/**
 * Candidate artifact resolution and certified-product-tree comparison.
 *
 * Certification binds to the current product tree, not merely to matching
 * record fields:
 *
 * - `commit:<sha>` candidates resolve through Git to exactly one full commit;
 *   nonexistent or ambiguous references fail before record creation or
 *   rebaseline. Where Git cannot verify the reference (no work tree, no git
 *   binary), only an already-canonical full 40-hex SHA is accepted; a short
 *   or non-canonical value receives an explicit repair diagnostic instead of
 *   silent reinterpretation.
 * - After certification, closeout compares current state with the certified
 *   candidate. Only the bound audit record and explicitly enumerated
 *   non-product workflow metadata may change; every other changed, dirty, or
 *   untracked path is product drift (deny-by-default classification).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { classifyCloseoutPath, validateWorkflowDeltaContent } from './closeout-contract.js';
import { validateImprovementProposal } from './improvement.js';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHORTISH_SHA_PATTERN = /^[0-9a-f]{4,40}$/i;

function defaultGitRunner(args, options = {}) {
  return spawnSync('git', args, { encoding: 'utf-8', ...options });
}

function runGit(gitRunner, cwd, args) {
  const result = (gitRunner ?? defaultGitRunner)(args, { cwd, encoding: 'utf-8' });
  if (result?.error) {
    return { ok: false, error: result.error.message, status: null, stdout: '', stderr: '' };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stdoutRaw: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? '').trim(),
  };
}

/**
 * True when `target` sits inside a Git work tree Git can inspect.
 *
 * @param {string} target
 * @param {Function} [gitRunner]
 * @returns {boolean}
 */
export function isGitWorkTree(target, gitRunner) {
  const probe = runGit(gitRunner, target, ['rev-parse', '--is-inside-work-tree']);
  return probe.ok && probe.stdout === 'true';
}

/**
 * Resolve a candidate artifact to its canonical identity.
 *
 * @param {string} target   Repository/work-tree root used for Git resolution.
 * @param {string} artifact e.g. 'commit:<sha>' or another immutable reference.
 * @param {{ gitRunner?: Function }} [options]
 * @returns {{ ok: boolean, canonical?: string, error?: string, repair?: string, verified?: boolean }}
 */
export function resolveCandidateArtifact(target, artifact, options = {}) {
  const raw = String(artifact ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'candidate artifact is empty', repair: 'pass --artifact commit:<full-sha>' };
  }
  if (!raw.startsWith('commit:')) {
    // Non-git immutable references are stored verbatim; there is no resolver.
    return { ok: true, canonical: raw, verified: false };
  }
  const ref = raw.slice('commit:'.length).trim();
  if (!ref) {
    return { ok: false, error: 'commit candidate is missing a revision', repair: 'pass --artifact commit:<full-sha>' };
  }
  if (!SHORTISH_SHA_PATTERN.test(ref) && !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    return {
      ok: false,
      error: `commit candidate revision '${ref}' is not a plausible git revision`,
      repair: 'pass --artifact commit:<full-sha>',
    };
  }

  if (isGitWorkTree(target, options.gitRunner)) {
    const resolved = runGit(options.gitRunner, target, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!resolved.ok || !FULL_SHA_PATTERN.test(resolved.stdout)) {
      return {
        ok: false,
        error: `commit candidate '${ref}' does not resolve to exactly one commit in this repository`,
        repair: 'pass --artifact commit:<full-sha> naming an existing commit',
      };
    }
    // Ambiguity check: a short/sha-like prefix must name exactly one object.
    if (!FULL_SHA_PATTERN.test(ref)) {
      const objects = runGit(options.gitRunner, target, ['rev-parse', '--disambiguate', ref]);
      const matches = objects.ok ? objects.stdout.split(/\r?\n/).filter(Boolean) : [];
      if (matches.length !== 1) {
        return {
          ok: false,
          error: `commit candidate '${ref}' is ambiguous (${matches.length} matching objects)`,
          repair: 'pass --artifact commit:<full-sha> naming exactly one commit',
        };
      }
    }
    return { ok: true, canonical: `commit:${resolved.stdout}`, verified: true };
  }

  // No git verification is available. Only an already-canonical full SHA is
  // accepted; anything else gets an explicit repair diagnostic rather than a
  // silent reinterpretation.
  if (FULL_SHA_PATTERN.test(ref)) {
    return { ok: true, canonical: `commit:${ref}`, verified: false };
  }
  return {
    ok: false,
    error: `cannot resolve short commit candidate '${ref}' outside a git work tree`,
    repair: 'rerun inside the git work tree, or pass --artifact commit:<full-40-hex-sha>',
  };
}

