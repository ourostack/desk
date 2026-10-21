import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readProcessStart } from '../../../../../plugins/desk/mcp/src/readiness/process-start.js';
import vm from 'node:vm';
import { mkTempRoot } from '../_temp_roots.js';
import { removeTree } from '../_remove_tree.js';
import { BrokerError } from '../../../../../plugins/desk/mcp/src/util/broker-error.mjs';
import { NativeCommandTransport } from '../../../../../plugins/desk/mcp/src/browser/native-transport.mjs';
import { protectWindowsPaths } from '../../../../../plugins/desk/mcp/src/factory/windows-acl.js';

const require = createRequire(import.meta.url);
const rootUrl = new URL('../../../../../plugins/desk/mcp/', import.meta.url);
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64), SOURCE = 'b'.repeat(64), EXTENSION = 'c'.repeat(32);
const actualCli = require('./fixtures/playwright-native-error-transport.cjs').cliDirectory();
const roots = [], shortRoots = [], servers = new Set();
const trackedServers = new Set(), trackedTests = new WeakSet();
const chain = [
  { pid: 300, parentPid: 200, startIdentity: 'runtime', owner: 'fixture', executable: '/fixture/node' },
  { pid: 200, parentPid: 100, startIdentity: 'entry', owner: 'fixture', executable: '/fixture/entry' },
  { pid: 100, parentPid: 1, startIdentity: 'browser', owner: 'fixture', executable: '/fixture/browser' },
];
const reader = async pid => structuredClone(chain.find(p => p.pid === pid));
let runnerStart;
const code = value => error => error.code === value;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
const createParams = { label: 'owned current-A fixture', relayUrl: `ws://127.0.0.1:38123/extension/${A}` };

