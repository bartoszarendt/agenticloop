import {
  existsSync,
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
import { resolveTaskBackend } from './task-backend.js';
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
  VerificationContextError,
  VerificationContextMalformedError,
  VerificationContextStaleError,
  VerificationContextUnsupportedBoundaryError,
  publicErrorFromFindings,
} from './public-error.js';
import { commandFailure, printGateResult } from './public-result.js';
import { presentGateResultForTarget } from './diagnostic-presentation.js';
import { canonicalJson } from './canonical-json.js';
import { loadAgenticLoopConfig } from './json.js';
import { buildHostRoleCapabilityInventory } from './host-role-capabilities.js';
import { resolveWorkflowRoleRegistry } from './workflow-roles.js';
import {
  createTaskReadinessEvidence,
  createTaskEvidenceContext,
  createTaskMutationReceipt,
  dependencyStatusMap,
  parseDependencySnapshot,
  shellQuoteArgument,
} from './task-evidence-contract.js';
import { evaluateCommitAttribution } from './commit-attribution.js';
import { evaluateTaskRecordRoot } from './task-record-root.js';
import { fileMatchesScopePattern } from './scope-matcher.js';
import { createValidationResult, validationResultDigest, VALIDATION_RESULT_KIND } from './result-envelope.js';
import { COMMAND_REGISTRY, parseCommandArgs, suggestName } from './cli-registry.js';
import { evaluateTaskReadiness } from './task-readiness.js';
import { executeMutationBatch } from './fs-mutation-kernel.js';
import { createTaskContractBaselineRecord, createTaskContractCorrectionRecord, taskContractDigest, trustedChainTerminal, validActivationCaptureRef, validateTaskContractBaseline } from './task-contract-baseline.js';
import { appendFilesTaskContractRecord, loadFilesTaskContractRecords } from './files-task-contract.js';
import { resolveCanonicalTerminalScope } from './terminal-scope.js';
import { validateTaskStatusTransition } from './task-transition.js';
import { assertLifecycleHandoffResolved } from './lifecycle-plan.js';
import {
  activationCapabilityInventory,
  activationCaptureDisposition,
  prepareRoleDispatch,
  receiveRoleReturn,
  validateActivationCapture,
  verifyDispatchBeforeMutation,
} from './dispatch-envelope.js';
import { loadHostTrustStore, targetRepositoryIdentity } from './host-trust.js';
import { CommitRangeError, deriveCommitRange } from './commit-range.js';
import { gitTreeObjectId, isGitObjectId } from './git-oid.js';
import { verifyCommittedAttributedSource } from './committed-source.js';

function frontmatterString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function taskLintCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf-8', ...options });
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

function guardFilesBackend(target, io) {
  const resolution = resolveTaskBackend(target);
  for (const warning of resolution.warnings) io.warn(`  WARN: ${warning}`);
  if (resolution.backend !== 'files') {
    const message = resolution.backend === 'github'
      ? "Active task backend is 'github'. `agenticloop task` v1 supports the files backend only; " +
        "use GitHub issues/PRs for task operations in this project."
      : `Active task backend is '${resolution.backend}'. \`agenticloop task\` v1 supports the files backend only.`;
    return { ok: false, message };
  }
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

/** Digest of one exact task-record byte sequence. */
function taskRecordDigest(content) {
  return `sha256:${createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')}`;
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

function resolveEffectiveHostRoleCapabilities(target) {
  const config = loadAgenticLoopConfig(join(target, 'agenticloop.json'));
  return buildHostRoleCapabilityInventory({
    adapterConfigs: config.adapters ?? {},
  });
}

function resolveEffectiveWorkflowRegistry(target) {
  return resolveWorkflowRoleRegistry(
    loadAgenticLoopConfig(join(target, 'agenticloop.json'))
  );
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
  return args => spawnSync('git', args, { cwd: target, encoding: 'utf8' });
}

function refetchDispatchRepository(target, readiness) {
  const baseTree = gitTreeObjectId(readiness?.evidence?.base?.identity);
  if (!baseTree) throw new VerificationContextMalformedError('dispatch readiness must bind a full git-tree base identity');
  const verifiedTree = spawnSync('git', ['rev-parse', '--verify', `${baseTree}^{tree}`], { cwd: target, encoding: 'utf8' });
  if (verifiedTree.status !== 0 || String(verifiedTree.stdout ?? '').trim() !== baseTree) {
    throw new VerificationContextStaleError(`dispatch base tree '${baseTree}' is unavailable or changed`);
  }
  const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: target, encoding: 'utf8' });
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: target, encoding: 'utf8' });
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
 * Reconstruct files-backed return evidence from current durable Git state.
 * Host-signed checks remain transport evidence; repository identity, paths, and
 * attribution are always derived again before the receipt is authenticated.
 */
