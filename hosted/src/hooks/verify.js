// Webhook signature checks. Each runs on the raw bytes the sender posted, before anything parses them, and every
// comparison is constant-time on equal-length buffers. A check never throws on what a sender sends: a bad header is a
// refusal with a reason, and the reason never repeats a header value or the body.
//
// Schemes:
//   standard  Standard Webhooks (https://www.standardwebhooks.com/): HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>`
//             under the base64 key after `whsec_`, sent as `v1,<base64>` (several may be listed, space-separated).
//   stripe    `Stripe-Signature: t=<seconds>,v1=<hex>`: HMAC-SHA256 of `<t>.<body>` under the secret's text.
//   hmac      HMAC-SHA256 of the body under the secret's text, in a named header, with an optional prefix, hex or base64.
//   none      Nothing; the hook's unguessable id is the only check.
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SECONDS = 300;

// secretFrom: who makes the signing secret. "server": the receiver makes it and shows it once, for pasting into the
// sender. "sender": the sender's dashboard issues it and it is read from stdin when the hook is made.
export const PRESETS = Object.freeze({
  standard: { scheme: "standard", secretFrom: "server" },
  svix: { scheme: "standard", secretFrom: "sender" },
  resend: { scheme: "standard", secretFrom: "sender" },
  clerk: { scheme: "standard", secretFrom: "sender" },
  stripe: { scheme: "stripe", secretFrom: "sender" },
  github: { scheme: "hmac", header: "x-hub-signature-256", prefix: "sha256=", encoding: "hex", deliveryHeader: "x-github-delivery", secretFrom: "server" },
  sentry: { scheme: "hmac", header: "sentry-hook-signature", encoding: "hex", deliveryHeader: "request-id", secretFrom: "sender" },
  linear: { scheme: "hmac", header: "linear-signature", encoding: "hex", deliveryHeader: "linear-delivery", secretFrom: "sender" },
  none: { scheme: "none", secretFrom: "none" },
});

// The delivery ids a hook with no signature still deduplicates by.
const KNOWN_DELIVERY_HEADERS = ["webhook-id", "x-github-delivery", "linear-delivery"];
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/** A preset name, or a custom `hmac` spec, as the spec `verify` takes. Throws on anything else. */
export function resolveVerify(nameOrSpec) {
  if (typeof nameOrSpec === "string") {
    if (!Object.hasOwn(PRESETS, nameOrSpec)) throw new Error(`unknown verify preset ${nameOrSpec}`);
    return { preset: nameOrSpec, ...PRESETS[nameOrSpec] };
  }
  if (nameOrSpec?.scheme !== "hmac") throw new Error(`unknown verify preset ${JSON.stringify(nameOrSpec?.scheme ?? nameOrSpec)}`);
  const header = String(nameOrSpec.header ?? "").toLowerCase();
  if (!HEADER_NAME.test(header)) throw new Error("a custom hmac spec needs a header name of letters, digits and hyphens");
  const encoding = nameOrSpec.encoding ?? "hex";
  if (encoding !== "hex" && encoding !== "base64") throw new Error("a custom hmac spec's encoding must be hex or base64");
  const prefix = typeof nameOrSpec.prefix === "string" ? nameOrSpec.prefix : "";
  return { preset: "hmac", scheme: "hmac", header, prefix, encoding, secretFrom: "sender" };
}

const hmac = (key, ...parts) => {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
};

// Constant-time equality that refuses, rather than throws on, a length mismatch.
function same(expected, given) {
  return given.length === expected.length && timingSafeEqual(expected, given);
}

const refuse = (reason) => ({ ok: false, reason });
const MISMATCH = refuse("signature does not match");

function fresh(seconds, now) {
  return Math.abs(Math.floor(now / 1000) - seconds) <= TOLERANCE_SECONDS;
}

function standardKey(secret) {
  const text = String(secret);
  return Buffer.from(text.startsWith("whsec_") ? text.slice(6) : text, "base64");
}

function checkStandard(secret, headers, raw, now) {
  for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) if (!headers[name]) return refuse(`missing ${name} header`);
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  if (!/^\d{1,12}$/.test(timestamp)) return refuse("webhook-timestamp is not a number");
  if (!fresh(Number(timestamp), now)) return refuse("webhook-timestamp is more than 5 minutes from now");
  const expected = hmac(standardKey(secret), `${id}.${timestamp}.`, raw);
  for (const entry of headers["webhook-signature"].split(" ")) {
    const [version, signature] = entry.split(",");
    if (version === "v1" && signature && same(expected, Buffer.from(signature, "base64"))) return { ok: true, deliveryId: id };
  }
  return MISMATCH;
}

function stripeEventId(raw) {
  try {
    const id = JSON.parse(raw.toString("utf8"))?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function checkStripe(secret, headers, raw, now) {
  const header = headers["stripe-signature"];
  if (!header) return refuse("missing stripe-signature header");
  const pairs = header.split(",").map((part) => part.split("="));
  const timestamp = pairs.find(([key]) => key === "t")?.[1];
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return refuse("stripe-signature has no t= timestamp");
  if (!fresh(Number(timestamp), now)) return refuse("stripe-signature timestamp is more than 5 minutes from now");
  const expected = hmac(String(secret), `${timestamp}.`, raw);
  const matched = pairs.some(([key, value]) => key === "v1" && value && same(expected, Buffer.from(value, "hex")));
  return matched ? { ok: true, deliveryId: stripeEventId(raw) } : MISMATCH;
}

function checkHmac(spec, secret, headers, raw) {
  const value = headers[spec.header];
  if (!value) return refuse(`missing ${spec.header} header`);
  const prefix = spec.prefix ?? "";
  if (!value.startsWith(prefix)) return MISMATCH;
  const given = Buffer.from(value.slice(prefix.length), spec.encoding);
  if (!same(hmac(String(secret), raw), given)) return MISMATCH;
  return { ok: true, deliveryId: headers[spec.deliveryHeader] || null };
}

/**
 * Checks one request. `headers` has lower-case names, as Node gives them; `raw` is the body exactly as sent.
 * Returns `{ ok: true, deliveryId }` (the sender's own id for this delivery, used to drop a repeat, or null) or
 * `{ ok: false, reason }`.
 */
export function verify(spec, secret, headers, raw, now) {
  switch (spec.scheme) {
    case "standard":
      return checkStandard(secret, headers, raw, now);
    case "stripe":
      return checkStripe(secret, headers, raw, now);
    case "hmac":
      return checkHmac(spec, secret, headers, raw);
    default:
      return { ok: true, deliveryId: KNOWN_DELIVERY_HEADERS.map((name) => headers[name]).find(Boolean) ?? null };
  }
}
