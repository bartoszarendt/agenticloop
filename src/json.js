// @ts-check

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseJson(text) {
  return JSON.parse(text);
}

/**
 * @param {string} filePath
 * @returns {unknown}
 */
export function loadJsonFile(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  return parseJson(text);
}

/**
 * @param {unknown} base
 * @param {unknown} override
 * @returns {unknown}
 */
export function deepMerge(base, override) {
  if (override === undefined) return base;
  if (base === undefined || base === null) return override;
  if (Array.isArray(override)) return override;
  if (Array.isArray(base)) return override;
  if (typeof override !== 'object' || override === null) return override;
  if (typeof base !== 'object' || base === null) return override;

  const result = { .../** @type {Record<string, unknown>} */ (base) };
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (override))) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

/**
 * @param {string} filePath
 * @param {Set<string>} [visited]
 * @returns {Record<string, unknown>}
 */
export function loadAgenticLoopConfig(filePath, visited = new Set()) {
  const absPath = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (visited.has(absPath)) {
    throw new Error(`Circular extends chain detected at ${absPath}`);
  }
  visited.add(absPath);

  /** @type {Record<string, unknown>} */
  let config;
  try {
    config = /** @type {Record<string, unknown>} */ (loadJsonFile(absPath));
  } catch (/** @type {any} */ error) {
    throw new Error(`Failed to load config at ${absPath}: ${error.message}`);
  }

  const extendsPath = config.extends;
  if (extendsPath !== undefined) {
    if (typeof extendsPath !== 'string') {
      throw new Error(`Invalid "extends" value in ${absPath}: must be a string path`);
    }
    const basePath = isAbsolute(extendsPath)
      ? extendsPath
      : resolve(dirname(absPath), extendsPath);

    let baseConfig;
    try {
      baseConfig = loadAgenticLoopConfig(basePath, visited);
    } catch (/** @type {any} */ error) {
      if (error.message.startsWith('Failed to load config at')) {
        throw new Error(
          `Cannot resolve extends "${extendsPath}" from ${absPath}: ${error.message}`
        );
      }
      throw error;
    }

    config = /** @type {Record<string, unknown>} */ (deepMerge(baseConfig, config));
    delete config.extends;
  }

  return config;
}
