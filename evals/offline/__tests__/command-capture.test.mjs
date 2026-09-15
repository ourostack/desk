import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { captureBoundedCommand } from "../output.mjs";
import { ownedDescendant, processIdentity } from "./helpers/owned-descendant.mjs";
import { workRoot } from "./helpers/paths.mjs";

const root = workRoot("command-capture");
const options = source => ({ executable: process.execPath, argv: ["-e", source], cwd: root, env: {}, limits: { maxStreamBytes: 32, timeoutMs: 1000, cleanupMs: 300 } });

test("a real command preserves binary streams, explicit environment and a nonzero semantic exit", async () => {
  const result = await captureBoundedCommand({ ...options("process.stdout.write(Buffer.from([255,0,128]));process.stderr.write(process.env.CAPTURE_VALUE);process.exitCode=7"), env: { CAPTURE_VALUE: "explicit" } });
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 7);
  assert.deepEqual(result.stdout.bytes, Buffer.from([255, 0, 128]));
  assert.equal(result.stderr.bytes.toString(), "explicit");
  assert.equal(result.cleanup.ownedSpawns.length, 1);
  assert.equal(result.cleanup.exitObservations[0].spawnIdentity, result.cleanup.ownedSpawns[0].spawnIdentity);
  assert.deepEqual(result.cleanup.unverifiedPids, []);
  assert.equal(result.cleanup.scope, "captured-direct-child-only");
});

test("missing executable is a structured infrastructure failure without invented process ownership", async () => {
  const result = await captureBoundedCommand({ ...options(""), executable: path.join(root, "missing") });
  assert.equal(result.failure.code, "ENOENT");
  assert.equal(result.status, "infrastructure_failure");
  assert.equal(result.exitCode, null);
  assert.deepEqual(result.cleanup.ownedSpawns, []);
});

test("the outer deadline bounds its own child without assuming completed startup", async () => {
  const result = await captureBoundedCommand({ ...options("setInterval(()=>{},1000)"), limits: { maxStreamBytes: 32, timeoutMs: 400, cleanupMs: 300 } });
  assert.equal(result.status, "timed_out");
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.stdout.bytes.length, 0);
  assert.equal(result.cleanup.exitObservations.length, 1);
});

test("a real signal-resistant child is force-stopped only after its readiness is observed", async () => {
  const ready = path.join(root, "resistant-child-ready");
  const controller = new AbortController();
  let observedPid;
  const watcher = fs.watch(root, (_event, filename) => {
    if (filename !== path.basename(ready) || !fs.existsSync(ready)) return;
    observedPid = Number(fs.readFileSync(ready, "utf8"));
    controller.abort();
  });
  let result;
  try {
    const source = `const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(`${ready}.pending`)},String(process.pid));fs.renameSync(${JSON.stringify(`${ready}.pending`)},${JSON.stringify(ready)});setInterval(()=>{},1000);`;
    result = await captureBoundedCommand({ ...options(source), signal: controller.signal, limits: { maxStreamBytes: 32, timeoutMs: 10000, cleanupMs: 300 } });
  } finally { watcher.close(); }
  assert.equal(result.status, "cancelled");
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Number.isSafeInteger(observedPid) && observedPid > 0);
  assert.equal(result.cleanup.ownedSpawns[0].pid, observedPid);
  assert.equal(result.cleanup.exitObservations.length, 1);
});

test("overflow retains bounded raw prefixes on both streams and a visible failure", async () => {
  const result = await captureBoundedCommand(options('process.on("SIGTERM",()=>{});const send=()=>{process.stdout.write("x".repeat(4096));process.stderr.write("y".repeat(4096))};send();setInterval(send,10)'));
  assert.equal(result.failure.code, "COMMAND_OUTPUT_OVERFLOW");
  assert.equal(result.stdout.bytes.length, 32);
  assert.equal(result.stderr.bytes.length, 32);
  assert.equal(result.stdout.truncated, true);
  assert.equal(result.stderr.truncated, true);
});

