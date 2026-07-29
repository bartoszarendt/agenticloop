/** Read-only task readiness and explicit base-tree path-intent evaluation. */

import { parseFrontmatterStrict } from './frontmatter.js';
import { fileMatchesScopePattern, isSafeScopePattern, parseScopePatterns, validatePathsAgainstDeviations } from './scope-matcher.js';
import { createDiagnostic } from './repair-policy.js';
import { evaluateTaskRecordRoot } from './task-record-root.js';
import { validateTaskRecord } from './validate-config.js';

const GLOB = /[*?]/;
const GLOB_SAMPLE_LIMIT = 5;

function normalize(path) {
  return String(path ?? '').replace(/\\/g, '/').trim();
}

function issue(level, code, evidence) {
  return createDiagnostic({ level, code, evidence });
}

function asStringList(value, field, diagnostics) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && normalize(item))) {
    diagnostics.push(issue('error', 'scope.declaration.invalid', { field }));
    return [];
  }
  const values = value.map(normalize);
  const seen = new Set();
  for (const item of values) {
    if (seen.has(item)) diagnostics.push(issue('error', 'scope.declaration.duplicate', { field, paths: [item] }));
    seen.add(item);
  }
  return values;
}

/** Parse path and dependency declarations from an existing task record. */
export function parseTaskReadinessDeclaration(taskBody) {
  const diagnostics = [];
  const parsedFrontmatter = parseFrontmatterStrict(String(taskBody ?? ''));
  if (parsedFrontmatter.state !== 'valid') {
    return {
      diagnostics: [issue('error', parsedFrontmatter.state === 'malformed' ? 'task.contract.malformed' : 'task.contract.absent', {
        reason: parsedFrontmatter.reason,
      })],
      declaration: null,
    };
  }
  const frontmatter = parsedFrontmatter.data;
  const scope = parseScopePatterns(taskBody);
  if (scope?.error) diagnostics.push(issue('error', 'scope.declaration.invalid', { reason: scope.error, field: scope.fieldName }));
  if (!scope) diagnostics.push(issue('warning', 'scope.declaration.missing', {}));
  if (Array.isArray(scope?.patterns)) {
    const seenPaths = new Set();
    for (const path of scope.patterns) {
      if (seenPaths.has(path)) diagnostics.push(issue('error', 'scope.declaration.duplicate', { field: scope.fieldName, paths: [path] }));
      seenPaths.add(path);
    }
  }
  const intendedCreations = asStringList(frontmatter.intended_creations, 'intended_creations', diagnostics);
  const dependsOn = asStringList(frontmatter.depends_on ?? frontmatter.dependsOn, 'depends_on', diagnostics);
  const generated = new Map();
  if (frontmatter.generated_paths !== undefined) {
    if (!frontmatter.generated_paths || typeof frontmatter.generated_paths !== 'object' || Array.isArray(frontmatter.generated_paths)) {
      diagnostics.push(issue('error', 'generated.path.invalid', { field: 'generated_paths' }));
    } else {
      for (const [rawPath, raw] of Object.entries(frontmatter.generated_paths)) {
        const path = normalize(rawPath);
        if (!path || GLOB.test(path) || path.endsWith('/')) {
          diagnostics.push(issue('error', 'generated.path.invalid', { field: 'generated_paths', paths: [String(rawPath)], reason: 'invalid_path' }));
          continue;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          diagnostics.push(issue('error', 'generated.path.invalid', { field: 'generated_paths', paths: [path], reason: 'missing_metadata' }));
          continue;
        }
        const generator = String(raw.generator ?? '').trim();
        const source = String(raw.source ?? '').trim();
        const verification = String(raw.verification ?? raw.parity ?? '').trim();
        if (!generator || !source || !verification) {
          diagnostics.push(issue('error', 'generated.path.invalid', { field: 'generated_paths', paths: [path], reason: 'missing_metadata' }));
          continue;
        }
        generated.set(path, { generator, source, verification });
      }
    }
  }
  for (const path of intendedCreations) {
    if (!isSafeScopePattern(path) || GLOB.test(path) || path.endsWith('/')) {
      diagnostics.push(issue('error', 'scope.intent.invalid', { field: 'intended_creations', paths: [path] }));
    }
  }
  if (Object.hasOwn(frontmatter, 'allowed_paths')) {
    const allowedPaths = scope?.patterns ?? [];
    for (const path of intendedCreations) {
      if (!allowedPaths.some(pattern => fileMatchesScopePattern(path, pattern))) {
        diagnostics.push(issue('error', 'scope.intended_creation.uncovered', { paths: [path] }));
      }
    }
  }
  return {
    diagnostics,
    declaration: {
      allowedPaths: scope?.patterns ?? [],
      intendedCreations,
      generated,
      dependsOn,
    },
  };
}

/**
 * Evaluate mechanical readiness. Semantic tension is reported for Maintainer
 * reconciliation rather than inferred from prose.
 *
 * Changed-path/deviation validation uses the single shared
 * `validatePathsAgainstDeviations` authority: a path the existing
 * `## Deviations` mechanism (or a generated-path declaration) authorizes is not
 * re-rejected here, and a path that authority rejects is reported exactly once.
 */
