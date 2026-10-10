// ID-token validation for sign-in through the Ouro tenant (Review Focus 1), against a stub tenant whose keys are
// generated in the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { exportSPKI } from "jose";
import { createIdTokenVerifier, IdTokenError } from "../src/auth/id-token.js";
import { stubTenant, newSigningKey, ISSUER, TENANT_ID, CLIENT_ID, DISCOVERY } from "./fixtures/stub-tenant.mjs";

const START = Date.parse("2026-11-01T00:00:00Z");
const NONCE = "nonce-0123456789abcdef";
const OID = "4f6c1d2e-8b9a-4c3d-9e8f-7a6b5c4d3e2f";

async function setup() {
  let clock = START;
  const now = () => clock;
  const tenant = await stubTenant({ now });
  const verifier = createIdTokenVerifier({ issuer: ISSUER, clientId: CLIENT_ID, tenantId: TENANT_ID, jwksUri: DISCOVERY.jwks_uri, fetch: tenant.fetch, now });
  return { tenant, verifier, now, advance: (ms) => (clock += ms) };
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function refused(promise, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof IdTokenError, `expected IdTokenError, got ${error?.name}: ${error?.message}`);
    if (reason) assert.equal(error.reason, reason);
    return true;
  });
}

test("a valid ID token yields its tid, oid and name", async () => {
  const { tenant, verifier } = await setup();
  const token = await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: NONCE }));
  assert.deepEqual(await verifier.verify(token, { nonce: NONCE }), { tid: TENANT_ID, oid: OID, name: "Ari Mendelow" });
  assert.equal(tenant.calls.jwks, 1);
});

test("refuses alg none", async () => {
  const { tenant, verifier } = await setup();
  const token = `${b64({ alg: "none", typ: "JWT" })}.${b64(tenant.claimsFor({ oid: OID, nonce: NONCE }))}.`;
  await refused(verifier.verify(token, { nonce: NONCE }));
});

test("refuses HS256 signed with the JWKS public key", async () => {
  const { tenant, verifier } = await setup();
  const body = `${b64({ alg: "HS256", typ: "JWT", kid: tenant.signing.kid })}.${b64(tenant.claimsFor({ oid: OID, nonce: NONCE }))}`;
  for (const secret of [await exportSPKI(tenant.signing.publicKey), JSON.stringify(tenant.signing.jwk), tenant.signing.jwk.n]) {
    const signature = createHmac("sha256", secret).update(body).digest("base64url");
    await refused(verifier.verify(`${body}.${signature}`, { nonce: NONCE }));
  }
});

test("refuses a kid not in the JWKS after one refetch", async () => {
  const { tenant, verifier } = await setup();
  const stranger = await newSigningKey("stranger-key");
  const token = await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: NONCE }), { key: stranger });
  await refused(verifier.verify(token, { nonce: NONCE }));
  assert.equal(tenant.calls.jwks, 2, "the initial fetch and exactly one refetch");
  // The same key id signed by a key the tenant never published is refused too.
  const impostor = { ...stranger, kid: tenant.signing.kid };
  await refused(verifier.verify(await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: NONCE }), { key: impostor }), { nonce: NONCE }));
});

test("a key the tenant publishes after the first fetch is found by the refetch", async () => {
  const { tenant, verifier } = await setup();
  await verifier.verify(await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: NONCE })), { nonce: NONCE });
  const rolled = await newSigningKey("tenant-key-2");
  tenant.published.push(rolled.jwk);
  const token = await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: NONCE }), { key: rolled });
  assert.equal((await verifier.verify(token, { nonce: NONCE })).oid, OID);
  assert.equal(tenant.calls.jwks, 2);
});

test("fetches the JWKS at most once in 5 minutes for repeated unknown kids", async () => {
  const { tenant, verifier, advance } = await setup();
  for (let i = 0; i < 5; i++) {
    const stranger = await newSigningKey(`stranger-${i}`);
    await refused(verifier.verify(await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: NONCE }), { key: stranger }), { nonce: NONCE }));
    advance(30_000);
  }
  assert.equal(tenant.calls.jwks, 2, "the initial fetch and one refetch in the first 5 minutes");
  advance(5 * 60_000);
  const late = await newSigningKey("stranger-late");
  await refused(verifier.verify(await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: NONCE }), { key: late }), { nonce: NONCE }));
  assert.equal(tenant.calls.jwks, 3, "another refetch once 5 minutes have passed");
});

test("refuses another tenant's tid, another issuer, another audience, a wrong nonce, an expired token and a token from 10 minutes in the future", async () => {
  const { tenant, verifier, now } = await setup();
  const t = Math.floor(now() / 1000);
  const cases = {
    "another tenant": { tid: "de8841c3-7799-4523-bbad-44f8a2426eaa" },
    // The production tenant's issuer, and the tenant-name form of this tenant's issuer, which the endpoints use.
    "another issuer": { iss: "https://de8841c3-7799-4523-bbad-44f8a2426eaa.ciamlogin.com/de8841c3-7799-4523-bbad-44f8a2426eaa/v2.0" },
    "the tenant-name issuer": { iss: `https://ourobottest.ciamlogin.com/${TENANT_ID}/v2.0` },
    "another audience": { aud: "00000000-0000-0000-0000-000000000001" },
    "an audience list holding another client too": { aud: [CLIENT_ID, "00000000-0000-0000-0000-000000000001"] },
    "a wrong nonce": { nonce: "someone-elses-nonce" },
    "no nonce": { nonce: undefined },
    "expired beyond the 5-minute skew": { iat: t - 3600, nbf: t - 3600, exp: t - 301 },
    "from 10 minutes in the future": { iat: t + 600, nbf: t + 600, exp: t + 4200 },
    "issued 10 minutes in the future without nbf": { iat: t + 600, nbf: undefined },
    "no oid": { oid: undefined },
    "no expiry": { exp: undefined },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const claims = tenant.claimsFor({ oid: OID, nonce: NONCE, ...overrides });
    for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete claims[key];
    await assert.rejects(verifier.verify(await tenant.idToken(claims), { nonce: NONCE }), IdTokenError, name);
  }
  // Within the skew still passes.
  const skewed = tenant.claimsFor({ oid: OID, nonce: NONCE, iat: t - 3600, nbf: t - 3600, exp: t - 299 });
  assert.equal((await verifier.verify(await tenant.idToken(skewed), { nonce: NONCE })).oid, OID);
});

test("refuses when no nonce is expected and when the token is not a JWT", async () => {
  const { tenant, verifier } = await setup();
  const token = await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: NONCE }));
  await refused(verifier.verify(token, {}), "nonce");
  await refused(verifier.verify("not-a-token", { nonce: NONCE }));
  await refused(verifier.verify(undefined, { nonce: NONCE }));
});

test("a refusal's message never carries the token or its claims", async () => {
  const { tenant, verifier } = await setup();
  const token = await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: "other" }));
  await assert.rejects(verifier.verify(token, { nonce: NONCE }), (error) => {
    for (const secret of [token, OID, NONCE, "other", "Ari Mendelow"]) assert.ok(!error.message.includes(secret), `message leaks ${secret}`);
    return true;
  });
});

test("a JWKS that can't be fetched refuses the token", async () => {
  const { tenant } = await setup();
  const verifier = createIdTokenVerifier({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    tenantId: TENANT_ID,
    jwksUri: DISCOVERY.jwks_uri,
    fetch: async () => new Response("down", { status: 503 }),
    now: () => START,
  });
  await refused(verifier.verify(await tenant.idToken(tenant.claimsFor({ oid: OID, nonce: NONCE })), { nonce: NONCE }), "jwks");
});
