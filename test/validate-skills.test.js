/**
 * Tests for src/validate-skills.js and src/frontmatter.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../src/frontmatter.js';
import { validateSkills, errorCount, warningCount } from '../src/validate-skills.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('parseFrontmatter', () => {
  it('returns null fm for content without ---', () => {
    const [fm, body] = parseFrontmatter('# Title\nbody');
    assert.equal(fm, null);
    assert.equal(body, '# Title\nbody');
  });

  it('parses flat fields', () => {
    const content = '---\nname: my-skill\ndescription: Use when X\n---\nbody';
    const [fm, body] = parseFrontmatter(content);
    assert.equal(fm.name, 'my-skill');
    assert.equal(fm.description, 'Use when X');
    assert.equal(body, 'body');
  });

  it('parses CRLF frontmatter', () => {
    const content = '---\r\nname: my-skill\r\ndescription: Use when X\r\n---\r\nbody\r\nnext';
    const [fm, body] = parseFrontmatter(content);
    assert.equal(fm.name, 'my-skill');
    assert.equal(fm.description, 'Use when X');
    assert.equal(body, 'body\r\nnext');
  });

  it('parses nested mappings and quoted keys', () => {
    const content = '---\nmetadata:\n  area: engineering\npermission:\n  task:\n    "*": deny\n    maintainer: allow\n---\nbody';
    const [fm] = parseFrontmatter(content);
    assert.deepEqual(fm.metadata, { area: 'engineering' });
    assert.deepEqual(fm.permission, {
      task: {
        '*': 'deny',
        maintainer: 'allow',
      },
    });
  });

  it('parses folded and literal block scalars plus scalar lists', () => {
    const content = [
      '---',
      'description: >-',
      '  Use when a description is',
      '  intentionally wrapped.',
      'notes: |-',
      '  first line',
      '  second line',
      'paths:',
      '  - src/example.js',
      '  - "test/example.test.js"',
      'inline: [one, "two"]',
      '---',
      'body',
    ].join('\n');
    const [fm] = parseFrontmatter(content);
    assert.equal(fm.description, 'Use when a description is intentionally wrapped.');
    assert.equal(fm.notes, 'first line\nsecond line');
    assert.deepEqual(fm.paths, ['src/example.js', 'test/example.test.js']);
    assert.deepEqual(fm.inline, ['one', 'two']);
  });
});

describe('Skill validator on real skills', () => {
  it('finds 17 skills, 0 errors, 0 warnings on real skills/', () => {
    const skillsDir = join(REPO_ROOT, 'skills');
    const report = validateSkills(skillsDir);
    assert.equal(Object.keys(report.skills).length, 17, 'expected 17 skills');
    assert.equal(errorCount(report), 0, 'expected 0 errors');
    assert.equal(warningCount(report), 0, 'expected 0 warnings');
  });

  it('all real skills have trust metadata', () => {
    const skillsDir = join(REPO_ROOT, 'skills');
    const report = validateSkills(skillsDir);
    for (const name of Object.keys(report.skills)) {
      const errs = report.skills[name].errors;
      assert.ok(!errs.some(e => e.includes('trust metadata')), `${name} should have trust metadata fields`);
    }
  });

  it('role-delegation and setup-agenticloop are linked from canonical skills', () => {
    const skillsDir = join(REPO_ROOT, 'skills');
    const report = validateSkills(skillsDir);
    const rd = report.skills['role-delegation'];
    const setup = report.skills['setup-agenticloop'];
    assert.ok(rd, 'role-delegation skill must exist');
    assert.ok(setup, 'setup-agenticloop skill must exist');
    assert.ok(!rd.warnings.some(w => w.includes('Orphan skill')));
    assert.ok(!setup.warnings.some(w => w.includes('Orphan skill')));
  });
});

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-skills-test-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeSkill(dir, name, frontmatter, body) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const fm = frontmatter ?? `---\nname: ${name}\ndescription: Use when testing\nmetadata:\n  area: test\n  side_effects: none\n  credentials: none\n  runs_scripts: none\n---\n`;
  writeFileSync(join(skillDir, 'SKILL.md'), fm + (body ?? 'body text '.repeat(10)));
}

describe('Broken [[skill-name]] link', () => {
  it('produces an error for a link to a non-existent skill', () => {
    const d = mkdtempSync(join(tmpDir, 'broken-link-'));
    makeSkill(d, 'alpha', null, '[[nonexistent]] ' + 'words '.repeat(10));
    const report = validateSkills(d);
    assert.ok(report.skills.alpha.errors.some(e => e.includes('Broken link')));
  });
});

describe('[[agent: ...]] attribution', () => {
  it('does not treat [[agent: maintainer]] as a skill link', () => {
    const d = mkdtempSync(join(tmpDir, 'agent-attr-'));
    makeSkill(d, 'beta', null, '[[agent: maintainer]] does something. ' + 'words '.repeat(10));
    const report = validateSkills(d);
    const errs = report.skills.beta.errors;
    assert.ok(!errs.some(e => e.includes('maintainer')));
  });
});

describe('Orphan skill warning', () => {
  it('warns but does not fail when a skill has no inbound links', () => {
    const d = mkdtempSync(join(tmpDir, 'orphan-'));
    makeSkill(d, 'orphan-skill', null, 'standalone body '.repeat(5));
    const report = validateSkills(d);
    assert.ok(report.skills['orphan-skill'].warnings.some(w => w.includes('Orphan skill')));
    assert.equal(report.skills['orphan-skill'].errors.length, 0);
  });
});

describe('Missing SKILL.md', () => {
  it('errors on a skill directory without SKILL.md', () => {
    const d = mkdtempSync(join(tmpDir, 'missing-md-'));
    mkdirSync(join(d, 'empty-skill'));
    const report = validateSkills(d);
    assert.ok(report.skills['empty-skill'].errors.some(e => e.includes('Missing SKILL.md')));
  });
});

describe('Required frontmatter fields', () => {
  it('errors on missing metadata.area', () => {
    const d = mkdtempSync(join(tmpDir, 'missing-area-'));
    makeSkill(d, 'no-area', '---\nname: no-area\ndescription: Use when X\n---\n', 'body '.repeat(10));
    const report = validateSkills(d);
    assert.ok(report.skills['no-area'].errors.some(e => e.includes('metadata.area')));
  });

  it('errors on name mismatch', () => {
    const d = mkdtempSync(join(tmpDir, 'name-mismatch-'));
    makeSkill(d, 'actual-name', '---\nname: wrong-name\ndescription: Use when X\nmetadata:\n  area: test\n---\n', 'body '.repeat(10));
    const report = validateSkills(d);
    assert.ok(report.skills['actual-name'].errors.some(e => e.includes('mismatch')));
  });
});

describe('Word count warnings', () => {
  it('warns when body is very short', () => {
    const d = mkdtempSync(join(tmpDir, 'short-body-'));
    makeSkill(d, 'tiny', null, 'short');
    const report = validateSkills(d);
    assert.ok(report.skills.tiny.warnings.some(w => w.includes('very short')));
  });

  it('does not count Markdown punctuation or standalone dashes as words', () => {
    const d = mkdtempSync(join(tmpDir, 'markdown-punctuation-'));
    const body = '## - * ``` \u2013 \u2014 '.repeat(60);
    makeSkill(d, 'punctuation-only', null, body);
    const report = validateSkills(d);
    assert.ok(report.skills['punctuation-only'].warnings.some(w => w.includes('very short (0 words)')));
  });

  it('counts words joined by internal hyphens and dashes as words', () => {
    const d = mkdtempSync(join(tmpDir, 'joined-words-'));
    const body = 'well-known end-to-end pre\u2013review post\u2014review '.repeat(13);
    makeSkill(d, 'joined-words', null, body);
    const report = validateSkills(d);
    assert.ok(!report.skills['joined-words'].warnings.some(w => w.includes('very short')));
  });

  it('warns when an ordinary skill body exceeds 5000 readable words', () => {
    const d = mkdtempSync(join(tmpDir, 'long-body-'));
    makeSkill(d, 'below-long-limit', null, 'word '.repeat(4500));
    makeSkill(d, 'above-long-limit', null, 'word '.repeat(5001));
    const report = validateSkills(d);
    assert.ok(!report.skills['below-long-limit'].warnings.some(w => w.includes('Body is long')));
    assert.ok(report.skills['above-long-limit'].warnings.some(w => w.includes('Body is long (5001 words)')));
  });

  it('keeps a narrow 5200-word exception for the canonical review contract only', () => {
    const d = mkdtempSync(join(tmpDir, 'review-long-body-'));
    makeSkill(d, 'review-and-accept', null, 'word '.repeat(5100));
    makeSkill(d, 'ordinary-skill', null, 'word '.repeat(5100));
    const report = validateSkills(d);
    assert.ok(!report.skills['review-and-accept'].warnings.some(w => w.includes('Body is long')));
    assert.ok(report.skills['ordinary-skill'].warnings.some(w => w.includes('Body is long (5100 words)')));
  });
});

describe('Trigger phrase warning', () => {
  it('warns when description has no trigger phrase', () => {
    const d = mkdtempSync(join(tmpDir, 'no-trigger-'));
    makeSkill(d, 'no-trigger', '---\nname: no-trigger\ndescription: This is useful for X\nmetadata:\n  area: test\n  side_effects: none\n  credentials: none\n  runs_scripts: none\n---\n', 'body '.repeat(10));
    const report = validateSkills(d);
    assert.ok(report.skills['no-trigger'].warnings.some(w => w.includes('trigger phrase')));
  });
});

describe('Trust metadata validation', () => {
  const baseFm = (extra = '') => `---\nname: trust-test\ndescription: Use when testing\nmetadata:\n  area: test\n${extra}---\n`;

  it('errors when trust metadata fields are missing', () => {
    const d = mkdtempSync(join(tmpDir, 'trust-missing-'));
    makeSkill(d, 'no-trust', '---\nname: no-trust\ndescription: Use when testing\nmetadata:\n  area: test\n---\n', 'body '.repeat(10));
    const report = validateSkills(d);
    assert.ok(report.skills['no-trust'].errors.some(e => e.includes('metadata.side_effects')));
    assert.ok(report.skills['no-trust'].errors.some(e => e.includes('metadata.credentials')));
    assert.ok(report.skills['no-trust'].errors.some(e => e.includes('metadata.runs_scripts')));
  });

  it('errors on invalid trust enum values', () => {
    const d = mkdtempSync(join(tmpDir, 'trust-enum-'));
    makeSkill(d, 'bad-trust', baseFm('  side_effects: deletes-everything\n  credentials: secret-token\n  runs_scripts: sometimes\n'), 'body '.repeat(10));
    const report = validateSkills(d);
    assert.ok(report.skills['bad-trust'].errors.some(e => e.includes('metadata.side_effects')));
    assert.ok(report.skills['bad-trust'].errors.some(e => e.includes('metadata.credentials')));
    assert.ok(report.skills['bad-trust'].errors.some(e => e.includes('metadata.runs_scripts')));
  });

  it('errors when a skill with scripts/ claims runs_scripts: none', () => {
    const d = mkdtempSync(join(tmpDir, 'trust-scripts-'));
    makeSkill(d, 'has-scripts', baseFm('  side_effects: none\n  credentials: none\n  runs_scripts: none\n'), 'body '.repeat(10));
    mkdirSync(join(d, 'has-scripts', 'scripts'), { recursive: true });
    const report = validateSkills(d);
    assert.ok(report.skills['has-scripts'].errors.some(e => e.includes('scripts/ directory')));
  });

  it('errors when a GitHub-writing skill does not declare github-cli credentials', () => {
    const d = mkdtempSync(join(tmpDir, 'trust-github-'));
    makeSkill(d, 'gh-writer', baseFm('  side_effects: writes-github\n  credentials: none\n  runs_scripts: none\n'), 'body '.repeat(10));
    const report = validateSkills(d);
    assert.ok(report.skills['gh-writer'].errors.some(e => e.includes('credentials: github-cli')));
  });

  it('accepts backend-dependent credentials for backend-writing skills', () => {
    const d = mkdtempSync(join(tmpDir, 'trust-backend-'));
    makeSkill(
      d,
      'backend-writer',
      '---\nname: backend-writer\ndescription: Use when testing\nmetadata:\n  area: test\n  side_effects: writes-backend\n  credentials: backend-dependent\n  runs_scripts: none\n---\n',
      'body '.repeat(10)
    );
    const report = validateSkills(d);
    assert.deepEqual(report.skills['backend-writer'].errors, []);
  });
});
