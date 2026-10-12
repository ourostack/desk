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
    for (const id of ids) registry.leases[id].expiresAt = new Date(Date.now() - 600_000).toISOString();
    await writeFile(registryFile, JSON.stringify(registry));
  };
  // Returns once the start and the sweep it begins have finished.
  // A grace of zero judges an expired lease with tabs at once; the default waits one expiry period for its session to reconnect.
  const restart = async ({ ownerGraceMs = 0 } = {}) => {
    const started = await startNativeProvider({
      stateDir, transport, contextIdentity: { ...contextIdentity, transportGeneration: 'native-host-2' }, ownerGraceMs,
      processReader: async pid => [processIdentity, entry, runtime].find(identity => identity.pid === pid),
    });
    await started.sweep();
    return started;
  };
  const leases = async () => JSON.parse(await readFile(registryFile, 'utf8')).leases;
  return { transport, stateDir, idle, used, expire, restart, leases };
}

test('GivenTheIncidentRegistryOf82ExpiredLeases_WhenProviderStarts_ItIsReadyAndEveryAbandonedLeaseIsGone', async t => {
  const { transport, idle, used, expire, restart, leases } = await pileUp(t);
  await expire([...idle.map(lease => lease.leaseId), used.leaseId]);
  const before = transport.calls.length;
  const started = Date.now();
  const replacement = await restart();
  t.after(() => replacement.close());
  assert.ok(Date.now() - started < 5_000);
  assert.ok(JSON.parse(await readFile(replacement.readyFile, 'utf8')).endpoint, 'readiness is published');
  const bound = transport.calls.slice(before).filter(call => call.method === 'lease.bind' || call.method === 'lease.restore');
  assert.deepEqual(bound.map(call => call.leaseId), [used.leaseId], 'an expired lease that never touched the browser is not bound again');
  assert.ok(transport.calls.slice(before).some(call => call.leaseId === used.leaseId && call.method === 'target.close'),
    'the expired lease with a window is a session that is gone: its recorded tabs are closed');
  assert.deepEqual(Object.keys(await leases()), []);
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

test('GivenAnExpiredLeaseWithTabsThatCannotBeRestored_WhenProviderStarts_ItIsKeptAndRetriedNeverDropped', async t => {
  const { transport, used, expire, restart, leases } = await pileUp(t, { count: 0 });
  const lost = transport.leases.get(used.leaseId);
  transport.leases.delete(used.leaseId);
  await expire([used.leaseId]);
  const replacement = await restart();
  t.after(() => replacement.close());
  assert.ok(JSON.parse(await readFile(replacement.readyFile, 'utf8')).endpoint, 'the start completes');
  assert.deepEqual(Object.keys(await leases()), [used.leaseId], 'its tabs may still be open, so the record that can close them stays');
  // The failure was transient: the next sweep restores the lease and, its session being gone, closes its tabs and releases it.
  transport.leases.set(used.leaseId, lost);
  await replacement.sweep();
  assert.deepEqual(Object.keys(await leases()), []);
  assert.ok(transport.calls.some(call => call.leaseId === used.leaseId && call.method === 'target.close'));
});

test('GivenLeasesWhoseSessionIsGone_WhenSwept_TheyAreReleasedAndTheirTabsClosed', async t => {
  const { startNativeProvider } = await import(moduleUrl);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'desk-native-provider-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  // Process starts as the operating system reports them; a session reports its own the same way.
  const starts = new Map([[process.pid, 'start-self']]);
  const transport = new Transport();
  const service = await startNativeProvider({
    stateDir, transport, contextIdentity,
    processReader: async pid => [processIdentity, entry, runtime].find(identity => identity.pid === pid),
    processStartReader: async pid => starts.get(pid) ?? null,
  });
  t.after(() => service.close());
  const acquire = (owner, ownerPid, ownerStart = starts.get(ownerPid)) =>
    service.invoke('acquire', { owner, ...(ownerPid === undefined ? {} : { ownerPid, ownerStart }) });
  // Process ids that are not running here, so the signal probe cannot answer for them; only the start read can.
  const [gone, withWindow, replaced, elsewhere] = [999_901, 999_903, 999_904, 999_905];
  const live = process.pid;
  starts.set(gone, 'start-gone');
  starts.set(withWindow, 'start-window');
  starts.set(replaced, 'start-replaced');
  const a = await acquire('gone-session', gone);
  const b = await acquire('live-session', live);
  const c = await acquire('window-session', withWindow);
  await service.invoke('ensureWindow', { leaseId: c.leaseId, owner: 'window-session' });
  const d = await acquire('old-client-session');
  const e = await acquire('replaced-session', replaced);
  // A session in another process namespace reports a start this provider cannot confirm: its process is never judged.
  const f = await acquire('other-namespace-session', elsewhere, 'start-in-a-container');
  await assert.rejects(acquire('bad-pid', -1), error => error.code === 'NATIVE_OWNER_INVALID');
  starts.set(gone, 'start-of-another-process');
  starts.set(withWindow, 'start-of-yet-another-process');
  starts.set(replaced, 'reused-pid');
  // The replaced session's process id is in use by a live process with another start.
  starts.set(elsewhere, 'start-of-an-unrelated-process');
  await service.sweep();
  const remaining = (await service.invoke('status')).leases.map(lease => lease.leaseId).sort();
  assert.deepEqual(remaining, [b.leaseId, d.leaseId, f.leaseId].sort(),
    'gone sessions are released, the one with a window included; a live one, an older client and an unconfirmed one stay');
  assert.ok(transport.calls.some(call => call.leaseId === c.leaseId && call.method === 'target.close'), 'the dead session\'s tabs are closed');
  for (const lease of [a, e]) assert.ok(transport.calls.some(call => call.leaseId === lease.leaseId && call.method === 'lease.unbind'));
});

test('GivenAnExpiredIdleLease_WhenSwept_ItIsReleasedAndAFailedReleaseIsRetriedNotLeftReleasing', async t => {
  const { service, transport, stateDir } = await setup(t);
  const stale = await service.invoke('acquire', { owner: 'stale-session' });
  const stuck = await service.invoke('acquire', { owner: 'stuck-session' });
  const registryFile = path.join(stateDir, 'registry.json');
  const registry = JSON.parse(await readFile(registryFile, 'utf8'));
  for (const id of [stale.leaseId, stuck.leaseId]) registry.leases[id].expiresAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(registryFile, JSON.stringify(registry));
  const original = transport.request.bind(transport);
  let answering = false;
  transport.request = async message => {
    if (message.method === 'lease.unbind' && message.leaseId === stuck.leaseId && !answering) throw new Error('the extension did not answer');
    return original(message);
  };
  const started = Date.now();
  const next = await service.invoke('acquire', { owner: 'next-session' });
  assert.ok(Date.now() - started < 5_000, 'an acquire never waits for the sweep');
  await service.sweep();
  let remaining = (await service.invoke('status')).leases.map(lease => lease.leaseId);
  assert.equal(remaining.includes(stale.leaseId), false);
  assert.equal(remaining.includes(next.leaseId), true);
  assert.equal(remaining.includes(stuck.leaseId), true);
  answering = true;
  await service.sweep();
  remaining = (await service.invoke('status')).leases.map(lease => lease.leaseId);
  assert.equal(remaining.includes(stuck.leaseId), false, 'the failed release is retried by the next sweep');
});

// 2026-10-12, 20:30Z: a lease whose heartbeat stopped while its provider was being replaced still recorded three tabs, and the
// extension update gate counted it as an active owner, so the update was refused forever and the lease could never renew.
test('GivenAnExpiredLeaseWithTabs_WhenAnUpdateIsPrepared_ItNeverHoldsTheUpdateBack', async t => {
  const { transport, used, expire, restart } = await pileUp(t, { count: 0 });
  await expire([used.leaseId]);
  const replacement = await restart();
  t.after(() => replacement.close());
  transport.pause = () => {};
  transport.resume = () => {};
  const update = await replacement.invoke('prepareUpdate', { expectedProcessIdentity: processIdentity });
  assert.equal(update.safe, true);
  assert.ok(transport.calls.some(call => call.leaseId === used.leaseId && call.method === 'target.close'), 'its tabs were closed first');
  await replacement.invoke('cancelUpdate', { updateToken: update.updateToken });
});

test('GivenAnExpiredOrphanLeaseThatCannotBeRestored_WhenAnUpdateIsPrepared_ItIsTrackedButNeverBlocks', async t => {
  const { transport, used, expire, restart, leases } = await pileUp(t, { count: 0 });
  transport.leases.delete(used.leaseId);
  await expire([used.leaseId]);
  const replacement = await restart();
  t.after(() => replacement.close());
  transport.pause = () => {};
  transport.resume = () => {};
  const update = await replacement.invoke('prepareUpdate', { expectedProcessIdentity: processIdentity });
  assert.equal(update.safe, true);
  assert.deepEqual(Object.keys(await leases()), [used.leaseId], 'the orphan stays recorded so a later sweep can still close its tabs');
  await replacement.invoke('cancelUpdate', { updateToken: update.updateToken });
});

test('GivenALiveSessionWithTabs_WhenAnUpdateIsPrepared_ItStillBlocksTheUpdate', async t => {
  const { service, transport } = await setup(t);
  transport.pause = () => {};
  transport.resume = () => {};
  const acquired = await service.invoke('acquire', { owner: 'live-owner', ownerPid: process.pid });
  await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'live-owner' });
  await assert.rejects(service.invoke('prepareUpdate', { expectedProcessIdentity: processIdentity }),
    error => error.code === 'NATIVE_UPDATE_ACTIVE_OWNERS');
});