export function evaluateTaskReadiness({
  taskBody,
  basePaths,
  mode,
  changedPaths = [],
  deviationEntries = [],
  deviationErrors = [],
  dependencies = {},
  dependencyEvaluator,
  projectFacts = [],
} = {}) {
  const root = evaluateTaskRecordRoot(taskBody);
  if (!root.ok) {
    return finish(root.diagnostics, {
      paths: [],
      dependencies: [],
      knownFacts: projectFacts,
      deviations: { missing: [], stale: [], unnecessary: [] },
    });
  }
  const diagnostics = [];
  for (const message of validateTaskRecord(String(taskBody ?? ''), 'task readiness carrier')) {
    diagnostics.push(createDiagnostic({
      level: 'error',
      code: 'task.record.structure',
      message,
      evidence: {
        state: 'malformed',
        prerequisite: 'canonical_task_record',
        supplied: true,
      },
    }));
  }
  if (diagnostics.length > 0) {
    return finish(diagnostics, {
      paths: [],
      dependencies: [],
      knownFacts: projectFacts,
      deviations: { missing: [], stale: [], unnecessary: [] },
    });
  }
  if (!Array.isArray(basePaths)) {
    diagnostics.push(issue('error', 'readiness.base_inventory.missing', {
      state: 'missing',
      committedStateEvaluated: false,
      rollbackAuthorized: false,
    }));
  }
  if (!['authoring', 'review'].includes(mode)) {
    diagnostics.push(issue('error', 'readiness.mode.invalid', { mode: mode ?? null }));
  }
  const parsed = parseTaskReadinessDeclaration(taskBody);
  diagnostics.push(...parsed.diagnostics);
  if (!parsed.declaration || diagnostics.some(item => item.level === 'error')) {
    return finish(diagnostics, { paths: [], dependencies: [], knownFacts: projectFacts });
  }
  const base = new Set((basePaths ?? []).map(normalize));
  const declaration = parsed.declaration;
  const paths = [];
  for (const pattern of declaration.allowedPaths) {
    if (GLOB.test(pattern) || pattern.endsWith('/')) {
      const matches = [...base].filter(path => fileMatchesScopePattern(path, pattern));
      // Bound glob diagnostics: report a count and a small deterministic sample
      // instead of dumping every match into the result object.
      const sortedMatches = [...matches].sort();
      const sample = sortedMatches.slice(0, GLOB_SAMPLE_LIMIT);
      if (matches.length === 0) diagnostics.push(issue('warning', 'scope.glob.unmatched', { paths: [pattern] }));
      paths.push({ pattern, classification: 'glob', matchCount: matches.length, sample });
      continue;
    }
    if (base.has(pattern)) {
      paths.push({ pattern, classification: 'existing' });
    } else if (declaration.intendedCreations.includes(pattern)) {
      paths.push({ pattern, classification: 'intended_creation' });
    } else if (declaration.generated.has(pattern)) {
      paths.push({ pattern, classification: 'generated', provenance: declaration.generated.get(pattern) });
    } else {
      const level = mode === 'review' ? 'error' : 'warning';
      diagnostics.push(issue(level, 'scope.intended_creation.missing', { paths: [pattern] }));
      paths.push({ pattern, classification: 'unmatched' });
    }
  }

  // One authority for changed-path/deviation validation. Generated outputs are
  // an explicit, exact-path authorization and never authorize unrelated source
  // changes; the shared deviation validator owns every other changed path and
  // its diagnostics are reported verbatim exactly once.
  const normalizedChanged = changedPaths.map(normalize).filter(Boolean);
  if (deviationErrors.length) {
    diagnostics.push(issue('error', 'scope.deviation.malformed', { errors: [...deviationErrors] }));
  }
  const generatedAuthorized = new Set(declaration.generated.keys());
  const deviationCheck = validatePathsAgainstDeviations(
    normalizedChanged.filter(path => !generatedAuthorized.has(path)),
    declaration.allowedPaths,
    deviationEntries,
  );
  if (deviationCheck.missingDeviations.length) {
    diagnostics.push(issue('error', 'scope.deviation.missing', { paths: deviationCheck.missingDeviations }));
  }
  if (deviationCheck.staleDeviations.length) diagnostics.push(issue('error', 'scope.deviation.malformed', { paths: deviationCheck.staleDeviations, kind: 'stale' }));
  if (deviationCheck.inScopeDeviations.length) diagnostics.push(issue('error', 'scope.deviation.malformed', { paths: deviationCheck.inScopeDeviations, kind: 'in_scope' }));

  const dependencyResults = [];
  for (const id of declaration.dependsOn) {
    const result = dependencyEvaluator ? dependencyEvaluator(id) : dependencies[id];
    const status = typeof result === 'string' ? result : result?.status;
    dependencyResults.push({ id, status: status ?? 'unresolved' });
    if (status !== 'resolved' && status !== 'accepted' && status !== 'closed') {
      diagnostics.push(issue('error', 'dependency.unresolved', { dependencies: [id], status: status ?? 'unresolved' }));
    }
  }
  return finish(diagnostics, {
    paths,
    dependencies: dependencyResults,
    knownFacts: projectFacts,
    deviations: {
      missing: deviationCheck.missingDeviations,
      stale: deviationCheck.staleDeviations,
      unnecessary: deviationCheck.inScopeDeviations,
    },
  });
}

function finish(diagnostics, detail) {
  const errors = diagnostics.filter(item => item.level === 'error');
  const warnings = diagnostics.filter(item => item.level === 'warning');
  const evidenceState = errors
    .map(item => item.evidence?.state)
    .find(state => ['missing', 'malformed', 'stale', 'negative', 'changed'].includes(state))
    ?? (errors.length === 0 ? 'current' : 'negative');
  const disposition = evidenceState === 'missing'
    ? 'needs_context'
    : evidenceState === 'malformed'
      ? 'rejected'
      : ['stale', 'changed'].includes(evidenceState)
        ? 'superseded'
        : errors.length === 0 ? 'proceed' : 'blocked';
  return {
    schemaVersion: 1,
    ok: errors.length === 0,
    evidenceState,
    disposition,
    rollbackAuthorized: false,
    errors: errors.map(item => item.message),
    warnings: warnings.map(item => item.message),
    diagnostics,
    ...detail,
  };
}
