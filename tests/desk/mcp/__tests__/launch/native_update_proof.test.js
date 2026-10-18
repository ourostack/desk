import '../_isolated_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkTempRoot } from '../_temp_roots.js';
import { protectWindowsPaths } from '../../../../../plugins/desk/mcp/src/factory/windows-acl.js';
import * as installer from '../../../../../plugins/desk/mcp/native-messaging-install.mjs';
import { withBrokerLock } from '../../../../../plugins/desk/mcp/src/util/broker-lock.mjs';
import client from '../../../../../plugins/desk/mcp/web-native-messaging.cjs';

const moduleUrl = new URL('../../../../../plugins/desk/mcp/src/browser/native-update-proof.mjs', import.meta.url);
const load = () => import(moduleUrl).catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
const ID = '11111111-1111-4111-8111-111111111111', SOURCE = 'b'.repeat(64), CHALLENGE = 'c'.repeat(64);
const activation = { protocol: 1, workerEpoch: ID, trigger: 'evaluation' };
const signed = value => ({ ...value, witnessDigest: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
async function fixture() {
  const root = await mkTempRoot('desk-native-transition-');
  const directory = path.join(root, 'native-owned');
  await fs.mkdir(directory, { mode: 0o700 });
  const config = { browserStateRoot: root, profileRoot: path.join(root, 'profile', 'Default'),
    extensionId: 'd'.repeat(32), extensionSourceDigest: SOURCE };
  const file = path.join(directory, 'extension-update.json');
  const write = async value => {
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    if (process.platform === 'win32') await protectWindowsPaths([
      { path: directory, kind: 'directory', created: true }, { path: file, kind: 'file', created: true }]);
  };
  const journal = { version: 2, transactionId: ID, challenge: CHALLENGE, phase: 'intent',
    profileRoot: config.profileRoot, extensionId: config.extensionId, sourceDigest: SOURCE, terminalReceipts: [] };
  return { config, file, write, journal };
}

test('ordinary no-journal handoff captures and releases UNKNOWN after admission, without creating state', async () => {
  const module = await load();
  assert.equal(typeof module.createNativeUpdateProof, 'function');
  const f = await fixture(), controls = [];
  const proof = module.createNativeUpdateProof(f.config);
  await proof.onAdmitted({
    generation: ID, bindingDigest: SOURCE, activation, recheck: async () => {},
    capture: async params => {
      controls.push('capture');
      assert.match(params.transactionId, /^[0-9a-f-]{36}$/u);
      assert.match(params.challenge, /^[a-f0-9]{64}$/u);
      return signed({ ...params, workerEpoch: ID, activation,
        admission: 'held', firstContextEffect: null, contextEffectSequence: 0,
        currentUnknownObligations: [] });
    },
    release: async params => { controls.push('release'); return { transactionId: params.transactionId, workerEpoch: ID, released: true }; },
  });
  assert.deepEqual(controls, ['capture', 'release']);
  await assert.rejects(fs.lstat(f.file), { code: 'ENOENT' });
  await assert.rejects(proof.verifyContinuity({ snapshot: { owners: [], digest: 'invalid' } }), { code: 'NATIVE_SNAPSHOT_CHANGED' });
});

for (const phase of ['intent', 'prepared', 'committing', 'blocked-origin']) {
  test(`matching ${phase} journal retains capture and never releases or grants an invented origin`, async () => {
    const module = await load();
    assert.equal(typeof module.createNativeUpdateProof, 'function');
    const f = await fixture(); f.journal.phase = phase;
    await f.write(f.journal);
    const proof = module.createNativeUpdateProof(f.config);
    let released = false;
    await assert.rejects(proof.onAdmitted({
      generation: ID, bindingDigest: SOURCE, activation, recheck: async () => {},
      capture: async params => signed({ ...params, workerEpoch: ID,
        activation: { protocol: 1, workerEpoch: ID, trigger: 'browser-install-event', reason: 'install' },
        admission: 'held', firstContextEffect: null, contextEffectSequence: 0,
        currentUnknownObligations: [] }),
      release: async () => { released = true; },
    }), { code: 'NATIVE_TRANSITION_ORIGIN_UNPROVED' });
    assert.equal(released, false);
    const retained = JSON.parse(await fs.readFile(f.file));
    assert.equal(retained.phase, phase, 'prepared state is never reset by capture or expiration');
    assert.equal(retained.capture.generation, ID);
    assert.equal(retained.capture.witness.activation.reason, 'install');
    assert.deepEqual(retained.terminalReceipts, []);
    assert.equal(retained.baselineId, undefined);
  });
}

for (const variant of ['legacy', 'foreign', 'invalid', 'forged-baseline', 'unknown-owner']) {
  test(`normal journal refuses ${variant} without ordinary release or empty-baseline amnesty`, async () => {
    const module = await load();
    assert.equal(typeof module.createNativeUpdateProof, 'function');
    const f = await fixture();
    let value = f.journal;
    if (variant === 'legacy') value = { version: 1 };
    if (variant === 'foreign') value.profileRoot += '-foreign';
    if (variant === 'invalid') value = '{';
    if (variant === 'forged-baseline') value.baselineId = ID;
    if (variant === 'unknown-owner') value.terminalReceipts = [{ contextId: ID, disposition: 'unknown' }];
    await f.write(value);
    let calls = 0;
    await assert.rejects(module.createNativeUpdateProof(f.config).onAdmitted({
      capture: async () => { ++calls; }, release: async () => { ++calls; },
    }));
    assert.equal(calls, 0);
    assert.equal(await fs.readFile(f.file, 'utf8'), typeof value === 'string' ? value : JSON.stringify(value));
  });
}

test('normal preparer is a real installer export and rejects proof/config flags before acquiring native authority', async () => {
  assert.equal(typeof installer.prepareNativeExtensionUpdate, 'function');
  await assert.rejects(installer.prepareNativeExtensionUpdate({ safe: true, browserProcessId: process.pid }),
    { code: 'NATIVE_INSTALL_OPTIONS_INVALID' });
});

test('journal appearing during capture prevents ordinary release and is retained', async () => {
  const module = await load(), f = await fixture();
  let released = false;
  await assert.rejects(module.createNativeUpdateProof(f.config).onAdmitted({
    activation, recheck: async () => {},
    capture: async params => {
      await f.write(f.journal);
      return signed({ ...params, workerEpoch: ID, activation, admission: 'held',
        firstContextEffect: null, contextEffectSequence: 0, currentUnknownObligations: [] });
    },
    release: async () => { released = true; },
  }), { code: 'NATIVE_TRANSITION_CHANGED' });
  assert.equal(released, false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file)), f.journal);
});

