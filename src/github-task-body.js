/** Guarded, offline-testable GitHub task-body fetch/lint/apply operations. */

import { createHash, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import { parseFrontmatterStrict } from './frontmatter.js';
import { markdownSection } from './markdown.js';
import { resolveGitHubTaskIdentityStrict } from './github-task-identity.js';
import { validateTaskRecord } from './validate-config.js';
import { evaluateTaskReadiness, parseTaskReadinessDeclaration } from './task-readiness.js';
import { deriveTaskContractLifecycle, hasTaskContractRecordMarker, parseTaskContractRecords, taskContractDigest, validateTaskContractBaseline, validateTrustedTaskContractRecords } from './task-contract-baseline.js';
import { parseAttemptBudget, parseReviewBudget } from './github-preflight.js';
import { createDiagnostic } from './repair-policy.js';
import { normalizeGitHubCommentCarriers } from './github-comment-carrier.js';
import { resolveTrustedTaskContractActors } from './trusted-actors.js';

const BODY_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export class GitHubTaskBodyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHubTaskBodyError';
  }
}

export function taskBodyDigest(body) {
  return `sha256:${createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex')}`;
}

function issueNumber(issue) {
  const number = Number(issue);
  if (!Number.isInteger(number) || number <= 0) throw new GitHubTaskBodyError('--issue must be a positive integer');
  return number;
}

function runGhJson(commandRunner, args) {
  const result = commandRunner('gh', args, { encoding: 'utf8' });
  if (result?.error) throw new GitHubTaskBodyError(`failed to run 'gh ${args.join(' ')}': ${result.error.message}`);
  if (result?.status !== 0) {
    throw new GitHubTaskBodyError(`'gh ${args.join(' ')}' failed: ${(result?.stderr ?? result?.stdout ?? `exit ${result?.status}`).trim()}`);
  }
  try {
    return JSON.parse(String(result?.stdout ?? ''));
  } catch {
    throw new GitHubTaskBodyError(`'gh ${args.join(' ')}' returned invalid JSON`);
  }
}

function runGh(commandRunner, args) {
  const result = commandRunner('gh', args, { encoding: 'utf8' });
  if (result?.error) throw new GitHubTaskBodyError(`failed to run 'gh ${args.join(' ')}': ${result.error.message}`);
  if (result?.status !== 0) {
    throw new GitHubTaskBodyError(`'gh ${args.join(' ')}' failed: ${(result?.stderr ?? result?.stdout ?? `exit ${result?.status}`).trim()}`);
  }
}

function configuredTrustedActors(projectMapConfig) {
  const resolved = resolveTrustedTaskContractActors(projectMapConfig);
  if (resolved.errors.length) throw new GitHubTaskBodyError(resolved.errors.join('; '));
  return resolved;
}

function githubRepository(commandRunner, repo) {
  if (repo) return repo;
  const data = runGhJson(commandRunner, ['repo', 'view', '--json', 'nameWithOwner']);
  const name = String(data?.nameWithOwner ?? '').trim();
  if (!name) throw new GitHubTaskBodyError('cannot resolve the current GitHub repository for paginated issue comments');
  return name;
}

function fetchAllGitHubIssueComments(commandRunner, repo, issue) {
  const ownerName = githubRepository(commandRunner, repo);
  const data = runGhJson(commandRunner, ['api', '--paginate', '--slurp', `repos/${ownerName}/issues/${issue}/comments`]);
  if (!Array.isArray(data)) throw new GitHubTaskBodyError('GitHub issue-comment pagination returned an invalid collection');
  return data.flatMap(page => Array.isArray(page) ? page : []);
}

