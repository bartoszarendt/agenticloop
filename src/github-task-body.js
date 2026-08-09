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
import { evaluateTaskRecordRoot } from './task-record-root.js';
import { PublicCommandError, staleCarrierDigestMessage } from './public-error.js';
import { normalizeGitHubCommentCarriers } from './github-comment-carrier.js';
import { resolveTrustedTaskContractActors, trustedActorAllowed } from './trusted-actors.js';
import {
  createTaskMutationReceipt,
  shellQuoteArgument,
  validateTaskEvidenceContext,
} from './task-evidence-contract.js';
import {
  createValidationResult,
  validationResultDigest,
  VALIDATION_RESULT_KIND,
} from './result-envelope.js';

const BODY_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export const TASK_BODY_USAGE_ERROR = Object.freeze({
  code: 'cli.usage',
  evidenceState: 'negative',
  disposition: 'blocked',
  committedStateEvaluated: false,
  safeRepair: 'Correct the command arguments, then rerun without changing remote state.',
});
export const TASK_BODY_MISSING_CONTEXT = Object.freeze({
  code: 'verification.context.missing',
  evidenceState: 'missing',
  disposition: 'needs_context',
  committedStateEvaluated: false,
  safeRepair: 'Restore the required GitHub or local-file context, then rerun without changing remote state.',
});
export const TASK_BODY_MALFORMED_CONTEXT = Object.freeze({
  code: 'verification.context.malformed',
  evidenceState: 'malformed',
  disposition: 'rejected',
  committedStateEvaluated: false,
  safeRepair: 'Repair or regenerate the malformed task-body context, then rerun.',
});
export const TASK_BODY_NEGATIVE_EVIDENCE = Object.freeze({
  code: 'evidence.negative',
  evidenceState: 'negative',
  disposition: 'blocked',
  committedStateEvaluated: false,
  safeRepair: 'Repair the reported task-body condition, then rerun the operation.',
});

export class GitHubTaskBodyError extends PublicCommandError {
  constructor(message, options) {
    if (!options || typeof options.evidenceState !== 'string' || typeof options.committedStateEvaluated !== 'boolean') {
      throw new TypeError('GitHubTaskBodyError requires explicit evidenceState and committedStateEvaluated classification');
    }
    super(message, options);
    this.name = 'GitHubTaskBodyError';
  }
}

export function taskBodyDigest(body) {
  return `sha256:${createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex')}`;
}

function taskIdentity(body, issue) {
  return taskContractDigest(body).projection?.task_id ?? `#${issue}`;
}

/** Verification-result identity for one lint outcome, bound into a receipt. */
function verificationOfLint(lintResult) {
  const result = createValidationResult({
    command: 'task-body lint',
    ok: Boolean(lintResult?.ok),
    evidenceState: lintResult?.ok ? 'current' : lintResult?.evidenceState ?? 'negative',
    disposition: lintResult?.ok ? 'proceed' : 'blocked',
    errors: lintResult?.ok ? [] : [...(lintResult?.errors ?? [])],
    warnings: [...(lintResult?.warnings ?? [])],
  });
  return { resultKind: VALIDATION_RESULT_KIND, digest: validationResultDigest(result) };
}

/**
 * The exact read-only command that re-evaluates a GitHub transition's evidence
 * against the resulting body. It is `task-readiness`, never a mutation command,
 * and it carries the resulting digest rather than a placeholder.
 */
function githubRevalidationCommand({ issue, resultingDigest, context }) {
  // Without a readiness evidence context there is no base or dependency
  // evidence to re-evaluate, so the exact read-only verifier is the lint
  // family bound to the resulting digest.
  if (!context) {
    return ['npx', 'agenticloop', 'task-body', 'lint', '--issue', String(issue), '--expect-task-digest', resultingDigest].join(' ');
  }
  return [
    'npx', 'agenticloop', 'task-readiness',
    '--issue', String(issue),
    '--mode', 'authoring',
    '--expect-task-digest', resultingDigest,
    ...context.base.revalidationArgs.map(shellQuoteArgument),
    ...context.dependencies.revalidationArgs.map(shellQuoteArgument),
  ].join(' ');
}

function issueNumber(issue) {
  const number = Number(issue);
  if (!Number.isInteger(number) || number <= 0) {
    throw new GitHubTaskBodyError('--issue must be a positive integer', TASK_BODY_USAGE_ERROR);
  }
  return number;
}

function runGhJson(commandRunner, args) {
  const result = commandRunner('gh', args, { encoding: 'utf8' });
  if (result?.error) {
    throw new GitHubTaskBodyError(`failed to run 'gh ${args.join(' ')}': ${result.error.message}`, TASK_BODY_MISSING_CONTEXT);
  }
  if (result?.status !== 0) {
    throw new GitHubTaskBodyError(
      `'gh ${args.join(' ')}' failed: ${(result?.stderr ?? result?.stdout ?? `exit ${result?.status}`).trim()}`,
      TASK_BODY_MISSING_CONTEXT
    );
  }
  try {
    return JSON.parse(String(result?.stdout ?? ''));
  } catch {
    throw new GitHubTaskBodyError(`'gh ${args.join(' ')}' returned invalid JSON`, TASK_BODY_MALFORMED_CONTEXT);
  }
}

