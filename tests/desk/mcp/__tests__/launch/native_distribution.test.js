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
  'package.json', 'native-host.mjs', 'web-native-messaging.cjs', 'web-native-private-path.cjs', 'web-real-profile.cjs', 'web-extension-credential.cjs',
  'src/browser/native-host.mjs', 'src/browser/native-transport.mjs', 'src/browser/native-provider.mjs', 'src/browser/native-owner-inventory.mjs',
  'src/util/broker-error.mjs', 'src/util/private-state.mjs', 'src/util/broker-lock.mjs',
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
  for (const name of result.sources.keys()) assert.doesNotMatch(name, /\/(?:claims|registry|leases)\.mjs$|node_modules|native-update-proof/u);
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
