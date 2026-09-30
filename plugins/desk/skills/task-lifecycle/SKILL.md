---
name: task-lifecycle
description: The 8-state task lifecycle machine — one job as one task, states, valid transitions, the state-change protocol, and handling of adopted tasks with pre-completed planning. Use whenever a task changes state, when checking whether a proposed transition is valid, or when deciding whether new work is a new task or another iteration of an existing one.
---

# Task lifecycle

Invoke `desk:using-superpowers-with-desk` for engineering, at its `start` entry for new work and at its `material-redesign` entry when an approved outcome changes design or scope materially. This skill owns Desk state transitions, not a second implementation lifecycle; Superpowers consumes the existing task, approval, plan and terminal boundary.

Every task moves through a state machine with 8 states. The `status` field in `task.md` tracks the current state.

## States

| State | Description | Workflow phase |
|-------|-------------|----------------|
| `drafting` | Clarifying scope and choosing the route; a clear task can remain task-card-only | `work-orchestration` |
| `processing` | Writing code, running tests, implementing | Selected Superpowers execution skill |
| `validating` | Verifying the approved delivery endpoint, including authorized PR/release/smoke work | `superpowers:verification-before-completion` through the Desk adapter |
| `collaborating` | Human gate — waiting for operator input/review/approval | Paused for human |
| `paused` | Temporarily suspended by operator | No active work |
| `blocked` | External dependency, unclear requirement | No active work |
| `done` | Terminal delivery verified and archived | Terminal |
| `cancelled` | Abandoned by operator | Terminal |

## One job is one task

A job is one outcome, and it is recorded as exactly one task for its whole life. A follow-up, a re-review, a retry or a second attempt at the same outcome is a new iteration of the existing task (`directory-structure` "iteration-directory rules"), not a new task, even when it arrives in a new session or after the task is `done` and archived; `start-task` says how to reopen it. A genuinely different outcome that grew out of the work is a new task, linked from the old one with an `origin_note:`.

`desk_doctor` reports `duplicate_job` when two live task cards reference the same pull request. Fold them into one: keep the task that holds the most history, move the other's iteration folders under it with Git, and archive the emptied card, under the tidying rules in `interaction-style` section 2.

## Resuming a task

"Resume `<task>`" means report the task card's recorded state (its `status` and the next step already written there) and continue exactly that step — not a different task, and not a silently reinterpreted scope. Never declare completion without evidence: an agent that has not actually finished the recorded next step must not report it done, set `status: done`, or write a "Completed work" section describing tests, merges or reviews that did not happen. `task_update` and `task_archive` both enforce this on any move into `done`, refusing one with no `evidence` reference (a PR, a commit on a remote branch, a CI run, or a stated non-code outcome's own proof link) checkable in that reference's own shape; genuinely abandoned work moves to `cancelled` instead (`task_archive` takes this as `outcome: "cancelled"`), which needs none of that. A direct edit to a task card's `status:` line — Write, Edit, or MultiEdit — that bypasses both tools is denied at the tool-call boundary for the same reason. When the recorded next step is unclear, blocked, or contradicted by what you actually find, say so and move the task to `blocked` or `collaborating` rather than guessing or inventing progress.

## Checkpoint-type annotations on transitions (folded in from AIDLC 2026-05-18)

Each transition has a checkpoint type declaring how humans interact at that gate. AIDLC's `feature-orchestration` skill used 5 types (GATE / CHECKPOINT / AUTO / CONFIRM / NOTIFY); desk adopts them as a sibling layer on the existing state machine (annotations, not a replacement).

