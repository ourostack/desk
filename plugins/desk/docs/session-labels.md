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
