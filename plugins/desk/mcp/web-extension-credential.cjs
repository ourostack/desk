"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");

var EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
var BINDING_KEY = "DESK_BROWSER_PROFILE_DIR";
var STREAM_KEY = "__desk_text_protection_v3__";
var MAX_ENCODED_SECRET_FORM_BYTES = 65536;
var MASK = Buffer.from("<token>");

function protectionError(code) {
  var error = new Error(code);
  error.code = code;
  return error;
}
function states(proc) {
  return [proc.stdout, proc.stderr].filter(function (stream, index, all) {
    return stream && all.indexOf(stream) === index;
  }).map(function (stream) { return stream[STREAM_KEY]; }).filter(Boolean);
}
function notify(state) {
  if (!state.failure && (state.pending || state.blocked)) return;
  state.waiters.splice(0).forEach(function (waiter) {
    clearTimeout(waiter.timer);
    if (state.failure) waiter.reject(protectionError("TEXT_PROTECTION_SINK_ERROR"));
    else waiter.resolve();
  });
}
function forward(state, bytes) {
  if (!bytes.length) return true;
  var completed = false;
  state.pending++;
  function done(error) {
    if (completed) return;
    completed = true;
    state.pending--;
    if (error) state.failure = true;
    notify(state);
  }
  try {
    var result = state.original.call(state.stream, bytes, done);
    state.blocked = state.blocked || result === false;
    // Simple synchronous text sinks retain the existing protect() contract.
    // Actual Writable/EventEmitter streams require their real completion.
    if (typeof state.stream.on !== "function" && result !== false) done();
    return result;
  } catch (error) {
    done(error);
    throw protectionError("TEXT_PROTECTION_SINK_ERROR");
  }
}
function transform(state, bytes) {
  var offset = 0;
  while (state.quarantine.length && offset < bytes.length) {
    var next = state.quarantine.filter(function (candidate) {
      return candidate.form[candidate.offset] === bytes[offset];
    });
    if (!next.length) { state.quarantine = []; break; }
    offset++;
    state.quarantine = next.map(function (candidate) {
      return { form: candidate.form, offset: candidate.offset + 1 };
    }).filter(function (candidate) { return candidate.offset < candidate.form.length; });
  }
  var data = Buffer.concat([state.tail, bytes.subarray(offset)]), output = [], start = 0, pos = 0;
  state.tail = Buffer.alloc(0);
  while (pos < data.length) {
    var available = data.length - pos, match = null, partial = false;
    state.forms.forEach(function (form) {
      if (form[0] !== data[pos]) return;
      if (available < form.length) {
        if (form.subarray(0, available).equals(data.subarray(pos))) partial = true;
      } else if (!match && form.equals(data.subarray(pos, pos + form.length))) match = form;
    });
    if (partial) {
      output.push(data.subarray(start, pos));
      state.tail = Buffer.from(data.subarray(pos));
      return Buffer.concat(output);
    }
    if (match) {
      output.push(data.subarray(start, pos), match.mask);
      pos += match.length;
      start = pos;
    } else pos++;
  }
  output.push(data.subarray(start));
  return Buffer.concat(output);
}
function decorate(stream) {
  if (stream[STREAM_KEY]) return stream[STREAM_KEY];
  var state = { stream: stream, original: stream.write, forms: [], textForms: [], tail: Buffer.alloc(0),
    quarantine: [], pending: 0, blocked: false, failure: false, waiters: [] };
  Object.defineProperty(stream, STREAM_KEY, { value: state });
  if (typeof stream.on === "function") {
    stream.on("drain", function () { state.blocked = false; notify(state); });
    stream.on("error", function () { state.failure = true; notify(state); });
  }
  stream.write = function (chunk, encoding, callback) {
    if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
    if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk))
      return state.original.apply(stream, arguments);
    function acknowledge(error) {
      if (typeof callback === "function") process.nextTick(function () { callback(error); });
    }
    if (state.failure || state.blocked) {
      acknowledge(protectionError(state.failure ? "TEXT_PROTECTION_SINK_ERROR" : "TEXT_PROTECTION_BACKPRESSURE"));
      return false;
    }
    try {
      if (encoding && !Buffer.isEncoding(encoding))
        throw protectionError("TEXT_PROTECTION_ENCODING_UNSUPPORTED");
      var bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding || "utf8") :
        Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      var output = transform(state, bytes);
      var accepted = forward(state, output);
      acknowledge();
      return accepted;
    } catch (error) {
      acknowledge(error);
      return false;
    }
  };
  return state;
}
function protect(proc, token) {
  if (token && Buffer.byteLength(String(token)) > MAX_ENCODED_SECRET_FORM_BYTES)
    throw protectionError("TEXT_PROTECTION_FORM_TOO_LARGE");
  var forms = token ? [String(token), encodeURIComponent(token), encodeURI(token),
    JSON.stringify(token).slice(1, -1), JSON.stringify(token).slice(1, -1).replace(/\//g, "\\/")] : [];
  var textForms = forms.filter(function (form, index) { return forms.indexOf(form) === index; });
  forms = [];
  textForms.forEach(function (form) {
    // Canonical byte encodings cover every Buffer.isEncoding alias as well as
    // legacy write(string, encoding, callback) and subsequent raw byte views.
    ["utf8", "utf16le", "latin1", "ascii", "base64", "base64url", "hex"].forEach(function (encoding) {
      var bytes = Buffer.from(form, encoding);
      if (bytes.length > MAX_ENCODED_SECRET_FORM_BYTES) throw protectionError("TEXT_PROTECTION_FORM_TOO_LARGE");
      if (!bytes.length) return;
      bytes.mask = Buffer.from("<token>", encoding);
      forms.push(bytes);
    });
  });
  [proc.stdout, proc.stderr].forEach(function (stream) {
    var state = decorate(stream);
    state.textForms = Array.from(new Set(state.textForms.concat(textForms)));
    forms.forEach(function (form) {
      if (!state.forms.some(function (existing) { return existing.equals(form); })) state.forms.push(form);
    });
    state.forms.sort(function (a, b) { return b.length - a.length; });
  });
}
function redactProtected(proc, value) {
  var forms = [];
  states(proc).forEach(function (state) { state.textForms.forEach(function (text) {
    if (forms.indexOf(text) === -1) forms.push(text);
  }); });
  forms.sort(function (a, b) { return b.length - a.length; });
  function copy(input, depth) {
    if (typeof input === "string") {
      forms.forEach(function (form) { input = input.split(form).join("<token>"); });
      return input.slice(0, 65536);
    }
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (!input || depth > 12) return undefined;
    if (input instanceof Error) input = { code: input.code, message: input.message, resources: input.resources };
    var out = Array.isArray(input) ? [] : {};
    Object.keys(input).slice(0, 64).forEach(function (key) {
      Object.defineProperty(out, copy(key, depth + 1), { value: copy(input[key], depth + 1),
        enumerable: true, configurable: true, writable: true });
    });
    return out;
  }
  return copy(value, 0);
}
async function flushProtection(proc) {
  return Promise.all(states(proc).map(function (state) {
    if (state.tail.length) {
      state.quarantine = state.forms.filter(function (form) {
        return form.length > state.tail.length && form.subarray(0, state.tail.length).equals(state.tail);
      }).map(function (form) { return { form: form, offset: state.tail.length }; });
      state.tail = Buffer.alloc(0);
      forward(state, MASK);
    }
    if (state.failure) return Promise.reject(protectionError("TEXT_PROTECTION_SINK_ERROR"));
    if (!state.pending && !state.blocked) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var waiter = { resolve: resolve, reject: reject };
      waiter.timer = setTimeout(function () {
        var index = state.waiters.indexOf(waiter);
        state.waiters.splice(index, 1);
        reject(protectionError("TEXT_PROTECTION_FLUSH_UNCONFIRMED"));
      }, 5000);
      state.waiters.push(waiter);
    });
  })).then(function () {});
}

