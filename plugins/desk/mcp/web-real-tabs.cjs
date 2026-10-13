// Closes an agent's real-browser tabs when its session ends, however it ends. Stock Playwright MCP drives the operator's browser through the stock Playwright Extension (web.cjs), and the extension gives each connection its own tab group, but when a connection closes it only ungroups the tabs and leaves them open. This file adds the missing cleanup and nothing else.
//
// - Run as `node web-real-tabs.cjs <playwright-mcp cli.js> [options]`, it starts stock Playwright MCP in this process after one change: when Playwright opens the extension's connect page, a detached watchdog (this file again, with --watch) starts instead of the browser. It also replaces the extension token in Playwright MCP's output, because the connect page carries the token in its address and Playwright MCP reports page addresses to the host.
// - The watchdog points the connect page at its own loopback relay, starts the browser with that page, and passes every message between the extension and Playwright unchanged. It records the tabs Playwright attaches to and forgets the ones that close or leave the group.
// - When Playwright's side closes (browser_close, the server exiting, or the server being killed, even with SIGKILL), the watchdog closes the tabs it recorded and then disconnects. Because it runs detached, killing the server or its whole process group does not stop it.
// - Working beats protected: if the watchdog cannot set up its relay, it opens the original connect page, so the browser still works without the cleanup.

"use strict";

var childProcess = require("child_process");
var path = require("path");

var CONNECT_PAGE = "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html";
// How long the watchdog waits for the extension to connect, and for the extension to confirm the tabs are closed.
var CONNECT_MS = 120000;
var CLOSE_MS = 5000;
// How recently a detached tab still counts as the session's: the extension detaches a tab for a moment while it re-attaches it after some navigations.
var DETACH_GRACE_MS = 5000;

function either(value, fallback) {
  return value === undefined ? fallback : value;
}

// Replace the token in everything a stream is given.
function redact(stream, token) {
  var write = stream.write;
  stream.write = function (chunk) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) args[0] = String(chunk).split(token).join("<token>");
    return write.apply(stream, args);
  };
}

// Start Playwright MCP with the connect-page launch routed through the watchdog. `o` replaces the real process, child_process and require, for tests.
function run(argv, o) {
  var proc = either(o.process, process);
  var cp = either(o.childProcess, childProcess);
  var cli = path.resolve(argv[0]);
  var token = proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  if (token) {
    redact(proc.stdout, token);
    redact(proc.stderr, token);
  }
  var spawn = cp.spawn;
  cp.spawn = function (file, args, options) {
    var last = args[args.length - 1];
    if (typeof last !== "string" || last.indexOf(CONNECT_PAGE) !== 0) return spawn.apply(cp, arguments);
    return spawn.call(cp, proc.execPath, [__filename, "--watch", cli, file].concat(args), options);
  };
  proc.argv = [proc.argv[0], cli].concat(argv.slice(1));
  either(o.load, require)(cli);
}

// The tabs one Playwright connection owns, from the messages passing through the relay. Requests come from Playwright, replies and events from the extension.
function tabLedger(clock) {
  var owned = {};
  var detached = {};
  var pending = {};
  return {
    request: function (message) {
      if (message.method === "chrome.debugger.attach") pending[message.id] = message.params[0].tabId;
    },
    reply: function (message) {
      var tabId;
      if (Object.prototype.hasOwnProperty.call(pending, message.id)) {
        tabId = pending[message.id];
        delete pending[message.id];
        if (message.error) return;
        owned[tabId] = true;
        delete detached[tabId];
      } else if (message.method === "chrome.tabs.onRemoved") {
        delete owned[message.params[0]];
        delete detached[message.params[0]];
      } else if (message.method === "chrome.debugger.onDetach" && owned[message.params[0].tabId]) {
        tabId = message.params[0].tabId;
        delete owned[tabId];
        detached[tabId] = clock();
      }
    },
    // Every attached tab, and any that detached only a moment ago.
    tabs: function () {
      var now = clock();
      return Object.keys(owned).concat(Object.keys(detached).filter(function (id) {
        return now - detached[id] < DETACH_GRACE_MS;
      })).map(Number);
    }
  };
}

function launchBrowser(file, args) {
  var browser = childProcess.spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  browser.on("error", function () {});
  browser.unref();
}

// The ws package installed beside Playwright MCP, or null.
function loadWebSocket(cli) {
  try {
    return require(require.resolve("ws", { paths: [path.dirname(cli)] }));
  } catch (error) {
    return null;
  }
}

// The detached watchdog: relay between the extension and Playwright, then close the connection's tabs when Playwright goes. `o` replaces the browser launch, the exit, the clock, the ws package and the time limits, for tests.
function watch(cli, file, browserArgs, o) {
  var launch = either(o.launch, launchBrowser);
  var exit = either(o.exit, process.exit);
  var closeMs = either(o.closeMs, CLOSE_MS);
  var args = browserArgs.slice();
  var page = new URL(args[args.length - 1]);
  var upstreamUrl = page.searchParams.get("mcpRelayUrl");
  var WebSocket = either(o.WebSocket, loadWebSocket(cli));
  if (WebSocket === null) return launch(file, args);
  var ledger = tabLedger(either(o.clock, Date.now));
  var server = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  var giveUp = setTimeout(function () {
    server.close();
    exit(0);
  }, either(o.connectMs, CONNECT_MS));
  server.on("error", function () {
    clearTimeout(giveUp);
    launch(file, browserArgs);
    exit(0);
  });
  server.on("listening", function () {
    page.searchParams.set("mcpRelayUrl", "ws://127.0.0.1:" + server.address().port + "/extension");
    args[args.length - 1] = page.toString();
    launch(file, args);
  });
  server.once("connection", function (extension) {
    clearTimeout(giveUp);
    server.close();
    var upstream = new WebSocket(upstreamUrl);
    var queued = [];
    var finishing = false;
    var answered = function () {};
    extension.on("message", function (data) {
      var text = String(data);
      try {
        var message = JSON.parse(text);
        ledger.reply(message);
        answered(message);
      } catch (error) {
        // Passed on as it is.
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push(text);
    });
    upstream.on("open", function () {
      queued.forEach(function (text) {
        upstream.send(text);
      });
      queued = [];
    });
    upstream.on("message", function (data) {
      var text = String(data);
      try {
        ledger.request(JSON.parse(text));
      } catch (error) {
        // Passed on as it is.
      }
      extension.send(text);
    });
    // Playwright is gone: close what it opened, then let the extension go.
    function finish() {
      if (finishing) return;
      finishing = true;
      var tabs = ledger.tabs();
      var left = tabs.length;
      var timer = setTimeout(done, closeMs);
      function done() {
        clearTimeout(timer);
        extension.close(1000, "Playwright client disconnected");
        setTimeout(function () {
          exit(0);
        }, 200);
      }
      if (left === 0 || extension.readyState !== WebSocket.OPEN) return done();
      answered = function (message) {
        if (String(message.id).indexOf("desk-close-") === 0 && --left === 0) done();
      };
      tabs.forEach(function (tabId) {
        extension.send(JSON.stringify({ id: "desk-close-" + tabId, method: "chrome.tabs.remove", params: [tabId] }));
      });
    }
    upstream.on("close", finish);
    upstream.on("error", finish);
    extension.on("close", function () {
      upstream.close();
      if (!finishing) exit(0);
    });
  });
}

module.exports = { run: run, watch: watch };

/* istanbul ignore next */
if (require.main === module) {
  if (process.argv[2] === "--watch") watch(process.argv[3], process.argv[4], process.argv.slice(5), {});
  else run(process.argv.slice(2), {});
}
