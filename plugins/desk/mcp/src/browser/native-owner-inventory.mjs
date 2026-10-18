// Read-only signed-in inventory. Maintained Registry.loadEntry is used with an
// explicit validated directory; never Registry.load/list or Session._connect.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import client from '../../web-native-messaging.cjs';
import { BrokerError } from '../util/broker-error.mjs';

const require = createRequire(import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createNativeOwnerInventory({ browserStateRoot, cliDir, binding, platform = process.platform,
  env = process.env, socketRoot = platform === 'win32' ? os.tmpdir() : '/tmp', probeTimeoutMs = 500 }) {
  if (![browserStateRoot, cliDir, socketRoot].every(p => typeof p === 'string' && path.isAbsolute(p)) ||
      !Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs <= 0 || probeTimeoutMs > 5000)
    throw new BrokerError('NATIVE_INVENTORY_INVALID', 'NATIVE_INVENTORY_INVALID');
  const { Registry } = require(path.join(cliDir, 'registry.js'));
  const { Session } = require(path.join(cliDir, 'session.js'));
  const version = require(path.resolve(cliDir, '../../package.js')).packageJSON.version;
  if (typeof Registry !== 'function' || typeof Registry.prototype.loadEntry !== 'function' ||
      typeof Session?.prototype.isCompatible !== 'function')
    throw new BrokerError('NATIVE_CLI_UNSUPPORTED', 'NATIVE_CLI_UNSUPPORTED');
  const signedIn = path.join(browserStateRoot, 'signed-in');
  function layout(contextId) {
    if (typeof contextId !== 'string' || !UUID.test(contextId)) throw new BrokerError('NATIVE_OWNER_INVALID', 'NATIVE_OWNER_INVALID');
    const directory = path.join(signedIn, contextId);
    const marker = { contextId, directory };
    const workspaceDirHash = hash(directory, 'sha1').slice(0, 16);
    // Same private HOME/cache/TMP conventions as the existing CLI controller.
    const socketDirectory = path.join(socketRoot, `dp-${process.getuid ? process.getuid() : 'win'}-${hash(JSON.stringify(marker)).slice(0, 16)}`);
    const userHash = hash(env.USERNAME || env.USER || 'default', 'sha1').slice(0, 8);
    let socketPath;
    if (platform === 'win32') socketPath = `\\\\.\\pipe\\pw-${userHash}-cli-${workspaceDirHash}-${contextId}`;
    else {
      const parent = path.join(socketDirectory, `pw-${userHash}`, 'cli');
      const name = `${workspaceDirHash}-${contextId}`;
      socketPath = path.join(parent, name + '.sock');
      // Maintained makeSocketPath uses the common 103-byte Unix limit.
      if (Buffer.byteLength(socketPath) > 103) socketPath = path.join(parent, hash(name, 'sha1').slice(0, 16) + '.sock');
      if (Buffer.byteLength(socketPath) > 103) throw new BrokerError('NATIVE_SOCKET_PATH_INVALID', 'NATIVE_SOCKET_PATH_INVALID');
    }
    const cache = platform === 'darwin' ? path.join(directory, 'home', 'Library', 'Caches') :
      platform === 'win32' ? path.join(directory, 'home', 'AppData', 'Local') : path.join(directory, 'cache');
    const daemonProfilesDir = path.join(cache, 'ms-playwright', 'daemon', workspaceDirHash);
    return { directory, marker, socketDirectory, socketPath, daemonProfilesDir,
      sessionFile: path.join(daemonProfilesDir, contextId + '.session'), workspaceDirHash };
  }
  function descriptor(contextId) {
    const l = layout(contextId);
    client.privatePaths([browserStateRoot, signedIn, l.directory].map(file => ({ file, directory: true })));
    const marker = client.readPrivateJson(path.join(l.directory, '.desk-context-owner'));
    if (!same(marker, l.marker)) throw new BrokerError('NATIVE_OWNER_INVALID', 'NATIVE_OWNER_INVALID');
    client.privatePaths(['.playwright', 'home', 'config', 'cache', 'data', 'state', 'runtime', 'local', 'roaming']
      .map(name => ({ file: path.join(l.directory, name), directory: true })));
    const config = client.readPrivateJson(path.join(l.directory, 'config', 'browser.json'));
    const record = client.validateNativeRecord(config.deskNativeContext);
    if (config.extension !== true || !config.browser || typeof config.browser !== 'object' || Array.isArray(config.browser) ||
        config.browser.isolated || config.browser.remoteEndpoint ||
        config.browser.cdpEndpoint || record.contextId !== contextId ||
        (config.browser.userDataDir !== undefined && config.browser.userDataDir !== binding.userDataDir) ||
        ['channel', 'userDataDir', 'profileDirName', 'nativeReadyFile', 'extensionId', 'sourceDigest'].some(k => record[k] !== binding[k]))
      throw new BrokerError('NATIVE_OWNER_BINDING_MISMATCH', 'NATIVE_OWNER_BINDING_MISMATCH');
    return { ...l, record };
  }
  async function probe(l) {
    client.privatePath(l.socketDirectory, true);
    if (!same(client.readPrivateJson(path.join(l.socketDirectory, '.desk-context-owner')), l.marker))
      throw new BrokerError('NATIVE_OWNER_INVALID', 'NATIVE_OWNER_INVALID');
    if (platform !== 'win32') {
      let current = l.socketDirectory;
      for (const segment of path.relative(current, path.dirname(l.socketPath)).split(path.sep)) {
        current = path.join(current, segment);
        try { client.privatePath(current, true, false); }
        catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
      }
      let metadata;
      try { metadata = await fs.lstat(l.socketPath); }
      catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
      if (!metadata.isSocket() || metadata.isSymbolicLink() || (process.getuid && metadata.uid !== process.getuid()))
        return 'unknown';
    }
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
      const socket = net.createConnection(l.socketPath);
      const timer = setTimeout(() => finish('unknown'), probeTimeoutMs);
      socket.once('connect', () => finish('active'));
      // ECONNREFUSED, timeout, access errors are not absence and never unlink.
      socket.once('error', error => finish(error.code === 'ENOENT' ? 'absent' : 'unknown'));
    });
  }
  async function inspectOwner(contextId) {
    let l;
    try { l = descriptor(contextId); }
    catch { return { contextId, configured: false, cli: 'unknown', reason: 'NATIVE_OWNER_INVALID' }; }
    try {
      const raw = client.readPrivateJson(l.sessionFile, { anchor: l.directory });
      const identity = client.fileIdentity(l.sessionFile);
      if (raw.name !== contextId || !Number.isFinite(raw.timestamp) || raw.timestamp <= 0 ||
          typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(raw.version) ||
          raw.workspaceDir !== l.directory || raw.attached !== true || raw.cli?.persistent !== true ||
          raw.browser?.browserName !== 'chromium' ||
          (raw.browser.userDataDir != null && raw.browser.userDataDir !== binding.userDataDir) || raw.socketPath !== l.socketPath)
        throw Error();
      // This actual API does not consult cached baseDaemonDir or process HOME.
      const registry = new Registry(new Map());
      const entry = await registry.loadEntry({ daemonProfilesDir: l.daemonProfilesDir,
        workspaceDir: l.directory, workspaceDirHash: l.workspaceDirHash }, contextId);
      if (entry.file !== l.sessionFile || entry.daemonDir !== l.daemonProfilesDir || !same(entry.config, raw) ||
          !new Session(entry).isCompatible({ version })) throw Error();
      const cli = await probe(l);
      const fresh = client.readPrivateJson(l.sessionFile, { anchor: l.directory });
      if (client.fileIdentity(l.sessionFile) !== identity || !same(fresh, raw) || !same(descriptor(contextId).record, l.record)) throw Error();
      return { contextId, configured: true, cli, fingerprint: hash(identity + JSON.stringify(raw) + JSON.stringify(l.record)) };
    } catch {
      return { contextId, configured: true, cli: 'unknown', reason: 'NATIVE_CLI_EVIDENCE_UNKNOWN' };
    }
  }
  async function snapshot() {
    let names;
    try {
      client.privatePath(browserStateRoot, true); client.privatePath(signedIn, true);
      names = (await fs.readdir(signedIn)).sort();
    } catch {
      return { owners: [{ cli: 'unknown', reason: 'NATIVE_INVENTORY_UNAVAILABLE' }], digest: hash('unavailable') };
    }
    const owners = [];
    for (const [index, name] of names.entries()) {
      if (!UUID.test(name)) owners.push({ ownerIndex: index, cli: 'unknown', reason: 'NATIVE_OWNER_UNRECOGNIZED' });
      else owners.push(await inspectOwner(name));
    }
    if (!same(names, (await fs.readdir(signedIn)).sort()))
      owners.push({ cli: 'unknown', reason: 'NATIVE_INVENTORY_CHANGED' });
    return { owners, digest: hash(JSON.stringify(owners)) };
  }
  return Object.freeze({ layout, descriptor, inspectOwner, snapshot, version });
}
