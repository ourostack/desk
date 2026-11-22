# Session label proposals

`task_focus`, a focused `task_create`, and an update to the current focused
task can return a transient display proposal:

```json
{
  "track": "engineering",
  "slug": "workflow-review",
  "display_label": "Workflow promotion review"
}
```

The successful tool result carries:

```json
{
  "session_label": {
    "proposal": {
      "version": 1,
      "task": { "track": "engineering", "slug": "workflow-review" },
      "text": "Workflow promotion review",
      "phase": "unknown",
      "origin": "automatic"
    }
  }
}
```

The task tools themselves do **not** rename a native conversation, terminal panel or Hub entry.
The proposal does not prove a main-agent invocation, ownership, current native activity,
delivery or acceptance. A native consumer must independently qualify and
correlate those facts, preserve manual names, and reject stale or child results
before applying any automatic name. A shared MCP connection is not ownership.
The one consumer Desk ships is the [Orca tab namer](#orca-tab-names) below.

Author a short functional description, not a copied card title, path, URL,
email address or credential. Labels are trimmed and limited to 72 Unicode
code points; controls, formatting characters and credential-shaped values are
rejected as a whole. They are private display data, not permission to export
task information. `display_label` is not written to the task card or a separate
naming store; normal tool transcripts may still record the supplied input.

When no label was proposed, `session_label` is left out of the result. Unsafe input instead
returns code `unsafe_label`; task CRUD and its existing evidence checks remain
unchanged. A supplied label on a parked create or nonfocused update returns
`awaiting_focus` without changing the held focus. An invalid internal task
identity returns `owner_unknown`. The proposal never converts a card title or slug
into display text; only the Orca tab namer falls back to the card title, under its own rules.

`task_focus` with `clear:true` remains a standalone operation and cannot also
supply `display_label`. Clearing does not issue a rename. A task card's status
never changes the proposal's `unknown` phase into working, delivered or
accepted.

## Orca tab names

When a Claude Code session runs in an [Orca](https://github.com/stablyai/orca) terminal, Desk names that terminal's tab after the task its main agent focuses, so the phone's session list says what each session is doing ([desk#1478](https://github.com/ourostack/desk/issues/1478); Ari asked for automatic names on 2026-11-22). A `PostToolUse` hook in [`hooks/hooks.json`](../hooks/hooks.json) runs in the background after `task_focus` and `task_create`, and [`mcp/src/runtime/orca-session-title.js`](../mcp/src/runtime/orca-session-title.js) does the work:

- **Which terminal.** Only the caller's own, named by Orca in `ORCA_TERMINAL_HANDLE`. Desk never picks "the active terminal" and never renames another session.
- **Who may rename.** Only the main agent. A subagent's hook input carries `agent_id`; a headless `claude -p` child started in the same terminal runs with `CLAUDE_CODE_ENTRYPOINT` `sdk-*`; a Desk child process runs with `DESK_READ_ONLY_CHILD` or `DESK_FACTORY_HEADLESS`. All of them are skipped. Clearing focus, a parked `task_create` and a failed call leave the title alone.
- **The title.** The agent's own `display_label` when it gave one, else the card's title (`task_focus` now answers `title`). Either passes the safety rules above whole or not at all, so no path, URL, address or credential reaches a tab. It is cut at a word to 32 characters with an ellipsis, never inside a character.
- **A person's name wins.** Orca's CLI has one setter, and it writes the same custom title a person types. So Desk keeps one small file per terminal in its state folder (`orca-session-titles/<handle>.json`) with the last 3 titles it set there, and renames only while the tab still shows one of those or an Orca default: empty, `Terminal N`, the agent or shell name, a working-folder title such as `~/desk`, or Claude Code's own status title (a braille spinner frame or `✳`, then a summary). Any other title is a person's and stays. Desk records its title before renaming, so a rename that times out still leaves a title Desk recognises next time. Where the installed Orca supports `terminal rename --if-manual-title`, Desk passes the manual name it saw (none over a default, its own otherwise), so the rename lands only if nobody renamed the tab in between; without it, that moment between reading and writing is the known gap.
- **Overlapping focuses.** The hook runs in the background, so two focuses can overlap. Each one claims the terminal in its file first, and an older one that finds a newer claim stands down (`superseded`).
- **Proof.** Desk reads the title back after renaming. Every outcome is one line in `orca-session-titles.log` in Desk's state folder (`applied`, `manual_title_kept`, `superseded`, `conditional_rename_refused`, `readback_mismatch`, `not_in_orca`, `child_agent` and the rest), rotated at 256 KB. Files for terminals untouched for 30 days are removed. Nothing is shown to the agent, and the tool call never waits on or fails because of naming.

Copilot sessions in Orca are not named yet: the hook is registered for Claude Code only. Windows is not supported (`unsupported_platform`): Orca's Windows CLI is a `.cmd` shim that cannot be started without a shell.

## Parent-loaded Copilot consumer (not shipped)

**Not loaded by default.** The Copilot root manifest no longer declares `extensions`, and the code lives in `optional/session-label/`. The Copilot app asks a person to allow any extension that registers hooks, in every new session folder, and a session that is waiting on that prompt does not start; unattended sessions froze. A test keeps Desk from shipping an extension again. Without the extension, automatic naming is not applied in the Copilot app. The rest of this section describes the optional code if a host lets it load without a prompt.

`optional/session-label/extension.mjs` is a native Copilot extension entry.
A manifest that declared `"extensions": "./extensions/"`, the
host-supported legacy plugin component path, would have normal plugin acquisition
supply the entry to native plugin discovery, with source-qualified
identity `plugin:desk:session-label`. Merely exposing a task-tool schema is not
enrollment.

This declaration is additive, not `exclusive`: it does not suppress built-in
or other extensions, copy a project entry to a user directory, overwrite an
unowned file, or change native preferences. Plugin disablement, extension
mode disablement and per-extension opt-outs remain host-owned and authoritative.
The plugin never calls an enable/reload API on the operator's existing session.
Normal updates retain the same extension identity and acquire its current
plugin-relative module; there is no source pin or independent naming daemon.

The current host gates extension loading on its extension feature capability.
A launch-scoped experimental RC invocation can exercise that capability
without a global setting change, but must not override explicit native
extension disablement or be represented as ordinary published-channel proof.
There is no session launcher or transcript/file poller here.

The entry joins its parent process's current session, then observes live
native tool-start/completion pairs from the configured `desk` MCP server.
Only a matching successful main-agent result from `task_focus`, focused
`task_create` or `task_update` can propose a name. Child markers, unmatched or
older results, a changed session identity, unsafe text and a proposal that
disagrees with the authored input are refused. Resuming requires a fresh
observation; saved tool-result text is never replayed.

The currently observed provider-discovery route is the host-owned Desk
plugin. Naming requires host-reported plugin ownership matching this acquired
Desk artifact and consistent native event provenance; the
alias `desk` alone is insufficient. Other agent/activation providers need
equivalent qualified ownership evidence. Missing evidence makes naming
unavailable, not Desk access or assigned work unauthorized.

The supported asynchronous pre-MCP hook must correlate each observation.
It drains earlier naming work before the outgoing task request, with a
maximum one-second wait. If the wait expires, naming stops and reports
uncertainty; the MCP request still continues unchanged. The helper never
returns a permission decision, changes request metadata or waits indefinitely.
An already-submitted uncertain native write cannot be claimed cancelled or
current: that is an explicit naming limitation, not a reason to ban task work.

Application uses only the native conditional `name.setAuto` operation and
verifies exact native readback. It does not use the explicit/manual setter,
rewrite a UUID, or change Hub or panel names. Native refusal remains
`preserved/native_owner_refused`, not success. Missing APIs, failed readback
and runtime errors remain explicit unavailable diagnostics. An unacknowledged
write stops this consumer rather than issuing another write that the unknown
operation could overtake. Tool results and task execution are unchanged.

### Diagnostics

The entry logs each state as `Desk automatic session label: <state>/<code>`.
A failed native read is reported as `unavailable/native_<stage>_<cause>`:

| Stage | Native read |
| --- | --- |
| `snapshot` | The session identity check when the consumer attaches. |
| `recheck` | The identity recheck just before an automatic write. No write was issued. |
| `readback` | The name read after the native setter acknowledged the write. The write may have taken effect; the label is not reported as applied. |

| Cause | Meaning |
| --- | --- |
| `timeout` | The consumer's own bounded wait (two seconds by default) expired. |
| `invalid_params` | The host answered with JSON-RPC error `-32602`. |
| `internal_error` | The host answered with JSON-RPC error `-32603`. |
| `rpc_error` | The host answered with another reserved JSON-RPC error code (`-32768` to `-32000`). |
| `failed` | Anything else, including errors without a readable code. This does not claim a transport fault. |

A missing method (`-32601`) at any stage stays `unsupported_runtime`. A failed
or timed-out setter stays `native_apply_uncertain` and stops automatic naming,
whatever the error, because the write may still complete. Codes come from this
fixed vocabulary only: no error message, data, stack, identity or label text is
logged. They locate the failing call; they do not identify why the host failed
it.

This source entry alone does not establish ordinary installed discovery or
native validation. Those require the normal installation owner's source and
consuming-host proof. Claude additionally requires a supported automatic
route that truthfully reflects initial/resumed and changed work while
preserving explicit names and session identity. A custom mod setter is not
mandatory if a supported built-in, normal prompt or resume mechanism
actually fulfills that outcome; declarations alone do not qualify it.