// Same Chrome/WebSocket boundary as browser_context_extension.test.js. The
// current A kernel AND its maintained relay are real; no browser/network runs.
async function currentA(t, { admit = true } = {}) {
  const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
      emit: (...args) => { for (const fn of [...listeners]) fn(...args); } };
  };
  let nextTab = 10, nextGroup = 50, ready;
  const tabs = new Map([[1, { id: 1, windowId: 7, groupId: -1, active: true }]]);
  const groups = new Map(), sockets = [];
  const api = {
    tabs: {
      onCreated: event(), onRemoved: event(), onUpdated: event(), onDetached: event(),
      async get(id) { if (!tabs.has(id)) throw Error('No tab'); return { ...tabs.get(id) }; },
      async query(query) { return [...tabs.values()].filter(tab => query.groupId === undefined || tab.groupId === query.groupId).map(tab => ({ ...tab })); },
      async create(options) {
        const tab = { id: nextTab++, windowId: 7, groupId: -1, active: false, ...options };
        tabs.set(tab.id, tab); api.tabs.onCreated.emit({ ...tab }); return { ...tab };
      },
      async group({ groupId, tabIds }) {
        const id = groupId ?? nextGroup++;
        if (!groups.has(id)) groups.set(id, { id, windowId: 7, title: '', color: 'grey' });
        for (const tabId of tabIds) {
          Object.assign(tabs.get(tabId), { groupId: id });
          api.tabs.onUpdated.emit(tabId, { groupId: id }, { ...tabs.get(tabId) });
        }
        return id;
      },
      async remove(id) {
        if (!tabs.delete(id)) throw Error('No tab');
        api.tabs.onRemoved.emit(id, { windowId: 7, isWindowClosing: false });
      },
      async update() { assert.fail('No physical activation'); },
      async ungroup() { assert.fail('No generic ungroup'); },
    },
    tabGroups: {
      async get(id) { if (!groups.has(id)) throw Error('No group'); return { ...groups.get(id) }; },
      async update(id, style) { Object.assign(groups.get(id), style); return { ...groups.get(id) }; },
      async query() { assert.fail('No global title scan'); },
    },
    windows: {
      async getAll() { return [{ id: 7, type: 'normal' }]; },
      async update() { assert.fail('No physical focus'); },
      async create() { assert.fail('No new window'); },
    },
    debugger: {
      onEvent: event(), onDetach: event(),
      async attach() { assert.fail('No debugger attachment in these races'); },
      async detach() { assert.fail('No debugger detachment in these races'); },
      async sendCommand() { assert.fail('No CDP commands in these races'); },
    },
    action: { async setBadgeText() {}, async setTitle() {}, async setBadgeBackgroundColor() {} },
    runtime: {
      id: EXTENSION, getURL: name => `chrome-extension://${EXTENSION}/${name}`,
      async getContexts() { return [{ documentUrl: api.runtime.getURL('token.html') }]; },
      async sendMessage() { return { token: TOKEN }; },
      connectNative() {
        return { onMessage: event(), onDisconnect: event(), disconnect() {},
          postMessage(message) { if (message.event === 'ready') ready = structuredClone(message); } };
      },
    },
    offscreen: { async createDocument() { assert.fail('No real offscreen document'); } },
  };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const { createBrowserExtension } = await import('../../../../../plugins/desk/browser-extension/context-engine.mjs');
  const engine = createBrowserExtension(api, { WebSocket: Socket, sourceDigest: SOURCE });
  if (admit) {
    const transition = { transactionId: A, challenge: 'd'.repeat(64), profileToken: TOKEN, sourceDigest: SOURCE };
    const captured = await engine.dispatch({ id: 'fixture-capture', method: 'transition.capture', params: transition });
    assert.equal(captured.result?.admission, 'held');
    const released = await engine.dispatch({ id: 'fixture-release', method: 'transition.release',
      params: { ...transition, workerEpoch: captured.result.workerEpoch,
        witnessDigest: captured.result.witnessDigest, mode: 'ordinary' } });
    assert.equal(released.result?.released, true);
  } else await engine.start();
  t.after(async () => {
    // Exact owned synthetic contexts only; never stop/inspect an operator tab.
    for (const contextId of [A, B]) await engine.dispatch({ id: `cleanup-${contextId}`, method: 'context.discard',
      contextId, params: { profileToken: TOKEN, sourceDigest: SOURCE } });
    engine.stop();
    assert.deepEqual([...tabs.keys()], [1], 'all allocated in-memory tabs closed, manual peer untouched');
    assert.ok(sockets.every(socket => socket.readyState === 3), 'all in-memory relay sockets closed');
    t.diagnostic(`current A fixture closed; allocated synthetic tabs=${nextTab - 10}; real browser/native processes=0`);
  });
  return { engine, tabs, ready };
}
test.after(async () => {
  assert.equal(servers.size, 0, 'all exact owned servers closed');
  assert.equal(trackedServers.size, 0, 'all instrumented listeners closed');
  for (const root of shortRoots) { await removeTree(root); await assert.rejects(fs.lstat(root), { code: 'ENOENT' }); console.log(`C short fixture removed-and-absent=${root}`); }
  for (const root of roots) {
    await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
    console.log(`C fixture removed-and-absent=${root}`);
  }
});
function instrumentServers(t) {
  if (trackedTests.has(t)) return;
  trackedTests.add(t);
  const create = http.createServer;
  t.mock.method(http, 'createServer', function (...args) {
    const server = create.apply(this, args);
    let port;
    trackedServers.add(server);
    server.once('listening', () => { port = server.address().port; t.diagnostic(`C owned HTTP listener port=${port}; pid=${process.pid}`); });
    server.once('close', () => { trackedServers.delete(server); t.diagnostic(`C HTTP listener closed port=${port ?? 'not-listened'}`); });
    return server;
  });
}
async function put(file, value, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
}
async function fixture(t, options = {}) {
  instrumentServers(t);
  const { startNativeProvider } = await import(new URL('src/browser/native-provider.mjs', rootUrl));
  const { createNativeOwnerInventory } = await import(new URL('src/browser/native-owner-inventory.mjs', rootUrl));
  const root = await mkTempRoot('desk-native-C-'); roots.push(root);
  const socketRoot = await fs.mkdtemp(path.join(os.tmpdir() === '/tmp' || process.platform === 'win32' ? os.tmpdir() : '/tmp', 'dc-'));
  shortRoots.push(socketRoot);
  t.diagnostic(`C owned short fixture root=${socketRoot}`);
  runnerStart ||= readProcessStart(process.pid);
  t.diagnostic(`C owned fixture root=${root}; runner pid=${process.pid}; start=${await runnerStart}`);
  const config = {
    version: 1, extensionId: EXTENSION, extensionOrigin: `chrome-extension://${EXTENSION}/`,
    extensionSourceDigest: SOURCE, runtimeExecutable: chain[0].executable,
    entryExecutable: chain[1].executable, browserExecutable: chain[2].executable,
    expectedBrowser: chain[2], channel: 'msedge', userDataDir: path.join(root, 'profile'),
    profileDirName: 'Default', profileRoot: path.join(root, 'profile', 'Default'),
    pluginDirs: [path.join(root, 'plugin')], nativeReadyFile: path.join(root, 'state', 'ready.json'),
    browserStateRoot: path.join(root, 'browser'), cliDir: actualCli,
  };
  const selection = {
    channel: config.channel, userDataDir: config.userDataDir, profileDirName: config.profileDirName,
    profileRoot: config.profileRoot, extensionId: EXTENSION, sourceDigest: SOURCE,
    nativeReadyFile: config.nativeReadyFile,
  };
  await fs.mkdir(path.join(config.browserStateRoot, 'signed-in'), { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') await protectWindowsPaths(
    [config.browserStateRoot, path.join(config.browserStateRoot, 'signed-in')]
      .map(path => ({ path, kind: 'directory', created: true })));
  const inventory = createNativeOwnerInventory({
    browserStateRoot: config.browserStateRoot, cliDir: actualCli,
    binding: selection, socketRoot, env: { USER: 'fixture', USERNAME: 'fixture' },
  });
  async function owner(id, settings = {}) {
    const directory = path.join(config.browserStateRoot, 'signed-in', id);
    const marker = { contextId: id, directory };
    await put(path.join(directory, '.desk-context-owner'), marker);
    for (const name of ['.playwright', 'home', 'config', 'cache', 'data', 'state', 'runtime', 'local', 'roaming'])
      await fs.mkdir(path.join(directory, name), { mode: 0o700 });
    const record = { version: 1, contextId: id, label: 'fixture native owner', ...selection };
    delete record.profileRoot;
    await put(path.join(directory, 'config/browser.json'), {
      extension: true, browser: { userDataDir: config.userDataDir }, deskNativeContext: record,
    });
    const layout = inventory.layout(id);
    await put(path.join(layout.socketDirectory, '.desk-context-owner'), marker);
    if (process.platform !== 'win32') await fs.mkdir(path.dirname(layout.socketPath), { recursive: true, mode: 0o700 });
    const metadata = { name: id, version: inventory.version, timestamp: Date.now(), workspaceDir: directory,
      attached: true, cli: { persistent: true }, browser: {
        browserName: 'chromium', launchOptions: {}, userDataDir: config.userDataDir,
      },
      socketPath: layout.socketPath };
    if (!settings.startup) await put(layout.sessionFile, settings.bad ? '{' : metadata, 0o644);
    if (process.platform === 'win32') await protectWindowsPaths([
      directory, ...['.playwright', 'home', 'config', 'cache', 'data', 'state', 'runtime', 'local', 'roaming']
        .map(name => path.join(directory, name)), layout.socketDirectory,
    ].map(path => ({ path, kind: 'directory', created: true })).concat([
      path.join(directory, '.desk-context-owner'), path.join(directory, 'config/browser.json'),
      path.join(layout.socketDirectory, '.desk-context-owner'),
    ].map(path => ({ path, kind: 'file', created: true }))));
    return { id, directory, layout, record, metadata };
  }
  let pin = TOKEN, alive = true;
  const requests = [], contexts = new Map();
  let transport;
  const request = async message => {
    requests.push(structuredClone(message));
    await options.onRequest?.(message);
    if (options.kernel) {
      const reply = await options.kernel.dispatch(message);
      await options.afterNativeReply?.(message, reply);
      return reply;
    }
    if (options.overrideResponse) {
      const overridden = await options.overrideResponse(message);
      if (overridden !== undefined) return overridden;
    }
    if (!alive) throw new BrokerError('NATIVE_TRANSPORT_DISCONNECTED', 'fixed', { effect: 'unknown' });
    if (message.method === 'profile.read') return options.profileResponse || { extensionId: EXTENSION, sourceDigest: SOURCE, profileToken: TOKEN };
    if (message.method === 'extension.reload') return { reload: true };
    if (message.method === 'extension.reload.commit') return { committing: true };
    if (message.method === 'context.create') {
      const result = { contextId: message.contextId, state: 'ready', groupId: 9, tabs: [{ tabId: 10, windowId: 1 }], pendingEffects: 0 };
      contexts.set(message.contextId, result); return result;
    }
    if (message.method === 'context.discard') {
      contexts.delete(message.contextId);
      return { contextId: message.contextId, discarded: true, closedTabIds: [10], absentTabIds: [10],
        releasedRevokedTabs: [{ tabId: 20, windowId: 1 }] };
    }
    if (!contexts.has(message.contextId)) throw new BrokerError('native_context_unavailable', 'native_context_unavailable');
    return structuredClone(contexts.get(message.contextId));
  };
  if (options.kernel) transport = new NativeCommandTransport({ send: async message => transport.receive(await request(message)) });
  else {
    transport = new EventEmitter();
    transport.request = request;
    transport.close = () => { alive = false; transport.emit('close'); };
  }
  const proof = options.normalProof ?
    (await import(new URL('src/browser/native-update-proof.mjs', rootUrl))).createNativeUpdateProof(config) : undefined;
  const construction = {
    config, ready: options.ready || { event: 'ready', protocolVersion: 1, extensionId: EXTENSION, sourceDigest: SOURCE, profileToken: TOKEN },
    chain, transport, inventory, processReader: options.processReader || reader,
    resolveSelection: async () => selection, readProfileToken: async () => { await options.beforeTokenRead?.(); return pin; },
    verifyContinuity: proof?.verifyContinuity || options.verifyContinuity || (options.trustedBaseline ? async evidence => ({
      generation: evidence.generation, bindingDigest: evidence.bindingDigest, snapshotDigest: evidence.snapshot.digest,
      baselineId: A,
    }) : undefined),
    updateTtlMs: options.updateTtlMs || 1000,
    protectSecret() {},
    onAdmitted: proof?.onAdmitted || options.onAdmitted,
  };
  const provider = await startNativeProvider(construction);
  servers.add(provider);
  t.after(async () => {
    try { await provider.close(); }
    catch (error) { if (error.code !== options.expectedCloseError) throw error; }
    finally { servers.delete(provider); }
  });
  return { root, config, provider, owner, inventory, requests, contexts, selection, transport, options, construction,
    setPin(value) { pin = value; }, resetNative() { alive = true; },
    client: require(fileURLToPath(new URL('web-native-messaging.cjs', rootUrl))) };
}
test('post-admission handoff sees healthy reserved readiness with zero prior native RPC', async t => {
  let entered = false;
  const f = await fixture(t, { onAdmitted: async evidence => {
    entered = true;
    const ready = JSON.parse(await fs.readFile(evidence.readyFile, 'utf8'));
    assert.equal(ready.generation, evidence.generation);
    assert.match(evidence.bindingDigest, /^[a-f0-9]{64}$/u);
    // The callback runs only once a client-ready binding exists.
    assert.equal(typeof evidence.capture, 'function');
  } });
  assert.equal(entered, true);
  assert.equal(f.requests.length, 0, 'handoff construction itself did not issue native traffic');
});

test('post-admission HTTP effects remain fenced until the source handoff completes', async t => {
  const f = await fixture(t, { onAdmitted: async evidence => {
    const ready = JSON.parse(await fs.readFile(evidence.readyFile, 'utf8'));
    const client = require(fileURLToPath(new URL('web-native-messaging.cjs', rootUrl)));
    await assert.rejects(client.providerRequest(ready.endpoint, 'dispatch',
      { contextId: A, method: 'context.create', params: createParams }), { code: 'NATIVE_UPDATE_IN_PROGRESS' });
    await assert.rejects(client.providerRequest(ready.endpoint, 'dispatch',
      { contextId: A, method: 'transition.capture', params: {} }), { code: 'NATIVE_UPDATE_IN_PROGRESS' });
  } });
  assert.equal(f.requests.length, 0);
});

test('post-admission asynchronous ready replacement refuses and preserves the replacement', async t => {
  let replacement;
  await assert.rejects(fixture(t, { onAdmitted: async evidence => {
    replacement = evidence.readyFile;
    await fs.rename(replacement, replacement + '.owned-previous');
    await put(replacement, { foreign: true });
  } }), error => ['NATIVE_STATE_CHANGED', 'NATIVE_READY_CHANGED'].includes(error.code));
  assert.deepEqual(JSON.parse(await fs.readFile(replacement)), { foreign: true });
});
test('actual producer plus fixed normal proof releases ordinary contexts but cannot issue update authority', async t => {
  const native = await currentA(t, { admit: false });
  const f = await fixture(t, { kernel: native.engine, ready: native.ready, normalProof: true });
  assert.deepEqual(f.requests.map(r => r.method), ['transition.capture', 'transition.release']);
  await f.owner(A);
  const made = await f.provider.invoke('dispatch', { contextId: A, method: 'context.create', params: createParams });
  assert.equal(made.tabs[0].tabId, 10);
  const discarded = await f.provider.invoke('dispatch', { contextId: A, method: 'context.discard', params: {} });
  assert.equal(discarded.discarded, true);
  await assert.rejects(f.provider.invoke('prepareUpdate'), { code: 'NATIVE_CONTINUITY_UNKNOWN' });
});

async function entryConfiguration(f) {
  const file = path.join(f.root, 'entry', 'provider-config.json');
  await put(file, f.config);
  if (process.platform === 'win32') await protectWindowsPaths([
    { path: path.dirname(file), kind: 'directory', created: true },
    { path: file, kind: 'file', created: true },
  ]);
  assert.deepEqual(f.client.readPrivateJson(file), f.config);
  return file;
}

test('inventory descriptor preserves both private batches on their own side of the marker read', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  const owner = await f.owner(A);
  const events = [], batch = f.client.privatePaths, read = f.client.readPrivateJson;
  t.mock.method(f.client, 'privatePaths', function (entries) {
    events.push({ batch: entries });
    return batch(entries);
  });
  t.mock.method(f.client, 'readPrivateJson', function (file, options) {
    events.push({ read: file });
    return read(file, options);
  });
  assert.deepEqual(f.inventory.descriptor(A).record, owner.record);
  const first = { batch: [f.config.browserStateRoot, path.dirname(owner.directory), owner.directory]
    .map(file => ({ file, directory: true })) };
  const marker = { read: path.join(owner.directory, '.desk-context-owner') };
  assert.deepEqual(events, [first, marker, {
    batch: ['.playwright', 'home', 'config', 'cache', 'data', 'state', 'runtime', 'local', 'roaming']
      .map(name => ({ file: path.join(owner.directory, name), directory: true })),
  }, { read: path.join(owner.directory, 'config/browser.json') }]);
  await put(marker.read, { contextId: B, directory: owner.directory });
  events.length = 0;
  assert.throws(() => f.inventory.descriptor(A), { code: 'NATIVE_OWNER_INVALID' });
  assert.deepEqual(events, [first, marker], 'invalid owner marker cannot authorize the later batch');
});

