# Skill Anatomy

Skills are the canonical procedure units in Agentic Loop. In the toolkit repo, a skill is a directory under `skills/` with a required `SKILL.md` file. Installed target repos still receive the same content under `agenticloop/skills/`.

```text
skills/
  skill-name/
    SKILL.md
    references/        # optional
    scripts/           # optional, avoid unless genuinely needed
```

Keep skills Markdown-first. Add scripts only when deterministic automation is clearly better than instructions.

## Frontmatter

Every skill starts with YAML frontmatter:

```yaml
---
name: skill-name
description: Use when [specific trigger]. Explains what the skill does and when to apply it.
metadata:
  area: engineering-discipline
  side_effects: writes-files
  credentials: none
  runs_scripts: optional
---
```

Rules:

- `name` matches the directory name.
- `description` includes a clear trigger phrase such as `Use when`, `Use before`, or `Use the moment`.
- `metadata.area` groups the skill for catalogs and validation.
- `metadata.side_effects`, `metadata.credentials`, and `metadata.runs_scripts` are required trust metadata.
- Descriptions are routing metadata, not marketing copy. They must be specific enough to avoid false activation.

### Trust metadata

Trust metadata makes skill side effects explicit for reviewers and downstream hosts.

| Field | Allowed values | Meaning |
|---|---|---|
| `side_effects` | `none`, `read-only`, `writes-tmp`, `writes-files`, `writes-backend`, `writes-github` | Highest side effect the skill can cause when followed. |
| `credentials` | `none`, `optional`, `backend-dependent`, `github-cli` | Credentials required to execute the skill fully. |
| `runs_scripts` | `none`, `optional`, `required` | Whether the skill executes scripts or commands. |

Rules:

- A skill with a `scripts/` directory cannot claim `runs_scripts: none`.
- A `writes-github` skill must declare `credentials: github-cli`.
- Backend-neutral skills that write through the active task backend use
  `side_effects: writes-backend` and `credentials: backend-dependent`.
- Use `writes-github` only for skills that operate exclusively on GitHub artifacts.
- Use the most conservative value that is still accurate.

Current area values in use:

| Area | Skills |
|---|---|
| `task-records` | task-record-contract |
| `review-workflow` | review-and-accept |
| `task-closeout` | task-closeout |
| `frontend-design-quality` | frontend-design-quality |
| `process-improvement` | loop-retrospective |
| `github-workflow` | github-attribution |
| `failure-handling` | blocked-state, change-request-gate |
| `decision-records` | decision-capture |
| `engineering-discipline` | tdd-implementation, debugging-before-fixes, verification-evidence |
| `orchestration` | role-delegation |

Backend-neutral skills use areas that describe the workflow domain, not the storage backend. Only skills that operate exclusively on GitHub artifacts use `github-workflow`.

Target projects may expose their own host-visible skills outside the installed
Agentic Loop `agenticloop/skills/` directory. Those project skills are not validated as
canonical Agentic Loop skills unless they live under the configured
`skills.sourceDirectory`.

## Recommended Sections

Use this shape unless the skill has a better local structure:

```markdown
# Skill Title

## Purpose

## When to Use

## Process

## Evidence

## Red Flags

## Rationalizations

## Output
```

## Writing Principles

- Write procedures, not essays.
- Keep the main `SKILL.md` focused.
- Move long reference material into directly linked files.
- Include stop conditions and escalation points.
- Require evidence for completion claims.
- Use backend-neutral language first: "task record" before "GitHub issue".
- Keep host-specific instructions in setup docs unless the skill truly needs them.

## Script Policy

Scripts are optional. Do not add a script just to mirror another repository.

If a skill needs automation:

- prefer future Node-based helpers for cross-platform use,
- keep Bash or PowerShell host-specific and optional,
- document required credentials and side effects,
- print machine-readable output when the agent needs to consume results.

## Cross-References

Reference another skill by name with a wiki link:

```markdown
Use [[verification-evidence]] before claiming the task is complete.
```

Do not duplicate another skill's process. Link to it and let the agent load it when needed.

## Activation Corpus

Skill descriptions are routing metadata. To catch accidental description drift,
keep a deterministic surrogate activation corpus in `skills/agenticloop-tests.json` in the toolkit repo.

Each skill entry has:

- `shouldTrigger`: prompts that must rank the skill in the top two.
- `shouldNotTrigger`: prompts that must not rank the skill first with a non-zero score.
- `nearMiss`: prompts close to another skill, which must not route to that other skill.
- `nearMissTarget` (optional): the skill the near-miss prompt must avoid.

The scorer is `src/activation-scorer.js`. It ranks skills using only frontmatter
`name` and `description` via token overlap; no LLM or host routing is invoked.
The scorer catches accidental description drift and vocabulary collisions, not
real host routing behavior. It is a deterministic surrogate check, not a
substitute for live host routing validation.

Run it with:

```text
npx agenticloop validate
npm test
```

Add corpus entries whenever you add a skill or change a description that affects
routing. A near-miss prompt should still route to its own skill, just not to the
near-missed skill.

## Quality Checklist

Before publishing a skill, confirm:

- [ ] frontmatter is valid,
- [ ] trust metadata is complete and accurate,
- [ ] trigger description is specific,
- [ ] process steps are actionable,
- [ ] verification requires evidence,
- [ ] red flags catch common failures,
- [ ] references are direct and useful,
- [ ] agenticloop-tests.json covers the skill if it is new,
- [ ] no host-specific duplicate skill content was added.
