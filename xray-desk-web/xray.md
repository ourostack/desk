# AX X-ray: MCP server

Ouro AX claim set 1.5.0 (sha256 dfcf73422b9f718d709d2210649ec1e3b98c5d19650cc1180b358368fb6b1feb), checked by ax-xray 1.5.0 at 2026-11-16T12:51:28.476Z. Target: at abc; MCP (2 tools).

**Conforms: every applicable must claim holds, and the inventory covers every surface checked.** Claims holding: 3 of 5 (must: 2 of 2). Checks: 5 pass, 1 fail, 2 skipped.

Calls to what other people see: not made (loopback: no, isolated home: yes, no credentials: yes, mock identity: no).

Effects the X-ray caused: none recorded.

| | Claim | Tier | Rule | Pass | Fail | Skip |
|---|---|---|---|---|---|---|
| ✗ | `mcp.unknown-tool` | should | An unknown tool is refused, and the error names the tools or tools/list. | 0 | 1 | 0 |
| – | `mcp.bad-call-teaches` | should | A call missing a required argument is refused, and the error names the argument. | 0 | 0 | 2 |
| ✓ | `mcp.effect-annotated` | must | Every tool says whether it only reads or changes something (`readOnlyHint` or `destructiveHint`). | 2 | 0 | 0 |
| ✓ | `mcp.inventory` | must | Every tool the server registers is in tools/list once and in the adopter's inventory. | 1 | 0 | 0 |
| ✓ | `mcp.tools-list` | should | The server lists its tools, each with a description and an input schema. | 2 | 0 | 0 |

## What fails, and the fix

### `mcp.unknown-tool`: An unknown tool is refused, and the error names the tools or tools/list.

Why: The error should be the menu.

Fix: Answer with the tool names.

- **ax_xray_no_such_tool**: refused: Unknown tool ax_xray_no_such_tool.

## Every surface

| Surface | Holds | Fails | Skipped |
|---|---|---|---|
| mcp · inventory | `mcp.inventory` |  |  |
| mcp · browser_context | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · browser_command | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · ax_xray_no_such_tool |  | `mcp.unknown-tool` |  |
