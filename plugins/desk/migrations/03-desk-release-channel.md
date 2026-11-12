---
id: 03-desk-release-channel
description: Move an explicit Agency entry for Desk on main to Desk's release channel, never leaving a session two Desk roots (2026-11-11)
safety: safe
needs_restart: false
---

## Detect

```bash
# Fires when agency.toml (AGENCY_TOML, else ~/.local/agency/agency.toml) selects github:ourostack/desk:plugins/desk@main
# and the move can be made now. An entry waits, printing `held: <reason>`, while another plugin in its list might bring Desk
# and Agency has not cached that plugin's manifest yet. The driver sets DESK_PLUGIN_ROOT to the Desk plugin root.
command -v node >/dev/null 2>&1 || exit 1
[ -f "${DESK_PLUGIN_ROOT:-}/mcp/scripts/agency-desk-channel.js" ] || exit 1
node "$DESK_PLUGIN_ROOT/mcp/scripts/agency-desk-channel.js" --detect
```

## Safety check

```bash
# The move changes only which Desk the next session loads; this session keeps the Desk it already has.
command -v node >/dev/null 2>&1 || { echo "node is required to move the Agency entry"; exit 1; }
exit 0
```

## Migrate

```bash
# Where another plugin in the same list already brings Desk, the entry gives way to it on those engines; anywhere else
# it moves to @release. agency.toml is written in place after a one-time copy to agency.toml.pre-desk-release.
set -eu
node "$DESK_PLUGIN_ROOT/mcp/scripts/agency-desk-channel.js" --migrate
```

## Announce

Desk's own Agency entry moved off main: it now follows Desk's release channel, or gives way where another plugin already brings Desk, as the report above says. New sessions load one Desk; this session keeps the Desk it started with.
