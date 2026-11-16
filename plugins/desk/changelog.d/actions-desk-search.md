### Desk search is declared as an action

`desk_search` is declared with the read tools in `plugins/desk/mcp/src/actions/desk-read.actions.mts` and served from its generated `mcp.json`. Its input is unchanged, including the `filters` that take one value or a list. The generator is Ouro's ouro-actions v0.17.2, which adds the wire names and `anyOf` that make this exact.
