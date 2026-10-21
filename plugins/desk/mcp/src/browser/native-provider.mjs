// Native control plane only. Maintained CLI owns sessions; the extension owns
// effects. No browser/lease/CDP server or persistent custody database lives here.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { TextDecoder } from 'node:util';
import client from '../../web-native-messaging.cjs';
import profile from '../../web-real-profile.cjs';
import credential from '../../web-extension-credential.cjs';
import { BrokerError } from '../util/broker-error.mjs';
import { assertNativeReady, readNativeAncestry, readNativeProcess, reserveNativeReadyFile } from './native-host.mjs';
import { createNativeOwnerInventory } from './native-owner-inventory.mjs';

const require = createRequire(import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const MAX = 1_048_576;
const CONTEXT = new Set(['context.create', 'context.resume', 'context.status', 'context.label', 'context.discard']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sameProcess = (a, b) => ['pid', 'parentPid', 'startIdentity', 'owner', 'executable'].every(k => a?.[k] === b?.[k]);
function fail(code, resources) {
  const e = new BrokerError(code, code, resources === undefined ? {} : { resources });
  if (resources !== undefined) e.resources = resources;
  return e;
}
function keys(value, names) { return object(value) && Object.keys(value).every(k => names.includes(k)); }
function validReceipt(receipt, contextId) {
  return receipt?.contextId === contextId && receipt.discarded === true &&
    ['closedTabIds', 'absentTabIds'].every(k => Array.isArray(receipt[k]) &&
      receipt[k].every(id => Number.isSafeInteger(id) && id >= 0) && new Set(receipt[k]).size === receipt[k].length) &&
    receipt.closedTabIds.every(id => receipt.absentTabIds.includes(id)) &&
    Array.isArray(receipt.releasedRevokedTabs) && receipt.releasedRevokedTabs.every(r =>
      Number.isSafeInteger(r.tabId) && r.tabId >= 0 && Number.isSafeInteger(r.windowId) && r.windowId >= 0 &&
      !receipt.absentTabIds.includes(r.tabId));
}

export function validateNativeHostConfig(config) {
  const fields = ['version', 'extensionId', 'extensionOrigin', 'extensionSourceDigest', 'runtimeExecutable',
    'entryExecutable', 'browserExecutable', 'expectedBrowser', 'channel', 'userDataDir', 'profileDirName',
    'profileRoot', 'pluginDirs', 'nativeReadyFile', 'browserStateRoot', 'cliDir'];
  if (!keys(config, fields) || fields.some(k => !Object.hasOwn(config, k)) || config.version !== 1 ||
      typeof config.extensionId !== 'string' || !/^[a-p]{32}$/u.test(config.extensionId) ||
      config.extensionOrigin !== `chrome-extension://${config.extensionId}/` ||
      typeof config.extensionSourceDigest !== 'string' || !HEX.test(config.extensionSourceDigest) || !['msedge', 'chrome'].includes(config.channel) ||
      !['runtimeExecutable', 'entryExecutable', 'browserExecutable', 'userDataDir', 'profileRoot',
        'nativeReadyFile', 'browserStateRoot', 'cliDir'].every(k =>
        typeof config[k] === 'string' && path.isAbsolute(config[k]) && !/[\u0000-\u001f\u007f]/u.test(config[k])) ||
      typeof config.profileDirName !== 'string' || !config.profileDirName || /^[.]{1,2}$/u.test(config.profileDirName) ||
      /[\\/\u0000-\u001f\u007f]/u.test(config.profileDirName) ||
      config.profileRoot !== path.join(config.userDataDir, config.profileDirName) ||
      !Array.isArray(config.pluginDirs) || !config.pluginDirs.length || config.pluginDirs.length > 32 ||
      !config.pluginDirs.every(p => typeof p === 'string' && path.isAbsolute(p)) ||
      !Number.isSafeInteger(config.expectedBrowser?.pid) || typeof config.expectedBrowser?.startIdentity !== 'string')
    throw fail('NATIVE_CONFIG_INVALID');
  return config;
}

// Uses only the ordinary declared selector and its selected partition, never a
// browser/extension/account scan. D pins the normal installed declaration roots.
async function resolveSelectedNativeProfile(config, { env = process.env, homeDir = os.homedir() } = {}) {
  const declaration = profile.readDeclaration({ env, homeDir, pluginDirs: () => config.pluginDirs });
  if (declaration.state !== 'declared' || declaration.channel !== config.channel) throw fail('NATIVE_SELECTION_MISMATCH');
  const userDataDir = profile.userDataDir(declaration.channel, process.platform, env, homeDir);
  const profileDirName = profile.findProfileDir(path.join(userDataDir, 'Local State'), declaration.domain);
  if (userDataDir !== config.userDataDir || profileDirName !== config.profileDirName) throw fail('NATIVE_SELECTION_MISMATCH');
  return { channel: declaration.channel, userDataDir, profileDirName, profileRoot: path.join(userDataDir, profileDirName),
    nativeReadyFile: config.nativeReadyFile, extensionId: config.extensionId, sourceDigest: config.extensionSourceDigest };
}

export async function startNativeProvider({ config: supplied, ready, chain: suppliedChain, transport,
  processReader = readNativeProcess, resolveSelection = resolveSelectedNativeProfile,
  readProfileToken, inventory: suppliedInventory, verifyContinuity, onAdmitted,
  updateTtlMs = 30_000, protectSecret }) {
  const config = structuredClone(validateNativeHostConfig(supplied));
  readProfileToken ||= profileRoot => credential.readExtensionToken(profileRoot, {
    extensionId: config.extensionId, tokenKey: 'deskBrowserProfileToken',
    // The normal browser install already owns this reader dependency. Do not
    // add it to MCP or select a module path from a browser caller's record.
    level: require(path.resolve(config.cliDir, '../../../../classic-level')), tmpdir: os.tmpdir(),
  });
  const chain = structuredClone(suppliedChain);
  if (!Array.isArray(chain) || chain.length !== 3 || chain[0].executable !== config.runtimeExecutable ||
      chain[1].executable !== config.entryExecutable || chain[2].executable !== config.browserExecutable ||
      !sameProcess(chain[2], config.expectedBrowser) || chain.some(p => p.owner !== chain[2].owner) ||
      !Number.isSafeInteger(updateTtlMs) || updateTtlMs <= 0 || updateTtlMs > 60_000)
    throw fail('NATIVE_ANCESTRY_MISMATCH');
  if (!transport || typeof transport.request !== 'function' || typeof transport.close !== 'function') throw fail('NATIVE_CONFIG_INVALID');
  const generation = randomUUID();
  const inventory = suppliedInventory || createNativeOwnerInventory({
    browserStateRoot: config.browserStateRoot, cliDir: config.cliDir,
    binding: { channel: config.channel, userDataDir: config.userDataDir, profileDirName: config.profileDirName,
      nativeReadyFile: config.nativeReadyFile, extensionId: config.extensionId, sourceDigest: config.extensionSourceDigest },
  });
  const contexts = new Map(), contextEpochs = new Map(), active = new Set();
  function advanceContext(contextId) {
    const epoch = Symbol();
    contextEpochs.set(contextId, epoch);
    return epoch;
  }
  function assertContextEpochs(expected) {
    const changed = [...contextEpochs].filter(([contextId, epoch]) => expected.get(contextId) !== epoch);
    if (changed.length) throw fail('NATIVE_UPDATE_OWNERS_UNSETTLED', {
      owners: changed.map(([contextId]) => ({ contextId, disposition: 'unknown', reason: 'NATIVE_EFFECT_UNSETTLED' })),
    });
  }
  // The existing hook protects diagnostics, NEVER native-framed stdout. Replacing
  // a legitimate token inside a frame would corrupt its length and protocol.
  const diagnostics = { stdout: { write: (...args) => process.stderr.write(...args) }, stderr: process.stderr };
  protectSecret ||= secret => credential.protect(diagnostics, secret);
  let connected = true, phase = 'admitting', ticket, reservation, readyIdentity, readyFingerprint, closing, close;
  const obligation = () => ticket?.prepared
    ? { update: 'prepared', disposition: 'unknown' } : { disposition: 'unknown' };
  const lost = () => {
    connected = false; if (ticket?.prepared) phase = 'obligation';
    if (close) close().catch(() => {}); // close retains its rejected promise for the owner.
  };
  const event = message => {
    if (message?.event === 'context.unavailable' && UUID.test(message.contextId || '')) {
      advanceContext(message.contextId);
      contexts.set(message.contextId, { disposition: 'unknown', generation });
      if (ticket?.prepared) phase = 'obligation';
    }
  };
  transport.on?.('close', lost);
  transport.on?.('event', event);

  function assertReservation() {
    if (!connected || phase === 'closed') throw fail('NATIVE_TRANSPORT_DISCONNECTED', obligation());
    if (reservation) {
      try {
        if (client.fileIdentity(config.nativeReadyFile) !== readyIdentity ||
            hash(client.readPrivateJson(config.nativeReadyFile)) !== readyFingerprint) throw Error();
      } catch {
        connected = false;
        close?.().catch(() => {});
        throw fail('NATIVE_READY_CHANGED', obligation());
      }
    }
  }
  // Synchronous final fence: no awaited corroboration may separate the exact
  // protected reservation check from an authority-bearing native dispatch.
  function requestNative(request) {
    assertReservation();
    return transport.request(request);
  }
  async function attest({ helloOnly = false } = {}) {
    assertReservation();
    let current, selected, pin;
    try { current = await readNativeAncestry(chain[0].pid, { processReader }); }
    catch { throw fail('NATIVE_ANCESTRY_MISMATCH', obligation()); }
    if (!connected) throw fail('NATIVE_TRANSPORT_DISCONNECTED', obligation());
    if (current.some((p, i) => !sameProcess(p, chain[i]))) throw fail('NATIVE_ANCESTRY_MISMATCH', obligation());
    try { selected = await resolveSelection(config); }
    catch { throw fail('NATIVE_SELECTION_MISMATCH'); }
    if (!connected) throw fail('NATIVE_TRANSPORT_DISCONNECTED', obligation());
    if (['channel', 'userDataDir', 'profileDirName', 'profileRoot', 'nativeReadyFile', 'extensionId'].some(k => selected?.[k] !== config[k]) ||
        selected.sourceDigest !== config.extensionSourceDigest) throw fail('NATIVE_SELECTION_MISMATCH');
    try { pin = await readProfileToken(selected.profileRoot); }
    catch { throw fail('NATIVE_PROFILE_TOKEN_UNAVAILABLE'); }
    if (!connected) throw fail('NATIVE_TRANSPORT_DISCONNECTED', obligation());
    if (typeof pin !== 'string' || !HEX.test(pin)) throw fail('NATIVE_PROFILE_TOKEN_UNAVAILABLE');
    protectSecret(pin);
    assertNativeReady(ready, { ...config, expectedProfileToken: pin });
    const bindingDigest = hash({ chain, profileRoot: config.profileRoot, source: config.extensionSourceDigest, pin, generation });
    assertReservation();
    if (helloOnly) return { pin, bindingDigest };
    let live;
    try { live = await requestNative({ method: 'profile.read', params: { profileToken: pin, sourceDigest: config.extensionSourceDigest } }); }
    catch (error) {
      if (error.code === 'NATIVE_READY_CHANGED') throw error;
      throw fail(error.code === 'native_profile_mismatch' ? 'NATIVE_PROFILE_MISMATCH' : 'NATIVE_TRANSPORT_DISCONNECTED', error.resources || obligation());
    }
    assertReservation();
    if (live?.sourceDigest !== config.extensionSourceDigest) throw fail('NATIVE_EXTENSION_SOURCE_MISMATCH', obligation());
    if (!connected || live?.profileToken !== pin || live.extensionId !== config.extensionId)
      throw fail('NATIVE_PROFILE_MISMATCH', obligation());
    return { pin, bindingDigest };
  }
  function publicAttestation() {
    assertReservation();
    // Private HTTP corroboration result, not a browser command/public report.
    return { healthy: true, generation, profileRoot: config.profileRoot,
      extensionId: config.extensionId, sourceDigest: config.extensionSourceDigest, chain: structuredClone(chain) };
  }
  async function dispatch(payload) {
    if (!keys(payload, ['contextId', 'method', 'params']) || typeof payload.contextId !== 'string' ||
        !UUID.test(payload.contextId) || !CONTEXT.has(payload.method) || !object(payload.params))
      throw fail('NATIVE_REQUEST_INVALID');
    if (phase !== 'open') throw fail('NATIVE_UPDATE_IN_PROGRESS', obligation());
    let owner;
    try { owner = inventory.descriptor(payload.contextId); } catch { throw fail('NATIVE_OWNER_INVALID'); }
    if (!owner) throw fail('NATIVE_OWNER_INVALID');
    // Context ID/label/configuration is not a principal. The selected native
    // capability, live pins and extension's current binding remain authority.
    const { pin } = await attest();
    if (phase !== 'open') throw fail('NATIVE_UPDATE_IN_PROGRESS');
    if (Object.hasOwn(payload.params, 'profileToken') || Object.hasOwn(payload.params, 'sourceDigest'))
      throw fail('NATIVE_REQUEST_INVALID');
    const mutating = ['context.create', 'context.label', 'context.discard'].includes(payload.method) ||
      (payload.method === 'context.resume' && Object.hasOwn(payload.params, 'relayUrl'));
    const epoch = mutating ? advanceContext(payload.contextId) : undefined;
    if (mutating) contexts.set(payload.contextId, { disposition: 'unknown', generation });
    try {
      const result = await requestNative({ method: payload.method, contextId: payload.contextId,
        params: { ...payload.params, profileToken: pin, sourceDigest: config.extensionSourceDigest } });
      if (!connected) throw fail('NATIVE_TRANSPORT_DISCONNECTED', { contextId: payload.contextId, disposition: 'unknown' });
      assertReservation();
      if (result?.contextId !== payload.contextId ||
          (['context.create', 'context.resume', 'context.label'].includes(payload.method) && result.state !== 'ready') ||
          (payload.method === 'context.create' && (!Number.isSafeInteger(result.groupId) || result.groupId < 0 ||
            !Array.isArray(result.tabs) || !result.tabs.length)) ||
          (payload.method === 'context.discard' && !validReceipt(result, payload.contextId))) {
        advanceContext(payload.contextId);
        contexts.set(payload.contextId, { disposition: 'unknown', generation });
        throw fail('NATIVE_CONTEXT_UNCONFIRMED', { contextId: payload.contextId, disposition: 'unknown',
          native: client.safeResources(result) });
      }
      if (payload.method === 'context.discard' && validReceipt(result, payload.contextId)) {
        // Receipt publication is fenced against later mutations/unavailable
        // events, including ones admitted during this final attestation.
        await attest();
        assertReservation();
        if (contextEpochs.get(payload.contextId) !== epoch)
          throw fail('NATIVE_CONTEXT_UNCONFIRMED', { contextId: payload.contextId, disposition: 'unknown' });
        contexts.set(payload.contextId, { disposition: 'discarded', generation, receipt: structuredClone(result) });
      } else if (mutating) {
        if (contextEpochs.get(payload.contextId) !== epoch)
          throw fail('NATIVE_CONTEXT_UNCONFIRMED', { contextId: payload.contextId, disposition: 'unknown' });
        contexts.set(payload.contextId, { disposition: 'unsettled', generation, resources: structuredClone(result) });
      }
      return result;
    } catch (error) {
      throw fail(client.safeCode(error.code, 'NATIVE_REQUEST_FAILED'),
        client.safeResources(error.resources) || { contextId: payload.contextId, disposition: 'unknown' });
    }
  }
  async function quiescence() {
    const attested = await attest();
    const snapshot = await inventory.snapshot();
    const unsettled = [];
    for (const owner of snapshot.owners) {
      const state = contexts.get(owner.contextId);
      if (owner.cli === 'absent' && state?.generation === generation && state.disposition === 'discarded') continue;
      let native;
      if (owner.contextId && owner.configured && state?.disposition !== 'discarded') {
        try {
          native = await requestNative({ method: 'context.status', contextId: owner.contextId,
            params: { profileToken: ready.profileToken, sourceDigest: config.extensionSourceDigest } });
        } catch (error) { native = error.resources || { disposition: 'unknown' }; }
      }
      unsettled.push({ ...owner, ...(native ? { native: client.safeResources(native) } : {}) });
    }
    for (const [contextId, state] of contexts) {
      if (!snapshot.owners.some(o => o.contextId === contextId) || state.disposition !== 'discarded')
        unsettled.push({ contextId, reason: 'NATIVE_EFFECT_UNSETTLED' });
    }
    if (unsettled.length) throw fail('NATIVE_UPDATE_OWNERS_UNSETTLED', {
      owners: unsettled.map(o => ({ ...(o.contextId ? { contextId: o.contextId } : {}),
        disposition: 'unknown', reason: o.reason || 'NATIVE_OWNER_UNSETTLED', ...(o.native ? { native: o.native } : {}) })),
    });
    if (typeof verifyContinuity !== 'function') throw fail('NATIVE_CONTINUITY_UNKNOWN');
    const epochs = new Map(contextEpochs);
    // Trusted source-only seam for D's existing journal/baseline verifier.
    // Not configuration, an RPC option, a browser receipt, or fresh emptiness.
    const proof = await verifyContinuity({ generation, bindingDigest: attested.bindingDigest,
      snapshot: structuredClone(snapshot), nativeReceipts: structuredClone([...contexts]) });
    assertReservation();
    if (!proof || proof.generation !== generation || proof.bindingDigest !== attested.bindingDigest ||
        proof.snapshotDigest !== snapshot.digest || typeof proof.baselineId !== 'string' || !UUID.test(proof.baselineId)) throw fail('NATIVE_CONTINUITY_UNKNOWN');
    assertContextEpochs(epochs);
    return { bindingDigest: attested.bindingDigest, snapshotDigest: snapshot.digest, baselineId: proof.baselineId, epochs };
  }
  function checkTicket(payload) {
    if (!keys(payload, ['ticket']) || !ticket || typeof payload.ticket !== 'string' || !HEX.test(payload.ticket) ||
        !timingSafeEqual(Buffer.from(payload.ticket), Buffer.from(ticket.token)))
      throw fail('NATIVE_UPDATE_TICKET_INVALID', obligation());
    if (Date.now() >= ticket.expiresAt) throw fail('NATIVE_UPDATE_TICKET_EXPIRED', obligation());
    return ticket;
  }
  async function update(operation, payload) {
    const current = checkTicket(payload);
    if (operation === 'cancelUpdate' && phase !== 'ticket') throw fail('NATIVE_UPDATE_PREPARED_OBLIGATION', obligation());
    if ((operation === 'reload' && phase !== 'ticket') || (operation === 'commit' && phase !== 'prepared'))
      throw fail('NATIVE_UPDATE_TICKET_INVALID', obligation());
    const previous = phase;
    phase = 'validating'; // Same synchronous fence for reload/commit/cancel races.
    try {
      const evidence = operation === 'cancelUpdate' ? await attest() : await quiescence();
      checkTicket(payload); // The snapshot itself may have outlasted the ticket.
      if ((operation === 'cancelUpdate' ? ['bindingDigest'] : ['bindingDigest', 'snapshotDigest', 'baselineId']).some(k => evidence[k] !== current[k]))
        throw fail('NATIVE_UPDATE_EVIDENCE_CHANGED', obligation());
      assertReservation();
      if (operation !== 'cancelUpdate') assertContextEpochs(evidence.epochs);
      if (operation === 'cancelUpdate') { ticket = undefined; phase = 'open'; return { cancelled: true }; }
    } catch (error) { if (phase === 'validating') phase = previous; throw error; }
    // Mark before native dispatch: a failed write/ack cannot cancel preparation.
    current.prepared = true;
    phase = operation === 'reload' ? 'prepared' : 'committing';
    try {
      const result = await requestNative({ method: operation === 'reload' ? 'extension.reload' : 'extension.reload.commit',
        params: { profileToken: ready.profileToken, sourceDigest: config.extensionSourceDigest, updateToken: current.token } });
      if ((operation === 'reload' ? result?.reload : result?.committing) !== true) throw Error();
      if (operation === 'commit') phase = 'obligation';
      return { ...(operation === 'reload' ? { prepared: true } : { committing: true }), reconciliationRequired: true };
    } catch (error) { phase = 'obligation'; throw fail('NATIVE_UPDATE_PREPARED_OBLIGATION', error.resources || obligation()); }
  }
  function invoke(operation, payload = {}) {
    if (!object(payload)) return Promise.reject(fail('NATIVE_REQUEST_INVALID'));
    try { payload = structuredClone(payload); } catch { return Promise.reject(fail('NATIVE_REQUEST_INVALID')); }
    if (!connected || phase === 'closed') return Promise.reject(fail('NATIVE_TRANSPORT_DISCONNECTED', obligation()));
    if (operation === 'prepareUpdate') {
      if (!keys(payload, []) || phase !== 'open') return Promise.reject(fail(phase !== 'open' ? 'NATIVE_UPDATE_IN_PROGRESS' : 'NATIVE_REQUEST_INVALID'));
      // Synchronous fence before draining any request, reading any owner, or
      // awaiting native attestation. New external dispatch cannot slip through.
      phase = 'checking';
      return (async () => {
        try {
          await Promise.allSettled([...active]);
          const evidence = await quiescence();
          assertReservation();
          assertContextEpochs(evidence.epochs);
          const token = randomBytes(32).toString('hex'); protectSecret(token);
          ticket = { token, expiresAt: Date.now() + updateTtlMs, ...evidence };
          phase = 'ticket';
          return { ticket: token, expiresAt: ticket.expiresAt };
        } catch (error) { if (phase === 'checking') phase = 'open'; throw error; }
      })();
    }
    if (['cancelUpdate', 'reload', 'commit'].includes(operation)) return update(operation, payload);
    if (phase !== 'open') return Promise.reject(fail('NATIVE_UPDATE_IN_PROGRESS', obligation()));
    let task;
    if (operation === 'dispatch') task = dispatch(payload);
    else if (operation === 'attest' && keys(payload, [])) task = attest().then(publicAttestation);
    else return Promise.reject(fail('NATIVE_REQUEST_INVALID'));
    active.add(task);
    task.then(() => active.delete(task), () => active.delete(task));
    return task;
  }

  // Hello is the startup oracle. A successful bootstrap profile.read would
  // confirm A's retry budget even when later private admission fails forever.
  // No native request before a healthy private binding/reservation. The finite
  // source-only handoff below runs while public effect dispatch is still fenced.
  let initialAttestation;
  try { initialAttestation = await attest({ helloOnly: true }); }
  catch (error) {
    transport.off?.('close', lost); transport.off?.('event', event); transport.close(); throw error;
  }
  const capability = randomBytes(32).toString('hex');
  const route = `/provider/${capability}`;
  protectSecret(capability);
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    function reply(status, body) {
      if (response.destroyed || response.writableEnded) return;
      const bytes = JSON.stringify(body);
      if (Buffer.byteLength(bytes) > MAX) { response.writeHead(500); response.end('{"ok":false,"error":{"code":"NATIVE_RESPONSE_TOO_LARGE"}}'); return; }
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(bytes);
    }
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    const candidate = Buffer.from(request.url || '');
    const expected = Buffer.from(route);
    if (request.method !== 'POST' || request.headers.host !== expectedHost || request.headers.origin !== undefined ||
        request.headers['content-type'] !== 'application/json' || candidate.length !== expected.length ||
        !timingSafeEqual(candidate, expected)) {
      reply(403, { ok: false, error: { code: 'NATIVE_PROVIDER_REQUEST_REFUSED' } }); request.resume(); return;
    }
    const chunks = []; let size = 0;
    try {
      for await (const bytes of request) {
        size += bytes.length;
        if (size > MAX) { reply(413, { ok: false, error: { code: 'NATIVE_REQUEST_TOO_LARGE' } }); return; }
        chunks.push(bytes);
      }
      const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!keys(message, ['operation', 'payload']) || typeof message.operation !== 'string' || !object(message.payload))
        throw fail('NATIVE_REQUEST_INVALID');
      reply(200, { ok: true, result: await invoke(message.operation, message.payload) });
    } catch (error) {
      const code = client.safeCode(error.code, 'NATIVE_REQUEST_INVALID');
      reply(409, { ok: false, error: { code, ...(error.resources === undefined ? {} : { resources: client.safeResources(error.resources) }) } });
    }
  });
  server.maxConnections = 32; server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  close = () => {
    if (closing) return closing;
    connected = false; phase = 'closed'; transport.off?.('close', lost); transport.off?.('event', event); transport.close();
    closing = (async () => {
      const stopped = new Promise(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await stopped;
      if (reservation) await reservation.close();
    })();
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', () => reject(fail('NATIVE_PROVIDER_LISTEN_FAILED')));
      server.listen(0, '127.0.0.1', resolve);
    });
    const endpoint = `http://127.0.0.1:${server.address().port}${route}`;
    protectSecret(endpoint);
    const record = {
      version: 1, generation, endpoint, profileRoot: config.profileRoot,
      extensionId: config.extensionId, sourceDigest: config.extensionSourceDigest, browser: chain[2], chain,
    };
    reservation = await reserveNativeReadyFile({ readyFile: config.nativeReadyFile, record });
    readyIdentity = client.fileIdentity(config.nativeReadyFile);
    readyFingerprint = hash(record);
    if (hash(client.readPrivateJson(config.nativeReadyFile)) !== readyFingerprint) throw fail('NATIVE_READY_CHANGED');
    if (!connected) throw fail('NATIVE_TRANSPORT_DISCONNECTED');
    if (onAdmitted !== undefined) {
      if (typeof onAdmitted !== 'function') throw fail('NATIVE_CONFIG_INVALID');
      const recheck = async () => {
        const fresh = await attest({ helloOnly: true });
        if (fresh.bindingDigest !== initialAttestation.bindingDigest) throw fail('NATIVE_READY_CHANGED');
        return fresh;
      };
      const control = async (method, params) => {
        await recheck();
        const result = await requestNative({ method, params: { ...params,
          profileToken: initialAttestation.pin, sourceDigest: config.extensionSourceDigest } });
        await recheck();
        return result;
      };
      // Source-only finite handoff after healthy private reservation. HTTP
      // remains fenced until it completes; no control operation is exposed.
      await onAdmitted(Object.freeze({
        generation, bindingDigest: initialAttestation.bindingDigest,
        readyFile: config.nativeReadyFile, activation: structuredClone(ready.activation),
        capture: params => control('transition.capture', params),
        release: params => control('transition.release', params),
        recheck,
      }));
      await recheck();
    }
    phase = 'open';
  } catch (error) { await close(); throw fail(error.code === 'NATIVE_STATE_CHANGED' ? error.code : 'NATIVE_PROVIDER_START_FAILED'); }
  return Object.freeze({ invoke, close, readyFile: config.nativeReadyFile });
}