test("the owning command cancellation is distinct from an SDK invocation's normal finally-abort", async () => {
  const before = new AbortController();
  before.abort();
  const unstarted = await captureBoundedCommand({ ...options(""), signal: before.signal });
  assert.equal(unstarted.status, "cancelled");
  assert.deepEqual(unstarted.cleanup.ownedSpawns, []);
  const during = new AbortController();
  const running = captureBoundedCommand({ ...options("setInterval(()=>{},1000)"), signal: during.signal });
  setTimeout(() => during.abort(), 100);
  assert.equal((await running).status, "cancelled");
});

test("command construction rejects malformed argv, environment and limits without starting a child", async () => {
  const valid = options("");
  for (const delta of [{ statusPipe: "true" }, { onStatus: "not a function" }, { argv: "shell string" }, { env: null }, { env: { value: 1 } }, { argv: ["nul\0argument"] }, { limits: { maxStreamBytes: 0, timeoutMs: 1 } }, { limits: { maxStreamBytes: 1, timeoutMs: 1, cleanupMs: 0 } }]) await assert.rejects(() => captureBoundedCommand({ ...valid, ...delta }));
});

test("real host transport captures FD 3 separately and bounds its overflow without claiming native isolation", async () => {
  const captured = await captureBoundedCommand({ ...options('require("node:fs").writeSync(3,"private");process.stdout.write("forged status");'), statusPipe: true });
  assert.equal(captured.statusPipe.bytes.toString(), "private");
  assert.equal(captured.stdout.bytes.toString(), "forged status");
  assert.equal(captured.statusPipe.truncated, false);
  const overflow = await captureBoundedCommand({ ...options('require("node:fs").writeSync(3,"x".repeat(4096));setInterval(()=>{},1000);'), statusPipe: true });
  assert.equal(overflow.failure.code, "COMMAND_OUTPUT_OVERFLOW");
  assert.equal(overflow.statusPipe.bytes.length, 32);
  assert.equal(overflow.statusPipe.truncated, true);
  const cancelled = await captureBoundedCommand({ ...options(""), statusPipe: true, signal: AbortSignal.abort() });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.statusPipe.bytes.length, 0);
});

function syntheticChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  return child;
}