for (const intervening of ['recreate', 'unavailable']) {
  // Break caught: an old discard receipt must not overwrite newer effects or
  // a later unavailable event while its final attestation is suspended.
  test(`C1 current A old discard cannot settle a newer ${intervening} epoch`, { skip: !actualCli, timeout: 10000 }, async t => {
    const native = await currentA(t);
    const entered = deferred(), release = deferred();
    let hold = false;
    const options = { kernel: native.engine, trustedBaseline: true,
      beforeTokenRead: async () => {
        if (!hold) return;
        hold = false; entered.resolve(); await release.promise;
      },
      afterNativeReply: async message => { if (message.method === 'context.discard') hold = true; },
    };
    const f = await fixture(t, options);
    await f.owner(A);
    const created = await f.provider.invoke('dispatch', { contextId: A, method: 'context.create', params: createParams });
    assert.equal(created.tabs[0].tabId, 10);
    const discard = settled(f.provider.invoke('dispatch', { contextId: A, method: 'context.discard', params: {} }));
    try {
      await entered.promise;
      assert.equal(native.tabs.has(10), false, 'actual A already closed the old tab');
      if (intervening === 'recreate') {
        const recreated = await f.provider.invoke('dispatch', { contextId: A, method: 'context.create', params: createParams });
        assert.equal(recreated.tabs[0].tabId, 11);
        assert.equal(native.tabs.has(11), true);
      } else f.transport.receive({ event: 'context.unavailable', contextId: A });
      release.resolve();
      const completion = await discard;
      const gate = await settled(f.provider.invoke('prepareUpdate'));
      if (gate.value) await f.provider.invoke('cancelUpdate', { ticket: gate.value.ticket });
      assert.equal(gate.error?.code, 'NATIVE_UPDATE_OWNERS_UNSETTLED',
        'old receipt cannot grant quiescence over a newer context operation/event');
      assert.equal(completion.error?.code, 'NATIVE_CONTEXT_UNCONFIRMED');
      assert.equal(completion.error.resources.contextId, A);
      assert.equal(completion.error.resources.disposition, 'unknown');
      if (intervening === 'recreate') {
        assert.equal(native.tabs.has(11), true, 'gating did not clean or replace the new live tab');
        assert.ok(f.requests.some(message => message.method === 'context.status'), 'gate consults actual current A status');
      }
    } finally { release.resolve(); await discard; }
  });
}

// The same C1 epoch fence must survive the gate's final awaited trusted proof:
// a new unavailable obligation cannot be overwritten by an older empty snapshot.
test('C1 current A unavailable during proof cannot publish stale quiescence', { skip: !actualCli, timeout: 10000 }, async t => {
  const native = await currentA(t), entered = deferred(), release = deferred();
  const f = await fixture(t, { kernel: native.engine,
    verifyContinuity: async evidence => {
      entered.resolve(); await release.promise;
      return { generation: evidence.generation, bindingDigest: evidence.bindingDigest,
        snapshotDigest: evidence.snapshot.digest, baselineId: A };
    },
  });
  await f.owner(A);
  await f.provider.invoke('dispatch', { contextId: A, method: 'context.create', params: createParams });
  await f.provider.invoke('dispatch', { contextId: A, method: 'context.discard', params: {} });
  const pending = settled(f.provider.invoke('prepareUpdate'));
  try {
    await entered.promise;
    f.transport.receive({ event: 'context.unavailable', contextId: A });
    release.resolve();
    const gate = await pending;
    if (gate.value) await f.provider.invoke('cancelUpdate', { ticket: gate.value.ticket });
    assert.equal(gate.error?.code, 'NATIVE_UPDATE_OWNERS_UNSETTLED');
    assert.equal(gate.error.resources.owners[0].contextId, A);
  } finally { release.resolve(); await pending; }
});

for (const seam of ['token', 'profile-reply', 'prepareUpdate', 'reload', 'commit']) {
  // Break caught: a reservation replaced during any awaited corroboration
  // must invalidate the old provider before the next authority-bearing send
  // or ticket publication; closing it must preserve the foreign replacement.
  test(`C2 current A reservation replacement across ${seam} await refuses authority`, { skip: !actualCli, timeout: 10000 }, async t => {
    const native = await currentA(t);
    const entered = deferred(), release = deferred();
    let holdToken = false, holdReply = false, holdProof = false;
    const pause = async () => { entered.resolve(); await release.promise; };
    const options = { kernel: native.engine, updateTtlMs: 10000, expectedCloseError: 'NATIVE_STATE_CHANGED',
      beforeTokenRead: async () => { if (holdToken) { holdToken = false; await pause(); } },
      afterNativeReply: async message => {
        if (holdReply && message.method === 'profile.read') { holdReply = false; await pause(); }
      },
      verifyContinuity: async evidence => {
        if (holdProof) { holdProof = false; await pause(); }
        return { generation: evidence.generation, bindingDigest: evidence.bindingDigest,
          snapshotDigest: evidence.snapshot.digest, baselineId: A };
      },
    };
    const f = await fixture(t, options);
    await f.owner(A);
    let ticket;
    if (!['token', 'profile-reply'].includes(seam)) {
      await f.provider.invoke('dispatch', { contextId: A, method: 'context.create', params: createParams });
      await f.provider.invoke('dispatch', { contextId: A, method: 'context.discard', params: {} });
      if (seam !== 'prepareUpdate') ticket = (await f.provider.invoke('prepareUpdate')).ticket;
      if (seam === 'commit') await f.provider.invoke('reload', { ticket });
    }
    holdToken = seam === 'token'; holdReply = seam === 'profile-reply';
    holdProof = !['token', 'profile-reply'].includes(seam);
    const operation = ['token', 'profile-reply'].includes(seam)
      ? f.provider.invoke('dispatch', { contextId: A, method: 'context.create', params: createParams })
      : f.provider.invoke(seam, ticket ? { ticket } : {});
    const completion = settled(operation);
    try {
      await entered.promise;
      const count = f.requests.length;
      const replacement = { ...JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8')),
        generation: '33333333-3333-4333-8333-333333333333' };
      await fs.rename(f.config.nativeReadyFile, `${f.config.nativeReadyFile}.owned-old`);
      await put(f.config.nativeReadyFile, replacement);
      release.resolve();
      const result = await completion;
      assert.equal(result.error?.code, 'NATIVE_READY_CHANGED', 'old provider authority is invalid after an awaited replacement');
      assert.equal(f.requests.length, count, 'no native request after the exact reservation changed');
      assert.deepEqual([...native.tabs.keys()], [1], 'no late create or replacement allocation');
      await assert.rejects(f.provider.close(), code('NATIVE_STATE_CHANGED'));
      assert.deepEqual(JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8')), replacement,
        'old close preserves foreign inode/content');
      await assert.rejects(f.provider.invoke('attest'), code('NATIVE_TRANSPORT_DISCONNECTED'));
    } finally { release.resolve(); await completion; }
  });
}

