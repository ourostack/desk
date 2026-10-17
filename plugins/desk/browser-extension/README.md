# Explicit native browser context kernel

Kernel plus the assignment-2/A producer amendment only. This is **not an installer, native provider,
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
`start()` again before terminal `stop()`. Worker restart constructs a new factory with no bindings,
and unknown resume/status/discard fails rather than scanning groups.

The production entry's `createBackground(api, resourceOptions?)` adds native-port
retry around that same factory; directly importing the kernel does not add
retry. Evaluation, install/startup events, or current native-port loss begin one
coalesced single-flight burst: at most three attempts, at delays 0, 250 and
1000 ms, with a 5000 ms active-burst deadline. These are tested local constants, not
operator settings. Success/terminal stop cancels timers; exhaustion emits fixed
`native_host_unavailable` and waits for another ordinary event. A hung start is
not overlapped, even across a later burst. A late successful start may complete;
the deadline ends retry scheduling, not an unabortable Chrome API operation.
Asynchronously failed native ports continue the same capped attempt budget;
merely queueing ready or receiving refusal diagnostics does not replenish it.
A later ordinary wake/clean loss, or a successful native request/reply before a
later failure, permits a new budget. Timer injection is a resource-test seam,
not new runtime configuration.
No alarm/permission, indefinite watchdog or universal suspended-worker wake is
implied. Native-port loss retains the same relay/page/group. Relay WebSocket
loss is different: retained disconnected/unavailable state, no reattachment or
replacement blank page. Fixed lifecycle status codes also include
`native_transport_connected`, `native_transport_disconnected` and
`native_extension_stopped`, plus `native_transport_failed` and
`native_transport_confirmed` (successful current-port request/reply, not
ancestry/all-owner proof). No raw native exceptions/capabilities are emitted.

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
  live tabs, unknown revoked/uncertain obligations, and pending effects/requests.
  Affirmatively released peer resources do not count as current-owned tabs or
  unknown effects, even though the peer tabs may remain physically present. A
  prepared update blocks creation. Commit must match the prepared token.
  `dispatch(commit)` returns `{committing:true}`; only the native-port handler,
  after posting that affirmative receipt, invokes `chrome.runtime.reload()`.
  The **provider must issue this capability only after its independent
  all-owner quiescence check**, including owners it retained across a worker
  restart. An empty restarted in-memory map is not proof of that quiescence.
  Native-port loss invalidates the local capability, not the provider's
  responsibility for an already-prepared update transaction; reconnect/reset
  is not a cancellation receipt.

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
Projections also expose `groupingObligations` and `debuggerCustody` (below);
zero `pendingEffects` alone is never evidence of quiescence.
`releasedRevokedTabs` and `unknownRevokedTabs` explicitly partition the retained
revocation records, both as `[{tabId,windowId}]`. The original `revokedTabIds`
and `revokedTabs` include both, and confer no authority. `effectObligations`
contains bounded `{tabId,windowId,state:"unknown",reason}` records for unknown
command/close outcomes; `admittingTabIds` retains unsettled opener admissions.
These obligations survive zero current tabs and zero pending effects.

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

Membership is recorded from the actual admitted Chrome tab, including ungrouped
`groupId:-1`; there is no wildcard initial membership. A grouping API or
membership-readback failure retains
`groupingObligations:[{tabId,windowId,priorGroupId,attemptedGroupId?,state}]`.
`unknown` is non-discardable even if a later query succeeds. Presentation moves
still revoke the old binding; neither a query nor a matching title can clear
unknown custody or authorize closing a manually moved tab.
Group-style/readback failures additionally retain
`{groupId,windowId,state:"unknown",reason}` obligations.

Debugger custody is independent of command ownership:
`debuggerCustody:[{tabId,windowId,generation,state,revoked,reason?}]`.
Each attach reserves a live-worker generation before invocation. Revocation
removes command authority immediately but retains attaching/detaching custody
and fences cooperative admission of that exact Chrome identity until settlement.
A late attach success is compensated only while the exact generation fence is
intact; a single exact detach response settles that custody. Rejection or
unconfirmed cleanup stays `unknown`, with a bounded reason, and blocks
discard/update even after the last task tab disappears. An observed debugger
detach while attach is pending breaks generation evidence: a new external
binding must not receive a blind late bare-tab-ID detach. Unknown generations
have no automatic title/query/event-based recovery or handoff in this kernel.
These are in-memory current-worker fences, not Chrome atomic generation-aware
APIs or a restart-recovery database.

Revocation is **released** only after affirmative settlement: no pending or
unknown creation/grouping/effects/admissions, no unknown generation and no
debugger custody on that revoked identity. A no-attachment presentation move or
a settled exact detach may qualify. Command authority never returns. Own logical
relay retirement waits for that disposition; unknown startup/grouping custody
is retained rather than declared cleaned by closing its transport. Terminal
stop still closes relays immediately while preserving its reviewed critical
generation observer until issued effects settle; stop's retained task tabs are
not reclassified as released manual peers.

The exact maintained Chrome-API wire protocol remains unchanged:
`chrome.debugger.attach/detach/sendCommand`, `chrome.tabs.create/remove`, the
corresponding tab/debugger events, then `extension.initialized`.
Frame sessions must have been observed on the exact currently attached owned
tab. Browser/global, foreign-target and physical activation methods fail.
`Page.bringToFront` is a logical acknowledgment only. Navigation/ordinary CDP
failures remain errors. Independent in-flight messages allow a later command to
resolve a pending `Runtime.evaluate({awaitPromise:true})`.

Relay disconnect detaches transport and retains all pages/groups. Resume never creates
anything: disconnected/unavailable bindings return an error. Status reports
their exact retained projection. `stop()` immediately removes ordinary event
listeners and closes relays, not tabs or groups; use a new factory after stop.
The custody-critical debugger-detach observer remains until already-issued
effects (including compensation) settle, then retires without a timer. Retiring
observation also invalidates any remaining unknown generation evidence; an
old map entry alone never authorizes later compensation. A stopped
`context.status` request is still a `native_extension_stopped` error, but carries
the retained cleanup projection in `error.resources`, including
`debuggerObservationActive`. It does not authorize commands, restart, discard
or reload, and unknown custody is not erased to claim quiescence.

`context.discard` is separate from socket close. It preflights current members,
revalidates immediately before each exact Chrome remove call, confirms absence,
and returns `{contextId,discarded:true,closedTabIds,absentTabIds,releasedRevokedTabs}` only on
affirmative completion. Peers/manual members survive. Partial remove or
transport/readback failure returns a non-success cleanup obligation; revoked or
unknown-created resources are not silently closed. Chrome has **no atomic
conditional remove**: a transfer during the remove API call may already have
closed the tab; the result is explicitly ownership-changed, never atomic success.
The native controller must separately confirm its maintained CLI session stopped.
Only remaining current-owned tabs are closed. Released records are retired
without touching their transferred/manual tabs; they are never added to
`closedTabIds` or `absentTabIds`. **Released is not absent.** Unknown records and
uncertain operation outcomes block discard/update and receive no query/title/
time-based amnesty or automatic reconciliation.

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
