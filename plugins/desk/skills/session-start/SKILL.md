---
name: session-start
description: Session-start checklist. Invoke as the FIRST thing in every agent session — runs the boot script (host identity, prerequisites — gh binary + version floor + auth state, jq; workspace sync; the active-task index; task-card frontmatter validation; push-account resolution) in one call, then scans for active tasks and emits a one-screen status block. Hard-stops on prereq failures; does NOT silently fall through to local-only operation. If `$DESK/` doesn't exist, hands off to `first-run-bootstrap`. If the operator picks a task to resume, hands off to `session-resumption`.
---

# Session start

sitting down at the desk. the first thing every session — turn on the lamp, check the tools are where they were left, see what's still open across the drawers, surface it for the operator. the prereq probe has teeth: a real miss is a hard stop, not a hint to route around.

This skill is the authoritative owner of migration ordering, workspace sync, task discovery, and resumption routing. The startup hook never performs a partial duplicate scan; it injects the Desk foundation, points here, and checks Desk's own migrations (see Step 0.5).

> **overlay users**: consumer overlays may extend session-start with their own identity-resolve, work-item-tracker staleness probes, and additional PR fan-out steps. this skill stays generic.

## Step 0 — Host identity probe

before touching anything — before prereq checks, before sync, before scanning the drawers — figure out where this desk is sitting. the substrate is increasingly spread across multiple hosts (local mac, headless VM, remote fleet members), and an agent that doesn't know which room it's in will commit to the wrong workspace, reach for tooling that isn't on this host, propose actions appropriate for some other machine, or miss the host-specific recovery the operator actually needs.

run a minimal identity probe in the first tool call of the session. use the variant matching the host shell:

**POSIX shells (macOS, Linux, WSL, Git Bash):**

```bash
hostname && pwd && whoami && uname -s
```

**Windows PowerShell:**

```powershell
hostname; (Get-Location).Path; whoami; [System.Environment]::OSVersion.Platform
```

both shells: just run it. four commands, idempotent — re-running is cheap. don't try to short-circuit by "checking if probe already ran" before any tool call; the check is harder than the probe itself. Step 0.75's boot script reports this same identity again, in its `host` field — that is redundant confirmation, not a second probe to act on.

then write the result to durable state, **but only when the host has changed** — repeating an unchanged host's identity every session is exactly the kind of boot-line noise this skill otherwise works to cut. persistence precedence:

- **if a task card exists**, and its own "Host context" line (if any) names a different `hostname` than this probe just found, updating it is **mandatory**: add or replace the line with ``Host: `<hostname>` / user: `<user>` / cwd: `<pwd>` / OS: `<os>` / probed: <timestamp>``. chat scrollback is ephemeral from the perspective of a future session resuming this task; the task card is what survives, so that's where the host context belongs. an unchanged hostname writes nothing.
- **if no task card exists** (fresh session, nothing picked yet), open the first chat message with a one-line "Running on `<hostname>` as `<user>` in `<pwd>`, OS `<os>`." visible to the operator from turn one, **only** the first time this session sees this host; a session that already said so, or resumes on the same host a task card already recorded, does not repeat it.
- **both** is fine — chat lead + task-card preamble together — but the task card is what carries across sessions.

applies to ANY agent using this skill — worker, ccatester, investigator, triage, future fleet agents. single-host setups still benefit (the probe is fast and silent on the happy path), but the cost-of-omission climbs as host count grows.

## Step 0.25 — Read the desk's AGENTS.md

right after the host probe, read `AGENTS.md` at the root of the bound desk: the root the `Desk startup:` line names, or the root `desk_status` reports when they differ. do it before the first question to the operator or action on the desk, including the migrations in Step 0.5. that file is the desk's own interaction contract (for example, which question formats to avoid, which calls the agent makes itself, and what counts as a human gate), and it binds the session from its first move, not from whenever a later step happens to open it. treat its rules as binding for the whole session, alongside this plugin's skills. when the file is absent, or no desk is bound, stay silent and go on.

say so in one line, in the first message to the operator:

> Read `$DESK/AGENTS.md`; its rules bind this session.

if Step 2's sync changed it, read it again before Step 2.7 or any later question.

## Step 0.5 — Auto-heal migrations