| Transition | Checkpoint type | What it means |
|------------|-----------------|---------------|
| → `drafting` | NOTIFY | Entry point; the agent creates, names and files the task itself (`start-task`) and says so in one line; no approval of the name or track |
| `drafting` → `processing` | AUTO | The existing alignment receipt records the agreed outcome, definition of done, and explicit go-ahead. New work without it stays in alignment; a clear task or completed plan alone is not authorization. |
| `processing` → `validating` | AUTO | Implementation is complete; record the authorized delivery ref and open a PR only when repository policy calls for one; no new human go |
| `validating` → `done` | AUTO | The selected Superpowers implementation owner verifies the agreed terminal state through `verification-before-completion` and the recorded repository policy, including applicable release/install, consuming-surface smoke, resource dispositions and durable state. Normal merge tasks require the exact green merge; a preview-only task preserves its branch without main promotion. Explicit owner policies can still route a required approval through `collaborating`. |
| Any → `collaborating` | NOTIFY | Worker records the specific unsatisfied human gate and tells the operator what's needed; resume when that required input/approval is recorded, without another go |
| Any → `paused` | NOTIFY | Operator-requested pause; worker emits a clean handoff state |
| Any → `blocked` | NOTIFY | External blocker; worker emits the blocker reason + escalation path |
| Any → `cancelled` | CONFIRM | Operator confirms abandonment; rare; worker doesn't auto-cancel |
| `done` → `processing` | NOTIFY | Reopen: another round of the same job (a follow-up, re-review or retry) continues the existing task; the agent records why in the card and says so in one line (`start-task`) |
| `cancelled` → (terminal) | (n/a) | Terminal; no further transitions. `done` is terminal too unless the same job is reopened |

**Why annotate:** the checkpoint type makes human interaction explicit. AUTO transitions proceed under the task's authorization; NOTIFY transitions explain a real pause. Do not manufacture a checkpoint because a planning document exists.

## Valid transitions

```
                    +---> collaborating ---+
                    |         ^            |
                    |         |            v
  drafting --> processing --> validating --> done
    |  ^          |              |
    |  |          v              v
    |  +--- collaborating   collaborating
    |
    v
  cancelled

  Any non-terminal state --> paused --> (return to previous state)
  Any non-terminal state --> blocked --> (return to previous state when resolved)
  Any non-terminal state --> cancelled
  done --> processing   (reopen for another round of the same job)
```

## State-change protocol

Every transition writes the applicable durable surfaces in order. Commit-message-only is not sufficient: a new session must reconstruct what happened from the task, track and mapped progress/rulings. Consume the adapter's mapped `progressPath` and derived `rulingsPath`; an explicit provider progress file is not replaced by a universal `doing.md`. When the map resolves to `task.md`, update it in place rather than writing a duplicate progress record.

### 1. Task card (`task.md`)

- Update `status` field.
- Update `updated` timestamp to ISO 8601 UTC.
- Body updates as transition dictates:
  - Transitioning to `processing`: add a "Current work" line pointing at the active branch and mapped progress record.
  - Transitioning to `validating`: record the authorized delivery refs and applicable PR URLs (one per repo in multi-repo tasks), with repo name, title and status; a no-push or local handoff endpoint does not require a PR.
  - Transitioning to `done`: move the PR list to a "Landed" section with merge shas and record applicable release/install, smoke, and cleanup evidence. For an explicitly unmerged terminal outcome, use "Delivered" with the preview or PR ref and its proof; never invent a merge. `task_update` (and `task_archive`, when archiving a task that isn't already terminal) requires an `evidence: { kind, ref }` argument on this transition (`task-card-format`'s "Evidence on `done`") and refuses a bare `done` without one.
  - Transitioning to `blocked` / `collaborating`: a "Blocker" / "Waiting on" line with the specific reason.

### 2. Mapped progress/rulings (for `processing`, `validating`, `done` transitions)

Clear tasks can execute from the task card without a doing document. Update the mapped progress record, whether an explicit provider file, existing `doing.md` or `task.md`; retain historical artifacts without forking the active record. At minimum:

- Check off unit checkboxes (`- [ ]` → `- [x]`) for units completed.
- If the implementation owner produced a progress log at the top, append the current transition.
- On `validating`: record the applicable PR URL or intentional unmerged delivery ref and its remaining obligations.

### 3. Track card (`track.md`)

- Update the relevant row in the Tasks table:
  - `State` column to the new status
  - `PR` column if a PR was opened (URL, one per repo in multi-repo)
- If transitioning to `done`: move the row into the "Landed" section or strike it; track the merge. Use "Delivered" instead for an explicitly unmerged terminal outcome.

### 4. Commit + push

