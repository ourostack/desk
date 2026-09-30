---
name: session-start
description: Session-start. Invoke as the FIRST thing in every agent session. Runs one script that does every mechanical startup step (migrations, host, prerequisites, sync, task index, card validation, push accounts, repo state, open PRs) and returns one JSON result with an `instructions` array to act on. Hard-stops on a genuinely missing prerequisite. If no desk is bound, hands off to `first-run-bootstrap`. If the operator names a task, hands off to `session-resumption`.
---

# Session start

One command does the mechanical startup. This skill is the authoritative owner of migration ordering, workspace sync, task discovery and resumption routing, and the script is its authoritative scan: the startup hook never duplicates it. Run it, act on its `instructions`, and keep the judgment rules below.

## Run it

```bash
node <Desk plugin folder>/mcp/scripts/session-boot.js
node <Desk plugin folder>/mcp/scripts/session-boot.js --task "<what the operator named>"
```

`<Desk plugin folder>` is two levels above this skill's folder: `$CLAUDE_PLUGIN_ROOT` under Claude Code, the plugin folder the activation names under Copilot CLI and Codex. The script covers all three hosts and prints them in `covers_hosts`. Use the second form when the operator's first message already names the task to resume (a title, slug, `track/slug` or handle); the script resolves it and its `instructions` say whether to hand off to `session-resumption` or ask which one. Run it before anything else touches `$DESK/`. It prints one JSON line and always exits 0, and `boot_complete: true` means it finished, not that everything is healthy.

If it cannot run at all (no Node on PATH, a permissions problem), run `gh --version`, `jq --version` and `gh auth status` by hand, read `$DESK/AGENTS.md`, and record the failure as friction.

## Act on the result

- Do what `instructions` says, in order. They are plain sentences naming the exact file, command, task or repo. The same problems also appear in `degraded` (why startup is not healthy), `pending` (checks the time budget did not let finish: carry them, never block on them) and `actions`.
- `status` is one word. `ready` means go on. `degraded` means work through every `degraded` line first: it is like a compile error, and a missing `gh`, an old `gh` or stale auth is a hard stop, never a cue to work offline. The operator may override a broken prerequisite only after you name the specific risk. `setup_required` means no desk is bound: this is a first run, not an outage. Follow the instruction (`desk:first-run-bootstrap` Entrance A by default, or the path `desk_status` names in `onboarding_skill`, such as an overlay's `crew:join-crew`) and stop session-start there.
- A desk the saved binding or `$DESK` names that is missing is never replaced by another desk: restore it, or rebind through `first-run-bootstrap` with the operator's agreement.
- Read `$DESK/AGENTS.md` when the instructions say to. Its rules bind the whole session.
- A desk that holds task cards but lacks the V2 foundations is a V1 workspace: see Step 2 below. If it has a `desks/` folder or a roster in `_meta/desks.md`, it is a crew workspace (`details.md`, "Crew workspace").
- Another enabled plugin may ship migrations of its own; hand those to `session-start-migrations`.
- `desk_status.readiness.state` is one word (`ready`, `converging`, `degraded`, `unavailable`, `not_checked`) about the search index only. The top-level `state` decides whether Desk works: with `state: ready`, a `degraded` readiness means search falls back to direct reads, not an outage; `readiness.detail` holds the controller's own state name and diagnostic. Mention it in one line only when the work needs search.
- `active_tasks`, `open_prs`, `repo_states`, `card_validation` and `push_accounts` are the data for the status block; a push route that is not a plain direct push by gh's active account (a fork, a different account, or no account) also arrives as an instruction naming the repo, account and route, and binds every push in the session. When `active_tasks` is missing or `null`, say the listing is unavailable and why in one line; do not fall back to globbing the desk. A redacted name stays redacted: see `details.md`, "Redacted names".
- The script runs the sync itself, never streaming git's own diffstat to this session's output, so a folder another machine created with a secret's value in its name can't land here before the `active_tasks` listing hides it. To see what changed, use that listing, never `git log --stat` or `git diff --stat` on the desk.

## Step 2 — Workspace sync

The boot script already synced the workspace, so there is no sync command to run here. One check remains.

### Existing-workspace V1 upgrade branch

If `$DESK/` already exists and still shows V1 evidence (durable desk state such as task cards or the `_meta/`, `_archive/` or `artifacts/` folders, but not the V2 startup foundations and the activation-owned worker surface), do not continue into ordinary resumption. Hand off to `first-run-bootstrap` Entrance B, which upgrades the same workspace in place and never clones or creates a parallel Desk. Once `first-run-bootstrap` has completed that upgrade, later runs skip this branch.

## Judgment rules

**Desk MCP availability checkpoint.** The script reports the desk workspace; it cannot tell whether this running session can call Desk's MCP tools. Check that `desk_status` is callable at session start and again after any context-compaction resume. If it is absent, repair first without asking, and never continue silently in local-only mode: see `details.md`, "Desk MCP availability and repair". A healthy `desk_status` adds one `Desk MCP: available` line to the first reply only when something else is being said.

**First reply.** Say only what the operator needs: the open work and the one question (resume which, or start new), plus any `degraded`, `pending` or blocked item that changes what they would do. Do not print the host, user or path line, a list of checks that passed, or the raw JSON. A healthy boot with nothing to flag needs no health report. A named task skips the status block and goes straight to the resume hand-off, with any problem folded into that reply.

**Decide, don't ask.** Fix what you can fix yourself (a card's frontmatter, a repair, a tidy-up) and say so in one line. Bring the operator only a true human gate: an account or credential they must act in, a decision that is theirs, an irreversible action. The factory consent question is not one of the things to lead with: it never comes before the work the operator asked for, and never instead of it. Do the work, then raise it at most once as one short line at the end of the reply. The script emits no consent instruction in a noninteractive session (`claude -p`, a scheduled run, CI); if you are in one anyway, do not ask and do not record anything.

**Resume.** Hand a chosen task to `session-resumption`; its state machine lives in `task-lifecycle`. To start new work, follow `dual-input`. For the fuller dashboard, invoke `status`.

**More detail, only when it applies** (all in `details.md`): a V1 workspace upgrade, a crew workspace with `_meta/desks.md`, the friction backlog, the workspace MCP link, the Factory boot-line clauses, and the routing prompts for `curator` and `pr-feedback-on-own-pr`.

**Startup hook lines.** The hook may add `Desk migrations:` and `Desk boot:` lines. The script already runs Desk's own migrations and reports what is pending in `instructions`, so a `Desk migrations:` line is covered by them. A `Desk boot: workspace-tidy budget exceeded; deferred` line needs no action: the check retries at the next session start, and the line spells out an optional command to run it sooner in the background.

## Never skip

Every session runs the script, reads the desk's `AGENTS.md`, and confirms the Desk MCP. Auto-mode is license for action, not for skipping a safety check. A session doing work unrelated to the desk should not use the desk root as its working directory; a stray file dropped there is how scratch has ended up committed to a desk.
