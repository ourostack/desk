# Native Background Target Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep multi-page native browser work responsive and attributable without
activating the operator's browser application.

**Architecture:** Retain one attested profile/context and lease per connection.
Create a stable owner control popup and a separately recorded popup for each task
target. Reuse the existing independent per-target window routing and exact
opener-based descendant admission.

**Tech Stack:** Existing Chrome extension APIs, Node native messaging, the native
CDP adapter, maintained Playwright MCP and the existing test/coverage runners.

**Spec:** `docs/superpowers/specs/2026-10-11-native-background-target-windows.md`

## Global Constraints

- No shared browser restart, security-policy/permission changes, debug flags,
  notification suppression or after-the-fact focus restoration.
- Create both control and work windows with `type: "popup", focused: false`;
  each deliberately created window must return exactly one tab.
- Preserve the existing browser floor of 125, dependencies, immutable source and
  profile-proof contracts, bounded peer reads and recovery on new calls.
- Persisted `nativeRouting.windowId` remains the control window;
  `nativeRouting.targetTabs[targetId].windowId` remains that target's window.
- `target.create.windowId` means the work window; new `controlWindowId` means the
  control window. Never guess one from the other.
- Preserve page titles, the operator's unrelated resources, complete native
  production-leaf coverage and genuine full Windows/native CI gates.
- Keep live browser receipts and capabilities in the task's protected evidence
  directory, not product commits. Retain every failed receipt.

## Review Focus

- An ambiguous native create must remain pending/unknown, never route into a
  normal fallback window or report successful cleanup.
- A moved owned tab must be refused against its own recorded window, not the
  control's window or another owner's resource.
- Identical or hostile page titles must not collapse distinct window mappings
  or inject markup into the control page.
- A content-spawned popup must still require its exact recorded owned opener;
  browser window type alone supplies no authority.
- A native-host interruption with several work windows must restore the exact
  existing routing or fail closed, never duplicate the windows.

---

## Task 1: Create and route independently recorded popup windows

**Files**

- Modify `plugins/desk/browser-extension/background.js`: `target.create`.
- Modify `plugins/desk/browser-context-broker/src/native-cdp.mjs`:
  `Target.createTarget` response validation and control-routing publication.
- Test `tests/desk/mcp/__tests__/launch/browser_extension.test.js`.
- Test `tests/desk/browser-context-broker/test/native-cdp.test.mjs`.
- Test `tests/desk/browser-context-broker/test/native-provider.test.mjs`.

**Interfaces**

- Extension `target.create({marker, markerUrl})` returns the existing fields plus
  `controlWindowId: number`; `windowId: number` is the work window.
- Existing `recordNativeRouting(...)` consumes the control's `windowId` and the
  independently scoped `{tabId, windowId}` for each virtual target.
- `ownTab(lease, tabId)` and restoration retain their existing per-record window
  verification and opener admission, not window-type authority.

- [ ] **Step 1:** Add RED extension tests for two created work targets: all three
  windows are popup/unfocused, each target has a different exact window, the
  control stays stable, and no `tabs.create` fallback is dispatched. Add native
  CDP assertions that control routing uses `controlWindowId` and each target uses
  its own returned `windowId`; reject absent/invalid control identity.
- [ ] **Step 2:** Run `node --test tests/desk/mcp/__tests__/launch/browser_extension.test.js tests/desk/browser-context-broker/test/native-cdp.test.mjs`
  and preserve the failing receipt. Confirm failures exercise the old creation
  or field semantics, not unrelated setup.
- [ ] **Step 3:** Replace deliberate task-tab creation with one exact popup create.
  Record only confirmed returned identities. Return `controlWindowId`; validate
  it in native CDP before publishing unchanged persisted routing semantics.
  Retain the existing pending-create/refusal behavior for ambiguous effects.
- [ ] **Step 4:** Pin wrong-window and malformed-create negatives, exact target
  close followed by control-last cleanup, content-popup opener admission across
  different windows, and restoration of multiple unchanged target-window routes
  without extra creates.
- [ ] **Step 5:** Replace fixed wait mechanisms in the two failing baseline
  native admission/event fixtures with bounded condition/event completion.
  Preserve every negative ordering and authoritative-registry assertion; do not
  relax operation deadlines or coverage. Record each original failure.
- [ ] **Step 6:** Run the three affected files together and require zero failures.
  Inspect the exact diff, then commit only Task 1 source/tests with the required
  commit provenance.

## Task 2: Expose attributable recorded windows without changing page semantics

**Files**

- Modify `plugins/desk/browser-extension/{background.js,control.js,control.html}`.
- Modify `plugins/desk/browser-context-broker/src/native-provider.mjs`: `peers`.
- Modify `plugins/desk/skills/cdp-headed-browser/SKILL.md` for the amended native
  window model and unchanged cleanup/peer boundaries.
