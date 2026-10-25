// Desk's browser: the desk-web MCP server.
//
// browser_context opens one of two browsers and closes it again:
//   fresh  an empty throwaway profile in a private temp folder;
//   mine   a private copy of the person's own Edge (or Chrome) profile, so their sign-ins work.
// Each runs headless as its own browser process with its own user-data folder, driven by the
// Playwright CLI inside playwright-core, which talks to the browser over a pipe, not a debugging
// port. So Desk never focuses a window, never attaches to, closes or changes the person's running
// browser, and never touches another agent's browser. Closing a context deletes its folder.
//
// browser_command runs one Playwright CLI page command (snapshot, click, fill, goto, ...) in it.
//
// playwright-core is installed with npm into Desk's state folder on the first open.

"use strict";

var childProcess = require("child_process");
var crypto = require("crypto");
var fs = require("fs");
var os = require("os");
var path = require("path");
var browserDiscovery = require("./web-browser-discovery.cjs");

var PLAYWRIGHT_VERSION = "1.63.0";
var BROWSER_TOOL_NAMES = ["browser_context", "browser_command"];
var ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var PREFIX = "desk-browser-";
// Each context folder is its own Playwright CLI workspace, so one fixed session name per folder is enough.
var SESSION = "desk";
// Commands that would open, close, re-point or attach a browser, or reach other sessions. Only browser_context opens and closes.
var REFUSED = ["open", "attach", "detach", "close", "close-all", "kill-all", "list", "delete-data", "install", "install-browser",
  "config-print", "show", "tray", "pause-at", "resume", "step-over"];
var REFUSED_OPTIONS = ["-s", "--session", "--config", "--profile", "--browser", "--persistent", "--headed", "--extension",
  "--endpoint", "--cdp-endpoint", "--help", "-h", "--version", "-v"];
// Parts of a profile that are large caches, belong to extensions, or would reopen the person's own tabs. Sign-ins live in Cookies, Local Storage and Login Data, which are kept.
var SKIP = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "CacheStorage",
  "ScriptCache", "Extensions", "Extension Scripts", "Extension State", "Extension Rules", "Local Extension Settings",
  "Sync Extension Settings", "File System", "Shared Dictionary", "IndexedDB", "WebStorage", "load_statistics.db",
  "WebAssistDatabase", "Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs"];
var BROWSERS = { msedge: { name: "Microsoft Edge", short: "Edge" }, chrome: { name: "Google Chrome", short: "Chrome" } };

