/**
 * The `agenticloop activate` command and the `agenticloop activation`
 * status, revoke, and provision-key subcommands.
 *
 * This is the universal, host-neutral activation path. It requires no OpenCode
 * plugin, no host integration, and no change to an existing task: the operator
 * runs one explicit command outside the agent session, sees the exact tasks,
 * carriers, contract digests, repository, work unit, and resulting assurance,
 * and types a confirmation.
 *
 * Two rules keep the grade honest:
 *
 * 1. `operator_confirmed` requires a genuinely interactive invocation. There is
 *    no `--yes`, no `--force`, and no environment variable that lets an agent
 *    mint this grade silently. A non-interactive invocation is refused.
 * 2. The grant and every binding are signed with a key held outside the target
 *    repository, so a hand-authored record inside `.agenticloop/activations/`
 *    cannot self-authorize however self-consistent it looks.
 *
 * The command never rewrites task bodies. Existing tasks keep their IDs,
 * frontmatter, history, and decomposition state.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { CliUsageError, EXIT_USAGE, createIo, resolveCliTarget } from './cli-io.js';
import { COMMAND_REGISTRY, parseCommandArgs, suggestName } from './cli-registry.js';
import { PROJECT_MAP_DEFAULTS, loadProjectMap } from './project-map.js';
import { resolveTaskBackend } from './task-backend.js';
import { commandFailure, printGateResult } from './public-result.js';
import { createValidationResult } from './result-envelope.js';
import { taskContractDigest } from './task-contract-baseline.js';
import { targetRepositoryIdentity } from './host-trust.js';
import {
  PublicCommandError,
  VerificationContextError,
  VerificationContextMalformedError,
} from './public-error.js';
import {
  ACTIVATION_ASSURANCE_LIMITATIONS,
  CLI_OPERATOR_PRODUCER_ID,
  DEFAULT_GRANT_TTL_SECONDS,
  MAX_GRANT_TTL_SECONDS,
  OPERATOR_CONFIRMATION_PHRASE,
  RETURN_ASSURANCE_LIMITATIONS,
  createActivationGrant,
  createActivationRevocation,
  createTaskActivationBinding,
  resolveTaskActivationBinding,
  validateActivationGrantShape,
  validateTaskActivationBindingShape,
} from './activation-grant.js';
import {
  loadOperatorActivationKey,
  provisionOperatorActivationKey,
  readExternalActivationRevocations,
  signOperatorActivationPayload,
  writeExternalActivationRevocation,
} from './activation-trust.js';
import {
  inspectOperatorActivationIdentity,
  migrateOperatorActivationIdentity,
} from './activation-identity-migration.js';
import {
  activationGrantSignaturePayload,
  taskActivationBindingSignaturePayload,
} from './activation-grant.js';
import {
  ACTIVATION_STORE_ROOT,
  activationScopeSummaryDigest,
  bindingRecordPath,
  listTaskActivationBindings,
  readActivationGrant,
  readActivationRevocations,
  writeActivationRecords,
  writeActivationRevocation,
} from './activation-store.js';
import {
  loadTaskActivationEvidence,
  resolveActivationVerification,
  resolveEffectiveActivationPolicy,
} from './activation-resolution.js';
import { fetchGitHubTaskBody } from './github-task-body.js';
import { resolveGhRunner } from './closeout-github.js';
import { buildGitHubTaskIdentityInventory, resolveCoveredGitHubTask } from './github-task-identity.js';
import { resolveGitHubRepository, runGhJson } from './gh-helpers.js';
import { createHash } from 'node:crypto';

const ACTIVATION_SUBCOMMANDS = ['status', 'revoke', 'provision-key', 'identity-status', 'migrate-identity'];

function sha256(text) {
  return `sha256:${createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')}`;
}

function resolveProjectConfig(target) {
  const projectMap = loadProjectMap(target);
  return { ...(projectMap?.config ?? PROJECT_MAP_DEFAULTS) };
}

function taskPathForId(target, projectConfig, taskId) {
  const relPath = String(projectConfig.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template)
    .replace(/\\/g, '/')
    .replaceAll('{taskId}', taskId);
  const fullPath = resolve(target, relPath);
  const root = resolve(target);
  if (fullPath !== root && !fullPath.startsWith(`${root}\\`) && !fullPath.startsWith(`${root}/`)) {
    throw new VerificationContextMalformedError(`task_file_template resolves outside target: ${projectConfig.task_file_template}`);
  }
  return fullPath;
}

/**
 * Load one task's canonical identity, carrier, and current contract digest from
 * the configured backend. Neither backend rewrites the task body.
 */
