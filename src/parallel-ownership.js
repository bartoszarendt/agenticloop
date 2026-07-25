/**
 * Structured ownership and managed-join checks for parallel implementation
 * lanes. These helpers deliberately prove only mechanical facts; Maintainer
 * classification remains required for code and semantic joinability.
 */

import { parseFrontmatter } from './frontmatter.js';
import { markdownSection } from './markdown.js';
import {
  fileMatchesScopePattern,
  isFileInScope,
  isSafeScopePattern,
  parseScopePatterns,
} from './scope-matcher.js';

export const TASK_PARALLEL_ELIGIBILITY = new Set(['eligible', 'blocked', 'unknown']);
export const PAIRWISE_PARALLEL_RELATIONS = new Set(['disjoint', 'managed_join', 'blocked', 'unknown']);
export const MANAGED_MUTATION_OPERATIONS = new Set(['add_export', 'add_json_key']);

const GLOB_PATTERN = /[*?]/;
const EXACT_SHA = /^[0-9a-f]{40}$/i;
const INELIGIBLE_MANAGED_PATH = /(?:^|\/)(?:\.agenticloop|migrations?|generated|dist|build|coverage)(?:\/|$)|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|composer\.lock|cargo\.lock|gemfile\.lock)$/i;

function normalizePath(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/').trim() : '';
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function isExactFile(path) {
  return isSafeScopePattern(path) && !GLOB_PATTERN.test(path) && !path.endsWith('/');
}

function normalizeStringArray(value, fieldName, errors) {
  if (!Array.isArray(value)) {
    errors.push(`'${fieldName}' must be a YAML list`);
    return null;
  }

  const values = [];
  for (const raw of value) {
    if (!isSafeScopePattern(raw)) {
      errors.push(`unsafe or malformed pattern in '${fieldName}': ${JSON.stringify(raw)}`);
      continue;
    }
    values.push(normalizePath(raw));
  }
  return values;
}

/**
 * Conservative proof that every file represented by a candidate ownership
 * pattern remains inside at least one allowed scope pattern. An inconclusive
 * glob relation is rejected rather than assumed safe.
 */
export function isScopePatternContained(candidate, allowedPatterns) {
  const normalized = normalizePath(candidate);
  if (!normalized || !Array.isArray(allowedPatterns)) return false;
  if (!GLOB_PATTERN.test(normalized)) return isFileInScope(normalized, allowedPatterns);

  return allowedPatterns.some(rawAllowed => {
    const allowed = normalizePath(rawAllowed);
    if (allowed === '**' || allowed === normalized) return true;
    if (allowed.endsWith('/') && normalized.startsWith(allowed)) return true;
    if (allowed.endsWith('/**') && normalized.startsWith(allowed.slice(0, -2))) return true;
    return false;
  });
}

function isValidMutationTarget(operation, target) {
  if (typeof target !== 'string' || !target.trim()) return false;
  if (operation === 'add_export') return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(target);
  return /^scripts\.[A-Za-z0-9:_-]+$/.test(target);
}

function parseSharedMutations(value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push("'shared_mutations' must be a mapping of exact file paths to operation objects");
    return null;
  }

  const mutations = [];
  for (const [rawPath, rawMutation] of Object.entries(value)) {
    const path = normalizePath(rawPath);
    if (!isExactFile(path)) {
      errors.push(`'shared_mutations' path must be a safe exact file, not a glob: ${JSON.stringify(rawPath)}`);
      continue;
    }
    if (INELIGIBLE_MANAGED_PATH.test(path)) {
      errors.push(`'shared_mutations' path is ineligible for managed join: '${path}'`);
      continue;
    }
    if (!rawMutation || typeof rawMutation !== 'object' || Array.isArray(rawMutation)) {
      errors.push(`'shared_mutations.${rawPath}' must be an operation object`);
      continue;
    }
    const keys = Object.keys(rawMutation);
    if (keys.some(key => key !== 'operation' && key !== 'target')) {
      errors.push(`'shared_mutations.${rawPath}' may contain only 'operation' and 'target'`);
      continue;
    }
    const operation = typeof rawMutation.operation === 'string' ? rawMutation.operation.trim() : '';
    const target = typeof rawMutation.target === 'string' ? rawMutation.target.trim() : '';
    if (!MANAGED_MUTATION_OPERATIONS.has(operation)) {
      errors.push(`'shared_mutations.${rawPath}.operation' must be one of: ${[...MANAGED_MUTATION_OPERATIONS].join(', ')}`);
      continue;
    }
    if (!isValidMutationTarget(operation, target)) {
      errors.push(`'shared_mutations.${rawPath}.target' is not a precise target for '${operation}'`);
      continue;
    }
    if (path === 'package.json' && operation !== 'add_json_key') {
      errors.push("'package.json' managed mutations must use operation 'add_json_key'");
      continue;
    }
    if (operation === 'add_json_key' && path !== 'package.json') {
      errors.push("'add_json_key' managed mutations are limited to 'package.json'");
      continue;
    }
    mutations.push({ path, operation, target });
  }
  return mutations;
}