for (const envelope of ['empty', 'missing-result', 'ambiguous', 'bad-error', 'bad-error-code', 'wrong-success-status']) {
  // Break caught: schema-invalid HTTP completion after actual create must
  // never become success or lose the named unknown-effect projection.
  test(`C3 current A create retains resources for ${envelope} HTTP envelope`, { skip: !actualCli, timeout: 10000 }, async t => {
    const native = await currentA(t);
    const f = await fixture(t, { kernel: native.engine });
    await f.owner(A);
    const proxy = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const bytes of request) chunks.push(bytes);
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await f.provider.invoke(message.operation, message.payload);
      const body = {
        empty: {},
        'missing-result': { ok: true },
        ambiguous: { ok: true, result, error: { code: 'NATIVE_REQUEST_FAILED' } },
        'bad-error': { ok: false, error: null },
        'bad-error-code': { ok: false, error: { code: 42 } },
        'wrong-success-status': { ok: true, result },
      }[envelope];
      response.writeHead(envelope === 'wrong-success-status' ? 409 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = `http://127.0.0.1:${proxy.address().port}/provider/${'d'.repeat(64)}`;
      const completion = await settled(f.client.providerRequest(endpoint, 'dispatch',
        { contextId: A, method: 'context.create', params: createParams }));
      assert.equal(native.tabs.has(10), true, 'the current A create really took effect before the invalid response');
      assert.equal(completion.error?.code, 'NATIVE_PROVIDER_RESPONSE_INVALID');
      assert.deepEqual(completion.error.resources,
        { disposition: 'unknown', operation: 'dispatch', contextId: A, method: 'context.create' });
    } finally { await new Promise(resolve => proxy.close(resolve)); }
  });
}

test('fresh provider cannot certify old retained effects from empty maps', {
  skip: !actualCli && process.env.DESK_TEST_OLD_NATIVE_GATE !== '1',
}, async t => {
  if (process.env.DESK_TEST_OLD_NATIVE_GATE === '1') {
    const text = await fs.readFile('/Users/microsoft/code/desk-worktrees/delivery-proof-receipts/plugins/desk/browser-context-broker/src/native-provider.mjs', 'utf8');
    const start = text.indexOf("if (operation === 'prepareUpdate') {");
    const end = text.indexOf("if (['cancelUpdate', 'reloadExtension'].includes(operation))", start);
    assert.ok(start >= 0 && end > start);
    const factory = new Function('BrokerError', `
      let updateToken, activeOperations=0;
      const identity={},context={id:'fixture'},stateDir='virtual';
      const transport={pause(){},resume(){}};
      const invoke=async()=>({healthy:true}),withBrokerLock=async(_dir,fn)=>fn();
      const readRegistry=async()=>({leases:{}}),randomBytes=()=>({toString:()=> 'ticket'});
      return async function(operation,payload){${text.slice(start,end)}};`);
    const oldGate = factory(BrokerError);
    const retainedOldSyntheticTab = { id: 91, groupId: 9 };
    assert.equal(retainedOldSyntheticTab.id, 91);
    await assert.rejects(oldGate('prepareUpdate', {}), code('NATIVE_CONTINUITY_UNKNOWN'));
    return;
  }
  const f = await fixture(t);
  await assert.rejects(f.provider.invoke('prepareUpdate', {}), code('NATIVE_CONTINUITY_UNKNOWN'));
  assert.equal(f.requests.some(r => r.method === 'extension.reload'), false);
});

test('concurrent update commands cannot both dispatch or cancel a validating reload', { skip: !actualCli }, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  const ticket = await f.provider.invoke('prepareUpdate', {});
  const reload = f.provider.invoke('reload', { ticket: ticket.ticket });
  const duplicate = f.provider.invoke('reload', { ticket: ticket.ticket });
  const outcome = duplicate.then(() => 'wrongly-accepted', error => error.code);
  await reload;
  assert.notEqual(await outcome, 'wrongly-accepted');
  assert.equal(f.requests.filter(r => r.method === 'extension.reload').length, 1);
});

test('current native resource projections and unavailable events block update after files look settled', { skip: !actualCli }, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  await f.owner(A);
  await f.provider.invoke('dispatch', { contextId: A, method: 'context.create', params: {} });
  const projection = { contextId: A, tabs: [], unknownRevokedTabs: [{ tabId: 29, windowId: 3 }],
    pendingEffects: 0, debuggerCustody: [{ tabId: 29, state: 'unknown' }], unconfirmedCreates: 1 };
  f.contexts.set(A, projection);
  await assert.rejects(f.provider.invoke('prepareUpdate', {}), error =>
    error.code === 'NATIVE_UPDATE_OWNERS_UNSETTLED' &&
    JSON.stringify(error.resources).includes('unknownRevokedTabs'));
  await f.provider.invoke('dispatch', { contextId: A, method: 'context.discard', params: {} });
  f.transport.emit('event', { event: 'context.unavailable', contextId: A, code: 'native_relay_unavailable' });
  await assert.rejects(f.provider.invoke('prepareUpdate', {}), code('NATIVE_UPDATE_OWNERS_UNSETTLED'));
});

test('fresh source selection native oracle and ancestor changes refuse every authorized operation', { skip: !actualCli }, async t => {
  let changed = false;
  const f = await fixture(t, { processReader: async pid => {
    const p = await reader(pid);
    if (changed && pid === 200) p.startIdentity = 'replaced';
    return p;
  } });
  f.selection.sourceDigest = 'd'.repeat(64);
  await assert.rejects(f.provider.invoke('attest', {}), code('NATIVE_SELECTION_MISMATCH'));
  f.selection.sourceDigest = SOURCE;
  f.options.profileResponse = { extensionId: EXTENSION, sourceDigest: 'e'.repeat(64), profileToken: TOKEN };
  await assert.rejects(f.provider.invoke('attest', {}), code('NATIVE_EXTENSION_SOURCE_MISMATCH'));
  f.options.profileResponse = undefined;
  changed = true;
  await assert.rejects(f.provider.invoke('attest', {}), code('NATIVE_ANCESTRY_MISMATCH'));
});

test('ordinary selected-profile resolver reads only synthetic declared Local State', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  await f.provider.close();
  const { startNativeProvider } = await import(new URL('src/browser/native-provider.mjs', rootUrl));
  const real = require(fileURLToPath(new URL('web-real-profile.cjs', rootUrl)));
  // HOME is the existing isolated runner's private HOME; do not change it or
  // invoke any Registry API that caches it. This exact subtree was absent.
  const userDataDir = real.userDataDir('msedge', process.platform, process.env, os.homedir());
  await assert.rejects(fs.lstat(userDataDir), { code: 'ENOENT' });
  t.diagnostic(`C owned synthetic selector subtree=${userDataDir}`);
  t.after(async () => { await removeTree(userDataDir); await assert.rejects(fs.lstat(userDataDir), { code: 'ENOENT' }); });
  const config = { ...f.config, userDataDir, profileRoot: path.join(userDataDir, 'Default') };
  await put(path.join(config.pluginDirs[0], 'plugin.json'), {
    desk: { browser: { channel: 'msedge', profileAccountDomain: 'fixture.invalid' } },
  });
  await put(path.join(userDataDir, 'Local State'), {
    profile: { last_used: 'Default', info_cache: { Default: { user_name: 'fixture@fixture.invalid' },
      'Profile 1': { user_name: 'foreign@other.invalid' } } },
  });
  f.resetNative();
  const transport = new EventEmitter();
  transport.request = f.transport.request;
  transport.close = () => { f.transport.close(); transport.emit('close'); };
  const provider = await startNativeProvider({ ...f.construction, config, transport, inventory: undefined, resolveSelection: undefined,
    readProfileToken: async selected => { assert.equal(selected, config.profileRoot); return TOKEN; } });
  servers.add(provider);
  t.after(async () => { try { await provider.close(); } finally { servers.delete(provider); } });
  assert.equal((await provider.invoke('attest', {})).healthy, true);
  await put(path.join(userDataDir, 'Local State'), { profile: { info_cache: {} } });
  await assert.rejects(provider.invoke('attest', {}), code('NATIVE_SELECTION_MISMATCH'));
});

