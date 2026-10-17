// Explicit, agent-owned, in-memory browsers. Keep this entry parseable on old Node;
// only the selected compatible child imports the maintained Playwright CLI.
"use strict";
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var os = require("os");
var childProcess = require("child_process");
var web = require("./web.cjs");
var ID = /^private-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var COMMANDS = ("goto type click dblclick fill drag drop hover select upload check uncheck snapshot find eval console dialog-accept dialog-dismiss resize run-code go-back go-forward reload press keydown keyup mousemove mousedown mouseup mousewheel screenshot pdf tab-list tab-new tab-close tab-select state-save cookie-list cookie-get cookie-set cookie-delete cookie-clear localstorage-list localstorage-get localstorage-set localstorage-delete localstorage-clear sessionstorage-list sessionstorage-get sessionstorage-set sessionstorage-delete sessionstorage-clear set-color-scheme set-reduced-motion set-forced-colors set-contrast set-media clear-color-scheme clear-reduced-motion clear-forced-colors clear-contrast clear-media requests request request-headers request-body response-headers response-body route route-list unroute network-state-set recording-start recording-stop tracing-start tracing-stop webmcp-list webmcp-call").split(" ");
function failure(code, message) {
  var error = new Error(message);
  error.code = code;
  throw error;
}
function validate(argv) {
  if (!Array.isArray(argv) || argv.some(function (a) { return typeof a !== "string" || a.indexOf("\0") !== -1; })) failure("invalid_arguments", "Expected string arguments");
  var verb = argv[0];
  if (verb === "create" && argv.length === 1) return;
  if (["keep", "resume", "discard", "run"].indexOf(verb) === -1 || !ID.test(argv[1] || "")) failure("invalid_arguments", "Use create, keep/resume/discard <context-id>, or run <context-id> -- <page-command>");
  if (verb !== "run") {
    if (argv.length !== 2) failure("invalid_arguments", "Unexpected control arguments");
    return;
  }
  if (argv[2] !== "--" || COMMANDS.indexOf(argv[3]) === -1) failure("invalid_arguments", "Only ordinary page commands are allowed");
  for (var i = 4; i < argv.length && argv[i] !== "--"; i += 1) {
    // minimist accepts short clusters and --no-session as well as -s= and -sfoo.
    // Page data beginning with '-' must use the genuine inner '--' delimiter.
    if (/^-[^-]/.test(argv[i]) || /^--(?:no-)?(?:s|g|h|v|session|global|all|cdp(?:-endpoint)?|endpoint|extension|persistent|profile(?:-dir-name)?|user-data-dir|storage-state|config|browser|executable-path|headed|headless|isolated|device|mobile|idle-timeout|help|version)(?:=|$)/.test(argv[i])) {
      failure("reserved_option", "Session, lifecycle, profile, configuration and connection overrides are not allowed");
    }
  }
}
function checkOwned(target, directory) {
  var stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 63) !== 0)) ||
      (!directory && stat.nlink !== 1)) failure("unsafe_path", "Private context path is not owner-private: " + target);
}
function ownedDir(target, create) {
  if (create) {
    try { fs.mkdirSync(target, { mode: 448 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  checkOwned(target, true);
}
function marker(dir, value, create) {
  var file = path.join(dir, ".desk-private-owner");
  if (create) fs.writeFileSync(file, value, { flag: "wx", mode: 384 });
  checkOwned(file, false);
  if (fs.readFileSync(file, "utf8") !== value) failure("unsafe_path", "Private context ownership marker does not match");
}
function environment(source, root, socketDir, node) {
  var env = {};
  // An allowlist avoids future inherited profile/session/connection variables.
  Object.keys(source).forEach(function (key) {
    if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USER|USERNAME|LANG|LC_[A-Z_]+)$/i.test(key)) env[key] = source[key];
  });
  env.HOME = path.join(root, "home");
  env.USERPROFILE = env.HOME;
  env.XDG_CONFIG_HOME = path.join(root, "config");
  env.XDG_CACHE_HOME = path.join(root, "cache");
  env.XDG_DATA_HOME = path.join(root, "data");
  env.XDG_STATE_HOME = path.join(root, "state");
  env.XDG_RUNTIME_DIR = path.join(root, "runtime");
  env.LOCALAPPDATA = path.join(root, "local");
  env.APPDATA = path.join(root, "roaming");
  env.TMPDIR = socketDir;
  env.TMP = socketDir;
  env.TEMP = socketDir;
  return web.withNodeFirst(env, node, process.platform);
}
function scrub(value, source) {
  if (typeof value === "string") {
    Object.keys(source).forEach(function (key) {
      if (/token|password|credential|authorization|secret/i.test(key) && typeof source[key] === "string" && source[key].length > 2) value = value.split(source[key]).join("<redacted>");
    });
    return value.replace(/(?:https?|wss?):\/\/[^\s"\\<>]+/gi, function (url) {
      return /@|[?&#](?:[^=&#]*(?:token|password|secret|auth|key|code)[^=&#]*)=/i.test(url) ? "<redacted-url>" : url;
    }).replace(/\b(Bearer|Basic)\s+[^\s"\\]+/gi, "$1 <redacted>")
      .replace(/((?:token|password|authorization|secret)["']*\s*[:=]\s*["']*)[^"'\\\s,&}]+/gi, "$1<redacted>");
  }
  if (Array.isArray(value)) return value.map(function (item) { return scrub(item, source); });
  if (value && typeof value === "object") {
    var copy = {};
    Object.keys(value).forEach(function (key) {
      copy[key] = /token|password|credential|authorization|secret/i.test(key) ? "<redacted>" : scrub(value[key], source);
    });
    return copy;
  }
  return value;
}
function execute(node, args, options) {
  return new Promise(function (resolve, reject) {
    childProcess.execFile(node, args, { cwd: options.cwd, env: options.env, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, function (error, stdout, stderr) {
      var payload;
      try { payload = JSON.parse(stdout); } catch (e) {
        reject(Object.assign(new Error("Private browser runner did not return a confirmed result: " + (stderr || stdout || (error && (error.code || error.signal)) || "empty output") + "; any owned context remains a cleanup obligation"), { code: "runner_failed" }));
        return;
      }
      if (!payload || typeof payload !== "object") {
        reject(Object.assign(new Error("Private browser runner returned an invalid result; cleanup remains unconfirmed"), { code: "runner_failed" }));
        return;
      }
      if (error || payload.isError) reject(Object.assign(new Error(payload.message || payload.error || stderr || "Upstream command failed"), { code: payload.code || "upstream_failed" }));
      else resolve(payload);
    });
  });
}
function run(argv, options) {
  var o = options || {};
  var source = o.env || process.env;
  var id;
  var resources;
  var absent = false;
  return Promise.resolve().then(function () {
    validate(argv);
    if (argv[0] === "create") {
      var bytes = crypto.randomBytes(16);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = bytes.toString("hex");
      id = o.contextId ? o.contextId() : "private-" + hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
    } else id = argv[1];
    if (!ID.test(id || "")) failure("invalid_arguments", "Invalid generated context ID");
    if (argv[0] !== "create") {
      var state = web.stateDir(source, source.HOME || source.USERPROFILE || os.homedir());
      var parent = path.join(state, "private");
      var root = path.join(parent, id);
      try { ownedDir(parent, false); } catch (parentError) { if (parentError.code !== "ENOENT") throw parentError; }
      try {
        fs.lstatSync(root);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (argv[0] !== "discard") failure("context_absent", "Private context is absent; it was not recreated");
        absent = true;
        return null;
      }
      ownedDir(parent, false);
      ownedDir(root, false);
      marker(root, JSON.stringify({ contextId: id, directory: path.join(fs.realpathSync(state), "private", id) }), false);
    }
    return (o.prepareBrowserRuntime || web.prepareBrowserRuntime)(o);
  }).then(function (runtime) {
    if (absent) return { state: "absent" };
    var cliDir = path.join(runtime.installed.dir, "node_modules", "playwright-core", "lib", "tools", "cli-client");
    ["program", "registry", "session"].forEach(function (name) {
      if (!fs.existsSync(path.join(cliDir, name + ".js"))) failure("unsupported_cli", "Installed Playwright generation does not support the maintained private CLI modules");
    });
    var state = fs.realpathSync(runtime.stateRoot);
    var parent = path.join(state, "private");
    var root = path.join(parent, id);
    var creating = argv[0] === "create";
    resources = { contextDirectory: root, disposition: "owner-private directories retained; exports are never erased" };
    if (!creating && (!fs.existsSync(parent) || !fs.existsSync(root))) {
      failure("context_absent", "Private context disappeared while preparing the runtime; cleanup remains unconfirmed");
    }
    ownedDir(parent, creating);
    if (creating) fs.mkdirSync(root, { mode: 448 });
    ownedDir(root, false);
    var owner = JSON.stringify({ contextId: id, directory: root });
    marker(root, owner, creating);
    [".playwright", "home", "config", "cache", "data", "state", "runtime", "local", "roaming"].forEach(function (dir) { ownedDir(path.join(root, dir), creating); });
    var configFile = path.join(root, "config", "browser.json");
    resources.configFile = configFile;
    var choice = [];
    if (creating) {
      var selected = web.browserSelection([], process.platform, source, o.browserExists || function (file) { try { return fs.statSync(file).isFile(); } catch (e) { return false; } });
      choice = selected.args;
      var config = { browser: { isolated: true, launchOptions: { headless: true } } };
      if (selected.executablePath) config.browser.launchOptions.executablePath = selected.executablePath;
      fs.writeFileSync(configFile, JSON.stringify(config), { flag: "wx", mode: 384 });
    }
    checkOwned(configFile, false);
    // A short real directory, not a symlink or global Playwright override. Windows
    // keeps upstream's named pipes. A marker binds hash collisions to the exact owner.
    var shortBase = o.socketRoot || (process.platform === "win32" ? root : "/tmp");
    var socketDir = path.join(shortBase, "dp-" + (process.getuid ? process.getuid() : "win") + "-" + crypto.createHash("sha256").update(owner).digest("hex").slice(0, 16));
    resources.socketDirectory = socketDir;
    if (creating) fs.mkdirSync(socketDir, { mode: 448 });
    ownedDir(socketDir, false);
    marker(socketDir, owner, creating);
    var env = environment(source, root, socketDir, runtime.nodePath);
    var request = { operation: argv[0], contextId: id, cliDir: cliDir, root: root, socketDir: socketDir, args: argv.slice(3) };
    if (creating) {
      // The CLI accepts channels; executable selection uses its native config.
      request.browserArgs = (choice.indexOf("--browser") === -1 ? [] : ["--browser", choice[choice.indexOf("--browser") + 1]]).concat(["--config=" + configFile]);
    }
    return Promise.resolve((o.execute || execute)(runtime.nodePath, [path.join(__dirname, "private-browser-runtime.cjs"), JSON.stringify(request)], { cwd: root, env: env })).then(function (result) {
      if (!result || typeof result !== "object" || result.isError ||
          (argv[0] === "discard" ? ["discarded", "absent"].indexOf(result.state) === -1 : result.state !== "running")) {
        failure("runner_failed", "Private browser runner did not confirm " + argv[0] + "; cleanup remains unconfirmed");
      }
      return result;
    });
  }).then(function (result) {
    return { exitCode: 0, payload: scrub({ contextId: id, mode: "private", state: result.state, result: result.result, resources: resources }, source) };
  }, function (error) {
    return { exitCode: 1, payload: scrub({ isError: true, code: error.code || "private_browser_failed", message: error.message || String(error), contextId: id, resources: resources }, source) };
  });
}
module.exports = { run: run };
/* istanbul ignore next */
if (require.main === module) run(process.argv.slice(2)).then(function (result) {
  process.stdout.write(JSON.stringify(result.payload) + "\n");
  process.exitCode = result.exitCode;
});
