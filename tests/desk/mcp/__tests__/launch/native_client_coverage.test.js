import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import Module, { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { different } from "../_file_identity.js";

const require = createRequire(import.meta.url);
const filename = path.resolve(import.meta.dirname, "../../../../../plugins/desk/mcp/web-native-messaging.cjs");
require(filename); // Actual canonical CJS load, including ordinary NYC ownership.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SOURCE = "b".repeat(64), EXT = "c".repeat(32), CAP = "a".repeat(64);
const endpoint = "http://127.0.0.1:38123/provider/" + CAP;
const json = value => JSON.parse(JSON.stringify(value));
const chain = [
  { pid: 300, parentPid: 200, startIdentity: "runtime", owner: "owned", executable: "/owned/node" },
  { pid: 200, parentPid: 100, startIdentity: "entry", owner: "owned", executable: "/owned/entry" },
  { pid: 100, parentPid: 1, startIdentity: "browser", owner: "owned", executable: "/owned/browser" },
];
function record() {
  return { version: 1, contextId: A, label: "Owned fixture", channel: "msedge", userDataDir: "/owned/profile",
    profileDirName: "Default", nativeReadyFile: "/owned/state/ready.json", extensionId: EXT, sourceDigest: SOURCE };
}
function ready() {
  return { version: 1, generation: B, profileRoot: "/owned/profile/Default", extensionId: EXT,
    sourceDigest: SOURCE, chain: json(chain), browser: json(chain[2]), endpoint };
}
function selection(r = record()) { return { ...r, browserExecutable: "/owned/browser" }; }

// Standard Node CJS loading retains the installed NYC extension transform.
// The complete unchanged source is evaluated with resource-only fs/http/OS
// boundaries. No instrumenter, counter, source position or source text edits.
function load(resources = {}, nativeContext = false) {
  const diagnostics = [], stderr = [], timers = new Map();
  let timerId = 0;
  const proc = { platform: "linux", env: {}, getuid: () => process.getuid?.() ?? 42,
    stdout: { write() { assert.fail("native/binary stdout must not be a diagnostic sink"); } },
    stderr: { write(value) { stderr.push(value); return true; } }, ...resources.process };
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module.require = name => {
    if (name === "./web-extension-credential.cjs") return {
      protect(sink, value) { diagnostics.push({ sink, value }); },
    }; // E's already-qualified diagnostic hook is out of this test's scope.
    if (name === "path") return path.posix; // Portable in-memory fs; win32 policy still uses path.win32.
    return Object.hasOwn(resources, name) ? resources[name] : require(name);
  };
  if (!nativeContext) module._compile = (source, file) => {
    const wrapper = vm.runInNewContext(Module.wrap(source), { process: proc, Buffer,
      __coverage__: global.__coverage__,
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    }, { filename: file });
    wrapper.call(module.exports, module.exports, module.require, module, file, path.dirname(file));
  };
  (Module._extensions[".cjs"] || Module._extensions[".js"])(module, filename);
  return { client: module.exports, diagnostics, stderr, timers };
}

function privateFs(initial = ready()) {
  const state = { value: initial, bytes: null, ino: 2n, open: new Set(), closed: [], stats: 0,
    symlink: false, directory: false, mode: 0o600, nlink: 1, uid: process.getuid?.() ?? 42 };
  let onStat, onRead, onOpen;
  const io = {
    lstatSync(file, options) {
      state.stats++;
      const directory = file !== "/owned/state/ready.json";
      const stat = { dev: 1n, ino: directory ? 1n : state.ino, size: BigInt(state.bytes?.length ?? Buffer.byteLength(JSON.stringify(state.value))),
        uid: options?.bigint ? BigInt(state.uid) : state.uid, mode: directory ? 0o700 : state.mode,
        nlink: options?.bigint ? BigInt(state.nlink) : state.nlink, ctimeNs: 10n, mtimeNs: 20n,
        isDirectory: () => (directory || state.directory) && !state.symlink,
        isFile: () => !directory && !state.directory && !state.symlink,
        isSymbolicLink: () => state.symlink };
      return onStat?.(file, options, stat) || stat;
    },
    openSync(file, flags) {
      assert.equal(file, "/owned/state/ready.json"); assert.equal(flags, "r");
      onOpen?.(); state.open.add(91); return 91;
    },
    fstatSync(fd) {
      assert.equal(state.open.has(fd), true);
      return { dev: 1n, ino: state.ino, size: BigInt(state.bytes?.length ?? Buffer.byteLength(JSON.stringify(state.value))) };
    },
    readFileSync(fd) { assert.equal(state.open.has(fd), true); return onRead?.() || state.bytes || Buffer.from(JSON.stringify(state.value)); },
    closeSync(fd) { assert.equal(state.open.delete(fd), true); state.closed.push(fd); },
  };
  return { io, state, onStat(fn) { onStat = fn; }, onRead(fn) { onRead = fn; }, onOpen(fn) { onOpen = fn; } };
}

function transport(reply) {
  const requests = [], destroyed = { request: 0, response: 0 };
  let onEnd = reply;
  const io = { request(options, callback) {
    const request = new EventEmitter();
    request.destroy = () => { destroyed.request++; };
    request.end = data => {
      const payload = JSON.parse(data); requests.push({ options, payload, bytes: Buffer.byteLength(data) });
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200; response.destroy = () => { destroyed.response++; };
        const send = (value, status = 200) => {
          response.statusCode = status; callback(response);
          response.emit("data", Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
          response.emit("end");
        };
        onEnd({ request, response, callback, payload, send });
      });
    };
    return request;
  } };
  return { io, requests, destroyed, reply(fn) { onEnd = fn; } };
}

