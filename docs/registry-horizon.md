# Registry and Marketplace Horizon

Agentic Loop intentionally does not build a registry, marketplace, publishing
system, trust service, or package index today. This document records the
deferral decision and the evidence gates that must pass before registry work
starts.

## Decision

Registry work is deferred.

The toolkit remains a set of host-neutral Markdown assets and a small Node CLI.
The toolkit repo authors canonical `agents/`, `skills/`, and `backends/` assets at the root, and downstream projects copy or reference the installed `agenticloop/agents/`, `agenticloop/skills/`, and
`agenticloop/backends/` paths directly. There is no package index, no skill marketplace,
and no centralized trust service.

## Why defer

- The core loop, setup path, and host adapters are still stabilizing.
- A registry would add coordination, versioning, and security surface before the
  underlying quality evidence exists.
- Skills and roles are already usable as copied Markdown; a registry would be a
  convenience layer, not a prerequisite.

## Evidence gates

Registry work may be reconsidered only after these gates are met:

1. **Activation corpus shows routine value for description-drift checks.**
   `skills/agenticloop-tests.json` and `src/activation-scorer.js` must have
   caught at least one unintended description-drift regression in the deterministic
   surrogate scorer, or proven their value through routine validation. This gate
   is about token-overlap activation checks against skill frontmatter, not proof
   of real host routing behavior.
2. **Workflow examples have been used in first-party runs.** At least one of the
   documented workflows in `docs/workflow-examples.md` has been driven through a
   real target project end to end.
3. **Trace sections are useful in closeout.** The optional `## Trace` section in
   the work-unit summary has been used during closeout and found more useful than
   a raw transcript.
4. **Trust metadata is validated across skills.** `npx agenticloop validate`
   enforces trust metadata for every skill and downstream projects have not
   needed to relax the rules.
5. **Adapter quality checks pass.** Each implemented adapter has
   been validated through automated generation and validation tests.

## What is not deferred

Quality evidence is in scope now: activation tests, workflow examples, trace
summaries, and trust metadata are part of the toolkit. Only the registry itself
is out of scope.

## Links

- [PLAN.md](../.dev/PLAN.md) - phase status and scope.
- [docs/host-adapters.md](host-adapters.md) - adapter status table.
