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
export function identitySettings(record) {
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
    DESK_GITHUB_SIGNIN: "on",
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

// The cutoff must be set within a day of the release (spec: 14 days after shipping); a forgotten one fails open.
export function cutoffWarning(record, now = Date.now()) {
  if (!record.releasedAt || record.legacyCutoff) return null;
  if (now - Date.parse(record.releasedAt) <= 24 * 3600 * 1000) return null;
  return `WARNING: identity-${record.env}.json records releasedAt ${record.releasedAt} but no legacyCutoff; legacy tokens never expire until it is set.`;
}
