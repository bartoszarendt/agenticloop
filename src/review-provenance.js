// @ts-check

/**
 * Canonical review-provenance vocabulary and validation.
 *
 * `review_mode` records HOW the current artifact revision was reviewed. It
 * reuses the delegation-mode vocabulary (host_subagent, explicit_agent_invocation,
 * single_agent_fallback) and adds `independent_human` for a durable human review.
 * Defining the enum once here keeps the files backend, the task CLI, and the
 * GitHub marker docs from drifting into divergent copies.
 */

/**
 * Delegation modes recorded on `role.invoked` events (see AGENTIC_LOOP.md).
 * @type {readonly string[]}
 */
export const DELEGATION_MODES = Object.freeze([
  'host_subagent',
  'explicit_agent_invocation',
  'single_agent_fallback',
]);

/**
 * Structured causes for a `single_agent_fallback` delegation. A fallback is
 * legal only when the capability check found no relevant mechanism
 * (`mechanism_absent`) or a named mechanism was attempted and concretely failed
 * (`invocation_failed`). "Re-review requested" is not a fallback cause.
 * @type {readonly string[]}
 */
export const FALLBACK_CAUSES = Object.freeze([
  'mechanism_absent',
  'invocation_failed',
]);

/**
 * The single delegation mode that is a same-session fallback rather than real
 * host delegation. Kept as a named constant so producers and validators do not
 * re-spell the string.
 * @type {string}
 */
export const SINGLE_AGENT_FALLBACK = 'single_agent_fallback';

