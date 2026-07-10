/**
 * Skill validator for canonical Agentic Loop skills.
 *
 * Errors (exit 1 when used via CLI):
 *   - skill directory without SKILL.md
 *   - SKILL.md without frontmatter
 *   - missing/empty name, description, metadata.area, or trust metadata
 *   - invalid trust metadata enum values
 *   - frontmatter name that does not match directory name
 *   - [[skill-name]] link pointing at a non-existent skill
 *
 * Warnings (do not fail):
 *   - orphan skill (no inbound [[link]] from another skill)
 *   - body under 50 or over 4000 words
 *   - description without an explicit trigger phrase
 *
 * [[agent: ...]] attribution markers are not skill links and are ignored.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';

import { join, relative, basename } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const REQUIRED_FIELDS = ['name', 'description'];
const TRIGGER_PHRASES = ['use when', 'use whenever', 'use before', 'use the moment'];
const MIN_WORDS = 50;
const MAX_WORDS = 4000;
const WORD_RE = /[\p{L}\p{N}]+(?:['\u2019\u002d\u2013\u2014][\p{L}\p{N}]+)*/gu;

const TRUST_FIELDS = ['side_effects', 'credentials', 'runs_scripts'];
const TRUST_ENUMS = {
  side_effects: ['none', 'read-only', 'writes-tmp', 'writes-files', 'writes-backend', 'writes-github'],
  credentials: ['none', 'optional', 'backend-dependent', 'github-cli'],
  runs_scripts: ['none', 'optional', 'required'],
};

function countWords(text) {
  return text.match(WORD_RE)?.length ?? 0;
}

function skillLinks(body) {
  const targets = [];
  const re = new RegExp(WIKILINK_RE.source, 'g');
  let match;
  while ((match = re.exec(body)) !== null) {
    const inner = match[1].trim();
    if (!inner.toLowerCase().startsWith('agent:')) {
      targets.push(inner);
    }
  }
  return targets;
}

function validateSkill(skillDir) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const name = basename(skillDir);
  const skillMd = join(skillDir, 'SKILL.md');

  if (!existsSync(skillMd)) {
    errors.push('Missing SKILL.md');
    return { errors, warnings, notes, links: [] };
  }

  const content = readFileSync(skillMd, 'utf-8');
  const [fm, body] = parseFrontmatter(content);

  if (fm === null) {
    errors.push("Missing YAML frontmatter (file must start with '---')");
    return { errors, warnings, notes, links: skillLinks(content) };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fm[field]) {
      errors.push(`Missing or empty required frontmatter field: ${field}`);
    }
  }

  const metadata = fm.metadata;
  if (!metadata || typeof metadata !== 'object' || !metadata.area) {
    errors.push('Missing or empty required frontmatter field: metadata.area');
  }

  if (metadata && typeof metadata === 'object') {
    for (const field of TRUST_FIELDS) {
      const value = metadata[field];
      if (value === undefined || value === null || value === '') {
        errors.push(`Missing or empty required trust metadata field: metadata.${field}`);
      } else if (!TRUST_ENUMS[field].includes(value)) {
        errors.push(`Invalid value for metadata.${field}: '${value}' (expected one of: ${TRUST_ENUMS[field].join(', ')})`);
      }
    }

    if (metadata.side_effects === 'writes-github' && metadata.credentials !== 'github-cli') {
      errors.push(`GitHub-writing skill must declare credentials: github-cli`);
    }
  }

  const hasScriptsDir = existsSync(join(skillDir, 'scripts')) && statSync(join(skillDir, 'scripts')).isDirectory();
  if (hasScriptsDir && metadata?.runs_scripts === 'none') {
    errors.push(`Skill has a scripts/ directory but claims runs_scripts: none`);
  }

  const fmName = fm.name;
  if (fmName && fmName !== name) {
    errors.push(`Name mismatch: frontmatter name '${fmName}' but directory is '${name}'`);
  }

  const description = fm.description ?? '';
  if (description) {
    const descLower = description.toLowerCase();
    if (!TRIGGER_PHRASES.some(p => descLower.includes(p))) {
      warnings.push(
        "Description has no explicit trigger phrase (e.g. 'Use when', 'Use before', 'Use the moment')"
      );
    }
  }

  const words = countWords(body);
  notes.push(`word count: ${words}`);
  if (words < MIN_WORDS) {
    warnings.push(`Body is very short (${words} words); may need more content`);
  } else if (words > MAX_WORDS) {
    warnings.push(`Body is long (${words} words); consider progressive disclosure`);
  }

  return { errors, warnings, notes, links: skillLinks(body) };
}

