import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs, { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkTempRoot } from '../_temp_roots.js';
import { createBrowserExtension } from '../../../../../plugins/desk/browser-extension/context-engine.mjs';
import { startNativeProvider } from '../../../../../plugins/desk/mcp/src/browser/native-provider.mjs';
import { createNativeOwnerInventory } from '../../../../../plugins/desk/mcp/src/browser/native-owner-inventory.mjs';
import { NativeCommandTransport } from '../../../../../plugins/desk/mcp/src/browser/native-transport.mjs';
import { readNativeAncestry } from '../../../../../plugins/desk/mcp/src/browser/native-host.mjs';
import { readProcessStart } from '../../../../../plugins/desk/mcp/src/readiness/process-start.js';
import { removeTree } from '../_remove_tree.js';
import { mcpRoot } from './_mcp_handshake.js';
import '../_isolated_env.mjs';

const require = createRequire(import.meta.url);
const patch = require(path.join(mcpRoot, 'web-playwright-patch.cjs'));
const fixture = readFileSync(new URL('./fixtures/playwright-server-lifecycle.cjs', import.meta.url), 'utf8');
const actualCli = process.env.DESK_TEST_MAINTAINED_CLI_DIR;
const A = '12a12345-6789-4234-8123-123456789abc';
const B = '23b12345-6789-4234-8123-123456789abc';
const NONCES = ['34c12345-6789-4234-8123-123456789abc', '45d12345-6789-4234-8123-123456789abc'];
const EXTENSION = 'a'.repeat(32), SOURCE = 'b'.repeat(64), TOKEN = 'c'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => { for (const fn of [...listeners]) fn(...args); }, listeners };
};
const put = async (file, value) => {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
};
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= end) throw Error('owned E fixture condition did not settle');
    await new Promise(resolve => setImmediate(resolve));
  }
}
function textSink(output) {
  return { write(bytes, encoding, callback) {
    output.push(Buffer.from(bytes).toString());
    if (typeof encoding === 'function') callback = encoding;
    callback?.();
    return true;
  } };
}

// These are raw WebSocket resource boundaries only. All method interpretation
// is the actual maintained Core and actual producer, not a test CDP translator.
function socketPair(onClientSend) {
  const server = new EventEmitter();
  server.readyState = 1;
  const client = { readyState: 1, onmessage: undefined, onclose: undefined };
  server.send = data => queueMicrotask(() => client.onmessage?.({ data }));
  client.send = data => {
    const deliver = () => queueMicrotask(() => server.emit('message', Buffer.from(data)));
    if (onClientSend) onClientSend(data, deliver); else deliver();
  };
  function close() {
    if (server.readyState === 3) return;
    server.readyState = 3; client.readyState = 3;
    queueMicrotask(() => { server.emit('close', 1000, Buffer.from('owned fixture closed')); client.onclose?.(); });
  }
  server.close = close; client.close = close;
  return { server, client };
}

