/**
 * Sanitized OpenCode permission corpus for the three-tier router.
 *
 * Every entry is the exact `permission.updated` shape the pinned OpenCode
 * 1.18.4 bridge forwards as `permission.asked`: `id`, `sessionID`, `type`,
 * `pattern`, `metadata`, plus the `working_directory` the generated plugin adds
 * from `ctx.directory`.
 *
 * Provenance is explicit per entry:
 *
 * - `sanitized-host-shape` -- the field shape was taken from a real pinned-host
 *   permission event and then rewritten with neutral project-relative paths and
 *   invented identifiers.
 * - `synthetic` -- constructed for this corpus to exercise a boundary the
 *   observed traffic did not happen to contain.
 *
 * No entry contains a credential, a personal path, a real session id, or any
 * transcript text. The two credential-bearing entries use obviously fake
 * placeholder tokens whose only purpose is to prove the sensitivity boundary
 * fires before anything is stored or projected.
 *
 * `expected_tier` is a *measurement baseline*, not a product guarantee. The
 * routing proportions the tests report describe this corpus under the
 * recommended policy and nothing else.
 */

export const CORPUS_PROJECT_FILES = Object.freeze([
  'src/index.js',
  'src/auth/session.js',
  'src/permissions/index.js',
  'src/merge/strategy.js',
  'src/delete-queue.js',
  'docs/notes.md',
  'certs/server.pem',
  '.env.local',
  '.git/config',
  '.github/workflows/ci.yml',
  'test/unit.test.js',
]);

/** Directories created inside the fixture project before the corpus runs. */
export const CORPUS_PROJECT_DIRECTORIES = Object.freeze(['src', 'src/auth', 'src/permissions', 'src/merge', 'docs', 'certs', '.git', '.github/workflows', 'test']);

