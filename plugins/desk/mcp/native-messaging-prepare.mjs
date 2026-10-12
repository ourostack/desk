import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installNativeMessaging, updateNativeMessaging } from './native-messaging-install.mjs';
import { compareVersions, readDeskVersion, readVersions, versionOf } from './native-messaging-versions.mjs';

const require = createRequire(import.meta.url);
const profile = require('./web-real-profile.cjs');
const native = require('./web-native-messaging.cjs');

function unavailable(code, summary, fix) {
  return { payload: { status: 'degraded', state: 'degraded:' + code, code, summary, fix } };
}

// The provider removes its readiness file when it stops, and the browser starts a new one when its extension reconnects, within a
// few seconds. A missing file is waited for before anything is concluded from it.
async function lstatWhenReady(file, { waitMs = 10_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await fs.lstat(file);
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
}

function providerNotRunning(file) {
  return unavailable('browser_native_provider_not_running',
    `The native browser provider is not running: its readiness file ${file} is missing.`,
    'The Desk extension in the signed-in browser starts the provider, and Desk waited for it. Check that the browser is running with the Desk extension enabled, then try again. If the file stays missing while the browser runs, the provider is failing as it starts: report it as desk:desk-problem says. Do not restart the shared browser.');
}

export async function prepareNativeMessaging(options) {
  const { declaration, installed, executable, platform, homeDir, root, mcpRoot, env = process.env } = options;
  if (!executable) return unavailable('browser_missing', 'The declared browser is not installed', 'Install the declared browser and reconnect desk-web.');
  const userDataRoot = profile.userDataDir(declaration.channel, platform, env, homeDir);
  const selected = profile.findProfileDir(path.join(userDataRoot, 'Local State'), declaration.domain);
  if (!selected) {
    return unavailable('browser_profile_missing', 'The declared signed-in browser profile is unavailable',
      'Sign in to the declared account domain in the browser and reconnect desk-web. No browser operation was forwarded.');
  }
  if (options.update === true) {
    const stateDir = path.join(root, 'native-owned/state');
    const file = path.join(stateDir, `native-provider-${createHash('sha256')
      .update(executable + '\0' + path.join(userDataRoot, selected)).digest('hex')}.json`);
    let info;
    try {
      info = await lstatWhenReady(file, options.readyWait);
    } catch (error) {
      if (error.code === 'ENOENT') return providerNotRunning(file);
      throw error;
    }
    if (!info.isFile() || info.nlink !== 1 || info.size > 16384 ||
        (platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) {
      throw Object.assign(new Error('Native update readiness is not private'), { code: 'NATIVE_READINESS_NOT_PRIVATE' });
    }
    const ready = JSON.parse(await fs.readFile(file, 'utf8'));
    if (ready.version !== 1 || ready.processIdentity?.executable !== executable ||
        ready.processIdentity?.profileRoot !== path.join(userDataRoot, selected)) {
      throw Object.assign(new Error('Native update readiness does not match the declared profile'), { code: 'NATIVE_READINESS_PROFILE_MISMATCH' });
    }
    const attested = await native.providerRequest(ready.endpoint, 'attest', { expectedProcessIdentity: ready.processIdentity });
    if (attested.healthy !== true) {
      throw Object.assign(new Error('Native update requires a live exact provider'), { code: 'NATIVE_MEDIATOR_UNAVAILABLE' });
    }
    // An update never moves the browser to an older release than the one it runs.
    const versions = await readVersions(path.join(root, 'native-owned'));
    const deskVersion = await readDeskVersion(mcpRoot);
    const loadedRuntime = path.basename(ready.mediationChain?.[0]?.profileRoot ?? '');
    const loadedCapsule = compareVersions(versionOf(versions, 'capsules', loadedRuntime), deskVersion);
    const loadedExtension = compareVersions(versionOf(versions, 'extensions', ready.extensionSourceDigest), deskVersion);
    if (loadedCapsule > 0 || loadedExtension > 0) {
      throw Object.assign(new Error('The browser runs a newer Desk release than this copy'), { code: 'NATIVE_UPDATE_WOULD_DOWNGRADE' });
    }
    // Another session already moved the browser to this release.
    if (loadedCapsule === 0 && loadedExtension === 0 && deskVersion !== null) return { updated: false, current: true, profile: selected };
    await (options.updater ?? updateNativeMessaging)({
      mcpRoot, root: path.join(root, 'native-owned'), userDataRoot, profile: selected, channel: declaration.channel,
      browserExecutable: executable, runtimeExecutable: options.runtimeExecutable,
      levelModule: path.join(installed.dir, 'node_modules/classic-level'), wsModule: path.join(installed.dir, 'node_modules/ws'),
      platform, arch: options.arch ?? process.arch, providerEndpoint: ready.endpoint,
      expectedProcessIdentity: ready.processIdentity,
    });
    return { updated: true, reconciliationRequired: true, profile: selected };
  }
  let own;
  try {
    own = await (options.installer ?? installNativeMessaging)({
      mcpRoot, root: path.join(root, 'native-owned'), userDataRoot, profile: selected, channel: declaration.channel,
      browserExecutable: executable, runtimeExecutable: options.runtimeExecutable,
      levelModule: path.join(installed.dir, 'node_modules/classic-level'),
      wsModule: path.join(installed.dir, 'node_modules/ws'), platform, arch: options.arch ?? process.arch,
    });
  } catch (error) {
    if (error.code === 'NATIVE_EXTENSION_UPDATE_REQUIRED') {
      return unavailable('browser_native_messaging_update_required', 'The native extension folder holds source that no Desk release shipped',
        'Desk does not drive a browser through extension source it cannot verify. Report it as desk:desk-problem says. Do not restart the shared browser.');
    }
    throw error;
  }
  const versions = await readVersions(path.join(root, 'native-owned'));
  // This Desk copy's runtime or extension is newer than what the browser runs: the automatic guarded update moves the browser to
  // it once no session owns tabs. Until then the loaded provider serves this session. An older copy never updates a newer browser.
  let updatePending = own.reloadPending === true;
  const readyFile = path.join(own.stateDir, `native-provider-${createHash('sha256')
    .update(executable + '\0' + path.join(userDataRoot, selected)).digest('hex')}.json`);
  let ready;
  try {
    const info = await lstatWhenReady(readyFile, options.readyWait);
    if (!info.isFile() || info.size > 16384 || (platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw new Error('NATIVE_READINESS_NOT_PRIVATE');
    }
    ready = JSON.parse(await fs.readFile(readyFile, 'utf8'));
    if (ready.version !== 1 || ready.processIdentity?.executable !== executable ||
        ready.processIdentity?.profileRoot !== path.join(userDataRoot, selected)) {
      throw new Error('NATIVE_READINESS_PROFILE_MISMATCH');
    }
    if (!/^[a-f0-9]{64}$/u.test(ready.extensionSourceDigest ?? '') || !/^[a-f0-9]{64}$/u.test(own.extensionSourceDigest ?? '')) {
      throw new Error('NATIVE_EXTENSION_SOURCE_INVALID');
    }
    if (ready.extensionSourceDigest !== own.extensionSourceDigest &&
        compareVersions(own.deskVersion, versionOf(versions, 'extensions', ready.extensionSourceDigest)) > 0) updatePending = true;
    const paths = platform === 'win32' ? path.win32 : path;
    const normalize = value => typeof value === 'string' && paths.isAbsolute(value)
      ? (platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value)) : null;
    const chain = ready.mediationChain;
    // The loaded provider runs from one of this installation's runtime capsules, which may belong to another Desk copy.
    const runtimes = normalize(path.join(root, 'native-owned', 'runtimes'));
    const loadedRuntime = Array.isArray(chain) && chain.length === 2 ? normalize(chain[0]?.profileRoot) : null;
    if (!normalize(own.executable) || !normalize(own.runtimeDirectory) || !runtimes || !loadedRuntime ||
        paths.dirname(loadedRuntime) !== runtimes ||
        normalize(chain[0]?.executable) !== normalize(paths.join(loadedRuntime, paths.basename(own.executable))) ||
        chain.some(identity => normalize(identity?.profileRoot) !== loadedRuntime)) {
      return unavailable('browser_native_messaging_unavailable', 'The loaded native provider does not run from this installation',
        'Inspect the exact native setup and reconnect desk-web. No focusing fallback or browser-global attachment is permitted.');
    }
    if (loadedRuntime !== normalize(own.runtimeDirectory) &&
        compareVersions(own.deskVersion, versionOf(versions, 'capsules', paths.basename(loadedRuntime))) > 0) updatePending = true;
    const endpoint = new URL(ready.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
        !/^\/provider\/[a-f0-9]{64}$/u.test(endpoint.pathname) || endpoint.search || endpoint.username || endpoint.password) {
      throw new Error('NATIVE_READINESS_ENDPOINT_INVALID');
    }
    const attested = await native.providerRequest(ready.endpoint, 'attest', { expectedProcessIdentity: ready.processIdentity });
    if (attested.healthy !== true) throw new Error('NATIVE_MEDIATOR_UNAVAILABLE');
  } catch (error) {
    if (error.code !== 'ENOENT' && !['ECONNREFUSED', 'NATIVE_MEDIATOR_UNAVAILABLE'].includes(error.code ?? error.message)) {
      return unavailable('browser_native_messaging_unavailable', 'The native browser provider could not be verified',
        'Inspect the exact native setup and reconnect desk-web. No focusing fallback or browser-global attachment is permitted.');
    }
    return unavailable('browser_native_messaging_setup_required', 'The native browser extension is not connected to the declared profile' +
      (error.code === 'ENOENT' ? ` (the provider's readiness file ${readyFile} is missing)` : ''),
      'One-time developer setup: in the declared browser profile open its Extensions page, enable Developer mode, choose Load Unpacked and select ' +
      own.extensionDirectory + '. This is local sideloading, not an extension-store installation. Chrome/Edge 125 or newer is required. Reconnect desk-web; do not enable browser debugging or restart the shared browser.');
  }
  return {
    providerEndpoint: ready.endpoint, readyFile, processIdentity: ready.processIdentity,
    extensionSourceDigest: ready.extensionSourceDigest, updatePending,
    profile: selected, app: declaration.channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome',
    args: ['--init-page', path.join(mcpRoot, 'scripts/native-owned-page.cjs')],
    env: {}, secrets: [ready.endpoint],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1048576) throw new Error('NATIVE_PREPARE_INPUT_TOO_LARGE');
    }
    const result = await prepareNativeMessaging(JSON.parse(input));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write((error.code ?? 'NATIVE_PREPARE_FAILED') + '\n');
    process.exitCode = 1;
  }
}
