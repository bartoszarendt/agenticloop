import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildHostRoleCapabilityInventory,
  buildEffectiveHostRoleCapabilityInventory,
  createHostRoleCapabilitySidecar,
  createDegradedEnforcementReports,
  degradedEnforcementDeclarationFacts,
  getHostRoleCapability,
  hostRoleCapabilityDigest,
  renderHostRoleCapabilityNotice,
  SHIPPED_ADAPTER_HOSTS,
  validateDegradedEnforcementReport,
  validateHostRoleCapabilityDeclaration,
  validateHostRoleCapabilityInventory,
  validateHostRoleCapabilitySidecar,
} from '../src/host-role-capabilities.js';
import {
  enumerateWorkflowRoles,
  getWorkflowRoleLabel,
  validateWorkflowRoleParity,
  WORKFLOW_ROLE_IDS,
} from '../src/workflow-roles.js';
import { WORKFLOW_ROLE_REGISTRY } from '../src/transition-contract.js';

function binding(host, roleId, action) {
  return getHostRoleCapability(host, roleId).actionBindings.find(item => item.action === action);
}

describe('canonical workflow-role registry', () => {
  it('owns ordered enumeration, display labels, and exact config/agent/model parity', () => {
    assert.deepEqual(enumerateWorkflowRoles().map(role => role.roleId), [...WORKFLOW_ROLE_IDS]);
    assert.equal(getWorkflowRoleLabel('orchestrator'), 'Orchestrator');
    assert.equal(validateWorkflowRoleParity({
      configRoles: Object.fromEntries(WORKFLOW_ROLE_IDS.map(roleId => [roleId, {}])),
      agents: [...WORKFLOW_ROLE_IDS],
      modelBindings: Object.fromEntries(WORKFLOW_ROLE_IDS.map(roleId => [roleId, 'inherit'])),
    }).ok, true);
    const incomplete = validateWorkflowRoleParity({
      configRoles: { engineer: {} },
      agents: [...WORKFLOW_ROLE_IDS, 'invented'],
      modelBindings: [...WORKFLOW_ROLE_IDS],
    });
    assert.equal(incomplete.ok, false);
    assert.match(incomplete.errors.join('\n'), /missing registry roles|non-registry roles/);
  });

  it('treats a label rename as presentation-only in generated capability text and authority digest', () => {
    const renamed = WORKFLOW_ROLE_REGISTRY.map(role => (
      role.roleId === 'engineer' ? { ...role, defaultLabel: 'Builder' } : { ...role }
    ));
    const rolePolicies = Object.fromEntries(WORKFLOW_ROLE_IDS.map(roleId => [
      roleId,
      getHostRoleCapability('opencode', roleId).allowedActions,
    ]));
    const inventory = buildHostRoleCapabilityInventory({ registry: renamed, rolePolicies });
    const canonical = getHostRoleCapability('opencode', 'engineer');
    const changed = inventory.opencode.engineer;
    assert.equal(changed.defaultLabel, 'Builder');
    assert.equal(changed.digest, canonical.digest);
    assert.equal(hostRoleCapabilityDigest(changed), hostRoleCapabilityDigest(canonical));
    assert.match(renderHostRoleCapabilityNotice('opencode', 'engineer', inventory, renamed), /Role: Builder \(engineer\)/);
  });

  it('requires an added role to have capability bindings on every shipped host', () => {
    const registry = [
      ...WORKFLOW_ROLE_REGISTRY.map(role => ({ ...role })),
      { roleId: 'security-observer', defaultLabel: 'Security Observer', escalationPrecedence: 5 },
    ];
    assert.throws(
      () => buildHostRoleCapabilityInventory({ registry }),
      /missing a capability policy binding/
    );
    const rolePolicies = Object.fromEntries(WORKFLOW_ROLE_IDS.map(roleId => [
      roleId,
      getHostRoleCapability('opencode', roleId).allowedActions,
    ]));
    rolePolicies['security-observer'] = [];
    const inventory = buildHostRoleCapabilityInventory({ registry, rolePolicies });
    assert.equal(validateHostRoleCapabilityInventory(inventory, { registry }).ok, true);
    for (const host of SHIPPED_ADAPTER_HOSTS) {
      assert.equal(inventory[host]['security-observer'].roleId, 'security-observer');
      assert.equal(
        inventory[host]['security-observer'].actionBindings.find(item => item.action === 'role_result_produce').enforcement,
        'unavailable'
      );
    }
  });
});

