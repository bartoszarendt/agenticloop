/**
 * Deterministic permission routing for attached OpenCode supervision.
 *
 * This module is intentionally free of kernel state, host handles, and I/O other
 * than the injected filesystem probes it needs to prove repository containment.
 * Everything here is a pure decision over an exact permission scope, so the
 * routing boundary can be tested table-driven and cannot drift with unrelated
 * kernel changes.
 *
 * Three tiers, in strictly decreasing trust:
 *
 * - `policy`  mechanically proven low-impact scope. Answered with an exact host
 *             `once` reply, no model call, no assessment or wakeup charge.
 * - `assess`  complete scope that is neither mechanically safe nor human-only.
 *             The supervisor sees a bounded transient scope and may approve
 *             `once`, reject, or escalate.
 * - `human`   sensitive, protected, incomplete, contradictory, unknown,
 *             unauthorized, high-impact, or supervisor-self scope. Left pending
 *             for the operator; the model is never woken.
 *
 * Nothing in here may make a request *safer*: a host-supplied category can only
 * narrow authority, and every unresolved question routes down, never up.
 */

import { existsSync, realpathSync } from 'node:fs';

/**
 * Every operation the pinned OpenCode permission contract can name. An
 * operation outside this list keeps the identity `unknown` and is human-only:
 * the public projection and the router agree on one vocabulary, so a configured
 * operation can never normalize into a different public identity.
 */
export const CANONICAL_PERMISSION_OPERATIONS = Object.freeze([
  'read',
  'edit',
  'write',
  'grep',
  'glob',
  'list',
  'search',
  'webfetch',
  'bash',
  'task',
  'question',
  'external_directory',
]);

const CANONICAL_OPERATION_SET = new Set(CANONICAL_PERMISSION_OPERATIONS);

/** Operations whose scope is expressed as filesystem paths or path patterns. */
const PATH_BEARING_OPERATIONS = new Set(['read', 'edit', 'write', 'grep', 'glob', 'list', 'search']);

/** Operations that write when they are permitted. */
const MUTATING_OPERATIONS = new Set(['edit', 'write']);

/**
 * The only operations an operator may place in `permissions.policy.auto_operations`.
 *
 * `bash` is deliberately excluded: a command is proven by a structured rule, not
 * by naming the operation. `webfetch`, `task`, `question`, and
 * `external_directory` are excluded because their consequence is external,
 * unbounded, or outside the project by construction.
 */
export const POLICY_ELIGIBLE_AUTO_OPERATIONS = Object.freeze(['read', 'edit', 'write', 'grep', 'glob', 'list', 'search']);

/**
 * Path prefixes that are protected regardless of configuration. Matching is
 * path-specific and segment-exact: `src/auth/session.js` and
 * `src/permissions/index.js` are ordinary source files, while `.git/config` is
 * not.
 */
export const DEFAULT_PROTECTED_PATHS = Object.freeze([
  // VCS internals and hooks.
  '.git',
  '.hg',
  '.svn',
  '.githooks',
  '.husky',
  '.github/workflows',
  // Agentic Loop authorization and runtime state.
  '.agenticloop/state',
  '.agenticloop/logs',
  'agenticloop.json',
  // Host and agent permission configuration.
  '.opencode',
  'opencode.json',
  'opencode.jsonc',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.vscode/settings.json',
  // Credential and key material directories.
  '.ssh',
  '.gnupg',
  '.aws',
  '.docker/config.json',
]);

/**
 * Protected basenames, matched exactly on the final path segment. These catch
 * credential-like files anywhere in the tree without the substring guesswork
 * that made ordinary source paths look high impact.
 */
const PROTECTED_BASENAMES = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.netrc',
  '_netrc',
  '.pgpass',
  '.htpasswd',
  'credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const PROTECTED_BASENAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)\.pub$/i,
  /\.(?:pem|key|pfx|p12|jks|keystore|asc|gpg)$/i,
];

/**
 * Flags that can turn a nominally observational command into a write. Rejected
 * unconditionally, in configured rules and in the parsed argument vector, so a
 * rule author cannot accidentally allow one.
 */
const OUTPUT_FLAG_PATTERN = /^--?(?:o|out|output|outfile|ofile|w|write|writeout)(?:-(?:file|out|to))?$/i;
const FILE_FLAG_PATTERN = /(?:^|-)(?:file|files|outfile|logfile|tofile)(?:-|$)/i;

/**
 * Executables that are never mechanically safe, whatever their arguments: they
 * run project-controlled code, resolve or download code, or open a network or
 * shell escape. Rejected at configuration time so a rule can never authorize
 * them.
 */
