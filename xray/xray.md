# AX X-ray: MCP server

Ouro AX claim set 1.5.0 (sha256 dfcf73422b9f718d709d2210649ec1e3b98c5d19650cc1180b358368fb6b1feb), checked by ax-xray 1.5.0 at 2026-11-16T12:51:01.665Z. Target: at abc; MCP (19 tools).

**Conforms: every applicable must claim holds, and the inventory covers every surface checked.** Claims holding: 3 of 5 (must: 2 of 2). Checks: 39 pass, 2 fail, 8 skipped.

Calls to what other people see: not made (loopback: no, isolated home: yes, no credentials: yes, mock identity: no).

Effects the X-ray caused: none recorded.

| | Claim | Tier | Rule | Pass | Fail | Skip |
|---|---|---|---|---|---|---|
| ✗ | `mcp.bad-call-teaches` | should | A call missing a required argument is refused, and the error names the argument. | 0 | 1 | 8 |
| ✗ | `mcp.unknown-tool` | should | An unknown tool is refused, and the error names the tools or tools/list. | 0 | 1 | 0 |
| ✓ | `mcp.effect-annotated` | must | Every tool says whether it only reads or changes something (`readOnlyHint` or `destructiveHint`). | 19 | 0 | 0 |
| ✓ | `mcp.inventory` | must | Every tool the server registers is in tools/list once and in the adopter's inventory. | 1 | 0 | 0 |
| ✓ | `mcp.tools-list` | should | The server lists its tools, each with a description and an input schema. | 19 | 0 | 0 |

## What fails, and the fix

### `mcp.bad-call-teaches`: A call missing a required argument is refused, and the error names the argument.

Why: Schemas that reject bad calls with the fix.

Fix: Validate input against the schema before running and name each missing field.

- **desk_recall**: refused: {   "status": "degraded",   "mode": "setup",   "reason": "no_desk_root",   "summary": "desk_recall needs the desk root and the Desk runtime, which Desk has not admitted yet (no_desk_root).",   "onboarding_skill": "desk:…

### `mcp.unknown-tool`: An unknown tool is refused, and the error names the tools or tools/list.

Why: The error should be the menu.

Fix: Answer with the tool names.

- **ax_xray_no_such_tool**: refused: unknown tool: ax_xray_no_such_tool

## Every surface

| Surface | Holds | Fails | Skipped |
|---|---|---|---|
| mcp · inventory | `mcp.inventory` |  |  |
| mcp · task_create | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · task_update | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · task_archive | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · task_focus | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · task_signoff | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · track_create | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · track_update | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · friction_add | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · lesson_add | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · desk_save | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · note | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · desk_search | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · desk_recall | `mcp.tools-list` `mcp.effect-annotated` | `mcp.bad-call-teaches` |  |
| mcp · desk_status | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · desk_doctor | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · desk_skill | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · improvement_open | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · improvement_next | `mcp.tools-list` `mcp.effect-annotated` |  |  |
| mcp · improvement_update | `mcp.tools-list` `mcp.effect-annotated` |  | `mcp.bad-call-teaches` |
| mcp · ax_xray_no_such_tool |  | `mcp.unknown-tool` |  |