function parseSafetyField(taskBody, label) {
  const section = markdownSection(String(taskBody ?? ''), '## Parallel Safety')?.body;
  if (section === undefined) return null;
  const pattern = new RegExp(`^\\s*[-*]\\s*\\*\\*${label}\\*\\*\\s*:\\s*([^\\r\\n]+)`, 'im');
  return section.match(pattern)?.[1]?.trim().toLowerCase() ?? '';
}

/**
 * Parse the ownership projection from a task record. Declarations remain
 * optional for historical/serial tasks, but malformed declarations are errors
 * and absence produces an unknown parallel-eligibility input.
 */
export function parseOwnershipDeclaration(taskBody) {
  const errors = [];
  const [frontmatter] = parseFrontmatter(String(taskBody ?? ''));
  if (!frontmatter) {
    return {
      present: false,
      ownedPaths: null,
      sharedMutations: null,
      allowedPaths: null,
      eligibility: null,
      knowledgeCoupling: null,
      errors: [],
    };
  }

  const scope = parseScopePatterns(taskBody);
  if (scope?.error) errors.push(scope.error);
  const allowedPaths = scope?.patterns ?? null;

  let ownedPaths = null;
  if (hasOwn(frontmatter, 'owned_paths')) {
    ownedPaths = normalizeStringArray(frontmatter.owned_paths, 'owned_paths', errors);
  }

  let sharedMutations = null;
  if (hasOwn(frontmatter, 'shared_mutations')) {
    sharedMutations = parseSharedMutations(frontmatter.shared_mutations, errors);
  }

  if (allowedPaths) {
    for (const path of ownedPaths ?? []) {
      if (!isScopePatternContained(path, allowedPaths)) {
        errors.push(`'owned_paths' entry '${path}' is not mechanically contained by allowed_paths`);
      }
    }
    for (const mutation of sharedMutations ?? []) {
      if (!isFileInScope(mutation.path, allowedPaths)) {
        errors.push(`'shared_mutations' path '${mutation.path}' is not contained by allowed_paths`);
      }
    }
  }

  const rawEligibility = parseSafetyField(taskBody, 'Parallel eligibility');
  const rawKnowledgeCoupling = parseSafetyField(taskBody, 'Knowledge coupling');
  if (rawEligibility && !TASK_PARALLEL_ELIGIBILITY.has(rawEligibility)) {
    errors.push("'Parallel eligibility' must be eligible, blocked, or unknown");
  }
  if (rawKnowledgeCoupling && !['independent', 'coupled', 'unknown'].includes(rawKnowledgeCoupling)) {
    errors.push("'Knowledge coupling' must be independent, coupled, or unknown");
  }

  return {
    present: hasOwn(frontmatter, 'owned_paths') || hasOwn(frontmatter, 'shared_mutations'),
    ownedPaths,
    sharedMutations,
    allowedPaths,
    eligibility: TASK_PARALLEL_ELIGIBILITY.has(rawEligibility) ? rawEligibility : null,
    knowledgeCoupling: ['independent', 'coupled', 'unknown'].includes(rawKnowledgeCoupling)
      ? rawKnowledgeCoupling
      : null,
    errors,
  };
}

