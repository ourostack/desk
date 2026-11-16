### Session status and doctor are declared as actions

`desk_status` and `desk_doctor` are declared with the session tools in `plugins/desk/mcp/src/actions/desk-session.actions.mts` and served from their generated `mcp.json`. Their inputs keep their names on the wire (`has_instructions`, `factory_consent`) through the generator's wire names; the tools behave as before.
