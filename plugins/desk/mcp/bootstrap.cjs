// Desk MCP bootstrap: the first file every host runs, with whatever `node` the host found.
//
// Desk must never depend on which Node a host or shell puts first on PATH. This file finds the best installed Node and runs index.js in it:
// - It lists Node binaries on PATH and under the usual version managers: nvm, fnm, Volta, asdf, mise and Homebrew on macOS and Linux; nvm-windows, fnm, Volta, mise and Program Files on Windows.
// - It keeps the ones that satisfy engines.node in package.json and prefers the newest whose module ABI has a shipped Desk runtime pack (the same support matrix index.js reads), so index.js never has to restart itself. With no packed ABI installed, it takes the newest compatible Node.
// - When the running Node is that choice, index.js runs in this process. Otherwise index.js runs as a child with inherited stdio, forwarded signals and its exit code passed through.
// - When no compatible Node exists, this file answers the MCP handshake itself: it lists every Desk tool and answers each call with degraded:node_missing and the install command for this machine.
//
// It must parse and run on very old Node (8 and later), so it uses ES5 syntax only (var, function, no arrow functions, template literals, destructuring or optional chaining) and only the child_process, fs, os, path and url built-ins.
//
// Known limit: with no `node` executable at all, the host cannot start this file, so Desk cannot answer. Desk's setup and desk_doctor make sure Node is installed.
//
// DESK_NODE_SYSTEM_PREFIX prefixes the fixed Homebrew and system paths on macOS and Linux, so tests can point them at a fixture tree.

"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

var DEFAULT_RANGE = ">=20.0.0";
var DEFAULT_PROTOCOL = "2025-06-18";
var PROBE_SCRIPT = "process.stdout.write(process.version + \" \" + process.versions.modules)";
// Node's module ABI for each release line it is known for; a Node from any other line is asked.
var KNOWN_ABIS = { "16": "93", "17": "102", "18": "108", "19": "111", "20": "115", "21": "120", "22": "127", "23": "131", "24": "137" };
// Keep in step with src/tool-names.js; a test checks it.
var TOOL_NAMES = [
  "task_create", "task_update", "task_archive", "track_create", "track_update", "friction_add", "lesson_add",
  "desk_work_ledger", "desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread", "desk_reindex",
  "desk_status", "desk_doctor"
];
var ANSWERING_TOOLS = ["desk_status", "desk_doctor"];
var FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// ---- small helpers ----

function either(value, fallback) {
  return value ? value : fallback;
}

// Join path parts under a base, or return an empty string when there is no base.
function under(base) {
  if (!base) return "";
  return path.join.apply(null, [base].concat(Array.prototype.slice.call(arguments, 1)));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    return [];
  }
}

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    return file;
  }
}

function isExecutableFile(file, windows) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!windows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---- versions and the engines range ----