/**
 * True when an artifact value is in canonical commit form (full 40-hex SHA).
 * Legacy non-canonical values receive migration diagnostics instead of silent
 * reinterpretation.
 *
 * @param {string} artifact
 * @returns {boolean}
 */
export function isCanonicalCommitArtifact(artifact) {
  const raw = String(artifact ?? '').trim();
  return raw.startsWith('commit:') && FULL_SHA_PATTERN.test(raw.slice('commit:'.length).trim());
}

/**
 * Compare the certified candidate with the current state of the checkout.
 *
 * Fails closed on:
 * - an unverifiable candidate (no git work tree / git failure);
 * - any product, plan, test, dependency, or implementation-configuration
 *   drift between the certified commit and HEAD;
 * - dirty or untracked product paths in the working tree.
 *
 * The bound audit-record write alone never recursively invalidates its own
 * certificate.
 *
 * @param {string} target
 * @param {object} params
 * @param {string} params.certifiedArtifact  canonical 'commit:<full-sha>'.
 * @param {string} [params.auditRecordRelPath] bound audit record (allowed delta).
 * @param {string} [params.markerCarrierRelPath] marker carrier (content-validated delta).
 * @param {string[]} [params.allowedWorkflowPaths] validated improvement proposal paths.
 * @param {string[]} [params.coveredTaskRelPaths] covered task records (content-validated delta).
 * @param {string[]} [params.eventLogRelPaths] applicable event logs (append-only delta).
 * @param {Function} [params.validateEvent] event schema validator for appended log records.
 * @param {Function} [params.gitRunner]
 * @returns {{ ok: boolean, state: string, drift: { path: string, classification: string, source: string }[], error?: string }}
 */
