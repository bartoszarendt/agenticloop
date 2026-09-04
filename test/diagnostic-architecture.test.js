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

import {
  APPROVED_PRESENTATION_MODULES,
  CONSTRUCTOR_MODULES,
  PUBLIC_COMMAND_MODULES,
  collectDiagnosticCodeLiterals,
  collectDiagnosticEmissionSites,
  checkDiagnosticArchitecture,
} from './helpers/diagnostic-architecture-check.js';
import {
  HUMAN_AUTHORITY_BOUNDARY,
  getProjectRoleCapabilities,
  loadRoleCapabilities,
  validateProjectRoleCapabilities,
} from '../src/role-capabilities.js';
import { ESCALATION_KINDS, REPAIR_KINDS, REPAIR_POLICY, createDiagnostic } from '../src/repair-policy.js';
import { presentDiagnostic } from '../src/diagnostic-presentation.js';
import { commandFailure } from '../src/public-result.js';
import { PublicCommandError } from '../src/public-error.js';
import {
  DYNAMIC_DIAGNOSTIC_PRODUCERS,
  HARD_REFUSAL_ALLOWLIST,
  HISTORICAL_PRODUCER_EXCEPTIONS,
  REFUSAL_CLASSES,
  assertRefusalClassCatalog,
} from '../src/refusal-classes.js';

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
        publicCommandModule: PUBLIC_COMMAND_MODULES.has(relative),
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

  it('rejects raw built-in errors in a public command path', () => {
    const violations = checkDiagnosticArchitecture(
      `function command() { throw new Error('private implementation detail'); }`,
      { publicCommandModule: true },
    );
    assert.ok(violations.some(item => item.rule === 'untyped-public-command-error'));
  });

  it('allows classified public command errors', () => {
    const violations = checkDiagnosticArchitecture(
      `function command() { throw new VerificationContextError('missing task body'); }`,
      { publicCommandModule: true },
    );
    assert.deepEqual(violations, []);
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

describe('refusal classification ratchet', () => {
  const HARD_CLASSES = new Set(['retained_hard_refusal', 'material_human_decision']);
  const ACCEPTED_FAMILIES = new Set(['F1', 'F2', 'F3', 'F4']);

  function scannedDiagnosticEmissions(sources = null) {
    const emittedByCode = new Map();
    const dynamicByModule = new Map();
    const entries = sources ?? readdirSync(join(REPO_ROOT, 'src'))
      .filter(entry => entry.endsWith('.js') && !['repair-policy.js', 'refusal-classes.js'].includes(entry))
      .map(entry => [`src/${entry}`, readFileSync(join(REPO_ROOT, 'src', entry), 'utf8')]);
    for (const [relative, source] of entries) {
      const sites = collectDiagnosticEmissionSites(source, relative);
      for (const found of sites.codes) {
        if (!ACCEPTED_FAMILIES.has(REFUSAL_CLASSES[found.code]?.family)) continue;
        const producers = emittedByCode.get(found.code) ?? new Set();
        producers.add(relative);
        emittedByCode.set(found.code, producers);
      }
      for (const site of sites.dynamic) {
        const acceptedCodes = site.possibleCodes.filter(code => ACCEPTED_FAMILIES.has(REFUSAL_CLASSES[code]?.family));
        // A caller-supplied code can be a runtime refusal even when this scan
        // cannot enumerate its values. It must stay observable as `external`;
        // otherwise an undeclared emitter can evade the ratchet entirely.
        if (acceptedCodes.length === 0 && site.possibleCodes.length > 0) continue;
        const dynamic = dynamicByModule.get(relative) ?? [];
        dynamic.push({ ...site, acceptedCodes });
        dynamicByModule.set(relative, dynamic);
        for (const code of acceptedCodes) {
          const producers = emittedByCode.get(code) ?? new Set();
          producers.add(relative);
          emittedByCode.set(code, producers);
        }
      }
    }
    return { emittedByCode, dynamicByModule };
  }

  function assertHistoricalCodesHaveNoLiveEmitters(emittedByCode) {
    for (const [code] of Object.entries(HISTORICAL_PRODUCER_EXCEPTIONS)) {
      assert.equal(emittedByCode.get(code)?.size ?? 0, 0, `${code} removal row has a live runtime emitter`);
    }
  }

  it('classifies every registered code exactly once and exhausts accepted hard boundaries', () => {
    assert.equal(assertRefusalClassCatalog(), true);
    assert.deepEqual(Object.keys(REFUSAL_CLASSES).sort(), Object.keys(REPAIR_POLICY).sort());
    for (const [code, entry] of Object.entries(REFUSAL_CLASSES)) {
      if (!['F1', 'F2', 'F3', 'F4'].includes(entry.family)) continue;
      assert.notEqual(entry.refusalClass, 'pending_classification', `${code} must be classified`);
      assert.ok(entry.factOwner, `${code} requires a fact owner`);
      assert.ok(entry.rationale, `${code} requires an assurance rationale`);
      assert.ok(entry.repairClass, `${code} requires a repair class`);
      assert.ok(Array.isArray(entry.producers) || entry.producers === null, `${code} requires producers or a historical marker`);
      assert.ok(entry.semanticInvalidators, `${code} requires semantic invalidators`);
      assert.ok(entry.proof, `${code} requires disposition proof`);
    }
    for (const entry of Object.values(REFUSAL_CLASSES).filter(item => item.refusalClass === 'pending_classification')) {
      assert.ok(entry.pendingSurfaces.length > 0, `${entry.code} requires a known pending evaluation surface`);
      assert.equal(entry.proof, `pending_wu_b2:${entry.family}`, `${entry.code} must name its completing slice`);
    }
    assert.deepEqual(
      HARD_REFUSAL_ALLOWLIST.map(entry => entry.code).sort(),
      Object.values(REFUSAL_CLASSES)
        .filter(entry => HARD_CLASSES.has(entry.refusalClass))
        .map(entry => entry.code)
        .sort(),
    );
  });

  it('rejects non-registered, duplicate, and registry-removed allowlist entries', () => {
    assert.throws(
      () => assertRefusalClassCatalog({
        allowlist: [...HARD_REFUSAL_ALLOWLIST, {
          code: 'unregistered.refusal', factOwner: 'test', rationale: 'test', repairClass: 'test',
        }],
      }),
      /hard-refusal allowlist has no registered diagnostic: unregistered\.refusal/,
    );
    assert.throws(
      () => assertRefusalClassCatalog({ allowlist: [...HARD_REFUSAL_ALLOWLIST, HARD_REFUSAL_ALLOWLIST[0]] }),
      /hard-refusal allowlist has duplicate diagnostic/,
    );
    const withoutNegativeProof = { ...HARD_REFUSAL_ALLOWLIST[0] };
    delete withoutNegativeProof.negativeProof;
    assert.throws(
      () => assertRefusalClassCatalog({ allowlist: [withoutNegativeProof, ...HARD_REFUSAL_ALLOWLIST.slice(1)] }),
      /hard-refusal allowlist lacks metadata/,
    );
    const duplicateProof = { ...HARD_REFUSAL_ALLOWLIST[1], negativeProof: HARD_REFUSAL_ALLOWLIST[0].negativeProof };
    assert.throws(
      () => assertRefusalClassCatalog({ allowlist: [HARD_REFUSAL_ALLOWLIST[0], duplicateProof, ...HARD_REFUSAL_ALLOWLIST.slice(2)] }),
      /hard-refusal allowlist has duplicate negative proof/,
    );
    const missingScenario = { ...HARD_REFUSAL_ALLOWLIST[0], negativeProof: 'Material fact: a test fixture does not name an adversarial scenario.' };
    assert.throws(
      () => assertRefusalClassCatalog({ allowlist: [missingScenario, ...HARD_REFUSAL_ALLOWLIST.slice(1)] }),
      /negative proof lacks an adversarial scenario/,
    );
    const removedPolicy = { ...REPAIR_POLICY };
    delete removedPolicy[HARD_REFUSAL_ALLOWLIST[0].code];
    assert.throws(
      () => assertRefusalClassCatalog({ policy: removedPolicy }),
      /registered diagnostic codes and refusal classifications differ/,
    );
  });

  it('rejects a bare scenario marker in a hard-refusal negative proof', () => {
    const emptyScenario = { ...HARD_REFUSAL_ALLOWLIST[0], negativeProof: 'Material fact: a test fixture names no adversarial scenario. scenario:   ' };
    assert.throws(
      () => assertRefusalClassCatalog({ allowlist: [emptyScenario, ...HARD_REFUSAL_ALLOWLIST.slice(1)] }),
      /negative proof lacks an adversarial scenario/,
    );
  });

  it('requires code-specific adversarial negative proof for every hard boundary', () => {
    const proofs = HARD_REFUSAL_ALLOWLIST.map(entry => entry.negativeProof);
    assert.equal(new Set(proofs).size, proofs.length, 'negative proof text must not be boilerplate');
    for (const entry of HARD_REFUSAL_ALLOWLIST) {
      assert.match(entry.negativeProof, /Material fact:/);
      assert.match(entry.negativeProof, /scenario:/i);
    }
  });

  it('keeps non-allowlisted diagnostics out of a hard-refusal presentation mapping', () => {
    const nonAllowlisted = Object.values(REFUSAL_CLASSES)
      .filter(entry => !HARD_REFUSAL_ALLOWLIST.some(item => item.code === entry.code));
    assert.ok(nonAllowlisted.length > 0);
    for (const entry of nonAllowlisted) assert.ok(!HARD_CLASSES.has(entry.refusalClass), entry.code);

    // Presentation presently routes repair ownership only; it has no separate
    // hard-refusal flag or escalation map.  This assertion is the mechanically
    // checkable boundary until later work gives presentation a disposition field.
    const capabilities = getProjectRoleCapabilities(REPO_ROOT);
    const presented = presentDiagnostic(createDiagnostic({ code: nonAllowlisted[0].code }), capabilities);
    assert.equal(Object.hasOwn(presented, 'hardRefusal'), false);
    assert.equal(Object.hasOwn(presented, 'refusalClass'), false);
  });

  it('binds accepted producers bidirectionally and records every dynamic selection explicitly', () => {
    const { emittedByCode, dynamicByModule } = scannedDiagnosticEmissions();
    for (const [code, classification] of Object.entries(REFUSAL_CLASSES)) {
      if (!ACCEPTED_FAMILIES.has(classification.family)) continue;
      if (classification.producers === null) {
        assert.ok(HISTORICAL_PRODUCER_EXCEPTIONS[code], `${code} must declare its historical absence`);
        assert.match(classification.proof, /historical_no_live_producer/);
        continue;
      }
      for (const emittedBy of emittedByCode.get(code) ?? []) {
        assert.ok(classification.producers.includes(emittedBy), `${code} emitter ${emittedBy} is missing from catalog producers`);
      }
      for (const producer of classification.producers) {
        const source = readFileSync(join(REPO_ROOT, producer), 'utf8');
        assert.ok(source.includes(code), `${code} named producer no longer references its diagnostic`);
      }
    }
    assertHistoricalCodesHaveNoLiveEmitters(emittedByCode);
    assert.deepEqual([...dynamicByModule.keys()].sort(), Object.keys(DYNAMIC_DIAGNOSTIC_PRODUCERS).sort());
    for (const [surface, declaration] of Object.entries(DYNAMIC_DIAGNOSTIC_PRODUCERS)) {
      const emittedSites = dynamicByModule.get(surface);
      const emitted = new Set(emittedSites.flatMap(site => site.acceptedCodes));
      const external = emittedSites.some(site => site.hasUnresolved);
      const codes = declaration.codes === 'external' ? declaration.knownCodes ?? [] : declaration.codes;
      assert.equal(external, declaration.codes === 'external', `${surface} external dynamic producer declaration is incomplete`);
      for (const code of codes.filter(code => ACCEPTED_FAMILIES.has(REFUSAL_CLASSES[code]?.family))) {
        assert.ok(emitted.has(code), `${surface} dynamic producer does not enumerate ${code}`);
        assert.ok(REFUSAL_CLASSES[code].producers.includes(surface), `${code} omits dynamic producer ${surface}`);
      }
      assert.deepEqual(
        [...emitted].sort(),
        codes.filter(code => ACCEPTED_FAMILIES.has(REFUSAL_CLASSES[code]?.family)).sort(),
        `${surface} dynamic producer inventory is incomplete`,
      );
    }
  });

  it('detects default-parameter emissions and rejects their unregistered literals', () => {
    const source = `const DEFAULT_CODE = 'activation.binding.mismatch';\nfunction emit(message, code = DEFAULT_CODE) {}\nemit('default');`;
    assert.deepEqual(collectDiagnosticCodeLiterals(source).map(item => item.code), ['activation.binding.mismatch']);
    const unknown = collectDiagnosticCodeLiterals(`function emit(message, code = 'unregistered.default_parameter') {}\nemit('default');`)
      .filter(found => !Object.hasOwn(REPAIR_POLICY, found.code));
    assert.deepEqual(unknown.map(found => found.code), ['unregistered.default_parameter']);
  });

  it('rejects an undeclared dynamic diagnostic producer', () => {
    const { dynamicByModule } = scannedDiagnosticEmissions([
      ['src/undeclared-dynamic.js', `function emit(message, code) {}\nconst lookup = { active: 'activation.capture.missing' };\nemit('x', lookup[state]);`],
    ]);
    assert.throws(
      () => assert.deepEqual([...dynamicByModule.keys()].sort(), Object.keys(DYNAMIC_DIAGNOSTIC_PRODUCERS).sort()),
      /src\/undeclared-dynamic\.js/,
    );
  });

  it('rejects an undeclared dynamic producer whose code cannot be statically resolved', () => {
    const { dynamicByModule } = scannedDiagnosticEmissions([
      ['src/undeclared-external-dynamic.js', `function emit(message, code) { return createDiagnostic({ message, code }); }\nconst externalCode = input.code;\nemit('x', externalCode);`],
    ]);
    assert.throws(
      () => assert.deepEqual([...dynamicByModule.keys()].sort(), Object.keys(DYNAMIC_DIAGNOSTIC_PRODUCERS).sort()),
      /src\/undeclared-external-dynamic\.js/,
    );
  });

  it('rejects an undeclared mixed known and external dynamic producer', () => {
    const { dynamicByModule } = scannedDiagnosticEmissions([
      ['src/undeclared-mixed-dynamic.js', `function emit(message, code) { return createDiagnostic({ message, code }); }\nconst externalCode = input.code;\nemit('x', state ? 'activation.capture.missing' : externalCode);`],
    ]);
    const [site] = dynamicByModule.get('src/undeclared-mixed-dynamic.js');
    assert.deepEqual(site.acceptedCodes, ['activation.capture.missing']);
    assert.equal(site.hasUnresolved, true);
    assert.throws(
      () => assert.deepEqual([...dynamicByModule.keys()].sort(), Object.keys(DYNAMIC_DIAGNOSTIC_PRODUCERS).sort()),
      /src\/undeclared-mixed-dynamic\.js/,
    );
  });

  it('observes every direct conditional constructor branch so an unregistered branch fails', () => {
    const source = `createDiagnostic({ code: condition ? 'activation.capture.missing' : 'unregistered.direct', message: 'x' });`;
    const sites = collectDiagnosticEmissionSites(source, 'src/undeclared-direct-conditional.js');
    assert.deepEqual(sites.codes.map(site => site.code).sort(), ['activation.capture.missing', 'unregistered.direct']);
    assert.throws(
      () => assert.deepEqual(
        sites.codes.filter(site => !Object.hasOwn(REPAIR_POLICY, site.code)).map(site => site.code),
        [],
      ),
      /unregistered\.direct/,
    );
  });

  it('requires a declaration for a direct constructor code property read', () => {
    const { dynamicByModule } = scannedDiagnosticEmissions([
      ['src/undeclared-direct-property.js', `createDiagnostic({ code: input.code, message: 'x' });`],
    ]);
    const [site] = dynamicByModule.get('src/undeclared-direct-property.js');
    assert.equal(site.hasUnresolved, true);
    assert.throws(
      () => assert.deepEqual([...dynamicByModule.keys()].sort(), Object.keys(DYNAMIC_DIAGNOSTIC_PRODUCERS).sort()),
      /src\/undeclared-direct-property\.js/,
    );
  });

  it('observes an unregistered literal embedded in a typed error class', () => {
    const sites = collectDiagnosticEmissionSites(
      `class DirectRefusal extends Error { code = 'unregistered.typed_direct'; }`,
      'src/undeclared-typed-error.js',
    );
    assert.throws(
      () => assert.deepEqual(
        sites.codes.filter(site => !Object.hasOwn(REPAIR_POLICY, site.code)).map(site => site.code),
        [],
      ),
      /unregistered\.typed_direct/,
    );
  });

  it('treats an explicit null code argument as a non-emission', () => {
    const sites = collectDiagnosticEmissionSites(
      `function emit(message, code) { return createDiagnostic({ message, code }); }\nemit('no diagnostic', null);`,
    );
    assert.deepEqual(sites, { codes: [], dynamic: [] });
  });

  it('rejects a live emitter for a removal disposition', () => {
    const { emittedByCode } = scannedDiagnosticEmissions([
      ['src/future-removal-regression.js', `function emit(message, code) {}\nemit('x', 'scope.existing_path.missing');`],
    ]);
    assert.throws(() => assertHistoricalCodesHaveNoLiveEmitters(emittedByCode), /scope\.existing_path\.missing.*live runtime emitter/);
  });

  it('records consumers separately from producers for split F4 facts', () => {
    for (const entry of Object.values(REFUSAL_CLASSES).filter(item => item.family === 'F4' && item.consumers)) {
      for (const consumer of entry.consumers) assert.ok(readFileSync(join(REPO_ROOT, consumer), 'utf8'));
    }
  });

  it('finds no unregistered runtime refusal in accepted slices with an AST structural scan', () => {
    // These exact pending-family sites are F6 review/audit/remediation/closeout
    // (`audit.already_exists`, `review.entry.fixup_invalid`,
    // `review.entry.matrix_stale`, and `review.entry.persistence`) and F7
    // compatibility/update/generated-workspace
    // (`compatibility.waiver_scope_retired`). Keeping the inventory exact means
    // a new unregistered literal fails this test instead of being hidden by a
    // family-wide exemption.
    const deferredToPendingFamily = new Set([
      'audit.already_exists', 'review.entry.fixup_invalid', 'review.entry.matrix_stale', 'review.entry.persistence',
      'compatibility.waiver_scope_retired',
    ]);
    const unknown = [];
    for (const entry of readdirSync(join(REPO_ROOT, 'src'))) {
      if (!entry.endsWith('.js') || ['repair-policy.js', 'refusal-classes.js'].includes(entry)) continue;
      for (const found of collectDiagnosticCodeLiterals(readFileSync(join(REPO_ROOT, 'src', entry), 'utf8'), `src/${entry}`)) {
        if (!Object.hasOwn(REPAIR_POLICY, found.code) && !deferredToPendingFamily.has(found.code)) {
          unknown.push(`src/${entry}:${found.line}: ${found.code}`);
        }
      }
    }
    assert.deepEqual(unknown, [], unknown.join('\n'));
  });

  it('detects positional and typed-error unregistered refusal emitters', () => {
    assert.deepEqual(
      collectDiagnosticCodeLiterals(`function fail(message, code) {}\nfail('x', 'unregistered.refusal');`)
        .map(item => item.code),
      ['unregistered.refusal'],
    );
    assert.deepEqual(
      collectDiagnosticCodeLiterals(`class Refusal extends Error { constructor() { super(); this.code = 'unregistered.refusal'; } }`)
        .map(item => item.code),
      ['unregistered.refusal'],
    );
  });

  it('presents and normalizes every code registered by this classification slice', () => {
    const registeredHere = [
      'activation.policy.invalid', 'task.evidence.product_head',
      'execution_evidence.malformed_input', 'execution_evidence.stale_version',
      'execution_evidence.binding_mismatch', 'execution_evidence.lineage_mismatch',
      'return.lane.implementation_absent', 'attempt_return_unbound', 'attempt_return_ambiguous',
      'attempt_return_conflict', 'attempt_terminal_conflict', 'task.role_start.check_evidence_missing',
      'task.role_start.check_evidence_mismatch', 'tooling_failure_input_invalid',
      'tooling_failure_evidence_conflict', 'tooling_failure_write_failed', 'tooling_failure_admission_conflict',
      'handoff.evidence.freshness_expired', 'handoff.evidence.schema_retired',
      'handoff.evidence.revalidation_failed', 'handoff.evidence.ambiguous_return',
    ];
    const capabilities = getProjectRoleCapabilities(REPO_ROOT);
    for (const code of registeredHere) {
      const classification = REFUSAL_CLASSES[code];
      assert.ok(classification.rationale && classification.repairClass, `${code} has C1 metadata`);
      const fact = createDiagnostic({ code });
      const presented = presentDiagnostic(fact, capabilities);
      assert.ok(presented.owner, `${code} presents an owner`);
      const normalized = commandFailure('diagnostic test', new PublicCommandError('registered diagnostic', { code }), 'operational_error', {}, REPO_ROOT);
      assert.equal(normalized.diagnostics[0].code, code, `${code} must not normalize as an unregistered fallback`);
    }
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

  it('resolves overlapping escalation claims by registry precedence, not caller order', () => {
    const dir = fixture({
      ...COMPLETE,
      maintainer: `${COMPLETE.maintainer}escalation_capabilities:\n  - dependency_escalation\n`,
    });
    try {
      const canonical = loadRoleCapabilities(dir);
      const shuffled = loadRoleCapabilities(dir, {
        roles: ['auditor', 'engineer', 'maintainer', 'orchestrator'],
      });
      assert.equal(canonical.escalationOwnerByKind.dependency_escalation, 'orchestrator');
      assert.equal(shuffled.escalationOwnerByKind.dependency_escalation, 'orchestrator');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires agent frontmatter identity to match the registry role ID', () => {
    const dir = fixture(COMPLETE);
    try {
      const path = join(dir, 'maintainer.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace('name: maintainer', 'name: release-steward'), 'utf8');
      const result = loadRoleCapabilities(dir);
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /frontmatter name must equal roleId 'maintainer'/);
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