const FORBIDDEN_AUTO_EXECUTABLES = new Set([
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno', 'node', 'nodejs',
  'python', 'python3', 'py', 'ruby', 'perl', 'php', 'java', 'dotnet', 'cargo', 'go',
  'sh', 'bash', 'zsh', 'fish', 'dash', 'cmd', 'command', 'powershell', 'pwsh', 'wsl',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet',
  'make', 'cmake', 'gradle', 'mvn', 'docker', 'kubectl', 'terraform', 'gh', 'git-lfs',
  'rm', 'del', 'mv', 'move', 'cp', 'copy', 'chmod', 'chown', 'icacls', 'takeown',
  'eval', 'exec', 'env', 'set', 'export', 'source',
]);

/** Bounded canonical risk vocabulary. Host categories never enter durable state. */
export const CANONICAL_RISK_CATEGORIES = Object.freeze([
  'destructive_cleanup',
  'merge',
  'release',
  'publication',
  'credentials',
  'authentication',
  'external_communication',
  'authorization_expansion',
  'locked_decision',
  'backend_exception',
]);

/**
 * Semantic risk rules for the three-tier router.
 *
 * Unlike the legacy classifier these never see path text. Paths are judged by
 * exact containment and the protected set instead, so `src/auth/session.js` no
 * longer reads as an authentication operation.
 */
