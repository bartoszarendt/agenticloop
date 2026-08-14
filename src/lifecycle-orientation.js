/** Closed, deterministic, read-only lifecycle orientation for `status --json`. */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseFrontmatterStrict } from './frontmatter.js';
import { loadProjectMap, PROJECT_MAP_DEFAULTS } from './project-map.js';
import { adapterDiscoverySummary } from './adapter-discovery.js';
import { taskContractDigest, validateTaskContractBaseline } from './task-contract-baseline.js';
import { loadFilesTaskContractRecords } from './files-task-contract.js';
import { validateTaskRecord, validateTaskRecordDiagnostics } from './validate-config.js';
import { LEGAL_TASK_STATUS_TRANSITIONS } from './task-transition.js';
import {
  ACTIVATION_STORE_ROOT,
  listTaskActivationBindings,
  readActivationRevocations,
} from './activation-store.js';
import {
  resolveCurrentTaskAuthorization,
  resolveActivationVerification,
  resolveEffectiveActivationPolicy,
} from './activation-resolution.js';
import {
  ACTIVATION_GRANT_CLOCK_SKEW_MS,
  activationGrantSignaturePayload,
  validateActivationGrantShape,
  validateActivationRevocation,
  validateTaskActivationBindingShape,
} from './activation-grant.js';
import { targetRepositoryIdentity } from './host-trust.js';
import { readExternalActivationRevocations } from './activation-trust.js';

export const LIFECYCLE_ORIENTATION_KIND = 'agenticloop.lifecycle-orientation';
export const LIFECYCLE_ORIENTATION_SCHEMA_VERSION = 2;

/** The closed set of authorization states the snapshot can report. */
export const AUTHORIZATION_STATES = Object.freeze([
  'present', 'missing', 'malformed', 'expired', 'revoked', 'stale', 'mismatched', 'unauthenticated',
]);

const TOP_LEVEL_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'state', 'target', 'backend', 'roots', 'activationScope',
  'operatorAuthorizedSet', 'adapters', 'candidates', 'excluded', 'tasks', 'diagnostics', 'legalNextAction',
]);
const TASK_FIELDS = Object.freeze([
  'taskId', 'carrier', 'status', 'state', 'reasons', 'baseline', 'lint', 'activationProvenance',
  'operatorAuthorization', 'roots', 'dependencies',
]);
const ACTION_FIELDS = Object.freeze(['type', 'taskId', 'command']);
const ROOT_FIELDS = Object.freeze(['carrier', 'artifact', 'working']);
const BASELINE_FIELDS = Object.freeze(['state', 'digest', 'trustedRecordCount', 'errors']);
const LINT_FIELDS = Object.freeze(['state', 'rootDiagnostics', 'errors']);
const ACTIVATION_PROVENANCE_FIELDS = Object.freeze(['state', 'inputDigest', 'captureRef']);
const AUTHORIZATION_FIELDS = Object.freeze(['state', 'bindingId', 'grantId', 'provenance', 'errors']);
const AUTHORIZATION_PROVENANCE_FIELDS = Object.freeze([
  'repositoryIdentity', 'assurance', 'issuedAt', 'expiresAt', 'source', 'derivation', 'scope',
]);
const DEPENDENCY_FIELDS = Object.freeze(['id', 'disposition']);
const EXCLUDED_FIELDS = Object.freeze(['taskId', 'carrier', 'reason']);
const ACTIVATION_SCOPE_FIELDS = Object.freeze(['source', 'state', 'scopes', 'errors']);
const AUTHORIZED_SET_FIELDS = Object.freeze(['source', 'state', 'bindings', 'errors']);
const ACTIVATION_SCOPE_ENTRY_FIELDS = Object.freeze(['grantId', 'repositoryIdentity', 'assurance', 'scope']);
const AUTHORIZED_BINDING_FIELDS = Object.freeze([
  'taskId', 'bindingId', 'grantId', 'repositoryIdentity', 'assurance', 'issuedAt', 'expiresAt', 'provenance',
]);
const AUTHORIZED_BINDING_PROVENANCE_FIELDS = Object.freeze(['source', 'derivation', 'scope']);
const GRANT_SCOPE_FIELDS = Object.freeze(['type', 'taskIds', 'workUnitId', 'operatorIntentDigest']);
const ADAPTER_SUMMARY_FIELDS = Object.freeze(['adapters', 'nextSteps']);
const ADAPTER_FIELDS = Object.freeze(['host', 'status', 'enabled', 'required', 'present', 'missingModelRoles']);