/** Return the Maintainer-owned per-task mutation eligibility input. */
export function evaluateTaskEligibility(declaration) {
  if (!declaration || declaration.errors?.length) return 'blocked';
  if (declaration.eligibility === 'blocked') return 'blocked';
  if (declaration.eligibility !== 'eligible') return 'unknown';
  const hasExclusiveOwnership = Array.isArray(declaration.ownedPaths) && declaration.ownedPaths.length > 0;
  const hasSharedOwnership = Array.isArray(declaration.sharedMutations) && declaration.sharedMutations.length > 0;
  if (!hasExclusiveOwnership && !hasSharedOwnership) return 'unknown';
  return 'eligible';
}

function literalPrefix(pattern) {
  const normalized = normalizePath(pattern);
  const index = normalized.search(GLOB_PATTERN);
  return index === -1 ? normalized : normalized.slice(0, index);
}

/**
 * Resolve a path relation only when it is mechanically provable. Unknown is
 * intentionally preserved for broad overlapping glob patterns.
 */
export function classifyPathRelation(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return 'unknown';
  if (a === b) return 'overlap';
  if (!GLOB_PATTERN.test(a) && !GLOB_PATTERN.test(b)) return 'disjoint';
  if (!GLOB_PATTERN.test(a)) return fileMatchesScopePattern(a, b) ? 'overlap' : 'disjoint';
  if (!GLOB_PATTERN.test(b)) return fileMatchesScopePattern(b, a) ? 'overlap' : 'disjoint';

  const aPrefix = literalPrefix(a);
  const bPrefix = literalPrefix(b);
  if (aPrefix && bPrefix && !aPrefix.startsWith(bPrefix) && !bPrefix.startsWith(aPrefix)) {
    return 'disjoint';
  }
  return 'unknown';
}

function changedPathAllowed(path, declaration) {
  if (declaration.ownedPaths?.some(pattern => fileMatchesScopePattern(path, pattern))) return true;
  return declaration.sharedMutations?.some(mutation => mutation.path === path) ?? false;
}

/** Validate a lane's actual artifact diff against its exact write declaration. */
export function validateChangedPathsAgainstOwnership(changedPaths, declaration) {
  if (!declaration?.present) {
    return { ok: false, errors: ['structured ownership is missing; run one bounded read-only discovery pass before parallel writes'], unexpected: [] };
  }
  if (declaration.errors?.length) {
    return { ok: false, errors: [...declaration.errors], unexpected: [] };
  }
  if (!Array.isArray(changedPaths)) {
    return { ok: false, errors: ['artifact changed-file list is unavailable'], unexpected: [] };
  }
  const unexpected = changedPaths.map(normalizePath).filter(path => path && !changedPathAllowed(path, declaration));
  return {
    ok: unexpected.length === 0,
    errors: unexpected.map(path => `artifact changed undeclared path '${path}'`),
    unexpected,
  };
}

function additiveLineDifference(baseLines, headLines) {
  let baseIndex = 0;
  const added = [];
  for (const line of headLines) {
    if (baseIndex < baseLines.length && line === baseLines[baseIndex]) {
      baseIndex += 1;
    } else {
      added.push(line);
    }
  }
  return { preservesBase: baseIndex === baseLines.length, added };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isExactExportAddition(line, target) {
  const trimmed = line.trim();
  const symbol = escapeRegExp(target);
  if (!new RegExp(`\\b${symbol}\\b`).test(trimmed)) return false;
  return [
    new RegExp(`^export\\s+(?:type\\s+)?\\{[^}]*\\b${symbol}\\b[^}]*\\}(?:\\s+from\\s+['\"][^'\"]+['\"])?;?$`),
    new RegExp(`^export\\s+\\*\\s+as\\s+${symbol}\\s+from\\s+['\"][^'\"]+['\"];?$`),
    new RegExp(`^from\\s+[A-Za-z0-9_.]+\\s+import\\s+.*\\b${symbol}\\b`),
    new RegExp(`^__all__\\s*=\\s*.*(?:['\"]${symbol}['\"]).*$`),
    new RegExp(`^__all__\\.append\\(\\s*['\"]${symbol}['\"]\\s*\\)$`),
  ].some(pattern => pattern.test(trimmed));
}

function deepEqualJson(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqualJson(left[key], right[key]));
}

