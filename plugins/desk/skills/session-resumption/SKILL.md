---
name: session-resumption
description: Checkpoint and resume an authorized non-terminal task, including a fresh-process handover after interruption, verified resource exhaustion or runtime pressure. Preserve actual source, unfinished work, work identity and authority; admit a replacement writer only after the prior owner is released. Also owns where private or sensitive operational evidence (raw transcripts, credentials, private measurement, customer data) is kept.
---

# Session resumption

Desk owns checkpoint and recovery admission here. Reconcile the canonical task, current authority, actual source, writer ownership and uncertain effects before entering `desk:using-superpowers-with-desk` at `reconciled-resume`. Consume the existing approval and explicit artifact map; do not start another lifecycle or repeat go-ahead.

at the desk again. the operator picked an active task to resume — a manilla envelope already part-filled, papers laid out where the last session left them. pick up where things were, don't start over.

## Protected evidence

Operational evidence that is private or sensitive (raw transcripts, credentials, private measurement, customer data) stays outside Git, in an approved private evidence location. The desk and every other repository record only pointers and derived, non-sensitive summaries. This holds for all work, not only checkpoints, and no host memory, plan or task store is a substitute location.

## Checkpoint before handoff

Keep the same work-item identity, canonical task and work-ledger identity. Consume the mapped `progressPath` and `rulingsPath` from the recorded artifact map: explicit provider progress is authoritative, not a universal `doing.md`. The existing mapper's `--progress-path` selects that task-local record; only when omitted does it select the existing `doing.md`, then `task.md`. Rulings stay derived from the same progress record, never a second store. Preserve the map's task/person scope, including resolved symlinks, and its design/plan and private evidence pointers. Reuse the recorded step/attempt for reading; allocate a new attempt for new output and preserve all earlier attempts and findings. Do not rename legacy files, invent progress paths or create a competing `.superpowers/sdd` tree.

A checkpoint is a resumable state of the existing work, not another task, progress database or approval round. Keep approved summaries and references in the mapped progress record (which may be the task card); put protected payloads and the manifest at the already-approved private evidence location:

