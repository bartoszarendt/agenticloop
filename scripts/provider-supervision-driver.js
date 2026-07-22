/**
 * Provider-backed attached-supervision acceptance driver.
 *
 * This is the opt-in release gate. It runs the real scenario against a real
 * pinned OpenCode server inside an explicitly marked disposable fixture, using
 * the real controller, the real kernel, and a real supervisor model turn.
 *
 * What it deliberately does not do:
 *   - read, log, or serialize any credential value;
 *   - serialize any prompt, model response, or private reasoning;
 *   - touch anything outside the fixture target;
 *   - clean up any process or file it did not itself create.
 *
 * It also does not exercise the OpenCode TUI `command.execute.before` hook.
 * That path is proven by the provider-free plugin-load smoke; this driver
 * proves controller, supervisor, recovery, and reconciliation behaviour.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { SupervisionController } from '../src/supervision/controller.js';
import { normalizeOpenCodeSupervisorUsage } from '../src/adapters/opencode-supervision-plugin.js';
import { classifyOpencodeOutcome } from '../src/supervision/opencode-event-contract.js';
import { connectAuthenticatedIpc } from '../src/supervision/ipc.js';
import { DEFAULT_SUPERVISION_CONFIG } from '../src/supervision/config.js';
import { ATTACHED_BRIDGE_CAPABILITIES } from '../src/supervision/kernel.js';

const RECOVERABLE_OUTCOMES = new Set(['failed_transport', 'failed_context', 'failed_rate_limit', 'failed_quota', 'unknown']);
const PROVIDER_BRIDGE_CAPABILITIES = Object.freeze(Object.fromEntries(ATTACHED_BRIDGE_CAPABILITIES.map(name => [name, true])));
export const PROVIDER_ARTIFACT_RELATIVE_PATH = join('.agenticloop', 'tmp', 'provider-fixture-artifact.txt');

function step(name, detail = null) {
  return { name, ok: false, detail, duration_ms: null, startedAt: Date.now() };
}

function finish(entry, ok, detail = entry.detail) {
  entry.ok = ok;
  entry.detail = detail;
  entry.duration_ms = Date.now() - entry.startedAt;
  delete entry.startedAt;
  return entry;
}

async function api(serverUrl, path, { method = 'GET', body = null, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, serverUrl), {
      method,
      signal: controller.signal,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new Error(`OpenCode ${method} ${path} returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

function providerConfig(model) {
  const config = structuredClone(DEFAULT_SUPERVISION_CONFIG);
  config.enabled = true;
  config.supervisor.model = model;
  // One bounded assessment plus a small margin; the fixture must never be able
  // to loop the provider.
  config.budgets.supervisor_wakeups = 4;
  config.budgets.lane_infrastructure_retries = 1;
  config.budgets.active_minutes = 30;
  config.budgets.absolute_age_minutes = 30;
  return config;
}

/**
 * @param {{ fixture: any, serverUrl: string, opencodeVersion: string }} options
 */