test("native record validation rejects every malformed field without changing its valid caller record", () => {
  const { client } = load();
  const good = record(); assert.equal(client.validateNativeRecord(good), good);
  for (const patch of [
    { version: 2 }, { contextId: 3 }, { contextId: "bad" }, { label: 3 }, { label: " " }, { label: "x".repeat(121) },
    { label: "secret\n" }, { channel: "other" }, { userDataDir: "relative" }, { nativeReadyFile: null },
    { profileDirName: null }, { profileDirName: "" }, { profileDirName: "." }, { profileDirName: ".." },
    { profileDirName: "a/b" }, { profileDirName: "a\\b" }, { extensionId: 3 }, { extensionId: "z".repeat(32) },
    { sourceDigest: 3 }, { sourceDigest: "wrong" },
  ]) assert.throws(() => client.validateNativeRecord({ ...good, ...patch }), { code: "NATIVE_CONFIG_INVALID" });
  for (const value of [null, [], false, {}, { ...good, extra: 1 }, { ...good, extra: 1, label: undefined }]) {
    if (value && value.extra && value.label === undefined) delete value.label;
    assert.throws(() => client.validateNativeRecord(value), { code: "NATIVE_CONFIG_INVALID" });
  }
});

test("resource projection preserves topology, bounds depth/text and never exposes URLs or capability-like digests", () => {
  const { client } = load();
  assert.equal(client.safeCode("native_discard_incomplete", "fallback"), "native_discard_incomplete");
  assert.equal(client.safeCode("private-unknown", "fallback"), "fallback");
  assert.equal(client.safeResources("https://private.invalid/path " + CAP + "\n"), "<redacted-url> <redacted> ");
  assert.equal(client.safeResources("x".repeat(5000)).length, 4096);
  assert.equal(client.safeResources(undefined), undefined);
  assert.equal(client.safeResources(Symbol("unknown")), undefined);
  assert.equal(client.safeResources(NaN), undefined);
  assert.deepEqual(json(client.safeResources({ ids: [1, null, true], closedTabIds: [7] })), { ids: [1, null, true], closedTabIds: [7] });
  let nested = { remainingTabIds: [8] };
  for (let i = 0; i < 18; i++) nested = { native: nested };
  assert.ok(JSON.stringify(client.safeResources(nested)).includes("<bounded>"));
});

