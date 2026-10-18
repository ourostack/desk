import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module, { createRequire } from "node:module";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkTempRoot } from "../_temp_roots.js";
import { nativeProbe, writePosixNodeProvider } from "../factory/_private_state_helpers.js";
import { assertWindowsAclAvailable, protectWindowsPaths } from "../../../../../plugins/desk/mcp/src/factory/windows-acl.js";
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js";
import { Worker as ActualWorker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const filename = path.resolve(import.meta.dirname, "../../../../../plugins/desk/mcp/web-native-private-path.cjs");
const entries = [{ file: "C:\\owned\\state", directory: true }, { file: "C:\\owned\\state\\ready.json", directory: false }];

function load() {
  const workers = [], waits = [], diagnostics = [], proc = new EventEmitter();
  proc.stderr = { write(value) { diagnostics.push(value); } };
  let clock = 1000, wall = 1000, action = "success", throwing = false, onPost, onConstruct;
  class Worker extends EventEmitter {
    constructor(file, options) {
      super();
      if (throwing) throw Error("private loader detail");
      onConstruct?.();
      this.file = file; this.options = options; this.messages = []; this.unrefs = 0;
      workers.push(this);
    }
    unref() { this.unrefs++; }
    postMessage(message) {
      if (throwing) throw Error("private post detail");
      this.messages.push(message);
      onPost?.(message);
    }
    terminate() { assert.fail("worker termination must not substitute for real helper close"); }
  }
  const module = new Module(filename);
  module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  module.require = name => name === "node:worker_threads" ? { isMainThread: true, Worker } :
    name === "node:perf_hooks" ? { performance: { now: () => clock } } : require(name);
  module._compile = (source, file) => {
    const wrapper = vm.runInNewContext(Module.wrap(source), {
      process: proc, Buffer, SharedArrayBuffer, Int32Array, Date: { now: () => wall },
      __coverage__: global.__coverage__,
      Atomics: { ...Atomics,
        load: Atomics.load, store: Atomics.store, compareExchange: Atomics.compareExchange,
        wait(state, index, expected, timeout) {
          waits.push({ state, timeout });
          assert.ok(timeout > 0 && timeout <= 5000);
          const message = workers.at(-1).messages.at(-1);
          assert.equal(state.buffer, message.buffer);
          if (action === "timeout") { clock += timeout; return "timed-out"; }
          Atomics.store(state, 0, action === "refuse" ? -1 : message.operation === "close" ? 2 : 1);
          return "ok";
        },
      },
    }, { filename: file });
    wrapper.call(module.exports, module.exports, module.require, module, file, path.dirname(file));
  };
  (Module._extensions[".cjs"] || Module._extensions[".js"])(module, filename);
  return { client: module.exports, workers, waits, diagnostics, proc,
    action(value) { action = value; }, throwing(value) { throwing = value; },
    onPost(fn) { onPost = fn; }, onConstruct(fn) { onConstruct = fn; },
    advance(ms) { clock += ms; wall += ms; }, rewindWall(ms) { wall -= ms; } };
}

test("readonly frontend stays lazy, inherits all preloads, and verifies each call with a fresh bounded SAB", () => {
  const f = load();
  assert.equal(f.workers.length, 0);
  f.client.verify(entries, "C:\\Windows");
  f.client.verify(entries, "C:\\Windows");
  assert.equal(f.workers.length, 1);
  const worker = f.workers[0];
  assert.equal(worker.file, filename);
  assert.deepEqual(Object.keys(worker.options), ["workerData"]);
  assert.equal(worker.options.workerData.mode, "desk-native-private-path");
  assert.equal(worker.options.workerData.root, "C:\\Windows");
  assert.equal(worker.unrefs, 1);
  assert.equal(worker.messages.length, 2);
  assert.notEqual(worker.messages[0].buffer, worker.messages[1].buffer);
  assert.deepEqual(JSON.parse(JSON.stringify(worker.messages[0].entries)), entries);
  assert.equal(worker.messages[0].due, 6000);
  assert.equal(f.waits.length, 2);
  assert.equal(f.diagnostics.length, 0);
  f.client.close();
  assert.equal(worker.messages.at(-1).operation, "close");
  assert.equal(f.waits.at(-1).state[0], 2);
  assert.throws(() => f.client.verify(entries, "C:\\Windows"), /NATIVE_PRIVATE_PATH_INVALID/);
});

test("readonly frontend refuses startup, provider, post, error, and exit failures without private details", () => {
  for (const mode of ["startup", "refuse", "post", "error", "exit"]) {
    const f = load();
    if (mode === "startup") f.throwing(true);
    else {
      f.client.verify(entries, "C:\\Windows");
      if (mode === "refuse") f.action("refuse");
      if (mode === "post") f.throwing(true);
      if (mode === "error") f.workers[0].emit("error", Error("private detail"));
      if (mode === "exit") f.workers[0].emit("exit", 1);
    }
    assert.throws(() => f.client.verify(entries, "C:\\Windows"), error => error.message === "NATIVE_PRIVATE_PATH_INVALID", mode);
    assert.equal(f.diagnostics.length, 0);
  }
});

test("readonly frontend cancels timed out SABs and cannot accept a late old answer as a new authorization", () => {
  const f = load();
  f.action("timeout");
  assert.throws(() => f.client.verify(entries, "C:\\Windows"), /NATIVE_PRIVATE_PATH_INVALID/);
  const first = f.workers[0], old = first.messages[0].buffer;
  assert.equal(new Int32Array(old)[0], -2);
  assert.equal(first.messages.at(-1).operation, "close");
  assert.equal(f.waits.length, 1, "a timed-out request is not given another wait budget");
  Atomics.store(new Int32Array(old), 0, 1);
  Atomics.store(new Int32Array(first.messages.at(-1).buffer), 0, 2);
  f.action("success");
  f.client.verify(entries, "C:\\Windows");
  assert.equal(f.workers.length, 2);
  assert.notEqual(f.workers[1].messages[0].buffer, old);
  assert.equal(f.waits.length, 2);
});

test("readonly frontend never admits another worker while an old helper's close is unknown", () => {
  const f = load();
  f.action("refuse");
  assert.throws(() => f.client.verify(entries, "C:\\Windows"), /NATIVE_PRIVATE_PATH_INVALID/);
  assert.equal(f.workers.length, 1);
  assert.throws(() => f.client.verify(entries, "C:\\Windows"), /NATIVE_PRIVATE_PATH_INVALID/);
  assert.equal(f.workers.length, 1, "unknown close must not accumulate replacement workers");
  Atomics.store(new Int32Array(f.workers[0].messages.at(-1).buffer), 0, -1);
  assert.throws(() => f.client.verify(entries, "C:\\Windows"), /NATIVE_PRIVATE_PATH_INVALID/);
  assert.equal(f.workers.length, 1);
});

test("readonly frontend rejects malformed or oversized input before creating a worker and exposes explicit-close failure", () => {
  const f = load(), circular = []; circular.push(circular);
  for (const input of [null, {}, [], Array(65).fill(entries[0]), [{ file: "x".repeat(65536), directory: false }], circular])
    assert.throws(() => f.client.verify(input, "C:\\Windows"), /NATIVE_PRIVATE_PATH_INVALID/);
  for (const root of [null, 3, ""]) assert.throws(() => f.client.verify(entries, root), /NATIVE_PRIVATE_PATH_INVALID/);
  assert.equal(f.workers.length, 0);
  f.client.verify(entries, "C:\\Windows");
  f.action("refuse");
  assert.throws(() => f.client.close(), /NATIVE_PRIVATE_PATH_CLOSE_UNKNOWN/);
  assert.throws(() => f.client.close(), /NATIVE_PRIVATE_PATH_CLOSE_UNKNOWN/);
  f.proc.exitCode = 7;
  f.proc.emit("exit");
  assert.equal(f.proc.exitCode, 7);
});

test("readonly frontend closes the old provider before admitting a changed provider root", () => {
  const f = load();
  f.client.verify(entries, "C:\\Windows");
  f.client.verify(entries, "D:\\Windows");
  assert.equal(f.workers.length, 2);
  assert.equal(f.workers[0].messages.at(-1).operation, "close");
  assert.equal(f.waits[1].state[0], 2);
  assert.equal(f.workers[1].options.workerData.root, "D:\\Windows");
});

test("readonly frontend never extends its total budget for wall-clock movement or an already-completed late answer", () => {
  const f = load();
  f.onPost(message => {
    if (message.operation === "verify") {
      Atomics.store(new Int32Array(message.buffer), 0, 1);
      f.advance(6000);
    }
  });
  assert.throws(() => f.client.verify(entries, "C:\\Windows"), /NATIVE_PRIVATE_PATH_INVALID/);
  const g = load();
  g.onConstruct(() => { g.advance(4000); g.rewindWall(60000); });
  g.client.verify(entries, "C:\\Windows");
  assert.equal(g.waits[0].timeout, 1000);
  const h = load();
  h.onConstruct(() => h.advance(6000));
  assert.throws(() => h.client.verify(entries, "C:\\Windows"), /NATIVE_PRIVATE_PATH_INVALID/);
  assert.equal(h.waits.length, 0);
  const j = load();
  j.client.verify(entries, "C:\\Windows");
  j.action("refuse");
  assert.throws(() => j.client.verify(entries, "D:\\Windows"), /NATIVE_PRIVATE_PATH_INVALID/);
  assert.equal(j.workers.length, 1);
});

test("readonly frontend hooks both normal drain and explicit exit and reports unknown close rather than success", () => {
  for (const event of ["beforeExit", "exit"]) {
    const f = load();
    f.client.verify(entries, "C:\\Windows");
    f.proc.emit(event, 0);
    assert.equal(f.workers[0].messages.at(-1).operation, "close");
    assert.equal(f.waits.at(-1).state[0], 2);
    const count = f.waits.length;
    f.proc.emit("exit", 0);
    assert.equal(f.waits.length, count);
    assert.equal(f.diagnostics.length, 0);
  }
  const f = load();
  f.client.verify(entries, "C:\\Windows");
  f.action("refuse");
  f.proc.emit("exit", 0);
  assert.deepEqual(f.diagnostics, ["NATIVE_PRIVATE_PATH_CLOSE_UNKNOWN\n"]);
  assert.equal(f.proc.exitCode, 1);
});

function absent(pid, start, observed) {
  if (typeof observed === "string" && observed) return observed !== start;
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

function directWorker(data) {
  const worker = new ActualWorker(filename, { workerData: data, stdout: true, stderr: true });
  let output = "", diagnostic = "";
  worker.stdout.on("data", chunk => { output += chunk; });
  worker.stderr.on("data", chunk => { diagnostic += chunk; });
  const exited = new Promise(resolve => {
    worker.once("error", error => resolve({ error }));
    worker.once("exit", code => resolve({ code, output, diagnostic }));
  });
  function send(operation, extra = {}) {
    const buffer = new SharedArrayBuffer(4), state = new Int32Array(buffer);
    worker.postMessage({ operation, buffer, ...extra });
    return state;
  }
  function wait(state) {
    Atomics.wait(state, 0, 0, 5000);
    return Atomics.load(state, 0);
  }
  return { worker, exited, send, wait };
}

test("actual worker records invalid mode or unavailable provider boot failure and refuses close certainty", async () => {
  for (const data of [null, { mode: "wrong" }, { mode: "desk-native-private-path", root: 3 },
    { mode: "desk-native-private-path", root: path.join(await mkTempRoot("native-readonly-missing-"), "absent") }]) {
    const w = directWorker(data);
    assert.equal(w.wait(w.send("verify", { entries, due: Date.now() + 5000 })), -1);
    assert.equal(w.wait(w.send("close")), -1);
    assert.deepEqual(await w.exited, { code: 0, output: "", diagnostic: "" });
  }
});

for (const mode of ["clean", "unclean", "pending"]) {
  test(`actual worker rejects malformed/expired/cancelled requests and settles duplicate ${mode} close honestly`, {
    skip: process.platform === "win32", timeout: 20000,
  }, async () => {
    const root = await mkTempRoot("native-readonly-worker-protocol-");
    const provider = path.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe"), log = path.join(root, "requests.jsonl");
    await fs.mkdir(path.dirname(provider), { recursive: true });
    await writePosixNodeProvider(provider, `
const lines = require("node:readline").createInterface({ input: process.stdin })
lines.on("line", line => {
  require("node:fs").appendFileSync(${JSON.stringify(log)}, line + "\\n")
  setTimeout(() => process.stdout.write("private\\n"), ${mode === "pending" ? 100 : 0})
})
lines.on("close", () => { ${mode === "unclean" ? "process.exitCode = 3" : ""} })
`);
    const w = directWorker({ mode: "desk-native-private-path", root });
    w.worker.postMessage(null);
    w.worker.postMessage({ buffer: new ArrayBuffer(4) });
    w.worker.postMessage({ buffer: new SharedArrayBuffer(8) });
    assert.equal(w.wait(w.send("unknown")), -1);
    for (const due of [undefined, "future", NaN, Date.now() - 1])
      assert.equal(w.wait(w.send("verify", { entries, due })), -1);
    const cancelledBuffer = new SharedArrayBuffer(4), cancelled = new Int32Array(cancelledBuffer);
    Atomics.store(cancelled, 0, -2);
    w.worker.postMessage({ operation: "verify", entries, due: Date.now() + 5000, buffer: cancelledBuffer });
    assert.equal(w.wait(w.send("verify", { entries: [], due: Date.now() + 5000 })), -1);
    await assert.rejects(fs.access(log), { code: "ENOENT" });
    const verified = w.send("verify", { entries, due: Date.now() + 5000 });
    if (mode !== "pending") assert.equal(w.wait(verified), 1);
    const closed = w.send("close"), duplicate = w.send("close");
    const late = w.send("verify", { entries, due: Date.now() + 5000 });
    assert.equal(w.wait(closed), mode === "unclean" ? -1 : 2);
    assert.equal(w.wait(duplicate), mode === "unclean" ? -1 : 2);
    assert.equal(w.wait(late), -1);
    if (mode === "pending") assert.equal(w.wait(verified), -1);
    assert.equal(cancelled[0], -2);
    assert.deepEqual(await w.exited, { code: 0, output: "", diagnostic: "" });
  });
}

for (const mode of ["natural", "explicit-exit", "uncaught"]) {
  test(`actual readonly backend inherits preloads, reuses transport, and closes before ${mode}`, { timeout: 30000 }, async t => {
    const base = await mkTempRoot("native-readonly-worker-backend-"), log = path.join(base, "observer.jsonl");
    let root, provider, requested, served;
    if (process.platform === "win32") {
      root = process.env.SystemRoot || process.env.SYSTEMROOT;
      provider = assertWindowsAclAvailable();
      const directory = path.join(base, "private"), file = path.join(directory, "ready.json");
      await fs.mkdir(directory); await fs.writeFile(file, "{}");
      await protectWindowsPaths([{ path: directory, kind: "directory", created: true }, { path: file, kind: "file", created: true }]);
      requested = [{ file: directory, directory: true }, { file, directory: false }];
    } else {
      root = path.join(base, "provider");
      provider = path.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe");
      served = path.join(base, "requests.jsonl");
      await fs.mkdir(path.dirname(provider), { recursive: true });
      await writePosixNodeProvider(provider, `
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  require("node:fs").appendFileSync(${JSON.stringify(served)}, line + "\\n")
  process.stdout.write("private\\r\\n")
})
`);
      requested = entries;
    }

    const fixture = fileURLToPath(new URL("./fixtures/native-private-path-backend.cjs", import.meta.url));
    const observer = fileURLToPath(new URL("./fixtures/native-private-path-observer.cjs", import.meta.url));
    const child = fork(fixture, [mode, root, JSON.stringify(requested)], {
      execArgv: [...process.execArgv, "--require", observer],
      env: { ...process.env, DESK_OWNED_PRIVATE_PATH_OBSERVER: log }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "", diagnostic = "", helper, start;
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { diagnostic += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      if (helper) {
        for (let i = 0; i < 100 && !absent(helper.pid, start, await readProcessStart(helper.pid)); i++)
          await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(absent(helper.pid, start, await readProcessStart(helper.pid)), true);
      }
    });
    const boot = await Promise.race([
      new Promise(resolve => child.once("message", resolve)),
      exited.then(() => { throw Error("OWNED_BACKEND_ENDED_BEFORE_BOOT: " + diagnostic); }),
    ]);
    assert.equal(boot.event, "booted");
    const seen = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(seen.length, 1, "two verifies own exactly one live helper");
    helper = seen[0];
    assert.equal(helper.event, "spawn"); assert.equal(helper.isMainThread, false);
    assert.equal(helper.executable, provider);
    assert.equal(helper.digest, boot.digest, "Worker inherited complete NODE_OPTIONS and execArgv");
    start = await readProcessStart(helper.pid);
    assert.equal(typeof start, "string");
    if (served) assert.deepEqual((await fs.readFile(served, "utf8")).trim().split("\n").map(JSON.parse), [requested, requested]);
    t.diagnostic(JSON.stringify({ scope: process.platform === "win32" ? "actual Windows native privatePaths" : "POSIX transport only, not NTFS policy",
      mode, primary: child.pid, helper: { pid: helper.pid, start, executable: provider }, preloadDigest: boot.digest }));
    child.send("proceed");
    assert.deepEqual(await exited, { code: mode === "uncaught" ? 1 : 0, signal: null });
    const final = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(final.slice(1), [{ event: "eof", pid: helper.pid }, { event: "close", pid: helper.pid, code: 0, signal: null }]);
    assert.deepEqual(JSON.parse(output), { mode, exitCode: mode === "uncaught" ? 1 : 0, digest: boot.digest });
    if (mode === "uncaught") assert.match(diagnostic, /OWNED_BACKEND_EXPECTED_FAILURE/);
    else assert.equal(diagnostic, "");
  });
}

test("native Windows readonly backend rechecks adverse DACLs and kind/reparse/link policy without repairing them", {
  skip: process.platform !== "win32", timeout: 120000,
}, async () => {
  const base = await mkTempRoot("native-readonly-policy-"), directory = path.join(base, "private"), file = path.join(directory, "ready.json");
  await fs.mkdir(directory); await fs.writeFile(file, "{}");
  const paths = [{ path: directory, kind: "directory", created: true }, { path: file, kind: "file", created: true }];
  const requested = [{ file: directory, directory: true }, { file, directory: false }];
  const client = require(path.join(path.dirname(filename), "web-native-messaging.cjs"));
  const frontend = require(filename), root = process.env.SystemRoot || process.env.SYSTEMROOT;
  const snapshot = target => nativeProbe("$a=Get-Acl -LiteralPath $request.path;ConvertTo-Json -Compress -InputObject $a.Sddl", { path: target });
  await protectWindowsPaths(paths, { memoize: false });
  for (const entry of requested) {
    const before = snapshot(entry.file);
    client.privatePaths(requested); client.privatePaths(requested);
    assert.equal(snapshot(entry.file), before, "successful verification does not rewrite any ACL");
    for (const mutation of ["extra-rule", "inherited", "insufficient"]) {
      nativeProbe("$i=Get-Item -LiteralPath $request.path -Force;$a=$i.GetAccessControl('Access,Owner');" +
        "if($request.mode -eq 'inherited'){$a.SetAccessRuleProtection($false,$true)}" +
        "elseif($request.mode -eq 'insufficient'){$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;" +
        "foreach($r in @($a.Access)){[void]$a.RemoveAccessRule($r)};" +
        "$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'Read','Allow')))}" +
        "else{$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')),'Read','Allow')))};" +
        "$i.SetAccessControl($a);ConvertTo-Json -Compress -InputObject $true",
      { path: entry.file, mode: mutation });
      const adverse = snapshot(entry.file);
      assert.notEqual(adverse, before);
      assert.throws(() => client.privatePaths(requested), { code: "NATIVE_PRIVATE_PATH_INVALID" });
      assert.equal(snapshot(entry.file), adverse, "refused verification must not repair its input");
      await protectWindowsPaths(paths, { memoize: false });
      client.privatePaths(requested);
    }
  }
  for (const entry of requested) {
    assert.throws(() => frontend.verify([{ ...entry, directory: !entry.directory }], root), /NATIVE_PRIVATE_PATH_INVALID/);
    assert.throws(() => client.privatePaths([{ ...entry, directory: !entry.directory }]), { code: "NATIVE_PRIVATE_PATH_INVALID" });
  }
  const link = path.join(directory, "hard-link.json");
  await fs.link(file, link);
  assert.throws(() => client.privatePaths(requested), { code: "NATIVE_PRIVATE_PATH_INVALID" });
  await fs.unlink(link);
  const junction = path.join(base, "junction");
  await fs.symlink(directory, junction, "junction");
  assert.throws(() => client.privatePaths([{ file: junction, directory: true }]), { code: "NATIVE_PRIVATE_PATH_INVALID" });
  assert.throws(() => frontend.verify([{ file: junction, directory: true }], root), /NATIVE_PRIVATE_PATH_INVALID/);
  const foreign = process.execPath;
  const ownership = nativeProbe("$a=Get-Acl -LiteralPath $request.path;ConvertTo-Json -Compress -InputObject " +
    "([pscustomobject]@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;self=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value})",
  { path: foreign });
  assert.notEqual(ownership.owner, ownership.self, "standard-user runner's Node belongs to the installing account, not this test user");
  const foreignBefore = snapshot(foreign);
  assert.throws(() => client.privatePaths([{ file: foreign, directory: false }]), { code: "NATIVE_PRIVATE_PATH_INVALID" });
  assert.equal(snapshot(foreign), foreignBefore, "foreign-owned native input is refused without rewriting it");
  client.privatePaths(requested);
  frontend.close();
});
