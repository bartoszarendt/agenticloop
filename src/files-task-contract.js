/**
 * Committed append-only task-contract carriers for the files backend.
 *
 * Provenance model: the JSONL history is verified against first-parent Git
 * history. Every successive committed blob must be an exact byte-prefix
 * extension of the previous blob, and each appended line is bound to the
 * commit that introduced it (SHA, path, line index, Git author, timestamp).
 * When a merge touches the history path, the first-parent merge commit is
 * treated as the introducing carrier and its author is the bound author.
 *
 * This is committed Git provenance — evidence of which commit introduced a
 * line — not authenticated identity or signed authorship.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { relative, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FILES_TASK_CONTRACT_HISTORY_DIRECTORY } from './layout.js';
import { parseTaskContractRecords, validateTrustedTaskContractRecords } from './task-contract-baseline.js';
import { GIT_MAX_BUFFER } from './git-runner.js';

export function filesTaskContractHistoryPath(target, taskId) {
  return join(target, FILES_TASK_CONTRACT_HISTORY_DIRECTORY, `${taskId}.jsonl`);
}

export function appendFilesTaskContractRecord(target, record) {
  const path = filesTaskContractHistoryPath(target, record.taskId);
  mkdirSync(join(target, FILES_TASK_CONTRACT_HISTORY_DIRECTORY), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  return path;
}

function git(target, args) {
  // Ignore replace refs so provenance reads the repository's stored objects.
  return spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
}

const recordCache = new Map();
const RECORD_CACHE_MAX_ENTRIES = 256;

function cacheRecords(key, value) {
  while (recordCache.size >= RECORD_CACHE_MAX_ENTRIES) recordCache.delete(recordCache.keys().next().value);
  recordCache.set(key, structuredClone(value));
  return value;
}

function historyDigest(history) {
  return createHash('sha256').update(history, 'utf8').digest('hex');
}

function failure(path, errors, extra = {}) {
  return { trustedRecords: [], rejectedRecords: [], errors: Array.isArray(errors) ? errors : [errors], warnings: [], path, carriers: [], parseDiagnostics: [], ...extra };
}

/** Lines of a JSONL blob, requiring a final newline for every complete record. */
function completeJsonlLines(blob) {
  const text = String(blob ?? '');
  if (text === '') return { ok: true, lines: [] };
  if (!text.endsWith('\n')) return { ok: false, lines: [] };
  const lines = text.slice(0, -1).split('\n');
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, lines: [] };
    } catch {
      return { ok: false, lines: [] };
    }
  }
  return { ok: true, lines };
}

/**
 * Documented actor/author normalization rule: a record actor matches the
 * introducing commit when, after trimming and case-folding, it equals either
 * the Git author name (`%an`) or the full `Name <email>` identity.
 */
export function gitAuthorMatchesRecordActor(actor, { authorName, authorEmail }) {
  const candidate = String(actor ?? '').trim().toLowerCase();
  if (!candidate) return false;
  const name = String(authorName ?? '').trim().toLowerCase();
  const full = `${name} <${String(authorEmail ?? '').trim().toLowerCase()}>`;
  return candidate === name || candidate === full;
}

