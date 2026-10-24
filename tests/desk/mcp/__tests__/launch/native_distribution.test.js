import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkTempRoot } from '../_temp_roots.js';
import { verifyNativeDistribution } from '../../../../../plugins/desk/mcp/native-messaging-install.mjs';
import { computeSourceDigest } from '../../../../../plugins/desk/browser-extension/build.mjs';

const plugin = fileURLToPath(new URL('../../../../../plugins/desk/', import.meta.url));
const closure = [
  'package.json', 'native-host.mjs', 'native-bootstrap.mjs', 'web-native-messaging.cjs', 'web-native-private-path.cjs', 'web-real-profile.cjs', 'web-extension-credential.cjs',
  'src/browser/native-host.mjs', 'src/browser/native-transport.mjs', 'src/browser/native-provider.mjs', 'src/browser/native-owner-inventory.mjs',
  'src/browser/native-update-proof.mjs',
  'src/util/broker-error.mjs', 'src/util/private-state.mjs', 'src/util/broker-lock.mjs', 'src/util/agency-session.cjs',
  'src/factory/os-protect.js', 'src/factory/windows-acl.js', 'src/factory/plugin-sources.cjs', 'src/readiness/process-start.js',
].map(name => `mcp/${name}`).concat([
  'browser-context-broker/src/primitives/broker-error.mjs',
  'browser-context-broker/src/primitives/private-state.mjs',
  'browser-context-broker/src/primitives/broker-lock.mjs',
]);
async function fixture(t) {
  const root = await mkTempRoot('desk-native-D-distribution-');
  t.diagnostic(`D exact distribution fixture=${root}`);
  const files = ['plugin.json', ...closure];
  for (const name of files) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.copyFile(path.join(plugin, name), path.join(root, name));
  }
  for (const directory of ['browser-extension', 'mcp/native/browser-messaging', 'mcp/artifacts/browser-messaging'])
    await fs.cp(path.join(plugin, directory), path.join(root, directory), { recursive: true });
  return root;
}

test('native distribution has exactly the real B/C closure, normal package boundary and independent current execution digest', async () => {
  const result = await verifyNativeDistribution(plugin);
  assert.deepEqual([...result.sources.keys()].sort(), [...closure].sort());
  assert.equal(result.extensionSourceDigest, computeSourceDigest(path.join(plugin, 'browser-extension')));
  const manifest = JSON.parse(await fs.readFile(path.join(plugin, 'browser-extension/manifest.json'), 'utf8'));
  const want = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/gu, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  assert.equal(result.extensionId, want);
  assert.match(result.extensionId, /^[a-p]{32}$/u);
  assert.equal(JSON.parse(result.sources.get('mcp/package.json')).type, 'module');
  for (const name of result.sources.keys()) assert.doesNotMatch(name, /\/(?:claims|registry|leases)\.mjs$|node_modules/u);
  const provenance = JSON.parse(result.artifactManifest).provenance;
  assert.match(provenance.goLicense, /Redistribution.*source and binary/su);
  assert.equal(provenance.predecessor, '60adac5ff6f14fbef6e371fa2983f84e0f7eba9f');
});

for (const change of ['missing-import', 'missing-module', 'missing-worker', 'extra-executable', 'generated-digest', 'source-link', 'manifest-key',
  'shared-missing', 'shared-link', 'shared-import']) {
  test(`native distribution refuses ${change} rather than shipping incomplete/stale source`, async t => {
    const root = await fixture(t);
    if (change === 'missing-import') await fs.appendFile(path.join(root, 'mcp/native-host.mjs'), '\nimport "./not-shipped.mjs";\n');
    if (change === 'missing-module') await fs.rename(path.join(root, 'mcp/src/browser/native-provider.mjs'), path.join(root, 'mcp/src/browser/owned-away.mjs'));
    if (change === 'missing-worker') await fs.rename(path.join(root, 'mcp/web-native-private-path.cjs'), path.join(root, 'mcp/owned-worker-away.cjs'));
    if (change === 'extra-executable') await fs.writeFile(path.join(root, 'browser-extension/unverified.mjs'), 'throw Error("not shipped");');
    if (change === 'generated-digest') await fs.writeFile(path.join(root, 'browser-extension/source-digest.mjs'), 'export const SOURCE_DIGEST = "' + '0'.repeat(64) + '";\n');
    if (change === 'source-link') {
      const source = path.join(root, 'mcp/src/browser/native-provider.mjs');
      await fs.rename(source, `${source}.owned-away`);
      await fs.symlink(`${source}.owned-away`, source);
    }
    const shared = path.join(root, 'browser-context-broker/src/primitives/broker-error.mjs');
    if (change === 'shared-missing' || change === 'shared-link') {
      await fs.rename(shared, `${shared}.owned-away`);
      if (change === 'shared-link') await fs.symlink(`${shared}.owned-away`, shared);
    }
    if (change === 'shared-import') await fs.appendFile(shared, '\nimport "../../../../outside-capsule.mjs";\n');
    if (change === 'manifest-key') {
      const file = path.join(root, 'browser-extension/manifest.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8')); manifest.key = 'invalid';
      await fs.writeFile(file, JSON.stringify(manifest));
    }
    const expected = ['missing-import', 'shared-import'].includes(change) ? 'NATIVE_CAPSULE_DEPENDENCY_MISSING'
      : ['missing-module', 'missing-worker', 'source-link', 'shared-missing', 'shared-link'].includes(change) ? 'NATIVE_DISTRIBUTION_INCOMPLETE' : 'NATIVE_EXTENSION_SOURCE_INVALID';
    await assert.rejects(verifyNativeDistribution(root), { code: expected });
  });

  test('shared canonical primitive bytes are included in native distribution integrity', async t => {
    const root = await fixture(t), before = await verifyNativeDistribution(root);
    await fs.appendFile(path.join(root, 'browser-context-broker/src/primitives/broker-error.mjs'), '\n// owned source integrity fixture\n');
    const after = await verifyNativeDistribution(root);
    assert.equal(after.extensionSourceDigest, before.extensionSourceDigest);
    assert.notEqual(after.distributionDigest, before.distributionDigest);
  });
}

