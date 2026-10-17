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
import { readProcessStart } from '../../../../../plugins/desk/mcp/src/readiness/process-start.js';
import vm from 'node:vm';
import { mkTempRoot } from '../_temp_roots.js';
import { removeTree } from '../_remove_tree.js';
import { BrokerError } from '../../../../../plugins/desk/mcp/src/util/broker-error.mjs';

const require = createRequire(import.meta.url);
const rootUrl = new URL('../../../../../plugins/desk/mcp/', import.meta.url);
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64), SOURCE = 'b'.repeat(64), EXTENSION = 'c'.repeat(32);
const actualCli = process.env.DESK_TEST_MAINTAINED_CLI_DIR;
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
    await fs.mkdir(path.dirname(layout.socketPath), { recursive: true, mode: 0o700 });
    const metadata = { name: id, version: inventory.version, timestamp: Date.now(), workspaceDir: directory,
      attached: true, cli: { persistent: true }, browser: {
        browserName: 'chromium', launchOptions: {}, userDataDir: config.userDataDir,
      },
      socketPath: layout.socketPath };
    if (!settings.startup) await put(layout.sessionFile, settings.bad ? '{' : metadata, 0o644);
    return { id, directory, layout, record, metadata };
  }
  let pin = TOKEN, alive = true;
  const requests = [], contexts = new Map();
  const transport = new EventEmitter();
  transport.request = async message => {
    requests.push(structuredClone(message));
    await options.onRequest?.(message);
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
  transport.close = () => { alive = false; transport.emit('close'); };
  const construction = {
    config, ready: { event: 'ready', protocolVersion: 1, extensionId: EXTENSION, sourceDigest: SOURCE, profileToken: TOKEN },
    chain, transport, inventory, processReader: options.processReader || reader,
    resolveSelection: async () => selection, readProfileToken: async () => pin,
    verifyContinuity: options.trustedBaseline ? async evidence => ({
      generation: evidence.generation, bindingDigest: evidence.bindingDigest, snapshotDigest: evidence.snapshot.digest,
      baselineId: A,
    }) : undefined,
    updateTtlMs: options.updateTtlMs || 1000,
    protectSecret() {},
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
    client: require(new URL('web-native-messaging.cjs', rootUrl).pathname) };
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
  const real = require(new URL('web-real-profile.cjs', rootUrl).pathname);
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
  const client = require(new URL('web-native-messaging.cjs', rootUrl).pathname);
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
  const client = require(new URL('web-native-messaging.cjs', rootUrl).pathname);
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

test('native entry initialization receives its own profile reply without a frame-chain deadlock', { skip: !actualCli }, async t => {
  const f = await fixture(t);
  await f.provider.close();
  const { runNativeEntry } = await import(new URL('native-host.mjs', rootUrl));
  const host = await import(new URL('src/browser/native-host.mjs', rootUrl));
  const configFile = path.join(f.root, 'entry', 'provider-config.json');
  await put(configFile, f.config);
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
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await fs.stat(f.config.nativeReadyFile); ready = true; break; } catch {}
    await sleep(5);
  }
  assert.equal(ready, true);
  assert.equal(native.length, 0, 'startup hello must not self-confirm a retry budget');
  const binding = JSON.parse(await fs.readFile(f.config.nativeReadyFile, 'utf8'));
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    try { healthy = (await f.client.providerRequest(binding.endpoint, 'attest', {})).healthy; }
    catch (error) { if (error.code !== 'NATIVE_UPDATE_IN_PROGRESS') throw error; }
    if (!healthy) await sleep(5);
  }
  assert.equal(healthy, true);
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
  assert.ok((await fs.lstat(b.layout.socketPath)).isSocket());
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
  const configFile = path.join(f.root, 'entry', 'provider-config.json');
  await put(configFile, f.config);
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const entryChain = structuredClone(chain); entryChain[0].pid = process.pid;
  let selected, created = 0;
  const selecting = new Promise(resolve => { selected = resolve; });
  const create = http.createServer;
  t.mock.method(http, 'createServer', function (...args) { created++; return create.apply(this, args); });
  const running = runNativeEntry({ stdin, stdout, stderr, origin: f.config.extensionOrigin, configFile,
    processReader: async pid => structuredClone(entryChain.find(p => p.pid === pid)),
    providerOptions: { ...f.construction, readProfileToken: async () => { selected(); await sleep(50); return TOKEN; } } });
  const refused = assert.rejects(running, code('NATIVE_PROVIDER_START_FAILED'));
  await sleep(20);
  stdin.write(host.encodeNativeMessage(f.construction.ready));
  await selecting;
  stdin.end();
  await refused;
  assert.equal(created, 0);
  await assert.rejects(fs.lstat(f.config.nativeReadyFile), { code: 'ENOENT' });
  stdout.destroy(); stderr.destroy();
});