/** Load only the committed, append-only-verified version of the history carrier. */
export function loadFilesTaskContractRecords(target, taskId) {
  const path = filesTaskContractHistoryPath(target, taskId);
  const relativePath = relative(target, path).replace(/\\/g, '/');
  const state = git(target, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--', relativePath]);
  if (state.status !== 0) return failure(path, `cannot inspect git state for files task-contract history '${relativePath}'`);
  const stateLines = String(state.stdout ?? '').split(/\r?\n/).filter(Boolean);
  const headOid = stateLines.find(line => line.startsWith('# branch.oid '))?.slice('# branch.oid '.length) ?? null;
  if (!headOid || headOid === '(initial)') {
    // No commits yet: only a clean, absent history is trustworthy (empty).
    return existsSync(path)
      ? failure(path, `files task-contract history '${relativePath}' must be committed separately before it is trusted`)
      : { trustedRecords: [], rejectedRecords: [], errors: [], warnings: [], path, carriers: [], parseDiagnostics: [] };
  }
  if (stateLines.some(line => !line.startsWith('# '))) {
    return failure(path, `files task-contract history '${relativePath}' must be committed separately before it is trusted`);
  }
  const history = git(target, ['log', '--first-parent', '--format=%H%x00%an%x00%ae%x00%aI', '--', relativePath]);
  if (history.status !== 0) return failure(path, `cannot read first-parent history for files task-contract history '${relativePath}'`);
  const historyOutput = String(history.stdout ?? '');
  const cacheKey = `${resolve(target)}\0${taskId}\0${headOid}\0sha256:${historyDigest(historyOutput)}`;
  const cached = recordCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const commits = historyOutput.split('\n').filter(Boolean).map(line => {
    const [sha = '', authorName = '', authorEmail = '', timestamp = ''] = line.split('\0');
    return { sha, authorName, authorEmail, timestamp };
  }).reverse();
  if (commits.length === 0) {
    return cacheRecords(cacheKey, { trustedRecords: [], rejectedRecords: [], errors: [], warnings: [], path, carriers: [], parseDiagnostics: [] });
  }
  const headContent = git(target, ['show', `HEAD:${relativePath}`]);
  if (headContent.status !== 0) {
    return failure(path, `files task-contract history '${relativePath}' was deleted in committed history; append-only provenance forbids deletion`);
  }
  const carriers = [];
  let previous = null;
  let lineOffset = 0;
  for (const commit of commits) {
    const blobResult = git(target, ['show', `${commit.sha}:${relativePath}`]);
    if (blobResult.status !== 0) return failure(path, `cannot read committed blob for files task-contract history '${relativePath}' at commit ${commit.sha}`);
    const blob = String(blobResult.stdout ?? '');
    if (previous !== null) {
      if (!blob.startsWith(previous)) {
        return failure(path, `files task-contract history '${relativePath}' violates append-only provenance at commit ${commit.sha}: the previously committed content is not an exact prefix (a committed line was rewritten, replaced, truncated, or reordered)`);
      }
      const suffix = completeJsonlLines(blob.slice(previous.length));
      if (!suffix.ok) {
        return failure(path, `files task-contract history '${relativePath}' violates append-only provenance at commit ${commit.sha}: the appended content is not a sequence of complete newline-terminated JSONL records`);
      }
      for (const line of suffix.lines) {
        carriers.push(lineCarrier(commit, relativePath, lineOffset + 1, line));
        lineOffset += 1;
      }
    } else {
      const initial = completeJsonlLines(blob);
      if (!initial.ok) {
        return failure(path, `files task-contract history '${relativePath}' is not a sequence of complete newline-terminated JSONL records at its introducing commit ${commit.sha}`);
      }
      for (const line of initial.lines) {
        carriers.push(lineCarrier(commit, relativePath, lineOffset + 1, line));
        lineOffset += 1;
      }
    }
    previous = blob;
  }
  const parsed = parseTaskContractRecords(carriers.map(carrier => ({ ...carrier, body: `<!-- AGENTIC_LOOP_TASK_CONTRACT_RECORD\n${carrier.body}\n-->` })));
  const trust = validateTrustedTaskContractRecords(parsed.parsedRecords, { taskId });
  const errors = [...parsed.parseErrors, ...trust.errors];
  const trustedRecords = [];
  for (const record of trust.trustedRecords) {
    const provenance = record.carrier?.provenance ?? {};
    if (!gitAuthorMatchesRecordActor(record.actor, provenance)) {
      errors.push(`task-contract record '${String(record.recordId ?? 'unknown')}' actor '${String(record.actor ?? '')}' does not match introducing commit ${provenance.sha ?? 'unknown'} author '${provenance.authorName ?? 'unknown'}'`);
      trust.rejectedRecords.push({ record, carrier: record.carrier ?? null, state: 'trusted_but_invalid', errors: [errors[errors.length - 1]] });
      continue;
    }
    trustedRecords.push(record);
  }
  return cacheRecords(cacheKey, { trustedRecords, rejectedRecords: trust.rejectedRecords, errors, warnings: [...parsed.parseWarnings, ...trust.warnings], path, carriers, parseDiagnostics: parsed.parseDiagnostics });
}

function lineCarrier(commit, relativePath, lineIndex, body) {
  return {
    id: `commit:${commit.sha}:${relativePath}:${lineIndex}`,
    kind: 'files_task_contract_history',
    url: relativePath,
    author: commit.authorName,
    createdAt: commit.timestamp,
    updatedAt: commit.timestamp,
    edited: false,
    body,
    bodyDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
    verifiedAuthority: true,
    authorityState: 'trusted_immutable',
    provenance: {
      sha: commit.sha,
      path: relativePath,
      line: lineIndex,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      timestamp: commit.timestamp,
    },
  };
}
