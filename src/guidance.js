/**
 * Repository-rules activation-guidance reconciler.
 *
 * Agentic Loop manages exactly one clearly marked, manifest-owned block inside
 * the target project's repository-rules document. Everything outside the marker
 * pair is target-owned and preserved byte-for-byte. Separators added while
 * appending are recorded as part of the owned region, too.
 *
 * This module owns:
 *   - the canonical guidance block and its markers;
 *   - a guidance-specific rules-document target resolver;
 *   - the marker-block reconciler (apply / check / remove planning).
 *
 * Discovering or reading Agentic Loop does not activate the methodology; this
 * block only informs agents of that boundary.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  hashContent,
  loadManifest,
  saveManifest,
  createMarkerBlockEntry,
  createManifest,
  loadPackageVersion,
  resolveManagedPath,
  entryIdentity,
} from './generated-artifacts.js';
import { getDocumentRoleRegistry, findFirstExistingDocumentCandidate } from './document-roles.js';
import { loadProjectMap } from './project-map.js';

export const GUIDANCE_START_MARKER = '<!-- AGENTICLOOP_START -->';
export const GUIDANCE_END_MARKER = '<!-- AGENTICLOOP_END -->';
export const GUIDANCE_OWNER = 'core';
export const GUIDANCE_DEFAULT_RULES_DOC = 'AGENTS.md';

// The canonical activation-guidance block. Newlines are LF; the reconciler
// re-renders line endings to match the target file. There is no trailing
// newline after the end marker so the stored hash stays stable.
export const GUIDANCE_BLOCK = [
  GUIDANCE_START_MARKER,
  '## Agentic Loop',
  '',
  'Agentic Loop is installed in this repository. `agenticloop/` contains the toolkit and `.agenticloop/` contains project-owned workflow state.',
  '',
  'Installation, discovery, or reading the methodology does not activate Agentic Loop. Use the full methodology only when the user explicitly asks for Agentic Loop, invokes its host activation surface, or asks to implement, continue, review, accept, or close a tracked Agentic Loop work unit. Mentioning a task ID for discussion, orientation, or status does not activate it.',
  '',
  'For ordinary questions, fixes, exploration, and one-off changes, follow this rules document directly. Do not create Agentic Loop workflow state for that work. Reading Agentic Loop files to answer a question about them is fine.',
  '',
  'The main agent may use the generated engineer as a normal bounded subagent when that would help. Standalone engineer delegation does not activate Agentic Loop and requires no task ID or task record. Unless the delegation explicitly activates Agentic Loop or names an Agentic Loop task record as its contract, the engineer follows the parent request and repository rules without Agentic Loop bookkeeping.',
  GUIDANCE_END_MARKER,
].join('\n');

export const GUIDANCE_CANONICAL_HASH = hashContent(GUIDANCE_BLOCK);

const RULES_ROLE = 'rules';

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function renderBlockWithNewline(newline) {
  return newline === '\n' ? GUIDANCE_BLOCK : GUIDANCE_BLOCK.replace(/\n/g, newline);
}

/**
 * Locate the single owned marker pair in a document.
 * @returns {{state:'none'} | {state:'malformed', reason:string} |
 *   {state:'present', start:number, end:number, block:string, before:string, after:string}}
 */
export function locateGuidanceBlock(content, startMarker = GUIDANCE_START_MARKER, endMarker = GUIDANCE_END_MARKER) {
  const starts = [];
  const ends = [];
  let index = content.indexOf(startMarker);
  while (index !== -1) { starts.push(index); index = content.indexOf(startMarker, index + 1); }
  index = content.indexOf(endMarker);
  while (index !== -1) { ends.push(index); index = content.indexOf(endMarker, index + 1); }

  if (starts.length === 0 && ends.length === 0) return { state: 'none' };
  if (starts.length !== 1 || ends.length !== 1) {
    return { state: 'malformed', reason: 'duplicate or unbalanced guidance markers' };
  }
  const start = starts[0];
  const endMarkerStart = ends[0];
  if (endMarkerStart < start) return { state: 'malformed', reason: 'guidance end marker precedes start marker' };
  const end = endMarkerStart + endMarker.length;
  return {
    state: 'present',
    start,
    end,
    block: content.slice(start, end),
    before: content.slice(0, start),
    after: content.slice(end),
  };
}

