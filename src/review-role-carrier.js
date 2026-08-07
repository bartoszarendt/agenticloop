/** Immutable role identity for append-only review and history carriers. */

import { getWorkflowRole } from './workflow-roles.js';

export const REVIEW_ROLE_CARRIER_SCHEMA = 'agenticloop.review-role-carrier';
export const REVIEW_ROLE_CARRIER_SCHEMA_VERSION = 1;
export const REVIEW_ROLE_CARRIER_VERSION = `${REVIEW_ROLE_CARRIER_SCHEMA}/v${REVIEW_ROLE_CARRIER_SCHEMA_VERSION}`;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize legacy protocol tokens and the versioned role carrier into one
 * immutable role identity. Legacy `Maintainer:` and `Orchestrator:` fields are
 * deliberately protocol tokens, never mutable presentation labels.
 */
export function normalizeReviewRoleCarrier(fields, {
  expectedRoleId,
  legacyField,
  legacyActorAccount = null,
  allowUntrustedLegacyParse = false,
  registry,
  label = 'review carrier',
} = {}) {
  const source = fields && typeof fields === 'object' ? fields : {};
  const errors = [];
  const legacy = text(source[legacyField]);
  const carrierVersion = text(source.review_role_carrier);
  const roleId = text(source.role_id);
  const actorAccount = text(source.actor_account);
  const hasVersioned = Boolean(carrierVersion || roleId || actorAccount);

  if (legacy && hasVersioned) {
    errors.push(`${label} mixes legacy '${legacyField}' and versioned role authority fields`);
  }
  if (hasVersioned) {
    if (carrierVersion !== REVIEW_ROLE_CARRIER_VERSION) {
      errors.push(`${label} review role carrier must be '${REVIEW_ROLE_CARRIER_VERSION}'`);
    }
    if (!roleId) errors.push(`${label} versioned role carrier requires Role ID`);
    if (!actorAccount) errors.push(`${label} versioned role carrier requires Actor account`);
    try {
      if (roleId) getWorkflowRole(roleId, registry);
    } catch {
      errors.push(`${label} Role ID '${roleId}' is not in the workflow-role registry`);
    }
    if (roleId && expectedRoleId && roleId !== expectedRoleId) {
      errors.push(`${label} Role ID must be immutable '${expectedRoleId}'`);
    }
    return {
      ok: errors.length === 0,
      errors,
      roleId: errors.length === 0 ? roleId : null,
      actorAccount: errors.length === 0 ? actorAccount : null,
      // Preserve whether the supported version was actually declared. An
      // invalid or omitted version is not normalized into the version a later
      // repair would like to write; repair disclosure must name that change.
      schemaVersion: carrierVersion === REVIEW_ROLE_CARRIER_VERSION
        ? REVIEW_ROLE_CARRIER_SCHEMA_VERSION
        : null,
      declaredVersion: carrierVersion || null,
      legacy: false,
    };
  }

  // Legacy protocol values are only authority carriers in their documented
  // namespace. Files used the fixed role spelling; GitHub used the authenticated
  // source account. Arbitrary legacy text must never acquire role authority.
  if (!legacy) errors.push(`${label} must declare legacy ${legacyField} attribution`);
  const trustedActor = text(legacyActorAccount);
  if (legacy && trustedActor) {
    // The collector compares the returned actor account with this authenticated
    // source and records a repairable candidate on mismatch. Keep the immutable
    // role token separate so the mismatched account itself grants no authority.
  } else if (legacy && legacy.toLowerCase() !== String(expectedRoleId ?? '').toLowerCase() && !allowUntrustedLegacyParse) {
    errors.push(`${label} legacy ${legacyField} value must use the historical role spelling '${expectedRoleId}'`);
  }
  return {
    ok: errors.length === 0,
    errors,
    // A parser without GitHub authenticated-source context may preserve a
    // historical account token for diagnostics, but it never grants authority.
    roleId: errors.length === 0 && (trustedActor || legacy.toLowerCase() === String(expectedRoleId ?? '').toLowerCase()) ? expectedRoleId : null,
    actorAccount: errors.length === 0 ? legacy : null,
    schemaVersion: 0,
    declaredVersion: null,
    legacy: true,
  };
}

/** Render the only authority fields new review/history carriers may write. */
export function renderReviewRoleCarrier({ roleId, actorAccount, registry }) {
  getWorkflowRole(roleId, registry);
  if (!text(actorAccount)) {
    throw new TypeError('review role carrier Actor account must be non-empty');
  }
  return [
    `- Review role carrier: ${REVIEW_ROLE_CARRIER_VERSION}`,
    `- Role ID: ${roleId}`,
    `- Actor account: ${text(actorAccount)}`,
  ];
}
