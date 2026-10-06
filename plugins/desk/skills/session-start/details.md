# Session start: reference

The parts of `desk:session-start` that only some sessions need. `SKILL.md` links each one at the moment it applies; read only that section. The boot script's `instructions` already cover the ordinary path.

## Desk MCP availability and repair

**Desk MCP availability checkpoint.** boot no longer orders a `desk_status` check up front. If your host defers tools, Desk's may be listed by name without being loaded, so the first time you need one, load it (Claude Code: ToolSearch `select:` naming the exact tools, `mcp__plugin_desk_desk__task_update`, `mcp__plugin_desk_desk__desk_status` and the others). this section applies when a Desk tool is still absent after that. it is a distinct concern from the boot script's own `status`: the boot script reports the desk *workspace's* state, while this checks whether *this running session* can reach Desk's MCP tools at all. this applies to every agent built on `desk:worker`, including downstream overlays like `ms-desk` and area-specific workers. overlays may add their own MCP checks, but they inherit this substrate check rather than re-implementing it.

the minimum sentinel is `desk_status`. if the host exposes an active tool list, look for `desk_status` or the Desk MCP namespace. if the host does not expose a tool-list API, infer from the callable tools available in the current session. this is an active-session check: repo source and plugin cache can both be current while this running agent still lacks the MCP because the host has not reloaded or the MCP failed to launch. a context-compaction resume can reload tools, so check again after one if a Desk tool call fails.

when `desk_status` is callable:
- call it once.
- if it reports healthy/fresh state, include `Desk MCP: available` in the session-start status block.
- if it reports degraded state, include a concise `Desk MCP: degraded` line with the `desk_status` guidance. the compact answer carries only `state` (`ready`, `degraded`, `admitting` or `setup_required`), why and what to do when not ready, and `search`; the per-part fields (missing/stale DB, lexical index, vector coverage, runtime pack, snapshot, embedding endpoint) are present only with `desk_status({ detail: true })`, so call it that way when you need to name the failing part. degraded is not the same as absent: the agent can still use MCP-backed CRUD/status and can repair via `desk_reindex`, runtime-pack verification, snapshot/vector-pack import, or embedding/Ollama checks.

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

## Crew workspace: desk registry and agent-work migrations

after sync, check whether this workspace carries a committed desk registry: `$DESK/_meta/desks.md`. **default-tolerant — absent → behave exactly as today (single-desk, no shared-workspace awareness).** the file is plain markdown that travels with the repo (no machine-local fork), so reading it is a cheap existence-check + parse.

```bash
test -f "<desk path>/_meta/desks.md" && cat "<desk path>/_meta/desks.md"
```

the file makes this a crew workspace only when it holds the crew roster: the table below, whose header names both `alias` and `identity`. then the roster tells the agent two things:

1. **the desk-set** — every desk this workspace knows about (the operator's own, plus any peers' desks in a shared crew repo). surface the count in the status block ("crew workspace: N desks — alex, bob, …").
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

`desks/<alias>/**/task.md` globs already match nested paths, so the boot script's active-task scan picks up person-scoped task cards without change — this step only adds the *awareness* layer (the desk-set + which-desk-am-I framing). the scan itself is remap-transparent.

### agent-work migrations

the boot script's `instructions` name any pending `agent_work: true` migration (today `02-tidy-desk`) with the command to run. do it after the desk is synced and this session's own desk is known: pass the desk path boot printed on its `Desk:` line as `root.path`; `write_scope.person` is the desk's own handle, empty on a single desk, and `desk_status` reports it when you need it (load that tool first if your host defers it). for another plugin's migration, go through `session-start-migrations` with `DESK_TOOLS_ROOT` and `DESK_TOOLS_PERSON` set to the same values. for `02-tidy-desk`, tidy your own desk as its steps say, announce it in one line and carry on without waiting.

## Redacted names

