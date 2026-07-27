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
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createIo, resolveCliTarget, CliUsageError, EXIT_USAGE } from './cli-io.js';
import { COMMAND_REGISTRY, parseCommandArgs, suggestName } from './cli-registry.js';
import { defaultGhCommandRunner } from './gh-helpers.js';
import { evaluateCloseout,
  renderMarkerForPacket,
  upsertCloseoutMarkerInTaskRecord,
  verifyCloseoutStatus,
} from './closeout.js';
import {
  validateCloseoutPacket,
  closeoutPacketDigest,
  closeoutProvenanceProjection,
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
import { loadProjectMap, PROJECT_MAP_DEFAULTS } from './project-map.js';
import { parseFrontmatter } from './frontmatter.js';
import { createLocalVerificationContext } from './verification-context.js';
import { findAuditRecord, normalizeCoveredTasks } from './audit-record.js';
import { resolveCoveredGitHubTask } from './github-task-identity.js';
import { buildCliDurableReferenceContext } from './durable-refs.js';

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
    throw new Error(`closeout packet output must be under ${SCRATCH_DIRECTORY_RELATIVE_PATH}/`);
  }
  if (existsSync(packetPath) && packetPath !== defaultPath) {
    throw new Error(`closeout packet output already exists and is not the transient default packet: ${output}`);
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
        io.out(JSON.stringify({
          work_unit: optionString(opts.workUnit),
          state: result.state,
          status: result.status,
          current: result.current,
          expected_digest: result.expectedDigest,
          reasons: result.reasons,
        }, null, 2));
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
      if (staleReasons.length > 0) {
        // Same-packet retry: the exact digest may already be the current
        // marker. That is idempotent success, never a misleading stale
        // failure - but only when every other live fact still matches.
        if (packet.backend !== 'github' && filesPacketAlreadyCurrent(target, packet, live).current) {
          io.out(`Marker ${packet.digest} is already current in ${packet.carrier?.reference}; nothing to do.`);
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
        if (canonicalJson(comparablePacket(finalLive.packet)) !== canonicalJson(comparablePacket(packet))) {
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
  const content = readFileSync(carrierFile, 'utf-8');
  const priorMarkers = live.markerState.current;
  const updated = upsertCloseoutMarkerInTaskRecord(content, markerBody, { priorMarkers });

  if (mode.dryRun) {
    io.out(`dry run: would publish to ${carrierRef}:`);
    io.out(markerBody);
    return 0;
  }
  const committed = executeMutationBatch(target, [{ type: 'write', path: carrierRef, content: updated }]);
  if (!committed.ok) {
    for (const error of committed.errors) io.err(`closeout record failed; the carrier is unchanged: ${error}`);
    for (const error of committed.rollbackErrors) io.err(`rollback error: ${error}`);
    return 1;
  }
  io.out(`Recorded ${packet.recommended_status} marker in ${carrierRef} (${packet.digest})`);
  if (packet.recommended_status !== 'complete') {
    io.out('  This marker is truthful state, not completion; completion requires a completion-eligible packet.');
  }
  return 0;
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
    io.out(`Marker ${packet.digest} is already current on ${carrier.reference}; nothing to do.`);
    return 0;
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
  io.out(published.ambiguousRecovered
    ? `Marker ${packet.digest} recovered after an ambiguous remote response on ${carrier.reference}; no duplicate posted.`
    : `Recorded ${packet.recommended_status} marker on ${carrier.reference} (${packet.digest})`);
  if (packet.recommended_status !== 'complete') {
    io.out('  This marker is truthful state, not completion; completion requires a completion-eligible packet.');
  }
  return 0;
}
