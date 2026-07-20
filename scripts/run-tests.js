#!/usr/bin/env node
/**
 * Cross-platform grouped test runner.
 *
 *   node scripts/run-tests.js fast          Deliberate unit + quick integration selection.
 *   node scripts/run-tests.js unit          Pure logic tests, no subprocess, no temp FS.
 *   node scripts/run-tests.js integration   Module-level filesystem integration.
 *   node scripts/run-tests.js e2e           Real binary, Git, packaging.
 *   node scripts/run-tests.js check         Validate the partition and print the split.
 *
 * `npm test` remains a single `node --test "test/**\/*.test.js"` invocation over
 * the whole suite; these groups are focused developer workflows only.
 *
 * Extra arguments after the group are forwarded to `node --test`
 * (e.g. `node scripts/run-tests.js e2e --test-concurrency=4`).
 */

import { spawnSync } from 'node:child_process';
import { assertPartition, fastFiles, groupFiles, GROUPS, rel, REPO_ROOT } from './test-groups.js';

function main() {
  const [requested, ...passthrough] = process.argv.slice(2);
  const group = requested;

  if (group === 'check' || !requested) {
    const partition = assertPartition();
    process.stdout.write(
      `Test group partition OK: ${partition.all.length} files = ` +
      GROUPS.map((g) => `${partition[g].length} ${g}`).join(' + ') +
      `; fast=${partition.fast.length}\n\n`
    );
    for (const g of GROUPS) {
      process.stdout.write(`${g}:\n` + partition[g].map((f) => `  ${rel(f)}`).join('\n') + '\n\n');
    }
    if (!requested) {
      process.stderr.write('Usage: node scripts/run-tests.js <fast|unit|integration|e2e|check> [node --test args]\n');
      process.exit(2);
    }
    return;
  }

  if (group !== 'fast' && !GROUPS.includes(group)) {
    process.stderr.write(`Unknown group '${requested}'. Expected: fast, unit, integration, e2e, or check.\n`);
    process.exit(2);
  }

  // Fail loudly if a file is unclassified before running a partial group.
  assertPartition();
  const files = group === 'fast' ? fastFiles() : groupFiles()[group];
  if (files.length === 0) {
    process.stderr.write(`No test files in group '${group}'.\n`);
    process.exit(1);
  }

  const result = spawnSync(
    process.execPath,
    ['--test', ...passthrough, ...files],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  process.exit(result.status ?? 1);
}

main();
