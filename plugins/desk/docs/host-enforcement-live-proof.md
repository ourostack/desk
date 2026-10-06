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

## Sign-off witness

No hook was seen firing in a live session for any case in this section (the Copilot hooks recorded earlier in this file were live-checked; the sign-off cases here were not). No `claude`, `copilot` or `codex` process was started for this section. It rests on four things, and every cell below says which:

- `proven`: a fixture run of our own code (the `isHumanPromptLine` predicate in `src/factory/derive-claude.js`, `claudeShapedPayload` and `mcpToolName` in `src/runtime/copilot-hook-payload.js`) with fixture inputs written by hand. The interrupt-marker fixture is written from the structure probe below, not from a transcript.
- `observed`: seen in the structure probe of real Claude Code transcripts on this machine (enum codes and counts only, below).
- `documented, not run live`: the host's published page says so. Pages: https://code.claude.com/docs/en/hooks and https://docs.github.com/en/copilot/reference/hooks-configuration, read in full.
- `unproven`: none of the above. D3 treats every cell that is not `proven` or `observed` as failing closed: the sign-off is recorded `unverified`. The rule has no exception: nothing that is only documented is relied on to give `verified`.

### The questions

| # | Question | Claude Code | Copilot CLI | What D3 does |
| --- | --- | --- | --- | --- |
| 1 | Does the prompt hook fire when a scheduled wake-up, a background-task notification or a stop-hook continuation starts a turn? | `documented, not run live`: "`UserPromptSubmit` hooks don't fire only on prompts you type. Claude Code also runs them on: A scheduled task firing, including a `/loop` iteration; A background subagent reporting back to the session that started it; A message another session sends to your main conversation". The page does not list a stop-hook continuation or a background shell notification. | `unproven`: the page says only that `userPromptSubmitted` fires on a prompt submit; it is silent on scheduled and autopilot turns. It says `userPromptTransformed` is never triggered by system notifications, lists a separate `notification` hook with types `shell_completed`, `agent_completed` and `agent_idle`, and says `userPromptSubmitted` fires at most once in a Copilot cloud agent job (that sentence is about the cloud agent, not the CLI). None of that proves what `userPromptSubmitted` does. | The prompt hook is no witness of a human. Keep it only to record a time. Claude Code: `verified` needs the last prompt-like root line of the transcript to carry `origin.kind` exactly `human`. Copilot: see question b. |
| 2 | Does `PreToolUse` fire for an MCP tool a subagent calls, and does the payload carry a marker? | `documented, not run live`: "When a subagent calls a tool, tool events such as `PreToolUse` and `PostToolUse` fire the same configured hooks as in the main conversation, and the input carries the `agent_id` and `agent_type` common input fields". `agent_id` is "Present only when the hook fires inside a subagent call". | `unproven`: the `preToolUse` input is `sessionId`, `timestamp`, `cwd`, `toolName`, `toolArgs`, with no marker. `agentId` appears only in `subagentStop` input, and the page says the built-in `general-purpose` agent emits no `subagentStart` or `subagentStop` at all. | Claude Code: a payload with `agent_id` is denied. Without one, the ticket says the main agent called only when the root transcript holds a root assistant line with a `tool_use` block whose id equals the payload's `tool_use_id`; otherwise the sign-off is `unverified` as `subagent_not_ruled_out`. Copilot: every sign-off is `unverified` with the reason `subagent_not_ruled_out` until a live probe finds a subagent marker on `preToolUse`. |
| 3 | Is the human prompt's line in the transcript by the time `PreToolUse` runs for a tool in that turn? | `unproven`: the page warns that the transcript "is written asynchronously and may lag the in-memory conversation, so it may not yet include the current turn's most recent messages when a hook fires". It names no guarantee for `PreToolUse`. | `unproven`: no page statement. Our own live check (above) found the first prompt's hook runs before the message is logged. | Do not rely on the current turn's line being there. Claude Code: the verdict uses the timestamp of the last `origin.kind: human` line, and the hook's own prompt record must be no more than 30 seconds later than that line, else `not_human_origin`. Copilot: unverified anyway. |
| 4 | Does the Stop hook fire when the human interrupts a turn? | `documented, not run live`: it does not. "Does not run if the stoppage occurred due to a user interrupt." API errors fire `StopFailure` instead. | `unproven`: `agentStop` input has `stopReason: "end_turn"` only; the page is silent on an interrupt. | A stop record cannot be relied on to end a turn. D3 does not read "no stop since the prompt" as proof that no interrupt happened. |
| 5 | Does an interrupt leave a line that passes `isHumanPromptLine`? | `proven` by fixture run, and `observed`: the line passes, and real interrupt lines carry no `origin` (16 lines). | `unproven`: what an interrupt leaves in Copilot's event log is not known. | Claude Code: an interrupt marker is not human, because `verified` needs `origin.kind` exactly `human`, which the marker lacks. |
| a | Does the prompt hook fire for scheduled wake-ups and system notifications? | `documented, not run live` for a scheduled task, a background subagent report and another session's message (question 1). `observed`: the transcript records a background-task notification with `promptSource: "system"` and `origin.kind: "task-notification"`, and another session's message with `isMeta: true` and `origin.kind: "peer"`. | `unproven` (question 1). | Same as question 1. |
| b | Can a subagent's `task_signoff` call be told apart on Copilot? | Not applicable. | `unproven`: no marker on `preToolUse`. `claudeShapedPayload` also drops an `agentId` key if one arrived (fixture run: the output keys are `cwd`, `session_id`, `stop_hook_active`, `tool_input`, `tool_name`, `tool_response`, `transcript_path`). | Every Copilot sign-off is `unverified`, reason `subagent_not_ruled_out`; `mainAgent` there is `null`, which the verdict treats as not proven. The prompt record, stop record and `source` check are still built. |

