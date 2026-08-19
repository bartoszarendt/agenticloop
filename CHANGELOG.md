# Changelog

## Unreleased

### Highlights
- **A resumed attempt can return.** Product work committed under an attempt that
  is later abandoned is no longer stranded. The product head is derived from Git
  rather than pinned to `HEAD`, and a return whose task carries prior abandoned
  attempts binds the earliest carried base and states that claim explicitly in
  `productLineage`, re-derived from durable records and reproved against Git at
  every verification boundary.
- **Public failures are diagnosable again.** Every command-boundary envelope
  carries a real `debugReference`, `--debug` and `AGENTICLOOP_DEBUG=1` reach
  failures a command catches internally, and role-return construction throws a
  typed public error that names its own cause instead of being generalized to
  "required operational context is unavailable".
- **A producer for the commit grammar.** `task commit-message` emits a
  canonically trailered message file, so no role has to hand-author the one
  artifact the toolkit is strictest about.

### Added
- Added `task commit-message <id> --class <commit-class> --subject <text>
  --output <file>`, which writes a commit message whose final contiguous block
  is exactly one `Task:`/`Agent:` pair. The commit class decides the attributed
  role, the producer and the `commit-attribution check` validator share one
  renderer, and every refusal that reports a trailer defect now names this
  command as its repair. `git commit -m … -m …` inserts a blank line between each
  `-m` and therefore strands `Task:` outside the final block; commit the emitted
  file with `git commit -F <file>` instead.
- Added `productLineage` to the role return and its repository evidence (role
  return schema version 5). It is `null` for an ordinary attempt and otherwise
  names the explicitly abandoned execution attempts whose committed product work
  the return carries, together with the carried base it therefore binds. The
  verification boundary re-derives the lineage from the same dispatch-consumption
  and abandonment records and refuses a return whose claim does not match, or
  whose carried base is not an ancestor of the packet base.
- Added `nextSequence` to the `task handoff-preflight` result: the complete
  ordered sequence the verdict is predicting, with what each step writes and
  which of those writes must be committed before the next step's gate can pass.
- Added rewritten-history detection to the execution-attempt ledger. A recorded
  product base Git can no longer reach, a base that is no longer an ancestor of
  the current head, or a live `git replace` mapping now refuses a new packet with
  the Maintainer-owned `dispatch.attempt.history_rewritten` diagnostic instead of
  being discovered after the fact.

### Changed
- `task evidence --class implementation_artifact_evidence` now accepts a
  `--product-head` that is `HEAD` **or** an ancestor of it, provided no product
  path changed after that commit, and requires the named commit to introduce at
  least one non-workflow path. Pinning the field to `HEAD` forced every resumed
  attempt to rebind `implementation_artifact` to a role-start workflow commit,
  which then derived an empty product range and made the return unreachable.
- `task lint` now refuses an `implementation_artifact` whose commit introduces no
  non-workflow path, so the field cannot durably name workflow state while the
  implementation sits earlier in history.
- The dependency snapshot's `freshnessPolicy` is now optional and derives the
  same backend-based default as the decomposition (`86400` for files, `3600` for
  GitHub), and `task refresh-handoff-evidence` emits that derived policy rather
  than carrying a hand-authored window forward into one that expires again inside
  the same delegation cycle. A declared policy is still honoured as authored.
- The dispatch liveness window is derived rather than hand-sized: a packet now
  stays consumable for the same window a default activation grant covers, instead
  of one hour. Every fact a packet binds is revalidated at consumption, so the
  clock is a backstop, not a timer on the operator.
- The dispatch liveness window now gates consumption only. A boundary
  revalidating an already-consumed attempt - return verification, review entry,
  acceptance, integration, closeout - judges the packet's window at the instant
  the attempt was consumed, exactly as it already judges that attempt's
  activation authority. Widening the window only postponed the failure: an
  attempt whose repairs, review, or closeout ran past it was retired for elapsed
  time alone while every fact the packet bound still held. Nothing extends a
  minted packet; the window simply stops being a gate once the packet has been
  consumed, and a packet that has *not* been consumed is still refused on the
  current clock.
- `task refresh-handoff-evidence` now emits the backend-derived freshness window
  for the decomposition it regenerates, not just for the dependency snapshot. The
  regeneration is a new observation by a new producer, so carrying the old
  policy forward - or falling back to a hand-written hour - re-stamped
  `observedAt` and left the regenerated decomposition expiring again inside the
  same delegation cycle. The decomposition and dependency-snapshot defaults are
  now one derivation rather than two identical copies.
- Every producer a command calls directly now refuses caller-supplied evidence
  with a typed public error that keeps its own sentence: activation grants,
  task activation bindings, activation revocations, and dispatch consumption
  records join role returns. Untyped, those refusals reached the failure
  boundary as bare `TypeError`s and were erased to "required operational context
  is unavailable" - or, uncaught, rendered as an unexpected internal failure.
- Usage refusals now carry the command's own shape — accepted operands, accepted
  options, and the usage line — at the point of use, rather than pointing at a
  separate help command.

### Fixed
- Fixed the `debugReference: null` and message erasure at the command-failure
  boundary. A command that caught its own error produced an envelope with no root
  cause and no reference by which to request one, and `--debug` printed nothing
  because the failure never reached the top-level handler.

### Migration and compatibility
- The role return schema version moved from 4 to 5 with `productLineage`. A role
  return record minted before this upgrade (schema version 4) is refused after it
  ("role return schemaVersion must be 5"), and its digest is bound to the v5
  projection. Both `task verify-return` and the later acceptance/closeout
  lifecycle step validate the retained role return against the current schema, so
  an in-flight v4 return must be re-minted with `task prepare-return` against the
  current packet and check evidence before either boundary is retried. Tasks whose
  returns were verified and terminally closed out before the upgrade are
  unaffected; retain the v4 records as history.

## 0.4.3 - 2026-08-18

### Highlights
- **Atomic files-backed readiness.** `task readiness-plan` can now produce an
  exact, reviewable execution plan, and `task readiness-apply` settles the
  task-contract history, decomposition, and carrier as one guarded transaction
  with at most one Maintainer-attributed commit.
- **Canonical acceptance and closeout lineage.** Post-return review mutations no
  longer invalidate the Engineer evidence they review: acceptance and closeout
  resolve the durable Engineer return terminal while preserving the live
  carrier's own transition authority.
- **Consistent terminal dispatch refusal.** Dispatch packet creation now applies
  the same lifecycle rule as preflight, so accepted and closed tasks cannot be
  reminted into a new execution attempt.

### Added
- Added `task readiness-apply <id> --plan <path> (--dry-run|--yes)`, the
  Maintainer-owned mutation that settles the whole files-backed readiness
  sequence as one transaction. It consumes one reviewed executable readiness
  plan, re-resolves every bound input, validates the exact candidate bundle
  prospectively, writes the task-contract history append, the decomposition
  source, and the task carrier through the shared filesystem mutation kernel, and
  creates **at most one** Maintainer-attributed commit. Previously this took four
  or five commands and usually two commits, and a repair in the middle could
  invalidate evidence an earlier command had already produced.
- Extended `task readiness-plan` with the exact apply inputs (`--actor`,
  `--authority`, `--work-unit`, `--base`/`--base-paths`, `--dependencies`,
  `--max-age-seconds`, `--route`, `--rescan-trigger`). The command remains
  read-only. With every input supplied it emits an **executable** plan
  (`applicable: true`) that binds the expected HEAD, the expected carrier digest,
  the trusted contract-chain terminal state, the resolved base tree, the committed
  dependency snapshot and its source commit, the observed task inventory, the exact
  write set with each path's expected predecessor state, the final commit message,
  and a `planDigest` over the whole closed plan. Without them the plan is
  display-only and lists its blockers. The plan schema version is now 2.

### Changed
- **Packet creation refuses terminal tasks.** `task prepare-dispatch` applied
  only part of the dispatchability rule: it refused everything that had not yet
  reached an execution attempt, but accepted `accepted` and `closed` and left
  them to preflight. That narrowing existed solely because the closeout fixtures
  built their evidence backwards — setting a task terminal and then minting the
  packet that was supposed to have preceded it. Those fixtures now build one
  attempt in real chronological order, and the packet constructor applies
  `evaluateDispatchableLifecycle` unchanged. A terminal task receives the same
  typed refusal everywhere, and no operator action or packet remint reopens it.

### Fixed
- **A files-backed acceptance can now complete through the canonical handoff
  chain.** It never could: the acceptance gate requires post-return Maintainer
  review provenance on the carrier (`review_status`, `review_mode`,
  `reviewed_artifact`, `## Scope Completed`, `## Evidence`), yet the transition
  demanded that the verified return still describe the *live* carrier — a
  condition that recording review provenance makes impossible. `task status <id>
  accepted` now expects the return to describe the durably recognized **Engineer
  return terminal** (the dispatch consumption plus the Engineer receipt chain,
  resolved from stored records rather than supplied by the caller), and
  rederives return evidence against the retained return head the way terminal
  closeout already does. The live carrier keeps its own authority: the
  `--expect-digest` gate and the atomic write that performs the transition.
- `resolveCarrierLineage` now names the boundary it is asked about. An
  `engineer_return` resolution terminates at the last Engineer receipt and
  refuses to absorb a lifecycle-owned mutation such as `acceptance_transition`;
  a `lifecycle` resolution continues through it to the live carrier. A lifecycle
  receipt can never bridge a gap in the Engineer chain — an interrupted chain
  still fails closed — and a receipt that chains itself onto any member of the
  active generation with a mismatched dispatch identity is now refused instead
  of being ignored as unrelated history.
- Closeout compared the verified return against the **role-start** carrier, so
  an Engineer that recorded its own carrier evidence under a valid receipt could
  not close out. It now compares against the Engineer return-lineage terminal,
  and refuses when that terminal cannot be resolved at all.
- Expiry is now non-retroactive across every transition that acts on an
  already-consumed attempt, not just the closeout's covered-task assurance. The
  revalidation of the stored return and of the retained packet — at review
  entry, acceptance, integration, and closeout alike — is evaluated as of the
  consumption instant, so a 12-hour grant whose window closes during review no
  longer blocks acceptance of work it genuinely authorized. Revocation is
  unchanged: it is matched by grant identity, stays time-independent, and still
  refuses. Pinning only narrows — a grant issued after the attempt started still
  fails.
