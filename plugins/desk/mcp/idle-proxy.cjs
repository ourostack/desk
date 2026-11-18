// Desk MCP idle proxy: what bootstrap.cjs runs when this process's Node is the right one.
//
// A Desk server holds about 200 MB once it has loaded its runtime, its tools and its search index, and a host keeps one per hosted session for days. This proxy is the process the host talks to: it holds none of that. It starts the real server (index.js) as a child, passes the MCP stream through line by line, and when nothing has crossed it for DESK_MCP_IDLE_MS (3 minutes by default) and no call is waiting for an answer, it ends the child, which gives all of that memory back. The next message from the host starts a new child first: the proxy replays the `initialize` handshake the host already sent (the child's answer to that replay is dropped, so the host never sees a second handshake) and then delivers the message.
//
// DESK_MCP_IDLE_MS=0 turns the release off: bootstrap.cjs then runs index.js in this process, as before.
//
// Like bootstrap.cjs it uses ES5 syntax and built-ins only.

"use strict";

var childProcess = require("child_process");

var DEFAULT_IDLE_MS = 180000;
// A child told to stop (its stdin closed) gets this long to finish before it is killed.
var STOP_GRACE_MS = 5000;
// A call the host never cancelled and the child never answered stops holding the child up after this long.
var STALE_CALL_MS = 3600000;
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

// options: { spawnChild() -> child, stdin, stdout, stderr, idleMs, now, setTimer, clearTimer, exit, signals, kill }
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
      started = options.spawnChild();
    } catch (error) {
      return error;
    }
    child = started;
    stopping = false;
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
      if (clientEnded) return finish(code || 0);
      if (queue.length > 0) ensureChild();
      return;
    }
    // A child that ended by itself or by a crash takes the proxy with it, as it would have taken an in-process server.
    if (signal) options.stderr.write("[desk-mcp] idle proxy: the server ended on " + signal + "\n");
    finish(code === null || code === undefined ? 1 : code);
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
    FORWARDED_SIGNALS.forEach(function (signal) {
      options.signals.on(signal, function () {
        if (child !== null) child.kill(signal);
        else options.kill(process.pid, signal);
      });
    });
    if (options.stdin.resume) options.stdin.resume();
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
    kill: process.kill
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
    spawnChild: function () {
      var childEnv = Object.assign({}, env);
      // The child's parent is this proxy, not the host: the host's own pid is what "other sessions" must leave out.
      if (!childEnv.DESK_SESSION_HOST_PID) childEnv.DESK_SESSION_HOST_PID = String(process.ppid);
      return spawn(o.node, [o.indexFile].concat(o.args), { stdio: ["pipe", "pipe", "inherit"], env: childEnv, windowsHide: true });
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
    kill: pick("kill")
  });
  return { proxy: proxy, error: proxy.begin() };
}

module.exports = {
  DEFAULT_IDLE_MS: DEFAULT_IDLE_MS,
  createIdleProxy: createIdleProxy,
  idleMs: idleMs,
  runIdleProxy: runIdleProxy
};
