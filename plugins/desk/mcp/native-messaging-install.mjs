// Protected immutable capsule/registration mechanics adapted from ourostack/desk
// 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f. Installation integrity only:
// no update, reload, historical baseline, activation or recovery authority.
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { createHash, randomUUID, createPublicKey } from 'node:crypto';
import { isBuiltin, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertOutsideGitWorkspace, ensureOwnerOnlyDirectory, protectLeafFile } from './src/factory/os-protect.js';
import { protectWindowsPaths } from './src/factory/windows-acl.js';
import { windowsPowerShellPath } from './src/readiness/process-start.js';

const require = createRequire(import.meta.url);
const ownMcp = fileURLToPath(new URL('./', import.meta.url));
const ownPlugin = path.dirname(path.resolve(ownMcp));
const HOST = 'com.ourostack.desk.browser';
const naming = { label: 'desk_native_browser', subject: 'native browser capsule' };
const GO_SOURCES = ['go.mod', 'main.go', 'private_unix.go', 'private_windows.go'];
const EXECUTION_FILES = ['background.mjs', 'context-engine.mjs', 'manifest.json', 'token.html', 'token.mjs', 'vendor/maintained.mjs'];
const EXTENSION_FILES = [...EXECUTION_FILES, 'source-digest.mjs', 'build.mjs', 'README.md', 'vendor/LICENSE', 'vendor/PROVENANCE.md'].sort();
const CAPSULE_FILES = [
  'package.json', 'native-host.mjs', 'web-native-messaging.cjs', 'web-native-private-path.cjs', 'web-real-profile.cjs', 'web-extension-credential.cjs',
  'src/browser/native-host.mjs', 'src/browser/native-transport.mjs', 'src/browser/native-provider.mjs', 'src/browser/native-owner-inventory.mjs',
  'src/browser/native-update-proof.mjs',
  'src/util/broker-error.mjs', 'src/util/private-state.mjs', 'src/util/broker-lock.mjs',
  'src/factory/os-protect.js', 'src/factory/windows-acl.js', 'src/factory/plugin-sources.cjs', 'src/readiness/process-start.js',
].map(name => `mcp/${name}`).concat([
  'browser-context-broker/src/primitives/broker-error.mjs',
  'browser-context-broker/src/primitives/private-state.mjs',
  'browser-context-broker/src/primitives/broker-lock.mjs',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failure = code => Object.assign(new Error(code), { code });
const fileAt = (root, relative) => path.join(root, ...relative.split('/'));

async function present(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw failure('NATIVE_PATH_UNAVAILABLE'); }
}
function sourceBytes(root, relative) {
  if (sync.realpathSync(root) !== path.resolve(root) || !sync.lstatSync(root).isDirectory()) throw failure('NATIVE_DISTRIBUTION_INCOMPLETE');
  const file = fileAt(root, relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = sync.lstatSync(current);
    if (info.isSymbolicLink() || (current === file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()))
      throw failure('NATIVE_DISTRIBUTION_INCOMPLETE');
  }
  const before = sync.lstatSync(file, { bigint: true });
  if (before.size > 4_194_304n) throw failure('NATIVE_DISTRIBUTION_INCOMPLETE');
  const bytes = sync.readFileSync(file);
  const after = sync.lstatSync(file, { bigint: true });
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key]) || after.size !== BigInt(bytes.length))
    throw failure('NATIVE_DISTRIBUTION_CHANGED');
  return bytes;
}
async function regularFiles(directory, relative = '') {
  const result = [];
  for (const item of await fs.readdir(fileAt(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...await regularFiles(directory, name));
    else if (item.isFile()) result.push(name);
    else throw failure('NATIVE_PATH_INVALID');
  }
  return result.sort();
}
function inventoryDigest(entries) {
  return hash(JSON.stringify([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => [name, hash(bytes)])));
}

// Read-only inventory of a complete normal plugin distribution. A server source
// mirror is not this distribution. Never execute code selected by this argument.
export async function verifyNativeDistribution(pluginRoot = ownPlugin) {
  try {
    if (!path.isAbsolute(pluginRoot) || sync.realpathSync(pluginRoot) !== path.resolve(pluginRoot)) throw Error();
    const mcpRoot = path.join(pluginRoot, 'mcp');
    const plugin = JSON.parse(sourceBytes(pluginRoot, 'plugin.json'));
    const pkg = JSON.parse(sourceBytes(mcpRoot, 'package.json'));
    if (plugin.name !== 'desk' || typeof plugin.version !== 'string' || pkg.name !== '@ourostack/desk-mcp' || pkg.type !== 'module') throw Error();
    const native = require('./web-native-artifacts.cjs').artifactFamily('browser-messaging', GO_SOURCES);
    native.verifyAssets(mcpRoot);
    const sources = new Map(CAPSULE_FILES.map(name => [name, sourceBytes(pluginRoot, name)]));
    for (const [name, bytes] of sources) {
      if (!/\.(?:mjs|cjs|js)$/u.test(name)) continue;
      for (const [, specifier] of bytes.toString('utf8').matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]+)['"]/gu)) {
        if (specifier.startsWith('.')) {
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
          if (!sources.has(resolved)) throw failure('NATIVE_CAPSULE_DEPENDENCY_MISSING');
        } else if (!isBuiltin(specifier)) throw failure('NATIVE_CAPSULE_DEPENDENCY_MISSING');
      }
    }
    const extensionRoot = path.join(pluginRoot, 'browser-extension');
    if (!same(await regularFiles(extensionRoot), EXTENSION_FILES)) throw failure('NATIVE_EXTENSION_SOURCE_INVALID');
    const extension = new Map(EXTENSION_FILES.map(name => [name, sourceBytes(extensionRoot, name)]));
    const digest = createHash('sha256');
    for (const name of EXECUTION_FILES) {
      const bytes = extension.get(name);
      digest.update(`${name}\0${bytes.length}\0`); digest.update(bytes);
    }
    const extensionSourceDigest = digest.digest('hex');
    const generated = `// Generated by build.mjs; no profile or relay credentials.\nexport const SOURCE_DIGEST = "${extensionSourceDigest}";\n`;
    if (extension.get('source-digest.mjs').toString('utf8') !== generated) throw failure('NATIVE_EXTENSION_SOURCE_INVALID');
    const manifest = JSON.parse(extension.get('manifest.json'));
    const key = Buffer.from(manifest.key || '', 'base64');
    if (!key.length || key.toString('base64') !== manifest.key) throw failure('NATIVE_EXTENSION_SOURCE_INVALID');
    createPublicKey({ key, format: 'der', type: 'spki' });
    const extensionId = hash(key).slice(0, 32).replace(/[0-9a-f]/gu, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
    const artifactManifest = sourceBytes(mcpRoot, 'artifacts/browser-messaging/manifest.json');
    const distributionDigest = inventoryDigest(new Map([
      ...sources,
      ...[...extension].map(([name, bytes]) => [`extension/${name}`, bytes]), ['artifact-manifest.json', artifactManifest],
    ]));
    return { mcpRoot, sources, extension, artifactManifest, extensionId, extensionSourceDigest, distributionDigest, native };
  } catch (error) {
    if (['NATIVE_CAPSULE_DEPENDENCY_MISSING', 'NATIVE_EXTENSION_SOURCE_INVALID', 'NATIVE_DISTRIBUTION_CHANGED'].includes(error.code)) throw error;
    throw failure('NATIVE_DISTRIBUTION_INCOMPLETE');
  }
}

export function registrationLocation({ platform, channel, userDataRoot }) {
  if (!['msedge', 'chrome'].includes(channel) || typeof userDataRoot !== 'string' || !path.isAbsolute(userDataRoot))
    throw failure('NATIVE_REGISTRATION_INVALID');
  if (platform === 'win32') return { registryKey: `HKCU\\Software\\${channel === 'msedge' ? 'Microsoft\\Edge' : 'Google\\Chrome'}\\NativeMessagingHosts\\${HOST}` };
  if (!['darwin', 'linux'].includes(platform)) throw failure('NATIVE_REGISTRATION_INVALID');
  return { file: path.join(userDataRoot, 'NativeMessagingHosts', `${HOST}.json`) };
}
async function checkedPath(directory) {
  let current = path.resolve(directory);
  for (;;) {
    const info = await present(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw failure('NATIVE_PATH_INVALID');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function privateDirectory(directory, justCreated = false) {
  await checkedPath(directory);
  const info = await present(directory);
  if (!info && !await present(path.dirname(directory))) await privateDirectory(path.dirname(directory));
  if (info && process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077))) throw failure('NATIVE_PRIVATE_STATE_INVALID');
  const created = await ensureOwnerOnlyDirectory(directory, process.platform, naming) || justCreated;
  if (process.platform === 'win32') await protectWindowsPaths([{ path: directory, kind: 'directory', created }], { label: naming.label });
}
async function protectFile(file, executable = false) {
  await protectLeafFile(file, process.platform, naming);
  if (process.platform === 'win32') await protectWindowsPaths([{ path: file, kind: 'file', created: true }], { label: naming.label });
  else if (executable) await fs.chmod(file, 0o700);
}
async function checkPrivate(file, expected, executable = false, identity) {
  await checkedPath(path.dirname(file));
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      (identity && (before.dev !== identity.dev || before.ino !== identity.ino)) ||
      (process.platform !== 'win32' && (before.uid !== BigInt(process.getuid()) || Number(before.mode & 0o777n) !== (executable ? 0o700 : 0o600))))
    throw failure('NATIVE_RUNTIME_INTEGRITY');
  const bytes = await fs.readFile(file), after = await fs.lstat(file, { bigint: true });
  if (!bytes.equals(expected) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key]))
    throw failure('NATIVE_RUNTIME_INTEGRITY');
  if (process.platform === 'win32') await protectWindowsPaths([{ path: file, kind: 'file', created: false }], { label: naming.label });
}
async function writeNew(file, bytes) {
  await privateDirectory(path.dirname(file));
  const parent = sync.lstatSync(path.dirname(file), { bigint: true });
  const handle = await fs.open(file, 'wx', 0o600);
  let identity;
  try {
    identity = await handle.stat({ bigint: true }); // creation handle, never a later path observation
    await fs.writeFile(handle, bytes);
    await handle.sync();
  } finally { await handle.close(); }
  const current = sync.lstatSync(file, { bigint: true });
  if (current.dev !== identity.dev || current.ino !== identity.ino) throw failure('NATIVE_RUNTIME_INTEGRITY');
  await protectFile(file);
  await checkPrivate(file, bytes, false, identity);
  return { identity, parent };
}
function assertRegistrationStage(file, bytes, owned, links = 1n) {
  try {
    const parent = sync.lstatSync(path.dirname(file), { bigint: true });
    const current = sync.lstatSync(file, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
        parent.dev !== owned.parent.dev || parent.ino !== owned.parent.ino ||
        !current.isFile() || current.isSymbolicLink() || current.nlink !== links ||
        current.dev !== owned.identity.dev || current.ino !== owned.identity.ino ||
        (process.platform !== 'win32' && (parent.uid !== BigInt(process.getuid()) || (parent.mode & 0o077n) ||
          current.uid !== BigInt(process.getuid()) || (current.mode & 0o777n) !== 0o600n)) ||
        current.size !== BigInt(bytes.length) ||
        !(links === 1n ? sourceBytes(path.dirname(file), path.basename(file)) : sync.readFileSync(file)).equals(bytes)) throw Error();
    if (links === 1n) require('./web-native-messaging.cjs').readPrivateJson(file, { maxBytes: 16384 });
  } catch { throw failure('NATIVE_RUNTIME_INTEGRITY'); }
}
async function publishRegistration(file, bytes, assertPublication) {
  if (await present(file)) { await checkPrivate(file, bytes); assertPublication(); return; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const owned = await writeNew(temporary, bytes);
  // link is exclusive: unlike rename it cannot overwrite a racing replacement.
  assertPublication(); // synchronous final fence after every awaited staging step
  assertRegistrationStage(temporary, bytes, owned); // no await before exclusive publication
  await fs.link(temporary, file);
  assertRegistrationStage(temporary, bytes, owned, 2n); // no await before exact-name release
  await fs.unlink(temporary); // exact owned staging inode only, never a foreign replacement
  await checkPrivate(file, bytes);
}
async function registry(location, operation, assertPublication) {
  const key = location.registryKey.slice('HKCU\\'.length).replaceAll("'", "''"), manifest = location.file.replaceAll("'", "''");
  const script = operation === 'read'
    ? `# DESK_NATIVE_REGISTRY read\n$ErrorActionPreference='Stop';$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}');if($k){try{$v=$k.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($null -eq $v -or $k.ValueCount -ne 1 -or $k.SubKeyCount -ne 0 -or $k.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String){throw 'conflict'};[Console]::Write($v)}finally{$k.Close()}}`
    : `# DESK_NATIVE_REGISTRY write\n# MANIFEST ${JSON.stringify(location.file)}\n$ErrorActionPreference='Stop';$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}');try{if($k.ValueCount -ne 0 -or $k.SubKeyCount -ne 0){throw 'conflict'};$k.SetValue('','${manifest}',[Microsoft.Win32.RegistryValueKind]::String);$k.Flush()}finally{$k.Close()}`;
  try {
    if (operation === 'write') assertPublication();
    const result = await new Promise((resolve, reject) => childProcess.execFile(windowsPowerShellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 16384 },
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
    return result.stdout;
  } catch { throw failure('NATIVE_REGISTRATION_CONFLICT'); }
}

// Ephemeral publication fingerprints, using the same inode/change-time basis
// as the existing private/ACL helpers. Not a custody store or history proof.
function publicationFence({ runtimeDirectory, files, executable, assetBytes, extensionDirectory, distribution, stateDir, input }) {
  const entries = [
    ...[...files].map(([name, bytes]) => ({ base: runtimeDirectory, name, bytes })),
    { base: runtimeDirectory, name: path.basename(executable), bytes: assetBytes },
    ...[...distribution.extension].map(([name, bytes]) => ({ base: extensionDirectory, name, bytes })),
  ];
  const fingerprint = info => ['dev', 'ino', 'ctimeNs', 'mtimeNs', 'size', 'mode', 'uid', 'nlink'].map(key => String(info[key])).join(':');
  const directories = new Set();
  for (const entry of entries) {
    let directory = path.dirname(fileAt(entry.base, entry.name));
    for (;;) {
      directories.add(directory);
      if (directory === entry.base) break;
      directory = path.dirname(directory);
    }
  }
  const directoryPins = new Map([...directories].map(directory => [directory, fingerprint(sync.lstatSync(directory, { bigint: true }))]));
  const filePins = new Map(entries.map(entry => [fileAt(entry.base, entry.name), fingerprint(sync.lstatSync(fileAt(entry.base, entry.name), { bigint: true }))]));
  const client = require('./web-native-messaging.cjs');
  return () => {
    try {
      if (sync.readdirSync(stateDir).length) throw failure('NATIVE_INSTALL_UNRESOLVED');
      for (const [directory, pin] of directoryPins) {
        const current = sync.lstatSync(directory, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || fingerprint(current) !== pin) throw Error();
      }
      for (const entry of entries) {
        const file = fileAt(entry.base, entry.name);
        if (fingerprint(sync.lstatSync(file, { bigint: true })) !== filePins.get(file) ||
            !sourceBytes(entry.base, entry.name).equals(entry.bytes)) throw Error();
      }
      client.readPrivateJson(path.join(runtimeDirectory, 'native-host.json'), { maxBytes: 16384 });
      client.readPrivateJson(path.join(runtimeDirectory, 'mcp/provider-config.json'), { maxBytes: 16384 });
      if (!sourceBytes(input.browserStateRoot, 'current.json').equals(input.pointerBytes)) throw Error();
    } catch (error) {
      if (error.code === 'NATIVE_INSTALL_UNRESOLVED') throw error;
      throw failure('NATIVE_RUNTIME_INTEGRITY');
    }
  };
}

async function normalInputs(options, distribution, readNativeProcess) {
  if (!object(options) || Object.keys(options).some(key => !['env', 'homeDir', 'browserProcessId'].includes(key)) ||
      !Number.isSafeInteger(options.browserProcessId) || options.browserProcessId <= 0) throw failure('NATIVE_INSTALL_OPTIONS_INVALID');
  // This is the native account's home, not a later owner-isolated CLI HOME.
  const env = options.env || process.env, homeDir = options.homeDir || os.userInfo().homedir;
  const web = require('./web.cjs'), profile = require('./web-real-profile.cjs'), bootstrap = require('./bootstrap.cjs');
  const discovery = require('./web-browser-discovery.cjs');
  const browserStateRoot = path.resolve(web.stateDir(env, homeDir));
  const pointerBytes = sourceBytes(browserStateRoot, 'current.json'), pointer = JSON.parse(pointerBytes);
  if (typeof pointer.dir !== 'string' || !/^installs\/[A-Za-z0-9_-]+$/u.test(pointer.dir)) throw failure('NATIVE_RUNTIME_UNAVAILABLE');
  const installed = web.readInstalled(browserStateRoot);
  if (!installed || !installed.reader || !installed.patchRevision || installed.unavailableAt ||
      installed.dir !== path.join(browserStateRoot, pointer.dir)) throw failure('NATIVE_RUNTIME_UNAVAILABLE');
  // Existing normal receipt verification covers the patched maintained bundle
  // and shipped generic reader. Never acquire packages or scan source caches.
  sourceBytes(installed.dir, 'playwright-patch.json');
  sourceBytes(installed.dir, 'node_modules/classic-level/package.json');
  const level = require(path.join(installed.dir, 'node_modules/classic-level'));
  if (typeof level.ClassicLevel !== 'function') throw failure('NATIVE_RUNTIME_UNAVAILABLE');
  const cliDir = path.join(installed.dir, 'node_modules/playwright-core/lib/tools/cli-client');
  for (const name of ['registry.js', 'session.js']) sourceBytes(cliDir, name);
  const selectedNode = bootstrap.selectNode({ env, platform: process.platform, arch: process.arch, homeDir,
    mcpRoot: distribution.mcpRoot, current: { path: process.execPath, version: process.version, abi: process.versions.modules } });
  if (!selectedNode.node) throw failure('NATIVE_RUNTIME_UNAVAILABLE');
  const runtimeExecutable = await fs.realpath(selectedNode.node.path);
  const pluginDirs = profile.pluginDirs({ env, homeDir });
  const declaration = profile.readDeclaration({ env, homeDir, pluginDirs: () => pluginDirs });
  if (declaration.state !== 'declared') throw failure('NATIVE_SELECTION_MISMATCH');
  const userDataDir = profile.userDataDir(declaration.channel, process.platform, env, homeDir);
  const profileDirName = profile.findProfileDir(path.join(userDataDir, 'Local State'), declaration.domain);
  if (!profileDirName || /^[.]{1,2}$/u.test(profileDirName) || /[\\/\u0000-\u001f\u007f]/u.test(profileDirName)) throw failure('NATIVE_SELECTION_MISMATCH');
  const expectedBrowser = await readNativeProcess(options.browserProcessId);
  const executable = discovery.channelBrowserSelection(declaration.channel, process.platform, env,
    file => sync.existsSync(file), { nativeHome: homeDir }).executablePath;
  if (!executable || await fs.realpath(executable) !== expectedBrowser.executable) throw failure('NATIVE_ANCESTRY_MISMATCH');
  const { createNativeOwnerInventory } = await import('./src/browser/native-owner-inventory.mjs');
  createNativeOwnerInventory({ browserStateRoot, cliDir, binding: {} }); // actual maintained module/type boundary, no inventory or CLI probes
  return { env, homeDir, browserStateRoot, pointerBytes, runtimeExecutable, expectedBrowser,
    channel: declaration.channel, userDataDir, profileDirName, pluginDirs, cliDir };
}

// Normal source/selector preflight, not an updater with an empty-map grant.
// No registration, source publication or native preparation occurs before
// continuity authority is available through the fixed normal journal reader.
export async function prepareNativeExtensionUpdate(options) {
  if (!object(options) || Object.keys(options).some(k => !['env', 'homeDir', 'browserProcessId'].includes(k)) ||
      !Number.isSafeInteger(options.browserProcessId) || options.browserProcessId <= 0)
    throw failure('NATIVE_INSTALL_OPTIONS_INVALID');
  const distribution = await verifyNativeDistribution();
  const { readNativeProcess } = await import('./src/browser/native-host.mjs');
  const { createNativeUpdateProof } = await import('./src/browser/native-update-proof.mjs');
  const input = await normalInputs(options, distribution, readNativeProcess);
  await createNativeUpdateProof({ browserStateRoot: input.browserStateRoot,
    profileRoot: path.join(input.userDataDir, input.profileDirName), extensionId: distribution.extensionId,
    extensionSourceDigest: distribution.extensionSourceDigest }).assertPreparationAvailable();
}

// Explicit setup API only. No browser command/import calls it. The separate
// transition preflight above cannot publish/recover an unproved update.
export async function installNativeMessaging(options) {
  try {
    const distribution = await verifyNativeDistribution();
    const { withBrokerLock } = await import('./src/util/broker-lock.mjs');
    const { readNativeProcess } = await import('./src/browser/native-host.mjs');
    const input = await normalInputs(options, distribution, readNativeProcess);
    const root = path.join(input.browserStateRoot, 'native-owned');
    await assertOutsideGitWorkspace(root, naming);
    await privateDirectory(root);
    return await withBrokerLock(root, async () => {
      if ((await fs.readdir(root)).some(name => !['runtimes', 'extension', 'state', 'host-manifest.json', 'native-extension-update.lock'].includes(name)))
        throw failure('NATIVE_INSTALL_UNRESOLVED');
      if (await present(path.join(root, 'extension-update.json'))) throw failure('NATIVE_INSTALL_UNRESOLVED');
      const stateDir = path.join(root, 'state'), extensionDirectory = path.join(root, 'extension');
      await checkedPath(stateDir); await checkedPath(extensionDirectory); await checkedPath(path.join(root, 'runtimes'));
      if (await present(stateDir) && (await fs.readdir(stateDir)).length) throw failure('NATIVE_INSTALL_UNRESOLVED');
      const nativeReadyFile = path.join(stateDir, `native-provider-${hash(input.expectedBrowser.executable + '\0' + path.join(input.userDataDir, input.profileDirName))}.json`);
      const asset = distribution.native.selectAsset(distribution.mcpRoot, process.platform, process.arch);
      const assetBytes = sourceBytes(distribution.mcpRoot, path.relative(distribution.mcpRoot, asset.file).split(path.sep).join('/'));
      if (hash(assetBytes) !== asset.sha256) throw failure('NATIVE_RUNTIME_INTEGRITY');
      const binding = { ...input, env: undefined, homeDir: undefined, pointerBytes: undefined };
      const digest = hash(JSON.stringify({ distribution: distribution.distributionDigest, asset: asset.sha256, binding }));
      const runtimeDirectory = path.join(root, 'runtimes', digest);
      const executable = path.join(runtimeDirectory, `desk-browser-messaging${process.platform === 'win32' ? '.exe' : ''}`);
      const nativeConfig = { runtime: input.runtimeExecutable, hostModule: path.join(runtimeDirectory, 'mcp/native-host.mjs'),
        extensionOrigin: `chrome-extension://${distribution.extensionId}/` };
      const providerConfig = {
        version: 1, extensionId: distribution.extensionId, extensionOrigin: nativeConfig.extensionOrigin,
        extensionSourceDigest: distribution.extensionSourceDigest, runtimeExecutable: input.runtimeExecutable,
        entryExecutable: executable, browserExecutable: input.expectedBrowser.executable, expectedBrowser: input.expectedBrowser,
        channel: input.channel, userDataDir: input.userDataDir, profileDirName: input.profileDirName,
        profileRoot: path.join(input.userDataDir, input.profileDirName), pluginDirs: input.pluginDirs,
        nativeReadyFile, browserStateRoot: input.browserStateRoot, cliDir: input.cliDir,
      };
      const { validateNativeHostConfig } = await import('./src/browser/native-provider.mjs');
      validateNativeHostConfig(providerConfig);
      const registration = registrationLocation({ platform: process.platform, channel: input.channel, userDataRoot: input.userDataDir });
      if (process.platform === 'win32') registration.file = path.join(root, 'host-manifest.json');
      const hostManifest = Buffer.from(JSON.stringify({ name: HOST, description: 'Desk native browser contexts',
        path: executable, type: 'stdio', allowed_origins: [nativeConfig.extensionOrigin] }, null, 2) + '\n');
      // Preflight *all* existing publication surfaces before creating a capsule
      // or source. Never overwrite old/foreign source or upgrade a journal.
      if (await present(path.join(root, 'runtimes'))) {
        const entries = await fs.readdir(path.join(root, 'runtimes'));
        if (entries.some(name => name !== digest)) throw failure('NATIVE_INSTALL_UNRESOLVED');
      }
      if (await present(extensionDirectory)) {
        if (!same(await regularFiles(extensionDirectory), EXTENSION_FILES)) throw failure('NATIVE_EXTENSION_CONFLICT');
        for (const [name, bytes] of distribution.extension) await checkPrivate(fileAt(extensionDirectory, name), bytes);
      }
      if (await present(registration.file)) await checkPrivate(registration.file, hostManifest);
      let registered;
      if (process.platform === 'win32') {
        registered = await registry(registration, 'read');
        if (registered && registered !== registration.file) throw failure('NATIVE_REGISTRATION_CONFLICT');
      }
      const files = new Map(distribution.sources);
      files.set('native-host.json', Buffer.from(JSON.stringify(nativeConfig)));
      files.set('mcp/provider-config.json', Buffer.from(JSON.stringify(providerConfig)));
      files.set('artifact-manifest.json', distribution.artifactManifest);
      const binaryName = path.basename(executable);
      const inventory = Buffer.from(JSON.stringify({ version: 1, digest, distributionDigest: distribution.distributionDigest,
        files: [...files].map(([name, bytes]) => [name, hash(bytes)]), asset: { name: binaryName, sha256: asset.sha256 } }));
      files.set('capsule.json', inventory);
      if (await present(runtimeDirectory)) {
        if (!same(await regularFiles(runtimeDirectory), [...files.keys(), binaryName].sort())) throw failure('NATIVE_RUNTIME_INTEGRITY');
        for (const [name, bytes] of files) await checkPrivate(fileAt(runtimeDirectory, name), bytes);
        await checkPrivate(executable, assetBytes, true);
        const client = require('./web-native-messaging.cjs');
        client.readPrivateJson(path.join(runtimeDirectory, 'native-host.json'), { maxBytes: 16384 });
        client.readPrivateJson(path.join(runtimeDirectory, 'mcp/provider-config.json'), { maxBytes: 16384 });
      }
      if ((await verifyNativeDistribution()).distributionDigest !== distribution.distributionDigest ||
          !sourceBytes(input.browserStateRoot, 'current.json').equals(input.pointerBytes) ||
          !same(await readNativeProcess(options.browserProcessId), input.expectedBrowser)) throw failure('NATIVE_INSTALL_INPUT_CHANGED');
      if (!await present(runtimeDirectory)) {
        await privateDirectory(path.dirname(runtimeDirectory));
        await fs.mkdir(runtimeDirectory, { mode: 0o700 }); // exclusive final reservation; no replacing rename
        await privateDirectory(runtimeDirectory, true);
        for (const [name, bytes] of files) await writeNew(fileAt(runtimeDirectory, name), bytes);
        distribution.native.copyPrivateAsset(distribution.mcpRoot, process.platform, process.arch, executable);
        await protectFile(executable, true);
        for (const [name, bytes] of files) await checkPrivate(fileAt(runtimeDirectory, name), bytes);
        await checkPrivate(executable, assetBytes, true);
        const client = require('./web-native-messaging.cjs');
        client.readPrivateJson(path.join(runtimeDirectory, 'native-host.json'), { maxBytes: 16384 });
        client.readPrivateJson(path.join(runtimeDirectory, 'mcp/provider-config.json'), { maxBytes: 16384 });
      }
      if (!await present(extensionDirectory)) {
        await fs.mkdir(extensionDirectory, { mode: 0o700 }); // never replace an old source directory
        await privateDirectory(extensionDirectory, true);
        for (const [name, bytes] of distribution.extension) await writeNew(fileAt(extensionDirectory, name), bytes);
      }
      await privateDirectory(stateDir);
      if (!same(await regularFiles(extensionDirectory), EXTENSION_FILES)) throw failure('NATIVE_EXTENSION_CONFLICT');
      for (const [name, bytes] of distribution.extension) await checkPrivate(fileAt(extensionDirectory, name), bytes);
      const assertPublication = publicationFence({ runtimeDirectory, files, executable, assetBytes, extensionDirectory, distribution, stateDir, input });
      assertPublication();
      await publishRegistration(registration.file, hostManifest, assertPublication);
      if (process.platform === 'win32') {
        if (!registered) await registry(registration, 'write', assertPublication);
        if (await registry(registration, 'read') !== registration.file) throw failure('NATIVE_REGISTRATION_UNCONFIRMED');
      }
      await checkPrivate(registration.file, hostManifest);
      assertPublication();
      return { executable, runtimeDirectory, extensionDirectory, extensionId: distribution.extensionId,
        extensionSourceDigest: distribution.extensionSourceDigest, registration, nativeReadyFile,
        browserStateRoot: input.browserStateRoot, digest, continuity: 'unknown' };
    }, { name: 'native-extension-update' });
  } catch (error) {
    if (typeof error.code === 'string' && /^NATIVE_[A-Z_]+$/u.test(error.code)) throw error;
    throw failure('NATIVE_INSTALL_REFUSED');
  }
}
