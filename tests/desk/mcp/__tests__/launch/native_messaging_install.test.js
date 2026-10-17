import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkTempRoot } from '../_temp_roots.js';
import { processStartReaders, readProcessStart, windowsPowerShellPath } from '../../../../../plugins/desk/mcp/src/readiness/process-start.js';
import * as installer from '../../../../../plugins/desk/mcp/native-messaging-install.mjs';
import { installNativeMessaging, registrationLocation } from '../../../../../plugins/desk/mcp/native-messaging-install.mjs';
import { createNativeFramer, readNativeProcess } from '../../../../../plugins/desk/mcp/src/browser/native-host.mjs';

const require = createRequire(import.meta.url);
const mcp = new URL('../../../../../plugins/desk/mcp/', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const put = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
};

for (const channel of ['chrome', 'msedge']) {
  test(`native install admits normal per-user macOS ${channel} without a global-channel fallback`,
    { skip: process.platform !== 'darwin' }, async t => {
      const f = await fixture(t, { channel, location: 'user', isolatedHome: true });
      const got = await installNativeMessaging(f.options);
      const config = JSON.parse(await fs.readFile(path.join(got.runtimeDirectory, 'mcp/provider-config.json')));
      assert.equal(config.channel, channel);
      assert.equal(config.expectedBrowser.pid, process.pid);
      assert.equal(config.browserExecutable, fsSync.realpathSync(process.execPath));
      assert.equal(config.userDataDir, f.userDataDir);
    });
}

test('native install refuses declared Chrome versus discovered Edge without global-channel/profile fallback', async t => {
  const f = await fixture(t);
  await put(path.join(f.root, 'plugins/overlay/plugin.json'), { name: 'overlay', version: '1.0.0',
    desk: { browser: { channel: 'chrome', profileAccountDomain: 'fixture.invalid' } } });
  const profile = require(fileURLToPath(new URL('web-real-profile.cjs', mcp)));
  const chrome = profile.userDataDir('chrome', process.platform, f.env, f.homeDir);
  await put(path.join(chrome, 'Local State'), await fs.readFile(path.join(f.userDataDir, 'Local State')));
  await fs.mkdir(path.join(chrome, 'Default'), { mode: 0o700 });
  await assert.rejects(installNativeMessaging(f.options), { code: 'NATIVE_ANCESTRY_MISMATCH' });
});

test('native install refuses a discovered canonical executable different from the observed PID', async t => {
  const f = await fixture(t, { wrongExecutable: true });
  await assert.rejects(installNativeMessaging(f.options), { code: 'NATIVE_ANCESTRY_MISMATCH' });
});

test('native install refuses PID generation reuse at actual final ancestry corroboration', async t => {
  const f = await fixture(t), reader = processStartReaders[process.platform];
  let reads = 0;
  t.mock.method(processStartReaders, process.platform, async (pid, ...args) => {
    const start = await reader(pid, ...args);
    return pid === process.pid && ++reads > 2 ? `${start}:reused-generation` : start;
  });
  await assert.rejects(installNativeMessaging(f.options), { code: 'NATIVE_INSTALL_INPUT_CHANGED' });
  assert.ok(reads >= 4, 'both actual process observations ran with internally consistent but different generations');
  const registration = registrationLocation({ platform: process.platform, channel: 'msedge', userDataRoot: f.userDataDir });
  await assert.rejects(fs.lstat(registration.file || path.join(f.env.DESK_BROWSER_STATE_DIR, 'native-owned/host-manifest.json')), { code: 'ENOENT' });
});

test('native installation is an implemented explicit API, not an updater/continuity stub', async () => {
  assert.equal(typeof installNativeMessaging, 'function', 'the admitted installer must exist');
  assert.equal(installer.updateNativeMessaging, undefined);
  assert.equal(installer.recoverNativeExtensionUpdate, undefined);
  assert.equal(installer.createNativeUpdateVerifier, undefined);
});

