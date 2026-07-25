/**
 * `agenticloop audit` - mechanical persistence for work-unit audit certificates.
 *
 * The Auditor is read-only: it returns a structured report and never edits files.
 * This CLI is the persistence path. It appends one completed report per call,
 * never rewrites an earlier history entry, and never alters the substantive
 * findings it is given.
 *
 * Subcommands:
 *   new      create an audit record for a work unit
 *   baseline refresh the candidate artifact and covered-task boundary
 *   report   append one completed Auditor report
 *   status   show current certification state
 *   gate     enforce certification for work-unit closeout
 *   lint     validate audit records
 *   override record a human-approved budget increase
 *   resolve  record the human direction requested by the Auditor
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createIo, resolveCliTarget, CliUsageError, EXIT_USAGE } from './cli-io.js';
import { COMMAND_REGISTRY, parseCommandArgs, suggestName } from './cli-registry.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  applyAuditHumanResolution,
  auditBudgetState,
  auditRecordPath,
  certificationStatus,
  createAuditRecordContent,
  applyAuditBudgetOverride,
  appendAuditReport,
  evaluateAuditCloseoutGate,
  findAuditRecord,
  listAuditRecordFiles,
  nextAuditId,
  normalizeCoveredTasks,
  openBlockingFindings,
  parseAuditRecord,
  parseWorkUnitIdentity,
  updateAuditBaseline,
  validateAuditRecord,
  validateAuditRecords,
} from './audit-record.js';
import { AUDITS_DIRECTORY_RELATIVE_PATH } from './layout.js';
import {
  loadProjectMap,
  PROJECT_MAP_DEFAULTS,
  resolveProjectAuditBudget,
  resolveWorkUnitAudit,
} from './project-map.js';
import { createLocalVerificationContext } from './verification-context.js';

function optionString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function splitList(value) {
  return optionString(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function projectConfig(target) {
  return loadProjectMap(target)?.config ?? PROJECT_MAP_DEFAULTS;
}

function auditValidationOptions(target, config = projectConfig(target)) {
  const context = createLocalVerificationContext(target);
  return {
    taskIdRegex: config.task_id_regex,
    decisionAccepted: decisionId => {
      const file = join(target, '.agenticloop', 'decisions', `${decisionId}.md`);
      if (!existsSync(file)) return false;
      const [frontmatter] = parseFrontmatter(readFileSync(file, 'utf-8'));
      return optionString(frontmatter?.status) === 'accepted';
    },
    ...(config.task_backend === 'files' ? { taskExists: context.taskExists } : {}),
  };
}

function filesTaskStatus(target, config, taskId) {
  const template = String(config.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template)
    .replace(/\\/g, '/');
  if (!template.includes('{taskId}')) return '';
  const root = resolve(target);
  const file = resolve(root, template.replaceAll('{taskId}', taskId));
  if (file !== root && !file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`)) return '';
  if (!existsSync(file)) return '';
  const [frontmatter] = parseFrontmatter(readFileSync(file, 'utf-8'));
  return optionString(frontmatter?.status);
}

function writeRecord(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
}

function relDisplay(auditId) {
  return `${AUDITS_DIRECTORY_RELATIVE_PATH}/${auditId}.md`;
}

function parseFindingsOption(value, errors) {
  const raw = optionString(value);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    errors.push(`--finding-json must be valid JSON: ${error.message}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    errors.push('--finding-json must be a JSON array of findings');
    return [];
  }
  return parsed.map(item => ({
    id: optionString(item?.id),
    severity: optionString(item?.severity).toLowerCase(),
    blocking: item?.blocking === true || optionString(item?.blocking).toLowerCase() === 'true',
    claim: optionString(item?.claim),
    evidenceRefs: optionString(item?.evidenceRefs ?? item?.evidence_refs),
    consequence: optionString(item?.consequence),
    requiredOutcome: optionString(item?.requiredOutcome ?? item?.required_outcome),
    verificationRequired: optionString(item?.verificationRequired ?? item?.verification_required),
  }));
}

function statusPayload(entry, target) {
  const record = entry.record;
  const status = certificationStatus(record);
  const budget = auditBudgetState(record);
  const config = projectConfig(target);
  const workUnitAudit = resolveWorkUnitAudit(config);
  const validationErrors = entry.content
    ? validateAuditRecord(entry.content, entry.relPath ?? `${record.auditId}.md`, auditValidationOptions(target, config))
    : ["audit record content was not supplied for structural validation"];
  const matchingRecords = listAuditRecordFiles(target)
    .map(item => parseAuditRecord(item.content))
    .filter(item => item.workUnit === record.workUnit);
  if (matchingRecords.length !== 1) {
    validationErrors.push(
      `work unit '${record.workUnit}' has ${matchingRecords.length} audit records; exactly one is required`
    );
  }
  const blockingReasons = [...new Set([...validationErrors, ...status.reasons])];
  return {
    audit_id: record.auditId,
    work_unit: record.workUnit,
    audit_state: record.auditState,
    audit_blocked_reason: record.auditBlockedReason || null,
    latest_verdict: record.latestVerdict || null,
    candidate_artifact: record.candidateArtifact,
    certified_artifact: record.certifiedArtifact || null,
    covered_tasks: normalizeCoveredTasks(record.coveredTasks),
    certified_covered_tasks: normalizeCoveredTasks(record.certifiedCoveredTasks),
    completed_audits: budget.completed,
    audit_budget: budget.budget,
    budget_remaining: budget.remaining,
    budget_exhausted: budget.exhausted,
    open_blocking_findings: openBlockingFindings(record).map(finding => finding.id),
    record_valid: validationErrors.length === 0,
    certification_current: validationErrors.length === 0 && status.current,
    blocking_reasons: blockingReasons,
    work_unit_audit: workUnitAudit,
    file: relDisplay(record.auditId),
  };
}

function printStatus(payload, io) {
  io.out(`${payload.audit_id}  ${payload.work_unit}`);
  io.out(`  audit_state:         ${payload.audit_state}${payload.audit_blocked_reason ? ` (${payload.audit_blocked_reason})` : ''}`);
  io.out(`  latest_verdict:      ${payload.latest_verdict ?? '(none)'}`);
  io.out(`  candidate_artifact:  ${payload.candidate_artifact}`);
  io.out(`  certified_artifact:  ${payload.certified_artifact ?? '(none)'}`);
  io.out(`  covered_tasks:       ${payload.covered_tasks.join(', ') || '(none)'}`);
  io.out(`  completed audits:    ${payload.completed_audits}/${payload.audit_budget}`);
  io.out(`  work_unit_audit:     ${payload.work_unit_audit}`);
  io.out(`  certification:       ${payload.certification_current ? 'current' : 'not current'}`);
  for (const reason of payload.blocking_reasons) io.out(`    - ${reason}`);
}

/**
 * @param {string[]} args
 * @param {object} [io]
 * @returns {Promise<number>}
 */
