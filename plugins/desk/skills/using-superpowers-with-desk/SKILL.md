---
name: using-superpowers-with-desk
description: Map an existing Desk task, approval, plan and progress record onto one pristine Superpowers entry and an explicit artifact map. Invoke at the start of engineering work, at a reconciled resume, or at a material redesign.
---

# Using Superpowers with Desk

Desk owns work identity, authority, durable state and the agreed delivery endpoint. Superpowers owns engineering discovery, planning, implementation and verification. This adapter is the only seam between them: it reads what Desk already recorded, selects one provider entry, and hands over explicit existing paths. It is not a second lifecycle, contract, store or scheduler.

## This entry satisfies Superpowers' "1% chance" rule

`superpowers:using-superpowers` requires invoking a skill the moment there is even a 1% chance it applies; for engineering work on a Desk task, this adapter is that skill, so invoking it at the start of engineering work, a reconciled resume or a material redesign is how that rule gets satisfied, not a workaround to weigh against it. Invoke this adapter first rather than reasoning about which raw `superpowers:*` skill might apply instead; its own Boundary below then selects and hands off to the specific one (brainstorming, writing-plans, subagent-driven-development, or the executing-plans fallback), which is the next required invocation the same rule already covers, not a redundant second decision.

## Boundary

```text
Entry: start | reconciled-resume | material-redesign.
Read: canonical task, recorded approval, delivery endpoint, explicit artifact map.
Select once: brainstorming for new/material design; writing-plans for approved unplanned design, task-card-only work included; subagent-driven-development for this approved plan; executing-plans only for an existing plan, as the same ready-set sequential fallback, never for a task with no plan.
Pass: task path, design/plan/progress pointers, authority and endpoint.
Return: selected provider entry and mapped context. Do not review, recover, schedule, deliver or measure here.
```

Nothing else enters here. Pick the entry from what the task already holds, top row that applies first (the two plan rows differ only in how the plan runs, so each is reachable):

| What the task holds | Select |
| --- | --- |
| No approved design, a new outcome, or a material design change | `superpowers:brainstorming` |
| An approved design or outcome but **no plan** (including approved work that lives only on the task card; `planPath` would be `null`) | `superpowers:writing-plans` |
| An approved plan (an existing plan file to pass as `--plan-path`), and a subagent tool is available, and the human did not choose inline execution | `superpowers:subagent-driven-development` |
| An approved plan, and there is no subagent tool or the human chose inline execution: the same ready set runs in this session | `superpowers:executing-plans` |

`superpowers:executing-plans` executes a plan, so it is never the entry for a task with no plan: a task card is not a plan. A recorded next step that is one small, clear change needs no plan document (next section); anything larger gets a short plan first: select `writing-plans` (or `brainstorming` when the design itself is unapproved), then re-enter the plan row. A resume that has already reconciled its writer and source re-enters at its recorded step; a genuinely new outcome or material design change re-enters at selection. Everything after the handover belongs to the selected Superpowers skill.

## Resuming a named task, and where a plan lives

"Resume `<task>`" continues the card's recorded next step; it does not start new planning. When that step is one small, clear change (one file or one test), the step on the card is the plan: do the work test-first in the card's repo and record progress with `task_update` (`note`, and `next_step` when the next action changes). No plan document is written and no planning skill runs.

When a plan is genuinely needed (several tasks, several owners, a risky or unclear design), it is written inside the task's own iteration folder in the desk, `<track>/<task>/<repo>/<YYYY-MM-DD>-<slug>/planning.md` (`directory-structure` has the layout; a cross-repo plan goes in `<track>/_planning/`), and that file is the `--plan-path`. A plan never goes into the operator's code repository (no `docs/superpowers/plans/` there) and never into the desk root, whatever a provider skill's default save location says. Choose the execution method (subagent-driven or inline) yourself from the table above; it is an engineering call, not a question for the operator.

Superpowers' `writing-plans` is a skill that writes a plan file. It is not the host's Plan mode, which Desk never enters; selecting `writing-plans` neither requires nor implies Plan mode.

## Authority carried into the provider

Prior approval remains valid; do not reopen it without a scope change.

Delegation remains limited by the recorded authority.

An intentional alpha or PR-only delivery endpoint does not authorize main promotion.

One implementation owner handles all remediation and re-review findings.

Read the existing task card, plan, progress record and explicit mandate before selecting. Do not infer permission from access, tool availability, a paused historical record, or a provider skill's default finish options. Later explicit instructions supersede older state; keep that fact attributable in Desk. A required machine-review gate is not a new request for human go, and an actual human-only approval boundary is respected. Superpowers approval checkpoints consume the already-recorded approval when it covers the same outcome and scope; its worktree and finishing routines cannot change the approved repository, delegate against a prohibition, promote an intentional alpha to main, publish, install into live profiles, or clean up preserved work without authority.

## Incremental delivery

Build the agreed outcome through the smallest coherent milestones that put a working artifact in a real consumer's hands. A milestone may be labeled dogfood, preview, or alpha and remain partially qualified, but its own safety, compatibility, migration, review, and correction path must be honest.

Later evaluation, automation, documentation breadth, platform breadth, and final qualification can continue after that milestone. They must not block an independently usable slice merely because both belong to one final plan. Keep every remaining criterion visible and scope readiness claims to the evidence that exists.

Incremental milestones do not change the authorized endpoint or lower its standards. If no safe intermediate artifact exists, record the concrete coupling that makes delivery atomic instead of assuming one final release by default.

## Explicit artifact map