async function integrated(t, options = {}) {
  assert.ok(actualCli, 'this source integration requires the admitted actual maintained CLI input');
  const root = await mkTempRoot('native-E-integrated-'), home = path.join(root, 'native-home');
  const generation = path.join(root, 'generation'), lib = path.join(generation, 'node_modules/playwright-core/lib');
  let codeRoot = mcpRoot, stagingPatch = patch;
  if (options.sourceClone) {
    codeRoot = path.join(root, 'normal-plugin/mcp');
    for (const name of [...require(path.join(mcpRoot, 'web-extension-credential.cjs')).nativeInventory(fs.realpathSync(mcpRoot)).map(entry => entry.path),
      'web-playwright-patch.cjs', 'web-native-relay.cjs']) {
      await fsp.mkdir(path.dirname(path.join(codeRoot, name)), { recursive: true, mode: 0o755 });
      await fsp.copyFile(path.join(mcpRoot, name), path.join(codeRoot, name));
    }
    stagingPatch = require(path.join(codeRoot, 'web-playwright-patch.cjs'));
  }
  const osUserInfo = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...osUserInfo, homedir: home }));
  await put(path.join(lib, 'coreBundle.js'), fixture);
  stagingPatch.apply({ dir: generation, version: 'owned-E-fixture', core: null });
  assert.equal(stagingPatch.readRevision({ dir: generation, version: 'owned-E-fixture', core: null }), 3);
  const app = path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  const browserExecutable = process.platform === 'darwin' ? app : path.join(root, 'native-browser');
  await put(browserExecutable, 'owned file-observation fixture; never executed');
  const chain = [
    { pid: 800003, parentPid: 800002, startIdentity: 'E-runtime-generation', owner: String(process.getuid?.() ?? 'fixture'), executable: path.join(root, 'node') },
    { pid: 800002, parentPid: 800001, startIdentity: 'E-entry-generation', owner: String(process.getuid?.() ?? 'fixture'), executable: path.join(root, 'entry') },
    { pid: 800001, parentPid: 1, startIdentity: 'E-browser-generation', owner: String(process.getuid?.() ?? 'fixture'), executable: browserExecutable },
  ];
  const reader = async pid => structuredClone(chain.find(p => p.pid === pid));
  const config = { version: 1, extensionId: EXTENSION, extensionOrigin: `chrome-extension://${EXTENSION}/`,
    extensionSourceDigest: SOURCE, runtimeExecutable: chain[0].executable, entryExecutable: chain[1].executable,
    browserExecutable, expectedBrowser: chain[2], channel: 'msedge', userDataDir: path.join(root, 'profile'),
    profileDirName: 'Default', profileRoot: path.join(root, 'profile/Default'), pluginDirs: [path.join(root, 'plugin')],
    nativeReadyFile: path.join(root, 'state/ready.json'), browserStateRoot: path.join(root, 'browser'), cliDir: actualCli };
  const selection = { channel: config.channel, userDataDir: config.userDataDir, profileDirName: 'Default',
    nativeReadyFile: config.nativeReadyFile, extensionId: EXTENSION, sourceDigest: SOURCE };
  await fsp.mkdir(path.join(config.browserStateRoot, 'signed-in'), { recursive: true, mode: 0o700 });
  const inventory = createNativeOwnerInventory({ browserStateRoot: config.browserStateRoot, cliDir: actualCli, binding: selection });
  const records = new Map();
  for (const contextId of [A, B]) {
    const directory = inventory.layout(contextId).directory;
    for (const name of ['.playwright', 'home', 'config', 'cache', 'data', 'state', 'runtime', 'local', 'roaming'])
      await fsp.mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
    const record = { version: 1, contextId, label: 'owned E fixture', ...selection };
    records.set(contextId, record);
    await put(path.join(directory, '.desk-context-owner'), { contextId, directory });
    await put(path.join(directory, 'config/browser.json'), { extension: true, browser: { userDataDir: config.userDataDir }, deskNativeContext: record });
  }
  const output = [], binary = [], coreProc = { platform: process.platform, pid: process.pid, getuid: process.getuid?.bind(process),
    env: { ...process.env, HOME: path.join(root, 'isolated-cli-home'), PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'stock-must-not-be-used' },
    stdout: textSink(output), stderr: textSink(output), nextTick: process.nextTick.bind(process) };
  const nativeProc = { ...coreProc, stdout: { write: bytes => { binary.push(Buffer.from(bytes)); return true; } } };
  const binaryWrite = nativeProc.stdout.write;
  const realFs = Object.create(fs), normalDiscovery = require(path.join(mcpRoot, 'web-browser-discovery.cjs'));
  const systemCandidates = normalDiscovery.browserPaths('msedge', process.platform, process.env);
  realFs.existsSync = file => systemCandidates.includes(String(file)) ? process.platform === 'darwin' ? false : true : fs.existsSync(file);
  realFs.realpathSync = file => systemCandidates.includes(String(file)) && process.platform !== 'darwin' ? browserExecutable : fs.realpathSync(file);
  const vmRequire = name => {
    if (name === 'fs') return realFs;
    if (name === path.join(codeRoot, 'web-native-messaging.cjs')) return cClient;
    return require(name);
  };
  const cModule = { exports: {} };
  const sourceRequire = createRequire(path.join(codeRoot, 'web-native-messaging.cjs'));
  const pendingHttp = new Set(), realHttp = sourceRequire('http');
  const listeners = new Set(), sockets = new Set(), createServer = realHttp.createServer;
  t.mock.method(realHttp, 'createServer', function (...args) {
    const server = createServer.apply(this, args);
    listeners.add(server);
    server.once('close', () => listeners.delete(server));
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    return server;
  });
  const observedHttp = Object.create(realHttp);
  observedHttp.request = function (...args) {
    const request = realHttp.request(...args);
    pendingHttp.add(request);
    request.once('close', () => pendingHttp.delete(request));
    return request;
  };
  runInNewContext(readFileSync(path.join(codeRoot, 'web-native-messaging.cjs'), 'utf8'), {
    module: cModule, require: name => name === 'http' ? observedHttp : sourceRequire(name),
    __dirname: codeRoot, process: nativeProc, Buffer, URL, setTimeout, clearTimeout,
    Function: function (parameter, body) {
      assert.equal(parameter, 'url'); assert.equal(body, 'return import(url)');
      return async url => {
        assert.equal(fileURLToPath(url), path.join(codeRoot, 'src/browser/native-host.mjs'));
        return { readNativeAncestry: pid => readNativeAncestry(pid, { processReader: reader }) };
      };
    },
  });
  const cClient = cModule.exports, credentialModule = { exports: {} };
  runInNewContext(readFileSync(path.join(lib, 'desk-extension-credential.cjs'), 'utf8'), {
    module: credentialModule, require: vmRequire, __dirname: lib, process: coreProc, Buffer, setTimeout, clearTimeout,
  });
  const credential = credentialModule.exports;
  const protectionCalls = [], originalProtect = credential.protect;
  credential.protect = function (proc, secret) { protectionCalls.push(secret); return originalProtect(proc, secret); };
  let now = 0, nextTimer = 1;
  const timers = new Map(), timeline = [], relays = [], cdpBrowsers = [];
  const setTimer = (callback, ms) => { const id = nextTimer++; timers.set(id, { callback, due: now + ms }); return id; };
  const clearTimer = id => timers.delete(id);
  const advance = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); }
  };
  const nativeModule = { exports: {} };
  runInNewContext(readFileSync(path.join(lib, 'desk-native-relay.cjs'), 'utf8'), {
    module: nativeModule, require: name => name === path.join(lib, 'desk-extension-credential.cjs') ? credential : require(name),
    __dirname: lib, process: coreProc, Buffer, setTimeout: setTimer, clearTimeout: clearTimer,
  });
  const holdInitialized = deferred(), holdAck = deferred();
  let tabCounter = 10, groupCounter = 50, creates = 0;
  const tabs = new Map([[1, { id: 1, windowId: 7, groupId: -1, active: true, url: 'manual-peer' }]]);
  const groups = new Map(), debuggerAttached = new Set(), runtimes = new Map(), pairs = [];
  const api = {
    tabs: { onCreated: event(), onRemoved: event(), onUpdated: event(), onDetached: event(),
      async get(id) { if (!tabs.has(id)) throw Error('No tab'); return { ...tabs.get(id) }; },
      async query(query) { return [...tabs.values()].filter(tab => query.groupId === undefined || tab.groupId === query.groupId).map(tab => ({ ...tab })); },
      async create(data) { const tab = { id: tabCounter++, windowId: 7, groupId: -1, active: false, ...data }; creates++; tabs.set(tab.id, tab); api.tabs.onCreated.emit({ ...tab }); return { ...tab }; },
      async group({ groupId, tabIds }) { const id = groupId ?? groupCounter++; if (!groups.has(id)) groups.set(id, { id, windowId: 7 }); for (const tabId of tabIds) { tabs.get(tabId).groupId = id; api.tabs.onUpdated.emit(tabId, { groupId: id }, { ...tabs.get(tabId) }); } return id; },
      async remove(id) { tabs.delete(id); api.tabs.onRemoved.emit(id, { windowId: 7, isWindowClosing: false }); },
      async update() { assert.fail('No focus/tab activation'); }, async ungroup() { assert.fail('No arbitrary ungroup'); } },
    tabGroups: { async get(id) { return { ...groups.get(id) }; }, async update(id, style) { Object.assign(groups.get(id), style); return { ...groups.get(id) }; } },
    windows: { async getAll() { return [{ id: 7, type: 'normal' }]; }, async create() { assert.fail('No new window'); }, async update() { assert.fail('No focus'); } },
    debugger: { onEvent: event(), onDetach: event(), async attach({ tabId }) { debuggerAttached.add(tabId); },
      async detach({ tabId }) { debuggerAttached.delete(tabId); api.debugger.onDetach.emit({ tabId }, 'target_closed'); },
      async getTargets() { return [...debuggerAttached].map(tabId => ({ tabId, attached: true })); },
      async sendCommand({ tabId }, method, params = {}) {
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: `owned-${tabId}`, type: 'page', url: 'about:blank', title: 'owned' } };
        if (method === 'Runtime.evaluate') {
          if (!runtimes.has(tabId)) runtimes.set(tabId, {});
          return { result: { type: 'string', value: runInNewContext(params.expression, runtimes.get(tabId)) } };
        }
        return {};
      } },
    runtime: { id: EXTENSION, getURL: name => `chrome-extension://${EXTENSION}/${name}`,
      async getContexts() { return [{ documentUrl: api.runtime.getURL('token.html') }]; }, async sendMessage() { return { token: TOKEN }; } },
    offscreen: { async createDocument() { assert.fail('No real token document'); } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  };
  class Socket { static OPEN = 1; }
  const engine = createBrowserExtension(api, { WebSocket: Socket, sourceDigest: SOURCE, openSocket: async endpoint => {
    const relay = relays.find(r => endpoint === r.host + r.extensionPath);
    assert.ok(relay, 'actual A connects only to the actual maintained relay endpoint');
    const pair = socketPair((data, deliver) => {
      if (JSON.parse(data).method === 'extension.initialized') {
        timeline.push('initialized-sent');
        if (options.holdInitialized) { holdInitialized.promise.then(() => { timeline.push('initialized-delivered'); deliver(); }); return; }
        timeline.push('initialized-delivered');
      }
      deliver();
    });
    pairs.push(pair);
    relay.delegate.onConnection({}, new URL(endpoint), pair.server);
    return pair.client;
  } });
  let transport;
  transport = new NativeCommandTransport({ send: async message => {
    const reply = await engine.dispatch(message);
    if (message.method === 'context.create') {
      timeline.push('native-create-completed');
      if (options.holdAck) await holdAck.promise;
      timeline.push('create-ack');
    }
    transport.receive(reply);
  } });
  const tokenGate = deferred(); let blockToken = false, tokenBlocked = false;
  let foreignReady;
  const provider = await startNativeProvider({ config, ready: { event: 'ready', protocolVersion: 1, extensionId: EXTENSION, sourceDigest: SOURCE, profileToken: TOKEN },
    chain, transport, inventory, processReader: reader, resolveSelection: async () => ({ ...selection, profileRoot: config.profileRoot }),
    readProfileToken: async () => { if (blockToken) { tokenBlocked = true; await tokenGate.promise; } return TOKEN; } });
  t.after(async () => {
    tokenGate.resolve(); holdInitialized.resolve(); holdAck.resolve();
    for (const browser of cdpBrowsers) await browser.close();
    for (const pair of pairs) pair.client.close();
    if (foreignReady) await assert.rejects(provider.close(), { code: 'NATIVE_STATE_CHANGED' });
    else await provider.close();
    await until(() => pendingHttp.size === 0);
    await until(() => listeners.size === 0 && sockets.size === 0);
    for (const contextId of [A, B]) await engine.dispatch({ id: `cleanup-${contextId}`, method: 'context.discard', contextId, params: { profileToken: TOKEN, sourceDigest: SOURCE } });
    engine.stop();
    assert.deepEqual([...tabs.keys()], [1], 'only owned synthetic allocations removed, manual peer intact');
    assert.equal(nativeProc.stdout.write, binaryWrite, 'actual C never decorated native binary stdout');
    assert.equal(timers.size, 0, 'all E-owned clock/handshake timers closed');
    assert.ok(pairs.every(pair => pair.client.readyState === 3));
    if (foreignReady) assert.deepEqual(await fsp.readFile(config.nativeReadyFile), foreignReady, 'foreign ready replacement preserved');
    else await assert.rejects(fsp.lstat(config.nativeReadyFile), { code: 'ENOENT' });
    t.diagnostic(`E owned provider closed; virtual sockets=${pairs.length} all closed; real browser/native processes=0`);
  });
  const ready = JSON.parse(await fsp.readFile(config.nativeReadyFile));
  t.diagnostic(`E exact owned provider listener port=${new URL(ready.endpoint).port}; root=${root}; pid=${process.pid}; start=${await readProcessStart(process.pid)}`);
  class Server {
    constructor(delegate) {
      this.delegate = delegate; this.host = `ws://127.0.0.1:${38123 + relays.length}`;
      const nonce = NONCES[relays.length];
      this.extensionPath = `/extension/${nonce}`;
      assert.ok([nonce, `/cdp/${nonce}`, `/extension/${nonce}`].every(secret => protectionCalls.includes(secret)),
        'actual generation-time protection precedes server constructor/callbacks');
      // This happens before any server callback or debug: actual helper must
      // already protect both generated paths and the bare nonce.
      coreProc.stderr.write(`ctor /cdp/${nonce} /extension/${nonce} ${nonce}\n`);
      if (options.constructorFailure) throw Error(`owned constructor-private /extension/${nonce}`);
      relays.push(this); this.closed = false;
    }
    async listen() { return this.host; }
    async close() { this.closed = true; }
  }
  const actualCore = readFileSync(path.resolve(actualCli, '../../coreBundle.js'), 'utf8');
  function exactClass(marker) {
    const start = actualCore.indexOf(marker), end = actualCore.indexOf('\n    };', start);
    assert.ok(start >= 0 && end > start);
    return actualCore.slice(start, end + '\n    };'.length);
  }
  const maintained = 'var ManualPromise, BrowserModel, ExtensionProtocolV2;\n' +
    exactClass('    ManualPromise = class extends Promise {') + '\n' +
    exactClass('    BrowserModel = class {') + '\n' + exactClass('    ExtensionProtocolV2 = class {');
  let nonceCounter = 0;
  const context = {
    require: name => name === './desk-extension-credential.cjs' ? credential :
      name === './desk-native-relay.cjs' ? nativeModule.exports : assert.fail(`Unexpected Core require ${name}`),
    process: coreProc, Buffer, URL, console: { log() {} }, WSServer: Server, VERSION: 2, ws3: { OPEN: 1 },
    crypto: { randomUUID: () => NONCES[nonceCounter++] }, extensionConnectionTimeout: 30000,
    monotonicTime: () => now,
    raceAgainstDeadline: async (callback, deadline) => {
      let timer;
      const result = await Promise.race([Promise.resolve().then(callback).then(() => ({ timedOut: false })),
        new Promise(resolve => { timer = setTimer(() => resolve({ timedOut: true }), deadline - now); })]);
      clearTimer(timer); return result;
    },
    logUnhandledError() {}, debugLogger2(...args) { coreProc.stderr.write(args.join(' ') + '\n'); }, debugLogger3(...args) {
      const relay = relays.at(-1), nonce = NONCES[relays.length - 1];
      assert.ok([`${relay.host}/cdp/${nonce}`, `${relay.host}/extension/${nonce}`].every(secret => protectionCalls.includes(secret)),
        'both full URLs protected before native acquisition debug');
      coreProc.stderr.write(args.join(' ') + '\n');
    },
    resolveExtensionOptions: opts => opts, browserInfo: () => ({}),
    playwright: { chromium: { async connectOverCDP(endpoint, connectOptions) {
      assert.ok(timeline.includes('create-ack') && timeline.includes('initialized-delivered'));
      assert.ok(connectOptions.timeout > 0 && connectOptions.timeout <= 30000);
      const relay = relays.find(r => endpoint.startsWith(r.host + '/'));
      const pair = socketPair(); pairs.push(pair);
      const waiting = new Map(), events = []; let id = 0;
      pair.client.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { const w = waiting.get(message.id); waiting.delete(message.id); if (message.error) w.reject(Error(message.error.message)); else w.resolve(message.result); } else events.push(message); };
      relay.delegate.onConnection({}, new URL(endpoint), pair.server);
      const browser = new EventEmitter();
      browser.bind = async () => { if (options.bindFailure && cdpBrowsers.length === 2) throw Error('owned binding failure ' + endpoint); return { endpoint: 'owned-cli-endpoint' }; };
      browser.close = async () => { pair.client.close(); browser.emit('disconnected'); };
      browser.command = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; waiting.set(next, { resolve, reject }); pair.client.send(JSON.stringify({ id: next, method, params, sessionId })); });
      browser.events = events;
      cdpBrowsers.push(browser);
      return browser;
    } } },
  };
  const exports = runInNewContext(maintained + '\n' + stagingPatch.patchSource(fixture) +
    '\ninitOwnedRelayFixture(); ({createBrowser, createExtensionBrowser})', context);
  async function create(contextId = A) {
    const result = await exports.createBrowser({ extension: true, browser: { browserName: 'chromium', userDataDir: config.userDataDir },
      deskNativeContext: records.get(contextId) }, { clientName: 'owned E fixture' }, { channel: 'msedge', profileDirName: 'Default' }, { title: 'owned' });
    return result.browser;
  }
  return { root, codeRoot, generation, lib, create, records, provider, tabs, timeline, holdInitialized, holdAck, advance, timers, output,
    credential, coreProc, relays, cdpBrowsers, creates: () => creates, binary, nativeProc, binaryWrite,
    pendingHttp, blockAttestation: () => { blockToken = true; }, tokenBlocked: () => tokenBlocked, tokenGate,
    readyFile: config.nativeReadyFile, chain,
    retainForeignReady: bytes => { foreignReady = Buffer.from(bytes); } };
}

