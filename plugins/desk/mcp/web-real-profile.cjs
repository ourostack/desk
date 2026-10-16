// The real-browser half of Desk's browser (see web.cjs): when a plugin declares `desk.browser`, `desk-web` drives the operator's own signed-in browser profile through the stock Playwright Extension instead of its headless, isolated default. Nothing here runs without that declaration.
//
// - The declaration is `"desk": { "browser": { "channel": "msedge" | "chrome", "profileAccountDomain": "<domain>" } }` in a plugin's `plugin.json`. It is found the way the factory store declaration is found (`src/factory/plugin-sources.cjs` lists the installed plugin folders). When several plugins declare one, the last folder listed wins, so the overlay loaded after Desk decides.
// - The profile is the one in the browser's own `Local State` profile list whose `user_name` (the signed-in account's address) ends in `@<profileAccountDomain>`.
// - The launcher reads the extension token from a temporary copy of the selected profile's local storage. The staged acquisition patch re-reads that same profile before every new relay; web-real-tabs.cjs and the staged reader share in-memory output redaction. Stock Playwright still carries the token on its browser-launch command line.
// - The extension gives each connection its own tab group. Automatic tab cleanup is deferred; explicit close remains stock Playwright behavior.
//
// Like web.cjs it must parse on very old Node, so it uses ES5 syntax and only built-ins (plugin-sources.cjs is loaded only when this mode is on).

"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var credential = require("./web-extension-credential.cjs");
var readExtensionToken = credential.readExtensionToken;

// The Playwright Extension's id in the Chrome Web Store (the same extension installs in Edge).
var EXTENSION_ID = credential.EXTENSION_ID;
var INSTALL_URL = "https://chromewebstore.google.com/detail/playwright-extension/" + EXTENSION_ID;
var CHANNELS = { msedge: "Microsoft Edge", chrome: "Google Chrome" };
var MANIFESTS = ["plugin.json", path.join(".claude-plugin", "plugin.json"), path.join(".codex-plugin", "plugin.json")];
var DOMAIN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
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

