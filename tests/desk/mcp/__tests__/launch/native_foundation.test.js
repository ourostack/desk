import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, rename, lstat, mkdir, readdir } from 'node:fs/promises';
import { mkTempRoot } from '../_temp_roots.js';

// Optional read-only predecessor targets let RED exercise the real old behavior,
// not a missing-module failure. Normal tests always load the admitted source.
const host = await import(process.env.DESK_FOUNDATION_HOST_TEST_URL ??
  new URL('../../../../../plugins/desk/mcp/src/browser/native-host.mjs', import.meta.url));
async function loadTransport() {
  if (!process.env.DESK_FOUNDATION_TRANSPORT_TEST_URL)
    return import(new URL('../../../../../plugins/desk/mcp/src/browser/native-transport.mjs', import.meta.url));
  // Read only the exact generic class from retained source. Its surrounding
  // CDP engine imports ws/leases; those are neither needed nor admitted here.
  const text = await readFile(new URL(process.env.DESK_FOUNDATION_TRANSPORT_TEST_URL), 'utf8');
  const start = text.indexOf('export class NativeCommandTransport extends EventEmitter {');
  const end = text.indexOf('\nfunction sameIdentity', start);
  assert.ok(start >= 0 && end > start, 'exact retained transport anchors');
  const errorUrl = new URL('../../../../../plugins/desk/mcp/src/util/broker-error.mjs', import.meta.url);
  const code = `import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BrokerError } from ${JSON.stringify(errorUrl.href)};
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
${text.slice(start, end)}`;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const transportModule = await loadTransport();
const { NativeCommandTransport } = transportModule;
const contextId = '12345678-1234-4234-8234-123456789abc';
const extensionId = 'a'.repeat(32), sourceDigest = 'b'.repeat(64), profileToken = 'c'.repeat(64);
const origin = `chrome-extension://${extensionId}/`;
const identities = [
  { pid: 30, parentPid: 20, startIdentity: 'runtime-start', owner: 'fixture', executable: '/fixture/node' },
  { pid: 20, parentPid: 10, startIdentity: 'entry-start', owner: 'fixture', executable: '/fixture/entry' },
  { pid: 10, parentPid: 1, startIdentity: 'browser-start', owner: 'fixture', executable: '/fixture/browser' },
];
const reader = async pid => ({ ...identities.find(i => i.pid === pid) });
const config = {
  pid: 30, origin, extensionOrigin: origin, runtimeExecutable: '/fixture/node',
  entryExecutable: '/fixture/entry', browserExecutable: '/fixture/browser',
  expectedBrowser: identities[2],
};
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const request = (method = 'context.create') => ({ contextId, method, params: { profileToken, sourceDigest } });
const code = expected => error => error.code === expected;
const roots = [];
test.after(async () => {
  for (const root of roots) {
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    console.log(`confirmed native fixture absent=${root}`);
  }
});

test('correlated context requests do not require legacy lease authority', async () => {
  let sent;
  const t = new NativeCommandTransport({ send: value => { sent = value; } });
  try {
    const pending = t.request(request());
    // Attach now so the predecessor refusal is observed as an assertion, not an
    // unhandled rejection while waiting for a frame.
    const outcome = pending.then(result => ({ result }), error => ({ error }));
    await tick();
    assert.ok(sent?.contextId === contextId, 'valid canonical context request must dispatch without leaseId');
    t.receive({ id: sent.id, result: { ready: true } });
    assert.deepEqual(await outcome, { result: { ready: true } });
  } finally { t.close(); }
});

test('framing stays responsive while a dispatched handler awaits its reply', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  let unblock, replyObserved = false, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  const running = host.runNativeHost({ stdin, stdout, config: { ...config,
    async onMessage(message) {
      if (message.id === 'request') { entered(); await blocked; }
      else replyObserved = true;
    },
  }, processReader: reader });
  await tick();
  stdin.write(host.encodeNativeMessage({ id: 'request' }));
  await started;
  stdin.write(host.encodeNativeMessage({ id: 'reply' }));
  await tick();
  const observed = replyObserved;
  unblock();
  stdin.end();
  await running;
  stdout.destroy();
  assert.equal(observed, true, 'reply must not wait behind pending request completion');
});