function loadTaskIdentity(target, { backend, projectConfig, taskId, io, repo, githubSnapshot }) {
  if (backend === 'files') {
    const filePath = taskPathForId(target, projectConfig, taskId);
    const carrier = relative(target, filePath).replace(/\\/g, '/');
    if (!existsSync(filePath)) {
      throw new VerificationContextError(`Task record not found: ${carrier}`);
    }
    const body = readFileSync(filePath, 'utf8');
    const contract = taskContractDigest(body);
    if (!contract.ok) throw new VerificationContextMalformedError(`Task '${taskId}' contract is invalid: ${contract.error}`);
    if (contract.projection.task_id !== taskId) {
      throw new VerificationContextMalformedError(
        `Task record ${carrier} declares task_id '${contract.projection.task_id}', not '${taskId}'`
      );
    }
    return { backend, taskId, carrier, body, contractDigest: contract.digest, bodyDigest: sha256(body) };
  }
  const snapshot = githubSnapshot();
  const resolved = resolveCoveredGitHubTask(snapshot.identityInventory, taskId);
  if (!resolved.found) throw new VerificationContextError(`GitHub task '${taskId}' is not resolvable: ${resolved.error}`);
  const fetched = fetchGitHubTaskBody({
    issue: resolved.issue.number,
    repo: snapshot.repo,
    commandRunner: resolveGhRunner(io),
    projectMapConfig: projectConfig,
  });
  const contract = taskContractDigest(fetched.body);
  if (!contract.ok) throw new VerificationContextMalformedError(`Task '${taskId}' contract is invalid: ${contract.error}`);
  if (contract.projection.task_id !== taskId) {
    throw new VerificationContextMalformedError(
      `GitHub issue #${resolved.issue.number} declares task_id '${contract.projection.task_id}', not '${taskId}'`
    );
  }
  return {
    backend,
    taskId,
    carrier: `issue:${resolved.issue.number}`,
    body: fetched.body,
    contractDigest: contract.digest,
    bodyDigest: fetched.digest,
  };
}

function githubSnapshotLoader(target, projectConfig, io, repoOption) {
  let cached = null;
  return () => {
    if (cached) return cached;
    const commandRunner = resolveGhRunner(io);
    const repo = resolveGitHubRepository(commandRunner, repoOption);
    const pages = runGhJson(commandRunner, [
      'api', '--paginate', '--slurp', `repos/${repo}/issues?state=all&per_page=100`,
    ]);
    if (!Array.isArray(pages) || pages.length === 0 || pages.some(page => !Array.isArray(page))) {
      throw new VerificationContextMalformedError('GitHub issue pagination did not return a complete page inventory');
    }
    const issues = pages.flat().filter(issue => !issue?.pull_request).map(issue => ({
      number: issue?.number,
      state: issue?.state,
      title: issue?.title,
      body: issue?.body,
      labels: issue?.labels,
    }));
    cached = {
      repo,
      issues,
      identityInventory: buildGitHubTaskIdentityInventory(issues, {
        complete: true,
        taskIdRegex: projectConfig.task_id_regex,
      }),
    };
    return cached;
  };
}

/**
 * Read the committed decomposition source that a work-unit activation derives
 * its child bindings from.
 *
 * Only a Maintainer-attributed, complete, current record for the exact work
 * unit can be used. Nothing here derives authority from a task body.
 */
