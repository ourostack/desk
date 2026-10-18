"use strict";

const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");

function preloadDigest() {
  return createHash("sha256").update(JSON.stringify({
    present: Object.hasOwn(process.env, "NODE_OPTIONS"), value: process.env.NODE_OPTIONS,
    execArgv: process.execArgv,
  })).digest("hex");
}

if (!isMainThread) {
  const boot = new Int32Array(workerData.boot, 0, 2);
  const bytes = new Uint8Array(workerData.boot, 8);
  const script = "$ErrorActionPreference='Stop';" +
    "$self=[Diagnostics.Process]::GetCurrentProcess();" +
    "[Console]::Out.WriteLine((@{pid=$PID;start=('win32:'+$self.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'));executable=$self.MainModule.FileName}|ConvertTo-Json -Compress));" +
    "while($null -ne [Console]::In.ReadLine()){};" +
    "[Console]::Out.WriteLine('owned-eof')";
  const child = spawn(workerData.provider, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref();
  let output = "", diagnostic = "", ready = false, closed = false, closing;
  const timer = setTimeout(() => {
    Atomics.store(boot, 0, -1); Atomics.notify(boot, 0);
    child.kill();
  }, 5000);
  function bootFailure() {
    clearTimeout(timer);
    Atomics.store(boot, 0, -1); Atomics.notify(boot, 0);
  }
  child.on("error", bootFailure);
  child.stdin.on("error", bootFailure);
  child.stderr.on("data", chunk => { diagnostic += chunk; if (diagnostic.length > 4096) bootFailure(); });
  child.stdout.on("data", chunk => {
    output += chunk;
    if (output.length > 8192) return bootFailure();
    const newline = output.indexOf("\n");
    if (ready || newline < 0) return;
    try {
      const helper = JSON.parse(output.slice(0, newline));
      const metadata = Buffer.from(JSON.stringify({ helper, preloadDigest: preloadDigest() }));
      if (metadata.length > bytes.length || helper.pid !== child.pid) return bootFailure();
      bytes.set(metadata);
      Atomics.store(boot, 1, metadata.length);
      ready = true; output = output.slice(newline + 1);
      clearTimeout(timer);
      Atomics.store(boot, 0, 1); Atomics.notify(boot, 0);
    } catch { bootFailure(); }
  });
  child.on("close", (code, signal) => {
    closed = true;
    if (!ready) bootFailure();
    if (closing) {
      const valid = code === 0 && signal === null && output.trim() === "owned-eof" && diagnostic === "";
      Atomics.store(closing, 0, valid ? 2 : -1); Atomics.notify(closing, 0);
    }
    parentPort.close();
  });
  parentPort.on("message", buffer => {
    closing = new Int32Array(buffer);
    if (closed) {
      Atomics.store(closing, 0, -1); Atomics.notify(closing, 0);
      return;
    }
    child.stdin.end();
  });
} else {
  const mode = process.argv[2];
  const bootBuffer = new SharedArrayBuffer(8192), boot = new Int32Array(bootBuffer, 0, 2);
  const worker = new Worker(__filename, { workerData: { boot: bootBuffer, provider: process.argv[3] } });
  worker.unref();
  if (Atomics.wait(boot, 0, 0, 5000) === "timed-out" || Atomics.load(boot, 0) !== 1)
    throw Error("OWNED_WORKER_BOOT_FAILED");
  const metadata = JSON.parse(Buffer.from(new Uint8Array(bootBuffer, 8, Atomics.load(boot, 1))).toString("utf8"));
  if (metadata.preloadDigest !== preloadDigest()) throw Error("OWNED_PRELOAD_INHERITANCE_CHANGED");
  let attempted = false;
  function shutdown(event, code) {
    if (attempted) return;
    attempted = true;
    const buffer = new SharedArrayBuffer(4), state = new Int32Array(buffer);
    worker.postMessage(buffer);
    const wait = Atomics.wait(state, 0, 0, 5000);
    fs.writeSync(1, JSON.stringify({ mode, event, code, wait, status: Atomics.load(state, 0), ...metadata }) + "\n");
  }
  process.on("beforeExit", code => shutdown("beforeExit", code));
  process.on("exit", code => shutdown("exit", code));
  process.once("message", message => {
    if (message !== "proceed") throw Error("OWNED_WORKER_COMMAND_INVALID");
    process.disconnect();
    if (mode === "explicit-exit") process.exit(0);
    if (mode === "uncaught") throw Error("OWNED_EXPECTED_FAILURE");
    if (mode !== "natural") throw Error("OWNED_WORKER_MODE_INVALID");
  });
  process.send({ event: "booted", ...metadata });
}