test('native readiness checks exact selected profile and source pins without disk reads', () => {
  const pins = { extensionId, extensionSourceDigest: sourceDigest, expectedProfileToken: profileToken };
  const ready = { event: 'ready', protocolVersion: 1, extensionId, sourceDigest, profileToken };
  assert.doesNotThrow(() => host.assertNativeReady(ready, pins));
  for (const value of [undefined, null, '', 'malformed', 'd'.repeat(64)]) {
    assert.throws(() => host.assertNativeReady({ ...ready, profileToken: value }, pins), code('NATIVE_PROFILE_MISMATCH'));
    assert.throws(() => host.assertNativeReady({ ...ready, sourceDigest: value }, pins), code('NATIVE_EXTENSION_SOURCE_MISMATCH'));
  }
  for (const value of [undefined, '', 'malformed']) {
    assert.throws(() => host.assertNativeReady(ready, { ...pins, expectedProfileToken: value }), code('NATIVE_PROFILE_TOKEN_UNAVAILABLE'));
  }
  for (const value of [undefined, {}, { ...ready, protocolVersion: 2 }, { ...ready, extensionId: 'foreign' }])
    assert.throws(() => host.assertNativeReady(value, pins), code('NATIVE_PROTOCOL_MISMATCH'));
});

test('fragmented frames preserve native ready tokens and reject invalid bounded wire data', () => {
  const messages = [], errors = [];
  const framer = host.createNativeFramer({ onMessage: m => messages.push(m), onError: e => errors.push(e.code) });
  const ready = { event: 'ready', profileToken };
  for (const byte of host.encodeNativeMessage(ready)) framer.push(Buffer.from([byte]));
  framer.end();
  assert.deepEqual(messages, [ready]); // native framing is not a log redactor
  assert.deepEqual(errors, []);
  const raw = bytes => {
    const h = Buffer.alloc(4);
    h[os.endianness() === 'LE' ? 'writeUInt32LE' : 'writeUInt32BE'](bytes.length);
    return Buffer.concat([h, bytes]);
  };
  const oversized = Buffer.alloc(4);
  oversized[os.endianness() === 'LE' ? 'writeUInt32LE' : 'writeUInt32BE'](1_048_577);
  for (const [bytes, expected] of [
    [Buffer.alloc(4), 'NATIVE_FRAME_INVALID_LENGTH'], [oversized, 'NATIVE_FRAME_TOO_LARGE'],
    [raw(Buffer.from([0xff])), 'NATIVE_FRAME_INVALID_UTF8'],
    [raw(Buffer.from('{')), 'NATIVE_FRAME_INVALID_JSON'],
    [raw(Buffer.from('[]')), 'NATIVE_FRAME_INVALID_MESSAGE'],
    [Buffer.from([1]), 'NATIVE_FRAME_INCOMPLETE'],
  ]) {
    const failures = [];
    const f = host.createNativeFramer({ onMessage: () => assert.fail('invalid wire dispatched'), onError: e => failures.push(e.code) });
    f.push(bytes); f.end(); f.push(host.encodeNativeMessage({ late: true }));
    assert.deepEqual(failures, [expected]);
  }
  assert.throws(() => host.encodeNativeMessage({ huge: 'x'.repeat(1_048_576) }), code('NATIVE_FRAME_TOO_LARGE'));
});