test('malformed native capture is never sealed, even with a genuine install-shaped activation', async () => {
  const module = await load(), f = await fixture();
  await f.write(f.journal);
  await assert.rejects(module.createNativeUpdateProof(f.config).onAdmitted({
    activation, recheck: async () => {},
    capture: async params => ({ ...params, workerEpoch: ID, activation, admission: 'held',
      firstContextEffect: null, contextEffectSequence: 1, currentUnknownObligations: [], witnessDigest: SOURCE }),
  }), { code: 'NATIVE_TRANSITION_WITNESS_INVALID' });
  assert.deepEqual(JSON.parse(await fs.readFile(f.file)), f.journal);
});

test('null journal is an explicit retained invalid obligation rather than a missing ordinary path', async () => {
  const module = await load(), f = await fixture();
  await f.write('null');
  await assert.rejects(module.createNativeUpdateProof(f.config).assertPreparationAvailable(),
    { code: 'NATIVE_TRANSITION_JOURNAL_INVALID' });
  assert.equal(await fs.readFile(f.file, 'utf8'), 'null');
});

test('ordinary handoff waits behind the existing normal update lock before deciding journal absence', async () => {
  const module = await load(), f = await fixture();
  let captured = 0, task;
  try {
    await withBrokerLock(path.dirname(f.file), async () => {
      task = module.createNativeUpdateProof(f.config).onAdmitted({
        activation, recheck: async () => {},
        capture: async params => {
          ++captured;
          return signed({ ...params, workerEpoch: ID, activation, admission: 'held',
            firstContextEffect: null, contextEffectSequence: 0, currentUnknownObligations: [] });
        },
        release: async params => ({ transactionId: params.transactionId, workerEpoch: ID, released: true }),
      });

      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(captured, 0);
    }, { name: 'native-extension-update' });
  } finally { await task; }
  assert.equal(captured, 1);
});

