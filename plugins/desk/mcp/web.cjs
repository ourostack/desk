// Desk's browser: the desk-web MCP server.
//
// browser_context opens one of two browsers and closes it again:
//   fresh  an empty throwaway profile in a private temp folder;
//   mine   a private copy of the person's own Edge (or Chrome) profile, so their sign-ins work.
// Both run headless as separate processes with their own user-data folder, through the Playwright
// CLI that ships inside playwright-core (it talks to the browser over a pipe, never a debugging
// port). So Desk never focuses a window, attaches to, closes or changes the person's running
// browser, or touches another agent's browser. Closing a context deletes its folder.
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
var SESSION = "desk";
var INSTALL_MS = 180000;
var OPEN_MS = 120000;
var COMMAND_MS = 120000;
// Commands that would open, close, re-point or attach a browser, or reach other sessions. Only browser_context opens and closes.
var REFUSED = ["open", "attach", "detach", "close", "close-all", "kill-all", "list", "delete-data", "install", "install-browser",
  "config-print", "show", "tray", "pause-at", "resume", "step-over"];
var REFUSED_OPTIONS = ["-s", "--session", "--config", "--profile", "--browser", "--persistent", "--headed", "--extension", "--endpoint", "--cdp-endpoint", "--help", "-h", "--version", "-v"];
// Parts of a profile that are large caches, belong to extensions, or would reopen the person's own tabs. Sign-ins live in Cookies, Local Storage and Login Data, which are kept.
var SKIP = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "CacheStorage", "ScriptCache",
  "Extensions", "Extension Scripts", "Extension State", "Extension Rules", "Local Extension Settings", "Sync Extension Settings",
  "File System", "Shared Dictionary", "IndexedDB", "WebStorage", "load_statistics.db", "WebAssistDatabase",
  "Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs", "SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"];

var BROWSERS = {
  msedge: { name: "Microsoft Edge", short: "Edge" },
  chrome: { name: "Google Chrome", short: "Chrome" }
};

function plain(message) {
  var error = new Error(message);
  error.plain = true;
  return error;
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

function envValue(env, name) {
  var key = Object.keys(env).filter(function (candidate) {
    return candidate.toUpperCase() === name;
  })[0];
  return key === undefined ? undefined : env[key];
}

// Desk's state folder for the browser: $DESK_BROWSER_STATE_DIR, else $XDG_STATE_HOME/ouroboros-skills/desk/browser, else ~/.local/state/ouroboros-skills/desk/browser.
function stateDir(env, homeDir) {
  if (env.DESK_BROWSER_STATE_DIR) return env.DESK_BROWSER_STATE_DIR;
  return path.join(env.XDG_STATE_HOME || path.join(homeDir, ".local", "state"), "ouroboros-skills", "desk", "browser");
}

// The npm that ships with a Node install: lib/node_modules/npm next to bin/node on macOS and Linux, node_modules\npm beside node.exe on Windows.
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
  if (platform === "win32") {
    var local = envValue(env, "LOCALAPPDATA") || path.win32.join(homeDir, "AppData", "Local");
    return channel === "chrome" ? path.win32.join(local, "Google", "Chrome", "User Data") : path.win32.join(local, "Microsoft", "Edge", "User Data");
  }
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", channel === "chrome" ? path.join("Google", "Chrome") : "Microsoft Edge");
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), channel === "chrome" ? "google-chrome" : "microsoft-edge");
}

function settings(o) {
  o = o || {};
  var env = o.env || process.env;
  var homeDir = o.homeDir || env.HOME || env.USERPROFILE || os.homedir();
  return {
    env: env,
    homeDir: homeDir,
    platform: o.platform || process.platform,
    fileExists: o.exists || exists,
    tmpDir: o.tmpDir || os.tmpdir(),
    stateRoot: stateDir(env, homeDir),
    node: o.node || process.execPath,
    profileRoots: o.profileRoots || null
  };
}