test("private path policies exercise macOS ACL and the fixed Windows readonly worker boundary", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const env of platform === "win32" ? [{ SystemRoot: "C:\\Windows" }, { SYSTEMROOT: "C:\\Windows" },
      { windir: "C:\\Windows" }, { WINDIR: "C:\\Windows" }] : [{}]) {
      const f = privateFs(), calls = [];
      const { client } = load({ fs: f.io, process: { platform, env },
        "./web-native-private-path.cjs": { verify(entries, root) {
          calls.push({ entries, root });
          assert.equal(root, "C:\\Windows");
          assert.deepEqual(json(entries), [{ file: "/owned/state/ready.json", directory: false }]);
        } },
        child_process: { execFileSync(executable, args, options) {
          calls.push({ executable, args, options });
          assert.equal(executable, "/bin/ls"); return "owned regular file";
        } } });
      client.privatePath("/owned/state/ready.json", false);
      assert.equal(calls.length, platform === "linux" ? 0 : 1);
      f.state.mode = 0o644;
      client.privatePath("/owned/state/ready.json", false, false);
    }
  }
  for (const mode of ["link", "directory", "nlink", "owner", "mode", "mac-acl", "win-env", "win-relative", "win-acl", "missing", "os-error"]) {
    const f = privateFs();
    if (mode === "link") f.state.symlink = true;
    if (mode === "directory") f.state.directory = true;
    if (mode === "nlink") f.state.nlink = 2;
    if (mode === "owner") f.state.uid++;
    if (mode === "mode") f.state.mode = 0o644;
    if (mode === "missing" || mode === "os-error") f.onStat(() => { throw Object.assign(Error("private path"), { code: mode === "missing" ? "ENOENT" : "EACCES" }); });
    const { client } = load({ fs: f.io, process: { platform: mode === "mac-acl" ? "darwin" : mode.startsWith("win-") ? "win32" : "linux",
      env: mode === "win-env" ? {} : { SystemRoot: mode === "win-relative" ? "relative" : "C:\\Windows" } },
      "./web-native-private-path.cjs": { verify() { throw Error("private worker refusal"); } },
      child_process: { execFileSync: () => mode === "mac-acl" ? " 0: user allow read" : "not private" } });
    assert.throws(() => client.privatePath("/owned/state/ready.json", false), { code: mode === "missing" ? "ENOENT" : "NATIVE_PRIVATE_PATH_INVALID" }, mode);
  }
  const f = privateFs(), { client } = load({ fs: f.io, process: { getuid: undefined } });
  assert.doesNotThrow(() => client.privatePath("/owned", true));
  assert.throws(() => client.privatePath("/owned/state/ready.json", true), { code: "NATIVE_PRIVATE_PATH_INVALID" });
});

test("Windows private batch checks typed paths in one read-only policy operation before JSON opens", () => {
  const f = privateFs(), events = [];
  f.onStat((file, options) => { if (options?.bigint) events.push(["stat", file]); });
  f.onOpen(() => events.push(["open"]));
  const { client } = load({ fs: f.io, process: { platform: "win32", env: { SystemRoot: "C:\\Windows" } },
    "./web-native-private-path.cjs": { verify(entries, root) {
      events.push(["policy", json(entries)]);
      assert.equal(root, "C:\\Windows");
    } } });
  const entries = [{ file: "/owned/state", directory: true }, { file: "/owned/state/ready.json", directory: false }];
  const stats = client.privatePaths(entries);
  assert.equal(stats.length, 2);
  assert.deepEqual(events, [["stat", entries[0].file], ["stat", entries[1].file], ["policy", entries],
    ["stat", entries[0].file], ["stat", entries[1].file]]);
  events.length = 0;
  assert.equal(client.readPrivateJson(entries[1].file).version, 1);
  assert.equal(events.filter(event => event[0] === "policy").length, 1);
  assert.deepEqual(events.find(event => event[0] === "policy")[1], entries);
  assert.ok(events.findIndex(event => event[0] === "open") > events.findIndex(event => event[0] === "policy"));
  f.state.mode = 0o644;
  assert.equal(typeof client.privatePath(entries[1].file, false).nlink, "number");
  events.length = 0;
  client.privatePath(entries[1].file, false, false);
  assert.equal(events.some(event => event[0] === "policy"), false);
});