function exact(value, fields) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
}
function rel(target, path) { return relative(target, path).replaceAll('\\', '/') || '.'; }
function taskRoot(target, config) {
  return dirname(resolve(target, String(config.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template).replaceAll('{taskId}', '__TASK_ID__')));
}
function stringList(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].sort() : [];
}
function string(value) { return typeof value === 'string' && value.length > 0; }
function nullableString(value) { return value === null || string(value); }
function strings(value) { return Array.isArray(value) && value.every(string); }
function root(value, { allowNullWorking = false } = {}) {
  return exact(value, ROOT_FIELDS) && string(value.carrier) &&
    (allowNullWorking ? nullableString(value.working) : string(value.working)) && nullableString(value.artifact);
}
function grantScope(value) {
  return exact(value, GRANT_SCOPE_FIELDS) && ['exact_tasks', 'work_unit', 'captured_request'].includes(value.type) &&
    (value.type === 'exact_tasks'
      ? Array.isArray(value.taskIds) && value.taskIds.length > 0 && value.taskIds.every(string) &&
        new Set(value.taskIds).size === value.taskIds.length && value.taskIds.every((id, index) => index === 0 || id > value.taskIds[index - 1]) &&
        value.workUnitId === null && value.operatorIntentDigest === null
      : value.type === 'work_unit'
        ? value.taskIds === null && string(value.workUnitId) && value.operatorIntentDigest === null
        : value.taskIds === null && value.workUnitId === null && string(value.operatorIntentDigest));
}

/**
 * Inventory record faults are lifecycle context, not authorization. A raw
 * record never adds authority here: exact authority remains solely the result
 * of `resolveCurrentTaskAuthorization` for the current task carrier.
 */
function activationInventoryErrors(target) {
  const errors = [];
  const bindings = listTaskActivationBindings(target);
  errors.push(...(bindings.errors ?? []).map(error => `binding:${error}`));
  for (const item of bindings.bindings ?? []) {
    const checked = validateTaskActivationBindingShape(item.record);
    if (!checked.ok) {
      errors.push(...checked.errors.map(error => `binding:${item.path}: ${error.message}`));
    }
  }
  const revocations = readActivationRevocations(target);
  errors.push(...(revocations.errors ?? []).map(error => `revocation:${error}`));

  const grantsDirectory = resolve(target, ACTIVATION_STORE_ROOT, 'grants');
  if (existsSync(grantsDirectory)) {
    try {
      for (const name of readdirSync(grantsDirectory).filter(name => name.endsWith('.json')).sort()) {
        const path = `${ACTIVATION_STORE_ROOT}/grants/${name}`;
        try {
          const checked = validateActivationGrantShape(JSON.parse(readFileSync(join(grantsDirectory, name), 'utf8')));
          if (!checked.ok) errors.push(...checked.errors.map(error => `grant:${path}: ${error.message}`));
        } catch (error) {
          errors.push(`grant:${path}: unreadable or invalid JSON: ${error.message}`);
        }
      }
    } catch (error) {
      errors.push(`grant inventory unreadable: ${error.message}`);
    }
  }
  return [...new Set(errors)].sort();
}