- `task readiness-apply` now guarantees the exact commit tree across Git hooks,
  with commit and rollback ownership bound to the reviewed branch ref. The
  exact staged tree is captured from the verified index before the commit, the
  full symbolic ref and its OID are captured immediately before `git commit`,
  and after every hook has run the *reviewed ref* - never ambient HEAD, which a
  hook may have switched - must hold exactly one new commit directly above the
  expected HEAD whose tree equals the captured tree and whose message is the
  reviewed message. A hook that stages an unplanned path (a product file above
  all) or rewrites planned bytes makes that one commit the transaction's own
  invalid commit: it is rolled back by a compare-and-swap ref update
  (`git update-ref <ref> <expected> <created>`) that moves only if the ref
  still points at the created commit, with index entries restored one literal
  pathspec at a time and operation-owned paths restored to their exact
  predecessor bytes, and reported `rolled_back`. Everything else is preserved
  and reported `unresolved`: a post-commit hook that adds another commit
  (changed-tree or same-tree), a hook that switches branches (the other branch
  is never rewound), a ref that moves between detection and rollback, or a
  compare-and-swap refusal - no commit outside the one this transaction created
  is ever rewritten, and receipt heads and commit counts are derived from the
  actual post-state rather than assumed. Hooks and signing policy remain fully
  honored (`--no-verify` is never used).
- `already_current` is now a proven state rather than an early exit. A fresh
  ready plan is `already_current` only while its digest and bound facts still
  match; a consumed plan only while HEAD is still its exact readiness commit
  (parent = the plan's expected HEAD, reviewed message, exactly the planned
  paths). Both forms still pass current applicability, repository safety, and
  canonical committed verification. A later HEAD movement makes a consumed plan
  `stale`; a detached HEAD or unrelated staged/dirty state makes the rerun
  `blocked`; stale and blocked results never carry activation guidance.
- Repository safety now refuses staged scratch: only untracked or unstaged
  transient work under `.agenticloop/tmp/` is ignored, and a force-staged
  (or otherwise staged) `.agenticloop/tmp/` entry is refused like any other
  staged change, in `--dry-run` and `--yes` alike. The post-commit cleanliness
  check applies the same staged-versus-unstaged distinction.

### Changed
- `task readiness-apply` refuses a stale or altered plan before any write:
  unknown plan fields, an unsupported schema version, a tampered digest, a wrong
  task, backend, or repository identity, an unresolved placeholder, a product or
  activation path in the write set, and duplicate or conflicting write entries all
  fail closed, as does a moved HEAD, a changed carrier digest or status, damaged
  trusted history, a changed dependency snapshot, changed inventory membership, or
  a changed predecessor path state.
- `task readiness-apply` never stages a path it did not plan. Any staged entry
  (including staged scratch under `.agenticloop/tmp/`), unrelated tracked or
  untracked change, dirty planned path whose bytes the plan did not bind, or
  detached HEAD is refused; a refusal resets, restores, and discards nothing,
  and rollback on the transaction's own failures restores only operation-owned
  paths and their index entries - no broad or destructive reset is performed
  anywhere. `git add -A` is never used and Git hooks and signing policy are
  never bypassed. The write set is workflow evidence only; readiness never
  writes activation and never activates.
- The readiness transaction prepares the decomposition over the prospective
  agent-ready carrier the same commit introduces, so the committed decomposition
  is no longer stale against its own commit.
- `task establish-baseline` and `task status <id> agent-ready` now build and
  validate their candidates through the same extracted preparation functions the
  readiness transaction uses, so the standalone and orchestrated routes cannot
  accept different evidence. Their observable behavior is unchanged.
- `task readiness-apply` is declared files-only. Invoking it with the GitHub
  backend returns the standard typed unsupported-backend result rather than a
  partial cross-carrier orchestration.

## 0.4.2 - 2026-08-16

### Highlights
- **Pre-delegation preflight.** `task handoff-preflight` is a new read-only gate
  that reports every ordinary prerequisite and one safe repair before dispatch
  packet assembly, on both the files and GitHub backends. It derives
  dispatchability from the same canonical validator `task prepare-dispatch`
  uses, so preflight and dispatch return the same verdict on the same fixture.
- **Bounded derived-evidence refresh.** `task refresh-handoff-evidence` applies
  one digest-bound plan that renews dependency snapshots, regenerates the
  decomposition, and refreshes dispatch liveness. Snapshot renewal and
  decomposition regeneration apply as one atomic pair, the write surface is
  confined, and a stale or forged plan is refused with zero writes.
- **Dispatch stops refusing healthy repositories.** Registered sibling worktrees
  no longer dirty the active checkout's clean-state scan, a large ignored tree
  no longer overflows Git's output buffer into a false Git failure, and
  prose-only carrier edits no longer stale an otherwise ready set.

### Added
- Added `task handoff-preflight <id>`, a read-only pre-delegation prerequisite
  check. It evaluates activation, readiness against the real dependency snapshot
  recorded in the decomposition, decomposition dispatchability through the
  canonical dispatch validator, repository and sibling-worktree state, host-role
  capability, and return-adapter resolution, then reports the disposition owner
  and one first safe repair. Clean state is explicitly advisory and flagged as
  evaluated at dispatch time. Options: `--host` (required when several adapter
  hosts are configured), `--return-adapter` (required when several eligible
  protected-boundary adapters exist), `--host-trust-store`, `--repair-plan` to
  write a bounded refresh plan, `--output` for an atomic target-relative JSON
  write, and `--json`. Ambiguous or unknown `--host` and `--return-adapter`
  values fail closed with typed errors, and a present-but-malformed
  `agenticloop.json` is an error while a missing config remains acceptable.
- Added GitHub-backend parity for preflight. The evaluator resolves `#NUMBER`
  (direct) and `T-NNN` (label lookup) issue references through the `gh` CLI with
  the strict identity resolver, shares the task-contract and carrier digests
  with the files backend, and stays read-only. Downstream activation, readiness,
  decomposition, repository, host-role, return-adapter, and sibling logic is
  backend-agnostic. `--repair-plan` applies only to the files backend and
  returns a typed refusal elsewhere without discarding the preflight verdict.
- Added `task refresh-handoff-evidence <id> --plan <path> --yes`. The snapshot
  path is re-derived from the on-disk decomposition rather than from the plan,
  guarded by a protected-prefix denylist, and verified with a canonical digest.
  Apply is atomic with a compare-before-write against expected digests and
  inputs, followed by refetch and validation. The write surface is derived
  evidence, decomposition provenance, and at most one bound dependency snapshot;
  never task contracts, activation, human decisions, review dispositions,
  acceptance, closeout, or product files. Dependency refresh renews the
  observation window: it writes a fresh `observedAt`, carries Maintainer-recorded
  statuses forward unchanged, verifies every declared dependency has a recorded
  status, and does not re-observe dependency state.
- Added `--role <orchestrator|maintainer|engineer|auditor>` to
  `commit-attribution check`, so the expected role is selectable rather than
  fixed. A non-canonical or non-lowercase role is rejected through the new
  `attribution.role` diagnostic, and the emitted repair plan names the expected
  role instead of always naming Engineer.
- Added a finding-resolution matrix and decision to `task review-prepare
  --json`, built from the canonical review record's stable finding IDs and
  revision classification. Both are null on a first review and populate on a
  revision round once the review record carries a `needs_revision` outcome.
  `matrixDecision.maintainerFixupEligible` is true only when every finding in the
  round is record-only, routing that correction to the Maintainer without
  consuming an Engineer revision round; any implementation-changing finding
  routes to the Engineer without hard-blocking review entry. Classification is
  derived per revision round, not per finding, and the `contract-changing` class
  is currently unreachable because the review record permits only
  `implementation_changing` and `record_only`. Per-finding classification is a
  known limitation, not yet implemented.
- Registered the `return.assurance.ambiguous`, `capability.resolution.failed`,
  `attribution.role`, `handoff.refresh.plan.malformed`, and
  `handoff.refresh.plan.unsupported` repair-policy result codes.

### Changed
- The `Agent:` commit trailer is now matched case-sensitively against the exact
  lowercase canonical `roleId`. A capitalized spelling such as `Agent: Engineer`
  that 0.4.1 accepted (it lowercased the value before comparing) is now rejected
  as a wrong trailer across `commit-attribution check` and the Engineer-return,
  Maintainer-decomposition, review-entry, and derived-evidence verification
  gates. Author the trailer as the lowercase `roleId` (`Agent: engineer`).
- Refetched inventory digests that differ while membership is identical are now
  re-evaluated through the shared parallel-scan projection and compared by
  decomposition-eligibility digest. Equal projections accept the drift as
  observation-only, so a prose-only carrier edit no longer stales the ready set.
  Material drift still fails closed, including status changes on any member,
  scope or required-check contract changes, `depends_on` add/remove/swap,
  knowledge-coupling flips affecting candidature, membership or readability
  changes, and old-shape scans lacking the new eligibility fields. Callers that
  do not opt into the recheck keep the previous fail-closed behavior. The
  handoff-evidence receipt now uses the canonical decomposition-eligibility
  digest and rejects any other domain.
- Every Git `spawnSync` now shares a 64 MiB `maxBuffer` bound, and a
  post-ceiling overflow is reported distinctly as an overflow rather than as an
  unreadable Git query.
- Dirty registered worktrees are kept with a stated reason. Removal still
  requires an explicit `--force`, and no repair output prescribes force-removal
  to satisfy dispatch cleanliness.

### Fixed
- Fixed registered sibling worktrees blocking dispatch on a clean root. Sibling
  roots are excluded from untracked and ignored scans of the active checkout by
  resolved registered path, never by pattern-matching the worktree directory,
  and a per-sibling `git status` spawn can be skipped. Enumeration fails open,
  so an ignored non-worktree directory still fails the gate, and uncommitted
  sibling content is byte-identical after every run.
- Fixed the dispatch clean gate refusing a pristine checkout when a large
  ignored tree under `.agenticloop/` exceeded Node's 1 MB default `spawnSync`
  `maxBuffer` and the resulting `ENOBUFS` was misread as a Git failure.

### Migration and compatibility
- Author the commit trailer as the lowercase `roleId` (`Agent: engineer`).
  Capitalized spellings that 0.4.1 accepted are rejected by every gate that
  parses the trailer.