function validateAddExport(mutation, baseContent, headContent) {
  const baseLines = String(baseContent).replace(/\r\n/g, '\n').split('\n');
  const headLines = String(headContent).replace(/\r\n/g, '\n').split('\n');
  const difference = additiveLineDifference(baseLines, headLines);
  const added = difference.added.filter(line => line.trim());
  const errors = [];
  if (!difference.preservesBase) {
    errors.push(`shared mutation '${mutation.path}' removes or rewrites content instead of only adding export '${mutation.target}'`);
  }
  if (added.length === 0 || added.some(line => !isExactExportAddition(line, mutation.target))) {
    errors.push(`shared mutation '${mutation.path}' must add only the exact named export '${mutation.target}'`);
  }
  return errors;
}

function validateAddJsonKey(mutation, baseContent, headContent) {
  const errors = [];
  let base;
  let head;
  try {
    base = JSON.parse(String(baseContent));
    head = JSON.parse(String(headContent));
  } catch {
    return [`shared mutation '${mutation.path}' must compare valid JSON at both exact artifacts`];
  }
  const key = mutation.target.slice('scripts.'.length);
  const baseScripts = base?.scripts;
  const headScripts = head?.scripts;
  if (!headScripts || typeof headScripts !== 'object' || Array.isArray(headScripts) ||
    !Object.prototype.hasOwnProperty.call(headScripts, key)) {
    errors.push(`shared mutation '${mutation.path}' did not add declared JSON key '${mutation.target}'`);
    return errors;
  }
  if (baseScripts && typeof baseScripts === 'object' && !Array.isArray(baseScripts) &&
    Object.prototype.hasOwnProperty.call(baseScripts, key)) {
    errors.push(`shared mutation '${mutation.path}' changes existing JSON key '${mutation.target}' instead of adding it`);
    return errors;
  }
  const normalizedHead = structuredClone(head);
  delete normalizedHead.scripts[key];
  if (!Object.prototype.hasOwnProperty.call(base ?? {}, 'scripts') &&
    Object.keys(normalizedHead.scripts).length === 0) {
    delete normalizedHead.scripts;
  }
  if (!deepEqualJson(base, normalizedHead)) {
    errors.push(`shared mutation '${mutation.path}' changes content outside declared JSON key '${mutation.target}'`);
  }
  return errors;
}

/**
 * Prove that one exact base/head content pair performs only its declared
 * additive managed mutation.
 */
export function validateSharedMutationContents(mutation, baseContent, headContent) {
  if (typeof baseContent !== 'string' || typeof headContent !== 'string') {
    return {
      ok: false,
      errors: [`shared mutation '${mutation?.path ?? 'unknown'}' lacks exact base/head content proof`],
    };
  }
  const errors = mutation.operation === 'add_export'
    ? validateAddExport(mutation, baseContent, headContent)
    : validateAddJsonKey(mutation, baseContent, headContent);
  return { ok: errors.length === 0, errors };
}

function validateChangedSharedMutations(changedPaths, declaration, contentsByPath) {
  const changed = new Set(changedPaths.map(normalizePath));
  const errors = [];
  for (const mutation of declaration.sharedMutations ?? []) {
    if (!changed.has(mutation.path)) continue;
    const contents = contentsByPath?.[mutation.path];
    if (contents?.error) {
      errors.push(`shared mutation '${mutation.path}' content lookup failed: ${contents.error}`);
      continue;
    }
    errors.push(...validateSharedMutationContents(
      mutation,
      contents?.baseContent,
      contents?.headContent
    ).errors);
  }
  return errors;
}

/** Parse only the exact files-backed range artifact format accepted for diffing. */
export function parseArtifactRange(artifact) {
  const value = String(artifact ?? '').trim();
  const match = value.match(/^range:([0-9a-f]{40})\.\.([0-9a-f]{40})$/i);
  if (!match) {
    return { base: null, head: null, error: "implementation_artifact must be an exact 'range:<40-sha>..<40-sha>' for artifact-bound ownership validation" };
  }
  return { base: match[1].toLowerCase(), head: match[2].toLowerCase(), error: null };
}

