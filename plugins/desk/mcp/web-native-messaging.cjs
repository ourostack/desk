"use strict";

var assets = require("./web-native-artifacts.cjs").artifactFamily("browser-messaging",
  ["go.mod", "main.go", "private_unix.go", "private_windows.go"]);

function providerRequest(endpoint, operation, payload) {
  return new Promise(function (resolve, reject) {
    var http = require("http");
    var parsed = require("url").parse(endpoint);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
        !/^\/provider\/[a-f0-9]{64}$/.test(parsed.pathname) || parsed.auth || parsed.search) {
      reject(new Error("NATIVE_PROVIDER_ENDPOINT_INVALID"));
      return;
    }
    var data = JSON.stringify({ operation: operation, payload: payload });
    var request = http.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.path,
      method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, function (response) {
      var chunks = [];
      var size = 0;
      response.on("data", function (bytes) {
        size += bytes.length;
        if (size > 1048576) { response.destroy(new Error("NATIVE_RESPONSE_TOO_LARGE")); return; }
        chunks.push(bytes);
      });
      response.on("error", reject);
      response.on("end", function () {
        var value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch (error) { reject(new Error("NATIVE_PROVIDER_RESPONSE_INVALID")); return; }
        if (response.statusCode !== 200 || value.ok !== true) {
          var error = new Error(value.error && value.error.code || "NATIVE_PROVIDER_REQUEST_FAILED");
          error.code = value.error && value.error.code || "NATIVE_PROVIDER_REQUEST_FAILED";
          reject(error);
          return;
        }
        resolve(value.result);
      });
    });
    request.setTimeout(30000, function () { request.destroy(new Error("NATIVE_PROVIDER_TIMEOUT")); });
    request.on("error", reject);
    request.end(data);
  });
}

