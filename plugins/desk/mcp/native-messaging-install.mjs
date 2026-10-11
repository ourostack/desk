import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureOwnerOnlyDirectory, protectLeafFile } from './src/factory/os-protect.js';
import { protectWindowsPaths } from './src/factory/windows-acl.js';
import { windowsPowerShellPath } from './src/readiness/process-start.js';
import { withBrokerLock } from '../browser-context-broker/src/lock.mjs';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const HOST = 'com.ourostack.desk.browser';
const naming = { label: 'desk_native_browser', subject: 'native browser runtime' };

export function registrationLocation({ platform, channel, userDataRoot }) {
  if (!['msedge', 'chrome'].includes(channel)) throw Object.assign(new Error('Unsupported browser channel'), { code: 'NATIVE_CHANNEL_UNSUPPORTED' });
  if (platform === 'win32') {
    return { registryKey: `HKCU\\Software\\${channel === 'msedge' ? 'Microsoft\\Edge' : 'Google\\Chrome'}\\NativeMessagingHosts\\${HOST}` };
  }

  if (!['darwin', 'linux'].includes(platform) || !path.isAbsolute(userDataRoot ?? '')) {
    throw Object.assign(new Error('Native registration requires a supported platform and browser root'), { code: 'NATIVE_REGISTRATION_INVALID' });
  }
  return { file: path.join(userDataRoot, 'NativeMessagingHosts', HOST + '.json') };
}