/** Resolve a broad signed grant only for scoped status projection, never task authority. */
function activeGrantScopes(target, io) {
  const errors = [];
  const scopes = [];
  let verification;
  let policy;
  try {
    verification = resolveActivationVerification(target, io);
    policy = resolveEffectiveActivationPolicy(target, io);
  } catch (error) {
    return { scopes, errors: [`activation context: ${error.message}`] };
  }
  const external = readExternalActivationRevocations(target, {
    operatorActivationRoot: io?.operatorActivationRoot ?? undefined,
  });
  const local = readActivationRevocations(target);
  errors.push(...(external.errors ?? []).map(error => `external revocation: ${error}`));
  errors.push(...(local.errors ?? []).map(error => `revocation: ${error}`));
  const grantsDirectory = resolve(target, ACTIVATION_STORE_ROOT, 'grants');
  if (!existsSync(grantsDirectory)) return { scopes, errors: errors.sort() };
  try {
    for (const name of readdirSync(grantsDirectory).filter(name => name.endsWith('.json')).sort()) {
      const path = `${ACTIVATION_STORE_ROOT}/grants/${name}`;
      let grant;
      try { grant = JSON.parse(readFileSync(join(grantsDirectory, name), 'utf8')); } catch { continue; }
      const checked = validateActivationGrantShape(grant);
      if (!checked.ok) continue;
      // Grant validation alone cannot authenticate signatures; make the
      // verification explicit without interpreting broad scope as a binding.
      const authenticated = verification.verify(
        activationGrantSignaturePayload(grant), grant.authentication, grant.assurance, { recordType: 'grant', grant }
      );
      const now = Date.now();
      const revoked = [...external.revocations, ...local.revocations].some(record => {
        const valid = validateActivationRevocation(record);
        return !valid.ok || record.grantId === grant.grantId || record.revocationId === grant.revocation.id;
      });
      const issuedAt = Date.parse(grant.issuedAt);
      if (issuedAt - ACTIVATION_GRANT_CLOCK_SKEW_MS > now) {
        errors.push(`grant:${path}: activation grant is issued in the future`);
        continue;
      }
      if (grant.repositoryIdentity !== targetRepositoryIdentity(target) || !authenticated || revoked || Date.parse(grant.expiresAt) <= now ||
          (policy.minimumActivation === 'host_signed' && grant.assurance !== 'host_signed')) continue;
      scopes.push({
        grantId: grant.grantId,
        repositoryIdentity: grant.repositoryIdentity,
        assurance: grant.assurance,
        scope: structuredClone(grant.scope),
      });
    }
  } catch (error) {
    errors.push(`grant inventory unreadable: ${error.message}`);
  }
  return { scopes: scopes.sort((left, right) => left.grantId.localeCompare(right.grantId)), errors: errors.sort() };
}

function taskShell(carrier) {
  return {
    taskId: null, carrier, status: null, state: 'incomplete', reasons: [],
    baseline: { state: 'unavailable', digest: null, trustedRecordCount: 0, errors: [] },
    lint: { state: 'unavailable', rootDiagnostics: [], errors: [] },
    activationProvenance: { state: 'missing', inputDigest: null, captureRef: null },
    operatorAuthorization: { state: 'missing', bindingId: null, grantId: null, provenance: null, errors: [] },
    roots: { carrier, artifact: null, working: null }, dependencies: [],
  };
}

