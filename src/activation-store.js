/**
 * Durable, target-owned activation record storage.
 *
 * Activation grants and task bindings are evidence dispatch consumes later, so
 * they are never written to `.agenticloop/tmp/`. They live under a dedicated
 * durable root:
 *
 *     .agenticloop/activations/grants/<grant-uuid>.json
 *     .agenticloop/activations/bindings/<backend>--<task-id>.json
 *     .agenticloop/activations/revocations/<revocation-uuid>.json
 *
 * Filenames are deterministic, so re-running an activation for the same task
 * addresses the same record instead of accumulating shadow authority. Every
 * path is resolved through the shared mutation kernel, which rejects traversal,
 * drive-qualified paths, backslashes, NUL bytes, and symlink/junction escape,
 * and every multi-record write is one transaction: either the grant and all its
 * bindings land, or nothing does and the receipt says so explicitly.
 *
 * No private key material and no raw operator request text is ever stored here.
 * The grant carries digests and identities only.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { executeMutationBatch, fingerprintTargetPath, resolveTargetPath } from './fs-mutation-kernel.js';
import {
  validateActivationGrantShape,
  validateActivationRevocation,
  validateTaskActivationBindingShape,
} from './activation-grant.js';

export const ACTIVATION_STORE_ROOT = '.agenticloop/activations';
export const ACTIVATION_MUTATION_RECEIPT_KIND = 'agenticloop.activation-mutation-receipt';
export const ACTIVATION_MUTATION_RECEIPT_SCHEMA_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Reserved Windows device names, which cannot be used as file basenames. */
const RESERVED_BASENAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function assertSafeTaskSlug(taskId) {
  const value = String(taskId ?? '');
  if (!TASK_ID_RE.test(value)) {
    throw new Error(`unsafe activation record task id: ${value}`);
  }
  if (RESERVED_BASENAMES.test(value) || value.endsWith('.') || value.endsWith(' ')) {
    throw new Error(`unsafe activation record task id for cross-platform storage: ${value}`);
  }
  return value;
}

function idSuffix(prefixed, prefix) {
  const value = String(prefixed ?? '');
  if (!value.startsWith(`${prefix}:`)) throw new Error(`activation record id must start with '${prefix}:'`);
  const suffix = value.slice(prefix.length + 1);
  if (!UUID_RE.test(suffix)) throw new Error(`activation record id must be ${prefix}:<uuid-v4>`);
  return suffix;
}

export function grantRecordPath(grantId) {
  return `${ACTIVATION_STORE_ROOT}/grants/${idSuffix(grantId, 'grant')}.json`;
}

export function bindingRecordPath(backend, taskId) {
  if (!['files', 'github'].includes(backend)) throw new Error(`unsupported activation binding backend: ${String(backend)}`);
  return `${ACTIVATION_STORE_ROOT}/bindings/${backend}--${assertSafeTaskSlug(taskId)}.json`;
}

export function revocationRecordPath(revocationId) {
  return `${ACTIVATION_STORE_ROOT}/revocations/${idSuffix(revocationId, 'revocation')}.json`;
}

function serialize(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function digestOf(target, relPath) {
  const fingerprint = fingerprintTargetPath(target, relPath);
  if (fingerprint === null) return null;
  if (fingerprint === 'directory') throw new Error(`activation record path is a directory: ${relPath}`);
  return `sha256:${fingerprint}`;
}

function readRecord(target, relPath) {
  const absolute = resolveTargetPath(target, relPath);
  if (!existsSync(absolute)) return { ok: true, state: 'absent', record: null, errors: [], path: relPath };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    return { ok: false, state: 'malformed', record: null, errors: [`${relPath} is unreadable or invalid JSON: ${error.message}`], path: relPath };
  }
  return { ok: true, state: 'present', record: parsed, errors: [], path: relPath };
}

/**
 * Build one versioned mutation receipt for an activation store transaction.
 * `unresolved` is true whenever the filesystem was left in a state the command
 * could not prove, so a caller never has to infer it from prose.
 */
export function createActivationMutationReceipt({
  operation,
  grantId = null,
  bindingIds = [],
  disposition,
  changedPaths = [],
  recovery = null,
  errors = [],
}) {
  const record = {
    kind: ACTIVATION_MUTATION_RECEIPT_KIND,
    schemaVersion: ACTIVATION_MUTATION_RECEIPT_SCHEMA_VERSION,
    operation,
    grantId,
    bindingIds: [...bindingIds].sort(),
    mutationDisposition: disposition,
    unresolved: !['committed', 'uncommitted', 'already_current'].includes(disposition),
    changedPaths: [...changedPaths].sort(),
    recovery,
    errors: [...errors],
  };
  return Object.freeze(record);
}