test("Windows private batch refuses every pre/post identity or metadata change and never caches policy", () => {
  const entries = [{ file: "/owned/state", directory: true }, { file: "/owned/state/ready.json", directory: false }];
  for (const file of entries.map(entry => entry.file)) {
    for (const field of ["dev", "ino", "size", "ctimeNs", "mtimeNs"]) {
      const f = privateFs();
      let policyRan = false;
      f.onStat((name, options, stat) => name === file && options?.bigint && policyRan
        ? { ...stat, [field]: different(stat[field]) } : stat);
      const { client } = load({ fs: f.io, process: { platform: "win32", env: { SystemRoot: "C:\\Windows" } },
        "./web-native-private-path.cjs": { verify() { policyRan = true; } } });
      assert.throws(() => client.privatePaths(entries), { code: "NATIVE_PRIVATE_PATH_INVALID" }, `${file}:${field}`);
    }
  }
  for (const phase of ["before", "after"]) {
    for (const mode of ["link", "kind", "nlink", "uid", "missing", "denied"]) {
      const f = privateFs();
      let policyRan = false;
      f.onStat((name, options, stat) => {
        if (!options?.bigint || (phase === "after") !== policyRan || name !== entries[1].file) return stat;
        if (mode === "missing" || mode === "denied")
          throw Object.assign(Error("private"), { code: mode === "missing" ? "ENOENT" : "EACCES" });
        return { ...stat, ...(mode === "link" ? { isSymbolicLink: () => true } :
          mode === "kind" ? { isFile: () => false } : mode === "nlink" ? { nlink: 2n } : { uid: stat.uid + 1n }) };
      });
      const { client } = load({ fs: f.io, process: { platform: "win32", env: { SystemRoot: "C:\\Windows" } },
        "./web-native-private-path.cjs": { verify() { policyRan = true; } } });
      assert.throws(() => client.privatePaths(entries),
        { code: mode === "missing" ? "ENOENT" : "NATIVE_PRIVATE_PATH_INVALID" }, `${phase}:${mode}`);
    }
  }
  const f = privateFs();
  let calls = 0;
  const { client } = load({ fs: f.io, process: { platform: "win32", getuid: undefined,
    env: { SystemRoot: "C:\\Windows" } }, "./web-native-private-path.cjs": { verify() { if (++calls !== 1) throw Error("refused"); } } });
  client.privatePaths(entries);
  assert.throws(() => client.privatePaths(entries), { code: "NATIVE_PRIVATE_PATH_INVALID" });
});

test("private batch validates requests, preserves native errors and reuses non-Windows policies", () => {
  const f = privateFs(), { client } = load({ fs: f.io });
  for (const entries of [null, {}, [null], [{}], [{ file: 1, directory: true }],
    [{ file: "", directory: false }], [{ file: "/owned", directory: 1 }]])
    assert.throws(() => client.privatePaths(entries), { code: "NATIVE_PRIVATE_PATH_INVALID" });
  assert.equal(client.privatePaths([]).length, 0);
  assert.equal(client.privatePaths([{ file: "/owned", directory: true }]).length, 1);
  for (const env of [{}, { SystemRoot: "relative" }]) {
    const win = load({ fs: f.io, process: { platform: "win32", env } });
    assert.throws(() => win.client.privatePaths([{ file: "/owned", directory: true }]), { code: "NATIVE_PRIVATE_PATH_INVALID" });
  }
  const win = load({ fs: f.io, process: { platform: "win32", env: { SystemRoot: "C:\\Windows" } },
    "./web-native-private-path.cjs": { verify() { throw Object.assign(Error("policy failed"), { code: "EACCES" }); } } });
  assert.equal(win.client.privatePaths([]).length, 0);
  assert.throws(() => win.client.privatePaths([{ file: "/owned", directory: true }]), { code: "NATIVE_PRIVATE_PATH_INVALID" });
});

test("private JSON requires a complete owned tree, bounded UTF8 object and stable open/name identities", () => {
  const f = privateFs(), { client } = load({ fs: f.io });
  assert.equal(client.fileIdentity("/owned/state/ready.json"), "1:2");
  assert.equal(client.readPrivateJson("/owned/state/ready.json").version, 1);
  assert.equal(client.readPrivateJson("/owned/state/ready.json", { anchor: "/owned" }).version, 1);
  for (const [file, anchor] of [["relative", "/owned"], ["/owned/state/ready.json", "relative"], ["/peer", "/owned"], ["/owned2/peer", "/owned"]])
    assert.throws(() => client.ownedTree(file, anchor), { code: "NATIVE_PRIVATE_PATH_INVALID" });
  for (const mode of ["inode-open", "large-open", "large-read", "utf8", "json", "array", "renamed", "read-error", "open-error"]) {
    const f = privateFs(), { client } = load({ fs: f.io });
    if (mode === "inode-open") f.onOpen(() => { f.state.ino = different(f.state.ino); });
    if (mode === "large-open") f.state.bytes = Buffer.alloc(65537);
    if (mode === "large-read") f.onRead(() => Buffer.alloc(65537));
    if (mode === "utf8") f.state.bytes = Buffer.from([255]);
    if (mode === "json") f.state.bytes = Buffer.from("{private");
    if (mode === "array") f.state.value = [];
    if (mode === "renamed") f.onRead(() => { const bytes = Buffer.from(JSON.stringify(f.state.value)); f.state.ino = different(f.state.ino); return bytes; });
    if (mode === "read-error") f.onRead(() => { throw Error("private bytes"); });
    if (mode === "open-error") f.onOpen(() => { throw Error("private path"); });
    assert.throws(() => client.readPrivateJson("/owned/state/ready.json", { maxBytes: 65536 }),
      { code: ["inode-open", "large-open", "array", "renamed"].includes(mode) ? "NATIVE_PRIVATE_STATE_CHANGED" : "NATIVE_PRIVATE_STATE_INVALID" }, mode);
    assert.equal(f.state.open.size, 0, mode);
  }
});

