// Desk's default browser: starts the Playwright MCP server from a copy installed in Desk's per-user state folder, and keeps that copy on the `@playwright/mcp@latest` channel, so every fresh Desk install has a working browser with no setup.
//
// - Session start never waits on the network once a copy is installed. The launcher starts the installed copy at once and then starts a detached refresher, which asks npm for the channel's current release and, when it differs, installs it into a new folder and switches the `current.json` pointer with an atomic rename. The next launch uses the new release, so a session is at most one launch behind the channel. There is no pinned version or commit.
// - The first launch on a machine installs the copy in the foreground, with a time limit below the host's connection timeout. Every npm call runs with no fetch retries and a short fetch timeout, so an unreachable registry fails in seconds with a message naming the registry, instead of after minutes.
// - Installs and refreshes run under one lock file, so sessions that start together never race: one installs while the others wait for it or, with a copy already installed, skip the refresh.
// - It runs under the same compatible Node that Desk's bootstrap picks, never whatever `node` a host puts first on PATH. It uses the npm that ships next to that Node and puts that Node first on the child's PATH.
// - Desk's own browser is headless, so agents never take the operator's focus, and isolated, so concurrent sessions never fight over one profile. Playwright MCP writes its snapshots and screenshots to an `output` folder in Desk's state folder, never into the session's project. Options passed after the script go to Playwright MCP after these defaults. A caller that connects to an existing browser (`--cdp-endpoint`, `--extension` or `--endpoint`, as the managed-Edge overlay does) gets no headless or isolated defaults.
// - Playwright MCP defaults to Google Chrome. When Chrome is only in ~/Applications on macOS, where Playwright does not look, the launcher passes its path. When Chrome is not installed but Edge is (always the case on Windows), it uses Edge. With neither, page tools fail with Playwright's own message until one is installed, for example with `npx -y @playwright/mcp@latest install-browser chrome`.
// - Authenticated or persistent browser contexts are not this file's job: they go through the claims-based browser context broker (desk:cdp-headed-browser).
// - This file backs the `web` MCP server Desk declares beside `desk` (its tools read `mcp__plugin_desk_web__browser_navigate` and so on). Before Playwright MCP takes over stdio, any failure here -- no compatible Node, no npm beside it, an unreachable registry, a Node that will not spawn, or anything else that throws -- is served as a degraded MCP handshake instead of a silent `exit(1)`: every tool is listed as unavailable and every call answers with a `status`, a `code` and a `fix`, the same shape `desk`'s own bootstrap serves when it cannot start. The one difference: `desk` keeps `desk_status`/`desk_doctor` answering without `isError` so a resuming agent can still ask "what's wrong"; the browser has no diagnostic tool of its own, so every call here answers with `isError: true` and the fix is in the payload itself.
//
// Like bootstrap.cjs it must parse on very old Node, so it uses ES5 syntax and only built-ins.

"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");
var bootstrap = require("./bootstrap.cjs");