function isMarkdownPath(relPath) {
  return /\.md$/i.test(relPath);
}

/**
 * Guidance-specific rules-document target resolver.
 *
 * Precedence:
 *   1. An explicit `documents.rules` selection in .agenticloop/project.md.
 *   2. An explicitly configured target-project `documents.rules`, when it exists.
 *   3. The first existing candidate from the rules document-role registry.
 *   4. AGENTS.md as the default path to create when no rules document exists.
 *
 * Rejects non-Markdown destinations, paths outside the repository, paths that
 * cross symlinks/junctions, and malformed/empty configured paths.
 *
 * @returns {{ok:true, relPath:string, fullPath:string, source:string, exists:boolean} |
 *   {ok:false, error:string, relPath?:string}}
 */
export function resolveGuidanceRulesTarget(repoRoot, { alConfig = null, projectMap = null } = {}) {
  const map = projectMap ?? loadProjectMap(repoRoot);
  const explicitProjectRules = map?.raw?.documents?.rules;
  const explicitConfigRules = alConfig?.documents?.rules;

  let relPath = null;
  let source = null;

  if (typeof explicitProjectRules === 'string' && explicitProjectRules.trim()) {
    relPath = explicitProjectRules.trim();
    source = 'project-map';
  } else if (typeof explicitConfigRules === 'string' && explicitConfigRules.trim() &&
    existsSync(join(repoRoot, explicitConfigRules.trim()))) {
    relPath = explicitConfigRules.trim();
    source = 'config';
  } else {
    const registry = getDocumentRoleRegistry(alConfig);
    const rulesRole = registry[RULES_ROLE];
    const detected = rulesRole ? findFirstExistingDocumentCandidate(repoRoot, rulesRole) : null;
    if (detected) {
      relPath = detected;
      source = 'registry';
    } else {
      relPath = GUIDANCE_DEFAULT_RULES_DOC;
      source = 'default';
    }
  }

  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { ok: false, error: 'guidance rules target is empty or malformed' };
  }
  const normalized = relPath.replace(/\\/g, '/').trim();
  if (!isMarkdownPath(normalized)) {
    return { ok: false, error: `guidance rules target must be a Markdown (.md) document: ${normalized}`, relPath: normalized };
  }
  let fullPath;
  try {
    fullPath = resolveManagedPath(repoRoot, '.', normalized);
  } catch (error) {
    return { ok: false, error: `guidance rules target is unsafe: ${error.message}`, relPath: normalized };
  }
  return { ok: true, relPath: normalized, fullPath, source, exists: existsSync(fullPath) };
}

function findOwnedMarkerEntries(manifest) {
  if (!manifest) return [];
  return manifest.entries.filter(entry =>
    entry.kind === 'marker-block' &&
    entry.adapter === GUIDANCE_OWNER &&
    entry.outputRoot === '.' &&
    entry.startMarker === GUIDANCE_START_MARKER &&
    entry.endMarker === GUIDANCE_END_MARKER
  );
}

function findOwnedMarkerEntry(manifest, relPath) {
  return findOwnedMarkerEntries(manifest).find(entry => entry.relPath === relPath) ?? null;
}

function resolveEntryTarget(repoRoot, entry) {
  try {
    const fullPath = resolveManagedPath(repoRoot, entry.outputRoot, entry.relPath);
    return { ok: true, relPath: entry.relPath, fullPath, exists: existsSync(fullPath) };
  } catch (error) {
    return { ok: false, error: `owned guidance path is unsafe: ${error.message}`, relPath: entry.relPath };
  }
}

/**
 * Non-mutating guidance status.
 *
 * status is one of:
 *   unsafe-path, malformed, current, stale, modified, manual, absent
 */
