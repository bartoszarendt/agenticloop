import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { deepFreeze } from './immutable.js';
import {
  TRANSITION_CAPABILITIES,
  TRANSITION_CAPABILITY_ACTIONS,
  TRANSITION_CAPABILITY_ACTION_POLICIES,
  TRANSITION_CAPABILITY_ENFORCEMENT,
  TRANSITION_DEGRADED_ENFORCEMENT_REPORT,
  TRANSITION_HOST_ROLE_CAPABILITY_SCHEMA,
  WORKFLOW_ROLE_REGISTRY,
} from './transition-contract.js';
import {
  enumerateWorkflowRoles,
  getWorkflowRole,
  WORKFLOW_ROLE_IDS,
} from './workflow-roles.js';

export const SHIPPED_ADAPTER_HOSTS = Object.freeze([
  'opencode',
  'claude-code',
  'codex',
  'copilot',
  'cursor',
]);

const ACTION_CAPABILITY = deepFreeze({
  implementation_mutate: 'implementation_mutation',
  task_workflow_mutate: 'task_workflow_mutation',
  role_dispatch: 'role_dispatch',
  role_result_produce: 'role_result_production',
  role_result_import: 'role_result_import',
  blocked_result_resume: 'blocked_result_resumption',
  blocked_result_redelegate: 'blocked_result_redelegation',
  destructive_recovery: 'human_authorized_recovery',
  scope_changing_recovery: 'human_authorized_recovery',
  host_state_repair: 'human_authorized_recovery',
  closeout_owned_accepted_to_closed: 'task_terminal_closeout',
  generic_accepted_to_closed: 'task_terminal_closeout',
});

const HUMAN_DISPOSITION_ACTIONS = Object.freeze([
  'destructive_recovery',
  'scope_changing_recovery',
  'host_state_repair',
]);

/**
 * Canonical per-role capability policy. Exported so a target that appends an
 * extension workflow role can build its effective inventory from the canonical
 * policy rather than restating it, keeping one source for the shipped roles.
 */
export const ROLE_ALLOWED_ACTIONS = deepFreeze({
  orchestrator: [
    'role_dispatch',
    'role_result_import',
    'blocked_result_redelegate',
  ],
  maintainer: [
    'task_workflow_mutate',
    'role_result_produce',
    'role_result_import',
    'blocked_result_resume',
    'closeout_owned_accepted_to_closed',
    'generic_accepted_to_closed',
  ],
  engineer: [
    'implementation_mutate',
    'role_result_produce',
    'blocked_result_resume',
  ],
  auditor: [
    'role_result_produce',
    'blocked_result_resume',
  ],
});

const HOST_PROFILES = deepFreeze({
  opencode: {
    nativeReadonlyRoles: [],
    readonlyMechanism: null,
    writableMechanism: 'OpenCode edit and bash permissions remain available according to the generated role configuration',
    limitation: 'OpenCode permission.edit denies write/edit/apply_patch, but generated Orchestrator and Auditor agents retain bash; shell commands can still mutate the repository, so implementation denial is advisory until role-return receive checks authenticated actor and evidence.',
  },
  'claude-code': {
    nativeReadonlyRoles: ['orchestrator', 'auditor'],
    readonlyMechanism: 'Claude Code permissionMode: plan',
    writableMechanism: 'Claude Code permissionMode: acceptEdits',
    limitation: 'Claude Code plan mode withholds agent editing, but writable roles are not path-typed and no shipped production receipt signer authenticates the actual producer.',
  },
  codex: {
    nativeReadonlyRoles: [],
    readonlyMechanism: null,
    writableMechanism: 'Codex custom-agent instructions',
    limitation: 'Codex exposes no per-agent write restriction in generated custom-agent TOML; role mutation boundaries are advisory until authenticated evidence reaches the next Agentic Loop authority edge.',
  },
  copilot: {
    nativeReadonlyRoles: [],
    readonlyMechanism: null,
    writableMechanism: 'Copilot custom-agent edit and execute tools',
    limitation: 'Copilot withholds edit from Orchestrator and Auditor but retains execute; shell execution can still mutate the repository, so implementation denial is advisory until role-return receive checks authenticated actor and evidence.',
  },
  cursor: {
    nativeReadonlyRoles: ['orchestrator', 'auditor'],
    readonlyMechanism: 'Cursor agent readonly: true',
    writableMechanism: 'Cursor agent readonly: false',
    limitation: 'Cursor can mark whole agents read-only, but it cannot distinguish Maintainer workflow edits from implementation edits and no shipped production receipt signer authenticates the actual producer.',
  },
});