- Run `npx agenticloop update` after upgrading so generated role, backend, and
  skill guidance includes the new handoff-preflight and refresh-handoff-evidence
  steps. User-modified managed blocks remain preserved and are reported rather
  than overwritten.

## 0.4.1 - 2026-08-14

### Highlights
- **Public dispatch and return lifecycle.** Files-backend users can prepare a
  dispatch, produce shell-neutral command evidence and an Engineer return, and
  independently verify that return through supported CLI commands without
  constructing internal JSON contracts by hand.
- **Authenticated return evidence.** Protected host execution receipts bind the
  exact repository, packet, invocation, task contract, work unit, carrier,
  candidate heads, command artifacts, and producer return. Signed replay state
  is prepared and committed through the protected host boundary and is
  revalidated without re-consuming the receipt.
- **Cross-platform execution.** One shell-free runner resolves Windows command
  shims, records exact argv and bounded output, distinguishes startup and runtime
  timeouts, and terminates descendant process trees on Windows and POSIX.

### Added
- Added public files-backend producers for dispatch preparation, required-check
  execution evidence, Engineer role returns, and independently refetched return
  verification. Advanced explicit inputs remain validated and cannot override
  derived repository or lifecycle authority.
- Added schema-v4 return-verification records with separate activation and
  return-assurance grades, exact return-generation binding, durable disposition,
  and a fixed version-1 freshness policy of 86,400 seconds.
- Added canonical target/worktree path identities shared across dispatch,
  execution evidence, host trust, return verification, and handoff recognition.
  Public artifact selectors remain target-relative and reject absolute paths,
  traversal, and supported symlink escapes.
- Added typed lifecycle compatibility diagnostics and read-only lifecycle
  orientation. Non-current records remain historical evidence and route safely
  to fresh current evidence rather than being relabelled in place.
- Added host-neutral cancellation provenance. Host end-turn, interruption,
  budget-pause, or accepted-but-ignored interrupt state cannot establish
  authoritative Agentic Loop cancellation without a protected receipt producer.
- Added deterministic `status --json` lifecycle output and packaged public
  lifecycle coverage across the supported host adapters.

### Changed
- The generated Auditor is now dual-mode. By default it runs as a **standalone
  auditor**: an ordinary bounded, read-only, evidence-based assessment of
  whatever scope the caller names. Standalone delegation does not activate
  Agentic Loop, requires no task ID, audit ID, audit record, or audit packet,
  creates no Agentic Loop workflow state, and returns explicitly non-certifying
  findings. Missing Agentic Loop metadata no longer stops the Auditor or produces
  an Agentic Loop verdict.
- Existing formal work-unit certification is unchanged. Agentic Loop mode is
  selected only by explicit Agentic Loop activation, or by an explicit request to
  certify or re-audit a tracked work unit against a designated Agentic Loop audit
  record or audit packet. It keeps the exact frozen candidate, covered-task
  equality, all six perspectives, the four verdicts, the audit budget, invocation
  provenance, audit-record persistence, the fresh-invocation and no-same-session
  rules, non-substitutability, and the exact `auditor_report_v1` return format.
  A formal certification request with a missing or ambiguous packet stays in
  Agentic Loop mode and returns `needs_human_decision`; it is never silently
  downgraded to a standalone assessment. The closeout certification gate is
  unchanged.
- The managed activation-guidance block now also describes standalone auditor
  delegation. Because its canonical content changed, an unchanged owned block
  installed by an earlier version reports `stale` from `agenticloop guidance
  check` until `agenticloop guidance apply` or `agenticloop update` refreshes it
  in place. User-modified owned blocks are still preserved and reported rather
  than overwritten, and unowned marker blocks are still never adopted
  automatically.
- Generated Auditor description metadata changed across all five host adapters
  (OpenCode, Codex, Claude Code, Copilot, Cursor) to describe both modes. Run
  `npx agenticloop update` to regenerate. Auditor read-only enforcement is
  unchanged: OpenCode `permission.edit: deny`, Claude Code `permissionMode: plan`,
  Copilot withholds the `edit` tool, Cursor `readonly: true`, and Codex keeps its
  binding advisory prohibition.
- Blocked Engineer returns are persisted only as unverified observations and
  cannot authorize review, acceptance, integration, or closeout. Successful
  current returns and blocked returns now retain distinct durable dispositions.
- Host-receipted verification replays target-confined execution artifacts and
  verifies their exact packet, invocation, task, carrier, work-unit, repository
  heads, argv, exit outcome, and path authorities. Recomputed digests alone do
  not establish producer or execution provenance.
- Generated role, backend, setup, CLI, and workflow guidance now uses the public
  lifecycle commands and documents the protected-host durability boundary.

### Fixed
- Fixed Windows execution of `npm`, `npx`, and other command shims without
  enabling shell interpretation, while retaining metacharacter refusal and
  repository-declared command confinement.
- Fixed the timeout race that could terminate a parent before a descendant PID
  was recorded, and added bounded startup readiness before runtime timeout
  accounting begins.
- Fixed GNU tar handling of Windows drive-letter paths in the genuine 0.4.0
  packaged-upgrade regression by using target-relative operands under one
  working directory.
- Fixed return-receipt recognition so a correctly re-signed receipt for another
  work unit is rejected explicitly, with one shared packet work-unit derivation
  used by receipt creation, receipt verification, and stored-return validation.
- Fixed closeout and handoff paths to revalidate protected replay state without
  consuming it again, and hardened GitHub refusal fixtures against ambient
  repository state.

### Migration and compatibility
- Run `npx agenticloop update` after upgrading so generated host guidance and
  Auditor metadata are refreshed. User-modified managed blocks remain preserved
  and are reported rather than overwritten.
- Every non-v4 `agenticloop.return-verification` record is a typed incompatibility,
  including released schema v2 and interim schema v3. Retain those records as
  history, but produce a fresh current packet, execution evidence, role return,
  and verification before a protected transition.
- Real protected host integrations must retain execution-receipt replay state
  durably across process restarts. The package provides no in-process fallback
  replay ledger for production use.

## 0.4.0 - 2026-08-10

### Highlights
- **Workflow graph engineering.** Agentic Loop now has one backend-neutral,
  executable transition contract for task evidence, lifecycle claims, role
  authority, ownership, provenance, readiness, audit, and terminal scope. Files
  and GitHub carriers produce the same public diagnostics and safe-repair routes
  for equivalent conditions.
- **Universal activation with honest assurance.** Existing tasks can be
  authorized from an operator-controlled interactive terminal without rewriting
  their bodies or history. Activation and role returns carry separate assurance
  grades, and standard mode never presents operator confirmation or
  session-reported identity as cryptographic host authentication.
- **Guarded dispatch and return.** Role handoffs bind the current task contract,
  activation, repository state, candidate artifact, required checks, role
  capability, and liveness. Returns are independently revalidated before their
  evidence can advance the workflow.
- **Exact-candidate audit and closeout.** Work-unit audit, remediation, plan
  synchronization, improvement references, covered-task membership, and final
  closeout are bound to the exact integrated candidate, with stale or conflicting
  evidence failing closed.
- **Review and parallel-work integrity.** Trusted task-contract correction
  graphs, exact-head review-entry receipts, finding lifecycles, no-progress
  routing, managed joins, and authoritative parallel-scan provenance protect
  branching and rework paths without weakening review independence.

### Breaking changes and migration summary
- Node.js `>=22` is now required.
- `task new` requires either `--scaffold` or a supported host-produced v2
  activation input. `task prepare-decomposition` and `task prepare-dispatch`
  reject unsupported backends instead of falling through.
- Role-preparation packets, degraded-enforcement reports, audit records, and
  closeout packets/markers have new schema versions. Stale transport packets
  should be regenerated; existing task bodies and project history do not need to
  be recreated.
- Canonical role-registry validation is stricter. Custom host agents must live
  outside managed `agenticloop/agents/`; update target configuration, run
  `npx agenticloop update`, and then revalidate.
- `pr-body lint --input` and `init --setup` remain available only as deprecated
  compatibility paths. Prefer the live/snapshot PR-body modes and
  `agenticloop setup` respectively.

The detailed compatibility notes below are normative for migration.

### Added
- **Universal, host-neutral activation.** Agentic Loop no longer requires a host
  integration to authorize work. Every shipped adapter still declares activation
  capture `unsupported` - that is unchanged and permanent - but `unsupported` no
  longer means unusable. One explicit operator command outside the agent session
  authorizes existing tasks:

  ```text
  /agenticloop T-016 T-017                  # in the agent session, as usual
  npx agenticloop activate T-016 T-017      # once, in your own terminal
  ```

  The command prints the exact tasks, carriers, contract digests, repository,
  work unit, and resulting assurance, then requires the operator to type a
  confirmation. It refuses non-interactive invocation and refuses to run under
  CI, and there is deliberately no `--yes`. **Existing tasks and projects do not
  need to be recreated**: ids, bodies, history, decomposition state, and
  repository state are all preserved, and no task record is rewritten.

  Also available: `agenticloop activate --work-unit <id>` (derives child
  bindings from committed Maintainer-attributed decomposition evidence for
  canonical ready-set members only), `agenticloop activation status`,
  `agenticloop activation revoke <grant-id>`, and
  `agenticloop activation provision-key`.
- **Two independent assurance dimensions.** Activation is graded `host_signed`
  or `operator_confirmed`; role returns are graded `host_receipt` or
  `session_reported`. `standard` mode requires at least
  `operator_confirmed`/`session_reported`; `hardened` mode requires
  `host_signed`/`host_receipt`. Both grades, their producer and channel, the
  binding derivation, the effective policy and its source, and the honest
  limitation text travel through dispatch packets, validation results, return
  results, audit gate output, closeout packets, and human-readable output.
  `operator_confirmed` and `session_reported` are never described as
  cryptographically host-authenticated anywhere.
- **Durable activation records.** `agenticloop.activation-grant` (schema
  version 1) and `agenticloop.task-activation-binding` (schema version 1) live
  under `.agenticloop/activations/`, written as one transaction with a versioned
  mutation receipt, so a failed multi-task activation leaves no partial
  authority. A binding pins the exact current task-contract digest, so a
  contract change supersedes it. Both records are signed with an operator key
  held **outside** the repository; a hand-authored record inside the target
  cannot self-authorize however self-consistent its fields and digest are, and
  copying the directory to another checkout carries no authority.
