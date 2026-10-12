// The native provider wired to the real extension code: the extension's service worker keeps its own lease map across native
// host restarts, which a mock transport does not, and that is the state that kept the provider down on 2026-10-12.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = new URL('../../../../plugins/desk/', import.meta.url);
const { startNativeProvider } = await import(new URL('browser-context-broker/src/native-provider.mjs', root));
const { NativeCommandTransport } = await import(new URL('browser-context-broker/src/native-cdp.mjs', root));
const { readRegistry } = await import(new URL('browser-context-broker/src/registry.mjs', root));
const { createBrowserExtension } = await import(new URL('browser-extension/background.js', root));

const browser = { pid: 700, startIdentity: 'browser-1', owner: 'operator', executable: '/opt/browser', profileRoot: '/profiles/Default' };
const entry = { pid: 701, parentPid: 700, startIdentity: 'entry-1', owner: 'operator', executable: '/opt/entry', profileRoot: '/runtime' };
const runtime = { pid: 702, parentPid: 701, startIdentity: 'runtime-1', owner: 'operator', executable: '/opt/node', profileRoot: '/runtime' };
const token = 'a'.repeat(64);
const extensionId = 'bcejpajaingepdloiolbmbaflecgifbe';

function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}

// Just enough of chrome.* for lease binding and owner windows.
function fakeChrome() {
  let next = 1;
  let contexts = [];
  const tabs = new Map();
  const windows = new Map();
  const chrome = {
    runtime: { id: extensionId, onStartup: event(), onInstalled: event(), onMessage: event(),
      getURL: file => `chrome-extension://${extensionId}/${file}`, getContexts: async () => contexts, sendMessage: async () => ({ token }) },
    offscreen: { createDocument: async () => { contexts = [{ documentUrl: chrome.runtime.getURL('token.html') }]; } },
    windows: {
      get: async id => {
        if (!windows.has(id)) throw new Error('No window with id');
        return { id, left: 0, top: 0, width: 800, height: 600, state: 'normal' };
      },
      create: async params => {
        const id = next++;
        const tab = { id: next++, windowId: id, url: params.url, status: 'complete',
          title: params.url.startsWith('data:') ? 'Desk target marker' : '' };
        tabs.set(tab.id, tab);
        windows.set(id, { id });
        return { id, tabs: [tab] };
      },
    },
    tabs: {
      onCreated: event(), onRemoved: event(),
      get: async id => { const tab = tabs.get(id); if (!tab) throw new Error('No tab with id'); return { ...tab }; },
      update: async (id, params) => {
        const tab = tabs.get(id);
        Object.assign(tab, params);
        if (params.url?.includes('/control.html#')) {
          const { owner, work } = JSON.parse(decodeURIComponent(params.url.split('#')[1]));
          tab.title = `Desk | ${owner}${work === null || work === undefined ? '' : ` | ${work}`}`;
        }
        return { ...tab };
      },
      remove: async id => { if (!tabs.delete(id)) throw new Error('No tab with id'); chrome.tabs.onRemoved.emit(id, {}); },
    },
    debugger: { onEvent: event(), onDetach: event(),
      getTargets: async () => [...tabs.values()].map(tab => ({ id: `target-${tab.id}`, tabId: tab.id, type: 'page' })),
      attach: async () => {}, detach: async () => {},
      sendCommand: async ({ tabId }, method, params) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-${tabId}` } } };
        if (method === 'Runtime.evaluate') return { result: { value: true } };
        if (method === 'Page.navigate') tabs.get(tabId).url = params.url;
        return {};
      } },
  };
  return { chrome, tabs };
}

// One native host process: a transport to the extension and the provider it starts. The extension object outlives it.
function host(extension, generation) {
  const transport = new NativeCommandTransport({ send: async message => { transport.receive(await extension.dispatch(message)); } });
  return { transport, contextIdentity: { processIdentity: browser, mediationChain: [entry, runtime], endpointProcessIdentity: runtime,
    profileToken: token, transportGeneration: generation, browserVersion: 'Edg/155.0.0.0', userAgent: 'fixture',
    extensionSourceDigest: 'c'.repeat(64) } };
}

const processReader = async pid => [browser, entry, runtime].find(identity => identity.pid === pid);

async function stateDirectory(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'desk-native-restart-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

async function start(t, stateDir, extension, generation, extra = {}) {
  const { transport, contextIdentity } = host(extension, generation);
  const provider = await startNativeProvider({ stateDir, transport, contextIdentity, processReader, ...extra });
  t.after(() => provider.close());
  return { provider, transport };
}

test('GivenLiveExtension_WhenNativeHostRestarts_ProviderRestoresTheIdleLeaseInsteadOfExiting', async t => {
  const stateDir = await stateDirectory(t);
  const extension = createBrowserExtension(fakeChrome().chrome, { onStatus() {} });
  const first = await start(t, stateDir, extension, 'host-1');
  const acquired = await first.provider.invoke('acquire', { owner: 'session-a' });
  await first.provider.close();
  first.transport.close();

  // Edge starts a new host for the same extension service worker, which still has session-a bound.
  const second = await start(t, stateDir, extension, 'host-2');
  assert.equal(JSON.parse(await readFile(second.provider.readyFile, 'utf8')).transportGeneration, 'host-2');
  const resumed = await second.provider.invoke('resume', { leaseId: acquired.leaseId, owner: 'session-a', expectedProcessIdentity: browser });
  assert.equal(resumed.leaseId, acquired.leaseId, 'the live session keeps its lease across the host restart');
  const window = await second.provider.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'session-a' });
  assert.match(window.targetId, /^[^:]+:\d+$/u);
});

// The incident shape: 81 never-used leases hours past expiry and still bound in the live service worker, plus one live session
// whose lease expired while no provider ran.
test('GivenLiveExtensionAnd81ExpiredLeases_WhenNativeHostRestarts_ProviderIsReadyPrunedAndTheLiveSessionKeepsItsLease', async t => {
  const { readProcessStart } = await import(new URL('mcp/src/readiness/process-start.js', root));
  const stateDir = await stateDirectory(t);
  const extension = createBrowserExtension(fakeChrome().chrome, { onStatus() {} });
  const first = await start(t, stateDir, extension, 'host-1');
  const abandoned = [];
  for (let index = 0; index < 81; index++) abandoned.push((await first.provider.invoke('acquire', { owner: `gone-${index}` })).leaseId);
  const live = await first.provider.invoke('acquire', { owner: 'live', ownerPid: process.pid, ownerStart: await readProcessStart(process.pid) });
  await first.provider.close();
  first.transport.close();
  const registryFile = path.join(stateDir, 'registry.json');
  const registry = JSON.parse(await readFile(registryFile, 'utf8'));
  for (const lease of Object.values(registry.leases)) lease.expiresAt = new Date(Date.now() - 3_600_000).toISOString();
  await writeFile(registryFile, JSON.stringify(registry));

  const started = Date.now();
  const second = await start(t, stateDir, extension, 'host-2');
  await second.provider.sweep();
  assert.ok(Date.now() - started < 10_000);
  assert.ok((await stat(second.provider.readyFile)).isFile(), 'readiness is published');
  assert.deepEqual(Object.keys((await readRegistry(stateDir)).leases), [live.leaseId], 'the 81 abandoned leases are gone');
  const resumed = await second.provider.invoke('resume', { leaseId: live.leaseId, owner: 'live', expectedProcessIdentity: browser });
  assert.equal(resumed.leaseId, live.leaseId, 'a session whose process is alive keeps its lease through the provider outage');
});