test('exact ancestry refuses changed parent PID generation owner and executable', async () => {
  assert.deepEqual(await host.readNativeAncestry(30, { processReader: reader }), identities);
  for (const key of ['pid', 'parentPid', 'startIdentity', 'owner', 'executable']) {
    let reads = 0;
    await assert.rejects(host.readNativeAncestry(30, { processReader: async pid => {
      const value = await reader(pid);
      if (++reads > 3 && pid === 20) value[key] = typeof value[key] === 'number' ? value[key] + 1 : 'changed';
      return value;
    } }), code('NATIVE_ANCESTRY_INVALID'));
  }
  for (const patch of [{ origin: 'foreign' }, { runtimeExecutable: '/wrong' }, { entryExecutable: '/wrong' },
    { browserExecutable: '/wrong' }, { expectedBrowser: { ...identities[2], startIdentity: 'stale' } }]) {
    const stdin = new PassThrough(), stdout = new PassThrough();
    await assert.rejects(host.runNativeHost({ stdin, stdout, config: { ...config, ...patch, onMessage() {} },
      processReader: reader }), e => ['NATIVE_ORIGIN_REFUSED', 'NATIVE_ANCESTRY_MISMATCH'].includes(e.code));
    stdin.destroy(); stdout.destroy();
  }
});

test('periodic ancestry rechecks invalidate the open framed host', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  let changed = false, ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const running = host.runNativeHost({ stdin, stdout, identityPollMs: 5,
    processReader: async pid => ({ ...await reader(pid), ...(changed && pid === 20 ? { startIdentity: 'new' } : {}) }),
    config: { ...config, onMessage() { ready(); } } });
  const failed = assert.rejects(running, code('NATIVE_ANCESTRY_INVALID'));
  await tick();
  stdin.write(host.encodeNativeMessage({ event: 'fixture' }));
  await initialized;
  changed = true;
  await tick(); // PassThrough has no OS handle; keep the fixture alive for poll.
  await failed;
  assert.equal(stdin.destroyed, true);
  stdout.destroy();
});

test('scope discrimination rejects crossed or malformed context and provider requests before dispatch', async () => {
  let sent = 0;
  const t = new NativeCommandTransport({ send: value => {
    sent++;
    t.receive({ id: value.id, result: { wronglyDispatched: true } });
  } });
  try {
    for (const value of [
      { method: 'context.create', params: {} },
      { ...request(), contextId: contextId.toUpperCase() },
      { ...request(), contextId: 'not-a-uuid' },
      { ...request(), contextId: new String(contextId) },
      { ...request(), contextId: '12345678-1234-1234-1234-123456789abc' },
      ...['profile.read', 'extension.reload', 'extension.reload.commit'].map(method => ({ ...request(method) })),
      { ...request(), method: 'window.create' }, { ...request(), params: [] },
      { ...request(), leaseId: 'x'.repeat(161) },
      { ...request(), params: { huge: 'x'.repeat(1_048_576) } },
    ]) await assert.rejects(t.request(value), e => ['NATIVE_REQUEST_INVALID', 'NATIVE_FRAME_TOO_LARGE'].includes(e.code));
    assert.equal(sent, 0);
    for (const method of ['profile.read', 'extension.reload', 'extension.reload.commit']) {
      const outgoing = [];
      const p = new NativeCommandTransport({ send: value => outgoing.push(value) });
      const result = p.request({ method, leaseId: 'routing-only', params: {} });
      await tick();
      assert.equal(Object.hasOwn(outgoing[0], 'contextId'), false);
      p.receive({ id: outgoing[0].id, result: { method } });
      assert.deepEqual(await result, { method });
      p.close();
    }
  } finally { t.close(); }
});

test('reordered duplicate late and ambiguous replies cannot cross pending requests', async () => {
  const sent = [];
  const t = new NativeCommandTransport({ send: value => sent.push(value) });
  const a = t.request(request('context.status')), b = t.request(request('context.resume'));
  await tick();
  assert.notEqual(sent[0].id, sent[1].id);
  t.receive({ id: sent[1].id, result: 'second' });
  t.receive({ id: sent[0].id, result: 'first' });
  assert.deepEqual(await Promise.all([a, b]), ['first', 'second']);
  assert.equal(t.receive({ id: sent[0].id, result: 'duplicate' }), false);
  assert.equal(t.receive({ id: 'unknown', result: 'late' }), false);
  const c = t.request(request());
  const rejected = assert.rejects(c, e => e.code === 'NATIVE_RESPONSE_INVALID' && e.details.effect === 'unknown');
  await tick();
  t.receive({ id: sent[2].id, result: {}, error: { code: 'oops', message: 'private' } });
  await rejected;
  t.close();
});