async function rawHttp(endpoint, body, overrides = {}) {
  const client = require(fileURLToPath(new URL('web-native-messaging.cjs', rootUrl)));
  const parts = client.endpointParts(endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: parts.port, path: parts.path, method: 'POST',
      headers: { 'content-type': 'application/json' }, ...overrides }, res => {
      const chunks = []; res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
test('HTTP capability host origin method UTF8 and body limits reject before native dispatch', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  const ready = JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8'));
  const body = JSON.stringify({ operation: 'attest', payload: {} });
  const before = f.requests.length;
  for (const override of [
    { path: '/provider/' + 'f'.repeat(64) }, { path: f.client.endpointParts(ready.endpoint).path + '?extra' },
    { headers: { host: 'localhost', 'content-type': 'application/json' } },
    { headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' } },
    { method: 'GET' },
  ]) assert.equal((await rawHttp(ready.endpoint, override.method === 'GET' ? '' : body, override)).status, 403);
  for (const invalid of ['{', '[]', '{}', Buffer.from([0xff])])
    assert.equal((await rawHttp(ready.endpoint, invalid)).status, 409);
  assert.equal(f.requests.length, before);
  let limited;
  try { limited = (await rawHttp(ready.endpoint, JSON.stringify({ operation: 'attest', payload: { huge: 'x'.repeat(1048576) } }))).status === 413; }
  catch (error) { if (error.code !== 'ECONNRESET') throw error; limited = true; }
  assert.equal(limited, true);
  assert.equal(f.requests.length, before);
  await assert.rejects(f.client.providerRequest(ready.endpoint, 'attest', { large: 'x'.repeat(1048576) }),
    code('NATIVE_REQUEST_TOO_LARGE'));
  for (const endpoint of [ready.endpoint.replace('127.0.0.1', 'localhost'), ready.endpoint + '#fragment',
    ready.endpoint.replace('http:', 'https:'), ready.endpoint.replace('/provider/', '/provider/%')])
    await assert.rejects(f.client.providerRequest(endpoint, 'attest', {}), code('NATIVE_PROVIDER_ENDPOINT_INVALID'));
  const valid = await f.client.providerRequest(ready.endpoint, 'attest', {});
  assert.equal(valid.healthy, true);
});

test('client timeouts malformed responses and hostile error text retain only bounded unknown resources', async t => {
  instrumentServers(t);
  const client = require(fileURLToPath(new URL('web-native-messaging.cjs', rootUrl)));
  const sockets = new Set();
  let mode = 'timeout';
  const server = http.createServer((_req, res) => {
    if (mode === 'timeout') return;
    if (mode === 'json') { res.end('{'); return; }
    if (mode === 'large') { res.end('x'.repeat(1048577)); return; }
    res.writeHead(409);
    res.end(JSON.stringify({ ok: false, error: { code: 'NATIVE_' + 'A'.repeat(64), message: TOKEN,
      resources: { contextId: A, endpoint: 'http://127.0.0.1:1/provider/' + TOKEN, credential: TOKEN } } }));
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.diagnostic(`C owned HTTP fixture port=${server.address().port}; runner pid=${process.pid}`);
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/provider/${'d'.repeat(64)}`;
  await assert.rejects(client.providerRequest(endpoint, 'dispatch',
    { contextId: A, method: 'context.create', params: { profileToken: TOKEN } }, { timeoutMs: 20 }), error =>
    error.code === 'NATIVE_PROVIDER_TIMEOUT' && error.resources.disposition === 'unknown' &&
    error.resources.contextId === A && error.resources.method === 'context.create' && !JSON.stringify(error).includes(TOKEN));
  mode = 'json';
  await assert.rejects(client.providerRequest(endpoint, 'attest', {}), code('NATIVE_PROVIDER_RESPONSE_INVALID'));
  mode = 'large';
  await assert.rejects(client.providerRequest(endpoint, 'attest', {}), code('NATIVE_PROVIDER_RESPONSE_TOO_LARGE'));
  mode = 'error';
  await assert.rejects(client.providerRequest(endpoint, 'attest', {}), error =>
    error.code === 'NATIVE_PROVIDER_REQUEST_FAILED' && error.resources.contextId === A &&
    !JSON.stringify(error).includes(TOKEN));
});

test('normal bootstrap rebinds immutable setup to each current browser generation without granting update continuity', async t => {
  const entry = await import(new URL('native-host.mjs', rootUrl));
  assert.equal(typeof entry.runNativeBootstrapEntry, 'function',
    'normal native startup must derive its exact current browser rather than retain the installation PID');
  const f = await fixture(t);
  await f.provider.close();
  const host = await import(new URL('src/browser/native-host.mjs', rootUrl));
  const configFile = await entryConfiguration(f);
  const originalExpected = structuredClone(f.config.expectedBrowser);
  const bootstrap = { ...f.config, browserOwner: f.config.expectedBrowser.owner };
  delete bootstrap.expectedBrowser;
  await put(configFile, bootstrap);
  const before = await fs.readFile(configFile);
  for (const browserPid of [100, 101]) {
    const current = structuredClone(chain);
    current[0].pid = process.pid;
    current[1].parentPid = browserPid;
    current[2].pid = browserPid;
    current[2].startIdentity = `browser-generation-${browserPid}`;
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const requests = [];
    const framer = host.createNativeFramer({
      onMessage(message) {
        requests.push(message);
        if (message.method === 'profile.read')
          stdin.write(host.encodeNativeMessage({ id: message.id, result: {
            extensionId: EXTENSION, sourceDigest: SOURCE, profileToken: TOKEN,
          } }));
      }, onError: assert.fail,
    });
    stdout.on('data', bytes => framer.push(bytes));
    let failure;
    const running = entry.runNativeBootstrapEntry({
      stdin, stdout, stderr, origin: f.config.extensionOrigin, configFile,
      processReader: async pid => structuredClone(current.find(row => row.pid === pid)),
      providerOptions: { ...f.construction, processReader: undefined },
    });
    const completed = running.catch(error => { failure = error; });
    try {
      stdin.write(host.encodeNativeMessage(f.construction.ready));
      let binding;
      for (let i = 0; i < 100; i++) {
        if (failure) throw failure;
        try { binding = JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await sleep(5);
      }
      assert.ok(binding, 'bootstrap publishes current-generation readiness within the original startup budget');
      assert.deepEqual(binding.browser, current[2]);
      let healthy = false;
      for (let i = 0; i < 100 && !healthy; i++) {
        if (failure) throw failure;
        try { healthy = (await f.client.providerRequest(binding.endpoint, 'attest', {})).healthy; }
        catch (error) { if (error.code !== 'NATIVE_UPDATE_IN_PROGRESS') throw error; }
        if (!healthy) await sleep(5);
      }
      assert.equal(healthy, true);
      await assert.rejects(f.client.providerRequest(binding.endpoint, 'prepareUpdate', {}), code('NATIVE_CONTINUITY_UNKNOWN'));
      assert.ok(requests.every(request => request.method === 'profile.read'), 'bootstrap must not issue browser effects');
    } finally {
      stdin.end();
      await completed;
      stdout.destroy(); stderr.destroy();
    }
    if (failure) throw failure;
    await assert.rejects(fs.lstat(f.config.nativeReadyFile), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(configFile), before, 'runtime rebinding must not rewrite immutable setup');
  }
  assert.deepEqual(f.config.expectedBrowser, originalExpected);
});

for (const fault of ['owner', 'entry', 'runtime', 'browser', 'source', 'extra-field', 'missing-field', 'stale-full-config', 'generation-race']) {
  test(`normal bootstrap refuses ${fault} before readiness or browser effects`, async t => {
    const f = await fixture(t);
    await f.provider.close();
    const { runNativeBootstrapEntry } = await import(new URL('native-host.mjs', rootUrl));
    const host = await import(new URL('src/browser/native-host.mjs', rootUrl));
    const configFile = await entryConfiguration(f);
    const config = { ...f.config, browserOwner: f.config.expectedBrowser.owner };
    delete config.expectedBrowser;
    if (fault === 'owner') config.browserOwner = 'foreign-owner';
    if (['entry', 'runtime', 'browser'].includes(fault)) config[`${fault}Executable`] = '/foreign/executable';
    if (fault === 'source') config.extensionSourceDigest = 'd'.repeat(64);
    if (fault === 'extra-field') config.permission = 'untrusted';
    if (fault === 'missing-field') delete config.browserOwner;
    if (fault === 'stale-full-config') config.expectedBrowser = f.config.expectedBrowser;
    await put(configFile, config);
    const before = await fs.readFile(configFile), current = structuredClone(chain);
    current[0].pid = process.pid;
    let reads = 0;
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), messages = [];
    const framer = host.createNativeFramer({ onMessage: value => messages.push(value), onError: assert.fail });
    stdout.on('data', bytes => framer.push(bytes));
    const running = runNativeBootstrapEntry({ stdin, stdout, stderr, origin: f.config.extensionOrigin, configFile,
      processReader: async pid => {
        const row = structuredClone(current.find(value => value.pid === pid));
        if (++reads > 6 && fault === 'generation-race' && pid === current[2].pid) row.startIdentity += ':reused';
        return row;
      }, providerOptions: { ...f.construction, processReader: undefined } });
    const expected = ['extra-field', 'missing-field', 'stale-full-config'].includes(fault) ? 'NATIVE_CONFIG_INVALID'
      : ['source', 'generation-race'].includes(fault) ? 'NATIVE_PROVIDER_START_FAILED' : 'NATIVE_ANCESTRY_MISMATCH';
    const refused = assert.rejects(running, code(expected));
    if (fault === 'source') stdin.write(host.encodeNativeMessage(f.construction.ready));
    try { await refused; }
    finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); }
    assert.ok(messages.every(message => message.event === 'diagnostic'), 'no profile RPC or effect dispatch on invalid ancestry/source');
    await assert.rejects(fs.lstat(f.config.nativeReadyFile), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(configFile), before);
  });
}

test('native entry initialization receives its own profile reply without a frame-chain deadlock', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  await f.provider.close();
  const { runNativeEntry } = await import(new URL('native-host.mjs', rootUrl));
  const host = await import(new URL('src/browser/native-host.mjs', rootUrl));
  const configFile = await entryConfiguration(f);
  const probe = await fs.open(path.join(f.root, 'ready-write-probe'), 'wx', 0o600);
  const handlePrototype = Object.getPrototypeOf(probe), writeFile = handlePrototype.writeFile;
  await probe.close();
  let partialPublications = 0;
  t.mock.method(handlePrototype, 'writeFile', async function (bytes, ...options) {
    if (Buffer.isBuffer(bytes) && bytes.toString().includes(`"profileRoot":${JSON.stringify(f.config.profileRoot)}`)) {
      partialPublications++;
      await writeFile.call(this, bytes.subarray(0, 1), ...options);
      const partial = await fs.readFile(f.config.nativeReadyFile, 'utf8');
      assert.equal(partial, '{');
      assert.throws(() => JSON.parse(partial), SyntaxError);
      await sleep(50);
      return writeFile.call(this, bytes.subarray(1), ...options);
    }
    return writeFile.call(this, bytes, ...options);
  });
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const entryChain = structuredClone(chain); entryChain[0].pid = process.pid;
  const native = [];
  let replyToProfile = true;
  const framer = host.createNativeFramer({
    onMessage(message) {
      native.push(message);
      if (message.method === 'profile.read' && replyToProfile)
        stdin.write(host.encodeNativeMessage({ id: message.id, result: { extensionId: EXTENSION, sourceDigest: SOURCE, profileToken: TOKEN } }));
    }, onError: assert.fail,
  });

  stdout.on('data', b => framer.push(b));
  const running = runNativeEntry({ stdin, stdout, stderr, origin: f.config.extensionOrigin, configFile,
    processReader: async pid => structuredClone(entryChain.find(p => p.pid === pid)),
    providerOptions: { ...f.construction, processReader: undefined } });
  const completed = running.then(value => value, error => { throw error; });
  t.after(async () => {
    stdin.end();
    try { await completed; } finally { stdout.destroy(); stderr.destroy(); }
  });
  await sleep(20);
  stdin.write(host.encodeNativeMessage(f.construction.ready));
  let binding;
  for (let i = 0; i < 100; i++) {
    try { binding = JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(5);
  }
  assert.ok(binding, 'startup publishes a complete readiness record within the original wait budget');
  assert.equal(native.length, 0, 'startup hello must not self-confirm a retry budget');
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    try { healthy = (await f.client.providerRequest(binding.endpoint, 'attest', {})).healthy; }
    catch (error) { if (error.code !== 'NATIVE_UPDATE_IN_PROGRESS') throw error; }
    if (!healthy) await sleep(5);
  }
  assert.equal(healthy, true);
  assert.equal(partialPublications, 1, 'the owned readiness write crossed an incomplete-JSON publication interval');
  assert.ok(native.some(r => r.method === 'profile.read' && r.params.profileToken === TOKEN));
  const before = native.length;
  replyToProfile = false;
  const pending = f.client.providerRequest(binding.endpoint, 'attest', {}, { timeoutMs: 1000 });
  const disconnected = assert.rejects(pending, code('NATIVE_PROVIDER_DISCONNECTED'));
  for (let i = 0; i < 100 && native.length === before; i++) await sleep(5);
  assert.ok(native.length > before, 'owned pending native request must actually dispatch');
  const endStarted = Date.now();
  stdin.end();
  assert.deepEqual(await completed, { closed: true });
  await disconnected;
  assert.ok(Date.now() - endStarted < 500, 'EOF closes pending requests, not their 10-second deadline');
  await assert.rejects(fs.lstat(f.config.nativeReadyFile), { code: 'ENOENT' });
  stdout.destroy(); stderr.destroy();
});

test('persistent startup admission failure cannot replenish current A three-attempt native budget', { skip: !actualCli }, async t => {
    const f = await fixture(t); // Its protected ready path deliberately occupies admission.
    const { createBackground } = await import('../../../../../plugins/desk/browser-extension/background.mjs');
    const { startNativeProvider } = await import(new URL('src/browser/native-provider.mjs', rootUrl));
    const { NativeCommandTransport } = await import(new URL('src/browser/native-transport.mjs', rootUrl));
    const event = () => {
      const listeners = new Set();
      return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
        emit: (...args) => { for (const fn of [...listeners]) fn(...args); } };
    };
    let attempts = 0, allocations = 0;
    const statuses = [], pending = new Set(), transports = [], admitted = new Set();
    const api = {
      tabs: { onUpdated: event(), onRemoved: event(), onCreated: event(), onDetached: event(),
        create() { allocations++; throw Error('no allocation admitted'); } },
      debugger: { onEvent: event(), onDetach: event() },
      runtime: {
        id: EXTENSION, onInstalled: event(), onStartup: event(),
        getURL: value => f.config.extensionOrigin + value,
        getContexts: async () => [{ documentUrl: f.config.extensionOrigin + 'token.html' }],
        sendMessage: async () => ({ token: TOKEN }),
        connectNative() {
          attempts++;
          let transport;
          const port = { onMessage: event(), onDisconnect: event(), disconnect() { transport?.close(); },
            postMessage(message) {
              if (message.event !== 'ready') { transport.receive(message); return; }
              transport = new NativeCommandTransport({ send: request => port.onMessage.emit(request) });
              transports.push(transport);
              const attempt = startNativeProvider({ ...f.construction, ready: message, transport })
                .then(provider => { admitted.add(provider); return provider; })
                .catch(() => {
                  api.runtime.lastError = { message: 'owned synthetic native admission failure' };
                  port.onDisconnect.emit(); delete api.runtime.lastError;
                });
              pending.add(attempt);
              attempt.finally(() => pending.delete(attempt));
            } };
          return port;
        },
      },
    };
    const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms === 5000 ? 2000 : 0), clearTimeout };
    const engine = createBackground(api, { sourceDigest: SOURCE, timers, onStatus: value => statuses.push(value) });
    try {
      for (let i = 0; i < 100 && !statuses.includes('native_host_unavailable') && attempts < 5; i++) await sleep(10);
      await sleep(30);
      assert.equal(attempts, 3, 'failed startup cannot self-confirm a new retry budget');
      assert.equal(statuses.filter(s => s === 'native_transport_confirmed').length, 0);
      assert.equal(allocations, 0);
      await f.provider.close(); // Release only this owned fixture's reservation.
      api.runtime.onStartup.emit(); // A later ordinary eligible wake is allowed.
      let healthy = false;
      for (let i = 0; i < 100 && !healthy; i++) {
        try {
          const ready = JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8'));
          healthy = (await f.client.providerRequest(ready.endpoint, 'attest', {})).healthy;
        } catch (error) {
          if (error.code && !['ENOENT', 'NATIVE_UPDATE_IN_PROGRESS', 'NATIVE_PROVIDER_DISCONNECTED'].includes(error.code)) throw error;
        }
        if (!healthy) await sleep(5);
      }
      assert.equal(healthy, true);
      assert.equal(attempts, 4);
      assert.equal(statuses.filter(s => s === 'native_transport_confirmed').length, 1);
      assert.equal(allocations, 0);
    } finally {
      engine.stop();
      for (const transport of transports) transport.close();
      await Promise.allSettled([...pending]);
      for (const provider of admitted) await provider.close();
    }
});

test('actual Registry loadEntry inventories both owners without pruning or unlinking', { skip: !actualCli }, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  const a = await f.owner(A), b = await f.owner(B);
  const live = net.createServer(socket => socket.end());
  await new Promise(resolve => live.listen(b.layout.socketPath, resolve));
  t.after(() => new Promise(resolve => live.close(resolve)));
  const beforeHome = process.env.HOME, beforeCwd = process.cwd();
  const snapshot = await f.inventory.snapshot();
  assert.equal(snapshot.owners.length, 2);
  assert.equal(snapshot.owners.find(o => o.contextId === A).cli, 'absent');
  assert.equal(snapshot.owners.find(o => o.contextId === B).cli, 'active');
  assert.equal(process.env.HOME, beforeHome); assert.equal(process.cwd(), beforeCwd);
  await assert.rejects(f.provider.invoke('prepareUpdate', {}), code('NATIVE_UPDATE_OWNERS_UNSETTLED'));
  assert.ok((await fs.lstat(a.layout.sessionFile)).isFile());
  if (process.platform === 'win32') {
    assert.equal(live.listening, true);
    assert.equal(live.address(), b.layout.socketPath);
  } else assert.ok((await fs.lstat(b.layout.socketPath)).isSocket());
});

test('actual unreachable Unix owner socket and maintained metadata are never pruned', {
  skip: !actualCli || process.platform === 'win32',
}, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  const o = await f.owner(A);
  const script = path.join(f.root, 'owned-unix-fixture.mjs');
  const startUrl = new URL('../../../../../plugins/desk/mcp/src/readiness/process-start.js', import.meta.url).href;
  await put(script, `import net from 'node:net';
import {readProcessStart} from ${JSON.stringify(startUrl)};
const start=await readProcessStart(process.pid);
const server=net.createServer();
server.listen(${JSON.stringify(o.layout.socketPath)},()=>process.stdout.write(JSON.stringify({pid:process.pid,start})+'\\n'));
process.stdin.once('data',()=>process.exit(0));`);
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  let text = '';
  const observed = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) resolve(JSON.parse(text.trim())); });
  });
  assert.equal(observed.pid, child.pid); assert.ok(observed.start);
  t.diagnostic(`C owned socket fixture path=${script}; pid=${observed.pid}; start=${observed.start}`);
  child.stdin.end('exit\n');
  assert.equal(await exit, 0);
  const socketIdentity = (await fs.lstat(o.layout.socketPath, { bigint: true })).ino;
  const snapshot = await f.inventory.snapshot();
  assert.equal(snapshot.owners[0].cli, 'unknown');
  assert.equal((await fs.lstat(o.layout.socketPath, { bigint: true })).ino, socketIdentity);
  assert.ok((await fs.stat(o.layout.sessionFile)).isFile());
  await assert.rejects(f.provider.invoke('prepareUpdate', {}), code('NATIVE_UPDATE_OWNERS_UNSETTLED'));
  t.diagnostic(`C exact socket fixture reaped pid=${observed.pid}; socket retained until owned-root cleanup`);
});

test('startup malformed unrecognized and differently bound owners remain unknown', { skip: !actualCli }, async t => {
  for (const kind of ['startup', 'bad', 'config', 'binding', 'metadata-binding', 'unrecognized']) {
    const f = await fixture(t, { trustedBaseline: true });
    if (kind === 'unrecognized') await fs.mkdir(path.join(f.config.browserStateRoot, 'signed-in', 'unrecognized'), { recursive: true });
    else {
      const o = await f.owner(A, { startup: kind === 'startup', bad: kind === 'bad' });
      if (kind === 'binding') await put(path.join(o.directory, 'config/browser.json'), {
        extension: true, browser: {}, deskNativeContext: { ...o.record, sourceDigest: 'd'.repeat(64) },
      });
      if (kind === 'config') await put(path.join(o.directory, 'config/browser.json'), {
        extension: true, browser: [], deskNativeContext: o.record,
      });
      if (kind === 'metadata-binding') await put(o.layout.sessionFile, {
        ...o.metadata, browser: { ...o.metadata.browser, userDataDir: path.join(f.root, 'foreign-profile') },
      }, 0o644);
    }
    const snapshot = await f.inventory.snapshot();
    assert.ok(snapshot.owners.some(o => o.cli === 'unknown'));
    await assert.rejects(f.provider.invoke('prepareUpdate', {}), code('NATIVE_UPDATE_OWNERS_UNSETTLED'));
  }
});

test('only observed native discard plus independent exact CLI absence settles every owner', { skip: !actualCli }, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  await f.owner(A); await f.owner(B);
  for (const contextId of [A, B]) {
    await f.provider.invoke('dispatch', { contextId, method: 'context.create', params: { label: 'fixture', relayUrl: `ws://127.0.0.1:1234/extension/${A}` } });
    await f.provider.invoke('dispatch', { contextId, method: 'context.discard', params: {} });
  }
  const ticket = await f.provider.invoke('prepareUpdate', {});
  assert.match(ticket.ticket, /^[a-f0-9]{64}$/);
  await assert.rejects(f.provider.invoke('cancelUpdate', { ticket: 'f'.repeat(64) }), code('NATIVE_UPDATE_TICKET_INVALID'));
  await f.provider.invoke('cancelUpdate', { ticket: ticket.ticket });
  await assert.rejects(f.provider.invoke('reload', { ticket: ticket.ticket }), code('NATIVE_UPDATE_TICKET_INVALID'));
});

test('freeze precedes async snapshot; pending pre-session effects and forged receipts cannot grant update', { skip: !actualCli }, async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { trustedBaseline: true, onRequest: async r => {
    if (r.method === 'context.create') { entered(); await blocked; }
  } });
  await f.owner(A);
  const create = f.provider.invoke('dispatch', { contextId: A, method: 'context.create', params: {} });
  await started;
  const checking = f.provider.invoke('prepareUpdate', {});
  const refused = assert.rejects(checking, code('NATIVE_UPDATE_OWNERS_UNSETTLED'));
  await assert.rejects(f.provider.invoke('dispatch', { contextId: A, method: 'context.resume', params: {} }), code('NATIVE_UPDATE_IN_PROGRESS'));
  release(); await create; await refused;
  await assert.rejects(f.provider.invoke('prepareUpdate', { discarded: true, cliStopped: true }), code('NATIVE_REQUEST_INVALID'));
});

test('post-prepare cancellation disconnect and expiry retain an explicit update obligation', { skip: !actualCli }, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  const ticket = await f.provider.invoke('prepareUpdate', {});
  await f.provider.invoke('reload', { ticket: ticket.ticket });
  await assert.rejects(f.provider.invoke('cancelUpdate', { ticket: ticket.ticket }), code('NATIVE_UPDATE_PREPARED_OBLIGATION'));
  f.transport.close();
  await assert.rejects(f.provider.invoke('commit', { ticket: ticket.ticket }), error =>
    error.code === 'NATIVE_TRANSPORT_DISCONNECTED' && error.resources.update === 'prepared');
  const g = await fixture(t, { trustedBaseline: true, updateTtlMs: 10 });
  const expiring = await g.provider.invoke('prepareUpdate', {});
  await sleep(20);
  await assert.rejects(g.provider.invoke('reload', { ticket: expiring.ticket }), code('NATIVE_UPDATE_TICKET_EXPIRED'));
});