async function fixture(t, { channel = 'msedge', location = 'system', wrongExecutable = false, isolatedHome = false } = {}) {
  const handles = new WeakMap(), open = fs.open;
  t.mock.method(fs, 'open', async function (file, ...args) {
    const handle = await open.call(this, file, ...args);
    handles.set(handle, String(file));
    return handle;
  });
  const writePath = file => typeof file === 'object' ? handles.get(file) : String(file);
  const root = await mkTempRoot('desk-native-D-install-');
  t.diagnostic(`D install exact root=${root}; pid=${process.pid}; start=${await readProcessStart(process.pid)}`);
  const homeDir = path.join(root, 'home');
  const env = { ...process.env, HOME: isolatedHome ? path.join(root, 'owner-isolated-cli-home') : homeDir, USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, 'config'), XDG_STATE_HOME: path.join(homeDir, 'state'),
    LOCALAPPDATA: path.join(homeDir, 'AppData/Local'), DESK_BROWSER_STATE_DIR: path.join(root, 'browser'),
    DESK_PLUGIN_ROOT: path.join(root, 'plugins/desk') };
  await put(path.join(root, 'plugins/desk/plugin.json'), { name: 'desk', version: '1.0.0' });
  await put(path.join(root, 'plugins/overlay/plugin.json'), { name: 'overlay', version: '1.0.0',
    desk: { browser: { channel, profileAccountDomain: 'fixture.invalid' } } });
  const profile = require(fileURLToPath(new URL('web-real-profile.cjs', mcp)));
  const web = require(fileURLToPath(new URL('web.cjs', mcp)));
  const patch = require(fileURLToPath(new URL('web-playwright-patch.cjs', mcp)));
  const userDataDir = profile.userDataDir(channel, process.platform, env, homeDir);
  await put(path.join(userDataDir, 'Local State'), { profile: { last_used: 'Default', info_cache: {
    Default: { user_name: 'owned@fixture.invalid' },
  } } });
  await fs.mkdir(path.join(userDataDir, 'Default'), { mode: 0o700 });
  const installed = path.join(env.DESK_BROWSER_STATE_DIR, 'installs/owned-fixture');
  const modules = path.join(installed, 'node_modules');
  const credential = await fs.readFile(new URL('web-extension-credential.cjs', mcp));
  const bundle = '// owned synthetic maintained CLI receipt fixture; not a shipping implementation\n';
  await put(path.join(modules, '@playwright/mcp/package.json'), { version: '1.2.3', bin: 'cli.js' });
  await put(path.join(modules, '@playwright/mcp/cli.js'), '// never executed\n');
  await put(path.join(modules, 'playwright-core/package.json'), { version: '1.2.4' });
  await put(path.join(modules, 'playwright-core/lib/coreBundle.js'), bundle);
  await put(path.join(modules, 'playwright-core/lib/desk-extension-credential.cjs'), credential);
  const cli = path.join(modules, 'playwright-core/lib/tools/cli-client');
  await put(path.join(cli, 'registry.js'), 'exports.Registry=class Registry { loadEntry() { throw Error("no inventory reads during install"); } };\n');
  await put(path.join(cli, 'session.js'), 'exports.Session=class Session { isCompatible() { return true; } };\n');
  await put(path.join(modules, 'playwright-core/lib/package.js'), 'exports.packageJSON={version:"1.2.4"};\n');
  await put(path.join(modules, 'classic-level/package.json'), { name: 'classic-level', main: 'index.js' });
  await put(path.join(modules, 'classic-level/index.js'), 'exports.ClassicLevel=class ClassicLevel { constructor() { throw Error("no credential DB read during install"); } };\n');
  await put(path.join(installed, 'playwright-patch.json'), { revision: patch.REVISION, mcpVersion: '1.2.3',
    coreVersion: '1.2.4', bundleSha256: sha(bundle), credentialSha256: sha(credential) });
  await put(path.join(env.DESK_BROWSER_STATE_DIR, 'current.json'), { version: '1.2.3', dir: 'installs/owned-fixture', previous: null });
  // Actual normal discovery runs. Only candidate filesystem observations are
  // redirected to this exact owned worker; no installed browser is observed.
  const candidates = ['chrome', 'msedge'].flatMap(value => {
    const app = value === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
    return [...web.browserPaths(value, process.platform, env), path.join(homeDir, 'Applications', `${app}.app/Contents/MacOS/${app}`)];
  });
  const app = channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
  const candidate = location === 'user' ? path.join(homeDir, 'Applications', `${app}.app/Contents/MacOS/${app}`)
    : web.browserPaths(channel, process.platform, env)[0];
  const exists = fsSync.existsSync, realpath = fs.realpath;
  t.mock.method(fsSync, 'existsSync', function (file) {
    return candidates.includes(String(file)) ? file === candidate : exists.call(this, file);
  });
  t.mock.method(fs, 'realpath', function (file, ...args) {
    return file === candidate ? Promise.resolve(wrongExecutable ? path.join(root, 'wrong-executable') : fsSync.realpathSync(process.execPath))
      : realpath.call(this, file, ...args);
  });
  if (process.platform === 'win32') {
    const exec = childProcess.execFile;
    let registryValue;
    t.mock.method(childProcess, 'execFile', function (file, args, options, callback) {
      if (!args?.some(arg => typeof arg === 'string' && arg.includes('# DESK_NATIVE_REGISTRY')))
        return exec.call(this, file, args, options, callback);
      const script = args[args.length - 1];
      if (script.includes('# DESK_NATIVE_REGISTRY write')) registryValue = JSON.parse(/# MANIFEST (".*")/u.exec(script)[1]);
      queueMicrotask(() => callback(null, registryValue || '', ''));
    });
  }
  return { root, env, homeDir, installed, userDataDir, writePath,
    options: { env, homeDir, browserProcessId: process.pid } };
}

