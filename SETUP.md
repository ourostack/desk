# Set up Agentic Engineering V2

**Operator:** give your agent the link to this file and say "set this up". Nothing else is needed.

**Agent:** follow these steps in order on the operator's machine. Run the commands yourself. Stop to ask only where a step says **Ask**. Report each step's result in one line.

Desk supports two hosts, Claude Code and Copilot CLI. Follow the section for the operator's host, or both. The setup installs three plugins from this repository, `ourostack/desk`: Desk (durable work state and authority), Superpowers (the engineering method) and Plain Language (prose policy). It binds the operator's desk, a Git repository that holds their durable context. On Claude Code it also leaves Claude's own config directory as a thin pointer to that desk; Copilot needs no pointer, because Desk's session-start hook applies its host settings.

**Claude config directory:** every Claude Code step below reads and writes the directory Claude Code itself uses: `$CLAUDE_CONFIG_DIR` when that variable is set, otherwise `~/.claude`. Resolve it once and use it in every step, so a throwaway or alternate profile never touches the operator's real `~/.claude`:

```bash
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
```

On Windows PowerShell, use `$CLAUDE_DIR = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { "$HOME\.claude" }`. The steps below write this directory as `$CLAUDE_DIR`. Run the `claude` commands in the same environment, because the CLI reads the same variable to find its own directory.

## Claude Code

### 1. Check prerequisites

```bash
claude --version && node --version && git --version && gh --version
```

