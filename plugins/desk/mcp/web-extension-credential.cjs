"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");

var EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
var BINDING_KEY = "DESK_BROWSER_PROFILE_DIR";
var redactors = new WeakMap();

function protect(proc, token) {
  var forms = redactors.get(proc);
  if (!forms) {
    forms = [];
    redactors.set(proc, forms);
    [proc.stdout, proc.stderr].forEach(function (stream) {
      var write = stream.write;
      stream.write = function (chunk) {
        var args = Array.prototype.slice.call(arguments);
        if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
          args[0] = forms.reduce(function (text, form) {
            return text.split(form).join("<token>");
          }, String(chunk));
        }
        return write.apply(stream, args);
      };
    });
  }
  if (!token) return;
  [token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1)].forEach(function (form) {
    if (forms.indexOf(form) === -1) forms.push(form);
  });
  forms.sort(function (a, b) { return b.length - a.length; });
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

module.exports = { BINDING_KEY: BINDING_KEY, EXTENSION_ID: EXTENSION_ID, initialize: initialize, protect: protect, readExtensionToken: readExtensionToken };
