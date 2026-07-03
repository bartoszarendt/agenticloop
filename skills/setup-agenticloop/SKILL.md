---
name: setup-agenticloop
description: Use when a maintainer or human is setting up Agentic Loop in a target project for the first time, when source document names are non-standard or ambiguous, or when .agenticloop/project.md is still unconfirmed. Discovers bounded candidate project docs once, gathers bounded backend evidence, proposes document selections and task conventions, asks for confirmation, and writes confirmed project-map values plus setup confirmation state.
metadata:
  area: setup
  side_effects: writes-files
  credentials: none
  runs_scripts: none
---

# Setup Agentic Loop

This is a one-time interactive setup skill. It is maintainer-run or human-run.
Run it when:

- setting up Agentic Loop in a target project for the first time,
- source document names are non-standard or ambiguous,
- `.agenticloop/project.md` is `setup_status: unconfirmed`,
- `.agenticloop/project.md` needs confirmed typed document selections.

Do not use this skill for routine runtime document lookup. At runtime, agents read
`.agenticloop/project.md` for overrides and fall back to conventional names. This skill
performs one-time discovery so runtime agents do not need to scan the repository.

## What This Skill Does

1. Scan bounded candidate paths once.
2. Propose detected documents by role, detected grouping profile, inferred task ID style, and backend choice.
3. Ask the human to confirm before writing.
4. Write confirmed project-map values and setup confirmation state to `.agenticloop/project.md`.
5. Preserve existing `.agenticloop/project.md` content where possible.

After this skill runs, future runtime agents use convention-first lookup plus the
confirmed overrides recorded here.

Setup is complete only after the maintainer or human confirms:

- document role selections,
- task ID pattern and regex,
- grouping profile,
- backend choice.

## Candidate Files to Detect

Use the canonical document-role registry in `agenticloop/config.json`. Scan only
these bounded candidates once:

### rules

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`

### plan

- `IMPLEMENTATION_PLAN.md`
- `PLAN.md`
- `ROADMAP.md`
- `docs/roadmap.md`

### overview

- `README.md`
- `docs/overview.md`

### process

- `agenticloop/AGENTIC_LOOP.md`

### spec

- `SPEC.md`
- `SPECS.md`
- `PRD.md`
- `REQUIREMENTS.md`
- `docs/spec.md`
- `docs/specs/`
- `docs/prd/`

### design

- `DESIGN.md`
- `ARCHITECTURE.md`
- `ARCHITECTURE_PLAN.md`
- `ARCHITECTURE_DESIGN.md`
- `docs/architecture.md`
- `docs/adr/`

### context

- `CONTEXT.md`
- `docs/context.md`

Use `context` for target-owned domain context, product vocabulary, or task-start
context. Agentic Loop's own glossary is in `agenticloop/AGENTIC_LOOP.md`.

### history

- `CHANGELOG.md`
- `RELEASE-NOTES.md`
- `MIGRATION.md`

## Steps

### Step 1: Scan

Look for the candidate files listed above. Identify which are present. Do not
search beyond these candidates; do not scan the whole repository.

### Step 2: Infer conventions

For each document role, compare the detected file against the conventional first
candidate. Note non-conventional selections that would need a typed document
entry in `.agenticloop/project.md`.

Also infer:

- the grouping profile (`flat`, `phase`, `milestone`, `epic`, or `custom`), defaulting to `flat` when no grouping is evident
- the task ID convention if it is visible in the plan
- bounded backend evidence, including only practical signals such as:
  - existing `.agenticloop/project.md` `task_backend`
  - legacy `agenticloop.json` `taskBackend`, when present
  - whether `git remote origin` points to GitHub
  - whether `gh auth status` is available, without requiring auth to finish local setup
  - existing GitHub labels such as `task:*`, `phase:*`, `type:impl`, `blocked`, `approved`, `agent-ready`
  - issue or pull-request references visible in the bounded source docs already scanned by this setup step
  - current branch names that already follow task or grouping conventions
  - presence or absence of local `.agenticloop/tasks/` records
- the backend choice, defaulting to `files` only when no existing durable backend evidence is present

Do not propose a document selection when the conventional default is present and
no better match exists.

When inferring grouping from plan headings, use the selected plan document when
one is already recorded; otherwise use the bounded plan candidates from
`agenticloop/config.json`. Treat `##`, `###`, and `####` headings named
`Phase`, `Milestone`, or `Epic` as grouping evidence.

