import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyParallelPair,
  collectArtifactChangedPaths,
  collectGitHubArtifactChangedPaths,
  evaluateTaskEligibility,
  parseArtifactRange,
  parseOwnershipDeclaration,
  validateArtifactOwnership,
  validateChangedPathsAgainstOwnership,
  validateManagedJoinFreshness,
  validateManagedReconciliation,
  validateSharedMutationContents,
} from '../src/parallel-ownership.js';
import { initTestGitRepository } from './helpers/git-fixture.js';

const BASE = 'a'.repeat(40);
const LEFT_HEAD = 'b'.repeat(40);
const RIGHT_HEAD = 'c'.repeat(40);
const JOIN_HEAD = 'd'.repeat(40);

function taskBody({ allowedPaths, ownedPaths, sharedMutations = '', eligibility = 'eligible', knowledge = 'independent' }) {
  return [
    '---',
    'allowed_paths:',
    ...allowedPaths.map(path => `  - ${path}`),
    ...(ownedPaths === null
      ? []
      : ownedPaths.length === 0
        ? ['owned_paths: []']
        : ['owned_paths:', ...ownedPaths.map(path => `  - ${path}`)]),
    ...(sharedMutations ? [sharedMutations] : []),
    '---',
    '# Task',
    '## Parallel Safety',
    `- **Parallel eligibility**: ${eligibility}`,
    `- **Knowledge coupling**: ${knowledge}`,
  ].join('\n');
}

function lane(taskId, body, head) {
  return {
    taskId,
    artifact: { base: BASE, head },
    declaration: parseOwnershipDeclaration(body),
  };
}

function managedPlan(...lanes) {
  return {
    classifiedBy: 'maintainer',
    dependencyIndependent: true,
    knowledgeIndependent: true,
    compositionOrder: lanes.map(item => item.taskId),
    joinTask: { taskId: 'JOIN-001', attemptBudget: 2, lease: 'return after each conflict resolution' },
    integratedChecks: ['npm test'],
    escalation: 'route semantic uncertainty to Maintainer',
    operations: lanes.flatMap(item => (item.declaration.sharedMutations ?? []).map(mutation => ({
      taskId: item.taskId,
      ...mutation,
    }))),
  };
}

