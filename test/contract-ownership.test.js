/**
 * Contract-ownership regression guard.
 *
 * Detects high-risk drift where a canonical invariant is either duplicated
 * across the runtime surface or missing from its single owner. It checks
 * distinctive required/forbidden snippets and ownership counts rather than
 * snapshotting whole documents.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKILLS_DIR = join(REPO_ROOT, 'skills');

function read(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

function skillNames() {
  return readdirSync(SKILLS_DIR).filter(name =>
    existsSync(join(SKILLS_DIR, name, 'SKILL.md'))
  );
}

// Canonical runtime documents: methodology, roles, backends, skills.
function canonicalRuntimeFiles() {
  const files = [{ rel: 'AGENTIC_LOOP.md', body: read('AGENTIC_LOOP.md') }];
  for (const f of readdirSync(join(REPO_ROOT, 'agents')).filter(n => n.endsWith('.md'))) {
    files.push({ rel: `agents/${f}`, body: read(`agents/${f}`) });
  }
  for (const f of readdirSync(join(REPO_ROOT, 'backends')).filter(n => n.endsWith('.md'))) {
    files.push({ rel: `backends/${f}`, body: read(`backends/${f}`) });
  }
  for (const name of skillNames()) {
    files.push({ rel: `skills/${name}/SKILL.md`, body: read(`skills/${name}/SKILL.md`) });
  }
  return files;
}

function ownersOf(predicate) {
  return canonicalRuntimeFiles().filter(f => predicate(f.body)).map(f => f.rel);
}

describe('contract ownership', () => {
  it('only the event-logging skill holds the complete command-resolution recipe', () => {
    const owners = ownersOf(body => body.includes('run `npx agenticloop --help`'));
    assert.deepEqual(owners, ['skills/event-logging/SKILL.md'], owners.join(', '));
  });

  it('only role-delegation holds the full delegation status template', () => {
    // The template lists "- Host delegation check:" and "- Consequence:" together.
    const owners = ownersOf(body =>
      /^- Host delegation check:/m.test(body) && /^- Consequence:/m.test(body)
    );
    assert.deepEqual(owners, ['skills/role-delegation/SKILL.md'], owners.join(', '));
  });

  it('AGENTIC_LOOP.md holds the full bounded-discovery invariant', () => {
    const body = read('AGENTIC_LOOP.md');
    assert.match(body, /### Normative context \(closed\)/);
    assert.match(body, /### Bounded implementation discovery \(permitted by default\)/);
    assert.match(body, /### Arbitrary context loading \(prohibited\)/);
    assert.match(body, /at most six previously unnamed paths or symbol bodies/);
    // And nowhere else.
    const owners = ownersOf(b => b.includes('at most six previously unnamed paths or symbol bodies'));
    assert.deepEqual(owners, ['AGENTIC_LOOP.md'], owners.join(', '));
  });

  it('role files carry required references but not copied canonical blocks', () => {
    const orchestrator = read('agents/orchestrator.md');
    assert.match(orchestrator, /\[\[role-delegation\]\]/, 'orchestrator must reference role-delegation');
    assert.ok(
      !/^- Host delegation check:/m.test(orchestrator),
      'orchestrator must not copy the delegation status template'
    );
    for (const role of ['orchestrator', 'maintainer', 'engineer']) {
      const body = read(`agents/${role}.md`);
      assert.match(body, /\[\[event-logging\]\]/, `${role} must reference event-logging`);
      assert.ok(
        !body.includes('run `npx agenticloop --help`'),
        `${role} must not copy the event-logging recipe`
      );
    }
  });

  it('keeps detailed review policy in review-and-accept and projections in backends', () => {
    const owner = read('skills/review-and-accept/SKILL.md');
    assert.match(owner, /host_subagent/);
    assert.match(owner, /independent_human/);
    assert.match(owner, /reviewed_artifact/);
    assert.match(owner, /single_agent_fallback/);
    assert.match(read('AGENTIC_LOOP.md'), /exact artifact revision reviewed/);
    assert.match(read('agents/maintainer.md'), /\[\[review-and-accept\]\]/);
    assert.doesNotMatch(read('agents/maintainer.md'), /host_subagent.*explicit_agent_invocation.*single_agent_fallback/s);
    const files = read('backends/files.md');
    const github = read('backends/github.md');
    assert.match(files, /reviewed_artifact/);
    assert.match(github, /AGENT_REVIEW_ARTIFACT/);
    assert.match(github, /github-review-audit/);
    assert.match(owner, /same-session fallback does not/);
  });

  it('keeps the detailed pre-merge gate in backends/github.md and references it elsewhere', () => {
    // The detailed "Pre-Merge Readiness Gate" section (a Markdown heading) is
    // owned by the GitHub backend doc; other files reference it by name only.
    const gateOwners = ownersOf(body => /^### Pre-Merge Readiness Gate$/m.test(body));
    assert.deepEqual(gateOwners, ['backends/github.md'], gateOwners.join(', '));

    const github = read('backends/github.md');
    assert.match(github, /npx agenticloop github-ready --pr/);

    // The composite gate is discoverable from the roles/skills that gate merge
    // and closeout, by reference rather than by copied procedure.
    assert.match(read('agents/orchestrator.md'), /github-ready/);
    assert.match(read('skills/review-and-accept/SKILL.md'), /github-ready/);
    assert.match(read('skills/task-closeout/SKILL.md'), /github-ready/);
  });

  it('review-and-accept owns the detailed Maintainer Review Fixup procedure', () => {
    // The detailed section (a Markdown heading) lives only in the skill; other
    // files reference the feature by name without restating the procedure.
    const sectionOwners = ownersOf(body => /^## Maintainer Review Fixup$/m.test(body));
    assert.deepEqual(sectionOwners, ['skills/review-and-accept/SKILL.md'], sectionOwners.join(', '));

    const owner = read('skills/review-and-accept/SKILL.md');
    // The eligibility gate and its critical invariants live in the owner.
    assert.match(owner, /### Eligibility gate/);
    assert.match(owner, /one fully understood finding\s+and one coherent edit packet/);
    // Independent-review tasks are rejected by the canonical procedure.
    assert.match(owner, /`independent_review_required` is not `true`/);
    // The canonical procedure requires single_agent_fallback provenance.
    assert.match(owner, /`review_mode: single_agent_fallback`/);
    // Missing pre-existing evidence is not fixup-eligible.
    assert.match(owner, /missing.*(summary|evidence).*not fixup-eligible/i);
  });

  it('orders GitHub fixup evidence, review, and readiness gates correctly', () => {
    const owner = read('skills/review-and-accept/SKILL.md');
    const start = owner.indexOf('\n## Maintainer Review Fixup\n');
    const end = owner.indexOf('\n## Re-review handoff', start);
    assert.ok(start >= 0 && end > start, 'expected canonical fixup section');
    const fixup = owner.slice(start, end);

    const refresh = fixup.indexOf('Refresh the canonical implementation summary and evidence');
    const preflight = fixup.indexOf('github-preflight --pr <number>');
    const accepted = fixup.indexOf('If accepted, append');
    const ready = fixup.indexOf('`github-ready`');
    assert.ok(refresh >= 0 && preflight > refresh,
      'final-head evidence must be refreshed before github-preflight');
    assert.ok(accepted > preflight,
      'acceptance must follow final-head preflight');
    assert.ok(ready > accepted,
      'github-ready must run only after accepted current-head markers are durable');
  });

  it('methodology, roles, and delegation reference the Maintainer Review Fixup', () => {
    for (const rel of [
      'AGENTIC_LOOP.md',
      'agents/maintainer.md',
      'agents/orchestrator.md',
      'skills/role-delegation/SKILL.md',
    ]) {
      assert.match(read(rel), /Maintainer Review Fixup/, `${rel} must reference the feature`);
    }
  });

  it('maintainer edit boundary carries the bounded fixup exception', () => {
    const maintainer = read('agents/maintainer.md');
    // The absolute prohibition retains a single named exception.
    assert.match(maintainer, /Do not edit implementation files\. The only exception is one bounded Maintainer\s+Review Fixup/);
    const eventSection = maintainer.slice(maintainer.indexOf('## Event Logging'));
    assert.match(eventSection, /`check\.run`/,
      'maintainer-owned fixup verification must emit check.run');
  });

  it('backend docs project the fixup without new schema', () => {
    const github = read('backends/github.md');
    const files = read('backends/files.md');
    assert.match(github, /Maintainer Review Fixup \(GitHub projection\)/);
    assert.match(github, /AGENT_REVIEW_MODE: single_agent_fallback/);
    assert.match(github, /editable PR comment/);
    const fixupStart = github.indexOf('#### Maintainer Review Fixup (GitHub projection)');
    const fixupEnd = github.indexOf('\n### ', fixupStart);
    const githubFixup = github.slice(fixupStart, fixupEnd);
    assert.ok(githubFixup.indexOf('github-preflight --pr <number>') < githubFixup.indexOf('Post the accepted review markers'),
      'GitHub fixup preflight must precede accepted markers');
    assert.ok(githubFixup.indexOf('Post the accepted review markers') < githubFixup.indexOf('github-ready --pr <number>'),
      'GitHub fixup ready gate must follow accepted markers');
    assert.match(files, /Maintainer Review Fixup \(files projection\)/);
    assert.match(files, /review_mode: single_agent_fallback/);
  });

  it('the fixup introduces no new review mode or frontmatter field', () => {
    // Fail closed against schema creep the feature explicitly forbids.
    for (const { rel, body } of canonicalRuntimeFiles()) {
      assert.ok(!body.includes('AGENT_REVIEW_FIXUP_COMMITS'), `${rel} must not add AGENT_REVIEW_FIXUP_COMMITS`);
      assert.ok(!body.includes('review_fixup_commits'), `${rel} must not add review_fixup_commits`);
      assert.ok(!body.includes('fixups_allowed'), `${rel} must not add a fixups_allowed knob`);
    }
  });

  it('every referenced skill exists', () => {
    const known = new Set(skillNames());
    // Documentation placeholder used to explain the [[skill-name]] convention.
    const placeholders = new Set(['skill-name']);
    for (const { rel, body } of canonicalRuntimeFiles()) {
      const refs = body.match(/\[\[([a-z0-9-]+)\]\]/g) ?? [];
      for (const ref of refs) {
        const name = ref.slice(2, -2);
        if (placeholders.has(name)) continue;
        assert.ok(known.has(name), `${rel} references missing skill [[${name}]]`);
      }
    }
  });
});
