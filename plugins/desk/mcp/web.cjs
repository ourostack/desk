// Normal maintained-browser runtime preparation, discovery and detached refresh.
// These facades remain shared by private and signed-in explicit controllers.
// Installs publish a verified immutable generation under the existing lock;
// refresh never rewrites the generation of a retained daemon.
//
// The desk-web entry now starts the browser-only standard-SDK frontend with
// browser_context/browser_command. Handshake/list never acquire a browser.
// There is no routable legacy page-tool proxy or signed-in/private fallback.
//
// Like bootstrap.cjs it must parse on very old Node, so it uses ES5 syntax and only built-ins.

"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");
var bootstrap = require("./bootstrap.cjs");
var playwrightPatch = require("./web-playwright-patch.cjs");
var browserDiscovery = require("./web-browser-discovery.cjs");

var PACKAGE_NAME = "@playwright/mcp";
var PACKAGE = PACKAGE_NAME + "@latest";
// Installed beside Playwright MCP only when a plugin declares a real browser profile: classic-level so a real-browser launch can read the Playwright Extension's token from the profile's LevelDB (it ships prebuilt N-API binaries, so one install serves every Node), and ws for the tab-cleanup relay in web-real-tabs.cjs.
var LEVEL_PACKAGE = "classic-level@1.4.1";
var WS_PACKAGE = "ws@8.21.3";
// Left in an install folder when the reader could not be installed (for example, no prebuilt binary for this platform), so the install is not repeated at every launch.
var READER_UNAVAILABLE = "reader-unavailable";
// A marker this old is tried again once, because one transient npm failure should not leave a machine without the reader until the next release.
var READER_RETRY_MS = 24 * 60 * 60 * 1000;
var DEFAULT_ARGS = ["--headless", "--isolated"];
// Options that connect to a browser that already runs; with any of them Desk's headless and isolated defaults do not apply.
var CONNECT = ["--cdp-endpoint", "--extension", "--endpoint"];
// Options that already say which browser to drive or connect to; with any of them the launcher adds no browser choice of its own.
var BROWSER_CHOICE = ["--browser", "--executable-path"].concat(CONNECT);
var REFRESH_FLAG = "--desk-web-refresh";
var DEFAULT_PROTOCOL = "2025-06-18";
// Healthy and degraded entry points expose the same explicit-context catalog.
var BROWSER_TOOL_NAMES = ["browser_context", "browser_command"];
// npm without retries and with a short fetch timeout: an unreachable registry fails in seconds, not minutes.
var NPM_ENV = {
  npm_config_fetch_retries: "0",
  npm_config_fetch_timeout: "10000",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_loglevel: "error"
};
// How long the first install may take. A launch with no installed copy answers the host's handshake at once and holds browser calls meanwhile (web-proxy.cjs), so this is not bound by the host's connection timeout; it stays below the proxy's hold time for a call, so a call that arrives at start still gets the browser before it gives up.
var FIRST_INSTALL_MS = 110000;
var REFRESH_MS = 180000;
var WAIT_STEP_MS = 250;
var LOCK_STALE_MS = 10 * 60 * 1000;
// Older installs stay this long, so a long-running session never loses the files it started from.
var KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function either(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    return file;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return null;
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

// The file-system calls below need Node 14.14 or later, which every supported host runs; on an older host run() reports the failure in one line.
function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function hasOption(args, names) {
  return args.some(function (arg) {
    return names.some(function (name) {
      return arg === name || arg.indexOf(name + "=") === 0;
    });
  });
}

// ---- which browser ----

var browserPaths = browserDiscovery.browserPaths;
var channelBrowserSelection = browserDiscovery.channelBrowserSelection;
var firstExisting = browserDiscovery.firstExisting;

function browserSelection(args, platform, env, fileExists) {
  if (hasOption(args, BROWSER_CHOICE)) return { args: [], executablePath: null };
  var chrome = channelBrowserSelection("chrome", platform, env, fileExists);
  return chrome.executablePath ? chrome : channelBrowserSelection("msedge", platform, env, fileExists);
}

// Keep legacy MCP arguments unchanged; isolated clients also need the selected
// binary because their private environment no longer contains discovery paths.
function browserArgs(args, platform, env, fileExists) {
  return browserSelection(args, platform, env, fileExists).args;
}

// Everything passed to Playwright MCP: Desk's defaults (unless the caller connects to a running browser), the output folder in Desk's state folder (unless the caller chose one), then the caller's own options.
function launchArgs(args, platform, env, fileExists, root) {
  var base = hasOption(args, CONNECT) ? [] : DEFAULT_ARGS.concat(browserArgs(args, platform, env, fileExists));
  var output = hasOption(args, ["--output-dir"]) ? [] : ["--output-dir", path.join(root, "output")];
  return base.concat(output, args);
}

// ---- which npm and which Node ----

// The npm that ships with a Node install: lib/node_modules/npm next to bin/node on macOS and Linux, node_modules\npm beside node.exe on Windows. Both the path as found and its real path are tried, because a version manager or Homebrew may link node from elsewhere.
function npmCli(node, platform, fileExists) {
  var candidates = [node, realpath(node)].map(function (file) {
    return platform === "win32"
      ? path.win32.join(path.win32.dirname(file), "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(path.dirname(file), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  });
  return firstExisting(candidates, fileExists);
}

// A copy of env with the chosen Node's folder first on PATH, keeping the variable's own spelling (Windows uses Path).
function withNodeFirst(env, node, platform) {
  var copy = {};
  Object.keys(env).forEach(function (key) {
    copy[key] = env[key];
  });
  var key = Object.keys(copy).filter(function (name) {
    return name.toUpperCase() === "PATH";
  })[0] || "PATH";
  var separator = platform === "win32" ? ";" : ":";
  var dir = platform === "win32" ? path.win32.dirname(node) : path.dirname(node);
  copy[key] = copy[key] ? dir + separator + copy[key] : dir;
  return copy;
}

function npmEnv(env, node, platform) {
  var copy = withNodeFirst(env, node, platform);
  Object.keys(NPM_ENV).forEach(function (key) {
    copy[key] = NPM_ENV[key];
  });
  return copy;
}

// Run npm with the chosen Node; resolves { code, stdout, stderr } and never rejects. A call that outlives its time limit is killed and resolves with code null.
function npm(tools, args, timeoutMs) {
  return new Promise(function (resolve) {
    var out = "";
    var err = "";
    var done = false;
    var timer = null;
    function finish(code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      tools.children = tools.children.filter(function (other) {
        return other !== child;
      });
      resolve({ code: code, stdout: out, stderr: err });
    }
    var child;
    try {
      // On POSIX npm leads its own process group, so a stop signal can end npm and everything it started.
      child = tools.spawn(tools.node, [tools.npmCli].concat(args), { env: tools.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: tools.platform !== "win32" });
    } catch (error) {
      err = describe(error);
      finish(null);
      return;
    }
    tools.children.push(child);
    timer = setTimeout(function () {
      err = "npm " + args[0] + " timed out after " + timeoutMs / 1000 + " seconds\n";
      stopTree(tools, child, "SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", function (chunk) {
      out += chunk;
    });
    child.stderr.on("data", function (chunk) {
      err += chunk;
    });
    child.on("error", function (error) {
      err += describe(error) + "\n";
      finish(null);
    });
    child.on("close", function (code) {
      finish(code);
    });
  });
}

// Windows' own taskkill, from SystemRoot (any letter case, then windir, then C:\Windows), never from PATH: an environment trimmed for npm may have no System32 on its PATH.
function taskkillPath(env) {
  function value(name) {
    var key = Object.keys(env).filter(function (candidate) {
      return candidate.toLowerCase() === name;
    })[0];
    return key === undefined ? undefined : env[key];
  }
  var root = [value("systemroot"), value("windir")].filter(function (candidate) {
    return candidate !== undefined && path.win32.isAbsolute(candidate);
  })[0];
  return path.win32.join(root === undefined ? "C:\\Windows" : root, "System32", "taskkill.exe");
}

// End one npm run and everything it started. On POSIX npm leads its own process group, so the signal goes to the group; on Windows taskkill ends npm and its whole tree. When neither works, or npm has no pid, the npm process alone gets the signal.
function stopTree(tools, child, signal) {
  if (typeof child.pid !== "number") {
    child.kill(signal);
    return;
  }
  if (tools.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      child.kill(signal);
    }
    return;
  }
  // npm has already ended: its pid may belong to another process now, and taskkill would end that one.
  if (typeof child.exitCode === "number" || typeof child.signalCode === "string") return;
  try {
    var killer = tools.spawn(taskkillPath(tools.env), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", function () {
      child.kill(signal);
    });
    killer.on("exit", function (code) {
      if (code !== 0) child.kill(signal);
    });
  } catch (error) {
    child.kill(signal);
  }
}

// End every npm run still going, with the processes it started.
function stopInstalls(tools) {
  tools.children.forEach(function (child) {
    stopTree(tools, child, "SIGTERM");
  });
}

// The useful part of npm's error output: its error code and first message line, without the syscall, errno, stack and log-file lines.
function npmError(result, what) {
  var code = null;
  var detail = null;
  String(result.stderr).split("\n").forEach(function (raw) {
    var body = raw.trim().replace(/^npm (error|ERR!)\s*/, "");
    var match = /^code (\S+)$/.exec(body);
    if (match) {
      code = either(code, match[1]);
      return;
    }
    if (!body || /^(syscall|errno) |^at |complete log of this run|^\d+$/.test(body)) return;
    detail = either(detail, body);
  });
  if (detail === null) return redactSignedUrls(code === null ? what + " exited with code " + result.code : code);
  return redactSignedUrls(code === null ? detail : code + ": " + detail);
}

function lastLine(text) {
  var lines = String(text).split("\n").map(function (line) {
    return line.trim();
  }).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

// ---- the installed copy ----

// Desk's state folder for the browser: $DESK_BROWSER_STATE_DIR, else $XDG_STATE_HOME/ouroboros-skills/desk/browser, else ~/.local/state/ouroboros-skills/desk/browser.
function stateDir(env, homeDir) {
  if (env.DESK_BROWSER_STATE_DIR) return env.DESK_BROWSER_STATE_DIR;
  return path.join(either(env.XDG_STATE_HOME, path.join(homeDir, ".local", "state")), "ouroboros-skills", "desk", "browser");
}

// The install a folder holds: its version, playwright-core version and entry script, or null when it is incomplete.
function readInstall(root, dir) {
  var modules = path.join(root, dir, "node_modules");
  var pkg = readJson(path.join(modules, "@playwright", "mcp", "package.json"));
  if (!pkg || typeof pkg.version !== "string") return null;
  var bin = typeof pkg.bin === "string" ? pkg.bin : either(pkg.bin, {})["playwright-mcp"];
  if (typeof bin !== "string") return null;
  var cli = path.join(modules, "@playwright", "mcp", bin);
  if (!exists(cli)) return null;
  var core = readJson(path.join(modules, "playwright-core", "package.json"));
  var found = { version: pkg.version, core: core && typeof core.version === "string" ? core.version : null,
    cli: cli, dir: path.join(root, dir), reader: exists(path.join(modules, "classic-level", "package.json")),
    ws: exists(path.join(modules, "ws", "package.json")) };
  found.patchRevision = playwrightPatch.readRevision(found);
  if (found.reader) return found;
  var marker = path.join(root, dir, READER_UNAVAILABLE);
  if (exists(marker)) {
    found.reader = true;
    found.unavailableAt = fs.statSync(marker).mtime.getTime();
  }
  return found;
}

// The install current.json points at, or null.
function readInstalled(root) {
  var pointer = readJson(path.join(root, "current.json"));
  return pointer && typeof pointer.dir === "string" ? readInstall(root, pointer.dir) : null;
}

// Replace a file atomically: write a sibling, then rename it over the target.
function writeAtomic(file, text) {
  var temp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

function newGeneration(tools, root) {
  var id = "installs/" + tools.clock() + "-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  var dir = path.join(root, id);
  mkdirp(dir);
  return { id: id, dir: dir };
}

function publishGeneration(tools, root, generation) {
  var installed = readInstall(root, generation.id);
  playwrightPatch.apply(installed);
  installed = readInstall(root, generation.id);
  var previous = readJson(path.join(root, "current.json"));
  var previousDir = previous && typeof previous.dir === "string" ? previous.dir : null;
  prune(root, [generation.id, previousDir], tools.clock);
  writeAtomic(path.join(root, "current.json"), JSON.stringify({ version: installed.version, dir: generation.id, previous: previousDir }, null, 2) + "\n");
  return { ok: true, installed: installed };
}

function generationFailed(generation, error) {
  removeTree(generation.dir);
  return { ok: false, error: describe(error), code: error.code === "PLAYWRIGHT_PATCH_UNSUPPORTED" ? "browser_patch_unsupported" : "browser_patch_failed" };
}

function migrate(tools, root, installed) {
  var generation = newGeneration(tools, root);
  return playwrightPatch.copyPackages(path.join(installed.dir, "node_modules"), path.join(generation.dir, "node_modules")).then(function () {
    fs.writeFileSync(path.join(generation.dir, "package.json"), "{\"private\":true}\n");
    var marker = path.join(installed.dir, READER_UNAVAILABLE);
    if (exists(marker)) {
      var copy = path.join(generation.dir, READER_UNAVAILABLE);
      fs.copyFileSync(marker, copy);
      var stat = fs.statSync(marker);
      fs.utimesSync(copy, stat.atime, stat.mtime);
    }
    return publishGeneration(tools, root, generation);
  }).catch(function (error) { return generationFailed(generation, error); });
}

// Remove installs other than the ones to keep, once they are older than KEEP_MS.
function prune(root, keep, clock) {
  var installs = path.join(root, "installs");
  fs.readdirSync(installs).forEach(function (entry) {
    if (keep.indexOf("installs/" + entry) !== -1) return;
    var dir = path.join(installs, entry);
    try {
      if (clock() - fs.statSync(dir).mtime.getTime() > KEEP_MS) removeTree(dir);
    } catch (error) {
      // An install that cannot be removed now is tried again at the next refresh.
    }
  });
}

// Install the channel's current release into a new folder, then point current.json at it. With `withReader` the token reader goes in the same npm call; if that fails the browser alone is installed and the folder is marked, so a machine without a reader still gets the browser and the real-profile mode answers that it cannot read the token. The caller holds the lock.
function install(tools, root, timeoutMs, withReader) {
  var generation = newGeneration(tools, root);
  var id = generation.id;
  var dir = generation.dir;
  fs.writeFileSync(path.join(dir, "package.json"), "{\"private\":true}\n");
  function run(packages) {
    return npm(tools, ["install", "--prefix", dir, "--no-save", "--no-package-lock"].concat(packages), timeoutMs);
  }
  var first = run(withReader ? [PACKAGE, LEVEL_PACKAGE, WS_PACKAGE] : [PACKAGE]);
  var done = !withReader ? first : first.then(function (result) {
    if (result.code === 0) return result;
    return run([PACKAGE]).then(function (alone) {
      if (alone.code === 0) fs.writeFileSync(path.join(dir, READER_UNAVAILABLE), "");
      return alone;
    });
  });
  return done.then(function (result) {
    var installed = result.code === 0 ? readInstall(root, id) : null;
    if (installed === null) {
      removeTree(dir);
      return { ok: false, error: npmError(result, "npm install") };
    }
    try {
      return publishGeneration(tools, root, generation);
    } catch (error) {
      return generationFailed(generation, error);
    }
  });
}

// ---- the lock ----

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function stale(file, clock) {
  var now = clock();
  var stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    // Its owner released it a moment ago.
    return true;
  }
  if (now - stat.mtime.getTime() > LOCK_STALE_MS) return true;
  var owner = readJson(file);
  return owner !== null && typeof owner.pid === "number" && !alive(owner.pid);
}

function createLock(file, clock) {
  try {
    var fd = fs.openSync(file, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: clock() }));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

// Take the lock, replacing one whose owner died or that is older than LOCK_STALE_MS. False when another process holds it.
function takeLock(file, clock) {
  if (createLock(file, clock)) return true;
  if (!stale(file, clock)) return false;
  try {
    fs.unlinkSync(file);
  } catch (error) {
    // Another process removed it first; the create below decides who wins.
  }
  return createLock(file, clock);
}

function releaseLock(file) {
  var owner = readJson(file);
  if (owner !== null && owner.pid === process.pid) fs.unlinkSync(file);
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// npm's error text with any credential removed: the user and password of a registry address, and an auth token setting.
function redactSignedUrls(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>]+/gi, function (url) {
    return /[?&](?:sig|signature|x-amz-signature|x-goog-signature)=/i.test(url) ? "<redacted-url>" : url;
  });
}
function scrub(text) {
  return redactSignedUrls(text)
    .replace(/\/\/\S*@/g, "//<redacted>@")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 <redacted>")
    .replace(/\bnpm_[A-Za-z0-9]{20,}/g, "<redacted>")
    .replace(/\b(token|password)=[^&\s]*/gi, "$1=<redacted>")
    .replace(/(_auth\w*|_password)\s*=\s*\S+/gi, "$1=<redacted>");
}

// The installed copy, installing it first when there is none (or, when `reader` is set, none with the token reader). Resolves { installed, fresh } or { error }.
// Whether an install can start as it is, with no npm run first: it has the reader and ws when a real profile needs them, and a reader that could not be installed is not due for another try.
function complete(installed, reader, clock) {
  if (installed === null || installed.patchRevision !== playwrightPatch.REVISION) return false;
  if (!reader) return true;
  var retry = installed.unavailableAt !== undefined && clock() - installed.unavailableAt > READER_RETRY_MS;
  return installed.reader && !retry && Boolean(installed.ws || installed.unavailableAt);
}

function ensureInstalled(tools, root, deadline, reader) {
  var installed = readInstalled(root);
  if (complete(installed, reader, tools.clock)) return Promise.resolve({ installed: installed, fresh: false });
  // An install that only lacks the reader still works without it, so a failed or crowded retry keeps it.
  var current = installed === null || installed.patchRevision !== playwrightPatch.REVISION ? null : { installed: installed, fresh: false };
  var lock = path.join(root, "refresh.lock");
  if (takeLock(lock, tools.clock)) {
    return Promise.resolve().then(function () {
      if (installed !== null && installed.patchRevision !== playwrightPatch.REVISION) return migrate(tools, root, installed);
      return install(tools, root, Math.max(deadline - tools.clock(), 1000), reader);
    }).then(function (result) {
      releaseLock(lock);
      if (!result.ok && current !== null) tools.stderr.write("[web] could not install the connection reader (" + scrub(result.error) + "); keeping the install without it\n");
      if (result.ok && !complete(result.installed, reader, tools.clock)) return ensureInstalled(tools, root, deadline, reader);
      return result.ok ? { installed: result.installed, fresh: installed === null || installed.patchRevision === playwrightPatch.REVISION } : current || { error: result.error, code: result.code };
    }, function (error) {
      releaseLock(lock);
      throw error;
    });
  }
  if (current !== null) {
    tools.stderr.write("[web] another Desk session is installing; keeping the install without the connection reader\n");
    return Promise.resolve(current);
  }
  if (tools.clock() >= deadline) return Promise.resolve({ error: "another Desk session was still installing it", retry: true });
  return wait(WAIT_STEP_MS).then(function () {
    return ensureInstalled(tools, root, deadline, reader);
  });
}

// ---- the background refresh ----

// Bring the installed copy up to the channel's current release. Runs detached after a launch; never throws, and records its outcome in last-refresh.json.
function refresh(o) {
  var env = either(o.env, process.env);
  var platform = either(o.platform, process.platform);
  var node = either(o.node, process.execPath);
  var clock = either(o.clock, Date.now);
  var root = stateDir(env, either(o.homeDir, either(either(env.HOME, env.USERPROFILE), os.homedir())));
  var lock = path.join(root, "refresh.lock");
  var tools = { spawn: either(o.spawn, childProcess.spawn), node: node, npmCli: o.npmCli, env: npmEnv(env, node, platform), clock: clock, platform: platform, children: [] };
  var held = false;
  function record(result) {
    try {
      writeAtomic(path.join(root, "last-refresh.json"), JSON.stringify({ at: new Date(clock()).toISOString(), result: result }, null, 2) + "\n");
    } catch (error) {
      // Losing the record never keeps the lock.
    }
    if (held) releaseLock(lock);
    return result;
  }
  return Promise.resolve().then(function () {
    mkdirp(root);
    held = takeLock(lock, clock);
    if (!held) return { ok: true, skipped: "another Desk session holds the refresh lock" };
    return npm(tools, ["view", PACKAGE, "version"], REFRESH_MS).then(function (view) {
      var latest = view.code === 0 ? lastLine(view.stdout) : "";
      if (!latest) return { ok: false, error: npmError(view, "npm view") };
      var installed = readInstalled(root);
      var same = installed !== null && installed.version === latest;
      if (same && installed.patchRevision === playwrightPatch.REVISION && (!installed.reader || installed.ws || installed.unavailableAt)) return { ok: true, version: latest, changed: false };
      var work = same && installed.patchRevision !== playwrightPatch.REVISION ? migrate(tools, root, installed) : install(tools, root, REFRESH_MS, installed !== null && installed.reader);
      return work.then(function (result) {
        return result.ok ? { ok: true, version: result.installed.version, changed: true } : result;
      });
    });
  }).then(record, function (error) {
    return record({ ok: false, error: describe(error) });
  });
}

// Start the refresh in a detached process, so it outlives neither the launch nor blocks it.
function startRefresh(o) {
  var child = childProcess.spawn(o.node, [__filename, REFRESH_FLAG, o.npmCli], { detached: true, stdio: "ignore", env: o.env, windowsHide: true });
  child.on("error", function () {});
  child.unref();
  return child;
}

// ---- degrade, never die: serve the MCP handshake itself when the browser cannot start ----
//
// Mirrors bootstrap.cjs's own degraded responder (same wire shape, same `serveDegraded` name), so an agent reads
// the same thing from either server: every tool listed as unavailable, every call answered with a status, a code
// and a fix. The browser has no diagnostic tool of its own (no `desk_status` equivalent), so every call here is
// `isError: true`; the fix is in the payload regardless.

function reconnectFix(action) {
  return action + ", then reconnect the desk-web MCP server (in Claude Code run /mcp and reconnect desk-web; otherwise start a new session).";
}

function placeholderTools() {
  return require("./web-catalog.json").tools;
}

function respond(stdout, id, body) {
  var message = { jsonrpc: "2.0", id: id };
  Object.keys(body).forEach(function (key) {
    message[key] = body[key];
  });
  stdout.write(JSON.stringify(message) + "\n");
}

function answer(stdout, payload, line) {
  var text = line.trim();
  if (text === "") return;
  var message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    respond(stdout, null, { error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    respond(stdout, null, { error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  if (message.id === undefined) return;
  var params = either(message.params, {});
  if (message.method === "initialize") {
    respond(stdout, message.id, { result: {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "desk-web-launcher", version: "0.0.0" },
      instructions: payload.summary + " " + payload.fix
    } });
  } else if (message.method === "ping") {
    respond(stdout, message.id, { result: {} });
  } else if (message.method === "tools/list") {
    respond(stdout, message.id, { result: { tools: placeholderTools() } });
  } else if (message.method === "tools/call") {
    respond(stdout, message.id, { result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true } });
  } else {
    respond(stdout, message.id, { error: { code: -32601, message: "Method not found: " + message.method } });
  }
}

// Line-delimited JSON-RPC on stdio, answering every call with one degraded payload; resolves when stdin closes.
function serveDegraded(options) {
  var stdin = options.stdin;
  return new Promise(function (resolve) {
    var buffered = "";
    function onData(chunk) {
      buffered += chunk;
      var newline = buffered.indexOf("\n");
      while (newline !== -1) {
        answer(options.stdout, options.payload, buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
    function finish() {
      answer(options.stdout, options.payload, buffered);
      buffered = "";
      stdin.removeListener("data", onData);
      stdin.removeListener("end", finish);
      stdin.removeListener("error", finish);
      resolve();
    }
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.on("end", finish);
    stdin.on("error", finish);
    if (stdin.resume) stdin.resume();
  });
}

// ---- run ----

// Runtime selection and the staged installer are shared with the explicit private CLI.
// This layer deliberately never reads a browser declaration or acquires a profile.
function browserRuntimeTools(o, io) {
  var env = either(o.env, process.env);
  var platform = either(o.platform, process.platform);
  var fileExists = either(o.exists, exists);
  var homeDir = o.homeDir !== undefined ? o.homeDir : either(either(env.HOME, env.USERPROFILE), os.homedir());
  var current = either(o.current, { path: process.execPath, version: process.version, abi: process.versions.modules });
  var clock = either(o.clock, Date.now);
  var selection = bootstrap.selectNode({
    env: env,
    platform: platform,
    arch: either(o.arch, process.arch),
    homeDir: homeDir,
    mcpRoot: either(o.mcpRoot, __dirname),
    current: current,
    systemPrefix: o.systemPrefix !== undefined ? o.systemPrefix : either(env.DESK_NODE_SYSTEM_PREFIX, ""),
    probe: o.probe,
    now: o.now
  });
  if (selection.node === null) {
    throw Object.assign(new Error("Desk needs Node.js " + selection.range + " to start the browser; this one is " + current.version + ", so the browser is unavailable until a compatible Node is installed"),
      { code: "node_missing", fix: reconnectFix("Install Node " + selection.range) });
  }
  var node = selection.node.path;
  var cli = npmCli(node, platform, fileExists);
  if (cli === null) {
    throw Object.assign(new Error("Desk found Node " + selection.node.version + " at " + node + " but it has no npm beside it, so the browser is unavailable"),
      { code: "npm_missing", fix: reconnectFix("Reinstall that Node with its bundled npm") });
  }
  var root = stateDir(env, homeDir);
  mkdirp(root);
  var tools = { stderr: io.stderr, spawn: either(o.npmSpawn, childProcess.spawn), node: node, npmCli: cli, env: npmEnv(env, node, platform), clock: clock, platform: platform, children: [] };
  return { env: env, platform: platform, fileExists: fileExists, homeDir: homeDir, clock: clock, selection: selection, node: node, cli: cli, root: root, tools: tools };
}

function prepareBrowserRuntime(o) {
  o = o || {};
  return Promise.resolve().then(function () {
    var runtime = browserRuntimeTools(o, { stderr: either(o.stderr, process.stderr) });
    return ensureInstalled(runtime.tools, runtime.root, runtime.clock() + either(o.firstInstallMs, FIRST_INSTALL_MS), false).then(function (got) {
      if (!got.installed) throw Object.assign(new Error("Desk could not prepare a verified browser install: " + scrub(got.error)), { code: got.code || "install_failed" });
      if (!got.fresh) either(o.startRefresh, startRefresh)({ node: runtime.node, npmCli: runtime.cli, env: runtime.env });
      return { nodePath: runtime.node, installed: got.installed, stateRoot: runtime.root };
    });
  });
}

// The SDK frontend owns normal/degraded initialization, never the legacy proxy.
function run(o) {
  return require("./browser-context-mcp.cjs").run(o);
}

module.exports = {
  BROWSER_TOOL_NAMES: BROWSER_TOOL_NAMES,
  DEFAULT_ARGS: DEFAULT_ARGS,
  LEVEL_PACKAGE: LEVEL_PACKAGE,
  NPM_ENV: NPM_ENV,
  PACKAGE: PACKAGE,
  REFRESH_FLAG: REFRESH_FLAG,
  browserArgs: browserArgs,
  browserSelection: browserSelection,
  channelBrowserSelection: channelBrowserSelection,
  browserPaths: browserPaths,
  launchArgs: launchArgs,
  npmCli: npmCli,
  npmError: npmError,
  readInstalled: readInstalled,
  prepareBrowserRuntime: prepareBrowserRuntime,
  refresh: refresh,
  run: run,
  serveDegraded: serveDegraded,
  startRefresh: startRefresh,
  stopInstalls: stopInstalls,
  stopTree: stopTree,
  taskkillPath: taskkillPath,
  stateDir: stateDir,
  takeLock: takeLock,
  WS_PACKAGE: WS_PACKAGE,
  withNodeFirst: withNodeFirst
};

// Started directly by a host (the Copilot config, the managed-Edge overlay) or as the detached refresher. The Claude config requires this file and calls run() itself. Spawned tests cover these lines; the in-process coverage run cannot be the main module.
/* istanbul ignore next */
if (require.main === module) {
  if (process.argv[2] === REFRESH_FLAG) refresh({ npmCli: process.argv[3] });
  else run({});
}