/**
 * Obtain changed paths from the recorded base and head, never from the current
 * working tree. The runner uses the same `(command, args, options)` shape as
 * config validation so tests can inject a deterministic Git result.
 */
export function collectArtifactChangedPaths(repoRoot, artifact, commandRunner) {
  const range = parseArtifactRange(artifact);
  if (range.error) return { paths: [], base: null, head: null, error: range.error };
  const result = commandRunner('git', ['diff', '--name-only', `${range.base}..${range.head}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
  }) ?? {};
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join(' ').trim();
    return { paths: [], base: range.base, head: range.head, error: detail || 'git diff --name-only failed' };
  }
  const paths = [...new Set(String(result.stdout ?? '').split(/\r?\n/).map(normalizePath).filter(Boolean))];
  return { paths, base: range.base, head: range.head, error: null };
}

export function validateArtifactOwnership({ repoRoot, artifact, declaration, commandRunner }) {
  const changed = collectArtifactChangedPaths(repoRoot, artifact, commandRunner);
  if (changed.error) return { ok: false, ...changed, errors: [changed.error], unexpected: [] };
  const ownership = validateChangedPathsAgainstOwnership(changed.paths, declaration);
  if (!ownership.ok) return { ...ownership, ...changed };

  const contentsByPath = {};
  const changedSet = new Set(changed.paths);
  for (const mutation of declaration.sharedMutations ?? []) {
    if (!changedSet.has(mutation.path)) continue;
    const readAt = sha => commandRunner('git', ['show', `${sha}:${mutation.path}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
    }) ?? {};
    const base = readAt(changed.base);
    const head = readAt(changed.head);
    if (base.status !== 0 || head.status !== 0) {
      const detail = [base.stderr, head.stderr, base.error?.message, head.error?.message]
        .filter(Boolean).join(' ').trim();
      contentsByPath[mutation.path] = { error: detail || 'git show failed' };
    } else {
      contentsByPath[mutation.path] = {
        baseContent: String(base.stdout ?? ''),
        headContent: String(head.stdout ?? ''),
      };
    }
  }
  const operationErrors = validateChangedSharedMutations(changed.paths, declaration, contentsByPath);
  return {
    ...ownership,
    ...changed,
    ok: operationErrors.length === 0,
    errors: operationErrors,
  };
}

/** Validate GitHub-hydrated exact base/head contents for changed shared files. */
export function validateGitHubSharedMutationContents(changedPaths, declaration, contentsByPath) {
  const errors = validateChangedSharedMutations(changedPaths, declaration, contentsByPath);
  return { ok: errors.length === 0, errors };
}

/** GitHub PR file lists provide the equivalent exact head artifact projection. */
export function collectGitHubArtifactChangedPaths(files) {
  if (!Array.isArray(files)) return { paths: [], error: 'GitHub PR file list is unavailable' };
  return {
    paths: [...new Set(files.map(file => normalizePath(typeof file === 'string' ? file : file?.path)).filter(Boolean))],
    error: null,
  };
}

function sameMutation(left, right) {
  return left.path === right.path && left.operation === right.operation && left.target === right.target;
}

function matchingPlanOperation(plan, taskId, mutation) {
  return (plan.operations ?? []).some(operation =>
    operation?.taskId === taskId && sameMutation(operation, mutation)
  );
}

/**
 * Validate the complete opt-in join plan. It is intentionally stricter than a
 * textual Git merge: only two known additive operation forms can be classified.
 */
