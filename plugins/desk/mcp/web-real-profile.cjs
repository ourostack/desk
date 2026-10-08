// The real-browser half of Desk's browser (see web.cjs): when a plugin declares `desk.browser`, `desk-web` drives the operator's own signed-in browser profile through the Playwright Extension instead of its headless, isolated default. Nothing here runs without that declaration.
//
// - The declaration is `"desk": { "browser": { "channel": "msedge" | "chrome", "profileAccountDomain": "<domain>" } }` in a plugin's `plugin.json`. It is found the way the factory store declaration is found (`src/factory/plugin-sources.cjs` lists the installed plugin folders). When several plugins declare one, the last folder listed wins, so the overlay loaded after Desk decides.
// - The profile is the one in the browser's own `Local State` profile list whose `user_name` (the signed-in account's address) ends in `@<profileAccountDomain>`.
// - The Playwright Extension keeps a connection token in the profile's local storage. The launcher reads it from a temporary copy of that folder (never from the live one, which the running browser locks), hands it to Playwright MCP in its environment and deletes the copy at once. The token is never printed, stored or put in a command line.
// - On macOS the agent works in its own window: before the first browser call is forwarded, the launcher opens a new window in that browser, brings it to the front so the extension's connect page lands there, and records its id. The window closes by that id when the agent calls `browser_close` and when the launcher ends (the host closing stdin, a stop signal or the browser process ending). It never quits the browser and never touches a window it did not open. Elsewhere there is no window opening: the connect page opens in the frontmost window, and the launcher says so once on stderr.
//
// Like web.cjs it must parse on very old Node, so it uses ES5 syntax and only built-ins (plugin-sources.cjs is loaded only when this mode is on).

"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

// The Playwright Extension's id in the Chrome Web Store (the same extension installs in Edge).
var EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
var INSTALL_URL = "https://chromewebstore.google.com/detail/playwright-extension/" + EXTENSION_ID;
var CHANNELS = { msedge: "Microsoft Edge", chrome: "Google Chrome" };
var MANIFESTS = ["plugin.json", path.join(".claude-plugin", "plugin.json"), path.join(".codex-plugin", "plugin.json")];
var DOMAIN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
var OSASCRIPT = "/usr/bin/osascript";
var OSASCRIPT_MS = 8000;
var MAX_MANIFEST = 1024 * 1024;
// plugin-sources.cjs checks plugin names, versions and repositories against these; the patterns match `PATTERNS` in src/factory/schema.js.
var PATTERNS = {
  pluginName: /^[a-z0-9][a-z0-9-]{0,63}$/,
  semver: /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]{1,32})?$/,
  prRepo: /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
};

