// The checks behind the signing-key operations of provision-identity.mjs
// (`--migrate client-key` and `--rotate signing-key`), kept free of `az` so
// they can be tested alone. Each compares fingerprints, never keys, and no
// message here ever carries a key.
//
// The script reads a key with `az containerapp secret show --query value -o
// tsv`, which ends its output with one newline, and compares what it read with
// the `keys:` line the running gateway logs at start (main.js), because only
// that line shows the value the gateway itself holds.
import { randomBytes } from "node:crypto";
import { fingerprint } from "../src/auth/seal.js";

// How long the previous signing key stays accepted after a rotation: as long
// as the longest-lived token sealed with it, a refresh token, plus an hour for
// the old revision, which keeps sealing with it until the new one is ready.
export const PREVIOUS_KEY_MS = (30 * 24 + 1) * 3600 * 1000;

// The client-key migration copies desk-signing-key into desk-client-key and
// points DESK_CLIENT_KEY at it.
export const CLIENT_KEY_MIGRATION = { secret: "desk-client-key", env: { DESK_CLIENT_KEY: "desk-client-key" } };

// A secret as `az ... -o tsv` printed it, less exactly one trailing newline.
// Anything else that is whitespace is refused, as the gateway's readConfig
// would refuse it.
export function secretFromAz(stdout, name = "the secret") {
  const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (value === "") throw new Error(`${name} is empty.`);
  if (/\s/.test(value)) throw new Error(`${name} contains whitespace beyond az's one trailing newline; refusing to copy it.`);
  return value;
}

const KEYS_LINE = /keys: (.*)$/;
const FIELDS = ["signing", "client", "client-from", "previous", "revision"];

// One `keys:` line's fields, or null when it is not a complete one.
function parseKeysLine(text) {
  const match = text.match(KEYS_LINE);
  if (!match) return null;
  const words = match[1].trim().split(/\s+/);
  const fields = {};
  for (let i = 0; i + 1 < words.length; i += 2) fields[words[i]] = words[i + 1];
  if (!FIELDS.every((name) => fields[name])) return null;
  return {
    signing: fields.signing,
    client: fields.client,
    clientFrom: fields["client-from"],
    previous: fields.previous === "none" ? null : fields.previous,
    until: fields.until ?? null,
    revision: fields.revision,
  };
}

// The fingerprints in the newest `keys:` line that the named revision logged,
// or null when it logged none (images before v1b-1 don't log it). A line from
// any other revision, or one naming none, is never taken, so a stale line
// can't stand in for the revision just restarted.
export function newestKeysLine(logText, { revision } = {}) {
  if (!revision) throw new Error("newestKeysLine needs the revision whose startup line to read.");
  const lines = logText.split("\n").map(parseKeysLine).filter((parsed) => parsed?.revision === revision);
  return lines.at(-1) ?? null;
}

// Before the migration writes anything: the key it read must be the one the
// gateway logged. With no logged line, the script must instead see a probe
// pass before and after its write (`{ probe: true }`).
export function checkCopySource({ signingKey, logged }) {
  if (!logged) return { probe: true };
  if (fingerprint(signingKey) !== logged.signing) {
    throw new Error(`desk-signing-key as read has fingerprint ${fingerprint(signingKey)}, but the gateway logged ${logged.signing}; nothing was written.`);
  }
  return { probe: false };
}

// After the write: desk-client-key and desk-signing-key, both read back, must
// be the same key.
export function checkReadBack({ clientKey, signingKey }) {
  if (fingerprint(clientKey) !== fingerprint(signingKey)) {
    throw new Error(`desk-client-key reads back as ${fingerprint(clientKey)}, not desk-signing-key's ${fingerprint(signingKey)}.`);
  }
}

// After the restart: the gateway must read its client key from
// DESK_CLIENT_KEY, and that key must be the copied one. The fallback to
// DESK_SIGNING_KEY has the same fingerprint, so only `client-from` shows it.
// Today's image logs no line and never reads DESK_CLIENT_KEY; a probe must
// pass instead, which proves the signing key only, so the client key stays
// unconfirmed until the first image that logs the line starts.
export function checkClientKeyLine({ signingKey, logged }) {
  if (!logged) return { probe: true, clientKeyConfirmed: false };
  if (logged.clientFrom !== "DESK_CLIENT_KEY") throw new Error(`The gateway reads its client key from ${logged.clientFrom}, not DESK_CLIENT_KEY.`);
  if (logged.client !== fingerprint(signingKey)) {
    throw new Error(`The gateway's client key is ${logged.client}, not the copied key ${fingerprint(signingKey)}.`);
  }
  return { probe: false, clientKeyConfirmed: true };
}

