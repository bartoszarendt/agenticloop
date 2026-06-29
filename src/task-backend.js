// @ts-check

/** @typedef {import('./types.js').TaskBackendResolution} TaskBackendResolution */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadJsonFile } from './json.js';
import { BACKENDS_SOURCE_DIRECTORY } from './layout.js';
import { loadProjectMap, PROJECT_MAP_PATH } from './project-map.js';

export const DEFAULT_TASK_BACKEND = 'files';
export const VALID_TASK_BACKENDS = new Set(['github', 'files']);
export const DEFAULT_BACKEND_PROJECTIONS = Object.freeze({
  github: `${BACKENDS_SOURCE_DIRECTORY}/github.md`,
  files: `${BACKENDS_SOURCE_DIRECTORY}/files.md`,
});

/**
 * @param {unknown} object
 * @param {string} key
 * @returns {boolean}
 */
function hasOwn(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidTaskBackend(value) {
  return VALID_TASK_BACKENDS.has(value);
}

/**
 * @param {Record<string, any> | null | undefined} config
 * @param {string | null | undefined} backend
 * @returns {string | null}
 */
export function getTaskBackendProjection(config, backend) {
  if (!backend) return null;

  const projection = config?.backends?.[backend]?.projection;
  if (typeof projection === 'string' && projection.trim()) {
    return projection.trim();
  }

  return /** @type {Record<string, string>} */ (/** @type {unknown} */ (DEFAULT_BACKEND_PROJECTIONS))[backend] ?? null;
}

/**
 * @param {string} repoRoot
 * @param {Record<string, any>} [options]
 * @returns {TaskBackendResolution}
 */
export function resolveTaskBackend(repoRoot, options = {}) {
  const projectMapPath = join(repoRoot, PROJECT_MAP_PATH);
  const jsonConfigPath = join(repoRoot, 'agenticloop.json');
  const warnings = [];

  let projectMapResult = hasOwn(options, 'projectMapResult')
    ? options.projectMapResult
    : null;
  let rawJsonConfig = hasOwn(options, 'rawJsonConfig')
    ? options.rawJsonConfig
    : null;
  /** @type {Error | null} */
  let rawJsonConfigError = null;

  if (!hasOwn(options, 'projectMapResult') && existsSync(projectMapPath)) {
    projectMapResult = loadProjectMap(repoRoot);
  }

  if (!hasOwn(options, 'rawJsonConfig') && existsSync(jsonConfigPath)) {
    try {
      rawJsonConfig = loadJsonFile(jsonConfigPath);
    } catch (/** @type {any} */ error) {
      rawJsonConfigError = error;
      warnings.push(`Failed to read agenticloop.json for legacy taskBackend fallback: ${error.message}`);
    }
  }

  const projectTaskBackend = projectMapResult?.config?.task_backend ?? null;
  const legacyJsonTaskBackend = hasOwn(rawJsonConfig, 'taskBackend')
    ? rawJsonConfig.taskBackend
    : null;

  let backend = DEFAULT_TASK_BACKEND;
  let source = 'default';

  if (projectTaskBackend !== null) {
    backend = projectTaskBackend;
    source = 'project.md';
  } else if (legacyJsonTaskBackend !== null) {
    backend = legacyJsonTaskBackend;
    source = 'agenticloop.json';
  }

  return {
    backend,
    source,
    legacyJsonTaskBackend,
    projectTaskBackend,
    warnings,
    projectMapPath: existsSync(projectMapPath) ? projectMapPath : null,
    jsonConfigPath: existsSync(jsonConfigPath) ? jsonConfigPath : null,
    projectMapResult,
    rawJsonConfig,
    rawJsonConfigError,
  };
}