const EXACT_DECLARATION_FIELDS = new Set(TRANSITION_HOST_ROLE_CAPABILITY_SCHEMA.requiredFields);
const EXACT_ACTION_FIELDS = new Set(TRANSITION_HOST_ROLE_CAPABILITY_SCHEMA.actionBindingFields);
const EXACT_DEGRADED_FIELDS = new Set(TRANSITION_DEGRADED_ENFORCEMENT_REPORT.requiredFields);
const CLAUDE_PERMISSION_MODES = new Set([
  'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan',
]);
const DEFAULT_CLAUDE_PERMISSION_MODE = deepFreeze({
  orchestrator: 'plan',
  maintainer: 'acceptEdits',
  engineer: 'acceptEdits',
  auditor: 'plan',
});

export const HOST_ROLE_CAPABILITY_SIDECAR_KIND =
  'agenticloop.host-role-capability-sidecar';
export const HOST_ROLE_CAPABILITY_SIDECAR_SCHEMA_VERSION = 1;
export const HOST_ROLE_CAPABILITY_SIDECAR_DIRECTORY =
  '.agenticloop/host-role-capabilities';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const wanted = expected instanceof Set ? expected : new Set(expected);
  const actual = Object.keys(value);
  return actual.length === wanted.size && actual.every(key => wanted.has(key));
}

function declarationProjection(value) {
  const projection = structuredClone(value);
  delete projection.defaultLabel;
  delete projection.digest;
  return projection;
}

export function hostRoleCapabilityDigest(value) {
  return `sha256:agenticloop.host-role-capability.v1:${canonicalSha256(declarationProjection(value))}`;
}

function rolePolicy(roleId, rolePolicies) {
  const allowed = rolePolicies[roleId];
  if (!Array.isArray(allowed)) {
    throw new TypeError(`workflow role '${roleId}' is missing a capability policy binding`);
  }
  const unknown = allowed.filter(action => !TRANSITION_CAPABILITY_ACTIONS.includes(action));
  if (unknown.length) {
    throw new TypeError(`workflow role '${roleId}' capability policy contains unknown actions: ${unknown.join(', ')}`);
  }
  return new Set(allowed);
}

function effectiveRoleConfiguration(host, roleId, adapterConfig = {}) {
  if (host === 'claude-code') {
    const permissionMode = adapterConfig?.roleSettings?.[roleId]?.permissionMode ??
      DEFAULT_CLAUDE_PERMISSION_MODE[roleId] ??
      'default';
    if (!CLAUDE_PERMISSION_MODES.has(permissionMode)) {
      throw new TypeError(
        `adapters.claude-code.roleSettings.${roleId}.permissionMode must be one of: ` +
        `${[...CLAUDE_PERMISSION_MODES].join(', ')}`
      );
    }
    return { permissionMode, nativeReadonly: permissionMode === 'plan' };
  }
  if (host === 'cursor') {
    return { readonly: roleId === 'orchestrator' || roleId === 'auditor', nativeReadonly: roleId === 'orchestrator' || roleId === 'auditor' };
  }
  if (host === 'opencode') {
    return {
      editDenied: roleId === 'orchestrator' || roleId === 'auditor',
      shellAllowed: true,
      nativeReadonly: false,
    };
  }
  if (host === 'copilot') {
    return {
      editAllowed: roleId !== 'orchestrator' && roleId !== 'auditor',
      executeAllowed: true,
      nativeReadonly: false,
    };
  }
  return { nativeReadonly: false };
}

