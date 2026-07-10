import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs, warnUnknownOptions } from './cli-args.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  TASK_RECORD_TEMPLATE_RELATIVE_PATH,
  resolveToolkitAssetLayout,
  resolveToolkitAssetPath,
} from './layout.js';
import { isValidTaskId, loadProjectMap, PROJECT_MAP_DEFAULTS } from './project-map.js';
import { resolveTaskBackend } from './task-backend.js';
import {
  FILES_TASK_STATUSES,
  sectionBody,
  validateFilesTaskRecord,
  validateTaskRecord,
} from './validate-config.js';

function frontmatterString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveProject(target) {
  const projectMap = loadProjectMap(target);
  return {
    raw: projectMap?.raw ?? {},
    config: projectMap?.config ?? PROJECT_MAP_DEFAULTS,
  };
}

function guardFilesBackend(target) {
  const resolution = resolveTaskBackend(target);
  for (const warning of resolution.warnings) console.warn(`  WARN: ${warning}`);
  if (resolution.backend !== 'files') {
    const message = resolution.backend === 'github'
      ? "Active task backend is 'github'. `agenticloop task` v1 supports the files backend only; " +
        "use GitHub issues/PRs for task operations in this project."
      : `Active task backend is '${resolution.backend}'. \`agenticloop task\` v1 supports the files backend only.`;
    return { ok: false, message };
  }
  return { ok: true, resolution };
}

function normalizeTemplatePath(template) {
  return String(template ?? PROJECT_MAP_DEFAULTS.task_file_template).replace(/\\/g, '/');
}

function taskPathForId(target, projectConfig, taskId) {
  const relPath = normalizeTemplatePath(projectConfig.task_file_template)
    .replaceAll('{taskId}', taskId);
  const fullPath = resolve(target, relPath);
  const root = resolve(target);
  if (fullPath !== root && !fullPath.startsWith(`${root}\\`) && !fullPath.startsWith(`${root}/`)) {
    throw new Error(`task_file_template resolves outside target: ${projectConfig.task_file_template}`);
  }
  return fullPath;
}

function taskDirectory(target, projectConfig) {
  return dirname(taskPathForId(target, projectConfig, '__TASK_ID__'));
}

function taskFiles(target, projectConfig) {
  const dir = taskDirectory(target, projectConfig);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(entry => entry.endsWith('.md'))
    .map(entry => join(dir, entry))
    .filter(file => statSync(file).isFile())
    .sort();
}

function readTaskRecord(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const [frontmatter] = parseFrontmatter(content);
  return { content, frontmatter: frontmatter ?? {} };
}

function taskRecordFromFile(filePath) {
  const { content, frontmatter } = readTaskRecord(filePath);
  return {
    file: filePath,
    content,
    task_id: frontmatterString(frontmatter.task_id),
    status: frontmatterString(frontmatter.status),
    review_status: frontmatterString(frontmatter.review_status),
    implementation_artifact: frontmatterString(frontmatter.implementation_artifact),
  };
}

function formatTable(rows) {
  const headers = ['task_id', 'status', 'review_status', 'implementation_artifact'];
  const widths = Object.fromEntries(headers.map(header => [header, header.length]));
  for (const row of rows) {
    for (const header of headers) {
      widths[header] = Math.max(widths[header], String(row[header] ?? '').length);
    }
  }
  const line = headers.map(header => header.padEnd(widths[header])).join('  ');
  const sep = headers.map(header => '-'.repeat(widths[header])).join('  ');
  const body = rows.map(row => headers.map(header => String(row[header] ?? '').padEnd(widths[header])).join('  '));
  return [line, sep, ...body].join('\n');
}

function lintTaskFile(filePath, target, projectConfig) {
  const content = readFileSync(filePath, 'utf-8');
  const filename = relative(target, filePath).replace(/\\/g, '/');
  const warnings = [];
  const errors = [
    ...validateTaskRecord(content, filename),
    ...validateFilesTaskRecord(content, filename, {
      activeTaskBackend: 'files',
      projectMapConfig: projectConfig,
      warnings,
    }),
  ];
  return { file: filename, errors, warnings };
}

