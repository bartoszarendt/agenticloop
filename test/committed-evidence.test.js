/**
 * Committed-source authority must survive
 * ordinary platform checkout behavior.
 *
 * The field record showed that `verifyCommittedAttributedSource` compared raw
 * working-tree bytes with the committed blob, so a clean Windows checkout
 * failed byte identity after CRLF conversion and any clean/smudge filter did
 * the same on every platform.
 *
 * These cases pin the corrected contract: Git decides whether the worktree path
 * is modified, and the committed blob (not the checked-out bytes) is the
 * authority the caller consumes. Genuinely modified, staged, untracked, and
 * misattributed sources must still fail exactly as before.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { verifyCommittedAttributedSource } from '../src/committed-source.js';
import { git, initTestGitRepository } from './helpers/git-fixture.js';

const MAINTAINER_MESSAGE = 'record evidence\n\nTask: T-001\nAgent: maintainer';
const EVIDENCE = '{"statuses":{}}\n';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-committed-evidence-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function fixture(name) {
  const root = mkdtempSync(join(temp, `${name}-`));
  initTestGitRepository(root, { userName: 'Agentic Loop Test', userEmail: 'loop@example.test' });
  writeFileSync(join(root, 'README.md'), 'fixture\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'fixture']);
  return root;
}

function commit(root, relPath, content, message) {
  mkdirSync(join(root, relPath, '..'), { recursive: true });
  writeFileSync(join(root, relPath), content, 'utf8');
  git(root, ['add', '--', relPath]);
  git(root, ['commit', '-m', message]);
}

/** Re-materialize the worktree copy so checkout filters and eol rules apply. */
function recheckout(root, relPath) {
  rmSync(join(root, relPath), { force: true });
  git(root, ['checkout', '--', relPath]);
}

