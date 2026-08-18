/**
 * Handoff preflight evaluator.
 *
 * One read-only evaluation that reports every ordinary prerequisite for a
 * dispatch packet without assembling the packet itself. Every check reuses the
 * existing canonical validators; nothing here reclassifies evidence states or
 * reimplements validation logic.
 *
 * The result is a closed validation-result-compatible shape with deterministic
 * schema and digest behavior. Human and --json output share identical semantics.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createValidationResult } from './result-envelope.js';
import { createDiagnostic } from './repair-policy.js';
import { presentGateResultForTarget } from './diagnostic-presentation.js';

import {
  buildHostRoleCapabilityInventory,
  createDegradedEnforcementReports,
  validateHostRoleCapabilityDeclaration,
} from './host-role-capabilities.js';
import {
  resolveEffectiveActivationPolicy,
  resolveCurrentTaskAuthorization,
} from './activation-resolution.js';
import { loadHostTrustStore } from './host-trust.js';
import { taskContractDigest } from './task-contract-baseline.js';
import { loadFilesTaskContractRecords } from './files-task-contract.js';
import { evaluateTaskReadiness } from './task-readiness.js';
import {
  evaluateDispatchableLifecycle,
  taskStatusFromBody,
} from './dispatchability.js';
import { parseDependencySnapshot, dependencyStatusMap } from './task-evidence-contract.js';
import { isGitObjectId } from './git-oid.js';
import { GIT_MAX_BUFFER } from './git-runner.js';
import { listAgenticLoopWorktrees, resolveGitRepositoryContext } from './worktree.js';
import { loadAgenticLoopConfig } from './json.js';
import { resolveGitHubTaskIdentityStrict } from './github-task-identity.js';
import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { createDecompositionEligibilityProjection } from './decomposition-eligibility.js';
import {
  createTaskInventoryEnumeration,
  normalizeFilesTaskInventory,
} from './parallel-scan.js';
import { deriveHandoffSequence } from './handoff-sequence.js';
import { ATTEMPT_HISTORY_DIAGNOSTIC_CODE, evaluateTaskPacketConservation } from './execution-attempt.js';
import { renderActivationRepair } from './activation-repair.js';
import { fileMatchesScopePattern } from './scope-matcher.js';
// The canonical dispatch-eligibility evaluator. Preflight resolves facts and
// presents results; every shared prerequisite is decided in this one module,
// the same one packet preparation and role start consume.
import {
  observeDispatchInitialState,
  evaluateDispatchEligibility,
  liveReadinessCandidate,
} from './dispatch-eligibility.js';


export const HANDOFF_PREFLIGHT_KIND = 'agenticloop.handoff-preflight';
export const HANDOFF_PREFLIGHT_SCHEMA_VERSION = 1;

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex')}`;
}

/** Run one Git command inside the target. */
function runGit(target, args) {
  return spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
}

