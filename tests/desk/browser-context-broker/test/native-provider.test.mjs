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
      const tab = { tabId: ++this.next, windowId: lease.windowId, url: params.markerUrl };
      lease.tabs.push(tab);
      return { ...tab, controlTabId: lease.controlTabId, controlMarker: lease.controlMarker };
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
    if (method === 'lease.unbind') return { unbound: true };
    throw new Error('unexpected native method');
  }
}

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
  assert.equal(peers.leases.find(lease => lease.leaseId === acquired.leaseId).work, 'work');
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
