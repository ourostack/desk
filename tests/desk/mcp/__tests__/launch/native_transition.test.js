import '../_isolated_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserExtension } from '../../../../../plugins/desk/browser-extension/context-engine.mjs';
import { createBackground } from '../../../../../plugins/desk/browser-extension/background.mjs';
import { NativeCommandTransport } from '../../../../../plugins/desk/mcp/src/browser/native-transport.mjs';
import * as inventory from '../../../../../plugins/desk/mcp/src/browser/native-owner-inventory.mjs';
import { assertNativeReady } from '../../../../../plugins/desk/mcp/src/browser/native-host.mjs';

const TOKEN = 'a'.repeat(64), SOURCE = 'b'.repeat(64);
const ID = '11111111-1111-4111-8111-111111111111', CHALLENGE = 'c'.repeat(64);
const event = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f),
    emit: (...args) => [...listeners].forEach(f => f(...args)) };
};
function fixture() {
  const messages = [], ports = [];
  const api = {
    tabs: { onCreated: event(), onUpdated: event(), onRemoved: event() },
    debugger: { onEvent: event(), onDetach: event() },
    runtime: {
      id: 'd'.repeat(32), onInstalled: event(), onStartup: event(),
      getURL: x => `chrome-extension://${'d'.repeat(32)}/${x}`,
      getContexts: async () => [{ documentUrl: `chrome-extension://${'d'.repeat(32)}/token.html` }],
      sendMessage: async () => ({ token: TOKEN }),
      connectNative() {
        const p = { onMessage: event(), onDisconnect: event(), postMessage: m => messages.push(m), disconnect() {} };
        ports.push(p); return p;
      },
    },
  };
  return { api, messages, ports };
}
let requestNumber = 0;
const request = (method, params = {}, contextId) => ({
  id: `test-${++requestNumber}`, method, ...(contextId ? { contextId } : {}),
  params: { profileToken: TOKEN, sourceDigest: SOURCE, ...params },
});
const capture = engine => engine.dispatch(request('transition.capture', { transactionId: ID, challenge: CHALLENGE }));
const release = (engine, witness, extra = {}) => engine.dispatch(request('transition.release',
  { transactionId: ID, challenge: CHALLENGE, workerEpoch: witness.workerEpoch, witnessDigest: witness.witnessDigest, mode: 'ordinary', ...extra }));

test('activation admission denies context effects before any normal-window selection', async () => {
  const f = fixture(), engine = createBrowserExtension(f.api, { sourceDigest: SOURCE });
  const denied = await engine.dispatch(request('context.create', { label: 'not admitted',
    relayUrl: `ws://127.0.0.1:1234/extension/${ID}` }, ID));
  assert.equal(denied.error?.code, 'native_transition_pending');
  engine.stop();
});

