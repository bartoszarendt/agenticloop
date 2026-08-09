/**
 * Files/GitHub semantic transition differential.
 *
 * Both backends are driven through their real public paths - files `task
 * status` and GitHub `task-body transition` - over one shared workflow fixture.
 * Every case compares a *closed* normalized semantic result: the gate outcome,
 * evidence state, disposition, rollback authorization, ordered diagnostic codes
 * and root cause, the canonical verification-result identity, and the resulting
 * shared task contract.
 *
 * The success path is compared just as closely: one normalized success result
 * and one identity over it, covering the shared task identity, the complete
 * evidence context, the owned-projection structure, the mutation disposition,
 * and the transition.
 *
 * Nothing is discarded to make the comparison pass. The dependency provenance
 * object and the task identity are compared field by field, and the only values
 * either side may differ in are enumerated explicitly below as
 * transport-specific: the carrier identity and its digests, the owned carrier
 * projection name, and the transport side effect. Message text is neutralized
 * only for command names and carrier identities - never for generic semantic
 * phrasing, which must genuinely match.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCliInProcess } from './helpers/run-cli.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { git } from './helpers/dispatch-fixture.js';
import {
  createTaskContractBaselineRecord,
  renderTaskContractRecord,
  taskContractDigest,
} from '../src/task-contract-baseline.js';
import { taskBodyDigest } from '../src/github-task-body.js';
import { validateTaskMutationReceipt } from '../src/task-evidence-contract.js';
import { validationResultDigest } from '../src/result-envelope.js';
import { canonicalJson } from '../src/canonical-json.js';
import { getProjectRoleCapabilities } from '../src/role-capabilities.js';
import { createAuditRecordContent } from '../src/audit-record.js';

let temp;

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-backend-equivalence-')); });
after(() => rmSync(temp, { recursive: true, force: true }));

function sha256(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * The closed canonical validation envelope. These fields carry the whole
 * semantic verdict and every one of them is compared.
 */
const SEMANTIC_ENVELOPE_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'command', 'ok', 'evidenceState', 'disposition',
  'diagnostics', 'warningDiagnostics', 'errors', 'warnings',
  'failureCategories', 'firstSafeRepair', 'rollbackAuthorized',
  'committedStateEvaluated', 'debugReference', 'requiredContext',
]);

/**
 * Domain fields outside the envelope that name the transport carrier rather
 * than the semantics. They are compared as carrier identity, not for equality.
 *
 * - `file`         : the files carrier path
 * - `task_id`      : the files carrier's task identity field
 * - `status`       : the files carrier's requested status field
 * - `issue`/`pr`   : the GitHub carrier identity
 * - `carrier`      : the backend-qualified carrier name
 * - `headRefOid`   : a GitHub-only artifact identity
 * - `receipt`      : the transport mutation receipt, compared field by field by
 *                    `semanticEvidence()` and the success projection below
 */
const TRANSPORT_DOMAIN_FIELDS = Object.freeze([
  'file', 'task_id', 'status', 'issue', 'pr', 'carrier', 'headRefOid', 'receipt',
]);

/**
 * Replace the invoking command's *name* and the carrier's *identity*.
 *
 * Nothing else is rewritten. An earlier version also folded the phrase "task
 * body" into "task record", which is a generic semantic noun rather than a
 * command or carrier name: two backends describing the same condition in
 * genuinely different words would have been masked into agreement. If a
 * substantive phrase differs between backends the differential must fail and
 * the wording must be fixed at the source.
 */
