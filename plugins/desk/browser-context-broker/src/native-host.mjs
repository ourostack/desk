import os from 'node:os';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { readFile, readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { BrokerError } from './claims.mjs';
import { readProcessStart, windowsPowerShellPath } from '../../mcp/src/readiness/process-start.js';

const MAX_NATIVE_BYTES = 1_048_576;
const decoder = new TextDecoder('utf-8', { fatal: true });
const littleEndian = os.endianness() === 'LE';
const execFileAsync = promisify(execFile);

function messageObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function encodeNativeMessage(message) {
  if (!messageObject(message)) {
    throw new BrokerError('NATIVE_FRAME_INVALID_MESSAGE', 'Native messages must be JSON objects');
  }
  const bytes = Buffer.from(JSON.stringify(message), 'utf8');
  if (bytes.length > MAX_NATIVE_BYTES) {
    throw new BrokerError('NATIVE_FRAME_TOO_LARGE', 'Native message exceeds the 1 MiB frame limit');
  }
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(bytes.length);
  else header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

function completeIdentity(identity, pid) {
    return identity?.pid === pid && Number.isSafeInteger(pid) && pid > 0 &&
      Number.isSafeInteger(identity.parentPid) && identity.parentPid > 0 &&
      typeof identity.startIdentity === 'string' && identity.startIdentity.trim() !== '' &&
      typeof identity.owner === 'string' && identity.owner.trim() !== '' &&
      typeof identity.executable === 'string' &&
      (path.isAbsolute(identity.executable) || path.win32.isAbsolute(identity.executable));
  }

  export async function readNativeProcess(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native process PID is invalid');
    }
    try {
      const startIdentity = await readProcessStart(pid);
      let parentPid;
      let owner;
      let executable;
      if (process.platform === 'linux') {
        const text = await readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        parentPid = Number(fields[1]);
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        owner = status.match(/^Uid:\s+(\d+)/mu)?.[1];
        executable = await readlink(`/proc/${pid}/exe`);
      } else if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('/bin/ps',
          ['-p', String(pid), '-o', 'ppid=', '-o', 'uid=', '-o', 'comm='],
          { encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
        const fields = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
        parentPid = Number(fields?.[1]);
        owner = fields?.[2];
        executable = fields?.[3];
      } else if (process.platform === 'win32') {
        const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if($o.ReturnValue -eq 0){@{pid=$p.ProcessId;parentPid=$p.ParentProcessId;owner=$o.Sid;executable=$p.ExecutablePath}|ConvertTo-Json -Compress}}`;
        const { stdout } = await execFileAsync(windowsPowerShellPath(),
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384, windowsHide: true });
        ({ parentPid, owner, executable } = JSON.parse(stdout));
      } else {
        throw new BrokerError('NATIVE_ANCESTRY_UNSUPPORTED', 'Native process identity is unsupported on this platform');
      }
      const identity = { pid, parentPid, owner, executable, startIdentity };
      if (!completeIdentity(identity, pid) || startIdentity !== await readProcessStart(pid)) {
        throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native process identity is incomplete or changed during observation');
      }
      return identity;
    } catch (cause) {
      if (cause instanceof BrokerError) throw cause;
      throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native process identity could not be read', { causeCode: cause.code });
    }
  }

async function observeNativeIdentity(processReader, pid) {
  try {
    return await processReader(pid);
  } catch (cause) {
    throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native process identity could not be observed', { causeCode: cause.code });
  }
}

  export async function readNativeAncestry(pid, { processReader = readNativeProcess } = {}) {
    const seen = new Set();
    const chain = [];
    for (let index = 0; index < 3; index++) {
      if (seen.has(pid)) {
        throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native ancestry contains a process cycle');
      }
      seen.add(pid);
      const identity = await observeNativeIdentity(processReader, pid);
      if (!completeIdentity(identity, pid)) {
        throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native ancestry requires complete process identities');
      }
      chain.push(identity);
      pid = identity.parentPid;
    }
    for (const recorded of chain) {
      const fresh = await observeNativeIdentity(processReader, recorded.pid);
      if (!completeIdentity(fresh, recorded.pid) ||
          ['pid', 'parentPid', 'startIdentity', 'owner', 'executable'].some(key => fresh[key] !== recorded[key])) {
        throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native ancestry changed during observation');
      }
    }
    return chain;
  }

  export async function runNativeHost({ stdin, stdout, config, processReader = readNativeProcess }) {
    if (!/^chrome-extension:\/\/[a-p]{32}\/$/u.test(config?.extensionOrigin ?? '') ||
        config.origin !== config.extensionOrigin) {
      throw new BrokerError('NATIVE_ORIGIN_REFUSED', 'Native caller does not match the configured extension');
    }
    const chain = await readNativeAncestry(config.pid ?? process.pid, { processReader });
    const [runtime, entry, browser] = chain;
    if (runtime.executable !== config.runtimeExecutable ||
        entry.executable !== config.entryExecutable || browser.executable !== config.browserExecutable ||
        chain.some(identity => identity.owner !== browser.owner) ||
        (config.expectedBrowser && ['pid', 'startIdentity', 'owner', 'executable'].some(
          key => browser[key] !== config.expectedBrowser[key]))) {
      throw new BrokerError('NATIVE_ANCESTRY_MISMATCH', 'Native transport is not bound to its configured browser and runtime');
    }
    if (typeof config.onMessage !== 'function') {
      throw new BrokerError('NATIVE_DISPATCH_REQUIRED', 'Native transport requires a message dispatcher');
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let inputEnded = false;
      let pending = 0;
      let dispatch = Promise.resolve();
      const cleanup = () => {
        stdin.off('data', onData);
        stdin.off('end', onEnd);
        stdin.off('error', fail);
        stdin.off('close', onInputClose);
        stdout.off('error', fail);
        stdout.off('close', onOutputClose);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        stdin.pause();
        reject(error);
      };
      const send = message => new Promise((sent, failed) => {
        if (settled) {
          failed(new BrokerError('NATIVE_TRANSPORT_CLOSED', 'Native transport is closed'));
          return;
        }
        let bytes;
        try {
          bytes = encodeNativeMessage(message);
        } catch (error) {
          failed(error);
          return;
        }
        stdout.write(bytes, error => error ? failed(error) : sent());
      });
      const framer = createNativeFramer({
        onError: fail,
        onMessage(message) {
          pending++;
          if (pending > 256) {
            fail(new BrokerError('NATIVE_QUEUE_FULL', 'Native dispatch queue exceeded its bounded capacity'));
            return;
          }
          dispatch = dispatch.then(async () => {
            if (settled) return;
            const response = await config.onMessage(message, { send, chain });
            if (response !== undefined) await send(response);
            pending--;
          });
          dispatch.catch(fail);
        },
      });
      const onData = bytes => framer.push(bytes);
      const onInputClose = () => {
        if (!inputEnded) fail(new BrokerError('NATIVE_TRANSPORT_CLOSED', 'Native input closed without a complete EOF'));
      };
      const onOutputClose = () => fail(new BrokerError('NATIVE_TRANSPORT_CLOSED', 'Native output closed before transport completion'));
      const onEnd = () => {
        inputEnded = true;
        framer.end();
        dispatch.then(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ closed: true });
        }, fail);
      };
      stdin.on('error', fail);
      stdin.on('close', onInputClose);
      stdout.on('error', fail);
      stdout.on('close', onOutputClose);
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      if (stdin.destroyed || stdout.destroyed) {
        fail(new BrokerError('NATIVE_TRANSPORT_CLOSED', 'Native transport streams were already closed'));
      }
    });
  }
export function createNativeFramer({ onMessage, onError, maxBytes = MAX_NATIVE_BYTES }) {
  if (typeof onMessage !== 'function' || typeof onError !== 'function' ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_NATIVE_BYTES) {
    throw new BrokerError('NATIVE_FRAME_INVALID_OPTIONS', 'Native framing requires bounded message and error handlers');
  }
  let header = Buffer.alloc(4);
  let headerBytes = 0;
  let body = null;
  let bodyBytes = 0;
  let ended = false;
  const fail = (code, message) => {
    ended = true;
    header = null;
    body = null;
    onError(new BrokerError(code, message));
  };
  return {
    push(chunk) {
      if (ended) return;
      if (!Buffer.isBuffer(chunk)) {
        fail('NATIVE_FRAME_INVALID_INPUT', 'Native framing requires byte buffers');
        return;
      }
      let offset = 0;
      while (offset < chunk.length && !ended) {
        if (body === null) {
          const copied = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + copied);
          headerBytes += copied;
          offset += copied;
          if (headerBytes !== 4) continue;
          const size = littleEndian ? header.readUInt32LE(0) : header.readUInt32BE(0);
          if (size === 0 || size > maxBytes) {
            fail(size === 0 ? 'NATIVE_FRAME_INVALID_LENGTH' : 'NATIVE_FRAME_TOO_LARGE',
              'Native frame length is outside its supported bounds');
            return;
          }
          body = Buffer.alloc(size);
        }
        const copied = Math.min(body.length - bodyBytes, chunk.length - offset);
        chunk.copy(body, bodyBytes, offset, offset + copied);
        bodyBytes += copied;
        offset += copied;
        if (bodyBytes !== body.length) continue;
        let text;
        try {
          text = decoder.decode(body);
        } catch {
          fail('NATIVE_FRAME_INVALID_UTF8', 'Native message contains invalid UTF-8');
          return;
        }
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          fail('NATIVE_FRAME_INVALID_JSON', 'Native message is not valid JSON');
          return;
        }
        if (!messageObject(message)) {
          fail('NATIVE_FRAME_INVALID_MESSAGE', 'Native messages must be JSON objects');
          return;
        }
        headerBytes = 0;
        body = null;
        bodyBytes = 0;
        onMessage(message);
      }
    },
    end() {
      if (ended) return;
      if (headerBytes !== 0 || body !== null) {
        fail('NATIVE_FRAME_INCOMPLETE', 'Native transport ended during a frame');
        return;
      }
      ended = true;
    },
  };
}