function decodeToken(value) {
  return value.slice(1).toString(value[0] === 0 ? "utf16le" : "latin1");
}

function scan(iterator, want) {
  return iterator.next().then(function (entry) {
    if (!entry) return null;
    return entry[0].equals(want) ? decodeToken(entry[1]) : scan(iterator, want);
  });
}

function readSqliteToken(file, extensionId, tokenKey, deps) {
  var sqlite;
  try {
    sqlite = deps.sqlite === undefined ? require("node:sqlite") : deps.sqlite;
  } catch (error) {
    return null;
  }
  if (!sqlite) return null;
  var copy = fs.mkdtempSync(path.join(deps.tmpdir, "desk-web-ls-"));
  try {
    ["", "-wal"].forEach(function (suffix) {
      if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, path.join(copy, "LocalStorage" + suffix));
    });
    var db = new sqlite.DatabaseSync(path.join(copy, "LocalStorage"));
    try {
      var row = db.prepare("SELECT e.value AS value, e.value_compression_type AS compression FROM map_entries e JOIN maps m ON m.row_id = e.map_id WHERE m.storage_key = ? AND e.key = ?")
        .get(Buffer.from("chrome-extension://" + extensionId + "/", "latin1"), Buffer.concat([Buffer.from([1]), Buffer.from(tokenKey, "latin1")]));
      return row && row.compression === 0 ? decodeToken(Buffer.from(row.value)) : null;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

// Read only a temporary copy, never the browser's locked live database.
function readExtensionToken(profileDir, deps) {
  var extensionId = deps.extensionId === undefined ? EXTENSION_ID : deps.extensionId;
  var tokenKey = deps.tokenKey === undefined ? "auth-token" : deps.tokenKey;
  if (typeof extensionId !== "string" || !/^[a-p]{32}$/.test(extensionId) ||
      typeof tokenKey !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(tokenKey)) {
    return Promise.reject(new Error("browser_token_identity_invalid"));
  }
  var source = path.join(profileDir, "Local Storage", "leveldb");
  var sqliteFile = path.join(profileDir, "LocalStorage");
  function fromSqlite(token) {
    return token || !fs.existsSync(sqliteFile) ? token : readSqliteToken(sqliteFile, extensionId, tokenKey, deps);
  }
  if (!fs.existsSync(source)) return Promise.resolve(null).then(fromSqlite);
  var copy = fs.mkdtempSync(path.join(deps.tmpdir, "desk-web-ls-"));
  function remove() {
    fs.rmSync(copy, { recursive: true, force: true });
  }
  var db = null;
  var iterator = null;
  return Promise.resolve().then(function () {
    fs.readdirSync(source).forEach(function (name) {
      if (name !== "LOCK") fs.copyFileSync(path.join(source, name), path.join(copy, name));
    });
    db = new deps.level.ClassicLevel(copy, { keyEncoding: "buffer", valueEncoding: "buffer", createIfMissing: false });
    iterator = db.iterator();
    return scan(iterator, Buffer.from("_chrome-extension://" + extensionId + "\u0000\u0001" + tokenKey, "latin1"));
  }).then(function (token) {
    return shutdown().then(function () { return fromSqlite(token); });
  }, function (error) {
    return shutdown().then(function () { throw error; });
  });
  function shutdown() {
    return Promise.resolve().then(function () {
      return iterator === null ? null : iterator.close();
    }).then(function () {
      return db === null ? null : db.close();
    }).then(remove, remove);
  }
}

// Called from the staged copy in playwright-core/lib; o substitutes process/reader for tests.
function initialize(userDataDir, profileDirectory, o) {
  o = o || {};
  var proc = o.process === undefined ? process : o.process;
  return Promise.resolve().then(function () {
    var binding = proc.env[BINDING_KEY];
    if (binding === undefined) return;
    if (typeof binding !== "string" || !path.isAbsolute(binding) ||
        typeof userDataDir !== "string" || typeof profileDirectory !== "string" ||
        path.resolve(binding) !== path.resolve(userDataDir, profileDirectory)) {
      throw new Error("browser_profile_binding_mismatch");
    }
    protect(proc, proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN);
    delete proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    return Promise.resolve().then(function () {
      var level = o.level === undefined ? require(path.resolve(__dirname, "..", "..", "classic-level")) : o.level;
      return readExtensionToken(path.resolve(binding), { level: level, tmpdir: os.tmpdir() });
    }).then(function (token) {
      if (!token) throw new Error("browser_token_unavailable");
      // No yield between registering a rotated secret and making it visible to the relay.
      protect(proc, token);
      proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
    }, function () {
      throw new Error("browser_token_unreadable");
    });
  });
}

var NATIVE_FILES = Object.freeze([
  "package.json", "web-native-messaging.cjs", "web-extension-credential.cjs", "web-browser-discovery.cjs",
  "src/browser/native-host.mjs", "src/util/broker-error.mjs", "src/util/private-state.mjs",
  "src/factory/os-protect.js", "src/factory/windows-acl.js", "src/readiness/process-start.js",
  "../browser-context-broker/src/primitives/broker-error.mjs",
  "../browser-context-broker/src/primitives/private-state.mjs"
]);
var nativeBindings = new WeakMap();
function digest(bytes) { return require("crypto").createHash("sha256").update(bytes).digest("hex"); }
function nativeError(code, resources) {
  var safe = resources === undefined ? undefined : redactProtected(process, resources);
  var error = new Error(code + (safe === undefined ? "" : ": " + JSON.stringify(safe)));
  error.code = code;
  if (safe !== undefined) error.resources = safe;
  return error;
}
function publicCode(root, relative) {
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw nativeError("NATIVE_CODE_UNAVAILABLE");
  var current = root;
  relative.split("/").forEach(function (part) {
    if (!part || part === "." || part === "..") throw nativeError("NATIVE_CODE_UNAVAILABLE");
    current = path.join(current, part);
    var stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (current === path.join(root, relative) ? !stat.isFile() : !stat.isDirectory()))
      throw nativeError("NATIVE_CODE_UNAVAILABLE");
  });
  var before = fs.lstatSync(current, { bigint: true });
  if (before.size > BigInt(4194304)) throw nativeError("NATIVE_CODE_UNAVAILABLE");
  var bytes = fs.readFileSync(current), after = fs.lstatSync(current, { bigint: true });
  if (["dev", "ino", "size", "ctimeNs", "mtimeNs"].some(function (key) { return before[key] !== after[key]; }))
    throw nativeError("NATIVE_CODE_CHANGED");
  return bytes;
}
function nativeInventory(root) {
  if (JSON.parse(publicCode(root, "package.json")).type !== "module") throw nativeError("NATIVE_CODE_UNAVAILABLE");
  var targets = NATIVE_FILES.map(function (file) { return path.posix.normalize("mcp/" + file); });
  return NATIVE_FILES.map(function (file) {
    // Only these fixed sibling entries cross the MCP root; publicCode still
    // refuses traversal in every relative path it reads.
    var bytes = file.indexOf("../browser-context-broker/") === 0
      ? publicCode(path.dirname(root), file.slice(3)) : publicCode(root, file);
    var source = bytes.toString("utf8"), match;
    var literals = /\b(?:from|import)\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
    while (file !== "package.json" && (match = literals.exec(source))) {
      var target = match[1] || match[2], moduleApi = require("module");
      if (target[0] === ".") {
        if (targets.indexOf(path.posix.normalize(path.posix.join("mcp", path.posix.dirname(file), target))) === -1)
          throw nativeError("NATIVE_CODE_UNAVAILABLE");
      } else if (!(moduleApi.isBuiltin ? moduleApi.isBuiltin(target) :
        (moduleApi.builtinModules || []).indexOf(target.replace(/^node:/, "")) !== -1))
        throw nativeError("NATIVE_CODE_UNAVAILABLE");
    }
    return { path: file, sha256: digest(bytes) };
  });
}
function captureNativeDiscoveryInputs(platform, env, home) {
  var paths = platform === "win32" ? path.win32 : path.posix;
  if (["win32", "darwin", "linux"].indexOf(platform) === -1 || !env || typeof env !== "object" || Array.isArray(env) || typeof home !== "string" ||
      !paths.isAbsolute(home) || home.length > 32768 || /[\x00-\x1f\x7f]/.test(home))
    throw nativeError("NATIVE_DISCOVERY_INPUTS_UNAVAILABLE");
  var values = {};
  if (platform === "win32") ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"].forEach(function (name) {
    var key = Object.keys(env).filter(function (candidate) { return candidate.toUpperCase() === name; })[0];
    if (key === undefined) return;
    var value = env[key];
    if (typeof value !== "string" || !paths.isAbsolute(value) || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value))
      throw nativeError("NATIVE_DISCOVERY_INPUTS_UNAVAILABLE");
    values[name] = value;
  });
  return Object.freeze({ version: 1, platform: platform, nativeHome: home, browserEnv: Object.freeze(values) });
}
function checkCapture(value) {
  if (!value || Object.keys(value).sort().join(",") !== "browserEnv,nativeHome,platform,version" || value.version !== 1 ||
      !value.browserEnv || Array.isArray(value.browserEnv) ||
      Object.keys(value.browserEnv).some(function (key) { return ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"].indexOf(key) === -1; }))
    throw nativeError("NATIVE_DISCOVERY_INPUTS_UNAVAILABLE");
  var fresh = captureNativeDiscoveryInputs(value.platform, value.browserEnv, value.nativeHome);
  if (JSON.stringify(fresh) !== JSON.stringify(value)) throw nativeError("NATIVE_DISCOVERY_INPUTS_UNAVAILABLE");
  return fresh;
}
// Private generation state only, never public distributed code. The synchronous
// staging API uses the same OS SID/DACL policy as the approved private readers.
function privateGeneration(directory, file) {
  var stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory) ||
      (process.getuid && stat.uid !== process.getuid())) throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 448);
    if (file) fs.chmodSync(file, 384);
    return;
  }
  var rootKey = Object.keys(process.env).filter(function (key) { return key.toLowerCase() === "systemroot"; })[0];
  var root = process.env[rootKey];
  if (!root || !path.win32.isAbsolute(root)) throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
  var script = "$ErrorActionPreference='Stop';$paths=[Console]::In.ReadToEnd()|ConvertFrom-Json;" +
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;foreach($p in $paths){" +
    "$i=Get-Item -LiteralPath $p -Force;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse'};" +
    "$a=$i.GetAccessControl('Access,Owner');if($a.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid){throw 'owner'};" +
    "$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){[void]$a.RemoveAccessRuleSpecific($r)};" +
    "$inherit=if($i.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};" +
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);" +
    "$a.AddAccessRule($rule);$i.SetAccessControl($a)}";
  require("child_process").execFileSync(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { input: JSON.stringify(file ? [directory, file] : [directory]),
      encoding: "utf8", timeout: 20000, maxBuffer: 16384, windowsHide: true });
}
function verifyGeneration(installed, expectedRoot) {
  var receiptPath = path.join(installed.dir, "playwright-patch.json");
  if (fs.lstatSync(receiptPath).isDirectory()) fs.readFileSync(receiptPath); // preserve real EISDIR
  assertPrivateState(installed.dir, true);
  var directoryIdentity = fs.lstatSync(installed.dir, { bigint: true });
  assertPrivateState(receiptPath, false);
  var before = fs.lstatSync(receiptPath, { bigint: true });
  if (before.size > BigInt(65536)) throw nativeError("NATIVE_CODE_UNAVAILABLE");
  var receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  var after = fs.lstatSync(receiptPath, { bigint: true });
  if (["dev", "ino", "size", "ctimeNs", "mtimeNs"].some(function (key) { return before[key] !== after[key]; }))
    throw nativeError("NATIVE_CODE_CHANGED");
  if (!receipt || Object.keys(receipt).sort().join(",") !==
      "bundleSha256,coreVersion,credentialSha256,errorCodecSha256,errorRegionProofs,guardedRegionProofs,mcpVersion,nativeHelperSha256,nativeRuntime,patchSourceSha256,revision,sessionSha256" ||
      receipt.revision !== 4 || (installed.version !== undefined && receipt.mcpVersion !== installed.version) ||
      (installed.core !== undefined && receipt.coreVersion !== installed.core)) throw nativeError("NATIVE_CODE_UNAVAILABLE");
  var runtime = receipt.nativeRuntime;
  if (runtime && !Object.prototype.hasOwnProperty.call(runtime, "discoveryInputs"))
    throw nativeError("NATIVE_DISCOVERY_INPUTS_UNAVAILABLE");
  if (!runtime || Object.keys(runtime).sort().join(",") !== "discoveryInputs,mcpRoot,modules,version" || runtime.version !== 1 ||
      typeof runtime.mcpRoot !== "string" || !path.isAbsolute(runtime.mcpRoot) ||
      (expectedRoot && runtime.mcpRoot !== fs.realpathSync(expectedRoot)) ||
      JSON.stringify(nativeInventory(runtime.mcpRoot)) !== JSON.stringify(runtime.modules))
    throw nativeError("NATIVE_CODE_UNAVAILABLE");
  checkCapture(runtime.discoveryInputs);
  var lib = path.join(installed.dir, "node_modules/playwright-core/lib");
  if (digest(publicCode(installed.dir, "node_modules/playwright-core/lib/coreBundle.js")) !== receipt.bundleSha256 ||
      digest(publicCode(installed.dir, "node_modules/playwright-core/lib/desk-extension-credential.cjs")) !== receipt.credentialSha256 ||
      digest(publicCode(runtime.mcpRoot, "web-extension-credential.cjs")) !== receipt.credentialSha256 ||
      digest(publicCode(installed.dir, "node_modules/playwright-core/lib/desk-native-relay.cjs")) !== receipt.nativeHelperSha256 ||
      digest(publicCode(runtime.mcpRoot, "web-native-relay.cjs")) !== receipt.nativeHelperSha256 ||
      digest(publicCode(installed.dir, "node_modules/playwright-core/lib/desk-native-error-transport.cjs")) !== receipt.errorCodecSha256 ||
      digest(publicCode(runtime.mcpRoot, "web-native-error-transport.cjs")) !== receipt.errorCodecSha256 ||
      digest(publicCode(installed.dir, "node_modules/playwright-core/lib/tools/cli-client/session.js")) !== receipt.sessionSha256 ||
      digest(publicCode(runtime.mcpRoot, "web-playwright-patch.cjs")) !== receipt.patchSourceSha256)
    throw nativeError("NATIVE_CODE_UNAVAILABLE");
  var source = publicCode(installed.dir, "node_modules/playwright-core/lib/coreBundle.js").toString("utf8");
  var proof = [
    ["function createServer(name, version3, factory, transportInitialized, runHeartbeat) {", "\nfunction addServerListener(", "0a0d6cd9bfae79dbda66509b6d01fad89fdc37629cc729e26db7b97d80b8fc4b"],
    ["async function createExtensionBrowser(", "\nvar import_path60, debug16, debugLogger3;", "e014782f47d440a616b852b8a5838d4d49a2d2c458a5eba2b3ecd70ae5fe91ca"],
    ["async function createBrowser(config,", "\nasync function connectToBrowserEndpoint(", "b4976bd9fda5aa82d853428acf2ff586fa16dae44b605649bd2652dd89759d0e"],
    ["    CDPRelayServer = class {", "\n    ExtensionConnection = class {", "0c01234faaad68848d096c87c384a4a9318bdab8a5aef964824498b7e64751e5"]
  ].map(function (region) {
    var start = source.indexOf(region[0]), end = source.indexOf(region[1], start);
    if (start < 0 || end < 0 || source.indexOf(region[0], start + region[0].length) !== -1)
      throw nativeError("NATIVE_CODE_UNAVAILABLE");
    return { original: region[2], patched: digest(source.slice(start, end)) };
  });
  if (JSON.stringify(proof) !== JSON.stringify(receipt.guardedRegionProofs)) throw nativeError("NATIVE_CODE_UNAVAILABLE");
  var errorRegions = [
    ["var init_browserBackend = __esm({", "\n// packages/playwright-core/src/tools/backend/common.ts", "024e7dcae1350fc0c5afa4f71f1e9405081c0fcf8c5e63d980319ed6e3287c34"],
    ["async function startCliDaemonServer(", "\nasync function saveSessionFile(", "b4b6608dc24505cc41c1ede77e96ae00426cd5ed52dc85652f0b933a399b4543"],
    ["function decorateProgram3(program4) {", "\nfunction defaultConfigFile(", "becf9648f7de7d20e50d02350c886bffa538e8d66c7dc809874f5db0a497f638"],
    ["function createSessionConfig(", "\nvar import_fs67, import_net10, import_path63;", "b46fb243926574fbeacb1832adc19a7910413b62d5bcda4e61e655f6c6932985"],
    ["async function loadConfig(configFile) {", "\nfunction resolveConfigPaths(", "adbf471d2fc29dcf8a83f03dc08aed0058361bbe5f72dc45610248afd36ad789"],
    ["var tools_exports = {};", "\nvar init_tools2 = __esm({", "bbbe1a73e260c1bd94c759018d09cbf8823684f4718c3e34ec3f0445d0c0c202"],
    ["function configFromIniFile(filePath) {", "\n// packages/playwright-core/src/tools/mcp/config.ts", "4deca6f390b3931fee8cc57ed3076ed384a0f4f1e33a3077c6b749d50d0d41fa"]
  ];
  function errorProof(text, specification) {
    var start = text.indexOf(specification[0]), end = text.indexOf(specification[1], start);
    if (start < 0 || end < 0 || text.indexOf(specification[0], start + specification[0].length) !== -1)
      throw nativeError("NATIVE_CODE_UNAVAILABLE");
    return { original: specification[2], patched: digest(text.slice(start, end)) };
  }
  var sessionSource = publicCode(installed.dir, "node_modules/playwright-core/lib/tools/cli-client/session.js").toString("utf8");
  var errorProofs = { core: errorRegions.map(function (entry) { return errorProof(source, entry); }),
    session: errorProof(sessionSource, ["  static async startDaemon(", "\n  async _stopDaemon()", "1086c0f0f2fedc452761a5870bbf93512f58a743152ffe6bbf3222d12e71331c"]) };
  if (JSON.stringify(errorProofs) !== JSON.stringify(receipt.errorRegionProofs))
    throw nativeError("NATIVE_CODE_UNAVAILABLE");
  var patch = require(path.join(runtime.mcpRoot, "web-playwright-patch.cjs"));
  if (patch.patchSource(source) !== source || patch.patchSessionSource(sessionSource) !== sessionSource)
    throw nativeError("NATIVE_CODE_UNAVAILABLE");
  assertPrivateState(installed.dir, true);
  assertPrivateState(receiptPath, false);
  var final = fs.lstatSync(receiptPath, { bigint: true });
  var finalDirectory = fs.lstatSync(installed.dir, { bigint: true });
  if (["dev", "ino", "size", "ctimeNs", "mtimeNs"].some(function (key) { return before[key] !== final[key]; }))
    throw nativeError("NATIVE_CODE_CHANGED");
  if (directoryIdentity.dev !== finalDirectory.dev || directoryIdentity.ino !== finalDirectory.ino)
    throw nativeError("NATIVE_CODE_CHANGED");
  if (fs.realpathSync(lib) !== lib) throw nativeError("NATIVE_CODE_UNAVAILABLE");
  return { receipt: receipt, runtime: runtime,
    stateIdentity: [directoryIdentity.dev, directoryIdentity.ino, before.dev, before.ino,
      before.size, before.ctimeNs, before.mtimeNs].map(String).join(":") };
}
function assertPrivateState(file, directory) {
  var stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (process.getuid && stat.uid !== process.getuid())) throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
  var exec = require("child_process").execFileSync;
  if (process.platform !== "win32") {
    if (stat.mode & 63) throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
    if (process.platform === "darwin" && /^\s*\d+:/m.test(exec("/bin/ls", ["-ldeq", file],
      { encoding: "utf8", timeout: 5000, maxBuffer: 16384 }))) throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
    return;
  }
  var key = Object.keys(process.env).filter(function (name) { return name.toLowerCase() === "systemroot"; })[0];
  var root = process.env[key];
  if (!root || !path.win32.isAbsolute(root)) throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
  var script = "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;" +
    "$i=Get-Item -LiteralPath $p -Force;$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;" +
    "if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){exit 2};$a=$i.GetAccessControl('Access,Owner');" +
    "if($a.GetOwner([Security.Principal.SecurityIdentifier]) -ne $s -or -not $a.AreAccessRulesProtected){exit 2};" +
    "$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));" +
    "if($r.Count -ne 1 -or $r[0].IdentityReference -ne $s -or $r[0].AccessControlType -ne 'Allow' -or " +
    "($r[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl){exit 2};[Console]::Out.Write('private')";
  if (exec(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { input: JSON.stringify(file), encoding: "utf8",
      timeout: 5000, maxBuffer: 16384, windowsHide: true }) !== "private") throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
}
function validateNativeBinding(record, route) {
  if (!record || typeof record !== "object" || Array.isArray(record) || !Object.keys(record).length)
    throw nativeError("NATIVE_CONFIG_INVALID");
  var browser = route && route.browser || route || {}, options = route && route.options || route || {};
  if (!route || route.extension !== true || (browser.browserName || route.browserName) !== "chromium" ||
      browser.remoteEndpoint || browser.cdpEndpoint || browser.isolated)
    throw nativeError("NATIVE_CONFIG_INVALID");
  var generation = path.resolve(__dirname, "../../..");
  var verified;
  try { verified = verifyGeneration({ dir: generation }); }
  catch (error) { throw nativeError(["NATIVE_CODE_CHANGED", "NATIVE_DISCOVERY_INPUTS_UNAVAILABLE"].indexOf(error.code) !== -1 ?
    error.code : "NATIVE_CODE_UNAVAILABLE"); }
  var cached = nativeBindings.get(record), codeEpoch = digest(JSON.stringify(verified.receipt));
  if (cached && (cached.origin !== verified.runtime.mcpRoot || cached.codeEpoch !== codeEpoch ||
      cached.stateIdentity !== verified.stateIdentity))
    throw nativeError("NATIVE_CODE_CHANGED");
  // Native-only lazy load; ordinary staging/revision reads do not import C.
  var client = require(path.join(verified.runtime.mcpRoot, "web-native-messaging.cjs"));
  var checked = client.readPrivateJson(path.join(generation, "playwright-patch.json"));
  if (JSON.stringify(checked) !== JSON.stringify(verified.receipt)) throw nativeError("NATIVE_CODE_CHANGED");
  client.validateNativeRecord(record); // sole nine-field record validator
  var profileDirName = options.profileDirName === undefined ? record.profileDirName : options.profileDirName;
  if (options.channel !== record.channel || browser.userDataDir !== record.userDataDir ||
      profileDirName !== record.profileDirName) throw nativeError("NATIVE_SELECTION_MISMATCH");
  var capture = checkCapture(verified.runtime.discoveryInputs), home;
  try { home = os.userInfo().homedir; } catch (error) { throw nativeError("NATIVE_DISCOVERY_INPUTS_UNAVAILABLE"); }
  if (capture.platform !== process.platform || capture.nativeHome !== home)
    throw nativeError("NATIVE_DISCOVERY_INPUTS_UNAVAILABLE");
  var discovery = require(path.join(verified.runtime.mcpRoot, "web-browser-discovery.cjs"));
  var candidate = discovery.channelBrowserSelection(record.channel, process.platform, capture.browserEnv,
    function (file) { return fs.existsSync(file); }, { nativeHome: home }).executablePath;
  if (!candidate) throw nativeError("NATIVE_BROWSER_UNAVAILABLE");
  var executable;
  try {
    executable = fs.realpathSync(candidate);
    if (options.executablePath && fs.realpathSync(options.executablePath) !== executable) throw Error();
  } catch (error) { throw nativeError("NATIVE_SELECTION_MISMATCH"); }
  if (cached) {
    if (cached.selection.browserExecutable !== executable || JSON.stringify(cached.record) !== JSON.stringify(record))
      throw nativeError("NATIVE_SELECTION_MISMATCH");
    return cached;
  }
  var frozen = Object.freeze(JSON.parse(JSON.stringify(record))), acquisition;
  var selection = {};
  ["channel", "userDataDir", "profileDirName", "nativeReadyFile", "extensionId", "sourceDigest"].forEach(function (key) {
    selection[key] = frozen[key];
  });
  selection.browserExecutable = executable;
  var binding = Object.freeze({ record: frozen, selection: Object.freeze(selection), client: client,
    origin: verified.runtime.mcpRoot, codeEpoch: codeEpoch, stateIdentity: verified.stateIdentity,
    retain: function (value) { acquisition = value; },
    waitFor: function (operation, stage) { return acquisition.waitFor(operation, stage); },
    failure: function (error) { if (acquisition) acquisition.retire(); return acquisition ? acquisition.failure(error) :
      nativeError(client.safeCode(error && error.code, "NATIVE_ACQUISITION_UNAVAILABLE"),
        client.safeResources(error && error.resources)); }
  });
  nativeBindings.set(record, binding);
  nativeBindings.set(frozen, binding);
  return binding;
}
function getNativeBinding(record) {
  var binding = nativeBindings.get(record);
  if (!binding) throw nativeError("NATIVE_CONFIG_INVALID");
  return binding;
}
// Error transport is descriptive only. Reuse the C projector after validating
// descriptors/budgets, then apply a fixed field vocabulary and registered-text
// redaction. Never inspect Error.message/stack or execute a resource getter.
var TRANSPORT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var TRANSPORT_CODES = [
  "NATIVE_ERROR_TRANSPORT_UNCONFIRMED", "NATIVE_CONFIG_INVALID", "NATIVE_SELECTION_MISMATCH",
  "NATIVE_CODE_UNAVAILABLE", "NATIVE_CODE_CHANGED", "NATIVE_DISCOVERY_INPUTS_UNAVAILABLE",
  "NATIVE_BROWSER_UNAVAILABLE", "NATIVE_PRIVATE_PATH_INVALID", "NATIVE_HANDSHAKE_TIMEOUT",
  "NATIVE_ACQUISITION_UNAVAILABLE"
];
var RESOURCE_FIELDS = ("contextId state disposition label groupId priorGroupId tabId windowId generation " +
  "tabs revokedTabIds revokedTabs releasedRevokedTabs unknownRevokedTabs pendingEffects unconfirmedCreates " +
  "uncertainTabs groupingObligations effectObligations admittingTabIds debuggerObservationActive debuggerCustody " +
  "revoked reason closedTabIds absentTabIds remainingTabIds owners native method operation pendingNativeOperation " +
  "pendingAcquisitionOperations pendingRelayOperation relayDisposition discarded count pending released closed " +
  "absent retained unknown redactedFields").split(" ");