function present(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// Whether a folder is inside Claude Code's plugin store, `<config dir>/plugins`, where it keeps every plugin it installs.
function underClaudePlugins(folder, env, homeDir) {
  var store = path.join(present(env.CLAUDE_CONFIG_DIR) || path.join(homeDir, ".claude"), "plugins") + path.sep;
  return path.resolve(folder).indexOf(store) === 0;
}

// Which host launched this server and which folder is Desk's own. The main Desk server decides the same way (`factoryPluginScan` in src/tools/factory-context.js, with `pluginRootFor` in src/factory/end-hook.js): Claude Code sets CLAUDE_PLUGIN_ROOT, and a session without it is Copilot's. Copilot (and Agency, which runs Copilot) sets neither it nor, for MCP servers, COPILOT_PLUGIN_ROOT, so the absence of the Claude variable must mean Copilot, never Claude. A Desk inside Claude's own plugin store is Claude's even if the variable did not reach this process. end-hook.js is an ES module and cannot be loaded here, so the rule is repeated, not shared.
function hostFor(env, homeDir, pluginRoot) {
  if (present(env.COPILOT_PLUGIN_ROOT) !== null) return "copilot";
  if (present(env.CLAUDE_PLUGIN_ROOT) !== null || underClaudePlugins(pluginRoot, env, homeDir)) return "claude";
  return "copilot";
}

// The folders of the installed plugins, in the host's order. Copilot (and Agency) lists the folders beside Desk's own; Claude Code reads its plugin registry. A host whose list cannot be read gives none, which leaves the browser as it was.
function pluginDirs(o) {
  var env = either(o.env, process.env);
  var homeDir = either(o.homeDir, os.homedir());
  var pluginRoot = present(env.COPILOT_PLUGIN_ROOT) || present(env.DESK_PLUGIN_ROOT) || present(env.CLAUDE_PLUGIN_ROOT) || path.join(__dirname, "..");
  try {
    return require("./src/factory/plugin-sources.cjs").metadata({
      host: hostFor(env, homeDir, pluginRoot),
      pluginRoot: pluginRoot,
      home: homeDir,
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

// ---- connecting ----

// What to start Playwright MCP with for a declaration: { args, env } or { payload } (a degraded answer that says what is missing). The user-data folder is passed explicitly, so Playwright opens the connect page in the same browser data the profile was found in.
// `o.declaration`, `o.installed` (the Playwright MCP install, whose folder also holds classic-level), `o.executable` (the browser's real executable, or null when it is not installed), `o.platform`, `o.env`, `o.homeDir`, `o.unavailable(code, summary, fix)` and `o.reconnectFix(action)`; `o.requireModule` and `o.tmpdir` are for tests.
function connect(o) {
  var declaration = o.declaration;
  var app = CHANNELS[declaration.channel];
  if (o.executable === null) {
    return Promise.resolve({ payload: o.unavailable("browser_not_installed",
      "Desk could not find " + app + " on this machine, so the browser is unavailable",
      o.reconnectFix("Install " + app)) });
  }
  var statePath = path.join(userDataDir(declaration.channel, o.platform, o.env, o.homeDir), "Local State");
  var profile = findProfileDir(statePath, declaration.domain);
  if (profile === null) {
    return Promise.resolve({ payload: o.unavailable("browser_profile_not_found",
      "Desk looked for a " + app + " profile signed in to an @" + declaration.domain + " account in " + statePath + " and found none, so the browser is unavailable",
      o.reconnectFix("Sign in to your @" + declaration.domain + " account in " + app + ", or fix the desk.browser setting")) });
  }
  var missing = function () {
    return { payload: o.unavailable("browser_extension_missing",
      "Desk found no usable persisted Playwright Extension credential in the " + app + " profile " + profile + " (the one signed in to @" + declaration.domain + "), so the browser is unavailable",
      "Stop browser calls and preserve the existing browser and profile. Automatic extension setup is not available through this launcher; record this binding as blocked for an admitted agent-owned repair, not an operator setup chore. Stock extension reference: " + INSTALL_URL + ".") };
  };
  var level;
  try {
    level = either(o.requireModule, require)(path.join(o.installed.dir, "node_modules", "classic-level"));
  } catch (error) {
    return Promise.resolve({ payload: o.unavailable("browser_token_unreadable",
      "Desk could not load the reader for the Playwright Extension's connection token (" + describe(error) + "), so the browser is unavailable",
      o.reconnectFix("Check that this machine can reach the npm registry") + " If the problem persists after npm works, delete " + o.installed.dir + " so Desk installs the browser again.") });
  }
  var deadline = Date.now() + 10000;
  var delay = 100;
  function readWhenPersisted() {
    return readExtensionToken(path.join(path.dirname(statePath), profile), { level: level, tmpdir: either(o.tmpdir, os.tmpdir()) }).then(function (token) {
      if (token !== null && token !== "") return token;
      var remaining = deadline - Date.now();
      if (remaining <= 0) return token;
      var wait = Math.min(delay, remaining);
      delay = Math.min(delay * 2, 1000);
      return new Promise(function (resolve) { setTimeout(resolve, wait); }).then(readWhenPersisted);
    });
  }
  // A newly initialized extension can take several seconds to commit its token.
  return Promise.resolve().then(readWhenPersisted).then(function (token) {
    if (token === null || token === "") return missing();
    var env = {};
    env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
    env[credential.BINDING_KEY] = path.resolve(path.dirname(statePath), profile);
    return { args: ["--extension", "--browser", declaration.channel, "--user-data-dir", path.dirname(statePath), "--profile-dir-name", profile], env: env, profile: profile, app: app };
  }, function (error) {
    return { payload: o.unavailable("browser_token_unreadable",
      "Desk could not read the Playwright Extension's connection token from the " + app + " profile " + profile + " (" + describe(error) + "), so the browser is unavailable",
      o.reconnectFix("Check that the profile folder is readable")) };
  });
}

module.exports = {
  CHANNELS: CHANNELS,
  EXTENSION_ID: EXTENSION_ID,
  INSTALL_URL: INSTALL_URL,
  connect: connect,
  findProfileDir: findProfileDir,
  pluginDirs: pluginDirs,
  readDeclaration: readDeclaration,
  readExtensionToken: readExtensionToken,
  userDataDir: userDataDir
};