/**
 * Write one grant and its complete binding set as a single transaction.
 *
 * Bindings replace any prior binding for the same (backend, task) pair, but
 * only against the exact digest the caller observed: a concurrent activation
 * makes the whole batch fail closed rather than silently overwrite.
 *
 * @param {string} target
 * @param {{ grant: object, bindings: object[], expectedBindingDigests?: Record<string, string|null> }} input
 */
export function writeActivationRecords(target, { grant, bindings = [], expectedBindingDigests = null } = {}) {
  const grantCheck = validateActivationGrantShape(grant);
  if (!grantCheck.ok) {
    return {
      ok: false,
      receipt: createActivationMutationReceipt({
        operation: 'activate',
        disposition: 'uncommitted',
        errors: grantCheck.errors.map(item => item.message),
        recovery: 'No activation record was written. Repair the reported cause and rerun the activation command.',
      }),
      paths: [],
    };
  }
  for (const binding of bindings) {
    const check = validateTaskActivationBindingShape(binding);
    if (!check.ok) {
      return {
        ok: false,
        receipt: createActivationMutationReceipt({
          operation: 'activate',
          grantId: grant.grantId,
          disposition: 'uncommitted',
          errors: check.errors.map(item => item.message),
          recovery: 'No activation record was written. Repair the reported cause and rerun the activation command.',
        }),
        paths: [],
      };
    }
  }
  /** @type {any[]} */
  let mutations;
  let paths;
  try {
    const grantPath = grantRecordPath(grant.grantId);
    mutations = [{ type: 'create', path: grantPath, content: serialize(grant) }];
    paths = [grantPath];
    for (const binding of bindings) {
      const path = bindingRecordPath(binding.backend, binding.taskId);
      const expected = expectedBindingDigests?.[path] ?? digestOf(target, path);
      mutations.push(
        expected === null
          ? { type: 'create', path, content: serialize(binding) }
          : { type: 'write', path, content: serialize(binding), expectedDigest: expected, expectedKind: 'file' }
      );
      paths.push(path);
    }
  } catch (error) {
    return {
      ok: false,
      receipt: createActivationMutationReceipt({
        operation: 'activate',
        grantId: grant.grantId,
        disposition: 'uncommitted',
        errors: [error.message],
        recovery: 'No activation record was written. Repair the reported cause and rerun the activation command.',
      }),
      paths: [],
    };
  }
  const applied = executeMutationBatch(target, mutations);
  if (!applied.ok) {
    const rolledBack = applied.rollbackErrors.length === 0;
    return {
      ok: false,
      receipt: createActivationMutationReceipt({
        operation: 'activate',
        grantId: grant.grantId,
        bindingIds: bindings.map(binding => binding.bindingId),
        disposition: rolledBack ? 'uncommitted' : 'unresolved',
        changedPaths: rolledBack ? [] : paths,
        errors: [...applied.errors, ...applied.rollbackErrors],
        recovery: rolledBack
          ? 'No activation authority was created; the transaction rolled back completely. Rerun the activation command.'
          : `Rollback reported errors. Inspect ${paths.join(', ')} before treating any task as activated.`,
      }),
      paths,
    };
  }
  return {
    ok: true,
    receipt: createActivationMutationReceipt({
      operation: 'activate',
      grantId: grant.grantId,
      bindingIds: bindings.map(binding => binding.bindingId),
      disposition: 'committed',
      changedPaths: applied.writtenFiles,
    }),
    paths,
  };
}

