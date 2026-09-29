# Boot-acceptance harness

Acceptance gate for the `desk-plugin/boot-in-one-call` task: boots Desk in
real, fresh, headless Claude Code sessions on Haiku, runs a fixed set of
scenarios against a synthetic fixture desk, and collects each agent's own
critique of the boot -- plus the transcript evidence to check its outcome
without trusting that self-report. Acceptance (per the task's own ruling) is
every scenario reaching the right outcome with no substantive complaint on
two consecutive rounds, judged from the transcript.

## Run it

One command runs every scenario twice and writes a summary:

```bash
node evals/boot-acceptance/run.mjs --out-dir <dir>
node evals/boot-acceptance/summarize.mjs --out-dir <dir>
```

Run from anywhere; `--worktree` defaults to this checkout (two directories up
from this file). Useful flags:

- `--scenario <id>|all` (default `all`) -- see `scenarios.mjs` for the five ids.
- `--runs <n>` (default `2`)
- `--model <name>` (default `haiku`)
- `--budget <usd>` (default `1`, passed as `--max-budget-usd` per run)
- `--shared-cache <dir>` (default `<out-dir>/.shared-runtime-cache`) -- see
  "Shared cache" below.
- `--keep-fixtures` -- don't delete the per-run fixture/HOME temp dirs
  afterward (useful when a run's outcome needs deeper investigation).

Never commit `--out-dir`'s contents: transcripts are real (if synthetic-content)
conversation records and don't belong in the repo. Write them under a scratch
or temp location instead.

## What each run does

1. Builds a fresh synthetic fixture desk (`lib.mjs`'s `materializeFixture`):
   two tracks, four tasks in varied states (`drafting`, `processing` x2,
   `blocked`), a friction log, git-initialized with `origin` set to a fresh
   local bare repo unique to that run (never shared across runs, so one
   run's push can never leak into another run's starting state). All names
   are synthetic (a fictional greenhouse-irrigation product and a fictional
   lighthouse-beacon relay product) -- nothing is copied from any real desk.
2. For the `slow-or-failing-status` scenario, points `origin` at a local
   path that doesn't exist, so session-start's sync step fails.
3. Builds an isolated `HOME` for the `claude` subprocess (see "Isolation"
   below).
4. Runs `claude -p <prompt> --model haiku --output-format stream-json
   --verbose --max-budget-usd <budget> --no-session-persistence
   --permission-mode bypassPermissions --plugin-dir <scratch plugin dir>`
   with `cwd` set to the fixture desk root.
5. Parses the stream-json transcript, runs the scenario's transcript-only
   outcome check (never the agent's self-report), and extracts the critique.
6. Writes `transcript.jsonl`, `stderr.log` (if any) and `summary.json` under
   `<out-dir>/<scenario>/run-<n>/`.

`summarize.mjs` then reads every `summary.json` and writes `SUMMARY.md`: the
outcome table, a mechanical keyword tally over the critiques (a first pass
only -- real clustering needs a human or a judge model reading the actual
text), and every critique verbatim.

## The critique turn

`--no-session-persistence` means a session cannot be `--resume`d for a
second turn, so (per the task's own instructions for exactly this case) both
turns are one `-p` call: the scenario prompt, then a fixed suffix
(`scenarios.mjs`'s `CRITIQUE_SUFFIX`) asking the agent to step back and
critique the boot once it's done with the scenario. The model still sees the
critique question before it acts -- there is no way around that with a
single call -- but the suffix is phrased as a second, later ask ("once you
have finished with the above"), matching how the two turns would read under
`--resume`.

## Isolation

**Desk root.** No `--root` flag, no `$DESK`. `cwd` is the fixture desk, which
Claude Code passes to the MCP server as `CLAUDE_PROJECT_DIR`; Desk's own root
resolver (`mcp/src/util/paths.js` `resolveDeskRootWithSource`) binds directly
to a `CLAUDE_PROJECT_DIR` that itself looks like a desk workspace
(`isDeskWorkspace`: has `_meta/` and `_archive/`) *before* it ever reads any
saved activation-config binding -- so even on a machine where the operator's
real desk is already bound, a fixture that carries `_meta/` + `_archive/`
wins the resolution outright and the real binding is never consulted.
Verified empirically: a `desk_status` call from inside a fixture run reports
`root.source: "host-project"` and `root.path` equal to the fixture path, not
the real desk.

**HOME.** Every other piece of Desk state that matters here --
`~/.claude` (Claude Code's own config/plugin cache), `~/.local/state/
ouroboros-skills` (Desk's protected state: identity cache, factory
consent/outbox, last-start records) and `~/.cache/ouroboros-skills` (the
readiness-controller cache and the downloaded runtime-dependency pack) -- is
`HOME`-relative in Desk's own code. Most of it additionally honors
`XDG_STATE_HOME`/`$DESK_RUNTIME_CACHE_DIR`, but one call site does not:
`readiness/controller-client.js`'s default `stateHome` param reads
`os.homedir()` directly with no env-var override at all (confirmed by
reading the source; the surrounding comment even names this as a known gap
from a real incident on `ourostack/desk` main, 2026-09-29, where a bare
`node --test` run wrote 34 files under a developer's real state dir). The
only override that reaches every one of these paths is `HOME` itself.

A from-scratch `HOME` breaks Claude Code's own auth on this host (`Not
logged in`, confirmed empirically) -- it resolves the login keychain at
`$HOME/Library/Keychains/login.keychain-db`. Each run's isolated `HOME`
therefore starts empty except for one symlink, `Library/Keychains` back to
the real `$HOME/Library/Keychains` (a read-only lookup path; nothing here or
in Desk ever writes to it), plus a **copy** (never a symlink, so nothing a
run does can write back) of `~/.config/gh/hosts.yml` and `config.yml` --
`gh`'s own account list, no secret material; the actual tokens stay in the
symlinked keychain. Without that copy, `gh auth status` reports "no cached
login" even with the keychain reachable, and session-start's own prereq
probe hard-stops every scenario on it -- confirmed empirically, and fixed
before any run in `baseline/` was recorded.

Verified: after a run, `find ~/.local/state/ouroboros-skills -newermt
"-N minutes"` and the equivalent under `~/.cache/ouroboros-skills` show
nothing from an isolated-HOME run (only from the ambient real session doing
the reconnaissance that shaped this harness, before isolation was in
place -- see the task's own final report for that finding). Inspecting an
isolated HOME directly after a run shows Desk's state fully materialized
*there*: `.local/state/ouroboros-skills/desk/{last-start.json,factory/,
browser/}`, `.cache/ouroboros-skills/desk/{readiness/,<version>/}`, and a
freshly-bootstrapped `.claude/`.

**Plugin loading.** `--plugin-dir` loads *the folder passed as a folder of
plugins*, not a single plugin's own folder -- pointing it at
`plugins/desk` directly loads nothing (confirmed empirically: the
`system:init` event's `mcp_servers`/`plugins` lists come back empty for
Desk). It has to be the *parent* directory. `run.mjs` builds a scratch
directory per invocation (`buildPluginDir` in `lib.mjs`) holding symlinks to
exactly `desk` plus its two declared `plugin.json` dependencies
(`superpowers`, `plain-language`) from this worktree, and nothing else --
in particular not the sibling `crew` overlay that also lives in this repo's
`plugins/` but is not a Desk dependency. Verified via the `system:init`
event: `mcp_servers` shows `plugin:desk:desk` connected and nothing else
Desk-shaped, `plugins` lists exactly `desk`, `superpowers`, `plain-language`
plus the two Claude Code builtins (`agents-md`, `telemetry`) that are always
present. A fresh, isolated `HOME` also means there is no marketplace-
installed copy of Desk to double-load in the first place -- `~/.claude/
plugins/` starts empty every run.

**GitHub.** The fixture's own git remote is a local bare repo, so ordinary
sync/push activity never reaches GitHub. The `wrong-push-account` scenario
is the one deliberate exception: its task names a real, public,
well-known repo (`anthropics/claude-code`) that the configured account
cannot push to, so an agent that looks it up makes read-only `gh` calls
(`gh pr list --repo ...`, `gh repo view ...`) against a real but unrelated
public repo. Nothing in any scenario ever pushes to GitHub, and this
harness never runs `gh auth switch`, `gh pr create`, or any other
account-mutating or repo-mutating command.

**Factory intake.** Never explicitly disabled by a flag -- there isn't one.
It's structurally off instead: a fresh fixture has no recorded factory
consent, and `desk:session-start`'s own Step 2.7 explicitly tells the agent
not to ask and not to record a consent decision in a noninteractive session
(`claude -p` matches exactly). `startFactory` (the detached delivery worker
the SessionStart hook launches) checks `hasContributingStore(env)` first and
no-ops when no store has `contribute: true` -- true for every fixture by
construction. Checked directly: no run's isolated `.local/state/
ouroboros-skills/desk/factory/outbox/*/consent` was ever written to `yes`.

**Not yet injectable.** A slow-or-hung *readiness controller* (as opposed to
the sync failure this harness injects) needs a hand-crafted owner-record
file matching `readiness/owner-record.js`'s schema, sitting under the
readiness cache directory keyed by a hash of the fixture root plus the
lexical/semantic contract in effect at boot -- doable, but not built here.
The `slow-or-failing-status` scenario instead injects a sync failure (an
`origin` that doesn't exist), which is deterministic, fast, and exercises a
real Step-2 failure path without needing to reverse-engineer that binary
format.

## Shared cache

The first boot in a brand-new `HOME` makes Desk build a runtime-dependency
pack (`node_modules` for the MCP server) under `~/.cache/ouroboros-skills/
desk/<version>/...` -- content-addressed by Desk version + platform + Node
ABI, holding only Desk's own installed code, no operator content. Rebuilding
it on every single run would be pure waste, so `--shared-cache` symlinks
each run's isolated `.cache` to one persistent directory reused across runs.
Safe to reuse indefinitely; delete it to force a clean rebuild.

## Scenarios

See `scenarios.mjs` for the exact prompts and checks. In brief:

1. `say-hi` -- bare "hi"; boot should complete without error.
2. `where-were-we` -- no task named; boot should surface the in-progress
   `watering-schedule-api` task (and ideally the others).
3. `resume-named-task` -- `resume watering-schedule-api`; boot should go
   straight to that task's own files and surface its recorded next step,
   not sweep every task card.
4. `slow-or-failing-status` -- injected sync failure; boot should degrade
   and say so, not hang or fail silently.
5. `wrong-push-account` -- the named task's only repo is real but not
   pushable by the configured account; the agent should notice before
   assuming it can deliver, and never attempt a push.

Outcome checks are transcript-only heuristics (tool calls made, specific
strings in the assistant's text), documented inline in `scenarios.mjs`.
They're a floor, not a substitute for actually reading the transcripts and
critiques when judging acceptance.