- Claude Code 2.1.277 or later. If older, run `claude update`. The desktop app bundles its own Claude Code; this check is for the `claude` CLI the setup commands use, which can lag behind the app.
- Node 22 on macOS arm64 or Linux x64, or Node 24 on Windows x64. It does not need to be the default `node`: Desk finds a compatible installed Node on its own. If none is installed, install it yourself (for example `nvm install 22`, or the platform's package manager), and change the default `node` if that helps other tools; involve the operator only for something only they can do, such as a password prompt. Desk ships its native runtime for exactly these platforms; others are unsupported.
- Edge or Chrome for the browser Desk ships. Windows always has Edge. Desk's first browser open downloads `playwright-core` from npm once, so the machine must reach the npm registry that time.
- `gh auth status` should be healthy so desk discovery can find the operator's desk repository. If it is not, give the repair (`gh auth login`) and continue; local discovery still works.

### 2. Install the plugins

```bash
claude plugin marketplace add ourostack/desk
claude plugin install desk@ourostack
claude plugin list
```

Installing Desk pulls in Superpowers and Plain Language. Expect `desk@ourostack`, `superpowers@ourostack` and `plain-language@ourostack` enabled. Desk makes `desk:worker` the default agent for new sessions.

Turn on automatic updates for this marketplace: in `$CLAUDE_DIR/settings.json`, add `"autoUpdate": true` to `extraKnownMarketplaces.ourostack` (the install just created that entry). Leave every other key as it is.

### 3. Set the host defaults

Merge these keys into `$CLAUDE_DIR/settings.json`, preserving everything already there (other tools may own hooks and settings in that file):

```json
{
  "autoMemoryEnabled": false,
  "attribution": { "commit": "", "pr": "", "sessionUrl": false }
}
```

- `autoMemoryEnabled: false` keeps durable context out of Claude's machine-local memory, so it lives in the desk and syncs across machines and harnesses.
- `attribution` removes the AI attribution Claude Code adds to commits and pull requests, including the claude.ai session link cloud and Remote Control sessions otherwise add.

### 4. Make `$CLAUDE_DIR/CLAUDE.md` a thin pointer

The file must contain only this, byte for byte:

```markdown
# Pointer

Durable context — instructions, preferences, task state and memory — lives in the operator's desk, a Git repository, not in this directory. The Desk plugin finds the desk and loads its instructions at the start of every session; follow them.

- Do not use Claude's memory. Record anything worth keeping in the desk.
- Never add AI attribution: no `Co-Authored-By` trailers, no "Generated with" lines and no AI credit in commits, pull requests, code comments or documents.
```

If the file already has other content, or `$CLAUDE_DIR/agents/`, `$CLAUDE_DIR/skills/`, `$CLAUDE_DIR/hooks/` or `$CLAUDE_DIR/projects/*/memory/` hold anything the operator wrote:

1. Copy all of it to a dated backup outside `$CLAUDE_DIR` first.
2. **Ask** the operator whether anything there is still live. Once the desk is bound (step 5), move live rules into the desk's `AGENTS.md` or `_meta/`, and put historical material under the desk's `_archive/`.
3. Remove what was moved or declared obsolete. Leave anything another tool installed (for example hooks pointing at a local service) and say so.

Never delete Claude's own runtime state: session transcripts under `$CLAUDE_DIR/projects/`, history, caches or credentials.

### 5. Find or create the desk

Follow `plugins/desk/skills/first-run-bootstrap/SKILL.md`, Entrance A, from this repository. It looks for an existing local desk, then the operator's desk repository on GitHub.

**Ask:** present what Entrance A found and let a human choose among it, most likely first; with nothing found, offer a fresh desk. A working directory that already has the desk shape is one candidate in that ask, never an automatic bind. A session with no human able to answer stops right at this Ask: it reports the question and everything found, and does not pick an option, bind a desk, write `desk.activation.json`, or report this step complete — that report and stop is what finishing this step looks like for such a session, not something to read past on the way to binding anyway. See the skill's A3 for the exact rule. If the operator already has a V1 desk, use Entrance B instead.

Only once a human has answered this Ask, bind the chosen desk by writing this file, with the absolute desk path:

```json
{ "schema_version": 1, "desk": { "root": "<absolute desk path>" } }
```

to `$CLAUDE_DIR/plugins/data/desk-ourostack/desk.activation.json`, creating the directory if needed. The binding survives plugin updates. It applies wherever a session starts, except in a project folder that is itself a desk (it has `_meta/` plus `_archive/` or `desks/`): a session opened there uses that desk, on Claude Code and Copilot alike.

### 6. Start a new session and verify

Plugins and their MCP servers load when a session starts, so ask the operator to start a new Claude Code session. In it:

- the session runs as `desk:worker`, and the Desk foundation appears at startup;
- `desk_status` reports the bound desk root and its source;
- `desk:session-start` runs normally and offers work to resume or start;
- the `desk-web` server lists `browser_context` and `browser_command`, and opening a `fresh` browser, then running `["goto","https://example.com"]`, shows the page title "Example Domain". Close it afterwards.

The browser is part of the default install, so check it here, but never let it block setup. The first open on a machine can take a minute while Desk installs `playwright-core`. Every failure is a plain sentence that says what to do, for example to install Edge or Chrome, or to check the internet connection. Retry once after the fix. If it still fails, or `example.com` is unreachable, report the browser as not verified, with the error, in your setup report, and continue; the rest of setup does not depend on it.

For a signed-in page, open `browser: "mine"`, which uses a private copy of the operator's own Edge or Chrome profile and deletes it on close.

If any of these fail, `desk_doctor` explains why. Desk never ends setup by being unavailable: with no desk bound it runs in setup mode and routes back to step 5.

### Updating

With `autoUpdate` on, Claude Code picks up new versions at startup. To update now:

```bash
claude plugin marketplace update ourostack
claude plugin update desk@ourostack
```

Claude Code keys its plugin cache on the version string, so a change reaches installed users only when its plugin version is bumped.

## Copilot CLI

Copilot CLI runs Desk through [Agency](https://aka.ms/agency). The steps match the Claude Code ones; Desk's own session-start hook does the host settings, so there is no settings step.

### 1. Check prerequisites

```bash
agency --version && node --version && git --version && gh --version
```

Node, the browser and `gh` need what the Claude Code step 1 lists.

### 2. Install the plugins

```bash
agency plugin install github:ourostack/desk:plugins/desk@main --cache-policy auto --cache-ttl 0 --fetch-mode foreground
agency plugin list
```

Installing Desk pulls in Superpowers and Plain Language (`plugins/desk/agency.json`). `--cache-policy auto --cache-ttl 0 --fetch-mode foreground` makes each new session fetch and load the latest `main` before it starts, so updates need no further step.

### 3. Host settings

Nothing to do by hand. Each Desk session start sets `memory: false` in Copilot's settings (`~/.copilot/settings.json`, or `$COPILOT_HOME/settings.json`), and sets `includeCoAuthoredBy: false` and `askUser: false` once when the operator has not chosen a value: no native memory, no AI co-author trailer and no question form, as Claude Code's step 3 and its worker agent arrange. Each change applies from the next session, and the first session says so in its startup text.

### 4. Find or create the desk

Follow Claude Code step 5's Entrance A and its **Ask**. Copilot has no saved binding file, so bind the chosen desk in one of these ways, most robust first: set `DESK=<absolute desk path>` in the operator's shell profile (Desk then never falls back to another folder), start Copilot from the desk folder, or put the desk at `~/desk`. Desk skips `~/desk` when an overlay such as MS Desk or PWF is loaded, so use `DESK` there. `desk_status` reports which one bound it.

### 5. Start a new session and verify

```bash
agency copilot --agent desk:worker
```

Copilot has no setting that picks a default agent for every session, so start with `--agent desk:worker`; a session started without it still gets the Desk foundation and a startup line telling it to read the worker's instructions, but not the worker agent itself. Then check the same list as Claude Code step 6. Copilot names Desk's tools `desk-<name>`, for example `desk-desk_status`.

## Other hosts

- **Codex:** Desk does not support Codex and ships no Codex manifests ([RFC section 8](plugins/desk/docs/agentic-engineering-v2-rfc.md#8-limits)).
- **Ouroboros:** see `plugins/desk/README.md` ("Under Ouroboros").

The host defaults and the no-attribution rule above apply on every host; set them wherever that host keeps its user configuration.