function loadWorkUnitDecomposition(target, workUnitId) {
  const directory = join(target, '.agenticloop', 'decompositions');
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new VerificationContextError(
      `No committed decomposition sources found under .agenticloop/decompositions/ for work unit '${workUnitId}'`
    );
  }
  const matches = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const relPath = `.agenticloop/decompositions/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    } catch (error) {
      throw new VerificationContextMalformedError(`Committed decomposition '${relPath}' is invalid JSON: ${error.message}`);
    }
    if (parsed?.scan?.workUnit?.id === workUnitId) matches.push({ relPath, record: parsed });
  }
  if (matches.length === 0) {
    throw new VerificationContextError(
      `No committed decomposition source names work unit '${workUnitId}'. ` +
      'Run `agenticloop task prepare-decomposition` and commit its output first, or activate the exact task ids directly.'
    );
  }
  // Several task records may share one work unit; they must agree on the exact
  // committed source, because a single grant derives from a single scan.
  const distinct = new Set(matches.map(item => item.record?.sourceDigest));
  if (distinct.size !== 1) {
    throw new VerificationContextError(
      `Work unit '${workUnitId}' has ${distinct.size} distinct committed decomposition sources; ` +
      'reconcile them before activating the work unit, or activate the exact task ids directly.'
    );
  }
  const chosen = matches[0];
  const record = chosen.record;
  if (record?.authority !== 'maintainer' || record?.source !== 'task-decomposition') {
    throw new VerificationContextError(
      `Committed decomposition '${chosen.relPath}' is not Maintainer-attributed task decomposition`
    );
  }
  if (record?.scan?.inventory?.complete !== true || record?.scan?.decomposition?.state !== 'complete') {
    throw new VerificationContextError(
      `Committed decomposition '${chosen.relPath}' does not prove a complete authoritative task inventory`
    );
  }
  const readyTaskIds = Array.isArray(record?.scan?.readyTaskIds) ? [...record.scan.readyTaskIds] : [];
  if (readyTaskIds.length === 0) {
    throw new VerificationContextError(`Committed decomposition '${chosen.relPath}' has an empty ready set`);
  }
  return { sourceRef: record.sourceRef ?? chosen.relPath, record, readyTaskIds };
}

/** Human-readable authorization scope. Its exact text is digested into the grant. */
function renderScopeSummary({ repositoryIdentity, backend, mode, policy, scope, workUnitId, tasks, expiresAt }) {
  const lines = [
    'Agentic Loop activation request',
    '',
    `  repository:        ${repositoryIdentity}`,
    `  backend:           ${backend}`,
    `  scope:             ${scope}`,
    ...(workUnitId ? [`  work unit:         ${workUnitId}`] : []),
    `  tasks:             ${tasks.length}`,
    '',
  ];
  for (const task of tasks) {
    lines.push(`  - ${task.taskId}`);
    lines.push(`      carrier:         ${task.carrier}`);
    lines.push(`      contract digest: ${task.contractDigest}`);
    lines.push(`      derivation:      ${task.derivation}`);
  }
  lines.push(
    '',
    `  resulting activation assurance: operator_confirmed`,
    `  effective mode:                 ${mode} (policy source: ${policy.source})`,
    `  minimum activation:             ${policy.minimumActivation}`,
    `  minimum return:                 ${policy.minimumReturn}`,
    `  grant expires:                  ${expiresAt}`,
    '',
    `  ${ACTIVATION_ASSURANCE_LIMITATIONS.operator_confirmed}`,
    '',
  );
  return lines.join('\n');
}

/**
 * Refuse anything that is not a genuine interactive terminal session.
 *
 * There is deliberately no override. An agent that can only write files and run
 * non-interactive commands cannot reach this grade, which is the entire
 * difference between `operator_confirmed` and an unsigned repository file.
 */
function requireInteractiveOperator(io) {
  if (io.ci) {
    throw new PublicCommandError(
      'Operator-confirmed activation refuses to run under CI.',
      {
        code: 'activation.grant.unauthenticated',
        evidenceState: 'negative',
        disposition: 'blocked',
        committedStateEvaluated: false,
        safeRepair:
          'Run `npx agenticloop activate <task-id>` from an interactive terminal on the machine that owns the checkout. ' +
          'For unattended pipelines, register a protected host adapter and use host-signed activation instead.',
      }
    );
  }
  if (!io.isTTY || !io.stdinIsTTY) {
    throw new PublicCommandError(
      'Operator-confirmed activation requires a genuinely interactive terminal (both stdin and stdout must be a TTY).',
      {
        code: 'activation.grant.unauthenticated',
        evidenceState: 'negative',
        disposition: 'blocked',
        committedStateEvaluated: false,
        safeRepair:
          'Run `npx agenticloop activate <task-id>` yourself in a terminal, outside the agent session, then continue in the same project. ' +
          'There is no non-interactive flag for this assurance grade.',
      }
    );
  }
}

function parseTtlSeconds(value) {
  if (value === undefined) return DEFAULT_GRANT_TTL_SECONDS;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new CliUsageError('--expires-in-hours must be a positive number of hours');
  }
  const seconds = Math.round(hours * 3600);
  if (seconds > MAX_GRANT_TTL_SECONDS) {
    throw new CliUsageError(`--expires-in-hours must not exceed ${MAX_GRANT_TTL_SECONDS / 3600} hours`);
  }
  return seconds;
}

/** `agenticloop activate <task-id...> | --work-unit <id>` */
export async function cmdActivate(args, io = createIo()) {
  const spec = COMMAND_REGISTRY.activate;
  const { opts, positional } = parseCommandArgs('activate', spec, args);
  const target = resolveCliTarget(io, opts.target);
  const asJson = Boolean(opts.json);
  const command = 'activate';

  try {
    const workUnitId = opts.workUnit ? String(opts.workUnit) : null;
    const requestedTaskIds = [...new Set(positional.map(String))];
    if (workUnitId && requestedTaskIds.length > 0) {
      throw new CliUsageError('activate takes either explicit task ids or --work-unit <id>, not both');
    }
    if (!workUnitId && requestedTaskIds.length === 0) {
      throw new CliUsageError('activate requires at least one task id, or --work-unit <id>');
    }
    const ttlSeconds = parseTtlSeconds(opts.expiresInHours);
    const backendResolution = resolveTaskBackend(target);
    const backend = backendResolution.backend;
    if (!['files', 'github'].includes(backend)) {
      throw new VerificationContextMalformedError(
        `Configured task backend '${String(backend)}' from ${backendResolution.source} is not supported by activate`
      );
    }
    if (backend === 'files' && opts.repo !== undefined) {
      throw new CliUsageError("--repo names a GitHub repository and the configured task backend is 'files'");
    }
    const projectConfig = resolveProjectConfig(target);
    const policy = resolveEffectiveActivationPolicy(target, io);
    const repositoryIdentity = targetRepositoryIdentity(target);
    const githubSnapshot = githubSnapshotLoader(target, projectConfig, io, opts.repo);

    // Resolve the exact task set and its derivation before anything is shown to
    // the operator or signed.
    let decomposition = null;
    let taskIds = requestedTaskIds;
    let derivation = 'direct_operator_confirmation';
    let scopeLabel = `exact task set (${requestedTaskIds.length})`;
    if (workUnitId) {
      decomposition = loadWorkUnitDecomposition(target, workUnitId);
      taskIds = [...decomposition.readyTaskIds].sort();
      derivation = 'committed_decomposition_membership';
      scopeLabel = `work unit '${workUnitId}' ready set (${taskIds.length})`;
    }

    const tasks = taskIds.map(taskId => ({
      ...loadTaskIdentity(target, { backend, projectConfig, taskId, io, repo: opts.repo, githubSnapshot }),
      derivation,
    }));

    // Every child of a work-unit grant must be a canonical ready-set member.
    if (workUnitId) {
      for (const task of tasks) {
        if (!decomposition.readyTaskIds.includes(task.taskId)) {
          throw new VerificationContextError(
            `Task '${task.taskId}' is not a member of the canonical ready set for work unit '${workUnitId}'`
          );
        }
      }
    }

    // Refuse a non-interactive caller before any side effect at all, including
    // key provisioning outside the target. `--dry-run` is read-only and stays
    // available so a plan can be inspected from anywhere.
    if (!opts.dryRun) requireInteractiveOperator(io);

    // The confirmation key lives outside the target. Provision lazily so the
    // first activation in a checkout is still a single command.
    const provisioned = opts.dryRun
      ? { ok: true, key: { keyId: 'operator-0000000000000000' } }
      : provisionOperatorActivationKey(target, {
          operatorActivationRoot: io.operatorActivationRoot ?? undefined,
        });
    if (!provisioned.ok) {
      throw new VerificationContextMalformedError(
        `Operator activation key could not be provisioned: ${provisioned.errors.join('; ')}` +
        (provisioned.diagnostic?.code === 'activation.identity.migration_required'
          ? ". Run 'npx agenticloop activation migrate-identity' to carry the existing operator identity forward."
          : '')
      );
    }
    const operatorKey = provisioned.key;

    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString();
    const summary = renderScopeSummary({
      repositoryIdentity,
      backend,
      mode: policy.mode,
      policy,
      scope: scopeLabel,
      workUnitId,
      tasks,
      expiresAt,
    });

    // In JSON mode stdout must hold exactly one machine-readable document, so
    // the operator-facing scope summary and the prompt go to stderr.
    const show = asJson ? line => io.err(line) : line => io.out(line);

    if (opts.dryRun) {
      show(summary);
      show('Dry run: no activation grant was created.');
      if (asJson) {
        io.out(JSON.stringify({
          command,
          dryRun: true,
          repositoryIdentity,
          backend,
          workUnitId,
          tasks: tasks.map(task => ({ taskId: task.taskId, carrier: task.carrier, contractDigest: task.contractDigest, derivation: task.derivation })),
          assurance: { activation: 'operator_confirmed', mode: policy.mode, policySource: policy.source },
        }, null, 2));
      }
      return 0;
    }

    // Interactive confirmation. This is the whole assurance claim: the operator
    // sees every resolved fact first, and there is no way to skip it.
    show(summary);
    const prompts = io.createPrompts();
    let answer;
    try {
      answer = await prompts.ask(`Type '${OPERATOR_CONFIRMATION_PHRASE}' to authorize exactly this scope: `);
    } finally {
      prompts.close?.();
    }
    if (String(answer ?? '').trim() !== OPERATOR_CONFIRMATION_PHRASE) {
      show('Activation cancelled; no grant was created.');
      if (asJson) io.out(JSON.stringify({ command, cancelled: true, grantId: null, tasks: [] }, null, 2));
      return 0;
    }
    const confirmedAt = new Date().toISOString();

    const grantSkeleton = createActivationGrant({
      repositoryIdentity,
      backend,
      scope: workUnitId
        ? { type: 'work_unit', workUnitId }
        : { type: 'exact_tasks', taskIds },
      assurance: 'operator_confirmed',
      producer: { id: CLI_OPERATOR_PRODUCER_ID, channel: 'cli_interactive_confirmation' },
      issuedAt,
      expiresAt,
      evidence: {
        confirmedAt,
        confirmationPhrase: OPERATOR_CONFIRMATION_PHRASE,
        channel: 'cli_interactive_confirmation',
        operatorKeyId: operatorKey.keyId,
        // The digest of the exact text the operator saw. The raw text is never
        // stored in the target.
        scopeSummaryDigest: activationScopeSummaryDigest(summary),
      },
    });
    const grant = Object.freeze({
      ...grantSkeleton,
      authentication: signOperatorActivationPayload(
        activationGrantSignaturePayload(grantSkeleton),
        { key: operatorKey, repositoryIdentity }
      ),
    });

    const bindings = tasks.map(task => {
      const skeleton = createTaskActivationBinding({
        grant,
        backend,
        taskId: task.taskId,
        carrier: task.carrier,
        taskContractDigest: task.contractDigest,
        derivation,
        decompositionSource: decomposition
          ? {
              sourceRef: decomposition.record.sourceRef ?? decomposition.sourceRef,
              sourceDigest: decomposition.record.sourceDigest,
              scanSemanticDigest: decomposition.record.scan?.semanticDigest,
              workUnitId,
              observedAt: decomposition.record.observedAt,
            }
          : null,
      });
      return Object.freeze({
        ...skeleton,
        authentication: signOperatorActivationPayload(
          taskActivationBindingSignaturePayload(skeleton),
          { key: operatorKey, repositoryIdentity }
        ),
      });
    });

    // One transaction. A partial write never leaves partial authority: either
    // the grant and every binding land, or none do and the receipt says so.
    const written = writeActivationRecords(target, { grant, bindings });
    if (!written.ok) {
      const result = createValidationResult({
        command,
        ok: false,
        evidenceState: written.receipt.unresolved ? 'changed' : 'negative',
        disposition: written.receipt.unresolved ? 'superseded' : 'blocked',
        errors: written.receipt.errors,
        firstSafeRepair: written.receipt.recovery,
        receipt: written.receipt,
      });
      return printGateResult(command, result, asJson, io);
    }

    const report = {
      command,
      grantId: grant.grantId,
      repositoryIdentity,
      backend,
      workUnitId,
      scopeType: grant.scope.type,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      revocationId: grant.revocation.id,
      assurance: {
        activation: 'operator_confirmed',
        activationProducer: CLI_OPERATOR_PRODUCER_ID,
        activationChannel: 'cli_interactive_confirmation',
        mode: policy.mode,
        policySource: policy.source,
        minimumActivation: policy.minimumActivation,
        minimumReturn: policy.minimumReturn,
        limitations: [
          ACTIVATION_ASSURANCE_LIMITATIONS.operator_confirmed,
          RETURN_ASSURANCE_LIMITATIONS[policy.minimumReturn],
        ],
      },
      tasks: bindings.map(binding => ({
        taskId: binding.taskId,
        carrier: binding.carrier,
        contractDigest: binding.taskContractDigest,
        derivation: binding.derivation,
        bindingId: binding.bindingId,
        record: bindingRecordPath(binding.backend, binding.taskId),
      })),
      receipt: written.receipt,
    };
    if (asJson) {
      io.out(JSON.stringify(report, null, 2));
      return 0;
    }
    io.out(`Activated ${bindings.length} task(s) under grant ${grant.grantId}.`);
    for (const binding of bindings) {
      io.out(`  ${binding.taskId}  ${binding.carrier}  ${binding.taskContractDigest}`);
    }
    io.out('');
    io.out(`  activation: operator_confirmed`);
    io.out(`  return:     ${policy.minimumReturn} (minimum for ${policy.mode} mode)`);
    io.out(`  expires:    ${grant.expiresAt}`);
    io.out(`  records:    ${ACTIVATION_STORE_ROOT}/`);
    io.out('');
    io.out(`  ${ACTIVATION_ASSURANCE_LIMITATIONS.operator_confirmed}`);
    if (policy.mode === 'hardened') {
      io.warn(
        '  WARN: this project is in hardened mode, which requires host_signed activation. ' +
        'These operator-confirmed grants will not authorize dispatch until a protected host adapter is registered.'
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      return printGateResult(command, commandFailure(command, error, 'usage', {}, target), asJson, io, EXIT_USAGE);
    }
    return printGateResult(command, commandFailure(command, error, 'operational_error', {}, target), asJson, io);
  }
}

/**
 * Report or apply the repository authority-identity migration.
 *
 * Both subcommands share one projection so the read-only report and the applied
 * result can never disagree about what state exists.
 */
function runIdentityMigrationSubcommand(sub, { target, io, asJson, command }) {
  const operatorActivationRoot = io.operatorActivationRoot ?? undefined;
  const applied = sub === 'migrate-identity'
    ? migrateOperatorActivationIdentity(target, { operatorActivationRoot })
    : null;
  // `applied.inspection` is the state the migration *read*, before it wrote
  // anything. Projecting that as `current` reported `currentKeyState: missing`
  // alongside `migrated: true` for a migration that had just succeeded. A
  // mutation is reported from the state it produced, so the
  // filesystem is re-read after a successful apply and the pre-migration view is
  // kept only under its own name.
  const priorInspection = applied?.inspection ?? null;
  const inspection = applied?.migrated
    ? inspectOperatorActivationIdentity(target, { operatorActivationRoot })
    : priorInspection ?? inspectOperatorActivationIdentity(target, { operatorActivationRoot });
  const report = {
    command,
    disposition: applied?.disposition ?? inspection.disposition,
    identityVersion: inspection.identityVersion,
    currentIdentity: inspection.currentIdentity,
    currentDigest: inspection.currentDigest,
    currentKeyState: inspection.currentKeyState,
    currentKeyId: inspection.currentKeyId,
    // The digest is the directory name under `<root>/revocations/`, so the
    // documented manual repair can only name a locatable path when the digest
    // is reported.
    supersededIdentities: inspection.legacy.map(item => ({
      identity: item.identity,
      digest: item.digest,
      keyState: item.keyState,
      keyId: item.keyId,
      revocationCount: item.revocationCount,
      revocationDirectory: item.revocationDirectory,
    })),
    receiptPath: inspection.receiptPath,
    ...(applied
      ? {
        migrated: applied.migrated,
        errors: applied.errors,
        ...(applied.migrated
          ? {
            priorKeyState: priorInspection.currentKeyState,
            priorKeyId: priorInspection.currentKeyId,
            migratedFrom: applied.receipt?.migratedFrom ?? null,
          }
          : {}),
      }
      : {}),
  };
  if (asJson) io.out(JSON.stringify(report, null, 2));
  else {
    io.out(`Repository authority identity v${inspection.identityVersion}: ${inspection.currentIdentity}`);
    io.out(`  digest:            ${inspection.currentDigest}`);
    io.out(`  operator key:      ${report.currentKeyState}${report.currentKeyId ? ` (${report.currentKeyId})` : ''}`);
    io.out(`  disposition:       ${report.disposition}`);
    for (const item of report.supersededIdentities) {
      io.out(`  superseded:        ${item.identity} [key ${item.keyState}, ${item.revocationCount} revocation(s)]`);
      io.out(`    digest:          ${item.digest}`);
      io.out(`    revocations:     ${item.revocationDirectory}`);
    }
    if (report.supersededIdentities.length === 0) io.out('  superseded:        (none)');
    if (applied?.migrated) {
      io.out(`  migrated from:     ${report.migratedFrom?.identity ?? '(unknown)'}`);
      io.out(`  receipt:           ${applied.receiptPath}`);
    }
    for (const message of applied?.errors ?? []) io.err(message);
  }
  if (applied && !applied.ok) {
    io.err(applied.diagnostic?.code === 'activation.identity.conflict'
      ? 'Several operator activation keys claim this repository. Remove or rename every superseded key you do not want to keep, then rerun.'
      : 'The operator activation identity could not be migrated.');
    return 1;
  }
  return 0;
}

/**
 * The `activation` command family: status, revoke, provision-key,
 * identity-status, and migrate-identity.
 */
export async function cmdActivation(args, io = createIo()) {
  const sub = args[0];
  const spec = COMMAND_REGISTRY.activation.subcommands;
  if (!sub || !spec[sub]) {
    const suggestion = sub ? suggestName(sub, ACTIVATION_SUBCOMMANDS) : null;
    io.err(suggestion
      ? `activation: unknown subcommand '${sub}'. Did you mean '${suggestion}'?`
      : `activation requires a subcommand: ${ACTIVATION_SUBCOMMANDS.join(', ')}.`);
    io.err('Run "agenticloop help activation" for usage.');
    return EXIT_USAGE;
  }
  const { opts, positional } = parseCommandArgs(`activation ${sub}`, spec[sub], args.slice(1));
  const target = resolveCliTarget(io, opts.target);
  const asJson = Boolean(opts.json);
  const command = `activation ${sub}`;

  try {
    if (sub === 'identity-status' || sub === 'migrate-identity') {
      return runIdentityMigrationSubcommand(sub, { target, io, asJson, command });
    }

    if (sub === 'provision-key') {
      const provisioned = provisionOperatorActivationKey(target, {
        operatorActivationRoot: io.operatorActivationRoot ?? undefined,
      });
      if (!provisioned.ok) {
        throw new VerificationContextMalformedError(
          `Operator activation key could not be provisioned: ${provisioned.errors.join('; ')}` +
          (provisioned.diagnostic?.code === 'activation.identity.migration_required'
            ? ". Run 'npx agenticloop activation migrate-identity' to carry the existing operator identity forward."
            : '')
        );
      }
      const report = {
        command,
        created: provisioned.created,
        keyId: provisioned.key.keyId,
        path: provisioned.path,
        repositoryIdentity: provisioned.key.repositoryIdentity,
        ownerProtection: provisioned.ownerProtection,
        note: 'The private key is stored outside the target repository and is never written into it.',
      };
      if (asJson) io.out(JSON.stringify(report, null, 2));
      else {
        io.out(provisioned.created
          ? `Provisioned operator activation key ${provisioned.key.keyId}.`
          : `Operator activation key ${provisioned.key.keyId} already exists.`);
        io.out(`  path: ${provisioned.path}`);
        io.out(`  ${provisioned.ownerProtection?.limitation ?? ''}`);
      }
      return 0;
    }

    const projectConfig = resolveProjectConfig(target);
    const policy = resolveEffectiveActivationPolicy(target, io);
    const backendResolution = resolveTaskBackend(target);
    const backend = backendResolution.backend;
    const repositoryIdentity = targetRepositoryIdentity(target);

    if (sub === 'status') {
      const verification = resolveActivationVerification(target, io, { hostTrustStorePath: opts.hostTrustStore });
      const revocations = readActivationRevocations(target);
      const externalRevocations = readExternalActivationRevocations(target, {
        operatorActivationRoot: io.operatorActivationRoot ?? undefined,
      });
      const requestedTaskId = positional[0] ?? null;
      const listed = listTaskActivationBindings(target);
      const rows = [];
      for (const entry of listed.bindings) {
        const binding = entry.record;
        if (requestedTaskId && binding?.taskId !== requestedTaskId) continue;
        const grantRead = readActivationGrant(target, binding?.grantId);
        const grant = grantRead.state === 'present' ? grantRead.record : null;
        let current = null;
        let identityError = null;
        try {
          current = loadTaskIdentity(target, {
            backend: binding?.backend ?? backend,
            projectConfig,
            taskId: binding?.taskId,
            io,
            repo: opts.repo,
            githubSnapshot: githubSnapshotLoader(target, projectConfig, io, opts.repo),
          });
        } catch (error) {
          identityError = error.publicMessage ?? error.message;
        }
        const resolved = grant && current
          ? resolveTaskActivationBinding({
              grant,
              binding,
              repositoryIdentity,
              backend: current.backend,
              taskId: current.taskId,
              carrier: current.carrier,
              taskContractDigest: current.contractDigest,
              verifySignature: verification.verify,
              revocations: [
                ...(externalRevocations.ok ? externalRevocations.revocations : [{ malformedExternalRegistry: externalRevocations.errors }]),
                ...revocations.revocations,
              ],
              decomposition: binding?.derivation === 'committed_decomposition_membership'
                ? readCommittedDecomposition(target, binding?.decompositionSource?.sourceRef)
                : null,
            })
          : { ok: false, evidenceState: 'missing', disposition: 'needs_context', errors: [{ message: identityError ?? `activation grant '${String(binding?.grantId)}' is not present` }], assurance: null };
        rows.push({
          taskId: binding?.taskId ?? null,
          carrier: binding?.carrier ?? null,
          backend: binding?.backend ?? null,
          grantId: binding?.grantId ?? null,
          bindingId: binding?.bindingId ?? null,
          assurance: binding?.assurance ?? null,
          derivation: binding?.derivation ?? null,
          expiresAt: binding?.expiresAt ?? null,
          usable: resolved.ok,
          evidenceState: resolved.evidenceState,
          disposition: resolved.disposition,
          reasons: resolved.ok ? [] : resolved.errors.map(item => item.message),
        });
      }
      const report = {
        command,
        repositoryIdentity,
        backend,
        store: ACTIVATION_STORE_ROOT,
        operatorKey: {
          state: verification.operatorKeyState,
          keyId: verification.operatorKey?.keyId ?? null,
          path: verification.operatorKeyPath,
        },
        policy: {
          mode: policy.mode,
          source: policy.source,
          minimumActivation: policy.minimumActivation,
          minimumReturn: policy.minimumReturn,
          pinnedMode: policy.pinnedMode,
          requestedMode: policy.requestedMode,
        },
        revocationErrors: [...externalRevocations.errors, ...revocations.errors],
        bindings: rows,
      };
      if (asJson) {
        io.out(JSON.stringify(report, null, 2));
        return rows.length > 0 && rows.every(row => !row.usable) ? 1 : 0;
      }
      io.out(`Activation status for ${repositoryIdentity}`);
      io.out(`  mode: ${policy.mode} (policy source: ${policy.source})`);
      io.out(`  minimum activation: ${policy.minimumActivation}; minimum return: ${policy.minimumReturn}`);
      io.out(`  operator key: ${verification.operatorKeyState}${verification.operatorKey ? ` (${verification.operatorKey.keyId})` : ''}`);
      if (rows.length === 0) {
        io.out(requestedTaskId
          ? `  no activation binding for task '${requestedTaskId}'`
          : '  no activation bindings');
        return 0;
      }
      for (const row of rows) {
        io.out(`  ${row.taskId}  ${row.usable ? 'usable' : `unusable (${row.evidenceState})`}  ${row.assurance}  ${row.derivation}`);
        for (const reason of row.reasons) io.out(`      ${reason}`);
      }
      return rows.every(row => !row.usable) ? 1 : 0;
    }

    if (sub === 'revoke') {
      const grantId = positional[0];
      if (!grantId) throw new CliUsageError('activation revoke requires the exact grant id');
      const grantRead = readActivationGrant(target, grantId);
      if (!grantRead.ok) {
        throw new VerificationContextMalformedError(`Activation grant '${grantId}' is unreadable: ${grantRead.errors.join('; ')}`);
      }
      if (grantRead.state !== 'present') {
        throw new VerificationContextError(`Activation grant '${grantId}' is not present in this repository`);
      }
      const grant = grantRead.record;
      const shape = validateActivationGrantShape(grant);
      if (!shape.ok) {
        throw new VerificationContextMalformedError(`Activation grant '${grantId}' is malformed: ${shape.errors[0].message}`);
      }
      const revocation = createActivationRevocation({
        grant,
        reason: opts.reason ? String(opts.reason) : 'operator revocation',
      });
      const external = writeExternalActivationRevocation(target, revocation, {
        operatorActivationRoot: io.operatorActivationRoot ?? undefined,
      });
      if (!external.ok) {
        throw new VerificationContextMalformedError(
          `External activation revocation could not be established: ${external.errors.join('; ')}`
        );
      }
      const written = writeActivationRevocation(target, revocation);
      if (!written.ok) {
        const result = createValidationResult({
          command,
          ok: false,
          evidenceState: written.receipt.unresolved ? 'changed' : 'negative',
          disposition: written.receipt.unresolved ? 'superseded' : 'blocked',
          errors: written.receipt.errors,
          firstSafeRepair: written.receipt.recovery,
          receipt: written.receipt,
        });
        return printGateResult(command, result, asJson, io);
      }
      const report = {
        command,
        grantId,
        revocationId: revocation.revocationId,
        revokedAt: revocation.revokedAt,
        reason: revocation.reason,
        externalTombstone: external.path,
        receipt: written.receipt,
      };
      if (asJson) io.out(JSON.stringify(report, null, 2));
      else {
        io.out(`Revoked activation grant ${grantId} (${written.receipt.mutationDisposition}).`);
        io.out('  Every task binding derived from this grant is now refused by dispatch.');
      }
      return 0;
    }

    throw new CliUsageError(`activation: unknown subcommand '${sub}'`);
  } catch (error) {
    if (error instanceof CliUsageError) {
      return printGateResult(command, commandFailure(command, error, 'usage', {}, target), asJson, io, EXIT_USAGE);
    }
    return printGateResult(command, commandFailure(command, error, 'operational_error', {}, target), asJson, io);
  }
}

/** Read one committed decomposition source by its exact repository-relative path. */
function readCommittedDecomposition(target, sourceRef) {
  if (typeof sourceRef !== 'string' || !sourceRef) return null;
  const path = resolve(target, sourceRef);
  const root = resolve(target);
  if (path !== root && !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) return null;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export { readCommittedDecomposition };
