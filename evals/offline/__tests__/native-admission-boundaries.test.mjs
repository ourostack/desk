import assert from "node:assert/strict";
import test from "node:test";
import { isSuccessfulIdle, normalizeJudgeObservations, reconcileJudgeHistory } from "../admission.mjs";
import { heldOutChecks, requireTrustedChecker } from "../check-executor.mjs";
import { jsonBytes, sha256 } from "../core.mjs";
import { validReport } from "./helpers/native-sdk.mjs";
import { testCheckerPreflight } from "./helpers/checker-preflight.mjs";

const qualified = /NATIVE_QUALIFICATION_REQUIRED/u;
test("a fully exercised parent preflight is the only route to conditional checker admission", () => {
  const f = testCheckerPreflight();
  assert.equal(requireTrustedChecker({ preflight: f.receipt, expected: f.expected }), true);
  assert.equal(heldOutChecks.assertAvailable({ preflight: f.receipt, expected: f.expected }), true);
  // The same immutable receipt admits repeatedly; admission is a recheck, not a one-time latch.
  assert.equal(requireTrustedChecker({ preflight: Object.freeze(structuredClone(f.receipt)), expected: f.expected }), true);
});
test("absent, malformed or unexercised admission arguments raise the typed refusal, never a destructuring error", () => {
  assert.throws(() => requireTrustedChecker(), qualified);
  for (const context of [null, undefined, "receipt", 7, [], { preflight: undefined, expected: undefined }]) assert.throws(() => requireTrustedChecker(context), qualified);
  const f = testCheckerPreflight();
  for (const context of [{ preflight: f.receipt }, { expected: f.expected }, { preflight: f.receipt, expected: {} }, { preflight: f.receipt, expected: { identities: f.expected.identities } }, { preflight: f.receipt, expected: { identities: null, readEvidence: f.expected.readEvidence, observeIdentities: f.observe } }]) {
    assert.throws(() => requireTrustedChecker(context), qualified);
  }
});
for (const [label, mutate] of [
  ["an unavailable status", receipt => ({ ...receipt, status: "unavailable" })],
  ["a cancelled preflight", receipt => ({ ...receipt, status: "unavailable", checks: { ...receipt.checks, namespaceCleanup: false } })],
  ["a false isolation check", receipt => ({ ...receipt, checks: { ...receipt.checks, isolation: false } })],
  ["a false hidden-assertion check", receipt => ({ ...receipt, checks: { ...receipt.checks, hiddenAssertionsSeparated: false } })],
  ["a missing capture bound", receipt => ({ ...receipt, checks: { ...receipt.checks, boundedCapture: false } })],
  ["a missing EOF and cleanup reconciliation", receipt => ({ ...receipt, checks: { ...receipt.checks, namespaceCleanup: false } })],
  ["unfrozen identities", receipt => ({ ...receipt, checks: { ...receipt.checks, frozenIdentities: false } })],
  ["an extra invented check", receipt => ({ ...receipt, checks: { ...receipt.checks, nativelyAttested: true } })],
  ["a wrong schema version", receipt => ({ ...receipt, schemaVersion: 2 })],
  ["a widened claim scope", receipt => ({ ...receipt, claimScope: "native_authenticity" })],
  ["absent evidence references", receipt => ({ ...receipt, evidenceRefs: [] })],
  ["a malformed evidence reference", receipt => ({ ...receipt, evidenceRefs: [...receipt.evidenceRefs, { path: "../escape.raw", sha256: "0".repeat(64) }] })],
  ["a non-hex identity", receipt => ({ ...receipt, identities: { ...receipt.identities, runtimeSha256: "NOT-A-DIGEST" } })],
  ["a missing identity", receipt => ({ ...receipt, identities: { controllerSha256: receipt.identities.controllerSha256 } })],
  ["a candidate-forged available claim", receipt => ({ ...receipt, status: "available", parsedCandidateOutput: { status: "available", trusted: true }, identities: { ...receipt.identities, launcherSha256: "b".repeat(64) } })],
]) test(`checker admission refuses ${label}`, () => {
  const f = testCheckerPreflight();
  assert.throws(() => requireTrustedChecker({ preflight: mutate(f.receipt), expected: f.expected }), qualified);
});
for (const [label, mutate] of [
  ["a changed candidate source manifest", f => f.mutateSource()],
  ["a changed held-out controller manifest", f => f.mutateController()],
  ["a changed launcher", f => f.mutateLauncher()],
]) test(`checker admission refuses ${label} observed after the receipt`, () => {
  const f = testCheckerPreflight();
  assert.equal(requireTrustedChecker({ preflight: f.receipt, expected: f.expected }), true);
  mutate(f);
  // The parent's own observer is re-read at this boundary, so no frozen declared snapshot can carry the change.
  assert.throws(() => requireTrustedChecker({ preflight: f.receipt, expected: f.expected }), qualified);
  assert.throws(() => requireTrustedChecker({ preflight: f.receipt, expected: { ...f.expected, identities: f.observe() } }), qualified);
});
test("a declared identity snapshot without an observer cannot admit, and a malformed observation refuses", () => {
  const f = testCheckerPreflight();
  // A caller that cannot observe identities again has no way to detect drift, so the snapshot alone is refused.
  assert.throws(() => requireTrustedChecker({ preflight: f.receipt, expected: { identities: f.expected.identities, readEvidence: f.expected.readEvidence } }), qualified);
  assert.throws(() => requireTrustedChecker({ preflight: f.receipt, expected: { ...f.expected, observeIdentities: f.expected.identities } }), qualified);
  for (const observeIdentities of [() => ({}), () => ({ ...f.expected.identities, runtimeSha256: "NOT-HEX" }), () => ({ ...f.expected.identities, launcherSha256: "e".repeat(64) })]) {
    assert.throws(() => requireTrustedChecker({ preflight: f.receipt, expected: { ...f.expected, observeIdentities } }), qualified);
  }
});
test("an evidence reader fault is a host failure, not a qualification answer", () => {
  const f = testCheckerPreflight();
  const fault = Object.assign(new Error("Synthetic host storage fault"), { code: "EIO" });
  assert.throws(() => requireTrustedChecker({ preflight: f.receipt, expected: { ...f.expected, readEvidence: () => { throw fault; } } }), error => error === fault);
  const bug = new TypeError("Synthetic reader defect");
  assert.throws(() => requireTrustedChecker({ preflight: f.receipt, expected: { ...f.expected, readEvidence: () => { throw bug; } } }), error => error === bug);
});
test("a stale receipt whose identities no longer equal freshly observed identities is refused", () => {
  const f = testCheckerPreflight();
  for (const name of ["controllerSha256", "runtimeSha256", "launcherSha256", "sourceManifestSha256"]) {
    assert.throws(() => requireTrustedChecker({ preflight: { ...f.receipt, identities: { ...f.receipt.identities, [name]: "c".repeat(64) } }, expected: f.expected }), qualified);
  }
});
test("every evidence reference is read and hash-verified, so truncated, absent or mutated bytes refuse", () => {
  const truncated = testCheckerPreflight();
  truncated.truncate("hidden-read-status.raw");
  assert.throws(() => requireTrustedChecker({ preflight: truncated.receipt, expected: truncated.expected }), qualified);
  const absent = testCheckerPreflight();
  absent.remove("cancellation-probe.json");
  assert.throws(() => requireTrustedChecker({ preflight: absent.receipt, expected: absent.expected }), qualified);
  const unreadable = testCheckerPreflight();
  assert.throws(() => requireTrustedChecker({ preflight: unreadable.receipt, expected: { ...unreadable.expected, readEvidence: () => "not raw bytes" } }), qualified);
});
test("a receipt admitted once is rechecked, so evidence changed between open and use refuses", () => {
  const f = testCheckerPreflight();
  assert.equal(requireTrustedChecker({ preflight: f.receipt, expected: f.expected }), true);
  f.truncate("write-denied-probe.json");
  assert.throws(() => requireTrustedChecker({ preflight: f.receipt, expected: f.expected }), qualified);
});

