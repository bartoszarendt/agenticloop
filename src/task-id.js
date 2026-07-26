// @ts-check

/**
 * Shared task-ID validation.
 *
 * A project regex narrows the identifiers a target accepts. It never replaces
 * the repository-independent safety envelope required for filenames, labels,
 * branches, task references, and audit boundaries.
 */

export const TASK_ID_MAX_LENGTH = 64;
export const TASK_ID_REGEX_MAX_LENGTH = 256;
export const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const NESTED_QUANTIFIER_PATTERN =
  /\((?:\\.|[^()])*(?:[+*]|\{\d+(?:,\d*)?\})(?:\\.|[^()])*\)(?:[+*]|\{\d+(?:,\d*)?\})/;

/**
 * Return the first configuration error for a project task-ID regex.
 *
 * @param {unknown} regex
 * @returns {string|null}
 */
export function taskIdRegexError(regex) {
  if (typeof regex !== 'string' || !regex.trim()) {
    return 'task_id_regex is required';
  }
  if (regex.length > TASK_ID_REGEX_MAX_LENGTH) {
    return `task_id_regex must be at most ${TASK_ID_REGEX_MAX_LENGTH} characters`;
  }
  if (/[\r\n"'`]/.test(regex)) {
    return 'task_id_regex must be a single-line expression without quote or backtick characters';
  }
  try {
    new RegExp(regex);
  } catch {
    return `task_id_regex is not a valid regular expression: ${regex}`;
  }
  if (!regex.startsWith('^') || !regex.endsWith('$')) {
    return 'task_id_regex must be anchored with ^ and $ so it matches the whole task ID';
  }
  if (/\\[1-9]/.test(regex)) {
    return 'task_id_regex must not use backreferences';
  }
  if (NESTED_QUANTIFIER_PATTERN.test(regex)) {
    return 'task_id_regex must not use nested quantifiers';
  }
  return null;
}

/**
 * Return the first repository-independent safety error for a task ID.
 *
 * @param {unknown} taskId
 * @returns {string|null}
 */
export function taskIdSafetyError(taskId) {
  if (typeof taskId !== 'string' || !taskId) {
    return 'task ID is empty';
  }
  if (taskId.length > TASK_ID_MAX_LENGTH) {
    return `task ID must be at most ${TASK_ID_MAX_LENGTH} characters`;
  }
  if (!SAFE_TASK_ID_PATTERN.test(taskId)) {
    return "task ID must start with an alphanumeric character and use only letters, numbers, '.', '_', or '-'";
  }
  if (taskId === '.' || taskId === '..') {
    return "task ID must not be '.' or '..'";
  }
  return null;
}

/**
 * Validate one task ID against both the safety envelope and project regex.
 *
 * @param {unknown} taskId
 * @param {unknown} regex
 * @returns {boolean}
 */
export function isValidTaskId(taskId, regex) {
  if (taskIdSafetyError(taskId) || taskIdRegexError(regex)) return false;
  try {
    // The wrapper is intentional defense in depth. Project validation requires
    // explicit anchors, while runtime matching still cannot degrade to a
    // substring match if validation was skipped.
    return new RegExp(`^(?:${regex})$`).test(/** @type {string} */ (taskId));
  } catch {
    return false;
  }
}