function git(cwd, args, expectedStatus = 0) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  assert.equal(
    result.status,
    expectedStatus,
    `git ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout.trim();
}

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'al-p30-git-'));
  initTestGitRepository(repo, {
    initialBranch: 'main',
    quiet: true,
    userName: 'Agentic Loop Test',
    userEmail: 'agenticloop@example.invalid',
  });
  return repo;
}

describe('structured ownership declarations', () => {
  it('keeps the canonical serial task template out of structured ownership', () => {
    const template = readFileSync(new URL('../memory/task-record.md', import.meta.url), 'utf-8');
    const declaration = parseOwnershipDeclaration(template);
    assert.equal(declaration.present, false);
    assert.equal(declaration.ownedPaths, null);
  });

  it('keeps broad allowed scope separate from narrow owned writes (P30-S1)', () => {
    const declaration = parseOwnershipDeclaration(taskBody({
      allowedPaths: ['api/**'],
      ownedPaths: ['api/error_mapping.py'],
    }));

    assert.deepEqual(declaration.errors, []);
    assert.deepEqual(declaration.ownedPaths, ['api/error_mapping.py']);
    assert.equal(evaluateTaskEligibility(declaration), 'eligible');
  });

  it('rejects malformed, unsafe, uncontained, and shared-glob declarations', () => {
    const scalar = parseOwnershipDeclaration(taskBody({
      allowedPaths: ['src/**'],
      ownedPaths: null,
    }).replace('---\n# Task', 'owned_paths: src/file.js\n---\n# Task'));
    assert.ok(scalar.errors.some(error => error.includes("'owned_paths' must be a YAML list")));

    const unsafe = parseOwnershipDeclaration(taskBody({
      allowedPaths: ['src/**'],
      ownedPaths: ['../secrets.txt'],
    }));
    assert.ok(unsafe.errors.some(error => error.includes('unsafe or malformed')));

    const uncontained = parseOwnershipDeclaration(taskBody({
      allowedPaths: ['api/**'],
      ownedPaths: ['schemas/model.py'],
    }));
    assert.ok(uncontained.errors.some(error => error.includes('not mechanically contained')));

    const sharedGlob = parseOwnershipDeclaration(taskBody({
      allowedPaths: ['schemas/**'],
      ownedPaths: ['schemas/order.py'],
      sharedMutations: [
        'shared_mutations:',
        '  schemas/*.py:',
        '    operation: add_export',
        '    target: Order',
      ].join('\n'),
    }));
    assert.ok(sharedGlob.errors.some(error => error.includes('exact file, not a glob')));
  });

  it('requires exact supported operations and rejects ineligible shared resources', () => {
    const invalidOperation = parseOwnershipDeclaration(taskBody({
      allowedPaths: ['package.json'],
      ownedPaths: ['src/commands.js'],
      sharedMutations: [
        'shared_mutations:',
        '  package.json:',
        '    operation: replace_dependency',
        '    target: dependencies.react',
      ].join('\n'),
    }));
    assert.ok(invalidOperation.errors.some(error => error.includes('operation')));

    const lockfile = parseOwnershipDeclaration(taskBody({
      allowedPaths: ['package-lock.json'],
      ownedPaths: ['src/commands.js'],
      sharedMutations: [
        'shared_mutations:',
        '  package-lock.json:',
        '    operation: add_export',
        '    target: Generated',
      ].join('\n'),
    }));
    assert.ok(lockfile.errors.some(error => error.includes('ineligible for managed join')));
  });

  it('allows a fully declared shared-only lane to be eligible', () => {
    const declaration = parseOwnershipDeclaration(taskBody({
      allowedPaths: ['package.json'],
      ownedPaths: [],
      sharedMutations: 'shared_mutations:\n  package.json:\n    operation: add_json_key\n    target: scripts.check-api',
    }));
    assert.equal(evaluateTaskEligibility(declaration), 'eligible');
  });
});

describe('artifact-bound changed-file accounting', () => {
  const declaration = parseOwnershipDeclaration(taskBody({
    allowedPaths: ['src/**', 'schemas/**'],
    ownedPaths: ['src/error_mapping.js'],
    sharedMutations: [
      'shared_mutations:',
      '  schemas/__init__.py:',
      '    operation: add_export',
      '    target: ErrorSchema',
    ].join('\n'),
  }));

  it('derives changes from the exact recorded range, not git status', () => {
    const calls = [];
    const changed = collectArtifactChangedPaths('/repo', `range:${BASE}..${LEFT_HEAD}`, (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: 'src/error_mapping.js\nschemas/__init__.py\n', stderr: '' };
    });

    assert.deepEqual(calls, [['git', ['diff', '--name-only', `${BASE}..${LEFT_HEAD}`]]]);
    assert.deepEqual(changed.paths, ['src/error_mapping.js', 'schemas/__init__.py']);
    assert.equal(validateChangedPathsAgainstOwnership(changed.paths, declaration).ok, true);

    const validated = validateArtifactOwnership({
      repoRoot: '/repo',
      artifact: `range:${BASE}..${LEFT_HEAD}`,
      declaration,
      commandRunner: (command, args) => {
        if (args[0] === 'diff') {
          return { status: 0, stdout: 'src/error_mapping.js\nschemas/__init__.py\n', stderr: '' };
        }
        const baseContent = 'from .existing import Existing\n';
        return {
          status: 0,
          stdout: args[1].startsWith(`${BASE}:`)
            ? baseContent
            : `${baseContent}from .error import ErrorSchema\n`,
          stderr: '',
        };
      },
    });
    assert.equal(validated.ok, true, validated.errors.join('\n'));
  });

  it('fails closed on missing artifact identity and unexpected actual writes', () => {
    assert.ok(parseArtifactRange('branch:lane').error);
    const missing = validateArtifactOwnership({
      repoRoot: '/repo',
      artifact: 'branch:lane',
      declaration,
      commandRunner: () => ({ status: 0, stdout: '' }),
    });
    assert.equal(missing.ok, false);

    const unexpected = validateChangedPathsAgainstOwnership(['src/error_mapping.js', 'src/unexpected.js'], declaration);
    assert.equal(unexpected.ok, false);
    assert.deepEqual(unexpected.unexpected, ['src/unexpected.js']);
  });

  it('uses exact GitHub PR file lists as the GitHub artifact projection', () => {
    const changed = collectGitHubArtifactChangedPaths([
      { path: 'src/error_mapping.js' },
      { path: 'schemas/__init__.py' },
    ]);
    assert.equal(changed.error, null);
    assert.equal(validateChangedPathsAgainstOwnership(changed.paths, declaration).ok, true);
    assert.equal(validateChangedPathsAgainstOwnership([...changed.paths, 'package-lock.json'], declaration).ok, false);
  });

  it('rejects arbitrary shared-file rewrites that merely use a declared path', () => {
    const mutation = { path: 'package.json', operation: 'add_json_key', target: 'scripts.safe' };
    const base = JSON.stringify({ scripts: { test: 'node --test' }, private: true });
    const validHead = JSON.stringify({ scripts: { test: 'node --test', safe: 'node safe.js' }, private: true });
    const rewrittenHead = JSON.stringify({ scripts: { safe: 'node safe.js' }, private: false });
    assert.equal(validateSharedMutationContents(mutation, base, validHead).ok, true);
    assert.equal(validateSharedMutationContents(mutation, base, rewrittenHead).ok, false);

    const exportMutation = { path: 'schemas/__init__.py', operation: 'add_export', target: 'InvoiceSchema' };
    assert.equal(validateSharedMutationContents(
      exportMutation,
      'from .address import AddressSchema\n',
      'from .address import AddressSchema\nfrom .invoice import InvoiceSchema\n'
    ).ok, true);
    assert.equal(validateSharedMutationContents(
      exportMutation,
      'from .address import AddressSchema\n',
      'from .invoice import InvoiceSchema\n'
    ).ok, false);
    assert.equal(validateSharedMutationContents(
      exportMutation,
      'from .address import AddressSchema\nfrom .customer import CustomerSchema\n',
      'from .customer import CustomerSchema\nfrom .address import AddressSchema\nfrom .invoice import InvoiceSchema\n'
    ).ok, false);
  });
});

describe('task and pairwise eligibility', () => {
  it('classifies broad API scope and unrelated schema work as disjoint (P30-S1)', () => {
    const api = lane('API-1', taskBody({
      allowedPaths: ['api/**'],
      ownedPaths: ['api/error_mapping.py'],
    }), LEFT_HEAD);
    const schema = lane('SCHEMA-1', taskBody({
      allowedPaths: ['schemas/**'],
      ownedPaths: ['schemas/error.py'],
    }), RIGHT_HEAD);

    const result = classifyParallelPair(api, schema, managedPlan(api, schema));
    assert.equal(result.relation, 'disjoint');
  });

  it('permits distinct additive schema exports and blocks competing variants (P30-S2)', () => {
    const left = lane('SCHEMA-A', taskBody({
      allowedPaths: ['schemas/**'],
      ownedPaths: ['schemas/address.py'],
      sharedMutations: 'shared_mutations:\n  schemas/__init__.py:\n    operation: add_export\n    target: AddressSchema',
    }), LEFT_HEAD);
    const right = lane('SCHEMA-B', taskBody({
      allowedPaths: ['schemas/**'],
      ownedPaths: ['schemas/invoice.py'],
      sharedMutations: 'shared_mutations:\n  schemas/__init__.py:\n    operation: add_export\n    target: InvoiceSchema',
    }), RIGHT_HEAD);
    assert.equal(classifyParallelPair(left, right, managedPlan(left, right)).relation, 'managed_join');

    const sameExport = lane('SCHEMA-C', taskBody({
      allowedPaths: ['schemas/**'],
      ownedPaths: ['schemas/duplicate.py'],
      sharedMutations: 'shared_mutations:\n  schemas/__init__.py:\n    operation: add_export\n    target: AddressSchema',
    }), RIGHT_HEAD);
    assert.equal(classifyParallelPair(left, sameExport, managedPlan(left, sameExport)).relation, 'blocked');

    const coupled = lane('SCHEMA-D', taskBody({
      allowedPaths: ['schemas/**'],
      ownedPaths: ['schemas/coupled.py'],
      sharedMutations: 'shared_mutations:\n  schemas/__init__.py:\n    operation: add_export\n    target: CoupledSchema',
      knowledge: 'coupled',
    }), RIGHT_HEAD);
    assert.equal(classifyParallelPair(left, coupled, managedPlan(left, coupled)).relation, 'blocked');
  });

  it('permits distinct package scripts and blocks same-key/dependency variants (P30-S3)', () => {
    const left = lane('SCRIPT-A', taskBody({
      allowedPaths: ['package.json', 'src/**'],
      ownedPaths: ['src/generate.js'],
      sharedMutations: 'shared_mutations:\n  package.json:\n    operation: add_json_key\n    target: scripts.generate-api',
    }), LEFT_HEAD);
    const right = lane('SCRIPT-B', taskBody({
      allowedPaths: ['package.json', 'src/**'],
      ownedPaths: ['src/check.js'],
      sharedMutations: 'shared_mutations:\n  package.json:\n    operation: add_json_key\n    target: scripts.check-api',
    }), RIGHT_HEAD);
    assert.equal(classifyParallelPair(left, right, managedPlan(left, right)).relation, 'managed_join');

    const sameKey = lane('SCRIPT-C', taskBody({
      allowedPaths: ['package.json', 'src/**'],
      ownedPaths: ['src/other.js'],
      sharedMutations: 'shared_mutations:\n  package.json:\n    operation: add_json_key\n    target: scripts.generate-api',
    }), RIGHT_HEAD);
    assert.equal(classifyParallelPair(left, sameKey, managedPlan(left, sameKey)).relation, 'blocked');

    const lockfile = lane('SCRIPT-D', taskBody({
      allowedPaths: ['package-lock.json', 'src/**'],
      ownedPaths: ['src/dependency.js'],
      sharedMutations: 'shared_mutations:\n  package-lock.json:\n    operation: add_export\n    target: Dependency',
    }), RIGHT_HEAD);
    assert.equal(evaluateTaskEligibility(lockfile.declaration), 'blocked');
  });

  it('keeps unknown ownership distinct from a blocked pair and rejects Orchestrator-authored joinability', () => {
    const missing = lane('UNKNOWN', taskBody({ allowedPaths: ['src/**'], ownedPaths: null }), LEFT_HEAD);
    const known = lane('KNOWN', taskBody({ allowedPaths: ['src/**'], ownedPaths: ['src/known.js'] }), RIGHT_HEAD);
    assert.equal(evaluateTaskEligibility(missing.declaration), 'unknown');
    assert.equal(classifyParallelPair(missing, known, managedPlan(missing, known)).relation, 'unknown');

    const left = lane('A', taskBody({
      allowedPaths: ['schemas/**'], ownedPaths: ['schemas/a.py'],
      sharedMutations: 'shared_mutations:\n  schemas/__init__.py:\n    operation: add_export\n    target: A',
    }), LEFT_HEAD);
    const right = lane('B', taskBody({
      allowedPaths: ['schemas/**'], ownedPaths: ['schemas/b.py'],
      sharedMutations: 'shared_mutations:\n  schemas/__init__.py:\n    operation: add_export\n    target: B',
    }), RIGHT_HEAD);
    const unauthorized = managedPlan(left, right);
    unauthorized.classifiedBy = 'orchestrator';
    assert.equal(classifyParallelPair(left, right, unauthorized).relation, 'unknown');
  });
});

describe('reconciliation and exact-artifact invalidation', () => {
  const plan = {
    joinTask: { attemptBudget: 2 },
    conflictPaths: ['schemas/__init__.py'],
    compositionOrder: ['A', 'B'],
  };

  it('allows only bounded textual reconciliation on named paths with final checks', () => {
    const result = validateManagedReconciliation({
      plan,
      attempts: 1,
      editedPaths: ['schemas/__init__.py'],
      classification: 'mechanical',
      postChecksPassed: true,
    });
    assert.equal(result.ok, true);
  });

  it('escalates semantic ambiguity, unexpected writes, exhausted budget, and failed final checks', () => {
    assert.equal(validateManagedReconciliation({ plan, attempts: 1, editedPaths: [], classification: 'semantic', postChecksPassed: true }).ok, false);
    assert.equal(validateManagedReconciliation({ plan, attempts: 1, editedPaths: ['src/unrelated.py'], classification: 'mechanical', postChecksPassed: true }).ok, false);
    assert.equal(validateManagedReconciliation({ plan, attempts: 3, editedPaths: ['schemas/__init__.py'], classification: 'mechanical', postChecksPassed: true }).ok, false);
    assert.equal(validateManagedReconciliation({ plan, attempts: 1, editedPaths: ['schemas/__init__.py'], classification: 'mechanical', postChecksPassed: false }).ok, false);
  });

  it('invalidates evidence and review when artifact or composition order changes', () => {
    const left = lane('A', taskBody({ allowedPaths: ['schemas/**'], ownedPaths: ['schemas/a.py'], sharedMutations: 'shared_mutations:\n  schemas/__init__.py:\n    operation: add_export\n    target: A' }), LEFT_HEAD);
    const right = lane('B', taskBody({ allowedPaths: ['schemas/**'], ownedPaths: ['schemas/b.py'], sharedMutations: 'shared_mutations:\n  schemas/__init__.py:\n    operation: add_export\n    target: B' }), RIGHT_HEAD);
    const fullPlan = managedPlan(left, right);
    const current = validateManagedJoinFreshness({
      plan: fullPlan,
      lanes: [left, right],
      finalArtifact: JOIN_HEAD,
      integratedEvidence: { artifact: JOIN_HEAD, compositionOrder: ['A', 'B'] },
      review: { artifact: JOIN_HEAD, lenses: ['lens1', 'lens2', 'lens3'] },
    });
    assert.equal(current.ok, true);

    const staleOrder = validateManagedJoinFreshness({
      plan: { ...fullPlan, compositionOrder: ['B', 'A'] },
      lanes: [left, right],
      finalArtifact: JOIN_HEAD,
      integratedEvidence: { artifact: JOIN_HEAD, compositionOrder: ['A', 'B'] },
      review: { artifact: JOIN_HEAD, lenses: ['lens1', 'lens2', 'lens3'] },
    });
    assert.equal(staleOrder.ok, false);
    assert.ok(staleOrder.errors.some(error => error.includes('composition order')));

    const staleReview = validateManagedJoinFreshness({
      plan: fullPlan,
      lanes: [left, right],
      finalArtifact: JOIN_HEAD,
      integratedEvidence: { artifact: JOIN_HEAD, compositionOrder: ['A', 'B'] },
      review: { artifact: LEFT_HEAD, lenses: ['lens1', 'lens2', 'lens3'] },
    });
    assert.equal(staleReview.ok, false);
    assert.ok(staleReview.errors.some(error => error.includes('review is stale')));
  });
});

describe('disposable Git composition', () => {
  it('composes exact disjoint lane artifacts into a stable final tree', () => {
    const repo = makeGitRepo();
    try {
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      git(repo, ['add', 'base.txt']);
      git(repo, ['commit', '-q', '-m', 'base']);
      const base = git(repo, ['rev-parse', 'HEAD']);

      git(repo, ['checkout', '-q', '-b', 'lane-a']);
      writeFileSync(join(repo, 'a.txt'), 'lane-a\n');
      git(repo, ['add', 'a.txt']);
      git(repo, ['commit', '-q', '-m', 'lane a']);
      const laneA = git(repo, ['rev-parse', 'HEAD']);

      git(repo, ['checkout', '-q', '-b', 'lane-b', base]);
      writeFileSync(join(repo, 'b.txt'), 'lane-b\n');
      git(repo, ['add', 'b.txt']);
      git(repo, ['commit', '-q', '-m', 'lane b']);
      const laneB = git(repo, ['rev-parse', 'HEAD']);

      git(repo, ['checkout', '-q', '-b', 'join', base]);
      git(repo, ['cherry-pick', laneA]);
      git(repo, ['cherry-pick', laneB]);
      const finalArtifact = git(repo, ['rev-parse', 'HEAD']);
      const finalTree = git(repo, ['rev-parse', 'HEAD^{tree}']);
      assert.equal(git(repo, ['rev-parse', `${finalArtifact}^{tree}`]), finalTree);
      assert.equal(git(repo, ['show', `${finalArtifact}:a.txt`]), 'lane-a');
      assert.equal(git(repo, ['show', `${finalArtifact}:b.txt`]), 'lane-b');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('bounds a real textual conflict to the named export path and records the exact result', () => {
    const repo = makeGitRepo();
    try {
      const shared = join(repo, 'exports.js');
      writeFileSync(shared, '// exports\n// end\n');
      git(repo, ['add', 'exports.js']);
      git(repo, ['commit', '-q', '-m', 'base']);
      const base = git(repo, ['rev-parse', 'HEAD']);

      git(repo, ['checkout', '-q', '-b', 'lane-a']);
      writeFileSync(shared, '// exports\nexport { A } from \"./a.js\";\n// end\n');
      git(repo, ['add', 'exports.js']);
      git(repo, ['commit', '-q', '-m', 'add A']);
      const laneA = git(repo, ['rev-parse', 'HEAD']);

      git(repo, ['checkout', '-q', '-b', 'lane-b', base]);
      writeFileSync(shared, '// exports\nexport { B } from \"./b.js\";\n// end\n');
      git(repo, ['add', 'exports.js']);
      git(repo, ['commit', '-q', '-m', 'add B']);
      const laneB = git(repo, ['rev-parse', 'HEAD']);

      git(repo, ['checkout', '-q', '-b', 'join-conflict', base]);
      git(repo, ['cherry-pick', laneA]);
      const conflict = spawnSync('git', ['-C', repo, 'cherry-pick', laneB], { encoding: 'utf-8' });
      assert.notEqual(conflict.status, 0, 'second lane must produce the rehearsal conflict');
      assert.deepEqual(git(repo, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/), ['exports.js']);

      writeFileSync(shared, '// exports\nexport { A } from \"./a.js\";\nexport { B } from \"./b.js\";\n// end\n');
      git(repo, ['add', 'exports.js']);
      git(repo, ['cherry-pick', '--continue']);
      const finalArtifact = git(repo, ['rev-parse', 'HEAD']);
      assert.match(git(repo, ['show', `${finalArtifact}:exports.js`]), /export \{ A \}[\s\S]*export \{ B \}/);
      assert.match(git(repo, ['show', '--format=', '--name-only', finalArtifact]), /^exports\.js$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('cleanly composes distinct additive exports in the same shared file', () => {
    const repo = makeGitRepo();
    try {
      const shared = join(repo, 'exports.js');
      const baseContent = '// first exports\n// untouched middle one\n// untouched middle two\n// final exports\n';
      writeFileSync(shared, baseContent);
      git(repo, ['add', 'exports.js']);
      git(repo, ['commit', '-q', '-m', 'base']);
      const base = git(repo, ['rev-parse', 'HEAD']);

      git(repo, ['checkout', '-q', '-b', 'lane-a']);
      const laneAContent = '// first exports\nexport { A } from \"./a.js\";\n// untouched middle one\n// untouched middle two\n// final exports\n';
      writeFileSync(shared, laneAContent);
      git(repo, ['add', 'exports.js']);
      git(repo, ['commit', '-q', '-m', 'add A']);
      const laneA = git(repo, ['rev-parse', 'HEAD']);

      git(repo, ['checkout', '-q', '-b', 'lane-b', base]);
      const laneBContent = '// first exports\n// untouched middle one\n// untouched middle two\n// final exports\nexport { B } from \"./b.js\";\n';
      writeFileSync(shared, laneBContent);
      git(repo, ['add', 'exports.js']);
      git(repo, ['commit', '-q', '-m', 'add B']);
      const laneB = git(repo, ['rev-parse', 'HEAD']);

      assert.equal(validateSharedMutationContents(
        { path: 'exports.js', operation: 'add_export', target: 'A' },
        baseContent,
        laneAContent
      ).ok, true);
      assert.equal(validateSharedMutationContents(
        { path: 'exports.js', operation: 'add_export', target: 'B' },
        baseContent,
        laneBContent
      ).ok, true);

      git(repo, ['checkout', '-q', '-b', 'join-clean-shared', base]);
      git(repo, ['cherry-pick', laneA]);
      git(repo, ['cherry-pick', laneB]);
      const finalArtifact = git(repo, ['rev-parse', 'HEAD']);
      const finalContent = git(repo, ['show', `${finalArtifact}:exports.js`]);
      assert.match(finalContent, /export \{ A \}/);
      assert.match(finalContent, /export \{ B \}/);
      assert.deepEqual(git(repo, ['diff', '--name-only', `${base}..${finalArtifact}`]).split(/\r?\n/), ['exports.js']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
