/**
 * Agentic Loop Git worktree provisioning and non-interactive Git guard helpers.
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

export const WORKTREE_PARENT = '.agenticloop/worktrees';

export const GIT_GUARD_CONFIG = [
  { key: 'core.editor', value: 'true' },
  { key: 'sequence.editor', value: 'true' },
  { key: 'core.pager', value: 'cat' },
  { key: 'credential.interactive', value: 'false' },
];

export const NON_INTERACTIVE_ENV = [
  { key: 'GIT_EDITOR', value: 'true' },
  { key: 'GIT_SEQUENCE_EDITOR', value: 'true' },
  { key: 'GIT_PAGER', value: 'cat' },
  { key: 'GIT_TERMINAL_PROMPT', value: '0' },
  { key: 'GH_EDITOR', value: 'true' },
  { key: 'GH_PAGER', value: 'cat' },
  { key: 'GH_PROMPT_DISABLED', value: '1' },
];

function runGit(cwd, args, options = {}) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    ...options,
  });
}

function outputText(result) {
  return [
    String(result.stderr ?? '').trim(),
    String(result.stdout ?? '').trim(),
    result.error?.message?.trim() ?? '',
  ].filter(Boolean).join('\n');
}

function assertGitOk(result, action) {
  if (result.status === 0) return;
  throw new Error(`${action} failed: ${outputText(result) || `exit ${result.status}`}`);
}

function normalizeConfigValue(value) {
  return String(value ?? '').trim().replace(/^"(.*)"$/, '$1');
}

function isSubpath(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new Error('worktree add requires a non-empty task id');
  }
  if (
    taskId !== taskId.trim() ||
    taskId === '.' ||
    taskId === '..' ||
    taskId.includes('..') ||
    taskId.includes('/') ||
    taskId.includes('\\') ||
    isAbsolute(taskId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)
  ) {
    throw new Error(
      'task id must be a safe path segment using only letters, numbers, dot, underscore, or dash'
    );
  }
}

function validateBranchName(repoRoot, branch) {
  if (typeof branch !== 'string' || branch.trim() === '') {
    throw new Error('worktree add requires a non-empty branch name');
  }
  if (branch !== branch.trim() || branch.startsWith('-')) {
    throw new Error('branch name must not be empty, padded, or start with dash');
  }
  const result = runGit(repoRoot, ['check-ref-format', '--branch', branch]);
  assertGitOk(result, `validate branch '${branch}'`);
}

function resolveRepoRoot(target) {
  const result = runGit(target, ['rev-parse', '--show-toplevel']);
  assertGitOk(result, `resolve Git repository for '${target}'`);
  return resolve(result.stdout.trim());
}

function resolveCommonGitDir(repoRoot) {
  const result = runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  assertGitOk(result, 'resolve Git common directory');
  return resolve(result.stdout.trim());
}

function ensureWorktreeParentIgnored(repoRoot) {
  const commonGitDir = resolveCommonGitDir(repoRoot);
  const infoDir = join(commonGitDir, 'info');
  const excludePath = join(infoDir, 'exclude');
  const entry = `${WORKTREE_PARENT}/`;
  mkdirSync(infoDir, { recursive: true });

  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
  const hasEntry = existing
    .split(/\r?\n/)
    .map(line => line.trim().replace(/\\/g, '/').replace(/^\//, ''))
    .includes(entry);
  if (hasEntry) return false;

  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(excludePath, `${prefix}${entry}\n`, 'utf-8');
  return true;
}

function enableWorktreeConfig(repoRoot) {
  const result = runGit(repoRoot, ['config', 'extensions.worktreeConfig', 'true']);
  assertGitOk(result, 'enable worktree-specific Git config');
}

function branchExists(repoRoot, branch) {
  const result = runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return result.status === 0;
}

function applyGitGuardConfig(worktreePath) {
  for (const entry of GIT_GUARD_CONFIG) {
    const result = runGit(worktreePath, ['config', '--worktree', entry.key, entry.value]);
    assertGitOk(result, `set ${entry.key} in worktree config`);
  }
}

function getGitConfig(path, key) {
  const result = runGit(path, ['config', '--get', key]);
  if (result.status !== 0) return null;
  return normalizeConfigValue(result.stdout);
}

function getGitConfigSource(path, key) {
  const result = runGit(path, ['config', '--show-origin', '--get', key]);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function envGuardStatus(env = process.env) {
  const entries = NON_INTERACTIVE_ENV.map(entry => {
    const actual = env[entry.key];
    return {
      ...entry,
      actual,
      ok: actual === entry.value,
    };
  });
  return {
    entries,
    ok: entries.every(entry => entry.ok),
    missing: entries.filter(entry => !entry.ok).map(entry => entry.key),
  };
}

function configGuardStatus(path) {
  const entries = GIT_GUARD_CONFIG.map(entry => {
    const actual = getGitConfig(path, entry.key);
    return {
      ...entry,
      actual,
      source: getGitConfigSource(path, entry.key),
      ok: actual === entry.value,
    };
  });
  return {
    entries,
    ok: entries.every(entry => entry.ok),
    missing: entries.filter(entry => !entry.ok).map(entry => entry.key),
  };
}

function gitRootOrNull(target) {
  try {
    return resolveRepoRoot(target);
  } catch {
    return null;
  }
}

function parseWorktreeList(output) {
  const records = [];
  let current = null;
  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line.trim() === '' && current) {
      records.push(current);
      current = null;
    }
  }
  if (current) records.push(current);
  return records;
}

export function findAgenticLoopWorktrees(repoRoot) {
  const parent = join(repoRoot, WORKTREE_PARENT);
  const result = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) return [];
  return parseWorktreeList(result.stdout)
    .map(record => ({ ...record, path: resolve(record.path) }))
    .filter(record => isSubpath(parent, record.path));
}

export function createAgenticLoopWorktree(options) {
  const {
    target = process.cwd(),
    taskId,
    branch,
    from,
  } = options;

  const repoRoot = resolveRepoRoot(resolve(target));
  validateTaskId(taskId);
  validateBranchName(repoRoot, branch);

  const parent = join(repoRoot, WORKTREE_PARENT);
  const worktreePath = join(parent, taskId);
  if (!isSubpath(parent, worktreePath)) {
    throw new Error('resolved worktree path escaped the Agentic Loop worktree directory');
  }
  if (existsSync(worktreePath)) {
    throw new Error(`worktree path already exists: ${worktreePath}`);
  }

  mkdirSync(parent, { recursive: true });
  const ignored = ensureWorktreeParentIgnored(repoRoot);
  enableWorktreeConfig(repoRoot);

  const existingBranch = branchExists(repoRoot, branch);
  if (existingBranch && from) {
    throw new Error(`branch '${branch}' already exists; omit --from or choose a new branch`);
  }

  const args = existingBranch
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, from || 'HEAD'];
  const addResult = runGit(repoRoot, args);
  assertGitOk(addResult, `create worktree '${worktreePath}'`);

  applyGitGuardConfig(worktreePath);

  return {
    repoRoot,
    taskId,
    branch,
    from: existingBranch ? null : (from || 'HEAD'),
    path: worktreePath,
    ignored,
    guard: configGuardStatus(worktreePath),
  };
}

export function inspectGitGuard(path, env = process.env) {
  const resolvedPath = resolve(path);
  const repoRoot = gitRootOrNull(resolvedPath);
  const environment = envGuardStatus(env);
  if (!repoRoot) {
    return {
      path: resolvedPath,
      repoRoot: null,
      environment,
      config: null,
      ok: environment.ok,
      reason: 'not a Git working tree',
    };
  }

  const config = configGuardStatus(resolvedPath);
  return {
    path: resolvedPath,
    repoRoot,
    environment,
    config,
    ok: environment.ok || config.ok,
    reason: environment.ok ? 'environment guard present' : (config.ok ? 'worktree config guard present' : 'missing guard'),
  };
}

export function inspectGitGuardState(target = process.cwd(), env = process.env) {
  const resolvedTarget = resolve(target);
  const repoRoot = gitRootOrNull(resolvedTarget);
  const environment = envGuardStatus(env);
  if (!repoRoot) {
    return {
      target: resolvedTarget,
      repoRoot: null,
      environment,
      current: null,
      worktrees: [],
    };
  }

  const current = {
    path: repoRoot,
    config: configGuardStatus(repoRoot),
  };
  const worktrees = findAgenticLoopWorktrees(repoRoot).map(record => ({
    ...record,
    config: configGuardStatus(record.path),
  }));

  return {
    target: resolvedTarget,
    repoRoot,
    environment,
    current,
    worktrees,
  };
}

function formatMissing(keys) {
  return keys.length > 0 ? `missing ${keys.join(', ')}` : 'ok';
}

function formatGuardLine(label, ok, detail) {
  return `  ${ok ? '[x]' : '[ ]'} ${label}: ${detail}`;
}

export function formatGitGuardDoctor(target = process.cwd(), env = process.env) {
  const state = inspectGitGuardState(target, env);
  const lines = ['Git non-interactive guard:'];
  lines.push(formatGuardLine('Session environment', state.environment.ok, formatMissing(state.environment.missing)));

  if (!state.repoRoot) {
    lines.push(formatGuardLine('Git repository', false, 'not detected'));
    return lines.join('\n');
  }

  const coordinatorGuarded = state.environment.ok || state.current.config.ok;
  let coordinatorDetail;
  if (state.environment.ok) {
    coordinatorDetail = 'covered by session environment';
  } else if (state.current.config.ok) {
    coordinatorDetail = 'covered by checkout config';
  } else {
    coordinatorDetail = 'unguarded; launch the host with session env before coordinator Git or gh commands';
  }
  lines.push(formatGuardLine(
    'Coordinator checkout',
    coordinatorGuarded,
    coordinatorDetail
  ));
  if (!state.current.config.ok) {
    lines.push('  Info: current checkout config is not repaired by worktree guard, to preserve the user editor.');
  }

  if (state.worktrees.length === 0) {
    lines.push(formatGuardLine('Agentic Loop worktrees', true, 'none detected'));
  } else {
    for (const worktree of state.worktrees) {
      const label = `Worktree ${relative(state.repoRoot, worktree.path).replace(/\\/g, '/')}`;
      lines.push(formatGuardLine(
        label,
        worktree.config.ok,
        worktree.config.ok ? 'guarded' : formatMissing(worktree.config.missing)
      ));
    }
  }

  if (!state.environment.ok && state.worktrees.some(worktree => !worktree.config.ok)) {
    lines.push('  Next: npx agenticloop worktree guard --fix --all');
  }
  if (!coordinatorGuarded) {
    lines.push('  Warning: coordinator Git or gh commands can still block on an editor, pager, or prompt.');
    lines.push('  Next: launch the host with the Git/GitHub CLI env guard from docs/host-adapters.md.');
  }

  return lines.join('\n');
}

export function guardAgenticLoopWorktrees(options = {}) {
  const {
    target = process.cwd(),
    path,
    all = false,
    fix = false,
    env = process.env,
  } = options;

  if (all && path) {
    throw new Error('worktree guard accepts either --all or a path, not both');
  }

  const resolvedTarget = resolve(target);
  const repoRoot = resolveRepoRoot(resolvedTarget);
  let targets;
  if (all) {
    targets = findAgenticLoopWorktrees(repoRoot).map(record => record.path);
  } else {
    targets = [path ? resolve(resolvedTarget, path) : resolvedTarget];
  }

  if (targets.length === 0) {
    return {
      repoRoot,
      fixed: fix,
      targets: [],
      ok: true,
    };
  }

  if (fix) {
    enableWorktreeConfig(repoRoot);
    for (const targetPath of targets) {
      applyGitGuardConfig(targetPath);
    }
  }

  const inspected = targets.map(targetPath => inspectGitGuard(targetPath, env));
  return {
    repoRoot,
    fixed: fix,
    targets: inspected,
    ok: inspected.every(entry => entry.ok),
  };
}

export function formatWorktreeGuardResult(result) {
  const lines = ['Git non-interactive guard:'];
  if (result.targets.length === 0) {
    lines.push('  [x] Agentic Loop worktrees: none detected');
    return lines.join('\n');
  }

  for (const target of result.targets) {
    const label = relative(result.repoRoot, target.path).replace(/\\/g, '/') || '.';
    const detail = target.ok
      ? target.reason
      : formatMissing(target.config?.missing ?? target.environment.missing);
    lines.push(formatGuardLine(label, target.ok, detail));
  }
  return lines.join('\n');
}
