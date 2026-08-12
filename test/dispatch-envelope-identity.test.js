import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION,
  BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION,
  DECOMPOSITION_BINDING_SCHEMA_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  DISPATCH_PREPARATION_SCHEMA_VERSION,
  LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION,
  ROLE_RETURN_SCHEMA_VERSION,
  SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION,
  dispatchPreparationDigest,
  legacyDispatchPreparationDigest,
  validateDispatchPreparation,
} from '../src/dispatch-envelope.js';
import {
  createDispatchFixture,
  prepare,
  readyReturn,
  repositoryEvidence,
} from './helpers/dispatch-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
let temp;

const currentFilesTask = name => createDispatchFixture(temp, name);

// Every contract test below clones and classifies the packet in memory; the
// committed repository itself is read-only, so they all share one fixture.
let sharedTask;
const sharedFilesTask = () => (sharedTask ??= createDispatchFixture(temp, 'shared'));

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-dispatch-identity-')); });
after(() => rmSync(temp, { recursive: true, force: true }));
/**
 * Strip the current envelope down to the v2-v5 field set. Prior packets carried
 * exactly one activation model and no assurance statement, so a genuine legacy
 * carrier has neither field.
 */
function assuranceUnboundEnvelope(packet) {
  const legacy = structuredClone(packet);
  delete legacy.activationBinding;
  delete legacy.returnAdapter;
  delete legacy.assurance;
  return legacy;
}