- Test `tests/desk/mcp/__tests__/launch/browser_extension.test.js`.
- Test `tests/desk/browser-context-broker/test/native-provider.test.mjs`.
- Test `tests/desk/mcp/__tests__/launch/web_real_profile.test.js`.

**Interfaces**

- Public peers preserve `leaseId`, `owner`, `work`, `windowId` and `targetIds`;
  add `targetWindows: Array<{targetId: string, windowId: number}>`, bounded by the
  existing recorded routing limit. `windowId` still identifies the control.
- The control URL carries bounded recorded target entries
  `{tabId: number, windowId: number, title: string}`. Render through `textContent`,
  not HTML, and retain the existing ownership/lease-marker proof.
- Fresh `target.readback` updates the control projection from freshly verified
  owned tabs. Update it only when that projection changes. Closing a target and
  its confirmed readback remove the entry; purpose changes preserve routing.

- [ ] **Step 1:** Add RED tests for separate control/target window IDs in peer
  output, unchanged existing fields and absence of endpoints/unrecorded windows.
  Add control rendering tests for duplicate titles, hostile markup, empty titles,
  purpose changes and removal after exact close/readback.
- [ ] **Step 2:** Run the affected extension/provider/real-profile tests and retain
  the failure receipt before source changes.
- [ ] **Step 3:** Implement the bounded recorded peer projection. Extend the
  control hash/rendering with verified owned target entries and literal text
  rendering. Do not modify task documents' titles or expose activation controls.
  Refresh through existing serialized native operations/readback rather than a
  browser-global inventory or a new background polling service.
- [ ] **Step 4:** Update the existing native-browser guidance to say one control
  popup plus separate work popups per lease; explain exact recorded maps and
  preserved website titles. Keep the unsupported legacy path distinct.
- [ ] **Step 5:** Run the affected tests to zero failures; check full launcher and
  broker suites using their existing runners. Require the unchanged production
  coverage gates, review the diff and commit Task 2 source/tests/guidance.

## Task 3: Qualify, review, deliver and reconcile the actual installed outcome

**Files/resources**

- Use the existing protected ordinary-install and shared-profile qualification
  harnesses linked from the bound task handover; update their window accounting
  to track all exact control and work windows, preserving older receipts.
- Update the existing private execution ledger and canonical task through Desk.
- Change product tests/code only for failures caused by or directly coupled to
  Tasks 1 and 2, with a separate RED/GREEN receipt for each correction.

**Interfaces**

- Qualification selects source/installed MCP via `QUALIFY_MCP_ROOT` and the
  installed launcher's normal native preparation/update flow.
- Live acceptance accounts for every recorded target window separately from
  the control, and correlates Chrome IDs with native windows rather than treating
  them as interchangeable.

- [ ] **Step 1:** Normally update only the exact targetless owned fixture extension;
  run two owners with multiple work targets, flattened cross-origin frames,
  background rAF-dependent click/fill, screenshot/snapshot/network, purpose,
  duplicate-title peer maps, individual target close/reopen and connection
  close/reopen. Require every control/work window absent after release.
- [ ] **Step 2:** Repeat successful loopback, public and later loopback navigation
  with Terminal foreground, callbacks and every positive 50ms sample unchanged,
  `document.hidden === false`, running rAF and completed input. Preserve a
  separate receipt for each run; do not restore focus after failures.
- [ ] **Step 3:** Exercise owned-fixture normal restarts, native-host crashes and
  deliberate targetless updates. Require exact restoration or explicit refusal,
  no duplicate creates, no replay of interrupted actions and zero final leases.
- [ ] **Step 4:** Obtain an independent whole-branch code review and adversarial
  requirement acceptance. Fix findings with targeted tests before requesting
  exact-head approval. Open only our product PR.
- [ ] **Step 5:** Require every exact-head check terminal/success, including the
  genuine full eight-shard Windows suite and aggregator, before merge. Verify
  the actual carried release workflow/version, not a PR dry run.
- [ ] **Step 6:** Perform ordinary `agency plugin install github:ourostack/desk:plugins/desk@main --refresh`,
  compare installed load-bearing source with the release and normally update
  the exact targetless product extension. Repeat Step 2 and the complete
  multi-target shared-profile acceptance against that installed runtime.
- [ ] **Step 7:** Freshly attest and normally quit only the wholly owned fixture
  Chrome/Edge processes, confirming their absence. Reconcile the newly owned
  Terminal and every exact setup/prototype resource; retain profile proof and
  failure receipts. Never quit the shared browser or guess historical windows.
- [ ] **Step 8:** Obtain final adversarial outcome acceptance and update/archive
  the browser-specific task with released evidence. Do not mark unrelated
  umbrella/deferred work complete.
