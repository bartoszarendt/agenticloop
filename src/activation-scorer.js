/**
 * Deterministic surrogate skill activation scorer.
 *
 * Ranks skills for a free-form prompt using only skill frontmatter (name and
 * description) via token overlap. No LLM or external host routing is invoked.
 *
 * Scoring is intentionally simple and conservative:
 *   - token overlap between prompt and skill description,
 *   - exact-phrase bonus,
 *   - skill-name-in-prompt bonus.
 *
 * This is a description-drift regression tool, not a substitute for live host
 * routing validation.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for',
  'from', 'has', 'have', 'in', 'is', 'it', 'its', 'must', 'not', 'of', 'on',
  'or', 'so', 'that', 'the', 'this', 'to', 'use', 'when', 'with',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\- ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t));
}

function uniqueTokens(text) {
  return new Set(tokenize(text));
}

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    out.push(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

function buildIdf(skillDescriptions) {
  const df = {};
  for (const desc of skillDescriptions) {
    for (const token of uniqueTokens(desc)) {
      df[token] = (df[token] ?? 0) + 1;
    }
  }
  const n = skillDescriptions.length;
  const idf = {};
  for (const [token, count] of Object.entries(df)) {
    idf[token] = Math.log(n / count) + 1;
  }
  return idf;
}

function scoreSkill(promptTokens, promptPhrases, name, description, idf) {
  const descText = description.toLowerCase();
  const descTokenList = tokenize(description);
  const descTf = {};
  for (const token of descTokenList) {
    descTf[token] = (descTf[token] ?? 0) + 1;
  }

  let score = 0;

  for (const token of promptTokens) {
    if (descTf[token]) {
      score += descTf[token] * (idf[token] ?? 1);
    }
  }

  for (const phrase of promptPhrases) {
    if (descText.includes(phrase)) score += 3;
  }

  const nameTokens = tokenize(name.replace(/-/g, ' '));
  for (const token of nameTokens) {
    if (promptTokens.has(token)) score += 5;
  }

  return score;
}

/**
 * Load skill descriptions from skillsDir.
 *
 * @param {string} skillsDir
 * @returns {{ skills: { name: string, description: string }[], errors: string[] }}
 */
export function loadSkillDescriptions(skillsDir) {
  const skills = [];
  const errors = [];

  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    return { skills, errors: [`Skills directory not found: ${skillsDir}`] };
  }

  for (const entry of readdirSync(skillsDir).sort()) {
    const skillDir = join(skillsDir, entry);
    if (!statSync(skillDir).isDirectory()) continue;
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) {
      errors.push(`Missing SKILL.md for skill '${entry}'`);
      continue;
    }

    const content = readFileSync(skillMd, 'utf-8');
    const [fm] = parseFrontmatter(content);
    if (!fm || !fm.name || !fm.description) {
      errors.push(`Missing name/description frontmatter for skill '${entry}'`);
      continue;
    }

    skills.push({ name: fm.name, description: fm.description });
  }

  return { skills, errors };
}

/**
 * Rank skills for a prompt.
 *
 * @param {{ name: string, description: string }[]} skills
 * @param {string} prompt
 * @returns {{ name: string, score: number }[]}
 */