test("provider input boundaries reject endpoints, deadlines, operations and unencodable/oversized payloads before IO", async () => {
  const { client } = load({ http: { request() { assert.fail("invalid request reached IO"); } } });
  for (const value of [null, "", "http://localhost:1/provider/" + CAP, "http://127.0.0.1:65536/provider/" + CAP,
    "http://127.0.0.1:01/provider/" + CAP, endpoint + "?extra"]) {
    assert.throws(() => client.endpointParts(value), { code: "NATIVE_PROVIDER_ENDPOINT_INVALID" });
  }
  assert.equal(client.endpointParts(endpoint).port, 38123);
  for (const timeoutMs of [-1, 1.5, 60001, Infinity])
    await assert.rejects(client.providerRequest(endpoint, "attest", {}, { timeoutMs }), { code: "NATIVE_REQUEST_INVALID" });
  for (const [operation, payload] of [["unknown", {}], ["attest", null], ["attest", []]])
    await assert.rejects(client.providerRequest(endpoint, operation, payload), { code: "NATIVE_REQUEST_INVALID" });
  const circular = {}; circular.self = circular;
  await assert.rejects(client.providerRequest(endpoint, "attest", circular), { code: "NATIVE_REQUEST_INVALID" });
  await assert.rejects(client.providerRequest(endpoint, "attest", { big: "x".repeat(1048576) }), { code: "NATIVE_REQUEST_TOO_LARGE" });
});

test("HTTP response arms reject ambiguity, malformed UTF8/JSON, schema drift and non-200 success", async () => {
  const cases = [
    Buffer.from([255]), Buffer.from("{"), [], null, { ok: "yes" }, { ok: true, result: {}, extra: true },
    { ok: true }, { ok: true, result: {}, error: {} }, { ok: false, result: {}, error: { code: "NATIVE_REQUEST_FAILED" } },
    { ok: false }, { ok: false, error: [] }, { ok: false, error: { code: 7 } },
  ];
  for (const response of cases) {
    const http = transport(({ send }) => send(response)), f = load({ http: http.io });
    await assert.rejects(f.client.providerRequest(endpoint, "dispatch", { contextId: A, method: "context.discard" }),
      error => error.code === "NATIVE_PROVIDER_RESPONSE_INVALID" && error.resources.contextId === A &&
        error.resources.method === "context.discard" && error.resources.disposition === "unknown");
    assert.equal(f.timers.size, 0);
  }
  const http = transport(({ send }) => send({ ok: true, result: {} }, 503));
  await assert.rejects(load({ http: http.io }).client.providerRequest(endpoint, "attest", {}), { code: "NATIVE_PROVIDER_RESPONSE_INVALID" });
});