function actionBinding(host, roleId, action, policy, profile, effectiveConfiguration) {
  const isMutation = action === 'implementation_mutate' || action === 'task_workflow_mutate';
  const nativeReadonly = effectiveConfiguration.nativeReadonly === true;
  let enforcement = 'advisory';
  let mechanism = 'generated role instructions plus authoritative Agentic Loop validation';

  if (HUMAN_DISPOSITION_ACTIONS.includes(action)) {
    enforcement = 'enforced';
    mechanism = 'typed human-disposition validation at blocked-result recovery';
  } else if (action === 'role_result_produce') {
    enforcement = 'unavailable';
    mechanism = 'no shipped production host receipt signer; raw role output is not authenticated evidence';
  } else if (action === 'role_result_import') {
    enforcement = 'advisory';
    mechanism = 'receipt authentication proves the producer, but the importing role is not authenticated at this boundary';
  } else if (action === 'blocked_result_resume' || action === 'blocked_result_redelegate') {
    enforcement = 'enforced';
    mechanism = 'blocked-result owner and redelegation authority validation';
  } else if (action === 'closeout_owned_accepted_to_closed' || action === 'generic_accepted_to_closed') {
    enforcement = policy === 'allowed' ? 'enforced' : (nativeReadonly ? 'enforced' : 'advisory');
    mechanism = policy === 'allowed'
      ? 'canonical terminal-transition authority gate'
      : nativeReadonly
        ? profile.readonlyMechanism
        : 'canonical terminal-transition gate; arbitrary external edits remain outside host control';
  } else if (isMutation && policy === 'denied') {
    enforcement = nativeReadonly ? 'enforced' : 'advisory';
    mechanism = nativeReadonly
      ? profile.readonlyMechanism
      : 'generated role instructions; incompatible actor/evidence is rejected at role-return receipt';
  } else if (isMutation && policy === 'allowed') {
    enforcement = 'advisory';
    mechanism = `${profile.writableMechanism}; host configuration permits the path but does not authenticate the acting role`;
  } else if (action === 'role_dispatch' && policy === 'allowed') {
    enforcement = 'advisory';
    mechanism = 'generated host delegation configuration and role instructions';
  }

  return {
    action,
    capability: ACTION_CAPABILITY[action],
    policy,
    enforcement,
    mechanism,
  };
}

function buildDeclaration(host, role, rolePolicies, hostProfiles, adapterConfig) {
  const profile = hostProfiles[host];
  if (!profile) throw new TypeError(`host '${host}' is missing a capability profile`);
  const effectiveConfiguration = effectiveRoleConfiguration(host, role.roleId, adapterConfig);
  const allowedPolicy = rolePolicy(role.roleId, rolePolicies);
  const actionBindings = TRANSITION_CAPABILITY_ACTIONS.map(action => {
    const policy = HUMAN_DISPOSITION_ACTIONS.includes(action)
      ? 'requires_human_disposition'
      : allowedPolicy.has(action) ? 'allowed' : 'denied';
    return actionBinding(host, role.roleId, action, policy, profile, effectiveConfiguration);
  });
  const declaration = {
    kind: TRANSITION_HOST_ROLE_CAPABILITY_SCHEMA.constants.kind,
    schemaVersion: TRANSITION_HOST_ROLE_CAPABILITY_SCHEMA.constants.schemaVersion,
    host,
    roleId: role.roleId,
    defaultLabel: role.defaultLabel,
    allowedActions: actionBindings.filter(item => item.policy === 'allowed').map(item => item.action),
    deniedActions: actionBindings.filter(item => item.policy === 'denied').map(item => item.action),
    humanDispositionActions: [...HUMAN_DISPOSITION_ACTIONS],
    actionBindings,
    detectionBoundary: 'role_return_receive',
    limitation: profile.limitation,
    recoveryRoute: `Return the typed blocked or rejected result to ${role.roleId}; correct the producer/capability evidence, or supply a separately validated redelegation or human disposition when that authority is required.`,
    digest: null,
  };
  declaration.digest = hostRoleCapabilityDigest(declaration);
  return declaration;
}