function createNativeSession(options) {
  var providerEndpoint = options.endpoint;
  var acquired = null;
  var acquiring = null;
  var owner = null;
  var released = false;
  var releasing = null;
  var clearing = null;
  var resuming = null;
  var request = options.request || function (operation, payload) { return providerRequest(providerEndpoint, operation, payload); };
  var readyWaitMs = options.readyWaitMs === undefined ? 15000 : options.readyWaitMs;
  var readyPollMs = options.readyPollMs === undefined ? 250 : options.readyPollMs;
  var ownStart = null;
  function refusal(code) {
    var error = new Error(code);
    error.code = code;
    return error;
  }
  function payload() {
    if (!acquired || released) throw new Error("browser_native_session_unavailable");
    return { leaseId: acquired.leaseId, owner: owner };
  }
  // This process's start as the operating system reports it; the provider records this session's process only when it reads the
  // same start, and later releases the lease once that process is gone.
  function ownerProcess() {
    if (!ownStart) {
      ownStart = Promise.resolve().then(function () {
        return options.readOwnStart ? options.readOwnStart(process.pid)
          : import("./src/readiness/process-start.js").then(function (module) { return module.readProcessStart(process.pid); });
      }).then(null, function () { return null; });
    }
    return ownStart.then(function (start) {
      return typeof start === "string" ? { ownerPid: process.pid, ownerStart: start } : { ownerPid: process.pid };
    });
  }
  function notRunning(cause) {
    var missing = refusal("browser_native_provider_not_running");
    var code = cause && (cause.code || cause.message);
    missing.message = "The native browser provider is not running: its readiness file " + options.readyFile +
      (!code || code === "ENOENT" ? " is missing." : " is present, but the provider does not answer (" + code + ").");
    missing.readyFile = options.readyFile;
    return missing;
  }
  // The provider writes its readiness file once it is up and removes it when it stops. The browser starts a new provider as soon
  // as its extension reconnects, so a missing file is waited for, up to readyWaitMs, before the provider is named as not running.
  function readReady() {
    var fs = require("fs").promises;
    var deadline = Date.now() + readyWaitMs;
    function attempt() {
      return fs.lstat(options.readyFile).then(null, function (failure) {
        if (!failure || failure.code !== "ENOENT") throw failure;
        if (Date.now() >= deadline) throw notRunning();
        return new Promise(function (resolve) { setTimeout(resolve, readyPollMs); }).then(attempt);
      });
    }
    return attempt().then(function (info) {
      if (!info.isFile() || info.nlink !== 1 || info.size > 16384 ||
          (process.platform !== "win32" && ((info.mode & 63) !== 0 || info.uid !== process.getuid()))) {
        throw refusal("NATIVE_READINESS_NOT_PRIVATE");
      }
      return fs.readFile(options.readyFile, "utf8");
    }).then(function (text) {
      var ready = JSON.parse(text);
      if (ready.version !== 1 || ["pid", "startIdentity", "owner", "executable", "profileRoot"].some(function (key) {
        return !options.processIdentity || ready.processIdentity[key] !== options.processIdentity[key];
      })) throw refusal("NATIVE_BROWSER_GENERATION_MISMATCH");
      if (!/^[a-f0-9]{64}$/.test(options.extensionSourceDigest || "") ||
          ready.extensionSourceDigest !== options.extensionSourceDigest) {
        throw refusal("NATIVE_EXTENSION_SOURCE_MISMATCH");
      }
      var lease = acquired && !released ? { leaseId: acquired.leaseId, owner: owner } : {};
      return providerRequest(ready.endpoint, "attest", Object.assign({ expectedProcessIdentity: options.processIdentity }, lease)).then(function (attested) {
        if (!attested || attested.healthy !== true || ["pid", "startIdentity", "owner", "executable", "profileRoot"].some(function (key) {
          return !attested.processIdentity || attested.processIdentity[key] !== options.processIdentity[key];
        })) throw refusal("NATIVE_MEDIATOR_UNAVAILABLE");
        return { endpoint: ready.endpoint, leaseBound: attested.leaseBound };
      });
    });
  }
  // A provider that stopped between its readiness file and the request is waited for once more, then named as not running.
  function withProvider(step) {
    return step().then(null, function (error) {
      if (!error || ["ENOENT", "ECONNREFUSED", "ECONNRESET", "NATIVE_PROVIDER_TIMEOUT", "browser_native_provider_not_running"]
        .indexOf(error.code || error.message) === -1) throw error;
      return step().then(null, function (again) {
        if (again && ["ENOENT", "ECONNREFUSED", "ECONNRESET", "NATIVE_PROVIDER_TIMEOUT"].indexOf(again.code || again.message) !== -1) {
          throw notRunning(again);
        }
        throw again;
      });
    });
  }
  function acquireAt(endpoint) {
    return ownerProcess().then(function (session) {
      return (options.request ? request : function (operation, input) { return providerRequest(endpoint, operation, input); })(
        "acquire", Object.assign({ owner: owner }, session));
    }).then(function (result) {
      if (!result || typeof result.leaseId !== "string" || typeof result.endpoint !== "string" || result.owner !== owner) {
        throw new Error("NATIVE_ACQUIRE_RESPONSE_INVALID");
      }
      providerEndpoint = endpoint;
      acquired = result;
      return acquired;
    });
  }
  return {
    setOwner: function (name) {
      if (typeof name !== "string" || !name.trim() || name.length > 160 || /[\x00-\x1f\x7f]/.test(name)) return Promise.reject(new Error("browser_owner_identity_missing"));
      if (owner !== null && owner !== name) return Promise.reject(new Error("browser_owner_identity_conflict"));
      if (acquired) return Promise.resolve(acquired);
      if (acquiring) return acquiring;
      owner = name;
      // A lease is taken through the provider running now, which may not be the one that was running when the session connected.
      acquiring = (options.readyFile ? withProvider(function () {
        return readReady().then(function (ready) { return acquireAt(ready.endpoint); });
      }) : acquireAt(providerEndpoint)).then(function (result) {
        acquiring = null;
        return result;
      }, function (error) {
        acquiring = null;
        throw error;
      });
      return acquiring;
    },
    environment: function () {
      var current = payload();
      return { DESK_NATIVE_LEASE_ID: current.leaseId, DESK_BROWSER_OWNER: current.owner, DESK_NATIVE_PROVIDER_URL: providerEndpoint };
    },
    secrets: function () {
      var endpoints = [providerEndpoint].concat(acquired ? [acquired.endpoint] : []);
      return endpoints.concat(endpoints.map(function (endpoint) {
        return require("url").parse(endpoint).pathname.split("/").filter(Boolean).pop();
      }).filter(function (value) { return typeof value === "string" && value.length >= 32; }));
    },
    // Moves the session to the provider running now. A lease that provider no longer holds (released after its session looked
    // gone, or not restorable) is replaced by a new one for the same owner, so the session carries on instead of failing.
    resume: function () {
      var current = payload();
      if (!options.readyFile) return Promise.resolve({ changed: false, endpoint: acquired.endpoint });
      if (resuming) return resuming;
      function replace(endpoint) {
        acquired = null;
        return acquireAt(endpoint).then(function (result) { return { changed: true, endpoint: result.endpoint }; });
      }
      resuming = withProvider(function () {
        return readReady().then(function (ready) {
          if (ready.leaseBound === false) return replace(ready.endpoint);
          if (ready.endpoint === providerEndpoint) return { changed: false, endpoint: acquired.endpoint };
          return providerRequest(ready.endpoint, "resume", Object.assign({}, current,
            { expectedProcessIdentity: options.processIdentity })).then(function (restored) {
            if (!restored || restored.leaseId !== current.leaseId || restored.owner !== current.owner ||
                typeof restored.endpoint !== "string") throw refusal("NATIVE_RESUME_RESPONSE_INVALID");
            providerEndpoint = ready.endpoint;
            acquired = Object.assign({}, acquired, { endpoint: restored.endpoint });
            return { changed: true, endpoint: acquired.endpoint };
          }, function (error) {
            if (error && error.code === "NATIVE_LEASE_OWNER_MISMATCH") return replace(ready.endpoint);
            throw error;
          });
        });
      }).then(function (result) {
        resuming = null;
        return result;
      }, function (error) {
        resuming = null;
        throw error;
      });
      return resuming;
    },
    ensureWindow: function (operation) {
      if (releasing) throw new Error("browser_native_session_unavailable");
      var current = payload();
      return Promise.resolve(clearing).then(function () {
        if (operation && operation.cancelled) return null;
        if (releasing || released) throw new Error("browser_native_session_unavailable");
        return request("ensureWindow", current);
      });
    },
    clear: function (detach) {
      if (clearing) return clearing;
      var current = payload();
      clearing = Promise.resolve().then(detach).then(function () { return request("clear", current); }).then(function (result) {
        clearing = null;
        if (!result || result.cleared !== true) throw new Error("PARTIAL_CLEAR");
        return result;
      }, function (error) { clearing = null; throw error; });
      return clearing;
    },
    release: function () {
      if (released || (!acquired && !acquiring)) return Promise.resolve({ released: true });
      if (releasing) return releasing;
      var session = this;
      releasing = Promise.resolve(acquiring).then(function () { return clearing; }).then(function () {
        return options.readyFile ? session.resume() : null;
      }).then(function () {
        return request("release", payload());
      }).then(function (result) {
        if (!result || result.released !== true) throw new Error("PARTIAL_RELEASE");
        released = true;
        return result;
      }, function (error) { releasing = null; throw error; });
      return releasing;
    }
  };
}

