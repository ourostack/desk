# desk

a quiet room for a long-running agent's work — the universal substrate underneath whichever overlay (corporate worker, autonomous agent, personal coding agent) sits on top.

the desk is where the agent does its thinking and keeps its things. drawers for tracks, manilla envelopes for tasks, a corkboard for friction notes, a small reference shelf for lessons earned. archive lives at the back of the room — still browsable, still mine. the same desk serves every consumer because the layout and ceremonies don't depend on whose desk it is:

- **corporate worker overlay** — an enterprise engineer overlay (with whatever work-item tracker, code-review system, and identity provider the org uses) declares desk as substrate dependency, then layers org-context overlays on top
- **autonomous agents** (long-lived agents managed by an agent framework) — bundle desk as part of the agent package; declare the desk path in the agent's preamble
- **personal coding agents** — activate desk through the host/plugin profile; declare a workspace path in agent preamble

cross-context portability runs on the `$DESK` placeholder convention: each consumer agent's preamble binds `$DESK` to its own workspace directory, and desk skills reference paths via `$DESK` rather than any specific literal. one substrate, many overlays.

The dependency ladder is explicit:

```text
desk substrate -> desk:worker -> ms-desk:worker -> area overlay
```

`desk:worker` is the standalone default supplied by Desk. A consumer overlay such as `ms-desk` declares Desk as a dependency, inherits `desk:worker`, and contributes its own identity/instructions. A narrower area overlay depends on `ms-desk` and inherits `ms-desk:worker`. The selected activation is profile/project state: standalone Desk selects `desk:worker`; a personal global profile can select `ms-desk:worker` or an area overlay without copying Desk setup.

For the on-demand design rationale behind the V2 foundation, layered toolshop, coaching, validation, and migration boundaries, see the canonical public RFC: [`docs/agentic-engineering-v2-rfc.md`](./docs/agentic-engineering-v2-rfc.md). Ordinary startup does not load the long-form RFC.

## Activation

### Under Copilot CLI

Run `agency plugin install github:ourostack/desk:plugins/desk@main --engine copilot`, then start Copilot with `agency copilot`. `main` of `ourostack/desk` is the release channel.

Acquisition is ordinary and single-root: select `desk` and let its own declaration pull the rest. `plugins/desk/agency.json` declares exactly two generic dependencies — Superpowers and Plain Language, both tracked at `ourostack/desk@main` — so the standalone composition is the three roots Desk, Superpowers and Plain Language, with no Ponytail, no Work Suite and no private feedback API. A shared-workspace composition adds Crew and its organization overlay (five roots), and a Platform Workflows consumer adds its own root on top (six roots); those are consumer compositions, not this package's closure. Metadata is not runtime loading proof: the host must load every selected root and prove the actual skill/MCP source identity before admission. Later source corrections arrive through ordinary Agency branch tracking of `@main`, not a manual refresh or rollback channel.

### Under Ouroboros

Select `ourostack/desk:plugins/desk@main` through the host's supported bundle path. `main` of `ourostack/desk` is the release channel; do not substitute a fork, another branch or an exact commit.

The agent's `bundle.json` gains a `plugins[]` entry; the agent's preamble declares `Your desk: ~/AgentBundles/<agent>.ouro/desk/`.

The source bundle carries the three selected roots — Desk, Superpowers and Plain Language — together. Its packaging contract does not establish full runtime qualification:

```json
{
  "plugins": [
    "desk",
    "superpowers",
    "plain-language"
  ]
}
```

The agent preamble binds the placeholder to a concrete workspace path:

```text
$DESK = ~/AgentBundles/<agent>.ouro/desk/
Your desk: ~/AgentBundles/<agent>.ouro/desk/
```

### Under Claude Code

Setup is agent-driven: give Claude Code the link to [`SETUP.md`](../../SETUP.md) and say "set this up". It installs `desk@ourostack` from the `ourostack/desk` marketplace at user scope (Superpowers and Plain Language come with it as declared dependencies), sets the host defaults (no Claude memory, no AI attribution), turns `CLAUDE.md` in the Claude config directory (`$CLAUDE_CONFIG_DIR`, falling back to `~/.claude`) into a thin pointer, and finds or creates the desk.