test("an unverified synthetic direct-child exit cannot outlive the finite cleanup budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const child = syntheticChild();
  child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
  const original = childProcess.spawn;
  childProcess.spawn = () => child;
  syncBuiltinESMExports();
  try {
    const pending = captureBoundedCommand({ ...options(""), statusPipe: true, limits: { maxStreamBytes: 32, timeoutMs: 10, cleanupMs: 20 } });
    t.mock.timers.tick(10);
    t.mock.timers.tick(10);
    t.mock.timers.tick(10);
    const result = await pending;
    assert.equal(result.status, "timed_out");
    assert.equal(result.elapsedMs, 30);
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(result.cleanup.unverifiedPids, [child.pid]);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stdio[3].destroyed, true);
    child.stdout.emit("data", Buffer.from("late"));
    assert.equal(result.stdout.bytes.length, 0);
    child.emit("close", 0, null);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test("an error raised during timeout cleanup does not erase the original timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const child = syntheticChild();
  const original = childProcess.spawn;
  childProcess.spawn = () => child;
  syncBuiltinESMExports();
  try {
    const pending = captureBoundedCommand({ ...options(""), limits: { maxStreamBytes: 32, timeoutMs: 10, cleanupMs: 20 } });
    t.mock.timers.tick(10);
    child.emit("error", Object.assign(new Error("cleanup transport failure"), { code: "EIO" }));
    const result = await pending;
    assert.equal(result.status, "timed_out");
    assert.equal(result.failure.code, "COMMAND_TIMEOUT");
    assert.equal(result.errors[0].code, "EIO");
    assert.deepEqual(result.cleanup.unverifiedPids, [child.pid]);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test("a launcher status transport error fails capture and still bounds owned-child cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const child = syntheticChild();
  child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
  t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const pending = captureBoundedCommand({ ...options(""), statusPipe: true });
  child.stdio[3].emit("error", Object.assign(new Error("source-test status transport failure"), { code: "EIO" }));
  t.mock.timers.tick(300);
  const result = await pending;
  assert.equal(result.failure.code, "COMMAND_STREAM_FAILED");
  assert.equal(result.errors[0].channel, "statusPipe");
  assert.deepEqual(result.cleanup.unverifiedPids, [child.pid]);
  child.stdout.emit("error", new Error("late stream error"));
  assert.equal(result.errors.length, 1);
});

test("a completed real command reports stream EOF and complete capture with raw identities", async () => {
  const result = await captureBoundedCommand(options('process.stdout.write("done");process.exitCode=0'));
  assert.equal(result.stdout.eof, true);
  assert.equal(result.stderr.eof, true);
  assert.equal(result.captureComplete, true);
  assert.equal(result.stdout.sha256, createHash("sha256").update(result.stdout.bytes).digest("hex"));
  assert.equal(result.stdout.byteLength, 4);
});

test("a real late inherited descriptor withholds EOF and complete capture inside the deadline", async t => {
  const descendant = ownedDescendant(root, "inherited", { stdio: ["ignore", "inherit", "inherit"] });
  let reconciliation;
  t.after(() => { reconciliation = descendant.reconcile(); });
  const result = await captureBoundedCommand({ ...options(`${descendant.source}process.stdout.write("parent-exited");`), limits: { maxStreamBytes: 64, timeoutMs: 700, cleanupMs: 300 } });
  assert.equal(result.stdout.bytes.toString(), "parent-exited");
  assert.equal(result.captureComplete, false, "A surviving descendant holding the pipe is not a completed capture");
  assert.equal(result.status, "timed_out");
  t.after(() => assert.equal(reconciliation.identity > 0, true, "The fixture recorded and reconciled its own descendant"));
});

test("a real fork that keeps FD 3 open withholds status-pipe EOF", async t => {
  const descendant = ownedDescendant(root, "monitor", { stdio: ["ignore", "ignore", "ignore", 3] });
  t.after(() => descendant.reconcile());
  const result = await captureBoundedCommand({ ...options(`${descendant.source}require("node:fs").writeSync(3,"launcher");`), statusPipe: true, limits: { maxStreamBytes: 64, timeoutMs: 700, cleanupMs: 300 } });
  assert.equal(result.statusPipe.bytes.toString(), "launcher");
  assert.equal(result.statusPipe.eof, false);
  assert.equal(result.captureComplete, false);
});

test("a late zero exit after cancellation stays cancelled and incomplete", async () => {
  const controller = new AbortController();
  const running = captureBoundedCommand({ ...options('process.on("SIGTERM",()=>{setTimeout(()=>process.exit(0),20)});process.stdout.write("started");setInterval(()=>{},1000)'), signal: controller.signal, limits: { maxStreamBytes: 64, timeoutMs: 5000, cleanupMs: 400 } });
  setTimeout(() => controller.abort(), 200);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.failure.code, "COMMAND_CANCELLED");
  assert.equal(result.captureComplete, false);
});

test("captured overflow is never a complete capture", async () => {
  const result = await captureBoundedCommand(options('process.on("SIGTERM",()=>{});const send=()=>process.stdout.write("x".repeat(4096));send();setInterval(send,10)'));
  assert.equal(result.failure.code, "COMMAND_OUTPUT_OVERFLOW");
  assert.equal(result.captureComplete, false);
});

test("an owned descendant's teardown reconciles an exact creation-time identity", async t => {
  const base = workRoot("owned-descendant-identity");
  const early = ownedDescendant(base, "early", { stdio: ["ignore", "ignore", "ignore"], lifetimeMs: 50 });
  const done = await captureBoundedCommand({ ...options(early.source), cwd: base, limits: { maxStreamBytes: 64, timeoutMs: 5000, cleanupMs: 300 } });
  assert.equal(done.status, "exited");
  const identity = JSON.parse(fs.readFileSync(early.identity, "utf8"));
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
  assert.ok(typeof identity.started === "string" && identity.started.length > 0, "A start-time identity is recorded at creation, not at teardown");
  for (let attempt = 0; attempt < 80 && !processIdentity(identity.pid).absent; attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(processIdentity(identity.pid).absent, true, "The descendant expired under its own backstop");
  const retired = early.reconcile();
  assert.equal(retired.state, "already-retired");
  assert.deepEqual(retired.signals, []);

  // Counterexample: the recorded PID number is alive at teardown but is a different process.
  const reused = ownedDescendant(base, "reused", { stdio: ["ignore", "ignore", "ignore"] });
  fs.writeFileSync(reused.identity, JSON.stringify({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970", createdAt: Date.now() }));
  const recycled = reused.reconcile();
  assert.equal(recycled.state, "pid-reused");
  assert.deepEqual(recycled.signals, [], "A recycled PID is never signalled");
  assert.notEqual(recycled.currentIdentity, recycled.recordedIdentity);
  assert.equal(processIdentity(process.pid).absent, false, "The unrelated holder of that PID is left running");

  // A descendant that never recorded its identity fails the teardown instead of being assumed gone.
  const absent = ownedDescendant(base, "absent", { stdio: ["ignore", "ignore", "ignore"], lifetimeMs: 10 });
  assert.throws(() => absent.reconcile(), /never recorded a creation-time identity/u);
});

test("an unreadable process observation fails teardown instead of claiming retirement", async t => {
  const base = workRoot("owned-descendant-unreadable");
  const descendant = ownedDescendant(base, "opaque", { stdio: ["ignore", "ignore", "ignore"], lifetimeMs: 60000, retirementMs: 200 });
  await captureBoundedCommand({ ...options(descendant.source), cwd: base, limits: { maxStreamBytes: 64, timeoutMs: 5000, cleanupMs: 300 } });
  const recorded = JSON.parse(fs.readFileSync(descendant.identity, "utf8"));
  const real = childProcess.execFileSync;
  t.mock.method(childProcess, "execFileSync", (file, args, settings) => {
    if (file === "ps") throw Object.assign(new Error("observation timed out"), { status: null, signal: "SIGTERM" });
    return real(file, args, settings);
  });
  syncBuiltinESMExports();
  assert.throws(() => descendant.reconcile(), /could not be observed; retirement is unproved/u);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(processIdentity(recorded.pid).absent, false, "The live descendant is still running and still owned");
  fs.writeFileSync(descendant.identity, JSON.stringify(recorded));
  const outcome = descendant.reconcile();
  assert.equal(outcome.state, "retired-cooperatively");
  assert.equal(processIdentity(recorded.pid).absent, true);
});

test("a descendant that ignores its stop marker is retired by exact-PID signal and observed", async () => {
  const base = workRoot("owned-descendant-signal");
  const descendant = ownedDescendant(base, "stubborn", { stdio: ["ignore", "ignore", "ignore"], lifetimeMs: 60000, retirementMs: 600, ignoreStop: true });
  await captureBoundedCommand({ ...options(descendant.source), cwd: base, limits: { maxStreamBytes: 64, timeoutMs: 5000, cleanupMs: 300 } });
  const recorded = JSON.parse(fs.readFileSync(descendant.identity, "utf8"));
  assert.equal(processIdentity(recorded.pid).started, recorded.started, "The descendant is alive under its recorded identity");
  const outcome = descendant.reconcile();
  assert.equal(outcome.state, "retired-after-signal");
  assert.deepEqual(outcome.signals, ["SIGTERM"]);
  assert.equal(outcome.identity, recorded.pid);
  assert.ok(Number.isInteger(outcome.retirementObservedMs));
  assert.equal(processIdentity(recorded.pid).absent, true, "The exact recorded process is gone");
});

test("a live owned descendant retires cooperatively without any signal", async () => {
  const base = workRoot("owned-descendant-retirement");
  const descendant = ownedDescendant(base, "live", { stdio: ["ignore", "ignore", "ignore"], lifetimeMs: 60000 });
  await captureBoundedCommand({ ...options(descendant.source), cwd: base, limits: { maxStreamBytes: 64, timeoutMs: 5000, cleanupMs: 300 } });
  const recorded = JSON.parse(fs.readFileSync(descendant.identity, "utf8"));
  assert.equal(processIdentity(recorded.pid).started, recorded.started);
  const outcome = descendant.reconcile();
  assert.equal(outcome.state, "retired-cooperatively");
  assert.deepEqual(outcome.signals, [], "The ordinary path never signals, so it cannot race a recycled PID");
  assert.ok(Number.isInteger(outcome.retirementObservedMs));
  assert.equal(processIdentity(recorded.pid).absent, true, "The exact recorded process is gone");
});
