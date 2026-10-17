// One fresh compatible process per operation: Registry's cached HOME never crosses
// contexts. No daemon, PID ledger, profile sweep or recovery policy lives here.
"use strict";
var fs = require("fs");
var path = require("path");
var net = require("net");
function fail(code, message) { throw Object.assign(new Error(message), { code: code }); }
function within(file, root) {
  var relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && relative.indexOf(".." + path.sep) !== 0 && !path.isAbsolute(relative));
}
function noLinks(file, root) {
  if (!within(file, root)) fail("unsafe_registry", "Registry path escaped its private context");
  var current = root;
  var parts = path.relative(root, file).split(path.sep).filter(Boolean);
  [""].concat(parts).forEach(function (part) {
    if (part) current = path.join(current, part);
    try {
      var stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) fail("unsafe_registry", "Registry/socket path is not owned");
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  });
}
function validateEntry(entry, info, request) {
  var file = path.join(info.daemonProfilesDir, request.contextId + ".session");
  if (entry.file !== file || entry.daemonDir !== info.daemonProfilesDir || entry.config.name !== request.contextId ||
      !entry.config.browser || entry.config.browser.userDataDir != null ||
      !entry.config.cli || entry.config.cli.persistent || entry.config.attached ||
      entry.config.workspaceDir !== request.root) fail("unsafe_registry", "Session metadata does not describe this in-memory context");
  noLinks(file, request.root);
  if (process.platform === "win32") {
    if (typeof entry.config.socketPath !== "string" || entry.config.socketPath.indexOf("\\\\.\\pipe\\pw-") !== 0 || entry.config.socketPath.indexOf(request.contextId) === -1) fail("unsafe_registry", "Unexpected private named pipe");
  } else {
    if (typeof entry.config.socketPath !== "string" || !/\.sock$/.test(entry.config.socketPath)) fail("unsafe_registry", "Missing or invalid private socket");
    noLinks(entry.config.socketPath, request.socketDir);
    try {
      if (!fs.lstatSync(entry.config.socketPath).isSocket()) fail("unsafe_registry", "Private socket metadata points at a non-socket resource");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function validateRegistry(base, root) {
  noLinks(base, root);
  if (!fs.existsSync(base)) return;
  fs.readdirSync(base).forEach(function (name) {
    var dir = path.join(base, name);
    noLinks(dir, root);
    if (fs.lstatSync(dir).isDirectory()) fs.readdirSync(dir).forEach(function (file) {
      noLinks(path.join(dir, file), root);
    });
  });
}
function connect(socketPath) {
  return new Promise(function (resolve, reject) {
    var socket = net.createConnection(socketPath, function () {
      clearTimeout(timer);
      resolve(socket);
    });
    var timer = setTimeout(function () {
      socket.destroy();
      reject(Object.assign(new Error("Private browser connection timed out; session metadata is retained"), { code: "session_unreachable" }));
    }, 10000);
    socket.on("error", function (error) {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}
function send(socket, SocketConnection, method, params) {
  return new Promise(function (resolve, reject) {
    var connection = new SocketConnection(socket);
    var timer = setTimeout(function () {
      finish(Object.assign(new Error("Private browser reply timed out; cleanup remains unconfirmed"), { code: "session_unreachable" }));
    }, 90000);
    var finished = false;
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      connection.close();
      if (error) reject(error);
      else resolve(result);
    }
    socket.on("error", function (error) { finish(error); });
    connection.onclose = function () {
      finish(Object.assign(new Error("Private browser closed without acknowledging the command"), { code: "cleanup_unconfirmed" }));
    };
    connection.onmessage = function (message) {
      if (message.id !== 1) return finish(new Error("Unexpected private browser response"));
      if (message.error) return finish(new Error(message.error));
      finish(null, message.result);
    };
    connection.send({ id: 1, method: method, params: params }).catch(finish);
  });
}
function main(request) {
  var registryModule = require(path.join(request.cliDir, "registry.js"));
  var Session = require(path.join(request.cliDir, "session.js")).Session;
  var program = require(path.join(request.cliDir, "program.js")).program;
  var SocketConnection = require(path.join(request.cliDir, "..", "utils", "socketConnection.js")).SocketConnection;
  if (typeof registryModule.createClientInfo !== "function" || !registryModule.Registry ||
      typeof registryModule.Registry.load !== "function" || typeof Session !== "function" || typeof program !== "function" ||
      typeof SocketConnection !== "function") fail("unsupported_cli", "Installed Playwright CLI module interface is unsupported");
  var info = registryModule.createClientInfo();
  noLinks(info.daemonProfilesDir, request.root);
  var entry;
  var session;
  var captured = "";
  var write = process.stdout.write;
  function load() {
    var expected = path.join(info.daemonProfilesDir, request.contextId + ".session");
    noLinks(expected, request.root);
    if (typeof registryModule.baseDaemonDir === "function") validateRegistry(registryModule.baseDaemonDir(), request.root);
    return registryModule.Registry.load().then(function (registry) {
      entry = registry.entry(info, request.contextId);
      if (!entry && fs.existsSync(expected)) fail("session_metadata_invalid", "Private session metadata is present but unreadable; cleanup remains outstanding");
      if (entry) {
        validateEntry(entry, info, request);
        session = new Session(entry);
      }
    });
  }
  function live() {
    if (!entry) fail("context_absent", "Private browser is absent; it was not recreated");
    if (!session.isCompatible(info)) fail("session_incompatible", "Private browser session is incompatible with the selected CLI");
    return connect(entry.config.socketPath);
  }
  function command(args) {
    process.argv = [process.execPath, "playwright-cli", "--session=" + request.contextId, "--json"].concat(args);
    process.stdout.write = function (chunk) { captured += String(chunk); return true; };
    return Promise.resolve().then(function () { return program(); }).then(function () {
      process.stdout.write = write;
      var result;
      try { result = JSON.parse(captured); } catch (e) { result = captured; }
      if (process.exitCode || (result && result.isError)) fail("upstream_failed", typeof result === "object" ? (result.error || "Upstream command failed") : captured);
      return result;
    }, function (error) { process.stdout.write = write; throw error; });
  }
  return load().then(function () {
    if (request.operation === "create") {
      if (entry) fail("context_exists", "A private context with this ID already exists");
      return command(["open", "--idle-timeout=0"].concat(request.browserArgs || [])).then(function (result) {
        return load().then(live).then(function (socket) {
          socket.destroy();
          return { state: "running", result: result };
        });
      });
    }
    if (request.operation === "discard") {
      if (!entry) return { state: "absent" };
      // Session._connect unlinks on every connection error. Keep the same
      // non-destructive connection through the daemon's affirmative stop ACK.
      return live().then(function (socket) { return send(socket, SocketConnection, "stop", {}); }).then(function (ack) {
        if (ack !== "ok") fail("cleanup_unconfirmed", "Private browser did not confirm stop");
        if (process.platform !== "win32" && fs.existsSync(entry.config.socketPath)) fail("cleanup_unconfirmed", "Private socket remains after stop; cleanup remains outstanding");
        if (fs.existsSync(entry.file)) return connect(entry.config.socketPath).then(function (socket) {
          socket.destroy();
          fail("cleanup_unconfirmed", "Private browser still responds after stop; cleanup remains outstanding");
        }, function (error) {
          if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED") throw error;
          return session.deleteSessionConfig();
        });
      }).then(function () {
        if (fs.existsSync(entry.file)) fail("cleanup_unconfirmed", "Private session metadata remains after stop");
        return { state: "discarded" };
      });
    }
    return live().then(function (socket) {
      if (request.operation !== "run") {
        socket.destroy();
        return { state: "running" };
      }
      var args;
      try {
        var help = require(path.join(request.cliDir, "help.json"));
        var minimist = require(path.join(request.cliDir, "minimist.js")).minimist;
        args = minimist(request.args, { boolean: help.booleanOptions.concat(["all", "g", "help", "json", "raw", "version"]), string: ["_"] });
        if (help.commands[args._[0]] && help.commands[args._[0]].raw) args.raw = true;
      } catch (error) { socket.destroy(); throw error; }
      var raw = !!args.raw;
      delete args.raw;
      delete args.json;
      delete args.session;
      return send(socket, SocketConnection, "run", { args: args, cwd: request.root, raw: raw, json: true }).then(function (response) {
        if (response.isError) fail("upstream_failed", response.text || "Upstream command failed");
        var result;
        try { result = JSON.parse(response.text); } catch (error) { result = response.text; }
        return { state: "running", result: result };
      });
    });
  });
}
/* istanbul ignore next */
if (require.main === module) {
  Promise.resolve().then(function () { return main(JSON.parse(process.argv[2])); }).then(function (result) {
    process.stdout.write(JSON.stringify(result) + "\n");
  }, function (error) {
    process.stdout.write(JSON.stringify({ isError: true, code: error.code || "upstream_failed", message: error.message || String(error) }) + "\n");
    process.exitCode = 1;
  });
}