- **Activation policy.** Repository configuration may request a stronger minimum
  through `agenticloop.json` `activation.mode`, but it can never lower the
  external operator pin at
  `~/.agenticloop/operator-activation/<target-sha256>.policy.json`. Hardened
  policy therefore never rests on model-writable repository configuration alone,
  and a malformed pin or request fails closed at hardened.
- **`agenticloop host-trust`** provides bounded provisioning and status for the
  external operator trust store: `status`, `register`, `rotate`, and `revoke`,
  each with `--dry-run`. Registration accepts only a public key. There is
  deliberately no command that signs an activation capture or a return receipt
  with the protected host key.

### Changed
- Fresh separate Auditor returns now use the same effective return-assurance
  policy as ordinary role returns. Standard mode accepts a fully revalidated,
  receipt-free `auditor_report_v1` as `session_reported` with
  `producerAuthenticated: false`; hardened mode still requires the protected
  verifier and `host_receipt`. Same-session audit remains invalid. Audit record
  schema version 3, closeout packet schema version 2, and closeout marker schema
  version 2 carry the observed grade, authentication state, and exact report
  digest through certification and closeout. Version 2 audit records have an
  explicit conservative canonicalization path.
- `audit report --repository-evidence` and `--producer-receipt` help now
  describe the real contract: repository evidence is always refetched and
  revalidated, while a producer receipt is required only when the effective
  policy minimum is `host_receipt`.
- `agenticloop.role-preparation` is schema version 6. A packet now binds exactly
  one activation model - the legacy host-signed capture in `activation`, or the
  new `activationBinding` authenticated envelope containing the complete signed
  grant plus task binding - together
  with a closed `agenticloop.dispatch-assurance` statement. Versions 2 through 5
  are recognized as authentic prior evidence and rejected as
  `dispatch.packet.stale`; regenerate rather than migrating. Version 5 is not
  migrated because it predates the assurance dimensions entirely.
- `task prepare-dispatch` resolves activation in one fixed order: a current
  valid legacy host-signed task capture, then a current valid task activation
  binding, then blocked. An existing activation-bound project behaves exactly as
  before. An unactivated task is refused with the exact
  `npx agenticloop activate <task-id>` command as its first safe repair.
- `task verify-return` accepts a return with no host producer receipt only in
  `standard` mode, grades it `session_reported`, and emits a warning diagnostic
  stating that the producing role identity was **not** host-authenticated. The
  existing `host_receipt` path is unchanged, and hardened policy still refuses a
  receipt-less return.
- Packet v6 independently binds the nullable return adapter. Successful returns
  persist `agenticloop.return-verification` v1 evidence, and closeout derives
  assurance only from observed records, never capability ceilings.
- Revocation uses an externally authoritative repository-specific create-only
  tombstone; deleting target-local ignored state cannot restore a grant.
- Missing evidence fails both closeout modes. Standard mode has an explicit
  interactive `--legacy-unactivated` compatibility waiver for exact old work;
  it makes no activation claim and hardened mode rejects it.
- `agenticloop.dispatch-clean-state` is schema version 3. It adds the
  operator-owned activation state class, so untracked records under
  `.agenticloop/activations/` no longer fail the dispatch clean gate. Like
  scratch state, they remain refused as implementation work at the return
  boundary. `init` and `setup` add `.agenticloop/activations/` to the managed
  `.gitignore` block: these are short-lived, machine-local, externally
  authenticated records, and committing them would add noise without adding
  authority.
- The closeout packet carries an `assurance` block and an `assurance` gate.
  Hardened closeout fails when either dimension is below policy; standard
  closeout may proceed with `operator_confirmed`/`session_reported` and reports
  those grades prominently.
- The generated OpenCode command - and the canonical activation command every
  adapter derives from - now tells the operator the exact
  `npx agenticloop activate ...` command to run outside the agent session, then
  to continue in the same project and session. It remains fail-closed: no
  `$ARGUMENTS`, `$1`, `$2`, shell interpolation, permission prompt, or
  model-authored artifact is ever activation proof.
- `task prepare-dispatch`, `task verify-return`, and closeout no longer fail on
  a target without `agenticloop.json`. An absent file means "no target
  overrides"; a present but unreadable one is still a typed malformed context.

### Added (earlier in this release)
- `prepareAuditorReturnReportForSigning()` gives a protected host the exact
  normalized Auditor report and the exact `auditor-return-report.v1` digest the
  CLI will later derive, without needing a receipt that does not exist yet. The
  CLI normalizes a report before it digests it, so a host that signed the raw
  wire document produced a different identity and its genuine receipt was
  rejected whenever the report carried permitted surrounding whitespace,
  mixed-case severities, string booleans, or uncanonicalized covered tasks. The
  supported sequence is now: prepare, sign the returned digest, insert the
  receipt into the returned normalized report, submit. Normal submission is
  unchanged - a `verified` report still requires a non-empty receipt - and there
  is no dummy-receipt convention.
- The package declares stable subpath exports for the host integration surface:
  `agenticloop/auditor-return-receipt`, `agenticloop/audit-report-schema`,
  `agenticloop/host-trust`, and the package root. Existing
  `agenticloop/src/...` deep imports and shipped data files remain reachable.
- Protected host integrations can import the packaged production Auditor-return
  verifier. Its closed Ed25519 receipt binds the pinned adapter/key, target,
  immutable Auditor role, invocation, work unit, candidate, covered tasks,
  substantive report digest, receipt identity, and strictly positive liveness.
  Loader authorization requires a fresh exact-context nonce challenge signed by
  the pinned adapter key; boolean callbacks and replayed responses are refused,
  and a report claiming `verified`/`host_receipt` still fails closed without an
  authenticated host boundary; standard receipt-free reports use the distinct
  `session_reported` path described above.
- `task prepare-decomposition` and `task prepare-dispatch` now select their
  read-only inventory adapter from the configured backend. GitHub enumeration
  follows the complete injected paginated issue transport and dispatch refetches
  the authoritative inventory, task carrier, trusted history, and readiness
  evidence before accepting scan/decomposition bindings.
- Guarded dispatch/return public commands now bind the complete current task
  carrier and material contract, preserve primary plus independent structured
  diagnostics, and support one canonical command/manual required-check model.
- Host activation-capture schema v2 adds a unique capture ID, signed intended
  task ID, canonical repository binding, and expiry. All five shipped adapters
  now fill shared activation/request slots with stable typed unsupported
  capability declarations.
- Public task handoff commands include `task prepare-dispatch` and
  `task verify-return`; every shipped adapter and every dynamic `supported`
  registry entry remains fail-closed through public and delegated in-process
  APIs. Future support requires authenticated host-controlled IPC, OS isolation,
  or an equivalent external boundary.

- Shared transition contract: one deeply immutable, backend-neutral definition
  now covers evidence, lifecycle claims, typed ownership, terminal scope,
  Markdown, audit-budget availability, provenance, and liveness. Its executable
  definition remains internal to the npm package, while installed targets receive
  the human-readable contract in `agenticloop/AGENTIC_LOOP.md`. Indeterminate
  terminal scope is explicitly blocked with no terminal action until scope
  evidence is repaired and re-derived.
- Workflow role identity: the shared contract now owns a deeply frozen registry
  with lowercase durable `roleId` values, presentation-only default labels, and
  explicit escalation precedence. Compatibility role-ID exports, capability
  routing, config keys, source filenames, and agent frontmatter all derive from
  or validate against that registry without changing adapter behavior.
  Display-bearing projections may carry labels, while the separately exported
  semantic projection mechanically excludes `defaultLabel` from authority and
  digest input so a label-only rename cannot change workflow semantics.
- Audit and closeout integrity: canonical `auditor_report_v1` file/stdin
  ingestion, capability-tiered asserted versus verified invocation provenance,
  global invocation/receipt uniqueness, typed disposition requirements, and
  collision-safe improvement proposal creation. `closeout prepare/status/record`
  now use reconstructable digest packets, explicit four-state marker correction,
  exact candidate drift checks, scratch-only atomic packet output, and trusted
  GitHub marker publication with final-state revalidation.
- Mechanical closeout gates: plan synchronization is enforced with
  `--plan-sync not_required|synced|skipped` plus `--plan-ref`/`--plan-revision`
  binding (an omitted disposition never completes when a source plan applies,
  and a plan edit after certification stales the marker); post-certification
  workflow deltas are content-validated (covered-task `accepted -> closed`
  terminal transitions, append-only schema-valid `task.closed` events in
  applicable event logs, exact valid referenced improvement proposals, and
  transient scratch activity only); and a same-packet files retry whose exact
  digest is already the current marker returns idempotent success without
  rewriting the marker.
- Durable improvement evidence: `improvement new` and `improvement lint`
  resolve every `--source-ref` against live backend state (audit IDs and runs,
  task IDs, decision IDs, closeout marker digests, proposal IDs) and reject
  fabricated references before any file is created; closeout
  `--improvement-ref` must name an existing, lint-valid proposal related to
  the work unit.
- GitHub terminal lifecycle: closeout proves one review-accepted, merged PR
  that closes the correct covered-task issue and lands the certified
  candidate; `github-ready` adds a repository-wide task-identity gate that
  fails closed on duplicate carriers across open and closed issues; and every
  GitHub audit, closeout, and readiness command uses one command-scoped
  issue-inventory snapshot through the production `gh` runner (no test-only
  injection), failing closed with an explicit `inventory_incomplete`
  diagnostic when GitHub cannot be queried.
- Generated host adapters (OpenCode, Codex, Claude Code, Copilot, Cursor) now
  instruct orchestrators to persist the returned `auditor_report_v1` object
  through `agenticloop audit report` without rewriting findings, alongside the
  existing fresh-delegation and no-same-session audit rules.