export function checkGuidance(repoRoot, options = {}) {
  const target = resolveGuidanceRulesTarget(repoRoot, options);
  if (!target.ok) {
    return { status: 'unsafe-path', message: target.error, relPath: target.relPath ?? null };
  }
  let manifest;
  try { manifest = loadManifest(repoRoot); } catch (error) {
    return { status: 'malformed-manifest', message: error.message, relPath: target.relPath, owned: false, source: target.source };
  }
  const entries = findOwnedMarkerEntries(manifest);
  if (entries.length > 1) {
    return { status: 'multiple-owned', message: 'multiple owned guidance entries are recorded; refusing ambiguous guidance operations', relPath: target.relPath, owned: true, source: target.source };
  }
  const entry = entries[0] ?? null;
  if (entry && entry.relPath !== target.relPath) {
    return { status: 'path-mismatch', message: `owned guidance is recorded at ${entry.relPath}, not resolved rules document ${target.relPath}`, relPath: target.relPath, owned: true, source: target.source, ownedRelPath: entry.relPath };
  }
  const content = target.exists ? readFileSync(target.fullPath, 'utf8') : '';
  const located = locateGuidanceBlock(content);

  if (located.state === 'malformed') {
    return { status: 'malformed', message: located.reason, relPath: target.relPath, owned: Boolean(entry), source: target.source };
  }

  if (entry) {
    if (located.state === 'none') {
      return { status: 'absent', message: 'owned guidance block is recorded but missing from the rules document', relPath: target.relPath, owned: true, source: target.source };
    }
    const onDiskHash = hashContent(normalizeNewlines(located.block));
    if (onDiskHash !== entry.hash) {
      return { status: 'modified', message: 'managed guidance block was modified since generation', relPath: target.relPath, owned: true, source: target.source };
    }
    if (entry.hash === GUIDANCE_CANONICAL_HASH) {
      return { status: 'current', message: 'guidance block is current and owned', relPath: target.relPath, owned: true, source: target.source };
    }
    return { status: 'stale', message: 'guidance block is owned, unchanged, and refreshable', relPath: target.relPath, owned: true, source: target.source };
  }

  // No manifest ownership.
  if (located.state === 'present') {
    return { status: 'manual', message: 'an unowned guidance marker block is present; it will not be adopted automatically', relPath: target.relPath, owned: false, source: target.source };
  }
  return { status: 'absent', message: 'no guidance block is installed', relPath: target.relPath, owned: false, source: target.source };
}

function appendBlock(content, renderedBlock, newline) {
  if (content === '') return { content: renderedBlock + newline, ownedPrefix: '', ownedSuffix: newline };
  const ownedPrefix = content.endsWith(newline) ? newline : newline + newline;
  const ownedSuffix = newline;
  return { content: content + ownedPrefix + renderedBlock + ownedSuffix, ownedPrefix, ownedSuffix };
}