test('retained capture cannot be overwritten by a later provider generation', async () => {
  const module = await load(), f = await fixture();
  await f.write(f.journal);
  const evidence = generation => ({
    activation, generation, bindingDigest: SOURCE, recheck: async () => {},
    capture: async params => signed({ ...params, workerEpoch: ID, activation, admission: 'held',
      firstContextEffect: null, contextEffectSequence: 0, currentUnknownObligations: [] }),
    release: async () => { assert.fail('origin is unproved'); },
  });
  const proof = module.createNativeUpdateProof(f.config);
  await assert.rejects(proof.onAdmitted(evidence(ID)), { code: 'NATIVE_TRANSITION_ORIGIN_UNPROVED' });
  const retained = await fs.readFile(f.file, 'utf8');
  await assert.rejects(proof.onAdmitted(evidence('22222222-2222-4222-8222-222222222222')), { code: 'NATIVE_TRANSITION_REPLAY' });
  assert.equal(await fs.readFile(f.file, 'utf8'), retained);
});

for (const failure of ['interrupted-write', 'opened-replacement']) {
  test(`capture ${failure} retains an unknown obligation and never releases`, async t => {
    const module = await load(), f = await fixture();
    await f.write(f.journal);
    const open = fs.open;
    let closed = 0, released = false;
    t.mock.method(fs, 'open', async function(file, flags, ...args) {
      if (file === f.file && flags === 'r+' && failure === 'opened-replacement') {
        await fs.rename(file, `${file}.owned-original`);
        await f.write({ foreign: true });
      }
      const handle = await open.call(this, file, flags, ...args);
      if (file === f.file && flags === 'r+') {
        const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
        handle.close = async () => { ++closed; return close(); };
        if (failure === 'interrupted-write') handle.writeFile = async bytes => {
          await write(bytes.subarray(0, 9));
          throw Object.assign(Error('owned injected interrupted write'), { code: 'EIO' });
        };
      }
      return handle;
    });
    await assert.rejects(module.createNativeUpdateProof(f.config).onAdmitted({
      activation, generation: ID, bindingDigest: SOURCE, recheck: async () => {},
      capture: async params => signed({ ...params, workerEpoch: ID, activation, admission: 'held',
        firstContextEffect: null, contextEffectSequence: 0, currentUnknownObligations: [] }),
      release: async () => { released = true; },
    }));
    assert.equal(released, false);
    assert.equal(closed, 1);
    assert.ok(await fs.lstat(f.file));
    if (failure === 'opened-replacement') assert.deepEqual(JSON.parse(await fs.readFile(f.file)), { foreign: true });
  });
}

for (const race of ['disappear', 'same-bytes-replacement']) {
  test(`journal ${race} during the first protected read is not absence or new authority`, async t => {
    const module = await load(), f = await fixture();
    await f.write(f.journal);
    const original = client.readPrivateJson;
    let fired = false, captures = 0;
    t.mock.method(client, 'readPrivateJson', function(file, options) {
      if (file !== f.file || fired) return original(file, options);
      fired = true;
      const value = original(file, options);
      sync.renameSync(file, `${file}.owned-previous`);
      if (race === 'same-bytes-replacement') sync.writeFileSync(file, JSON.stringify(f.journal), { mode: 0o600 });
      if (race === 'disappear') return original(file, options);
      return value;
    });
    await assert.rejects(module.createNativeUpdateProof(f.config).onAdmitted({
      activation, recheck: async () => {},
      capture: async params => {
        ++captures;
        return signed({ ...params, workerEpoch: ID, activation, admission: 'held',
          firstContextEffect: null, contextEffectSequence: 0, currentUnknownObligations: [] });
      },
      release: async () => { throw Error('must not release'); },
    }), { code: 'NATIVE_TRANSITION_JOURNAL_INVALID' });
    assert.equal(captures, 0);
    if (race === 'same-bytes-replacement') assert.deepEqual(JSON.parse(await fs.readFile(f.file)), f.journal);
  });
}
