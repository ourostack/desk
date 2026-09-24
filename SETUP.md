# Set up Agentic Engineering V2

**Operator:** give your agent the link to this file and say "set this up". Nothing else is needed.

**Agent:** follow these steps in order on the operator's machine. Run the commands yourself. Stop to ask only where a step says **Ask**. Report each step's result in one line. Use the branch or ref in the link you were given wherever this page says `<ref>`: today that is `v2-alpha`.

The setup installs three plugins from this repository: Desk (durable work state and authority), Superpowers (the engineering method) and Plain Language (prose policy). It binds the operator's desk, a Git repository that holds their durable context, and it leaves the host's own config directory as a thin pointer to that desk.

## Claude Code

### 1. Check prerequisites

```bash
claude --version && node --version && git --version && gh --version
```

- Claude Code 2.1.277 or later. If older, run `claude update`. The desktop app bundles its own Claude Code; this check is for the `claude` CLI the setup commands use, which can lag behind the app.
- Node 22 installed on macOS arm64 or Linux x64, or Node 24 on Windows x64. It does not need to be the default `node`: Desk finds a compatible installed Node on its own. Desk ships its native runtime for exactly these platforms; others are unsupported.
- `gh auth status` should be healthy so desk discovery can find the operator's desk repository. If it is not, give the repair (`gh auth login`) and continue; local discovery still works.

### 2. Install the plugins

```bash
claude plugin marketplace add ourostack/ouroboros-skills#<ref>
claude plugin install desk@ouroboros-skills
claude plugin list
```

Installing Desk pulls in Superpowers and Plain Language. Expect all three enabled. Desk makes `desk:worker` the default agent for new sessions.

Turn on automatic updates for this marketplace: in `~/.claude/settings.json`, add `"autoUpdate": true` to `extraKnownMarketplaces.ouroboros-skills` (the install just created that entry). Leave every other key as it is.

### 3. Set the host defaults

Merge these keys into `~/.claude/settings.json`, preserving everything already there (other tools may own hooks and settings in that file):

```json
{
  "autoMemoryEnabled": false,
  "attribution": { "commit": "", "pr": "" }
}
```

- `autoMemoryEnabled: false` keeps durable context out of Claude's machine-local memory, so it lives in the desk and syncs across machines and harnesses.
- `attribution` removes the AI attribution Claude Code adds to commits and pull requests.

### 4. Make `~/.claude/CLAUDE.md` a thin pointer

The file must contain only this, byte for byte:

```markdown
# Pointer

Durable context — instructions, preferences, task state and memory — lives in the operator's desk, a Git repository, not in this directory. The Desk plugin finds the desk and loads its instructions at the start of every session; follow them.

- Do not use Claude's memory. Record anything worth keeping in the desk.
- Never add AI attribution: no `Co-Authored-By` trailers, no "Generated with" lines and no AI credit in commits, pull requests, code comments or documents.
```

If the file already has other content, or `~/.claude/agents/`, `~/.claude/skills/`, `~/.claude/hooks/` or `~/.claude/projects/*/memory/` hold anything the operator wrote:

1. Copy all of it to a dated backup outside `~/.claude` first.
2. **Ask** the operator whether anything there is still live. Once the desk is bound (step 5), move live rules into the desk's `AGENTS.md` or `_meta/`, and put historical material under the desk's `_archive/`.
3. Remove what was moved or declared obsolete. Leave anything another tool installed (for example hooks pointing at a local service) and say so.

Never delete Claude's own runtime state: session transcripts under `~/.claude/projects/`, history, caches or credentials.

### 5. Find or create the desk

Follow `plugins/desk/skills/first-run-bootstrap/SKILL.md`, Entrance A, from this repository at `<ref>`. It looks for an existing local desk, then the operator's desk repository on GitHub, and **asks** once with what it found; with nothing found it offers a fresh desk. If the operator already has a V1 desk, use Entrance B instead.

Bind the chosen desk by writing this file, with the absolute desk path:

```json
{ "schema_version": 1, "desk": { "root": "<absolute desk path>" } }
```

to `~/.claude/plugins/data/desk-ouroboros-skills/desk.activation.json`, creating the directory if needed. If the operator uses `CLAUDE_CONFIG_DIR`, the path is relative to that directory instead of `~/.claude`. The binding survives plugin updates.

### 6. Start a new session and verify

Plugins and their MCP servers load when a session starts, so ask the operator to start a new Claude Code session. In it:

- the session runs as `desk:worker`, and the Desk foundation appears at startup;
- `desk_status` reports the bound desk root and its source;
- `desk:session-start` runs normally and offers work to resume or start.

If any of these fail, `desk_doctor` explains why. Desk never ends setup by being unavailable: with no desk bound it runs in setup mode and routes back to step 5.

### Updating

With `autoUpdate` on, Claude Code picks up new versions at startup. To update now:

```bash
claude plugin marketplace update ouroboros-skills
claude plugin update desk@ouroboros-skills
```

Claude Code keys its plugin cache on the version string, so a change reaches installed users only when its plugin version is bumped.

## Other hosts

- **Codex:** see `plugins/desk/README.md` ("Under Codex") and `desk:codex-onboarding`; the activation adapter binds the desk and owns the instruction block.
- **Copilot CLI and Ouroboros:** see `plugins/desk/README.md` for the admitted compositions.

The host defaults and the no-attribution rule above apply on every host; set them wherever that host keeps its user configuration.
