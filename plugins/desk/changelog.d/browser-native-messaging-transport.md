### Cooperative native browser ownership

- Add bounded native-messaging framing and exact browser/entry/runtime ancestry checks, preserving browser identity when a mediator disconnects.
- Ship separately verified native entry assets for all eight supported targets. Execute only private owner-only copies and validate private configuration. Native diagnostic frames carry only allowlisted codes, stages and syscalls; raw diagnostics never enter the protocol.
- Keep browser-launch artifact verification shared without changing its fixed launch contract.
- Add our extension's explicit owned-window/tab dispatcher and hidden profile-token document. Selected controls label their owner and work while task pages stay backgrounded; same-document purpose updates do not activate tabs.
- Pin the selected profile's persisted token through the agent-side temporary-copy reader in the immutable private runtime. Native startup verifies that independent proof without requiring live-profile filesystem access or widening browser permissions.
- Native messaging requires Chrome or Edge 125 or newer for documented flattened debugger child sessions. Normal local sideloading remains the developer-distribution setup path.
- Translate owned native tabs and flattened frame sessions through the existing lease proxy, with authenticated private endpoints, control hiding, background renderer focus and same-lease close/reopen. Native capabilities stay out of status and error surfaces.
- Declared real profiles now use our native transport by default. Catalog initialization acquires no window; first use creates an unfocused exact owner window, and explicit/headless connections retain their existing behavior.
- Add frozen supported Page work/peer helpers and exact detach-before-clear/shutdown handling. Native host recovery freshly attests and resumes the same resolved lease on a new call without replaying a disrupted operation.
- Keep extension paths stable and native runtime copies immutable. Explicit `--desk-native-update` verifies source and registration, journals interrupted replacement, and refuses any live task/control owners before reloading only our extension. Normal background refresh never reloads it.
- Preserve Chrome event order through asynchronous ownership checks, renew debugger domains after native-host recovery, and support the maintained MCP default initializer export.
