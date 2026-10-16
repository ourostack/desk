import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { serviceHandle } from "../src/service-lifetime.js";

function guardian() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), connected: true, pid: 42 });
  child.sent = [];
  child.send = (message, callback) => { child.sent.push(message); callback?.(); return true; };
  return child;
}

test("service EOF completes protocol without closing or signalling the retained guardian", async () => {
  const child = guardian();
  const service = serviceHandle(child);
  service.stdout.resume();
  let response = "";
  service.stdout.on("data", chunk => { response += chunk; });
  let guardianClosed = false;
  child.once("close", () => { guardianClosed = true; });
  const closed = once(service, "close");
  assert.equal(service.exitCode, null, "pending stdout must drain before protocol close");
  child.emit("message", { serviceStdout: Buffer.from("last response\n").toString("base64"), serviceOutputId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response, "last response\n");
  child.emit("message", { serviceClosed: true, code: 0, signal: null });
  assert.deepEqual(await closed, [0, null]);
  assert.equal(guardianClosed, false);
  assert.equal(service.kill(), false);
  assert.equal(service.send({ ignored: true }), false);
  assert.deepEqual(child.sent, [{ serviceOutputAck: "stdout", serviceOutputId: 1 }]);
});

test("service output bytes drain in channel order before actual MCP completion", async () => {
  const child = guardian();
  const service = serviceHandle(child);
  const output = [];
  service.stdout.on("data", chunk => output.push(chunk));
  const text = Buffer.from('{"result":"✓"}\n');
  child.emit("message", { serviceStdout: text.subarray(0, 13).toString("base64"), serviceOutputId: 1 });
  child.emit("message", { serviceStdout: text.subarray(13).toString("base64"), serviceOutputId: 2 });
  const closed = once(service, "close");
  child.emit("message", { serviceClosed: true, code: 0, signal: null });
  await closed;
  assert.deepEqual(Buffer.concat(output), text);
});

test("an empty service protocol closes even when its stdout has no reader", async () => {
  const child = guardian();
  const service = serviceHandle(child);
  const result = new Promise(resolve => service.once("close", () => resolve("closed")));
  child.emit("message", { serviceClosed: true, code: 0, signal: null });
  assert.equal(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve("hung"), 50))]), "closed");
});

test("session signals and messages address the actual MCP, never realm retirement", () => {
  const child = guardian();
  const service = serviceHandle(child);
  assert.equal(service.kill("SIGTERM"), true);
  assert.equal(service.send({ request: 1 }), true);
  assert.deepEqual(child.sent, [{ serviceSignal: "SIGTERM" }, { serviceMessage: { request: 1 } }]);
  assert.throws(() => service.kill("SIGUSR1"), /Unsupported/);
  const received = [];
  service.on("message", message => received.push(message));
  child.emit("message", { serviceMessage: { ready: true } });
  child.emit("message", { retired: true, quiescent: true });
  assert.deepEqual(received, [{ ready: true }]);
});

test("uncredited stderr cannot grow the gateway buffer without a bounded preservation error", async () => {
  const child = guardian();
  const failures = [];
  const service = serviceHandle(child, error => failures.push(error));
  const errors = [];
  service.on("error", error => errors.push(error));
  let guardianClosed = false;
  child.once("close", () => { guardianClosed = true; });
  for (let id = 1; id <= 128; id++) {
    child.emit("message", { serviceStderr: Buffer.alloc(16384).toString("base64"), serviceOutputId: id });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(service.stderr.writableLength <= 32768, `stderr buffered ${service.stderr.writableLength} bytes`);
  assert.equal(errors.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].quiescent, false);
  assert.equal(guardianClosed, false, "protocol failure cannot fabricate guardian close");
  service.stderr.resume();
});

test("normal protocol completion waits for both pressured output streams to drain and finish", async () => {
  const child = guardian();
  const service = serviceHandle(child);
  let closed = false;
  service.on("close", () => { closed = true; });
  child.emit("message", { serviceStdout: Buffer.alloc(16384).toString("base64"), serviceOutputId: 1 });
  child.emit("message", { serviceStderr: Buffer.alloc(16384).toString("base64"), serviceOutputId: 1 });
  child.emit("message", { serviceClosed: true, code: 0, signal: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, "unread output is not protocol completion");
  service.stdout.resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, "stderr must drain too");
  const done = once(service, "close");
  service.stderr.resume();
  await done;
  assert.equal(service.stdout.writableFinished, true);
  assert.equal(service.stderr.writableFinished, true);
  assert.equal(service.stdout.readableEnded, true);
  assert.equal(service.stderr.readableEnded, true);
});