// The installed browser to drive: Edge first, then Chrome. For mine, only one whose profile folder exists.
function chooseBrowser(s, mine) {
  var order = ["msedge", "chrome"];
  for (var index = 0; index < order.length; index += 1) {
    var channel = order[index];
    var found = browserDiscovery.channelBrowserSelection(channel, s.platform, s.env, s.fileExists);
    if (!found.executablePath) continue;
    var root = s.profileRoots ? s.profileRoots[channel] : profileRoot(channel, s.platform, s.env, s.homeDir);
    if (mine && !(root && exists(path.join(root, "Local State")))) continue;
    return { channel: channel, executablePath: found.executablePath, profileRoot: root };
  }
  if (mine) throw plain("Desk could not find your own Edge or Chrome profile on this computer. Use a fresh browser instead (browser: \"fresh\").");
  throw plain("Desk needs Microsoft Edge or Google Chrome to open a browser, and found neither. Install one, then try again.");
}

// Copy the person's last-used profile and Local State (which holds the key their sign-ins are encrypted with) into the context folder.
function copyProfile(source, dest) {
  var name = "Default";
  try {
    var local = JSON.parse(fs.readFileSync(path.join(source, "Local State"), "utf8"));
    if (local && local.profile && typeof local.profile.last_used === "string" && local.profile.last_used) name = local.profile.last_used;
  } catch (error) {
    // an unreadable Local State fails the copy below with the plain message
  }
  if (name.indexOf("/") !== -1 || name.indexOf("\\") !== -1 || name === "..") name = "Default";
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

// Run the Playwright CLI in a context folder; resolves { code, stdout, stderr }.
function runCli(s, cli, cwd, args, timeoutMs) {
  return new Promise(function (resolve) {
    childProcess.execFile(s.node, [cli, "--session=" + SESSION].concat(args), {
      cwd: cwd, env: s.env, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "utf8"
    }, function (error, stdout, stderr) {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), timedOut: Boolean(error && error.killed) });
    });
  });
}

// ---- installing playwright-core ----

var installing = null;

function cliPath(dir) {
  return path.join(dir, "node_modules", "playwright-core", "lib", "tools", "cli-client", "cli.js");
}

