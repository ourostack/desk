import '../_isolated_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mcpRoot } from './_mcp_handshake.js';
import { mkTempRoot } from '../_temp_roots.js';
import { removeTree } from '../_remove_tree.js';
import { protectWindowsPaths } from '../../../../../plugins/desk/mcp/src/factory/windows-acl.js';

const require = createRequire(import.meta.url);
// A selected canonical collector is initialized by the ordinary module import.
// VM execution below shares it; no coverage global or counter is synthesized.
require(path.join(mcpRoot, 'browser-context.cjs'));
const native = require(path.join(mcpRoot, 'web-native-messaging.cjs'));
const profile = require(path.join(mcpRoot, 'web-real-profile.cjs'));
const discovery = require(path.join(mcpRoot, 'web-browser-discovery.cjs'));
const distribution = await import(pathToFileURL(path.join(mcpRoot, 'native-messaging-install.mjs')).href);
const { loadTemplate } = require('./fixtures/native-template-loader.cjs');

// Controller unit resource model, NOT enrollment or installed/native proof.
// The unchanged installer/distribution verifier and C attest boundary are
// independently exercised by their integration suites. No browser is launched.
async function fixture(t, options = {}) {
  const root = await mkTempRoot('desk-normal-controller-');
  t.after(() => removeTree(root));
  const home = path.join(root, 'home'), stateRoot = path.join(root, 'browser');
  const plugin = path.join(root, 'plugin');
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'native-local'), APPDATA: path.join(home, 'native-roaming'),
    ProgramFiles: path.join(root, 'program-files'), 'ProgramFiles(x86)': path.join(root, 'program-files-x86'),
    DESK_PLUGIN_ROOT: plugin, DESK_BROWSER_STATE_DIR: stateRoot };
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  };
  put(path.join(plugin, 'plugin.json'), { name: 'owned-bootstrap', desk: {
    browser: { channel: 'msedge', profileAccountDomain: 'example.test' } } });
  const userDataDir = profile.userDataDir('msedge', process.platform, env, home);
  put(path.join(userDataDir, 'Local State'), { profile: {
    info_cache: { Default: { user_name: 'owner@example.test' } } } });
  const app = path.join(root, 'observed-browser');
  put(app, 'Owned inert executable observation. Never executed.');
  const installed = { dir: path.join(stateRoot, 'installs', 'owned-normal'), version: 'owned-normal', core: null };
  const lib = path.join(installed.dir, 'node_modules/playwright-core/lib');
  const input = require('./fixtures/playwright-native-error-transport.cjs').read();
  put(path.join(lib, 'coreBundle.js'), fs.readFileSync(new URL('./fixtures/playwright-server-lifecycle.cjs', import.meta.url), 'utf8') + input.core);
  put(path.join(lib, 'tools/cli-client/session.js'), input.sessionSource);
  require(path.join(mcpRoot, 'web-playwright-patch.cjs')).apply(installed);
  const verified = await distribution.verifyNativeDistribution(path.dirname(mcpRoot));
  const readyFile = path.join(stateRoot, 'native-owned/state/native-provider-' +
    createHash('sha256').update(app + '\0' + path.join(userDataDir, 'Default')).digest('hex') + '.json');
  const seen = { setup: [], attest: [], execute: 0, privateArgs: [] };
  const writeReady = async (extra = {}) => {
    put(readyFile, { profileRoot: path.join(userDataDir, 'Default'),
      extensionId: verified.extensionId, sourceDigest: verified.extensionSourceDigest,
      browser: { executable: app }, ...extra });
    if (process.platform === 'win32') await protectWindowsPaths([
      ...[stateRoot, path.join(stateRoot, 'native-owned'), path.dirname(readyFile)]
        .map(path => ({ path, kind: 'directory', created: true })),
      { path: readyFile, kind: 'file', created: true },
    ]);
  };
  if (options.ready) await writeReady(options.ready === true ? {} : options.ready);
  const candidates = discovery.browserPaths('msedge', process.platform, env);
  const observedFs = Object.create(fs);
  observedFs.statSync = (file, ...args) => candidates.includes(String(file)) ? fs.statSync(app, ...args) : fs.statSync(file, ...args);
  observedFs.realpathSync = (file, ...args) => candidates.includes(String(file)) ? fs.realpathSync(app, ...args) : fs.realpathSync(file, ...args);
  const observedNative = { ...native, async attestNativeContext(record, selection) {
    seen.attest.push({ record, selection });
    assert.equal(fs.existsSync(path.join(stateRoot, 'signed-in')), false,
      'C admission must precede owner-directory allocation');
    if (options.attestError) throw Object.assign(Error(options.attestError), { code: options.attestError });
    return Object.freeze({ contextId: record.contextId });
  } };
  const module = { exports: {} };
  const controller = loadTemplate(path.join(mcpRoot, 'browser-context.cjs'), {
    module, __dirname: mcpRoot, process, Buffer,
    require: name => name === 'fs' ? observedFs : name === 'os' ?
      { ...os, userInfo: () => ({ ...os.userInfo(), homedir: home }) } :
      name === './web-native-messaging.cjs' ? observedNative :
      name === './browser-private.cjs' && options.privateRun ?
        { run: async args => { seen.privateArgs.push(args); return { exitCode: 0, payload: { state: 'private-resource-result' } }; } } :
      require(name.startsWith('.') ? path.join(mcpRoot, name) : name),
    Function: function (...args) {
      if (args.length !== 2 || args[0] !== 'url' || args[1] !== 'return import(url)')
        return Function(...args);
      return async url => {
        if (url === pathToFileURL(path.join(mcpRoot, 'native-messaging-install.mjs')).href)
          return { verifyNativeDistribution: distribution.verifyNativeDistribution,
            async installNativeMessagingBootstrap(input) {
              seen.setup.push(input);
              assert.equal(fs.existsSync(path.join(stateRoot, 'signed-in')), false);
              if (options.setupError) throw Object.assign(Error(options.setupError), { code: options.setupError });
              if (options.publishReady) await writeReady();
              if (options.malformedAfterSetup) fs.writeFileSync(readyFile, '{');
              return { nativeReadyFile: readyFile, browserStateRoot: stateRoot,
                extensionId: verified.extensionId, extensionSourceDigest: verified.extensionSourceDigest,
                continuity: 'unknown' };
            } };
        return import(url);
      };
    },
  });
  const executionOptions = {
    env, prepareBrowserRuntime: async () => ({ nodePath: process.execPath, installed, stateRoot }),
    execute: async () => { ++seen.execute; return { state: 'running' }; },
  };
  const result = options.argv ? await controller.run(options.argv, executionOptions) :
    await controller.context(options.input || { action: 'create', label: 'Owned normal setup' }, executionOptions);
  if (result.payload.contextResources?.socketDirectory)
    t.after(() => removeTree(result.payload.contextResources.socketDirectory));
  return { result, seen, stateRoot, env, home };
}