### Payload key names

Key names only, never values.

| Host | Hook | Keys per the host's page | Keys our parsers read |
| --- | --- | --- | --- |
| Claude Code | every hook (common) | `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort`, `hook_event_name`; inside a subagent or with `--agent` also `agent_id`, `agent_type` | `done-claim-gate.js`: `session_id`, `cwd`, `agent_id`, `hook_event_name`, `transcript_path` |
| Claude Code | `UserPromptSubmit` | common plus `prompt`, and `session_title` when the session has a custom title | `desk-naming.cjs`: `prompt`; the gate: `session_id`, `cwd` |
| Claude Code | `PreToolUse` | common plus `tool_name`, `tool_input`, `tool_use_id`; for an MCP tool also `mcp_server` (`name`, `source`) | `tool_name`, `tool_input`; D3 will read `agent_id` and `tool_use_id` |
| Claude Code | `Stop` | common plus `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | `stop_hook_active`, `last_assistant_message`, `transcript_path`, `session_id` |
| Claude Code | `SubagentStop` | common plus `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` | `hook_event_name: "SubagentStop"`, `agent_id` |
| Copilot CLI | `userPromptSubmitted` | `sessionId`, `timestamp`, `cwd`, `prompt` (the VS Code form: `hook_event_name`, `session_id`, `timestamp`, `cwd`, `prompt`) | `claudeShapedPayload`: `sessionId`, `cwd` |
| Copilot CLI | `preToolUse` | `sessionId`, `timestamp`, `cwd`, `toolName`, `toolArgs` (VS Code form: `hook_event_name`, `session_id`, `timestamp`, `cwd`, `tool_name`, `tool_input`) | `sessionId`, `cwd`, `toolName`, `toolArgs` |
| Copilot CLI | `postToolUse` | the `preToolUse` keys plus `toolResult` (`resultType`, `textResultForLlm`), per the live check recorded earlier in this file (Copilot CLI 1.0.89) | adds `toolResult.textResultForLlm` |
| Copilot CLI | `agentStop` | `sessionId`, `timestamp`, `cwd`, `transcriptPath`, `stopReason` (`"end_turn"`), `stop_hook_active` | `sessionId`, `cwd`, `transcriptPath`, `stop_hook_active` (also `stopHookActive`) |
| Copilot CLI | `subagentStart` | `sessionId`, `timestamp`, `cwd`, `transcriptPath`, `agentName`, `agentDisplayName`, `agentDescription` | not parsed; not registered in `copilot-hooks.json` |
| Copilot CLI | `subagentStop` | `sessionId`, `timestamp`, `cwd`, `transcriptPath`, `agentId`, `agentType`, `agentName`, `agentDisplayName`, `response`, `stopReason` | not parsed; not registered |
| Copilot CLI | MCP server environment | not applicable | `COPILOT_AGENT_SESSION_ID` (`src/runtime/copilot-session.js`) |

Two things D3 must do in our own code, found by fixture run: `isTaskToolName` and `mcpToolName` in `copilot-hook-payload.js` know only `task_update`, `task_create`, `task_move` and `task_archive`, so `mcpToolName("desk-task_signoff")` returns `desk-task_signoff` unchanged; and `claudeShapedPayload` drops any `agentId`.

### `isHumanPromptLine` on each fixture line

Produced by a throwaway script that extracts the real `classifyUserContent` and `isHumanPromptLine` source text from `derive-claude.js` and runs it (no product code changed). Text values are placeholders.

```
PASS    typed prompt
PASS    typed prompt, no origin keys
REJECT  tool result
REJECT  isMeta hook output
REJECT  compaction summary
REJECT  system wake-up (promptSource system)
REJECT  task notification (origin.kind task-notification)
PASS    system notification with no marker key
PASS    interrupt marker
PASS    interrupt marker for tool use
```

The predicate rejects a line only when the line carries a marker (`isMeta`, `isCompactSummary`, `promptSource: "system"`, an `origin.kind` other than `human`). The structure probe below confirms that real interrupt marker lines and real headless prompts carry no `origin`, so both pass today's predicate. Only `origin.kind === "human"` is a positive mark of a human prompt.

### Structure probe of real transcripts

The package lead ran `structure-probe.mjs` over the 60 most recently changed root Claude Code transcript files on this machine. It printed only counts per combination of host enum codes on root `user` lines that are not all tool results, and the key names seen on those lines. A value was printed only when it is a boolean or matches `^[a-z_-]{1,32}$`; no text, path or identifier was printed or kept. The interrupt column is the result of a prefix comparison against the fixed host marker `[Request interrupted by user`; the text was not kept. Result (2026-10-05):

```
  1142 shape=string interrupt=false isMeta=absent compact=absent promptSource=system origin.kind=task-notification entrypoint=cli
   736 shape=string interrupt=false isMeta=absent compact=absent promptSource=system origin.kind=task-notification entrypoint=claude-desktop
   488 shape=string interrupt=false isMeta=absent compact=absent promptSource=typed origin.kind=human entrypoint=cli
   216 shape=string interrupt=false isMeta=absent compact=absent promptSource=sdk origin.kind=human entrypoint=claude-desktop
   191 shape=string interrupt=false isMeta=true compact=absent promptSource=system origin.kind=absent entrypoint=cli
   118 shape=blocks interrupt=false isMeta=true compact=absent promptSource=absent origin.kind=absent entrypoint=cli
    68 shape=string interrupt=false isMeta=true compact=absent promptSource=system origin.kind=peer entrypoint=cli
    66 shape=blocks interrupt=false isMeta=absent compact=absent promptSource=typed origin.kind=human entrypoint=cli
    57 shape=string interrupt=false isMeta=true compact=absent promptSource=absent origin.kind=absent entrypoint=cli
    40 shape=string interrupt=false isMeta=true compact=absent promptSource=absent origin.kind=absent entrypoint=claude-desktop
    36 shape=string interrupt=false isMeta=absent compact=true promptSource=absent origin.kind=absent entrypoint=cli
    33 shape=string interrupt=false isMeta=absent compact=absent promptSource=sdk origin.kind=absent entrypoint=sdk-cli
    32 shape=blocks interrupt=false isMeta=true compact=absent promptSource=absent origin.kind=absent entrypoint=claude-desktop
    22 shape=string interrupt=false isMeta=absent compact=absent promptSource=absent origin.kind=absent entrypoint=cli
    21 shape=string interrupt=false isMeta=absent compact=absent promptSource=queued origin.kind=human entrypoint=cli
    14 shape=blocks interrupt=true isMeta=absent compact=absent promptSource=absent origin.kind=absent entrypoint=cli
     8 shape=blocks interrupt=false isMeta=absent compact=absent promptSource=sdk origin.kind=human entrypoint=claude-desktop
     7 shape=string interrupt=false isMeta=true compact=absent promptSource=system origin.kind=peer entrypoint=claude-desktop
     5 shape=string interrupt=false isMeta=absent compact=true promptSource=absent origin.kind=absent entrypoint=claude-desktop
     4 shape=string interrupt=false isMeta=absent compact=absent promptSource=suggestion_accepted origin.kind=human entrypoint=cli
     3 shape=string interrupt=false isMeta=true compact=absent promptSource=system origin.kind=absent entrypoint=claude-desktop
     2 shape=blocks interrupt=true isMeta=absent compact=absent promptSource=absent origin.kind=absent entrypoint=claude-desktop
     2 shape=blocks interrupt=false isMeta=true compact=absent promptSource=absent origin.kind=absent entrypoint=sdk-cli
keys: cwd entrypoint gitBranch imagePasteIds interruptedMessageId isCompactSummary isMeta isSidechain isVisibleInTranscriptOnly message origin parentUuid permissionMode promptId promptSource queuePriority queueSkipAttachments queueTranscriptOnly scheduledFireId scheduledTaskId sessionId session_id slug sourceToolUseID timestamp turnCompanion turnOrigin turnPosition type userType uuid version
```

What it shows (`observed`):

- A prompt a human typed, queued or accepted from a suggestion carries `origin.kind: "human"` on every line seen (terminal: `promptSource` `typed`, `queued` or `suggestion_accepted`; desktop app: `sdk`). 803 lines, no exception.
- A background-task notification carries `promptSource: "system"` and `origin.kind: "task-notification"`. A message from another session carries `isMeta: true` and `origin.kind: "peer"`.
- The interrupt marker line is a block line with no `promptSource`, no `origin` and no `isMeta` (16 lines). It passes today's `isHumanPromptLine`.
- A headless run (`entrypoint: "sdk-cli"`) writes its prompt with `promptSource: "sdk"` and no `origin` (33 lines). No human typed it, and it passes today's `isHumanPromptLine`.
- 22 terminal string lines carry no marker at all; what wrote them is not known.
- So "origin is human or absent" lets through two known kinds of line no human typed in that turn (the interrupt marker and the headless prompt), plus 22 lines of unknown origin. Only `origin.kind === "human"` is a positive mark of a human prompt.

### Still unproven, needs a live run

For the final verification:

- Whether the current turn's prompt line is in the transcript when `PreToolUse` runs (the Claude Code page says the transcript may lag).
- Whether the assistant line that holds the `task_signoff` tool call is in the root transcript by the time `PreToolUse` runs. D3's proof of a main-agent call depends on it; if it fails, every Claude Code sign-off reads `unverified`.
- Whether `PreToolUse` in a subagent carries `agent_id` live (documented only; D3 does not rely on it for `verified`).
- Whether Claude Code's `Stop` hook really does not run on a user interrupt (documented only).
- Whether Copilot's `agentStop` fires on an interrupt, and what an interrupt leaves in Copilot's event log.
- Whether the Claude Code prompt hook fires for a stop-hook continuation or a background shell notification (the page lists neither; the probe shows task-notification lines exist).
- Whether Copilot fires `userPromptSubmitted` for autopilot or scheduled turns.
- Any subagent marker on Copilot `preToolUse`.
- What wrote the 22 unmarked terminal lines in the probe (they could be typed prompts on some host version; D3 treats them as not human).