export async function runProviderScenario({ fixture, serverUrl, opencodeVersion, request = api }) {
  const target = resolve(fixture.target);
  prepareFixtureWorkspace(target);
  const steps = [];
  const artifactPath = join(target, PROVIDER_ARTIFACT_RELATIVE_PATH);
  // The engineer is instructed to create this exact fixture-owned output. It
  // is registered for cleanup before any provider call so partial failures do
  // not strand it.
  const ownedFiles = [artifactPath];
  const ownedSessions = [];
  let controller = null;
  let bridge = null;

  const abortSession = async sessionId => {
    try {
      await request(serverUrl, `/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', body: {} });
    } catch {
      // Cleanup must never mask the scenario result.
    }
  };

  try {
    // 1. Controller startup with exact root and supervisor registration.
    const startup = step('controller_startup_and_registration');
    steps.push(startup);
    const rootSession = await request(serverUrl, '/session', { method: 'POST', body: { title: 'Agentic Loop provider fixture root' } });
    const rootSessionId = rootSession?.id ?? rootSession?.data?.id;
    if (!rootSessionId) throw new Error('OpenCode did not return a root session id');
    ownedSessions.push(rootSessionId);

    controller = new SupervisionController({ projectRoot: target, config: providerConfig(fixture.model) });
    await controller.start();

    bridge = await connectAuthenticatedIpc(controller.ipc.endpoint, controller.auth(), async (method, params) => {
      if (method === 'host.supervisor.create') {
        const created = await request(serverUrl, '/session', { method: 'POST', body: { title: 'Agentic Loop provider fixture supervisor' } });
        const id = created?.id ?? created?.data?.id;
        if (!id) throw new Error('OpenCode did not create a supervisor session');
        ownedSessions.push(id);
        return { session_id: id };
      }
      if (method === 'host.supervisor.assess') {
        const [providerID, ...modelParts] = fixture.model.split('/');
        const result = await request(serverUrl, `/session/${encodeURIComponent(params.session_id)}/message`, {
          method: 'POST',
          timeoutMs: fixture.timeout_ms,
          body: {
            model: { providerID, modelID: modelParts.join('/') },
            parts: [{
              type: 'text',
              text: 'Return one compact JSON object only, with action, target, rationale, and evidence_refs. '
                + 'The action_context is immutable: copy its exact target without substitution. '
                + `Allowed actions: ${JSON.stringify(params.allowed_actions)}. `
                + `Action context: ${JSON.stringify(params.action_context)}. `
                + `Question: ${params.question}\nState: ${JSON.stringify(params.state)}`,
            }],
          },
        });
        const payload = result?.data ?? result;
        const parts = Array.isArray(payload?.parts) ? payload.parts : [];
        // Only the parsed structured disposition leaves this closure; the raw
        // response text is never stored or reported.
        return {
          disposition: parts.filter(part => part.type === 'text').map(part => part.text).join('\n').trim(),
          usage: normalizeOpenCodeSupervisorUsage(payload),
        };
      }
      if (method === 'host.session.abort') {
        await request(serverUrl, `/session/${encodeURIComponent(params.session_id)}/abort`, { method: 'POST', body: {} });
        return { aborted: true };
      }
      if (method === 'host.lane.create') {
        const created = await request(serverUrl, '/session', { method: 'POST', body: { parentID: rootSessionId, title: `Agentic Loop provider fixture recovery ${params.lane.id}` } });
        const id = created?.id ?? created?.data?.id;
        if (!id) throw new Error('OpenCode did not create a recovery lane session');
        ownedSessions.push(id);
        return { session_id: id };
      }
      if (method === 'host.lane.start') {
        // Generation 2 must genuinely invoke an engineer model. The driver is
        // prohibited from writing the expected artifact itself.
        const [providerID, ...modelParts] = fixture.model.split('/');
        await request(serverUrl, `/session/${encodeURIComponent(params.lane.session_id)}/message`, {
          method: 'POST',
          timeoutMs: fixture.timeout_ms,
          body: {
            agent: 'build',
            model: { providerID, modelID: modelParts.join('/') },
            parts: [{
              type: 'text',
              text: 'Act as the delegated engineer for this disposable acceptance fixture. '
                + `Create exactly ${PROVIDER_ARTIFACT_RELATIVE_PATH.replace(/\\/g, '/')} with the exact UTF-8 text `
                + '"agenticloop provider fixture artifact\\n". Verify the file exists, then return a concise completion message. '
                + 'Do not create or modify anything else.',
            }],
          },
        });
        return { started: true, provider_invoked: true };
      }
      if (method === 'host.reconcile') return { root_session_id: rootSessionId, registered_session_count: ownedSessions.length };
      if (method === 'host.notification') return { delivered: false, reason: 'no TUI in the provider fixture driver' };
      throw new Error(`unsupported provider fixture host request: ${method}`);
    });

    await bridge.call('bridge.connect', { server_identity: serverUrl, server_url: serverUrl, capabilities: PROVIDER_BRIDGE_CAPABILITIES });
    const handshake = await bridge.call('bootstrap', {
      adapter: 'opencode',
      mode: 'attached',
      project_root: target,
      root_session_id: rootSessionId,
      opencode_version: opencodeVersion,
      server_identity: serverUrl,
    });
    if (handshake?.minimum_capability_verdict !== 'supported') throw new Error('attached minimum capability was not proven');
    finish(startup, true, {
      root_session_registered: Boolean(controller.kernel.state.sessions.root),
      supervisor_session_registered: Boolean(controller.kernel.state.sessions.supervisor),
      root_generation: controller.kernel.state.sessions.root?.session_generation ?? null,
    });

    // 2. Explicit work-unit authorization.
    const authorization = step('explicit_work_unit_authorization');
    steps.push(authorization);
    await bridge.call('operator.command', { principal: 'operator', command: 'authorize', unit_id: 'U-PROVIDER', scope_ref: 'task-file:T-PROVIDER' });
    finish(authorization, controller.kernel.state.authorization?.unit_id === 'U-PROVIDER', {
      unit_id: controller.kernel.state.authorization?.unit_id ?? null,
      generation: controller.kernel.state.authorization?.generation ?? null,
    });

    // 3. Real delegated engineer lane registration.
    const registration = step('delegated_engineer_lane_registration');
    steps.push(registration);
    const laneSession = await request(serverUrl, '/session', { method: 'POST', body: { parentID: rootSessionId, title: 'Agentic Loop provider fixture engineer lane' } });
    const laneSessionId = laneSession?.id ?? laneSession?.data?.id;
    if (!laneSessionId) throw new Error('OpenCode did not create the delegated lane session');
    ownedSessions.push(laneSessionId);
    await bridge.call('lane.prepare', {
      envelope: {
        lane_id: 'lane-provider',
        role: 'engineer',
        task_ref: 'T-PROVIDER',
        expected_artifact: `file:${PROVIDER_ARTIFACT_RELATIVE_PATH}`,
        authorized_unit_id: 'U-PROVIDER',
        scope_ref: 'task-file:T-PROVIDER',
        lease: { no_progress_minutes: 5 },
      },
    });
    await bridge.call('lane.bind', { lane_id: 'lane-provider', session_id: laneSessionId });
    const boundLane = controller.kernel.findLane('lane-provider');
    const initialGeneration = boundLane.session_generation;
    finish(registration, boundLane.session_id === laneSessionId, {
      lane_id: boundLane.id, session_generation: boundLane.session_generation, route: boundLane.route, lease_ms: boundLane.lease?.no_progress_ms ?? null,
    });

    // 4. Prove generation 1 can execute on the selected provider, then abort
    //    its exact host session and inject a labelled recoverable transport
    //    fault. Fault injection is explicit; it is never presented as a native
    //    OpenCode transport event.
    const failure = step('verified_session_loss_and_recoverable_classification');
    steps.push(failure);
    const [engineerProviderID, ...engineerModelParts] = fixture.model.split('/');
    await request(serverUrl, `/session/${encodeURIComponent(laneSessionId)}/message`, {
      method: 'POST', timeoutMs: fixture.timeout_ms,
      body: {
        agent: 'build',
        model: { providerID: engineerProviderID, modelID: engineerModelParts.join('/') },
        parts: [{ type: 'text', text: 'This is a disposable supervision fixture readiness turn. Reply with READY only and do not modify files.' }],
      },
    });
    await request(serverUrl, `/session/${encodeURIComponent(laneSessionId)}/abort`, { method: 'POST', body: {} });
    const hostErrorPayload = { code: 'network_error', reason: 'fixture-injected after verified exact-session abort' };
    const classification = classifyOpencodeOutcome(hostErrorPayload);
    if (!RECOVERABLE_OUTCOMES.has(classification.outcome)) {
      finish(failure, false, { classified_outcome: classification.outcome, classification_source: classification.classification_source, reason: 'host failure was not classified as recoverable; the scenario refuses to force an outcome' });
      throw new Error(`host failure classified as ${classification.outcome}, which is not a recoverable outcome`);
    }
    await bridge.call('host.outcome', { target: laneSessionId, outcome: classification.outcome, metadata: { session_id: laneSessionId, classification_source: classification.classification_source } });
    finish(failure, true, {
      classified_outcome: classification.outcome,
      classification_source: classification.classification_source,
      provenance: 'fixture-injected-after-verified-session-abort',
      aborted_session_id: laneSessionId,
    });

    // 5-7. A real supervisor assessment, a fresh lane generation, and positive
    //      artifact reconciliation.
    const assessment = step('supervisor_assessment_and_fresh_generation');
    steps.push(assessment);
    await controller.wakeChain;
    const recovered = controller.kernel.findLane('lane-provider');
    const disposition = controller.kernel.state.last_disposition;
    finish(assessment, Boolean(disposition) && recovered.session_generation > initialGeneration, {
      action: disposition?.action ?? null,
      action_context_id: disposition?.action_context_id ?? null,
      previous_generation: initialGeneration,
      current_generation: recovered.session_generation,
      current_session_id: recovered.session_id,
    });

    const reconciliation = step('expected_artifact_reconciliation');
    steps.push(reconciliation);
    const present = existsSync(artifactPath);
    await bridge.call('host.outcome', {
      target: recovered.session_id,
      outcome: 'completed',
      metadata: { session_id: recovered.session_id, reconciliation: { verified: present, present, kind: 'file', reference: PROVIDER_ARTIFACT_RELATIVE_PATH } },
    });
    const reconciled = controller.kernel.findLane('lane-provider');
    finish(reconciliation, reconciled.artifact_valid === true, {
      artifact_valid: reconciled.artifact_valid, artifact_reference: reconciled.reconciliation?.reference ?? null, kind: reconciled.reconciliation?.kind ?? null,
    });

    // 8. Budget and event updates.
    const accounting = step('budget_and_event_accounting');
    steps.push(accounting);
    const status = controller.kernel.status();
    finish(accounting, status.budgets.used.supervisor_wakeups > 0
      && status.recent_events.length > 0
      && status.budgets.cost.tracking === 'host-reported', {
      supervisor_wakeups: status.budgets.used.supervisor_wakeups,
      lane_infrastructure_retries: status.budgets.used.lane_infrastructure_retries,
      cost: status.budgets.cost,
      recorded_event_types: [...new Set(status.recent_events.map(event => event.type))],
      active_minutes: status.timing.active_minutes,
    });

    // 9. Exact stop and cleanup.
    const shutdown = step('exact_stop_and_cleanup');
    steps.push(shutdown);
    await bridge.call('operator.command', { principal: 'operator', command: 'stop' });
    await Promise.race([controller.waitUntilClosed(), new Promise(resolvePromise => setTimeout(resolvePromise, 5_000))]);
    finish(shutdown, controller.kernel.state.controller.status === 'stopped', { controller_status: controller.kernel.state.controller.status });

    return {
      summary: {
        target: target,
        opencode_version: opencodeVersion,
        owned_session_count: ownedSessions.length,
        owned_file_count: ownedFiles.length,
      },
      steps,
    };
  } finally {
    try { bridge?.close(); } catch { /* closing a dead peer is not a failure */ }
    if (controller && !controller.closed) await controller.close();
    // Only exactly what this fixture created is removed.
    for (const sessionId of ownedSessions) await abortSession(sessionId);
    for (const file of ownedFiles) {
      if (file.startsWith(target) && !relative(target, file).startsWith('..')) rmSync(file, { force: true });
    }
  }
}

// Ensure the artifact directory exists inside the fixture before the driver runs.
export function prepareFixtureWorkspace(target) {
  mkdirSync(dirname(join(resolve(target), PROVIDER_ARTIFACT_RELATIVE_PATH)), { recursive: true });
}
