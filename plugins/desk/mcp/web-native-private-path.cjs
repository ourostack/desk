"use strict";

var threads = require("node:worker_threads");
var monotonic = require("node:perf_hooks").performance;
var LIMIT = 5000;
var MODE = "desk-native-private-path";
function invalid() { return new Error("NATIVE_PRIVATE_PATH_INVALID"); }
function closeUnknown() { return new Error("NATIVE_PRIVATE_PATH_CLOSE_UNKNOWN"); }

if (threads.isMainThread) {
  var current, instances = [], closed = false, closeFailed = false, hooked = false, stopped = false;
  function beginClose(instance) {
    if (!instance.closing) {
      instance.closing = new SharedArrayBuffer(4);
      var state = new Int32Array(instance.closing);
      try {
        if (instance.exited) throw closeUnknown();
        instance.worker.postMessage({ operation: "close", buffer: instance.closing });
      } catch (error) { Atomics.store(state, 0, -1); }
    }
    return new Int32Array(instance.closing);
  }
  function waitFor(state, due, expected) {
    if (Atomics.load(state, 0) === expected) return monotonic.now() <= due;
    var remaining = due - monotonic.now();
    if (remaining <= 0) return false;
    Atomics.wait(state, 0, 0, remaining);
    return Atomics.load(state, 0) === expected && monotonic.now() <= due;
  }
  function close() {
    if (!closed) {
      closed = true;
      current = undefined;
      var due = monotonic.now() + LIMIT;
      instances.forEach(beginClose);
      instances.forEach(function (instance) {
        if (!waitFor(new Int32Array(instance.closing), due, 2)) closeFailed = true;
      });
    }
    if (closeFailed) throw closeUnknown();
  }
  function shutdown() {
    if (stopped) return;
    stopped = true;
    try { close(); }
    catch (error) {
      process.stderr.write("NATIVE_PRIVATE_PATH_CLOSE_UNKNOWN\n");
      if (!process.exitCode) process.exitCode = 1;
    }
  }
  function verify(entries, root) {
    var until = monotonic.now() + LIMIT, due = Date.now() + LIMIT, instance, buffer, state;
    try {
      if (closed || typeof root !== "string" || !root || !Array.isArray(entries) ||
          entries.length < 1 || entries.length > 64 || Buffer.byteLength(JSON.stringify(entries)) > 65536) throw invalid();
      instances.forEach(function (retired) {
        if (retired !== current && !waitFor(beginClose(retired), until, 2)) throw invalid();
      });
      instances = current ? [current] : [];
      if (current && current.root !== root) {
        if (!waitFor(beginClose(current), until, 2)) throw invalid();
        current = undefined;
        instances = [];
      }
      if (!current) {
        var worker = new threads.Worker(__filename, { workerData: { mode: MODE, root: root } });
        instance = { worker: worker, root: root, broken: false, exited: false, closing: null };
        worker.on("error", function () { instance.broken = true; });
        worker.on("exit", function () { instance.exited = true; instance.broken = true; });
        worker.unref();
        current = instance;
        instances.push(instance);
        if (!hooked) {
          hooked = true;
          process.on("beforeExit", shutdown);
          process.on("exit", shutdown);
        }
      }
      instance = current;
      if (instance.broken || monotonic.now() >= until) throw invalid();
      buffer = new SharedArrayBuffer(4);
      state = new Int32Array(buffer);
      instance.worker.postMessage({ operation: "verify", entries: entries, due: due, buffer: buffer });
      if (!waitFor(state, until, 1)) throw invalid();
    } catch (error) {
      if (state) Atomics.store(state, 0, -2);
      if (current) { beginClose(current); current = undefined; }
      throw invalid();
    }
  }
  module.exports = { verify: verify, close: close };
} else {
  var reader, closing, failed = false;
  var data = threads.workerData;
  function answer(state, status) {
    Atomics.compareExchange(state, 0, 0, status);
    Atomics.notify(state, 0);
  }
  function finish() {
    if (!closing) {
      closing = reader ? reader.close() : Promise.resolve();
      closing.then(function () { threads.parentPort.close(); }, function () { failed = true; threads.parentPort.close(); });
    }
    return closing;
  }
  var loaded = import("./src/factory/windows-acl.js");
  // The rejection is recorded even if startup fails before the first message.
  loaded = loaded.then(function (api) {
    if (!data || data.mode !== MODE || typeof data.root !== "string") throw invalid();
    reader = api.createWindowsPrivatePathVerifier({ env: { SystemRoot: data.root } });
  }).catch(function () { failed = true; });
  threads.parentPort.on("message", async function (message) {
    if (!message || !(message.buffer instanceof SharedArrayBuffer) || message.buffer.byteLength !== 4) return;
    var state = new Int32Array(message.buffer);
    try {
      await loaded;
      if (message.operation === "close") {
        await finish();
        answer(state, failed ? -1 : 2);
        return;
      }
      if (message.operation !== "verify" || closing || failed || Atomics.load(state, 0) !== 0 ||
          !Number.isSafeInteger(message.due) || message.due <= Date.now()) throw invalid();
      await reader.verify(message.entries, message.due);
      answer(state, 1);
    } catch (error) { answer(state, -1); }
  });
}
