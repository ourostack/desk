// Desk MCP idle proxy: what bootstrap.cjs runs when this process's Node is the right one.
//
// A Desk server holds about 200 MB once it has loaded its runtime, its tools and its search index, and a host keeps one per hosted session for days. This proxy is the process the host talks to: it holds none of that. It starts the real server (index.js) as a child, passes the MCP stream through line by line, and when nothing has crossed it for DESK_MCP_IDLE_MS (3 minutes by default) and no call is waiting for an answer, it ends the child, which gives all of that memory back. The next message from the host starts a new child first: the proxy replays the `initialize` handshake the host already sent (the child's answer to that replay is dropped, so the host never sees a second handshake) and then delivers the message.
//
// A new child runs the newest compatible installed Desk, not the copy this proxy was installed with (bootstrap.cjs newestDesk), so an idle session follows Desk releases without a restart, and a session whose copy a host removed keeps working on the next call.
//
// DESK_MCP_IDLE_MS=0 turns the release off: bootstrap.cjs then runs index.js in this process, as before.
//
// Like bootstrap.cjs it uses ES5 syntax and built-ins only.

"use strict";

var childProcess = require("child_process");
var path = require("path");
var v8 = require("v8");
var vm = require("vm");

var DEFAULT_IDLE_MS = 180000;
// A child told to stop (its stdin closed) gets this long to finish before it is killed.
var STOP_GRACE_MS = 5000;
// A call the host never cancelled and the child never answered stops holding the child up after this long.
var STALE_CALL_MS = 3600000;
// A server that ends this soon after it started counts as crashing on start; this many in a row end the proxy instead of respawning forever.
var QUICK_CRASH_MS = 10000;
var MAX_QUICK_CRASHES = 3;
var PARENT_CHECK_MS = 5000;
var RESUME_ID = "desk-idle-proxy-resume";
var FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// The idle time from DESK_MCP_IDLE_MS: a whole number of milliseconds, 0 for never, the default when unset or unreadable.
function idleMs(env) {
  var text = env.DESK_MCP_IDLE_MS;
  if (text === undefined || String(text).trim() === "") return DEFAULT_IDLE_MS;
  var value = Number(text);
  return isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_IDLE_MS;
}

function parse(line) {
  try {
    var message = JSON.parse(line);
    return message !== null && typeof message === "object" && !Array.isArray(message) ? message : null;
  } catch (error) {
    return null;
  }
}

function hasId(message) {
  return message.id !== undefined && message.id !== null;
}