// Ari's rule: there is no limit on how many sessions or tabs can be owned at once. Accumulation is fixed by cleanup, never by a cap.
test('GivenManySessionsOwningTabsAtOnce_WhenEachAcquiresAndOpensItsWindow_NoneIsRefused', async t => {
  const { service } = await setup(t);
  const owners = await Promise.all(Array.from({ length: 150 }, (_, index) => service.invoke('acquire', { owner: 'owner-' + index })));
  for (const acquired of owners) await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: acquired.owner });
  assert.equal((await service.invoke('status')).leases.length, 150);
});

async function providerWith(t, options = {}) {
  const { startNativeProvider } = await import(moduleUrl);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'desk-native-provider-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const transport = new Transport();
  transport.pause = () => {};
  transport.resume = () => {};
  const service = await startNativeProvider({
    stateDir, transport, contextIdentity,
    processReader: async pid => [processIdentity, entry, runtime].find(identity => identity.pid === pid), ...options,
  });
  t.after(() => service.close());
  const registryFile = path.join(stateDir, 'registry.json');
  const expire = async id => {
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    registry.leases[id].expiresAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await writeFile(registryFile, JSON.stringify(registry));
  };
  const leases = async () => JSON.parse(await readFile(registryFile, 'utf8')).leases;
  return { service, transport, stateDir, expire, leases };
}

