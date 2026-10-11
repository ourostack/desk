import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import { runNativeHost, assertNativeReady, nativeDiagnosticLine } from '../src/native-host.mjs';
import { NativeCommandTransport } from '../src/native-cdp.mjs';
import { startNativeProvider } from '../src/native-provider.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const config = JSON.parse(await readFile(path.join(root, 'provider-config.json'), 'utf8'));
const require = createRequire(import.meta.url);
const profile = require(path.join(root, 'plugins/desk/mcp/web-real-profile.cjs'));
let transport;
let provider;
let initialization;
try {
  await runNativeHost({
    stdin: process.stdin, stdout: process.stdout,
    config: {
      origin: process.argv[2], extensionOrigin: config.extensionOrigin,
      runtimeExecutable: config.runtimeExecutable, entryExecutable: config.entryExecutable,
      browserExecutable: config.browserExecutable,
      onMessage(message, { send, chain }) {
        if (message.event !== 'ready') {
          transport?.receive(message);
          return;
        }
        if (transport) {
          throw new Error('NATIVE_PROTOCOL_MISMATCH');
        }
        assertNativeReady(message, config);
        transport = new NativeCommandTransport({ send });
        initialization = (async () => {
          let expected;
          for (let attempt = 0; attempt < 100; attempt++) {
            expected = await profile.readExtensionToken(config.profileRoot, {
              level: require(config.levelModule), tmpdir: config.stateDir,
              extensionId: config.extensionId, tokenKey: 'deskBrowserProfileToken',
            });
            if (expected) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!/^[a-f0-9]{64}$/u.test(message.profileToken ?? '') || expected !== message.profileToken) {
            throw new Error('NATIVE_PROFILE_MISMATCH');
          }
          const processIdentity = { ...chain[2], profileRoot: config.profileRoot };
          const mediationChain = [chain[1], chain[0]].map(identity => ({ ...identity, profileRoot: root }));
          provider = await startNativeProvider({
            stateDir: config.stateDir, transport, contextIdentity: {
              processIdentity, mediationChain, endpointProcessIdentity: mediationChain[1],
              transportGeneration: randomUUID(), profileToken: expected,
              browserVersion: message.browserVersion, userAgent: message.userAgent, protocolVersion: '1.3',
              extensionSourceDigest: message.sourceDigest,
            },
          });
        })();
        initialization.catch(error => {
          process.stderr.write(nativeDiagnosticLine(error, 'NATIVE_PROVIDER_START_FAILED') + '\n');
          process.stdin.destroy();
        });
      },
    },
  });
  await initialization;
} catch (error) {
  process.stderr.write(nativeDiagnosticLine(error, 'NATIVE_HOST_FAILED') + '\n');
  process.exitCode = 1;
} finally {
  transport?.close();
  await provider?.close();
}
