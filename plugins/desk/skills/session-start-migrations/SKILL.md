---
name: session-start-migrations
description: Run the plugins' local-state migrations at session start (renamed folders, moved plugins, changed links), each with its safety check, and halt for a restart when one needs it. Used by `desk:session-start`.
---

# Session-start migrations

A plugin that renames its workspace folder, moves its clone or changes a link leaves older machines broken until someone notices. Each plugin can ship `migrations/<NN>-<slug>.md` files in its plugin root. At session start this skill runs each migration's `Detect` block and, for each one that fires, runs `Safety check`, `Migrate` and `Announce`, then stops for a restart when the migration needs one. It is silent when nothing is needed.

- **It lives in Desk, not an overlay,** so an overlay's own rename migration never renames the framework out from under itself.
- **Detect inspects real state** (`[ -d ~/old-dir ]`, a link's target), never a "has run" marker that a restored backup could make wrong.

Path migrations must complete before any path-dependent startup scans run, including Desk or Crew onboarding checks that assume canonical locations already exist. This skill owns stale-path repair only; if a workspace is already present at the canonical path but still needs the V1-to-V2 Desk bootstrap, `desk:session-start` routes that same workspace through `desk:first-run-bootstrap` Entrance B before ordinary resumption. Once those migrations have converged and onboarding is complete, completed onboarding is not replayed during normal resumption.

## When this skill fires

At the top of `desk:session-start`, before the boot script (whose checks assume `$DESK/` resolves) and every other scan, on every session start. A migration that already ran fails its `Detect` next time and is skipped silently.

## Migration file format

Each migration lives at `<plugin-root>/migrations/<NN>-<slug>.md`, with a two-digit `NN` and a short kebab-case slug.

### Frontmatter (YAML)

```yaml
---
id: 01-rename-workspace-dir
description: one-liner of what this migration does + when it was added
safety: safe              # only "safe" is implemented today; future values: confirm, manual
needs_restart: true       # after running, halt the session and ask operator to restart
agent_work: false         # optional; true when Migrate prints work the agent then does in this session
---
```

Field semantics:

- `id` — must match the filename stem. Used in announcements and logging.
- `description` — one line, surfaces in announcement output when something fails.
- `safety` — see the **Safety semantics** section below.
- `needs_restart` — if `true`, after a successful migration the session hard-stops with a "please restart" message. If `false`, the session continues into the next migration / normal session-start flow.
- `agent_work` — optional, `false` by default. `true` marks a migration whose work needs the agent's judgment, such as `02-tidy-desk`: its Migrate block changes nothing and prints the steps, the agent performs them in this session with the Desk tools, and the agent then sends the Announce text with its placeholders filled in (the counts, the commit link) instead of printing it verbatim. Such a migration never needs a restart and never asks the human anything; it announces what it did in one line and the session carries on. When its Migrate prints a single line and no steps (the work cannot run this session), say that line instead of the Announce text. Its blocks also read `DESK_TOOLS_ROOT` and `DESK_TOOLS_PERSON`, which the driver sets to the `root.path` and `write_scope.person` that `desk_status` reports, so the work lands on the desk the Desk tools use.

### Body: three fenced bash code blocks and a plain-text Announce

Each section is a level-2 markdown heading. `Detect`, `Safety check` and `Migrate` each hold exactly one fenced bash code block; `Announce` holds plain text.

```
## Detect
<bash that exits 0 if migration is NEEDED on this machine, non-zero otherwise>

## Safety check
<bash that exits 0 if it's SAFE to run the Migrate block right now, non-zero if not (and prints why)>

## Migrate
<bash that performs the migration; should be idempotent against partial runs>

## Announce
<plain text — the message the operator sees after the migration runs successfully>
```

The `## Announce` block is plain markdown text, not a code fence. The driver reads everything between `## Announce` and end-of-file (trimmed) and prints it verbatim. A migration whose outcome differs by machine prints a report of what it changed on stdout from Migrate; the driver shows that report first, then the Announce text, so Announce stays true on every machine.

Detect is a side-effect-free predicate, so the driver can run every Detect cheaply on every start. Safety check prints why it stopped, so a safety stop is told apart from a failed Migrate. Migrate must converge when re-run after a partial failure.

## Driver flow

1. **Find migrations in every enabled plugin root**, by reading the filesystem so it works on every host, in this order:
   - `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/` and the older `~/.claude-plugin/plugins/`;
   - `~/.copilot/plugins/`;
   - `~/.ouro-cli/plugins/` (in an Ouro agent context);
   - Agency's plugin cache: walk only the folders that `node <desk plugin>/mcp/scripts/migrations.js roots` prints (add `--engine <prefix>` for a host other than Copilot). Agency keeps old fetches under `~/.local/agency/plugins/cache/entries/`, so walking it blindly finds stale copies. The command reads `~/.local/agency/plugins/cache/cache_index.json` (`entries[spec].dir_name` and `fetched_at`), keeps specs for the running engine (`copilot:`), skips Desk's own plugin, and for each plugin takes the entry with the newest `fetched_at` that has a `migrations/` folder; an unreadable index prints nothing;
   - `~/code/<plugin-id>/` and `~/code/<plugin-id>.ouro/`, for plugin authors' local clones;
   - any root a host's plugin-list command reports.

   Every `*.md` in a root's `migrations/` folder is a candidate. Dedupe by absolute path, then dedupe by migration `id` (the first root in the order above wins). Sort all of them by leaf filename, so `NN` orders migrations across plugins.

2. **For each migration in that order**, parse the frontmatter and blocks and run every block with `DESK_PLUGIN_ROOT` set to the plugin's root and, once `desk_status` answers, `DESK_TOOLS_ROOT` and `DESK_TOOLS_PERSON` set to its `root.path` and `write_scope.person` (empty when none). An `agent_work: true` migration waits until the desk is synced and bound; the boot names it in its `instructions`.
   - **Detect:** exit 0 means needed; anything else skips silently.
   - **Safety check:** on non-zero, show its reason and stop: run neither Migrate nor any later migration.
   - **Migrate:** on non-zero, show its output and stop with "Migration `<id>` failed mid-run; manual intervention needed".
   - On success, show Migrate's output, then the Announce text (for agent work, do the printed work, then send the Announce text with its placeholders filled in).
   - If `needs_restart: true`, stop after the announcement and say: "Please start a new session so my preamble loads against the migrated paths." On several hosts, each host runs its own pass.

3. **Then** continue with `desk:session-start`.

## Desk's own migrations at startup

Desk does not leave its own migrations to this skill being followed: a session that skipped the skill once skipped the one-time tidy with it. Both startup hooks run the Detect block of every migration in Desk's own `migrations/` folder themselves, in id order, within a 2-second budget, and add exactly one line to the startup context, addressed to the agent, when anything is pending. With nothing pending they add nothing. The code is `mcp/src/runtime/pending-migrations.js`.

- **`agent_work: true`** (the tidy): the line names the migration and the command that prints its work, `node <desk plugin>/mcp/scripts/migrations.js run <id> --tools-root <root.path> --tools-person <write_scope.person>`, with both values from `desk_status` (leave `--tools-person` out when it reports none). Run it and do what it prints, in this session and without asking. The line returns at every session start until Detect stops firing.
- **held**: a Detect that does not fire but prints `held: <reason>` names a migration that is pending but cannot make progress now. The line gives the reason and asks for nothing; mention it to the human in one line if it matters to them. For the tidy this means another session holds its claim (only one session tidies a desk at a time, and a claim lapses after 30 minutes), or the tidy stopped for a reason that has not changed: no person resolves on a crew desk, the Desk tools and the tidy resolve different desks, Git is mid-merge, or the agent ran the tidy's `--defer` command because it could not finish. That hold lifts when its state changes (the roster or identity, the merge, or the desk's latest commit and uncommitted changes) or after 7 days. The claim and the hold live in the desk repository's Git folder; the code is `mcp/src/desk/tidy.js`.
- **`safety: safe`, `needs_restart: false`, no agent work**: the hook runs Safety check and Migrate itself, and the line gives the announcement to relay to the human in one line.
- **`needs_restart: true`**: the hook cannot restart the session, so the line tells the agent to run the command right away, before other work and whether or not anyone is watching — it completes on its own, with no human needed to run it. Once it is done, show the human what it printed and ask them to start a new session; with no human in this session, just say a restart is needed and move on.
- **anything else** (a safety other than `safe`, a Safety check that stops it, a Migrate that fails, a block that runs out of time): the line gives the command, so the agent runs it and sees why.