for (const order of ['initialized-first', 'create-first']) {
  test(`actual guarded Core + C provider/client + current A requires both signals (${order})`, { timeout: 15000 }, async t => {
    const f = await integrated(t, order === 'initialized-first' ? { holdAck: true } : { holdInitialized: true });
    let completed = false, failed;
    const pending = f.create().then(browser => { completed = true; return browser; });
    pending.catch(error => { failed = error; });
    await until(() => failed || f.timeline.includes(order === 'initialized-first' ? 'initialized-delivered' : 'create-ack'));
    if (failed) throw failed;
    assert.equal(completed, false);
    assert.equal(f.cdpBrowsers.length, 0, 'neither isolated signal may connect CDP');
    f.holdAck.resolve(); f.holdInitialized.resolve();
    const browser = await pending;
    await browser.command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await until(() => browser.events.some(e => e.method === 'Target.attachedToTarget'));
    const sessionId = browser.events.find(e => e.method === 'Target.attachedToTarget').params.sessionId;
    assert.equal((await browser.command('Runtime.evaluate', { expression: '"real maintained Runtime traffic"' }, sessionId)).result.value, 'real maintained Runtime traffic');
    assert.equal(f.creates(), 1);
    for (const nonce of NONCES) assert.equal(f.output.join('').includes(nonce), false, 'constructor/debug capability masked');
  });
}

