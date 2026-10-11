### Native browser transport foundation

- Add bounded native-messaging framing and exact browser/entry/runtime ancestry checks, preserving browser identity when a mediator disconnects.
- Ship separately verified native entry assets for all eight supported targets. Execute only private owner-only copies, validate private configuration and keep diagnostics off framed stdout.
- Keep browser-launch artifact verification shared without changing its fixed launch contract.
- Add our extension's explicit owned-window/tab dispatcher and hidden profile-token document. Selected controls label their owner and work while task pages stay backgrounded; same-document purpose updates do not activate tabs.
- Native messaging requires Chrome or Edge 125 or newer for documented flattened debugger child sessions. Normal local sideloading remains the developer-distribution setup path.