- Closed-loop PR-body authoring: `pr-body lint --pr <n> --body-file <path>`
  lints a local Markdown draft against live read-only GitHub context (the local
  file replaces only the in-memory candidate body; live task/decision reference
  resolvers are injected; GitHub is never written), and
  `pr-body scaffold --snapshot-output <path>` serializes the complete loaded
  evaluation context as a versioned `agenticloop.pr-body-context` snapshot
  (capture time, repository, PR, issue, head, base, fixed review mode, nested
  preparation input, materialized task/decision inventories) for fully offline
  `pr-body lint --snapshot <path> --body-file <path>`. Body and snapshot
  outputs are written atomically with safe parent creation, and scaffold
  reports the exact next lint command. Lint results add `contextMode`,
  `bodyLintEvaluated`, and `gateEvaluated` (additive, still `schemaVersion: 1`)
  alongside retained `inputComplete`, `lintReady`, `gatePassed`, and
  `publicationReady`; errors, warnings, warning diagnostics, failure
  categories, ownership, and first-repair routing are merged truthfully across
  context, body-lint, and gate phases, and incomplete context can no longer
  masquerade as an evaluated semantic gate. Failure categories remain empty on
  passing warning-only results, every rendered diagnostic has a domain owner,
  legacy output says that live state was not checked, and repair commands
  follow the first safe repair instead of repeating a stale invocation.
  Snapshot provenance is validated strictly, configured nested task-file
  templates are materialized without flattening, and live CLI tests use an
  injectable read-only GitHub command-runner seam.
- Shared preflight diagnostics now always carry a domain `owner`. This is an
  additive JSON-shape change across `github-preflight`, `github-ready`, and
  `github-review-prepare`, with exhaustive owner routing for every canonical
  preflight diagnostic category and a defensive Maintainer fallback for
  externally supplied categories.
- Executable review preparation: one serializable preparation-input
  schema drives offline PR-body lint/scaffolding, live preflight, review
  preparation, and merge readiness under a single completeness policy (every
  category present; explicit `null` distinguished from silent omission). Typed
  proof kinds and satisfaction sources with canonical structured
  per-observation evidence; explicit base-tree path intent, generated-output
  provenance, dependency readiness, and read-only commit-attribution guidance;
  exact-head fail-closed review packets with mechanical stale-head rejection at
  emission and at consumer verification
  (`github-review-prepare --packet <path>`); structured resolution references
  and finding-ID lifecycle; bounded same-author checkpoint repairs through one
  pure shared repair validator; explicit checkpoint states
  (`absent`/`rendered`/`authorizes_revision`/`consumed`/`invalid`); revision
  classification (`implementation_changing`/`record_only`) and distinct
  no-progress dispositions.

### Migration and compatibility
- Workflow-role registry validation is intentionally stricter: targets with
  missing, renamed, or additional `roles` entries, canonical agent files,
  `sourceFile` identities, or agent frontmatter now fail validation. Custom
  host agents must live outside managed `agenticloop/agents/`; migrate
  `agenticloop.json` to extend `./agenticloop/config.json`, remove non-registry
  role and adapter-role settings, run `npx agenticloop update`, and then
  revalidate. See `docs/getting-started.md`.
- `pr-body lint --input <evaluation-input.json>` is deprecated as an ambiguous
  expert compatibility path: it retains its serialized-input semantics for now,
  emits a deprecation diagnostic in human output, `warnings`, and
  `warningDiagnostics`, cannot be combined with `--pr`, `--snapshot`,
  `--body-file`, `--issue`, or `--repo`, and rejects Markdown input with a
  targeted Engineer-owned error pointing at `--body-file`. Use
  `--pr --body-file` (live) or `--snapshot --body-file` (offline) instead;
  removal requires a separately approved breaking release.
- Resolution entries: a `resolved` entry binds the current artifact through its
  structured `[ref: ...]`; a prose-only exact current-artifact citation remains
  valid with a migration diagnostic on both backends, while a present malformed
  or stale structured reference is always an error. Files legacy prose
  citations now match as complete reference tokens, so `branch:feat` no longer
  matches prose containing `branch:feature`. Hex identities compare
  case-insensitively; branch, patch, and local-diff identifiers compare exactly.
- No-progress guard: two consecutive valid implementation-changing
  `needs_revision` outcomes sustaining the same active finding IDs now pause an
  equivalent revision until a bound `no_progress_disposition` is recorded.
  Record-only corrections, stale reviews, accepted outcomes, withdrawn or
  retired findings, and new-only finding sets never trigger it.
- Typed finding-ID baseline: a legacy `needs_revision` review whose findings
  field is missing (accepted only for an old artifact) establishes no IDs; the
  first typed `needs_revision` outcome after it allocates IDs from `F-1`.
- Revision classification defaults: an outcome without a declared
  classification is treated as `implementation_changing`.
- Commit attribution: the local check and live preflight share one canonical
  final-trailer-block parser; a blank separator before the final trailer block
  is not required (matching prior live behavior), standard Git trailers may be
  mixed in, and Task/Agent tokens in prose are never scanned as trailers.
- Evidence: an evidence entry's proof kind is inferred from its own shape, so
  command-shaped evidence can no longer satisfy a manual check, and manual-shaped
  evidence (including legacy command labels that dropped their backticks) cannot
  satisfy a command check. Preserve the declared backtick command in command
  evidence during migration. A stable RC ID survives wording edits only when
  kind, source, exact command identity, and observation contract all match
  (previously a display-text drift produced only a warning). Declared
  observations require structured per-observation records
  (`Observation:`/`Level:`/`Result:`/`Artifact:`/`Source:`); an exact successful
  status check cannot replace them, and a copied
  observation name list no longer satisfies them.
- Files checkpoints, repairs, and no-progress carriers now require exactly
  `Orchestrator: orchestrator`; a wrong trusted role is a repairable malformed
  candidate rather than silently accepted.

### Changed
- **Breaking:** `agenticloop.degraded-enforcement-report` is now schema version
  4 and no longer restates its declaration's `limitation`, `detectionBoundary`,
  and `recoveryRoute`. Those are properties of the capability declaration, not
  of one action binding, and the report already pins the exact declaration by
  digest - so repeating them once per degraded action only enlarged every
  dispatch packet. Rendered warnings are unchanged: the declaration facts are
  resolved from the pinned declaration through the new
  `degradedEnforcementDeclarationFacts()` helper. A canonical schema-v5 dispatch
  packet drops from 15,988 to 12,201 bytes against the 16,384-byte regression
  benchmark. Packets prepared before this change carry version-3 reports and are
  routed to typed regeneration rather than accepted.
- Both task carriers now report identical public text for identical conditions.
  A stale expected digest reports one message, one safe repair, and
  `committedStateEvaluated: true` on files and GitHub alike; a transition to
  `agent-ready` without `--dependencies` reports one message and one required
  context on both. Only the carrier identity in the surrounding envelope
  distinguishes them. Illegal transitions and closeout-owned generic terminal
  refusals now also share the canonical validation-result envelope, diagnostic
  classification, safe repair, and backend-neutral terminal message.
- **Breaking:** `task prepare-decomposition` and `task prepare-dispatch` now
  reject an unsupported `task_backend` at the root, before selecting an
  enumerator or a transport, with a single typed
  `verification.context.malformed` diagnostic. Previously an unrecognized value
  was only warned about and then fell through to the files enumerator or to
  GitHub behavior. Passing `--repo` while `task_backend: files` is configured is
  now a usage error rather than a silently ignored flag.
- **Breaking:** `task new` now requires either `--scaffold` or a supported
  host-produced v2 `--activation-input`. Supported v1 captures are rejected,
  prospective auto IDs are resolved before capture verification, and
  command/manual required checks use stable `[RC-N]` identities.
- A missing derived trust store is safe empty configuration that exposes the
  shipped typed unsupported inventory; malformed existing stores still fail,
  and a well-formed store that declares dynamic `supported` adapters is typed
  negative/blocked unsupported-boundary evidence rather than malformed input.
- The 16,384-byte dispatch packet assertion is a measured regression threshold,
  not an enforced production protocol limit.
- Tightened `parseReviewMarker()` so every `needs_revision` marker requires
  exactly one `AGENT_REVIEW_FINDINGS` field containing unique canonical
  `F-<positive integer>` IDs; accepted markers reject findings. Trusted stale
  GitHub markers that only predate this field remain visible as legacy history,
  while trusted current markers fail closed and untrusted carriers remain inert.
  Legacy outcomes still count for chronological checkpoint authorization and
  review-budget consumption, but never supply required resolution finding IDs.
- Resolution entries, PR head markers, review markers, and fixup headings now
  apply only from live Markdown. Fenced, quoted, and indented examples remain
  inert; malformed live content reports the canonical repair shape without
  weakening current-artifact, authorization, or provenance gates.
- GitHub review-marker and Maintainer Review Fixup state is scoped to the expected
  loop account. Outsider carriers can provide a repair diagnostic for a missing
  current marker but cannot create, invalidate, or alter workflow state.
- Published checkpoint, marker, resolution, PR-evidence, attribution, and audit
  Run examples are executable contract fixtures. The audit Run 1 example now
  requires exactly its eight ordered labeled bullets, and real audit history
  rejects duplicate canonical Run fields instead of silently selecting one.
- `github-preflight --json` now preserves its compatible `errors` and `warnings`
  arrays while adding structured repair diagnostics with stable categories,
  expected shapes or values, and required resolution finding IDs where relevant.
- Centralized workflow budgets: equivalent attempts and review checkpoints default
  to 5, work-unit audits default to 3, and project maps can set
  `default_attempt_budget`, `default_review_budget`, `default_audit_budget`, and
  the existing 5-lane implementation ceiling. Attempt budgets resolve from task,
  project, then built-in policy without rewriting legacy task records.
- New task and audit records materialize their effective project defaults, while
  existing records retain their stored budgets.
- Closeout conditionally synchronizes selected-plan progress before final audit
  freeze, then certifies the resulting exact candidate before publishing complete.

### Fixed
- The protected loader challenge now enforces the expiry it states. The loader
  reads an injectable clock when it issues the challenge and again after the
  host callback returns, and refuses a response that arrives at or after
  `challenge.expiresAt` however well it is signed. Challenge lifetime and
  receipt clock skew are separate named policies
  (`HOST_TRUST_CHALLENGE_TTL_MS` and `AUDITOR_RECEIPT_FUTURE_SKEW_MS`); they were
  previously one unenforced literal.
- `task-body transition` now reports the safe repair for a root-malformed task
  record, which the files carrier already reported and the GitHub carrier
  dropped.
