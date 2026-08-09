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

/**
 * Budget policy.
 *
 * The budget is deliberately one-sided: a category may shrink freely and fails
 * only when it grows past `baseline * (1 + TOLERANCE)`. A two-sided band would
 * turn every genuine consolidation into a failing test.
 *
 * A baseline is never raised to make a failing test pass. It is raised only when
 * a measured value reflects required canonical capability packaged once through
 * the existing role, skill, or backend sources - and every such raise gets a
 * `BASELINE_RATIONALE` record naming the previous value, the new measured value,
 * the delta, the reason, and the pass that made it.
 */
const TOLERANCE = 0.05;

const CATEGORIES = Object.freeze(['generatedPayload', 'agentDefinitions', 'activationSurface', 'referenceLibrary']);

/**
 * Rebaseline history.
 *
 * This is the accumulated rationale that used to live in a hundred-line comment
 * block above the baselines. As structured data it can be checked rather than
 * only read: the tests below assert every record names real adapters and real
 * categories and carries a reason and an evidence reference.
 *
 * Records made from the P35-08 corrective pass onward carry `previous`,
 * `measured`, and `delta`. Earlier records predate that requirement; they set
 * `valuesRecorded: false` and leave the numbers null rather than carrying a
 * reconstructed figure the original notes never stated.
 *
 * @type {ReadonlyArray<{
 *   pass: string,
 *   adapters: string[],
 *   categories: string[],
 *   previous: number|null,
 *   measured: number|null,
 *   delta: number|null,
 *   valuesRecorded: boolean,
 *   reason: string,
 *   evidence: string,
 * }>}
 */
