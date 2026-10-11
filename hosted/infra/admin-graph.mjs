// Microsoft Graph as an Ouro tenant's admin app, ouro-identity-admin, with an app-only token (client credentials).
//
// Why: az's own Graph token is delegated, for the Azure CLI's first-party app, and holds no IdentityProvider.*,
// IdentityUserFlow.*, EventListener.* or Policy.ReadWrite.AuthenticationMethod scope. Entra refuses to consent them
// (AADSTS65002, first party to first party), so the Apple provider, the user flow and the email one-time-code policy
// can't be read or written through `az rest` (spike, 2026-10-11, Step 3). az's token does hold
// Application.ReadWrite.All and AppRoleAssignment.ReadWrite.All, so provision-identity.mjs creates this app with it and
// grants it Graph application roles; the calls az can't make go through here.
//
// The app's client secret lives only in the operator's macOS keychain, as generic password `ouro-identity-admin-<tenant
// id>` with the app id as its account. It is read through `security ... -w` into memory, written through `security -i`'s
// stdin, sent only in the token request's body, and never printed or passed as an argument. The access token stays in
// memory too.
import { fingerprint } from "../src/auth/seal.js";
import { trimOneNewline } from "./runner.mjs";

export const ADMIN_APP_NAME = "ouro-identity-admin";
// The Graph application roles the admin app needs for provision-identity.mjs's tenant steps and identity-checks.mjs's
// local runs: the Apple provider; the user flow, its identity providers and its applications; the email one-time-code
// policy; and reading app registrations (a user flow's application link and the gateway's client-secret expiry).
export const ADMIN_ROLES = ["IdentityProvider.ReadWrite.All", "IdentityUserFlow.ReadWrite.All", "EventListener.ReadWrite.All", "Policy.ReadWrite.AuthenticationMethod", "Application.ReadWrite.All"];
export const adminKeychainService = (tenantId) => `ouro-identity-admin-${tenantId}`;

const LOGIN = "https://login.microsoftonline.com";
// Entra client secrets use these characters only; anything else is refused before it reaches `security -i`.
const SECRET_CHARS = /^[A-Za-z0-9~._-]+$/;

export class GraphError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    // The other scripts' not-found and retry checks read `stderr`.
    this.stderr = message;
  }
}

// The admin app's secret from the keychain, or null when there is no such item.
export async function readAdminSecret({ runner, tenantId, appId }) {
  try {
    const { stdout } = await runner("security", ["find-generic-password", "-s", adminKeychainService(tenantId), "-a", appId, "-w"]);
    const secret = trimOneNewline(stdout ?? "");
    return secret || null;
  } catch (error) {
    if (/could not be found|SecKeychainSearchCopyNext|exit 44/i.test(`${error?.stderr ?? ""} ${error?.message ?? ""}`)) return null;
    throw error;
  }
}

// Stores (or replaces, -U) the admin app's secret, through stdin only, and reads it back.
export async function storeAdminSecret({ runner, tenantId, appId, secret }) {
  if (!SECRET_CHARS.test(secret)) throw new Error("The admin app's new client secret has characters a keychain command can't carry; nothing was stored.");
  await runner("security", ["-i"], { input: `add-generic-password -U -a ${appId} -s ${adminKeychainService(tenantId)} -w "${secret}"\n` });
  const stored = await readAdminSecret({ runner, tenantId, appId });
  if (!stored || fingerprint(stored) !== fingerprint(secret)) throw new Error(`The keychain item ${adminKeychainService(tenantId)} doesn't read back as the secret just stored.`);
}

const claimsOf = (token) => {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
};

// Graph through the admin app. `fresh` says this run just created the secret or granted roles, so a refused secret or
// a token without every role is waited for (both take effect after a delay) instead of failing at once.
export function createAdminGraph({ tenantId, appId, secret, fetch, sleep, fresh = () => false, tries = 20, waitMs = 15_000 }) {
  let cached = null;

  async function requestToken() {
    const body = new URLSearchParams({ client_id: appId, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    const response = await fetch(`${LOGIN}/${tenantId}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || !answer.access_token) {
      // Entra's error description names the app and the request, never the secret.
      const code = answer.error ?? `HTTP ${response.status}`;
      throw new GraphError(`The ${ADMIN_APP_NAME} app could not sign in to tenant ${tenantId}: ${code}: ${String(answer.error_description ?? "").split("\n")[0].slice(0, 200)}`, { status: response.status, code });
    }
    return answer.access_token;
  }

  async function token({ refresh = false } = {}) {
    if (cached && !refresh) return cached;
    for (let attempt = 0; ; attempt += 1) {
      let candidate;
      try {
        candidate = await requestToken();
      } catch (error) {
        // A new client secret is refused (AADSTS7000215, invalid_client), and a new service principal not found
        // (AADSTS700016, unauthorized_client), until Entra has it everywhere.
        if ((error.code === "invalid_client" || error.code === "unauthorized_client") && fresh() && attempt < tries) {
          await sleep(waitMs);
          continue;
        }
        throw error;
      }
      const claims = claimsOf(candidate);
      if (claims.tid !== tenantId) throw new GraphError(`The ${ADMIN_APP_NAME} token is for tenant ${claims.tid ?? "(none)"}, not ${tenantId}; nothing was called.`, { code: "wrong-tenant" });
      const missing = ADMIN_ROLES.filter((role) => !(claims.roles ?? []).includes(role));
      if (missing.length && fresh() && attempt < tries) {
        await sleep(waitMs);
        continue;
      }
      if (missing.length) throw new GraphError(`The ${ADMIN_APP_NAME} app's token lacks ${missing.join(", ")}; grant them (provision-identity.mjs does) and run this again.`, { code: "missing-roles" });
      cached = candidate;
      return cached;
    }
  }

  // One Graph call. `body` is the request's JSON text. Resolves with the parsed answer, or null for an empty one.
  // A failure names the method, the path and Graph's error code and message, never the request body.
  async function call(method, url, body) {
    const path = new URL(url).pathname.replace(/^\/v1\.0\//, "");
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { method: method.toUpperCase(), headers: { Authorization: `Bearer ${await token({ refresh: attempt > 0 })}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body }) });
      const text = await response.text();
      if (response.ok) return text.trim() ? JSON.parse(text) : null;
      // A role granted moments ago may not be in effect yet.
      if (response.status === 403 && fresh() && attempt < tries) {
        await sleep(waitMs);
        continue;
      }
      let error = {};
      try {
        error = JSON.parse(text).error ?? {};
      } catch {
        error = {};
      }
      throw new GraphError(`graph ${method.toUpperCase()} ${path} failed: HTTP ${response.status} ${error.code ?? ""}: ${String(error.message ?? "").split("\n")[0].slice(0, 300)}`, { status: response.status, code: error.code });
    }
  }

  return { token, call, appId, tenantId };
}
