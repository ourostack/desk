### `sessions.js` reads and messages this machine's sessions

A new command, `mcp/scripts/sessions.js`, prints a session's last messages (`tail`), says which session the caller is (`whoami`) and sends a message to another session through the GitHub Copilot app, reporting `delivered` only when the message shows in the target's own history. It covers the machine it runs on and fails with a Desk failure line. See [sessions](docs/sessions.md).