function orientTask(target, backend, file, io) {
  const carrier = rel(target, file);
  const task = taskShell(carrier);
  let content;
  try { content = readFileSync(file, 'utf8'); } catch (error) {
    task.reasons = [`carrier_unreadable:${error.message}`]; return task;
  }
  const parsed = parseFrontmatterStrict(content);
  if (parsed.state !== 'valid') {
    task.reasons = [`frontmatter_${parsed.state}${parsed.reason ? `:${parsed.reason}` : ''}`]; return task;
  }
  task.taskId = typeof parsed.data.task_id === 'string' ? parsed.data.task_id.trim() || null : null;
  task.status = typeof parsed.data.status === 'string' ? parsed.data.status.trim() || null : null;
  task.roots.artifact = '.';
  const rootDiagnostics = validateTaskRecordDiagnostics(content, carrier).map(item => item.message).sort();
  const lintErrors = validateTaskRecord(content, carrier).sort();
  task.lint = { state: rootDiagnostics.length || lintErrors.length ? 'invalid' : 'current', rootDiagnostics, errors: lintErrors };
  const contract = taskContractDigest(content);
  let history = { trustedRecords: [], errors: [] };
  if (task.taskId) history = loadFilesTaskContractRecords(target, task.taskId);
  const baselineCheck = contract.ok && task.status && task.status !== 'draft'
    ? validateTaskContractBaseline(content, { lifecycle: Number(parsed.data.task_contract_schema) >= 2 ? 'new' : 'legacy', trustedRecords: history.trustedRecords, trustedRecordErrors: history.errors })
    : { ok: contract.ok, errors: contract.ok ? [] : [contract.error] };
  task.baseline = {
    state: contract.ok && baselineCheck.ok ? 'current' : 'invalid', digest: contract.digest ?? null,
    trustedRecordCount: history.trustedRecords.length, errors: [...(baselineCheck.errors ?? [])].sort(),
  };
  const digest = typeof parsed.data.activation_input_digest === 'string' ? parsed.data.activation_input_digest : null;
  const captureRef = typeof parsed.data.activation_capture_ref === 'string' ? parsed.data.activation_capture_ref : null;
  task.activationProvenance = { state: digest && captureRef ? 'declared' : 'missing', inputDigest: digest, captureRef };
  // Authorization is resolved through the canonical activation-resolution and
  // policy path, never by interpreting raw store JSON: `present` requires a
  // current, authenticated binding for this exact repository, backend, task,
  // carrier, and contract digest under the effective policy.
  if (task.taskId) {
    const authorization = resolveCurrentTaskAuthorization(target, io ?? {}, {
      backend, taskId: task.taskId, carrier, taskContractDigest: contract.digest ?? null,
    });
    task.operatorAuthorization = {
      state: authorization.state,
      bindingId: authorization.binding?.bindingId ?? null, grantId: authorization.grant?.grantId ?? null,
      provenance: authorization.binding && authorization.grant ? {
        repositoryIdentity: authorization.grant?.repositoryIdentity ?? authorization.binding.repositoryIdentity,
        assurance: authorization.assurance ?? authorization.binding.assurance,
        issuedAt: authorization.binding.issuedAt,
        expiresAt: authorization.binding.expiresAt,
        source: 'activation_grant',
        derivation: authorization.binding.derivation,
        scope: structuredClone(authorization.grant.scope),
      } : null,
      errors: authorization.errors,
    };
  }
  task.dependencies = stringList(parsed.data.depends_on ?? parsed.data.dependencies).map(id => ({ id, disposition: 'unresolved' }));
  task.reasons = [
    ...(task.taskId ? [] : ['task_id_missing']),
    ...(Object.hasOwn(LEGAL_TASK_STATUS_TRANSITIONS, task.status) ? [] : ['status_invalid']),
    ...task.baseline.errors.map(error => `baseline:${error}`), ...rootDiagnostics.map(error => `root:${error}`), ...lintErrors.map(error => `lint:${error}`),
    ...task.operatorAuthorization.errors.map(error => `authorization:${error}`),
  ].sort();
  task.state = task.reasons.length ? 'incomplete' : 'current';
  return task;
}

