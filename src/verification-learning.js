import { markdownLines, parseAtxHeading } from './markdown.js';

export const VERIFICATION_OUTCOMES = Object.freeze(['passed', 'failed', 'timed_out', 'blocked']);
export const VERIFICATION_STRATEGIES = Object.freeze(['foreground', 'background', 'focused', 'split', 'ci']);
export const VERIFICATION_TRIAGE_CLASSIFICATIONS = Object.freeze([
  'one_off',
  'project_fact',
  'decision',
  'follow_up',
  'blocker',
]);

const NUMERIC_ABSENCE_VALUES = new Set(['unknown', 'none']);
const FACT_EMPTY_STATE = 'No project-wide verification operating facts are currently recorded.';
const ATTEMPT_EMPTY_STATE = 'No verification attempts are currently recorded.';
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function headingEntries(content) {
  const lines = markdownLines(content);
  return {
    lines,
    headings: lines
      .map((item, index) => {
        if (!item.live) return null;
        const heading = parseAtxHeading(item.raw);
        return heading ? { ...heading, index } : null;
      })
      .filter(Boolean),
  };
}

function sectionEnd(headings, startIndex, level, lineCount) {
  const next = headings.find(heading => heading.index > startIndex && heading.level <= level);
  return next ? next.index : lineCount;
}

function headingBody(lines, headings, heading) {
  const end = sectionEnd(headings, heading.index, heading.level, lines.length);
  return {
    end,
    body: lines.slice(heading.index + 1, end).map(item => item.raw).join('\n').trim(),
  };
}

function directHeadings(headings, parent, level) {
  return headings.filter(heading =>
    heading.index > parent.index && heading.index < parent.end && heading.level === level
  );
}

function parseFields(body, label, errors) {
  const fields = new Map();
  for (const item of markdownLines(body)) {
    if (!item.live) continue;
    const match = item.raw.match(/^ {0,3}-\s+([^:]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    if (fields.has(key)) {
      errors.push(`${label} repeats field '${match[1].trim()}'`);
      continue;
    }
    fields.set(key, match[2].trim());
  }
  return fields;
}

function requiredField(fields, name, label, errors) {
  const value = fields.get(name.toLowerCase()) ?? '';
  if (!value) errors.push(`${label} is missing required field '${name}'`);
  return value;
}

function parsePositiveIntegerOrAbsence(value, field, label, errors) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (NUMERIC_ABSENCE_VALUES.has(normalized)) return normalized;
  if (/^[1-9]\d*$/.test(normalized)) return Number(normalized);
  errors.push(`${label} field '${field}' must be a positive integer, unknown, or none`);
  return null;
}

function requireEnum(value, field, values, label, errors) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!values.includes(normalized)) {
    errors.push(`${label} field '${field}' must be one of: ${values.join(', ')}`);
  }
  return normalized;
}

function requireUtcTimestamp(value, field, label, errors) {
  if (!ISO_UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    errors.push(`${label} field '${field}' must be an ISO-8601 UTC timestamp`);
  }
}

function requireDate(value, field, label, errors) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    errors.push(`${label} field '${field}' must be YYYY-MM-DD`);
  }
}

function isBooleanString(value) {
  return value === 'true' || value === 'false';
}

export function isProjectFactReference(value) {
  return /^VF-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(value ?? '').trim());
}