function nextDefaultTaskId(files) {
  let max = 0;
  for (const file of files) {
    const base = file.split(/[\\/]/).pop() ?? '';
    const match = base.match(/^T-(\d{3,})\.md$/);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

function instantiateTaskTemplate(target, projectConfig, taskId, title) {
  const layout = resolveToolkitAssetLayout(target);
  const templatePath = resolveToolkitAssetPath(target, TASK_RECORD_TEMPLATE_RELATIVE_PATH, layout);
  if (!existsSync(templatePath)) {
    throw new Error(`Task template not found: ${TASK_RECORD_TEMPLATE_RELATIVE_PATH}`);
  }
  return readFileSync(templatePath, 'utf-8')
    .replaceAll('T-001', taskId)
    .replaceAll('Short Task Title', title)
    .replaceAll('Short task title', title);
}

function replaceFrontmatterField(content, key, value) {
  // Operate only inside the leading YAML frontmatter block so a matching
  // `key:` line elsewhere in the body (e.g. a fenced example) is never touched.
  const fence = content.match(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
  if (!fence) {
    throw new Error('Task record missing YAML frontmatter');
  }
  const [full, open, block, close] = fence;
  const eol = block.includes('\r\n') ? '\r\n' : '\n';
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyPattern = new RegExp(`^${escapedKey}:`);
  const lines = block.split(/\r?\n/);
  const index = lines.findIndex(l => keyPattern.test(l));

  if (value === null) {
    if (index === -1) return content;
    lines.splice(index, 1);
  } else if (index === -1) {
    lines.unshift(`${key}: ${value}`);
  } else {
    lines[index] = `${key}: ${value}`;
  }

  const newBlock = lines.join(eol);
  return content.slice(0, fence.index) + open + newBlock + close + content.slice(fence.index + full.length);
}

function appendComment(content, note) {
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- ${date}: ${note.trim()}`;
  if (content.includes('## Comments')) {
    return content.replace(/## Comments[ \t]*(?:\r?\n)?/, match => `${match}${entry}\n`);
  }
  return `${content.trimEnd()}\n\n## Comments\n${entry}\n`;
}

function printLintResults(results, json) {
  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const result of results) {
    if (result.errors.length === 0 && result.warnings.length === 0) {
      console.log(`${result.file}: ok`);
      continue;
    }
    for (const error of result.errors) console.log(`${result.file}: ERROR ${error}`);
    for (const warning of result.warnings) console.log(`${result.file}: WARN ${warning}`);
  }
}

/**
 * Legal task status transitions for the files backend.
 *
 * Key rules:
 * - draft cannot jump directly to accepted or closed
 * - agent-ready cannot jump directly to closed
 * - accepted is terminal (requires explicit reopen to go back)
 * - blocked/needs_context require a note
 */
const LEGAL_TRANSITIONS = {
  'draft':         new Set(['agent-ready', 'blocked', 'needs_context']),
  'agent-ready':   new Set(['in-progress', 'blocked', 'needs_context']),
  'in-progress':   new Set(['needs_revision', 'blocked', 'needs_context', 'accepted']),
  'needs_revision': new Set(['in-progress', 'blocked', 'needs_context']),
  'blocked':       new Set(['agent-ready', 'in-progress']),
  'needs_context': new Set(['agent-ready', 'in-progress']),
  'accepted':      new Set(['closed']),
  'closed':        new Set(),
};

/**
 * Validate a task status transition.
 *
 * @param {string} currentStatus
 * @param {string} nextStatus
 * @param {string|boolean} note
 * @returns {string|null} Error message, or null if transition is valid.
 */
function validateTransition(currentStatus, nextStatus, note) {
  if (!currentStatus) {
    // No current status — allow setting any status (new task record).
    return null;
  }

  if (currentStatus === nextStatus) {
    return null; // Same status is always allowed (idempotent).
  }

  const allowed = LEGAL_TRANSITIONS[currentStatus];
  if (!allowed) {
    return null; // Unknown current status — don't block.
  }

  if (!allowed.has(nextStatus)) {
    const allowedList = [...allowed].join(', ');
    return `Cannot transition from '${currentStatus}' to '${nextStatus}'. Allowed transitions: ${allowedList}`;
  }

  // Require note for blocked and needs_context transitions.
  if ((nextStatus === 'blocked' || nextStatus === 'needs_context') && (!note || note === true)) {
    return `Transition to '${nextStatus}' requires --note explaining the reason`;
  }

  return null;
}

/**
 * Validate the acceptance gate: a task cannot be accepted or closed without
 * meeting minimum evidence requirements.
 *
 * @param {string} content  Full task record content
 * @param {string} filePath  Path for error messages
 * @param {object} projectConfig
 * @returns {string[]} Error messages (empty if gate passes)
 */
function validateAcceptanceGate(content, filePath, projectConfig) {
  const filename = filePath.replace(/\\/g, '/');
  const [frontmatter] = parseFrontmatter(content);
  const errors = [];

  if (!frontmatter) {
    errors.push(`Task '${filename}' cannot be accepted: missing YAML frontmatter`);
    return errors;
  }

  const reviewStatus = frontmatterString(frontmatter.review_status);
  const implementationArtifact = frontmatterString(frontmatter.implementation_artifact);

  // 1. review_status must be 'accepted'
  if (reviewStatus !== 'accepted') {
    errors.push(`Task '${filename}' cannot be accepted: review_status must be 'accepted' (currently '${reviewStatus || '(empty)'}')`);
  }

  // 2. implementation_artifact must be non-empty
  if (!implementationArtifact) {
    errors.push(`Task '${filename}' cannot be accepted: implementation_artifact is empty`);
  }

  // 3. Scope Completed must be non-empty
  const scopeBody = sectionBody(content, '## Scope Completed');
  if (!scopeBody) {
    errors.push(`Task '${filename}' cannot be accepted: '## Scope Completed' section is empty`);
  }

  // 4. Evidence must be non-empty
  const evidenceBody = sectionBody(content, '## Evidence');
  if (!evidenceBody) {
    errors.push(`Task '${filename}' cannot be accepted: '## Evidence' section is empty`);
  }

  return errors;
}

export async function cmdTask(args) {
  const sub = args[0];
  const { opts, positional } = parseArgs(args.slice(1));
  const target = opts.target && opts.target !== true ? resolve(opts.target) : process.cwd();
  const guard = guardFilesBackend(target);
  if (!guard.ok) {
    console.error(guard.message);
    process.exitCode = 1;
    return;
  }

  const project = resolveProject(target);
  const projectConfig = project.config;

  try {
    if (sub === 'list') {
      warnUnknownOptions(opts, ['target', 'status', 'json'], 'task list');
      const rows = taskFiles(target, projectConfig)
        .map(taskRecordFromFile)
        .filter(row => !opts.status || row.status === opts.status)
        .map(row => ({
          task_id: row.task_id,
          status: row.status,
          review_status: row.review_status,
          implementation_artifact: row.implementation_artifact,
        }));
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else console.log(rows.length > 0 ? formatTable(rows) : 'No task records found.');
      return;
    }

    if (sub === 'lint') {
      warnUnknownOptions(opts, ['target', 'json'], 'task lint');
      const taskId = positional[0];
      const files = taskId ? [taskPathForId(target, projectConfig, taskId)] : taskFiles(target, projectConfig);
      const results = files.map(file => existsSync(file)
        ? lintTaskFile(file, target, projectConfig)
        : { file: relative(target, file).replace(/\\/g, '/'), errors: [`Task record not found: ${taskId}`], warnings: [] });
      printLintResults(results, Boolean(opts.json));
      process.exitCode = results.some(result => result.errors.length > 0) ? 1 : 0;
      return;
    }

    if (sub === 'new') {
      warnUnknownOptions(opts, ['target', 'id', 'json'], 'task new');
      const title = positional.join(' ').trim();
      if (!title) {
        console.error('task new requires a title');
        process.exitCode = 1;
        return;
      }
      const defaultRegex = PROJECT_MAP_DEFAULTS.task_id_regex;
      const taskId = opts.id
        ? String(opts.id)
        : projectConfig.task_id_regex === defaultRegex
          ? nextDefaultTaskId(taskFiles(target, projectConfig))
          : null;
      if (!taskId) {
        console.error('Automatic task id allocation supports the default T-### convention only; pass --id for this project.');
        process.exitCode = 1;
        return;
      }
      if (!isValidTaskId(taskId, projectConfig.task_id_regex ?? defaultRegex)) {
        console.error(`Task id '${taskId}' does not match project task_id_regex '${projectConfig.task_id_regex ?? defaultRegex}'`);
        process.exitCode = 1;
        return;
      }
      const filePath = taskPathForId(target, projectConfig, taskId);
      if (existsSync(filePath)) {
        console.error(`Task record already exists: ${relative(target, filePath).replace(/\\/g, '/')}`);
        process.exitCode = 1;
        return;
      }
      mkdirSync(dirname(filePath), { recursive: true });
      // A freshly scaffolded skeleton is not yet ready for an agent; the
      // canonical template ships `agent-ready`, so open new tasks as `draft`.
      const newContent = replaceFrontmatterField(
        instantiateTaskTemplate(target, projectConfig, taskId, title),
        'status',
        'draft'
      );
      writeFileSync(filePath, newContent, 'utf-8');
      if (opts.json) console.log(JSON.stringify({ task_id: taskId, file: relative(target, filePath).replace(/\\/g, '/') }, null, 2));
      else console.log(`Created ${relative(target, filePath).replace(/\\/g, '/')}`);
      return;
    }

    if (sub === 'status') {
      warnUnknownOptions(opts, ['target', 'note', 'blockCategory', 'json', 'accept'], 'task status');
      const [taskId, nextStatus] = positional;
      if (!taskId || !nextStatus) {
        console.error('task status requires <id> and <status>');
        process.exitCode = 1;
        return;
      }
      if (!FILES_TASK_STATUSES.has(nextStatus)) {
        console.error(`Invalid task status '${nextStatus}' (expected one of: ${[...FILES_TASK_STATUSES].join(', ')})`);
        process.exitCode = 1;
        return;
      }
      const blockCategory = frontmatterString(opts.blockCategory);
      if (nextStatus === 'blocked' && !blockCategory) {
        console.error("task status blocked requires --block-category <category>");
        process.exitCode = 1;
        return;
      }
      const filePath = taskPathForId(target, projectConfig, taskId);
      if (!existsSync(filePath)) {
        console.error(`Task record not found: ${relative(target, filePath).replace(/\\/g, '/')}`);
        process.exitCode = 1;
        return;
      }
      let content = readFileSync(filePath, 'utf-8');

      // --- Lifecycle transition enforcement ---
      const { content: parsedContent, frontmatter } = readTaskRecord(filePath);
      const currentStatus = frontmatterString(frontmatter.status);

      const transitionError = validateTransition(currentStatus, nextStatus, opts.note);
      if (transitionError) {
        console.error(transitionError);
        process.exitCode = 1;
        return;
      }

      // --- Acceptance gate for accepted/closed ---
      // Skip the gate when transitioning from accepted to closed;
      // the gate was already checked when the task first became accepted.
      if ((nextStatus === 'accepted' || nextStatus === 'closed') &&
          !(currentStatus === 'accepted' && nextStatus === 'closed')) {
        const gateErrors = validateAcceptanceGate(parsedContent, filePath, projectConfig);
        if (gateErrors.length > 0) {
          for (const err of gateErrors) console.error(err);
          process.exitCode = 1;
          return;
        }
      }

      content = replaceFrontmatterField(content, 'status', nextStatus);
      content = nextStatus === 'blocked'
        ? replaceFrontmatterField(content, 'block_category', blockCategory)
        : replaceFrontmatterField(content, 'block_category', null);
      if (opts.note && opts.note !== true) {
        content = appendComment(content, String(opts.note));
      }
      writeFileSync(filePath, content, 'utf-8');
      if (opts.json) console.log(JSON.stringify({ task_id: taskId, status: nextStatus, file: relative(target, filePath).replace(/\\/g, '/') }, null, 2));
      else console.log(`Updated ${taskId} status to ${nextStatus}`);
      return;
    }

    console.error('Unknown task subcommand. Expected: list, lint, new, status.');
    process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
