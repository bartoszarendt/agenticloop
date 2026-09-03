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
 *   changes?: Array<{
 *     adapter: string,
 *     category: string,
 *     previous: number,
 *     measured: number,
 *     delta: number,
 *   }>,
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
    evidence: 'internal planning evidence, P35-04',
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
    evidence: 'internal planning evidence, P35-04 corrective pass',
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
    evidence: 'internal planning evidence, P35-E43',
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
  {
    pass: 'dual-mode auditor (2026-08-12)',
    adapters: ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'],
    categories: ['generatedPayload', 'agentDefinitions', 'activationSurface', 'referenceLibrary'],
    previous: null, measured: null, delta: null, valuesRecorded: true,
    changes: [
      { adapter: 'opencode', category: 'generatedPayload', previous: 12712, measured: 14061, delta: 1349 },
      { adapter: 'opencode', category: 'agentDefinitions', previous: 11759, measured: 13084, delta: 1325 },
      { adapter: 'opencode', category: 'activationSurface', previous: 953, measured: 977, delta: 24 },
      { adapter: 'codex', category: 'generatedPayload', previous: 69922, measured: 71644, delta: 1722 },
      { adapter: 'codex', category: 'agentDefinitions', previous: 12292, measured: 13516, delta: 1224 },
      { adapter: 'codex', category: 'activationSurface', previous: 1236, measured: 1260, delta: 24 },
      { adapter: 'codex', category: 'referenceLibrary', previous: 56394, measured: 56868, delta: 474 },
      { adapter: 'claude-code', category: 'generatedPayload', previous: 53691, measured: 54913, delta: 1222 },
      { adapter: 'claude-code', category: 'agentDefinitions', previous: 11105, measured: 12094, delta: 989 },
      { adapter: 'claude-code', category: 'activationSurface', previous: 2109, measured: 2157, delta: 48 },
      { adapter: 'claude-code', category: 'referenceLibrary', previous: 40477, measured: 40662, delta: 185 },
      { adapter: 'copilot', category: 'generatedPayload', previous: 67876, measured: 69622, delta: 1746 },
      { adapter: 'copilot', category: 'agentDefinitions', previous: 11945, measured: 13193, delta: 1248 },
      { adapter: 'copilot', category: 'activationSurface', previous: 1290, measured: 1314, delta: 24 },
      { adapter: 'copilot', category: 'referenceLibrary', previous: 54641, measured: 55115, delta: 474 },
      { adapter: 'cursor', category: 'generatedPayload', previous: 67616, measured: 69370, delta: 1754 },
      { adapter: 'cursor', category: 'agentDefinitions', previous: 11931, measured: 13187, delta: 1256 },
      { adapter: 'cursor', category: 'activationSurface', previous: 1044, measured: 1068, delta: 24 },
      { adapter: 'cursor', category: 'referenceLibrary', previous: 54641, measured: 55115, delta: 474 },
    ],
    reason:
      'The Auditor gained a second operating mode, so its canonical role file now carries two ' +
      'contracts instead of one: mode selection, a shared read-only boundary, the standalone ' +
      'non-certifying assessment contract, and the unchanged Agentic Loop certification contract ' +
      '(packet, six perspectives, four verdicts, auditor_report_v1, provenance, budget, ' +
      're-audit). This is the same shape as the earlier dual-mode engineer rebaseline and is ' +
      'authored once in agents/auditor.md, inherited by every host. agentDefinitions carries that ' +
      'body plus the three-line shared STANDALONE_AUDITOR_PREAMBLE_LINES and the OpenCode ' +
      'engineer preamble that host had been missing; the structured changes enumerate all 19 ' +
      'raised adapter/category baselines. activationSurface moves +24 from the dual-mode role description in ' +
      'config.json alone. referenceLibrary moves from the AGENTIC_LOOP.md standalone-auditor ' +
      'activation and glossary text and the work-unit-audit entry guard. No canonical block was ' +
      'copied into an adapter and no formal certification requirement was removed; a deliberate ' +
      're-baseline against measured values, not a raised ceiling.',
    evidence: 'agents/auditor.md, src/adapters/shared.js STANDALONE_AUDITOR_PREAMBLE_LINES, AGENTIC_LOOP.md, skills/work-unit-audit/SKILL.md',
  },
  {
    pass: 'post-dual-mode lifecycle contracts (2026-08-31)',
    adapters: ['claude-code'],
    categories: ['agentDefinitions'],
    previous: 12094, measured: 12721, delta: 627, valuesRecorded: true,
    changes: [
      { adapter: 'claude-code', category: 'agentDefinitions', previous: 12094, measured: 12721, delta: 627 },
    ],
    reason:
      'Canonical role definitions gained the required attempt, readiness, handoff, review, and return-state contracts after the dual-mode Auditor measurement. Claude Code packages those role definitions directly; the measured increase is shared canonical capability rather than adapter-specific duplication.',
    evidence: 'git history 94c321c..7315ecc for agents/',
  },
  {
    pass: 'lifecycle evidence remediation payload (2026-09-01)',
    adapters: ['opencode', 'copilot', 'cursor'],
    categories: ['generatedPayload'],
    previous: null, measured: null, delta: null, valuesRecorded: true,
    changes: [
      { adapter: 'opencode', category: 'generatedPayload', previous: 14061, measured: 14970, delta: 909 },
      { adapter: 'copilot', category: 'generatedPayload', previous: 69622, measured: 73136, delta: 3514 },
      { adapter: 'cursor', category: 'generatedPayload', previous: 69370, measured: 72884, delta: 3514 },
    ],
    reason:
      'Canonical roles and reference material now carry the executable role-start ordering, exact ' +
      'audit currency, return-attempt dispositions, evidence-v4 binding, idempotent verification, ' +
      'and bounded safe-retry rules required by the lifecycle remediation. The content remains ' +
      'authored once in existing role, skill, backend, and methodology sources; adapters only ' +
      'package those sources through their established surfaces.',
    evidence: 'agents/, skills/, backends/files.md, AGENTIC_LOOP.md lifecycle evidence remediation',
  },
  {
    pass: 'lifecycle evidence remediation roles (2026-09-01)',
    adapters: ['opencode', 'codex', 'copilot', 'cursor'],
    categories: ['agentDefinitions'],
    previous: null, measured: null, delta: null, valuesRecorded: true,
    changes: [
      { adapter: 'opencode', category: 'agentDefinitions', previous: 13084, measured: 13993, delta: 909 },
      { adapter: 'codex', category: 'agentDefinitions', previous: 13516, measured: 14303, delta: 787 },
      { adapter: 'copilot', category: 'agentDefinitions', previous: 13193, measured: 14006, delta: 813 },
      { adapter: 'cursor', category: 'agentDefinitions', previous: 13187, measured: 14000, delta: 813 },
    ],
    reason:
      'The canonical Engineer, Maintainer, and Orchestrator definitions now state the exact ' +
      'role-start, evidence publication, return, review, and recovery responsibilities required ' +
      'by the lifecycle remediation. Each adapter inherits the same role sources without an ' +
      'adapter-local copy.',
    evidence: 'agents/engineer.md, agents/maintainer.md, agents/orchestrator.md',
  },
  {
    pass: 'files lifecycle reliability Codex contract (2026-09-03)',
    adapters: ['codex'],
    categories: ['generatedPayload', 'referenceLibrary'],
    previous: null, measured: null, delta: null, valuesRecorded: true,
    changes: [
      { adapter: 'codex', category: 'generatedPayload', previous: 71644, measured: 76593, delta: 4949 },
      { adapter: 'codex', category: 'referenceLibrary', previous: 56868, measured: 60541, delta: 3673 },
    ],
    reason:
      'The Codex payload packages the canonical lifecycle roles plus the shared reference ' +
      'library carrying the files reliability contract; neither surface adds adapter-local workflow.',
    evidence: 'agents/, skills/, backends/files.md, AGENTIC_LOOP.md, test/files-lifecycle-reliability.test.js',
  },
  {
    pass: 'files lifecycle reliability Claude role contract (2026-09-03)',
    adapters: ['claude-code'],
    categories: ['agentDefinitions'],
    previous: 12721, measured: 13390, delta: 669, valuesRecorded: true,
    changes: [
      { adapter: 'claude-code', category: 'agentDefinitions', previous: 12721, measured: 13390, delta: 669 },
    ],
    reason:
      'Claude Code packages the expanded canonical role definitions that specify live carrier ' +
      'freezing, predictive preflight, and repeated-refusal stopping without an adapter-local copy.',
    evidence: 'agents/engineer.md, agents/maintainer.md, agents/orchestrator.md',
  },
  {
    pass: 'files lifecycle reliability shared references (2026-09-03)',
    adapters: ['copilot', 'cursor'],
    categories: ['referenceLibrary'],
    previous: 55115, measured: 58788, delta: 3673, valuesRecorded: true,
    changes: [
      { adapter: 'copilot', category: 'referenceLibrary', previous: 55115, measured: 58788, delta: 3673 },
      { adapter: 'cursor', category: 'referenceLibrary', previous: 55115, measured: 58788, delta: 3673 },
    ],
    reason:
      'Copilot and Cursor package the same canonical skills, backend guidance, and methodology ' +
      'for scratch checks, carried lineage, predictive preflight, and blocked-return authority.',
    evidence: 'skills/, backends/files.md, AGENTIC_LOOP.md, test/files-lifecycle-reliability.test.js',
  },
  {
    pass: 'dual-mode Maintainer (2026-09-03)',
    adapters: ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'],
    categories: ['generatedPayload', 'agentDefinitions', 'activationSurface', 'referenceLibrary'],
    previous: null, measured: null, delta: null, valuesRecorded: true,
    changes: [
      { adapter: 'opencode', category: 'generatedPayload', previous: 14970, measured: 16156, delta: 1186 },
      { adapter: 'opencode', category: 'agentDefinitions', previous: 13993, measured: 15179, delta: 1186 },
      { adapter: 'opencode', category: 'activationSurface', previous: 977, measured: 977, delta: 0 },
      { adapter: 'codex', category: 'generatedPayload', previous: 76593, measured: 76885, delta: 292 },
      { adapter: 'codex', category: 'agentDefinitions', previous: 14303, measured: 15482, delta: 1179 },
      { adapter: 'codex', category: 'activationSurface', previous: 1260, measured: 1260, delta: 0 },
      { adapter: 'codex', category: 'referenceLibrary', previous: 60541, measured: 60143, delta: -398 },
      { adapter: 'claude-code', category: 'generatedPayload', previous: 54913, measured: 57503, delta: 2590 },
      { adapter: 'claude-code', category: 'agentDefinitions', previous: 13390, measured: 13964, delta: 574 },
      { adapter: 'claude-code', category: 'activationSurface', previous: 2157, measured: 2157, delta: 0 },
      { adapter: 'claude-code', category: 'referenceLibrary', previous: 40662, measured: 41382, delta: 720 },
      { adapter: 'copilot', category: 'generatedPayload', previous: 73136, measured: 74914, delta: 1778 },
      { adapter: 'copilot', category: 'agentDefinitions', previous: 14006, measured: 15210, delta: 1204 },
      { adapter: 'copilot', category: 'activationSurface', previous: 1314, measured: 1314, delta: 0 },
      { adapter: 'copilot', category: 'referenceLibrary', previous: 58788, measured: 58390, delta: -398 },
      { adapter: 'cursor', category: 'generatedPayload', previous: 72884, measured: 74666, delta: 1782 },
      { adapter: 'cursor', category: 'agentDefinitions', previous: 14000, measured: 15208, delta: 1208 },
      { adapter: 'cursor', category: 'activationSurface', previous: 1068, measured: 1068, delta: 0 },
      { adapter: 'cursor', category: 'referenceLibrary', previous: 58788, measured: 58390, delta: -398 },
    ],
    reason:
      'The Maintainer gained one canonical dual-mode contract in agents/maintainer.md, and the ' +
      'wrapping adapters inherit one shared compact STANDALONE_MAINTAINER_PREAMBLE_LINES block ' +
      'before workflow-state instructions. Claude Code continues to package the canonical role ' +
      'body directly without adapter-local prose. Methodology and public activation guidance ' +
      'carry the matching standalone boundary once in their existing canonical surfaces. The ' +
      'measurements record every declared category, including unchanged activation surfaces and ' +
      'pre-existing downward reference-library drift, rather than merely raising ceilings.',
    evidence: 'agents/maintainer.md, src/adapters/shared.js STANDALONE_MAINTAINER_PREAMBLE_LINES, src/adapters/, src/guidance.js, AGENTIC_LOOP.md',
  },
]);

