import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEvent, validateNewEvent, VALID_EVENT_TYPES } from '../src/event-logging.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// Canonical documentation surfaces whose copy/paste event-logging examples must
// pass strict producer validation. Future producer-validation changes that would
// invalidate a documented example fail here instead of silently rotting docs.
function canonicalDocPaths() {
  const paths = [join(REPO_ROOT, 'AGENTIC_LOOP.md')];
  for (const dir of ['agents', 'backends', 'docs']) {
    for (const name of readdirSync(join(REPO_ROOT, dir))) {
      if (name.endsWith('.md')) paths.push(join(REPO_ROOT, dir, name));
    }
  }
  for (const name of readdirSync(join(REPO_ROOT, 'skills'))) {
    try {
      paths.push(join(REPO_ROOT, 'skills', name, 'SKILL.md'));
      readFileSync(paths[paths.length - 1]);
    } catch {
      paths.pop();
    }
  }
  return paths;
}

// Parse one documented `npx agenticloop event-logging <event_type> ...` command
// line into buildEvent input. Supports the option shapes used in canonical
// docs: bare values, double-quoted values, and single-quoted JSON.
function parseExampleCommand(line) {
  const match = line.match(/npx agenticloop event(?:-logging)? (\S+)(.*)$/);
  if (!match) return null;
  const eventType = match[1];
  if (!VALID_EVENT_TYPES.has(eventType)) return null;

  const options = { refs: [] };
  const optionRe = /--([a-z-]+)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  for (const opt of match[2].matchAll(optionRe)) {
    const name = opt[1];
    const value = opt[2] ?? opt[3] ?? opt[4];
    if (name === 'ref') options.refs.push(value);
    else options[name] = value;
  }

  let data;
  if (options['data-json'] !== undefined) {
    data = JSON.parse(options['data-json']);
  }

  return {
    line,
    input: {
      task: options.task,
      eventType,
      role: options.role,
      summary: options.summary,
      outcome: options.outcome,
      refs: options.refs,
      data,
    },
  };
}

function collectExamples() {
  const examples = [];
  for (const path of canonicalDocPaths()) {
    const content = readFileSync(path, 'utf-8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.includes('npx agenticloop event')) continue;
      const parsed = parseExampleCommand(line);
      if (parsed) examples.push({ path, ...parsed });
    }
  }
  return examples;
}

describe('canonical event-logging examples pass strict producer validation', () => {
  const examples = collectExamples();

  it('finds documented append examples to validate', () => {
    // The canonical docs carry at least the review.started/review.result and
    // check.run examples; an empty scan means the extractor regressed.
    assert.ok(examples.length >= 3, `expected at least 3 examples, found ${examples.length}`);
    assert.ok(
      examples.some(example => example.input.eventType === 'review.result'),
      'expected a documented review.result example'
    );
  });

  for (const example of collectExamples()) {
    it(`${example.path.slice(REPO_ROOT.length).replace(/\\/g, '/')} example '${example.input.eventType}' is producer-valid`, () => {
      const event = buildEvent(example.input);
      const { errors } = validateNewEvent(event);
      assert.deepEqual(errors, [], `${example.line}\n${errors.join('\n')}`);
    });
  }
});