function parseVersion(text) {
  var match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (var index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

// The version one step above a partial version given to n parts: 20 gives 21.0.0, 20.1 gives 20.2.0, 20.1.2 gives 20.1.3.
function bump(parts, n) {
  if (n === 1) return [parts[0] + 1, 0, 0];
  if (n === 2) return [parts[0], parts[1] + 1, 0];
  return [parts[0], parts[1], parts[2] + 1];
}

function comparatorOk(version, comparator) {
  var match = /^(>=|<=|>|<|=|\^|~)?v?(.*)$/.exec(comparator);
  var op = either(match[1], "");
  var rest = match[2];
  if (rest === "*" || rest === "x" || rest === "X") return op === "" || op === "=" || op === ">=" || op === "<=";
  rest = rest.replace(/(\.[*xX])+$/, "");
  if (!/^\d+(\.\d+){0,2}$/.test(rest)) return false;
  var given = rest.split(".").map(Number);
  var n = given.length;
  var full = [given[0], either(given[1], 0), either(given[2], 0)];
  var order = compareVersions(version, full);
  if (op === ">=") return order >= 0;
  if (op === "<") return order < 0;
  if (op === ">") return n === 3 ? order > 0 : compareVersions(version, bump(full, n)) >= 0;
  if (op === "<=") return n === 3 ? order <= 0 : compareVersions(version, bump(full, n)) < 0;
  var upper;
  if (op === "~") {
    upper = bump(full, n === 1 ? 1 : 2);
  } else if (op === "^") {
    upper = full[0] > 0 || n === 1 ? bump(full, 1) : (full[1] > 0 || n === 2 ? bump(full, 2) : bump(full, 3));
  } else if (n === 3) {
    return order === 0;
  } else {
    upper = bump(full, n);
  }
  return order >= 0 && compareVersions(version, upper) < 0;
}

// npm semver for plain majors, minors and patches: comparators joined by spaces, alternatives joined by ||.
function satisfies(versionText, range) {
  var version = parseVersion(versionText);
  if (version === null) return false;
  var alternatives = String(range).replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split("||");
  return alternatives.some(function (alternative) {
    return alternative.trim().split(/\s+/).every(function (comparator) {
      return comparator === "" || comparatorOk(version, comparator);
    });
  });
}

// ---- package metadata: the engines range and the ABIs Desk ships runtime packs for ----

function readPackage(mcpRoot) {
  var pkg = either(readJson(path.join(mcpRoot, "package.json")), {});
  var engines = either(pkg.engines, {});
  return {
    range: typeof engines.node === "string" ? engines.node : DEFAULT_RANGE,
    version: typeof pkg.version === "string" ? pkg.version : null
  };
}

// The same support matrix index.js inspects: artifacts/runtime-deps/<version>/support-matrix.json.
function packAbis(mcpRoot, version, platform, arch) {
  if (!version) return [];
  var matrix = readJson(path.join(mcpRoot, "artifacts", "runtime-deps", version, "support-matrix.json"));
  if (!matrix || !Array.isArray(matrix.targets)) return [];
  var abis = [];
  matrix.targets.forEach(function (target) {
    var abi = String(target.node_abi);
    if (target.platform === platform && target.arch === arch && abis.indexOf(abi) === -1) abis.push(abi);
  });
  return abis;
}

// ---- discovery ----

// Every installed Node binary, PATH first so a tie keeps the host's own choice.
function candidatePaths(options) {
  var env = options.env;
  var home = options.homeDir;
  var windows = options.platform === "win32";
  var exe = windows ? "node.exe" : "node";
  var found = [];

  function add(file) {
    if (found.indexOf(file) === -1 && isExecutableFile(file, windows)) found.push(file);
  }
  // Every <root>/<middle...>/<version>/<tail...>, for each version folder.
  function eachVersion(root, middle, tail) {
    if (!root) return;
    var dir = path.join.apply(null, [root].concat(middle));
    listDir(dir).forEach(function (entry) {
      add(path.join.apply(null, [dir, entry].concat(tail)));
    });
  }

  either(env.PATH, "").split(windows ? ";" : ":").forEach(function (dir) {
    if (dir) add(path.join(dir, exe));
  });

  if (windows) {
    var appData = env.APPDATA;
    var localAppData = env.LOCALAPPDATA;
    eachVersion(env.NVM_HOME, [], [exe]);
    eachVersion(under(appData, "nvm"), [], [exe]);
    if (env.NVM_SYMLINK) add(path.join(env.NVM_SYMLINK, exe));
    [env.FNM_DIR, under(appData, "fnm"), under(localAppData, "fnm")].forEach(function (root) {
      eachVersion(root, ["node-versions"], ["installation", exe]);
    });
    eachVersion(under(localAppData, "fnm_multishells"), [], [exe]);
    eachVersion(either(env.VOLTA_HOME, under(localAppData, "Volta")), ["tools", "image", "node"], [exe]);
    eachVersion(either(env.MISE_DATA_DIR, under(localAppData, "mise")), ["installs", "node"], [exe]);
    add(path.join(either(env.ProgramFiles, "C:\\Program Files"), "nodejs", exe));
    add(path.join(either(env["ProgramFiles(x86)"], "C:\\Program Files (x86)"), "nodejs", exe));
    return found;
  }

  var dataHome = either(env.XDG_DATA_HOME, under(home, ".local", "share"));
  eachVersion(either(env.NVM_DIR, under(home, ".nvm")), ["versions", "node"], ["bin", exe]);
  [env.FNM_DIR, under(dataHome, "fnm"), under(home, "Library", "Application Support", "fnm"), under(home, ".fnm")].forEach(function (root) {
    eachVersion(root, ["node-versions"], ["installation", "bin", exe]);
  });
  eachVersion(either(env.VOLTA_HOME, under(home, ".volta")), ["tools", "image", "node"], ["bin", exe]);
  eachVersion(either(env.ASDF_DATA_DIR, under(home, ".asdf")), ["installs", "nodejs"], ["bin", exe]);
  eachVersion(either(env.MISE_DATA_DIR, under(dataHome, "mise")), ["installs", "node"], ["bin", exe]);
  var prefix = options.systemPrefix;
  add(prefix + "/opt/homebrew/bin/node");
  add(prefix + "/usr/local/bin/node");
  [prefix + "/opt/homebrew/opt", prefix + "/usr/local/opt"].forEach(function (formulae) {
    listDir(formulae).forEach(function (formula) {
      if (/^node(@\d+)?$/.test(formula)) add(path.join(formulae, formula, "bin", exe));
    });
  });
  add(prefix + "/usr/bin/node");
  return found;
}

// A version manager keeps each install in a folder named after its version; read the last such folder in the real path.
function versionFromPath(file) {
  var pattern = /[\\/]v?(\d+\.\d+\.\d+)(?=[\\/])/g;
  var version = null;
  var match = pattern.exec(file);
  while (match !== null) {
    version = match[1];
    match = pattern.exec(file);
  }
  return version;
}

// Ask a binary for its version and module ABI; null when it does not run or answers oddly.
function probeNode(file, env) {
  var result = childProcess.spawnSync(file, ["-e", PROBE_SCRIPT], { encoding: "utf8", env: env, timeout: 5000, windowsHide: true });
  if (result.status !== 0) return null;
  var match = /^v(\d+\.\d+\.\d+)\S*\s+(\d+)$/.exec(result.stdout.trim());
  return match ? { version: match[1], abi: match[2] } : null;
}

function selectNode(options) {
  var pkg = readPackage(options.mcpRoot);
  var abis = packAbis(options.mcpRoot, pkg.version, options.platform, options.arch);
  var probe = either(options.probe, function (file) {
    return probeNode(file, options.env);
  });
  var current = options.current;
  var seen = {};
  var candidates = [{
    path: current.path,
    version: String(current.version).replace(/^v/, ""),
    abi: String(current.abi),
    current: true,
    order: 0
  }];
  seen[realpath(current.path)] = true;

  candidatePaths(options).forEach(function (file) {
    var real = realpath(file);
    if (seen[real]) return;
    seen[real] = true;
    var version = versionFromPath(real);
    var abi = version === null ? null : either(KNOWN_ABIS[version.split(".")[0]], null);
    if (abi === null) {
      var probed = probe(file);
      if (probed === null) return;
      version = probed.version;
      abi = probed.abi;
    }
    candidates.push({ path: file, version: version, abi: abi, current: false, order: candidates.length });
  });

  var compatible = candidates.filter(function (candidate) {
    return satisfies(candidate.version, pkg.range);
  });
  function newestFirst(left, right) {
    return compareVersions(parseVersion(right.version), parseVersion(left.version)) || left.order - right.order;
  }
  function packed(candidate) {
    return abis.indexOf(candidate.abi) !== -1;
  }
  var ordered = compatible.filter(packed).sort(newestFirst).concat(compatible.filter(function (candidate) {
    return !packed(candidate);
  }).sort(newestFirst));

  for (var index = 0; index < ordered.length; index += 1) {
    var candidate = ordered[index];
    // A version read from a folder name is trusted only once the binary actually runs.
    if (candidate.current || probe(candidate.path) !== null) {
      return { node: candidate, range: pkg.range, packAbis: abis };
    }
  }
  return { node: null, range: pkg.range, packAbis: abis };
}

// ---- the degraded responder ----

// Whether an executable is on a macOS or Linux PATH.
function onPosixPath(name, env) {
  return either(env.PATH, "").split(":").some(function (dir) {
    return dir !== "" && isExecutableFile(path.join(dir, name), false);
  });
}

// The exact command that installs a compatible Node on this machine.
function installCommand(options) {
  var env = options.env;
  if (options.platform === "win32") {
    return env.NVM_HOME ? "nvm install lts && nvm use lts" : "winget install --id OpenJS.NodeJS.LTS --exact";
  }
  if (onPosixPath("brew", env)) return "brew install node";
  var scripts = [under(env.NVM_DIR, "nvm.sh"), under(options.homeDir, ".nvm", "nvm.sh")];
  for (var index = 0; index < scripts.length; index += 1) {
    if (scripts[index] && isExecutableFile(scripts[index], true)) return ". \"" + scripts[index] + "\" && nvm install --lts";
  }
  return "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . \"$HOME/.nvm/nvm.sh\" && nvm install --lts";
}

function reconnectFix(action) {
  return action + ", then reconnect the Desk MCP server (in Claude Code run /mcp and reconnect desk; otherwise start a new session).";
}

function degraded(code, summary, fix, extra) {
  var payload = { status: "degraded", state: "degraded:" + code, code: code, summary: summary, fix: fix };
  Object.keys(extra).forEach(function (key) {
    payload[key] = extra[key];
  });
  return payload;
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
  if (message.id === undefined) return;
  var params = either(message.params, {});
  if (message.method === "initialize") {
    respond(stdout, message.id, { result: {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "desk-mcp-bootstrap", version: "0.0.0" },
      instructions: payload.summary + " " + payload.fix
    } });
  } else if (message.method === "ping") {
    respond(stdout, message.id, { result: {} });
  } else if (message.method === "tools/list") {
    respond(stdout, message.id, { result: { tools: TOOL_NAMES.map(function (name) {
      return {
        name: name,
        description: "Unavailable until Desk can start. Call desk_status for the reason and the fix.",
        inputSchema: { type: "object", properties: {}, additionalProperties: true }
      };
    }) } });
  } else if (message.method === "tools/call") {
    respond(stdout, message.id, { result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: ANSWERING_TOOLS.indexOf(params.name) === -1
    } });
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

// ---- running index.js ----

// Load index.js (an ES module) in this process and start it through its own entrypoint guard, which serves diagnostic mode on any startup exception. The import is built at run time so that very old Node can still parse this file.
function importIndex(indexFile, args) {
  var load = new Function("specifier", "return import(specifier)");
  return load(require("url").pathToFileURL(indexFile).href).then(function (index) {
    return index.runIfEntrypoint({
      argv: [process.execPath, indexFile],
      launch: function () {
        return index.main({ argv: args });
      }
    });
  });
}

function reexec(options) {
  return new Promise(function (resolve) {
    var child = options.spawn(options.node, [options.indexFile].concat(options.args), { stdio: "inherit", env: options.env, windowsHide: true });
    var handlers = {};
    FORWARDED_SIGNALS.forEach(function (signal) {
      handlers[signal] = function () {
        child.kill(signal);
      };
      options.signals.on(signal, handlers[signal]);
    });
    function detach() {
      FORWARDED_SIGNALS.forEach(function (signal) {
        options.signals.removeListener(signal, handlers[signal]);
      });
    }
    child.on("error", function (error) {
      detach();
      resolve(options.onSpawnError(error));
    });
    child.on("exit", function (code, signal) {
      detach();
      if (signal) options.kill(process.pid, signal);
      else options.exit(code);
      resolve();
    });
  });
}

function run(options) {
  var o = either(options, {});
  var env = either(o.env, process.env);
  var platform = either(o.platform, process.platform);
  var homeDir = o.homeDir !== undefined ? o.homeDir : either(either(env.HOME, env.USERPROFILE), os.homedir());
  var mcpRoot = either(o.mcpRoot, __dirname);
  var indexFile = path.join(mcpRoot, "index.js");
  var args = either(o.args, process.argv.slice(2));
  var stderr = either(o.stderr, process.stderr);
  var current = either(o.current, { path: process.execPath, version: process.version, abi: process.versions.modules });
  var selection = selectNode({
    env: env,
    platform: platform,
    arch: either(o.arch, process.arch),
    homeDir: homeDir,
    mcpRoot: mcpRoot,
    current: current,
    systemPrefix: o.systemPrefix !== undefined ? o.systemPrefix : either(env.DESK_NODE_SYSTEM_PREFIX, ""),
    probe: o.probe
  });

  function serve(payload) {
    return serveDegraded({ stdin: either(o.stdin, process.stdin), stdout: either(o.stdout, process.stdout), payload: payload });
  }

  if (selection.node === null) {
    stderr.write("[desk-mcp] bootstrap: no Node satisfies " + selection.range + " (this one is " + current.version + "); serving degraded:node_missing\n");
    return serve(degraded(
      "node_missing",
      "Desk needs Node.js " + selection.range + " and found none on PATH or under the usual version managers, so every Desk tool is unavailable until one is installed.",
      reconnectFix("Run `" + installCommand({ platform: platform, env: env, homeDir: homeDir }) + "` in a shell"),
      { required_node: selection.range, running_node: current.version }
    ));
  }

  if (selection.node.current) {
    return Promise.resolve().then(function () {
      return either(o.importIndex, importIndex)(indexFile, args);
    }).catch(function (error) {
      var message = describeError(error);
      stderr.write("[desk-mcp] bootstrap: could not start index.js: " + message + "\n");
      return serve(degraded(
        "bootstrap_failed",
        "Desk could not start index.js: " + message,
        reconnectFix("Refresh or reinstall the Desk plugin from its trusted source"),
        {}
      ));
    });
  }

  return reexec({
    node: selection.node.path,
    indexFile: indexFile,
    args: args,
    env: env,
    spawn: either(o.spawn, childProcess.spawn),
    signals: either(o.signals, process),
    exit: either(o.exit, process.exit),
    kill: either(o.kill, process.kill),
    onSpawnError: function (error) {
      var message = describeError(error);
      stderr.write("[desk-mcp] bootstrap: could not start Node " + selection.node.path + ": " + message + "\n");
      return serve(degraded(
        "node_spawn_failed",
        "Desk found Node " + selection.node.version + " at " + selection.node.path + " but could not start it: " + message,
        reconnectFix("Check that this Node runs, or reinstall it"),
        {}
      ));
    }
  });
}

module.exports = {
  TOOL_NAMES: TOOL_NAMES,
  candidatePaths: candidatePaths,
  importIndex: importIndex,
  installCommand: installCommand,
  packAbis: packAbis,
  probeNode: probeNode,
  readPackage: readPackage,
  run: run,
  satisfies: satisfies,
  selectNode: selectNode,
  serveDegraded: serveDegraded
};

// Started directly by a host (the Copilot config). The Claude config requires this file and calls run() itself. Spawned tests cover this line; the in-process coverage run cannot be the main module.
/* istanbul ignore next */
if (require.main === module) {
  run();
}
