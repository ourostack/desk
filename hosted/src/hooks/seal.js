// Signing secrets at rest. Each is sealed with AES-256-GCM under a key derived from DESK_CLIENT_KEY with HKDF-SHA256
// (empty salt, info `desk-hooks-v1`). DESK_CLIENT_KEY, unlike DESK_SIGNING_KEY, never rotates (hosted/README.md), so
// a signing-key rotation leaves every hook's secret readable.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const INFO = "desk-hooks-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function hooksKey(clientKey) {
  if (typeof clientKey !== "string" || clientKey === "") throw new Error("DESK_CLIENT_KEY is not set; the hooks receiver seals signing secrets with it");
  return Buffer.from(hkdfSync("sha256", clientKey, Buffer.alloc(0), INFO, 32));
}

/** base64url of iv(12) | tag(16) | ciphertext. */
export function sealSecret(key, plain) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** The secret's text; throws if the sealed value was changed or sealed under another key. */
export function openSecret(key, sealed) {
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("the sealed secret is too short to be one");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
  decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

/** A Standard Webhooks secret: `whsec_` and 32 random bytes in base64. */
export const newStandardSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

/** A secret the receiver makes for an HMAC sender that lets you choose one (GitHub): 32 random bytes, base64url. */
export const newServerSecret = () => randomBytes(32).toString("base64url");
