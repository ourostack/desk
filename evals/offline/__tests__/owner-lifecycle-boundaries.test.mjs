import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runFixedCase } from "../fixed-controller.mjs";
import { openRunOutput } from "../output.mjs";
import { privateControllerFixture } from "./helpers/private-controller.mjs";
import { completedControllerFixture } from "./helpers/completed-controller.mjs";
import { ownerCleanup } from "./helpers/owner-cleanup.mjs";

function options(f) {
  const outputRoot = path.join(f.root, "owner-boundaries");
  const output = openRunOutput({ outputRoot, authorizedRoot: f.root, protectedRoots: [], runContext: { runId: "source-owner-boundaries", cellId: f.cell.id, executionKind: f.cell.executionKind, planSha256: f.prepared.runSet.plan.sha256 }, limits: f.plan.limits });
  return { cell: f.cell, plan: f.plan, input: f.input, outputRoot, output, bindingAdmitted: true };
}

test("an already cancelled private acquisition closes without invoking any private callback", async () => {
  const f = await privateControllerFixture();
  const controller = new AbortController();
  f.opened.protocol.signal = controller.signal;
  controller.abort();
  let callbacks = 0;
  f.input.createDeskCallbacks = async () => { callbacks++; return f.p.callbacks; };
  const result = await runFixedCase(options(f));
  assert.equal(result.status, "cancelled");
  assert.equal(result.grade, null);
  assert.equal(callbacks, 0);
  assert.equal(f.closes, 1);
});

test("a refused reacquisition closes both registered owners without starting the next turn", async () => {
  const f = await completedControllerFixture("review-recovery-state");
  let confined = 0;
  f.input.assertConfinement = async () => ++confined === 2 ? false : undefined;
  await assert.rejects(runFixedCase(options(f)), { code: "NATIVE_CONFINEMENT_UNVERIFIED" });
  assert.equal(confined, 2);
  assert.equal(f.closes, 2);
});

test("the captured owner close and cancellation signal cannot be replaced during confinement", async () => {
  const f = await privateControllerFixture();
  const controller = new AbortController();
  f.opened.protocol.signal = controller.signal;
  const close = f.opened.close;
  f.opened.close = async function () { controller.abort(); return close.call(this); };
  f.input.assertConfinement = async ({ opened }) => {
    opened.close = async () => { throw new Error("Replaced close must not run"); };
    opened.protocol = { ...opened.protocol, signal: new AbortController().signal };
  };
  const result = await runFixedCase(options(f));
  assert.equal(result.status, "cancelled");
  assert.equal(result.grade, null);
  assert.equal(f.closes, 1);
});

test("cancellation during reacquisition closes the new owner without dispatching it", async () => {
  const f = await completedControllerFixture("review-recovery-state");
  const controller = new AbortController();
  f.opened.protocol.signal = controller.signal;
  const open = f.input.open;
  let acquisitions = 0;
  f.input.open = async args => {
    const owner = await open(args);
    if (++acquisitions === 2) controller.abort();
    return owner;
  };
  const result = await runFixedCase(options(f));
  assert.equal(result.status, "cancelled");
  assert.equal(result.checkpoints.length, 1);
  assert.equal(f.closes, 2);
});

test("cancellation after a canonical checkpoint does not permit a resumed acquisition", async () => {
  const f = await completedControllerFixture("review-recovery-state");
  const controller = new AbortController();
  f.opened.protocol.signal = controller.signal;
  const input = options(f);
  const write = input.output.writeArtifact;
  input.output = { ...input.output, writeArtifact(name, bytes) {
    const result = write(name, bytes);
    if (name.endsWith("canonical-stopped-0.json")) controller.abort();
    return result;
  } };
  const result = await runFixedCase(input);
  assert.equal(result.status, "cancelled");
  assert.equal(result.checkpoints.length, 1);
  assert.equal(f.closes, 1);
});

test("cancellation after the last held-out observation prevents the judge", async () => {
  const f = await completedControllerFixture("checker-is-enforced");
  const controller = new AbortController();
  f.opened.protocol.signal = controller.signal;
  const input = options(f);
  const write = input.output.writeArtifact;
  input.output = { ...input.output, writeArtifact(name, bytes) {
    const result = write(name, bytes);
    if (name.endsWith("maintained-checker-invoked-observation.json")) controller.abort();
    return result;
  } };
  const result = await runFixedCase(input);
  assert.equal(result.status, "cancelled");
  assert.equal(result.grade, null);
  assert.equal(result.counts.observedRequests, 0);
});

test("a partial cleanup capture failure cannot admit its otherwise valid receipt", async () => {
  const f = await privateControllerFixture();
  const input = options(f);
  const write = input.output.writeArtifact;
  input.output = { ...input.output, writeArtifact(name, bytes) {
    if (name === "owner-1-exitObservations-1.json") throw Object.assign(new Error("Synthetic output failure"), { code: "SOURCE_CAPTURE_FAILURE" });
    return write(name, bytes);
  } };
  await assert.rejects(runFixedCase(input), error => error instanceof AggregateError && error.code === "SOURCE_CAPTURE_FAILURE" && error.observedCounts.admittedGrades === 0);
  assert.equal(f.closes, 1);
});

for (const thrown of [null, undefined]) test(`a close throwing ${String(thrown)} remains an explicit aggregate failure`, async () => {
  const f = await privateControllerFixture();
  f.opened.close = async () => { throw thrown; };
  await assert.rejects(runFixedCase(options(f)), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === thrown && error.observedCounts.admittedGrades === 0);
});

test("callback failure counts survive a separate close failure without an admitted grade", async () => {
  const f = await privateControllerFixture();
  const failure = Object.assign(new Error("Synthetic callback failure"), { observedCounts: { observedRequests: 2, schemaAcceptedHandlers: 1, validatorAcceptedReports: 1, admittedGrades: 1 } });
  f.input.createDeskCallbacks = async () => { throw failure; };
  f.opened.close = async () => { throw undefined; };
  await assert.rejects(runFixedCase(options(f)), error => error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === undefined && error.observedCounts.observedRequests === 2 && error.observedCounts.admittedGrades === 0);
});

test("reusing a carrier object cannot collapse separately acquired generations or replace their closes", async () => {
  const f = await completedControllerFixture("review-recovery-state");
  const acquired = [];
  const closed = [];
  f.input.open = async ({ runId }) => {
    acquired.push(runId);
    f.opened.close = async () => { closed.push(runId); return ownerCleanup(runId); };
    return f.opened;
  };
  assert.equal((await runFixedCase(options(f))).status, "passed");
  assert.equal(acquired.length, 3);
  assert.deepEqual(closed, acquired);
});

test("an exhausted shared deadline still attempts every close and rejects in-budget claims from late owners", async t => {
  const f = await completedControllerFixture("review-recovery-state");
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const closed = [];
  f.input.open = async ({ runId }) => ({ ...f.opened, close: async () => {
    closed.push(runId);
    now = f.plan.limits.cleanup.totalMs + 1;
    return ownerCleanup(runId);
  } });
  await assert.rejects(runFixedCase(options(f)), error => error instanceof AggregateError && error.errors.length === 3 && error.errors.every(item => item.code === "NATIVE_OWNER_STOP_UNVERIFIED") && error.observedCounts.admittedGrades === 0);
  assert.equal(closed.length, 3);
});
