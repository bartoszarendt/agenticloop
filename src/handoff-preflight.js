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
import { existsSync, readFileSync } from 'node:fs';
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
import { evaluateDispatchCleanState } from './repository-state.js';
import {
  resolveEffectiveActivationPolicy,
  resolveCurrentTaskAuthorization,
} from './activation-resolution.js';
import { loadHostTrustStore } from './host-trust.js';
import { taskContractDigest } from './task-contract-baseline.js';
import { loadFilesTaskContractRecords } from './files-task-contract.js';
import { evaluateTaskReadiness } from './task-readiness.js';
import {
  DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
  dispatchableLifecycleRepair,
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
import { fileMatchesScopePattern } from './scope-matcher.js';
import {
  FindingSet,
  validateDecomposition,
} from './dispatch-envelope.js';

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
            try {
              const history = loadFilesTaskContractRecords(resolvedTarget, taskId);
              snapshot.trustedRecords = history.trustedRecords;
              snapshot.trustedRecordErrors = history.errors;
            } catch {
              // Trusted records are optional for the preflight report.
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
  // refused later over unchanged facts (C12-F1).
  let lifecycle = null;

  if (snapshot) {
    const evaluated = evaluateDispatchableLifecycle(taskStatusFromBody(snapshot.body));
    lifecycle = { status: evaluated.status, dispatchable: evaluated.ok };
    if (!evaluated.ok) {
      findings.error(
        DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
        evaluated.reason,
        dispatchableLifecycleRepair(taskId, evaluated.status),
        evaluated.evidenceState
      );
    }
  }

  // ── 2. Activation ─────────────────────────────────────────────────────
  let activationState = null;
  let activationAssurance = null;
  let effectivePolicy = null;
  let operatorAuthorization = 'unknown';
  let activationUsability = 'unknown';

  function activationDiagnosticForAuthorization(state) {
    switch (state) {
      case 'missing': return 'activation.capture.missing';
      case 'expired': return 'activation.grant.expired';
      case 'revoked': return 'activation.grant.revoked';
      case 'stale': return 'activation.binding.stale_contract';
      case 'mismatched': return 'activation.binding.mismatch';
      case 'unauthenticated': return 'activation.assurance.insufficient';
      case 'malformed': return 'activation.grant.malformed';
      default: return 'activation.capture.missing';
    }
  }

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
          } else {
            operatorAuthorization = auth.state;
            activationUsability = 'blocked';
            const code = activationDiagnosticForAuthorization(auth.state);
            const evidenceState = auth.state === 'missing' ? 'missing' : (auth.state === 'malformed' ? 'malformed' : 'negative');
            const messages = Array.isArray(auth.errors) && auth.errors.length
              ? auth.errors
              : [`task '${taskId}' activation authorization is '${auth.state}'`];
            findings.error(
              code,
              messages.join('; '),
              `npx agenticloop activate ${taskId}`,
              evidenceState
            );
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
    }
  }

  // ── 3. Decomposition source (loaded early for readiness dependency resolution) ──
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

  // ── 4. Readiness ──────────────────────────────────────────────────────
  let readinessResult = null;
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
          for (const diag of evaluated.diagnostics) {
            if (diag.level === 'error') {
              findings.error(
                diag.code,
                diag.message,
                `npx agenticloop task readiness ${taskId}`,
                diag.evidence?.state ?? 'negative'
              );
            } else if (diag.level === 'warning') {
              findings.warning(
                diag.code,
                diag.message,
                diag.evidence?.state ?? 'current'
              );
            }
          }
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

  if (snapshot) {
    const sourceRef = `.agenticloop/decompositions/${taskId}.json`;
    const fullPath = join(resolvedTarget, sourceRef);
    const head = gitText(resolvedTarget, ['rev-parse', '--verify', 'HEAD']);
    const baseTree = gitText(resolvedTarget, ['rev-parse', 'HEAD^{tree}']);
    const repairCommand = () => formatDecompositionRepairCommand({ taskId, sourceRef, baseTree, head, decompositionSource });
    if (!decompositionSource) {
      if (!existsSync(fullPath)) {
        findings.error(
          'parallel_scan.decomposition.invalid',
          `decomposition source not found: ${sourceRef}`,
          repairCommand(),
          'missing'
        );
      } else {
        findings.error(
          'parallel_scan.decomposition.invalid',
          `decomposition source is unreadable: ${sourceRef}`,
          repairCommand(),
          'malformed'
        );
      }
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

        const dispatchFindings = new FindingSet('parallel_scan.decomposition.invalid');
        validateDecomposition(decompositionSource, taskId, dispatchFindings, {
          now: Date.parse(now) || undefined,
        });

        for (const item of dispatchFindings.items) {
          findings.error(
            item.code ?? 'parallel_scan.decomposition.invalid',
            item.message,
            repairCommand(),
            item.evidenceState ?? 'negative'
          );
        }

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
          dispatchCompatible: dispatchFindings.length === 0,
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

      // Clean state
      try {
        const scopeContract = snapshot ? (taskContract ?? taskContractDigest(snapshot.body)) : null;
        const cleanState = evaluateDispatchCleanState({
          runGit: args => runGit(resolvedTarget, args),
          scopePatterns: scopeContract?.ok ? scopeContract.projection.allowed_paths ?? [] : [],
          intendedCreations: scopeContract?.ok ? scopeContract.projection.intended_creations ?? [] : [],
        });
        cleanStateClassification = cleanState.ok ? 'clean' : 'dirty';
        if (!cleanState.ok) {
          for (const finding of cleanState.findings) {
            findings.warning(
              'worktree.clean_gate.failed',
              `${finding.message}; clean state is evaluated at dispatch time; a dirty checkout may be refused by prepare-dispatch`,
              'negative'
            );
          }
        }
      } catch (error) {
        cleanStateClassification = 'unknown';
        findings.warning('cli.operational', `clean state evaluation failed: ${error.message}`, 'malformed');
      }
    }
  }

  // ── 7. Host-role capability ───────────────────────────────────────────
  let hostRoleCapability = null;
  let degradedEnforcementReports = [];

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
        } else {
          findings.warning(
            'capability.declaration.invalid',
            `host-role capability declaration is invalid: ${checked.errors.join('; ')}`,
            'malformed'
          );
        }
      }
    }
  } catch (error) {
    findings.warning('capability.resolution.failed', `host-role capability resolution failed: ${error.message}`, 'malformed');
  }

  // ── 8. Return-adapter resolution ──────────────────────────────────────
  let returnAdapterResolution = null;

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
          findings.error(
            'return.assurance.insufficient',
            `requested return adapter '${returnAdapter}' is not an eligible protected-boundary adapter with returnReceipt support; eligible: ${eligibleIds.join(', ') || '(none)'}`,
            eligibleIds.length
              ? `Use --return-adapter with one of: ${eligibleIds.join(', ')}.`
              : registerHint,
            'negative'
          );
          returnAdapterResolution = { state: 'unmatched', requested: returnAdapter, adapters: eligibleIds };
        } else {
          returnAdapterResolution = {
            state: 'resolved',
            adapter: { adapterId: chosen.adapterId, keyId: chosen.keyId },
            adapters: eligibleIds,
          };
        }
      } else if (effectivePolicy?.mode === 'hardened' && eligibleAdapters.length === 0) {
        findings.error(
          'return.assurance.insufficient',
          'hardened mode requires a protected-boundary return adapter with returnReceipt support',
          registerHint,
          'negative'
        );
        returnAdapterResolution = { state: 'missing', adapters: [] };
      } else if (effectivePolicy?.mode === 'hardened' && eligibleAdapters.length > 1) {
        findings.error(
          'return.assurance.insufficient',
          'multiple return adapters are available; select one with --return-adapter',
          `Use --return-adapter with one of: ${eligibleIds.join(', ')}.`,
          'negative'
        );
        returnAdapterResolution = { state: 'ambiguous', adapters: eligibleIds };
      } else {
        const selected = eligibleAdapters[0] ?? null;
        if (eligibleAdapters.length > 1 && effectivePolicy?.mode !== 'hardened') {
          findings.warning(
            'return.assurance.ambiguous',
            `multiple return adapters are available (${eligibleIds.join(', ')}); selected '${selected?.adapterId}'; use --return-adapter to select a specific adapter`,
            'current'
          );
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
