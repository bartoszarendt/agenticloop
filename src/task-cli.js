import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { parseFrontmatter, replaceFrontmatterField } from './frontmatter.js';
import { markdownSection } from './markdown.js';
import {
  TASK_RECORD_TEMPLATE_RELATIVE_PATH,
  resolveToolkitAssetLayout,
  resolveToolkitAssetPath,
} from './layout.js';
import {
  isValidTaskId,
  loadProjectMap,
  PROJECT_MAP_DEFAULTS,
  resolveProjectAttemptBudget,
  resolveProjectReviewBudget,
} from './project-map.js';
import { isValidTaskBackend, resolveTaskBackend, VALID_TASK_BACKENDS } from './task-backend.js';
import {
  FILES_TASK_STATUSES,
  sectionBody,
  validateFilesTaskRecord,
  validateFilesReviewControls,
  validateTaskRecord,
  validateTaskRecordDiagnostics,
} from './validate-config.js';
import { validateVerificationAttempts } from './verification-learning.js';
import { createLocalVerificationContext } from './verification-context.js';
import {
  validateReviewProvenance,
} from './review-provenance.js';
import { createIo, resolveCliTarget, CliUsageError, EXIT_USAGE } from './cli-io.js';
import {
  BaselineChangedError,
  PublicCommandError,
  STALE_CARRIER_DIGEST_CONTEXT,
  TASK_TRANSITION_NEGATIVE_CONTEXT,
  staleCarrierDigestMessage,
  VerificationContextError,
  VerificationContextMalformedError,
  VerificationContextStaleError,
  VerificationContextUnsupportedBoundaryError,
  publicErrorFromFindings,
} from './public-error.js';
import { commandFailure, printGateResult } from './public-result.js';
import { presentGateResultForTarget } from './diagnostic-presentation.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { loadAgenticLoopConfig } from './json.js';
import { buildHostRoleCapabilityInventory } from './host-role-capabilities.js';
import { resolveWorkflowRoleRegistry } from './workflow-roles.js';
import {
  createTaskReadinessEvidence,
  createTaskEvidenceContext,
  createTaskMutationReceipt,
  createCarrierMutationReceipt,
  defaultDependencyFreshnessSeconds,
  dependencyStatusMap,
  parseDependencySnapshot,
  shellQuoteArgument,
} from './task-evidence-contract.js';
import {
  COMMIT_MESSAGE_CLASSES,
  COMMIT_MESSAGE_CLASS_LIST,
  evaluateCommitAttribution,
  renderCommitMessage,
} from './commit-attribution.js';
import { evaluateTaskRecordRoot } from './task-record-root.js';
import { fileMatchesScopePattern } from './scope-matcher.js';
import { createValidationResult, validationResultDigest, VALIDATION_RESULT_KIND } from './result-envelope.js';
import { createDiagnostic } from './repair-policy.js';
import { COMMAND_REGISTRY, parseCommandArgs, suggestName } from './cli-registry.js';
import { evaluateTaskReadiness } from './task-readiness.js';
import { executeMutationBatch, resolveTargetPath } from './fs-mutation-kernel.js';
import { createTaskContractBaselineRecord, createTaskContractCorrectionRecord, taskContractDigest, trustedChainTerminal, validActivationCaptureRef, validateTaskContractBaseline } from './task-contract-baseline.js';
import { appendFilesTaskContractRecord, loadFilesTaskContractRecords } from './files-task-contract.js';
import { genericTerminalRefusalMessage, resolveCanonicalTerminalScope } from './terminal-scope.js';
import { validateTaskStatusTransition } from './task-transition.js';
import { assertLifecycleHandoffResolved } from './lifecycle-plan.js';
import {
  activationCapabilityInventory,
  activationCaptureDisposition,
  dispatchPreparationDigest,
  prepareDecompositionSource,
  prepareRoleDispatch,
  createRoleReturn,
  authoritativePacketTaskBinding,
  receiveRoleReturn,
  validateActivationCapture,
  validateDispatchPreparation,
  verifyDispatchBeforeMutation,
} from './dispatch-envelope.js';
import { createExecutionReceiptReplayAuthority, loadHostTrustStore, targetRepositoryIdentity } from './host-trust.js';
import { CommitRangeError, deriveCommitRange } from './commit-range.js';
import { gitTreeObjectId, isGitObjectId } from './git-oid.js';
import { DISPATCH_LIVENESS_WINDOW_SECONDS } from './dispatch-eligibility.js';
import { commitCarriesProductPaths, createPathClassifier, isWorkflowPath } from './product-lineage.js';
import { renderHandoffSequence } from './handoff-sequence.js';
import { GIT_MAX_BUFFER } from './git-runner.js';
import { validateCommittedSourcePath, verifyCommittedAttributedSource } from './committed-source.js';
import {
  createTaskInventoryEnumeration,
  normalizeFilesTaskInventory,
  normalizeGitHubTaskInventory,
} from './parallel-scan.js';
import { resolveGhRunner } from './closeout-github.js';
import { resolveGitHubRepository, runGhJson } from './gh-helpers.js';
import {
  loadTaskActivationEvidence,
  resolveActivationVerification,
  resolveEffectiveActivationPolicy,
  resolvePacketActivationBinding,
  unactivatedTaskError,
} from './activation-resolution.js';
import { buildGitHubTaskIdentityInventory, resolveCoveredGitHubTask } from './github-task-identity.js';
import { fetchGitHubTaskBody } from './github-task-body.js';
import {
  evaluateHandoffPreflight,
} from './handoff-preflight.js';
import {
  applyHandoffEvidenceRefresh,
  createHandoffEvidenceRefreshPlan,
  validateHandoffRefreshPlan,
} from './handoff-evidence-refresh.js';
import {
  createFindingResolutionMatrix,
  detectFixupEpisodes,
  metadataOnlyReviewDecision,
  validateFindingResolutionMatrix,
  validateFixupEpisode,
} from './maintainer-fixup.js';
import { parseFilesReviewHistory } from './review-history.js';
import {
  createAuthenticatedReturnVerification,
  createReturnVerification,
  CURRENT_REQUIRED_CHECK_EVIDENCE_ASSURANCE,
  listReturnVerifications,
  writeReturnVerification,
} from './return-verification.js';
import {
  recognizeLifecycleReturn,
  recognizeRoleStart,
} from './handoff-binding.js';
import { createPreparedDispatchValidation } from './handoff-recognition.js';
import { refetchGitHubReturnEvidence } from './github-return-evidence.js';
import { refetchFilesReturnEvidence } from './files-return-evidence.js';
import {
  createDispatchConsumption,
  carrierMutationRelativePath,
  dispatchConsumptionRelativePath,
  listDispatchConsumptions,
  resolveCarrierLineage,
} from './handoff-consumption.js';
import { measureTaskWorkflow } from './workflow-measurement.js';
import { buildReadinessPlan } from './readiness-plan.js';
import { applyReadinessPlan } from './readiness-apply.js';
import {
  evaluateCurrentTaskCarrier,
  prepareAgentReadyEvidence,
  prepareTaskStatusCandidate,
  prepareTrustedBaselineCandidate,
  taskRecordDigest,
} from './readiness-candidates.js';
import {
  HISTORICAL_MISSING_EVIDENCE_CLASSES,
  createHistoricalAdoption,
  historicalAdoptionRelativePath,
  projectHistoricalAdoption,
} from './historical-adoption.js';
import {
  EXECUTION_ATTEMPT_ABANDONMENT_KIND,
  EXECUTION_ATTEMPT_ABANDONMENT_SCHEMA_VERSION,
  PACKET_CONSERVATION_DIAGNOSTIC_CODE,
  evaluateTaskPacketConservation,
  executionAttemptAbandonmentRelativePath,
  validateExecutionAttemptAbandonment,
} from './execution-attempt.js';
import { createDegradedEnforcementReports } from './host-role-capabilities.js';
import { REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION, validateRequiredCheckEvidence, requiredCheckEvidenceMatchesInventory } from './required-checks.js';
import { produceExecutionEvidence, parseRequiredCheckCommand, validateExecutionEvidence } from './execution-evidence.js';
import { CANCELLATION_PROVENANCE_KIND, validateAuthoritativeCancellationProvenance } from './cancellation-provenance.js';
import { isAbsoluteOrDriveQualifiedPath, isPathWithin, pathIdentity, samePathAuthority } from './path-identity.js';
import { runRequiredCheckCommand } from './cross-platform-runner.js';

function frontmatterString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function implementationArtifactHead(content) {
  const [frontmatter] = parseFrontmatter(content);
  const value = frontmatterString(frontmatter?.implementation_artifact);
  const commit = value.match(/^commit:([0-9a-f]{40}|[0-9a-f]{64})$/);
  if (commit) return commit[1];
  const range = value.match(/^range:[0-9a-f]{40,64}\.\.([0-9a-f]{40}|[0-9a-f]{64})$/);
  return range?.[1] ?? null;
}

/**
 * Refuse an implementation-artifact product head that current Git does not
 * support, or return `null` when it does.
 *
 * Three conditions, each of which the field run violated or was forced to
 * violate:
 *
 *   1. the head is a real commit reachable from the current HEAD,
 *   2. no product path changed between it and HEAD - so it really is the
 *      product head and not merely some earlier commit,
 *   3. it introduces product work at all - so `implementation_artifact` can
 *      never name a role-start or receipt commit.
 */
function evaluateProductHeadEvidence(runGit, productHead, classifier) {
  const refusal = (message, code = 'task.evidence.product_head') => new PublicCommandError(message, {
    code, evidenceState: 'changed', disposition: 'blocked',
    safeRepair:
      'Pass the exact commit that introduced this task\'s product work; it must be reachable from HEAD ' +
      'and no product path may have changed after it.',
  });
  if (!isGitObjectId(productHead)) {
    return refusal('implementation artifact evidence requires --product-head as a full lowercase 40- or 64-character Git identity');
  }
  const observedHead = String(runGit(['rev-parse', '--verify', 'HEAD']).stdout ?? '').trim();
  if (!isGitObjectId(observedHead)) {
    return refusal('implementation artifact evidence requires a readable current repository HEAD');
  }
  if (productHead !== observedHead) {
    if (runGit(['merge-base', '--is-ancestor', productHead, observedHead]).status !== 0) {
      return refusal(
        'implementation artifact evidence requires --product-head to be the current repository HEAD or an ancestor of it'
      );
    }
    const later = String(runGit(['diff', '--name-only', '--no-renames', `${productHead}..${observedHead}`]).stdout ?? '')
      .split(/\r?\n/).filter(Boolean);
    const productPaths = later.filter(path => !isWorkflowPath(path, classifier));
    if (productPaths.length > 0) {
      return refusal(
        'implementation artifact evidence requires --product-head to be the last commit carrying product work; ' +
        `product path(s) changed after it: ${[...new Set(productPaths)].sort().slice(0, 5).join(', ')}`
      );
    }
  }
  const carries = commitCarriesProductPaths(runGit, productHead, classifier);
  if (!carries.ok) return refusal(`implementation artifact evidence could not read the product head: ${carries.reason}`);
  if (!carries.carries) {
    return refusal(
      'implementation artifact evidence requires a --product-head commit that introduces at least one non-workflow path; ' +
      'a workflow-only commit is not an implementation artifact'
    );
  }
  return null;
}

function taskLintCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf-8', ...options });
}

const REQUIRED_CHECK_TIMEOUT_MS = 300_000;

/** Execute the task-authorized argv through the cross-platform runner. */
function requiredCheckCommandRunner({ command, args, cwd }) {
  return runRequiredCheckCommand({ command, args, cwd });
}

/**
 * Re-run the canonical prepare-dispatch consumer against live target state.
 *
 * Role-start callers use this immediately before mutation. Reusing the public
 * command path keeps task, readiness, repository, decomposition, inventory,
 * activation, and operator-policy refetches identical to `task
 * prepare-dispatch --packet`; a static packet validation is not a freshness
 * check.
 */
export async function verifyCurrentDispatchPacket({
  target,
  io,
  taskId,
  packetPath,
  roleId = 'engineer',
  hostTrustStore = undefined,
  repo = undefined,
}) {
  const stdout = [];
  const stderr = [];
  const captureIo = {
    ...io,
    out: (...args) => stdout.push(args.join(' ')),
    err: (...args) => stderr.push(args.join(' ')),
    warn: (...args) => stderr.push(args.join(' ')),
  };
  const args = [
    'prepare-dispatch', String(taskId),
    '--packet', String(packetPath),
    '--target', String(target),
    '--role', String(roleId),
    '--json',
  ];
  try {
    const packet = JSON.parse(readFileSync(resolve(target, String(packetPath)), 'utf8'));
    if (packet?.returnAdapter?.adapterId) {
      args.push('--return-adapter', String(packet.returnAdapter.adapterId));
    }
  } catch {
    // The canonical command below owns the typed unreadable/malformed result.
  }
  if (hostTrustStore) args.push('--host-trust-store', String(hostTrustStore));
  if (repo) args.push('--repo', String(repo));
  let exactPacket = null;
  try {
    exactPacket = JSON.parse(readFileSync(resolve(target, String(packetPath)), 'utf8'));
  } catch {
    // The canonical command below owns the public malformed-packet diagnostic.
  }
  try {
    const status = await cmdTask(args, captureIo);
    if (status === 0) return createPreparedDispatchValidation(exactPacket, { ok: true, errors: [] });
    let parsed = null;
    try {
      parsed = JSON.parse(stdout.join('\n'));
    } catch {
      // Human diagnostics remain a valid fallback if an older projection did
      // not emit a structured result.
    }
    const errors = Array.isArray(parsed?.errors) && parsed.errors.length > 0
      ? parsed.errors.map(String)
      : stderr.length > 0 ? stderr : ['dispatch packet is not current for this role start'];
    return createPreparedDispatchValidation(exactPacket, { ok: false, errors });
  } catch (error) {
    return createPreparedDispatchValidation(exactPacket, {
      ok: false, errors: [`dispatch packet freshness check failed: ${error.message}`],
    });
  }
}

function resolveProject(target) {
  const projectMap = loadProjectMap(target);
  return {
    raw: projectMap?.raw ?? {},
    config: {
      ...(projectMap?.config ?? PROJECT_MAP_DEFAULTS),
      verificationFacts: projectMap?.verificationFacts ?? [],
    },
  };
}

/**
 * Backends each `task` subcommand can act under.
 *
 * The configured backend chooses the enumerator, the carrier, and the write
 * transport, so it is resolved and checked against this matrix once, before any
 * subcommand-specific routing. Previously only `prepare-decomposition` and
 * `prepare-dispatch` validated it; every other subcommand fell through a
 * files-only guard that emitted untyped stderr text, ignored `--json`, and gave
 * an unrecognized backend a different diagnostic than the preparation commands
 * gave for the identical misconfiguration.
 *
 * A subcommand absent from this map has no defined backend support and is
 * refused rather than defaulted, so adding a subcommand cannot silently
 * inherit files authority.
 */
const TASK_SUBCOMMAND_BACKENDS = Object.freeze({
  list: Object.freeze(['files']),
  lint: Object.freeze(['files']),
  new: Object.freeze(['files']),
  'establish-baseline': Object.freeze(['files']),
  'abandon-attempt': Object.freeze(['files']),
  'adopt-historical': Object.freeze(['files']),
  measure: Object.freeze(['files']),
  'readiness-plan': Object.freeze(['files']),
  // Readiness apply is a single-transaction Maintainer mutation. It is declared
  // files-only because no equivalent transactional carrier exists on GitHub;
  // an invocation there returns the standard typed unsupported-backend result
  // rather than a partial cross-carrier orchestration.
  'readiness-apply': Object.freeze(['files']),
  'attempt-status': Object.freeze(['files']),
  // A commit message is Git-carrier work, not task-carrier work: both backends
  // require the same canonical Task/Agent trailer block on the commits they
  // attribute, so both get the same producer.
  'commit-message': Object.freeze(['files', 'github']),
  'authorize-correction': Object.freeze(['files']),
  'prepare-decomposition': Object.freeze(['files', 'github']),
  'prepare-dispatch': Object.freeze(['files', 'github']),
  'handoff-preflight': Object.freeze(['files', 'github']),
  'refresh-handoff-evidence': Object.freeze(['files']),
  'prepare-return': Object.freeze(['files']),
  'verify-return': Object.freeze(['files', 'github']),
  'check-evidence-init': Object.freeze(['files', 'github']),
  'check-evidence-show': Object.freeze(['files', 'github']),
  'check-evidence-update': Object.freeze(['files', 'github']),
  evidence: Object.freeze(['files']),
  'review-prepare': Object.freeze(['files']),
  status: Object.freeze(['files']),
});

/** Backends one `task` subcommand supports, or an empty list when undeclared. */
export function taskSubcommandBackends(sub) {
  return TASK_SUBCOMMAND_BACKENDS[sub] ?? Object.freeze([]);
}

/**
 * Resolve and validate the configured task backend for one subcommand.
 *
 * Returns either the accepted resolution or a typed refusal. Both refusals are
 * validation results rather than free stderr text, so `--json` behaves the same
 * for every subcommand and a caller can distinguish an unusable configuration
 * from an unsupported-but-valid combination.
 */
function guardTaskBackend(sub, target, opts, io) {
  const resolution = resolveTaskBackend(target);
  const supported = taskSubcommandBackends(sub);
  const asJson = Boolean(opts.json);
  const command = `task ${sub}`;

  // An unrecognized value cannot be allowed to fall through to whichever branch
  // happens to be the `else`: that silently answers a question about one
  // backend using another's authority. This is the root diagnostic; no task
  // inventory has been read and no backend transport has been contacted.
  if (!isValidTaskBackend(resolution.backend)) {
    for (const warning of resolution.warnings) io.warn(`  WARN: ${warning}`);
    return {
      ok: false,
      exit: printGateResult(
        command,
        commandFailure(command, new VerificationContextMalformedError(
          `Configured task backend '${String(resolution.backend)}' from ${resolution.source} is not supported; ` +
          `supported backends: ${[...VALID_TASK_BACKENDS].join(', ')}`,
          {
            safeRepair: `Set task_backend to one of ${[...VALID_TASK_BACKENDS].join(' or ')} in the project map, then rerun. ` +
              'No task inventory was enumerated and no backend transport was contacted.',
            requiredContext: ['a project map declaring a supported task_backend'],
          }
        ), 'operational_error', {}, target),
        asJson,
        io
      ),
    };
  }

  // A valid backend this subcommand cannot act under is a usage problem, not a
  // configuration problem, and it is never resolved by quietly selecting the
  // other backend.
  if (!supported.includes(resolution.backend)) {
    for (const warning of resolution.warnings) io.warn(`  WARN: ${warning}`);
    const alternatives = supported.length > 0
      ? `'agenticloop ${command}' supports the ${supported.map(name => `${name}`).join(' and ')} backend${supported.length > 1 ? 's' : ''} only`
      : `'agenticloop ${command}' declares no supported task backend`;
    return {
      ok: false,
      exit: printGateResult(
        command,
        commandFailure(command, new CliUsageError(
          `Active task backend is '${resolution.backend}' (from ${resolution.source}); ${alternatives}.`,
          {
            hint: supported.includes('files')
              ? "Set task_backend: files in the project map to use this subcommand, or use the GitHub task surface ('agenticloop task-body') for task operations in this project."
              : `Set task_backend to ${supported.join(' or ')} in the project map, then rerun.`,
          }
        ), 'usage', {}, target),
        asJson,
        io,
        EXIT_USAGE
      ),
    };
  }

  // `--repo` names a GitHub repository. On the files backend it can never be
  // honored, so it is refused rather than accepted and quietly discarded.
  if (resolution.backend === 'files' && opts.repo !== undefined) {
    for (const warning of resolution.warnings) io.warn(`  WARN: ${warning}`);
    return {
      ok: false,
      exit: printGateResult(
        command,
        commandFailure(command, new CliUsageError(
          `--repo names a GitHub repository and the configured task backend is 'files'; remove --repo or configure task_backend: github`
        ), 'usage', {}, target),
        asJson,
        io,
        EXIT_USAGE
      ),
    };
  }

  for (const warning of resolution.warnings) io.warn(`  WARN: ${warning}`);
  return { ok: true, resolution };
}

function normalizeTemplatePath(template) {
  return String(template ?? PROJECT_MAP_DEFAULTS.task_file_template).replace(/\\/g, '/');
}

function taskPathForId(target, projectConfig, taskId) {
  const relPath = normalizeTemplatePath(projectConfig.task_file_template)
    .replaceAll('{taskId}', taskId);
  const fullPath = resolve(target, relPath);
  const root = resolve(target);
  if (fullPath !== root && !fullPath.startsWith(`${root}\\`) && !fullPath.startsWith(`${root}/`)) {
    throw new VerificationContextMalformedError(`task_file_template resolves outside target: ${projectConfig.task_file_template}`);
  }
  return fullPath;
}

function taskDirectory(target, projectConfig) {
  return dirname(taskPathForId(target, projectConfig, '__TASK_ID__'));
}

function taskFiles(target, projectConfig) {
  const dir = taskDirectory(target, projectConfig);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(entry => entry.endsWith('.md'))
    .map(entry => join(dir, entry))
    .filter(file => statSync(file).isFile())
    .sort();
}

function readTaskRecord(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const [frontmatter] = parseFrontmatter(content);
  return { content, frontmatter: frontmatter ?? {} };
}

function taskRecordFromFile(filePath) {
  const { content, frontmatter } = readTaskRecord(filePath);
  return {
    file: filePath,
    content,
    task_id: frontmatterString(frontmatter.task_id),
    status: frontmatterString(frontmatter.status),
    review_status: frontmatterString(frontmatter.review_status),
    review_mode: frontmatterString(frontmatter.review_mode),
    implementation_artifact: frontmatterString(frontmatter.implementation_artifact),
    reviewed_artifact: frontmatterString(frontmatter.reviewed_artifact),
  };
}

function formatTable(rows) {
  const headers = ['task_id', 'status', 'review_status', 'review_mode', 'implementation_artifact'];
  const widths = Object.fromEntries(headers.map(header => [header, header.length]));
  for (const row of rows) {
    for (const header of headers) {
      widths[header] = Math.max(widths[header], String(row[header] ?? '').length);
    }
  }
  const line = headers.map(header => header.padEnd(widths[header])).join('  ');
  const sep = headers.map(header => '-'.repeat(widths[header])).join('  ');
  const body = rows.map(row => headers.map(header => String(row[header] ?? '').padEnd(widths[header])).join('  '));
  return [line, sep, ...body].join('\n');
}

function lintTaskFile(filePath, target, projectConfig, verificationContext) {
  const content = readFileSync(filePath, 'utf-8');
  const filename = relative(target, filePath).replace(/\\/g, '/');
  const warnings = [];
  const diagnostics = validateTaskRecordDiagnostics(content, filename);
  if (diagnostics.length > 0) {
    return {
      file: filename,
      digest: taskRecordDigest(content),
      errors: diagnostics.map(item => item.message),
      warnings,
      diagnostics,
    };
  }
  const errors = [
    ...validateTaskRecord(content, filename),
    ...validateFilesTaskRecord(content, filename, {
      activeTaskBackend: 'files',
      projectMapConfig: projectConfig,
      projectVerificationFacts: verificationContext.projectFacts,
      decisionExists: verificationContext.decisionExists,
      taskExists: verificationContext.taskExists,
      repoRoot: target,
      commandRunner: taskLintCommandRunner,
      warnings,
    }),
  ];
  const frontmatter = parseFrontmatter(content)[0] ?? {};
  // A durable data-integrity check, not a transient refusal: while the product
  // head was pinned to HEAD, `implementation_artifact` was routinely rebound to
  // a role-start workflow commit, and every later audit, closeout, or
  // historical adoption that trusted the field bound the wrong object. Lint
  // reads the named commit and refuses one that introduces no product work.
  const artifactHead = implementationArtifactHead(content);
  if (artifactHead) {
    const carries = commitCarriesProductPaths(targetGitRunner(target), artifactHead, createPathClassifier(target));
    if (carries.ok && !carries.carries) {
      errors.push(
        `implementation_artifact commit ${artifactHead} introduces no non-workflow path; ` +
        'it names workflow state rather than the implementation'
      );
    }
  }
  const status = frontmatterString(frontmatter.status);
  if (status && status !== 'draft') {
    const history = loadFilesTaskContractRecords(target, frontmatterString(frontmatter.task_id));
    const baseline = validateTaskContractBaseline(content, {
      lifecycle: Number(frontmatter.task_contract_schema) >= 2 ? 'new' : 'legacy',
      trustedRecords: history.trustedRecords,
      trustedRecordErrors: history.errors,
    });
    errors.push(...baseline.errors);
    warnings.push(...baseline.warnings);
  }
  return { file: filename, digest: taskRecordDigest(content), errors, warnings, diagnostics };
}

/** Derive execution binding only from the authentic packet and current target facts. */
function executionEvidenceBinding(target, projectConfig, taskId, packet, current = {}) {
  const body = current.body ?? readFileSync(taskPathForId(target, projectConfig, taskId), 'utf8');
  const contractDigest = current.contractDigest ?? taskContractDigest(body).digest;
  const currentCarrierDigest = current.currentCarrierDigest ?? taskRecordDigest(body);
  const repositoryHead = String(targetGitRunner(target)(['rev-parse', '--verify', 'HEAD']).stdout ?? '').trim();
  // GitHub task carriers do not own the files-only implementation_artifact
  // field. Their public execution route binds the current repository head,
  // which the authenticated return receipt later rechecks as its product head.
  const productHead = current.productHead ?? implementationArtifactHead(body) ??
    (packet?.backend === 'github' ? repositoryHead : null);
  if (!contractDigest || !currentCarrierDigest || !isGitObjectId(repositoryHead) || !isGitObjectId(productHead)) {
    throw new VerificationContextMalformedError('execution evidence requires current task contract, carrier, repository, and product Git identities');
  }
  return {
    packetId: packet.packetId,
    packetDigest: packet.digest,
    invocationId: packet.assignment.invocationId,
    taskId,
    taskContractDigest: contractDigest,
    currentCarrierDigest,
    repositoryHead,
    productHead,
  };
}

