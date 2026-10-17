import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { BrokerError } from './broker-error.mjs';
import { ensureStateDirectory } from './private-state.mjs';

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const execFileAsync = promisify(execFile);

async function readProcessStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Process PID is invalid');
  }
  if (process.platform === 'linux') {
    try {
      const processStat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = processStat.slice(processStat.lastIndexOf(')') + 2).split(' ');
      const startTicks = fields[19];
      if (!startTicks) throw new Error('Process start identity is unavailable');
      return `linux:${startTicks}`;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined;
      throw error;
    }
  }
  if (process.platform === 'darwin') {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return undefined;
      if (error.code !== 'EPERM') throw error;
    }
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', maxBuffer: 4_096 },
    );
    const startIdentity = stdout.trim();
    if (!startIdentity) throw new Error('Process start identity is unavailable');
    return `darwin:${startIdentity}`;
  }
  if (process.platform === 'win32') {
    const { readProcessStart } = await import('../readiness/process-start.js');
    const identity = await readProcessStart(pid);
    if (identity === null) throw new Error('Windows process start identity is unavailable');
    return identity;
  }
  throw new Error(`Process start identity is unsupported on ${process.platform}`);
}

/**
 * Read this process's own start identity, keeping it once read: a process's start never changes. A failed or empty
 * read is tried once more before it is reported. On a loaded Windows machine the PowerShell read can hit its 5 s cap
 * while the next one returns in well under a second, and without an identity the lock cannot be taken at all.
 */