Desk ships `desk:worker` as the default agent for new sessions (`settings.json`); an explicit `--agent` still wins. Desk binds the desk in this order, on Claude Code and Copilot alike: an explicit root, then the project folder the host opened when it is itself a desk (it has `_meta/` plus `_archive/` or `desks/`), then the folder the session started in when it is in a Crew workspace clone (`_meta/` plus `desks/`, marked by `_meta/crew.json` or a roster in `_meta/desks.md`; a folder inside the clone binds the clone, up to the clone's Git top level, so a repository nested in it is its own project; on Copilot, the folder Copilot recorded for the session), then the saved binding at `$CLAUDE_PLUGIN_DATA/desk.activation.json`, then `$DESK`, then the folder the session started in when it is a personal desk, then the personal home fallbacks (`~/desk`, then `~/worker-workspace`, reported by `desk_status` as source `home_fallback`). A home fallback binds only a folder with the desk layout (`_meta/` plus `_archive/` or `desks/`); an empty folder leaves Desk in setup mode. An explicit root, saved binding or set `$DESK` never falls back: if its folder is missing or unreadable, Desk stays up in `degraded:root_unavailable`, names the configured path and how to restore or rebind it, and recovers in the same session once the folder exists. Plain Desk never binds a work overlay's desk; `~/ms-desk` is consulted only while the ms-desk overlay is loaded next to Desk in the same Agency session, and such a session never falls back to the personal `~/desk` or `~/worker-workspace`. With no desk bound, the Desk MCP stays up in setup mode and routes to `first-run-bootstrap` instead of being unavailable. A plugin loaded with `--plugin-dir` takes precedence over the installed copy for that session, so overlay launchers do not load Desk twice. A Crew clone outranks the saved binding and `$DESK` so that a member who starts a session in it always works in the team workspace, even with a user-wide `$DESK` pointing at their personal desk; a personal desk folder does not, so an existing binding keeps working. The boot script and the tool server resolve this with the same code, so they always name the same desk. Background and Agent View inheritance remain unqualified.

### Overlays that own their workspace

An overlay that resolves its own root (a crew launcher that maps the operator's identity to a shared workspace, for example) launches the Desk MCP with `--root <workspace>` when it can, and with `--onboarding <skill>` when it cannot, optionally adding `--onboarding-reason "<what is missing>"`. Desk then starts in setup mode on that path instead of exiting or guessing a home fallback that belongs to a different desk; `desk_status` reports the skill and the reason, and the startup hook and `session-start` route to it. Failing closed leaves the operator with an unavailable Desk MCP, so launchers should prefer `--onboarding`.

### Missing Desk MCP and search

At worker session start, missing Desk MCP is surfaced as an operator decision rather than silently falling through to local-only mode: fix/reload the host activation now, or continue without generic reminders while accepting weaker desk search, task CRUD, friction/lesson writes, and cross-session resumption.

Search needs no setup. Each Desk MCP server keeps its own exact-word index and runs a small built-in embedding model for meaning-based search, downloaded once into `$DESK/.state/`. See [Search](mcp/README.md#search) in the MCP README.

Vector packs and snapshots under `$DESK/artifacts/` belong to the old shared index. This build does not read or make them.

### Embedding privacy

Embeddings are derivative data and may carry privacy risk even though they are not plain-text documents. Desk keeps them in `$DESK/.state/`, which it keeps out of Git, and never publishes them.

### Work accounting

Desk accounts for work automatically. When a session ends, the factory records its facts on the machine, outside any desk, and a finished job gets a report in its factory store ([local capture](docs/factory-local-capture.md)). There is no manual ledger to keep. The manual work-measurement ledger, its tool and its batch profiler are retired; records it left in your state directory stay where they are, and `desk_doctor` counts them without opening, moving or deleting them.

To see your own tasks by name on the factory site, run `node mcp/scripts/private-view.js` from the installed Desk plugin folder with your desk bound (`$DESK` set). It fetches the published site files first (nothing is written if any fetch fails), then replaces `~/.local/state/desk-private-view/factory/` (folder 0700, files 0600) with a copy of the site and a `local-names.json` mapping each task's published job ID to its title, track and slug. It refuses a folder that is a symbolic link, inside a Git work tree or inside the factory's state folder, and refuses with the reason when a job ID cannot be derived exactly as the factory publishes it. Then it serves the folder on `127.0.0.1` only and prints the `http://127.0.0.1:<port>/` URL to open; it serves until Ctrl-C, so an agent runs it in the background and reads the URL from its first output line. Crew desks (`desks/<alias>`) are not mapped, and the script says so. A home folder that is itself a Git repository (for example a dotfiles repo) is refused, with no override. The names show once the site change ([ourostack/factory#168](https://github.com/ourostack/factory/pull/168)) is live. The page runs the published site's code beside your names, so never copy that folder anywhere public.

## Invocation — the default `worker` agent

The plugin ships a substrate-default agent named `worker` — a long-running engineering agent that uses the desk (tracks, tasks, friction, lessons) to keep its work coherent across sessions. It's standalone-functional; you don't need to author a consumer overlay to start working.

```bash
# Claude Code (via plugin loader / marketplace)
claude --agent desk:worker

# Copilot CLI (through Agency)
agency copilot --agent desk:worker
```

Copilot startup uses the root plugin's Desk-owned `sessionStart` hook to read `skills/using-desk/SKILL.md` at runtime and emit it as `additionalContext`. The agent file keeps the worker identity and operating context without copying the foundation body.

See [`docs/agent-files.md`](./docs/agent-files.md) for the per-harness agent file reference.

Two agent files (`agents/worker.md`, `agents/worker.agent.md`) ship the same canonical body in each harness's expected format. A sibling agent, `observer`, ships the same way (`agents/observer.md`, `agents/observer.agent.md`): it evaluates work it did not do, from evidence, and never fixes or certifies it; it is never the default. It evaluates a release with the [evaluation packet](docs/evaluation-packet.md), and labels a finished job's waste in the background when its task reaches `done` ([factory-evaluator](skills/factory-evaluator/SKILL.md)). If you want a context-specific overlay (corporate-engineering, autonomous-agent, personal-coding), author it as a sibling plugin that depends on `desk` and provides its own agent file; the substrate stays generic.

For deeper stacks, depend on the most specific layer you need. `desk_status` reports the declared chain when the host passes activation context; actual host loading still needs verification.

## Structured questions

Questions belong in ordinary chat. Claude's Desk agent definitions exclude only `AskUserQuestion`. On Copilot, Desk's session start sets `askUser: false` in Copilot's settings once when the operator has not chosen a value, which turns off the `ask_user` form from the next session; an explicit `askUser: true` is left alone. See [agent tool policy and host boundaries](docs/agent-files.md#structured-questions-on-claude-code).

## what desk gives an agent

a furnished room, ready to settle into. the layout, the lifecycle, the small ceremonies for tending it.

### workspace structure
- `$DESK/<track>/<task>/<iteration>/` — drawers, folders inside drawers, pages laid open one per work session
- `track.md` and `task.md` cards as canonical state (frontmatter + body)
- `$DESK/_meta/`, `$DESK/_archive/`, `$DESK/_friction/`, `$DESK/_planning/` system directories
- per-iteration planning, doing, and feedback documents when the work needs them

### lifecycle
- 8-state machine: drafting → processing → validating → collaborating → paused → blocked → done → cancelled. every task moves; some pause along the way
- checkpoint-type annotations on each transition (GATE / CHECKPOINT / AUTO / CONFIRM / NOTIFY)
- session start / resumption / archival workflow

### the card guard
Desk installs a git `pre-commit` hook in the desk (marker line `# desk-card-commit-guard`) that refuses a hand `git commit` adding or modifying a live task card; cards are written with `task_update`, `task_create`, `task_move` and `task_archive`, which commit for you. It passes while a merge, cherry-pick or revert is in progress and for a card whose frontmatter does not parse. A hook that was already there is kept as `pre-commit.desk-chained` and runs after the check; a `core.hooksPath` that holds tracked files is never modified (boot says so and gives the manual remedy).

#### Removing the card guard
Run `node -e 'import("<desk plugin>/mcp/src/desk/card-commit-guard.js").then(m=>console.log(m.uninstallCardGuard(process.argv[1])))' <desk root>`, or delete `.git/hooks/pre-commit` (or the hook in your `core.hooksPath`) and rename `pre-commit.desk-chained`, if present, back to `pre-commit`. Boot installs the hook again on the next session start, so to keep it off, set `core.hooksPath` to a folder Desk should leave alone (tracked) or remove the plugin.

Desk's hooks run at its own boundaries: session start and end, the factory capture, and the card guard on the desk repository above. The harness owns its tools and the shell.

#### Copilot and the Desk MCP server
Copilot gives its MCP servers no session folder (the server's working folder is the plugin's, `roots/list` answers an empty list, and `PWD` is only what launched Copilot). Desk's `sessionStart` hook records the session folder and the saved binding it saw in `<desk state>/copilot-sessions/<digest of session id>.json`, and the server reads that file whenever it resolves its root, keyed by `COPILOT_AGENT_SESSION_ID`, the one per-session value in its environment. Copilot starts the server before it fires `sessionStart`, so the first resolution finds nothing; the server watches for the record and admits the session as soon as it appears, and every `desk_status` and gated tool call resolves again, so nothing needs a restart. Sessions have separate files written by rename, a record whose folder is no longer a desk falls through to the saved binding, `$DESK` and the home fallbacks, and records untouched for 30 days are pruned.

### unsigned deliveries at boot
Boot records which unsigned deliveries it listed per host session, so a resumed or compacted session is not asked twice. A subagent's shell has the same environment as the main agent's (same session id, no agent id), so a subagent that runs the boot can mark sign-offs as listed and delay the ask once within that session; the boot text still lists every delivery, and the next session asks again.

### dispatch
- `work-orchestration` invokes `desk:using-superpowers-with-desk`; Superpowers is the sole engineering method, while Desk preserves state and authority
- non-coding workflow paths supported (execution + completion alternatives for non-code work)

### engineering posture
- `evidence-discipline` — fixtures-or-refusal, smoke-before-infinity, messages-over-models, etc.
- `factory-work` — the Lean reading and terrarium checks for designing, changing or reviewing the factory
- `preflight-actions` — preflight pattern before irreversible actions
- `runtime-symptom-investigation` — narrow-the-hypothesis-space pattern for runtime issues

### PR craft (for coding agents)
- `pr-self-review`, `pr-review-interrogation`, `pr-surface-hygiene` — pre-open and post-open PR discipline
- `peer-pr-review`, `pr-reviewer-audit` — reviewing others' code

### browser
- a `desk-web` MCP server ships beside the Desk MCP on Claude Code and Copilot CLI, so every install can open and drive web pages with no setup. It has two tools: `browser_context` opens a browser and closes it, and `browser_command` runs one Playwright CLI page command in it (`goto`, `snapshot`, `click`, `fill`, `screenshot`, tabs and so on)
- `browser_context` offers two browsers: `fresh`, an empty throwaway profile that is never signed in, and `mine`, a private copy of the person's own Edge (or Chrome) profile, so their sign-ins work. The copy skips caches, extensions and open tabs, runs with sync off, and is deleted on close. On Windows, files the running Edge locks (its cookies among them) are skipped, so with Edge open only the work sign-in carries over, and the open result says so
- each browser is its own headless process with its own user-data folder in a private temp folder. Desk never focuses a window, attaches to or closes the person's running browser or another agent's, changes their default browser or profiles, or uses a debugging port
- `mcp/web.cjs` installs `playwright-core` with npm into Desk's state folder (`~/.local/state/ouroboros-skills/desk/browser`, or under `$XDG_STATE_HOME`) on the first open, so that first open needs the npm registry. Screenshots and other files go to the `files` folder inside the context's private temp folder, which is deleted when the context closes
- it drives Edge, or Chrome when Edge is not installed. Every failure is a plain sentence that says what to do

### friction / learning
- `friction-management` — pin a card to the corkboard, then encode the pattern
- `lesson-capture` (post-task) — mine a finished task for patterns and propose what's earned a place on the reference shelf; waste the evaluator found in the shared system becomes a kaizen card
- `curator` — on the operator's request, process the friction backlog and work the kaizen cards: handle open andon issues first, file system friction as cards in the factory store after signoff, ship each countermeasure, fill in its version at release and close the cards the store's build confirms

## convention: the `$DESK` placeholder

skill bodies reference workspace paths via `$DESK`, not literal paths. the host agent's preamble declares the binding — same skills, different rooms:

- Corporate worker overlay: `Your desk: ~/<your-workspace>/` (whatever the overlay's convention is)
- Autonomous agent: `Your desk: ~/AgentBundles/<agent>.ouro/desk/`
- Personal coding agent: whatever the operator declares

The agent does textual substitution when interpreting skill instructions or running shell commands.

## what desk does NOT provide

the substrate stays general. the overlay handles everything situational.

- **org-specific agent identity** — `worker` is the substrate default; consumer overlays (corporate-engineering, autonomous-agent, personal-coding) can ship their own agent and foundation with extended skills and tooling on top.
- **engineering implementation mechanics** — those live in the Superpowers provider, not a second Desk lifecycle
- **organization-specific concerns** — auth systems, work-item trackers, internal portals, etc. live in a consumer overlay (one of several possible overlays — others can be built the same way)

## versioning

v0.1.0 ships the first cut: 12 core skills + the `lesson-capture` skill. Subsequent releases add further skills with cleaner substrate-vs-overlay separation, and refinements.