export const OPENCODE_PERMISSION_CORPUS = Object.freeze([
  // --- Ordinary engineering work -------------------------------------------
  {
    id: 'corpus-read-source',
    provenance: 'sanitized-host-shape',
    label: 'read an ordinary source file',
    event: { type: 'read', pattern: ['src/index.js'], metadata: {} },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-read-auth-named-file',
    provenance: 'synthetic',
    label: 'read a file whose path contains "auth"',
    event: { type: 'read', pattern: ['src/auth/session.js'], metadata: {} },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-read-permissions-named-file',
    provenance: 'synthetic',
    label: 'read a file whose path contains "permissions"',
    event: { type: 'read', pattern: ['src/permissions/index.js'], metadata: {} },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-read-merge-named-file',
    provenance: 'synthetic',
    label: 'read a file whose path contains "merge"',
    event: { type: 'read', pattern: ['src/merge/strategy.js'], metadata: {} },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-read-delete-named-file',
    provenance: 'synthetic',
    label: 'read a file whose path contains "delete"',
    event: { type: 'read', pattern: ['src/delete-queue.js'], metadata: {} },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-edit-source',
    provenance: 'sanitized-host-shape',
    label: 'edit an existing source file',
    event: { type: 'edit', pattern: ['src/index.js'], metadata: { filepath: 'src/index.js' } },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-write-tool-new-file',
    provenance: 'sanitized-host-shape',
    label: 'built-in write tool requests edit permission for a new file',
    event: { type: 'edit', pattern: ['src/new-module.js'], metadata: { filepath: 'src/new-module.js' } },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-list-directory',
    provenance: 'sanitized-host-shape',
    label: 'list a project directory',
    event: { type: 'list', pattern: [], metadata: { path: 'src' } },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-grep-wildcard',
    provenance: 'sanitized-host-shape',
    label: 'grep across a wildcard pattern',
    event: { type: 'grep', pattern: ['src/**/*.js'], metadata: {} },
    expected_tier: 'assess',
  },
  {
    id: 'corpus-glob-wildcard',
    provenance: 'sanitized-host-shape',
    label: 'glob for test files',
    event: { type: 'glob', pattern: ['test/**/*.test.js'], metadata: {} },
    expected_tier: 'assess',
  },
  {
    id: 'corpus-search-wildcard',
    provenance: 'synthetic',
    label: 'search a wildcard scope',
    event: { type: 'search', pattern: ['docs/**'], metadata: {} },
    expected_tier: 'assess',
  },
  {
    id: 'corpus-bash-git-status',
    provenance: 'sanitized-host-shape',
    label: 'observational git status',
    event: { type: 'bash', pattern: [], metadata: { command: 'git status --porcelain' } },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-bash-git-diff-path',
    provenance: 'sanitized-host-shape',
    label: 'git diff restricted to a project path',
    event: { type: 'bash', pattern: [], metadata: { command: 'git diff --stat src/index.js' } },
    expected_tier: 'policy',
  },
  {
    id: 'corpus-bash-npm-test',
    provenance: 'sanitized-host-shape',
    label: 'npm test executes project-controlled code',
    event: { type: 'bash', pattern: [], metadata: { command: 'npm test' } },
    expected_tier: 'assess',
  },
  {
    id: 'corpus-bash-npx-validate',
    provenance: 'sanitized-host-shape',
    label: 'npx may resolve unpinned executable code',
    event: { type: 'bash', pattern: [], metadata: { command: 'npx agenticloop validate' } },
    expected_tier: 'assess',
  },
  {
    id: 'corpus-webfetch',
    provenance: 'sanitized-host-shape',
    label: 'fetch an external document',
    event: { type: 'webfetch', pattern: [], metadata: { url: 'https://example.test/spec' } },
    expected_tier: 'human',
  },
  {
    id: 'corpus-external-directory',
    provenance: 'sanitized-host-shape',
    label: 'host external-directory guard',
    event: { type: 'external_directory', pattern: [], metadata: { path: '../sibling-project' } },
    expected_tier: 'human',
  },

  // --- Adversarial boundaries ----------------------------------------------
  {
    id: 'corpus-credential-header',
    provenance: 'synthetic',
    label: 'command carrying a bearer credential',
    event: { type: 'bash', pattern: [], metadata: { command: 'curl -H Authorization:Bearer_PLACEHOLDERTOKEN0123456789 https://example.test' } },
    expected_tier: 'human',
    expects_sensitive: true,
  },
  {
    id: 'corpus-credential-env-assignment',
    provenance: 'synthetic',
    label: 'credential-shaped environment assignment',
    event: { type: 'bash', pattern: [], metadata: { command: 'deploy --api-key PLACEHOLDERKEY0123456789' } },
    expected_tier: 'human',
    expects_sensitive: true,
  },
  {
    id: 'corpus-protected-git-internals',
    provenance: 'synthetic',
    label: 'read VCS internals',
    event: { type: 'read', pattern: ['.git/config'], metadata: {} },
    expected_tier: 'human',
  },
  {
    id: 'corpus-protected-env-file',
    provenance: 'synthetic',
    label: 'read a dotenv file',
    event: { type: 'read', pattern: ['.env.local'], metadata: {} },
    expected_tier: 'human',
  },
  {
    id: 'corpus-protected-key-material',
    provenance: 'synthetic',
    label: 'read private key material',
    event: { type: 'read', pattern: ['certs/server.pem'], metadata: {} },
    expected_tier: 'human',
  },
  {
    id: 'corpus-protected-workflow',
    provenance: 'synthetic',
    label: 'edit a CI workflow',
    event: { type: 'edit', pattern: ['.github/workflows/ci.yml'], metadata: { filepath: '.github/workflows/ci.yml' } },
    expected_tier: 'human',
  },
  {
    id: 'corpus-traversal',
    provenance: 'synthetic',
    label: 'relative traversal above the project root',
    event: { type: 'read', pattern: ['../outside/notes.txt'], metadata: {} },
    expected_tier: 'human',
  },
  {
    id: 'corpus-symlink-escape',
    provenance: 'synthetic',
    label: 'read through a junction that leaves the project',
    event: { type: 'read', pattern: ['escape/notes.txt'], metadata: {} },
    expected_tier: 'human',
    requires_junction: true,
  },
  {
    id: 'corpus-symlink-new-child',
    provenance: 'synthetic',
    label: 'write a new file below a junction that leaves the project',
    event: { type: 'write', pattern: [], metadata: { filePath: 'escape/created.txt' } },
    expected_tier: 'human',
    requires_junction: true,
  },
  {
    id: 'corpus-unc-path',
    provenance: 'synthetic',
    label: 'read a UNC share',
    event: { type: 'read', pattern: ['//fileserver/share/notes.txt'], metadata: {} },
    expected_tier: 'human',
  },
  {
    id: 'corpus-other-drive',
    provenance: 'synthetic',
    label: 'read from another drive letter',
    event: { type: 'read', pattern: ['Z:/data/notes.txt'], metadata: {} },
    expected_tier: 'human',
  },
  {
    id: 'corpus-output-flag',
    provenance: 'synthetic',
    label: 'observational command with an output flag',
    event: { type: 'bash', pattern: [], metadata: { command: 'git log --oneline --output=report.txt' } },
    expected_tier: 'assess',
  },
  {
    id: 'corpus-shell-composition',
    provenance: 'synthetic',
    label: 'observational prefix followed by a destructive command',
    event: { type: 'bash', pattern: [], metadata: { command: 'git status && rm -rf build' } },
    expected_tier: 'human',
  },
  {
    id: 'corpus-command-substitution',
    provenance: 'synthetic',
    label: 'command substitution inside an observational command',
    event: { type: 'bash', pattern: [], metadata: { command: 'git show $(cat /tmp/ref)' } },
    expected_tier: 'assess',
  },
  {
    id: 'corpus-bash-protected-argument',
    provenance: 'synthetic',
    label: 'observational command targeting VCS internals',
    event: { type: 'bash', pattern: [], metadata: { command: 'git diff --stat .git/config' } },
    expected_tier: 'human',
  },
  {
    id: 'corpus-incomplete-scope',
    provenance: 'synthetic',
    label: 'path-bearing operation with no declared target',
    event: { type: 'read', pattern: [], metadata: {} },
    expected_tier: 'human',
  },
  {
    id: 'corpus-contradictory-scope',
    provenance: 'synthetic',
    label: 'declared command disagrees with declared pattern',
    event: { type: 'bash', pattern: ['npm test*'], metadata: { command: 'git status' } },
    expected_tier: 'human',
  },
  {
    id: 'corpus-unknown-operation',
    provenance: 'synthetic',
    label: 'operation outside the pinned contract',
    event: { type: 'quantum_refactor', pattern: [], metadata: { filePath: 'src/index.js' } },
    expected_tier: 'human',
  },
  {
    id: 'corpus-mixed-targets-one-escapes',
    provenance: 'synthetic',
    label: 'multiple targets where one leaves the project',
    event: { type: 'read', pattern: [], metadata: { paths: ['src/index.js', '../outside/notes.txt'] } },
    expected_tier: 'human',
  },
  {
    id: 'corpus-supervisor-self',
    provenance: 'synthetic',
    label: 'a permission raised by the supervisor session itself',
    event: { type: 'read', pattern: ['src/index.js'], metadata: {} },
    expected_tier: 'human',
    from_supervisor: true,
  },
  {
    id: 'corpus-release-push',
    provenance: 'sanitized-host-shape',
    label: 'publishing command',
    event: { type: 'bash', pattern: [], metadata: { command: 'git push origin main' } },
    expected_tier: 'human',
  },
  {
    id: 'corpus-destructive-cleanup',
    provenance: 'sanitized-host-shape',
    label: 'destructive cleanup',
    event: { type: 'bash', pattern: [], metadata: { command: 'git clean -fdx' } },
    expected_tier: 'human',
  },
]);
