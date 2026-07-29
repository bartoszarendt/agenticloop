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

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createIo, resolveCliTarget, CliUsageError, EXIT_USAGE } from './cli-io.js';
import { COMMAND_REGISTRY, parseCommandArgs, suggestName } from './cli-registry.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  applyAuditDisposition,
  applyAuditHumanResolution,
  auditBudgetState,
  canonicalizeAuditRecord,
  LEGACY_CONSUMPTION_CAUSE,
  migrateAuditConsumptionCause,
  certificationStatus,
  createAuditRecordContent,
  applyAuditBudgetOverride,
  appendAuditReport,
  evaluateAuditCloseoutGate,
  findAuditRecord,
  findingDispositionState,
  listAuditRecordFiles,
  nextAuditId,
  normalizeCoveredTasks,
  openBlockingFindings,
  parseAuditRecord,
  parseWorkUnitIdentity,
  repairAuditRecordStructure,
  updateAuditBaseline,
  validateAuditRecord,
  validateAuditRecords,
} from './audit-record.js';
import {
  legacyInlineToAuditRun,
  parseAuditorWireReport,
  wireReportToAuditRun,
} from './audit-report-schema.js';
import { resolveCandidateArtifact } from './candidate.js';
import { findAuditorInvocationEvent, normalizeAuditorInvocationProvenance } from './audit-provenance.js';
import { executeMutationBatch } from './fs-mutation-kernel.js';
import { AUDITS_DIRECTORY_RELATIVE_PATH } from './layout.js';
import {
  loadProjectMap,
  PROJECT_MAP_DEFAULTS,
  resolveProjectAuditBudget,
  resolveWorkUnitAudit,
} from './project-map.js';
import { createLocalVerificationContext } from './verification-context.js';
import { fetchGitHubTaskInventory, resolveGhRunner } from './closeout-github.js';
import { resolveCoveredGitHubTask } from './github-task-identity.js';

// Memory safety valve for the stdin reader, not a report-size policy: a valid
// report is never rejected for ordinary size.
const MAX_REPORT_STDIN_BYTES = 64 * 1024 * 1024;

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

/**
 * Build the one command-scoped validation context. A GitHub-backed command
 * fetches the task inventory exactly once per invocation through the injected
 * runner or, in normal CLI execution, the real read-only `gh` runner; every
 * validator, mutation, gate, and status renderer in the command reuses the
 * snapshot. A non-ok inventory state becomes one explicit fail-closed
 * diagnostic rather than misleading per-task "unknown task" errors.
 */
