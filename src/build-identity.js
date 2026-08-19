/**
 * Which build of Agentic Loop is actually running.
 *
 * `--version` printed `agenticloop 0.4.3` for three days while the installed
 * tree was two commits past that release. The package installs from a Git ref,
 * so the version string does not move between releases, and every field record
 * written during that run says "toolkit upgraded to 0.4.3" and "re-run fresh
 * under CLI 0.4.3" - statements that cannot distinguish the release from either
 * post-release build. One of the findings in that cohort turned on exactly that
 * distinction: a defect was corrected mid-run, and nothing in the record could
 * say which side of the fix a given refusal came from.
 *
 * So a build carries a marker beside its version, derived from whatever the
 * running tree can actually prove:
 *
 * - a Git checkout proves its commit, and whether the tree is dirty;
 * - an installed tree proves its own source bytes, which is what a Git-ref
 *   install has instead of a commit - and is exactly the case the field met.
 *
 * The marker is descriptive, never authoritative: nothing gates on it, and it
 * is deliberately cheap enough to compute only when a version is being printed.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GIT_MAX_BUFFER } from './git-runner.js';

/** The installed package root: the directory holding `package.json`. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Source trees whose bytes define one build when no commit is available. */
const SOURCE_ROOTS = Object.freeze(['src', 'bin']);

let cached = null;

function git(args) {
  const result = spawnSync('git', args, { cwd: PACKAGE_ROOT, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  return result.status === 0 ? String(result.stdout ?? '') : null;
}

function gitBuildMarker() {
  // Only a checkout that owns its own `.git` describes this package. A package
  // installed inside some other repository's `node_modules` would otherwise
  // report that repository's commit, which is a worse lie than no marker.
  if (!existsSync(join(PACKAGE_ROOT, '.git'))) return null;
  const commit = git(['rev-parse', 'HEAD'])?.trim();
  if (!commit || !/^[0-9a-f]{40,64}$/.test(commit)) return null;
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  const dirty = status === null ? false : status.trim() !== '';
  return `git:${commit.slice(0, 12)}${dirty ? '+dirty' : ''}`;
}

function digestTree(root, hash) {
  const entries = [];
  const walk = (directory, prefix) => {
    let names;
    try { names = readdirSync(directory).sort(); } catch { return; }
    for (const name of names) {
      const full = join(directory, name);
      let stats;
      try { stats = statSync(full); } catch { continue; }
      if (stats.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (name.endsWith('.js')) entries.push([`${prefix}${name}`, readFileSync(full)]);
    }
  };
  walk(join(PACKAGE_ROOT, root), `${root}/`);
  for (const [path, bytes] of entries) {
    hash.update(path, 'utf8');
    hash.update('\0');
    hash.update(createHash('sha256').update(bytes).digest());
  }
  return entries.length;
}

function sourceBuildMarker() {
  const hash = createHash('sha256');
  let files = 0;
  for (const root of SOURCE_ROOTS) files += digestTree(root, hash);
  if (files === 0) return null;
  return `src:${hash.digest('hex').slice(0, 12)}`;
}

/**
 * The build marker for the running package, or `null` when the tree can prove
 * nothing about itself.
 */
export function packageBuildMarker() {
  if (cached !== null) return cached.marker;
  cached = { marker: gitBuildMarker() ?? sourceBuildMarker() };
  return cached.marker;
}

/** `<version>` or `<version> (build <marker>)`, for every version surface. */
export function renderPackageVersion(version) {
  const marker = packageBuildMarker();
  return marker ? `${version} (build ${marker})` : String(version);
}