export function fetchGitHubTaskBody({ issue, repo, commandRunner, projectMapConfig = null }) {
  const number = issueNumber(issue);
  const args = ['issue', 'view', String(number), '--json', 'body,number'];
  if (repo) args.push('--repo', repo);
  const data = runGhJson(commandRunner, args);
  if (!data || typeof data.body !== 'string') throw new GitHubTaskBodyError(`issue #${number} has no readable body`);
  const trustConfig = configuredTrustedActors(projectMapConfig);
  const comments = fetchAllGitHubIssueComments(commandRunner, repo, number);
  const carriers = normalizeGitHubCommentCarriers(comments, { trustedActors: trustConfig.actors });
  const parsed = parseTaskContractRecords(carriers);
  const taskId = taskContractDigest(data.body).projection?.task_id;
  const trust = validateTrustedTaskContractRecords(parsed.parsedRecords, { taskId, trustedActors: trustConfig.actors });
  return {
    issue: Number(data.number ?? number),
    body: data.body,
    digest: taskBodyDigest(data.body),
    comments,
    carriers,
    parsedRecords: parsed.parsedRecords,
    parseDiagnostics: parsed.parseDiagnostics,
    parseErrors: parsed.parseErrors,
    trustedRecords: trust.trustedRecords,
    rejectedRecords: trust.rejectedRecords,
    trustedRecordErrors: [...parsed.parseErrors, ...trust.errors],
    warnings: [...trustConfig.warnings, ...parsed.parseWarnings, ...trust.warnings],
  };
}

export function atomicWriteUtf8(filePath, content, fs = nodeFs) {
  const text = String(content ?? '');
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve primary failure */ }
    throw error;
  }
}

function rawFrontmatterLines(body) {
  const normalized = String(body ?? '').startsWith('\uFEFF') ? String(body).slice(1) : String(body ?? '');
  const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match?.[1]?.split(/\r?\n/) ?? [];
}

/** Make one bounded top-level frontmatter field mutation without reformatting the body. */
export function setTaskBodyFrontmatterField(body, field, value) {
  const text = String(body ?? '');
  const parsed = parseFrontmatterStrict(text);
  if (parsed.state !== 'valid') throw new GitHubTaskBodyError(`cannot set task field: frontmatter is ${parsed.state}${parsed.reason ? ` (${parsed.reason})` : ''}`);
  const name = String(field ?? '').trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new GitHubTaskBodyError('task-body set-field requires a simple frontmatter field name');
  if (String(value ?? '').includes('\n') || String(value ?? '').includes('\r')) throw new GitHubTaskBodyError('task-body set-field value must be one line');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const opening = text.match(/^(?:\uFEFF)?---[ \t]*\r?\n/);
  if (!opening) throw new GitHubTaskBodyError('cannot find task frontmatter opening delimiter');
  const close = /\r?\n---[ \t]*(?=\r?\n|$)/g;
  close.lastIndex = opening[0].length;
  const closing = close.exec(text);
  if (!closing) throw new GitHubTaskBodyError('cannot find task frontmatter closing delimiter');
  const frontmatter = text.slice(opening[0].length, closing.index);
  const lines = frontmatter.split(/\r?\n/);
  const matches = lines.map((line, index) => ({ line, index })).filter(item => new RegExp(`^${name}:`).test(item.line));
  if (matches.length > 1) throw new GitHubTaskBodyError(`cannot set duplicate frontmatter field '${name}'`);
  const rendered = `${name}: ${JSON.stringify(String(value ?? ''))}`;
  if (matches.length === 1) lines[matches[0].index] = rendered;
  else lines.push(rendered);
  const candidate = `${text.slice(0, opening[0].length)}${lines.join(eol)}${text.slice(closing.index)}`;
  return { body: candidate, changed: text !== candidate, field: name };
}

function duplicateFrontmatterFields(body) {
  const counts = new Map();
  for (const line of rawFrontmatterLines(body)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):/);
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([key]) => key).sort();
}

function diagnostic(code, { message = null, evidence = {}, level = 'error' } = {}) {
  return createDiagnostic({ code, message, evidence, level });
}

