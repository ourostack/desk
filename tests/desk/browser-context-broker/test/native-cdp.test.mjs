import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import net from 'node:net';

import { CdpClient } from '../../../../plugins/desk/browser-context-broker/src/cdp-client.mjs';
import { startLeaseProxy } from '../../../../plugins/desk/browser-context-broker/src/cdp-proxy.mjs';
import { createLease, createOwnedTarget, clearLeaseTargets, closeOwnedTarget } from '../../../../plugins/desk/browser-context-broker/src/leases.mjs';
import { readRegistry, writeRegistry } from '../../../../plugins/desk/browser-context-broker/src/registry.mjs';
import { markerTargetUrl } from '../../../../plugins/desk/browser-context-broker/src/markers.mjs';

const moduleUrl = new URL('../../../../plugins/desk/browser-context-broker/src/native-cdp.mjs', import.meta.url);
const identity = { pid: 700, startIdentity: 'browser-700', owner: 'operator', executable: '/opt/browser', profileRoot: '/profiles/shared' };
const context = { id: 'native-context', launch: { executable: identity.executable, profileRoot: identity.profileRoot } };

class NativeWorld extends EventEmitter {
  next = 100;
  calls = [];
  leases = new Map();
  async request({ leaseId, method, params = {} }) {
    this.calls.push({ leaseId, method, params: structuredClone(params) });
    if (method === 'lease.bind') {
      this.leases.set(leaseId, { tabs: new Map(), windowId: ++this.next });
      return { bound: true };
    }
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error('native lease absent');
    if (method === 'target.create') {
      if (!lease.controlTabId) {
        lease.controlTabId = ++this.next;
        lease.controlMarker = params.marker;
        lease.tabs.set(lease.controlTabId, { tabId: lease.controlTabId, windowId: lease.windowId, targetId: `chrome-${lease.controlTabId}`, control: true, url: 'chrome-extension://own/control.html', title: 'owner' });
      }
      const tabId = ++this.next;
      const target = { tabId, windowId: ++this.next, targetId: `chrome-${tabId}`, control: false, url: params.markerUrl, title: 'marker' };
      if (this.pendingNavigation) target.url = '';
      lease.tabs.set(tabId, target);
      if (this.loseCreateResponse) {
        this.loseCreateResponse = false;
        throw Object.assign(new Error('native create response lost'), { code: 'NATIVE_EFFECT_UNKNOWN' });
      }
      return { ...target, controlWindowId: lease.windowId, controlTabId: lease.controlTabId, controlTargetId: `chrome-${lease.controlTabId}`, controlMarker: lease.controlMarker };
    }
    if (method === 'target.readback') {
      return { windowId: lease.windowId, controlTabId: lease.controlTabId, controlMarker: lease.controlMarker,
        windows: [...new Set([...lease.tabs.values()].map(tab => tab.windowId))].map(id => ({
          id, left: 10, top: 20, width: 800, height: 600, state: 'normal',
        })),
        tabs: [...lease.tabs.values()].map(tab => ({ ...tab })) };
    }
    const tab = lease.tabs.get(params.tabId);
    if (method === 'target.attach') return { targetId: tab.targetId };
    if (method === 'target.detach') return { detached: true };
    if (method === 'target.command') {
      if (params.method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'native-main-' + params.tabId, url: tab.url } } };
      }
      if (params.method === 'Page.navigate') {
        tab.url = params.params.url;
        return { frameId: 'owned-frame' };
      }
      if (params.method === 'Runtime.evaluate' && params.params.expression?.includes('__deskNativeTargetId')) {
        return { result: { type: 'boolean', value: true } };
      }
      return { result: { type: 'string', value: 'native-result' } };
    }
    if (method === 'target.close') {
      lease.tabs.delete(params.tabId);
      if (params.tabId === lease.controlTabId) {
        lease.controlTabId = undefined;
        lease.windowId = ++this.next;
      }
      return { closed: true };
    }
    if (method === 'target.admit') {
      const popup = lease.tabs.get(params.tabId);
      if (!popup || popup.openerTabId !== params.openerTabId) throw new Error('wrong popup opener');
      return { ...popup };
    }
    if (method === 'lease.unbind') {
      if (lease.tabs.size) throw new Error('native lease not empty');
      this.leases.delete(leaseId);
      return { unbound: true };
    }
    throw new Error(`unexpected native method ${method}`);
  }
}