describe('committed evidence is platform-safe', () => {
  it('accepts a clean checkout whose worktree bytes were CRLF-converted', () => {
    const root = fixture('crlf');
    // `text eol=crlf` normalizes to LF in the object database and materializes
    // CRLF in the worktree: exactly the ordinary Windows checkout shape.
    commit(root, '.gitattributes', 'evidence/*.json text eol=crlf\n', 'attributes\n\nTask: T-001\nAgent: maintainer');
    commit(root, 'evidence/dependencies.json', EVIDENCE, MAINTAINER_MESSAGE);
    recheckout(root, 'evidence/dependencies.json');

    const verified = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(verified.ok, true, `expected a clean CRLF checkout to verify: ${verified.error ?? ''}`);
    // The committed blob is the authority, so the caller sees canonical LF
    // content on every platform rather than the host's checkout spelling.
    assert.equal(verified.source, EVIDENCE);
    assert.match(verified.provenance.blob, /^[a-f0-9]{40,64}$/);
  });

  it('accepts a clean checkout materialized through a clean/smudge filter', () => {
    const root = fixture('filter');
    const filters = join(root, '.filters');
    mkdirSync(filters, { recursive: true });
    // Node is the only interpreter this suite can rely on cross-platform.
    writeFileSync(join(filters, 'clean.cjs'),
      "let b='';process.stdin.setEncoding('utf8');" +
      "process.stdin.on('data',c=>{b+=c});" +
      "process.stdin.on('end',()=>process.stdout.write(b.replace(/\\n+$/,'\\n')));\n",
      'utf8');
    writeFileSync(join(filters, 'smudge.cjs'),
      "let b='';process.stdin.setEncoding('utf8');" +
      "process.stdin.on('data',c=>{b+=c});" +
      "process.stdin.on('end',()=>process.stdout.write(b+'\\n'));\n",
      'utf8');
    const node = process.execPath.replace(/\\/g, '/');
    git(root, ['config', 'filter.altest.clean', `"${node}" "${join(filters, 'clean.cjs').replace(/\\/g, '/')}"`]);
    git(root, ['config', 'filter.altest.smudge', `"${node}" "${join(filters, 'smudge.cjs').replace(/\\/g, '/')}"`]);
    commit(root, '.gitattributes', 'evidence/*.json filter=altest\n', 'attributes\n\nTask: T-001\nAgent: maintainer');
    commit(root, 'evidence/dependencies.json', EVIDENCE, MAINTAINER_MESSAGE);
    recheckout(root, 'evidence/dependencies.json');

    const verified = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(verified.ok, true, `expected a filtered clean checkout to verify: ${verified.error ?? ''}`);
    assert.equal(verified.source, EVIDENCE, 'the committed blob, not the smudged worktree copy, is the authority');
  });

  it('still refuses genuinely modified, staged, untracked, and absent sources', () => {
    const root = fixture('negatives');
    commit(root, '.gitattributes', 'evidence/*.json text eol=crlf\n', 'attributes\n\nTask: T-001\nAgent: maintainer');
    commit(root, 'evidence/dependencies.json', EVIDENCE, MAINTAINER_MESSAGE);
    recheckout(root, 'evidence/dependencies.json');

    // Semantic modification, even expressed with the host's CRLF spelling.
    writeFileSync(join(root, 'evidence', 'dependencies.json'), '{"statuses":{"T-002":"blocked"}}\r\n', 'utf8');
    const modified = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(modified.ok, false);
    assert.equal(modified.evidenceState, 'changed');

    git(root, ['checkout', 'HEAD', '--', 'evidence/dependencies.json']);
    const restored = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(restored.ok, true, `expected the restored checkout to verify: ${restored.error ?? ''}`);

    // An untracked lookalike beside real evidence carries no committed authority.
    writeFileSync(join(root, 'evidence', 'lookalike.json'), EVIDENCE, 'utf8');
    const untracked = verifyCommittedAttributedSource(root, 'evidence/lookalike.json', { taskId: 'T-001' });
    assert.equal(untracked.ok, false);
    assert.equal(untracked.evidenceState, 'missing');

    // A deleted worktree copy is missing evidence even though HEAD still has it.
    rmSync(join(root, 'evidence', 'dependencies.json'), { force: true });
    const deleted = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(deleted.ok, false);
    assert.equal(deleted.evidenceState, 'missing');
  });

  it('refuses a staged difference whose worktree copy was restored', () => {
    // `git diff HEAD` compares the worktree against HEAD and ignores the index,
    // so this case is invisible to it and needs its own question.
    const root = fixture('staged-only');
    commit(root, 'evidence/dependencies.json', EVIDENCE, MAINTAINER_MESSAGE);
    writeFileSync(join(root, 'evidence', 'dependencies.json'), '{"statuses":{"T-002":"blocked"}}\n', 'utf8');
    git(root, ['add', '--', 'evidence/dependencies.json']);
    writeFileSync(join(root, 'evidence', 'dependencies.json'), EVIDENCE, 'utf8');

    const staged = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(staged.ok, false, 'an index that diverges from HEAD is pending, uncommitted drift');
    assert.equal(staged.evidenceState, 'changed');
    assert.match(staged.error, /staged difference/);
  });

  it('refuses a path whose worktree copy Git has been told to stop checking', () => {
    // `assume-unchanged` and `skip-worktree` make both diffs report nothing, so
    // "Git says unmodified" would otherwise be an unproven claim.
    for (const bit of ['--assume-unchanged', '--skip-worktree']) {
      const root = fixture(`bit-${bit.replace(/-/g, '')}`);
      commit(root, 'evidence/dependencies.json', EVIDENCE, MAINTAINER_MESSAGE);
      git(root, ['update-index', bit, '--', 'evidence/dependencies.json']);
      writeFileSync(join(root, 'evidence', 'dependencies.json'), '{"statuses":{"FORGED":"yes"}}\n', 'utf8');

      const checked = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
      assert.equal(checked.ok, false, `${bit} must not be able to suppress the drift gate`);
      assert.equal(checked.evidenceState, 'changed');
    }
  });

  it('refuses a target that is not the repository root, decoy or not', () => {
    // `HEAD:<path>` is root-relative while a pathspec and the filesystem read
    // are target-relative. A subdirectory target must never let a same-named
    // root file supply the blob, provenance, and attribution.
    const root = fixture('subdirectory-target');
    commit(root, 'evidence/dependencies.json', '{"statuses":{"ROOT":"DECOY"}}\n', MAINTAINER_MESSAGE);
    commit(root, 'app/evidence/dependencies.json', EVIDENCE, MAINTAINER_MESSAGE);

    const checked = verifyCommittedAttributedSource(join(root, 'app'), 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(checked.ok, false, 'a non-root target must be refused, not silently resolved against the root');
    assert.equal(checked.evidenceState, 'malformed');
    assert.match(checked.error, /repository root/);
    assert.doesNotMatch(String(checked.source ?? ''), /DECOY/);

    // The same file verifies normally when addressed from the repository root.
    const fromRoot = verifyCommittedAttributedSource(root, 'app/evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(fromRoot.ok, true, fromRoot.error ?? '');
    assert.equal(fromRoot.source, EVIDENCE);
  });

  it('keeps Maintainer attribution mandatory for a clean CRLF checkout', () => {
    const root = fixture('attribution');
    commit(root, '.gitattributes', 'evidence/*.json text eol=crlf\n', 'attributes\n\nTask: T-001\nAgent: maintainer');
    commit(root, 'evidence/dependencies.json', EVIDENCE, 'unattributed evidence');
    recheckout(root, 'evidence/dependencies.json');

    const verified = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(verified.ok, false);
    assert.equal(verified.evidenceState, 'malformed');
    assert.match(verified.error, /Maintainer attribution/);
  });
});
