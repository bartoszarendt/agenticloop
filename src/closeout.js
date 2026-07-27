/**
 * Backend-neutral composite closeout evaluation and marker publication.
 *
 * `closeout prepare` composes the public `audit gate` evaluator with task,
 * backend, candidate, finding-disposition, marker, and plan-sync checks into
 * one versioned packet. `closeout record --yes` revalidates live state and
 * publishes exactly one current marker through the configured backend. The
 * packet under `.agenticloop/tmp/` is transient transport: provenance is the
 * canonical digest projection, reconstructable from durable and live state
 * after the packet is deleted.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  closeoutPacketDigest,
  closeoutProvenanceProjection,
  parseCloseoutMarkers,
  renderCloseoutMarker,
  resolveCurrentCloseoutMarkers,
  validateCloseoutPacket,
  workflowRecordSubstance,
  CLOSEOUT_PACKET_SCHEMA_VERSION,
} from './closeout-contract.js';
import { compareCertifiedProductTree, resolveCandidateArtifact } from './candidate.js';
import {
  auditBudgetState,
  certificationStatus,
  evaluateAuditCloseoutGate,
  findAuditRecord,
  findingDispositionState,
  listAuditRecordFiles,
  normalizeCoveredTasks,
  parseAuditRecord,
  parseWorkUnitIdentity,
  validateAuditRecord,
} from './audit-record.js';
import { parseFrontmatter } from './frontmatter.js';
import { markdownSection } from './markdown.js';
import {
  PROJECT_MAP_DEFAULTS,
  resolveWorkUnitAudit,
} from './project-map.js';
import { resolveCoveredGitHubTask } from './github-task-identity.js';
import { evaluatePullRequestLifecycle } from './closeout-github.js';
import { validateEvent, DEFAULT_LOG_DIR } from './event-logging.js';
import {
  IMPROVEMENT_ID_PATTERN,
  IMPROVEMENTS_DIRECTORY_RELATIVE_PATH,
  parseImprovementProposal,
  validateImprovementProposal,
} from './improvement.js';

/** Applicable closeout/work-unit event log for one covered task (files backend). */
function eventLogRelPath(taskId) {
  return `${DEFAULT_LOG_DIR}/${String(taskId ?? '').trim()}.jsonl`.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Reason model
// ---------------------------------------------------------------------------

/**
 * Non-complete reason categories drive deterministic status precedence:
 * `blocked` (exhausted authority or hard workflow bound), then
 * `needs_context` (required human-supplied boundary or evidence that cannot
 * be derived), then `follow_up_required` (actionable remediation or
 * disposition work).
 */
const REASON_CATEGORY_STATUS = Object.freeze({
  audit_blocked: 'blocked',
  marker_contradictory: 'blocked',
  audit_awaiting_human: 'needs_context',
  membership_underivable: 'needs_context',
  candidate_unverifiable: 'needs_context',
  plan_sync_missing: 'needs_context',
  improvement_ref: 'needs_context',
  candidate_missing: 'follow_up_required',
  audit_missing: 'follow_up_required',
  audit_invalid: 'follow_up_required',
  audit_not_current: 'follow_up_required',
  covered_task: 'follow_up_required',
  pr_lifecycle: 'follow_up_required',
  product_drift: 'follow_up_required',
  undisposed_findings: 'follow_up_required',
  plan_sync: 'follow_up_required',
  marker_correction: 'follow_up_required',
  inventory_incomplete: 'follow_up_required',
  identity_conflict: 'follow_up_required',
});

function reason(gate, category, message, options = {}) {
  return {
    gate,
    category,
    message,
    owner: options.owner ?? 'maintainer',
    repair: options.repair ?? null,
  };
}

/**
 * Deterministic marker-status precedence over a reason set.
 *
 * @param {object[]} reasons
 * @returns {'complete'|'blocked'|'needs_context'|'follow_up_required'}
 */
export function recommendedStatusForReasons(reasons) {
  if (!reasons || reasons.length === 0) return 'complete';
  const statuses = new Set(reasons.map(item => REASON_CATEGORY_STATUS[item.category] ?? 'follow_up_required'));
  if (statuses.has('blocked')) return 'blocked';
  if (statuses.has('needs_context')) return 'needs_context';
  return 'follow_up_required';
}

/**
 * Finalize every derived packet field in one place. Callers supply only observed
 * facts, gates, and structured reasons; no caller may independently choose a
 * publishability, completion, or recommendation result.
 */
export function finalizeCloseoutPacket(packet, reasons, markerResolution) {
  const gates = Array.isArray(packet.gates) ? packet.gates : [];
  const failedGates = gates.filter(gate => gate?.passed !== true);
  for (const gate of failedGates) {
    if (!reasons.some(item => item.gate === gate.id)) {
      reasons.push(reason(gate.id, 'membership_underivable',
        `closeout gate '${gate.id}' did not pass and supplied no evaluable reason`));
    }
  }
  const recommendedStatus = recommendedStatusForReasons(reasons);
  const candidatePresent = Boolean(String(packet.candidate_artifact ?? '').trim());
  const markerResolvable = !markerResolution?.error;
  const completionEligible =
    candidatePresent &&
    failedGates.length === 0 &&
    markerResolvable &&
    reasons.length === 0 &&
    recommendedStatus === 'complete';
  const currentMarker = markerResolution?.current?.length === 1
    ? markerResolution.current[0]
    : null;
  const markerAction = completionEligible
    ? 'record'
    : currentMarker && markerResolvable && recommendedStatus !== 'complete'
      ? 'correct'
      : 'none';
  const publishable = completionEligible || markerAction === 'correct';
  const finalized = {
    ...packet,
    marker_action: markerAction,
    publishable,
    completion_eligible: completionEligible,
    recommended_status: recommendedStatus,
    reasons: reasons.map(item => ({
      gate: item.gate,
      category: item.category,
      message: item.message,
      owner: item.owner,
      repair: item.repair,
    })),
  };
  finalized.digest = closeoutPacketDigest(finalized);
  return { packet: finalized, contractErrors: validateCloseoutPacket(finalized) };
}

// ---------------------------------------------------------------------------
// Files-backend task and carrier access
// ---------------------------------------------------------------------------

function filesTaskPath(target, config, taskId) {
  const template = String(config?.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template)
    .replace(/\\/g, '/');
  if (!template.includes('{taskId}')) return null;
  const root = resolve(target);
  const file = resolve(root, template.replaceAll('{taskId}', taskId));
  if (file !== root && !file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`)) return null;
  return file;
}

function filesTaskRelPath(config, taskId) {
  const template = String(config?.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template)
    .replace(/\\/g, '/');
  return template.includes('{taskId}') ? template.replaceAll('{taskId}', taskId) : null;
}

export function filesTaskInfo(target, config, taskId) {
  const file = filesTaskPath(target, config, taskId);
  if (!file || !existsSync(file)) return { exists: false, status: '', relPath: filesTaskRelPath(config, taskId) };
  const [frontmatter] = parseFrontmatter(readFileSync(file, 'utf-8'));
  return {
    exists: true,
    status: String(frontmatter?.status ?? '').trim(),
    relPath: filesTaskRelPath(config, taskId),
  };
}

/**
 * Derive files-backend work-unit membership deterministically: a task belongs
 * to the work unit when its `## Grouping` section names the canonical
 * identity token (for example `phase:4`). Flat projects have no derivable
 * membership and must name covered tasks explicitly.
 *
 * @param {string} target
 * @param {object} config
 * @param {string} workUnit
 * @returns {string[]|null}  null when membership cannot be derived.
 */
export function deriveFilesWorkUnitTasks(target, config, workUnit) {
  const identity = parseWorkUnitIdentity(workUnit);
  if (!identity.ok) return null;
  const profile = String(config?.grouping_profile ?? 'flat');
  if (identity.kind === 'work-unit' || profile === 'flat' || identity.kind !== profile) {
    return null;
  }
  const tasksDir = join(target, '.agenticloop', 'tasks');
  if (!existsSync(tasksDir) || !statSync(tasksDir).isDirectory()) return [];
  const members = [];
  for (const name of readdirSync(tasksDir).filter(item => item.endsWith('.md')).sort()) {
    const content = readFileSync(join(tasksDir, name), 'utf-8');
    const [frontmatter] = parseFrontmatter(content);
    const taskId = String(frontmatter?.task_id ?? '').trim() || name.replace(/\.md$/, '');
    const grouping = markdownSection(content, '## Grouping')?.body ?? '';
    const tokens = grouping.split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
    if (tokens.includes(identity.canonical)) {
      members.push(taskId);
    }
  }
  return members.sort();
}

// ---------------------------------------------------------------------------
// Closeout marker carrier
// ---------------------------------------------------------------------------

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * The files-backend marker carrier is the last covered task record (canonical
 * id order). The marker block lives in its `## Comments` section.
 *
 * @param {string} target
 * @param {object} config
 * @param {string[]} coveredTasks
 * @returns {{ kind: string, reference: string, revision: string, taskId: string, relPath: string, content: string }|null}
 */
export function readFilesCloseoutCarrier(target, config, coveredTasks) {
  const ordered = normalizeCoveredTasks(coveredTasks);
  if (ordered.length === 0) return null;
  const taskId = ordered[ordered.length - 1];
  const relPath = filesTaskRelPath(config, taskId);
  const file = filesTaskPath(target, config, taskId);
  if (!file || !existsSync(file)) return null;
  const content = readFileSync(file, 'utf-8');
  return {
    kind: 'files_task_record',
    reference: relPath,
    // The revision is marker- and status-normalized: publishing a marker or
    // performing the one permitted accepted->closed terminal transition never
    // changes it, but any other substantive carrier edit does.
    revision: `sha256:${sha256Text(workflowRecordSubstance(content))}`,
    taskId,
    relPath,
    content,
  };
}

/**
 * Replace the current closeout marker block inside one task record's
 * `## Comments` section. The prior marker stays recognizable as history: a
 * superseding marker carries `AGENT_CLOSEOUT_SUPERSEDES`, and a dated
 * correction reference is appended.
 *
 * @param {string} content       Full task record content.
 * @param {string} markerBlock   Rendered marker lines.
 * @param {{ priorMarkers?: object[], note?: string }} [options]
 * @returns {string}
 */
export function upsertCloseoutMarkerInTaskRecord(content, markerBlock, options = {}) {
  const commentsHeading = '## Comments';
  const section = markdownSection(content, commentsHeading);
  const date = new Date().toISOString().slice(0, 10);
  const lines = [markerBlock];
  if (options.note) {
    lines.push('', `- ${date}: ${options.note}`);
  } else if ((options.priorMarkers ?? []).length > 0) {
    lines.push('', `- ${date}: closeout marker corrected; the superseded marker above is retained as history.`);
  }
  const addition = lines.join('\n');
  if (!section) {
    const base = content.replace(/\s*$/, '\n');
    return `${base}\n${commentsHeading}\n\n${addition}\n`;
  }
  const body = section.body.trim();
  const newBody = body ? `${body}\n\n${addition}` : addition;
  const contentLines = content.split('\n');
  const before = contentLines.slice(0, section.startLine);
  const after = contentLines.slice(section.endLine);
  return [...before, ...newBody.split('\n'), ...after].join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Mechanical plan synchronization
// ---------------------------------------------------------------------------

const PLAN_SYNC_DISPOSITIONS = ['none', 'not_required', 'synced', 'skipped'];
const PLAN_OPEN_STATUSES = new Set(['planned', 'in-progress', 'in_progress']);
const PLAN_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Parse a plan-sync value into its disposition and optional bound revision.
 * The packet and marker carry `synced@sha256:<hash>` for a verified
 * synchronization; every other disposition stands alone.
 *
 * @param {string} value
 * @returns {{ disposition: string, revision: string|null }}
 */
export function parsePlanSyncValue(value) {
  const raw = String(value ?? '').trim() || 'none';
  const [disposition, revision] = raw.split('@');
  if (!PLAN_SYNC_DISPOSITIONS.includes(disposition)) {
    return { disposition: 'none', revision: null };
  }
  return {
    disposition,
    revision: revision && PLAN_REVISION_PATTERN.test(revision) ? revision : null,
  };
}

/** The configured source plan (`documents.plan`), including missing paths. */
function selectedPlanPath(_target, config) {
  const planPath = String(config?.documents?.plan ?? '').trim();
  return planPath;
}

/**
 * Parse the first Markdown task table carrying a `Status` column. Unrelated
 * tables may precede it; each contiguous Markdown table is inspected in turn.
 *
 * @param {string} content
 * @returns {{ statusIndex: number, rows: string[][] }|null}
 */
function parsePlanTaskTable(content) {
  const tables = [];
  let current = [];
  for (const line of [...String(content ?? '').split(/\r?\n/), '']) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|')) {
      const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim());
      if (cells.length >= 2) current.push(cells);
      continue;
    }
    if (current.length > 0) {
      tables.push(current);
      current = [];
    }
  }
  for (const table of tables) {
    if (table.length < 2) continue;
    const statusIndex = table[0].findIndex(cell => /^status$/i.test(cell));
    if (statusIndex === -1) continue;
    if (!table[1].every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    return { statusIndex, rows: table.slice(2) };
  }
  return null;
}

/**
 * Mechanically verify a `synced` plan-sync claim: the plan exists, its exact
 * content revision is bound, and every plan task-table row naming a covered
 * task is past `planned`/`in-progress`. A plan whose format cannot be
 * verified fails visibly rather than accepting a caller assertion.
 *
 * @param {string} target
 * @param {{ planRef: string, coveredTasks: string[] }} params
 * @returns {{ ok: boolean, revision?: string, error?: string, repair?: string }}
 */
export function verifyPlanSynchronization(target, params) {
  const planRef = String(params?.planRef ?? '').trim();
  if (!planRef) {
    return { ok: false, error: 'plan-sync synced requires an exact plan reference (--plan-ref or documents.plan)' };
  }
  const targetRoot = resolve(target);
  const file = resolve(targetRoot, planRef);
  const relativePlan = relative(targetRoot, file);
  if (!relativePlan || relativePlan === '..' || relativePlan.startsWith(`..${sep}`) || isAbsolute(relativePlan)) {
    return {
      ok: false,
      error: `plan-sync plan '${planRef}' resolves outside the target repository`,
      repair: 'select a plan file inside the target repository',
    };
  }
  if (!existsSync(file)) {
    return {
      ok: false,
      error: `plan-sync synced cites missing plan '${planRef}'`,
      repair: 'synchronize the selected plan first, or record --plan-sync not_required when no plan update applies',
    };
  }
  const content = readFileSync(file, 'utf-8');
  const revision = `sha256:${sha256Text(content)}`;
  const table = parsePlanTaskTable(content);
  if (!table) {
    return {
      ok: false,
      error: `plan '${planRef}' has no recognizable task table with a Status column; plan synchronization cannot be verified mechanically`,
      repair: 'record --plan-sync not_required with maintainer rationale, or add a verifiable task table to the plan',
    };
  }
  const covered = new Set(normalizeCoveredTasks(params?.coveredTasks ?? []));
  const openItems = [];
  let matched = 0;
  for (const row of table.rows) {
    if (!row.some(cell => covered.has(cell))) continue;
    matched += 1;
    const status = String(row[table.statusIndex] ?? '').trim().toLowerCase();
    if (PLAN_OPEN_STATUSES.has(status)) {
      openItems.push(`${row.find(cell => covered.has(cell))} [${status}]`);
    }
  }
  if (covered.size > 0 && matched === 0) {
    return {
      ok: false,
      error: `plan '${planRef}' task table does not cover ${[...covered].join(', ')}; the plan is internally incomplete for this work unit`,
      repair: 'add the covered work items to the plan task table, or record --plan-sync not_required',
    };
  }
  if (openItems.length > 0) {
    return {
      ok: false,
      error: `plan '${planRef}' still marks covered work items as open: ${openItems.join(', ')}`,
      repair: 'complete the conditional source-plan synchronization before candidate freeze, then re-run closeout prepare',
    };
  }
  return { ok: true, revision };
}

// ---------------------------------------------------------------------------
// Composite evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the composite closeout gate for one work unit. Read-only: this
 * function never mutates the target or any backend.
 *
 * @param {string} target
 * @param {object} params
 * @param {string} params.workUnit
 * @param {string} [params.artifact]        Candidate override (defaults to the certified candidate).
 * @param {string[]} [params.coveredTasks]  Explicit boundary (required for flat projects without an audit record).
 * @param {string} [params.planSync]        Plan-sync disposition: none, not_required, synced, skipped.
 * @param {string[]} [params.improvementRefs]
 * @param {object} params.config            Merged project-map config.
 * @param {'files'|'github'} [params.backend]
 * @param {object} [params.inventory]       GitHub inventory snapshot (buildGitHubTaskIdentityInventory).
 * @param {Function} [params.gitRunner]
 * @param {object} [params.validationOptions] taskIdRegex/taskExists/decisionAccepted overrides.
 * @returns {{ packet: object, reasons: object[], gates: object[], markerState: object }}
 */
export function evaluateCloseout(target, params) {
  const config = params?.config ?? PROJECT_MAP_DEFAULTS;
  const backend = params?.backend === 'github' ? 'github' : 'files';
  const gates = [];
  const reasons = [];
  const gate = (id, passed) => gates.push({ id, passed: passed === true });

  // --- work-unit identity -------------------------------------------------
  const identity = parseWorkUnitIdentity(params?.workUnit);
  gate('work_unit_identity', identity.ok);
  if (!identity.ok) {
    reasons.push(reason('work_unit_identity', 'membership_underivable',
      `closeout requires a canonical work-unit identity: ${identity.error}`,
      { repair: 'pass --work-unit <kind>:<id> (phase:4, milestone:M2, epic:x, custom:x, work-unit:x)' }));
  }
  const workUnit = identity.ok ? identity.canonical : String(params?.workUnit ?? '');

  // --- audit gate (the public audit-only subset evaluator) -----------------
  const workUnitAudit = resolveWorkUnitAudit(config);
  const auditGate = evaluateAuditCloseoutGate(target, {
    workUnit,
    workUnitAudit,
    taskIdRegex: params?.validationOptions?.taskIdRegex ?? config.task_id_regex,
    taskExists: params?.validationOptions?.taskExists,
    decisionAccepted: params?.validationOptions?.decisionAccepted,
    ...(backend === 'files'
      ? { taskStatus: taskId => filesTaskInfo(target, config, taskId).status }
      : {}),
  });
  gate('audit_gate', auditGate.allowed);
  const auditEntry = auditGate.auditId ? findAuditRecord(target, auditGate.auditId) : null;
  const auditRecord = auditEntry?.record ?? null;
  if (!auditGate.allowed) {
    const category = auditGate.state === 'audit_blocked'
      ? 'audit_blocked'
      : auditGate.state === 'audit_awaiting_human'
        ? 'audit_awaiting_human'
        : auditGate.state;
    for (const message of auditGate.reasons) {
      reasons.push(reason('audit_gate', category, message, {
        repair: auditGate.state === 'audit_missing'
          ? `agenticloop audit new --work-unit ${workUnit} --covered-tasks <ids> --artifact commit:<full-sha> --goal "<outcome>" --completion-oracle "<observable completion>" --evidence "<checks>"`
          : null,
      }));
    }
  }

  // --- covered tasks --------------------------------------------------------
  let coveredTasks = auditRecord ? normalizeCoveredTasks(auditRecord.coveredTasks) : [];
  if (coveredTasks.length === 0 && Array.isArray(params?.coveredTasks) && params.coveredTasks.length > 0) {
    coveredTasks = normalizeCoveredTasks(params.coveredTasks);
  }
  if (coveredTasks.length === 0 && backend === 'files') {
    const derived = deriveFilesWorkUnitTasks(target, config, workUnit);
    if (derived && derived.length > 0) coveredTasks = derived;
  }
  if (coveredTasks.length === 0) {
    gate('covered_tasks', false);
    reasons.push(reason('covered_tasks', 'membership_underivable',
      `covered-task membership for '${workUnit}' cannot be derived; name the exact boundary`,
      { repair: `agenticloop audit new --work-unit ${workUnit} --covered-tasks <ids> ... (or rerun closeout prepare with explicit covered tasks)` }));
  } else {
    let tasksOk = true;
    for (const taskId of coveredTasks) {
      if (backend === 'github') {
        const resolved = resolveCoveredGitHubTask(params?.inventory, taskId);
        if (resolved.error === 'inventory_incomplete') {
          tasksOk = false;
          reasons.push(reason('covered_tasks', 'inventory_incomplete',
            'GitHub task inventory is incomplete; uniqueness and covered-task state cannot be proven'));
          break;
        }
        if (!resolved.found) {
          tasksOk = false;
          reasons.push(reason('covered_tasks', 'covered_task', resolved.error));
          continue;
        }
        if (resolved.state !== 'closed') {
          tasksOk = false;
          reasons.push(reason('covered_tasks', 'covered_task',
            `covered task ${taskId} is '${resolved.state}' rather than closed (issue #${resolved.issue.number})`));
        }
      } else {
        const info = filesTaskInfo(target, config, taskId);
        if (!info.exists) {
          tasksOk = false;
          reasons.push(reason('covered_tasks', 'covered_task', `covered task ${taskId} does not exist`));
        } else if (info.status !== 'accepted' && info.status !== 'closed') {
          tasksOk = false;
          reasons.push(reason('covered_tasks', 'covered_task',
            `covered task ${taskId} is '${info.status || 'missing'}' rather than accepted or closed`));
        }
      }
    }
    if (backend === 'github' && params?.inventory?.errors?.length > 0) {
      tasksOk = false;
      for (const message of params.inventory.errors) {
        reasons.push(reason('covered_tasks', 'identity_conflict', message));
      }
    }
    gate('covered_tasks', tasksOk);
  }

  // --- candidate artifact ----------------------------------------------------
  const artifactInput = String(params?.artifact ?? '').trim() ||
    auditRecord?.certifiedArtifact ||
    auditRecord?.candidateArtifact ||
    '';
  let candidateArtifact = '';
  if (!artifactInput) {
    gate('candidate', false);
    reasons.push(reason('candidate', 'candidate_missing',
      'no candidate artifact is available; freeze the exact integrated candidate',
      { repair: 'pass --artifact commit:<full-sha> or bind the audit baseline to the frozen candidate' }));
  } else {
    const resolution = resolveCandidateArtifact(target, artifactInput, { gitRunner: params?.gitRunner });
    if (!resolution.ok) {
      gate('candidate', false);
      reasons.push(reason('candidate', 'candidate_unverifiable', resolution.error,
        { repair: resolution.repair ?? null }));
    } else {
      candidateArtifact = resolution.canonical;
      gate('candidate', true);
      if (auditRecord?.certifiedArtifact && resolution.canonical !== auditRecord.certifiedArtifact &&
          artifactInput === String(params?.artifact ?? '').trim()) {
        gate('candidate', false);
        reasons.push(reason('candidate', 'audit_not_current',
          `candidate '${resolution.canonical}' does not match certified_artifact '${auditRecord.certifiedArtifact}'`));
      }
    }
  }

  // --- terminal PR lifecycle (github backend) --------------------------------
  // Terminal closeout proves, for every covered GitHub task, that one PR was
  // accepted by review, merged, bound to the certified candidate, and carries
  // the closing relationship to the correct issue. A merely closed issue
  // without that relationship can never complete.
  if (backend === 'github') {
    const lifecycle = params?.prLifecycle;
    const candidateSha = candidateArtifact.startsWith('commit:')
      ? candidateArtifact.slice('commit:'.length)
      : '';
    let lifecycleOk = true;
    if (!lifecycle || lifecycle.ok !== true) {
      lifecycleOk = false;
      reasons.push(reason('pr_lifecycle', 'pr_lifecycle',
        `pull-request lifecycle evidence is unavailable: ${lifecycle?.error ?? 'not fetched'}; terminal closeout cannot prove PR acceptance, merge state, and closing relationships`));
    } else {
      for (const taskId of coveredTasks) {
        const resolved = resolveCoveredGitHubTask(params?.inventory, taskId);
        if (!resolved.found) continue; // covered_tasks gate already reports this
        const verdict = evaluatePullRequestLifecycle(
          lifecycle.byIssue?.get(resolved.issue.number) ?? [],
          resolved.issue.number,
          candidateSha
        );
        if (!verdict.ok) {
          lifecycleOk = false;
          reasons.push(reason('pr_lifecycle', 'pr_lifecycle',
            `covered task ${taskId}: ${verdict.error}`));
        }
      }
    }
    gate('pr_lifecycle', lifecycleOk);
  }

  // --- product tree ----------------------------------------------------------
  const carrierForTree = backend === 'files'
    ? readFilesCloseoutCarrier(target, config, coveredTasks)
    : null;
  if (candidateArtifact && auditRecord?.certifiedArtifact && workUnitAudit !== 'disabled') {
    const comparison = compareCertifiedProductTree(target, {
      certifiedArtifact: auditRecord.certifiedArtifact,
      auditRecordRelPath: auditEntry?.relPath,
      markerCarrierRelPath: carrierForTree?.relPath,
      coveredTaskRelPaths: backend === 'files'
        ? coveredTasks.map(taskId => filesTaskRelPath(config, taskId)).filter(Boolean)
        : [],
      eventLogRelPaths: backend === 'files'
        ? coveredTasks.map(taskId => eventLogRelPath(taskId))
        : [],
      validateEvent,
      allowedWorkflowPaths: (params?.improvementRefs ?? [])
        .map(ref => `.agenticloop/improvements/${String(ref).trim()}.md`),
      gitRunner: params?.gitRunner,
    });
    gate('product_tree', comparison.ok);
    if (!comparison.ok) {
      if (comparison.state === 'product_drift') {
        for (const item of comparison.drift) {
          reasons.push(reason('product_tree', 'product_drift',
            `${item.source} product drift after certification: ${item.path}${item.error ? ` (${item.error})` : ''}`,
            { repair: `rebaseline and re-audit: agenticloop audit baseline ${auditRecord.auditId} --artifact commit:<new-full-sha> --evidence "<checks>"` }));
        }
      } else {
        reasons.push(reason('product_tree', 'candidate_unverifiable',
          comparison.error ?? 'cannot verify the certified product tree'));
      }
    }
  } else {
    gate('product_tree', true);
  }

  // --- marker state -----------------------------------------------------------
  const carrier = backend === 'files'
    ? carrierForTree
    : params?.carrier ?? null;
  const markerText = backend === 'files'
    ? (markdownSection(carrier?.content ?? '', '## Comments')?.body ?? '')
    : String(params?.carrierComments ?? '');
  const markers = parseCloseoutMarkers(markerText);
  const markerResolution = params?.markerResolution ?? resolveCurrentCloseoutMarkers(markers);
  const currentMarker = markerResolution.current.length === 1 ? markerResolution.current[0] : null;
  const markerCarrierError = backend === 'github' && (!carrier || params?.carrierError);
  gate('marker_state', !markerCarrierError && !markerResolution.error);
  if (markerCarrierError) {
    reasons.push(reason('marker_state', 'membership_underivable',
      `GitHub closeout marker carrier cannot be resolved: ${params?.carrierError ?? 'carrier is unavailable'}`));
  } else if (markerResolution.error) {
    reasons.push(reason('marker_state', 'marker_contradictory', markerResolution.error));
  }
  const prematureComplete = currentMarker?.status === 'complete' && reasons.length > 0;
  if (prematureComplete) {
    reasons.push(reason('marker_state', 'marker_correction',
      `an existing 'complete' closeout marker does not match current gate state and must be superseded`,
      { repair: `agenticloop closeout record --packet <packet> --yes (records the truthful ${recommendedStatusForReasons(reasons)} marker)` }));
  }
  const legacyComplete = currentMarker?.status === 'complete' && !currentMarker.provenanced;
  if (legacyComplete) {
    reasons.push(reason('marker_state', 'marker_correction',
      `the current 'complete' marker is a legacy unprovenanced marker; it is history, not valid completion`,
      { repair: 're-run closeout prepare for the work unit, then closeout record --yes, to re-record with provenance' }));
  }

  // --- finding dispositions ----------------------------------------------------
  const dispositionProjection = [];
  if (auditRecord) {
    const state = findingDispositionState(auditRecord);
    for (const entry of state.findings) {
      dispositionProjection.push({
        run: entry.run,
        finding_id: entry.findingId,
        disposition: entry.disposition?.type ?? 'none',
      });
    }
    const undisposedNonBlocking = state.undisposed.filter(entry => !entry.blocking);
    gate('finding_dispositions', undisposedNonBlocking.length === 0);
    for (const entry of undisposedNonBlocking) {
      reasons.push(reason('finding_dispositions', 'undisposed_findings',
        `non-blocking finding run ${entry.run} / ${entry.findingId} has no typed disposition`,
        { repair: `agenticloop audit disposition ${auditRecord.auditId} --run ${entry.run} --finding ${entry.findingId} --type <type> [--ref <ref>] [--note "<reason>"]` }));
    }
  } else {
    gate('finding_dispositions', true);
  }

  // --- plan sync -----------------------------------------------------------------
  // Mechanical contract: an implicit `none` never suffices when a source plan
  // applies; `not_required` is an explicit visible opt-out; `synced` binds the
  // exact plan reference and content revision and is verified mechanically;
  // `skipped` is non-passing. Absent or ambiguous evidence is needs_context.
  const planSyncInput = parsePlanSyncValue(params?.planSync);
  const planSync = planSyncInput.disposition;
  const explicitPlanRef = String(params?.planSyncRef ?? '').trim();
  const planPath = selectedPlanPath(target, config);
  const planApplies = Boolean(explicitPlanRef || planPath);
  const claimedRevision = planSyncInput.revision ?? (String(params?.planSyncRevision ?? '').trim() || null);
  let packetPlanSync = planSync;
  let planSyncOk = true;
  if (planSync === 'skipped') {
    planSyncOk = false;
    reasons.push(reason('plan_sync', 'plan_sync',
      'a required source-plan progress synchronization was not completed',
      { repair: 'complete the conditional plan sync before candidate freeze, then re-run closeout prepare' }));
  } else if (!planApplies) {
    if (planSync === 'synced') {
      planSyncOk = false;
      reasons.push(reason('plan_sync', 'plan_sync',
        "plan-sync disposition 'synced' names no applicable source plan; select documents.plan or pass --plan-ref"));
    }
  } else if (planSync === 'none') {
    planSyncOk = false;
    reasons.push(reason('plan_sync', 'plan_sync_missing',
      `a source plan applies (${explicitPlanRef || planPath}) but no plan-sync evidence was recorded`,
      { repair: 're-run closeout prepare with --plan-sync not_required, or --plan-sync synced [--plan-ref <path>] [--plan-revision sha256:<hash>]' }));
  } else if (planSync === 'not_required') {
    // Explicit, visible opt-out carried into the marker.
  } else if (planSync === 'synced') {
    const verification = verifyPlanSynchronization(target, {
      planRef: explicitPlanRef || planPath,
      coveredTasks,
    });
    if (!verification.ok) {
      planSyncOk = false;
      reasons.push(reason('plan_sync', 'plan_sync', verification.error,
        { repair: verification.repair ?? null }));
    } else if (claimedRevision && claimedRevision !== verification.revision) {
      planSyncOk = false;
      reasons.push(reason('plan_sync', 'plan_sync',
        `plan-sync revision ${claimedRevision} does not match the current plan revision ${verification.revision}; the plan changed after the recorded synchronization`,
        { repair: 're-run closeout prepare --plan-sync synced against the current plan revision' }));
    } else {
      packetPlanSync = `synced@${verification.revision}`;
    }
  }
  gate('plan_sync', planSyncOk);

  // --- improvement references -------------------------------------------------
  // Every cited proposal must exist, pass the canonical live validator, and
  // correspond to this work unit where that is mechanically derivable. Only
  // validated proposal paths enter the allowed workflow-delta list.
  const improvementRefs = [...(params?.improvementRefs ?? [])].map(item => String(item).trim()).filter(Boolean);
  let improvementsOk = true;
  for (const ref of improvementRefs) {
    const relPath = `${IMPROVEMENTS_DIRECTORY_RELATIVE_PATH}/${ref}.md`;
    const file = join(target, relPath);
    if (!IMPROVEMENT_ID_PATTERN.test(ref) || !existsSync(file)) {
      improvementsOk = false;
      reasons.push(reason('improvement_refs', 'improvement_ref',
        `improvement reference '${ref}' does not identify an existing proposal`,
        { repair: 'create it with agenticloop improvement new --title <text> --source-ref <durable-ref> ..., or drop the --improvement-ref' }));
      continue;
    }
    const content = readFileSync(file, 'utf-8');
    const validationErrors = params?.refContext
      ? validateImprovementProposal(content, relPath, { refContext: params.refContext })
      : [`${relPath} cannot resolve source_refs because live durable-reference context is unavailable`];
    if (validationErrors.length > 0) {
      improvementsOk = false;
      reasons.push(reason('improvement_refs', 'improvement_ref',
        `improvement proposal '${ref}' is invalid: ${validationErrors.join('; ')}`,
        { repair: `agenticloop improvement lint ${ref}` }));
      continue;
    }
    const proposal = parseImprovementProposal(content);
    const normalizedCovered = normalizeCoveredTasks(coveredTasks);
    if (proposal.relatedTasks.length > 0 && normalizedCovered.length > 0 &&
        !proposal.relatedTasks.some(task => normalizedCovered.includes(task))) {
      improvementsOk = false;
      reasons.push(reason('improvement_refs', 'improvement_ref',
        `improvement proposal '${ref}' names related_tasks (${proposal.relatedTasks.join(', ')}) outside this work unit's covered tasks`));
    }
  }
  gate('improvement_refs', improvementsOk);

  // --- packet ----------------------------------------------------------------------
  const predecessor = currentMarker
    ? currentMarker.reference
    : 'none';

  const observedPacket = {
    packet_schema: CLOSEOUT_PACKET_SCHEMA_VERSION,
    work_unit: workUnit,
    covered_tasks: coveredTasks,
    candidate_artifact: candidateArtifact || artifactInput,
    audit: auditRecord
      ? {
          audit_id: auditRecord.auditId,
          audit_schema_version: auditRecord.auditSchemaVersion ?? null,
          run: auditRecord.history?.length ?? 0,
          verdict: auditRecord.latestVerdict ?? '',
          report_format: auditRecord.history?.[auditRecord.history.length - 1]?.reportFormat ?? '',
        }
      : null,
    audit_opt_out: workUnitAudit === 'disabled',
    backend,
    carrier: carrier
      ? { kind: carrier.kind, reference: carrier.reference, revision: carrier.revision }
      : null,
    plan_sync: packetPlanSync,
    gates,
    finding_dispositions: dispositionProjection,
    improvement_refs: [...(params?.improvementRefs ?? [])].map(String).sort(),
    predecessor_marker: predecessor,
    marker_action: 'none',
    publishable: false,
    completion_eligible: false,
    recommended_status: 'follow_up_required',
    reasons: [],
  };
  const finalized = finalizeCloseoutPacket(observedPacket, reasons, markerResolution);
  const packet = finalized.packet;

  return {
    packet,
    reasons,
    gates,
    markerState: {
      markers,
      current: markerResolution.current,
      superseded: markerResolution.superseded,
      error: markerResolution.error,
      prematureComplete,
      legacyComplete,
    },
    contractErrors: finalized.contractErrors,
  };
}

// ---------------------------------------------------------------------------
// Audit-due diagnostics
// ---------------------------------------------------------------------------

/**
 * Work units whose membership is deterministically derivable (files backend,
 * grouped project) and that have accepted/closed covered tasks but no audit
 * record. Flat projects require an explicit boundary and are never guessed.
 *
 * @param {string} target
 * @param {object} [config]
 * @returns {{ workUnit: string, tasks: string[], state: 'audit_due' }[]}
 */
export function deriveAuditDueWorkUnits(target, config = PROJECT_MAP_DEFAULTS) {
  const profile = String(config?.grouping_profile ?? 'flat');
  if (profile === 'flat' || String(config?.task_backend ?? 'files') !== 'files') {
    return [];
  }
  if (resolveWorkUnitAudit(config) === 'disabled') return [];
  const tasksDir = join(target, '.agenticloop', 'tasks');
  if (!existsSync(tasksDir) || !statSync(tasksDir).isDirectory()) return [];
  const membership = new Map();
  for (const name of readdirSync(tasksDir).filter(item => item.endsWith('.md')).sort()) {
    const content = readFileSync(join(tasksDir, name), 'utf-8');
    const [frontmatter] = parseFrontmatter(content);
    const status = String(frontmatter?.status ?? '').trim();
    if (status !== 'accepted' && status !== 'closed') continue;
    const taskId = String(frontmatter?.task_id ?? '').trim() || name.replace(/\.md$/, '');
    const grouping = markdownSection(content, '## Grouping')?.body ?? '';
    for (const token of grouping.split(/[\s,]+/).map(item => item.trim()).filter(Boolean)) {
      const identity = parseWorkUnitIdentity(token);
      if (!identity.ok || identity.kind !== profile) continue;
      const list = membership.get(identity.canonical) ?? [];
      list.push(taskId);
      membership.set(identity.canonical, list);
    }
  }
  const audited = new Set(
    listAuditRecordFiles(target).map(entry => parseAuditRecord(entry.content).workUnit)
  );
  return [...membership.entries()]
    .filter(([workUnit]) => !audited.has(workUnit))
    .map(([workUnit, tasks]) => ({ workUnit, tasks: tasks.sort(), state: 'audit_due' }))
    .sort((left, right) => left.workUnit.localeCompare(right.workUnit));
}

// ---------------------------------------------------------------------------
// Status verification (digest reconstruction after packet deletion)
// ---------------------------------------------------------------------------

/**
 * Verify the current closeout marker for one work unit against live state.
 * The provenance projection is regenerated from durable and live state with
 * the marker treated as the evaluation output; no transient packet is needed.
 *
 * @param {string} target
 * @param {object} params  Same shape as evaluateCloseout params.
 * @returns {{ state: string, status: string, current: boolean, marker: object|null, expectedDigest: string|null, reasons: string[] }}
 */
export function verifyCloseoutStatus(target, params) {
  let evaluation = evaluateCloseout(target, params);
  const provisionalMarker = evaluation.markerState.current[0] ?? null;
  // Audit opt-out completion still binds an exact candidate. Status has no
  // transient packet to supply it, so revalidate the durable marker artifact
  // rather than treating the marker itself as proof without resolution.
  if (provisionalMarker?.provenanced) {
    const artifact = String(provisionalMarker.fields?.AGENT_CLOSEOUT_ARTIFACT ?? '');
    const improvementField = String(provisionalMarker.fields?.AGENT_CLOSEOUT_IMPROVEMENTS ?? 'none');
    const improvementRefs = improvementField === 'none'
      ? []
      : improvementField.split(',').map(item => item.trim()).filter(Boolean);
    const markerPlanSync = String(provisionalMarker.fields?.AGENT_CLOSEOUT_PLAN_SYNC ?? 'none') || 'none';
    const callerPlanSync = parsePlanSyncValue(params?.planSync).disposition;
    const revalidatePlanSync = callerPlanSync === 'none' && markerPlanSync !== 'none';
    if ((!evaluation.packet.candidate_artifact && artifact && artifact !== 'none') ||
        ((params?.improvementRefs?.length ?? 0) === 0 && improvementRefs.length > 0) ||
        revalidatePlanSync) {
      evaluation = evaluateCloseout(target, {
        ...params,
        ...(artifact && artifact !== 'none' ? { artifact } : {}),
        ...(improvementRefs.length > 0 ? { improvementRefs } : {}),
        ...(revalidatePlanSync ? { planSync: markerPlanSync } : {}),
      });
    }
  }
  const { markerState, packet } = evaluation;
  const reasons = evaluation.reasons.map(item => item.message);

  if (markerState.error) {
    return { state: 'contradictory', status: 'blocked', current: false, marker: null, expectedDigest: null, reasons: [markerState.error, ...reasons] };
  }
  const marker = markerState.current[0] ?? null;
  if (!marker) {
    const auditMissing = evaluation.reasons.some(item => item.category === 'audit_missing');
    return {
      state: auditMissing ? 'audit_due' : 'missing',
      status: packet.recommended_status,
      current: false,
      marker: null,
      expectedDigest: null,
      reasons: reasons.length > 0 ? reasons : ['no closeout marker is recorded for this work unit'],
    };
  }
  if (!marker.provenanced) {
    return {
      state: 'legacy_unprovenanced',
      status: marker.status,
      current: false,
      marker,
      expectedDigest: null,
      reasons: [
        `the current marker is a legacy unprovenanced marker (${marker.status}); re-record with closeout prepare/record`,
        ...reasons,
      ],
    };
  }

  // Rebuild the projection with the marker treated as the evaluation output:
  // its recorded predecessor binds history, its recorded plan-sync and
  // improvement references carry the declared dispositions, and the marker
  // being verified is never hashed into its own digest.
  const markerImprovements = String(marker.fields?.AGENT_CLOSEOUT_IMPROVEMENTS ?? 'none');
  const reconstruction = {
    ...packet,
    predecessor_marker: String(marker.fields?.AGENT_CLOSEOUT_PREDECESSOR ?? 'none') || 'none',
    plan_sync: String(marker.fields?.AGENT_CLOSEOUT_PLAN_SYNC ?? 'none') || 'none',
    improvement_refs: markerImprovements === 'none'
      ? []
      : markerImprovements.split(',').map(item => item.trim()).filter(Boolean).sort(),
  };
  const expectedDigest = closeoutPacketDigest(reconstruction);
  const markerDigest = marker.fields?.AGENT_CLOSEOUT_GATE ?? '';
  const markerArtifact = String(marker.fields?.AGENT_CLOSEOUT_ARTIFACT ?? '');
  const expectedAudit = packet.audit
    ? `${packet.audit.audit_id}/run:${packet.audit.run}`
    : 'none';
  const matches =
    marker.knownStatus &&
    markerDigest === expectedDigest &&
    String(marker.fields?.AGENT_CLOSEOUT_WORK_UNIT ?? '') === packet.work_unit &&
    markerArtifact === (packet.candidate_artifact || 'none') &&
    String(marker.fields?.AGENT_CLOSEOUT_AUDIT ?? '') === expectedAudit &&
    marker.status === packet.recommended_status &&
    String(marker.fields?.AGENT_CLOSEOUT_PREDECESSOR ?? '') &&
    String(marker.fields?.AGENT_CLOSEOUT_PLAN_SYNC ?? '') &&
    String(marker.fields?.AGENT_CLOSEOUT_IMPROVEMENTS ?? '');
  if (!matches) {
    return {
      state: 'stale',
      status: marker.status,
      current: false,
      marker,
      expectedDigest,
      reasons: ['the current marker digest does not reconstruct from live state; re-run closeout prepare/record', ...reasons],
    };
  }
  if (marker.status !== 'complete') {
    return { state: marker.status, status: marker.status, current: false, marker, expectedDigest, reasons };
  }
  if (evaluation.reasons.length > 0) {
    return {
      state: 'stale',
      status: marker.status,
      current: false,
      marker,
      expectedDigest,
      reasons: ['the complete marker no longer matches current gate state', ...reasons],
    };
  }
  return { state: 'complete', status: 'complete', current: true, marker, expectedDigest, reasons: [] };
}

// ---------------------------------------------------------------------------
// Marker rendering for one packet
// ---------------------------------------------------------------------------

/**
 * Render the closeout marker a packet would publish.
 *
 * @param {object} packet
 * @param {{ supersedes?: string }} [options]
 * @returns {string}
 */
export function renderMarkerForPacket(packet, options = {}) {
  return renderCloseoutMarker({
    status: packet.recommended_status,
    workUnit: packet.work_unit,
    artifact: packet.candidate_artifact,
    auditRef: packet.audit ? `${packet.audit.audit_id}/run:${packet.audit.run}` : 'none',
    predecessor: packet.predecessor_marker,
    planSync: packet.plan_sync,
    improvementRefs: packet.improvement_refs,
    gateDigest: packet.digest,
    supersedes: options.supersedes ?? '',
  });
}

export { validateCloseoutPacket, closeoutProvenanceProjection };