before any path-dependent work — before the prereq probe, before sync, before scans — hand off to the `session-start-migrations` skill. it walks every enabled plugin's `migrations/` dir, runs each migration's Detect predicate, and (for the ones that fire) runs Safety/Migrate/Announce. if any migration with `needs_restart: true` runs successfully, the skill hard-stops the session with a "please restart" message; the operator restarts and the next session opens against canonical paths.

why here, not later: most later steps assume `$DESK/` already points at the right place. if the machine is still on a pre-migration name (an old workspace dir that's since been renamed), running Step 0.75's boot script first would either fail confusingly or — worse — quietly operate against stale state. migrations run first, restart, everything downstream resolves cleanly.

on a machine with no pending migrations (the common case) this step is a few cheap Detect bash exits and returns immediately.

a migration marked `agent_work: true` (such as `02-tidy-desk`, the one-time desk tidy) is the exception: it writes to the desk, so it runs after Step 2.6 instead, once the workspace is synced and this session's own desk is known.

Desk's own migrations do not wait on this step: the startup hook runs their Detect blocks itself and adds one `Desk migrations:` line to the startup context when one is pending (`session-start-migrations` owns what that line says). When the startup context has that line, do what it says in this session; it is part of starting the session, not a suggestion.

## Step 0.75 — Run the boot script, then confirm Desk MCP availability

right after Step 0.5's migrations settle — never before, since a stale pre-migration `$DESK/` could otherwise get scanned or synced under the wrong path — run the boot script. it replaces what used to be a chain of separate steps the agent re-derived and re-ran by hand each session: a five-part prerequisite probe, the workspace sync, the active-task index, task-card frontmatter validation, and per-task-repo push-account resolution. one call, one JSON result, so nothing downstream re-derives or re-runs what it already answered.

```bash
node <Desk plugin folder>/mcp/scripts/session-boot.js
```

`<Desk plugin folder>` is two levels above this skill's folder. it prints one line of JSON and always exits 0 — a boot script must never block session start on its own crash. `boot_complete: true` always appears in that line; it marks that the script finished and returned a complete result, not that everything it found is healthy. read:

- **`status`** — one word: `"ready"`, `"degraded"` or `"setup_required"`. never two contradictory state words (a slow readiness-convergence check must never report something that disagrees with what just ran) — act on this one field.
- **`degraded`** — why, one line per problem. work through every one before treating startup as healthy; a session with broken auth isn't "offline mode," it's "not-yet-ready" — don't fall back to local-only operation.
- **`pending`** — checks the wall-clock budget didn't let finish (a slow auth check, a push-account store past the deadline). not a failure; carry it into the Step 5 status block, don't block on it.
- **`actions`** — concrete next steps, each naming the task, repo or file it is about. surface these to the operator instead of re-deriving your own remediation prose.
- **`root`**, **`host`**, **`desk_export_line`** — the resolved desk and this host's identity (hostname, user, cwd, platform, probed timestamp); export the line so later shell calls in this session see `$DESK`. `host` reports the same identity Step 0 already probed — redundant confirmation, not a second write.
- **`prereqs`** — `gh` binary present, `gh` version floor (2.40 — `gh auth switch -u <user>`, used by any workflow disambiguating cached GitHub accounts, landed there; older gh silently drops the flag and a push can leak under the wrong account), `jq` present, and `gh auth status` actually healthy (a cached-but-expired token fails every later `gh` call with a confusing 401/403). a Windows host missing `winget` on PATH is a known false "missing" reading — `WindowsApps` not on the current user's PATH for a templated admin-base image — diagnose with `Get-AppxPackage Microsoft.DesktopAppInstaller`, `Test-Path "$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe"`, and `$env:Path -split ';' | Select-String WindowsApps` before recommending a reinstall.
- **`sync`** — the workspace-sync result: **synced** (the ordinary case), **quarantined** (a dirty index blocked the pull; every stray untracked path moved, never deleted, to `_cache/stray-<date>/`, then the pull retried and succeeded), or **unresolved** (a genuine conflict, or the retry still failed — read `git status` in the desk before making further changes there). the script runs the pull itself, never streaming git's own diffstat to this session's output, so a folder another machine created with a secret's value in its name can't land here before Step 3 hides it; to see what changed, use the Step 3 listing, never `git log --stat` or `git diff --stat` on the desk.
- **`active_tasks`** — the cheap, filesystem-only task index Step 3 reads. never the slow runtime status, so it is never blocked behind readiness convergence.
- **`card_validation`** — every task card whose frontmatter is malformed (a missing or non-string required field, an unrecognized `status`, an unparseable timestamp, a malformed `repos[]` entry, or the numeric-string-keyed-object corruption pattern a card can pick up from a bad write), named by redacted track/slug/desk and a stable handle, with the specific problem spelled out — never a bare "N cards have problems" count. surface these in the Step 3 listing; fix a card's frontmatter through its `handle`, the same discipline Step 3 already uses for a redacted name.
- **`push_accounts`** — the push-capable GitHub account for every repo of every open task, reusing the same per-store, per-signed-in-account resolution Step 2.7 uses for the factory account: it asks each account's own token, never assumes `gh`'s active account. `no_account_can_deliver` means do not push there — ask the operator which account to use, or fork.
- **`factory`** — the same factory-consent context Step 2.7 reads via `desk_status`.

`status: "setup_required"` means no desk is bound yet: this is a first run, not an outage. follow the action the script names (hand off to the onboarding path `desk_status` names in `onboarding_skill` — `desk:first-run-bootstrap` Entrance A by default, or an overlay's own path such as `crew:join-crew`) and skip the rest of this step and Step 2. do not present the fix/continue decision below — a missing desk is fixed by finding or creating the desk, and Desk keeps running in setup mode until then.

`status: "degraded"` with a root problem (`desk_status` would report `degraded:root_unavailable`) means the folder that `--root`, the saved binding or `$DESK` names is missing or unreadable, and Desk deliberately binds no other desk: the script's own `actions` line already names the configured path and the fix (restore or clone the desk there, or, with the operator's agreement, rebind through `desk:first-run-bootstrap`); never work around it by pointing `$DESK` at a different desk. Desk upgrades to ready in the same session once the folder exists. any other `degraded` entry (a prereq or sync failure) is like a compile error: work through it before treating this session as ready.

if the boot script itself fails to run at all (no Node on PATH, a permissions problem) — the rare exception the script cannot report on itself — fall back to running `gh --version`, `jq --version`, and `gh auth status` by hand, and record the failure as friction.

**named-task short path**: if the operator's own first message already names the task to resume (a title, a slug, or an unambiguous handle), still run the boot script exactly as above — every check still applies, a named task is not license to skip a prereq or sync problem — but skip presenting the full status block before acting: fold `status`/`degraded`/`actions` straight into the reply that hands off to `session-resumption`, and let that skill's own resume flow carry the rest. a named task is license to skip only the "which one?" prompt.

**workspace-tidy budget exceeded, deferred**: the startup hook may append a `Desk boot: workspace-tidy budget exceeded; deferred to the next session start automatically, no agent action needed; to run it sooner: node <hook path> --repair <desk_status root>` line, separate from the boot script's own JSON. it means the hook's own background tidy check hit its wall-clock budget before finishing. no agent action is required: the check retries automatically at the next session start. to run it sooner, use the command the line itself spells out, filling in the `root` the boot script (or `desk_status`) reports; it is optional and best-effort, so run it in the background and never let it block this session.

**Desk MCP availability checkpoint.** now, before treating session-start as healthy, check whether the active host session exposes the Desk MCP tool surface. this is a distinct concern from the boot script's own `status`: the boot script reports the desk *workspace's* state, while this checks whether *this running session* can reach Desk's MCP tools at all. this applies to every agent built on `desk:worker`, including downstream overlays like `ms-desk` and area-specific workers. overlays may add their own MCP checks, but they inherit this substrate check rather than re-implementing it.

re-run this check after a context-compaction resume, not only at the very first message of a session: compaction can restart the host process or reload tools, so a tool surface confirmed available before compaction is not guaranteed to still be available after — treat a fresh resume the same as a fresh session for this one check, even mid-task.

the minimum sentinel is `desk_status`. if the host exposes an active tool list, look for `desk_status` or the Desk MCP namespace. if the host does not expose a tool-list API, infer from the callable tools available in the current session. this is an active-session check: repo source and plugin cache can both be current while this running agent still lacks the MCP because the host has not reloaded or the MCP failed to launch.

when `desk_status` is callable:
- call it once.
- if it reports healthy/fresh state, include `Desk MCP: available` in the session-start status block.
- if it reports degraded state (missing/stale DB, lexical index, vector coverage, runtime pack, snapshot, or embedding endpoint), include a concise `Desk MCP: degraded` line with the `desk_status` guidance. degraded is not the same as absent: the agent can still use MCP-backed CRUD/status and can repair via `desk_reindex`, runtime-pack verification, snapshot/vector-pack import, or embedding/Ollama checks.

when `desk_status` or the Desk MCP namespace is absent:
- do **not** silently continue in local-only mode.
- explain the impact in plain language: Desk MCP is the structured access path for task/track CRUD, durable status, friction/lesson writes, search/recall/timeline/thread queries, reindexing, snapshots, and vector-pack health. without it, a desk-based agent can still use shell/file/git tools, but durable task lifecycle updates, historical recall, cross-session resumption, and shared-worker continuity are weaker and easier to fork.
- repair first, without asking: an unavailable Desk MCP reads as broken, so leaving it off is the last resort. check that the Desk plugin is enabled and loaded for this host, run `desk_doctor` if any Desk tool responds, and apply the host repair path — `codex-onboarding` under Codex; under Claude Code, `claude plugin list` to confirm `desk@<marketplace>` is installed and enabled, `claude plugin install desk@<marketplace>` or enable it if not, then `/reload-plugins` or a fresh session because MCP servers load at session start.
- only when repair needs something the operator must do (a restart, a reinstall they have not authorized) present exactly one decision group:

```text
Desk MCP is not available in this session. Want me to fix/reload it now, or continue without Desk MCP and stop reminding you?

- Fix Desk MCP now: I will run the host repair path (`codex-onboarding` when available, otherwise the host checklist) and may ask you to restart/open a fresh session if the host needs to reload tools.
- Continue without reminders: I will mute generic Desk MCP absence reminders. I will still mention the limitation if you ask for something that specifically needs MCP-backed desk search, task CRUD, reindexing, or durable friction/lesson writes.
```

if the operator chooses **Fix Desk MCP now**, route to `codex-onboarding` under Codex and to the Claude Code steps above under Claude. otherwise surface the host repair checklist for plugin enablement, activation-owned MCP bridge, runtime-pack health, and fresh-session reload. if repair requires a restart, stop after explaining the exact restart/reopen step; do not keep working as if the MCP is healthy.

if the operator chooses **Continue without reminders**, honor the mute for the rest of the session. if they explicitly ask for a durable no-reminder preference, record it in `$DESK/AGENTS.md` as an operator preference so future worker-based agents inherit it across machines. do not silently switch the activation to `manual-only`: explain that durable manual-only mode disables default worker/MCP autostart, while a reminder mute only suppresses the generic warning.

## Step 2 — Workspace sync

Step 0.75's boot script already resolved the desk and synced it — see `sync` in its result, described there. by this point in the skill, status was already `"ready"`; a `"setup_required"` result would already have handed off to `first-run-bootstrap` Entrance A and ended session-start before this step, so this step never itself has to check whether a desk is bound or run its own sync command.

### Existing-workspace V1 upgrade branch

If `$DESK/` already exists and the workspace still shows V1 evidence instead of an already-migrated V2 Desk, do not continue straight into ordinary sync and resumption. Ground that decision in existing Desk layout and activation evidence: durable Desk state is already present in the documented workspace layout (for example task cards or system directories such as `_meta/`, `_archive/`, or `artifacts/`), but the V2 startup foundations and activation-owned worker surface described in `plugins/desk/README.md` and `desk:codex-onboarding` are not yet in place. In that case, hand off to `first-run-bootstrap` Entrance B so it inventories and upgrades the same workspace in place, preserves the same workspace, and avoids cloning or creating a parallel Desk. Once that same workspace has completed the V1-to-V2 upgrade, later session-start runs skip this branch and continue with ordinary sync + scan.

a session doing work unrelated to the desk — a different tool, a different repo, a one-off script — should not use the desk root as its working directory; a stray file dropped there by an unrelated tool session is exactly how loose scratch content has ended up committed to a desk before.

## Step 2.6 — Desk-registry awareness (shared-workspace mode)

after sync, check whether this workspace carries a committed desk registry: `$DESK/_meta/desks.md`. **default-tolerant — absent → behave exactly as today (single-desk, no shared-workspace awareness).** the file is plain markdown that travels with the repo (no machine-local fork), so reading it is a cheap existence-check + parse.

```bash
test -f "$DESK/_meta/desks.md" && cat "$DESK/_meta/desks.md"
```

the file makes this a crew workspace only when it holds the crew roster: the table below, whose header names both `alias` and `identity`. then the roster tells the agent two things:

1. **the desk-set** — every desk this workspace knows about (the operator's own, plus any peers' desks in a shared crew repo). surface the count in the Step 5 status block ("crew workspace: N desks — alex, bob, …").
2. **"which desk am I"** — resolve the session's home desk by matching the operator's **identity** (not a re-derived handle) against the registry rows. derive the identity once (cheap, deterministic — for org-backed crews, the SSO account `login`), find the row whose `identity` column equals it, and **that row's `alias` is the home desk** — its `write_subtree` is where this session's writes land (`desks/<alias>/`), and that alias is what the desk MCP's `--person` should be set to. **Match on identity, not on a handle re-derived from the identity** — the chosen handle (`alex`) need not be a transform of the identity (`agarcia_corp`), so re-deriving a handle each session can disagree with the registry and silently bind to the wrong desk. if no `--person` is set (OFF mode), the agent writes at the workspace root as today, and the registry is read-only context.

### `_meta/desks.md` schema

one table, one row per desk. keep it human-readable — a non-agent teammate must be able to read it as plain markdown:

```markdown
# Desks

| alias | identity | path | repo | worker_variant | write_subtree |
|-------|----------|------|------|----------------|---------------|
| alex  | agarcia_corp  | desks/alex | example-org/crew-workspace | crew | desks/alex |
| bob   | bsmith   | desks/bob  | example-org/crew-workspace | crew | desks/bob |
```

- **alias** — the operator's short **chosen handle** (`alex`, `bob`). It is NOT necessarily a mechanical transform of the identity — it's whatever short name the operator picked for their desk. The registry is the **source of truth** for the identity→alias binding; the match (below) happens here, not by re-deriving a handle from the identity string each session.
- **identity** — the stable account identity the desk belongs to (for org-backed crews, the SSO account `login`, e.g. `agarcia_corp`). The "which desk am I" step keys off this column: derive the session's identity, find the row whose `identity` equals it, use that row's `alias`. This is what lets a chosen handle (`alex`) diverge from its identity (`agarcia_corp`) without binding the wrong desk. A consumer may pick a *default* handle for a brand-new identity (e.g. by transforming the login) to seed the first row — but once the row exists, the recorded `alias` wins. Optional for a single-OFF-mode desk; effectively required for a shared crew repo where chosen handles diverge from identities.
- **path** — the desk's subtree within this workspace repo (`desks/<alias>`), OR an absolute/`~`-tilde path for a desk that lives in a *different* repo (a multi-desk operator whose personal desk is a separate clone).
- **repo** — the git repo the desk lives in (so a personal `worker` can route "that lives in the crew repo" and read the right clone).
- **worker_variant** — which worker overlay is bound to this desk (`worker` for a plain personal desk, `crew` / a crew variant for a shared crew desk).
- **write_subtree** — the path prefix this desk's agent scopes its writes to. equals `path` for an in-repo person desk; for a single-desk OFF-mode workspace there is no crew roster, so this column never describes the workspace root.

a single-owner OFF-mode desk has **no crew roster**: either no `_meta/desks.md` at all, or one that holds something else, such as a hub's cross-desk routing registry (its own "Solo desks" and "Crew desks" tables) or a spoke desk's pointer to its hub. either way, when the workspace has no `desks/` folder, it is a single desk: behave as today, and read a hub's registry as routing context only. don't synthesize a roster; don't warn about its absence. the exception fails closed: a `desks/` folder with no roster, or a `_meta/desks.md` that cannot be read, is treated as a crew workspace whose person cannot be resolved, so nothing is written at the workspace root until a roster names this session's desk.

### remap-tolerance note

`desks/<alias>/**/task.md` globs already match nested paths, so Step 3's active-task scan picks up person-scoped task cards without change — this step only adds the *awareness* layer (the desk-set + which-desk-am-I framing). the scan itself is remap-transparent.

### agent-work migrations

now that the workspace is synced and this session's own desk is known, run the `agent_work: true` migrations that Step 0.5 deferred. for each one the startup context's `Desk migrations:` line names, run the command it gives with the `root.path` and `write_scope.person` that `desk_status` reports; for another plugin's, go through `session-start-migrations` with `DESK_TOOLS_ROOT` and `DESK_TOOLS_PERSON` set to the same values. `02-tidy-desk` is the one today: when it is pending, tidy your own desk as its steps say, announce it in one line and carry on without waiting.

## Step 2.7 — Factory contribution: ask once

Desk can contribute measurement data about finished tasks to a factory store, which builds a report for each finished job. Each desk reports to one store, and this machine records one decision per store.

Check `factory` in the `desk_status` result. Ask only when `factory.consent` is `undecided`; the startup hook's `Desk boot:` line says the desk hasn't decided in exactly that case, because both read the decision with the same code. A recorded decision is never asked again: for `yes` or `no`, say nothing. `held` means no store is resolved for this desk, so there is nothing to ask, and the boot line does not ask either. `unreadable` is a `desk_doctor` finding to report, not a question.

Before asking, find the GitHub account that would open the intake pull requests. Never assume gh's active account: it may be a work account that cannot open pull requests on the store. Run the Desk factory CLI (the same one the recording commands below use), which asks GitHub about the store with each signed-in account's own token:

```bash
node <Desk plugin folder>/mcp/scripts/factory.js account --store <store>
```

With `result: account_found`, `account` is the `<login>` to name. With `no_account_can_deliver`, do not ask: tell the operator in one line that no signed-in GitHub account can open pull requests on `<store>`, with each account's `reason` (`managed_account` is an Enterprise Managed User account, which cannot open pull requests outside its enterprise; `store_not_visible`, `auth_failed`, `forking_disabled`), and that signing in a personal account with `gh auth login` lets the next session ask. Any other `result` is a GitHub or `gh` problem to report the same way; ask in a later session. Then ask once, as its own decision group in the Step 5 message, naming the store from `factory.store`:

> Desk can contribute measurement data about your finished tasks to `<store>`, which builds a report for each finished job. What it publishes: durations, counts, tool kinds, plugin and model versions, and references to public repositories. What it never publishes: prompt, assistant or tool content, names, or dates and times of day. `<store>` is a public repository, and your GitHub account `<login>` appears as the author of the intake pull requests that deliver the data. Contribute? (yes or no)

Record the answer, yes or no, with the Desk factory CLI in the Desk plugin folder (two levels above this skill's folder):

```bash
node <Desk plugin folder>/mcp/scripts/factory.js consent --store <store> --contribute yes --account <login>
node <Desk plugin folder>/mcp/scripts/factory.js consent --store <store> --contribute no
```

`no` is a decision too: it is recorded, nothing is collected for that store, and the question is not asked again. The operator can change the decision later by running the same command with the other answer. Record consent only through this command.

In a noninteractive session, such as `claude -p`, a scheduled run or a subagent with no operator in the conversation, do not ask and do not record anything. The next interactive session asks. Never hold up the rest of session-start for the answer.

## Step 3 — Scan for active tasks

build the status block from the `active_tasks` field of the boot script's result (Step 0.75 already called it; call `desk_status` again if the tasks may have changed since), never from a glob or a folder listing. it lists the non-terminal tasks (NOT `done`, NOT `cancelled`), grouped by track, newest `updated` first, skipping `_archive/`. this is the look across the drawers to see what's still open. **in a shared crew workspace** (crew roster present from Step 2.6), it also lists every `desks/<alias>/` subtree with each task's `desk` — surface peers' open tasks as theirs, and this session's own desk first. every task and track carries a `handle`.

**surface `card_validation` and `push_accounts` findings here too**, not as a separate pass: a task with a `card_validation` entry gets a short problem note next to its listing (the specific defect, not a bare count); a task whose `push_accounts` resolution came back `no_account_can_deliver` gets a short note naming the repo and that no signed-in account can push there. both come from Step 0.75's boot result — don't re-derive either by re-reading cards or re-running `gh` by hand.

**never repeat a redacted name.** a folder name can carry a secret's value (a task folder named after a prompt that held a password), and the status block reaches the chat and the transcript. the listing shows such a track, task or desk name as `<redacted segment>` and such a title as `<redacted title>`, and counts them under `redacted`. show the marker as it is, with the task's `handle` so the operator can tell two redacted tasks apart; do not open the card or list the folder to recover the name, and do not quote it in any later step. to resume or rename such a task, act on it by its handle: `task_move` with `handle` and an outcome `to_slug` (a track: `track_rename` with `handle` and `to`), then use the new name. when `redacted` is non-zero, rename those in your own desk that way as ordinary tidying (build the new name from the task's status, repos and the work you know about, never from the old name), and add one line after the status block: "N names hidden because they looked like they contained a secret's value; I renamed them to outcome names." when `active_tasks` is missing or `null` (Desk is still starting, or the root is not valid), say the listing is unavailable and why in one line; do not fall back to globbing the desk.

## Step 4 — Scan code repos

for each locally-cloned repo in the `repos` of an `active_tasks` entry, run `git fetch --quiet origin` and note current branch + dirty state. don't block on this — it just informs the status output.

## Step 4.5 — Fan PR lookups across every `repos[]` on every non-terminal task

for every non-terminal task in `active_tasks`, iterate every entry in its `repos` — not just the entry whose PR ID is already cached in the task's frontmatter. a task that lists `OrderService` + `OrderUI` in `repos[]` may have an active PR on either; session-start needs to surface both.

for each GitHub repo entry:

```bash
gh pr list --repo <org>/<repo> --author @me --state open --json number,title,url,isDraft
```

(overlay users: non-GitHub work-item trackers use their own REST endpoints instead — consumer overlays extend this step.)

for each PR surfaced:
- if the PR has unresolved (Active) review threads from humans or an AI reviewer → flag for the pr-feedback-on-own-pr routing prompt in step 5.
- cache PR metadata in the task-scan output so step 5 can render it without a re-fetch.

## Step 4.6 — Friction-backlog scan

while scanning active tracks, count the open `_friction/*.md` entries (exclude `_friction/_archive/`) — the cards pinned to the corkboard, still asking for attention. if the count is non-zero on any active track, flag for the curator routing prompt in step 5.

## Step 4.7 — Workspace MCP link check (consumer-engine-specific)

if the operator's runtime supports a workspace-level MCP config file discovered by walk-up from CWD (e.g. an `<runtime>.toml` at the workspace root), this step is where to ensure the discovery link from `$HOME` to the workspace file exists. the mechanism is engine-specific — see the relevant consumer overlay's session-start extension for the exact file name, link primitives (symlink / hardlink / copy), and platform-aware decision tree.

the substrate's contribution at this step is just the slot: every session, check whether the workspace MCP config is reachable from `$HOME`, repair if not, and announce link state if anything changed. on a fresh-cloned machine this lands the discovery link once and is silent thereafter. on a known-good machine this is a single cheap existence check.

if the runtime does not support walked-up workspace MCP discovery, this step is a no-op.

## Step 4.8 — Factory boot lines

the session-start hook appends at most one `Desk boot:` line, addressed to you; its clauses are separated by `; `. this step owns what the `Factory:` clauses about waste labels and andon ask, and how to handle an answer from the waste evaluator's `evaluate` command, whether it ran here or from `desk:task-lifecycle`'s done step. no such clause → nothing to do.

`<Desk plugin folder>` below is two levels above this skill's folder; run the commands from it.

- **`Factory: N finished tasks have no waste labels yet; run the evaluator for them in the background`** → the hook has already started a detached `evaluate --pending` that prepares briefs, but only you can start evaluators. run `node <Desk plugin folder>/mcp/scripts/factory.js evaluate --pending` and handle each job in its `jobs` answer as below. don't wait for the evaluators before continuing.
- **`Factory: N finished tasks have quarantined waste labels that will not be delivered; tell the operator (desk:session-start)`** → say so in one line of the Step 5 status block. there is nothing to run: labels are quarantined when the factory store refused them or when their session's facts were quarantined (a `facts_quarantined` record names those facts), under `quarantine/<store-slug>/labels/` in the protected factory state.
- **`Factory: N open andon issues in <store> (#…); a release made a quality measure clearly worse, and the kaizen worker handles it before any other card (desk:curator)`** → the start-time refresh found open andon issues for plugins that store tracks. say so in one line of the Step 5 status block and offer a `curator` pass, which handles them first. nothing runs on its own.

**handling an `evaluate` answer**, per job:

- `ready` → start a fresh `desk:observer` subagent in the background whose whole prompt is: "Label the waste in these evaluator briefs with `desk:factory-evaluator`: <that job's `briefs` paths>." give it nothing else from this conversation; the evaluator must not see the working agent's context. one observer per job, with only that job's paths.
- `no_sessions` → the finishing session is not derived yet. the request stays, and a later `evaluate --pending` picks it up.
- `complete` → every session has labels, or has them held back because its facts are quarantined. nothing to do.
- `not_opted_in` or `expired` → no evaluator.

a missing or failed evaluation never reopens a task, and `done` never waits for it.

## Step 5 — Emit status + ask

**first-reply content discipline**: the first reply is this concise status block, not a dump of the boot script's raw JSON and not an enumeration of every prereq that passed. surface only non-default state — the `degraded` and `pending` lists (when non-empty), any `card_validation` or `push_accounts` problem, and the status block itself — and fold a `setup_required` or `degraded` boot result straight into the reply that names the fix, rather than printing the field names the script used internally. a healthy `ready` boot with nothing pending needs no separate mention beyond the status block below; the operator asked to sit down at the desk, not to read a health-check transcript.

concise status block, then an open prompt:

```
N active tasks across M tracks. Uncommitted changes in K repos.

<track-name>/
  <task-slug>    <status>    updated <X ago>
  ...

resume one, or start new?
```

**shared-workspace addendum** (only when a `_meta/desks.md` registry was found in Step 2.6): prepend a one-line desk-set banner so the operator sees which crew desk they're sitting at and who else is in the repo:

```
crew workspace: P desks (you: <alias> → desks/<alias>) · peers: <a>, <b>
```

omit this line entirely in single-desk (OFF) mode — no crew roster, no banner, byte-identical to today's output.

if the operator picks a task to resume → hand off to the `session-resumption` skill. if the operator says "start new" → follow the `dual-input` skill. if the operator wants the fuller dashboard → invoke the `status` skill.

### Skill-routing prompts

after the status block, offer skill routing if the signals from steps 4.5 and 4.6 fire. both prompts are engine-agnostic prose the agent presents; the operator picks. the prompts exist because `curator` and `pr-feedback-on-own-pr` are gated by explicit operator phrasing in their `description:` frontmatter — they won't auto-fire from ambient conversation, so this skill surfaces them when signals warrant.

- **Curator routing** (from step 4.6): if open `_friction/` cards exist on any active track, surface:
  > "I see N open friction cards across tracks [A, B, C]. Want to process the backlog? (invokes the `curator` skill)"

- **pr-feedback-on-own-pr routing** (from step 4.5): if any non-merged PR on any active track has unresolved review threads, surface:
  > "I see M PRs with unresolved review threads (PR <id> on <repo> has K threads; PR <id> on <repo> has L threads). Want to iterate on feedback? (invokes the `pr-feedback-on-own-pr` skill)"

these prompts are one decision group each, per `interaction-style`. if both fire, offer both in a single message; operator picks one or neither.

## Never skip, never route around

every step in this skill — Step 0, 0.25, 0.5 and 0.75, plus the Step 2 through Step 5 chain (including the `.x` sub-steps for 2.6, 2.7, 4.5, 4.6, 4.7, 4.8) — runs every session. Step 2.6 (desk-registry awareness) is a cheap existence-check that is silent on the single-desk happy path (no `_meta/desks.md` → no-op). the host-identity probe (Step 0) is cheap and silent on the single-host happy path; the boot script (Step 0.75) is load-bearing — most mid-session failures trace back to a missing tool, an old `gh`, or stale auth that wasn't caught at start.

**auto-mode is license for action, not for skipping safety checks.** a prereq-probe failure is like a compile error: fix it, don't proceed. if the operator insists on proceeding with broken prereqs, surface the specific risk (e.g., "no gh = can't push to the workspace state repo = state won't sync across machines") and require an explicit override.
