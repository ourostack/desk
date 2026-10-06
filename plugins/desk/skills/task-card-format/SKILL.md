---
name: task-card-format
description: Schema for `task.md` — the per-task card inside a task directory. Covers required fields, adoption signals (`planning_complete`, `adopted_at`), local-path portability via tilde paths, and adopted doc filename conventions. Use when creating, reading, or updating a task card.
---

# Task card format

`task.md` is the cover of the folder — one task per folder, one folder per piece of work. it lives inside a task directory and represents one unit of work within a track.

A blocked task's card records why in a `## Blocker` (or `## Waiting on`) section or a `Blocker:` line; boot prints that reason beside the task, and falls back to the card's `**Next step:**` paragraph. Boot prints both whole, never cut.

## Template

```yaml
---
schema_version: 1
title: "<task-slug>"
status: drafting
created: "YYYY-MM-DDTHH:MM:SSZ"
updated: "YYYY-MM-DDTHH:MM:SSZ"
track: <track-directory-name>

# Optional: categorization + runtime fields (see "Runtime fields" below)
category: general                       # general | reminder | coordination | infrastructure | <free>
cadence: "30m"                          # recurring cadence — daemon fires `ouro poke <agent> --task <id>` per cadence
scheduledAt: 2026-05-21T09:00:00Z       # one-time scheduled fire (mutually compatible with `cadence` if both present)
requester: "ari"                        # who asked for this task (defaults to "self" when agent-initiated)
validator: "ari"                        # who validates completion
artifacts: [https://github.com/.../pull/123]  # outputs produced by this task (PR URLs / file paths)
active_bridge: "bridge-abc123"          # set by bridge promotion — bridge ID this task durably records
bridge_sessions: ["sess-xyz789"]        # set by bridge promotion — session IDs the bridge is coordinating
factory_report: https://github.com/<store>/blob/reports/jobs/<job>.md  # set by the task tools at done, only on a desk known to be private
factory_report_unavailable: desk_not_private  # set by the task tools instead of the link: the reason code a done card has no link
evidence:                               # required by task_update, or by task_archive archiving a non-terminal task without outcome: cancelled; see task-lifecycle "Resuming a task"
  kind: pr                              # pr | commit | ci_run | non_code
  ref: https://github.com/<org>/<repo>/pull/123
  recorded_at: 2026-04-21T09:00:00Z     # set by task_update; never hand-write

# Optional: adoption signals
planning_complete: true                 # skip brainstorming and planning; resume at implementation
adopted_at: 2026-04-16T14:30:00Z        # when the task entered the workspace (distinct from `created`)

repos:
  - name: OrderService
    local_path: ~/code/OrderService     # tilde paths only — never absolute /Users/<alias>/...
    mode: local                         # local (cloned) | remote (read-only via API)
    url: https://github.com/<org>/OrderService.git  # optional: where to clone it from; boot's missing-clone instruction runs `git clone <url> <local_path>`
    # local_only: true                  # written by Desk, never by you: set when task_create or boot first sees the clone with no remote and the entry has no url; task_update refuses to set or change it
  - name: OrderAdminPortal
    local_path: ""
    mode: remote

# Optional: per-task iteration history
# Each repo workspace contains per-iteration directories. The task card
# tracks which iteration is active and the full history, so an agent
# reading the task card alone sees the iteration shape without needing
# to traverse the repo workspace.
iterations:
  active: ./OrderService/2026-04-21-review-pass-1    # null when between iterations
  history:
    - slug: 2026-04-13-initial-impl
      repo: OrderService
      trigger: initial-impl
      pr: 1234567                                    # null for task-level refactor iterations
      path: ./OrderService/_archive/2026-04-13-initial-impl
      outcome: shipped-to-pr                         # shipped-to-pr | merged | reverted
    - slug: 2026-04-21-review-pass-1
      repo: OrderService
      trigger: pr-feedback
      pr: 1234567
      path: ./OrderService/2026-04-21-review-pass-1
      outcome: in-progress
---
```

## Test command