const BASELINE_RATIONALE = Object.freeze([
  {
    pass: 'pre-P35 accumulated',
    adapters: ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'],
    categories: ['agentDefinitions', 'referenceLibrary'],
    previous: null, measured: null, delta: null, valuesRecorded: false,
    reason:
      'Successive canonical capability additions packaged once through existing role and skill ' +
      'sources: the dual-mode engineer structure and mode-selection preamble; the Maintainer ' +
      'Review Fixup exception and its procedure in review-and-accept; the delegation/review ' +
      'provenance clarification (explicit Delegation mode, Fallback cause+reason, ' +
      're-review-and-continuation policy, fixup eligibility verdict, durable fixup disclosure ' +
      'shape); the Project Operating Facts tier, whose full definition lives only in ' +
      'AGENTIC_LOOP.md and is therefore in no adapter payload; the host-neutral stop command; ' +
      'the review-lifecycle revision policy with its bounded Structural Risk Sweep and required ' +
      'durable review-body examples; and the fourth canonical role (Auditor), which adds one ' +
      'agent definition and one work-unit-audit procedure per host without copying any canonical ' +
      'block into the role file.',
    evidence: 'git history for agents/, skills/, backends/',
  },
  {
    pass: 'managed joins',
    adapters: ['codex', 'claude-code', 'copilot', 'cursor'],
    categories: ['referenceLibrary'],
    previous: null, measured: null, delta: null, valuesRecorded: false,
    reason:
      'The managed-join law is owned once by parallel-delegation; generated reference libraries ' +
      'must carry it while roles and backends retain only local deltas. Exact ownership, ' +
      'artifact-bound composition, bounded reconciliation, and final-artifact review are ' +
      'irreducible contract, not adapter duplication. The shared executable-preparation ' +
      'vocabulary is packaged through the same existing sources.',
    evidence: 'skills/parallel-delegation',
  },
  {
    pass: 'review-preparation completion',
    adapters: ['codex', 'copilot', 'cursor'],
    categories: ['referenceLibrary'],
    previous: null, measured: null, delta: null, valuesRecorded: false,
    reason:
      'Rebased to the measured completion state for the typed proof/evidence contract ' +
      '(structured per-observation records owned by verification-evidence), the ' +
      'preparation/review-packet lifecycle, bounded checkpoint repair, revision classification, ' +
      'and the no-progress disposition. Duplicated review-preparation prose was consolidated ' +
      'into single owners first; the residual growth is contract, not duplication.',
    evidence: 'skills/verification-evidence, skills/review-and-accept',
  },
  {
    pass: 'post-review role restoration',
    adapters: ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'],
    categories: ['agentDefinitions'],
    previous: null, measured: null, delta: null, valuesRecorded: false,
    reason:
      'Rebased to measured sizes after restoring the Maintainer pre-existing parallel-safety ' +
      'duties and the Orchestrator current-state reassessment and knowledge-independence gates. ' +
      'Review found those responsibilities had been replaced rather than extended; this is ' +
      'contract restoration, not a second copy of the managed-join law.',
    evidence: 'agents/maintainer.md, agents/orchestrator.md',
  },
  {
    pass: 'PR-body workflow',
    adapters: ['codex', 'copilot', 'cursor'],
    categories: ['generatedPayload'],
    previous: null, measured: null, delta: null, valuesRecorded: false,
    reason:
      'The closed-loop Engineer workflow contributes 206 words to each payload (88 ' +
      'agent-definition words plus 118 packaged-reference words); the remainder over the prior ' +
      'baselines is accumulated earlier drift, not duplicate PR-body teaching. The narrow ' +
      'claude-code reference-library headroom predates this workflow and remains a separate ' +
      'consolidation concern rather than being hidden by this rebase.',
    evidence: 'agents/engineer.md, skills/pr-body',
  },
  {
    pass: 'auditor wire-format completion',
    adapters: ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'],
    categories: ['agentDefinitions', 'generatedPayload', 'referenceLibrary'],
    previous: null, measured: null, delta: null, valuesRecorded: false,
    reason:
      'Every generated orchestrator guidance now requires persisting the returned ' +
      'auditor_report_v1 object through `agenticloop audit report` without rewriting findings, ' +
      'alongside the existing fresh-delegation and no-same-session audit rules. Claude Code also ' +
      'moves on generatedPayload and referenceLibrary because those surfaces package the same ' +
      'canonical contract. Measured multi-surface baselines, not a claude-code-only adjustment.',
    evidence: 'agents/orchestrator.md, skills/work-unit-audit',
  },
  {
    pass: 'task-contract trust model',
    adapters: ['codex', 'copilot', 'cursor'],
    categories: ['generatedPayload'],
    previous: null, measured: null, delta: null, valuesRecorded: false,
    reason:
      'Role files now declare primary_repair_capabilities/escalation_capabilities, packaged into ' +
      'every generated role definition, and the backend docs carry the explicit carrier-state, ' +
      'append-only provenance, and offline-lint contracts. New canonical contract delivered ' +
      'through existing role and backend sources.',
    evidence: 'agents/, backends/',
  },
  {
    pass: 'P35-04',
    adapters: ['opencode'],
    categories: ['generatedPayload'],
    previous: null, measured: 11845, delta: null, valuesRecorded: false,
    reason:
      'The compact parser-controlled activation identity and exact single-role dispatch/return ' +
      'boundary inherited from canonical command, role, and delegation source. It replaces a ' +
      'lossy aggregate argument rather than adding adapter-local workflow payload.',
    evidence: '.dev/PLAN_PHASE_35.md, P35-04',
  },
  {
    pass: 'P35-04 corrective',
    adapters: ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'],
    categories: ['generatedPayload', 'agentDefinitions', 'activationSurface', 'referenceLibrary'],
    previous: null, measured: null, delta: null, valuesRecorded: false,
    reason:
      'Rebased every baseline to its freshly measured value. Three activation surfaces gained a ' +
      'typed declaration they were missing: the Copilot IDE prompt fallback shipped as a live ' +
      'activation surface stating nothing about its capture capability, and the canonical ' +
      'activation command default capability slot shipped empty even though ' +
      '.claude-plugin/plugin.json registers it as the live /agenticloop:start command. Codex, ' +
      'Copilot, and Cursor also move because fresh atomic init now discovers the canonical ' +
      'backend docs it previously missed. Measured values for required fail-closed content and ' +
      'recovered references; rebasing from a true current measurement restored real 5% headroom ' +
      'instead of leaving three budgets a handful of words from failing.',
    evidence: '.dev/PLAN_PHASE_35.md, P35-04 corrective pass',
  },
  {
    pass: 'P35-08 corrective (2026-08-08)',
    adapters: ['claude-code'],
    categories: ['agentDefinitions'],
    previous: 10572, measured: 11105, delta: 533, valuesRecorded: true,
    reason:
      'The baseline had drifted stale across P35: the tree already measured 11,105 words against ' +
      'a 10,572 baseline, leaving two words of headroom, so any required role-source edit failed. ' +
      'That pass added one sentence to agents/auditor.md telling the Auditor never to pre-compute ' +
      'a report digest - required content, since a host-computed digest over an unnormalized ' +
      'report was the defect being fixed. Re-measuring restored real 5% headroom; a deliberate ' +
      're-baseline, not a raised ceiling.',
    evidence: '.dev/PLAN_PHASE_35.md, P35-E43',
  },
  {
    pass: 'universal activation (2026-08-09)',
    adapters: ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'],
    categories: ['generatedPayload', 'agentDefinitions', 'activationSurface', 'referenceLibrary'],
    previous: 791, measured: 953, delta: 162, valuesRecorded: true,
    reason:
      'Every activation surface previously told the operator only that capture was `unsupported` ' +
      'and to stop. That was the whole reason the toolkit had no runnable dispatch path on any ' +
      'shipped host. The canonical activation command now also names the exact plugin-free ' +
      'repair - `npx agenticloop activate <task-id>`, run outside the agent session - and states ' +
      'the two honest assurance grades that result. The +162 activation-surface words per ' +
      'surface are that required content, authored once in commands/start.md and inherited by ' +
      'every adapter; claude-code moves twice as far because it packages two activation ' +
      'surfaces. referenceLibrary moves +90 from the AGENTIC_LOOP.md activation-assurance ' +
      'contract and the backends/files.md operation mapping. agentDefinitions and the remaining ' +
      'generatedPayload drift are stale pre-existing baselines re-measured in the same pass ' +
      'rather than left a few words from failing. A deliberate re-baseline against measured ' +
      'values, not a raised ceiling.',
    evidence: 'commands/start.md, AGENTIC_LOOP.md activation assurance, backends/files.md',
  },
]);

