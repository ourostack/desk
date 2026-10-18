import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { mkTempRoot } from "../_temp_roots.js";
import { mcpRoot } from "./_mcp_handshake.js";

const require = createRequire(import.meta.url);
const { read, cliDirectory } = require("./fixtures/playwright-native-error-transport.cjs");
const A = "11111111-1111-4111-8111-111111111111";
const resources = { contextId: A, disposition: "unknown", closedTabIds: [7],
  remainingTabIds: [8], unknownRevokedTabs: [{ tabId: 9, windowId: 2 }] };

test.beforeEach(t => {
  if (process.platform !== "win32") return;
  const cp = require("node:child_process"), original = cp.execFileSync, calls = [];
  t.mock.method(cp, "execFileSync", function (executable, ...args) {
    if (path.basename(executable).toLowerCase() !== "powershell.exe") return original.call(this, executable, ...args);
    const started = performance.now(), row = {};
    try { return original.call(this, executable, ...args); }
    catch (error) { row.error = { code: error.code, status: error.status, signal: error.signal }; throw error; }
    finally { row.ms = Math.round(performance.now() - started); calls.push(row); }
  });
  t.after(() => t.diagnostic("actual Windows ACL provider timing " + JSON.stringify({
    calls: calls.length, totalMs: calls.reduce((total, row) => total + row.ms, 0),
    maxMs: Math.max(0, ...calls.map(row => row.ms)), failures: calls.filter(row => row.error),
  })));
});

test("E4 exposes the real codec and credential binding and selects revision four", () => {
  const codec = require(path.join(mcpRoot, "web-native-error-transport.cjs"));
  assert.deepEqual(Object.keys(codec).sort(), ["decodeError", "forDaemon", "forLaunch", "markResult", "project", "sessionStamp", "takeResult", "writeLaunch"].sort());
  assert.equal(typeof require(path.join(mcpRoot, "web-extension-credential.cjs")).nativeErrorTransportBinding, "function");
  assert.equal(require(path.join(mcpRoot, "web-playwright-patch.cjs")).REVISION, 4);
});

function originalCError(resourceInput = resources) {
  const module = { exports: {} };
  const http = { request(_options, callback) {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter(); response.statusCode = 409;
      response.destroy = () => {};
      callback(response);
      response.emit("data", Buffer.from(JSON.stringify({ ok: false, error: { code: "native_discard_incomplete", resources: resourceInput } })));
      response.emit("end");
    };
    return request;
  } };
  vm.runInNewContext(fs.readFileSync(path.join(mcpRoot, "web-native-messaging.cjs"), "utf8"), {
    module, __dirname: mcpRoot, process: { ...process, stdout: { write() {} }, stderr: { write() {} } },
    Buffer, URL, setTimeout, clearTimeout,
    require: name => name === "http" ? http : require(name.startsWith(".") ? path.join(mcpRoot, name) : name),
  });
  return module.exports.providerRequest("http://127.0.0.1:38123/provider/" + "a".repeat(64), "dispatch", {}).then(
    () => assert.fail("actual C error arm must reject"), error => error);
}

test("unpatched actual backend demonstrably loses the original C resources before daemon formatting", async () => {
  const input = read(), error = await originalCError();
  assert.equal(error.code, "native_discard_incomplete");
  assert.deepEqual(JSON.parse(JSON.stringify(error.resources)), resources);
  class Response {
    addError() {}
    async serialize() { return { content: [{ type: "text", text: "ordinary page result" }] }; }
  }
  const Backend = vm.runInNewContext(
    "var import_events29,z5,debug10,backendDebug,BrowserBackend;\n" + input.backend +
    "\ninit_browserBackend(); BrowserBackend", {
      require: name => name === "events" ? { EventEmitter } : { z: {}, debug: () => () => {} },
      __esm: object => () => Object.values(object)[0](),
      init_context() {}, init_response() {}, init_sessionLog() {},
      Response4: Response, formatRejectionReason: String, Buffer,
    });
  const browserContext = new EventEmitter(); browserContext.browser = () => null;
  const backend = new Backend({ deskNativeContext: { contextId: A } }, browserContext,
    [{ schema: { name: "owned", inputSchema: { parse: value => value } }, handle: async () => { throw error; } }]);
  backend._context = { setRunningTool() {}, drainPendingUnhandledRejections: () => [] };
  const result = await backend.callTool("owned", {});
  assert.equal(result.isError, true);
  assert.equal(Object.getOwnPropertySymbols(result).length, 0);
  assert.equal(result.resources, undefined);
});

    test("unpatched actual daemon catch demonstrably flattens the original C resources", async () => {
      const error = await originalCError(), input = read(), sent = [];
      let accept, connection;
      const browserContext = new EventEmitter(); browserContext.isClosed = () => false;
      class Backend { async initialize() {} async callTool() { throw error; } }
      class Connection { constructor() { connection = this; } async send(value) { sent.push(value); } }
      const server = new EventEmitter(); server.listen = (_path, callback) => callback();
      const start = vm.runInNewContext(input.daemon + "\nstartCliDaemonServer", {
        process: { platform: process.platform, env: {} }, AbortController,
        createSessionConfig: () => ({ socketPath: "/virtual/native.sock" }), socketExists: async () => false,
        BrowserBackend: Backend, browserTools: [],
        import_net10: { default: { createServer(callback) { accept = callback; return server; } } },
        SocketConnection: Connection, decorateServer() {}, saveSessionFile: async () => {},
        monitorSocketPath: async () => {}, parseCliCommand: () => ({ toolName: "owned", toolParams: {} }),
      });
      await start(A, browserContext, {}, { deskNativeContext: { contextId: A } }, {}, {}, {});
      accept({});
      await connection.onmessage({ id: 37, method: "run", params: { args: {} } });
      assert.equal(sent.length, 1);
      assert.equal(typeof sent[0].error, "string");
      assert.equal(sent[0].error, "native_discard_incomplete");
    });

    test("unpatched actual external Session demonstrably loses startup C code and resources", async () => {
      const error = await originalCError(), input = read(), signals = new EventEmitter(), descriptors = new Set();
      const child = new EventEmitter(); child.pid = 123; child.stdout = new EventEmitter();
      child.stdout.destroy = () => {}; child.unref = () => {};
      const Session = vm.runInNewContext("class Session {\n" + input.session + "\n}; Session", {
        process: Object.assign(signals, { execPath: process.execPath, cwd: () => "/virtual" }),
        import_fs: { default: { promises: { mkdir: async () => {} },
          openSync() { descriptors.add(91); return 91; }, readFileSync: () => "private diagnostics" } },
        import_path: { default: path }, import_package: { libPath: () => "/virtual/cliDaemon.js" },
        import_registry: { resolveSessionName: value => value },
        import_child_process: { spawn() {
          queueMicrotask(() => { child.stdout.emit("data", Buffer.from(String(error))); child.emit("close", 1); });
          return child;
        } },
      });
      let observed;
      try { await Session.startDaemon({ daemonProfilesDir: "/virtual/daemon" }, { session: A, config: "/virtual/config.json" }); }
      catch (value) { observed = value; }
      finally {
        // This unpatched negative owns only virtual descriptors/emitters. Explicitly
        // retire them even though the original start method has no failure finally.
        descriptors.clear(); signals.removeAllListeners(); child.stdout.removeAllListeners(); child.removeAllListeners();
      }
      assert.equal(observed?.code, undefined);
      assert.equal(observed?.resources, undefined);
      assert.equal(descriptors.size, 0);
    });

async function stagedTransport(t, options = {}) {
  const root = await mkTempRoot("native-error-transport-"), home = path.join(root, "native-home");
  const homeInfo = os.userInfo();
  t.mock.method(os, "userInfo", () => ({ ...homeInfo, homedir: home }));
  const input = read(), generation = path.join(root, "generation");
  const lib = path.join(generation, "node_modules/playwright-core/lib");
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  };
  const stock = fs.readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs", import.meta.url), "utf8") + input.core;
  put(path.join(lib, "coreBundle.js"), stock);
  put(path.join(lib, "tools/cli-client/session.js"), input.sessionSource);
  const patch = require(path.join(mcpRoot, "web-playwright-patch.cjs"));
  patch.apply({ dir: generation, version: "owned-E4", core: null });
  assert.equal(patch.readRevision({ dir: generation, version: "owned-E4", core: null }), 4);
  const app = process.platform === "darwin" ? path.join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge") :
    path.join(root, "owned-browser");
  put(app, "Owned filesystem observation fixture, never executed.");
  const owner = path.join(root, "owner"), configFile = path.join(owner, "config/browser.json");
  const record = { version: 1, contextId: A, label: "private profile label", channel: "msedge",
    userDataDir: path.join(root, "profile"), profileDirName: "Default",
    nativeReadyFile: path.join(root, "state/ready.json"), extensionId: "a".repeat(32), sourceDigest: "b".repeat(64) };
  const config = { extension: true, browser: { browserName: "chromium", userDataDir: record.userDataDir,
    launchOptions: { channel: "msedge" } }, deskNativeContext: record };
  put(configFile, config);
  if (process.platform === "win32") {
    const helper = require(path.join(mcpRoot, "web-extension-credential.cjs"));
    helper.privateGeneration(owner);
    helper.privateGeneration(path.dirname(configFile), configFile);
  }
  const resolved = { ...config, configFile };
  const output = [], proc = { ...process, stdout: options.sink || { write(bytes, callback) {
    output.push(Buffer.from(bytes)); callback?.(); return true;
  } } };
  proc.stderr = proc.stdout;
  const observedFs = Object.create(fs);
  const candidates = require(path.join(mcpRoot, "web-browser-discovery.cjs")).browserPaths("msedge", process.platform, process.env);
  observedFs.existsSync = file => process.platform !== "darwin" && candidates.includes(String(file)) ? true :
    path.resolve(String(file)).startsWith(root + path.sep) && fs.existsSync(file);
  observedFs.realpathSync = file => process.platform !== "darwin" && candidates.includes(String(file)) ? app : fs.realpathSync(file);
  const cache = new Map(), { loadTemplate } = require("./fixtures/native-template-loader.cjs");
  function template(name) {
    if (cache.has(name)) return cache.get(name);
    const file = path.join(lib, name), module = { exports: {} };
    const value = loadTemplate(file, { module, __dirname: lib, process: proc, Buffer,
      setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
      require: name => name === "fs" ? observedFs : name === "perf_hooks" && options.now ?
        { performance: { now: options.now } } :
        name === path.join(lib, "desk-extension-credential.cjs") || name.startsWith("./desk-") ? template(path.basename(name)) : require(name) });
    cache.set(name, value); return value;
  }
  const codec = template("desk-native-error-transport.cjs");
  const scope = codec.forDaemon(resolved, A), stamp = codec.sessionStamp(scope);
  assert.equal(stamp.contextId, A);
  assert.equal(stamp.sourceGeneration, require("node:crypto").createHash("sha256")
    .update(fs.readFileSync(path.join(generation, "playwright-patch.json"))).digest("hex"),
    "correlation uses the exact final verified receipt bytes, including its newline");
  return { root, lib, input, stock, configFile, config, resolved, codec, scope, proc, output, stamp, template, put, observedFs,
    clientInfo: { daemonProfilesDir: path.join(owner, "cache/ms-playwright/daemon/owned"), version: "owned-E4", workspaceDirHash: "owned" } };
}

test("genuine revision-four private binding projects and decodes the original C error without flattening resources", async t => {
  const f = await stagedTransport(t), error = await originalCError();
  const envelope = f.codec.project(error, f.scope, { stage: "command", requestId: 37 });
  const decoded = f.codec.decodeError(JSON.parse(JSON.stringify(envelope)), { ...f.stamp, stage: "command", requestId: 37 });
  assert.equal(decoded.code, "native_discard_incomplete");
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.resources)), resources);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.nativeTransport)), {
    version: 1, contextId: A, sourceGeneration: f.stamp.sourceGeneration, stage: "command", requestId: 37 });
});