var PACKAGE_NAME = "@playwright/mcp";
var PACKAGE = PACKAGE_NAME + "@latest";
var DEFAULT_ARGS = ["--headless", "--isolated"];
// Options that connect to a browser that already runs; with any of them Desk's headless and isolated defaults do not apply.
var CONNECT = ["--cdp-endpoint", "--extension", "--endpoint"];
// Options that already say which browser to drive or connect to; with any of them the launcher adds no browser choice of its own.
var BROWSER_CHOICE = ["--browser", "--executable-path"].concat(CONNECT);
var REFRESH_FLAG = "--desk-web-refresh";
var DEFAULT_PROTOCOL = "2025-06-18";
// The tool names Playwright MCP's currently-installed channel exposes, used only so the degraded tools/list below
// looks like the real server's. Desk tracks @playwright/mcp@latest with no pinned version (see PACKAGE above), so
// this list can drift from a future release's; that is harmless, because every tools/call below answers with the
// same degraded payload whatever name it is asked for.
var BROWSER_TOOL_NAMES = [
  "browser_click", "browser_close", "browser_console_messages", "browser_drag", "browser_drop",
  "browser_emulate_media", "browser_evaluate", "browser_file_upload", "browser_fill_form", "browser_find",
  "browser_handle_dialog", "browser_hover", "browser_navigate", "browser_navigate_back", "browser_network_request",
  "browser_network_requests", "browser_press_key", "browser_resize", "browser_run_code_unsafe", "browser_select_option",
  "browser_snapshot", "browser_tabs", "browser_take_screenshot", "browser_type", "browser_wait_for"
];
// npm without retries and with a short fetch timeout: an unreachable registry fails in seconds, not minutes.
var NPM_ENV = {
  npm_config_fetch_retries: "0",
  npm_config_fetch_timeout: "10000",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_loglevel: "error"
};
// The first install must finish before the host gives up on the server (Claude Code waits 30 seconds).
var FIRST_INSTALL_MS = 25000;
var REFRESH_MS = 180000;
var REGISTRY_MS = 5000;
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

// Where Playwright itself looks for the chrome and msedge channels, per platform.
function browserPaths(browser, platform, env) {
  if (platform === "win32") {
    var roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(Boolean);
    var tail = browser === "chrome" ? ["Google", "Chrome", "Application", "chrome.exe"] : ["Microsoft", "Edge", "Application", "msedge.exe"];
    return roots.map(function (root) {
      return path.win32.join.apply(path.win32, [root].concat(tail));
    });
  }
  if (platform === "darwin") return ["/Applications/" + macBundle(browser)];
  return browser === "chrome" ? ["/opt/google/chrome/chrome"] : ["/opt/microsoft/msedge/msedge"];
}

function macBundle(browser) {
  var app = browser === "chrome" ? "Google Chrome" : "Microsoft Edge";
  return app + ".app/Contents/MacOS/" + app;
}

// Per-user install locations Playwright does not look in; a browser found only there is passed by path.
function userBrowserPaths(browser, platform, env) {
  if (platform !== "darwin" || !env.HOME) return [];
  return [path.join(env.HOME, "Applications", macBundle(browser))];
}

function firstExisting(files, fileExists) {
  for (var index = 0; index < files.length; index += 1) {
    if (fileExists(files[index])) return files[index];
  }
  return null;
}

