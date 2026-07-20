---
name: decision-capture
description: Use when recording, updating, accepting, or superseding a durable project decision that constrains future work, including a maintainer's promotion of an already-recorded policy-level verification observation. Covers tracked Markdown decision records under .agenticloop/decisions/, maintainer ownership, proposed vs accepted state, source-linked discoverability, supersession, and decision.recorded events.
metadata:
  area: decision-records
  side_effects: writes-files
  credentials: none
  runs_scripts: none
---

# Decision capture

Decision records are the small docs-first layer for durable project decisions.
They are broader than the narrow ADR threshold. If a decision constrains future
work and later agents would benefit from seeing it, it can earn a decision
record even when it is not especially surprising or hard to reverse.

## When to Use

Use this skill when a project decision needs a tracked Markdown record because
it constrains future work. Common scopes include:

- process,
- architecture,
- backend choice,
- role boundaries,
- quality rules,
- security posture,
- release rules,
- product direction,
- accepted project conventions,
- verification.

Strong ADR-style signals such as hard to reverse, surprising, or tradeoff-heavy
still matter, but they are not the only trigger.

## Verification operating decisions

This is a promotion path, not timeout handling. First use
[[verification-evidence]] to record the task attempt. The maintainer then
triages it and, when the observation affects repeated project work, records or
updates the current `VF-...` fact in `.agenticloop/project.md`.

Use this skill for verification only when that already-recorded fact represents
a policy-level conclusion that constrains future work, such as a project rule to
use CI rather than local execution for a class of checks. The decision cites the
`VF-...` fact and its durable task/event evidence, states the policy and revisit
trigger, and follows the normal acceptance gate.

Do not use this skill for one timeout, ordinary timing noise, a retry choice, a
task attempt, final timeout triage, or a mutable verification-fact update.
Engineers report those observations; delegation observations never approve a
strategy. A decision is not created merely because a check is expensive.

## When Not to Use

Do not create a decision record for:

- ordinary task notes,
- implementation summaries,
- raw meeting notes,
- raw chat transcripts,
- temporary debugging observations,
- one-off local experiments that do not constrain later work,
- a current, non-binding project operating fact -- record it in
  `## Project Operating Facts` in `.agenticloop/project.md` instead,
- a compact pointer to a runbook -- that is a Project Operating Fact, not a
  decision.

## Project operating facts

A Project Operating Fact is current, mutable, non-binding project knowledge in
`## Project Operating Facts` in `.agenticloop/project.md`; it is owned by the
maintainer and defined in `agenticloop/AGENTIC_LOOP.md`. If a project fact
becomes binding policy or constrains future implementation, security,
architecture, quality, or release behavior, promote it through the normal
proposed -> accepted decision path here. A fact may cite a decision, but a fact
is not approval, and preserving a runbook pointer never by itself warrants a
decision record.

## Who May Create Proposed Records

Any role may create a new `status: proposed` decision record when it directly
discovers evidence that satisfies the decision-worthiness test. The creating
role must:

- use `agenticloop/memory/decision-record.md` as the record shape,
- set provenance fields (`proposed_at`, `proposed_by_role`, `proposed_by`,
  and `source_refs`),
- link the record from a durable source: the current task record,
  implementation summary, `.agenticloop/project.md`, selected source document,
  or nearest durable source; a status return may mention the link but is not
  sufficient by itself,
- keep it short and evidence-backed,
- not mark it `accepted`.

For `scope: verification`, the maintainer uses this path only after final
timeout triage and an existing `VF-...` fact establish a policy-level promotion.
An engineer records and reports the observation through
[[verification-evidence]] instead of opening a verification decision directly.

## Maintainer Ownership

The maintainer owns:

- accepting proposed decisions,
- rejecting proposed decisions,
- superseding decisions,
- edits to accepted decisions,
- resolving conflicting proposed records.

Human confirmation or an approved `type:change-request` remains required for
`accepted`. If an accepted decision needs to change, non-maintainer roles must
create a new `proposed` decision or report the need; they must not silently edit
the accepted record.

## Decision-Worthiness Test

Create or update a decision record when all of the following are true:

1. the decision is durable enough to matter beyond one task,
2. it constrains future implementation, review, setup, or release work,
3. later agents or maintainers would likely make the wrong choice without it.

For verification, also require an existing evidence-backed `VF-...` fact and a
policy-level consequence beyond selecting the next run's strategy.

If the note is only evidence for one task, keep it in the task record or
implementation artifact instead.

The promotion threshold is deliberately graded:

- a lane-local observation stays in that lane's status return or task summary;
- a finding relevant only to the current batch is routed and disposed under
  the cross-lane finding rules in [[parallel-delegation]];
- a durable technical invariant that constrains future work may become a
  `status: proposed` decision record with provenance and source references.

Any scope from the existing list may carry such an invariant -- `quality`,
`architecture`, `verification`, `process`, or an accepted project convention.
Do not add a new decision scope for parallel-lane findings. Promotion is never
automatic: the maintainer resolves proposed records under the existing rules,
and future work retrieves them through existing source-linked decision
discovery.

## Parallel Safety

In parallel lanes, a role may create only a new uniquely named `proposed`
decision file. A role must not edit an existing decision record unless the
concurrency plan grants exclusive ownership.

## Process

1. Check whether an accepted record already covers the decision. If yes and the
   meaning must change, create a new record and mark the old one superseded.
2. Create one decision record per durable decision under
   `.agenticloop/decisions/<slug>.md`. Use `agenticloop/memory/decision-record.md`
   as the record shape. Keep the record short.
3. Set status according to authority: non-maintainer creators use `proposed`;
   maintainer may set `accepted`, `rejected`, or `superseded` under the rules
   below.
4. Add or update a link to the decision record in the nearest durable source:
   - Prefer the current task record when the decision is task-local.
   - Prefer `.agenticloop/project.md`, `IMPLEMENTATION_PLAN.md`,
     architecture/design docs, or the relevant source doc when the decision
     changes project behavior.
5. Validate discoverability: the decision record must be linked from at least
   one durable source. Do not create or maintain a decision index.
6. When `event_logging: enabled`, emit `decision.recorded` per [[event-logging]],
   which owns command resolution and the disabled/non-blocking rules.

## Proposed vs Accepted

- Agents may create `proposed` records when they detect a durable decision that
  should be reviewed.
- `accepted` requires explicit human confirmation or an approved
  `type:change-request`.
- `rejected` is for decisions that were considered and explicitly declined.
- `superseded` is for older accepted decisions replaced by a newer record.

## Supersession Rule

Do not silently rewrite an accepted decision to change its meaning. Write a new
record, update the old record to `superseded`, and link the relationship in
the record frontmatter. Update or add links in the durable source that
referenced the superseded record.

## Change-Request Gate

If the work changes an accepted locked process, architecture, backend, or other
project decision, use [[change-request-gate]] before implementation. Approval
does not remove the need to record or supersede the decision.

## Evidence

The tracked Markdown files under `.agenticloop/decisions/` are the source of
truth. The event log is only an audit signal.

Do not store raw transcripts, raw meeting dumps, prompt logs, or tool output in
decision files.