test('actual two maintained runtimes remain independent and outer bind failure retains only its native context', { timeout: 15000 }, async t => {
  const f = await integrated(t, { bindFailure: true });
  const first = await f.create(A);
  await assert.rejects(f.create(B), error => error.resources?.contextId === B && error.resources.disposition === 'retained');
  assert.equal(f.tabs.size, 3, 'failed bind did not discard native allocations or touch manual peer');
  assert.equal(f.relays[0].closed, false, 'only failed relay stopped');
  assert.equal(f.relays[1].closed, true);
  await first.command('Target.setAutoAttach', { autoAttach: true });
  const sessionId = first.events.find(e => e.method === 'Target.attachedToTarget').params.sessionId;
  assert.equal((await first.command('Runtime.evaluate', { expression: 'globalThis.value = "A-still-healthy"' }, sessionId)).result.value, 'A-still-healthy');
  assert.equal(f.creates(), 2);
});

test('actual maintained BrowserModels route independent Runtime traffic in both orders', { timeout: 15000 }, async t => {
  const f = await integrated(t);
  const browsers = [await f.create(A), await f.create(B)];
  const sessions = [];
  for (const browser of browsers) {
    await browser.command('Target.setAutoAttach', { autoAttach: true });
    sessions.push(browser.events.find(e => e.method === 'Target.attachedToTarget').params.sessionId);
  }
  for (const order of [[0, 1], [1, 0]]) {
    for (const i of order)
      assert.equal((await browsers[i].command('Runtime.evaluate', { expression: `globalThis.value = "runtime-${i}"` }, sessions[i])).result.value, `runtime-${i}`);
    for (const i of order)
      assert.equal((await browsers[i].command('Runtime.evaluate', { expression: 'globalThis.value' }, sessions[i])).result.value, `runtime-${i}`);
  }
  assert.equal(f.creates(), 2);
});

