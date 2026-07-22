/**
 * Provider-free pinned-host smoke. It proves the generated plugin can load on
 * the selected OpenCode binary without granting broad permissions or invoking a
 * model. Provider execution is an explicit, disposable-fixture release gate.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { OPENCODE_SUPERVISION_PLUGIN_RELATIVE_PATH, renderOpencodeSupervisionPlugin } from '../src/adapters/opencode-supervision-plugin.js';
import { SUPPORTED_OPENCODE_VERSION_RANGE, isSupportedOpencodeVersion } from '../src/supervision/config.js';
import { buildProviderReport, validateProviderFixture } from '../src/supervision/provider-fixture.js';
import { runProviderScenario } from './provider-supervision-driver.js';

const isWindows = process.platform === 'win32';
const nodeWindowsShim = join(dirname(process.execPath), 'opencode.cmd');
const appDataWindowsShim = join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? 'C:\\Users\\User', 'AppData', 'Roaming'), 'npm', 'opencode.cmd');
const defaultWindowsShim = existsSync(nodeWindowsShim) ? nodeWindowsShim : appDataWindowsShim;
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? (isWindows ? defaultWindowsShim : 'opencode');
const OPENCODE_BIN_ARGS = process.env.OPENCODE_BIN_ARGS ? JSON.parse(process.env.OPENCODE_BIN_ARGS) : [];
if (!Array.isArray(OPENCODE_BIN_ARGS) || OPENCODE_BIN_ARGS.some(value => typeof value !== 'string' || /[\r\n&|<>^%!]/.test(value))) {
  throw new Error('OPENCODE_BIN_ARGS must be a JSON array of shell-safe command arguments');
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (/[\r\n&|<>^%!]/.test(text)) throw new Error('OpenCode executable or argument contains unsafe cmd.exe characters');
  return `"${text.replace(/(\\*)"/g, '$1$1\\"')}"`;
}

function spawnOpenCode(args, options) {
  if (!isWindows) return spawn(OPENCODE_BIN, [...OPENCODE_BIN_ARGS, ...args], options);
  const command = [OPENCODE_BIN, ...OPENCODE_BIN_ARGS, ...args].map(quoteWindowsArgument).join(' ');
  // `call` makes cmd.exe invoke the exact quoted .cmd shim instead of treating
  // its quoted path as a literal command string.
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `call ${command}`], { ...options, windowsVerbatimArguments: true });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise(resolvePromise => server.close(resolvePromise));
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited before health check (${child.exitCode}): ${child.supervisionStderr ?? ''}`);
    try {
      const response = await fetch(`${url}/global/health`);
      if (response.ok) return await response.json();
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`OpenCode health check timed out: ${lastError?.message ?? 'no response'}; ${child.supervisionStderr ?? ''}`);
}

async function terminateChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (isWindows) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await new Promise(resolvePromise => killer.once('exit', resolvePromise));
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null) throw new Error('owned OpenCode process did not exit after termination');
}

async function removeTemporaryProject(project) {
  await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function sanitizedProviderReport(project, values) {
  const reportPath = join(project, '.agenticloop', 'tmp', 'opencode-provider-smoke.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
  return reportPath;
}

const repositoryRoot = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const providerValidation = validateProviderFixture(process.env, { repoRoot: repositoryRoot });

const port = await freePort();
const temporaryProject = providerValidation.enabled ? null : mkdtempSync(join(tmpdir(), 'agenticloop-opencode-supervision-'));
// A provider-backed engineer must run in the disposable fixture it is expected
// to modify. Serving an unrelated temporary project would make real artifact
// production impossible and could be masked only by driver-side file writes.
const project = providerValidation.enabled ? providerValidation.fixture.target : temporaryProject;
const pluginPath = join(project, OPENCODE_SUPERVISION_PLUGIN_RELATIVE_PATH);
if (providerValidation.enabled && existsSync(pluginPath)) {
  throw new Error(`the disposable provider fixture already contains ${OPENCODE_SUPERVISION_PLUGIN_RELATIVE_PATH}; refusing to overwrite it`);
}
mkdirSync(dirname(pluginPath), { recursive: true });
writeFileSync(pluginPath, renderOpencodeSupervisionPlugin(), 'utf8');
const child = spawnOpenCode(['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
  cwd: project,
});
child.supervisionStderr = '';
child.stderr?.setEncoding('utf8');
child.stderr?.on('data', chunk => { child.supervisionStderr = `${child.supervisionStderr}${chunk}`.slice(-4000); });
let primaryError = null;
try {
  const health = await waitForHealth(`http://127.0.0.1:${port}`, child);
  if (!isSupportedOpencodeVersion(health.version)) throw new Error(`OpenCode ${health.version ?? 'unknown'} is outside supported range >=1.18.4 <1.19.0`);
  const sessions = await fetch(`http://127.0.0.1:${port}/session`);
  if (!sessions.ok) throw new Error(`session API returned ${sessions.status}`);
  const tools = await fetch(`http://127.0.0.1:${port}/experimental/tool/ids?directory=${encodeURIComponent(project)}`);
  if (!tools.ok) throw new Error(`tool registry API returned ${tools.status}`);
  const toolIds = await tools.json();
    const requiredTools = ['agenticloop_delegate', 'agenticloop_checkpoint'];
    const missingTools = requiredTools.filter(id => !Array.isArray(toolIds) || !toolIds.includes(id));
    if (missingTools.length) throw new Error(`generated supervision plugin loaded without registering: ${missingTools.join(', ')}`);
  console.log(`PASS OpenCode ${health.version} (${OPENCODE_BIN}) plugin load, server health, session API, and tool registration`);

  if (!providerValidation.enabled) {
    console.log(`SKIP provider-backed supervisor/recovery smoke: ${providerValidation.reason}`);
  } else {
    // The explicit disposable fixture is required rather than inferred from
    // ambient credentials. The driver runs the real scenario against this
    // pinned server; it never serializes credentials or model responses.
    const scenario = await runProviderScenario({
      fixture: providerValidation.fixture,
      serverUrl: `http://127.0.0.1:${port}`,
      opencodeVersion: health.version,
    });
    const report = buildProviderReport({
      fixture: providerValidation.fixture,
      host: { binary: OPENCODE_BIN, version: health.version, supported_range: SUPPORTED_OPENCODE_VERSION_RANGE },
      scenario: scenario.summary,
      steps: scenario.steps,
    });
    const reportPath = sanitizedProviderReport(providerValidation.fixture.target, report);
    const failed = scenario.steps.filter(step => !step.ok);
    if (failed.length) {
      throw new Error(`provider-backed supervision scenario failed at: ${failed.map(step => step.name).join(', ')}; sanitized report: ${reportPath}`);
    }
    console.log(`PASS provider-backed supervision scenario (${scenario.steps.length} steps); sanitized report: ${reportPath}`);
  }
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await terminateChild(child);
    if (temporaryProject) await removeTemporaryProject(temporaryProject);
    else await rm(pluginPath, { force: true });
  } catch (cleanupError) {
    if (primaryError) console.error(`cleanup warning after primary smoke failure: ${cleanupError.message}`);
    else throw cleanupError;
  }
}
