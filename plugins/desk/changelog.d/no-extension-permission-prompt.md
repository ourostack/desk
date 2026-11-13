### Desk no longer asks you to allow an extension in every new session

The Copilot plugin shipped a session-label extension. The Copilot app asks a person to allow an extension that registers hooks, once per session folder, and chats always get a new folder. Until someone answered, the new session did not start and the session that created it stayed frozen, so unattended coordinators and automations stalled for hours. `permissions allow-all` does not skip that prompt.

Desk now declares no extension, so no prompt appears. The extension code moved to [`optional/session-label/`](optional/session-label/) and is not loaded. The cost is that Desk no longer renames the native session from `task_focus`, `task_create` and `task_update` in the Copilot app; the proposal stays in the tool result and the session keeps its own name. Moving the naming into the MCP server was not possible, because only an extension receives the app's session handle.

A packaging test now fails if the plugin declares an extension or ships a file that joins a session as one.
