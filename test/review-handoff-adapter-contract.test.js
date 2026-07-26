import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateOpencodeArtifacts } from '../src/adapters/opencode.js';
import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TMP_ROOT = join(REPO_ROOT, '.agenticloop', 'tmp');
const ADAPTERS = [
  ['opencode', generateOpencodeArtifacts],
  ['codex', generateCodexArtifacts],
  ['claude-code', generateClaudeCodeArtifacts],
  ['copilot', generateCopilotArtifacts],
  ['cursor', generateCursorArtifacts],
];

function generatedText(root) {
  const files = [];
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) visit(file);
      else if (/\.(?:md|toml|json)$/i.test(name)) files.push(file);
    }
  };
  visit(root);
  return files.map(file => readFileSync(file, 'utf-8')).join('\n');
}

describe('generated review-handoff adapter contract', () => {
  let temporaryRoot;

  before(() => {
    if (!existsSync(TMP_ROOT)) mkdirSync(TMP_ROOT, { recursive: true });
    temporaryRoot = mkdtempSync(join(TMP_ROOT, 'review-handoff-adapters-'));
  });
  after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

  for (const [name, generate] of ADAPTERS) {
    it(`${name} derives the exact-artifact handoff contract from canonical source`, () => {
      const target = mkdtempSync(join(temporaryRoot, `${name}-target-`));
      const output = mkdtempSync(join(temporaryRoot, `${name}-output-`));
      seedTargetLayout(REPO_ROOT, target, { includeDocs: false, includeScratch: false });
      generate(loadAgenticLoopConfig(join(target, 'agenticloop.json')), target, output);
      const generated = generatedText(output);
      const canonical = generatedText(join(target, 'agenticloop'));

      // Adapters may reference canonical assets instead of duplicating their payload.
      assert.match(generated, /review-and-accept/i);
      assert.match(canonical, /Expected artifact:/);
      assert.match(canonical, /--expect-artifact/);
      assert.match(canonical, /Review Round Checkpoint/);
      assert.match(canonical, /resolution matrix/i);
      assert.match(canonical, /Maintainer disposition/i);
    });
  }
});