const ADAPTERS = [
  { name: 'opencode', generate: generateOpencodeArtifacts, dirs: ['.opencode'], baseline: { generatedPayload: 16156, agentDefinitions: 15179, activationSurface: 977 } },
  { name: 'codex', generate: generateCodexArtifacts, dirs: ['.codex', '.agents'], baseline: { generatedPayload: 76885, agentDefinitions: 15482, activationSurface: 1260, referenceLibrary: 60143 } },
  { name: 'claude-code', generate: generateClaudeCodeArtifacts, dirs: ['.claude'], baseline: { generatedPayload: 57503, agentDefinitions: 13964, activationSurface: 2157, referenceLibrary: 41382 } },
  { name: 'copilot', generate: generateCopilotArtifacts, dirs: ['.github'], baseline: { generatedPayload: 74914, agentDefinitions: 15210, activationSurface: 1314, referenceLibrary: 58390 } },
  { name: 'cursor', generate: generateCursorArtifacts, dirs: ['.cursor'], baseline: { generatedPayload: 74666, agentDefinitions: 15208, activationSurface: 1068, referenceLibrary: 58390 } },
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
    const latestChanges = new Map();
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
        if (Array.isArray(record.changes)) {
          const expectedPairs = new Set();
          for (const adapterName of record.adapters) {
            const adapter = ADAPTERS.find(candidate => candidate.name === adapterName);
            for (const category of record.categories) {
              if (Object.hasOwn(adapter.baseline, category)) expectedPairs.add(`${adapterName}:${category}`);
            }
          }
          const actualPairs = new Set();
          for (const change of record.changes) {
            const pair = `${change.adapter}:${change.category}`;
            assert.ok(expectedPairs.has(pair), `${label}: undeclared baseline change '${pair}'`);
            assert.ok(!actualPairs.has(pair), `${label}: duplicate baseline change '${pair}'`);
            actualPairs.add(pair);
            assert.equal(typeof change.previous, 'number', `${label}: ${pair} previous`);
            assert.equal(typeof change.measured, 'number', `${label}: ${pair} measured`);
            assert.equal(change.delta, change.measured - change.previous, `${label}: ${pair} delta must equal measured - previous`);
            latestChanges.set(pair, change);
          }
          assert.deepEqual(actualPairs, expectedPairs, `${label}: every declared raised baseline must have numeric accounting`);
        } else {
          // Older numeric records captured one representative raise before the
          // per-adapter/category changes shape was introduced.
          assert.equal(typeof record.previous, 'number', `${label}: previous`);
          assert.equal(typeof record.measured, 'number', `${label}: measured`);
          assert.equal(record.delta, record.measured - record.previous, `${label}: delta must equal measured - previous`);
        }
      }
    }
    for (const [pair, change] of latestChanges) {
      const adapter = ADAPTERS.find(candidate => candidate.name === change.adapter);
      assert.equal(change.measured, adapter.baseline[change.category], `${pair}: latest measurement must equal its declared baseline`);
    }
  });

  it('keeps every declared baseline category measurable', () => {
    for (const adapter of ADAPTERS) {
      for (const category of Object.keys(adapter.baseline)) {
        assert.ok(CATEGORIES.includes(category), `${adapter.name} declares unknown category '${category}'`);
      }
    }
  });

  it('does not project the retired generated-guidance literal into any adapter target', () => {
    for (const adapter of ADAPTERS) {
      const fx = mkdtempSync(join(tmpDir, `${adapter.name}-literal-fx-`));
      seedTargetLayout(REPO_ROOT, fx, { includeDocs: false, includeScratch: false });
      const out = mkdtempSync(join(tmpDir, `${adapter.name}-literal-out-`));
      adapter.generate(loadAgenticLoopConfig(join(fx, 'agenticloop.json')), fx, out);
      const projected = readFileSync(join(fx, 'agenticloop', 'AGENTIC_LOOP.md'), 'utf8');
      assert.doesNotMatch(projected, /reevaluated P35-03/);
      for (const file of walk(out)) {
        if (!/\.(md|toml|ya?ml)$/.test(file)) continue;
        assert.doesNotMatch(readFileSync(file, 'utf8'), /reevaluated P35-03/, `${adapter.name}: ${file}`);
      }
    }
  });
});