test('before-dispatch absolute deadline retires late C attestation without ever allocating a tab', { timeout: 15000 }, async t => {
  const f = await integrated(t);
  f.blockAttestation();
  const pending = f.create().then(value => ({ value }), error => ({ error }));
  await until(f.tokenBlocked);
  assert.ok(f.pendingHttp.size, 'the actual C HTTP operation is still outstanding');
  f.advance(30000);
  const result = await pending;
  assert.equal(result.error.code, 'NATIVE_HANDSHAKE_TIMEOUT');
  assert.equal(f.creates(), 0);
  assert.equal(f.relays.length, 0);
  assert.ok(f.pendingHttp.size, 'timeout did not pretend to abort the unabortable C operation');
  f.tokenGate.resolve();
  await until(() => f.pendingHttp.size === 0);
  assert.equal(f.creates(), 0, 'late actual attestation cannot dispatch create');
});

test('after-dispatch deadline retains named unknown effect and tracks actual C late settlement', { timeout: 15000 }, async t => {
  const f = await integrated(t, { holdAck: true });
  const pending = f.create().then(value => ({ value }), error => ({ error }));
  await until(() => f.timeline.includes('native-create-completed'));
  f.advance(30000);
  const { error } = await pending;
  assert.equal(error.code, 'NATIVE_HANDSHAKE_TIMEOUT');
  assert.equal(error.resources.contextId, A);
  assert.equal(error.resources.method, 'context.create');
  assert.equal(error.resources.disposition, 'unknown');
  assert.equal(error.resources.pendingNativeOperation, true);
  assert.equal(f.tabs.size, 2, 'no automatic native discard');
  assert.ok(f.pendingHttp.size);
  f.holdAck.resolve();
  await until(() => f.pendingHttp.size === 0);
  assert.equal(f.cdpBrowsers.length, 0, 'late acknowledgement cannot revive retired CDP acquisition');
  assert.equal(f.creates(), 1);
});

