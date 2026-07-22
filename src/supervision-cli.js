import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SupervisionController, loadEnabledSupervisionConfig } from './supervision/controller.js';
import { callAuthenticatedIpc } from './supervision/ipc.js';
import { readCredential, readRunState, resolveSingleActiveRun } from './supervision/state.js';

function parseOptions(args) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === 'json' || key === 'confirm-always') {
      options[key] = true;
      continue;
    }
    const next = args[++index];
    if (!next || next.startsWith('--')) throw new Error(`--${key} requires a value`);
    options[key] = next;
  }
  return { positionals, options };
}

async function readSingleBootstrapLine() {
  const text = await readFile(0, 'utf8');
  const line = text.split(/\r?\n/, 1)[0];
  if (!line) throw new Error('supervision bootstrap was not provided on standard input');
  let bootstrap;
  try {
    bootstrap = JSON.parse(line);
  } catch {
    throw new Error('supervision bootstrap is not valid JSON');
  }
  if (!bootstrap || typeof bootstrap !== 'object') throw new Error('supervision bootstrap must be an object');
  return bootstrap;
}

export async function supervise(args) {
  const { options } = parseOptions(args);
  if (options.adapter !== 'opencode') throw new Error('supervise currently requires --adapter opencode');
  if (!options['bootstrap-stdin']) throw new Error('supervise is an internal bootstrap command and requires --bootstrap-stdin');
  const bootstrap = await readSingleBootstrapLine();
  const projectRoot = resolve(bootstrap.project_root ?? '');
  if (!bootstrap.credential || typeof bootstrap.credential !== 'string') throw new Error('supervision bootstrap has no credential');
  const config = loadEnabledSupervisionConfig(projectRoot);
  try {
    const activeRunId = resolveSingleActiveRun(projectRoot);
    const { state } = readRunState(projectRoot, activeRunId);
    const activeCredential = readCredential(projectRoot, activeRunId);
    const endpoint = state.controller.endpoint;
    if (endpoint?.host && Number.isInteger(endpoint.port)) {
      const status = await callAuthenticatedIpc(endpoint, {
        credential: activeCredential,
        project_root: projectRoot,
        run_id: activeRunId,
      }, 'operator.command', { principal: 'operator', command: 'status' }, 1000);
      if (status.ok && status.status.controller.status !== 'stopped') {
        process.stdout.write(`${JSON.stringify({ type: 'ready', reused: true, run_id: activeRunId, endpoint, credential: activeCredential })}\n`);
        return;
      }
    }
  } catch {
    // No live, authenticated controller was proven. Starting a fresh run will
    // still fail closed on an active or unverifiable ownership lock.
  }
  const controller = new SupervisionController({ projectRoot, config, credential: bootstrap.credential });
  const handshake = await controller.start();
  process.stdout.write(`${JSON.stringify({ type: 'ready', reused: false, run_id: handshake.run_id, endpoint: controller.ipc.endpoint, credential: bootstrap.credential })}\n`);

  const stop = async () => {
    await controller.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await controller.waitUntilClosed();
}

function mapCommand(positionals) {
  const [verb, ...rest] = positionals;
  if (!verb) throw new Error('supervision requires a command');
  if (verb === 'status') return { command: 'status' };
  if (verb === 'notifications') {
    if (rest[0] === 'ack') return { command: 'notifications', acknowledge: true, through_sequence: rest[1] === undefined ? null : Number(rest[1]) };
    return { command: 'notifications' };
  }
  if (verb === 'pause' || verb === 'resume' || verb === 'permissions' || verb === 'stop') return { command: verb };
  if (verb === 'ask') return { command: 'ask', question: rest.join(' ') };
  if (verb === 'explain' && rest[0] === 'last') return { command: 'explain_last' };
  if (verb === 'investigate') return { command: 'investigate', target: rest[0] };
  if (verb === 'cancel') return { command: 'cancel', target: rest[0] };
  if (verb === 'retry') return { command: 'retry', target: rest[0] };
  if (verb === 'replace-orchestrator') return { command: 'replace_orchestrator' };
  if (verb === 'permission') return { command: 'permission', request_id: rest[0], decision: rest[1] };
  if (verb === 'authorize') return { command: 'authorize', unit_id: rest[0], scope_ref: rest.slice(1).join(' ') };
  throw new Error(`unknown supervision command '${[verb, ...rest].join(' ')}'`);
}

export async function supervision(args, { stdout = process.stdout } = {}) {
  const { positionals, options } = parseOptions(args);
  const projectRoot = resolve(options.target ?? process.cwd());
  const runId = options.run ?? resolveSingleActiveRun(projectRoot);
  const { state } = readRunState(projectRoot, runId);
  const endpoint = state.controller.endpoint;
  if (!endpoint?.host || !Number.isInteger(endpoint.port)) throw new Error('supervision controller endpoint is unavailable from durable state');
  const credential = readCredential(projectRoot, runId);
  const command = mapCommand(positionals);
  if (command.command === 'permission' && command.decision === 'always') {
    command.confirm_always = options['confirm-always'] === true;
  }
  if (options.offset !== undefined || options.limit !== undefined) {
    const page = {
      offset: Number(options.offset ?? 0),
      limit: Number(options.limit ?? 50),
    };
    if (command.command === 'status') {
      command.page = {
        lanes: page,
        pending_permissions: page,
        decided_permissions: page,
        notifications: page,
        events: page,
      };
    } else if (command.command === 'permissions' || command.command === 'notifications') {
      command.page = page;
    }
  }
  const result = await callAuthenticatedIpc(endpoint, {
    credential,
    project_root: projectRoot,
    run_id: runId,
  }, 'operator.command', { principal: 'operator', ...command });
  if (options.json) stdout.write(`${JSON.stringify(result)}\n`);
  else if (command.command === 'status' && result.ok) stdout.write(formatStatus(result.status));
  else if (command.command === 'permissions' && result.ok) stdout.write(formatPermissions(result));
  else stdout.write(`Supervision ${command.command}: ${result.ok ? 'ok' : result.code ?? 'failed'}\n`);
  return result.ok ? 0 : 1;
}

function pageLine(label, collection) {
  const truncated = collection.truncated ? ` (truncated; next --offset ${collection.next_offset} --limit ${collection.limit ?? 50})` : '';
  return `${label}: ${collection.returned}/${collection.total}${truncated}\n`;
}

/**
 * Human-readable operator status. It never prints permission command text or
 * any other host-derived permission metadata; use `--json` for the full public
 * schema, which is already redacted by the kernel.
 */
export function formatStatus(status) {
  const lines = [];
  const controller = status.controller;
  lines.push(`Supervision ${controller.status} (${controller.mode}/${controller.adapter}) run ${controller.run_id}\n`);
  lines.push(status.authorization
    ? `Authorization: unit ${status.authorization.unit_id} scope ${status.authorization.scope_ref} by ${status.authorization.provenance}\n`
    : 'Authorization: none; observation only until a work unit is authorized\n');
  lines.push(`Server: ${status.server.status}   Bridge: ${status.bridge.status}\n`);
  lines.push(`Root: ${status.sessions.root ? `${status.sessions.root.id} gen ${status.sessions.root.session_generation} ${status.sessions.root.lifecycle}/${status.sessions.root.status}` : 'unregistered'}\n`);
  lines.push(`Supervisor: ${status.sessions.supervisor ? `${status.sessions.supervisor.id} gen ${status.sessions.supervisor.session_generation} ${status.sessions.supervisor.lifecycle}` : 'unregistered'}\n`);
  lines.push(pageLine('Lanes', status.collections.lanes));
  lines.push(pageLine('Pending permissions', status.collections.pending_permissions));

  const configured = status.budgets.configured;
  const used = status.budgets.used;
  const budgetParts = Object.entries(configured)
    .filter(([name, limit]) => Number.isInteger(limit) && limit > 0 && typeof used[name] === 'number')
    .map(([name, limit]) => `${name} ${used[name]}/${limit} (${Math.max(0, limit - used[name])} left)`);
  if (budgetParts.length) lines.push(`Budgets: ${budgetParts.join('; ')}\n`);
  const cost = status.budgets.cost;
  lines.push(`Cost: tracking ${cost.tracking}, enforcement ${cost.enforcement}, used ${cost.used}${cost.remaining === null ? '' : `/${cost.limit} (${cost.remaining} left)`}${cost.exhausted ? ', exhausted' : ''}\n`);
  lines.push(`Time: ${status.timing.active_minutes.toFixed(1)} active min, ${status.timing.absolute_age_minutes.toFixed(1)} absolute min, ${Math.round(status.timing.paused_ms / 60000)} paused min, ${Math.round(status.timing.permission_wait_ms / 60000)} permission-wait min, ${Math.round(status.timing.human_wait_ms / 60000)} operator-wait min\n`);
  lines.push(`Unsupported in attached mode: ${status.unsupported_capabilities.join(', ') || 'none'}\n`);
  lines.push(`Notifications: ${status.notification_summary.unread} unread / ${status.notification_summary.total} total (acknowledged through ${status.notification_summary.acknowledged_through})\n`);
  lines.push('Paging: add --offset and --limit to any collection command; `notifications ack [sequence]` records what you have read.\n');
  return lines.join('');
}

export function formatPermissions(result) {
  const lines = [pageLine('Pending permissions', result.collections.pending)];
  for (const permission of result.permissions) {
    lines.push(`  ${permission.id} ${permission.operation} lane=${permission.lane_id ?? '-'} authority=${permission.authority}${permission.metadata.sensitive_material_redacted ? ' [sensitive material withheld]' : ''}\n`);
  }
  lines.push(pageLine('Decided permissions', result.collections.decided));
  return lines.join('');
}
