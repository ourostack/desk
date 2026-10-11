import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { open, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

import { BrokerError } from './claims.mjs';
import { ensureStateDirectory, readRegistry } from './registry.mjs';
import { recordNativeRouting } from './leases.mjs';
import { redactNativeSurface } from './secret-surfaces.mjs';

const ROOT_METHODS = new Set([
  'Browser.getVersion', 'Browser.getWindowForTarget', 'Target.getTargets',
  'Target.getTargetInfo', 'Target.createTarget', 'Target.closeTarget',
  'Target.attachToTarget', 'Target.detachFromTarget', 'Target.setAutoAttach', 'Target.setDiscoverTargets',
]);
const ACTIVATION = new Set(['Target.activateTarget', 'Page.bringToFront']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAX_MESSAGE = 1_048_576;

export class NativeCommandTransport extends EventEmitter {
  constructor({ send, timeoutMs = 10_000 }) {
    super();
    if (typeof send !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new BrokerError('INVALID_NATIVE_TRANSPORT', 'Native transport requires a sender and bounded request deadline');
    }
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.closed = false;
  }

  request({ leaseId, method, params = {} }) {
    if (this.closed) return Promise.reject(new BrokerError('NATIVE_TRANSPORT_DISCONNECTED', 'Native transport is disconnected'));
    if (!ID.test(leaseId ?? '') || typeof method !== 'string' || !/^[a-z][a-z.]{0,63}$/u.test(method) ||
        !params || typeof params !== 'object' || Array.isArray(params)) {
      return Promise.reject(new BrokerError('NATIVE_REQUEST_INVALID', 'Native request requires an exact lease, method and object parameters'));
    }
    if (this.pending.size >= 256) return Promise.reject(new BrokerError('NATIVE_QUEUE_FULL', 'Native IPC queue is full'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrokerError('NATIVE_REQUEST_TIMEOUT', 'Native reply deadline elapsed; dispatched effects still require reconciliation'));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      Promise.resolve().then(() => {
        if (this.closed || !this.pending.has(id)) return;
        return this.send({ id, leaseId, method, params });
      }).catch(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new BrokerError('NATIVE_SEND_FAILED', 'Native IPC write failed; retain dispatched-effect evidence'));
      });
    });
  }

  receive(message) {
    if (this.closed || !message || typeof message !== 'object' || Array.isArray(message)) return false;
    if (typeof message.event === 'string') {
      this.emit('event', message);
      return true;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError || (hasError && (typeof message.error?.code !== 'string' || typeof message.error?.message !== 'string'))) {
      pending.reject(new BrokerError('NATIVE_RESPONSE_INVALID', 'Native response is missing or ambiguous'));
    } else if (hasError) {
      pending.reject(new BrokerError(message.error.code, message.error.message));
    } else pending.resolve(message.result);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BrokerError('NATIVE_TRANSPORT_DISCONNECTED', 'Native IPC disconnected; owned effects remain recorded'));
    }
    this.pending.clear();
    this.emit('close');
  }
}

function sameIdentity(left, right) {
  return ['pid', 'startIdentity', 'owner', 'executable', 'profileRoot'].every(key => left?.[key] === right?.[key]);
}

function denied(code, message) {
  return new BrokerError('NATIVE_CDP_DENIED', message, { cdpCode: code });
}

function virtualTarget(leaseId, tabId) {
  return `${leaseId}:${tabId}`;
}

function frameReferences(value, from, to, frameObject = false) {
  if (Array.isArray(value)) return value.map(item => frameReferences(item, from, to));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    (['frameId', 'parentFrameId', 'parentId'].includes(key) || (frameObject && key === 'id')) && item === from
      ? to : frameReferences(item, from, to, key === 'frame'),
  ]));
}

