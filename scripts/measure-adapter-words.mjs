#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { generateOpencodeArtifacts } from '../src/adapters/opencode.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from '../test/helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const ADAPTERS = Object.freeze([
  { name: 'opencode', generate: generateOpencodeArtifacts, dirs: ['.opencode'] },
  { name: 'codex', generate: generateCodexArtifacts, dirs: ['.codex', '.agents'] },
  { name: 'claude-code', generate: generateClaudeCodeArtifacts, dirs: ['.claude'] },
  { name: 'copilot', generate: generateCopilotArtifacts, dirs: ['.github'] },
  { name: 'cursor', generate: generateCursorArtifacts, dirs: ['.cursor'] },
]);

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function measure(adapter, tmpDir) {
  const fixture = mkdtempSync(join(tmpDir, `${adapter.name}-fixture-`));
  seedTargetLayout(REPO_ROOT, fixture, { includeDocs: false, includeScratch: false });
  const output = mkdtempSync(join(tmpDir, `${adapter.name}-output-`));
  adapter.generate(loadAgenticLoopConfig(join(fixture, 'agenticloop.json')), fixture, output);
  const counts = { generatedPayload: 0, agentDefinitions: 0, activationSurface: 0, referenceLibrary: 0 };
  for (const dir of adapter.dirs) for (const file of walk(join(output, dir))) {
    if (!/\.(md|toml|ya?ml)$/.test(file)) continue;
    const words = wordCount(readFileSync(file, 'utf8'));
    counts.generatedPayload += words;
    const path = file.replace(/\\/g, '/');
    if (path.includes('/references/')) counts.referenceLibrary += words;
    else if (/\/agents\//.test(path)) counts.agentDefinitions += words;
    else counts.activationSurface += words;
  }
  return counts;
}

/** Generate each adapter into a disposable fixture and return its word counts. */
export function measureAdapterWords() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agenticloop-adapter-words-'));
  try {
    return Object.fromEntries(ADAPTERS.map(adapter => [adapter.name, measure(adapter, tmpDir)]));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(measureAdapterWords(), null, 2)}\n`);