function plain(message) {
  return Object.assign(new Error(message), { plain: true });
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

// Desk's state folder for the browser: $DESK_BROWSER_STATE_DIR, else $XDG_STATE_HOME/ouroboros-skills/desk/browser, else ~/.local/state/ouroboros-skills/desk/browser.
function stateDir(env, homeDir) {
  if (env.DESK_BROWSER_STATE_DIR) return env.DESK_BROWSER_STATE_DIR;
  return path.join(env.XDG_STATE_HOME || path.join(homeDir, ".local", "state"), "ouroboros-skills", "desk", "browser");
}

// The npm that ships with a Node install: lib/node_modules/npm next to bin/node on macOS and Linux, node_modules\npm beside node.exe on Windows. Both the path as found and its real path are tried, because a version manager or Homebrew may link node from elsewhere.
function npmCli(node, platform, fileExists) {
  var real = node;
  try {
    real = fs.realpathSync(node);
  } catch (error) {
    // keep the path as given
  }
  var candidates = [node, real].map(function (file) {
    return platform === "win32"
      ? path.win32.join(path.win32.dirname(file), "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(path.dirname(file), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  });
  return browserDiscovery.firstExisting(candidates, fileExists);
}

// Where each browser keeps its profiles.
function profileRoot(channel, platform, env, homeDir) {
  var chrome = channel === "chrome";
  if (platform === "win32") {
    var local = env.LOCALAPPDATA || path.win32.join(homeDir, "AppData", "Local");
    return chrome ? path.win32.join(local, "Google", "Chrome", "User Data") : path.win32.join(local, "Microsoft", "Edge", "User Data");
  }
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", chrome ? "Google/Chrome" : "Microsoft Edge");
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), chrome ? "google-chrome" : "microsoft-edge");
}

function settings(o) {
  var env = o.env || process.env;
  var homeDir = o.homeDir || os.homedir();
  var platform = o.platform || process.platform;
  var fileExists = o.exists || exists;
  var node = o.node || process.execPath;
  return {
    env: env, homeDir: homeDir, platform: platform, fileExists: fileExists, node: node,
    npmCli: o.npmCli === undefined ? npmCli(node, platform, fileExists) : o.npmCli,
    tmpDir: o.tmpDir || os.tmpdir(),
    stateRoot: stateDir(env, homeDir),
    profileRoots: o.profileRoots || {},
    installMs: o.installMs || 180000,
    openMs: o.openMs || 120000,
    commandMs: o.commandMs || 120000
  };
}

// The installed browser to drive: Edge first, then Chrome. For mine, only one whose profile folder exists.
function chooseBrowser(s, mine) {
  var found = ["msedge", "chrome"].map(function (channel) {
    var selected = browserDiscovery.channelBrowserSelection(channel, s.platform, s.env, s.fileExists);
    var root = s.profileRoots[channel] || profileRoot(channel, s.platform, s.env, s.homeDir);
    return { channel: channel, executablePath: selected.executablePath, profileRoot: root };
  }).filter(function (browser) {
    return browser.executablePath && (!mine || exists(path.join(browser.profileRoot, "Local State")));
  });
  if (found.length) return found[0];
  if (mine) throw plain("Desk could not find your own Edge or Chrome profile on this computer. Use a fresh browser instead (browser: \"fresh\").");
  throw plain("Desk needs Microsoft Edge or Google Chrome to open a browser, and found neither. Install one, then try again.");
}

// Copy the person's last-used profile, and Local State, which holds the key their sign-ins are encrypted with.
function copyProfile(source, dest) {
  var name = "Default";
  try {
    var last = JSON.parse(fs.readFileSync(path.join(source, "Local State"), "utf8")).profile.last_used;
    if (typeof last === "string" && /^[^/\\]+$/.test(last) && last !== "..") name = last;
  } catch (error) {
    // no usable last_used: copy Default
  }
  fs.mkdirSync(dest, { mode: 448 });
  fs.copyFileSync(path.join(source, "Local State"), path.join(dest, "Local State"));
  fs.cpSync(path.join(source, name), path.join(dest, name), {
    recursive: true,
    filter: function (file) {
      return SKIP.indexOf(path.basename(file)) === -1;
    }
  });
  return name;
}

function launchConfig(kind, browser, profileDir, profileName, outputDir) {
  var launch = { channel: browser.channel, executablePath: browser.executablePath, headless: true, args: ["--no-first-run", "--no-default-browser-check"] };
  if (kind === "mine") {
    // Playwright's mock keychain and basic password store would hide the saved sign-ins; sync stays off so the copy never writes back to the person's account.
    launch.ignoreDefaultArgs = ["--use-mock-keychain", "--password-store=basic"];
    launch.args.push("--profile-directory=" + profileName, "--disable-sync");
  }
  return { browser: { browserName: "chromium", isolated: false, userDataDir: profileDir, launchOptions: launch }, outputDir: outputDir };
}

// ---- the Playwright CLI ----

function cliPath(s) {
  return path.join(s.stateRoot, "playwright-core-" + PLAYWRIGHT_VERSION, "node_modules", "playwright-core", "lib", "tools", "cli-client", "cli.js");
}

// Run the Playwright CLI in a context folder; resolves { code, text, timedOut }.
function runCli(s, cwd, args, timeoutMs) {
  return new Promise(function (resolve) {
    childProcess.execFile(s.node, [cliPath(s), "--session=" + SESSION].concat(args), {
      cwd: cwd, env: s.env, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "utf8"
    }, function (error, stdout, stderr) {
      resolve({ code: error ? 1 : 0, text: (stdout + "\n" + stderr).trim(), timedOut: Boolean(error && error.killed) });
    });
  });
}

var installing = {};

function installPlaywright(s) {
  if (!s.npmCli) {
    return Promise.reject(plain("Desk could not find npm next to Node (" + s.node + "), so it cannot install the browser driver. Reinstall Node.js with npm, then try again."));
  }
  var dir = path.join(s.stateRoot, "playwright-core-" + PLAYWRIGHT_VERSION);
  fs.mkdirSync(s.stateRoot, { recursive: true });
  var staging = fs.mkdtempSync(path.join(s.stateRoot, "install-"));
  fs.writeFileSync(path.join(staging, "package.json"), "{\"private\":true}\n");
  var env = Object.assign({}, s.env, { npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false", npm_config_loglevel: "error", npm_config_fetch_retries: "1", npm_config_fetch_timeout: "20000" });
  return new Promise(function (resolve, reject) {
    childProcess.execFile(s.node, [s.npmCli, "install", "--no-save", "--ignore-scripts", "playwright-core@" + PLAYWRIGHT_VERSION], {
      cwd: staging, env: env, timeout: s.installMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8"
    }, function (error, stdout, stderr) {
      var installed = path.join(staging, path.relative(dir, cliPath(s)));
      if (error || !exists(installed)) {
        reject(plain("Desk could not install the browser driver (playwright-core " + PLAYWRIGHT_VERSION + ") with npm. Check the internet connection, then try again. npm said: " + (stderr.trim().split("\n").filter(function (line) { return line.indexOf("complete log") === -1; }).pop() || "nothing")));
        return;
      }
      try {
        fs.renameSync(staging, dir);
      } catch (renameError) {
        // Another Desk process finished the same install first; its copy is used.
      }
      resolve();
    });
  });
}

function ensurePlaywright(s) {
  if (exists(cliPath(s))) return Promise.resolve();
  var key = s.stateRoot;
  if (!installing[key]) {
    installing[key] = installPlaywright(s).then(function () {
      delete installing[key];
      if (!exists(cliPath(s))) throw plain("Desk installed the browser driver but could not put it in place in " + s.stateRoot + ". Try again.");
    }, function (error) {
      delete installing[key];
      throw error;
    });
  }
  return installing[key];
}

// ---- contexts ----

function contextDir(s, id) {
  return path.join(s.tmpDir, PREFIX + id);
}

function open(s, kind) {
  if (kind !== "fresh" && kind !== "mine") throw plain("browser must be \"fresh\" or \"mine\".");
  var browser = chooseBrowser(s, kind === "mine");
  var short = BROWSERS[browser.channel].short;
  var id = crypto.randomUUID();
  var dir = contextDir(s, id);
  var outputDir = path.join(s.stateRoot, "output", id);
  return ensurePlaywright(s).then(function () {
    fs.mkdirSync(dir, { mode: 448 });
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid, browser: kind }) + "\n");
    fs.mkdirSync(path.join(dir, ".playwright"));
    var profileDir = path.join(dir, "profile");
    var profileName = null;
    if (kind === "mine") {
      try {
        profileName = copyProfile(browser.profileRoot, profileDir);
      } catch (error) {
        throw plain("Desk could not copy your " + short + " profile, probably because " + short + " is using it. Close " + short + ", or use a fresh browser (browser: \"fresh\").");
      }
    } else {
      fs.mkdirSync(profileDir, { mode: 448 });
    }
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(launchConfig(kind, browser, profileDir, profileName, outputDir)));
    return runCli(s, dir, ["open", "--config=config.json"], s.openMs);
  }).then(function (result) {
    if (result.code !== 0) throw plain("The browser did not start. Try again, or use a fresh browser. Details: " + result.text.slice(-1500));
    return {
      contextId: id, browser: kind, app: BROWSERS[browser.channel].name, files: outputDir,
      note: "Runs in the background and leaves your own browser windows alone. Close it with browser_context action \"close\" when done."
    };
  }).catch(function (error) {
    return close(s, id).then(function () {
      throw error;
    });
  });
}