test('native no-stock-token handshake remains finite when create is ready but initialized is withheld', { timeout: 15000 }, async t => {
  const f = await integrated(t, { holdInitialized: true });
  delete f.coreProc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  const pending = f.create().then(value => ({ value }), error => ({ error }));
  await until(() => f.timeline.includes('create-ack'));
  await until(() => f.timers.size > 0 && f.pendingHttp.size === 0);
  f.advance(30000);
  const { error } = await pending;
  assert.equal(error.code, 'NATIVE_HANDSHAKE_TIMEOUT');
  assert.equal(error.resources.contextId, A);
  assert.equal(error.resources.disposition, 'retained');
  assert.equal(f.relays[0].closed, true);
  assert.equal(f.cdpBrowsers.length, 0);
  assert.equal(f.creates(), 1);
});

test('actual C diagnostics preserve native binary stdout identity and literal frame bytes after E protection', { timeout: 15000 }, async t => {
  const f = await integrated(t);
  await f.create();
  const payload = Buffer.from(JSON.stringify({ token: TOKEN, relay: `ws://127.0.0.1:38123/extension/${NONCES[0]}` }));
  const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
  f.nativeProc.stdout.write(frame);
  assert.equal(f.nativeProc.stdout.write, f.binaryWrite);
  assert.deepEqual(Buffer.concat(f.binary), frame);
  assert.equal(frame.readUInt32LE(0), payload.length);
});

