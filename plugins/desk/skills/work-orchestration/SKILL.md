---
name: work-orchestration
description: Bind authorized engineering work to the selected Superpowers method and preserve Desk state and cross-repository dependency authority.
---

# Work orchestration

Invoke `desk:superpowers-integration`. This Desk compatibility entrypoint selects no second engineering method: Superpowers owns discovery, planning, execution and verification; Desk owns the work state and approved terminal boundary.

Read the existing task, agreement and plan before choosing the matching Superpowers skill. Consume prior approval without reopening it. Use `superpowers:brainstorming` for missing design agreement, `superpowers:writing-plans` when a plan is needed, and `superpowers:executing-plans` or authorized `superpowers:subagent-driven-development` for implementation. Keep plans and progress on Desk. Invoke `desk:independent-review` for the required independent gate.

Verify repository authority and the approved contribution path before any branch, worktree or source edit. Read-only requests remain read-only. Delegation and worktree creation stay within the recorded mandate.

The cross-repository plan owns an explicit DAG; `repos[]` must never define dependency order. Reject cycles and unknown dependencies. A failed predecessor blocks its dependents, not independent ready nodes. Use isolated worktrees and explicit working directories for authorized parallel work. Serialize shared/version surfaces or merge normally; never force-push through a coordinated conflict.

Only a current, unsatisfied `needs-human-approval` is a hard exception. Superseded records do not revoke existing go. Mechanical reviews go to the authorized reviewer. A nested worker returns its frozen brief to the parent rather than self-certifying or waiting for the parent's entire task to finish.

Desk owns task and iteration state and archive transitions. The agreed endpoint determines whether verification ends at an intentional alpha/PR-only branch or includes authorized merge, release/install, consuming-surface smoke and cleanup. Superpowers finish options cannot silently change that endpoint.

Invoke `desk:independent-review` for a fresh cold branch review at the diff boundary, using frozen source and evidence inputs. This is the same independent-review cycle with one Superpowers remediation owner, not a second implementation loop or a repeated per-edit ceremony.

## Ready-set scheduling and continuous peer review

This section consumes the cross-repository plan's five-column Markdown DAG, its node states and the T01 adapter's mapped context; it produces ordered dispatch/acceptance events linked to native call IDs, resource ownership and commit-review receipts. It defines no task schema or frontmatter, no universal graph parser, service or database, and it never touches a Superpowers payload.

```text
1. Read the plan and progress; reject unknown dependencies and dependency cycles before dispatch.
2. Ready = pending nodes with all dependencies accepted.
3. Walk ready nodes in stable table order; reserve complete writes/resources before launching.
4. Dispatch every non-conflicting ready node through pristine Superpowers skills in its own worktree.
5. Missing conflict data or unavailable parallel execution serializes the same ready set.
6. A result is accepted only after spec/targeted proof and terminal exact-commit RoboRev disposition.
7. On failure, block only descendants; release verified resources and recompute immediately.
8. A candidate-changing repair invalidates affected descendants and re-enters at the same owner.
```

Ready is exactly step 2's definition: pending nodes with all dependencies accepted; an unknown dependency or a dependency cycle is rejected before any dispatch, never silently skipped. Walk that ready set in stable table order — the DAG's own row order, never an inferred priority — and reserve each ready node's complete write set and exclusive resources before it launches, so overlapping write sets or contended exclusive resources between two ready nodes hold one of them back rather than let both proceed; missing conflict data serializes the same ready set instead of guessing at safety, and so does an environment where parallel execution is unavailable. This relaxation of unconditional cross-node serialization is Desk's own approved concurrency policy, not an upstream source change: the pristine Superpowers skills underneath are unmodified either way.

Dispatch every non-conflicting ready node through pristine Superpowers skills in its own worktree: `superpowers:using-git-worktrees` gives each dispatched node its own isolated worktree so no two ready nodes share a writer; `superpowers:dispatching-parallel-agents` fans genuinely independent, non-conflicting nodes out; `superpowers:subagent-driven-development` and `superpowers:executing-plans` carry out one dispatched node's own implement/fix loop; `superpowers:verification-before-completion` runs before any acceptance. One coherent task's implement/fix loop stays sequential; independent non-conflicting nodes may run concurrently in stable table order.

A candidate is accepted only after spec/targeted proof and a terminal exact-commit disposition with `source=post_commit` from the same Superpowers implementation owner through `desk:independent-review` — a promised, in-flight, stale-SHA or duplicate result is not acceptance. Never run `roborev fix` or `roborev refine` as a parallel remediation path, and never open a second fix loop beside the implementation owner's own loop.

On failure, failure blocks only descendants: independent ready nodes already dispatched keep running, the failed node's reserved resources are released, and the ready set is recomputed immediately rather than held open. A candidate-changing repair invalidates its affected descendants' prior acceptance and re-enters at the same Superpowers implementation owner, not a new one — the same single-owner remediation rule `desk:independent-review` already requires.

Final behavioral scheduling proof — that dispatch, serialization and acceptance actually execute this way at runtime — belongs to a later task; this section ships the source contract and the real caller/provider witnesses only.
