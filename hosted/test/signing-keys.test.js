import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint } from "../src/auth/seal.js";
import { keysStartupLine, readConfig } from "../src/main.js";
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
const REV = "ouro-desk-hosted-staging--0000002";

// A gateway log line, built by the gateway's own formatter from the env it would read.
const line = ({ signing = SIGNING, client, previous, until = "2026-12-01T00:00:00Z", revision = REV } = {}) =>
  `desk-hosted: ${keysStartupLine(
    readConfig({
      DESK_SIGNING_KEY: signing,
      ...(client ? { DESK_CLIENT_KEY: client } : {}),
      ...(previous ? { DESK_SIGNING_KEY_PREVIOUS: previous, DESK_SIGNING_KEY_PREVIOUS_UNTIL: until } : {}),
      CONTAINER_APP_REVISION: revision,
    }),
  )}`;
const logged = (options) => newestKeysLine(line(options), { revision: options?.revision ?? REV });

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

test("the startup line is read only from the named revision, newest first", () => {
  const log = [
    line({ client: SIGNING, revision: "rev-new" }),
    line({ revision: "rev-old" }),
    "desk-hosted: listening on 8080",
    line({ signing: OTHER, client: SIGNING, previous: SIGNING, revision: "rev-new" }),
    line({ signing: SIGNING, revision: "rev-old" }),
  ].join("\n");
  assert.deepEqual(newestKeysLine(log, { revision: "rev-new" }), {
    signing: fingerprint(OTHER),
    client: fingerprint(SIGNING),
    clientFrom: "DESK_CLIENT_KEY",
    previous: fingerprint(SIGNING),
    until: "2026-12-01T00:00:00.000Z",
    revision: "rev-new",
  });
  assert.equal(newestKeysLine(log, { revision: "rev-old" }).clientFrom, "DESK_SIGNING_KEY");
  assert.equal(newestKeysLine(log, { revision: "rev-other" }), null, "a stale revision's line never stands in");
  assert.equal(newestKeysLine(line({ revision: "unknown" }).replace(/ revision \S+/, ""), { revision: "unknown" }), null, "a line naming no revision is never taken");
  assert.equal(newestKeysLine("desk-hosted: listening on 8080\n", { revision: REV }), null, "images before v1b-1 don't log it");
  assert.throws(() => newestKeysLine(log, {}), /revision/);
});

test("the migration stops without writing when its read doesn't match the gateway's logged fingerprint", () => {
  assert.throws(() => checkCopySource({ signingKey: SIGNING, logged: logged({ signing: OTHER }) }), noKeyIn(SIGNING, OTHER));
  assert.deepEqual(checkCopySource({ signingKey: SIGNING, logged: logged() }), { probe: false });
  // Today's image logs no key line, so the script proves the key with a probe before and after the write.
  assert.deepEqual(checkCopySource({ signingKey: SIGNING, logged: null }), { probe: true });
});

test("the migration fails when the read-back fingerprints of desk-client-key and desk-signing-key differ", () => {
  assert.throws(() => checkReadBack({ clientKey: OTHER, signingKey: SIGNING }), (error) => /desk-client-key/.test(error.message) && noKeyIn(SIGNING, OTHER)(error));
  assert.doesNotThrow(() => checkReadBack({ clientKey: SIGNING, signingKey: SIGNING }));
});

test("after the restart, the migration requires the gateway to read its client key from DESK_CLIENT_KEY", () => {
  assert.deepEqual(checkClientKeyLine({ signingKey: SIGNING, logged: logged({ client: SIGNING }) }), { probe: false, clientKeyConfirmed: true });
  // The fallback has the same fingerprint, so only client-from catches a dropped DESK_CLIENT_KEY.
  assert.throws(() => checkClientKeyLine({ signingKey: SIGNING, logged: logged() }), /DESK_CLIENT_KEY/);
  assert.throws(() => checkClientKeyLine({ signingKey: SIGNING, logged: logged({ client: OTHER }) }), noKeyIn(SIGNING, OTHER));
  // Today's image logs no line and never reads DESK_CLIENT_KEY: a probe proves the signing key only.
  assert.deepEqual(checkClientKeyLine({ signingKey: SIGNING, logged: null }), { probe: true, clientKeyConfirmed: false });
});

test("the migration writes desk-client-key and points DESK_CLIENT_KEY at it", () => {
  assert.deepEqual(CLIENT_KEY_MIGRATION, { secret: "desk-client-key", env: { DESK_CLIENT_KEY: "desk-client-key" } });
});

