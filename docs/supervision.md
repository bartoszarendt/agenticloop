# OpenCode Supervision

Agentic Loop is a Markdown-defined workflow toolkit with an optional, run-scoped
OpenCode supervision component. Markdown roles, skills, task records, review,
and acceptance remain useful without it. The component is explicit and dormant:
ordinary `/agenticloop` behavior is unchanged.

## Packaging

The MVP is a separately enabled OpenCode component, not part of ordinary adapter
output. The dependency-free controller command is co-shipped so the public
bootstrap remains `npx agenticloop supervise --adapter opencode`, but the
supervisor agent and `.opencode/plugins/agenticloop-supervision.ts` bridge are
generated only after `supervision.enabled` is explicitly set to `true`. Disabling
it and regenerating removes those owned artifacts. No controller code loads or
starts during ordinary Agentic Loop use, and no OpenCode SDK runtime dependency
is added to Markdown-only installations.

## Supported Host

Attached supervision is pinned to OpenCode `>=1.18.4 <1.19.0` and uses the
official OpenCode v1.18.4 plugin, server, and SDK contracts. It requires the
generated plugin's `command.execute.before` hook, exact session IDs, OpenCode
events, session abort/create APIs, and exact permission replies.

Stable releases in that range are accepted, including build metadata. Pre-release
builds such as `1.18.4-beta.1` are not accepted as substitutes for `1.18.4`.

| Support level | Attached OpenCode status |
|---|---|
| Full live | Not claimed until provider-backed recovery is exercised. |
| Bounded stream | Current provider-free bridge: exact registered sessions, event delivery, cancellation, permission replies, and fresh-session preparation. |
| Terminal | Artifact reconciliation after a registered lane returns. |
| Artifact only | Used when a host cannot prove a live session binding. |

Enable the optional component in target-project `agenticloop.json` after review:

```json
{
  "extends": "./agenticloop/config.json",
  "supervision": {
    "enabled": true,
    "execution": {
      "adapter": "opencode",
      "transport": "server",
      "launch": "attached-on-activation"
    },
    "supervisor": {
      "adapter": "opencode",
      "enabled": true,
      "required": true,
      "route": "supervisor",
      "model": "provider/model"
    },
    "activation": {
      "flag": "--supervised",
      "minimum_capability": "attached-live",
      "fail_closed": true
    },
    "permissions": {
      "mode": "eligible-once-only",
      "supervisor_decision": "eligible-once-only",
      "always": "human",
      "high_impact": "human",
      "eligible_operations": ["read", "grep", "glob", "list", "search", "webfetch", "bash"],
      "eligible_bash_patterns": ["git status", "git diff", "git log", "git show", "npm test", "npx agenticloop validate"]
    }
  }
}
```

