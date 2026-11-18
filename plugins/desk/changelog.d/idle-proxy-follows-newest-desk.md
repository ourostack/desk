### A Desk server that restarts after idling now runs the newest installed Desk

A host keeps one Desk MCP server per session for days, and the session stays on the Desk it started with. The idle proxy (`mcp/idle-proxy.cjs`) now starts each new server from the newest installed copy of Desk it can find beside its own (`newestDesk` in `mcp/bootstrap.cjs`), so an idle session moves to the current Desk on its next message, without a restart.

It switches only when the newer copy is the same plugin, declares the same `toolProtocol` in `mcp/package.json` (every tool the host may have cached still exists with the same inputs), and accepts the running Node; otherwise, or when anything cannot be read, it keeps its own copy. Bump `toolProtocol` in the same change that removes or breaks a tool; a test lists the tools protocol 1 promises.