test("rotating with no explicit client key is refused", () => {
  assert.throws(() => refuseRotation({ env: "test", appEnv: [{ name: "DESK_SIGNING_KEY", secretRef: "desk-signing-key" }], now: NOW }), /DESK_CLIENT_KEY/);
  assert.throws(() => refuseRotation({ env: "test", appEnv: [{ name: "DESK_CLIENT_KEY", value: "unset" }], now: NOW }), /DESK_CLIENT_KEY/);
  assert.doesNotThrow(() => refuseRotation({ env: "test", appEnv: [{ name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" }], now: NOW }));
  // A desk-client-key secret holding "unset" makes the gateway fall back, which its line shows.
  assert.throws(() => rotationChanges({ signingKey: SIGNING, logged: logged(), now: NOW }), /DESK_CLIENT_KEY/);
});

test("rotating with --env prod is refused in v1b-1", () => {
  for (const env of ["prod", "production", undefined]) {
    assert.throws(() => refuseRotation({ env, appEnv: [{ name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" }], now: NOW }), /test/, String(env));
  }
});

test("rotating again while the previous key is still accepted, or with no readable until-time, is refused", () => {
  const appEnv = (until) => [
    { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" },
    { name: "DESK_SIGNING_KEY_PREVIOUS", secretRef: "desk-signing-key-previous" },
    ...(until === undefined ? [] : [{ name: "DESK_SIGNING_KEY_PREVIOUS_UNTIL", value: until }]),
  ];
  assert.throws(() => refuseRotation({ env: "test", appEnv: appEnv("2026-11-20T00:00:00.000Z"), now: NOW }), /2026-11-20/);
  for (const until of [undefined, "", "soon"]) assert.throws(() => refuseRotation({ env: "test", appEnv: appEnv(until), now: NOW }), /UNTIL/, String(until));
  assert.doesNotThrow(() => refuseRotation({ env: "test", appEnv: appEnv("2026-10-20T00:00:00.000Z"), now: NOW }));
});

test("a rotation checks the key it read against the gateway's logged one before planning any write", () => {
  const ready = logged({ client: SIGNING });
  assert.throws(() => rotationChanges({ signingKey: OTHER, logged: ready, now: NOW }), noKeyIn(SIGNING, OTHER));
  assert.throws(() => rotationChanges({ signingKey: SIGNING, logged: null, now: NOW }), /startup line/);
  assert.ok(rotationChanges({ signingKey: SIGNING, logged: ready, now: NOW }));
});

test("a rotation keeps the old key as previous for 30 days and an hour and makes a new random key", () => {
  const ready = logged({ client: SIGNING });
  const changes = rotationChanges({ signingKey: SIGNING, logged: ready, now: NOW, random: (size) => Buffer.alloc(size, 0xcd) });
  assert.deepEqual(changes, {
    setSecrets: { "desk-signing-key-previous": SIGNING, "desk-signing-key": "cd".repeat(32) },
    secretRefs: { DESK_SIGNING_KEY_PREVIOUS: "desk-signing-key-previous" },
    setEnv: { DESK_SIGNING_KEY_PREVIOUS_UNTIL: "2026-12-01T01:00:00.000Z" },
  });
  const real = rotationChanges({ signingKey: SIGNING, logged: ready, now: NOW });
  assert.match(real.setSecrets["desk-signing-key"], /^[0-9a-f]{64}$/);
  assert.notEqual(real.setSecrets["desk-signing-key"], SIGNING);
});

test("after a rotation, the gateway must name the old key as previous, a new signing key and the same explicit client key", () => {
  const before = logged({ client: SIGNING, revision: "rev-1" });
  const after = (options) => logged({ client: SIGNING, revision: "rev-2", ...options });
  assert.doesNotThrow(() => checkRotatedLine({ before, after: after({ signing: OTHER, previous: SIGNING }) }));
  assert.throws(() => checkRotatedLine({ before, after: after({ signing: SIGNING, previous: SIGNING }) }), /signing/);
  assert.throws(() => checkRotatedLine({ before, after: after({ signing: OTHER }) }), /previous/);
  assert.throws(() => checkRotatedLine({ before, after: after({ signing: OTHER, previous: SIGNING, client: OTHER }) }), /client/);
  assert.throws(() => checkRotatedLine({ before, after: null }), /startup line/);
});
