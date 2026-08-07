/**
 * `agenticloop closeout` - composite work-unit closeout gate.
 *
 *   prepare  read-only composite evaluation; emits one versioned packet
 *   status   resolve the current marker and verify its provenance digest
 *   record   revalidate live state, then publish exactly one current marker
 *
 * `audit gate` remains the public audit-only subset evaluator; prepare
 * composes it with the other closeout checks. Packets under
 * `.agenticloop/tmp/` are transient transport: marker provenance is the
 * canonical digest projection, reconstructable after packet deletion.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createIo, resolveCliTarget, CliUsageError, EXIT_USAGE } from './cli-io.js';
import { COMMAND_REGISTRY, parseCommandArgs, suggestName } from './cli-registry.js';
import { defaultGhCommandRunner } from './gh-helpers.js';
import { evaluateCloseout,
  filesTaskInfo,
  renderMarkerForPacket,
  upsertCloseoutMarkerInTaskRecord,
  verifyCloseoutStatus,
} from './closeout.js';
import { parseFrontmatter as parseCarrierFrontmatter, replaceFrontmatterField as replaceCloseoutFrontmatterField } from './frontmatter.js';
import { validateTaskRecordDiagnostics } from './validate-config.js';
import { applyGitHubTaskBody, fetchGitHubTaskBody, setTaskBodyFrontmatterField } from './github-task-body.js';
import { canonicalSha256 } from './canonical-json.js';
import {
  validateCloseoutPacket,
  closeoutPacketDigest,
  closeoutProvenanceProjection,
  parseCloseoutMarkers,
  resolveCurrentCloseoutMarkers,
  workflowRecordSubstance,
} from './closeout-contract.js';
import {
  checkGitHubMarkerCurrent,
  fetchCarrierComments,
  fetchGitHubTaskInventory,
  fetchGitHubTrustedAccount,
  fetchPullRequestLifecycle,
  gitHubCarrierRevision,
  publishGitHubCloseoutMarker,
  resolveGitHubCloseoutCarrier,
  resolveGitHubCurrentMarkers,
  trustedCarrierMarkerText,
} from './closeout-github.js';
import { atomicWriteFile, executeMutationBatch } from './fs-mutation-kernel.js';
import { SCRATCH_DIRECTORY_RELATIVE_PATH } from './layout.js';
import { canonicalJson } from './canonical-json.js';
import { deriveLifecycleClaims } from './lifecycle-claims.js';
import { loadProjectMap, PROJECT_MAP_DEFAULTS } from './project-map.js';
import { parseFrontmatter } from './frontmatter.js';
import { createLocalVerificationContext } from './verification-context.js';
import { findAuditRecord, normalizeCoveredTasks } from './audit-record.js';
import { resolveCoveredGitHubTask } from './github-task-identity.js';
import { buildCliDurableReferenceContext } from './durable-refs.js';
import { createDiagnostic } from './repair-policy.js';
import { createValidationResult, emitValidationResult } from './result-envelope.js';
import { presentDiagnostic } from './diagnostic-presentation.js';
import { getProjectRoleCapabilities } from './role-capabilities.js';
import { PublicCommandError } from './public-error.js';
import { evaluateTaskRecordRoot } from './task-record-root.js';

function optionString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionList(value) {
  if (Array.isArray(value)) {
    return value.flatMap(item => String(item ?? '').split(',')).map(item => item.trim()).filter(Boolean);
  }
  return optionString(value).split(',').map(item => item.trim()).filter(Boolean);
}

function projectConfig(target) {
  return loadProjectMap(target)?.config ?? PROJECT_MAP_DEFAULTS;
}

function defaultPacketPath(target, workUnit) {
  const safe = workUnit.replace(/[^A-Za-z0-9._-]+/g, '-');
  return join(target, SCRATCH_DIRECTORY_RELATIVE_PATH, `${safe}-closeout.json`);
}

/**
 * Build the evaluation params shared by prepare, status, and record
 * revalidation. GitHub inventory is fetched once per command and reused by
 * every evaluator.
 */
async function buildEvaluationParams(target, config, opts, io) {
  const backend = config.task_backend === 'github' ? 'github' : 'files';
  const context = createLocalVerificationContext(target);
  const params = {
    workUnit: optionString(opts.workUnit),
    artifact: optionString(opts.artifact) || undefined,
    coveredTasks: optionList(opts.coveredTasks),
    planSync: optionString(opts.planSync) || 'none',
    planSyncRef: optionString(opts.planRef) || undefined,
    planSyncRevision: optionString(opts.planRevision) || undefined,
    improvementRefs: optionList(opts.improvementRef),
    config,
    backend,
    validationOptions: {
      taskIdRegex: config.task_id_regex,
      taskExists: backend === 'files' ? context.taskExists : undefined,
      decisionAccepted: decisionId => {
        const file = join(target, '.agenticloop', 'decisions', `${decisionId}.md`);
        if (!existsSync(file)) return false;
        const [frontmatter] = parseFrontmatter(readFileSync(file, 'utf-8'));
        return optionString(frontmatter?.status) === 'accepted';
      },
    },
  };
  if (backend === 'github') {
    const ghRunner = io.ghCommandRunner ?? defaultGhCommandRunner;
    params.inventory = fetchGitHubTaskInventory(ghRunner, {
      repo: optionString(opts.repo) || undefined,
      taskIdRegex: config.task_id_regex,
    });
    params.ghRunner = ghRunner;
    params.repo = optionString(opts.repo) || undefined;
    const audit = findAuditRecord(target, params.workUnit)?.record;
    const carrierTasks = params.coveredTasks.length > 0
      ? params.coveredTasks
      : normalizeCoveredTasks(audit?.coveredTasks ?? []);
    // Terminal PR lifecycle evidence for every covered task issue, fetched
    // once against the same command-local inventory snapshot.
    if (params.inventory.complete) {
      const issueNumbers = carrierTasks
        .map(taskId => resolveCoveredGitHubTask(params.inventory, taskId))
        .filter(resolved => resolved.found)
        .map(resolved => resolved.issue.number);
      params.prLifecycle = fetchPullRequestLifecycle(ghRunner, [...new Set(issueNumbers)], { repo: params.repo });
    } else {
      params.prLifecycle = { ok: false, error: 'task inventory is incomplete' };
    }
    const carrier = resolveGitHubCloseoutCarrier(params.inventory, carrierTasks);
    if (carrier.error) {
      params.carrierError = carrier.error;
    } else {
      const comments = fetchCarrierComments(ghRunner, carrier.issue.number, { repo: params.repo });
      const account = fetchGitHubTrustedAccount(ghRunner, { repo: params.repo });
      if (!comments.ok) {
        params.carrierError = comments.error;
      } else if (!account.ok) {
        params.carrierError = account.error;
      } else {
        params.carrier = {
          kind: carrier.kind,
          reference: carrier.reference,
          revision: gitHubCarrierRevision(comments.comments),
        };
        params.carrierComments = trustedCarrierMarkerText(comments.comments, account.login);
        params.trustedAccount = account.login;
        params.markerResolution = resolveGitHubCurrentMarkers(comments.comments, account.login);
      }
    }
    params.refContext = buildCliDurableReferenceContext(target, config, io, {
      inventory: params.inventory,
      repo: params.repo,
      markerContents: params.carrierComments ? [params.carrierComments] : [],
    });
  } else {
    params.refContext = buildCliDurableReferenceContext(target, config, io);
  }
  return params;
}