When a repo has a test command, name it on the card (a line such as `**Test command:** python3 -m unittest`, in the repo's folder). A resuming agent can then run it and report a result it saw; a note, commit message or reply that says tests pass names the command that ran (`task-lifecycle`).

## Required fields

`title`, `status`, `created`, `updated`, `track`, `repos[]` (each with `name`, `local_path`, `mode`, and optionally `url`, the clone URL boot uses when the local clone is missing, and `local_only`, which only Desk writes).

## Schema versioning

`schema_version: 1` declares the current task-card schema. consumers (parsers, migrators, the desk MCP server) read it to know how to interpret the rest of the frontmatter.

**back-compat rule:** files missing `schema_version` are treated as `schema_version: 0` (pre-versioned). consumers MUST accept v0 files indefinitely — parsing them with the current schema works because v1 is a strict superset of v0. new task creation always writes `schema_version: 1`.

**bump rule:** increment `schema_version` only when a change is genuinely breaking (a required field added, a field renamed, a value range changed). adding optional fields is NOT a schema bump — desk has many optional fields and they accumulate without disturbing the schema_version.

## Runtime fields (optional)

these fields are read by the harness, not the agent. set them when the task represents something the harness needs to schedule, route, or reconcile:

- **`category`** — free-string tag. reserved values: `reminder` (creates via `ouro reminder create` — fires on a schedule), `coordination` (bridge-promoted tasks), `infrastructure` (harness self-maintenance). anything else is a project category the agent can use freely.
- **`cadence`** — recurring schedule expressed as `Nm` / `Nh` / `Nd` (e.g. `30m`, `4h`, `1d`) or a cron expression. the daemon scheduler fires `ouro poke <agent> --task <id>` at each cadence interval. leave unset for non-recurring tasks.
- **`scheduledAt`** — ISO 8601 timestamp for a one-time scheduled fire. compatible with `cadence`: `scheduledAt` is the first/next fire; `cadence` is the repeat interval after.
- **`requester`** — who asked for this task. `"self"` when agent-initiated; the operator's alias when operator-initiated; another agent's name when delegated cross-agent.
- **`validator`** — who validates completion. usually the same as `requester`; differs when the validator is a separate party (e.g. automated test suite).
- **`artifacts`** — list of outputs this task produced. PR URLs, file paths, document references. appended to as the task progresses.
- **`active_bridge`** — set automatically by `promoteBridgeToDesk`. records the bridge ID this task durably represents. read by the bridge lifecycle reconciler to auto-resolve bridges when their backing task reaches `done` / `cancelled`.
- **`bridge_sessions`** — set automatically by `promoteBridgeToDesk`. session IDs the bridge is coordinating across. read by the same reconciler.
- **`factory_report`** — the link to this job's factory report, written by `task_update` or `task_archive` on the transition to `done` when the desk's resolved factory store has consent (see `desk:session-start` Step 2.7) and the desk is known to be private. A public desk's card never links its job, because that would tie the public card to the store's job. The link is deterministic, so it is written at once and may not resolve until the store has merged the job's facts and rebuilt its reports; `done` never waits for that. Cards without consent, cards finished before the field existed and `cancelled` cards have no link. Never write or edit it by hand: `task_update` and `task_create` refuse it in `frontmatter`.
- **`factory_report_unavailable`** — written by the task tools instead of `factory_report` when the store has consent but no link can be named, as a reason code only: `desk_not_private` (a public desk, one GitHub answered as unknown, or one with no GitHub remote; meant to last), `visibility_not_known` (the cached visibility answer is expired, absent or unreadable) or `job_identity_unavailable`. The tool result carries the same field. A later `task_update` of the card, or `task_archive` of it (again, for an archived card), asks again and replaces the field with the link once one can be named. Never write, edit or remove it by hand: `task_update` and `task_create` refuse it in `frontmatter`.

agents creating tasks via `desk` skills don't typically set runtime fields directly — they're added by `ouro reminder create`, by bridge promotion, or by the operator. but agents reading task cards should understand what these fields mean so they don't strip them on edits.

## Outcome records (written by the task tools)

Three optional keys record how a task was delivered and answered. The task tools write them; you never write or edit them, and `task_update` and `task_create` refuse `signoff`, `flow` and `returns` in `frontmatter` (to record an answer, call `task_signoff`). Read them to understand a card; keep them when you edit around them.

- **`signoff`** — written by the task tools when a task is delivered and when the operator answers: `state` (`delivered_unsigned`, `accepted` or `refused`), `at` (when the operator answered, empty until then), `verified` (true when Desk saw a human message behind the answer, false when it did not, empty until answered) and `reason` (the operator's reason for a refusal: `not_what_was_asked`, `defect`, `changed_ask`, `incomplete` or `other`). A move out of `done` through `task_update` clears it; a refusal through `task_signoff` keeps it as `refused`.
- **`flow`** — written by the task tools on every status change: `since` (`created` or `adopted`, for a card that existed before the record), `rev` (how many recorded moves), `reached` (the furthest main-line status since the last return), `first_validating_at`, `first_delivered_at`, `delivered_at` and `deliveries` (how many times the task was delivered).
- **`returns`** — written by the task tools, one line per return, oldest first: `<time> <from> <to> <agent reason> <caught>`, with ` refused=<operator reason> <verified|unverified>` added when the operator's refusal caused it. The agent reason is `agent_error`, `changed_ask`, `new_information` or `external`; `caught` is `in_task`, `at_review` or `after_delivery`. `task-lifecycle`, "Returns", says what a return is and why a move back needs `return_reason`; `task_update` takes `return_reason` as its own input, never in `frontmatter`. A card whose `returns` list is damaged is counted by the factory, never read as having no returns.

A card with no record is a task from before the record existed; it is never read as accepted.

## Evidence on `done`

unlike the runtime fields above, **`evidence`** is supplied by the agent, not the harness: a transition to `status: done` — whether made by `task_update`'s `frontmatter: { status: "done" }` or by `task_archive` bumping a non-terminal task on archive — is refused unless the call passes `evidence: { kind, ref }`, and it's written onto the card as `evidence: { kind, ref, recorded_at }` alongside the transition. `kind` is one of `pr`, `commit`, `ci_run` or `non_code`; `ref` is a checkable reference in that kind's own shape — a PR URL, a commit sha (optionally with its repo/branch) or a commit URL, the CI run's own https URL, or an https URL or desk-relative path to a non-code proof — and an error names the exact shape expected when `ref` doesn't match its `kind`. A `non_code` desk-relative path is resolved against the desk root and must land on a file or directory that actually exists there — a path that escapes the desk via `..`, or names nothing on disk, is refused the same as free text with no link. **When the card lists `repos:`, only code evidence finishes the task.** `kind: pr` needs a PR URL whose owner/repo (or Azure DevOps repo name) is one of the card's repos or a remote of its recorded clone, so a fork route's upstream and fork both match (no network call: shape and repository only). `kind: commit` needs a sha (or a commit URL in one of the repos) that resolves in one of the recorded local clones (`git cat-file` in `repos[].local_path`) and is contained in a remote-tracking branch of that clone, meaning it is pushed; the one exception is a repo Desk recorded as local-only (`local_only: true` on its entry, below), where a commit that a branch or HEAD reaches and that was made after the card's `created` is accepted as it stands, because that repo has nowhere to push. A commit that exists only in the desk, or in a repo the card does not list, is refused, and so is an unpushed one in a clone that has a remote (push, or open a PR and pass its URL, or leave the task at `validating` and tell the operator the commit sha). `non_code` and `ci_run` are refused, because `non_code` is only for a task with no code repos. On any card, a `non_code` ref may not be the task card itself. Each refusal names exactly what to supply. If the PR cannot be opened, the task stays at `validating` (or `blocked` when the work is unfinished); it does not move to `done` on a stand-in. A `task_update` cannot empty `repos` on a card that has them as a way round this: it is refused unless the call sets `status: cancelled`, or passes `repos_removed_reason: "<one line>"` because the work turned out not to touch those repos. The reason is recorded on the card as `repos_removed: [{ name, reason, at }]`, and the same call may not set `status: done`: finish in a separate call with `non_code` evidence that is not the card itself. `task_archive` instead accepts `outcome: "cancelled"` in place of `evidence` for genuinely abandoned work, archiving the task as `cancelled` with no evidence required; a task already `done` or already `cancelled` archives as-is, needing neither. a direct edit to `status: done` that bypasses both tools — Write, Edit, or MultiEdit, and so never supplies or records evidence — is denied at the tool-call boundary on Claude Code; see `task-lifecycle`'s "Resuming a task" for the contract this enforces. cards finished before this field existed have no `evidence`, and `cancelled` cards never require one.

consumer agents extending this with their own work-tracker schema (e.g. enterprise overlays with Feature / Epic hierarchies) add their own frontmatter block — typically the overlay ships a card-fields skill defining the tracker-specific `tracker:` + `repos[].org` shape.

## Local path portability

the desk travels — same folder, different machines. **never commit absolute paths with a specific username** (e.g. `/Users/<alias>/code/<repo>`). they don't resolve on other machines. always use `~/code/<repo-name>` tilde paths — they expand to `$HOME` on whatever machine opens the task card.

the `repo-handling` skill handles auto-discovery and machine-local overrides when the tilde path doesn't resolve on a given machine.

## Iteration history (`iterations:`)

`iterations:` is the canonical per-task record of iteration shape — every page that's ever been laid open on the desk for this folder. it supersedes the older `doing_docs:` field (now deprecated — see `directory-structure` for the iteration-centric layout).

- `iterations.active` → relative path to the currently-running iteration directory (`./<repo>/<YYYY-MM-DD>-<slug>/`), or `null` when the task is between iterations.
- `iterations.history[]` → one entry per past or current iteration. each entry carries:
  - `slug` — iteration slug (`YYYY-MM-DD-<trigger>`)
  - `repo` — which repo the iteration targets (matches `repos[].name`)
  - `trigger` — one of `initial-impl`, `pr-feedback`, `architecture-review`, `post-int-smoke-fixes`, `revert-and-reland`, `pre-merge-polish`, or a new trigger the agent names from what the iteration does
  - `pr` — PR number this iteration drives, or `null` for task-level refactor iterations with no PR yet
  - `path` — relative path from task root to the iteration directory (active entries point at the live dir; archived entries point at `_archive/`)
  - `outcome` — `shipped-to-pr` | `merged` | `reverted` | `in-progress`

linking out from the task card to per-iteration `doing.md`, `planning.md`, and `feedback.md` is how the agent navigates the layered-doc model documented in `skills/pr-feedback-on-own-pr/SKILL.md`.

## Iteration-doc `required_mcps:` field

a per-iteration doc (`doing.md`, `investigation.md`, etc.) MAY declare `required_mcps:` in its frontmatter — a list of MCP keys matching aliased entries in the runtime's workspace MCP config under either `[mcps.builtins.<alias>]` (runtime-proxied builtins) or `[mcps.servers.<alias>]` (external stdio MCPs). the field signals a HARD requirement: when the operator picks the task to resume, `session-resumption` stops at the resumption prompt if any required MCP isn't loaded. see the `session-resumption` skill for enforcement details and the consumer overlay's "Workspace MCPs" docs for the runtime-specific workspace MCP config convention.

## Filename timestamp convention for adopted docs

per-iteration docs (`planning.md`, `doing.md`, `feedback.md`) live inside an iteration directory named `<YYYY-MM-DD>-<slug>/`. the iteration directory's date prefix carries the "when was this originally written" signal; the files inside use canonical names without embedded timestamps.

for **adopted** planning/doing docs pulled from legacy bundles:
- preserve the adoption date in the iteration directory name (typically `<YYYY-MM-DD>-adopted` or the original iteration slug if it was already in the source layout).
- add `adopted_at:` to the doing-doc frontmatter to record when the doc entered `$DESK/` (distinct from the iteration date).

## Cross-org / multi-platform routing

when a task spans repos hosted across different orgs or platforms, the routing is encoded in consumer-specific frontmatter fields (e.g. `repos[].org` selecting an org-specific MCP server). consumer overlays ship the routing schema specific to their tracker(s).
