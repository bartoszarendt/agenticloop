---
name: decision-capture
description: Use when recording, updating, accepting, or superseding a durable project decision that constrains future work. Covers tracked Markdown decision records under .agenticloop/decisions/, maintainer ownership, proposed vs accepted state, source-linked discoverability, supersession, and decision.recorded events.
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

Use decision records for durable verification conclusions that constrain future
agents. Examples:

- a full test suite exceeds the foreground host timeout and should be run as
  background, split, focused, or CI;
- a known expensive integration check needs a specific execution strategy;
- a local check is not reliable and must be treated as advisory.

Do not create a decision for one-off timing noise or ordinary task evidence.
Engineers may create `proposed` `scope: verification` decisions when a
timed-out, expensive, unreliable, or host-limited check constrains future work.
The proposed decision must cite task evidence or `check.run` event data and
state the future execution strategy. The record should include:

- command or check name,
- observed behavior summary,
- chosen execution strategy,
- consequences for future engineers or reviewers,
- revisit trigger such as duration growth, host limit change, test layout
  change, or CI divergence.

## When Not to Use

Do not create a decision record for:

- ordinary task notes,
- implementation summaries,
- raw meeting notes,
- raw chat transcripts,
- temporary debugging observations,
- one-off local experiments that do not constrain later work.

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
