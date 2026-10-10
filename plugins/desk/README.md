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

The alpha source is `ourostack/desk:plugins/desk@main`. Use the host's admitted, explicit alpha composition instead of changing a live default installation.

Acquisition is ordinary and single-root: select `desk` and let its own declaration pull the rest. `plugins/desk/agency.json` declares exactly two generic dependencies — Superpowers and Plain Language, both tracked at `ourostack/desk@main` — so the standalone composition is the three roots Desk, Superpowers and Plain Language, with no Ponytail, no Work Suite and no private feedback API. A shared-workspace composition adds Crew and its organization overlay (five roots), and a Platform Workflows consumer adds its own root on top (six roots); those are consumer compositions, not this package's closure. Metadata is not runtime loading proof: the host must load every selected root and prove the actual skill/MCP source identity before admission. Later source corrections arrive through ordinary Agency branch tracking of `@main`, not a manual refresh or rollback channel.

### Under Ouroboros

Select `ourostack/desk:plugins/desk@main` through the host's supported opt-in bundle path. `main` of `ourostack/desk` is the release channel; do not substitute a fork, another branch or an exact commit.

The agent's `bundle.json` gains a `plugins[]` entry; the agent's preamble declares `Your desk: ~/AgentBundles/<agent>.ouro/desk/`.

The source bundle carries the three selected roots — Desk, Superpowers and Plain Language — together. Its packaging contract does not establish full alpha runtime qualification:

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

Desk ships `desk:worker` as the default agent for new sessions (`settings.json`); an explicit `--agent` still wins. Desk binds the desk in this order: an explicit root, then the project folder when it is itself a desk, then the saved binding at `$CLAUDE_PLUGIN_DATA/desk.activation.json`, then `$DESK`, then the personal home fallbacks (`~/desk`, then `~/worker-workspace`, reported by `desk_status` as source `home_fallback`). A home fallback binds only a folder with the desk layout (`_meta/` plus `_archive/` or `desks/`); an empty folder leaves Desk in setup mode. An explicit root, saved binding or set `$DESK` never falls back: if its folder is missing or unreadable, Desk stays up in `degraded:root_unavailable`, names the configured path and how to restore or rebind it, and recovers in the same session once the folder exists. Plain Desk never binds a work overlay's desk; `~/ms-desk` is consulted only while the ms-desk overlay is loaded next to Desk in the same Agency session, and such a session never falls back to the personal `~/desk` or `~/worker-workspace`. With no desk bound, the Desk MCP stays up in setup mode and routes to `first-run-bootstrap` instead of being unavailable. A plugin loaded with `--plugin-dir` takes precedence over the installed copy for that session, so overlay launchers do not load Desk twice. Background and Agent View inheritance remain unqualified.

### Overlays that own their workspace

