// The `Desk startup:` line both startup hooks append after the using-desk
// foundation. It names the root this session's Desk MCP would bind, using the
// same resolution the server uses, and says where that root came from.
//
// A hook cannot see an overlay launcher's arguments: an overlay that starts
// Desk with its own `--root` (for example a crew checkout) binds that root. The
// hooks pass the session's project folder, so a session opened in that
// workspace names it; otherwise the line says plainly that desk_status reports
// the root Desk actually bound, rather than claiming more than a hook knows.

function sourceLabel(source) {
  if (source === "host-project") return "this session's project folder is a desk"
  if (source === "activation-config") return "the saved desk binding"
  if (source === "env:DESK") return "the DESK environment variable"
  if (typeof source === "string" && source.startsWith("fallback:")) return "a home-folder fallback"
  return "the root passed to Desk"
}

export const DESK_SETUP_DIRECTION =
  "Desk startup: no desk is bound yet, so Desk is in setup mode. Run the onboarding path desk_status names now — desk:first-run-bootstrap by default, which looks for an existing local desk, then the operator's desk repository on GitHub, and otherwise offers to create one; an overlay that owns its workspace names its own, such as crew:join-crew. Do not offer to continue without Desk. After setup, desk:session-start remains the authoritative workspace scan."

export function deskStartupDirection(resolution) {
  if (!resolution?.root) return DESK_SETUP_DIRECTION
  return `Desk startup: $DESK is ${resolution.root} (${sourceLabel(resolution.source)}). Invoke desk:session-start now for the authoritative workspace scan before other work. An overlay that launches Desk with its own root binds that root instead; desk_status reports the root Desk actually bound, so use that root if the two differ.`
}
