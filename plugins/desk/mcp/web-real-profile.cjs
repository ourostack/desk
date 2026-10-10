// The real-browser half of Desk's browser (see web.cjs): when a plugin declares `desk.browser`, `desk-web` drives the operator's own signed-in browser profile through the Playwright Extension instead of its headless, isolated default. Nothing here runs without that declaration.
//
// - The declaration is `"desk": { "browser": { "channel": "msedge" | "chrome", "profileAccountDomain": "<domain>" } }` in a plugin's `plugin.json`. It is found the way the factory store declaration is found (`src/factory/plugin-sources.cjs` lists the installed plugin folders). When several plugins declare one, the last folder listed wins, so the overlay loaded after Desk decides.
// - The profile is the one in the browser's own `Local State` profile list whose `user_name` (the signed-in account's address) ends in `@<profileAccountDomain>`.
// - The Playwright Extension keeps a connection token in the profile's local storage. The launcher reads it from a temporary copy of that folder (never from the live one, which the running browser locks), hands it to Playwright MCP in its environment and deletes the copy at once. The token is never printed, stored or put in a command line, and the proxy replaces it in everything it passes on (web-proxy.cjs).
// - The agent works in a window of its own, on every platform and with no scripting of the browser. Before the first browser call reaches Playwright MCP, the launcher starts the real browser executable itself with `--new-window --profile-directory=<profile>` and a holding page. The running browser opens that as a new, focused window. Playwright MCP then opens the extension's connect page, which the browser puts in the last active window (this one), and the holding tab closes itself within 30 seconds (sooner if it is hidden). The window ends up holding only the connect tab, which the extension turns into the agent's tab.
// - Cleanup closes the agent's own tabs, never a window: it lists the tabs this connection controls once and closes that many (closing a window's last tab closes the window). It never lists again, because listing tabs makes Playwright MCP create one when none is left. `browser_close` runs that cleanup and is then answered here and not passed on, because Playwright MCP would open a new connect page, in a new window nobody owns, for a connection with no page left. The next call opens a new holding window and connects again. The cleanup also runs when the host closes stdin or stops the launcher, if the connection was used since the last close. It never quits the browser and never touches a tab it did not open.
//
// Like web.cjs it must parse on very old Node, so it uses ES5 syntax and only built-ins (plugin-sources.cjs is loaded only when this mode is on).

"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");

// The Playwright Extension's id in the Chrome Web Store (the same extension installs in Edge).
var EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
var INSTALL_URL = "https://chromewebstore.google.com/detail/playwright-extension/" + EXTENSION_ID;
var CHANNELS = { msedge: "Microsoft Edge", chrome: "Google Chrome" };
var MANIFESTS = ["plugin.json", path.join(".claude-plugin", "plugin.json"), path.join(".codex-plugin", "plugin.json")];
var DOMAIN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
// Each call to the browser during cleanup, and how many tabs one cleanup closes at most.
var TAB_CALL_MS = 2500;
var MAX_TABS = 50;
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
      "The Playwright Extension is not installed in the " + app + " profile " + profile + " (the one signed in to @" + declaration.domain + "), so the browser is unavailable",
      o.reconnectFix("If the extension is not installed, install it in that profile from " + INSTALL_URL + "; if it is already installed, click its toolbar icon once to open its page")) };
  };
  var level;
  try {
    level = either(o.requireModule, require)(path.join(o.installed.dir, "node_modules", "classic-level"));
  } catch (error) {
    return Promise.resolve({ payload: o.unavailable("browser_token_unreadable",
      "Desk could not load the reader for the Playwright Extension's connection token (" + describe(error) + "), so the browser is unavailable",
      o.reconnectFix("Check that this machine can reach the npm registry") + " If the problem persists after npm works, delete " + o.installed.dir + " so Desk installs the browser again.") });
  }
  return Promise.resolve().then(function () {
    return readExtensionToken(path.join(path.dirname(statePath), profile), { level: level, tmpdir: either(o.tmpdir, os.tmpdir()) });
  }).then(function (token) {
    if (token === null || token === "") return missing();
    var env = {};
    env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
    return { args: ["--extension", "--browser", declaration.channel, "--profile-dir-name", profile], env: env, secrets: [token], profile: profile, executable: o.executable, app: app };
  }, function (error) {
    return { payload: o.unavailable("browser_token_unreadable",
      "Desk could not read the Playwright Extension's connection token from the " + app + " profile " + profile + " (" + describe(error) + "), so the browser is unavailable",
      o.reconnectFix("Check that the profile folder is readable")) };
  });
}

// ---- the agent's own window ----

// The holding page: it closes itself within 30 seconds (sooner if it is hidden, as the connect page opening in the same window should make it). On a hidden event it changes its title first, so a live run can tell whether the event fires.
var HOLDING_PAGE = "<title>Agent window</title><p>An agent is using this window and will close it when its task is done.</p><script>document.addEventListener('visibilitychange',function(){if(document.hidden){document.title='Agent window (closing)';window.close()}});setTimeout(function(){window.close()},30000)</script>";
var OPEN_WAIT_MS = 1000;

