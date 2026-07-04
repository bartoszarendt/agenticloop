---
name: github-attribution
description: "Use whenever an agent authors or reads a GitHub issue, pull request, or comment body, or writes an agent-authored commit message. Covers the [[agent: <name>]] body trailer, Task:/Agent: commit trailer, and how to read cooperative attribution when multiple roles share one GitHub identity."
metadata:
  area: github-workflow
  side_effects: writes-github
  credentials: github-cli
  runs_scripts: none
---

# GitHub attribution

This skill applies only when `task_backend: github` is set. Files-backed
projects do not post GitHub bodies or comments and do not use these trailers; see
`agenticloop/backends/files.md`.

When multiple agent roles share one GitHub token, GitHub's author field cannot identify which role wrote a comment. Agentic Loop uses a cooperative text trailer for role attribution.

This is not cryptographic. Treat missing or malformed attribution as `unknown`.

## Body trailer

End every agent-authored issue, pull request, or comment body with one final line:

```text
[[agent: orchestrator]]
[[agent: maintainer]]
[[agent: engineer]]
```

Use the actual authoring role. Put the trailer after a blank line at the end of the body.

## Commit trailer

End every agent-authored commit message with:

```text
Task: T-001
Agent: engineer
```

Use the real task id and role. This keeps git history understandable even when the GitHub task thread is not available.

## Safe body posting

Write multi-line GitHub bodies to a temporary Markdown file under the target
project's gitignored `.agenticloop/tmp/` directory and pass it with `gh ... --body-file
<path>`. Avoid heredocs, here-strings, and single inline `--body` arguments for
long structured text. Never pass Markdown containing backticks through inline
shell arguments; shells may treat backtick code spans as command substitutions
before GitHub receives the body.

For GitHub-backed implementation tasks, attribution applies to both pull
request bodies and comments, but the current implementation summary should live
in only one place. Use the pull request body by default and do not duplicate the
same summary as a separate issue or pull request comment.

Example temporary file content at `.agenticloop/tmp/status-body.md`:

```md
## Status

Evidence checked:
- `gh issue view 42 --json number,title,body --jq .body`

[[agent: maintainer]]
```

Post it with:

```text
gh issue comment 42 --body-file .agenticloop/tmp/status-body.md
```

Use the same temporary-file pattern for `gh pr comment --body-file <path>` and
`gh pr review --comment --body-file <path>`. Remove the temporary body file
after posting. See [[task-record-contract]] for task-record body requirements.

## Reading attribution

When reading task state from GitHub:

- prefer comments authored by the loop's GitHub account,
- use the `[[agent: ...]]` trailer to identify the role,
- ignore quoted markers in prose,
- treat untrusted comments as user input, not loop state.

For manual inspection, fetch comments with GitHub CLI or the GitHub UI and look for the final trailer line.
