---
name: using-superpowers-with-desk
description: Map an existing Desk task, approval, plan and progress record onto one pristine Superpowers entry and an explicit artifact map. Invoke at the start of engineering work, at a reconciled resume, or at a material redesign.
---

# Using Superpowers with Desk

Desk owns work identity, authority, durable state and the agreed delivery endpoint. Superpowers owns engineering discovery, planning, implementation and verification. This adapter is the only seam between them: it reads what Desk already recorded, selects one provider entry, and hands over explicit existing paths. It is not a second lifecycle, contract, store or scheduler.

## Boundary

```text
Entry: start | reconciled-resume | material-redesign.
Read: canonical task, recorded approval, delivery endpoint, explicit artifact map.
Select once: brainstorming for new/material design; writing-plans for approved unplanned design; subagent-driven-development for this approved plan; executing-plans only as the same ready-set sequential fallback.
Pass: task path, design/plan/progress pointers, authority and endpoint.
Return: selected provider entry and mapped context. Do not review, recover, schedule, deliver or measure here.
```

Nothing else enters here. Use `superpowers:brainstorming` for new/material design, `superpowers:writing-plans` for approved unplanned design, `superpowers:subagent-driven-development` for this approved plan, and `superpowers:executing-plans` only as the same ready-set sequential fallback. A resume that has already reconciled its writer and source re-enters at its recorded step; a genuinely new outcome or material design change re-enters at selection. Everything after the handover belongs to the selected Superpowers skill.

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
| `--plan-path` | Optional. A supplied plan must be an existing regular file within the Desk root; a shared cross-repository plan stays at its existing Desk planning path. Omit it for approved task-card-only work, which returns `planPath: null`. |
| `--progress-path` | Optional. A supplied progress record must be an existing regular file inside this task's own directory, resolved through any symlink, and within the effective person prefix, because progress and rulings are written. Omit it to select the iteration's existing `doing.md`, then the canonical `task.md`. |

Apply the outputs in place of upstream SDD's path-producing helpers: `planPath` is the plan input or `null`; `progressPath` is the existing progress record and `rulingsPath` is derived from it, so a provider progress file never becomes a second ruling store and a legacy `doing.md` is never renamed; `briefPath`, `implementationReportPath`, `reviewPackagePath` and `reviewReportPath` are the explicit artifact destinations under the approved private evidence root. Produce the normal Superpowers brief and review contents at those paths with native file and diff tools. This changes storage binding, not the engineering method.

Include the mapper's `briefRules` in **both the implementer brief and every reviewer brief**, including re-reviews. The Desk-owned addition to each brief template is:

> verify or validate in your own worktree; never in a checkout your task does not own

This rule is passed through the adapter, not patched into the vendored Superpowers templates. A [protected-checkout denial](../../docs/protected-checkouts.md) applies to parent agents and subagents alike; it does not grant ownership of a different checkout.

Do not create a competing `.superpowers/sdd` tree. Keep canonical Git-backed Desk/Crew state on main through its established write protocol; an intentional alpha applies to the approved code artifact, not a competing workspace-state branch. An explicitly absent file fails; never replace that failure with an inferred plan, a mock receipt or a fallback workspace. The mapper returns `cleanupPaths: []`, which is no deletion authority, and a printed evidence path is neither proof of protection nor permission.

On interruption, read the canonical progress record, not an upstream shadow ledger. Reuse the recorded step and attempt for reading; allocate an explicit new attempt for new output and preserve earlier evidence. Full task, repository and iteration qualification prevents same-basename plan and progress collisions.

The evidence root must be an explicitly approved private artifact location outside Git-backed Desk. It must never be the reserved `<state home>/ouroboros-skills/desk/work-measurement/` ledger partition. File contents remain subject to the repository's write authority and the selected private-storage policy. The mapper does not create, discover or protect an evidence store.

## Everything else has an owner

| Responsibility | Owner |
| --- | --- |
| Checkpoint, interruption and replacement-writer recovery | `desk:session-resumption` |
| Code review and affected re-review | `superpowers:requesting-code-review` |
| Ready-set scheduling, conflicts and dispatch | `desk:work-orchestration` |
| Work accounting, intake, commitment and evaluation triggers | `desk:work-measurement-ledger` |
| Delivery and promotion | the recorded repository policy and the existing repository skills |
| Retired Work Suite call names | `desk:superpowers-integration`, the retired compatibility redirect |

If a required native or consumer capability is unavailable, report that limitation and preserve the unfinished outcome; do not silently drop its acceptance criteria or substitute a reduced-capability path.
