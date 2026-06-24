# Memory Definition (read-only package source)

This directory is the **read-only memory definition**. The live mutable store
is `.agenticloop/` in each target project.

## Layout

```text
memory/
  scaffold/           Seed files for a fresh .agenticloop/ store
    project.md        Target-owned project map (copied once, never overwritten)
    decisions/.gitkeep  Empty directory marker (not copied into targets)
    tasks/.gitkeep    Empty directory marker (not copied into targets)
    logs/.gitkeep
    tmp/.gitkeep
  decision-record.md         Toolkit-owned record shape reference
  task-record.md             Toolkit-owned record shape reference
  work-unit-summary.md       Toolkit-owned inline task-summary shape reference
```

## Layers

| Layer | Location | Owner |
|---|---|---|
| **scaffold/** | Seed files for `.agenticloop/` | Toolkit (read-only source) |
| **record shapes** | `task-record.md`, `work-unit-summary.md`, `decision-record.md` | Toolkit (installed to `agenticloop/memory/`) |
| **live state** | `.agenticloop/project.md`, `.agenticloop/tasks/`, etc. | Target project |

`init` copies scaffold seed files into `.agenticloop/` only when absent.
Record-shape files are installed to `agenticloop/memory/` for reference but
are never copied into `.agenticloop/`.
