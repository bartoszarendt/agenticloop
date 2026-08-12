# Developer Test Workflows

Use the focused workflows below for local feedback. They complement, but do not
replace, the full validation required before delivery.

## Fast Feedback

```text
npm run test:fast
npm run test:changed -- --list
npm run test:changed -- --dry-run
```

`test:fast` runs an explicit, reviewed selection of unit and integration tests.
`test:changed` selects tests from tracked, staged, and nonignored untracked
changes. `--list` and `--dry-run` are equivalent preview modes: they print the
changed files, selected tests, reasons, and any full-suite fallback without
running tests. Use `--base <revision>` to include changes from
`<revision>...HEAD` in the selection.

The changed-test selector fails safe by widening to the full suite for central
metadata, unknown paths, shared fixtures, and relevant dependency ambiguity.
Central metadata includes package and lock files, `config.json`, and the test
runner scripts. Literal repository data reads are followed directly; dynamic
reads widen only when their normalized repository scope overlaps the changed
dependency. It is a developer aid, not a sole CI gate; CI and delivery
validation must still run the required full checks.

## Test Groups

The repository classifies every test as `unit`, `integration`, or `e2e`; the
fast set is a separate deliberate selection. Validate and print that partition:

```text
npm run test:groups
```

Run a single group when investigating a relevant boundary:

```text
node scripts/run-tests.js unit
node scripts/run-tests.js integration
npm run test:e2e
```

Arguments after a group are passed to Node's test runner. For example, override
Node test-file concurrency for a focused run:

```text
npm run test:e2e -- --test-concurrency=4
```

The same Node option can be used for the whole suite:

```text
npm test -- --test-concurrency=4
```

`AGENTICLOOP_PACKED_CONCURRENCY` separately controls the concurrency of the
`packed package boundary` test's cases. It does not set Node's test-file
concurrency. In PowerShell, for example:

```text
$env:AGENTICLOOP_PACKED_CONCURRENCY = '2'
node --test test/packed-package.test.js
Remove-Item Env:AGENTICLOOP_PACKED_CONCURRENCY
```

To reuse an existing package archive for that test, set
`AGENTICLOOP_TEST_ARCHIVE` to an existing path relative to the repository root.
The packed-package test installs that archive instead of creating a new one; it
still performs its package-boundary checks. Create an archive first, then use the
filename reported by `npm pack`:

```text
npm pack --pack-destination .agenticloop/tmp
$env:AGENTICLOOP_TEST_ARCHIVE = '.agenticloop/tmp/<archive>.tgz'
node --test test/packed-package.test.js
Remove-Item Env:AGENTICLOOP_TEST_ARCHIVE
```

## Profiling

Profile tests to identify slow files, not to set pass/fail timing targets:

```text
npm run test:profile -- --group fast --jobs 4
npm run test:profile -- --group e2e --match packed-package
```

`--group` accepts `unit`, `integration`, `e2e`, or `fast`; `--match` filters
selected paths with a regular expression; and `--jobs` controls how many files
are profiled in parallel. Profiling runs each selected file in its own process,
so its isolated durations are diagnostic and do not predict full-suite wall time.

## Required Full Validation

Before delivery, run the full suite and validate the toolkit:

```text
npx agenticloop validate
npm test
```

Run `npm run typecheck` when the change affects typed surfaces. Focused groups,
profiles, and `test:changed` reduce iteration cost; they do not replace required
full validation.