const ADAPTERS = [
  { name: 'opencode', generate: generateOpencodeArtifacts, dirs: ['.opencode'], baseline: { generatedPayload: 12712, agentDefinitions: 11759, activationSurface: 953 } },
  { name: 'codex', generate: generateCodexArtifacts, dirs: ['.codex', '.agents'], baseline: { generatedPayload: 69922, agentDefinitions: 12292, activationSurface: 1236, referenceLibrary: 56394 } },
  { name: 'claude-code', generate: generateClaudeCodeArtifacts, dirs: ['.claude'], baseline: { generatedPayload: 53691, agentDefinitions: 11105, activationSurface: 2109, referenceLibrary: 40477 } },
  { name: 'copilot', generate: generateCopilotArtifacts, dirs: ['.github'], baseline: { generatedPayload: 67876, agentDefinitions: 11945, activationSurface: 1290, referenceLibrary: 54641 } },
  { name: 'cursor', generate: generateCursorArtifacts, dirs: ['.cursor'], baseline: { generatedPayload: 67616, agentDefinitions: 11931, activationSurface: 1044, referenceLibrary: 54641 } },
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
      // Reductions are always acceptable: only the upper bound is enforced, and
      // the message reports the headroom so a future rebaseline decision has the
      // measured numbers in front of it.
      assert.ok(counts[category] <= budget,
        `${adapter.name} ${category} grew to ${counts[category]} words, exceeding the ${budget}-word generated-artifact budget (baseline ${baseline} +${Math.round(TOLERANCE * 100)}%, headroom ${budget - counts[category]}). Reduce the artifact, or deliberately rebaseline and add a BASELINE_RATIONALE record with previous, measured, delta, reason, and evidence.`);
    }
  });

  it('keeps the rebaseline history auditable', () => {
    assert.ok(BASELINE_RATIONALE.length > 0);
    const adapterNames = new Set(ADAPTERS.map(adapter => adapter.name));
    for (const record of BASELINE_RATIONALE) {
      const label = record.pass;
      assert.ok(typeof label === 'string' && label.trim(), 'every record names the pass that made it');
      assert.ok(record.adapters.length > 0, label);
      assert.ok(record.categories.length > 0, label);
      for (const name of record.adapters) assert.ok(adapterNames.has(name), `${label}: unknown adapter '${name}'`);
      for (const category of record.categories) {
        assert.ok(CATEGORIES.includes(category), `${label}: unknown category '${category}'`);
      }
      assert.ok(typeof record.reason === 'string' && record.reason.trim().length > 40, `${label}: reason`);
      assert.ok(typeof record.evidence === 'string' && record.evidence.trim(), `${label}: evidence`);
      if (record.valuesRecorded) {
        // The record requirement adopted from P35-08 onward: a raise must state
        // what it was, what it measured, and the difference between them.
        assert.equal(typeof record.previous, 'number', `${label}: previous`);
        assert.equal(typeof record.measured, 'number', `${label}: measured`);
        assert.equal(record.delta, record.measured - record.previous, `${label}: delta must equal measured - previous`);
      }
    }
  });

  it('keeps every declared baseline category measurable', () => {
    for (const adapter of ADAPTERS) {
      for (const category of Object.keys(adapter.baseline)) {
        assert.ok(CATEGORIES.includes(category), `${adapter.name} declares unknown category '${category}'`);
      }
    }
  });
});