// A browser that just exited can hold its files for a moment, most often on Windows, so a refused removal is retried for about two seconds.
function removeDir(dir) {
  for (var attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 10 || ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].indexOf(error.code) === -1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function close(s, id) {
  var dir = contextDir(s, id);
  var stop = fs.existsSync(path.join(dir, "config.json")) && exists(cliPath(s)) ? runCli(s, dir, ["close"], 30000) : Promise.resolve();
  return stop.then(function () {
    removeDir(dir);
    return { contextId: id, closed: true };
  });
}

function checkId(id) {
  if (typeof id !== "string" || !ID.test(id)) throw plain("contextId must be the id that browser_context open returned.");
}

function checkArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some(function (arg) { return typeof arg !== "string"; })) {
    throw plain("args must be a list of strings, for example [\"snapshot\"].");
  }
  if (REFUSED.indexOf(args[0]) !== -1) {
    throw plain("\"" + args[0] + "\" is not available here. Open and close browsers with browser_context; browser_command runs page commands such as snapshot, click and goto.");
  }
  var end = args.indexOf("--");
  (end === -1 ? args : args.slice(0, end)).forEach(function (arg) {
    var name = arg.split("=")[0];
    if (REFUSED_OPTIONS.indexOf(name) !== -1) throw plain("The option " + name + " is not available here; the browser is chosen when browser_context opens it.");
  });
}

function command(s, id, args) {
  checkId(id);
  checkArgs(args);
  var dir = contextDir(s, id);
  if (!fs.existsSync(path.join(dir, "config.json"))) throw plain("There is no open browser with that contextId. Open one with browser_context.");
  return runCli(s, dir, args, s.commandMs).then(function (result) {
    if (result.timedOut) throw plain("The command took longer than " + s.commandMs / 1000 + " seconds and was stopped.");
    if (result.code !== 0) throw plain(result.text || "The command failed.");
    return result.text;
  });
}

