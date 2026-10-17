"use strict";

// Installed template. All native authority comes from the fixed sibling's
// verified receipt/private config. Nothing in an error or page selects code.
var PREFIX = "DESK_NATIVE_CLI_V1 ";
var MAX_FRAME = 4194304;
var MAX_DIAGNOSTICS = 1048576;
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var SHA = /^[a-f0-9]{64}$/;
var STAGES = ["launch.config", "launch.acquire", "launch.backend", "launch.publish", "command", "stop"];
var scopes = new WeakMap(), projections = new WeakMap(), results = new WeakMap();
var daemonScopes = new WeakMap();
var marker = Symbol("desk.native.error");

function credential() { return require(require("path").join(__dirname, "desk-extension-credential.cjs")); }
function now() { return require("perf_hooks").performance.now(); }
function unknown(expected) {
  var error = new Error("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
  error.code = error.message;
  error.resources = { disposition: "unknown" };
  if (expected && UUID.test(expected.contextId)) error.resources.contextId = expected.contextId;
  return error;
}
function scopeFor(input) {
  var binding = credential().nativeErrorTransportBinding(input);
  if (!binding) return null;
  var scope = Object.freeze({ contextId: binding.contextId, sourceGeneration: binding.sourceGeneration });
  scopes.set(scope, binding);
  return scope;
}
function bindingFor(scope) {
  var binding = scopes.get(scope);
  if (!binding) throw unknown();
  return binding;
}
function forDaemon(config, sessionName) {
  var cached = daemonScopes.get(config);
  if (cached && cached.sessionName === sessionName) { stamp(cached.scope); return cached.scope; }
  var scope = scopeFor({ kind: "resolved", config: config, sessionName: sessionName });
  if (scope) { stamp(scope); daemonScopes.set(config, { sessionName: sessionName, scope: scope }); }
  return scope;
}
function stamp(scope) {
  var binding = bindingFor(scope);
  binding.assert();
  // The opaque binding's successful assertion already proves the canonical
  // record/session UUID; sourceGeneration is its verified SHA-256 construction.
  // Wire candidates still undergo the independent strict checks below.
  return { version: 1, contextId: scope.contextId, sourceGeneration: scope.sourceGeneration };
}
function sessionStamp(scope) { return stamp(scope); }
function equivalentScope(left, right) {
  if (left === right) return true;
  var a = bindingFor(left), b = bindingFor(right);
  return !!a.identity && a.identity === b.identity &&
    left.contextId === right.contextId && left.sourceGeneration === right.sourceGeneration;
}
function projected(error, scope) {
  var binding = bindingFor(scope), previous = projections.get(error);
  if (previous) {
    if (!equivalentScope(previous.scope, scope)) throw unknown(scope);
    return previous.value;
  }
  var value;
  try { value = binding.project(error); }
  catch (_) { value = { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED",
    message: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED", resources: unknown(scope).resources }; }
  if (value.code === "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" && value.resources === null)
    value.resources = unknown(scope).resources;
  return value;
}
function preflightError(error, scope) {
  var value = projected(error, scope), safe = new Error(value.message);
  safe.code = value.code; safe.resources = value.resources;
  return safe;
}
function project(error, scope, routing) {
  bindingFor(scope);
  if (!routing || STAGES.indexOf(routing.stage) === -1 ||
      ((routing.stage === "command" || routing.stage === "stop") ?
        !Number.isSafeInteger(routing.requestId) || routing.requestId <= 0 : routing.requestId !== null) ||
      (!UUID.test(scope.contextId) && !(scope.contextId === "unbound" && routing.stage === "launch.config")) ||
      !SHA.test(scope.sourceGeneration)) throw unknown(scope);
  var value = projected(error, scope);
  var envelope = Object.assign({ version: 1, kind: "error", contextId: scope.contextId,
    sourceGeneration: scope.sourceGeneration, stage: routing.stage, requestId: routing.requestId }, value);
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_FRAME) throw unknown(scope);
  return envelope;
}
function markResult(result, error, scope) {
  bindingFor(scope);
  if (!result || typeof result !== "object") throw unknown(scope);
  var value = projected(error, scope), existing = results.get(result);
  if (existing && !equivalentScope(existing.scope, scope)) throw unknown(scope);
  if (!existing) {
    existing = { scope: scope, value: Object.assign({}, value) };
    results.set(result, existing);
    Object.defineProperty(result, marker, { value: true, enumerable: false });
  } else {
    existing.value.relatedErrors = (existing.value.relatedErrors || []).concat([
      { code: value.code, message: value.message, resources: value.resources }
    ], value.relatedErrors || []);
  }
  return result;
}
function takeResult(result, scope) {
  bindingFor(scope);
  var saved = results.get(result);
  if (!saved || !equivalentScope(saved.scope, scope) || !Object.prototype.hasOwnProperty.call(result, marker)) return undefined;
  var value = credential().nativeErrorTransportBinding.json(saved.value);
  function freeze(item) {
    if (item && typeof item === "object") {
      Object.keys(item).forEach(function (key) { freeze(item[key]); });
      Object.freeze(item);
    }
  }
  freeze(value);
  projections.set(value, { scope: scope, value: value });
  return value;
}
function checked(value, expected, readyAllowed) {
  var binding = credential().nativeErrorTransportBinding;
  var data = binding.json(value);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw unknown(expected);
  var ready = data.kind === "ready";
  var keys = ready ? "contextId,kind,requestId,sourceGeneration,stage,version" :
    "code,contextId,kind,message,requestId,resources,sourceGeneration,stage,version";
  if (!ready && Object.prototype.hasOwnProperty.call(data, "relatedErrors")) keys += ",relatedErrors";
  if (Object.keys(data).sort().join(",") !== keys.split(",").sort().join(",") ||
      data.version !== 1 || !SHA.test(data.sourceGeneration) ||
      (!UUID.test(data.contextId) && !(data.contextId === "unbound" && data.kind === "error" && data.stage === "launch.config")) ||
      data.contextId !== expected.contextId || data.sourceGeneration !== expected.sourceGeneration)
    throw unknown(expected);
  if (ready) {
    if (!readyAllowed || data.stage !== "launch.ready" || data.requestId !== null) throw unknown(expected);
    return data;
  }
  if (data.kind !== "error" || STAGES.indexOf(data.stage) === -1 ||
      (expected.stage !== undefined && data.stage !== expected.stage) ||
      (expected.requestId !== undefined && data.requestId !== expected.requestId) ||
      ((data.stage === "command" || data.stage === "stop") ?
        !Number.isSafeInteger(data.requestId) || data.requestId <= 0 : data.requestId !== null))
    throw unknown(expected);
  function errorPart(part) {
    if (!part || Object.keys(part).sort().join(",") !== "code,message,resources") throw unknown(expected);
    var canonical = binding.project({ code: part.code, resources: part.resources });
    if (JSON.stringify(canonical) !== JSON.stringify({ code: part.code, message: part.message, resources: part.resources }))
      throw unknown(expected);
  }
  errorPart({ code: data.code, message: data.message, resources: data.resources });
  if (Object.prototype.hasOwnProperty.call(data, "relatedErrors")) {
    if (!Array.isArray(data.relatedErrors) || !data.relatedErrors.length) throw unknown(expected);
    data.relatedErrors.forEach(errorPart);
  }
  // json() counted these exact serialized bytes before returning this clone.
  return data;
}
function decodeError(value, expected) {
  var correlation;
  try {
    correlation = credential().nativeErrorTransportBinding.json(expected);
    if (!correlation || !UUID.test(correlation.contextId) || !SHA.test(correlation.sourceGeneration) ||
        STAGES.indexOf(correlation.stage) === -1 ||
        ((correlation.stage === "command" || correlation.stage === "stop") ?
          !Number.isSafeInteger(correlation.requestId) || correlation.requestId <= 0 : correlation.requestId !== null))
      throw unknown(correlation);
    var data = checked(value, correlation, false);
    var error = new Error(data.message);
    error.code = data.code; error.resources = data.resources;
    error.nativeTransport = { version: 1, contextId: data.contextId, sourceGeneration: data.sourceGeneration,
      stage: data.stage, requestId: data.requestId };
    if (data.relatedErrors) error.relatedErrors = data.relatedErrors;
    return error;
  } catch (_) { throw unknown(correlation); }
}
async function writeLaunch(scope, value) {
  bindingFor(scope);
  var deadline = now() + 5000, timer, retired = false;
  try {
    var envelope = checked(value, { contextId: scope.contextId, sourceGeneration: scope.sourceGeneration }, true);
    if (envelope.kind === "ready") stamp(scope);
    if (envelope.stage !== "launch.ready" && envelope.stage.indexOf("launch.") !== 0) throw unknown(scope);
    var bytes = Buffer.from(PREFIX + JSON.stringify(envelope) + "\n");
    if (bytes.length > MAX_FRAME) throw unknown(scope);
    var helper = credential();
    helper.protect(process);
    if (now() >= deadline) throw unknown(scope);
    await new Promise(function (resolve, reject) {
      timer = setTimeout(function () { reject(unknown(scope)); }, Math.max(0, deadline - now()));
      var called = false;
      process.stdout.write(bytes, function (error) {
        if (called || retired) return;
        called = true;
        if (error) { reject(error); return; }
        // This callback proves only this frame's acceptance, not delivery.
        // A false return may be accepted backpressure; the callback and E3's
        // actual pending-write/drain proof are independently required.
        helper.flushProtection(process).then(resolve, reject);
      });
    });
    if (now() >= deadline) throw unknown(scope);
  } catch (_) { throw unknown(scope); }
  finally { retired = true; clearTimeout(timer); }
}
function forLaunch(cliArgs, clientInfo) {
  if (!cliArgs.config) return null;
  var started = now();
  var scope = scopeFor({ kind: "file", configFile: cliArgs.config, sessionName: cliArgs.session,
    channel: cliArgs.browser || process.env.PLAYWRIGHT_MCP_BROWSER || "chrome" });
  if (!scope) return null;
  var binding = bindingFor(scope), deadline = started + 45000, timer, fd, disposed = false;
  var tail = Buffer.alloc(0), diagnostics = 0, terminal, failure, settle, reject;
  var promise;
  function finish(error, value) {
    if (disposed || terminal || failure) return;
    if (error) failure = error; else terminal = value;
    clearTimeout(timer);
    if (error && reject) reject(error);
    if (!error && settle) settle(value);
  }
  function fail() { finish(unknown(scope)); }
  function assertLive() {
    if (disposed || now() >= deadline) throw unknown(scope);
  }
  function push(bytes) {
    if (disposed || failure) return;
    try {
      assertLive();
      if (!Buffer.isBuffer(bytes) && !ArrayBuffer.isView(bytes)) throw unknown(scope);
      bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (tail.length + bytes.length > MAX_FRAME + MAX_DIAGNOSTICS) throw unknown(scope);
      var pending = Buffer.concat([tail, bytes]), offset = 0, found;
      for (;;) {
        var end = pending.indexOf(10, offset);
        if (end < 0) break;
        var line = pending.subarray(offset, end); offset = end + 1;
        var text = line.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(line)) throw unknown(scope);
        if (text.indexOf("DESK_NATIVE_CLI_V1") === 0 && text.indexOf(PREFIX) !== 0) throw unknown(scope);
        if (text.indexOf(PREFIX) === 0) {
          if (line.length + 1 > MAX_FRAME || found || terminal) throw unknown(scope);
          found = checked(JSON.parse(text.slice(PREFIX.length)), {
            contextId: scope.contextId, sourceGeneration: scope.sourceGeneration }, true);
          if (found.requestId !== null || found.stage.indexOf("launch.") !== 0) throw unknown(scope);
        } else {
          diagnostics += line.length + 1;
          if (diagnostics > MAX_DIAGNOSTICS) throw unknown(scope);
        }
      }
      tail = Buffer.from(pending.subarray(offset));
      if (tail.length > MAX_FRAME) throw unknown(scope);
      var prefix = Buffer.from(PREFIX), head = tail.subarray(0, prefix.length);
      if (!prefix.subarray(0, head.length).equals(head) && diagnostics + tail.length > MAX_DIAGNOSTICS)
        throw unknown(scope);
      // Validate the entire delivered batch before settling: two terminal
      // records (including ready+error) can never be first-message-wins.
      if (found) {
        if (tail.length) throw unknown(scope);
        binding.assert();
        var error = found.kind === "error" ? decodeError(found, {
          contextId: scope.contextId, sourceGeneration: scope.sourceGeneration, stage: found.stage, requestId: null }) : null;
        assertLive();
        if (error) finish(error);
        else finish(null, found);
      }
    } catch (_) { fail(); }
  }
  return Object.freeze({
    scope: scope,
    validate: function () {
      try { assertLive(); binding.validateLaunch(cliArgs); assertLive(); }
      catch (error) { throw preflightError(error, scope); }
    },
    openErrorLog: function () {
      try { assertLive(); if (fd !== undefined) throw unknown(scope); fd = binding.openErrorLog(clientInfo); assertLive(); return fd; }
      catch (error) { throw preflightError(error, scope); }
    },
    push: push,
    end: function () { if (!terminal && !failure) fail(); },
    wait: function () {
      if (!promise) promise = new Promise(function (resolve, rejectPromise) {
        settle = resolve; reject = rejectPromise;
        if (failure) reject(failure);
        else if (terminal) settle(terminal);
        else timer = setTimeout(fail, Math.max(0, deadline - now()));
      });
      return promise;
    },
    dispose: function () {
      if (disposed) return;
      if (!terminal && !failure) fail();
      disposed = true; clearTimeout(timer);
      if (fd !== undefined) {
        var ownedFd = fd; fd = undefined;
        try { require("fs").closeSync(ownedFd); }
        catch (error) { return preflightError(error, scope); }
      }
    }
  });
}
module.exports = { forLaunch: forLaunch, forDaemon: forDaemon, project: project,
  markResult: markResult, takeResult: takeResult, writeLaunch: writeLaunch,
  sessionStamp: sessionStamp, decodeError: decodeError };