export function buildHostRoleCapabilityInventory({
  registry = WORKFLOW_ROLE_REGISTRY,
  rolePolicies = ROLE_ALLOWED_ACTIONS,
  hostProfiles = HOST_PROFILES,
  hosts = SHIPPED_ADAPTER_HOSTS,
  adapterConfigs = {},
} = {}) {
  const entries = enumerateWorkflowRoles(registry);
  const inventory = {};
  for (const host of hosts) {
    if (!hostProfiles[host]) throw new TypeError(`host '${host}' is missing a capability profile`);
    inventory[host] = {};
    for (const role of entries) {
      inventory[host][role.roleId] = buildDeclaration(
        host,
        role,
        rolePolicies,
        hostProfiles,
        adapterConfigs[host] ?? {}
      );
    }
  }
  const checked = validateHostRoleCapabilityInventory(inventory, { registry, hosts });
  if (!checked.ok) throw new TypeError(`invalid host-role capability inventory: ${checked.errors.join('; ')}`);
  return deepFreeze(inventory);
}

export function validateHostRoleCapabilityDeclaration(value, {
  registry = WORKFLOW_ROLE_REGISTRY,
  expectedHost,
  expectedRoleId,
} = {}) {
  const errors = [];
  if (!exactKeys(value, EXACT_DECLARATION_FIELDS)) {
    return { ok: false, errors: ['host-role capability declaration fields must equal the closed schema'] };
  }
  if (value.kind !== TRANSITION_HOST_ROLE_CAPABILITY_SCHEMA.constants.kind ||
      value.schemaVersion !== TRANSITION_HOST_ROLE_CAPABILITY_SCHEMA.constants.schemaVersion) {
    errors.push('host-role capability declaration identity is invalid');
  }
  if (typeof value.host !== 'string' || !value.host || (expectedHost && value.host !== expectedHost)) {
    errors.push('host-role capability declaration host is invalid');
  }
  let role = null;
  try {
    role = getWorkflowRole(value.roleId, registry);
  } catch {
    errors.push(`host-role capability declaration roleId '${String(value.roleId)}' is not in the workflow-role registry`);
  }
  if (expectedRoleId && value.roleId !== expectedRoleId) errors.push('host-role capability declaration roleId does not match its inventory key');
  if (role && value.defaultLabel !== role.defaultLabel) errors.push('host-role capability declaration defaultLabel does not match the registry');
  const bindings = Array.isArray(value.actionBindings) ? value.actionBindings : [];
  if (bindings.length !== TRANSITION_CAPABILITY_ACTIONS.length) errors.push('host-role capability declaration action inventory is incomplete');
  const seen = new Set();
  for (const binding of bindings) {
    if (!exactKeys(binding, EXACT_ACTION_FIELDS)) {
      errors.push('host-role capability action binding fields must equal the closed schema');
      continue;
    }
    if (!TRANSITION_CAPABILITY_ACTIONS.includes(binding.action)) errors.push(`unknown host-role action '${String(binding.action)}'`);
    if (seen.has(binding.action)) errors.push(`duplicate host-role action '${String(binding.action)}'`);
    seen.add(binding.action);
    if (!TRANSITION_CAPABILITIES.includes(binding.capability) ||
        ACTION_CAPABILITY[binding.action] !== binding.capability) {
      errors.push(`host-role action '${String(binding.action)}' has an invalid capability binding`);
    }
    if (!TRANSITION_CAPABILITY_ACTION_POLICIES.includes(binding.policy)) errors.push(`host-role action '${String(binding.action)}' has invalid policy`);
    if (!TRANSITION_CAPABILITY_ENFORCEMENT.includes(binding.enforcement)) errors.push(`host-role action '${String(binding.action)}' has invalid enforcement`);
    if (typeof binding.mechanism !== 'string' || !binding.mechanism.trim()) errors.push(`host-role action '${String(binding.action)}' lacks an enforcement mechanism`);
  }
  const partition = [
    ...(Array.isArray(value.allowedActions) ? value.allowedActions : []),
    ...(Array.isArray(value.deniedActions) ? value.deniedActions : []),
    ...(Array.isArray(value.humanDispositionActions) ? value.humanDispositionActions : []),
  ];
  if (partition.length !== TRANSITION_CAPABILITY_ACTIONS.length ||
      new Set(partition).size !== TRANSITION_CAPABILITY_ACTIONS.length ||
      TRANSITION_CAPABILITY_ACTIONS.some(action => !partition.includes(action))) {
    errors.push('host-role allowed, denied, and human-disposition actions must form one exact non-overlapping inventory');
  }
  for (const [field, policy] of [
    ['allowedActions', 'allowed'],
    ['deniedActions', 'denied'],
    ['humanDispositionActions', 'requires_human_disposition'],
  ]) {
    if (!Array.isArray(value[field])) {
      errors.push(`host-role capability declaration ${field} must be an array`);
      continue;
    }
    const actual = bindings.filter(item => item.policy === policy).map(item => item.action);
    if (JSON.stringify(value[field]) !== JSON.stringify(actual)) {
      errors.push(`host-role capability declaration ${field} contradicts action bindings`);
    }
  }
  for (const field of ['detectionBoundary', 'limitation', 'recoveryRoute']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) errors.push(`host-role capability declaration ${field} is required`);
  }
  if (value.digest !== hostRoleCapabilityDigest(value)) errors.push('host-role capability declaration digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function validateHostRoleCapabilityInventory(inventory, {
  registry = WORKFLOW_ROLE_REGISTRY,
  hosts = SHIPPED_ADAPTER_HOSTS,
} = {}) {
  const errors = [];
  if (!isObject(inventory)) return { ok: false, errors: ['host-role capability inventory must be an object'] };
  const expectedRoles = enumerateWorkflowRoles(registry).map(role => role.roleId);
  const actualHosts = Object.keys(inventory);
  for (const host of hosts) if (!actualHosts.includes(host)) errors.push(`host-role capability inventory missing host '${host}'`);
  for (const host of actualHosts) if (!hosts.includes(host)) errors.push(`host-role capability inventory contains unknown host '${host}'`);
  for (const host of hosts) {
    const declarations = inventory[host];
    if (!isObject(declarations)) {
      errors.push(`host '${host}' capability declarations must be an object`);
      continue;
    }
    const actualRoles = Object.keys(declarations);
    for (const roleId of expectedRoles) if (!actualRoles.includes(roleId)) errors.push(`host '${host}' missing role '${roleId}' capability declaration`);
    for (const roleId of actualRoles) if (!expectedRoles.includes(roleId)) errors.push(`host '${host}' contains unknown role '${roleId}' capability declaration`);
    for (const roleId of actualRoles) {
      const checked = validateHostRoleCapabilityDeclaration(declarations[roleId], {
        registry,
        expectedHost: host,
        expectedRoleId: roleId,
      });
      errors.push(...checked.errors.map(error => `${host}/${roleId}: ${error}`));
    }
  }
  return { ok: errors.length === 0, errors };
}

