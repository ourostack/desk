import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealmLifecycle } from "../src/account-runtime.js";
import { serveTokens } from "../src/token-socket.js";
import { serviceOutputFailure } from "../src/service-output.js";

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const outcome = promise => promise.then(
  () => "fulfilled",
  error => ({ code: error.code, quiescent: error.quiescent }),
);

async function setup(t, { holdPush = false, holdBroker = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "desk-r3-"));
  console.log(`retained R3 unit root: ${root}`);
  writeFileSync(join(root, "recovery"), "retained lifecycle unit evidence");
  const broker = serveTokens({ socketPath: join(root, "broker.sock"), mint: async () => ({ token: "synthetic" }) });
  await broker.ready;
  const pushGate = deferred();
  const brokerGate = deferred();
  const brokerEntered = deferred();
  const services = new Set();
  const preservationFailures = new Map();
  const state = { push: 0, brokerClose: 0, purge: 0, failure: undefined, stopped: false };
  const preserve = (error, child) => {
    state.failure = error;
    state.stopped = true;
    preservationFailures.set("unit", { error, child });
  };
  const lifecycle = createRealmLifecycle({
    services, operations: new Set(), failure: () => preservationFailures.get("unit")?.error, preserve,
    stop: () => { state.stopped = true; },
    async push() { state.push++; if (holdPush) await pushGate.promise; },
    async closeBroker() {
      state.brokerClose++;
      brokerEntered.resolve();
      if (holdBroker) await brokerGate.promise;
      await new Promise(resolve => broker.close(resolve));
    },
    async purgeRoot() {
      state.purge++;
      writeFileSync(join(root, "purged"), "would authorize owning-UID purge");
    },
  });
  t.after(async () => {
    pushGate.resolve();
    brokerGate.resolve();
    if (broker.listening) await new Promise(resolve => broker.close(resolve));
  });
  const service = async ({ buffered = true, retired = true, protocolClosed = true } = {}) => {
    const guardian = Object.assign(new EventEmitter(), {
      connected: true, exitCode: null, signalCode: null, stdin: new PassThrough(), pid: 42,
      sent: [], signals: [],
      send(message, callback) { this.sent.push(message); callback?.(); return true; },
      kill(signal) {
        if (this.exitCode !== null || this.signalCode !== null) return false;
        this.signals.push(signal);
        return true;
      },
    });
    const handle = lifecycle.service(guardian);
    const errors = [];
    handle.on("error", error => errors.push(error));
    handle.stdout.resume();
    if (buffered) guardian.emit("message", { serviceStderr: Buffer.alloc(8192, 7).toString("base64"), serviceOutputId: 1 });
    if (protocolClosed) guardian.emit("message", { serviceClosed: true, code: 0, signal: null });
    if (retired) {
      guardian.emit("message", { retired: true, quiescent: true });
      guardian.connected = false;
      guardian.exitCode = 0;
      guardian.emit("disconnect");
      guardian.emit("close", 0);
    }
    await turn();
    return { guardian, handle, errors };
  };
  return { root, broker, lifecycle, state, services, preserve, pushGate, brokerGate, brokerEntered, service };
}

test("credited buffered protocol after positive retirement cannot authorize a successful close or purge after consumer failure", async t => {
  const f = await setup(t, { holdPush: true });
  const { handle, errors } = await f.service();
  assert.equal(handle.stderr.readableLength, 8192);
  assert.equal(handle.stderr.readableEnded, false);
  const closing = f.lifecycle.close();
  const result = outcome(closing);
  await turn();
  const pushStartedBeforeFailure = f.state.push > 0;
  handle.stderr.destroy();
  await turn();
  assert.equal(errors.length, 1);
  assert.equal(f.state.failure.quiescent, false);
  f.pushGate.resolve();
  const closed = await result;
  const repeated = await outcome(f.lifecycle.close());
  const purged = await outcome(f.lifecycle.purge());
  const purgedAgain = await outcome(f.lifecycle.purge());
  console.log(JSON.stringify({ r3: { pushStartedBeforeFailure, closed, repeated, purged, purgedAgain, brokerListening: f.broker.listening, purgeCalls: f.state.purge } }));
  assert.notEqual(closed, "fulfilled");
  assert.notEqual(repeated, "fulfilled");
  assert.notEqual(purged, "fulfilled");
  assert.notEqual(purgedAgain, "fulfilled");
  assert.equal(pushStartedBeforeFailure, false, "coordination removes the old active-protocol/push overlap");
  assert.equal(f.state.brokerClose, 0);
  assert.equal(f.state.purge, 0);
  assert.equal(f.broker.listening, true);
  assert.equal(existsSync(join(f.root, "recovery")), true);
  assert.equal(existsSync(join(f.root, "broker.sock")), true);
});