export function nativeRegistryManifestPath(output, root) {
    const entries = typeof output === 'string' && output.length <= 16384
      ? [...output.matchAll(/^\s*[^\r\n]*?\sREG_SZ\s+([^\r\n]+)\s*$/gmu)] : [];
    if (entries.length !== 1) {
      throw Object.assign(new Error('Native registry must contain one exact string manifest value'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    }
    const value = entries[0][1].trim();
    const normalized = path.win32.resolve(value);
    if (!path.win32.isAbsolute(value) || !normalized.toLowerCase().startsWith(path.win32.resolve(root).toLowerCase() + '\\')) {
      throw Object.assign(new Error('Native registry manifest belongs to another installation'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    }
    return normalized;
  }
async function regularFiles(directory, relative = '') {
  const result = [];
  for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, item.name);
    if (item.isDirectory()) result.push(...await regularFiles(directory, name));
    else if (item.isFile()) result.push(name);
    else throw Object.assign(new Error('Native source contains a nonregular entry'), { code: 'NATIVE_SOURCE_INVALID' });
  }
  return result.sort();
}

async function validateDirectoryPath(directory) {
  let current = path.resolve(directory);
  for (;;) {
    try {
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw Object.assign(new Error('Native installation path contains a non-directory or symlink'), { code: 'NATIVE_PATH_INVALID' });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function privateDirectory(directory, platform) {
  await validateDirectoryPath(directory);
  const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (platform !== 'win32' && info.uid !== process.getuid()) {
    throw Object.assign(new Error('Native private directory belongs to a different owner'), { code: 'NATIVE_PATH_OWNER_MISMATCH' });
  }
  await ensureOwnerOnlyDirectory(directory, platform, naming);
  if (platform === 'win32') await protectWindowsPaths([{ path: directory, kind: 'directory', created: created !== undefined }], { label: naming.label });
}

async function privateConfigFile(file, platform, created) {
  const info = await fs.lstat(file);
  if (platform !== 'win32' && info.uid !== process.getuid()) {
    throw Object.assign(new Error('Native configuration belongs to a different owner'), { code: 'NATIVE_RUNTIME_INTEGRITY' });
  }
  if (!info.isFile() || info.nlink !== 1) {
    throw Object.assign(new Error('Native configuration must be an unshared regular file'), { code: 'NATIVE_RUNTIME_INTEGRITY' });
  }
  await protectLeafFile(file, platform, naming);
  if (platform === 'win32') {
    await protectWindowsPaths([{ path: file, kind: 'file', created }], { label: naming.label });
  }
}

function sourceDigest(bytes) {
  return createHash('sha256').update(JSON.stringify([...bytes].map(([name, content]) => [name.split(path.sep).join('/'), content])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]))).digest('hex');
}

async function directoryBytes(directory) {
  await validateDirectoryPath(directory);
  const bytes = new Map();
  for (const name of await regularFiles(directory)) bytes.set(name, await fs.readFile(path.join(directory, name)));
  return bytes;
}

async function recoverExtensionSwap(extensionDirectory) {
  const root = path.dirname(extensionDirectory);
  const journalFile = path.join(root, 'extension-update.json');
  let journal;
  try {
    const info = await fs.lstat(journalFile);
    if (!info.isFile() || info.nlink !== 1 || info.size > 16384 ||
        (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) {
      throw Object.assign(new Error('Native extension update journal is not private'), { code: 'NATIVE_UPDATE_JOURNAL_INVALID' });
    }
    journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (journal.version !== 1 || journal.stable !== path.basename(extensionDirectory) ||
      !/^\.extension-update-[A-Za-z0-9]+$/u.test(journal.staged ?? '') ||
      !/^\.extension-previous-[a-f0-9-]{36}$/u.test(journal.previous ?? '') ||
      ![journal.newDigest, journal.previousDigest].every(value => /^[a-f0-9]{64}$/u.test(value ?? ''))) {
    throw Object.assign(new Error('Native extension update journal has invalid exact paths or digests'), { code: 'NATIVE_UPDATE_JOURNAL_INVALID' });
  }
  const staged = path.join(root, journal.staged);
  const previousDirectory = path.join(root, journal.previous);
  async function digestIfPresent(directory) {
    try {
      return sourceDigest(await directoryBytes(directory));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  const stableDigest = await digestIfPresent(extensionDirectory);
  const stagedDigest = await digestIfPresent(staged);
  const previousDigest = await digestIfPresent(previousDirectory);
  if (stableDigest === journal.newDigest && previousDigest === journal.previousDigest && stagedDigest === null) {
    return { reloadRequired: true, extensionDirectory, previousDirectory, journalFile, newDigest: journal.newDigest };
  }
  if (stagedDigest !== journal.newDigest ||
      !((stableDigest === journal.previousDigest && previousDigest === null) ||
        (stableDigest === null && previousDigest === journal.previousDigest))) {
    throw Object.assign(new Error('Interrupted native extension update does not match its recorded sources'),
      { code: 'NATIVE_UPDATE_UNCONFIRMED' });
  }
  if (stableDigest !== null) await fs.rename(extensionDirectory, previousDirectory);
  await fs.rename(staged, extensionDirectory);
  return { reloadRequired: true, extensionDirectory, previousDirectory, journalFile, newDigest: journal.newDigest };
}

export async function recoverNativeExtensionUpdate({ extensionDirectory }) {
  await validateDirectoryPath(path.dirname(extensionDirectory));
  return withBrokerLock(path.dirname(extensionDirectory), () => recoverExtensionSwap(extensionDirectory),
    { name: 'native-extension-update' });
}

export async function updateNativeExtension({ sourceDirectory, extensionDirectory, gate, reload, platform = process.platform }) {
  if (![sourceDirectory, extensionDirectory].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      typeof gate !== 'function' || typeof reload !== 'function') {
    throw Object.assign(new Error('Deliberate extension update requires exact directories and guarded reload'), { code: 'NATIVE_UPDATE_INVALID' });
  }
  const root = path.dirname(extensionDirectory);
  await validateDirectoryPath(root);
  return withBrokerLock(root, async () => {
    const bytes = await directoryBytes(sourceDirectory);
    const recovered = await recoverExtensionSwap(extensionDirectory);
    if (recovered) {
      if (recovered.newDigest !== sourceDigest(bytes)) {
        throw Object.assign(new Error('Pending native update must reconcile before another source update'), { code: 'NATIVE_UPDATE_EFFECTS_PENDING' });
      }
      if ((await gate())?.safe !== true) {
        throw Object.assign(new Error('Exact live native effects must settle before extension reload'), { code: 'NATIVE_UPDATE_EFFECTS_PENDING' });
      }
      await reload();
      await fs.unlink(recovered.journalFile);
      return { updated: true, extensionDirectory, previousDirectory: recovered.previousDirectory };
    }
    const sourceManifest = JSON.parse(bytes.get('manifest.json')?.toString('utf8'));
    await ensureOwnerOnlyDirectory(extensionDirectory, platform, naming);
    await regularFiles(extensionDirectory);
    const currentManifest = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
    if (!sourceManifest.key || sourceManifest.key !== currentManifest.key) {
      throw Object.assign(new Error('Extension update cannot replace its registered public identity'), { code: 'NATIVE_EXTENSION_CONFLICT' });
    }
    const permission = await gate();
    if (permission?.safe !== true) {
      throw Object.assign(new Error('Exact live native effects must settle before extension update'), { code: 'NATIVE_UPDATE_EFFECTS_PENDING' });
    }
    const staged = await fs.mkdtemp(path.join(root, '.extension-update-'));
    await privateDirectory(staged, platform);
    for (const [name, content] of bytes) {
      const destination = path.join(staged, name);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, content, { mode: 0o600, flag: 'wx' });
      if (!(await fs.readFile(destination)).equals(content)) {
        throw Object.assign(new Error('Extension update source readback failed; reload was not dispatched'), { code: 'NATIVE_UPDATE_UNCONFIRMED' });
      }
    }
    const previousDirectory = path.join(root, '.extension-previous-' + randomUUID());
    const journalFile = path.join(root, 'extension-update.json');
    const journal = await fs.open(journalFile, 'wx', 0o600);
    try {
      await journal.writeFile(JSON.stringify({ version: 1, stable: path.basename(extensionDirectory),
        staged: path.basename(staged), previous: path.basename(previousDirectory),
        newDigest: sourceDigest(bytes), previousDigest: sourceDigest(await directoryBytes(extensionDirectory)) }));
      await journal.sync();
    } finally {
      await journal.close();
    }
    await recoverExtensionSwap(extensionDirectory);
    // Keep the prior source: reload disconnects consumers and is not a continuity acknowledgement.
    await reload();
    await fs.unlink(journalFile);
    return { updated: true, extensionDirectory, previousDirectory };
  }, { name: 'native-extension-update' });
}

export async function updateNativeMessaging(options) {
  const native = require(path.join(options.mcpRoot, 'web-native-messaging.cjs'));
  const destinationSourceDigest = /^export const SOURCE_DIGEST = "([a-f0-9]{64})";\n$/u.exec(
    await fs.readFile(path.resolve(options.mcpRoot, '../browser-extension/source-digest.js'), 'utf8'))?.[1];
  if (!destinationSourceDigest) {
    throw Object.assign(new Error('Deliberate source update requires a generated destination identity'), { code: 'NATIVE_SOURCE_INVALID' });
  }
  let updateToken;
  let reloadDispatched = false;
  try {
    const result = await updateNativeExtension({
      sourceDirectory: path.resolve(options.mcpRoot, '../browser-extension'),
      extensionDirectory: path.join(options.root, 'extension'),
      platform: options.platform ?? process.platform,
      gate: async () => {
        const permission = await native.providerRequest(options.providerEndpoint, 'prepareUpdate',
          { expectedProcessIdentity: options.expectedProcessIdentity, extensionSourceDigest: destinationSourceDigest });
        if (permission?.safe !== true || !/^[a-f0-9]{64}$/u.test(permission.updateToken ?? '')) {
          throw Object.assign(new Error('Native provider did not confirm exact source-update quiescence'), { code: 'NATIVE_UPDATE_UNCONFIRMED' });
        }
        updateToken = permission.updateToken;
        return { safe: true };
      },
      reload: async () => {
        await installNativeMessagingUnlocked(options);
        reloadDispatched = true;
        const response = await native.providerRequest(options.providerEndpoint, 'reloadExtension', { updateToken });
        if (response?.reloading !== true || response.reconciliationRequired !== true) {
          throw Object.assign(new Error('Native reload did not acknowledge required transport reconciliation'),
            { code: 'NATIVE_UPDATE_UNCONFIRMED' });
        }
      },
    });
    return { ...result, reconciliationRequired: true };
  } catch (error) {
    if (updateToken && !reloadDispatched) {
      const cancelled = await native.providerRequest(options.providerEndpoint, 'cancelUpdate', { updateToken });
      if (cancelled?.cancelled !== true) {
        throw Object.assign(new Error('Native update failed and its exact pause could not be cancelled', { cause: error }),
          { code: 'NATIVE_UPDATE_CANCEL_UNCONFIRMED' });
      }
    }
    throw error;
  }
}

export async function installNativeMessaging(options) {
  if (typeof options.root !== 'string' || !path.isAbsolute(options.root)) {
    throw Object.assign(new Error('Native installation requires an exact absolute root'), { code: 'NATIVE_INSTALL_INVALID' });
  }
  await privateDirectory(options.root, options.platform ?? process.platform);
  return withBrokerLock(options.root, async () => {
    const recovered = await recoverExtensionSwap(path.join(options.root, 'extension'));
    if (recovered) {
      throw Object.assign(new Error('Native source publication recovered; deliberate reload and fresh attestation remain required'),
        { code: 'NATIVE_EXTENSION_RELOAD_REQUIRED' });
    }
    return installNativeMessagingUnlocked(options);
  }, { name: 'native-extension-update' });
}

async function installNativeMessagingUnlocked({
  mcpRoot, root, userDataRoot, profile, channel, browserExecutable, runtimeExecutable, levelModule,
  wsModule = path.resolve(mcpRoot, '../browser-context-broker/node_modules/ws'),
  platform = process.platform, arch = process.arch,
}) {
  if (![root, userDataRoot, browserExecutable, runtimeExecutable, levelModule, wsModule].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      typeof profile !== 'string' || !profile || profile === '.' || profile === '..' || /[\\/\u0000-\u001f]/u.test(profile)) {
    throw Object.assign(new Error('Native installation requires exact absolute paths and a profile directory'), { code: 'NATIVE_INSTALL_INVALID' });
  }
  await validateDirectoryPath(root);
  await validateDirectoryPath(path.join(userDataRoot, 'NativeMessagingHosts'));
  const native = require(path.join(mcpRoot, 'web-native-messaging.cjs'));
  const asset = native.selectAsset(mcpRoot, platform, arch);
  const plugin = path.resolve(mcpRoot, '..');
  const extensionSource = path.join(plugin, 'browser-extension');
  const sourceBytes = await directoryBytes(extensionSource);
  const extensionSourceDigest = /^export const SOURCE_DIGEST = "([a-f0-9]{64})";\n$/u
    .exec(sourceBytes.get('source-digest.js')?.toString('utf8') ?? '')?.[1];
  if (!extensionSourceDigest || extensionSourceDigest !== sourceDigest(new Map([...sourceBytes]
    .filter(([name]) => name !== 'source-digest.js')))) {
    throw Object.assign(new Error('Generated extension identity does not match its source'), { code: 'NATIVE_SOURCE_INVALID' });
  }
  const manifest = JSON.parse(await fs.readFile(path.join(extensionSource, 'manifest.json'), 'utf8'));
  const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/gu, value => String.fromCharCode(97 + Number.parseInt(value, 16)));
  const registration = registrationLocation({ platform, channel, userDataRoot });
  let previous;
  if (registration.file) {
    try {
      const info = await fs.lstat(registration.file);
      if (!info.isFile()) throw Object.assign(new Error('Native registration is not a regular file'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
      previous = JSON.parse(await fs.readFile(registration.file, 'utf8'));
      if (previous.name !== HOST || previous.type !== 'stdio' ||
          !path.resolve(previous.path ?? '').startsWith(path.resolve(root) + path.sep) ||
          JSON.stringify(previous.allowed_origins) !== JSON.stringify([`chrome-extension://${extensionId}/`])) {
        throw Object.assign(new Error('Native host registration belongs to another installation'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const files = [];
  for (const name of await regularFiles(extensionSource)) files.push({ source: path.join(extensionSource, name), destination: path.join('extension', name) });
  const broker = path.join(plugin, 'browser-context-broker');
  for (const name of ['package.json', ...await regularFiles(path.join(broker, 'src')).then(names => names.map(name => path.join('src', name))), 'bin/native-host.mjs']) {
    files.push({ source: path.join(broker, name), destination: path.join('plugins/desk/browser-context-broker', name) });
  }
  for (const name of ['package.json', 'web-real-profile.cjs', 'src/readiness/process-start.js', 'src/factory/windows-acl.js']) {
    files.push({ source: path.join(mcpRoot, name), destination: path.join('plugins/desk/mcp', name) });
  }
  for (const name of await regularFiles(wsModule)) {
    files.push({ source: path.join(wsModule, name), destination: path.join('plugins/desk/browser-context-broker/node_modules/ws', name) });
  }
  const hash = createHash('sha256').update(asset.sha256).update(runtimeExecutable).update(browserExecutable)
    .update(userDataRoot).update(profile).update(levelModule);
  const bytes = new Map();
  for (const item of files) {
    const content = await fs.readFile(item.source);
    hash.update(item.destination + '\0').update(content);
    bytes.set(item.destination, content);
  }
  const digest = hash.digest('hex');
  await privateDirectory(root, platform);
  await privateDirectory(path.join(root, 'runtimes'), platform);
  const runtimeDirectory = path.join(root, 'runtimes', digest);
  let existing = false;
  try {
    const info = await fs.lstat(runtimeDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error('Native runtime path is not an owned directory'), { code: 'NATIVE_RUNTIME_INVALID' });
    existing = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const executable = path.join(runtimeDirectory, 'desk-browser-messaging' + (platform === 'win32' ? '.exe' : ''));
  const nativeConfig = {
    runtime: runtimeExecutable, hostModule: path.join(runtimeDirectory, 'plugins/desk/browser-context-broker/bin/native-host.mjs'),
    extensionOrigin: `chrome-extension://${extensionId}/`,
  };
  const providerConfig = {
    extensionOrigin: nativeConfig.extensionOrigin, extensionId, extensionSourceDigest, entryExecutable: executable,
    runtimeExecutable, browserExecutable, profileRoot: path.join(userDataRoot, profile),
    levelModule, stateDir: path.join(root, 'state'),
  };
  if (!existing) {
    const stagedRuntime = await fs.mkdtemp(path.join(root, 'runtimes', '.native-runtime-'));
    await privateDirectory(stagedRuntime, platform);
    for (const [name, content] of bytes) {
      const file = path.join(stagedRuntime, name);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, content, { mode: 0o600, flag: 'wx' });
      if (!(await fs.readFile(file)).equals(content)) {
        throw Object.assign(new Error('Staged native source failed exact readback'), { code: 'NATIVE_RUNTIME_INTEGRITY' });
      }
    }
    native.copyPrivateAsset(mcpRoot, platform, arch, path.join(stagedRuntime, path.basename(executable)));
    for (const [name, config] of [['native-host.json', nativeConfig], ['provider-config.json', providerConfig]]) {
      const file = path.join(stagedRuntime, name);
      await fs.writeFile(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
      await privateConfigFile(file, platform, true);
      if ((await fs.readFile(file, 'utf8')) !== JSON.stringify(config)) {
        throw Object.assign(new Error('Staged native configuration failed exact readback'), { code: 'NATIVE_RUNTIME_INTEGRITY' });
      }
    }
    await fs.rename(stagedRuntime, runtimeDirectory);
  }
  for (const [name, expected] of [['native-host.json', nativeConfig], ['provider-config.json', providerConfig]]) {
    const file = path.join(runtimeDirectory, name);
    await privateConfigFile(file, platform, false);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.nlink !== 1 ||
        (platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) ||
        (await fs.readFile(file, 'utf8')) !== JSON.stringify(expected)) {
      throw Object.assign(new Error('Native runtime configuration no longer matches its installation'), { code: 'NATIVE_RUNTIME_INTEGRITY' });
    }
  }
  for (const [name, content] of bytes) {
    const file = path.join(runtimeDirectory, name);
    const info = await fs.lstat(file);
    if (!info.isFile() || !(await fs.readFile(file)).equals(content)) {
      throw Object.assign(new Error('Installed native runtime source does not match its digest'), { code: 'NATIVE_RUNTIME_INTEGRITY' });
    }
  }
  native.checkAsset(executable, asset.sha256);
  const extensionDirectory = path.join(root, 'extension');
  let extensionExists = false;
  try {
    const info = await fs.lstat(extensionDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw Object.assign(new Error('Stable native extension path is not an owned directory'), { code: 'NATIVE_EXTENSION_CONFLICT' });
    }
    extensionExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!extensionExists) {
    await privateDirectory(extensionDirectory, platform);
    for (const [name, content] of bytes) {
      if (!name.startsWith('extension' + path.sep)) continue;
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, content, { mode: 0o600, flag: 'wx' });
    }
  }
  for (const [name, content] of bytes) {
    if (!name.startsWith('extension' + path.sep)) continue;
    const file = path.join(root, name);
    const info = await fs.lstat(file);
    if (!info.isFile() || !(await fs.readFile(file)).equals(content)) {
      throw Object.assign(new Error('Native extension source changed; a deliberate verified update and self-reload is required'),
        { code: 'NATIVE_EXTENSION_UPDATE_REQUIRED' });
    }
  }
  const expectedExtensionFiles = [...bytes.keys()].filter(name => name.startsWith('extension' + path.sep))
    .map(name => name.slice('extension'.length + 1)).sort();
  if (JSON.stringify(await regularFiles(extensionDirectory)) !== JSON.stringify(expectedExtensionFiles)) {
    throw Object.assign(new Error('Native extension contains source outside the verified installation'),
      { code: 'NATIVE_EXTENSION_UPDATE_REQUIRED' });
  }
  await privateDirectory(path.join(root, 'state'), platform);
  const hostManifest = { name: HOST, description: 'Desk cooperative browser ownership', path: executable, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
  if (platform === 'win32') registration.file = path.join(runtimeDirectory, 'host-manifest.json');
  await fs.mkdir(path.dirname(registration.file), { recursive: true, mode: 0o700 });
  const temporary = registration.file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(hostManifest, null, 2), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, registration.file);
  if (platform === 'win32') {
    const reg = path.win32.join(path.win32.dirname(path.win32.dirname(path.win32.dirname(windowsPowerShellPath()))), 'reg.exe');
    const observed = await execute(reg, ['query', registration.registryKey, '/ve'], { windowsHide: true }).catch(error => {
      if (error.code === 1) return { stdout: '' };
      throw error;
    });
    if (observed.stdout) {
      const previousFile = nativeRegistryManifestPath(observed.stdout, root);
      const previousManifest = JSON.parse(await fs.readFile(previousFile, 'utf8'));
      if (previousManifest.name !== HOST || previousManifest.type !== 'stdio' ||
          JSON.stringify(previousManifest.allowed_origins) !== JSON.stringify(hostManifest.allowed_origins) ||
          !path.resolve(previousManifest.path ?? '').startsWith(path.resolve(root) + path.sep)) {
        throw Object.assign(new Error('Native registry entry belongs to another installation'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
      }
    }
    await execute(reg, ['add', registration.registryKey, '/ve', '/t', 'REG_SZ', '/d', registration.file, '/f'], { windowsHide: true });
    const registered = await execute(reg, ['query', registration.registryKey, '/ve'], { windowsHide: true });
    if (nativeRegistryManifestPath(registered.stdout, root).toLowerCase() !== path.win32.resolve(registration.file).toLowerCase()) {
      throw Object.assign(new Error('Native registry did not confirm its exact manifest path'), { code: 'NATIVE_REGISTRATION_UNCONFIRMED' });
    }
    await protectWindowsPaths([{ path: runtimeDirectory, kind: 'directory', created: !existing },
      { path: registration.file, kind: 'file', created: true }], { label: naming.label });
  }
  const readback = JSON.parse(await fs.readFile(registration.file, 'utf8'));
  if (readback.path !== executable || JSON.stringify(readback.allowed_origins) !== JSON.stringify(hostManifest.allowed_origins)) {
    throw Object.assign(new Error('Native registration did not confirm its exact executable and origin'), { code: 'NATIVE_REGISTRATION_UNCONFIRMED' });
  }
  return { executable, runtimeDirectory, extensionDirectory,
    extensionId, extensionSourceDigest, registration, stateDir: path.join(root, 'state'), digest };
}