function printReasons(reasons, io) {
  for (const item of reasons) {
    io.out(`  - [${item.gate}] ${item.message}`);
    io.out(`    owner: ${item.owner}`);
    if (item.repair) io.out(`    repair: ${item.repair}`);
  }
}

function resolvePacketOutputPath(target, output, workUnit) {
  const scratch = resolve(target, SCRATCH_DIRECTORY_RELATIVE_PATH);
  const defaultPath = defaultPacketPath(target, workUnit);
  const packetPath = output ? resolve(target, output) : defaultPath;
  const withinScratch = relative(scratch, packetPath);
  if (!withinScratch || withinScratch === '..' || withinScratch.startsWith(`..\\`) ||
      withinScratch.startsWith('../') || isAbsolute(withinScratch)) {
    throw new PublicCommandError(`closeout packet output must be under ${SCRATCH_DIRECTORY_RELATIVE_PATH}/`, {
      code: 'evidence.negative',
      evidenceState: 'negative',
      disposition: 'blocked',
      safeRepair: `Choose a packet output path under ${SCRATCH_DIRECTORY_RELATIVE_PATH}/.`,
    });
  }
  if (existsSync(packetPath) && packetPath !== defaultPath) {
    throw new PublicCommandError(`closeout packet output already exists and is not the transient default packet: ${output}`, {
      code: 'evidence.negative',
      evidenceState: 'negative',
      disposition: 'blocked',
      safeRepair: 'Choose a new packet output path; do not overwrite an existing file.',
    });
  }
  return packetPath;
}

function writePacket(packetPath, packet) {
  atomicWriteFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
}

function comparablePacket(packet) {
  return {
    digest: packet.digest,
    projection: closeoutProvenanceProjection(packet),
    marker_action: packet.marker_action,
    publishable: packet.publishable,
    completion_eligible: packet.completion_eligible,
    recommended_status: packet.recommended_status,
    reasons: packet.reasons,
  };
}

/**
 * Files-backend same-packet retry: true only when the exact packet digest is
 * already the one current marker and every live fact - task, audit,
 * candidate, plan, evidence, disposition, and carrier substance - still
 * matches the packet with the marker treated as the evaluation output.
 * Idempotency never hides actual post-publication drift: contradictory or
 * malformed markers, changed facts, or a different digest all fail closed.
 *
 * @param {string} target
 * @param {object} packet
 * @param {object} live  evaluateCloseout result from the record revalidation.
 * @returns {{ current: boolean }}
 */
function filesPacketAlreadyCurrent(target, packet, live) {
  const markerState = live?.markerState;
  if (!markerState || markerState.error) return { current: false };
  if (markerState.current.length !== 1) return { current: false };
  const marker = markerState.current[0];
  if (!marker.provenanced || marker.malformed) return { current: false };
  if (String(marker.fields?.AGENT_CLOSEOUT_GATE ?? '') !== String(packet.digest)) return { current: false };
  if (marker.status !== packet.recommended_status) return { current: false };

  // Revalidate all live facts excluding only the marker mutation this packet
  // produced: rebuild the provenance projection with the marker treated as
  // the evaluation output (its recorded predecessor, plan-sync, and
  // improvement references bind history) and compare digests and reasons.
  const markerImprovements = String(marker.fields?.AGENT_CLOSEOUT_IMPROVEMENTS ?? 'none');
  const reconstruction = {
    ...live.packet,
    predecessor_marker: String(marker.fields?.AGENT_CLOSEOUT_PREDECESSOR ?? 'none') || 'none',
    plan_sync: String(marker.fields?.AGENT_CLOSEOUT_PLAN_SYNC ?? 'none') || 'none',
    improvement_refs: markerImprovements === 'none'
      ? []
      : markerImprovements.split(',').map(item => item.trim()).filter(Boolean).sort(),
  };
  if (closeoutPacketDigest(reconstruction) !== packet.digest) return { current: false };
  if (live.packet.recommended_status !== packet.recommended_status) return { current: false };
  if (canonicalJson(live.packet.reasons) !== canonicalJson(packet.reasons)) return { current: false };
  return { current: true };
}

/**
 * @param {string[]} args
 * @param {object} [io]
 * @returns {Promise<number>}
 */