test('a native relay constructor exception is fixed-code only and cannot leak its protected paths', { timeout: 15000 }, async t => {
  const f = await integrated(t, { constructorFailure: true });
  await assert.rejects(f.create(), error => error.code === 'NATIVE_ACQUISITION_UNAVAILABLE' &&
    !String(error).includes('constructor-private') && !String(error).includes(NONCES[0]));
  assert.equal(f.creates(), 0);
  assert.equal(f.relays.length, 0);
  assert.equal(f.timers.size, 0);
});

test('Core disconnect stops only its relay without discarding native tabs or claiming a CLI stop', { timeout: 15000 }, async t => {
  const f = await integrated(t);
  const first = await f.create(A), second = await f.create(B);
  await first.close();
  assert.equal(f.relays[0].closed, true);
  assert.equal(f.relays[1].closed, false);
  assert.equal(f.creates(), 2, 'no replacement create');
  assert.equal(f.tabs.size, 3, 'manual peer and both native tabs retained');
  await second.command('Browser.getVersion');
});

test('replacing the protected generation receipt during actual C attestation cannot be adopted before create', { timeout: 15000 }, async t => {
  const f = await integrated(t);
  f.blockAttestation();
  const pending = f.create().then(value => ({ value }), error => ({ error }));
  await until(f.tokenBlocked);
  const receipt = path.join(f.generation, 'playwright-patch.json'), bytes = readFileSync(receipt);
  fs.renameSync(receipt, receipt + '.owned-original');
  fs.writeFileSync(receipt, bytes, { mode: 0o600, flag: 'wx' });
  f.tokenGate.resolve();
  const { error } = await pending;
  assert.equal(error?.code, 'NATIVE_CODE_CHANGED');
  assert.equal(f.creates(), 0, 'old binding must not adopt a new private receipt inode even with identical contents');
  assert.deepEqual(readFileSync(receipt), bytes, 'foreign replacement retained');
});

