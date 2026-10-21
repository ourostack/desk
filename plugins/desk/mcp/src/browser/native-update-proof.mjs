// Fixed normal journal consumer. No HTTP/config proof loader or genesis flag.
// The current delivery path does not observe fresh-profile creation/enrollment
// or a complete legacy predecessor cut. Capture is NOT continuity authority.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import client from '../../web-native-messaging.cjs';
import { BrokerError } from '../util/broker-error.mjs';
import { withBrokerLock } from '../util/broker-lock.mjs';
import { nativeOwnerSnapshotDigest } from './native-owner-inventory.mjs';
import { assertNativeActivation } from './native-host.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const MAX = 65536;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = code => new BrokerError(code, code);
const phases = new Set(['intent', 'captured', 'prepared', 'committing', 'blocked-origin']);

export function createNativeUpdateProof(config) {
  const pins = structuredClone(config);
  if (typeof pins.browserStateRoot !== 'string' || !path.isAbsolute(pins.browserStateRoot) ||
      typeof pins.profileRoot !== 'string' || !path.isAbsolute(pins.profileRoot) ||
      !/^[a-p]{32}$/u.test(pins.extensionId ?? '') || !HEX.test(pins.extensionSourceDigest ?? ''))
    throw fail('NATIVE_TRANSITION_BINDING_INVALID');
  const root = path.join(pins.browserStateRoot, 'native-owned');
  const file = path.join(root, 'extension-update.json');

  function read() {
    let value, identity;
    try {
      identity = client.fileIdentity(file);
      value = client.readPrivateJson(file, { maxBytes: MAX });
      if (digest(client.readPrivateJson(file, { maxBytes: MAX })) !== digest(value) ||
          client.fileIdentity(file) !== identity)
        throw fail('NATIVE_TRANSITION_CHANGED');
    } catch (error) {
      if (error.code === 'ENOENT' && identity === undefined) return undefined;
      throw fail('NATIVE_TRANSITION_JOURNAL_INVALID');
    }
    if (value.version === 1) throw fail('NATIVE_LEGACY_CONTINUITY_UNPROVED');
    const fields = ['version', 'transactionId', 'challenge', 'phase', 'profileRoot', 'extensionId',
      'sourceDigest', 'terminalReceipts', 'capture'];
    if (!object(value) || Object.keys(value).some(k => !fields.includes(k)) || value.version !== 2 ||
        !UUID.test(value.transactionId ?? '') || !HEX.test(value.challenge ?? '') || !phases.has(value.phase) ||
        value.profileRoot !== pins.profileRoot || value.extensionId !== pins.extensionId ||
        value.sourceDigest !== pins.extensionSourceDigest || !Array.isArray(value.terminalReceipts))
      throw fail('NATIVE_TRANSITION_JOURNAL_INVALID');
    // F's terminal retirement is not implemented in this delivery; never clear,
    // adopt, or silently ignore an unsupported/unknown receipt.
    if (value.terminalReceipts.length) throw fail('NATIVE_TRANSITION_TERMINAL_EVIDENCE_UNSUPPORTED');
    return { value, identity, fingerprint: digest(value) };
  }
  function unchanged(expected) {
    const current = read();
    if ((current?.identity ?? null) !== (expected?.identity ?? null) ||
        (current?.fingerprint ?? null) !== (expected?.fingerprint ?? null))
      throw fail('NATIVE_TRANSITION_CHANGED');
    return current;
  }
  function validateWitness(w, params, activation) {
    const fields = ['transactionId', 'challenge', 'workerEpoch', 'activation', 'admission',
      'firstContextEffect', 'contextEffectSequence', 'currentUnknownObligations', 'witnessDigest'];
    if (!object(w) || Object.keys(w).length !== fields.length || Object.keys(w).some(k => !fields.includes(k)) ||
        w.transactionId !== params.transactionId || w.challenge !== params.challenge ||
        !UUID.test(w.workerEpoch ?? '') || !object(w.activation) || w.activation.protocol !== 1 ||
        w.activation.workerEpoch !== w.workerEpoch || w.workerEpoch !== activation?.workerEpoch ||
        !['evaluation', 'startup', 'browser-install-event', 'browser-update-event'].includes(w.activation.trigger) ||
        w.admission !== 'held' || w.firstContextEffect !== null || w.contextEffectSequence !== 0 ||
        !Array.isArray(w.currentUnknownObligations) || w.currentUnknownObligations.length ||
        !HEX.test(w.witnessDigest ?? '')) throw fail('NATIVE_TRANSITION_WITNESS_INVALID');
    const { witnessDigest, ...body } = w;
    assertNativeActivation(w.activation);
    if (digest(body) !== witnessDigest) throw fail('NATIVE_TRANSITION_WITNESS_INVALID');
    return structuredClone(w);
  }
  async function retain(expected, capture, lockHeld) {
    const write = async () => {
      const current = unchanged(expected);
      if (current.value.capture) {
        if (digest(current.value.capture) !== digest(capture)) throw fail('NATIVE_TRANSITION_REPLAY');
        return; // Exact duplicate readback only; never replace predecessor proof.
      }
      const bytes = Buffer.from(JSON.stringify({ ...current.value, capture }));
      if (bytes.length > MAX) throw fail('NATIVE_TRANSITION_JOURNAL_INVALID');
      const handle = await fs.open(file, 'r+');
      try {
        const opened = await handle.stat({ bigint: true });
        if (`${opened.dev}:${opened.ino}` !== current.identity || opened.nlink !== 1n)
          throw fail('NATIVE_TRANSITION_CHANGED');
        unchanged(current);
        // Same private inode: an interrupted write remains an invalid retained
        // obligation, never a missing journal interpreted as ordinary startup.
        await handle.writeFile(bytes);
        await handle.truncate(bytes.length);
        await handle.sync();
        if (client.fileIdentity(file) !== current.identity ||
            digest(client.readPrivateJson(file, { maxBytes: MAX })) !== digest({ ...current.value, capture }))
          throw fail('NATIVE_TRANSITION_CHANGED');
      } finally { await handle.close(); }
    };
    if (lockHeld) await write();
    else await withBrokerLock(root, write, { name: 'native-extension-update' });
  }
  async function handoff(evidence, lockHeld) {
    const pending = read();
    // Compatibility with the previously shipped ungated producer. It cannot
    // seed continuity and cannot bypass a present transition obligation.
    if (!evidence.activation) {
      if (pending) throw fail('NATIVE_TRANSITION_WITNESS_UNAVAILABLE');
      return;
    }
    // Same released factory reconnecting retains its effects; this is not a
    // fresh activation or a new zero-effect witness. No continuity is issued.
    if (!pending && evidence.activation.admission === 'ordinary') return;
    const params = pending ? { transactionId: pending.value.transactionId, challenge: pending.value.challenge } :
      { transactionId: randomUUID(), challenge: randomBytes(32).toString('hex') };
    const witness = validateWitness(await evidence.capture(params), params, evidence.activation);
    await evidence.recheck();
    unchanged(pending);
    if (pending) {
      await retain(pending, { generation: evidence.generation, bindingDigest: evidence.bindingDigest, witness }, lockHeld);
      await evidence.recheck();
      // No normal source currently observes either allowed predecessor origin.
      // In particular, install reason + zero effects is NOT fresh enrollment.
      throw fail('NATIVE_TRANSITION_ORIGIN_UNPROVED');
    }
    // Re-read immediately before release; no timeout cancels a new obligation.
    unchanged(pending);
    const result = await evidence.release({ ...params, workerEpoch: witness.workerEpoch,
      witnessDigest: witness.witnessDigest, mode: 'ordinary' });
    if (result?.released !== true || result.transactionId !== params.transactionId || result.workerEpoch !== witness.workerEpoch)
      throw fail('NATIVE_TRANSITION_RELEASE_UNCONFIRMED');
    await evidence.recheck();
    unchanged(pending);
  }
  async function onAdmitted(evidence) {
    try { client.privatePath(root, true); }
    catch (error) {
      if (error.code === 'ENOENT') return handoff(evidence, false);
      throw fail('NATIVE_TRANSITION_JOURNAL_INVALID');
    }
    // Serialize absence decisions with the SAME normal setup/update lock.
    // No new journal/root is created on an ordinary missing-state path.
    return withBrokerLock(root, () => handoff(evidence, true), { name: 'native-extension-update' });
  }
  async function assertPreparationAvailable() {
    const pending = read();
    if (pending) throw fail('NATIVE_TRANSITION_ORIGIN_UNPROVED');
    throw fail('NATIVE_CONTINUITY_UNKNOWN');
  }
  async function verifyContinuity(evidence) {
    if (!Array.isArray(evidence?.snapshot?.owners) ||
        nativeOwnerSnapshotDigest(evidence.snapshot.owners) !== evidence.snapshot.digest)
      throw fail('NATIVE_SNAPSHOT_CHANGED');
    // Deliberate refusal, not a caller/test verifier success path. A later
    // independently admitted normal enrollment observer must supply the real
    // origin before this delivery can issue a baseline.
    await assertPreparationAvailable();
  }
  return Object.freeze({ onAdmitted, verifyContinuity, assertPreparationAvailable });
}
