/**
 * Generated adapter payload-size regression protection.
 *
 * Measures generated files, not exact active model context: host loading may be
 * dynamic. Activation-surface and reference-library budgets catch packaging
 * growth while allowing reductions.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateOpencodeArtifacts } from '../src/adapters/opencode.js';
import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOLERANCE = 0.05;
// agentDefinitions baselines were deliberately raised when the canonical
// engineer role gained its dual-mode (standalone / Agentic Loop) structure and
// the Codex/Copilot/Cursor engineer preamble gained the mode-selection wording.
const ADAPTERS = [
  { name: 'opencode', generate: generateOpencodeArtifacts, dirs: ['.opencode'], baseline: { generatedPayload: 7319, agentDefinitions: 6740, activationSurface: 579 } },
  { name: 'codex', generate: generateCodexArtifacts, dirs: ['.codex', '.agents'], baseline: { generatedPayload: 38606, agentDefinitions: 7171, activationSurface: 869, referenceLibrary: 31241 } },
  { name: 'claude-code', generate: generateClaudeCodeArtifacts, dirs: ['.claude'], baseline: { generatedPayload: 30781, agentDefinitions: 6330, activationSurface: 1308, referenceLibrary: 23720 } },
  { name: 'copilot', generate: generateCopilotArtifacts, dirs: ['.github'], baseline: { generatedPayload: 36857, agentDefinitions: 6928, activationSurface: 848, referenceLibrary: 29728 } },
  { name: 'cursor', generate: generateCursorArtifacts, dirs: ['.cursor'], baseline: { generatedPayload: 36684, agentDefinitions: 6925, activationSurface: 678, referenceLibrary: 29728 } },
];

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-adapterpayload-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });
function wordCount(text) { return text.split(/\s+/).filter(Boolean).length; }
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc); else acc.push(full);
  }
  return acc;
}
function measure(adapter) {
  const fx = mkdtempSync(join(tmpDir, `${adapter.name}-fx-`));
  seedTargetLayout(REPO_ROOT, fx, { includeDocs: false, includeScratch: false });
  const out = mkdtempSync(join(tmpDir, `${adapter.name}-out-`));
  adapter.generate(loadAgenticLoopConfig(join(fx, 'agenticloop.json')), fx, out);
  const counts = { generatedPayload: 0, agentDefinitions: 0, activationSurface: 0, referenceLibrary: 0 };
  for (const dir of adapter.dirs) for (const file of walk(join(out, dir))) {
    if (!/\.(md|toml|ya?ml)$/.test(file)) continue;
    const words = wordCount(readFileSync(file, 'utf-8'));
    counts.generatedPayload += words;
    const p = file.replace(/\\/g, '/');
    if (p.includes('/references/')) counts.referenceLibrary += words;
    else if (/\/agents\//.test(p)) counts.agentDefinitions += words;
    else counts.activationSurface += words;
  }
  return counts;
}

describe('generated adapter payload-size budgets', () => {
  for (const adapter of ADAPTERS) it(`${adapter.name} stays within its generated payload-size budget`, () => {
    const counts = measure(adapter);
    for (const [category, baseline] of Object.entries(adapter.baseline)) {
      const budget = Math.ceil(baseline * (1 + TOLERANCE));
      assert.ok(counts[category] <= budget,
        `${adapter.name} ${category} grew to ${counts[category]} words, exceeding the ${budget}-word generated-artifact budget (baseline ${baseline} +${Math.round(TOLERANCE * 100)}%). Reduce the artifact or deliberately raise this baseline.`);
    }
  });
});
