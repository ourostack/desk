import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { open, lstat, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';

import { BrokerError } from './claims.mjs';
import { ensureStateDirectory, readRegistry } from './registry.mjs';
import { createLease, createOwnedTarget, clearLeaseTargets, releaseLease, withLeaseOperation, recordLeasePurpose, renewNativeLeaseBinding } from './leases.mjs';
import { startLeaseProxy } from './cdp-proxy.mjs';
import { startNativeCdp } from './native-cdp.mjs';
import { readNativeProcess } from './native-host.mjs';
import { redactNativeSurface } from './secret-surfaces.mjs';
import { withBrokerLock } from './lock.mjs';

const MAX_BYTES = 1_048_576;
const IDENTITY_KEYS = ['pid', 'startIdentity', 'owner', 'executable'];

function sameIdentity(left, right) {
  return IDENTITY_KEYS.every(key => left?.[key] === right?.[key]);
}

export async function startNativeProvider({ stateDir, transport, contextIdentity, processReader = readNativeProcess }) {
  const major = Number(/(?:Chrome|Chromium|Edg)\/(\d+)\./u.exec(contextIdentity?.browserVersion ?? '')?.[1]);
  if (!Number.isSafeInteger(major) || major < 125) {
    throw new BrokerError('NATIVE_BROWSER_VERSION_UNSUPPORTED', 'Native Desk browser ownership requires Chrome or Edge 125 or newer');
  }
  await ensureStateDirectory(stateDir);
  const identity = structuredClone(contextIdentity.processIdentity);
  const chain = structuredClone(contextIdentity.mediationChain);
  if (!Array.isArray(chain) || chain.length !== 2 || !sameIdentity(chain[1], contextIdentity.endpointProcessIdentity) ||
      chain[0].parentPid !== identity.pid || chain[1].parentPid !== chain[0].pid) {
    throw new BrokerError('INVALID_NATIVE_CONTEXT', 'Native provider requires complete browser-entry-runtime ancestry');
  }
  const adapter = await startNativeCdp({ transport, stateDir, contextIdentity });
  const capability = randomBytes(32);
  const secret = capability.toString('hex');
  const readyFile = path.join(stateDir, `native-provider-${createHash('sha256').update(identity.executable + '\0' + identity.profileRoot).digest('hex')}.json`);
  let disconnected = false;
  let closing;
  let reservation;
  let endpoint;
  let updateToken;
  let reloadPrepared;
  let activeOperations = 0;
  const proxies = new Map();
  const context = {
    id: createHash('sha256').update(identity.executable + '\0' + identity.profileRoot).digest('hex'),
    launch: { executable: identity.executable, profileRoot: identity.profileRoot },
    mediation: { entryExecutable: chain[0].executable, runtimeExecutable: chain[1].executable },
  };
  const lost = () => { disconnected = true; };
  transport.on?.('close', lost);

  async function invoke(operation, payload = {}) {
    const effect = ['acquire', 'resume', 'ensureWindow', 'clear', 'release', 'purpose', 'peek'].includes(operation);
    if (updateToken && effect) {
      throw new BrokerError('NATIVE_UPDATE_IN_PROGRESS', 'Native provider is paused for a deliberate source update');
    }
    if (effect) activeOperations++;
    try {
      return await invokeOperation(operation, payload);
    } finally {
      if (effect) activeOperations--;
    }
  }

  async function invokeOperation(operation, payload = {}) {
    if (operation === 'prepareUpdate') {
      const attested = await invoke('attest', { expectedProcessIdentity: payload.expectedProcessIdentity });
      if (!attested.healthy) throw new BrokerError('NATIVE_TRANSPORT_DISCONNECTED', 'Native update requires a live exact provider');
      if (updateToken || activeOperations !== 0 || typeof transport.pause !== 'function' || typeof transport.resume !== 'function') {
        throw new BrokerError('NATIVE_UPDATE_EFFECTS_PENDING', 'Native operations must settle before source update');
      }
      updateToken = randomBytes(32).toString('hex');
      try {
        transport.pause();
        await withBrokerLock(stateDir, async () => {
          const registry = await readRegistry(stateDir);
          const leases = Object.values(registry.leases).filter(lease => lease.contextId === context.id);
          const activeOwners = leases.filter(lease => lease.targetIds.length || lease.nativeRouting?.controlTabId);
          if (activeOwners.length) {
            throw new BrokerError('NATIVE_UPDATE_ACTIVE_OWNERS', 'Deliberate extension reload must wait for exact owners to close their targets',
              { owners: activeOwners.map(lease => lease.owner) });
          }
          if (leases.some(lease => lease.releasing || lease.pendingTargetCreates?.length ||
              !sameIdentity(lease.processIdentity, identity))) {
            throw new BrokerError('NATIVE_UPDATE_EFFECTS_PENDING', 'Exact recorded browser effects must reconcile before source update');
          }
        });
        return { safe: true, updateToken };
      } catch (error) {
        updateToken = undefined;
        transport.resume();
        throw error;
      }
    }
    if (['cancelUpdate', 'reloadExtension'].includes(operation)) {
      if (!updateToken || payload.updateToken !== updateToken) {
        throw new BrokerError('NATIVE_UPDATE_TOKEN_INVALID', 'Native update operation requires its exact quiescence token');
      }
      if (operation === 'cancelUpdate') {
        if (reloadPrepared) throw new BrokerError('NATIVE_UPDATE_EFFECTS_PENDING', 'A prepared reload must reconcile before cancellation');
        updateToken = undefined;
        transport.resume();
        return { cancelled: true };
      }
      const result = await transport.request({
        leaseId: 'provider-update', method: 'extension.reload', params: { profileToken: contextIdentity.profileToken, updateToken },
      });
      if (result?.reload !== true) {
        throw new BrokerError('NATIVE_UPDATE_UNCONFIRMED', 'Native extension did not acknowledge its deliberate reload');
      }
      reloadPrepared = updateToken;
      return { reloading: true, reconciliationRequired: true };
    }
    if (operation === 'status') {
      const registry = await readRegistry(stateDir);
      return { contextId: context.id, processIdentity: identity, disconnected,
        leases: Object.values(registry.leases).filter(lease => lease.contextId === context.id)
          .map(lease => ({ leaseId: lease.id, owner: lease.owner, targetCount: lease.targetIds.length, releasing: Boolean(lease.releasing) })) };
    }
    if (operation === 'acquire') {
      if (disconnected) throw new BrokerError('NATIVE_TRANSPORT_DISCONNECTED', 'Native transport is disconnected');
      if (typeof payload.owner !== 'string' || !payload.owner.trim() || payload.owner.length > 160 ||
          /[\u0000-\u001f\u007f]/u.test(payload.owner)) {
        throw new BrokerError('NATIVE_OWNER_INVALID', 'Native ownership requires a bounded nonempty label');
      }
      const lease = await createLease({
        stateDir, context, owner: payload.owner, processIdentity: identity, mediationChain: chain,
        rawEndpoint: endpoint, deferInitialTarget: true,
        providerBind: ({ lease }) => adapter.bindLease({ leaseId: lease.id, owner: lease.owner }),
      });
      let proxy;
      try {
        proxy = await startLeaseProxy({ stateDir, leaseId: lease.id, declaration: context, providerInvoker: attestor });
      } catch (error) {
        await releaseLease({ stateDir, leaseId: lease.id, declaration: context, providerInvoker: attestor });
        throw error;
      }
      proxies.set(lease.id, proxy);
      return { leaseId: lease.id, endpoint: proxy.endpoint, owner: lease.owner, contextId: context.id,
        processIdentity: identity, mediationChain: chain };
    }
    if (['resume', 'ensureWindow', 'clear', 'release', 'purpose', 'peers', 'peek'].includes(operation)) {
      const lease = (await readRegistry(stateDir)).leases[payload.leaseId];
      if (!lease || lease.owner !== payload.owner || !proxies.has(lease.id) || !sameIdentity(lease.processIdentity, identity)) {
        throw new BrokerError('NATIVE_LEASE_OWNER_MISMATCH', 'Native operation does not match the exact bound lease owner');
      }
      if (disconnected) throw new BrokerError('NATIVE_TRANSPORT_DISCONNECTED', 'Native transport is disconnected; owned effects remain recorded');
      if (operation === 'resume') {
        if (!sameIdentity(payload.expectedProcessIdentity, identity) ||
            payload.expectedProcessIdentity?.profileRoot !== identity.profileRoot) {
          throw new BrokerError('NATIVE_BROWSER_GENERATION_MISMATCH', 'Native resume cannot inherit a different browser or profile');
        }
        const attested = await invoke('attest', { expectedProcessIdentity: payload.expectedProcessIdentity });
        if (!attested.healthy) throw new BrokerError('NATIVE_TRANSPORT_DISCONNECTED', 'Native resume requires fresh provider attestation');
        return withLeaseOperation(stateDir, lease.id, async () => {
          const current = (await readRegistry(stateDir)).leases[lease.id];
          if (current.releasing || current.pendingTargetCreates?.length) {
            throw new BrokerError('NATIVE_EFFECT_PENDING', 'Native resume requires exact pending effects to reconcile');
          }
          return { leaseId: lease.id, owner: lease.owner, endpoint: proxies.get(lease.id).endpoint };
        });
      }
      if (operation === 'peek') {
        if (!['snapshot', 'screenshot'].includes(payload.format)) {
          throw new BrokerError('NATIVE_PEEK_FORMAT_INVALID', 'Native peer inspection permits snapshot or screenshot only');
        }
        return withLeaseOperation(stateDir, payload.peerLeaseId, async () => {
          const peer = (await readRegistry(stateDir)).leases[payload.peerLeaseId];
          const route = peer?.nativeRouting?.targetTabs?.[payload.targetId];
          if (!peer || peer.contextId !== context.id || !sameIdentity(peer.processIdentity, identity) ||
              peer.releasing || Date.parse(peer.expiresAt) <= Date.now() ||
              !peer.targetIds.includes(payload.targetId) || !route) {
            throw new BrokerError('NATIVE_PEER_NOT_OWNED', 'Peer inspection requires one exact live recorded task target');
          }
          await transport.request({ leaseId: peer.id, method: 'target.attach', params: { tabId: route.tabId } });
          const result = await transport.request({
            leaseId: peer.id, method: 'target.command',
            params: {
              tabId: route.tabId, method: payload.format === 'snapshot' ? 'Accessibility.getFullAXTree' : 'Page.captureScreenshot',
              params: payload.format === 'snapshot' ? {} : { format: 'png', captureBeyondViewport: false },
            },
          });
          const limit = payload.format === 'snapshot' ? 65536 : 1048576;
          if (Buffer.byteLength(JSON.stringify(result)) > limit ||
              (payload.format === 'snapshot' && !Array.isArray(result.nodes)) ||
              (payload.format === 'screenshot' && typeof result.data !== 'string')) {
            throw new BrokerError('NATIVE_PEEK_LIMIT', 'Exact peer readback exceeded its bounded shape or size');
          }
          return { ...result, attribution: { leaseId: peer.id, owner: peer.owner, work: peer.work ?? null, targetId: payload.targetId } };
        });
      }
      if (operation === 'peers') {
        const registry = await readRegistry(stateDir);
        return { leases: Object.values(registry.leases).filter(peer => peer.contextId === context.id &&
          sameIdentity(peer.processIdentity, identity) && Date.parse(peer.expiresAt) > Date.now() &&
          !peer.releasing).map(peer => ({
          leaseId: peer.id, owner: peer.owner, work: peer.work ?? null, windowId: peer.nativeRouting?.windowId,
          targetIds: peer.targetIds.filter(id => id !== peer.nativeRouting?.controlTargetId),
        })) };
      }
      if (operation === 'purpose') {
        return withLeaseOperation(stateDir, lease.id, async () => {
          const current = (await readRegistry(stateDir)).leases[lease.id];
          if (!current.targetIds.includes(payload.targetId) || !current.nativeRouting?.targetTabs?.[payload.targetId] ||
              current.releasing) {
            throw new BrokerError('NATIVE_TARGET_NOT_OWNED', 'Purpose updates require an exact live owned task target');
          }
          if (payload.work !== null && (typeof payload.work !== 'string' || !payload.work.trim() ||
              payload.work.length > 160 || /[\u0000-\u001f\u007f]/u.test(payload.work))) {
            throw new BrokerError('NATIVE_PURPOSE_INVALID', 'Purpose requires a bounded label or null');
          }
          const result = await transport.request({ leaseId: lease.id, method: 'purpose.set', params: { work: payload.work } });
          const expected = `Desk | ${lease.owner}${payload.work === null ? '' : ' | ' + payload.work}`;
          if (result?.title !== expected) throw new BrokerError('NATIVE_PURPOSE_UNCONFIRMED', 'Owner control did not confirm its exact purpose label');
          await recordLeasePurpose(stateDir, lease.id, payload.work);
          return result;
        });
      }
      if (operation === 'ensureWindow') {
        return withLeaseOperation(stateDir, lease.id, async () => {
          const current = (await readRegistry(stateDir)).leases[lease.id];
          if (current.releasing || current.pendingTargetCreates?.length) {
            throw new BrokerError('NATIVE_EFFECT_PENDING', 'Native lease has unresolved operations; exact reconciliation is required');
          }
          const taskId = current.targetIds.find(id => id !== current.nativeRouting?.controlTargetId);
          const created = taskId ? { targetId: taskId } : await createOwnedTarget({
            stateDir, leaseId: lease.id, rawEndpoint: current.rawEndpoint, params: { url: 'about:blank' },
          });
          return { targetId: created.targetId, endpoint: proxies.get(lease.id).endpoint };
        });
      }
      const options = { stateDir, leaseId: lease.id, declaration: context, providerInvoker: attestor };
      const result = operation === 'clear' ? await clearLeaseTargets(options) : await releaseLease(options);
      if (operation === 'release' && result.released) {
        await proxies.get(lease.id).close();
        proxies.delete(lease.id);
      }
      return result;
    }
    if (operation !== 'attest') throw new BrokerError('NATIVE_PROVIDER_METHOD_DENIED', 'Native provider operation is not supported');
    if (!sameIdentity(payload.expectedProcessIdentity, identity)) {
      throw new BrokerError('NATIVE_BROWSER_GENERATION_MISMATCH', 'The expected browser generation does not match this native provider');
    }
    if (disconnected) return { healthy: false, reason: 'MEDIATOR_UNAVAILABLE' };
    const observed = await processReader(identity.pid);
    if (!sameIdentity(observed, identity)) {
      throw new BrokerError('NATIVE_BROWSER_GENERATION_MISMATCH', 'The native browser generation cannot be confirmed');
    }
    for (const recorded of chain) {
      const current = await processReader(recorded.pid);
      if (!sameIdentity(current, recorded) || current?.parentPid !== recorded.parentPid) {
        return { healthy: false, reason: 'MEDIATOR_UNAVAILABLE' };
      }
    }
    return {
      healthy: true, endpoint: endpoint,
      processIdentity: identity, endpointProcessIdentity: contextIdentity.endpointProcessIdentity,
      mediationChain: chain,
    };
  }

  const server = http.createServer(async (request, response) => {
    const match = /^\/provider\/([a-f0-9]{64})$/u.exec(request.url ?? '');
    if (!match || !timingSafeEqual(Buffer.from(match[1], 'hex'), capability)) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new BrokerError('NATIVE_REQUEST_TOO_LARGE', 'Native provider request exceeds its byte limit');
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new BrokerError('NATIVE_REQUEST_INVALID', 'Native provider request must be a JSON object');
      }
      const result = await invoke(input.operation, input.payload);
      if (input.operation === 'reloadExtension') {
        const commitToken = reloadPrepared;
        response.once('finish', () => {
          transport.request({
            leaseId: 'provider-update', method: 'extension.reload.commit',
            params: { profileToken: contextIdentity.profileToken, updateToken: commitToken },
          }).then(committed => {
            if (committed?.committing !== true) process.stderr.write('NATIVE_RELOAD_COMMIT_UNCONFIRMED\n');
          }, () => {
            process.stderr.write('NATIVE_RELOAD_COMMIT_UNCONFIRMED\n');
          });
        });
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: false, error: { code: error.code ?? 'NATIVE_PROVIDER_FAILED',
          message: redactNativeSurface(error.message, { secrets: [secret, contextIdentity.profileToken] }) },
      }));
    }
  });
  async function attestor(_operation, { observation }) {
    const result = await invoke('attest', { expectedProcessIdentity: observation.processIdentity });
    return { ...result, ...(result.healthy ? { endpoint: observation.endpoint } : {}) };
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  endpoint = `http://127.0.0.1:${server.address().port}/provider/${secret}`;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      disconnected = true;
      transport.off?.('close', lost);
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const proxy of proxies.values()) await proxy.close();
      proxies.clear();
      await adapter.close();
      if (reservation) {
        try {
          const current = await lstat(readyFile, { bigint: true });
          if (!current.isFile() || current.ino !== reservation.ino || current.dev !== reservation.dev) {
            throw new BrokerError('NATIVE_STATE_CHANGED', 'Native provider readiness was replaced; cleanup is not authorized');
          }
          await unlink(readyFile);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    })();
    return closing;
  }
  async function reconcileExistingReadiness() {
      let info;
      try {
        info = await lstat(readyFile, { bigint: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (!info.isFile() || info.size > 16384n) {
        throw new BrokerError('NATIVE_READINESS_INVALID', 'Existing native provider readiness is not a bounded regular file');
      }
      const recorded = JSON.parse(await readFile(readyFile, 'utf8'));
      const previousRuntime = recorded.endpointProcessIdentity;
      if (recorded.version !== 1 || recorded.processIdentity?.executable !== identity.executable ||
          recorded.processIdentity?.profileRoot !== identity.profileRoot ||
          !Number.isSafeInteger(previousRuntime?.pid) || previousRuntime.pid <= 0 ||
          IDENTITY_KEYS.slice(1).some(key => typeof previousRuntime[key] !== 'string' || !previousRuntime[key])) {
        throw new BrokerError('NATIVE_READINESS_INVALID', 'Existing native readiness does not identify an exact owned runtime and profile');
      }
      let observed;
      try {
        observed = await processReader(previousRuntime.pid);
      } catch (error) {
        let absent = false;
        try {
          process.kill(previousRuntime.pid, 0);
        } catch (probe) {
          absent = probe.code === 'ESRCH';
        }
        if (!absent) throw error;
        observed = undefined;
      }
      if (observed && sameIdentity(observed, previousRuntime)) {
        throw new BrokerError('NATIVE_PROVIDER_ALREADY_RUNNING', 'The recorded native runtime is still alive; its provider cannot be replaced');
      }
      const current = await lstat(readyFile, { bigint: true });
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) {
        throw new BrokerError('NATIVE_STATE_CHANGED', 'Native readiness changed while its original runtime was being reconciled');
      }
      await unlink(readyFile);
  }
  async function restoreLeases() {
    const registry = await readRegistry(stateDir);
    for (const lease of Object.values(registry.leases)) {
      if (lease.contextId !== context.id || !sameIdentity(lease.processIdentity, identity) ||
          !lease.nativeRouting || lease.releasing || lease.pendingTargetCreates?.length) continue;
      await withLeaseOperation(stateDir, lease.id, async () => {
        const binding = await adapter.bindLease({ leaseId: lease.id, owner: lease.owner, restore: true });
        await renewNativeLeaseBinding({
          stateDir, leaseId: lease.id, processIdentity: identity, mediationChain: chain,
          rawEndpoint: binding.rawEndpoint, transportGeneration: contextIdentity.transportGeneration,
        });
      });
      const proxy = await startLeaseProxy({ stateDir, leaseId: lease.id, declaration: context, providerInvoker: attestor });
      proxies.set(lease.id, proxy);
    }
  }
  try {
    await withBrokerLock(stateDir, async () => {
      await reconcileExistingReadiness();
      await restoreLeases();
      const file = await open(readyFile, 'wx', 0o600);
      try {
        const info = await file.stat({ bigint: true });
        reservation = { ino: info.ino, dev: info.dev };
        await file.writeFile(JSON.stringify({
          version: 1, endpoint, processIdentity: identity,
          mediationChain: chain, endpointProcessIdentity: contextIdentity.endpointProcessIdentity,
          browserVersion: contextIdentity.browserVersion, transportGeneration: contextIdentity.transportGeneration,
          extensionSourceDigest: contextIdentity.extensionSourceDigest,
        }));
        await file.sync();
      } finally {
        await file.close();
      }
    }, { name: 'native-readiness-' + context.id });
  } catch (error) {
    await close();
    throw error;
  }
  return Object.freeze({ readyFile, invoke, close });
}