`migrations.js run <id>` follows the driver flow above for that one migration, and prints everything the migration prints, however long: it prints that nothing is needed when Detect does not fire (or the hold's reason when it is held), the Safety check's reason when it stops, Migrate's output, and then the Announce text (as the template to fill in, after an agent-work migration's steps). The Detect blocks run in the hook without `DESK_TOOLS_ROOT` or `DESK_TOOLS_PERSON`: each resolves the desk and person the way the Desk MCP does. A host without `bash` gets no line, and this skill remains the way to run migrations there. Other plugins' migrations are still found and run only through this skill.

## Safety semantics

Only `safety: safe` (run and announce) is implemented. For `confirm` or `manual`, say in one line that migration `<id>` needs a safety mode that is not implemented, skip it and continue.

## Ordering and scope

Plugins coordinate global order only through the `NN` they choose; there is no registry. Past 99 migrations, everyone moves to a three-digit prefix. Each machine migrates its own state; nothing is shared between machines, nothing is previewed (a migration that passes Detect and Safety check runs), and a plugin without a `migrations/` folder is fine. Migrations should be idempotent and reversible where possible, for example `mv` rather than delete and recreate.

## Adding a migration

See the `README.md` beside this skill. In short: add `migrations/<NN>-<slug>.md` to your plugin root with the four sections, pick the next free `NN` across active plugins, and mark a path-rename migration `safety: safe` and `needs_restart: true`.
