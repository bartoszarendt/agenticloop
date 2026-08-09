/**
 * `agenticloop host-trust` - bounded provisioning and status for the operator
 * host trust store.
 *
 * The store lives outside the target repository, at a path derived from the
 * canonical repository identity. It pins the *public* half of a host adapter's
 * Ed25519 key together with the exact capabilities that adapter is trusted for.
 * Registering one is what makes hardened, `host_signed` activation and
 * `host_receipt` returns possible at all.
 *
 * Deliberate omissions:
 *
 * - There is no command that signs an activation capture, a handoff receipt, or
 *   any other payload with the protected host key. The toolkit never holds that
 *   key; an isolated signer does. A generic signing command would turn the
 *   whole hardened path into an oracle any local process could call.
 * - Registration accepts only a public key. A private key passed here is
 *   rejected rather than stored.
 * - Nothing here writes into the target repository.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, chmodSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { CliUsageError, EXIT_USAGE, createIo, resolveCliTarget } from './cli-io.js';
import { COMMAND_REGISTRY, parseCommandArgs, suggestName } from './cli-registry.js';
import { atomicWriteFile } from './fs-mutation-kernel.js';
import { commandFailure, printGateResult } from './public-result.js';
import {
  HOST_SIGNATURE_ALGORITHM,
  HOST_TRUST_AUTHORITY_SCHEMA_VERSION,
  HOST_TRUST_KIND,
  defaultOperatorTrustRoot,
  importPublicKey,
  operatorTrustStorePath,
  parseHostTrustStore,
  targetRepositoryIdentity,
} from './host-trust.js';
import {
  VerificationContextError,
  VerificationContextMalformedError,
} from './public-error.js';
import { resolveEffectiveActivationPolicy } from './activation-resolution.js';

const HOST_TRUST_SUBCOMMANDS = ['status', 'register', 'rotate', 'revoke'];
const CAPABILITY_STATES = ['supported', 'unsupported'];

function canonicalPath(path) {
  const resolved = resolve(String(path));
  if (!existsSync(resolved)) return resolved;
  const nativeRealpath = realpathSync.native ?? realpathSync;
  return nativeRealpath(resolved);
}

function outsideTarget(target, path) {
  const fromTarget = relative(canonicalPath(target), canonicalPath(path));
  return Boolean(fromTarget) && (fromTarget.startsWith('..') || isAbsolute(fromTarget));
}

/**
 * Resolve the one trust-store path permitted for this target, refusing a root
 * that is not absolute or that resolves inside the repository.
 */
function resolveStorePath(target, io) {
  const root = io?.operatorTrustRoot ?? defaultOperatorTrustRoot();
  if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) {
    throw new VerificationContextMalformedError('operator host trust root must be an absolute path');
  }
  if (!outsideTarget(target, root)) {
    throw new VerificationContextMalformedError('operator host trust root must be outside the target repository');
  }
  return { root: canonicalPath(root), path: operatorTrustStorePath(target, root) };
}

