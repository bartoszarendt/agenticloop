/** Canonical task-contract carrier adapter for GitHub REST and GraphQL comments. */

import { createHash } from 'node:crypto';

export const GITHUB_TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Carrier authority states. Only `trusted_immutable` carriers may promote a
 * record into the trusted chain; every other state is a structured,
 * non-promoting classification.
 *
 * - trusted_immutable:    association and allowlist accepted, required metadata complete, unedited.
 * - trusted_but_invalid:  assigned during promotion when a trusted_immutable
 *                         carrier's record payload violates the record contract (fatal).
 * - edited_authority:     otherwise trusted authority, but the carrier was edited.
 * - untrusted_association: author is not OWNER, MEMBER, or COLLABORATOR (noise).
 * - not_allowlisted:      trusted association, but the configured allowlist excludes the author (noise).
 * - incomplete_carrier:   the backend response lacks metadata needed to decide authority (adapter error).
 */
export const CARRIER_STATES = Object.freeze([
  'trusted_immutable',
  'trusted_but_invalid',
  'edited_authority',
  'untrusted_association',
  'not_allowlisted',
  'incomplete_carrier',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

function association(value) {
  return text(value).replace(/[ -]+/g, '_').toUpperCase();
}

/**
 * Normalize a REST issue-comment object or a GraphQL/`gh --json` comment.
 * Missing trust fields are retained as explicit normalization errors; callers
 * must validate those errors rather than inferring authority from a payload.
 * Login comparisons are case-insensitive; the canonical display casing is
 * preserved on `author`.
 */
export function normalizeGitHubCommentCarrier(comment, { trustedActors = null } = {}) {
  const source = comment && typeof comment === 'object' ? comment : {};
  const id = text(source.databaseId ?? source.id);
  const author = text(source.user?.login ?? source.author?.login ?? source.author);
  const authorAssociation = association(source.author_association ?? source.authorAssociation);
  const createdAt = text(source.created_at ?? source.createdAt);
  const updatedAt = text(source.updated_at ?? source.updatedAt);
  const url = text(source.html_url ?? source.url);
  const body = typeof source.body === 'string' ? source.body : '';
  const errors = [];
  if (!id) errors.push('carrier id is missing');
  if (!author) errors.push('carrier author is missing');
  if (!authorAssociation) errors.push('carrier author association is missing');
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) errors.push('carrier creation timestamp is missing or invalid');
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) errors.push('carrier update timestamp is missing or invalid');
  if (!url) errors.push('carrier url is missing');
  if (typeof source.body !== 'string') errors.push('carrier body is missing');
  const edited = source.includesCreatedEdit === true ||
    (Boolean(createdAt && updatedAt) && Date.parse(createdAt) !== Date.parse(updatedAt));
  const verifiedRepositoryAssociation = GITHUB_TRUSTED_ASSOCIATIONS.has(authorAssociation);
  if (authorAssociation && !verifiedRepositoryAssociation) errors.push(`carrier author association '${authorAssociation}' is not trusted`);
  const allowed = Array.isArray(trustedActors) ? new Set(trustedActors.map(value => text(value).toLowerCase()).filter(Boolean)) : null;
  if (allowed?.size && !allowed.has(author.toLowerCase())) errors.push(`carrier author '${author}' is not in the configured trusted-actor allowlist`);
  const authorityState =
    !id || !author || !authorAssociation || !createdAt || !updatedAt || !url || typeof source.body !== 'string' ||
      Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))
      ? 'incomplete_carrier'
      : !verifiedRepositoryAssociation
        ? 'untrusted_association'
        : allowed?.size && !allowed.has(author.toLowerCase())
          ? 'not_allowlisted'
          : edited
            ? 'edited_authority'
            : 'trusted_immutable';
  return {
    id,
    kind: 'github_issue_comment',
    url,
    author,
    authorAssociation,
    createdAt,
    updatedAt,
    edited,
    body,
    bodyDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
    verifiedRepositoryAssociation,
    authorityState,
    verifiedAuthority: authorityState === 'trusted_immutable',
    sourceShape: source.user ? 'rest' : source.author ? 'graphql' : 'unknown',
    normalizationErrors: errors,
  };
}

export function normalizeGitHubCommentCarriers(comments, options) {
  return (Array.isArray(comments) ? comments : []).map(comment => normalizeGitHubCommentCarrier(comment, options));
}