/**
 * Revalidate a dispatch packet after role start without replaying the
 * role-start repository-head check. Check evidence is only legal for the exact
 * consumed packet generation, current task contract, and continuous carrier
 * lineage; a self-consistent packet digest is never authority to execute.
 */
function validateConsumedCheckEvidencePacket(target, projectConfig, taskId, packet, io, hostTrustStore) {
  const activationPolicy = resolveEffectiveActivationPolicy(target, io);
  const hostRoleCapabilities = resolveEffectiveHostRoleCapabilities(target);
  let consumedLegacyCapture = false;
  try {
    const capabilities = resolveActivationCapabilities(target, io, hostTrustStore);
    const activationVerification = resolveActivationVerification(target, io, {
      hostTrustStorePath: hostTrustStore,
    });
    const dispatch = validateDispatchPreparation(packet, {
      capabilities,
      hostRoleCapabilities,
      assurancePolicy: { mode: activationPolicy.mode, policySource: activationPolicy.source },
      verifyActivationSignature: activationVerification.verify,
      resolveActivationBinding: candidate => resolvePacketActivationBinding(target, io, candidate, {
        hostTrustStorePath: hostTrustStore,
      }),
    });
    if (!dispatch.ok) {
      throw new VerificationContextMalformedError(
        `dispatch packet is not authentic for check evidence: ${dispatch.errors.join('; ')}`
      );
    }
  } catch (error) {
    // A standard-policy legacy capture has already passed canonical packet and
    // signature validation at role start before its immutable consumption
    // record was created.  The public check-evidence commands run after that
    // boundary; they may reuse this exact consumed packet without requiring a
    // second live host challenge. Hardened packets, grants, and every other
    // validation error remain fail-closed here.
    if (!(error instanceof VerificationContextUnsupportedBoundaryError) ||
        activationPolicy.mode !== 'standard' ||
        packet?.assurance?.activationSource !== 'legacy_task_capture') {
      throw error;
    }
    consumedLegacyCapture = true;
  }
  const backend = resolveTaskBackend(target).backend;
  if (packet.backend !== backend || packet.task?.id !== taskId ||
      packet.assignment?.roleId !== 'engineer' ||
      packet.assurance?.mode !== activationPolicy.mode ||
      packet.assurance?.minimumActivation !== activationPolicy.minimumActivation ||
      packet.assurance?.minimumReturn !== activationPolicy.minimumReturn ||
      !samePathAuthority(packet.repository?.worktree, target) ||
      !samePathAuthority(packet.assignment?.worktree, target) ||
      targetRepositoryIdentity(packet.repository?.worktree) !== targetRepositoryIdentity(target)) {
    throw new VerificationContextMalformedError(
      'dispatch packet does not bind the selected target, current policy, and Engineer role'
    );
  }

  let snapshot;
  if (backend === 'github') {
    const inventory = enumerateGitHubTaskInventory(projectConfig, io);
    const resolvedTask = resolveCoveredGitHubTask(inventory.identityInventory, taskId);
    if (!resolvedTask.found) throw new VerificationContextMalformedError(resolvedTask.error);
    const fetched = fetchGitHubTaskBody({
      issue: resolvedTask.issue.number,
      repo: inventory.repo,
      commandRunner: resolveGhRunner(io),
      projectMapConfig: projectConfig,
    });
    snapshot = {
      backend, taskId, carrier: `issue:${resolvedTask.issue.number}`,
      body: fetched.body, digest: fetched.digest,
      trustedRecords: fetched.trustedRecords, trustedRecordErrors: fetched.trustedRecordErrors,
    };
  } else {
    const filePath = taskPathForId(target, projectConfig, taskId);
    if (!existsSync(filePath)) {
      throw new VerificationContextMalformedError(`task record not found: ${relative(target, filePath).replace(/\\/g, '/')}`);
    }
    const body = readFileSync(filePath, 'utf8');
    snapshot = {
      backend, taskId, carrier: relative(target, filePath).replace(/\\/g, '/'), body,
      digest: taskRecordDigest(body),
    };
  }
  const { body, digest: currentCarrierDigest } = snapshot;
  const authoritative = authoritativePacketTaskBinding(snapshot);
  if (!authoritative.ok) {
    throw new VerificationContextMalformedError(
      `current task contract cannot authorize check evidence: ${authoritative.error}`
    );
  }
  const { dispatchCarrierDigest: _packetCarrierDigest, ...packetContract } = packet.task;
  const { dispatchCarrierDigest: _currentCarrierDigest, ...currentContract } = authoritative.binding.task;
  if (canonicalJson(packetContract) !== canonicalJson(currentContract)) {
    throw new VerificationContextStaleError(
      'dispatch packet required-check inventory or task contract does not equal the current authoritative task contract'
    );
  }
  const lineage = resolveCarrierLineage(target, taskId, {
    backend, taskContractDigest: authoritative.contract.digest, currentCarrierDigest,
  });
  const expectedWorkUnitIdentity = packet.decomposition?.workUnitId ??
    packet.decomposition?.scan?.workUnit?.id ?? packet.decomposition?.workUnit?.id ?? null;
  if (!lineage.ok ||
      lineage.dispatchConsumption.packetId !== packet.packetId ||
      lineage.dispatchConsumption.packetDigest !== packet.digest ||
      lineage.dispatchConsumption.invocationId !== packet.assignment.invocationId ||
      lineage.dispatchConsumption.workflowRole !== packet.assignment.roleId ||
      lineage.dispatchConsumption.taskContractDigest !== authoritative.contract.digest ||
      lineage.dispatchConsumption.dispatchCarrierDigest !== packet.task.dispatchCarrierDigest ||
      lineage.dispatchConsumption.repositoryIdentity !== targetRepositoryIdentity(target) ||
      !samePathAuthority(lineage.dispatchConsumption.worktreeRoot, target) ||
      lineage.dispatchConsumption.workUnitIdentity !== expectedWorkUnitIdentity ||
      lineage.dispatchCarrierDigest !== packet.task.dispatchCarrierDigest ||
      lineage.currentCarrierDigest !== currentCarrierDigest) {
    throw new VerificationContextStaleError(
      `current dispatch consumption and carrier lineage do not bind the exact packet invocation: ${lineage.errors?.join('; ') || 'identity mismatch'}`
    );
  }
  if (consumedLegacyCapture &&
      (packet.digest !== dispatchPreparationDigest(packet) ||
       packet.assurance?.activation !== 'host_signed' ||
       lineage.dispatchConsumption.assuranceGrade !== 'host_signed')) {
    throw new VerificationContextMalformedError(
      'consumed legacy activation packet is not canonical and host-signed for standard check evidence'
    );
  }
  return {
    packet,
    body,
    contractDigest: authoritative.contract.digest,
    currentCarrierDigest,
    lineage,
  };
}

function checkEvidencePaths(target, packetPath, inputPath = null, outputPath = null, executionOutputPath = null) {
  const packet = publicTargetRelativePath(target, packetPath, 'dispatch packet');
  const input = inputPath === null ? null : publicTargetRelativePath(target, inputPath, 'check evidence input');
  const output = outputPath === null ? null : validateCheckEvidenceWritePath(
    target,
    publicTargetRelativePath(target, outputPath, 'check evidence output'),
    'check evidence output',
  );
  const execution = executionOutputPath === null ? null : validateCheckEvidenceWritePath(
    target,
    publicTargetRelativePath(target, executionOutputPath, 'execution output'),
    'execution output',
  );
  if ([input, output, execution].filter(Boolean).some(candidate => samePathAuthority(packet.path, candidate.path))) {
    throw new VerificationContextMalformedError('dispatch packet path must not alias a check-evidence or execution artifact path');
  }
  if (execution !== null && output !== null && samePathAuthority(execution.path, output.path)) {
    throw new VerificationContextMalformedError('execution output path must not alias the check-evidence output path');
  }
  return { packet, input, output, execution };
}

/**
 * Validate a future public write through the mutation kernel's path resolver
 * before a required command may run.  The kernel repeats this validation at
 * commit time; this early pass makes unsafe destinations fail before command
 * execution while retaining the batch's atomic write semantics.
 */
function validateCheckEvidenceWritePath(target, destination, label) {
  try {
    const path = resolveTargetPath(target, destination.relPath);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) {
      throw new VerificationContextMalformedError(`destination must be absent or an existing regular file: ${destination.relPath}`);
    }
    return { ...destination, path };
  } catch (error) {
    throw new VerificationContextMalformedError(
      `${label} is not a safe target-confined write destination: ${error.message}`
    );
  }
}

function writeCheckEvidenceUpdate(target, execution, executionPath, checks, checksPath) {
  const actions = [];
  if (execution !== null) {
    actions.push({ type: 'write', path: executionPath.relPath, content: `${JSON.stringify(execution, null, 2)}\n` });
  }
  actions.push({ type: 'write', path: checksPath.relPath, content: `${JSON.stringify(checks, null, 2)}\n` });
  const applied = executeMutationBatch(target, actions);
  if (!applied.ok) {
    throw new VerificationContextMalformedError(
      `check evidence could not be written atomically: ${[...applied.errors, ...applied.rollbackErrors].join('; ')}`
    );
  }
}

function publicTargetRelativePath(target, value, label) {
  if (typeof value !== 'string' || !value.trim() || isAbsoluteOrDriveQualifiedPath(value)) {
    throw new VerificationContextMalformedError(`${label} must be a non-empty target-relative path`);
  }
  const path = resolve(target, String(value));
  const relPath = relative(target, path).replace(/\\/g, '/');
  if (!relPath || relPath === '..' || relPath.startsWith('../')) {
    throw new VerificationContextMalformedError(`${label} must resolve inside the selected target`);
  }
  return { path, relPath };
}

/** Read exactly one target-confined regular file without following leaf links. */
function readTargetText(target, relPath, label) {
  const { path } = publicTargetRelativePath(target, relPath, label);
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || !isPathWithin(path, target)) {
      throw new VerificationContextMalformedError(`${label} must be a target-confined regular file`);
    }
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof VerificationContextMalformedError) throw error;
    throw new VerificationContextMalformedError(`${label} is unreadable: ${error.message}`);
  }
}

/** Read exactly one JSON value from a target-relative regular file. */
function readTargetJson(target, relPath, label) {
  try {
    return JSON.parse(readTargetText(target, relPath, label));
  } catch (error) {
    if (error instanceof VerificationContextMalformedError) throw error;
    throw new VerificationContextMalformedError(`${label} is unreadable or invalid JSON: ${error.message}`);
  }
}

/** Atomically persist a public JSON artifact below the selected target. */
function writeTargetJson(target, relPath, value) {
  const destination = publicTargetRelativePath(target, relPath, 'output path');
  const applied = executeMutationBatch(target, [{
    type: 'write', path: destination.relPath, content: `${JSON.stringify(value, null, 2)}\n`,
  }]);
  if (!applied.ok) {
    throw new VerificationContextMalformedError(`output could not be written atomically: ${[...applied.errors, ...applied.rollbackErrors].join('; ')}`);
  }
  return destination.path;
}

/**
 * Classify one cancellation-evidence failure. A structurally broken record is
 * malformed; a well-formed record that is not a usable Agentic Loop-controlled
 * observation (absent, ambiguous, or for another request/invocation) leaves
 * the cancellation outcome unknown and needs context.
 */
function cancellationEvidenceError(errors, prefix) {
  const structural = errors.some(error =>
    /fields must equal|identity is invalid|digest is invalid/.test(error));
  const message = `${prefix}: ${errors.join('; ')}`;
  return structural
    ? new VerificationContextMalformedError(message)
    : new VerificationContextError(message, {
        requiredContext: ['an Agentic Loop-controlled cancellation observation bound to the exact consumed invocation'],
      });
}

/**
 * Receiving-boundary execution-evidence enforcement for files-backend returns.
 *
 * The packet's authenticated requiredCheckEvidenceContract selects this grammar.
 * Field absence is never a compatibility selector.
 */
function enforceReturnedCommandCheckEvidence(target, wireReturn, packet, verifiedEvidence, taskId) {
  const checks = wireReturn?.checks;
  if (packet?.task?.requiredCheckEvidenceContract !== REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION) {
    throw new VerificationContextMalformedError('dispatch packet does not select the current required-check evidence contract');
  }
  const checked = validateRequiredCheckEvidence(checks, {
    label: 'role return', contractVersion: REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION,
  });
  if (!checked.ok) {
    throw new VerificationContextMalformedError(`role return does not satisfy the authenticated required-check evidence contract: ${checked.errors.join('; ')}`);
  }
  for (const check of checks) {
    if (check?.kind === 'command' && check.outcome !== 'passed' && check.executionEvidence != null) {
      throw new VerificationContextMalformedError(
        `command check '${check.id}' with outcome '${check.outcome}' must not carry an execution artifact reference`
      );
    }
  }
  validatePreparedCommandCheckExecutions(target, checks, packet.task.requiredChecks, {
    packetId: packet.packetId,
    packetDigest: packet.digest,
    invocationId: packet.assignment.invocationId,
    taskId,
    taskContractDigest: wireReturn.task.taskContractDigest,
    currentCarrierDigest: wireReturn.task.currentCarrierDigest,
    repositoryHead: verifiedEvidence.workflowHead,
    productHead: wireReturn.productHead,
  });
}

/**
 * A passed command observation is only usable when it binds the exact
 * target-confined execution record emitted by check-evidence-update. The
 * surrounding check JSON is editable, so its exit-code and prose are never
 * accepted as a substitute for the closed execution record.
 */
function validatePreparedCommandCheckExecutions(target, checks, inventory, expectedBinding) {
  const targetAuthority = pathIdentity(target).authorityPath;
  const scratchAuthority = pathIdentity(join(target, '.agenticloop', 'tmp')).authorityPath;
  for (const required of inventory) {
    if (required.kind !== 'command') continue;
    const check = checks.find(candidate => candidate?.id === required.id);
    if (check?.outcome !== 'passed') continue;
    const reference = check.executionEvidence;
    if (!reference || typeof reference !== 'object' || Array.isArray(reference) ||
        Object.keys(reference).length !== 2 || typeof reference.path !== 'string' || !reference.path.trim() ||
         !/^sha256:agenticloop\.execution-evidence\.v3:[a-f0-9]{64}$/.test(String(reference.digest ?? ''))) {
      throw new VerificationContextMalformedError(
        `passed command check '${required.id}' requires a closed CLI execution artifact path and digest (executionEvidence)`
      );
    }
    const artifactPath = publicTargetRelativePath(target, reference?.path, `passed command check '${required.id}' execution artifact`);
    const execution = readTargetJson(target, artifactPath.relPath, `passed command check '${required.id}' execution artifact`);
    const checked = validateExecutionEvidence(execution, { expectedBinding });
    if (!checked.ok) {
      throw new VerificationContextMalformedError(
        `passed command check '${required.id}' execution artifact is invalid: ${checked.errors.join('; ')}`
      );
    }
    let parsed;
    try {
      parsed = parseRequiredCheckCommand(required.command);
    } catch (error) {
      throw new VerificationContextMalformedError(
        `required command check '${required.id}' is not safe inert argv: ${error.message}`
      );
    }
    if (reference.digest !== execution.digest ||
        execution.check.id !== required.id ||
        execution.check.instruction !== required.command ||
        execution.check.command !== parsed.command ||
        JSON.stringify(execution.check.args) !== JSON.stringify(parsed.args) ||
        execution.execution.outcome !== 'passed' || execution.execution.childExitCode !== 0 ||
        !['carrierRoot', 'artifactWorktreeRoot', 'workingDirectory'].every(field =>
          samePathAuthority(execution.locations[field].authorityPath, targetAuthority)) ||
         !samePathAuthority(execution.locations.projectScratchRoot.authorityPath, scratchAuthority)) {
      throw new VerificationContextMalformedError(
        `passed command check '${required.id}' does not bind exact target CLI execution evidence`
      );
    }
  }
}

function artifactSuccess({ taskId, outputPath, artifact, assuranceGrade }) {
  return {
    ok: true,
    task_id: taskId,
    outputPath,
    artifactKind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    semanticDigest: artifact.digest,
    assuranceGrade,
  };
}

function checkEvidenceSuccess({ taskId, outputPath, checks, assuranceGrade }) {
  return {
    ok: true,
    task_id: taskId,
    outputPath,
    artifactKind: 'agenticloop.required-check-evidence',
    schemaVersion: 1,
    semanticDigest: `sha256:agenticloop.required-check-evidence.v1:${canonicalSha256(checks)}`,
    assuranceGrade,
  };
}

function dispatchAssignmentFromCurrentFacts({ taskId, host, repository, backend, hostRoleCapabilities }) {
  const declaration = hostRoleCapabilities?.[host]?.engineer;
  if (!declaration) {
    throw new VerificationContextMalformedError(
      `no canonical effective host-role capability declaration exists for '${String(host)}/engineer'`
    );
  }
  return {
    roleId: 'engineer',
    host,
    hostRoleCapability: declaration,
    degradedEnforcementReports: createDegradedEnforcementReports(declaration),
    worktree: repository.worktree,
    branch: repository.branch,
    requiredCapabilities: ['implementation_mutation'],
    canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', `backends/${backend}.md`],
    attribution: { taskTrailer: `Task: ${taskId}`, agentTrailer: 'Agent: engineer' },
    liveness: {
      cadence: 'return after each check',
      // Derived, not hand-sized: see DISPATCH_LIVENESS_WINDOW_SECONDS. A packet
      // that expires while the toolkit's own mandated repairs are running was
      // never measuring staleness - it was measuring how long the repairs took.
      expiry: new Date(Date.now() + DISPATCH_LIVENESS_WINDOW_SECONDS * 1000).toISOString(),
      stopCondition: 'return on blocker',
    },
    cancellationBoundary: 'return_on_cancellation',
    invocationId: `invocation:${randomUUID()}`,
  };
}

function dispatchSourcesFromDurableState(target, taskId) {
  const sourceRef = `.agenticloop/decompositions/${taskId}.json`;
  const decomposition = readTargetJson(target, sourceRef, 'derived decomposition source');
  const base = decomposition?.scan?.readinessContext?.base;
  const dependency = decomposition?.scan?.readinessContext?.dependencies;
  const regeneration =
    `regenerate the decomposition source with 'agenticloop task prepare-decomposition ${taskId} ` +
    `--work-unit <work-unit-id> --source-ref ${sourceRef} --source-revision <ref> --base <ref-or-tree> ` +
    `--dependencies <path>' or use the advanced --input compatibility path`;
  if (base?.kind !== 'git_tree' || typeof base?.identity !== 'string' || !base.identity.startsWith('git-tree:')) {
    throw new VerificationContextMalformedError(
      `derived dispatch sources require an exact Git-tree base selector; ${regeneration}`
    );
  }
  // The semantic dependency source identity (for example
  // `files:.agenticloop/tasks`) is never reinterpreted as a path. The persisted
  // `sourceRef` is the only artifact selector, and it is validated through the
  // same canonical target-relative confinement every committed source uses.
  const dependencyRef = typeof dependency?.sourceRef === 'string' ? dependency.sourceRef : null;
  if (dependencyRef === null || !validateCommittedSourcePath(dependencyRef).ok) {
    throw new VerificationContextMalformedError(
      `derived dispatch sources lack an exact target-relative dependency revalidation selector; ${regeneration}`
    );
  }
  return {
    decomposition,
    readiness: {
      evidence: {
        base: { revalidationArgs: ['--base', base.identity.slice('git-tree:'.length)] },
        dependencies: { revalidationArgs: ['--dependencies', dependencyRef] },
      },
    },
  };
}

/**
 * Resolve the single authoritative activation capability inventory for a target.
 *
 * Every public edge - creation, preparation, persisted-packet validation, and
 * receive-side verification - goes through this function, so no surface can
 * recognize an adapter identity another surface rejects. The shipped inventory
 * is fail-closed. Registry documents are parsed for diagnostics, but no
 * supported adapter can enter through this public in-process boundary.
 */
function resolveActivationCapabilities(target, io, assertedPath) {
  const store = loadHostTrustStore(target, {
    operatorTrustRoot: io.operatorTrustRoot ?? undefined,
    assertedPath,
    protectedBoundary: io.hostAuthority ?? undefined,
  });
  if (store.state === 'unsupported_boundary') {
    throw new VerificationContextUnsupportedBoundaryError(
      `Host trust registry is well-formed but declares dynamic supported adapters: ${store.errors.join('; ')}`
    );
  }
  if (!store.ok) {
    throw new VerificationContextMalformedError(`Host trust store is invalid: ${store.errors.join('; ')}`);
  }
  return activationCapabilityInventory(store.adapters);
}

/**
 * Read the target's `agenticloop.json` when it exists.
 *
 * A files-only project that never generated a host adapter legitimately has no
 * such file, and the plugin-free activation path makes that the common case. An
 * absent file means "no target overrides"; a present but unreadable one stays a
 * typed malformed context rather than a silent default.
 */
function loadOptionalTargetConfig(target) {
  const path = join(target, 'agenticloop.json');
  if (!existsSync(path)) return {};
  try {
    return loadAgenticLoopConfig(path);
  } catch (error) {
    throw new VerificationContextMalformedError(`agenticloop.json is unreadable: ${error.message}`);
  }
}

/**
 * Report both assurance dimensions for one prepared dispatch.
 *
 * The activation grade is a fact about the packet; the return grade printed
 * here is the *minimum the policy requires*, because no return exists yet. The
 * wording says so rather than implying an observed return.
 */
function printDispatchAssurance(assurance, io) {
  if (!assurance) return;
  io.err(`activation: ${assurance.activation} (${assurance.activationDerivation}, via ${assurance.activationProducer})`);
  io.err(`return:     ${assurance.minimumReturn} (minimum required by ${assurance.mode} mode; policy source: ${assurance.policySource})`);
  for (const limitation of assurance.limitations ?? []) io.err(`  note: ${limitation}`);
}

function resolveEffectiveHostRoleCapabilities(target) {
  const config = loadOptionalTargetConfig(target);
  return buildHostRoleCapabilityInventory({
    adapterConfigs: config.adapters ?? {},
  });
}

function resolveEffectiveWorkflowRegistry(target) {
  return resolveWorkflowRoleRegistry(loadOptionalTargetConfig(target));
}

/** Resolve one pinned host adapter for return-receipt verification. */
function resolveTrustedHostAdapter(target, io, assertedPath, expectedAdapterId) {
  const store = loadHostTrustStore(target, {
    operatorTrustRoot: io.operatorTrustRoot ?? undefined,
    assertedPath,
    protectedBoundary: io.hostAuthority ?? undefined,
  });
  if (store.state === 'unsupported_boundary') {
    throw new VerificationContextUnsupportedBoundaryError(
      `Host trust registry is well-formed but declares dynamic supported adapters: ${store.errors.join('; ')}`
    );
  }
  if (!store.ok) {
    throw new VerificationContextMalformedError(`Host trust store is invalid: ${store.errors.join('; ')}`);
  }
  const adapter = store.adapters[String(expectedAdapterId ?? '')];
  if (!adapter) {
    throw new VerificationContextError(
      `packet-bound host adapter '${String(expectedAdapterId ?? '')}' is not pinned in the fixed operator trust registry`
    );
  }
  return adapter;
}

/** Resolve one verification-only authority from the same fixed operator trust store. */
function resolveTrustedBlockedAuthority(target, io, assertedPath, expectedAuthorityId, expectedKind) {
  const store = loadHostTrustStore(target, {
    operatorTrustRoot: io.operatorTrustRoot ?? undefined,
    assertedPath,
    protectedBoundary: io.hostAuthority ?? undefined,
  });
  if (store.state === 'unsupported_boundary') {
    throw new VerificationContextUnsupportedBoundaryError(
      `Host trust registry is well-formed but declares dynamic supported adapters: ${store.errors.join('; ')}`
    );
  }
  if (!store.ok) {
    throw new VerificationContextMalformedError(`Host trust store is invalid: ${store.errors.join('; ')}`);
  }
  const authority = store.authorities[String(expectedAuthorityId ?? '')];
  if (!authority || authority.authorityKind !== expectedKind) {
    throw new VerificationContextError(
      `authority '${String(expectedAuthorityId ?? '')}' of kind '${String(expectedKind ?? '')}' is not pinned in the fixed operator trust registry`
    );
  }
  return authority;
}

function readActivationCaptureInput(target, relPath, capabilities, intendedTaskId) {
  const path = resolve(target, String(relPath));
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new VerificationContextMalformedError(`Activation capture input '${String(relPath)}' is unreadable or invalid JSON: ${error.message}`);
  }
  const checked = validateActivationCapture(parsed, {
    capabilities,
    intendedTaskId,
    repositoryIdentity: targetRepositoryIdentity(target),
  });
  if (!checked.ok) {
    throw publicErrorFromFindings(checked.findings, {
      fallbackMessage: `Activation capture input '${String(relPath)}' is malformed.`,
    });
  }
  return parsed;
}

/** Run one Git command inside the target and return a plain spawn result. */
function targetGitRunner(target) {
  return args => spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
}

