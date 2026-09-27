// Desk's default browser: starts the Playwright MCP server from its npm channel, so every fresh Desk install has a working browser with no setup.
//
// - The package follows its channel: `@playwright/mcp@latest`, resolved by npx at each launch. There is no pinned version or commit.
// - It runs under the same compatible Node that Desk's bootstrap picks, never whatever `node` a host puts first on PATH. It uses the npx that ships next to that Node and puts that Node first on the child's PATH, so the package's own `node` shebang resolves to it too.
// - The browser is headless, so agents never take the operator's focus, and isolated, so concurrent sessions never fight over one profile. Options passed after the script (the Copilot entry point) go to Playwright MCP after these defaults.
// - Playwright MCP defaults to Google Chrome. When Chrome is not installed but Edge is (always the case on Windows), it uses Edge. With neither, page tools fail with Playwright's own message until one is installed, for example with `npx -y @playwright/mcp@latest install-browser chrome`.
// - Authenticated or persistent browser contexts are not this file's job: they go through the claims-based browser context broker (desk:cdp-headed-browser).
//
// Like bootstrap.cjs it must parse on very old Node, so it uses ES5 syntax and only built-ins.

"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");
var bootstrap = require("./bootstrap.cjs");

var PACKAGE = "@playwright/mcp@latest";
var DEFAULT_ARGS = ["--headless", "--isolated"];
// Options that already say which browser to drive or connect to; with any of them the launcher adds no browser choice of its own.
var BROWSER_CHOICE = ["--browser", "--executable-path", "--cdp-endpoint", "--extension", "--endpoint"];

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

// Where each browser is installed by default, per platform. These are the locations Playwright itself checks for the chrome and msedge channels.
function browserPaths(browser, platform, env) {
  if (platform === "win32") {
    var roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(Boolean);
    var tail = browser === "chrome" ? ["Google", "Chrome", "Application", "chrome.exe"] : ["Microsoft", "Edge", "Application", "msedge.exe"];
    return roots.map(function (root) {
      return path.win32.join.apply(path.win32, [root].concat(tail));
    });
  }
  if (platform === "darwin") {
    var app = browser === "chrome" ? "Google Chrome" : "Microsoft Edge";
    var bundle = app + ".app/Contents/MacOS/" + app;
    return ["/Applications/" + bundle, path.join(either(env.HOME, ""), "Applications", bundle)];
  }
  return browser === "chrome" ? ["/opt/google/chrome/chrome"] : ["/opt/microsoft/msedge/msedge"];
}

// The browser options to add: none when the caller chose a browser or Chrome is installed, Edge when only Edge is, and none otherwise.
function browserArgs(args, platform, env, fileExists) {
  var chosen = args.some(function (arg) {
    return BROWSER_CHOICE.some(function (option) {
      return arg === option || arg.indexOf(option + "=") === 0;
    });
  });
  if (chosen || browserPaths("chrome", platform, env).some(fileExists)) return [];
  return browserPaths("msedge", platform, env).some(fileExists) ? ["--browser", "msedge"] : [];
}

// The npx that ships with a Node install: lib/node_modules/npm next to bin/node on macOS and Linux, node_modules\npm beside node.exe on Windows. Both the path as found and its real path are tried, because a version manager or Homebrew may link node from elsewhere.
function npxCli(node, platform, fileExists) {
  var candidates = [];
  [node, realpath(node)].forEach(function (file) {
    candidates.push(platform === "win32"
      ? path.win32.join(path.win32.dirname(file), "node_modules", "npm", "bin", "npx-cli.js")
      : path.join(path.dirname(file), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"));
  });
  for (var index = 0; index < candidates.length; index += 1) {
    if (fileExists(candidates[index])) return candidates[index];
  }
  return null;
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

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(stderr, exit, message) {
  stderr.write("[desk-browser] " + message + "\n");
  exit(1);
  return Promise.resolve();
}

function start(o, stderr, exit) {
  var env = either(o.env, process.env);
  var platform = either(o.platform, process.platform);
  var fileExists = either(o.exists, exists);
  var args = either(o.args, process.argv.slice(2));
  var current = either(o.current, { path: process.execPath, version: process.version, abi: process.versions.modules });
  var selection = bootstrap.selectNode({
    env: env,
    platform: platform,
    arch: either(o.arch, process.arch),
    homeDir: o.homeDir !== undefined ? o.homeDir : either(either(env.HOME, env.USERPROFILE), os.homedir()),
    mcpRoot: either(o.mcpRoot, __dirname),
    current: current,
    systemPrefix: o.systemPrefix !== undefined ? o.systemPrefix : either(env.DESK_NODE_SYSTEM_PREFIX, ""),
    probe: o.probe,
    now: o.now
  });
  if (selection.node === null) {
    return fail(stderr, exit, "no Node satisfies " + selection.range + " (this one is " + current.version + "), so the browser cannot start. Install Node " + selection.range + " and reconnect the playwright MCP server.");
  }
  var node = selection.node.path;
  var cli = npxCli(node, platform, fileExists);
  if (cli === null) {
    return fail(stderr, exit, "Node " + selection.node.version + " at " + node + " has no npx beside it, so the browser cannot start. Reinstall that Node with its bundled npm and reconnect the playwright MCP server.");
  }
  return bootstrap.reexec({
    node: node,
    indexFile: cli,
    args: ["-y", PACKAGE].concat(DEFAULT_ARGS, browserArgs(args, platform, env, fileExists), args),
    env: withNodeFirst(env, node, platform),
    stderr: stderr,
    spawn: either(o.spawn, childProcess.spawn),
    signals: either(o.signals, process),
    exit: exit,
    kill: either(o.kill, process.kill),
    onSpawnError: function (error) {
      return fail(stderr, exit, "could not start Node " + node + ": " + describe(error));
    }
  });
}

// Never throws: anything that goes wrong is one stderr line and exit code 1, which the host reports as a failed server. Every option defaults to the real process.
function run(o) {
  var stderr = either(o.stderr, process.stderr);
  var exit = either(o.exit, process.exit);
  try {
    return start(o, stderr, exit);
  } catch (error) {
    return fail(stderr, exit, "could not start the browser: " + describe(error));
  }
}

module.exports = {
  DEFAULT_ARGS: DEFAULT_ARGS,
  PACKAGE: PACKAGE,
  browserArgs: browserArgs,
  browserPaths: browserPaths,
  npxCli: npxCli,
  run: run,
  withNodeFirst: withNodeFirst
};

// Started directly by a host (the Copilot config). The Claude config requires this file and calls run() itself. Spawned tests cover this line; the in-process coverage run cannot be the main module.
/* istanbul ignore next */
if (require.main === module) run({});