function neutralizeCommandIdentity(text) {
  return String(text)
    // Command names.
    .replace(/task-body transition/g, '<transition command>')
    .replace(/task status/g, '<transition command>')
    // Carrier identities.
    .replace(/issue:\d+/g, '<carrier>')
    .replace(/#\d+/g, '<carrier>')
    .replace(/\.agenticloop\/tasks\/T-001\.md/g, '<carrier>')
    .replace(/(?:dependencies|stale)-(?:files|github)\.json/g, '<dependency snapshot>')
    // The two carriers hold different bytes by construction (the GitHub body
    // carries backend: github and its attribution line), so their *current*
    // digests differ. The expected digest is supplied identically to both and
    // is still compared verbatim.
    .replace(/the current digest is sha256:[0-9a-f]{64}/g, 'the current digest is <current carrier digest>')
    // Wall-clock age advances between the two invocations; the freshness policy
    // it is compared against is what the differential is asserting.
    .replace(/observed \d+s ago/g, 'observed <elapsed> ago');
}

/**
 * The closed normalized semantic projection of one refused transition.
 *
 * The canonical verification-result identity is recomputed through the real
 * public serializer after transport-only fields are replaced by fixed
 * placeholders, so the digest proves the whole remaining envelope matches -
 * not just the handful of fields spelled out beside it.
 */
function semanticEnvelope(result) {
  const value = JSON.parse(result.stdout);
  assert.equal(value.kind, 'agenticloop.validation-result', result.stdout);

  // Every field outside the closed envelope must be a known transport-domain
  // field. A new semantic field appearing on one backend only would fail here
  // rather than be silently excluded from the comparison.
  const extras = Object.keys(value).filter(key => !SEMANTIC_ENVELOPE_FIELDS.includes(key));
  assert.deepEqual(
    extras.filter(key => !TRANSPORT_DOMAIN_FIELDS.includes(key)),
    [],
    `unexpected non-transport field outside the semantic envelope: ${extras.join(', ')}`
  );

  const neutral = Object.fromEntries(
    SEMANTIC_ENVELOPE_FIELDS.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]])
  );
  neutral.command = '<transition command>';
  neutral.debugReference = null;
  neutral.errors = (value.errors ?? []).map(neutralizeCommandIdentity);
  neutral.diagnostics = (value.diagnostics ?? []).map(item => ({
    ...item,
    message: neutralizeCommandIdentity(item.message),
    ...(item.repairHint ? { repairHint: neutralizeCommandIdentity(item.repairHint) } : {}),
    ...(item.nextAction ? { nextAction: neutralizeCommandIdentity(item.nextAction) } : {}),
  }));
  if (Array.isArray(neutral.requiredContext)) {
    neutral.requiredContext = neutral.requiredContext.map(neutralizeCommandIdentity);
  }
  if (neutral.firstSafeRepair) neutral.firstSafeRepair = neutralizeCommandIdentity(neutral.firstSafeRepair);
  const diagnostics = value.diagnostics ?? [];
  return {
    exitStatus: result.status,
    ok: value.ok,
    evidenceState: value.evidenceState,
    disposition: value.disposition,
    rollbackAuthorized: value.rollbackAuthorized,
    committedStateEvaluated: value.committedStateEvaluated ?? null,
    diagnosticCommittedStateEvaluated: diagnostics.map(item => item.evidence?.committedStateEvaluated ?? null),
    requiredContext: neutral.requiredContext ?? null,
    diagnosticCodes: diagnostics.map(item => item.code),
    rootCause: diagnostics[0]?.code ?? null,
    failureCategories: value.failureCategories ?? [],
    errors: neutral.errors,
    firstSafeRepair: neutral.firstSafeRepair ?? null,
    verificationResultIdentity: validationResultDigest(neutral, {
      capabilities: getProjectRoleCapabilities(null),
    }),
  };
}

/**
 * Receipt fields that describe the transport rather than the outcome.
 *
 * Each is either the backend's own name, a digest taken over carrier bytes that
 * differ by construction, or the affordance for repeating the operation on that
 * carrier. Everything else in the receipt is compared verbatim.
 */
const TRANSPORT_RECEIPT_FIELDS = Object.freeze([
  'backend', 'expectedDigest', 'candidateDigest', 'resultingDigest',
  'evidenceContextDigest', 'changedPaths', 'revalidateCommand', 'rollback',
]);

/**
 * The closed normalized projection of one *successful* transition, plus its
 * canonical identity.
 *
 * This is the success-path counterpart of `semanticEnvelope()`. Neither backend
 * prints its validation result on success - both print a mutation receipt - so
 * the identity here is a canonical digest over the whole normalized success
 * result: the shared task identity, the complete evidence context, the
 * verification result kind, the owned projections, the mutation disposition and
 * resolution, and the transition. Any non-transport difference between the two
 * backends changes the digest.
 *
 * The two `verification.digest` values are deliberately *not* compared: each is
 * that backend's own validation-result identity and therefore embeds its own
 * command name. `verification.resultKind` is compared, so both must still be
 * reporting a canonical validation result.
 */
