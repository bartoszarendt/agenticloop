/**
 * Read-only compatibility classification for persisted lifecycle evidence.
 *
 * Every non-current version is a resumable incompatibility. There is no
 * guarded migration implementation yet, so no record may be called
 * "migratable" merely because its version is known.
 */

import { DISPATCH_CONSUMPTION_SCHEMA_VERSION } from './handoff-consumption.js';
import { TASK_CARRIER_MUTATION_RECEIPT_SCHEMA_VERSION } from './task-evidence-contract.js';
import { RETURN_VERIFICATION_SCHEMA_VERSION } from './return-verification.js';
import { DISPATCH_PREPARATION_SCHEMA_VERSION } from './dispatch-envelope.js';

export const LIFECYCLE_COMPATIBILITY_SCHEMA_VERSION = 1;

// Resolve imported bindings only when a record is classified. This preserves
// canonical derivation while allowing the readers of these records to import
// this classifier without an ESM initialization cycle.
function currentVersions() {
  return {
    'agenticloop.dispatch-consumption': DISPATCH_CONSUMPTION_SCHEMA_VERSION,
    // Records persisted below handoffs/task-mutations are role-owned carrier
    // receipts. Their v3 contract is deliberately distinct from historical v2
    // publication/readiness mutation receipts with the same kind string.
    'agenticloop.task-mutation-receipt': TASK_CARRIER_MUTATION_RECEIPT_SCHEMA_VERSION,
    'agenticloop.return-verification': RETURN_VERIFICATION_SCHEMA_VERSION,
    'agenticloop.dispatch-preparation': DISPATCH_PREPARATION_SCHEMA_VERSION,
  };
}

/** Classify a persisted lifecycle record without changing it. */
export function classifyLifecycleCompatibility(record, expectedKind = null) {
  const kind = typeof record?.kind === 'string' ? record.kind : expectedKind;
  const version = record?.schemaVersion;
  const current = currentVersions()[kind];
  if (!kind || current === undefined || (expectedKind !== null && kind !== expectedKind)) {
    return Object.freeze({
      kind: 'agenticloop.lifecycle-compatibility', schemaVersion: LIFECYCLE_COMPATIBILITY_SCHEMA_VERSION,
      state: 'incompatible', route: 'resume_with_current_evidence', reason: 'unknown_kind', observedVersion: version ?? null,
    });
  }
  if (!Number.isSafeInteger(version)) {
    return Object.freeze({
      kind: 'agenticloop.lifecycle-compatibility', schemaVersion: LIFECYCLE_COMPATIBILITY_SCHEMA_VERSION,
      state: 'incompatible', route: 'resume_with_current_evidence', reason: 'malformed_version', observedVersion: version ?? null,
    });
  }
  if (version === current) {
    return Object.freeze({
      kind: 'agenticloop.lifecycle-compatibility', schemaVersion: LIFECYCLE_COMPATIBILITY_SCHEMA_VERSION,
      state: 'current', route: null, reason: null, observedVersion: version,
    });
  }
  return Object.freeze({
    kind: 'agenticloop.lifecycle-compatibility', schemaVersion: LIFECYCLE_COMPATIBILITY_SCHEMA_VERSION,
    state: 'incompatible', route: 'resume_with_current_evidence',
    reason: version > current ? 'unsupported_new_version' : 'unsupported_legacy_version', observedVersion: version,
  });
}

export function compatibilityMessage(result, label = 'lifecycle record') {
  return `${label} has ${result.reason} schemaVersion ${String(result.observedVersion)}; resume with current evidence`;
}

/** Enumerate persisted lifecycle evidence without mutating or reserializing it. */
export function diagnoseLifecycleCompatibility(target) {
  const { existsSync, readdirSync, readFileSync } = requireFs();
  const { join, relative } = requirePath();
  const roots = [
    ['.agenticloop/handoffs/dispatch', 'agenticloop.dispatch-consumption'],
    ['.agenticloop/handoffs/task-mutations', 'agenticloop.task-mutation-receipt'],
    ['.agenticloop/returns/verifications', 'agenticloop.return-verification'],
  ];
  const findings = [];
  const visit = (directory, expectedKind) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, expectedKind);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const display = relative(target, path).replaceAll('\\', '/');
        try {
          const classification = classifyLifecycleCompatibility(JSON.parse(readFileSync(path, 'utf8')), expectedKind);
          if (classification.state !== 'current') findings.push({ path: display, ...classification });
        } catch (error) {
          findings.push({ path: display, kind: 'agenticloop.lifecycle-compatibility', schemaVersion: LIFECYCLE_COMPATIBILITY_SCHEMA_VERSION, state: 'incompatible', route: 'resume_with_current_evidence', reason: 'unreadable_record', observedVersion: null, error: error.message });
        }
      }
    }
  };
  for (const [root, kind] of roots) visit(join(target, ...root.split('/')), kind);
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

// Node builtins are loaded lazily so this pure classifier stays browser-testable.
function requireFs() { return globalThis.process.getBuiltinModule('node:fs'); }
function requirePath() { return globalThis.process.getBuiltinModule('node:path'); }
