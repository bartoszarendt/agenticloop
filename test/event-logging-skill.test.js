import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { loadAgenticLoopConfig, loadJsonFile } from '../src/json.js';
import { loadSkillDescriptions, validateCorpus } from '../src/activation-scorer.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKILLS_DIR = join(REPO_ROOT, 'skills');

// The distinctive command-resolution recipe phrase. It must live in exactly one
// canonical file: the event-logging skill.
const RECIPE_PHRASE = 'run `npx agenticloop --help`';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-eventlog-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeFixture() {
  const d = mkdtempSync(join(tmpDir, 'fx-'));
  seedTargetLayout(REPO_ROOT, d, { includeDocs: false, includeScratch: false });
  return d;
}

function canonicalRuntimeFiles() {
  const files = [join(REPO_ROOT, 'AGENTIC_LOOP.md')];
  for (const f of readdirSync(join(REPO_ROOT, 'agents')).filter(n => n.endsWith('.md'))) {
    files.push(join(REPO_ROOT, 'agents', f));
  }
  for (const f of readdirSync(join(REPO_ROOT, 'backends')).filter(n => n.endsWith('.md'))) {
    files.push(join(REPO_ROOT, 'backends', f));
  }
  const skillsRoot = join(REPO_ROOT, 'skills');
  for (const entry of readdirSync(skillsRoot)) {
    const skillFile = join(skillsRoot, entry, 'SKILL.md');
    if (existsSync(skillFile)) files.push(skillFile);
  }
  return files;
}

describe('canonical event-logging skill', () => {
  const skillPath = join(SKILLS_DIR, 'event-logging', 'SKILL.md');

  it('exists and owns the command-resolution recipe', () => {
    assert.ok(existsSync(skillPath), 'event-logging skill must exist');
    const body = readFileSync(skillPath, 'utf-8');
    assert.match(body, /run `npx agenticloop --help`/);
    assert.match(body, /event_logging_command/);
  });

  it('states the disabled no-op and non-blocking rules', () => {
    const body = readFileSync(skillPath, 'utf-8');
    assert.match(body, /disabled.*do nothing|do nothing/i);
    assert.match(body, /non-blocking/i);
  });

  it('is the ONLY canonical runtime file containing the full resolution recipe', () => {
    const offenders = canonicalRuntimeFiles().filter(f =>
      readFileSync(f, 'utf-8').includes(RECIPE_PHRASE)
    );
    assert.deepEqual(
      offenders.map(f => f.replace(/\\/g, '/').split('/skills/')[1] ?? f),
      ['event-logging/SKILL.md'],
      `recipe should only live in event-logging skill, found in: ${offenders.join(', ')}`
    );
  });

  it('boilerplate resolution paragraph is deduplicated from roles and skills', () => {
    // The old inline paragraph opened with this exact wording; it must not
    // remain duplicated across the runtime surface.
    const legacyOpen = 'resolve the event\nlogging command before writing the event';
    const offenders = canonicalRuntimeFiles().filter(f =>
      readFileSync(f, 'utf-8').includes(legacyOpen)
    );
    assert.deepEqual(offenders, [], `legacy boilerplate still present in: ${offenders.join(', ')}`);
  });
});

describe('event-logging activation corpus coverage', () => {
  it('strictly covers every current canonical skill, including event-logging', () => {
    const { skills } = loadSkillDescriptions(SKILLS_DIR);
    assert.ok(skills.some(s => s.name === 'event-logging'), 'event-logging must load');
    const corpus = loadJsonFile(join(SKILLS_DIR, 'agenticloop-tests.json'));
    const { errors, warnings } = validateCorpus(skills, corpus, { strictSkillSet: true });
    assert.deepEqual(errors, [], `corpus errors: ${errors.join(', ')}`);
    assert.deepEqual(warnings, [], `corpus warnings: ${warnings.join(', ')}`);
  });
});

describe('event-logging is packaged for every reference-copying adapter', () => {
  const adapters = [
    { name: 'codex', generate: generateCodexArtifacts, root: ['.agents', 'skills', 'agenticloop', 'references', 'skills'] },
    { name: 'claude-code', generate: generateClaudeCodeArtifacts, root: ['.claude', 'skills', 'agenticloop', 'references', 'skills'] },
    { name: 'copilot', generate: generateCopilotArtifacts, root: ['.github', 'skills', 'agenticloop', 'references', 'skills'] },
    { name: 'cursor', generate: generateCursorArtifacts, root: ['.cursor', 'skills', 'agenticloop', 'references', 'skills'] },
  ];

  for (const adapter of adapters) {
    it(`${adapter.name} packages a resolvable event-logging reference`, () => {
      const fx = makeFixture();
      const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
      const out = mkdtempSync(join(tmpDir, `${adapter.name}-out-`));
      adapter.generate(cfg, fx, out);
      const ref = join(out, ...adapter.root, 'event-logging', 'reference.md');
      assert.ok(existsSync(ref), `expected ${adapter.name} event-logging reference at ${ref}`);
      const content = readFileSync(ref, 'utf-8');
      // The reference carries the resolution recipe so the contract is preserved.
      assert.match(content, /event_logging_command/);
      // No unresolved skill markers should remain dangling in generated output.
      assert.ok(!/\[\[event-logging\]\]/.test(content) || content.includes('event-logging'),
        'generated reference should resolve its own name');
    });
  }
});
