/**
 * Agentic Loop Git worktree provisioning, lifecycle, and non-interactive Git guard helpers.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { resolveTaskBackend } from './task-backend.js';
import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { loadProjectMap } from './project-map.js';

export const WORKTREE_PARENT = '.agenticloop/worktrees';

export const LANE_LOCAL_STATE_DIRS = [
  '.agenticloop/logs',
  '.agenticloop/summaries',
  '.agenticloop/tasks',
  '.agenticloop/decisions',
];

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

export function resolveGitRepositoryContext(target = process.cwd()) {
  const resolvedTarget = resolve(target);

  const toplevelResult = runGit(resolvedTarget, ['rev-parse', '--show-toplevel']);
  if (toplevelResult.status === 0) {
    const currentWorktreeRoot = resolve(toplevelResult.stdout.trim());
    const commonDirResult = runGit(currentWorktreeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    assertGitOk(commonDirResult, `resolve Git common directory for '${resolvedTarget}'`);
    const commonGitDir = resolve(commonDirResult.stdout.trim());
    const isBareResult = runGit(currentWorktreeRoot, ['rev-parse', '--is-bare-repository']);
    const isBare = isBareResult.status === 0 && isBareResult.stdout.trim() === 'true';

    const repoRoot = basename(commonGitDir) === '.git' ? dirname(commonGitDir) : commonGitDir;
    return {
      target: resolvedTarget,
      repoRoot,
      commonGitDir,
      isBare,
      gitCwd: repoRoot,
      currentWorktreeRoot,
      isInsideWorktree: repoRoot !== currentWorktreeRoot,
    };
  }

  const commonDirResult = runGit(resolvedTarget, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDirResult.status !== 0) {
    throw new Error(`resolve Git repository for '${resolvedTarget}' failed: ${outputText(toplevelResult)}`);
  }
  const commonGitDir = resolve(commonDirResult.stdout.trim());
  const isBareResult = runGit(resolvedTarget, ['rev-parse', '--is-bare-repository']);
  const isBare = isBareResult.status === 0 && isBareResult.stdout.trim() === 'true';

  const repoRoot = isBare && basename(commonGitDir) === '.git' ? dirname(commonGitDir) : commonGitDir;

  return {
    target: resolvedTarget,
    repoRoot,
    commonGitDir,
    isBare,
    gitCwd: repoRoot,
    currentWorktreeRoot: null,
    isInsideWorktree: false,
  };
}

function resolveRepoRoot(target) {
  return resolveGitRepositoryContext(target).repoRoot;
}

function resolveCommonGitDir(repoRoot) {
  return resolveGitRepositoryContext(repoRoot).commonGitDir;
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
    return resolveGitRepositoryContext(target).repoRoot;
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
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (current && line === 'detached') {
      current.detached = true;
    } else if (current && line === 'bare') {
      current.bare = true;
    } else if (current && line === 'locked') {
      current.locked = true;
    } else if (current && line.startsWith('locked ')) {
      current.locked = line.slice('locked '.length) || true;
    } else if (current && line === 'prunable') {
      current.prunable = true;
    } else if (current && line.startsWith('prunable ')) {
      current.prunable = true;
      current.prunableReason = line.slice('prunable '.length).trim();
    } else if (line.trim() === '' && current) {
      records.push(current);
      current = null;
    }
  }
  if (current) records.push(current);
  return records;
}

function taskIdFromWorktreePath(worktreePath) {
  return basename(resolve(worktreePath));
}

function parseStatusLine(line) {
  const raw = line.trim();
  if (raw.length < 3) return null;
  const status = raw.slice(0, 2);
  const path = raw.slice(3);
  return { status, path };
}

function listDirtyFiles(path) {
  const result = runGit(path, ['status', '--short', '--untracked-files=all']);
  if (result.status !== 0) return [];
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .map(parseStatusLine)
    .filter(Boolean);
}

function isAgenticLoopStatePath(relPath) {
  const normalized = String(relPath ?? '').replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length < 3) return false;
  if (parts[0] !== '.agenticloop') return false;
  return LANE_LOCAL_STATE_DIRS.some(dir => dir === `.agenticloop/${parts[1]}`);
}

function isLaneLocalStatePath(relPath, taskId) {
  const normalized = String(relPath ?? '').replace(/\\/g, '/');
  const taskIdLower = String(taskId).toLowerCase();
  const parts = normalized.split('/');
  if (parts.length !== 3) return false;
  if (parts[0] !== '.agenticloop') return false;
  const dir = parts[1];
  const file = parts[2];
  if (!LANE_LOCAL_STATE_DIRS.some(d => d === `.agenticloop/${dir}`)) return false;

  const baseLower = file.replace(/\.[^.]+$/, '').toLowerCase();
  if (baseLower === taskIdLower) return true;
  if ((dir === 'summaries' || dir === 'decisions') && baseLower.startsWith(`${taskIdLower}-`)) {
    return true;
  }
  return false;
}

function classifyWorktreeLocation(record, standardParent, repoRoot) {
  if (record.bare) return 'bare-main';
  const normalizedPath = resolve(record.path);
  if (normalizedPath === repoRoot) return 'main';
  if (isSubpath(standardParent, normalizedPath)) return 'standard';
  if (record.detached) return 'detached';
  return 'external';
}

export function listAgenticLoopWorktrees(contextOrTarget) {
  const context = typeof contextOrTarget === 'string' || !contextOrTarget?.repoRoot
    ? resolveGitRepositoryContext(contextOrTarget)
    : contextOrTarget;
  const standardParent = join(context.repoRoot, WORKTREE_PARENT);

  const result = runGit(context.gitCwd, ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) {
    throw new Error(`list worktrees failed: ${outputText(result)}`);
  }

  const records = parseWorktreeList(result.stdout).map(record => {
    const path = resolve(record.path);
    const location = classifyWorktreeLocation(record, standardParent, context.repoRoot);
    return {
      path,
      head: record.head ?? null,
      branch: record.branch ?? null,
      detached: Boolean(record.detached),
      bare: Boolean(record.bare),
      locked: Boolean(record.locked),
      prunable: Boolean(record.prunable),
      prunableReason: record.prunableReason ?? null,
      location,
    };
  });

  return records.map(record => {
    const taskId = record.location === 'standard' ? taskIdFromWorktreePath(record.path) : null;
    const dirtyFiles = record.bare ? [] : listDirtyFiles(record.path);
    const laneLocalDirtyFiles = taskId
      ? dirtyFiles.filter(entry => isLaneLocalStatePath(entry.path, taskId))
      : [];
    const blockingDirtyFiles = dirtyFiles.filter(
      entry => !laneLocalDirtyFiles.includes(entry)
    );
    const sharedStateDirtyFiles = taskId
      ? dirtyFiles.filter(entry => isAgenticLoopStatePath(entry.path) && !isLaneLocalStatePath(entry.path, taskId))
      : [];
    const guard = record.location === 'standard' ? configGuardStatus(record.path) : null;
    return {
      ...record,
      dirtyCount: dirtyFiles.length,
      blockingDirtyCount: blockingDirtyFiles.length,
      laneLocalDirtyFiles: laneLocalDirtyFiles.map(entry => entry.path),
      sharedStateDirtyFiles: sharedStateDirtyFiles.map(entry => entry.path),
      guard,
    };
  });
}

export function findAgenticLoopWorktrees(repoRootOrContext) {
  const context = typeof repoRootOrContext === 'string' || !repoRootOrContext?.repoRoot
    ? resolveGitRepositoryContext(repoRootOrContext)
    : repoRootOrContext;
  return listAgenticLoopWorktrees(context).filter(record => record.location === 'standard');
}

function hashFile(path) {
  const buffer = readFileSync(path);
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeLineEndings(content) {
  return String(content ?? '').replace(/\r\n/g, '\n');
}

function splitJsonlLines(content) {
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function countLines(lines) {
  const counts = new Map();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function isLineMultisetSuperset(rootLines, laneLines) {
  const rootCounts = countLines(rootLines);
  const laneCounts = countLines(laneLines);
  for (const [line, count] of laneCounts) {
    if ((rootCounts.get(line) ?? 0) < count) return false;
  }
  return true;
}

function missingLineCount(rootLines, laneLines) {
  const rootCounts = countLines(rootLines);
  const laneCounts = countLines(laneLines);
  let missing = 0;
  for (const [line, count] of laneCounts) {
    const rootCount = rootCounts.get(line) ?? 0;
    if (rootCount < count) missing += count - rootCount;
  }
  return missing;
}

function jsonlUnion(rootLines, laneLines) {
  const rootCounts = countLines(rootLines);
  const laneCounts = countLines(laneLines);
  const missingCounts = new Map();
  for (const [line, laneCount] of laneCounts) {
    const rootCount = rootCounts.get(line) ?? 0;
    if (laneCount > rootCount) {
      missingCounts.set(line, laneCount - rootCount);
    }
  }
  const output = [...rootLines];
  for (const line of laneLines) {
    const remaining = missingCounts.get(line) ?? 0;
    if (remaining > 0) {
      output.push(line);
      missingCounts.set(line, remaining - 1);
    }
  }
  return output;
}

function formatJsonlLines(lines) {
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

export function planLaneLocalStatePreservation(worktreePath, repoRoot, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const preserved = [];
  const wouldPreserve = [];
  const alreadyPreserved = [];
  const ignoredShared = [];
  const conflicts = [];
  const errors = [];

  const taskId = taskIdFromWorktreePath(worktreePath);
  const rootStateDir = join(repoRoot, '.agenticloop');

  for (const stateRel of LANE_LOCAL_STATE_DIRS) {
    const worktreeStatePath = join(worktreePath, stateRel);
    if (!existsSync(worktreeStatePath) || !statSync(worktreeStatePath).isDirectory()) continue;

    const rootStatePath = join(rootStateDir, stateRel.split('/').pop());
    if (!dryRun) {
      mkdirSync(rootStatePath, { recursive: true });
    }

    const entries = readdirSync(worktreeStatePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const relPath = `${stateRel}/${entry.name}`;
      if (!isLaneLocalStatePath(relPath, taskId)) {
        ignoredShared.push(relPath);
        continue;
      }

      const sourcePath = join(worktreeStatePath, entry.name);
      const targetPath = join(rootStatePath, entry.name);

      try {
        const sourceHash = hashFile(sourcePath);
        if (existsSync(targetPath)) {
          const targetHash = hashFile(targetPath);
          if (sourceHash === targetHash) {
            alreadyPreserved.push(relative(repoRoot, targetPath).replace(/\\/g, '/'));
          } else if (entry.name.toLowerCase().endsWith('.jsonl')) {
            const rootContent = readFileSync(targetPath, 'utf-8');
            const laneContent = readFileSync(sourcePath, 'utf-8');
            const rootLines = splitJsonlLines(rootContent);
            const laneLines = splitJsonlLines(laneContent);
            if (isLineMultisetSuperset(rootLines, laneLines)) {
              const targetRel = relative(repoRoot, targetPath).replace(/\\/g, '/');
              alreadyPreserved.push(`${targetRel} (jsonl superset)`);
            } else {
              const missing = missingLineCount(rootLines, laneLines);
              conflicts.push({
                source: relative(repoRoot, sourcePath).replace(/\\/g, '/'),
                target: relative(repoRoot, targetPath).replace(/\\/g, '/'),
                reason: `state file conflict: root .jsonl is missing ${missing} lane line(s)`,
                missing,
              });
            }
          } else {
            conflicts.push({
              source: relative(repoRoot, sourcePath).replace(/\\/g, '/'),
              target: relative(repoRoot, targetPath).replace(/\\/g, '/'),
              reason: 'state file conflict: root file exists with different content',
            });
          }
        } else {
          if (!dryRun) {
            copyFileSync(sourcePath, targetPath);
          }
          const targetRel = relative(repoRoot, targetPath).replace(/\\/g, '/');
          if (dryRun) {
            wouldPreserve.push(targetRel);
          } else {
            preserved.push(targetRel);
          }
        }
      } catch (error) {
        errors.push(`${relative(repoRoot, sourcePath).replace(/\\/g, '/')}: ${error.message}`);
      }
    }
  }

  return { preserved, wouldPreserve, alreadyPreserved, ignoredShared, conflicts, errors };
}

export function createAgenticLoopWorktree(options) {
  const {
    target = process.cwd(),
    taskId,
    branch,
    from,
  } = options;

  const context = resolveGitRepositoryContext(resolve(target));
  if (context.isBare && basename(context.commonGitDir) !== '.git') {
    throw new Error(
      'worktree add is only supported for project-root bare coordinator repos (parent of .git); conventional bare repos are not supported'
    );
  }
  const repoRoot = context.repoRoot;
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
  if (!context.isBare) {
    enableWorktreeConfig(repoRoot);
  }

  const existingBranch = branchExists(repoRoot, branch);
  if (existingBranch && from) {
    throw new Error(`branch '${branch}' already exists; omit --from or choose a new branch`);
  }

  const args = existingBranch
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, from || 'HEAD'];
  const addResult = runGit(repoRoot, args);
  assertGitOk(addResult, `create worktree '${worktreePath}'`);

  if (!context.isBare) {
    applyGitGuardConfig(worktreePath);
  }

  return {
    repoRoot,
    taskId,
    branch,
    from: existingBranch ? null : (from || 'HEAD'),
    path: worktreePath,
    ignored,
    guard: context.isBare ? null : configGuardStatus(worktreePath),
  };
}

export function inspectGitGuard(path, env = process.env) {
  const resolvedPath = resolve(path);
  const environment = envGuardStatus(env);
  let context = null;
  try {
    context = resolveGitRepositoryContext(resolvedPath);
  } catch {
    return {
      path: resolvedPath,
      repoRoot: null,
      environment,
      config: null,
      ok: environment.ok,
      reason: 'not a Git working tree',
    };
  }

  const config = context.isBare ? null : configGuardStatus(resolvedPath);
  const ok = environment.ok || (config?.ok ?? false);
  let reason;
  if (environment.ok) {
    reason = 'environment guard present';
  } else if (context.isBare) {
    reason = 'bare repository; session environment required';
  } else if (config.ok) {
    reason = 'worktree config guard present';
  } else {
    reason = 'missing guard';
  }

  return {
    path: resolvedPath,
    repoRoot: context.repoRoot,
    environment,
    config,
    ok,
    reason,
  };
}

export function inspectGitGuardState(target = process.cwd(), env = process.env) {
  const resolvedTarget = resolve(target);
  const environment = envGuardStatus(env);

  let context = null;
  try {
    context = resolveGitRepositoryContext(resolvedTarget);
  } catch {
    return {
      target: resolvedTarget,
      repoRoot: null,
      environment,
      current: null,
      worktrees: [],
    };
  }

  const current = context.isBare ? null : {
    path: context.repoRoot,
    config: configGuardStatus(context.repoRoot),
  };
  const worktrees = listAgenticLoopWorktrees(context)
    .filter(record => record.location === 'standard')
    .map(record => ({
      ...record,
      config: configGuardStatus(record.path),
    }));

  return {
    target: context.target,
    repoRoot: context.repoRoot,
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

  if (state.repoRoot === null) {
    lines.push(formatGuardLine('Git repository', false, 'not detected'));
    return lines.join('\n');
  }

  if (state.current === null) {
    lines.push(formatGuardLine('Bare coordinator', state.environment.ok, state.environment.ok ? 'covered by session environment' : 'session environment required'));
  } else {
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
  if ((state.current === null || (!state.environment.ok && !state.current.config.ok))) {
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

  const context = resolveGitRepositoryContext(target);
  let targets;
  if (all) {
    targets = listAgenticLoopWorktrees(context)
      .filter(record => record.location === 'standard')
      .map(record => record.path);
  } else {
    targets = [path ? resolve(context.target, path) : context.target];
  }

  if (targets.length === 0) {
    return {
      repoRoot: context.repoRoot,
      fixed: fix,
      targets: [],
      ok: true,
    };
  }

  if (fix && !context.isBare) {
    enableWorktreeConfig(context.repoRoot);
    for (const targetPath of targets) {
      applyGitGuardConfig(targetPath);
    }
  }

  const inspected = targets.map(targetPath => inspectGitGuard(targetPath, env));
  return {
    repoRoot: context.repoRoot,
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

function resolveRepoOwnerRepo(context) {
  const remoteResult = runGit(context.gitCwd, ['remote', 'get-url', 'origin']);
  if (remoteResult.status === 0) {
    const url = remoteResult.stdout.trim();
    const match = url.match(/[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) return `${match[1]}/${match[2]}`;
  }

  try {
    const data = runGhJson(defaultGhCommandRunner, ['repo', 'view', '--json', 'owner,name']);
    if (data?.owner?.login && data?.name) {
      return `${data.owner.login}/${data.name}`;
    }
  } catch {
    // ignore
  }
  return null;
}

function injectTestPrState() {
  if (process.env.NODE_ENV !== 'test') return null;
  const testState = process.env.AGENTICLOOP_TEST_GH_PR_STATE;
  if (!testState) return null;
  if (testState === 'fail') {
    return {
      state: null,
      number: null,
      warning: 'injected GitHub lookup failure',
      source: 'test-mock-failed',
    };
  }
  try {
    const parsed = JSON.parse(testState);
    return {
      state: String(parsed.state ?? '').toUpperCase(),
      number: parsed.number ?? null,
      warning: null,
      source: 'test-mock',
    };
  } catch {
    return null;
  }
}

export function lookupPullRequestState(repoRoot, branch, options = {}) {
  const context = resolveGitRepositoryContext(repoRoot);
  const backend = resolveTaskBackend(context.repoRoot);
  if (backend.backend !== 'github') {
    return { state: null, number: null, warning: null, source: 'not-github-backend' };
  }

  const injected = injectTestPrState();
  if (injected) return injected;

  const repo = options.repo ?? resolveRepoOwnerRepo(context);
  if (!repo) {
    return { state: null, number: null, warning: 'could not determine GitHub repo', source: 'repo-resolution-failed' };
  }

  const commandRunner = options.commandRunner ?? defaultGhCommandRunner;
  const shortBranch = branch.replace(/^refs\/heads\//, '');
  try {
    const data = runGhJson(commandRunner, [
      'pr', 'list',
      '--state', 'all',
      '--head', shortBranch,
      '--repo', repo,
      '--json', 'number,state',
      '--limit', '1',
    ]);
    if (!Array.isArray(data) || data.length === 0) {
      return { state: null, number: null, warning: null, source: 'no-pr-found' };
    }
    const pr = data[0];
    const state = String(pr.state ?? '').toUpperCase();
    const number = pr.number ?? null;
    return { state, number, warning: null, source: 'github', repo };
  } catch (error) {
    return {
      state: null,
      number: null,
      warning: `GitHub lookup failed: ${error.message}`,
      source: 'github-lookup-failed',
    };
  }
}

function ghPrStateFromEntry(pr) {
  return {
    state: String(pr.state ?? '').toUpperCase(),
    number: pr.number ?? null,
    warning: null,
    source: 'github',
  };
}

export function lookupPullRequestStates(repoRoot, branches, options = {}) {
  const context = resolveGitRepositoryContext(repoRoot);
  const backend = resolveTaskBackend(context.repoRoot);
  const result = new Map();
  if (backend.backend !== 'github' || branches.length === 0) {
    return result;
  }

  const injected = injectTestPrState();
  if (injected) {
    for (const branch of branches) {
      result.set(branch, injected);
    }
    return result;
  }

  const repo = options.repo ?? resolveRepoOwnerRepo(context);
  if (!repo) {
    for (const branch of branches) {
      result.set(branch, { state: null, number: null, warning: 'could not determine GitHub repo', source: 'repo-resolution-failed' });
    }
    return result;
  }

  const commandRunner = options.commandRunner ?? defaultGhCommandRunner;
  const limit = Math.max(100, branches.length * 2);
  try {
    const data = runGhJson(commandRunner, [
      'pr', 'list',
      '--state', 'all',
      '--repo', repo,
      '--json', 'number,state,headRefName',
      '--limit', String(limit),
    ]);
    const prs = Array.isArray(data) ? data : [];
    const byHead = new Map();
    for (const pr of prs) {
      const headRef = String(pr.headRefName ?? '');
      if (!headRef) continue;
      byHead.set(headRef, pr);
      byHead.set(`refs/heads/${headRef}`, pr);
    }
    for (const branch of branches) {
      const shortBranch = branch.replace(/^refs\/heads\//, '');
      const pr = byHead.get(branch) ?? byHead.get(shortBranch) ?? byHead.get(`refs/heads/${shortBranch}`);
      if (pr) {
        result.set(branch, { ...ghPrStateFromEntry(pr), repo });
      } else {
        result.set(branch, { state: null, number: null, warning: null, source: 'no-pr-found' });
      }
    }
  } catch (error) {
    for (const branch of branches) {
      result.set(branch, { state: null, number: null, warning: `GitHub lookup failed: ${error.message}`, source: 'github-lookup-failed' });
    }
  }

  for (const branch of branches) {
    const existing = result.get(branch);
    if (!existing || existing.source !== 'no-pr-found') continue;
    try {
      result.set(branch, lookupPullRequestState(repoRoot, branch, { repo, commandRunner }));
    } catch (fallbackError) {
      result.set(branch, { state: null, number: null, warning: `GitHub lookup failed: ${fallbackError.message}`, source: 'github-lookup-failed' });
    }
  }

  return result;
}

function readTaskFileStatus(worktreePath) {
  const parts = worktreePath.replace(/\\/g, '/').split('/');
  const taskId = parts[parts.length - 1];
  const taskPath = join(worktreePath, '.agenticloop', 'tasks', `${taskId}.md`);
  if (!existsSync(taskPath)) return { status: null, reviewStatus: null };

  try {
    const content = readFileSync(taskPath, 'utf-8');
    const statusMatch = content.match(/^status:\s*(\S+)\s*$/m);
    const reviewMatch = content.match(/^review_status:\s*(\S+)\s*$/m);
    return {
      status: statusMatch?.[1] ?? null,
      reviewStatus: reviewMatch?.[1] ?? null,
    };
  } catch {
    return { status: null, reviewStatus: null };
  }
}

function isEventLoggingEnabled(repoRoot) {
  try {
    const projectMap = loadProjectMap(repoRoot);
    return projectMap?.config?.event_logging === 'enabled';
  } catch {
    return false;
  }
}

function readEventLogStatus(worktreePath, repoRoot) {
  if (repoRoot && !isEventLoggingEnabled(repoRoot)) {
    return { hasEvents: false, hasTerminalClosure: false };
  }
  const parts = worktreePath.replace(/\\/g, '/').split('/');
  const taskId = parts[parts.length - 1];
  const logPath = join(worktreePath, '.agenticloop', 'logs', `${taskId}.jsonl`);
  if (!existsSync(logPath)) return { hasEvents: false, hasTerminalClosure: false };

  try {
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    let hasTerminalClosure = false;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.event_type === 'task.closed' && event.outcome === 'success') {
          hasTerminalClosure = true;
        }
      } catch {
        // ignore malformed lines
      }
    }
    return { hasEvents: lines.length > 0, hasTerminalClosure };
  } catch {
    return { hasEvents: false, hasTerminalClosure: false };
  }
}

function resolveMainBranch(context) {
  const headRefResult = runGit(context.gitCwd, ['rev-parse', '--abbrev-ref', 'refs/remotes/origin/HEAD']);
  if (headRefResult.status === 0) {
    const headRef = headRefResult.stdout.trim();
    if (headRef && headRef !== 'HEAD') return headRef.replace(/^refs\/remotes\//, '');
  }

  for (const candidate of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    const result = runGit(context.gitCwd, ['rev-parse', '--verify', candidate]);
    if (result.status === 0) return candidate.replace(/^refs\/remotes\//, '');
  }

  for (const candidate of ['main', 'master']) {
    const result = runGit(context.gitCwd, ['rev-parse', '--verify', candidate]);
    if (result.status === 0) return candidate;
  }

  const headResult = runGit(context.gitCwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (headResult.status === 0) {
    const head = headResult.stdout.trim();
    if (head && head !== 'HEAD') return head;
  }

  return 'HEAD';
}

function isBranchMergedByAncestry(context, branch) {
  const mainBranch = resolveMainBranch(context);
  const shortBranch = branch.replace(/^refs\/heads\//, '');
  const ancestorResult = runGit(context.gitCwd, ['merge-base', '--is-ancestor', shortBranch, mainBranch]);
  return ancestorResult.status === 0;
}

function isCandidateRemovableByPreservation(worktreePath, repoRoot) {
  const preservation = planLaneLocalStatePreservation(worktreePath, repoRoot, { dryRun: true });
  if (preservation.conflicts.length > 0) {
    return { ok: false, reason: 'state file conflict', preservation };
  }
  if (preservation.errors.length > 0) {
    return { ok: false, reason: 'preservation error', preservation };
  }
  return { ok: true, preservation };
}

export function classifyWorktreesForCleanup(contextOrTarget, options = {}) {
  const context = typeof contextOrTarget === 'string' || !contextOrTarget?.repoRoot
    ? resolveGitRepositoryContext(contextOrTarget)
    : contextOrTarget;
  const backend = resolveTaskBackend(context.repoRoot);
  const lookupPrStates = options.lookupPrStates ?? (options.lookupPrState
    ? ((repoRoot, branches, opts) => {
        const map = new Map();
        for (const branch of branches) {
          map.set(branch, options.lookupPrState(repoRoot, branch, opts));
        }
        return map;
      })
    : lookupPullRequestStates);

  const result = {
    wouldRemove: [],
    kept: [],
    needsReview: [],
    preserved: [],
    errors: [],
    warning: null,
  };

  const allWorktrees = listAgenticLoopWorktrees(context);
  const standardWorktrees = [];
  for (const worktree of allWorktrees) {
    if (worktree.location === 'main' || worktree.location === 'bare-main') continue;
    if (worktree.location === 'external' || worktree.location === 'detached') {
      result.needsReview.push({
        path: worktree.path,
        reason: worktree.prunable ? 'missing/prunable worktree' : `${worktree.location} worktree`,
      });
      continue;
    }
    standardWorktrees.push(worktree);
  }

  let prStateByBranch = new Map();
  if (backend.backend === 'github' && standardWorktrees.length > 0) {
    const branches = standardWorktrees.map(w => w.branch).filter(Boolean);
    if (branches.length > 0) {
      prStateByBranch = lookupPrStates(context.repoRoot, branches, { repo: options.repo, commandRunner: options.commandRunner });
    }
  }

  for (const worktree of standardWorktrees) {
    const item = { path: worktree.path };
    const taskId = taskIdFromWorktreePath(worktree.path);

    if (worktree.locked) {
      item.reason = 'locked';
      result.kept.push(item);
      continue;
    }

    if (worktree.prunable) {
      item.reason = worktree.prunableReason
        ? `missing/prunable worktree: ${worktree.prunableReason}`
        : 'missing/prunable worktree';
      result.needsReview.push(item);
      continue;
    }

    if (worktree.blockingDirtyCount > 0) {
      item.reason = 'blocking dirty files';
      item.blockingDirtyFiles = listDirtyFiles(worktree.path)
        .filter(entry => !isLaneLocalStatePath(entry.path, taskId))
        .map(entry => entry.path);
      result.kept.push(item);
      continue;
    }

    const taskState = readTaskFileStatus(worktree.path);
    const activeStatuses = new Set(['in-progress', 'needs_context', 'blocked', 'needs_revision', 'agent-ready']);
    if (activeStatuses.has(taskState.status)) {
      item.reason = `task status ${taskState.status}`;
      result.kept.push(item);
      continue;
    }
    if (taskState.reviewStatus === 'needs_revision') {
      item.reason = 'review status needs_revision';
      result.kept.push(item);
      continue;
    }

    const branch = worktree.branch ? worktree.branch.replace(/^refs\/heads\//, '') : null;
    const prState = worktree.branch ? (prStateByBranch.get(worktree.branch) ?? null) : null;

    if (prState?.state === 'OPEN') {
      item.reason = prState.number ? `open PR #${prState.number}` : 'open PR';
      result.kept.push(item);
      continue;
    }

    if (prState?.state === 'MERGED') {
      item.reason = prState.number ? `merged PR #${prState.number}` : 'merged PR';
      const removable = isCandidateRemovableByPreservation(worktree.path, context.repoRoot);
      if (!removable.ok) {
        item.reason = removable.reason;
        item.preservation = removable.preservation;
        result.needsReview.push(item);
      } else {
        item.preservation = removable.preservation;
        result.wouldRemove.push(item);
      }
      continue;
    }

    if (prState?.state === 'CLOSED') {
      item.reason = prState.number ? `closed unmerged PR #${prState.number}` : 'closed unmerged PR';
      result.needsReview.push(item);
      continue;
    }

    if (branch && isBranchMergedByAncestry(context, branch)) {
      if (backend.backend === 'github' && prState?.warning) {
        item.reason = 'GitHub lookup failed; not classified by ancestry';
        result.needsReview.push(item);
        continue;
      }

      const eventStatus = readEventLogStatus(worktree.path, context.repoRoot);
      if (backend.backend !== 'github' && eventStatus.hasEvents && !eventStatus.hasTerminalClosure) {
        item.reason = 'event log has non-terminal state';
        result.kept.push(item);
        continue;
      }

      item.reason = 'already merged by ancestry';
      const removable = isCandidateRemovableByPreservation(worktree.path, context.repoRoot);
      if (!removable.ok) {
        item.reason = removable.reason;
        item.preservation = removable.preservation;
        result.needsReview.push(item);
      } else {
        item.preservation = removable.preservation;
        result.wouldRemove.push(item);
      }
      continue;
    }

    if (prState?.warning) {
      item.reason = 'no PR found; GitHub lookup failed';
      result.needsReview.push(item);
      continue;
    }

    const eventStatus = readEventLogStatus(worktree.path, context.repoRoot);
    if (eventStatus.hasEvents && !eventStatus.hasTerminalClosure) {
      item.reason = 'event log has non-terminal state';
      result.kept.push(item);
      continue;
    }

    item.reason = 'no PR found; not merged by ancestry';
    result.needsReview.push(item);
  }

  if (standardWorktrees.length === 0) {
    const standardParent = join(context.repoRoot, WORKTREE_PARENT);
    const hasMisclassified = allWorktrees.some(
      r => r.location !== 'standard' && r.location !== 'main' && r.location !== 'bare-main' && isSubpath(standardParent, r.path)
    );
    if (hasMisclassified) {
      result.warning = `Worktrees exist under ${WORKTREE_PARENT} but were not classified as standard; repo root resolution may be wrong. Use explicit paths or review the repository topology.`;
    }
  }

  return result;
}

export function removeAgenticLoopWorktree(options = {}) {
  const {
    target = process.cwd(),
    identifier,
    dryRun = false,
    yes = false,
    force = false,
  } = options;

  if (!identifier) {
    throw new Error('worktree remove requires a task-id or path');
  }
  if (!dryRun && !yes) {
    throw new Error('worktree remove requires either --dry-run or --yes');
  }
  if (dryRun && yes) {
    throw new Error('worktree remove accepts either --dry-run or --yes, not both');
  }

  const context = resolveGitRepositoryContext(target);
  const standardParent = join(context.repoRoot, WORKTREE_PARENT);
  const standardCandidate = join(standardParent, identifier);
  let worktreePath;

  if (isSubpath(standardParent, standardCandidate) && existsSync(standardCandidate)) {
    worktreePath = standardCandidate;
  } else {
    const explicitPath = resolve(context.target, identifier);
    if (!existsSync(explicitPath)) {
      throw new Error(`worktree not found: ${identifier}`);
    }
    worktreePath = explicitPath;
  }

  const record = listAgenticLoopWorktrees(context).find(r => r.path === worktreePath);
  if (!record) {
    throw new Error(`worktree is not registered with Git: ${worktreePath}`);
  }

  const removed = [];
  const skipped = [];
  const preserved = [];
  const errors = [];

  if (record.location === 'main' || record.location === 'bare-main') {
    errors.push(`refusing to remove main worktree: ${record.path}`);
    return { removed, skipped, preserved, errors };
  }

  if (record.locked) {
    errors.push(`refusing to remove locked worktree: ${record.path}`);
    return { removed, skipped, preserved, errors };
  }

  if (record.blockingDirtyCount > 0 && !force) {
    errors.push(`refusing to remove dirty worktree (use --force): ${record.path}`);
    return { removed, skipped, preserved, errors };
  }

  const isExplicitPath = resolve(context.target, identifier) === worktreePath;
  if ((record.location === 'external' || record.detached) && !isExplicitPath) {
    errors.push(`refusing to remove ${record.location} worktree without explicit path: ${record.path}`);
    return { removed, skipped, preserved, errors };
  }

  const taskId = taskIdFromWorktreePath(worktreePath);
  const remainingDirty = listDirtyFiles(worktreePath);
  const remainingBlocking = remainingDirty.filter(entry => !isLaneLocalStatePath(entry.path, taskId));
  const hasLaneLocalDirt = remainingDirty.some(entry => isLaneLocalStatePath(entry.path, taskId));
  if (remainingBlocking.length > 0 && !force) {
    errors.push(`refusing to remove dirty worktree (use --force): ${record.path}`);
    return { removed, skipped, preserved, errors };
  }

  const preservation = planLaneLocalStatePreservation(worktreePath, context.repoRoot, { dryRun });
  preserved.push(...preservation.preserved, ...preservation.wouldPreserve);
  if (preservation.conflicts.length > 0) {
    for (const conflict of preservation.conflicts) {
      errors.push(`${conflict.target}: ${conflict.reason}`);
    }
    return { removed, skipped, preserved, errors };
  }
  if (preservation.errors.length > 0) {
    errors.push(...preservation.errors);
    return { removed, skipped, preserved, errors };
  }

  try {
    if (!dryRun) {
      const removeArgs = ['worktree', 'remove'];
      if (force || hasLaneLocalDirt) removeArgs.push('--force');
      removeArgs.push(worktreePath);
      const removeResult = runGit(context.gitCwd, removeArgs);
      if (removeResult.status !== 0) {
        throw new Error(outputText(removeResult));
      }
    }
    removed.push(relative(context.repoRoot, worktreePath).replace(/\\/g, '/'));
  } catch (error) {
    errors.push(`${worktreePath}: ${error.message}`);
  }

  return { removed, skipped, preserved, errors };
}

export function cleanupAgenticLoopWorktrees(options = {}) {
  const {
    target = process.cwd(),
    dryRun = false,
    yes = false,
    repo,
    lookupPrState,
    lookupPrStates,
    commandRunner,
  } = options;

  if (!dryRun && !yes) {
    throw new Error('worktree cleanup requires either --dry-run or --yes');
  }
  if (dryRun && yes) {
    throw new Error('worktree cleanup accepts either --dry-run or --yes, not both');
  }

  const context = resolveGitRepositoryContext(target);
  const classification = classifyWorktreesForCleanup(context, { repo, lookupPrState, lookupPrStates, commandRunner });

  const removed = [];
  const kept = [...classification.kept];
  const needsReview = [...classification.needsReview];
  const preserved = [];
  const wouldPreserve = [];
  const alreadyPreserved = [];
  const ignoredShared = [];
  const errors = [...classification.errors];

  for (const item of classification.wouldRemove) {
    const worktreePath = item.path;
    const relativePath = relative(context.repoRoot, worktreePath).replace(/\\/g, '/');

    const preservation = planLaneLocalStatePreservation(worktreePath, context.repoRoot, { dryRun });
    if (preservation.conflicts.length > 0) {
      for (const conflict of preservation.conflicts) {
        errors.push(`${conflict.target}: ${conflict.reason}`);
      }
      needsReview.push({ path: worktreePath, reason: 'state file conflict' });
      continue;
    }
    if (preservation.errors.length > 0) {
      errors.push(...preservation.errors);
      needsReview.push({ path: worktreePath, reason: 'preservation error' });
      continue;
    }

    preserved.push(...preservation.preserved);
    wouldPreserve.push(...preservation.wouldPreserve);
    alreadyPreserved.push(...preservation.alreadyPreserved);
    ignoredShared.push(...preservation.ignoredShared);

    try {
      if (!dryRun) {
        const taskId = taskIdFromWorktreePath(worktreePath);
        const remainingDirty = listDirtyFiles(worktreePath);
        const remainingBlocking = remainingDirty.filter(entry => !isLaneLocalStatePath(entry.path, taskId));
        const hasLaneLocalDirt = remainingDirty.some(entry => isLaneLocalStatePath(entry.path, taskId));
        if (remainingBlocking.length > 0) {
          throw new Error(`blocking dirty files remain after preservation: ${remainingBlocking.map(e => e.path).join(', ')}`);
        }
        const removeArgs = ['worktree', 'remove'];
        if (hasLaneLocalDirt) removeArgs.push('--force');
        removeArgs.push(worktreePath);
        const removeResult = runGit(context.gitCwd, removeArgs);
        if (removeResult.status !== 0) {
          throw new Error(outputText(removeResult));
        }
      }
      removed.push({ path: worktreePath, relativePath, reason: item.reason });
    } catch (error) {
      errors.push(`${worktreePath}: ${error.message}`);
      needsReview.push({ path: worktreePath, reason: 'remove failed' });
    }
  }

  return {
    removed,
    wouldRemove: dryRun ? removed : undefined,
    kept,
    needsReview,
    preserved: [...new Set(preserved)],
    wouldPreserve: [...new Set(wouldPreserve)],
    alreadyPreserved: [...new Set(alreadyPreserved)],
    ignoredShared: [...new Set(ignoredShared)],
    errors,
    dryRun,
    warning: classification.warning,
  };
}

export function resolveAgenticLoopStateConflicts(options = {}) {
  const {
    target = process.cwd(),
    identifier,
    strategy,
    dryRun = false,
    yes = false,
  } = options;

  if (!identifier) {
    throw new Error('worktree resolve-state requires a task-id or path');
  }
  if (!dryRun && !yes) {
    throw new Error('worktree resolve-state requires either --dry-run or --yes');
  }
  if (dryRun && yes) {
    throw new Error('worktree resolve-state accepts either --dry-run or --yes, not both');
  }
  if (yes && !strategy) {
    throw new Error('worktree resolve-state --yes requires --strategy');
  }

  const validStrategies = new Set(['prefer-root', 'prefer-worktree', 'union-jsonl']);
  if (strategy && !validStrategies.has(strategy)) {
    throw new Error(`unknown strategy '${strategy}'; use prefer-root, prefer-worktree, or union-jsonl`);
  }

  const context = resolveGitRepositoryContext(target);
  const standardParent = join(context.repoRoot, WORKTREE_PARENT);
  const standardCandidate = join(standardParent, identifier);
  let worktreePath;

  if (isSubpath(standardParent, standardCandidate) && existsSync(standardCandidate)) {
    worktreePath = standardCandidate;
  } else {
    const explicitPath = resolve(context.target, identifier);
    if (!existsSync(explicitPath)) {
      throw new Error(`worktree not found: ${identifier}`);
    }
    worktreePath = explicitPath;
  }

  const record = listAgenticLoopWorktrees(context).find(r => r.path === worktreePath);
  if (!record) {
    throw new Error(`worktree is not registered with Git: ${worktreePath}`);
  }
  if (record.location === 'main' || record.location === 'bare-main') {
    throw new Error(`refusing to resolve state for main worktree: ${record.path}`);
  }
  if (record.locked) {
    throw new Error(`refusing to resolve state for locked worktree: ${record.path}`);
  }
  if (record.location === 'external' || record.detached) {
    throw new Error(`refusing to resolve state for ${record.location} worktree: ${record.path}`);
  }

  const taskId = taskIdFromWorktreePath(worktreePath);
  const repoRoot = context.repoRoot;
  const preservation = planLaneLocalStatePreservation(worktreePath, repoRoot, { dryRun: true });
  const actions = [];
  const errors = [];

  for (const conflict of preservation.conflicts) {
    const sourcePath = resolve(repoRoot, conflict.source);
    const targetPath = resolve(repoRoot, conflict.target);
    const sourceRelToWorktree = relative(worktreePath, sourcePath).replace(/\\/g, '/');

    if (!isLaneLocalStatePath(sourceRelToWorktree, taskId)) {
      errors.push(`${conflict.source}: not a lane-local state file for ${taskId}`);
      continue;
    }

    if (!strategy) {
      actions.push({
        source: conflict.source,
        target: conflict.target,
        action: dryRun ? 'would-keep' : 'kept-root',
      });
      continue;
    }

    if (strategy === 'prefer-root') {
      let discarded = 0;
      if (sourcePath.toLowerCase().endsWith('.jsonl') && targetPath.toLowerCase().endsWith('.jsonl')) {
        const rootContent = readFileSync(targetPath, 'utf-8');
        const laneContent = readFileSync(sourcePath, 'utf-8');
        discarded = missingLineCount(splitJsonlLines(rootContent), splitJsonlLines(laneContent));
      }
      if (!dryRun) {
        try {
          copyFileSync(targetPath, sourcePath);
        } catch (error) {
          errors.push(`${conflict.source}: ${error.message}`);
          continue;
        }
      }
      actions.push({
        source: conflict.source,
        target: conflict.target,
        action: dryRun ? 'would-sync-lane-from-root' : 'synced-lane-from-root',
        discarded,
      });
      continue;
    }

    if (strategy === 'prefer-worktree') {
      if (!dryRun) {
        try {
          copyFileSync(sourcePath, targetPath);
        } catch (error) {
          errors.push(`${conflict.target}: ${error.message}`);
          continue;
        }
      }
      actions.push({
        source: conflict.source,
        target: conflict.target,
        action: dryRun ? 'would-overwrite' : 'overwrote',
      });
      continue;
    }

    if (strategy === 'union-jsonl') {
      if (!sourcePath.toLowerCase().endsWith('.jsonl') || !targetPath.toLowerCase().endsWith('.jsonl')) {
        const reason = 'union-jsonl only supports .jsonl files';
        actions.push({
          source: conflict.source,
          target: conflict.target,
          action: 'skipped-unsupported',
          reason,
        });
        errors.push(`${conflict.source}: ${reason}`);
        continue;
      }

      try {
        const targetContent = readFileSync(targetPath, 'utf-8');
        const sourceContent = readFileSync(sourcePath, 'utf-8');
        const rootLines = splitJsonlLines(targetContent);
        const laneLines = splitJsonlLines(sourceContent);
        const unionLines = jsonlUnion(rootLines, laneLines);
        const appended = unionLines.length - rootLines.length;

        if (!dryRun) {
          const output = formatJsonlLines(unionLines);
          writeFileSync(targetPath, output, 'utf-8');
          writeFileSync(sourcePath, output, 'utf-8');
        }
        actions.push({
          source: conflict.source,
          target: conflict.target,
          action: dryRun ? 'would-union-sync' : 'union-synced',
          lines: appended,
        });
      } catch (error) {
        errors.push(`${conflict.target}: ${error.message}`);
        continue;
      }
    }
  }

  let remainingConflicts = [];
  if (yes && !dryRun && errors.length === 0) {
    const verification = planLaneLocalStatePreservation(worktreePath, repoRoot, { dryRun: true });
    remainingConflicts = verification.conflicts;
    if (remainingConflicts.length > 0) {
      for (const conflict of remainingConflicts) {
        errors.push(`${conflict.target}: remaining conflict after ${strategy}: ${conflict.reason}`);
      }
    }
  }

  return {
    dryRun,
    worktreePath,
    taskId,
    strategy,
    conflicts: preservation.conflicts,
    actions,
    errors,
    remainingConflicts: dryRun ? null : remainingConflicts,
  };
}

export function formatResolveStateResult(result) {
  const lines = ['agenticloop worktree resolve-state'];
  lines.push('='.repeat(50));
  if (result.dryRun) lines.push('  (dry run - no changes will be made)');
  if (result.strategy) lines.push(`  strategy: ${result.strategy}`);
  for (const action of result.actions) {
    let detail;
    switch (action.action) {
      case 'would-keep':
        detail = `would keep root: ${action.target}`;
        break;
      case 'kept-root':
        detail = `kept root: ${action.target}`;
        break;
      case 'would-overwrite':
        detail = `would overwrite root with lane: ${action.target}`;
        break;
      case 'overwrote':
        detail = `overwrote root with lane: ${action.target}`;
        break;
      case 'would-sync-lane-from-root':
        detail = action.discarded > 0
          ? `would sync lane from root: ${action.target} (${action.discarded} lane-only line(s) would be discarded)`
          : `would sync lane from root: ${action.target}`;
        break;
      case 'synced-lane-from-root':
        detail = action.discarded > 0
          ? `synced lane from root: ${action.target} (${action.discarded} lane-only line(s) discarded)`
          : `synced lane from root: ${action.target}`;
        break;
      case 'would-union-sync':
        detail = `would union-sync ${action.lines} line(s) to root and lane: ${action.target}`;
        break;
      case 'union-synced':
        detail = `union-synced ${action.lines} line(s) to root and lane: ${action.target}`;
        break;
      case 'skipped-unsupported':
        detail = `skipped unsupported conflict: ${action.target} (${action.reason})`;
        break;
      default:
        detail = `${action.action}: ${action.target}`;
    }
    lines.push(`  ${detail}`);
  }
  for (const error of result.errors) lines.push(`  ERROR: ${error}`);
  if (result.actions.length === 0 && result.errors.length === 0) {
    lines.push('  No lane-local state conflicts found.');
  }
  return lines.join('\n');
}

export function pruneAgenticLoopWorktrees(options = {}) {
  const {
    target = process.cwd(),
    dryRun = false,
    yes = false,
  } = options;

  if (!dryRun && !yes) {
    throw new Error('worktree prune requires either --dry-run or --yes');
  }
  if (dryRun && yes) {
    throw new Error('worktree prune accepts either --dry-run or --yes, not both');
  }

  const context = resolveGitRepositoryContext(target);
  const args = dryRun
    ? ['worktree', 'prune', '--dry-run', '--verbose']
    : ['worktree', 'prune', '--verbose'];
  const result = runGit(context.gitCwd, args);

  const pruned = [];
  const errors = [];

  if (result.status !== 0) {
    errors.push(outputText(result) || `git worktree prune exited ${result.status}`);
    return { pruned, dryRun, errors };
  }

  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    pruned.push(trimmed);
  }

  return { pruned, dryRun, errors };
}

export function formatWorktreeList(records) {
  if (records.length === 0) return 'No worktrees found.';
  const lines = ['Agentic Loop worktrees:'];
  for (const record of records) {
    const branch = record.branch ? record.branch.replace(/^refs\/heads\//, '') : (record.detached ? '(detached)' : '(unknown)');
    const flags = [
      record.location,
      record.locked ? 'locked' : null,
      record.prunable ? (record.prunableReason ? `prunable (${record.prunableReason})` : 'prunable') : null,
      record.dirtyCount !== null ? `dirty=${record.dirtyCount}` : null,
    ].filter(Boolean).join('; ');
    const guard = record.guard ? (record.guard.ok ? 'guarded' : `missing ${record.guard.missing.join(', ')}`) : 'n/a';
    lines.push(`  ${relative(process.cwd(), record.path).replace(/\\/g, '/') || record.path}`);
    lines.push(`    branch: ${branch}, HEAD: ${record.head ?? 'unknown'}, flags: ${flags}`);
    lines.push(`    guard: ${guard}`);
  }
  return lines.join('\n');
}

export function formatWorktreeRemoveResult(result, { dryRun = false } = {}) {
  const lines = ['agenticloop worktree remove'];
  lines.push('='.repeat(50));
  if (dryRun) lines.push('  (dry run - no changes will be made)');
  const prefix = dryRun ? 'would remove' : 'removed';
  for (const item of result.removed) lines.push(`  ${prefix}: ${item}`);
  for (const item of result.skipped) lines.push(`  skipped: ${item}`);
  for (const item of result.preserved) lines.push(`  preserved: ${item}`);
  for (const error of result.errors) lines.push(`  ERROR: ${error}`);
  return lines.join('\n');
}

export function formatWorktreeCleanupResult(result) {
  const lines = ['agenticloop worktree cleanup'];
  lines.push('='.repeat(50));
  if (result.dryRun) lines.push('  (dry run - no changes will be made)');
  if (result.warning) lines.push(`  WARN: ${result.warning}`);

  const prefix = result.dryRun ? 'would remove' : 'removed';
  for (const item of result.removed) lines.push(`  ${prefix}: ${item.relativePath} (${item.reason})`);
  for (const item of result.kept) {
    const detail = item.blockingDirtyFiles?.length
      ? `${item.reason}: ${item.blockingDirtyFiles.join(', ')}`
      : item.reason;
    lines.push(`  kept: ${relative(process.cwd(), item.path).replace(/\\/g, '/')} (${detail})`);
  }
  for (const item of result.needsReview) lines.push(`  needs review: ${relative(process.cwd(), item.path).replace(/\\/g, '/')} (${item.reason})`);
  for (const item of result.wouldPreserve ?? []) lines.push(`  would preserve: ${item}`);
  for (const item of result.alreadyPreserved ?? []) lines.push(`  already preserved: ${item}`);
  for (const item of result.ignoredShared ?? []) lines.push(`  ignored shared state: ${item}`);
  for (const item of result.preserved ?? []) lines.push(`  preserved: ${item}`);
  for (const error of result.errors) lines.push(`  ERROR: ${error}`);
  return lines.join('\n');
}

export function formatWorktreePruneResult(result) {
  const lines = ['agenticloop worktree prune'];
  lines.push('='.repeat(50));
  if (result.dryRun) lines.push('  (dry run - no changes will be made)');
  if (result.pruned.length === 0) {
    lines.push('  No prunable worktree registrations found.');
  } else {
    for (const item of result.pruned) lines.push(`  ${result.dryRun ? 'would prune' : 'pruned'}: ${item}`);
  }
  for (const error of result.errors) lines.push(`  ERROR: ${error}`);
  return lines.join('\n');
}