export async function cmdAudit(args, io = createIo()) {
  const sub = args[0];
  const AUDIT_SUBCOMMANDS = COMMAND_REGISTRY.audit.subcommands;
  if (!sub || !AUDIT_SUBCOMMANDS[sub]) {
    const suggestion = sub ? suggestName(sub, Object.keys(AUDIT_SUBCOMMANDS)) : null;
    io.err(suggestion
      ? `audit: unknown subcommand '${sub}'. Did you mean '${suggestion}'?`
      : 'audit requires a subcommand: new, baseline, report, status, gate, lint, override, resolve.');
    io.err('Run "agenticloop help audit" for usage.');
    return EXIT_USAGE;
  }
  const { opts, positional } = parseCommandArgs(`audit ${sub}`, AUDIT_SUBCOMMANDS[sub], args.slice(1));
  const target = resolveCliTarget(io, opts.target);

  try {
    if (sub === 'new') {
      const workUnit = optionString(opts.workUnit) || positional[0] || '';
      const identity = parseWorkUnitIdentity(workUnit);
      if (!identity.ok) {
        io.err(`audit new requires a canonical --work-unit: ${identity.error}`);
        return EXIT_USAGE;
      }
      const coveredTasks = normalizeCoveredTasks(splitList(opts.coveredTasks));
      if (coveredTasks.length === 0) {
        io.err('audit new requires --covered-tasks <T-001,T-002> naming the exact audit boundary');
        return EXIT_USAGE;
      }
      const artifact = optionString(opts.artifact);
      if (!artifact) {
        io.err('audit new requires --artifact <commit:sha> naming the exact frozen candidate');
        return EXIT_USAGE;
      }
      const goal = optionString(opts.goal);
      const completionOracle = optionString(opts.completionOracle);
      const evidence = optionString(opts.evidence);
      if (!goal) {
        io.err('audit new requires --goal <text> defining the work-unit outcome');
        return EXIT_USAGE;
      }
      if (!completionOracle) {
        io.err('audit new requires --completion-oracle <text> defining observable completion');
        return EXIT_USAGE;
      }
      if (!evidence) {
        io.err('audit new requires --evidence <text> bound to the frozen candidate');
        return EXIT_USAGE;
      }
      const existing = listAuditRecordFiles(target);
      const duplicate = existing.find(entry => parseAuditRecord(entry.content).workUnit === identity.canonical);
      if (duplicate) {
        io.err(`Work unit '${identity.canonical}' already has audit record ${duplicate.relPath}`);
        return 1;
      }
      const budgetRaw = optionString(opts.budget);
      let budget;
      if (budgetRaw) {
        budget = Number(budgetRaw);
      } else {
        const projectBudget = resolveProjectAuditBudget(projectConfig(target));
        if (projectBudget.error) {
          io.err(`audit new cannot resolve its default budget: ${projectBudget.error}`);
          return EXIT_USAGE;
        }
        budget = projectBudget.budget;
      }
      if (!Number.isSafeInteger(budget) || budget <= 0) {
        io.err('audit new --budget must be a positive integer');
        return EXIT_USAGE;
      }
      const auditId = nextAuditId(existing.map(entry => entry.auditId));
      const content = createAuditRecordContent({
        auditId,
        workUnit: identity.canonical,
        coveredTasks,
        candidateArtifact: artifact,
        auditBudget: budget,
        goal,
        completionOracle,
        evidence,
      });
      writeRecord(auditRecordPath(target, auditId), content);
      if (opts.json) io.out(JSON.stringify({ audit_id: auditId, file: relDisplay(auditId) }, null, 2));
      else io.out(`Created ${relDisplay(auditId)}`);
      return 0;
    }

    if (sub === 'baseline') {
      const selector = positional[0];
      if (!selector) {
        io.err('audit baseline requires an <audit-id|work-unit> selector');
        return EXIT_USAGE;
      }
      const entry = findAuditRecord(target, selector);
      if (!entry) {
        io.err(`Audit record not found: ${selector}`);
        return 1;
      }
      const artifact = optionString(opts.artifact);
      const coveredTasks = splitList(opts.coveredTasks);
      if (!artifact && coveredTasks.length === 0) {
        io.err('audit baseline requires --artifact and/or --covered-tasks');
        return EXIT_USAGE;
      }
      const evidence = optionString(opts.evidence);
      if (!evidence) {
        io.err('audit baseline requires --evidence <text> bound to the refreshed candidate');
        return EXIT_USAGE;
      }
      const updated = updateAuditBaseline(entry.content, {
        candidateArtifact: artifact,
        coveredTasks,
        evidence,
      });
      writeRecord(entry.file, updated);
      const record = parseAuditRecord(updated);
      if (opts.json) {
        io.out(JSON.stringify(statusPayload({ record, content: updated, relPath: entry.relPath }, target), null, 2));
      } else {
        io.out(`Updated ${relDisplay(record.auditId)} baseline to ${record.candidateArtifact}`);
        if (!record.certifiedArtifact) {
          io.out('  Previous certification cleared; a fresh Auditor invocation is required.');
        }
      }
      return 0;
    }

    if (sub === 'report') {
      const selector = positional[0];
      if (!selector) {
        io.err('audit report requires an <audit-id|work-unit> selector');
        return EXIT_USAGE;
      }
      const entry = findAuditRecord(target, selector);
      if (!entry) {
        io.err(`Audit record not found: ${selector}`);
        return 1;
      }
      const parseErrors = [];
      const findings = parseFindingsOption(opts.findingJson, parseErrors);
      if (parseErrors.length > 0) {
        for (const error of parseErrors) io.err(error);
        return EXIT_USAGE;
      }
      const result = appendAuditReport(entry.content, {
        verdict: optionString(opts.verdict),
        invocationMode: optionString(opts.invocationMode),
        invocationReference: optionString(opts.invocationRef),
        auditedArtifact: optionString(opts.artifact) || entry.record.candidateArtifact,
        assessment: optionString(opts.assessment),
        evidenceChecked: optionString(opts.evidence),
        findings,
      }, auditValidationOptions(target));
      if (!result.ok) {
        for (const error of result.errors) io.err(`Cannot record audit report: ${error}`);
        return 1;
      }
      writeRecord(entry.file, result.content);
      const record = parseAuditRecord(result.content);
      if (opts.json) {
        io.out(JSON.stringify({
          run: result.runNumber,
          ...statusPayload({ record, content: result.content, relPath: entry.relPath }, target),
        }, null, 2));
      } else {
        io.out(`Recorded run ${result.runNumber} in ${relDisplay(record.auditId)} (${record.latestVerdict})`);
        const budget = auditBudgetState(record);
        if (record.auditState === 'blocked') {
          io.out(`  audit_budget ${budget.budget} exhausted; a human-approved override is required for another report.`);
        } else if (record.auditState === 'awaiting_human') {
          io.out('  Human direction is required; record it with `agenticloop audit resolve` before re-audit.');
        }
      }
      return 0;
    }

    if (sub === 'gate') {
      const selector = positional[0];
      if (!selector) {
        io.err('audit gate requires a work-unit identity or audit id');
        return EXIT_USAGE;
      }
      const selected = findAuditRecord(target, selector);
      const workUnit = selected?.record?.workUnit || selector;
      const identity = parseWorkUnitIdentity(workUnit);
      if (!identity.ok) {
        io.err(`audit gate requires a canonical work-unit identity or existing audit id: ${identity.error}`);
        return EXIT_USAGE;
      }
      const config = projectConfig(target);
      const validation = auditValidationOptions(target, config);
      const result = evaluateAuditCloseoutGate(target, {
        workUnit: identity.canonical,
        workUnitAudit: resolveWorkUnitAudit(config),
        taskIdRegex: validation.taskIdRegex,
        taskExists: validation.taskExists,
        decisionExists: validation.decisionExists,
        decisionAccepted: validation.decisionAccepted,
        ...(config.task_backend === 'files'
          ? { taskStatus: taskId => filesTaskStatus(target, config, taskId) }
          : {}),
      });
      if (opts.json) {
        io.out(JSON.stringify(result, null, 2));
      } else if (result.allowed) {
        io.out(`${identity.canonical}: closeout audit gate passed${result.optOut ? ' (disabled by project policy)' : ''}`);
      } else {
        io.out(`${identity.canonical}: closeout audit gate failed (${result.state})`);
        for (const reason of result.reasons) io.out(`  - ${reason}`);
      }
      return result.allowed ? 0 : 1;
    }

    if (sub === 'status') {
      const selector = positional[0];
      if (selector) {
        const entry = findAuditRecord(target, selector);
        if (!entry) {
          io.err(`Audit record not found: ${selector}`);
          return 1;
        }
        const payload = statusPayload(entry, target);
        if (opts.json) io.out(JSON.stringify(payload, null, 2));
        else printStatus(payload, io);
        return payload.certification_current ? 0 : 1;
      }
      const entries = listAuditRecordFiles(target)
        .map(item => ({ ...item, record: parseAuditRecord(item.content) }));
      const payloads = entries.map(item => statusPayload(item, target));
      if (opts.json) {
        io.out(JSON.stringify(payloads, null, 2));
      } else if (payloads.length === 0) {
        io.out('No audit records found.');
      } else {
        for (const payload of payloads) printStatus(payload, io);
      }
      return payloads.length > 0 &&
        payloads.every(payload => payload.certification_current) ? 0 : 1;
    }

    if (sub === 'lint') {
      const selector = positional[0];
      const config = projectConfig(target);
      const options = auditValidationOptions(target, config);
      if (selector) {
        const entry = findAuditRecord(target, selector);
        if (!entry) {
          io.err(`Audit record not found: ${selector}`);
          return 1;
        }
        const errors = validateAuditRecord(entry.content, entry.relPath, options);
        if (opts.json) io.out(JSON.stringify([{ file: entry.relPath, errors }], null, 2));
        else if (errors.length === 0) io.out(`${entry.relPath}: ok`);
        else for (const error of errors) io.out(`${entry.relPath}: ERROR ${error}`);
        return errors.length > 0 ? 1 : 0;
      }
      const result = validateAuditRecords(target, options);
      if (opts.json) {
        io.out(JSON.stringify(result, null, 2));
      } else if (result.errors.length === 0) {
        io.out('Audit records: ok');
      } else {
        for (const error of result.errors) io.out(`ERROR ${error}`);
      }
      return result.errors.length > 0 ? 1 : 0;
    }

    if (sub === 'override') {
      const selector = positional[0];
      if (!selector) {
        io.err('audit override requires an <audit-id|work-unit> selector');
        return EXIT_USAGE;
      }
      const entry = findAuditRecord(target, selector);
      if (!entry) {
        io.err(`Audit record not found: ${selector}`);
        return 1;
      }
      const budgetRaw = optionString(opts.budget);
      const result = applyAuditBudgetOverride(entry.content, {
        budget: budgetRaw ? Number(budgetRaw) : NaN,
        authority: optionString(opts.authority),
        note: optionString(opts.note),
      }, auditValidationOptions(target));
      if (!result.ok) {
        for (const error of result.errors) io.err(`Cannot record budget override: ${error}`);
        return 1;
      }
      writeRecord(entry.file, result.content);
      const record = parseAuditRecord(result.content);
      if (opts.json) {
        io.out(JSON.stringify(
          statusPayload({ record, content: result.content, relPath: entry.relPath }, target),
          null,
          2
        ));
      }
      else io.out(`Raised ${relDisplay(record.auditId)} audit_budget to ${record.auditBudget}`);
      return 0;
    }

    if (sub === 'resolve') {
      const selector = positional[0];
      if (!selector) {
        io.err('audit resolve requires an <audit-id|work-unit> selector');
        return EXIT_USAGE;
      }
      const entry = findAuditRecord(target, selector);
      if (!entry) {
        io.err(`Audit record not found: ${selector}`);
        return 1;
      }
      const result = applyAuditHumanResolution(entry.content, {
        authority: optionString(opts.authority),
        note: optionString(opts.note),
      }, auditValidationOptions(target));
      if (!result.ok) {
        for (const error of result.errors) io.err(`Cannot resolve audit decision: ${error}`);
        return 1;
      }
      writeRecord(entry.file, result.content);
      const record = parseAuditRecord(result.content);
      if (opts.json) {
        io.out(JSON.stringify(
          statusPayload({ record, content: result.content, relPath: entry.relPath }, target),
          null,
          2
        ));
      } else {
        io.out(`Recorded human decision for ${relDisplay(record.auditId)}; a fresh Auditor run is required.`);
      }
      return 0;
    }

    io.err(`Unknown audit subcommand '${sub}'. Expected: new, baseline, report, status, gate, lint, override, resolve.`);
    return EXIT_USAGE;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    io.err(error.message);
    return 1;
  }
}

/**
 * Read an audit record file directly. Exposed for callers that already resolved
 * a path (for example closeout tooling).
 *
 * @param {string} file
 * @returns {object|null}
 */
export function readAuditRecordFile(file) {
  if (!existsSync(file)) return null;
  return parseAuditRecord(readFileSync(file, 'utf-8'));
}
