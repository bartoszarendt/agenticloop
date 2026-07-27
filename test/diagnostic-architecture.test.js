/**
 * Universal diagnostic-architecture enforcement: scans every runtime source
 * file with the TypeScript compiler API and rejects role routing in evaluator
 * diagnostics, protected constructor fields, role-prose concatenation, and
 * non-canonical diagnostic construction. Also validates role capability
 * bindings: coverage, duplicate primaries, unknown capabilities, and the
 * human-authority boundary.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { APPROVED_PRESENTATION_MODULES, CONSTRUCTOR_MODULES, checkDiagnosticArchitecture } from './helpers/diagnostic-architecture-check.js';
import {
  HUMAN_AUTHORITY_BOUNDARY,
  getProjectRoleCapabilities,
  loadRoleCapabilities,
  validateProjectRoleCapabilities,
} from '../src/role-capabilities.js';
import { ESCALATION_KINDS, REPAIR_KINDS } from '../src/repair-policy.js';
import { presentDiagnostic } from '../src/diagnostic-presentation.js';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

describe('diagnostic architecture anti-bypass enforcement', () => {
  it('finds no routing bypasses in any runtime source file', () => {
    const violations = [];
    for (const entry of readdirSync(join(REPO_ROOT, 'src'))) {
      if (!entry.endsWith('.js')) continue;
      const relative = `src/${entry}`;
      const source = readFileSync(join(REPO_ROOT, 'src', entry), 'utf8');
      for (const violation of checkDiagnosticArchitecture(source, {
        fileName: relative,
        presentation: APPROVED_PRESENTATION_MODULES.has(relative),
        constructorModule: CONSTRUCTOR_MODULES.has(relative),
      })) {
        violations.push(`${relative}:${violation.line} [${violation.rule}] ${violation.detail}`);
      }
    }
    assert.deepEqual(violations, [], violations.join('\n'));
  });

  it('rejects a hand-built role-directed diagnostic literal', () => {
    const violations = checkDiagnosticArchitecture(
      `const diagnostic = { message: 'scope broken', category: 'scope_deviations', owner: 'engineer', nextAction: 'Engineer must repair the scope' };`,
    );
    assert.ok(violations.some(item => item.rule === 'routing-fields-in-diagnostic'));
  });

  it('rejects protected routing fields supplied to the canonical constructor', () => {
    const violations = checkDiagnosticArchitecture(
      `createDiagnostic({ code: 'scope.deviation.missing', message: 'x', owner: 'engineer' });`,
    );
    assert.ok(violations.some(item => item.rule === 'protected-field-to-constructor'));
  });

  it('rejects role-name prose concatenated into diagnostic messages', () => {
    const violations = checkDiagnosticArchitecture(
      `const warning = 'task-readiness warning requires Maintainer correction before agent-ready: ' + detail;\nconst diagnostic = { code: 'scope.deviation.missing', level: 'error', message: warning };`,
    );
    assert.ok(violations.some(item => item.rule === 'role-prose-in-diagnostic-message'));
  });

  it('rejects diagnostic facts constructed without the canonical constructor', () => {
    const violations = checkDiagnosticArchitecture(
      `const fact = { level: 'error', code: 'scope.deviation.missing', message: 'hand built fact' };`,
    );
    assert.ok(violations.some(item => item.rule === 'non-canonical-diagnostic-construction'));
  });

  it('allows factual diagnostics and legitimate ownership vocabulary', () => {
    const violations = checkDiagnosticArchitecture(`
      createDiagnostic({ code: 'scope.deviation.missing', message: 'unexpected file has no declaration' });
      const attribution = { contentOwnerRole: 'engineer', repairOperator: 'maintainer' };
      const event = { type: 'status', role: 'maintainer' };
    `);
    assert.deepEqual(violations, []);
  });

  it('overwrites injected routing for a known diagnostic code', () => {
    const capabilities = getProjectRoleCapabilities(REPO_ROOT);
    const presented = presentDiagnostic({
      code: 'scope.deviation.missing',
      message: 'scope broken',
      owner: 'orchestrator',
      nextAction: 'bypass capability routing',
    }, capabilities);
    assert.equal(presented.owner, capabilities.primaryOwnerByRepairKind.declare_exact_deviation);
    assert.notEqual(presented.nextAction, 'bypass capability routing');
  });
});

describe('role capability bindings', () => {
  function fixture(bindings) {
    const dir = mkdtempSync(join(tmpdir(), 'al-capabilities-'));
    for (const [role, frontmatter] of Object.entries(bindings)) {
      writeFileSync(join(dir, `${role}.md`), `---\nname: ${role}\n${frontmatter}---\n\n# ${role}\n`, 'utf8');
    }
    return dir;
  }

  const COMPLETE = {
    maintainer: `primary_repair_capabilities:\n${REPAIR_KINDS.filter(kind => !['resolve_dependency'].includes(kind)).map(kind => `  - ${kind}\n`).join('')}`,
    orchestrator: 'primary_repair_capabilities:\n  - resolve_dependency\nescalation_capabilities:\n  - dependency_escalation\n',
    engineer: '',
    auditor: '',
  };

  it('resolves the canonical repository bindings with full coverage', () => {
    const capabilities = getProjectRoleCapabilities(REPO_ROOT);
    for (const kind of REPAIR_KINDS) assert.ok(capabilities.primaryOwnerByRepairKind[kind], `${kind} has a primary owner`);
    assert.equal(capabilities.escalationOwnerByKind.none, null);
    for (const kind of ESCALATION_KINDS.filter(item => item.startsWith('human_authority'))) {
      assert.equal(capabilities.escalationOwnerByKind[kind], HUMAN_AUTHORITY_BOUNDARY);
    }
  });

  it('fails when a repair kind has no primary owner', () => {
    const dir = fixture({
      ...COMPLETE,
      engineer: '',
      orchestrator: '', // resolve_dependency loses its only claimant
    });
    try {
      const result = loadRoleCapabilities(dir);
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /repair kind 'resolve_dependency' has no primary owner/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when multiple roles claim the same primary capability', () => {
    const dir = fixture({
      ...COMPLETE,
      engineer: 'primary_repair_capabilities:\n  - resolve_dependency\n',
    });
    try {
      const result = loadRoleCapabilities(dir);
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /repair kind 'resolve_dependency' has multiple primary owners/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a role declares an unknown capability', () => {
    const dir = fixture({
      ...COMPLETE,
      engineer: 'primary_repair_capabilities:\n  - invent_features\n',
    });
    try {
      const result = loadRoleCapabilities(dir);
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /unknown primary repair capability 'invent_features'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a catalog escalation kind cannot be resolved', () => {
    const dir = fixture({
      ...COMPLETE,
      orchestrator: 'primary_repair_capabilities:\n  - resolve_dependency\n', // drops dependency_escalation
    });
    try {
      const result = loadRoleCapabilities(dir);
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /escalation kind 'dependency_escalation' cannot be resolved/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('models human authority as a boundary no role may claim', () => {
    const dir = fixture({
      ...COMPLETE,
      engineer: 'escalation_capabilities:\n  - human_authority_review\n',
    });
    try {
      const result = loadRoleCapabilities(dir);
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /unknown escalation capability 'human_authority_review'/);
      assert.equal(result.escalationOwnerByKind.human_authority_review, HUMAN_AUTHORITY_BOUNDARY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('memoizes bindings per directory instead of re-reading role Markdown', () => {
    const first = getProjectRoleCapabilities(REPO_ROOT);
    const second = getProjectRoleCapabilities(REPO_ROOT);
    assert.equal(first, second);
  });

  it('uses bundled bindings with a migration warning for fully legacy installed roles', () => {
    const target = mkdtempSync(join(tmpdir(), 'al-legacy-capabilities-'));
    const agentsDir = join(target, 'agenticloop', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    for (const role of ['maintainer', 'orchestrator', 'engineer', 'auditor']) {
      writeFileSync(join(agentsDir, `${role}.md`), `---\nname: ${role}\n---\n\n# ${role}\n`, 'utf8');
    }
    try {
      const capabilities = getProjectRoleCapabilities(target);
      assert.match(capabilities.warnings.join('\n'), /predate capability bindings/);
      for (const kind of REPAIR_KINDS) assert.ok(capabilities.primaryOwnerByRepairKind[kind]);
      const validation = validateProjectRoleCapabilities(target);
      assert.deepEqual(validation.errors, []);
      assert.match(validation.warnings.join('\n'), /predate capability bindings/);
      assert.equal(validation.usingBundledFallback, true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('fails validation for partial installed capability declarations', () => {
    const target = mkdtempSync(join(tmpdir(), 'al-partial-capabilities-'));
    const agentsDir = join(target, 'agenticloop', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    for (const role of ['maintainer', 'orchestrator', 'engineer', 'auditor']) {
      const declaration = role === 'maintainer'
        ? 'primary_repair_capabilities:\n  - repair_task_contract\n'
        : '';
      writeFileSync(join(agentsDir, `${role}.md`), `---\nname: ${role}\n${declaration}---\n\n# ${role}\n`, 'utf8');
    }
    try {
      const validation = validateProjectRoleCapabilities(target);
      assert.ok(validation.errors.length > 0);
      assert.equal(validation.warnings.length, 0);
      assert.throws(() => getProjectRoleCapabilities(target), /invalid role capability bindings/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
