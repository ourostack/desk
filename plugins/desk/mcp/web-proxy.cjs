// The first-use half of Desk's default browser (see web.cjs): answers the host's MCP handshake itself, at once, while Playwright MCP installs, then runs Playwright MCP as a child and passes tool calls through to it.
//
// Why it exists: on a machine with no installed copy, the install can take longer than a host waits. A host must see one tool catalog for the life of a connection (Copilot CLI refuses a call with "MCP tool catalog changed before tool ... could be invoked" when the list it holds is out of date), so this proxy:
//
// - answers `initialize` and `tools/list` itself, immediately, and answers `tools/list` with the same catalog for as long as it runs. The catalog is a snapshot of Playwright MCP's own tool list (mcp/web-catalog.json), so names and input schemas match what the installed server exposes.
// - never sends `notifications/tools/list_changed`, not for the install and not when Playwright MCP says its own list changed.
// - holds every `tools/call` that arrives before Playwright MCP is ready, with a time limit, and sends it on once the child has finished its own handshake. A call fails only when the install itself failed or the limit passed, and then the answer carries the code and the fix.
//
// Once Playwright MCP is ready the child's answers, progress and log notifications are passed back unchanged. A child that exits ends this process the way the direct launch does, so the host reconnects to a fresh server.
//
// Like web.cjs it must parse on very old Node, so it uses ES5 syntax and only built-ins.

"use strict";

var DEFAULT_PROTOCOL = "2025-06-18";
var FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
var HANDSHAKE_ID = "desk-web-handshake";
// How long a call waits for the browser, and how long a child gets to exit after its stdin closes.
var HOLD_MS = 120000;
var CLOSE_MS = 5000;