function ownerGone(file) {
  try {
    process.kill(JSON.parse(fs.readFileSync(file, "utf8")).pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// Close what an earlier Desk process left open when it stopped without closing.
function sweep(s) {
  var names = fs.existsSync(s.tmpDir) ? fs.readdirSync(s.tmpDir) : [];
  var stale = names.filter(function (name) {
    return name.indexOf(PREFIX) === 0 && ID.test(name.slice(PREFIX.length)) && ownerGone(path.join(s.tmpDir, name, "owner.json"));
  });
  return stale.reduce(function (chain, name) {
    return chain.then(function () {
      return close(s, name.slice(PREFIX.length));
    });
  }, Promise.resolve());
}

// ---- MCP ----

function createController(options) {
  var s = settings(options || {});
  var owned = {};
  function answer(work) {
    return Promise.resolve().then(work).then(function (value) {
      return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError: false };
    }, function (error) {
      return { content: [{ type: "text", text: error.plain ? error.message : "Desk's browser hit an unexpected problem: " + error.message }], isError: true };
    });
  }
  function context(input) {
    if (input.action === "open") {
      return open(s, input.browser || "fresh").then(function (opened) {
        owned[opened.contextId] = true;
        return opened;
      });
    }
    if (input.action !== "close") throw plain("action must be \"open\" or \"close\".");
    checkId(input.contextId);
    delete owned[input.contextId];
    return close(s, input.contextId);
  }
  return {
    settings: s,
    call: function (name, input) {
      var given = input || {};
      if (name === "browser_context") return answer(function () { return context(given); });
      if (name === "browser_command") return answer(function () { return command(s, given.contextId, given.args); });
      return answer(function () { throw plain("Unknown tool " + name + "."); });
    },
    closeAll: function () {
      return Promise.all(Object.keys(owned).map(function (id) {
        delete owned[id];
        return close(s, id);
      }));
    },
    sweep: function () {
      return Promise.resolve().then(function () {
        return sweep(s);
      }).catch(function (error) {
        return error;
      });
    }
  };
}

// options: stdin, stdout, signals (an emitter of SIGINT/SIGTERM/SIGHUP), exit, plus the controller's own settings.
function serve(o) {
  var stdin = o.stdin;
  var controller = createController(o);
  var tools = require("./web-catalog.json").tools;
  var pending = [];
  var buffered = "";
  function send(id, body) {
    o.stdout.write(JSON.stringify(Object.assign({ jsonrpc: "2.0", id: id }, body)) + "\n");
  }
  function handle(line) {
    var message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      send(null, { error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!message || message.id === undefined) return;
    var params = message.params || {};
    if (message.method === "initialize") {
      send(message.id, { result: { protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "desk-web", version: "2.0.0" } } });
    } else if (message.method === "ping") {
      send(message.id, { result: {} });
    } else if (message.method === "tools/list") {
      send(message.id, { result: { tools: tools } });
    } else if (message.method === "tools/call") {
      pending.push(controller.call(params.name, params.arguments).then(function (body) {
        send(message.id, { result: body });
      }));
    } else {
      send(message.id, { error: { code: -32601, message: "Method not found: " + message.method } });
    }
  }
  var swept = controller.sweep();
  return new Promise(function (resolve) {
    var finishing = null;
    function finish() {
      if (!finishing) {
        finishing = Promise.all(pending.concat([swept])).then(function () {
          return controller.closeAll();
        });
      }
      return finishing;
    }
    function stop() {
      o.exit(0);
    }
    ["SIGINT", "SIGTERM", "SIGHUP"].forEach(function (signal) {
      o.signals.once(signal, function () {
        finish().then(stop, stop);
      });
    });
    stdin.setEncoding("utf8");
    stdin.on("data", function (chunk) {
      buffered += chunk;
      var lines = buffered.split("\n");
      buffered = lines.pop();
      lines.forEach(function (line) {
        if (line.trim()) handle(line);
      });
    });
    stdin.on("end", function () {
      finish().then(resolve, resolve);
    });
    stdin.resume();
  });
}

module.exports = {
  BROWSER_TOOL_NAMES: BROWSER_TOOL_NAMES,
  PLAYWRIGHT_VERSION: PLAYWRIGHT_VERSION,
  npmCli: npmCli,
  profileRoot: profileRoot,
  copyProfile: copyProfile,
  createController: createController,
  serve: serve,
  run: run
};

/* istanbul ignore next -- the hosts start this with the real process; tests call serve() with their own streams */
function run() {
  return serve({ stdin: process.stdin, stdout: process.stdout, signals: process, exit: function (code) { process.exit(code); } });
}

/* istanbul ignore next -- Copilot starts this file directly */
if (require.main === module) run();
