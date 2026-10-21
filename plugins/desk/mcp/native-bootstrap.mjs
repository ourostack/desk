import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeBootstrapEntry } from './native-host.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    process.stderr.write('NATIVE_HOST_REFUSED\n');
    process.exitCode = 2;
  } else {
    runNativeBootstrapEntry({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, origin: process.argv[2] })
      .catch(() => { process.stderr.write('NATIVE_HOST_FAILED\n'); process.exitCode = 1; });
  }
}