for (const mutation of ['helper', 'receipt', 'root', 'capture', 'native-home', 'module-list', 'package-type',
  'module-link', 'module-bytes', 'extra-record', 'ancestry', 'source', 'channel', 'ready']) {
  test(`actual E/C refuses ${mutation} drift with no native allocation or stock fallback`, { timeout: 15000 }, async t => {
    const f = await integrated(t, { sourceClone: ['package-type', 'module-link', 'module-bytes'].includes(mutation) });
    const receipt = path.join(f.generation, 'playwright-patch.json');
    if (mutation === 'helper') fs.appendFileSync(path.join(f.lib, 'desk-native-relay.cjs'), '\n// changed\n');
    if (['receipt', 'root', 'capture', 'native-home', 'module-list'].includes(mutation)) {
      const data = JSON.parse(readFileSync(receipt));
      if (mutation === 'receipt') data.nativeHelperSha256 = '0'.repeat(64);
      if (mutation === 'root') data.nativeRuntime.mcpRoot = path.join(f.root, 'missing-normal-source');
      if (mutation === 'capture') delete data.nativeRuntime.discoveryInputs;
      if (mutation === 'native-home') data.nativeRuntime.discoveryInputs.nativeHome = path.join(f.root, 'another-native-account');
      if (mutation === 'module-list') data.nativeRuntime.modules.pop();
      fs.writeFileSync(receipt, JSON.stringify(data), { mode: 0o600 });
    }
    if (mutation === 'extra-record') f.records.get(A).modulePath = '/untrusted';
    if (mutation === 'package-type') {
      const file = path.join(f.codeRoot, 'package.json'), data = JSON.parse(readFileSync(file));
      data.type = 'commonjs'; fs.writeFileSync(file, JSON.stringify(data));
    }
    if (mutation === 'module-bytes') fs.appendFileSync(path.join(f.codeRoot, 'src/util/broker-error.mjs'), '\n// source drift\n');
    if (mutation === 'module-link') {
      const file = path.join(f.codeRoot, 'src/util'), outside = path.join(f.root, 'owned-outside-module');
      fs.renameSync(file, outside);
      fs.symlinkSync(outside, file, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (mutation === 'ancestry') f.chain[1].startIdentity = 'changed-entry-generation';
    if (mutation === 'source') f.records.get(A).sourceDigest = 'd'.repeat(64);
    if (mutation === 'channel') f.records.get(A).channel = 'chrome';
    if (mutation === 'ready') {
      f.blockAttestation();
      const pending = f.create().then(value => ({ value }), error => ({ error }));
      await until(f.tokenBlocked);
      const bytes = readFileSync(f.readyFile);
      fs.renameSync(f.readyFile, f.readyFile + '.owned-original');
      fs.writeFileSync(f.readyFile, bytes, { mode: 0o600, flag: 'wx' });
      f.retainForeignReady(bytes);
      f.tokenGate.resolve();
      assert.ok((await pending).error, 'actual ready reservation/ancestry reader refused');
    } else await assert.rejects(f.create(), error => ['capture', 'native-home'].includes(mutation) ?
      error.code === 'NATIVE_DISCOVERY_INPUTS_UNAVAILABLE' : /^NATIVE_/u.test(error.code));
    assert.equal(f.creates(), 0);
    assert.equal(f.cdpBrowsers.length, 0);
    assert.equal(f.tabs.size, 1, 'manual peer untouched');
  });
}

test('removing its genuine normal-source origin refuses instead of falling back to a cache or real plugin root', { timeout: 15000 }, async t => {
  const f = await integrated(t, { sourceClone: true });
  await removeTree(f.codeRoot); // exact owned code fixture, intentional missing-origin injection
  await assert.rejects(f.create(), { code: 'NATIVE_CODE_UNAVAILABLE' });
  assert.equal(f.creates(), 0);
  assert.equal(f.relays.length, 0);
});

test('native helper refuses unvalidated records rather than accepting a module locator or fake client', async () => {
  const helper = require(path.join(mcpRoot, 'web-native-relay.cjs'));
  await assert.rejects(helper.initialize({ mcpRoot: '/untrusted', client: {} }, {}, {
    deadline: 30000, now: () => 0,
  }), { code: 'NATIVE_CONFIG_INVALID' });
});

function browserHarness() {
  const calls = [];
  const browser = { bind: async () => ({ endpoint: 'owned' }), close: async () => {} };
  const create = runInNewContext(`${patch.patchSource(fixture)}\ncreateBrowser`, {
    require: () => { calls.push('credential'); return { validateNativeBinding: () => { throw Error('native refused'); } }; },
    createRemoteBrowser: async () => { calls.push('remote'); return browser; },
    createCDPBrowser: async () => { calls.push('cdp'); return browser; },
    createIsolatedBrowser: async () => { calls.push('isolated'); return browser; },
    createPersistentBrowser: async () => { calls.push('persistent'); return browser; },
    browserInfo: () => ({}), resolveExtensionOptions: () => ({ channel: 'msedge' }),
  });
  return { calls, create: config => create(config, { clientName: 'owned' }, {}, { title: 'owned' }) };
}

test('own native config presence refuses before remote/CDP/private/persistent escape; absence stays exact stock', async () => {
  for (const value of [null, false, undefined, [], {}, { version: 2 }]) {
    for (const route of [{ remoteEndpoint: 'owned' }, { cdpEndpoint: 'owned' }, { isolated: true }, {}]) {
      const h = browserHarness();
      await assert.rejects(h.create({ browser: route, deskNativeContext: value }));
      assert.ok(!h.calls.some(call => ['remote', 'cdp', 'isolated', 'persistent'].includes(call)));
    }
  }
  const stock = browserHarness();
  await stock.create({ browser: { remoteEndpoint: 'owned' } });
  assert.deepEqual(stock.calls, ['remote']);
});

test('an inherited native property is absent and cannot route a stock extension call into the native helper', async () => {
  const source = patch.patchSource(fixture), start = source.indexOf('async function createBrowser(config,');
  const end = source.indexOf('\nasync function connectToBrowserEndpoint(', start);
  let passed;
  const create = runInNewContext(source.slice(start, end) + '\ncreateBrowser', {
    require() { throw Error('stock absence must not load any native helper'); },
    resolveExtensionOptions: () => ({ channel: 'msedge', profileDirName: 'Default' }),
    createExtensionBrowser: async (...args) => { passed = args; return { bind: async () => ({ endpoint: 'owned' }) }; },
    browserInfo: () => ({}),
  });
  const config = Object.assign(Object.create({ deskNativeContext: { unexpected: true } }), {
    extension: true, browser: { browserName: 'chromium', userDataDir: '/owned' },
  });
  await create(config, { clientName: 'owned' }, {}, {});
  assert.equal(passed[5], undefined);
});
