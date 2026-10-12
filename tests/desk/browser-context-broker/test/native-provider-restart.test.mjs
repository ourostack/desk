// The native provider wired to the real extension code: the extension's service worker keeps its own lease map across native
// host restarts, which a mock transport does not, and that is the state that kept the provider down on 2026-10-12.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = new URL('../../../../plugins/desk/', import.meta.url);
const { startNativeProvider } = await import(new URL('browser-context-broker/src/native-provider.mjs', root));
const { readRegistry } = await import(new URL('browser-context-broker/src/registry.mjs', root));
const { createBrowserExtension } = await import(new URL('browser-extension/background.js', root));
const { browser, fakeChrome, host, processReader } = await import('./fixtures/native-extension.mjs');

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
