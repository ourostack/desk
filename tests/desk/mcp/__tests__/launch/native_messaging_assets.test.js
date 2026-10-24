import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkTempRoot } from '../_temp_roots.js';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const mcp = path.join(repository, 'plugins/desk/mcp');
const sourceFiles = ['go.mod', 'main.go', 'private_unix.go', 'private_windows.go'];

// Break caught: the normal release gate used to ignore the whole native family.
// Refuse a missing *production source*, not a missing test import/dependency.
test('normal generated gate refuses missing browser-messaging production source', async t => {
  const gate = require(path.join(repository, 'scripts/test-desk-generated-artifacts.cjs'));
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function (file, ...args) {
    if (file === path.join(mcp, 'native/browser-messaging/main.go'))
      throw Object.assign(Error('owned missing-source fixture'), { code: 'ENOENT' });
    return original.call(this, file, ...args);
  });
  const result = await gate.verifyGeneratedArtifacts({ io: { stdout: { write() {} }, stderr: { write() {} } } });
  assert.equal(result.ok, false, 'a missing native production input must fail the actual generated-artifact gate');
  assert.ok(result.errors.some(error => /browser.messag|browser_native/iu.test(error)));
});

async function familyFixture(t) {
  const root = await mkTempRoot('desk-native-D-assets-');
  t.diagnostic(`D asset fixture=${root}`);
  for (const directory of ['native/browser-messaging', 'artifacts/browser-messaging'])
    fs.cpSync(path.join(mcp, directory), path.join(root, directory), { recursive: true });
  return { root, family: require(path.join(mcp, 'web-native-artifacts.cjs')).artifactFamily('browser-messaging', sourceFiles) };
}

for (const change of ['byte', 'source', 'source-hash', 'missing-target', 'extra-target', 'compiler', 'missing-file', 'symlink']) {
  test(`native asset verifier refuses ${change} independently`, async t => {
    const { root, family } = await familyFixture(t);
    const manifestFile = path.join(root, 'artifacts/browser-messaging/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const asset = path.join(root, 'artifacts/browser-messaging/linux-x64/desk-browser-messaging');
    if (change === 'byte') fs.appendFileSync(asset, 'changed');
    if (change === 'source') fs.appendFileSync(path.join(root, 'native/browser-messaging/main.go'), '// changed\n');
    if (change === 'source-hash') manifest.sourceSha256 = '0'.repeat(64);
    if (change === 'missing-target') delete manifest.assets['linux-arm'];
    if (change === 'extra-target') manifest.assets['linux-ia32'] = manifest.assets['linux-x64'];
    if (change === 'compiler') manifest.goVersion = '1.27.0';
    if (change === 'missing-file') fs.renameSync(asset, `${asset}.owned-away`);
    if (change === 'symlink') {
      fs.renameSync(asset, `${asset}.owned-away`);
      fs.symlinkSync(`${asset}.owned-away`, asset);
    }

    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => family.verifyAssets(root), /browser_native_messaging_integrity/u);
  });
}

for (const name of ['unhashed.go', 'unhashed.syso']) {
  test(`native source verifier refuses unhashed compiler input ${name}`, async t => {
    const { root, family } = await familyFixture(t);
    fs.writeFileSync(path.join(root, 'native/browser-messaging', name), name.endsWith('.go') ? 'package main\nfunc init() {}\n' : 'owned object fixture');
    assert.throws(() => family.verifyAssets(root), /browser_native_messaging_integrity/u);
  });
}

test('native artifact source hash excludes tests, not extra production inputs', async t => {
  const { root, family } = await familyFixture(t);
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/browser-messaging/manifest.json'), 'utf8')).sourceSha256;
  fs.appendFileSync(path.join(root, 'native/browser-messaging/main_test.go'), '\n// owned test-only hash exclusion fixture\n');
  assert.equal(family.sourceHash(root), expected);
  assert.equal(family.verifyAssets(root).targets.length, 8);
});

test('verify-only never invokes compiler/acquisition, and unsupported targets refuse', async t => {
  const { root, family } = await familyFixture(t);
  const builder = require(path.join(mcp, 'scripts/build-browser-messaging-assets.cjs'));
  let message = '';
  builder.run(['--verify'], { root, spawn() { assert.fail('verify-only must not spawn'); },
    stdout: { write(value) { message += value; } } });
  assert.match(message, /eight targets/u);
  assert.throws(() => family.selectAsset(root, 'linux', 'ia32'), /unsupported/u);
  assert.throws(() => builder.run(['--unknown'], { root }), /Usage/u);
});

