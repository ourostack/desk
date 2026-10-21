import { mkdir, stat } from 'node:fs/promises';
import { BrokerError } from './broker-error.mjs';

export async function ensureStateDirectory(stateDir) {
  const created = await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const metadata = await stat(stateDir);
  if (!metadata.isDirectory()) {
    throw new BrokerError('INVALID_STATE_DIRECTORY', 'Broker state path is not a directory');
  }
  if (process.platform === 'win32') {
    const { protectWindowsPaths } = await import('../../../mcp/src/factory/windows-acl.js');
    await protectWindowsPaths([{ path: stateDir, kind: 'directory', created: created !== undefined }], { label: 'desk_browser_state' });
  } else if ((metadata.mode & 0o077) !== 0) {
    throw new BrokerError(
      'INSECURE_STATE_DIRECTORY',
      'Broker state directory must not be accessible by group or other users',
      { mode: (metadata.mode & 0o777).toString(8) },
    );
  }
}
