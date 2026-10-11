# Native background target windows

Date: 2026-10-11

Status: design approved; implementation requires implementation-plan approval.

## Outcome and constraints

Keep one selected, attested browser profile and one lease per agent connection.
Agents must retain responsive pages, exact resource ownership, bounded attributed
peer inspection and complete cleanup without activating the browser application.
The operator must not need to restore terminal focus, restart a shared browser,
change security policy or repeatedly authorize ordinary page operations.

This amends the earlier one-control-tab-plus-task-tabs-in-one-normal-window
mechanism. It does not change profile selection, identity attestation, native
transport authentication, the lease authority boundary or recovery on new calls.

## Evidence and alternatives

Qualification reproduced application activation on successful loopback document
navigation in normal Edge windows, including a minimal extension without the
debugger or native transport. Removing Accessibility observation and implicit
favicon requests did not remove it. A verified public HTTPS page and an HTTP 204
control did not reproduce it. An owned-process sample captured Edge's built-in
hub-app notification widget calling application activation. The exact notification
signal remains unverified; no browser security permission is identified as the
cause or changed by this design.

A normally created single-page popup did not activate the application. However,
adding another tab with `tabs.create({windowId: popupId})` did not retain the tab in
the requested popup. A minimized normal window still activated the application.
Neither is an acceptable same-window replacement.

The selected design therefore uses supported popup windows for individual work
targets, not hidden/offscreen coordinates, policy overrides, browser flags,
notification suppression or after-the-fact focus restoration.

## Window and ownership model

Each lease has one persistent **owner control window**, created with
`windows.create({type: "popup", focused: false, url: controlUrl})`. Its only tab
retains the recognizable `Desk | owner | work` label.

Each deliberate work-target creation creates a separate **work window** with
`windows.create({type: "popup", focused: false, url: markerUrl})`. The returned
window must contain exactly one tab. Record its exact tab/window identities before
target discovery and subsequent effects. Never fall back to `tabs.create` in an
arbitrary normal window.

The existing Playwright/MCP logical page collection remains a lease-scoped set of
targets. Several pages can live in separate native windows within the same
browser context. This is cooperative resource grouping, not identity isolation.

Browser-created descendants remain a separate case: admit a content-spawned tab
only from its exact recorded owned opener. Deliberately created work windows are
owned through their recorded create operation and marker; descendants are owned
through opener admission. A window's `type` never establishes authority.

## Exact schema semantics

Before, a successful extension `target.create` returns:

```text
{ tabId, targetId, windowId,
  controlTabId, controlTargetId, controlMarker, markerUrl }
```

`windowId` was both the target's window and the control's window because they were
identical. After this amendment it returns:

```text
{ tabId, targetId, windowId, controlWindowId,
  controlTabId, controlTargetId, controlMarker, markerUrl }
```

`windowId` is exclusively the newly created work target's window;
`controlWindowId` is the lease's stable owner control window. Both are freshly
returned Chrome window identities, not native operating-system window numbers.
The immutable extension/runtime source contract requires both sides to update
together; an absent or malformed control identity is refused, not guessed.

Persisted native routing remains:

```text
nativeRouting: {
  windowId: controlWindowId,
  controlTabId, controlTargetId, controlMarker,
  targetTabs: {
    [virtualTargetId]: { tabId, windowId: workWindowId }
  }
}
```

The top-level persisted `windowId` continues to mean the control window. Every
per-target `windowId` continues to mean that target's exact recorded window.
Recovery checks each independently; neither field can substitute for the other.

Public `peers()` retains its existing `windowId` as the owner control window and
adds bounded `targetWindows: [{ targetId, windowId }]` derived only from recorded
task routing. No endpoint, credential, cookie, browser-global target inventory or
unrecorded window is exposed. Existing owner/work/lease/target fields retain
their meanings.

## Agent and human attribution

The owner control remains the stable visible ownership label and lists the
recorded work windows. Each entry includes its current page title and Chrome
window identity. Closing a target removes its entry; purpose updates refresh the
owner label without opening or activating a window.

Work windows intentionally retain their websites' document titles. Do not
decorate `document.title`, override website getters, inject a branding overlay,
or misrepresent a Chrome window ID as an OS window ID. This preserves page
semantics; the cost is that secondary windows do not each carry an owner prefix
in Mission Control or a window menu. Ownership is resolved deterministically
through the control listing and exact `peers()` target/window mapping, including
when two pages have identical titles. The control is attributable visually;
individual task windows are attributable through the recorded map.

The additional background windows are an explicit tradeoff. There is no
foreground activation control on the owner page. Agent peer reads continue
through the existing bounded inspection API rather than clicking another
connection's resources.

## Routing, reconciliation and cleanup

Continue to freshly verify each recorded tab's exact window before commands.
Discovery, root-frame proof, immutable target annotation and flattened child
sessions remain bound to the same recorded target, irrespective of window
granularity. `Browser.getWindowForTarget` reports the target's work window, not
the control window.

Keep pending-create reconciliation and ordered writes. A missing/ambiguous
native create result remains unknown until exact reconciliation; neither success
nor cleanup may be invented. Never close a different window in response.

Release closes and confirms every exact task tab first, which normally closes
its single-tab work window. Then close the control tab/window last, unbind the
empty lease and remove only that lease's registry entry. Verify native window
absence across all recorded work windows and the control window in live
qualification. Preserve unrelated normal windows, other owners and the shared
browser process.

## Required acceptance

1. Unit contracts distinguish control and target window IDs and reject malformed
   returns, wrong-window routing, foreign targets and unrecorded admission.
2. Two owners each create multiple work targets. Verify discovery, flattened
   cross-process frame routing, background rAF-dependent locator actions,
   snapshots, screenshots, network reads and exact per-target window bounds.
3. Exercise successful loopback and public navigation, then another loopback
   transition while the terminal remains foreground. Require unchanged frontmost
   PID in callbacks and every positive 50ms sample, not browser-window identity
   alone. Also prove `document.hidden === false` and running rAF.
4. Verify the control label, its current target listing and bounded peer mapping
   against actual created resources, including duplicate page titles and purpose
   changes. Never infer physical OS window numbers from Chrome IDs.
5. Close/reopen individual targets, close/reopen each connection, recover across
   permitted owned-fixture restarts and native-host crashes, and deliberately
   update targetless native runtime state. Verify all old target/control windows
   absent and zero leases, with unrelated windows/process generation unchanged.
6. Run the affected suites, existing coverage gates, independent review and
   genuine full Windows/native CI on the exact proposed head. After merge and
   release, normally refresh the installed plugin, compare installed source with
   the release and repeat actual shared-profile Terminal-foreground acceptance.

A single-page popup spike, source-only test or browser-foreground run cannot
substitute for these gates. The task remains validating until the actual
installed-release outcome and exact cleanup are verified.
