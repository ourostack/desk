# Factory local session capture

Desk records local session facts without waiting for a network service. This release captures markers and derives facts; it does not publish them or claim installed-host qualification. The [hook](../hooks/factory-end.cjs), [runner](../mcp/src/factory/derive-run.js) and [synthetic lifecycle tests](../mcp/__tests__/factory/end_hook.test.js) define this boundary.

## Host events

| Event | Local action | Detached action |
| --- | --- | --- |
| Claude `Stop`, Copilot `agentStop` | Refresh the protected session marker. | Start pending jobs only when the CLI advertises `finalize`. |
| Claude `SessionEnd`, Copilot `sessionEnd` | Refresh the marker with the end reason. | Run `factory.js derive --marker <file> --wait-quiet 30000`. |

The [host manifests](../hooks/hooks.json) and [Copilot manifest](../hooks/copilot-hooks.json) register these events. The [handler](../hooks/factory-end.cjs) caps stdin at 1 MiB, stops waiting for input after 150 ms, uses a 1.5-second exit backstop and prints nothing. Ordinary native operation targets 500 ms; the [subprocess tests](../mcp/__tests__/factory/end_hook.test.js) allow 2 seconds for CI. The local protection helpers may invoke OS ACL utilities, but neither the hook nor derivation requests a network operation.

Copilot log paths come from `sessionId` under `COPILOT_HOME` (otherwise `~/.copilot`), not from prompt text or `transcriptPath`. Agency plugin-session locations supply the `launcher` entrypoint. Plugin names and versions come from sibling manifests on Copilot and the installed-plugin registry on Claude. The marker captures the resolved route so deleting a temporary plugin folder cannot redirect a later sweep to the default store. A present desk declaration still wins; an incomplete plugin scan holds the route unless the desk declares it. The [marker validator](../mcp/src/factory/marker.js) limits paths and metadata, while the [canonical resolver](../mcp/scripts/resolve-desk-root.js) owns desk selection. `DESK_PERSON`, when set, supplies an explicit `desks/<alias>` binding prefix; no identity is inferred from content.

## Local state and commands

All factory state lives at `$XDG_STATE_HOME/ouroboros-skills/desk/factory`, or `~/.local/state/ouroboros-skills/desk/factory`. The [outbox](../mcp/src/factory/outbox.js) applies the shared owner-only protections and refuses Git checkouts, symlinks and hard links. Markers are local bookkeeping, not published facts: paths, routing warnings and exact hook times never enter a facts file. Marker JSON is capped at 64 KiB. Prompt fields, assistant text, task titles and tool arguments are not copied into markers.

Run commands from the installed Desk plugin root:

```sh
node mcp/scripts/factory.js consent --store ourostack/factory --contribute yes --account <login>
node mcp/scripts/factory.js derive --marker <protected-marker-file> --wait-quiet 30000
node mcp/scripts/factory.js status
```

The [CLI](../mcp/scripts/factory.js) returns one JSON result. `derive` accepts only a marker in the protected marker directory, waits for source quiet for up to five minutes, and then returns `written`, `held`, `skipped`, `not_opted_in`, `log_missing`, `source_unreadable` or `invalid`, with the selected store when known. Local `status` includes marker/finalize counts, derivation receipts and routing warnings; it is not a public report and must not be uploaded as facts. No command prints the machine secret.

The [runner](../mcp/src/factory/derive-run.js) combines the existing native derivers, job binder, store resolver and consent-aware outbox. Per-session locks prevent concurrent derivations from overwriting one another. Receipts retain the source size, modification time and marker hash, so unchanged sessions can be skipped and late host writes remain eligible for another pass. `sweep(env, { quietMs: 600000 })` derives quiet changed logs and ended sessions, retaining markers for later resumes. Wiring the sweep into startup belongs to the transport/boot-check slice.

## Completion and remaining boundary

The [task tools](../mcp/src/tools/task.js) write `finalize/<job>.json` on `done`, `cancelled` and archive, including repeat archive calls, only when factory state already exists. They use the same job identity as binding; a factory failure emits a fixed diagnostic code without failing the completed task operation. This does not wait for a store, create consent or mark a report delivered.

The [CLI command list](../mcp/scripts/factory.js) does not yet contain `finalize`, so the end-of-turn hook leaves requests pending. The later transport slice must register that command, consume the requests, invoke sweep from startup and publish only transformed public facts. Real installed Claude, Copilot and Desktop behavior remains unverified until the channel update is installed and the controller runs live proof.