function semanticSuccess(result) {
  const value = JSON.parse(result.stdout);
  const receipt = value.receipt;
  assert.equal(receipt?.kind, 'agenticloop.task-mutation-receipt', result.stdout);
  assert.equal(receipt.verification.resultKind, 'agenticloop.validation-result');
  assert.match(receipt.verification.digest, /^sha256:agenticloop\.validation-result\.v1:[0-9a-f]{64}$/);

  const rewritten = ['task', 'evidenceContext', 'verification', 'recovery', 'ownedProjections', 'projections'];
  const semantic = Object.fromEntries(
    Object.entries(receipt).filter(([key]) =>
      !TRANSPORT_RECEIPT_FIELDS.includes(key) && !rewritten.includes(key))
  );
  const projection = {
    exitStatus: result.status,
    ...semantic,
    task: { ...receipt.task, carrier: '<carrier>' },
    evidenceContext: semanticEvidence(receipt),
    verificationResultKind: receipt.verification.resultKind,
    // A projection *name* is a carrier surface: files owns the task record's
    // status field, GitHub can only own the whole issue body. The count and
    // every other projection field are compared; the exact names are pinned by
    // explicit per-backend assertions in the success test rather than folded
    // into agreement here.
    ownedProjections: receipt.ownedProjections.map(() => '<owned carrier projection>'),
    projections: receipt.projections.map(item => ({ ...item, name: '<owned carrier projection>' })),
    recovery: receipt.recovery === null || receipt.recovery === undefined
      ? null
      : neutralizeCommandIdentity(receipt.recovery),
  };
  return { projection, identity: sha256(canonicalJson(projection)) };
}

/** The shared, backend-independent task contract projection. */
function semanticContract(body) {
  const contract = taskContractDigest(body);
  assert.equal(contract.ok, true, contract.error);
  const { backend: _backend, ...shared } = contract.projection;
  return shared;
}

/**
 * The complete evidence context a successful transition receipt carries.
 *
 * The dependency provenance object is kept and compared. The task object is
 * kept too: `task.id` is the shared, backend-independent identity of the record
 * being transitioned, and dropping the whole object let the two backends agree
 * while transitioning different tasks. Only `carrier` and `expectedDigest` are
 * genuinely transport-specific - the carrier names the file or the issue, and
 * its digest is taken over bytes that differ by construction - so those two are
 * replaced by fixed placeholders and everything else is compared verbatim.
 */
function semanticEvidence(receipt) {
  const { backend: _backend, task, ...shared } = receipt.evidenceContext;
  const { carrier: _carrier, expectedDigest: _expectedDigest, ...sharedTask } = task;
  const { evaluatedAt: _evaluatedAt, revalidationArgs: _revalidationArgs, provenance, ...dependencies } =
    shared.dependencies;
  return {
    ...shared,
    task: { ...sharedTask, carrier: '<carrier>', expectedDigest: '<expected carrier digest>' },
    dependencies: {
      ...dependencies,
      // Provenance is compared in full except for the snapshot's own path and
      // the commit that recorded it: each backend commits its own snapshot file.
      provenance: provenance === undefined ? null : {
        ...provenance,
        path: '<dependency snapshot>',
        commit: '<recording commit>',
        blob: '<recording blob>',
      },
    },
  };
}

