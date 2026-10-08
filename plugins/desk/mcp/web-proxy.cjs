// The first-use half of Desk's default browser (see web.cjs): answers the host's MCP handshake itself, at once, while Playwright MCP installs, then runs Playwright MCP as a child and passes tool calls through to it.
//
// Why it exists: on a machine with no installed copy, the install can take longer than a host waits. A host must see one tool catalog for the life of a connection (Copilot CLI refuses a call with "MCP tool catalog changed before tool ... could be invoked" when the list it holds is out of date), so this proxy:
//
// - answers `initialize` and `tools/list` itself, immediately, and answers `tools/list` with the same catalog for as long as it runs. The catalog is a snapshot of Playwright MCP's own tool list (mcp/web-catalog.json), so names and input schemas match what the installed server exposes.
// - never sends `notifications/tools/list_changed`, not for the install and not when Playwright MCP says its own list changed.
// - holds every `tools/call` that arrives before Playwright MCP is ready, with a time limit, and sends it on once the child has finished its own handshake. A call fails only when the install itself failed or the limit passed, and then the answer carries the code and the fix.
//
// While a call with a progress token is held, the proxy sends `notifications/progress` about every 10 seconds, so a host that resets its call timeout on progress keeps waiting. When the child is ready the proxy asks it for its own tool list and writes one stderr line naming any tools added, removed or changed since the snapshot; it keeps serving the snapshot. A launch that waited out another session's install retries the install on the next call instead of failing until the host reconnects. Stop signals (SIGINT, SIGTERM, SIGHUP) are handled from the start: they end a running install, process group included, or are passed to the browser.
//
// Once Playwright MCP is ready the child's answers, progress and log notifications are passed back unchanged. A child that exits ends this process the way the direct launch does, so the host reconnects to a fresh server.
//
// Like web.cjs it must parse on very old Node, so it uses ES5 syntax and only built-ins.

"use strict";

var DEFAULT_PROTOCOL = "2025-06-18";
var FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
var HANDSHAKE_ID = "desk-web-handshake";
var LIST_ID = "desk-web-catalog";
var PROGRESS_MS = 10000;
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

// Split a stream into lines without rescanning text already searched: `state.scanned` is how much of `state.text` held no newline.
function feed(state, chunk, handle) {
  state.text += chunk;
  var newline = state.text.indexOf("\n", state.scanned);
  while (newline !== -1) {
    var line = state.text.slice(0, newline);
    state.text = state.text.slice(newline + 1);
    handle(line);
    newline = state.text.indexOf("\n");
  }
  state.scanned = state.text.length;
}

// JSON with sorted keys, so two tools compare equal whatever order a server wrote their fields in.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(function (key) {
    return JSON.stringify(key) + ":" + canonical(value[key]);
  }).join(",") + "}";
}

// The tools added, removed and changed (by name) between a snapshot and a live list.
function diffCatalog(snapshot, live) {
  var before = {};
  var after = {};
  snapshot.forEach(function (tool) {
    before[tool.name] = canonical(tool);
  });
  live.forEach(function (tool) {
    after[tool.name] = canonical(tool);
  });
  return {
    added: Object.keys(after).filter(function (name) {
      return before[name] === undefined;
    }).sort(),
    removed: Object.keys(before).filter(function (name) {
      return after[name] === undefined;
    }).sort(),
    changed: Object.keys(after).filter(function (name) {
      return before[name] !== undefined && before[name] !== after[name];
    }).sort()
  };
}

function describeDiff(diff) {
  var parts = [];
  if (diff.added.length) parts.push("added " + diff.added.join(", "));
  if (diff.removed.length) parts.push("removed " + diff.removed.join(", "));
  if (diff.changed.length) parts.push("changed " + diff.changed.join(", "));
  return parts.join("; ");
}

