// Webhook signature schemes (hosted/src/hooks/verify.js). Every vector is computed here with createHmac over the exact
// bytes sent, so a check that parsed or re-serialized the body first would fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { PRESETS, resolveVerify, verify } from "../src/hooks/verify.js";

const NOW = Date.parse("2026-11-20T21:00:00Z");
const SECONDS = Math.floor(NOW / 1000);
const KEY = randomBytes(32);
const WHSEC = `whsec_${KEY.toString("base64")}`;

const standardSignature = (key, id, timestamp, raw) =>
  `v1,${createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw])).digest("base64")}`;

function standardHeaders(raw, { id = "msg_2Kq", timestamp = SECONDS, key = KEY, extra } = {}) {
  const signature = standardSignature(key, id, timestamp, raw);
  return { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": extra ? `${extra} ${signature}` : signature };
}

test("standard accepts a valid signature even when only the second listed one matches", () => {
  const raw = Buffer.from('{"type":"ping"}');
  const headers = standardHeaders(raw, { extra: "v1,AAAAbm90IHRoaXMgb25l" });
  assert.deepEqual(verify(resolveVerify("standard"), WHSEC, headers, raw, NOW), { ok: true, deliveryId: "msg_2Kq" });
});

test("standard reads the key after whsec_, and a bare base64 key works too", () => {
  const raw = Buffer.from("{}");
  assert.equal(verify(resolveVerify("standard"), KEY.toString("base64"), standardHeaders(raw), raw, NOW).ok, true);
});

test("standard refuses a wrong secret, with or without the whsec_ prefix", () => {
  const raw = Buffer.from("{}");
  const other = randomBytes(32).toString("base64");
  for (const secret of [`whsec_${other}`, other]) {
    const result = verify(resolveVerify("standard"), secret, standardHeaders(raw), raw, NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason, /signature/);
  }
});

test("standard refuses a timestamp 301 s old or ahead, and accepts 300 s", () => {
  const raw = Buffer.from("{}");
  for (const offset of [-301, 301]) {
    const result = verify(resolveVerify("standard"), WHSEC, standardHeaders(raw, { timestamp: SECONDS + offset }), raw, NOW);
    assert.deepEqual(result, { ok: false, reason: "webhook-timestamp is more than 5 minutes from now" });
  }
  assert.equal(verify(resolveVerify("standard"), WHSEC, standardHeaders(raw, { timestamp: SECONDS - 300 }), raw, NOW).ok, true);
});

test("standard refuses missing headers and a timestamp that isn't a number", () => {
  const raw = Buffer.from("{}");
  const headers = standardHeaders(raw);
  for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    const { [name]: _gone, ...rest } = headers;
    assert.deepEqual(verify(resolveVerify("standard"), WHSEC, rest, raw, NOW), { ok: false, reason: `missing ${name} header` });
  }
  assert.equal(verify(resolveVerify("standard"), WHSEC, { ...headers, "webhook-timestamp": "soon" }, raw, NOW).reason, "webhook-timestamp is not a number");
});

test("a body with trailing spaces and odd key order verifies against its exact bytes only", () => {
  const raw = Buffer.from('{ "b":1,   "a" : 2 }   ');
  const headers = standardHeaders(raw);
  assert.equal(verify(resolveVerify("standard"), WHSEC, headers, raw, NOW).ok, true);
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
  assert.equal(verify(resolveVerify("standard"), WHSEC, headers, reserialized, NOW).ok, false);
});

test("stripe checks t= and v1= and takes the event id from a JSON body", () => {
  const secret = "whsec_stripe_test_secret";
  const raw = Buffer.from('{"id":"evt_1","type":"invoice.paid"}');
  const signature = createHmac("sha256", secret).update(`${SECONDS}.${raw}`).digest("hex");
  const spec = resolveVerify("stripe");
  const good = { "stripe-signature": `t=${SECONDS},v1=deadbeef,v1=${signature},v0=ignored` };
  assert.deepEqual(verify(spec, secret, good, raw, NOW), { ok: true, deliveryId: "evt_1" });
  assert.deepEqual(verify(spec, secret, { "stripe-signature": `t=${SECONDS - 301},v1=${signature}` }, raw, NOW), { ok: false, reason: "stripe-signature timestamp is more than 5 minutes from now" });
  assert.equal(verify(spec, "wrong", good, raw, NOW).ok, false);
  assert.deepEqual(verify(spec, secret, {}, raw, NOW), { ok: false, reason: "missing stripe-signature header" });
  assert.deepEqual(verify(spec, secret, { "stripe-signature": `v1=${signature}` }, raw, NOW), { ok: false, reason: "stripe-signature has no t= timestamp" });
  // A body that isn't JSON, or JSON with no string id, has no delivery id.
  const text = Buffer.from("not json");
  const textSignature = createHmac("sha256", secret).update(`${SECONDS}.not json`).digest("hex");
  assert.deepEqual(verify(spec, secret, { "stripe-signature": `t=${SECONDS},v1=${textSignature}` }, text, NOW), { ok: true, deliveryId: null });
});

