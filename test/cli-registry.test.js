/**
 * Strict CLI parser registry tests.
 *
 * Covers the declarative registry and parse wrapper: strict unknown-option
 * and missing-value failures, repeatable options, Boolean options not
 * consuming positionals, `--` termination, enum validation, suggestions,
 * safe help at every level, version output, the literal Node-20-compatible
 * `--no-agents-guidance` option, and emitted-command consistency.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_REGISTRY,
  findHelpRequest,
  packageVersion,
  parseCommandArgs,
  renderCommandHelp,
  renderFirstUse,
  renderFullHelp,
  resolveCommandName,
  suggestName,
} from '../src/cli-registry.js';
import { CliUsageError } from '../src/cli-io.js';
import { VALID_EVENT_TYPES } from '../src/event-logging.js';
import { runCliInProcess } from './helpers/run-cli.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('command registry', () => {
  it('characterizes the legacy update surface before clone-safe modes are introduced', () => {
    for (const option of ['--repository-only', '--dry-run']) {
      assert.throws(
        () => parseCommandArgs('update', COMMAND_REGISTRY.update, [option]),
        error => error instanceof CliUsageError && /unknown option/i.test(error.message)
      );
    }
    assert.equal(COMMAND_REGISTRY.hydrate, undefined);
  });

  it('resolves aliases to canonical commands', () => {
    assert.equal(resolveCommandName('upgrade'), 'update');
    assert.equal(resolveCommandName('event'), 'event-logging');
    assert.equal(resolveCommandName('init'), 'init');
    assert.equal(resolveCommandName('frobnicate'), null);
  });

  it('parses kebab-case options into camelCase keys', () => {
    const { opts } = parseCommandArgs('init', COMMAND_REGISTRY.init, [
      '--target', '/tmp/x', '--no-agents-guidance', '--dry-run',
    ]);
    assert.equal(opts.target, '/tmp/x');
    assert.equal(opts.noAgentsGuidance, true);
    assert.equal(opts.dryRun, true);
    assert.equal('no-agents-guidance' in opts, false);
  });

  it('registers --no-agents-guidance as a literal option without allowNegative', () => {
    const initNames = COMMAND_REGISTRY.init.options.map(option => option.name);
    const setupNames = COMMAND_REGISTRY.setup.options.map(option => option.name);
    assert.ok(initNames.includes('no-agents-guidance'));
    assert.ok(setupNames.includes('no-agents-guidance'));
  });

  it('keeps repeatable --adapter ordering and all values', () => {
    const { opts } = parseCommandArgs('update', COMMAND_REGISTRY.update, [
      '--adapter', 'codex', '--adapter', 'opencode', '--adapter', 'cursor',
    ]);
    assert.deepEqual(opts.adapter, ['codex', 'opencode', 'cursor']);
  });

  it('keeps repeatable --ref ordering for event writes', () => {
    const spec = { options: COMMAND_REGISTRY['event-logging'].eventTypeOptions };
    const { opts } = parseCommandArgs('event-logging check.run', spec, [
      '--ref', 'a', '--ref', 'b', '--summary', 's',
    ]);
    assert.deepEqual(opts.ref, ['a', 'b']);
    assert.equal(opts.summary, 's');
  });

  it('does not let Boolean options consume following tokens', () => {
    const { opts, positional } = parseCommandArgs('task new', COMMAND_REGISTRY.task.subcommands.new, [
      '--json', 'My', 'title',
    ]);
    assert.equal(opts.json, true);
    assert.deepEqual(positional, ['My', 'title']);
  });

  it('rejects accidental Boolean-value forms as unexpected operands (strict-parsing change)', () => {
    // The permissive parser turned `--dry-run foo` into dryRun: 'foo'.
    // Strict parsing keeps --dry-run Boolean, exposes 'foo' as a positional,
    // and central shape enforcement rejects it: remove declares no positionals.
    assert.throws(
      () => parseCommandArgs('remove', COMMAND_REGISTRY.remove, ['--dry-run', 'foo']),
      error => {
        assert.ok(error instanceof CliUsageError);
        assert.equal(error.exitCode, 2);
        assert.match(error.message, /unexpected operand 'foo'/);
        return true;
      }
    );
  });

  it('terminates option parsing at --', () => {
    const { opts, positional } = parseCommandArgs('task new', COMMAND_REGISTRY.task.subcommands.new, [
      '--json', '--', '--not-an-option',
    ]);
    assert.equal(opts.json, true);
    assert.deepEqual(positional, ['--not-an-option']);
  });

  it('fails on unknown options with a close-spelling suggestion', () => {
    assert.throws(
      () => parseCommandArgs('init', COMMAND_REGISTRY.init, ['--targt', 'x']),
      error => {
        assert.ok(error instanceof CliUsageError);
        assert.equal(error.exitCode, 2);
        assert.match(error.message, /unknown option '--targt'/);
        assert.match(error.message, /Did you mean '--target'/);
        return true;
      }
    );
  });

  it('fails on missing option values', () => {
    assert.throws(
      () => parseCommandArgs('init', COMMAND_REGISTRY.init, ['--target']),
      error => {
        assert.ok(error instanceof CliUsageError);
        assert.equal(error.exitCode, 2);
        return true;
      }
    );
  });

  it('fails on invalid enum values with the valid choices', () => {
    assert.throws(
      () => parseCommandArgs('setup', COMMAND_REGISTRY.setup, ['--event-logging', 'sometimes']),
      error => {
        assert.match(error.message, /Invalid --event-logging value 'sometimes'/);
        assert.match(error.message, /enabled, disabled/);
        return true;
      }
    );
  });

  it('suggests close command spellings only when confidence is high', () => {
    assert.equal(suggestName('setp', Object.keys(COMMAND_REGISTRY)), 'setup');
    assert.equal(suggestName('frobnicate', Object.keys(COMMAND_REGISTRY)), null);
  });

  it('detects help requests before -- only', () => {
    assert.equal(findHelpRequest(['--help']), true);
    assert.equal(findHelpRequest(['-h']), true);
    assert.equal(findHelpRequest(['--target', 'x', '-h']), true);
    assert.equal(findHelpRequest(['--', '--help']), false);
    assert.equal(findHelpRequest(['--target', 'x']), false);
  });

  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.equal(packageVersion(), pkg.version);
  });
});

describe('central positional shape enforcement', () => {
  function assertUsageFailure(label, spec, args, pattern) {
    assert.throws(
      () => parseCommandArgs(label, spec, args),
      error => {
        assert.ok(error instanceof CliUsageError, `${label}: expected CliUsageError`);
        assert.equal(error.exitCode, 2);
        assert.match(error.message, pattern);
        return true;
      },
      `${label} ${args.join(' ')} must fail`
    );
  }

  it('commands without a positionals declaration accept zero operands', () => {
    for (const [label, spec] of [
      ['init', COMMAND_REGISTRY.init],
      ['setup', COMMAND_REGISTRY.setup],
      ['update', COMMAND_REGISTRY.update],
      ['remove', COMMAND_REGISTRY.remove],
      ['validate', COMMAND_REGISTRY.validate],
      ['doctor', COMMAND_REGISTRY.doctor],
      ['status', COMMAND_REGISTRY.status],
      ['generate opencode', COMMAND_REGISTRY.generate.subcommands.opencode],
      ['bootstrap-labels', COMMAND_REGISTRY['bootstrap-labels']],
      ['configure models', COMMAND_REGISTRY.configure.subcommands.models],
    ]) {
      assertUsageFailure(label, spec, ['unexpected'], /does not accept operands; unexpected operand 'unexpected'/);
      // Zero operands parse fine.
      const { positional } = parseCommandArgs(label, spec, []);
      assert.deepEqual(positional, []);
    }
  });

  it('required positionals must be present', () => {
    assertUsageFailure('task status', COMMAND_REGISTRY.task.subcommands.status, [], /missing required <id>/);
    assertUsageFailure('task status', COMMAND_REGISTRY.task.subcommands.status, ['T-001'], /missing required <status>/);
    assertUsageFailure('worktree add', COMMAND_REGISTRY.worktree.subcommands.add, [], /missing required <task-id>/);
    assertUsageFailure('worktree remove', COMMAND_REGISTRY.worktree.subcommands.remove, [], /missing required <task-id\|path>/);
    assertUsageFailure('audit gate', COMMAND_REGISTRY.audit.subcommands.gate, [], /missing required <audit-id\|work-unit>/);
    assertUsageFailure('task new', COMMAND_REGISTRY.task.subcommands.new, [], /missing required <title>/);
  });

  it('optional positionals may be omitted but not exceeded', () => {
    const lint = COMMAND_REGISTRY.task.subcommands.lint;
    assert.deepEqual(parseCommandArgs('task lint', lint, []).positional, []);
    assert.deepEqual(parseCommandArgs('task lint', lint, ['T-001']).positional, ['T-001']);
    assertUsageFailure('task lint', lint, ['T-001', 'T-002'], /unexpected operand 'T-002'/);
    const guard = COMMAND_REGISTRY.worktree.subcommands.guard;
    assertUsageFailure('worktree guard', guard, ['a', 'b'], /unexpected operand 'b'/);
  });

  it('non-variadic declarations enforce maximum arity', () => {
    assertUsageFailure('task status', COMMAND_REGISTRY.task.subcommands.status, ['T-001', 'done', 'extra'], /unexpected operand 'extra'/);
    assertUsageFailure('worktree add', COMMAND_REGISTRY.worktree.subcommands.add, ['T-001', 'branch', 'extra'], /unexpected operand 'extra'/);
  });

  it('a variadic positional must be the final declaration', () => {
    assert.throws(
      () => parseCommandArgs('broken', { options: [], positionals: [{ name: 'a', variadic: true }, { name: 'b' }] }, []),
      /variadic positional must be the final declaration/
    );
  });

  it('no registry spec declares a non-final variadic positional', () => {
    const specs = [];
    for (const [name, spec] of Object.entries(COMMAND_REGISTRY)) {
      if (spec.positionals) specs.push([name, spec]);
      for (const [subName, subSpec] of Object.entries(spec.subcommands ?? {})) {
        if (subSpec.positionals) specs.push([`${name} ${subName}`, subSpec]);
      }
    }
    for (const [label, spec] of specs) {
      const variadicIndex = spec.positionals.findIndex(positional => positional.variadic === true);
      assert.ok(
        variadicIndex === -1 || variadicIndex === spec.positionals.length - 1,
        `${label}: variadic positional must be final`
      );
    }
  });

  it('-- still terminates option parsing, but operands must satisfy the declared shape', () => {
    // Variadic title: operand after -- is accepted.
    const { positional } = parseCommandArgs('task new', COMMAND_REGISTRY.task.subcommands.new, ['--', '--literal']);
    assert.deepEqual(positional, ['--literal']);
    // Zero-operand command: operand after -- is rejected.
    assertUsageFailure('init', COMMAND_REGISTRY.init, ['--', 'operand'], /does not accept operands/);
  });
});

describe('help rendering', () => {
  it('lists every registered command exactly once in complete help', () => {
    const help = renderFullHelp();
    const commandsSection = help.split('\n\n').find(block => block.startsWith('Commands:'));
    assert.ok(commandsSection, 'complete help must contain a Commands: block');
    for (const name of Object.keys(COMMAND_REGISTRY)) {
      const occurrences = commandsSection
        .split('\n')
        .filter(line => line.trimStart().startsWith(`${name} `) || line.trimStart() === name)
        .length;
      assert.equal(occurrences, 1, `command '${name}' must appear exactly once in complete help`);
    }
  });

  it('renders help for every command and subcommand', () => {
    for (const [name, spec] of Object.entries(COMMAND_REGISTRY)) {
      const commandHelp = renderCommandHelp(name);
      assert.ok(commandHelp, `help missing for command '${name}'`);
      assert.match(commandHelp, /agenticloop/);
      for (const subName of Object.keys(spec.subcommands ?? {})) {
        const subHelp = renderCommandHelp(`${name} ${subName}`);
        assert.ok(subHelp, `help missing for '${name} ${subName}'`);
      }
    }
  });

  it('marks init --setup deprecated and documents the setup --yes alias', () => {
    assert.match(renderCommandHelp('init'), /--setup is deprecated/);
    assert.match(renderCommandHelp('setup'), /--yes is a compatibility alias for --non-interactive/);
  });

  it('renders a short first-use screen pointing at setup', () => {
    const firstUse = renderFirstUse();
    assert.match(firstUse, /agenticloop setup/);
    assert.match(firstUse, /agenticloop doctor/);
    assert.match(firstUse, /agenticloop help/);
  });

  it('documents exit statuses in complete help', () => {
    const help = renderFullHelp();
    for (const code of ['0', '1', '2', '130']) {
      assert.match(help, new RegExp(`^ {2}${code} {2,}`, 'm'));
    }
  });

  it('documents the global debug flag and environment switch', () => {
    const help = renderFullHelp();
    assert.match(help, /--debug/);
    assert.match(help, /AGENTICLOOP_DEBUG=1/);
  });
});

describe('CLI help and version through runCli', () => {
  it('prints version through --version and version', async () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    for (const argv of [['--version'], ['version']]) {
      const result = await runCliInProcess(argv);
      assert.equal(result.status, 0);
      assert.match(result.stdout, new RegExp(`agenticloop ${pkg.version.replaceAll('.', '\\.')}`));
      assert.equal(result.stderr, '');
    }
  });

  it('makes help <command> equivalent to <command> --help', async () => {
    for (const command of ['init', 'setup', 'update', 'remove', 'doctor', 'worktree', 'task', 'audit', 'generate']) {
      const viaHelp = await runCliInProcess(['help', command]);
      const viaFlag = await runCliInProcess([command, '--help']);
      assert.equal(viaHelp.status, 0, `help ${command}`);
      assert.equal(viaFlag.status, 0, `${command} --help`);
      assert.equal(viaFlag.stdout, viaHelp.stdout, `help output mismatch for '${command}'`);
    }
  });

  it('provides safe local help for subcommands', async () => {
    for (const argv of [
      ['task', 'new', '--help'],
      ['worktree', 'remove', '--help'],
      ['guidance', 'apply', '--help'],
      ['audit', 'gate', '--help'],
      ['generate', 'codex', '--help'],
      ['help', 'worktree', 'add'],
    ]) {
      const result = await runCliInProcess(argv);
      assert.equal(result.status, 0, argv.join(' '));
      assert.match(result.stdout, /agenticloop/);
    }
  });

  it('suggests close spellings for unknown commands with exit 2', async () => {
    const result = await runCliInProcess(['setp']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown command: setp/);
    assert.match(result.stderr, /Did you mean 'setup'/);
  });

  it('exits 2 for unknown subcommands without executing handlers', async () => {
    const result = await runCliInProcess(['task', 'frobnicate']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /task/);
  });
});

describe('emitted command consistency', () => {
  function collectMarkdownFiles(dir, files = []) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'tmp') continue;
        collectMarkdownFiles(fullPath, files);
      } else if (entry.endsWith('.md')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  // Representative values for documented placeholders.
  const PLACEHOLDER_VALUES = {
    host: 'opencode', dir: 'dir', id: 'T-001', number: '1', file: 'file.json',
    'task-id': 'T-001', title: 'Title', status: 'done', branch: 'feature/T-001',
    path: 'dir', s: 'done', ids: 'T-001', ref: 'commit:abc123', text: 'text',
    v: 'certified', m: 'host_subagent', json: '{}', n: '1', category: 'scope',
    role: 'engineer', value: 'high', mode: 'enabled', strategy: 'prefer-root',
    event: 'task.started', event_type: 'task.started',
    name: 'owner/repo', 'owner/name': 'owner/repo',
    'audit-id': 'A-1', 'work-unit': 'work-unit:x', 'task-id|path': 'T-001',
    'audit-id|work-unit': 'A-1', command: 'init', subcommand: 'add',
    'commit-class': 'product_implementation',
  };

  function normalizeToken(token) {
    let out = token;
    out = out.replace(/<([^>]+)>/g, (_match, inner) => {
      const first = inner.split('|')[0].trim();
      // Known meta-names map to representative values; literal alternatives
      // (<apply|check|remove>, <accepted|needs_revision>) stand for themselves.
      return PLACEHOLDER_VALUES[first] ?? PLACEHOLDER_VALUES[first.toLowerCase()] ?? first;
    });
    if (out.includes('|')) out = out.split('|')[0];
    return out;
  }

  /**
   * Shell-ish tokenizer: whitespace-separated, double/single quotes group
   * (their contents, including JSON parentheses, stay one token), unquoted
   * backtick/`$`/paren characters or space-separated pipe/ampersand/semicolon
   * mark shell composition and return null.
   */
  function shellTokenize(text) {
    const tokens = [];
    let current = '';
    let quote = null;
    for (let index = 0; index < text.length; index += 1) {
      const ch = text[index];
      if (quote) {
        if (ch === quote) quote = null;
        else current += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (/\s/.test(ch)) {
        if (current) { tokens.push(current); current = ''; }
        continue;
      }
      if (ch === '`' || ch === '$' || ch === '(' || ch === ')') return null;
      if ((ch === '|' || ch === '&' || ch === ';') && current === '') return null;
      current += ch;
    }
    if (quote) return null;
    if (current) tokens.push(current);
    return tokens;
  }

  /**
   * Tokenize one extracted candidate into a normalized argv, or return null
   * when the candidate is not a recognizable command snippet (prose, aligned
   * documentation columns, meta usage patterns, path references, shell
   * compositions, or truncated examples).
   */
  function tokenizeInvocation(raw) {
    let text = raw.trim();
    // Aligned documentation columns: a run of 2+ spaces ends the invocation.
    text = text.split(/\s{2,}/)[0];
    // Trailing shell comments and line-continuation markers.
    text = text.replace(/\s+#.*$/, '');
    text = text.replace(/\s*\\$/, '');
    // Strip prompts, env assignments, and the package runner prefix.
    text = text.replace(/^[$>]\s*/, '');
    while (/^[A-Z_][A-Z0-9_]*=\S+\s+/.test(text)) text = text.replace(/^[A-Z_][A-Z0-9_]*=\S+\s+/, '');
    text = text.replace(/^npx\s+(?:-y\s+)?/, '');
    if (!text.startsWith('agenticloop')) return null;
    // Meta usage patterns that cannot be concretely validated.
    if (/\[options\]|\[subcommand\]|<command>|\.\.\./.test(text)) return null;
    // Optional-group brackets are documentation notation, not shell syntax.
    text = text.replace(/\[|\]/g, '');
    const rawTokens = shellTokenize(text);
    if (!rawTokens) return null;
    const tokens = rawTokens.map(normalizeToken).filter(token => token.length > 0);
    if (tokens[0] !== 'agenticloop' || tokens.length < 2) return null;
    const second = tokens[1];
    // A recognizable snippet names a registered command (or alias), a global
    // flag, or help/version. Anything else is prose, not an invocation.
    const recognizable = second === 'help' || second === 'version' ||
      second === '--help' || second === '-h' || second === '--version' ||
      resolveCommandName(second) !== null;
    return recognizable ? tokens : null;
  }

  /** Extract candidate invocations from Markdown code spans and fenced blocks. */
  function extractFromMarkdown(text) {
    const candidates = [];
    for (const match of text.matchAll(/`([^`\n]*agenticloop[^`\n]*)`/g)) {
      candidates.push(match[1]);
    }
    for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      for (const line of match[1].split('\n')) {
        if (/(?:^|[\s$>])(?:npx\s+)?agenticloop\s/.test(line)) candidates.push(line);
      }
    }
    return candidates;
  }

  /** Extract candidate invocations from quoted source string literals. */
  function extractFromSource(text) {
    const candidates = [];
    for (const match of text.matchAll(/["'`]((?:npx )?agenticloop [^"'`\n]*)["'`]/g)) {
      candidates.push(match[1]);
    }
    return candidates;
  }

  /**
   * Validate one complete normalized invocation through the same registry and
   * parser the CLI uses: command, subcommand, options, option values, enum
   * literals, and positional arity. Returns an error string or null.
   */
  function validateInvocation(tokens) {
    const args = tokens.slice(1);
    try {
      if (args[0] === '--help' || args[0] === '-h' || args[0] === '--version') {
        if (args.length !== 1) return `global flag '${args[0]}' takes no further arguments`;
        return null;
      }
      if (args[0] === 'version') {
        return args.length === 1 ? null : `version takes no arguments`;
      }
      if (args[0] === 'help') {
        if (args.length === 1) return null;
        const helpCommand = resolveCommandName(args[1]);
        if (!helpCommand) return `help references unknown command '${args[1]}'`;
        if (args.length === 2) return null;
        const helpSpec = COMMAND_REGISTRY[helpCommand];
        if (args.length === 3 && (helpSpec.subcommands?.[args[2]] ||
            (helpCommand === 'event-logging' && VALID_EVENT_TYPES.has(args[2])))) return null;
        return `help references unknown subcommand '${args.slice(1).join(' ')}'`;
      }
      const command = resolveCommandName(args[0]);
      if (!command) return `unknown command '${args[0]}'`;
      const spec = COMMAND_REGISTRY[command];
      let leaf = spec;
      let label = command;
      let rest = args.slice(1);
      if (spec.subcommands) {
        const sub = rest[0];
        if (!sub || sub.startsWith('-')) return `${label}: missing subcommand`;
        const subSpec = spec.subcommands[sub];
        if (subSpec) {
          leaf = subSpec;
        } else if (command === 'event-logging' && VALID_EVENT_TYPES.has(sub)) {
          leaf = { options: spec.eventTypeOptions };
        } else {
          return `${label}: unknown subcommand '${sub}'`;
        }
        label = `${command} ${sub}`;
        rest = rest.slice(1);
      }
      parseCommandArgs(label, leaf, rest);
      return null;
    } catch (error) {
      return error instanceof CliUsageError ? error.message : String(error);
    }
  }

  it('every documented agenticloop invocation validates completely against the registry parser', () => {
    const markdownFiles = [
      ...collectMarkdownFiles(join(REPO_ROOT, 'docs')),
      ...collectMarkdownFiles(join(REPO_ROOT, 'skills')),
      join(REPO_ROOT, 'README.md'),
      join(REPO_ROOT, 'AGENTIC_LOOP.md'),
    ];
    const sourceFiles = readdirSync(join(REPO_ROOT, 'src'))
      .filter(entry => entry.endsWith('.js'))
      .map(entry => join(REPO_ROOT, 'src', entry));

    const offenders = [];
    let checked = 0;
    const checkCandidate = (file, candidate) => {
      const tokens = tokenizeInvocation(candidate);
      if (!tokens) return;
      const problem = validateInvocation(tokens);
      if (!problem) { checked += 1; return; }
      // Prose references name a command family with no options or operands
      // ("persists with `agenticloop audit report`"); they are not presented
      // as runnable invocations, so shape failures on the bare command path
      // are out of scope.
      const command = resolveCommandName(tokens[1]);
      const spec = command ? COMMAND_REGISTRY[command] : null;
      const bareCommandPath = command &&
        (tokens.length === 2 ||
          (tokens.length === 3 && spec?.subcommands &&
            (spec.subcommands[tokens[2]] !== undefined ||
              (command === 'event-logging' && VALID_EVENT_TYPES.has(tokens[2])))));
      if (bareCommandPath && /missing (required|subcommand)/.test(problem)) return;
      checked += 1;
      offenders.push(`${file}: 'agenticloop ${tokens.slice(1).join(' ')}' -> ${problem}`);
    };
    for (const file of markdownFiles) {
      for (const candidate of extractFromMarkdown(readFileSync(file, 'utf-8'))) {
        checkCandidate(file, candidate);
      }
    }
    for (const file of sourceFiles) {
      for (const candidate of extractFromSource(readFileSync(file, 'utf-8'))) {
        checkCandidate(file, candidate);
      }
    }
    assert.ok(checked > 50, `expected meaningful extraction coverage, only ${checked} invocations found`);
    assert.deepEqual(offenders, [], `documented invocations rejected by the registry parser:\n${offenders.join('\n')}`);
  });

  it('registry usage strings parse as complete valid invocation shapes', () => {
    // Usage strings are structured examples generated from the registry: the
    // fullest expansion (every optional group included) must parse.
    const offenders = [];
    const checkUsage = (label, usage) => {
      if (!usage) return;
      const tokens = tokenizeInvocation(usage);
      // Meta usage patterns (parent commands with <subcommand> [options]
      // shapes) cannot be concretely validated; their leaf usages are.
      if (!tokens) return;
      const problem = validateInvocation(tokens);
      if (problem) offenders.push(`${label}: usage '${usage}' -> ${problem}`);
    };
    for (const [name, spec] of Object.entries(COMMAND_REGISTRY)) {
      checkUsage(name, spec.usage);
      for (const [subName, subSpec] of Object.entries(spec.subcommands ?? {})) {
        checkUsage(`${name} ${subName}`, subSpec.usage);
      }
    }
    assert.deepEqual(offenders, [], `registry usage strings rejected by the parser:\n${offenders.join('\n')}`);
  });

  it('keeps check-evidence-update usage to parser-valid flags and arguments', () => {
    const usage = COMMAND_REGISTRY.task.subcommands['check-evidence-update'].usage;
    assert.doesNotMatch(usage, /for passed command checks/);
    assert.doesNotThrow(() => {
      parseCommandArgs('task check-evidence-update', COMMAND_REGISTRY.task.subcommands['check-evidence-update'], [
        'T-001', '--packet', 'packet.json', '--input', 'checks.json', '--output', 'checks.json',
        '--check', 'RC-1', '--outcome', 'passed', '--evidence', 'green', '--execution-output', 'rc-1.json',
      ]);
    });
  });
});