test('timeouts disconnects and send failures retain named unknown effects without secrets', async () => {
  for (const mode of ['timeout', 'disconnect', 'send']) {
    const sent = [];
    const t = new NativeCommandTransport({ timeoutMs: 15, send: value => {
      sent.push(value);
      if (mode === 'send') throw Error(`ws://127.0.0.1:123/extension/${profileToken}`);
    } });
    const p = t.request(request());
    const rejected = assert.rejects(p, e => {
      assert.equal(e.details.effect, 'unknown');
      assert.deepEqual(e.details.request, { id: sent[0].id, method: 'context.create', contextId });
      assert.deepEqual(e.resources, { contextId, disposition: 'unknown' });
      assert.equal(JSON.stringify(e).includes(profileToken), false);
      assert.doesNotMatch(e.message, /ws:|extension\/|private/);
      return true;
    });
    await tick(5);
    if (mode === 'disconnect') t.close();
    await tick(20);
    await rejected;
    assert.equal(t.receive({ id: sent[0].id, result: { cleaned: true } }), false);
    t.close();
  }
});

test('producer error resources survive while native exception messages stay private', async () => {
  const sent = [];
  const t = new NativeCommandTransport({ send: value => sent.push(value) });
  const resources = { contextId, groupId: 42, uncertain: [{ tabId: 123, reason: 'native_command_effect_unconfirmed' }] };
  const p = t.request(request('context.discard'));
  const rejected = assert.rejects(p, e => {
    assert.equal(e.code, 'native_cleanup_unconfirmed');
    assert.deepEqual(e.resources, resources);
    assert.deepEqual(e.details.resources, resources);
    assert.equal(e.message, 'native_cleanup_unconfirmed');
    return true;
  });
  await tick();
  t.receive({ id: sent[0].id, error: { code: 'native_cleanup_unconfirmed', message: profileToken, resources } });
  await rejected;
  t.close();
});

test('fixed current producer error codes survive without native exception messages', async () => {
  const sent = [];
  const t = new NativeCommandTransport({ send: value => sent.push(value) });
  try {
    for (const expected of ['native_request_busy', 'native_operation_failed', 'native_task_create_failed', 'native_discard_incomplete']) {
      const p = t.request(request());
      const rejected = assert.rejects(p, error => error.code === expected && error.message === expected);
      await tick();
      t.receive({ id: sent.at(-1).id, error: { code: expected, message: `private ${profileToken}` } });
      await rejected;
    }
  } finally { t.close(); }
});

test('current producer dispatch consumes discriminated requests and keeps bootstrap token on the private wire', async () => {
  const { createBrowserExtension } = await import('../../../../../plugins/desk/browser-extension/context-engine.mjs');
  const listeners = new Set();
  const event = () => ({ addListener: f => listeners.add(f), removeListener: f => listeners.delete(f) });
  const extension = createBrowserExtension({
    tabs: { onUpdated: event(), onRemoved: event(), onCreated: event(), onDetached: event() },
    debugger: { onEvent: event(), onDetach: event() },
    runtime: {
      id: extensionId, getURL: value => origin + value,
      getContexts: async () => [{ documentUrl: origin + 'token.html' }],
      sendMessage: async () => ({ token: profileToken }),
    },
  }, { sourceDigest });
  const t = new NativeCommandTransport({ send: async value => t.receive(await extension.dispatch(value)) });
  try {
    assert.deepEqual(await t.request({ method: 'profile.read', params: {} }),
      { profileToken, extensionId, sourceDigest });
    const transactionId = '11111111-1111-4111-8111-111111111111', challenge = 'e'.repeat(64);
    const captured = await t.request({ method: 'transition.capture', params: { profileToken, sourceDigest, transactionId, challenge } });
    await t.request({ method: 'transition.release', params: { profileToken, sourceDigest, transactionId, challenge,
      workerEpoch: captured.workerEpoch, witnessDigest: captured.witnessDigest, mode: 'ordinary' } });
    await assert.rejects(t.request(request('context.status')), code('native_context_unavailable'));
    await assert.rejects(t.request({ method: 'profile.read', params: { profileToken: 'd'.repeat(64) } }),
      code('native_profile_mismatch'));
    const params = { profileToken, sourceDigest, updateToken: 'd'.repeat(64) };
    assert.deepEqual(await t.request({ method: 'extension.reload', params }), { reload: true });
    assert.deepEqual(await t.request({ method: 'extension.reload.commit', params }), { committing: true });
  } finally { t.close(); extension.stop(); }
  assert.equal(listeners.size, 0);
});

