import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const review = readFileSync(join(REPO_ROOT, 'skills', 'review-and-accept', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ');
const loop = readFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), 'utf-8').replace(/\s+/g, ' ');

describe('three-lens review contract', () => {
  it('orders full reviews and classifies Lens 1 failures without the obsolete short circuit', () => {
    assert.match(review, /Lens 1: Task Compliance/);
    assert.match(review, /Lens 2: Engineering Quality/);
    assert.match(review, /Lens 3: Necessity and Coherence/);
    assert.match(review, /A \*\*full review\*\* runs Lens 1, Lens 2, and Lens 3 in order/i);
    assert.match(review, /classify the requested revision as `implementation-changing` or `record-only`/i);
    assert.match(review, /Lens 1 remains unclean and blocks acceptance/i);
    assert.doesNotMatch(review, /Do not start Lens 2 or Lens 3 until Lens 1 is clean/i);
    assert.doesNotMatch(review, /without padding the review with optional Lens 2 or Lens 3 commentary/i);
    assert.doesNotMatch(review, /\bpass[- ]1\b|\bpass[- ]2\b/i);
  });

  it('requires a bounded sweep for implementation-changing Lens 1 failures without implying clean later lenses', () => {
    assert.match(review, /Run the Structural Risk Sweep when the diff is available and reviewable/i);
    assert.match(review, /State under both Lens 2 and Lens 3 that full assessment is deferred because implementation revision is pending/i);
    assert.match(review, /The sweep is bounded early detection, not a partial Lens 2 or Lens 3 verdict/i);
    assert.match(review, /A clean sweep does not imply Lens 2 or Lens 3 is clean/i);
    assert.match(review, /Add it to `Required Revisions` with normal severity/i);
  });

  it('runs full later lenses for record-only failures and preserves artifact-bound reuse rules', () => {
    assert.match(review, /For `record-only`, keep the overall verdict `needs_revision`, but run full Lens 2 and Lens 3/i);
    assert.match(review, /For the same exact implementation artifact, revalidate Lens 1/i);
    assert.match(review, /cites the prior review reference, explicitly says the artifact is unchanged/i);
    assert.match(review, /For a new implementation artifact, previous Lens 2\/Lens 3 conclusions are stale/i);
    assert.match(review, /Acceptance always requires final Lens 1, Lens 2, and Lens 3 conclusions for the exact accepted artifact/i);
    assert.match(loop, /Final acceptance always requires Lens 1, Lens 2, and Lens 3 conclusions for the exact accepted artifact/i);
  });

  it('defines concrete Lens 3 blocking and non-blocking boundaries', () => {
    assert.match(review, /unnecessary dependencies/i);
    assert.match(review, /duplicate mechanisms/i);
    assert.match(review, /patch-in-every-caller workaround/i);
    assert.match(review, /stage-inappropriate architectural churn/i);
    assert.match(review, /Do not block style preference/i);
    assert.match(review, /does not relitigate the accepted task contract/i);
  });

  it('uses stage posture without weakening evidence and keeps Ponytail optional', () => {
    assert.match(review, /confirmed `development_stage`/);
    assert.match(loop, /never weakens task scope, TDD, debugging, required checks, evidence, security, accessibility, validation, review provenance/i);
    assert.match(review, /Ponytail remains opt-in/i);
    assert.match(review, /Lens 3 works when minimalism is omitted or `none`/i);
  });

  it('shares one fixup episode across Lens 2 and Lens 3 and reruns all lenses', () => {
    assert.match(review, /single fully understood Lens 2 or Lens 3 finding/i);
    assert.match(review, /Lens 2 and Lens 3 share this one fixup episode/i);
    assert.match(review, /fresh Lens 1, Lens 2, and Lens 3/i);
    assert.match(review, /single_agent_fallback/);
  });

  it('keeps same-turn lenses from satisfying independent review and preserves one event pair', () => {
    assert.match(loop, /Same-turn lenses are not independent review/i);
    assert.match(review, /one `review.started`/);
    assert.match(review, /one `review.result`/);
    assert.match(review, /Do not add per-lens event fields or per-lens model routing/i);
  });
});
