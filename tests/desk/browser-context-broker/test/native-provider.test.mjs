import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const moduleUrl = new URL('../../../../plugins/desk/browser-context-broker/src/native-provider.mjs', import.meta.url);
const processIdentity = { pid: 700, startIdentity: 'browser-1', owner: 'operator', executable: '/opt/browser', profileRoot: '/profiles/Default' };
const entry = { pid: 701, parentPid: 700, startIdentity: 'entry-1', owner: 'operator', executable: '/opt/entry', profileRoot: '/runtime' };
const runtime = { pid: 702, parentPid: 701, startIdentity: 'runtime-1', owner: 'operator', executable: '/opt/node', profileRoot: '/runtime' };
const contextIdentity = {
  processIdentity, mediationChain: [entry, runtime], endpointProcessIdentity: runtime,
  profileToken: 'a'.repeat(64), transportGeneration: 'native-host-1',
  browserVersion: 'Chrome/155.0.0.0', userAgent: 'fixture-agent', extensionSourceDigest: 'c'.repeat(64),
};

class Transport extends EventEmitter {
  calls = [];
  leases = new Map();
  next = 100;
  async request(message) {
    this.calls.push(message);
    const { leaseId, method, params } = message;
    if (method === 'lease.bind') {
      this.leases.set(leaseId, { tabs: [], windowId: ++this.next });
      return { bound: true };
    }
    if (method === 'lease.restore') {
      const current = this.leases.get(leaseId);
      if (!current || current.controlTabId !== params.controlTabId || current.controlMarker !== params.controlMarker) {
        throw new Error('exact control mismatch');
      }
      return { restored: true, controlVerified: params.rehydrateControl === true,
        windowId: current.windowId, controlTabId: current.controlTabId };
    }
    const lease = this.leases.get(leaseId);
    if (method === 'target.readback') return { ...lease, windows: [] };
    if (method === 'target.create') {
      if (!lease.controlTabId) {
        lease.controlTabId = ++this.next;
        lease.controlMarker = params.marker;
        lease.tabs.push({ tabId: lease.controlTabId, windowId: lease.windowId, control: true, title: 'owner', url: 'control' });
      }
      const tab = { tabId: ++this.next, windowId: ++this.next, url: params.markerUrl };
      lease.tabs.push(tab);
      return { ...tab, controlWindowId: lease.windowId, controlTabId: lease.controlTabId, controlMarker: lease.controlMarker };
    }
    if (method === 'target.attach') return {};
    if (method === 'target.command') {
      if (params.method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'native-' + params.tabId } } };
      if (params.method === 'Runtime.evaluate') return { result: { value: true } };
      if (params.method === 'Page.navigate') {
        lease.tabs.find(tab => tab.tabId === params.tabId).url = params.params.url;
        return { frameId: 'native-' + params.tabId };
      }
      if (params.method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'Peer owned button' } }] };
      return {};
    }
    if (method === 'purpose.set') return { title: 'Desk | native-test-owner' + (params.work === null ? '' : ' | ' + params.work) };
    if (method === 'target.close') {
      lease.tabs = lease.tabs.filter(tab => tab.tabId !== params.tabId);
      if (params.tabId === lease.controlTabId) {
        lease.controlTabId = undefined;
        lease.windowId = ++this.next;
      }
      return { closed: true };
    }
    if (method === 'lease.unbind') {
      if (lease.tabs.length) throw new Error('owned native tabs remain');
      this.leases.delete(leaseId);
      return { unbound: true };
    }
    throw new Error('unexpected native method');
  }
}

test('GivenNativeLeaseReleased_WhenAllTargetsClose_TransportBindingAndSourceLeaseAreRetired', async t => {
  const { service, transport } = await setup(t);
  const acquired = await service.invoke('acquire', { owner: 'native-test-owner' });
  await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: acquired.owner });
  const result = await service.invoke('release', { leaseId: acquired.leaseId, owner: acquired.owner });
  assert.equal(result.released, true);
  assert.ok(transport.calls.some(call => call.leaseId === acquired.leaseId && call.method === 'lease.unbind'));
  assert.equal(transport.leases.has(acquired.leaseId), false, 'permanent host cannot accumulate released native leases/create history');
  assert.deepEqual((await service.invoke('status')).leases, []);
});