// options: { launchChild() -> child, compact() (collects garbage once a server has ended), stdin, stdout, stderr, idleMs, now, setTimer, clearTimer, exit, signals, kill }
// The child is { stdin, stdout, kill(signal), on(event, listener) } like a child_process child with piped stdin and stdout.
function createIdleProxy(options) {
  var child = null;
  var stopping = false;
  var resuming = false;
  var clientEnded = false;
  var queue = [];
  var initRequest = null;
  var initialized = null;
  var logLevel = null;
  var clientCalls = {};
  var serverCalls = {};
  var lastTraffic = options.now();
  var idleTimer = null;
  var killTimer = null;
  var finished = null;
  var startedAt = 0;
  var quickCrashes = 0;
  var signalled = false;

  function touch() {
    lastTraffic = options.now();
  }

  function track(calls, id) {
    calls[JSON.stringify(id)] = options.now();
  }

  function live(calls) {
    var cutoff = options.now() - STALE_CALL_MS;
    return Object.keys(calls).some(function (key) {
      return calls[key] > cutoff;
    });
  }

  function writeToChild(line) {
    child.stdin.write(line + "\n");
  }

  function toClient(line) {
    options.stdout.write(line + "\n");
  }

  function finish(code) {
    if (finished !== null) return;
    finished = { code: code };
    clearTimer();
    options.exit(code);
  }

  function clearTimer() {
    if (idleTimer !== null) options.clearTimer(idleTimer);
    if (killTimer !== null) options.clearTimer(killTimer);
    idleTimer = null;
    killTimer = null;
  }

  function armIdle(delay) {
    if (options.idleMs <= 0 || clientEnded) return;
    if (idleTimer !== null) options.clearTimer(idleTimer);
    idleTimer = options.setTimer(checkIdle, delay);
  }

  function checkIdle() {
    idleTimer = null;
    if (child === null || stopping || resuming) return;
    var quiet = options.now() - lastTraffic;
    if (quiet < options.idleMs || live(clientCalls) || live(serverCalls)) {
      armIdle(quiet < options.idleMs ? options.idleMs - quiet : options.idleMs);
      return;
    }
    stop();
  }

  // Ends the child by closing its stdin, which is how index.js shuts down cleanly; a child that does not leave is killed.
  function stop() {
    stopping = true;
    try {
      child.stdin.end();
    } catch (error) {
      // The exit event below still arrives.
    }
    var stopped = child;
    killTimer = options.setTimer(function () {
      killTimer = null;
      stopped.kill("SIGKILL");
    }, STOP_GRACE_MS);
  }

  function start() {
    var started;
    try {
      started = options.launchChild();
    } catch (error) {
      return error;
    }
    child = started;
    stopping = false;
    startedAt = options.now();
    var buffered = "";
    started.stdout.setEncoding("utf8");
    started.stdout.on("data", function (chunk) {
      buffered += chunk;
      var newline = buffered.indexOf("\n");
      while (newline !== -1) {
        fromChild(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    });
    started.stdin.on("error", function () {
      // A child that is gone: its exit event says so.
    });
    started.on("error", function (error) {
      options.stderr.write("[desk-mcp] idle proxy: " + String(error) + "\n");
    });
    started.on("exit", function (code, signal) {
      onExit(started, code, signal);
    });
    touch();
    armIdle(options.idleMs);
    if (initRequest !== null) {
      resuming = true;
      var replay = parse(initRequest);
      replay.id = RESUME_ID;
      writeToChild(JSON.stringify(replay));
    } else {
      flush();
    }
    return null;
  }

  function flush() {
    var lines = queue;
    queue = [];
    lines.forEach(writeToChild);
  }

  function onExit(exited, code, signal) {
    if (exited !== child) return;
    child = null;
    resuming = false;
    if (killTimer !== null) options.clearTimer(killTimer);
    killTimer = null;
    if (stopping) {
      stopping = false;
      clientCalls = {};
      serverCalls = {};
      options.compact();
      if (clientEnded) return finish(code || 0);
      if (queue.length > 0) ensureChild();
      return;
    }
    // A child that ended by itself or by a crash: the host keeps its tools. Calls it never answered get an error the host can retry, and the next message starts a new child, as after an idle stop.
    var reason = signal ? "ended on " + signal : "exited with code " + code;
    quickCrashes = options.now() - startedAt < QUICK_CRASH_MS ? quickCrashes + 1 : 1;
    if (clientEnded || signalled || quickCrashes >= MAX_QUICK_CRASHES) {
      options.stderr.write("[desk-mcp] idle proxy: the server " + reason + (clientEnded || signalled ? "\n" : " " + quickCrashes + " times in a row; not restarting it\n"));
      return finish(code === null || code === undefined ? 1 : code);
    }
    options.stderr.write("[desk-mcp] idle proxy: the server " + reason + "; it restarts on the next message\n");
    var lost = Object.keys(clientCalls);
    clientCalls = {};
    serverCalls = {};
    lost.forEach(function (key) {
      toClient(JSON.stringify({
        jsonrpc: "2.0",
        id: JSON.parse(key),
        error: { code: -32603, message: "The Desk server ended " + reason + " before it answered. It restarts on the next call: retry this call. If it keeps happening, file it with friction_add (about: \"system\") including this message." }
      }));
    });
    if (queue.length > 0) ensureChild();
  }

  function ensureChild() {
    var error = start();
    if (error !== null) {
      options.stderr.write("[desk-mcp] idle proxy: could not start the server: " + String(error) + "\n");
      finish(1);
    }
  }

  function fromChild(line) {
    if (line === "") return;
    touch();
    var message = parse(line);
    if (message !== null && hasId(message)) {
      if (message.id === RESUME_ID && resuming) {
        resuming = false;
        if (initialized !== null) writeToChild(initialized);
        if (logLevel !== null) writeToChild(logLevel);
        flush();
        return;
      }
      if (message.method !== undefined) track(serverCalls, message.id);
      else delete clientCalls[JSON.stringify(message.id)];
    }
    toClient(line);
  }

  function fromClient(line) {
    if (line === "") return;
    touch();
    var message = parse(line);
    if (message !== null) {
      if (message.method === "initialize" && hasId(message)) {
        initRequest = line;
        initialized = null;
      } else if (message.method === "notifications/initialized") {
        initialized = line;
      } else if (message.method === "logging/setLevel") {
        logLevel = line;
      } else if (message.method === "notifications/cancelled" && message.params && message.params.requestId !== undefined) {
        delete clientCalls[JSON.stringify(message.params.requestId)];
      }
      if (hasId(message)) {
        if (message.method !== undefined) track(clientCalls, message.id);
        else delete serverCalls[JSON.stringify(message.id)];
      }
    }
    if (child === null || stopping || resuming) {
      queue.push(line);
      if (child === null) ensureChild();
      return;
    }
    writeToChild(line);
    armIdle(options.idleMs);
  }

  function onClientEnd() {
    clientEnded = true;
    clearTimer();
    if (child === null) return finish(0);
    if (!stopping) stop();
  }

  function begin() {
    var buffered = "";
    options.stdin.setEncoding("utf8");
    options.stdin.on("data", function (chunk) {
      buffered += chunk;
      var newline = buffered.indexOf("\n");
      while (newline !== -1) {
        fromClient(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    });
    options.stdin.on("end", function () {
      fromClient(buffered);
      buffered = "";
      onClientEnd();
    });
    options.stdin.on("error", onClientEnd);
    // A host that is gone cannot be answered: end like a closed stdin rather than keep a server alive with no client.
    if (options.stdout.on) options.stdout.on("error", onClientEnd);
    if (options.watchParent) options.watchParent(onClientEnd);
    var signalHandlers = {};
    FORWARDED_SIGNALS.forEach(function (signal) {
      signalHandlers[signal] = function () {
        signalled = true;
        if (child !== null) return child.kill(signal);
        // Stop listening first, so the re-raised signal takes its default action and ends the proxy instead of coming
        // back to this listener, which would raise it again forever.
        FORWARDED_SIGNALS.forEach(function (name) {
          options.signals.removeListener(name, signalHandlers[name]);
        });
        options.kill(process.pid, signal);
      };
      options.signals.on(signal, signalHandlers[signal]);
    });
    options.stdin.resume();
    return start();
  }

  return {
    begin: begin,
    // Tests: whether a server is running right now.
    running: function () {
      return child !== null;
    }
  };
}

/* istanbul ignore next -- the process's own streams, timers and spawn; every test injects its own */
function hostDefaults() {
  return {
    env: process.env,
    spawn: childProcess.spawn,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    exit: process.exit,
    signals: process,
    kill: process.kill,
    // Calls `gone` once when the process that started this proxy has ended: its pid changed or it no longer exists. The timer never keeps the process alive.
    watchParent: function (gone) {
      var initial = process.ppid;
      if (!(initial > 1)) return;
      var timer = setInterval(function () {
        var alive = true;
        try {
          process.kill(initial, 0);
        } catch (error) {
          alive = error && error.code === "EPERM";
        }
        if (process.ppid !== initial || !alive) {
          clearInterval(timer);
          gone();
        }
      }, PARENT_CHECK_MS);
      if (timer.unref) timer.unref();
    },
    // The process's heap can sit at tens of MB of garbage from its own startup and traffic; a collection after a server ends brings it back to the baseline.
    compact: function () {
      try {
        v8.setFlagsFromString("--expose-gc");
        vm.runInNewContext("gc")();
      } catch (error) {
        // Not collecting only leaves the memory for later.
      }
    }
  };
}

// Runs the proxy for bootstrap.cjs: `error` is what kept the first server from starting, or null. Options left undefined are the process's own.
function runIdleProxy(o) {
  var defaults = hostDefaults();
  function pick(name) {
    return o[name] !== undefined ? o[name] : defaults[name];
  }
  var env = pick("env");
  var spawn = pick("spawn");
  var proxy = createIdleProxy({
    launchChild: function () {
      var childEnv = Object.assign({}, env);
      // The child's parent is this proxy, not the host: the host's own pid is what "other sessions" must leave out.
      if (!childEnv.DESK_SESSION_HOST_PID) childEnv.DESK_SESSION_HOST_PID = String(process.ppid);
      var indexFile = o.indexFile;
      // Each new server runs the newest compatible installed Desk, so an idle session moves to the current Desk on its next message; no choice, or a failing one, keeps the copy this proxy came from.
      var newest = null;
      try {
        newest = typeof o.chooseIndex === "function" ? o.chooseIndex() : null;
      } catch (error) {
        newest = null;
      }
      if (newest) {
        var ownRoot = path.dirname(path.dirname(o.indexFile));
        // A root the host set that no longer exists (a pruned version) is replaced too.
        if (!childEnv.DESK_PLUGIN_ROOT || childEnv.DESK_PLUGIN_ROOT === ownRoot || !o.exists(childEnv.DESK_PLUGIN_ROOT)) childEnv.DESK_PLUGIN_ROOT = newest.pluginRoot;
        indexFile = newest.indexFile;
        pick("stderr").write("[desk-mcp] idle proxy: running Desk " + newest.version + " from " + newest.pluginRoot + "\n");
      }
      return spawn(o.node, [indexFile].concat(o.args), { stdio: ["pipe", "pipe", "inherit"], env: childEnv, windowsHide: true });
    },
    stdin: pick("stdin"),
    stdout: pick("stdout"),
    stderr: pick("stderr"),
    idleMs: o.idleMs,
    now: pick("now"),
    setTimer: pick("setTimer"),
    clearTimer: pick("clearTimer"),
    exit: pick("exit"),
    signals: pick("signals"),
    kill: pick("kill"),
    compact: pick("compact"),
    watchParent: pick("watchParent")
  });
  return { proxy: proxy, error: proxy.begin() };
}

module.exports = {
  DEFAULT_IDLE_MS: DEFAULT_IDLE_MS,
  createIdleProxy: createIdleProxy,
  idleMs: idleMs,
  runIdleProxy: runIdleProxy
};
