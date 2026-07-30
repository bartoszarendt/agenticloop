/**
 * Canonical required-check contract shared by task projection, dispatch, and
 * role-return evidence.
 *
 * Closed syntax: the `## Required Checks` section body may contain blank lines
 * and canonical bullets only. Any other nonblank content is rejected rather
 * than silently ignored, so a prose paragraph can never disappear from the
 * parsed inventory while remaining in the signed section text.
 *
 * Syntax:
 *   - [RC-1] command: `npm test`
 *   - [RC-2] manual: Inspect the generated adapter output.
 */

const CHECK_ID_RE = /^RC-([1-9]\d*)$/;
const OUTCOMES = new Set(['passed', 'failed', 'blocked', 'not_run']);

function compareChecks(left, right) {
  const leftId = typeof left?.id === 'string' ? left.id : '';
  const rightId = typeof right?.id === 'string' ? right.id : '';
  const leftNumber = CHECK_ID_RE.test(leftId) ? Number(leftId.slice(3)) : Number.MAX_SAFE_INTEGER;
  const rightNumber = CHECK_ID_RE.test(rightId) ? Number(rightId.slice(3)) : Number.MAX_SAFE_INTEGER;
  return leftNumber - rightNumber || leftId.localeCompare(rightId);
}

/** Parse a complete Required Checks section into its closed canonical model. */
export function parseRequiredCheckInventory(text, { allowEmpty = false, allowLegacy = false } = {}) {
  const errors = [];
  const checks = [];
  const seen = new Set();
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const material = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!/^\s*-\s+/.test(line)) {
      errors.push(`required-check inventory rejects non-bullet content: ${line.trim()}`);
      continue;
    }
    material.push(line);
  }

  if (material.length === 0) {
    if (!allowEmpty) errors.push('required-check inventory must contain at least one canonical bullet');
    return { ok: errors.length === 0, checks, errors };
  }

  for (const line of material) {
    const bullet = line.match(/^\s*-\s+\[(RC-[1-9]\d*)\]\s+(command|manual):\s+(.+?)\s*$/);
    if (!bullet) {
      if (allowLegacy) {
        const legacy = line.match(/^\s*-\s+(?:\[(RC-[1-9]\d*)\]\s+)?(.+?)\s*$/);
        const id = legacy?.[1] ?? `RC-${checks.length + 1}`;
        const instruction = legacy?.[2]?.replace(/^`([^`]+)`$/, '$1').trim() ?? '';
        if (legacy && instruction && !seen.has(id)) {
          seen.add(id);
          checks.push({ id, kind: 'command', command: instruction });
          continue;
        }
      }
      errors.push(`required check must use '- [RC-N] command: \`...\`' or '- [RC-N] manual: ...': ${line.trim()}`);
      continue;
    }
    const [, id, kind, rawInstruction] = bullet;
    if (!CHECK_ID_RE.test(id)) {
      errors.push(`required check id '${id}' is invalid`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`required-check inventory duplicates id '${id}'`);
      continue;
    }
    seen.add(id);

    if (kind === 'command') {
      const command = rawInstruction.match(/^`([^`\r\n]+)`$/)?.[1]?.trim() ?? '';
      if (!command) {
        errors.push(`command required check '${id}' must contain one non-empty backtick-delimited command`);
        continue;
      }
      checks.push({ id, kind, command });
      continue;
    }

    const instruction = rawInstruction.trim();
    if (!instruction || instruction.startsWith('`') || instruction.endsWith('`')) {
      errors.push(`manual required check '${id}' must contain a non-empty manual instruction`);
      continue;
    }
    checks.push({ id, kind, instruction });
  }

  checks.sort(compareChecks);
  return { ok: errors.length === 0, checks, errors };
}

/** Validate a persisted canonical inventory without interpreting prose. */
export function validateRequiredCheckInventory(value, { allowEmpty = false, label = 'required-check inventory' } = {}) {
  const errors = [];
  if (!Array.isArray(value)) return { ok: false, checks: [], errors: [`${label} must be an array`] };
  if (!allowEmpty && value.length === 0) errors.push(`${label} must contain at least one check`);
  const seen = new Set();
  const checks = [];
  for (const check of value) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      errors.push(`${label} check must be an object`);
      continue;
    }
    const expected = check.kind === 'command' ? ['id', 'kind', 'command'] :
      check.kind === 'manual' ? ['id', 'kind', 'instruction'] : ['id', 'kind'];
    const missing = expected.filter(key => !Object.hasOwn(check, key));
    const unknown = Object.keys(check).filter(key => !expected.includes(key));
    if (missing.length) errors.push(`${label} check is missing field(s): ${missing.join(', ')}`);
    if (unknown.length) errors.push(`${label} check contains unknown field(s): ${unknown.join(', ')}`);
    if (!CHECK_ID_RE.test(String(check.id ?? ''))) errors.push(`${label} check id must use RC-N`);
    if (seen.has(check.id)) errors.push(`${label} duplicates id '${check.id}'`);
    seen.add(check.id);
    if (!['command', 'manual'].includes(check.kind)) errors.push(`${label} check kind is invalid`);
    if (check.kind === 'command' && (typeof check.command !== 'string' || !check.command.trim())) {
      errors.push(`${label} command check command is required`);
    }
    if (check.kind === 'manual' && (typeof check.instruction !== 'string' || !check.instruction.trim())) {
      errors.push(`${label} manual check instruction is required`);
    }
    checks.push(check);
  }
  const sorted = [...checks].sort(compareChecks);
  if (JSON.stringify(sorted) !== JSON.stringify(checks)) errors.push(`${label} must use canonical RC identity order`);
  return { ok: errors.length === 0, checks: sorted, errors };
}