test('build pins compiler, every target and deterministic flags without hidden launch-family imports', async t => {
  const root = await mkTempRoot('desk-native-D-build-');
  fs.cpSync(path.join(mcp, 'native/browser-messaging'), path.join(root, 'native/browser-messaging'), { recursive: true });
  const { run } = require(path.join(mcp, 'scripts/build-browser-messaging-assets.cjs'));
  assert.throws(() => run([], { root, spawn: () => ({ status: 0, stdout: 'go version go1.27.0 linux/amd64\n' }) }), /Go 1.27.1/u);
  let count = 0;
  run([], { root, stdout: { write() {} }, spawn(command, args, options) {
    assert.equal(command, 'go');
    assert.equal(options.env.GOTOOLCHAIN, 'local');
    if (args[0] === 'version') return { status: 0, stdout: 'go version go1.27.1 linux/amd64\n' };
    ++count;
    assert.deepEqual(args.slice(0, 4), ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=']);
    assert.equal(options.env.CGO_ENABLED, '0');
    assert.equal(options.env.GOARM, '7');
    const file = args[args.indexOf('-o') + 1];
    fs.writeFileSync(file, `${options.env.GOOS}/${options.env.GOARCH}`);
    return { status: 0 };
  } });
  assert.equal(count, 8);
  const family = require(path.join(mcp, 'web-native-artifacts.cjs')).artifactFamily('browser-messaging', sourceFiles);
  assert.equal(family.verifyAssets(root).targets.length, 8);
  // These are compiler-boundary fixture bytes, never shipped/released assets.
});

for (const link of ['output-directory', 'manifest']) {
  test(`native builder preserves foreign ${link} symlink before publication`, async t => {
    const root = await mkTempRoot('desk-native-D-link-');
    fs.cpSync(path.join(mcp, 'native/browser-messaging'), path.join(root, 'native/browser-messaging'), { recursive: true });
    const outside = path.join(root, 'owned-foreign');
    fs.mkdirSync(outside);
    if (link === 'output-directory') fs.symlinkSync(outside, path.join(root, 'artifacts'), 'junction');
    else {
      fs.mkdirSync(path.join(root, 'artifacts/browser-messaging'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'foreign-manifest'), path.join(root, 'artifacts/browser-messaging/manifest.json'));
    }
    const { run } = require(path.join(mcp, 'scripts/build-browser-messaging-assets.cjs'));
    assert.throws(() => run([], { root, stdout: { write() {} }, spawn(command, args) {
      if (args[0] === 'version') return { status: 0, stdout: 'go version go1.27.1 linux/amd64\n' };
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'owned compiler fixture');
      return { status: 0 };
    } }), /browser_native_messaging_integrity/u);
    assert.deepEqual(fs.readdirSync(outside), [], 'no foreign directory or dangling-link destination was written');
  });
}

// Only on-device setup tolerates another platform's missing helper. The
// release and packaging checks must still refuse any missing helper.
const windowsHelper = 'artifacts/browser-messaging/win32-x64/desk-browser-messaging.exe';
test('release verify-only check still refuses a missing Windows helper', async t => {
  const { root } = await familyFixture(t);
  fs.renameSync(path.join(root, windowsHelper), path.join(root, `${windowsHelper}.owned-away`));
  const builder = require(path.join(mcp, 'scripts/build-browser-messaging-assets.cjs'));
  assert.throws(() => builder.run(['--verify'], { root, stdout: { write() {} } }), /browser_native_messaging_integrity/u);
});

test('generated-artifact gate still refuses a missing Windows helper', async t => {
  const gate = require(path.join(repository, 'scripts/test-desk-generated-artifacts.cjs'));
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function (file, ...args) {
    if (path.resolve(String(file)) === path.join(mcp, windowsHelper))
      throw Object.assign(Error('owned missing-helper fixture'), { code: 'ENOENT' });
    return original.call(this, file, ...args);
  });
  const result = await gate.verifyGeneratedArtifacts({ io: { stdout: { write() {} }, stderr: { write() {} } } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('browser-messaging native source/asset integrity verification failed'), result.errors.join('\n'));
});
