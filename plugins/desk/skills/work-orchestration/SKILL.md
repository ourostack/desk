---
name: work-orchestration
description: Align new work before go by gathering every decision that needs the human's judgment into one batch with recommendations, then bind authorized engineering work to the selected Superpowers method and preserve Desk state and cross-repository dependency authority.
---

# Work orchestration

Invoke `desk:using-superpowers-with-desk`. This Desk adapter selects no second engineering method: Superpowers owns discovery, planning, execution and verification; Desk owns the work state and approved terminal boundary.

Read the existing task, agreement and plan before choosing the matching Superpowers skill. Consume prior approval without reopening it. Use `superpowers:brainstorming` for missing design agreement, `superpowers:writing-plans` when a plan is needed, and `superpowers:executing-plans` or authorized `superpowers:subagent-driven-development` for implementation. Keep plans and progress on Desk. Invoke `superpowers:requesting-code-review` for the normal review transition.

## Align new work before go

Before new work starts, list every decision in it that needs the human's judgment: voice, relationships, irreversible or hard-to-undo choices, and real ambiguity. Naming and filing are not among them: the agent owns them (`start-task`). Resolve each one you can from the request, the code or a sensible default. Put the rest to the human now, not when you reach the fork, and especially any entangled calls, where one answer changes another or changes work done before the fork. Ask them as one batch, each with your recommendation, so execution then runs without blocking on the human. A fork that could not have been foreseen is raised when it appears; one you did not think about beforehand is not unforeseeable.

## Authority and dependencies

Verify repository authority and the approved contribution path before any branch, worktree or source edit. Read-only requests remain read-only. Delegation and worktree creation stay within the recorded mandate.

The cross-repository plan owns an explicit DAG; `repos[]` must never define dependency order. Reject cycles and unknown dependencies. A failed predecessor blocks its dependents, not independent ready nodes. Use isolated worktrees and explicit working directories for authorized parallel work. Serialize shared/version surfaces or merge normally; never force-push through a coordinated conflict.

Plan delivery milestones as well as task dependencies. The target is the smallest coherent, usable milestone for a real consumer: an end-to-end slice with only the nodes required for that slice on its critical path. Keep unrelated qualification, automation, documentation and platform-breadth work downstream.

When the ready set can produce an independently usable artifact, complete that milestone's review and authorized publish, install and consuming-surface smoke. Qualification can continue afterward and must not block an independently usable slice. Record the remaining criteria and keep the milestone's readiness claim narrow.

Do not optimize for one final reveal. Local branches, completed nodes and review receipts are engineering progress, not delivered value. Replan when a consumer is waiting while unrelated tail work gates a safe usable milestone. If an intermediate artifact cannot be safe or coherent, record the exact coupling that requires atomic delivery.

Only a current, unsatisfied `needs-human-approval` is a hard exception. A producer may use `needs reviewer gate` only when it explicitly permits machine review. Superseded records do not revoke existing go. Mechanical reviews go to the authorized reviewer. A nested worker returns its brief and evidence to the parent rather than self-certifying or waiting for the parent's entire task to finish.

Before any fan-out, the root identifies dependencies, write sets, exclusive resources, the integration fold, the evidence each child must return, and the final synthesis it will own. If those stay implicit, the work is not ready to split.

Include `task-lifecycle`'s **Resources** inventory in every child return contract, including reviewers: every created worktree and local/remote branch, exact repository/path/ref, current state, owner and verified disposition, or `none created`. Record ownership and disposition at creation, not from branch-name patterns at cleanup time. At each task, iteration or delegated-assignment boundary, its owner closes out through `git-hygiene`; the Superpowers controller removes completed task worktrees through `using-superpowers-with-desk`'s mapped controller duty before releasing their reservations. A return or root exit alone does not prove that delegated, remote, MCP or command writers are absent.

Each repository retains its own branch and merge cycle. The isolation and shared-surface rules above apply at that repository boundary.

If material resequencing becomes necessary, record the observed waste pattern, the recommendation, and the consequence of not resequencing before changing the plan.

Desk owns task and iteration state and archive transitions. The agreed endpoint determines whether verification ends at an intentional alpha/PR-only branch or includes authorized merge, release/install, consuming-surface smoke and cleanup. Superpowers finish options cannot silently change that endpoint.

Invoke `superpowers:requesting-code-review` once at the diff boundary with the candidate branch and the relevant evidence, and record the head it reviewed as evidence. Record every finding disposition, keep one Superpowers implementation owner, run one bounded correction wave, and request affected re-review rather than opening a second implementation loop or repeating review after every edit.

## Ready-set scheduling and continuous peer review

This section consumes the cross-repository plan's five-column Markdown DAG, its node states and the T01 adapter's mapped context; it produces ordered dispatch/acceptance events linked to native call IDs, resource ownership and commit-review receipts. It defines no task schema or frontmatter, no universal graph parser, service or database, and it never touches a Superpowers payload.

```text
1. Read the plan and progress; reject unknown dependencies and dependency cycles before dispatch.
2. Ready = pending nodes with all dependencies accepted.
3. Walk ready nodes in stable table order; reserve complete writes/resources before launching.
4. Dispatch every non-conflicting ready node through pristine Superpowers skills in its own worktree.
5. Missing conflict data or unavailable parallel execution serializes the same ready set.
6. A result is accepted only after spec/targeted proof and native Superpowers review disposition.
7. On failure, block only descendants; release verified resources and recompute immediately.
8. A candidate-changing repair invalidates affected descendants and re-enters at the same owner.
```

Ready is exactly step 2's definition: pending nodes with all dependencies accepted; an unknown dependency or a dependency cycle is rejected before any dispatch, never silently skipped. Walk that ready set in stable table order — the DAG's own row order, never an inferred priority — and reserve each ready node's complete write set and exclusive resources before it launches, so overlapping write sets or contended exclusive resources between two ready nodes hold one of them back rather than let both proceed; missing conflict data serializes the same ready set instead of guessing at safety, and so does an environment where parallel execution is unavailable. This relaxation of unconditional cross-node serialization is Desk's own approved concurrency policy, not an upstream source change: the pristine Superpowers skills underneath are unmodified either way.

Dispatch every non-conflicting ready node through pristine Superpowers skills in its own worktree: `superpowers:using-git-worktrees` gives each dispatched node its own isolated worktree so no two ready nodes share a writer; `superpowers:dispatching-parallel-agents` fans genuinely independent, non-conflicting nodes out; `superpowers:subagent-driven-development` and `superpowers:executing-plans` carry out one dispatched node's own implement/fix loop; `superpowers:verification-before-completion` runs before any acceptance. One coherent task's implement/fix loop stays sequential; independent non-conflicting nodes may run concurrently in stable table order.

A candidate is accepted only after spec/targeted proof and a completed finding disposition from `superpowers:requesting-code-review` against the candidate branch, with the head it reviewed recorded as evidence. The same Superpowers implementation owner handles one bounded correction wave and the affected re-review; never open a second fix loop beside that owner's loop.

On failure, failure blocks only descendants: independent ready nodes already dispatched keep running, the failed node's reserved resources are released, and the ready set is recomputed immediately rather than held open. A candidate-changing repair invalidates its affected descendants' prior acceptance and re-enters at the same Superpowers implementation owner, not a new one.

Final behavioral scheduling proof — that dispatch, serialization and acceptance actually execute this way at runtime — belongs to a later task; this section ships the source contract and the real caller/provider witnesses only.
