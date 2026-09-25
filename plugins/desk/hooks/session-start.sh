#!/usr/bin/env bash
# desk worker — SessionStart hook.
#
# Fast, non-blocking foundation injected as additionalContext, followed by a pointer to the authoritative `desk:session-start` scan. Deliberately does no workspace, network, or Git work. MUST always exit 0 because a nonzero SessionStart hook blocks the session from starting.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FOUNDATION_SKILL="${1:-$PLUGIN_ROOT/skills/using-desk/SKILL.md}"

emit() {
  # Emit a SessionStart additionalContext JSON object. Prefer jq for correct escaping; fall back to minimal manual escaping if jq is absent.
  local ctx="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -nc --arg c "$ctx" \
      '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}' 2>/dev/null && return 0
  fi
  ctx="${ctx//\\/\\\\}"; ctx="${ctx//\"/\\\"}"; ctx="${ctx//$'\n'/\\n}"
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' "$ctx"
}

if [ ! -r "$FOUNDATION_SKILL" ]; then
  emit "desk worker boot — the Desk foundation could not be read from $FOUNDATION_SKILL. Invoke desk:session-start before other work; it remains the authoritative workspace scan."
  exit 0
fi

foundation=$(cat "$FOUNDATION_SKILL" 2>/dev/null) || {
  emit "desk worker boot — the Desk foundation could not be read from $FOUNDATION_SKILL. Invoke desk:session-start before other work; it remains the authoritative workspace scan."
  exit 0
}

# Ask the MCP server's own resolver which desk this session binds and let it
# compose the startup line, so the hook and the server can never disagree. It
# honours the Claude project folder when it is a desk, the saved binding, $DESK
# and the home fallbacks, names where the root came from, and always exits 0.
direction=""
if command -v node >/dev/null 2>&1; then
  direction=$(node "$PLUGIN_ROOT/mcp/scripts/resolve-desk-root.js" --startup-line 2>/dev/null)
fi
if [ -z "$direction" ]; then
  direction="Desk startup: Desk could not resolve its root in this hook. Invoke desk:session-start now for the authoritative workspace scan before other work; desk_status reports the root Desk actually bound."
fi

# The foundation points at the RFC through this line: the installed copy, which
# the agent can open from any repository.
rfc="Desk RFC: $PLUGIN_ROOT/docs/agentic-engineering-v2-rfc.md"

emit "${foundation}

${rfc}

${direction}"
exit 0
