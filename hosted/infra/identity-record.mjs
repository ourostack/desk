// The non-secret facts about each Ouro tenant and its Azure pieces, kept in
// hosted/infra/identity-<env>.json, and the gateway settings they give.
//
// provision-identity.mjs writes the record; provision.sh (through app-yaml.mjs)
// reads it, so a rerun of either never recomputes an id, Ari's accountId or the
// legacy cutoff (plan rulings on DESK_LEGACY_CUTOFF and the mapped accounts).
// The record holds ids, names and times only: never a secret, a token or an
// email address.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint } from "../src/auth/seal.js";
import { ISO_TIME, readIdentity } from "../src/identity-config.js";

export const SUBSCRIPTION = "261e0bf1-934d-41ab-9295-229b0d254418";
export const APPS_RESOURCE_GROUP = "rg-ouro-work-substrate";
export const IDENTITY_RESOURCE_GROUP = "rg-ouro-identity";
export const LOCATION = "eastus2";
export const VAULT = "kv-ouro-identity-261e0b";
export const GATEWAY_APP_NAME = "ouro-desk-hosted";
export const AUTOMATION_APP_NAME = "ouro-identity-automation";
// Each stage's gateway has its own identity, so staging can reach neither production's Entra secret nor its
// accounts tables (ledger ruling on review I2).
export const GATEWAY_IDENTITIES = { prod: "id-ouro-desk-hosted", test: "id-ouro-desk-hosted-staging" };
export const CHECKS_IDENTITY = "id-ouro-identity-checks";
// Production's image-pull identity. It also holds roles on production storage and the email domain, so staging never
// holds it; staging pulls with its own gateway identity (re-review N-I1; provision.sh).
export const PROD_PULL_IDENTITY = "ouro-prod-services-mi";
export const IDENTITY_ENVIRONMENT = "identity";
export const GITHUB_REPO = "ourostack/desk";
export const CHECKS_SUBJECT = "repo:ourostack@265728804/desk@1386529300:environment:identity";
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const FEDERATED_AUDIENCE = "api://AzureADTokenExchange";
export const TABLES = ["accounts", "identities", "invites", "bindings"];
// The Container App secret that references the gateway's Entra client secret in Key Vault.
export const ENTRA_SECRET_REF = "entra-client-secret";
export const ARI = { githubUserId: 16390116, githubLogin: "arimendelow", displayName: "Ari Mendelow", authorEmail: "16390116+arimendelow@users.noreply.github.com" };

const AZURE_DOMAIN = "blueflower-44af4710.eastus2.azurecontainerapps.io";

// What differs between the two environments. The tenant names follow spike.md
// (`ouro` and `ourotest` were taken; the ruling chose `ourobot` and `ourobottest`).
export const ENVIRONMENTS = {
  prod: {
    app: "ouro-desk-hosted",
    gatewayIdentity: GATEWAY_IDENTITIES.prod,
    storage: "stouroaccounts261e0b",
    tenantCandidates: ["ourobot", "ouroid"],
    tenantDisplayName: "Ouro",
    repo: "arimendelow/desk",
    publicUrl: "https://desk.ouro.bot",
    publicUrls: ["https://desk.ouro.bot", `https://ouro-desk-hosted.${AZURE_DOMAIN}`],
    inviteTtlMs: 24 * 3600 * 1000,
    probe: "prod-legacy",
  },
  test: {
    app: "ouro-desk-hosted-staging",
    gatewayIdentity: GATEWAY_IDENTITIES.test,
    storage: "stouroacctstest261e0b",
    tenantCandidates: ["ourobottest", "ouroidtest"],
    tenantDisplayName: "Ouro (test)",
    repo: "arimendelow/desk-rehearsal",
    publicUrl: `https://ouro-desk-hosted-staging.${AZURE_DOMAIN}`,
    publicUrls: [`https://ouro-desk-hosted-staging.${AZURE_DOMAIN}`],
    inviteTtlMs: 7 * 24 * 3600 * 1000,
    probe: "staging-legacy",
  },
};

export function environment(env) {
  const settings = ENVIRONMENTS[env];
  if (!settings) throw new Error("--env must be test or prod.");
  return settings;
}

