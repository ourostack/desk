// 2026-10-12 end to end: many sessions, ownership records left by sessions that are gone, a busy page flooding the native host
// with events, and the native host killed while calls are under way. Every live session must carry on by itself, and nothing may
// be left behind once the sessions end. The provider, the extension's service worker and the session client are the real code;
// only chrome.* and the operating system's processes are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const root = new URL('../../../../plugins/desk/', import.meta.url);
const { startNativeProvider } = await import(new URL('browser-context-broker/src/native-provider.mjs', root));
const { readRegistry } = await import(new URL('browser-context-broker/src/registry.mjs', root));
const { createBrowserExtension } = await import(new URL('browser-extension/background.js', root));
const { readProcessStart } = await import(new URL('mcp/src/readiness/process-start.js', root));
const { createNativeSession } = createRequire(import.meta.url)(new URL('mcp/web-native-messaging.cjs', root).pathname);
const { browser, fakeChrome, host, processReader } = await import('./fixtures/native-extension.mjs');

const LIVE = 24;
const GONE = 16;
const STALE = 40;

// A process that is gone by the time the provider looks, whose start the provider confirmed while it ran.
async function goneProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise(resolve => child.once('spawn', resolve));
  const start = await readProcessStart(child.pid);
  return { pid: child.pid, start, end: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); }) };
}

test('GivenThe2026_10_12Shape_WhenTheNativeHostDiesMidUse_EveryLiveSessionRecoversAndNothingIsLeftBehind',
  { skip: process.platform === 'win32', timeout: 120_000 }, async t => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'desk-native-replay-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const chrome = fakeChrome({ createDelayMs: 20 });
    const extension = createBrowserExtension(chrome.chrome, { onStatus() {} });
    const providers = [];
    async function startHost(generation) {
      const { transport, contextIdentity } = host(extension, generation);
      const provider = await startNativeProvider({ stateDir, transport, contextIdentity, processReader, ownerGraceMs: 0 });
      providers.push(provider);
      return { provider, transport };
    }
    t.after(() => Promise.all(providers.map(provider => provider.close())));
    let current = await startHost('host-1');

    // Ownership records from sessions that ended without releasing.
    const gone = [];
    for (let index = 0; index < GONE; index++) {
      const owner = await goneProcess(t);
      gone.push((await current.provider.invoke('acquire', { owner: `gone-${index}`, ownerPid: owner.pid, ownerStart: owner.start })).leaseId);
      await current.provider.invoke('ensureWindow', { leaseId: gone.at(-1), owner: `gone-${index}` });
      await owner.end();
    }
    const stale = [];
    for (let index = 0; index < STALE; index++) stale.push((await current.provider.invoke('acquire', { owner: `stale-${index}` })).leaseId);

    // Live sessions, each with its own window.
    const readyFile = current.provider.readyFile;
    const sessions = Array.from({ length: LIVE }, () => createNativeSession({ endpoint: 'unused', readyFile, processIdentity: browser,
      readyPollMs: 20, readyWaitMs: 10_000 }));
    await Promise.all(sessions.map((session, index) => session.setOwner(`live-${index}`)));
    await Promise.all(sessions.map(session => session.ensureWindow()));

    // A busy page floods the host with events while every session is opening a new window, and the host dies.
    await Promise.all(sessions.map(session => session.clear(() => {})));
    for (let index = 0; index < 5000; index++) {
      current.transport.receive({ event: 'cdp', leaseId: 'busy-page', tabId: 1, method: 'Network.dataReceived', params: { index } });
    }
    const inFlight = Promise.allSettled(sessions.map(session => session.resume().then(() => session.ensureWindow())));
    await new Promise(resolve => setTimeout(resolve, 5));
    await current.provider.close();
    current.transport.close();
    const interrupted = (await inFlight).filter(result => result.status === 'rejected');
    assert.ok(interrupted.length > 0, 'the host died while calls were under way');

    // The stale records ran out while no provider ran.
    const registryFile = path.join(stateDir, 'registry.json');
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    for (const id of stale) registry.leases[id].expiresAt = new Date(Date.now() - 7_200_000).toISOString();
    await writeFile(registryFile, JSON.stringify(registry));

    // The browser starts a new host a moment later; nobody does anything by hand.
    const restarted = new Promise(resolve => setTimeout(() => resolve(startHost('host-2')), 200));
    const results = await Promise.allSettled(sessions.map(session => session.resume().then(() => session.ensureWindow())));
    current = await restarted;
    assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason?.code ?? result.reason?.message), [],
      'every live session carries on through the new host');
    for (const result of results) assert.match(result.value.targetId, /^[^:]+:\d+$/u);

    await current.provider.sweep();
    const remaining = Object.keys((await readRegistry(stateDir)).leases);
    assert.equal(remaining.length, LIVE, 'only the live sessions own anything');
    assert.equal(remaining.some(id => gone.includes(id) || stale.includes(id)), false);

    await Promise.all(sessions.map(session => session.release()));
    await current.provider.sweep();
    assert.deepEqual(Object.keys((await readRegistry(stateDir)).leases), [], 'no ownership record is left');
    assert.equal(chrome.tabs.size, 0, 'no owned tab is left open');
  });