test('selected partition reader supplies native pins from owned synthetic bytes only', async t => {
  const { createRequire } = await import('node:module');
  const { readExtensionToken } = createRequire(import.meta.url)('../../../../../plugins/desk/mcp/web-extension-credential.cjs');
  const root = await mkTempRoot('native-selected-pins-');
  roots.push(root);
  t.diagnostic(`owned synthetic partition root=${root}`);
  const selected = path.join(root, 'User Data', 'Default');
  const peer = path.join(root, 'User Data', 'Profile 1');
  for (const [directory, marker] of [[selected, 'selected-synthetic-bytes'], [peer, 'foreign-synthetic-bytes']]) {
    const leveldb = path.join(directory, 'Local Storage', 'leveldb');
    await mkdir(leveldb, { recursive: true, mode: 0o700 });
    await writeFile(path.join(leveldb, 'fixture.ldb'), marker, { mode: 0o600 });
    await writeFile(path.join(leveldb, 'LOCK'), 'must-not-copy', { mode: 0o600 });
  }
  const copies = [];
  let dbClosed = 0, iteratorClosed = 0;
  class ClassicLevel {
    constructor(copy) { this.copy = copy; copies.push(copy); }
    iterator() {
      const entries = [
        [Buffer.from('_chrome-extension://' + 'd'.repeat(32) + '\u0000\u0001deskBrowserProfileToken', 'latin1'), Buffer.from('\u0001wrong', 'latin1')],
        [Buffer.from('_chrome-extension://' + extensionId + '\u0000\u0001deskBrowserProfileToken', 'latin1'), Buffer.from('\u0001' + profileToken, 'latin1')],
      ];
      return {
        next: async () => {
          assert.equal(await readFile(path.join(this.copy, 'fixture.ldb'), 'utf8'), 'selected-synthetic-bytes');
          assert.deepEqual(await readdir(this.copy), ['fixture.ldb']);
          return entries.shift();
        },
        close: async () => { iteratorClosed++; },
      };
    }
    async close() { dbClosed++; }
  }
  const pin = await readExtensionToken(selected, {
    extensionId, tokenKey: 'deskBrowserProfileToken', level: { ClassicLevel }, tmpdir: root,
  });
  const pins = { extensionId, extensionSourceDigest: sourceDigest, expectedProfileToken: pin };
  const ready = { event: 'ready', protocolVersion: 1, extensionId, sourceDigest, profileToken };
  host.assertNativeReady(ready, pins);
  assert.throws(() => host.assertNativeReady({ ...ready, profileToken: 'e'.repeat(64) }, pins), code('NATIVE_PROFILE_MISMATCH'));
  assert.equal(dbClosed, 1); assert.equal(iteratorClosed, 1);
  for (const copy of copies) await assert.rejects(lstat(copy), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(peer, 'Local Storage', 'leveldb', 'fixture.ldb'), 'utf8'), 'foreign-synthetic-bytes');
});

