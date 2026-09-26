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
  - Transitioning to `done`: move the PR list to a "Landed" section with merge shas and record applicable release/install, smoke, and cleanup evidence. For an explicitly unmerged terminal outcome, use "Delivered" with the preview or PR ref and its proof; never invent a merge.
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

After the three artifact updates above:

```
cd $DESK && git add <specific-files> && git commit -m "task(<slug>): <old> -> <new>" && git push origin main
```

Auth and push convention is consumer-specific: corporate-worker overlays push under whatever enterprise-managed identity the org requires (the overlay's git-identity skill handles this); ouroboros agents push under whatever account their bundle's git remote is configured for; personal agents per their setup.

### 5. Downstream triggers

- If transitioning to `done` or `cancelled` → invoke `archive-workflow`.
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