test('profile source and fresh ancestry failures refuse without leaking native secrets', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  f.setPin('d'.repeat(64));
  await assert.rejects(f.provider.invoke('attest', {}), error =>
    error.code === 'NATIVE_PROFILE_MISMATCH' && !JSON.stringify(error).includes(TOKEN));
  f.setPin(null);
  await assert.rejects(f.provider.invoke('attest', {}), code('NATIVE_PROFILE_TOKEN_UNAVAILABLE'));
});

test('lazy client returns only a closure and reattests exact ready/profile/source binding', { skip: !actualCli }, async t => {
  const protocolWrite = process.stdout.write;
  const f = await fixture(t);
  const o = await f.owner(A);
  const selection = { ...f.selection, browserExecutable: f.config.browserExecutable };
  const client = await f.client.attestNativeContext(o.record, selection, { readAncestry: async () => structuredClone(chain) });
  assert.equal(process.stdout.write, protocolWrite, 'secret hook must not corrupt binary/native/test stdout');
  assert.deepEqual(JSON.parse(JSON.stringify(client)), { contextId: A });
  await assert.rejects(client.request('context.resume', {}), code('native_context_unavailable'));
  assert.equal(f.requests.some(r => r.method === 'context.create'), false);
  await assert.rejects(f.client.attestNativeContext({ ...o.record, contextId: undefined }, selection), code('NATIVE_CONFIG_INVALID'));
  await assert.rejects(f.client.attestNativeContext(o.record, { ...selection, profileDirName: 'Profile 1' }),
    code('NATIVE_SELECTION_MISMATCH'));
  const ready = JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8'));
  await fs.rename(f.config.nativeReadyFile, f.config.nativeReadyFile + '.retained');
  await put(f.config.nativeReadyFile, ready);
  await assert.rejects(client.request('context.status', {}), code('NATIVE_READY_CHANGED'));
  f.options.expectedCloseError = 'NATIVE_STATE_CHANGED';
  await assert.rejects(f.provider.close(), code('NATIVE_STATE_CHANGED'));
});

