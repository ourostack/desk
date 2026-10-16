import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { serviceHandle } from "../src/service-lifetime.js";

function guardian() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), connected: true, pid: 42 });
  child.sent = [];
  child.send = message => { child.sent.push(message); return true; };
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
  child.emit("message", { serviceStdout: Buffer.from("last response\n").toString("base64") });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response, "last response\n");
  child.emit("message", { serviceClosed: true, code: 0, signal: null });
  assert.deepEqual(await closed, [0, null]);
  assert.equal(guardianClosed, false);
  assert.equal(service.kill(), false);
  assert.equal(service.send({ ignored: true }), false);
  assert.deepEqual(child.sent, []);
});

test("service output bytes drain in channel order before actual MCP completion", async () => {
  const child = guardian();
  const service = serviceHandle(child);
  const output = [];
  service.stdout.on("data", chunk => output.push(chunk));
  const text = Buffer.from('{"result":"✓"}\n');
  child.emit("message", { serviceStdout: text.subarray(0, 13).toString("base64") });
  child.emit("message", { serviceStdout: text.subarray(13).toString("base64") });
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