/** Strict, offline task-record validation for a GitHub issue body. */
export function lintGitHubTaskBody({
  issue,
  body,
  basePaths,
  projectMapConfig = null,
  trustedRecords = [],
  trustedRecordErrors = [],
  prospectiveRecords = [],
  currentBody = null,
  lifecycle = 'legacy',
} = {}) {
  const number = issueNumber(issue);
  const text = String(body ?? '');
  const diagnostics = [];
  if (hasTaskContractRecordMarker(text)) diagnostics.push(diagnostic('contract.record_marker.mutable_body'));
  if (text.startsWith('\uFEFF')) diagnostics.push(diagnostic('task.body.bom'));
  const parsed = parseFrontmatterStrict(text);
  if (parsed.state !== 'valid') {
    diagnostics.push(diagnostic(parsed.state === 'malformed' ? 'task.contract.malformed' : 'task.contract.absent', {
      evidence: { reason: parsed.reason },
    }));
  }
  for (const key of duplicateFrontmatterFields(text)) {
    diagnostics.push(diagnostic('task.body.invalid', { message: `duplicate frontmatter field '${key}'`, evidence: { field: key } }));
  }
  const identity = resolveGitHubTaskIdentityStrict({ number, body: text });
  if (!identity.ok) diagnostics.push(diagnostic('task.body.identity', { message: identity.diagnostic.message }));
  if (!identity.identity) diagnostics.push(diagnostic('task.body.identity', { message: 'GitHub task record requires a non-empty frontmatter task_id; legacy issue identity is read-only compatibility only' }));

  if (parsed.state === 'valid') {
    const frontmatter = parsed.data;
    if (String(frontmatter.backend ?? '').trim() !== 'github') diagnostics.push(diagnostic('task.body.invalid', { message: 'GitHub task record frontmatter requires backend: github', evidence: { field: 'backend' } }));
    if (!String(frontmatter.status ?? '').trim()) diagnostics.push(diagnostic('task.body.invalid', { message: 'GitHub task record frontmatter requires status', evidence: { field: 'status' } }));
    const attemptBudget = parseAttemptBudget(text, projectMapConfig);
    const reviewBudget = parseReviewBudget(text, projectMapConfig);
    if (attemptBudget.error) diagnostics.push(diagnostic('task.body.invalid', { message: attemptBudget.error, evidence: { field: 'attempt_budget' } }));
    if (reviewBudget.error) diagnostics.push(diagnostic('task.body.invalid', { message: reviewBudget.error, evidence: { field: 'review_budget' } }));
    const baseline = validateTaskContractBaseline(text, {
      lifecycle: deriveTaskContractLifecycle(text, { currentBody, transition: lifecycle === 'transition' }),
      trustedRecords,
      trustedRecordErrors,
      prospectiveRecords,
    });
    diagnostics.push(...baseline.errors.map(message => diagnostic(
      message.includes('differs from the trusted baseline') ? 'contract.baseline.stale'
        : message.includes('trusted task-contract baseline record') ? 'contract.baseline.missing'
          : 'contract.baseline.invalid',
      { message }
    )));
    diagnostics.push(...baseline.warnings.map(message => diagnostic('contract.baseline.missing', { message, level: 'warning' })));
    if (String(frontmatter.status ?? '').trim() === 'agent-ready' && !Array.isArray(basePaths)) diagnostics.push(diagnostic('task.body.base_inventory.missing'));
  }

  diagnostics.push(...validateTaskRecord(text, `issue #${number}`).map(message => diagnostic('task.body.invalid', { message })));
  const declaration = parseTaskReadinessDeclaration(text);
  diagnostics.push(...declaration.diagnostics.map(item => ({ ...item, level: item.level ?? 'error' })));
  if (Array.isArray(basePaths)) {
    const readiness = evaluateTaskReadiness({ taskBody: text, basePaths, mode: 'authoring' });
    diagnostics.push(...readiness.diagnostics);
  }
  if (!/\n\s*\[\[agent: maintainer\]\]\s*$/i.test(text)) {
    diagnostics.push(diagnostic('task.body.attribution', { message: 'GitHub task body must end with the Maintainer attribution trailer [[agent: maintainer]]' }));
  }

  const errors = diagnostics.filter(item => item.level !== 'warning');
  const warnings = diagnostics.filter(item => item.level === 'warning');
  return {
    schemaVersion: 1,
    ok: errors.length === 0,
    issue: number,
    digest: taskBodyDigest(text),
    errors: errors.map(item => item.message),
    warnings: warnings.map(item => item.message),
    diagnostics,
    warningDiagnostics: warnings,
    failureCategories: [...new Set(errors.map(item => item.category))],
  };
}