function ensurePlaywright(s) {
  var dir = path.join(s.stateRoot, "playwright-core-" + PLAYWRIGHT_VERSION);
  if (exists(cliPath(dir))) return Promise.resolve(dir);
  if (installing) return installing;
  installing = new Promise(function (resolve, reject) {
    var npm = npmCli(s.node, s.platform, s.fileExists);
    if (!npm) {
      reject(plain("Desk could not find npm next to Node (" + s.node + "), so it cannot install the browser driver. Reinstall Node.js with npm, then try again."));
      return;
    }
    fs.mkdirSync(s.stateRoot, { recursive: true });
    var staging = fs.mkdtempSync(path.join(s.stateRoot, "install-"));
    fs.writeFileSync(path.join(staging, "package.json"), "{\"private\":true}\n");
    var env = Object.assign({}, s.env, { npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false", npm_config_loglevel: "error" });
    childProcess.execFile(s.node, [npm, "install", "--no-save", "--ignore-scripts", "playwright-core@" + PLAYWRIGHT_VERSION], {
      cwd: staging, env: env, timeout: INSTALL_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024
    }, function (error, stdout, stderr) {
      if (error || !exists(cliPath(staging))) {
        var last = String(stderr || "").trim().split("\n").pop() || (error && error.message) || "";
        reject(plain("Desk could not install the browser driver (playwright-core " + PLAYWRIGHT_VERSION + ") with npm. Check the internet connection, then try again. npm said: " + last));
        return;
      }
      try {
        fs.renameSync(staging, dir);
      } catch (renameError) {
        // another Desk finished the same install first
        if (!exists(cliPath(dir))) {
          reject(plain("Desk installed the browser driver but could not move it into place: " + renameError.message));
          return;
        }
      }
      resolve(dir);
    });
  }).then(function (dir) {
    installing = null;
    return dir;
  }, function (error) {
    installing = null;
    throw error;
  });
  return installing;
}

// ---- contexts ----

function contextDir(s, id) {
  return path.join(s.tmpDir, PREFIX + id);
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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

function cleanError(text) {
  return String(text).split("\n").map(function (line) {
    return line.trim();
  }).filter(Boolean).slice(0, 6).join(" ");
}

function open(s, kind, owned) {
  if (kind !== "fresh" && kind !== "mine") throw plain("browser must be \"fresh\" or \"mine\".");
  var browser = chooseBrowser(s, kind === "mine");
  var id = crypto.randomUUID();
  var dir = contextDir(s, id);
  return ensurePlaywright(s).then(function (installed) {
    fs.mkdirSync(dir, { mode: 448 });
    owned[id] = dir;
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid, browser: kind }) + "\n");
    fs.mkdirSync(path.join(dir, ".playwright"));
    var profileDir = path.join(dir, "profile");
    var profileName = null;
    if (kind === "mine") {
      try {
        profileName = copyProfile(browser.profileRoot, profileDir);
      } catch (error) {
        throw plain("Desk could not copy your " + BROWSERS[browser.channel].short + " profile, probably because " + BROWSERS[browser.channel].short + " is using it. Close " + BROWSERS[browser.channel].short + ", or use a fresh browser (browser: \"fresh\").");
      }
    } else {
      fs.mkdirSync(profileDir, { mode: 448 });
    }
    var outputDir = path.join(s.stateRoot, "output", id);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(launchConfig(kind, browser, profileDir, profileName, outputDir)));
    return runCli(s, cliPath(installed), dir, ["open", "--config=config.json"], OPEN_MS);
  }).then(function (result) {
    if (result.code !== 0) throw plain("The browser did not start: " + (cleanError(result.stderr || result.stdout) || "no details") + ". Try again, or use a fresh browser.");
    return { contextId: id, browser: kind, app: BROWSERS[browser.channel].name, files: path.join(s.stateRoot, "output", id),
      note: "Runs in the background and leaves your own browser windows alone. Close it with browser_context action \"close\" when done." };
  }).catch(function (error) {
    return close(s, id, owned).then(function () {
      throw error;
    }, function () {
      throw error;
    });
  });
}

function close(s, id, owned) {
  var dir = contextDir(s, id);
  delete owned[id];
  if (!fs.existsSync(dir)) return Promise.resolve({ contextId: id, closed: true });
  var installed = path.join(s.stateRoot, "playwright-core-" + PLAYWRIGHT_VERSION);
  var stop = exists(cliPath(installed)) && fs.existsSync(path.join(dir, "config.json"))
    ? runCli(s, cliPath(installed), dir, ["close"], 30000) : Promise.resolve(null);
  return stop.then(function () {
    try {
      removeDir(dir);
    } catch (error) {
      throw plain("The browser closed, but Desk could not delete its folder " + dir + ": " + error.message);
    }
    return { contextId: id, closed: true };
  });
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
  if (typeof id !== "string" || !ID.test(id)) throw plain("contextId must be the id that browser_context open returned.");
  checkArgs(args);
  var dir = contextDir(s, id);
  var installed = path.join(s.stateRoot, "playwright-core-" + PLAYWRIGHT_VERSION);
  if (!fs.existsSync(path.join(dir, "config.json")) || !exists(cliPath(installed))) {
    throw plain("There is no open browser with that contextId. Open one with browser_context.");
  }
  return runCli(s, cliPath(installed), dir, args, COMMAND_MS).then(function (result) {
    var text = (result.stdout + (result.stderr ? "\n" + result.stderr : "")).trim();
    if (result.timedOut) throw plain("The command took longer than " + COMMAND_MS / 1000 + " seconds and was stopped.");
    if (result.code !== 0) throw plain(text || "The command failed.");
    return text;
  });
}