async function setup(t) {
  const { startNativeCdp } = await import(moduleUrl);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'desk-native-cdp-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const transport = new NativeWorld();
  const server = await startNativeCdp({
    transport, stateDir, contextIdentity: {
      processIdentity: identity, transportGeneration: 'native-generation', profileToken: 'a'.repeat(64),
      browserVersion: 'Chrome/155.0.0.0', userAgent: 'fixture-agent', protocolVersion: '1.3',
    },
  });
  t.after(() => server.close());
  const lease = await createLease({
    stateDir, context, owner: 'native-owner', processIdentity: identity,
    rawEndpoint: server.origin, deferInitialTarget: true,
    providerBind: ({ lease }) => server.bindLease({ leaseId: lease.id, owner: lease.owner }),
  });
  return { stateDir, server, transport, lease };
}

async function client(t, endpoint) {
  const connected = await CdpClient.connect(endpoint);
  t.after(() => connected.close());
  return connected;
}

test('GivenSeparateNativeWorkWindows_WhenCreated_ControlAndTaskRoutingRemainDistinct', async t => {
  const { stateDir, lease, server, transport } = await setup(t);
  const endpoint = server.endpointForLease(lease.id);
  const first = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: endpoint, params: { url: 'about:blank' } });
  const later = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: endpoint, params: { url: 'about:blank' } });
  const routing = (await readRegistry(stateDir)).leases[lease.id].nativeRouting;
  assert.equal(routing.windowId, transport.leases.get(lease.id).windowId);
  assert.notEqual(routing.targetTabs[first.targetId].windowId, routing.windowId);
  assert.notEqual(routing.targetTabs[later.targetId].windowId, routing.windowId);
  assert.notEqual(routing.targetTabs[later.targetId].windowId, routing.targetTabs[first.targetId].windowId);
  const connected = await client(t, endpoint);
  const window = await connected.send('Browser.getWindowForTarget', { targetId: later.targetId });
  assert.equal(window.windowId, routing.targetTabs[later.targetId].windowId);
});

for (const controlWindowId of [undefined, null, '101', -1]) {
  test(`GivenInvalidNativeControlWindow_${String(controlWindowId)}_WhenCreated_NoControlIsGuessed`, async t => {
    const { stateDir, lease, server, transport } = await setup(t);
    const request = transport.request.bind(transport);
    transport.request = async message => {
      const result = await request(message);
      if (message.method === 'target.create') result.controlWindowId = controlWindowId;
      return result;
    };
    const marker = `${lease.id}:invalid-control-fixture`;
    const markerUrl = markerTargetUrl(marker);
    const registry = await readRegistry(stateDir);
    registry.leases[lease.id].pendingTargetCreates = [{
      marker, markerUrl, requestedUrl: 'about:blank', startedAt: new Date().toISOString(),
    }];
    await writeRegistry(stateDir, registry);
    const connected = await client(t, server.endpointForLease(lease.id));
    await assert.rejects(connected.send('Target.createTarget', { url: markerUrl, background: true }),
      error => error.code === 'CDP_COMMAND_FAILED' && error.details.cdpCode === -32006);
    const after = (await readRegistry(stateDir)).leases[lease.id].nativeRouting;
    assert.equal(after.windowId, 101, 'only independent exact readback can establish control routing');
    assert.equal(transport.calls.filter(call => call.method === 'target.create').length, 1);
  });
}

