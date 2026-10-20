// Go selects this exact Node module and passes only the extension origin.
// Capsule publication/config construction belong to D, not this entry.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import client from './web-native-messaging.cjs';
import { BrokerError } from './src/util/broker-error.mjs';
import { runNativeHost, reportNativeDiagnostic, readNativeProcess, readNativeAncestry } from './src/browser/native-host.mjs';
import { NativeCommandTransport } from './src/browser/native-transport.mjs';
import { startNativeProvider, validateNativeHostConfig } from './src/browser/native-provider.mjs';
import { createNativeUpdateProof } from './src/browser/native-update-proof.mjs';

export async function runNativeEntry({ stdin, stdout, stderr, origin,
  configFile = new URL('./provider-config.json', import.meta.url),
  processReader = readNativeProcess, providerOptions = {} }) {
  if (configFile instanceof URL) configFile = fileURLToPath(configFile);
  const config = validateNativeHostConfig(client.readPrivateJson(configFile, { maxBytes: 16384 }));
  return runConfiguredNativeEntry({ stdin, stdout, stderr, origin, config, processReader, providerOptions });
}

export async function runNativeBootstrapEntry({ stdin, stdout, stderr, origin,
  configFile = new URL('./bootstrap-config.json', import.meta.url),
  processReader = readNativeProcess, providerOptions = {} }) {
  if (configFile instanceof URL) configFile = fileURLToPath(configFile);
  const config = client.readPrivateJson(configFile, { maxBytes: 16384 });
  const fields = ['version', 'extensionId', 'extensionOrigin', 'extensionSourceDigest', 'runtimeExecutable',
    'entryExecutable', 'browserExecutable', 'browserOwner', 'channel', 'userDataDir', 'profileDirName',
    'profileRoot', 'pluginDirs', 'nativeReadyFile', 'browserStateRoot', 'cliDir'];
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(config, key)) ||
      typeof config.browserOwner !== 'string' || !config.browserOwner || /[\u0000-\u001f\u007f]/u.test(config.browserOwner))
    throw new BrokerError('NATIVE_CONFIG_INVALID', 'NATIVE_CONFIG_INVALID');
  const chain = await readNativeAncestry(process.pid, { processReader });
  if (chain[0].executable !== config.runtimeExecutable || chain[1].executable !== config.entryExecutable ||
      chain[2].executable !== config.browserExecutable || chain.some(row => row.owner !== config.browserOwner))
    throw new BrokerError('NATIVE_ANCESTRY_MISMATCH', 'NATIVE_ANCESTRY_MISMATCH');
  const { browserOwner, ...selection } = config;
  const bound = validateNativeHostConfig({ ...selection, expectedBrowser: chain[2] });
  return runConfiguredNativeEntry({ stdin, stdout, stderr, origin, config: bound, processReader, providerOptions });
}

async function runConfiguredNativeEntry({ stdin, stdout, stderr, origin, config, processReader, providerOptions }) {
  const proof = createNativeUpdateProof(config);
  let transport, provider, initializing, failure;
  const stopNative = () => transport?.close();
  stdin.once('end', stopNative);
  stdin.once('close', stopNative);
  try {
    await runNativeHost({ stdin, stdout, processReader, config: {
      ...config, origin,
      onMessage(message, { send, chain }) {
        if (message.event === 'ready') {
          if (initializing) throw new BrokerError('NATIVE_PROTOCOL_MISMATCH', 'NATIVE_PROTOCOL_MISMATCH');
          transport = new NativeCommandTransport({ send });
          // Never await initialization in the frame path. Authorized requests
          // and their profile.read replies share this same stream.
          initializing = startNativeProvider({ ...providerOptions, config, ready: message, chain, transport, processReader,
            verifyContinuity: proof.verifyContinuity, onAdmitted: proof.onAdmitted })
            .then(value => { provider = value; return value; });
          initializing.catch(error => {
            failure = error; transport.close(); stdin.destroy();
          });
          return;
        }
        if (!transport) throw new BrokerError('NATIVE_PROTOCOL_MISMATCH', 'NATIVE_PROTOCOL_MISMATCH');
        transport.receive(message);
      },
    } });
    await initializing;
    if (!initializing) throw new BrokerError('NATIVE_PROTOCOL_MISMATCH', 'NATIVE_PROTOCOL_MISMATCH');
    if (failure) throw failure;
    return { closed: true };
  } catch (error) {
    await reportNativeDiagnostic({ stdout, stderr, stage: 'provider' }, failure || error, 'NATIVE_PROVIDER_START_FAILED');
    throw new BrokerError('NATIVE_PROVIDER_START_FAILED', 'NATIVE_PROVIDER_START_FAILED');
  } finally {
    transport?.close();
    if (initializing) {
      try { await initializing; } catch {}
    }
    try { await provider?.close(); }
    finally {
      stdin.off('end', stopNative);
      stdin.off('close', stopNative);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    process.stderr.write('NATIVE_HOST_REFUSED\n');
    process.exitCode = 2;
  } else {
    runNativeEntry({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, origin: process.argv[2] })
      .catch(() => { process.stderr.write('NATIVE_HOST_FAILED\n'); process.exitCode = 1; });
  }
}