test("actual transformed backend retains primary C errors before text conversion and runs both cleanup steps", async t => {
  const f = await stagedTransport(t), error = await originalCError(), cleanup = [];
  const core = fs.readFileSync(path.join(f.lib, "coreBundle.js"), "utf8");
  const begin = core.indexOf("var init_browserBackend = __esm({");
  const backendSource = core.slice(begin, core.indexOf("\n// packages/playwright-core/src/tools/backend/common.ts", begin));
  class Response { addError() {} async serialize() { return { content: [{ type: "text", text: "https://ordinary.page/success" }] }; } }
  const Backend = vm.runInNewContext("var import_events29,z5,debug10,backendDebug,BrowserBackend;\n" +
    backendSource + "\ninit_browserBackend(); BrowserBackend", {
      require: name => name === "./desk-native-error-transport.cjs" ? f.codec :
        name === "events" ? { EventEmitter } : { z: {}, debug: () => () => {} },
      __esm: object => () => Object.values(object)[0](), init_context() {}, init_response() {}, init_sessionLog() {},
      Response4: Response, formatRejectionReason: String, Buffer,
    });
  const browserContext = new EventEmitter(); browserContext.browser = () => null;
  const backend = new Backend(f.resolved, browserContext,
    [{ schema: { name: "owned", inputSchema: { parse: value => value } }, handle: async () => { throw error; } }],
    { dispose: async () => { cleanup.push("callback"); throw error; } });
  backend._context = { setRunningTool(value) { cleanup.push(value || "cleared"); },
    drainPendingUnhandledRejections: () => [], dispose: async () => { cleanup.push("context"); throw error; } };
  backend._disconnected = true;
  const result = await backend.callTool("owned", {});
  const primary = f.codec.takeResult(result, f.scope);
  assert.ok(primary);
  const envelope = f.codec.project(primary, f.scope, { stage: "command", requestId: 37 });
  assert.equal(envelope.code, "native_discard_incomplete");
  assert.deepEqual(JSON.parse(JSON.stringify(envelope.resources)), resources);
  assert.deepEqual(cleanup, ["owned", "cleared", "context", "callback"]);
  assert.equal(envelope.relatedErrors.length, 2);
  assert.equal(JSON.stringify(result).includes("relatedErrors"), false, "the marker never becomes a public result field");
});

    function transformedBackend(f, failure, options = {}) {
      const core = fs.readFileSync(path.join(f.lib, "coreBundle.js"), "utf8");
      const begin = core.indexOf("var init_browserBackend = __esm({");
      const source = core.slice(begin, core.indexOf("\n// packages/playwright-core/src/tools/backend/common.ts", begin));
      class Context {
        constructor() { this.pending = [...(options.pendingErrors || [])]; }
        setRunningTool() {}
        drainPendingUnhandledRejections() { return this.pending.splice(0); }
        async dispose() {}
      }
      class Response {
        addError() {}
        async serialize() { return { content: [{ type: "text", text: "https://ordinary.page/success" }] }; }
      }
      const Backend = vm.runInNewContext("var import_events29,z5,debug10,backendDebug,BrowserBackend;\n" +
        source + "\ninit_browserBackend(); BrowserBackend", {
          require: name => name === "./desk-native-error-transport.cjs" ? f.codec :
            name === "events" ? { EventEmitter } : { z: {}, debug: () => () => {} },
          __esm: object => () => Object.values(object)[0](), init_context() {}, init_response() {}, init_sessionLog() {},
          Context, Response4: Response, formatRejectionReason: String, Buffer,
        });
      return { Backend, tools: [{ schema: { name: "owned", inputSchema: { parse: value => value } },
        handle: async () => { if (failure) throw failure; } }] };
    }

    function transformedDaemon(f, options = {}) {
      const { Backend, tools } = transformedBackend(f, options.toolError, options);
      const source = fs.readFileSync(path.join(f.lib, "coreBundle.js"), "utf8");
      const daemonStart = source.indexOf("async function startCliDaemonServer(");
      const daemon = source.slice(daemonStart, source.indexOf("\nasync function saveSessionFile(", daemonStart));
      const metadataStart = source.indexOf("function createSessionConfig(");
      const metadata = source.slice(metadataStart, source.indexOf("\nvar import_fs67, import_net10, import_path63;", metadataStart));
      const { SocketConnection } = require(path.resolve(cliDirectory(), "../utils/socketConnection.js"));
      const server = new EventEmitter(), sockets = [], wire = [];
      let accept, published;
      server.listen = (_path, callback) => options.listenError ? server.emit("error", options.listenError) : callback();
      const browserContext = new EventEmitter(); browserContext.browser = () => null; browserContext.isClosed = () => false;
      const start = vm.runInNewContext(daemon + "\n" + metadata + "\nstartCliDaemonServer", {
        require: name => { assert.equal(name, "./desk-native-error-transport.cjs"); return f.codec; },
        process: f.proc, AbortController, Date,
        BrowserBackend: class extends Backend {
          constructor(config, ...args) {
            super(options.independentBackendConfig ? JSON.parse(JSON.stringify(config)) : config, ...args);
          }
          async initialize(info) {
          if (options.initializeError) throw options.initializeError;
          return super.initialize(info);
        } },
        browserTools: tools, socketExists: async () => false,
        daemonSocketPath: () => path.join(f.clientInfo.daemonProfilesDir, "native.sock"),
        import_net10: { default: { createServer(callback) { accept = callback; return server; } } },
        SocketConnection, decorateServer() {},
        saveSessionFile: async (_client, value) => {
          if (options.publishError) throw options.publishError;
          f.put(path.join(f.clientInfo.daemonProfilesDir, A + ".session"), value);
          published = value;
        },
        monitorSocketPath: async () => {}, parseCliCommand: () => ({ toolName: "owned", toolParams: {} }),
        formatResult: value => ({ isError: value.isError, text: value.content[0].type === "text" ? value.content[0].text : undefined }),
        deleteSessionFile: async () => { if (options.stopError) throw options.stopError; },
      });
      return { browserContext, start, get published() { return published; },
        async request(message) {
          let done;
          const completion = new Promise(resolve => { done = resolve; });
          const socket = new EventEmitter(); sockets.push(socket);
          socket.write = (bytes, callback) => { wire.push(Buffer.from(bytes)); callback(); done(); return true; };
          accept(socket);
          socket.emit("data", Buffer.from(JSON.stringify(message) + "\n"));
          await completion;
          return JSON.parse(wire.at(-1).toString());
        },
        close() {
          for (const socket of sockets) socket.removeAllListeners();
          server.removeAllListeners(); browserContext.removeAllListeners();
        }
      };
    }

    test("actual transformed backend-to-daemon-to-maintained-SocketConnection retains the original C error", async t => {
      const f = await stagedTransport(t), original = await originalCError();
      const daemon = transformedDaemon(f, { toolError: original });
      t.after(() => daemon.close());
      await daemon.start(A, daemon.browserContext, { browserName: "chromium" }, f.resolved, f.clientInfo, {}, {});
      assert.deepEqual(JSON.parse(JSON.stringify(daemon.published.deskNativeErrorTransport)), JSON.parse(JSON.stringify(f.stamp)));
      const reply = await daemon.request({ id: 37, method: "run", params: { args: {} } });
      assert.equal(reply.id, 37); assert.equal("result" in reply, false);
      const error = f.codec.decodeError(reply.error, { ...f.stamp, stage: "command", requestId: 37 });
      assert.equal(error.code, "native_discard_incomplete");
      assert.deepEqual(JSON.parse(JSON.stringify(error.resources)), resources);
    });

    test("actual transformed daemon catch outside backend preserves C stop failure and cannot send an ACK", async t => {
      const f = await stagedTransport(t), original = await originalCError();
      const daemon = transformedDaemon(f, { stopError: original });
      t.after(() => daemon.close());
      await daemon.start(A, daemon.browserContext, { browserName: "chromium" }, f.resolved, f.clientInfo, {}, {});
      const reply = await daemon.request({ id: 38, method: "stop", params: {} });
      assert.equal("result" in reply, false);
      const error = f.codec.decodeError(reply.error, { ...f.stamp, stage: "stop", requestId: 38 });
      assert.equal(error.code, "native_discard_incomplete");
      assert.deepEqual(JSON.parse(JSON.stringify(error.resources)), resources);
    });

    function transformedProgram(f, daemon, failure, phase) {
      const core = fs.readFileSync(path.join(f.lib, "coreBundle.js"), "utf8");
      const begin = core.indexOf("function decorateProgram3(program4) {");
      const source = core.slice(begin, core.indexOf("\nfunction defaultConfigFile(", begin));
      let action, exit;
      const program = { argument() { return this; }, option() { return this; }, action(callback) { action = callback; return this; } };
      const decorate = vm.runInNewContext(source + "\ndecorateProgram3", {
        require: name => name === "./desk-native-error-transport.cjs" ? f.codec : require(name),
        process: f.proc, numberParser: Number, setupExitWatchdog() {}, createClientInfo: () => f.clientInfo,
        deskNativeConfigPresent: maintainedConfigInterface(f).tools.deskNativeConfigPresent,
        resolveCLIConfigForCLI: async () => { if (phase === "config") throw failure; return f.resolved; },
        guessClientName: () => "owned E4 fixture",
        createBrowserWithInfo: async () => {
          if (phase === "acquire") throw failure;
          return { browser: { contexts: () => [daemon.browserContext] }, browserInfo: { browserName: "chromium" } };
        },
        startCliDaemonServer: daemon.start,
        gracefullyProcessExitDoNotHang: code => { exit = code; },
      });
      decorate(program);
      return { action, get exit() { return exit; } };
    }

    for (const phase of ["config", "acquire", "backend", "listen", "publish", "ready"]) {
      test(`actual transformed startup and external Session carry ${phase} through the typed stdout pipe`, async t => {
        const f = await stagedTransport(t), original = await originalCError();
        const daemon = transformedDaemon(f, { initializeError: phase === "backend" ? original : undefined,
          listenError: phase === "listen" ? original : undefined, publishError: phase === "publish" ? original : undefined });
        t.after(() => daemon.close());
        const child = new EventEmitter(), signals = new EventEmitter();
        child.stdout = new EventEmitter(); child.pid = 124;
        let destroyed = 0, unref = 0, actionPromise;
        child.stdout.destroy = () => { destroyed++; }; child.unref = () => { unref++; };
        f.proc.stdout.write = (bytes, callback) => {
          f.output.push(Buffer.from(bytes));
          queueMicrotask(() => child.stdout.emit("data", Buffer.from(bytes)));
          callback?.(); return true;
        };
        const program = transformedProgram(f, daemon, original, phase);
        const sessionPath = path.join(f.lib, "tools/cli-client/session.js");
        assert.equal(fs.existsSync(sessionPath), true, "this is the exact external path consumed by F");
        const sessionSource = fs.readFileSync(sessionPath, "utf8");
        const begin = sessionSource.indexOf("  static async startDaemon(");
        const region = sessionSource.slice(begin, sessionSource.indexOf("\n  async _stopDaemon()", begin));
        const Session = vm.runInNewContext("class Session {\n" + region + "\n}; Session", {
          process: Object.assign(signals, { execPath: process.execPath, cwd: () => f.root }),
          require: name => {
            if (name === "../../coreBundle.js") return maintainedConfigInterface(f);
            assert.equal(name, "../../desk-native-error-transport.cjs"); return f.codec;
          },
          import_fs: { default: fs }, import_path: { default: path },
          import_package: { libPath: () => path.join(f.lib, "entry/cliDaemon.js") },
          import_registry: { resolveSessionName: value => value },
          import_child_process: { spawn() {
            queueMicrotask(() => { actionPromise = program.action(A, { config: f.configFile, browser: "msedge" }); });
            return child;
          } },
        });
        if (phase === "ready") {
          const result = await Session.startDaemon(f.clientInfo, { session: A, config: f.configFile, browser: "msedge" });
          assert.equal(result.pid, 124); assert.ok(daemon.published);
        } else {
          await assert.rejects(Session.startDaemon(f.clientInfo, { session: A, config: f.configFile, browser: "msedge" }), error => {
            assert.equal(error.code, "native_discard_incomplete");
            assert.deepEqual(JSON.parse(JSON.stringify(error.resources)), resources);
            const expected = phase === "config" ? "launch.config" : phase === "acquire" ? "launch.acquire" :
              phase === "backend" ? "launch.backend" : "launch.publish";
            assert.equal(error.nativeTransport.stage, expected);
            return true;
          });
        }
        await actionPromise;
        assert.equal(program.exit, phase === "ready" ? undefined : 1);
        assert.equal(destroyed, 1); assert.equal(unref, 1);
        assert.equal(signals.eventNames().length, 0);
        assert.equal(child.eventNames().length, 0);
        assert.equal(child.stdout.eventNames().length, 0);
        const log = path.join(f.clientInfo.daemonProfilesDir, A + ".err");
        if (process.platform === "win32") require(path.join(mcpRoot, "web-native-messaging.cjs")).privatePath(log, false, true);
        else assert.equal(fs.statSync(log).mode & 0o077, 0);
        assert.equal(fs.statSync(log).nlink, 1);
        // Every operation above has settled before fixture teardown.
      });
    }

