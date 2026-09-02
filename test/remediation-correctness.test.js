import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCloseoutCandidateArtifact } from '../src/candidate.js';
import { validateCloseoutPacket } from '../src/closeout-contract.js';
import { recommendedStatusForReasons } from '../src/closeout.js';
import { groupExecutionAttempts } from '../src/execution-attempt.js';
import { evaluateToolingFailureRetry } from '../src/role-session-policy.js';
import { recordToolingFailure } from '../src/tooling-failure.js';
import { applyTaskEvidenceInput, validateAppliedTaskEvidence } from '../src/task-evidence.js';
import { parseVerificationAttempts } from '../src/verification-learning.js';
import { parseResolutionMatrix } from '../src/resolution-matrix.js';

const SHA = 'a'.repeat(40);
const CONTRACT = `sha256:v1:${'b'.repeat(64)}`;
const ATTEMPT_ID = `attempt:${'1'.repeat(32)}`;

function gitRunner({ exists = true } = {}) {
  return args => {
    const command = args.join(' ');
    if (command === 'rev-parse --is-inside-work-tree') return { status: 0, stdout: 'true\n', stderr: '' };
    if (command === `rev-parse --verify --quiet ${SHA}^{commit}`) return exists
      ? { status: 0, stdout: `${SHA}\n`, stderr: '' }
      : { status: 128, stdout: '', stderr: 'unknown revision' };
    throw new Error(`unexpected git command: ${command}`);
  };
}

function sections() {
  return {
    scopeCompleted: [], evidence: [], deviations: [], knownGaps: [], verificationAttempts: [],
    maintainerTriage: [], retryAuthorization: [], revisionResolution: [],
  };
}

function provenance(role) {
  return { workflowRole: role, invocationId: `invocation-${role}`, taskContractDigest: CONTRACT, attemptId: ATTEMPT_ID };
}

const simple = (id, status = 'recorded') => ({ id, summary: `${id} summary`, status, evidenceRefs: [`task:T-001`] });

describe('canonical closeout candidate boundary', () => {
  it('accepts only an existing exact full commit identity', () => {
    assert.deepEqual(resolveCloseoutCandidateArtifact('/repo', `commit:${SHA}`, { gitRunner: gitRunner() }), {
      ok: true, canonical: `commit:${SHA}`, verified: true,
    });
    for (const value of ['release:not-a-commit', 'commit:abcdef1', 'commit:not-a-sha']) {
      const result = resolveCloseoutCandidateArtifact('/repo', value, { gitRunner: gitRunner() });
      assert.equal(result.ok, false, value);
      assert.match(result.error, /commit:<full-git-sha>/);
    }
    assert.equal(resolveCloseoutCandidateArtifact('/repo', `commit:${SHA}`, { gitRunner: gitRunner({ exists: false }) }).ok, false);
  });

  it('rejects noncanonical packet candidates even when the packet is not completion eligible', () => {
    const errors = validateCloseoutPacket({ candidate_artifact: 'release:not-a-commit' });
    assert.ok(errors.some(error => error.includes('commit:<full-git-sha>')));
  });
});

describe('section-specific structured evidence', () => {
  const base = [
    '---', 'status: in-progress', '---', '',
    '```text', 'leave   this', '', '', 'fenced block unchanged', '```', '',
    '## Scope Completed', '', 'Existing scope prose.', '',
    '## Evidence', '', 'Existing evidence prose.', '',
    '## Deviations', '', 'None.', '',
    '## Known Gaps', '', 'None.', '',
    '## Verification Attempts', '', 'No verification attempts are currently recorded.', '',
    '## Maintainer Triage', '', 'None.', '',
    '## Retry Authorization', '', 'None.', '',
    '## Revision Resolution', '', 'None.', '',
  ].join('\n');

  it('round-trips all eight sections and preserves unrelated whitespace and fences byte-for-byte', () => {
    const engineer = {
      kind: 'agenticloop.task-evidence-input', schemaVersion: 1, actorRole: 'engineer', provenance: provenance('engineer'),
      sections: {
        ...sections(),
        scopeCompleted: [simple('scope-1', 'completed')], evidence: [simple('evidence-1')],
        deviations: [simple('deviation-1')], knownGaps: [simple('gap-1')],
        verificationAttempts: [{
          id: 'RC-1', attempt: 1, artifact: `commit:${SHA}`, command: 'npm test', strategy: 'focused',
          timeoutMs: 300000, outcome: 'failed', durationMs: 1200, required: true,
          partialEvidence: 'One focused assertion failed.', proposedNextStrategy: 'foreground',
          candidateClassification: 'one_off', recordedAt: '2026-08-01T12:00:00.000Z',
        }],
        revisionResolution: [{ id: 'F-1', summary: 'Corrected the finding.', status: 'resolved', evidenceRefs: ['commit:abcdef1'] }],
      },
    };
    const maintainer = {
      kind: 'agenticloop.task-evidence-input', schemaVersion: 1, actorRole: 'maintainer', provenance: provenance('maintainer'),
      sections: { ...sections(), maintainerTriage: [simple('triage-1', 'resolved')], retryAuthorization: [simple('retry-1', 'authorized')] },
    };
    const fenced = '```text\nleave   this\n\n\nfenced block unchanged\n```';
    const withEngineer = applyTaskEvidenceInput(base, engineer);
    const result = applyTaskEvidenceInput(withEngineer, maintainer);
    assert.ok(result.includes(fenced));
    for (const heading of Object.values({
      a: 'Scope Completed', b: 'Evidence', c: 'Deviations', d: 'Known Gaps',
      e: 'Verification Attempts', f: 'Maintainer Triage', g: 'Retry Authorization', h: 'Revision Resolution',
    })) assert.equal(result.match(new RegExp(`^## ${heading}$`, 'gm'))?.length, 1);
    assert.equal(parseVerificationAttempts(result).errors.length, 0);
    assert.equal(parseResolutionMatrix(result).errors.length, 0);
    assert.equal(validateAppliedTaskEvidence(result, engineer).ok, true);
    assert.equal(validateAppliedTaskEvidence(result, maintainer).ok, true);
  });

  it('rejects malformed input and duplicate or conflicting generated content', () => {
    const malformed = {
      kind: 'agenticloop.task-evidence-input', schemaVersion: 1, actorRole: 'maintainer', provenance: provenance('maintainer'),
      sections: { ...sections(), revisionResolution: [simple('F-1', 'resolved')] },
    };
    assert.throws(() => applyTaskEvidenceInput(base, malformed), /does not own/);
    const duplicated = base.replace('## Evidence', '## Evidence\n\nconflict\n\n## Evidence');
    const input = {
      kind: 'agenticloop.task-evidence-input', schemaVersion: 1, actorRole: 'engineer', provenance: provenance('engineer'),
      sections: { ...sections(), evidence: [simple('evidence-1')] },
    };
    assert.throws(() => applyTaskEvidenceInput(duplicated, input), /repeats the '## Evidence'/);
    const conflictingEntry = base.replace('## Evidence\n\nExisting evidence prose.', '## Evidence\n\n### evidence-1\n- Summary: prior text');
    assert.throws(() => applyTaskEvidenceInput(conflictingEntry, input), /conflicts with existing entry 'evidence-1'/);
  });
});

