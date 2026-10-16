import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { pipeServiceOutput, relayServiceOutput, sendServiceControl } from "../src/service-output.js";
import { serviceHandle } from "../src/service-lifetime.js";

const turn = () => new Promise(resolve => setImmediate(resolve));

function pair() {
  const left = new EventEmitter();
  const right = new EventEmitter();
  for (const [from, to] of [[left, right], [right, left]]) {
    from.connected = true;
    from.sent = [];
    from.send = (message, callback) => {
      from.sent.push(message);
      queueMicrotask(() => { to.emit("message", message); callback?.(); });
      return false; // IPC pressure is deliberately present at both hops.
    };
  }
  return [left, right];
}

function transport(output = { stdout: new PassThrough({ highWaterMark: 16384 }), stderr: new PassThrough({ highWaterMark: 16384 }) }) {
  const [worker, child] = pair();
  const [supervisor, guardian] = pair();
  Object.assign(guardian, { stdin: new PassThrough(), pid: 42, exitCode: null, signalCode: null });
  const failures = [];
  const service = serviceHandle(guardian, error => failures.push(error));
  const protocolErrors = [];
  service.on("error", error => protocolErrors.push(error));
  relayServiceOutput(child, supervisor, () => {
    failures.push("supervisor");
    sendServiceControl(supervisor, { serviceFailure: true }, () => {});
  });
  child.on("message", message => {
    if (message.serviceFailure) sendServiceControl(supervisor, message, () => {});
  });
  const done = pipeServiceOutput(output, worker, () => {
    failures.push("worker");
    sendServiceControl(worker, { serviceFailure: true }, () => {});
  });
  done.catch(() => {});
  return { worker, child, supervisor, guardian, service, output, done, failures, protocolErrors };
}

test("paused stdout and blocked stderr propagate bounded credit through both IPC hops, then resume in order", async () => {
  const t = transport();
  const chunks = Array.from({ length: 32 }, (_, index) => Buffer.alloc(16384, index));
  const stdout = [];
  const stderr = [];
  let unblock;
  let blocked = true;
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      stderr.push(chunk);
      if (blocked) unblock = callback;
      else callback();
    },
  });
  t.service.stderr.pipe(sink);
  Readable.from(chunks).pipe(t.output.stdout);
  Readable.from(chunks).pipe(t.output.stderr);
  await turn();
  assert.equal(t.worker.sent.filter(message => message.serviceStdout).length, 1);
  assert.equal(t.supervisor.sent.filter(message => message.serviceStdout).length, 1);
  assert.ok(t.service.stdout.readableLength <= 16384);
  assert.ok(t.service.stderr.readableLength <= 16384);
  assert.ok(t.output.stdout.readableLength <= 32768);
  assert.ok(t.output.stderr.readableLength <= 32768);
  assert.equal(t.worker.sent.filter(message => message.serviceStderr).length, 2, "one sink frame and one gateway frame, not unbounded stderr");

  let signal;
  t.supervisor.on("message", message => {
    if (message.serviceSignal) t.child.send(message);
  });
  t.worker.on("message", message => { if (message.serviceSignal) signal = message.serviceSignal; });
  t.guardian.send({ serviceSignal: "SIGTERM" });
  await turn();
  assert.equal(signal, "SIGTERM", "control still crosses both IPC hops while output credit is withheld");

  let closed = false;
  const protocolClosed = once(t.service, "close");
  t.service.once("close", () => { closed = true; });
  t.done.then(() => t.worker.send({ serviceClosed: true, code: 0, signal: null }));
  t.child.on("message", message => {
    if (message.serviceClosed) t.supervisor.send(message);
  });
  t.service.stdout.on("data", chunk => stdout.push(chunk));
  t.service.stdout.resume();
  await turn();
  assert.deepEqual(Buffer.concat(stdout), Buffer.concat(chunks));
  assert.equal(closed, false, "blocked stderr cannot be called complete");
  assert.equal(t.service.stderr.writableFinished, false);
  blocked = false;
  unblock();
  await protocolClosed;
  await t.done;
  assert.deepEqual(Buffer.concat(stderr), Buffer.concat(chunks));
  for (const stream of [t.service.stdout, t.service.stderr]) {
    assert.equal(stream.readableEnded, true);
    assert.equal(stream.writableFinished, true);
  }
  assert.deepEqual(t.failures, []);
});

test("the intermediate supervisor rejects a second frame without downstream credit", async () => {
  const t = transport();
  const frame = { serviceStdout: Buffer.alloc(16384).toString("base64"), serviceOutputId: 1 };
  t.worker.send(frame);
  t.worker.send({ ...frame, serviceOutputId: 2 });
  await turn();
  assert.equal(t.supervisor.sent.filter(message => message.serviceStdout).length, 1);
  assert.equal(t.protocolErrors.length, 1);
  assert.equal(t.service.stdout.destroyed, true);
  assert.ok(t.failures.includes("supervisor"));
  assert.equal(t.guardian.exitCode, null);
});