export function validateManagedJoinPlan(plan, lanes) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['managed join plan is missing'] };
  if (plan.classifiedBy !== 'maintainer') errors.push('managed join classification must be authored by Maintainer');
  if (plan.dependencyIndependent !== true) errors.push('managed join requires dependency-independent lanes');
  if (plan.knowledgeIndependent !== true) errors.push('managed join requires knowledge-independent lanes');
  if (!Array.isArray(plan.compositionOrder) || plan.compositionOrder.length !== lanes.length ||
    new Set(plan.compositionOrder).size !== lanes.length || lanes.some(lane => !plan.compositionOrder.includes(lane.taskId))) {
    errors.push('managed join plan requires one exact composition order containing every lane');
  }
  if (!plan.joinTask || typeof plan.joinTask.taskId !== 'string' || !plan.joinTask.taskId.trim()) {
    errors.push('managed join plan requires a dedicated join task id');
  }
  if (!Number.isInteger(plan.joinTask?.attemptBudget) || plan.joinTask.attemptBudget < 1) {
    errors.push('managed join plan requires the dedicated join task attemptBudget');
  }
  if (typeof plan.joinTask?.lease !== 'string' || !plan.joinTask.lease.trim()) {
    errors.push('managed join plan requires the dedicated join task lease');
  }
  if (!Array.isArray(plan.integratedChecks) || plan.integratedChecks.length === 0) {
    errors.push('managed join plan requires integrated checks');
  }
  if (typeof plan.escalation !== 'string' || !plan.escalation.trim()) {
    errors.push('managed join plan requires an escalation route');
  }
  if (!Array.isArray(plan.operations)) errors.push('managed join plan requires per-lane operations');

  for (const lane of lanes) {
    if (!lane.taskId || !lane.artifact?.base || !lane.artifact?.head ||
      !EXACT_SHA.test(lane.artifact.base) || !EXACT_SHA.test(lane.artifact.head)) {
      errors.push(`lane '${lane.taskId ?? 'unknown'}' lacks an exact base/head artifact binding`);
    }
    for (const mutation of lane.declaration?.sharedMutations ?? []) {
      if (!matchingPlanOperation(plan, lane.taskId, mutation)) {
        errors.push(`managed join plan does not bind ${lane.taskId}:${mutation.path}:${mutation.operation}:${mutation.target}`);
      }
    }
  }

  for (const operation of plan.operations ?? []) {
    if (!operation || typeof operation !== 'object' || !lanes.some(lane => lane.taskId === operation.taskId)) {
      errors.push('managed join plan has an operation without a participating lane');
      continue;
    }
    if (!isExactFile(normalizePath(operation.path)) || !MANAGED_MUTATION_OPERATIONS.has(operation.operation) ||
      !isValidMutationTarget(operation.operation, operation.target)) {
      errors.push('managed join plan has an invalid exact operation classification');
    }
  }
  return { ok: errors.length === 0, errors };
}

function declaredOverlaps(left, right) {
  const overlaps = [];
  const uncertain = [];
  const leftExclusive = left.declaration.ownedPaths ?? [];
  const rightExclusive = right.declaration.ownedPaths ?? [];
  const leftShared = left.declaration.sharedMutations ?? [];
  const rightShared = right.declaration.sharedMutations ?? [];
  const compare = (a, b, type) => {
    const relation = classifyPathRelation(a, b);
    if (relation === 'overlap') overlaps.push({ left: a, right: b, type });
    if (relation === 'unknown') uncertain.push({ left: a, right: b, type });
  };
  for (const a of leftExclusive) for (const b of rightExclusive) compare(a, b, 'exclusive');
  for (const a of leftExclusive) for (const b of rightShared) compare(a, b.path, 'exclusive_shared');
  for (const a of leftShared) for (const b of rightExclusive) compare(a.path, b, 'shared_exclusive');
  for (const a of leftShared) for (const b of rightShared) compare(a.path, b.path, 'shared');
  return { overlaps, uncertain };
}

/**
 * Classify a candidate pair. Maintainer supplies `classifiedBy: maintainer` and
 * semantic facts in the join plan; Orchestrator can call this to verify inputs
 * and record the result but cannot originate those facts.
 */
