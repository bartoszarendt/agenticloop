# Host Adapters

Agentic Loop is host-neutral. The canonical role, skill, and backend source stays
in `agenticloop/agents/`, `agenticloop/skills/`, and `agenticloop/backends/`. A host adapter renders that source
into host-native artifacts (for example `.opencode/agents/*.md`,
`.codex/agents/*.toml`, `.claude/agents/*.md` plus
`.claude/settings.local.json` by default, `.github/agents/*.agent.md`, or
`.cursor/agents/*.md`).

Host-native output is generated shim material. The shim directories are not the
source of truth.

Host UI status, messages, opaque handles, and cancellation notifications are
transport observations, not Agentic Loop role returns. The ordinary public
handoff uses target-relative CLI artifacts: `task prepare-dispatch` with
`--host`, `--role engineer`, `--output`, and `--json`; guarded role start;
for files, the role start creates the scratch aggregate before ordered `task
evidence` and `task check-evidence-update`; then `task prepare-return`;
then `task verify-return --from-current-repository` before review. Hosts and
agents must not inspect internals, hand-author JSON/digests, substitute those
observations for a return, or infer cancellation from host status alone.
GitHub has no files `role-start` aggregate producer and retains its documented
explicit `task check-evidence-init` step.

Adapters are status-bearing in `agenticloop.json` so downstream projects can
see what is supported and what is reserved.

The table below describes artifact generation and ordinary host integration,
not parser-owned activation capture. Every shipped adapter declares activation
capture `unsupported` through the shared generated slots because its request
text is model-visible. That is intentional fail-closed behavior and it does not
change from inside a session.

`unsupported` no longer means "unusable". It means the *host* cannot prove
activation, so the operator does, through one explicit command outside the agent
session:

```text
npx agenticloop activate T-016 T-017
npx agenticloop activate --work-unit <work-unit-id>
```