test('pending capacity deadlines frame size and sender options are bounded', async () => {
  assert.throws(() => new NativeCommandTransport({ send() {}, timeoutMs: 2 ** 31 }), code('INVALID_NATIVE_TRANSPORT'));
  const t = new NativeCommandTransport({ send() {}, timeoutMs: 1_000 });
  const all = Array.from({ length: 256 }, () => t.request(request()).catch(e => e.code));
  await assert.rejects(t.request(request()), code('NATIVE_QUEUE_FULL'));
  t.close();
  assert.equal((await Promise.all(all)).length, 256);
  assert.equal(t.pending.size, 0);
});

test('ready reservation is private and close never deletes a replacement inode', async t => {
  const root = await mkTempRoot('native-ready-');
  roots.push(root);
  t.diagnostic(`owned ready fixture root=${root}`);
  const readyFile = path.join(root, 'ready.json');
  const record = { version: 1, generation: contextId };
  const reserved = await host.reserveNativeReadyFile({ readyFile, record });
  assert.deepEqual(JSON.parse(await readFile(readyFile, 'utf8')), record);
  if (process.platform !== 'win32') assert.equal((await lstat(readyFile)).mode & 0o777, 0o600);
  await assert.rejects(host.reserveNativeReadyFile({ readyFile, record }), code('NATIVE_STATE_UNAVAILABLE'));
  await rename(readyFile, path.join(root, 'retained-original.json'));
  await writeFile(readyFile, JSON.stringify({ replacement: true }), { mode: 0o600 });
  await assert.rejects(reserved.close(), code('NATIVE_STATE_CHANGED'));
  assert.deepEqual(JSON.parse(await readFile(readyFile, 'utf8')), { replacement: true });
  const secondFile = path.join(root, 'second.json');
  const second = await host.reserveNativeReadyFile({ readyFile: secondFile, record });
  await second.close(); await second.close();
  await assert.rejects(lstat(secondFile), { code: 'ENOENT' });
});

test('diagnostics use fixed codes and never raw native messages or tokens', async () => {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const messages = [], logs = [];
  const f = host.createNativeFramer({ onMessage: value => messages.push(value), onError: assert.fail });
  stdout.on('data', b => f.push(b));
  stderr.on('data', b => logs.push(String(b)));
  await host.reportNativeDiagnostic({ stdout, stderr, stage: 'profile-token' },
    { code: profileToken.toUpperCase(), message: `https://private/${profileToken}`, syscall: '/private' }, 'NATIVE_HOST_FAILED');
  assert.deepEqual(messages, [{ event: 'diagnostic', code: 'NATIVE_HOST_FAILED', stage: 'profile-token' }]);
  assert.deepEqual(logs, ['NATIVE_HOST_FAILED\n']);
  stdout.destroy(); stderr.destroy();
});

test('synchronous native output failures expose only fixed write diagnostics', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdout.write = () => { throw Error(`private ${profileToken}`); };
  let observed;
  const running = host.runNativeHost({ stdin, stdout, processReader: reader,
    config: { ...config, async onMessage(_message, { send }) {
      try { await send({ event: 'fixture' }); } catch (error) { observed = error; }
    } } });
  await tick();
  stdin.end(host.encodeNativeMessage({ id: 'fixture' }));
  await running;
  stdout.destroy();
  assert.equal(observed?.code, 'NATIVE_TRANSPORT_WRITE_FAILED');
  assert.equal(observed.message.includes(profileToken), false);
  const stderr = new PassThrough();
  const broken = { write() { throw Error(profileToken); } };
  await assert.rejects(host.reportNativeDiagnostic({ stdout: broken, stderr }, Error('private'), 'NATIVE_HOST_FAILED'),
    error => error.code === 'NATIVE_TRANSPORT_WRITE_FAILED' && !error.message.includes(profileToken));
  await assert.rejects(host.reportNativeDiagnostic({ stdout: new PassThrough(), stderr: broken }, Error('private'), 'NATIVE_HOST_FAILED'),
    error => error.code === 'NATIVE_TRANSPORT_WRITE_FAILED' && !error.message.includes(profileToken));
  stderr.destroy();
});