export async function cmdCloseout(args, io = createIo()) {
  const sub = args[0];
  const SUBCOMMANDS = COMMAND_REGISTRY.closeout.subcommands;
  if (!sub || !SUBCOMMANDS[sub]) {
    const suggestion = sub ? suggestName(sub, Object.keys(SUBCOMMANDS)) : null;
    io.err(suggestion
      ? `closeout: unknown subcommand '${sub}'. Did you mean '${suggestion}'?`
      : 'closeout requires a subcommand: prepare, status, record.');
    io.err('Run "agenticloop help closeout" for usage.');
    return EXIT_USAGE;
  }
  const { opts } = parseCommandArgs(`closeout ${sub}`, SUBCOMMANDS[sub], args.slice(1));
  const target = resolveCliTarget(io, opts.target);
  const config = projectConfig(target);

  try {
    if (sub === 'prepare') {
      if (!optionString(opts.workUnit)) {
        io.err('closeout prepare requires --work-unit <kind>:<id>');
        return EXIT_USAGE;
      }
      const params = await buildEvaluationParams(target, config, opts, io);
      const evaluation = evaluateCloseout(target, params);
      const packet = evaluation.packet;
      const contractErrors = evaluation.contractErrors?.length
        ? evaluation.contractErrors
        : validateCloseoutPacket(packet);
      if (contractErrors.length > 0) {
        for (const error of contractErrors) io.err(`closeout prepare internal contract failure: ${error}`);
        return 1;
      }
      const packetPath = resolvePacketOutputPath(target, optionString(opts.output), packet.work_unit || 'work-unit');
      writePacket(packetPath, packet);
      if (opts.json) {
        io.out(JSON.stringify(packet, null, 2));
      } else {
        io.out(`${packet.work_unit}: ${packet.recommended_status} (packet ${packet.digest})`);
        io.out(`  publishable: ${packet.publishable}  completion_eligible: ${packet.completion_eligible}`);
        io.out(`  packet: ${packetPath} (transient; provenance is the digest)`);
        if (packet.reasons.length > 0) printReasons(packet.reasons, io);
      }
      return packet.completion_eligible ? 0 : 1;
    }

    if (sub === 'status') {
      if (!optionString(opts.workUnit)) {
        io.err('closeout status requires --work-unit <kind>:<id>');
        return EXIT_USAGE;
      }
      const params = await buildEvaluationParams(target, config, opts, io);
      const result = verifyCloseoutStatus(target, params);
      if (opts.json) {
        if (result.current && result.state === 'complete') {
          io.out(JSON.stringify({
            work_unit: optionString(opts.workUnit),
            state: result.state,
            code: result.code ?? null,
            status: result.status,
            current: result.current,
            expected_digest: result.expectedDigest,
            resume_command: result.resumeCommand ?? null,
            reasons: result.reasons,
          }, null, 2));
        } else {
          const code = result.code ?? 'cli.operational';
          const evidenceState = code === 'closeout.marker.stale' ? 'stale' : 'negative';
          const diagnostic = presentDiagnostic(createDiagnostic({
            code,
            message: result.reasons?.[0] ?? 'Closeout status is not current.',
            evidence: { state: evidenceState, rollbackAuthorized: false },
            repairHint: result.resumeCommand ?? 'Re-run closeout status after repairing the reported state.',
          }), getProjectRoleCapabilities(target));
          const domainFields = {
            work_unit: optionString(opts.workUnit),
            state: result.state,
            status: result.status,
            current: result.current,
            expected_digest: result.expectedDigest ?? null,
            resume_command: result.resumeCommand ?? null,
            reasons: Array.isArray(result.reasons) ? result.reasons : [],
          };
          domainFields.code = result.code ?? null;
          emitValidationResult(io, createValidationResult({
            command: 'closeout status',
            evidenceState,
            disposition: evidenceState === 'stale' ? 'superseded' : 'blocked',
            diagnostics: [diagnostic],
            firstSafeRepair: diagnostic.nextAction ?? result.resumeCommand
              ?? 'Re-run closeout status after repairing the reported state.',
            debugReference: null,
            ...domainFields,
          }));
        }
      } else {
        io.out(`${optionString(opts.workUnit)}: ${result.state}${result.current ? ' (current)' : ''}`);
        for (const message of result.reasons) io.out(`  - ${message}`);
      }
      return result.current && result.state === 'complete' ? 0 : 1;
    }

    if (sub === 'record') {
      const packetOption = optionString(opts.packet);
      if (!packetOption) {
        io.err('closeout record requires --packet <path>');
        return EXIT_USAGE;
      }
      const dryRun = Boolean(opts.dryRun);
      const yes = Boolean(opts.yes);
      if (dryRun === yes) {
        io.err('closeout record requires exactly one of --dry-run or --yes');
        return EXIT_USAGE;
      }
      const packetPath = isAbsolute(packetOption) ? packetOption : resolve(target, packetOption);
      if (!existsSync(packetPath)) {
        io.err(`closeout record: packet not found: ${packetOption}`);
        return 1;
      }
      let packet;
      try {
        packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
      } catch (error) {
        io.err(`closeout record: packet is not valid JSON: ${error.message}`);
        return 1;
      }
      const packetErrors = validateCloseoutPacket(packet);
      if (packetErrors.length > 0) {
        for (const error of packetErrors) io.err(`closeout record: invalid packet: ${error}`);
        return 1;
      }
      if (!packet.publishable) {
        io.err('closeout record: the packet is not publishable; re-run closeout prepare');
        return 1;
      }

      // Live revalidation: any task, artifact, audit, evidence, or marker
      // change since preparation makes the packet stale.
      const liveParams = await buildEvaluationParams(target, config, {
        workUnit: packet.work_unit,
        artifact: packet.candidate_artifact,
        coveredTasks: packet.covered_tasks,
        planSync: packet.plan_sync,
        improvementRef: packet.improvement_refs,
        repo: optionString(opts.repo),
      }, io);
      const live = evaluateCloseout(target, liveParams);
      const staleReasons = [];
      if (live.contractErrors?.length > 0) {
        staleReasons.push(`live evaluation violates the closeout packet contract: ${live.contractErrors.join('; ')}`);
      }
      if (live.packet.digest !== packet.digest) {
        staleReasons.push(
          `packet digest ${packet.digest} no longer matches live state ${live.packet.digest}; re-run closeout prepare`
        );
      }
      if (canonicalJson(comparablePacket(live.packet)) !== canonicalJson(comparablePacket(packet))) {
        staleReasons.push('live closeout facts or derived state no longer match the packet; re-run closeout prepare');
      }
      // A published marker is not a completed closeout. When publication is
      // already done for this exact packet and nothing else drifted, the
      // operation resumes at the terminal transition instead of reporting a
      // stale packet; the alternative leaves covered tasks stranded in
      // `accepted` with no rerun able to finish them.
      const gitHubResume = staleReasons.length > 0 && closeoutGitHubResumeAvailable(packet, live);
      if (gitHubResume) {
        io.out(`Marker ${packet.digest} is already published on the GitHub carrier; resuming at the closeout-owned terminal transition.`);
      }
      if (staleReasons.length > 0 && !gitHubResume) {
        // Same-packet retry: the exact digest may already be the current
        // marker. That is idempotent success, never a misleading stale
        // failure - but only when every other live fact still matches.
        if (packet.backend !== 'github' && filesPacketAlreadyCurrent(target, packet, live).current) {
          io.out(`Marker ${packet.digest} is already current in ${packet.carrier?.reference}; nothing to do.`);
          return 0;
        }
        // A completed closeout-owned terminal transition necessarily changes
        // the covered task statuses, so the packet that authorized it will
        // read as stale on rerun. Resuming from that already-verified terminal
        // step is success, not a stale-packet failure.
        const complete = closeoutTerminalAlreadyComplete(target, config, packet, live);
        if (complete.current) {
          io.out(`Marker ${packet.digest} is current and every covered task is already closed; nothing to do.`);
          io.out(`  resumed step: closeout_owned_accepted_to_closed (${complete.tasks.join(', ')})`);
          return 0;
        }
        for (const message of staleReasons) io.err(`closeout record: stale packet: ${message}`);
        return 1;
      }

      const currentMarkers = live.markerState.current;
      const supersedes = currentMarkers.length === 1 &&
        (currentMarkers[0].fields?.AGENT_CLOSEOUT_GATE ?? '') !== packet.digest
        ? currentMarkers[0].reference
        : '';
      const markerBody = renderMarkerForPacket(packet, { supersedes });

      if (packet.backend === 'github') {
        // Rebuild the complete inventory, carrier, trusted marker state, and
        // carrier revision immediately before the one remote mutation.
        const finalParams = await buildEvaluationParams(target, config, {
          workUnit: packet.work_unit,
          artifact: packet.candidate_artifact,
          coveredTasks: packet.covered_tasks,
          planSync: packet.plan_sync,
          improvementRef: packet.improvement_refs,
          repo: optionString(opts.repo),
        }, io);
        const finalLive = evaluateCloseout(target, finalParams);
        // On a resume the marker this packet already published is part of live
        // state, so the full comparison necessarily differs. The bounded
        // projection still has to match exactly, so unrelated drift immediately
        // before publication continues to fail closed.
        const finalUnchanged = gitHubResume
          ? packetFactsUnchanged(finalLive, packet)
          : canonicalJson(comparablePacket(finalLive.packet)) === canonicalJson(comparablePacket(packet));
        if (!finalUnchanged) {
          io.err('closeout record: stale packet: GitHub state changed immediately before publication; re-run closeout prepare');
          return 1;
        }
        return await recordGitHubMarker(target, config, packet, markerBody, finalParams, { dryRun, yes }, io);
      }
      return recordFilesMarker(target, config, packet, markerBody, live, { dryRun, yes }, io);
    }

    io.err(`Unknown closeout subcommand '${sub}'. Expected: prepare, status, record.`);
    return EXIT_USAGE;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    io.err(error.message);
    return 1;
  }
}