// Review of #372: a session killed before its process start could be confirmed was never cleaned up, and with tabs it held every
// update back, because the proxy renewed its lease whether or not the session was alive.
test('GivenAKilledSessionWhoseStartWasNeverConfirmed_WhenItsLeaseExpires_ItsTabsAreClosedAndUpdatesProceed', async t => {
  const { service, transport, expire, leases } = await providerWith(t, { processStartReader: async () => null, ownerGraceMs: 0 });
  const acquired = await service.invoke('acquire', { owner: 'killed-session', ownerPid: 999_907, ownerStart: 'darwin:2026-10-12T00:00:00.000Z' });
  assert.equal((await leases())[acquired.leaseId].ownerProcess.confirmed, false);
  await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'killed-session' });
  // No client is connected, so nothing renews it; it expires.
  await expire(acquired.leaseId);
  const update = await service.invoke('prepareUpdate', { expectedProcessIdentity: processIdentity });
  assert.equal(update.safe, true);
  assert.ok(transport.calls.some(call => call.leaseId === acquired.leaseId && call.method === 'target.close'));
  assert.deepEqual(Object.keys(await leases()), []);
  await service.invoke('cancelUpdate', { updateToken: update.updateToken });
});

test('GivenAnExpiredLeaseWithTabsOfAnUnknownSession_WhenTheProviderHasJustStarted_ItWaitsForTheSessionToReconnect', async t => {
  const { service, transport, expire, leases } = await providerWith(t, { ownerGraceMs: 200 });
  const acquired = await service.invoke('acquire', { owner: 'reconnecting-session' });
  await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'reconnecting-session' });
  await expire(acquired.leaseId);
  await service.sweep();
  assert.ok((await leases())[acquired.leaseId], 'a session whose provider was just down keeps its tabs for one expiry period');
  assert.equal(transport.calls.some(call => call.method === 'target.close'), false);
  await new Promise(resolve => setTimeout(resolve, 250));
  await service.sweep();
  assert.equal((await leases())[acquired.leaseId], undefined, 'a session that never reconnected is gone');
});