describe('retry admission and explicit attempt results', () => {
  const current = {
    taskId: 'T-001', taskContractDigest: CONTRACT, attemptId: ATTEMPT_ID,
    attemptState: 'live', contractCurrent: true, operation: 'task.role-start', signature: 'sig',
    mutationOccurred: false, safeToRetry: true,
  };

  it('classifies retry safety and status reasons deterministically', () => {
    assert.equal(evaluateToolingFailureRetry({ current, budget: 0 }).retryPermitted, false);
    assert.equal(evaluateToolingFailureRetry({ current, budget: 2 }).retryPermitted, true);
    assert.equal(evaluateToolingFailureRetry({ current: { ...current, mutationOccurred: true } }).retryPermitted, false);
    assert.equal(evaluateToolingFailureRetry({ current: { ...current, safeToRetry: false } }).retryPermitted, false);
    assert.equal(evaluateToolingFailureRetry({ current: { ...current, contractCurrent: false } }).retryPermitted, false);
    assert.equal(evaluateToolingFailureRetry({ current: { ...current, attemptState: 'returned' } }).retryPermitted, false);
    const statusCases = [
      [['audit_stale'], 'follow_up_required'],
      [['audit_candidate_missing'], 'follow_up_required'],
      [['audit_task_set_missing'], 'follow_up_required'],
      [['audit_stale', 'audit_candidate_missing'], 'follow_up_required'],
      [['audit_task_set_missing', 'audit_stale'], 'follow_up_required'],
      [['audit_stale', 'undisposed_findings'], 'follow_up_required'],
    ];
    for (const [categories, expected] of statusCases) {
      assert.equal(recommendedStatusForReasons(categories.map(category => ({ category }))), expected, categories.join(','));
    }
  });

  it('serializes grouping errors instead of hiding them on an array', () => {
    const result = groupExecutionAttempts({ returns: [{ recordId: 'orphan' }] });
    const serialized = JSON.parse(JSON.stringify(result));
    assert.equal(serialized.ok, false);
    assert.deepEqual(serialized.records, []);
    assert.equal(serialized.errors[0].code, 'attempt_return_unbound');
  });

  it('admits only one of two contenders for the final retry slot', () => {
    const target = mkdtempSync(join(tmpdir(), 'agenticloop-tooling-retry-'));
    try {
      const attempt = {
        attemptId: ATTEMPT_ID, state: 'live', packetId: 'dispatch:11111111-1111-4111-8111-111111111111',
        packetDigest: `sha256:agenticloop.dispatch-preparation.v6:${'c'.repeat(64)}`,
        invocationId: 'invocation-1', productBaseHead: SHA,
      };
      const input = {
        schemaVersion: 1, operation: 'task.role-start', diagnosticCode: 'host.spawn_failed', diagnosticClass: 'tooling',
        mutationOccurred: false, safeToRetry: true, provenance: { source: 'guarded-cli', operationRef: 'role-start' },
      };
      let inner = null;
      let injected = false;
      const outer = recordToolingFailure(target, {
        taskId: 'T-001', taskContractDigest: CONTRACT, currentTaskContractDigest: CONTRACT,
        attempt, input, budget: 2,
        mutationOptions: { beforeWrite: () => {
          if (injected) return;
          injected = true;
          inner = recordToolingFailure(target, {
            taskId: 'T-001', taskContractDigest: CONTRACT, currentTaskContractDigest: CONTRACT,
            attempt, input, budget: 2,
          });
        } },
      });
      assert.equal(inner.retryPermitted, true);
      assert.equal(outer.retryPermitted, false);
      assert.equal(outer.repeated, 2);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
