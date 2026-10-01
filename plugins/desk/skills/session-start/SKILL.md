---
name: session-start
description: Session-start. Invoke as the FIRST thing in every agent session. Runs one script that does every mechanical startup step (migrations, host, prerequisites, sync, task index, card validation, push accounts, repo state, open PRs) and returns one JSON result with an `instructions` array to act on. Hard-stops on a genuinely missing prerequisite. If no desk is bound, hands off to `first-run-bootstrap`. If the operator names a task, hands off to `session-resumption`.
---

# Session start

One command does the mechanical startup. It is the authoritative scan; the startup hook only points at it. Run it, do what its `instructions` say, in order, and keep the judgment rules below. The `instructions` already cover the desk's `AGENTS.md`, the desk's absolute path, prerequisites, sync, task cards, push routes, the Desk MCP check, resuming a named task and the factory question, so nothing here repeats them.

## Run it

```bash
node <absolute plugin folder>/mcp/scripts/session-boot.js
node <absolute plugin folder>/mcp/scripts/session-boot.js --task "<what the operator named>"
```

The `Desk startup:` line in your context gives the exact command with the absolute path: use it as written. If that line is not in your context, the host shows this skill's base directory when it loads the skill, and the script is at `<that directory>/../../mcp/scripts/session-boot.js` (under Claude Code, `$CLAUDE_PLUGIN_ROOT/mcp/scripts/session-boot.js`); print the resolved absolute path before running it. The `Desk startup:` and `Desk boot pre-checks:` lines are pointers and quick checks, never the boot: until the script has run, say nothing about the desk's state. Use the second form when the operator's first message names the task to resume (a title, slug, `track/slug` or handle). It prints one JSON line and always exits 0; `boot_complete: true` means it finished, not that everything is healthy.

If it cannot run at all (no Node on PATH, a permissions problem), run `gh --version`, `jq --version` and `gh auth status` by hand, read the desk's `AGENTS.md`, and record the failure as friction.

## Reading the result

- `status` is one word: `ready`, `degraded` or `setup_required`. `degraded` lists why in `degraded` (work through every line first, like a compile error); `pending` lists checks the time budget did not finish (carry them, never block on them). `setup_required` means no desk is bound, so this is a first run, not an outage: follow the instruction and stop here.
- `desk_status` answers compactly with the same words in `state`, and its `search` is a separate word about the index only: with `state: ready`, a degraded `search` means search reads the files directly. Pass `{ detail: true }` only when you need the full payload.
- `active_tasks`, `open_prs`, `repo_states`, `card_validation` and `push_accounts` are the data for the status block. When `active_tasks` is `null`, say the listing is unavailable and why in one line; never glob the desk instead. A redacted name stays redacted (`details.md`, "Redacted names").
- The script syncs without streaming git's diffstat, so a folder another machine created with a secret in its name cannot land here before the listing hides it. To see what changed, use the listing, never `git log --stat` or `git diff --stat` on the desk.
- A desk the saved binding names that is missing is never replaced by another desk. A desk with task cards but no V2 foundations is a V1 workspace (Step 2 below); one with a `desks/` folder or `_meta/desks.md` is a crew workspace (`details.md`). Another plugin's migrations go to `session-start-migrations`.

## Step 2 — Workspace sync

The boot script already synced the workspace, so there is no sync command to run here. One check remains.

### Existing-workspace V1 upgrade branch

If the desk already exists and still shows V1 evidence (durable desk state such as task cards or the `_meta/`, `_archive/` or `artifacts/` folders, but not the V2 startup foundations and the activation-owned worker surface), do not continue into ordinary resumption. Hand off to `first-run-bootstrap` Entrance B, which upgrades the same workspace in place and never clones or creates a parallel Desk. Once `first-run-bootstrap` has completed that upgrade, later runs skip this branch.

## Judgment rules

**First reply.** Say only what the operator needs: the open work and the one question (resume which, or start new), plus any `degraded`, `pending` or blocked item that changes what they would do. Do not print the host, user or path line, a list of checks that passed, or the raw JSON. A healthy boot with nothing to flag needs no health report; a named task skips the status block and goes straight to its resume reply.

**Decide, don't ask.** Fix what you can fix yourself (a card's frontmatter, a repair, a tidy-up) and say so in one line. Bring the operator only a true human gate: an account or credential they must act in, a decision that is theirs, an irreversible action. The factory consent question never comes before the work the operator asked for.

**Resume.** Hand a chosen task to `session-resumption`; its state machine lives in `task-lifecycle`. To start new work, follow `dual-input`. For the fuller dashboard, invoke `status`.

**More detail, only when it applies** (all in `details.md`): the Desk MCP repair path, a crew workspace, the friction backlog, the workspace MCP link, the factory label clauses, and the routing prompts for `curator` and `pr-feedback-on-own-pr`.

**Startup hook lines.** A `Desk boot pre-checks: workspace-tidy budget exceeded; deferred` line needs no action: the check retries at the next session start. A `Desk migrations:` line is covered by the script's own migration instructions.

## Never skip

Every session runs the script and does what its instructions say. Auto-mode is license for action, not for skipping a safety check. A session doing work unrelated to the desk should not use the desk root as its working directory; a stray file dropped there is how scratch has ended up committed to a desk.
