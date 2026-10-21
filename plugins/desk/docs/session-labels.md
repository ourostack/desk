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

This does **not** rename a native conversation, terminal panel or Hub entry.
It does not prove a main-agent invocation, ownership, current native activity,
delivery or acceptance. A native consumer must independently qualify and
correlate those facts, preserve manual names, and reject stale or child results
before applying any automatic name. A shared MCP connection is not ownership.
No native naming consumer is installed by these task tools.

Author a short functional description, not a copied card title, path, URL,
email address or credential. Labels are trimmed and limited to 72 Unicode
code points; controls, formatting characters and credential-shaped values are
rejected as a whole. They are private display data, not permission to export
task information. `display_label` is not written to the task card or a separate
naming store; normal tool transcripts may still record the supplied input.

For a successful focus observation without a label, `session_label` is
`{"state":"unavailable","code":"missing_safe_label"}`. Unsafe input instead
returns code `unsafe_label`; task CRUD and its existing evidence checks remain
unchanged. A supplied label on a parked create or nonfocused update returns
`awaiting_focus` without changing the held focus. An invalid internal task
identity returns `owner_unknown`. No fallback converts a card title or slug
into display text.

`task_focus` with `clear:true` remains a standalone operation and cannot also
supply `display_label`. Clearing does not issue a rename. A task card's status
never changes the proposal's `unknown` phase into working, delivered or
accepted.

## Parent-loaded Copilot consumer

`extensions/session-label/extension.mjs` is a native Copilot extension entry.
The native discovery/installation owner must enroll it through the host's
supported extension loader; merely installing the task-tool schema does not
enroll an extension. There is no guessed plugin-manifest field, automatic
global-directory write, session launcher or transcript/file poller here.

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

This source entry alone does not establish ordinary installed discovery or
native validation. Those require the normal installation owner's source and
consuming-host proof. Claude additionally requires a supported automatic
route that truthfully reflects initial/resumed and changed work while
preserving explicit names and session identity. A custom mod setter is not
mandatory if a supported built-in, normal prompt or resume mechanism
actually fulfills that outcome; declarations alone do not qualify it.