export function classifyParallelPair(left, right, plan) {
  const leftEligibility = evaluateTaskEligibility(left.declaration);
  const rightEligibility = evaluateTaskEligibility(right.declaration);
  if (leftEligibility === 'blocked' || rightEligibility === 'blocked') {
    return { relation: 'blocked', reason: 'a lane has malformed or blocked ownership' };
  }
  if (leftEligibility === 'unknown' || rightEligibility === 'unknown') {
    return { relation: 'unknown', reason: 'a lane needs bounded ownership discovery' };
  }
  if (left.declaration.knowledgeCoupling === 'coupled' || right.declaration.knowledgeCoupling === 'coupled' ||
    left.dependsOn?.includes(right.taskId) || right.dependsOn?.includes(left.taskId)) {
    return { relation: 'blocked', reason: 'dependency or knowledge coupling prevents managed join' };
  }
  if (left.declaration.knowledgeCoupling !== 'independent' || right.declaration.knowledgeCoupling !== 'independent') {
    return { relation: 'unknown', reason: 'knowledge independence is unresolved' };
  }

  const paths = declaredOverlaps(left, right);
  if (paths.uncertain.length > 0) {
    return { relation: 'unknown', reason: 'ownership pattern overlap is not mechanically determined', details: paths.uncertain };
  }
  if (paths.overlaps.length === 0) return { relation: 'disjoint', reason: 'structured exclusive ownership is mechanically disjoint' };
  if (paths.overlaps.some(item => item.type !== 'shared')) {
    return { relation: 'blocked', reason: 'exclusive ownership overlaps another lane', details: paths.overlaps };
  }

  const shared = paths.overlaps;
  for (const overlap of shared) {
    const leftMutation = left.declaration.sharedMutations.find(item => item.path === overlap.left);
    const rightMutation = right.declaration.sharedMutations.find(item => item.path === overlap.right);
    if (!leftMutation || !rightMutation || leftMutation.operation !== rightMutation.operation || leftMutation.target === rightMutation.target) {
      return { relation: 'blocked', reason: 'shared mutation is competing or not an additive distinct operation', details: shared };
    }
  }

  const validation = validateManagedJoinPlan(plan, [left, right]);
  if (!validation.ok) return { relation: 'unknown', reason: 'managed join plan is incomplete or stale', details: validation.errors };
  return { relation: 'managed_join', reason: 'Maintainer-classified exact additive shared operations', details: shared };
}

/** Return stale reasons when artifacts, order, evidence, or review no longer bind the join. */
export function validateManagedJoinFreshness({ plan, lanes, finalArtifact, integratedEvidence, review }) {
  const errors = [];
  const planValidation = validateManagedJoinPlan(plan, lanes);
  errors.push(...planValidation.errors);
  if (!finalArtifact || !EXACT_SHA.test(finalArtifact)) errors.push('final join artifact identity is missing or malformed');
  if (integratedEvidence?.artifact !== finalArtifact) errors.push('integrated evidence is stale for the final join artifact');
  if (JSON.stringify(integratedEvidence?.compositionOrder) !== JSON.stringify(plan?.compositionOrder)) {
    errors.push('integrated evidence is stale for the current composition order');
  }
  if (review?.artifact !== finalArtifact) errors.push('full Maintainer review is stale for the final join artifact');
  if (JSON.stringify(review?.lenses) !== JSON.stringify(['lens1', 'lens2', 'lens3'])) {
    errors.push('final join artifact lacks a fresh full ordered three-lens review');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Check a bounded Engineer reconciliation return. It deliberately does not
 * decide semantic ambiguity: those results stop and route to their owner.
 */
export function validateManagedReconciliation({ plan, attempts, editedPaths, classification, postChecksPassed }) {
  const errors = [];
  const conflictPaths = new Set((plan?.conflictPaths ?? []).map(normalizePath));
  if (classification !== 'mechanical') {
    return { ok: false, route: 'maintainer_or_human', errors: ['reconciliation is ambiguous, semantic, architectural, or contract-changing'] };
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > plan?.joinTask?.attemptBudget) {
    return { ok: false, route: 'orchestrator', errors: ['dedicated join task attempt budget is exhausted or unavailable'] };
  }
  if (conflictPaths.size === 0) errors.push('reconciliation has no Maintainer-named conflict paths');
  for (const path of editedPaths ?? []) {
    if (!conflictPaths.has(normalizePath(path))) errors.push(`reconciliation wrote unnamed path '${normalizePath(path)}'`);
  }
  if (postChecksPassed !== true) errors.push('post-reconciliation integrated checks did not pass after the final edit');
  return {
    ok: errors.length === 0,
    route: errors.length === 0 ? null : 'owning_lane_or_maintainer',
    errors,
  };
}