test('capture binds same-factory event, exact challenge and one-way release', async () => {
  const f = fixture(), engine = createBrowserExtension(f.api, { sourceDigest: SOURCE });
  engine.observeActivation('installed', { reason: 'install' });
  const observed = await capture(engine);
  assert.equal(observed.result?.admission, 'held');
  assert.equal(observed.result.activation.trigger, 'browser-install-event');
  assert.equal(observed.result.activation.reason, 'install');
  assert.match(observed.result.workerEpoch, /^[0-9a-f-]{36}$/u);
  assert.match(observed.result.witnessDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual((await capture(engine)).result, observed.result);
  assert.equal((await release(engine, observed.result, { challenge: 'e'.repeat(64) })).error?.code, 'native_transition_changed');
  assert.equal((await release(engine, observed.result)).result?.released, true);
  assert.equal((await capture(engine)).error?.code, 'native_transition_unavailable');
  engine.stop();
});

test('normal native transport admits only provider-scoped transition controls', async () => {
  const f = fixture(), engine = createBrowserExtension(f.api, { sourceDigest: SOURCE });
  const transport = new NativeCommandTransport({ send: async m => transport.receive(await engine.dispatch(m)) });
  try {
    const witness = await transport.request({ method: 'transition.capture',
      params: { profileToken: TOKEN, sourceDigest: SOURCE, transactionId: ID, challenge: CHALLENGE } });
    assert.equal(witness.admission, 'held');
    await assert.rejects(transport.request({ method: 'transition.capture', contextId: ID, params: {} }),
      { code: 'NATIVE_REQUEST_INVALID' });
  } finally { transport.close(); engine.stop(); }
});

test('shared snapshot digest preserves the existing exact array encoding and order', () => {
  assert.equal(typeof inventory.nativeOwnerSnapshotDigest, 'function');
  // sha256 of literal [] from the existing C algorithm, not a second encoder.
  assert.equal(inventory.nativeOwnerSnapshotDigest([]), '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  assert.notEqual(inventory.nativeOwnerSnapshotDigest([{ contextId: ID }, { contextId: 'other' }]),
    inventory.nativeOwnerSnapshotDigest([{ contextId: 'other' }, { contextId: ID }]));
});

test('evaluation is not an install witness and a late event cannot rewrite a captured witness', async () => {
  const f = fixture(), engine = createBrowserExtension(f.api, { sourceDigest: SOURCE });
  const observed = await capture(engine);
  assert.equal(observed.result?.activation.trigger, 'evaluation');
  engine.observeActivation('installed', { reason: 'install' });
  assert.equal((await release(engine, observed.result)).error?.code, 'native_transition_changed');
  engine.stop();
});

test('native controls reject context scope and stale-port release', async () => {
  const f = fixture(), engine = createBrowserExtension(f.api, { sourceDigest: SOURCE });
  assert.equal((await engine.dispatch(request('transition.capture', { transactionId: ID, challenge: CHALLENGE }, ID))).error?.code,
    'native_request_invalid');
  await engine.start();
  const observed = await capture(engine);
  f.ports[0].onDisconnect.emit();
  assert.equal((await release(engine, observed.result)).error?.code, 'native_transition_changed');
  engine.stop();
});

test('ordinary same-factory port reconnect does not reset custody or masquerade as a zero-effect activation', async () => {
  const f = fixture(), engine = createBrowserExtension(f.api, { sourceDigest: SOURCE });
  await engine.start();
  const observed = await capture(engine);
  await release(engine, observed.result);
  f.ports[0].onDisconnect.emit();
  await engine.start();
  assert.equal(f.messages.at(-1).activation.admission, 'ordinary');
  assert.equal((await capture(engine)).error?.code, 'native_transition_unavailable');
  engine.stop();
});

test('background uses actual same-factory browser event rather than synthesizing install at evaluation', async () => {
  const f = fixture(), timers = { setTimeout: () => 1, clearTimeout() {} };
  const engine = createBackground(f.api, { timers, sourceDigest: SOURCE, onStatus() {} });
  f.api.runtime.onInstalled.emit({ reason: 'update' });
  assert.equal((await capture(engine)).result?.activation.trigger, 'browser-update-event');
  engine.stop();
});

test('protected hello rejects malformed activation claims instead of treating them as ordinary release', async () => {
  const f = fixture(), engine = createBrowserExtension(f.api, { sourceDigest: SOURCE });
  await engine.start();
  const ready = f.messages[0], config = { extensionId: f.api.runtime.id, extensionSourceDigest: SOURCE, expectedProfileToken: TOKEN };
  assert.doesNotThrow(() => assertNativeReady(ready, config));
  for (const activation of [null, { ...ready.activation, protocol: 2 }, { ...ready.activation, workerEpoch: 'not-uuid' },
    { ...ready.activation, contextEffectSequence: -1 }, { ...ready.activation, admission: 'released-by-caller' },
    { ...ready.activation, trigger: 'browser-install-event', reason: 'not-a-browser-reason' }]) {
    assert.throws(() => assertNativeReady({ ...ready, activation }, config), { code: 'NATIVE_PROTOCOL_MISMATCH' });
  }
  engine.stop();
});

test('capture-only pending transition cannot replenish native retry budget as ordinary confirmation', { timeout: 2000 }, async () => {
  const f = fixture(), statuses = [], engine = createBrowserExtension(f.api, { sourceDigest: SOURCE, onStatus: c => statuses.push(c) });
  try {
    await engine.start();
    const native = q => new Promise(resolve => {
      const original = f.ports[0].postMessage;
      f.ports[0].postMessage = message => { original(message); if (message.id === q.id) resolve(message); };
      f.ports[0].onMessage.emit(q);
    });
    const captured = await native(request('transition.capture', { transactionId: ID, challenge: CHALLENGE }));
    assert.equal(captured.result.admission, 'held');
    assert.equal(statuses.includes('native_transport_confirmed'), false);
    await native(request('transition.release', { transactionId: ID, challenge: CHALLENGE,
      workerEpoch: captured.result.workerEpoch, witnessDigest: captured.result.witnessDigest, mode: 'ordinary' }));
    assert.equal(statuses.includes('native_transport_confirmed'), true);
  } finally { engine.stop(); }
});
