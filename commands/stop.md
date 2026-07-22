---
description: "Deactivate Agentic Loop for this conversation and safely checkpoint unfinished work."
disable-model-invocation: true
---

# Stop Agentic Loop

Stop means current-conversation deactivation, not host-session exit, task
closeout, or worktree cleanup. Do not authorize or initiate new Agentic Loop work
or spawn new maintainer, engineer, or parallel-lane agents.

1. Inspect active Agentic Loop subagents, delegated roles, background commands,
   and worktree lanes.
2. When the host exposes a safe interruption control, interrupt active Agentic
   Loop subagents or background work. When it does not, do not wait
   indefinitely; report the still-running work and host limitation.
3. Preserve material unfinished work. Use the existing maintainer/delegation
   path when available. When progress is not yet durable, append a concise dated
   handoff/checkpoint note to the task record with the last completed action,
   current artifact, branch or worktree, verification already run, and the next
   concrete action. Keep the current task status unchanged unless an independent
   blocker actually exists. A voluntary stop is not `blocked` or `needs_context`.
4. If no task or delegated work is active, do not write a checkpoint.

Do not accept, close, merge, commit, push, delete branches, clean up worktrees,
or begin task closeout unless the user separately authorizes that action.

Return a final stop summary containing:

- Agentic Loop deactivated for this conversation.
- Active task ID, or `none`, and its durable status.
- Interrupted work or still-running work with any host limitation.
- Checkpoint location, if one was needed.
- Branch or worktree when relevant.
- Exact resume invocation for the active host: `/agenticloop <task or context>`
  for OpenCode, Claude Code repo-local, Copilot CLI, and Cursor;
  `/agenticloop:start <task or context>` for Claude Code plugin; and
  `$agenticloop <task or context>` for Codex.

After this summary, do not automatically continue Agentic Loop for later user
messages. Reactivation requires the normal explicit activation command.