function runGh(commandRunner, args) {
  const result = commandRunner('gh', args, { encoding: 'utf8' });
  if (result?.error) {
    throw new GitHubTaskBodyError(`failed to run 'gh ${args.join(' ')}': ${result.error.message}`, TASK_BODY_MISSING_CONTEXT);
  }
  if (result?.status !== 0) {
    throw new GitHubTaskBodyError(
      `'gh ${args.join(' ')}' failed: ${(result?.stderr ?? result?.stdout ?? `exit ${result?.status}`).trim()}`,
      TASK_BODY_MISSING_CONTEXT
    );
  }
}

export function authenticatedGitHubLogin(commandRunner) {
  const account = runGhJson(commandRunner, ['api', 'user']);
  const login = String(account?.login ?? '').trim();
  if (!login) {
    throw new GitHubTaskBodyError(
      'authenticated GitHub account has no login',
      TASK_BODY_MALFORMED_CONTEXT
    );
  }
  return login;
}

function configuredTrustedActors(projectMapConfig) {
  const resolved = resolveTrustedTaskContractActors(projectMapConfig);
  if (resolved.errors.length) {
    throw new GitHubTaskBodyError(resolved.errors.join('; '), TASK_BODY_MALFORMED_CONTEXT);
  }
  return resolved;
}

function githubRepository(commandRunner, repo) {
  if (repo) return repo;
  const data = runGhJson(commandRunner, ['repo', 'view', '--json', 'nameWithOwner']);
  const name = String(data?.nameWithOwner ?? '').trim();
  if (!name) {
    throw new GitHubTaskBodyError(
      'cannot resolve the current GitHub repository for paginated issue comments',
      TASK_BODY_MISSING_CONTEXT
    );
  }
  return name;
}

function fetchAllGitHubIssueComments(commandRunner, repo, issue) {
  const ownerName = githubRepository(commandRunner, repo);
  const data = runGhJson(commandRunner, ['api', '--paginate', '--slurp', `repos/${ownerName}/issues/${issue}/comments`]);
  if (!Array.isArray(data)) {
    throw new GitHubTaskBodyError(
      'GitHub issue-comment pagination returned an invalid collection',
      TASK_BODY_MALFORMED_CONTEXT
    );
  }
  return data.flatMap(page => Array.isArray(page) ? page : []);
}