/** Persist one revocation record. Revocation is deny-side and create-only. */
export function writeActivationRevocation(target, revocation) {
  const checked = validateActivationRevocation(revocation);
  if (!checked.ok) {
    return {
      ok: false,
      receipt: createActivationMutationReceipt({
        operation: 'revoke',
        grantId: revocation?.grantId ?? null,
        disposition: 'uncommitted',
        errors: checked.errors.map(item => item.message),
        recovery: 'No revocation was written. Repair the reported cause and rerun the revoke command.',
      }),
    };
  }
  let path;
  try {
    path = revocationRecordPath(revocation.revocationId);
  } catch (error) {
    return {
      ok: false,
      receipt: createActivationMutationReceipt({
        operation: 'revoke',
        grantId: revocation.grantId,
        disposition: 'uncommitted',
        errors: [error.message],
        recovery: 'No revocation was written. Repair the reported cause and rerun the revoke command.',
      }),
    };
  }
  const existing = digestOf(target, path);
  if (existing !== null) {
    return {
      ok: true,
      receipt: createActivationMutationReceipt({
        operation: 'revoke',
        grantId: revocation.grantId,
        disposition: 'already_current',
        changedPaths: [],
      }),
    };
  }
  const applied = executeMutationBatch(target, [{ type: 'create', path, content: serialize(revocation) }]);
  if (!applied.ok) {
    const rolledBack = applied.rollbackErrors.length === 0;
    return {
      ok: false,
      receipt: createActivationMutationReceipt({
        operation: 'revoke',
        grantId: revocation.grantId,
        disposition: rolledBack ? 'uncommitted' : 'unresolved',
        changedPaths: rolledBack ? [] : [path],
        errors: [...applied.errors, ...applied.rollbackErrors],
        recovery: rolledBack
          ? 'The grant was not revoked. Rerun the revoke command.'
          : `Rollback reported errors. Inspect ${path} before relying on the revocation.`,
      }),
    };
  }
  return {
    ok: true,
    receipt: createActivationMutationReceipt({
      operation: 'revoke',
      grantId: revocation.grantId,
      disposition: 'committed',
      changedPaths: applied.writtenFiles,
    }),
  };
}

/** Read one grant record by id. Never throws for a malformed document. */
export function readActivationGrant(target, grantId) {
  try {
    return readRecord(target, grantRecordPath(grantId));
  } catch (error) {
    return { ok: false, state: 'malformed', record: null, errors: [error.message], path: null };
  }
}

/** Read the current binding for one (backend, task) pair. */
export function readTaskActivationBinding(target, backend, taskId) {
  try {
    return readRecord(target, bindingRecordPath(backend, taskId));
  } catch (error) {
    return { ok: false, state: 'malformed', record: null, errors: [error.message], path: null };
  }
}

/**
 * Read every revocation record in the target.
 *
 * A malformed revocation document is returned as an error rather than skipped:
 * activation resolution treats an unreadable revocation as a revocation, so an
 * attacker cannot re-enable a grant by corrupting the record that revoked it.
 */
export function readActivationRevocations(target) {
  const directory = `${ACTIVATION_STORE_ROOT}/revocations`;
  let absolute;
  try {
    absolute = resolveTargetPath(target, directory);
  } catch (error) {
    return { ok: false, revocations: [], errors: [error.message] };
  }
  if (!existsSync(absolute)) return { ok: true, revocations: [], errors: [] };
  /** @type {any[]} */
  const revocations = [];
  /** @type {string[]} */
  const errors = [];
  for (const name of readdirSync(absolute).sort()) {
    if (!name.endsWith('.json')) continue;
    const read = readRecord(target, `${directory}/${name}`);
    if (!read.ok) {
      errors.push(...read.errors);
      // Preserve the fault as an unusable record so resolution fails closed.
      revocations.push({ kind: 'agenticloop.activation-revocation', malformedPath: `${directory}/${name}` });
      continue;
    }
    if (read.state === 'present') revocations.push(read.record);
  }
  return { ok: errors.length === 0, revocations, errors };
}

/** Enumerate every stored binding, newest activation state first by task id. */
export function listTaskActivationBindings(target) {
  const directory = `${ACTIVATION_STORE_ROOT}/bindings`;
  let absolute;
  try {
    absolute = resolveTargetPath(target, directory);
  } catch (error) {
    return { ok: false, bindings: [], errors: [error.message] };
  }
  if (!existsSync(absolute)) return { ok: true, bindings: [], errors: [] };
  /** @type {any[]} */
  const bindings = [];
  /** @type {string[]} */
  const errors = [];
  for (const name of readdirSync(absolute).sort()) {
    if (!name.endsWith('.json')) continue;
    const read = readRecord(target, `${directory}/${name}`);
    if (!read.ok) {
      errors.push(...read.errors);
      continue;
    }
    if (read.state === 'present') bindings.push({ path: read.path, record: read.record });
  }
  return { ok: errors.length === 0, bindings, errors };
}

/**
 * Digest of the exact human-readable scope summary an operator confirmed. The
 * grant carries this digest, never the raw text, so the durable record holds no
 * free-form operator input.
 */
export function activationScopeSummaryDigest(summaryText) {
  return `sha256:${createHash('sha256').update(String(summaryText ?? ''), 'utf8').digest('hex')}`;
}

/** Absolute path of the durable activation root, for diagnostics only. */
export function activationStoreDirectory(target) {
  return join(target, ...ACTIVATION_STORE_ROOT.split('/'));
}