const SEMANTIC_RISK_RULES = Object.freeze([
  ['destructive_cleanup', /(?:\brm\s+-[a-z]*[rf]|remove-item|\bgit\s+clean\b|\bgit\s+reset\s+--hard\b|\btruncate\b|\bdrop\s+(?:table|database)\b|\bdel\s+\/[a-z])/i],
  ['merge', /(?:\bgit\s+merge\b|\bgit\s+rebase\b|\bmerge\s+pull\s+request\b|\bgh\s+pr\s+merge\b)/i],
  ['release', /(?:\bgit\s+push\b|\bgh\s+release\b|\bdeploy\b|\brelease\b)/i],
  ['publication', /(?:\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\bpublish\b)/i],
  ['credentials', /(?:\bcredential|\bsecret\b|\btoken\b|\bpassword\b|\bkeychain\b|(?:^|[\s"'`(])(?:set-)?cookie\s*[:=]|(?:-H|--header)\s)/i],
  ['authentication', /(?:\bauth\s|\bauthenticate\b|\blogin\b|\blogout\b|\boauth\b|\bgh\s+auth\b|\bnpm\s+login\b)/i],
  ['external_communication', /(?:\bcurl\b|\bwget\b|\bmailto:|\bslack\b|\bwebhook\b|\bsmtp\b|\bsend(?:mail|-mailmessage)\b)/i],
  ['authorization_expansion', /(?:\bchmod\b|\bchown\b|\bicacls\b|\btakeown\b|\bsetfacl\b|\bgrant\s+(?:all|role|privileges)\b)/i],
  ['locked_decision', /locked[_ -]?decision/i],
  ['backend_exception', /backend[_ -]?exception/i],
]);

/** Any external URL scheme in a webfetch/external target is external communication. */
const EXTERNAL_TARGET_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

function normalizedText(value) {
  return String(value ?? '').trim();
}

/**
 * Canonical public identity for a host operation name.
 *
 * The router and the public projection share this function, so every configured
 * operation keeps one identity and an operation the pinned contract does not
 * define stays `unknown` rather than being silently folded into a known name.
 */
export function normalizePermissionOperation(value) {
  const operation = normalizedText(value).toLowerCase();
  if (CANONICAL_OPERATION_SET.has(operation)) return operation;
  // Accept only the exact aliases the pinned OpenCode contract emits. Anything
  // else keeps the `unknown` identity and is human-only.
  const aliases = {
    ls: 'list',
    readfile: 'read',
    writefile: 'write',
    web_fetch: 'webfetch',
    'web-fetch': 'webfetch',
    external_dir: 'external_directory',
    'external-directory': 'external_directory',
  };
  return aliases[operation] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Split an absolute path into a root and remainder without depending on the
 * running platform. Windows drive roots, UNC shares, and POSIX roots are all
 * recognized, so a Windows-shaped scope is classified identically on any host
 * that runs the tests.
 *
 * Drive-relative paths (`C:src`) are deliberately *not* absolute: their meaning
 * depends on a per-drive current directory this process cannot observe, so they
 * are reported as unresolvable rather than guessed.
 */
export function parseAbsolutePath(value) {
  const text = String(value ?? '').replace(/\\/g, '/');
  if (!text) return null;
  const unc = /^\/\/([^/]+)\/([^/]+)(\/.*)?$/.exec(text);
  if (unc) return { root: `//${unc[1]}/${unc[2]}/`, rest: unc[3] ?? '' };
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(text);
  if (drive) return { root: `${drive[1]}/`, rest: drive[2] ?? '' };
  if (text.startsWith('/')) return { root: '/', rest: text };
  return null;
}

/** True for a drive-relative path such as `C:src`, whose base is unobservable. */
function isDriveRelative(value) {
  return /^[A-Za-z]:(?![\\/])/.test(String(value ?? '').replace(/\\/g, '/'));
}

function normalizeSegments(rest) {
  const segments = [];
  for (const segment of String(rest ?? '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      // Traversal above the root is refused rather than clamped: a scope that
      // tries to leave the tree is never quietly rewritten into a valid one.
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function joinAbsolute(root, segments) {
  return `${root}${segments.join('/')}`;
}

function comparableKey(value, caseInsensitive) {
  let text = String(value ?? '').replace(/\\/g, '/');
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1);
  return caseInsensitive ? text.toLowerCase() : text;
}

function isInside(rootKey, candidateKey) {
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}/`);
}

/**
 * Resolve one path lexically against an absolute base. Returns null when the
 * scope cannot be resolved exactly: an unusable base, a drive-relative target,
 * or traversal above a root.
 */
export function resolveLexicalPath(base, target) {
  const text = String(target ?? '').trim();
  if (!text || isDriveRelative(text)) return null;
  const absolute = parseAbsolutePath(text);
  if (absolute) {
    const segments = normalizeSegments(absolute.rest);
    return segments ? joinAbsolute(absolute.root, segments) : null;
  }
  const parsedBase = parseAbsolutePath(base);
  if (!parsedBase) return null;
  const baseSegments = normalizeSegments(parsedBase.rest);
  if (!baseSegments) return null;
  const segments = normalizeSegments(`${baseSegments.join('/')}/${text.replace(/\\/g, '/')}`);
  return segments ? joinAbsolute(parsedBase.root, segments) : null;
}

const MAXIMUM_ANCESTOR_WALK = 64;

/**
 * Resolve real identity for a path that may not exist yet.
 *
 * An existing target is resolved directly, so a symlink or junction that leaves
 * the project is caught. A nonexistent write target has its nearest existing
 * ancestor resolved first and the remaining lexical segments appended, so a new
 * file *below* a junction cannot be created outside the project through a path
 * that merely looks contained.
 */
export function resolveRealPath(absolutePath, fileSystem) {
  let candidate = absolutePath;
  const trailing = [];
  for (let step = 0; step < MAXIMUM_ANCESTOR_WALK; step += 1) {
    let exists;
    try {
      exists = fileSystem.existsSync(candidate);
    } catch {
      return null;
    }
    if (exists) {
      let real;
      try {
        real = String(fileSystem.realpathSync(candidate));
      } catch {
        return null;
      }
      const parsedReal = parseAbsolutePath(real);
      if (!parsedReal) return null;
      const realSegments = normalizeSegments(parsedReal.rest);
      if (!realSegments) return null;
      return { path: joinAbsolute(parsedReal.root, [...realSegments, ...trailing]), existed: trailing.length === 0 };
    }
    const parsed = parseAbsolutePath(candidate);
    if (!parsed) return null;
    const segments = normalizeSegments(parsed.rest);
    if (!segments || segments.length === 0) return null;
    trailing.unshift(segments.pop());
    candidate = joinAbsolute(parsed.root, segments);
  }
  return null;
}

function relativeSegments(rootKey, candidateKey) {
  if (candidateKey === rootKey) return [];
  return candidateKey.slice(rootKey.length + 1).split('/').filter(Boolean);
}

function isProtectedRelative(segments, protectedKeys) {
  if (!segments.length) return true;
  const relativeKey = segments.join('/');
  for (const key of protectedKeys) {
    if (relativeKey === key || relativeKey.startsWith(`${key}/`)) return true;
  }
  const basename = segments.at(-1);
  if (PROTECTED_BASENAMES.has(basename.toLowerCase())) return true;
  return PROTECTED_BASENAME_PATTERNS.some(pattern => pattern.test(basename));
}

const WILDCARD_PATTERN = /[*?[\]{}]/;

/**
 * Prove one effective target is inside the exact project root and outside the
 * protected set.
 *
 * @returns {{complete: boolean, inside_project: boolean, protected: boolean, reason: string|null, wildcard: boolean}}
 */
export function evaluatePathContainment(value, {
  projectRoot,
  workingDirectory,
  protectedKeys,
  fileSystem = { existsSync, realpathSync },
  caseInsensitive,
} = {}) {
  const refused = (reason, extra = {}) => ({ complete: false, inside_project: false, protected: false, wildcard: false, reason, ...extra });
  const text = normalizedText(value);
  if (!text) return refused('missing_path');

  const wildcard = WILDCARD_PATTERN.test(text);
  // A wildcard scope is reduced to its literal prefix only to prove the search
  // root is contained. It never becomes policy-eligible: the prefix says nothing
  // about what the expansion would match inside that root.
  const literal = wildcard ? text.slice(0, text.search(WILDCARD_PATTERN)) : text;
  const reducible = wildcard ? literal.replace(/[^\\/]*$/, '') : literal;
  if (wildcard && /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(text)) return refused('wildcard_traversal', { wildcard: true });

  const rootLexical = resolveLexicalPath(projectRoot, projectRoot);
  if (!rootLexical) return refused('unresolvable_project_root');
  const base = workingDirectory ? resolveLexicalPath(projectRoot, workingDirectory) : rootLexical;
  if (!base) return refused('unresolvable_working_directory');
  const baseKey = comparableKey(base, caseInsensitive);
  const rootKey = comparableKey(rootLexical, caseInsensitive);
  if (!isInside(rootKey, baseKey)) return refused('working_directory_outside_project');

  const lexical = resolveLexicalPath(base, reducible === '' ? '.' : reducible);
  if (!lexical) return refused('unresolvable_path', { wildcard });
  const lexicalKey = comparableKey(lexical, caseInsensitive);
  if (!isInside(rootKey, lexicalKey)) return refused('outside_project', { wildcard });
  const lexicalRelative = relativeSegments(rootKey, lexicalKey);
  if (isProtectedRelative(lexicalRelative, protectedKeys)) {
    return { complete: true, inside_project: true, protected: true, wildcard, reason: 'protected_path' };
  }

  const realRoot = resolveRealPath(rootLexical, fileSystem);
  if (!realRoot) return refused('unresolvable_project_root', { wildcard });
  const realTarget = resolveRealPath(lexical, fileSystem);
  if (!realTarget) return refused('unresolvable_real_path', { wildcard });
  const realRootKey = comparableKey(realRoot.path, caseInsensitive);
  const realTargetKey = comparableKey(realTarget.path, caseInsensitive);
  if (!isInside(realRootKey, realTargetKey)) return refused('resolved_outside_project', { wildcard });
  const realRelative = relativeSegments(realRootKey, realTargetKey);
  if (isProtectedRelative(realRelative, protectedKeys)) {
    return { complete: true, inside_project: true, protected: true, wildcard, reason: 'protected_path' };
  }
  return { complete: true, inside_project: true, protected: false, wildcard, reason: null };
}

/**
 * Prove every effective target of a path-bearing request. One escaping or
 * unresolvable target makes the whole request unsafe; there is no partial pass.
 */
export function evaluatePathScope(values, options) {
  const entries = Array.isArray(values) ? values.filter(entry => normalizedText(entry)) : [];
  if (!entries.length) {
    return { checked: true, complete: false, inside_project: false, protected: false, wildcard: false, reason: 'missing_path', count: 0 };
  }
  let wildcard = false;
  for (const entry of entries) {
    const result = evaluatePathContainment(entry, options);
    wildcard = wildcard || result.wildcard === true;
    if (!result.complete) return { checked: true, complete: false, inside_project: false, protected: false, wildcard, reason: result.reason, count: entries.length };
    if (result.protected) return { checked: true, complete: true, inside_project: true, protected: true, wildcard, reason: 'protected_path', count: entries.length };
  }
  return { checked: true, complete: true, inside_project: true, protected: false, wildcard, reason: null, count: entries.length };
}

// ---------------------------------------------------------------------------
// Structured command validation
// ---------------------------------------------------------------------------

/**
 * Characters and sequences that give a command more reach than its executable
 * and arguments. Their presence ends structured validation immediately: this
 * parser proves a narrow grammar, it does not emulate a shell.
 */
const SHELL_COMPOSITION = /(?:&&|\|\||[;|&`<>]|\$\(|\$\{|\r|\n|\\)/;

const SAFE_TOKEN = /^[A-Za-z0-9._@:+,=/-]+$/;

/**
 * Parse a command into an executable and argument vector, or refuse.
 *
 * Anything outside the grammar -- composition, substitution, redirection,
 * quoting, environment mutation, or an unrecognized character -- is refused
 * rather than interpreted. A refusal is not a verdict about the command; it
 * only means this parser cannot prove what it does, so the request routes to
 * `assess` or `human`.
 */
export function parseStructuredCommand(command) {
  const text = normalizedText(command);
  if (!text) return { ok: false, reason: 'missing_command' };
  if (text.length > 300) return { ok: false, reason: 'command_too_long' };
  if (SHELL_COMPOSITION.test(text)) return { ok: false, reason: 'shell_composition' };
  if (/['"]/.test(text)) return { ok: false, reason: 'quoting_not_supported' };
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ok: false, reason: 'missing_command' };
  if (tokens.some(token => !SAFE_TOKEN.test(token))) return { ok: false, reason: 'unrecognized_token' };
  // `NAME=value cmd` mutates the environment of the invocation.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return { ok: false, reason: 'environment_mutation' };
  const executable = tokens[0];
  if (/[/]/.test(executable)) return { ok: false, reason: 'executable_path_not_supported' };
  return { ok: true, executable: executable.toLowerCase(), argv: tokens.slice(1) };
}

function isOutputFlag(flag) {
  const name = String(flag).replace(/=.*$/, '');
  const bare = name.replace(/^--?/, '');
  return OUTPUT_FLAG_PATTERN.test(name) || FILE_FLAG_PATTERN.test(bare);
}

/**
 * Validate one configured bash rule shape. Free-form command prefixes are not
 * accepted: a rule must name an executable, its exact subcommand, and the exact
 * flags it may carry.
 */
export function validateBashRule(rule, label) {
  const errors = [];
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return [`${label} must be a structured object with executable, subcommand, allowed_flags, and allow_paths`];
  }
  const allowedKeys = new Set(['executable', 'subcommand', 'allowed_flags', 'allow_paths']);
  for (const key of Object.keys(rule)) {
    if (!allowedKeys.has(key)) errors.push(`${label}.${key} is not supported`);
  }
  const executable = normalizedText(rule.executable).toLowerCase();
  if (!/^[a-z][a-z0-9_.-]*$/.test(executable)) errors.push(`${label}.executable must be a bare executable name`);
  else if (FORBIDDEN_AUTO_EXECUTABLES.has(executable)) {
    errors.push(`${label}.executable '${executable}' runs project-controlled, downloaded, or shell-escaping code and can never be automatically approved`);
  }
  if (rule.subcommand !== null && rule.subcommand !== undefined && !/^[a-z][a-z0-9_.-]*$/.test(normalizedText(rule.subcommand).toLowerCase())) {
    errors.push(`${label}.subcommand must be a bare subcommand name or null`);
  }
  if (!Array.isArray(rule.allowed_flags)) errors.push(`${label}.allowed_flags must be an array`);
  else {
    for (const [index, flag] of rule.allowed_flags.entries()) {
      if (typeof flag !== 'string' || !/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(flag)) {
        errors.push(`${label}.allowed_flags[${index}] must be an exact flag such as --porcelain`);
        continue;
      }
      if (isOutputFlag(flag)) errors.push(`${label}.allowed_flags[${index}] '${flag}' can redirect output to a file and is never automatically approvable`);
    }
  }
  if (rule.allow_paths !== undefined && typeof rule.allow_paths !== 'boolean') errors.push(`${label}.allow_paths must be a boolean`);
  return errors;
}

/**
 * Match a parsed command against the configured structured rules and prove any
 * positional path argument is project-contained.
 *
 * @returns {{ok: boolean, reason: string|null, containment: object|null}}
 */
export function evaluateStructuredCommand(command, rules, containmentOptions) {
  const parsed = parseStructuredCommand(command);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, containment: null };
  const candidates = (Array.isArray(rules) ? rules : []).filter(rule => normalizedText(rule?.executable).toLowerCase() === parsed.executable);
  if (!candidates.length) return { ok: false, reason: 'executable_not_configured', containment: null };
  if (FORBIDDEN_AUTO_EXECUTABLES.has(parsed.executable)) return { ok: false, reason: 'forbidden_executable', containment: null };

  // Several rules can share an executable, so the reported refusal is the most
  // specific one any candidate produced rather than whichever rule happened to
  // be checked last. A proven boundary violation outranks an argument problem,
  // which outranks "this is not my subcommand".
  let refusalRank = -1;
  let refusalReason = 'no_matching_rule';
  const refuse = reason => {
    const rank = REFUSAL_RANK[reason] ?? 0;
    if (rank <= refusalRank) return;
    refusalRank = rank;
    refusalReason = reason;
  };
  for (const rule of candidates) {
    const subcommand = rule.subcommand === null || rule.subcommand === undefined ? null : normalizedText(rule.subcommand).toLowerCase();
    let args = parsed.argv;
    if (subcommand) {
      if (args[0]?.toLowerCase() !== subcommand) { refuse('subcommand_not_configured'); continue; }
      args = args.slice(1);
    }
    const allowedFlags = new Set((rule.allowed_flags ?? []).map(flag => String(flag)));
    const positional = [];
    let refusal = null;
    for (const argument of args) {
      if (argument === '--') { refusal = 'unrecognized_argument'; break; }
      if (argument.startsWith('-')) {
        const name = argument.replace(/=.*$/, '');
        if (isOutputFlag(argument)) { refusal = 'output_flag'; break; }
        if (!allowedFlags.has(name)) { refusal = 'flag_not_configured'; break; }
        // A configured flag may not smuggle a value that names a path.
        if (argument.includes('=') && /[\\/]/.test(argument.slice(argument.indexOf('=') + 1))) { refusal = 'flag_value_names_a_path'; break; }
        continue;
      }
      positional.push(argument);
    }
    if (refusal) { refuse(refusal); continue; }
    if (positional.length && rule.allow_paths !== true) { refuse('positional_arguments_not_allowed'); continue; }
    if (!positional.length) return { ok: true, reason: null, containment: { checked: false, complete: true, inside_project: true, protected: false, wildcard: false, reason: null, count: 0 } };
    const containment = evaluatePathScope(positional, containmentOptions);
    if (!containment.complete || !containment.inside_project || containment.protected || containment.wildcard) {
      refuse(containment.protected ? 'protected_path' : containment.reason ?? 'path_not_contained');
      continue;
    }
    return { ok: true, reason: null, containment };
  }
  return { ok: false, reason: refusalReason, containment: null };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Detect canonical risk categories from the request's *semantic* surface.
 *
 * Path text is deliberately absent: containment and the protected set judge
 * paths. That removes the false positives the legacy classifier produced for
 * ordinary source files whose names contain `auth`, `permission`, `merge`, or
 * `delete`, without weakening any real boundary.
 */
export function detectRiskCategories({ category, command, maximumEffect, targets = [], patterns = [] } = {}) {
  const surface = [category, command, maximumEffect, ...targets, ...patterns].filter(Boolean).join(' | ');
  const detected = new Set();
  for (const [name, matcher] of SEMANTIC_RISK_RULES) {
    matcher.lastIndex = 0;
    if (matcher.test(surface)) detected.add(name);
  }
  if (targets.some(target => EXTERNAL_TARGET_PATTERN.test(normalizedText(target)))) detected.add('external_communication');
  return [...detected];
}

function protectedKeysFrom(policy, caseInsensitive) {
  const configured = Array.isArray(policy?.protected_paths) ? policy.protected_paths : [];
  return [...DEFAULT_PROTECTED_PATHS, ...configured]
    .map(entry => comparableKey(String(entry ?? '').replace(/^[\\/]+/, ''), caseInsensitive))
    .filter(Boolean);
}

/**
 * Collect the effective path scope for a path-bearing operation.
 *
 * The pinned OpenCode host expresses read scope only through `pattern`, while
 * edit/write requests also carry a metadata path. A non-wildcard pattern is an
 * exact target and can therefore be mechanically proven. Wildcard patterns are
 * still accepted as complete scope, but containment marks them as wildcard and
 * they can never reach the policy tier.
 */
function effectivePathScope(operation, { paths, patterns }) {
  if (paths.length) return { values: paths, source: 'paths' };
  if (patterns.length) return { values: patterns, source: 'patterns' };
  return { values: [], source: 'none' };
}

const HUMAN = 'human';
const ASSESS = 'assess';
const POLICY = 'policy';

/**
 * Structured-command refusals that describe a *proven* boundary violation
 * rather than an unprovable command. These route to the operator, never to the
 * supervisor.
 */
const PATH_REFUSAL_REASONS = new Set(['protected_path', 'outside_project', 'resolved_outside_project', 'wildcard_traversal']);

/**
 * How specific a structured-command refusal is. Higher wins when several rules
 * share an executable, so "this command tried to write through --output" is
 * never masked by a sibling rule's "that is not my subcommand".
 */
const REFUSAL_RANK = Object.freeze({
  no_matching_rule: 0,
  executable_not_configured: 1,
  subcommand_not_configured: 2,
  positional_arguments_not_allowed: 3,
  flag_not_configured: 4,
  unrecognized_argument: 4,
  flag_value_names_a_path: 5,
  path_not_contained: 5,
  unresolvable_path: 5,
  missing_path: 5,
  output_flag: 6,
  wildcard_traversal: 7,
  outside_project: 7,
  resolved_outside_project: 7,
  protected_path: 8,
});

function result(tier, { categories = [], consequence, policyVersion, scopeComplete, containment, decision = null }) {
  return {
    tier,
    authority: tier === POLICY ? 'policy-eligible' : tier === ASSESS ? 'supervisor-eligible' : 'human-only',
    canonical_categories: [...new Set(categories)].filter(name => CANONICAL_RISK_CATEGORIES.includes(name) || name.startsWith('unclassified_') || ROUTING_MARKERS.has(name)),
    consequence,
    policy_version: policyVersion,
    scope_complete: scopeComplete === true,
    containment: containment ?? { checked: false, inside_project: false, protected: false },
    policy_decision: tier === POLICY ? decision : null,
  };
}

/** Bounded non-risk markers the router may attach to explain its routing. */
const ROUTING_MARKERS = new Set([
  'host_human_only',
  'supervisor_self_request',
  'sensitive_material_redacted',
  'missing_authorization',
  'unclassified_operation',
  'unclassified_bash',
  'incomplete_scope',
  'protected_path',
  'outside_project',
  'wildcard_scope',
  'transient_scope_disabled',
  'configured_low_impact',
  'ambiguous_consequence',
]);

/**
 * Route one exact permission request.
 *
 * The evaluation order is fixed and fail-closed: identity and authorization
 * first, then non-negotiable categories, then exact scope, and only then the
 * narrow proofs that can produce a `policy` verdict.
 */
export function evaluatePermissionRouting({
  operation,
  category = '',
  command = '',
  maximumEffect = '',
  patterns = [],
  paths = [],
  targets = [],
  humanOnlyCategories = new Set(CANONICAL_RISK_CATEGORIES),
  hostHumanOnly = false,
  sensitive = false,
  supervisorSelf = false,
  authorized = true,
  policy = {},
  projectRoot,
  workingDirectory = null,
  transientScopeEnabled = false,
  fileSystem = { existsSync, realpathSync },
  caseInsensitive = process.platform === 'win32',
} = {}) {
  const policyVersion = Number.isInteger(policy?.version) ? policy.version : 1;
  const normalizedOperation = normalizePermissionOperation(operation);
  const base = { policyVersion, scopeComplete: false, containment: { checked: false, inside_project: false, protected: false } };

  if (supervisorSelf) return result(HUMAN, { ...base, categories: ['supervisor_self_request'], consequence: 'supervisor self-approval is prohibited' });
  if (sensitive) return result(HUMAN, { ...base, categories: ['sensitive_material_redacted', 'credentials'], consequence: 'request carries credential-like material; its scope cannot be shown or trusted for autonomous approval' });
  if (hostHumanOnly) return result(HUMAN, { ...base, categories: ['host_human_only'], consequence: 'host marked this request human-only' });
  if (!authorized) return result(HUMAN, { ...base, categories: ['missing_authorization'], consequence: 'no authorized work unit binds this request' });
  if (normalizedOperation === 'unknown') return result(HUMAN, { ...base, categories: ['unclassified_operation'], consequence: 'operation is outside the pinned permission contract' });

  const risk = detectRiskCategories({ category, command, maximumEffect, targets, patterns });
  const humanOnly = risk.filter(name => humanOnlyCategories.has(name));
  if (humanOnly.length) return result(HUMAN, { ...base, categories: humanOnly, consequence: 'configured high-impact or human-only operation' });

  const transientRoute = transientScopeEnabled ? ASSESS : HUMAN;
  const transientCategories = transientScopeEnabled ? [] : ['transient_scope_disabled'];
  const assessConsequence = transientScopeEnabled
    ? 'complete scope that is not mechanically provable; the supervisor decides from a bounded transient view'
    : 'complete scope that is not mechanically provable, and transient supervisor scope is disabled';

  const protectedKeys = protectedKeysFrom(policy, caseInsensitive);
  const containmentOptions = { projectRoot, workingDirectory, protectedKeys, fileSystem, caseInsensitive };
  const autoOperations = new Set(Array.isArray(policy?.auto_operations) ? policy.auto_operations.map(entry => normalizePermissionOperation(entry)) : []);

  if (PATH_BEARING_OPERATIONS.has(normalizedOperation)) {
    const scope = effectivePathScope(normalizedOperation, { paths, patterns });
    if (!scope.values.length) {
      return result(HUMAN, { ...base, categories: ['incomplete_scope'], consequence: 'path-bearing request did not name an exact target' });
    }
    // A declared path set that disagrees with a declared pattern set is
    // contradictory scope, not a narrower one.
    if (paths.length && patterns.length && scope.source === 'paths' && MUTATING_OPERATIONS.has(normalizedOperation)) {
      const reducible = patterns.every(pattern => paths.some(path => normalizedText(path).replace(/\\/g, '/').includes(normalizedText(pattern).replace(/\\/g, '/').replace(/[*?].*$/, ''))));
      if (!reducible) return result(HUMAN, { ...base, categories: ['incomplete_scope'], consequence: 'declared paths and patterns describe different scopes' });
    }
    const containment = evaluatePathScope(scope.values, containmentOptions);
    const facts = { checked: true, inside_project: containment.inside_project === true, protected: containment.protected === true };
    if (!containment.complete) {
      return result(HUMAN, { ...base, containment: facts, categories: [containment.reason === 'outside_project' || containment.reason === 'resolved_outside_project' ? 'outside_project' : 'incomplete_scope'], consequence: `effective target scope could not be proven (${containment.reason})` });
    }
    if (containment.protected) {
      return result(HUMAN, { ...base, containment: facts, scopeComplete: true, categories: ['protected_path'], consequence: 'target is inside the protected set' });
    }
    if (containment.wildcard) {
      return result(transientRoute, { ...base, containment: facts, scopeComplete: true, categories: ['wildcard_scope', ...transientCategories], consequence: 'wildcard scope proves only a contained search root, never what it expands to' });
    }
    if (autoOperations.has(normalizedOperation)) {
      return result(POLICY, { ...base, containment: facts, scopeComplete: true, categories: ['configured_low_impact'], consequence: 'every effective target is inside the project root and outside the protected set', decision: 'once' });
    }
    return result(transientRoute, { ...base, containment: facts, scopeComplete: true, categories: transientCategories, consequence: assessConsequence });
  }

  if (normalizedOperation === 'bash') {
    const commandText = normalizedText(command);
    const patternTexts = patterns.map(normalizedText).filter(Boolean);
    if (!commandText && !patternTexts.length) {
      return result(HUMAN, { ...base, categories: ['unclassified_bash'], consequence: 'command scope is missing' });
    }
    if (commandText && patternTexts.length) {
      const consistent = patternTexts.some(pattern => {
        const prefix = pattern.replace(/\*+$/, '');
        return commandText === pattern || commandText === prefix || commandText.startsWith(prefix);
      });
      if (!consistent) return result(HUMAN, { ...base, categories: ['unclassified_bash'], consequence: 'declared command and declared patterns describe different scopes' });
    }
    if (!commandText) {
      return result(HUMAN, { ...base, categories: ['unclassified_bash'], consequence: 'only a pattern was declared; the exact command is unknown' });
    }
    const structured = evaluateStructuredCommand(commandText, policy?.bash_rules ?? [], containmentOptions);
    if (structured.ok) {
      const containment = structured.containment ?? { inside_project: true, protected: false };
      return result(POLICY, {
        ...base,
        containment: { checked: containment.checked === true, inside_project: containment.inside_project === true, protected: false },
        scopeComplete: true,
        categories: ['configured_low_impact'],
        consequence: 'command matched a narrow structured rule with project-contained arguments',
        decision: 'once',
      });
    }
    // A command that parsed cleanly and matched a configured executable, but
    // whose arguments name a protected or escaping path, is not merely
    // unprovable -- it is a boundary violation. It fails closed to the operator
    // rather than being offered to the supervisor.
    if (PATH_REFUSAL_REASONS.has(structured.reason)) {
      return result(HUMAN, {
        ...base,
        containment: { checked: true, inside_project: false, protected: structured.reason === 'protected_path' },
        scopeComplete: true,
        categories: [structured.reason === 'protected_path' ? 'protected_path' : 'outside_project'],
        consequence: `command arguments name a target outside the permitted set (${structured.reason})`,
      });
    }
    return result(transientRoute, { ...base, scopeComplete: true, categories: transientCategories, consequence: `${assessConsequence} (${structured.reason})` });
  }

  // webfetch, task, question, and external_directory: never policy-eligible.
  if (normalizedOperation === 'external_directory') {
    return result(HUMAN, { ...base, categories: ['outside_project'], consequence: 'the request names a directory outside the project root' });
  }
  const hasScope = Boolean(normalizedText(command)) || targets.length > 0 || patterns.length > 0 || paths.length > 0;
  if (!hasScope) return result(HUMAN, { ...base, categories: ['incomplete_scope'], consequence: 'request did not name an exact scope' });
  return result(transientRoute, { ...base, scopeComplete: true, categories: transientCategories, consequence: assessConsequence });
}

/**
 * A reviewed starting policy for `permissions.mode: "policy-assess-human"`.
 *
 * It is exported for documentation, the sanitized corpus, and operator copying;
 * it is deliberately *not* the shipped default, so enabling the router alone
 * still approves nothing until an operator opts each capability in.
 */
export const RECOMMENDED_PERMISSION_POLICY = Object.freeze({
  version: 1,
  auto_operations: Object.freeze(['read', 'edit', 'write', 'list']),
  protected_paths: Object.freeze([]),
  bash_rules: Object.freeze([
    Object.freeze({ executable: 'git', subcommand: 'status', allowed_flags: Object.freeze(['--short', '--porcelain', '--branch']), allow_paths: false }),
    Object.freeze({ executable: 'git', subcommand: 'diff', allowed_flags: Object.freeze(['--stat', '--staged', '--cached', '--name-only', '--name-status']), allow_paths: true }),
    Object.freeze({ executable: 'git', subcommand: 'log', allowed_flags: Object.freeze(['--oneline', '--stat', '--graph', '--decorate']), allow_paths: true }),
    Object.freeze({ executable: 'git', subcommand: 'show', allowed_flags: Object.freeze(['--stat', '--name-only']), allow_paths: true }),
  ]),
});