export function rankSkills(skills, prompt) {
  const promptTokens = uniqueTokens(prompt);
  const promptWords = [...promptTokens];
  const promptPhrases = [
    ...ngrams(promptWords, 2),
    ...ngrams(promptWords, 3),
  ];
  const idf = buildIdf(skills.map(s => s.description));

  return skills
    .map(({ name, description }) => ({
      name,
      score: scoreSkill(promptTokens, promptPhrases, name, description, idf),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * Validate an activation corpus against the loaded skill descriptions.
 *
 * By default skill-set mismatches are warnings so downstream repos can add or
 * remove custom skills without failing validation solely because the corpus is
 * out of sync. Use `{ strictSkillSet: true }` to treat missing or unknown skill
 * entries as errors.
 *
 * @param {{ name: string, description: string }[]} skills
 * @param {object} corpus
 * @param {object} [options]
 * @param {boolean} [options.strictSkillSet]  Treat missing/unknown skill entries as errors (default: false)
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateCorpus(skills, corpus, options = {}) {
  const errors = [];
  const warnings = [];
  const skillNames = new Set(skills.map(s => s.name));
  const strictSkillSet = Boolean(options.strictSkillSet);

  if (!isObjectRecord(corpus) || !isObjectRecord(corpus.skills)) {
    errors.push('Corpus missing top-level "skills" object');
    return { errors, warnings };
  }

  for (const name of skillNames) {
    if (!Object.prototype.hasOwnProperty.call(corpus.skills, name)) {
      const message = `Corpus missing skill '${name}'`;
      if (strictSkillSet) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  for (const [name, entry] of Object.entries(corpus.skills)) {
    if (!skillNames.has(name)) {
      const message = `Corpus references unknown skill '${name}'`;
      if (strictSkillSet) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
      continue;
    }

    if (!isObjectRecord(entry)) {
      errors.push(`Skill '${name}' corpus entry must be an object`);
      continue;
    }

    for (const category of ['shouldTrigger', 'shouldNotTrigger', 'nearMiss']) {
      const prompts = entry[category];
      if (!Array.isArray(prompts) || prompts.length === 0) {
        errors.push(`Skill '${name}' missing or empty '${category}' prompts`);
      }
    }

    if (entry.nearMissTarget && !skillNames.has(entry.nearMissTarget)) {
      const message = `Skill '${name}' nearMissTarget '${entry.nearMissTarget}' does not exist`;
      if (strictSkillSet) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  return { errors, warnings };
}

/**
 * Run the activation corpus as a regression suite.
 *
 * Only evaluates entries for skills present in the loaded skills list; entries
 * for unknown skills are skipped so downstream repos are not blocked by stale
 * corpus data.
 *
 * @param {{ name: string, description: string }[]} skills
 * @param {object} corpus
 * @param {object} [options]
 * @param {number} [options.triggerRankThreshold]  Rank must be <= this for shouldTrigger (default: 2)
 * @returns {{ passed: boolean, failures: string[] }}
 */
export function runActivationCorpus(skills, corpus, options = {}) {
  const failures = [];
  const threshold = options.triggerRankThreshold ?? 2;
  const skillNames = new Set(skills.map(s => s.name));

  if (!isObjectRecord(corpus) || !isObjectRecord(corpus.skills)) {
    return { passed: false, failures: ['Corpus missing top-level "skills" object'] };
  }

  for (const [name, entry] of Object.entries(corpus.skills)) {
    if (!skillNames.has(name)) {
      continue;
    }

    if (!isObjectRecord(entry)) {
      failures.push(`Skill '${name}' corpus entry must be an object`);
      continue;
    }

    for (const prompt of entry.shouldTrigger ?? []) {
      const ranked = rankSkills(skills, prompt);
      const rank = ranked.findIndex(r => r.name === name);
      if (rank === -1 || rank >= threshold) {
        failures.push(
          `shouldTrigger for '${name}' ranked ${rank === -1 ? 'unranked' : rank + 1} for prompt: ${prompt.slice(0, 80)}`
        );
      }
    }

    for (const prompt of entry.shouldNotTrigger ?? []) {
      const ranked = rankSkills(skills, prompt);
      const top = ranked[0];
      if (top && top.name === name && top.score > 0) {
        failures.push(
          `shouldNotTrigger for '${name}' incorrectly ranked it first (score ${top.score}) for prompt: ${prompt.slice(0, 80)}`
        );
      }
    }

    for (const prompt of entry.nearMiss ?? []) {
      const ranked = rankSkills(skills, prompt);
      const top = ranked[0];
      const nearMissTarget = entry.nearMissTarget;
      if (!top || top.name !== name) {
        const nearMissDetail = top && top.name === nearMissTarget
          ? ` (near-miss target '${nearMissTarget}')`
          : '';
        failures.push(
          `nearMiss for '${name}' ranked '${top?.name ?? 'none'}' first instead of itself${nearMissDetail} for prompt: ${prompt.slice(0, 80)}`
        );
      }
    }
  }

  return { passed: failures.length === 0, failures };
}