See [Universal activation](#universal-activation) below. Registering a protected
host adapter remains the only route to `host_signed` activation and
`host_receipt` returns, and therefore to hardened mode.

A registry document may describe a target-bound key and supported capabilities,
but the current public and delegated in-process CLI always rejects such entries.
A callback, derived filesystem path, JSON flag, environment variable visible to
the delegated process, or same-user writable registry is not mechanical
protection. The packaged host seam therefore treats its callback only as a
transport: it emits a fresh random challenge binding the exact target, trust
store, adapter inventory, and five-second liveness window, and accepts support
only when every requested adapter returns an Ed25519 signature from its pinned
key. A boolean return is always refused. The signing key and transport still
require authenticated host-controlled IPC, an inherited protected OS handle,
OS isolation, or an equivalent external boundary. With no derived store, the CLI
safely reports shipped adapters as typed unsupported; malformed existing stores
still fail as malformed/rejected input, while a well-formed store that declares
dynamic supported capabilities is typed negative/blocked unsupported-boundary
evidence, never malformed evidence and never trusted authority.

Agentic Loop-owned adapter settings use strict JSON (`agenticloop.json` and
`agenticloop/config.json`).

Configuration has two explicit layers. `agenticloop.json` is tracked, portable
project configuration. Optional `.agenticloop/local/config.json` is ignored
clone/device configuration used only by `hydrate`. The local file may contain
only adapter `roleSettings` model/effort fields supported by that host; unknown
adapters, roles, fields, unsafe paths, backend/trust changes, and security
boundary changes are rejected. The merge exists only in memory and is never
written back to `agenticloop.json`.

Example without credentials or device secrets:

```json
{
  "adapters": {
    "opencode": {
      "roleSettings": {
        "engineer": {
          "model": "provider/model",
          "reasoningEffort": "high"
        }
      }
    }
  }
}
```

## Setup

Use `npx agenticloop setup` for guided adapter selection and model
configuration. Use `npx agenticloop doctor` to inspect adapter state without
mutating files. For manual setup, use `npx agenticloop init --adapter <host>`
followed by `npx agenticloop configure models --adapter <host>`.

The interactive model picker offers catalog models, custom model IDs, keep
current, skip, and cancel options. Custom model IDs are first-class for
private deployments, local providers, and preview models. When configuring
interactively, Agentic Loop tries host-native model discovery where a safe
noninteractive list command exists:

- OpenCode: `opencode models` lists provider/model identifiers.
- Cursor: `agent models` lists `id - label` entries for the current account.
- Codex: `codex debug models` prints JSON model metadata.

Claude Code and Copilot do not have a safe noninteractive model-list command,
so their interactive pickers use the bundled catalog and custom entry only.

Discovery is best-effort and non-fatal. If a command is missing or fails, the
picker falls back silently to the bundled catalog. Override the discovery
command via environment variables `AGENTICLOOP_OPENCODE_COMMAND`,
`AGENTICLOOP_CURSOR_COMMAND`, or `AGENTICLOOP_CODEX_COMMAND`.

The bundled catalog is a convenience fallback with source and freshness
metadata; it may become stale and is never treated as a complete current
source of truth.

Fresh Codex setup writes an opinionated target-owned profile: `gpt-5.6-luna`
with `xhigh` for orchestrator, `gpt-5.6-terra` with `xhigh` for maintainer,
`gpt-5.6-terra` with `high` for engineer, and `gpt-5.6-sol` with `high` for
auditor. These are setup defaults, not canonical role contracts. Auditor always
gets its own explicit slot; the maintainer model is never silently copied into
it, because the audit exists to be independent of the authority that accepted the
work. Existing explicit fields remain untouched; apply the
same missing-only profile deliberately with:

```text
npx agenticloop configure models --adapter codex --profile recommended
```

The command reports added and preserved fields and does not regenerate output.

## Non-Interactive Git Environment

Launch Agentic Loop host sessions with Git editor, pager, and terminal prompts
neutralized so unattended lanes fail or accept prepared messages instead of
hanging on VS Code, Vim, a pager, or credential input. Include GitHub CLI prompt
guards when the project uses the GitHub backend:

```powershell
$env:GIT_EDITOR = 'true'
$env:GIT_SEQUENCE_EDITOR = 'true'
$env:GIT_PAGER = 'cat'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GH_EDITOR = 'true'
$env:GH_PAGER = 'cat'
$env:GH_PROMPT_DISABLED = '1'
```

The same values can be set in Bash with `export`. These environment variables
override the user's global Git and GitHub CLI editor and pager only for the
launched session. Agents should still use explicit-message, file-backed, and
no-pager commands, but the environment is the backstop when a conflict
continuation, PR command, or read command would otherwise open an interactive
surface.

Use `npx agenticloop worktree add <task-id> <branch> [--from <ref>]` for
delegated write lanes. It creates `.agenticloop/worktrees/<task-id>`, ignores the
worktree parent through `.git/info/exclude`, and writes worktree-scoped Git guard
config. Use `npx agenticloop worktree guard --fix --all` to repair existing
Agentic Loop worktrees, `npx agenticloop worktree list` to inspect all registered
worktrees, and `npx agenticloop doctor` to report missing guards.

Worktrees have a lifecycle. After a task is accepted and integrated, run
`npx agenticloop worktree cleanup --dry-run` to preview which standard
`.agenticloop/worktrees/*` lanes are safe to remove. Cleanup is destructive
filesystem cleanup and requires `--dry-run` first, then `--yes`. It keeps open
pull requests, locked worktrees, worktrees with blocking dirty source or shared
`.agenticloop` state, external or detached worktrees, and lanes with active task
state. Task-specific lane-local `.agenticloop` state is flat only (`logs`,
`tasks`, `summaries`, and `decisions` files directly under `.agenticloop/<dir>/`);
it is preserved before removal and does not by itself block cleanup. Nested or
shared `.agenticloop` files are not lane-local and dirty shared state blocks
cleanup. Git worktree removal may be forced internally only after preservation
succeeds. For `.jsonl` lane-local files, preservation is safe when the root file
already contains every lane line (a root superset). If lane-local preservation
conflicts with existing root state, use `npx agenticloop worktree resolve-state
<task-id|path> --strategy <prefer-root|prefer-worktree|union-jsonl> --yes`
(default `--dry-run`) to resolve before cleanup: `prefer-root` copies the root
file into the lane, `prefer-worktree` copies the lane file into the root, and
`union-jsonl` computes a root-first max-count multiset union and writes the
result to both files. resolve-state never removes worktrees or branches. Shared `.agenticloop` files are not preserved.
Project-root bare coordinator repos are supported. Branch deletion is not part
of v1 cleanup. External or detached worktrees require explicit review and are
never bulk-removed. Use `npx agenticloop worktree remove <task-id|path> --yes`
for single-worktree removal with lane-local state preservation, or
`npx agenticloop worktree prune --dry-run` to inspect stale Git registrations.

| Host | Status | Adapter output | Generation command |
|---|---|---|---|
| OpenCode | supported | `.opencode/agents/*.md` plus `.opencode/commands/agenticloop.md` | `agenticloop generate opencode` |
| Codex | supported | `.codex/agents/*.toml`, `.agents/skills/agenticloop/SKILL.md`, `.agents/skills/agenticloop/agents/openai.yaml`, `.agents/skills/agenticloop/references/skills/<name>/reference.md`, optional `plugins/agenticloop/.codex-plugin/plugin.json` | `agenticloop generate codex` |
| Claude Code | supported | Mode A: tracked root `.claude-plugin/` packaging (activation command and role agents, with no copied plugin skill payloads). Mode B: generated `.claude/commands/agenticloop.md`, `.claude/agents/*.md`, one public `.claude/skills/agenticloop/SKILL.md` with internal `references/skills/<name>/reference.md`, and `.claude/settings.local.json` by default | `agenticloop generate claude-code` (Mode B) |
| Copilot | supported | `.github/agents/*.agent.md`, one public `.github/skills/agenticloop/SKILL.md` with internal `references/skills/<name>/reference.md`, `.github/skills/agenticloop/references/backends/*.md`, and `.github/prompts/agenticloop.prompt.md` | `agenticloop generate copilot` |
| Cursor | supported | `.cursor/agents/*.md`, one public `.cursor/skills/agenticloop/SKILL.md` with internal `references/skills/<name>/reference.md` and backend references under `.cursor/skills/agenticloop/references/backends/*.md` | `agenticloop generate cursor` |

## Unified Host-Skill Surface

Agentic Loop keeps many canonical skills as the source of truth, but it exposes
them to hosts as a single public activation skill plus internal procedure
references:

- Canonical source: `agenticloop/skills/<name>/SKILL.md` (multiple skills, never edited by
  adapters).
- Generated public surface: exactly one discoverable `agenticloop/SKILL.md` per
  host that renders generated skills (Codex, Claude Code Mode B, Copilot, and
  Cursor).
- Internal procedures: `references/skills/<name>/reference.md` copies of each
  canonical skill. They are renamed from `SKILL.md` to `reference.md` so the
  host skill picker does not treat every internal procedure as a separate public
  skill. No discoverable `SKILL.md` files exist under `references/`.

This keeps a single clean entry point in each generated skill surface while
still shipping the full procedure set. OpenCode and Claude Code Mode A are
command-first and do not render a generated skill surface: their prompts point
at the canonical `agenticloop/skills/<name>/SKILL.md` files by explicit path instead.

`.agents/skills` is a shared agent-skills location used by Codex (and visible to
OpenCode in the same target), so it must not contain per-procedure Agentic Loop
skills. Only the single public `.agents/skills/agenticloop/SKILL.md` is
discoverable there; everything else lives under its `references/`. OpenCode's
generated Agentic Loop entry point remains `/agenticloop`; its parser-owned
activation capture capability is unsupported.

`.github/skills` is a shared Copilot customization location, so the Copilot
adapter also keeps exactly one public `.github/skills/agenticloop/SKILL.md`
skill. Internal procedures live under `.github/skills/agenticloop/references/`
as `reference.md` copies instead of separate public skills.

`.cursor/skills` is a shared Cursor customization location, so the Cursor
adapter also keeps exactly one public `.cursor/skills/agenticloop/SKILL.md`
skill. Internal procedures live under `.cursor/skills/agenticloop/references/`
as `reference.md` copies instead of separate public skills. The Cursor MVP does
not generate `.cursor/rules/` or always-on hooks by default.

## Stop Agentic Loop

`stop` is an exact activation argument that deactivates Agentic Loop in the
current conversation and safely checkpoints unfinished work. It is not task
closeout, worktree cleanup, host exit, or a request to terminate a host process.

| Host | Stop invocation | Resume invocation |
|---|---|---|
| OpenCode | `/agenticloop stop` | `/agenticloop <task or context>` |
| Claude Code repo-local | `/agenticloop stop` | `/agenticloop <task or context>` |
| Claude Code plugin | `/agenticloop:stop` | `/agenticloop:start <task or context>` |
| Codex | `$agenticloop stop` | `$agenticloop <task or context>` |
| Copilot CLI | `/agenticloop stop` | `/agenticloop <task or context>` |
| Cursor | `/agenticloop stop` | `/agenticloop <task or context>` |

The stop contract first stops new Agentic Loop work and new role spawning, then
inspects active subagents, background work, and worktree lanes. It uses safe
host interruption controls when available and otherwise reports still-running
activity without waiting indefinitely. When progress is not durable, it appends
a concise dated checkpoint to the active task record but keeps the task status
unchanged unless an independent blocker exists. A voluntary stop is neither
`blocked` nor `needs_context`.

Stop never automatically accepts, closes, commits, pushes, merges, deletes a
branch, or removes a worktree. Codex `/stop` is a separate built-in control for
background terminals, and `/exit` or `/quit` exits the host rather than Agentic
Loop. Use the dedicated task closeout and worktree cleanup commands only when
their normal authorization rules are satisfied.

## Role-return handoff receipts

A host that supports exact role-return transport creates an
`agenticloop.role-return-producer` schema-version-2 receipt only after receiving the raw role wire
and collecting its repository/transport evidence. Use the packaged
`createHostHandoffReceipt` helper with a host-held Ed25519 private key. The
receipt authenticates the adapter/key identity and binds the target repository,
invocation ID, packet ID/digest, return ID/digest, packet-liveness expiry, and
canonical repository-evidence digest. The host must supply the producer role it
observed at that boundary; the helper does not derive it from the assignment.

The receiving CLI verifies that receipt with an operator-pinned public key from
the fixed host-owned registry. It never receives a signing secret. The core
receive boundary authenticates the raw receipt itself against the
packet-selected adapter/key and the exact repository evidence; for a files
backend it additionally requires a Git reader and rederives the current head,
contiguous ancestry, commit list, and changed paths, so caller-authored
repository evidence cannot replace durable Git state. An adapter that
cannot isolate an Ed25519 private key or cannot produce parser-controlled bytes
reports the corresponding capability as unsupported; an Orchestrator-authored
receipt is not a degraded substitute.

### Auditor-return receipts

Protected host integrations import the packaged production implementation from
the `agenticloop/auditor-return-receipt` subpath (the deep path
`agenticloop/src/auditor-return-receipt.js` keeps working).
`createAuditorReturnReceipt` is the
bounded canonical signature-payload helper for an external host signer;
`loadAuditorReturnReceiptVerifier` loads the fixed operator-pinned trust store,
requires the existing `returnReceipt: supported` capability, and returns the
verifier injected as `auditProvenanceVerifier`. The receipt binds immutable role
`auditor`, adapter/key, target repository, invocation reference and mode, work
unit, exact candidate, canonical covered tasks, substantive report digest,
receipt identity, and issue/expiry instants.

The wrapper supplies `protectedBoundary` as transport for the loader's fresh
nonce-bound challenge. The response must sign the exact target identity,
trust-store path, requested adapter/key, nonce, and issue/expiry instants; returning
`true` or replaying a response for another challenge cannot authorize the load.
The installed regression passes a closed host-owned configuration envelope
through an inherited OS file descriptor rather than flags or environment
variables. The ordinary packed
CLI supplies no signer or boundary and still fails closed. Do not expose verifier
selection, trust root, or private key through a public flag, environment variable,
generated prompt, or ordinary delegated callback. Receipt shape and signature are checked
before semantic and freshness checks, so forged-and-expired data remains
untrusted while an authentic expired receipt is stale. Private keys remain
external; the package ships no key and no general agent-callable signing command.

#### Packaged reference integration: inherited descriptor

`loadAuditorReturnReceiptVerifier` is a seam. The package also ships one bounded
reference integration that occupies it, so an operator does not have to author
the wrapper from scratch: `agenticloop/protected-host-boundary` (deep path
`agenticloop/src/protected-host-boundary.js`).

It reads one closed JSON configuration envelope from **inherited file descriptor
3**, exported as `PROTECTED_KEY_DESCRIPTOR`. The envelope contains exactly
`kind`, `schemaVersion`, `adapterId`, `keyId`, `targetRepositoryIdentity`,
`operatorTrustRoot`, `assertedPath`, and `privateKey`. The trusted parent owns all
of those values; none can be replaced through the JavaScript API, argv, or the
environment. The target passed by the wrapper must derive the same repository
identity carried in the envelope.

The descriptor payload is UTF-8 JSON with this closed shape (the paths must be
absolute, and `assertedPath` may be `null` to use the store derived from the
protected root):

```json
{
  "kind": "agenticloop.protected-host-config",
  "schemaVersion": 1,
  "adapterId": "acme.parser.v1",
  "keyId": "acme-key-1",
  "targetRepositoryIdentity": "file:/absolute/target",
  "operatorTrustRoot": "/absolute/operator/host-trust",
  "assertedPath": null,
  "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
}
```

```js
// host-wrapper.mjs, spawned as:
//   spawn(process.execPath, ['host-wrapper.mjs'],
//         { stdio: ['ignore', 'inherit', 'inherit', protectedConfigFd] })
import { runCli } from 'agenticloop';
import { loadProtectedAuditorReturnVerifier } from 'agenticloop/protected-host-boundary';

const loaded = loadProtectedAuditorReturnVerifier({ target });
if (!loaded.ok) throw new Error(loaded.errors.join('; '));

process.exitCode = await runCli(args, { auditProvenanceVerifier: loaded.verifier });
```

The integration:

- keeps the private key and trust configuration outside the package, target
  repository, environment, CLI flags, and every generated prompt - they exist
  only in host-owned storage and on the descriptor the host passed;
- fixes the production channel to descriptor 3 and exposes no alternate reader,
  descriptor, signing-callback constructor, test clock, trust-root override, or
  adapter/key override;
- answers the exact nonce-bound loader challenge and nothing else, so it is not
  a general signing oracle - an unrecognized challenge shape is refused, not
  signed;
- loads the exact operator-pinned trust store named by the protected envelope
  and requires its target binding and pinned public key to match;
- registers no CLI subcommand, so no agent-callable signing command exists;
- fails closed with a stated reason and a null verifier when the descriptor is
  absent, empty, unreadable, malformed, target-mismatched, or does not carry an
  Ed25519 private key matching the pinned adapter.

This is a *reference* integration for an operator who already holds the key and
spawns the CLI. Shipping it does not grant any generated host adapter the
boundary: an adapter that runs `npx agenticloop ...` as a plain subprocess
passes no descriptor and holds no key, so it stays fail-closed exactly as
before. Granting the capability remains an operator act.

#### Preparing a report for signing

The digest a receipt authenticates is computed over the CLI's **normalized**
report, not over the raw wire document the Auditor produced. The CLI trims
surrounding whitespace, lower-cases severities and provenance, canonicalizes
covered tasks, and normalizes boolean forms before it derives that identity. A
host that digests the raw document therefore signs a different identity, and its
genuine receipt is rejected.

Import `prepareAuditorReturnReportForSigning` from
`agenticloop/audit-report-schema` (or the deep path
`agenticloop/src/audit-report-schema.js`) and follow exactly two steps:

```js
import { prepareAuditorReturnReportForSigning } from 'agenticloop/audit-report-schema';
import { createAuditorReturnReceipt } from 'agenticloop/auditor-return-receipt';

// 1. Normalize the Auditor's raw report and obtain the exact digest the CLI
//    will later derive. Validation is the same closed schema as submission.
const prepared = prepareAuditorReturnReportForSigning(rawReport);
if (!prepared.ok) throw new Error(prepared.errors.join('; '));

// 2. Sign that digest, then insert the receipt into the returned normalized
//    report. Never re-serialize or edit any other field afterwards.
const receipt = createAuditorReturnReceipt({
  /* ... */ reportDigest: prepared.digest,
}, privateKey);
prepared.report.invocation.receipt = JSON.stringify(receipt);

// 3. Submit `prepared.report`. The CLI derives the identical digest.
```

`prepared.report` is the receipt-null normalized projection: `invocation.receipt`
is `null` until step 2 inserts the real receipt. This is the only mode in which a
`verified` report may lack a receipt, and it exists solely because the receipt
cannot exist before its own digest is known. Submitting that projection unsigned
is still refused. There is no dummy-receipt convention, and mutating any
substantive field after signing changes the digest and fails closed - which is
the intended behavior.

#### Challenge lifetime and receipt clock skew

Two separate policies govern time, and they are not the same concept:

- `HOST_TRUST_CHALLENGE_TTL_MS` (`agenticloop/host-trust`) bounds how long one
  protected loader challenge stays answerable. Signed `issuedAt`/`expiresAt`
  values use the wall clock, while callback duration uses an independent
  monotonic clock. A response at or beyond the elapsed-time limit, a backward
  monotonic reading, or an invalid wall-clock date is refused however well it is
  signed. Low-level tests may inject `clock` and `monotonicClock`; the packaged
  production wrapper exposes neither.
- `AUDITOR_RECEIPT_FUTURE_SKEW_MS` (`agenticloop/auditor-return-receipt`) bounds
  tolerated clock disagreement between the signing host and the verifying
  process for a receipt's `issuedAt`.
- `AUDITOR_RECEIPT_MAX_VALIDITY_MS` (`agenticloop/auditor-return-receipt`) bounds
  both a receipt's observed age and the validity interval it declares for
  itself. Without the interval bound, a receipt could name an arbitrarily
  distant `expiresAt` and stay replayable indefinitely.

`now`, `clock`, and `monotonicClock` are separate low-level test inputs and are
never substituted for one another. `clock` supplies the challenge's wall-clock
timestamps, `monotonicClock` measures callback duration, and `now` fixes the
instant receipt freshness is evaluated against. Passing only `now` therefore
leaves challenge expiry on the real monotonic clock rather than freezing it. A
non-finite clock is refused rather than treated as "no freshness check".

## Universal activation

The plugin-free path works on every host, including hosts Agentic Loop has no
adapter for at all. It needs no OpenCode plugin, no host integration, and no
change to any existing task.

```text
/agenticloop T-016 T-017                  # in the agent session, as usual
npx agenticloop activate T-016 T-017      # once, in your own terminal
```

The `activate` command prints the exact tasks, carriers, contract digests,
repository, work unit, and resulting assurance, then requires you to type a
confirmation. After it succeeds, those tasks are eligible for dispatch if every
other gate passes. Their IDs, bodies, history, decomposition state, and
repository state are untouched: **existing tasks and projects never need to be
recreated.**

Work-unit activation derives child bindings from committed decomposition
evidence:

```text
npx agenticloop activate --work-unit phase:4
```

Inspect and manage what exists:

```text
npx agenticloop activation status            # every binding and its usability
npx agenticloop activation status T-016      # one task
npx agenticloop activation revoke grant:<uuid>
npx agenticloop activation provision-key     # optional; activate provisions lazily
```

### What the grades mean

| Dimension | Grade | Meaning |
| --- | --- | --- |
| Activation | `host_signed` | Parser/host-owned capture authenticated by an isolated signer pinned in the operator trust store. |
| Activation | `operator_confirmed` | A human at an interactive terminal on this machine confirmed the exact task set and contract digests. |
| Return | `host_receipt` | Authenticated host handoff receipt proving the observed producer role. |
| Return | `session_reported` | Schema-valid, fully revalidated role result with **no** authenticated host producer proof. |

Two modes combine them. `standard` requires at least `operator_confirmed`
activation and permits `session_reported` returns. `hardened` requires
`host_signed` activation and `host_receipt` returns.

Activation and return adapters are independent packet bindings. A capability
declaration is never evidence that a capture or receipt occurred. Hardened
closeout requires a persisted, observed, authenticated host receipt from the
exact packet-bound return adapter and key.

`operator_confirmed` is **procedural, local-user assurance**. It proves a human
saw the exact scope and typed a confirmation on this machine. It is not
equivalent to an isolated host signer and it does not resist arbitrary hostile
code running as the same OS user. No output describes it, or a
`session_reported` return, as cryptographically host-authenticated.

### Why a repository file cannot forge it

Grants and bindings live under `.agenticloop/activations/`, but their authority
does not. Each record is signed with an operator confirmation key held **outside**
the repository, under `~/.agenticloop/operator-activation/<target-sha256>.json`,
provisioned lazily on first activation. A hand-authored grant inside the
repository fails verification however self-consistent its fields and digests
are, and copying `.agenticloop/activations/` into another checkout carries no
authority because every record binds one canonical repository identity.

On POSIX the key file and its directory are created `0600`/`0700`. On Windows
the toolkit sets no explicit ACL and reports that honestly rather than claiming
protection it did not apply; keep your per-user profile directory restricted.

`init` and `setup` add `.agenticloop/activations/` to the managed `.gitignore`
block. The records are short-lived, machine-local, and authenticated at use
time against an external key, so committing them would add noise without adding
authority. The dispatch clean gate names them as a distinct permitted class -
neither scratch nor shared workflow state - and the return boundary still
refuses those paths as implementation work.

`activate` refuses non-interactive invocation and refuses to run under CI. There
is deliberately no `--yes`: a flag that let an agent mint this grade silently
would erase the only thing that distinguishes it from an unsigned file.

### Setting an activation policy

Repository configuration may *raise* the bar in `agenticloop.json`:

```json
{ "activation": { "mode": "hardened" } }
```

An operator pin held outside the repository sets a floor the repository cannot
lower, at `~/.agenticloop/operator-activation/<target-sha256>.policy.json`:

```json
{
  "kind": "agenticloop.activation-policy-pin",
  "schemaVersion": 1,
  "target": { "repositoryIdentity": "file:/absolute/target" },
  "mode": "hardened"
}
```

Hardened policy therefore never rests on model-writable repository
configuration alone. A malformed pin or a malformed repository request fails
closed at `hardened`.

## Operator Trust Stores

The public CLI reads one pre-registered store from the fixed per-user operator
registry at `~/.agenticloop/host-trust/<target-sha256>.json`. The filename is
derived from the canonical real path identity of the target checkout; use the
packaged `operatorTrustStorePath(target)` helper when provisioning it. A host
integration may inject a different registry root through its in-process I/O
context, but an agent-callable CLI argument cannot choose that root.

`--host-trust-store <absolute-path>` is optional and only asserts the exact
pre-registered path the CLI already derived. A different external path is
rejected, even when it contains a valid target and key controlled by the caller.
The store's `target.repositoryIdentity` uses `file:<canonical-real-path>` form,
and each adapter or blocked-result authority has one Ed25519 SPKI-DER public
key encoded as base64. Schema version 1 remains valid for adapter-only stores.
Schema version 2 adds the closed verification-only `authorities` inventory:

```json
{
  "kind": "agenticloop.host-trust",
  "schemaVersion": 2,
  "target": { "repositoryIdentity": "file:/absolute/target" },
  "adapters": [{
    "adapterId": "operator.parser.v1",
    "keyId": "rotation-2026-07",
    "algorithm": "ed25519",
    "publicKey": "<base64-spki-der>",
    "capabilities": { "activationCapture": "supported", "returnReceipt": "supported" }
  }],
  "authorities": [{
    "authorityId": "orchestrator-redelegation-2026",
    "authorityKind": "blocked_result_redelegation",
    "keyId": "rotation-2026-07",
    "algorithm": "ed25519",
    "publicKey": "<base64-spki-der>",
    "issuer": { "ownerKind": "workflow_role", "ownerId": "orchestrator" },
    "revokedRecordIds": []
  }, {
    "authorityId": "repository-human-authority",
    "authorityKind": "human_disposition",
    "keyId": "rotation-2026-07",
    "algorithm": "ed25519",
    "publicKey": "<base64-spki-der>",
    "issuer": { "ownerKind": "human_authority", "ownerId": "human_authority" },
    "revokedRecordIds": []
  }]
}
```

Adapter metadata alone is not sufficient host authority. An ordinary public CLI
call rejects every adapter entry that declares a supported capture or receipt
capability, even when the path is outside the target and its key is well formed.
A supported host integration may use the protected `hostAuthority` I/O seam,
but only after its host-controlled boundary authenticates the capture/receipt
channel and approves the exact target identity, trust-store path, and supported
adapter IDs supplied by the loader. This seam is not a CLI flag and cannot
select another trust root. Authority entries are verification-only roots for
signed redelegation or human-disposition records. Signing happens only at the
external trusted Orchestrator or human/operator boundary; private keys never
enter generated adapters, packets, returns, dispositions, or archives.
Semantic record digests prove integrity but never issuer identity.

A repository actor can commit an adapter, public key, private key, or
self-consistent authority record they retain, but the CLI neither discovers nor
trusts repository-local data. In particular,
`.agenticloop/host-trust.json` may be carried as a portable manifest but grants
no authority. The current protected integration seam consumes separately
protected registry material only after the host boundary approves the exact
loader context. The CLI never uses the repository-local file as a fallback.

The loader resolves the target and registry through their real filesystem paths,
rejects a registry that resolves inside the target, and rejects a symbolic-link
store. These checks prevent path aliases from turning target-owned data into an
apparent external trust root.

The capture signature, dispatch packet, and return receipt all bind the same
target identity. Return verification chooses the expected adapter and key from
the packet's verified activation capture, not from a receipt-controlled adapter
field. A wrong target, adapter, key ID, public key, malformed signature, future
timestamp, expired packet liveness, missing store, or unreadable store fails
closed with a typed result before mutation or acceptance.

For key rotation, generate a new Ed25519 pair outside the repository, update the
external store with the replacement `keyId` and public key, then switch the host
signer. Reissue captures, packets, and receipts after the rotation; old artifacts
remain intentionally unverifiable once their key is no longer pinned. Never put a
private key in source, fixtures, archives, prompts, packets, returns, receipts,
environment variables, or generated adapter output.

### Constructing signed blocked-authority records

Use the packaged canonical helper instead of recreating JSON canonicalization or
signature input:

```text
node scripts/sign-blocked-authority.mjs --request redelegation-request.json --private-key C:\operator-keys\redelegation.pem --output redelegation.json --config agenticloop.json
```

The request is a JSON object with exactly these top-level inputs:

```json
{
  "type": "blocked_result_redelegation",
  "signing": {
    "authorityId": "orchestrator-redelegation-2026",
    "keyId": "rotation-2026-07"
  },
  "record": {
    "blockedReturn": "<the complete validated blocked role-return object>",
    "toRole": "maintainer",
    "authority": {
      "ownerKind": "workflow_role",
      "ownerId": "orchestrator",
      "reference": "dispatch:redelegate:T-001"
    },
    "reason": "Maintainer must repair the task contract.",
    "issuedAt": "2026-07-30T12:00:00.000Z",
    "expiresAt": "2026-07-30T13:00:00.000Z"
  }
}
```

For exceptional recovery, set `type` to `human_disposition`. Its `record`
contains `blockedReturn`, the exact `recovery` object, `human.actor`,
`human.authorityReference`, `reason`, `issuedAt`, `expiresAt`, and
`result.ownerRole`/`result.nextTransition`. The helper calls the production
`createBlockedResultRedelegation` or `createHumanDisposition` implementation,
which derives the closed record shape, semantic digest, canonical Ed25519
signing input, packet/return binding, and invalidation inventory. `--config`
loads target `workflowRoles` so a valid custom role ID can be selected.

The private-key file must be operator-controlled and correspond to the
authority ID/key ID pinned in the target's schemaVersion 2 external trust
store. The helper writes a new output file with create-only semantics and
restricted mode where the platform supports it; it prints only the output path.
It never prints or embeds private key bytes. Verify the resulting record through
`task verify-return`; do not treat a recomputed digest as issuer authentication.

## Adapter Status

The `adapters.<host>.status` field in `agenticloop/config.json` records adapter
availability.

- `supported` -- implemented, documented, and available for generation.
- `placeholder` -- reserved name with no generator yet. Avoid referencing it in
  target-owned config until the generator exists.

All five implemented adapters – OpenCode, Codex, Claude Code, Copilot, and
Cursor – are supported. Tests, validation commands, and packaging checks remain
development and release quality checks.

## Role capability enforcement

Generated canonical roles and their display labels come from the workflow-role
registry. Durable filenames, config keys, model bindings, attribution, dispatch,
and authority continue to use immutable `roleId`. A target may extend
`workflowRoles` with a closed entry and a matching `roles.<role-id>` source
configuration; hyphenated IDs are valid. Config validation and blocked-result
ownership/authority use that effective registry, and CLI diagnostics enumerate
its effective IDs. The four canonical roles retain their contract-defined
acting capability policies. A target extension does not silently inherit one
of those acting policies merely because it has an agent file.

The current implementation-mutation matrix is:

| Host | Engineer path | Orchestrator and Auditor denial | State and limitation |
| --- | --- | --- | --- |
| OpenCode | Native edit and retained `bash` | `permission.edit: deny`, with `bash` retained | `advisory`; edit/write/apply-patch are denied, but shell commands can still mutate. |
| Claude Code | `permissionMode: acceptEdits` | `permissionMode: plan` | `enforced` for whole-agent editing; writable roles are not path-typed. |
| Codex | Custom-agent instructions permit Engineer edits | Generated role instructions | `advisory`; generated custom-agent TOML has no per-agent write restriction. |
| Copilot | Custom-agent tool list includes `edit` and `execute` | `edit` is withheld, but `execute` is retained | `advisory`; retained shell execution can still mutate. |
| Cursor | `readonly: false` | `readonly: true` | `enforced` for whole-agent editing; it cannot distinguish workflow-record edits from implementation edits. |

Maintainer retains task/workflow mutation, review, and closeout responsibility;
its implementation denial is therefore advisory on every host because host
tools do not distinguish legitimate workflow edits from implementation edits.
That does not grant general implementation mutation. Orchestrator retains
dispatch and authenticated return-import responsibilities, not implementation.
Auditor remains read-only. All hosts currently report role-result production as
`unavailable` at the production trust boundary because no shipped adapter
contains the external private-key receipt signer. Correctly authenticated
test/integration seams remain available for contract verification.

Every non-enforced action produces a closed version 4 degraded-enforcement
report with stable code `capability.enforcement.degraded`, the action,
capability, enforcement state, and declaration digest. The exact limitation,
`role_return_receive` detection boundary, and recovery route are resolved from
that pinned declaration rather than repeated in every report. Generated agents
carry a short human-readable summary plus the schema, digest, and deterministic
`.agenticloop/host-role-capabilities/<host>.json` path. That sidecar holds the
full canonical declaration exactly once per host; validation recomputes its
canonical bytes and digest, so modification or prompt/sidecar drift fails
closed. Dispatch binds the derived report set and emits its repair-policy
warnings. Return import performs canonical packet validation, including
report/declaration compatibility, at the receive edge; it does not count a
necessarily duplicate report branch as another enforcement layer. Malformed,
contradictory, or caller-fabricated reports fail closed. An
authenticated host receipt records the host-observed producer. A mismatched
producer is rejected even when commit messages contain correct `Task:` and
`Agent:` trailers. Native host restriction, authenticated Agentic Loop checks,
and arbitrary external writes are distinct; none claims control over external
or legitimate human work.

`role_result_import` is advisory in generated host declarations. The receipt
authenticates the producer, but the import boundary has no independently
authenticated importing-role identity. Producer authentication therefore does
not prove that a particular role performed the import.

## Loop-Guard Capabilities

Prompt-level liveness rules reduce loop risk, but host runtime controls are the
model-independent guard. Prefer host adapters and operating modes that can
surface running role status, stream subagent output, cancel a runaway role, and
enforce max steps, max tokens, or timeout limits.

When a host cannot provide cancellation or running-subagent status, treat
long-running parallel delegation as unsupported. Short bounded parallel batches
may still run on such a host when every lane has a clear expected artifact, a
stop condition, an observable-step lease, a no-progress budget, and a join
condition. If even bounded join-based parallelism is unverifiable, use bounded
serial delegation instead, and require each role prompt to include an
observable-step checkpoint cadence, no-progress budget, and status-return stop
condition.

## Concurrency Guidance

Serial execution is the default safety floor, not a preference. Every authorized
multi-task unit receives a current Parallel Opportunity Scan after decomposition
(see `agenticloop/AGENTIC_LOOP.md`); fewer than two ready tasks still produce a
truthful not-currently-eligible result and rescan trigger. Bounded eligible
batches may use at most the target project's configured implementation-lane
maximum (default five). It is a ceiling, not a target or total-agent budget, and
does not automatically apply to review, coordination, or integration lanes.
Choosing serial after eligible candidates exist requires a recorded concrete
reason. Long-running parallelism carries stronger observability requirements
(live status/cancellation or strict bounded leases) than short bounded join-based
batches.

## Per-Host Role Settings

Model identifiers and aliases are host/provider specific. They do not live in
the portable role files under `agenticloop/agents/`. Use
`adapters.<host>.roleSettings.<role>.model` to express the same logical role
with a different concrete model on each host. OpenCode and Codex also support
`adapters.<host>.roleSettings.<role>.reasoningEffort`; Claude Code supports
`model` and `permissionMode` there; Copilot and Cursor currently support
`model` only.
Codex supports `minimal`, `low`, `medium`, `high`, and `xhigh` for
`reasoningEffort`. OpenCode supports `low`, `medium`, `high`, `xhigh`, and
`max` (provider/model-dependent; `minimal` is not offered), plus a `Default`
choice that omits or removes the setting so generated agent Markdown omits
`variant`.

Adapter-local role settings are the supported configuration surface. The
shared resolver still tolerates older configs that put model fields under
`roles.<role>`, but new target configs should not do that. Logical roles stay
host-neutral; concrete model choices live under the host adapter.

The orchestrator should use a model reliable at multi-step instruction
following, state tracking, tool routing, and stop-condition enforcement. It does
not need to be the strongest coding model, but avoid using a lightweight model
that frequently drops workflow state during long task sets. When uncertain,
prefer the strongest general reasoning model available for orchestration. This
guidance is provider-neutral: reasoning-effort labels are not comparable across
providers, and Agentic Loop does not rank or gate specific models.

## Generation Commands

```text
npx agenticloop generate opencode     # .opencode/agents/*.md plus .opencode/commands/agenticloop.md
npx agenticloop generate codex        # directory of artifacts
npx agenticloop generate claude-code  # directory of artifacts
npx agenticloop generate copilot      # .github/agents/*.agent.md plus .github/skills/agenticloop/ and .github/prompts/agenticloop.prompt.md
npx agenticloop generate cursor       # .cursor/agents/*.md plus .cursor/skills/agenticloop/
npx agenticloop generate all          # every implemented adapter
```

Each command accepts:

- `--target <dir>` - directory containing `agenticloop.json` (default: cwd)
- `--output-dir <dir>` - output directory

`generate all` writes every adapter that has a generator in this package.

Generation refuses to overwrite a changed generated artifact by default. Use
`--force-generated` only to refresh an artifact whose manifest proves Agentic
Loop owns it; it never overrides user-owned files or malformed shared config.
It also never overrides a modified cross-adapter transfer: Codex-to-Cursor and
Cursor-to-Codex plugin switching is atomic only when every transferred file is
an exact, unmodified owned output.
Use a single-host generation command when you only want one host's artifacts
in a target project.

For package upgrades, commit the output of `npx agenticloop update
--repository-only`, then run `npx agenticloop hydrate --adapter <host>` in each
clone. Hydration uses `.agenticloop/local/generated-artifacts.json`; legacy
generation commands retain `.agenticloop/generated-artifacts.json`. This keeps
portable and clone-local ownership separate. Plain `update`, `update --adapter
<host>`, and `upgrade` remain deprecated compatibility paths for the former
combined refresh behavior.

## OpenCode Activation

OpenCode is explicitly activated by command. After generating the adapter, run
`/agenticloop [task-id or task description]` from the target project root.
Normal OpenCode prompts stay outside Agentic Loop mode until that command is
invoked. The command reports parser-owned activation capture as `unsupported`:
OpenCode positional placeholders are documented prompt substitutions, not
lossless parser-produced bytes. Do not use `$ARGUMENTS`, `$1`, `$2`, shell
interpolation, a permission prompt, prompt text, or a model-created JSON file as
a capture substitute. This stays `unsupported` permanently.

**No OpenCode plugin is required.** When a task needs activation, the generated
command tells the operator to run, outside the agent session:

```text
npx agenticloop activate T-016 T-017
```

and then continue in the same project and session. Activation assurance is
`operator_confirmed` and returns are `session_reported`. See
[Universal activation](#universal-activation).

### Optional future OpenCode integration

An `opencode.command.before.v1` integration could raise assurance, and is
deliberately not required. To be worth anything it must:

- create `host_signed` activation grants from the parser-owned command bytes,
  before any model sees them;
- inject an **opaque grant handle** into the session rather than the grant
  itself, so nothing the model can read is the authority;
- produce authenticated host-return receipts binding the observed producer role;
- communicate with an **isolated broker** that holds the signing key outside the
  agent process.

A same-process plugin without an isolated signer must not receive `host_signed`
assurance, and this toolkit will not grant it: the trust store's supported
capabilities are only honored after the protected `hostAuthority` boundary
answers a fresh nonce challenge with a signature from the pinned key. A plugin
that can only return a boolean, a file path, or JSON it authored itself is
indistinguishable from the model and stays `unsupported`.

## Codex Activation

Codex MVP support is repo-local and skill-first.

- Generate the adapter, then start Agentic Loop in Codex with
  `$agenticloop [task-id or task description]`.
- The same public skill also appears in `/skills` as `Agentic Loop`.
- Codex does not use a repo-local `/agenticloop` slash command for this
  adapter. Deprecated custom prompts can create personal slash commands under
  `~/.codex/prompts`, but they are user-local and are not the target-project
  contract.
- Codex exposes one clean public skill surface at `.agents/skills/agenticloop/`.
  Internal Agentic Loop procedures are packaged under `references/skills/` so
  the normal Codex skill picker stays clean.
- The main Codex session stays the coordinator/orchestrator. Role work is routed
  through the generated custom agents under `.codex/agents/`, especially
  `maintainer`, `engineer`, and `auditor`.
- Generated-host smoke checks must delegate one fresh Auditor execution after
  covered work is integrated, capture its `auditor_report_v1` JSON through a file
  or stdin, and persist it with `audit report`. Maintainer/Engineer delegation
  alone does not prove the audit path; an inline same-session audit is invalid.
- Optional plugin distribution is separate from repo-local use. Set
  `adapters.codex.plugin.enabled: true` only when you intentionally want
  generated `plugins/agenticloop/` packaging plus
  `.agents/plugins/marketplace.json`.
- Codex and Cursor plugin modes cannot be enabled together because they share
  `plugins/agenticloop/`. A single `generate all` or update can switch the
  enabled host atomically when the prior generated files are unchanged;
  `--force-generated` does not weaken that transfer safety check.

## Claude Code Modes

Claude Code has two distinct install paths:

- Mode A plugin packaging lives at the toolkit root in `.claude-plugin/`. Its
  public surfaces are `agenticloop/commands/start.md` (`/agenticloop:start`) and
  `agenticloop/commands/stop.md` (`/agenticloop:stop`), plus the canonical role agents under `agenticloop/agents/`. It does
  not copy canonical skills into `.claude-plugin/`, and it does not register
  every canonical `agenticloop/skills/` entry as a separate public plugin skill.
- Mode B is the repo-local adapter generated by `agenticloop generate
  claude-code`, which emits `.claude/commands/agenticloop.md`,
  `.claude/agents/`, one public `.claude/skills/agenticloop/SKILL.md` with
  internal `references/skills/<name>/reference.md` procedure copies, and
  `.claude/settings.local.json` into the target project by default.

Mode B defaults maintainer and engineer subagents to
`permissionMode: acceptEdits` so edit auto-accept is scoped to Agentic Loop
worker subagents rather than the whole repository. Orchestrator and Auditor
subagents default to `permissionMode: plan`, Claude Code's supported non-editing
mode, so their non-implementation posture is enforced mechanically. It also writes the built-in
`agenticloop` permissions profile to `.claude/settings.local.json` by default.
That profile is intentionally broad enough for normal Agentic Loop work,
including common `git`, `gh`, `npm`, `npx`, `pytest`, `ruff`, and `alembic`
commands for both Bash and PowerShell. The local settings file is recommended
because the broader rules stay machine-local and are normally untracked.

Teams that intentionally want shared Claude Code settings may set
`adapters.claude-code.permissions.scope: "project"`, which writes
`.claude/settings.json` instead. Agentic Loop does not set project-wide
`permissions.defaultMode` unless the target explicitly configures
`adapters.claude-code.permissions.defaultMode`.

Claude Code is explicitly activated by command: use `/agenticloop:start` for
Mode A and `/agenticloop` for Mode B. Use `/agenticloop:stop` for Mode A or
`/agenticloop stop` for Mode B to deactivate the loop. It does not rely on hooks, and it never
uses `CLAUDE.md` as an activation mechanism. If Agentic Loop's repository-rules
resolver selects `CLAUDE.md` as the rules document, that file may still carry the
one informational activation-boundary guidance block (see
[Repository-rules activation guidance](#repository-rules-activation-guidance));
that block is informational only and does not activate the methodology.

Mode B detection keys on `.claude/agents/`. Validation expects the repo-local
command at `.claude/commands/agenticloop.md` plus the generated skill namespace
when Claude Code adapter output is present. A root `.claude-plugin/` directory
is Mode A packaging, not repo-local adapter output.

Before refresh, update inspects existing adapter output for model choices and
backfills any missing values into
`agenticloop.json` under `adapters.<host>.roleSettings.<role>`. This preserves
target-local model choices from:

- `.opencode/agents/*.md` frontmatter `model` and `variant`
- `.codex/agents/*.toml` `model` and `model_reasoning_effort`
- `.claude/agents/*.md` frontmatter `model`
- `.github/agents/*.agent.md` frontmatter `model`
- `.cursor/agents/*.md` frontmatter `model`

Explicit values already present in `agenticloop.json` are not overwritten.
New model edits should still be made in `agenticloop.json` or with
`agenticloop configure models`.
Claude Code `permissionMode` is generated from adapter config defaults and is
not backfilled from generated `.claude/agents/*.md` files.

## Copilot Activation

Copilot support is repo-local.

- Generate the adapter, then activate Agentic Loop in Copilot CLI with
  `/agenticloop [task-id or task description]`.
- The generated public skill at `.github/skills/agenticloop/SKILL.md` is the
  Copilot CLI slash surface. It is `user-invocable: true` and
  `disable-model-invocation: true`, so Agentic Loop stays explicit and does not
  auto-trigger during ordinary Copilot work.
- In Copilot IDE surfaces that support `.github/prompts/*.prompt.md`, use the
  generated `agenticloop` prompt file as the IDE prompt-file fallback. That
  prompt binds activation to the generated Copilot custom agent for the
  orchestrator role.
- Generated Copilot custom agents live under `.github/agents/*.agent.md` and are
  rendered from canonical `agenticloop/agents/*.md` plus Copilot-specific delegation wiring.
  The orchestrator is the user-selectable entry agent; maintainer, engineer, and
  auditor are generated as subagent-only workers. The auditor is generated
  without the `edit` tool.
- Generated Copilot skills live under `.github/skills/agenticloop/` as one public
  `SKILL.md` plus internal `reference.md` procedure copies and backend
  references.
- `.github/copilot-instructions.md` is intentionally not generated. Treat it, and
  any `.github/instructions/*.instructions.md` files, as user or team-owned
  customization surfaces.
- `generate all` includes Copilot because it is implemented.

## Repository-rules activation guidance

Independent of any host adapter, `init` and `setup` install one clearly marked,
manifest-owned activation-guidance block into the selected repository-rules
document. The rules document is resolved with a guidance-specific precedence:

1. an explicit `documents.rules` selection in `.agenticloop/project.md`;
2. an explicitly configured target-project `documents.rules` path, when the file
   exists;
3. the first existing candidate from the rules document-role registry
   (`AGENTS.md`, then `CLAUDE.md`, then `GEMINI.md`);
4. `AGENTS.md` as the default path to create when no rules document exists.

Non-Markdown destinations, paths outside the repository, and paths that cross a
symlink or junction are rejected. Only the region between `<!-- AGENTICLOOP_START -->`
and `<!-- AGENTICLOOP_END -->` is owned; everything else in the file is
target-owned and preserved byte-for-byte. A modified owned block or an unowned
manual marker block is preserved and reported rather than overwritten or adopted.
`update` refreshes only a block Agentic Loop already owns and never enrolls an
existing installation that has no owned block. Opt out with
`--no-agents-guidance`, inspect with `agenticloop guidance check`, and remove with
`agenticloop guidance remove`. Because the block is informational, it does not
activate the methodology. `guidance remove --force` removes only the managed
marker region from an edited file. A configured rules-path change is reported as
ownership drift; update does not silently add a second block at the new path.

## Cursor Activation

Cursor support is repo-local.

- Generate the adapter, then invoke `/agenticloop` in Cursor Agent chat.
- Cursor exposes one clean public skill surface at
  `.cursor/skills/agenticloop/`.
- Generated Cursor subagents live under `.cursor/agents/*.md` and are rendered
  from canonical `agenticloop/agents/*.md` plus Cursor-specific delegation and
  boundary wiring.
- The active Cursor session stays the coordinator/orchestrator. Maintainer,
  engineer, and auditor role work is delegated through the generated Cursor
  subagents where supported. The auditor subagent is generated with
  `readonly: true`.
- The Cursor MVP does not generate `.cursor/rules/` or session hooks. Activation
  stays explicit.

## Validation

`npx agenticloop validate` is adapter-aware. It validates an adapter's
output only when:

- the adapter output file or directory is present, OR
- the adapter is marked `enabled: true` or `required: true`, OR
- the user passes `--adapter <host>` to force validation.

This means a target project can use a subset of adapters without seeing
errors for the rest. It also means neither a tracked root `opencode.jsonc` nor
generated `.opencode/` output is required just because `adapters.opencode`
exists in the base config.

Additional validations:

- Generated OpenCode artifacts are checked for a `Generated by Agentic Loop`
  banner. Missing banners produce a warning.
- Files-backend task records that claim an agent opened a PR or merged a branch
  produce an error. PR/merge behavior requires `task_backend: github`.
- Task files under `.agenticloop/` are scanned for dotted toolkit path
  references (e.g. `.agenticloop/agents/`). Those paths are invalid;
  canonical toolkit assets live under `agenticloop/` (no dot).

## Project-Skill Collision Safety

Agentic Loop keeps generated skills distinct from target-owned project skills,
but the mechanism is host-specific:

- Codex repo-local activation uses one discoverable public skill at
  `.agents/skills/agenticloop/SKILL.md`. Internal procedures live under
  `.agents/skills/agenticloop/references/skills/` as `reference.md` files, not
  discoverable `SKILL.md` copies.
- Claude Code repo-local activation uses one discoverable public skill at
  `.claude/skills/agenticloop/SKILL.md`. Internal procedures live under
  `.claude/skills/agenticloop/references/skills/` as `reference.md` files, not
  discoverable `SKILL.md` copies.
- Copilot repo-local activation uses one discoverable public skill at
  `.github/skills/agenticloop/SKILL.md`. Internal procedures live under
  `.github/skills/agenticloop/references/skills/` as `reference.md` files, not
  discoverable `SKILL.md` copies.
- Cursor repo-local activation uses one discoverable public skill at
  `.cursor/skills/agenticloop/SKILL.md`. Internal procedures live under
  `.cursor/skills/agenticloop/references/skills/` as `reference.md` files, not
  discoverable `SKILL.md` copies.

Collision rule:

- target-owned project skills outside the Codex `.agents/skills/agenticloop/`
  directory, outside the Claude Code `agenticloop/` generated subdirectory, and
  outside the Copilot `.github/skills/agenticloop/` generated subdirectory are
  left alone
- generated Codex `agenticloop/` files, stale legacy Codex `agenticloop-*`
  directories, Claude Code files inside `.claude/skills/agenticloop/`, and
  Copilot files inside `.github/skills/agenticloop/`,
  `.github/prompts/agenticloop.prompt.md`, and generated
  `.github/agents/*.agent.md`, plus Cursor files inside
  `.cursor/skills/agenticloop/` and generated `.cursor/agents/*.md`, are
  treated as generated output and may be
  regenerated

## Project State and Activation Boundaries

Generated role bodies embed the canonical role contracts, so they carry the
standing recognition behavior for durable project state – including the Project
Operating Facts responsibilities – without any adapter-specific template edits.

Activated Agentic Loop roles read the live `.agenticloop/project.md` (its
`## Verification Operating Facts` and `## Project Operating Facts` profiles
included) before acting. Because that project map is target-owned mutable state,
build-time embedding of its contents into generated adapters would become stale
and must not be used; adapters point roles at the live file by path.

Ordinary sessions outside Agentic Loop activation are not required to load
Agentic Loop project state. Do not add "read `.agenticloop/project.md` at every
session start" to global host instructions. Host-specific ambient memory remains
outside the core methodology.

## Registry and Marketplace

A registry, marketplace, or package index is not an active target. See
[docs/registry-horizon.md](registry-horizon.md) for the deferral decision and
evidence gates.

## Why Generated Output Lives Outside `.agenticloop/tmp/`

`.agenticloop/tmp/` is the toolkit's verification scratch area. For target projects,
generated host artifacts should live at the host's expected location
(`.opencode/`, `.codex/`, `.claude/`, `.github/`, `.cursor/`, etc.) so
the host can discover them without extra configuration.

For toolkit-level verification, generate into a throwaway directory under
`.agenticloop/tmp/` so the artifacts do not collide with downstream target
generation paths.