async function setup(t) {
  const { startNativeProvider } = await import(moduleUrl);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'desk-native-provider-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const transport = new Transport();
  const service = await startNativeProvider({
    stateDir, transport, contextIdentity,
    processReader: async pid => [processIdentity, entry, runtime].find(identity => identity.pid === pid),
  });
  t.after(() => service.close());
  return { stateDir, transport, service };
}

test('GivenProviderUpdateGate_WhenQuiesced_NewAcquisitionAndLateRendererCommandsAreRefused', async t => {
  const { service, transport } = await setup(t);
  transport.pause = () => { transport.paused = true; };
  transport.resume = () => { transport.paused = false; };
  const update = await service.invoke('prepareUpdate', { expectedProcessIdentity: processIdentity });
  assert.match(update.updateToken, /^[a-f0-9]{64}$/u);
  assert.equal(transport.paused, true);
  await assert.rejects(service.invoke('acquire', { owner: 'new-owner' }),
    error => error.code === 'NATIVE_UPDATE_IN_PROGRESS');
  await service.invoke('cancelUpdate', { updateToken: update.updateToken });
  assert.equal(transport.paused, false);
  const acquired = await service.invoke('acquire', { owner: 'native-test-owner' });
  assert.ok(acquired.leaseId);
});

test('GivenLiveOwnedTargets_WhenExtensionUpdateRequested_ExistingOwnersBlockReloadWithoutAnyEffect', async t => {
  const { service, transport } = await setup(t);
  transport.pause = () => {};
  transport.resume = () => {};
  const acquired = await service.invoke('acquire', { owner: 'native-test-owner' });
  await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: acquired.owner });
  await assert.rejects(service.invoke('prepareUpdate', {
    expectedProcessIdentity: processIdentity, extensionSourceDigest: 'd'.repeat(64),
  }), error => error.code === 'NATIVE_UPDATE_ACTIVE_OWNERS' &&
    error.details?.owners?.includes(acquired.owner));
  assert.equal(transport.calls.some(call => call.method.startsWith('extension.reload')), false);
  const retained = await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: acquired.owner });
  assert.ok(retained.targetId);
});