/** Validate an orientation snapshot before it crosses the public JSON boundary. */
export function validateLifecycleOrientationSnapshot(snapshot) {
  const errors = [];
  if (!exact(snapshot, TOP_LEVEL_FIELDS)) return { ok: false, errors: ['orientation snapshot fields must equal the closed schema'] };
  if (snapshot.kind !== LIFECYCLE_ORIENTATION_KIND || snapshot.schemaVersion !== LIFECYCLE_ORIENTATION_SCHEMA_VERSION) errors.push('orientation snapshot identity is invalid');
  if (!['incomplete', 'no_work', 'one_candidate', 'multiple_candidates'].includes(snapshot.state)) errors.push('orientation snapshot state is invalid');
  if (!string(snapshot.target) || !['files', 'github'].includes(snapshot.backend)) errors.push('orientation target or backend is invalid');
  const validTask = task => exact(task, TASK_FIELDS) &&
    nullableString(task.taskId) && string(task.carrier) && nullableString(task.status) && ['current', 'incomplete'].includes(task.state) && strings(task.reasons) &&
    root(task.roots, { allowNullWorking: true }) && exact(task.baseline, BASELINE_FIELDS) && ['current', 'invalid', 'unavailable'].includes(task.baseline.state) && nullableString(task.baseline.digest) &&
    Number.isSafeInteger(task.baseline.trustedRecordCount) && task.baseline.trustedRecordCount >= 0 && strings(task.baseline.errors) &&
    exact(task.lint, LINT_FIELDS) && ['current', 'invalid', 'unavailable'].includes(task.lint.state) && strings(task.lint.rootDiagnostics) && strings(task.lint.errors) &&
    exact(task.activationProvenance, ACTIVATION_PROVENANCE_FIELDS) && ['declared', 'missing'].includes(task.activationProvenance.state) &&
    nullableString(task.activationProvenance.inputDigest) && nullableString(task.activationProvenance.captureRef) &&
    exact(task.operatorAuthorization, AUTHORIZATION_FIELDS) && AUTHORIZATION_STATES.includes(task.operatorAuthorization.state) &&
    nullableString(task.operatorAuthorization.bindingId) && nullableString(task.operatorAuthorization.grantId) && strings(task.operatorAuthorization.errors) &&
    (task.operatorAuthorization.provenance === null || (exact(task.operatorAuthorization.provenance, AUTHORIZATION_PROVENANCE_FIELDS) &&
      string(task.operatorAuthorization.provenance.repositoryIdentity) && ['operator_confirmed', 'host_signed'].includes(task.operatorAuthorization.provenance.assurance) &&
      string(task.operatorAuthorization.provenance.issuedAt) && string(task.operatorAuthorization.provenance.expiresAt) &&
      task.operatorAuthorization.provenance.source === 'activation_grant' && string(task.operatorAuthorization.provenance.derivation) &&
      grantScope(task.operatorAuthorization.provenance.scope))) &&
    Array.isArray(task.dependencies) && task.dependencies.every(dependency => exact(dependency, DEPENDENCY_FIELDS) && string(dependency.id) && string(dependency.disposition));
  if (!Array.isArray(snapshot.tasks) || snapshot.tasks.some(task => !validTask(task))) errors.push('orientation task fields must equal the closed schema');
  if (!Array.isArray(snapshot.candidates) || snapshot.candidates.some(task => !validTask(task))) errors.push('orientation candidates must be detailed closed task objects');
  if (!Array.isArray(snapshot.excluded) || snapshot.excluded.length !== snapshot.tasks.length - snapshot.candidates.length || snapshot.excluded.some(item => !exact(item, EXCLUDED_FIELDS) || !nullableString(item.taskId) || !string(item.carrier) || !string(item.reason))) errors.push('orientation excluded inventory must cover every non-candidate task');
  const authorizedBindings = snapshot.operatorAuthorizedSet?.bindings;
  const taskById = new Map((snapshot.tasks ?? []).filter(task => task?.taskId).map(task => [task.taskId, task]));
  const validAuthorizedBinding = binding => {
    const authorization = taskById.get(binding?.taskId)?.operatorAuthorization;
    const provenance = authorization?.provenance;
    return exact(binding, AUTHORIZED_BINDING_FIELDS) && string(binding.taskId) &&
      string(binding.bindingId) && string(binding.grantId) && string(binding.repositoryIdentity) &&
      ['operator_confirmed', 'host_signed'].includes(binding.assurance) && string(binding.issuedAt) && string(binding.expiresAt) &&
      exact(binding.provenance, AUTHORIZED_BINDING_PROVENANCE_FIELDS) && binding.provenance.source === 'activation_grant' &&
      string(binding.provenance.derivation) && grantScope(binding.provenance.scope) &&
      authorization?.state === 'present' && authorization.bindingId === binding.bindingId && authorization.grantId === binding.grantId &&
      provenance !== null && binding.repositoryIdentity === provenance?.repositoryIdentity && binding.assurance === provenance?.assurance &&
      binding.issuedAt === provenance?.issuedAt && binding.expiresAt === provenance?.expiresAt &&
      binding.provenance.source === provenance?.source && binding.provenance.derivation === provenance?.derivation &&
      JSON.stringify(binding.provenance.scope) === JSON.stringify(provenance?.scope);
  };
  if (!root(snapshot.roots) || !exact(snapshot.activationScope, ACTIVATION_SCOPE_FIELDS) ||
      snapshot.activationScope.source !== '.agenticloop/activations' || !['current', 'invalid'].includes(snapshot.activationScope.state) ||
      !Array.isArray(snapshot.activationScope.scopes) || snapshot.activationScope.scopes.some(scope =>
        !exact(scope, ACTIVATION_SCOPE_ENTRY_FIELDS) || !string(scope.grantId) || !string(scope.repositoryIdentity) ||
        !['operator_confirmed', 'host_signed'].includes(scope.assurance) || !grantScope(scope.scope)) ||
      snapshot.activationScope.scopes.some((scope, index, scopes) => index > 0 && scope.grantId <= scopes[index - 1].grantId) ||
      !strings(snapshot.activationScope.errors) ||
      !exact(snapshot.operatorAuthorizedSet, AUTHORIZED_SET_FIELDS) ||
      snapshot.operatorAuthorizedSet.source !== 'canonical_activation_resolution' || !['current', 'invalid'].includes(snapshot.operatorAuthorizedSet.state) ||
      !Array.isArray(authorizedBindings) || authorizedBindings.some(item => !validAuthorizedBinding(item)) ||
      new Set((authorizedBindings ?? []).map(item => item.taskId)).size !== (authorizedBindings ?? []).length ||
      authorizedBindings?.some((binding, index, bindings) => index > 0 && binding.taskId <= bindings[index - 1].taskId) ||
      !strings(snapshot.operatorAuthorizedSet.errors) || !strings(snapshot.diagnostics)) {
    errors.push('orientation nested fields must equal the closed schema');
  }
  if (!exact(snapshot.adapters, ADAPTER_SUMMARY_FIELDS) || !Array.isArray(snapshot.adapters.adapters) || !strings(snapshot.adapters.nextSteps) ||
      snapshot.adapters.adapters.some(adapter => !exact(adapter, ADAPTER_FIELDS) || !string(adapter.host) || !string(adapter.status) ||
        typeof adapter.enabled !== 'boolean' || typeof adapter.required !== 'boolean' || !strings(adapter.present) || !strings(adapter.missingModelRoles))) {
    errors.push('orientation adapters must equal the closed schema');
  }
  const action = snapshot.legalNextAction;
  if (!exact(action, ACTION_FIELDS) || ![
    ['repair_lifecycle_context', null], ['no_action', null], ['prepare_dispatch', 'task'], ['select_task', null],
  ].some(([type, task]) => action.type === type && (task === 'task' ? string(action.taskId) : action.taskId === task)) ||
      (action.type === 'no_action' ? action.command !== null : !string(action.command)) ||
      (action.type === 'prepare_dispatch' && !/\s--role engineer(?:\s|$)/.test(action.command))) {
    errors.push('orientation legalNextAction must equal the closed schema');
  }
  return { ok: errors.length === 0, errors };
}