function gitText(target, args) {
  const result = runGit(target, args);
  return result.status === 0 ? String(result.stdout ?? '').trim() : null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Enumerate the current files-backed task inventory the same way dispatch does.
 *
 * Read-only and best effort: an unreadable task directory returns null so the
 * caller reports nothing rather than inventing a membership verdict from an
 * inventory it could not enumerate. "Could not read" is never "nothing there".
 */
function enumerateFilesTaskInventory(target, projectConfig) {
  const template = projectConfig?.task_file_template ?? '.agenticloop/tasks/{taskId}.md';
  const directory = join(target, template.replace(/\{taskId\}.*$/, '').replace(/[\\/]+$/, ''));
  let names;
  try {
    names = readdirSync(directory).filter(name => name.endsWith('.md')).sort();
  } catch {
    return null;
  }
  const entries = [];
  for (const name of names) {
    try {
      entries.push({
        carrier: `${relative(target, join(directory, name)).replace(/\\/g, '/')}`,
        content: readFileSync(join(directory, name), 'utf8'),
        readError: null,
      });
    } catch (error) {
      // An unreadable member is reported as such, never skipped: dropping it
      // would silently shrink membership and make a stale scan look current.
      entries.push({ carrier: name, content: null, readError: String(error.message ?? error) });
    }
  }
  return normalizeFilesTaskInventory({
    inventoryId: 'files:.agenticloop/tasks',
    entries,
    complete: true,
    enumeration: createTaskInventoryEnumeration({
      backend: 'files',
      inventoryId: 'files:.agenticloop/tasks',
      observedAt: new Date().toISOString(),
      discovered: entries.length,
      returned: entries.length,
    }),
  });
}

/**
 * The exact repair for one dirty-checkout refusal.
 *
 * Different dirty shapes have different safe repairs, and lumping them into one
 * sentence sends the caller to the wrong action: staged and unstaged tracked
 * changes are committed or reverted, relevant untracked state is committed or
 * moved into scratch, and pre-existing ignored state has to be removed because
 * it could otherwise be force-added and attributed to the role's work.
 */
function cleanStateRepair(state) {
  const parts = [];
  if (state?.stagedPaths?.length || state?.unstagedPaths?.length) {
    parts.push('Commit or revert the tracked changes');
  }
  if (state?.untrackedRelevantPaths?.length) {
    parts.push(
      'commit the relevant untracked paths as Maintainer-authored evidence, or move transient output under ' +
      `${(state.permittedScratchPrefixes ?? ['.agenticloop/tmp/']).join(' or ')}`
    );
  }
  if (state?.ignoredRelevantPaths?.length) {
    parts.push('remove the pre-existing ignored task-scope paths so they cannot be attributed to the role');
  }
  if (parts.length === 0) return 'Restore a clean checkout before requesting a packet.';
  return `${parts.join('; ')}, then rerun this preflight.`;
}

/**
 * Present one canonical finding as this command's owning repair.
 *
 * This is presentation, not decision: the code, message, evidence state, and
 * disposition all arrive already decided from `dispatch-eligibility.js`. What
 * belongs to `task handoff-preflight` is the exact next command an operator or
 * role should run, which is command-specific and therefore resolved here.
 */
function preflightRepairHint(finding, context) {
  const { taskId, cleanState, decompositionRepair, decompositionSource, returnCapabilityFact } = context;
  if (finding.repairHint) return finding.repairHint;
  const code = String(finding.code ?? '');
  if (code === 'worktree.clean_gate.failed') return cleanStateRepair(cleanState?.state);
  if (code.startsWith('parallel_scan.')) {
    return typeof decompositionRepair === 'function' ? decompositionRepair() : null;
  }
  if (code.startsWith('activation.')) {
    // Preflight already knows the bound work unit and the ready set from the
    // committed decomposition, so the refusal offers the batch and work-unit
    // options instead of one task at a time.
    return renderActivationRepair({
      taskId,
      workUnitId: decompositionSource?.scan?.workUnit?.id ?? null,
      readyTaskIds: (decompositionSource?.scan?.inventory?.members ?? [])
        .filter(member => member?.eligibility?.eligible !== false)
        .map(member => member?.taskId),
    });
  }
  if (code.startsWith('return.')) {
    const matched = (returnCapabilityFact?.errors ?? []).find(item => item.message === finding.message);
    return matched?.repairHint ?? null;
  }
  if (code === 'contract.baseline.invalid' || code === 'contract.baseline.missing') {
    return `Restore the committed append-only contract history for ${taskId} from Git history, or ` +
      `authorize a correction with 'npx agenticloop task authorize-correction ${taskId}'. ` +
      'The history is append-only, so it is repaired by restoring the committed chain, never by rewriting it.';
  }
  if (code === 'capability.declaration.invalid') {
    return 'Repair or reinstall the host adapter so its engineer role declaration is complete, then rerun.';
  }
  if (code.startsWith('task.contract.') || code.startsWith('task.record.') || code.startsWith('task.body.')) {
    return 'Repair the task record frontmatter, then rerun.';
  }
  return `npx agenticloop task readiness ${taskId}`;
}

/**
 * Collect findings into an ordered, de-duplicated list with stable codes.
 * All items are canonical diagnostics produced through createDiagnostic.
 */
class PreflightFindings {
  constructor() {
    this.items = [];
    this.seen = new Set();
  }

  _add(diagnostic) {
    const key = `${diagnostic.level}\0${diagnostic.code}\0${diagnostic.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(diagnostic);
  }

  error(code, message, repairHint = null, evidenceState = 'negative') {
    this._add(createDiagnostic({
      code,
      message,
      evidence: { state: evidenceState, supplied: true, rollbackAuthorized: false },
      ...(repairHint ? { repairHint } : {}),
    }));
  }

  warning(code, message, evidenceState = 'current') {
    this._add(createDiagnostic({
      level: 'warning',
      code,
      message,
      evidence: { state: evidenceState, supplied: true, rollbackAuthorized: false },
    }));
  }

  get hasErrors() {
    return this.items.some(item => item.level !== 'warning');
  }

  get errorItems() {
    return this.items.filter(item => item.level !== 'warning');
  }

  get warningItems() {
    return this.items.filter(item => item.level === 'warning');
  }

  get primaryErrorCode() {
    const err = this.errorItems[0];
    return err?.code ?? null;
  }

  get firstRepairHint() {
    const err = this.errorItems.find(item => item.repairHint);
    return err?.repairHint ?? null;
  }
}

/**
 * Evaluate one task's handoff preflight state.
 *
 * Returns a closed validation-result-compatible shape with domain fields.
 * Every check reuses existing canonical validators; this function only
 * orchestrates and collects.
 *
 * @param {{
 *   target: string,
 *   taskId: string,
 *   backend: string,
 *   projectConfig: object,
 *   io: object,
 *   host?: string,
 *   hostTrustStore?: string,
 *   returnAdapter?: string,
 *   now?: string,
 * }} input
 */
export function evaluateHandoffPreflight(input) {
  const {
    target,
    taskId,
    backend,
    projectConfig,
    io,
    host: requestedHost,
    hostTrustStore,
    returnAdapter = null,
    now = new Date().toISOString(),
  } = input;

  const command = 'task handoff-preflight';
  const findings = new PreflightFindings();
  const resolvedTarget = resolve(target);

  // ── 1. Task snapshot ──────────────────────────────────────────────────
  let snapshot = null;
  let taskCarrierPath = null;
  let taskCarrierDigest = null;
  let taskContract = null;
  let taskContractDigestValue = null;

  if (backend === 'files') {
    const relPath = (projectConfig.task_file_template ?? '.agenticloop/tasks/{taskId}.md')
      .replace(/\{taskId\}/g, taskId);
    taskCarrierPath = relPath.replace(/\\/g, '/');
    const fullPath = join(resolvedTarget, relPath);
    if (!existsSync(fullPath)) {
      findings.error(
        'task.contract.absent',
        `task record not found: ${taskCarrierPath}`,
        `Create the task record at ${taskCarrierPath}, then rerun.`,
        'missing'
      );
    } else {
      try {
        const body = readFileSync(fullPath, 'utf8');
        taskCarrierDigest = digestBytes(body);
        taskContract = taskContractDigest(body);
        if (!taskContract.ok) {
          findings.error(
            'task.contract.malformed',
            `task contract is invalid: ${taskContract.error}`,
            'Repair the task record frontmatter, then rerun.',
            'malformed'
          );
        } else {
          taskContractDigestValue = taskContract.digest;
          if (taskContract.projection.task_id !== taskId) {
            findings.error(
              'task.record.identity_mismatch',
              `task contract task_id '${taskContract.projection.task_id}' does not match requested '${taskId}'`,
              'Correct the task_id frontmatter field, then rerun.',
              'malformed'
            );
          } else {
            snapshot = {
              backend: 'files', taskId, carrier: taskCarrierPath,
              body, digest: taskCarrierDigest,
              trustedRecords: [], trustedRecordErrors: [],
            };
            // Load trusted records for contract baseline validation.
            //
            // These errors used to be collected and then dropped - "optional for
            // the preflight report" - while `prepareRoleDispatch` refuses any
            // packet whose readiness evidence carries a non-empty
            // `trustedRecordErrors`. A deleted or rewritten append-only contract
            // history therefore produced a green preflight and a blocked
            // dispatch over identical committed facts.
            //
            // The trusted contract baseline is one of the dimensions a single
            // preflight is required to answer for, and a broken append-only
            // provenance chain is Maintainer-owned authoring work, so it is
            // reported here with its owning repair.
            try {
              const history = loadFilesTaskContractRecords(resolvedTarget, taskId);
              snapshot.trustedRecords = history.trustedRecords;
              snapshot.trustedRecordErrors = history.errors;
            } catch (error) {
              // An unreadable history is unevaluable state, not proof of
              // absence. It is recorded on the snapshot as the fact it is; the
              // canonical evaluator decides that it blocks, with the same code
              // and evidence classification packet preparation uses.
              snapshot.trustedRecordErrors = [`task-contract history for ${taskId} is unreadable: ${error.message}`];
            }
          }
        }
      } catch (error) {
        findings.error(
          'cli.operational',
          `task record is unreadable: ${error.message}`,
          'Ensure the task record file is readable, then rerun.',
          'malformed'
        );
      }
    }
  } else if (backend === 'github') {
    // ── GitHub backend: fetch task record from a GitHub issue ──
    // Resolve the issue number from the taskId. Two formats are accepted:
    //   #NUMBER  — direct issue number
    //   T-NNN    — resolved via the task label (task:T-NNN)
    let ghIssueNumber = null;
    const issueNumberMatch = String(taskId).match(/^#(\d+)$/);
    if (issueNumberMatch) {
      ghIssueNumber = Number(issueNumberMatch[1]);
    } else {
      // Try to resolve by task label (default template: task:{taskId})
      try {
        const ghRunner = io?.ghCommandRunner ?? defaultGhCommandRunner;
        const labelResult = runGhJson(ghRunner, [
          'issue', 'list', '--label', `task:${taskId}`, '--json', 'number', '--limit', '1',
        ]);
        if (Array.isArray(labelResult) && labelResult.length === 1 && Number.isInteger(Number(labelResult[0]?.number))) {
          ghIssueNumber = Number(labelResult[0].number);
        }
      } catch {
        // Label resolution failed; fall through to error diagnostic.
      }
    }

    if (!ghIssueNumber) {
      findings.error(
        'task.contract.absent',
        `GitHub backend requires a valid issue number; taskId '${taskId}' could not be resolved to an issue`,
        'Provide a taskId in #NUMBER format or ensure the task label (task:<id>) exists, then rerun.',
        'missing'
      );
    } else {
      try {
        const ghRunner = io?.ghCommandRunner ?? defaultGhCommandRunner;
        const data = runGhJson(ghRunner, ['issue', 'view', String(ghIssueNumber), '--json', 'body,number']);
        if (!data || typeof data.body !== 'string') {
          findings.error(
            'task.contract.absent',
            `GitHub issue #${ghIssueNumber} has no readable body`,
            'Ensure the issue has a task-record body, then rerun.',
            'missing'
          );
        } else {
          const body = data.body;
          taskCarrierDigest = digestBytes(body);
          taskContract = taskContractDigest(body);
          if (!taskContract.ok) {
            findings.error(
              'task.contract.malformed',
              `task contract is invalid: ${taskContract.error}`,
              'Repair the issue task-record frontmatter, then rerun.',
              'malformed'
            );
          } else {
            taskContractDigestValue = taskContract.digest;
            // Resolve GitHub task identity (frontmatter task_id or issue-number fallback)
            const identity = resolveGitHubTaskIdentityStrict({ number: ghIssueNumber, body });
            if (!identity.ok) {
              findings.error(
                'task.contract.malformed',
                identity.diagnostic?.message ?? 'GitHub task identity is malformed',
                'Repair the issue task-record frontmatter, then rerun.',
                'malformed'
              );
            } else {
              const resolvedTaskId = identity.identity?.taskId ?? `#${ghIssueNumber}`;
              if (resolvedTaskId !== taskId) {
                findings.error(
                  'task.record.identity_mismatch',
                  `task contract task_id '${resolvedTaskId}' does not match requested '${taskId}'`,
                  'Correct the task_id frontmatter field or use the correct taskId, then rerun.',
                  'malformed'
                );
              } else {
                taskCarrierPath = `issue:${ghIssueNumber}`;
                snapshot = {
                  backend: 'github',
                  taskId,
                  carrier: taskCarrierPath,
                  body,
                  digest: taskCarrierDigest,
                  trustedRecords: [],
                  trustedRecordErrors: [],
                };
              }
            }
          }
        }
      } catch (error) {
        const detail = String(error?.message ?? error);
        let hint = '';
        if (/not logged|authentication|gh auth/i.test(detail)) {
          hint = " Run 'gh auth login' first.";
        }
        findings.error(
          'cli.operational',
          `GitHub task fetch failed: ${detail}${hint}`,
          'Ensure the gh CLI is installed and authenticated, then rerun.',
          'missing'
        );
      }
    }
  } else {
    findings.error(
      'cli.operational',
      `unsupported task backend '${backend}'`,
      "Set task_backend to 'files' in .agenticloop/project.md, then rerun.",
      'negative'
    );
  }

  // ── 1b. Lifecycle dispatchability ─────────────────────────────────────
  // The same gate role start applies, asked here so a green preflight cannot be
  // refused later over unchanged facts.
  let lifecycle = null;

  if (snapshot) {
    // Reported, not decided: the canonical evaluator asks the same gate and
    // owns the refusal, so preflight cannot pass a status role start refuses.
    const evaluated = evaluateDispatchableLifecycle(taskStatusFromBody(snapshot.body));
    lifecycle = { status: evaluated.status, dispatchable: evaluated.ok };
  }

  // ── 1c. Decomposition source ──────────────────────────────────────────
  // Loaded before activation and readiness because both consume it: readiness
  // resolves its dependency snapshot through it, and an activation refusal
  // reads the bound work unit and ready set from it so it can offer the batch
  // and work-unit options instead of one task at a time.
  let decompositionSource = null;

  if (snapshot) {
    const decompositionSourceRef = `.agenticloop/decompositions/${taskId}.json`;
    const decompositionFullPath = join(resolvedTarget, decompositionSourceRef);
    if (existsSync(decompositionFullPath)) {
      try {
        decompositionSource = JSON.parse(readFileSync(decompositionFullPath, 'utf8'));
      } catch {
        decompositionSource = null;
      }
    }
  }

  // ── 2. Activation ─────────────────────────────────────────────────────
  let activationState = null;
  let activationAssurance = null;
  let effectivePolicy = null;
  let operatorAuthorization = 'unknown';
  let activationUsability = 'unknown';
  /** The resolved activation authority, handed to the canonical evaluator to grade. */
  let authorizationFact = null;

  function formatDecompositionRepairCommand({ taskId, sourceRef, baseTree, head, decompositionSource }) {
    const workUnit = decompositionSource?.scan?.workUnit?.id ?? `work-unit:${taskId}`;
    const sourceRevision = decompositionSource?.scan?.decomposition?.revision ?? head ?? 'HEAD';
    const base = baseTree ?? 'HEAD';
    const dependencies = decompositionSource?.scan?.readinessContext?.dependencies?.sourceRef ?? `.agenticloop/decompositions/${taskId}.dependencies.json`;
    return `npx agenticloop task prepare-decomposition ${taskId} --work-unit ${workUnit} --source-ref ${sourceRef} --source-revision ${sourceRevision} --base ${base} --dependencies ${dependencies}`;
  }

  try {
    effectivePolicy = resolveEffectiveActivationPolicy(resolvedTarget, io);
  } catch (error) {
    findings.error(
      'cli.operational',
      `activation policy could not be resolved: ${error.message}`,
      'Repair the activation policy in agenticloop.json or operator trust, then rerun.',
      'malformed'
    );
  }

  if (snapshot && effectivePolicy) {
    try {
      const contract = taskContract ?? taskContractDigest(snapshot.body);
      if (contract?.ok) {
        const ref = contract.projection.activation_capture_ref;
        if (ref) {
          activationState = { source: 'legacy_task_capture', captureRef: ref };
          activationAssurance = 'host_signed';
          operatorAuthorization = 'authorized';
          activationUsability = 'usable';
          authorizationFact = { state: 'present', assurance: 'host_signed', errors: [] };
        } else {
          const auth = resolveCurrentTaskAuthorization(resolvedTarget, io, {
            backend: snapshot.backend,
            taskId: snapshot.taskId,
            carrier: snapshot.carrier,
            taskContractDigest: taskContractDigestValue,
            now: Date.parse(now) || undefined,
          });
          if (auth.state === 'present') {
            activationState = {
              source: 'activation_grant',
              binding: auth.binding ?? null,
              grant: auth.grant ?? null,
            };
            activationAssurance = auth.assurance;
            operatorAuthorization = 'authorized';
            activationUsability = 'usable';
            authorizationFact = { state: 'present', assurance: auth.assurance, errors: [] };
          } else {
            operatorAuthorization = auth.state;
            activationUsability = 'blocked';
            authorizationFact = { state: auth.state, assurance: null, errors: auth.errors ?? [] };
          }
        }
      }
    } catch (error) {
      findings.error(
        'cli.operational',
        `activation resolution failed: ${error.message}`,
        'Repair the activation evidence, then rerun.',
        'malformed'
      );
      operatorAuthorization = 'malformed';
      activationUsability = 'blocked';
      authorizationFact = { state: 'malformed', assurance: null, errors: [`activation resolution failed: ${error.message}`] };
    }
  }

  // ── 4. Readiness ──────────────────────────────────────────────────────
  let readinessResult = null;
  /** The live authoring readiness observation the canonical evaluator grades. */
  let readinessObservation = null;
  let dependencyAge = { state: 'missing', evaluatedAt: null, maxAgeSeconds: null };

  if (snapshot) {
    try {
      const contract = taskContract ?? taskContractDigest(snapshot.body);
      if (contract?.ok) {
        const baseTree = gitText(resolvedTarget, ['rev-parse', 'HEAD^{tree}']);
        if (!baseTree || !isGitObjectId(baseTree)) {
          findings.error(
            'readiness.base_inventory.missing',
            'could not resolve HEAD^{tree} for readiness evaluation',
            'Ensure the repository has a HEAD commit, then rerun.',
            'missing'
          );
        } else {
          const listed = runGit(resolvedTarget, ['ls-tree', '-r', '--name-only', baseTree]);
          const basePaths = listed.status === 0
            ? String(listed.stdout ?? '').split(/\r?\n/).filter(Boolean)
            : [baseTree];

          let depStatuses = {};
          let parsedDepSnapshot = null;
          const depSourceRef = decompositionSource?.scan?.readinessContext?.dependencies?.sourceRef;
          if (depSourceRef) {
            const depFullPath = join(resolvedTarget, depSourceRef);
            if (existsSync(depFullPath)) {
              try {
                const depContent = readFileSync(depFullPath, 'utf8');
                parsedDepSnapshot = parseDependencySnapshot(depContent, { sourceRef: depSourceRef, now: Date.parse(now) });
                if (parsedDepSnapshot.ok) {
                  depStatuses = dependencyStatusMap(parsedDepSnapshot.evidence);
                }
              } catch {
                depStatuses = {};
              }
            }
          }

          const evaluated = evaluateTaskReadiness({
            taskBody: snapshot.body,
            basePaths,
            mode: 'authoring',
            dependencies: depStatuses,
          });
          readinessResult = {
            ok: evaluated.ok,
            evidenceState: evaluated.evidenceState,
            disposition: evaluated.disposition,
            errors: evaluated.errors,
            warnings: evaluated.warnings,
            base: { identity: `git-tree:${baseTree}` },
            dependencies: evaluated.dependencies ?? null,
            evaluatedAt: now,
          };
          // Handed to the canonical evaluator rather than graded here: an
          // authoring readiness error blocks, and is never downgraded into
          // advice at one boundary and enforced at another.
          readinessObservation = {
            diagnostics: evaluated.diagnostics ?? [],
            base: { identity: `git-tree:${baseTree}` },
          };
          if (parsedDepSnapshot?.ok) {
            const observedAt = parsedDepSnapshot.evidence.observedAt;
            const maxAgeSeconds = parsedDepSnapshot.evidence.freshnessPolicy.maxAgeSeconds;
            const ageSeconds = (Date.parse(now) - Date.parse(observedAt)) / 1000;
            const state = ageSeconds > maxAgeSeconds ? 'stale' : 'observed';
            dependencyAge = { state, evaluatedAt: now, maxAgeSeconds, observedAt };
          } else if (decompositionSource) {
            if (!depSourceRef) {
              dependencyAge = { state: 'observed', evaluatedAt: now, maxAgeSeconds: null };
            } else {
              const stale = parsedDepSnapshot?.errors?.some(error => /stale|future/i.test(error)) ?? false;
              dependencyAge = { state: stale ? 'stale' : 'missing', evaluatedAt: now, maxAgeSeconds: null };
            }
          }
        }
      }
    } catch (error) {
      findings.error(
        'cli.operational',
        `readiness evaluation failed: ${error.message}`,
        'Repair the readiness evidence, then rerun.',
        'negative'
      );
    }
  }

  // ── 5. Decomposition ──────────────────────────────────────────────────
  let decompositionDispatchable = null;
  /** Resolved work-unit inputs the canonical evaluator decides over. */
  let currentTaskInventory = null;
  let inventoryRecheck = null;
  let decompositionRepair = null;
  let decompositionResolutionReported = false;

  if (snapshot) {
    const sourceRef = `.agenticloop/decompositions/${taskId}.json`;
    const fullPath = join(resolvedTarget, sourceRef);
    const head = gitText(resolvedTarget, ['rev-parse', '--verify', 'HEAD']);
    const baseTree = gitText(resolvedTarget, ['rev-parse', 'HEAD^{tree}']);
    const repairCommand = () => formatDecompositionRepairCommand({ taskId, sourceRef, baseTree, head, decompositionSource });
    decompositionRepair = repairCommand;
    if (!decompositionSource) {
      // Resolution reports what it could not read; the canonical evaluator
      // decides that an unresolvable source authorizes no dispatch.
      findings.error(
        'parallel_scan.decomposition.invalid',
        existsSync(fullPath)
          ? `decomposition source is unreadable: ${sourceRef}`
          : `decomposition source not found: ${sourceRef}`,
        repairCommand(),
        existsSync(fullPath) ? 'malformed' : 'missing'
      );
      decompositionResolutionReported = true;
    } else {
      try {
        const schemaVersion = decompositionSource?.schemaVersion;
        const sourceRefPath = decompositionSource?.sourceRef;
        const sourceRevision = decompositionSource?.scan?.decomposition?.revision ?? null;
        const members = decompositionSource?.scan?.inventory?.members ?? [];
        const member = members.find(candidate => candidate?.taskId === taskId);
        const eligibility = member?.eligibility ?? null;
        const eligibilityProjection = createDecompositionEligibilityProjection({
          taskId,
          backend,
          contractDigest: taskContractDigestValue,
          scan: decompositionSource?.scan,
          taskFacts: {
            requiredChecks: taskContract?.projection?.required_checks ?? null,
            scope: taskContract?.projection?.allowed_paths ?? null,
          },
        });

        // Both the decomposition verdict and the work-unit membership recheck
        // are the canonical evaluator's. Preflight resolves the inputs - the
        // committed source above, the freshly enumerated backend inventory and
        // the eligibility recheck below - and projects the result. It used to
        // run `validateDecomposition` itself and re-enumerate membership beside
        // packet preparation doing the same; that duplication is what made
        // the membership divergence possible and is now removed.
        if (backend === 'files' && isObject(decompositionSource?.scan?.workUnit)) {
          currentTaskInventory = enumerateFilesTaskInventory(resolvedTarget, projectConfig);
          if (taskContract?.ok) {
            inventoryRecheck = {
              taskId,
              backend: decompositionSource.scan.workUnit.backend,
              currentContractDigest: taskContractDigestValue,
              runGit: args => runGit(resolvedTarget, args),
              baseEvidence: decompositionSource?.scan?.readinessContext?.base ?? null,
              dependencyEvidence: decompositionSource?.scan?.readinessContext?.dependencies ?? null,
            };
          }
        }
        decompositionRepair = repairCommand;

        decompositionDispatchable = {
          schemaVersion,
          sourceRef: sourceRefPath ?? sourceRef,
          sourceRevision: sourceRevision ?? null,
          sourceCommit: sourceRevision ?? null,
          maintainerAttribution: decompositionSource?.authority === 'maintainer',
          inventoryComplete: decompositionSource?.scan?.inventory?.complete === true &&
            decompositionSource?.scan?.decomposition?.state === 'complete',
          baseMode: decompositionSource?.scan?.readinessContext?.base?.kind ?? 'unknown',
          baseValid: decompositionSource?.scan?.readinessContext?.base?.kind === 'git_tree' &&
            typeof decompositionSource?.scan?.readinessContext?.base?.identity === 'string' &&
            decompositionSource.scan.readinessContext.base.identity.startsWith('git-tree:'),
          eligibility,
          eligibilityDigest: eligibilityProjection.digest,
          eligibilityProjection,
          // Filled in from the canonical decision once it is taken.
          dispatchCompatible: null,
        };
      } catch (error) {
        findings.error(
          'parallel_scan.decomposition.invalid',
          `decomposition source is unreadable: ${error.message}`,
          `Regenerate the decomposition: ${repairCommand()}`,
          'malformed'
        );
      }
    }
  }

  // ── 6. Repository state ───────────────────────────────────────────────
  let repositoryState = null;
  let cleanStateClassification = 'unknown';
  /** The observed initial repository state the canonical evaluator grades. */
  let cleanStateObservation = null;

  {
    const head = gitText(resolvedTarget, ['rev-parse', '--verify', 'HEAD']);
    const branch = gitText(resolvedTarget, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const baseTree = gitText(resolvedTarget, ['rev-parse', 'HEAD^{tree}']);

    if (!head || !isGitObjectId(head)) {
      findings.error(
        'cli.operational',
        'HEAD is not a valid Git object',
        'Ensure the repository has a HEAD commit, then rerun.',
        'malformed'
      );
    } else {
      repositoryState = {
        worktree: resolve(resolvedTarget),
        branch: branch ?? null,
        head,
        baseTree: baseTree && isGitObjectId(baseTree) ? baseTree : null,
        // Before an Engineer return exists, the current checkout tree is the
        // only product base this read-only preflight can prove. Never label the
        // current commit itself as a product artifact head.
        productBase: baseTree && isGitObjectId(baseTree) ? baseTree : null,
      };

      // One evaluator, one verdict. Preflight and `prepare-dispatch` always
      // called the same `evaluateDispatchCleanState`, but preflight downgraded
      // its findings to warnings and told the caller the gate "may" refuse
      // later - so a dirty checkout produced a green preflight and a blocked
      // dispatch over identical facts. Preflight now only observes;
      // the classification is the canonical evaluator's, so the two boundaries
      // are structurally unable to disagree about it again.
      try {
        const scopeContract = snapshot ? (taskContract ?? taskContractDigest(snapshot.body)) : null;
        cleanStateObservation = observeDispatchInitialState({
          runGit: args => runGit(resolvedTarget, args),
          scopePatterns: scopeContract?.ok ? scopeContract.projection.allowed_paths ?? [] : [],
          intendedCreations: scopeContract?.ok ? scopeContract.projection.intended_creations ?? [] : [],
        });
        cleanStateClassification = cleanStateObservation.clean?.ok === true ? 'clean' : 'dirty';
      } catch (error) {
        cleanStateClassification = 'unknown';
        findings.warning('cli.operational', `clean state evaluation failed: ${error.message}`, 'malformed');
      }
    }
  }

  // ── 7. Host-role capability ───────────────────────────────────────────
  let hostRoleCapability = null;
  let degradedEnforcementReports = [];
  /** The resolved host-role declaration the canonical evaluator grades. */
  let hostRoleCapabilityFact = null;

  try {
    const config = {};
    try {
      const configPath = join(resolvedTarget, 'agenticloop.json');
      if (existsSync(configPath)) {
        Object.assign(config, loadAgenticLoopConfig(configPath));
      }
    } catch (error) {
      findings.error(
        'cli.operational',
        `agenticloop.json is present but unreadable: ${error.message}`,
        'Repair agenticloop.json, then rerun.',
        'malformed'
      );
    }
    const hostRoleCapabilities = buildHostRoleCapabilityInventory({
      adapterConfigs: config.adapters ?? {},
    });
    const availableHosts = Object.keys(hostRoleCapabilities);
    const configuredHosts = Object.keys(config.adapters ?? {});
    // The shippable inventory (availableHosts) is always every supported host,
    // so it is never the operator's selection. The set that actually drives the
    // pick is the operator's configured adapters; when none are configured there
    // is no operator choice to disambiguate and a single canonical default host
    // applies. The ambiguity check runs against that selection set rather than
    // one-sidedly on `configured` while silently taking the first shippable host.
    const defaultHost = availableHosts.includes('opencode') ? 'opencode' : (availableHosts[0] ?? 'opencode');
    const selectionHosts = configuredHosts.length > 0 ? configuredHosts : [defaultHost];
    let host;
    if (requestedHost) {
      if (!hostRoleCapabilities[requestedHost]) {
        findings.error(
          'cli.operational',
          `requested host '${requestedHost}' is not a recognized adapter host; available: ${availableHosts.join(', ') || '(none)'}`,
          `Specify --host with one of: ${availableHosts.join(', ') || 'opencode'}.`,
          'negative'
        );
        host = null;
      } else {
        host = requestedHost;
      }
    } else if (selectionHosts.length > 1) {
      findings.error(
        'cli.operational',
        `host is ambiguous; ${selectionHosts.length} adapter hosts are configured (${selectionHosts.join(', ')}); specify --host <id>`,
        `Specify --host with one of: ${selectionHosts.join(', ')}.`,
        'negative'
      );
      host = null;
    } else {
      host = selectionHosts[0];
    }
    if (host) {
      const declaration = hostRoleCapabilities[host]?.engineer;
      if (declaration) {
        const checked = validateHostRoleCapabilityDeclaration(declaration);
        if (checked.ok) {
          hostRoleCapability = { host, roleId: 'engineer', declaration };
          degradedEnforcementReports = createDegradedEnforcementReports(declaration);
          hostRoleCapabilityFact = { host, roleId: 'engineer', declaration, errors: [] };
        } else {
          // Packet preparation refuses an invalid declaration outright. Preflight
          // used to report it as advice, which is the same false-green shape as
          // the clean-state divergence; the canonical evaluator now decides it for both.
          hostRoleCapabilityFact = { host, roleId: 'engineer', declaration: null, errors: checked.errors };
        }
      }
    }
  } catch (error) {
    findings.warning('capability.resolution.failed', `host-role capability resolution failed: ${error.message}`, 'malformed');
  }

  // ── 8. Return-adapter resolution ──────────────────────────────────────
  let returnAdapterResolution = null;
  /** Resolved return-capability facts the canonical evaluator grades. */
  const returnCapabilityFact = { errors: [], warnings: [] };

  try {
    const store = loadHostTrustStore(resolvedTarget, {
      operatorTrustRoot: io?.operatorTrustRoot ?? undefined,
      assertedPath: hostTrustStore,
      protectedBoundary: io?.hostAuthority ?? undefined,
    });
    const registerHint =
      'Register a host adapter with returnReceipt capability: npx agenticloop host-trust register <adapter-id> --key-id <id> --public-key <base64-or-path> --return-receipt supported';
    if (store.ok) {
      const eligibleAdapters = Object.values(store.adapters ?? {})
        .filter(adapter => adapter?.capabilities?.returnReceipt === 'supported');
      const eligibleIds = eligibleAdapters.map(a => a.adapterId);
      if (returnAdapter) {
        // An explicit operator selection is authoritative: honor it when it
        // names an eligible adapter and reject it otherwise. A valid selection
        // resolves the boundary, so the ambiguity error and warning below are
        // never reached.
        const chosen = eligibleAdapters.find(a => a.adapterId === returnAdapter) ?? null;
        if (!chosen) {
          returnCapabilityFact.errors.push({
            code: 'return.assurance.insufficient',
            message: `requested return adapter '${returnAdapter}' is not an eligible protected-boundary adapter with returnReceipt support; eligible: ${eligibleIds.join(', ') || '(none)'}`,
            repairHint: eligibleIds.length
              ? `Use --return-adapter with one of: ${eligibleIds.join(', ')}.`
              : registerHint,
          });
          returnAdapterResolution = { state: 'unmatched', requested: returnAdapter, adapters: eligibleIds };
        } else {
          returnAdapterResolution = {
            state: 'resolved',
            adapter: { adapterId: chosen.adapterId, keyId: chosen.keyId },
            adapters: eligibleIds,
          };
        }
      } else if (effectivePolicy?.mode === 'hardened' && eligibleAdapters.length === 0) {
        returnCapabilityFact.errors.push({
          code: 'return.assurance.insufficient',
          message: 'hardened mode requires a protected-boundary return adapter with returnReceipt support',
          repairHint: registerHint,
        });
        returnAdapterResolution = { state: 'missing', adapters: [] };
      } else if (effectivePolicy?.mode === 'hardened' && eligibleAdapters.length > 1) {
        returnCapabilityFact.errors.push({
          code: 'return.assurance.insufficient',
          message: 'multiple return adapters are available; select one with --return-adapter',
          repairHint: `Use --return-adapter with one of: ${eligibleIds.join(', ')}.`,
        });
        returnAdapterResolution = { state: 'ambiguous', adapters: eligibleIds };
      } else {
        const selected = eligibleAdapters[0] ?? null;
        if (eligibleAdapters.length > 1 && effectivePolicy?.mode !== 'hardened') {
          returnCapabilityFact.warnings.push({
            code: 'return.assurance.ambiguous',
            evidenceState: 'current',
            message: `multiple return adapters are available (${eligibleIds.join(', ')}); selected '${selected?.adapterId}'; use --return-adapter to select a specific adapter`,
          });
        }
        returnAdapterResolution = {
          state: selected ? 'resolved' : 'none_required',
          adapter: selected ? { adapterId: selected.adapterId, keyId: selected.keyId } : null,
          adapters: eligibleIds,
        };
      }
    } else {
      returnAdapterResolution = { state: 'no_store', adapters: [] };
      if (effectivePolicy?.mode === 'hardened') {
        findings.error(
          'cli.operational',
          'hardened mode requires an operator-pinned host trust store',
          registerHint,
          'negative'
        );
      }
    }
  } catch (error) {
    returnAdapterResolution = { state: 'error', error: error.message, adapters: [] };
  }

  // ── 9. Sibling-worktree collisions ──────────────────────────────────────
  let siblingCollisions = [];
  let siblingWorktrees = [];

  if (repositoryState) {
    try {
      const context = resolveGitRepositoryContext(resolvedTarget);
      const allWorktrees = listAgenticLoopWorktrees(context);
      const currentPath = resolve(resolvedTarget);

      // Get current task's scope patterns
      const scopeContract = snapshot ? (taskContract ?? taskContractDigest(snapshot.body)) : null;
      const scopePatterns = scopeContract?.ok ? scopeContract.projection.allowed_paths ?? [] : [];

      const hasScope = scopePatterns.length > 0;

      for (const wt of allWorktrees) {
        if (resolve(wt.path) === currentPath) continue;

        // Non-standard siblings: advisory only, not collisions
        if (wt.location !== 'standard') {
          siblingWorktrees.push({
            worktreePath: relative(context.repoRoot, wt.path).replace(/\\/g, '/'),
            location: wt.location,
            reason: `non-standard sibling worktree (${wt.location})`,
          });
          continue;
        }

        // No scope declared: advisory that overlap cannot be evaluated
        if (!hasScope) {
          siblingWorktrees.push({
            worktreePath: relative(context.repoRoot, wt.path).replace(/\\/g, '/'),
            taskId: wt.taskId ?? null,
            location: wt.location,
            reason: 'task declares no allowed_paths; sibling overlap cannot be evaluated',
          });
          continue;
        }

        // Only report dirty siblings that overlap with our scope
        if (wt.blockingDirtyCount === 0) continue;

        const dirtyPaths = (wt.blockingDirtyFiles ?? []);
        const overlapping = dirtyPaths.filter(path =>
          scopePatterns.some(pattern => fileMatchesScopePattern(path, pattern))
        );
        if (overlapping.length > 0) {
          siblingCollisions.push({
            worktreePath: relative(context.repoRoot, wt.path).replace(/\\/g, '/'),
            taskId: wt.taskId ?? null,
            dirtyCount: wt.blockingDirtyCount,
            overlappingPaths: overlapping.slice(0, 5),
            reason: 'dirty sibling worktree has files overlapping with task scope',
          });
        }
      }
    } catch {
      // Sibling detection is advisory; failures don't block the preflight.
    }
  }

  // ── 9b. The one canonical semantic decision ───────────────────────────
  //
  // Everything above resolves facts: task retrieval, backend inventory
  // enumeration, Git and filesystem observation, host selection, trust-store
  // loading, and sibling-worktree advisory analysis. Not one shared dispatch
  // prerequisite is decided there any more. Lifecycle, task contract, trusted
  // baseline, required checks, activation and its assurance, readiness,
  // dependency evidence, decomposition, Maintainer attribution, task
  // eligibility, work-unit membership, repository identity, base identity,
  // clean state, host-role capability, and return capability are all decided
  // once here, by the same evaluator packet preparation and role start use.
  //
  // Preflight keeps only its presentation: the owning repair for each canonical
  // finding, its command-specific domain fields, and boundary-only advisories.
  let eligibility = null;
  if (snapshot) {
    eligibility = evaluateDispatchEligibility(liveReadinessCandidate({
      snapshot,
      authorization: authorizationFact,
      readinessObservation,
      dependencyObservation: dependencyAge,
      repository: repositoryState,
      decomposition: decompositionSource,
      parallelScanInventory: currentTaskInventory,
      hostRoleCapability: hostRoleCapabilityFact,
      policy: effectivePolicy
        ? { mode: effectivePolicy.mode, minimumActivation: effectivePolicy.minimumActivation }
        : null,
      returnCapability: returnCapabilityFact,
      cleanStateObservation,
      inventoryRecheck,
      authority: {},
      now: Date.parse(now) || undefined,
    }));

    for (const finding of eligibility.findings) {
      // The boundary already named the exact unreadable path and its repair;
      // the canonical decision still refuses, it simply does not restate it.
      if (decompositionResolutionReported &&
          finding.code === 'parallel_scan.decomposition.invalid' &&
          /absent or could not be read/.test(finding.message)) continue;
      findings.error(
        finding.code,
        finding.message,
        preflightRepairHint(finding, {
          taskId,
          cleanState: cleanStateObservation?.clean ?? null,
          decompositionRepair,
          decompositionSource,
          returnCapabilityFact,
        }),
        finding.evidenceState
      );
    }
    for (const warning of eligibility.warnings) {
      findings.warning(warning.code, warning.message, warning.evidenceState);
    }
    if (decompositionDispatchable) {
      decompositionDispatchable.dispatchCompatible =
        eligibility.dimensions.decomposition.state === 'satisfied';
    }
  }

  // ── 10. Build result ──────────────────────────────────────────────────
  const hasErrors = findings.hasErrors;
  const primaryError = findings.errorItems[0] ?? null;

  // Diagnostics are already canonical (created through createDiagnostic)
  const diagnostics = findings.errorItems;
  const warningDiagnostics = findings.warningItems;

  // Derive evidence state from the primary error's diagnostic evidence
  const evidenceState = primaryError?.evidence?.state ?? 'current';
  const disposition = hasErrors ? 'blocked' : 'proceed';

  const activation = activationState ? {
    source: activationState.source ?? null,
    assurance: activationAssurance,
    policyMode: effectivePolicy?.mode ?? null,
    policySource: effectivePolicy?.source ?? null,
    policyMinimum: effectivePolicy?.minimumActivation ?? null,
    usability: activationUsability,
  } : null;

  // What preflight is about to require, in order, including the commits each
  // step forces. A point-in-time green that does not survive its own prescribed
  // next action is a false green; reporting the sequence is what makes it a
  // prediction rather than a snapshot.
  const conservation = backend === 'files'
    ? evaluateTaskPacketConservation(resolvedTarget, taskId, { backend })
    : { ok: true, liveAttempt: null };
  // Rewritten execution provenance is a pre-dispatch refusal, not an
  // after-the-fact discovery. Preflight is where a role would next mint a
  // packet, so it is where a reset attempt range has to stop.
  if (conservation.historyIntegrity && conservation.historyIntegrity.ok === false) {
    findings.error(
      ATTEMPT_HISTORY_DIAGNOSTIC_CODE,
      conservation.historyIntegrity.reason,
      conservation.historyIntegrity.repair,
      'changed'
    );
  }
  const nextSequence = deriveHandoffSequence({
    taskId,
    backend,
    host: hostRoleCapability?.host ?? requestedHost ?? null,
    liveAttempt: conservation.liveAttempt,
    newPacketPermitted: conservation.ok,
  });

  const domain = {
    kind: HANDOFF_PREFLIGHT_KIND,
    schemaVersion: HANDOFF_PREFLIGHT_SCHEMA_VERSION,
    taskId,
    backend,
    carrier: taskCarrierPath ?? `issue:${taskId}`,
    carrierDigest: taskCarrierDigest ?? null,
    contractDigest: taskContractDigestValue ?? null,
    lifecycle,
    activation,
    operatorAuthorization,
    readiness: readinessResult,
    dependencyAge,
    decomposition: decompositionDispatchable,
    repository: repositoryState,
    cleanState: cleanStateClassification,
    cleanStateAdvisory: cleanStateClassification === 'dirty',
    hostRoleCapability: hostRoleCapability ? {
      host: hostRoleCapability.host,
      roleId: hostRoleCapability.roleId,
      declaration: hostRoleCapability.declaration,
    } : null,
    returnAdapter: returnAdapterResolution,
    nextSequence,
    siblingCollisions,
    siblingWorktrees,
    degradedEnforcementReports: degradedEnforcementReports.map(r => ({
      host: r.host, roleId: r.roleId, action: r.action, enforcement: r.enforcement,
    })),
  };

  const result = createValidationResult({
    command,
    ok: !hasErrors,
    evidenceState,
    disposition,
    diagnostics,
    warningDiagnostics,
    firstSafeRepair: findings.firstRepairHint,
  });

  const presented = presentGateResultForTarget(result, resolvedTarget);
  const firstSafeRepair = presented.diagnostics[0]?.repairHint ?? presented.firstSafeRepair ?? null;
  const dispositionOwner = presented.diagnostics[0]?.owner ?? null;

  return {
    ...presented,
    ...domain,
    firstSafeRepair,
    dispositionOwner,
  };
}