/** Validate the closed role-return evidence shape for required checks. */
export function validateRequiredCheckEvidence(value, { allowEmpty = false, label = 'role return' } = {}) {
  const errors = [];
  if (!Array.isArray(value)) {
    return { ok: false, checks: [], errors: [`${label} checks must be an array`] };
  }
  if (!allowEmpty && value.length === 0) {
    return { ok: false, checks: [], errors: [`${label} checks must be a non-empty array`] };
  }

  const seen = new Set();
  const checks = [];
  for (const check of value) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      errors.push(`${label} check must be an object`);
      continue;
    }
    const common = ['id', 'kind', 'outcome', 'evidence', 'exitCode'];
    const expected = check.kind === 'command' ? [...common, 'command'] : check.kind === 'manual' ? [...common, 'instruction'] : common;
    const missing = expected.filter(key => !Object.hasOwn(check, key));
    const unknown = Object.keys(check).filter(key => !expected.includes(key));
    if (missing.length) errors.push(`${label} check is missing field(s): ${missing.join(', ')}`);
    if (unknown.length) errors.push(`${label} check contains unknown field(s): ${unknown.join(', ')}`);
    if (!CHECK_ID_RE.test(String(check.id ?? ''))) errors.push(`${label} check id must use RC-N`);
    if (seen.has(check.id)) errors.push(`${label} checks must not duplicate id '${check.id}'`);
    seen.add(check.id);
    if (!['command', 'manual'].includes(check.kind)) errors.push(`${label} check kind must be 'command' or 'manual'`);
    if (!OUTCOMES.has(check.outcome)) errors.push(`${label} check outcome is invalid`);
    if (typeof check.evidence !== 'string' || !check.evidence.trim()) errors.push(`${label} check evidence is required`);

    if (check.kind === 'command') {
      if (typeof check.command !== 'string' || !check.command.trim()) errors.push(`${label} command check command is required`);
      if (!Number.isSafeInteger(check.exitCode)) errors.push(`${label} command check exitCode must be an integer`);
      if (check.outcome === 'passed' && check.exitCode !== 0) errors.push(`passed ${label} command checks require exitCode 0`);
      if (check.outcome === 'failed' && (!Number.isSafeInteger(check.exitCode) || check.exitCode === 0)) {
        errors.push(`failed ${label} command checks require a non-zero exitCode`);
      }
      if (check.outcome === 'blocked' && (!Number.isSafeInteger(check.exitCode) || check.exitCode === 0)) {
        errors.push(`blocked ${label} command checks require a non-zero exitCode`);
      }
      if (check.outcome === 'not_run' && check.exitCode !== -1) errors.push(`not_run ${label} command checks require exitCode -1`);
    }
    if (check.kind === 'manual') {
      if (typeof check.instruction !== 'string' || !check.instruction.trim()) errors.push(`${label} manual check instruction is required`);
      if (check.exitCode !== null) errors.push(`${label} manual checks require exitCode null`);
    }
    checks.push(check);
  }

  const sorted = [...checks].sort(compareChecks);
  if (JSON.stringify(sorted) !== JSON.stringify(checks)) {
    errors.push(`${label} checks must use canonical RC identity order`);
  }
  return { ok: errors.length === 0, checks: sorted, errors };
}

/** Compare returned evidence with the packet/current contract by stable RC id. */
export function requiredCheckEvidenceMatchesInventory(evidence, inventory) {
  const checked = validateRequiredCheckEvidence(evidence);
  if (!checked.ok || !Array.isArray(inventory)) return false;
  if (checked.checks.length !== inventory.length) return false;
  return inventory.every((required, index) => {
    const actual = checked.checks[index];
    if (actual?.id !== required.id || actual?.kind !== required.kind) return false;
    return required.kind === 'command'
      ? actual.command === required.command
      : actual.instruction === required.instruction;
  });
}
