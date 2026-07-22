import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const SUPERVISION_STATE_VERSION = 2;
export const SUPERVISION_STATE_RELATIVE_ROOT = '.agenticloop/state/supervision';

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function assertRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(runId ?? '')) {
    throw new Error('supervision run id must be a safe identifier');
  }
}

export function createRunId() {
  return `sup-${randomUUID()}`;
}

export function supervisionPaths(projectRoot, runId) {
  assertRunId(runId);
  const resolvedProjectRoot = resolve(projectRoot);
  const root = resolve(resolvedProjectRoot, SUPERVISION_STATE_RELATIVE_ROOT);
  const runDirectory = join(root, runId);
  const projectKey = createHash('sha256').update(resolvedProjectRoot).digest('hex').slice(0, 32);
  return {
    root,
    runDirectory,
    state: join(runDirectory, 'state.json'),
    // Keep the bearer secret outside the target project so repository content
    // and ordinary project-scoped agent reads cannot disclose operator access.
    credential: join(tmpdir(), 'agenticloop-supervision', projectKey, runId, '.credential'),
    index: join(root, 'index.json'),
    // Attached MVP permits one live controller per project. This is stricter
    // than per-unit ownership and prevents two roots from mutating the same
    // durable workflow state while unit-level collision proof is unavailable.
    lock: join(root, 'locks', 'controller.lock'),
  };
}

export function atomicWriteJson(path, value) {
  ensureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function writeRunState(projectRoot, state) {
  if (state?.schema_version !== SUPERVISION_STATE_VERSION) throw new Error('invalid supervision state schema version');
  const paths = supervisionPaths(projectRoot, state.controller.run_id);
  atomicWriteJson(paths.state, state);
  atomicWriteJson(paths.index, {
    schema_version: SUPERVISION_STATE_VERSION,
    active_runs: state.controller.status === 'stopped' ? [] : [state.controller.run_id],
    updated_at: state.controller.updated_at,
  });
  return paths;
}

export function readRunState(projectRoot, runId) {
  const paths = supervisionPaths(projectRoot, runId);
  if (!existsSync(paths.state)) throw new Error(`supervision state not found for run ${runId}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(paths.state, 'utf8'));
  } catch (error) {
    throw new Error(`supervision state is malformed: ${error.message}`);
  }
  if (parsed?.schema_version !== SUPERVISION_STATE_VERSION) {
    throw new Error(`unsupported supervision state schema version ${parsed?.schema_version}`);
  }
  if (parsed?.controller?.run_id !== runId) throw new Error('supervision state run binding does not match its path');
  return { state: parsed, paths };
}

export function resolveSingleActiveRun(projectRoot) {
  const root = resolve(projectRoot, SUPERVISION_STATE_RELATIVE_ROOT);
  const index = join(root, 'index.json');
  if (!existsSync(index)) throw new Error('no active supervision controller found');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(index, 'utf8'));
  } catch (error) {
    throw new Error(`supervision index is malformed: ${error.message}`);
  }
  const runs = parsed?.active_runs;
  if (!Array.isArray(runs) || runs.length !== 1 || typeof runs[0] !== 'string') {
    throw new Error('supervision controller selection is ambiguous; specify an exact run id');
  }
  return runs[0];
}

export function writeCredential(projectRoot, runId, credential) {
  if (typeof credential !== 'string' || credential.length < 32) throw new Error('invalid supervision credential');
  const paths = supervisionPaths(projectRoot, runId);
  ensureDirectory(dirname(paths.credential));
  writeFileSync(paths.credential, credential, { encoding: 'utf8', mode: 0o600 });
}

export function readCredential(projectRoot, runId) {
  const paths = supervisionPaths(projectRoot, runId);
  if (!existsSync(paths.credential)) throw new Error('supervision local credential is unavailable');
  return readFileSync(paths.credential, 'utf8').trim();
}

export function removeCredential(projectRoot, runId) {
  const paths = supervisionPaths(projectRoot, runId);
  if (!existsSync(paths.credential)) return false;
  rmSync(paths.credential, { force: true });
  return true;
}

export const PID_REUSE_REMEDIATION =
  'The recorded controller PID is live or its identity cannot be verified. A reused PID can strand this lock until an operator reconciles it; '
  + 'delete the lock only after confirming no supervision controller owns this project.';

/**
 * A lock is released only by its owner or when an injected verifier proves the
 * old owner is gone. Age alone is never enough to steal a live PID on Windows.
 *
 * Known limitation, deliberately not papered over: the lock records a
 * `process_instance` token, but no cross-platform, verifiable process *birth*
 * identity is available here, so staleness is still decided by PID liveness
 * alone. If the operating system reuses a dead controller's PID, this refuses
 * takeover and reports `pid_reused_or_owner_unverified`. That is fail-closed:
 * the lock may need operator reconciliation, but no live process is ever stolen
 * from or terminated, and no weak process identity is invented to guess.
 */
export function acquireOwnershipLock(projectRoot, runId, owner, { verifyStaleOwner = () => false } = {}) {
  const paths = supervisionPaths(projectRoot, runId);
  ensureDirectory(dirname(paths.lock));
  const payload = { ...owner, run_id: runId, project_root: resolve(projectRoot), issued_at: new Date().toISOString() };
  try {
    const descriptor = openSync(paths.lock, 'wx', 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(payload));
    } finally {
      closeSync(descriptor);
    }
    return { acquired: true, lock: payload };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  let existing;
  try {
    existing = JSON.parse(readFileSync(paths.lock, 'utf8'));
  } catch {
    return { acquired: false, reason: 'existing_lock_is_unreadable' };
  }
  // Reuse requires the exact owner id *and* the exact process instance token, so
  // a different controller that happens to reconstruct an owner id cannot adopt
  // a live lock.
  if (existing.owner_id === owner.owner_id
    && existing.project_root === resolve(projectRoot)
    && (existing.process_instance === undefined || existing.process_instance === owner.process_instance)) {
    return { acquired: true, reused: true, lock: existing };
  }
  if (!verifyStaleOwner(existing)) {
    return {
      acquired: false,
      reason: 'pid_reused_or_owner_unverified',
      remediation: PID_REUSE_REMEDIATION,
      lock: { owner_id: existing.owner_id, pid: existing.pid, run_id: existing.run_id, issued_at: existing.issued_at },
    };
  }
  try {
    removeCredential(projectRoot, existing.run_id);
  } catch {
    // A malformed stale owner must not let an untrusted path influence cleanup.
  }
  rmSync(paths.lock, { force: true });
  return acquireOwnershipLock(projectRoot, runId, owner, { verifyStaleOwner });
}

/**
 * Owner-bound release. When the lock records a `process_instance`, the caller
 * must supply the identical token: an owner id alone is not proof of ownership.
 */
export function releaseOwnershipLock(projectRoot, runId, ownerId, processInstance = undefined) {
  const paths = supervisionPaths(projectRoot, runId);
  if (!existsSync(paths.lock)) return false;
  let lock;
  try {
    lock = JSON.parse(readFileSync(paths.lock, 'utf8'));
  } catch {
    return false;
  }
  if (lock.owner_id !== ownerId) return false;
  if (lock.process_instance !== undefined && processInstance !== undefined && lock.process_instance !== processInstance) return false;
  rmSync(paths.lock, { force: true });
  return true;
}