function either(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---- the declaration ----

// The folders of the installed plugins, in the host's order. Copilot lists the folders beside Desk's own; Claude Code reads its plugin registry. A host whose list cannot be read gives none, which leaves the browser as it was.
function pluginDirs(o) {
  var env = either(o.env, process.env);
  var copilotRoot = env.COPILOT_PLUGIN_ROOT;
  var pluginRoot = copilotRoot || env.DESK_PLUGIN_ROOT || path.join(__dirname, "..");
  try {
    return require("./src/factory/plugin-sources.cjs").metadata({
      host: copilotRoot ? "copilot" : "claude",
      pluginRoot: pluginRoot,
      home: o.homeDir,
      env: env,
      readSmallText: function (file) {
        return fs.readFileSync(file, "utf8");
      },
      PATTERNS: PATTERNS,
      sources: false
    }).dirs;
  } catch (error) {
    return [];
  }
}

function readManifest(dir) {
  for (var index = 0; index < MANIFESTS.length; index += 1) {
    var file = path.join(dir, MANIFESTS[index]);
    try {
      var text = fs.readFileSync(file, "utf8");
      if (text.length > MAX_MANIFEST) continue;
      var json = JSON.parse(text);
      if (isObject(json)) return { file: file, json: json };
    } catch (error) {
      // A missing or unreadable manifest declares nothing.
    }
  }
  return null;
}

// What the installed plugins declare: { state: "none" } (today's headless browser), { state: "declared", channel, domain }, or { state: "invalid", summary } for a `desk.browser` that cannot be used.
function readDeclaration(o) {
  var dirs = either(o.pluginDirs, pluginDirs)(o);
  var found = null;
  dirs.forEach(function (dir) {
    var manifest = readManifest(dir);
    if (manifest !== null && isObject(manifest.json.desk) && manifest.json.desk.browser !== undefined) found = { file: manifest.file, browser: manifest.json.desk.browser };
  });
  if (found === null) return { state: "none" };
  var browser = found.browser;
  if (!isObject(browser) || !Object.prototype.hasOwnProperty.call(CHANNELS, browser.channel) || typeof browser.profileAccountDomain !== "string" || !DOMAIN.test(browser.profileAccountDomain)) {
    return { state: "invalid", summary: "The plugin manifest " + found.file + " has a desk.browser setting Desk cannot use: it needs a channel of msedge or chrome and a profileAccountDomain such as microsoft.com" };
  }
  return { state: "declared", channel: browser.channel, domain: browser.profileAccountDomain.toLowerCase() };
}

// ---- the profile ----

// The folder that holds the browser's `Local State` and its profile folders.
function userDataDir(channel, platform, env, homeDir) {
  var edge = channel === "msedge";
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", edge ? "Microsoft Edge" : path.join("Google", "Chrome"));
  if (platform === "win32") return path.win32.join(either(env.LOCALAPPDATA, path.win32.join(homeDir, "AppData", "Local")), edge ? "Microsoft\\Edge" : "Google\\Chrome", "User Data");
  return path.join(either(env.XDG_CONFIG_HOME, path.join(homeDir, ".config")), edge ? "microsoft-edge" : "google-chrome");
}

// The profile folder name (for example `Default` or `Profile 1`) whose signed-in account ends in `@<domain>`, from `Local State`'s `profile.info_cache` (each profile's `user_name` is its account address); the profile the browser used last wins when several match. Null when the file cannot be read or no profile matches.
function findProfileDir(localStatePath, domain) {
  var state;
  try {
    state = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
  } catch (error) {
    return null;
  }
  var profile = isObject(state) && isObject(state.profile) ? state.profile : {};
  var cache = isObject(profile.info_cache) ? profile.info_cache : {};
  var suffix = "@" + domain.toLowerCase();
  var matches = Object.keys(cache).filter(function (dir) {
    var name = isObject(cache[dir]) ? cache[dir].user_name : null;
    return typeof name === "string" && name.toLowerCase().slice(-suffix.length) === suffix;
  });
  if (matches.length === 0) return null;
  return matches.indexOf(profile.last_used) === -1 ? matches[0] : profile.last_used;
}

// ---- the token ----

// The token as the extension stored it: a one-byte encoding marker (0 for UTF-16, anything else for Latin-1) and then the text.
function decodeToken(value) {
  return value.slice(1).toString(value[0] === 0 ? "utf16le" : "latin1");
}

function scan(iterator, want) {
  return iterator.next().then(function (entry) {
    if (!entry) return null;
    return entry[0].equals(want) ? decodeToken(entry[1]) : scan(iterator, want);
  });
}

// The extension's token in a profile, or null when the profile has none (the extension is not installed there). Reads a copy of `Local Storage/leveldb` made without its LOCK file and removes the copy before it answers, whatever happens. `deps.level` is the `classic-level` module.
function readExtensionToken(profileDir, deps) {
  var source = path.join(profileDir, "Local Storage", "leveldb");
  if (!fs.existsSync(source)) return Promise.resolve(null);
  var copy = fs.mkdtempSync(path.join(deps.tmpdir, "desk-web-ls-"));
  function remove() {
    fs.rmSync(copy, { recursive: true, force: true });
  }
  var db = null;
  var iterator = null;
  var shut = Promise.resolve();
  return Promise.resolve().then(function () {
    fs.readdirSync(source).forEach(function (name) {
      if (name !== "LOCK") fs.copyFileSync(path.join(source, name), path.join(copy, name));
    });
    db = new deps.level.ClassicLevel(copy, { keyEncoding: "buffer", valueEncoding: "buffer", createIfMissing: false });
    iterator = db.iterator();
    return scan(iterator, Buffer.from("_chrome-extension://" + EXTENSION_ID + "\u0000\u0001auth-token", "latin1"));
  }).then(function (token) {
    return shutdown().then(function () {
      return token;
    });
  }, function (error) {
    return shutdown().then(function () {
      throw error;
    });
  });
  function shutdown() {
    shut = Promise.resolve().then(function () {
      return iterator === null ? null : iterator.close();
    }).then(function () {
      return db === null ? null : db.close();
    }).then(remove, remove);
    return shut;
  }
}

// ---- connecting ----

// What to start Playwright MCP with for a declaration: { args, env } or { payload } (a degraded answer that says what is missing).
// `o.declaration`, `o.installed` (the Playwright MCP install, whose folder also holds classic-level), `o.platform`, `o.env`, `o.homeDir`, `o.unavailable(code, summary, fix)` and `o.reconnectFix(action)`; `o.requireModule` and `o.tmpdir` are for tests.
function connect(o) {
  var declaration = o.declaration;
  var app = CHANNELS[declaration.channel];
  var statePath = path.join(userDataDir(declaration.channel, o.platform, o.env, o.homeDir), "Local State");
  var profile = findProfileDir(statePath, declaration.domain);
  if (profile === null) {
    return Promise.resolve({ payload: o.unavailable("browser_profile_not_found",
      "Desk looked for a " + app + " profile signed in to an @" + declaration.domain + " account in " + statePath + " and found none, so the browser is unavailable",
      o.reconnectFix("Sign in to your @" + declaration.domain + " account in " + app + ", or fix the desk.browser setting")) });
  }
  var missing = function () {
    return { payload: o.unavailable("browser_extension_missing",
      "The Playwright Extension is not installed in the " + app + " profile " + profile + " (the one signed in to @" + declaration.domain + "), so the browser is unavailable",
      o.reconnectFix("Install the Playwright Extension in that profile from " + INSTALL_URL)) };
  };
  var level;
  try {
    level = either(o.requireModule, require)(path.join(o.installed.dir, "node_modules", "classic-level"));
  } catch (error) {
    return Promise.resolve({ payload: o.unavailable("browser_token_unreadable",
      "Desk could not load the reader for the Playwright Extension's connection token (" + describe(error) + "), so the browser is unavailable",
      o.reconnectFix("Delete " + o.installed.dir + " so Desk installs the browser again")) });
  }
  return Promise.resolve().then(function () {
    return readExtensionToken(path.join(path.dirname(statePath), profile), { level: level, tmpdir: either(o.tmpdir, os.tmpdir()) });
  }).then(function (token) {
    if (token === null || token === "") return missing();
    var env = {};
    env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
    return { args: ["--extension", "--browser", declaration.channel, "--profile-dir-name", profile], env: env, profile: profile, app: app };
  }, function (error) {
    return { payload: o.unavailable("browser_token_unreadable",
      "Desk could not read the Playwright Extension's connection token from the " + app + " profile " + profile + " (" + describe(error) + "), so the browser is unavailable",
      o.reconnectFix("Check that the profile folder is readable")) };
  });
}

// ---- the agent's own window ----

// Runs one AppleScript through /usr/bin/osascript and resolves its trimmed output; rejects with osascript's own message.
function osascript(execFile) {
  return function (script) {
    return new Promise(function (resolve, reject) {
      execFile(OSASCRIPT, ["-e", script], { encoding: "utf8", timeout: OSASCRIPT_MS }, function (error, stdout) {
        if (error) reject(error);
        else resolve(String(stdout).trim());
      });
    });
  };
}

function openScript(app) {
  var page = encodeURIComponent("<title>Desk agent window</title><h1>Desk agent window</h1><p>An agent is using this window and will close it when its task is done.</p>");
  return "tell application \"" + app + "\"\nset w to make new window\nset URL of active tab of w to \"data:text/html," + page + "\"\nset index of w to 1\nreturn id of w\nend tell";
}

// Closes the window only if the browser still runs and still has it, so a window the operator already closed (or a browser they quit) is never reopened.
function closeScript(app, id) {
  return "if application \"" + app + "\" is running then\ntell application \"" + app + "\"\nif exists (first window whose id is " + id + ") then close (first window whose id is " + id + ")\nend tell\nend if";
}

// The one window this launcher opened, if any. `ensure()` opens it before the first browser call (once; again after `release()`), resolving null or { payload } when it cannot; `release()` closes it by its id and never rejects.
function windows(o) {
  var app = CHANNELS[o.channel];
  var id = null;
  var opening = null;
  var closing = null;
  var warned = false;
  function open() {
    return o.osascript(openScript(app)).then(function (answer) {
      if (!/^[0-9]+$/.test(answer)) throw new Error("it answered " + JSON.stringify(answer) + " instead of a window id");
      id = answer;
      return null;
    }).then(null, function (error) {
      return { payload: o.unavailable("browser_window_failed",
        "Desk could not open its own " + app + " window (" + describe(error) + "), so the browser is unavailable and no other window was touched",
        o.reconnectFix("Check that " + app + " can open a window")) };
    }).then(function (outcome) {
      opening = null;
      return outcome;
    });
  }
  function ensure() {
    if (o.platform !== "darwin") {
      if (!warned) o.stderr.write("[web] opening a separate " + app + " window works on macOS only; the connect page opens in the frontmost window\n");
      warned = true;
      return Promise.resolve(null);
    }
    if (id !== null) return Promise.resolve(null);
    if (opening === null) opening = open();
    return opening;
  }
  function closeRecorded() {
    if (id === null) return null;
    var target = id;
    id = null;
    return o.osascript(closeScript(app, target)).then(null, function (error) {
      o.stderr.write("[web] could not close the " + app + " window " + target + ": " + describe(error) + "\n");
    });
  }
  function release() {
    if (closing === null) {
      closing = Promise.resolve(opening).then(closeRecorded).then(function () {
        closing = null;
      });
    }
    return closing;
  }
  return { ensure: ensure, release: release };
}

module.exports = {
  CHANNELS: CHANNELS,
  EXTENSION_ID: EXTENSION_ID,
  INSTALL_URL: INSTALL_URL,
  closeScript: closeScript,
  connect: connect,
  findProfileDir: findProfileDir,
  openScript: openScript,
  osascript: function (execFile) {
    return osascript(either(execFile, childProcess.execFile));
  },
  pluginDirs: pluginDirs,
  readDeclaration: readDeclaration,
  readExtensionToken: readExtensionToken,
  userDataDir: userDataDir,
  windows: windows
};
