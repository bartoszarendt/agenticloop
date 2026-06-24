import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export function parseJson(text) {
  return JSON.parse(text);
}

export function loadJsonFile(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  return parseJson(text);
}

function deepMerge(base, override) {
  if (override === undefined) return base;
  if (base === undefined || base === null) return override;
  if (Array.isArray(override)) return override;
  if (Array.isArray(base)) return override;
  if (typeof override !== 'object' || override === null) return override;
  if (typeof base !== 'object' || base === null) return override;

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

export function loadAgenticLoopConfig(filePath, visited = new Set()) {
  const absPath = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (visited.has(absPath)) {
    throw new Error(`Circular extends chain detected at ${absPath}`);
  }
  visited.add(absPath);

  let config;
  try {
    config = loadJsonFile(absPath);
  } catch (error) {
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
    } catch (error) {
      if (error.message.startsWith('Failed to load config at')) {
        throw new Error(
          `Cannot resolve extends "${extendsPath}" from ${absPath}: ${error.message}`
        );
      }
      throw error;
    }

    config = deepMerge(baseConfig, config);
    delete config.extends;
  }

  return config;
}