export function fetchGitHubTaskBody({ issue, repo, commandRunner, projectMapConfig = null }) {
  const number = issueNumber(issue);
  const args = ['issue', 'view', String(number), '--json', 'body,number'];
  if (repo) args.push('--repo', repo);
  const data = runGhJson(commandRunner, args);
  if (!data || typeof data.body !== 'string') {
    throw new GitHubTaskBodyError(`issue #${number} has no readable body`, TASK_BODY_MISSING_CONTEXT);
  }
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
  if (parsed.state !== 'valid') {
    throw new GitHubTaskBodyError(
      `cannot set task field: frontmatter is ${parsed.state}${parsed.reason ? ` (${parsed.reason})` : ''}`,
      TASK_BODY_MALFORMED_CONTEXT
    );
  }
  const name = String(field ?? '').trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new GitHubTaskBodyError('task-body set-field requires a simple frontmatter field name', TASK_BODY_USAGE_ERROR);
  }
  if (String(value ?? '').includes('\n') || String(value ?? '').includes('\r')) {
    throw new GitHubTaskBodyError('task-body set-field value must be one line', TASK_BODY_USAGE_ERROR);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const opening = text.match(/^(?:\uFEFF)?---[ \t]*\r?\n/);
  if (!opening) {
    throw new GitHubTaskBodyError('cannot find task frontmatter opening delimiter', TASK_BODY_MALFORMED_CONTEXT);
  }
  const close = /\r?\n---[ \t]*(?=\r?\n|$)/g;
  close.lastIndex = opening[0].length;
  const closing = close.exec(text);
  if (!closing) {
    throw new GitHubTaskBodyError('cannot find task frontmatter closing delimiter', TASK_BODY_MALFORMED_CONTEXT);
  }
  const frontmatter = text.slice(opening[0].length, closing.index);
  const lines = frontmatter.split(/\r?\n/);
  const matches = lines.map((line, index) => ({ line, index })).filter(item => new RegExp(`^${name}:`).test(item.line));
  if (matches.length > 1) {
    throw new GitHubTaskBodyError(`cannot set duplicate frontmatter field '${name}'`, TASK_BODY_MALFORMED_CONTEXT);
  }
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
  dependencies = {},
} = {}) {
  const number = issueNumber(issue);
  const text = String(body ?? '');
  let diagnostics = [];
  const root = evaluateTaskRecordRoot(text);
  if (!root.ok) {
    diagnostics.push(...root.diagnostics);
    const errors = diagnostics.filter(item => item.level !== 'warning');
    const warnings = diagnostics.filter(item => item.level === 'warning');
    return {
      schemaVersion: 1,
      ok: false,
      evidenceState: 'malformed',
      disposition: 'rejected',
      rollbackAuthorized: false,
      issue: number,
      digest: taskBodyDigest(text),
      errors: errors.map(item => item.message),
      warnings: warnings.map(item => item.message),
      diagnostics,
      warningDiagnostics: warnings,
      failureCategories: [...new Set(errors.map(item => item.category))],
      firstSafeRepair: root.firstSafeRepair,
    };
  }
  if (hasTaskContractRecordMarker(text)) diagnostics.push(diagnostic('contract.record_marker.mutable_body'));
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
    diagnostics.push(...(baseline.errorFacts ?? baseline.errors.map(message => ({
      code: 'contract.baseline.invalid', message,
    }))).map(fact => diagnostic(fact.code, { message: fact.message })));
    diagnostics.push(...baseline.warnings.map(message => diagnostic('contract.baseline.missing', { message, level: 'warning' })));
    if (String(frontmatter.status ?? '').trim() === 'agent-ready' && !Array.isArray(basePaths)) diagnostics.push(diagnostic('task.body.base_inventory.missing'));
  }

  diagnostics.push(...validateTaskRecord(text, `issue #${number}`).map(message => diagnostic('task.body.invalid', { message })));
  const declaration = parseTaskReadinessDeclaration(text);
  diagnostics.push(...declaration.diagnostics.map(item => ({ ...item, level: item.level ?? 'error' })));
  if (Array.isArray(basePaths)) {
    const readiness = evaluateTaskReadiness({ taskBody: text, basePaths, mode: 'authoring', dependencies });
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

function recoveryPrefix(issue) {
  return `issue-${issue}-task-body-`;
}

/**
 * What a recovery artifact records about the operation that produced it.
 *
 * `attempted` is written before the transport call and means only that a write
 * was about to be issued. It is deliberately not proof of anything: a process
 * that dies mid-operation leaves this state behind, and the toolkit cannot tell
 * that case from a write that never left the machine.
 */
const RECOVERY_OUTCOMES = Object.freeze(['attempted', 'applied', 'not_applied']);
const RECOVERY_OUTCOME_KIND = 'agenticloop.task-body-recovery-outcome';
const RECOVERY_OUTCOME_SCHEMA_VERSION = 1;
const RECOVERY_OUTCOME_KEYS = Object.freeze([
  'kind',
  'observedAt',
  'operationId',
  'outcome',
  'schemaVersion',
]);
const RECOVERY_OUTCOME_OBSERVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function recoveryOutcomePath(recovery) {
  return `${recovery.originalPath.slice(0, -'-original.md'.length)}-outcome.json`;
}

function writeRecoveryOutcome(recovery, outcome, fs) {
  if (!RECOVERY_OUTCOMES.includes(outcome)) throw new TypeError(`unknown recovery outcome '${outcome}'`);
  atomicWriteUtf8(
    recoveryOutcomePath(recovery),
    `${JSON.stringify({
      kind: RECOVERY_OUTCOME_KIND,
      schemaVersion: RECOVERY_OUTCOME_SCHEMA_VERSION,
      operationId: recovery.operationId,
      outcome,
      observedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    fs
  );
  recovery.outcome = outcome;
  return recovery;
}

/**
 * Read the outcome an artifact recorded for one exact operation.
 *
 * The marker is bound to its operation id, and the id is checked against the one
 * the artifact filenames carry. A marker naming another operation says nothing
 * about this artifact; a marker that is malformed, unrecognized, or unreadable
 * says nothing at all. Every one of those reads as `null`, which the caller
 * treats as absence of proof rather than as absence of a problem.
 *
 * @returns {'attempted'|'applied'|'not_applied'|null}
 */
function readRecoveryOutcome(outcomePath, fs, expectedOperationId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(RECOVERY_OUTCOME_KEYS)) return null;
    if (parsed.kind !== RECOVERY_OUTCOME_KIND) return null;
    if (parsed.schemaVersion !== RECOVERY_OUTCOME_SCHEMA_VERSION) return null;
    if (!expectedOperationId || parsed.operationId !== expectedOperationId) return null;
    if (!RECOVERY_OUTCOMES.includes(parsed.outcome)) return null;
    if (!RECOVERY_OUTCOME_OBSERVED_AT.test(String(parsed.observedAt ?? '')) ||
        !Number.isFinite(Date.parse(parsed.observedAt))) return null;
    return parsed.outcome;
  } catch {
    return null;
  }
}

function writeRecoveryFiles({ recoveryDir, issue, original, candidate, fs }) {
  const operationId = randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const digest = taskBodyDigest(original).slice('sha256:'.length, 20);
  const prefix = `${recoveryPrefix(issue)}${digest}-${timestamp}-${operationId}`;
  const originalPath = join(recoveryDir, `${prefix}-original.md`);
  const candidatePath = join(recoveryDir, `${prefix}-candidate.md`);
  if (fs.existsSync?.(originalPath) || fs.existsSync?.(candidatePath)) {
    throw new GitHubTaskBodyError(
      'refusing to overwrite an existing task-body recovery artifact',
      TASK_BODY_NEGATIVE_EVIDENCE
    );
  }
  atomicWriteUtf8(originalPath, original, fs);
  atomicWriteUtf8(candidatePath, candidate, fs);
  const recovery = { originalPath, candidatePath, operationId, retained: true, outcome: 'attempted' };
  return writeRecoveryOutcome(recovery, 'attempted', fs);
}

function removeRecoveryFiles(recovery, fs) {
  for (const path of [recovery.originalPath, recovery.candidatePath, recoveryOutcomePath(recovery)]) {
    fs.rmSync(path, { force: true });
  }
}

/**
 * Find a retained recovery artifact proving that this exact candidate was
 * previously *written* to this issue from this exact predecessor body.
 *
 * The artifact files alone prove only that a write was prepared. An operation
 * whose refetch confirmed the remote body was unchanged left artifacts behind
 * too, and treating those as proof would let a later external write that happens
 * to match the candidate be attributed to us. Only an artifact whose recorded
 * outcome is `applied` — written after a refetch observed the candidate bytes on
 * the carrier — attributes a matching remote body to one of our operations.
 *
 * @returns {{operationId: string, originalPath: string, candidatePath: string}|null}
 */
function findRecoveryProof({ recoveryDir, issue, candidateDigest, expectDigest, fs }) {
  let entries;
  try {
    entries = fs.readdirSync(recoveryDir);
  } catch {
    return null;
  }
  const prefix = recoveryPrefix(issue);
  for (const name of [...entries].sort().reverse()) {
    if (!name.startsWith(prefix) || !name.endsWith('-candidate.md')) continue;
    const candidatePath = join(recoveryDir, name);
    const originalPath = join(recoveryDir, `${name.slice(0, -'-candidate.md'.length)}-original.md`);
    let storedCandidate;
    let storedOriginal;
    try {
      storedCandidate = fs.readFileSync(candidatePath, 'utf8');
      storedOriginal = fs.readFileSync(originalPath, 'utf8');
    } catch {
      continue;
    }
    if (taskBodyDigest(storedCandidate) !== candidateDigest) continue;
    if (taskBodyDigest(storedOriginal) !== expectDigest) continue;
    const outcomePath = join(recoveryDir, `${name.slice(0, -'-candidate.md'.length)}-outcome.json`);
    const operationId = name.slice(prefix.length, -'-candidate.md'.length).split('-').slice(-5).join('-');
    // An artifact that only records an attempt, whose refetch proved the write
    // did not apply, or whose marker belongs to some other operation, is
    // operation evidence at most and never publication evidence.
    if (readRecoveryOutcome(outcomePath, fs, operationId) !== 'applied') continue;
    return { operationId, originalPath, candidatePath };
  }
  return null;
}

/**
 * Reconcile only the labels this transition owns.
 *
 * Ownership is explicit: every requested label is owned, and any existing label
 * inside `ownedLabelPrefix` that is no longer requested is superseded and
 * removed. Every other label on the issue is left exactly as it is. GitHub
 * offers no cross-resource transaction, so this returns its own outcome and the
 * caller reports partial progress rather than claiming atomicity.
 */
function reconcileOwnedLabels({ issue, repo, labels, ownedLabelPrefix, commandRunner }) {
  const requested = [...new Set((labels ?? []).map(label => String(label).trim()).filter(Boolean))].sort();
  if (requested.length === 0) {
    return { attempted: false, ok: true, verified: true, added: [], removed: [], untouched: [], error: null };
  }
  const viewArgs = ['issue', 'view', String(issue), '--json', 'labels'];
  if (repo) viewArgs.push('--repo', repo);
  let existing;
  try {
    const data = runGhJson(commandRunner, viewArgs);
    existing = (Array.isArray(data?.labels) ? data.labels : [])
      .map(label => String(label?.name ?? label ?? '').trim())
      .filter(Boolean);
  } catch (error) {
    return { attempted: true, ok: false, verified: false, added: [], removed: [], untouched: [], error: error.message };
  }
  const owned = new Set(requested);
  const add = requested.filter(label => !existing.includes(label));
  const remove = existing.filter(label => !owned.has(label) && label.startsWith(ownedLabelPrefix));
  const untouched = existing.filter(label => !owned.has(label) && !label.startsWith(ownedLabelPrefix)).sort();
  if (add.length === 0 && remove.length === 0) {
    return { attempted: true, ok: true, verified: true, added: [], removed: [], untouched, error: null };
  }
  const editArgs = ['issue', 'edit', String(issue)];
  for (const label of add) editArgs.push('--add-label', label);
  for (const label of remove) editArgs.push('--remove-label', label);
  if (repo) editArgs.push('--repo', repo);
  try {
    runGh(commandRunner, editArgs);
  } catch (error) {
    return { attempted: true, ok: false, verified: false, added: [], removed: [], untouched, error: error.message };
  }
  try {
    const refetched = runGhJson(commandRunner, viewArgs);
    const names = (Array.isArray(refetched?.labels) ? refetched.labels : [])
      .map(label => String(label?.name ?? label ?? '').trim())
      .filter(Boolean);
    const complete = requested.every(label => names.includes(label)) &&
      !names.some(label => !owned.has(label) && label.startsWith(ownedLabelPrefix));
    return complete
      ? { attempted: true, ok: true, verified: true, added: add, removed: remove, untouched, error: null }
      : { attempted: true, ok: false, verified: false, added: [], removed: [], untouched, error: 'refetched issue labels do not match the requested owned-label projection' };
  } catch (error) {
    return { attempted: true, ok: false, verified: false, added: [], removed: [], untouched, error: error.message };
  }
}

function transitionNoteMarker({ repository, issue, expectedDigest, candidateDigest, note }) {
  const normalizedNote = String(note ?? '').replace(/\r\n?/g, '\n').trim();
  const identity = JSON.stringify({
    kind: 'agenticloop.transition-note', schemaVersion: 1, repository: String(repository).toLowerCase(), issue: Number(issue),
    expectedDigest: String(expectedDigest), candidateDigest: String(candidateDigest), note: normalizedNote,
  });
  return `<!-- agenticloop-transition-note:v1:${createHash('sha256').update(identity, 'utf8').digest('hex')} -->`;
}

function transitionNoteBody(marker, note) {
  return `${marker}\n${String(note ?? '').replace(/\r\n?/g, '\n').trim()}`;
}

function matchingTransitionNote(comments, { rendered, publisher, trustedActors }) {
  const publisherKey = String(publisher).toLowerCase();
  const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
  return (comments ?? []).find(comment => {
    const body = String(comment?.body ?? '').replace(/\r\n?/g, '\n');
    const author = String(comment?.user?.login ?? comment?.author?.login ?? '').trim();
    const association = String(comment?.author_association ?? comment?.authorAssociation ?? '').toUpperCase();
    const trusted = Array.isArray(trustedActors)
      ? trustedActorAllowed(trustedActors, author)
      : trustedAssociations.has(association);
    return body === rendered && author.toLowerCase() === publisherKey && trusted;
  }) ?? null;
}

/** Persist and refetch one idempotently identified transition note. */
function persistTransitionNote({ issue, repo, note, expectDigest, candidateDigest, commandRunner, projectMapConfig }) {
  if (!note) return { attempted: false, ok: true, verified: true, marker: null, error: null };
  let repository;
  let marker;
  let rendered;
  let publisher;
  let trustedActors;
  try {
    repository = githubRepository(commandRunner, repo);
    publisher = authenticatedGitHubLogin(commandRunner);
    const trust = configuredTrustedActors(projectMapConfig);
    trustedActors = trust.actors;
    if (!trustedActorAllowed(trustedActors, publisher)) {
      throw new GitHubTaskBodyError(
        `authenticated GitHub publisher '${publisher}' is not allowed by the configured trusted task-contract actors`,
        TASK_BODY_NEGATIVE_EVIDENCE
      );
    }
    marker = transitionNoteMarker({ repository, issue, expectedDigest: expectDigest, candidateDigest, note });
    rendered = transitionNoteBody(marker, note);
    if (matchingTransitionNote(fetchAllGitHubIssueComments(commandRunner, repository, issue), { rendered, publisher, trustedActors })) {
      return { attempted: false, ok: true, verified: true, marker, error: null };
    }
  } catch (error) {
    return { attempted: false, ok: false, verified: false, marker: null, error: error.message };
  }
  const args = ['issue', 'comment', String(issue), '--body', rendered];
  if (repo) args.push('--repo', repo);
  try {
    runGh(commandRunner, args);
  } catch (error) {
    try {
      if (matchingTransitionNote(fetchAllGitHubIssueComments(commandRunner, repository, issue), { rendered, publisher, trustedActors })) {
        return { attempted: true, ok: true, verified: true, marker, ambiguous: true, error: null };
      }
    } catch (refetchError) {
      return { attempted: true, ok: false, verified: false, marker, error: `${error.message}; refetch failed: ${refetchError.message}` };
    }
    return { attempted: true, ok: false, verified: false, marker, error: error.message };
  }
  try {
    if (matchingTransitionNote(fetchAllGitHubIssueComments(commandRunner, repository, issue), { rendered, publisher, trustedActors })) {
      return { attempted: true, ok: true, verified: true, marker, error: null };
    }
    return { attempted: true, ok: false, verified: false, marker, error: 'published transition comment was not found by the required refetch' };
  } catch (error) {
    return { attempted: true, ok: false, verified: false, marker, error: error.message };
  }
}

/**
 * Closed-loop issue-body mutation with optimistic digest and post-write checks.
 * Command runner and filesystem are injectable so all failure cases stay offline.
 *
 * Resume semantics are provenance-typed. When the remote body already equals
 * the candidate this function distinguishes:
 *
 *   `current_no_op`                  expected, candidate, and current all agree;
 *   `receipt_proven_prior_write`     a retained recovery artifact attributes the
 *                                    current body to one of our own operations
 *                                    from the exact expected predecessor;
 *   `unattributed_matching_write`    the body matches but nothing attributes it
 *                                    to us; this is never reported as proven
 *                                    publication and requires reconciliation.
 */
export function applyGitHubTaskBody({
  issue,
  repo,
  body,
  bodyFile,
  expectDigest,
  dryRun = false,
  yes = false,
  note = null,
  labels = [],
  ownedLabelPrefix = 'status:',
  commandRunner,
  fs = nodeFs,
  recoveryDir = '.agenticloop/tmp',
  projectMapConfig = null,
  basePaths,
  dependencies = {},
  evidenceContext = null,
  lint = lintGitHubTaskBody,
  retainRecovery = true,
} = {}) {
  const number = issueNumber(issue);
  if (Boolean(dryRun) === Boolean(yes)) {
    throw new GitHubTaskBodyError(
      'task-body apply requires exactly one of --dry-run or --yes',
      TASK_BODY_USAGE_ERROR
    );
  }
  if (!BODY_DIGEST_RE.test(String(expectDigest ?? ''))) {
    throw new GitHubTaskBodyError(
      '--expect-digest must be sha256:<64 lowercase hex characters>',
      TASK_BODY_USAGE_ERROR
    );
  }
  if (evidenceContext !== null) {
    const validation = validateTaskEvidenceContext(evidenceContext);
    if (!validation.ok) {
      throw new GitHubTaskBodyError(
        `task evidence context is invalid: ${validation.errors.join('; ')}`,
        TASK_BODY_MALFORMED_CONTEXT
      );
    }
    if (evidenceContext.task.expectedDigest !== String(expectDigest)) {
      throw new GitHubTaskBodyError(
        'task evidence context binds a different expected predecessor digest than --expect-digest',
        TASK_BODY_MALFORMED_CONTEXT
      );
    }
  }
  let candidate;
  try {
    candidate = body === undefined ? fs.readFileSync(bodyFile, 'utf8') : String(body);
  } catch {
    throw new GitHubTaskBodyError(
      `candidate task body '${String(bodyFile ?? '')}' is unavailable`,
      TASK_BODY_MISSING_CONTEXT
    );
  }
  if (candidate.startsWith('﻿')) {
    throw new GitHubTaskBodyError('candidate task body begins with a UTF-8 BOM', TASK_BODY_MALFORMED_CONTEXT);
  }
  if (!candidate.includes('\n')) {
    throw new GitHubTaskBodyError('candidate task body has collapsed newlines and is not a valid Markdown record', TASK_BODY_MALFORMED_CONTEXT);
  }
  const current = fetchGitHubTaskBody({ issue: number, repo, commandRunner, projectMapConfig });
  const candidateDigest = taskBodyDigest(candidate);
  const projectionState = ({ bodyAttempted = false, bodyComplete = false, noteResult = null, labelResult = null, includeNote = note !== null && note !== undefined } = {}) => {
    const projections = [{ name: 'issue_body', owned: true, attempted: bodyAttempted, complete: bodyComplete }];
    if (includeNote) {
      projections.push({
        name: 'issue_comment', owned: true,
        attempted: Boolean(noteResult?.attempted), complete: Boolean(noteResult?.verified),
      });
    }
    if ((labels ?? []).some(label => String(label).trim())) {
      projections.push({
        name: 'issue_labels', owned: true,
        attempted: Boolean(labelResult?.attempted), complete: Boolean(labelResult?.verified),
      });
    }
    return projections;
  };
  const receiptFor = ({
    resultingDigest,
    disposition,
    projections,
    changedPaths = [`issue:${number}`],
    recovery: recoveryNote = null,
    verification,
    rollback = null,
  }) =>
    createTaskMutationReceipt({
      context: evidenceContext,
      backend: 'github',
      taskId: taskIdentity(candidate, number),
      carrier: `issue:${number}`,
      expectedDigest: String(expectDigest),
      candidateDigest,
      resultingDigest,
      verification,
      ownedProjections: projections.map(item => item.name),
      projections,
      changedPaths,
      mutationDisposition: disposition,
      recovery: recoveryNote,
      rollback,
      revalidateCommand: githubRevalidationCommand({
        issue: number,
        resultingDigest: resultingDigest ?? candidateDigest,
        context: evidenceContext,
      }),
    });

  // --- Resume: the remote body already equals the candidate ----------------
  if (current.digest === candidateDigest) {
    const currentLint = lint({
      issue: number, body: current.body, basePaths, dependencies, projectMapConfig,
      trustedRecords: current.trustedRecords, trustedRecordErrors: current.trustedRecordErrors,
      currentBody: current.body,
    });
    const proof = findRecoveryProof({ recoveryDir, issue: number, candidateDigest, expectDigest: String(expectDigest), fs });
    const provenance = String(expectDigest) === candidateDigest
      ? 'current_no_op'
      : proof
        ? 'receipt_proven_prior_write'
        : 'unattributed_matching_write';
    if (provenance === 'unattributed_matching_write') {
      // The body matches but nothing attributes it to us. Reporting this as a
      // proven publication would invent provenance the host cannot supply.
      return {
        ok: false,
        applied: false,
        stale: false,
        nonAuthoritative: true,
        issue: number,
        remote: current,
        candidateDigest,
        candidateLint: currentLint,
        publicationProvenance: provenance,
        errors: [
          `issue #${number} already contains the exact candidate body, but no retained operation receipt attributes that write to this toolkit ` +
          `and the expected predecessor digest ${expectDigest} does not match it. Refetch the task body and reconcile the external change before continuing.`,
        ],
        diff: '',
        changeSummary: summarizeTaskBodyChanges(current.body, candidate),
        recovery: null,
        evidenceContext,
      };
    }
    if (!currentLint.ok) {
      return {
        ok: false, applied: false, stale: false, issue: number, remote: current, candidateDigest,
        candidateLint: currentLint, publicationProvenance: provenance,
        errors: currentLint.errors, diff: '', recovery: null, evidenceContext,
      };
    }
    // A genuinely current no-op has no historical transition to annotate. A
    // receipt-proven body can resume its missing note without rewriting it.
    const noteResult = provenance === 'current_no_op'
      ? { attempted: false, ok: true, verified: true, marker: null, error: null }
      : persistTransitionNote({ issue: number, repo, note, expectDigest, candidateDigest, commandRunner, projectMapConfig });
    const labelResult = reconcileOwnedLabels({ issue: number, repo, labels, ownedLabelPrefix, commandRunner });
    const projections = projectionState({ bodyComplete: true, noteResult, labelResult, includeNote: provenance !== 'current_no_op' });
    const partialErrors = [
      ...(noteResult.ok ? [] : [`the transition note could not be persisted: ${noteResult.error}`]),
      ...(labelResult.ok ? [] : [`owned label reconciliation failed: ${labelResult.error}`]),
    ];
    if (partialErrors.length > 0) {
      return {
        ok: false, applied: false, dryRun: false, issue: number, remote: current, candidateDigest,
        candidateLint: currentLint, postLint: currentLint, publicationProvenance: provenance,
        labels: labelResult, note: noteResult, diff: '', changeSummary: summarizeTaskBodyChanges(current.body, candidate),
        recovery: null, evidenceContext,
        errors: partialErrors,
        receipt: receiptFor({
          resultingDigest: current.digest,
          disposition: 'partially_committed',
          projections,
          verification: verificationOfLint(currentLint),
          recovery: `The issue body is current at ${current.digest}; one or more owned projections did not complete. ` +
            'Rerun the same command to resume the incomplete projections without rewriting the body.',
        }),
      };
    }
    return {
      ok: true, applied: false, dryRun: false, issue: number, remote: current,
      candidateDigest, candidateLint: currentLint, postLint: currentLint,
      publicationProvenance: provenance, labels: labelResult, note: noteResult,
      diff: '', changeSummary: summarizeTaskBodyChanges(current.body, candidate), recovery: null,
      receipt: receiptFor({
        resultingDigest: current.digest,
        disposition: 'already_current',
        projections,
        verification: verificationOfLint(currentLint),
      }),
    };
  }

  if (current.digest !== expectDigest) {
    return {
      ok: false,
      applied: false,
      stale: true,
      errors: [staleCarrierDigestMessage(expectDigest, current.digest)],
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
    dependencies,
  });
  if (!candidateLint.ok) {
    return { ok: false, applied: false, stale: false, candidateLint, recovery: null, errors: candidateLint.errors, diff: null, evidenceContext };
  }
  const diff = unifiedDiff(current.body, candidate);
  const changeSummary = summarizeTaskBodyChanges(current.body, candidate);
  if (dryRun) {
    return {
      ok: true, applied: false, dryRun: true, issue: number, remote: current, candidateDigest,
      candidateLint, diff, changeSummary, recovery: null,
      receipt: receiptFor({
          resultingDigest: null,
          disposition: 'dry_run',
          projections: projectionState(),
          verification: verificationOfLint(candidateLint),
      }),
    };
  }

  const recovery = writeRecoveryFiles({ recoveryDir, issue: number, original: current.body, candidate, fs });
  // Publish the retained copy, never the user-editable source path, so the
  // bytes sent to GitHub are exactly the candidate that passed lint.
  const args = ['issue', 'edit', String(number), '--body-file', recovery.candidatePath];
  if (repo) args.push('--repo', repo);
  let transportError = null;
  try {
    runGh(commandRunner, args);
  } catch (error) {
    // An ambiguous transport response is not proof the write failed. The
    // retained recovery artifact is the operation evidence that lets the
    // refetch below attribute a matching remote body to this operation.
    transportError = error;
  }

  const published = fetchGitHubTaskBody({ issue: number, repo, commandRunner, projectMapConfig });
  // Record what the refetch actually observed. This is what makes the retained
  // artifact evidence of a write rather than evidence of an attempt, and it is
  // what a later rerun consults before attributing a matching remote body here.
  writeRecoveryOutcome(recovery, published.digest === candidateDigest ? 'applied' : 'not_applied', fs);
  if (transportError && published.digest !== candidateDigest) {
    return {
      ok: false, applied: false, dryRun: false, issue: number, remote: published, candidateDigest,
      candidateLint, diff, changeSummary, recovery,
      publicationProvenance: 'ambiguous_response_not_applied',
      errors: [`the publication transport failed and the remote body is unchanged: ${transportError.message}`],
      evidenceContext,
      receipt: receiptFor({
        resultingDigest: published.digest,
        disposition: 'uncommitted',
        projections: projectionState({ bodyAttempted: true }),
        changedPaths: [],
        verification: verificationOfLint(candidateLint),
        recovery: `No issue-body change was observed after the ambiguous transport response. Preserve the operation artifacts under '${recoveryDir}' and rerun only after refetching issue #${number}.`,
      }),
    };
  }
  const postLint = lint({
    issue: number,
    body: published.body,
    basePaths,
    projectMapConfig,
    trustedRecords: published.trustedRecords,
    trustedRecordErrors: published.trustedRecordErrors,
    currentBody: current.body,
    dependencies,
  });
  if (published.digest === candidateDigest && postLint.ok) {
    const noteResult = persistTransitionNote({ issue: number, repo, note, expectDigest, candidateDigest, commandRunner, projectMapConfig });
    const labelResult = reconcileOwnedLabels({ issue: number, repo, labels, ownedLabelPrefix, commandRunner });
    const projections = projectionState({ bodyAttempted: true, bodyComplete: true, noteResult, labelResult });
    const partialErrors = [
      ...(noteResult.ok ? [] : [`the transition note could not be persisted: ${noteResult.error}`]),
      ...(labelResult.ok ? [] : [`owned label reconciliation failed: ${labelResult.error}`]),
    ];
    if (partialErrors.length > 0) {
      return {
        ok: false, applied: true, dryRun: false, issue: number, remote: published, candidateDigest,
        candidateLint, postLint, diff, changeSummary, recovery,
        publicationProvenance: transportError ? 'ambiguous_response_recovered' : 'published',
        labels: labelResult, note: noteResult, errors: partialErrors,
        receipt: receiptFor({
          resultingDigest: published.digest,
          disposition: 'partially_committed',
          projections,
          verification: verificationOfLint(postLint),
          recovery: `The issue body committed at ${published.digest}; one or more owned projections did not. ` +
            'Rerun the same command to resume at the remaining projections without rewriting the body. ' +
            'GitHub offers no cross-resource transaction, so this is partial external progress, not a rolled-back operation.',
        }),
      };
    }
    if (!retainRecovery) {
      removeRecoveryFiles(recovery, fs);
      recovery.retained = false;
    }
    return {
      ok: true, applied: true, dryRun: false, issue: number, remote: published,
      candidateDigest, candidateLint, postLint, diff, changeSummary, recovery,
      publicationProvenance: transportError ? 'ambiguous_response_recovered' : 'published',
      labels: labelResult, note: noteResult,
      receipt: receiptFor({
        resultingDigest: published.digest,
        disposition: 'committed',
        projections,
        verification: verificationOfLint(postLint),
      }),
    };
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
    receipt: rollback.restored ? receiptFor({
      resultingDigest: current.digest,
      disposition: 'rolled_back',
      projections: projectionState({ bodyAttempted: true }),
      changedPaths: [],
      verification: verificationOfLint(postLint),
      rollback: {
        attempted: true,
        restored: true,
        expectedDigest: current.digest,
        resultingDigest: current.digest,
        reason: rollback.reason,
      },
      recovery: 'The invalid publication was proven restored to the exact predecessor. Repair the failed validation before rebuilding and rerunning the transition.',
    }) : receiptFor({
      resultingDigest: published.digest,
      disposition: 'unresolved',
      projections: projectionState({ bodyAttempted: true }),
      verification: verificationOfLint(postLint),
      recovery: `A publication committed to issue #${number} (${published.digest}) that does not equal the validated candidate (${candidateDigest}) ` +
        `and could not be rolled back: ${rollback.reason}. Recovery artifacts are retained at ${recovery.originalPath} and ${recovery.candidatePath}. ` +
        'Refetch the body and reconcile it before any further transition.',
    }),
  };
}
