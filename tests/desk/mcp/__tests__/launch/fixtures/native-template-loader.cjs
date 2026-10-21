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
const { isNativeError } = require("node:util").types;
const intrinsicStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack").get;
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

// One-shot observation at the existing VM global seam. Never retries or
// changes the verifier's result/refusal, and never projects arbitrary errors.
function observeNextVerifyGeneration(context, phase, diagnostic) {
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
    let stack = data(error, "stack");
    // V8 can expose its genuine Error stack as an accessor, including across
    // VM realms. Use only our captured intrinsic, never error.stack's getter.
    // Refuse accessor-backed formatting inputs rather than running user code.
    function plainHeader(key) {
      let object = error;
      try {
        for (let depth = 0; object && depth < 4; depth++, object = Object.getPrototypeOf(object)) {
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if (descriptor) return Object.hasOwn(descriptor, "value") &&
            (typeof descriptor.value === "string" || descriptor.value === undefined);
        }
      } catch {}
      return false;
    }
    if (stack === undefined && intrinsicStackGetter && isNativeError(error) &&
        plainHeader("name") && plainHeader("message")) {
      try { stack = Reflect.apply(intrinsicStackGetter, error, []); } catch {}
    }
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
      setupPhase: phase === "signedWorkerFixture.initial-daemon" ? phase : "unknown",
      originalCode: codes.has(code) ? code : "unknown",
      status: Number.isInteger(status) && status >= -2147483648 && status <= 4294967295 ? status : "unknown",
      signal: signals.has(signal) ? signal : "unknown",
      guard,
    };
  }
  let armed = true;
  function restore() {
    armed = false;
    if (context.verifyGeneration === observed) context.verifyGeneration = actual;
  }
  function observed(...args) {
    if (!armed) return Reflect.apply(actual, this, args);
    restore(); // Exactly the next invocation, including nested calls.
    try { return Reflect.apply(actual, this, args); }
    catch (error) {
      try { diagnostic(record(error)); } catch {}
      throw error; // Preserve identity even for malformed errors or failed sinks.
    }
  }
  context.verifyGeneration = observed;
  return restore;
}

module.exports = { loadTemplate, observeNextVerifyGeneration };