const DELEGATION_MODES_SET = new Set(DELEGATION_MODES);
const FALLBACK_CAUSES_SET = new Set(FALLBACK_CAUSES);

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidDelegationMode(value) {
  return DELEGATION_MODES_SET.has(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidFallbackCause(value) {
  return FALLBACK_CAUSES_SET.has(value);
}

/**
 * Valid `review_mode` values. Delegation modes plus independent-human review.
 * @type {readonly string[]}
 */
export const REVIEW_MODES = Object.freeze([
  ...DELEGATION_MODES,
  'independent_human',
]);

/**
 * Review modes that satisfy an independent-review requirement. Same-session
 * `single_agent_fallback` does not.
 * @type {readonly string[]}
 */
export const INDEPENDENT_REVIEW_MODES = Object.freeze([
  'host_subagent',
  'explicit_agent_invocation',
  'independent_human',
]);

const REVIEW_MODES_SET = new Set(REVIEW_MODES);
const INDEPENDENT_REVIEW_MODES_SET = new Set(INDEPENDENT_REVIEW_MODES);

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidReviewMode(value) {
  return REVIEW_MODES_SET.has(value);
}

/**
 * @param {string} mode
 * @returns {boolean}
 */
export function satisfiesIndependentReview(mode) {
  return INDEPENDENT_REVIEW_MODES_SET.has(mode);
}

/**
 * Parse an `independent_review_required` frontmatter value.
 * Absent/empty -> null; only `true`/`false` are well-formed.
 *
 * @param {string|undefined|null} raw
 * @returns {{ value: boolean | null, malformed: boolean }}
 */
export function parseIndependentReviewRequired(raw) {
  const trimmed = String(raw ?? '').trim().toLowerCase();
  if (trimmed === '') return { value: null, malformed: false };
  if (trimmed === 'true') return { value: true, malformed: false };
  if (trimmed === 'false') return { value: false, malformed: false };
  return { value: null, malformed: true };
}

/**
 * Validate review-provenance fields for a files-backed task record. Shared by
 * `agenticloop validate`/`task lint` and the `task status` acceptance gate so
 * both surfaces enforce identical rules.
 *
 * @param {object} params
 * @param {string} params.label            Identifier used in messages (task filename).
 * @param {string} [params.status]         Task status ('' when unset).
 * @param {string} [params.reviewStatus]   Current review_status ('' when unset).
 * @param {string} [params.reviewModeRaw]  Raw review_mode frontmatter string.
 * @param {string} [params.implementationArtifact] Current implementation artifact.
 * @param {string} [params.reviewedArtifact] Exact artifact reviewed for review_status.
 * @param {string} [params.independentRaw] Raw independent_review_required string.
 * @param {string} [params.humanReviewRef] Raw human_review_ref string.
 * @returns {string[]} Error messages (empty when the record satisfies the contract).
 */
export function validateReviewProvenance(params) {
  const label = params.label;
  const status = String(params.status ?? '').trim();
  const reviewStatus = String(params.reviewStatus ?? '').trim();
  const reviewMode = String(params.reviewModeRaw ?? '').trim();
  const implementationArtifact = String(params.implementationArtifact ?? '').trim();
  const reviewedArtifact = String(params.reviewedArtifact ?? '').trim();
  const humanReviewRef = String(params.humanReviewRef ?? '').trim();
  const { value: independentRequired, malformed } = parseIndependentReviewRequired(
    params.independentRaw
  );
  const errors = [];

  if (malformed) {
    errors.push(
      `Task record '${label}' has malformed independent_review_required '${String(params.independentRaw).trim()}' (expected true or false)`
    );
  }

  if (reviewMode && !isValidReviewMode(reviewMode)) {
    errors.push(
      `Task record '${label}' has invalid review_mode '${reviewMode}' (expected one of: ${REVIEW_MODES.join(', ')})`
    );
  }

  // Reverse consistency: when review_status is empty, no review fields should be set
  if (!reviewStatus) {
    if (reviewMode) {
      errors.push(
        `Task record '${label}' sets review_mode '${reviewMode}' but has no review_status outcome`
      );
    }
    if (reviewedArtifact) {
      errors.push(
        `Task record '${label}' sets reviewed_artifact but has no review_status outcome`
      );
    }
    if (humanReviewRef) {
      errors.push(
        `Task record '${label}' sets human_review_ref but has no review_status outcome`
      );
    }
  }

  // A non-empty review outcome must record how it was reviewed.
  if (reviewStatus && !reviewMode) {
    errors.push(
      `Task record '${label}' sets review_status '${reviewStatus}' but is missing required frontmatter field 'review_mode'`
    );
  }

  if (reviewStatus && !reviewedArtifact) {
    errors.push(
      `Task record '${label}' sets review_status '${reviewStatus}' but is missing required frontmatter field 'reviewed_artifact'`
    );
  }

  if (reviewStatus && reviewedArtifact !== implementationArtifact) {
    errors.push(
      `Task record '${label}' review provenance is stale: reviewed_artifact must exactly equal implementation_artifact`
    );
  }

  // human_review_ref consistency with review_mode
  if (reviewMode === 'independent_human' && !humanReviewRef) {
    errors.push(
      `Task record '${label}' uses review_mode 'independent_human' but is missing required recorded 'human_review_ref' reference`
    );
  }

  if (humanReviewRef && reviewMode && reviewMode !== 'independent_human') {
    errors.push(
      `Task record '${label}' sets human_review_ref but review_mode is '${reviewMode}'; human_review_ref is only valid with 'independent_human' mode`
    );
  }

  const isTerminal = status === 'accepted' || status === 'closed';
  if (isTerminal) {
    if (reviewStatus !== 'accepted') {
      errors.push(
        `Task record '${label}' has status '${status}' but review_status is not 'accepted'`
      );
    }
    if (!implementationArtifact) {
      errors.push(
        `Task record '${label}' has status '${status}' but is missing implementation_artifact`
      );
    }
    if (!reviewMode) {
      errors.push(
        `Task record '${label}' has status '${status}' but is missing required frontmatter field 'review_mode'`
      );
    } else if (isValidReviewMode(reviewMode) && independentRequired === true && !satisfiesIndependentReview(reviewMode)) {
      errors.push(
        `Task record '${label}' requires independent review but review_mode is '${reviewMode}'; ${status} state needs a separate-execution or independent-human review`
      );
    }
  }

  return errors;
}