// Opens a new, focused window in the running browser, with the declared profile, and resolves when it should exist. The browser is started directly (no shell) with the launcher's own environment, which holds no token, and is left to run on its own. `o.spawn`, `o.executable`, `o.profile`, `o.env`, `o.stderr`, `o.waitMs`.
function openWindow(o) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(resolve, either(o.waitMs, OPEN_WAIT_MS));
    function failed(error) {
      clearTimeout(timer);
      o.stderr.write("[web] could not open a new browser window: " + describe(error) + "\n");
      reject(error);
    }
    try {
      var child = o.spawn(o.executable, ["--new-window", "--profile-directory=" + o.profile, "data:text/html," + encodeURIComponent(HOLDING_PAGE)], { detached: true, stdio: "ignore", shell: false, windowsHide: true, env: o.env });
      child.on("error", failed);
      child.unref();
    } catch (error) {
      failed(error);
    }
  });
}

// ---- the agent's own tabs ----

// How many tabs a `browser_tabs` list names: the lines that start `- <index>:`.
function countTabs(result) {
  var text = result && Array.isArray(result.content) ? result.content.map(function (part) {
    return typeof part.text === "string" ? part.text : "";
  }).join("\n") : "";
  var lines = text.match(/^\s*-\s*\d+:/gm);
  return lines === null ? 0 : lines.length;
}

function noTabs(result) {
  return Boolean(result && Array.isArray(result.content) && result.content.some(function (part) {
    return typeof part.text === "string" && /No open tabs/.test(part.text);
  }));
}

function cleanupIncomplete(closed, remaining) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({
    status: "degraded",
    code: "browser_cleanup_incomplete",
    summary: "Desk could not verify that this connection's browser tabs are closed.",
    closed: closed,
    remaining: remaining,
    fix: "The existing connection is retained. Retry browser_close on this connection before opening a replacement. Do not close another agent's or the operator's window.",
  }) }] };
}

// Lists once, then closes no more than that snapshot or MAX_TABS. No final list: Playwright creates a tab when listing an empty connection. Only an explicit no-tabs response proves completion; failures retain the connection for retry.
function closeOwnTabs(call, callMs) {
  var ms = either(callMs, TAB_CALL_MS);
  var closed = 0;
  var remaining = null;
  function close(left) {
    if (left <= 0) return cleanupIncomplete(closed, remaining);
    return call("browser_tabs", { action: "close", index: 0 }, ms).then(function (result) {
      if (!result || result.isError) return cleanupIncomplete(closed, null);
      if (noTabs(result)) {
        closed += 1;
        return CLOSED;
      }
      remaining = countTabs(result) || null;
      if (remaining === null) return cleanupIncomplete(closed, null);
      closed += 1;
      return close(left - 1);
    });
  }
  return call("browser_tabs", { action: "list" }, ms).then(function (listed) {
    if (!listed || listed.isError) return cleanupIncomplete(closed, null);
    if (noTabs(listed)) return CLOSED;
    remaining = countTabs(listed) || null;
    return remaining === null ? cleanupIncomplete(closed, null) : close(Math.min(remaining, MAX_TABS));
  }).then(null, function () {
    return cleanupIncomplete(closed, null);
  });
}

// What `browser_close` answers once the agent's window is closed. The call is not passed on (see the header).
var CLOSED = { content: [{ type: "text", text: "The browser window this session opened is closed. The next browser call opens a new one." }] };

// The hooks the proxy calls for the agent's window and tabs. `open()` opens the holding window or resolves an error tool result. Before a call (other than `browser_close`) the window is opened once per connection; `afterCall` marks the connection as used only when a call succeeded, so cleanup never starts a connection. `browser_close` closes the tabs and answers itself, and the next call starts a new connection. The cleanup at the end of the session closes the tabs only if the connection was used since the last close.
function ownTabs(open, callMs) {
  var used = false;
  var opening = null;
  var cleaning = null;
  function cleanup(api) {
    if (cleaning !== null) return cleaning;
    if (!used) return Promise.resolve(CLOSED);
    cleaning = closeOwnTabs(api.callTool, callMs).then(function (result) {
      cleaning = null;
      if (!result.isError) used = false;
      return result;
    });
    return cleaning;
  }
  return {
    beforeCall: function beforeCall(params, api) {
      if (params.name === "browser_close") {
        return cleanup(api).then(function (result) {
          if (!result.isError) opening = null;
          return result;
        });
      }
      if (cleaning !== null) {
        return cleaning.then(function (result) {
          return result.isError ? result : beforeCall(params, api);
        });
      }
      if (opening === null) opening = open();
      var attempt = opening;
      return attempt.then(function (result) {
        if (result && result.isError) {
          if (opening === attempt) opening = null;
          return result;
        }
        return null;
      });
    },
    afterCall: function (params, failed) {
      if (!failed && params.name !== "browser_close") used = true;
    },
    cleanup: cleanup
  };
}

module.exports = {
  CHANNELS: CHANNELS,
  EXTENSION_ID: EXTENSION_ID,
  INSTALL_URL: INSTALL_URL,
  closeOwnTabs: closeOwnTabs,
  connect: connect,
  countTabs: countTabs,
  findProfileDir: findProfileDir,
  openWindow: openWindow,
  ownTabs: ownTabs,
  pluginDirs: pluginDirs,
  readDeclaration: readDeclaration,
  readExtensionToken: readExtensionToken,
  userDataDir: userDataDir
};