Resolve the map once, with explicit existing paths, before handing over:

```sh
node <loaded-desk-plugin>/mcp/src/activation/superpowers-context.js --desk-root <desk-root> --person <alias> --task-path <task-directory> --iteration-path <iteration-directory> [--plan-path <existing-plan>] [--progress-path <existing-progress>] --evidence-root <approved-private-evidence-root> --step <positive-step> --attempt <positive-attempt>
```

Omit `--person` for a single-person Desk. Use the actually loaded, admitted Desk artifact, not a guessed sibling directory or mutable cache path. The mapper reads and creates nothing: it reuses Desk's path authority without creating missing roots, verifies existing regular files, and returns JSON.

| Option | Meaning |
| --- | --- |
| `--plan-path` | Optional. A supplied plan must be an existing regular file within the Desk root; a shared cross-repository plan stays at its existing Desk planning path. Omit it while the task has no plan: the mapper returns `planPath: null`, and the selection above is `writing-plans`, not `executing-plans`. |
| `--progress-path` | Optional. A supplied progress record must be an existing regular file inside this task's own directory, resolved through any symlink, and within the effective person prefix, because progress and rulings are written. Omit it to select the iteration's existing `doing.md`, then the canonical `task.md`. |

Apply the outputs in place of upstream SDD's path-producing helpers: `planPath` is the plan input or `null`; `progressPath` is the existing progress record and `rulingsPath` is derived from it, so a provider progress file never becomes a second ruling store and a legacy `doing.md` is never renamed; `briefPath`, `implementationReportPath`, `reviewPackagePath` and `reviewReportPath` are the explicit artifact destinations under the approved private evidence root. Produce the normal Superpowers brief and review contents at those paths with native file and diff tools. This changes storage binding, not the engineering method.

Include the mapper's `briefRules` in **both the implementer brief and every reviewer brief**, including re-reviews. The Desk-owned addition to each brief template is:

> verify or validate in your own worktree; never in a checkout your task does not own

The first `briefRules` entry is a `Desk-Task: <track>/<slug>` line, which must be copied verbatim, on its own line, into every implementer and reviewer brief so the factory can credit each subagent's work to its own task.

Also pass the mapper's close-out rule in both brief types: every child returns every created worktree and branch, its exact repository/path/ref, current state, owner and verified disposition in the mapped Resources record. `task-lifecycle` owns that return inventory and `git-hygiene` owns its safety gates; the mapper does not infer cleanup paths.

This rule is passed through the adapter, not patched into the vendored Superpowers templates. A [protected-checkout denial](../../docs/protected-checkouts.md) applies to parent agents and subagents alike; it does not grant ownership of a different checkout.

Do not create a competing `.superpowers/sdd` tree. Keep canonical Git-backed Desk/Crew state on main through its established write protocol; an intentional alpha applies to the approved code artifact, not a competing workspace-state branch. An explicitly absent file fails; never replace that failure with an inferred plan, a mock receipt or a fallback workspace. The mapper returns `cleanupPaths: []`, which is no deletion authority, and a printed evidence path is neither proof of protection nor permission.

On interruption, read the canonical progress record, not an upstream shadow ledger. Reuse the recorded step and attempt for reading; allocate an explicit new attempt for new output and preserve earlier evidence. Full task, repository and iteration qualification prevents same-basename plan and progress collisions.

The evidence root must be an explicitly approved private artifact location outside Git-backed Desk. It must never be inside the factory's own state directory, `<state home>/ouroboros-skills/desk/factory/`, or the retired work ledger's `<state home>/ouroboros-skills/desk/work-ledger/`, whose leftover folders `desk_doctor` counts. File contents remain subject to the repository's write authority and the selected private-storage policy. The mapper does not create, discover or protect an evidence store.

## Mapped controller close-out

At pristine `superpowers:subagent-driven-development`'s per-task completion step, the controller reads the child's Resources inventory and the mapped `progressPath`, reconciles every exact writer and consumer, and removes that completed task's worktree through `superpowers:using-git-worktrees` and the recorded `desk:git-hygiene` cleanup policy. Record absence readback and any merged-branch deletion or safe state-branch restoration through `desk:task-lifecycle` before marking the unit complete and releasing its reservation. This is the provider's controller duty with Desk's existing authority and storage map, not a second scheduler or a change to the vendored provider.

An intentionally retained alpha/PR-only worktree or an acknowledged transfer stays named with its owner and trigger. Missing inventory, a live or unobservable writer, local-only work, failed cleanup or an unacknowledged transfer keeps cleanup pending; neither a child's success status nor a plan-complete flag grants deletion authority. The sequential `executing-plans` fallback has the same ownership boundary.

## Everything else has an owner

| Responsibility | Owner |
| --- | --- |
| Checkpoint, interruption and replacement-writer recovery | `desk:session-resumption` |
| Code review and affected re-review | `superpowers:requesting-code-review` |
| Ready-set scheduling, conflicts and dispatch | `desk:work-orchestration` |
| Intake and commitment | `desk:task-lifecycle` |
| Work accounting | automatic: the factory captures each session when it ends and reports each finished job; nothing to route |
| Evaluating a finished job | `desk:online-evaluation` |
| Delivery and promotion | the recorded repository policy and the existing repository skills |
| Retired Work Suite call names | `desk:superpowers-integration`, the retired compatibility redirect |

If a required native or consumer capability is unavailable, report that limitation and preserve the unfinished outcome; do not silently drop its acceptance criteria or substitute a reduced-capability path.
