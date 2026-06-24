/**
 * Tests for src/activation-scorer.js.
 *
 * Covers:
 *   - skill description loading from real skills/
 *   - deterministic ranking,
 *   - corpus validation,
 *   - activation regression checks against skills/agenticloop-tests.json.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadSkillDescriptions,
  rankSkills,
  validateCorpus,
  runActivationCorpus,
} from '../src/activation-scorer.js';
import { parseJson } from '../src/json.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const CORPUS_PATH = join(REPO_ROOT, 'skills', 'agenticloop-tests.json');

function loadCorpus() {
  return parseJson(readFileSync(CORPUS_PATH, 'utf-8'));
}

describe('loadSkillDescriptions', () => {
  it('loads all 15 canonical skills with no errors', () => {
    // Intentional canonical-skill tripwire: this count must be updated when
    // skills are added or removed from the toolkit, and agenticloop-tests.json
    // must cover every canonical skill.
    const { skills, errors } = loadSkillDescriptions(SKILLS_DIR);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join(', ')}`);
    assert.equal(skills.length, 15, 'expected 15 canonical skills');
    assert.ok(skills.some(s => s.name === 'task-record-contract'));
  });
});

describe('rankSkills', () => {
  it('ranks a matching skill highly for a direct trigger prompt', () => {
    const { skills } = loadSkillDescriptions(SKILLS_DIR);
    const ranked = rankSkills(skills, 'Create the durable task record with scope and acceptance criteria.');
    assert.equal(ranked[0].name, 'task-record-contract', `expected task-record-contract first, got ${ranked[0].name}`);
    assert.ok(ranked[0].score > 0, 'expected a non-zero score');
  });

  it('returns a deterministic order for ties', () => {
    const { skills } = loadSkillDescriptions(SKILLS_DIR);
    const prompt = 'The quick brown fox jumps over the lazy dog';
    const a = rankSkills(skills, prompt);
    const b = rankSkills(skills, prompt);
    assert.deepEqual(a, b);
  });
});

describe('Activation corpus', () => {
  it('corpus strictly covers every current canonical skill', () => {
    const { skills } = loadSkillDescriptions(SKILLS_DIR);
    const corpus = loadCorpus();
    const result = validateCorpus(skills, corpus, { strictSkillSet: true });
    assert.equal(result.errors.length, 0, `corpus validation errors: ${result.errors.join(', ')}`);
    assert.equal(result.warnings.length, 0, `unexpected warnings: ${result.warnings.join(', ')}`);
  });

  it('every skill in the corpus has all three prompt categories', () => {
    const corpus = loadCorpus();
    for (const [name, entry] of Object.entries(corpus.skills)) {
      assert.ok(Array.isArray(entry.shouldTrigger) && entry.shouldTrigger.length > 0,
        `${name} missing shouldTrigger prompts`);
      assert.ok(Array.isArray(entry.shouldNotTrigger) && entry.shouldNotTrigger.length > 0,
        `${name} missing shouldNotTrigger prompts`);
      assert.ok(Array.isArray(entry.nearMiss) && entry.nearMiss.length > 0,
        `${name} missing nearMiss prompts`);
    }
  });

  it('activation regression suite passes', () => {
    const { skills } = loadSkillDescriptions(SKILLS_DIR);
    const corpus = loadCorpus();
    const { passed, failures } = runActivationCorpus(skills, corpus);
    assert.equal(passed, true, `activation regressions:\n${failures.join('\n')}`);
  });

  it('warning mode warns when a loaded skill has no corpus entry', () => {
    const skills = [{ name: 'custom-skill', description: 'A custom skill.' }];
    const corpus = { skills: {} };
    const { errors, warnings } = validateCorpus(skills, corpus);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("Corpus missing skill 'custom-skill'"));
  });

  it('warning mode warns when a corpus entry references an unknown skill', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const corpus = {
      skills: {
        'known-skill': {
          shouldTrigger: ['trigger'],
          shouldNotTrigger: ['not trigger'],
          nearMiss: ['miss'],
        },
        'stale-skill': {
          shouldTrigger: ['trigger'],
          shouldNotTrigger: ['not trigger'],
          nearMiss: ['miss'],
        },
      },
    };
    const { errors, warnings } = validateCorpus(skills, corpus);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("Corpus references unknown skill 'stale-skill'"));
  });

  it('strict mode errors when a loaded skill has no corpus entry', () => {
    const skills = [{ name: 'custom-skill', description: 'A custom skill.' }];
    const corpus = { skills: {} };
    const { errors, warnings } = validateCorpus(skills, corpus, { strictSkillSet: true });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("Corpus missing skill 'custom-skill'"));
    assert.equal(warnings.length, 0);
  });

  it('strict mode errors when a corpus entry references an unknown skill', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const corpus = {
      skills: {
        'known-skill': {
          shouldTrigger: ['trigger'],
          shouldNotTrigger: ['not trigger'],
          nearMiss: ['miss'],
        },
        'stale-skill': {
          shouldTrigger: ['trigger'],
          shouldNotTrigger: ['not trigger'],
          nearMiss: ['miss'],
        },
      },
    };
    const { errors, warnings } = validateCorpus(skills, corpus, { strictSkillSet: true });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("Corpus references unknown skill 'stale-skill'"));
    assert.equal(warnings.length, 0);
  });

  it('runActivationCorpus reports a malformed corpus without throwing', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const { passed, failures } = runActivationCorpus(skills, {});
    assert.equal(passed, false);
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes('Corpus missing top-level "skills" object'));
  });

  it('runActivationCorpus reports a non-object skills map without throwing', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const { passed, failures } = runActivationCorpus(skills, { skills: [] });
    assert.equal(passed, false);
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes('Corpus missing top-level "skills" object'));
  });

  it('runActivationCorpus reports a malformed skill entry without throwing', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const { passed, failures } = runActivationCorpus(skills, {
      skills: {
        'known-skill': null,
      },
    });
    assert.equal(passed, false);
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes("Skill 'known-skill' corpus entry must be an object"));
  });

  it('runActivationCorpus skips entries for unknown skills', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const corpus = {
      skills: {
        'known-skill': {
          shouldTrigger: ['trigger known'],
          shouldNotTrigger: ['not trigger'],
          nearMiss: ['miss'],
        },
        'unknown-skill': {
          shouldTrigger: ['would fail if evaluated'],
          shouldNotTrigger: ['not trigger'],
          nearMiss: ['miss'],
        },
      },
    };
    const { passed, failures } = runActivationCorpus(skills, corpus);
    assert.equal(passed, true);
    assert.equal(failures.length, 0);
  });

  it('reports malformed corpus as a structural error', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const { errors, warnings } = validateCorpus(skills, {});
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('Corpus missing top-level "skills" object'));
    assert.equal(warnings.length, 0);
  });

  it('reports non-object skills map as a structural error', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const { errors, warnings } = validateCorpus(skills, { skills: [] });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('Corpus missing top-level "skills" object'));
    assert.equal(warnings.length, 0);
  });

  it('reports malformed skill entry as a structural error', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const { errors, warnings } = validateCorpus(skills, {
      skills: {
        'known-skill': null,
      },
    });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("Skill 'known-skill' corpus entry must be an object"));
    assert.equal(warnings.length, 0);
  });

  it('warning mode warns when a nearMissTarget references an unknown skill', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const corpus = {
      skills: {
        'known-skill': {
          shouldTrigger: ['trigger'],
          shouldNotTrigger: ['not trigger'],
          nearMiss: ['miss'],
          nearMissTarget: 'stale-skill',
        },
      },
    };
    const { errors, warnings } = validateCorpus(skills, corpus);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("nearMissTarget 'stale-skill' does not exist"));
  });

  it('strict mode errors when a nearMissTarget references an unknown skill', () => {
    const skills = [{ name: 'known-skill', description: 'A known skill.' }];
    const corpus = {
      skills: {
        'known-skill': {
          shouldTrigger: ['trigger'],
          shouldNotTrigger: ['not trigger'],
          nearMiss: ['miss'],
          nearMissTarget: 'stale-skill',
        },
      },
    };
    const { errors, warnings } = validateCorpus(skills, corpus, { strictSkillSet: true });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("nearMissTarget 'stale-skill' does not exist"));
    assert.equal(warnings.length, 0);
  });

  it('does not double-report near-miss failures when the top skill is the near-miss target', () => {
    const skills = [
      { name: 'alpha', description: 'Use when working with alpha.' },
      { name: 'beta', description: 'Use when working with beta.' },
    ];
    const corpus = {
      skills: {
        alpha: {
          shouldTrigger: ['alpha task'],
          shouldNotTrigger: ['beta task'],
          nearMiss: ['beta task'],
          nearMissTarget: 'beta',
        },
      },
    };
    const { passed, failures } = runActivationCorpus(skills, corpus);
    assert.equal(passed, false);
    assert.equal(failures.length, 1, `expected one failure, got: ${failures.join(' | ')}`);
    assert.ok(failures[0].includes("nearMiss for 'alpha' ranked 'beta' first instead of itself"));
    assert.ok(failures[0].includes("near-miss target 'beta'"));
  });
});