test("typed obligation IDs cannot smuggle malformed nonnumeric values as redaction markers", async t => {
  const f = await stagedTransport(t);
  const envelope = f.codec.project({ code: "native_discard_incomplete",
    resources: { closedTabIds: ["<redacted>"], disposition: "unknown" } }, f.scope, { stage: "command", requestId: 1 });
  assert.equal(envelope.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
  assert.equal(envelope.resources.disposition, "unknown");
});

test("a malformed reserved startup token preceding ready is not an ignorable diagnostic", async t => {
  const f = await stagedTransport(t);
  const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  try {
    reader.push(Buffer.from("DESK_NATIVE_CLI_V1BROKEN\nDESK_NATIVE_CLI_V1 " +
      JSON.stringify({ ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null }) + "\n"));
    await assert.rejects(reader.wait(), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  } finally { reader.dispose(); }
});

test("decoder requires the outstanding request ID rather than accepting any positive reply ID", async t => {
  const f = await stagedTransport(t), envelope = f.codec.project(await originalCError(), f.scope, { stage: "command", requestId: 37 });
  assert.throws(() => f.codec.decodeError(envelope, { ...f.stamp, stage: "command" }),
    { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
});

test("a resolved malformed-present native record is refused before becoming a command scope", async t => {
  const f = await stagedTransport(t);
  assert.throws(() => f.codec.forDaemon({ ...f.resolved, deskNativeContext: null }, A), { code: "NATIVE_CONFIG_INVALID" });
});

test("returned source-owned projection snapshots cannot be mutated to bypass privacy", async t => {
  const f = await stagedTransport(t), result = {};
  f.codec.markResult(result, await originalCError(), f.scope);
  const snapshot = f.codec.takeResult(result, f.scope);
  assert.throws(() => { snapshot.resources.remainingTabIds.push(99); }, { name: "TypeError" });
  assert.throws(() => { snapshot.code = "raw-private-string"; }, { name: "TypeError" });
});

test("maximum admitted C resource depth survives the additional envelope and marker nesting", async t => {
  const f = await stagedTransport(t);
  let value = { remainingTabIds: [7] };
  for (let i = 0; i < 14; i++) value = { native: value };
  const envelope = f.codec.project({ code: "native_discard_incomplete", resources: value }, f.scope, { stage: "command", requestId: 37 });
  const decoded = f.codec.decodeError(envelope, { ...f.stamp, stage: "command", requestId: 37 });
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.resources)), value);
});

test("partial revision-four regions never normalize as a complete known generation", async t => {
  const f = await stagedTransport(t), patch = require(path.join(mcpRoot, "web-playwright-patch.cjs"));
  const source = fs.readFileSync(path.join(f.lib, "coreBundle.js"), "utf8");
  const begin = source.indexOf("function createSessionConfig(");
  const end = source.indexOf("\nvar import_fs67, import_net10, import_path63;", begin);
  const mixed = source.slice(0, begin) + f.input.metadata + source.slice(end);
  assert.throws(() => patch.patchSource(mixed), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" });
});

test("a revision-four Core paired with original external Session refuses before any candidate write", async t => {
  const f = await stagedTransport(t), patch = require(path.join(mcpRoot, "web-playwright-patch.cjs"));
  const coreFile = path.join(f.lib, "coreBundle.js"), sessionFile = path.join(f.lib, "tools/cli-client/session.js");
  const core = fs.readFileSync(coreFile), receipt = fs.readFileSync(path.join(f.root, "generation/playwright-patch.json"));
  fs.writeFileSync(sessionFile, f.input.sessionSource);
  assert.throws(() => patch.apply({ dir: path.join(f.root, "generation"), version: "owned-E4", core: null }),
    { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" });
  assert.deepEqual(fs.readFileSync(coreFile), core);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "generation/playwright-patch.json")), receipt);
});

test("missing source receipt refuses before spawn without exposing a native filesystem exception", async t => {
  const f = await stagedTransport(t), receipt = path.join(f.root, "generation/playwright-patch.json");
  fs.renameSync(receipt, receipt + ".owned-held");
  try {
    assert.throws(() => f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo), error => {
      assert.equal(error.code, "NATIVE_CODE_UNAVAILABLE");
      assert.equal(error.message, "NATIVE_CODE_UNAVAILABLE");
      assert.equal(error.sourceGeneration, undefined);
      return true;
    });
  } finally { fs.renameSync(receipt + ".owned-held", receipt); }
});

test("actual external Session never exposes JSON parser excerpts from a malformed explicit config", async t => {
  const f = await stagedTransport(t), secret = "owned-private-config-secret";
  fs.writeFileSync(f.configFile, '{"deskNativeContext":"' + secret);
  const source = fs.readFileSync(path.join(f.lib, "tools/cli-client/session.js"), "utf8");
  const begin = source.indexOf("  static async startDaemon(");
  const method = source.slice(begin, source.indexOf("\n  async _stopDaemon()", begin));
  let spawns = 0;
  const Session = vm.runInNewContext("class Session {\n" + method + "\n}; Session", {
    require: name => { assert.equal(name, "../../coreBundle.js"); return maintainedConfigInterface(f); },
    import_fs: { default: fs }, import_child_process: { spawn() { spawns++; throw Error("must not spawn"); } },
  });
  await assert.rejects(Session.startDaemon(f.clientInfo, { config: f.configFile, session: A, browser: "msedge" }), error => {
    assert.equal(error.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(spawns, 0);
});

test("a native err pathname replaced immediately after exclusive open cannot modify a peer's permissions", {
  skip: process.platform === "win32" ? "POSIX file-descriptor mode seam; actual Windows ACL is a separate maintained gate" : false,
}, async t => {
  const f = await stagedTransport(t), peer = path.join(f.root, "owned-peer");
  f.put(peer, "peer original bytes"); fs.chmodSync(peer, 0o644);
  const log = path.join(f.clientInfo.daemonProfilesDir, A + ".err");
  const open = f.observedFs.openSync;
  t.mock.method(f.observedFs, "openSync", function (file, ...args) {
    const fd = open.call(this, file, ...args);
    if (file === log) { fs.renameSync(log, log + ".owned-first"); fs.symlinkSync(peer, log); }
    return fd;
  });
  const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  try {
    assert.throws(() => reader.openErrorLog(), { code: "NATIVE_PRIVATE_PATH_INVALID" });
    assert.equal(fs.statSync(peer).mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(peer, "utf8"), "peer original bytes");
  } finally { reader.dispose(); }
});

test("all current C debugger/effect reason literals and safe obligation topology survive deep-equal", async t => {
  const f = await stagedTransport(t);
  const raw = { contextId: A, state: "unavailable", groupId: 3, priorGroupId: -1,
    tabs: [{ tabId: 7, windowId: 2 }], revokedTabIds: [8], revokedTabs: [{ tabId: 8, windowId: 2 }],
    releasedRevokedTabs: [{ tabId: 9, windowId: 2 }], unknownRevokedTabs: [{ tabId: 10, windowId: 2 }],
    pendingEffects: 1, unconfirmedCreates: 2, uncertainTabs: [{ tabId: 11, windowId: 2 }],
    groupingObligations: [{ tabId: 7, windowId: 2, priorGroupId: -1, state: "unknown", reason: "native_group_readback_unconfirmed" }],
    effectObligations: ["native_close_ownership_unconfirmed", "native_close_unconfirmed", "native_command_effect_unconfirmed"]
      .map(reason => ({ tabId: 7, windowId: 2, state: "unknown", reason })),
    admittingTabIds: [12], debuggerObservationActive: true,
    debuggerCustody: ["native_debugger_observation_retired", "native_debugger_generation_unconfirmed",
      "native_debugger_detach_unconfirmed", "native_debugger_attach_unconfirmed"]
      .map(reason => ({ tabId: 7, windowId: 2, generation: 1, state: "unknown", revoked: true, reason })),
    closedTabIds: [13], absentTabIds: [13], remainingTabIds: [7],
    owners: [{ contextId: A, disposition: "unknown", reason: "NATIVE_EFFECT_UNSETTLED", native: { pendingEffects: 1 } }] };
  const safe = require(path.join(mcpRoot, "web-native-messaging.cjs")).safeResources(raw);
  const envelope = f.codec.project({ code: "native_discard_incomplete", resources: safe }, f.scope, { stage: "command", requestId: 37 });
  assert.deepEqual(JSON.parse(JSON.stringify(envelope.resources)), raw);
  const decoded = f.codec.decodeError(envelope, { ...f.stamp, stage: "command", requestId: 37 });
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.resources)), raw);
});

test("valid numeric obligation arrays below the actual frame budget are not silently replaced by a conservative estimate", async t => {
  const f = await stagedTransport(t), ids = Array.from({ length: 131072 }, (_, i) => i);
  const envelope = f.codec.project({ code: "native_discard_incomplete", resources: { remainingTabIds: ids } },
    f.scope, { stage: "command", requestId: 37 });
  assert.equal(envelope.code, "native_discard_incomplete");
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 4194304);
  const decoded = f.codec.decodeError(envelope, { ...f.stamp, stage: "command", requestId: 37 });
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.resources.remainingTabIds)), ids);
});