test('preparation can be exactly cancelled when new owner files appear but no native preparation ran', { skip: !actualCli }, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  const ticket = await f.provider.invoke('prepareUpdate', {});
  await f.owner(A, { startup: true });
  assert.deepEqual(await f.provider.invoke('cancelUpdate', { ticket: ticket.ticket }), { cancelled: true });
  assert.equal(f.requests.some(r => r.method === 'extension.reload'), false);
});

test('strict nine-field config rejects coercion and ordinary module load has no native side effects', async () => {
  const file = new URL('web-native-messaging.cjs', rootUrl);
  const source = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n'), /=>|`|\?\.|\blet\s|\bconst\s|\basync\s/u);
  const module = { exports: {} };
  const load = new vm.Script('(function(require,module,exports){' + source + '\n})').runInThisContext();
  load(name => {
    assert.ok(['fs', 'path'].includes(name), 'ordinary require may load built-ins fs/path only');
    return require(name);
  }, module, module.exports);
  const base = { version: 1, contextId: A, label: 'fixture', channel: 'msedge', userDataDir: path.resolve('fixture-profile'),
    profileDirName: 'Default', nativeReadyFile: path.resolve('fixture-ready.json'), extensionId: EXTENSION, sourceDigest: SOURCE };
  assert.doesNotThrow(() => module.exports.validateNativeRecord(base));
  for (const patch of [
    { sourceDigest: [SOURCE] }, { extensionId: [EXTENSION] }, { contextId: new String(A) },
    { sourceDigest: new String(SOURCE) }, { userDataDir: new String(base.userDataDir) },
    { profileDirName: '../Default' }, { label: '\u0000' }, { version: 2 }, { clientName: 'not-authority' },
  ]) assert.throws(() => module.exports.validateNativeRecord({ ...base, ...patch }), code('NATIVE_CONFIG_INVALID'));
});