function prepareNativeMessaging(options) {
  var path = require("path");
  var input = {};
  Object.keys(options).forEach(function (key) {
    if (typeof options[key] !== "function") input[key] = options[key];
  });
  return new Promise(function (resolve, reject) {
    require("child_process").execFile(options.runtimeExecutable,
      [path.join(options.mcpRoot, "native-messaging-prepare.mjs")],
      { encoding: "utf8", maxBuffer: 1048576, timeout: 30000, windowsHide: true },
      function (error, stdout, stderr) {
        if (error) {
          var code = typeof stderr === "string" && /^[A-Z][A-Z0-9_]{0,79}\n?$/.test(stderr.trim()) ? stderr.trim() : "NATIVE_PREPARE_FAILED";
          var refusal = new Error(code);
          refusal.code = code;
          reject(refusal);
          return;
        }
        var result;
        try { result = JSON.parse(stdout); }
        catch (failure) { reject(new Error("NATIVE_PREPARE_RESPONSE_INVALID")); return; }
        if (!result.payload && result.updated !== true) result.session = createNativeSession({
          endpoint: result.providerEndpoint, readyFile: result.readyFile,
          processIdentity: result.processIdentity, extensionSourceDigest: result.extensionSourceDigest
        });
        resolve(result);
      }).stdin.end(JSON.stringify(input));
  });
}

module.exports = Object.assign(assets, {
  createNativeSession: createNativeSession, providerRequest: providerRequest, prepareNativeMessaging: prepareNativeMessaging
});