function readStoreDocument(target, path) {
  if (!existsSync(path)) {
    return {
      kind: HOST_TRUST_KIND,
      schemaVersion: HOST_TRUST_AUTHORITY_SCHEMA_VERSION,
      target: { repositoryIdentity: targetRepositoryIdentity(target) },
      adapters: [],
      authorities: [],
    };
  }
  if (lstatSync(path).isSymbolicLink()) {
    throw new VerificationContextMalformedError('host trust store must not be a symbolic link');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new VerificationContextMalformedError(`host trust store is unreadable or invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VerificationContextMalformedError('host trust store must be a JSON object');
  }
  // A store bound to another checkout is never edited in place.
  const expected = targetRepositoryIdentity(target);
  if (parsed.target?.repositoryIdentity !== expected) {
    throw new VerificationContextMalformedError('host trust store target does not match this repository');
  }
  return {
    ...parsed,
    schemaVersion: HOST_TRUST_AUTHORITY_SCHEMA_VERSION,
    adapters: Array.isArray(parsed.adapters) ? parsed.adapters : [],
    authorities: Array.isArray(parsed.authorities) ? parsed.authorities : [],
  };
}

/**
 * Validate one prospective document by parsing it through the same reader every
 * consumer uses. A document that would not load is never written.
 */
function assertLoadable(document, target) {
  const parsed = parseHostTrustStore(JSON.stringify(document), { target });
  if (!parsed.ok) {
    throw new VerificationContextMalformedError(
      `the resulting host trust store would be invalid: ${parsed.errors.join('; ')}`
    );
  }
  return parsed;
}

function writeStore(path, document) {
  const directory = resolve(path, '..');
  mkdirSync(directory, { recursive: true });
  if (process.platform !== 'win32') {
    try { chmodSync(directory, 0o700); } catch { /* reported, never claimed */ }
  }
  atomicWriteFile(path, `${JSON.stringify(document, null, 2)}\n`);
  if (process.platform !== 'win32') {
    try { chmodSync(path, 0o600); } catch { /* reported, never claimed */ }
  }
}

function readPublicKeyMaterial(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new CliUsageError('--public-key is required');
  const material = existsSync(text) ? readFileSync(text, 'utf8').trim() : text;
  if (/PRIVATE KEY/.test(material)) {
    throw new VerificationContextError(
      'host trust registration accepts only a public key; the private half must stay with the isolated signer and is never stored here'
    );
  }
  try {
    // Accept base64 SPKI DER, which is exactly what every consumer expects.
    importPublicKey(material.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  } catch (error) {
    throw new VerificationContextMalformedError(`--public-key is not a valid Ed25519 public key: ${error.message}`);
  }
  return material.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
}

function capabilityValue(option, name) {
  const value = String(option ?? 'unsupported').trim();
  if (!CAPABILITY_STATES.includes(value)) {
    throw new CliUsageError(`--${name} must be one of: ${CAPABILITY_STATES.join(', ')}`);
  }
  return value;
}

/** The `host-trust` command family: status, register, rotate, and revoke. */
export async function cmdHostTrust(args, io = createIo()) {
  const sub = args[0];
  const spec = COMMAND_REGISTRY['host-trust'].subcommands;
  if (!sub || !spec[sub]) {
    const suggestion = sub ? suggestName(sub, HOST_TRUST_SUBCOMMANDS) : null;
    io.err(suggestion
      ? `host-trust: unknown subcommand '${sub}'. Did you mean '${suggestion}'?`
      : `host-trust requires a subcommand: ${HOST_TRUST_SUBCOMMANDS.join(', ')}.`);
    io.err('Run "agenticloop help host-trust" for usage.');
    return EXIT_USAGE;
  }
  const { opts, positional } = parseCommandArgs(`host-trust ${sub}`, spec[sub], args.slice(1));
  const target = resolveCliTarget(io, opts.target);
  const asJson = Boolean(opts.json);
  const command = `host-trust ${sub}`;

  try {
    const { path } = resolveStorePath(target, io);
    const document = readStoreDocument(target, path);

    if (sub === 'status') {
      const parsed = existsSync(path) ? parseHostTrustStore(readFileSync(path, 'utf8'), { target }) : null;
      const policy = resolveEffectiveActivationPolicy(target, io);
      const report = {
        command,
        repositoryIdentity: targetRepositoryIdentity(target),
        storePath: path,
        present: existsSync(path),
        valid: parsed ? parsed.ok : true,
        errors: parsed ? parsed.errors : [],
        adapters: Object.values(parsed?.adapters ?? {}).map(adapter => ({
          adapterId: adapter.adapterId,
          keyId: adapter.keyId,
          algorithm: adapter.algorithm,
          capabilities: adapter.capabilities,
        })),
        authorities: Object.values(parsed?.authorities ?? {}).map(authority => ({
          authorityId: authority.authorityId,
          authorityKind: authority.authorityKind,
          keyId: authority.keyId,
          revokedRecordIds: authority.revokedRecordIds,
        })),
        policy: {
          mode: policy.mode,
          source: policy.source,
          minimumActivation: policy.minimumActivation,
          minimumReturn: policy.minimumReturn,
        },
        note:
          'A registered adapter can only be used through an authenticated out-of-process host boundary. ' +
          'This command never signs an activation capture or a return receipt; the private key stays with the isolated signer.',
      };
      if (asJson) io.out(JSON.stringify(report, null, 2));
      else {
        io.out(`Host trust for ${report.repositoryIdentity}`);
        io.out(`  store: ${path}${report.present ? '' : ' (absent)'}`);
        io.out(`  valid: ${report.valid}`);
        for (const error of report.errors) io.err(`  ERROR: ${error}`);
        io.out(`  activation policy: ${policy.mode} (source: ${policy.source})`);
        if (report.adapters.length === 0) io.out('  adapters: none pinned');
        for (const adapter of report.adapters) {
          io.out(`  adapter ${adapter.adapterId} key=${adapter.keyId} activationCapture=${adapter.capabilities.activationCapture} returnReceipt=${adapter.capabilities.returnReceipt}`);
        }
        for (const authority of report.authorities) {
          io.out(`  authority ${authority.authorityId} (${authority.authorityKind}) key=${authority.keyId} revoked=${authority.revokedRecordIds.length}`);
        }
        io.out(`  ${report.note}`);
      }
      return report.valid ? 0 : 1;
    }

    if (sub === 'register' || sub === 'rotate') {
      const adapterId = positional[0];
      if (!adapterId) throw new CliUsageError(`host-trust ${sub} requires the exact adapter id`);
      if (!opts.keyId) throw new CliUsageError(`host-trust ${sub} requires --key-id`);
      const publicKey = readPublicKeyMaterial(opts.publicKey);
      const existingIndex = document.adapters.findIndex(entry => entry?.adapterId === adapterId);
      if (sub === 'register' && existingIndex !== -1) {
        throw new VerificationContextError(
          `adapter '${adapterId}' is already registered; use 'agenticloop host-trust rotate' to replace its key`
        );
      }
      if (sub === 'rotate' && existingIndex === -1) {
        throw new VerificationContextError(`adapter '${adapterId}' is not registered; use 'agenticloop host-trust register' first`);
      }
      const entry = {
        adapterId,
        keyId: String(opts.keyId),
        algorithm: HOST_SIGNATURE_ALGORITHM,
        publicKey,
        capabilities: {
          activationCapture: capabilityValue(opts.activationCapture, 'activation-capture'),
          returnReceipt: capabilityValue(opts.returnReceipt, 'return-receipt'),
        },
      };
      const adapters = existingIndex === -1
        ? [...document.adapters, entry]
        : document.adapters.map((item, index) => (index === existingIndex ? entry : item));
      const candidate = { ...document, adapters };
      assertLoadable(candidate, target);
      if (opts.dryRun) {
        const report = { command, dryRun: true, storePath: path, adapter: entry };
        if (asJson) io.out(JSON.stringify(report, null, 2));
        else {
          io.out(`Dry run: would ${sub} adapter ${adapterId} in ${path}`);
          io.out(`  activationCapture=${entry.capabilities.activationCapture} returnReceipt=${entry.capabilities.returnReceipt}`);
        }
        return 0;
      }
      writeStore(path, candidate);
      const report = { command, storePath: path, adapter: entry, rotated: sub === 'rotate' };
      if (asJson) io.out(JSON.stringify(report, null, 2));
      else {
        io.out(`${sub === 'rotate' ? 'Rotated' : 'Registered'} host adapter ${adapterId} in ${path}.`);
        io.out(`  activationCapture=${entry.capabilities.activationCapture} returnReceipt=${entry.capabilities.returnReceipt}`);
        io.out('  A supported capability is only usable through an authenticated out-of-process host boundary.');
      }
      return 0;
    }

    if (sub === 'revoke') {
      const adapterId = positional[0];
      if (!adapterId) throw new CliUsageError('host-trust revoke requires the exact adapter id');
      const existingIndex = document.adapters.findIndex(entry => entry?.adapterId === adapterId);
      if (existingIndex === -1) {
        throw new VerificationContextError(`adapter '${adapterId}' is not registered`);
      }
      const candidate = { ...document, adapters: document.adapters.filter((_, index) => index !== existingIndex) };
      assertLoadable(candidate, target);
      if (opts.dryRun) {
        if (asJson) io.out(JSON.stringify({ command, dryRun: true, storePath: path, adapterId }, null, 2));
        else io.out(`Dry run: would revoke adapter ${adapterId} in ${path}`);
        return 0;
      }
      writeStore(path, candidate);
      if (asJson) io.out(JSON.stringify({ command, storePath: path, adapterId, revoked: true }, null, 2));
      else {
        io.out(`Revoked host adapter ${adapterId} from ${path}.`);
        io.out('  Every capture and receipt signed by its key now fails authentication.');
      }
      return 0;
    }

    throw new CliUsageError(`host-trust: unknown subcommand '${sub}'`);
  } catch (error) {
    if (error instanceof CliUsageError) {
      return printGateResult(command, commandFailure(command, error, 'usage', {}, target), asJson, io, EXIT_USAGE);
    }
    return printGateResult(command, commandFailure(command, error, 'operational_error', {}, target), asJson, io);
  }
}