test('normal signed-in controller invokes PID-free setup on missing readiness without claiming enrollment', async t => {
  const f = await fixture(t);
  assert.equal(f.seen.setup.length, 1);
  assert.deepEqual(Object.keys(f.seen.setup[0]).sort(), ['env', 'homeDir']);
  assert.equal(f.seen.setup[0].env, f.env);
  assert.equal(f.seen.setup[0].homeDir, f.home);
  assert.equal(f.result.payload.code, 'NATIVE_READY_UNAVAILABLE');
  assert.equal(f.result.exitCode, 1);
  assert.equal(f.seen.execute, 0);
  assert.equal(fs.existsSync(path.join(f.stateRoot, 'signed-in')), false);
});

test('normal setup can proceed only after readiness and C admission, preserving the strict owner record', async t => {
  const f = await fixture(t, { publishReady: true });
  assert.equal(f.result.exitCode, 0, JSON.stringify(f.result.payload));
  assert.equal(f.seen.setup.length, 1);
  assert.equal(f.seen.attest.length, 1);
  assert.equal(f.seen.execute, 1);
  const config = native.readPrivateJson(f.result.payload.contextResources.configFile);
  native.validateNativeRecord(config.deskNativeContext);
  assert.equal(config.deskNativeContext.contextId, f.result.payload.contextId);
});