function atomicWriteFile(fullPath, content) {
  mkdirSync(dirname(fullPath), { recursive: true });
  const temporary = `${fullPath}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content); renameSync(temporary, fullPath); }
  finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
}

/**
 * Apply (create / append / refresh) the guidance block.
 *
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {boolean} [options.force]        Refresh a user-modified owned block or adopt an unowned block.
 * @param {boolean} [options.refreshOnly]  Only refresh an already-owned block; never create, append, or adopt.
 * @returns {{ ok:boolean, status:string, action:string, relPath:string|null, message:string,
 *   createdFile?:boolean, changed:boolean, warnings:string[] }}
 */
export function applyGuidance(repoRoot, options = {}) {
  const { force = false, refreshOnly = false, packageVersion = loadPackageVersion() } = options;
  const write = options.writeFile ?? atomicWriteFile;
  const persistManifest = options.saveManifest ?? saveManifest;
  const warnings = [];
  const target = resolveGuidanceRulesTarget(repoRoot, options);
  if (!target.ok) {
    return { ok: false, status: 'unsafe-path', action: 'blocked', relPath: target.relPath ?? null, message: target.error, changed: false, warnings };
  }

  let manifest;
  try { manifest = loadManifest(repoRoot) ?? createManifest(packageVersion); } catch (error) {
    return { ok: false, status: 'malformed-manifest', action: 'blocked', relPath: target.relPath, message: error.message, changed: false, warnings };
  }
  const ownedEntries = findOwnedMarkerEntries(manifest);
  if (ownedEntries.length > 1) {
    return { ok: false, status: 'multiple-owned', action: 'blocked', relPath: target.relPath, message: 'multiple owned guidance entries are recorded; refusing ambiguous guidance operations', changed: false, warnings };
  }
  const priorEntry = ownedEntries[0] ?? null;
  if (priorEntry && priorEntry.relPath !== target.relPath) {
    return { ok: false, status: 'path-mismatch', action: 'blocked', relPath: target.relPath, message: `owned guidance remains at ${priorEntry.relPath}; resolve or remove it before applying to ${target.relPath}`, changed: false, warnings };
  }
  const entry = priorEntry;
  const fileExists = target.exists;
  const content = fileExists ? readFileSync(target.fullPath, 'utf8') : '';
  const newline = fileExists && content ? detectNewline(content) : '\n';
  const renderedBlock = renderBlockWithNewline(newline);
  const located = locateGuidanceBlock(content);

  const result = (status, action, changed, message, extra = {}) => ({
    ok: status !== 'unsafe-path' && action !== 'blocked', status, action, relPath: target.relPath, message, changed, warnings, ...extra,
  });

  if (located.state === 'malformed') {
    return { ok: false, status: 'malformed', action: 'blocked', relPath: target.relPath, message: located.reason, changed: false, warnings };
  }

  // Decide the new content and whether we own the result.
  let newContent = null;
  let createdFile = false;
  let ownedPrefix = '';
  let ownedSuffix = '';
  let action;
  let status;

  if (entry) {
    // Owned block.
    if (located.state === 'none') {
      // Owned entry but block missing on disk. Re-apply if allowed.
      if (refreshOnly) {
        ({ content: newContent, ownedPrefix, ownedSuffix } = appendBlock(content, renderedBlock, newline));
        createdFile = !fileExists;
        action = 'refreshed';
        status = 'stale';
      } else {
        if (fileExists) ({ content: newContent, ownedPrefix, ownedSuffix } = appendBlock(content, renderedBlock, newline));
        else { newContent = renderedBlock + newline; ownedSuffix = newline; }
        createdFile = !fileExists;
        action = fileExists ? 'appended' : 'created';
        status = 'absent';
      }
    } else {
      const onDiskHash = hashContent(normalizeNewlines(located.block));
      if (onDiskHash === entry.hash) {
        if (entry.hash === GUIDANCE_CANONICAL_HASH) {
          return result('current', 'unchanged', false, 'guidance block already current');
        }
        // Stale but unchanged: refresh in place.
        newContent = located.before + renderedBlock + located.after;
        createdFile = entry.createdFile;
        ownedPrefix = entry.ownedPrefix ?? '';
        ownedSuffix = entry.ownedSuffix ?? '';
        action = 'refreshed';
        status = 'stale';
      } else if (force) {
        newContent = located.before + renderedBlock + located.after;
        createdFile = entry.createdFile;
        ownedPrefix = entry.ownedPrefix ?? '';
        ownedSuffix = entry.ownedSuffix ?? '';
        action = 'force-refreshed';
        status = 'modified';
      } else {
        warnings.push(`Managed guidance in ${target.relPath} was modified and was not refreshed. Re-run with --force to replace it.`);
        return result('modified', 'preserved', false, 'managed guidance block was modified; preserved');
      }
    }
  } else {
    // No ownership.
    if (located.state === 'present') {
      // Unowned marker block: never adopt silently.
      if (!force) {
        warnings.push(`An unowned guidance marker block exists in ${target.relPath}; it was preserved. Re-run with --force to adopt it.`);
        return result('manual', 'preserved', false, 'unowned guidance marker block preserved (collision)');
      }
      newContent = located.before + renderedBlock + located.after;
      createdFile = false;
      ownedPrefix = '';
      ownedSuffix = '';
      action = 'adopted';
      status = 'manual';
    } else if (refreshOnly) {
      // Existing installation without an owned block must not be enrolled.
      return result('absent', 'skipped', false, 'no owned guidance block; existing installation left unchanged');
    } else if (!fileExists) {
      newContent = renderedBlock + '\n';
      createdFile = true;
      ownedSuffix = '\n';
      action = 'created';
      status = 'absent';
    } else {
      ({ content: newContent, ownedPrefix, ownedSuffix } = appendBlock(content, renderedBlock, newline));
      createdFile = false;
      action = 'appended';
      status = 'absent';
    }
  }

  // Persist atomically: write the file, then the manifest. Roll back the file
  // if the manifest write fails.
  const nextEntry = createMarkerBlockEntry({
    owner: GUIDANCE_OWNER,
    relPath: target.relPath,
    startMarker: GUIDANCE_START_MARKER,
    endMarker: GUIDANCE_END_MARKER,
    hash: GUIDANCE_CANONICAL_HASH,
    createdFile,
    ownedPrefix,
    ownedSuffix,
    existence: entry ? 'refreshed' : 'created',
  });
  const nextManifest = {
    ...manifest,
    entries: [...manifest.entries.filter(e => entryIdentity(e) !== entryIdentity(nextEntry)), nextEntry],
  };

  const previousBytes = fileExists ? readFileSync(target.fullPath) : null;
  try {
    write(target.fullPath, newContent);
  } catch (error) {
    return { ok: false, status: 'error', action: 'blocked', relPath: target.relPath, message: `guidance rules-file write failed: ${error.message}`, changed: false, warnings };
  }
  try {
    persistManifest(repoRoot, nextManifest);
  } catch (error) {
    // Roll the rules document back to its prior state.
    if (previousBytes !== null) atomicWriteFile(target.fullPath, previousBytes);
    else if (existsSync(target.fullPath)) rmSync(target.fullPath, { force: true });
    return { ok: false, status: 'error', action: 'rolled-back', relPath: target.relPath, message: `guidance manifest write failed: ${error.message}`, changed: false, warnings };
  }

  return result(status, action, true, `guidance ${action} in ${target.relPath}`, { createdFile });
}

/**
 * Remove a safely owned guidance block. Idempotent.
 *
 * @returns {{ ok:boolean, status:string, action:string, relPath:string|null, message:string,
 *   changed:boolean, warnings:string[] }}
 */
export function removeGuidance(repoRoot, options = {}) {
  const warnings = [];
  const write = options.writeFile ?? atomicWriteFile;
  const persistManifest = options.saveManifest ?? saveManifest;
  const target = resolveGuidanceRulesTarget(repoRoot, options);
  if (!target.ok) {
    return { ok: false, status: 'unsafe-path', action: 'blocked', relPath: target.relPath ?? null, message: target.error, changed: false, warnings };
  }
  let manifest;
  try { manifest = loadManifest(repoRoot); } catch (error) {
    return { ok: false, status: 'malformed-manifest', action: 'blocked', relPath: target.relPath, message: error.message, changed: false, warnings };
  }
  const entries = findOwnedMarkerEntries(manifest);
  if (entries.length > 1) {
    return { ok: false, status: 'multiple-owned', action: 'blocked', relPath: target.relPath, message: 'multiple owned guidance entries are recorded; refusing ambiguous guidance operations', changed: false, warnings };
  }
  const entry = entries[0] ?? null;
  if (!entry) {
    return { ok: true, status: 'absent', action: 'noop', relPath: target.relPath, message: 'no owned guidance block to remove', changed: false, warnings };
  }
  const entryTarget = resolveEntryTarget(repoRoot, entry);
  if (!entryTarget.ok) return { ok: false, status: 'unsafe-path', action: 'blocked', relPath: entryTarget.relPath, message: entryTarget.error, changed: false, warnings };
  const fileExists = entryTarget.exists;
  const content = fileExists ? readFileSync(entryTarget.fullPath, 'utf8') : '';

  const dropEntry = () => {
    const remaining = manifest.entries.filter(e => entryIdentity(e) !== entryIdentity(entry));
    if (remaining.length) persistManifest(repoRoot, { ...manifest, entries: remaining });
    else {
      const manifestPath = resolveManagedPath(repoRoot, '.', '.agenticloop/generated-artifacts.json');
      if (existsSync(manifestPath)) rmSync(manifestPath, { force: true });
    }
  };

  const plan = computeGuidanceRemoval(content, entry, { allowModified: Boolean(options.force) });
  if (plan.outcome === 'absent') {
    dropEntry();
    return { ok: true, status: 'absent', action: 'noop', relPath: entry.relPath, message: 'owned guidance block already absent; ownership released', changed: false, warnings };
  }
  if (plan.outcome === 'modified') {
    warnings.push(`Managed guidance in ${target.relPath} was modified and was not removed. Re-run with --force to remove it.`);
    return { ok: true, status: 'modified', action: 'preserved', relPath: entry.relPath, message: 'managed guidance block was modified; preserved', changed: false, warnings };
  }
  if (plan.outcome === 'malformed' || !['rewrite', 'delete'].includes(plan.outcome)) {
    return { ok: false, status: 'blocked', action: 'blocked', relPath: entry.relPath, message: `unknown or unsafe guidance removal plan: ${plan.outcome}`, changed: false, warnings };
  }
  const previousBytes = readFileSync(entryTarget.fullPath);

  try {
    if (plan.outcome === 'delete') {
      rmSync(entryTarget.fullPath, { force: true });
    } else if (plan.outcome === 'rewrite') {
      write(entryTarget.fullPath, plan.content);
    }
  } catch (error) {
    return { ok: false, status: 'error', action: 'blocked', relPath: entry.relPath, message: `guidance rules-file write failed: ${error.message}`, changed: false, warnings };
  }
  try {
    dropEntry();
  } catch (error) {
    try { write(entryTarget.fullPath, previousBytes); } catch { /* Preserve the manifest error. */ }
    return { ok: false, status: 'error', action: 'rolled-back', relPath: entry.relPath, message: `guidance manifest write failed: ${error.message}`, changed: false, warnings };
  }
  const deleted = plan.outcome === 'delete';
  return {
    ok: true,
    status: 'removed',
    action: deleted ? 'deleted-file' : 'removed-block',
    relPath: entry.relPath,
    message: deleted ? `removed guidance block and deleted ${entry.relPath}` : `removed owned guidance block from ${entry.relPath}`,
    changed: true,
    warnings,
  };
}

/**
 * Compute the result of removing an owned guidance block from content.
 * Pure: performs no I/O. Used by both `guidance remove` and manifest-first
 * `agenticloop remove`.
 *
 * @returns {{outcome:'absent'|'modified'|'delete'} | {outcome:'rewrite', content:string}}
 */
export function computeGuidanceRemoval(content, entry, { allowModified = false } = {}) {
  const located = locateGuidanceBlock(content, entry.startMarker, entry.endMarker);
  if (located.state === 'malformed') return { outcome: 'malformed' };
  if (located.state !== 'present') return { outcome: 'absent' };
  const onDiskHash = hashContent(normalizeNewlines(located.block));
  const modified = onDiskHash !== entry.hash;
  if (modified && !allowModified) return { outcome: 'modified' };
  let start = located.start;
  let end = located.end;
  // Only remove separators whose exact bytes were recorded as generated. For a
  // modified block this remains conservative: unmatched surrounding bytes stay.
  const ownedPrefix = entry.ownedPrefix ?? '';
  const ownedSuffix = entry.ownedSuffix ?? '';
  if (ownedPrefix && content.slice(start - ownedPrefix.length, start) === ownedPrefix) start -= ownedPrefix.length;
  if (ownedSuffix && content.slice(end, end + ownedSuffix.length) === ownedSuffix) end += ownedSuffix.length;
  const remaining = content.slice(0, start) + content.slice(end);
  if (entry.createdFile && remaining === '') return { outcome: 'delete' };
  return { outcome: 'rewrite', content: remaining };
}
