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
  function refusal(code) {
    var error = new Error(code);
    error.code = code;
    return error;
  }
  function payload() {
    if (!acquired || released) throw new Error("browser_native_session_unavailable");
    return { leaseId: acquired.leaseId, owner: owner };
  }
  return {
    setOwner: function (name) {
      if (typeof name !== "string" || !name.trim() || name.length > 160 || /[\x00-\x1f\x7f]/.test(name)) return Promise.reject(new Error("browser_owner_identity_missing"));
      if (owner !== null && owner !== name) return Promise.reject(new Error("browser_owner_identity_conflict"));
      if (acquired) return Promise.resolve(acquired);
      if (acquiring) return acquiring;
      owner = name;
      acquiring = request("acquire", { owner: name }).then(function (result) {
        if (!result || typeof result.leaseId !== "string" || typeof result.endpoint !== "string" || result.owner !== owner) {
          throw new Error("NATIVE_ACQUIRE_RESPONSE_INVALID");
        }
        acquired = result;
        return acquired;
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
    resume: function () {
      var current = payload();
      if (!options.readyFile) return Promise.resolve({ changed: false, endpoint: acquired.endpoint });
      if (resuming) return resuming;
      var fs = require("fs").promises;
      resuming = fs.lstat(options.readyFile).then(function (info) {
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
        return providerRequest(ready.endpoint, "attest", { expectedProcessIdentity: options.processIdentity }).then(function (attested) {
          if (!attested || attested.healthy !== true || ["pid", "startIdentity", "owner", "executable", "profileRoot"].some(function (key) {
            return !attested.processIdentity || attested.processIdentity[key] !== options.processIdentity[key];
          })) throw refusal("NATIVE_MEDIATOR_UNAVAILABLE");
          if (ready.endpoint === providerEndpoint) return { changed: false, endpoint: acquired.endpoint };
          return providerRequest(ready.endpoint, "resume", Object.assign({}, current,
            { expectedProcessIdentity: options.processIdentity })).then(function (restored) {
            if (!restored || restored.leaseId !== current.leaseId || restored.owner !== current.owner ||
                typeof restored.endpoint !== "string") throw refusal("NATIVE_RESUME_RESPONSE_INVALID");
            providerEndpoint = ready.endpoint;
            acquired = Object.assign({}, acquired, { endpoint: restored.endpoint });
            return { changed: true, endpoint: acquired.endpoint };
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
