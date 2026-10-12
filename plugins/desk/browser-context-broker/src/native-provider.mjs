import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { open, lstat, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';

import { BrokerError } from './claims.mjs';
import { ensureStateDirectory, readRegistry, writeRegistry } from './registry.mjs';
import { createLease, createOwnedTarget, clearLeaseTargets, releaseLease, withLeaseOperation, recordLeasePurpose, renewNativeLeaseBinding, heartbeatLease } from './leases.mjs';
import { startLeaseProxy } from './cdp-proxy.mjs';
import { startNativeCdp } from './native-cdp.mjs';
import { readNativeProcess } from './native-host.mjs';
import { readProcessStart } from '../../mcp/src/readiness/process-start.js';
import { redactNativeSurface } from './secret-surfaces.mjs';
import { withBrokerLock } from './lock.mjs';

const MAX_BYTES = 1_048_576;
const IDENTITY_KEYS = ['pid', 'startIdentity', 'owner', 'executable'];

function sameIdentity(left, right) {
  return IDENTITY_KEYS.every(key => left?.[key] === right?.[key]);
}

export async function startNativeProvider({
  stateDir, transport, contextIdentity, processReader = readNativeProcess, processStartReader = readProcessStart,
  sweepIntervalMs = 60_000, ownerGraceMs = 300_000, orphanDropMs = 3_600_000,
}) {
  const startedAt = Date.now();
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
  // A lease with nothing recorded in the browser: no owner window, no task tab, no create or release under way.
  const recordsTabs = lease => lease.targetIds.length !== 0 || Boolean(lease.nativeRouting?.controlTabId) ||
    Object.keys(lease.nativeRouting?.targetTabs ?? {}).length !== 0 || Boolean(lease.pendingTargetCreates?.length);
  const holdsNothing = lease => !recordsTabs(lease) && !lease.releasing;
  const expired = lease => !(Date.parse(lease.expiresAt) > Date.now());
  const readStart = pid => Promise.resolve().then(() => processStartReader(pid)).catch(() => null);
  // A start that names one process: a Linux read whose boot id failed is not comparable with one whose read succeeded.
  const comparable = start => typeof start === 'string' && !start.includes(':unknown-boot:');
  // The session process that took the lease, as the session reported it. `confirmed` records whether this provider read the same
  // start; an unconfirmed claim may name a process in another namespace, so it can show the session alive but never gone.
  // 'gone': the confirmed process has exited, or its process id now names a process with another comparable start; 'alive': the
  // same start; 'unknown': nothing recorded, or nothing can be concluded now.
  async function ownerState(lease) {
    const recorded = lease.ownerProcess;
    if (!Number.isSafeInteger(recorded?.pid) || typeof recorded.startIdentity !== 'string') return 'unknown';
    let exited = false;
    try {
      process.kill(recorded.pid, 0);
    } catch (error) {
      exited = error.code === 'ESRCH';
    }
    if (recorded.confirmed === false) {
      return !exited && await readStart(recorded.pid) === recorded.startIdentity ? 'alive' : 'unknown';
    }
    if (exited) return 'gone';
    const current = await readStart(recorded.pid);
    if (!comparable(current) || !comparable(recorded.startIdentity)) return 'unknown';
    return current === recorded.startIdentity ? 'alive' : 'gone';
  }
  // A lease is abandoned when its session is gone. A session whose process cannot be judged is gone once its lease expires: the
  // proxy renews a lease only while the session's browser client is connected to it. One whose lease still records tabs is judged
  // only after this provider has run a full expiry period, so a live session whose provider was down for longer can reconnect.
  async function abandoned(lease) {
    const owner = await ownerState(lease);
    return owner === 'gone' || (owner === 'unknown' && expired(lease) &&
      (!recordsTabs(lease) || Date.now() - startedAt >= ownerGraceMs));
  }
  // Starts a lease's proxy. A proxy that closes itself, because its lease could not be renewed, is forgotten, so the session is
  // told its lease is no longer bound and takes a new one.
  async function startProxy(id) {
    let proxy;
    proxy = await startLeaseProxy({
      stateDir, leaseId: id, declaration: context, providerInvoker: attestor, renewOnlyWhileConnected: true,
      heartbeatLeaseFn: (dir, leaseId) => heartbeatLease(dir, leaseId, 300_000, { revive: true }),
      onClosed: () => { if (proxies.get(id) === proxy) proxies.delete(id); },
    });
    return proxy;
  }
  // Leases between createLease and their proxy: not yet in `proxies`, but bound, so the sweep must not restore them.
  const binding = new Set();
  // Binds a recorded lease of this browser to this provider and starts its proxy. A release that a previous provider left half done
  // (`releasing`, with no create in flight) is cleared first: no provider ran it, so nothing is in progress.
  async function restoreLease(id, { forRelease = false } = {}) {
    await withLeaseOperation(stateDir, id, async () => {
      await withBrokerLock(stateDir, async () => {
        const registry = await readRegistry(stateDir);
        const current = registry.leases[id];
        if (current?.releasing && !current.pendingTargetCreates?.length) {
          current.releasing = false;
          await writeRegistry(stateDir, registry);
        }
      });
      const lease = (await readRegistry(stateDir)).leases[id];
      if (!lease?.nativeRouting || lease.pendingTargetCreates?.length) {
        throw new BrokerError('NATIVE_EFFECT_PENDING', 'A recorded create must reconcile before its lease can be restored');
      }
      const bound = await adapter.bindLease({ leaseId: id, owner: lease.owner, restore: true });
      if (forRelease) boundForRelease.add(id);
      await renewNativeLeaseBinding({
        stateDir, leaseId: id, processIdentity: identity, mediationChain: chain,
        rawEndpoint: bound.rawEndpoint, transportGeneration: contextIdentity.transportGeneration, extend: !forRelease,
      });
    });
    if (!forRelease) proxies.set(id, await startProxy(id));
  }
  // Abandoned leases bound to this provider only so their recorded tabs can be closed; they get no proxy and are never renewed.
  const boundForRelease = new Set();
  // A session that is killed never releases its lease, so leases are swept after a start, every sweepIntervalMs and after every
  // acquire (which never waits for it). An abandoned lease is released the way its session releases it at exit, closing exactly the
  // owner window and task tabs recorded to it; the verdict is taken again under the lease's lock, so a session that is using its
  // lease is never released from under it. A release that fails stays recorded, `releasing` included, and is retried by the next
  // sweep. A lease of this browser that could not be restored is tried again, so a transient failure heals and its tabs can still
  // be closed. Records of another browser generation are removed once expired: that browser and its tabs are gone.
  let sweeping;
  function sweep() {
    sweeping ??= (async () => {
      try {
        const registry = await readRegistry(stateDir);
        for (const recorded of Object.values(registry.leases)) {
          if (closing || updateToken || disconnected) return;
          if (recorded.contextId !== context.id || !sameIdentity(recorded.processIdentity, identity) ||
              recorded.creating || binding.has(recorded.id)) continue;
          try {
            const gone = await abandoned(recorded);
            if (binding.has(recorded.id)) continue;
            if (!proxies.has(recorded.id) && !boundForRelease.has(recorded.id)) {
              if (gone && holdsNothing(recorded)) continue;
              try {
                await restoreLease(recorded.id, { forRelease: gone });
              } catch (error) {
                // An abandoned record whose tabs could not be reached for an hour past its expiry is dropped: whatever it recorded is
                // beyond this provider's reach, and keeping it would only retry forever.
                if (gone && Date.now() - Date.parse(recorded.expiresAt) > orphanDropMs) {
                  await dropRecord(recorded.id);
                  continue;
                }
                throw error;
              }
            }
            if (!gone) continue;
            const result = await releaseLease({ stateDir, leaseId: recorded.id, declaration: context, providerInvoker: attestor,
              onlyIf: abandoned, providerUnbind: ({ closedTargetIds }) => adapter.unbindLease(recorded.id, { closedTargetIds }) });
            if (result.released) {
              await proxies.get(recorded.id)?.close();
              proxies.delete(recorded.id);
              boundForRelease.delete(recorded.id);
            }
          } catch (error) {
            process.stderr.write(`NATIVE_LEASE_SWEEP_DEFERRED ${error.code ?? 'UNKNOWN'}\n`);
          }
        }
        if (!closing) await pruneRecords();
      } catch (error) {
        process.stderr.write(`NATIVE_LEASE_SWEEP_FAILED ${error.code ?? 'UNKNOWN'}\n`);
      }
    })().finally(() => { sweeping = undefined; });
    return sweeping;
  }
  async function dropRecord(id) {
    await withLeaseOperation(stateDir, id, () => withBrokerLock(stateDir, async () => {
      const registry = await readRegistry(stateDir);
      if (!registry.leases[id] || proxies.has(id) || binding.has(id)) return;
      delete registry.leases[id];
      await writeRegistry(stateDir, registry);
      process.stderr.write('NATIVE_LEASE_ORPHAN_DROPPED\n');
    }));
  }
  // Removes, under the broker lock, the records that cannot hold anything in this browser: an abandoned lease of this browser that
  // holds nothing and is not bound here, and an expired lease of another browser generation.
  async function pruneRecords() {
    const candidates = [];
    for (const lease of Object.values((await readRegistry(stateDir)).leases)) {
      if (lease.contextId !== context.id || proxies.has(lease.id) || binding.has(lease.id) || boundForRelease.has(lease.id) ||
          lease.creating) continue;
      if (!sameIdentity(lease.processIdentity, identity) ? expired(lease) : holdsNothing(lease) && await abandoned(lease)) {
        candidates.push(lease.id);
      }
    }
    if (!candidates.length) return;
    await withBrokerLock(stateDir, async () => {
      const registry = await readRegistry(stateDir);
      let removed = 0;
      for (const id of candidates) {
        const lease = registry.leases[id];
        if (!lease || proxies.has(id) || binding.has(id) || boundForRelease.has(id) || lease.creating) continue;
        const removable = sameIdentity(lease.processIdentity, identity)
          ? holdsNothing(lease) && await abandoned(lease) : expired(lease);
        if (!removable) continue;
        delete registry.leases[id];
        removed++;
      }
      if (removed) await writeRegistry(stateDir, registry);
    });
  }
  const sweeper = setInterval(() => { sweep(); }, sweepIntervalMs);
  sweeper.unref();
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
      // Release abandoned leases first, closing their recorded windows, so a session that is gone never holds an update back.
      await sweep();
      if (updateToken || activeOperations !== 0) {
        throw new BrokerError('NATIVE_UPDATE_EFFECTS_PENDING', 'Native operations must settle before source update');
      }
      updateToken = randomBytes(32).toString('hex');
      try {
        transport.pause();
        await withBrokerLock(stateDir, async () => {
          const registry = await readRegistry(stateDir);
          // An expired lease has no session renewing it through any provider: it is an orphan the sweep keeps retrying, not an
          // owner, and counting it once kept an update refused forever (2026-10-12, 20:30Z).
          const leases = Object.values(registry.leases).filter(lease => lease.contextId === context.id && !expired(lease));
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
      if (payload.ownerPid !== undefined && (!Number.isSafeInteger(payload.ownerPid) || payload.ownerPid <= 0 ||
          (payload.ownerStart !== undefined && (typeof payload.ownerStart !== 'string' || payload.ownerStart.length > 200)))) {
        throw new BrokerError('NATIVE_OWNER_INVALID', 'Native ownership requires a valid session process id and start when given');
      }
      // The session's own process, confirmed when its start as read here matches the start the session read for itself.
      const ownerProcess = typeof payload.ownerStart === 'string'
        ? { pid: payload.ownerPid, startIdentity: payload.ownerStart,
          confirmed: await readStart(payload.ownerPid) === payload.ownerStart } : undefined;
      let created;
      const lease = await createLease({
        stateDir, context, owner: payload.owner, ownerProcess, processIdentity: identity, mediationChain: chain,
        rawEndpoint: endpoint, deferInitialTarget: true,
        providerBind: ({ lease }) => {
          created = lease.id;
          binding.add(lease.id);
          return adapter.bindLease({ leaseId: lease.id, owner: lease.owner });
        },
      }).finally(() => { if (created) binding.delete(created); });
      binding.add(lease.id);
      let proxy;
      try {
        proxy = await startProxy(lease.id);
      } catch (error) {
        binding.delete(lease.id);
        await releaseLease({ stateDir, leaseId: lease.id, declaration: context, providerInvoker: attestor });
        throw error;
      }
      proxies.set(lease.id, proxy);
      binding.delete(lease.id);
      sweep();
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
          targetWindows: peer.targetIds.filter(id => id !== peer.nativeRouting?.controlTargetId &&
            peer.nativeRouting?.targetTabs?.[id]).map(targetId => ({
            targetId, windowId: peer.nativeRouting.targetTabs[targetId].windowId,
          })),
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
      const options = { stateDir, leaseId: lease.id, declaration: context, providerInvoker: attestor,
        providerUnbind: ({ closedTargetIds }) => adapter.unbindLease(lease.id, { closedTargetIds }) };
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
    // A session that names its lease learns whether this provider still holds it, so it can take a new one instead of failing.
    let leaseBound;
    if (typeof payload.leaseId === 'string') {
      const lease = (await readRegistry(stateDir)).leases[payload.leaseId];
      leaseBound = Boolean(lease && lease.owner === payload.owner && proxies.has(lease.id));
    }
    return {
      healthy: true, endpoint: endpoint,
      processIdentity: identity, endpointProcessIdentity: contextIdentity.endpointProcessIdentity,
      mediationChain: chain, ...(leaseBound === undefined ? {} : { leaseBound }),
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
      clearInterval(sweeper);
      await sweeping;
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
  // Restores this browser's leases after a provider restart. An abandoned lease that holds nothing is not restored: restoring
  // renews a lease, which kept every abandoned lease alive across restarts (82 of them on 2026-10-12); pruneRecords removes it. An
  // abandoned lease with a window is left to the sweep after the start, which binds it without renewing it and closes that window.
  // A lease that cannot be restored never stops the start: it stays recorded, unrenewed, and the sweep tries it again.
  async function restoreLeases() {
    const registry = await readRegistry(stateDir);
    for (const lease of Object.values(registry.leases)) {
      if (lease.contextId !== context.id || !sameIdentity(lease.processIdentity, identity)) continue;
      if (await abandoned(lease)) continue;
      try {
        await restoreLease(lease.id);
      } catch (error) {
        process.stderr.write(`NATIVE_LEASE_NOT_RESTORED ${error.code ?? 'UNKNOWN'}\n`);
      }
    }
    await pruneRecords();
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
  sweep();
  return Object.freeze({ readyFile, invoke, close, sweep });
}