test('GivenProviderReload_WhenHttpAcknowledged_OnlyThenExactNativeCommitIsDispatched', async t => {
  const { service, transport } = await setup(t);
  transport.pause = () => {};
  transport.resume = () => {};
  const permission = await service.invoke('prepareUpdate', { expectedProcessIdentity: processIdentity });
  const dispatched = [];
  const original = transport.request.bind(transport);
  transport.request = async message => {
    if (message.method.startsWith('extension.reload')) {
      assert.equal(message.params.updateToken, permission.updateToken);
      dispatched.push(message.method);
      return message.method === 'extension.reload' ? { reload: true } : { committing: true };
    }
    return original(message);
  };
  const ready = JSON.parse(await readFile(service.readyFile, 'utf8'));
  const response = await fetch(ready.endpoint, {
    method: 'POST', body: JSON.stringify({ operation: 'reloadExtension', payload: { updateToken: permission.updateToken } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.reconciliationRequired, true);
  await new Promise(setImmediate);
  assert.deepEqual(dispatched, ['extension.reload', 'extension.reload.commit']);
});

test('GivenProviderUpdateGate_WhenGenerationWrong_NoPauseOrReloadIsAuthorized', async t => {
  const { service, transport } = await setup(t);
  let paused = false;
  transport.pause = () => { paused = true; };
  transport.resume = () => { paused = false; };
  await assert.rejects(service.invoke('prepareUpdate', {
    expectedProcessIdentity: { ...processIdentity, startIdentity: 'foreign-browser' },
  }), error => error.code === 'NATIVE_BROWSER_GENERATION_MISMATCH');
  assert.equal(paused, false);
});

test('GivenProviderReady_WhenSerialized_OnlyPrivateFileCarriesItsCapability', async t => {
  const { service, stateDir } = await setup(t);
  const ready = JSON.parse(await readFile(service.readyFile, 'utf8'));
  assert.equal(ready.extensionSourceDigest, 'c'.repeat(64));
  assert.match(ready.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/provider\/[a-f0-9]{64}$/u);
  const capability = ready.endpoint.split('/').at(-1);
  assert.equal(JSON.stringify(service).includes(capability), false);
  assert.ok(service.readyFile.startsWith(stateDir + path.sep));
  const response = await fetch(ready.endpoint.replace(capability, '0'.repeat(64)), { method: 'POST', body: JSON.stringify({ operation: 'status' }) });
  assert.equal(response.status, 401);
});

test('GivenBoundProvider_WhenAttested_BrowserAndRuntimeStayTruthfullyDistinct', async t => {
  const { service } = await setup(t);
  const result = await service.invoke('attest', { expectedProcessIdentity: processIdentity });
  assert.equal(result.healthy, true);
  assert.deepEqual(result.processIdentity, processIdentity);
  assert.deepEqual(result.endpointProcessIdentity, runtime);
  assert.deepEqual(result.mediationChain, [entry, runtime]);
});

test('GivenOldProviderGeneration_WhenExpectedBrowserDiffers_AttestationFailsClosed', async t => {
  const { service } = await setup(t);
  await assert.rejects(service.invoke('attest', {
    expectedProcessIdentity: { ...processIdentity, startIdentity: 'browser-replacement' },
  }), error => error.code === 'NATIVE_BROWSER_GENERATION_MISMATCH');
});

test('GivenProviderTransportLoss_WhenAttested_LiveBrowserIsNotDeclaredAbsent', async t => {
  const { service, transport } = await setup(t);
  transport.emit('close');
  const result = await service.invoke('attest', { expectedProcessIdentity: processIdentity });
  assert.equal(result.healthy, false);
  assert.equal(result.reason, 'MEDIATOR_UNAVAILABLE');
  assert.equal(result.browserAbsence, undefined);
});

test('GivenUnsupportedBrowser_WhenProviderStarts_Explicit125DiagnosticRefuses', async t => {
  const { startNativeProvider } = await import(moduleUrl);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'desk-native-provider-version-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await assert.rejects(startNativeProvider({
    stateDir, transport: new Transport(),
    contextIdentity: { ...contextIdentity, browserVersion: 'Chrome/124.0.0.0' },
  }), error => error.code === 'NATIVE_BROWSER_VERSION_UNSUPPORTED' && error.message.includes('125'));
});

test('GivenNativeProviderAcquisition_WhenCatalogConnects_NoWindowIsCreated', async t => {
  const { service, transport } = await setup(t);
  const result = await service.invoke('acquire', { owner: 'native-test-owner' });
  assert.ok(result.leaseId);
  assert.match(result.endpoint, /^http:\/\/127\.0\.0\.1:/u);
  assert.equal(transport.calls.some(call => call.method === 'target.create'), false);
  assert.equal(JSON.stringify(await service.invoke('status')).includes(result.endpoint), false);
});

test('GivenConcurrentNativeFirstUse_WhenWindowEnsured_OneOwnedCreateOccurs', async t => {
  const { service, transport } = await setup(t);
  const acquired = await service.invoke('acquire', { owner: 'native-test-owner' });
  const results = await Promise.all([
    service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'native-test-owner' }),
    service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'native-test-owner' }),
  ]);
  assert.equal(results[0].targetId, results[1].targetId);
  assert.equal(transport.calls.filter(call => call.method === 'target.create').length, 1);
});

test('GivenWrongNativeOwner_WhenEnsureRequested_NoEffectIsDispatched', async t => {
  const { service, transport } = await setup(t);
  const acquired = await service.invoke('acquire', { owner: 'native-test-owner' });
  const count = transport.calls.length;
  await assert.rejects(service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'wrong-owner' }),
    error => error.code === 'NATIVE_LEASE_OWNER_MISMATCH');
  assert.equal(transport.calls.length, count);
});