export function decisionReferenceId(value) {
  const normalized = String(value ?? '').trim();
  const pathMatch = normalized.match(/^(?:\.\/)?\.agenticloop\/decisions\/([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/);
  if (pathMatch) return pathMatch[1];
  return /^D-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized) ? normalized : null;
}

function isDurableSource(value) {
  const normalized = String(value ?? '').trim();
  return /^(?:T-[A-Za-z0-9._-]+|task:|event:|issue:#?\d+|pr:#?\d+|github:(?:issue|pr):\d+|commit:|https?:\/\/|\.?\/?[A-Za-z0-9_./-]+\.md(?:#\S+)?)$/i.test(normalized);
}

function isFollowUpReference(value) {
  return /^(?:T-[A-Za-z0-9._-]+|issue:#?\d+|github:issue:\d+)$/i.test(String(value ?? '').trim());
}

function isBlockerReference(value) {
  return /^(?:blocker:[A-Za-z0-9._-]+|T-[A-Za-z0-9._-]+|issue:#?\d+|github:issue:\d+)$/i.test(String(value ?? '').trim());
}

/**
 * Parse and validate the current project-map verification projection.
 *
 * @param {string} content
 * @param {{ decisionExists?: (id: string) => boolean }} [options]
 */
export function parseVerificationOperatingFacts(content, options = {}) {
  const errors = [];
  const { lines, headings } = headingEntries(content);
  const sections = headings.filter(heading => heading.level === 2 && heading.text === 'Verification Operating Facts');
  if (sections.length === 0) return { present: false, facts: [], errors };
  if (sections.length > 1) errors.push("project.md repeats the '## Verification Operating Facts' section");

  const section = { ...sections[0], ...headingBody(lines, headings, sections[0]) };
  const factHeadings = directHeadings(headings, section, 3);
  if (factHeadings.length === 0) {
    if (section.body && section.body !== FACT_EMPTY_STATE) {
      errors.push("project.md '## Verification Operating Facts' must use the canonical empty state or one '### VF-...' entry per fact");
    }
    return { present: true, facts: [], errors };
  }

  const facts = [];
  const ids = new Set();
  const commands = new Set();
  for (const heading of factHeadings) {
    const label = `Verification fact '${heading.text}'`;
    if (!isProjectFactReference(heading.text)) {
      errors.push(`${label} must use a stable id in the form 'VF-<name>'`);
    }
    if (ids.has(heading.text)) errors.push(`Verification fact id '${heading.text}' is duplicated`);
    ids.add(heading.text);

    const entry = { ...heading, ...headingBody(lines, headings, heading) };
    const fields = parseFields(entry.body, label, errors);
    const command = requiredField(fields, 'Command', label, errors);
    const lastOutcome = requireEnum(
      requiredField(fields, 'Last outcome', label, errors),
      'Last outcome',
      VERIFICATION_OUTCOMES,
      label,
      errors
    );
    const observedDurationMs = parsePositiveIntegerOrAbsence(
      requiredField(fields, 'Observed duration ms', label, errors),
      'Observed duration ms',
      label,
      errors
    );
    const timeoutMs = parsePositiveIntegerOrAbsence(
      requiredField(fields, 'Timeout ms', label, errors),
      'Timeout ms',
      label,
      errors
    );
    const hostTimeoutCeilingMs = parsePositiveIntegerOrAbsence(
      requiredField(fields, 'Host timeout ceiling ms', label, errors),
      'Host timeout ceiling ms',
      label,
      errors
    );
    const strategy = requireEnum(
      requiredField(fields, 'Strategy', label, errors),
      'Strategy',
      VERIFICATION_STRATEGIES,
      label,
      errors
    );
    const updated = requiredField(fields, 'Updated', label, errors);
    if (updated) requireDate(updated, 'Updated', label, errors);
    const source = requiredField(fields, 'Source', label, errors);
    if (source && !isDurableSource(source)) {
      errors.push(`${label} field 'Source' must identify task evidence, an event, issue/PR, or another durable source`);
    }
    const revisitWhen = requiredField(fields, 'Revisit when', label, errors);
    const decision = requiredField(fields, 'Decision', label, errors);
    if (decision && decision !== 'none') {
      const decisionId = decisionReferenceId(decision);
      if (!decisionId) {
        errors.push(`${label} field 'Decision' must be 'none' or a decision reference`);
      } else if (options.decisionExists && !options.decisionExists(decisionId)) {
        errors.push(`${label} references missing decision '${decision}'`);
      }
    }
    if (command) {
      if (commands.has(command)) {
        errors.push(`Verification facts have contradictory active entries for exact command '${command}'`);
      }
      commands.add(command);
    }
    facts.push({
      id: heading.text,
      command,
      lastOutcome,
      observedDurationMs,
      timeoutMs,
      hostTimeoutCeilingMs,
      strategy,
      updated,
      source,
      revisitWhen,
      decision,
    });
  }
  return { present: true, facts, errors };
}

function parseAttempt(fields, checkId, number, order, errors) {
  const label = `Verification attempt '${checkId}' attempt ${number}`;
  const artifact = requiredField(fields, 'Artifact', label, errors);
  const command = requiredField(fields, 'Command', label, errors);
  const strategy = requireEnum(requiredField(fields, 'Strategy', label, errors), 'Strategy', VERIFICATION_STRATEGIES, label, errors);
  const timeoutMs = parsePositiveIntegerOrAbsence(requiredField(fields, 'Timeout ms', label, errors), 'Timeout ms', label, errors);
  const outcome = requireEnum(requiredField(fields, 'Outcome', label, errors), 'Outcome', VERIFICATION_OUTCOMES, label, errors);
  const durationMs = parsePositiveIntegerOrAbsence(requiredField(fields, 'Duration ms', label, errors), 'Duration ms', label, errors);
  const required = requiredField(fields, 'Required', label, errors).toLowerCase();
  if (!isBooleanString(required)) errors.push(`${label} field 'Required' must be true or false`);
  const partialEvidence = requiredField(fields, 'Partial evidence', label, errors);
  const proposedNextStrategy = requiredField(fields, 'Proposed next strategy', label, errors).toLowerCase();
  if (proposedNextStrategy !== 'none' && !VERIFICATION_STRATEGIES.includes(proposedNextStrategy)) {
    errors.push(`${label} field 'Proposed next strategy' must be one of: none, ${VERIFICATION_STRATEGIES.join(', ')}`);
  }
  const candidateClassification = (fields.get('candidate classification') ?? '').trim().toLowerCase();
  if (candidateClassification && !VERIFICATION_TRIAGE_CLASSIFICATIONS.includes(candidateClassification)) {
    errors.push(`${label} field 'Candidate classification' must be one of: ${VERIFICATION_TRIAGE_CLASSIFICATIONS.join(', ')}`);
  }
  const recordedBy = requiredField(fields, 'Recorded by', label, errors).toLowerCase();
  if (recordedBy && recordedBy !== 'engineer') errors.push(`${label} field 'Recorded by' must be engineer`);
  const recordedAt = requiredField(fields, 'Recorded at', label, errors);
  if (recordedAt) requireUtcTimestamp(recordedAt, 'Recorded at', label, errors);
  return {
    checkId,
    number,
    order,
    artifact,
    command,
    strategy,
    timeoutMs,
    outcome,
    durationMs,
    required: required === 'true',
    partialEvidence,
    proposedNextStrategy,
    candidateClassification,
    recordedBy,
    recordedAt,
  };
}

function parsePrediction(fields, checkId, attemptNumber, order, errors) {
  const label = `Foreground escalation prediction '${checkId}' attempt ${attemptNumber}`;
  const basedAttemptRaw = requiredField(fields, 'Based on attempt', label, errors);
  const basedAttempt = /^[1-9]\d*$/.test(basedAttemptRaw) ? Number(basedAttemptRaw) : null;
  if (basedAttempt === null) errors.push(`${label} field 'Based on attempt' must be a positive attempt number`);
  const evidence = requiredField(fields, 'Evidence', label, errors);
  if (/^(?:it )?(?:may|might) need longer(?:\.|$)/i.test(evidence)) {
    errors.push(`${label} field 'Evidence' must cite concrete evidence, not a generic longer-timeout assertion`);
  }
  const window = requiredField(fields, 'Predicted completion window ms', label, errors);
  const windowMatch = window.match(/^([1-9]\d*)\s*-\s*([1-9]\d*)$/);
  let lowerBound = null;
  let upperBound = null;
  if (!windowMatch) {
    errors.push(`${label} field 'Predicted completion window ms' must be a bounded '<min>-<max>' range`);
  } else {
    lowerBound = Number(windowMatch[1]);
    upperBound = Number(windowMatch[2]);
    if (lowerBound > upperBound) errors.push(`${label} predicted completion window must be ordered low-to-high`);
  }
  const chosenTimeoutRaw = requiredField(fields, 'Chosen timeout ms', label, errors);
  const chosenTimeoutMs = /^[1-9]\d*$/.test(chosenTimeoutRaw) ? Number(chosenTimeoutRaw) : null;
  if (chosenTimeoutRaw && chosenTimeoutMs === null) errors.push(`${label} field 'Chosen timeout ms' must be a positive integer`);
  if (typeof chosenTimeoutMs === 'number' && upperBound !== null && chosenTimeoutMs < upperBound) {
    errors.push(`${label} chosen timeout must cover the bounded completion window`);
  }
  const recordedBy = requiredField(fields, 'Recorded by', label, errors).toLowerCase();
  if (recordedBy && recordedBy !== 'engineer') errors.push(`${label} field 'Recorded by' must be engineer`);
  const recordedAt = requiredField(fields, 'Recorded at', label, errors);
  if (recordedAt) requireUtcTimestamp(recordedAt, 'Recorded at', label, errors);
  return { checkId, attemptNumber, basedAttempt, evidence, window, lowerBound, upperBound, chosenTimeoutMs, recordedBy, recordedAt, order };
}

function parseTriage(fields, checkId, attemptNumber, order, errors) {
  const label = `Verification triage '${checkId}' attempt ${attemptNumber}`;
  const classification = requiredField(fields, 'Classification', label, errors).toLowerCase();
  if (classification !== 'pending' && !VERIFICATION_TRIAGE_CLASSIFICATIONS.includes(classification)) {
    errors.push(`${label} field 'Classification' must be pending or one of: ${VERIFICATION_TRIAGE_CLASSIFICATIONS.join(', ')}`);
  }
  const reference = (fields.get('reference') ?? '').trim();
  const reason = (fields.get('reason') ?? '').trim();
  const triagedBy = requiredField(fields, 'Triaged by', label, errors).toLowerCase();
  if (triagedBy && triagedBy !== 'maintainer') errors.push(`${label} field 'Triaged by' must be maintainer`);
  const triagedAt = requiredField(fields, 'Triaged at', label, errors);
  if (triagedAt) requireUtcTimestamp(triagedAt, 'Triaged at', label, errors);
  return { checkId, attemptNumber, classification, reference, reason, triagedBy, triagedAt, order };
}

/**
 * Parse the canonical per-check task attempt history. It does not impose
 * lifecycle rules; use validateVerificationAttempts for that evaluation.
 *
 * @param {string} content
 */
export function parseVerificationAttempts(content) {
  const errors = [];
  const { lines, headings } = headingEntries(content);
  const sections = headings.filter(heading => heading.level === 2 && heading.text === 'Verification Attempts');
  if (sections.length === 0) return { present: false, checks: [], attempts: [], predictions: [], triages: [], errors };
  if (sections.length > 1) errors.push("Task record repeats the '## Verification Attempts' section");

  const section = { ...sections[0], ...headingBody(lines, headings, sections[0]) };
  const checkHeadings = directHeadings(headings, section, 3);
  if (checkHeadings.length === 0) {
    if (section.body && section.body !== ATTEMPT_EMPTY_STATE) {
      errors.push("Task record '## Verification Attempts' must use the canonical empty state or one '### RC-...' subsection per check");
    }
    return { present: true, checks: [], attempts: [], predictions: [], triages: [], errors };
  }

  const checks = [];
  const attempts = [];
  const predictions = [];
  const triages = [];
  const checkIds = new Set();
  for (const checkHeading of checkHeadings) {
    const checkId = checkHeading.text;
    if (!/^RC-\d+$/.test(checkId)) errors.push(`Verification attempt check id '${checkId}' must use the stable 'RC-<number>' form`);
    if (checkIds.has(checkId)) errors.push(`Verification attempt check id '${checkId}' is duplicated`);
    checkIds.add(checkId);
    const check = { ...checkHeading, ...headingBody(lines, headings, checkHeading) };
    checks.push(checkId);
    const entries = directHeadings(headings, check, 4);
    const attemptNumbers = new Set();
    const predictionNumbers = new Set();
    const triageNumbers = new Set();
    for (const entryHeading of entries) {
      const entry = { ...entryHeading, ...headingBody(lines, headings, entryHeading) };
      const fields = parseFields(entry.body, `Verification entry '${checkId}'`, errors);
      const attemptMatch = entryHeading.text.match(/^Attempt ([1-9]\d*)$/);
      const predictionMatch = entryHeading.text.match(/^Foreground escalation prediction for attempt ([1-9]\d*)$/);
      const triageMatch = entryHeading.text.match(/^Triage for attempt ([1-9]\d*)$/);
      if (attemptMatch) {
        const number = Number(attemptMatch[1]);
        if (attemptNumbers.has(number)) errors.push(`Verification attempt '${checkId}' repeats attempt ${number}`);
        attemptNumbers.add(number);
        attempts.push(parseAttempt(fields, checkId, number, entryHeading.index, errors));
      } else if (predictionMatch) {
        const number = Number(predictionMatch[1]);
        if (predictionNumbers.has(number)) errors.push(`Verification attempt '${checkId}' repeats foreground escalation prediction for attempt ${number}`);
        predictionNumbers.add(number);
        predictions.push(parsePrediction(fields, checkId, number, entryHeading.index, errors));
      } else if (triageMatch) {
        const number = Number(triageMatch[1]);
        if (triageNumbers.has(number)) errors.push(`Verification attempt '${checkId}' repeats triage for attempt ${number}`);
        triageNumbers.add(number);
        triages.push(parseTriage(fields, checkId, number, entryHeading.index, errors));
      } else {
        errors.push(`Verification attempt check '${checkId}' has unrecognized subsection '#### ${entryHeading.text}'`);
      }
    }
  }
  return { present: true, checks, attempts, predictions, triages, errors };
}

function validateTriageReference(triage, factsById, options, errors) {
  const label = `Verification triage '${triage.checkId}' attempt ${triage.attemptNumber}`;
  if (triage.classification === 'pending') return;
  if (triage.classification === 'one_off' && !triage.reason) {
    errors.push(`${label} classification 'one_off' requires a concrete Reason`);
  }
  if (triage.classification === 'project_fact') {
    if (!isProjectFactReference(triage.reference)) {
      errors.push(`${label} classification 'project_fact' requires a project verification fact Reference`);
    } else if (!factsById.has(triage.reference)) {
      errors.push(`${label} references missing project verification fact '${triage.reference}'`);
    }
  }
  if (triage.classification === 'decision') {
    const decisionId = decisionReferenceId(triage.reference);
    if (!decisionId) {
      errors.push(`${label} classification 'decision' requires a decision Reference`);
    } else if (options.decisionExists && !options.decisionExists(decisionId)) {
      errors.push(`${label} references missing decision '${triage.reference}'`);
    }
  }
  if (triage.classification === 'follow_up') {
    if (!isFollowUpReference(triage.reference)) {
      errors.push(`${label} classification 'follow_up' requires a task or issue Reference`);
    } else if (/^T-/i.test(triage.reference) && options.taskExists && !options.taskExists(triage.reference)) {
      errors.push(`${label} references missing follow-up task '${triage.reference}'`);
    }
  }
  if (triage.classification === 'blocker' && !isBlockerReference(triage.reference)) {
    errors.push(`${label} classification 'blocker' requires a durable blocker Reference`);
  }
}

function validateForegroundEscalations(parsed, errors) {
  const attempts = [...parsed.attempts].sort((a, b) => a.order - b.order);
  const predictions = new Map(parsed.predictions.map(prediction => [`${prediction.checkId}:${prediction.attemptNumber}`, prediction]));
  for (const timeout of attempts.filter(attempt => attempt.outcome === 'timed_out' && attempt.strategy === 'foreground')) {
    const retries = attempts.filter(attempt =>
      attempt.order > timeout.order &&
      attempt.checkId === timeout.checkId &&
      attempt.command === timeout.command &&
      attempt.artifact === timeout.artifact &&
      attempt.strategy === 'foreground'
    );
    if (retries.length === 0) continue;
    if (retries.length > 1) {
      errors.push(
        `Verification attempt '${timeout.checkId}' has more than one foreground timeout escalation for command '${timeout.command}' and artifact '${timeout.artifact}'`
      );
    }
    const retry = retries[0];
    const label = `Verification attempt '${retry.checkId}' attempt ${retry.number}`;
    const prediction = predictions.get(`${retry.checkId}:${retry.number}`);
    if (!(typeof timeout.timeoutMs === 'number' && typeof retry.timeoutMs === 'number' && retry.timeoutMs > timeout.timeoutMs)) {
      errors.push(`${label} repeats a foreground timeout without changing strategy or using a larger bounded timeout`);
    }
    if (!prediction) {
      errors.push(`${label} is a foreground timeout escalation but has no preceding prediction`);
      continue;
    }
    if (prediction.order <= timeout.order || prediction.order >= retry.order || prediction.basedAttempt !== timeout.number) {
      errors.push(`${label} foreground escalation prediction must be appended after attempt ${timeout.number} and before the retry`);
    }
    if (typeof retry.timeoutMs === 'number' && typeof prediction.chosenTimeoutMs === 'number' && retry.timeoutMs !== prediction.chosenTimeoutMs) {
      errors.push(`${label} timeout must equal its recorded foreground escalation prediction`);
    }
    if (retry.outcome === 'timed_out' && retries.length > 1) {
      errors.push(`${label} failed its foreground escalation prediction; no further foreground timeout escalation is allowed`);
    }
  }
  for (const prediction of parsed.predictions) {
    const target = parsed.attempts.find(attempt => attempt.checkId === prediction.checkId && attempt.number === prediction.attemptNumber);
    if (!target) {
      errors.push(`Foreground escalation prediction '${prediction.checkId}' targets missing attempt ${prediction.attemptNumber}`);
    }
  }
}

/**
 * Evaluate attempt history against lifecycle, reference, and retry rules.
 * Historical task records without this optional section remain valid.
 *
 * @param {string} content
 * @param {{ status?: string, projectFacts?: { id: string }[], decisionExists?: (id: string) => boolean, taskExists?: (id: string) => boolean, requireTimeoutCandidate?: boolean }} [options]
 */
export function validateVerificationAttempts(content, options = {}) {
  const parsed = parseVerificationAttempts(content);
  const errors = [...parsed.errors];
  const warnings = [];
  const factsById = new Map((options.projectFacts ?? []).map(fact => [fact.id, fact]));
  const triagesByAttempt = new Map();
  for (const triage of parsed.triages) {
    const attempt = parsed.attempts.find(candidate => candidate.checkId === triage.checkId && candidate.number === triage.attemptNumber);
    if (!attempt) {
      errors.push(`Verification triage '${triage.checkId}' targets missing attempt ${triage.attemptNumber}`);
      continue;
    }
    if (triage.order <= attempt.order) {
      errors.push(`Verification triage '${triage.checkId}' attempt ${triage.attemptNumber} must be appended after its attempt`);
    }
    triagesByAttempt.set(`${triage.checkId}:${triage.attemptNumber}`, triage);
    validateTriageReference(triage, factsById, options, errors);
  }

  const terminalStatus = options.status === 'accepted' || options.status === 'closed';
  for (const attempt of parsed.attempts.filter(candidate => candidate.outcome === 'timed_out')) {
    const label = `Verification attempt '${attempt.checkId}' attempt ${attempt.number}`;
    if (!attempt.candidateClassification) {
      const message = `${label} timed out without a Candidate classification`;
      if (options.requireTimeoutCandidate) errors.push(message);
      else warnings.push(message);
    }
    const triage = triagesByAttempt.get(`${attempt.checkId}:${attempt.number}`);
    if (terminalStatus && (!triage || triage.classification === 'pending')) {
      errors.push(`${label} timed out but lacks final maintainer triage for ${options.status} work`);
    }
    if (triage?.classification === 'pending' && terminalStatus) {
      errors.push(`${label} has pending maintainer triage and cannot be ${options.status}`);
    }
  }
  for (const triage of parsed.triages.filter(candidate => candidate.classification === 'pending')) {
    if (terminalStatus) {
      errors.push(`Verification triage '${triage.checkId}' attempt ${triage.attemptNumber} is pending and cannot be ${options.status}`);
    }
  }
  validateForegroundEscalations(parsed, errors);
  return { ...parsed, errors, warnings };
}

export const GITHUB_VERIFICATION_ATTEMPT_MARKER = 'AGENTIC_LOOP_VERIFICATION_ATTEMPTS';

function liveVerificationMarkers(body) {
  const liveBody = markdownLines(body).map(item => item.live ? item.raw : '').join('\n');
  return [...liveBody.matchAll(/^ {0,3}<!--\s*AGENTIC_LOOP_VERIFICATION_ATTEMPTS:([A-Za-z]+-\d+)\s*-->[ \t]*$/gm)];
}

function commentAuthorLogin(comment) {
  if (!comment || typeof comment === 'string') return '';
  return String(comment?.author?.login ?? comment?.user?.login ?? '').trim();
}

function verificationCommentRole(body) {
  const lines = markdownLines(body);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].raw.trim()) continue;
    if (!lines[index].live) return null;
    return lines[index].raw.trim().match(/^\[\[agent:\s*(engineer|maintainer)\]\]$/i)?.[1].toLowerCase() ?? null;
  }
  return null;
}

/**
 * Parse trusted, marked GitHub task-issue comments without inspecting unrelated
 * comments. Markers in quoted/code examples and comments from other accounts
 * are ignored as untrusted user input.
 */
export function parseGitHubVerificationAttemptComments(comments, options = {}) {
  const errors = [];
  const records = [];
  const seen = new Set();
  const expectedLogin = String(options.expectedAccount?.login ?? '').trim().toLowerCase();
  for (const [index, comment] of (Array.isArray(comments) ? comments : []).entries()) {
    const body = typeof comment === 'string' ? comment : String(comment?.body ?? '');
    const markers = liveVerificationMarkers(body);
    if (markers.length === 0) continue;
    if (expectedLogin) {
      const authorLogin = commentAuthorLogin(comment);
      if (!authorLogin || authorLogin.toLowerCase() !== expectedLogin) continue;
    }
    if (markers.length !== 1) {
      errors.push(`GitHub verification-attempt comment ${index + 1} must contain exactly one stable marker`);
      continue;
    }
    if (expectedLogin && !verificationCommentRole(body)) {
      errors.push(`GitHub verification-attempt comment ${index + 1} is missing a final engineer or maintainer attribution trailer`);
      continue;
    }
    const checkId = markers[0][1].toUpperCase();
    if (seen.has(checkId)) {
      errors.push(`GitHub verification-attempt comments duplicate check id '${checkId}'`);
      continue;
    }
    seen.add(checkId);
    const parsed = parseVerificationAttempts(body);
    if (!parsed.present) {
      errors.push(`GitHub verification-attempt comment for '${checkId}' is missing the canonical '## Verification Attempts' section`);
      continue;
    }
    if (parsed.checks.length !== 1 || parsed.checks[0] !== checkId) {
      errors.push(`GitHub verification-attempt comment marker '${checkId}' must contain exactly one matching '### ${checkId}' subsection`);
    }
    records.push({ checkId, commentIndex: index, body, parsed });
  }
  return { records, errors };
}

/** Evaluate all marked issue-comment attempt histories for GitHub gates. */
export function validateGitHubVerificationAttempts(comments, options = {}) {
  const parsed = parseGitHubVerificationAttemptComments(comments, options);
  const errors = [...parsed.errors];
  const warnings = [];
  const requiredIds = new Set((options.requiredChecks ?? []).map(check => check.id).filter(Boolean));
  for (const record of parsed.records) {
    if (requiredIds.size > 0 && !requiredIds.has(record.checkId)) {
      errors.push(`GitHub verification-attempt comment references unknown required-check id '${record.checkId}'`);
    }
    const result = validateVerificationAttempts(record.body, {
      ...options,
      requireTimeoutCandidate: true,
    });
    errors.push(...result.errors.map(error => `GitHub verification-attempt comment '${record.checkId}': ${error}`));
    warnings.push(...result.warnings.map(warning => `GitHub verification-attempt comment '${record.checkId}': ${warning}`));
  }
  return { records: parsed.records, errors, warnings };
}