- Current outcome, explicit authority, delivery endpoint, next concrete action, outstanding findings and responsible owner.
- The exact repository roots and revisions, branch and remote publication state; distinguish current source from the source each retained result actually exercised.
- Task-owned uncommitted changes and untracked files, plus local-only commits. Commit and publish through the approved contribution path when ready; otherwise preserve a binary patch, necessary untracked payload and prerequisite-bound bundle in the approved protected evidence location. Do not sweep unrelated work, ignored credentials or private stores into a source archive.
- Evidence locations, hashes and read-back of the preserved payload, including bundle prerequisites. Publish a ready checkpoint only after its referenced files are complete and readable; a missing or partially written archive cannot count as saved work.
- Pending external side effects, their existing request or operation identities, what was observed, and what remains uncertain. Preserve failed and interrupted attempts; never infer success from a submitted request.
- The actual host/process generation, remaining delegated writers and the host-owned recovery entry point, with its availability limits. Keep delivery and exact owned resources/dispositions in the mapped progress record under `## Delivery` and `## Resources`, using the single [task-lifecycle table definition](../task-lifecycle/SKILL.md#delivery-and-resource-accounting).

A protected handoff manifest binds these references to one checkpoint generation: canonical task/iteration and work-ledger identity, explicit mapped artifacts, exact source and unfinished-file hashes, step/attempt history, findings, active writers, unresolved operations and the next expected step with its responsible owner. Reuse existing ledger links under `desk:work-measurement-ledger`; recording-off or unavailable accounting remains explicitly unavailable, never a fabricated identity or new collection consent. It is an admission artifact for the existing records, not a second task database. Check storage before capture, persist and read back every referenced payload, then atomically publish the complete generation as ready using a staging file and rename within the protected location. Retain the previous complete generation; a torn successor cannot replace it.

Determine freshness by reconciling current authority, actual source/publication and writer ownership against that generation, not by a recent timestamp alone. Before using a previous complete generation, preserve and reconcile intervening committed and unfinished source. Missing or corrupt latest evidence is never permission to overwrite newer work or silently treat a partial snapshot as ready.

If a torn or incomplete latest checkpoint exists, use the previous complete generation only after preserving current source and reconciling authority: preserve newer committed and uncommitted source bytes, including untracked files, before any recovery action; never reset to a snapshot or silently replay. A readable old generation alone does not establish readiness. If newer bytes or the required payload cannot be preserved and reconciled, admission remains non-ready.

Protected payloads follow "Protected evidence" above. A same-host protected copy is not an off-host backup; state which durability boundary was actually achieved. Do not delete the originals merely because an archive exists.

## Fresh-process recovery

Read the current task and ready checkpoint generation before starting any replacement writer. Revalidate the recorded authority, source, result and publication claims against current state. A cached session label or PID alone is not ownership: the host must establish the exact prior process generation and its owned descendants, including delegated agents, MCP/command children and keep-awake processes, and confirm that the entire writer tree is released. A root PID's exit is not writer release: a surviving delegated writer leaves the replacement non-ready, with no second writer on that worktree. An unobservable or unresolved remote writer is not a released writer. If release cannot be established, do not start a competing writer. Host cleanup uses exact resource ownership and absence evidence through `desk:git-hygiene`, never process-name patterns.

Start a fresh process with a bounded handoff from the canonical record; do not replay the exhausted transcript or restore its entire conversation as a substitute for state reconciliation. Keep the work item, commitments and accounting continuous while allowing a new runtime/session identity. Read a specific retained transcript segment only when a missing fact requires it, bounded by the relevant owner and event range.

Inspect actual committed and unfinished source without overwriting it, then reconcile pending external side effects using source-system readback bound to the recorded operation identity or the destination's existing idempotency mechanism before retrying. Classify each effect as confirmed applied, confirmed absent or unknown; unknown outcomes remain unresolved, never inferred absent from a timeout. Retry only with confirmed absence and a safe authorized retry, or the destination's verified duplicate-suppression semantics; never blind replay or transcript replay. An uncertain delivery is not permission to resend, and unresolved conflicting effects leave that workload non-ready. Refresh a stale checkpoint from reachable source and evidence before admission. Treat missing, corrupt, stale or foreign-owned recovery evidence, invalid process identity, active writers and insufficient storage as explicit non-ready states rather than success-shaped fallbacks.

Process monitoring and restart belong outside the worker process to the owning host. Use its maintained launch/recovery capability without changing authentication, source selection, permissions or default profiles. An in-session reminder, restored terminal label, live MCP server or successful process launch does not prove the worker resumed. If the required host capability is unavailable, report that specific gap and continue independent safe work rather than inventing a scheduler or claiming unattended recovery.

## Bounded execution and recovery

Verified resource exhaustion is not a phantom limit. A process handoff continues the existing mandate; it is not permission to return control, shrink the outcome or keep an exhausted runtime alive. At a safe integration boundary, or when the host reports persistent memory pressure with failed compaction, preserve source and unfinished work here and use the authorized host's fresh-process recovery path; the project and its work-item identity outlive the process.

Checkpoint at completed integration and delegation boundaries and before an unattended batch. Keep one implementation writer per worktree, close completed assignments, and return bounded findings plus artifact pointers rather than repeatedly copying whole histories or command output. The approved outcome continues across process handovers; no new go or lifecycle is created.

Treat a host-observed persistent memory-pressure signal followed by compaction failure as a handover condition: stop starting new work, preserve the current recoverable source/evidence and use the authorized host recovery path. Do not keep retrying failed emergency compaction indefinitely. Context-token usage is not JavaScript heap usage, and more physical memory does not establish a healthy process.

The guard and restart capability must live outside the worker process. Desk owns checkpoint and recovery admission; the host owns process generations, descendant cleanup and the actual launch. A replacement must consume the current Desk record, establish sole-writer ownership, reconcile uncertain side effects and keep the original work identity. T16 owns host lifecycle implementation; this policy does not implement a watchdog or restart service. Do not put a second scheduler, task ledger or implementation loop into this skill or the tiny entry adapter.

The host protocol declares armed and disarmed intent, finite pressure-persistence/checkpoint/handover/acknowledgement limits, and a persisted ceiling on consecutive recoveries without verified durable progress. A launch, heartbeat or self-reported success cannot reset that counter. Explicitly disarm before an intentional stop, pause or completion; recovery must not resurrect stopped work. For non-ready recovery, do not launch or continue the protected workload, report the exact reason and never substitute reduced-capability execution. Independent safe work can continue under the original mandate.

Record the actual fresh-history executable/argv, admitted source/profile and identity in the host receipt without copying credentials or changing permissions. Require a work-item-bound acknowledgement and read-back of the next expected work step before declaring recovery successful; starting a process or delivering a prompt is not that acknowledgement.

Before claiming unattended recovery, exercise two consecutive actual interruption and recovery cycles on the declared consuming host. Confirm preserved partial work and original identity, no competing writers or duplicate external effects, resumed work through the selected source, and ordinary rollback. Retain both attempts and their source/host boundaries. Source instructions, a synthetic process fixture or a successful launch alone are not that proof.

The two cycles include graceful handover and abrupt mid-batch interruption, with actual uncommitted source and an externally visible operation whose response is uncertain. Record the operation identity or idempotency key before issue; use destination read-back instead of blind replay. Prove refusal of a surviving delegated writer, intentional-stop/disarm behavior, the exhausted recovery budget and an incomplete latest checkpoint. Each replacement must perform the next expected work step; two idle restarts cannot satisfy the requirement.

## Step 1 — Read the task card

```
$DESK/<track>/<task>/task.md
```

note: `status`, `planning_complete` (if set), `repos[]`, any `collaborating`/`blocked` reason fields. the card is the memory of what was happening; read it before reaching for anything else.

## Step 2 — Check repo workspaces

For each `mode: local` repo, inspect `git status`, the current branch, local-only commits and the recorded publication ref through `git-hygiene`. Compare with the mapped progress record and protected checkpoint, not an assumed `doing.md` or upstream branch. A missing upstream is not proof of publication. Preserve and reconcile any unexpected source or ownership before resuming.

## Step 2.5 — Required MCPs hard-gate

If the resumption target's mapped progress record or referenced active iteration doc (an existing `doing.md`, `investigation.md` or per-iteration doc named in the task card's `iterations.active`) declares `required_mcps:` in frontmatter, treat that list as a **hard requirement** for resuming, not a recommendation. Consume all applicable declared requirements; an explicit provider progress path does not erase the iteration's requirements.