test('native: explicit install publishes exact private capsule/config/source/registration and is idempotent', async t => {
  const f = await fixture(t);
  const installed = await installNativeMessaging(f.options);
  assert.equal(installed.continuity, 'unknown');
  assert.equal(installed.runtimeDirectory, path.join(f.env.DESK_BROWSER_STATE_DIR, 'native-owned/runtimes', installed.digest));
  const go = JSON.parse(await fs.readFile(path.join(installed.runtimeDirectory, 'native-host.json'), 'utf8'));
  assert.deepEqual(Object.keys(go).sort(), ['extensionOrigin', 'hostModule', 'runtime']);
  assert.equal(go.hostModule, path.join(installed.runtimeDirectory, 'mcp/native-host.mjs'));
  const provider = JSON.parse(await fs.readFile(path.join(path.dirname(go.hostModule), 'provider-config.json'), 'utf8'));
  assert.equal(Object.keys(provider).length, 16);
  assert.equal(provider.expectedBrowser.pid, process.pid);
  assert.equal(provider.cliDir, path.join(f.installed, 'node_modules/playwright-core/lib/tools/cli-client'));
  assert.equal(provider.profileRoot, path.join(f.userDataDir, 'Default'));
  assert.equal(provider.nativeReadyFile, installed.nativeReadyFile);
  assert.equal(provider.entryExecutable, installed.executable);
  assert.equal(await fs.readFile(path.join(installed.runtimeDirectory, 'mcp/package.json'), 'utf8'),
    await fs.readFile(new URL('package.json', mcp), 'utf8'));
  await import(pathToFileURL(go.hostModule));
  assert.equal((await installNativeMessaging(f.options)).digest, installed.digest);
  assert.deepEqual(await fs.readdir(path.join(f.env.DESK_BROWSER_STATE_DIR, 'native-owned/runtimes')), [installed.digest]);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(installed.executable)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(path.dirname(go.hostModule), 'provider-config.json'))).mode & 0o777, 0o600);
  }
  const manifest = JSON.parse(await fs.readFile(installed.registration.file, 'utf8'));
  assert.equal(manifest.path, installed.executable);
  assert.deepEqual(manifest.allowed_origins, [go.extensionOrigin]);
});