- Dispatch and return hardening corrective pass: the Claude Code production
  planner (init/setup/generate) now fills the canonical activation slots
  through the same single rendering as direct generation, so every shipped
  adapter's production surface declares its typed unsupported capability with
  a concrete requested input and no `$ARGUMENTS`/`$1`/`$2` placeholders; the
  role-return core boundary now authenticates the raw producer receipt itself
  (pinned adapter/key, repository, invocation, packet, return, liveness, and
  evidence digests) and requires a Git reader to rederive files-backend head,
  ancestry, commits, and changed paths instead of trusting caller-authored
  evidence; pre-existing ignored files inside task scope, intended creations,
  or shared workflow state now fail the dispatch clean gate, and scratch
  paths can never be returned as implementation work; `deepFreeze` reaches
  mutable descendants beneath already-frozen parents; one shared Git object
  identity rule accepts full lowercase 40- or 64-character identities across
  dispatch, commit-range, and committed-source checks; a well-formed dynamic
  `supported` host trust registry is now classified as typed negative/blocked
  unsupported-boundary evidence rather than malformed; and `## Required
  Checks` rejects unexpected non-bullet content instead of silently dropping
  it. No shipped adapter provides production supported/verified activation
  capture; the boundary remains fail-closed.
- Required-check policy is now validated before PR-body or status-check
  satisfaction, so malformed kinds/sources, command proofs without exact
  backticked identities, non-command status substitution, and status-only
  observation contracts fail closed as Maintainer-owned task-policy errors.
  ID-less evidence matching ignores recognized typed annotations while
  preserving exact command identity, and ambiguous semantic check labels now
  require distinct `RC-N` ids.
- Review-preparation completion: proof-metadata `[source:value]` and `[source: value]` now
  parse identically (the template-literal whitespace expression is escaped
  correctly, so a leading-`s` value such as `status_check` is no longer
  truncated). Finding IDs are processed numerically within each ordered review
  event, so a severity ordering such as `[F-2, F-1]` is no longer rejected as a
  gap. A `no_progress_disposition` must now bind the exact sustained finding IDs
  plus the required target/reference; a disposition bound to different findings
  cannot authorize another revision. Raw PR comments/reviews are the
  authorization source of truth: a fabricated, stale, or empty supplied
  `reviewHistory` is rejected by canonical content comparison whenever the
  carrier fields are present. `pr-body lint` is structural (sections, exact
  head marker and artifact, required checks, verdicts, observation records,
  resolution entries, final Engineer attribution), and `pr-body scaffold`
  reports `generated`/`lintReady`/`gatePassed` separately instead of implying a
  pass. Files-backend resolution preserves branch/patch casing in rendered
  Markdown, accepts the documented `local-diff` reference, and the legacy
  prose-citation migration applies to both backends. Named files references are
  case-sensitive; only SHA material is case-folded. Legacy manual checks retain
  their compatibility behavior and require an entry-level artifact only after
  explicitly adopting typed `manual` or `contract_proof` evidence. Checkpoint repair
  application is pure (caller events are never mutated), planner and
  application share one repair validator, and the planner never emits a carrier
  application would reject. Review preparation refetches the head immediately
  before emitting a packet. Commit attribution scans only the final contiguous
  Git trailer block and never arbitrary prose.

## 0.3.1 - 2026-07-25

### Added
- Artifact-bound review handoffs for both task backends. Review dispatch captures
  the exact implementation artifact, places it under a mutation lease, and
  rejects stale verdicts when the PR head or files-backed artifact changes.
  Re-review additionally requires a durable resolution matrix that accounts for
  every prior finding against the current candidate.
- Fail-closed Review Round Checkpoints at the task's `review_budget` boundary.
  A checkpoint records the direction, classified cause, current review count,
  exact artifact, targeted finding or durable judgment reference, and
  authenticated orchestrator identity. Missing, stale, malformed, replayed, or
  out-of-order authorization cannot route another revision.
- Safe managed joins for parallel tasks that intentionally make compatible
  changes to the same exact file. Structured `owned_paths`, `shared_mutations`,
  and `integrated_by` metadata distinguish exclusive ownership from
  Maintainer-classified operations such as distinct export or JSON-key
  additions. Validation binds each lane to its immutable artifact diff,
  rejects undeclared writes and unsafe shared targets, and requires a dedicated
  integration task with fresh three-lens review of the combined artifact.
- Strict, declarative CLI parsing (`src/cli-registry.js`). One registry defines
  every command, subcommand, option type, alias, repeatability, enum value,
  positional, and help text, parsed with `node:util.parseArgs` plus an explicit
  kebab-case to camelCase normalization layer. Unknown options, missing values,
  invalid values, and invalid command shapes now fail before any handler runs,
  with close-spelling suggestions for unknown commands and options.
- Safe help and version everywhere. `--help`/`-h` work at the root, command,
  and subcommand level; `agenticloop help <command> [subcommand]` is
  equivalent to `<command> --help`; `--version` and `version` report the
  package version; a bare `agenticloop` invocation shows a short first-use
  screen instead of the full reference dump.
