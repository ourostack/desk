// Private native capability boundary. Ordinary require is dependency-light and
// old-Node parseable; no provider, installer, browser or asset work at load time.
"use strict";
var fs = require("fs");
var path = require("path");
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var HEX = /^[a-f0-9]{64}$/;
var MAX = 1048576;
var CODES = ("NATIVE_CONFIG_INVALID NATIVE_PRIVATE_PATH_INVALID NATIVE_PRIVATE_STATE_CHANGED NATIVE_PRIVATE_STATE_INVALID " +
  "NATIVE_PROVIDER_ENDPOINT_INVALID NATIVE_REQUEST_INVALID NATIVE_REQUEST_TOO_LARGE NATIVE_RESPONSE_TOO_LARGE " +
  "NATIVE_PROVIDER_TIMEOUT NATIVE_PROVIDER_DISCONNECTED NATIVE_PROVIDER_RESPONSE_TOO_LARGE NATIVE_PROVIDER_RESPONSE_INVALID " +
  "NATIVE_PROVIDER_REQUEST_FAILED NATIVE_PROVIDER_REQUEST_REFUSED NATIVE_PROVIDER_START_FAILED NATIVE_PROVIDER_LISTEN_FAILED " +
  "NATIVE_SELECTION_MISMATCH NATIVE_READY_INVALID NATIVE_READY_CHANGED NATIVE_ANCESTRY_MISMATCH NATIVE_ATTESTATION_MISMATCH NATIVE_ATTESTATION_UNAVAILABLE " +
  "NATIVE_PROFILE_MISMATCH NATIVE_PROFILE_TOKEN_UNAVAILABLE NATIVE_EXTENSION_SOURCE_MISMATCH NATIVE_PROTOCOL_MISMATCH " +
  "NATIVE_TRANSPORT_DISCONNECTED NATIVE_OWNER_INVALID NATIVE_OWNER_BINDING_MISMATCH NATIVE_INVENTORY_INVALID NATIVE_CLI_UNSUPPORTED " +
  "NATIVE_UPDATE_IN_PROGRESS NATIVE_CONTINUITY_UNKNOWN NATIVE_UPDATE_OWNERS_UNSETTLED NATIVE_UPDATE_TICKET_INVALID " +
  "NATIVE_UPDATE_TICKET_EXPIRED NATIVE_UPDATE_EVIDENCE_CHANGED NATIVE_UPDATE_PREPARED_OBLIGATION NATIVE_REQUEST_FAILED " +
  "NATIVE_REQUEST_TIMEOUT NATIVE_SEND_FAILED NATIVE_RESPONSE_INVALID NATIVE_QUEUE_FULL NATIVE_CONTEXT_UNCONFIRMED " +
  "native_browser_operation_failed native_cdp_method_denied native_cleanup_unconfirmed native_close_unconfirmed native_discard_incomplete " +
  "native_context_busy native_context_duplicate native_context_create_failed native_context_ownership_changed native_context_parameters_invalid native_context_unavailable " +
  "native_debugger_cleanup_unconfirmed native_debugger_custody_busy native_extension_stopped native_group_custody_unknown native_group_not_owned native_group_unconfirmed " +
  "native_inactive_tab_unconfirmed native_normal_window_unavailable native_opener_admission_failed native_profile_mismatch native_profile_token_invalid " +
  "native_relay_request_invalid native_relay_unavailable native_session_not_owned native_source_mismatch native_tab_admission_failed " +
  "native_target_not_owned native_target_unavailable native_token_document_invalid native_transport_disconnected native_update_effects_pending native_update_pending " +
  "native_update_token_invalid native_request_invalid native_request_busy native_operation_failed native_task_create_failed native_method_denied").split(" ");