Do not use a brittle deterministic rule such as "GitHub remote means GitHub backend".
Instead, present the bounded evidence you found, propose a backend with a short
rationale and confidence level, and require an explicit human confirmation.

If durable GitHub workflow evidence is present, propose `github` or require an
explicit files-backend exception from the human before writing `task_backend: files`.

### Step 3: Propose and Confirm

Present your findings to the human in a compact list:

```text
Detected source documents:
  rules: AGENTS.md                       (conventional - no selection needed)
  plan: ROADMAP.md                       (selection recommended)
  overview: README.md                    (conventional - no selection needed)
  design: ARCHITECTURE_PLAN.md           (selection recommended)

Detected grouping:
  grouping_profile: phase
  task_id_pattern: P<phase>-<number>

Backend evidence:
  - git remote origin: github.com/acme/widget
  - gh auth status: available
  - existing labels: agent-ready, blocked, approved, type:impl, task:P6-FU-1
  - existing issue title prefixes: P6-FU-1, P3-10-FU-1
  - local .agenticloop/tasks/: absent

Backend proposal:
  task_backend: github
  confidence: high
  rationale: existing durable GitHub issue and label workflow evidence is present

Proposed .agenticloop/project.md values:
  documents.plan: "ROADMAP.md"
  documents.design: "ARCHITECTURE_PLAN.md"
  task_backend: github
  grouping_profile: phase
  task_id_pattern: "P<phase>-<number>"
  task_id_regex: "^P\\d+-\\d{2,}$"
  group_closeout: true

Confirm these document selections, task naming/grouping values, and backend choice? (yes / no / edit)
```

Ask the human to confirm before writing. Confirmation may either record typed
selections or explicitly accept the defaults already shown in the project map.
If they say "edit", accept their corrections. If they say "no", do not write
anything and leave `setup_status: unconfirmed`.

If the human keeps `task_backend: files` despite durable GitHub workflow evidence,
ask them to state the explicit exception in one short sentence and record that
sentence in `backend_evidence_summary` when writing the file.

### Step 4: Write Overrides

Write only the confirmed non-conventional selections and confirmed grouping/task
convention values to `.agenticloop/project.md` frontmatter. Do not write a
document selection for a role whose conventional path was detected.

After confirmation, always write:

- `setup_status: confirmed`
- `setup_confirmed_at: <YYYY-MM-DD>`
- `setup_confirmed_by: <human or maintainer>`
- `task_backend: <confirmed backend choice>`

Do this even when no non-conventional document selections are needed and the
human only confirms the default conventions.

When helpful, also write these optional backend-confirmation notes:

- `backend_confirmed_at: <YYYY-MM-DD>`
- `backend_confirmed_by: <human or maintainer>`
- `backend_evidence_summary: <one-line backend evidence summary or explicit files exception>`

When the human or target setup already knows the engineer model's active context
window, the maintainer may also record:

- `engineer_context_window_tokens: <positive integer>`

When `.agenticloop/project.md` already exists:

- Parse the existing frontmatter.
- Merge in the new override keys.
- Preserve existing frontmatter values that are not being overridden.
- Preserve the body of the file.
- If the human declines confirmation, leave `setup_status: unconfirmed`.

When `.agenticloop/project.md` does not exist, write a fresh file using the
project-map shape: YAML frontmatter with `setup_status`,
`setup_confirmed_at`, `setup_confirmed_by`, `task_backend`,
`task_id_pattern`, `task_id_regex`, `task_file_template`,
optional `engineer_context_window_tokens`, and optional typed `documents` keys, followed by a
`# Agentic Loop Project Map` heading.
Alternatively, tell the human to run `npx agenticloop init` first, which
creates the file automatically.

Do not write model IDs, provider names, or reasoning effort settings to
`.agenticloop/project.md`. Those belong in `agenticloop.json` under
`adapters.<host>.roleSettings`.

### Step 5: Explain Next Steps

After writing, tell the human:

- which selections were written,
- which grouping or task-ID conventions were recorded,
- which backend choice was confirmed and why,
- who confirmed the setup and on what date,
- that future runtime agents will use the typed selections plus bounded candidate defaults,
- that `agenticloop validate` can verify the project map.

## What This Skill Must Not Do

- Perform broad runtime document discovery on every agent turn.
- Write model IDs, provider names, or reasoning effort values.
- Overwrite the body of `.agenticloop/project.md` beyond frontmatter overrides.
- Guess at document paths without candidate detection.
- Run `agenticloop init` automatically; only write confirmed overrides.