export const HOST_ROLE_CAPABILITIES = buildHostRoleCapabilityInventory();

export function buildEffectiveHostRoleCapabilityInventory(host, adapterConfig = {}, options = {}) {
  const inventory = buildHostRoleCapabilityInventory({
    ...options,
    hosts: [host],
    adapterConfigs: { [host]: adapterConfig },
  });
  return inventory[host];
}

export function getHostRoleCapability(host, roleId, { adapterConfig = null } = {}) {
  const declarations = adapterConfig === null
    ? HOST_ROLE_CAPABILITIES[host]
    : buildEffectiveHostRoleCapabilityInventory(host, adapterConfig);
  const declaration = declarations?.[roleId];
  if (!declaration) throw new TypeError(`no host-role capability declaration for '${String(host)}/${String(roleId)}'`);
  return declaration;
}

export function createDegradedEnforcementReports(declaration, { registry = WORKFLOW_ROLE_REGISTRY } = {}) {
  const checked = validateHostRoleCapabilityDeclaration(declaration, { registry });
  if (!checked.ok) throw new TypeError(`cannot report malformed host-role capability declaration: ${checked.errors.join('; ')}`);
  return deepFreeze(declaration.actionBindings
    .filter(binding => binding.enforcement !== 'enforced')
    .map(binding => ({
      kind: TRANSITION_DEGRADED_ENFORCEMENT_REPORT.constants.kind,
      schemaVersion: TRANSITION_DEGRADED_ENFORCEMENT_REPORT.constants.schemaVersion,
      host: declaration.host,
      roleId: declaration.roleId,
      diagnosticCode: 'capability.enforcement.degraded',
      action: binding.action,
      capability: binding.capability,
      enforcement: binding.enforcement,
      // The declaration's limitation, detection boundary, and recovery route
      // are reached through this digest-pinned declaration, never copied per
      // report. See TRANSITION_DEGRADED_ENFORCEMENT_REPORT.
      declarationDigest: declaration.digest,
    })));
}