test('GivenNativeProviderCleared_WhenEnsuredAgain_SameLeaseProxyGetsNewOwnWindow', async t => {
  const { service } = await setup(t);
  const acquired = await service.invoke('acquire', { owner: 'native-test-owner' });
  const payload = { leaseId: acquired.leaseId, owner: 'native-test-owner' };
  const first = await service.invoke('ensureWindow', payload);
  assert.equal((await service.invoke('clear', payload)).cleared, true);
  const second = await service.invoke('ensureWindow', payload);
  assert.notEqual(second.targetId, first.targetId);
  assert.equal(second.endpoint, acquired.endpoint);
  assert.equal((await service.invoke('release', payload)).released, true);
});

test('GivenOwnedNativePurpose_WhenSet_DiscoveryShowsAttributedWorkAndNullClearsIt', async t => {
  const { service } = await setup(t);
  const acquired = await service.invoke('acquire', { owner: 'native-test-owner' });
  const payload = { leaseId: acquired.leaseId, owner: 'native-test-owner' };
  const first = await service.invoke('ensureWindow', payload);
  assert.equal((await service.invoke('purpose', { ...payload, targetId: first.targetId, work: 'work' })).title, 'Desk | native-test-owner | work');
  const peers = await service.invoke('peers', payload);
  const record = peers.leases.find(lease => lease.leaseId === acquired.leaseId);
  assert.equal(record.work, 'work');
  assert.deepEqual(record.targetWindows, [{ targetId: first.targetId, windowId: record.windowId + 3 }]);
  assert.equal(JSON.stringify(peers).includes(acquired.endpoint), false);
  await service.invoke('purpose', { ...payload, targetId: first.targetId, work: null });
  assert.equal((await service.invoke('peers', payload)).leases.find(lease => lease.leaseId === acquired.leaseId).work, null);
});

test('GivenExplicitNativePeer_WhenPeeked_OnlyBoundedReadonlyAccessibilityCommandIsSent', async t => {
  const { service, transport } = await setup(t);
  const own = await service.invoke('acquire', { owner: 'native-test-owner' });
  const peer = await service.invoke('acquire', { owner: 'peer-owner' });
  const target = await service.invoke('ensureWindow', { leaseId: peer.leaseId, owner: 'peer-owner' });
  const count = transport.calls.length;
  const result = await service.invoke('peek', {
    leaseId: own.leaseId, owner: 'native-test-owner', peerLeaseId: peer.leaseId,
    targetId: target.targetId, format: 'snapshot',
  });
  assert.equal(result.nodes[0].name.value, 'Peer owned button');
  const dispatched = transport.calls.slice(count).filter(call => call.method === 'target.command');
  assert.equal(dispatched.some(call => call.params.method === 'Accessibility.getFullAXTree'), true);
  assert.equal(dispatched.some(call => call.params.method === 'Runtime.evaluate'), false);
  await assert.rejects(service.invoke('peek', {
    leaseId: own.leaseId, owner: 'native-test-owner', peerLeaseId: peer.leaseId,
    targetId: target.targetId, format: 'evaluate',
  }), error => error.code === 'NATIVE_PEEK_FORMAT_INVALID');
});

test('GivenNativeProviderReload_WhenBrowserAndControlRemain_ExactLeaseIsRestoredWithoutCreate', async t => {
  const { startNativeProvider } = await import(moduleUrl);
  const { service, transport, stateDir } = await setup(t);
  const acquired = await service.invoke('acquire', { owner: 'native-test-owner' });
  const original = await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'native-test-owner' });
  await service.close();
  const creates = transport.calls.filter(call => call.method === 'target.create').length;
  const replacement = await startNativeProvider({
    stateDir, transport,
    contextIdentity: { ...contextIdentity, transportGeneration: 'native-host-2' },
    processReader: async pid => [processIdentity, entry, runtime].find(identity => identity.pid === pid),
  });
  t.after(() => replacement.close());
  const resumed = await replacement.invoke('resume', {
    leaseId: acquired.leaseId, owner: 'native-test-owner', expectedProcessIdentity: processIdentity,
  });
  assert.equal(resumed.leaseId, acquired.leaseId);
  assert.notEqual(resumed.endpoint, acquired.endpoint);
  const restored = await replacement.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'native-test-owner' });
  assert.equal(restored.targetId, original.targetId);
  assert.equal(transport.calls.filter(call => call.method === 'target.create').length, creates);
  assert.equal(transport.calls.some(call => call.method === 'lease.restore'), true);
});


