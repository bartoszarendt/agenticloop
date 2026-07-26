/** Read-only task readiness and explicit base-tree path-intent evaluation. */

import { parseFrontmatter } from './frontmatter.js';
import { fileMatchesScopePattern, parseScopePatterns, validatePathsAgainstDeviations } from './scope-matcher.js';

const GLOB = /[*?]/;
const GLOB_SAMPLE_LIMIT = 5;

function normalize(path) {
  return String(path ?? '').replace(/\\/g, '/').trim();
}

function issue(level, message, category, owner = 'maintainer') {
  return { level, message, category, owner, nextAction: level === 'error' ? 'repair the declared task contract and rerun task-readiness' : 'confirm or correct the declaration before review' };
}

function asStringList(value, field, diagnostics) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && normalize(item))) {
    diagnostics.push(issue('error', `'${field}' must be a YAML list of repo-relative paths`, 'path_intent'));
    return [];
  }
  return value.map(normalize);
}

/** Parse path and dependency declarations from an existing task record. */
export function parseTaskReadinessDeclaration(taskBody) {
  const diagnostics = [];
  const [frontmatter] = parseFrontmatter(String(taskBody ?? ''));
  if (!frontmatter) {
    return { diagnostics: [issue('error', 'task readiness requires YAML frontmatter', 'task_contract')], declaration: null };
  }
  const scope = parseScopePatterns(taskBody);
  if (scope?.error) diagnostics.push(issue('error', scope.error, 'path_intent'));
  const intendedCreations = asStringList(frontmatter.intended_creations, 'intended_creations', diagnostics);
  const dependsOn = asStringList(frontmatter.depends_on ?? frontmatter.dependsOn, 'depends_on', diagnostics);
  const generated = new Map();
  if (frontmatter.generated_paths !== undefined) {
    if (!frontmatter.generated_paths || typeof frontmatter.generated_paths !== 'object' || Array.isArray(frontmatter.generated_paths)) {
      diagnostics.push(issue('error', "'generated_paths' must map an exact path to generator, source, and verification metadata", 'generated_paths'));
    } else {
      for (const [rawPath, raw] of Object.entries(frontmatter.generated_paths)) {
        const path = normalize(rawPath);
        if (!path || GLOB.test(path) || path.endsWith('/')) {
          diagnostics.push(issue('error', `generated path '${rawPath}' must be an exact repo-relative path`, 'generated_paths'));
          continue;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          diagnostics.push(issue('error', `generated path '${path}' must declare generator, source, and verification`, 'generated_paths'));
          continue;
        }
        const generator = String(raw.generator ?? '').trim();
        const source = String(raw.source ?? '').trim();
        const verification = String(raw.verification ?? raw.parity ?? '').trim();
        if (!generator || !source || !verification) {
          diagnostics.push(issue('error', `generated path '${path}' requires generator, source, and verification (parity or regeneration)`, 'generated_paths'));
          continue;
        }
        generated.set(path, { generator, source, verification });
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
  dependencies = {},
  dependencyEvaluator,
  projectFacts = [],
} = {}) {
  const diagnostics = [];
  if (!Array.isArray(basePaths)) {
    diagnostics.push(issue('error', 'basePaths inventory is unavailable; readiness cannot classify path intent', 'path_intent'));
  }
  if (!['authoring', 'review'].includes(mode)) {
    diagnostics.push(issue('error', "mode must be explicitly 'authoring' or 'review'", 'path_intent'));
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
      if (matches.length === 0) diagnostics.push(issue('warning', `scope glob '${pattern}' matches no base-tree paths and is not creation-capable`, 'path_intent'));
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
      diagnostics.push(issue(level, `literal allowed path '${pattern}' is absent from the base tree and is not declared as an intended creation or generated output`, 'path_intent'));
      paths.push({ pattern, classification: 'unmatched' });
    }
  }

  // One authority for changed-path/deviation validation. Generated outputs are
  // an explicit, exact-path authorization and never authorize unrelated source
  // changes; the shared deviation validator owns every other changed path and
  // its diagnostics are reported verbatim exactly once.
  const normalizedChanged = changedPaths.map(normalize).filter(Boolean);
  const generatedAuthorized = new Set(declaration.generated.keys());
  const deviationCheck = validatePathsAgainstDeviations(
    normalizedChanged.filter(path => !generatedAuthorized.has(path)),
    declaration.allowedPaths,
    deviationEntries,
  );
  for (const message of deviationCheck.errors ?? []) {
    diagnostics.push(issue('error', message, 'scope_deviations', 'engineer'));
  }

  const dependencyResults = [];
  for (const id of declaration.dependsOn) {
    const result = dependencyEvaluator ? dependencyEvaluator(id) : dependencies[id];
    const status = typeof result === 'string' ? result : result?.status;
    dependencyResults.push({ id, status: status ?? 'unresolved' });
    if (status !== 'resolved' && status !== 'accepted' && status !== 'closed') {
      diagnostics.push(issue('error', `declared dependency '${id}' is unresolved`, 'dependencies', 'orchestrator'));
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
  return {
    schemaVersion: 1,
    ok: errors.length === 0,
    errors: errors.map(item => item.message),
    warnings: warnings.map(item => item.message),
    diagnostics,
    firstSafeRepair: errors[0]?.nextAction ?? null,
    ...detail,
  };
}