test('GivenNativeBootstrapPending_WhenTargetCreated_ObserversSeeItOnlyAfterBootstrapCommandSettles', async t => {
  const { stateDir, lease, server, transport } = await setup(t);
  const observer = await client(t, server.endpointForLease(lease.id));
  await observer.send('Target.setDiscoverTargets', { discover: true });
  await observer.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
  const events = [];
  observer.on('event', event => events.push(event));
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const request = transport.request.bind(transport);
  transport.request = async message => {
    if (message.method === 'target.command' && message.params.method === 'Page.navigate') {
      entered();
      await held;
    }
    return request(message);
  };
  const creating = createOwnedTarget({ stateDir, leaseId: lease.id,
    rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  await started;
  await new Promise(resolve => setTimeout(resolve, 30));
  const early = events.slice();
  release();
  const created = await creating;
  assert.equal(early.some(event => ['Target.targetCreated', 'Target.attachedToTarget'].includes(event.method)), false);
  assert.equal(events.some(event => event.method === 'Target.attachedToTarget' &&
    event.params.targetInfo.targetId === created.targetId), true);
});

for (const lifecycle of ['target.closed', 'target.detached', 'target.routingLost']) {
  test(`GivenNative${lifecycle}_WhenTaskWasAttached_ClientLifecycleIsNotLost`, async t => {
    const { server, transport, stateDir, lease } = await setup(t);
    const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
    const connected = await client(t, server.endpointForLease(lease.id));
    const { sessionId } = await connected.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    await connected.send('Target.setDiscoverTargets', { discover: true });
    const events = [];
    connected.on('event', event => events.push(event));
    const tabId = (await readRegistry(stateDir)).leases[lease.id].nativeRouting.targetTabs[created.targetId].tabId;
    if (lifecycle === 'target.closed') transport.leases.get(lease.id).tabs.delete(tabId);
    transport.emit('event', { event: lifecycle, leaseId: lease.id, tabId, reason: 'canceled_by_user' });
    const until = Date.now() + 500;
    while (!events.some(event => event.method === 'Target.detachedFromTarget') && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(events.some(event => event.method === 'Target.detachedFromTarget' && event.params.sessionId === sessionId));
    const recorded = (await readRegistry(stateDir)).leases[lease.id];
    if (lifecycle === 'target.closed') {
      assert.ok(events.some(event => event.method === 'Target.targetDestroyed' && event.params.targetId === created.targetId));
      assert.equal(recorded.targetIds.includes(created.targetId), false);
    } else {
      assert.equal(recorded.targetIds.includes(created.targetId), true, 'detachment or routing loss is not proof the task disappeared');
    }
    await assert.rejects(connected.send('Runtime.evaluate', { expression: '1' }, { sessionId }),
      error => /session|owned|bound/u.test(error.message));
  });
}



test('GivenNativeHttpConnectionPending_WhenAdapterCloses_OwnTransportIsTerminated', async t => {
    const { server } = await setup(t);
    const port = Number(new URL(server.origin).port);
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET /marker/fixture HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    await new Promise(resolve => setTimeout(resolve, 10));
    const closing = server.close();
    const timely = await Promise.race([closing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
    socket.destroy();
    await closing;
    assert.equal(timely, true, 'private HTTP connections cannot keep the stopped provider generation alive');
  });

test('GivenNativeEventAdmissionPending_WhenLaterContextEventArrives_SourceOrderIsPreserved', async t => {
  const { server, transport, stateDir, lease } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const connected = await client(t, server.endpointForLease(lease.id));
  await connected.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  await connected.send('Target.setDiscoverTargets', { discover: true });
  const parent = (await readRegistry(stateDir)).leases[lease.id].nativeRouting.targetTabs[created.targetId];
  const popupId = 901;
  transport.leases.get(lease.id).tabs.set(popupId, {
    tabId: popupId, windowId: parent.windowId, targetId: 'chrome-popup', url: 'about:blank', title: 'popup', openerTabId: parent.tabId,
  });
  let release;
  let entered;
  const pending = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { entered = resolve; });
  const original = transport.request.bind(transport);
  transport.request = async message => {
    if (message.method === 'target.admit') { entered(); await pending; }
    return original(message);
  };
  const events = [];
  connected.on('event', event => events.push(event.method));
  transport.emit('event', { event: 'target.popup', leaseId: lease.id, tabId: popupId, windowId: parent.windowId, openerTabId: parent.tabId });
  await begun;
  transport.emit('event', { event: 'cdp', leaseId: lease.id, tabId: parent.tabId, method: 'Runtime.executionContextsCleared', params: {} });
  await new Promise(resolve => setTimeout(resolve, 30));
  const early = events.slice();
  release();
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Ordered context event did not arrive')), 500);
    const received = event => {
      if (event.method !== 'Runtime.executionContextsCleared') return;
      clearTimeout(deadline);
      connected.off('event', received);
      resolve();
    };
    if (events.includes('Runtime.executionContextsCleared')) { clearTimeout(deadline); resolve(); }
    else connected.on('event', received);
  });
  assert.equal(early.includes('Runtime.executionContextsCleared'), false);
  assert.ok(events.indexOf('Target.targetCreated') < events.indexOf('Runtime.executionContextsCleared'));
});

test('GivenNativeTransportUpdate_WhenPaused_OnlyExactReloadCanDispatchUntilResume', async () => {
  const { NativeCommandTransport } = await import(moduleUrl);
  const sent = [];
  const transport = new NativeCommandTransport({ send: message => sent.push(message) });
  transport.pause();
  await assert.rejects(transport.request({ leaseId: 'owned', method: 'target.create' }),
    error => error.code === 'NATIVE_UPDATE_IN_PROGRESS');
  assert.equal(sent.length, 0);
  const reload = transport.request({ leaseId: 'provider-update', method: 'extension.reload' });
  await new Promise(setImmediate);
  transport.receive({ id: sent[0].id, result: { reload: true } });
  assert.deepEqual(await reload, { reload: true });
  transport.resume();
  const pending = transport.request({ leaseId: 'owned', method: 'target.readback' });
  assert.throws(() => transport.pause(), error => error.code === 'NATIVE_UPDATE_EFFECTS_PENDING');
  await new Promise(setImmediate);
  transport.receive({ id: sent[1].id, result: { tabs: [] } });
  await pending;
  transport.close();
});

test('GivenNativeEndpoint_WhenCapabilityOrNamespaceIsWrong_HttpAndWsRefuseBeforeDispatch', async t => {
  const { server, transport, lease } = await setup(t);
  const endpoint = server.endpointForLease(lease.id);
  const count = transport.calls.length;
  const bad = [
    endpoint.replace(/\/native\/[a-f0-9]{64}\//u, '/native/missing/'),
    endpoint.replace(/\/native\/[a-f0-9]{64}\//u, '/native/' + '0'.repeat(64) + '/'),
    endpoint.replace(lease.id, 'unbound-lease'),
  ];
  for (const url of bad) {
    const response = await fetch(url + '/json/version');
    assert.ok([401, 403].includes(response.status));
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/devtools/browser');
    await assert.rejects(once(socket, 'open'));
  }
  assert.equal(transport.calls.length, count);
  assert.equal((await fetch(endpoint + '/json/version')).status, 200);
  assert.match(endpoint, /\/native\/[a-f0-9]{64}\//u);
  assert.equal(JSON.stringify(server).includes(endpoint), false);
});

test('GivenRecordedNativeMarker_WhenCreated_OriginalUrlAndControlLedgerArePreserved', async t => {
  const { server, transport, stateDir, lease } = await setup(t);
  const original = 'https://example.test/path?q=a%20b#original';
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: original } });
  const record = (await readRegistry(stateDir)).leases[lease.id];
  assert.ok(record.nativeRouting.controlTargetId);
  assert.equal(record.targetIds.length, 2);
  assert.ok(record.nativeRouting.targetTabs[created.targetId]);
  const navigation = transport.calls.find(call => call.method === 'target.command' && call.params.method === 'Page.navigate');
  assert.equal(navigation.params.params.url, original);
  const connected = await client(t, server.endpointForLease(lease.id));
  const targets = (await connected.send('Target.getTargets')).targetInfos;
  assert.deepEqual(targets.map(target => target.targetId), [created.targetId]);
  assert.equal(targets[0].url, original);
  assert.equal(targets[0].browserContextId, 'native:' + lease.id, 'native target must name its exact cooperative CDP context for Playwright attachment');
});

test('GivenUnrecordedNativeCreate_WhenDispatched_NoChromeCreateOccurs', async t => {
  const { server, transport, lease } = await setup(t);
  const connected = await client(t, server.endpointForLease(lease.id));
  const count = transport.calls.length;
  await assert.rejects(connected.send('Target.createTarget', { url: 'https://unrecorded.test/' }), error => error.details.cdpCode === -32002);
  assert.equal(transport.calls.length, count);
});

test('GivenPeerNativeTargets_WhenAttached_ForeignTargetAndSessionAreDenied', async t => {
  const { server, transport, stateDir, lease } = await setup(t);
  const a = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const other = await createLease({
    stateDir, context, owner: 'peer', processIdentity: identity, rawEndpoint: server.origin, deferInitialTarget: true,
    providerBind: ({ lease }) => server.bindLease({ leaseId: lease.id, owner: lease.owner }),
  });
  const b = await createOwnedTarget({ stateDir, leaseId: other.id, rawEndpoint: server.endpointForLease(other.id), params: { url: 'about:blank' } });
  const clientA = await client(t, server.endpointForLease(lease.id));
  const clientB = await client(t, server.endpointForLease(other.id));
  const attached = await clientA.send('Target.attachToTarget', { targetId: a.targetId, flatten: true });
  const count = transport.calls.length;
  await assert.rejects(clientB.send('Target.attachToTarget', { targetId: a.targetId, flatten: true }), error => error.details.cdpCode === -32002);
  await assert.rejects(clientB.send('Runtime.evaluate', { expression: 'wrong' }, attached.sessionId), error => error.details.cdpCode === -32003);
  assert.equal(transport.calls.length, count);
  assert.deepEqual((await clientB.send('Target.getTargets')).targetInfos.map(target => target.targetId), [b.targetId]);
});

for (const method of ['Target.activateTarget', 'Page.bringToFront', 'Browser.close', 'Browser.setDownloadBehavior', 'Target.attachToBrowserTarget']) {
  test(`GivenNativeClient_When${method}IsRequested_NoGlobalOrActivationDispatchOccurs`, async t => {
    const { server, transport, lease } = await setup(t);
    const connected = await client(t, server.endpointForLease(lease.id));
    const count = transport.calls.length;
    await assert.rejects(connected.send(method, {}), error => [-32001, -32004].includes(error.details.cdpCode));
    assert.equal(transport.calls.length, count);
  });
}

test('GivenLostCreateResponse_WhenExactMarkerExists_NativeCreateIsNotReplayed', async t => {
  const { server, transport, stateDir, lease } = await setup(t);
  transport.loseCreateResponse = true;
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'https://reconcile.test/' } });
  assert.equal(created.reconciled, true);
  assert.equal(transport.calls.filter(call => call.method === 'target.create').length, 1);
  assert.equal((await readRegistry(stateDir)).leases[lease.id].pendingTargetCreates.length, 0);
});

