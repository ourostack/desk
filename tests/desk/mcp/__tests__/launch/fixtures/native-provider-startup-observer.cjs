"use strict";
// Diagnostic-only source hook. No production file, dependency, outcome or cleanup is replaced.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { registerHooks } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const SOURCE_HASH = "cb01897be483f39103a122ce5189e2816c8d73ef6405465cb0898318221b37ae";
const KEY = Symbol.for("desk.test.nativeProviderStartup.observer");
const CATCH = "} catch (error) { await close(); throw fail(error.code === 'NATIVE_STATE_CHANGED' ? error.code : 'NATIVE_PROVIDER_START_FAILED'); }";
const OBSERVED_CATCH = "} catch (error) { try { globalThis[Symbol.for('desk.test.nativeProviderStartup.observer')](__deskStartupPhase, error, performance.now() - __deskStartupAt); } catch {} await close(); throw fail(error.code === 'NATIVE_STATE_CHANGED' ? error.code : 'NATIVE_PROVIDER_START_FAILED'); }";
const phases = new Set(["listen", "reserve-ready", "ready-identity", "ready-fingerprint", "ready-private-json",
  "connection-check", "admission-validation", "on-admitted", "final-recheck", "open"]);
const codes = new Set(["NATIVE_PRIVATE_PATH_INVALID", "NATIVE_PRIVATE_PATH_CLOSE_UNKNOWN", "NATIVE_STATE_CHANGED", "NATIVE_STATE_UNAVAILABLE",
  "NATIVE_READY_CHANGED", "NATIVE_READY_INVALID", "NATIVE_READY_UNAVAILABLE", "NATIVE_READY_EXISTS",
  "NATIVE_PROVIDER_LISTEN_FAILED", "NATIVE_CONFIG_INVALID", "NATIVE_TRANSPORT_DISCONNECTED",
  "NATIVE_ANCESTRY_MISMATCH", "NATIVE_SELECTION_MISMATCH", "NATIVE_PROFILE_TOKEN_CHANGED",
  "NATIVE_UPDATE_EVIDENCE_CHANGED", "NATIVE_UPDATE_INVENTORY_UNKNOWN", "NATIVE_UPDATE_INVENTORY_INCOMPLETE",
  "NATIVE_UPDATE_PREPARED_OBLIGATION", "NATIVE_CONTEXTS_ACTIVE", "NATIVE_CODE_CHANGED", "NATIVE_CODE_UNAVAILABLE",
  "NATIVE_TRANSITION_BINDING_INVALID", "NATIVE_TRANSITION_CHANGED", "NATIVE_TRANSITION_JOURNAL_INVALID",
  "NATIVE_LEGACY_CONTINUITY_UNPROVED", "NATIVE_TRANSITION_TERMINAL_EVIDENCE_UNSUPPORTED",
  "NATIVE_TRANSITION_WITNESS_INVALID", "NATIVE_TRANSITION_REPLAY", "NATIVE_TRANSITION_WITNESS_UNAVAILABLE",
  "NATIVE_TRANSITION_ORIGIN_UNPROVED", "NATIVE_TRANSITION_RELEASE_UNCONFIRMED", "NATIVE_CONTINUITY_UNKNOWN",
  "NATIVE_SNAPSHOT_CHANGED", "NATIVE_INVENTORY_INVALID", "NATIVE_OWNER_INVALID", "NATIVE_OWNER_BINDING_MISMATCH",
  "ENOENT", "EACCES", "EPERM", "EIO", "ETIMEDOUT", "EINTR", "EMFILE", "ENFILE", "ENOTDIR", "EISDIR",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);

function own(value, key) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}
function metadata(phase, error, elapsed) {
  const code = own(error, "code"), status = own(error, "status"), signal = own(error, "signal");
  return {
    phase: phases.has(phase) ? phase : "unknown",
    outcome: error === null ? "ready" : "refused",
    originalCode: error === null ? "none" : codes.has(code) ? code : "unknown",
    status: Number.isInteger(status) && status >= -2147483648 && status <= 4294967295 ? status : "unknown",
    signal: ["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGSEGV", "SIGPIPE"].includes(signal) ? signal : "unknown",
    sinceListenMs: typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 600000 ?
      Math.round(elapsed) : "unknown",
  };
}
function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, "exact single startup observation seam");
  return source.replace(from, to);
}
function instrument(source) {
  assert.equal(createHash("sha256").update(source).digest("hex"), SOURCE_HASH, "refuse unknown provider source");
  let result = replaceOnce(source, "  try {\n    await new Promise((resolve, reject) => {\n      server.once('error'",
    "  let __deskStartupPhase = 'listen'; const __deskStartupAt = performance.now();\n  try {\n    await new Promise((resolve, reject) => {\n      server.once('error'");
  for (const [statement, phase] of [
    ["    reservation = await reserveNativeReadyFile", "reserve-ready"],
    ["    readyIdentity = client.fileIdentity", "ready-identity"],
    ["    readyFingerprint = hash(record);", "ready-fingerprint"],
    ["    if (hash(client.readPrivateJson(config.nativeReadyFile))", "ready-private-json"],
    ["    if (!connected) throw fail('NATIVE_TRANSPORT_DISCONNECTED');", "connection-check"],
    ["    if (onAdmitted !== undefined) {", "admission-validation"],
    ["      await onAdmitted(Object.freeze({", "on-admitted"],
  ]) result = replaceOnce(result, statement, `    __deskStartupPhase = '${phase}';\n${statement}`);
  result = replaceOnce(result, "      }));\n      await recheck();",
    "      }));\n      __deskStartupPhase = 'final-recheck';\n      await recheck();");
  result = replaceOnce(result, "    phase = 'open';\n  } catch (error) { await close();",
    "    phase = 'open';\n    try { globalThis[Symbol.for('desk.test.nativeProviderStartup.observer')]('open', null, performance.now() - __deskStartupAt); } catch {}\n  } catch (error) { await close();");
  return replaceOnce(result, CATCH, OBSERVED_CATCH);
}

if (process.env.DESK_TEST_NATIVE_STARTUP_OBSERVATION === "1") {
  const canonical = path.resolve(__dirname, "../../../../../../plugins/desk/mcp/src/browser/native-provider.mjs");
  const url = pathToFileURL(canonical).href;
  Object.defineProperty(globalThis, KEY, { configurable: true, value: (phase, error, elapsed) => {
    process.stdout.write("DESK_NATIVE_PROVIDER_STARTUP_DIAGNOSTIC_V1 " + JSON.stringify(metadata(phase, error, elapsed)) + "\n");
  } });
  registerHooks({ load(requested, context, nextLoad) {
    const loaded = nextLoad(requested, context);
    if (requested !== url) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    const observed = instrument(source);
    process.stdout.write("DESK_NATIVE_PROVIDER_STARTUP_SOURCE_V1 " + JSON.stringify({ sourceHash: SOURCE_HASH,
      scope: "diagnostic_transform_only", file: "plugins/desk/mcp/src/browser/native-provider.mjs" }) + "\n");
    return { ...loaded, source: observed };
  } });
}
module.exports = { SOURCE_HASH, KEY, CATCH, OBSERVED_CATCH, metadata, instrument };