test("idle needs an explicit expected mode and rejects malformed or cancelled flags", () => {
  for (const data of [undefined, null, {}, [], { mode: "autopilot" }, { mode: "interactive", aborted: true }, { mode: "interactive", aborted: null }, { mode: "interactive", aborted: "false" }]) assert.equal(isSuccessfulIdle(data, "interactive"), false);
  for (const expected of [undefined, null, ""]) assert.equal(isSuccessfulIdle({ mode: expected }, expected), false);
  assert.equal(isSuccessfulIdle({ mode: "interactive" }, "interactive"), true);
  assert.equal(isSuccessfulIdle({ mode: "interactive", aborted: false }, "interactive"), true);
});

function observed(history) {
  let offset = 0;
  return normalizeJudgeObservations({
    sessionId: "native", rootAgentId: null, expectedMode: "interactive",
    events: history.map(event => {
      const rawRecord = jsonBytes(event);
      const value = { sessionId: "native", rawRecord, ref: { path: "events.jsonl", sessionId: "native", eventId: event.id, byteOffset: offset, byteLength: rawRecord.length, sha256: sha256(rawRecord) } };
      offset += rawRecord.length;
      return value;
    }),
  });
}
const event = (id, type, data) => ({ id, type, data });
const stream = () => [
  event("turn", "assistant.turn_start", { turnId: "turn" }),
  event("report", "assistant.message", { turnId: "turn", toolRequests: [{ name: "report_result", toolCallId: "report-call", arguments: validReport() }] }),
  { ...event("idle", "session.idle", { mode: "interactive" }), ephemeral: true },
];
test("ephemeral terminal handling does not erase missing, partial, unobserved or extra root attempts", () => {
  const live = stream();
  const observation = observed(live);
  const compare = history => reconcileJudgeHistory({ history, observed: observation, sessionId: "native", rootAgentId: null, expectedMode: "interactive" });
  assert.equal(compare(live.slice(0, -1)), true);
  assert.equal(compare(live.slice(0, 1)), false);
  assert.equal(compare(live.slice(1, -1)), false);
  assert.equal(compare([...live.slice(0, -1), event("partial", "assistant.tool_call_delta", { turnId: "turn", toolName: "report_result", toolCallId: "pending" })]), false);
  assert.equal(compare([...live.slice(0, -1), event("unobserved", "assistant.message", { turnId: "turn", toolRequests: [{ name: "report_result", toolCallId: "unobserved" }] })]), false);
  assert.equal(compare([...live.slice(0, -1), event("extra", "assistant.message", { turnId: "turn", toolRequests: [{ name: "report_result", toolCallId: "extra", arguments: validReport() }] })]), false);
  assert.equal(compare([...live.slice(0, -1), event("idle", "session.idle", { mode: "interactive", aborted: false })]), true);
  assert.equal(compare([...live.slice(0, -1), event("other-idle", "session.idle", { mode: "interactive", aborted: false })]), false);
});