var RESOURCE_WORDS = ("unknown pending ready creating unavailable disconnected discarded retained released closed absent " +
  "unsettled attaching attached detaching dispatch prepareUpdate cancelUpdate commitUpdate " +
  "context.create context.resume context.status context.label context.discard profile.read extension.reload extension.reload.commit " +
  "extension.handshake cdp.connect browser.bind browser.close " +
  "NATIVE_EFFECT_UNSETTLED NATIVE_OWNER_UNSETTLED native_group_readback_unconfirmed native_debugger_generation_unconfirmed " +
  "native_debugger_observation_retired native_debugger_detach_unconfirmed native_debugger_attach_unconfirmed " +
  "native_command_effect_unconfirmed native_close_ownership_unconfirmed").split(" ");
function transportJson(value, maxDepth) {
  var budget = 0, seen = new Set();
  function visit(item, depth) {
    if (depth > maxDepth) throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    if (item === null || typeof item === "boolean") { budget += item === true ? 4 : item === false ? 5 : 4; return item; }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
      budget += Buffer.byteLength(JSON.stringify(item)); return item;
    }
    if (typeof item === "string") {
      var size = Buffer.byteLength(JSON.stringify(item));
      // C's string bound must never silently truncate an obligation.
      if (item.length > 4096) throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
      budget += size; return item;
    }
    if (!item || typeof item !== "object" || seen.has(item))
      throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    var array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (!array && proto !== null && Object.getPrototypeOf(proto) !== null)
      throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    if (array && (!proto || !Object.getOwnPropertyDescriptor(proto, "constructor") ||
        Object.getOwnPropertyDescriptor(proto, "constructor").value.name !== "Array"))
      throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    seen.add(item);
    var result = array ? [] : {}, keys = Reflect.ownKeys(item), first = true;
    budget += 2;
    keys.forEach(function (key) {
      if (array && key === "length") return;
      var descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== "string" || !descriptor || !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          (array && !/^(0|[1-9][0-9]*)$/.test(key)))
        throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
      budget += first ? 0 : 1; first = false;
      if (!array) budget += Buffer.byteLength(JSON.stringify(key)) + 1;
      var copied = visit(descriptor.value, depth + 1);
      if (budget > 4194304) throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
      Object.defineProperty(result, key, { value: copied, enumerable: true, writable: true, configurable: true });
    });
    if (array && result.length !== keys.length - 1) throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    seen.delete(item);
    return result;
  }
  return visit(value, 0);
}
function transportProject(client, error) {
  function field(name) {
    if (!error || (typeof error !== "object" && typeof error !== "function")) return undefined;
    var descriptor = Object.getOwnPropertyDescriptor(error, name);
    if (!descriptor) return undefined;
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value"))
      throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    return descriptor.value;
  }
  var candidate = field("code");
  var code = client.safeCode(candidate, TRANSPORT_CODES.indexOf(candidate) !== -1 ?
    candidate : "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
  var input = field("resources");
  var resources = input === undefined ? null : client.safeResources(transportJson(input, 16));
  function privacy(item, key) {
    if (typeof item === "string") {
      var safe = redactProtected(process, item);
      if (key === "contextId" && TRANSPORT_UUID.test(item) && safe === item) return item;
      if ((["state", "disposition", "reason", "method", "operation", "pendingAcquisitionOperations", "relayDisposition"].indexOf(key) !== -1) &&
          safe === item && (RESOURCE_WORDS.indexOf(item) !== -1 || client.safeCode(item, null))) return item;
      return "<redacted>";
    }
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(function (entry) { return privacy(entry, key); });
    var out = {}, hidden = [];
    Object.keys(item).forEach(function (name) {
      if (["closedTabIds", "absentTabIds", "remainingTabIds", "revokedTabIds", "admittingTabIds"].indexOf(name) !== -1 &&
          (!Array.isArray(item[name]) || item[name].some(function (id) { return !Number.isSafeInteger(id) || id < 0; })))
        throw nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
      if (RESOURCE_FIELDS.indexOf(name) !== -1) out[name] = privacy(item[name], name);
      else hidden.push(privacy(item[name], ""));
    });
    // Unknown field names themselves can contain credentials. Preserve their
    // numeric/boolean/array topology under one fixed marker, never their keys.
    if (hidden.length) out.redactedFields = (out.redactedFields || []).concat(hidden);
    return out;
  }
  return { code: code, message: code, resources: privacy(resources, "") };
}
// Existing OS-private behavior factored at its actual descriptor/protection
// boundary. The native acquisition still performs both pathname/FD identity
// checks around this operation; no caller-selectable protection policy.
function protectNativeErrorLog(fd, directory, file) {
  if (process.platform === "win32") privateGeneration(directory, file);
  else fs.fchmodSync(fd, 384);
}
function nativeErrorTransportBinding(input) {
  var file = input.kind === "file" ? input.configFile : input.config.configFile;
  var config;
  try { config = input.kind === "file" ? JSON.parse(fs.readFileSync(file, "utf8")) : input.config; }
  catch (_) {
    var failure = nativeError("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    failure.resources = { disposition: "unknown" };
    if (TRANSPORT_UUID.test(input.sessionName)) failure.resources.contextId = input.sessionName;
    throw failure;
  }
  if (!config || !Object.prototype.hasOwnProperty.call(config, "deskNativeContext")) return null;
  var verified;
  try { verified = verifyGeneration({ dir: path.resolve(__dirname, "../../..") }); }
  catch (error) { throw nativeError(["NATIVE_CODE_CHANGED", "NATIVE_DISCOVERY_INPUTS_UNAVAILABLE"].indexOf(error.code) !== -1 ?
    error.code : "NATIVE_CODE_UNAVAILABLE"); }
  var client = require(path.join(verified.runtime.mcpRoot, "web-native-messaging.cjs"));
  var receiptFile = path.resolve(__dirname, "../../../playwright-patch.json");
  var receiptBytes = fs.readFileSync(receiptFile);
  if (JSON.stringify(JSON.parse(receiptBytes)) !== JSON.stringify(verified.receipt))
    throw nativeError("NATIVE_CODE_CHANGED");
  var sourceGeneration = digest(receiptBytes), configIdentity, configDigest, invalid, record, route;
  try {
    var privateConfig = client.readPrivateJson(file);
    configIdentity = client.fileIdentity(file);
    configDigest = digest(JSON.stringify(privateConfig));
    var descriptor = Object.getOwnPropertyDescriptor(config, "deskNativeContext");
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value"))
      throw nativeError("NATIVE_CONFIG_INVALID");
    record = transportJson(descriptor.value, 16);
    if (JSON.stringify(privateConfig.deskNativeContext) !== JSON.stringify(record))
      throw nativeError("NATIVE_CONFIG_INVALID");
    client.validateNativeRecord(record);
    var browser = config.browser || {};
    var options = browser.launchOptions || {};
    var channel = input.kind === "file" ? input.channel : options.channel || "chrome";
    route = { extension: config.extension, browser: Object.assign({}, browser, { browserName: browser.browserName || "chromium" }),
      options: { channel: channel, profileDirName: record.profileDirName, executablePath: options.executablePath } };
    validateNativeBinding(record, route);
    if (input.sessionName !== record.contextId) throw nativeError("NATIVE_CONFIG_INVALID");
  } catch (error) { invalid = nativeError(client.safeCode(error.code,
    TRANSPORT_CODES.indexOf(error.code) !== -1 ? error.code : "NATIVE_CONFIG_INVALID")); }
  var contextId = TRANSPORT_UUID.test(input.sessionName) ? input.sessionName :
    record && TRANSPORT_UUID.test(record.contextId) ? record.contextId : "unbound";
  function assertBinding() {
    if (invalid) throw invalid;
    var current = verifyGeneration({ dir: path.resolve(__dirname, "../../..") });
    if (current.stateIdentity !== verified.stateIdentity || digest(fs.readFileSync(receiptFile)) !== sourceGeneration ||
        client.fileIdentity(file) !== configIdentity || digest(JSON.stringify(client.readPrivateJson(file))) !== configDigest)
      throw nativeError("NATIVE_CODE_CHANGED");
    var descriptor = Object.getOwnPropertyDescriptor(config, "deskNativeContext");
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        JSON.stringify(transportJson(descriptor.value, 16)) !== JSON.stringify(record))
      throw nativeError("NATIVE_CONFIG_INVALID");
    validateNativeBinding(record, route);
  }
  return Object.freeze({ contextId: contextId, sourceGeneration: sourceGeneration,
    identity: invalid ? null : digest(JSON.stringify([verified.stateIdentity, file, configIdentity, configDigest])),
    project: function (error) { return transportProject(client, error); },
    assert: assertBinding,
    validateLaunch: function (args) {
      assertBinding();
      if (args.cdp || args.endpoint) throw nativeError("NATIVE_CONFIG_INVALID");
      if ((args.profile && path.resolve(args.profile) !== record.userDataDir) ||
          (args.browser && args.browser !== record.channel)) throw nativeError("NATIVE_SELECTION_MISMATCH");
    },
    openErrorLog: function (clientInfo) {
      assertBinding();
      var directory = path.resolve(clientInfo.daemonProfilesDir);
      var anchor = path.dirname(path.dirname(path.resolve(file)));
      var relative = path.relative(anchor, directory);
      if (relative === ".." || relative.indexOf(".." + path.sep) === 0 || path.isAbsolute(relative))
        throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
      client.privatePath(anchor, true, true);
      var current = anchor;
      relative.split(path.sep).filter(Boolean).forEach(function (part) {
        current = path.join(current, part);
        try { fs.lstatSync(current); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          fs.mkdirSync(current, { mode: 448 });
          privateGeneration(current);
        }
        client.privatePath(current, true, false);
      });
      client.privatePath(directory, true, true);
      var log = path.join(directory, contextId + ".err"), fd;
      if (fs.existsSync(log)) { client.privatePath(log, false, true); throw nativeError("NATIVE_PRIVATE_PATH_INVALID"); }
      try {
        fd = fs.openSync(log, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 384);
        var own = fs.fstatSync(fd, { bigint: true });
        client.privatePath(log, false, false);
        var named = fs.lstatSync(log, { bigint: true });
        if (own.dev !== named.dev || own.ino !== named.ino) throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
        protectNativeErrorLog(fd, directory, log);
        client.privatePath(log, false, true);
        named = fs.lstatSync(log, { bigint: true });
        if (own.dev !== named.dev || own.ino !== named.ino) throw nativeError("NATIVE_PRIVATE_PATH_INVALID");
        return fd;
      } catch (error) { if (fd !== undefined) fs.closeSync(fd); throw error; }
    }
  });
}
// The decoder has no config/custody authority. This fixed source-only property
// shares the identical projection and descriptor checks without a fake binding.
nativeErrorTransportBinding.json = function (value) { return transportJson(value, 20); };
nativeErrorTransportBinding.project = function (error) {
  var verified = verifyGeneration({ dir: path.resolve(__dirname, "../../..") });
  return transportProject(require(path.join(verified.runtime.mcpRoot, "web-native-messaging.cjs")), error);
};
module.exports = { BINDING_KEY: BINDING_KEY, EXTENSION_ID: EXTENSION_ID, initialize: initialize, protect: protect,
  redactProtected: redactProtected, flushProtection: flushProtection, readExtensionToken: readExtensionToken,
  nativeInventory: nativeInventory, publicCode: publicCode, privateGeneration: privateGeneration,
  captureNativeDiscoveryInputs: captureNativeDiscoveryInputs, verifyGeneration: verifyGeneration,
  validateNativeBinding: validateNativeBinding, getNativeBinding: getNativeBinding,
  nativeErrorTransportBinding: nativeErrorTransportBinding };