describe('host-role capability declarations', () => {
  it('projects the narrow mutation and workflow responsibilities of every shipped host', () => {
    for (const host of SHIPPED_ADAPTER_HOSTS) {
      assert.deepEqual(binding(host, 'engineer', 'implementation_mutate'), {
        ...binding(host, 'engineer', 'implementation_mutate'),
        policy: 'allowed',
        enforcement: 'advisory',
      });
      assert.equal(binding(host, 'maintainer', 'task_workflow_mutate').policy, 'allowed');
      assert.equal(binding(host, 'orchestrator', 'implementation_mutate').policy, 'denied');
      assert.equal(binding(host, 'auditor', 'implementation_mutate').policy, 'denied');
      assert.equal(binding(host, 'orchestrator', 'role_dispatch').policy, 'allowed');
      assert.equal(binding(host, 'orchestrator', 'role_result_import').enforcement, 'advisory');
    }
    for (const host of ['claude-code', 'cursor']) {
      assert.equal(binding(host, 'orchestrator', 'implementation_mutate').enforcement, 'enforced');
      assert.equal(binding(host, 'auditor', 'implementation_mutate').enforcement, 'enforced');
    }
    for (const host of ['opencode', 'codex', 'copilot']) {
      assert.equal(binding(host, 'orchestrator', 'implementation_mutate').enforcement, 'advisory');
      assert.equal(binding(host, 'auditor', 'implementation_mutate').enforcement, 'advisory');
    }
    for (const host of SHIPPED_ADAPTER_HOSTS) {
      assert.equal(binding(host, 'maintainer', 'implementation_mutate').enforcement, 'advisory');
    }
  });

  it('derives Claude Code enforcement from the effective permissionMode override', () => {
    const defaults = buildEffectiveHostRoleCapabilityInventory('claude-code', {});
    assert.equal(
      defaults.orchestrator.actionBindings.find(item => item.action === 'implementation_mutate').enforcement,
      'enforced'
    );
    const overridden = buildEffectiveHostRoleCapabilityInventory('claude-code', {
      roleSettings: { orchestrator: { permissionMode: 'acceptEdits' } },
    });
    assert.equal(
      overridden.orchestrator.actionBindings.find(item => item.action === 'implementation_mutate').enforcement,
      'advisory'
    );
    assert.notEqual(overridden.orchestrator.digest, defaults.orchestrator.digest);
  });

  it('renders a compact digest reference and rejects modified sidecar bytes', () => {
    const sidecar = createHostRoleCapabilitySidecar('copilot');
    const notice = renderHostRoleCapabilityNotice('copilot', 'engineer');
    assert.match(notice, /Schema: 1; digest:/);
    assert.match(notice, /\.agenticloop\/host-role-capabilities\/copilot\.json/);
    assert.doesNotMatch(notice, /base64|Canonical JSON/i);
    assert.equal(validateHostRoleCapabilitySidecar(sidecar, { host: 'copilot' }).ok, true);
    const tampered = structuredClone(sidecar);
    tampered.declarations.engineer.limitation += ' tampered';
    assert.equal(validateHostRoleCapabilitySidecar(tampered, { host: 'copilot' }).ok, false);
  });

  it('emits closed degraded reports that resolve the boundary and recovery route from their pinned declaration', () => {
    for (const host of SHIPPED_ADAPTER_HOSTS) {
      const declaration = getHostRoleCapability(host, 'orchestrator');
      const reports = createDegradedEnforcementReports(declaration);
      assert.ok(reports.length > 0);
      for (const report of reports) {
        assert.equal(validateDegradedEnforcementReport(report).ok, true);
        assert.equal(report.diagnosticCode, 'capability.enforcement.degraded');
        assert.notEqual(report.enforcement, 'enforced');
        assert.equal(report.declarationDigest, declaration.digest);

        // The declaration's prose is reached through the pinned digest, not
        // copied into every report.
        for (const field of ['limitation', 'detectionBoundary', 'recoveryRoute']) {
          assert.equal(Object.hasOwn(report, field), false, `report must not restate '${field}'`);
        }
        const facts = degradedEnforcementDeclarationFacts(report, declaration);
        assert.equal(facts.detectionBoundary, 'role_return_receive');
        assert.ok(facts.recoveryRoute.includes('typed blocked or rejected result'));
        assert.equal(facts.limitation, declaration.limitation);

        // Resolution also works from the shipped inventory alone.
        const resolvedFromInventory = degradedEnforcementDeclarationFacts(report);
        assert.deepEqual(resolvedFromInventory, facts);
      }
    }
  });

  it('refuses to resolve declaration facts for a report whose pinned digest does not match', () => {
    const declaration = getHostRoleCapability('codex', 'orchestrator');
    const [report] = createDegradedEnforcementReports(declaration);
    const repinned = { ...report, declarationDigest: `sha256:agenticloop.host-role-capability.v1:${'0'.repeat(64)}` };
    assert.equal(validateDegradedEnforcementReport(repinned).ok, false);
    assert.deepEqual(
      degradedEnforcementDeclarationFacts(repinned, declaration),
      { limitation: null, detectionBoundary: null, recoveryRoute: null }
    );
  });

  it('rejects unknown, duplicate, contradictory, incomplete, and extra declaration fields', () => {
    const base = getHostRoleCapability('codex', 'orchestrator');
    const candidates = [];
    const extra = structuredClone(base);
    extra.extra = true;
    candidates.push(extra);
    const duplicate = structuredClone(base);
    duplicate.actionBindings[1] = structuredClone(duplicate.actionBindings[0]);
    duplicate.digest = hostRoleCapabilityDigest(duplicate);
    candidates.push(duplicate);
    const contradictory = structuredClone(base);
    contradictory.allowedActions.push('implementation_mutate');
    contradictory.digest = hostRoleCapabilityDigest(contradictory);
    candidates.push(contradictory);
    const incomplete = structuredClone(base);
    incomplete.actionBindings.pop();
    incomplete.digest = hostRoleCapabilityDigest(incomplete);
    candidates.push(incomplete);
    const unknown = structuredClone(base);
    unknown.actionBindings[0].action = 'invented';
    unknown.digest = hostRoleCapabilityDigest(unknown);
    candidates.push(unknown);
    for (const candidate of candidates) {
      assert.equal(validateHostRoleCapabilityDeclaration(candidate).ok, false);
    }
  });
});
