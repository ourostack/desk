# Maintained Playwright extension components

`maintained.mjs` contains the actual compiled `RelayConnection` and
`ConnectedTabGroup` regions of the official Playwright browser extension 0.4.
Copyright (c) Microsoft Corporation. Licensed under Apache-2.0; the complete
license is in `LICENSE`, and the original region copyright notices are retained.
This is a modified distribution, not an upstream release.

## Audited input and reproducibility

The exact public artifact supplied for this assignment is preserved, unmodified,
at `tools/browser-extension/upstream/background-0.4.mjs.txt`. Its origin was the
official extension 0.4 `extension/lib/background.mjs`, supplied as the read-only
`promotion-20261014/browser/owned-stock-attempt-1` reference. No installed
Playwright cache is loaded by this distribution.

SHA-256 checks enforced by `tools/browser-extension/extract.mjs`:

| Region | SHA-256 |
| --- | --- |
| Complete original background.mjs | `e77f9014417f5107332b80b8f5d4cfce2d83a7e269a85b0aa771576e045737ac` |
| `src/relayConnection.ts`, including markers | `cc75f9fab056fcae9d2e903613d09f06cbcefe15a8c64a7417a1ee273f203d16` |
| `src/connectedTabGroup.ts`, including markers | `855086fd8c67e144134de41a9e8fdb5b91b657f884a9ebf9b3c42a5f059549ab` |

From repository root, with Node 22:

```sh
node tools/browser-extension/extract.mjs --write
node plugins/desk/browser-extension/build.mjs --write
node tools/browser-extension/extract.mjs --check
node plugins/desk/browser-extension/build.mjs --check
```

Unsupported complete input, changed regions, or unmatched single substitutions
fail closed. The checked-in full input is audit data only; the product imports
only the extracted generated module. No `PendingConnections`,
`PlaywrightExtension`, `_connectTab`, popup or connection-page hook is exported
or executed.

## Local transformations

- Wrap the maintained regions in a function accepting scoped `chrome` and
  `WebSocket`; the Chrome-API wire dispatcher remains upstream's independent
  asynchronous dispatcher, not a replacement CDP translator or promise queue.
- Remove command/URL/error diagnostics; return bounded error codes. Reject
  malformed relay packet shapes with nonzero protocol error envelopes.
- Remove detached-target reattachment scheduling: there is no detached grace
  period that could become ownership authority.
- Remove the stale-title sweep function entirely. No startup or reconnect scan.
- Change the group constructor's handshake into awaited `initialize(tab)`;
  grouping/readback must complete before first-tab and initialized events.
- Remove all disconnect ungrouping. Preserve pages/group membership after
  ordinary socket close; detach debugger transport only.
- Remove the reserved-tab ungroup effect. The injected API filters foreign
  events and rejects foreign commands instead of moving manual tabs.
- Surface asynchronous group-add failures through `onfailure`; group creation
  errors are thrown rather than logged and treated as success.

The scope/ownership API in `context-engine.mjs` separately forces inactive
creation in the chosen existing normal window, confirms group readback, filters
owned-opener admission and current frame sessions, denies global/foreign effects,
and acknowledges logical `Page.bringToFront` without invoking physical focus.
These are policy around the maintained transport, not a competing relay.
