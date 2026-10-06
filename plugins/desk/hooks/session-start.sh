#!/usr/bin/env bash
# desk worker — SessionStart hook.
#
# Foundation plus bounded local boot checks; repairs run detached. MUST always exit 0 because a nonzero SessionStart hook blocks the session from starting.

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
  emit "desk worker boot — the Desk foundation could not be read from $FOUNDATION_SKILL. The boot has not run: run node \"$PLUGIN_ROOT/mcp/scripts/session-boot.js\" before other work, then desk:session-start explains its result. A child agent with a bounded brief follows the brief instead and skips this."
  exit 0
fi

foundation=$(cat "$FOUNDATION_SKILL" 2>/dev/null) || {
  emit "desk worker boot — the Desk foundation could not be read from $FOUNDATION_SKILL. The boot has not run: run node \"$PLUGIN_ROOT/mcp/scripts/session-boot.js\" before other work, then desk:session-start explains its result. A child agent with a bounded brief follows the brief instead and skips this."
  exit 0
}

# Ask the MCP server's own resolver which desk this session binds and let it
# compose the startup line, so the hook and the server can never disagree. It
# honours the Claude project folder when it is a desk, the saved binding, $DESK
# and the home fallbacks, names where the root came from, and always exits 0.
# With --boot-checks it runs the boot-check registry (hooks/boot-checks.cjs),
# which adds one "Desk boot pre-checks:" line only when a check has something to say, and
# then starts factory delivery (hooks/factory-start.cjs) detached with ignored
# stdio, after that output is built.
direction=""
if command -v node >/dev/null 2>&1; then
  direction=$(node "$PLUGIN_ROOT/mcp/scripts/resolve-desk-root.js" --startup-line --boot-checks 2>/dev/null)
fi
if [ -z "$direction" ]; then
  direction="Desk startup: Desk could not resolve its root in this hook. The boot has not run: run node \"$PLUGIN_ROOT/mcp/scripts/session-boot.js\" now, before other work, for the authoritative workspace scan; desk_status reports the root Desk actually bound. A child agent with a bounded brief follows the brief instead and skips this."
fi

# The foundation points at the RFC through this line: the installed copy, which
# the agent can open from any repository. A Windows plugin root keeps its
# backslash separators.
sep="/"
case "$PLUGIN_ROOT" in *\\*) sep="\\" ;; esac
rfc="Desk RFC: ${PLUGIN_ROOT}${sep}docs${sep}agentic-engineering-v2-rfc.md"

# The startup line goes first. Claude Code saves a hook's additionalContext to a file and shows the agent only a
# preview of its first 2 KB once it passes 10,000 characters, and the foundation alone is most of that budget. The
# boot imperative has to sit inside the preview, so the foundation and the RFC line come after it.
emit "${direction}

${foundation}

${rfc}
"
exit 0
