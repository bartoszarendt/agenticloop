# Worktree Lanes and State Preservation

Agentic Loop isolates file-mutating work in guarded repo-internal `git worktree`
lanes – one lane per task, each with its own branch. The CLI owns the lane
lifecycle:

```text
npx agenticloop worktree add <task-id> <branch>      Create guarded repo-internal lane worktree
npx agenticloop worktree guard [--fix] [--all]       Check or repair non-interactive Git guard config
npx agenticloop worktree list [--json]               List all registered worktrees
npx agenticloop worktree remove <id|path> --dry-run  Preview worktree removal
npx agenticloop worktree remove <id|path> --yes      Remove a standard worktree and preserve lane state
npx agenticloop worktree cleanup --dry-run           Preview bulk cleanup of merged/integrated lanes
npx agenticloop worktree cleanup --yes               Remove merged standard worktrees after confirmation
npx agenticloop worktree resolve-state <id|path>     Resolve lane-local state preservation conflicts
npx agenticloop worktree prune --dry-run             Preview stale worktree registrations
npx agenticloop worktree prune --yes                 Remove stale worktree registrations
```

`remove` and `cleanup` follow the dry-run/yes confirmation pattern because
worktree removal is destructive filesystem cleanup. Cleanup keeps open PRs,
locked worktrees, worktrees with blocking dirty source or shared `.agenticloop`
state, external or detached worktrees, and lanes with active task state.

## Lane-local state

Before removing a lane, cleanup preserves task-specific lane-local
`.agenticloop` state into the root checkout.

Lane-local state that cleanup can preserve is flat only (`logs`, `tasks`,
`summaries` (legacy; preserved for migration only – current projects do not
create a summaries directory), and `decisions` files directly under
`.agenticloop/<dir>/`). Nested or shared `.agenticloop` files are treated as
blocking dirty state.

For `.jsonl` files, preservation is safe when the root file already contains
every lane line (a root superset).

## Resolving preservation conflicts

If preservation conflicts with existing root state, use
`worktree resolve-state` before running cleanup:

- `--strategy prefer-root` copies the root file into the lane;
- `--strategy prefer-worktree` copies the lane file into the root;
- `--strategy union-jsonl` computes a root-first max-count multiset union and
  writes the result to both files.

`union-jsonl` is the recommended lossless strategy for JSONL log conflicts.
`resolve-state` defaults to `--dry-run` and never removes worktrees or
branches.