test("github, sentry and linear check an HMAC of the raw body and name their delivery ids", () => {
  const secret = "shared-secret";
  const raw = Buffer.from('{"action":"opened"}\n');
  const hex = createHmac("sha256", secret).update(raw).digest("hex");
  assert.deepEqual(verify(resolveVerify("github"), secret, { "x-hub-signature-256": `sha256=${hex}`, "x-github-delivery": "gh-1" }, raw, NOW), { ok: true, deliveryId: "gh-1" });
  assert.deepEqual(verify(resolveVerify("sentry"), secret, { "sentry-hook-signature": hex, "request-id": "se-1" }, raw, NOW), { ok: true, deliveryId: "se-1" });
  assert.deepEqual(verify(resolveVerify("linear"), secret, { "linear-signature": hex, "linear-delivery": "li-1" }, raw, NOW), { ok: true, deliveryId: "li-1" });
  // GitHub's prefix is required; without it the signature doesn't match.
  assert.equal(verify(resolveVerify("github"), secret, { "x-hub-signature-256": hex }, raw, NOW).ok, false);
  assert.deepEqual(verify(resolveVerify("sentry"), secret, {}, raw, NOW), { ok: false, reason: "missing sentry-hook-signature header" });
  // No delivery header: no delivery id.
  assert.deepEqual(verify(resolveVerify("linear"), secret, { "linear-signature": hex }, raw, NOW), { ok: true, deliveryId: null });
});

test("a custom hmac spec can read a base64 signature", () => {
  const spec = resolveVerify({ scheme: "hmac", header: "X-Signature", encoding: "base64" });
  const raw = Buffer.from("payload");
  const signature = createHmac("sha256", "k").update(raw).digest("base64");
  assert.equal(verify(spec, "k", { "x-signature": signature }, raw, NOW).ok, true);
  assert.equal(verify(spec, "k", { "x-signature": "AAAA" }, raw, NOW).ok, false);
});

test("none always passes and still finds a delivery id it knows", () => {
  assert.deepEqual(verify(resolveVerify("none"), null, {}, Buffer.alloc(0), NOW), { ok: true, deliveryId: null });
  assert.deepEqual(verify(resolveVerify("none"), null, { "x-github-delivery": "d" }, Buffer.alloc(0), NOW), { ok: true, deliveryId: "d" });
});

test("a signature of the wrong length is refused and never throws", () => {
  const raw = Buffer.from("x");
  for (const value of ["", "zz", "sha256=", "a".repeat(10_000)]) {
    assert.doesNotThrow(() => verify(resolveVerify("sentry"), "s", { "sentry-hook-signature": value }, raw, NOW));
    assert.equal(verify(resolveVerify("sentry"), "s", { "sentry-hook-signature": value }, raw, NOW).ok, false);
  }
  assert.equal(verify(resolveVerify("standard"), WHSEC, { "webhook-id": "a", "webhook-timestamp": String(SECONDS), "webhook-signature": "v1,AA v2,BB nonsense" }, raw, NOW).ok, false);
});

test("presets say who makes the secret, and unknown presets and specs are refused", () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ["clerk", "github", "linear", "none", "resend", "sentry", "standard", "stripe", "svix"]);
  assert.equal(PRESETS.standard.secretFrom, "server");
  assert.equal(PRESETS.github.secretFrom, "server");
  for (const name of ["stripe", "sentry", "linear", "svix", "resend", "clerk"]) assert.equal(PRESETS[name].secretFrom, "sender", name);
  assert.equal(PRESETS.none.secretFrom, "none");
  assert.equal(resolveVerify("svix").scheme, "standard");
  assert.equal(resolveVerify("github").preset, "github");
  assert.throws(() => resolveVerify("hmac-md5"), /unknown verify preset hmac-md5/);
  assert.throws(() => resolveVerify({ scheme: "rsa" }), /unknown verify preset/);
  assert.throws(() => resolveVerify({ scheme: "hmac", header: "bad header" }), /header/);
  assert.throws(() => resolveVerify({ scheme: "hmac", header: "x-sig", encoding: "base32" }), /encoding/);
  // Changing a resolved preset never changes the table.
  resolveVerify("github").header = "changed";
  assert.equal(PRESETS.github.header, "x-hub-signature-256");
});
