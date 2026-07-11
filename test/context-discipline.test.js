import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function read(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

// Extract the `## Context Read Discipline` section body (up to the next
// same-or-higher-level heading).
function contextSection(content) {
  const lines = content.split('\n');
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (line.trim() === '## Context Read Discipline') {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^#{1,2}\s/.test(line.trim())) break;
      out.push(line);
    }
  }
  return out.join('\n');
}

describe('Context Read Discipline: bounded implementation discovery', () => {
  const methodology = read('AGENTIC_LOOP.md');
  const roleDelegation = read('skills/role-delegation/SKILL.md');
  const section = contextSection(methodology);

  it('AGENTIC_LOOP.md owns the canonical bounded-discovery invariant', () => {
    assert.ok(section, 'AGENTIC_LOOP.md must have a Context Read Discipline section');
    // Three-part distinction.
    assert.ok(
      section.includes('### Normative context (closed)'),
      'must define a closed normative context set'
    );
    assert.ok(
      section.includes('### Bounded implementation discovery (permitted by default)'),
      'must define bounded implementation discovery as permitted by default'
    );
    assert.ok(
      section.includes('### Arbitrary context loading (prohibited)'),
      'must keep arbitrary context loading prohibited'
    );
  });

  it('permits bounded capability-based discovery', () => {
    assert.match(section, /repository indexing or language-aware symbol, reference/i);
    assert.match(section, /caller\/callee lookup/i);
    assert.match(section, /exact identifier or known-path search/i);
    assert.match(section, /focused test discovery/i);
    assert.match(section, /relevant version-control history/i);
  });

  it('permits inspecting directly connected callers and tests', () => {
    assert.match(section, /caller/i);
    assert.match(section, /test/i);
    assert.match(section, /may be inspected/i);
  });

  it('still prohibits arbitrary repository-wide loading', () => {
    assert.match(section, /broad repository dumps|scanning the whole tree/i);
    assert.match(section, /indiscriminate full-file loading/i);
  });

  it('contains the six-expansion default bound', () => {
    assert.match(section, /at most six previously unnamed paths or symbol bodies/);
    assert.match(section, /one bounded discovery pass/);
  });

  it('routes excess or contract-changing discovery to needs_context', () => {
    assert.match(section, /Return `needs_context`/);
    assert.match(section, /exceeds the default bound/);
    // Directly connected discovery does not automatically escalate.
    assert.match(section, /by itself require `needs_context`/);
  });

  it('records discovery in the existing Deviations section, not a new mandatory section', () => {
    assert.match(section, /## Deviations/);
  });

  it('has one canonical full definition, not a second divergent copy in role-delegation', () => {
    // role-delegation must reference the canonical owner, not restate the bound.
    assert.match(
      roleDelegation,
      /canonical Context Read Discipline in\s+`agenticloop\/AGENTIC_LOOP\.md`/
    );
    // The distinctive six-expansion bound lives only in AGENTIC_LOOP.md.
    assert.ok(
      !roleDelegation.includes('at most six previously unnamed paths or symbol bodies'),
      'role-delegation must not restate the six-expansion bound'
    );
    // The full three-part structure is not duplicated into role-delegation.
    assert.ok(
      !roleDelegation.includes('### Bounded implementation discovery (permitted by default)'),
      'role-delegation must not copy the canonical three-part structure'
    );
  });

  it('role-delegation still permits bounded discovery and routes expansion to needs_context', () => {
    assert.match(roleDelegation, /Bounded task-scoped implementation discovery/);
    assert.match(roleDelegation, /returns `needs_context`/);
  });

  it('canonical discovery sections do not require CodeGraph', () => {
    const workflow = read('docs/workflow-examples.md');
    for (const [label, body] of [
      ['methodology', section],
      ['role delegation', roleDelegation],
      ['workflow examples', workflow],
    ]) {
      assert.doesNotMatch(body, /\bCodeGraph\b/, `${label} must remain tool-neutral`);
    }
  });
});
