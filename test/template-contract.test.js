import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { validateCanonicalTemplates, REQUIRED_TEMPLATE_RELATIVE_PATHS } from '../src/template-contract.js';
import { seedToolkitSource } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('template contract validation', () => {
  it('rejects copied trace-summary bullet lists in backend docs', () => {
    const target = mkdtempSync(join(tmpdir(), 'al-template-contract-'));
    try {
      seedToolkitSource(REPO_ROOT, target);
      const backendDoc = join(target, 'agenticloop', 'backends', 'files.md');
      mkdirSync(dirname(backendDoc), { recursive: true });
      writeFileSync(
        backendDoc,
        [
          '# Files Task Backend',
          '',
          'Use agenticloop/memory/work-unit-summary.md.',
          '',
          '- **Task Record**: copied shape',
          '',
        ].join('\n'),
        'utf-8'
      );

      const result = validateCanonicalTemplates(target);

      assert.ok(
        result.errors.some(error => error.includes('embeds trace-summary bullet labels')),
        `expected copied trace-summary list error, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('validates optional proof-pressure section in task record template', () => {
    const target = mkdtempSync(join(tmpdir(), 'al-template-proof-pressure-'));
    try {
      seedToolkitSource(REPO_ROOT, target);
      const result = validateCanonicalTemplates(target);
      const proofPressureWarnings = result.warnings.filter(e =>
        e.includes('Proof Pressure')
      );
      assert.equal(
        proofPressureWarnings.length,
        0,
        `task-record.md should include optional '## Proof Pressure' section, got warnings: ${JSON.stringify(proofPressureWarnings)}`
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('recognizes proof pressure as an optional task-record section in layout constants', async () => {
    const layout = await import('../src/layout.js');
    assert.ok(
      layout.TASK_OPTIONAL_SECTION_HEADINGS.includes('## Proof Pressure'),
      'TASK_OPTIONAL_SECTION_HEADINGS must include ## Proof Pressure'
    );
  });

  it('requires memory/decision-record.md as a canonical template', () => {
    assert.ok(
      REQUIRED_TEMPLATE_RELATIVE_PATHS.some(p => p.includes('decision-record.md')),
      'REQUIRED_TEMPLATE_RELATIVE_PATHS must include decision-record.md'
    );
  });

  it('does not require a decision index as a canonical template', () => {
    assert.ok(
      !REQUIRED_TEMPLATE_RELATIVE_PATHS.some(p => p.includes('decisions/index')),
      'REQUIRED_TEMPLATE_RELATIVE_PATHS must not include a decision index'
    );
  });

  it('requires memory/work-unit-summary.md as a canonical template', () => {
    assert.ok(
      REQUIRED_TEMPLATE_RELATIVE_PATHS.some(p => p.includes('work-unit-summary.md')),
      'REQUIRED_TEMPLATE_RELATIVE_PATHS must include work-unit-summary.md'
    );
  });

  it('does not require implementation-summary.md, closeout-summary.md, or trace-summary.md as separate canonical templates', () => {
    const separateTemplates = REQUIRED_TEMPLATE_RELATIVE_PATHS.filter(p =>
      /implementation-summary\.md|closeout-summary\.md|trace-summary\.md/.test(p)
    );
    assert.equal(
      separateTemplates.length,
      0,
      `REQUIRED_TEMPLATE_RELATIVE_PATHS must not include removed template files: ${separateTemplates.join(', ')}`
    );
  });

  it('validates ordered headings in the task record template', () => {
    const target = mkdtempSync(join(tmpdir(), 'al-template-task-record-'));
    try {
      seedToolkitSource(REPO_ROOT, target);
      const result = validateCanonicalTemplates(target);
      const headingErrors = result.errors.filter(e =>
        e.includes('task-record.md') && e.includes('missing required heading')
      );
      assert.equal(
        headingErrors.length,
        0,
        `task-record.md should pass heading validation, got errors: ${JSON.stringify(headingErrors)}`
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('validates ordered headings in the unified work-unit summary template', () => {
    const target = mkdtempSync(join(tmpdir(), 'al-template-wus-'));
    try {
      seedToolkitSource(REPO_ROOT, target);
      const result = validateCanonicalTemplates(target);
      const headingErrors = result.errors.filter(e =>
        e.includes('work-unit-summary') && e.includes('missing required heading')
      );
      assert.equal(
        headingErrors.length,
        0,
        `work-unit-summary.md should pass heading validation, got errors: ${JSON.stringify(headingErrors)}`
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('validates required work-unit summary frontmatter fields and values', () => {
    const target = mkdtempSync(join(tmpdir(), 'al-template-wus-frontmatter-'));
    try {
      seedToolkitSource(REPO_ROOT, target);
      const templatePath = join(target, 'agenticloop', 'memory', 'work-unit-summary.md');
      const templateText = readFileSync(templatePath, 'utf-8')
        .replace('summary_unit: task', 'summary_unit: invalid-altitude')
        .replace('scope_ref: T-001', 'scope_ref: ""')
        .replace('status: complete', 'status: bogus');
      writeFileSync(templatePath, templateText, 'utf-8');

      const result = validateCanonicalTemplates(target);

      assert.ok(
        result.errors.some(e => e.includes("'summary_unit'") && e.includes('must be one of: task')),
        `expected summary_unit validation error, got: ${JSON.stringify(result.errors)}`
      );
      assert.ok(
        result.errors.some(e => e.includes("'scope_ref'")),
        `expected scope_ref validation error, got: ${JSON.stringify(result.errors)}`
      );
      assert.ok(
        result.errors.some(e => e.includes("'status'") && e.includes('follow_up_required')),
        `expected status validation error, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('validates trace bullet labels in optional ## Trace section', () => {
    const target = mkdtempSync(join(tmpdir(), 'al-template-trace-'));
    try {
      seedToolkitSource(REPO_ROOT, target);
      const result = validateCanonicalTemplates(target);
      const traceErrors = result.errors.filter(e =>
        e.includes('## Trace') && e.includes('missing required bullet label')
      );
      assert.equal(
        traceErrors.length,
        0,
        `work-unit-summary.md ## Trace section should contain all bullet labels, got errors: ${JSON.stringify(traceErrors)}`
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('decision-index stale-reference check', () => {
  const STALE_PATTERNS = [
    /\.agenticloop\/decisions\/index\.md/,
    /read the decision index/i,
    /update the decision index/i,
    /decisions\/index\.md/,
    /decision files or in the index/i,
  ];

  const ACTIVE_SURFACE_DIRS = [
    'AGENTIC_LOOP.md',
    'README.md',
    'docs',
    'agents',
    'skills',
    'backends',
    'memory',
    'src',
  ];

  function collectActiveFiles(base, relDir = '') {
    const results = [];
    const dir = relDir ? join(base, relDir) : base;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return results;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...collectActiveFiles(base, relPath));
      } else if (entry.endsWith('.md') || entry.endsWith('.js') || entry.endsWith('.json')) {
        results.push({ relPath, fullPath });
      }
    }
    return results;
  }

  it('rejects stale decision-index references in active surfaces', () => {
    const violations = [];
    for (const surface of ACTIVE_SURFACE_DIRS) {
      const fullPath = join(REPO_ROOT, surface);
      let files;
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          files = [{ relPath: surface, fullPath }];
        } else {
          files = collectActiveFiles(REPO_ROOT, surface);
        }
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.relPath === 'IMPLEMENTATION_PLAN.md') continue;
        const content = readFileSync(file.fullPath, 'utf-8');
        for (const pattern of STALE_PATTERNS) {
          if (pattern.test(content)) {
            violations.push(`${file.relPath} matches ${pattern}`);
          }
        }
      }
    }
    assert.equal(
      violations.length,
      0,
      `stale decision-index references found in active surfaces:\n${violations.join('\n')}`
    );
  });
});

describe('phase-s stale-reference check', () => {
  const STALE_PATTERNS = [
    /state\.yaml/,
    /\.agenticloop\/runs\b/,
    /receipts\.jsonl/,
    /\bnode_id\b/,
    /trace memory/i,
    /output-ref[:/]/i,
    /\.agenticloop\/output-refs\b/,
    /sqlite/i,
    /lancedb/i,
    /vector.index/i,
    /sidecar/i,
    /postinstall/i,
  ];

  const EXCLUDED_FILES = new Set([
    // IMPLEMENTATION_PLAN.md lives under .dev/ and .dev is not in ACTIVE_SURFACE_DIRS,
    // so it does not need to be listed here.
    'test/template-contract.test.js',
  ]);

  const ACTIVE_SURFACE_DIRS = [
    'AGENTIC_LOOP.md',
    'README.md',
    'docs',
    'agents',
    'skills',
    'backends',
    'memory',
    'src',
    'config.json',
    'manifest.json',
    'agenticloop.template.json',
  ];

  function collectActiveFiles(base, relDir = '') {
    const results = [];
    const dir = relDir ? join(base, relDir) : base;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return results;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...collectActiveFiles(base, relPath));
      } else if (
        entry.endsWith('.md') ||
        entry.endsWith('.js') ||
        entry.endsWith('.json') ||
        entry.endsWith('.toml')
      ) {
        results.push({ relPath, fullPath });
      }
    }
    return results;
  }

  it('rejects phase-s deferred infrastructure references in active surfaces', () => {
    const violations = [];
    for (const surface of ACTIVE_SURFACE_DIRS) {
      const fullPath = join(REPO_ROOT, surface);
      let files;
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          files = [{ relPath: surface, fullPath }];
        } else {
          files = collectActiveFiles(REPO_ROOT, surface);
        }
      } catch {
        continue;
      }
      for (const file of files) {
        if (EXCLUDED_FILES.has(file.relPath)) continue;
        const content = readFileSync(file.fullPath, 'utf-8');
        for (const pattern of STALE_PATTERNS) {
          if (pattern.test(content)) {
            violations.push(`${file.relPath} matches ${pattern}`);
          }
        }
      }
    }
    assert.equal(
      violations.length,
      0,
      `phase-s deferred infrastructure references found in active surfaces:\n${violations.join('\n')}`
    );
  });
});