const isSet = (entry) => entry && (entry.secretRef || (entry.value && entry.value.trim() !== "" && entry.value.trim() !== "unset"));

// Refuses a signing-key rotation that v1b-1 must not run. `appEnv` is the
// container's env list from `az containerapp show`.
export function refuseRotation({ env, appEnv, now = Date.now() }) {
  if (env !== "test") {
    throw new Error("Signing-key rotation runs only with --env test in v1b-1; production waits until the rollback image retires (README).");
  }
  const named = (name) => appEnv.find((entry) => entry.name === name);
  if (!isSet(named("DESK_CLIENT_KEY"))) {
    throw new Error("DESK_CLIENT_KEY is not set; run --migrate client-key first, or the rotation would void every registered client.");
  }
  const until = named("DESK_SIGNING_KEY_PREVIOUS_UNTIL")?.value;
  if (isSet(named("DESK_SIGNING_KEY_PREVIOUS"))) {
    if (Number.isNaN(Date.parse(until))) throw new Error("A previous signing key is set without a readable DESK_SIGNING_KEY_PREVIOUS_UNTIL; fix that before rotating.");
    if (Date.parse(until) >= now) {
      throw new Error(`The previous signing key is accepted until ${until}; rotating again before then would sign out everyone holding a token sealed with it.`);
    }
  }
}

// Before a rotation writes anything: the running revision's startup line
// must exist, name the key the script read as its signing key, and show an
// explicit DESK_CLIENT_KEY. Otherwise the script would save the wrong bytes
// as the previous key and sign everyone out, or re-key every client.
function checkRotationSource({ signingKey, logged }) {
  if (!logged) throw new Error("The running revision's keys startup line is missing; cannot confirm which signing key it holds, so nothing was written.");
  if (fingerprint(signingKey) !== logged.signing) {
    throw new Error(`desk-signing-key as read has fingerprint ${fingerprint(signingKey)}, but the gateway logged ${logged.signing}; nothing was written.`);
  }
  if (logged.clientFrom !== "DESK_CLIENT_KEY") throw new Error(`The gateway reads its client key from ${logged.clientFrom}, not DESK_CLIENT_KEY; run --migrate client-key first.`);
}

// What a rotation writes: the old key as desk-signing-key-previous, accepted
// for 30 days and an hour more, and a new random desk-signing-key (32 bytes as
// hex, as provision.sh makes it). `logged` is the running revision's startup
// line; the changes are planned only once it confirms the key read.
export function rotationChanges({ signingKey, logged, now = Date.now(), random = randomBytes }) {
  checkRotationSource({ signingKey, logged });
  return {
    setSecrets: { "desk-signing-key-previous": signingKey, "desk-signing-key": random(32).toString("hex") },
    secretRefs: { DESK_SIGNING_KEY_PREVIOUS: "desk-signing-key-previous" },
    setEnv: { DESK_SIGNING_KEY_PREVIOUS_UNTIL: new Date(now + PREVIOUS_KEY_MS).toISOString() },
  };
}

// After a rotation's restart: the gateway must hold the old key as previous,
// a new signing key and the same client key.
export function checkRotatedLine({ before, after }) {
  if (!before || !after) throw new Error("The gateway's keys startup line is missing; cannot confirm the rotation.");
  if (after.previous !== before.signing) throw new Error(`The gateway's previous key is ${after.previous ?? "none"}, not the old signing key ${before.signing}.`);
  if (after.signing === before.signing) throw new Error("The gateway still signs with the old signing key.");
  if (after.client !== before.client || after.clientFrom !== "DESK_CLIENT_KEY") {
    throw new Error(`The gateway's client key changed from ${before.client} to ${after.client} (from ${after.clientFrom}).`);
  }
}