test('GivenALiveSessionWhoseStartReadsDifferentlyButNotComparably_WhenSwept_ItIsNeverJudgedGone', async t => {
  let start = 'linux:0b5e1c7a-0000-4000-8000-000000000000:4242';
  const { service, transport } = await providerWith(t, { processStartReader: async () => start });
  const acquired = await service.invoke('acquire', { owner: 'live-session', ownerPid: process.pid, ownerStart: start });
  await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'live-session' });
  // A read whose boot id failed under load.
  start = 'linux:unknown-boot:4242';
  await service.sweep();
  assert.equal(transport.calls.some(call => call.method === 'target.close'), false);
  assert.deepEqual((await service.invoke('status')).leases.map(lease => lease.leaseId), [acquired.leaseId]);
});

test('GivenAnUnconfirmedClaim_WhenItsStartReadsTheSameLater_TheSessionIsAlive', async t => {
  let reads = 0;
  const { service, expire, leases } = await providerWith(t, {
    ownerGraceMs: 0, processStartReader: async () => (++reads === 1 ? null : 'darwin:2026-10-12T01:00:00.000Z'),
  });
  const acquired = await service.invoke('acquire', { owner: 'slow-read-session', ownerPid: process.pid, ownerStart: 'darwin:2026-10-12T01:00:00.000Z' });
  await service.invoke('ensureWindow', { leaseId: acquired.leaseId, owner: 'slow-read-session' });
  await expire(acquired.leaseId);
  await service.sweep();
  assert.ok((await leases())[acquired.leaseId], 'the claim now reads the same, so the session is alive and keeps its tabs');
});

test('GivenAnAbandonedOrphanWhoseTabsCannotBeReached_WhenAnHourPastExpiry_ItsRecordIsDropped', async t => {
  const { startNativeProvider } = await import(moduleUrl);
  const { transport, used, expire, restart, leases, stateDir } = await pileUp(t, { count: 0 });
  transport.leases.delete(used.leaseId);
  await expire([used.leaseId]);
  const replacement = await restart();
  t.after(() => replacement.close());
  assert.deepEqual(Object.keys(await leases()), [used.leaseId], 'an hour has not passed since its expiry');
  await replacement.close();
  const later = await startNativeProvider({
    stateDir, transport, contextIdentity: { ...contextIdentity, transportGeneration: 'native-host-3' }, ownerGraceMs: 0, orphanDropMs: 0,
    processReader: async pid => [processIdentity, entry, runtime].find(identity => identity.pid === pid),
  });
  t.after(() => later.close());
  await later.sweep();
  assert.deepEqual(Object.keys(await leases()), []);
});