// Serve the host on stdin/stdout until it closes stdin, or the child ends this process.
//
// options.ready resolves { launch: { node, indexFile, args, env } } when Playwright MCP can start, or { payload } (a degraded payload) when it cannot; it never rejects.
// options.beforeCall(params), when given, runs before each tools/call goes to the browser and resolves null to go on or { payload } to answer the call with that degraded payload instead; it never rejects. options.afterCall(params), when given, runs after the browser's answer to a call has been sent to the host.
// options.catalog is the tools/list answer, and options.catalogVersion names the Playwright MCP release it was taken from. options.retry() starts the install again and returns a new ready promise, and options.abort() ends a running install; options.progressMs sets the progress interval. options.timeoutPayload, options.spawnPayload(error) and options.exitPayload(code, signal) build the degraded payloads for a call that waited too long, a child that would not start and a child that ended.
function serve(options) {
  var stdin = options.stdin;
  var stdout = options.stdout;
  var stderr = options.stderr;
  var holdMs = either(options.holdMs, HOLD_MS);
  var closeMs = either(options.closeMs, CLOSE_MS);
  var progressMs = either(options.progressMs, PROGRESS_MS);
  var signals = options.signals;
  return new Promise(function (resolve) {
    var hostLines = { text: "", scanned: 0 };
    var childLines = { text: "", scanned: 0 };
    var queue = [];
    var inflight = {};
    var calls = {};
    var nextId = 1;
    var child = null;
    var childReady = false;
    var failure = null;
    var retryable = false;
    var settled = false;
    var closed = false;
    var handlers = {};

    function send(message) {
      stdout.write(frame(message));
    }

    function toChild(message) {
      child.stdin.write(frame(message));
    }

    // A held call's timers: its hold limit and its progress ticker.
    function release(entry) {
      clearTimeout(entry.timer);
      clearInterval(entry.ticker);
    }

    function detach() {
      FORWARDED_SIGNALS.forEach(function (signal) {
        signals.removeListener(signal, handlers[signal]);
      });
    }

    function done() {
      queue.forEach(release);
      queue = [];
      detach();
      resolve();
    }

    // A stop signal ends the browser when it runs, which then ends this process; with no browser yet it ends the install and then this process.
    FORWARDED_SIGNALS.forEach(function (signal) {
      handlers[signal] = function () {
        if (child !== null) {
          child.kill(signal);
          return;
        }
        options.abort();
        detach();
        options.kill(process.pid, signal);
        done();
      };
      signals.on(signal, handlers[signal]);
    });

    // Answer every held call with the failure, and every later call too.
    function fail(payload, retry) {
      failure = payload;
      retryable = retry === true;
      var held = queue;
      queue = [];
      held.forEach(function (entry) {
        release(entry);
        send({ id: entry.id, result: callFailure(payload) });
      });
    }

    function dispatch(entry) {
      var childId = nextId;
      nextId += 1;
      entry.childId = childId;
      inflight[childId] = entry.id;
      calls[childId] = entry.params;
      toChild({ id: childId, method: "tools/call", params: entry.params });
    }

    function forward(entry) {
      if (options.beforeCall === undefined) {
        dispatch(entry);
        return;
      }
      options.beforeCall(entry.params).then(function (gate) {
        if (gate === null) dispatch(entry);
        else send({ id: entry.id, result: callFailure(gate.payload) });
      });
    }

    function flush() {
      var held = queue;
      queue = [];
      held.forEach(function (entry) {
        release(entry);
        forward(entry);
      });
    }

    // One stderr line when the installed browser's own tool list differs from the snapshot being served; the snapshot stays.
    function compare(message) {
      if (!message.result || !Array.isArray(message.result.tools)) return;
      var diff = diffCatalog(options.catalog, message.result.tools);
      var text = describeDiff(diff);
      if (text !== "") stderr.write("[web] the installed browser's tool list differs from the snapshot (Playwright MCP " + options.catalogVersion + ") this session keeps serving: " + text + "\n");
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
        toChild({ id: LIST_ID, method: "tools/list" });
        flush();
        return;
      }
      if (message.id === LIST_ID) {
        compare(message);
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
        var params = calls[message.id];
        delete calls[message.id];
        if (options.afterCall !== undefined) options.afterCall(params);
        return;
      }
      if (message.id !== undefined) {
        // The browser asks the host for something (roots, sampling); the handshake declared no such capability. A ping is answered.
        if (message.method === "ping") toChild({ id: message.id, result: {} });
        else toChild({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
        return;
      }
      // The catalog never changes under the host, whatever the browser says about its own list.
      if (message.method === "notifications/tools/list_changed") return;
      send({ method: message.method, params: message.params });
    }

    function onChildLine(raw) {
      var message = null;
      try {
        message = JSON.parse(raw.trim());
      } catch (error) {
        // A line that is not JSON-RPC is the browser's own noise, not part of the protocol.
      }
      if (message !== null && typeof message === "object") childMessage(message);
    }

    function onChildData(chunk) {
      feed(childLines, chunk, onChildLine);
    }

    function onChildExit(code, signal) {
      var payload = options.exitPayload(code, signal);
      Object.keys(inflight).forEach(function (childId) {
        send({ id: inflight[childId], result: callFailure(payload) });
      });
      inflight = {};
      calls = {};
      if (!childReady) {
        // It ended before it could take calls: answer them with the reason and keep the handshake alive.
        child = null;
        if (failure === null) fail(payload);
        if (closed) done();
        return;
      }
      detach();
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

    function track(ready) {
      settled = false;
      ready.then(function (outcome) {
        settled = true;
        if (outcome.payload) {
          fail(outcome.payload, outcome.retry);
          if (closed) done();
          return;
        }
        if (closed) {
          done();
          return;
        }
        start(outcome.launch);
      });
    }

    track(options.ready);

    function hold(id, params) {
      if (failure !== null) {
        if (!retryable) {
          send({ id: id, result: callFailure(failure) });
          return;
        }
        // The last wait ended because another session's install outlasted the limit; that session may have finished since.
        failure = null;
        retryable = false;
        track(options.retry());
      }
      var entry = { id: id, params: params, childId: null, timer: null, ticker: null };
      if (childReady) {
        forward(entry);
        return;
      }
      entry.timer = setTimeout(function () {
        release(entry);
        queue = queue.filter(function (other) {
          return other !== entry;
        });
        send({ id: id, result: callFailure(options.timeoutPayload) });
      }, holdMs);
      var meta = params._meta;
      if (meta && meta.progressToken !== undefined) {
        var ticks = 0;
        entry.ticker = setInterval(function () {
          ticks += 1;
          send({ method: "notifications/progress", params: { progressToken: meta.progressToken, progress: ticks, message: "Installing the browser; the call continues when it is ready" } });
        }, progressMs);
      }
      queue.push(entry);
    }

    function cancel(params) {
      var requestId = params.requestId;
      var waiting = queue.filter(function (entry) {
        return entry.id === requestId;
      })[0];
      if (waiting) {
        release(waiting);
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
      feed(hostLines, chunk, answer);
    }

    function onClose() {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onClose);
      stdin.removeListener("error", onClose);
      answer(hostLines.text);
      hostLines.text = "";
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
  describeDiff: describeDiff,
  diffCatalog: diffCatalog,
  serve: serve
};