That is the configuration schema version 1 envelope and remains the default. The
three-tier permission router is opt-in through `permissions.mode`; see
[Three-Tier Permission Routing](#three-tier-permission-routing) for the version 2
sections and their migration.

The validator rejects unsupported adapters, launch modes, disabled required
supervisors, non-fail-closed activation, autonomous `always`, and malformed
budgets or fallback routes. A configured fallback is always an explicit
OpenCode model route; it cannot broaden permission, provider, or cost posture.

## Activation And Authorization

Run the normal command with the explicit flag:

```text
/agenticloop --supervised
/agenticloop --supervised Fix the intermittent checkout test
```

The plugin starts `npx agenticloop supervise --adapter opencode` internally,
passes bootstrap data through stdin and authenticated loopback IPC, and waits for
a bounded handshake. The handshake identifies controller/run/root/supervisor
sessions, attached mode, schema/controller versions, and supported versus
unsupported capabilities. Bridge capabilities are derived from authenticated
OpenCode client-API probes; an unproven method is unavailable rather than
inherited from a static adapter claim. Failure, a version mismatch, missing bridge, or a
missing supervisor session stops the command rather than falling back to an
unsupervised run.

Activation starts observation only. It does not authorize a task, delegation,
permission decision, retry, or root replacement. After the human has selected a
bounded work unit, record that binding explicitly through either:

```text
/agenticloop supervisor authorize <unit-id> <durable-scope-reference>
npx agenticloop supervision authorize <unit-id> <durable-scope-reference>
```

The controller rejects registered-lane creation until this binding exists. This
command records operator provenance; it does not expand the named scope.
The scope reference must explicitly contain each permitted lane `task_ref`
(for example `task-file:T-1,T-2`); exact references and `/` or `#` descendants
are accepted, while an unlisted task fails closed.

## Operator Controls

The generated plugin routes these directly to the controller, without an
orchestrator model turn:

```text
/agenticloop supervisor status
/agenticloop supervisor ask <question>
/agenticloop supervisor explain last
/agenticloop supervisor investigate <root-or-lane>
/agenticloop supervisor pause
/agenticloop supervisor resume
/agenticloop supervisor cancel <root-or-lane>
/agenticloop supervisor retry <root-or-lane>
/agenticloop supervisor replace-orchestrator
/agenticloop supervisor permissions
/agenticloop supervisor permission <request-id> <once|reject>
/agenticloop supervisor permission <request-id> always --confirm-always
/agenticloop supervisor stop
```

`stop` is terminal: the controller rejects further controlled work, closes its
IPC peers, releases project ownership, clears the active-run selection, and lets
the external controller process exit.

This controller-only command is distinct from `/agenticloop stop`, which runs
the canonical current-conversation deactivation contract. When a supervision
controller is active, that contract uses the authenticated controller stop,
checkpoints material unfinished work when needed, and returns the full
deactivation summary. Stopping only the controller does not deactivate Agentic
Loop for the conversation.

The same controls are available from a separate terminal as
`npx agenticloop supervision ...`; add `--json` to status output. Factual
kernel commands (`status`, `pause`, `resume`, `cancel`, `permissions`,
`notifications`, exact human permission response, and `stop`) do not require a
model. `ask`, `investigate`, `retry`, and normal root replacement require the
restricted supervisor model and return `supervisor_model_unavailable` when it is
absent. `explain last` returns a stored compact disposition when no fresh model
turn is available.

`investigate` performs one fresh bounded assessment each time it is invoked.
There is no lifetime per-target cap: it remains available after a retry, after a
new lane session generation, and after a previously unavailable model recovers,
limited only by the ordinary wakeup and cost budgets. An assessment that never
began (model unavailable, budget refused) does not consume an attempt. An
*autonomous* `investigate` disposition may request follow-up assessments, and
that chain is bounded by `supervision.recovery.max_investigation_depth`.

Human-readable `supervision status` reports controller mode/status and run id,
authorization unit and scope, server and bridge state, root and supervisor
lifecycle, lane and pending-permission totals with truncation, every bounded
budget as used/limit/remaining, cost usage with its enforcement mode, active and
absolute time, unsupported attached capabilities, the unread notification count,
and explicit pagination guidance. It never prints permission command text.

`supervision permissions` is explicitly paginated and returns pending and
decided collections with `total`, `returned`, `offset`, `limit`, `truncated`,
and `next_offset`; it never silently returns only the first page. Use
`--offset` and `--limit` on it, on `status`, and on `notifications`.

Notification read state is an authenticated acknowledgment, not a claim the
controller cannot honour. `npx agenticloop supervision notifications ack
[sequence]` records the operator cursor; `unread` means "issued after the last
acknowledgment". Without an explicit sequence, everything issued so far is
acknowledged.

`resume_work_unit` is a supervisor-only, non-mutating control-plane marker. It
requires the unchanged authorization, a live bridge and server, and a non-paused
controller. It reconciles registered root/lane/permission/artifact facts and
returns a bounded continuation summary; it never injects a message, starts a
task, creates a worker, accepts work, or grants new authorization.

`status --json` uses a dedicated public schema. It includes non-secret
authorization (`unit_id`, `scope_ref`, provenance, timestamp), session and
batch summaries, permissions, every configured budget and usage, timing,
capabilities with probe provenance, process limitation, last outcome/disposition,
and notifications.
Collections carry `total`, `returned`, `offset`, `truncated`, and `next_offset`.
Use `--offset` and `--limit` for an explicit subsequent page; no collection is
silently truncated.

## Safety And State

The controller stores non-authoritative recovery state at
`.agenticloop/state/supervision/<run-id>/`. It is atomically written and
gitignored. Task records, artifacts, verification, review provenance, and
backend state remain the workflow truth. The state has a schema version and an
ownership lock; it stores compact identifiers, counters, disposition summaries,
and evidence references, never raw transcripts, private reasoning, prompts, or
credential-bearing diagnostics. The loopback credential is kept in a separate
mode-restricted OS temporary runtime file outside the target project, never in
repository content, logs, or command arguments, and is removed on graceful
controller shutdown. The same-user host account is the trust boundary.

The mechanical kernel records identities, events, budgets, exact permission
state, and locks. It waits while models are idle and serializes model wakeups on
registered lane/root return or failure, exact permission requests, supervisor
failure/replacement, and operator assessment commands. It does not classify
semantic progress or choose retry/fallback recovery by itself. The supervisor
proposes enumerated actions; the kernel enforces authorization, ownership,
capabilities, budgets, route configuration, and human-only gates before executing
one.

OpenCode `once` and `reject` are the only possible supervisor decisions. `always`
is available only through an exact operator command carrying
`--confirm-always`, after the operator reviews the native OpenCode scope. Destructive cleanup, merge, release, publication, credentials,
authentication, external communication, authorization expansion, locked
decisions, backend exceptions, ambiguous consequences, and supervisor-self
permissions are human-only. A rejected request remains an invocation outcome;
when no safe route exists, project roles use the canonical `permission-denied`
blocked-state projection.

## Reserved Vocabulary Versus Attached Capability

The host-neutral action and outcome vocabulary is deliberately wider than what
attached OpenCode mode can execute. A reserved name is not a promise.

| Action | Attached OpenCode status |
|---|---|
| `continue_observing`, `investigate`, `request_operator`, `record_block` | Executable. |
| `fresh_retry`, `use_configured_fallback` | Executable: a fresh registered session in a new lane generation. |
| `cancel_session` | Executable: exact registered session abort. A failed abort is recorded as `failed_cancellation`, never as success. |
| `replace_orchestrator` | Executable while the same server stays live. |
| `resume_work_unit` | Executable as a bounded non-mutating reconciliation marker. |
| `approve_permission_once`, `reject_permission` | Executable. `always` is operator-only. |
| `message_session` | Returns `unsupported_capability` (`live_message_injection`). Attached mode cannot prove reliable live message injection into a running session. |
| `terminate_owned_process` | Returns `unsupported_capability` (`process_termination`). Attached mode owns no OS process tree. |

| Reserved concept | Attached OpenCode status |
|---|---|
| Server recovery | Unsupported. Server loss preserves state and reports `server_recovery: unsupported`; the controller never claims a restart. |
| Managed mode | Unsupported. `supervision.execution.launch` accepts only `attached-on-activation`. |
| `orphaned_process` outcome | Reserved in the host-neutral outcome vocabulary but **has no producer in attached mode**. Process ownership and termination are unsupported, the generated bridge never emits it, and no process-registry entry is ever fabricated. |

## Attached Limitations

Attached mode can abort exact registered sessions, create fresh registered
sessions, and replace the root while the same OpenCode server remains live. It
does not claim reliable live message injection, server restart/recovery,
managed-mode ownership, or operating-system process-tree termination. If the
attached server disappears, the controller preserves state and reports
`server_recovery: unsupported`; factual CLI status/pause/stop remain available.
It never scans ports, process names, terminal output, or newest sessions to infer
ownership. Managed server ownership and direct visible supervisor conversation
are deferred follow-ons.

Attached completion reconciliation recognizes
`file:<project-relative-path>` and `commit:<full-commit-id>`. A registered lane
that becomes idle without one of those proven artifacts is recorded as unknown
and wakes the supervisor; it is not treated as completed workflow work. Session
events outside the registered root, supervisor, and lane set are ignored.

When a bridge disconnects, the controller records `bridge_lost` and stops
model-required and host-required actions while retaining factual status, pause,
and stop. It then performs one bounded health check against the authenticated
loopback server URL: a healthy server remains `bridge_lost`, while a failed
health check becomes `server_lost` with recovery still unsupported. A restarted plugin or
TUI may reconnect only with the same project, run credential, server identity,
and registered root. A different root receives a structured remediation response
and must use the registered replacement-root path or stop/restart after human
review. The same-user Windows account is the attached-mode credential trust
boundary.

Plugin disposal and controller stop are different lifecycle events. Disposing
the plugin (OpenCode exiting, a reload) is an *incidental* disconnect: the
controller keeps its state, records bridge loss, and stays reachable from the
CLI. Only an explicit `/agenticloop supervisor stop` or
`npx agenticloop supervision stop` terminates it.

On reconnect the bridge clears its local session and lane registries and rebuilds
them from an authenticated `bridge.reattach` snapshot: lane id, exact session id,
session generation, task reference, expected artifact, lifecycle/status, route,
and authorization generation. Each stored session is reconciled against the same
pinned server first; sessions the server no longer reports are marked
`unknown_after_reattachment` and routed for bounded reconciliation rather than
trusted. Pending host permissions are never recreated from stale local state --
the snapshot reports `pending_permission_reconstruction:
host-enumeration-unsupported`, the documented ceiling. A different project, run,
server, or root fails closed with explicit remediation.

The spawned controller's stderr is drained by the bridge so a full pipe cannot
deadlock it, but its contents are discarded. Bootstrap failures report only that
private diagnostics were withheld; raw provider stderr is never retained or
copied into a TUI error.

### Secrets In Host-Derived Text

Permission commands, patterns, paths, targets, error text, rationales, and event
and notification data are host-derived and may contain credentials. The
unredacted permission scope exists only as the in-memory input to the mechanical
router, in the bounded transient store described below when the operator
explicitly enables it, and in OpenCode's native pending-permission UI. Agentic
Loop never persists those arbitrary strings, even when the current redaction
patterns consider them benign, and model-projects them only through the
explicitly configured assess-tier egress. The durable internal permission record
carries the normalized operation, scope counts, consequence/risk categories,
and a run-keyed HMAC-SHA-256 scope fingerprint used to reject request-id reuse
with changed fields without exposing a reusable unsalted digest. The current
public and model projections omit the counts and fingerprint as well as the raw
scope. They expose only the bounded permission identity, normalized operation,
empty scope fields, sensitivity flag, authority, and canonical risk result.

Authorization headers, cookies, custom auth headers, bearer/basic tokens, API
keys, credential-shaped environment assignments, URLs with userinfo, OAuth
codes or secret query parameters, package-registry auth tokens, well-known
provider token shapes, JWTs, and credential CLI flags are detected as a second
line of defence.

When sensitive material is detected, `sensitive_material_redacted` is set and
the request is forced human-only. The operator reviews its exact scope in
OpenCode's native prompt; the supervision CLI intentionally does not reconstruct
or echo it.

### Three-Tier Permission Routing

Attached supervision ships two permission models. `permissions.mode` selects
which one is in force, and configuration schema version 1 documents keep the
first one until they are explicitly migrated.

| `permissions.mode` | Behaviour |
|---|---|
| `eligible-once-only` (default) | The version 1 envelope. Every newly registered request charges one `permission_assessments` allowance and wakes the supervisor, which may answer `once` only inside `eligible_operations` / `eligible_bash_patterns`. |
| `policy-assess-human` | The three-tier router below. |

Upgrading the package never changes routing: an unmigrated document normalizes
to `eligible-once-only`, with transient scope disabled, decision memory
disabled, and an empty policy.

#### The Three Tiers

| Tier | Selection | Decision path |
|---|---|---|
| `policy` | Complete, mechanically proven low-impact scope | Replies `once` immediately through the ordinary atomic host-reply path. No model call, no assessment or wakeup charge. |
| `assess` | Complete scope that is neither mechanically safe nor human-only | Wakes the supervisor with a bounded transient scope. The supervisor may approve `once`, reject, or request the operator. Charges one assessment and one wakeup. |
| `human` | Sensitive, protected, incomplete, contradictory, unknown, supervisor-self, pre-authorization, or non-negotiable high-impact scope | Stays pending for the operator. The model is never woken and no budget is charged. |

Evaluation order is fixed and fail-closed: supervisor-self, credential
detection, a host `human_only` marker, and missing authorization route to the
operator before anything else is considered; then non-negotiable categories;
then exact scope; and only then the narrow proofs that can yield `policy`. A
host-supplied category may narrow authority but can never make a request safer.

`always` remains operator-only. It installs host permission patterns whose
effective lifetime and sharing are controlled by OpenCode rather than by the
run-scoped controller, and Agentic Loop cannot reliably revoke them. A replayed
Agentic Loop decision sends an exact host `once` response and never becomes an
OpenCode `always` grant.

#### Configuration

```json
{
  "supervision": {
    "permissions": {
      "mode": "policy-assess-human",
      "supervisor_decision": "eligible-once-only",
      "always": "human",
      "high_impact": "human",

      "transient_scope": {
        "mode": "redacted-provider",
        "maximum_age_seconds": 120,
        "maximum_entries": 50
      },

      "policy": {
        "version": 1,
        "auto_operations": ["read", "edit", "write", "list"],
        "protected_paths": ["config/secrets"],
        "bash_rules": [
          { "executable": "git", "subcommand": "status", "allowed_flags": ["--short", "--porcelain", "--branch"], "allow_paths": false },
          { "executable": "git", "subcommand": "diff", "allowed_flags": ["--stat", "--staged", "--cached", "--name-only", "--name-status"], "allow_paths": true },
          { "executable": "git", "subcommand": "log", "allowed_flags": ["--oneline", "--stat", "--graph", "--decorate"], "allow_paths": true },
          { "executable": "git", "subcommand": "show", "allowed_flags": ["--stat", "--name-only"], "allow_paths": true }
        ]
      },

      "decision_cache": {
        "enabled": true,
        "maximum_entries": 200,
        "policy_ttl_seconds": 900,
        "supervisor_ttl_seconds": 300,
        "rejection_ttl_seconds": 600
      }
    }
  }
}
```

Every section is strictly validated and every bound is explicit. The validator
rejects unknown keys, absolute or traversing `protected_paths`, pattern-shaped
protected entries, free-form command prefixes in `bash_rules`, output-capable
flags, executables that run project-controlled or downloaded code, unbounded
cache settings, and a `supervisor_ttl_seconds` longer than
`policy_ttl_seconds`. `auto_operations` accepts only `read`, `edit`, `write`,
`grep`, `glob`, `list`, and `search`; `bash` is proven by a structured rule, and
`webfetch`, `task`, `question`, and `external_directory` can never be
mechanically approved.

Configuring `transient_scope`, `decision_cache.enabled`, or any policy grant
while `mode` is still `eligible-once-only` is an error rather than a silently
ignored setting, so an operator cannot believe the router is active when it is
not.

**Migration.** Set `permissions.mode` to `policy-assess-human`, then opt each
capability in separately. Enabling the mode alone approves nothing: the shipped
`policy` section is empty. Enabling `transient_scope` is a deliberate provider
egress decision, and `decision_cache` is deliberate memory. The legacy
`eligible_operations` and `eligible_bash_patterns` fields remain valid and
continue to describe the version 1 envelope; they have no effect in the new
mode.

#### Deterministic Policy Tier

Path-bearing operations must prove that *every* effective target is inside the
exact project root and outside the protected set. This applies to reads and
searches, not only writes. Absolute paths, relative paths resolved against the
host-reported working directory, Windows drive letters and case, UNC paths, `..`
traversal, symlinks, junctions, and other reparse points are all handled. A new
write target has its nearest existing ancestor resolved before the remaining
lexical segments are appended, so a file created *below* a junction cannot land
outside the project through a path that merely looks contained. A drive-relative
path such as `C:src` is unresolvable rather than guessed. One escaping target
disqualifies the whole request.

The protected set always includes VCS internals and hooks, CI workflow
definitions, dotenv and credential files, private key material, `.ssh`, `.gnupg`,
`.aws`, Agentic Loop authorization and runtime state, and host or agent
permission configuration. A configured `protected_paths` list extends that set;
it never replaces it. Protection is path-specific and segment-exact, so
`src/auth/session.js`, `src/permissions/index.js`, `src/merge/strategy.js`, and
`src/delete-queue.js` are ordinary source files again.

Wildcard scope is reduced to its literal prefix only to prove the search root is
contained. It never reaches the policy tier, because a contained root says
nothing about what the expansion would match inside it.

Bash policy validates a structured executable, subcommand, arguments, and
working directory. The parser proves a deliberately narrow grammar and refuses
everything else: `&&`, `||`, pipes, semicolons, newlines, backticks, command and
parameter substitution, redirection, background operators, quoting, backslashes,
environment mutation, executable paths, unrecognized tokens, unrecognized flags,
and any output-capable flag. A refusal is not a verdict about the command -- it
means the parser cannot prove what the command does, so the request leaves the
policy tier. `npm test` and `npx ...` are never intrinsically read-only: they
execute project-controlled or unpinned downloaded code and are refused at
configuration time.

A command that parses cleanly and matches a configured executable but names a
protected or escaping path is a proven boundary violation, not merely an
unprovable one: it routes to the operator rather than being offered to the
supervisor.

#### Transient Supervisor Scope

The `assess` tier passes a request-bound transient view containing the
normalized operation, bounded command, patterns, paths, targets, working
directory, containment booleans, lane id, task reference, expected artifact,
and authorization and session generations. It travels in
its own `permission_scope` field on `host.supervisor.assess`; it is never
interpolated into the free-form question, and the durable `modelView()` payload
stays redacted and unchanged.

**This is provider egress.** Sending a scope to a supervisor model sends it to
the configured model provider. Keeping it out of `state.json` does not mean the
provider cannot retain it. That is why `transient_scope.mode` must be set
explicitly and defaults to `disabled`; when it is disabled, every assess
candidate routes to the operator instead.

Secret detection runs *before* insertion. A credential-bearing request is never
inserted and never model-projected, and redaction plus bounded structured
serialization run afterwards as defence in depth rather than as the boundary.
The store is in memory, bounded in entry count, string length, array length, and
age. A duplicate host event cannot replace the immutable scope a pending
decision is bound to, and every read revalidates the request id, authorization
generation, and session generation. Entries are removed on a decision,
rejection, assessment failure, operator escalation, authorization change,
session replacement, bridge or server loss, pause, stop, TTL expiry, and
capacity eviction. If the entry is missing, stale, or inconsistent at the moment
of the provider call, the request routes to the operator. No transient scope
reaches public status, `modelView()`, diagnostics, notifications, JSONL, or
durable run state.

#### Fingerprint-Scoped Decision Memory

Decision replay is bounded Agentic Loop memory, not a host `always` grant. The
cache key covers project identity, authorization generation, lane id, session id
and generation, task reference, normalized operation, policy version, the
run-keyed scope fingerprint, and the lane's durable-progress epoch. A change in
any of them is a different decision, not a hit. The published key is itself a
run-keyed HMAC, so neither a reusable digest nor the scope can be recovered.

The cache is in memory, size-bounded, and evicts least-recently-used entries
deterministically. Policy decisions live for the current generation, supervisor
approvals expire sooner, and rejections carry their own bounded lifetime so a
stale semantic judgment cannot create an unbounded denial loop. A durable
checkpoint advances the lane's progress epoch and therefore invalidates
supervisor decisions recorded against the older task context. Every replay still
performs the exact atomic host `once` (or bounded rejection) reply for the new
request and records `decided_by: cache`, the originating decision id, and the
cache key version. A failed host reply leaves the request pending. The whole
cache is cleared on authorization change, session replacement, bridge or server
loss, and stop.

#### Atomicity, Budgets, And Projection

All four principals -- `policy`, `supervisor`, `cache`, and `operator` -- use the
same order: preview authority and exact request, perform the host permission
reply, then commit the decision. Nothing mutates durable permission state before
the host accepts the reply, and a failed reply leaves the record pending for
every principal.

`policy` may approve `once` only, requires a current policy-tier result for the
exact request at the active policy version, and may neither reject nor issue
`always`. `cache` may replay only its stored decision, must present a complete
cache context that still matches the request, and may never issue `always`.
`supervisor` keeps its existing authorization, authority, action-context, and
self-approval checks and may answer only `once` or `reject`. `operator` keeps
exact manual `once`/`reject`/`always`, with `always` still requiring
`--confirm-always`.

Only a request that actually enters `assess` and begins a provider call consumes
`permission_assessments` and `supervisor_wakeups`. Policy, cache, human-only,
pre-authorization, sensitive, duplicate, and malformed requests consume neither,
and `assessment_scheduled` is never reported true when no assessment could be
scheduled.

Status and `status --json` publish the routing mode, policy version, transient
scope mode and live entry count, per-tier routing counts, and aggregate cache
hits, misses, and entries. Each permission additionally carries its routing
tier, policy version, scope-completeness flag, containment booleans, the
deciding principal, and -- for a replay -- the originating decision id and cache
key version. No raw scope, fingerprint, or cache key is published, and no safe
public field is populated from an arbitrary host string. Every configured
operation, including `grep`, `glob`, `list`, and `search`, now keeps one
canonical identity across routing, the cache key, and public projection;
operations outside the pinned contract stay `unknown` and human-only.

#### Measured Routing And Remaining Limitations

`test/fixtures/opencode-permission-corpus.js` pins 39 sanitized OpenCode
permission event shapes. Each entry declares its provenance as
`sanitized-host-shape` (real pinned-host field shape, rewritten with neutral
project-relative paths and invented identifiers) or `synthetic` (constructed to
exercise a boundary the observed traffic did not contain). No entry carries a
credential, a personal path, a real session id, or transcript text.

Under the recommended policy above, that corpus routes **10 policy (25.6%),
7 assess (17.9%), and 22 human (56.4%)**. That is a measurement over a
deliberately adversarial-heavy fixture set, not a prediction about real traffic
and not an acceptance threshold. No automatic-approval percentage is claimed.

Operations and cases that still route to `assess` or the operator because exact
scope cannot be proven:

- `grep`, `glob`, and `search` in practice, because their scope is normally a
  wildcard pattern and a contained search root is not proof of what it matches;
- any bash command outside a narrow configured structured rule, including every
  quoted argument, backslash path, `npm`/`npx`/`node` invocation, and any
  command carrying an output-capable flag;
- `webfetch`, `task`, `question`, and `external_directory`, which are never
  policy-eligible;
- any request whose working directory the host does not report, whose paths use
  a spelling outside the recognized `paths` / `path` / `files` / `file` /
  `filePath` / `file_path` / `filepath` keys, or whose declared paths and
  patterns describe different scopes;
- drive-relative paths, UNC shares, and anything the filesystem cannot resolve.

The pinned OpenCode `permission.updated` event carries only `id`, `sessionID`,
`type`, `pattern`, and a free-form `metadata` object. The generated bridge adds
the exact project directory from `ctx.directory`. Where that contract does not
supply enough exact information for an operation, that operation routes to
`assess` or the operator by design.

### Time Accounting

Elapsed time is charged to the state that actually elapsed, not to the state
being entered. Authorize, pause, resume, entering and leaving an operator wait,
the first pending permission, the last decided permission, bridge/server loss,
and stop all account before they mutate. Absolute age is independent of every
bucket, and repeated saves in one instant cannot double-account. Permission wait
is an independent measurement: when one lane waits but a sibling or root remains
runnable, the same interval contributes to both permission-wait duration and
authorized active time. A pending request never suppresses observation of an
unrelated running lane.

### Liveness Versus Durable Progress

Liveness and durable progress are separate clocks. Ordinary messages,
busy/session updates, and tool completions prove a session is alive; they never
reset the durable-progress lease. No-progress detection runs from the last
verified artifact/task/evidence checkpoint, an explicit lease checkpoint, or lane
registration -- never from message traffic, stdout, tool activity, or arbitrary
filesystem timestamps.

The generated bridge exposes `agenticloop_checkpoint` to registered lane
sessions. It accepts only the exact expected artifact or a checkpoint declared
in that lane's immutable delegation envelope, verifies the referenced file/path
or commit through the host, and then renews the lane's no-progress allowance.
The checkpoint never certifies completion or opens a batch join.

Each lane carries one normalized lease, stored and consumed as
`lease.no_progress_ms` (milliseconds). A delegation envelope may spell it
`lease.no_progress_ms`, `lease.no_progress_minutes`, `lease.ms`,
`lease.minutes`, or a bare numeric `lease` in minutes; out-of-bounds values are
rejected and fall back to `supervision.recovery.no_progress_minutes`. Two lanes
in one run can therefore carry different thresholds. The observation tick itself
is a fixed 60 seconds in the attached MVP and is deliberately not configurable.

### Backoff And Exhaustion

A rate-limited route defers its *entire* reassessment until the bounded
deadline; nothing is assessed early, so it can never be freshly retried before
its deadline. The backoff record is generation-bound: a replaced session, a
changed authorization, pause, stop, bridge or server loss, or an operator action
invalidates it, and exactly one wake fires on expiry. A delay that exceeds the
remaining time budget routes to the operator instead of being scheduled.

Once a lane's unknown-outcome or no-artifact allowance is spent for its current
generation, only `request_operator`, `record_block`, and `cancel_session` remain
offered; no further ordinary recovery retry is scheduled. The counters reset only
for a genuinely new authorized lane generation.

In `eligible-once-only` mode, every newly registered permission request consumes
one `permission_assessments` allowance before a supervisor wake is scheduled.
In `policy-assess-human` mode, the assessment and wakeup allowances are reserved
together only when an assess-tier request is about to cross the provider
boundary. If either allowance is unavailable, the exact request remains pending
and is routed to the operator without a model assessment.

A completed invocation without a verified expected artifact consumes the lane
no-artifact allowance (`lane_no_artifact`). Periodic durable-progress assessment
uses the separate `lane_no_progress` allowance, so one cannot exhaust or disable
the other. An unclassifiable host result
consumes the unknown-outcome allowance (`lane_unknown_outcomes`). One event never
charges both.

Supervisor cost enforcement is a pre-gate: once a nonzero
`supervisor_cost_units` ceiling is reached, the provider is not invoked again for
that run. The OpenCode bridge and provider acceptance driver normalize cost from
the returned assistant message or step-finish records; if the pinned host returns
no cost field, tracking remains explicitly `unsupported`. Status reports measured
usage, the ceiling, the enforcement mode, and exhaustion.

Each bounded budget emits one "approaching" notification at
`supervision.notifications.approaching_threshold_percent` (default 80) and one
exhaustion notification, and never repeats either. Routine observation and
`continue_observing` never notify.

### Batch Joins And Lane Dispositions

An invocation outcome and a workflow disposition are different facts. A join
opens only when every required lane has a verified expected artifact or an
explicit durable `failed`, `blocked`, or `cancelled` disposition carrying
provenance, an exact session, and a matching session generation. Starting a
fresh lane generation clears any older disposition and closes the join until
the retry produces a verified artifact or a new explicit disposition.
`permission_rejected` is an answered wait, not a
blocked lane. `failed_configuration` needs operator remediation, not a completed
disposition. A host-reported cancellation is not an operator- or
supervisor-approved terminal lane decision. `record_block` persists against the
exact lane. Successful sibling artifacts are always preserved.

### Event Projection

Lane events are projected to the task's canonical JSONL. Root and run
control-plane events -- root and supervisor registration, root replacement,
exhaustion, termination -- have no task and are projected to a run-scoped log at
`.agenticloop/logs/supervision/<run-id>.jsonl` through the same canonical
validation and append path, with `scope: run`, a `run_id`, a null `task_id`, and
controller/supervisor/operator provenance. One logical event reaches exactly one
store. No prompts, transcripts, private reasoning, credentials, or raw host
payloads are ever recorded, and an append failure becomes a secret-safe
diagnostic rather than an exception.

Attached mode has no arbitrary process registry. Status reports `processes: []`
and `process_termination: false` unless a host supplies verified process
provenance; it never scans PIDs, ports, names, or command lines. Cost tracking is
`unsupported` unless OpenCode returns normalized usage. A configured
`supervisor_cost_units: 0` disables enforcement rather than claiming a zero-cost
allowance.

One live controller owns a project at a time, guarded by an ownership lock. The
lock records an owner id, a PID, and a `process_instance` token; release requires
the exact owner id *and* the exact process instance. There is no cross-platform,
verifiable process *birth* identity available here, so staleness is still decided
by PID liveness alone, and no weak substitute is invented. **Known limitation:**
if the operating system reuses a dead controller's PID, takeover is refused with
`pid_reused_or_owner_unverified` and the lock can remain stranded until an
operator reconciles it. That is deliberate and fail-closed: no live process is
ever stolen from or terminated to acquire a lock. Delete
`.agenticloop/state/supervision/locks/controller.lock` only after confirming no
supervision controller owns the project.

## Troubleshooting

- Regenerate OpenCode output after upgrades: `npx agenticloop generate opencode`.
- A failed handshake is intentional. Check OpenCode version, configuration,
  generated `.opencode/plugins/agenticloop-supervision.ts`, and the configured
  supervisor model before retrying.
- If the root fails but the server remains live, use `status` then model-backed
  `replace-orchestrator`; the new root rereads canonical state before mutation.
- If the server fails, do not retry as if a restart occurred. Use CLI factual
  status and stop or restart a new run after human review.
- Provider-backed release smoke is opt-in and spends real provider budget. It is
  gated on an explicitly marked disposable fixture, never on ambient credentials:

  ```text
  AGENTICLOOP_OPENCODE_PROVIDER_SMOKE=1
  AGENTICLOOP_OPENCODE_PROVIDER_TARGET=<disposable fixture directory>
  AGENTICLOOP_OPENCODE_PROVIDER_MODEL=<provider/model>
  AGENTICLOOP_OPENCODE_PROVIDER_COST_ACK=yes
  AGENTICLOOP_OPENCODE_PROVIDER_CREDENTIALS_ACK=yes
  AGENTICLOOP_OPENCODE_PROVIDER_TIMEOUT_MS=<30000..600000>
  ```

  The target must contain `.agenticloop-provider-fixture.json` with
  `{"disposable": true, "purpose": "agenticloop-opencode-provider-smoke"}`. The
  repository root, a configured workspace root, and the home directory itself are
  refused. The gate records only that credentials were acknowledged; it never
  reads a credential value. OpenCode is served from that exact fixture. The
  driver proves an initial engineer provider turn, aborts the exact generation-1
  session, labels the ensuing transport outcome as fixture-injected, and starts
  a fresh engineer provider turn that must create the expected artifact. The
  driver itself never writes the artifact. It cleans up exactly the sessions and
  files it owns and writes a sanitized report under the fixture's
  `.agenticloop/tmp/` containing identities, classifications, generations,
  actions, timings, and artifact references -- never prompts, model responses,
  credentials, or private reasoning. Without the fixture the scenario is skipped
  and provider-backed acceptance stays partial.
