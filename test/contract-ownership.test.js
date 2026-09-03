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
    const end = owner.indexOf('\n## Review handoff', start);
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

  it('AGENTIC_LOOP.md owns the full Project Operating Facts definition', () => {
    const body = read('AGENTIC_LOOP.md');
    assert.match(body, /^## Project Operating Facts$/m);
    assert.match(body, /### Recognition test/);
    assert.match(body, /not already explicit or cheaply discoverable/);
    assert.match(body, /Never retain the empty-state sentence beside\s+active `PF-\.\.\.` entries/);
    // The distinctive recognition-test phrasing lives only in the methodology.
    const recognitionOwners = ownersOf(b => b.includes('not already explicit or cheaply discoverable'));
    assert.deepEqual(recognitionOwners, ['AGENTIC_LOOP.md'], recognitionOwners.join(', '));
    // The routing ladder lives only in the methodology, too.
    const routingOwners = ownersOf(b =>
      b.includes('Personal preference spanning repositories | Host memory outside Agentic Loop')
    );
    assert.deepEqual(routingOwners, ['AGENTIC_LOOP.md'], routingOwners.join(', '));
  });

  it('maintainer owns Project Operating Facts profile mutation', () => {
    const maintainer = read('agents/maintainer.md');
    assert.match(maintainer, /Own the current mutable `## Project Operating Facts` profile/);
    assert.match(maintainer, /`## Project Operating Facts` profiles as authorized mutable state/);
  });

  it('engineer reports Project Operating Fact candidates without editing shared state', () => {
    const engineer = read('agents/engineer.md');
    assert.match(engineer, /Project Operating Fact candidate/);
    assert.match(engineer, /do not edit the\s+shared `## Project Operating Facts` profile/);
    assert.match(engineer, /from an\s+implementation lane/);
    assert.ok(
      !engineer.includes('Own the current mutable `## Project Operating Facts` profile'),
      'engineer must not claim maintainer profile ownership'
    );
  });

  it('orchestrator owns the human-facing Project Operating Facts capture offer', () => {
    const orchestrator = read('agents/orchestrator.md');
    assert.match(orchestrator, /deduplicated\s+capture offer/);
    assert.ok(
      !orchestrator.includes('Own the current mutable `## Project Operating Facts` profile'),
      'orchestrator must not own profile mutation'
    );
  });

  it('role files reference the Project Operating Facts definition without copying it', () => {
    for (const role of ['orchestrator', 'maintainer', 'engineer']) {
      const body = read(`agents/${role}.md`);
      assert.match(body, /Project Operating Fact/, `${role} must carry the concise trigger`);
      assert.ok(
        !body.includes('not already explicit or cheaply discoverable'),
        `${role} must not copy the canonical recognition test`
      );
      assert.ok(
        !/^### Recognition test$/m.test(body),
        `${role} must not copy the canonical recognition-test section`
      );
    }
  });

  it('reserves parallel Project Operating Facts mutation for an exclusively owned maintainer lane or serial join', () => {
    const methodology = read('AGENTIC_LOOP.md');
    const parallel = read('skills/parallel-delegation/SKILL.md');
    for (const [label, body] of [
      ['methodology', methodology],
      ['parallel delegation', parallel],
    ]) {
      assert.match(body, /engineer implementation lanes do not append or edit\s+Project\s+Operating Facts/i,
        `${label} must keep engineer lanes read-only for the shared profile`);
      assert.match(body, /maintainer-owned\s+coordination\s+lane may mutate the profile only when the concurrency plan grants\s+it explicit\s+exclusive ownership/,
        `${label} must name the exclusive maintainer-lane exception`);
      assert.match(body, /serial maintainer-owned join step applies\s+approved facts/,
        `${label} must retain the serial-join fallback`);
    }
  });

  it('keeps the complete managed-join law in parallel-delegation while roles and backends project local duties', () => {
    const owners = ownersOf(body => /^## Managed Join$/m.test(body));
    assert.deepEqual(owners, ['skills/parallel-delegation/SKILL.md'], owners.join(', '));

    const parallel = read('skills/parallel-delegation/SKILL.md');
    assert.match(parallel, /Maintainer alone classifies code\/collision joinability/i);
    assert.match(parallel, /Orchestrator verifies the supplied required inputs/i);
    assert.match(parallel, /dedicated backend-neutral task/i);
    assert.match(parallel, /fresh full ordered Lens 1, Lens 2, and Lens 3 review/i);
    assert.match(parallel, /reconciliation event, role, or budget/i);

    assert.match(read('agents/orchestrator.md'), /managed join/i);
    assert.match(read('agents/maintainer.md'), /Maintainer alone classifies code\/collision/);
    assert.match(read('agents/engineer.md'), /Reconcile a managed join/i);
    assert.match(read('backends/files.md'), /dedicated files-backed join task/i);
    assert.match(read('backends/github.md'), /dedicated join task has its own issue, branch, and/i);
  });

  it('rejects stale disjoint-files mirrors and preserves canonical role duties', () => {
    for (const rel of [
      'agents/orchestrator.md',
      'agents/maintainer.md',
      'backends/files.md',
      'backends/github.md',
    ]) {
      assert.doesNotMatch(
        read(rel),
        /disjoint (?:expected|allowed) files or areas/i,
        `${rel} must not restore the retired scope-ceiling hard gate`
      );
    }
    assert.match(read('agents/maintainer.md'), /fill \[\[task-record-contract\]\] `## Parallel Safety` with owned paths\/backend objects/i);
    assert.match(read('agents/maintainer.md'), /one bounded read-only pass/i);
    assert.match(read('agents/orchestrator.md'), /reassess source proposals against current records\s+and repository state/i);
    assert.match(read('agents/orchestrator.md'), /knowledge independence plus either disjoint structured\s+exclusive ownership or a valid managed-join plan/i);
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

  it('keeps files role start and blocked-return authority unambiguous', () => {
    for (const rel of [
      'AGENTIC_LOOP.md',
      'agents/engineer.md',
      'backends/files.md',
      'skills/role-delegation/SKILL.md',
      'docs/cli-reference.md',
    ]) {
      const body = read(rel);
      assert.doesNotMatch(
        body,
        /role start[\s\S]{0,700}task prepare-dispatch <id>\s+--packet <packet-path>\s+--role engineer/i,
        `${rel} must not prescribe post-role-start packet recomputation`,
      );
    }
    assert.match(read('docs/cli-reference.md'), /implementation_blocked.*cancellation-only/is);
    assert.match(read('skills/blocked-state/SKILL.md'), /rawReturn: null/);
    assert.match(read('skills/blocked-state/SKILL.md'), /transitionAuthority: false/);
    assert.match(read('skills/blocked-state/SKILL.md'), /never becomes authenticated\s+evidence/i);
  });

  it('keeps atomic readiness and files aggregate guidance explicit', () => {
    for (const rel of ['AGENTIC_LOOP.md', 'backends/files.md', 'docs/cli-reference.md']) {
      const body = read(rel);
      assert.match(body, /live consumed\s+Engineer\s+attempt/i, rel);
      assert.match(body, /entire|whole/i, rel);
      assert.match(body, /partial\s+sibling\s+apply\s+is\s+unsupported|no\s+partial\s+sibling\s+apply/i, rel);
    }
    for (const rel of ['docs/getting-started.md', 'docs/host-adapters.md']) {
      const body = read(rel);
      assert.match(body, /(?:for files, the|files)\s+role start creates the\s+scratch (?:check )?aggregate/i, rel);
      assert.match(body, /GitHub[\s\S]{0,220}task check-evidence-init/i, rel);
      assert.match(body, /GitHub[\s\S]{0,220}explicit/i, rel);
      assert.doesNotMatch(body, /guarded role start[^.]{0,160}check-evidence-init/i, rel);
    }
  });

  it('retains the canonical delegation safeguards unrelated to lifecycle repair', () => {
    const role = read('skills/role-delegation/SKILL.md');
    for (const pattern of [
      /pseudo-worktree/,
      /numbered alternatives/,
      /"not code"/,
      /merged twice/,
      /issue-comment review/,
      /review_budget` \(default 5\)/,
    ]) assert.match(role, pattern);
    assert.match(read('skills/parallel-delegation/SKILL.md'), /not orchestrator-inline implementation work/);
  });

  it('the work-unit-audit skill owns the audit budget and closeout gate; roles reference it', () => {
    // Distinctive budget wording lives only in the canonical skill; role files
    // and methodology point at it rather than copying it.
    const owners = ownersOf(body => /^## 11\. Audit budget$/m.test(body));
    assert.deepEqual(owners, ['skills/work-unit-audit/SKILL.md'], owners.join(', '));

    assert.match(read('agents/auditor.md'), /\[\[work-unit-audit\]\]/);
    assert.match(read('agents/orchestrator.md'), /\[\[work-unit-audit\]\]/);
    assert.match(read('agents/maintainer.md'), /\[\[work-unit-audit\]\]/);
    assert.match(read('skills/task-closeout/SKILL.md'), /\[\[work-unit-audit\]\]/);
  });

  it('task-closeout owns the detailed conditional plan-progress procedure', () => {
    const owners = ownersOf(body => /^### Conditional source-plan progress synchronization$/m.test(body));
    assert.deepEqual(owners, ['skills/task-closeout/SKILL.md'], owners.join(', '));

    const owner = read('skills/task-closeout/SKILL.md');
    assert.match(owner, /documents\.plan/);
    assert.match(owner, /Never invent a checkbox,\s+percentage, status vocabulary/);
    assert.match(owner, /If no selected plan\s+exists, record no plan mutation and continue closeout normally/);
    assert.match(owner, /no\s+explicit progress-update instruction is not a closeout failure/);
    assert.match(owner, /mapping, authority, or the\s+write itself is ambiguous, prohibited, or fails, do not publish/);
    assert.match(owner, /rerun idempotent/);
    assert.match(owner, /before the final candidate freeze/);
    assert.match(owner, /post-sync audit\s+certificate/);
    const planSync = owner.indexOf('Complete the permitted plan update');
    const baseline = owner.indexOf('audit baseline to that exact resulting artifact');
    const marker = owner.indexOf('publish the closeout marker only after');
    assert.ok(planSync >= 0 && baseline > planSync && marker > baseline,
      'plan synchronization must precede baseline refresh, audit, and closeout marker');
  });

  it('keeps auditor-role rationale in methodology and operational constraints in the role', () => {
    const auditor = read('agents/auditor.md');
    assert.doesNotMatch(auditor, /Why Auditor Is A Separate Role/);
    assert.match(auditor, /non-substitutable/);
    assert.match(auditor, /new invocation|fresh invocation/i);
    assert.match(auditor, /read-only/i);

    // The methodology owns both the fourth role and the architectural reason
    // it cannot be collapsed into a Maintainer mode.
    const methodology = read('AGENTIC_LOOP.md');
    assert.match(methodology, /Agentic Loop uses four logical roles/);
    assert.match(methodology, /agenticloop\/agents\/auditor\.md/);
    assert.match(methodology, /Auditor is a separate role rather than a maintainer mode/);
  });
});
