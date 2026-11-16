### Drains: spot Copilot runtimes that came up without Desk

After an app restart, a session can be served by a Copilot runtime started without Desk's plugin, so it has no `desk-*` tools, hooks or boot text and cannot warn anyone itself. `drains.js runtimes status` now lists those runtimes and says how to recover; see [schedules](docs/schedules.md#when-a-session-has-no-desk-tools).
