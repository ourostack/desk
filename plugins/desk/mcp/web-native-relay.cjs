"use strict";

// This source is staged verbatim beside desk-extension-credential.cjs. It is
// entered only by the fully guarded Core native branch, never by stock setup.
var path = require("path");
var URLClass = require("url").URL;
var outstanding = new Set();
var E_CODES = ["NATIVE_HANDSHAKE_TIMEOUT", "NATIVE_RELAY_ENDPOINT_INVALID", "NATIVE_ACQUISITION_UNAVAILABLE",
  "NATIVE_CODE_UNAVAILABLE", "NATIVE_CODE_CHANGED", "NATIVE_DISCOVERY_INPUTS_UNAVAILABLE", "NATIVE_BROWSER_UNAVAILABLE"];
function fail(code, resources, credential) {
  var safe = credential ? credential.redactProtected(process, resources) : resources;
  var error = new Error(code + (safe ? ": " + JSON.stringify(safe) : ""));
  error.code = code;
  if (safe !== undefined) error.resources = safe;
  return error;
}
function initialize(record, selection, clock) {
  return Promise.resolve().then(function () {
    if (!record || typeof record !== "object" || typeof record.contextId !== "string")
      throw fail("NATIVE_CONFIG_INVALID");
    var credential;
    try { credential = require(path.join(__dirname, "desk-extension-credential.cjs")); }
    catch (error) { throw fail("NATIVE_CODE_UNAVAILABLE"); }
    var binding = credential.getNativeBinding(record);
    var recoveryContext = process.env.DESK_BROWSER_RECOVERY_CONTEXT;
    if (recoveryContext !== undefined && recoveryContext !== record.contextId) throw fail("NATIVE_CONFIG_INVALID");
    var method = recoveryContext === record.contextId ? "context.resume" : "context.create";
    if (!selection || JSON.stringify(selection) !== JSON.stringify(binding.selection) ||
        !clock || typeof clock.now !== "function" || !Number.isFinite(clock.deadline))
      throw fail("NATIVE_SELECTION_MISMATCH");
    var deadline = clock.deadline, now = clock.now, retired = false, attempted = false;
    var dispatched = false, created = false, pending = false, nativeResult, paths, endpoints, client;
    var ownRelay, relaySettled = false, relayStopped = false, pendingRelayOperation = false;
    var pendingAcquisitionOperations = new Set();
    function closeSettledRelay() {
      if (ownRelay && relaySettled && !relayStopped) {
        relayStopped = true;
        ownRelay.stop();
      }
    }
    function retire() { retired = true; closeSettledRelay(); }
    function failure(error) {
      var code = E_CODES.indexOf(error && error.code) !== -1 ? error.code :
        binding.client.safeCode(error && error.code, "NATIVE_ACQUISITION_UNAVAILABLE");
      var resources = binding.client.safeResources(error && error.resources);
      if (pendingRelayOperation || pendingAcquisitionOperations.size)
        resources = Object.assign({}, resources, { contextId: record.contextId,
          pendingAcquisitionOperations: Array.from(pendingAcquisitionOperations) });
      if (pendingRelayOperation)
        resources = Object.assign({}, resources, { pendingRelayOperation: true, relayDisposition: "unknown" });
      if (dispatched) {
        resources = Object.assign({}, resources && typeof resources === "object" ? resources : {}, {
          contextId: record.contextId, method: method,
          disposition: created ? "retained" : "unknown",
        });
        if (created) resources.native = binding.client.safeResources(nativeResult);
        if (pending) resources.pendingNativeOperation = true;
      }
      return fail(code, resources, credential);
    }
    function remaining() {
      var left = deadline - now();
      if (retired || !Number.isFinite(left) || left <= 0) throw failure({ code: "NATIVE_HANDSHAKE_TIMEOUT" });
      return left;
    }
    function bounded(operation) {
      var timer, settled = false;
      var owned = Promise.resolve(operation);
      outstanding.add(owned);
      owned.then(function () { outstanding.delete(owned); }, function () { outstanding.delete(owned); });
      var left;
      try { left = remaining(); }
      catch (error) { retired = true; return Promise.reject(error); }
      return new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          settled = true; retired = true;
          reject(failure({ code: "NATIVE_HANDSHAKE_TIMEOUT" }));
        }, left);
        owned.then(function (value) {
          if (settled) return;
          settled = true; clearTimeout(timer);
          try { remaining(); resolve(value); } catch (error) { reject(error); }
        }, function (error) {
          if (settled) return;
          settled = true; clearTimeout(timer); reject(failure(error));
        });
      });
    }
    function route() {
      return { extension: true, browserName: "chromium", userDataDir: record.userDataDir,
        channel: record.channel, profileDirName: record.profileDirName, executablePath: selection.browserExecutable };
    }
    function waitFor(operation, stage) {
      pendingAcquisitionOperations.add(stage);
      var tracked = Promise.resolve(operation).then(function (value) {
        pendingAcquisitionOperations.delete(stage); return value;
      }, function (error) { pendingAcquisitionOperations.delete(stage); throw error; });
      return bounded(tracked);
    }
    function start(relay) {
      remaining();
      ownRelay = relay;
      pendingRelayOperation = true;
      // No cancellation claim: only settlement makes this exact relay closable.
      var operation = relay.start();
      var tracked = Promise.resolve(operation).then(function (value) {
        pendingRelayOperation = false; relaySettled = true;
        if (retired) closeSettledRelay();
        return value;
      }, function (error) {
        pendingRelayOperation = false; relaySettled = true;
        if (retired) closeSettledRelay();
        throw error;
      });
      return bounded(tracked);
    }
    function protectPaths(cdp, extension) {
      var match = /^\/cdp\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(cdp);
      if (!match || extension !== "/extension/" + match[1] || paths)
        throw failure({ code: "NATIVE_RELAY_ENDPOINT_INVALID" });
      credential.protect(process, match[1]);
      credential.protect(process, cdp);
      credential.protect(process, extension);
      paths = { cdp: cdp, extension: extension };
    }
    function protectEndpoints(cdp, extension) {
      credential.protect(process, cdp);
      credential.protect(process, extension);
      try {
        var c = new URLClass(cdp), e = new URLClass(extension);
        if (!paths || c.protocol !== "ws:" || e.protocol !== "ws:" ||
            ["127.0.0.1", "[::1]"].indexOf(c.hostname) === -1 || c.host !== e.host ||
            !c.port || Number(c.port) > 65535 || c.username || e.username || c.password || e.password ||
            c.search || e.search || c.hash || e.hash || c.pathname !== paths.cdp ||
            e.pathname !== paths.extension || c.href !== cdp || e.href !== extension)
          throw Error();
      } catch (error) { throw failure({ code: "NATIVE_RELAY_ENDPOINT_INVALID" }); }
      endpoints = { cdp: cdp, extension: extension };
    }
    function connect(endpoint) {
      return Promise.resolve().then(function () {
        remaining();
        if (attempted || !endpoints || endpoint !== endpoints.extension)
          throw failure({ code: "NATIVE_RELAY_ENDPOINT_INVALID" });
        attempted = true;
        // Recheck public code/capture after awaited attestation and before the
        // authority-bearing C request. C independently rechecks protected ready.
        credential.validateNativeBinding(record, route());
        remaining();
        dispatched = true;
        pending = true;
        // Approved C request() always returns its invoke() Promise for this
        // constant method/plain payload; failures settle through tracked below.
        var operation = client.request(method, { label: record.label, relayUrl: endpoint });
        var tracked = Promise.resolve(operation).then(function (result) {
          pending = false;
          if (!retired && result && result.contextId === record.contextId && result.state === "ready" &&
              result.pendingEffects === 0 && Number.isSafeInteger(result.groupId) &&
              Array.isArray(result.tabs) && result.tabs.length &&
              result.tabs.every(function (tab) { return tab && Number.isSafeInteger(tab.tabId) && tab.tabId >= 0 &&
                Number.isSafeInteger(tab.windowId) && tab.windowId >= 0; })) {
            created = true; nativeResult = result;
          } else if (!retired) throw failure({ code: "NATIVE_PROVIDER_RESPONSE_INVALID" });
          return result;
        }, function (error) { pending = false; throw failure(error); });
        return bounded(tracked);
      }).catch(function (error) { throw failure(error); });
    }
    var acquisition = Object.freeze({ deadline: deadline, protectPaths: protectPaths, protectEndpoints: protectEndpoints,
      connect: connect, failure: failure, retire: retire, start: start, waitFor: waitFor });
    remaining();
    credential.validateNativeBinding(record, route());
    remaining();
    // The genuine C call has exactly two arguments. No test dependency, update,
    // refresh, cancellation, installer/provider or alternate module is supplied.
    return bounded(binding.client.attestNativeContext(record, selection)).then(function (attested) {
      client = attested;
      binding.retain(acquisition);
      return acquisition;
    });
  });
}

module.exports = { initialize: initialize };