export function ownIdentityReader(read, { pid = process.pid } = {}) {
  // Concurrent first acquisitions share one read; a read that fails is forgotten so the next acquisition reads again.
  let pending;
  async function attempt() {
    try {
      const identity = await read(pid);
      if (identity) return identity;
    } catch {
      // Read once more below.
    }
    return read(pid);
  }
  return () => {
    pending ??= attempt().then(
      (identity) => {
        if (!identity) pending = undefined;
        return identity;
      },
      (error) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}

const readOwnStartIdentity = ownIdentityReader(readProcessStartIdentity);

async function inspectOwner(owner, processIdentityReader) {
  if (
    !owner ||
    typeof owner.token !== 'string' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.startIdentity !== 'string' ||
    !owner.startIdentity
  ) {
    return 'unknown';
  }
  try {
    const observedStartIdentity = await processIdentityReader(owner.pid);
    if (observedStartIdentity === undefined) return 'absent';
    return observedStartIdentity === owner.startIdentity ? 'alive' : 'replaced';
  } catch {
    return 'unknown';
  }
}

function parseOwner(content) {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function isCompleteOwner(owner) {
  return Boolean(
    owner &&
    typeof owner.token === 'string' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.startIdentity === 'string' &&
    owner.startIdentity &&
    typeof owner.createdAt === 'string' &&
    Number.isFinite(Date.parse(owner.createdAt)),
  );
}

async function readLockEvidence(lockPath) {
  const lockStat = await stat(lockPath);
  // The file id is read as a BigInt: on Windows it can exceed 2^53, where a Number cannot tell two files apart.
  const lockId = await stat(lockPath, { bigint: true });
  const names = (await readdir(lockPath)).sort();
  const files = [];
  for (const name of names) {
    if (name !== 'owner.json' && !/^\.owner-.*\.tmp$/u.test(name)) continue;
    const content = await readFile(path.join(lockPath, name), 'utf8').catch(
      () => undefined,
    );
    files.push({ name, content });
  }
  const ownerContent = files.find(({ name }) => name === 'owner.json')?.content;
  const tempOwners = files
    .filter(({ name }) => name !== 'owner.json')
    .map(({ content }) => parseOwner(content))
    .filter(isCompleteOwner);
  return {
    lockStat,
    owner: parseOwner(ownerContent),
    tempOwners,
    fingerprint: JSON.stringify({
      dev: String(lockId.dev),
      ino: String(lockId.ino),
      mtimeMs: lockStat.mtimeMs,
      files,
    }),
  };
}

async function publishOwnerAtomically(lockPath, owner) {
  const temporaryPath = path.join(lockPath, `.owner-${owner.token}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(owner), { mode: 0o600 });
  if (process.platform === 'win32') {
    const { protectWindowsPaths } = await import('../factory/windows-acl.js');
    await protectWindowsPaths([{ path: temporaryPath, kind: 'file', created: true }], { label: 'desk_browser_lock' });
  }
  await rename(temporaryPath, path.join(lockPath, 'owner.json'));
}

export async function withBrokerLock(stateDir, fn, options = {}) {
  const {
    name = 'broker',
    timeoutMs = 5_000,
    pollMs = 10,
    staleMs = 30_000,
    processIdentityReader = readProcessStartIdentity,
    readOwnIdentity = processIdentityReader === readProcessStartIdentity
      ? readOwnStartIdentity
      : () => processIdentityReader(process.pid),
    ownerPublisher = publishOwnerAtomically,
  } = options;
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
    throw new BrokerError('INVALID_LOCK_NAME', 'Broker lock name contains unsupported path syntax', {
      name,
    });
  }
  await ensureStateDirectory(stateDir);
  const lockPath = path.join(stateDir, `${name}.lock`);
  const token = randomUUID();
  let startIdentity;
  try {
    startIdentity = await readOwnIdentity();
  } catch (cause) {
    throw new BrokerError(
      'BROKER_LOCK_IDENTITY_UNAVAILABLE',
      'Broker lock owner process identity could not be determined',
      { name, cause: cause.message },
    );
  }
  if (!startIdentity) {
    throw new BrokerError(
      'BROKER_LOCK_IDENTITY_UNAVAILABLE',
      'Broker lock owner process identity could not be determined',
      { name },
    );
  }

  // The wait for the lock starts after this process's identity is known, so a slow identity read does not use it up.
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await ensureStateDirectory(lockPath);
        await ownerPublisher(lockPath, {
          token,
          pid: process.pid,
          startIdentity,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let evidence;
      try {
        evidence = await readLockEvidence(lockPath);
      } catch (evidenceError) {
        if (evidenceError.code === 'ENOENT') continue;
        throw evidenceError;
      }
      const owner = isCompleteOwner(evidence.owner) ? evidence.owner : undefined;
      const createdAtMs = owner
        ? Date.parse(owner.createdAt)
        : evidence.lockStat.birthtimeMs || evidence.lockStat.ctimeMs;
      const lockAge = Date.now() - createdAtMs;
      if (lockAge > staleMs) {
        let ownerState = owner
          ? await inspectOwner(owner, processIdentityReader)
          : 'absent';
        if (!owner) {
          for (const tempOwner of evidence.tempOwners) {
            const tempOwnerState = await inspectOwner(
              tempOwner,
              processIdentityReader,
            );
            if (tempOwnerState === 'alive' || tempOwnerState === 'unknown') {
              ownerState = tempOwnerState;
              break;
            }
          }
        }
        if (ownerState !== 'absent' && ownerState !== 'replaced') {
          throw new BrokerError('STALE_BROKER_LOCK', `Broker lock "${name}" is stale`, {
            name,
            ageMs: lockAge,
            ownerState,
          });
        }
        const currentEvidence = await readLockEvidence(lockPath).catch(
          (currentError) => {
            if (currentError.code === 'ENOENT') return undefined;
            throw currentError;
          },
        );
        if (!currentEvidence) continue;
        if (currentEvidence.fingerprint !== evidence.fingerprint) {
          throw new BrokerError(
            'STALE_BROKER_LOCK',
            `Broker lock "${name}" changed during stale-owner verification`,
            { name, ageMs: lockAge, ownerState: 'unknown' },
          );
        }
        const reclaimedPath = path.join(
          stateDir,
          `.${name}.reclaimed-${token}-${randomUUID()}`,
        );
        try {
          await rename(lockPath, reclaimedPath);
        } catch (renameError) {
          if (renameError.code === 'ENOENT') continue;
          throw renameError;
        }
        await rm(reclaimedPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new BrokerError('BROKER_LOCK_TIMEOUT', `Timed out waiting for broker lock "${name}"`, {
          name,
          timeoutMs,
        });
      }
      await delay(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
      if (owner.token === token) await rm(lockPath, { recursive: true });
    } catch {
      // An externally removed lock is already released.
    }
  }
}
