import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint } from "../src/auth/seal.js";
import {
  secretFromAz,
  newestKeysLine,
  checkCopySource,
  checkReadBack,
  checkClientKeyLine,
  refuseRotation,
  rotationChanges,
  checkRotatedLine,
  CLIENT_KEY_MIGRATION,
} from "../infra/signing-keys.mjs";

const SIGNING = "a".repeat(64);
const OTHER = "b".repeat(64);
const NOW = Date.parse("2026-11-01T00:00:00Z");
const line = (signing, client, previous = "none") => `desk-hosted: keys: signing ${signing} client ${client} previous ${previous}`;

// Every check below throws on a mismatch; none of its messages may carry a key.
const noKeyIn = (...keys) => (error) => keys.every((key) => !error.message.includes(key));

test("the migration copies the key byte-exactly when az output ends with a newline", () => {
  assert.equal(secretFromAz(`${SIGNING}\n`), SIGNING);
  assert.equal(secretFromAz(SIGNING), SIGNING);
  assert.equal(fingerprint(secretFromAz(`${SIGNING}\n`)), fingerprint(SIGNING));
  for (const bad of [`${SIGNING}\n\n`, `${SIGNING} \n`, `${SIGNING}\r\n`, "", "\n", `a ${SIGNING}`]) {
    assert.throws(() => secretFromAz(bad, "desk-signing-key"), (error) => error.message.includes("desk-signing-key") && noKeyIn(SIGNING)(error), JSON.stringify(bad));
  }
});

test("the newest startup line's fingerprints are read from the gateway log", () => {
  const log = [line("fp-old", "fp-old"), "desk-hosted: listening on 8080", line("fp-new", "fp-client", "fp-prev"), "desk-hosted: something else"].join("\n");
  assert.deepEqual(newestKeysLine(log), { signing: "fp-new", client: "fp-client", previous: "fp-prev" });
  assert.deepEqual(newestKeysLine(line("s", "c")), { signing: "s", client: "c", previous: null });
  assert.equal(newestKeysLine("desk-hosted: listening on 8080\n"), null, "images before v1b-1 don't log it");
});

test("the migration stops without writing when its read doesn't match the gateway's logged fingerprint", () => {
  assert.throws(() => checkCopySource({ signingKey: SIGNING, logged: newestKeysLine(line(fingerprint(OTHER), fingerprint(OTHER))) }), noKeyIn(SIGNING, OTHER));
  assert.deepEqual(checkCopySource({ signingKey: SIGNING, logged: newestKeysLine(line(fingerprint(SIGNING), fingerprint(SIGNING))) }), { probe: false });
  // Today's image logs no key line, so the script proves the key with a probe before and after the write.
  assert.deepEqual(checkCopySource({ signingKey: SIGNING, logged: null }), { probe: true });
});

test("the migration fails when the read-back fingerprints of desk-client-key and desk-signing-key differ", () => {
  assert.throws(() => checkReadBack({ clientKey: OTHER, signingKey: SIGNING }), (error) => /desk-client-key/.test(error.message) && noKeyIn(SIGNING, OTHER)(error));
  assert.doesNotThrow(() => checkReadBack({ clientKey: SIGNING, signingKey: SIGNING }));
});

test("after the restart, the migration requires the gateway's client fingerprint to match", () => {
  assert.throws(() => checkClientKeyLine({ signingKey: SIGNING, logged: newestKeysLine(line(fingerprint(SIGNING), fingerprint(OTHER))) }));
  assert.deepEqual(checkClientKeyLine({ signingKey: SIGNING, logged: newestKeysLine(line(fingerprint(SIGNING), fingerprint(SIGNING))) }), { probe: false });
  // On today's image there is still no line after the restart, so a probe must pass instead.
  assert.deepEqual(checkClientKeyLine({ signingKey: SIGNING, logged: null }), { probe: true });
});

test("the migration writes desk-client-key and points DESK_CLIENT_KEY at it", () => {
  assert.deepEqual(CLIENT_KEY_MIGRATION, { secret: "desk-client-key", env: { DESK_CLIENT_KEY: "desk-client-key" } });
});

test("rotating with no explicit client key is refused", () => {
  assert.throws(() => refuseRotation({ env: "test", appEnv: [{ name: "DESK_SIGNING_KEY", secretRef: "desk-signing-key" }], now: NOW }), /DESK_CLIENT_KEY/);
  assert.throws(() => refuseRotation({ env: "test", appEnv: [{ name: "DESK_CLIENT_KEY", value: "unset" }], now: NOW }), /DESK_CLIENT_KEY/);
  assert.doesNotThrow(() => refuseRotation({ env: "test", appEnv: [{ name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" }], now: NOW }));
});

test("rotating with --env prod is refused in v1b-1", () => {
  for (const env of ["prod", "production", undefined]) {
    assert.throws(() => refuseRotation({ env, appEnv: [{ name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" }], now: NOW }), /test/, String(env));
  }
});

test("rotating again while the previous key is still accepted is refused, because it would sign out its holders", () => {
  const appEnv = (until) => [
    { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" },
    { name: "DESK_SIGNING_KEY_PREVIOUS", secretRef: "desk-signing-key-previous" },
    { name: "DESK_SIGNING_KEY_PREVIOUS_UNTIL", value: until },
  ];
  assert.throws(() => refuseRotation({ env: "test", appEnv: appEnv("2026-11-20T00:00:00.000Z"), now: NOW }), /2026-11-20/);
  assert.doesNotThrow(() => refuseRotation({ env: "test", appEnv: appEnv("2026-10-20T00:00:00.000Z"), now: NOW }));
});

test("a rotation keeps the old key as previous for 30 days and makes a new random key", () => {
  const changes = rotationChanges({ signingKey: SIGNING, now: NOW, random: (size) => Buffer.alloc(size, 0xcd) });
  assert.deepEqual(changes, {
    setSecrets: { "desk-signing-key-previous": SIGNING, "desk-signing-key": "cd".repeat(32) },
    secretRefs: { DESK_SIGNING_KEY_PREVIOUS: "desk-signing-key-previous" },
    setEnv: { DESK_SIGNING_KEY_PREVIOUS_UNTIL: "2026-12-01T00:00:00.000Z" },
  });
  const real = rotationChanges({ signingKey: SIGNING, now: NOW });
  assert.match(real.setSecrets["desk-signing-key"], /^[0-9a-f]{64}$/);
  assert.notEqual(real.setSecrets["desk-signing-key"], SIGNING);
});

test("after a rotation, the gateway must name the old key as previous and a new signing key", () => {
  const before = newestKeysLine(line(fingerprint(SIGNING), fingerprint("client")));
  assert.doesNotThrow(() => checkRotatedLine({ before, after: newestKeysLine(line(fingerprint(OTHER), fingerprint("client"), fingerprint(SIGNING))) }));
  assert.throws(() => checkRotatedLine({ before, after: newestKeysLine(line(fingerprint(SIGNING), fingerprint("client"), fingerprint(SIGNING))) }), /signing/);
  assert.throws(() => checkRotatedLine({ before, after: newestKeysLine(line(fingerprint(OTHER), fingerprint("client"))) }), /previous/);
  assert.throws(() => checkRotatedLine({ before, after: newestKeysLine(line(fingerprint(OTHER), fingerprint("other client"), fingerprint(SIGNING))) }), /client/);
  assert.throws(() => checkRotatedLine({ before, after: null }), /startup line/);
});
