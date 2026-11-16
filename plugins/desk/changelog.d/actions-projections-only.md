### Generated action output is only what Desk serves

The action declarations (`plugins/desk/mcp/src/actions/`) now generate only `actions.json` and `mcp.json` (ouro-actions 0.17.3 with `--targets mcp,actions`). The Swift, Reins, web, WebMCP and CLI projections Desk never reads are gone. Tools and their inputs are unchanged.