function refetchDispatchRepository(target, readiness) {
  const baseTree = gitTreeObjectId(readiness?.evidence?.base?.identity);
  if (!baseTree) throw new VerificationContextMalformedError('dispatch readiness must bind a full git-tree base identity');
  const verifiedTree = spawnSync('git', ['rev-parse', '--verify', `${baseTree}^{tree}`], { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  if (verifiedTree.status !== 0 || String(verifiedTree.stdout ?? '').trim() !== baseTree) {
    throw new VerificationContextStaleError(`dispatch base tree '${baseTree}' is unavailable or changed`);
  }
  const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  const branchName = String(branch.stdout ?? '').trim();
  const headId = String(head.stdout ?? '').trim();
  if (branch.status !== 0 || !branchName || head.status !== 0 || !isGitObjectId(headId)) {
    throw new VerificationContextMalformedError('dispatch requires a current named Git branch and full HEAD identity');
  }
  return { worktree: resolve(target), branch: branchName, head: headId, baseHead: headId, baseTree };
}

/**
 * Re-run readiness from the exact base and dependency sources named by the
 * request. Caller-authored result/evidence claims are never copied forward.
 */
function refetchDispatchReadiness(target, snapshot, requested) {
  const baseArgs = requested?.evidence?.base?.revalidationArgs;
  const dependencyArgs = requested?.evidence?.dependencies?.revalidationArgs;
  if (!Array.isArray(baseArgs) || baseArgs.length !== 2 || baseArgs[0] !== '--base') {
    throw new VerificationContextMalformedError('dispatch readiness requires exact --base <git-tree> revalidation arguments');
  }
  if (!Array.isArray(dependencyArgs) || dependencyArgs.length !== 2 || dependencyArgs[0] !== '--dependencies') {
    throw new VerificationContextMalformedError('dispatch readiness requires exact --dependencies <path> revalidation arguments');
  }
  const base = readExplicitBaseEvidence(target, { base: baseArgs[1] });
  const dependency = readDependencyEvidence(target, dependencyArgs[1], snapshot.taskId);
  const evaluated = evaluateTaskReadiness({
    taskBody: snapshot.body,
    basePaths: base.paths,
    mode: 'authoring',
    dependencies: dependency.statuses,
  });
  const result = createValidationResult({
    command: 'task-readiness',
    ok: evaluated.ok,
    evidenceState: evaluated.evidenceState,
    disposition: evaluated.disposition,
    errors: evaluated.errors,
    warnings: evaluated.warnings,
    diagnostics: evaluated.diagnostics,
  });
  const evidence = createTaskReadinessEvidence({
    backend: snapshot.backend,
    task: {
      id: snapshot.taskId,
      carrier: snapshot.carrier,
      expectedDigest: snapshot.digest,
    },
    base: base.evidence,
    dependencies: dependency.evidence,
    trustedRecordCount: snapshot.trustedRecords.length,
    trustedRecordErrors: snapshot.trustedRecordErrors,
  });
  return { evidence, result, resultDigest: validationResultDigest(result) };
}

/**
 * Read decomposition from the exact committed source and require canonical
 * Maintainer attribution on the source's last durable commit.
 */
function refetchDispatchDecomposition(target, requested, taskId) {
  const sourceRef = requested?.sourceRef;
  const verified = verifyCommittedAttributedSource(target, sourceRef, { taskId });
  if (!verified.ok) {
    const ErrorType = verified.evidenceState === 'missing' ? VerificationContextError
      : verified.evidenceState === 'changed' ? VerificationContextStaleError
        : VerificationContextMalformedError;
    throw new ErrorType(verified.error);
  }
  let value;
  try {
    value = JSON.parse(verified.source);
  } catch (error) {
    throw new VerificationContextMalformedError(`decomposition source '${sourceRef}' is invalid JSON: ${error.message}`);
  }
  if (value?.sourceRef !== sourceRef) {
    throw new VerificationContextMalformedError('decomposition sourceRef does not identify its exact carrier');
  }
  return value;
}

/**
 * Enumerate the configured files-backed task surface.
 *
 * This is the authoritative enumerator for the files backend: it lists the
 * configured task directory itself and issues the typed enumeration receipt
 * that inventory completeness is derived from. Completeness is never a caller
 * assertion, so nothing outside this function can claim the surface was fully
 * observed.
 */
function enumerateFilesTaskInventory(target, projectConfig, options = {}) {
  const dir = taskDirectory(target, projectConfig);
  const inventoryRoot = relative(target, dir).replace(/\\/g, '/');
  const inventoryId = `files:${inventoryRoot}`;
  const files = taskFiles(target, projectConfig);
  // `overlay` supplies the exact prospective bytes of one already-enumerated
  // carrier. It never adds, removes, or hides a member: the directory listing
  // and the enumeration receipt are unchanged, so completeness is still derived
  // from the authoritative enumeration. It exists because a single readiness
  // transaction settles the lifecycle transition and the decomposition together,
  // and a decomposition that bound the pre-transition carrier digest would be
  // stale against its own commit.
  const overlay = options.overlay ?? null;
  const entries = files.map(file => {
    const carrier = relative(target, file).replace(/\\/g, '/');
    if (overlay && Object.hasOwn(overlay, carrier)) {
      return { carrier, content: overlay[carrier], readError: null };
    }
    try {
      return { carrier, content: readFileSync(file, 'utf8'), readError: null };
    } catch (error) {
      return { carrier, content: null, readError: error.message };
    }
  });
  const enumeration = createTaskInventoryEnumeration({
    backend: 'files',
    inventoryId,
    observedAt: options.observedAt ?? new Date().toISOString(),
    discovered: entries.length,
    returned: entries.length,
    // A local directory listing is a single unpaginated observation; there is
    // no cursor left unfollowed and nothing was dropped between discovery and
    // return.
    pageCount: 1,
    truncated: false,
    cursor: null,
  });
  return normalizeFilesTaskInventory({ inventoryId, entries, complete: true, enumeration }, { now: options.now });
}

/**
 * Enumerate every GitHub issue page through the injected read-only transport.
 *
 * The enumeration is entirely transport-scoped: the repository identity comes
 * from `--repo` or the authenticated `gh` context, never from the local
 * checkout, so no target path is required or accepted here.
 *
 * @param {object} projectConfig  Project map config supplying `task_id_regex`.
 * @param {object} io             Injected I/O carrying the read-only gh runner.
 * @param {{ repo?: string, observedAt?: string, now?: number }} [options]
 */
function enumerateGitHubTaskInventory(projectConfig, io, options = {}) {
  const commandRunner = resolveGhRunner(io);
  const repo = resolveGitHubRepository(commandRunner, options.repo);
  const pages = runGhJson(commandRunner, [
    'api', '--paginate', '--slurp', `repos/${repo}/issues?state=all&per_page=100`,
  ]);
  if (!Array.isArray(pages) || pages.length === 0 || pages.some(page => !Array.isArray(page))) {
    throw new VerificationContextMalformedError('GitHub issue pagination did not return a complete page inventory');
  }
  // The REST issues endpoint also returns pull requests. They are not task issue
  // carriers and are excluded only by the API's explicit pull_request marker.
  //
  // Enumeration coverage is defined over the task-issue surface, *after* this
  // filter: `discovered` counts the issue entries that could carry a task
  // record, not the raw REST rows. Counting raw rows would make `discovered`
  // exceed `returned` and report a complete issue inventory as truncated purely
  // because the endpoint also returned pull requests - which are not part of the
  // surface the inventory claims to cover. Pull requests are therefore excluded
  // at the surface boundary rather than carried in and then excluded from the
  // ready set; the ready-set exclusion vocabulary describes task members, and a
  // pull request never becomes one.
  const issues = pages.flat().filter(issue => !issue?.pull_request).map(issue => ({
    number: issue?.number,
    state: issue?.state,
    title: issue?.title,
    body: issue?.body,
    labels: issue?.labels,
  }));
  const inventoryId = `github:${repo}`;
  const observedAt = options.observedAt ?? new Date().toISOString();
  const enumeration = createTaskInventoryEnumeration({
    backend: 'github', inventoryId, observedAt,
    discovered: issues.length, returned: issues.length,
    pageCount: pages.length, truncated: false, cursor: null,
  });
  const identityInventory = buildGitHubTaskIdentityInventory(issues, {
    complete: true,
    taskIdRegex: projectConfig.task_id_regex,
  });
  const normalized = normalizeGitHubTaskInventory({
    inventoryId,
    inventory: { ...identityInventory, issues },
    enumeration,
  }, { now: options.now });
  return { repo, issues, identityInventory, normalized };
}

/**
 * Refetch the work-unit inventory only once the decomposition is known to name
 * the selected backend. The inventory arrives as a thunk so an incompatible
 * decomposition is rejected before any directory listing or transport read.
 *
 * @param {string} backend
 * @param {() => object} enumerateInventory
 * @param {object} decomposition
 */
function refetchDispatchParallelScanInventory(backend, enumerateInventory, decomposition) {
  if (decomposition?.scan?.workUnit?.backend !== backend) {
    throw new VerificationContextMalformedError(
      `${backend}-backed task dispatch requires a ${backend} parallel-scan work-unit inventory`
    );
  }
  return enumerateInventory();
}

/**
 * Reconstruct files-backed return evidence from current durable Git state.
 * Host-signed checks remain transport evidence; repository identity, paths, and
 * attribution are always derived again before the receipt is authenticated.
 */
/**
 * The default wall-clock freshness window for a decomposition observation.
 *
 * The decomposition and the dependency snapshot it binds are one observation
 * answering one question of the backend - can this evidence change without
 * producing an observable repository event? - so they share one derivation,
 * `defaultDependencyFreshnessSeconds`, rather than two identical copies that can
 * drift apart. This name is kept because the command surface and its docs speak
 * of the decomposition's window.
 *
 * `--max-age-seconds` still overrides the default explicitly.
 */
export function defaultDecompositionFreshnessSeconds(backend) {
  return defaultDependencyFreshnessSeconds(backend);
}

/**
 * The canonical semantic rescan trigger a prepared decomposition declares.
 *
 * One constant, because `prepare-decomposition` and the readiness transaction
 * must declare the identical trigger: a decomposition whose rescan condition
 * differed between the two routes would be a different observation.
 */
export const DECOMPOSITION_RESCAN_TRIGGER =
  'inventory membership or enumeration coverage, task carrier digests, base or dependency evidence, ' +
  'ownership, coupling, or decomposition source revision changes';

/**
 * Resolve every exact input an executable readiness plan binds.
 *
 * Each input is resolved through the same canonical authority the standalone
 * command uses, so the plan can never bind a fact derived a second way. An input
 * that cannot be resolved becomes a blocker rather than a placeholder: a
 * display-only plan is still useful, but it must say so.
 */
function readinessPlanInputs({ target, taskId, opts, projectConfig, backend }) {
  const inputBlockers = [];
  let base = null;
  let dependencies = null;
  let inventory = null;
  if (opts.base || opts.basePaths) {
    try {
      base = readExplicitBaseEvidence(target, { base: opts.base, basePaths: opts.basePaths });
    } catch (error) {
      inputBlockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (opts.dependencies) {
    try {
      dependencies = readDependencyEvidence(target, opts.dependencies, taskId);
    } catch (error) {
      inputBlockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    inventory = enumerateFilesTaskInventory(target, projectConfig);
  } catch (error) {
    inputBlockers.push(`the authoritative task inventory could not be enumerated: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    projectConfig,
    actor: opts.actor ? String(opts.actor) : null,
    authority: opts.authority ? String(opts.authority) : null,
    workUnitId: opts.workUnit ? String(opts.workUnit) : null,
    base,
    dependencies,
    dependencyRef: opts.dependencies ? String(opts.dependencies) : null,
    inventory,
    freshnessMaxAgeSeconds: opts.maxAgeSeconds === undefined
      ? defaultDecompositionFreshnessSeconds(backend)
      : Number(opts.maxAgeSeconds),
    rescanTrigger: opts.rescanTrigger ? String(opts.rescanTrigger) : DECOMPOSITION_RESCAN_TRIGGER,
    route: opts.route ? String(opts.route) : 'serial',
    inputBlockers,
  };
}

/**
 * The canonical input bindings one readiness transaction re-resolves.
 *
 * Every one is the same authority the corresponding standalone command uses, so
 * apply can never derive a bound fact a second way, and it never parses a
 * rendered command string. Exported so failure-injection coverage exercises the
 * exact production bindings rather than test doubles.
 *
 * @param {string} target
 * @param {object} projectConfig
 * @param {string} taskId
 */
export function createReadinessApplyBindings(target, projectConfig, taskId) {
  return {
    enumerateInventory: (options = {}) => enumerateFilesTaskInventory(target, projectConfig, options),
    resolveBaseEvidence: options => readExplicitBaseEvidence(target, options),
    resolveDependencyEvidence: relPath => readDependencyEvidence(target, relPath, taskId),
  };
}

/**
 * Resolve explicit base evidence. There is no implicit HEAD and no default
 * branch: exactly one of `--base` or `--base-paths` must be supplied, and a
 * `--base` ref is resolved to its exact tree object id so a later branch move
 * cannot silently redefine the recorded baseline.
 */
function readExplicitBaseEvidence(target, options = {}) {
  const hasBase = Boolean(options.base);
  const hasInventory = Boolean(options.basePaths);
  if (hasBase && hasInventory) {
    throw new VerificationContextMalformedError(
      'Supply exactly one of --base <ref> or --base-paths <path>; supplying both leaves the intended baseline ambiguous.'
    );
  }
  if (!hasBase && !hasInventory) {
    throw new VerificationContextError(
      'An agent-ready transition requires explicit base evidence: --base <ref> or --base-paths <path>. No default branch or HEAD is selected.',
      { requiredContext: ['--base <ref> or --base-paths <path>'] }
    );
  }
  if (hasInventory) {
    const relPath = String(options.basePaths).replace(/\\/g, '/');
    const path = resolve(target, String(options.basePaths));
    let source;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      throw new VerificationContextError(`Base-path inventory '${relPath}' is unavailable.`, {
        requiredContext: [`a readable --base-paths JSON inventory at '${relPath}'`],
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new VerificationContextMalformedError(`Base-path inventory '${relPath}' is not valid JSON.`);
    }
    const paths = Array.isArray(parsed) ? parsed : parsed?.paths;
    if (!Array.isArray(paths) || paths.some(entry => typeof entry !== 'string')) {
      throw new VerificationContextMalformedError('--base-paths JSON must be an array or { paths: [] } of strings');
    }
    return {
      paths,
      evidence: {
        kind: 'path_inventory',
        identity: `path-inventory:${relPath}`,
        inventoryDigest: taskRecordDigest(canonicalJson([...paths].sort())),
        pathCount: paths.length,
        revalidationArgs: ['--base-paths', relPath],
      },
    };
  }
  const ref = String(options.base);
  const tree = spawnSync('git', ['rev-parse', '--verify', `${ref}^{tree}`], { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  const treeOid = String(tree.stdout ?? '').trim();
  if (tree.status !== 0 || !isGitObjectId(treeOid)) {
    throw new VerificationContextMalformedError(`Base ref '${ref}' cannot be resolved to an exact Git tree object id.`);
  }
  const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', treeOid], { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  if (listed.status !== 0) {
    throw new VerificationContextMalformedError(`Base tree '${treeOid}' cannot be listed.`);
  }
  const paths = String(listed.stdout ?? '').split(/\r?\n/).filter(Boolean);
  return {
    paths,
    evidence: {
      kind: 'git_tree',
      identity: `git-tree:${treeOid}`,
      inventoryDigest: taskRecordDigest(canonicalJson([...paths].sort())),
      pathCount: paths.length,
      // Revalidation binds the resolved tree, never the symbolic ref, so a
      // moved branch cannot make the emitted command evaluate a different base.
      revalidationArgs: ['--base', treeOid],
    },
  };
}

/** Read and validate the exact dependency-status snapshot for this transition. */
function readDependencyEvidence(target, option, taskId) {
  if (!option) {
    throw new VerificationContextError(
      // One condition, one public sentence. The GitHub carrier reports the
      // identical text for the identical condition; only the carrier identity
      // in the surrounding envelope tells the two apart.
      'A transition to agent-ready requires --dependencies <path> naming the exact dependency-status snapshot.',
      { requiredContext: ['--dependencies <path>'] }
    );
  }
  const relPath = String(option);
  const verified = verifyCommittedAttributedSource(target, relPath, { taskId });
  if (!verified.ok) {
    const ErrorType = verified.evidenceState === 'missing' ? VerificationContextError
      : verified.evidenceState === 'changed' ? VerificationContextStaleError
        : VerificationContextMalformedError;
    throw new ErrorType(verified.error, {
      requiredContext: [`a committed Maintainer-attributed dependency snapshot at '${relPath}'`],
    });
  }
  const parsed = parseDependencySnapshot(verified.source, {
    sourceRef: relPath,
    provenance: verified.provenance,
  });
  if (!parsed.ok) {
    const stale = parsed.errors.some(error => /stale|future/i.test(error));
    if (stale) throw new VerificationContextStaleError(parsed.errors[0]);
    throw new VerificationContextMalformedError(parsed.errors[0]);
  }
  return { evidence: parsed.evidence, statuses: dependencyStatusMap(parsed.evidence) };
}

/**
 * The exact read-only command that re-evaluates this transition's evidence
 * against the resulting record. It is `task-readiness`, never a mutation
 * command, and it carries the resulting digest rather than a placeholder.
 */
function readinessRevalidationCommand({ taskId, carrier, resultingDigest, context, mode = 'authoring' }) {
  // Without a readiness evidence context there is no base or dependency
  // evidence to re-evaluate, so the exact read-only verifier is the lint
  // family bound to the resulting digest.
  if (!context) {
    return ['npx', 'agenticloop', 'task', 'lint', shellQuoteArgument(taskId), '--expect-task-digest', resultingDigest].join(' ');
  }
  return [
    'npx', 'agenticloop', 'task-readiness',
    '--task-body', shellQuoteArgument(carrier),
    '--mode', mode,
    '--expect-task-digest', resultingDigest,
    ...context.base.revalidationArgs.map(shellQuoteArgument),
    ...context.dependencies.revalidationArgs.map(shellQuoteArgument),
  ].join(' ');
}

function nextDefaultTaskId(files) {
  let max = 0;
  for (const file of files) {
    const base = file.split(/[\\/]/).pop() ?? '';
    const match = base.match(/^T-(\d{3,})\.md$/);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

function instantiateTaskTemplate(target, projectConfig, taskId, title) {
  const layout = resolveToolkitAssetLayout(target);
  const templatePath = resolveToolkitAssetPath(target, TASK_RECORD_TEMPLATE_RELATIVE_PATH, layout);
  if (!existsSync(templatePath)) {
    throw new VerificationContextError(`Task template not found: ${TASK_RECORD_TEMPLATE_RELATIVE_PATH}`, {
      requiredContext: [`a readable toolkit task template at '${TASK_RECORD_TEMPLATE_RELATIVE_PATH}'`],
    });
  }
  return readFileSync(templatePath, 'utf-8')
    .replaceAll('T-001', taskId)
    .replaceAll('Short Task Title', title)
    .replaceAll('Short task title', title);
}

export function appendComment(content, note) {
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- ${date}: ${note.trim()}`;
  const comments = markdownSection(content, '## Comments');
  if (comments) {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    lines.splice(comments.startLine, 0, entry);
    return lines.join(eol);
  }
  return `${content.trimEnd()}\n\n## Comments\n${entry}\n`;
}

function printLintResults(results, json, io) {
  if (json) {
    io.out(JSON.stringify(results, null, 2));
    return;
  }
  for (const result of results) {
    if (result.errors.length === 0 && result.warnings.length === 0) {
      io.out(`${result.file}: ok`);
      continue;
    }
    const diagnosticMessages = new Set((result.diagnostics ?? []).map(item => item.message));
    for (const diagnostic of result.diagnostics ?? []) {
      io.out(`${result.file}: ERROR [${diagnostic.code}] ${diagnostic.message}`);
      if (diagnostic.repairHint) io.out(`${result.file}: REPAIR ${diagnostic.repairHint}`);
    }
    for (const error of result.errors) {
      if (!diagnosticMessages.has(error)) io.out(`${result.file}: ERROR ${error}`);
    }
    for (const warning of result.warnings) io.out(`${result.file}: WARN ${warning}`);
  }
}

/**
 * Validate the acceptance gate: a task cannot be accepted or closed without
 * meeting minimum evidence requirements.
 *
 * @param {string} content  Full task record content
 * @param {string} filePath  Path for error messages
 * @param {object} verificationContext
 * @returns {string[]} Error messages (empty if gate passes)
 */
function validateAcceptanceGate(content, filePath, verificationContext) {
  const filename = filePath.replace(/\\/g, '/');
  const [frontmatter] = parseFrontmatter(content);
  const errors = [];

  if (!frontmatter) {
    errors.push(`Task '${filename}' cannot be accepted: missing YAML frontmatter`);
    return errors;
  }

  const reviewStatus = frontmatterString(frontmatter.review_status);
  const implementationArtifact = frontmatterString(frontmatter.implementation_artifact);

  // 1. review_status must be 'accepted'
  if (reviewStatus !== 'accepted') {
    errors.push(`Task '${filename}' cannot be accepted: review_status must be 'accepted' (currently '${reviewStatus || '(empty)'}')`);
  }

  // Shared validation keeps lint and acceptance behavior aligned.
  const reviewMode = frontmatterString(frontmatter.review_mode);
  const reviewedArtifact = frontmatterString(frontmatter.reviewed_artifact);
  const humanReviewRef = frontmatterString(frontmatter.human_review_ref);
  errors.push(...validateReviewProvenance({
    label: filename,
    status: 'accepted',
    reviewStatus,
    reviewModeRaw: reviewMode,
    implementationArtifact,
    reviewedArtifact,
    independentRaw: frontmatterString(frontmatter.independent_review_required),
    humanReviewRef,
  }).map(error => error.replace(/^Task record/, 'Task')));

  // 2. implementation_artifact must be non-empty
  if (!implementationArtifact) {
    errors.push(`Task '${filename}' cannot be accepted: implementation_artifact is empty`);
  }

  // 3. Scope Completed must be non-empty
  const scopeBody = sectionBody(content, '## Scope Completed');
  if (!scopeBody) {
    errors.push(`Task '${filename}' cannot be accepted: '## Scope Completed' section is empty`);
  }

  // 4. Evidence must be non-empty
  const evidenceBody = sectionBody(content, '## Evidence');
  if (!evidenceBody) {
    errors.push(`Task '${filename}' cannot be accepted: '## Evidence' section is empty`);
  }

  const verificationAttempts = validateVerificationAttempts(content, {
    status: 'accepted',
    ...verificationContext,
  });
  errors.push(...verificationAttempts.errors.map(error => `Task '${filename}' cannot be accepted: ${error}`));

  return errors;
}

export async function cmdTask(args, io = createIo()) {
  const sub = args[0];
  const TASK_SUBCOMMANDS = COMMAND_REGISTRY.task.subcommands;
  if (!sub || !TASK_SUBCOMMANDS[sub]) {
    const suggestion = sub ? suggestName(sub, Object.keys(TASK_SUBCOMMANDS)) : null;
    throw new CliUsageError(suggestion
      ? `task: unknown subcommand '${sub}'. Did you mean '${suggestion}'?`
      : 'task requires a subcommand: list, lint, new, establish-baseline, authorize-correction, prepare-decomposition, prepare-dispatch, handoff-preflight, refresh-handoff-evidence, attempt-status, abandon-attempt, adopt-historical, readiness-plan, readiness-apply, measure, prepare-return, verify-return, check-evidence-init, check-evidence-show, check-evidence-update, evidence, status.');
  }
  const { opts, positional } = parseCommandArgs(`task ${sub}`, TASK_SUBCOMMANDS[sub], args.slice(1));
  const target = resolveCliTarget(io, opts.target);
  // One resolution, one validation, one diagnostic shape - for every
  // subcommand, before any subcommand-specific routing chooses an enumerator or
  // a transport.
  const guard = guardTaskBackend(sub, target, opts, io);
  if (!guard.ok) return guard.exit;
  const selectedBackend = guard.resolution;

  const project = resolveProject(target);
  const projectConfig = project.config;
  const verificationContext = createLocalVerificationContext(target, {
    projectMap: { config: projectConfig, verificationFacts: projectConfig.verificationFacts },
  });

  try {
    if (sub === 'list') {
      const rows = taskFiles(target, projectConfig)
        .map(taskRecordFromFile)
        .filter(row => !opts.status || row.status === opts.status)
        .map(row => ({
          task_id: row.task_id,
          status: row.status,
          review_status: row.review_status,
          review_mode: row.review_mode,
          implementation_artifact: row.implementation_artifact,
          reviewed_artifact: row.reviewed_artifact,
        }));
      if (opts.json) io.out(JSON.stringify(rows, null, 2));
      else io.out(rows.length > 0 ? formatTable(rows) : 'No task records found.');
      return 0;
    }

    if (sub === 'lint') {
      const taskId = positional[0];
      if (opts.expectTaskDigest && !taskId) {
        io.err('task lint --expect-task-digest requires the exact task id whose digest is being verified');
        return EXIT_USAGE;
      }
      const files = taskId ? [taskPathForId(target, projectConfig, taskId)] : taskFiles(target, projectConfig);
      const results = files.map(file => existsSync(file)
        ? lintTaskFile(file, target, projectConfig, verificationContext)
        : { file: relative(target, file).replace(/\\/g, '/'), errors: [`Task record not found: ${taskId}`], warnings: [] });
      // Read-only exact-digest verification: the receipt for a non-readiness
      // mutation names this command, so it must fail when the carrier no longer
      // holds the digest that receipt reported.
      if (opts.expectTaskDigest) {
        const expected = String(opts.expectTaskDigest);
        for (const result of results) {
          if (result.digest && result.digest !== expected) {
            result.errors = [
              ...result.errors,
              `expected task digest ${expected}, the current record digest is ${result.digest}`,
            ];
          }
        }
      }
      printLintResults(results, Boolean(opts.json), io);
      return results.some(result => result.errors.length > 0) ? 1 : 0;
    }

    if (sub === 'new') {
      const title = positional.join(' ').trim();
      if (!title) {
        io.err('task new requires a title');
        return EXIT_USAGE;
      }
      if (!opts.activationInput && !opts.scaffold) {
        return printGateResult('task new', commandFailure('task new', new PublicCommandError(
          'Task creation refused before mutation: parser-owned activation capture is required.', {
            code: 'activation.capture.missing', evidenceState: 'missing', disposition: 'needs_context',
            committedStateEvaluated: false,
            safeRepair: 'Use --scaffold for non-activated Markdown scaffolding, or use a supported host-produced activation capture when one exists. Never author capture JSON in model-visible text.',
          }
        ), 'operational_error', {}, target), Boolean(opts.json), io);
      }
      // Resolve the exact prospective identity before reading or validating a
      // one-task activation authorization. The capture can never float to a
      // different auto-allocated id after a conflict.
      const defaultRegex = PROJECT_MAP_DEFAULTS.task_id_regex;
      const taskId = opts.id
        ? String(opts.id)
        : projectConfig.task_id_regex === defaultRegex
          ? nextDefaultTaskId(taskFiles(target, projectConfig))
          : null;
      if (!taskId) {
        io.err('Automatic task id allocation supports the default T-### convention only; pass --id for this project.');
        return 1;
      }
      if (!isValidTaskId(taskId, projectConfig.task_id_regex ?? defaultRegex)) {
        io.err(`Task id '${taskId}' does not match project task_id_regex '${projectConfig.task_id_regex ?? defaultRegex}'`);
        return 1;
      }
      const filePath = taskPathForId(target, projectConfig, taskId);
      if (existsSync(filePath)) {
        io.err(`Task record already exists: ${relative(target, filePath).replace(/\\/g, '/')}`);
        return 1;
      }
      let activationCapture;
      let activationCaptureRef = null;
      if (opts.activationInput) {
        if (opts.scaffold) {
          io.err('task new --scaffold cannot be combined with --activation-input');
          return EXIT_USAGE;
        }
        let capabilities;
        try {
          capabilities = resolveActivationCapabilities(target, io, opts.hostTrustStore);
          activationCaptureRef = relative(target, resolve(target, String(opts.activationInput))).replace(/\\/g, '/');
          if (!validActivationCaptureRef(activationCaptureRef)) {
            throw new VerificationContextMalformedError(
              `Activation capture input '${String(opts.activationInput)}' must resolve to a safe repository-relative path inside the target`
            );
          }
          activationCapture = readActivationCaptureInput(target, opts.activationInput, capabilities, taskId);
        } catch (error) {
          return printGateResult('task new', commandFailure('task new', error, 'operational_error', {}, target), Boolean(opts.json), io);
        }
        const disposition = activationCaptureDisposition(activationCapture, {
          capabilities,
          intendedTaskId: taskId,
          repositoryIdentity: targetRepositoryIdentity(target),
        });
        if (!disposition.ok) {
          const code = disposition.evidenceState === 'missing'
            ? 'activation.capture.missing'
            : disposition.evidenceState === 'changed'
              ? 'activation.capture.mismatch'
              : disposition.evidenceState === 'negative'
                ? 'activation.capture.unsupported'
                : 'activation.capture.malformed';
          return printGateResult('task new', commandFailure('task new', new PublicCommandError(
            `Task creation refused before mutation: ${disposition.errors.join('; ')}`, {
              code, evidenceState: disposition.evidenceState, disposition: disposition.disposition,
              committedStateEvaluated: false,
              safeRepair: 'Use --scaffold for non-activated Markdown scaffolding, then run npx agenticloop activate <task-id> before dispatch. Use a supported host capture only when hardened host_signed assurance is required. Never edit or author capture JSON.',
            }
          ), 'operational_error', {}, target), Boolean(opts.json), io);
        }
      }
      const reviewBudget = resolveProjectReviewBudget(projectConfig);
      if (reviewBudget.error) {
        io.err(`Cannot create task: ${reviewBudget.error}`);
        return 1;
      }
      const attemptBudget = resolveProjectAttemptBudget(projectConfig);
      if (attemptBudget.error) {
        io.err(`Cannot create task: ${attemptBudget.error}`);
        return 1;
      }
      mkdirSync(dirname(filePath), { recursive: true });
      // A freshly scaffolded skeleton is not yet ready for an agent; the
      // canonical template ships `agent-ready`, so open new tasks as `draft`.
      let newContent = replaceFrontmatterField(
        instantiateTaskTemplate(target, projectConfig, taskId, title),
        'status',
        'draft'
      );
      newContent = replaceFrontmatterField(newContent, 'attempt_budget', String(attemptBudget.budget));
      newContent = replaceFrontmatterField(newContent, 'review_budget', String(reviewBudget.budget));
      newContent = replaceFrontmatterField(newContent, 'task_contract_schema', '2');
      if (activationCapture) {
        // Both fields are recorded: the digest binds the exact authorized bytes,
        // and the reference binds the verifiable host-signed capture artifact so
        // a hand-written digest alone cannot claim parser-owned authoring.
        newContent = replaceFrontmatterField(newContent, 'activation_input_digest', activationCapture.normalizedActivationDigest);
        newContent = replaceFrontmatterField(newContent, 'activation_capture_ref', activationCaptureRef);
      }
      const prospectiveDiagnostics = validateTaskRecordDiagnostics(newContent, relative(target, filePath).replace(/\\/g, '/'));
      const prospectiveErrors = [
        ...prospectiveDiagnostics.map(item => item.message),
        ...validateTaskRecord(newContent, relative(target, filePath).replace(/\\/g, '/')),
        ...validateFilesTaskRecord(newContent, relative(target, filePath).replace(/\\/g, '/'), {
          activeTaskBackend: 'files',
          projectMapConfig: projectConfig,
          projectVerificationFacts: verificationContext.projectFacts,
          decisionExists: verificationContext.decisionExists,
          taskExists: verificationContext.taskExists,
          repoRoot: target,
          commandRunner: taskLintCommandRunner,
          warnings: [],
        }),
      ];
      if (prospectiveErrors.length > 0) {
        for (const error of prospectiveErrors) io.err(`Cannot create task: ${error}`);
        return 1;
      }
      const relPath = relative(target, filePath).replace(/\\/g, '/');
      const candidateDigest = taskRecordDigest(newContent);
      const created = executeMutationBatch(target, [{ type: 'create', path: relPath, content: newContent }]);
      const creationReceipt = ({ resultingDigest, disposition, changedPaths, recovery, result }) =>
        createTaskMutationReceipt({
          context: null,
          backend: 'files',
          taskId,
          carrier: relPath,
          expectedDigest: null,
          candidateDigest,
          resultingDigest,
          verification: { resultKind: VALIDATION_RESULT_KIND, digest: validationResultDigest(result) },
          ownedProjections: ['task_record'],
          changedPaths,
          mutationDisposition: disposition,
          recovery,
          revalidateCommand: readinessRevalidationCommand({
            taskId, carrier: relPath, resultingDigest: resultingDigest ?? candidateDigest, context: null,
          }),
        });
      if (!created.ok) {
        const rolledBack = created.rollbackErrors.length === 0;
        const receipt = creationReceipt({
          resultingDigest: null,
          disposition: rolledBack ? 'uncommitted' : 'partially_committed',
          changedPaths: rolledBack ? [] : [relPath],
          recovery: rolledBack
            ? `No file was created at ${relPath}. Repair the reported cause and rerun task new.`
            : `Creation failed and rollback reported errors. Inspect ${relPath} before retrying: ${created.rollbackErrors.join('; ')}`,
          result: createValidationResult({
            command: 'task new', ok: false, evidenceState: 'negative', disposition: 'blocked',
            errors: created.errors, task_id: taskId, file: relPath,
          }),
        });
        for (const error of created.errors) io.err(`Cannot create task: ${error}`);
        for (const error of created.rollbackErrors) io.err(`rollback error: ${error}`);
        if (opts.json) io.out(JSON.stringify({ task_id: taskId, file: relPath, receipt }, null, 2));
        return 1;
      }
      const written = readFileSync(filePath, 'utf8');
      const writtenDigest = taskRecordDigest(written);
      if (written !== newContent || validateTaskRecordDiagnostics(written, relPath).length > 0) {
        const receipt = creationReceipt({
          resultingDigest: writtenDigest,
          disposition: 'unresolved',
          changedPaths: [relPath],
          recovery: `A file was created at ${relPath} (${writtenDigest}) that does not equal the validated candidate (${candidateDigest}). ` +
            'Preserve and inspect it before authorizing any readiness transition.',
          result: createValidationResult({
            command: 'task new', ok: false, evidenceState: 'changed', disposition: 'blocked',
            errors: ['the created record does not equal the validated candidate'], task_id: taskId, file: relPath,
          }),
        });
        io.err('Task creation did not refetch to the validated candidate; no readiness transition was authorized.');
        if (opts.json) io.out(JSON.stringify({ task_id: taskId, file: relPath, receipt }, null, 2));
        return 1;
      }
      const receipt = creationReceipt({
        resultingDigest: writtenDigest,
        disposition: 'committed',
        changedPaths: created.writtenFiles,
        recovery: null,
        result: createValidationResult({
          command: 'task new', ok: true, evidenceState: 'current', disposition: 'proceed',
          task_id: taskId, file: relPath,
        }),
      });
      if (opts.json) io.out(JSON.stringify({ task_id: taskId, file: relPath, receipt }, null, 2));
      else io.out(`Created ${relPath}`);
      return 0;
    }

    if (sub === 'prepare-decomposition') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId || !opts.workUnit || !opts.sourceRef || !opts.sourceRevision) {
        io.err('task prepare-decomposition requires <id>, --work-unit, --source-ref, and --source-revision');
        return EXIT_USAGE;
      }
      let base;
      let dependency;
      try {
        base = readExplicitBaseEvidence(target, { base: opts.base, basePaths: opts.basePaths });
        dependency = readDependencyEvidence(target, opts.dependencies, taskId);
      } catch (error) {
        return printGateResult('task prepare-decomposition', commandFailure('task prepare-decomposition', error, 'operational_error', {}, target), asJson, io);
      }
      // Wall-clock freshness is a backstop for state that can change *without*
      // an observable repository event - never a substitute for the semantic
      // binding, and never a timer on work that is progressing normally.
      //
      // The flat one-hour default guaranteed expiry before return for
      // any Engineer session longer than an hour, on a files-backed route where
      // every dependency status lives in the repository and every change to one
      // is already caught by the scan's inventory-membership and carrier-digest
      // bindings. The clock was measuring session length, not staleness.
      const maxAgeSeconds = opts.maxAgeSeconds === undefined
        ? defaultDecompositionFreshnessSeconds(selectedBackend.backend)
        : Number(opts.maxAgeSeconds);
      // One observation instant for the enumeration receipt and the scan: they
      // describe the same observation, so the emitted source is byte-identical
      // for identical inputs.
      const observedAt = opts.observedAt ? String(opts.observedAt) : new Date().toISOString();
      const backend = selectedBackend.backend;
      const enumerateInventory = backend === 'github'
        ? () => enumerateGitHubTaskInventory(projectConfig, io, { observedAt, repo: opts.repo }).normalized
        : () => enumerateFilesTaskInventory(target, projectConfig, { observedAt });
      const prepared = prepareDecompositionSource({
        // The producer never receives a caller-supplied inventory: it calls the
        // authoritative enumerator, which lists the configured task directory
        // and issues the typed enumeration receipt completeness derives from.
        enumerateInventory,
        workUnit: { id: String(opts.workUnit), backend },
        taskId,
        sourceRef: String(opts.sourceRef),
        sourceRevision: String(opts.sourceRevision),
        route: opts.route ? String(opts.route) : 'serial',
        observedAt,
        freshnessPolicy: { maxAgeSeconds },
        basePaths: base.paths,
        dependencies: dependency.statuses,
        readinessContext: { base: base.evidence, dependencies: dependency.evidence },
        rescanTrigger: opts.rescanTrigger ? String(opts.rescanTrigger) : DECOMPOSITION_RESCAN_TRIGGER,
      });
      if (!prepared.ok) {
        // The canonical validation-result envelope is the diagnostic surface;
        // it is emitted as itself rather than re-wrapped.
        return printGateResult('task prepare-decomposition', prepared.validation, asJson, io);
      }
      // The artifact is the committable source itself; the command writes
      // nothing. Redirect stdout to `--source-ref` and commit it separately.
      io.out(prepared.source.trimEnd());
      return 0;
    }

    if (sub === 'prepare-dispatch') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      const advancedInput = Boolean(opts.input);
      if (!taskId || (opts.input && opts.packet) || (!opts.packet && !advancedInput && (!opts.host || opts.role !== 'engineer'))) {
        const error = new CliUsageError('task prepare-dispatch requires <id>; ordinary packet creation requires --host <host> and --role engineer, while --input remains an advanced compatibility route; --input and --packet are mutually exclusive');
        return printGateResult('task prepare-dispatch', commandFailure('task prepare-dispatch', error, 'usage', {}, target), asJson, io, EXIT_USAGE);
      }
      const readJson = (relPath, label) => {
        return readTargetJson(target, relPath, label);
      };
      let input = null;
      let capabilities;
      let hostRoleCapabilities;
      let priorGateReceipts = [];
      try {
        input = opts.input ? readJson(opts.input, 'dispatch input') : null;
        capabilities = resolveActivationCapabilities(target, io, opts.hostTrustStore);
        hostRoleCapabilities = resolveEffectiveHostRoleCapabilities(target);
        if (opts.priorReceipts) {
          priorGateReceipts = readJson(opts.priorReceipts, 'prior-gate receipts');
        } else if (Array.isArray(input?.priorGateReceipts)) {
          priorGateReceipts = input.priorGateReceipts;
        }
      } catch (error) {
        return printGateResult('task prepare-dispatch', commandFailure('task prepare-dispatch', error, 'operational_error', {}, target), asJson, io);
      }
      const backend = selectedBackend.backend;
      const filePath = backend === 'files' ? taskPathForId(target, projectConfig, taskId) : null;
      const carrier = filePath ? relative(target, filePath).replace(/\\/g, '/') : null;
      let githubSnapshot = null;
      const currentGitHubSnapshot = () => {
        if (!githubSnapshot) githubSnapshot = enumerateGitHubTaskInventory(projectConfig, io, { repo: opts.repo });
        return githubSnapshot;
      };
      const refetchTask = () => {
        if (backend === 'files') {
          if (!existsSync(filePath)) throw new VerificationContextError(`task record not found: ${carrier}`);
          const body = readFileSync(filePath, 'utf8');
          const history = loadFilesTaskContractRecords(target, taskId);
          return {
            backend: 'files', taskId, carrier, body, digest: taskRecordDigest(body),
            trustedRecords: history.trustedRecords,
            trustedRecordErrors: history.errors,
          };
        }
        const snapshot = currentGitHubSnapshot();
        const resolvedTask = resolveCoveredGitHubTask(snapshot.identityInventory, taskId);
        if (!resolvedTask.found) throw new VerificationContextError(resolvedTask.error);
        const fetched = fetchGitHubTaskBody({
          issue: resolvedTask.issue.number,
          repo: snapshot.repo,
          commandRunner: resolveGhRunner(io),
          projectMapConfig: projectConfig,
        });
        const inventoriedIssue = snapshot.issues.find(issue => Number(issue?.number) === Number(resolvedTask.issue.number));
        if (!inventoriedIssue || fetched.body !== String(inventoriedIssue.body ?? '')) {
          throw new VerificationContextStaleError(`GitHub task '${taskId}' changed during authoritative inventory refetch`);
        }
        return {
          backend: 'github', taskId, carrier: `issue:${resolvedTask.issue.number}`,
          body: fetched.body, digest: fetched.digest,
          trustedRecords: fetched.trustedRecords,
          trustedRecordErrors: fetched.trustedRecordErrors,
        };
      };
      let derivedSources;
      try {
        derivedSources = opts.packet || advancedInput ? null : dispatchSourcesFromDurableState(target, taskId);
      } catch (error) {
        return printGateResult('task prepare-dispatch', commandFailure('task prepare-dispatch', error, 'operational_error', {}, target), asJson, io);
      }
      const refetchReadiness = ({ snapshot }) => refetchDispatchReadiness(
        target,
        snapshot,
        derivedSources?.readiness ?? input?.readiness ?? packet?.readiness
      );
      const refetchRepository = ({ readiness }) => refetchDispatchRepository(target, readiness);
      const refetchDecomposition = ({ snapshot }) => refetchDispatchDecomposition(
        target,
        derivedSources?.decomposition ?? input?.decomposition ?? packet?.decomposition,
        snapshot.taskId
      );
      const refetchParallelScanInventory = ({ decomposition }) => refetchDispatchParallelScanInventory(
        backend,
        backend === 'files'
          ? () => enumerateFilesTaskInventory(target, projectConfig)
          : () => currentGitHubSnapshot().normalized,
        decomposition
      );
      const readCarrierDigest = relPath => {
        if (backend === 'github' && String(relPath).startsWith('issue:')) {
          return currentGitHubSnapshot().normalized.members.find(member => member.carrier === relPath)?.digest ?? null;
        }
        const carrierPath = resolve(target, String(relPath));
        if (!existsSync(carrierPath)) return null;
        return taskRecordDigest(readFileSync(carrierPath, 'utf8'));
      };
      // Activation is read from the task's own durable provenance, never from
      // the dispatch request, and it resolves in one fixed order:
      //
      //   1. a current valid legacy host-signed task capture;
      //   2. a current valid task activation binding;
      //   3. otherwise blocked.
      //
      // The legacy path stays first so an existing activation-bound project
      // behaves exactly as before, with no change to any task record.
      const refetchActivationEvidence = ({ snapshot }) => {
        const contract = taskContractDigest(snapshot.body);
        if (!contract.ok) throw new VerificationContextMalformedError(contract.error);
        const ref = contract.projection.activation_capture_ref;
        if (ref) {
          const capture = readActivationCaptureInput(target, ref, capabilities, snapshot.taskId);
          if (capture.normalizedActivationDigest !== contract.projection.activation_input_digest) {
            throw new VerificationContextStaleError(
              `activation capture '${ref}' no longer matches the task contract activation_input_digest`
            );
          }
          return { source: 'legacy_task_capture', capture };
        }
        const evidence = loadTaskActivationEvidence(target, {
          backend: snapshot.backend,
          taskId: snapshot.taskId,
        });
        if (!evidence) throw unactivatedTaskError(snapshot.taskId);
        return evidence;
      };
      let activationVerification;
      let assurancePolicy;
      try {
        activationVerification = resolveActivationVerification(target, io, {
          hostTrustStorePath: opts.hostTrustStore,
        });
        const resolvedPolicy = resolveEffectiveActivationPolicy(target, io);
        assurancePolicy = { mode: resolvedPolicy.mode, policySource: resolvedPolicy.source };
      } catch (error) {
        return printGateResult('task prepare-dispatch', commandFailure('task prepare-dispatch', error, 'operational_error', {}, target), asJson, io);
      }
      const dispatchOptions = {
        capabilities,
        hostRoleCapabilities,
        assurancePolicy,
        verifyActivationSignature: activationVerification.verify,
        resolveActivationBinding: candidate => resolvePacketActivationBinding(target, io, candidate, {
          hostTrustStorePath: opts.hostTrustStore,
        }),
      };
      const eligibleReturnAdapters = Object.values(activationVerification.adapters ?? {})
        .filter(adapter => adapter.capabilities?.returnReceipt === 'supported');
      if (opts.returnAdapter) {
        const selected = eligibleReturnAdapters.find(adapter => adapter.adapterId === String(opts.returnAdapter));
        if (!selected) {
          const error = new VerificationContextError(`return adapter '${String(opts.returnAdapter)}' is not an authenticated protected-boundary adapter with returnReceipt support`);
          return printGateResult('task prepare-dispatch', commandFailure('task prepare-dispatch', error, 'operational_error', {}, target), asJson, io);
        }
        dispatchOptions.returnAdapter = { adapterId: selected.adapterId, keyId: selected.keyId, capability: 'returnReceipt' };
      } else if (assurancePolicy.mode === 'hardened') {
        if (eligibleReturnAdapters.length > 1) {
          const detail = 'multiple authenticated returnReceipt adapters are available; select one with --return-adapter <adapter-id>';
          return printGateResult('task prepare-dispatch', commandFailure('task prepare-dispatch', new VerificationContextError(detail), 'operational_error', {}, target), asJson, io);
        }
        const selected = eligibleReturnAdapters[0] ?? null;
        dispatchOptions.returnAdapter = selected
          ? { adapterId: selected.adapterId, keyId: selected.keyId, capability: 'returnReceipt' }
          : null;
      } else {
        dispatchOptions.returnAdapter = null;
      }
      const stateInputs = {
        runGit: targetGitRunner(target),
        priorGateReceipts,
        readCarrierDigest,
        refetchActivationEvidence,
        refetchParallelScanInventory,
      };
      let packet = null;
      let prepared;
      if (opts.packet) {
        try {
          packet = readJson(opts.packet, 'dispatch packet');
        } catch (error) {
          return printGateResult('task prepare-dispatch', commandFailure('task prepare-dispatch', error, 'operational_error', {}, target), asJson, io);
        }
        prepared = verifyDispatchBeforeMutation({
          packet,
          refetchTask,
          refetchReadiness,
          refetchRepository,
          refetchDecomposition,
          ...stateInputs,
          roleId: opts.role,
        }, dispatchOptions);
      } else {
        // Packet conservation, asked only when a *new* packet is being minted.
        // Re-validating an existing packet (`--packet`) is how a live attempt
        // proves itself and must never be refused here.
        //
        // Without this, a fresh packet silently replaced the one an
        // Engineer had already built against, until no retained packet
        // represented the start of the work that existed. The attempt reaches a
        // canonical return or is explicitly abandoned.
        const conservation = evaluateTaskPacketConservation(target, taskId, { backend });
        if (!conservation.ok) {
          const error = new PublicCommandError(conservation.reason, {
            code: PACKET_CONSERVATION_DIAGNOSTIC_CODE,
            evidenceState: 'negative',
            disposition: 'blocked',
            committedStateEvaluated: true,
            publicMessage: conservation.reason,
            safeRepair: conservation.repair,
          });
          return printGateResult(
            'task prepare-dispatch',
            commandFailure('task prepare-dispatch', error, 'operational_error', { task_id: taskId }, target),
            asJson, io
          );
        }
        let assignment;
        try {
          const readinessSource = derivedSources?.readiness ?? input?.readiness;
          const repository = refetchDispatchRepository(target, {
            evidence: { base: { identity: readinessSource?.evidence?.base?.revalidationArgs?.[1]?.startsWith('git-tree:')
              ? readinessSource.evidence.base.revalidationArgs[1]
              : `git-tree:${readinessSource?.evidence?.base?.revalidationArgs?.[1] ?? ''}` } },
          });
          assignment = advancedInput && input?.assignment
            ? input.assignment
            : dispatchAssignmentFromCurrentFacts({
                taskId,
                host: opts.host,
                repository,
                backend,
                hostRoleCapabilities,
              });
        } catch (error) {
          return printGateResult('task prepare-dispatch', commandFailure('task prepare-dispatch', error, 'operational_error', {}, target), asJson, io);
        }
        prepared = prepareRoleDispatch({
          refetchTask,
          refetchReadiness,
          refetchRepository,
          refetchDecomposition,
          ...stateInputs,
          activation: input?.activation,
          assignment,
        }, dispatchOptions);
      }
      const presentedValidation = presentGateResultForTarget(prepared.validation, target);
      const outputPath = prepared.ok && !opts.packet && opts.output
        ? writeTargetJson(target, opts.output, prepared.packet)
        : null;
      if (asJson) {
        if (prepared.ok && opts.packet) printGateResult('task prepare-dispatch', presentedValidation, true, io);
        else if (prepared.ok && outputPath) io.out(JSON.stringify(artifactSuccess({
          taskId, outputPath, artifact: prepared.packet, assuranceGrade: prepared.packet.assurance.activation,
        })));
        else if (prepared.ok) io.out(JSON.stringify(prepared.packet, null, 2));
        else printGateResult('task prepare-dispatch', presentedValidation, true, io);
      }
      else if (prepared.ok) io.out(JSON.stringify(prepared.packet, null, 2));
      else {
        for (const error of prepared.validation.errors) io.err(error);
        // The typed first safe repair is the actionable half of a blocked
        // dispatch - for an unactivated task it is the literal
        // `npx agenticloop activate <task-id>` command - so human output shows
        // it rather than leaving it visible only in `--json`.
        if (presentedValidation.firstSafeRepair) io.err(`first safe repair: ${presentedValidation.firstSafeRepair}`);
      }
      // stdout stays exactly one packet document so it can be piped. The two
      // assurance grades go to stderr, where a human sees them without a reader
      // having to dig them out of the packet.
      if (prepared.ok && !asJson) printDispatchAssurance(prepared.packet?.assurance ?? packet?.assurance, io);
      return prepared.ok ? 0 : 1;
      }

    if (sub === 'handoff-preflight') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId) {
        const error = new CliUsageError('task handoff-preflight requires <id>');
        return printGateResult('task handoff-preflight', commandFailure('task handoff-preflight', error, 'usage', {}, target), asJson, io, EXIT_USAGE);
      }
      let result;
      try {
        result = evaluateHandoffPreflight({
          target,
          taskId,
          backend: selectedBackend.backend,
          projectConfig,
          io,
          host: opts.host,
          hostTrustStore: opts.hostTrustStore,
          returnAdapter: opts.returnAdapter,
        });
      } catch (error) {
        return printGateResult('task handoff-preflight',
          commandFailure('task handoff-preflight', error, 'operational_error', {}, target), asJson, io);
      }
      let refreshPlan = null;
      let refreshPlanPath = null;
      let refreshPlanRefusal = null;
      if (opts.repairPlan) {
        if (result.backend !== 'files') {
          // Derived-evidence refresh is files-only. A GitHub (or other non-files)
          // preflight is still a valid, useful verdict, so do not discard it:
          // emit the preflight normally and attach a typed refusal explaining the
          // plan was not produced. The exit code reflects the preflight verdict.
          refreshPlanRefusal = {
            ...createDiagnostic({
              code: 'handoff.refresh.plan.unsupported',
              message: `derived-evidence refresh plans apply only to the files backend; the '${result.backend}' backend has no local derived-evidence surface to refresh`,
              evidence: { state: 'unsupported', backend: result.backend, supplied: false },
              repairHint: 'Rerun task handoff-preflight without --repair-plan; derived-evidence refresh applies only to the files backend.',
            }),
            owner: 'maintainer',
          };
        } else {
          try {
            refreshPlan = createHandoffEvidenceRefreshPlan({ target, preflight: result });
            refreshPlanPath = writeTargetJson(target, opts.repairPlan, refreshPlan);
          } catch (error) {
            return printGateResult('task handoff-preflight',
              commandFailure('task handoff-preflight', error, 'operational_error', {}, target), asJson, io);
          }
        }
      }
      // --output: atomically write the result JSON to a target-relative path.
      const refreshPlanFields = {
        ...(refreshPlan ? {
          refreshPlan,
          refreshPlanPath: relative(target, refreshPlanPath).replace(/\\/g, '/'),
        } : {}),
        ...(refreshPlanRefusal ? { refreshPlanRefusal } : {}),
      };
      if (opts.output) {
        try {
          writeTargetJson(target, opts.output, { ...result, ...refreshPlanFields });
        } catch (error) {
          return printGateResult('task handoff-preflight',
            commandFailure('task handoff-preflight', error, 'operational_error', {}, target), asJson, io);
        }
      }
      if (asJson) {
        // Emit the closed domain schema directly; the evaluator result already
        // carries the one canonical presentation applied at evaluation time.
        io.out(JSON.stringify({ ...result, ...refreshPlanFields }, null, 2));
      } else {
        io.out();
        io.out(`agenticloop task handoff-preflight ${taskId}`);
        io.out('='.repeat(50));
        io.out(`  task: ${result.taskId}`);
        io.out(`  backend: ${result.backend}`);
        io.out(`  carrier: ${result.carrier}`);
        io.out(`  carrier digest: ${result.carrierDigest ?? '(unavailable)'}`);
        io.out(`  contract digest: ${result.contractDigest ?? '(unavailable)'}`);
        io.out(`  operator authorization: ${result.operatorAuthorization}`);
        if (result.activation) {
          io.out(`  activation: ${result.activation.source} (${result.activation.assurance})`);
          io.out(`  policy: ${result.activation.policyMode} (${result.activation.policySource})`);
          io.out(`  activation usability: ${result.activation.usability}`);
        } else {
          io.out('  activation: none');
        }
        if (result.readiness) {
          io.out(`  readiness: ${result.readiness.ok ? 'pass' : 'FAIL'} (${result.readiness.evidenceState})`);
        }
        if (result.decomposition) {
          io.out(`  decomposition: ${result.decomposition.dispatchCompatible ? 'dispatchable' : 'NOT dispatchable'}`);
          io.out(`  decomposition source: ${result.decomposition.sourceRef}`);
          io.out(`  maintainer attribution: ${result.decomposition.maintainerAttribution}`);
          io.out(`  inventory complete: ${result.decomposition.inventoryComplete}`);
          io.out(`  base mode: ${result.decomposition.baseMode}`);
        } else {
          io.out('  decomposition: none');
        }
        if (result.repository) {
          io.out(`  worktree: ${result.repository.worktree}`);
          io.out(`  branch: ${result.repository.branch ?? '(detached)'}`);
          io.out(`  HEAD: ${result.repository.head}`);
          io.out(`  product base: ${result.repository.productBase ?? '(none)'}`);
        }
        io.out(`  clean state: ${result.cleanState}`);
        if (result.hostRoleCapability) {
          io.out(`  host-role: ${result.hostRoleCapability.host}/${result.hostRoleCapability.roleId}`);
        }
        if (result.returnAdapter) {
          io.out(`  return adapter: ${result.returnAdapter.state}${result.returnAdapter.adapter ? ` (${result.returnAdapter.adapter.adapterId})` : ''}`);
        }
        if (result.siblingCollisions.length > 0) {
          io.out('  sibling collisions:');
          for (const collision of result.siblingCollisions) {
            io.out(`    ${collision.worktreePath}: ${collision.reason}`);
          }
        }
        io.out(`  status: ${result.ok ? 'READY' : 'BLOCKED'}`);
        io.out(`  disposition owner: ${result.dispositionOwner ?? '(none)'}`);
        // A green preflight is a claim about a sequence, not about an instant.
        // Printing the sequence - with the commits each step forces - is what
        // keeps it from being a green that its own next action invalidates.
        if (result.nextSequence?.steps?.length) {
          for (const line of renderHandoffSequence(result.nextSequence)) io.out(line);
        }
        if (opts.output) io.out(`  output: ${relative(target, resolve(target, opts.output)).replace(/\\/g, '/')}`);
        if (refreshPlanPath) io.out(`  refresh plan: ${relative(target, refreshPlanPath).replace(/\\/g, '/')}`);
        if (refreshPlanRefusal) {
          io.warn(`  WARN: ${refreshPlanRefusal.message}`);
          io.out(`  refresh plan: unsupported (${refreshPlanRefusal.owner}; ${refreshPlanRefusal.repairHint})`);
        }
        for (const warning of result.warnings ?? []) io.warn(`  WARN: ${warning}`);
        for (const error of result.errors ?? []) io.err(`  ERROR: ${error}`);
        if (result.firstSafeRepair) io.out(`  first safe repair: ${result.firstSafeRepair}`);
        io.out();
      }
      return result.ok ? 0 : 1;
    }

    if (sub === 'refresh-handoff-evidence') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId || !opts.plan || opts.yes !== true) {
        const error = new CliUsageError(
          'task refresh-handoff-evidence requires <id>, --plan <path>, and --yes; refresh is never implicit'
        );
        return printGateResult(
          'task refresh-handoff-evidence',
          commandFailure('task refresh-handoff-evidence', error, 'usage', {}, target),
          asJson,
          io,
          EXIT_USAGE
        );
      }
      try {
        const plan = readTargetJson(target, opts.plan, 'handoff refresh plan');
        const checkedPlan = validateHandoffRefreshPlan(plan, { target, taskId });
        if (!checkedPlan.ok) {
          const result = createValidationResult({
            command: 'task refresh-handoff-evidence',
            ok: false,
            evidenceState: 'malformed',
            disposition: 'rejected',
            diagnostics: checkedPlan.errors.map(message =>
              createDiagnostic({
                code: 'handoff.refresh.plan.malformed',
                message,
                evidence: { state: 'malformed', supplied: true, rollbackAuthorized: false },
              })
            ),
            firstSafeRepair: null,
          });
          return printGateResult('task refresh-handoff-evidence', result, asJson, io);
        }
        const current = evaluateHandoffPreflight({
          target,
          taskId,
          backend: selectedBackend.backend,
          projectConfig,
          io,
          hostTrustStore: opts.hostTrustStore,
        });
        const applied = applyHandoffEvidenceRefresh({ target, plan, preflight: current });
        if (asJson) {
          io.out(JSON.stringify(applied, null, 2));
        } else {
          io.out(`agenticloop task refresh-handoff-evidence ${taskId}`);
          io.out(`  status: ${applied.ok ? 'REFRESHED' : 'BLOCKED'}`);
          io.out(`  evidence: ${applied.evidenceState}`);
          io.out(`  disposition: ${applied.disposition}`);
          io.out(`  changed files: ${(applied.changedFiles ?? []).join(', ') || '(none)'}`);
          for (const error of applied.errors ?? []) io.err(`  ERROR: ${error}`);
          if (applied.firstSafeRepair) io.out(`  first safe repair: ${applied.firstSafeRepair}`);
        }
        return applied.ok ? 0 : 1;
      } catch (error) {
        return printGateResult(
          'task refresh-handoff-evidence',
          commandFailure('task refresh-handoff-evidence', error, 'operational_error', {}, target),
          asJson,
          io
        );
      }
    }

      if (['check-evidence-init', 'check-evidence-show', 'check-evidence-update'].includes(sub)) {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId || !opts.packet) {
        const error = new CliUsageError(`task ${sub} requires <id> and --packet <packet.json>`);
        return printGateResult(`task ${sub}`, commandFailure(`task ${sub}`, error, 'usage', {}, target), asJson, io, EXIT_USAGE);
        }
        try {
          const paths = checkEvidencePaths(
            target,
            opts.packet,
            sub === 'check-evidence-init' ? null : opts.input,
            opts.output ?? null,
            sub === 'check-evidence-update' ? opts.executionOutput ?? null : null,
          );
          const packet = readTargetJson(target, paths.packet.relPath, 'dispatch packet');
          const current = validateConsumedCheckEvidencePacket(
            target, projectConfig, taskId, packet, io, opts.hostTrustStore,
          );
          if (sub === 'check-evidence-init') {
            if (!opts.output) throw new CliUsageError('task check-evidence-init requires --output <path>');
            const checks = packet.task.requiredChecks.map(required => ({
            id: required.id,
            kind: required.kind,
            ...(required.kind === 'command'
              ? { command: required.command, exitCode: -1, executionEvidence: null }
              : { instruction: required.instruction, exitCode: null }),
              outcome: 'not_run',
              evidence: 'not yet recorded',
            }));
            const outputPath = writeTargetJson(target, paths.output.relPath, checks);
            io.out(JSON.stringify(checkEvidenceSuccess({
              taskId, outputPath, checks, assuranceGrade: packet.assurance?.activation ?? 'unknown',
            })));
            return 0;
          }
          if (sub === 'check-evidence-show') {
            if (!opts.input) throw new CliUsageError('task check-evidence-show requires --input <path>');
            const checks = readTargetJson(target, paths.input.relPath, 'check evidence');
            const checked = validateRequiredCheckEvidence(checks, {
              contractVersion: packet.task.requiredCheckEvidenceContract,
            });
            if (!checked.ok || !requiredCheckEvidenceMatchesInventory(checks, packet.task.requiredChecks, {
              contractVersion: packet.task.requiredCheckEvidenceContract,
            })) {
              throw new VerificationContextMalformedError(`check evidence is invalid for the packet inventory: ${checked.errors.join('; ')}`);
            }
            validatePreparedCommandCheckExecutions(
              target,
              checked.checks,
              packet.task.requiredChecks,
              executionEvidenceBinding(target, projectConfig, taskId, packet, {
                body: current.body,
                contractDigest: current.contractDigest,
                currentCarrierDigest: current.currentCarrierDigest,
              }),
            );
            io.out(JSON.stringify(checked.checks, null, 2));
            return 0;
          }
        if (!opts.input || !opts.output || !opts.check || !opts.outcome || typeof opts.evidence !== 'string') {
          throw new CliUsageError('task check-evidence-update requires --input, --output, --check, --outcome, and --evidence');
        }
          const checks = readTargetJson(target, paths.input.relPath, 'check evidence');
          const priorChecks = validateRequiredCheckEvidence(checks, {
            contractVersion: packet.task.requiredCheckEvidenceContract,
          });
          if (!priorChecks.ok || !requiredCheckEvidenceMatchesInventory(checks, packet.task.requiredChecks, {
            contractVersion: packet.task.requiredCheckEvidenceContract,
          })) {
            throw new VerificationContextMalformedError(`check evidence is invalid for the packet inventory: ${priorChecks.errors.join('; ')}`);
          }
          const required = packet.task.requiredChecks.find(item => item.id === opts.check);
          if (!required) throw new VerificationContextMalformedError(`required check '${String(opts.check)}' is not in the packet inventory`);
          const validatePriorExecutions = () => validatePreparedCommandCheckExecutions(
            target,
            priorChecks.checks,
            packet.task.requiredChecks,
            executionEvidenceBinding(target, projectConfig, taskId, packet, {
              body: current.body,
              contractDigest: current.contractDigest,
              currentCarrierDigest: current.currentCarrierDigest,
            }),
          );
          let evidenceText = opts.evidence;
          let executionReference = null;
          let execution = null;
          if (required.kind === 'command' && opts.outcome === 'passed') {
          if (!opts.executionOutput) {
            throw new CliUsageError('a passed command check requires --execution-output <path>');
          }
          let parsed;
          try {
            parsed = parseRequiredCheckCommand(required.command);
          } catch (error) {
            throw new VerificationContextMalformedError(
              `required command check '${required.id}' is not safe inert argv: ${error.message}`
            );
          }
          // Refuse a missing execution selector or unsafe argv before requiring
          // unrelated product-artifact state, but still validate every prior
          // closed execution record before this command can be spawned.
          validatePriorExecutions();
          // This is the public trust boundary. The command text came from the
          // packet's authenticated inventory; the CLI parses and executes that
          // exact text itself, then persists the actual argv and child result.
            execution = produceExecutionEvidence({
            checkId: required.id,
            instruction: required.command,
            command: parsed.command,
            args: parsed.args,
            carrierRoot: target,
            artifactWorktreeRoot: target,
            workingDirectory: target,
            projectScratchRoot: join(target, '.agenticloop', 'tmp'),
            binding: executionEvidenceBinding(target, projectConfig, taskId, packet, {
              body: current.body,
              contractDigest: current.contractDigest,
              currentCarrierDigest: current.currentCarrierDigest,
            }),
          }, { run: io.requiredCheckCommandRunner ?? requiredCheckCommandRunner });
          if (execution.execution.outcome !== 'passed' || execution.execution.childExitCode !== 0) {
            throw new VerificationContextError(
              `required command check '${required.id}' did not pass (outcome ${execution.execution.outcome}, exit ${String(execution.execution.childExitCode)})`
            );
          }
          evidenceText = `${evidenceText}\nExecution evidence: ${execution.digest}\nExecution artifact: ${paths.execution.relPath}`;
          executionReference = {
            path: paths.execution.relPath,
            digest: execution.digest,
          };
        }
        if (required.kind !== 'command' || opts.outcome !== 'passed') validatePriorExecutions();
        const updated = checks.map(check => check?.id === required.id ? {
          id: required.id,
          kind: required.kind,
          ...(required.kind === 'command'
            ? { command: required.command, exitCode: opts.outcome === 'passed' ? 0 : Number(opts.exitCode) }
            : { instruction: required.instruction, exitCode: null }),
          outcome: opts.outcome,
          evidence: evidenceText,
          ...(required.kind === 'command' ? { executionEvidence: executionReference } : {}),
        } : check);
        const checked = validateRequiredCheckEvidence(updated, {
          contractVersion: packet.task.requiredCheckEvidenceContract,
        });
        if (!checked.ok || !requiredCheckEvidenceMatchesInventory(updated, packet.task.requiredChecks, {
          contractVersion: packet.task.requiredCheckEvidenceContract,
        })) {
          throw new VerificationContextMalformedError(`updated check evidence is invalid: ${checked.errors.join('; ')}`);
        }
        writeCheckEvidenceUpdate(target, executionReference === null ? null : execution, paths.execution, checked.checks, paths.output);
        const outputPath = paths.output.path;
        io.out(JSON.stringify(checkEvidenceSuccess({
          taskId, outputPath, checks: checked.checks, assuranceGrade: packet.assurance?.activation ?? 'unknown',
        })));
        return 0;
      } catch (error) {
        return printGateResult(`task ${sub}`, commandFailure(`task ${sub}`, error, error instanceof CliUsageError ? 'usage' : 'operational_error', {}, target), asJson, io, error instanceof CliUsageError ? EXIT_USAGE : 1);
      }
    }

    if (sub === 'prepare-return') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      const cancellationClaim = opts.outcome === 'implementation_blocked';
      if (!taskId || !opts.packet || !opts.checkEvidence || !opts.output ||
          !['implementation_ready_for_review', 'implementation_blocked'].includes(opts.outcome) ||
          (cancellationClaim && (opts.blockerCategory !== 'cancellation_requested' || !opts.cancellationEvidence)) ||
          (!cancellationClaim && (opts.blockerCategory !== undefined || opts.cancellationEvidence !== undefined))) {
        const error = new CliUsageError(
          'task prepare-return requires <id>, --packet <packet.json>, --check-evidence <path>, --output <path>, and either ' +
          '--outcome implementation_ready_for_review or --outcome implementation_blocked ' +
          '--blocker-category cancellation_requested --cancellation-evidence <path>'
        );
        return printGateResult('task prepare-return', commandFailure('task prepare-return', error, 'usage', {}, target), asJson, io, EXIT_USAGE);
      }
      try {
        const packet = readTargetJson(target, opts.packet, 'dispatch packet');
        // Full revalidation belongs at role start, where the packet's initial
        // repository head must still be current. A return necessarily follows
        // Engineer product commits, so it instead authenticates the packet and
        // proves its exact already-consumed invocation through carrier lineage.
        const capabilities = resolveActivationCapabilities(target, io, opts.hostTrustStore);
        const hostRoleCapabilities = resolveEffectiveHostRoleCapabilities(target);
        const activationVerification = resolveActivationVerification(target, io, {
          hostTrustStorePath: opts.hostTrustStore,
        });
        const activationPolicy = resolveEffectiveActivationPolicy(target, io);
        const dispatch = validateDispatchPreparation(packet, {
          capabilities,
          hostRoleCapabilities,
          assurancePolicy: { mode: activationPolicy.mode, policySource: activationPolicy.source },
          verifyActivationSignature: activationVerification.verify,
          resolveActivationBinding: candidate => resolvePacketActivationBinding(target, io, candidate, {
            hostTrustStorePath: opts.hostTrustStore,
          }),
        });
        if (!dispatch.ok) {
          throw new VerificationContextMalformedError(
            `dispatch packet is not authentic for return production: ${dispatch.errors.join('; ')}`
          );
        }
        if (packet.backend !== 'files') {
          throw new VerificationContextMalformedError('prepare-return supports the files backend only');
        }
        const checks = readTargetJson(target, opts.checkEvidence, 'check evidence');
        if (packet?.backend !== 'files' || packet?.task?.id !== taskId || !requiredCheckEvidenceMatchesInventory(
          checks,
          packet?.task?.requiredChecks,
          { contractVersion: packet?.task?.requiredCheckEvidenceContract }
        )) {
          const absentArtifact = Array.isArray(checks) && checks.find(check =>
            check?.kind === 'command' && check?.outcome === 'passed' && !Object.hasOwn(check, 'executionEvidence')
          );
          if (absentArtifact) {
            throw new VerificationContextMalformedError(
              `passed command check '${absentArtifact.id}' requires a closed CLI execution artifact path and digest (executionEvidence)`
            );
          }
          throw new VerificationContextMalformedError('packet and check evidence do not define one valid files-backed required-check inventory');
        }
        const checkedEvidence = validateRequiredCheckEvidence(checks, {
          label: 'check evidence', contractVersion: packet?.task?.requiredCheckEvidenceContract,
        });
        const filePath = taskPathForId(target, projectConfig, taskId);
        if (!existsSync(filePath)) throw new VerificationContextMalformedError(`task record not found: ${relative(target, filePath).replace(/\\/g, '/')}`);
        const body = readFileSync(filePath, 'utf8');
        const contract = taskContractDigest(body);
        const currentCarrierDigest = taskRecordDigest(body);
        const lineage = resolveCarrierLineage(target, taskId, {
          backend: 'files', taskContractDigest: contract.digest, currentCarrierDigest,
        });
        if (!lineage.ok ||
            lineage.dispatchConsumption.packetId !== packet.packetId ||
            lineage.dispatchConsumption.packetDigest !== packet.digest ||
            lineage.dispatchConsumption.invocationId !== packet.assignment.invocationId ||
            lineage.dispatchCarrierDigest !== packet.task.dispatchCarrierDigest) {
          throw new VerificationContextStaleError(
            `current dispatch consumption and carrier lineage do not bind the exact packet invocation: ${lineage.errors?.join('; ') || 'identity mismatch'}`
          );
        }
        const productHead = implementationArtifactHead(body);
        if (!contract.ok || (!cancellationClaim && !isGitObjectId(productHead))) {
          throw new VerificationContextMalformedError('current task facts lack a valid committed implementation_artifact product head');
        }
        // A cancellation claim is only ever an Agentic Loop-controlled
        // observation bound to the exact consumed invocation. Host idle,
        // completion, termination, or stop-reason state is never consulted.
        let cancellation = null;
        if (cancellationClaim) {
          const provenance = readTargetJson(target, opts.cancellationEvidence, 'cancellation evidence');
          const provenanceCheck = validateAuthoritativeCancellationProvenance(provenance);
          if (!provenanceCheck.ok) {
            throw cancellationEvidenceError(provenanceCheck.errors, 'cancellation evidence is not a usable Agentic Loop-controlled observation');
          }
          if (provenance.invocation.invocationId !== packet.assignment.invocationId) {
            throw new VerificationContextMalformedError('cancellation evidence does not bind the consumed packet invocation');
          }
          cancellation = provenance;
        }
        validatePreparedCommandCheckExecutions(target, checks, packet.task.requiredChecks, executionEvidenceBinding(target, projectConfig, taskId, packet, {
          body, contractDigest: contract.digest, currentCarrierDigest,
          productHead: isGitObjectId(productHead) ? productHead : packet.repository.head,
        }));
        if (!checkedEvidence.ok) {
          throw new VerificationContextMalformedError(
            `check evidence does not satisfy the authenticated required-check evidence contract: ${checkedEvidence.errors.join('; ')}`
          );
        }
        const evidence = refetchFilesReturnEvidence(target, packet, {
          productHead: isGitObjectId(productHead) ? productHead : packet.repository.head,
          checks,
          task: { currentCarrierDigest },
        });
        const roleReturn = createRoleReturn({
          producerRole: 'engineer',
          packet: { packetId: packet.packetId, digest: packet.digest },
          task: {
            backend: 'files', id: taskId, taskContractDigest: contract.digest,
            dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
            currentCarrierDigest,
          },
          worktree: evidence.worktree,
          branch: evidence.branch,
          productBaseHead: evidence.productBaseHead,
          productLineage: evidence.productLineage,
          productHead: evidence.productHead,
          workflowHead: evidence.workflowHead,
          candidateHead: null,
          productChangedPaths: evidence.productChangedPaths,
          workflowChangedPaths: evidence.workflowChangedPaths,
          checks,
          productAttribution: evidence.productAttribution,
          pr: evidence.pr,
          carrierLineage: evidence.carrierLineage,
          outcome: cancellationClaim
            ? { kind: 'implementation_blocked', completion: false, authority: 'non_authoritative_role_outcome' }
            : { kind: 'implementation_ready_for_review', completion: false, authority: 'non_authoritative_role_outcome' },
          disposition: cancellationClaim ? 'blocked' : 'proceed',
          blocker: cancellationClaim
            ? {
                category: 'cancellation_requested',
                evidence: { kind: CANCELLATION_PROVENANCE_KIND, detail: cancellation.digest },
                resumeOwner: 'engineer',
                resumeTransition: 'implementation_resume',
                resumePreconditions: {
                  items: ['Issue a fresh dispatch packet for the unchanged task contract before resuming.'],
                  justification: null,
                },
              }
            : null,
          freshness: { invalidatedBy: packet.freshness.invalidatedBy },
        });
        const outputPath = writeTargetJson(target, opts.output, roleReturn);
        io.out(JSON.stringify(artifactSuccess({
          taskId, outputPath, artifact: roleReturn,
          assuranceGrade: lineage.dispatchConsumption.assuranceGrade,
        })));
        return 0;
      } catch (error) {
        return printGateResult('task prepare-return', commandFailure('task prepare-return', error, 'operational_error', {}, target), asJson, io);
      }
    }

    if (sub === 'verify-return') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId || !opts.packet || !opts.return) {
        const error = new CliUsageError('task verify-return requires <id>, --packet <packet.json>, and --return <role-return.json>');
        return printGateResult('task verify-return', commandFailure('task verify-return', error, 'usage', {}, target), asJson, io, EXIT_USAGE);
      }
      const readJsonText = (relPath, label) => readTargetText(target, relPath, label);
      let packet;
      let raw;
      let repositoryEvidence = null;
      let producerReceipt = null;
      let redelegationAuthority = null;
      let recovery = null;
      let humanDisposition = null;
      let exceptionalVerification = null;
      let exceptionalReceipt = null;
      let executionReceipt = null;
      let capabilities;
      let hostRoleCapabilities;
      let workflowRoleRegistry;
      let returnPolicy;
      let activationVerification;
      try {
        packet = JSON.parse(readJsonText(opts.packet, 'dispatch packet'));
        raw = readJsonText(opts.return, 'role return');
        capabilities = resolveActivationCapabilities(target, io, opts.hostTrustStore);
        hostRoleCapabilities = resolveEffectiveHostRoleCapabilities(target);
        workflowRoleRegistry = resolveEffectiveWorkflowRegistry(target);
        returnPolicy = resolveEffectiveActivationPolicy(target, io);
        if (opts.repositoryEvidence && opts.fromCurrentRepository) {
          throw new CliUsageError('task verify-return accepts exactly one of --repository-evidence <path> or --from-current-repository');
        }
        repositoryEvidence = opts.repositoryEvidence
          ? JSON.parse(readJsonText(opts.repositoryEvidence, 'repository evidence'))
          : null;
        producerReceipt = opts.producerReceipt
          ? JSON.parse(readJsonText(opts.producerReceipt, 'producer receipt'))
          : null;
        redelegationAuthority = opts.redelegationAuthority
          ? JSON.parse(readJsonText(opts.redelegationAuthority, 'redelegation authority'))
          : null;
        recovery = opts.recoveryRequest
          ? JSON.parse(readJsonText(opts.recoveryRequest, 'recovery request'))
          : null;
        humanDisposition = opts.humanDisposition
          ? JSON.parse(readJsonText(opts.humanDisposition, 'human disposition'))
          : null;
        exceptionalVerification = opts.exceptionalVerification
          ? JSON.parse(readJsonText(opts.exceptionalVerification, 'exceptional verification'))
          : null;
        exceptionalReceipt = opts.exceptionalReceipt
          ? JSON.parse(readJsonText(opts.exceptionalReceipt, 'exceptional verification receipt'))
          : null;
        executionReceipt = opts.executionReceipt
          ? JSON.parse(readJsonText(opts.executionReceipt, 'execution receipt'))
          : null;
      } catch (error) {
        return printGateResult('task verify-return', commandFailure('task verify-return', error, error instanceof CliUsageError ? 'usage' : 'operational_error', {}, target), asJson, io, error instanceof CliUsageError ? EXIT_USAGE : 1);
      }
      const hasHumanDispositionSelector =
        opts.humanDispositionAuthority !== undefined ||
        opts.humanDispositionKeyId !== undefined;
      if (humanDisposition !== null) {
        if (recovery === null ||
            opts.humanDispositionAuthority === undefined ||
            opts.humanDispositionKeyId === undefined) {
          io.err(
            'task verify-return requires --recovery-request, --human-disposition-authority, ' +
            'and --human-disposition-key-id with --human-disposition'
          );
          return EXIT_USAGE;
        }
        if (humanDisposition?.authentication?.authorityId !== opts.humanDispositionAuthority ||
            humanDisposition?.authentication?.keyId !== opts.humanDispositionKeyId) {
          const error = new VerificationContextMalformedError(
            'human-disposition authentication does not match the explicitly selected authorityId and keyId'
          );
          return printGateResult(
            'task verify-return',
            commandFailure('task verify-return', error, 'operational_error', {}, target),
            asJson,
            io
          );
        }
      } else if (hasHumanDispositionSelector) {
        io.err(
          '--human-disposition-authority and --human-disposition-key-id require --human-disposition'
        );
        return EXIT_USAGE;
      }
      const backend = selectedBackend.backend;
      if (backend === 'files' && repositoryEvidence) {
        const repositoryChecks = validateRequiredCheckEvidence(repositoryEvidence.checks, {
          label: 'repository evidence',
        });
        if (!repositoryChecks.ok) {
          const artifactCheck = Array.isArray(repositoryEvidence.checks) && repositoryEvidence.checks.find(check =>
            check?.kind === 'command' && Object.hasOwn(check, 'executionEvidence')
          );
          if (artifactCheck) {
            throw new VerificationContextMalformedError(
              `repository evidence command check '${artifactCheck.id}' must not carry an execution artifact reference (executionEvidence)`
            );
          }
          throw new VerificationContextMalformedError(
            `repository evidence does not satisfy the baseline required-check observation grammar: ${repositoryChecks.errors.join('; ')}`
          );
        }
      }
      const filePath = backend === 'files' ? taskPathForId(target, projectConfig, taskId) : null;
      const carrier = filePath ? relative(target, filePath).replace(/\\/g, '/') : null;
      let githubSnapshot = null;
      const currentGitHubSnapshot = () => {
        if (!githubSnapshot) githubSnapshot = enumerateGitHubTaskInventory(projectConfig, io, { repo: opts.repo });
        return githubSnapshot;
      };
      const refetchTask = () => {
        if (backend === 'files') {
          if (!existsSync(filePath)) throw new VerificationContextError(`task record not found: ${carrier}`);
          const body = readFileSync(filePath, 'utf8');
          const history = loadFilesTaskContractRecords(target, taskId);
          return { backend: 'files', taskId, carrier, body, digest: taskRecordDigest(body), trustedRecords: history.trustedRecords, trustedRecordErrors: history.errors };
        }
        const snapshot = currentGitHubSnapshot();
        const resolvedTask = resolveCoveredGitHubTask(snapshot.identityInventory, taskId);
        if (!resolvedTask.found) throw new VerificationContextError(resolvedTask.error);
        const fetched = fetchGitHubTaskBody({
          issue: resolvedTask.issue.number,
          repo: snapshot.repo,
          commandRunner: resolveGhRunner(io),
          projectMapConfig: projectConfig,
        });
        return {
          backend: 'github', taskId, carrier: `issue:${resolvedTask.issue.number}`,
          body: fetched.body, digest: fetched.digest,
          trustedRecords: fetched.trustedRecords,
          trustedRecordErrors: fetched.trustedRecordErrors,
        };
      };
      let verifiedRepositoryEvidence = null;
      // `--from-current-repository` is files-only. The verification boundary
      // rederives Git topology from the live repository, takes the product head
      // and carrier digest from the exact current task carrier, and takes only
      // the required-check observations from the producing role's return -
      // caller-authored repository evidence is never current authority.
      if (opts.fromCurrentRepository && backend !== 'files') {
        const error = new CliUsageError(
          'task verify-return --from-current-repository is supported for the files backend only; ' +
          'the GitHub backend requires --repository-evidence authenticated at the protected boundary'
        );
        return printGateResult('task verify-return', commandFailure('task verify-return', error, 'usage', {}, target), asJson, io, EXIT_USAGE);
      }
      const refetchRepositoryEvidence = repositoryEvidence
        ? () => {
            verifiedRepositoryEvidence = backend === 'github'
              ? refetchGitHubReturnEvidence(repositoryEvidence, {
                  commandRunner: resolveGhRunner(io),
                  repo: opts.repo ?? currentGitHubSnapshot().repo,
                })
              : refetchFilesReturnEvidence(target, packet, repositoryEvidence);
            return verifiedRepositoryEvidence;
          }
        : opts.fromCurrentRepository
          ? () => {
              const body = readFileSync(filePath, 'utf8');
              let returnChecks;
              try { returnChecks = JSON.parse(raw)?.checks; } catch { returnChecks = undefined; }
              verifiedRepositoryEvidence = refetchFilesReturnEvidence(target, packet, {
                productHead: implementationArtifactHead(body) ?? packet?.repository?.head,
                checks: returnChecks,
                task: { currentCarrierDigest: taskRecordDigest(body) },
              });
              return verifiedRepositoryEvidence;
            }
          : null;
      // Verification consumes only the operator-pinned public key. No signing
      // secret is read from the environment, so an agent invoking this command
      // cannot mint a receipt for itself. The raw receipt travels into the
      // core boundary, which authenticates it against the pinned adapter
      // itself; this wrapper never claims verification happened.
      const received = receiveRoleReturn({
        raw,
        packet,
        refetchTask,
        refetchRepositoryEvidence,
        refetchCarrierLineage: ({ snapshot }) => {
          const contract = taskContractDigest(snapshot.body);
          return resolveCarrierLineage(target, taskId, {
            backend, taskContractDigest: contract.ok ? contract.digest : null,
            currentCarrierDigest: snapshot.digest,
          });
        },
        producerReceipt,
        resolveTrustedAdapter: adapterId => resolveTrustedHostAdapter(target, io, opts.hostTrustStore, adapterId),
        requestedOwner: opts.resumeOwner,
        redelegationAuthority,
        recovery,
        humanDisposition,
        exceptionalVerification,
        exceptionalReceipt,
        resolveTrustedAuthority: (authorityId, authorityKind) => {
          const selectedAuthorityId = authorityKind === 'human_disposition'
            ? opts.humanDispositionAuthority
            : authorityId;
          const authority = resolveTrustedBlockedAuthority(
            target,
            io,
            opts.hostTrustStore,
            selectedAuthorityId,
            authorityKind
          );
          if (authorityKind === 'human_disposition' &&
              authority.keyId !== opts.humanDispositionKeyId) {
            throw new VerificationContextError(
              `authority '${String(selectedAuthorityId)}' does not use selected keyId '${String(opts.humanDispositionKeyId)}'`
            );
          }
          return authority;
        },
        workflowRoleRegistry,
        runGit: targetGitRunner(target),
      }, {
        capabilities,
        hostRoleCapabilities,
        // The effective minimum comes from current external operator policy as
        // well as the packet, and the boundary takes the stronger of the two.
        // A packet minted under a since-hardened policy cannot carry its old
        // permissive minimum into a return.
        minimumReturnAssurance: returnPolicy.minimumReturn,
        resolveActivationBinding: candidate => resolvePacketActivationBinding(target, io, candidate, {
          hostTrustStorePath: opts.hostTrustStore,
        }),
      });
      const presentedValidation = presentGateResultForTarget(received.validation, target);
      let returnVerification = null;
      if (received.ok && received.exceptional === undefined) {
        try {
          const wireReturn = JSON.parse(raw);
          const cancellationClaimed = wireReturn?.disposition === 'blocked' &&
            wireReturn?.blocker?.category === 'cancellation_requested';
          if (cancellationClaimed) {
            // The cancellation outcome stays unknown until an Agentic
            // Loop-controlled observation bound to this exact consumed
            // invocation is presented. Host state is never consulted.
            if (!opts.cancellationEvidence) {
              throw new VerificationContextError(
                'a cancellation-blocked role return requires --cancellation-evidence <path> carrying the Agentic Loop-controlled observation; without it the cancellation outcome is unknown',
                { requiredContext: ['--cancellation-evidence <path>'] }
              );
            }
            const provenance = readTargetJson(target, opts.cancellationEvidence, 'cancellation evidence');
            const provenanceCheck = validateAuthoritativeCancellationProvenance(provenance);
            if (!provenanceCheck.ok) {
              throw cancellationEvidenceError(provenanceCheck.errors, 'cancellation evidence is not a usable Agentic Loop-controlled observation');
            }
            if (provenance.invocation.invocationId !== packet.assignment.invocationId ||
                provenance.digest !== wireReturn.blocker.evidence?.detail) {
              throw new VerificationContextMalformedError(
                'cancellation evidence does not bind the consumed packet invocation and the exact blocked-return claim'
              );
            }
          } else if (opts.cancellationEvidence) {
            throw new CliUsageError('--cancellation-evidence requires a cancellation-blocked role return');
          }
          if (backend === 'files' && verifiedRepositoryEvidence) {
            enforceReturnedCommandCheckEvidence(target, wireReturn, packet, verifiedRepositoryEvidence, taskId);
          }
          if (executionReceipt !== null && producerReceipt === null) {
            throw new CliUsageError('--execution-receipt requires --producer-receipt');
          }
          if (executionReceipt !== null) {
            const trustedAdapter = resolveTrustedHostAdapter(
              target, io, opts.hostTrustStore, packet.returnAdapter?.adapterId
            );
            const executionReceiptReplayAuthority = createExecutionReceiptReplayAuthority({
              target,
              trustedAdapter,
              // This is an adapter-owned protected transport in production. The
              // CLI intentionally has no fallback replay store; test IO is the
              // only in-process seam that can emulate that external boundary.
              protectedBoundary: io.hostAuthority,
            });
            returnVerification = createAuthenticatedReturnVerification({
              target,
              packet,
              roleReturn: wireReturn,
              repositoryEvidence: verifiedRepositoryEvidence,
              producerReceipt,
              received,
              executionReceipt,
              trustedAdapter,
            });
            const stored = writeReturnVerification(target, returnVerification, {
              trustedAdapter,
              executionReceiptReplayAuthority,
            });
            if (!stored.ok) {
              throw new VerificationContextError(`authenticated return verification could not be persisted: ${stored.errors.join('; ')}`);
            }
            returnVerification = { record: returnVerification, path: stored.path };
          } else {
            returnVerification = createReturnVerification({
              target,
              packet,
              roleReturn: wireReturn,
            repositoryEvidence: verifiedRepositoryEvidence,
            producerReceipt,
            received,
          });
            const stored = writeReturnVerification(target, returnVerification);
            if (!stored.ok) {
              throw new VerificationContextError(`successful return verification could not be persisted: ${stored.errors.join('; ')}`);
            }
            returnVerification = { record: returnVerification, path: stored.path };
          }
        } catch (error) {
          return printGateResult('task verify-return', commandFailure('task verify-return', error, error instanceof CliUsageError ? 'usage' : 'operational_error', {}, target), asJson, io, error instanceof CliUsageError ? EXIT_USAGE : 1);
        }
      }
      if (asJson) printGateResult('task verify-return', presentedValidation, true, io);
      else if (received.ok && received.exceptional?.state === 'exception_requested') {
        // A valid exception request is routed, not granted. Do not print a
        // "current"/proceed message that implies the next transition.
        io.out(
          `Exceptional verification recorded as exception_requested; routed to ${received.exceptional.route.ownerRole} ` +
          `for disposition. No exception has been accepted or rejected and no further authority is granted.`
        );
      } else if (received.ok) {
        io.out('Role return is current.');
        io.out(`  activation: ${received.assurance?.activation ?? 'unknown'}`);
        io.out(`  return:     ${received.returnAssurance}`);
        if (returnVerification) io.out(`  evidence:   ${returnVerification.path}`);
        if (received.returnAssurance === 'session_reported') {
          io.warn(
            '  WARN: the producing role identity was NOT host-authenticated. ' +
            'This result is session_reported, not cryptographically host-authenticated.'
          );
        }
      }
      else for (const error of received.validation.errors) io.err(error);
      return received.ok ? 0 : 1;
    }

    if (sub === 'evidence') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      const mutationClass = String(opts.class ?? '');
      const evidenceClasses = new Set([
        'implementation_artifact_evidence',
        'implementation_summary_evidence',
        'implementation_outcome_evidence',
      ]);
      if (!taskId || !opts.expectDigest || !evidenceClasses.has(mutationClass)) {
        io.err('task evidence requires <id>, --expect-digest, and --class implementation_artifact_evidence|implementation_summary_evidence|implementation_outcome_evidence');
        return EXIT_USAGE;
      }
      if (selectedBackend.backend !== 'files') {
        return printGateResult('task evidence', commandFailure('task evidence', new VerificationContextError(
          'GitHub task evidence mutation requires the task-body guarded transport and is not available through this files carrier command'
        ), 'operational_error', {}, target), asJson, io);
      }
      const filePath = taskPathForId(target, projectConfig, taskId);
      const carrier = relative(target, filePath).replace(/\\/g, '/');
      if (!existsSync(filePath)) {
        return printGateResult('task evidence', commandFailure('task evidence', new VerificationContextError(
          `task record not found: ${carrier}`
        ), 'operational_error', {}, target), asJson, io);
      }
      const current = readFileSync(filePath, 'utf8');
      const priorCarrierDigest = taskRecordDigest(current);
      if (priorCarrierDigest !== String(opts.expectDigest)) {
        return printGateResult('task evidence', commandFailure('task evidence', new PublicCommandError(
          staleCarrierDigestMessage(String(opts.expectDigest), priorCarrierDigest), STALE_CARRIER_DIGEST_CONTEXT
        ), 'operational_error', { task_id: taskId, file: carrier }, target), asJson, io);
      }
      const [frontmatter] = parseFrontmatter(current);
      if (frontmatterString(frontmatter?.status) !== 'in-progress') {
        return printGateResult('task evidence', commandFailure('task evidence', new PublicCommandError(
          'Engineer evidence mutation requires the task to be in-progress through a recognized role start', {
            code: 'task.evidence.not_in_progress', evidenceState: 'negative', disposition: 'blocked',
          }
        ), 'operational_error', { task_id: taskId, file: carrier }, target), asJson, io);
      }
      const contract = taskContractDigest(current);
      if (!contract.ok) {
        return printGateResult('task evidence', commandFailure('task evidence', new VerificationContextMalformedError(contract.error), 'operational_error', {}, target), asJson, io);
      }
      const lineage = resolveCarrierLineage(target, taskId, {
        backend: 'files', taskContractDigest: contract.digest, currentCarrierDigest: priorCarrierDigest,
      });
      if (!lineage.ok) {
        return printGateResult('task evidence', commandFailure('task evidence', new PublicCommandError(
          `Engineer evidence mutation refused: ${lineage.errors.join('; ')}`, {
            code: 'task.evidence.lineage', evidenceState: 'changed', disposition: 'blocked',
            safeRepair: 'Restore the recognized carrier lineage or prepare a fresh dispatch; do not edit task evidence directly.',
          }
        ), 'operational_error', { task_id: taskId, file: carrier }, target), asJson, io);
      }
      let candidate = current;
      let ownedFields;
      if (mutationClass === 'implementation_artifact_evidence') {
        const productHead = String(opts.productHead ?? '');
        const runGit = targetGitRunner(target);
        // The implementation artifact is the product head, and the product head
        // is not "whatever HEAD happens to be". Pinning it to HEAD forced every
        // resumed attempt to rebind the field to a role-start workflow commit -
        // which then derived an empty product range, made the return
        // impossible, and left the task record naming the wrong artifact.
        //
        // What the field must actually satisfy is stated directly: it is a
        // commit that introduces product work, it is reachable from HEAD, and
        // nothing after it changed product paths. HEAD itself still satisfies
        // all three in the ordinary case.
        const refused = evaluateProductHeadEvidence(runGit, productHead, createPathClassifier(target));
        if (refused) {
          return printGateResult('task evidence', commandFailure('task evidence', refused,
            'operational_error', { task_id: taskId, file: carrier }, target), asJson, io);
        }
        candidate = replaceFrontmatterField(candidate, 'implementation_artifact', `commit:${productHead}`);
        ownedFields = ['implementation_artifact'];
      } else if (mutationClass === 'implementation_summary_evidence') {
        if (typeof opts.summary !== 'string' || !opts.summary.trim() || typeof opts.checkEvidence !== 'string' || !opts.checkEvidence.trim()) {
          io.err('task evidence --class implementation_summary_evidence requires --summary and --check-evidence');
          return EXIT_USAGE;
        }
        candidate = appendComment(candidate, `Engineer summary: ${opts.summary.trim()} | Check evidence: ${opts.checkEvidence.trim()}`);
        ownedFields = ['comments'];
      } else {
        if (!['implementation_ready_for_review', 'implementation_blocked'].includes(String(opts.outcome ?? ''))) {
          io.err('task evidence --class implementation_outcome_evidence requires --outcome implementation_ready_for_review|implementation_blocked');
          return EXIT_USAGE;
        }
        candidate = appendComment(candidate, `Engineer outcome (non-authoritative): ${String(opts.outcome)}`);
        ownedFields = ['comments'];
      }
      const currentCarrierDigest = taskRecordDigest(candidate);
      const candidateContract = taskContractDigest(candidate);
      if (!candidateContract.ok || candidateContract.digest !== contract.digest || candidate === current) {
        return printGateResult('task evidence', commandFailure('task evidence', new PublicCommandError(
          'Engineer evidence candidate changes protected task contract or makes no bounded evidence change', {
            code: 'task.evidence.contract_drift', evidenceState: 'changed', disposition: 'blocked',
          }
        ), 'operational_error', { task_id: taskId, file: carrier }, target), asJson, io);
      }
      const receipt = createCarrierMutationReceipt({
        receiptId: `task-mutation:${randomUUID()}`,
        backend: 'files', task: { id: taskId, carrier }, taskContractDigest: contract.digest,
        dispatchCarrierDigest: lineage.dispatchCarrierDigest, priorCarrierDigest, currentCarrierDigest,
        mutationClass, ownedFields, changedFields: ownedFields,
        producer: {
          workflowRole: 'engineer', assuranceGrade: 'session_reported',
          invocationId: lineage.dispatchConsumption.invocationId,
          workUnitIdentity: lineage.dispatchConsumption.workUnitIdentity,
          repositoryIdentity: lineage.dispatchConsumption.repositoryIdentity,
        },
        predecessor: {
          kind: lineage.receipts.length === 0 ? 'dispatch_consumption' : 'task_mutation_receipt',
          digest: lineage.receipts.length === 0 ? lineage.dispatchConsumption.digest : lineage.receipts.at(-1).digest,
        },
      });
      const immediate = readFileSync(filePath, 'utf8');
      if (taskRecordDigest(immediate) !== priorCarrierDigest) {
        return printGateResult('task evidence', commandFailure('task evidence', new BaselineChangedError(
          `The task record changed between evidence validation and mutation; nothing was written to ${carrier}.`
        ), 'operational_error', { task_id: taskId, file: carrier }, target), asJson, io);
      }
      const receiptPath = carrierMutationRelativePath(receipt);
      const applied = executeMutationBatch(target, [
        { type: 'write', path: carrier, content: candidate, expectedDigest: priorCarrierDigest, expectedKind: 'file' },
        { type: 'create', path: receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n` },
      ]);
      if (!applied.ok) {
        return printGateResult('task evidence', commandFailure('task evidence', new PublicCommandError(
          `Engineer evidence mutation failed: ${[...applied.errors, ...applied.rollbackErrors].join('; ')}`, {
            code: 'task.evidence.atomic_write', evidenceState: 'negative', disposition: 'blocked',
          }
        ), 'operational_error', { task_id: taskId, file: carrier }, target), asJson, io);
      }
      const final = readFileSync(filePath, 'utf8');
      const finalLineage = resolveCarrierLineage(target, taskId, {
        backend: 'files', taskContractDigest: contract.digest, currentCarrierDigest,
      });
      if (final !== candidate || !finalLineage.ok || taskContractDigest(final).digest !== contract.digest) {
        return printGateResult('task evidence', commandFailure('task evidence', new PublicCommandError(
          'Engineer evidence mutation did not refetch to one current schema-valid carrier lineage', {
            code: 'task.evidence.final_validation', evidenceState: 'changed', disposition: 'blocked',
          }
        ), 'operational_error', { task_id: taskId, file: carrier }, target), asJson, io);
      }
      const result = {
        ok: true, task_id: taskId, mutationClass, taskContractDigest: contract.digest,
        dispatchCarrierDigest: lineage.dispatchCarrierDigest, currentCarrierDigest,
        receipt, receiptPath, productHead: mutationClass === 'implementation_artifact_evidence' ? opts.productHead : null,
      };
      if (asJson) io.out(JSON.stringify(result, null, 2));
      else io.out(`Recorded ${mutationClass} for ${taskId}; current carrier: ${currentCarrierDigest}`);
      return 0;
    }

    if (sub === 'review-prepare') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId) {
        io.err('task review-prepare requires <id>');
        return EXIT_USAGE;
      }
      if (selectedBackend.backend !== 'files') {
        return printGateResult('task review-prepare', commandFailure('task review-prepare', new VerificationContextError(
          'files review preparation requires the files backend'
        ), 'operational_error', {}, target), asJson, io);
      }
      const filePath = taskPathForId(target, projectConfig, taskId);
      const carrier = relative(target, filePath).replace(/\\/g, '/');
      if (!existsSync(filePath)) {
        return printGateResult('task review-prepare', commandFailure('task review-prepare', new VerificationContextError(
          `task record not found: ${carrier}`
        ), 'operational_error', {}, target), asJson, io);
      }
      // One command-local carrier snapshot is used for every review-entry
      // decision. A second fetch is only a final drift check, never input to a
      // mixed snapshot.
      const body = readFileSync(filePath, 'utf8');
      const currentCarrierDigest = taskRecordDigest(body);
      const contract = taskContractDigest(body);
      const history = loadFilesTaskContractRecords(target, taskId);
      const snapshot = {
        backend: 'files', taskId, carrier, body, digest: currentCarrierDigest,
        trustedRecords: history.trustedRecords, trustedRecordErrors: history.errors,
      };
      const recognition = recognizeLifecycleReturn({
        target, io, transition: 'review_entry', backend: 'files', taskId,
        taskContractDigest: contract.ok ? contract.digest : null,
        currentCarrierDigest, productHead: implementationArtifactHead(body),
        refetchTask: () => snapshot,
        refetchRepositoryEvidence: record => refetchFilesReturnEvidence(
          target, record.evidence.packet, record.evidence.repositoryEvidence
        ),
        hostTrustStore: opts.hostTrustStore,
      });
      if (!recognition.recognized) {
        return printGateResult('task review-prepare', {
          ok: false, task_id: taskId, diagnostics: recognition.diagnostics,
          errors: recognition.diagnostics.map(item => item.message), warnings: [],
          evidenceState: recognition.evidenceState, disposition: recognition.disposition,
          handoff_recognition: recognition,
        }, asJson, io);
      }

      // Maintainer Review Fixup durable-disclosure validation: validate the
      // shape of any fixup subsection using the shared checker, then build the
      // finding-resolution matrix from the canonical review record (stable
      // AGENT_REVIEW_FINDINGS IDs + Revision classification) rather than from
      // fixup episodes.  The matrix routes record-only corrections without
      // consuming an Engineer revision round; it does not hard-block review
      // entry preparation.
      let findingResolutionMatrix = null;
      let matrixDecision = null;
      const fixupEpisodes = detectFixupEpisodes(body);
      if (fixupEpisodes.length > 0) {
        const episodeErrors = [];
        for (const episode of fixupEpisodes) {
          episodeErrors.push(...validateFixupEpisode(episode, {
            subject: `Task record '${carrier}'`,
          }));
        }
        if (episodeErrors.length > 0) {
          return printGateResult('task review-prepare', commandFailure('task review-prepare', new PublicCommandError(
            `task record contains an invalid Maintainer Review Fixup: ${episodeErrors[0]}`, {
              code: 'review.entry.fixup_invalid', evidenceState: 'malformed', disposition: 'blocked',
              safeRepair: 'Repair the ## Maintainer Review Fixup subsection and rerun task review-prepare.',
            }
          ), 'operational_error', { task_id: taskId }, target), asJson, io);
        }
      }
      // Scaffold the finding-resolution matrix from the canonical review
      // record.  A null matrix on first review (no needs_revision outcome yet)
      // is correct — the matrix populates on revision rounds when
      // AGENT_REVIEW_FINDINGS exists.
      const reviewHistory = parseFilesReviewHistory(body);
      const needsRevisionEvents = reviewHistory.events.filter(
        event => event.type === 'outcome' && event.status === 'needs_revision'
      );
      if (needsRevisionEvents.length > 0) {
        const latestRevision = needsRevisionEvents.at(-1);
        const protectedContractUnchanged = contract.ok &&
          recognition.boundIdentity.taskContractDigest !== null &&
          contract.digest === recognition.boundIdentity.taskContractDigest;
        const boundProductArtifact = recognition.boundIdentity.productHead ?? '';
        const currentProductArtifact = implementationArtifactHead(body) ?? '';
        const fixupResolved = fixupEpisodes.length > 0 &&
          fixupEpisodes.some(episode => /passed|resolved/i.test(String(episode.fields.verification_result ?? '')));
        const classificationMap = {
          record_only: 'record-only',
          implementation_changing: 'implementation-changing',
        };
        const findings = latestRevision.findingIds.map(findingId => ({
          findingId,
          classification: classificationMap[latestRevision.classification] ?? 'implementation-changing',
          disposition: fixupResolved ? 'resolved' : 'disputed',
          evidence: fixupEpisodes.length > 0
            ? [
                fixupEpisodes[0].fields.finding,
                fixupEpisodes[0].fields.correction,
                fixupEpisodes[0].fields.verification_result,
              ].filter(Boolean).join('; ')
            : `review finding ${findingId} pending resolution`,
        }));
        findingResolutionMatrix = createFindingResolutionMatrix({
          taskId,
          productArtifact: boundProductArtifact,
          workflowHead: recognition.boundIdentity.workflowHead,
          carrierHead: currentCarrierDigest,
          findings,
        });
        const matrixValidation = validateFindingResolutionMatrix(findingResolutionMatrix, {
          taskId,
          currentProductArtifact,
          protectedContractUnchanged,
        });
        if (!matrixValidation.ok) {
          return printGateResult('task review-prepare', commandFailure('task review-prepare', new PublicCommandError(
            `finding-resolution matrix is stale or invalid: ${matrixValidation.errors[0]}`, {
              code: 'review.entry.matrix_stale', evidenceState: 'changed', disposition: 'superseded',
              safeRepair: `Refresh the finding-resolution matrix against the current product artifact ${currentProductArtifact} and rerun task review-prepare.`,
            }
          ), 'operational_error', { task_id: taskId }, target), asJson, io);
        }
        // Route and record the decision; do not hard-block review entry
        // preparation.  Implementation-changing findings are routed to the
        // Engineer for revision, but the review entry itself is still prepared.
        matrixDecision = metadataOnlyReviewDecision(findingResolutionMatrix, {
          taskId,
          currentProductArtifact,
          protectedContractUnchanged,
        });
      }

      const returnId = recognition.boundIdentity.returnId;
      const verified = listReturnVerifications(target, taskId, {
        taskContractDigest: contract.digest,
        resolveTrustedAdapter: adapterId => resolveTrustedHostAdapter(target, io, opts.hostTrustStore, adapterId),
        resolveExecutionReceiptReplayAuthority: record => {
          const trustedAdapter = resolveTrustedHostAdapter(
            target, io, opts.hostTrustStore, record.producerAuthentication?.adapterId
          );
          return createExecutionReceiptReplayAuthority({ target, trustedAdapter, protectedBoundary: io.hostAuthority });
        },
      });
      const matchingReturns = verified.records.filter(record =>
        record.evidence?.roleReturn?.returnId === returnId
      );
      if (!verified.ok || matchingReturns.length !== 1) {
        return printGateResult('task review-prepare', {
          ok: false, task_id: taskId, diagnostics: [],
          errors: verified.ok
            ? ['the recognized verified return cannot be resolved uniquely for review entry']
            : verified.errors,
          warnings: [], evidenceState: 'changed', disposition: 'superseded',
          handoff_recognition: recognition,
        }, asJson, io);
      }
      const verifiedReturn = matchingReturns[0];
      const terminalLineageDigest = verifiedReturn.evidence.roleReturn.carrierLineage
        .evidenceMutationReceiptDigests.at(-1) ??
        verifiedReturn.evidence.roleReturn.carrierLineage.dispatchConsumptionDigest;
      const receipt = {
        kind: 'agenticloop.files-review-entry-receipt', schemaVersion: 2,
        backend: 'files', taskId, taskContractDigest: contract.digest,
        dispatchCarrierDigest: recognition.boundIdentity.dispatchCarrierDigest,
        currentCarrierDigest, productHead: recognition.boundIdentity.productHead,
        workflowHead: recognition.boundIdentity.workflowHead,
        candidateHead: recognition.boundIdentity.candidateHead,
        verifiedReturn: {
          recordId: verifiedReturn.recordId,
          digest: verifiedReturn.digest,
          returnGenerationDigest: verifiedReturn.returnGenerationDigest,
        },
        carrierLineageTerminalDigest: terminalLineageDigest,
        handoffRecognitionDigest: recognition.digest,
        // A review entry is an idempotent projection of one verified return.
        // Reuse its trusted verification instant rather than minting a new
        // identity on an otherwise exact retry.
        observedAt: verifiedReturn.verifiedAt, digest: null,
      };
      const { digest: _digest, ...receiptProjection } = receipt;
      receipt.digest = `sha256:agenticloop.files-review-entry-receipt.v2:${canonicalSha256(receiptProjection)}`;
      // The receipt's human-readable record is intentionally not a source of
      // authority. The recognized verified return remains the authority; this
      // file merely records entry after the command-local drift check.
      const returnToken = verifiedReturn.recordId.replace(/^return-verification:/, '');
      const reviewPath = `.agenticloop/reviews/entries/${taskId}/${returnToken}.json`;
      const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
      const reviewAbsolute = resolve(target, reviewPath);
      let alreadyCurrent = false;
      if (existsSync(reviewAbsolute)) {
        try {
          const existing = JSON.parse(readFileSync(reviewAbsolute, 'utf8'));
          alreadyCurrent = canonicalJson(existing) === canonicalJson(receipt);
        } catch {
          alreadyCurrent = false;
        }
        if (!alreadyCurrent) {
          return printGateResult('task review-prepare', commandFailure('task review-prepare', new PublicCommandError(
            `conflicting review-entry content already exists at ${reviewPath}`, {
              code: 'review.entry.persistence', evidenceState: 'negative', disposition: 'blocked',
            }
          ), 'operational_error', { task_id: taskId }, target), asJson, io);
        }
      }
      // The no-op carrier write is intentional: executeMutationBatch rechecks
      // its exact bytes immediately before it creates the review entry, so a
      // carrier race cannot leave an authoritative entry behind.
      const applied = executeMutationBatch(target, [
        { type: 'write', path: carrier, content: body, expectedDigest: currentCarrierDigest, expectedKind: 'file' },
        ...(!alreadyCurrent ? [{ type: 'create', path: reviewPath, content: receiptText }] : []),
      ]);
      if (!applied.ok) {
        const stale = applied.stale === true;
        return printGateResult('task review-prepare', commandFailure('task review-prepare', new PublicCommandError(
          `review-entry persistence failed: ${[...applied.errors, ...applied.rollbackErrors].join('; ')}`, {
            code: 'review.entry.persistence', evidenceState: stale ? 'changed' : 'negative',
            disposition: stale ? 'superseded' : 'blocked',
          }
        ), 'operational_error', { task_id: taskId }, target), asJson, io);
      }
      const finalCarrier = readFileSync(filePath, 'utf8');
      const finalReceipt = readFileSync(reviewAbsolute, 'utf8');
      if (finalCarrier !== body || finalReceipt !== receiptText) {
        return printGateResult('task review-prepare', commandFailure('task review-prepare', new PublicCommandError(
          'review-entry persistence did not refetch to the exact intended carrier and receipt bytes', {
            code: 'review.entry.persistence', evidenceState: 'changed', disposition: 'superseded',
          }
        ), 'operational_error', { task_id: taskId }, target), asJson, io);
      }
      const result = {
        ok: true, task_id: taskId, taskContractDigest: contract.digest,
        dispatchCarrierDigest: receipt.dispatchCarrierDigest, currentCarrierDigest,
        productHead: receipt.productHead, workflowHead: receipt.workflowHead, candidateHead: receipt.candidateHead,
        reviewEntryPath: reviewPath,
        mutationDisposition: alreadyCurrent ? 'already_current' : 'created',
        verifiedReturn: receipt.verifiedReturn,
        carrierLineageTerminalDigest: receipt.carrierLineageTerminalDigest,
        handoff_recognition: recognition,
        findingResolutionMatrix,
        matrixDecision,
      };
      if (asJson) io.out(JSON.stringify(result, null, 2));
      else io.out(`Prepared files review entry for ${taskId}: ${reviewPath}`);
      return 0;
    }

    if (sub === 'commit-message') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      const commitClass = String(opts.class ?? '');
      // The one artifact Agentic Loop is strictest about had no producer, so
      // every role hand-authored it - and `git commit -m … -m …`, the natural
      // way to write a multi-line message, inserts a blank line between each
      // `-m` and strands `Task:` outside the final contiguous trailer block.
      // That single mechanical fact was the largest failure code of the field
      // run: fourteen refusals, three rejected commits, and one history reset.
      if (!taskId || !commitClass || typeof opts.subject !== 'string' || !opts.subject.trim() || !opts.output) {
        const error = new CliUsageError(
          'task commit-message requires <id>, --class <commit-class>, --subject <text>, and --output <path>',
          { hint: `Accepted --class values: ${COMMIT_MESSAGE_CLASS_LIST.join(', ')}.` }
        );
        return printGateResult('task commit-message', commandFailure('task commit-message', error, 'usage', {}, target), asJson, io, EXIT_USAGE);
      }
      if (!Object.hasOwn(COMMIT_MESSAGE_CLASSES, commitClass)) {
        const error = new CliUsageError(
          `task commit-message --class '${commitClass}' is not a canonical commit class; ` +
          `accepted values: ${COMMIT_MESSAGE_CLASS_LIST.join(', ')}`
        );
        return printGateResult('task commit-message', commandFailure('task commit-message', error, 'usage', {}, target), asJson, io, EXIT_USAGE);
      }
      try {
        const role = COMMIT_MESSAGE_CLASSES[commitClass];
        const body = typeof opts.bodyFile === 'string' && opts.bodyFile.trim()
          ? readTargetText(target, opts.bodyFile, 'commit message body')
          : typeof opts.body === 'string' ? opts.body : null;
        const rendered = renderCommitMessage({ taskId, role, subject: opts.subject, body });
        if (!rendered.ok) {
          throw new VerificationContextMalformedError(
            `commit message could not be rendered: ${rendered.errors.join('; ')}`
          );
        }
        // The producer proves its own output against the validator every
        // refusal is issued by, so the two can never drift apart.
        const checked = evaluateCommitAttribution({ message: rendered.message, taskId, role });
        if (!checked.ok) {
          throw new VerificationContextMalformedError(
            `rendered commit message does not satisfy canonical commit attribution: ${checked.errors.join('; ')}`
          );
        }
        const destination = publicTargetRelativePath(target, opts.output, 'output path');
        const applied = executeMutationBatch(target, [{
          type: 'write', path: destination.relPath, content: rendered.message,
        }]);
        if (!applied.ok) {
          throw new VerificationContextMalformedError(
            `commit message could not be written atomically: ${[...applied.errors, ...applied.rollbackErrors].join('; ')}`
          );
        }
        const result = {
          ok: true,
          command: 'task commit-message',
          task_id: taskId,
          commitClass,
          role,
          output: destination.relPath,
          message: rendered.message,
          commitCommand: `git commit -F ${destination.relPath}`,
        };
        if (asJson) io.out(JSON.stringify(result, null, 2));
        else {
          io.out(`Wrote ${destination.relPath} for ${taskId} (${commitClass}, Agent: ${role}).`);
          io.out(`Commit it with: git commit -F ${destination.relPath}`);
        }
        return 0;
      } catch (error) {
        return printGateResult('task commit-message', commandFailure('task commit-message', error, 'operational_error', { task_id: taskId }, target), asJson, io);
      }
    }

    if (sub === 'attempt-status') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId) {
        io.err('task attempt-status requires <id>');
        return EXIT_USAGE;
      }
      const conservation = evaluateTaskPacketConservation(target, taskId, { backend: selectedBackend.backend });
      const report = {
        command: 'task attempt-status',
        taskId,
        newPacketPermitted: conservation.ok,
        liveAttempt: conservation.liveAttempt,
        attempts: conservation.attempts,
        ...(conservation.ok ? {} : { reason: conservation.reason, safeRepair: conservation.repair }),
      };
      if (asJson) io.out(JSON.stringify(report, null, 2));
      else {
        io.out(`Execution attempts for ${taskId}: ${conservation.attempts.length}`);
        for (const attempt of conservation.attempts) {
          io.out(`  ${attempt.sequence}. ${attempt.attemptId} [${attempt.state}]`);
          io.out(`     packet:       ${attempt.packetId}`);
          io.out(`     product base: ${attempt.productBaseHead}`);
          io.out(`     consumed:     ${attempt.consumedAt}`);
          if (attempt.abandonment) {
            io.out(`     abandoned:    ${attempt.abandonment.abandonedAt} (${attempt.abandonment.authority})`);
            io.out(`     reason:       ${attempt.abandonment.reason}`);
          }
        }
        if (conservation.attempts.length === 0) io.out('  (none)');
        io.out(`  new packet permitted: ${conservation.ok ? 'yes' : 'no'}`);
        if (!conservation.ok) {
          io.err(conservation.reason);
          io.err(conservation.repair);
        }
      }
      return conservation.ok ? 0 : 1;
    }

    if (sub === 'readiness-plan') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId) {
        io.err('task readiness-plan requires <id>');
        return EXIT_USAGE;
      }
      const plan = buildReadinessPlan(target, taskId, readinessPlanInputs({
        target, taskId, opts, projectConfig, backend: selectedBackend.backend,
      }));
      if (asJson) io.out(JSON.stringify(plan, null, 2));
      else {
        io.out(`Readiness plan for ${taskId}: ${plan.ready ? 'settled' : `${plan.pendingSteps.length} step(s) remaining`}`);
        for (const item of plan.steps) {
          io.out(`  [${item.settled ? 'x' : ' '}] ${item.id} (${item.owner}) - ${item.detail}`);
          if (!item.settled && item.command) io.out(`        ${item.command.replace(/\n/g, ' ')}`);
        }
        if (plan.writeSet.length) {
          io.out('  write set:');
          for (const path of plan.writeSet) io.out(`    ${path}`);
        }
        if (!plan.ready) io.out(`  final commit trailer: ${plan.finalCommitTrailer.replace(/\n/g, ' / ')}`);
        io.out(`  applicable: ${plan.applicable ? 'yes (task readiness-apply can settle this plan in one commit)' : 'no (display only)'}`);
        for (const blocker of plan.blockers) io.out(`    blocker: ${blocker}`);
        io.out(`  ${plan.activationNote}`);
      }
      return plan.ready ? 0 : 1;
    }

    if (sub === 'readiness-apply') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      const dryRun = opts.dryRun === true;
      const yes = opts.yes === true;
      if (!taskId || !opts.plan || dryRun === yes) {
        const error = new CliUsageError(
          'task readiness-apply requires <id>, --plan <path>, and exactly one of --dry-run or --yes; readiness mutation is never implicit'
        );
        return printGateResult('task readiness-apply',
          commandFailure('task readiness-apply', error, 'usage', { task_id: taskId ?? null }, target), asJson, io, EXIT_USAGE);
      }
      let plan;
      try {
        plan = readTargetJson(target, opts.plan, 'readiness plan');
      } catch (error) {
        return printGateResult('task readiness-apply',
          commandFailure('task readiness-apply', error, 'operational_error', { task_id: taskId }, target), asJson, io);
      }
      const applied = applyReadinessPlan({
        target,
        taskId,
        plan,
        projectConfig,
        dryRun,
        ...createReadinessApplyBindings(target, projectConfig, taskId),
        io,
      });
      if (asJson) io.out(JSON.stringify(applied, null, 2));
      else {
        io.out(`agenticloop task readiness-apply ${taskId}`);
        io.out(`  disposition:   ${applied.mutationDisposition}`);
        io.out(`  plan digest:   ${applied.planDigest ?? '(unreadable)'}`);
        io.out(`  expected HEAD: ${applied.expectedHead ?? '(none)'}`);
        io.out(`  resulting HEAD:${applied.resultingHead ? ` ${applied.resultingHead}` : ' (unchanged)'}`);
        io.out(`  commits:       ${applied.commitCount}`);
        io.out(`  changed paths: ${applied.changedPaths.join(', ') || '(none)'}`);
        io.out(`  activation:    planned=${applied.activationPlanned} created=${applied.activationCreated}`);
        if (applied.readiness) {
          io.out(`  readiness:     ${applied.readiness.ready ? 'ready' : `pending ${applied.readiness.pendingSteps.join(', ')}`}`);
        }
        for (const error of applied.errors) io.err(`  ERROR: ${error}`);
        for (const error of applied.rollbackErrors) io.err(`  ROLLBACK: ${error}`);
        if (applied.recovery) io.out(`  recovery:      ${applied.recovery}`);
        if (applied.nextAction) io.out(`  next:          ${applied.nextAction}`);
      }
      return applied.mutationDisposition === 'committed' ||
        applied.mutationDisposition === 'already_current' ||
        applied.mutationDisposition === 'dry_run'
        ? 0
        : 1;
    }

    if (sub === 'measure') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId) {
        io.err('task measure requires <id>');
        return EXIT_USAGE;
      }
      const measurement = measureTaskWorkflow(target, taskId, { backend: selectedBackend.backend });
      if (asJson) io.out(JSON.stringify(measurement, null, 2));
      else {
        io.out(`Workflow measurement for ${taskId} (derived; nothing stored)`);
        io.out(`  execution attempts:  ${measurement.counters.executionAttempts}`);
        io.out(`  abandoned attempts:  ${measurement.counters.abandonedAttempts}`);
        io.out(`  packet remints:      ${measurement.counters.packetRemints}`);
        io.out(`  distinct bases:      ${measurement.counters.distinctProductBases}`);
        io.out(`  carrier mutations:   ${measurement.counters.carrierMutations}`);
        if (measurement.durations.liveAttemptElapsedSeconds !== null) {
          io.out(`  live attempt age:    ${measurement.durations.liveAttemptElapsedSeconds}s`);
        }
        for (const deviation of measurement.deviations) {
          io.out(`  deviation:           ${deviation.shape} expected ${deviation.expected}, observed ${deviation.observed}`);
        }
        if (measurement.deviations.length === 0) io.out('  deviation:           (none)');
        for (const item of measurement.unreadableEvidence) io.err(`unreadable evidence class: ${item}`);
      }
      return measurement.complete ? 0 : 1;
    }

    if (sub === 'adopt-historical') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      const missing = opts.missing === undefined
        ? []
        : (Array.isArray(opts.missing) ? opts.missing : [String(opts.missing)]);
      if (!taskId || !opts.artifact || !opts.integration || !opts.integrationCommit ||
          !opts.audit || !opts.authority || !opts.reason || missing.length === 0) {
        io.err('task adopt-historical requires <id>, --artifact, --integration, --integration-commit, --audit, --authority, --reason, and at least one --missing <class>');
        io.err(`Recognized --missing classes: ${HISTORICAL_MISSING_EVIDENCE_CLASSES.join(', ')}`);
        return EXIT_USAGE;
      }
      const filePath = taskPathForId(target, projectConfig, taskId);
      if (!existsSync(filePath)) {
        io.err(`Task record not found: ${relative(target, filePath).replace(/\\/g, '/')}`);
        return 1;
      }
      const body = readFileSync(filePath, 'utf-8');
      const contract = taskContractDigest(body);
      if (!contract.ok) {
        io.err(contract.error);
        return 1;
      }
      // Adoption is only for work that genuinely predates the lifecycle. A task
      // that already produced a dispatch consumption entered the canonical
      // path, and routing it here would launder real evidence into a
      // reduced-assurance record.
      const consumed = listDispatchConsumptions(target, taskId, { backend: 'files' });
      if (!consumed.ok) {
        for (const error of consumed.errors) io.err(error);
        return 1;
      }
      if (consumed.records.length > 0) {
        io.err(`Task ${taskId} has canonical dispatch consumption evidence and must complete normal closeout, not historical adoption.`);
        io.err(`Run 'npx agenticloop task attempt-status ${taskId} --json' to inspect its execution attempts.`);
        return 1;
      }
      const integrationMatch = String(opts.integration).match(/^([a-z_]+):(.+)$/);
      if (!integrationMatch) {
        io.err('--integration must be <git_merge|git_branch_containment|pull_request>:<reference>');
        return EXIT_USAGE;
      }
      let record;
      try {
        record = createHistoricalAdoption({
          backend: 'files',
          taskId,
          repositoryIdentity: targetRepositoryIdentity(target),
          taskContractDigest: contract.digest,
          implementationArtifact: { kind: 'git_commit', commit: String(opts.artifact) },
          integration: {
            kind: integrationMatch[1],
            reference: integrationMatch[2],
            commit: String(opts.integrationCommit),
          },
          audit: {
            reference: String(opts.audit),
            auditedArtifact: String(opts.artifact),
            independent: true,
          },
          disposition: {
            kind: 'human_adoption',
            authority: String(opts.authority),
            reason: String(opts.reason),
          },
          missingEvidence: missing.map(String),
        });
      } catch (error) {
        io.err(error.message);
        return EXIT_USAGE;
      }
      const relPath = historicalAdoptionRelativePath(taskId);
      const applied = executeMutationBatch(target, [{
        type: 'create', path: relPath, content: `${JSON.stringify(record, null, 2)}
`,
      }]);
      if (!applied.ok) {
        for (const error of [...applied.errors, ...applied.rollbackErrors]) io.err(error);
        return 1;
      }
      const projection = projectHistoricalAdoption(record);
      if (asJson) {
        io.out(JSON.stringify({ command: 'task adopt-historical', path: relPath, projection, record }, null, 2));
      } else {
        io.out(`Adopted ${taskId} as ${projection.status} (assurance: ${projection.assurance})`);
        io.out(`  canonical closure:  no`);
        io.out(`  artifact:           ${projection.adoptedArtifact}`);
        io.out(`  integration:        ${projection.integration}`);
        io.out(`  audit:              ${projection.auditReference}`);
        io.out(`  authority:          ${projection.dispositionAuthority}`);
        io.out(`  missing evidence:   ${projection.missingEvidence.join(', ')}`);
        io.out(`  record:             ${relPath}`);
        io.out('  No dispatch, consumption, return, host receipt, or activation evidence was created.');
      }
      return 0;
    }

    if (sub === 'abandon-attempt') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId || !opts.attempt || !opts.reason || !opts.authority) {
        io.err('task abandon-attempt requires <id>, --attempt <attempt-id>, --reason <text>, and --authority <kind:reference>');
        return EXIT_USAGE;
      }
      const backend = selectedBackend.backend;
      const conservation = evaluateTaskPacketConservation(target, taskId, { backend });
      const requested = String(opts.attempt);
      const attempt = conservation.attempts.find(item => item.attemptId === requested) ?? null;
      // Abandoning names an attempt that exists and is live. Inventing a record
      // for an unknown or already-closed attempt would create exactly the kind
      // of unbacked evidence this whole path exists to prevent.
      if (!attempt) {
        io.err(`Execution attempt '${requested}' is not recorded for ${taskId}.`);
        io.err(`Run 'npx agenticloop task attempt-status ${taskId} --json' to read the exact attempt identities.`);
        return 1;
      }
      if (attempt.state !== 'live') {
        io.err(`Execution attempt '${requested}' is already ${attempt.state}; nothing to abandon.`);
        return 1;
      }
      const record = {
        kind: EXECUTION_ATTEMPT_ABANDONMENT_KIND,
        schemaVersion: EXECUTION_ATTEMPT_ABANDONMENT_SCHEMA_VERSION,
        backend,
        taskId,
        attemptId: attempt.attemptId,
        packetId: attempt.packetId,
        reason: String(opts.reason),
        disposition: 'abandoned',
        authority: String(opts.authority),
        abandonedAt: new Date().toISOString(),
      };
      const checked = validateExecutionAttemptAbandonment(record, { taskId });
      if (!checked.ok) {
        for (const error of checked.errors) io.err(error);
        return EXIT_USAGE;
      }
      const relPath = executionAttemptAbandonmentRelativePath(record);
      const applied = executeMutationBatch(target, [{
        type: 'create', path: relPath, content: `${JSON.stringify(record, null, 2)}\n`,
      }]);
      if (!applied.ok) {
        for (const error of [...applied.errors, ...applied.rollbackErrors]) io.err(error);
        return 1;
      }
      if (asJson) {
        io.out(JSON.stringify({
          command: 'task abandon-attempt', taskId, attemptId: attempt.attemptId,
          packetId: attempt.packetId, path: relPath, record,
        }, null, 2));
      } else {
        io.out(`Abandoned execution attempt ${attempt.attemptId} for ${taskId}`);
        io.out(`  packet:   ${attempt.packetId}`);
        io.out(`  record:   ${relPath}`);
        io.out('  The abandoned attempt and its evidence are preserved, not deleted.');
        io.out(`  next:     npx agenticloop task prepare-dispatch ${taskId} --host <host> --role engineer`);
      }
      return 0;
    }

    if (sub === 'establish-baseline') {
      const taskId = positional[0];
      if (!taskId || !opts.actor || !opts.authority) {
        io.err('task establish-baseline requires <id>, --actor, and --authority');
        return EXIT_USAGE;
      }
      const filePath = taskPathForId(target, projectConfig, taskId);
      if (!existsSync(filePath)) {
        io.err(`Task record not found: ${relative(target, filePath).replace(/\\/g, '/')}`);
        return 1;
      }
      const body = readFileSync(filePath, 'utf8');
      // One shared preparer: `task readiness-apply` builds and validates the
      // identical candidate through the identical validators, so the two routes
      // can never accept a baseline the other would refuse.
      const prepared = prepareTrustedBaselineCandidate({
        target,
        taskId,
        body,
        actor: String(opts.actor),
        authority: String(opts.authority),
        timestamp: new Date().toISOString(),
        recordId: `files-task-contract:${randomUUID()}`,
        affectedArtifact: relative(target, filePath).replace(/\\/g, '/'),
      });
      if (!prepared.ok) {
        for (const error of prepared.errors) io.err(error);
        return 1;
      }
      const record = prepared.record;
      const historyPath = appendFilesTaskContractRecord(target, record);
      const message = `Wrote ${relative(target, historyPath).replace(/\\/g, '/')}; commit it separately before it can become a trusted baseline.`;
      if (opts.json) io.out(JSON.stringify({ ok: true, record, historyPath, warning: message }));
      else io.out(message);
      return 0;
    }

    if (sub === 'authorize-correction') {
      const taskId = positional[0];
      if (!taskId || !opts.expectPriorDigest || !opts.reason || !opts.authority || !opts.actor) {
        io.err('task authorize-correction requires <id>, --expect-prior-digest, --reason, --authority, and --actor');
        return EXIT_USAGE;
      }
      const filePath = taskPathForId(target, projectConfig, taskId);
      if (!existsSync(filePath)) {
        io.err(`Task record not found: ${relative(target, filePath).replace(/\\/g, '/')}`);
        return 1;
      }
      const body = readFileSync(filePath, 'utf8');
      const contract = taskContractDigest(body);
      if (!contract.ok) {
        io.err(contract.error);
        return 1;
      }
      const history = loadFilesTaskContractRecords(target, taskId);
      if (history.errors.length) {
        for (const error of history.errors) io.err(error);
        return 1;
      }
      const chain = trustedChainTerminal(history.trustedRecords, { taskId });
      if (!chain.ok) {
        for (const error of chain.errors) io.err(error);
        return 1;
      }
      if (chain.terminalDigest !== String(opts.expectPriorDigest).trim()) {
        io.err(`stale trusted chain: expected prior digest ${opts.expectPriorDigest}, committed chain terminal digest is ${chain.terminalDigest}`);
        return 1;
      }
      const changes = [];
      for (const field of new Set([...Object.keys(chain.terminalProjection ?? {}), ...Object.keys(contract.projection)])) {
        if (JSON.stringify(chain.terminalProjection?.[field]) !== JSON.stringify(contract.projection[field])) {
          changes.push({ field, oldValue: chain.terminalProjection?.[field], newValue: contract.projection[field] });
        }
      }
      if (changes.length === 0) {
        io.err('task-contract correction candidate does not change the protected contract');
        return 1;
      }
      const record = createTaskContractCorrectionRecord({
        recordId: `files-task-contract:${randomUUID()}`,
        taskId,
        priorDigest: chain.terminalDigest,
        resultingDigest: contract.digest,
        priorProjection: chain.terminalProjection,
        resultingProjection: contract.projection,
        changes,
        reason: String(opts.reason),
        authority: String(opts.authority),
        actor: String(opts.actor),
        affectedArtifact: relative(target, filePath).replace(/\\/g, '/'),
        timestamp: new Date().toISOString(),
      });
      // Validate the prospective correction against the committed chain
      // before writing; it becomes trusted only after a separate commit.
      const prospective = validateTaskContractBaseline(body, {
        lifecycle: 'transition',
        trustedRecords: history.trustedRecords,
        prospectiveRecords: [record],
      });
      if (!prospective.ok) {
        for (const error of prospective.errors) io.err(error);
        return 1;
      }
      const historyPath = appendFilesTaskContractRecord(target, record);
      const message = `Wrote ${relative(target, historyPath).replace(/\\/g, '/')}; commit it separately before it can become a trusted correction.`;
      if (opts.json) io.out(JSON.stringify({ ok: true, record, historyPath, warning: message }));
      else io.out(message);
      return 0;
    }

    if (sub === 'status') {
      const [taskId, nextStatus] = positional;
      if (!taskId || !nextStatus) {
        io.err('task status requires <id> and <status>');
        return EXIT_USAGE;
      }
      if (!FILES_TASK_STATUSES.has(nextStatus)) {
        io.err(`Invalid task status '${nextStatus}' (expected one of: ${[...FILES_TASK_STATUSES].join(', ')})`);
        return EXIT_USAGE;
      }
      if (!opts.expectDigest) {
        io.err('task status requires --expect-digest <sha256:...> read from the exact current task record.');
        io.err('Run "agenticloop task lint <id> --json" to read the current digest.');
        return EXIT_USAGE;
      }
      const blockCategory = frontmatterString(opts.blockCategory);
      if (nextStatus === 'blocked' && !blockCategory) {
        io.err("task status blocked requires --block-category <category>");
        return EXIT_USAGE;
      }
      const filePath = taskPathForId(target, projectConfig, taskId);
      const relPath = relative(target, filePath).replace(/\\/g, '/');
      if (!existsSync(filePath)) {
        io.err(`Task record not found: ${relPath}`);
        return 1;
      }
      const asJson = Boolean(opts.json);
      const domain = { task_id: taskId, status: nextStatus, file: relPath };
      const failure = (error, category = 'operational_error') =>
        printGateResult('task status', commandFailure('task status', error, category, domain, target), asJson, io);

      // --- 1. Current record integrity, before any candidate is constructed ---
      const currentContent = readFileSync(filePath, 'utf-8');
      const currentDigest = taskRecordDigest(currentContent);
      const root = evaluateTaskRecordRoot(currentContent);
      if (!root.ok) {
        return printGateResult('task status', {
          ok: false,
          diagnostics: root.diagnostics,
          errors: root.diagnostics.map(item => item.message),
          warnings: [],
          firstSafeRepair: root.firstSafeRepair,
          committedStateEvaluated: false,
          rollbackAuthorized: false,
          ...domain,
        }, asJson, io);
      }
      if (String(opts.expectDigest) !== currentDigest) {
        // The current record was read and compared, so committed state was
        // evaluated. Both carriers report this one condition identically.
        return failure(new PublicCommandError(
          staleCarrierDigestMessage(String(opts.expectDigest), currentDigest),
          STALE_CARRIER_DIGEST_CONTEXT
        ));
      }

      const { content: parsedContent, frontmatter } = readTaskRecord(filePath);
      const recordIdentity = frontmatterString(frontmatter.task_id);
      if (recordIdentity !== taskId) {
        const detail = `The requested task identity '${taskId}' differs from the materialized record identity '${recordIdentity || '(absent)'}' in ${relPath}.`;
        return failure(new PublicCommandError(detail, {
          code: 'task.record.identity_mismatch',
          evidenceState: 'negative',
          disposition: 'blocked',
          committedStateEvaluated: true,
          publicMessage: detail,
          safeRepair: 'Reconcile the record identity through the correction-authority path before requesting a status change.',
        }));
      }
      const currentStatus = frontmatterString(frontmatter.status);
      const transitionError = validateTaskStatusTransition(currentStatus, nextStatus, opts.note);
      if (transitionError) {
        return failure(new PublicCommandError(transitionError, TASK_TRANSITION_NEGATIVE_CONTEXT));
      }
      // Validate the complete current record before it can authorize a change.
      const currentDiagnostics = validateTaskRecordDiagnostics(currentContent, relPath);
      if (currentDiagnostics.length > 0) {
        return printGateResult('task status', {
          ok: false,
          diagnostics: currentDiagnostics,
          errors: currentDiagnostics.map(item => `Current task record is invalid: ${item.message}`),
          warnings: [],
          committedStateEvaluated: true,
          rollbackAuthorized: false,
          ...domain,
        }, asJson, io);
      }

      if (currentStatus === 'needs_revision' && nextStatus === 'in-progress') {
        const revisionErrors = validateFilesReviewControls(parsedContent, filePath.replace(/\\/g, '/'), {
          frontmatter,
          projectMapConfig: projectConfig,
          authorizingRevision: true,
        });
        if (revisionErrors.length > 0) {
          for (const error of revisionErrors) io.err(error);
          return 1;
        }
      }

      // --- 2. Exact readiness evidence, required for every record ---
      let evidenceContext = null;
      if (nextStatus === 'agent-ready' && currentStatus !== 'agent-ready') {
        try {
          assertLifecycleHandoffResolved(target);
        } catch (error) {
          if (error instanceof PublicCommandError) return failure(error);
          throw error;
        }
        let evidence;
        try {
          const base = readExplicitBaseEvidence(target, opts);
          const dependencies = readDependencyEvidence(target, opts.dependencies, taskId);
          // The one shared preparer. `task readiness-apply` calls it with a
          // prospective baseline entering the same commit; this standalone route
          // supplies none, so it still requires an already-committed trusted
          // chain exactly as before.
          evidence = prepareAgentReadyEvidence({
            target,
            taskId,
            relPath,
            currentContent,
            parsedContent,
            currentDigest,
            currentStatus,
            base,
            dependencies,
          });
        } catch (error) {
          if (error instanceof PublicCommandError) return failure(error);
          throw error;
        }
        evidenceContext = evidence.evidenceContext ?? null;
        if (!evidence.ok && evidence.stage === 'evidence_context') {
          return failure(new VerificationContextMalformedError(evidence.errors[0]));
        }
        // Blocking is represented structurally: readiness facts stay verbatim
        // and the gate outcome is the blocking signal, never role prose
        // prepended to a factual warning.
        if (!evidence.ok && evidence.stage === 'readiness') {
          const readiness = evidence.readiness;
          return printGateResult('task status', {
            ok: false,
            diagnostics: readiness.diagnostics,
            errors: readiness.errors,
            warnings: readiness.warnings,
            evidenceState: readiness.evidenceState,
            // Warnings alone still block agent-ready, so a 'proceed'
            // disposition from the readiness evaluator cannot be forwarded on a
            // failed gate result.
            disposition: readiness.disposition === 'proceed' ? 'blocked' : readiness.disposition,
            committedStateEvaluated: true,
            rollbackAuthorized: false,
            evidence_context: evidenceContext,
            ...domain,
          }, asJson, io);
        }
        // Entering agent-ready is always a lifecycle transition: even a
        // schema-less legacy task requires a trusted baseline chain first.
        if (!evidence.ok) {
          for (const error of evidence.errors) io.err(`Task cannot become agent-ready: ${error}`);
          return 1;
        }
      }

      // --- Role-start recognition, before any candidate is constructed ---
      //
      // Entering `in-progress` is the role start. Agentic Loop cannot stop a
      // host from invoking a role by hand, so this boundary decides only what
      // the record is allowed to claim: with a canonical packet the start is
      // recognized and bound; without one it stays an explicitly graded
      // `session_reported` observation that no later protected transition may
      // consume. A packet that is supplied but does not bind refuses the
      // mutation outright rather than degrading to the unrecognized form.
      // The requested status decides whether this is a role start, exactly as it
      // does on the GitHub carrier. Re-requesting a status the record already
      // holds is still a role start being claimed, so it is still recognized;
      // whether anything is written is the separate no-op decision below.
      let roleStartRecognition = null;
      let roleStartConsumption = null;
      let lifecycleHandoffRecognition = null;
      if (nextStatus === 'in-progress') {
        const recordContract = taskContractDigest(currentContent);
        try {
          const consumed = listDispatchConsumptions(target, taskId, { backend: 'files' });
          if (!consumed.ok) {
            throw new VerificationContextMalformedError(consumed.errors.join('; '));
          }
          const currentDispatch = opts.dispatchPacket
            ? await verifyCurrentDispatchPacket({
                target,
                io,
                taskId,
                packetPath: String(opts.dispatchPacket),
                hostTrustStore: opts.hostTrustStore,
              })
            : null;
          roleStartRecognition = recognizeRoleStart({
            target,
            io,
            backend: 'files',
            taskId,
            taskContractDigest: recordContract.ok ? recordContract.digest : null,
            dispatchCarrierDigest: currentDigest,
            packetPath: opts.dispatchPacket ? String(opts.dispatchPacket) : null,
            hostTrustStore: opts.hostTrustStore,
            validatePreparedDispatch: currentDispatch
              ? () => currentDispatch
              : null,
            consumedPacketIds: consumed.records.map(record => record.packetId),
            rawStartLabel: `raw role start requested for ${taskId} without a prepared dispatch`,
          });
        } catch (error) {
          if (error instanceof PublicCommandError) return failure(error);
          throw error;
        }
        if (!roleStartRecognition.recognized) {
          return printGateResult('task status', {
            ok: false,
            diagnostics: roleStartRecognition.diagnostics,
            errors: roleStartRecognition.diagnostics.map(item => item.message),
            warnings: [],
            evidenceState: roleStartRecognition.evidenceState,
            disposition: roleStartRecognition.disposition,
            committedStateEvaluated: true,
            rollbackAuthorized: false,
            handoff_recognition: roleStartRecognition,
            ...domain,
          }, asJson, io);
        }
      }

      if (nextStatus === 'closed' && currentStatus !== nextStatus) {
        const scope = resolveCanonicalTerminalScope({ target, config: projectConfig, taskId });
        if (!scope.decision.genericTerminalAllowed) {
          return failure(new PublicCommandError(
            genericTerminalRefusalMessage(scope),
            TASK_TRANSITION_NEGATIVE_CONTEXT
          ));
        }
      }

      // --- Acceptance gate for accepted/closed ---
      if ((nextStatus === 'accepted' || nextStatus === 'closed') &&
          currentStatus !== nextStatus) {
        const gateErrors = validateAcceptanceGate(parsedContent, filePath, verificationContext);
        if (gateErrors.length > 0) {
          for (const err of gateErrors) io.err(err);
          return 1;
        }
        const contract = taskContractDigest(currentContent);
        const history = loadFilesTaskContractRecords(target, taskId);
        lifecycleHandoffRecognition = recognizeLifecycleReturn({
          target,
          io,
          transition: nextStatus === 'accepted' ? 'acceptance' : 'closeout',
          backend: 'files',
          taskId,
          taskContractDigest: contract.ok ? contract.digest : null,
          currentCarrierDigest: currentDigest,
          productHead: implementationArtifactHead(currentContent),
          refetchTask: () => ({
            backend: 'files', taskId, carrier: relPath,
            body: readFileSync(filePath, 'utf8'),
            digest: taskRecordDigest(readFileSync(filePath, 'utf8')),
            trustedRecords: history.trustedRecords,
            trustedRecordErrors: history.errors,
          }),
          // By the time acceptance or closeout is legal, the workflow head has
          // legitimately advanced past the return: the durable return
          // verification record is committed, and the Maintainer review
          // provenance the acceptance gate requires is committed after it.
          // Rederive against the retained return head, exactly as terminal
          // closeout already does; ancestry, the product range and its
          // attribution, every workflow path in that range, and the Engineer
          // carrier-lineage terminal are all still reproved.
          refetchRepositoryEvidence: record => refetchFilesReturnEvidence(
            target,
            record.evidence.packet,
            record.evidence.repositoryEvidence,
            { historicalCloseout: true }
          ),
          hostTrustStore: opts.hostTrustStore,
        });
        if (!lifecycleHandoffRecognition.recognized) {
          return printGateResult('task status', {
            ok: false,
            diagnostics: lifecycleHandoffRecognition.diagnostics,
            errors: lifecycleHandoffRecognition.diagnostics.map(item => item.message),
            warnings: [],
            evidenceState: lifecycleHandoffRecognition.evidenceState,
            disposition: lifecycleHandoffRecognition.disposition,
            committedStateEvaluated: true,
            rollbackAuthorized: false,
            handoff_recognition: lifecycleHandoffRecognition,
            ...domain,
          }, asJson, io);
        }
      }

      // --- 3. Candidate construction and complete candidate validation ---
      // One shared candidate builder, used identically by the orchestrated
      // readiness transaction.
      const built = prepareTaskStatusCandidate({
        currentContent,
        relPath,
        nextStatus,
        blockCategory,
        note: opts.note && opts.note !== true ? String(opts.note) : null,
        appendNote: appendComment,
      });
      const candidate = built.candidate;
      const candidateDigest = built.candidateDigest;
      if (roleStartRecognition?.recognized) {
        roleStartConsumption = createDispatchConsumption({
          backend: 'files', taskId, recognition: roleStartRecognition,
          currentCarrierDigest: candidateDigest,
        });
      }
      if (!built.ok) {
        return printGateResult('task status', {
          ok: false,
          diagnostics: built.diagnostics,
          errors: built.diagnostics.map(item => `Task status candidate is invalid: ${item.message}`),
          warnings: [],
          committedStateEvaluated: true,
          rollbackAuthorized: false,
          ...domain,
        }, asJson, io);
      }

      const verificationOf = result => ({
        resultKind: VALIDATION_RESULT_KIND,
        digest: validationResultDigest(result),
      });
      const emitReceipt = receipt => {
        if (asJson) {
          io.out(JSON.stringify({
            ...domain,
            receipt,
            ...(roleStartRecognition ? { handoff_recognition: roleStartRecognition } : {}),
            ...(!roleStartRecognition && lifecycleHandoffRecognition
              ? { handoff_recognition: lifecycleHandoffRecognition }
              : {}),
          }, null, 2));
        } else {
          io.out(receipt.mutationDisposition === 'already_current'
            ? `${taskId} is already '${nextStatus}'; the validated record is unchanged.`
            : `Updated ${taskId} status to ${nextStatus}`);
          io.out(`  revalidate: ${receipt.revalidateCommand}`);
        }
        if (roleStartRecognition?.recognized && !asJson) {
          io.out(`  role start: recognized against ${roleStartRecognition.boundIdentity.packetId}`);
        }
        return receipt.unresolved ? 1 : 0;
      };

      // --- 4. Validated no-op: rerunning an already-current transition ---
      if (candidate === currentContent) {
        if (roleStartConsumption) {
          const recorded = executeMutationBatch(target, [
            { type: 'write', path: relPath, content: currentContent, expectedDigest: currentDigest, expectedKind: 'file' },
            {
              type: 'create',
              path: dispatchConsumptionRelativePath(roleStartConsumption),
              content: `${JSON.stringify(roleStartConsumption, null, 2)}\n`,
            },
          ]);
          if (!recorded.ok) {
            for (const error of recorded.errors) io.err(`task status failed: ${error}`);
            return 1;
          }
        }
        const result = createValidationResult({
          command: 'task status', ok: true, evidenceState: 'current', disposition: 'proceed', ...domain,
        });
        return emitReceipt(createTaskMutationReceipt({
          context: evidenceContext,
          backend: 'files',
          taskId,
          carrier: relPath,
          expectedDigest: currentDigest,
          candidateDigest,
          resultingDigest: currentDigest,
          verification: verificationOf(result),
          ownedProjections: ['task_record_status'],
          changedPaths: [],
          mutationDisposition: 'already_current',
          revalidateCommand: readinessRevalidationCommand({
            taskId, carrier: relPath, resultingDigest: currentDigest, context: evidenceContext,
          }),
        }));
      }

      // --- 5. Compare identity immediately before the atomic mutation ---
      const immediate = readFileSync(filePath, 'utf-8');
      if (taskRecordDigest(immediate) !== currentDigest) {
        return failure(new BaselineChangedError(
          `The task record changed between validation and mutation; nothing was written to ${relPath}.`
        ));
      }
      const mutationActions = [{
        type: 'write', path: relPath, content: candidate,
        expectedDigest: currentDigest, expectedKind: 'file',
      }];
      if (roleStartConsumption) mutationActions.push({
        type: 'create',
        path: dispatchConsumptionRelativePath(roleStartConsumption),
        content: `${JSON.stringify(roleStartConsumption, null, 2)}\n`,
      });
      const committed = executeMutationBatch(target, mutationActions);
      if (!committed.ok) {
        const rolledBack = committed.rollbackErrors.length === 0;
        const result = createValidationResult({
          command: 'task status', ok: false, evidenceState: 'negative',
          disposition: 'blocked', errors: committed.errors, ...domain,
        });
        const receipt = createTaskMutationReceipt({
          context: evidenceContext,
          backend: 'files',
          taskId,
          carrier: relPath,
          expectedDigest: currentDigest,
          candidateDigest,
          resultingDigest: null,
          verification: verificationOf(result),
          ownedProjections: ['task_record_status'],
          changedPaths: rolledBack ? [] : [relPath],
          mutationDisposition: rolledBack ? 'uncommitted' : 'partially_committed',
          recovery: rolledBack
            ? `The transaction rolled back; ${relPath} still holds ${currentDigest}. Repair the reported cause and rerun with the same expected digest.`
            : `The transaction failed and rollback reported errors. Inspect ${relPath} before any further mutation: ${committed.rollbackErrors.join('; ')}`,
          revalidateCommand: readinessRevalidationCommand({
            taskId, carrier: relPath, resultingDigest: currentDigest, context: evidenceContext,
          }),
        });
        for (const error of committed.errors) io.err(`task status failed: ${error}`);
        for (const error of committed.rollbackErrors) io.err(`rollback error: ${error}`);
        if (asJson) {
          io.out(JSON.stringify({
            ...domain,
            receipt,
            ...(roleStartRecognition ? { handoff_recognition: roleStartRecognition } : {}),
          }, null, 2));
        }
        return 1;
      }

      // --- 6. Refetch and fully validate the exact resulting bytes ---
      const resulting = readFileSync(filePath, 'utf-8');
      const resultingDigest = taskRecordDigest(resulting);
      const resultingRoot = evaluateTaskRecordRoot(resulting);
      const resultingDiagnostics = resultingRoot.ok
        ? validateTaskRecordDiagnostics(resulting, relPath)
        : resultingRoot.diagnostics;
      if (resulting !== candidate || resultingDiagnostics.length > 0) {
        // A post-write validation failure on bytes this operation still owns is
        // rolled back before reporting failure. If another writer replaced the
        // bytes, leave that external progress intact and describe it precisely.
        const rollback = resulting === candidate
          ? executeMutationBatch(target, [{
              type: 'write', path: relPath, content: currentContent,
              expectedDigest: resultingDigest, expectedKind: 'file',
            }])
          : null;
        const restored = rollback?.ok === true && readFileSync(filePath, 'utf8') === currentContent;
        const result = createValidationResult({
          command: 'task status', ok: false, evidenceState: 'changed', disposition: 'blocked',
          diagnostics: resultingDiagnostics,
          errors: resultingDiagnostics.length > 0
            ? resultingDiagnostics.map(item => item.message)
            : ['the committed record does not equal the validated candidate'],
          ...domain,
        });
        const receipt = createTaskMutationReceipt({
          context: evidenceContext,
          backend: 'files',
          taskId,
          carrier: relPath,
          expectedDigest: currentDigest,
          candidateDigest,
          resultingDigest: restored ? currentDigest : resultingDigest,
          verification: verificationOf(result),
          ownedProjections: ['task_record_status'],
          changedPaths: restored ? [] : [relPath],
          mutationDisposition: restored ? 'rolled_back' : 'unresolved',
          recovery: restored
            ? `The post-write validation failed and the transaction restored ${relPath} to ${currentDigest}; repair the candidate before retrying.`
            : `A mutation committed to ${relPath} (${resultingDigest}) but does not equal the validated candidate (${candidateDigest}). ` +
              'Preserve the file, compare it against the candidate, and repair it through the correction-authority path before any further transition.',
          revalidateCommand: readinessRevalidationCommand({
            taskId, carrier: relPath, resultingDigest: restored ? currentDigest : resultingDigest, context: evidenceContext,
          }),
        });
        io.err(restored
          ? `task status: ${relPath} failed final validation and was restored to its exact predecessor.`
          : `task status: ${relPath} was written but could not be revalidated against the exact candidate.`);
        io.err(receipt.recovery);
        if (asJson) io.out(JSON.stringify({ ...domain, receipt }, null, 2));
        return 1;
      }

      const result = createValidationResult({
        command: 'task status', ok: true, evidenceState: 'current', disposition: 'proceed', ...domain,
      });
      return emitReceipt(createTaskMutationReceipt({
        context: evidenceContext,
        backend: 'files',
        taskId,
        carrier: relPath,
        expectedDigest: currentDigest,
        candidateDigest,
        resultingDigest,
        verification: verificationOf(result),
        ownedProjections: ['task_record_status'],
        changedPaths: committed.writtenFiles,
        mutationDisposition: 'committed',
        revalidateCommand: readinessRevalidationCommand({
          taskId, carrier: relPath, resultingDigest, context: evidenceContext,
        }),
      }));
    }

    io.err(`Unknown task subcommand '${sub}'. Expected: list, lint, new, establish-baseline, authorize-correction, prepare-decomposition, prepare-dispatch, handoff-preflight, refresh-handoff-evidence, prepare-return, verify-return, check-evidence-init, check-evidence-show, check-evidence-update, evidence, review-prepare, status.`);
    return EXIT_USAGE;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    return printGateResult(`task ${sub}`, commandFailure(`task ${sub}`, error, 'operational_error', {}, target), Boolean(opts?.json), io);
  }
}
