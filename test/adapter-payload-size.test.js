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
// Baselines were raised for the review-lifecycle revision policy: the canonical
// review skill now carries the implementation-changing/record-only decision
// flow, bounded Structural Risk Sweep, artifact-bound reuse rules, and required
// durable review-body examples. The verification-history separation also updates
// the packaged role and backend references.
// Baselines were deliberately raised for the fourth canonical role. Auditor adds
// one packaged agent definition per host (agentDefinitions) and the
// work-unit-audit skill adds one packaged procedure per host that packages a
// reference library. Both are new capability, not duplication: the audit
// certificate contract lives only in the skill, and the role file carries no
// copied canonical block.
// Baselines are deliberately raised for managed joins. The full law is
// owned once by parallel-delegation; generated reference libraries must carry
// that law, while roles/backends retain only local deltas. Exact ownership,
// artifact-bound composition, bounded reconciliation, and final-artifact review
// are irreducible capability growth rather than adapter duplication.
// Reference-library baselines include the shared executable-preparation
// vocabulary. The rule is packaged through existing roles and skills rather than
// adapter-specific copies.
// Reference-library baselines for codex, copilot, and cursor are deliberately
// rebased to the measured review-preparation completion state: the typed proof/evidence
// contract (structured per-observation records owned by verification-evidence),
// the preparation/review-packet lifecycle, bounded checkpoint repair, revision
// classification, and the no-progress disposition are new canonical capability
// packaged once through the existing skills and backends docs. Duplicated
// review-preparation prose was first consolidated into single owners; the residual growth is
// irreducible contract, not adapter duplication.
// Agent-definition baselines are deliberately rebased to the measured
// post-review sizes after restoring the Maintainer's pre-existing
// parallel-safety duties and the Orchestrator's current-state reassessment and
// knowledge-independence gates. The review found those responsibilities had
// been replaced instead of extended; this is required contract restoration,
// not a second copy of the managed-join law.
// The PR-body workflow deliberately rebases generatedPayload for Codex,
// Copilot, and Cursor to the measured completion state. The closed-loop
// Engineer workflow
// contributes 206 words to each of those payloads (88 agent-definition words
// plus 118 packaged-reference words); the remaining increase over the previous
// baselines is accumulated earlier drift, not duplicate PR-body teaching.
// Claude Code's narrow reference-library headroom predates this workflow and
// remains a separate consolidation concern rather than being hidden by this
// rebase.
// The auditor wire-format completion pass deliberately rebases the
// agentDefinitions baseline for all five adapters: every host's generated
// orchestrator guidance now requires persisting the returned
// `auditor_report_v1` object through `agenticloop audit report` without
// rewriting findings, alongside the existing fresh-delegation and
// no-same-session audit rules. Claude Code also moves on generatedPayload and
// referenceLibrary because those surfaces package the same canonical contract.
// These are measured multi-surface baselines, not a Claude-only "+37 words"
// adjustment and not duplicate workflow teaching.
const ADAPTERS = [
  { name: 'opencode', generate: generateOpencodeArtifacts, dirs: ['.opencode'], baseline: { generatedPayload: 11005, agentDefinitions: 10727, activationSurface: 687 } },
  { name: 'codex', generate: generateCodexArtifacts, dirs: ['.codex', '.agents'], baseline: { generatedPayload: 62199, agentDefinitions: 11303, activationSurface: 977, referenceLibrary: 49672 } },
  { name: 'claude-code', generate: generateClaudeCodeArtifacts, dirs: ['.claude'], baseline: { generatedPayload: 50201, agentDefinitions: 10084, activationSurface: 1568, referenceLibrary: 38456 } },
  { name: 'copilot', generate: generateCopilotArtifacts, dirs: ['.github'], baseline: { generatedPayload: 60057, agentDefinitions: 10913, activationSurface: 978, referenceLibrary: 47919 } },
  { name: 'cursor', generate: generateCursorArtifacts, dirs: ['.cursor'], baseline: { generatedPayload: 59845, agentDefinitions: 10899, activationSurface: 786, referenceLibrary: 47919 } },
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