`task_update`, `track_update` and `task_archive` stage and commit the files they write themselves, exactly the paths written, as part of the call — no separate `git add`/`git commit` follows one of those calls. Update the mapped progress/rulings record with a Desk tool where one exists; when it's a hand-written file no Desk tool covers, commit it with `desk_save` (`paths`, `message`) rather than a manual `git commit`.

Each of those tools also schedules a debounced background push right after a successful commit — it runs detached, off the tool call, so nothing here waits on it. Manual pushing still works:

```
cd $DESK && git push origin main
```

and is the right call when the push needs to have actually landed before doing something else — handing off to another machine or agent mid-session, say — rather than leaving it to the background worker's own timing. Either way, `desk_status`'s `sync` field reports whether the desk is caught up (`blocked: false`, with `ahead`/`behind` counts and the last recorded push time) or stuck (`blocked: true`, with `reason`/`paths`); it never makes a network call itself, so it reports state as of the last push attempt or fetch, not a live check.

Auth and push convention is consumer-specific: corporate-worker overlays push under whatever enterprise-managed identity the org requires (the overlay's git-identity skill handles this); ouroboros agents push under whatever account their bundle's git remote is configured for; personal agents per their setup. This applies to the background worker's own pushes as much as a manual one — both use whatever credentials are already configured in the environment.

### 5. Downstream triggers

- If transitioning to `done` or `cancelled` → invoke `archive-workflow`.
- If transitioning to `done` → make the change with `task_update` (or `task_archive`). The tool writes `factory_report: <link>` into the card when the desk's resolved store has consent, and it writes the finalize request that starts delivery. Do not write or change `factory_report` yourself. `done` does not wait for the store: the link is fixed when the task is done and resolves once the store merges the job's facts and rebuilds its reports.
- If transitioning to `done` or `cancelled` → the same `task_update` (or `task_archive`) call already records the job's evaluation request for the waste evaluator, kept in protected factory state until the job's labels are complete; nothing to run by hand. Both statuses request one: a cancelled job is still a finished job, and the waste in it is exactly what the evaluator needs to see. Briefs are prepared later, off this path, by the session-start hook's `evaluate --pending`; handle each job's answer (`ready`, `no_sessions`, `complete`, `not_opted_in`) as `desk:session-start` Step 4.8 says, which also owns the `Factory:` lines a session start reports about waste labels. Neither status waits for the evaluator.
- (Optional, overlay context) If the transition is shiproom-relevant (`processing`, `validating`, `done`, `blocked`) → invoke the consumer overlay's status-update skill to refresh the parent work-item's status note. Skip for non-coding / non-tracker contexts.

### Why the applicable writes

Commit messages are not a handoff format. A new session reading the task card must see current state, active branch/artifact, open PRs, blockers, and terminal evidence without shell archaeology. Keep the track card aligned and use the explicit progress/rulings map without creating another state tree.

## Close-out at every ownership boundary

The owner closes out a task, iteration or delegated assignment when that unit ends, even while its parent continues. Through `desk:git-hygiene`, reconcile all created worktrees and branches, remove only exact-owned safe worktrees and merged branches authorized by the endpoint, and restore touched surviving checkouts to their recorded state branch when safe. Record checkout readbacks and resource dispositions in the tables below. Unmerged alpha or PR-only delivery resources are retained-with-trigger, not deleted or switched away from their delivery branch.

Every child return includes a **Resources** inventory: every created worktree's exact repository, path, branch/ref and current HEAD; every created local or remote branch and its current state; its owner, writer/consumer release evidence, intended disposition and verified result. List retained and transferred resources too, and explicitly say `none created` when empty. A parent must not infer a missing inventory from a successful implementation result. Unknown ownership, unsafe checkout restoration or incomplete cleanup remains `cleanup_pending` while canonical status is `validating`.

The selected Superpowers controller consumes the inventory through the [Desk adapter](../using-superpowers-with-desk/SKILL.md#mapped-controller-close-out). It removes each completed task's worktree after acceptance and writer release, before dropping that task's reservation; it does not wait for the whole plan to finish or remove resources held for an authorized PR-only endpoint.

## Delivery and resource accounting

The mapped progress record (`progressPath`) is the single canonical home for delivery and resource accounting. If `progressPath` resolves to `task.md`, keep the tables there, not in a second record. Record resources at creation, including their exact repository/worktree path or host resource/operation identity, owning task/attempt and process generation, active writers or consumers, intended cleanup or transfer owner, and evidence pointer. Keep detailed host/private evidence in approved protected storage, not the task card. No delivery daemon or schema is introduced.

Create the following headings and tables in that record when needed, using this single definition. These tables are a Markdown convention, not task frontmatter, a ninth state, a database schema or a universal lifecycle schema. Each table shows one illustrative placeholder row:

```markdown
## Delivery

| State | Recorded endpoint / policy / authority | Required gate / evidence | Responsible owner | Next action |
| --- | --- | --- | --- | --- |
| cleanup_pending | <recorded endpoint; repository policy; authority reference> | <required gate and evidence pointer> | <responsible owner> | <next action> |

## Resources

| Exact resource / generation identity | Owning task / attempt / generation | Active writers / consumers | Intended disposition | Evidence pointer | Terminal disposition details |
| --- | --- | --- | --- | --- | --- |
| <repository/worktree path or host resource/operation identity; exact generation> | <canonical task; attempt; owning process generation> | <exact active writers/consumers or verified none> | <intended disposition and cleanup/transfer owner> | <approved evidence pointer> | <removed-and-absent: absence readback; or named transfer: named transferee and acknowledgement; or retained-with-trigger: reason, owner and cleanup trigger> |
```

`cleanup_pending` is a Markdown delivery state while the canonical task status stays `validating`; it is not a ninth task state. A process exit, merged PR or successful build is not completion while resources remain unaccounted for. Every resource requires one verified disposition before transition to `done`:

- **removed-and-absent**: exact-owner cleanup plus source-system/host readback proving the resource and its owned writers or descendants are absent.
- **named transfer**: a specific receiving owner has acknowledged the exact resource, ongoing obligations and next step; recording an intended recipient alone is insufficient.
- **retained-with-trigger**: a responsible owner, reason and explicit cleanup trigger are recorded and verified, including intentional alpha branches/worktrees, protected evidence and any continuing consumers.

Unknown ownership, uncertain external effects or failed absence checks remain unresolved in the table, not silently complete. Reconcile effects and writer release through `desk:session-resumption`; perform repository/process cleanup through `desk:git-hygiene` and the owning host's existing skills. `desk:work-orchestration` owns reservations and ready-set recomputation, and `superpowers:requesting-code-review` owns review admission on the current candidate and affected re-review; resource accounting does not bypass their finding-disposition, acceptance or sole-writer gates.

Apply the recorded repository policy through `repo-handling`, `git-hygiene`, PR and host-specific skills, not a fresh literal finishing menu. Use `collaborating` only while an actual required human approval is outstanding; after it is recorded, return to `validating` and continue authorized agent-owned merge/cleanup without asking for another go. An alpha/PR-only endpoint retains its required refs and cannot authorize plugin main promotion.

## Adopted tasks with completed planning

When a task comes in from an external bundle with planning and doing docs already written, it still starts in `drafting`. Reuse that work through `desk:using-superpowers-with-desk`; enter at `material-redesign` only when the adopted design itself materially changes, and do not recreate plans or approval already supplied by the mandate.

Signal via task card frontmatter:

```yaml
status: drafting
planning_complete: true
```

When resuming a task with `planning_complete: true` and `status: drafting`, reuse its planning work. The flag is not an approval receipt. If the outcome, definition of done and go are recorded, transition to `processing` without reopening them; otherwise resolve the missing agreement through `superpowers:brainstorming`. Preserve the flag for audit history. An already-approved clear task without planning documents follows the same direct transition.

## Dispatch belongs to the selected implementation owner

The selected Superpowers implementation owner chooses a sequential or delegated execution shape within the recorded authority and `desk:work-orchestration`'s ready-set contract. Historical `Execution Mode` headers do not grant delegation or override current instructions. Progress and rulings remain at their explicit mapped Desk paths across delivery and recovery.
