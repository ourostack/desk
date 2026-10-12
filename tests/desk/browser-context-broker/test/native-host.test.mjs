import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';

const moduleUrl = new URL('../../../../plugins/desk/browser-context-broker/src/native-host.mjs', import.meta.url);

function frame(value) {
  const json = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  if (os.endianness() === 'LE') header.writeUInt32LE(json.length);
  else header.writeUInt32BE(json.length);
  return Buffer.concat([header, json]);
}

async function parser() {
  const { createNativeFramer } = await import(moduleUrl);
  const messages = [];
  const errors = [];
  return { messages, errors, framer: createNativeFramer({
    onMessage: value => messages.push(value),
    onError: error => errors.push(error),
  }) };
}

test('GivenNativeStartupFailure_WhenDiagnosed_StableCodeIsRetainedWithoutPrivateMessage', async () => {
  const { nativeDiagnosticCode } = await import(moduleUrl);
  assert.equal(nativeDiagnosticCode({ code: 'NATIVE_CONTROL_MISMATCH', message: 'private context token' }, 'NATIVE_HOST_FAILED'),
    'NATIVE_CONTROL_MISMATCH');
  assert.equal(nativeDiagnosticCode({ code: 'credential-bearing-url', message: 'private token' }, 'NATIVE_HOST_FAILED'),
    'NATIVE_HOST_FAILED');
  assert.equal(nativeDiagnosticCode(new Error('private token'), 'NATIVE_HOST_FAILED'), 'NATIVE_HOST_FAILED');
});