export function compareCertifiedProductTree(target, params) {
  const artifact = String(params?.certifiedArtifact ?? '').trim();
  const drift = [];
  if (!isCanonicalCommitArtifact(artifact)) {
    return {
      ok: false,
      state: 'candidate_unverifiable',
      drift,
      error: `certified artifact '${artifact || '(empty)'}' is not a canonical commit:<full-sha>; run audit baseline --canonicalize`,
    };
  }
  if (!isGitWorkTree(target, params?.gitRunner)) {
    return {
      ok: false,
      state: 'candidate_unverifiable',
      drift,
      error: 'cannot verify the certified product tree outside a git work tree',
    };
  }
  const sha = artifact.slice('commit:'.length);
  const exists = runGit(params?.gitRunner, target, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (!exists.ok) {
    return {
      ok: false,
      state: 'candidate_unresolvable',
      drift,
      error: `certified candidate ${artifact} no longer resolves in this repository`,
    };
  }

  const head = runGit(params?.gitRunner, target, ['rev-parse', 'HEAD']);
  if (!head.ok || !FULL_SHA_PATTERN.test(head.stdout)) {
    return {
      ok: false,
      state: 'candidate_unverifiable',
      drift,
      error: 'cannot resolve HEAD to compare with the certified candidate',
    };
  }

  const classifyOptions = {
    auditRecordRelPath: params?.auditRecordRelPath,
    markerCarrierRelPath: params?.markerCarrierRelPath,
    allowedWorkflowPaths: params?.allowedWorkflowPaths,
    coveredTaskRelPaths: params?.coveredTaskRelPaths,
    eventLogRelPaths: params?.eventLogRelPaths,
  };

  const gitShow = (ref, relPath) => {
    const result = runGit(params?.gitRunner, target, ['show', `${ref}:${relPath}`]);
    return result.ok ? result.stdoutRaw : null;
  };
  const workTreeContent = (relPath) => {
    const file = resolve(target, relPath);
    return existsSync(file) ? readFileSync(file, 'utf-8') : null;
  };
  // Content for one changed path at the two compared revisions. Committed
  // deltas compare the certified blob with the HEAD blob; dirty deltas
  // compare the HEAD blob with the working tree; untracked paths are adds.
  const contentAt = (relPath, source, side) => {
    if (source === 'committed') return gitShow(side === 'old' ? sha : 'HEAD', relPath);
    if (side === 'old') return source === 'untracked' ? null : gitShow('HEAD', relPath);
    return workTreeContent(relPath);
  };

  const classify = (path, source) => {
    const classification = classifyCloseoutPath(path, classifyOptions);
    if (classification === 'product') {
      drift.push({ path, classification, source });
      return;
    }
    if (classification === 'task_record' || classification === 'event_log') {
      const verdict = validateWorkflowDeltaContent(classification, {
        path,
        oldContent: contentAt(path, source, 'old'),
        newContent: contentAt(path, source, 'new'),
      }, {
        markerCarrierRelPath: params?.markerCarrierRelPath,
        validateEvent: params?.validateEvent,
      });
      if (!verdict.ok) {
        drift.push({ path, classification: 'product', source, error: verdict.error });
      }
      return;
    }
    if (classification === 'workflow_metadata') {
      // Exact referenced improvement proposals must themselves be valid;
      // scratch (`.agenticloop/tmp/`) content is transient and exempt.
      const normalized = String(path ?? '').replace(/\\/g, '/');
      if (/^\.agenticloop\/improvements\/[^/]+\.md$/.test(normalized)) {
        const content = contentAt(path, source, 'new');
        if (content == null) {
          drift.push({ path, classification: 'product', source, error: 'referenced improvement proposal was deleted after certification' });
          return;
        }
        const errors = validateImprovementProposal(content, normalized);
        if (errors.length > 0) {
          drift.push({ path, classification: 'product', source, error: `referenced improvement proposal is invalid: ${errors.join('; ')}` });
        }
      }
    }
  };

  const classifyRename = (paths, source) => {
    const endpoints = [...new Set(paths.map(path => String(path ?? '').trim()).filter(Boolean))];
    const classifications = endpoints.map(path => classifyCloseoutPath(path, classifyOptions));
    // A rename is one state transition. Moving product into workflow scratch
    // is still product drift, and both endpoints explain that transition.
    if (classifications.some(classification => classification === 'product')) {
      for (const path of endpoints) drift.push({ path, classification: 'product', source });
      return;
    }
    for (const path of endpoints) classify(path, source);
  };

  if (head.stdout !== sha) {
    const changed = runGit(params?.gitRunner, target, ['diff', '--name-status', '-z', sha, 'HEAD']);
    if (!changed.ok) {
      return {
        ok: false,
        state: 'candidate_unverifiable',
        drift,
        error: `cannot diff certified candidate against HEAD: ${changed.stderr || 'git diff failed'}`,
      };
    }
    for (const change of parseNameStatusZ(changed.stdoutRaw)) {
      if (change.paths.length > 1) classifyRename(change.paths, 'committed');
      else classify(change.paths[0], 'committed');
    }
  }

  const status = runGit(params?.gitRunner, target, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok && status.status !== 0) {
    return {
      ok: false,
      state: 'candidate_unverifiable',
      drift,
      error: `cannot inspect working-tree state: ${status.stderr || 'git status failed'}`,
    };
  }
  for (const change of parsePorcelainV1Z(status.stdoutRaw)) {
    if (change.paths.length > 1) classifyRename(change.paths, change.untracked ? 'untracked' : 'dirty');
    else classify(change.paths[0], change.untracked ? 'untracked' : 'dirty');
  }

  if (drift.length > 0) {
    return { ok: false, state: 'product_drift', drift };
  }
  return { ok: true, state: head.stdout === sha ? 'current' : 'current_with_workflow_metadata', drift };
}

/** Parse `git diff --name-status -z`; rename/copy records carry old then new. */
function parseNameStatusZ(raw) {
  const fields = String(raw ?? '').split('\0');
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      changes.push({ paths: [fields[index++] ?? '', fields[index++] ?? ''] });
    } else {
      changes.push({ paths: [fields[index++] ?? ''] });
    }
  }
  return changes;
}

/** Parse `git status --porcelain=v1 -z`; rename/copy records carry new then old. */
function parsePorcelainV1Z(raw) {
  const fields = String(raw ?? '').split('\0');
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const entry = fields[index++];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if ((code.includes('R') || code.includes('C')) && index < fields.length) {
      const original = fields[index++] ?? '';
      changes.push({ paths: [original, path], untracked: false });
    } else {
      changes.push({ paths: [path], untracked: code === '??' });
    }
  }
  return changes;
}