/**
 * Validate every skill under skillsDir.
 * Returns a report with { skills: { [name]: { errors, warnings, notes } }, config: { errors, warnings } }.
 */
export function validateSkills(skillsDir) {
  const report = {
    skills: {},
    config: { errors: [], warnings: [] },
  };

  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    report.config.errors.push(`Skills directory not found: ${skillsDir}`);
    return report;
  }

  const skillDirs = readdirSync(skillsDir)
    .map(name => join(skillsDir, name))
    .filter(p => statSync(p).isDirectory())
    .sort();

  const skillNames = new Set(skillDirs.map(p => basename(p)));
  const inbound = {};
  for (const name of skillNames) inbound[name] = new Set();

  for (const skillDir of skillDirs) {
    const name = basename(skillDir);
    const result = validateSkill(skillDir);
    report.skills[name] = result;
    for (const target of result.links) {
      if (!skillNames.has(target)) {
        result.errors.push(`Broken link: [[${target}]] points to a non-existent skill`);
      } else if (target !== name) {
        inbound[target].add(name);
      }
    }
  }

  for (const name of [...skillNames].sort()) {
    if (inbound[name].size === 0) {
      report.skills[name].warnings.push('Orphan skill: no inbound [[link]] from another skill');
    }
  }

  return report;
}

export function errorCount(report) {
  let n = 0;
  for (const r of Object.values(report.skills)) n += r.errors.length;
  n += report.config.errors.length;
  return n;
}

export function warningCount(report) {
  let n = 0;
  for (const r of Object.values(report.skills)) n += r.warnings.length;
  n += report.config.warnings.length;
  return n;
}

export function printReport(report, skillsDir, repoRoot, output = process.stdout, linkErrorCount = 0) {
  const write = (line = '') => output.write(`${line}\n`);
  const label = repoRoot
    ? relative(repoRoot, skillsDir).replace(/\\/g, '/')
    : skillsDir;

  write();
  write('='.repeat(70));
  write(` Skill Validator - ${label}`);
  write('='.repeat(70));

  for (const name of Object.keys(report.skills).sort()) {
    const r = report.skills[name];
    const status = r.errors.length ? 'FAIL' : r.warnings.length ? 'WARN' : 'OK';
    write(`\n[${status}] ${name}`);
    for (const msg of r.errors) write(`    ERROR: ${msg}`);
    for (const msg of r.warnings) write(`    WARN:  ${msg}`);
  }

  if (report.config.errors.length || report.config.warnings.length) {
    write('\n[config]');
    for (const msg of report.config.errors) write(`    ERROR: ${msg}`);
    for (const msg of report.config.warnings) write(`    WARN:  ${msg}`);
  }

  write();
  write('='.repeat(70));
  write(' Summary');
  write('='.repeat(70));
  const ec = errorCount(report);
  const wc = warningCount(report);
  write(`  Skills:   ${Object.keys(report.skills).length}`);
  write(`  Errors:   ${ec}`);
  write(`  Warnings: ${wc}`);
  if (linkErrorCount > 0) {
    write(`  Link errors: ${linkErrorCount}`);
  }
  if (ec === 0 && linkErrorCount === 0) {
    write(`\n  ALL CHECKS PASSED${wc ? ` (${wc} warnings)` : ''}`);
  } else if (ec > 0) {
    write(`\n  ${ec} ERROR(S) - fix before any interactive agent session`);
  } else {
    write(`\n  ${linkErrorCount} LINK ERROR(S) - fix broken Markdown links`);
  }
  write();
}
