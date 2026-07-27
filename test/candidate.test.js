/**
 * Candidate artifact resolution and certified product-tree comparison tests.
 * Git behavior is injected; no real repository is needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCertifiedProductTree,
  isCanonicalCommitArtifact,
  resolveCandidateArtifact,
} from '../src/candidate.js';

const FULL_A = 'a'.repeat(40);
const FULL_B = 'b'.repeat(40);

function gitRunner(script) {
  return (args) => {
    const key = args.join(' ');
    for (const [pattern, response] of script) {
      if (key.includes(pattern)) return response;
    }
    return { status: 128, stdout: '', stderr: `unexpected: ${key}` };
  };
}

const workTreeOk = { status: 0, stdout: 'true\n', stderr: '' };

describe('candidate resolution', () => {
  it('resolves a short sha to one full commit inside a work tree', () => {
    const runner = gitRunner([
      ['--is-inside-work-tree', workTreeOk],
      [`rev-parse --verify --quiet abc123^{commit}`, { status: 0, stdout: `${FULL_A}\n`, stderr: '' }],
      ['--disambiguate abc123', { status: 0, stdout: `${FULL_A}\n`, stderr: '' }],
    ]);
    const result = resolveCandidateArtifact('/repo', 'commit:abc123', { gitRunner: runner });
    assert.equal(result.ok, true);
    assert.equal(result.canonical, `commit:${FULL_A}`);
    assert.equal(result.verified, true);
  });

  it('fails on a nonexistent commit before record creation', () => {
    const runner = gitRunner([
      ['--is-inside-work-tree', workTreeOk],
      [`rev-parse --verify --quiet deadbeef^{commit}`, { status: 128, stdout: '', stderr: 'bad revision' }],
    ]);
    const result = resolveCandidateArtifact('/repo', 'commit:deadbeef', { gitRunner: runner });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not resolve/);
    assert.ok(result.repair);
  });

  it('fails on an ambiguous prefix', () => {
    const runner = gitRunner([
      ['--is-inside-work-tree', workTreeOk],
      [`rev-parse --verify --quiet abc123^{commit}`, { status: 0, stdout: `${FULL_A}\n`, stderr: '' }],
      ['--disambiguate abc123', { status: 0, stdout: `${FULL_A}\n${FULL_B}\n`, stderr: '' }],
    ]);
    const result = resolveCandidateArtifact('/repo', 'commit:abc123', { gitRunner: runner });
    assert.equal(result.ok, false);
    assert.match(result.error, /ambiguous/);
  });

  it('accepts only a full canonical sha outside a work tree', () => {
    const noGit = gitRunner([['--is-inside-work-tree', { status: 128, stdout: '', stderr: 'not a repo' }]]);
    const short = resolveCandidateArtifact('/nowhere', 'commit:abc123', { gitRunner: noGit });
    assert.equal(short.ok, false);
    assert.match(short.error, /outside a git work tree/);
    const full = resolveCandidateArtifact('/nowhere', `commit:${FULL_A}`, { gitRunner: noGit });
    assert.equal(full.ok, true);
    assert.equal(full.verified, false);
  });

  it('passes non-commit immutable references through verbatim', () => {
    const result = resolveCandidateArtifact('/nowhere', 'artifact-bundle:2026-07-27T12:00Z');
    assert.equal(result.ok, true);
    assert.equal(result.canonical, 'artifact-bundle:2026-07-27T12:00Z');
  });

  it('recognizes canonical commit artifacts', () => {
    assert.equal(isCanonicalCommitArtifact(`commit:${FULL_A}`), true);
    assert.equal(isCanonicalCommitArtifact('commit:abc123'), false);
    assert.equal(isCanonicalCommitArtifact('commit:0000000'), false);
  });
});

describe('certified product-tree comparison', () => {
  const certified = `commit:${FULL_A}`;

  function treeRunner({ head = FULL_A, diff = '', status = '' } = {}) {
    return gitRunner([
      ['--is-inside-work-tree', workTreeOk],
      [`rev-parse --verify --quiet ${FULL_A}^{commit}`, { status: 0, stdout: `${FULL_A}\n`, stderr: '' }],
      ['rev-parse HEAD', { status: 0, stdout: `${head}\n`, stderr: '' }],
      [`diff --name-status -z ${FULL_A} HEAD`, { status: 0, stdout: diff, stderr: '' }],
      ['status --porcelain=v1 -z --untracked-files=all', { status: 0, stdout: status, stderr: '' }],
    ]);
  }

  it('passes when HEAD is the certified commit and the tree is clean', () => {
    const result = compareCertifiedProductTree('/repo', {
      certifiedArtifact: certified,
      auditRecordRelPath: '.agenticloop/audits/AUD-001.md',
      gitRunner: treeRunner(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'current');
  });

  it('allows the bound audit-record delta alone after certification', () => {
    const result = compareCertifiedProductTree('/repo', {
      certifiedArtifact: certified,
      auditRecordRelPath: '.agenticloop/audits/AUD-001.md',
      gitRunner: treeRunner({ head: FULL_B, diff: 'M\0.agenticloop/audits/AUD-001.md\0' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'current_with_workflow_metadata');
  });

  it('fails with exact path evidence on product drift after certification', () => {
    const result = compareCertifiedProductTree('/repo', {
      certifiedArtifact: certified,
      auditRecordRelPath: '.agenticloop/audits/AUD-001.md',
      gitRunner: treeRunner({ head: FULL_B, diff: 'M\0src/app.js\0M\0.agenticloop/audits/AUD-001.md\0' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'product_drift');
    assert.deepEqual(result.drift.map(item => item.path), ['src/app.js']);
  });

  it('treats a new untracked path as product drift (deny-by-default)', () => {
    const result = compareCertifiedProductTree('/repo', {
      certifiedArtifact: certified,
      auditRecordRelPath: '.agenticloop/audits/AUD-001.md',
      gitRunner: treeRunner({ status: '?? scratch-notes.txt\0' }),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.drift.map(item => item.path), ['scratch-notes.txt']);
  });

  it('treats dirty product files as drift', () => {
    const result = compareCertifiedProductTree('/repo', {
      certifiedArtifact: certified,
      gitRunner: treeRunner({ status: ' M src/app.js\0' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.drift[0].source, 'dirty');
  });

  it('treats both endpoints of committed product-to-workflow renames as product drift', () => {
    const result = compareCertifiedProductTree('/repo', {
      certifiedArtifact: certified,
      auditRecordRelPath: '.agenticloop/audits/AUD-001.md',
      gitRunner: treeRunner({
        head: FULL_B,
        diff: 'R100\0app.js\0.agenticloop/tmp/app.js\0',
      }),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.drift.map(item => item.path), ['app.js', '.agenticloop/tmp/app.js']);
  });

  it('treats both endpoints of dirty product-to-workflow renames as product drift', () => {
    const result = compareCertifiedProductTree('/repo', {
      certifiedArtifact: certified,
      auditRecordRelPath: '.agenticloop/audits/AUD-001.md',
      gitRunner: treeRunner({ status: 'R  .agenticloop/tmp/app.js\0app.js\0' }),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.drift.map(item => item.path), ['app.js', '.agenticloop/tmp/app.js']);
  });

  it('fails closed when the candidate cannot be verified', () => {
    const result = compareCertifiedProductTree('/nowhere', {
      certifiedArtifact: certified,
      gitRunner: gitRunner([['--is-inside-work-tree', { status: 128, stdout: '', stderr: 'x' }]]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'candidate_unverifiable');
  });

  it('names the migration repair for legacy non-canonical artifacts', () => {
    const result = compareCertifiedProductTree('/repo', {
      certifiedArtifact: 'commit:abc123',
      gitRunner: treeRunner(),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /--canonicalize/);
  });
});