function linesForDiff(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function unifiedDiff(before, after) {
  if (before === after) return '';
  const oldLines = linesForDiff(before);
  const newLines = linesForDiff(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix++;
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const oldStart = prefix + 1;
  const newStart = prefix + 1;
  return [
    '--- remote issue body',
    '+++ candidate issue body',
    `@@ -${oldStart},${oldChanged.length} +${newStart},${newChanged.length} @@`,
    ...oldChanged.map(line => `-${line}`),
    ...newChanged.map(line => `+${line}`),
  ].join('\n');
}

export function summarizeTaskBodyChanges(before, after) {
  const fields = new Set();
  const previous = parseFrontmatterStrict(before);
  const candidate = parseFrontmatterStrict(after);
  if (previous.state === 'valid' && candidate.state === 'valid') {
    for (const field of new Set([...Object.keys(previous.data), ...Object.keys(candidate.data)])) {
      if (JSON.stringify(previous.data[field]) !== JSON.stringify(candidate.data[field])) fields.add(field);
    }
  }
  const sections = text => new Map([...String(text ?? '').matchAll(/^(##\s+.+?)\s*$/gm)].map(match => {
    const heading = match[1].replace(/^##\s+/, '').trim();
    return [heading, markdownSection(String(text ?? ''), match[1])?.body.replace(/\r\n?/g, '\n').trim() ?? ''];
  }));
  const beforeSections = sections(before);
  const afterSections = sections(after);
  const addedSections = [...afterSections.keys()].filter(key => !beforeSections.has(key)).sort();
  const removedSections = [...beforeSections.keys()].filter(key => !afterSections.has(key)).sort();
  const modifiedSections = [...beforeSections.keys()].filter(key => afterSections.has(key) && beforeSections.get(key) !== afterSections.get(key)).sort();
  const protectedFields = ['task_id', 'scope', 'out_of_scope', 'allowed_paths', 'intended_creations', 'acceptance_criteria', 'required_checks', 'independent_review_required', 'locked_decision_refs'];
  const previousContract = taskContractDigest(before).projection ?? {};
  const nextContract = taskContractDigest(after).projection ?? {};
  const changedProtectedFields = protectedFields.filter(field => JSON.stringify(previousContract[field]) !== JSON.stringify(nextContract[field]));
  return {
    frontmatterFields: [...fields].sort(),
    changedSections: [...new Set([...addedSections, ...removedSections, ...modifiedSections])],
    addedSections,
    removedSections,
    modifiedSections,
    changedProtectedFields,
    changedNonContractFrontmatterFields: [...fields].filter(field => !['task_contract_schema', ...protectedFields].includes(field)).sort(),
  };
}

function writeRecoveryFiles({ recoveryDir, issue, original, candidate, fs }) {
  const operationId = randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const digest = taskBodyDigest(original).slice('sha256:'.length, 20);
  const prefix = `issue-${issue}-task-body-${digest}-${timestamp}-${operationId}`;
  const originalPath = join(recoveryDir, `${prefix}-original.md`);
  const candidatePath = join(recoveryDir, `${prefix}-candidate.md`);
  if (fs.existsSync?.(originalPath) || fs.existsSync?.(candidatePath)) throw new GitHubTaskBodyError('refusing to overwrite an existing task-body recovery artifact');
  atomicWriteUtf8(originalPath, original, fs);
  atomicWriteUtf8(candidatePath, candidate, fs);
  return { originalPath, candidatePath, operationId, retained: true };
}

function removeRecoveryFiles(recovery, fs) {
  for (const path of [recovery.originalPath, recovery.candidatePath]) fs.rmSync(path, { force: true });
}

/**
 * Closed-loop issue-body mutation with optimistic digest and post-write checks.
 * Command runner and filesystem are injectable so all failure cases stay offline.
 */
export function applyGitHubTaskBody({
  issue,
  repo,
  body,
  bodyFile,
  expectDigest,
  dryRun = false,
  yes = false,
  commandRunner,
  fs = nodeFs,
  recoveryDir = '.agenticloop/tmp',
  projectMapConfig = null,
  basePaths,
  lint = lintGitHubTaskBody,
  retainRecovery = true,
} = {}) {
  const number = issueNumber(issue);
  if (Boolean(dryRun) === Boolean(yes)) {
    throw new GitHubTaskBodyError('task-body apply requires exactly one of --dry-run or --yes');
  }
  if (!BODY_DIGEST_RE.test(String(expectDigest ?? ''))) {
    throw new GitHubTaskBodyError('--expect-digest must be sha256:<64 lowercase hex characters>');
  }
  const candidate = body === undefined ? fs.readFileSync(bodyFile, 'utf8') : String(body);
  if (candidate.startsWith('\uFEFF')) throw new GitHubTaskBodyError('candidate task body begins with a UTF-8 BOM');
  const current = fetchGitHubTaskBody({ issue: number, repo, commandRunner, projectMapConfig });
  if (current.digest !== expectDigest) {
    return {
      ok: false,
      applied: false,
      stale: true,
      errors: [`stale task body: expected ${expectDigest}, current remote digest is ${current.digest}`],
      candidateLint: null,
      remote: current,
      recovery: null,
      diff: unifiedDiff(current.body, candidate),
      changeSummary: summarizeTaskBodyChanges(current.body, candidate),
    };
  }
  const candidateLint = lint({
    issue: number,
    body: candidate,
    basePaths,
    projectMapConfig,
    trustedRecords: current.trustedRecords,
    trustedRecordErrors: current.trustedRecordErrors,
    currentBody: current.body,
  });
  if (!candidateLint.ok) {
    return { ok: false, applied: false, stale: false, candidateLint, recovery: null, errors: candidateLint.errors, diff: null };
  }
  const diff = unifiedDiff(current.body, candidate);
  const changeSummary = summarizeTaskBodyChanges(current.body, candidate);
  if (dryRun) {
    return { ok: true, applied: false, dryRun: true, issue: number, remote: current, candidateDigest: taskBodyDigest(candidate), candidateLint, diff, changeSummary, recovery: null };
  }

  const recovery = writeRecoveryFiles({ recoveryDir, issue: number, original: current.body, candidate, fs });
  // Publish the retained copy, never the user-editable source path, so the
  // bytes sent to GitHub are exactly the candidate that passed lint.
  const args = ['issue', 'edit', String(number), '--body-file', recovery.candidatePath];
  if (repo) args.push('--repo', repo);
  runGh(commandRunner, args);

  const published = fetchGitHubTaskBody({ issue: number, repo, commandRunner, projectMapConfig });
  const candidateDigest = taskBodyDigest(candidate);
  const postLint = lint({
    issue: number,
    body: published.body,
    basePaths,
    projectMapConfig,
    trustedRecords: published.trustedRecords,
    trustedRecordErrors: published.trustedRecordErrors,
    currentBody: current.body,
  });
  if (published.digest === candidateDigest && postLint.ok) {
    if (!retainRecovery) {
      removeRecoveryFiles(recovery, fs);
      recovery.retained = false;
    }
    return { ok: true, applied: true, dryRun: false, issue: number, remote: published, candidateDigest, candidateLint, postLint, diff, changeSummary, recovery };
  }

  let rollback = { attempted: false, restored: false, reason: 'remote body no longer exactly equals the just-written candidate' };
  if (published.digest === candidateDigest) {
    const rollbackLease = fetchGitHubTaskBody({ issue: number, repo, commandRunner, projectMapConfig });
    if (rollbackLease.digest === candidateDigest) {
      rollback = { attempted: true, restored: false, reason: 'post-write validation failed while the fresh rollback lease remains valid', leaseDigest: rollbackLease.digest };
      try {
        const rollbackArgs = ['issue', 'edit', String(number), '--body-file', recovery.originalPath];
        if (repo) rollbackArgs.push('--repo', repo);
        runGh(commandRunner, rollbackArgs);
        const restored = fetchGitHubTaskBody({ issue: number, repo, commandRunner, projectMapConfig });
        rollback.restored = restored.digest === current.digest;
        if (!rollback.restored) rollback.reason = 'rollback response did not restore the exact original body';
      } catch (error) {
        rollback.reason = `rollback failed: ${error.message}`;
      }
    } else {
      rollback = { attempted: false, restored: false, reason: 'fresh rollback lease refused because the remote body changed after publication', leaseDigest: rollbackLease.digest };
    }
  }
  return {
    ok: false,
    applied: true,
    dryRun: false,
    issue: number,
    errors: [published.digest !== candidateDigest
      ? `post-write remote body digest ${published.digest} does not match validated candidate ${candidateDigest}`
      : `post-write task-record validation failed: ${postLint.errors.join('; ')}`],
    remote: published,
    candidateDigest,
    candidateLint,
    postLint,
    diff,
    changeSummary,
    recovery,
    rollback,
  };
}