for (const conflict of ['journal', 'source', 'registration', 'runtime', 'capsule-byte', 'reader', 'receipt', 'partial-write']) {
  test(`native install preserves and refuses ${conflict} instead of overwriting/adopting`, async t => {
    const f = await fixture(t);
    const root = path.join(f.env.DESK_BROWSER_STATE_DIR, 'native-owned');
    if (['source', 'capsule-byte'].includes(conflict)) {
      const got = await installNativeMessaging(f.options);
      await fs.appendFile(conflict === 'source' ? path.join(got.extensionDirectory, 'background.mjs')
        : path.join(got.runtimeDirectory, 'mcp/native-host.mjs'), '\n// retained conflicting bytes\n');
    } else if (conflict === 'journal') await put(path.join(root, 'extension-update.json'), { version: 1, phase: 'unknown-prepared' });
    else if (conflict === 'registration') {
      const location = registrationLocation({ platform: process.platform, channel: 'msedge', userDataRoot: f.userDataDir });
      if (process.platform === 'win32') await put(path.join(root, 'host-manifest.json'), { foreign: true });
      else await put(location.file, { foreign: true });
    } else if (conflict === 'runtime') await put(path.join(root, 'runtimes/unknown-retained/keep'), 'retained');
    else if (conflict === 'reader') await fs.rename(path.join(f.installed, 'node_modules/classic-level'), path.join(f.installed, 'node_modules/owned-reader-away'));
    else if (conflict === 'receipt') await fs.appendFile(path.join(f.installed, 'node_modules/playwright-core/lib/coreBundle.js'), 'changed');
    else {
      const write = fs.writeFile;
      t.mock.method(fs, 'writeFile', async function (file, ...args) {
        if (f.writePath(file)?.endsWith('/mcp/native-host.mjs') || f.writePath(file)?.endsWith('\\mcp\\native-host.mjs')) {
          await write.call(this, file, 'owned partial staging write', { flag: 'wx', mode: 0o600 });
          throw Object.assign(Error('injected exact write failure'), { code: 'EIO' });
        }
        return write.call(this, file, ...args);
      });
    }
    const expected = { journal: 'NATIVE_INSTALL_UNRESOLVED', source: 'NATIVE_RUNTIME_INTEGRITY',
      registration: 'NATIVE_RUNTIME_INTEGRITY', runtime: 'NATIVE_INSTALL_UNRESOLVED',
      'capsule-byte': 'NATIVE_RUNTIME_INTEGRITY', reader: 'NATIVE_RUNTIME_UNAVAILABLE',
      receipt: 'NATIVE_RUNTIME_UNAVAILABLE', 'partial-write': 'NATIVE_INSTALL_REFUSED' }[conflict];
    await assert.rejects(installNativeMessaging(f.options), { code: expected });
    if (conflict === 'journal') assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'extension-update.json'), 'utf8')), { version: 1, phase: 'unknown-prepared' });
    if (conflict === 'runtime') assert.equal(await fs.readFile(path.join(root, 'runtimes/unknown-retained/keep'), 'utf8'), 'retained');
    if (conflict === 'source') assert.match(await fs.readFile(path.join(root, 'extension/background.mjs'), 'utf8'), /retained conflicting bytes/u);
    if (conflict === 'partial-write') {
      const [digest] = await fs.readdir(path.join(root, 'runtimes'));
      assert.equal(await fs.readFile(path.join(root, 'runtimes', digest, 'mcp/native-host.mjs'), 'utf8'), 'owned partial staging write');
      await assert.rejects(fs.lstat(path.join(root, 'extension')), { code: 'ENOENT' });
    }
  });
}