`required_mcps:` is a list of MCP keys matching aliased entries in the workspace's runtime MCP config — either under `[mcps.builtins.<alias>]` (runtime-proxied builtins) or `[mcps.servers.<alias>]` (external stdio MCPs). both namespaces are valid sources; the key just needs to be loaded at runtime. example frontmatter snippet:

```yaml
required_mcps:
  - analytics-store
```

**check**: for each entry in `required_mcps`, consult the runtime's loaded-MCP registry to confirm the key is currently loaded — engine-specific. (implementations may probe the harness's own loaded-MCP listing, an introspection MCP, or a tool-name-prefix scan; encode the principle, not the API.)

**hard-stop**: if any required MCP key isn't loaded, **STOP at the resumption prompt before proceeding to Step 3**. don't start the phase, don't begin tool work, don't silently continue. print:

1. the list of required MCP keys that are missing.
2. the likely root cause: the runtime's workspace MCP config link absent, broken, or pointing somewhere else; or the MCP isn't declared in the workspace MCP config. reference session-start Step 4.7's link check.
3. a note that the agent will not proceed with this resumption until restarted with the required MCPs loaded.

example stop message:

```
Required MCPs not loaded for this iteration: [analytics-store]

Likely cause: workspace MCP-config link absent or broken.
session-start will create it on the next launch if the workspace
MCP config exists. Confirm the MCP is declared there, then restart
the agent.

Resumption paused until the required MCPs are available.
```

**why hard-stop, not recommendation**: when an iteration doc declares `required_mcps`, the planning pass already determined the work cannot proceed without those tools. letting the agent continue and discover the missing tool mid-investigation wastes operator time and contaminates the iteration's audit trail with abandoned work. session-start's Step 4.7 is the soft self-healing path (creates the symlink so MCPs auto-load next time); this gate is the hard requirement at the resumption boundary.

if the iteration doc has no `required_mcps:` field, this step is a no-op — proceed to Step 3.

## Step 3 — Re-enter the right phase

Only after writer release, source and effect reconciliation, current authority and required capabilities are established, invoke the adapter once at `reconciled-resume` for an authorized active task. Pass the same mapped progress/rulings and next expected step; do not invoke it again at each state row. A paused, blocked or human-gated task does not enter until its specific gate is satisfied. Resume scheduling through `desk:work-orchestration` and review through `superpowers:requesting-code-review`, consuming their existing ready-set, frozen-candidate, finding-disposition and affected re-review contract without resetting attempts or opening another fix loop.

| Status | Resume action |
|--------|---------------|
| `drafting` (default) | Read the existing alignment receipt and mapped plan/progress. Use `work-orchestration` and transition clear work directly to `processing` only with an agreed definition of done and explicit go-ahead; otherwise resume alignment, not implementation. |
| `drafting` + `planning_complete: true` | Reuse the plan and recorded go; the flag alone is not approval. Transition to `processing` when authorized and retain the flag for history. |
| `processing` | Resume the selected Superpowers execution skill from the task, branch and mapped progress/rulings. |
| `validating` | Resume verification and recorded delivery/resource obligations through `task-lifecycle` and `git-hygiene`; Markdown `cleanup_pending` stays canonically `validating`. Do not turn an alpha endpoint into a main merge. |
| `collaborating` | Read back the specific required input/approval. If already satisfied, resume the recorded phase without another go; otherwise show only the missing input and wait. |
| `paused` | Ask the operator whether they want to resume (go back to the pre-pause state) or update the status. |
| `blocked` | Show the blocker description + when/why. Ask whether it's resolved. If yes, go back to the pre-block state. |

full transition rules and state machine live in the `task-lifecycle` skill.

## Step 4 — Commit any state changes

if resuming caused a status transition (e.g., `drafting` → `processing` because `planning_complete: true`), follow the state-change protocol in `task-lifecycle`: update the `updated` timestamp, commit, push, and trigger any downstream actions (status tweet, archive) as applicable.
