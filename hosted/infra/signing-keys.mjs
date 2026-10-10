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
// as the longest-lived token sealed with it, a refresh token.
export const PREVIOUS_KEY_DAYS = 30;

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

const KEYS_LINE = /keys: signing (\S+) client (\S+) previous (\S+)/;

// The fingerprints in the newest `keys:` line of the gateway's log, or null
// when it has none (images before v1b-1 don't log it).
export function newestKeysLine(logText) {
  const lines = logText.split("\n").filter((text) => KEYS_LINE.test(text));
  if (lines.length === 0) return null;
  const [, signing, client, previous] = lines.at(-1).match(KEYS_LINE);
  return { signing, client, previous: previous === "none" ? null : previous };
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

// After the restart: the gateway's client key must be the copied key. On
// today's image there is no line, so a probe must pass instead.
export function checkClientKeyLine({ signingKey, logged }) {
  if (!logged) return { probe: true };
  if (logged.client !== fingerprint(signingKey)) {
    throw new Error(`the gateway's client key is ${logged.client}, not the copied key ${fingerprint(signingKey)}.`);
  }
  return { probe: false };
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
  if (isSet(named("DESK_SIGNING_KEY_PREVIOUS")) && Date.parse(until) >= now) {
    throw new Error(`The previous signing key is accepted until ${until}; rotating again before then would sign out everyone holding a token sealed with it.`);
  }
}

// What a rotation writes: the old key as desk-signing-key-previous, accepted
// for 30 more days, and a new random desk-signing-key (32 bytes as hex, as
// provision.sh makes it).
export function rotationChanges({ signingKey, now = Date.now(), random = randomBytes }) {
  return {
    setSecrets: { "desk-signing-key-previous": signingKey, "desk-signing-key": random(32).toString("hex") },
    secretRefs: { DESK_SIGNING_KEY_PREVIOUS: "desk-signing-key-previous" },
    setEnv: { DESK_SIGNING_KEY_PREVIOUS_UNTIL: new Date(now + PREVIOUS_KEY_DAYS * 24 * 3600 * 1000).toISOString() },
  };
}

// After a rotation's restart: the gateway must hold the old key as previous,
// a new signing key and the same client key.
export function checkRotatedLine({ before, after }) {
  if (!before || !after) throw new Error("The gateway's keys startup line is missing; cannot confirm the rotation.");
  if (after.previous !== before.signing) throw new Error(`The gateway's previous key is ${after.previous ?? "none"}, not the old signing key ${before.signing}.`);
  if (after.signing === before.signing) throw new Error("The gateway still signs with the old signing key.");
  if (after.client !== before.client) throw new Error(`The gateway's client key changed from ${before.client} to ${after.client}.`);
}