test('GivenRestoringNativeProvider_WhenLeaseRestoreIsPending_ReadinessIsNotPublishedEarly', async t => {
  const { startNativeProvider } = await import(moduleUrl);
  const { service, transport, stateDir } = await setup(t);
  const acquired = await service.invoke('acquire', { owner: 'native-test-owner' });
  await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'native-test-owner' });
  await service.close();
  let allowRestore;
  let entered;
  const paused = new Promise(resolve => { allowRestore = resolve; });
  const restoring = new Promise(resolve => { entered = resolve; });
  const original = transport.request.bind(transport);
  transport.request = async message => {
    if (message.method === 'lease.restore') { entered(); await paused; }
    return original(message);
  };
  const starting = startNativeProvider({
    stateDir, transport, contextIdentity: { ...contextIdentity, transportGeneration: 'replacement' },
    processReader: async pid => [processIdentity, entry, runtime].find(identity => identity.pid === pid),
  });
  await restoring;
  let replacement;
  try {
    await assert.rejects(readFile(service.readyFile), error => error.code === 'ENOENT',
      'ready must mean every exact lease has finished restoration, not merely that HTTP listens');
  } finally {
    allowRestore();
    replacement = await starting;
    t.after(() => replacement.close());
  }
  assert.equal(JSON.parse(await readFile(replacement.readyFile, 'utf8')).transportGeneration, 'replacement');
});

test('GivenCrashedNativeRuntimeReadiness_WhenOriginalProcessIsAbsent_NewHostRecoversWithoutClick', async t => {
  const { startNativeProvider } = await import(moduleUrl);
  const { service, transport, stateDir } = await setup(t);
  const old = await readFile(service.readyFile);
  await service.close();
  await writeFile(service.readyFile, old, { mode: 0o600 });
  const replacementRuntime = { ...runtime, pid: 703, startIdentity: 'runtime-2' };
  const replacement = await startNativeProvider({
    stateDir, transport,
    contextIdentity: { ...contextIdentity, endpointProcessIdentity: replacementRuntime,
      mediationChain: [entry, replacementRuntime], transportGeneration: 'native-host-2' },
    processReader: async pid => [processIdentity, entry, replacementRuntime].find(identity => identity.pid === pid),
  });
  t.after(() => replacement.close());
  const fresh = JSON.parse(await readFile(replacement.readyFile, 'utf8'));
  assert.equal(fresh.endpointProcessIdentity.pid, 703);
  assert.notEqual(fresh.endpoint, JSON.parse(old).endpoint);
});

test('GivenUnreadableButLiveRecordedRuntime_WhenNewHostStarts_ReadinessIsNeverDiscarded', async t => {
  const { startNativeProvider } = await import(moduleUrl);
  const { service, transport, stateDir } = await setup(t);
  const old = JSON.parse(await readFile(service.readyFile, 'utf8'));
  await service.close();
  old.endpointProcessIdentity.pid = process.pid;
  await writeFile(service.readyFile, JSON.stringify(old), { mode: 0o600 });
  const replacementRuntime = { ...runtime, pid: 703, startIdentity: 'runtime-2' };
  let started;
  try {
    await assert.rejects((async () => {
      started = await startNativeProvider({
        stateDir, transport,
        contextIdentity: { ...contextIdentity, endpointProcessIdentity: replacementRuntime,
          mediationChain: [entry, replacementRuntime], transportGeneration: 'native-host-2' },
        processReader: async pid => {
          if (pid === process.pid) throw Object.assign(new Error('OS identity unreadable'), { code: 'EACCES' });
          return [processIdentity, entry, replacementRuntime].find(identity => identity.pid === pid);
        },
      });
    })(), error => error.code === 'EACCES');
    assert.equal(JSON.parse(await readFile(service.readyFile, 'utf8')).endpointProcessIdentity.pid, process.pid);
  } finally {
    await started?.close();
  }
});