test('native: actual host-OS Go entry loads the real capsule Node entry/config and preserves framing diagnostics', { timeout: process.platform === 'win32' ? 120000 : 30000 }, async t => {
  const f = await fixture(t);
  const got = await installNativeMessaging(f.options);
  const origin = `chrome-extension://${got.extensionId}/`;
  const child = childProcess.spawn(got.executable, [origin], { stdio: ['pipe', 'pipe', 'pipe'], env: f.env });
  const messages = [];
  let diagnostics = '';
  const framer = createNativeFramer({ onMessage: message => messages.push(message), onError: error => { throw error; } });
  child.stdout.on('data', bytes => framer.push(bytes));
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  const ended = once(child, 'close');
  const start = await readProcessStart(child.pid);
  const runtimeExecutable = JSON.parse(await fs.readFile(path.join(got.runtimeDirectory, 'native-host.json'), 'utf8')).runtime;
  t.diagnostic(`D exact Go fixture executable=${got.executable}; pid=${child.pid}; start=${start}`);
  try {
    // Read only this known-owned Go parent's direct child. No process-name
    // search, browser discovery, signaling or general process/session engine.
    let runtimePid, runtimeStart;
    for (const deadline = Date.now() + (process.platform === 'win32' ? 30000 : 10000); !runtimePid && Date.now() < deadline;) {
      assert.equal(await readProcessStart(child.pid), start);
      let text;
      if (process.platform === 'linux') text = await fs.readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8');
      else {
        const command = process.platform === 'win32' ? windowsPowerShellPath() : '/usr/bin/pgrep';
        const args = process.platform === 'win32'
          ? ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | ForEach-Object {$_.ProcessId}`]
          : ['-P', String(child.pid)];
        text = await new Promise((resolve, reject) => childProcess.execFile(command, args,
          { encoding: 'utf8', timeout: 5000, windowsHide: true },
          (error, stdout) => error && error.code !== 1 ? reject(error) : resolve(stdout || '')));
      }
      const candidate = Number(text.trim().split(/\s+/u)[0]) || undefined;
      // Go's own ACL inspection utilities can briefly be direct children too.
      // A PID is not enough to call one of those the selected Node runtime.
      const identity = candidate ? await readNativeProcess(candidate).catch(() => null) : null;
      if (identity?.parentPid === child.pid && identity.executable === runtimeExecutable) {
        runtimePid = identity.pid; runtimeStart = identity.startIdentity;
      }
      if (!runtimePid) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(runtimePid, 'actual Go-selected Node child identified before sending the frame');
    assert.notEqual(runtimeStart, null);
    t.diagnostic(`D exact Node fixture parent=${child.pid}; pid=${runtimePid}; start=${runtimeStart}`);
    child.stdin.end(Buffer.alloc(4)); // Zero-length native frame, no hello/provider RPC.
    const [exit, signal] = await ended;
    assert.equal(signal, null);
    assert.equal(exit, 1);
    framer.end();
    assert.deepEqual(messages, [{ event: 'diagnostic', code: 'NATIVE_FRAME_INVALID_LENGTH', stage: 'provider' }]);
    assert.match(diagnostics, /NATIVE_HOST_FAILED/u);
    assert.doesNotMatch(diagnostics, /ERR_MODULE_NOT_FOUND|NATIVE_ANCESTRY_MISMATCH|NATIVE_CONFIG_REFUSED/u);
    assert.notEqual(await readProcessStart(runtimePid), runtimeStart, 'exact owned Node generation is gone');
    t.diagnostic(`D exact Go fixture exited=${exit}; pid=${child.pid}; start=${start}; Node pid=${runtimePid} generation absent`);
  } finally {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    await ended;
  }
});

test('native install flushes private files through a writable handle', async t => {
  const f = await fixture(t), open = fs.open;
  t.mock.method(fs, 'open', async function (file, flags, ...args) {
    const handle = await open.call(this, file, flags, ...args), flush = handle.sync.bind(handle);
    handle.sync = async () => {
      // Windows FlushFileBuffers requires GENERIC_WRITE. This is an owned
      // OS-boundary simulation, not a claim to have run Windows on this host.
      if (flags === 'r') throw Object.assign(Error('read-only handle cannot flush'), { code: 'EPERM' });
      return flush();
    };
    return handle;
  });
  const got = await installNativeMessaging(f.options);
  assert.equal(got.continuity, 'unknown');
  assert.ok(await fs.lstat(got.registration.file));
});

for (const replacement of ['byte', 'directory']) {
  test(`native install refuses late capsule ${replacement} replacement before registration publication`, async t => {
    const f = await fixture(t), root = path.join(f.env.DESK_BROWSER_STATE_DIR, 'native-owned');
    const write = fs.writeFile;
    let replaced = false, foreign;
    t.mock.method(fs, 'writeFile', async function (file, ...args) {
      const result = await write.call(this, file, ...args);
      if (!replaced && /(?:com\.ourostack\.desk\.browser|host-manifest)\.json\..*\.tmp$/u.test(f.writePath(file))) {
        replaced = true;
        const [digest] = await fs.readdir(path.join(root, 'runtimes'));
        const capsule = path.join(root, 'runtimes', digest);
        foreign = path.join(capsule, 'mcp/native-host.mjs');
        if (replacement === 'directory') {
          await fs.rename(capsule, `${capsule}.owned-before`);
          await fs.mkdir(path.dirname(foreign), { recursive: true, mode: 0o700 });
          await write(foreign, 'foreign retained replacement', { mode: 0o600, flag: 'wx' });
        } else await fs.appendFile(foreign, '\n// foreign retained replacement\n');
      }

      return result;
    });
    await assert.rejects(installNativeMessaging(f.options), { code: 'NATIVE_RUNTIME_INTEGRITY' });
    assert.equal(replaced, true, 'race actually crossed the awaited registration staging write');
    assert.match(await fs.readFile(foreign, 'utf8'), /foreign retained replacement/u);
    const location = registrationLocation({ platform: process.platform, channel: 'msedge', userDataRoot: f.userDataDir });
    await assert.rejects(fs.lstat(location.file || path.join(root, 'host-manifest.json')), { code: 'ENOENT' });
  });
}

for (const window of ['verified-write', 'prelink']) {
  test(`registration staging replacement at ${window} never publishes or deletes foreign bytes`, async t => {
    const f = await fixture(t), lstat = fs.lstat, read = fsSync.readFileSync, readAsync = fs.readFile;
    let stage, verifiedRead = false, replaced = false;
    const foreign = Buffer.from('{"foreign":"retained staging replacement"}');
    function replace() {
      fsSync.renameSync(stage, `${stage}.owned-original`);
      fsSync.writeFileSync(stage, foreign, { mode: 0o600, flag: 'wx' });
      replaced = true;
    }
    t.mock.method(fs, 'lstat', async function (file, ...args) {
      const info = await lstat.call(this, file, ...args);
      if (/(?:com\.ourostack\.desk\.browser|host-manifest)\.json\..*\.tmp$/u.test(String(file))) {
        stage = String(file);
        if (verifiedRead && window === 'verified-write' && !replaced) replace();
      }
      return info;
    });
    t.mock.method(fs, 'readFile', async function (file, ...args) {
      const bytes = await readAsync.call(this, file, ...args);
      if (file === stage) verifiedRead = true;
      return bytes;
    });
    t.mock.method(fsSync, 'readFileSync', function (file, ...args) {
      const bytes = read.call(this, file, ...args);
      if (window === 'prelink' && stage && !replaced && file === path.join(f.env.DESK_BROWSER_STATE_DIR, 'current.json')) replace();
      return bytes;
    });
    await assert.rejects(installNativeMessaging(f.options), error => /^NATIVE_/u.test(error.code));
    assert.equal(replaced, true, 'the intended post-verification publication window was crossed');
    const location = registrationLocation({ platform: process.platform, channel: 'msedge', userDataRoot: f.userDataDir });
    await assert.rejects(fs.lstat(location.file || path.join(f.env.DESK_BROWSER_STATE_DIR, 'native-owned/host-manifest.json')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(stage), foreign, 'foreign staging name/bytes were not removed');
  });
}