test('qualified existing readiness preserves the no-installer healthy fast path', async t => {
  const f = await fixture(t, { ready: true });
  assert.equal(f.result.exitCode, 0, JSON.stringify(f.result.payload));
  assert.equal(f.seen.setup.length, 0);
  assert.equal(f.seen.attest.length, 1);
  assert.equal(f.seen.execute, 1);
});

test('normal setup retains the actual classified registration refusal without allocating an owner', async t => {
  const f = await fixture(t, { setupError: 'NATIVE_REGISTRATION_CONFLICT' });
  assert.equal(f.result.payload.code, 'NATIVE_REGISTRATION_CONFLICT');
  assert.equal(f.seen.execute, 0);
  assert.equal(fs.existsSync(path.join(f.stateRoot, 'signed-in')), false);
});

test('a present mismatched source never invokes automatic setup or allocates an owner', async t => {
  const f = await fixture(t, { ready: { sourceDigest: '0'.repeat(64) } });
  assert.equal(f.result.payload.code, 'NATIVE_READY_INVALID');
  assert.equal(f.seen.setup.length, 0);
  assert.equal(f.seen.execute, 0);
  assert.equal(fs.existsSync(path.join(f.stateRoot, 'signed-in')), false);
});

for (const ready of [false, true]) test(`C refuses unhealthy ${ready ? 'existing' : 'new'} readiness before owner allocation`, async t => {
  const f = await fixture(t, { ready, publishReady: true, attestError: 'NATIVE_ATTESTATION_MISMATCH' });
  assert.equal(f.result.payload.code, 'NATIVE_ATTESTATION_MISMATCH');
  assert.equal(f.seen.execute, 0);
  assert.equal(fs.existsSync(path.join(f.stateRoot, 'signed-in')), false);
});

for (const action of ['keep', 'resume', 'discard']) test(`${action} never installs after retained readiness is missing`, async t => {
  const f = await fixture(t, { input: { action, contextId: '11111111-1111-4111-8111-111111111111' } });
  assert.equal(f.result.payload.code, 'NATIVE_READY_UNAVAILABLE');
  assert.equal(f.seen.setup.length, 0);
  assert.equal(f.seen.attest.length, 0);
  assert.equal(f.seen.execute, 0);
  assert.equal(fs.existsSync(path.join(f.stateRoot, 'signed-in')), false);
});

test('malformed readiness published during setup is retained and never treated as missing enrollment', async t => {
  const f = await fixture(t, { publishReady: true, malformedAfterSetup: true });
  assert.equal(f.result.payload.code, 'NATIVE_PRIVATE_STATE_INVALID');
  assert.equal(f.seen.setup.length, 1);
  assert.equal(f.seen.attest.length, 0);
  assert.equal(f.seen.execute, 0);
  assert.equal(fs.existsSync(path.join(f.stateRoot, 'signed-in')), false);
});

test('valid private create and page/action CLI forms retain exact facade delegation', async t => {
  const id = 'private-11111111-1111-4111-8111-111111111111';
  for (const [argv, expected] of [
    [['create', '--mode', 'private'], ['create']],
    [['run', id, '--', 'snapshot'], ['run', id, '--', 'snapshot']],
    [['keep', id], ['keep', id]],
  ]) {
    const f = await fixture(t, { argv, privateRun: true });
    assert.equal(f.result.exitCode, 0);
    assert.equal(f.result.payload.state, 'private-resource-result');
    assert.deepEqual(Array.from(f.seen.privateArgs[0]), expected);
    assert.equal(f.seen.setup.length, 0);
    assert.equal(f.seen.attest.length, 0);
  }
});