function either(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

function frame(message) {
  var out = { jsonrpc: "2.0" };
  Object.keys(message).forEach(function (key) {
    out[key] = message[key];
  });
  return JSON.stringify(out) + "\n";
}

function callFailure(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

// Serve the host on stdin/stdout until it closes stdin, or the child ends this process.
//
// options.ready resolves { launch: { node, indexFile, args, env } } when Playwright MCP can start, or { payload } (a degraded payload) when it cannot; it never rejects.
// options.catalog is the tools/list answer. options.timeoutPayload, options.spawnPayload(error) and options.exitPayload(code, signal) build the degraded payloads for a call that waited too long, a child that would not start and a child that ended.
function serve(options) {
  var stdin = options.stdin;
  var stdout = options.stdout;
  var stderr = options.stderr;
  var holdMs = either(options.holdMs, HOLD_MS);
  var closeMs = either(options.closeMs, CLOSE_MS);
  var signals = options.signals;
  return new Promise(function (resolve) {
    var buffered = "";
    var queue = [];
    var inflight = {};
    var nextId = 1;
    var child = null;
    var childReady = false;
    var failure = null;
    var settled = false;
    var closed = false;
    var handlers = {};
    var childBuffered = "";

    function send(message) {
      stdout.write(frame(message));
    }

    function toChild(message) {
      child.stdin.write(frame(message));
    }

    function done() {
      queue.forEach(function (entry) {
        clearTimeout(entry.timer);
      });
      queue = [];
      resolve();
    }

    function detach() {
      FORWARDED_SIGNALS.forEach(function (signal) {
        signals.removeListener(signal, handlers[signal]);
      });
    }

    // Answer every held call with the failure, and every later call too.
    function fail(payload) {
      failure = payload;
      var held = queue;
      queue = [];
      held.forEach(function (entry) {
        clearTimeout(entry.timer);
        send({ id: entry.id, result: callFailure(payload) });
      });
    }

    function forward(entry) {
      var childId = nextId;
      nextId += 1;
      entry.childId = childId;
      inflight[childId] = entry.id;
      toChild({ id: childId, method: "tools/call", params: entry.params });
    }

    function flush() {
      var held = queue;
      queue = [];
      held.forEach(function (entry) {
        clearTimeout(entry.timer);
        forward(entry);
      });
    }

    function childMessage(message) {
      if (message.id === HANDSHAKE_ID) {
        if (message.error) {
          fail(options.spawnPayload(new Error(String(message.error.message))));
          child.kill("SIGTERM");
          return;
        }
        childReady = true;
        toChild({ method: "notifications/initialized" });
        flush();
        return;
      }
      if (message.id !== undefined && message.method === undefined) {
        var hostId = inflight[message.id];
        if (hostId === undefined) return;
        delete inflight[message.id];
        var reply = { id: hostId };
        if (message.error) reply.error = message.error;
        else reply.result = message.result;
        send(reply);
        return;
      }
      if (message.id !== undefined) {
        // The browser asks the host for something (roots, sampling); the handshake declared no such capability.
        toChild({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
        return;
      }
      // The catalog never changes under the host, whatever the browser says about its own list.
      if (message.method === "notifications/tools/list_changed") return;
      send({ method: message.method, params: message.params });
    }

    function onChildData(chunk) {
      childBuffered += chunk;
      var newline = childBuffered.indexOf("\n");
      while (newline !== -1) {
        var line = childBuffered.slice(0, newline).trim();
        childBuffered = childBuffered.slice(newline + 1);
        newline = childBuffered.indexOf("\n");
        var message = null;
        try {
          message = JSON.parse(line);
        } catch (error) {
          // A line that is not JSON-RPC is the browser's own noise, not part of the protocol.
        }
        if (message !== null && typeof message === "object") childMessage(message);
      }
    }

    function onChildExit(code, signal) {
      detach();
      var payload = options.exitPayload(code, signal);
      Object.keys(inflight).forEach(function (childId) {
        send({ id: inflight[childId], result: callFailure(payload) });
      });
      inflight = {};
      if (!childReady) {
        // It ended before it could take calls: answer them with the reason and keep the handshake alive.
        child = null;
        if (failure === null) fail(payload);
        if (closed) done();
        return;
      }
      if (signal) options.kill(process.pid, signal);
      else options.exit(code);
      done();
    }

    function start(launch) {
      try {
        child = options.spawn(launch.node, [launch.indexFile].concat(launch.args), { stdio: ["pipe", "pipe", "pipe"], env: launch.env, windowsHide: true });
      } catch (error) {
        child = null;
        fail(options.spawnPayload(error));
        return;
      }
      var launched = child;
      FORWARDED_SIGNALS.forEach(function (signal) {
        handlers[signal] = function () {
          launched.kill(signal);
        };
        signals.on(signal, handlers[signal]);
      });
      launched.stdout.setEncoding("utf8");
      launched.stdout.on("data", onChildData);
      launched.stderr.on("data", function (chunk) {
        stderr.write(chunk);
      });
      launched.stdin.on("error", function () {
        // The child went away first; its exit is reported below.
      });
      launched.on("error", function (error) {
        // A running child can also emit error, for example when kill() fails; only a child that never started is replaced by a failure.
        if (launched.pid !== undefined) {
          stderr.write("[web] " + error.message + "\n");
          return;
        }
        detach();
        child = null;
        fail(options.spawnPayload(error));
        if (closed) done();
      });
      launched.on("exit", onChildExit);
      toChild({
        id: HANDSHAKE_ID,
        method: "initialize",
        params: { protocolVersion: DEFAULT_PROTOCOL, capabilities: {}, clientInfo: { name: "desk-web", version: "0.0.0" } }
      });
    }

    options.ready.then(function (outcome) {
      settled = true;
      if (outcome.payload) {
        fail(outcome.payload);
        if (closed) done();
        return;
      }
      if (closed) {
        done();
        return;
      }
      start(outcome.launch);
    });

    function hold(id, params) {
      if (failure !== null) {
        send({ id: id, result: callFailure(failure) });
        return;
      }
      var entry = { id: id, params: params, childId: null, timer: null };
      if (childReady) {
        forward(entry);
        return;
      }
      entry.timer = setTimeout(function () {
        queue = queue.filter(function (other) {
          return other !== entry;
        });
        send({ id: id, result: callFailure(options.timeoutPayload) });
      }, holdMs);
      queue.push(entry);
    }

    function cancel(params) {
      var requestId = params.requestId;
      var waiting = queue.filter(function (entry) {
        return entry.id === requestId;
      })[0];
      if (waiting) {
        clearTimeout(waiting.timer);
        queue = queue.filter(function (entry) {
          return entry !== waiting;
        });
        return;
      }
      Object.keys(inflight).forEach(function (childId) {
        if (inflight[childId] === requestId) toChild({ method: "notifications/cancelled", params: { requestId: Number(childId), reason: params.reason } });
      });
    }

    function answer(line) {
      var text = line.trim();
      if (text === "") return;
      var message;
      try {
        message = JSON.parse(text);
      } catch (error) {
        send({ id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        send({ id: null, error: { code: -32600, message: "Invalid Request" } });
        return;
      }
      var params = either(message.params, {});
      if (message.id === undefined) {
        if (message.method === "notifications/cancelled") cancel(params);
        return;
      }
      if (message.method === "initialize") {
        send({ id: message.id, result: {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "desk-web", version: "0.0.0" }
        } });
      } else if (message.method === "ping") {
        send({ id: message.id, result: {} });
      } else if (message.method === "tools/list") {
        send({ id: message.id, result: { tools: options.catalog } });
      } else if (message.method === "tools/call") {
        hold(message.id, params);
      } else {
        send({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
      }
    }

    function onData(chunk) {
      buffered += chunk;
      var newline = buffered.indexOf("\n");
      while (newline !== -1) {
        answer(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }

    function onClose() {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onClose);
      stdin.removeListener("error", onClose);
      answer(buffered);
      buffered = "";
      closed = true;
      if (child !== null) {
        // Playwright MCP exits when its own stdin closes; a child that does not is stopped after a short wait.
        var closing = child;
        closing.stdin.end();
        var timer = setTimeout(function () {
          closing.kill("SIGTERM");
        }, closeMs);
        timer.unref();
        return;
      }
      if (settled) done();
    }

    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.on("end", onClose);
    stdin.on("error", onClose);
    stdin.resume();
  });
}

module.exports = {
  HOLD_MS: HOLD_MS,
  serve: serve
};
