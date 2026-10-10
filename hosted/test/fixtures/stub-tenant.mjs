// A stand-in for the Ouro test tenant (Microsoft Entra External ID): its discovery document, JWKS and token endpoint,
// answered through an injected fetch, so no test reaches the network. The discovery document is the real one fetched
// from the test tenant on 2026-10-10 (entra-discovery-ourobottest.json): note that its `issuer` host is the tenant id
// while its endpoints use the tenant name. Signing keys are generated in the test with jose.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

export const DISCOVERY = JSON.parse(readFileSync(new URL("./entra-discovery-ourobottest.json", import.meta.url), "utf8"));
export const TENANT_ID = "c12edfb6-c5ab-4bf8-b1d5-1f053311d396";
export const SUBDOMAIN = "ourobottest";
export const ISSUER = DISCOVERY.issuer;
export const DISCOVERY_URL = `https://${SUBDOMAIN}.ciamlogin.com/${TENANT_ID}/v2.0/.well-known/openid-configuration`;
export const CLIENT_ID = "7d0f5b52-1c4e-4c7e-9a43-2f6f3d1e8a10";
export const CLIENT_SECRET = "entra-client-secret-for-tests";

// A code that carries its own grant, for a tenant running in another process (the end-to-end test's gateway): the test
// makes it from the authorize URL the gateway built, and that process's stub tenant redeems it without shared state.
export function codeFor(authorizeUrl, { oid, claims = {} }) {
  const url = new URL(authorizeUrl);
  const grant = {
    clientId: url.searchParams.get("client_id"),
    redirectUri: url.searchParams.get("redirect_uri"),
    challenge: url.searchParams.get("code_challenge"),
    nonce: url.searchParams.get("nonce"),
    oid,
    claims,
  };
  return `stub.${Buffer.from(JSON.stringify(grant)).toString("base64url")}`;
}

const grantOf = (code) => {
  try {
    return JSON.parse(Buffer.from(code.slice("stub.".length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

export async function newSigningKey(kid) {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, use: "sig", alg: "RS256" };
  return { kid, privateKey, publicKey, jwk };
}

// `now()` is the test clock in milliseconds. Claims default to a valid v2 ID token for this tenant and client.
export async function stubTenant({ now = Date.now, clientId = CLIENT_ID, clientSecret = CLIENT_SECRET, discovery = DISCOVERY } = {}) {
  const signing = await newSigningKey("tenant-key-1");
  const published = [signing.jwk];
  const codes = new Map();
  const calls = { discovery: 0, jwks: 0, token: [] };
  const state = { discoveryDown: false, discovery };

  const claimsFor = (overrides = {}) => {
    const iat = Math.floor(now() / 1000);
    return {
      ver: "2.0",
      iss: ISSUER,
      aud: clientId,
      tid: TENANT_ID,
      iat,
      nbf: iat,
      exp: iat + 3600,
      auth_time: iat,
      name: "Ari Mendelow",
      preferred_username: "ari@example.com",
      sub: "pairwise-subject",
      ...overrides,
    };
  };

  async function idToken(claims, { key = signing, header = {} } = {}) {
    return new SignJWT(claims).setProtectedHeader({ alg: "RS256", typ: "JWT", kid: key.kid, ...header }).sign(key.privateKey);
  }

  // The browser's trip through the tenant: takes the authorize URL the gateway built and returns the code Entra
  // would put on the callback. `claims` override the ID token that code will yield.
  function authorize(authorizeUrl, { oid, claims = {} }) {
    const url = new URL(authorizeUrl);
    const code = `entra-code-${randomBytes(8).toString("hex")}`;
    codes.set(code, {
      clientId: url.searchParams.get("client_id"),
      redirectUri: url.searchParams.get("redirect_uri"),
      challenge: url.searchParams.get("code_challenge"),
      nonce: url.searchParams.get("nonce"),
      oid,
      claims,
    });
    return code;
  }

  async function fetch(input, init = {}) {
    const url = String(input instanceof Request ? input.url : input);
    if (url === DISCOVERY_URL) {
      calls.discovery++;
      if (state.discoveryDown) return new Response("unavailable", { status: 503 });
      return Response.json(state.discovery);
    }
    if (url === DISCOVERY.jwks_uri) {
      calls.jwks++;
      return Response.json({ keys: [...published] });
    }
    if (url === DISCOVERY.token_endpoint) {
      const body = new URLSearchParams(String(init.body));
      calls.token.push({ method: init.method, headers: { ...(init.headers ?? {}) }, body });
      const code = body.get("code") ?? "";
      const grant = code.startsWith("stub.") ? grantOf(code) : codes.get(code);
      codes.delete(code);
      const verifier = body.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (
        init.method !== "POST" ||
        !grant ||
        body.get("grant_type") !== "authorization_code" ||
        body.get("client_id") !== clientId ||
        body.get("client_secret") !== clientSecret ||
        body.get("client_id") !== grant.clientId ||
        body.get("redirect_uri") !== grant.redirectUri ||
        challenge !== grant.challenge
      ) {
        return Response.json({ error: "invalid_grant", error_description: "AADSTS70000: bad grant" }, { status: 400 });
      }
      const token = await idToken(claimsFor({ oid: grant.oid, nonce: grant.nonce, ...grant.claims }));
      return Response.json({ token_type: "Bearer", scope: "openid profile", expires_in: 3600, id_token: token, access_token: "entra-access-token" });
    }
    throw new Error(`stub tenant: no network in tests (${url})`);
  }

  return { fetch, calls, state, signing, published, claimsFor, idToken, authorize };
}