test("HTTP actual error codes/resources, completion, diagnostics and duplicated late events remain bounded", async () => {
  const resources = { closedTabIds: [7], remainingTabIds: [8], nested: { url: "https://private.invalid/a", token: CAP } };
  const http = transport(({ send }) => send({ ok: false, error: { code: "native_discard_incomplete", resources } }, 409));
  const f = load({ http: http.io });
  await assert.rejects(f.client.providerRequest(endpoint, "dispatch", { contextId: A, method: "context.discard" }), error => {
    assert.equal(error.code, "native_discard_incomplete");
    assert.deepEqual(json(error.resources), { closedTabIds: [7], remainingTabIds: [8], nested: { url: "<redacted-url>", token: "<redacted>" } });
    return true;
  });
  assert.equal(f.diagnostics.length, 2);
  f.diagnostics[0].sink.stdout.write("owned diagnostic");
  assert.deepEqual(f.stderr, ["owned diagnostic"]);
  http.reply(({ send }) => send({ ok: false, error: { code: "raw-secret-code", resources: { remainingTabIds: [8] } } }));
  await assert.rejects(f.client.providerRequest(endpoint, "attest", {}), { code: "NATIVE_PROVIDER_REQUEST_FAILED" });
  http.reply(({ send, response, request }) => {
    send({ ok: true, result: { available: true } });
    response.emit("end"); response.emit("error", Error("late")); request.emit("error", Error("late"));
  });
  assert.deepEqual(json(await f.client.providerRequest(endpoint, "attest", {})), { available: true });
  assert.equal(f.timers.size, 0);
  assert.deepEqual(http.destroyed, { request: 2, response: 2 },
    "late events cannot destroy again after either successful or failed settlement");
  const sent = http.requests.at(-1);
  assert.equal(sent.options.headers["content-length"], sent.bytes);
  assert.equal(sent.options.method, "POST");
  assert.equal(sent.options.hostname, "127.0.0.1");
  assert.equal(sent.options.port, 38123);
  assert.equal(sent.options.path, "/provider/" + CAP);
});

test("dispatch unknown-effect projection never invents context or method routing from invalid or absent values", async () => {
  for (const [payload, expected] of [
    [{ contextId: A }, { disposition: "unknown", operation: "dispatch", contextId: A }],
    [{ contextId: A, method: "context.foreign" }, { disposition: "unknown", operation: "dispatch", contextId: A }],
    [{ contextId: 7, method: "context.create" }, { disposition: "unknown", operation: "dispatch" }],
    [{ contextId: "not-a-uuid", method: "context.create" }, { disposition: "unknown", operation: "dispatch" }],
  ]) {
    const http = transport(({ request }) => request.emit("error", Error("owned disconnect")));
    const f = load({ http: http.io });
    await assert.rejects(f.client.providerRequest(endpoint, "dispatch", payload), error => {
      assert.equal(error.code, "NATIVE_PROVIDER_DISCONNECTED");
      assert.deepEqual(json(error.resources), expected); return true;
    });
    assert.equal(f.timers.size, 0);
  }
});

for (const fault of ["request-error", "response-error", "aborted", "oversized", "throw", "timeout"]) {
  test(`HTTP ${fault} preserves explicit unknown effects and closes only its owned transport`, async () => {
    const http = transport(({ request, response, callback }) => {
      if (fault === "request-error") { request.emit("error", Error("private")); return; }
      callback(response);
      if (fault === "response-error") response.emit("error", Error("private"));
      if (fault === "aborted") response.emit("aborted");
      if (fault === "oversized") { response.emit("data", Buffer.alloc(1048577)); response.emit("end"); }
    });
    if (fault === "throw") http.io.request = () => { throw Error("private connect failure"); };
    const f = load({ http: http.io });
    const result = f.client.providerRequest(endpoint, "dispatch", { contextId: A, method: "context.status" }, { timeoutMs: 5 });
    if (fault === "timeout") {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.timers.size, 1);
      [...f.timers.values()][0].callback();
    }
    await assert.rejects(result, error => {
      assert.equal(error.code, fault === "timeout" ? "NATIVE_PROVIDER_TIMEOUT" :
        fault === "oversized" ? "NATIVE_PROVIDER_RESPONSE_TOO_LARGE" : "NATIVE_PROVIDER_DISCONNECTED");
      assert.deepEqual(json(error.resources), { disposition: "unknown", operation: "dispatch", contextId: A, method: "context.status" });
      assert.doesNotMatch(error.message, /private/); return true;
    });
    assert.equal(f.timers.size, 0);
    assert.deepEqual(http.destroyed, { request: fault === "throw" ? 0 : 1,
      response: ["throw", "request-error"].includes(fault) ? 0 : 1 });
  });
}

