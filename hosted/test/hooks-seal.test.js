// Signing secrets are stored sealed under a key derived from DESK_CLIENT_KEY (hosted/src/hooks/seal.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hooksKey, newServerSecret, newStandardSecret, openSecret, sealSecret } from "../src/hooks/seal.js";

const CLIENT_KEY = "a".repeat(64);

test("a sealed secret opens again under the same key", () => {
  const key = hooksKey(CLIENT_KEY);
  assert.equal(key.length, 32);
  assert.equal(openSecret(key, sealSecret(key, "whsec_abc")), "whsec_abc");
});

test("two seals of the same text differ", () => {
  const key = hooksKey(CLIENT_KEY);
  assert.notEqual(sealSecret(key, "same"), sealSecret(key, "same"));
});

test("a flipped byte or another client key fails to open", () => {
  const key = hooksKey(CLIENT_KEY);
  const sealed = Buffer.from(sealSecret(key, "secret"), "base64url");
  for (const index of [0, 12, 28, sealed.length - 1]) {
    const tampered = Buffer.from(sealed);
    tampered[index] ^= 1;
    assert.throws(() => openSecret(key, tampered.toString("base64url")));
  }
  assert.throws(() => openSecret(hooksKey("b".repeat(64)), sealed.toString("base64url")));
  assert.throws(() => openSecret(key, "short"), /sealed secret/);
});

test("a missing client key is refused", () => {
  assert.throws(() => hooksKey(""), /DESK_CLIENT_KEY/);
  assert.throws(() => hooksKey(undefined), /DESK_CLIENT_KEY/);
});

test("new secrets have the expected shape and differ each time", () => {
  const standard = newStandardSecret();
  assert.match(standard, /^whsec_[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(standard.slice(6), "base64").length, 32);
  assert.notEqual(newStandardSecret(), standard);
  assert.match(newServerSecret(), /^[A-Za-z0-9_-]{43}$/);
});