test('GivenOwnedNativeChildEvent_WhenRouted_FlattenedSessionStaysClientScoped', async t => {
  const { server, transport, stateDir, lease } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const connected = await client(t, server.endpointForLease(lease.id));
  const other = await client(t, server.endpointForLease(lease.id));
  const rootSession = await connected.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const tabId = (await readRegistry(stateDir)).leases[lease.id].nativeRouting.targetTabs[created.targetId].tabId;
  const events = [];
  connected.on('event', event => events.push(event));
  transport.emit('event', {
    event: 'cdp', leaseId: lease.id, tabId, method: 'Target.attachedToTarget',
    params: { sessionId: 'native-child', targetInfo: { targetId: 'native-frame', type: 'iframe', url: 'about:blank' }, waitingForDebugger: false },
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const attached = events.find(event => event.method === 'Target.attachedToTarget');
  assert.ok(attached, 'native child event must reach the exact attached root client');
  assert.equal(attached.sessionId, rootSession.sessionId);
  assert.notEqual(attached.params.sessionId, 'native-child');
  await connected.send('Runtime.enable', {}, attached.params.sessionId);
  assert.equal(transport.calls.at(-1).params.sessionId, 'native-child');
  const count = transport.calls.length;
  await assert.rejects(other.send('Runtime.enable', {}, attached.params.sessionId), error => error.details.cdpCode === -32003);
  assert.equal(transport.calls.length, count);
});

test('GivenExistingNativeGenerationState_WhenSecondServerFails_LiveStateIsNotDeleted', async t => {
  const { startNativeCdp } = await import(moduleUrl);
  const { stateDir } = await setup(t);
  const name = (await readdir(stateDir)).find(file => file.startsWith('native-cdp-'));
  const original = await readFile(path.join(stateDir, name));
  await assert.rejects(startNativeCdp({
    transport: new NativeWorld(), stateDir,
    contextIdentity: {
      processIdentity: identity, transportGeneration: 'native-generation', profileToken: 'a'.repeat(64),
      browserVersion: 'Chrome/155.0.0.0', userAgent: 'fixture-agent',
    },
  }), error => error.code === 'EEXIST');
  const current = await readFile(path.join(stateDir, name));
  assert.equal(original.equals(current), true, 'failed reservation must preserve the existing native generation');
});

test('GivenNativeCapabilityInContext_WhenStatusIsPrinted_OnlyNonSecretOriginIsExposed', async t => {
  const { stateDir, server, lease } = await setup(t);
  const endpoint = server.endpointForLease(lease.id);
  const capability = endpoint.match(/\/native\/([a-f0-9]{64})\//u)[1];
  const registry = await readRegistry(stateDir);
  registry.contexts.native = {
    contextId: 'native-context', endpoint, processIdentity: identity,
    recovery: { diagnostic: `transport unavailable at ${endpoint}`, capability },
  };
  await writeRegistry(stateDir, registry);
  const cli = new URL('../../../../plugins/desk/browser-context-broker/bin/browser-context-broker.mjs', import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [cli.pathname, 'status', '--state-dir', stateDir]);
  assert.equal(stdout.includes(capability), false, 'operator status must not expose the native capability anywhere');
  assert.equal(JSON.parse(stdout).result.contexts[0].endpoint, server.origin);
});

test('GivenTwoNativeIpcRequests_WhenRepliesReverse_OrderAndIdsStayCorrelated', async () => {
  const { NativeCommandTransport } = await import(moduleUrl);
  const sent = [];
  const transport = new NativeCommandTransport({ send: async message => sent.push(message) });
  const first = transport.request({ leaseId: 'lease-a', method: 'target.readback', params: {} });
  const second = transport.request({ leaseId: 'lease-b', method: 'target.readback', params: {} });
  await new Promise(setImmediate);
  assert.notEqual(sent[0].id, sent[1].id);
  transport.receive({ id: sent[1].id, result: { owner: 'b' } });
  transport.receive({ id: sent[0].id, result: { owner: 'a' } });
  assert.deepEqual(await first, { owner: 'a' });
  assert.deepEqual(await second, { owner: 'b' });
  transport.close();
});

test('GivenNativeIpcTransportLoss_WhenRequestIsPending_FailsWithoutEmptySuccess', async () => {
  const { NativeCommandTransport } = await import(moduleUrl);
  let dispatched = 0;
  const transport = new NativeCommandTransport({ send: async () => { dispatched++; } });
  const pending = transport.request({ leaseId: 'lease-a', method: 'target.create', params: { marker: 'recorded-marker' } });
  transport.close();
  await assert.rejects(pending, error => error.code === 'NATIVE_TRANSPORT_DISCONNECTED');
  await new Promise(setImmediate);
  assert.equal(dispatched, 0, 'closed native transport must not dispatch a queued create afterward');
});

test('GivenMalformedNativeReply_WhenReceived_RejectsTheExactPendingRequest', async () => {
  const { NativeCommandTransport } = await import(moduleUrl);
  const sent = [];
  const transport = new NativeCommandTransport({ send: async message => sent.push(message) });
  const pending = transport.request({ leaseId: 'lease-a', method: 'target.readback', params: {} });
  await new Promise(setImmediate);
  transport.receive({ id: sent[0].id });
  await assert.rejects(pending, error => error.code === 'NATIVE_RESPONSE_INVALID');
  transport.close();
});

async function proxyFor(t, stateDir, leaseId) {
  const proxy = await startLeaseProxy({
    stateDir, leaseId, declaration: context,
    providerInvoker: async (_operation, { observation }) => ({
      healthy: true, endpoint: observation.endpoint, processIdentity: observation.processIdentity,
      endpointProcessIdentity: { pid: identity.pid, startIdentity: identity.startIdentity },
    }),
  });
  t.after(() => proxy.close());
  return proxy;
}

test('GivenNativeControlInLedger_WhenProxyObservesDefaultTarget_ControlIsHidden', async t => {
  const { server, stateDir, lease } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const proxy = await proxyFor(t, stateDir, lease.id);
  const connected = await client(t, proxy.endpoint);
  assert.equal((await connected.send('Target.getTargetInfo')).targetInfo.targetId, created.targetId);
  const control = (await readRegistry(stateDir)).leases[lease.id].nativeRouting.controlTargetId;
  await assert.rejects(connected.send('Target.attachToTarget', { targetId: control, flatten: true }), error => error.details.cdpCode === -32002);
});

test('GivenNativeChildSession_WhenPassingLeaseProxy_ExactParentOwnershipAdmitsFrameOnly', async t => {
  const { server, transport, stateDir, lease } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const proxy = await proxyFor(t, stateDir, lease.id);
  const connected = await client(t, proxy.endpoint);
  const root = await connected.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const tabId = (await readRegistry(stateDir)).leases[lease.id].nativeRouting.targetTabs[created.targetId].tabId;
  const events = [];
  connected.on('event', event => events.push(event));
  transport.emit('event', {
    event: 'cdp', leaseId: lease.id, tabId, method: 'Target.attachedToTarget',
    params: { sessionId: 'native-child', targetInfo: { targetId: 'native-frame', type: 'iframe', url: 'about:blank' }, waitingForDebugger: false },
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const child = events.find(event => event.method === 'Target.attachedToTarget');
  assert.ok(child, 'lease proxy must preserve exact-parent iframe attachment');
  assert.equal(child.sessionId, root.sessionId);
  await connected.send('Runtime.enable', {}, child.params.sessionId);
  assert.equal(transport.calls.at(-1).params.sessionId, 'native-child');
});

test('GivenEmptyNativeProxy_WhenWindowCreatedLater_NewConnectionSeesRecordedTask', async t => {
  const { server, stateDir, lease } = await setup(t);
  const proxy = await proxyFor(t, stateDir, lease.id);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const connected = await client(t, proxy.endpoint);
  assert.deepEqual((await connected.send('Target.getTargets')).targetInfos.map(target => target.targetId), [created.targetId]);
});

test('GivenNativeLeaseCleared_WhenReopened_BindingPersistsWithoutStaleWindowRouting', async t => {
  const { server, stateDir, lease } = await setup(t);
  const first = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const firstRouting = (await readRegistry(stateDir)).leases[lease.id].nativeRouting;
  await clearLeaseTargets({
    stateDir, leaseId: lease.id, declaration: context,
    providerInvoker: async (_operation, { observation }) => ({
      healthy: true, endpoint: observation.endpoint, processIdentity: observation.processIdentity,
      endpointProcessIdentity: { pid: identity.pid, startIdentity: identity.startIdentity },
    }),
  });
  const empty = (await readRegistry(stateDir)).leases[lease.id];
  assert.deepEqual(empty.targetIds, []);
  assert.deepEqual(empty.nativeRouting, { transportGeneration: 'native-generation', targetTabs: {} });
  const next = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const nextRouting = (await readRegistry(stateDir)).leases[lease.id].nativeRouting;
  assert.notEqual(next.targetId, first.targetId);
  assert.notEqual(nextRouting.windowId, firstRouting.windowId);
  assert.equal(nextRouting.transportGeneration, firstRouting.transportGeneration);
});

test('GivenOwnedNativeRenderer_WhenAttached_OnlyRendererFocusAndStablePublicIdAreInitialized', async t => {
  const { server, transport, stateDir, lease } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'https://background.test/' } });
  const route = (await readRegistry(stateDir)).leases[lease.id].nativeRouting.targetTabs[created.targetId];
  const focus = transport.calls.find(call => call.params.method === 'Emulation.setFocusEmulationEnabled');
  assert.ok(focus);
  assert.equal(focus.params.tabId, route.tabId);
  assert.deepEqual(focus.params.params, { enabled: true });
  const annotation = transport.calls.find(call => call.params.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.ok(annotation);
  assert.equal(annotation.params.tabId, route.tabId);
  assert.equal(annotation.params.params.source.includes(created.targetId), true);
  assert.equal(annotation.params.params.source.includes('__deskNativeTargetId'), true);
  assert.equal(transport.calls.some(call => call.params.method === 'Page.bringToFront'), false);
});

test('GivenReturnedChromeIdsBeforeMarkerNavigation_WhenCreated_RoutingIsRecordedBeforeReadback', async t => {
  const { server, transport, stateDir, lease } = await setup(t);
  transport.pendingNavigation = true;
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const record = (await readRegistry(stateDir)).leases[lease.id];
  assert.ok(record.nativeRouting.targetTabs[created.targetId]);
  assert.equal(record.pendingTargetCreates.length, 0);
});

test('GivenSessionScopedNativeRequest_WhenAnswered_ResponsePreservesSessionEnvelope', async t => {
  const { server, stateDir, lease } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const connected = await client(t, server.endpointForLease(lease.id));
  const { sessionId } = await connected.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const response = once(connected.socket, 'message');
  connected.socket.send(JSON.stringify({ id: 9001, sessionId, method: 'Runtime.enable', params: {} }));
  const [bytes] = await response;
  const message = JSON.parse(bytes.toString());
  assert.equal(message.id, 9001);
  assert.equal(message.sessionId, sessionId, 'flattened CDP response must return to the session that owns its request');
});

test('GivenSyntheticNativeTarget_WhenFrameTreeRead_RootFrameMatchesPlaywrightTargetIdentity', async t => {
  const { server, transport, stateDir, lease } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const connected = await client(t, server.endpointForLease(lease.id));
  const { sessionId } = await connected.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const tree = await connected.send('Page.getFrameTree', {}, sessionId);
  assert.equal(tree.frameTree.frame.id, created.targetId);
  await connected.send('Page.createIsolatedWorld', { frameId: created.targetId, worldName: 'owned' }, sessionId);
  assert.equal(transport.calls.at(-1).params.params.frameId, 'native-main-' + transport.calls.at(-1).params.tabId);
});

test('GivenOwnedRendererRootReplaced_WhenNavigationEventArrives_StableTargetAndNewNativeFrameStayCorrelated', async t => {
  const { server, stateDir, lease, transport } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const connected = await client(t, server.endpointForLease(lease.id));
  const { sessionId } = await connected.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const tabId = (await readRegistry(stateDir)).leases[lease.id].nativeRouting.targetTabs[created.targetId].tabId;
  const events = [];
  connected.on('event', event => events.push(event));
  transport.emit('event', {
    event: 'cdp', leaseId: lease.id, tabId, method: 'Page.frameNavigated',
    params: { frame: { id: 'replacement-native-root', url: 'https://replacement.test/' } },
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const navigated = events.find(event => event.method === 'Page.frameNavigated');
  assert.equal(navigated.params.frame.id, created.targetId);
  await connected.send('Page.createIsolatedWorld', { frameId: created.targetId, worldName: 'owned' }, sessionId);
  assert.equal(transport.calls.at(-1).params.params.frameId, 'replacement-native-root');
});

test('GivenAutoAttachedNativeClient_WhenSeparateCreateCompletes_NewPageEventReachesExistingClient', async t => {
  const { server, stateDir, lease } = await setup(t);
  const connected = await client(t, server.endpointForLease(lease.id));
  await connected.send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
  const events = [];
  connected.on('event', event => events.push(event));
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(events.some(event => event.method === 'Target.attachedToTarget' && event.params.targetInfo.targetId === created.targetId), true);
});

test('GivenNativeTargetPhysicallyClosed_WhenBrokerRecordsClosure_ChromeRoutingIsRemoved', async t => {
  const { server, stateDir, lease } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  await closeOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), targetId: created.targetId });
  const record = (await readRegistry(stateDir)).leases[lease.id];
  assert.equal(record.targetIds.includes(created.targetId), false);
  assert.equal(Object.hasOwn(record.nativeRouting.targetTabs, created.targetId), false);
  assert.ok(record.nativeRouting.controlTabId);
});

test('GivenOwnedNativeWindow_WhenObserved_OnlyExactOwnedBoundsAreReturned', async t => {
  const { server, stateDir, lease } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const connected = await client(t, server.endpointForLease(lease.id));
  const result = await connected.send('Browser.getWindowForTarget', { targetId: created.targetId });
  assert.ok(Number.isSafeInteger(result.windowId));
  assert.deepEqual(result.bounds, { left: 10, top: 20, width: 800, height: 600, windowState: 'normal' });
  await assert.rejects(connected.send('Browser.getWindowForTarget', { targetId: 'foreign' }), error => error.details.cdpCode === -32002);
});

test('GivenNativePopupWithOwnedOpener_WhenAdmitted_RoutingAndAutoAttachAreRecorded', async t => {
  const { server, stateDir, lease, transport } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const connected = await client(t, server.endpointForLease(lease.id));
  await connected.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
  const events = [];
  connected.on('event', event => events.push(event));
  const tabId = ++transport.next;
  const record = (await readRegistry(stateDir)).leases[lease.id];
  const openerTabId = record.nativeRouting.targetTabs[created.targetId].tabId;
  const popupWindowId = ++transport.next;
  transport.leases.get(lease.id).tabs.set(tabId, {
    tabId, windowId: popupWindowId, targetId: `chrome-${tabId}`, openerTabId,
    url: 'https://popup.test/', title: 'popup',
  });
  const attached = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Owned popup auto-attach did not arrive')), 500);
    const received = event => {
      if (event.method !== 'Target.attachedToTarget' || event.params.targetInfo.tabId !== tabId) return;
      clearTimeout(deadline);
      connected.off('event', received);
      resolve();
    };
    connected.on('event', received);
  });
  transport.emit('event', { event: 'target.popup', leaseId: lease.id, tabId, windowId: popupWindowId, openerTabId });
  await attached;
  const current = (await readRegistry(stateDir)).leases[lease.id];
  const popup = Object.entries(current.nativeRouting.targetTabs).find(([, route]) => route.tabId === tabId);
  assert.ok(popup, 'exact-opener popup must enter the same authoritative lease');
  assert.equal(popup[1].windowId, popupWindowId);
  assert.equal(events.some(event => event.method === 'Target.attachedToTarget' && event.params.targetInfo.targetId === popup[0]), true);
});

test('GivenOwnedNativeSession_WhenBrowserTargetInventoryRequested_NoNativeCommandOccurs', async t => {
  const { server, stateDir, lease, transport } = await setup(t);
  const created = await createOwnedTarget({ stateDir, leaseId: lease.id, rawEndpoint: server.endpointForLease(lease.id), params: { url: 'about:blank' } });
  const connected = await client(t, server.endpointForLease(lease.id));
  const { sessionId } = await connected.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const count = transport.calls.length;
  await assert.rejects(connected.send('Target.getTargets', {}, sessionId), error => error.details.cdpCode === -32004);
  assert.equal(transport.calls.length, count);
});