function attestation(t, options = {}) {
  const disk = privateFs(), exchanges = [], readonlyCalls = [], http = transport(({ payload, send }) => {
    exchanges.push(payload);
    if (options.respond) return options.respond({ payload, send, disk });
    const r = disk.state.value;
    send({ ok: true, result: payload.operation === "attest" ? { healthy: true, generation: r.generation,
      profileRoot: r.profileRoot, extensionId: r.extensionId, sourceDigest: r.sourceDigest, chain: r.chain } :
      payload.operation === "prepareUpdate" ? { ticket: "d".repeat(64), expiresAt: 123 } : { retained: true } });
  });
  const loaded = load({ fs: disk.io, http: http.io, child_process: {
    execFileSync(command) {
      assert.equal(command, "/bin/ls");
      return "owned regular node";
    },
  }, "./web-native-private-path.cjs": {
    verify(entries, root) {
      assert.ok(path.win32.isAbsolute(root));
      assert.deepEqual(json(entries), [{ file: "/owned/state", directory: true },
        { file: "/owned/state/ready.json", directory: false }]);
      readonlyCalls.push(json(entries));
    },
  } }, options.nativeContext);
  t.after(() => { assert.equal(disk.state.open.size, 0); assert.equal(loaded.timers.size, 0); });
  return { ...loaded, disk, http, exchanges, readonlyCalls, dependencies: { readAncestry: async () => json(disk.state.value.chain) } };
}

test("attested client freezes caller selection, fences every operation and uses update tickets only after a valid prepare", async t => {
  const f = attestation(t), input = record(), selected = selection(input);
  const client = await f.client.attestNativeContext(input, selected, f.dependencies);
  input.contextId = B; input.nativeReadyFile = "/peer/ready.json"; input.sourceDigest = "f".repeat(64);
  input.profileDirName = "Foreign"; selected.profileDirName = "Foreign"; selected.browserExecutable = "/foreign/browser";
  assert.equal(client.contextId, A);
  assert.throws(() => client.withUpdateTicket(() => {}), { code: "NATIVE_UPDATE_TICKET_INVALID" });
  for (const method of ["context.create", "context.resume", "context.status", "context.label", "context.discard"]) {
    await client.request(method, null);
    const request = f.exchanges.at(-1);
    assert.equal(request.operation, "dispatch"); assert.equal(request.payload.contextId, A);
    assert.deepEqual(json(request.payload.params), {});
  }
  await assert.rejects(client.request("profile.read"), { code: "NATIVE_REQUEST_INVALID" });
  await assert.rejects(client.request(), { code: "NATIVE_REQUEST_INVALID" });
  assert.deepEqual(json(await client.prepareUpdate()), { quiescent: true });
  assert.equal(client.withUpdateTicket(ticket => ticket), "d".repeat(64));
  assert.throws(() => client.withUpdateTicket(null), { code: "NATIVE_UPDATE_TICKET_INVALID" });
  await client.reload(); assert.equal(f.exchanges.at(-1).payload.ticket, "d".repeat(64));
  await client.commit(); assert.equal(f.exchanges.at(-1).operation, "commit");
  assert.deepEqual(json(await client.cancelUpdate()), { cancelled: true });
  assert.throws(() => client.withUpdateTicket(() => {}), { code: "NATIVE_UPDATE_TICKET_INVALID" });
  f.disk.state.ino = different(f.disk.state.ino);
  const before = f.exchanges.length;
  for (const action of [() => client.request("context.status"), () => client.prepareUpdate(), () => client.cancelUpdate(),
    () => client.reload(), () => client.commit()])
    await assert.rejects(action(), { code: "NATIVE_READY_CHANGED" });
  assert.equal(f.exchanges.length, before, "no dispatch/update after the ready inode changes");
  f.disk.state.value.generation = A;
  assert.deepEqual(json(await client.refresh()), { available: true, contextId: A });
  await client.request("context.status", { label: "owned" });
  assert.deepEqual(json(f.exchanges.at(-1).payload.params), { label: "owned" });
});

