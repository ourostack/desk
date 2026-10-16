# Explicit native browser context kernel

Assignment-1 component only. This is **not an installer, native provider,
signed-in acquisition/controller, MCP adapter, or a promotion readiness claim**.
Nothing in this directory installs itself into a browser or changes permissions.
The enrolled extension public key/ID and profile-token storage key are retained.

## Factory and native contract

```js
import { createBrowserExtension } from "./context-engine.mjs"
const extension = createBrowserExtension(chrome, {
  sourceDigest,                 // immutable packaged source digest
  // Optional resource seams: WebSocket, openSocket(url), onStatus(safeCode).
})
await extension.start()        // offscreen profile read + native ready
const response = await extension.dispatch(request)
extension.stop()              // terminal disposal of this factory instance
```

`background.mjs` is the production MV3 entry. Chrome supplies `chrome`; no
stock extension object or browser window is constructed. `start()` is
idempotent while connected/starting. Native disconnect invalidates an update
capability but does not destroy contexts. A provider reconnection can call
`start()` again before terminal `stop()`; automatic native-host retry is not
implemented here. Worker restart constructs a new factory with no bindings,
and unknown resume/status/discard fails rather than scanning groups.

Requests are trusted native-provider messages, not authority from an MCP
connection, process ID, label or title. All have a bounded string `id`, a method,
and object `params`. Duplicate in-flight native IDs are rejected; commands are
not serialized. `leaseId` is accepted as a bounded legacy **routing tag only**.

- **Context scope:** `context.create`, `.resume`, `.status`, `.label`, `.discard`
  require a lowercase generated UUIDv4 `contextId`. All require exact
  `params.profileToken` and `params.sourceDigest`.
- **Provider scope:** `profile.read`, `extension.reload`,
  `extension.reload.commit` **forbid the `contextId` property**, even undefined.
  Bootstrap `profile.read` supports the previous empty-params token-read request;
  explicitly supplied wrong token/digest fails. The native provider must verify
  ancestry/profile/source independently before using its result.
- **Create:** also requires useful `params.label` (nonblank, max 120 UTF-16 code
  units, no control characters) and exact `params.relayUrl`: canonical
  `ws://127.0.0.1:<port>/extension/<uuidv4>` or IPv6 loopback equivalent, no
  credentials/query/fragment. The URL is an opaque provider-issued capability,
  never printed or returned.
- **Label:** `params.label`, same bounds; confirms the exact current group.
- **Reload prepare:** both exact profile/source and a provider-issued
  64-lowercase-hex `params.updateToken`. Every current owner must be free of
  live tabs, revoked/uncertain obligations, and pending effects/requests. A
  prepared update blocks creation. Commit must match the prepared token.
  `dispatch(commit)` returns `{committing:true}`; only the native-port handler,
  after posting that affirmative receipt, invokes `chrome.runtime.reload()`.
  The **provider must issue this capability only after its independent
  all-owner quiescence check**, including owners it retained across a worker
  restart. An empty restarted in-memory map is not proof of that quiescence.

Native ready is retained:
`{event:"ready",protocolVersion:1,extensionId,sourceDigest,profileToken,browserVersion,userAgent}`.
Host name remains `com.ourostack.desk.browser`. Token acquisition stays in an
offscreen local-storage document under the enrolled extension origin; an
existing corrupt token fails and is never replaced silently. Tokens/readiness
and relay endpoints belong only on the protected native transport, not logs.

Success envelope: `{id,result}`. Failure: `{id,error:{code,message,resources?}}`.
Error messages contain only bounded codes, never raw Chrome/provider exceptions.
All context responses use `contextId`, `state`, `label`, `groupId`, exact
`tabs:[{tabId,windowId}]`, `revokedTabIds`, `revokedTabs`, `pendingEffects`,
`unconfirmedCreates` and `uncertainTabs`. The latter fields are cleanup
obligations, **not** permission to adopt or close a foreign resource.

## Lifetime and relay

Creation reserves the handle before allocating an inactive blank tab in an
existing non-incognito normal window; an incognito-only browser is refused.
The maintained group is named/read back before its
first-tab/initialized handshake; no physical window/tab selection is performed.
New relay-created tabs are also inactive and in that window. Only current
explicit admissions and inactive same-window ungrouped supported owned-opener
HTTP(S)/blank tabs can join. A manual group move never admits a foreign member.
Moving/detaching an owned tab revokes its binding; attaching a debugger alone
does not restore it.

The exact maintained Chrome-API wire protocol remains unchanged:
`chrome.debugger.attach/detach/sendCommand`, `chrome.tabs.create/remove`, the
corresponding tab/debugger events, then `extension.initialized`.
Frame sessions must have been observed on the exact currently attached owned
tab. Browser/global, foreign-target and physical activation methods fail.
`Page.bringToFront` is a logical acknowledgment only. Navigation/ordinary CDP
failures remain errors. Independent in-flight messages allow a later command to
resolve a pending `Runtime.evaluate({awaitPromise:true})`.

Disconnect detaches transport and retains all pages/groups. Resume never creates
anything: disconnected/unavailable bindings return an error. Status reports
their exact retained projection. `stop()` removes this instance's event
listeners and closes relays, not tabs or groups; use a new factory after stop.

`context.discard` is separate from socket close. It preflights current members,
revalidates immediately before each exact Chrome remove call, confirms absence,
and returns `{contextId,discarded:true,closedTabIds,absentTabIds}` only on
affirmative completion. Peers/manual members survive. Partial remove or
transport/readback failure returns a non-success cleanup obligation; revoked or
unknown-created resources are not silently closed. Chrome has **no atomic
conditional remove**: a transfer during the remove API call may already have
closed the tab; the result is explicitly ownership-changed, never atomic success.
The native controller must separately confirm its maintained CLI session stopped.

## Artifact verification and boundaries

`build.mjs --check` recomputes SHA-256 over `SOURCE_FILES`, in the listed order.
For each file the hash receives UTF-8 `name + NUL + decimalByteLength + NUL`,
then its raw bytes. `source-digest.mjs` is generated/excluded from its own hash.
The provider must independently verify the packaged artifact and compare this
digest against fresh ready, not trust a checked-in string alone.

See `vendor/PROVENANCE.md` for the exact input/region hashes, Apache notice,
audit-only original input and guarded transformation. Source tests are under
`tests/desk/mcp/__tests__/launch/browser_context_extension.test.js`; they use
actual maintained components over in-memory Chrome/native/socket resource seams.
They do not qualify live focus, real profile permissions, cold enrollment,
Teams/OOPIF behavior, Windows delivery, native ancestry, or whole-V2 readiness.
