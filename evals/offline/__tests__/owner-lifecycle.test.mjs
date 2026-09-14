import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { heldOutChecks } from "../check-executor.mjs";
import { checkerProcess } from "../checker-process.mjs";
import { validateCleanupReceipt } from "../copilot-runner.mjs";
import { jsonBytes, sha256 } from "../core.mjs";
import { runFixedCase, runFixedController } from "../fixed-controller.mjs";
import { openRunOutput } from "../output.mjs";
import { completedControllerFixture } from "./helpers/completed-controller.mjs";
import { controllerFixture } from "./helpers/controller-fixture.mjs";
import { privateControllerFixture } from "./helpers/private-controller.mjs";
import { ownerCleanup } from "./helpers/owner-cleanup.mjs";

function options(f, bindingAdmitted = true) {
  const outputRoot = path.join(f.root, "owner-lifecycle");
  const output = openRunOutput({ outputRoot, authorizedRoot: f.root, protectedRoots: [], runContext: { runId: "owner-source-control", cellId: f.cell.id, executionKind: f.cell.executionKind, planSha256: f.prepared.runSet.plan.sha256 }, limits: f.plan.limits });
  return { cell: f.cell, plan: f.plan, input: f.input, outputRoot, output, bindingAdmitted };
}

function owners(f, close = stopped => stopped) {
  const acquired = [];
  const closed = [];
  f.input.open = async args => {
    const index = acquired.length;
    const stopped = ownerCleanup(args.runId ?? `unbound-source-${index}`);
    const owner = { ...f.opened, close: async () => {
      closed.push(index);
      return close(stopped, index, acquired);
    } };
    acquired.push({ args, owner, stopped });
    return owner;
  };
  return { acquired, closed };
}

const unverified = error => error instanceof AggregateError && error.errors.some(item => item?.code === "NATIVE_OWNER_STOP_UNVERIFIED") && error.observedCounts.admittedGrades === 0;

test("explicit false capability refusal wins without changing the throwing-void assertion contract", async t => {
  const f = await controllerFixture();
  let opens = 0;
  f.input.open = async () => { opens++; throw new Error("Must not acquire"); };
  t.mock.method(heldOutChecks, "assertAvailable", () => false);
  await assert.rejects(runFixedController({ prepared: f.prepared, nativeInputs: f.nativeInputs }), { code: "NATIVE_QUALIFICATION_REQUIRED" });
  await assert.rejects(runFixedCase(options(f)), { code: "NATIVE_QUALIFICATION_REQUIRED" });
  assert.equal(opens, 0);
  assert.equal(f.prepared.runSet.attempts.length, 0);
});

for (const name of ["assertAllocation", "assertSourceAndRuntime"]) test(`${name} explicit refusal cannot be discarded before acquisition`, async () => {
  const f = await controllerFixture();
  let opens = 0;
  f.nativeInputs[name] = async () => false;
  f.input.open = async () => { opens++; throw new Error("Must not acquire"); };
  await assert.rejects(runFixedController({ prepared: f.prepared, nativeInputs: f.nativeInputs }), { code: "NATIVE_QUALIFICATION_REQUIRED" });
  assert.equal(opens, 0);
  assert.equal(f.prepared.runSet.attempts.length, 0);
});

test("explicit false confinement refuses work but still closes its acquired generation", async () => {
  const f = await privateControllerFixture();
  const owned = owners(f);
  f.input.assertConfinement = async () => false;
  await assert.rejects(runFixedCase(options(f)), { code: "NATIVE_CONFINEMENT_UNVERIFIED" });
  assert.deepEqual(owned.closed, [0]);
  assert.equal(f.p.state.items.size, 0);
});

test("the actual held-out command receives cancellation and cannot turn a cancelled check into a grade", async t => {
  const f = await completedControllerFixture("checker-is-enforced");
  const controller = new AbortController();
  f.opened.protocol.signal = controller.signal;
  const owned = owners(f);
  const capture = checkerProcess.capture;
  const signals = [];
  t.mock.method(checkerProcess, "capture", async request => {
    signals.push(request.signal);
    controller.abort();
    return capture(request);
  });
  const result = await runFixedCase(options(f));
  assert.deepEqual(signals, [controller.signal]);
  assert.equal(result.status, "cancelled");
  assert.equal(result.grade, null);
  assert.equal(result.counts.admittedGrades, 0);
  assert.deepEqual(owned.closed, [0]);
});

for (const value of [undefined, false]) test(`subject admission rejects a ${String(value)} close result`, async () => {
  const f = await completedControllerFixture("checker-is-enforced");
  const owned = owners(f, () => value);
  await assert.rejects(runFixedCase(options(f)), unverified);
  assert.deepEqual(owned.closed, [0]);
});