/**
 * The canonical `closeout_owned_accepted_to_closed` action.
 *
 * Generic `task status ... closed` is refused for every established closeout
 * scope, so the terminal transition has to remain reachable somewhere: it lives
 * here, behind a fresh, valid, completion-eligible closeout packet and a
 * published marker. Blocking generic closure without this would make legitimate
 * closeout impossible.
 *
 * The files backend applies the exact covered task set through one guarded
 * transaction. GitHub cannot offer a cross-resource transaction, so its
 * per-carrier transitions are individually guarded and partial external
 * progress is reported exactly rather than described as atomic.
 */
/**
 * True when this exact packet's marker is current and every covered task has
 * already completed the closeout-owned terminal transition.
 *
 * The terminal transition changes the covered task statuses, so the authorizing
 * packet always reads as stale afterwards. Recognizing that verified terminal
 * state lets a safe rerun resume instead of reporting a confusing conflict.
 * Anything less than a fully closed covered set falls through to the normal
 * stale handling.
 */
function closeoutTerminalAlreadyComplete(target, config, packet, live) {
  if (packet.recommended_status !== 'complete') return { current: false, tasks: [] };
  const markers = live?.markerState?.current ?? [];
  const marker = markers.length === 1 ? markers[0] : null;
  if (!marker || !marker.provenanced || marker.malformed) return { current: false, tasks: [] };
  if (String(marker.fields?.AGENT_CLOSEOUT_GATE ?? '') !== String(packet.digest)) return { current: false, tasks: [] };
  if (packet.backend === 'github') {
    // GitHub carrier statuses are only re-readable through the transport, which
    // this read-only comparison does not own; the per-carrier transition below
    // reports its own already-verified steps.
    return { current: false, tasks: [] };
  }
  const tasks = [];
  for (const taskId of packet.covered_tasks) {
    const info = filesTaskInfo(target, config, taskId);
    if (!info.exists || info.status !== 'closed') return { current: false, tasks: [] };
    tasks.push(taskId);
  }
  if (tasks.length === 0) return { current: false, tasks: [] };
  // Files carrier revisions already normalize the closeout marker and the
  // accepted -> closed status transition. Any remaining revision change is
  // substantive drift and must stay inside the canonical comparison.
  if (!packetFactsUnchanged(live, packet)) {
    return { current: false, tasks: [] };
  }
  return { current: true, tasks };
}