// 2026-10-12: the operator's registry held 82 leases, all hours past `expiresAt`, 81 of them never used (a session takes a lease when
// it connects, whether or not it ever drives the browser). Every provider start restored and renewed all of them, and the provider
// then died within seconds, so no readiness file existed and no session could use the browser.
async function pileUp(t, { count = 81 } = {}) {
  const { startNativeProvider } = await import(moduleUrl);
  const { service, transport, stateDir } = await setup(t);
  const idle = [];
  for (let index = 0; index < count; index += 1) idle.push(await service.invoke('acquire', { owner: 'idle-owner-' + index }));
  const used = await service.invoke('acquire', { owner: 'used-owner' });
  await service.invoke('ensureWindow', { leaseId: used.leaseId, owner: 'used-owner' });
  await service.close();
  const registryFile = path.join(stateDir, 'registry.json');
  const expire = async ids => {
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    for (const id of ids) registry.leases[id].expiresAt = new Date(Date.now() - 3_600_000).toISOString();
    await writeFile(registryFile, JSON.stringify(registry));
  };
  const restart = () => startNativeProvider({
    stateDir, transport, contextIdentity: { ...contextIdentity, transportGeneration: 'native-host-2' },
    processReader: async pid => [processIdentity, entry, runtime].find(identity => identity.pid === pid),
  });
  const leases = async () => JSON.parse(await readFile(registryFile, 'utf8')).leases;
  return { transport, stateDir, idle, used, expire, restart, leases };
}

test('GivenManyExpiredNativeLeases_WhenProviderStarts_TheyArePrunedNotRestored', async t => {
  const { transport, idle, used, expire, restart, leases } = await pileUp(t);
  await expire([...idle.map(lease => lease.leaseId), used.leaseId]);
  const before = transport.calls.length;
  const started = Date.now();
  const replacement = await restart();
  t.after(() => replacement.close());
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(transport.calls.slice(before).filter(call => call.method === 'lease.bind'), [], 'an expired lease that never touched the browser is not bound again');
  assert.deepEqual(Object.keys(await leases()), [used.leaseId], 'the expired leases with nothing in the browser are gone; the one with a window is restored, since its tabs are still recorded');
  assert.deepEqual((await replacement.invoke('status')).leases.map(lease => lease.leaseId), [used.leaseId]);
});

test('GivenALeaseWhoseControlTabIsGone_WhenProviderStarts_ThatLeaseIsSkippedAndTheProviderStillStarts', async t => {
  const { transport, idle, used, restart, leases } = await pileUp(t, { count: 2 });
  // The browser no longer has the lease's control tab (the operator closed the window while no provider ran).
  transport.leases.delete(used.leaseId);
  const expiry = (await leases())[used.leaseId].expiresAt;
  const replacement = await restart();
  t.after(() => replacement.close());
  assert.equal(JSON.parse(await readFile(replacement.readyFile, 'utf8')).transportGeneration, 'native-host-2');
  assert.deepEqual(Object.keys(await leases()).sort(), [...idle.map(lease => lease.leaseId), used.leaseId].sort(), 'the lease that could not be restored stays recorded, because its tabs may still exist');
  assert.equal((await leases())[used.leaseId].expiresAt, expiry, 'and it is not renewed, so it expires and a later start removes it');
  await assert.rejects(replacement.invoke('resume', { leaseId: used.leaseId, owner: 'used-owner', expectedProcessIdentity: processIdentity }));
  const resumed = await replacement.invoke('resume', { leaseId: idle[0].leaseId, owner: 'idle-owner-0', expectedProcessIdentity: processIdentity });
  assert.equal(resumed.leaseId, idle[0].leaseId);
});