var FIELDS = ["version", "contextId", "label", "channel", "userDataDir", "profileDirName", "nativeReadyFile", "extensionId", "sourceDigest"];
function safeCode(code, fallback) { return CODES.indexOf(code) === -1 ? fallback : code; }
function safeResources(value, depth) {
  depth = depth || 0;
  if (depth > 16) return "<bounded>";
  if (typeof value === "string") return value.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<redacted-url>")
    .replace(/[a-f0-9]{64,}/gi, "<redacted>").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 4096);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(function (v) { return safeResources(v, depth + 1); });
  if (object(value)) {
    var out = {};
    Object.keys(value).forEach(function (k) { Object.defineProperty(out, safeResources(k, depth + 1),
      { value: safeResources(value[k], depth + 1), enumerable: true, writable: true, configurable: true }); });
    return out;
  }
  return undefined;
}
function failure(code, resources) {
  var e = new Error(code);
  e.code = code;
  if (resources !== undefined) e.resources = resources;
  return e;
}
function object(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function text(v) { return typeof v === "string" && !/[\x00-\x1f\x7f]/.test(v); }
function absolute(v) { return text(v) && path.isAbsolute(v); }
function validateNativeRecord(record) {
  if (!object(record) || Object.keys(record).length !== FIELDS.length ||
      Object.keys(record).some(function (key) { return FIELDS.indexOf(key) === -1; }) ||
      record.version !== 1 || typeof record.contextId !== "string" || !UUID.test(record.contextId) ||
      !text(record.label) || !record.label.trim() || record.label.length > 120 ||
      ["msedge", "chrome"].indexOf(record.channel) === -1 ||
      !absolute(record.userDataDir) || !absolute(record.nativeReadyFile) ||
      !text(record.profileDirName) || !record.profileDirName || /^[.]{1,2}$/.test(record.profileDirName) ||
      /[\\/]/.test(record.profileDirName) || typeof record.extensionId !== "string" || !/^[a-p]{32}$/.test(record.extensionId) ||
      typeof record.sourceDigest !== "string" || !HEX.test(record.sourceDigest)) throw failure("NATIVE_CONFIG_INVALID");
  return record;
}
// Read-only counterpart of the existing Go entry's private-config checks.
// Do not call the repairing Windows protection primitive during inventory.
function privatePath(file, directory, strict) {
  try {
    var stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1)) ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (strict !== false && process.platform !== "win32" && (stat.mode & 63) !== 0)) throw failure("NATIVE_PRIVATE_PATH_INVALID");
    if (process.platform === "darwin" && strict !== false) {
      var acl = require("child_process").execFileSync("/bin/ls", ["-ldeq", file],
        { encoding: "utf8", timeout: 5000, maxBuffer: 16384 });
      if (/^\s*\d+:/m.test(acl)) throw failure("NATIVE_PRIVATE_PATH_INVALID");
    }
    if (process.platform === "win32" && strict !== false) {
      var root = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir || process.env.WINDIR;
      if (!root || !path.win32.isAbsolute(root)) throw failure("NATIVE_PRIVATE_PATH_INVALID");
      var script = "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;" +
        "$i=Get-Item -LiteralPath $p -Force;$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;" +
        "if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){exit 2};" +
        "$a=$i.GetAccessControl('Access,Owner');if($a.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $s -or -not $a.AreAccessRulesProtected){exit 2};" +
        "$r=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));" +
        "if($r.Count -ne 1 -or $r[0].IdentityReference -ne $s -or $r[0].AccessControlType -ne 'Allow' -or " +
        "($r[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl){exit 2};[Console]::Out.Write('private')";
      var out = require("child_process").execFileSync(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { input: JSON.stringify(file), encoding: "utf8", timeout: 5000, maxBuffer: 16384, windowsHide: true });
      if (out !== "private") throw failure("NATIVE_PRIVATE_PATH_INVALID");
    }
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw failure("NATIVE_PRIVATE_PATH_INVALID");
  }
}
function ownedTree(file, anchor) {
  if (!absolute(file) || !absolute(anchor)) throw failure("NATIVE_PRIVATE_PATH_INVALID");
  var relative = path.relative(anchor, file);
  if (relative === ".." || relative.indexOf(".." + path.sep) === 0 || path.isAbsolute(relative)) throw failure("NATIVE_PRIVATE_PATH_INVALID");
  privatePath(anchor, true);
  var parts = relative.split(path.sep).filter(Boolean), current = anchor;
  parts.forEach(function (part, i) {
    current = path.join(current, part);
    privatePath(current, i !== parts.length - 1, false);
  });
}
function fileIdentity(file) {
  var s = fs.lstatSync(file, { bigint: true });
  return String(s.dev) + ":" + String(s.ino);
}
function readPrivateJson(file, options) {
  options = options || {};
  if (options.anchor) ownedTree(file, options.anchor);
  else { privatePath(path.dirname(file), true); privatePath(file, false); }
  var before = fileIdentity(file), fd;
  try {
    fd = fs.openSync(file, "r");
    var opened = fs.fstatSync(fd, { bigint: true });
    if (before !== String(opened.dev) + ":" + String(opened.ino) || opened.size > BigInt(options.maxBytes || 65536))
      throw failure("NATIVE_PRIVATE_STATE_CHANGED");
    var bytes = fs.readFileSync(fd);
    if (bytes.length > (options.maxBytes || 65536) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
      throw failure("NATIVE_PRIVATE_STATE_INVALID");
    var value = JSON.parse(bytes.toString("utf8"));
    if (!object(value) || fileIdentity(file) !== before) throw failure("NATIVE_PRIVATE_STATE_CHANGED");
    return value;
  } catch (error) {
    throw failure(error.code === "NATIVE_PRIVATE_STATE_CHANGED" ? error.code : "NATIVE_PRIVATE_STATE_INVALID");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function endpointParts(endpoint) {
  var match = typeof endpoint === "string" && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(\/provider\/([a-f0-9]{64}))$/.exec(endpoint);
  if (!match || Number(match[1]) > 65535) throw failure("NATIVE_PROVIDER_ENDPOINT_INVALID");
  return { port: Number(match[1]), path: match[2], capability: match[3] };
}
var diagnosticProcess;
function protect(endpoint, capability) {
  // HTTP internals/debug write diagnostics to stderr. Never wrap protocol or
  // binary stdout (native frames, MCP/test IPC); E owns streamed output work.
  if (!diagnosticProcess) diagnosticProcess = { stdout: { write: function () {
    return process.stderr.write.apply(process.stderr, arguments);
  } }, stderr: process.stderr };
  var hook = require("./web-extension-credential.cjs").protect;
  hook(diagnosticProcess, endpoint); hook(diagnosticProcess, capability);
}
function providerRequest(endpoint, operation, payload, options) {
  return Promise.resolve().then(function () {
    var parts = endpointParts(endpoint), timeout = options && options.timeoutMs || 10000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60000 ||
        ["attest", "dispatch", "prepareUpdate", "cancelUpdate", "reload", "commit"].indexOf(operation) === -1 || !object(payload))
      throw failure("NATIVE_REQUEST_INVALID");
    var unknown = { disposition: "unknown", operation: operation };
    if (operation === "dispatch" && typeof payload.contextId === "string" && UUID.test(payload.contextId)) {
      unknown.contextId = payload.contextId;
      if (/^context\.(create|resume|status|label|discard)$/.test(payload.method || "")) unknown.method = payload.method;
    }
    var data;
    try { data = JSON.stringify({ operation: operation, payload: payload }); } catch (error) { throw failure("NATIVE_REQUEST_INVALID"); }
    if (Buffer.byteLength(data) > MAX) throw failure("NATIVE_REQUEST_TOO_LARGE");
    protect(endpoint, parts.capability);
    return new Promise(function (resolve, reject) {
      var done = false, request, response, chunks = [], size = 0;
      function finish(error, result) {
        if (done) return; done = true;
        clearTimeout(timer);
        if (error) { if (response) response.destroy(); if (request) request.destroy(); reject(error); }
        else resolve(result);
      }
      var timer = setTimeout(function () { finish(failure("NATIVE_PROVIDER_TIMEOUT", unknown)); }, timeout);
      try {
        request = require("http").request({ hostname: "127.0.0.1", port: parts.port, path: parts.path, method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, function (incoming) {
          response = incoming;
          incoming.on("error", function () { finish(failure("NATIVE_PROVIDER_DISCONNECTED", unknown)); });
          incoming.on("aborted", function () { finish(failure("NATIVE_PROVIDER_DISCONNECTED", unknown)); });
          incoming.on("data", function (bytes) {
            size += bytes.length;
            if (size > MAX) finish(failure("NATIVE_PROVIDER_RESPONSE_TOO_LARGE", unknown));
            else chunks.push(bytes);
          });
          incoming.on("end", function () {
            if (done) return;
            var value, bytes = Buffer.concat(chunks);
            try {
              if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) throw Error();
              value = JSON.parse(bytes.toString("utf8"));
            } catch (error) { finish(failure("NATIVE_PROVIDER_RESPONSE_INVALID", unknown)); return; }
            if (!object(value) || typeof value.ok !== "boolean") { finish(failure("NATIVE_PROVIDER_RESPONSE_INVALID")); return; }
            if (incoming.statusCode !== 200 || !value.ok) {
              var code = value.error && value.error.code;
              code = safeCode(code, "NATIVE_PROVIDER_REQUEST_FAILED");
              finish(failure(code, safeResources(value.error && value.error.resources)));
            } else finish(null, value.result);
          });
        });
        request.on("error", function () { finish(failure("NATIVE_PROVIDER_DISCONNECTED", unknown)); });
        request.end(data);
      } catch (error) { finish(failure("NATIVE_PROVIDER_DISCONNECTED", unknown)); }
    });
  });
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sameProcess(a, b) {
  return ["pid", "parentPid", "startIdentity", "owner", "executable"].every(function (key) { return a && b && a[key] === b[key]; });
}
function attestNativeContext(record, selection, dependencies) {
  return Promise.resolve().then(function () {
    validateNativeRecord(record);
    record = Object.freeze(JSON.parse(JSON.stringify(record)));
    selection = selection && JSON.parse(JSON.stringify(selection));
    if (!object(selection) || ["channel", "userDataDir", "profileDirName", "nativeReadyFile", "extensionId", "sourceDigest"].some(function (k) {
      return selection[k] !== record[k];
    })) throw failure("NATIVE_SELECTION_MISMATCH");
    var binding, identity, ticket;
    function readReady() {
      var ready = readPrivateJson(record.nativeReadyFile);
      if (ready.version !== 1 || !UUID.test(ready.generation || "") || ready.profileRoot !== path.join(record.userDataDir, record.profileDirName) ||
          ready.extensionId !== record.extensionId || ready.sourceDigest !== record.sourceDigest ||
          !Array.isArray(ready.chain) || ready.chain.length !== 3 || !sameProcess(ready.browser, ready.chain[2]) ||
          ready.browser.executable !== selection.browserExecutable) throw failure("NATIVE_READY_INVALID");
      endpointParts(ready.endpoint);
      return ready;
    }
    function ancestry(ready) {
      if (dependencies && dependencies.readAncestry) return dependencies.readAncestry(ready.chain[0].pid);
      // Fixed shipped module, never a caller's module path / source-cache pin.
      return new Function("url", "return import(url)")(require("url").pathToFileURL(path.join(__dirname, "src/browser/native-host.mjs")).href)
        .then(function (host) { return host.readNativeAncestry(ready.chain[0].pid); });
    }
    function corroborate(refresh) {
      var ready, candidateIdentity;
      try {
        ready = readReady();
        candidateIdentity = fileIdentity(record.nativeReadyFile);
        if (identity && !refresh && fileIdentity(record.nativeReadyFile) !== identity) throw failure("NATIVE_READY_CHANGED");
        if (binding && (!sameProcess(ready.browser, binding.browser) || ready.profileRoot !== binding.profileRoot ||
            ready.sourceDigest !== binding.sourceDigest)) throw failure("NATIVE_SELECTION_MISMATCH");
      } catch (error) { return Promise.reject(error); }
      return ancestry(ready).then(function (current) {
        if (!Array.isArray(current) || current.length !== 3 || current.some(function (p, i) { return !sameProcess(p, ready.chain[i]); }))
          throw failure("NATIVE_ANCESTRY_MISMATCH");
        return providerRequest(ready.endpoint, "attest", {}).then(function (result) {
          if (!result || result.healthy !== true || result.generation !== ready.generation ||
              result.profileRoot !== ready.profileRoot || result.extensionId !== record.extensionId ||
              result.sourceDigest !== record.sourceDigest || !same(result.chain, ready.chain))
            throw failure("NATIVE_ATTESTATION_MISMATCH");
          if (fileIdentity(record.nativeReadyFile) !== candidateIdentity)
            throw failure("NATIVE_READY_CHANGED");
          binding = ready; identity = fileIdentity(record.nativeReadyFile);
        });
      });
    }
    function invoke(operation, payload) {
      return Promise.resolve().then(function () {
        if (!binding || fileIdentity(record.nativeReadyFile) !== identity) throw failure("NATIVE_READY_CHANGED");
        return providerRequest(binding.endpoint, operation, payload);
      }).catch(function (error) { throw failure(safeCode(error.code, "NATIVE_ATTESTATION_UNAVAILABLE"), safeResources(error.resources)); });
    }
    return corroborate(false).then(function () {
      return Object.freeze({
        contextId: record.contextId,
        refresh: function () { return corroborate(true).then(function () { return { available: true, contextId: record.contextId }; })
          .catch(function (error) { throw failure(safeCode(error.code, "NATIVE_ATTESTATION_UNAVAILABLE"), safeResources(error.resources)); }); },
        request: function (method, params) {
          if (!/^context\.(create|resume|status|label|discard)$/.test(method || "")) return Promise.reject(failure("NATIVE_REQUEST_INVALID"));
          return invoke("dispatch", { contextId: record.contextId, method: method, params: params || {} });
        },
        prepareUpdate: function () { return invoke("prepareUpdate", {}).then(function (result) {
          if (!result || !HEX.test(result.ticket || "") || !Number.isSafeInteger(result.expiresAt)) throw failure("NATIVE_PROVIDER_RESPONSE_INVALID");
          ticket = result.ticket; protect(binding.endpoint, ticket); return { quiescent: true };
        }); },
        cancelUpdate: function () { return invoke("cancelUpdate", { ticket: ticket }).then(function () { ticket = undefined; return { cancelled: true }; }); },
        reload: function () { return invoke("reload", { ticket: ticket }); },
        commit: function () { return invoke("commit", { ticket: ticket }); },
        withUpdateTicket: function (callback) {
          if (typeof callback !== "function" || !HEX.test(ticket || "")) throw failure("NATIVE_UPDATE_TICKET_INVALID");
          return callback(ticket);
        },
      });
    });
  }).catch(function (error) { throw failure(safeCode(error.code, "NATIVE_ATTESTATION_UNAVAILABLE"), safeResources(error.resources)); });
}
module.exports = {
  validateNativeRecord: validateNativeRecord, privatePath: privatePath, ownedTree: ownedTree,
  readPrivateJson: readPrivateJson, fileIdentity: fileIdentity, endpointParts: endpointParts,
  safeCode: safeCode, safeResources: safeResources,
  providerRequest: providerRequest, attestNativeContext: attestNativeContext
};