/**
 * Compare every authoritative closeout fact between live state and the packet.
 *
 * The basis is the canonical `closeoutProvenanceProjection` — the same
 * projection the packet digest is computed over — rather than a hand-picked
 * subset. A narrower ad hoc list silently exempts whatever it forgets, and what
 * it forgot here was backend, carrier identity and revision, gates, finding
 * dispositions, `audit_opt_out`, and the predecessor marker: all authoritative
 * inputs. The derived conclusions are compared alongside it.
 *
 * Publishing a marker leaves carrier revisions untouched: they are computed with
 * marker blocks normalized out, precisely so publication cannot masquerade as a
 * substantive carrier edit. A substantive carrier edit after publication
 * therefore still fails closed.
 *
 * Exactly one field does shift as a consequence of publication:
 * `predecessor_marker` becomes the marker this operation just published. That is
 * tolerated only when the live value equals this packet's own digest — the
 * marker this operation is provably responsible for. Any other predecessor is
 * some other operation's marker and is genuine drift.
 *
 * @param {{packet?: object}} live
 * @param {object} packet
 */
export function packetFactsUnchanged(live, packet) {
  const livePacket = live?.packet ?? {};
  const selfPublished = String(livePacket.predecessor_marker ?? 'none') === String(packet.digest ?? '');
  const comparable = source => {
    const provenance = closeoutProvenanceProjection(source);
    if (selfPublished) provenance.predecessor_marker = '<this-operation>';
    return canonicalJson({
      provenance,
      reasons: source.reasons,
      publishable: source.publishable,
      completion_eligible: source.completion_eligible,
      recommended_status: source.recommended_status,
    });
  };
  return comparable(livePacket) === comparable(packet);
}

/**
 * True when this exact packet's marker is already published on the GitHub
 * carrier and the operation may safely resume at the terminal transition.
 *
 * GitHub carrier statuses are only readable through the transport, so this
 * cannot assert that the covered tasks are closed the way the files backend
 * can; it asserts only that publication is done and no unrelated fact drifted.
 * The per-carrier terminal transition re-reads each carrier and reports its own
 * already-verified steps, so a resume that turns out to be complete is a no-op
 * rather than a second write.
 */
function closeoutGitHubResumeAvailable(packet, live) {
  if (packet.backend !== 'github' || packet.recommended_status !== 'complete') return false;
  const markers = live?.markerState?.current ?? [];
  const marker = markers.length === 1 ? markers[0] : null;
  if (!marker || !marker.provenanced || marker.malformed) return false;
  if (String(marker.fields?.AGENT_CLOSEOUT_GATE ?? '') !== String(packet.digest)) return false;
  return packetFactsUnchanged(live, packet);
}

function closeoutContentDigest(content) {
  return `sha256:${canonicalSha256(String(content ?? ''))}`;
}

function closeoutTerminalReceipt({ workUnit, backend, packetDigest, transitions, changedPaths, disposition, recovery }) {
  return {
    kind: 'agenticloop.closeout-terminal-receipt',
    schemaVersion: 1,
    action: 'closeout_owned_accepted_to_closed',
    backend,
    workUnit,
    packetDigest,
    transitions,
    changedPaths: [...changedPaths].sort(),
    mutationDisposition: disposition,
    unresolved: disposition !== 'committed' && disposition !== 'already_current',
    recovery: recovery ?? null,
    atomicity: backend === 'files'
      ? 'one guarded filesystem transaction across the exact covered task set'
      : 'per-carrier guarded transitions; GitHub provides no cross-resource transaction',
    revalidateCommand: `npx agenticloop closeout status --work-unit ${workUnit} --json`,
  };
}

/**
 * Transition the exact covered task set from `accepted` to `closed` on the
 * files backend through one guarded transaction.
 *
 * A task already `closed` is a verified terminal step and is resumed, not
 * rewritten. Any other current status blocks the whole action before a write.
 */