// The browser options to add: none when the caller chose a browser or Chrome is where Playwright looks; Chrome's path when it is only in ~/Applications; Edge when only Edge is installed; none otherwise.
function browserArgs(args, platform, env, fileExists) {
  if (hasOption(args, BROWSER_CHOICE)) return [];
  if (firstExisting(browserPaths("chrome", platform, env), fileExists)) return [];
  var chrome = firstExisting(userBrowserPaths("chrome", platform, env), fileExists);
  if (chrome) return ["--executable-path", chrome];
  if (firstExisting(browserPaths("msedge", platform, env), fileExists)) return ["--browser", "msedge"];
  var edge = firstExisting(userBrowserPaths("msedge", platform, env), fileExists);
  return edge ? ["--browser", "msedge", "--executable-path", edge] : [];
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
      resolve({ code: code, stdout: out, stderr: err });
    }
    var child;
    try {
      child = tools.spawn(tools.node, [tools.npmCli].concat(args), { env: tools.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      err = describe(error);
      finish(null);
      return;
    }
    timer = setTimeout(function () {
      err = "npm " + args[0] + " timed out after " + timeoutMs / 1000 + " seconds\n";
      child.kill("SIGKILL");
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
  if (detail === null) return code === null ? what + " exited with code " + result.code : code;
  return code === null ? detail : code + ": " + detail;
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
  return { version: pkg.version, core: core && typeof core.version === "string" ? core.version : null, cli: cli, dir: path.join(root, dir) };
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

// Install the channel's current release into a new folder, then point current.json at it. The caller holds the lock.
function install(tools, root, timeoutMs) {
  var id = "installs/" + tools.clock() + "-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  var dir = path.join(root, id);
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "package.json"), "{\"private\":true}\n");
  return npm(tools, ["install", "--prefix", dir, "--no-save", "--no-package-lock", PACKAGE], timeoutMs).then(function (result) {
    var installed = result.code === 0 ? readInstall(root, id) : null;
    if (installed === null) {
      removeTree(dir);
      return { ok: false, error: npmError(result, "npm install") };
    }
    var previous = readJson(path.join(root, "current.json"));
    var previousDir = previous && typeof previous.dir === "string" ? previous.dir : null;
    writeAtomic(path.join(root, "current.json"), JSON.stringify({ version: installed.version, dir: id, previous: previousDir }, null, 2) + "\n");
    prune(root, [id, previousDir], tools.clock);
    return { ok: true, installed: installed };
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

// The installed copy, installing it first when there is none. Resolves { installed, fresh } or { error }.
function ensureInstalled(tools, root, deadline) {
  var installed = readInstalled(root);
  if (installed !== null) return Promise.resolve({ installed: installed, fresh: false });
  var lock = path.join(root, "refresh.lock");
  if (takeLock(lock, tools.clock)) {
    return Promise.resolve().then(function () {
      return install(tools, root, Math.max(deadline - tools.clock(), 1000));
    }).then(function (result) {
      releaseLock(lock);
      return result.ok ? { installed: result.installed, fresh: true } : { error: result.error };
    }, function (error) {
      releaseLock(lock);
      throw error;
    });
  }
  if (tools.clock() >= deadline) return Promise.resolve({ error: "another Desk session was still installing it" });
  return wait(WAIT_STEP_MS).then(function () {
    return ensureInstalled(tools, root, deadline);
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
  var tools = { spawn: either(o.spawn, childProcess.spawn), node: node, npmCli: o.npmCli, env: npmEnv(env, node, platform), clock: clock };
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
      if (installed !== null && installed.version === latest) return { ok: true, version: latest, changed: false };
      return install(tools, root, REFRESH_MS).then(function (result) {
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
  return action + ", then reconnect the web MCP server (in Claude Code run /mcp and reconnect web; otherwise start a new session).";
}

function degraded(code, summary, fix) {
  return { status: "degraded", state: "degraded:" + code, code: code, summary: summary, fix: fix };
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
    respond(stdout, message.id, { result: { tools: BROWSER_TOOL_NAMES.map(function (name) {
      return {
        name: name,
        description: "Unavailable: the browser could not start. Call this tool for the code and the fix.",
        inputSchema: { type: "object", properties: {}, additionalProperties: true }
      };
    }) } });
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

// Writes one stderr line naming what went wrong, then keeps the process alive serving the degraded handshake above
// until the host closes stdin -- never exit(1), which left an agent with a failed server and no message it could
// read.
function fail(io, code, summary, fix) {
  io.stderr.write("[web] " + summary + "; serving degraded:" + code + "\n");
  return serveDegraded({ stdin: io.stdin, stdout: io.stdout, payload: degraded(code, summary, fix) });
}

function start(o, io) {
  var env = either(o.env, process.env);
  var platform = either(o.platform, process.platform);
  var fileExists = either(o.exists, exists);
  var args = either(o.args, process.argv.slice(2));
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
    return fail(io, "node_missing",
      "Desk needs Node.js " + selection.range + " to start the browser; this one is " + current.version + ", so the browser is unavailable until a compatible Node is installed",
      reconnectFix("Install Node " + selection.range));
  }
  var node = selection.node.path;
  var cli = npmCli(node, platform, fileExists);
  if (cli === null) {
    return fail(io, "npm_missing",
      "Desk found Node " + selection.node.version + " at " + node + " but it has no npm beside it, so the browser is unavailable",
      reconnectFix("Reinstall that Node with its bundled npm"));
  }
  var root = stateDir(env, homeDir);
  mkdirp(root);
  var tools = { spawn: either(o.npmSpawn, childProcess.spawn), node: node, npmCli: cli, env: npmEnv(env, node, platform), clock: clock };
  return ensureInstalled(tools, root, clock() + either(o.firstInstallMs, FIRST_INSTALL_MS)).then(function (got) {
    if (!got.installed) {
      return npm(tools, ["config", "get", "registry"], REGISTRY_MS).then(function (answer) {
        var registry = answer.code === 0 && lastLine(answer.stdout) ? lastLine(answer.stdout) : "the configured npm registry";
        return fail(io, "install_failed",
          "Desk could not install " + PACKAGE + " from " + registry + " (" + got.error + "), so the browser is unavailable",
          reconnectFix("Check that this machine can reach " + registry + ", or point npm at one it can reach (npm config set registry <url>)"));
      });
    }
    var installed = got.installed;
    io.stderr.write("[web] " + PACKAGE_NAME + " " + installed.version + (installed.core ? " (playwright-core " + installed.core + ")" : "") + " from " + installed.dir + "\n");
    // A copy installed just now is already the channel's current release.
    if (!got.fresh) either(o.startRefresh, startRefresh)({ node: node, npmCli: cli, env: env });
    return bootstrap.reexec({
      node: node,
      indexFile: installed.cli,
      args: launchArgs(args, platform, env, fileExists, root),
      env: withNodeFirst(env, node, platform),
      stderr: io.stderr,
      spawn: either(o.spawn, childProcess.spawn),
      signals: either(o.signals, process),
      exit: io.exit,
      kill: either(o.kill, process.kill),
      onSpawnError: function (error) {
        return fail(io, "node_spawn_failed",
          "Desk found Node " + selection.node.version + " at " + node + " but could not start it: " + describe(error) + ", so the browser is unavailable",
          reconnectFix("Check that this Node runs, or reinstall it"));
      }
    });
  });
}

// Never throws or rejects: anything that goes wrong is degraded:launch_failed over the handshake above, which the
// host reports as a connected but degraded server, never a failed one. Every option defaults to the real process.
function run(o) {
  var io = { stderr: either(o.stderr, process.stderr), stdin: either(o.stdin, process.stdin), stdout: either(o.stdout, process.stdout), exit: either(o.exit, process.exit) };
  function failed(error) {
    return fail(io, "launch_failed", "Desk could not start the browser: " + describe(error), reconnectFix("Refresh or reinstall the Desk plugin"));
  }
  try {
    return start(o, io).then(null, failed);
  } catch (error) {
    return failed(error);
  }
}

module.exports = {
  BROWSER_TOOL_NAMES: BROWSER_TOOL_NAMES,
  DEFAULT_ARGS: DEFAULT_ARGS,
  NPM_ENV: NPM_ENV,
  PACKAGE: PACKAGE,
  REFRESH_FLAG: REFRESH_FLAG,
  browserArgs: browserArgs,
  browserPaths: browserPaths,
  launchArgs: launchArgs,
  npmCli: npmCli,
  npmError: npmError,
  readInstalled: readInstalled,
  refresh: refresh,
  run: run,
  serveDegraded: serveDegraded,
  startRefresh: startRefresh,
  stateDir: stateDir,
  takeLock: takeLock,
  withNodeFirst: withNodeFirst
};

// Started directly by a host (the Copilot config, the managed-Edge overlay) or as the detached refresher. The Claude config requires this file and calls run() itself. Spawned tests cover these lines; the in-process coverage run cannot be the main module.
/* istanbul ignore next */
if (require.main === module) {
  if (process.argv[2] === REFRESH_FLAG) refresh({ npmCli: process.argv[3] });
  else run({});
}