test('native startup diagnostic frame reaches the receiver before its actual child process exits', async () => {
  const { createNativeFramer } = await import(moduleUrl);
  const messages = [];
  const failures = [];
  const framer = createNativeFramer({ onMessage: value => messages.push(value), onError: value => failures.push(value) });
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { reportNativeDiagnostic } from ${JSON.stringify(moduleUrl.href)};
     await reportNativeDiagnostic({ stdout: process.stdout, stderr: process.stderr, stage: 'profile-token' },
       { code: 'EPERM', syscall: 'copyfile', stage: 'private profile', message: 'private profile https://private/token' }, 'NATIVE_HOST_FAILED');
     process.exitCode = 1;`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.on('data', bytes => framer.push(bytes));
  child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  framer.end();
  assert.equal(code, 1);
  assert.deepEqual(failures, []);
  assert.deepEqual(messages, [{ event: 'diagnostic', code: 'EPERM', stage: 'profile-token', syscall: 'copyfile' }]);
  assert.equal(stderr.trim(), 'EPERM');
  assert.equal(JSON.stringify(messages).includes('private'), false);
});

test('native diagnostics omit unrecognized context instead of deriving it from error details', async () => {
  const { reportNativeDiagnostic, createNativeFramer } = await import(moduleUrl);
  const messages = [];
  const framer = createNativeFramer({ onMessage: value => messages.push(value), onError: error => { throw error; } });
  const stdout = new PassThrough(), stderr = new PassThrough();
  stdout.on('data', bytes => framer.push(bytes));
  await reportNativeDiagnostic({ stdout, stderr, stage: '/private/profile' },
    { code: 'EPERM', syscall: 'open/private/profile', stage: 'provider' }, 'NATIVE_HOST_FAILED');
  framer.end();
  assert.deepEqual(messages, [{ event: 'diagnostic', code: 'EPERM' }]);
});

test('native startup diagnostics retain failure when the native output cannot accept a frame', async () => {
  const { reportNativeDiagnostic } = await import(moduleUrl);
  const stderr = new PassThrough();
  let text = '';
  stderr.on('data', value => { text += value; });
  const stdout = { destroyed: true, write() { throw Error('must not write to a closed pipe'); } };
  assert.deepEqual(await reportNativeDiagnostic({ stdout, stderr }, Error('private'), 'NATIVE_HOST_FAILED'),
    { delivered: false });
  const broken = { write(bytes, done) { done(Error('pipe failed')); } };
  await assert.rejects(reportNativeDiagnostic({ stdout: broken, stderr }, Error('private'), 'NATIVE_HOST_FAILED'),
    /pipe failed/u);
  assert.equal(text.includes('private'), false);
});

test('GivenControlNavigationFailure_WhenDiagnosed_BoundedReasonRetainsNoUrlOrToken', async () => {
  const { nativeDiagnosticLine } = await import(moduleUrl);
  const result = nativeDiagnosticLine({
    code: 'NATIVE_CONTROL_NAVIGATION_FAILED',
    message: 'Cannot navigate chrome-extension://owned/control.html#owner-secret token ' + 'a'.repeat(64),
  }, 'NATIVE_HOST_FAILED');
  assert.match(result, /Cannot navigate/u);
  assert.equal(result.includes('owner-secret'), false);
  assert.equal(result.includes('a'.repeat(64)), false);
  assert.equal(nativeDiagnosticLine({ code: 'OTHER_FAILURE', message: 'private content' }, 'NATIVE_HOST_FAILED'), 'OTHER_FAILURE');
  assert.match(nativeDiagnosticLine({ code: 'NATIVE_CONTROL_RESTORATION_FAILED', message: 'Recorded route unavailable' },
    'NATIVE_HOST_FAILED'), /Recorded route unavailable/u);
});

test('GivenNativeReady_WhenExecutedExtensionSourceDiffers_ProviderCannotStart', async () => {
  const { assertNativeReady } = await import(moduleUrl);
  const config = { extensionId: 'owned-extension', extensionSourceDigest: 'a'.repeat(64), expectedProfileToken: 'c'.repeat(64) };
  const ready = { event: 'ready', protocolVersion: 1, extensionId: 'owned-extension', sourceDigest: 'a'.repeat(64), profileToken: 'c'.repeat(64) };
  assert.doesNotThrow(() => assertNativeReady(ready, config));
  for (const sourceDigest of [undefined, '', 'b'.repeat(64)]) {
    assert.throws(() => assertNativeReady({ ...ready, sourceDigest }, config),
      error => error.code === 'NATIVE_EXTENSION_SOURCE_MISMATCH');
  }
  assert.throws(() => assertNativeReady({ ...ready, extensionId: 'foreign' }, config),
    error => error.code === 'NATIVE_PROTOCOL_MISMATCH');
});

test('native readiness requires the independently pinned selected-profile token without reading a profile', async () => {
  const { assertNativeReady } = await import(moduleUrl);
  const config = { extensionId: 'owned-extension', extensionSourceDigest: 'a'.repeat(64), expectedProfileToken: 'c'.repeat(64) };
  const ready = { event: 'ready', protocolVersion: 1, extensionId: config.extensionId,
    sourceDigest: config.extensionSourceDigest, profileToken: 'c'.repeat(64) };
  assert.doesNotThrow(() => assertNativeReady(ready, config));
  for (const expectedProfileToken of [undefined, null, '', 'corrupt']) {
    assert.throws(() => assertNativeReady(ready, { ...config, expectedProfileToken }),
      error => error.code === 'NATIVE_PROFILE_TOKEN_UNAVAILABLE');
  }
  for (const profileToken of [undefined, 'corrupt', 'd'.repeat(64)]) {
    assert.throws(() => assertNativeReady({ ...ready, profileToken }, config),
      error => error.code === 'NATIVE_PROFILE_MISMATCH');
  }
});

test('GivenFragmentedUnicodeFrames_WhenPushed_FramerEmitsCompleteMessagesOnly', async () => {
  const { messages, errors, framer } = await parser();
  const message = { text: 'caf\u00e9 \ud83d\ude80', id: '__proto__' };
  const bytes = frame(message);
  for (let index = 0; index < bytes.length - 1; index++) {
    framer.push(bytes.subarray(index, index + 1));
    assert.equal(messages.length, 0);
  }
  framer.push(bytes.subarray(-1));
  assert.deepEqual(messages, [message]);
  assert.deepEqual(errors, []);
  framer.end();
  assert.deepEqual(errors, []);
});

test('GivenTwoNativeFrames_WhenOneChunkArrives_BothMessagesAreEmitted', async () => {
  const { messages, errors, framer } = await parser();
  framer.push(Buffer.concat([frame({ id: 1 }), frame({ id: 2 })]));
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(errors, []);
});

for (const [length, code] of [[0, 'NATIVE_FRAME_INVALID_LENGTH'], [1048577, 'NATIVE_FRAME_TOO_LARGE']]) {
  test(`GivenInvalidLength${length}_WhenPushed_FramerFailsTerminally`, async () => {
    const { messages, errors, framer } = await parser();
    const size = Buffer.alloc(4);
    if (os.endianness() === 'LE') size.writeUInt32LE(length);
    else size.writeUInt32BE(length);
    framer.push(size);
    framer.push(frame({ ignored: true }));
    framer.end();
    assert.equal(messages.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, code);
  });
}

test('GivenInvalidJson_WhenPushed_FramerReturnsSpecificError', async () => {
  const { messages, errors, framer } = await parser();
  const malformed = frame({ value: true });
  malformed[4] = 0;
  framer.push(malformed);
  assert.equal(messages.length, 0);
  assert.equal(errors[0].code, 'NATIVE_FRAME_INVALID_JSON');
});

for (const missing of [1, 3, 6]) {
  test(`GivenPartialNativeFrame${missing}_WhenEnded_FramerRefusesIncompleteInput`, async () => {
    const { messages, errors, framer } = await parser();
    const bytes = frame({ value: true });
    framer.push(bytes.subarray(0, bytes.length - missing));
    framer.end();
    assert.equal(messages.length, 0);
    assert.equal(errors[0].code, 'NATIVE_FRAME_INCOMPLETE');
  });
}

for (const value of [null, [], 'not-an-object', 42]) {
  test('GivenNonObjectNativeMessage_WhenPushed_FramerRejectsSchema', async () => {
    const { messages, errors, framer } = await parser();
    framer.push(frame(value));
    assert.equal(messages.length, 0);
    assert.equal(errors[0].code, 'NATIVE_FRAME_INVALID_MESSAGE');
  });
}

test('GivenInvalidUtf8_WhenPushed_FramerRejectsCorruptFrame', async () => {
  const { messages, errors, framer } = await parser();
  const bytes = frame({ value: 'x' });
  bytes[bytes.indexOf(Buffer.from('x'))] = 0xff;
  framer.push(bytes);
  assert.equal(messages.length, 0);
  assert.equal(errors[0].code, 'NATIVE_FRAME_INVALID_UTF8');
});

test('GivenValidMessage_WhenEncoded_LengthMatchesUtf8ByteCount', async () => {
  const { encodeNativeMessage } = await import(moduleUrl);
  assert.deepEqual(encodeNativeMessage({ text: '\u00e9' }), frame({ text: '\u00e9' }));
  assert.throws(() => encodeNativeMessage({ text: 'x'.repeat(1048576) }), error => error.code === 'NATIVE_FRAME_TOO_LARGE');
});

const browser = { pid: 101, parentPid: 1, startIdentity: 'browser-1', owner: 'user', executable: '/opt/browser' };
const entry = { pid: 102, parentPid: 101, startIdentity: 'entry-1', owner: 'user', executable: '/opt/entry' };
const runtime = { pid: 103, parentPid: 102, startIdentity: 'runtime-1', owner: 'user', executable: '/opt/node' };
const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const config = {
  origin, extensionOrigin: origin, pid: runtime.pid,
  entryExecutable: entry.executable, runtimeExecutable: runtime.executable,
  browserExecutable: browser.executable, expectedBrowser: browser,
  onMessage: message => ({ id: message.id, result: message.params }),
};
const reader = async pid => [runtime, entry, browser].find(identity => identity.pid === pid);

test('a correct pinned and claimed profile token cannot authorize foreign ancestry or another browser generation', async () => {
  const { runNativeHost, assertNativeReady } = await import(moduleUrl);
  const ready = { event: 'ready', protocolVersion: 1, extensionId: 'owned-extension',
    sourceDigest: 'a'.repeat(64), profileToken: 'c'.repeat(64) };
  const pin = { extensionId: ready.extensionId, extensionSourceDigest: ready.sourceDigest, expectedProfileToken: ready.profileToken };
  assert.doesNotThrow(() => assertNativeReady(ready, pin));
  for (const expectedBrowser of [{ ...browser, startIdentity: 'replacement' }, { ...browser, executable: '/foreign/browser' }]) {
    const stdin = new PassThrough(), stdout = new PassThrough();
    let dispatched = false;
    stdin.end(frame(ready));
    await assert.rejects(runNativeHost({ stdin, stdout, processReader: reader,
      config: { ...config, ...pin, expectedBrowser, onMessage(message) { dispatched = true; assertNativeReady(message, pin); } } }),
      error => error.code === 'NATIVE_ANCESTRY_MISMATCH');
    assert.equal(dispatched, false);
  }
});

test('GivenNativeHostAncestry_WhenRead_ReturnsRuntimeEntryAndBrowser', async () => {
  const { readNativeAncestry } = await import(moduleUrl);
  assert.deepEqual(await readNativeAncestry(runtime.pid, { processReader: reader }), [runtime, entry, browser]);
});

for (const changed of [
  { parentPid: 103 }, { startIdentity: '' }, { executable: 'node' }, { owner: '' }, { pid: 999 },
]) {
  test('GivenUnreadableOrCyclicAncestry_WhenRead_RefusesIncompleteEvidence', async () => {
    const { readNativeAncestry } = await import(moduleUrl);
    await assert.rejects(readNativeAncestry(runtime.pid, {
      processReader: async pid => pid === runtime.pid ? { ...runtime, ...changed } : reader(pid),
    }), error => error.code === 'NATIVE_ANCESTRY_INVALID');
  });
}

test('GivenRealProcess_WhenRead_IdentityContainsExecutableOwnerAndGeneration', async () => {
  const { readNativeProcess } = await import(moduleUrl);
  const identity = await readNativeProcess(process.pid);
  assert.equal(identity.pid, process.pid);
  assert.equal(identity.parentPid, process.ppid);
  assert.equal(identity.executable, process.execPath);
  assert.ok(identity.owner.length > 0);
  assert.ok(identity.startIdentity.length > 0);
});

for (const mutation of [
  { origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/' },
  { entryExecutable: '/opt/foreign' },
  { expectedBrowser: { ...browser, startIdentity: 'browser-2' } },
  { runtimeExecutable: '/opt/foreign-node' },
]) {
  test('GivenUnboundNativeHost_WhenRun_RefusesBeforeMessageOrStdout', async () => {
    const { runNativeHost } = await import(moduleUrl);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks = [];
    stdout.on('data', bytes => chunks.push(bytes));
    let invoked = false;
    await assert.rejects(runNativeHost({
      stdin, stdout,
      config: { ...config, ...mutation, onMessage: () => { invoked = true; } },
      processReader: reader,
    }), error => ['NATIVE_ORIGIN_REFUSED', 'NATIVE_ANCESTRY_MISMATCH'].includes(error.code));
    assert.equal(invoked, false);
    assert.equal(chunks.length, 0);
  });
}

test('GivenBoundNativeHost_WhenFramesArrive_ResponsesAreFramedAndEofWaitsForDispatch', async () => {
  const { runNativeHost } = await import(moduleUrl);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks = [];
  stdout.on('data', bytes => chunks.push(bytes));
  const running = runNativeHost({ stdin, stdout, config, processReader: reader });
  stdin.end(Buffer.concat([frame({ id: 1, params: 'one' }), frame({ id: 2, params: 'two' })]));
  assert.deepEqual(await running, { closed: true });
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([frame({ id: 1, result: 'one' }), frame({ id: 2, result: 'two' })]));
});

test('GivenNativeDispatchFailure_WhenRun_ErrorIsNotSuccessShapedOrWrittenAsText', async () => {
  const { runNativeHost } = await import(moduleUrl);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks = [];
  stdout.on('data', bytes => chunks.push(bytes));
  const running = runNativeHost({
    stdin, stdout, config: { ...config, onMessage: () => { throw new Error('dispatcher failed'); } }, processReader: reader,
  });
  stdin.end(frame({ id: 1 }));
  await assert.rejects(running, /dispatcher failed/u);
  assert.equal(chunks.length, 0);
});

test('GivenAncestryReadFailure_WhenRead_ReturnsSpecificRefusal', async () => {
  const { readNativeAncestry } = await import(moduleUrl);
  await assert.rejects(readNativeAncestry(runtime.pid, {
    processReader: async () => { throw new Error('OS access refused'); },
  }), error => error.code === 'NATIVE_ANCESTRY_INVALID');
});

test('GivenAncestryGenerationChanges_WhenRechecked_RefusesRace', async () => {
  const { readNativeAncestry } = await import(moduleUrl);
  let reads = 0;
  await assert.rejects(readNativeAncestry(runtime.pid, {
    processReader: async pid => {
      const identity = await reader(pid);
      return ++reads > 3 ? { ...identity, startIdentity: 'replacement' } : identity;
    },
  }), error => error.code === 'NATIVE_ANCESTRY_INVALID');
});

for (const stream of ['stdin', 'stdout']) {
  test(`GivenNative${stream}ClosesWithoutEof_WhenRun_ReportsTransportLoss`, async () => {
    const { runNativeHost } = await import(moduleUrl);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = runNativeHost({ stdin, stdout, config, processReader: reader });
    const refusal = assert.rejects(running, error => error.code === 'NATIVE_TRANSPORT_CLOSED');
    await new Promise(setImmediate);
    ({ stdin, stdout })[stream].destroy();
    await refusal;
  });
}

// 2026-10-12, 20:50Z: a session opened Teams and the native host ended on the next call. A busy page sends hundreds of CDP events
// in one read; the host failed its transport on the 257th queued message, and every session lost the browser with it.
test('GivenABurstOfThousandsOfInboundEvents_WhenRun_EveryOneIsDispatchedInOrderAndTheHostStaysUp', async () => {
  const { runNativeHost } = await import(moduleUrl);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const seen = [];
  const running = runNativeHost({
    stdin, stdout, processReader: reader,
    config: { ...config, onMessage: async message => { seen.push(message.id); await new Promise(setImmediate); } },
  });
  stdin.end(Buffer.concat(Array.from({ length: 5000 }, (_, id) => frame({ id, event: 'cdp' }))));
  assert.deepEqual(await running, { closed: true });
  assert.equal(seen.length, 5000);
  assert.deepEqual(seen.slice(0, 3), [0, 1, 2]);
  assert.equal(seen.at(-1), 4999);
});

test('GivenAnInboundMessageLargerThanOneMebibyte_WhenRun_ItIsDispatched', async () => {
  const { runNativeHost } = await import(moduleUrl);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let size = 0;
  const running = runNativeHost({
    stdin, stdout, processReader: reader, config: { ...config, onMessage: message => { size = message.data.length; } },
  });
  const data = 'x'.repeat(3 * 1048576);
  const body = Buffer.from(JSON.stringify({ id: 1, data }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  stdin.end(Buffer.concat([header, body]));
  assert.deepEqual(await running, { closed: true });
  assert.equal(size, data.length, 'a screenshot or a busy page event can pass 1 MiB; Chrome sends up to 64 MiB');
});

test('GivenOneFailedAncestryRead_WhenPolled_TheTransportStaysUp', async () => {
  const { runNativeHost } = await import(moduleUrl);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let failures = 0;
  let polling = false;
  const running = runNativeHost({
    stdin, stdout, config, identityPollMs: 5,
    processReader: async pid => {
      if (pid === runtime.parentPid && failures < 2 && polling) {
        failures++;
        throw new Error('ps timed out under load');
      }
      return reader(pid);
    },
  });
  await new Promise(setImmediate);
  polling = true;
  await new Promise(resolve => setTimeout(resolve, 100));
  stdin.end();
  assert.deepEqual(await running, { closed: true });
  assert.equal(failures, 2);
});

test('GivenTruncatedNativeInput_WhenEofArrives_ReportsIncompleteFrame', async () => {
  const { runNativeHost } = await import(moduleUrl);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = runNativeHost({ stdin, stdout, config, processReader: reader });
  stdin.end(Buffer.from([1, 0]));
  await assert.rejects(running, error => error.code === 'NATIVE_FRAME_INCOMPLETE');
});

test('GivenNativeEntryDisappears_WhenHostRemains_ExactOrphanTransportStopsWithoutWaitingForBrowserEof', async () => {
  const { runNativeHost } = await import(moduleUrl);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let lost = false;
  const running = runNativeHost({
    stdin, stdout, config, identityPollMs: 10,
    processReader: async pid => lost && pid === runtime.parentPid ? undefined : reader(pid),
  });
  const outcome = running.then(() => 'closed', error => error.code);
  await new Promise(setImmediate);
  lost = true;
  const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('still-orphaned'), 100))]);
  stdin.end();
  await outcome;
  assert.equal(result, 'NATIVE_ANCESTRY_INVALID');
  assert.equal(stdin.destroyed, true, 'fatal orphan transport must release its own input pipe, not leave a paused live handle');
});