test("attestation validates profile, source, process generation and every remote corroboration field", async t => {
  for (const field of ["version", "generation", "missing-generation", "profileRoot", "extensionId", "sourceDigest", "chain", "browser", "executable"]) {
    const f = attestation(t), r = f.disk.state.value;
    if (field === "version") r.version = 2;
    else if (field === "missing-generation") delete r.generation;
    else if (field === "chain") r.chain = [];
    else if (field === "browser") r.browser = null;
    else if (field === "executable") { r.browser.executable = "/foreign/browser"; r.chain[2] = r.browser; }
    else r[field] = "wrong";
    await assert.rejects(f.client.attestNativeContext(record(), selection(), f.dependencies), { code: "NATIVE_READY_INVALID" }, field);
    assert.equal(f.exchanges.length, 0);
  }
  for (const value of [undefined, [], { ...selection(), profileDirName: "Foreign" }])
    await assert.rejects(attestation(t).client.attestNativeContext(record(), value), { code: "NATIVE_SELECTION_MISMATCH" });
  for (const current of [null, [], chain.slice(0, 2), chain.map(p => ({ ...p, owner: "foreign" }))]) {
    const f = attestation(t);
    await assert.rejects(f.client.attestNativeContext(record(), selection(), { readAncestry: async () => current }),
      { code: "NATIVE_ANCESTRY_MISMATCH" });
  }
  for (const field of ["null", "healthy", "generation", "profileRoot", "extensionId", "sourceDigest", "chain"]) {
    const f = attestation(t, { respond({ payload, send, disk }) {
      const r = disk.state.value, result = { healthy: true, generation: r.generation, profileRoot: r.profileRoot,
        extensionId: r.extensionId, sourceDigest: r.sourceDigest, chain: r.chain };
      result[field] = "wrong"; send({ ok: true, result: field === "null" ? null : result });
    } });
    await assert.rejects(f.client.attestNativeContext(record(), selection(), f.dependencies), { code: "NATIVE_ATTESTATION_MISMATCH" }, field);
  }
});

test("attestation refresh refuses changed browser custody and rechecks inode after provider attestation", async t => {
  const f = attestation(t), client = await f.client.attestNativeContext(record(), selection(), f.dependencies);
  f.disk.state.value.browser.startIdentity = "replaced";
  f.disk.state.value.chain[2].startIdentity = "replaced";
  await assert.rejects(client.refresh(), { code: "NATIVE_SELECTION_MISMATCH" });
  const g = attestation(t, { respond({ send, disk }) {
    const r = disk.state.value;
    disk.state.ino = different(disk.state.ino);
    send({ ok: true, result: { healthy: true, generation: r.generation, profileRoot: r.profileRoot,
      extensionId: r.extensionId, sourceDigest: r.sourceDigest, chain: r.chain } });
  } });
  await assert.rejects(g.client.attestNativeContext(record(), selection(), g.dependencies), { code: "NATIVE_READY_CHANGED" });
  await assert.rejects(attestation(t).client.attestNativeContext(record(), selection(), {
    readAncestry: async () => { throw Object.assign(Error("private ancestry"), { resources: { remainingTabIds: [7] } }); },
  }), error => error.code === "NATIVE_ATTESTATION_UNAVAILABLE" && error.resources.remainingTabIds[0] === 7);
});

test("update prepare rejects malformed tickets/expiry and retains error resource fidelity for operations and refresh", async t => {
  for (const result of [null, {}, { ticket: "wrong", expiresAt: 1 }, { ticket: "d".repeat(64), expiresAt: 1.5 }]) {
    const f = attestation(t), client = await f.client.attestNativeContext(record(), selection(), f.dependencies);
    f.http.reply(({ send }) => send({ ok: true, result }));
    await assert.rejects(client.prepareUpdate(), { code: "NATIVE_PROVIDER_RESPONSE_INVALID" });
  }
  const f = attestation(t), client = await f.client.attestNativeContext(record(), selection(), f.dependencies);
  f.http.reply(({ send }) => send({ ok: false, error: { code: "native_discard_incomplete",
    resources: { remainingTabIds: [8], secret: "https://private.invalid/" + CAP } } }, 409));
  for (const action of [() => client.request("context.discard"), () => client.refresh()]) {
    await assert.rejects(action(), error => {
      assert.equal(error.code, "native_discard_incomplete");
      assert.deepEqual(json(error.resources), { remainingTabIds: [8], secret: "<redacted-url>" }); return true;
    });
  }
  f.http.io.request = () => { throw Object.assign(Error("private OS"), { code: "unknown" }); };
  await assert.rejects(client.reload(), { code: "NATIVE_PROVIDER_DISCONNECTED" });
});

test("default ancestry uses its fixed module and rejects an invalid PID before provider or host work", async t => {
  const f = attestation(t, { nativeContext: true });
  f.disk.state.value.chain[0].pid = 0;
  await assert.rejects(f.client.attestNativeContext(record(), selection()),
    error => ["NATIVE_ATTESTATION_UNAVAILABLE", "NATIVE_ANCESTRY_INVALID"].includes(error.code));
  assert.equal(f.readonlyCalls.length, process.platform === "win32" ? 1 : 0,
    "the native-context control uses the same in-memory private filesystem, not actual NTFS paths");
  assert.equal(f.exchanges.length, 0);
});