export function applyFilesCloseoutTerminalTransition(target, config, packet, io) {
  const writes = [];
  const transitions = [];
  for (const taskId of packet.covered_tasks) {
    const info = filesTaskInfo(target, config, taskId);
    if (!info.exists) {
      return {
        ok: false,
        receipt: closeoutTerminalReceipt({
          workUnit: packet.work_unit, backend: 'files', packetDigest: packet.digest,
          transitions, changedPaths: [], disposition: 'uncommitted',
          recovery: `Covered task '${taskId}' has no current record at ${info.relPath}; nothing was written.`,
        }),
        errors: [`covered task '${taskId}' has no current record at ${info.relPath}`],
      };
    }
    if (info.status === 'closed') {
      transitions.push({ taskId, carrier: info.relPath, from: 'closed', to: 'closed', state: 'already_verified' });
      continue;
    }
    if (info.status !== 'accepted') {
      return {
        ok: false,
        receipt: closeoutTerminalReceipt({
          workUnit: packet.work_unit, backend: 'files', packetDigest: packet.digest,
          transitions, changedPaths: [], disposition: 'uncommitted',
          recovery: `Covered task '${taskId}' is '${info.status || '(absent)'}' rather than 'accepted'; nothing was written.`,
        }),
        errors: [`covered task '${taskId}' is '${info.status || '(absent)'}' and cannot take the closeout-owned terminal transition`],
      };
    }
    const file = resolve(target, info.relPath);
    const currentBytes = readFileSync(file);
    const current = currentBytes.toString('utf8');
    io?.fsMutationOptions?.afterCarrierRead?.({ taskId, path: info.relPath });
    const root = evaluateTaskRecordRoot(current, { bytes: currentBytes });
    if (!root.ok) {
      return {
        ok: false,
        receipt: closeoutTerminalReceipt({
          workUnit: packet.work_unit, backend: 'files', packetDigest: packet.digest,
          transitions, changedPaths: [], disposition: 'uncommitted',
          recovery: `Covered task '${taskId}' is not a canonical current task record; repair it before closeout record.`,
        }),
        errors: root.diagnostics.map(item => `covered task '${taskId}': ${item.message ?? item.code}`),
      };
    }
    const candidate = replaceCloseoutFrontmatterField(current, 'status', 'closed');
    const diagnostics = validateTaskRecordDiagnostics(candidate, info.relPath);
    if (diagnostics.length > 0) {
      return {
        ok: false,
        receipt: closeoutTerminalReceipt({
          workUnit: packet.work_unit, backend: 'files', packetDigest: packet.digest,
          transitions, changedPaths: [], disposition: 'uncommitted',
          recovery: `The terminal candidate for '${taskId}' is invalid; nothing was written.`,
        }),
        errors: diagnostics.map(item => `covered task '${taskId}': ${item.message}`),
      };
    }
    writes.push({
      type: 'write', path: info.relPath, content: candidate,
      expectedDigest: createHash('sha256').update(currentBytes).digest('hex'), expectedKind: 'file',
      validateCurrent: bytes => evaluateTaskRecordRoot(bytes.toString('utf8'), { bytes }),
    });
    transitions.push({
      taskId, carrier: info.relPath, from: 'accepted', to: 'closed', state: 'planned',
      beforeDigest: closeoutContentDigest(current), candidateDigest: closeoutContentDigest(candidate),
    });
  }

  if (writes.length === 0) {
    return {
      ok: true,
      receipt: closeoutTerminalReceipt({
        workUnit: packet.work_unit, backend: 'files', packetDigest: packet.digest,
        transitions, changedPaths: [], disposition: 'already_current',
      }),
      errors: [],
    };
  }

  const committed = executeMutationBatch(target, writes, io?.fsMutationOptions ?? {});
  if (!committed.ok) {
    for (const error of committed.errors) io.err(`closeout terminal transition failed: ${error}`);
    for (const error of committed.rollbackErrors) io.err(`rollback error: ${error}`);
    const rolledBack = committed.rollbackErrors.length === 0;
    return {
      ok: false,
      receipt: closeoutTerminalReceipt({
        workUnit: packet.work_unit, backend: 'files', packetDigest: packet.digest,
        transitions, changedPaths: rolledBack ? [] : writes.map(item => item.path),
        disposition: rolledBack ? 'uncommitted' : 'partially_committed',
        recovery: rolledBack
          ? 'The guarded transaction rolled back; every covered task record is unchanged. Repair the reported cause and rerun closeout record.'
          : `The guarded transaction failed and rollback reported errors: ${committed.rollbackErrors.join('; ')}. Inspect the covered task records before rerunning.`,
      }),
      errors: committed.errors,
    };
  }

  const unresolved = [];
  for (const transition of transitions) {
    if (transition.state !== 'planned') continue;
    const written = readFileSync(resolve(target, transition.carrier), 'utf-8');
    const resultingDigest = closeoutContentDigest(written);
    transition.resultingDigest = resultingDigest;
    transition.state = resultingDigest === transition.candidateDigest &&
      validateTaskRecordDiagnostics(written, transition.carrier).length === 0
      ? 'committed'
      : 'unresolved';
    if (transition.state === 'unresolved') unresolved.push(transition.carrier);
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      receipt: closeoutTerminalReceipt({
        workUnit: packet.work_unit, backend: 'files', packetDigest: packet.digest,
        transitions, changedPaths: committed.writtenFiles, disposition: 'unresolved',
        recovery: `These carriers committed but do not equal their validated candidates: ${unresolved.join(', ')}. Preserve and inspect them before any further transition.`,
      }),
      errors: [`the committed terminal records do not equal their validated candidates: ${unresolved.join(', ')}`],
    };
  }
  return {
    ok: true,
    receipt: closeoutTerminalReceipt({
      workUnit: packet.work_unit, backend: 'files', packetDigest: packet.digest,
      transitions, changedPaths: committed.writtenFiles, disposition: 'committed',
    }),
    errors: [],
  };
}

/**
 * Transition the exact covered task set on GitHub through guarded per-carrier
 * body mutations. Partial external progress is reported exactly; no
 * cross-resource atomicity is claimed.
 */