export function validateDegradedEnforcementReport(value, { declaration: expectedDeclaration = null } = {}) {
  const errors = [];
  if (!exactKeys(value, EXACT_DEGRADED_FIELDS)) {
    return { ok: false, errors: ['degraded-enforcement report fields must equal the closed schema'] };
  }
  if (value.kind !== TRANSITION_DEGRADED_ENFORCEMENT_REPORT.constants.kind ||
      value.schemaVersion !== TRANSITION_DEGRADED_ENFORCEMENT_REPORT.constants.schemaVersion) {
    errors.push('degraded-enforcement report identity is invalid');
  }
  if (value.diagnosticCode !== 'capability.enforcement.degraded') {
    errors.push("degraded-enforcement report diagnosticCode must be 'capability.enforcement.degraded'");
  }
  let declaration = expectedDeclaration;
  if (declaration === null) {
    try {
      declaration = getHostRoleCapability(value.host, value.roleId);
    } catch (error) {
      errors.push(error.message);
    }
  } else {
    const checked = validateHostRoleCapabilityDeclaration(declaration, {
      expectedHost: value.host,
      expectedRoleId: value.roleId,
    });
    if (!checked.ok) errors.push(...checked.errors);
  }
  const binding = declaration?.actionBindings.find(item => item.action === value.action);
  if (!binding || binding.capability !== value.capability || binding.enforcement !== value.enforcement) {
    errors.push('degraded-enforcement report action binding does not match the canonical declaration');
  }
  if (value.enforcement === 'enforced') errors.push('degraded-enforcement report cannot claim enforced behavior');
  // The digest is the whole binding to the declaration: it pins the exact
  // limitation, detection boundary, and recovery route the report refers to
  // without restating any of them.
  if (declaration && value.declarationDigest !== declaration.digest) {
    errors.push('degraded-enforcement report does not match its canonical declaration');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Resolve the declaration-level facts a degraded-enforcement report refers to.
 *
 * A report names its declaration by digest rather than copying its prose, so
 * every renderer resolves the prose here from the exact pinned declaration.
 *
 * @param {object} report
 * @param {object|null} [declaration]  The bound declaration, when the caller holds one.
 * @returns {{ limitation: string|null, detectionBoundary: string|null, recoveryRoute: string|null }}
 */
export function degradedEnforcementDeclarationFacts(report, declaration = null) {
  let resolved = declaration;
  if (!resolved || resolved.digest !== report?.declarationDigest) {
    try {
      const candidate = getHostRoleCapability(report?.host, report?.roleId);
      resolved = candidate?.digest === report?.declarationDigest ? candidate : null;
    } catch {
      resolved = null;
    }
  }
  return {
    limitation: resolved?.limitation ?? null,
    detectionBoundary: resolved?.detectionBoundary ?? null,
    recoveryRoute: resolved?.recoveryRoute ?? null,
  };
}

export function renderHostRoleCapabilityNotice(
  host,
  roleId,
  inventory = HOST_ROLE_CAPABILITIES,
  registry = WORKFLOW_ROLE_REGISTRY
) {
  const declaration = inventory?.[host]?.[roleId];
  if (!declaration) throw new TypeError(`no host-role capability declaration for '${String(host)}/${String(roleId)}'`);
  const checked = validateHostRoleCapabilityDeclaration(declaration, {
    registry,
    expectedHost: host,
    expectedRoleId: roleId,
  });
  if (!checked.ok) throw new TypeError(`cannot render malformed host-role capability declaration: ${checked.errors.join('; ')}`);
  const implementation = declaration.actionBindings.find(item => item.action === 'implementation_mutate');
  return [
    'Capability declaration:',
    `- Role: ${declaration.defaultLabel} (${roleId})`,
    `- Schema: ${declaration.schemaVersion}; digest: ${declaration.digest}`,
    `- implementation_mutate: ${implementation.policy} (${implementation.enforcement})`,
    `- Boundary/recovery: ${declaration.detectionBoundary}; ${declaration.recoveryRoute}`,
    `- Canonical sidecar: ${hostRoleCapabilitySidecarRelativePath(host)}`,
  ].join('\n');
}

export function hostRoleCapabilitySidecarRelativePath(host) {
  if (!SHIPPED_ADAPTER_HOSTS.includes(host)) {
    throw new TypeError(`unknown host-role capability sidecar host '${String(host)}'`);
  }
  return `${HOST_ROLE_CAPABILITY_SIDECAR_DIRECTORY}/${host}.json`;
}

function sidecarProjection(value) {
  const projection = structuredClone(value);
  delete projection.digest;
  return projection;
}

export function hostRoleCapabilitySidecarDigest(value) {
  return `sha256:agenticloop.host-role-capability-sidecar.v1:${canonicalSha256(sidecarProjection(value))}`;
}

export function createHostRoleCapabilitySidecar(host, adapterConfig = {}, options = {}) {
  const value = {
    kind: HOST_ROLE_CAPABILITY_SIDECAR_KIND,
    schemaVersion: HOST_ROLE_CAPABILITY_SIDECAR_SCHEMA_VERSION,
    host,
    declarations: buildEffectiveHostRoleCapabilityInventory(host, adapterConfig, options),
    digest: null,
  };
  value.digest = hostRoleCapabilitySidecarDigest(value);
  return deepFreeze(value);
}

export function renderHostRoleCapabilitySidecar(host, adapterConfig = {}, options = {}) {
  return `${canonicalJson(createHostRoleCapabilitySidecar(host, adapterConfig, options))}\n`;
}

export function validateHostRoleCapabilitySidecar(value, {
  host,
  adapterConfig = {},
  registry = WORKFLOW_ROLE_REGISTRY,
} = {}) {
  const errors = [];
  if (!exactKeys(value, new Set(['kind', 'schemaVersion', 'host', 'declarations', 'digest']))) {
    return { ok: false, errors: ['host-role capability sidecar fields must equal the closed schema'] };
  }
  if (value.kind !== HOST_ROLE_CAPABILITY_SIDECAR_KIND ||
      value.schemaVersion !== HOST_ROLE_CAPABILITY_SIDECAR_SCHEMA_VERSION ||
      value.host !== host) {
    errors.push('host-role capability sidecar identity is invalid');
  }
  const checked = validateHostRoleCapabilityInventory(
    { [host]: value.declarations },
    { registry, hosts: [host] }
  );
  errors.push(...checked.errors);
  if (value.digest !== hostRoleCapabilitySidecarDigest(value)) {
    errors.push('host-role capability sidecar digest is invalid');
  }
  const expected = createHostRoleCapabilitySidecar(host, adapterConfig, { registry });
  if (canonicalJson(value) !== canonicalJson(expected)) {
    errors.push('host-role capability sidecar does not match the effective generated host configuration');
  }
  return { ok: errors.length === 0, errors };
}

export function requiredRoleCapabilities(roleId) {
  const role = WORKFLOW_ROLE_IDS.includes(roleId) ? roleId : null;
  if (!role) throw new TypeError(`unknown workflow roleId '${String(roleId)}'`);
  return Object.freeze([...new Set(
    ROLE_ALLOWED_ACTIONS[role].map(action => ACTION_CAPABILITY[action])
  )]);
}