test("every acquisition receives a distinct generation and retains its validated close receipt", async () => {
  const f = await completedControllerFixture("review-recovery-state");
  const owned = owners(f);
  const input = options(f);
  const result = await runFixedCase(input);
  assert.equal(result.status, "passed");
  assert.deepEqual(owned.closed, [0, 1, 2]);
  const ids = owned.acquired.map(value => value.args.runId);
  assert.ok(ids.every(id => typeof id === "string" && id.length > 0));
  assert.equal(new Set(ids).size, 3);
  for (const [index, runId] of ids.entries()) {
    const captured = JSON.parse(fs.readFileSync(path.join(input.outputRoot, `owner-${index + 1}-cleanup.json`)));
    assert.equal(captured.runId, runId);
    assert.equal(validateCleanupReceipt(captured.receipt, { runId, requireRunId: true, readArtifact: name => fs.readFileSync(path.join(input.outputRoot, name)) }).ok, true);
  }
});

test("an earlier invalid close is not rescued by later valid generations", async () => {
  const f = await completedControllerFixture("review-recovery-state");
  const owned = owners(f, (stopped, index) => index === 0 ? undefined : stopped);
  await assert.rejects(runFixedCase(options(f)), unverified);
  assert.deepEqual(owned.closed, [0, 1, 2]);
});

test("a valid prior-generation receipt cannot close a later acquisition", async () => {
  const f = await completedControllerFixture("review-recovery-state");
  const owned = owners(f, (stopped, index, acquired) => index === 1 ? acquired[0].stopped : stopped);
  await assert.rejects(runFixedCase(options(f)), unverified);
  assert.deepEqual(owned.closed, [0, 1, 2]);
});

test("current owner admission refuses generation-free raw records even with recomputed hashes", async () => {
  const f = await privateControllerFixture();
  owners(f, stopped => {
    for (const row of [...stopped.receipt.ownedSpawns, ...stopped.receipt.exitObservations]) {
      const raw = JSON.parse(stopped.readArtifact(row.rawRef.path));
      delete raw.runId;
      const bytes = jsonBytes(raw);
      stopped.artifacts.set(row.rawRef.path, bytes);
      Object.assign(row.rawRef, { sha256: sha256(bytes), byteLength: bytes.length });
    }
    return stopped;
  });
  await assert.rejects(runFixedCase(options(f)), unverified);
});

test("cancellation during final close withholds the already observed judge result", async () => {
  const f = await completedControllerFixture("checker-is-enforced");
  const controller = new AbortController();
  f.opened.protocol.signal = controller.signal;
  owners(f, stopped => { controller.abort(); return stopped; });
  const result = await runFixedCase(options(f));
  assert.equal(result.status, "cancelled");
  assert.equal(result.grade, null);
  assert.equal(result.counts.observedRequests, 1);
  assert.equal(result.counts.admittedGrades, 0);
});

test("an unverified close can publish only an unavailable failure, never the provisional grade or a retry", async () => {
  const f = await completedControllerFixture("discussion-then-go");
  owners(f, () => undefined);
  const result = await runFixedController({ prepared: f.prepared, nativeInputs: f.nativeInputs });
  assert.equal(result.exitCode, 3);
  assert.equal(result.attempts, 1);
  const attempt = f.prepared.runSet.attempts[0];
  const receipt = JSON.parse(fs.readFileSync(path.join(f.prepared.root, attempt.receipt.path)));
  assert.equal(receipt.status, "unavailable");
  assert.equal(receipt.grade, null);
  assert.equal(receipt.counts.admittedGrades, 0);
  assert.equal(f.prepared.runSet.unstartedCellIds.length, 11);
});

test("a final close is bounded and a late receipt cannot rescue or publish its timed-out generation", async t => {
  const f = await privateControllerFixture();
  let now = 0;
  let expire;
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    expire = () => { now += delay + 1; callback(); };
    return {};
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  let started;
  const closing = new Promise(resolve => { started = resolve; });
  let late;
  owners(f, stopped => new Promise(resolve => {
    late = () => resolve(stopped);
    started();
  }));
  const input = options(f);
  let settled;
  const pending = runFixedCase(input).then(value => { settled = { value }; }, error => { settled = { error }; });
  await closing;
  assert.equal(typeof expire, "function", "The owner close must have a caller-enforced deadline");
  expire();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(settled, "The caller must finish within its cleanup deadline even when the owner never returns");
  assert.ok(unverified(settled.error));
  late();
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(input.outputRoot, "owner-1-cleanup.json")), false);
});