test('GivenAnExpiredLeaseThatCannotBeRestored_WhenProviderStarts_ItIsDropped', async t => {
  const { transport, used, expire, restart, leases } = await pileUp(t, { count: 0 });
  transport.leases.delete(used.leaseId);
  await expire([used.leaseId]);
  const replacement = await restart();
  t.after(() => replacement.close());
  assert.deepEqual(Object.keys(await leases()), []);
});

test('GivenIdleLeasesWhoseSessionIsGone_WhenAnotherSessionAcquires_TheyAreReleased', async t => {
  const { startNativeProvider } = await import(moduleUrl);
  const { spawn } = await import('node:child_process');
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'desk-native-provider-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const session = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(() => child.kill());
    return child;
  };
  const end = child => new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  const [gone, live, withWindow, replaced] = [session(), session(), session(), session()];
  const starts = new Map([[gone.pid, 'start-gone'], [live.pid, 'start-live'], [withWindow.pid, 'start-window'], [replaced.pid, 'start-replaced']]);
  const transport = new Transport();
  const service = await startNativeProvider({
    stateDir, transport, contextIdentity,
    processReader: async pid => [processIdentity, entry, runtime].find(identity => identity.pid === pid) ??
      (starts.has(pid) ? { pid, startIdentity: starts.get(pid) } : undefined),
  });
  t.after(() => service.close());
  const acquire = (owner, ownerPid) => service.invoke('acquire', { owner, ...(ownerPid === undefined ? {} : { ownerPid }) });
  const a = await acquire('gone-session', gone.pid);
  const b = await acquire('live-session', live.pid);
  const c = await acquire('window-session', withWindow.pid);
  await service.invoke('ensureWindow', { leaseId: c.leaseId, owner: 'window-session' });
  const d = await acquire('old-client-session');
  const e = await acquire('replaced-session', replaced.pid);
  const f = await acquire('unreadable-session', process.pid);
  await assert.rejects(acquire('bad-pid', -1), error => error.code === 'NATIVE_OWNER_INVALID');
  await end(gone);
  await end(withWindow);
  // The process id is in use again by another process: the session that held the lease is gone.
  starts.set(replaced.pid, 'another-process');

  const next = await acquire('next-session', live.pid);
  const remaining = (await service.invoke('status')).leases.map(lease => lease.leaseId).sort();
  assert.deepEqual(remaining, [b.leaseId, c.leaseId, d.leaseId, f.leaseId, next.leaseId].sort(),
    'gone and replaced idle sessions are released; a live one, one with a window, one from a client that sent no process id and one whose start cannot be read stay');
  assert.ok(transport.calls.some(call => call.leaseId === a.leaseId && call.method === 'lease.unbind'));
  assert.ok(transport.calls.some(call => call.leaseId === e.leaseId && call.method === 'lease.unbind'));
  await assert.rejects(service.invoke('resume', { leaseId: a.leaseId, owner: 'gone-session', expectedProcessIdentity: processIdentity }),
    error => error.code === 'NATIVE_LEASE_OWNER_MISMATCH');
});

test('GivenAnExpiredIdleLease_WhenAnotherSessionAcquires_ItIsReleasedAndAFailedReleaseNeverFailsTheAcquire', async t => {
  const { service, transport, stateDir } = await setup(t);
  const stale = await service.invoke('acquire', { owner: 'stale-session' });
  const stuck = await service.invoke('acquire', { owner: 'stuck-session' });
  const registryFile = path.join(stateDir, 'registry.json');
  const registry = JSON.parse(await readFile(registryFile, 'utf8'));
  for (const id of [stale.leaseId, stuck.leaseId]) registry.leases[id].expiresAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(registryFile, JSON.stringify(registry));
  const original = transport.request.bind(transport);
  transport.request = async message => {
    if (message.method === 'lease.unbind' && message.leaseId === stuck.leaseId) throw new Error('the extension did not answer');
    return original(message);
  };
  const next = await service.invoke('acquire', { owner: 'next-session' });
  const remaining = (await service.invoke('status')).leases.map(lease => lease.leaseId);
  assert.equal(remaining.includes(stale.leaseId), false);
  assert.equal(remaining.includes(next.leaseId), true);
});