test("an actual output stream error under pressure delivers preservation control without waiting for credit", async () => {
  const t = transport();
  t.output.stderr.write(Buffer.alloc(16384));
  await turn();
  assert.equal(t.service.stderr.readableLength, 16384);
  t.output.stderr.destroy(new Error("synthetic pipe failure"));
  await assert.rejects(t.done, error => error.quiescent === false);
  await turn();
  assert.equal(t.protocolErrors.length, 1);
  assert.equal(t.service.stderr.destroyed, true);
  assert.equal(t.guardian.exitCode, null);
});

test("an IPC send callback failure stops source reads and rejects output completion", async () => {
  const output = { stdout: new PassThrough(), stderr: new PassThrough() };
  const upstream = Object.assign(new EventEmitter(), {
    connected: true, send(message, callback) { callback(new Error("synthetic IPC failure")); return false; },
  });
  let failures = 0;
  const done = pipeServiceOutput(output, upstream, () => { failures++; });
  output.stdout.end(Buffer.alloc(16384));
  await assert.rejects(done, error => error.quiescent === false);
  assert.equal(failures, 1);
});

test("a nonexistent output credit cannot start or advance either IPC hop", async () => {
  const t = transport();
  t.guardian.send({ serviceOutputAck: "stdout", serviceOutputId: null });
  await turn();
  assert.ok(t.failures.includes("supervisor"));
  assert.equal(t.protocolErrors.length, 1);
});

test("the source rejects unsolicited credit too", async () => {
  const t = transport();
  t.worker.emit("message", { serviceOutputAck: "stderr", serviceOutputId: null });
  await assert.rejects(t.done, error => error.quiescent === false);
  await turn();
  assert.ok(t.failures.includes("worker"));
  assert.equal(t.protocolErrors.length, 1);
});

test("small accepted output followed by full frames remains bounded until the consumer resumes", async () => {
  const t = transport();
  t.output.stdout.write(Buffer.alloc(8192, 1));
  await turn();
  t.output.stdout.write(Buffer.alloc(16384, 2));
  await turn();
  t.output.stdout.end(Buffer.alloc(16384, 3));
  t.output.stderr.end();
  await turn();
  assert.equal(t.worker.sent.filter(message => message.serviceStdout).length, 2);
  assert.ok(t.service.stdout.readableLength <= 32768);
  assert.ok(t.service.stdout.writableLength <= 16384);
  const bytes = [];
  t.service.stdout.on("data", chunk => bytes.push(chunk));
  await t.done;
  const closed = once(t.service, "close");
  t.guardian.emit("message", { serviceClosed: true, code: 0, signal: null });
  await closed;
  assert.deepEqual(Buffer.concat(bytes), Buffer.concat([Buffer.alloc(8192, 1), Buffer.alloc(16384, 2), Buffer.alloc(16384, 3)]));
  assert.deepEqual(t.failures, []);
});

test("a source pipe closed without EOF is an explicit preservation failure", async () => {
  const t = transport();
  t.output.stdout.destroy();
  await turn();
  assert.ok(t.failures.includes("worker"));
  assert.equal(t.protocolErrors.length, 1);
});

test("actual Node child pipes retain every byte across paused gateway output and process exit", async t => {
  const child = spawn(process.execPath, ["-e", `
    process.stdout.end(Buffer.alloc(65536, 1));
    process.stderr.end(Buffer.alloc(65536, 2));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    child.stdout.destroy();
    child.stderr.destroy();
  });
  const pipeline = transport(child);
  await once(pipeline.guardian, "message");
  assert.ok(pipeline.service.stdout.readableLength <= 16384);
  assert.ok(pipeline.service.stderr.readableLength <= 16384);
  const stdout = [];
  const stderr = [];
  pipeline.service.stdout.on("data", chunk => stdout.push(chunk));
  pipeline.service.stderr.on("data", chunk => stderr.push(chunk));
  await pipeline.done;
  assert.equal((await closed)[0], 0);
  const protocolClosed = once(pipeline.service, "close");
  pipeline.child.on("message", message => { if (message.serviceClosed) pipeline.supervisor.send(message); });
  pipeline.worker.send({ serviceClosed: true, code: 0, signal: null });
  await protocolClosed;
  assert.deepEqual(Buffer.concat(stdout), Buffer.alloc(65536, 1));
  assert.deepEqual(Buffer.concat(stderr), Buffer.alloc(65536, 2));
  assert.deepEqual(pipeline.failures, []);
});