// Close what an earlier Desk process left open after it stopped without closing.
function sweep(s) {
  var entries = [];
  try {
    entries = fs.readdirSync(s.tmpDir);
  } catch (error) {
    return Promise.resolve();
  }
  var stale = entries.filter(function (name) {
    if (name.indexOf(PREFIX) !== 0 || !ID.test(name.slice(PREFIX.length))) return false;
    var owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(s.tmpDir, name, "owner.json"), "utf8"));
    } catch (error) {
      return false;
    }
    if (!owner || typeof owner.pid !== "number" || owner.pid === process.pid) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  });
  return stale.reduce(function (chain, name) {
    return chain.then(function () {
      return close(s, name.slice(PREFIX.length), {}).catch(function () {});
    });
  }, Promise.resolve());
}

// ---- MCP ----

function createController(o) {
  var s = settings(o);
  var owned = {};
  function result(promise) {
    return Promise.resolve().then(promise).then(function (value) {
      return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError: false };
    }, function (error) {
      return { content: [{ type: "text", text: error && error.plain ? error.message : "Desk's browser hit an unexpected problem: " + (error && error.message || String(error)) }], isError: true };
    });
  }
  return {
    settings: s,
    owned: owned,
    call: function (name, input) {
      input = input || {};
      if (name === "browser_context") {
        return result(function () {
          if (input.action === "open") return open(s, input.browser || "fresh", owned);
          if (input.action === "close") {
            if (typeof input.contextId !== "string" || !ID.test(input.contextId)) throw plain("contextId must be the id that browser_context open returned.");
            return close(s, input.contextId, owned);
          }
          throw plain("action must be \"open\" or \"close\".");
        });
      }
      if (name === "browser_command") return result(function () { return command(s, input.contextId, input.args); });
      return result(function () { throw plain("Unknown tool " + name + "."); });
    },
    closeAll: function () {
      return Promise.all(Object.keys(owned).map(function (id) {
        return close(s, id, owned).catch(function () {});
      }));
    },
    sweep: function () {
      return sweep(s);
    }
  };
}

function serve(o) {
  o = o || {};
  var stdin = o.stdin || process.stdin;
  var stdout = o.stdout || process.stdout;
  var controller = createController(o);
  var tools = require("./web-catalog.json").tools;
  var buffered = "";
  var pending = [];
  function send(message) {
    stdout.write(JSON.stringify(message) + "\n");
  }
  function handle(line) {
    var message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!message || typeof message !== "object" || message.id === undefined) return;
    var params = message.params || {};
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "desk-web", version: "2.0.0" } } });
    } else if (message.method === "ping") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: tools } });
    } else if (message.method === "tools/call") {
      pending.push(controller.call(params.name, params.arguments).then(function (body) {
        send({ jsonrpc: "2.0", id: message.id, result: body });
      }));
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
    }
  }
  controller.sweep();
  return new Promise(function (resolve) {
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      Promise.all(pending).then(function () {
        return controller.closeAll();
      }).then(resolve, resolve);
    }
    stdin.setEncoding("utf8");
    stdin.on("data", function (chunk) {
      buffered += chunk;
      var newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        var line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) handle(line);
      }
    });
    stdin.on("end", finish);
    stdin.on("error", finish);
    if (o.signals !== false) {
      ["SIGINT", "SIGTERM", "SIGHUP"].forEach(function (signal) {
        process.once(signal, function () {
          finish();
          controller.closeAll().then(function () {
            process.exit(0);
          });
        });
      });
    }
    if (stdin.resume) stdin.resume();
  });
}

function run(o) {
  return serve(o);
}

module.exports = {
  BROWSER_TOOL_NAMES: BROWSER_TOOL_NAMES,
  PLAYWRIGHT_VERSION: PLAYWRIGHT_VERSION,
  stateDir: stateDir,
  npmCli: npmCli,
  profileRoot: profileRoot,
  copyProfile: copyProfile,
  launchConfig: launchConfig,
  createController: createController,
  ensurePlaywright: function (o) {
    return ensurePlaywright(settings(o));
  },
  run: run
};

if (require.main === module) run();
