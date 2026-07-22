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
// Baselines were deliberately raised again when the Maintainer Review Fixup
// exception was added: the detailed procedure in review-and-accept grows every
// adapter's reference library, and the maintainer/orchestrator role edits grow
// agentDefinitions.
// Baselines were raised again for the delegation/review provenance clarification:
// role-delegation gained the explicit Delegation mode / Fallback cause+reason
// prompt lines plus the re-review-and-continuation policy, and review-and-accept
// gained the fixup eligibility verdict line and the standardized durable fixup
// disclosure shape. These canonical additions grow every packaged reference
// library and the maintainer role edit grows agentDefinitions.
// Knowledge coordination and combined verification must remain within these
// established budgets; concise canonical rules and cross-links absorb the new
// behavior without rebasing payload growth.
// Baselines were deliberately raised again for the Project Operating Facts tier:
// the maintainer/engineer/orchestrator roles gained concise recognition and
// capture responsibilities (agentDefinitions), and the decision-capture and
// parallel-delegation skills gained the fact-vs-decision boundary and the
// shared-state parallel-write rule (referenceLibrary). The full canonical
// definition lives only in AGENTIC_LOOP.md, which is not part of any generated
// adapter payload, so role/skill growth stays concise.
// Baselines were deliberately raised for the host-neutral stop command. Its
// compact checkpoint/deactivation route is packaged in every activation surface.
const ADAPTERS = [
  { name: 'opencode', generate: generateOpencodeArtifacts, dirs: ['.opencode'], baseline: { generatedPayload: 8487, agentDefinitions: 7888, activationSurface: 661 } },
  { name: 'codex', generate: generateCodexArtifacts, dirs: ['.codex', '.agents'], baseline: { generatedPayload: 47453, agentDefinitions: 8366, activationSurface: 951, referenceLibrary: 38198 } },
  { name: 'claude-code', generate: generateClaudeCodeArtifacts, dirs: ['.claude'], baseline: { generatedPayload: 37885, agentDefinitions: 7478, activationSurface: 1466, referenceLibrary: 29065 } },
  { name: 'copilot', generate: generateCopilotArtifacts, dirs: ['.github'], baseline: { generatedPayload: 45475, agentDefinitions: 8076, activationSurface: 936, referenceLibrary: 36525 } },
  { name: 'cursor', generate: generateCursorArtifacts, dirs: ['.cursor'], baseline: { generatedPayload: 45296, agentDefinitions: 8073, activationSurface: 760, referenceLibrary: 36525 } },
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