describe('removed-template stale-reference check', () => {
  const STALE_PATTERNS = [
    /agenticloop\/memory\/implementation-summary\.md/,
    /agenticloop\/memory\/closeout-summary\.md/,
    /agenticloop\/memory\/trace-summary\.md/,
  ];

  const EXCLUDED_FILES = new Set([
    'IMPLEMENTATION_PLAN.md',
  ]);

  const ACTIVE_SURFACE_DIRS = [
    'AGENTIC_LOOP.md',
    'README.md',
    'docs',
    'agents',
    'skills',
    'backends',
    'memory',
  ];

  function collectActiveFiles(base, relDir = '') {
    const results = [];
    const dir = relDir ? join(base, relDir) : base;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return results;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...collectActiveFiles(base, relPath));
      } else if (entry.endsWith('.md') || entry.endsWith('.json')) {
        results.push({ relPath, fullPath });
      }
    }
    return results;
  }

  it('rejects active canonical instructions pointing to removed template files', () => {
    const violations = [];
    for (const surface of ACTIVE_SURFACE_DIRS) {
      const fullPath = join(REPO_ROOT, surface);
      let files;
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          files = [{ relPath: surface, fullPath }];
        } else {
          files = collectActiveFiles(REPO_ROOT, surface);
        }
      } catch {
        continue;
      }
      for (const file of files) {
        if (EXCLUDED_FILES.has(file.relPath)) continue;
        const content = readFileSync(file.fullPath, 'utf-8');
        for (const pattern of STALE_PATTERNS) {
          if (pattern.test(content)) {
            violations.push(`${file.relPath} matches ${pattern}`);
          }
        }
      }
    }
    assert.equal(
      violations.length,
      0,
      `stale removed-template references found in active surfaces:\n${violations.join('\n')}`
    );
  });
});