test("live guardian IPC loss promptly fails only the protocol and preserves the guardian", async () => {
  const child = guardian();
  const failures = [];
  const service = serviceHandle(child, error => failures.push(error));
  const errors = [];
  service.on("error", error => errors.push(error));
  let guardianClosed = false;
  child.once("close", () => { guardianClosed = true; });
  child.connected = false;
  child.emit("disconnect");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(service.stdout.destroyed, true);
  assert.equal(service.stderr.destroyed, true);
  assert.equal(service.kill("SIGKILL"), false);
  assert.equal(service.send({ ignored: true }), false);
  assert.equal(guardianClosed, false);
  assert.equal(service.exitCode, null, "no MCP or guardian exit is fabricated");
});

test("destroyed output under pressure promptly fails preservation even without a stream error event", async () => {
  const child = guardian();
  const failures = [];
  const service = serviceHandle(child, error => failures.push(error));
  const errors = [];
  service.on("error", error => errors.push(error));
  child.emit("message", { serviceStderr: Buffer.alloc(16384).toString("base64"), serviceOutputId: 1 });
  service.stderr.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(failures.length, 1);
});

test("service IPC send keeps its completion callback on successful delivery", () => {
  const child = guardian();
  const service = serviceHandle(child);
  let delivered = false;
  service.send({ request: 1 }, error => { assert.equal(error, undefined); delivered = true; });
  assert.equal(delivered, true);
});

test("forced session cancellation while output is pressured fails protocol without faking guardian exit", () => {
  const child = guardian();
  const failures = [];
  const service = serviceHandle(child, error => failures.push(error));
  let errors = 0;
  service.on("error", () => errors++);
  child.emit("message", { serviceStderr: Buffer.alloc(16384).toString("base64"), serviceOutputId: 1 });
  service.kill("SIGKILL");
  assert.equal(errors, 1);
  assert.equal(failures.length, 1);
  assert.equal(child.exitCode, undefined);
  assert.equal(service.exitCode, null);
  assert.ok(child.sent.some(message => message.serviceSignal === "SIGKILL"));
});

test("proved normal guardian retirement does not truncate pressured protocol output", async () => {
  const child = guardian();
  const service = serviceHandle(child);
  service.stdout.resume();
  const bytes = [];
  child.emit("message", { serviceStderr: Buffer.alloc(8192, 7).toString("base64"), serviceOutputId: 1 });
  child.emit("message", { serviceClosed: true, code: 0, signal: null });
  child.emit("message", { retired: true, quiescent: true });
  child.connected = false;
  child.emit("disconnect");
  child.emit("close", 0);
  assert.equal(service.stderr.destroyed, false);
  const closed = once(service, "close");
  service.stderr.on("data", chunk => bytes.push(chunk));
  await closed;
  assert.deepEqual(Buffer.concat(bytes), Buffer.alloc(8192, 7));
});

test("proved guardian retirement can end a cancelled protocol without inventing a preservation failure", () => {
  const child = guardian();
  const failures = [];
  const service = serviceHandle(child, error => failures.push(error));
  let errors = 0;
  service.on("error", () => errors++);
  child.emit("message", { retired: true, quiescent: true });
  child.connected = false;
  child.emit("disconnect");
  child.emit("close", 0);
  assert.equal(errors, 1, "protocol cancellation is explicit, not a fabricated MCP success");
  assert.equal(failures.length, 0, "positive kernel retirement is not an unproved channel failure");
  assert.equal(service.exitCode, null);
});

test("unproved guardian close under output pressure cannot leave a protocol waiter open", async () => {
  const child = guardian();
  const failures = [];
  const service = serviceHandle(child, error => failures.push(error));
  let errors = 0;
  service.on("error", () => errors++);
  child.emit("message", { serviceStderr: Buffer.alloc(16384).toString("base64"), serviceOutputId: 1 });
  child.emit("message", { serviceClosed: true, code: 0, signal: null });
  child.emit("close", 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors, 1);
  assert.equal(failures.length, 1);
  assert.equal(service.stderr.destroyed, true);
});
