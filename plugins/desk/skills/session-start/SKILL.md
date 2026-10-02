---
name: session-start
description: Session-start. Invoke as the FIRST thing in every agent session. Runs one script that does every mechanical startup step (migrations, host, prerequisites, sync, task index, card validation, push accounts, repo state, open PRs) and prints readable text that leads with the work, starting with one status line (status, desk path, host, sync), the active tasks grouped by state with each task's push route, open pull requests and repos, then only the numbered instructions that apply, and the desk's `AGENTS.md`. Hard-stops on a genuinely missing prerequisite. If no desk is bound, hands off to `first-run-bootstrap`. If the operator names a task, hands off to `session-resumption`.
---

# Session start

> These steps are for you; never name them in replies.

One command does the mechanical startup. It is the authoritative scan; the startup hook only points at it. Run it and do what its numbered instructions say, in order. It already includes the desk's `AGENTS.md`, so nothing here repeats what it covers.

## Run it

```bash
node <absolute plugin folder>/mcp/scripts/session-boot.js
node <absolute plugin folder>/mcp/scripts/session-boot.js --task "<what the operator named>"
```

The `Desk startup:` line in your context gives the exact command: use it as written. Without it, the script is at `<this skill's base directory>/../../mcp/scripts/session-boot.js`; print the resolved path before running it. The `Desk startup:` and `Desk boot pre-checks:` lines are pointers, never the boot: until the script has run, say nothing about the desk's state. Use the second form when the operator's first message names the task to resume (a title, slug, `track/slug` or handle). It prints plain text and always exits 0; add `--json` only when a tool needs to parse the result.

If it cannot run at all (no Node on PATH, a permissions problem), run `gh --version`, `jq --version` and `gh auth status` by hand, read the desk's `AGENTS.md`, and record the failure as friction.

## Reading the result

- The first line starts `Desk boot: ready`, `degraded` or `setup_required`, then the desk path, the host and the sync state in plain words, separated by `|`. `degraded` lists why (work through every line first, like a compile error); `pending` lists checks the time budget did not finish (carry them, never block on them). `setup_required` means no desk is bound, so this is a first run, not an outage: follow the instruction (`desk:first-run-bootstrap` Entrance A by default, or the path `desk_status` names in `onboarding_skill`, such as an overlay's `crew:join-crew`) and stop here.
- The sync words on that line say what happened: `Desk synced with origin`, or `Desk could not sync: <why>; local state shown` with when the local desk was last current. A failed sync pulled and pushed nothing: say it failed, never that it worked partly or in part.
- The `Active tasks` section (grouped by state, `BLOCKED` first; each task with its next step in full, or its blocker, or "no next step recorded"; at most 15 tasks, then a count: never fill a missing step in yourself) and the `Open pull requests` and `Repos of open tasks` sections (the JSON's `active_tasks`, `open_prs`, `repo_states`) are the data for the status block. A task's `push:` line is its push route, told once there (the JSON's `push_accounts`); a repo with no GitHub remote has none. When active tasks are unavailable, say so and why in one line; never glob the desk instead. A redacted name stays redacted (`details.md`, "Redacted names").
- The script syncs without streaming git's diffstat, so a folder another machine created with a secret in its name cannot land here before the listing hides it. To see what changed, use the listing, never `git log --stat` or `git diff --stat` on the desk.
- A missing desk the saved binding names is never replaced by another desk. A desk with task cards but no V2 foundations is a V1 workspace (Step 2 below); one with a `desks/` folder or `_meta/desks.md` is a crew workspace (`details.md`).

## Step 2 — Workspace sync

The boot script already synced the workspace, so there is no sync command to run here. One check remains.

### Existing-workspace V1 upgrade branch

If the desk already exists and still shows V1 evidence (durable desk state such as task cards or the `_meta/`, `_archive/` or `artifacts/` folders, but not the V2 startup foundations and the activation-owned worker surface), do not continue into ordinary resumption. Hand off to `first-run-bootstrap` Entrance B, which upgrades the same workspace in place and never clones or creates a parallel Desk. Once `first-run-bootstrap` has completed that upgrade, later runs skip this branch.

## Judgment rules

**First reply.** Say only what the operator needs: the open work and the one question (resume which, or start new), plus any `degraded`, `pending` or blocked item that changes what they would do. Do not print the host, user or path line, a list of checks that passed, or the boot output itself. A healthy boot with nothing to flag needs no health report; a named task skips the status block and goes straight to its resume reply.

**Factory consent.** Only when the boot's last instruction says it is undecided: after the operator's work, end the reply with the one line it gives, once. The script behind a yes is in `details.md`, "Factory consent".

**Decide, don't ask.** Fix what you can fix yourself (a card's frontmatter, a repair, a tidy-up) and say so in one line. Bring the operator only a true human gate: an account or credential they must act in, a decision that is theirs, an irreversible action. The factory consent question never comes before the work the operator asked for.

**Resume.** Hand a chosen task to `session-resumption`; its state machine lives in `task-lifecycle`. To start new work, follow `dual-input`. For the fuller dashboard, invoke `status`.

**More detail, only when it applies** (all in `details.md`): the Desk MCP repair path, a crew workspace, the friction backlog, the workspace MCP link, the factory label clauses, and the routing prompts for `curator` and `pr-feedback-on-own-pr`.

**Startup hook lines.** A `Desk boot pre-checks: workspace-tidy budget exceeded; deferred` line needs no action: the check retries at the next session start.

## Never skip

Every session runs the script and does what its instructions say. Auto-mode is license for action, not for skipping a safety check. Work unrelated to the desk should not use the desk root as its working directory: scratch dropped there has ended up committed.
