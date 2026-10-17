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
  "src/factory/os-protect.js", "src/factory/windows-acl.js", "src/readiness/process-start.js"
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
  return NATIVE_FILES.map(function (file) {
    var bytes = publicCode(root, file), source = bytes.toString("utf8"), match;
    var literals = /\b(?:from|import)\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
    while (file !== "package.json" && (match = literals.exec(source))) {
      var target = match[1] || match[2], moduleApi = require("module");
      if (target[0] === ".") {
        if (NATIVE_FILES.indexOf(path.posix.normalize(path.posix.join(path.posix.dirname(file), target))) === -1)
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
      "bundleSha256,coreVersion,credentialSha256,guardedRegionProofs,mcpVersion,nativeHelperSha256,nativeRuntime,patchSourceSha256,revision" ||
      receipt.revision !== 3 || (installed.version !== undefined && receipt.mcpVersion !== installed.version) ||
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
  if (options.channel !== record.channel || browser.userDataDir !== record.userDataDir ||
      options.profileDirName !== record.profileDirName) throw nativeError("NATIVE_SELECTION_MISMATCH");
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
module.exports = { BINDING_KEY: BINDING_KEY, EXTENSION_ID: EXTENSION_ID, initialize: initialize, protect: protect,
  redactProtected: redactProtected, flushProtection: flushProtection, readExtensionToken: readExtensionToken,
  nativeInventory: nativeInventory, publicCode: publicCode, privateGeneration: privateGeneration,
  captureNativeDiscoveryInputs: captureNativeDiscoveryInputs, verifyGeneration: verifyGeneration,
  validateNativeBinding: validateNativeBinding, getNativeBinding: getNativeBinding };