export async function startNativeCdp({ transport, stateDir, contextIdentity, host = '127.0.0.1', port = 0 }) {
  if (host !== '127.0.0.1' || !transport || typeof transport.request !== 'function' ||
      !ID.test(contextIdentity?.transportGeneration ?? '') ||
      !/^[a-f0-9]{64}$/u.test(contextIdentity?.profileToken ?? '') ||
      !Number.isSafeInteger(contextIdentity?.processIdentity?.pid) ||
      contextIdentity.processIdentity.pid <= 0 ||
      ['startIdentity', 'owner', 'executable', 'profileRoot'].some(key =>
        typeof contextIdentity.processIdentity[key] !== 'string' || !contextIdentity.processIdentity[key].trim())) {
    throw new BrokerError('INVALID_NATIVE_CONTEXT', 'Native CDP requires an attested loopback transport and profile identity');
  }
  await ensureStateDirectory(stateDir);
  const identity = structuredClone(contextIdentity.processIdentity);
  const generation = contextIdentity.transportGeneration;
  const capability = randomBytes(32);
  const capabilityText = capability.toString('hex');
  const bindings = new Map();
  const peers = new Set();
  const privateFile = path.join(stateDir, `native-cdp-${createHash('sha256').update(generation).digest('hex')}.json`);
  let closed = false;
  let closing;
  let origin;
  let privateReservation;
  const native = (leaseId, method, params = {}) => transport.request({ leaseId, method, params });

  async function leaseRecord(leaseId) {
    const binding = bindings.get(leaseId);
    const lease = (await readRegistry(stateDir)).leases[leaseId];
    if (!binding || !lease || lease.owner !== binding.owner || !sameIdentity(lease.processIdentity, identity)) {
      throw denied(-32002, 'The native lease is not bound to this browser generation');
    }
    return lease;
  }

  async function bindLease({ leaseId, owner }) {
    if (closed || !ID.test(leaseId ?? '') || typeof owner !== 'string' || !owner) {
      throw new BrokerError('INVALID_NATIVE_BINDING', 'Native lease binding requires an exact lease and owner');
    }
    const lease = (await readRegistry(stateDir)).leases[leaseId];
    if (!lease || lease.owner !== owner || !sameIdentity(lease.processIdentity, identity) || bindings.has(leaseId)) {
      throw new BrokerError('INVALID_NATIVE_BINDING', 'Native lease binding does not match its recorded browser and owner');
    }
    await native(leaseId, 'lease.bind', {
      profileToken: contextIdentity.profileToken, owner, work: null, transportGeneration: generation,
    });
    bindings.set(leaseId, { owner });
    return { rawEndpoint: endpointForLease(leaseId), transportGeneration: generation };
  }

  function endpointForLease(leaseId) {
    if (!bindings.has(leaseId) || closed) throw new BrokerError('NATIVE_LEASE_NOT_BOUND', 'Native lease namespace is unavailable');
    return `${origin}/native/${capabilityText}/${leaseId}`;
  }

  async function unbindLease(leaseId) {
    const lease = await leaseRecord(leaseId);
    if (lease.targetIds.length || lease.pendingTargetCreates?.length) {
      throw new BrokerError('NATIVE_LEASE_NOT_EMPTY', 'Native lease still has owned targets or pending effects');
    }
    await native(leaseId, 'lease.unbind');
    bindings.delete(leaseId);
  }

  async function readTargets(leaseId) {
    let lease = await leaseRecord(leaseId);
    const observed = await native(leaseId, 'target.readback');
    if (!observed || !Array.isArray(observed.tabs)) throw new BrokerError('INVALID_NATIVE_READBACK', 'Native target readback is incomplete');
    const control = observed.tabs.find(tab => tab.control === true);
    const pending = lease.pendingTargetCreates ?? [];
    const matching = observed.tabs.find(tab => !tab.control && pending.some(item => item.markerUrl === tab.url));
    const marker = matching ? pending.find(item => item.markerUrl === matching.url)?.marker : pending[0]?.marker;
    if (control && marker) {
      const routes = {};
      for (const tab of observed.tabs) {
        if (tab.control) continue;
        const targetId = virtualTarget(leaseId, tab.tabId);
        const known = lease.nativeRouting?.targetTabs?.[targetId];
        if (known || pending.some(item => item.markerUrl === tab.url)) {
          routes[targetId] = { tabId: tab.tabId, windowId: tab.windowId };
        }
      }
      await recordNativeRouting({
        stateDir, leaseId, processIdentity: identity, marker, transportGeneration: generation,
        controlTargetId: virtualTarget(leaseId, control.tabId), controlTabId: control.tabId,
        controlMarker: observed.controlMarker, windowId: observed.windowId, targetTabs: routes,
      });
      lease = await leaseRecord(leaseId);
    }
    const targets = [];
    for (const tab of observed.tabs) {
      const targetId = virtualTarget(leaseId, tab.tabId);
      const route = lease.nativeRouting?.targetTabs?.[targetId];
      if (tab.control || !route || !lease.targetIds.includes(targetId)) continue;
      if (route.tabId !== tab.tabId || route.windowId !== tab.windowId) {
        throw new BrokerError('NATIVE_WINDOW_MISMATCH', 'Native target readback no longer matches its recorded routing');
      }
      targets.push({ targetId, tabId: tab.tabId, windowId: tab.windowId, browserContextId: `native:${leaseId}`,
        ...(route.openerTargetId ? { openerId: route.openerTargetId } : {}),
        type: 'page', title: tab.title ?? '', url: tab.url ?? '', attached: true });
    }
    return targets;
  }

  function authenticate(url) {
    const match = /^\/native\/([a-f0-9]{64})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})(\/.*)?$/u.exec(url ?? '');
    if (!match || !timingSafeEqual(Buffer.from(match[1], 'hex'), capability)) return { status: 401 };
    if (!bindings.has(match[2])) return { status: 403 };
    return { leaseId: match[2], suffix: match[3] ?? '' };
  }

  const server = http.createServer((request, response) => {
    const auth = authenticate(request.url);
    if (auth.status) {
      response.writeHead(auth.status);
      response.end();
      return;
    }
    if (request.method !== 'GET' || !['/json/version', '/json/version/'].includes(auth.suffix)) {
      response.writeHead(404);
      response.end();
      return;
    }
    leaseRecord(auth.leaseId).then(() => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        Browser: contextIdentity.browserVersion,
        webSocketDebuggerUrl: endpointForLease(auth.leaseId).replace('http:', 'ws:') + '/devtools/browser',
      }));
    }, () => {
      response.writeHead(403);
      response.end();
    });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  server.on('upgrade', (request, socket, head) => {
    const auth = authenticate(request.url);
    if (auth.status || auth.suffix !== '/devtools/browser') {
      socket.end(`HTTP/1.1 ${auth.status ?? 404} Refused\r\nConnection: close\r\n\r\n`);
      return;
    }
    leaseRecord(auth.leaseId).then(() => {
      sockets.handleUpgrade(request, socket, head, connected => sockets.emit('connection', connected, auth.leaseId));
    }, () => socket.end('HTTP/1.1 403 Refused\r\nConnection: close\r\n\r\n'));
  });

  sockets.on('connection', (socket, leaseId) => {
    const peer = { socket, leaseId, sessions: new Map(), discover: false, autoAttach: false };
    peers.add(peer);
    let queued = 0;
    let processing = Promise.resolve();
    const send = message => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    async function targetRoute(targetId, allowControl = false) {
      const lease = await leaseRecord(leaseId);
      if (allowControl && targetId === lease.nativeRouting?.controlTargetId) {
        return { tabId: lease.nativeRouting.controlTabId, windowId: lease.nativeRouting.windowId, control: true };
      }
      const route = lease.nativeRouting?.targetTabs?.[targetId];
      if (!route || !lease.targetIds.includes(targetId)) throw denied(-32002, 'Cannot access a target owned by another native lease');
      return route;
    }
    async function attach(targetId, announce = false) {
      const route = await targetRoute(targetId);
      const existing = [...peer.sessions.entries()].find(([, session]) => session.targetId === targetId && !session.nativeSessionId);
      if (existing) return existing[0];
      await native(leaseId, 'target.attach', { tabId: route.tabId });
      const frameTree = await native(leaseId, 'target.command', {
        tabId: route.tabId, method: 'Page.getFrameTree', params: {},
      });
      const nativeFrameId = frameTree?.frameTree?.frame?.id;
      if (typeof nativeFrameId !== 'string' || !nativeFrameId) {
        throw new BrokerError('NATIVE_FRAME_IDENTITY_MISSING', 'Owned renderer did not return its root frame identity');
      }
      await native(leaseId, 'target.command', {
        tabId: route.tabId, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true },
      });
      const source = `(() => { const id = ${JSON.stringify(targetId)}; const prior = Object.getOwnPropertyDescriptor(globalThis, "__deskNativeTargetId"); if (prior && prior.value !== id) throw new Error("NATIVE_TARGET_ID_CONFLICT"); if (!prior) Object.defineProperty(globalThis, "__deskNativeTargetId", { value: id, configurable: false, writable: false }); return true; })()`;
      await native(leaseId, 'target.command', {
        tabId: route.tabId, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source },
      });
      const annotation = await native(leaseId, 'target.command', {
        tabId: route.tabId, method: 'Runtime.evaluate', params: { expression: source, returnByValue: true },
      });
      if (annotation?.exceptionDetails || annotation?.result?.value !== true) {
        throw new BrokerError('NATIVE_TARGET_ANNOTATION_FAILED', 'Owned renderer did not confirm its immutable native target identity');
      }
      const sessionId = randomUUID();
      peer.sessions.set(sessionId, { targetId, tabId: route.tabId, nativeFrameId });
      if (announce) {
        const info = (await readTargets(leaseId)).find(target => target.targetId === targetId);
        if (!info) throw denied(-32002, 'Attached native target disappeared before its readback');
        send({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: info, waitingForDebugger: false } });
      }
      return sessionId;
    }
    peer.attach = attach;
    peer.send = send;
    async function command(message) {
      await leaseRecord(leaseId);
      const { method, params = {}, sessionId } = message;
      if (ACTIVATION.has(method)) throw denied(-32001, 'Native target activation is denied');
      if (sessionId !== undefined) {
        const session = peer.sessions.get(sessionId);
        if (!session) throw denied(-32003, 'Cannot access a session owned by another native client');
        await targetRoute(session.targetId);
        if (/^(Browser|Storage|DOMStorage|IndexedDB|CacheStorage|Database|ServiceWorker)\./u.test(method) ||
            (method.startsWith('Target.') && method !== 'Target.setAutoAttach') ||
            ['Network.clearBrowserCache', 'Network.clearBrowserCookies', 'Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies'].includes(method)) {
          throw denied(-32004, 'Native browser-global and profile storage methods are denied');
        }
        const mappedParams = method.startsWith('Page.') || method === 'DOM.getFrameOwner'
          ? frameReferences(params, session.targetId, session.nativeFrameId) : params;
        const result = await native(leaseId, 'target.command', {
          tabId: session.tabId, method, params: mappedParams, ...(session.nativeSessionId ? { sessionId: session.nativeSessionId } : {}),
        });
        return method.startsWith('Page.') ? frameReferences(result, session.nativeFrameId, session.targetId) : result;
      }
      if (!ROOT_METHODS.has(method)) throw denied(-32004, 'Native browser-global command is denied');
      if (method === 'Browser.getVersion') {
        return { protocolVersion: contextIdentity.protocolVersion ?? '1.3', product: contextIdentity.browserVersion,
          userAgent: contextIdentity.userAgent, revision: '', jsVersion: '' };
      }
      if (method === 'Browser.getWindowForTarget') {
        const route = await targetRoute(params.targetId);
        const observed = await native(leaseId, 'target.readback');
        const window = observed?.windows?.find(candidate => candidate.id === route.windowId);
        if (!window || ['left', 'top', 'width', 'height'].some(key => !Number.isFinite(window[key]))) {
          throw denied(-32006, 'Exact native window bounds could not be observed');
        }
        return { windowId: route.windowId, bounds: {
          left: window.left, top: window.top, width: window.width, height: window.height, windowState: window.state,
        } };
      }
      if (method === 'Target.getTargets') return { targetInfos: await readTargets(leaseId) };
      if (method === 'Target.getTargetInfo') {
        const targets = await readTargets(leaseId);
        const info = params.targetId ? targets.find(target => target.targetId === params.targetId) : targets[0];
        if (!info) throw denied(-32002, 'Native lease has no matching task target');
        return { targetInfo: info };
      }
      if (method === 'Target.createTarget') {
        const lease = await leaseRecord(leaseId);
        const pending = lease.pendingTargetCreates?.find(create => create.markerUrl === params.url);
        if (!pending) throw denied(-32002, 'Native target create must be recorded before dispatch');
        if (lease.pendingTargetCreates.length !== 1) throw denied(-32006, 'An earlier native create still needs reconciliation');
        let created;
        try {
          created = await native(leaseId, 'target.create', { marker: pending.marker, markerUrl: pending.markerUrl });
          await recordNativeRouting({
            stateDir, leaseId, processIdentity: identity, marker: pending.marker, transportGeneration: generation,
            controlTargetId: virtualTarget(leaseId, created.controlTabId), controlTabId: created.controlTabId,
            controlMarker: created.controlMarker, windowId: created.windowId,
            targetTabs: { [virtualTarget(leaseId, created.tabId)]: { tabId: created.tabId, windowId: created.windowId } },
          });
          await readTargets(leaseId);
        } catch (error) {
          await readTargets(leaseId);
          throw error;
        }
        const targetId = virtualTarget(leaseId, created.tabId);
        await targetRoute(targetId);
        const info = (await readTargets(leaseId)).find(target => target.targetId === targetId);
        for (const observer of peers) {
          if (observer.leaseId !== leaseId || observer.socket.readyState !== WebSocket.OPEN) continue;
          if (observer.discover) observer.send({ method: 'Target.targetCreated', params: { targetInfo: info } });
          if (observer.autoAttach) await observer.attach(targetId, true);
        }
        return { targetId };
      }
      if (method === 'Target.attachToTarget') {
        if (params.flatten !== true) throw denied(-32004, 'Native CDP supports flattened sessions only');
        return { sessionId: await attach(params.targetId) };
      }
      if (method === 'Target.detachFromTarget') {
        if (!peer.sessions.has(params.sessionId)) throw denied(-32003, 'Cannot detach a foreign native session');
        peer.sessions.delete(params.sessionId);
        return {};
      }
      if (method === 'Target.closeTarget') {
        const route = await targetRoute(params.targetId, true);
        const result = await native(leaseId, 'target.close', { tabId: route.tabId });
        if (result?.closed !== true) throw denied(-32006, 'Native target close was not confirmed');
        return { success: true };
      }
      if (method === 'Target.setDiscoverTargets') {
        peer.discover = params.discover === true;
        if (peer.discover) for (const info of await readTargets(leaseId)) send({ method: 'Target.targetCreated', params: { targetInfo: info } });
        return {};
      }
      if (method === 'Target.setAutoAttach') {
        if (params.flatten !== true) throw denied(-32004, 'Native auto-attachment requires flattened sessions');
        peer.autoAttach = params.autoAttach === true;
        if (peer.autoAttach) for (const info of await readTargets(leaseId)) await attach(info.targetId, true);
        return {};
      }
      throw denied(-32004, 'Native method has no supported translation');
    }
    socket.on('message', (bytes, binary) => {
      if (++queued > 64) {
        socket.close(1008, 'Native command queue is full');
        return;
      }
      processing = processing.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        let message;
        try {
          if (binary) throw new Error('binary message');
          message = JSON.parse(bytes.toString('utf8'));
          if (!Number.isSafeInteger(message?.id) || typeof message.method !== 'string' ||
              (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)))) {
            throw new Error('invalid CDP message');
          }
        } catch {
          socket.close(1008, 'Invalid native CDP message');
          return;
        }
        try {
          const result = await command(message);
          send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result });
        } catch (error) {
          send({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: {
            code: error.details?.cdpCode ?? -32006,
            message: error instanceof BrokerError
              ? redactNativeSurface(error.message, { secrets: [capabilityText, contextIdentity.profileToken] })
              : 'Native operation failed; retain owned-effect evidence for reconciliation',
          } });
        }
      }).finally(() => { queued--; });
      processing.catch(() => socket.close(1011, 'Native command processing failed'));
    });
    socket.on('error', () => socket.close());
    socket.on('close', () => { peer.sessions.clear(); peers.delete(peer); });
  });

  const onTransportClose = () => {
    for (const peer of peers) peer.socket.close(1011, 'Native transport disconnected');
  };
  const onTransportEvent = message => {
    if (closed || !bindings.has(message?.leaseId)) return;
    const routeEvent = async () => {
      const lease = await leaseRecord(message.leaseId);
      if (message.event === 'target.popup') {
        const opener = Object.entries(lease.nativeRouting?.targetTabs ?? {})
          .find(([id, route]) => route.tabId === message.openerTabId && lease.targetIds.includes(id));
        if (!opener || lease.releasing) return;
        const admitted = await native(message.leaseId, 'target.admit', {
          tabId: message.tabId, openerTabId: message.openerTabId,
        });
        if (admitted.tabId !== message.tabId || admitted.windowId !== message.windowId) {
          throw new BrokerError('NATIVE_POPUP_NOT_OWNED', 'Native popup readback did not match its exact creation event');
        }
        const targetId = virtualTarget(message.leaseId, admitted.tabId);
        await recordNativeRouting({
          stateDir, leaseId: message.leaseId, processIdentity: identity, transportGeneration: generation,
          ...lease.nativeRouting, openerTargetId: opener[0],
          targetTabs: { [targetId]: { tabId: admitted.tabId, windowId: admitted.windowId } },
        });
        const info = (await readTargets(message.leaseId)).find(target => target.targetId === targetId);
        for (const peer of peers) {
          if (peer.leaseId !== message.leaseId || peer.socket.readyState !== WebSocket.OPEN) continue;
          if (peer.discover) peer.send({ method: 'Target.targetCreated', params: { targetInfo: info } });
          if (peer.autoAttach) await peer.attach(targetId, true);
        }
        return;
      }
      if (message.event !== 'cdp') return;
      const target = Object.entries(lease.nativeRouting?.targetTabs ?? {})
        .find(([targetId, route]) => route.tabId === message.tabId && lease.targetIds.includes(targetId));
      if (!target) return;
      for (const peer of peers) {
        if (peer.leaseId !== message.leaseId || peer.socket.readyState !== WebSocket.OPEN) continue;
        const parent = [...peer.sessions.entries()].find(([, session]) =>
          session.tabId === message.tabId &&
          (session.nativeSessionId ?? undefined) === (message.sessionId ?? undefined));
        if (!parent) continue;
        const [parentId, parentSession] = parent;
        const eventParams = frameReferences(message.params, parentSession.nativeFrameId, parentSession.targetId);
        if (message.method === 'Target.attachedToTarget') {
          if (!['iframe', 'worker'].includes(message.params?.targetInfo?.type) ||
              typeof message.params.sessionId !== 'string' || !message.params.sessionId) continue;
          if (peer.sessions.size >= 256) {
            peer.socket.close(1008, 'Native session limit exceeded');
            continue;
          }
          const existing = [...peer.sessions.entries()].find(([, session]) =>
            session.nativeSessionId === message.params.sessionId && session.tabId === message.tabId);
          if (existing) continue;
          const childId = randomUUID();
          peer.sessions.set(childId, {
            targetId: target[0], tabId: message.tabId, nativeSessionId: message.params.sessionId,
            nativeFrameId: parentSession.nativeFrameId, parentSessionId: parentId,
          });
          peer.socket.send(JSON.stringify({
            method: message.method, sessionId: parentId,
            params: { ...eventParams, sessionId: childId,
              targetInfo: { ...eventParams.targetInfo } },
          }));
          continue;
        }
        if (message.method === 'Target.detachedFromTarget') {
          const child = [...peer.sessions.entries()].find(([, session]) =>
            session.nativeSessionId === message.params?.sessionId && session.parentSessionId === parentId);
          if (!child) continue;
          const ids = new Set([child[0]]);
          for (const [sessionId, session] of peer.sessions) {
            if (ids.has(session.parentSessionId)) ids.add(sessionId);
          }
          for (const sessionId of ids) peer.sessions.delete(sessionId);
          peer.socket.send(JSON.stringify({ method: message.method, sessionId: parentId,
            params: { ...message.params, sessionId: child[0] } }));
          continue;
        }
        if (typeof message.method === 'string' && !message.method.startsWith('Browser.') &&
            !message.method.startsWith('Target.')) {
          const mapped = message.method.startsWith('Page.') || message.method.startsWith('Network.') ||
            message.method === 'Runtime.executionContextCreated' ? eventParams : message.params;
          peer.socket.send(JSON.stringify({ method: message.method, params: mapped, sessionId: parentId }));
        }
      }
    };
    routeEvent().catch(() => {
      for (const peer of peers) {
        if (peer.leaseId === message.leaseId) peer.socket.close(1011, 'Native event ownership could not be verified');
      }
    });
  };
  transport.on?.('close', onTransportClose);
  transport.on?.('event', onTransportEvent);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  origin = `http://${host}:${server.address().port}`;

  async function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      transport.off?.('close', onTransportClose);
      transport.off?.('event', onTransportEvent);
      for (const peer of peers) peer.socket.terminate();
      sockets.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (privateReservation) {
        try {
          const current = await lstat(privateFile, { bigint: true });
          if (!current.isFile() || current.dev !== privateReservation.dev || current.ino !== privateReservation.ino) {
            throw new BrokerError('NATIVE_STATE_CHANGED', 'Native state was replaced; its cleanup is not authorized');
          }
          await unlink(privateFile);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    })();
    return closing;
  }
  try {
    const file = await open(privateFile, 'wx', 0o600);
    try {
      const reserved = await file.stat({ bigint: true });
      privateReservation = { dev: reserved.dev, ino: reserved.ino };
      await file.writeFile(JSON.stringify({ version: 1, capability: capabilityText, origin, generation, pid: process.pid }));
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    await close();
    throw error;
  }
  return Object.freeze({ origin, generation, bindLease, unbindLease, endpointForLease, close });
}