test('license/provenance affect distribution integrity, never the six-file executed digest', async t => {
  const root = await fixture(t), before = await verifyNativeDistribution(root);
  await fs.appendFile(path.join(root, 'browser-extension/vendor/PROVENANCE.md'), '\nOwned distribution-only attribution fixture.\n');
  const after = await verifyNativeDistribution(root);
  assert.equal(after.extensionSourceDigest, before.extensionSourceDigest);
  assert.notEqual(after.distributionDigest, before.distributionDigest);
});

test('readonly worker source changes invalidate the exact native distribution digest', async t => {
  const root = await fixture(t), before = await verifyNativeDistribution(root);
  await fs.appendFile(path.join(root, 'mcp/web-native-private-path.cjs'), '\n// owned worker source drift\n');
  const after = await verifyNativeDistribution(root);
  assert.notEqual(after.distributionDigest, before.distributionDigest);
  assert.equal(after.extensionSourceDigest, before.extensionSourceDigest);
});

// Antivirus removed the Windows helper from an installed Mac plugin, and setup
// on the Mac then refused because it required every platform's helper.
const host = `${process.platform}-${process.arch}`;
const other = host === 'win32-x64' ? 'linux-x64' : 'win32-x64';
const otherName = other === 'win32-x64' ? 'Windows (x64)' : 'Linux (x64)';
const helper = target => `mcp/artifacts/browser-messaging/${target}/desk-browser-messaging${target.startsWith('win32-') ? '.exe' : ''}`;

test('setup check accepts a missing helper for another platform and says plainly what will not work', async t => {
  const root = await fixture(t), complete = await verifyNativeDistribution(root);
  assert.deepEqual(complete.missingHelpers, []);
  assert.equal(complete.notice, null);
  await fs.rename(path.join(root, helper(other)), path.join(root, `${helper(other)}.owned-away`));
  const result = await verifyNativeDistribution(root);
  assert.deepEqual(result.missingHelpers, [{ target: other, name: otherName, file: helper(other) }]);
  assert.equal(result.distributionDigest, complete.distributionDigest);
  assert.match(result.notice, new RegExp(`browser helper for ${otherName.replace(/[()]/gu, '\\$&')} is missing`, 'u'));
  assert.ok(result.notice.includes(helper(other)));
  assert.match(result.notice, /until Desk is reinstalled there/u);
  assert.doesNotMatch(result.notice, /NATIVE_|integrity/u);
});

for (const change of ['host-missing', 'host-bytes', 'other-bytes']) {
  test(`setup check refuses ${change} with a plain explanation`, async t => {
    const root = await fixture(t), target = change.startsWith('host') ? host : other;
    if (change === 'host-missing') await fs.rename(path.join(root, helper(target)), path.join(root, `${helper(target)}.owned-away`));
    else await fs.appendFile(path.join(root, helper(target)), 'changed helper bytes');
    const error = await verifyNativeDistribution(root).then(() => assert.fail('setup must refuse'), error => error);
    assert.equal(error.code, 'NATIVE_DISTRIBUTION_INCOMPLETE');
    assert.ok(error.message.includes(helper(target)), error.message);
    assert.match(error.message, change.startsWith('host') ? /for this computer, .* is missing or does not match/u : /does not match this Desk release/u);
    assert.match(error.message, /Reinstall Desk/u);
    // This computer's own helper can be removed again by antivirus after a reinstall; say where to look.
    const antivirus = /If the file goes missing again after reinstalling, security or antivirus software such as Microsoft Defender may be removing it; check that software's quarantine or history\./u;
    if (change.startsWith('host')) assert.match(error.message, antivirus);
    else assert.doesNotMatch(error.message, antivirus);
    assert.doesNotMatch(error.message, /NATIVE_|integrity|\(\w+ \(/u);
  });
}

test('setup check explains a changed helper list without naming one platform', async t => {
  const root = await fixture(t), file = path.join(root, 'mcp/artifacts/browser-messaging/manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')); manifest.goVersion = '1.27.0';
  await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(verifyNativeDistribution(root), { code: 'NATIVE_DISTRIBUTION_INCOMPLETE',
    message: /browser helper files do not match this Desk release.*Reinstall Desk/u });
});

test('setup check names every missing helper for other platforms in one notice', async t => {
  const root = await fixture(t), targets = ['linux-arm', 'win32-ia32'].filter(target => target !== host);
  for (const target of targets) await fs.rename(path.join(root, helper(target)), path.join(root, `${helper(target)}.owned-away`));
  const result = await verifyNativeDistribution(root);
  assert.deepEqual(result.missingHelpers.map(entry => entry.target), targets);
  assert.match(result.notice, /helpers for Linux \(32-bit ARM\) and Windows \(32-bit\) are missing/u);
  assert.match(result.notice, /may have removed them/u);
});
