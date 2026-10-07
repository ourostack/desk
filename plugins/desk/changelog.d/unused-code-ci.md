Pull requests now fail when they leave unused code behind. A new required check, "Unused code", runs [knip](https://knip.dev) over the repository and fails on a file no entry point reaches, an export nothing imports, an unused or unlisted dependency, an unresolved import, a duplicate export or a stale configuration entry. Hooks and skill scripts are checked as their own workspace, so an unused export in one, or a hook file that is neither registered nor reached from a registered one, fails too, as does a hook export that no other file uses. The entry points (the MCP server, the hooks, scripts and tests) and every exception, each with its reason, are in `tools/unused-code/knip.jsonc`; run it locally with `cd tools/unused-code && npm ci && npm run knip`.

### Deleted, with the code left without purpose

- The retired private feedback store (`src/feedback/store.js`, `src/protected/store.js`) and its tests and offline source-mirror witness. Nothing on a participant's disk is read, changed or deleted; `docs/private-feedback.md` now says what is left there. The native Windows job that exercised the store is now `desk on native Windows` and keeps its other native steps.
- The `src/feedback/windows-acl.js` re-export; `readiness/journal.js` imports `src/factory/windows-acl.js` directly, and the Windows ACL tests moved to `tests/desk/mcp/__tests__/factory/`.
- The vector-pack compaction validator (`src/indexer/vector-compaction.js`) and `cleanupRotatedArtifacts`, with their tests.
- Test-only exports and their tests: `unionIntervals` and `intervalUnion`, `diagnoseHostSupport`, `parseDeskRegistry`, `semanticPartitionIdentity`, `ownerLiveness`, `isLabelsPath` and the broker's `acquireContext` (its production path is `acquireLease`).
- `READINESS_PROTOCOL_VERSION`, a dead branch in the ranking score and the `reexecuteWithCompatibleNode` alias.
- Exports that nothing outside their own file imported are now private to that file. Their values and behaviour are unchanged.

### Moved

The Claude, Ouroboros stdio and MCP-declaration contract validators are CI checks, not shipped code, so they moved under `tests/desk/mcp/__tests__/activation/_contracts/`.

### Coverage

The five source files that had coverage gaps (`util/rank.js`, `readiness/protocol.js`, `readiness/journal.js`, `runtime/node-selection.js`, `artifacts/performance-budgets.js`) now have the tests they were missing. `openChangeJournal` takes optional `platform` and `protect` so the Windows path can be tested on any host.

No record Desk writes or publishes changes.