test("real error projection rejects getters, exotic prototypes, cycles, invalid JSON and silent string truncation", async t => {
  const f = await stagedTransport(t), cycle = {}; cycle.native = cycle;
  let gets = 0;
  const getter = Object.defineProperty({}, "remainingTabIds", { enumerable: true, get() { gets++; return [7]; } });
  const hidden = Object.defineProperty({}, "remainingTabIds", { enumerable: false, value: [7] });
  const symbolic = { [Symbol("private-key")]: 1 };
  const foreign = Object.create({ privatePrototype: true }); foreign.remainingTabIds = [7];
  const unusual = []; Object.setPrototypeOf(unusual, null);
  class ForeignArray extends Array {}
  const sparse = []; sparse[2] = 7;
  const extra = []; extra.private = 7;
  const notIndex = []; Object.defineProperty(notIndex, "4294967295", { enumerable: true, value: 7 });
  let deep = {}; for (let i = 0; i < 18; i++) deep = { native: deep };
  for (const value of [NaN, Infinity, "x".repeat(4097), () => {}, cycle, getter, hidden, symbolic,
    foreign, unusual, new ForeignArray(), sparse, extra, notIndex, deep, { native: undefined }]) {
    const envelope = f.codec.project({ code: "native_discard_incomplete", resources: value }, f.scope, { stage: "command", requestId: 37 });
    assert.equal(envelope.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    assert.equal(envelope.resources.disposition, "unknown");
  }
  assert.equal(gets, 0, "no resource getter was evaluated");
  const badError = Object.defineProperty({}, "code", { get() { gets++; return "private"; } });
  assert.equal(f.codec.project(badError, f.scope, { stage: "command", requestId: 37 }).code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
  for (const value of [undefined, null, "raw private exception", () => {}])
    assert.equal(f.codec.project(value, f.scope, { stage: "command", requestId: 37 }).resources.disposition, "unknown");
  assert.equal(gets, 0);
  for (const value of [false, true, null, Object.assign(Object.create(null), { pendingEffects: 0 })]) {
    const output = f.codec.project({ code: "native_discard_incomplete", resources: value }, f.scope, { stage: "command", requestId: 37 });
    assert.deepEqual(JSON.parse(JSON.stringify(output.resources)), JSON.parse(JSON.stringify(value)));
  }
  assert.equal(f.codec.project({ code: "native_discard_incomplete" }, f.scope, { stage: "command", requestId: 37 }).resources, null);
});

test("privacy keeps unknown obligation topology without exposing arbitrary keys, paths, labels or registered secrets", async t => {
  const f = await stagedTransport(t), secret = "owned-resource-secret";
  f.template("desk-extension-credential.cjs").protect(f.proc, secret);
  const envelope = f.codec.project({ code: "native_discard_incomplete", resources: {
    contextId: A, label: "/Users/private-account/Profile", reason: "human private account",
    [secret]: { remainingTabIds: [7], privateAccount: secret },
    argv: [secret, 3, false], nativeReadyFile: "/private/ready.json",
  } }, f.scope, { stage: "command", requestId: 37 });
  assert.deepEqual(JSON.parse(JSON.stringify(envelope.resources)), {
    contextId: A, label: "<redacted>", reason: "<redacted>", redactedFields: [
      { remainingTabIds: [7], redactedFields: ["<redacted>"] },
      ["<redacted>", 3, false], "<redacted>"
    ]
  });
  assert.equal(JSON.stringify(envelope).includes(secret), false);
  assert.equal(JSON.stringify(envelope).includes("private-account"), false);
});

test("native startup framing rejects crossed, ambiguous, malformed, oversized and incomplete records", async t => {
  const f = await stagedTransport(t);
  const ready = { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null };
  const error = f.codec.project(await originalCError(), f.scope, { stage: "launch.acquire", requestId: null });
  const line = value => Buffer.from("DESK_NATIVE_CLI_V1 " + JSON.stringify(value) + "\n");
  const cases = [
    Buffer.from("DESK_NATIVE_CLI_V1 not-json\n"),
    line({ ...ready, contextId: "22222222-2222-4222-8222-222222222222" }),
    line({ ...ready, sourceGeneration: "c".repeat(64) }),
    line({ ...ready, extra: true }), line({ ...ready, version: 2 }),
    line({ ...ready, stage: "launch.acquire" }), line({ ...ready, requestId: 1 }),
    Buffer.concat([line(ready), line(ready)]), Buffer.concat([line(error), line(ready)]),
    Buffer.concat([line(ready), Buffer.from("partial trailing line")]),
    Buffer.from([0xff, 10]), Buffer.from("z".repeat(1048577) + "\n"),
    Buffer.from("DESK_NATIVE_CLI_V1 " + "x".repeat(4194304) + "\n"),
    Buffer.from("DESK_NATIVE_CLI_V1 " + "x".repeat(4194304)),
    Buffer.alloc(4194304 + 1048576 + 1, 120),
    line(f.codec.project(await originalCError(), f.scope, { stage: "command", requestId: 37 })),
  ];
  for (const bytes of cases) {
    const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
    try {
      const waiting = reader.wait();
      reader.push(bytes);
      await assert.rejects(waiting, { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
      reader.push(Buffer.from("late")); reader.end();
    } finally { reader.dispose(); reader.dispose(); }
  }
  const eof = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  try { eof.end(); await assert.rejects(eof.wait(), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" }); eof.end(); }
  finally { eof.dispose(); }
  const invalid = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  try { invalid.push("not bytes"); await assert.rejects(invalid.wait(), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" }); }
  finally { invalid.dispose(); }
});

test("startup reader preserves split bytes and bounded diagnostics, including a buffer view and pre-wait ready", async t => {
  const f = await stagedTransport(t), ready = { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null };
  const bytes = Buffer.from("owned diagnostic ✓\nDESK_NATIVE_CLI_V1 " + JSON.stringify(ready) + "\n");
  for (const width of [1, 2, 17, bytes.length]) {
    const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
    try {
      for (let i = 0; i < bytes.length; i += width) {
        const chunk = bytes.subarray(i, i + width);
        reader.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
      assert.equal((await reader.wait()).kind, "ready");
      assert.equal(reader.wait(), reader.wait());
      reader.end();
    } finally { reader.dispose(); }
  }
});

test("source-owned absolute 45-second deadline retires only the reader and preserves named unknown context", async t => {
  let clock = 0, counter = 0; const timers = new Map();
  const f = await stagedTransport(t, { now: () => clock,
    setTimeout(callback, delay) { const id = ++counter; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  const waiting = reader.wait();
  assert.equal(timers.size, 1);
  clock = 44999;
  assert.equal([...timers.values()][0].due, 45000);
  clock = 45000;
  for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); }
  await assert.rejects(waiting, error => {
    assert.equal(error.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    assert.equal(error.resources.contextId, A); assert.equal(error.resources.disposition, "unknown"); return true;
  });
  reader.dispose();
  assert.equal(timers.size, 0);
  assert.throws(() => reader.validate(), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  reader.push(Buffer.from("late output cannot revive"));
});

test("strict decoder refuses invalid headers, error/result ambiguity, altered privacy and crossed request evidence", async t => {
  const f = await stagedTransport(t), expected = { ...f.stamp, stage: "command", requestId: 37 };
  const base = f.codec.project(await originalCError(), f.scope, { stage: "command", requestId: 37 });
  const inputs = [null, [], 0, { ...base, extra: 1 }, { ...base, version: 2 }, { ...base, kind: "other" },
    { ...base, contextId: "bad" }, { ...base, contextId: "unbound" }, { ...base, sourceGeneration: "bad" },
    { ...base, stage: "unknown" }, { ...base, stage: "stop" }, { ...base, requestId: 38 },
    { ...base, requestId: 0 }, { ...base, requestId: NaN }, { ...base, code: "unapproved" },
    { ...base, message: "private raw text" }, { ...base, resources: { label: "private raw label" } },
    { ...base, relatedErrors: null }, { ...base, relatedErrors: [] }, { ...base, relatedErrors: [null] },
    { ...base, relatedErrors: [{ code: base.code, message: base.message, resources: null, extra: true }] },
    { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null },
  ];
  for (const value of inputs) assert.throws(() => f.codec.decodeError(value, expected),
    { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  for (const value of [undefined, null, {}, { ...expected, contextId: "bad" }, { ...expected, sourceGeneration: "bad" },
    { ...expected, stage: "bad" }, { ...expected, requestId: 0 }, { ...expected, stage: "launch.config", requestId: 37 }])
    assert.throws(() => f.codec.decodeError(base, value), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  let gets = 0;
  for (const where of ["envelope", "expected"]) {
    const value = Object.defineProperty({}, "contextId", { enumerable: true, get() { gets++; return A; } });
    assert.throws(() => f.codec.decodeError(where === "envelope" ? value : base, where === "expected" ? value : expected),
      { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  }
  assert.equal(gets, 0);
});

test("source-owned related errors remain separate and two genuine private context scopes never cross replies or markers", async t => {
  const f = await stagedTransport(t), B = "22222222-2222-4222-8222-222222222222";
  const configFile = path.join(f.root, "owner-b/config/browser.json");
  const config = { ...f.config, deskNativeContext: { ...f.config.deskNativeContext, contextId: B } };
  f.put(configFile, config);
  if (process.platform === "win32") {
    const helper = require(path.join(mcpRoot, "web-extension-credential.cjs"));
    helper.privateGeneration(path.dirname(path.dirname(configFile))); helper.privateGeneration(path.dirname(configFile), configFile);
  }
  const scopeB = f.codec.forDaemon({ ...config, configFile }, B), stampB = f.codec.sessionStamp(scopeB);
  assert.equal(stampB.sourceGeneration, f.stamp.sourceGeneration);
  const a = f.codec.project(await originalCError(), f.scope, { stage: "command", requestId: 37 });
  const b = f.codec.project(await originalCError({ ...resources, contextId: B }), scopeB, { stage: "command", requestId: 37 });
  for (const [envelope, stamp] of [[a, f.stamp], [b, stampB]]) {
    const error = f.codec.decodeError(envelope, { ...stamp, stage: "command", requestId: 37 });
    assert.equal(error.resources.contextId, stamp.contextId);
  }
  assert.throws(() => f.codec.decodeError(a, { ...stampB, stage: "command", requestId: 37 }), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  assert.throws(() => f.codec.decodeError(b, { ...f.stamp, stage: "command", requestId: 37 }), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  const result = {};
  f.codec.markResult(result, await originalCError(), f.scope);
  f.codec.markResult(result, { code: "NATIVE_REQUEST_TIMEOUT", resources: { pendingNativeOperation: true } }, f.scope);
  const snapshot = f.codec.takeResult(result, f.scope);
  const envelope = f.codec.project(snapshot, f.scope, { stage: "command", requestId: 37 });
  const decoded = f.codec.decodeError(envelope, { ...f.stamp, stage: "command", requestId: 37 });
  assert.equal(decoded.relatedErrors.length, 1);
  assert.equal(decoded.relatedErrors[0].code, "NATIVE_REQUEST_TIMEOUT");
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.resources)), resources);
  assert.equal(f.codec.takeResult(result, scopeB), undefined);
  assert.equal(f.codec.takeResult({}, f.scope), undefined);
  const forgery = {}; Object.defineProperty(forgery, Object.getOwnPropertySymbols(result)[0], { value: true });
  assert.equal(f.codec.takeResult(forgery, f.scope), undefined);
  assert.throws(() => f.codec.markResult(result, {}, scopeB), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  assert.throws(() => f.codec.markResult(null, {}, f.scope), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  assert.throws(() => f.codec.project({}, { ...f.scope }, { stage: "command", requestId: 37 }), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  for (const routing of [null, {}, { stage: "bad", requestId: 37 }, { stage: "command", requestId: 0 },
    { stage: "launch.config", requestId: 37 }])
    assert.throws(() => f.codec.project({}, f.scope, routing), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  assert.throws(() => f.codec.sessionStamp({ ...f.scope }), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
});

test("absence stays native-free while malformed presence, crossed sessions, config mutation and route conflicts refuse", async t => {
  const f = await stagedTransport(t);
  assert.equal(f.codec.forLaunch({}, f.clientInfo), null);
  assert.equal(f.codec.forDaemon({}, A), null);
  const absent = path.join(f.root, "absent.json"); f.put(absent, {});
  assert.equal(f.codec.forLaunch({ config: absent, session: A }, f.clientInfo), null);
  for (const patch of [{ cdp: "private endpoint" }, { endpoint: "private endpoint" }, { profile: path.join(f.root, "wrong-profile") },
    { browser: "chrome" }]) {
    const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge", ...patch }, f.clientInfo);
    try { assert.throws(() => reader.validate(), error => /^NATIVE_(CONFIG_INVALID|SELECTION_MISMATCH)$/.test(error.code)); }
    finally { reader.dispose(); }
  }
  const crossed = f.codec.forLaunch({ config: f.configFile, session: "22222222-2222-4222-8222-222222222222", browser: "msedge" }, f.clientInfo);
  try { assert.throws(() => crossed.validate(), { code: "NATIVE_CONFIG_INVALID" }); }
  finally { crossed.dispose(); }
  f.resolved.deskNativeContext = { ...f.resolved.deskNativeContext, label: "changed" };
  assert.throws(() => f.codec.sessionStamp(f.scope), { code: "NATIVE_CONFIG_INVALID" });
  f.resolved.deskNativeContext = f.config.deskNativeContext;
  const bytes = fs.readFileSync(f.configFile);
  fs.writeFileSync(f.configFile, JSON.stringify({ ...f.config, extra: true }));
  assert.throws(() => f.codec.sessionStamp(f.scope), { code: "NATIVE_CODE_CHANGED" });
  fs.writeFileSync(f.configFile, bytes);
  assert.equal(f.codec.sessionStamp(f.scope).contextId, A);
});

test("native err acquisition rejects existing/outside paths, closes only its descriptor and never truncates retained diagnostics", async t => {
  const f = await stagedTransport(t);
  const args = { config: f.configFile, session: A, browser: "msedge" };
  const outside = f.codec.forLaunch(args, { ...f.clientInfo, daemonProfilesDir: path.join(f.root, "outside") });
  try { assert.throws(() => outside.openErrorLog(), { code: "NATIVE_PRIVATE_PATH_INVALID" }); }
  finally { outside.dispose(); }
  const first = f.codec.forLaunch(args, f.clientInfo), second = f.codec.forLaunch(args, f.clientInfo);
  const fd = first.openErrorLog();
  const log = path.join(f.clientInfo.daemonProfilesDir, A + ".err");
  fs.writeSync(fd, "retained original diagnostic");
  try {
    assert.throws(() => first.openErrorLog(), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
    assert.throws(() => second.openErrorLog(), { code: "NATIVE_PRIVATE_PATH_INVALID" });
    assert.equal(fs.readFileSync(log, "utf8"), "retained original diagnostic");
    assert.equal(fs.fstatSync(fd).nlink, 1);
  } finally { first.dispose(); second.dispose(); }
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  assert.equal(fs.readFileSync(log, "utf8"), "retained original diagnostic");
});

test("native log preflight does not expose operating-system exception messages or paths", async t => {
  const f = await stagedTransport(t), raw = Object.assign(new Error("owned-private-native-log-path"), { code: "EACCES" });
  const lstat = f.observedFs.lstatSync;
  t.mock.method(f.observedFs, "lstatSync", function (file, ...args) {
    if (file === path.join(f.root, "owner/cache")) throw raw;
    return lstat.call(this, file, ...args);
  });
  const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  try {
    assert.throws(() => reader.openErrorLog(), error => {
      assert.equal(error.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
      assert.equal(error.message.includes("owned-private-native-log-path"), false); return true;
    });
  } finally { reader.dispose(); }
});

test("launch emitter waits actual Writable completion and drain rather than the redactor's acceptance callback", async t => {
  let done, clock = 0, counter = 0; const timers = new Map(), bytes = [];
  const sink = new Writable({ highWaterMark: 1, write(value, _encoding, callback) { bytes.push(Buffer.from(value)); done = callback; } });
  const f = await stagedTransport(t, { sink, now: () => clock,
    setTimeout(callback, delay) { const id = ++counter; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  const ready = { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null };
  let settled = false;
  const writing = f.codec.writeLaunch(f.scope, ready).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false); assert.equal(timers.size, 1);
  assert.equal(Buffer.concat(bytes).toString().startsWith("DESK_NATIVE_CLI_V1 "), true);
  done();
  await writing;
  assert.equal(settled, true); assert.equal(timers.size, 0);
  sink.destroy();
});

test("five-second output failure is bounded, never raw-falls-back and settles its owned Writable before teardown", async t => {
  let done, clock = 0, counter = 0; const timers = new Map(), bytes = [];
  const sink = new Writable({ highWaterMark: 1, write(value, _encoding, callback) { bytes.push(Buffer.from(value)); done = callback; } });
  const f = await stagedTransport(t, { sink, now: () => clock,
    setTimeout(callback, delay) { const id = ++counter; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  const ready = { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null };
  const writing = f.codec.writeLaunch(f.scope, ready);
  await Promise.resolve();
  clock = 5000;
  for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); }
  await assert.rejects(writing, { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  assert.equal(bytes.length, 1, "no raw-tail fallback write was attempted");
  done(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0); sink.destroy();
});

test("invalid native configs use a validated session or the reserved config-error-only unbound sentinel", async t => {
  const f = await stagedTransport(t);
  const invalid = { ...f.config, deskNativeContext: { ...f.config.deskNativeContext, contextId: "not-a-uuid" } };
  f.put(f.configFile, invalid);
  const known = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  const unbound = f.codec.forLaunch({ config: f.configFile, session: "bad-session", browser: "msedge" }, f.clientInfo);
  try {
    assert.equal(known.scope.contextId, A); assert.equal(unbound.scope.contextId, "unbound");
    const error = Object.assign(new Error("private config text"), { code: "NATIVE_CONFIG_INVALID" });
    const envelope = f.codec.project(error, unbound.scope, { stage: "launch.config", requestId: null });
    assert.equal(envelope.contextId, "unbound");
    await f.codec.writeLaunch(unbound.scope, envelope);
    assert.equal(f.output.length, 1);
    assert.throws(() => f.codec.decodeError(envelope, { ...f.stamp, stage: "launch.config", requestId: null }),
      { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
    assert.throws(() => f.codec.project(error, unbound.scope, { stage: "command", requestId: 1 }),
      { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
    await assert.rejects(f.codec.writeLaunch(unbound.scope,
      { ...f.stamp, contextId: "unbound", kind: "ready", stage: "launch.ready", requestId: null }),
      { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  } finally { known.dispose(); unbound.dispose(); }
  f.put(f.configFile, f.config);
  const fromRecord = f.codec.forLaunch({ config: f.configFile, session: "bad-session", browser: "msedge" }, f.clientInfo);
  try { assert.equal(fromRecord.scope.contextId, A); assert.throws(() => fromRecord.validate(), { code: "NATIVE_CONFIG_INVALID" }); }
  finally { fromRecord.dispose(); }
});

test("actual byte budgets refuse oversized input and expansion without silently deleting obligations or writing a partial frame", async t => {
  const f = await stagedTransport(t);
  const input = { opaque: Array(1030).fill("x".repeat(4096)) };
  assert.equal(f.codec.project({ code: "native_discard_incomplete", resources: input }, f.scope,
    { stage: "command", requestId: 37 }).code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
  assert.throws(() => f.codec.project({ code: "native_discard_incomplete", resources: { opaque: Array(330000).fill("x") } },
    f.scope, { stage: "command", requestId: 37 }), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  const command = f.codec.project(await originalCError(), f.scope, { stage: "command", requestId: 37 });
  await assert.rejects(f.codec.writeLaunch(f.scope, command), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  const envelope = { ...f.stamp, kind: "error", stage: "launch.publish", requestId: null,
    code: "native_discard_incomplete", message: "native_discard_incomplete", resources: { pendingAcquisitionOperations: [] } };
  const base = Buffer.byteLength(JSON.stringify(envelope)), unit = Buffer.byteLength(JSON.stringify("extension.handshake")) + 1;
  envelope.resources.pendingAcquisitionOperations = Array(Math.floor((4194304 - base + 1) / unit)).fill("extension.handshake");
  if (4194304 - Buffer.byteLength(JSON.stringify(envelope)) >= Buffer.byteLength(JSON.stringify("browser.bind")) + 1)
    envelope.resources.pendingAcquisitionOperations.push("browser.bind");
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 4194304);
  assert.ok(Buffer.byteLength("DESK_NATIVE_CLI_V1 " + JSON.stringify(envelope) + "\n") > 4194304);
  await assert.rejects(f.codec.writeLaunch(f.scope, envelope), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  assert.equal(f.output.length, 0);
});

test("descriptor-based config validation refuses accessors and absent fields without a native RPC or private exception leak", async t => {
  const f = await stagedTransport(t); let gets = 0;
  const accessor = Object.defineProperty({ ...f.resolved }, "deskNativeContext",
    { enumerable: true, get() { gets++; return f.config.deskNativeContext; } });
  assert.throws(() => f.codec.forDaemon(accessor, A), { code: "NATIVE_CONFIG_INVALID" });
  assert.equal(gets, 0);
  for (const config of [
    { ...f.resolved, browser: undefined },
    { ...f.resolved, browser: { userDataDir: f.config.browser.userDataDir } },
    { ...f.resolved, configFile: path.join(f.root, "missing-config.json") },
  ]) assert.throws(() => f.codec.forDaemon(config, A), error => /^NATIVE_/.test(error.code));
  const ready = { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null };
  const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  try {
    reader.push(Buffer.from("DESK_NATIVE_CLI_V1 " + JSON.stringify(ready) + "\n"));
    assert.equal((await reader.wait()).kind, "ready");
    reader.push(Buffer.from("DESK_NATIVE_CLI_V1 " + JSON.stringify(ready) + "\n"));
    assert.equal((await reader.wait()).kind, "ready", "already accepted readiness is an event, not a later health guarantee");
  } finally { reader.dispose(); }
});

test("receipt replacement and a changed second receipt read cannot manufacture a source generation", async t => {
  const f = await stagedTransport(t), receipt = path.join(f.root, "generation/playwright-patch.json");
  const read = f.observedFs.readFileSync;
  let phase = "bytes", replaced = false;
  t.mock.method(f.observedFs, "readFileSync", function (file, ...args) {
    const value = read.call(this, file, ...args);
    if (file === receipt && phase === "bytes" && !args.length) {
      const changed = JSON.parse(value); changed.revision = 5;
      return Buffer.from(JSON.stringify(changed));
    }
    if (file === receipt && phase === "inode" && !replaced) {
      replaced = true; fs.renameSync(receipt, receipt + ".owned-first"); fs.copyFileSync(receipt + ".owned-first", receipt);
    }
    return value;
  });
  for (phase of ["bytes", "inode"]) assert.throws(() => f.codec.forLaunch({
    config: f.configFile, session: A, browser: "msedge"
  }, f.clientInfo), { code: "NATIVE_CODE_CHANGED" });
});

for (const afterProtection of [false, true]) {
  test(`native err regular-file replacement ${afterProtection ? "after" : "before"} protection preserves the peer and closes only the original descriptor`, {
    skip: process.platform === "win32" ? "POSIX descriptor mutation seam; Windows ACL command verdict is separate" : false,
  }, async t => {
    const f = await stagedTransport(t), peer = path.join(f.root, "owned-regular-peer");
    f.put(peer, "peer original bytes");
    const log = path.join(f.clientInfo.daemonProfilesDir, A + ".err");
    let fd, moved = false;
    function replace() { if (moved) return; moved = true; fs.renameSync(log, log + ".owned-first"); fs.renameSync(peer, log); }
    const open = f.observedFs.openSync, protect = f.observedFs.fchmodSync;
    t.mock.method(f.observedFs, "openSync", function (file, ...args) {
      const value = open.call(this, file, ...args);
      if (file === log) { fd = value; if (!afterProtection) replace(); }
      return value;
    });
    t.mock.method(f.observedFs, "fchmodSync", function (value, ...args) {
      const result = protect.call(this, value, ...args);
      if (value === fd && afterProtection) replace();
      return result;
    });
    const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
    try {
      assert.throws(() => reader.openErrorLog(), { code: "NATIVE_PRIVATE_PATH_INVALID" });
      assert.equal(fs.readFileSync(log, "utf8"), "peer original bytes");
      assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    } finally { reader.dispose(); }
  });
}

test("an exclusive log-open failure has no descriptor to close and remains a bounded projected error", async t => {
  const f = await stagedTransport(t), open = f.observedFs.openSync;
  const log = path.join(f.clientInfo.daemonProfilesDir, A + ".err");
  t.mock.method(f.observedFs, "openSync", function (file, ...args) {
    if (file === log) throw Object.assign(new Error("private operating system text"), { code: "EACCES" });
    return open.call(this, file, ...args);
  });
  const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  try { assert.throws(() => reader.openErrorLog(), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" }); }
  finally { reader.dispose(); }
  assert.equal(fs.existsSync(log), false);
});

test("a self-consistent falsified receipt cannot bless missing or old complete transport regions", async t => {
  const f = await stagedTransport(t), credential = f.template("desk-extension-credential.cjs");
  const installed = { dir: path.join(f.root, "generation"), version: "owned-E4", core: null };
  const receiptFile = path.join(installed.dir, "playwright-patch.json"), coreFile = path.join(f.lib, "coreBundle.js");
  const sessionFile = path.join(f.lib, "tools/cli-client/session.js");
  const receiptBytes = fs.readFileSync(receiptFile), core = fs.readFileSync(coreFile, "utf8"), session = fs.readFileSync(sessionFile, "utf8");
  const sha = value => require("node:crypto").createHash("sha256").update(value).digest("hex");
  const specifications = require("./fixtures/playwright-native-error-transport.cjs").regions;
  for (const kind of ["missing-backend", "old-core", "old-session"]) {
    let candidateCore = core, candidateSession = session;
    const receipt = JSON.parse(receiptBytes);
    if (kind === "missing-backend") candidateCore = core.replace("var init_browserBackend = __esm({", "var init_browserBackendChanged = __esm({");
    if (kind === "old-core") for (const [key, begin, end] of specifications) {
      if (key === "session") continue;
      const start = candidateCore.indexOf(begin), finish = candidateCore.indexOf(end, start);
      candidateCore = candidateCore.slice(0, start) + f.input[key] + candidateCore.slice(finish);
    }
    if (kind === "old-session") candidateSession = f.input.sessionSource;
    receipt.bundleSha256 = sha(candidateCore); receipt.sessionSha256 = sha(candidateSession);
    if (kind === "old-core") for (let i = 0; i < 4; i++) {
      const [, begin, end] = specifications[i], start = candidateCore.indexOf(begin);
      receipt.errorRegionProofs.core[i].patched = sha(candidateCore.slice(start, candidateCore.indexOf(end, start)));
    }
    if (kind === "old-session") receipt.errorRegionProofs.session.patched = sha(f.input.session);
    fs.writeFileSync(coreFile, candidateCore); fs.writeFileSync(sessionFile, candidateSession);
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    assert.throws(() => credential.verifyGeneration(installed, mcpRoot), { code: "NATIVE_CODE_UNAVAILABLE" });
    fs.writeFileSync(coreFile, core); fs.writeFileSync(sessionFile, session); fs.writeFileSync(receiptFile, receiptBytes);
  }
});

test("native log protection executes the real Windows SID/DACL command boundary and remains safe without O_NOFOLLOW", async t => {
  const f = await stagedTransport(t), directory = path.join(f.root, "owned-windows-protection");
  const file = path.join(directory, "owned.err"), calls = [];
  f.put(file, "");
  const fd = fs.openSync(file, "w");
  const context = { module: { exports: {} }, __dirname: f.lib, Buffer, setTimeout, clearTimeout,
    process: { platform: "win32", getuid: process.getuid?.bind(process), env: { SystemRoot: "C:\\Windows" } },
    require: name => name === "child_process" ? { execFileSync(executable, args, options) {
      calls.push({ executable, args, paths: JSON.parse(options.input) });
      return "";
    } } : require(name) };
  require("./fixtures/native-template-loader.cjs").loadTemplate(path.join(f.lib, "desk-extension-credential.cjs"), context);
  try {
    // Invoke the genuine internal OS-private boundary from the unchanged
    // compiled source, not a fake native client or an alternate factory.
    context.protectNativeErrorLog(fd, directory, file);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(calls[0].paths, [directory, file]);
    assert.match(calls[0].args.at(-1), /SetAccessRuleProtection/);
    assert.match(calls[0].args.at(-1), /GetOwner/);
    assert.match(calls[0].args.at(-1), /ReparsePoint/);
  } finally { fs.closeSync(fd); }
  Object.defineProperty(f.observedFs, "constants", { configurable: true,
    value: { ...fs.constants, O_NOFOLLOW: undefined } });
  const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  const ownFd = reader.openErrorLog();
  reader.dispose();
  assert.throws(() => fs.fstatSync(ownFd), { code: "EBADF" });
});

for (const ready of [false, true]) {
  test(`actual parent Session preserves ${ready ? "unknown rather than ready success" : "the primary C error"} when its own descriptor close fails`, async t => {
    const f = await stagedTransport(t), original = await originalCError();
    const child = new EventEmitter(), signals = new EventEmitter(); child.stdout = new EventEmitter(); child.pid = 125;
    child.stdout.destroy = () => {}; child.unref = () => {};
    const source = fs.readFileSync(path.join(f.lib, "tools/cli-client/session.js"), "utf8");
    const begin = source.indexOf("  static async startDaemon("), method = source.slice(begin, source.indexOf("\n  async _stopDaemon()", begin));
    const log = path.join(f.clientInfo.daemonProfilesDir, A + ".err"), open = f.observedFs.openSync, close = f.observedFs.closeSync;
    let ownedFd, emission;
    t.mock.method(f.observedFs, "openSync", function (file, ...args) {
      const fd = open.call(this, file, ...args); if (file === log) ownedFd = fd; return fd;
    });
    t.mock.method(f.observedFs, "closeSync", function (fd) {
      close.call(this, fd);
      if (fd === ownedFd) throw Object.assign(new Error("private-native-close-path"), { code: "EIO" });
    });
    f.proc.stdout.write = (bytes, callback) => { queueMicrotask(() => child.stdout.emit("data", Buffer.from(bytes))); callback?.(); return true; };
    const Session = vm.runInNewContext("class Session {\n" + method + "\n}; Session", {
      process: Object.assign(signals, { execPath: process.execPath, cwd: () => f.root }),
      require: name => {
        if (name === "../../coreBundle.js") return maintainedConfigInterface(f);
        assert.equal(name, "../../desk-native-error-transport.cjs"); return f.codec;
      },
      import_fs: { default: fs }, import_path: { default: path },
      import_package: { libPath: () => path.join(f.lib, "entry/cliDaemon.js") },
      import_registry: { resolveSessionName: value => value },
      import_child_process: { spawn() {
        queueMicrotask(() => {
          const value = ready ? { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null } :
            f.codec.project(original, f.scope, { stage: "launch.acquire", requestId: null });
          emission = f.codec.writeLaunch(f.scope, value);
        });
        return child;
      } },
    });
    try {
      await assert.rejects(Session.startDaemon(f.clientInfo, { config: f.configFile, session: A, browser: "msedge" }), error => {
        assert.equal(error.code, ready ? "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" : "native_discard_incomplete");
        if (!ready) {
          assert.deepEqual(JSON.parse(JSON.stringify(error.resources)), resources);
          assert.equal(error.relatedErrors.length, 1);
          assert.equal(error.relatedErrors[0].code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
        }
        assert.equal(error.message.includes("private-native-close-path"), false);
        return true;
      });
      assert.equal(signals.eventNames().length, 0);
      assert.equal(child.eventNames().length, 0);
      assert.equal(child.stdout.eventNames().length, 0);
    } finally {
      await emission;
      signals.removeAllListeners(); child.removeAllListeners(); child.stdout.removeAllListeners();
      assert.throws(() => fs.fstatSync(ownedFd), { code: "EBADF" });
    }
  });
}

test("a nonprefix partial diagnostic is bounded at one MiB without waiting for newline or EOF", async t => {
  const f = await stagedTransport(t), reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  let settled = false;
  const waiting = reader.wait().catch(error => { settled = true; return error; });
  try {
    reader.push(Buffer.alloc(1048577, 120));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, true);
    assert.equal((await waiting).code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
  } finally { reader.dispose(); await waiting; }
});

test("startup deadline is rechecked after synchronous error-frame validation delays timer delivery", async t => {
  let clock = 0, id = 0; const timers = new Map();
  const f = await stagedTransport(t, { now: () => clock,
    setTimeout(callback, delay) { const key = ++id; timers.set(key, { callback, delay }); return key; },
    clearTimeout(key) { timers.delete(key); } });
  const envelope = f.codec.project(await originalCError(), f.scope, { stage: "launch.acquire", requestId: null });
  const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  const read = f.observedFs.readFileSync, receipt = path.join(f.root, "generation/playwright-patch.json");
  t.mock.method(f.observedFs, "readFileSync", function (file, ...args) {
    const value = read.call(this, file, ...args); if (file === receipt) clock = 45001; return value;
  });
  try {
    const waiting = reader.wait();
    reader.push(Buffer.from("DESK_NATIVE_CLI_V1 " + JSON.stringify(envelope) + "\n"));
    await assert.rejects(waiting, { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  } finally { reader.dispose(); }
  assert.equal(timers.size, 0);
});

test("deadline expiry during the actual log open refuses before spawn and still closes only its owned descriptor", async t => {
  let clock = 0, id = 0; const timers = new Map();
  const f = await stagedTransport(t, { now: () => clock,
    setTimeout(callback, delay) { const key = ++id; timers.set(key, { callback, delay }); return key; },
    clearTimeout(key) { timers.delete(key); } });
  const reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  const open = f.observedFs.openSync, log = path.join(f.clientInfo.daemonProfilesDir, A + ".err");
  let ownedFd;
  t.mock.method(f.observedFs, "openSync", function (file, ...args) {
    const fd = open.call(this, file, ...args);
    if (file === log) { ownedFd = fd; clock = 45001; }
    return fd;
  });
  try { assert.throws(() => reader.openErrorLog(), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" }); }
  finally { reader.dispose(); }
  assert.throws(() => fs.fstatSync(ownedFd), { code: "EBADF" });
  assert.equal(timers.size, 0);
});

test("ready cannot bless a config changed after the parent's genuine private preflight", async t => {
  const f = await stagedTransport(t), reader = f.codec.forLaunch({ config: f.configFile, session: A, browser: "msedge" }, f.clientInfo);
  reader.validate();
  f.put(f.configFile, { ...f.config, changedAfterPreflight: true });
  try {
    const waiting = reader.wait();
    reader.push(Buffer.from("DESK_NATIVE_CLI_V1 " + JSON.stringify({ ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null }) + "\n"));
    await assert.rejects(waiting, { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  } finally { reader.dispose(); }
});

test("launch writer validates descriptors before inspecting a caller's discriminant", async t => {
  const f = await stagedTransport(t); let gets = 0;
  const candidate = Object.defineProperty({}, "kind", { enumerable: true, get() { gets++; return "ready"; } });
  await assert.rejects(f.codec.writeLaunch(f.scope, candidate), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  assert.equal(gets, 0);
  assert.equal(f.output.length, 0);
});

test("independently verified equivalent scopes retain source-owned primary and related projections", async t => {
  const f = await stagedTransport(t), other = f.codec.forDaemon(JSON.parse(JSON.stringify(f.resolved)), A);
  assert.notEqual(other, f.scope);
  assert.deepEqual(JSON.parse(JSON.stringify(f.codec.sessionStamp(other))), JSON.parse(JSON.stringify(f.stamp)));
  const result = {}, primary = await originalCError();
  f.codec.markResult(result, primary, f.scope);
  f.codec.markResult(result, { code: "NATIVE_REQUEST_TIMEOUT", resources: { pendingNativeOperation: true } }, f.scope);
  const original = f.codec.takeResult(result, f.scope);
  const retained = f.codec.takeResult(result, other);
  assert.ok(retained, "an independently verified equivalent scope must not flatten the marked result");
  assert.deepEqual(JSON.parse(JSON.stringify(retained)), JSON.parse(JSON.stringify(original)));
  const reprojected = f.codec.project(original, other, { stage: "command", requestId: 37 });
  assert.equal(reprojected.code, "native_discard_incomplete");
  assert.deepEqual(JSON.parse(JSON.stringify(reprojected.resources)), resources);
  assert.equal(reprojected.relatedErrors.length, 1);
  f.codec.markResult(result, primary, other);
  assert.equal(f.codec.takeResult(result, other).relatedErrors.length, 2);
});

test("actual daemon serializer retains backend errors across independently resolved equivalent configs", async t => {
  const f = await stagedTransport(t), daemon = transformedDaemon(f, {
    toolError: await originalCError(), independentBackendConfig: true,
  });
  t.after(() => daemon.close());
  await daemon.start(A, daemon.browserContext, {}, f.resolved, f.clientInfo, {}, {});
  const reply = await daemon.request({ id: 37, method: "run", params: { args: {} } });
  assert.equal("result" in reply, false, "equivalent backend/daemon scopes must use the error arm");
  const error = f.codec.decodeError(reply.error, { ...f.stamp, stage: "command", requestId: 37 });
  assert.equal(error.code, "native_discard_incomplete");
  assert.deepEqual(JSON.parse(JSON.stringify(error.resources)), resources);
});

test("launch emitter rejects its individually refused protected write even when an earlier write later drains", async t => {
  let done; const bytes = [];
  const sink = new Writable({ highWaterMark: 1, write(value, _encoding, callback) {
    bytes.push(Buffer.from(value)); done = callback;
  } });
  const f = await stagedTransport(t, { sink });
  f.template("desk-extension-credential.cjs").protect(f.proc);
  assert.equal(sink.write("earlier diagnostic\n"), false);
  const writing = f.codec.writeLaunch(f.scope, { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null });
  const observed = writing.then(() => null, error => error);
  try {
    await new Promise(resolve => setImmediate(resolve));
    done();
    const error = await observed;
    assert.equal(error?.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED",
      "flushing the earlier diagnostic cannot prove acceptance of the refused frame");
    assert.equal(Buffer.concat(bytes).toString(), "earlier diagnostic\n");
  } finally { sink.destroy(); }
});

function maintainedConfigInterface(f, boundary = f.observedFs) {
  const core = fs.readFileSync(path.join(f.lib, "coreBundle.js"), "utf8");
  const region = (start, end) => core.slice(core.indexOf(start), core.indexOf(end, core.indexOf(start)));
  const loader = region("async function loadConfig(configFile) {", "\nfunction resolveConfigPaths(");
  const ini = region("function configFromIniFile(filePath) {", "\n// packages/playwright-core/src/tools/mcp/config.ts");
  const exports = region("var tools_exports = {};", "\nvar init_tools2 = __esm({");
  return vm.runInNewContext(ini + "\n" + loader + "\n" + exports +
    "\ninit_configIni(); ({ tools: tools_exports, loadConfig })", {
      import_fs65: { default: boundary },
      require: name => name === "fs" ? boundary :
        require(path.resolve(cliDirectory(), "../../utilsBundle.js")),
      __esm: object => () => Object.values(object)[0](),
      __toESM: value => ({ default: value }),
      __export: (target, entries) => {
        for (const [key, get] of Object.entries(entries))
          Object.defineProperty(target, key, { get, enumerable: true });
      },
    });
}

function externalSessionBoundary(t, f, options = {}) {
  const source = options.original ? f.input.sessionSource :
    fs.readFileSync(path.join(f.lib, "tools/cli-client/session.js"), "utf8");
  const begin = source.indexOf("  static async startDaemon(");
  const method = source.slice(begin, source.indexOf("\n  async _stopDaemon()", begin));
  const signals = new EventEmitter(), descriptors = new Set(), loads = [], children = [];
  const boundary = Object.create(f.observedFs);
  boundary.openSync = () => { descriptors.add(91); return 91; }; // original stock log only; native opens through the real credential helper
  let spawns = 0;
  const Session = vm.runInNewContext("class Session {\n" + method + "\n}; Session", {
    process: Object.assign(signals, { execPath: process.execPath, cwd: () => f.root }),
    import_fs: { default: boundary }, import_path: { default: path },
    import_package: { libPath: () => path.join(f.lib, "entry/cliDaemon.js") },
    import_registry: { resolveSessionName: value => value },
    require: name => {
      loads.push(name);
      if (name === "../../coreBundle.js") return maintainedConfigInterface(f, boundary);
      assert.equal(name, "../../desk-native-error-transport.cjs");
      return f.codec;
    },
    import_child_process: { spawn() {
      spawns++;
      const child = new EventEmitter(); child.pid = 125; child.stdout = new EventEmitter();
      child.stdout.destroy = () => {}; child.unref = () => {};
      children.push(child);
      queueMicrotask(() => child.stdout.emit("data", Buffer.from("Daemon listening on owned-stock-socket\n")));
      return child;
    } },
  });
  const close = () => {
    for (const child of children) { child.stdout.removeAllListeners(); child.removeAllListeners(); }
    signals.removeAllListeners(); descriptors.clear();
  };
  t.after(close);
  return { Session, loads, close, get spawns() { return spawns; } };
}

for (const [name, extension, text] of [
  ["INI", ".ini", "browser.browserName=chromium\n# deskNativeContext is only a comment\n"],
  ["non-JSON INI fallback", ".json", "browser.browserName=chromium\nnote=deskNativeContext\n"],
  ["BOM JSON", ".json", '\ufeff{"browser":{"browserName":"chromium"},"note":"deskNativeContext"}'],
  ["plain JSON", ".json", '{"browser":{"browserName":"chromium"},"note":"deskNativeContext"}'],
]) {
  test(`stock ${name} uses actual maintained config semantics and original readiness without native imports`, async t => {
    const f = await stagedTransport(t), file = path.join(f.root, "public-config" + extension);
    f.put(file, text); fs.chmodSync(file, 0o644);
    for (const original of [true, false]) {
      const boundary = externalSessionBoundary(t, f, { original });
      const result = await boundary.Session.startDaemon(f.clientInfo, { config: file, session: A });
      assert.equal(result.pid, 125); assert.equal(boundary.spawns, 1);
      assert.equal(boundary.loads.some(value => /native-error|credential|messaging/.test(value)), false);
      boundary.close();
    }
  });
}

test("native-known second config read parse failure is coded and private in actual Session/codec/credential", async t => {
  const f = await stagedTransport(t), valid = fs.readFileSync(f.configFile, "utf8");
  const read = f.observedFs.readFileSync;
  let reads = 0;
  const value = (file, ...args) => file === f.configFile ?
    (++reads === 1 ? valid : '{"owned-private-input-secret":invalid') : read.call(f.observedFs, file, ...args);
  t.mock.method(f.observedFs, "readFileSync", value);
  Object.defineProperty(f.observedFs, "promises", { value: { ...fs.promises, readFile: async (...args) => value(...args) } });
  const boundary = externalSessionBoundary(t, f);
  await assert.rejects(boundary.Session.startDaemon(f.clientInfo, { config: f.configFile, session: A, browser: "msedge" }), error => {
    assert.equal(error.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    assert.equal(error.resources.contextId, A);
    assert.equal(error.resources.disposition, "unknown");
    assert.equal(String(error).includes("owned-private-input-secret"), false);
    assert.equal(error.sourceGeneration, undefined);
    return true;
  });

  assert.equal(reads, 2); assert.equal(boundary.spawns, 0);
});

test("actual startup does not attempt a second terminal record after ambiguous ready delivery", async t => {
    let done, clock = 0, counter = 0;
    const timers = new Map();
    const sink = new Writable({ highWaterMark: 1, write(_value, _encoding, callback) { done = callback; } });
    const f = await stagedTransport(t, { sink, now: () => clock,
      setTimeout(callback, delay) { const id = ++counter; timers.set(id, { callback, due: clock + delay }); return id; },
      clearTimeout(id) { timers.delete(id); } });
    const helper = f.template("desk-extension-credential.cjs"); helper.protect(f.proc);
    let attempts = 0; const write = sink.write;
    sink.write = function (...args) { attempts++; return write.apply(this, args); };
    const daemon = transformedDaemon(f); t.after(() => daemon.close());
    const program = transformedProgram(f, daemon, undefined, "ready");
    const action = program.action(A, { config: f.configFile, browser: "msedge" });
    while (!done) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    clock = 5000;
    for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); }
    await action;
    done(); await new Promise(resolve => setImmediate(resolve));
    sink.destroy();
    // stderr shares the protected sink in this fixture; the fixed unconfirmed
    // diagnostic is permitted, a second reserved terminal frame is not.
    assert.equal(attempts, 2, "one frame attempt and one fixed stderr diagnostic only");
    assert.equal(program.exit, 1); assert.equal(timers.size, 0);
});

for (const value of ["false", "null", "23", "wrong-type"]) {
  test(`actual maintained INI own native property ${value} never falls back to stock`, async t => {
    const f = await stagedTransport(t), file = path.join(f.root, "native.ini");
    f.put(file, "browser.browserName=chromium\ndeskNativeContext=" + value + "\n");
    const boundary = externalSessionBoundary(t, f);
    await assert.rejects(boundary.Session.startDaemon(f.clientInfo, { config: file, session: A }), {
      code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED",
    });
    assert.equal(boundary.spawns, 0);
    assert.equal(boundary.loads.includes("../../desk-native-error-transport.cjs"), true);
  });
}

for (const second of ["read-error", "absent", "missing-source"]) {
  test(`native-known ${second} on the second read never becomes stock or leaks private source`, async t => {
    const f = await stagedTransport(t), valid = fs.readFileSync(f.configFile, "utf8");
    const read = f.observedFs.readFileSync; let reads = 0;
    const value = (file, ...args) => {
      if (file !== f.configFile) return read.call(f.observedFs, file, ...args);
      reads++;
      if (reads === 1) return valid;
      if (second === "read-error") throw Object.assign(new Error("owned-private-read-path"), { code: "EACCES" });
      if (second === "missing-source") {
        const receipt = path.join(f.root, "generation/playwright-patch.json");
        if (fs.existsSync(receipt)) fs.renameSync(receipt, receipt + ".held");
        return valid;
      }
      return "{}";
    };
    t.mock.method(f.observedFs, "readFileSync", value);
    Object.defineProperty(f.observedFs, "promises", { value: { ...fs.promises, readFile: async (...args) => value(...args) } });
    const boundary = externalSessionBoundary(t, f);
    await assert.rejects(boundary.Session.startDaemon(f.clientInfo, { config: f.configFile, session: A }), error => {
      assert.equal(error.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
      assert.deepEqual(JSON.parse(JSON.stringify(error.resources)), { disposition: "unknown", contextId: A });
      assert.equal(error.sourceGeneration, undefined);
      assert.equal(String(error).includes("owned-private"), false);
      return true;
    });
    assert.equal(boundary.spawns, 0); assert.equal(reads, 2);
  });
}

test("direct native file binding normalizes initial parse failure without inventing an unbound generation", async t => {
  const f = await stagedTransport(t);
  fs.writeFileSync(f.configFile, '{"owned-private-input-secret":invalid');
  assert.throws(() => f.codec.forLaunch({ config: f.configFile, session: "not-a-uuid" }, f.clientInfo), error => {
    assert.equal(error.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
    assert.deepEqual(JSON.parse(JSON.stringify(error.resources)), { disposition: "unknown" });
    assert.equal(String(error).includes("owned-private-input-secret"), false);
    assert.equal(error.sourceGeneration, undefined);
    return true;
  });
});

for (const mode of ["missing", "drain-before-acceptance", "acceptance-before-drain-deadline", "duplicate"]) {
  test(`individual protected frame callback ${mode} stays bounded and distinct from delivery`, async t => {
    let done, clock = 0, counter = 0; const timers = new Map(), bytes = [], callbacks = [];
    const sink = new Writable({ highWaterMark: 1, write(value, _encoding, callback) {
      bytes.push(Buffer.from(value)); done = callback;
    } });
    const f = await stagedTransport(t, { sink, now: () => clock,
      setTimeout(callback, delay) { const id = ++counter; timers.set(id, { callback, due: clock + delay }); return id; },
      clearTimeout(id) { timers.delete(id); } });
    f.proc.nextTick = callback => { callbacks.push(callback); };
    const writing = f.codec.writeLaunch(f.scope, { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null });
    const observed = writing.then(() => null, error => error);
    const expire = at => {
      clock = at;
      for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); }
    };
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callbacks.length, 1);
    if (mode === "drain-before-acceptance" || mode === "duplicate") {
      done(); await new Promise(resolve => setImmediate(resolve));
      callbacks[0](); if (mode === "duplicate") callbacks[0]();
      assert.equal(await observed, null);
    } else {
      if (mode === "acceptance-before-drain-deadline") { clock = 4000; callbacks[0](); }
      expire(5000);
      assert.equal((await observed)?.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
      done(); callbacks[0](); callbacks[0]();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(timers.size, 0);
    assert.equal(bytes.length, 1);
    const wire = Buffer.concat(bytes).toString();
    assert.equal(wire.startsWith("DESK_NATIVE_CLI_V1 "), true); assert.equal(wire.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(wire.slice("DESK_NATIVE_CLI_V1 ".length)), {
      version: 1, kind: "ready", contextId: A, sourceGeneration: f.stamp.sourceGeneration,
      stage: "launch.ready", requestId: null,
    });
    sink.destroy();
  });
}

for (const moment of ["validation", "after-delivery"]) {
  test(`whole launch-write deadline covers synchronous ${moment} delays as well as callback waits`, async t => {
    let clock = 0, calls = 0;
    const f = await stagedTransport(t, { now() {
      calls++;
      if (moment === "validation" && calls === 2) clock = 5000;
      return clock;
    } });
    if (moment === "after-delivery") {
      const write = f.proc.stdout.write;
      f.proc.stdout.write = function (...args) { const result = write.apply(this, args); clock = 5000; return result; };
    }
    await assert.rejects(f.codec.writeLaunch(f.scope, { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null }),
      { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
    assert.equal(f.output.length, moment === "validation" ? 0 : 1);
  });
}

function reviewedPriorE4(f) {
  const sha = text => require("node:crypto").createHash("sha256").update(text).digest("hex");
  let core = require("./fixtures/playwright-native-error-transport.cjs").priorStopSource(
    fs.readFileSync(path.join(f.lib, "coreBundle.js"), "utf8"));
  core = core.replace('try { deskNativePresent = await deskNativeConfigPresent(options.config); }',
    'try { const config = JSON.parse(require("fs").readFileSync(options.config, "utf8")); deskNativePresent = !!config && Object.prototype.hasOwnProperty.call(config, "deskNativeContext"); }')
    .replace('let deskScope, deskEmissionStarted = false, deskStage = "launch.config";', 'let deskScope, deskStage = "launch.config";')
    .replace("        deskEmissionStarted = true;\n", "")
    .replace("if (!deskScope || deskEmissionStarted)", "if (!deskScope)");
  const presenceStart = core.indexOf("\nasync function deskNativeConfigPresent(");
  core = core.slice(0, presenceStart) + core.slice(core.indexOf("\nfunction resolveConfigPaths(", presenceStart));
  core = core.replace("  deskNativeConfigPresent: () => deskNativeConfigPresent,\n", "");
  const program = core.slice(core.indexOf("function decorateProgram3(program4) {"), core.indexOf("\nfunction defaultConfigFile("));
  assert.equal(sha(program), "b390a51a049b14a1c05bc4b89092db0491cbe8a6870a0615937daabcb0d32cc7",
    "fixed independent reviewed-93db complete-region pin, not a generated expected value");
  let session = fs.readFileSync(path.join(f.lib, "tools/cli-client/session.js"), "utf8");
  session = session.replace('try { deskNativePresent = await require("../../coreBundle.js").tools.deskNativeConfigPresent(cliArgs.config); }',
    'try { const config = JSON.parse(import_fs.default.readFileSync(cliArgs.config, "utf8")); deskNativePresent = !!config && Object.prototype.hasOwnProperty.call(config, "deskNativeContext"); }')
    .replace("      let deskCodec, reader, child, deskFailure;",
      '      const deskCodec = require("../../desk-native-error-transport.cjs");\n      const reader = deskCodec.forLaunch(cliArgs, clientInfo);\n      let child, deskFailure;')
    .replace('        deskCodec = require("../../desk-native-error-transport.cjs");\n        reader = deskCodec.forLaunch(cliArgs, clientInfo);\n', "")
    .replace('      } catch (error) {\n        if (!reader) error = Object.assign(new Error("NATIVE_ERROR_TRANSPORT_UNCONFIRMED"), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED", resources: { disposition: "unknown", ...(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(cliArgs.session) ? { contextId: cliArgs.session } : {}) } });\n        deskFailure = error; throw error;\n      } finally {',
      "      } catch (error) { deskFailure = error; throw error; } finally {")
    .replace("const cleanupError = reader?.dispose();", "const cleanupError = reader.dispose();");
  const begin = session.indexOf("  static async startDaemon(");
  assert.equal(sha(session.slice(begin, session.indexOf("\n  async _stopDaemon()", begin))),
    "56c9113590f7148f411740f2c0fb157a809eb978a8604c3857a4f12623f4dff6");
  return { core, session };
}

test("only the complete reviewed prior E4 pair migrates to fresh fixed guards, not mixed or tampered forms", async t => {
  const f = await stagedTransport(t), prior = reviewedPriorE4(f);
  const patch = require(path.join(mcpRoot, "web-playwright-patch.cjs"));
  const coreFile = path.join(f.lib, "coreBundle.js"), sessionFile = path.join(f.lib, "tools/cli-client/session.js");
  const currentCore = fs.readFileSync(coreFile, "utf8"), currentSession = fs.readFileSync(sessionFile, "utf8");
  assert.equal(patch.patchSource(prior.core), currentCore);
  assert.equal(patch.patchSessionSource(prior.session), currentSession);
  for (const [core, session] of [[prior.core, currentSession], [currentCore, prior.session],
    [prior.core.replace("async function loadConfig(configFile)", "async function loadConfig(tampered)"), prior.session],
    [prior.core.replace("raw.charCodeAt(0) === 65279", "raw.charCodeAt(0) === 0"), prior.session],
    [prior.core.replace("function coerceIniValue(value2)", "function coerceIniValue(tampered)"), prior.session],
    [prior.core.replace("  start: () => start\n});", "  start: () => wrong\n});"), prior.session],
    [prior.core.replace("\n// packages/playwright-core/src/tools/backend/common.ts",
      "\n// owned unexpected backend change\n// packages/playwright-core/src/tools/backend/common.ts"), prior.session],
    [prior.core, prior.session.replace("return { pid: child.pid", "return { pid: 0")]]) {
    fs.writeFileSync(coreFile, core); fs.writeFileSync(sessionFile, session);
    assert.throws(() => patch.apply({ dir: path.join(f.root, "generation"), version: "owned-E4", core: null }),
      { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" });
    assert.equal(fs.readFileSync(coreFile, "utf8"), core);
    assert.equal(fs.readFileSync(sessionFile, "utf8"), session);
  }
  fs.writeFileSync(coreFile, prior.core); fs.writeFileSync(sessionFile, prior.session);
  patch.apply({ dir: path.join(f.root, "generation"), version: "owned-E4", core: null });
  assert.equal(patch.readRevision({ dir: path.join(f.root, "generation"), version: "owned-E4", core: null }), 4);
  assert.equal(fs.readFileSync(coreFile, "utf8"), currentCore);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), currentSession);
});

test("independent backend/daemon configs preserve related original C errors through the actual socket serializer", async t => {
  const f = await stagedTransport(t), secondary = { contextId: A, disposition: "unknown", pendingNativeOperation: true };
  const daemon = transformedDaemon(f, { independentBackendConfig: true, toolError: await originalCError(),
    pendingErrors: [await originalCError(secondary)] });
  t.after(() => daemon.close());
  await daemon.start(A, daemon.browserContext, {}, f.resolved, f.clientInfo, {}, {});
  const reply = await daemon.request({ id: 37, method: "run", params: { args: {} } });
  const error = f.codec.decodeError(reply.error, { ...f.stamp, stage: "command", requestId: 37 });
  assert.equal(error.code, "native_discard_incomplete");
  assert.deepEqual(JSON.parse(JSON.stringify(error.resources)), resources);
  assert.deepEqual(JSON.parse(JSON.stringify(error.relatedErrors)), [{
    code: "native_discard_incomplete", message: "native_discard_incomplete", resources: secondary,
  }]);
});

test("actual private config inode replacement during reader construction refuses and closes its original descriptor", async t => {
  const f = await stagedTransport(t), bytes = fs.readFileSync(f.configFile);
  const originalOpen = fs.openSync, originalClose = fs.closeSync;
  let opened, closed = 0;
  t.mock.method(fs, "openSync", function (file, ...args) {
    const fd = originalOpen.call(this, file, ...args);
    if (file === f.configFile && args.length === 1 && args[0] === "r" && opened === undefined) {
      opened = fd;
      fs.renameSync(file, file + ".held");
      f.put(file, bytes.toString());
    }
    return fd;
  });
  t.mock.method(fs, "closeSync", function (fd) {
    if (fd === opened) closed++;
    return originalClose.call(this, fd);
  });
  const boundary = externalSessionBoundary(t, f);
  await assert.rejects(boundary.Session.startDaemon(f.clientInfo, { config: f.configFile, session: A, browser: "msedge" }),
    error => { assert.equal(error.code, "NATIVE_PRIVATE_STATE_CHANGED"); return true; });
  assert.equal(boundary.spawns, 0); assert.equal(closed, 1);
  assert.throws(() => fs.fstatSync(opened), { code: "EBADF" });
  assert.deepEqual(fs.readFileSync(f.configFile), bytes);
  assert.deepEqual(fs.readFileSync(f.configFile + ".held"), bytes);
});

test("actual protected Writable synchronous failure cannot become accepted delivery or a raw exception", async t => {
  const sink = new Writable({ write() { throw Error("owned-private-sink-secret"); } });
  const f = await stagedTransport(t, { sink });
  try {
    await assert.rejects(f.codec.writeLaunch(f.scope,
      { ...f.stamp, kind: "ready", stage: "launch.ready", requestId: null }), error => {
        assert.equal(error.code, "NATIVE_ERROR_TRANSPORT_UNCONFIRMED");
        assert.equal(String(error).includes("owned-private-sink-secret"), false);
        return true;
      });
  } finally { sink.destroy(); }
});

for (const crossing of ["context", "generation", "private-owner"]) {
  test(`source-owned retained projections refuse crossed verified ${crossing} rather than retagging original resources`, async t => {
    const f = await stagedTransport(t), result = {};
    f.codec.markResult(result, await originalCError(), f.scope);
    f.codec.markResult(result, { code: "NATIVE_REQUEST_TIMEOUT", resources: { pendingNativeOperation: true } }, f.scope);
    const snapshot = f.codec.takeResult(result, f.scope);
    let config = JSON.parse(JSON.stringify(f.resolved));
    if (crossing === "generation") {
      require(path.join(mcpRoot, "web-playwright-patch.cjs")).apply({
        dir: path.join(f.root, "generation"), version: "owned-E4-next", core: null,
      });
    } else {
      config.configFile = path.join(f.root, "other-owner/config/browser.json");
      if (crossing === "context") config.deskNativeContext.contextId = "22222222-2222-4222-8222-222222222222";
      const { configFile, ...fileConfig } = config;
      f.put(configFile, fileConfig);
      if (process.platform === "win32") {
        const helper = require(path.join(mcpRoot, "web-extension-credential.cjs"));
        helper.privateGeneration(path.dirname(path.dirname(configFile))); helper.privateGeneration(path.dirname(configFile), configFile);
      }
    }
    const crossed = f.codec.forDaemon(config, config.deskNativeContext.contextId);
    assert.equal(f.codec.takeResult(result, crossed), undefined);
    assert.throws(() => f.codec.project(snapshot, crossed, { stage: "command", requestId: 37 }),
      { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
  });
}

for (const [name, extension, text] of [
  ["INI", ".ini", "browser.browserName=chromium\n# deskNativeContext is data, not presence\n"],
  ["BOM JSON", ".json", '\ufeff{"browser":{"browserName":"chromium"},"note":"deskNativeContext"}'],
  ["JSON", ".json", '{"browser":{"browserName":"chromium"}}'],
]) {
  test(`actual child stock ${name} action remains native-free and publishes maintained readiness`, async t => {
    const f = await stagedTransport(t), file = path.join(f.root, "stock" + extension);
    f.put(file, text); fs.chmodSync(file, 0o644);
    const configInterface = maintainedConfigInterface(f), daemon = transformedDaemon(f), messages = [], loads = [];
    t.after(() => daemon.close());
    const core = fs.readFileSync(path.join(f.lib, "coreBundle.js"), "utf8");
    const start = core.indexOf("function decorateProgram3(program4) {");
    const source = core.slice(start, core.indexOf("\nfunction defaultConfigFile(", start));
    let action;
    const program = { argument() { return this; }, option() { return this; }, action(callback) { action = callback; return this; } };
    const decorate = vm.runInNewContext(source + "\ndecorateProgram3", {
      require: name => { loads.push(name); throw Error("stock native import refused"); },
      process: f.proc, numberParser: Number, setupExitWatchdog() {}, createClientInfo: () => f.clientInfo,
      deskNativeConfigPresent: configInterface.tools.deskNativeConfigPresent,
      resolveCLIConfigForCLI: async (_dir, _session, options) => configInterface.loadConfig(options.config),
      guessClientName: () => "owned stock fixture",
      createBrowserWithInfo: async () => ({ browser: { contexts: () => [daemon.browserContext] }, browserInfo: { browserName: "chromium" } }),
      startCliDaemonServer: daemon.start,
      console: { log: value => messages.push(value) },
      gracefullyProcessExitDoNotHang: () => assert.fail("supported stock config must not fail"),
    });
    decorate(program); await action(A, { config: file });
    assert.deepEqual(loads, []); assert.equal(messages.length, 1);
    assert.match(messages[0], /^Daemon listening on /);
    assert.equal(daemon.published.deskNativeErrorTransport, undefined);
    assert.equal(f.output.length, 0);
  });
}