function auditValidationOptions(target, config = projectConfig(target), io = null) {
  const context = createLocalVerificationContext(target);
  const githubInventory = config.task_backend === 'github'
    ? fetchGitHubTaskInventory(resolveGhRunner(io), { taskIdRegex: config.task_id_regex })
    : null;
  const inventoryError = githubInventory && githubInventory.state !== 'ok'
    ? (githubInventory.errors.join('; ') || `GitHub task inventory state is ${githubInventory.state}`)
    : null;
  return {
    taskIdRegex: config.task_id_regex,
    inventoryError,
    decisionAccepted: decisionId => {
      const file = join(target, '.agenticloop', 'decisions', `${decisionId}.md`);
      if (!existsSync(file)) return false;
      const [frontmatter] = parseFrontmatter(readFileSync(file, 'utf-8'));
      return optionString(frontmatter?.status) === 'accepted';
    },
    ...(config.task_backend === 'files'
      ? { taskExists: context.taskExists }
      : {
          taskExists: taskId => resolveCoveredGitHubTask(githubInventory, taskId).found,
          taskStatus: taskId => resolveCoveredGitHubTask(githubInventory, taskId).state ?? '',
          githubInventory,
        }),
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

/**
 * Commit one validated audit record through the shared filesystem mutation
 * kernel. Every audit mutation (`new`, `baseline`, `report`, `disposition`,
 * `override`, `resolve`) uses this one atomic path: a failed write rolls back
 * to the prior bytes and removes transaction-created residue.
 *
 * @param {string} target
 * @param {string} relPath  Target-relative record path.
 * @param {string} content  Fully validated record content.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function auditDigest(content) {
  return `sha256:${createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')}`;
}

function auditMutationReceipt({ entry, before, after, disposition, cause = null }) {
  const record = parseAuditRecord(after);
  const budget = auditBudgetState(record);
  return {
    kind: 'agenticloop.audit-mutation-receipt',
    schemaVersion: 1,
    audit: { id: record.auditId, workUnit: record.workUnit, file: entry.relPath },
    beforeDigest: auditDigest(before),
    afterDigest: auditDigest(after),
    changedPaths: before === after ? [] : [entry.relPath],
    mutationDisposition: disposition,
    budget: { completed: budget.completed, remaining: budget.remaining, exhausted: budget.exhausted },
    consumptionCause: cause,
    revalidateCommand: `npx agenticloop audit lint ${record.auditId}`,
  };
}

function commitAuditMutation(target, relPath, content) {
  const result = executeMutationBatch(target, [{ type: 'write', path: relPath, content }]);
  if (!result.ok) {
    return {
      ok: false,
      errors: [
        ...result.errors.map(error => `audit mutation failed; the prior record is unchanged: ${error}`),
        ...result.rollbackErrors.map(error => `rollback error: ${error}`),
      ],
    };
  }
  let refetched;
  try {
    refetched = readFileSync(join(target, relPath), 'utf8');
  } catch (error) {
    return { ok: false, errors: [`audit mutation committed but could not be re-read: ${error.message}`] };
  }
  if (refetched !== content) {
    return { ok: false, errors: ['audit mutation committed but the re-read content differs from the validated candidate; preserve the record and inspect it before retrying'] };
  }
  const errors = validateAuditRecord(refetched, relPath);
  if (errors.length > 0) {
    return { ok: false, errors: errors.map(error => `audit mutation committed but post-write validation failed: ${error}`) };
  }
  return { ok: true, errors: [], content: refetched };
}

/** Reject global invocation/receipt reuse before a mutation can make lint fail. */
function auditInvocationReuseErrors(target, incoming) {
  /** @type {string[]} */
  const errors = [];
  const reference = String(incoming?.invocationReference ?? '').trim();
  const receipt = String(incoming?.invocationReceipt ?? '').trim();
  for (const entry of listAuditRecordFiles(target)) {
    const record = parseAuditRecord(entry.content);
    for (const prior of record.history ?? []) {
      if (reference && prior.invocationReference === reference) {
        errors.push(`invocation reference '${reference}' was already recorded by ${record.auditId}/run:${prior.runNumber}; every re-audit requires a fresh Auditor invocation`);
      }
      const priorReceipt = String(prior.reportPayload?.invocation?.receipt ?? '').trim();
      if (receipt && priorReceipt === receipt) {
        errors.push(`invocation receipt '${receipt}' was already used by ${record.auditId}/run:${prior.runNumber}`);
      }
    }
  }
  return errors;
}

/**
 * Print validation errors with the exact repair command when it is
 * mechanically known.
 *
 * @param {string[]} errors
 * @param {string} [repair]
 * @param {ReturnType<typeof createIo>} io
 */
function printMutationErrors(errors, repair, io) {
  for (const error of errors) io.err(error);
  if (repair) io.err(`repair: ${repair}`);
}

/**
 * Read a bounded stdin body. The reader is injectable through io.stdin so
 * tests never touch the global process stream.
 *
 * @param {ReturnType<typeof createIo>} io
 * @returns {Promise<{ ok: boolean, body?: string, error?: string }>}
 */
function readStdinBody(io) {
  return new Promise(resolvePromise => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    io.stdin.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_REPORT_STDIN_BYTES) {
        done({ ok: false, error: `stdin report exceeds the ${MAX_REPORT_STDIN_BYTES}-byte bound` });
        return;
      }
      chunks.push(chunk);
    });
    io.stdin.on('end', () => done({ ok: true, body: Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8') }));
    io.stdin.on('error', error => done({ ok: false, error: `failed reading stdin: ${error.message}` }));
  });
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

function statusPayload(entry, target, validation) {
  const record = entry.record;
  const status = certificationStatus(record);
  const budget = auditBudgetState(record);
  const config = projectConfig(target);
  const workUnitAudit = resolveWorkUnitAudit(config);
  const validationErrors = entry.content
    ? validateAuditRecord(entry.content, entry.relPath ?? `${record.auditId}.md`, validation)
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
    // Every consumed run names why it consumed budget, so an exhausted budget
    // always has provenance rather than an unexplained count.
    budget_consumption: record.history.map(entry => ({
      run: entry.runNumber ?? entry.position,
      cause: entry.consumptionCause || 'unrecorded',
      authority: entry.consumptionAuthority || null,
      reason: entry.consumptionReason || null,
      plan: entry.consumptionPlan || null,
    })),
    open_blocking_findings: openBlockingFindings(record).map(finding => finding.id),
    undisposed_findings: findingDispositionState(record).undisposed
      .map(entry => `run:${entry.run}/${entry.findingId}`),
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
  // An exhausted budget must never be an unexplained count: name the cause of
  // every consumed run.
  for (const consumed of payload.budget_consumption) {
    const detail = consumed.authority ? ` (${consumed.authority})` : consumed.plan ? ` (${consumed.plan})` : '';
    io.out(`    run ${consumed.run}: ${consumed.cause}${detail}`);
  }
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
      : 'audit requires a subcommand: new, repair-structure, baseline, report, status, gate, lint, disposition, override, resolve.');
    io.err('Run "agenticloop help audit" for usage.');
    return EXIT_USAGE;
  }
  const { opts, positional } = parseCommandArgs(`audit ${sub}`, AUDIT_SUBCOMMANDS[sub], args.slice(1));
  const target = resolveCliTarget(io, opts.target);
  const config = projectConfig(target);
  // One command-scoped validation context: the GitHub task inventory is
  // fetched at most once per command and reused by every validator, mutation,
  // gate, and status renderer below, including JSON rendering after a
  // successful mutation.
  let cachedValidation = null;
  const commandValidation = () => {
    if (!cachedValidation) cachedValidation = auditValidationOptions(target, config, io);
    return cachedValidation;
  };

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
        const projectBudget = resolveProjectAuditBudget(config);
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
      // Resolve the candidate to its canonical identity before rendering.
      const resolution = resolveCandidateArtifact(target, artifact);
      if (!resolution.ok) {
        io.err(`audit new: ${resolution.error}`);
        if (resolution.repair) io.err(`repair: ${resolution.repair}`);
        return 1;
      }
      const auditId = nextAuditId(existing.map(entry => entry.auditId));
      const content = createAuditRecordContent({
        auditId,
        workUnit: identity.canonical,
        coveredTasks,
        candidateArtifact: resolution.canonical,
        auditBudget: budget,
        goal,
        completionOracle,
        evidence,
      });
      // Validate the complete prospective record before the first write.
      const relPath = relDisplay(auditId);
      const prospectiveErrors = validateAuditRecord(content, relPath, commandValidation());
      if (prospectiveErrors.length > 0) {
        printMutationErrors(
          prospectiveErrors.map(error => `Cannot create audit record: ${error}`),
          `agenticloop audit new --work-unit ${identity.canonical} ` +
            `--covered-tasks ${coveredTasks.join(',')} --artifact ${resolution.canonical} ` +
            '--goal "<outcome and durable source>" --completion-oracle "<observable completion>" ' +
            '--evidence "<integrated checks and results>"',
          io
        );
        return 1;
      }
      const committed = commitAuditMutation(target, relPath, content);
      if (!committed.ok) {
        printMutationErrors(committed.errors, null, io);
        return 1;
      }
      if (opts.json) io.out(JSON.stringify({ audit_id: auditId, file: relPath }, null, 2));
      else io.out(`Created ${relPath}`);
      return 0;
    }

    if (sub === 'repair-structure') {
      const selector = positional[0];
      if (!selector) {
        io.err('audit repair-structure requires an <audit-id|work-unit> selector');
        return EXIT_USAGE;
      }
      const entry = findAuditRecord(target, selector);
      if (!entry) {
        io.err(`Audit record not found: ${selector}`);
        return 1;
      }
      const repaired = repairAuditRecordStructure(entry.content, commandValidation());
      if (!repaired.ok) {
        printMutationErrors(
          repaired.errors.map(error => `Cannot repair audit record structure: ${error}`),
          null,
          io
        );
        return 1;
      }
      const committed = commitAuditMutation(target, entry.relPath, repaired.content);
      if (!committed.ok) {
        printMutationErrors(committed.errors, null, io);
        return 1;
      }
      if (opts.json) {
        io.out(JSON.stringify({
          audit_id: entry.record.auditId,
          file: entry.relPath,
          repaired: true,
        }, null, 2));
      } else {
        io.out(`Repaired canonical structure for ${entry.relPath}`);
      }
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
      const canonicalize = Boolean(opts.canonicalize);
      const evidence = optionString(opts.evidence);

      // Explicit, non-destructive consumption-cause migration. It is its own
      // mode: it neither rebaselines the candidate nor consumes audit budget.
      if (opts.migrateConsumptionCause) {
        if (canonicalize || artifact || coveredTasks.length > 0 || evidence) {
          io.err('audit baseline --migrate-consumption-cause records budget provenance only; it does not accept --canonicalize, --artifact, --covered-tasks, or --evidence');
          return EXIT_USAGE;
        }
        const migration = migrateAuditConsumptionCause(entry.content);
        if (!migration.ok) {
          printMutationErrors(migration.errors, null, io);
          return 1;
        }
        if (!migration.changed) {
          if (opts.json) io.out(JSON.stringify({ audit_id: entry.record.auditId, migrated: false, already_migrated: true }, null, 2));
          else io.out(`${relDisplay(entry.record.auditId)} already records a consumption cause for every run; nothing to do.`);
          return 0;
        }
        const committed = commitAuditMutation(target, entry.relPath, migration.content);
        if (!committed.ok) {
          printMutationErrors(committed.errors, null, io);
          return 1;
        }
        const migratedRecord = parseAuditRecord(committed.content);
        const receipt = auditMutationReceipt({
          entry, before: entry.content, after: committed.content,
          disposition: 'committed', cause: LEGACY_CONSUMPTION_CAUSE,
        });
        if (opts.json) {
          io.out(JSON.stringify({
            audit_id: migratedRecord.auditId,
            migrated: true,
            migrated_runs: migration.migratedRuns,
            consumption_cause: LEGACY_CONSUMPTION_CAUSE,
            receipt,
          }, null, 2));
        } else {
          io.out(`Recorded '${LEGACY_CONSUMPTION_CAUSE}' budget provenance for run(s) ${migration.migratedRuns.join(', ')} in ${relDisplay(migratedRecord.auditId)}.`);
          io.out('  No historical authority was invented; the cause records that it was never captured.');
        }
        return 0;
      }

      if (canonicalize && (artifact || coveredTasks.length > 0)) {
        io.err('audit baseline --canonicalize resolves the existing candidate; --artifact/--covered-tasks are mutually exclusive with it');
        return EXIT_USAGE;
      }
      if (!canonicalize && !artifact && coveredTasks.length === 0) {
        io.err('audit baseline requires --artifact and/or --covered-tasks');
        return EXIT_USAGE;
      }
      if (!evidence) {
        io.err(canonicalize
          ? 'audit baseline --canonicalize requires --evidence <text> bound to the resolved full candidate'
          : 'audit baseline requires --evidence <text> bound to the refreshed candidate');
        return EXIT_USAGE;
      }

      let updated;
      if (canonicalize) {
        const result = canonicalizeAuditRecord(entry.content, {
          evidence,
          resolveArtifact: value => resolveCandidateArtifact(target, value),
        }, commandValidation());
        if (!result.ok) {
          printMutationErrors(
            result.errors.map(error => `Cannot canonicalize audit record: ${error}`),
            `agenticloop audit baseline ${entry.record.auditId || selector} --canonicalize ` +
              '--evidence "<current integrated evidence for the resolved full candidate>"',
            io
          );
          return 1;
        }
        updated = result.content;
      } else {
        let canonicalArtifact = artifact;
        if (artifact) {
          const resolution = resolveCandidateArtifact(target, artifact);
          if (!resolution.ok) {
            io.err(`audit baseline: ${resolution.error}`);
            if (resolution.repair) io.err(`repair: ${resolution.repair}`);
            return 1;
          }
          canonicalArtifact = resolution.canonical;
        }
        updated = updateAuditBaseline(entry.content, {
          candidateArtifact: canonicalArtifact,
          coveredTasks,
          evidence,
        });
        // Validate the complete prospective record before any write; a failed
        // rebaseline leaves the existing record byte-identical.
        const prospectiveErrors = validateAuditRecord(updated, entry.relPath, commandValidation());
        if (prospectiveErrors.length > 0) {
          printMutationErrors(
            prospectiveErrors.map(error => `Cannot rebaseline audit record: ${error}`),
            `agenticloop audit baseline ${entry.record.auditId || selector} ` +
              `${artifact ? `--artifact ${canonicalArtifact} ` : ''}` +
              `${coveredTasks.length > 0 ? `--covered-tasks ${normalizeCoveredTasks(coveredTasks).join(',')} ` : ''}` +
              '--evidence "<integrated checks and results>"',
            io
          );
          return 1;
        }
      }

      const committed = commitAuditMutation(target, entry.relPath, updated);
      if (!committed.ok) {
        printMutationErrors(committed.errors, null, io);
        return 1;
      }
      const finalContent = committed.content;
      const record = parseAuditRecord(finalContent);
      const receipt = auditMutationReceipt({ entry, before: entry.content, after: finalContent, disposition: 'committed', cause: 'rebaseline' });
      if (opts.json) {
        io.out(JSON.stringify({ ...statusPayload({ record, content: finalContent, relPath: entry.relPath }, target, commandValidation()), receipt }, null, 2));
      } else {
        io.out(canonicalize
          ? `Canonicalized ${relDisplay(record.auditId)} to audit_schema_version 2 (${record.candidateArtifact})`
          : `Updated ${relDisplay(record.auditId)} baseline to ${record.candidateArtifact}`);
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
      const fileOption = optionString(opts.file);
      const stdinOption = Boolean(opts.stdin);
      const legacyInlineUsed = Boolean(
        optionString(opts.verdict) || optionString(opts.invocationMode) ||
        optionString(opts.invocationRef) || optionString(opts.assessment) ||
        optionString(opts.evidence) || optionString(opts.findingJson)
      );
      const modesUsed = [fileOption ? 'file' : null, stdinOption ? 'stdin' : null, legacyInlineUsed ? 'inline' : null]
        .filter(Boolean);
      // Conflict validation happens before any file or stdin read and before
      // any mutation.
      if (modesUsed.length === 0) {
        io.err('audit report requires one report source: --file <path>, --stdin, or legacy inline options');
        return EXIT_USAGE;
      }
      if (modesUsed.length > 1) {
        io.err(`audit report source modes conflict (${modesUsed.join(', ')}); use exactly one of --file, --stdin, or legacy inline options`);
        return EXIT_USAGE;
      }
      const entry = findAuditRecord(target, selector);
      if (!entry) {
        io.err(`Audit record not found: ${selector}`);
        return 1;
      }

      let run;
      if (fileOption || stdinOption) {
        let body;
        if (fileOption) {
          const reportPath = resolve(target, fileOption);
          if (!existsSync(reportPath)) {
            io.err(`audit report: report file not found: ${fileOption}`);
            return 1;
          }
          body = readFileSync(reportPath, 'utf-8');
        } else {
          const read = await readStdinBody(io);
          if (!read.ok) {
            io.err(`audit report: ${read.error}`);
            return 1;
          }
          body = read.body;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (error) {
          io.err(`audit report: report is not valid JSON: ${error.message}`);
          return 1;
        }
        const wire = parseAuditorWireReport(parsed);
        if (!wire.ok) {
          for (const error of wire.errors) io.err(`Cannot record audit report: ${error}`);
          return 1;
        }
        run = wireReportToAuditRun(wire.report);
      } else {
        const parseErrors = [];
        const findings = parseFindingsOption(opts.findingJson, parseErrors);
        if (parseErrors.length > 0) {
          for (const error of parseErrors) io.err(error);
          return EXIT_USAGE;
        }
        run = legacyInlineToAuditRun({
          verdict: optionString(opts.verdict),
          invocationMode: optionString(opts.invocationMode),
          invocationReference: optionString(opts.invocationRef),
          auditedArtifact: optionString(opts.artifact) || entry.record.candidateArtifact,
          assessment: optionString(opts.assessment),
          evidenceChecked: optionString(opts.evidence),
          findings,
        });
      }
      run.consumptionCause = optionString(opts.cause) || 'substantive_audit';
      run.consumptionAuthority = optionString(opts.consumptionAuthority);
      run.consumptionReason = optionString(opts.consumptionReason);
      run.consumptionPlan = optionString(opts.consumptionPlan);

      const normalizedProvenance = await normalizeAuditorInvocationProvenance(run, {
        verifier: io.auditProvenanceVerifier,
        workUnit: entry.record.workUnit,
        candidateArtifact: entry.record.candidateArtifact,
        coveredTasks: normalizeCoveredTasks(entry.record.coveredTasks),
      });
      if (normalizedProvenance.errors.length > 0) {
        for (const error of normalizedProvenance.errors) io.err(`Cannot record audit report: ${error}`);
        return 1;
      }
      run = normalizedProvenance.run;

      // Event cross-check: when event logging is enabled, the invocation
      // reference must match the corresponding Auditor role.invoked event.
      // When it is disabled, provenance stays as classified (verified receipt
      // or asserted) without inventing evidence.
      if (String(config.event_logging ?? 'disabled') === 'enabled') {
        const match = findAuditorInvocationEvent(target, run.invocationReference);
        if (match.error) {
          io.err(`Cannot record audit report: event-log cross-check failed: ${match.error}`);
          return 1;
        }
        if (!match.matched) {
          io.err(
            `Cannot record audit report: event logging is enabled but no Auditor role.invoked event ` +
            `carries invocation_reference '${run.invocationReference}'; record the delegation event or classify provenance truthfully`
          );
          return 1;
        }
      }

      const reused = auditInvocationReuseErrors(target, run);
      if (reused.length > 0) {
        for (const error of reused) io.err(`Cannot record audit report: ${error}`);
        return 1;
      }

      const result = appendAuditReport(entry.content, run, commandValidation());
      if (!result.ok) {
        for (const error of result.errors) io.err(`Cannot record audit report: ${error}`);
        return 1;
      }
      const committed = commitAuditMutation(target, entry.relPath, result.content);
      if (!committed.ok) {
        printMutationErrors(committed.errors, null, io);
        return 1;
      }
      const finalContent = committed.content;
      const record = parseAuditRecord(finalContent);
      const receipt = auditMutationReceipt({ entry, before: entry.content, after: finalContent, disposition: 'committed', cause: run.consumptionCause });
      if (opts.json) {
        io.out(JSON.stringify({
          run: result.runNumber,
          ...statusPayload({ record, content: finalContent, relPath: entry.relPath }, target, commandValidation()),
          receipt,
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

    if (sub === 'disposition') {
      const selector = positional[0];
      if (!selector) {
        io.err('audit disposition requires an <audit-id|work-unit> selector');
        return EXIT_USAGE;
      }
      const entry = findAuditRecord(target, selector);
      if (!entry) {
        io.err(`Audit record not found: ${selector}`);
        return 1;
      }
      const runRaw = optionString(opts.run);
      if (!runRaw) {
        io.err('audit disposition requires --run <n> naming the report run');
        return EXIT_USAGE;
      }
      const findingId = optionString(opts.finding);
      if (!findingId) {
        io.err('audit disposition requires --finding <A-0x>');
        return EXIT_USAGE;
      }
      const type = optionString(opts.type);
      if (!type) {
        io.err('audit disposition requires --type <disposition>');
        return EXIT_USAGE;
      }
      const result = applyAuditDisposition(entry.content, {
        run: Number(runRaw),
        findingId,
        type,
        ref: optionString(opts.ref),
        note: optionString(opts.note),
        authority: optionString(opts.authority),
      }, commandValidation());
      if (!result.ok) {
        for (const error of result.errors) io.err(`Cannot record finding disposition: ${error}`);
        return 1;
      }
      const committed = commitAuditMutation(target, entry.relPath, result.content);
      if (!committed.ok) {
        printMutationErrors(committed.errors, null, io);
        return 1;
      }
      const record = parseAuditRecord(result.content);
      if (opts.json) {
        io.out(JSON.stringify(statusPayload({ record, content: result.content, relPath: entry.relPath }, target, commandValidation()), null, 2));
      } else {
        io.out(`Recorded disposition for run ${Number(runRaw)} finding ${findingId} in ${relDisplay(record.auditId)} (${type})`);
        io.out('  Disposition never resolves a blocking finding; a fresh Auditor or human authority is still required.');
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
      const gateOptions = commandValidation();
      const result = evaluateAuditCloseoutGate(target, {
        workUnit: identity.canonical,
        workUnitAudit: resolveWorkUnitAudit(config),
        taskIdRegex: gateOptions.taskIdRegex,
        taskExists: gateOptions.taskExists,
        decisionExists: gateOptions.decisionExists,
        decisionAccepted: gateOptions.decisionAccepted,
        inventoryError: gateOptions.inventoryError,
        ...(config.task_backend === 'files'
          ? { taskStatus: taskId => filesTaskStatus(target, config, taskId) }
          : { taskStatus: gateOptions.taskStatus }),
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
        const payload = statusPayload(entry, target, commandValidation());
        if (opts.json) io.out(JSON.stringify(payload, null, 2));
        else printStatus(payload, io);
        return payload.certification_current ? 0 : 1;
      }
      const entries = listAuditRecordFiles(target)
        .map(item => ({ ...item, record: parseAuditRecord(item.content) }));
      const payloads = entries.map(item => statusPayload(item, target, commandValidation()));
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
      const options = commandValidation();
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
      }, commandValidation());
      if (!result.ok) {
        for (const error of result.errors) io.err(`Cannot record budget override: ${error}`);
        return 1;
      }
      const committed = commitAuditMutation(target, entry.relPath, result.content);
      if (!committed.ok) {
        printMutationErrors(committed.errors, null, io);
        return 1;
      }
      const record = parseAuditRecord(result.content);
      if (opts.json) {
        io.out(JSON.stringify(
          statusPayload({ record, content: result.content, relPath: entry.relPath }, target, commandValidation()),
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
      }, commandValidation());
      if (!result.ok) {
        for (const error of result.errors) io.err(`Cannot resolve audit decision: ${error}`);
        return 1;
      }
      const committed = commitAuditMutation(target, entry.relPath, result.content);
      if (!committed.ok) {
        printMutationErrors(committed.errors, null, io);
        return 1;
      }
      const record = parseAuditRecord(result.content);
      if (opts.json) {
        io.out(JSON.stringify(
          statusPayload({ record, content: result.content, relPath: entry.relPath }, target, commandValidation()),
          null,
          2
        ));
      } else {
        io.out(`Recorded human decision for ${relDisplay(record.auditId)}; a fresh Auditor run is required.`);
      }
      return 0;
    }

    io.err(`Unknown audit subcommand '${sub}'. Expected: new, baseline, report, status, gate, lint, disposition, override, resolve.`);
    return EXIT_USAGE;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    if (error?.code === 'task.record.structure') throw error;
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
