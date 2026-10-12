import { readFile } from 'node:fs/promises';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { runNativeHost, assertNativeReady, nativeDiagnosticLine, reportNativeDiagnostic } from '../src/native-host.mjs';
import { NativeCommandTransport } from '../src/native-cdp.mjs';
import { startNativeProvider } from '../src/native-provider.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const config = JSON.parse(await readFile(path.join(root, 'provider-config.json'), 'utf8'));
// The browser discards a native host's stderr, so its diagnostic lines (codes only, never endpoints or tokens) are also kept in a
// small private log beside the provider's state; without it, why a host ended could not be told afterwards.
const logFile = path.join(config.stateDir, 'native-host.log');
const writeError = process.stderr.write.bind(process.stderr);
function keep(line) {
  try {
    if (statSync(logFile).size > 262_144) renameSync(logFile, logFile + '.1');
  } catch {
    // No log yet.
  }
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${process.pid} ${line}`, { mode: 0o600 });
  } catch {
    // Logging never ends the host.
  }
}
process.stderr.write = (chunk, ...rest) => {
  keep(String(chunk).endsWith('\n') ? String(chunk) : String(chunk) + '\n');
  return writeError(chunk, ...rest);
};
keep('NATIVE_HOST_STARTED\n');
process.on('exit', code => keep(`NATIVE_HOST_EXITED ${code}\n`));
let transport;
let provider;
let initialization;
let stage = 'native-ancestry';
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
        stage = 'profile-token';
        assertNativeReady(message, config);
        transport = new NativeCommandTransport({ send });
        initialization = (async () => {
          const processIdentity = { ...chain[2], profileRoot: config.profileRoot };
          const mediationChain = [chain[1], chain[0]].map(identity => ({ ...identity, profileRoot: root }));
          stage = 'provider';
          provider = await startNativeProvider({
            stateDir: config.stateDir, transport, contextIdentity: {
              processIdentity, mediationChain, endpointProcessIdentity: mediationChain[1],
              transportGeneration: randomUUID(), profileToken: config.expectedProfileToken,
              browserVersion: message.browserVersion, userAgent: message.userAgent, protocolVersion: '1.3',
              extensionSourceDigest: message.sourceDigest,
            },
          });
        })();
        initialization.catch(async error => {
          try {
            await reportNativeDiagnostic({ stdout: process.stdout, stderr: process.stderr, stage }, error, 'NATIVE_PROVIDER_START_FAILED');
          } finally {
            process.stdin.destroy();
          }
        }).catch(error => {
          process.stderr.write(nativeDiagnosticLine(error, 'NATIVE_DIAGNOSTIC_FAILED') + '\n');
          process.exitCode = 1;
        });
      },
    },
  });
  await initialization;
} catch (error) {
  process.exitCode = 1;
  try {
    await reportNativeDiagnostic({ stdout: process.stdout, stderr: process.stderr, stage }, error, 'NATIVE_HOST_FAILED');
  } catch (error) {
    process.stderr.write(nativeDiagnosticLine(error, 'NATIVE_DIAGNOSTIC_FAILED') + '\n');
  }
} finally {
  transport?.close();
  await provider?.close();
}