function applyGitHubCloseoutTerminalTransition(target, config, packet, liveParams, io) {
  const commandRunner = liveParams.ghRunner ?? defaultGhCommandRunner;
  const transitions = [];
  const changedPaths = [];
  let failed = null;
  for (const taskId of packet.covered_tasks) {
    const resolved = resolveCoveredGitHubTask(liveParams.inventory, taskId);
    if (!resolved.found) {
      failed = `covered task '${taskId}' has no current GitHub carrier`;
      transitions.push({ taskId, carrier: null, state: 'unresolved' });
      break;
    }
    const issue = resolved.issue.number;
    const current = fetchGitHubTaskBody({ issue, repo: liveParams.repo, commandRunner, projectMapConfig: config });
    const status = String(parseCarrierFrontmatter(current.body)[0]?.status ?? '').trim();
    if (status === 'closed') {
      transitions.push({ taskId, carrier: `issue:${issue}`, from: 'closed', to: 'closed', state: 'already_verified' });
      continue;
    }
    if (status !== 'accepted') {
      failed = `covered task '${taskId}' is '${status || '(absent)'}' and cannot take the closeout-owned terminal transition`;
      transitions.push({ taskId, carrier: `issue:${issue}`, from: status, to: 'closed', state: 'blocked' });
      break;
    }
    const candidate = setTaskBodyFrontmatterField(current.body, 'status', 'closed').body;
    const applied = applyGitHubTaskBody({
      issue,
      repo: liveParams.repo,
      body: candidate,
      expectDigest: current.digest,
      yes: true,
      commandRunner,
      recoveryDir: join(target, '.agenticloop', 'tmp'),
      projectMapConfig: config,
    });
    if (!applied.ok) {
      failed = `covered task '${taskId}' could not be transitioned: ${(applied.errors ?? ['unknown transport failure']).join('; ')}`;
      transitions.push({ taskId, carrier: `issue:${issue}`, from: status, to: 'closed', state: 'unresolved', receipt: applied.receipt ?? null });
      break;
    }
    changedPaths.push(`issue:${issue}`);
    transitions.push({
      taskId, carrier: `issue:${issue}`, from: status, to: 'closed',
      state: applied.applied ? 'committed' : 'already_verified', receipt: applied.receipt ?? null,
    });
  }
  if (failed) {
    io.err(`closeout terminal transition failed: ${failed}`);
    const progressed = changedPaths.length > 0;
    return {
      ok: false,
      receipt: closeoutTerminalReceipt({
        workUnit: packet.work_unit, backend: 'github', packetDigest: packet.digest,
        transitions, changedPaths, disposition: progressed ? 'partially_committed' : 'uncommitted',
        recovery: progressed
          ? `These carriers already reached 'closed': ${changedPaths.join(', ')}. Rerun closeout record to resume at the remaining carriers; the completed ones are skipped as already verified.`
          : 'No GitHub carrier was transitioned. Repair the reported cause and rerun closeout record.',
      }),
      errors: [failed],
    };
  }
  return {
    ok: true,
    receipt: closeoutTerminalReceipt({
      workUnit: packet.work_unit, backend: 'github', packetDigest: packet.digest,
      transitions, changedPaths,
      disposition: changedPaths.length > 0 ? 'committed' : 'already_current',
    }),
    errors: [],
  };
}

function recordFilesMarker(target, config, packet, markerBody, live, mode, io) {
  const carrierRef = packet.carrier?.reference;
  if (!carrierRef) {
    io.err('closeout record: the packet has no files marker carrier; re-run closeout prepare');
    return 1;
  }
  const carrierFile = resolve(target, carrierRef);
  if (!existsSync(carrierFile)) {
    io.err(`closeout record: marker carrier '${carrierRef}' no longer exists`);
    return 1;
  }
  const currentBytes = readFileSync(carrierFile);
  const content = currentBytes.toString('utf-8');
  const expectedRevision = live?.packet?.carrier?.revision ?? packet.carrier?.revision;
  const currentRevision = `sha256:${createHash('sha256').update(workflowRecordSubstance(content), 'utf-8').digest('hex')}`;
  if (!expectedRevision || currentRevision !== expectedRevision) {
    io.err(`closeout record: marker carrier '${carrierRef}' changed after final evaluation; re-run closeout prepare`);
    return 1;
  }
  const currentMarkerState = resolveCurrentCloseoutMarkers(parseCloseoutMarkers(content));
  if (currentMarkerState.error) {
    io.err(`closeout record: marker carrier '${carrierRef}' is contradictory: ${currentMarkerState.error}`);
    return 1;
  }
  const priorMarkers = currentMarkerState.current;
  const updated = upsertCloseoutMarkerInTaskRecord(content, markerBody, { priorMarkers });

  if (mode.dryRun) {
    io.out(`dry run: would publish to ${carrierRef}:`);
    io.out(markerBody);
    return 0;
  }
  const committed = executeMutationBatch(target, [{
    type: 'write',
    path: carrierRef,
    content: updated,
    expectedDigest: createHash('sha256').update(currentBytes).digest('hex'),
    expectedKind: 'file',
    validateCurrent: bytes => evaluateTaskRecordRoot(bytes.toString('utf8'), { bytes }),
  }], io?.fsMutationOptions ?? {});
  if (!committed.ok) {
    for (const error of committed.errors) io.err(`closeout record failed; the carrier is unchanged: ${error}`);
    for (const error of committed.rollbackErrors) io.err(`rollback error: ${error}`);
    return 1;
  }
  const publishedContent = readFileSync(carrierFile, 'utf-8');
  const publishedMarkerState = resolveCurrentCloseoutMarkers(parseCloseoutMarkers(publishedContent));
  const publishedMarker = publishedMarkerState.current.length === 1
    ? publishedMarkerState.current[0]
    : null;
  if (
    publishedContent !== updated
    || publishedMarkerState.error
    || !publishedMarker?.provenanced
    || publishedMarker.malformed
    || String(publishedMarker.fields?.AGENT_CLOSEOUT_GATE ?? '') !== String(packet.digest)
  ) {
    io.err(
      `closeout record: marker publication on '${carrierRef}' could not be verified as the unique current packet; ` +
      'covered tasks were not closed'
    );
    return 1;
  }
  io.out(`Recorded ${packet.recommended_status} marker in ${carrierRef} (${packet.digest})`);
  if (packet.recommended_status !== 'complete') {
    io.out('  This marker is truthful state, not completion; completion requires a completion-eligible packet.');
    return 0;
  }

  // The marker is the last required gate before the closeout-owned terminal
  // transition. Generic closure is refused for every established scope, so this
  // is the only route by which a covered task set reaches `closed`.
  const terminal = applyFilesCloseoutTerminalTransition(target, config, packet, io);
  reportTerminalTransition(terminal, io, packet, {
    gateDigest: packet.digest,
    artifact: packet.candidate_artifact,
    workUnit: packet.work_unit,
  });
  return terminal.ok ? 0 : 1;
}

