import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installNativeMessaging, updateNativeMessaging } from './native-messaging-install.mjs';

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
    if (['NATIVE_EXTENSION_UPDATE_REQUIRED', 'NATIVE_EXTENSION_RELOAD_REQUIRED'].includes(error.code)) {
      return unavailable('browser_native_messaging_update_required', 'The installed native extension needs a deliberate verified update',
        'Run the deliberate native setup update for this declared profile. It must quiesce exact owned effects, publish verified source, reload only our extension, and freshly attest the reconnected provider. Background refresh does not reload it; do not restart the shared browser.');
    }
    throw error;
  }
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
    if (ready.extensionSourceDigest !== own.extensionSourceDigest || !/^[a-f0-9]{64}$/u.test(own.extensionSourceDigest ?? '')) {
      return unavailable('browser_native_messaging_update_required', 'The running extension source differs from the verified installation',
        'Complete the deliberate native extension update and fresh provider attestation for this exact profile. Do not reload it during background refresh or restart the shared browser.');
    }
    const paths = platform === 'win32' ? path.win32 : path;
    const normalize = value => typeof value === 'string' && paths.isAbsolute(value)
      ? (platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value)) : null;
    const chain = ready.mediationChain;
    if (!normalize(own.executable) || !normalize(own.runtimeDirectory) || !Array.isArray(chain) || chain.length !== 2 ||
        normalize(chain[0]?.executable) !== normalize(own.executable) ||
        chain.some(identity => normalize(identity?.profileRoot) !== normalize(own.runtimeDirectory))) {
      return unavailable('browser_native_messaging_update_required', 'The loaded native provider does not match the installed runtime capsule',
        'Close all same-browser owners, then run the deliberate native update and freshly attest the provider. Backend-only upgrades also require this step. Do not restart the shared browser or reload while owners have live targets.');
    }
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
    extensionSourceDigest: own.extensionSourceDigest,
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
