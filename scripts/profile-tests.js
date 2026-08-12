#!/usr/bin/env node
/**
 * profile-tests.js — dependency-free, cross-platform per-file test profiler.
 *
 * Runs each `test/**\/*.test.js` file in ISOLATION (its own `node --test`
 * process) and records wall-clock duration. This is a DIAGNOSTIC measurement:
 * isolated per-file timings are NOT equivalent to a file's contribution to the
 * full-suite wall clock, because the full suite runs files concurrently. Use it
 * to find the slowest files, not to predict `npm test` time.
 *
 * Usage:
 *   node scripts/profile-tests.js [--jobs <n>] [--dir <test-dir>] [--group <group>] [--match <regex>] [--json <path>]
 *
 *   --jobs <n>   Number of test files to profile in parallel (default: 1, i.e.
 *                fully isolated sequential timing). Higher values finish faster
 *                but the individual timings become less comparable.
 *   --dir <d>    Root directory to discover test files under (default: test).
 *   --group <g>  Profile a validated manifest group: unit, integration, e2e, or fast.
 *   --match <r>  Restrict the selected files to a regular expression.
 *   --json <p>   Also write the raw results as JSON to <p>.
 *
 * Exit code is nonzero if any test file fails.
 */

import { spawn } from 'node:child_process';
import { readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { assertPartition, GROUPS } from './test-groups.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = 'Usage: node scripts/profile-tests.js [--jobs <n>] [--dir <test-dir>] [--group <unit|integration|e2e|fast>] [--match <regex>] [--json <path>]';

class UsageError extends Error {
  constructor(message) {
    super(`${message}\n${USAGE}`);
    this.exitCode = 2;
  }
}

export function parseArgv(argv) {
  const opts = { jobs: 1, dir: 'test', group: null, match: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--jobs' || arg === '-j') {
      const value = argv[++i];
      if (!value) throw new UsageError(`${arg} requires a number`);
      opts.jobs = Math.max(1, Number.parseInt(value, 10) || 1);
    } else if (arg === '--dir') {
      opts.dir = argv[++i];
      if (!opts.dir) throw new UsageError('--dir requires a test directory');
    } else if (arg === '--group') {
      opts.group = argv[++i];
      if (![...GROUPS, 'fast'].includes(opts.group)) throw new UsageError(`--group must be one of: ${[...GROUPS, 'fast'].join(', ')}`);
    } else if (arg === '--match') {
      opts.match = argv[++i];
      if (!opts.match) throw new UsageError('--match requires a regular expression');
      try {
        new RegExp(opts.match);
      } catch {
        throw new UsageError('--match must be a valid regular expression');
      }
    } else if (arg === '--json') {
      opts.json = argv[++i];
      if (!opts.json) throw new UsageError('--json requires a path');
    } else {
      throw new UsageError(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

/** Recursively discover *.test.js files using only Node fs APIs. */
export function discoverTestFiles(rootDir) {
  const found = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.test.js')) {
        found.push(full);
      }
    }
  }
  walk(rootDir);
  return found.sort();
}

export function selectProfileFiles(opts, validatePartition = assertPartition) {
  // Validate before any discovery or child process can run. A stale manifest is
  // a repository-wide integrity failure, not only a grouped-profile concern.
  const partition = validatePartition();
  let files = opts.group
    ? partition[opts.group]
    : discoverTestFiles(join(repoRoot, opts.dir));
  if (opts.match) {
    const pattern = new RegExp(opts.match);
    files = files.filter(file => pattern.test(relative(repoRoot, file).split(sep).join('/')));
  }
  return files;
}

function runOneFile(file) {
  return new Promise((resolvePromise) => {
    const start = process.hrtime.bigint();
    const child = spawn(
      process.execPath,
      ['--test', file],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      // Best-effort parse of the TAP summary for a per-file test count.
      const passMatch = stdout.match(/# pass (\d+)/);
      const failMatch = stdout.match(/# fail (\d+)/);
      resolvePromise({
        file: relative(repoRoot, file).split(sep).join('/'),
        ok: code === 0,
        code,
        durationMs,
        pass: passMatch ? Number(passMatch[1]) : null,
        fail: failMatch ? Number(failMatch[1]) : null,
        stderr: code === 0 ? '' : stderr.slice(-2000),
      });
    });
  });
}

async function runWithConcurrency(files, jobs) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < files.length) {
      const my = index++;
      const result = await runOneFile(files[my]);
      results.push(result);
      const status = result.ok ? 'PASS' : 'FAIL';
      process.stdout.write(
        `[${String(results.length).padStart(3)}/${files.length}] ${status} ` +
        `${result.durationMs.toFixed(0).padStart(7)} ms  ${result.file}\n`
      );
    }
  }
  const workers = Array.from({ length: Math.min(jobs, files.length) }, worker);
  await Promise.all(workers);
  return results;
}

function formatMs(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const files = selectProfileFiles(opts);

  process.stdout.write(
    `Profiling ${files.length} test files (isolated per-file timings, ` +
    `jobs=${opts.jobs}, ${cpus().length} CPUs).\n` +
    `NOTE: isolated timings are diagnostic and do NOT equal full-suite ` +
    `wall-clock contribution.\n\n`
  );

  const wallStart = process.hrtime.bigint();
  const results = await runWithConcurrency(files, opts.jobs);
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

  const sorted = [...results].sort((a, b) => b.durationMs - a.durationMs);
  const failed = results.filter((r) => !r.ok);

  process.stdout.write(`\nSlowest files (isolated):\n`);
  for (const r of sorted.slice(0, 20)) {
    process.stdout.write(
      `  ${formatMs(r.durationMs).padStart(9)}  ${r.file}` +
      `${r.ok ? '' : '  <-- FAILED'}\n`
    );
  }

  const sumMs = results.reduce((acc, r) => acc + r.durationMs, 0);
  process.stdout.write(
    `\nTotal profiling wall time: ${formatMs(wallMs)} (jobs=${opts.jobs})\n` +
    `Sum of isolated file times: ${formatMs(sumMs)}\n` +
    `Files: ${results.length}  Failed: ${failed.length}\n`
  );

  if (failed.length > 0) {
    process.stdout.write(`\nFailed files:\n`);
    for (const r of failed) {
      process.stdout.write(`  ${r.file} (exit ${r.code})\n`);
    }
  }

  if (opts.json) {
    const jsonPath = isAbsolute(opts.json) ? opts.json : join(repoRoot, opts.json);
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(
      jsonPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), jobs: opts.jobs, wallMs, sumMs, results: sorted }, null, 2)
    );
    process.stdout.write(`\nWrote JSON results to ${opts.json}\n`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(err.exitCode);
      return;
    }
    process.stderr.write(`profile-tests failed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(err?.exitCode ?? 1);
  });
}
