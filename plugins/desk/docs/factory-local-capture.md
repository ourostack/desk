# Factory local session capture

Desk records local session facts without waiting for a network service. This release captures markers and derives facts; it does not publish them or claim installed-host qualification. The [hook](../hooks/factory-end.cjs), [runner](../mcp/src/factory/derive-run.js) and [synthetic lifecycle tests](../mcp/__tests__/factory/end_hook.test.js) define this boundary.

## Host events

| Event | Local action | Detached action |
| --- | --- | --- |
| Claude `Stop`, Copilot `agentStop` | Refresh the protected session marker. | Start pending jobs only when the CLI advertises `finalize`. |
| Claude `SessionEnd`, Copilot `sessionEnd` | Refresh the marker with the end reason. | Run `factory.js derive --marker <file> --wait-quiet 30000`. |

The [host manifests](../hooks/hooks.json) and [Copilot manifest](../hooks/copilot-hooks.json) register these events. The [handler](../hooks/factory-end.cjs) caps stdin at 1 MiB and stops waiting for input after 150 ms. Its supervisor keeps the unchanged 1.5-second deadline outside the worker that performs synchronous metadata and OS-protection work, terminates a blocked worker and waits for its exit. Both processes print nothing. Ordinary native operation targets 500 ms; the [subprocess tests](../mcp/__tests__/factory/end_hook.test.js) allow 2 seconds for CI. The local protection helpers may invoke OS ACL utilities, but neither the hook nor derivation requests a network operation.

Copilot log paths come from `sessionId` under `COPILOT_HOME` (otherwise `~/.copilot`), not from prompt text or `transcriptPath`. Agency plugin-session locations supply the `launcher` entrypoint. Plugin names and versions come from sibling manifests on Copilot and the installed-plugin registry on Claude. The marker captures the resolved route so deleting a temporary plugin folder cannot redirect a later sweep to the default store. Every discovery cap, including Claude's records-per-key and aggregate manifest-directory limits, makes routing incomplete; only the desk's own valid declaration can override that hold. The [marker validator](../mcp/src/factory/marker.js) limits paths and metadata, while the [canonical resolver](../mcp/scripts/resolve-desk-root.js) owns desk selection. Hook-facing activation reads are regular-file-only, no-follow and capped at 64 KiB. An unresolved binding defers capture rather than guessing. `DESK_PERSON`, when set, supplies an explicit `desks/<alias>` binding prefix; no identity is inferred from content.

## Local state and commands

All factory state lives at `$XDG_STATE_HOME/ouroboros-skills/desk/factory`, or `~/.local/state/ouroboros-skills/desk/factory`. The [outbox](../mcp/src/factory/outbox.js) applies the shared owner-only protections and refuses Git checkouts, symlinks and hard links. Capture, derivation and finalize callers also exclude the canonical bound desk, including unversioned desks and symlink aliases, before creating state. Direct marker reads, sweep and status use the same owned-directory, leaf-protection, 64 KiB and filename/session identity checks; corrupt and expired entries are pruned only while the exact owned leaf remains unchanged. Markers are local bookkeeping, not published facts: paths, routing warnings and exact hook times never enter a facts file. Prompt fields, assistant text, task titles and tool arguments are not copied into markers.

Run commands from the installed Desk plugin root:

```sh
node mcp/scripts/factory.js consent --store ourostack/factory --contribute yes --account <login>
node mcp/scripts/factory.js derive --marker <protected-marker-file> --wait-quiet 30000
node mcp/scripts/factory.js status
```

The [CLI](../mcp/scripts/factory.js) returns one JSON result. `derive` accepts only a marker in the protected marker directory, waits for source quiet for up to five minutes, and then returns `written`, `held`, `skipped`, `not_opted_in`, `log_missing`, `source_unreadable` or `invalid`, with the selected store when known. Local `status` includes marker/finalize counts, derivation receipts and routing warnings; it is not a public report and must not be uploaded as facts. No command prints the machine secret.

The [runner](../mcp/src/factory/derive-run.js) combines the existing native derivers, job binder, store resolver and consent-aware outbox. Per-session locks prevent concurrent derivations from overwriting one another. Receipts retain source identity, size, modification time and the effective marker hash. [Lifetime reconciliation](../mcp/src/factory/session-lifetime.js) checks native resumes and later root activity before treating a marker as ended; unclassifiable or over-limit lifecycle records cannot certify closure. Queued work honors newer protected markers, checks quietness under the lock and refuses a source that changes during inspection or derivation. `sweep(env, { quietMs: 600000 })` derives quiet changed logs and currently ended sessions, not busy resumed sessions with stale end markers. A requested `derive --wait-quiet` also rechecks quietness under the lock, including late shutdown writes. Markers remain available for retry and later resumes. Wiring sweep into startup belongs to the transport/boot-check slice.

## Completion and remaining boundary

The [task tools](../mcp/src/tools/task.js) write `finalize/<job>.json` on `done`, `cancelled` and archive, including repeat archive calls, only when factory state already exists. They use the same job identity as binding; a factory failure emits a fixed diagnostic code without failing the completed task operation. This does not wait for a store, create consent or mark a report delivered.

The [CLI command list](../mcp/scripts/factory.js) does not yet contain `finalize`, so the end-of-turn hook leaves requests pending. The later transport slice must register that command, consume the requests, invoke sweep from startup and publish only transformed public facts. Real installed Claude, Copilot and Desktop behavior remains unverified until the channel update is installed and the controller runs live proof.