export const entraSecretName = (env) => `entra-client-secret-${env}`;
export const appleKeySecretName = (slot, env) => `apple-siwa-key-${slot}-${env}`;
// The Apple client secret Entra makes from a key lasts six months. Key Vault secret apple-siwa-active-<env> holds the
// slot letter Entra was last given and, in its `apple-renewed-at` tag, when: written by provision-identity.mjs when it
// creates the provider, by identity-checks.mjs after a renewal Graph accepted, and by `identity-checks.mjs
// --record-apple-upload` after a manual admin-center upload (outcome B). The daily check counts the age from it.
export const appleActiveSecretName = (env) => `apple-siwa-active-${env}`;
export const APPLE_RENEWED_TAG = "apple-renewed-at";
export const appleActiveSetArgs = (env, renewedAt) => ["keyvault", "secret", "set", "--vault-name", VAULT, "--name", appleActiveSecretName(env), "--file", "/dev/stdin", "--encoding", "utf-8", "--tags", `${APPLE_RENEWED_TAG}=${renewedAt}`, "--query", "id", "-o", "tsv", "--subscription", SUBSCRIPTION];
// Tags that bind a Key Vault secret to what it holds (Task 7 review C1 and I3). An Apple key slot carries the Key ID
// read from its .p8 file name at import and the key's fingerprint; the gateway's Entra client secret carries the keyId
// of the app credential it is. A fingerprint is an HMAC keyed by the key, so it is safe to store and log.
export const KEY_ID_TAG = "key-id";
export const FINGERPRINT_TAG = "fingerprint";
// During a gateway client-secret rotation, the credential the new Key Vault version replaces; it is deleted only once
// the gateway logs the new secret's fingerprint (provision-identity.mjs --rotate entra-secret).
export const PREVIOUS_KEY_ID_TAG = "previous-key-id";
// `revoked` counts by its presence, whatever its value (review minor 7): `--tags revoked=` still marks the slot.
export const isRevoked = (tags) => Boolean(tags) && Object.hasOwn(tags, "revoked");
// Why a slot's key can't be sent with the record's Key ID, or null. `value` is checked only when given.
export function appleKeyProblem({ tags, recordedKeyId, value }) {
  if (!recordedKeyId) return "identity-<env>.json records no Key ID for it";
  if (tags?.[KEY_ID_TAG] !== recordedKeyId) return `its Key ID tag (${tags?.[KEY_ID_TAG] ?? "none"}) doesn't match the recorded Key ID ${recordedKeyId}`;
  if (value !== undefined && (!tags?.[FINGERPRINT_TAG] || fingerprint(value) !== tags[FINGERPRINT_TAG])) return "its key doesn't match the fingerprint taken at import";
  return null;
}
export const vaultSecretUrl = (name) => `https://${VAULT}.vault.azure.net/secrets/${name}`;
export const recordPath = (env, dir) => join(dir, `identity-${env}.json`);

export function emptyRecord(env) {
  return { env, tenant: null, gatewayApp: null, automationApp: null, userFlow: null, apple: null, gatewayIdentity: null, checksIdentity: null, storage: null, ari: null, legacyCutoff: null, releasedAt: null };
}

export function loadRecordFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadRecord(env, dir) {
  try {
    return { ...emptyRecord(env), ...loadRecordFile(recordPath(env, dir)) };
  } catch (error) {
    if (error.code === "ENOENT") return emptyRecord(env);
    throw error;
  }
}

export function saveRecord(record, dir) {
  writeFileSync(recordPath(record.env, dir), `${JSON.stringify(record, null, 2)}\n`);
}