function githubRunner(state) {
  return (_command, args) => {
    state.calls.push(args);
    if (args[0] === 'repo' && args[1] === 'view') {
      return { status: 0, stderr: '', stdout: JSON.stringify({ nameWithOwner: 'owner/repository' }) };
    }
    if (args[0] === 'api' && args[1] === 'user') {
      return { status: 0, stderr: '', stdout: JSON.stringify({ login: 'maintainer' }) };
    }
    if (args[0] === 'api' && args.includes('--paginate')) {
      return { status: 0, stderr: '', stdout: JSON.stringify([state.comments]) };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return { status: 0, stderr: '', stdout: JSON.stringify({ number: 71, body: state.body, labels: [] }) };
    }
    if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
      state.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      state.bodyWrites += 1;
      return { status: 0, stderr: '', stdout: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected gh invocation: ${args.join(' ')}` };
  };
}

/**
 * One shared workflow fixture: a committed, baselined task record materialized
 * on both carriers, plus committed Maintainer-attributed dependency evidence
 * for each.
 */
async function sharedWorkflow(name) {
  const root = mkdtempSync(join(temp, `${name}-`));
  createTaskProjectFixture(root);
  const created = await runCliInProcess(['task', 'new', 'Backend differential', '--scaffold', '--target', root]);
  assert.equal(created.status, 0, created.stderr);
  const file = join(root, '.agenticloop', 'tasks', 'T-001.md');
  git(root, ['add', '.agenticloop/tasks']);
  git(root, ['commit', '-m', 'record differential task']);
  const baseline = await runCliInProcess([
    'task', 'establish-baseline', 'T-001', '--actor', 'Agentic Loop Test',
    '--authority', 'task:T-001', '--target', root,
  ]);
  assert.equal(baseline.status, 0, baseline.stderr);
  git(root, ['add', '.agenticloop/task-contract-history']);
  git(root, ['commit', '-m', 'record differential baseline']);

  const dependencyPayload = `${JSON.stringify({
    kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
    source: 'files:.agenticloop/tasks', observedAt: new Date().toISOString(),
    freshnessPolicy: { maxAgeSeconds: 86400 }, statuses: {},
  })}\n`;
  writeFileSync(join(root, 'dependencies-files.json'), dependencyPayload, 'utf8');
  git(root, ['add', 'dependencies-files.json']);
  git(root, ['commit', '-m', 'record files dependency evidence\n\nTask: T-001\nAgent: maintainer']);
  writeFileSync(join(root, 'dependencies-github.json'), dependencyPayload, 'utf8');
  git(root, ['add', 'dependencies-github.json']);
  git(root, ['commit', '-m', 'record GitHub dependency evidence\n\nTask: <carrier>\nAgent: maintainer'.replace('<carrier>', '#71')]);

  // A stale snapshot both backends can be pointed at, committed the same way.
  const stalePayload = `${JSON.stringify({
    kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
    source: 'files:.agenticloop/tasks', observedAt: '2020-01-01T00:00:00.000Z',
    freshnessPolicy: { maxAgeSeconds: 60 }, statuses: {},
  })}\n`;
  writeFileSync(join(root, 'stale-files.json'), stalePayload, 'utf8');
  git(root, ['add', 'stale-files.json']);
  git(root, ['commit', '-m', 'record stale files dependency evidence\n\nTask: T-001\nAgent: maintainer']);
  writeFileSync(join(root, 'stale-github.json'), stalePayload, 'utf8');
  git(root, ['add', 'stale-github.json']);
  git(root, ['commit', '-m', 'record stale GitHub dependency evidence\n\nTask: #71\nAgent: maintainer']);

  const filesDraft = readFileSync(file, 'utf8');
  const githubDraft = `${filesDraft.replace(/^backend: files$/m, 'backend: github').trimEnd()}\n\n[[agent: maintainer]]\n`;
  const githubContract = taskContractDigest(githubDraft);
  assert.equal(githubContract.ok, true, githubContract.error);
  const timestamp = new Date().toISOString();
  const githubBaseline = createTaskContractBaselineRecord({
    recordId: 'github-comment:100', taskId: 'T-001', digest: githubContract.digest,
    projection: githubContract.projection, authority: 'maintainer:dispatch', actor: 'maintainer',
    timestamp, affectedArtifact: 'issue:71',
  });
  const state = {
    body: githubDraft,
    bodyWrites: 0,
    calls: [],
    comments: [{
      id: 100, html_url: 'https://example.test/issues/71#issuecomment-100',
      user: { login: 'maintainer' }, author_association: 'MEMBER',
      created_at: timestamp, updated_at: timestamp, body: renderTaskContractRecord(githubBaseline),
    }],
  };

  return {
    root,
    file,
    filesDraft,
    githubDraft,
    state,
    runner: githubRunner(state),
    /** Run the real files public path. */
    files(extra = []) {
      return runCliInProcess([
        'task', 'status', 'T-001', 'agent-ready',
        '--expect-digest', sha256(readFileSync(file, 'utf8')),
        '--base', 'HEAD', '--target', root, '--json', ...extra,
      ]);
    },
    /** Run the real GitHub public path. */
    github(extra = []) {
      return runCliInProcess([
        'task-body', 'transition', '--issue', '71', '--status', 'agent-ready',
        '--expect-digest', taskBodyDigest(state.body),
        '--base', 'HEAD', '--target', root, '--yes', '--json', ...extra,
      ], { ghCommandRunner: this.runner });
    },
  };
}

describe('backend semantic transition equivalence', () => {
  /**
   * Every refusal case below runs both real public paths and asserts a single
   * identical closed semantic result, then asserts neither carrier moved.
   */
  const REFUSAL_CASES = [
    {
      label: 'a root-malformed record carrying a UTF-8 BOM',
      setup(fx) {
        writeFileSync(fx.file, `﻿${fx.filesDraft}`, 'utf8');
        fx.state.body = `﻿${fx.githubDraft}`;
      },
      filesArgs: ['--dependencies', 'dependencies-files.json'],
      githubArgs: ['--dependencies', 'dependencies-github.json'],
    },
    {
      label: 'a stale expected digest',
      setup() {},
      filesArgs: ['--dependencies', 'dependencies-files.json', '--expect-digest', sha256('a different record')],
      githubArgs: ['--dependencies', 'dependencies-github.json', '--expect-digest', sha256('a different record')],
    },
    {
      label: 'missing dependency evidence',
      setup() {},
      filesArgs: [],
      githubArgs: [],
    },
    {
      label: 'dependency evidence that is not committed and attributed',
      setup(fx) {
        writeFileSync(join(fx.root, 'uncommitted.json'), '{"kind":"agenticloop.dependency-snapshot"}\n', 'utf8');
      },
      filesArgs: ['--dependencies', 'uncommitted.json'],
      githubArgs: ['--dependencies', 'uncommitted.json'],
    },
    {
      label: 'dependency evidence outside its declared freshness policy',
      setup() {},
      filesArgs: ['--dependencies', 'stale-files.json'],
      githubArgs: ['--dependencies', 'stale-github.json'],
    },
  ];

  for (const testCase of REFUSAL_CASES) {
    it(`refuses ${testCase.label} identically on both backends`, async () => {
      const fx = await sharedWorkflow(`refuse-${testCase.label.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}`);
      testCase.setup(fx);
      const filesBefore = readFileSync(fx.file, 'utf8');
      const githubBefore = fx.state.body;

      const filesResult = await fx.files(testCase.filesArgs);
      const githubResult = await fx.github(testCase.githubArgs);

      assert.equal(filesResult.status, 1, filesResult.stdout + filesResult.stderr);
      assert.equal(githubResult.status, 1, githubResult.stdout + githubResult.stderr);
      assert.deepEqual(
        semanticEnvelope(githubResult),
        semanticEnvelope(filesResult),
        `${testCase.label} must produce one semantic result on both backends`
      );

      // No mutation on either carrier, and no transport write attempt.
      assert.equal(readFileSync(fx.file, 'utf8'), filesBefore);
      assert.equal(fx.state.body, githubBefore);
      assert.equal(fx.state.bodyWrites, 0);
      assert.equal(fx.state.calls.some(args => args[0] === 'issue' && args[1] === 'edit'), false);
    });
  }

  it('refuses an illegal status transition on both backends without mutation', async () => {
    const fx = await sharedWorkflow('illegal-transition');
    const filesBefore = readFileSync(fx.file, 'utf8');
    const githubBefore = fx.state.body;

    // `accepted` is not reachable from the draft status either backend holds.
    const filesResult = await runCliInProcess([
      'task', 'status', 'T-001', 'accepted',
      '--expect-digest', sha256(filesBefore), '--target', fx.root, '--json',
    ]);
    const githubResult = await runCliInProcess([
      'task-body', 'transition', '--issue', '71', '--status', 'accepted',
      '--expect-digest', taskBodyDigest(githubBefore), '--target', fx.root, '--yes', '--json',
    ], { ghCommandRunner: fx.runner });

    assert.equal(filesResult.status, 1, filesResult.stdout + filesResult.stderr);
    assert.equal(githubResult.status, 1, githubResult.stdout + githubResult.stderr);

    assert.deepEqual(
      semanticEnvelope(githubResult),
      semanticEnvelope(filesResult),
      'illegal transitions must produce one canonical semantic result on both backends'
    );
    assert.match(filesResult.stdout, /accepted/, 'both backends must name the refused target status');

    assert.equal(readFileSync(fx.file, 'utf8'), filesBefore);
    assert.equal(fx.state.body, githubBefore);
    assert.equal(fx.state.bodyWrites, 0);
  });

  it('refuses closeout-owned generic terminal transition identically on both backends', async () => {
    const fx = await sharedWorkflow('terminal-generic-close');
    const filesAccepted = fx.filesDraft.replace(/^status: draft$/m, 'status: accepted');
    const githubAccepted = fx.githubDraft.replace(/^status: draft$/m, 'status: accepted');
    writeFileSync(fx.file, filesAccepted, 'utf8');
    fx.state.body = githubAccepted;
    mkdirSync(join(fx.root, '.agenticloop', 'audits'), { recursive: true });
    writeFileSync(join(fx.root, '.agenticloop', 'audits', 'AUD-001.md'), createAuditRecordContent({
      auditId: 'AUD-001',
      workUnit: 'work-unit:backend-equivalence',
      coveredTasks: ['T-001'],
      candidateArtifact: `commit:${git(fx.root, ['rev-parse', 'HEAD'])}`,
      goal: 'Prove backend-equivalent terminal ownership.',
      completionOracle: 'Both generic close paths refuse the closeout-owned task.',
      evidence: 'The differential compares both public mutation paths.',
    }), 'utf8');
    const filesBefore = readFileSync(fx.file, 'utf8');
    const githubBefore = fx.state.body;

    const filesResult = await runCliInProcess([
      'task', 'status', 'T-001', 'closed',
      '--expect-digest', sha256(filesBefore), '--target', fx.root, '--json',
    ]);
    const githubResult = await runCliInProcess([
      'task-body', 'transition', '--issue', '71', '--status', 'closed',
      '--expect-digest', taskBodyDigest(githubBefore), '--target', fx.root, '--yes', '--json',
    ], { ghCommandRunner: fx.runner });

    assert.equal(filesResult.status, 1, filesResult.stdout + filesResult.stderr);
    assert.equal(githubResult.status, 1, githubResult.stdout + githubResult.stderr);
    assert.deepEqual(
      semanticEnvelope(githubResult),
      semanticEnvelope(filesResult),
      'generic terminal refusal must produce one canonical semantic result on both backends'
    );
    assert.match(filesResult.stdout, /Generic task closure is refused \(explicit_task_set\//);
    assert.equal(readFileSync(fx.file, 'utf8'), filesBefore);
    assert.equal(fx.state.body, githubBefore);
    assert.equal(fx.state.bodyWrites, 0);
  });

  it('recovers and transitions to agent-ready with one shared semantic outcome', async () => {
    const fx = await sharedWorkflow('recovery');

    // Both carriers start root-malformed, are refused identically, are repaired
    // to the same normalized contract, and then transition through each
    // backend's real guarded public mutation path.
    writeFileSync(fx.file, `﻿${fx.filesDraft}`, 'utf8');
    fx.state.body = `﻿${fx.githubDraft}`;
    const filesFailed = await fx.files(['--dependencies', 'dependencies-files.json']);
    const githubFailed = await fx.github(['--dependencies', 'dependencies-github.json']);
    assert.equal(filesFailed.status, 1);
    assert.equal(githubFailed.status, 1);
    assert.deepEqual(semanticEnvelope(githubFailed), semanticEnvelope(filesFailed));
    assert.equal(readFileSync(fx.file, 'utf8'), `﻿${fx.filesDraft}`);
    assert.equal(fx.state.body, `﻿${fx.githubDraft}`);
    assert.equal(fx.state.bodyWrites, 0);

    writeFileSync(fx.file, fx.filesDraft, 'utf8');
    fx.state.body = fx.githubDraft;
    const filesOk = await fx.files(['--dependencies', 'dependencies-files.json']);
    const githubOk = await fx.github(['--dependencies', 'dependencies-github.json']);
    assert.equal(filesOk.status, 0, filesOk.stdout + filesOk.stderr);
    assert.equal(githubOk.status, 0, githubOk.stdout + githubOk.stderr);

    // The success path is held to a closed comparison too: one normalized
    // success result and one identity over it, not only a hand-picked receipt
    // projection. A backend that succeeded with a different disposition,
    // owned-projection set, transition, or evidence context fails here.
    const filesSuccess = semanticSuccess(filesOk);
    const githubSuccess = semanticSuccess(githubOk);
    assert.deepEqual(
      githubSuccess.projection,
      filesSuccess.projection,
      'a successful transition must produce one normalized semantic result on both backends'
    );
    assert.equal(
      githubSuccess.identity,
      filesSuccess.identity,
      'the normalized success result identity must match across backends'
    );

    const filesReceipt = JSON.parse(filesOk.stdout).receipt;
    const githubReceipt = JSON.parse(githubOk.stdout).receipt;
    assert.equal(validateTaskMutationReceipt(filesReceipt).ok, true);
    assert.equal(validateTaskMutationReceipt(githubReceipt).ok, true);

    // Closed success projection: outcome, disposition, and resolution match.
    assert.deepEqual(
      {
        mutationDisposition: githubReceipt.mutationDisposition,
        unresolved: githubReceipt.unresolved,
        transition: githubReceipt.transition,
      },
      {
        mutationDisposition: filesReceipt.mutationDisposition,
        unresolved: filesReceipt.unresolved,
        transition: filesReceipt.transition,
      }
    );
    assert.equal(filesReceipt.mutationDisposition, 'committed');
    assert.equal(filesReceipt.unresolved, false);

    // The complete evidence context, dependency provenance included.
    assert.deepEqual(semanticEvidence(githubReceipt), semanticEvidence(filesReceipt));

    // Dependency provenance was genuinely carried on both sides, not dropped.
    for (const receipt of [filesReceipt, githubReceipt]) {
      const provenance = receipt.evidenceContext.dependencies.provenance;
      assert.ok(provenance, 'dependency provenance must be present');
      assert.equal(provenance.role, 'maintainer');
      assert.match(provenance.blob, /^[0-9a-f]{40}$/);
      assert.match(provenance.commit, /^[0-9a-f]{40}$/);
    }
    // The two provenance objects carry the same field set; only the enumerated
    // transport-specific values differ.
    assert.deepEqual(
      Object.keys(githubReceipt.evidenceContext.dependencies.provenance).sort(),
      Object.keys(filesReceipt.evidenceContext.dependencies.provenance).sort()
    );
    assert.notEqual(
      githubReceipt.evidenceContext.dependencies.provenance.path,
      filesReceipt.evidenceContext.dependencies.provenance.path
    );

    // The resulting shared task contract is identical.
    assert.deepEqual(semanticContract(fx.state.body), semanticContract(readFileSync(fx.file, 'utf8')));
    assert.match(readFileSync(fx.file, 'utf8'), /^status: "?agent-ready"?$/m);
    assert.match(fx.state.body, /^status: "?agent-ready"?$/m);

    // Only the transport side effect differs: one wrote a file, one edited an issue.
    assert.equal(fx.state.bodyWrites, 1);
    assert.ok(fx.state.calls.some(args => args[0] === 'issue' && args[1] === 'edit'));
    assert.equal(filesReceipt.evidenceContext.backend, 'files');
    assert.equal(githubReceipt.evidenceContext.backend, 'github');
    assert.equal(filesReceipt.evidenceContext.task.carrier, '.agenticloop/tasks/T-001.md');
    assert.equal(githubReceipt.evidenceContext.task.carrier, 'issue:71');

    // The shared task identity is the same record on both carriers.
    assert.equal(filesReceipt.evidenceContext.task.id, 'T-001');
    assert.equal(githubReceipt.evidenceContext.task.id, 'T-001');

    // Owned projection names are the carrier surfaces the differential
    // placeholders; they are pinned here so a change is a deliberate edit.
    assert.deepEqual(filesReceipt.ownedProjections, ['task_record_status']);
    assert.deepEqual(githubReceipt.ownedProjections, ['issue_body']);
  });
});
