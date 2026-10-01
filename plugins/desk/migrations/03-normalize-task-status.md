---
id: 03-normalize-task-status
description: Map task cards whose status is a ghost value (active, doing, in-progress, planning, backlog, needs-review, waiting) to the eight lifecycle states, and list any other value for a hand check (2026-09-30)
safety: safe
needs_restart: false
agent_work: true
---

## Detect

```bash
# Fires when a live or archived task card in this session's own desk holds a status outside the eight lifecycle
# states (drafting, processing, validating, collaborating, paused, blocked, done, cancelled). Read from the cards
# themselves, so there is no marker to desync. The driver sets DESK_PLUGIN_ROOT to the Desk plugin root that holds
# this file, and DESK_TOOLS_ROOT and DESK_TOOLS_PERSON to the root.path and write_scope.person desk_status reports.
command -v node >/dev/null 2>&1 || exit 1
[ -f "${DESK_PLUGIN_ROOT:-}/mcp/scripts/status-normalize.js" ] || exit 1
node "$DESK_PLUGIN_ROOT/mcp/scripts/status-normalize.js" --detect ${DESK_TOOLS_ROOT:+--root "$DESK_TOOLS_ROOT"} ${DESK_TOOLS_PERSON:+--person "$DESK_TOOLS_PERSON"}
```

## Safety check

```bash
# Nothing here can be unsafe: Migrate changes no desk content.
exit 0
```

## Migrate

```bash
# The repair is agent work, so this block changes nothing. It prints one task_update call per card whose value maps to
# a lifecycle state, and lists every other value separately as a card to look at by hand.
node "$DESK_PLUGIN_ROOT/mcp/scripts/status-normalize.js" --plan ${DESK_TOOLS_ROOT:+--root "$DESK_TOOLS_ROOT"} ${DESK_TOOLS_PERSON:+--person "$DESK_TOOLS_PERSON"}
cat <<'STEPS'

Mapping (case and `-`, `_`, space are folded): active, doing and in progress become processing; planning and backlog become drafting; needs review becomes collaborating; waiting becomes blocked.

Do the work now, in this session and without asking: make each task_update call above exactly as printed, one card per call. Work only inside this session's own desk. Skip a card that holds uncommitted changes (another session may be working there) and name it in the announcement. Do not guess a state for a card in the hand-check list: read the card, choose the lifecycle state that matches where the work stands, and set it with task_update; if you cannot tell, leave it and name it.
STEPS
```

## Announce

I fixed task statuses in my desk: <how many cards moved to which state, for example 6 active cards to processing>. <Cards I left for a hand check or skipped, if any.> Say if you mind and I'll put anything back.