// The gateway's Ouro settings from a record, as app-yaml changes. Nothing is
// set until the record is complete, Ari's accountId included: a partial set
// would stop the gateway at start (readConfig refuses one), and an empty
// GitHub map would shut out Ari's legacy connector.
// `githubSignIn` is DESK_GITHUB_SIGNIN: the caller passes the operator's value, else the app's current one, so a
// rerun never turns the GitHub fallback back on (final review Minor 4); "on" only when neither is set.
export function identitySettings(record, { githubSignIn = "on" } = {}) {
  const none = { setEnv: {}, secretRefs: {}, keyVaultSecrets: {}, addIdentities: [] };
  const needed = {
    "tenant.id": record.tenant?.id,
    "tenant.subdomain": record.tenant?.subdomain,
    "gatewayApp.appId": record.gatewayApp?.appId,
    "storage.endpoint": record.storage?.endpoint,
    "gatewayIdentity.id": record.gatewayIdentity?.id,
    "gatewayIdentity.clientId": record.gatewayIdentity?.clientId,
    "ari.accountId": record.ari?.accountId,
    "ari.githubUserId": record.ari?.githubUserId,
    "ari.githubLogin": record.ari?.githubLogin,
  };
  const missing = Object.entries(needed).filter(([, value]) => value === undefined || value === null || value === "").map(([name]) => name);
  if (missing.length) return { ...none, missing };
  const setEnv = {
    DESK_ENTRA_TENANT_ID: record.tenant.id,
    DESK_ENTRA_SUBDOMAIN: record.tenant.subdomain,
    DESK_ENTRA_CLIENT_ID: record.gatewayApp.appId,
    DESK_ACCOUNTS_ENDPOINT: record.storage.endpoint,
    AZURE_CLIENT_ID: record.gatewayIdentity.clientId,
    DESK_GITHUB_SIGNIN: githubSignIn,
    DESK_GITHUB_ACCOUNTS: `${record.ari.githubUserId}=${record.ari.accountId}`,
    DESK_GITHUB_LOGINS: `${record.ari.githubUserId}=${record.ari.githubLogin}`,
  };
  if (record.legacyCutoff) setEnv.DESK_LEGACY_CUTOFF = record.legacyCutoff;
  return {
    setEnv,
    secretRefs: { DESK_ENTRA_CLIENT_SECRET: ENTRA_SECRET_REF },
    keyVaultSecrets: { [ENTRA_SECRET_REF]: { keyVaultUrl: vaultSecretUrl(entraSecretName(record.env)), identity: record.gatewayIdentity.id } },
    addIdentities: [record.gatewayIdentity.id],
    missing: [],
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isTime = (text) => typeof text === "string" && ISO_TIME.test(text) && !Number.isNaN(Date.parse(text));

// Refuses settings the gateway would refuse at start, or that would quietly do harm, before anything is written to the
// app (final review finding 1). `env` is the gateway env the write would produce and `current` the app's env now. The
// gateway's own reader checks the Ouro settings; a placeholder stands in for the Key Vault secret, which isn't here.
export function checkIdentitySettings({ record, env, current = {}, now = Date.now() }) {
  const refuse = (problem) => {
    throw new Error(`identity-${record.env}.json: ${problem} This update was not sent to the app.`);
  };
  try {
    readIdentity({ ...env, DESK_ENTRA_CLIENT_SECRET: "check-only" }, "https://desk.invalid");
  } catch (error) {
    refuse(`the gateway would refuse these settings and fail to start: ${error.message}`);
  }
  if (!/^https:\/\/[a-z0-9]{3,24}\.table\.core\.windows\.net\/?$/.test(record.storage.endpoint)) refuse(`storage.endpoint must be https://<account>.table.core.windows.net, not ${record.storage.endpoint}.`);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(record.tenant.subdomain)) refuse(`tenant.subdomain must be the tenant's subdomain, such as ourobottest, not ${record.tenant.subdomain}.`);
  if (!GUID.test(record.gatewayIdentity.clientId)) refuse("gatewayIdentity.clientId must be the identity's client id, a GUID.");
  const released = record.releasedAt ?? null;
  if (released !== null && !isTime(released)) refuse(`releasedAt must be an ISO time with its zone, such as 2026-11-01T00:00:00Z, not ${released}.`);
  const cutoff = record.legacyCutoff ?? null;
  if (cutoff === null) return;
  if (!isTime(cutoff)) refuse(`legacyCutoff must be an ISO time with its zone, such as 2026-11-15T00:00:00Z, not ${cutoff}.`);
  if (released !== null && Date.parse(cutoff) <= Date.parse(released)) refuse(`legacyCutoff ${cutoff} must be after releasedAt ${released}.`);
  // A cutoff already on the app may have passed (a rerun after day 14); a new one in the past would end every legacy
  // connector the moment the revision starts.
  if (Date.parse(cutoff) <= now && current.DESK_LEGACY_CUTOFF !== cutoff) {
    refuse(`legacyCutoff ${cutoff} is in the past, and the app holds ${current.DESK_LEGACY_CUTOFF ?? "no cutoff"}; setting it would end every legacy connector at once. Record a future cutoff.`);
  }
}

// The plan sets the cutoff 14 days after the release; a gap far from that is most likely a typo (re-review m3).
export function cutoffGapWarning(record) {
  if (!record.releasedAt || !record.legacyCutoff) return null;
  const days = Math.round((Date.parse(record.legacyCutoff) - Date.parse(record.releasedAt)) / (24 * 3600 * 1000));
  if (days >= 13 && days <= 15) return null;
  return `WARNING: identity-${record.env}.json's legacyCutoff ${record.legacyCutoff} is ${days} days after releasedAt ${record.releasedAt}; the plan is 14 days. Check it before relying on it.`;
}

// The cutoff must be set within a day of the release (spec: 14 days after shipping); a forgotten one fails open.
export function cutoffWarning(record, now = Date.now()) {
  if (!record.releasedAt || record.legacyCutoff) return null;
  if (now - Date.parse(record.releasedAt) <= 24 * 3600 * 1000) return null;
  return `WARNING: identity-${record.env}.json records releasedAt ${record.releasedAt} but no legacyCutoff; legacy tokens never expire until it is set.`;
}