test('a client freezes its declared context instead of following caller object mutation', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  const a = await f.owner(A); await f.owner(B);
  const client = await f.client.attestNativeContext(a.record, { ...f.selection, browserExecutable: f.config.browserExecutable },
    { readAncestry: async () => structuredClone(chain) });
  a.record.contextId = B;
  await assert.rejects(client.request('context.resume', {}), code('native_context_unavailable'));
  assert.equal(f.requests.filter(r => r.method === 'context.resume').at(-1).contextId, A);
});

test('old provider authority stops before native traffic when its ready reservation is replaced', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  const ready = JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8'));
  await fs.rename(f.config.nativeReadyFile, f.config.nativeReadyFile + '.retained');
  await put(f.config.nativeReadyFile, { ...ready, generation: B });
  const before = f.requests.length;
  f.options.expectedCloseError = 'NATIVE_STATE_CHANGED';
  await assert.rejects(f.provider.invoke('attest', {}), code('NATIVE_READY_CHANGED'));
  assert.equal(f.requests.length, before);
  assert.equal(JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8')).generation, B);
});

test('crossed native results and malformed discard never become affirmative cleanup', { skip: !actualCli }, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  await f.owner(A);
  f.options.overrideResponse = request => request.method === 'context.create' ? { contextId: B, state: 'ready' } : undefined;
  await assert.rejects(f.provider.invoke('dispatch', { contextId: A, method: 'context.create', params: {} }),
    code('NATIVE_CONTEXT_UNCONFIRMED'));
  f.options.overrideResponse = request => request.method === 'context.discard' ? {
    contextId: A, discarded: true, closedTabIds: [10], absentTabIds: [],
    releasedRevokedTabs: [{ tabId: 10, windowId: 1 }],
  } : undefined;
  await assert.rejects(f.provider.invoke('dispatch', { contextId: A, method: 'context.discard', params: {} }),
    code('NATIVE_CONTEXT_UNCONFIRMED'));
});

test('malformed tickets refuse with a fixed code instead of native buffer exceptions', { skip: !actualCli }, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  const ticket = await f.provider.invoke('prepareUpdate', {});
  await assert.rejects(f.provider.invoke('cancelUpdate', { ticket: [ticket.ticket] }), code('NATIVE_UPDATE_TICKET_INVALID'));
});

test('mediator refresh requires fresh same-browser profile and source and resumes without replacement', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  const a = await f.owner(A);
  const request = { contextId: A, method: 'context.create', params: { label: 'fixture', relayUrl: `ws://127.0.0.1:1234/extension/${A}` } };
  await f.provider.invoke('dispatch', request);
  let current = structuredClone(chain);
  const client = await f.client.attestNativeContext(a.record, { ...f.selection, browserExecutable: f.config.browserExecutable },
    { readAncestry: async () => structuredClone(current) });
  // Keep the old inode allocated so this replacement-generation case cannot
  // turn into same-inode reuse on a filesystem that immediately recycles it.
  const priorReady = await fs.open(f.config.nativeReadyFile, 'r');
  t.after(() => priorReady.close());
  await f.provider.close();
  await assert.rejects(client.refresh(), code('NATIVE_ATTESTATION_UNAVAILABLE'));
  f.resetNative();
  current[0].pid = 301; current[0].parentPid = 201; current[0].startIdentity = 'new-runtime';
  current[1].pid = 201; current[1].startIdentity = 'new-entry';
  const transport = new EventEmitter();
  transport.request = f.transport.request;
  transport.close = () => { f.transport.close(); transport.emit('close'); };
  const { startNativeProvider } = await import(new URL('src/browser/native-provider.mjs', rootUrl));
  const next = await startNativeProvider({ ...f.construction, chain: current, transport,
    processReader: async pid => structuredClone(current.find(p => p.pid === pid)) });
  servers.add(next);
  t.after(async () => { try { await next.close(); } finally { servers.delete(next); } });
  const currentReady = await fs.stat(f.config.nativeReadyFile, { bigint: true });
  const previousReady = await priorReady.stat({ bigint: true });
  assert.notEqual(`${currentReady.dev}:${currentReady.ino}`, `${previousReady.dev}:${previousReady.ino}`);
  await assert.rejects(client.request('context.resume', {}), error => ['NATIVE_READY_CHANGED', 'NATIVE_ATTESTATION_UNAVAILABLE'].includes(error.code));
  assert.deepEqual(await client.refresh(), { available: true, contextId: A });
  assert.equal((await client.request('context.resume', {})).contextId, A);
  assert.equal(f.requests.filter(r => r.method === 'context.create').length, 1);
  await assert.rejects(next.invoke('prepareUpdate', {}), code('NATIVE_UPDATE_OWNERS_UNSETTLED'));
});

test('exact reload and commit remain reconciliation obligations and cannot be replayed or cancelled', { skip: !actualCli }, async t => {
  const f = await fixture(t, { trustedBaseline: true });
  const ticket = await f.provider.invoke('prepareUpdate', {});
  assert.deepEqual(await f.provider.invoke('reload', { ticket: ticket.ticket }), { prepared: true, reconciliationRequired: true });
  assert.deepEqual(await f.provider.invoke('commit', { ticket: ticket.ticket }), { committing: true, reconciliationRequired: true });
  await assert.rejects(f.provider.invoke('commit', { ticket: ticket.ticket }), code('NATIVE_UPDATE_TICKET_INVALID'));
  await assert.rejects(f.provider.invoke('cancelUpdate', { ticket: ticket.ticket }), code('NATIVE_UPDATE_PREPARED_OBLIGATION'));
  assert.equal(f.requests.filter(r => r.method === 'extension.reload.commit').length, 1);
});

test('EOF during selected-pin startup cannot publish a provider after the native port ended', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  await f.provider.close();
  const { runNativeEntry } = await import(new URL('native-host.mjs', rootUrl));
  const host = await import(new URL('src/browser/native-host.mjs', rootUrl));
  const configFile = await entryConfiguration(f);
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const entryChain = structuredClone(chain); entryChain[0].pid = process.pid;
  let selected, created = 0;
  const selecting = new Promise(resolve => { selected = resolve; });
  const create = http.createServer;
  t.mock.method(http, 'createServer', function (...args) { created++; return create.apply(this, args); });
  const running = runNativeEntry({ stdin, stdout, stderr, origin: f.config.extensionOrigin, configFile,
    processReader: async pid => structuredClone(entryChain.find(p => p.pid === pid)),
    providerOptions: { ...f.construction, readProfileToken: async () => { selected(); await sleep(50); return TOKEN; } } });
  const completed = settled(running);
  t.after(async () => {
    stdin.end();
    await completed;
    stdout.destroy(); stderr.destroy();
  });
  await sleep(20);
  stdin.write(host.encodeNativeMessage(f.construction.ready));
  await Promise.race([selecting, completed.then(result => {
    if (result.error) throw result.error;
    assert.fail('native entry ended before selected-pin startup');
  })]);
  stdin.end();
  await assert.rejects(running, code('NATIVE_PROVIDER_START_FAILED'));
  assert.equal(created, 0);
  await assert.rejects(fs.lstat(f.config.nativeReadyFile), { code: 'ENOENT' });
});
