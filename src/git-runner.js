/**
 * Shared execution defaults for `spawnSync('git', ...)` calls.
 *
 * Git porcelain output can far exceed Node's 1 MB `spawnSync` default
 * `maxBuffer`. The dispatch clean gate in particular queries ignored paths
 * under `.agenticloop/`, and a single `npm test` run produces well over 1 MB
 * of ignored scratch content there. With the default buffer such a call
 * returns `status: null` and `error.code: 'ENOBUFS'`, which the clean gate
 * would otherwise misread as a Git failure and refuse a pristine checkout.
 *
 * Every `spawnSync('git', ...)` in `src/` binds this buffer so large but
 * legitimate porcelain output is read in full rather than truncated into a
 * false failure. An ENOBUFS after this ceiling is a genuine operational fault
 * and still fails closed, but distinctly (see `evaluateDispatchCleanState`).
 */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;