- One injectable CLI execution and I/O contract (`src/cli-io.js`). Every
  command runs in-process through `runCli()` with injected stdin/stdout/
  stderr, cwd, env, prompt factory, AbortSignal, and TTY/CI/color
  capabilities (including `NO_COLOR`), returning numeric exit codes without
  touching global `process.exitCode` or raw console. The legacy subprocess
  bridge (`runLegacySubprocess`, `IN_PROCESS_COMMANDS`, `dispatchLegacy`, and
  the binary's `legacyInProcess` escape hatch) is removed.
- Documented exit statuses: `0` success/safe no-op/help/version/cancellation
  before apply, `1` operational/configuration/validation/apply failure, `2`
  invalid CLI usage, `130` interruption propagated through one AbortSignal
  (in-process cancellation is the cross-platform authority; real-process
  SIGINT coverage is POSIX-gated).
- Trustworthy `init --dry-run` and `setup --dry-run`. Both compute and render
  the exact lifecycle plan with zero writes (no `.gitignore`, guidance,
  config, manifest, state, directory, or generated-shim changes), succeed
  against readable read-only targets, and exit `1` with blockers included
  when the plan is blocked. `--dry-run --json` is non-interactive, requires an
  existing confirmed profile or explicit values for every human-controlled
  decision, and emits exactly one versioned JSON plan document on stdout
  (`schemaVersion: 1`) with diagnostics on stderr.
- Lifecycle plan/apply architecture. A generic filesystem mutation kernel
  (`src/fs-mutation-kernel.js`) extracted from the generation transaction
  owns target-bound path validation, atomic writes, snapshots, rollback with
  explicit rollback-error reporting, and transaction-created empty-directory
  cleanup. The versioned lifecycle plan schema (`src/lifecycle-plan.js`,
  `LIFECYCLE_PLAN_SCHEMA_VERSION = 1`) validates plans before render or apply
  and rejects unknown versions, fields, and action kinds. Pure, no-write init
  and setup planners (`src/init-plan.js`, `src/setup-plan.js`) compose
  normalized create/update/merge/remove/skip/blocked actions, preflight the
  whole plan before the first write, and fail safely when target state
  changes between plan and apply.
- Repair-aware guided setup (Detect, Review, Choose, Plan, Apply, Verify).
  Setup always composes the idempotent init plan, including when a current
  layout manifest exists, so empty, current, legacy, partial, and
  inverse-partial targets use one path; nothing is written before the final
  apply confirmation; default output is a concise summary with per-path
  detail behind `--verbose`; "Files only" and "Skip adapter setup" are merged
  into one explicit "No host integration" choice; invalid choices reprompt
  with the valid input explained; running setup twice produces zero
  second-run mutations.
- `docs/cli-reference.md`: the shipped CLI contract covering the command
  hierarchy, setup versus init, interactive and non-interactive behavior,
  dry-run and JSON plans, stdout/stderr rules, exit statuses, capability
  behavior, and compatibility aliases/deprecations. It is included in the
  published package and asserted in a real `npm pack` archive test.

### Changed
- Parallel scheduling no longer treats every shared writable file as an
  automatic serial-only collision. Pairwise classification now distinguishes
  `disjoint`, `managed_join`, `blocked`, and `unknown`; knowledge independence
  remains mandatory, and uncertainty, lockfiles, migrations, generated files,
  globs, overlapping JSON keys, or unaccounted mutations still fail closed.
- GitHub cleanup for managed lanes is merge-strategy independent: it validates
  the recorded integration task and exact join PR head identity before removing
  a closed lane worktree. Files-backed task lint now performs the same
  artifact-bound ownership checks as full validation.
- **Compatibility: strict parsing.** Unknown options now exit `2` instead of
  being warned about and ignored. Accidental Boolean-value forms such as
  `--dry-run foo` or `--json foo` no longer assign the token as the flag
  value; the token is now rejected as an unexpected operand. Command-local
  `-h` now prints help instead of being treated as a positional.
- **Compatibility: positional operands are enforced.** Commands without
  declared positionals (for example `init unexpected`, `setup unexpected`,
  `update unexpected`, `validate unexpected`, `doctor unexpected`,
  `status unexpected`, `generate opencode unexpected`, or
  `remove --yes .agenticloop`) now exit `2` before any handler or mutation
  runs; required positionals must be present and excess operands are
  rejected. `--` still terminates option parsing, but the resulting operands
  must satisfy the declared shape.
- **Transaction semantics are explicit: per-segment, fail-stop, and
  rerun-repairable — not globally atomic.** Lifecycle apply preflights the
  complete plan before the first mutation, including both source and
  destination fingerprints for legacy renames. Built-in segments are atomic:
  a failed segment restores its own pre-state, file bytes exactly, and removes
  only transaction-created directories. Execution stops at the first failed
  segment, and previously committed segments are kept. Partial application is
  reported with the committed segments, the failed segment, primary errors,
  and rollback errors; an executor that cannot confirm rollback is reported
  explicitly instead of being described as rolled back. Rerunning
  `agenticloop setup` or `agenticloop init` repairs a consistent partial state
  (a clean rerun plans zero mutations).
- Init's `AGENTS.md` activation-guidance mutation is now part of the
  lifecycle plan instead of a post-init side effect: `init --dry-run --json`
  includes the guidance action, dry-run and normal init see the same plan,
  and `--no-agents-guidance` / `--agents-guidance off` exclude it.
- Relative `--target` values resolve against the CLI working directory
  through one shared `resolveCliTarget` helper across every public command;
  no command resolves targets through ambient global state.
- The filesystem mutation kernel accepts only target-relative mutation paths
  resolved through one canonical validator that rejects absolute,
  drive-qualified, backslash, NUL, dot-segment, traversal, empty-segment, and
  symlink/junction-escape paths; snapshots are explicitly absent/file-bytes/
  directory; directory snapshots are never written; direct directory-removal
  mutations are rejected. Pruning enumerates owned files and uses explicit
  non-recursive `rmdir-empty` mutations for stale empty directories; those
  directories are recreated if a later mutation in the segment fails.
  Primary errors are reported separately from genuine rollback failures.
- **Compatibility: exit statuses.** Invalid command-line usage exits `2`
  instead of `1` (operational failures remain `1`; scripts treating any
  nonzero status as failure are unaffected).
- `agenticloop setup` is the canonical first-use command across the README,
  Getting Started, workflow examples, downstream adoption guidance, the
  setup skill, setup-state/doctor next steps, adapter-discovery hints, and
  completion hints. `agenticloop setup --non-interactive` is the preferred
  non-interactive spelling; `setup --yes` remains its compatibility alias
  (`--yes` keeps its different, confirmation-oriented meaning on commands
  such as `remove`; convergence is deferred to a later compatibility phase).
  Neither spelling confirms a missing human-controlled project profile.
- `init --setup` is deprecated with a migration hint to
  `agenticloop setup --adapter <host>`; its behavior is unchanged during the
  deprecation window. Direct `init --adapter <host>` remains supported for
  all five adapters as the advanced/manual path.
- Init and setup default output is concise (step and mutation summaries, not
  every path); individual paths require `--verbose`.
- Removed the unused `src/adapter-output-plan.js`; adapter preflight and
  transactions remain in `src/generation-transaction.js`, now layered over
  the generic mutation kernel.

## 0.3.0 - 2026-07-24

### Added
- Work-unit audit and certification. A fourth canonical workflow role, Auditor,
  evaluates completed multi-task work units as a whole from six perspectives
  (outcome, completeness, integration, engineering quality, verification, risk)
  and produces one consolidated findings-and-recommendations report.
  Non-certifying findings route through normal Maintainer/Engineer remediation;
  re-audit uses a fresh Auditor invocation bound to the exact renewed artifact.
  An independent `audit_budget` (default 5) bounds the loop; after five completed
  non-certifying reports the work unit blocks for human direction.
- Audit records live in `.agenticloop/audits/` with append-only report history,
  stable `AUD-NNN` identities, exact-artifact binding, and dedicated validation
  (`src/audit-record.js`). Certification is current only when the certified
  artifact and covered task set match the candidate exactly.
- `work_unit_audit` project setting defaults to `enabled` (including when
  omitted); only an explicit human-controlled `disabled` value bypasses the
  closeout certification gate. Configured closeout cannot publish
  `AGENT_CLOSEOUT_STATUS: complete` without current certification.
- `agenticloop audit` CLI with `create`, `status`, `report`, and `certify`
  subcommands. Auditor model and reasoning effort use the existing adapter
  `roleSettings.auditor` configuration.
- All five host adapters (OpenCode, Claude Code, Codex, Copilot, Cursor) and
  their generated surfaces include full Auditor role support.
- New tests: audit-record validation, audit CLI, adapter lifecycle, end-to-end
  audit scenarios, and event-logging compatibility.

### Changed
- Refreshed the project positioning and normalized prose typography across the
  public and canonical Markdown documentation.

## 0.2.0 - 2026-07-23

### Added
- Project posture, parallel-scan, and review controls. Confirmed
  project maps now require one human-confirmed `development_stage` (`greenfield`,
  `expansion`, `stabilization`, or `maintenance`); existing confirmed projects
  without it must run interactive `agenticloop setup` once before validation and
  normal task work can continue. Setup proposals remain advisory, conflicts
  require an explicit human selection, and later transitions require another
  confirmation. `max_parallel_implementation_lanes` now defaults to `5` as an
  implementation-only ceiling, every multi-task work unit receives a current
  Parallel Opportunity Scan, and maintainer review uses three ordered lenses
  with one shared Lens 2/Lens 3 fixup budget. Existing projects without the lane
  field inherit `5`; the safety scan remains the binding constraint.
- Hardened Maintainer Review Fixup follow-up enforcement: GitHub review audit now
  checks same-task replacement PR history before allowing a fixup, files/event
  cross-checks ignore malformed fixup flags, and non-maintainer review results are
  reported separately without creating false unbacked-maintainer-review gaps.
- Delegation and review provenance clarification. `single_agent_fallback` now has
  two clearly separated meanings: a `delegation_mode: single_agent_fallback` means
  real role delegation was unavailable or a concrete attempt failed (and requires
  a structured `fallback_cause` of `mechanism_absent` or `invocation_failed` plus a
  reason), while a `review_mode: single_agent_fallback` means the review happened
  in the acting session and is not independent. A new review round – for example
  "re-review round 2" – is never a fallback cause; orchestrator-routed re-review
  rounds re-run delegation routing and use real host delegation when available. A
  human who directly continues an already-active maintainer session emits no new
  `role.invoked`, records a `continuation_reason` on the review telemetry, uses
  `review_mode: single_agent_fallback`, and cannot accept an independent-review
  task that way. The canonical policy lives in `skills/role-delegation/SKILL.md`
  and `AGENTIC_LOOP.md`; no new event type, review mode, GitHub marker, frontmatter
  field, or task-record knob was added.
- Delegation Prompt Shape now carries an explicit `Delegation mode` line
  (`host_subagent | explicit_agent_invocation | single_agent_fallback`), plus
  `Fallback cause` and `Fallback reason` lines required only for
  `single_agent_fallback`. The receiving role uses the supplied mode when it
  records review provenance; `Operating facts` remains required for real
  delegation but never substitutes for the explicit mode.
- Strict producer validation for newly written events. `role.invoked` writes now
  require a top-level `orchestrator` role, a `maintainer`/`engineer` `target_role`,
  a canonical `delegation_mode`, a boolean `fallback`, and – for
  `single_agent_fallback` – `fallback: true`, a structured `fallback_cause`, and a
  non-empty `reason`; non-fallback modes must record `fallback: false` and no
  fallback cause; maintainer self-invocation is rejected. `review.result` writes
  now require a valid `review_mode` and a `review_round`, validate an optional
  `continuation_reason` and `maintainer_fixup` flag, and only allow
  `maintainer_fixup: true` on a maintainer result with
  `review_mode: single_agent_fallback`. Both the CLI write path and direct
  `appendEventLog` callers pass this producer gate, so invalid new events fail
  before append. Historical schema-version-1 logs remain readable and are never
  retroactively rejected.
- Telemetry-quality provenance reporting. `event-logging report` (per task and
  aggregate) now counts and lists tasks for incomplete or inconsistent
  `role.invoked` (missing `target_role`, `delegation_mode`, or boolean `fallback`
  under strict `typeof` semantics, so string values like `"true"` are reported as
  historical gaps; fallback mode without a structured cause; mode/fallback
  mismatch; non-orchestrator emitter; self-invocation), `review.result` missing
  `review_mode`, and review rounds without backing. Review-round backing is
  computed per review through ordered correlation – each `review.result` must be
  preceded by an unconsumed maintainer `role.invoked` for that review step (with
  `review_round` matching when both carry it) or carry a `continuation_reason`;
  aggregate subtraction is no longer used, so an unrelated or earlier-round
  maintainer invocation cannot mask an unbacked round. `report --features` now
  reports `maintainer_fixup: true` events as event counts (deduplication is not
  assumed), tasks with a fixup event, and tasks with more than one event as a
  multiple-episode anomaly. Historical incomplete events are labeled, never
  inferred or backfilled.
- Maintainer Review Fixup observability. The durable `## Maintainer Review Fixup`
  subsection now uses a standardized field shape (Finding, Eligibility decision,
  Base artifact, Correction, Affected files, Planned verification, Verification
  result, Resulting artifact) parsed deterministically while ignoring fenced or
  non-live Markdown examples. One shared episode validator backs both surfaces:
  all eight fields are required and non-empty, both verification fields are
  required, duplicate field labels are rejected rather than silently merged, and
  base/resulting artifacts must differ. Files-backed validation enforces at most
  one episode, `independent_review_required` not true, final
  `review_mode: single_agent_fallback`, a reviewed artifact matching the
  resulting artifact, and a non-empty final `## Evidence` section that references
  the resulting artifact (`## Scope Completed` alone is not evidence). The GitHub
  review audit shape-validates every live episode with full-40-character-SHA
  artifacts (bare or `commit:`/`sha:` prefixed), enforces at most one episode
  across PR history, and distinguishes current-head from historical episodes:
  only an episode whose resulting artifact equals the exact current PR head
  forces `AGENT_REVIEW_MODE: single_agent_fallback` and verified maintainer
  commit attribution in the base-to-resulting fixup range (`Task:` must identify
  the canonical task when the issue declares one; unrelated commits never
  satisfy attribution; missing or malformed commit data fails closed), while a
  superseded historical episode still counts toward the one-episode limit but
  does not force a later genuinely delegated `host_subagent` re-review into
  fallback mode. When event logging is enabled, `agenticloop validate`
  cross-checks the durable subsection against `maintainer_fixup: true` review
  events and reports historical mismatches and multiple-episode anomalies as
  warnings. Every `needs_revision` review now carries one concise
  `Maintainer Review Fixup: ineligible -- <reason>` (or `applied -- <finding>`)
  verdict line.
- Maintainer Review Fixup: a bounded Lens 2 review exception that lets a
  reviewing maintainer correct one fully understood quality finding on the
  artifact under review, refresh final-state evidence, re-review, and accept
  without an engineer revision handoff. Lens 1 must already be clean; the bound is
  one fully understood finding and one coherent edit packet, not a line count. A
  successful fixup stays inside the current review round and does not consume a
  `needs_revision` round; any expanded, uncertain, or failed finding routes back
  to the engineer. It fails closed for independent-review tasks and cannot repair
  summary, evidence, linkage, or acceptance work that was already missing at the
  engineer handoff. Self-accepted fixups use the existing
  `review_mode: single_agent_fallback` (truthful because the maintainer authored
  part of the exact accepted artifact) with disclosure through a durable
  `## Maintainer Review Fixup` review subsection and `Task:`/`Agent: maintainer`
  commit trailers – no new review mode, marker, frontmatter field, or task-record
  knob. Merge, integration, issue closure, closeout, and cleanup gates are
  unchanged. `skills/review-and-accept/SKILL.md` owns the procedure; the
  methodology, roles, delegation, and backend docs reference or project it.

- `github-ready` composite pre-merge gate: `npx agenticloop github-ready --pr
  <number> [--issue <number>] [--repo <owner/name>] [--json]` runs the evidence
  preflight and the review audit together and returns one merge-readiness
  verdict, so the orchestrator has a single read-only command to run before
  merging a GitHub-backed implementation PR. It reuses the existing functions
  in-process, never mutates GitHub, requires both checks to pass, and fails
  closed when they disagree on the PR head or linked issue. The original
  `github-preflight` and `github-review-audit` commands remain available.
- Independent-review requirement now reads canonical YAML frontmatter
  `independent_review_required: true|false` from the linked GitHub task issue, in
  addition to the compatibility `AGENT_INDEPENDENT_REVIEW_REQUIRED: true` marker.
  Both share the files-backend boolean parser. Conflicting representations, a
  malformed YAML value, or malformed/duplicate markers fail closed. Quoted or
  example markers inside fenced code, blockquotes, or indented code stay ignored.
- Orchestrator model guidance: a provider-neutral note in `docs/host-adapters.md`
  recommends an orchestration model reliable at multi-step instruction following,
  state tracking, tool routing, and stop-condition enforcement, without naming or
  ranking specific models.
- Activation boundary and standalone engineer: `AGENTIC_LOOP.md` now states that
  installing, discovering, or reading the methodology does not activate it – full
  operation requires explicit activation. The canonical `engineer` role is
  restructured into two modes (standalone and Agentic Loop); the main agent may
  invoke the generated engineer as an ordinary bounded subagent with no task ID,
  task record, or Agentic Loop bookkeeping. Generated engineer surfaces for all
  five hosts and the Codex public skill body carry the same boundary.
- Repository-rules activation guidance: `init`/`setup` install one clearly
  marked, manifest-owned, removable guidance block into the resolved
  repository-rules document (`AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, created as
  `AGENTS.md` when absent). New `agenticloop guidance apply|check|remove`
  commands and an `--no-agents-guidance` install flag. Everything outside the
  markers stays target-owned; modified owned blocks and unowned manual blocks are
  preserved, not overwritten or adopted; `update` never enrolls an existing
   installation that has no owned block. The ownership manifest gains schema
   version 4 with a host-neutral `core` owner and a `marker-block` entry kind
   (v3 manifests migrate automatically; existing adapter entries are unchanged).
   Marker-block entries record generated separators so apply/remove restores an
   existing rules document byte-for-byte; forced removal removes only the edited
   marker region and never truncates surrounding target-owned content. Configured
   rules paths are used consistently by lifecycle and guidance commands; path
   drift is reported and never silently creates a duplicate block.

- Regression coverage for review markers posted in PR review bodies (GraphQL `reviews`)
  and for language-tagged Markdown fences.
- Tool-neutral bounded implementation discovery: `AGENTIC_LOOP.md` Context Read Discipline now
  distinguishes the closed normative context set, permitted task-scoped discovery
  (available indexing or language-aware symbol/reference/caller/test lookup within a default bound of one pass and
  at most six previously unnamed paths/symbols), and still-prohibited arbitrary
  repository loading. Excess or contract-changing discovery routes to `needs_context`.
- Artifact-bound review provenance: `review_mode` (`host_subagent`, `explicit_agent_invocation`,
  `single_agent_fallback`, `independent_human`) plus `independent_review_required`
  `reviewed_artifact`, and `human_review_ref` task fields, enforced by
  `agenticloop validate`, `task lint`, and the `task status` acceptance gate.
  GitHub markers bind to the PR head and `github-review-audit` rejects stale or
  malformed provenance. Same-session fallback remains legal unless independent
  review is required.
- `github-review-audit --expect-status <accepted|needs_revision>` separates
  provenance validity from acceptance readiness. Default audit fails for
  `needs_revision` outcomes; use `--expect-status needs_revision` for revision
  audits. Result JSON includes `provenanceValid`, `acceptanceReady`, and
  `expectedStatus` fields.
- Marker author verification: the audit matches the marker author's GitHub
  identity against the authenticated loop account. Trailer-only spoofing fails.
- Strengthened independent-human verification: `independent_human` mode now
  requires an approved GitHub review on the current PR head by a different human
  account. Missing author type fails conservatively.
- Strict issue binding: `github-review-audit` requires the selected issue to be
  one of the PR's closing references. `--issue` cannot point to an unrelated
  issue.
- Quoted/example marker filtering: markers inside fenced code blocks,
  blockquotes, and indented code are ignored during parsing.
- Files provenance reverse consistency: `review_mode`, `reviewed_artifact`, and
  `human_review_ref` cannot be set without `review_status`; `human_review_ref`
  requires `independent_human` mode.
- REST review fetch and normalization for `independent_human` GitHub audits: the audit
  fetches live reviews from `GET /repos/{owner}/{repo}/pulls/{pr}/reviews`, flattens
  paginated pages, and normalizes records into a stable internal shape with URL/ID,
  state, commit binding, and author identity.
- Outcome-sensitive human review state: `independent_human` accepted audits require an
  `APPROVED` current-head review; `needs_revision` audits require a `CHANGES_REQUESTED`
  current-head review.
- Markdown-consistent fence parsing for quoted-marker filtering: closing fences must use
  the same character and be at least as long as the opening fence; four-space-indented
  fences are treated as indented code.
- Canonical `event-logging` skill owning command resolution (including the
  one-time CLI-help fallback), the disabled/non-blocking rules, and event data
  conventions.
- Warn-only validation for unknown `roles.<role>` configuration keys (loading
  stays permissive; may become errors in a future major version).
- Generated adapter payload-size regression protection for every supported adapter
  (`test/adapter-payload-size.test.js`). It measures generated artifacts, not exact
  active model prompt context.
- Contract-ownership regression test (`test/contract-ownership.test.js`) pinning
  single-owner invariants for the event-logging recipe, the delegation status
  template, and the bounded-discovery rule.
- Generated-artifact ownership manifest (`.agenticloop/generated-artifacts.json`).
- Collision-safe adapter generation preflight (`src/adapter-output-plan.js`).
- Task lifecycle transition enforcement (draft cannot jump to accepted/closed).
- Acceptance gate requiring `review_status: accepted`, `implementation_artifact`, `## Scope Completed`, and `## Evidence` before accept/close.
- Markdown link validator (integrated into `agenticloop validate`).
- Manifest recording after each adapter generation.
- Contract tests for supported adapter status.

### Changed
- Startup guidance: the orchestrator confirms `npx agenticloop validate` reports
  no errors before implementation begins; warnings are triaged but only errors
  block startup, and validation is not rerun every task unless config or toolkit
  assets change.
- Closeout guidance: for a GitHub-backed group, the maintainer verifies every
  included PR was accepted (via `github-ready`) before publishing the closeout
  marker; missing acceptance or a current `needs_revision` blocks
  `AGENT_CLOSEOUT_STATUS: complete`. Missing historical events are never
  fabricated.
- The removed `.agenticloop/project.md` legacy fields (`summary_template` and
  peers) now produce an actionable validation error saying the field should be
  removed and that task summaries live inline in the task record.
- Direct callers of `evaluateGitHubReviewAudit` must pass normalized REST human reviews
  through the `humanReviews` parameter; `prData.reviews` is no longer used as human-review
  evidence.
- Event-logging command-resolution boilerplate is deduplicated from roles, skills,
  the methodology, and backends into the canonical `event-logging` skill; they now
  reference it via `[[event-logging]]`.
- The delegation status template now has a single owner (`role-delegation`); the
  verbatim copy was removed from `agents/orchestrator.md`.
- Accepted/closed files-backed tasks now require `review_status: accepted` plus a
  valid `review_mode`; the acceptance gate blocks `single_agent_fallback` when
  `independent_review_required: true`.
- **Breaking:** `draft` tasks must now go through `agent-ready` before `in-progress`.
- Codex marketplace writes now fail closed on malformed JSON instead of silently replacing it.
- Codex legacy skill removal now requires a strong marker or exact generated structure; name-only heuristics removed.
- Claude agent removal now scans all `.claude/agents/*.md` files for the generated marker (supports custom roleBindings filenames).
- Claude settings permissions are now reversibly reconciled during removal.
- `plugins/agenticloop` removal now checks for unknown content before deleting.
- Dry-run removal now reports the same planned file actions as real removal.
- `removeAgenticLoopMarketplaceEntry` preserves malformed marketplace JSON byte-for-byte.
- Independent-human verification now requires an explicit GitHub `User` author type; unknown
  types, missing type, and logins ending in `[bot]` fail conservatively.
- The maintainer attribution trailer is now checked against the same filtered live body
  used for marker parsing, so fenced/quoted/blockquoted trailers cannot satisfy attribution.

### Fixed
- `github-review-audit` now discovers review markers from both PR issue comments and PR review bodies.
- GraphQL PR review bodies are kept separate from normalized REST human-review evidence;
  `evaluateGitHubReviewAudit` accepts a dedicated `humanReviews` input and `prData.reviews`
  is reserved for GraphQL marker sources.
- `gh pr view --json` now requests the `reviews` field so PR review bodies are available
  for marker discovery.
- Language-tagged Markdown fences (` ```text `, ` ```json `, `~~~text`, and similar) are now
  recognized and their contents are filtered from live marker parsing.
- Fence indentation now accepts only zero to three literal ASCII spaces; tabs and
  Unicode whitespace cannot be misclassified as opening or closing delimiters.
- Active Phases now lists partial/deferred/approved-only work; Completed only lists finished work.
- `docs/codex-setup.md` smoke protocol is now explicitly optional/advisory.
- Remaining "live delegation tests still pending" moved to Active Phases.

### Removed
- Unused config role fields: `responsibilities`, `canEditImplementationFiles`, `canEditDocs`.
- Broken installed `AGENTIC_LOOP.md` link to `docs/workflow-examples.md`.

## 0.1.0 - 2026-06-24

### Added
- Initial public release.