function refetchFilesReturnEvidence(target, packet, signedEvidence) {
  const readGit = (args, label) => {
    const result = spawnSync('git', args, { cwd: target, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new VerificationContextStaleError(`${label} is unavailable: ${String(result.stderr ?? '').trim()}`);
    }
    return String(result.stdout ?? '').trim();
  };
  const branch = readGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], 'current return branch');
  const head = readGit(['rev-parse', '--verify', 'HEAD'], 'current return head');
  if (!isGitObjectId(head)) throw new VerificationContextMalformedError('current return head is not a full Git identity');
  for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
    const dirty = spawnSync('git', args, { cwd: target, encoding: 'utf8' });
    if (dirty.status !== 0) throw new VerificationContextStaleError('tracked repository state changed after the role-return evidence was collected');
  }
  const untracked = readGit(['ls-files', '--others', '--exclude-standard'], 'untracked return paths')
    .split(/\r?\n/)
    .filter(Boolean);
  const untrackedInScope = untracked.filter(path =>
    (packet?.task?.allowedPaths ?? []).some(pattern => fileMatchesScopePattern(path, pattern))
  );
  if (untrackedInScope.length > 0) {
    throw new VerificationContextStaleError(`untracked task-scope paths are not represented by durable return evidence: ${untrackedInScope.join(', ')}`);
  }
  const baseHead = packet?.repository?.head;
  if (!isGitObjectId(baseHead)) throw new VerificationContextMalformedError('dispatch packet lacks a full return base identity');
  // One canonical derivation proves contiguous ancestry before it lists commits,
  // changed paths, or trailers, so a reset or rebase cannot present a truncated
  // range as the returned work.
  const derived = deriveCommitRange({
    runGit: targetGitRunner(target),
    baseHead,
    head,
    taskId: packet?.task?.id,
    roleId: packet?.assignment?.roleId,
  });
  if (!derived.ok) {
    throw derived.evidenceState === 'malformed'
      ? new VerificationContextMalformedError(derived.message)
      : new VerificationContextStaleError(derived.message);
  }
  return {
    backend: 'files',
    task: signedEvidence?.task,
    worktree: resolve(target),
    branch,
    baseHead,
    head,
    changedPaths: derived.changedPaths,
    attribution: { range: derived.range, commits: derived.commits },
    checks: signedEvidence?.checks,
    pr: { state: 'not_applicable', number: null, url: null },
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
  const tree = spawnSync('git', ['rev-parse', '--verify', `${ref}^{tree}`], { cwd: target, encoding: 'utf8' });
  const treeOid = String(tree.stdout ?? '').trim();
  if (tree.status !== 0 || !isGitObjectId(treeOid)) {
    throw new VerificationContextMalformedError(`Base ref '${ref}' cannot be resolved to an exact Git tree object id.`);
  }
  const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', treeOid], { cwd: target, encoding: 'utf8' });
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
      'An agent-ready transition requires --dependencies <path> naming the exact dependency-status snapshot.',
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

function appendComment(content, note) {
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
    io.err(suggestion
      ? `task: unknown subcommand '${sub}'. Did you mean '${suggestion}'?`
      : 'task requires a subcommand: list, lint, new, establish-baseline, authorize-correction, prepare-dispatch, verify-return, status.');
    io.err('Run "agenticloop help task" for usage.');
    return EXIT_USAGE;
  }
  const { opts, positional } = parseCommandArgs(`task ${sub}`, TASK_SUBCOMMANDS[sub], args.slice(1));
  const target = resolveCliTarget(io, opts.target);
  const guard = guardFilesBackend(target, io);
  if (!guard.ok) {
    io.err(guard.message);
    return 1;
  }

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
              safeRepair: 'Use --scaffold for non-activated Markdown scaffolding, or obtain a fresh task-bound capture from a supported host adapter. Never edit or author capture JSON.',
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

    if (sub === 'prepare-dispatch') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId || (!opts.input && !opts.packet) || (opts.input && opts.packet)) {
        io.err('task prepare-dispatch requires <id> and exactly one of --input <dispatch-input.json> or --packet <packet.json>');
        return EXIT_USAGE;
      }
      const readJson = (relPath, label) => {
        try {
          return JSON.parse(readFileSync(resolve(target, String(relPath)), 'utf8'));
        } catch (error) {
          throw new VerificationContextMalformedError(`${label} is unreadable or invalid JSON: ${error.message}`);
        }
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
      const filePath = taskPathForId(target, projectConfig, taskId);
      const carrier = relative(target, filePath).replace(/\\/g, '/');
      const refetchTask = () => {
        if (!existsSync(filePath)) throw new VerificationContextError(`task record not found: ${carrier}`);
        const body = readFileSync(filePath, 'utf8');
        const history = loadFilesTaskContractRecords(target, taskId);
        return {
          backend: 'files', taskId, carrier, body, digest: taskRecordDigest(body),
          trustedRecords: history.trustedRecords,
          trustedRecordErrors: history.errors,
        };
      };
      const refetchReadiness = ({ snapshot }) => refetchDispatchReadiness(
        target,
        snapshot,
        input?.readiness ?? packet?.readiness
      );
      const refetchRepository = ({ readiness }) => refetchDispatchRepository(target, readiness);
      const refetchDecomposition = ({ snapshot }) => refetchDispatchDecomposition(
        target,
        input?.decomposition ?? packet?.decomposition,
        snapshot.taskId
      );
      const readCarrierDigest = relPath => {
        const carrierPath = resolve(target, String(relPath));
        if (!existsSync(carrierPath)) return null;
        return taskRecordDigest(readFileSync(carrierPath, 'utf8'));
      };
      // The activation capture is read from the task's own authoring reference,
      // never from the dispatch request: a caller cannot substitute a capture for
      // the one the authored contract is bound to.
      const refetchActivation = ({ snapshot }) => {
        const contract = taskContractDigest(snapshot.body);
        if (!contract.ok) throw new VerificationContextMalformedError(contract.error);
        const ref = contract.projection.activation_capture_ref;
        if (!ref) {
          throw new VerificationContextError(
            `task '${snapshot.taskId}' has no activation_capture_ref; it cannot authorize dispatch in this state, and when no separately authorized activation-binding conversion exists a fresh activation-bound task is required`
          );
        }
        const capture = readActivationCaptureInput(target, ref, capabilities, snapshot.taskId);
        if (capture.normalizedActivationDigest !== contract.projection.activation_input_digest) {
          throw new VerificationContextStaleError(
            `activation capture '${ref}' no longer matches the task contract activation_input_digest`
          );
        }
        return capture;
      };
      const stateInputs = {
        runGit: targetGitRunner(target),
        priorGateReceipts,
        readCarrierDigest,
        refetchActivation,
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
        }, { capabilities, hostRoleCapabilities });
      } else {
        prepared = prepareRoleDispatch({
          refetchTask,
          refetchReadiness,
          refetchRepository,
          refetchDecomposition,
          ...stateInputs,
          activation: input?.activation,
          assignment: input?.assignment,
        }, { capabilities, hostRoleCapabilities });
      }
      const presentedValidation = presentGateResultForTarget(prepared.validation, target);
      if (asJson) {
        if (prepared.ok && opts.packet) printGateResult('task prepare-dispatch', presentedValidation, true, io);
        else if (prepared.ok) io.out(JSON.stringify(prepared.packet, null, 2));
        else printGateResult('task prepare-dispatch', presentedValidation, true, io);
      }
      else if (prepared.ok) io.out(JSON.stringify(prepared.packet, null, 2));
      else for (const error of prepared.validation.errors) io.err(error);
      return prepared.ok ? 0 : 1;
    }

    if (sub === 'verify-return') {
      const taskId = positional[0];
      const asJson = Boolean(opts.json);
      if (!taskId || !opts.packet || !opts.return) {
        io.err('task verify-return requires <id>, --packet <packet.json>, and --return <role-return.json>');
        return EXIT_USAGE;
      }
      const readJsonText = (relPath, label) => {
        try {
          return readFileSync(resolve(target, String(relPath)), 'utf8');
        } catch (error) {
          throw new VerificationContextMalformedError(`${label} is unreadable: ${error.message}`);
        }
      };
      let packet;
      let raw;
      let repositoryEvidence = null;
      let producerReceipt = null;
      let redelegationAuthority = null;
      let recovery = null;
      let humanDisposition = null;
      let exceptionalVerification = null;
      let exceptionalReceipt = null;
      let capabilities;
      let hostRoleCapabilities;
      let workflowRoleRegistry;
      try {
        packet = JSON.parse(readJsonText(opts.packet, 'dispatch packet'));
        raw = readJsonText(opts.return, 'role return');
        capabilities = resolveActivationCapabilities(target, io, opts.hostTrustStore);
        hostRoleCapabilities = resolveEffectiveHostRoleCapabilities(target);
        workflowRoleRegistry = resolveEffectiveWorkflowRegistry(target);
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
      } catch (error) {
        return printGateResult('task verify-return', commandFailure('task verify-return', error, 'operational_error', {}, target), asJson, io);
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
      const filePath = taskPathForId(target, projectConfig, taskId);
      const carrier = relative(target, filePath).replace(/\\/g, '/');
      const refetchTask = () => {
        if (!existsSync(filePath)) throw new VerificationContextError(`task record not found: ${carrier}`);
        const body = readFileSync(filePath, 'utf8');
        const history = loadFilesTaskContractRecords(target, taskId);
        return { backend: 'files', taskId, carrier, body, digest: taskRecordDigest(body), trustedRecords: history.trustedRecords, trustedRecordErrors: history.errors };
      };
      const refetchRepositoryEvidence = repositoryEvidence
        ? () => refetchFilesReturnEvidence(target, packet, repositoryEvidence)
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
      }, { capabilities, hostRoleCapabilities });
      const presentedValidation = presentGateResultForTarget(received.validation, target);
      if (asJson) printGateResult('task verify-return', presentedValidation, true, io);
      else if (received.ok && received.exceptional?.state === 'exception_requested') {
        // A valid exception request is routed, not granted. Do not print a
        // "current"/proceed message that implies the next transition.
        io.out(
          `Exceptional verification recorded as exception_requested; routed to ${received.exceptional.route.ownerRole} ` +
          `for disposition. No exception has been accepted or rejected and no further authority is granted.`
        );
      } else if (received.ok) io.out('Role return is current.');
      else for (const error of received.validation.errors) io.err(error);
      return received.ok ? 0 : 1;
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
      const record = createTaskContractBaselineRecord({
        recordId: `files-task-contract:${randomUUID()}`,
        taskId,
        digest: contract.digest,
        projection: contract.projection,
        authority: String(opts.authority),
        actor: String(opts.actor),
        timestamp: new Date().toISOString(),
        affectedArtifact: relative(target, filePath).replace(/\\/g, '/'),
      });
      // A second baseline is never created over trusted history: validate the
      // prospective record against the committed chain before writing.
      const prospective = validateTaskContractBaseline(body, {
        lifecycle: 'legacy',
        trustedRecords: history.trustedRecords,
        prospectiveRecords: [record],
      });
      if (!prospective.ok) {
        for (const error of prospective.errors) io.err(error);
        return 1;
      }
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
        return failure(new BaselineChangedError(
          `Stale task record: expected ${String(opts.expectDigest)}, the current digest is ${currentDigest}.`
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
        io.err(transitionError);
        return 1;
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
        let base;
        let dependencies;
        try {
          base = readExplicitBaseEvidence(target, opts);
          dependencies = readDependencyEvidence(target, opts.dependencies, taskId);
        } catch (error) {
          if (error instanceof PublicCommandError) return failure(error);
          throw error;
        }
        try {
          evidenceContext = createTaskEvidenceContext({
            backend: 'files',
            task: { id: taskId, carrier: relPath, expectedDigest: currentDigest },
            transition: { fromStatus: currentStatus, toStatus: nextStatus },
            base: base.evidence,
            dependencies: dependencies.evidence,
          });
        } catch (error) {
          return failure(new VerificationContextMalformedError(error.message));
        }
        const readiness = evaluateTaskReadiness({
          taskBody: parsedContent,
          basePaths: base.paths,
          mode: 'authoring',
          dependencies: dependencies.statuses,
        });
        // Blocking is represented structurally: readiness facts stay verbatim
        // and the gate outcome is the blocking signal, never role prose
        // prepended to a factual warning.
        if (readiness.errors.length > 0 || readiness.warnings.length > 0) {
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
        const history = loadFilesTaskContractRecords(target, taskId);
        const baseline = validateTaskContractBaseline(currentContent, {
          lifecycle: 'transition',
          trustedRecords: history.trustedRecords,
          trustedRecordErrors: history.errors,
        });
        if (!baseline.ok) {
          for (const error of baseline.errors) io.err(`Task cannot become agent-ready: ${error}`);
          return 1;
        }
      }

      if (nextStatus === 'closed' && currentStatus !== nextStatus) {
        const scope = resolveCanonicalTerminalScope({ target, config: projectConfig, taskId });
        if (!scope.decision.genericTerminalAllowed) {
          const reason = scope.reasons[0] ??
            `the task belongs to a ${scope.scopeKind} closeout scope, whose terminal transition is closeout-owned`;
          io.err(
            `Generic task closure is refused (${scope.scopeKind}/${scope.auditMode}): ${reason}. ` +
            'Use closeout prepare and closeout record after repairing and re-deriving scope where required.'
          );
          return 1;
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
      }

      // --- 3. Candidate construction and complete candidate validation ---
      let candidate = replaceFrontmatterField(currentContent, 'status', nextStatus);
      candidate = nextStatus === 'blocked'
        ? replaceFrontmatterField(candidate, 'block_category', blockCategory)
        : replaceFrontmatterField(candidate, 'block_category', null);
      if (opts.note && opts.note !== true) {
        candidate = appendComment(candidate, String(opts.note));
      }
      const candidateDigest = taskRecordDigest(candidate);
      const candidateRoot = evaluateTaskRecordRoot(candidate);
      const candidateDiagnostics = candidateRoot.ok
        ? validateTaskRecordDiagnostics(candidate, relPath)
        : candidateRoot.diagnostics;
      if (candidateDiagnostics.length > 0) {
        return printGateResult('task status', {
          ok: false,
          diagnostics: candidateDiagnostics,
          errors: candidateDiagnostics.map(item => `Task status candidate is invalid: ${item.message}`),
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
        if (asJson) io.out(JSON.stringify({ ...domain, receipt }, null, 2));
        else {
          io.out(receipt.mutationDisposition === 'already_current'
            ? `${taskId} is already '${nextStatus}'; the validated record is unchanged.`
            : `Updated ${taskId} status to ${nextStatus}`);
          io.out(`  revalidate: ${receipt.revalidateCommand}`);
        }
        return receipt.unresolved ? 1 : 0;
      };

      // --- 4. Validated no-op: rerunning an already-current transition ---
      if (candidate === currentContent) {
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
      const committed = executeMutationBatch(target, [{ type: 'write', path: relPath, content: candidate }]);
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
        if (asJson) io.out(JSON.stringify({ ...domain, receipt }, null, 2));
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
          resultingDigest,
          verification: verificationOf(result),
          ownedProjections: ['task_record_status'],
          changedPaths: [relPath],
          mutationDisposition: 'unresolved',
          recovery: `A mutation committed to ${relPath} (${resultingDigest}) but does not equal the validated candidate (${candidateDigest}). ` +
            'Preserve the file, compare it against the candidate, and repair it through the correction-authority path before any further transition.',
          revalidateCommand: readinessRevalidationCommand({
            taskId, carrier: relPath, resultingDigest, context: evidenceContext,
          }),
        });
        io.err(`task status: ${relPath} was written but could not be revalidated against the exact candidate.`);
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

    io.err(`Unknown task subcommand '${sub}'. Expected: list, lint, new, establish-baseline, authorize-correction, prepare-dispatch, verify-return, status.`);
    return EXIT_USAGE;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    return printGateResult(`task ${sub}`, commandFailure(`task ${sub}`, error, 'operational_error', {}, target), Boolean(opts?.json), io);
  }
}