An overlay that resolves its own root (a crew launcher that maps the operator's identity to a shared workspace, for example) launches the Desk MCP with `--root <workspace>` when it can, and with `--onboarding <skill>` when it cannot, optionally adding `--onboarding-reason "<what is missing>"`. Desk then starts in setup mode on that path instead of exiting or guessing a home fallback that belongs to a different desk; `desk_status` reports the skill and the reason, and the startup hook and `session-start` route to it. Failing closed leaves the operator with an unavailable Desk MCP, so launchers should prefer `--onboarding`.

### Under Codex

The plugin ships Codex manifests for Desk and its Superpowers and Plain Language closure. Explicit alpha activation materializes only the owned config/instruction region for the selected mode.

Within explicit alpha activation, the default mode is `global-personal`: Desk and Superpowers are selected together with the owned MCP bridge and instruction block. `project-local` and `manual-only` remain opt-outs. Enabled competing lifecycle configuration is refused, not silently rewritten; operator-owned text and prior approvals remain intact through `desk:using-superpowers-with-desk`, the active adapter that the retired `desk:superpowers-integration` name now redirects to.

Codex plugin ids use the actual marketplace namespace consistently for Desk, Superpowers and downstream overlays. A namespace or cache version alone does not prove the selected loaded source.

Do not run `codex mcp add` or `npm install` inside the Desk plugin for the healthy path. The MCP entrypoint restores verified production runtime dependencies from the committed runtime pack into a writable cache, then launches from a source mirror. See `desk:codex-onboarding` for repair checks when a local development install, stale host config, or missing active Desk MCP tool surface needs inspection.

When debugging Codex setup, keep the evidence states separate:

- `repo-source-current`: repo manifests and `.agents` marketplace source match.
- `installed-cache-current`: the Codex plugin cache has the same manifests as repo source.
- `active-session-visible`: the running session has actually reloaded those manifests and exposes the selected activation plus the Desk MCP tool surface, including `desk_status`.

`scripts/audit-codex-plugin-cache.cjs` checks the first two states read-only. It can also check `active-session-visible` when given a host tool-list snapshot via `--active-tools` or `--active-tools-file`; `--strict-active` fails if that snapshot is missing or does not include the full Desk MCP tool set. A current cache with missing active tools means the host needs a fresh session or the MCP failed to launch.

At worker session start, missing Desk MCP is surfaced as an operator decision rather than silently falling through to local-only mode: fix/reload the host activation now, or continue without generic reminders while accepting weaker desk search, task CRUD, friction/lesson writes, and cross-session resumption.

For semantic search, keep Ollama reachable with `nomic-embed-text` pulled. The MCP honors `OLLAMA_HOST` and `DESK_EMBED_ENDPOINT` for endpoint selection, but the active embedding model is pinned. With semantic mode `background` or `required`, startup refuses an effective `DESK_EMBED_MODEL` (or fallback `OLLAMA_EMBED_MODEL`) that differs from `nomic-embed-text`; another model requires a separately versioned embedding specification. Unset a differing override rather than expecting lexical-only startup. Indexed query and reindex calls enforce the same pin even when automatic semantic convergence is `unsupported`. `desk_reindex` without arguments repairs missing vectors once embeddings are reachable. See the [MCP developer notes](mcp/README.md#developer-notes) for model and endpoint configuration.

For shared repos, document-side embeddings and warm-start SQLite snapshots live in the workspace repo under `$DESK/artifacts/`. On startup, the MCP checks `$DESK/artifacts` before plugin-bundled release artifacts, restores a compatible snapshot into local `.state/` when available, and falls back to repo-local vector packs before generating missing document vectors.

### Artifact privacy

Embeddings and snapshots are derivative data and may carry privacy risk even when they are not plain-text documents. Shared vector packs and warm boot snapshots are published only through explicit, policy-controlled artifact paths such as `$DESK/artifacts/`; public or sensitive repositories should require approval before these artifacts are committed.

See `desk:codex-onboarding` for the repair checklist and verification steps.

### Work accounting

Desk accounts for work automatically. When a session ends, the factory records its facts on the machine, outside any desk, and a finished job gets a report in its factory store ([local capture](docs/factory-local-capture.md)). There is no manual ledger to keep. The manual work-measurement ledger, its tool and its batch profiler are retired; records it left in your state directory stay where they are, and `desk_doctor` counts them without opening, moving or deleting them.

To see your own tasks by name on the factory site, run `node mcp/scripts/private-view.js` from the installed Desk plugin folder with your desk bound (`$DESK` set). It fetches the published site files first (nothing is written if any fetch fails), then replaces `~/.local/state/desk-private-view/factory/` (folder 0700, files 0600) with a copy of the site and a `local-names.json` mapping each task's published job ID to its title, track and slug. It refuses a folder that is a symbolic link, inside a Git work tree or inside the factory's state folder, and refuses with the reason when a job ID cannot be derived exactly as the factory publishes it. Then it serves the folder on `127.0.0.1` only and prints the `http://127.0.0.1:<port>/` URL to open; it serves until Ctrl-C, so an agent runs it in the background and reads the URL from its first output line. Crew desks (`desks/<alias>`) are not mapped, and the script says so. A home folder that is itself a Git repository (for example a dotfiles repo) is refused, with no override. The names show once the site change ([ourostack/factory#168](https://github.com/ourostack/factory/pull/168)) is live. The page runs the published site's code beside your names, so never copy that folder anywhere public.

## Invocation — the default `worker` agent

The plugin ships a substrate-default agent named `worker` — a long-running engineering agent that uses the desk (tracks, tasks, friction, lessons) to keep its work coherent across sessions. It's standalone-functional; you don't need to author a consumer overlay to start working.

```bash
# Claude Code (via plugin loader / marketplace)
claude --agent desk:worker

# Copilot CLI
copilot --agent worker
```

Copilot startup uses the root plugin's Desk-owned `sessionStart` hook to read `skills/using-desk/SKILL.md` at runtime and emit it as `additionalContext`. The agent file keeps the worker identity and operating context without copying the foundation body.

**Codex.** The activation adapter makes `worker` the global personal default by materializing owned Codex config and `AGENTS.md` blocks. Use `manual-only` when Desk should stay available as a plugin/MCP substrate without default worker behavior, or `project-local` when a specific repo should own its Desk binding.

See [`docs/agent-files.md`](./docs/agent-files.md) for the per-harness agent file reference, and `desk:codex-onboarding` for repair verification when a local Codex host does not reflect the activation metadata.

Three agent files (`agents/worker.md`, `agents/worker.agent.md`, `agents/worker.toml`) ship the same canonical body in each harness's expected format. A sibling agent, `observer`, ships the same way (`agents/observer.md`, `agents/observer.agent.md`, `agents/observer.toml`): it evaluates work it did not do, from evidence, and never fixes or certifies it; it is never the default. It evaluates a release with the [evaluation packet](docs/evaluation-packet.md), and labels a finished job's waste in the background when its task reaches `done` ([factory-evaluator](skills/factory-evaluator/SKILL.md)). If you want a context-specific overlay (corporate-engineering, autonomous-agent, personal-coding), author it as a sibling plugin that depends on `desk` and provides its own agent file; the substrate stays generic.

For deeper stacks, depend on the most specific layer you need. The adapter enables the selected overlay chain alongside Desk and Superpowers, with one Desk MCP. Generated instructions and `desk_status` report the declared chain; actual host loading still needs verification.

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

On Codex, Desk registers only the `SessionEnd` capture hook; Codex skips an untrusted hook silently and there is no automatable trust grant.

#### Copilot and the Desk MCP server
Copilot gives its MCP servers no session folder (the server's working folder is the plugin's, `roots/list` answers an empty list, and `PWD` is only what launched Copilot). Desk's `sessionStart` hook records the session folder and the saved binding it saw in `<desk state>/copilot-sessions/<digest of session id>.json`, and the server reads that file whenever it resolves its root, keyed by `COPILOT_AGENT_SESSION_ID`, the one per-session value in its environment. Copilot starts the server before it fires `sessionStart`, so the first resolution finds nothing; every `desk_status` and gated tool call resolves again, so the next call binds with no restart. Sessions have separate files written by rename, a record whose folder is no longer a desk falls through to the saved binding, `$DESK` and the home fallbacks, and records untouched for 30 days are pruned.

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
- a `desk-web` MCP server ships beside the Desk MCP on Claude Code and Copilot CLI, so every fresh install can open and drive web pages with no setup. Its tools read `browser_navigate` and so on (for example `mcp__plugin_desk_desk-web__browser_navigate` on Claude Code). A server of your own named `playwright` stays yours: Desk never uses that name
- `mcp/web.cjs` starts a copy of `@playwright/mcp` installed in Desk's state folder (`~/.local/state/ouroboros-skills/desk/browser`, or under `$XDG_STATE_HOME`), under the same compatible Node the Desk bootstrap picks. The first launch answers the host's handshake at once with a fixed snapshot of Playwright MCP's tool list (`mcp/web-catalog.json`) and installs it meanwhile (`mcp/web-proxy.cjs`): a browser call that arrives before the install finishes is held, up to two minutes, and then passed to the installed browser, so the first call waits instead of failing and the host never sees the tool list change (`mcp/scripts/refresh-web-catalog.mjs` refreshes the snapshot, and a daily workflow checks it against the latest release); later launches start it at once with no network call, then refresh it from the `@latest` channel in the background (never a pinned version), so a new release reaches the next session. Installs and refreshes share one lock, so sessions that start together never race, and every npm call runs with no retries and a short timeout
- by default the browser is headless and has an in-memory profile, so agents never take the operator's focus or fight over one profile. Playwright MCP writes snapshots and screenshots to `output/` in that state folder, never into the session's project. The launcher's first stderr line names the `@playwright/mcp` and `playwright-core` versions it started; `last-refresh.json` records the last refresh. To reproduce a problem with an exact release for one debugging session, run `npx -y @playwright/mcp@<version>` by hand; never commit a version
- a plugin can switch `desk-web` to the operator's real browser profile by declaring `"desk": { "browser": { "channel": "msedge" | "chrome", "profileAccountDomain": "<domain>" } }` in its `plugin.json` (the last plugin listed wins). The launcher (`mcp/web-real-profile.cjs`) finds the profile whose signed-in account ends in `@<domain>` in the browser's `Local State`, reads the Playwright Extension's connection token from a temporary copy of its local storage, and redacts it from the proxy's output. The token reader is `classic-level`. Desk supplies its hash-verified native executable through Playwright MCP's supported `--executable-path` option; that executable launches the official connect URL directly with `--new-window --profile-directory=<profile>`, without a shell, OS scripting, a holding page or a last-active-window delay. The URL is passed unchanged and never included in the helper's secret-free launch receipt. Each extension tab group has a distinct owner label using the host's client name and available session identity. `browser_close` attempts bounded cleanup of only this connection's tabs, without quitting the browser; partial or unverified cleanup retains the connection and reports `browser_cleanup_incomplete`. Session-end cleanup is attempted too. A native spawn receipt proves launch, not a physical-window identity or a hard isolation boundary. The token reader is installed only when a plugin declares a browser, so failure to install its native reader does not break the default headless path. Missing profiles, extensions, browsers or native assets return a degraded answer with the fix.
- it drives Google Chrome, or Edge when Chrome is not installed. With neither, install one, or run `npx -y @playwright/mcp@latest install-browser chrome`, which installs Google Chrome system-wide and asks for an administrator password on macOS and Linux
- real-profile connections keep one inactive owner-control tab. The supported `--init-page` callback uses that tab's existing extension capability to enable renderer-only focus emulation on exact-owned pages, so animation frames and ordinary Playwright input work while another window remains focused. It does not bring windows to the foreground, change browser permissions, or implement hard isolation. Task/control tabs close before the original connection tab; a final disconnect can still leave cleanup unverified rather than falsely reported complete.
- before Playwright MCP takes over, any failure (no compatible Node, no npm beside it, an unreachable registry, a Node that will not spawn) is served as a degraded MCP handshake rather than a silent `exit(1)`: `desk-web`'s tools list as unavailable and every call answers with a `status`, a `code` and a `fix`, the same shape `desk`'s own bootstrap uses when it cannot start
- signed-in or persistent browser contexts go through the claims-based browser context broker (`browser-context-broker/`, `desk:cdp-headed-browser`); an overlay supplies the provider and each workspace declares its contexts. Without an overlay provider, add a separate workspace MCP server that runs Playwright MCP with `--extension` (the operator's running browser) or `--user-data-dir`/`--storage-state` (a persistent signed-in profile); `desk:cdp-headed-browser` explains both

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