/** Print the closeout-owned terminal transition outcome and its receipt. */
function reportTerminalTransition(terminal, io, packet = null, marker = null) {
  const { receipt } = terminal;
  if (terminal.ok) {
    io.out(receipt.mutationDisposition === 'already_current'
      ? `  closeout_owned_accepted_to_closed: every covered task was already closed (${receipt.workUnit}).`
      : `  closeout_owned_accepted_to_closed: closed ${receipt.changedPaths.length} covered task carrier(s) for ${receipt.workUnit}.`);
    io.out(`  atomicity: ${receipt.atomicity}`);
    io.out(`  revalidate: ${receipt.revalidateCommand}`);
    const claims = deriveLifecycleClaims({
      closeoutPacket: packet,
      closeoutTerminalReceipt: receipt,
      currentCloseoutMarker: marker,
    });
    for (const claim of claims) io.out(`  lifecycle: ${claim.claim}`);
    return;
  }
  for (const error of terminal.errors) io.err(`closeout record: ${error}`);
  if (receipt.recovery) io.err(`  recovery: ${receipt.recovery}`);
  io.err(`  atomicity: ${receipt.atomicity}`);
}

async function recordGitHubMarker(target, config, packet, markerBody, liveParams, mode, io) {
  const ghRunner = liveParams.ghRunner ?? defaultGhCommandRunner;
  const carrier = resolveGitHubCloseoutCarrier(liveParams.inventory, packet.covered_tasks);
  if (carrier.error) {
    io.err(`closeout record: ${carrier.error}`);
    return 1;
  }
  const issueNumber = carrier.issue.number;
  if (!liveParams.trustedAccount) {
    io.err('closeout record: trusted GitHub account identity is unavailable; refusing publication');
    return 1;
  }

  if (mode.dryRun) {
    io.out(`dry run: would publish to ${carrier.reference}:`);
    io.out(markerBody);
    return 0;
  }

  // Idempotency: an already-current exact marker means publication is done.
  const current = checkGitHubMarkerCurrent(ghRunner, {
    issueNumber,
    digest: packet.digest,
    repo: liveParams.repo,
    expectedLogin: liveParams.trustedAccount,
  });
  if (current.error) {
    io.err(`closeout record: cannot establish current GitHub marker state: ${current.error}`);
    return 1;
  }
  if (current.alreadyCurrent) {
    // Publication is done, but publication is not the whole operation. The
    // covered tasks still have to complete the closeout-owned terminal
    // transition, and a first run that published the marker and then failed
    // partway through those transitions is exactly the case a rerun exists to
    // finish. Returning success here would report completion while covered
    // tasks remained accepted.
    io.out(`Marker ${packet.digest} is already current on ${carrier.reference}; resuming at the terminal transition.`);
    if (packet.recommended_status !== 'complete') {
      io.out('  This marker is truthful state, not completion; completion requires a completion-eligible packet.');
      return 0;
    }
    const resumed = applyGitHubCloseoutTerminalTransition(target, config, packet, liveParams, io);
    reportTerminalTransition(resumed, io, packet, {
      gateDigest: packet.digest,
      artifact: packet.candidate_artifact,
      workUnit: packet.work_unit,
    });
    return resumed.ok ? 0 : 1;
  }

  // Final pre-mutation revalidation: the carrier comments and task states are
  // re-read immediately before the single mutation call. GitHub cannot offer
  // a cross-resource atomic transaction; the residual remote
  // time-of-check/time-of-use window is recovered by digest lookup.
  const comments = fetchCarrierComments(ghRunner, issueNumber, { repo: liveParams.repo });
  if (!comments.ok) {
    io.err(`closeout record: cannot revalidate the carrier before publication: ${comments.error}`);
    return 1;
  }
  const currentResolution = resolveGitHubCurrentMarkers(comments.comments, liveParams.trustedAccount);
  const expectedResolution = liveParams.markerResolution;
  if (
    currentResolution.error
    || !expectedResolution
    || gitHubCarrierRevision(comments.comments) !== liveParams.carrier?.revision
    || canonicalJson(currentResolution) !== canonicalJson(expectedResolution)
  ) {
    io.err('closeout record: GitHub marker carrier changed after final evaluation; re-run closeout prepare');
    return 1;
  }
  const published = publishGitHubCloseoutMarker(ghRunner, {
    issueNumber,
    markerBody,
    digest: packet.digest,
    repo: liveParams.repo,
    expectedLogin: liveParams.trustedAccount,
  });
  if (!published.ok) {
    io.err(`closeout record: GitHub publication failed: ${published.error}`);
    return 1;
  }
  const verified = checkGitHubMarkerCurrent(ghRunner, {
    issueNumber,
    digest: packet.digest,
    repo: liveParams.repo,
    expectedLogin: liveParams.trustedAccount,
  });
  if (verified.error || !verified.alreadyCurrent) {
    io.err(
      `closeout record: published GitHub marker is not the unique current packet` +
      (verified.error ? `: ${verified.error}` : '')
    );
    return 1;
  }
  io.out(published.ambiguousRecovered
    ? `Marker ${packet.digest} recovered after an ambiguous remote response on ${carrier.reference}; no duplicate posted.`
    : `Recorded ${packet.recommended_status} marker on ${carrier.reference} (${packet.digest})`);
  if (packet.recommended_status !== 'complete') {
    io.out('  This marker is truthful state, not completion; completion requires a completion-eligible packet.');
    return 0;
  }
  const terminal = applyGitHubCloseoutTerminalTransition(target, config, packet, liveParams, io);
  reportTerminalTransition(terminal, io, packet, {
    gateDigest: packet.digest,
    artifact: packet.candidate_artifact,
    workUnit: packet.work_unit,
  });
  return terminal.ok ? 0 : 1;
}
