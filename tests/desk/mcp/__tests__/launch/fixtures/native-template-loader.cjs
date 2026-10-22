"use strict";

// Test-only resource-context compilation, not a production loader.
// Stage and canonical bytes must be identical. Under the running declared NYC
// dependency use its unmodified Istanbul instrumenter/configuration and share
// the collector's ordinary __coverage__ object. Counter maps/positions are
// produced by Istanbul from those exact bytes, never manufactured or rewritten.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../../../../../../plugins/desk/mcp");
const names = {
  "browser-context.cjs": "browser-context.cjs",
  "browser-context-common.cjs": "browser-context-common.cjs",
  "web.cjs": "web.cjs",
  "desk-extension-credential.cjs": "web-extension-credential.cjs",
  "desk-native-relay.cjs": "web-native-relay.cjs",
  "desk-native-error-transport.cjs": "web-native-error-transport.cjs",
  "web-extension-credential.cjs": "web-extension-credential.cjs",
  "web-native-relay.cjs": "web-native-relay.cjs",
  "web-native-error-transport.cjs": "web-native-error-transport.cjs",
  "web-playwright-patch.cjs": "web-playwright-patch.cjs",
};

function loadTemplate(runtimeFile, context) {
  const canonical = path.join(root, names[path.basename(runtimeFile)]);
  const bytes = fs.readFileSync(runtimeFile);
  assert.deepEqual(bytes, fs.readFileSync(canonical), "execute unchanged actual template bytes");
  let source = bytes.toString("utf8");
  let instrumented = false;
  if (process.env.NYC_CONFIG) {
    // NYC is a declared MCP devDependency. A relocated retained invocation can
    // resolve from its actual loaded module, without an extra dependency/env
    // locator or installation. This cache lookup locates tooling, never code
    // under test or a production/native client.
    const filename = Object.keys(require.cache).find(file => /[/\\]nyc[/\\]index\.js$/.test(file));
    assert.ok(filename, "running NYC loaded its standard instrumenter owner");
    const NYC = require(filename);
    const nyc = new NYC(JSON.parse(process.env.NYC_CONFIG));
    if (nyc.exclude.shouldInstrument(canonical)) {
      const instrumenter = nyc.instrumenter();
      source = instrumenter.instrumentSync(source, canonical, { registerMap() {} });
      const existing = global.__coverage__ && global.__coverage__[canonical], generated = instrumenter.lastFileCoverage();
      if (existing) for (const key of ["statementMap", "fnMap", "branchMap"])
        assert.equal(JSON.stringify(generated[key]), JSON.stringify(existing[key]), "standard canonical source-position identity");
      if (global.__coverage__) context.__coverage__ = global.__coverage__;
      instrumented = true;
    }
  }
  vm.runInNewContext(source, context, { filename: canonical });
  if (instrumented && !global.__coverage__) {
    assert.ok(context.__coverage__, "standard Istanbul template execution initialized its ordinary collector");
    global.__coverage__ = context.__coverage__;
  }
  return context.module.exports;
}

// Bounded observation at the existing VM global seam. Never retries or
// changes the verifier's result/refusal, and never projects arbitrary errors.
function observeNextVerifyGeneration(context, phase, diagnostic) {
  return observeVerifyGeneration(context, phase, diagnostic, true);
}

function observeFirstVerifyGenerationFailure(context, phase, diagnostic) {
  return observeVerifyGeneration(context, phase, diagnostic, false);
}

function observeVerifyGeneration(context, phase, diagnostic, oneShot) {
  const actual = context.verifyGeneration;
  assert.equal(typeof actual, "function");
  assert.equal(typeof diagnostic, "function");
  const codes = new Set([
    "NATIVE_CODE_UNAVAILABLE", "NATIVE_CODE_CHANGED", "NATIVE_PRIVATE_PATH_INVALID",
    "NATIVE_DISCOVERY_INPUTS_UNAVAILABLE", "ENOENT", "EACCES", "EPERM", "EIO",
    "ETIMEDOUT", "EINTR", "EMFILE", "ENFILE", "ENOTDIR", "EISDIR",
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  ]);
  const signals = new Set(["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGHUP", "SIGSEGV", "SIGPIPE"]);
  const guardFiles = new Map([
    ["web-extension-credential.cjs", "plugins/desk/mcp/web-extension-credential.cjs"],
    ["web-playwright-patch.cjs", "plugins/desk/mcp/web-playwright-patch.cjs"],
  ]);
  function data(error, key) {
    if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    } catch { return undefined; }
  }
  function record(error) {
    const code = data(error, "code"), status = data(error, "status"), signal = data(error, "signal");
    // Only an existing own data-string stack is observable. Even a captured
    // intrinsic accessor can execute the thrown realm's prepareStackTrace.
    const stack = data(error, "stack");
    let guard = { file: "unknown", line: "unknown" };
    if (typeof stack === "string") {
      for (const frame of stack.slice(0, 16384).split("\n")) {
        if (!/^\s*at\s/.test(frame)) continue;
        const match = /[/\\](web-extension-credential\.cjs|web-playwright-patch\.cjs):([1-9][0-9]{0,4})(?::[1-9][0-9]{0,4})?\)?\s*$/.exec(frame);
        if (match) {
          guard = { file: guardFiles.get(match[1]), line: Number(match[2]) };
          break;
        }
      }
    }
    return {
      setupPhase: ["signedWorkerFixture.initial-daemon","signedWorkerFixture.codec-binding"].includes(phase) ? phase : "unknown",
      originalCode: codes.has(code) ? code : "unknown",
      status: Number.isInteger(status) && status >= -2147483648 && status <= 4294967295 ? status : "unknown",
      signal: signals.has(signal) ? signal : "unknown",
      guard,
    };
  }
  let armed = true, reported = false;
  function restore() {
    armed = false;
    if (context.verifyGeneration === observed) context.verifyGeneration = actual;
  }
  function observed(...args) {
    if (!armed) return Reflect.apply(actual, this, args);
    if (oneShot) restore();
    try { return Reflect.apply(actual, this, args); }
    catch (error) {
      if (!reported) {
        reported = true;
        restore();
        try { diagnostic(record(error)); } catch {}
      }
      throw error; // Preserve identity even for malformed errors or failed sinks.
    }
  }
  context.verifyGeneration = observed;
  return restore;
}

module.exports = { loadTemplate, observeNextVerifyGeneration, observeFirstVerifyGenerationFailure };
