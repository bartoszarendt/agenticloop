/**
 * Task evidence integrity and provenance coverage.
 *
 * Fail-closed coverage for receipt identity, Git-state drift, closeout
 * provenance, cross-shell command rendering, and recovery outcome identity.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyGitHubTaskBody, taskBodyDigest } from '../src/github-task-body.js';
import { lifecycleMutationReceipt, readLifecycleReceipt } from '../src/lifecycle-plan.js';
import { LIFECYCLE_RECEIPT_RELATIVE_PATH } from '../src/layout.js';
import {
  createTaskEvidenceContext,
  createTaskMutationReceipt,
  shellQuoteArgument,
  taskEvidenceContextDigest,
  validateTaskEvidenceContext,
  validateTaskMutationReceipt,
} from '../src/task-evidence-contract.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-evidence-integrity-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

const D = character => `sha256:${character.repeat(64)}`;
const VALIDATION_DIGEST = `sha256:agenticloop.validation-result.v1:${'9'.repeat(64)}`;

function evidenceContext(overrides = {}) {
  return createTaskEvidenceContext({
    backend: 'files',
    task: { id: 'T-1', carrier: '.agenticloop/tasks/T-1.md', expectedDigest: D('a') },
    transition: { fromStatus: 'draft', toStatus: 'agent-ready' },
    base: { kind: 'git_tree', identity: `git-tree:${'d'.repeat(40)}`, inventoryDigest: D('b'), pathCount: 1, revalidationArgs: ['--base', 'main'] },
    dependencies: {
      source: 'file:x', digest: D('c'), observedAt: new Date().toISOString(),
      evaluatedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 86400 }, freshnessState: 'current',
      evaluatedState: 'satisfied', statuses: [], revalidationArgs: ['--dependencies', 'x.json'],
    },
    ...overrides,
  });
}

function receiptInput(overrides = {}) {
  return {
    candidateDigest: D('b'),
    resultingDigest: D('e'),
    mutationDisposition: 'committed',
    verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
    changedPaths: ['.agenticloop/tasks/T-1.md'],
    revalidateCommand: `npx agenticloop task-readiness --task-body .agenticloop/tasks/T-1.md --mode authoring --expect-task-digest ${D('e')} --base main --dependencies x.json`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A receipt may not contradict the context it embeds.
// ---------------------------------------------------------------------------

describe('receipt identity is bound to its embedded evidence context', () => {
  for (const [field, override] of [
    ['backend', { backend: 'github' }],
    ['task id', { taskId: 'T-OTHER' }],
    ['carrier', { carrier: 'issue:999' }],
    ['expected digest', { expectedDigest: D('f') }],
  ]) {
    it(`refuses a caller-supplied ${field} that contradicts the context`, () => {
      assert.throws(
        () => createTaskMutationReceipt({ context: evidenceContext(), ...receiptInput(override) }),
        /contradict|derived from the exact evidence context/i,
        `a receipt must not be able to disagree with its own context on ${field}`
      );
    });
  }

  it('rejects a persisted receipt whose fields disagree with its embedded context', () => {
    const context = evidenceContext();
    const honest = createTaskMutationReceipt({ context, ...receiptInput() });
    const tampered = {
      ...honest,
      backend: 'github',
      task: { id: 'T-OTHER', carrier: 'issue:999' },
      expectedDigest: D('f'),
    };
    const result = validateTaskMutationReceipt(tampered);
    assert.equal(result.ok, false, 'field equality with the context must be checked, not just the digest');
    const joined = result.errors.join('; ');
    for (const pattern of [/backend/i, /task/i, /expectedDigest|expected digest/i]) {
      assert.match(joined, pattern);
    }
  });

  it('rejects an unknown verification result kind', () => {
    assert.throws(
      () => createTaskMutationReceipt({
        context: evidenceContext(),
        ...receiptInput({ verification: { resultKind: 'anything', digest: VALIDATION_DIGEST } }),
      }),
      /resultKind/i
    );
  });

  it('rejects a verification digest that is not a canonical result digest', () => {
    assert.throws(
      () => createTaskMutationReceipt({
        context: evidenceContext(),
        ...receiptInput({ verification: { resultKind: 'agenticloop.validation-result', digest: 'not-a-digest' } }),
      }),
      /verification digest|digest/i
    );
  });

  it('still builds and validates an honest receipt', () => {
    const receipt = createTaskMutationReceipt({ context: evidenceContext(), ...receiptInput() });
    assert.equal(validateTaskMutationReceipt(receipt).ok, true);
    assert.equal(receipt.backend, 'files');
    assert.equal(receipt.task.id, 'T-1');
  });

  it('rejects revalidation commands for a different carrier, digest, base, or dependency snapshot', () => {
    const command = receiptInput().revalidateCommand;
    for (const forged of [
      command.replace('.agenticloop/tasks/T-1.md', '.agenticloop/tasks/T-2.md'),
      command.replace(D('e'), D('f')),
      command.replace('--base main', '--base other'),
      command.replace('--dependencies x.json', '--dependencies other.json'),
    ]) {
      assert.throws(
        () => createTaskMutationReceipt({
          context: evidenceContext(),
          ...receiptInput({ revalidateCommand: forged }),
        }),
        /revalidateCommand must exactly bind/
      );
    }
  });

  it('derives dependency state and freshness instead of trusting asserted summaries', () => {
    const context = evidenceContext();
    const dependencies = context.dependencies;
    const {
      kind: _kind,
      schemaVersion: _schemaVersion,
      ...contextInput
    } = context;
    assert.throws(
      () => createTaskEvidenceContext({
        ...contextInput,
        dependencies: {
          ...dependencies,
          statuses: [{ id: 'T-BLOCKED', status: 'blocked' }],
          evaluatedState: 'satisfied',
        },
      }),
      /evaluatedState must be 'unsatisfied'/
    );
    assert.throws(
      () => createTaskEvidenceContext({
        ...contextInput,
        dependencies: {
          ...dependencies,
          statuses: [
            { id: 'T-DUPLICATE', status: 'accepted' },
            { id: 'T-DUPLICATE', status: 'accepted' },
          ],
        },
      }),
      /duplicate dependency ids/
    );
    assert.throws(
      () => createTaskEvidenceContext({
        ...contextInput,
        dependencies: {
          ...dependencies,
          observedAt: '2020-01-01T00:00:00.000Z',
          freshnessPolicy: { maxAgeSeconds: 1 },
          freshnessState: 'current',
        },
      }),
      /freshnessState must be 'stale'/
    );
    const historical = createTaskEvidenceContext({
      ...contextInput,
      dependencies: {
        ...dependencies,
        observedAt: '2020-01-01T00:00:00.000Z',
        evaluatedAt: '2020-01-01T00:00:00.500Z',
        freshnessPolicy: { maxAgeSeconds: 1 },
        freshnessState: 'current',
      },
    });
    assert.equal(validateTaskEvidenceContext(historical).ok, true);
    assert.equal(taskEvidenceContextDigest(historical), taskEvidenceContextDigest(historical));
  });
});

// ---------------------------------------------------------------------------
// The prior gate must notice Git-state drift that leaves bytes alone.
// ---------------------------------------------------------------------------

describe('prior-gate receipts re-verify Git state, not only bytes', () => {
  function git(root, args) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  }

  it('reports drift when a recorded path leaves the index without changing bytes', () => {
    const root = mkdtempSync(join(temp, 'gate-git-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'Test']);
    git(root, ['config', 'user.email', 'test@example.test']);
    mkdirSync(join(root, '.agenticloop'), { recursive: true });
    writeFileSync(join(root, 'tracked.md'), 'content\n');
    git(root, ['add', 'tracked.md']);
    git(root, ['commit', '-q', '-m', 'tracked']);

    const receipt = lifecycleMutationReceipt(
      root,
      { command: 'init', actions: [], adapterGroups: [], blockers: [], warnings: [], schemaVersion: 1 },
      { ok: true, committedPaths: ['tracked.md'], committedSegments: ['toolkit'] }
    );
    assert.equal(receipt.unresolved, false, 'a committed clean path is a resolved gate');
    writeFileSync(join(root, LIFECYCLE_RECEIPT_RELATIVE_PATH), `${JSON.stringify(receipt, null, 2)}\n`);
    const before = readLifecycleReceipt(root);
    assert.equal(before.drift.length, 0, 'no drift before the change');
    assert.equal(before.observed.commitDisposition, 'committed');
    assert.equal(before.observed.unresolved, false, 'a committed clean path reads as resolved');

    // The bytes never change; only the Git state does.
    git(root, ['rm', '--cached', '-q', 'tracked.md']);
    assert.equal(readFileSync(join(root, 'tracked.md'), 'utf8'), 'content\n');

    const read = readLifecycleReceipt(root);
    assert.equal(read.state, 'present');
    assert.equal(
      read.observed.commitDisposition,
      'uncommitted',
      'a path that left the index must not still re-derive as committed'
    );
    assert.equal(
      read.observed.unresolved,
      true,
      'the gate must read as unresolved once its recorded state stopped being true'
    );
    assert.equal(read.receipt.commitDisposition, 'committed', 'the recorded value is unchanged history');
  });

  it('re-resolves the gate when the listed paths are committed', () => {
    const root = mkdtempSync(join(temp, 'gate-resolve-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'Test']);
    git(root, ['config', 'user.email', 'test@example.test']);
    mkdirSync(join(root, '.agenticloop'), { recursive: true });
    writeFileSync(join(root, 'written.md'), 'content\n');

    const receipt = lifecycleMutationReceipt(
      root,
      { command: 'init', actions: [], adapterGroups: [], blockers: [], warnings: [], schemaVersion: 1 },
      { ok: true, committedPaths: ['written.md'], committedSegments: ['toolkit'] }
    );
    assert.equal(receipt.unresolved, true, 'an untracked path is an unresolved gate');
    writeFileSync(join(root, LIFECYCLE_RECEIPT_RELATIVE_PATH), `${JSON.stringify(receipt, null, 2)}\n`);
    assert.equal(readLifecycleReceipt(root).observed.unresolved, true);

    // The receipt's own next action offers committing the listed paths as the
    // resolution, so doing exactly that must resolve the gate.
    git(root, ['add', 'written.md']);
    git(root, ['commit', '-q', '-m', 'commit setup output']);
    const read = readLifecycleReceipt(root);
    assert.equal(read.drift.length, 0, 'committing the listed paths is not drift');
    assert.equal(read.observed.unresolved, false, 'committing the listed paths resolves the gate');
  });
});

// ---------------------------------------------------------------------------
// Emitted revalidation arguments must also be inert under cmd.exe.
// ---------------------------------------------------------------------------

describe('emitted revalidation arguments are inert in every supported shell', () => {
  it('refuses values carrying cmd.exe expansion or quoting characters', () => {
    for (const hostile of [
      '$(whoami)', '`whoami`', '${HOME}', 'a"b', "a'b",
      '%USERPROFILE%', 'a!b!', 'a b\\', 'with space\\\\dir',
    ]) {
      assert.throws(() => shellQuoteArgument(hostile), /shell-safe|backslash/i, `${hostile} must be refused`);
    }
    // Backslashes are active escapes when unquoted in POSIX shells. Interior
    // backslashes therefore force double quoting; a trailing one is refused
    // because it would escape the shared closing quote.
    assert.equal(shellQuoteArgument('C:\\path'), '"C:\\path"');
    assert.throws(() => shellQuoteArgument('C:\\path\\'), /backslash/i);
  });

  it('renders separator characters inertly rather than refusing them', () => {
    assert.equal(shellQuoteArgument('with space & echo INJECTED'), '"with space & echo INJECTED"');
    assert.equal(shellQuoteArgument('a|b'), '"a|b"');
    assert.equal(shellQuoteArgument('simple.json'), 'simple.json');
    assert.equal(shellQuoteArgument(''), '""');
  });

  // The emitted string is executed by a real shell, not tokenized by a test
  // parser: a quoting bug that only a custom parser forgives is exactly the
  // defect this pins.
  const hostile = 'with space & echo INJECTED';
  const quoted = () => shellQuoteArgument(hostile);

  function runsInertly(command, args) {
    const probe = spawnSync(command, args, { encoding: 'utf8' });
    if (probe.error) return null;
    return `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  }

  it('is inert under cmd.exe', { skip: process.platform !== 'win32' }, () => {
    const output = runsInertly('cmd.exe', ['/c', `echo ${quoted()}`]);
    if (output === null) return;
    assert.doesNotMatch(output, /^INJECTED$/m, `cmd.exe executed the injected command: ${output}`);
    assert.match(output, /with space & echo INJECTED/);
    const probe = join(temp, 'shell-quote-path.cmd');
    writeFileSync(probe, `@for %%A in (${shellQuoteArgument('C:\\path')}) do @echo %%~A\r\n`, 'utf8');
    const pathOutput = runsInertly('cmd.exe', ['/d', '/c', probe]);
    assert.equal(pathOutput?.trim(), 'C:\\path');
  });

  it('is inert under PowerShell', { skip: process.platform !== 'win32' }, () => {
    const output = runsInertly('pwsh', ['-NoProfile', '-Command', `Write-Output ${quoted()}`]);
    if (output === null) return;
    assert.doesNotMatch(output, /^INJECTED$/m, `PowerShell executed the injected command: ${output}`);
    const pathOutput = runsInertly('pwsh', ['-NoProfile', '-Command', `Write-Output ${shellQuoteArgument('C:\\path')}`]);
    assert.equal(pathOutput?.trim(), 'C:\\path');
  });

  it('is inert under a POSIX shell', () => {
    const output = runsInertly('sh', ['-c', `printf '%s\\n' ${quoted()}`]);
    if (output === null) return;
    assert.doesNotMatch(output, /^INJECTED$/m, `sh executed the injected command: ${output}`);
    assert.match(output, /with space & echo INJECTED/);
    const pathOutput = runsInertly('sh', ['-c', `printf '%s' ${shellQuoteArgument('C:\\path')}`]);
    assert.equal(pathOutput, 'C:\\path');
  });
});

// ---------------------------------------------------------------------------
// Resume comparison uses the canonical provenance projection.
// ---------------------------------------------------------------------------

describe('closeout resume compares every authoritative provenance fact', () => {
  it('covers every field the canonical provenance projection defines', async () => {
    const { closeoutProvenanceProjection } = await import('../src/closeout-contract.js');
    const packet = {
      work_unit: 'milestone:M00',
      covered_tasks: ['T-001'],
      candidate_artifact: `commit:${'a'.repeat(40)}`,
      audit: null,
      audit_opt_out: true,
      backend: 'github',
      carrier: { kind: 'issue', reference: 'issue:1', revision: D('a') },
      plan_sync: 'none',
      gates: [{ id: 'review', passed: true }],
      finding_dispositions: [{ run: 1, finding_id: 'F-1', disposition: 'resolved' }],
      improvement_refs: [],
      predecessor_marker: 'none',
      reasons: [],
      publishable: true,
      completion_eligible: true,
      recommended_status: 'complete',
    };
    const projected = Object.keys(closeoutProvenanceProjection(packet));
    // Each authoritative field must actually change the compared projection.
    // A field the comparison forgets is a field a resume silently exempts.
    const mutations = {
      work_unit: 'milestone:M01',
      covered_tasks: ['T-002'],
      candidate_artifact: `commit:${'b'.repeat(40)}`,
      audit: { audit_id: 'AUD-001', audit_schema_version: 2, run: 1, verdict: 'pass', report_format: 'markdown' },
      audit_opt_out: false,
      backend: 'files',
      carrier: { kind: 'issue', reference: 'issue:1', revision: D('b') },
      plan_sync: 'synced',
      gates: [{ id: 'review', passed: false }],
      finding_dispositions: [{ run: 1, finding_id: 'F-1', disposition: 'deferred' }],
      improvement_refs: ['IMP-1'],
      predecessor_marker: D('c'),
    };
    const baseline = JSON.stringify(closeoutProvenanceProjection(packet));
    for (const field of projected) {
      if (field === 'packet_schema' || field === 'marker_schema') continue;
      assert.ok(Object.hasOwn(mutations, field), `no adversarial mutation defined for '${field}'`);
      const mutated = closeoutProvenanceProjection({ ...packet, [field]: mutations[field] });
      assert.notEqual(
        JSON.stringify(mutated),
        baseline,
        `'${field}' is an authoritative provenance field but changing it does not change the projection`
      );
    }
  });

  it('fails closed on a substantive carrier edit after publication', async () => {
    const { closeoutProvenanceProjection } = await import('../src/closeout-contract.js');
    const { packetFactsUnchanged } = await import('../src/closeout-cli.js');
    const packet = {
      work_unit: 'milestone:M00', covered_tasks: ['T-001'],
      candidate_artifact: `commit:${'a'.repeat(40)}`, audit: null, audit_opt_out: true,
      backend: 'github', carrier: { kind: 'issue', reference: 'issue:1', revision: D('a') },
      plan_sync: 'none', gates: [], finding_dispositions: [], improvement_refs: [],
      predecessor_marker: 'none',
      reasons: [], publishable: true, completion_eligible: true, recommended_status: 'complete',
    };
    // Marker publication is normalized out of a carrier revision, so a changed
    // revision means a substantive carrier edit and nothing else.
    const edited = { ...packet, carrier: { ...packet.carrier, revision: D('b') } };
    assert.notEqual(
      JSON.stringify(closeoutProvenanceProjection(edited)),
      JSON.stringify(closeoutProvenanceProjection(packet)),
      'a carrier revision change must be visible to the resume comparison'
    );
    assert.equal(
      packetFactsUnchanged({ packet: edited }, packet),
      false,
      'the actual resume comparison must not exempt a substantive carrier revision change'
    );
  });
});

// ---------------------------------------------------------------------------
// An outcome marker proves nothing about a different operation.
// ---------------------------------------------------------------------------

describe('recovery provenance requires an outcome marker for the exact operation', () => {
  const body = title => [
    '---', 'task_id: T-701', 'task_contract_schema: 2', 'status: draft', 'backend: github',
    'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**',
    'intended_creations:', '  - src/new.js', '---', '', `# ${title}`, '',
    '## Task', 'Guarded publication.', '', '## Source Documents Reviewed', '- README.md', '',
    '## Current State', 'Draft.', '', '## Scope', 'One field.', '', '## Out of Scope', 'Everything else.', '',
    '## Acceptance Criteria', '- valid', '', '## Required Checks', '- npm test', '',
    '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'none', '',
    '## Completion Summary Template', 'none', '', '## Reviewer Checklist', '- [ ] review', '',
    '[[agent: maintainer]]',
  ].join('\n');

  function transport(state) {
    return (_command, args) => {
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify([[]]) };
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ number: 71, body: state.body, labels: [] }) };
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
        if (state.failBodyEdit) return { status: 1, stderr: 'transport refused' };
        state.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
        state.bodyWrites += 1;
        return { status: 0, stdout: '' };
      }
      return { status: 1, stderr: `unexpected ${args.join(' ')}` };
    };
  }

  function outcomeFileIn(dir, fs = null) {
    const names = (fs ?? require('node:fs')).readdirSync(dir).filter(name => name.endsWith('-outcome.json'));
    assert.equal(names.length, 1, 'exactly one outcome marker is expected');
    return join(dir, names[0]);
  }

  it('does not accept an outcome marker naming a different operation', async () => {
    const { readdirSync } = await import('node:fs');
    const recoveryDir = mkdtempSync(join(temp, 'recovery-mismatch-'));
    const original = body('Draft');
    const candidate = body('Published');

    const state = { body: original, bodyWrites: 0, failBodyEdit: true };
    const failed = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      commandRunner: transport(state), recoveryDir,
    });
    assert.equal(failed.publicationProvenance, 'ambiguous_response_not_applied');

    // Forge the outcome: claim the write applied, but under another operation id.
    const names = readdirSync(recoveryDir).filter(name => name.endsWith('-outcome.json'));
    assert.equal(names.length, 1);
    const outcomePath = join(recoveryDir, names[0]);
    const forged = JSON.parse(readFileSync(outcomePath, 'utf8'));
    writeFileSync(outcomePath, JSON.stringify({
      ...forged, outcome: 'applied', operationId: 'different-operation',
    }, null, 2));

    state.body = candidate;
    state.failBodyEdit = false;
    const retried = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      commandRunner: transport(state), recoveryDir,
    });
    assert.notEqual(
      retried.publicationProvenance,
      'receipt_proven_prior_write',
      'an outcome marker for another operation must not confer publication provenance'
    );
    assert.equal(retried.ok, false);
  });

  it('does not accept a malformed outcome marker', async () => {
    const { readdirSync } = await import('node:fs');
    const recoveryDir = mkdtempSync(join(temp, 'recovery-malformed-'));
    const original = body('Draft');
    const candidate = body('Published');
    const state = { body: original, bodyWrites: 0, failBodyEdit: true };
    applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      commandRunner: transport(state), recoveryDir,
    });
    const names = readdirSync(recoveryDir).filter(name => name.endsWith('-outcome.json'));
    writeFileSync(join(recoveryDir, names[0]), '{ not json');

    state.body = candidate;
    state.failBodyEdit = false;
    const retried = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      commandRunner: transport(state), recoveryDir,
    });
    assert.notEqual(retried.publicationProvenance, 'receipt_proven_prior_write');
    assert.equal(retried.ok, false);
  });

  it('does not accept a structurally incomplete outcome marker', async () => {
    const { readdirSync } = await import('node:fs');
    const recoveryDir = mkdtempSync(join(temp, 'recovery-incomplete-'));
    const original = body('Draft');
    const candidate = body('Published');
    const state = { body: original, bodyWrites: 0, failBodyEdit: true };
    applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      commandRunner: transport(state), recoveryDir,
    });
    const names = readdirSync(recoveryDir).filter(name => name.endsWith('-outcome.json'));
    const outcomePath = join(recoveryDir, names[0]);
    const marker = JSON.parse(readFileSync(outcomePath, 'utf8'));
    delete marker.observedAt;
    marker.outcome = 'applied';
    writeFileSync(outcomePath, JSON.stringify(marker));

    state.body = candidate;
    state.failBodyEdit = false;
    const retried = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      commandRunner: transport(state), recoveryDir,
    });
    assert.notEqual(retried.publicationProvenance, 'receipt_proven_prior_write');
    assert.equal(retried.ok, false);
  });
});
