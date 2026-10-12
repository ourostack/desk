// Validates the ID token the Ouro tenant (Microsoft Entra External ID) returns at sign-in. The gateway trusts the
// token only as far as these checks go, so each is strict:
//
// - Only RS256, the one algorithm the tenant's discovery document lists: `none`, and HS256 keyed by a public key,
//   are refused before any key is looked up.
// - The signing key must be in the tenant's JWKS. The JWKS is cached; an unknown `kid` refetches it at most once
//   per 5 minutes, so tokens with made-up key ids can't drive traffic to the tenant. The cache is also refreshed
//   when a day old, so a key the tenant withdraws stops being accepted.
// - `iss` must equal the configured issuer exactly. For an external tenant that is
//   `https://<tenantId>.ciamlogin.com/<tenantId>/v2.0`, whose host is the tenant id, not the tenant name the
//   endpoints use; the gateway takes it from the discovery document, which must name it (see entra.js).
// - `aud` must be exactly our client id, and `tid` the tenant's id.
// - `exp`, `nbf` and `iat` are checked with 5 minutes' skew; `exp` must be present.
// - `nonce` must equal the one this sign-in sent, and `oid` must be present.
//
// A refusal is an IdTokenError whose `reason` names the failed check. Neither carries the token or its claims.
import { createLocalJWKSet, jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";

const SKEW_SEC = 300;
const REFETCH_INTERVAL_MS = 5 * 60_000;
const MAX_JWKS_AGE_MS = 24 * 3600_000;
// How long a JWKS fetch may take: a person is waiting at the callback, and the document is a few keys.
export const JWKS_TIMEOUT_MS = 5_000;

export class IdTokenError extends Error {
  constructor(reason) {
    super(`the ID token was refused: ${reason}`);
    this.name = "IdTokenError";
    this.reason = reason;
  }
}

const sameText = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// What failed, from jose's error, as one of a few fixed words.
function reasonOf(error) {
  if (error instanceof IdTokenError) return error.reason;
  switch (error?.code) {
    case "ERR_JOSE_ALG_NOT_ALLOWED":
    case "ERR_JOSE_NOT_SUPPORTED":
      return "algorithm";
    case "ERR_JWKS_NO_MATCHING_KEY":
    case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
      return "unknown_key";
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return "signature";
    case "ERR_JWT_EXPIRED":
      return "expired";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      return typeof error.claim === "string" && /^[a-z_]+$/.test(error.claim) ? `claim_${error.claim}` : "claims";
    default:
      return "malformed";
  }
}

// `now()` is the clock in milliseconds. `fetch` reads the JWKS.
export function createIdTokenVerifier({ issuer, clientId, tenantId, jwksUri, fetch = globalThis.fetch, now = Date.now, timeoutMs = JWKS_TIMEOUT_MS }) {
  for (const [name, value] of Object.entries({ issuer, clientId, tenantId, jwksUri })) {
    if (typeof value !== "string" || value === "") throw new Error(`createIdTokenVerifier needs ${name}`);
  }
  let keySet = null;
  let fetchedAt = -Infinity;
  let refetchedAt = -Infinity;
  // The refetch in flight, so sign-ins arriving together during a tenant key rollover all wait for the same one.
  let refetching = null;

  async function load() {
    let jwks;
    try {
      const response = await fetch(jwksUri, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      jwks = response.ok ? await response.json() : null;
    } catch {
      jwks = null;
    }
    if (!Array.isArray(jwks?.keys)) throw new IdTokenError("jwks");
    keySet = createLocalJWKSet(jwks);
    fetchedAt = now();
  }

  async function currentKeys() {
    if (!keySet || now() - fetchedAt >= MAX_JWKS_AGE_MS) {
      try {
        await load();
      } catch (error) {
        // A day-old set is still better than none while the tenant can't be reached.
        if (!keySet) throw error;
      }
    }
    return keySet;
  }

  async function keyFor(header, token) {
    try {
      return await (await currentKeys())(header, token);
    } catch (error) {
      if (error?.code !== "ERR_JWKS_NO_MATCHING_KEY") throw error;
      if (!refetching) {
        if (now() - refetchedAt < REFETCH_INTERVAL_MS) throw error;
        refetchedAt = now();
        refetching = load().finally(() => {
          refetching = null;
        });
      }
      await refetching;
      return keySet(header, token);
    }
  }

  return {
    async verify(idToken, { nonce } = {}) {
      if (typeof nonce !== "string" || nonce === "") throw new IdTokenError("nonce");
      if (typeof idToken !== "string") throw new IdTokenError("malformed");
      let payload;
      try {
        ({ payload } = await jwtVerify(idToken, keyFor, {
          algorithms: ["RS256"],
          issuer,
          audience: clientId,
          clockTolerance: SKEW_SEC,
          currentDate: new Date(now()),
          requiredClaims: ["exp", "iat"],
        }));
      } catch (error) {
        throw new IdTokenError(reasonOf(error));
      }
      const nowSec = now() / 1000;
      if (payload.iss !== issuer) throw new IdTokenError("claim_iss");
      if (payload.aud !== clientId) throw new IdTokenError("claim_aud");
      if (payload.tid !== tenantId) throw new IdTokenError("claim_tid");
      if (!(typeof payload.iat === "number" && payload.iat <= nowSec + SKEW_SEC)) throw new IdTokenError("claim_iat");
      if (!sameText(payload.nonce, nonce)) throw new IdTokenError("claim_nonce");
      if (typeof payload.oid !== "string" || payload.oid === "") throw new IdTokenError("claim_oid");
      return { tid: payload.tid, oid: payload.oid, name: typeof payload.name === "string" ? payload.name : null };
    },
  };
}