export function lifecycleOrientationSnapshot(target, options = {}) {
  const root = resolve(target); const diagnostics = []; let project = null;
  const io = options.io ?? {};
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const workingRelative = relative(root, workingDirectory);
  const working = workingRelative && !workingRelative.startsWith('..') && !isAbsolute(workingRelative)
    ? workingRelative.replaceAll('\\', '/')
    : workingDirectory;
  try { project = loadProjectMap(root); } catch (error) { diagnostics.push(`project_map_unreadable:${error.message}`); }
  const config = project?.config ?? PROJECT_MAP_DEFAULTS; const backend = config.task_backend; const directory = taskRoot(root, config);
  const tasks = [];
  if (backend !== 'files') diagnostics.push(`unsupported_backend:${String(backend)}`);
  else if (existsSync(directory)) {
    try { for (const name of readdirSync(directory).filter(name => name.endsWith('.md')).sort()) tasks.push(orientTask(root, backend, join(directory, name), io)); }
    catch (error) { diagnostics.push(`task_inventory_unreadable:${error.message}`); }
  }
  tasks.sort((left, right) => `${left.taskId ?? ''}\0${left.carrier}`.localeCompare(`${right.taskId ?? ''}\0${right.carrier}`));
  const byId = new Map(tasks.filter(task => task.taskId).map(task => [task.taskId, task]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      const targetTask = byId.get(dependency.id);
      dependency.disposition = targetTask?.state === 'current' && ['accepted', 'closed'].includes(targetTask.status) ? 'satisfied' : targetTask ? `blocked:${targetTask.status ?? 'incomplete'}` : 'missing';
    }
    if (task.state === 'current' && task.status === 'agent-ready') {
      // A declared legacy capture alone carries neither an authenticated exact
      // scope nor current operator authorization, so it cannot produce a
      // dispatch recommendation. It remains visible as provenance only.
      if (task.operatorAuthorization.state !== 'present') task.reasons.push('activation_missing');
      if (task.dependencies.some(item => item.disposition !== 'satisfied')) task.reasons.push('dependency_unsatisfied');
      task.reasons.sort(); if (task.reasons.length) task.state = 'incomplete';
    }
  }
  const inventoryErrors = activationInventoryErrors(root);
  const scopeInventory = activeGrantScopes(root, io);
  const activationErrors = [...new Set([...inventoryErrors, ...scopeInventory.errors])].sort();
  if (activationErrors.length) diagnostics.push(...activationErrors.map(error => `activation_inventory:${error}`));
  const authorized = tasks
    .filter(task => task.operatorAuthorization.state === 'present' && task.operatorAuthorization.provenance)
    .map(task => {
      const { bindingId, grantId, provenance } = task.operatorAuthorization;
      return {
        taskId: task.taskId,
        bindingId,
        grantId,
        repositoryIdentity: provenance.repositoryIdentity,
        assurance: provenance.assurance,
        issuedAt: provenance.issuedAt,
        expiresAt: provenance.expiresAt,
        provenance: {
          source: provenance.source,
          derivation: provenance.derivation,
          scope: structuredClone(provenance.scope),
        },
      };
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  const scopes = scopeInventory.scopes;
  const candidates = tasks.filter(task => task.state === 'current' && task.status === 'agent-ready');
  const excluded = tasks.filter(task => !candidates.includes(task)).map(task => ({ taskId: task.taskId, carrier: task.carrier, reason: task.state === 'incomplete' ? 'incomplete' : `status:${task.status}` }));
  const incomplete = diagnostics.length > 0 || tasks.some(task => task.state !== 'current');
  const action = incomplete ? { type: 'repair_lifecycle_context', taskId: null, command: 'agenticloop task lint' } : candidates.length === 0 ? { type: 'no_action', taskId: null, command: null } : candidates.length === 1 ? { type: 'prepare_dispatch', taskId: candidates[0].taskId, command: `agenticloop task prepare-dispatch ${candidates[0].taskId} --host <host> --role engineer` } : { type: 'select_task', taskId: null, command: 'agenticloop task list --status agent-ready' };
  const snapshot = {
    kind: LIFECYCLE_ORIENTATION_KIND, schemaVersion: LIFECYCLE_ORIENTATION_SCHEMA_VERSION, state: incomplete ? 'incomplete' : candidates.length === 0 ? 'no_work' : candidates.length === 1 ? 'one_candidate' : 'multiple_candidates',
    target: root, backend, roots: { carrier: rel(root, directory), artifact: '.', working },
    // Scope reports the signed grant's declared breadth, while bindings report
    // only exact, current task authorization. A broad scope is never itself a
    // dispatch authorization.
    activationScope: { source: '.agenticloop/activations', state: activationErrors.length ? 'invalid' : 'current', scopes, errors: activationErrors },
    operatorAuthorizedSet: { source: 'canonical_activation_resolution', state: activationErrors.length ? 'invalid' : 'current', bindings: authorized, errors: activationErrors },
    adapters: adapterDiscoverySummary(root), candidates, excluded, tasks, diagnostics: diagnostics.sort(), legalNextAction: action,
  };
  const checked = validateLifecycleOrientationSnapshot(snapshot);
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  return Object.freeze(snapshot);
}