test("completed protocol teardown during broker close and after cached success cannot retroactively latch preservation", async t => {
  const f = await setup(t, { holdBroker: true });
  const { guardian, handle } = await f.service();
  const protocolClosed = once(handle, "close");
  handle.stderr.resume();
  await protocolClosed;
  const closing = f.lifecycle.close();
  await f.brokerEntered.promise;
  assert.equal(f.services.size, 0, "all real-retirement/protocol outcomes are settled before broker finalization");
  assert.equal(handle.stderr.readableEnded, true);
  assert.equal(handle.stderr.writableFinished, true);
  handle.stderr.emit("error", new Error("unit late teardown callback"));
  guardian.emit("error", new Error("unit late guardian event"));
  await turn();
  assert.equal(f.state.failure, undefined);
  f.brokerGate.resolve();
  await closing;
  assert.equal(f.lifecycle.close(), closing);
  guardian.emit("message", { serviceFailure: true });
  await turn();
  assert.equal(f.state.failure, undefined);
  await f.lifecycle.purge();
  assert.equal(f.state.purge, 1);
});

test("sticky failure still dominates a cached successful close and cannot authorize purge", async t => {
  const f = await setup(t);
  const closing = f.lifecycle.close();
  await closing;
  f.preserve(serviceOutputFailure());
  assert.notEqual(await outcome(f.lifecycle.close()), "fulfilled");
  assert.notEqual(await outcome(f.lifecycle.purge()), "fulfilled");
  assert.equal(f.state.purge, 0);
  assert.equal(existsSync(join(f.root, "recovery")), true);
});

test("failure latched by a deferred final push is checked before broker closure", async t => {
  const f = await setup(t, { holdPush: true });
  const closing = f.lifecycle.close();
  const result = outcome(closing);
  await turn();
  assert.equal(f.state.push, 1);
  f.preserve(serviceOutputFailure());
  f.pushGate.resolve();
  assert.notEqual(await result, "fulfilled");
  assert.equal(f.state.brokerClose, 0);
  assert.equal(f.broker.listening, true);
});

test("buffered retired protocol may drain normally within the existing close budget before push", async t => {
  const f = await setup(t);
  const { handle } = await f.service();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const closing = f.lifecycle.close();
  await turn();
  assert.equal(f.state.push, 0);
  const protocolClosed = once(handle, "close");
  handle.stderr.resume();
  await protocolClosed;
  await closing;
  assert.equal(f.state.failure, undefined);
  assert.equal(f.state.push, 1);
  assert.equal(f.state.brokerClose, 1);
  t.mock.timers.tick(10_000);
  t.mock.timers.tick(5_000);
  await turn();
  assert.equal(f.state.failure, undefined, "completed finalization has no live deadline callback");
});

test("explicit protocol cancellation after positive kernel proof remains distinct from preservation failure", async t => {
  const f = await setup(t);
  const { guardian, errors } = await f.service({ buffered: false, retired: false, protocolClosed: false });
  const closing = f.lifecycle.close();
  guardian.emit("message", { retired: true, quiescent: true });
  guardian.connected = false;
  guardian.exitCode = 0;
  guardian.emit("disconnect");
  guardian.emit("close", 0);
  await closing;
  assert.equal(errors.length, 1, "protocol is explicitly cancelled, not fabricated successful");
  assert.equal(f.state.failure, undefined, "kernel proof still authorizes safe preservation finalization");
  assert.equal(f.state.push, 1);
});

test("unread protocol after retired guardian is bounded by the existing ten-second service close budget", async t => {
  const f = await setup(t);
  const { handle } = await f.service();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = outcome(f.lifecycle.close());
  await turn();
  t.mock.timers.tick(9_999);
  await turn();
  assert.equal(f.state.push, 0);
  assert.equal(f.state.failure, undefined);
  t.mock.timers.tick(1);
  assert.notEqual(await result, "fulfilled");
  assert.equal(handle.stderr.destroyed, true);
  assert.equal(f.state.brokerClose, 0);
  assert.equal(f.broker.listening, true);
  assert.equal(f.state.purge, 0);
});

test("missing real retirement proof retains only the existing five-second grace after service deadline", async t => {
  const f = await setup(t);
  const { guardian } = await f.service({ buffered: false, retired: false });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const result = outcome(f.lifecycle.close()).then(value => { settled = true; return value; });
  t.mock.timers.tick(10_000);
  await turn();
  assert.deepEqual(guardian.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, false);
  t.mock.timers.tick(4_999);
  await turn();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await result, { code: "DESK_OPERATION_UNQUIESCENT", quiescent: false });
  assert.equal(f.state.push, 0);
  assert.equal(f.state.brokerClose, 0);
  assert.equal(f.broker.listening, true);
});

test("the lifecycle seam refuses new service registration once close has started", async t => {
  const f = await setup(t, { holdPush: true });
  const closing = f.lifecycle.close();
  await turn();
  try {
    await assert.rejects(f.service({ buffered: false }), /runtime is closed/);
  } finally {
    f.pushGate.resolve();
    await closing;
  }
});
