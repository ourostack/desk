// Minimal native foundation ported from ourostack/desk at
// 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f:
// browser-context-broker/src/native-host.mjs (framing and ancestry), and
// native-provider.mjs (exclusive readiness reservation / exact inode close).
// No provider, registry, lease, window or CDP engine is included.
import os from 'node:os';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { open, lstat, unlink, readFile, readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrokerError } from '../util/broker-error.mjs';
import { ensureStateDirectory } from '../util/private-state.mjs';
import { protectLeafFile } from '../factory/os-protect.js';
import { readProcessStart, windowsPowerShellPath } from '../readiness/process-start.js';

const MAX_NATIVE_BYTES = 1_048_576;
const decoder = new TextDecoder('utf-8', { fatal: true });
const littleEndian = os.endianness() === 'LE';
const execFileAsync = promisify(execFile);
const DIAGNOSTIC_STAGES = new Set(['native-ancestry', 'profile-token', 'provider']);
const DIAGNOSTIC_SYSCALLS = new Set(['open', 'read', 'write', 'copyfile', 'mkdir', 'listen', 'unlink', 'rename', 'stat', 'lstat', 'scandir', 'rmdir']);
const CODES = new Set([
  'NATIVE_HOST_FAILED', 'NATIVE_PROVIDER_START_FAILED', 'NATIVE_DIAGNOSTIC_FAILED',
  'NATIVE_PROTOCOL_MISMATCH', 'NATIVE_EXTENSION_SOURCE_MISMATCH', 'NATIVE_PROFILE_TOKEN_UNAVAILABLE',
  'NATIVE_PROFILE_MISMATCH', 'NATIVE_FRAME_INVALID_MESSAGE', 'NATIVE_FRAME_TOO_LARGE',
  'NATIVE_FRAME_INVALID_OPTIONS', 'NATIVE_FRAME_INVALID_INPUT', 'NATIVE_FRAME_INVALID_LENGTH',
  'NATIVE_FRAME_INVALID_UTF8', 'NATIVE_FRAME_INVALID_JSON', 'NATIVE_FRAME_INCOMPLETE',
  'NATIVE_ANCESTRY_INVALID', 'NATIVE_ANCESTRY_UNSUPPORTED', 'NATIVE_ANCESTRY_MISMATCH',
  'NATIVE_ORIGIN_REFUSED', 'NATIVE_DISPATCH_REQUIRED', 'NATIVE_DISPATCH_FAILED',
  'NATIVE_TRANSPORT_CLOSED', 'NATIVE_TRANSPORT_WRITE_FAILED', 'NATIVE_QUEUE_FULL',
  'NATIVE_STATE_CHANGED', 'NATIVE_STATE_UNAVAILABLE', 'EPERM', 'EACCES', 'ENOENT', 'EIO',
]);
const messageObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function nativeDiagnosticCode(error, fallback = 'NATIVE_HOST_FAILED') {
  return CODES.has(error?.code) ? error.code : CODES.has(fallback) ? fallback : 'NATIVE_HOST_FAILED';
}

export function nativeDiagnosticLine(error, fallback) {
  return nativeDiagnosticCode(error, fallback);
}

export async function reportNativeDiagnostic({ stdout, stderr, stage }, error, fallback) {
  const code = nativeDiagnosticCode(error, fallback);
  try { stderr.write(code + '\n'); }
  catch { throw new BrokerError('NATIVE_TRANSPORT_WRITE_FAILED', 'Native diagnostic write failed'); }
  if (stdout.destroyed) return { delivered: false };
  const bytes = encodeNativeMessage({
    event: 'diagnostic', code,
    ...(DIAGNOSTIC_STAGES.has(stage) ? { stage } : {}),
    ...(DIAGNOSTIC_SYSCALLS.has(error?.syscall) ? { syscall: error.syscall } : {}),
  });
  await new Promise((resolve, reject) => {
    const failed = () => reject(new BrokerError('NATIVE_TRANSPORT_WRITE_FAILED', 'Native diagnostic write failed'));
    try { stdout.write(bytes, error => error ? failed() : resolve()); }
    catch { failed(); }
  });
  return { delivered: true };
}

