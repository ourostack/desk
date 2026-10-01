# Codex and Copilot host-enforcement live proof

Desk-only enforcement (spec §5 of the `agents-never-fight-the-desk` design) denies a
short list of durable/alternative-UI host surfaces through a `PreToolUse`-family
hook. [Part 7](../mcp/src/runtime/host-enforcement.js) verified the mechanism
against Claude Code directly. This page records the same direct verification for
Codex CLI and Copilot CLI: exact commands run, exact payloads captured, and the
one open gap (Codex hook trust) that changes what Desk can honestly claim.

Every claim below was produced by installing each CLI fresh into a throwaway
profile (`CODEX_HOME` / Copilot's home override), pointed at a synthetic
directory, and triggering a real tool call — never the operator's own Codex or
Copilot configuration, never a real desk.

## Codex CLI

### Hook registration: `config.toml` schema

Discovered by deliberately feeding malformed values under `codex exec
--strict-config` and reading the Rust deserializer's own error messages — a
technique that needs no auth or network, since the config parser rejects before
any connection attempt.

```toml
[hooks]
PreToolUse = [
  { matcher = "*", hooks = [ { type = "command", command = "/path/to/script" } ] }
]
```

- `hooks.PreToolUse` is an array of `MatcherGroup { matcher: String, hooks: Sequence }`
  — the same two field names Claude Code's `hooks.json` uses.
- The field name is exactly `PreToolUse`, PascalCase. A snake_case `pre_tool_use`
  key is silently ignored — this is easy to get wrong on a first pass, since
  TOML files are otherwise conventionally snake_case.
- Each hook handler is an internally-tagged enum on `type`, with four real
  variants: `command`, `mcp_tool`, `prompt`, `agent`. The `command` variant
  requires one string field, `command`.

### `PreToolUse` stdin shape

Real captured stdin from a fired hook, during a real Codex turn that called its
shell tool:

```json
{
  "session_id": "<uuid>",
  "turn_id": "<uuid>",
  "transcript_path": "<path>",
  "cwd": "<path>",
  "hook_event_name": "PreToolUse",
  "model": "<model id>",
  "permission_mode": "bypassPermissions",
  "tool_name": "Bash",
  "tool_input": { "command": "echo hello" },
  "tool_use_id": "<id>"
}
```

Field names are **snake_case** (`hook_event_name`, `tool_name`, `tool_input`,
`session_id`, `turn_id`), even though the config keys that register the hook are
PascalCase. The shell tool's `tool_name` is `"Bash"` — the same string Claude
Code uses.

### Deny response: exit code 2, not JSON

Codex's deny mechanism is **not** the `{"permissionDecision": "deny",
"permissionDecisionReason": "..."}` JSON shape Claude Code and Copilot both use.
Tried and falsified, in this order:

1. `{"decision":"deny","reason":"..."}` on stdout, exit 0 → the hook is recorded
   as **"PreToolUse Failed"** in the transcript, and the tool call still runs
   (an unparsed response fails open).
2. `{"permissionDecision":"deny","permissionDecisionReason":"..."}` on stdout,
   exit 0 → same result: **"PreToolUse Failed"**, tool call still runs.
3. Plain text to stderr, **exit code 2**, nothing on stdout → **this is the real
   mechanism.** The transcript shows `PreToolUse Blocked`, and the model is told
   the exact stderr text as the reason the tool call did not run.

**Codex denies a `PreToolUse` tool call when the hook process exits with status
2; the reason is whatever the hook wrote to stderr.** This is a UNIX-exit-code
convention, not a structured-output convention, and it is materially different
from Claude Code's and Copilot's JSON `permissionDecision` shape.

### MCP tool naming

An MCP tool's `tool_name` on the wire is `mcp__<server>__<tool>` — the identical
double-underscore convention Claude Code uses. A hook's `matcher` can name one
directly (`matcher = "mcp__everything__echo"`), and it fires and blocks the real
call. Statically, `mcp_servers.<id>.enabled_tools` and
`mcp_servers.<id>.disabled_tools` are both real, `deny_unknown_fields`-enforcing
array fields — confirmed by the same strict-config type-probing technique, with
a deliberately misspelled field name rejected as unknown to rule out a false
positive.

### Memory keys and defaults

`codex features list` against a fresh, un-overridden `CODEX_HOME` reports
`features.memories` as **stable, defaulting to `false`** — this is the master
gate, the direct analog of Claude Code's `autoMemoryEnabled: false`. Separately,
`[memories]` is its own real, `deny_unknown_fields`-enforcing top-level table,
and `use_memories` is a genuine field of it; toggling it does not change what
`codex features list` reports, so the two are independent settings. A fresh
`CODEX_HOME` provisions a memory store file on first login regardless of the
feature flag's value. `memories.use_memories`'s own shipped default could not be
independently confirmed (no command dumps the fully-resolved config); pinning
`features.memories = false` is the confirmed, sufficient gate.

### Hook trust: no supported, automatable grant exists

`codex --help` documents `--dangerously-bypass-hook-trust`: "Run enabled hooks
without requiring persisted hook trust for this invocation. DANGEROUS." Running
the identical hook config and a real prompt through non-interactive `codex exec`
**without** that flag produces no hook firing at all — no log line, no error, no
warning; the tool call simply runs as though no hook were configured. This
silent skip is a fail-open with zero signal, not a denial.

Three angles were tried to find a persisted, non-interactive trust grant, and
all three came back negative:

1. **A `config.toml` field on the hook entry itself.** None of `trust`,
   `trusted`, `require_trust`, `auto_trust`, `skip_trust`, `requires_trust` is
   a recognized field (all silently ignored under `--strict-config`, none
   produced a type error the way a real field does).
2. **Marking the working directory as a trusted project.** Codex does have a
   real, `--strict-config`-recognized `[projects."<path>"] trust_level =
   "trusted"` table. Setting it for the exact directory a hook-firing prompt
   ran in, then repeating the same real tool call without
   `--dangerously-bypass-hook-trust`, still produced no hook firing — project
   trust and hook trust are independent; one does not grant the other.
3. **A persisted trust record on disk.** The installed binary's own string
   table names a `HookStateToml` struct with fields `matcher`, `hooks`,
   `enabled`, `trusted_hash` — strong evidence that Codex's interactive TUI can
   record a per-hook trust decision, hashed to the hook's own content, so a
   later edit to the hook command re-asks. No file or SQLite table holding this
   state appeared anywhere under a fresh `CODEX_HOME` after either experiment
   above, including after the one-time `--dangerously-bypass-hook-trust` run —
   consistent with this state only ever being written by an interactive
   approval prompt, which a non-interactive `codex exec` invocation never
   renders and never gets asked.

**Conclusion:** there is no config value, environment variable, or file Desk's
Codex activation can write ahead of time to make a hook trusted for an
unattended or scripted Codex invocation. The only way to satisfy this
version's hook-trust gate at all is `--dangerously-bypass-hook-trust` on every
invocation, or an interactive approval Desk cannot trigger on the operator's
behalf and would not want to fabricate. Desk's Codex activation registers the
`PreToolUse` hook anyway, because the wiring is correct and forward-compatible
(a future Codex release, or a real interactive approval, may make it fire) —
but `desk_status` and the boot check report Codex host-enforcement as
**registered, not active**, rather than claiming a deny hook is protecting the
session when it silently is not.

## Copilot CLI

### `memory` / `includeCoAuthoredBy` defaults

Directly from the installed CLI's own bundled help (`copilot help config`):

- `memory`: whether to enable agentic memory (cross-session fact recall);
  **defaults to `true`.** Toggled with `/memory on|off`.
- `includeCoAuthoredBy`: whether to instruct the agent to add a
  `Co-authored-by` trailer to git commits; **defaults to `true`.**

(`copilot --help`'s separate `--enable-memory` flag, documented "disabled by
default," is a narrower default specific to non-interactive `-p` mode and does
not contradict the interactive default above.)

### Hook discovery: plugin-declared hooks fire only when `plugin.json` declares the key

Tested as a real, decisive experiment: a minimal throwaway plugin with a real
`preToolUse` hook entry, loaded two ways.

- **Trial A — no `hooks` key in the throwaway plugin's manifest:** the hook
  file was present on disk, the plugin listed as enabled, but a real prompt
  that triggered the shell tool never fired the hook — no log line, no denial,
  no error.
- **Trial B — same plugin, manifest declares `"hooks": "./hooks/copilot-hooks.json"`:**
  the identical prompt and hook script fired for real.

**A plugin's own hooks file is discovered directly by Copilot's plugin loader,
conditioned on the manifest actually declaring the `hooks` key.** Bare file
presence is not enough.

Checked against this desk plugin's own manifest as shipped: Copilot loads
`plugins/desk/plugin.json` (the flat, root-level manifest — not
`plugins/desk/.claude-plugin/plugin.json`, which is Claude Code's own, separate
manifest and carries no `hooks` key at all because Claude Code discovers
`hooks/hooks.json` by convention, with no manifest key required). The Copilot
manifest already declares `"hooks": "./hooks/copilot-hooks.json"`, so Copilot's
enforcement wiring is not blocked by the manifest-discovery gap this proof set
out to check.

### `preToolUse` stdin and deny shape

Stdin captured from a real fired hook:

```json
{"sessionId":"<id>","timestamp":0,"cwd":"<path>","toolName":"bash","toolArgs":{"command":"echo hello"}}
```

Field names are **camelCase** (`sessionId`, `timestamp`, `cwd`, `toolName`,
`toolArgs`), with no `hookEventName` field. The shell tool's `toolName` is
lowercase `"bash"` (contrast Codex's `"Bash"`).

Deny shape — the camelCase JSON candidate worked on the first try, unlike
Codex:

```json
{"permissionDecision":"deny","permissionDecisionReason":"<text>"}
```

printed to stdout, exit 0. **Confirmed: Copilot CLI's real deny shape is
exactly `{"permissionDecision": "deny", "permissionDecisionReason": "<text>"}`**
— matching Claude Code's own shape, flat with no `hookSpecificOutput` wrapper.

### MCP tool naming

Two independent deny mechanisms, with one naming gotcha:

- **The `--deny-tool` CLI flag** takes `<server>(<tool>)`, e.g.
  `--deny-tool='everything(echo)'` — confirmed against a real registered MCP
  server and a real call.
- **The same `preToolUse` hook**, matching on `toolName`. A real MCP tool call
  produced `"toolName":"everything-echo"` — **hyphen-joined** (`<server>-<tool>`),
  not the `mcp__<server>__<tool>` double-underscore convention Claude Code and
  Codex both use, and not the `Server(tool)` parenthetical syntax the
  `--deny-tool` flag itself uses.

Three different naming conventions for the same concept exist across the three
surfaces (Claude/Codex hook `tool_name`, Copilot hook `toolName`, Copilot
CLI-flag pattern) — a `matcher`/tool-name string written for one host is never
assumed to match on another.

### Hooks beyond `preToolUse` (Copilot CLI 1.0.89, live-checked)

- `toolArgs` is an object for `bash` (`{ command, description }`), `create` (`{ path, file_text }`) and `edit` (`{ path, old_str, new_str }`), and the raw patch text (`*** Begin Patch ...`) for `apply_patch`. Which of these a model uses depends on the model: Claude models edit with `create` and `edit`, GPT models with `apply_patch`.
- A flat deny from `preToolUse` reaches the model as `Denied by preToolUse hook: <reason>` (the tool result carries code `denied`).
- `postToolUse` adds `toolResult: { resultType, textResultForLlm }`; an MCP call is `<server>-<tool>`, such as `desk-task_update`.
- `userPromptSubmitted` input is `{ sessionId, timestamp, cwd, prompt }`; `sessionStart` input is `{ sessionId, timestamp, cwd, source, initialPrompt }`. Neither carries an attended-or-not flag, so the ask gate cannot be wired.
- Hook order on a new session (Copilot CLI 1.0.89, headless `-p` and interactive, read from the session's own `events.jsonl`): `userPromptSubmitted` for the first prompt runs first, then the user message is logged, then `sessionStart` runs. A first-prompt hook therefore cannot rely on `sessionStart` having run. Output of `userPromptSubmitted` `additionalContext` reaches the model as a `<system_reminder>` appended to the message (visible as `transformedContent` of the `user.message` event); `sessionStart` `additionalContext` reaches the model too but leaves no trace in the message.
- `sessionStart` context is weighed lightly: on a bare greeting ("hi") the model answered without booting, in boot acceptance rounds F, G and H. The same boot imperative returned as `userPromptSubmitted` `additionalContext` was followed every time it reached the model. The pointer hook originally waited for the `sessionStart` hook's record, which on a new session does not exist yet at the first prompt, so it only ever fired on a resumed turn. It now claims once per session id in its own file (an exclusive create, so no record write can drop it), and only for a folder that resolves to a usable desk, the way `sessionStart` resolves it; a folder that is no desk gets no pointer and claims nothing. A resumed session is directed again: `sessionStart` with `source: "resume"` clears the claim, and because Copilot runs the prompt hook before `sessionStart`, the pointer arrives on the next prompt. The boot acceptance harness saves the session's hook events (`copilot-events.jsonl`) and reports whether the pointer reached the model in each run's `summary.json` `gates`.
- `agentStop` input is `{ sessionId, timestamp, cwd, transcriptPath, stopReason, stop_hook_active }` and fires for the main agent only. `{ "decision": "block", "reason": "..." }` continues the agent with the reason as a follow-up message, and the next stop has `stop_hook_active: true`. The reply is not in the payload, and the transcript does not hold it when the hook starts; it appears about 200 ms later.
- Hooks run with the plugin folder as their working folder and receive `COPILOT_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`, `COPILOT_PLUGIN_ROOT` and `COPILOT_PLUGIN_DATA`; an MCP server receives none of the project or plugin-data variables, has the plugin folder as its working folder, and gets only `COPILOT_AGENT_SESSION_ID` (equal to the hooks' `sessionId`) as a per-session value. Copilot starts MCP servers before it fires `sessionStart`. `roots/list` answers an empty list.

## Summary table

| Question | Answer |
| --- | --- |
| Codex hook `config.toml` schema | `[hooks] PreToolUse = [{ matcher, hooks = [{ type = "command", command }] }]`; `type` ∈ `command`, `mcp_tool`, `prompt`, `agent` |
| Codex `PreToolUse` stdin shape | snake_case: `hook_event_name`, `tool_name` (`"Bash"` / `"mcp__server__tool"`), `tool_input`, `session_id`, `turn_id`, `cwd`, `model`, `permission_mode` |
| Codex deny response | exit code 2 + stderr text — not a JSON `permissionDecision` shape |
| Codex MCP deny by name | hook `matcher` on `mcp__server__tool`, or config `mcp_servers.<id>.enabled_tools`/`disabled_tools` |
| Codex `features.memories` | stable, defaults `false` — the operative gate to pin |
| Codex hook trust | no supported, automatable grant; untrusted hooks are silently skipped without `--dangerously-bypass-hook-trust`; project trust and a persisted `trusted_hash` (interactive-only, unconfirmed to be reachable non-interactively) are both distinct from it |
| Copilot plugin-hooks discovery | discovered directly by the plugin loader, only when `plugin.json` declares `"hooks": "<path>"`; this desk plugin's Copilot manifest already declares it |
| Copilot `preToolUse` stdin shape | camelCase: `sessionId`, `timestamp`, `cwd`, `toolName` (`"bash"` / `"server-tool"`), `toolArgs` |
| Copilot deny response | `{"permissionDecision":"deny","permissionDecisionReason":"<text>"}` on stdout, exit 0 |
| Copilot MCP deny by name | `--deny-tool='server(tool)'` CLI flag, or hook `toolName` match on `server-tool` |
| Copilot `memory` / `includeCoAuthoredBy` defaults | both default `true` |

## What remains open

- `memories.use_memories`'s own shipped default (Codex) — no command dumps the
  fully-resolved config; `features.memories = false` is the confirmed,
  sufficient gate regardless.
- Whether a real, human-attended interactive Codex session ever renders a hook
  trust approval prompt that persists a usable `trusted_hash` — not exercised
  here, since it requires a human answering a TUI prompt and would not change
  what Desk's own (unattended) activation can establish ahead of time.
- A `UserPromptSubmit`-equivalent event for `naming-allowlist.js`'s "named by
  the operator this session" exception (spec's controller ruling 3): Copilot's
  own hooks reference names a `userPromptSubmitted` event, but this pass never
  fired one live, so its stdin field names (a `sessionId`/`prompt` shape is
  assumed, not confirmed) are unverified. Codex's own hooks reference was not
  exhaustively re-checked for a prompt-submit-equivalent event at all. Given
  neither is confirmed, Part 8 does not wire `desk-naming.cjs` for either
  host: shipping it against a guessed payload shape would risk a silent no-op
  that looks wired but never actually populates the session allowlist, which
  is worse than the documented gap it would paper over. `UserPromptSubmit`
  stays Claude-Code-only until a live-fired Copilot or Codex payload confirms
  the real field names. (Update: Copilot's `userPromptSubmitted` payload is now
  confirmed, `{ sessionId, timestamp, cwd, prompt }`, and the done-claim gate uses
  it; `desk-naming.cjs` stays unwired because Copilot's tool names for the denied
  surfaces are still unconfirmed, so its allowlist would have nothing to allow.)
- Codex supports hooks, but an untrusted hook is silently skipped and its edit
  tool's payload has not been seen live, so the card guard and the done-claim gate
  are not wired for Codex.