**never repeat a redacted name.** a folder name can carry a secret's value (a task folder named after a prompt that held a password), and the status block reaches the chat and the transcript. the listing shows such a track, task or desk name as `<redacted segment>` and such a title as `<redacted title>`, and counts them under `redacted`. show the marker as it is, with the task's `handle` so the operator can tell two redacted tasks apart; do not open the card or list the folder to recover the name, and do not quote it in any later step. to resume or rename such a task, act on it by its handle: `task_move` with `handle` and an outcome `to_slug` (a track: `track_rename` with `handle` and `to`), then use the new name. when `redacted` is non-zero, rename those in your own desk that way as ordinary tidying (build the new name from the task's status, repos and the work you know about, never from the old name), and add one line after the status block: "N names hidden because they looked like they contained a secret's value; I renamed them to outcome names." when `active_tasks` is missing or `null` (Desk is still starting, or the root is not valid), say the listing is unavailable and why in one line; do not fall back to globbing the desk.

## Friction backlog

while scanning active tracks, count the open `_friction/*.md` entries (exclude `_friction/_archive/`) — the cards pinned to the corkboard, still asking for attention. if the count is non-zero on any active track, flag for the curator routing prompt in step 5.

## Workspace MCP link

if the operator's runtime supports a workspace-level MCP config file discovered by walk-up from CWD (e.g. an `<runtime>.toml` at the workspace root), this step is where to ensure the discovery link from `$HOME` to the workspace file exists. the mechanism is engine-specific — see the relevant consumer overlay's session-start extension for the exact file name, link primitives (symlink / hardlink / copy), and platform-aware decision tree.

the substrate's contribution at this step is just the slot: every session, check whether the workspace MCP config is reachable from `$HOME`, repair if not, and announce link state if anything changed. on a fresh-cloned machine this lands the discovery link once and is silent thereafter. on a known-good machine this is a single cheap existence check.

if the runtime does not support walked-up workspace MCP discovery, this step is a no-op.

## Factory lines

the session-start hook appends at most one `Desk boot pre-checks:` line, addressed to you; its clauses are separated by `; `. this step owns what the `Factory evaluator:`, `Factory:` and `Improvement cards:` clauses ask of you. the plugin runs the evaluator and the improvement loop itself, in a detached worker, so none of these lines asks you to start anything. no such clause, or a noninteractive or headless session (which gets none) → nothing to do.

- **`Factory evaluator: N finished jobs wait for labels (oldest D days); the plugin labels them in the background, last result <state>`** → say it in one line of the status block. nothing to run, and don't wait for the labels.
- **`Factory evaluator: cannot run (<state>); N finished jobs wait ...`** (`no_agent_cli`, `no_credentials`, `unsupported_host`, `sign_in_unknown`) → the plugin could not start the evaluator. the line says whether a card is open for it; if so, the card is yours to take (below). `no_agent_cli` and `no_credentials` are yours to fix: install the CLI, or sign in yourself, since an agent runs sign-in flows. for `sign_in_unknown`, check the CLI's sign-in status and repair what an agent can (a CLI that is not signed in); never switch billing.
- **`Factory evaluator: does not run because this sign-in would be billed per token, and nothing is spent ...`** (`disabled_would_bill`) → the plugin starts the evaluator only on a subscription sign-in. say the line in the status block and change nothing: how a person is billed or signed in is theirs to decide, and the state is shown on the health record and at session start so they can. no card opens for it. `switched off on this machine` means `DESK_FACTORY_HEADLESS_EVALUATOR=0` is set; it is the operator's choice.
- **`Improvement cards: N open (oldest D days). Standing, pre-authorized work: ...`** → cards are standing work; the operator need not ask. when your foreground work allows, hand the oldest to a background subagent through `improvement_next` and let it follow `desk:curator`'s improvement-card routine. `Improvement cards: unreadable` or `not checked` → say so in one line; for `not checked`, set `DESK_PERSON` to read your cards. a count of set-aside card files means `_meta/improvement/invalid/` holds files the card library could not read: restore each one there to `_meta/improvement/` once fixed, or delete it, and commit.
- **`Factory: N finished jobs have quarantined waste labels; a card is open for it | no card is open for it yet | the improvement cards could not be fully read`** → say so in one line. there is nothing to run: labels are quarantined when the factory store refused them or when their session's facts were quarantined (a `facts_quarantined` record names those facts), under `quarantine/<store-slug>/labels/` in the protected factory state. the card (`loop_alarm:labels_quarantined`) carries the fix.
- **`Factory: N open andon issues in <store> (#…); each has an improvement card | none has one yet, and each gets one at the next background step`** → a release made a quality measure clearly worse. andon cards come first in the improvement-card routine. say so in one line of the status block.

**handling an `evaluate` answer**, only when you retry a job the loop could not finish (run `node <Desk plugin folder>/mcp/scripts/factory.js evaluate --pending` from the Desk plugin folder, two levels above this skill's folder), per job:

- `ready` → start a fresh `desk:observer` subagent in the background whose whole prompt is: "Label the waste in these evaluator briefs with `desk:factory-evaluator`: <that job's `briefs` paths>." give it nothing else from this conversation; the evaluator must not see the working agent's context. one observer per job, with only that job's paths.
- `no_sessions` → the finishing session is not derived yet. the request stays, and a later `evaluate --pending` picks it up.
- `complete` → every session has labels, or has them held back because its facts are quarantined. nothing to do.
- `not_opted_in` or `expired` → no evaluator.

a missing or failed evaluation never reopens a task, and `done` never waits for it.

## Factory consent

Applies only after the boot's last instruction said consent is undecided for a store, you ended the reply with its one line, and the operator then said "factory details" (or asked what is sent). Never run it first, never in a noninteractive session, and never ask more than once. `<store>` is the store the boot named, and `<Desk plugin folder>` is the folder `session-start` runs the boot script from.

1. Find the account that would open the intake pull requests: `node <Desk plugin folder>/mcp/scripts/factory.js account --store <store>`. Never assume gh's active account.
2. With result `account_found`, ask this, naming that account as the login: "Desk can contribute measurement data about your finished tasks to `<store>`, which builds a report for each finished job. What it publishes: durations, counts, tool kinds, plugin and model versions, and references to public repositories. What it never publishes: prompt, assistant or tool content, names, or dates and times of day. `<store>` is a public repository, and your GitHub account `<login>` appears as the author of the intake pull requests that deliver the data. Contribute? (yes or no)"
3. With result `no_account_can_deliver`, do not ask: say in one line that no signed-in GitHub account can open pull requests on `<store>` (give each account's reason), and that signing in a personal account with `gh auth login` lets a later session ask.
4. Record the answer only with `node <Desk plugin folder>/mcp/scripts/factory.js consent --store <store> --contribute yes --account <login>` or `node <Desk plugin folder>/mcp/scripts/factory.js consent --store <store> --contribute no`. A no is a decision too and is never asked again.

## Delivered tasks awaiting sign-off

When the boot text has a `Delivered, awaiting sign-off:` section, it lists delivered tasks the operator has not yet answered, one line each (`<track>/<slug>`, age, proof, `overdue` after seven days), and one numbered instruction says how many. The list is a lower bound when the line says "at least" or that some task cards could not be read. In an interactive session, do what the operator asked first. Then raise every listed task once, together, each as three lines (what was asked, what you delivered with its proof, accept or send back?), and carry on without waiting. When the operator answers, call `task_signoff` for that task in a later turn. In a noninteractive session, raise nothing. Do not raise the same delivery again in the same session. `status.json` carries the counts as `signoff`; a figure marked `partial` or `unavailable` is not a measured count.

## Status block and routing prompts

concise status block, then an open prompt:

```
N active tasks across M tracks. Uncommitted changes in K repos.

<track-name>/
  <task-slug>    <status>    updated <X ago>
  ...

resume one, or start new?
```

**shared-workspace addendum** (only when a `_meta/desks.md` registry was found above): prepend a one-line desk-set banner so the operator sees which crew desk they're sitting at and who else is in the repo:

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