export function assertNativeReady(message, config) {
  if (!/^[a-p]{32}$/u.test(config?.extensionId ?? '') ||
      message?.event !== 'ready' || message.protocolVersion !== 1 || message.extensionId !== config.extensionId) {
    throw new BrokerError('NATIVE_PROTOCOL_MISMATCH', 'Native readiness must identify the registered extension and protocol');
  }
  if (!/^[a-f0-9]{64}$/u.test(config.extensionSourceDigest ?? '') ||
      message.sourceDigest !== config.extensionSourceDigest) {
    throw new BrokerError('NATIVE_EXTENSION_SOURCE_MISMATCH', 'Executed extension source does not match the verified native runtime');
  }
  if (!/^[a-f0-9]{64}$/u.test(config.expectedProfileToken ?? '')) {
    throw new BrokerError('NATIVE_PROFILE_TOKEN_UNAVAILABLE', 'Ordinary native preparation must pin the selected profile before connection');
  }
  if (message.profileToken !== config.expectedProfileToken) {
    throw new BrokerError('NATIVE_PROFILE_MISMATCH', 'Native readiness does not match the independently verified selected profile');
  }
}

export function encodeNativeMessage(message) {
  if (!messageObject(message)) throw new BrokerError('NATIVE_FRAME_INVALID_MESSAGE', 'Native messages must be JSON objects');
  let bytes;
  try { bytes = Buffer.from(JSON.stringify(message), 'utf8'); }
  catch { throw new BrokerError('NATIVE_FRAME_INVALID_MESSAGE', 'Native message must be serializable JSON'); }
  if (bytes.length > MAX_NATIVE_BYTES)
    throw new BrokerError('NATIVE_FRAME_TOO_LARGE', 'Native message exceeds the 1 MiB frame limit');
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
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native process PID is invalid');
  try {
    const startIdentity = await readProcessStart(pid);
    let parentPid, owner, executable;
    if (process.platform === 'linux') {
      const text = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      parentPid = Number(fields[1]);
      owner = (await readFile(`/proc/${pid}/status`, 'utf8')).match(/^Uid:\s+(\d+)/mu)?.[1];
      executable = await readlink(`/proc/${pid}/exe`);
    } else if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('/bin/ps',
        ['-p', String(pid), '-o', 'ppid=', '-o', 'uid=', '-o', 'comm='],
        { encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
      const fields = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      parentPid = Number(fields?.[1]); owner = fields?.[2]; executable = fields?.[3];
    } else if (process.platform === 'win32') {
      const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if($o.ReturnValue -eq 0){@{pid=$p.ProcessId;parentPid=$p.ParentProcessId;owner=$o.Sid;executable=$p.ExecutablePath}|ConvertTo-Json -Compress}}`;
      const { stdout } = await execFileAsync(windowsPowerShellPath(),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384, windowsHide: true });
      ({ parentPid, owner, executable } = JSON.parse(stdout));
    } else throw new BrokerError('NATIVE_ANCESTRY_UNSUPPORTED', 'Native process identity is unsupported on this platform');
    const identity = { pid, parentPid, owner, executable, startIdentity };
    if (!completeIdentity(identity, pid) || startIdentity !== await readProcessStart(pid))
      throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native process identity is incomplete or changed during observation');
    return identity;
  } catch (error) {
    throw new BrokerError(nativeDiagnosticCode(error, 'NATIVE_ANCESTRY_INVALID'), 'Native process identity could not be read');
  }
}

export async function readNativeAncestry(pid, { processReader = readNativeProcess } = {}) {
  const seen = new Set(), chain = [];
  async function observe(pid) {
    let identity;
    try { identity = await processReader(pid); } catch {}
    if (!completeIdentity(identity, pid))
      throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native ancestry requires complete process identities');
    return { ...identity };
  }
  for (let index = 0; index < 3; index++) {
    if (seen.has(pid)) throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native ancestry contains a process cycle');
    seen.add(pid);
    const identity = await observe(pid);
    chain.push(identity); pid = identity.parentPid;
  }
  for (const recorded of chain) {
    const fresh = await observe(recorded.pid);
    if (['pid', 'parentPid', 'startIdentity', 'owner', 'executable'].some(key => fresh[key] !== recorded[key]))
      throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native ancestry changed during observation');
  }
  return chain;
}

export async function runNativeHost({ stdin, stdout, config, processReader = readNativeProcess, identityPollMs = 1000 }) {
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/u.test(config?.extensionOrigin ?? '') || config.origin !== config.extensionOrigin)
    throw new BrokerError('NATIVE_ORIGIN_REFUSED', 'Native caller does not match the configured extension');
  if (!Number.isSafeInteger(identityPollMs) || identityPollMs <= 0 || identityPollMs > 60_000)
    throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native ancestry polling requires a bounded interval');
  const chain = await readNativeAncestry(config.pid ?? process.pid, { processReader });
  const [runtime, entry, browser] = chain;
  if (runtime.executable !== config.runtimeExecutable || entry.executable !== config.entryExecutable ||
      browser.executable !== config.browserExecutable || chain.some(i => i.owner !== browser.owner) ||
      (config.expectedBrowser && ['pid', 'startIdentity', 'owner', 'executable'].some(key => browser[key] !== config.expectedBrowser[key])))
    throw new BrokerError('NATIVE_ANCESTRY_MISMATCH', 'Native transport is not bound to its configured browser and runtime');
  if (typeof config.onMessage !== 'function')
    throw new BrokerError('NATIVE_DISPATCH_REQUIRED', 'Native transport requires a message dispatcher');
  return new Promise((resolve, reject) => {
    let settled = false, inputEnded = false, checkingIdentity = false, identityTimer;
    const pending = new Set();
    const cleanup = () => {
      clearInterval(identityTimer);
      stdin.off('data', onData); stdin.off('end', onEnd); stdin.off('error', fail); stdin.off('close', onInputClose);
      stdout.off('error', fail); stdout.off('close', onOutputClose);
    };
    const fail = error => {
      if (settled) return;
      settled = true; cleanup(); stdin.destroy();
      const code = nativeDiagnosticCode(error, 'NATIVE_DISPATCH_FAILED');
      reject(new BrokerError(code, code));
    };
    const finish = () => {
      if (settled || !inputEnded || pending.size) return;
      settled = true; cleanup(); resolve({ closed: true });
    };
    const send = message => new Promise((sent, failed) => {
      if (settled) return failed(new BrokerError('NATIVE_TRANSPORT_CLOSED', 'Native transport is closed'));
      let bytes;
      try { bytes = encodeNativeMessage(message); } catch (error) { failed(error); return; }
      const writeFailed = () => failed(new BrokerError('NATIVE_TRANSPORT_WRITE_FAILED', 'Native IPC write failed'));
      try { stdout.write(bytes, error => error ? writeFailed() : sent()); }
      catch { writeFailed(); }
    });
    const framer = createNativeFramer({ onError: fail, onMessage(message) {
      if (settled) return;
      if (pending.size >= 256) {
        fail(new BrokerError('NATIVE_QUEUE_FULL', 'Native dispatch exceeded its bounded capacity')); return;
      }
      // Invoke in arrival order, but never chain a reply behind another
      // handler's pending extension request. Each task owns its rejection.
      let response;
      try { response = config.onMessage(message, { send, chain: structuredClone(chain) }); }
      catch (error) { fail(error); return; }
      const task = Promise.resolve(response).then(response => {
        if (response !== undefined && !settled) return send(response);
      });
      pending.add(task);
      task.then(() => { pending.delete(task); finish(); }, fail);
    } });
    const onData = bytes => framer.push(bytes);
    const onInputClose = () => { if (!inputEnded) fail(new BrokerError('NATIVE_TRANSPORT_CLOSED', 'Native input closed without EOF')); };
    const onOutputClose = () => fail(new BrokerError('NATIVE_TRANSPORT_CLOSED', 'Native output closed before completion'));
    const onEnd = () => { inputEnded = true; framer.end(); finish(); };
    stdin.on('error', fail); stdin.on('close', onInputClose);
    stdout.on('error', fail); stdout.on('close', onOutputClose);
    stdin.on('data', onData); stdin.on('end', onEnd);
    identityTimer = setInterval(async () => {
      if (settled || checkingIdentity) return;
      checkingIdentity = true;
      try {
        const current = await readNativeAncestry(config.pid ?? process.pid, { processReader });
        if (current.some((identity, index) => ['pid', 'parentPid', 'startIdentity', 'owner', 'executable']
          .some(key => identity[key] !== chain[index][key])))
          throw new BrokerError('NATIVE_ANCESTRY_INVALID', 'Native transport lost its exact ancestry');
      } catch (error) { fail(error); } finally { checkingIdentity = false; }
    }, identityPollMs);
    identityTimer.unref();
    if (stdin.destroyed || stdout.destroyed) fail(new BrokerError('NATIVE_TRANSPORT_CLOSED', 'Native streams were already closed'));
  });
}

export function createNativeFramer({ onMessage, onError, maxBytes = MAX_NATIVE_BYTES }) {
  if (typeof onMessage !== 'function' || typeof onError !== 'function' ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_NATIVE_BYTES)
    throw new BrokerError('NATIVE_FRAME_INVALID_OPTIONS', 'Native framing requires bounded message and error handlers');
  let header = Buffer.alloc(4), headerBytes = 0, body = null, bodyBytes = 0, ended = false;
  const fail = (code, message) => { ended = true; header = null; body = null; onError(new BrokerError(code, message)); };
  return {
    push(chunk) {
      if (ended) return;
      if (!Buffer.isBuffer(chunk)) { fail('NATIVE_FRAME_INVALID_INPUT', 'Native framing requires byte buffers'); return; }
      let offset = 0;
      while (offset < chunk.length && !ended) {
        if (body === null) {
          const copied = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + copied); headerBytes += copied; offset += copied;
          if (headerBytes !== 4) continue;
          const size = littleEndian ? header.readUInt32LE(0) : header.readUInt32BE(0);
          if (size === 0 || size > maxBytes) {
            fail(size === 0 ? 'NATIVE_FRAME_INVALID_LENGTH' : 'NATIVE_FRAME_TOO_LARGE', 'Native frame length is outside supported bounds'); return;
          }
          body = Buffer.alloc(size);
        }
        const copied = Math.min(body.length - bodyBytes, chunk.length - offset);
        chunk.copy(body, bodyBytes, offset, offset + copied); bodyBytes += copied; offset += copied;
        if (bodyBytes !== body.length) continue;
        let text, message;
        try { text = decoder.decode(body); } catch { fail('NATIVE_FRAME_INVALID_UTF8', 'Native message contains invalid UTF-8'); return; }
        try { message = JSON.parse(text); } catch { fail('NATIVE_FRAME_INVALID_JSON', 'Native message is not valid JSON'); return; }
        if (!messageObject(message)) { fail('NATIVE_FRAME_INVALID_MESSAGE', 'Native messages must be JSON objects'); return; }
        headerBytes = 0; body = null; bodyBytes = 0;
        onMessage(message);
      }
    },
    end() {
      if (ended) return;
      if (headerBytes !== 0 || body !== null) { fail('NATIVE_FRAME_INCOMPLETE', 'Native transport ended during a frame'); return; }
      ended = true;
    },
  };
}

// Caller supplies an already selected owner-private directory and its record.
// No stale-owner policy or provider inventory is implied. Existing files refuse.
export async function reserveNativeReadyFile({ readyFile, record }) {
  if (typeof readyFile !== 'string' || !path.isAbsolute(readyFile) || !messageObject(record))
    throw new BrokerError('NATIVE_STATE_UNAVAILABLE', 'Native readiness requires an exact private path and record');
  let file, reservation;
  const close = async () => {
    if (!reservation) return;
    let current;
    try { current = await lstat(readyFile, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') { reservation = undefined; return; } throw new BrokerError('NATIVE_STATE_UNAVAILABLE', 'Native readiness could not be inspected'); }
    if (!current.isFile() || current.ino !== reservation.ino || current.dev !== reservation.dev)
      throw new BrokerError('NATIVE_STATE_CHANGED', 'Native readiness was replaced; cleanup is not authorized');
    try { await unlink(readyFile); reservation = undefined; }
    catch { throw new BrokerError('NATIVE_STATE_UNAVAILABLE', 'Native readiness could not be closed'); }
  };
  try {
    const bytes = encodeNativeMessage(record).subarray(4);
    await ensureStateDirectory(path.dirname(readyFile));
    if ((await lstat(path.dirname(readyFile))).isSymbolicLink()) throw Error();
    file = await open(readyFile, 'wx', 0o600);
    reservation = await file.stat({ bigint: true });
    await protectLeafFile(readyFile, process.platform, { label: 'desk_native_ready', subject: 'native readiness' });
    if (process.platform === 'win32') {
      const { protectWindowsPaths } = await import('../factory/windows-acl.js');
      await protectWindowsPaths([{ path: readyFile, kind: 'file', created: true }], { label: 'desk_native_ready' });
    }
    await file.writeFile(bytes); await file.sync();
  } catch {
    if (file) { await file.close(); file = undefined; }
    await close();
    throw new BrokerError('NATIVE_STATE_UNAVAILABLE', 'Native readiness reservation could not be published');
  } finally { if (file) await file.close(); }
  return Object.freeze({ readyFile, close });
}