describe('documented envelope identity contract', () => {
  it('AGENTIC_LOOP.md names the exact schema versions and digests the implementation emits', async () => {
    const doc = readFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), 'utf8');
    assert.match(doc, /agenticloop\.role-preparation`, schema version\s*\n?`7`/);
    assert.match(doc, /sha256:agenticloop\.role-preparation\.v7:<64-lowercase-hex>/);
    assert.match(doc, /agenticloop\.role-return`, schema version\s*\n?`3`/);
    assert.match(doc, /sha256:agenticloop\.role-return\.v3:<64-lowercase-hex>/);
    assert.match(doc, /agenticloop\.decomposition-provenance`, schema\s*\n?version `2`/);
    assert.match(doc, /agenticloop\.decomposition-binding`,\s*\n?schema version `1`/);
    assert.doesNotMatch(doc, /agenticloop\.role-preparation\.v1/);
    assert.doesNotMatch(doc, /agenticloop\.role-return\.v1/);
    assert.equal(DISPATCH_PREPARATION_SCHEMA_VERSION, 7);
    assert.equal(ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION, 5);
    assert.equal(SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION, 4);
    assert.equal(BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION, 2);
    assert.equal(LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION, 3);
    assert.equal(DECOMPOSITION_SCHEMA_VERSION, 2);
    assert.equal(DECOMPOSITION_BINDING_SCHEMA_VERSION, 1);
    assert.equal(ROLE_RETURN_SCHEMA_VERSION, 3);
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.ok(prepared.packet.digest.startsWith('sha256:agenticloop.role-preparation.v7:'));
    const roleReturn = readyReturn(prepared.packet, repositoryEvidence(prepared.packet));
    assert.ok(roleReturn.digest.startsWith('sha256:agenticloop.role-return.v3:'));
  });

  it('classifies the shipped schemaVersion 2 baseline as typed stale without accepting it', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const baseline = assuranceUnboundEnvelope(prepared.packet);
    baseline.schemaVersion = BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION;
    delete baseline.assignment.host;
    delete baseline.assignment.hostRoleCapability;
    delete baseline.assignment.degradedEnforcementReports;
    baseline.digest = legacyDispatchPreparationDigest(
      baseline,
      BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION
    );

    const checked = validateDispatchPreparation(baseline, fixture.options);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.findings, [{
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation schemaVersion 2 is stale; regenerate the packet as schemaVersion 7 before dispatch or return import',
    }]);
  });

  it('classifies an assurance-unbound schemaVersion 5 carrier as typed stale', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const legacy = assuranceUnboundEnvelope(prepared.packet);
    legacy.schemaVersion = ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION;
    legacy.digest = legacyDispatchPreparationDigest(
      legacy,
      ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION
    );

    const checked = validateDispatchPreparation(legacy, fixture.options);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.findings, [{
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation schemaVersion 5 is stale; regenerate the packet as schemaVersion 7 before dispatch or return import',
    }]);
  });

  it('classifies a canonical schemaVersion 3 carrier as typed stale', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const legacy = assuranceUnboundEnvelope(prepared.packet);
    legacy.schemaVersion = LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION;
    delete legacy.assignment.degradedEnforcementReports;
    legacy.digest = legacyDispatchPreparationDigest(
      legacy,
      LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION
    );

    const checked = validateDispatchPreparation(legacy, fixture.options);
    assert.equal(checked.ok, false);
    assert.equal(checked.findings.length, 1);
    assert.deepEqual(checked.findings[0], {
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation schemaVersion 3 is stale; regenerate the packet as schemaVersion 7 before dispatch or return import',
    });
  });

  it('classifies a schemaVersion 4 scan-unbound carrier as typed stale rather than migrating it', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const legacy = assuranceUnboundEnvelope(prepared.packet);
    legacy.schemaVersion = SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION;
    // A version 4 packet carried the version 1 decomposition source inline.
    legacy.decomposition = structuredClone(fixture.legacyDecomposition);
    legacy.digest = legacyDispatchPreparationDigest(
      legacy,
      SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION
    );

    const checked = validateDispatchPreparation(legacy, fixture.options);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.findings, [{
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation schemaVersion 4 is stale; regenerate the packet as schemaVersion 7 before dispatch or return import',
    }]);
  });

  it('classifies an authentic current packet with canonical v3 degraded reports as typed stale', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const legacy = structuredClone(prepared.packet);
    const declaration = legacy.assignment.hostRoleCapability;
    legacy.assignment.degradedEnforcementReports = legacy.assignment.degradedEnforcementReports.map(report => ({
      ...report,
      schemaVersion: 3,
      limitation: declaration.limitation,
      detectionBoundary: declaration.detectionBoundary,
      recoveryRoute: declaration.recoveryRoute,
    }));
    legacy.digest = dispatchPreparationDigest(legacy);

    const checked = validateDispatchPreparation(legacy, fixture.options);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.findings, [{
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation degraded-enforcement report schemaVersion 3 is stale; regenerate the packet before dispatch or return import',
    }]);
  });

  it('does not classify a malformed nested-v3 report lookalike as trusted stale', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const malformed = structuredClone(prepared.packet);
    const declaration = malformed.assignment.hostRoleCapability;
    malformed.assignment.degradedEnforcementReports = malformed.assignment.degradedEnforcementReports.map(report => ({
      ...report,
      schemaVersion: 3,
      limitation: declaration.limitation,
      detectionBoundary: declaration.detectionBoundary,
      recoveryRoute: declaration.recoveryRoute,
    }));
    malformed.assignment.degradedEnforcementReports[0].unexpected = true;
    malformed.digest = dispatchPreparationDigest(malformed);

    const checked = validateDispatchPreparation(malformed, fixture.options);
    assert.equal(checked.ok, false);
    assert.equal(checked.findings.some(item => item.code === 'dispatch.packet.stale'), false);
    assert.ok(checked.findings.some(item => item.code === 'capability.declaration.invalid'));
  });

  it('does not promote malformed or current packets into a legacy version class', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(validateDispatchPreparation(prepared.packet, fixture.options).ok, true);
    const malformed = assuranceUnboundEnvelope(prepared.packet);
    malformed.schemaVersion = BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION;
    delete malformed.assignment.host;
    delete malformed.assignment.hostRoleCapability;
    delete malformed.assignment.degradedEnforcementReports;
    malformed.packetId = 'not-a-dispatch-id';
    const checked = validateDispatchPreparation(malformed, fixture.options);
    assert.equal(checked.ok, false);
    assert.equal(checked.findings.some(item => item.code === 'dispatch.packet.stale'), false);
    assert.match(checked.errors.join('\n'), /packetId|schemaVersion|digest/);
  });
});
