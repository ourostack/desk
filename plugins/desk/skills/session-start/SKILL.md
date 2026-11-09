---
name: session-start
description: Run first in every session, and when the operator asks for status or 'where are we'. Runs the boot script and turns its output into the first reply.
---

# Session start

In a hosted Desk (no shell; the connector's instructions say so), skip this skill and call `desk_status`, which is the startup status block.

> These steps are for you; never name them in replies.

One command starts the mechanical startup; the startup hook only points at it. Session entry has a 3000 ms foreground budget: return light local context and let the runtime own sync, migrations, index work and deep checks in the background. Do not wait, poll or run serial repairs before addressing the supplied task. Follow root, admission, identity and writer gates only for the operations that depend on them. It already includes the desk's `AGENTS.md`.

## Run it

```bash
node <absolute plugin folder>/mcp/scripts/session-boot.js
node <absolute plugin folder>/mcp/scripts/session-boot.js --task "<what the operator named>"
```

The `Desk startup:` line in your context gives the exact command: use it as written. Without it, the script is at `<this skill's base directory>/../../mcp/scripts/session-boot.js`; print the resolved path before running it. The `Desk startup:` and `Desk boot pre-checks:` lines are pointers, never the boot: until the script has run, say nothing about the desk's state. Use the second form when the operator's first message names the task to resume (a title, slug, `track/slug` or handle). It prints plain text and always exits 0; add `--json` only when a tool needs to parse the result.

If it cannot run at all (no Node on PATH, a permissions problem), preserve that failure and use permitted light local context for the supplied task. Use `desk-problem` for supported recovery without replacing startup with serial prerequisite probes. Do not claim boot or dependent checks passed.

## Reading the result

- The first line starts `Desk boot: ready`, `degraded` or `setup_required`, then the desk path, the host and the sync state in plain words, separated by `|`. `degraded` lists actual scoped faults. Routine background `pending` or admission is quiet, not a terminal failure or proof of readiness. Start the supplied task without waiting for background settlement (`desk-problem`). `setup_required` means no desk is bound: use the named onboarding path (`desk:first-run-bootstrap` or `crew:join-crew`) when setup is requested; it does not prohibit an independent supplied task.
- Read sync state as evidence, not a success implied by startup returning. Retain the acknowledged worker's operation identity and use the runtime's supported status/readback without launching a duplicate. Pending recovery is not “synced”; local context is not a finished recovery endpoint. A failed sync or timeout is not proof that nothing changed: before another mutation, read back files, HEAD and remote state and distinguish confirmed applied, confirmed absent and unknown effects. Never claim a save, commit, push or source convergence without its own proof.
- The `Active tasks` section (grouped by state, `BLOCKED` first; each task with its next step in full, or its blocker, or "no next step recorded"; at most 10 tasks, then a count: never fill a missing step in yourself) and the `Open pull requests` section (the JSON's `active_tasks`, `open_prs`) are the data for the status block. Push routes and repo state are checked only for a task the operator named: once the operator picks a task, run the boot again with `--task "<its handle>" --task-only`. That run prints only the task's `Push routes` (the JSON's `push_accounts`), its repos under `Repos of open tasks` (`repo_states`) and its instructions, not the task list or `AGENTS.md` again; a repo with no GitHub remote has no route. A first boot that names a task shows each route as the task's `push:` line. When active tasks are unavailable, say so and why in one line; never glob the desk instead. A redacted name stays redacted (`details.md`, "Redacted names").
- The script syncs without streaming git's diffstat, so a folder another machine created with a secret in its name cannot land here before the listing hides it. To see what changed, use the listing, never `git log --stat` or `git diff --stat` on the desk.
- A missing desk the saved binding names is never replaced by another desk. A desk with task cards but no V2 foundations is a V1 workspace (see the workspace check below); one with a `desks/` folder or `_meta/desks.md` is a crew workspace (`details.md`). A session started in a Crew workspace clone binds that clone even when the saved binding or `DESK` names another desk, and the first line then adds `person <alias>, writes to desks/<alias>` and where the person came from, or says the team workspace is read-only and why.

## Check the workspace without waiting for sync

Do not run a foreground sync or wait for the recovery worker here. Use the boot's light local context; recover and verify in the background. One compatibility check remains for desk-dependent work.

### Existing-workspace V1 upgrade branch

If the desk already exists and still shows V1 evidence (durable desk state such as task cards or the `_meta/`, `_archive/` or `artifacts/` folders, but not the V2 startup foundations and the activation-owned worker surface), do not perform ordinary desk resumption or dependent mutations. Use `first-run-bootstrap` Entrance B for the same workspace, never clone a parallel Desk. The migration does not hold unrelated authorized work or the first reply behind a long startup. Once the upgrade completes, later runs skip this branch.

## Judgment rules

**First reply.** Address the supplied task using available light local context. When no work was supplied, give the open work and the one question (resume which, or start new), in ordinary conversation where permitted (`interaction-style`, "Questions and blocked prompts"). A policy-blocked question is not pending human approval; preserve host instruction precedence and report a transport conflict if no permitted asking route remains. Surface only a consequential unresolved barrier, not routine pending recovery or passed checks. Do not print the host, user or path line or boot output. A named task skips the status block and goes straight to its resume reply.

**Factory consent.** Only when the boot's last instruction says it is undecided: after the operator's work, include the statement it gives once. If delivering a task, defer that notice to a later turn; never replace the delivery's required sign-off or mix it with another decision group. The script behind a request for details is in `details.md`, "Factory consent".

**Decide, don't ask.** Own routine choices within the supplied task, including a bounded known operational repair when safe. Do not turn a helper fault or an improvement-card notice into an unsolicited maintenance child, branch or PR. Respect the existing repair owner. Bring the operator only a true human gate: an account or credential they must act in, a decision that is theirs, an irreversible action. The factory consent question never comes before the work the operator asked for.

**Declare the task.** When the operator names or picks the task, the main agent calls `task_focus` once; `session-resumption` then skips its call, and a new task is declared by `task_create` with `focus: true`.

**Delivered, awaiting sign-off.** A boot section by that name and one numbered instruction list delivered tasks the operator has not answered; `details.md` says what to do with them, in short: after what the operator asked, raise them once, together.

**Resume.** Hand a chosen task to `session-resumption`; its state machine lives in `task-lifecycle`. To start new work, follow `start-task`.

**Status on request.** When the operator asks "status" or "where are we" later in the session, answer from `desk_status` with `{ detail: true }`: its `active_tasks` (by track, newest first, at most 20, then a count), each task's blocker or waiting reason, the local repos of open tasks with uncommitted or unpushed work (`git -C <path> status --porcelain`), and the last three entries in `$DESK/_meta/friction.md`. It is read-only: do not sync first, fetch trackers or change anything; end by asking which task to resume or whether to start new.

**More detail, only when it applies** (all in `details.md`): the Desk MCP repair path, a crew workspace, the friction backlog, the workspace MCP link, the factory label clauses, and the routing prompts for `curator` and `pr-feedback-on-own-pr`.

**Startup hook lines.** Routine background or deferred work needs no foreground action or warning. Do not convert a display deadline into cancellation, failure, a new dispatch or a claim that synchronization finished.

## Never skip

Every session runs the script and does what its instructions say. Auto-mode is license for action, not for skipping a safety check. Work unrelated to the desk should not use the desk root as its working directory: scratch dropped there has ended up committed.
