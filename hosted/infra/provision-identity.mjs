#!/usr/bin/env node
// Builds an Ouro tenant's sign-in pieces and their Azure resources from scratch,
// and reconciles them on every rerun; records every non-secret id in
// hosted/infra/identity-<env>.json, which provision.sh reads.
//
//   node hosted/infra/provision-identity.mjs --env test|prod [--dry-run]
//       creates or reconciles, each step reading first: the tenant (named in the
//       record, or the first free candidate), the accounts storage account, the
//       gateway identity id-ouro-desk-hosted and the checks identity
//       id-ouro-identity-checks with their roles, the gateway app registration
//       ouro-desk-hosted with its 12-month client secret (written to Key Vault
//       through stdin), the ouro-identity-automation app, email one-time codes,
//       the Apple provider (outcome A; outcome B stops with the admin-center
//       steps), the user flow, and the GitHub environment `identity`.
//   ... --apple-key-file <p8> --apple-key-slot a|b [--apple-key-id <id>] [--keep-file]
//       imports an Apple key into Key Vault through stdin, tagged with its Key ID
//       (from AuthKey_<id>.p8, or --apple-key-id) and fingerprint, which clears
//       any `revoked` tag on that slot; records the Key ID in identity-<env>.json;
//       and deletes the file once Key Vault returns the same bytes (unless --keep-file).
//   ... --seed-ari            reconciles, then creates Ari's account and binding and records his accountId
//   ... --invite-ari [--browser-context <name>]
//       issues an invite for the recorded account: 24 hours in prod, written to
//       ~/.ouro/invite-prod.url (0600) and opened through the CDP opener
//       (DESK_CDP_OPENER) in the named browser context, never printed; 7 days in
//       test, printed.
//   ... --copy-app-secrets    (test) copies the GitHub App's four secrets from production to staging
//   ... --clear-app-secrets   (test) writes `unset` over staging's four GitHub App secrets
//   ... --migrate client-key  copies desk-signing-key into desk-client-key and sets DESK_CLIENT_KEY
//   ... --rotate signing-key  (test) rotates the signing key with a 30-day overlap
//   ... --rotate signing-key --emergency
//       (prod or test) for a signing key that may have leaked: new random signing and client keys, no previous key;
//       every client registers and signs in again
//   ... --rotate entra-secret  adds a 12-month gateway client secret, writes it to Key Vault through stdin tagged
//       key-id=<new> previous-key-id=<old>, restarts the app, and deletes the old credential only once the gateway's
//       startup line logs the new secret's fingerprint; a rerun finishes a rotation the gateway hadn't confirmed yet
//
// Secrets move only inside this process: read with `--query value -o tsv`,
// trimmed of az's one trailing newline, and written through a child's stdin or
// through a whole-app document (app-yaml.mjs) in a 0600 file. No secret is ever
// an argument or printed; logs carry fingerprints only. Every call to az, gh,
// the probe or the CDP opener goes through `runner`, so tests replace it.
//
// az must be signed in to the Azure subscription and, for the Graph steps, have
// the env's tenant as its current account (the script checks and says how).
import { chmodSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fingerprint } from "../src/auth/seal.js";
import { defaultRunner, trimOneNewline } from "./runner.mjs";
import { issueInvite, seed } from "../src/accounts/invites.js";
import { buildAppYaml, checkWritten, isKeyVaultFillFailure, keyVaultFillFailure, writeAppYaml } from "./app-yaml.mjs";
import {
  APPS_RESOURCE_GROUP,
  ARI,
  AUTOMATION_APP_NAME,
  CHECKS_IDENTITY,
  CHECKS_SUBJECT,
  ENVIRONMENTS,
  FEDERATED_AUDIENCE,
  GATEWAY_APP_NAME,
  GITHUB_ISSUER,
  GITHUB_REPO,
  IDENTITY_ENVIRONMENT,
  IDENTITY_RESOURCE_GROUP,
  LOCATION,
  PROD_PULL_IDENTITY,
  SUBSCRIPTION,
  VAULT,
  APPLE_RENEWED_TAG,
  FINGERPRINT_TAG,
  KEY_ID_TAG,
  PREVIOUS_KEY_ID_TAG,
  appleActiveSecretName,
  appleKeyProblem,
  isRevoked,
  appleActiveSetArgs,
  appleKeySecretName,
  entraSecretName,
  environment,
  loadRecord,
  saveRecord,
} from "./identity-record.mjs";
import {
  CLIENT_KEY_MIGRATION,
  checkClientKeyLine,
  checkCopySource,
  checkEmergencyLine,
  emergencyChanges,
  checkReadBack,
  checkRotatedLine,
  newestKeysLine,
  refuseRotation,
  rotationChanges,
  secretFromAz,
} from "./signing-keys.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUB = ["--subscription", SUBSCRIPTION];
const GRAPH = "https://graph.microsoft.com/v1.0/";
const CIAM_API = "2023-05-17-preview";
const GRAPH_APP = "00000003-0000-0000-c000-000000000000";
// Microsoft Graph's ids: the application roles IdentityProvider.ReadWrite.All and Application.Read.All, and the
// delegated openid and profile.
const IDENTITY_PROVIDER_READWRITE_ALL = "90db2b9a-d928-4d33-a4dd-8442ae3d41e4";
const APPLICATION_READ_ALL = "9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30";
// The automation app's Graph roles in its tenant. IdentityProvider.ReadWrite.All lets the identity-checks workflow
// renew the Apple provider. Application.Read.All lets it read the gateway app's passwordCredentials[].endDateTime
// (Task 7): it is the least-privileged application permission Microsoft documents for GET /applications/{id}. The only
// narrower-scoped one, Application.ReadWrite.OwnedBy with the automation app as the gateway app's owner, would also let
// it add credentials to the gateway app, which is worse than reading every app registration in this tenant.
const AUTOMATION_ROLES = { [IDENTITY_PROVIDER_READWRITE_ALL]: "IdentityProvider.ReadWrite.All", [APPLICATION_READ_ALL]: "Application.Read.All" };
const OPENID = "37f7f235-527c-4136-accd-4a02d197296e";
const PROFILE = "14dad69e-099b-42c9-810b-d002981feec1";
const APPLE_TYPE = "#microsoft.graph.appleManagedIdentityProvider";
const EMAIL_OTP_PROVIDER = "EmailOtpSignup-OAUTH";
const USER_FLOW_NAME = "Ouro sign-in";
const FLOW_IDPS = "microsoft.graph.externalUsersSelfServiceSignUpEventsFlow/onAuthenticationMethodLoadStart/microsoft.graph.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp/identityProviders";
const APP_SECRETS = ["desk-app-id", "desk-app-client-id", "desk-app-client-secret", "desk-app-key"];
const PROD_APP = ENVIRONMENTS.prod.app;
const STAGING_APP = ENVIRONMENTS.test.app;
const CHECKS_FEDERATED_NAME = "github-identity-environment";
const POLL_MS = 15_000;
// Graph's directory reads lag its writes by seconds.
const GRAPH_LAG_TRIES = 12;
const GRAPH_LAG_MS = 5_000;
// A role assignment takes minutes to reach a data plane (Key Vault, Table Storage).
const PROPAGATION_TRIES = 20;
const FORBIDDEN = /Forbidden|AuthorizationFailed|AuthorizationPermissionMismatch|HTTP 403|\(403\)/i;

// Ends a run on purpose, with what the operator does next.
export class Stop extends Error {}

const placeholder = (what) => `<${what} once created>`;
const isPlaceholder = (arg) => typeof arg === "string" && /^<.* once created>$/.test(arg);
const isNotFound = (error) => /ResourceNotFound|NotFound|Not Found|not found|could not be found|does not exist|HTTP 404|\(404\)/i.test(`${error?.stderr ?? ""} ${error?.message ?? ""}`);

// --- Reading -----------------------------------------------------------------------------------------------------

async function out(ctx, cmd, args, options) {
  return (await ctx.runner(cmd, args, options)).stdout ?? "";
}
async function azJson(ctx, args) {
  const text = (await out(ctx, "az", args)).trim();
  return text ? JSON.parse(text) : null;
}
async function maybe(read) {
  try {
    return await read();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const graphGet = (ctx, path) => azJson(ctx, ["rest", "--method", "get", "--url", `${GRAPH}${path}`]);
const graphCall = (method, path, body, { secret = false } = {}) => ({
  cmd: "az",
  args: ["rest", "--method", method, "--url", `${GRAPH}${path}`, "--headers", "Content-Type=application/json", "--body", "@/dev/stdin"],
  input: body === undefined ? undefined : JSON.stringify(body),
  secret,
});

// The name check takes its body through stdin, like every other az rest call here.
async function nameAvailable(ctx, name) {
  const result = JSON.parse(
    (await out(ctx, "az", ["rest", "--method", "post", "--url", `https://management.azure.com/subscriptions/${SUBSCRIPTION}/providers/Microsoft.AzureActiveDirectory/checkNameAvailability?api-version=${CIAM_API}`, "--headers", "Content-Type=application/json", "--body", "@/dev/stdin"], { input: JSON.stringify({ name, countryCode: "US" }) })) || "{}",
  );
  return result.nameAvailable === true;
}

async function findTenant(ctx) {
  const { record, settings } = ctx;
  if (record.tenant?.id) return record.tenant;
  const named = record.tenant?.name;
  const candidates = [...new Set([...(named ? [named] : []), ...settings.tenantCandidates])];
  for (const name of candidates) {
    const shown = await maybe(() =>
      azJson(ctx, ["resource", "show", "-g", IDENTITY_RESOURCE_GROUP, "--namespace", "Microsoft.AzureActiveDirectory", "--resource-type", "ciamDirectories", "-n", name, "--api-version", CIAM_API, "--query", "{tenantId: properties.tenantId, domainName: properties.domainName}", "-o", "json", ...SUB]),
    );
    if (shown) return shown.tenantId ? { name, subdomain: name, id: shown.tenantId, domain: shown.domainName ?? `${name}.onmicrosoft.com` } : { name, pending: true };
    if (await nameAvailable(ctx, name)) return { name, create: true };
    ctx.log(`Tenant name ${name} is taken; trying the next candidate.`);
  }
  return { missing: true, candidates };
}

// A read that misses something this run created waits for Graph to show it, and never lets the plan create it
// again (review I5). `expected` is true when this run created it.
async function untilVisible(ctx, read, expected, what) {
  let found = await read();
  for (let attempt = 0; !found && expected && attempt < GRAPH_LAG_TRIES; attempt += 1) {
    await ctx.sleep(GRAPH_LAG_MS);
    found = await read();
  }
  if (!found && expected) throw new Error(`${what} was created by this run, but Graph doesn't show it yet; run this again in a few minutes.`);
  return found;
}

async function readApp(ctx, displayName) {
  const list = async () => {
    const apps = (await azJson(ctx, ["ad", "app", "list", "--display-name", displayName, "--query", "[].{appId: appId, id: id, redirects: web.redirectUris, tokenVersion: api.requestedAccessTokenVersion, passwords: length(passwordCredentials), access: requiredResourceAccess}", "-o", "json"])) ?? [];
    if (apps.length > 1) throw new Error(`There are ${apps.length} app registrations named ${displayName}; keep one, delete the others, and run this again.`);
    return apps[0] ?? null;
  };
  const app = await untilVisible(ctx, list, Boolean(ctx.created.apps[displayName]), `App registration ${displayName}`);
  if (!app) return null;
  const readSp = async () => lines(await out(ctx, "az", ["ad", "sp", "list", "--filter", `appId eq '${app.appId}'`, "--query", "[].id", "-o", "tsv"]))[0] ?? null;
  const servicePrincipalId = await untilVisible(ctx, readSp, ctx.created.servicePrincipals.has(app.appId), `The service principal of ${displayName}`);
  return { ...app, servicePrincipalId };
}

// The signed-in operator's object id in the Azure tenant that holds the subscription, from the oid claim of an
// ARM token az issues for it. Graph can't be used: az's current account is the Ouro tenant during a run, and the
// workforce tenant may block Graph. The token stays in memory and is never logged.
async function operator(ctx) {
  if (ctx.operator) return ctx.operator;
  const token = (await out(ctx, "az", ["account", "get-access-token", ...SUB, "--query", "accessToken", "-o", "tsv"])).trim();
  let claims = null;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    claims = null;
  }
  if (!claims?.oid) throw new Error("Could not read the signed-in operator's object id from az's token for the subscription; sign az in to it (az login) and run this again.");
  ctx.operator = { oid: claims.oid };
  return ctx.operator;
}

// Gives the signed-in operator a data role the run needs (review I3): Key Vault Secrets Officer on the vault, and
// Storage Table Data Contributor on this env's accounts storage for seeding. Returns false in a dry run when the
// role is missing, so the caller knows it can't read that data plane yet.
async function ensureOperatorRole(ctx, role, scope) {
  const { oid } = await operator(ctx);
  if (hasRole(await rolesAt(ctx, scope), oid, role)) return true;
  const args = ["role", "assignment", "create", "--assignee-object-id", oid, "--assignee-principal-type", "User", "--role", role, "--scope", scope, "--output", "none", ...SUB];
  if (ctx.dryRun) {
    ctx.log(`==> operator access: ${role} on ${scope.split("/").at(-1)}`);
    ctx.log(`    would run: az ${args.join(" ")}`);
    return false;
  }
  ctx.log(`Granting the signed-in operator ${role} on ${scope.split("/").at(-1)}.`);
  await out(ctx, "az", args);
  return true;
}

// Runs `action`, retrying while a new role assignment hasn't reached the data plane yet.
async function propagated(ctx, action, what) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!FORBIDDEN.test(`${error?.stderr ?? ""} ${error?.message ?? ""}`) || attempt >= PROPAGATION_TRIES) throw error;
      if (attempt === 0) ctx.log(`${what} is refused while a new role assignment takes effect; retrying for up to ${(PROPAGATION_TRIES * POLL_MS) / 60_000} minutes.`);
      await ctx.sleep(POLL_MS);
    }
  }
}

async function readIdentity(ctx, name) {
  const identity = await maybe(() => azJson(ctx, ["identity", "show", "-n", name, "-g", IDENTITY_RESOURCE_GROUP, "--query", "{id: id, clientId: clientId, principalId: principalId, tenantId: tenantId}", "-o", "json", ...SUB]));
  return identity ? { name, ...identity } : null;
}

async function rolesAt(ctx, scope) {
  if (!scope || isPlaceholder(scope)) return [];
  return (await azJson(ctx, ["role", "assignment", "list", "--scope", scope, "--query", "[].{principalId: principalId, roleDefinitionName: roleDefinitionName}", "-o", "json", ...SUB])) ?? [];
}

export async function readState(ctx) {
  const { env, settings } = ctx;
  const state = {};
  state.tenant = await findTenant(ctx);
  state.vaultId = ctx.vaultId ?? (await vaultId(ctx));
  if (ctx.vaultReadable === false) {
    // A dry run before the operator holds a Key Vault data role: every vault secret is planned as missing.
    state.vaultSecrets = [];
  } else {
    state.vaultSecrets = lines(await propagated(ctx, () => out(ctx, "az", ["keyvault", "secret", "list", "--vault-name", VAULT, "--query", "[].name", "-o", "tsv", ...SUB]), "Reading Key Vault"));
  }
  const storage = await maybe(() => azJson(ctx, ["storage", "account", "show", "-n", settings.storage, "-g", IDENTITY_RESOURCE_GROUP, "--query", "{id: id, endpoint: primaryEndpoints.table, sharedKey: allowSharedKeyAccess, tls: minimumTlsVersion}", "-o", "json", ...SUB]));
  state.storage = storage ? { account: settings.storage, id: storage.id, endpoint: storage.endpoint.replace(/\/+$/, ""), sharedKey: storage.sharedKey, tls: storage.tls } : null;
  state.gatewayIdentity = await readIdentity(ctx, settings.gatewayIdentity);
  state.checksIdentity = await readIdentity(ctx, CHECKS_IDENTITY);
  state.containerApps = {};
  // The checks identity reads this env's app only, so a test run writes nothing on production's app (review m2).
  for (const app of [settings.app]) {
    state.containerApps[app] = (await maybe(() => out(ctx, "az", ["containerapp", "show", "-n", app, "-g", APPS_RESOURCE_GROUP, "--query", "id", "-o", "tsv", ...SUB])))?.trim() || null;
  }
  state.entraSecretScope = `${state.vaultId}/secrets/${entraSecretName(env)}`;
  state.roles = {
    entraSecret: await rolesAt(ctx, state.vaultSecrets.includes(entraSecretName(env)) ? state.entraSecretScope : null),
    storage: await rolesAt(ctx, state.storage?.id),
    vault: await rolesAt(ctx, state.vaultId),
    apps: Object.fromEntries(await Promise.all(Object.entries(state.containerApps).map(async ([app, id]) => [app, await rolesAt(ctx, id)]))),
  };
  if (state.checksIdentity) {
    state.checksIdentity.subjects = lines(await out(ctx, "az", ["identity", "federated-credential", "list", "--identity-name", CHECKS_IDENTITY, "-g", IDENTITY_RESOURCE_GROUP, "--query", "[].subject", "-o", "tsv", ...SUB]));
  }

  // GitHub's environment, its branch policy and variables.
  state.github = { environment: Boolean(await maybe(() => out(ctx, "gh", ["api", `repos/${GITHUB_REPO}/environments/${IDENTITY_ENVIRONMENT}`]))) };
  state.github.branches = state.github.environment ? JSON.parse((await out(ctx, "gh", ["api", `repos/${GITHUB_REPO}/environments/${IDENTITY_ENVIRONMENT}/deployment-branch-policies`, "--jq", "[.branch_policies[].name]"])) || "[]") : [];
  // Listing variables of an environment that doesn't exist answers 404 (review I4).
  state.github.variables = !state.github.environment ? {} : Object.fromEntries(((await azJsonGh(ctx, ["variable", "list", "--env", IDENTITY_ENVIRONMENT, "-R", GITHUB_REPO, "--json", "name,value"])) ?? []).map(({ name, value }) => [name, value]));

  // Graph, in the env's tenant only.
  if (!state.tenant.id) return state;
  const signedIn = (await out(ctx, "az", ["account", "show", "--query", "tenantId", "-o", "tsv"])).trim();
  if (signedIn !== state.tenant.id) {
    throw new Error(`az's current account is in tenant ${signedIn || "(none)"}, not ${state.tenant.name} (${state.tenant.id}). Run: az login --tenant ${state.tenant.id} --allow-no-subscriptions, then az account set --subscription ${state.tenant.id}, and run this again.`);
  }
  state.graph = true;
  state.email = await graphGet(ctx, "policies/authenticationMethodsPolicy/authenticationMethodConfigurations/email");
  const providers = (await graphGet(ctx, "identity/identityProviders"))?.value ?? [];
  state.apple = providers.find((provider) => provider["@odata.type"] === APPLE_TYPE) ?? null;
  state.gatewayApp = await readApp(ctx, GATEWAY_APP_NAME);
  state.automationApp = await readApp(ctx, AUTOMATION_APP_NAME);
  if (state.automationApp) {
    state.automationApp.subjects = lines(await out(ctx, "az", ["ad", "app", "federated-credential", "list", "--id", state.automationApp.appId, "--query", "[].subject", "-o", "tsv"]));
    state.automationApp.appRoles = state.automationApp.servicePrincipalId
      ? ((await graphGet(ctx, `servicePrincipals/${state.automationApp.servicePrincipalId}/appRoleAssignments`))?.value ?? []).map(({ appRoleId }) => appRoleId)
      : [];
  }
  const readFlow = async () => {
    const flows = ((await graphGet(ctx, "identity/authenticationEventsFlows"))?.value ?? []).filter(({ displayName }) => displayName === USER_FLOW_NAME);
    if (flows.length > 1) throw new Error(`There are ${flows.length} user flows named ${USER_FLOW_NAME}; keep one, delete the others, and run this again.`);
    return flows[0] ?? null;
  };
  const flow = await untilVisible(ctx, readFlow, ctx.created.flow, `User flow ${USER_FLOW_NAME}`);
  state.userFlow = flow
    ? {
        id: flow.id,
        apps: ((await graphGet(ctx, `identity/authenticationEventsFlows/${flow.id}/conditions/applications/includeApplications`))?.value ?? []).map(({ appId }) => appId),
        idps: ((await graphGet(ctx, `identity/authenticationEventsFlows/${flow.id}/${FLOW_IDPS}`))?.value ?? []).map(({ id }) => id),
      }
    : null;
  return state;
}

async function azJsonGh(ctx, args) {
  const text = (await out(ctx, "gh", args)).trim();
  return text ? JSON.parse(text) : null;
}

// --- Planning ----------------------------------------------------------------------------------------------------

const call = (cmd, args, extra = {}) => ({ cmd, args, ...extra });
const az = (...args) => call("az", args.flat());

function hasRole(assignments, principalId, role) {
  return assignments.some((assignment) => assignment.principalId === principalId && assignment.roleDefinitionName === role);
}

function roleStep(name, identity, identityLabel, role, scope, assignments) {
  if (identity && scope && !isPlaceholder(scope) && hasRole(assignments ?? [], identity.principalId, role)) return [];
  const principal = identity?.principalId ?? placeholder(`${identityLabel} principal id`);
  return [{ name, calls: [az("role", "assignment", "create", "--assignee-object-id", principal, "--assignee-principal-type", "ServicePrincipal", "--role", role, "--scope", scope, SUB)] }];
}

function hasAccess(app, resourceAppId, id, type) {
  return (app?.access ?? []).some((resource) => resource.resourceAppId === resourceAppId && (resource.resourceAccess ?? []).some((access) => access.id === id && access.type === type));
}

const sameSet = (a = [], b = []) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

// The steps that would bring `state` to the env's target. Pure; `record` gives the Apple facts.
export function plan({ env, state, record = {} }) {
  const settings = environment(env);
  const steps = [];
  const tenant = state.tenant ?? {};
  if (tenant.create) {
    const body = { location: "United States", sku: { name: "Standard", tier: "A0" }, properties: { createTenantProperties: { displayName: settings.tenantDisplayName, countryCode: "US" } } };
    steps.push({
      name: "tenant",
      calls: [call("az", ["rest", "--method", "put", "--url", `https://management.azure.com/subscriptions/${SUBSCRIPTION}/resourceGroups/${IDENTITY_RESOURCE_GROUP}/providers/Microsoft.AzureActiveDirectory/ciamDirectories/${tenant.name}?api-version=${CIAM_API}`, "--headers", "Content-Type=application/json", "--body", "@/dev/stdin"], { input: JSON.stringify(body) })],
      stop: `Tenant ${tenant.name} is being created (up to 30 minutes). Once it shows a tenant id, sign az in to it (az login --tenant <id> --allow-no-subscriptions) and run this again.`,
    });
    return steps;
  }
  if (tenant.pending) return [{ name: "tenant", calls: [], stop: `Tenant ${tenant.name} is still being created; run this again once it has a tenant id.` }];
  if (tenant.missing) return [{ name: "tenant", calls: [], stop: `No tenant name is free among ${tenant.candidates.join(", ")}; add another candidate.` }];

  // Storage for the accounts store: Standard ZRS, no shared key, TLS 1.2.
  if (!state.storage) {
    steps.push({ name: "storage account", reread: true, calls: [az("storage", "account", "create", "-n", settings.storage, "-g", IDENTITY_RESOURCE_GROUP, "-l", LOCATION, "--sku", "Standard_ZRS", "--kind", "StorageV2", "--min-tls-version", "TLS1_2", "--allow-shared-key-access", "false", "--allow-blob-public-access", "false", "--https-only", "true", "--output", "none", SUB)] });
  } else if (state.storage.sharedKey !== false || state.storage.tls !== "TLS1_2") {
    steps.push({ name: "storage account settings", calls: [az("storage", "account", "update", "-n", settings.storage, "-g", IDENTITY_RESOURCE_GROUP, "--min-tls-version", "TLS1_2", "--allow-shared-key-access", "false", "--output", "none", SUB)] });
  }

  // The two managed identities.
  for (const [key, name] of [["gatewayIdentity", settings.gatewayIdentity], ["checksIdentity", CHECKS_IDENTITY]]) {
    if (!state[key]) steps.push({ name: `identity ${name}`, reread: true, calls: [az("identity", "create", "-n", name, "-g", IDENTITY_RESOURCE_GROUP, "-l", LOCATION, "--output", "none", SUB)] });
  }

  // The checks identity: its GitHub federated credential and roles.
  if (!(state.checksIdentity?.subjects ?? []).includes(CHECKS_SUBJECT)) {
    steps.push({ name: "checks identity federated credential", calls: [az("identity", "federated-credential", "create", "--name", CHECKS_FEDERATED_NAME, "--identity-name", CHECKS_IDENTITY, "-g", IDENTITY_RESOURCE_GROUP, "--issuer", GITHUB_ISSUER, "--subject", CHECKS_SUBJECT, "--audiences", FEDERATED_AUDIENCE, "--output", "none", SUB)] });
  }
  steps.push(...roleStep("checks identity: Key Vault Secrets Officer", state.checksIdentity, CHECKS_IDENTITY, "Key Vault Secrets Officer", state.vaultId, state.roles?.vault));
  for (const app of [settings.app]) {
    const id = state.containerApps?.[app];
    if (id) steps.push(...roleStep(`checks identity: Reader on ${app}`, state.checksIdentity, CHECKS_IDENTITY, "Reader", id, state.roles?.apps?.[app]));
  }
  // The gateway identity reads the accounts tables.
  steps.push(...roleStep("gateway identity: Storage Table Data Contributor", state.gatewayIdentity, settings.gatewayIdentity, "Storage Table Data Contributor", state.storage?.id ?? placeholder(`${settings.storage} id`), state.roles?.storage));

  // Everything below is in the tenant, through Graph.
  if (tenant.id && state.graph !== false) {
    const gateway = state.gatewayApp;
    const gatewayAppId = gateway?.appId ?? placeholder(`${GATEWAY_APP_NAME} appId`);
    const redirects = settings.publicUrls.map((url) => `${url}/oauth/entra/callback`);
    if (!gateway) {
      steps.push({ name: "gateway app registration", reread: true, creates: { app: GATEWAY_APP_NAME }, calls: [az("ad", "app", "create", "--display-name", GATEWAY_APP_NAME, "--sign-in-audience", "AzureADMyOrg", "--web-redirect-uris", ...redirects, "--query", "{appId: appId, id: id}", "-o", "json")] });
    } else if (!sameSet(gateway.redirects, redirects)) {
      steps.push({ name: "gateway app redirects", calls: [az("ad", "app", "update", "--id", gatewayAppId, "--web-redirect-uris", ...redirects)] });
    }
    if (gateway?.tokenVersion !== 2) steps.push({ name: "gateway app v2 tokens", calls: [az("ad", "app", "update", "--id", gatewayAppId, "--set", "api.requestedAccessTokenVersion=2")] });
    if (!gateway?.servicePrincipalId) steps.push({ name: "gateway service principal", creates: { servicePrincipal: gatewayAppId }, calls: [az("ad", "sp", "create", "--id", gatewayAppId, "--output", "none")] });
    if (!hasAccess(gateway, GRAPH_APP, OPENID, "Scope") || !hasAccess(gateway, GRAPH_APP, PROFILE, "Scope")) {
      steps.push({ name: "gateway app openid and profile", calls: [az("ad", "app", "permission", "add", "--id", gatewayAppId, "--api", GRAPH_APP, "--api-permissions", `${OPENID}=Scope`, `${PROFILE}=Scope`), az("ad", "app", "permission", "admin-consent", "--id", gatewayAppId)] });
    }
    // Its client secret: appended (an existing one keeps working), straight into Key Vault through stdin.
    if (!(state.vaultSecrets ?? []).includes(entraSecretName(env)) || !gateway?.passwords) {
      steps.push({
        name: "gateway client secret",
        gatewaySecret: true,
        calls: [
          az("ad", "app", "credential", "reset", "--id", gatewayAppId, "--append", "--display-name", `desk-gateway-${env}`, "--years", "1", "--query", "password", "-o", "tsv"),
          call("az", ["keyvault", "secret", "set", "--vault-name", VAULT, "--name", entraSecretName(env), "--file", "/dev/stdin", "--encoding", "utf-8", "--query", "id", "-o", "tsv", ...SUB], { input: "", secret: true }),
        ],
      });
    }
    steps.push(...roleStep("gateway identity: Key Vault Secrets User on its Entra secret", state.gatewayIdentity, settings.gatewayIdentity, "Key Vault Secrets User", state.entraSecretScope ?? `${state.vaultId}/secrets/${entraSecretName(env)}`, state.roles?.entraSecret));

    // The automation app the identity-checks workflow signs in to the tenant as.
    const automation = state.automationApp;
    const automationAppId = automation?.appId ?? placeholder(`${AUTOMATION_APP_NAME} appId`);
    if (!automation) steps.push({ name: "automation app registration", reread: true, creates: { app: AUTOMATION_APP_NAME }, calls: [az("ad", "app", "create", "--display-name", AUTOMATION_APP_NAME, "--sign-in-audience", "AzureADMyOrg", "--query", "{appId: appId, id: id}", "-o", "json")] });
    if (!automation?.servicePrincipalId) steps.push({ name: "automation service principal", reread: true, creates: { servicePrincipal: automationAppId }, calls: [az("ad", "sp", "create", "--id", automationAppId, "--output", "none")] });
    if (!(automation?.subjects ?? []).includes(CHECKS_SUBJECT)) {
      steps.push({ name: "automation federated credential", calls: [call("az", ["ad", "app", "federated-credential", "create", "--id", automationAppId, "--parameters", "@/dev/stdin"], { input: JSON.stringify({ name: CHECKS_FEDERATED_NAME, issuer: GITHUB_ISSUER, subject: CHECKS_SUBJECT, audiences: [FEDERATED_AUDIENCE] }) })] });
    }
    // Each role is added only if the app doesn't request it yet, and consent runs while any is not granted.
    const ungranted = Object.keys(AUTOMATION_ROLES).filter((id) => !(automation?.appRoles ?? []).includes(id));
    if (ungranted.length) {
      const unrequested = ungranted.filter((id) => !hasAccess(automation, GRAPH_APP, id, "Role"));
      const add = unrequested.length ? [az("ad", "app", "permission", "add", "--id", automationAppId, "--api", GRAPH_APP, "--api-permissions", ...unrequested.map((id) => `${id}=Role`))] : [];
      steps.push({ name: `automation app ${ungranted.map((id) => AUTOMATION_ROLES[id]).join(", ")}`, calls: [...add, az("ad", "app", "permission", "admin-consent", "--id", automationAppId)] });
    }

    // Email one-time codes for external users.
    if (state.email?.state !== "enabled" || state.email?.allowExternalIdToUseEmailOtp !== "enabled") {
      steps.push({ name: "email one-time code", calls: [graphCall("patch", "policies/authenticationMethodsPolicy/authenticationMethodConfigurations/email", { "@odata.type": "#microsoft.graph.emailAuthenticationMethodConfiguration", state: "enabled", allowExternalIdToUseEmailOtp: "enabled" })] });
    }

    // Apple: Graph under outcome A, the admin center under outcome B.
    const apple = record.apple ?? {};
    if (!state.apple) {
      if (apple.outcome === "A") {
        steps.push({
          name: "Apple provider",
          reread: true,
          appleProvider: true,
          calls: [
            az("keyvault", "secret", "show", "--vault-name", VAULT, "--name", appleKeySecretName("a", env), "--query", "value", "-o", "tsv", SUB),
            graphCall("post", "identity/identityProviders", { "@odata.type": APPLE_TYPE, displayName: "Sign in with Apple", developerId: apple.developerId, serviceId: apple.serviceId, keyId: apple.keyIds?.a, certificateData: "***" }, { secret: true }),
            // After Graph accepts the POST: the slot sent and when, which the daily Apple age check reads (Task 7).
            call("az", appleActiveSetArgs(env, "<time of the POST>"), { input: "<slot sent>" }),
          ],
        });
      } else {
        steps.push({ name: "Apple provider", calls: [], stop: adminCenterText({ env, tenant, apple }) });
        return steps;
      }
    }

    // The user flow: email code and Apple, used by the gateway app.
    const appleId = state.apple?.id ?? placeholder("Apple provider id");
    const flow = state.userFlow;
    if (!flow) {
      steps.push({
        name: "user flow",
        reread: true,
        creates: { flow: true },
        calls: [
          graphCall("post", "identity/authenticationEventsFlows", {
            "@odata.type": "#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow",
            displayName: USER_FLOW_NAME,
            onInteractiveAuthFlowStart: { "@odata.type": "#microsoft.graph.onInteractiveAuthFlowStartExternalUsersSelfServiceSignUp", isSignUpAllowed: true },
            onAuthenticationMethodLoadStart: { "@odata.type": "#microsoft.graph.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp", identityProviders: [{ id: EMAIL_OTP_PROVIDER }, { id: appleId }] },
            onUserCreateStart: { "@odata.type": "#microsoft.graph.onUserCreateStartExternalUsersSelfServiceSignUp", userTypeToCreate: "member" },
          }),
        ],
      });
    }
    const flowId = flow?.id ?? placeholder("user flow id");
    if (flow && !flow.idps.includes(appleId)) {
      steps.push({ name: "user flow: Apple", calls: [graphCall("post", `identity/authenticationEventsFlows/${flowId}/${FLOW_IDPS}/$ref`, { "@odata.id": `${GRAPH}identityProviders/${appleId}` })] });
    }
    if (!flow?.apps?.includes(gateway?.appId)) {
      steps.push({ name: "user flow: gateway app", calls: [graphCall("post", `identity/authenticationEventsFlows/${flowId}/conditions/applications/includeApplications`, { "@odata.type": "#microsoft.graph.authenticationConditionApplication", appId: gatewayAppId })] });
    }

    // The GitHub environment the identity-checks workflow runs in: main only, with variables naming the identities.
    const github = state.github ?? {};
    if (!github.environment) {
      steps.push({ name: "GitHub environment identity", calls: [call("gh", ["api", "-X", "PUT", `repos/${GITHUB_REPO}/environments/${IDENTITY_ENVIRONMENT}`, "--input", "-"], { input: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }) })] });
    }
    if (!(github.branches ?? []).includes("main")) {
      steps.push({ name: "GitHub environment: main only", calls: [call("gh", ["api", "-X", "POST", `repos/${GITHUB_REPO}/environments/${IDENTITY_ENVIRONMENT}/deployment-branch-policies`, "-f", "name=main", "-f", "type=branch"])] });
    }
    const variables = {
      AZURE_CHECKS_CLIENT_ID: state.checksIdentity?.clientId ?? placeholder(`${CHECKS_IDENTITY} client id`),
      AZURE_TENANT_ID: state.checksIdentity?.tenantId ?? placeholder(`${CHECKS_IDENTITY} tenant id`),
      AZURE_SUBSCRIPTION_ID: SUBSCRIPTION,
      [`OURO_TENANT_ID_${env.toUpperCase()}`]: tenant.id,
      [`OURO_AUTOMATION_CLIENT_ID_${env.toUpperCase()}`]: automationAppId,
    };
    for (const [name, value] of Object.entries(variables)) {
      if ((github.variables ?? {})[name] !== value) steps.push({ name: `GitHub variable ${name}`, calls: [call("gh", ["variable", "set", name, "--env", IDENTITY_ENVIRONMENT, "-R", GITHUB_REPO, "--body", value])] });
    }
  }
  return steps;
}

function adminCenterText({ env, tenant, apple }) {
  return [
    `The ${env} tenant ${tenant.name} has no Apple provider and Graph can't create it (outcome ${apple.outcome ?? "not recorded yet"}), so Ari adds it in the Entra admin center:`,
    `  1. Sign in to https://entra.microsoft.com as an admin of ${tenant.name} (${tenant.id}).`,
    "  2. External Identities > All identity providers > Apple (Add, or Edit if it exists).",
    `  3. Services ID ${apple.serviceId ?? "(see identity record)"}, Team ID ${apple.developerId ?? "(see identity record)"}, Key ID ${apple.keyIds?.a ?? "(see identity record)"}; upload that tenant's -a .p8.`,
    `  4. Run this again; the user flow and later steps continue.`,
  ].join("\n");
}

// --- Running -----------------------------------------------------------------------------------------------------

function describe(stepCall) {
  const input = stepCall.input === undefined ? "" : ` (stdin: ${stepCall.secret ? "***" : stepCall.input})`;
  return `${stepCall.cmd} ${stepCall.args.join(" ")}${input}`;
}

async function execCall(ctx, stepCall, input = stepCall.input) {
  if (stepCall.args.some(isPlaceholder)) throw new Error(`Internal: ${stepCall.cmd} ${stepCall.args.slice(0, 3).join(" ")} still names an id that doesn't exist yet.`);
  return out(ctx, stepCall.cmd, stepCall.args, input === undefined ? undefined : { input });
}

async function execStep(ctx, step) {
  if (step.gatewaySecret) {
    // The new password goes from az's stdout into Key Vault's stdin and nowhere else. If Key Vault refuses it,
    // the credential just added is deleted again, so reruns don't pile up credentials nobody holds (review m1).
    const appId = step.calls[0].args[step.calls[0].args.indexOf("--id") + 1];
    const keyIds = async () => lines(await out(ctx, "az", ["ad", "app", "credential", "list", "--id", appId, "--query", "[].keyId", "-o", "tsv"]));
    const before = new Set(await keyIds());
    const password = secretFromAz(await execCall(ctx, step.calls[0]), "The gateway's new client secret");
    // The Key Vault secret is tagged with the new credential's keyId, so the daily check judges the credential the
    // gateway uses, not the newest one on the app (Task 7 review I3). Graph may take a moment to list it.
    let added = (await keyIds()).filter((id) => !before.has(id));
    for (let attempt = 0; added.length !== 1 && attempt < GRAPH_LAG_TRIES; attempt += 1) {
      await ctx.sleep(GRAPH_LAG_MS);
      added = (await keyIds()).filter((id) => !before.has(id));
    }
    const setCall = { ...step.calls[1], args: [...step.calls[1].args] };
    if (added.length === 1) setCall.args.splice(setCall.args.indexOf("--query"), 0, "--tags", `${KEY_ID_TAG}=${added[0]}`);
    else ctx.log(`    could not tell which credential reset added (${added.length} new); ${entraSecretName(ctx.env)} is written untagged, and the daily check will alert until it is tagged.`);
    try {
      await propagated(ctx, () => execCall(ctx, setCall, password), "Writing to Key Vault");
    } catch (error) {
      for (const keyId of (await keyIds()).filter((id) => !before.has(id))) {
        await out(ctx, "az", ["ad", "app", "credential", "delete", "--id", appId, "--key-id", keyId]);
        ctx.log(`    removed the unsaved credential ${keyId} from ${GATEWAY_APP_NAME}`);
      }
      throw error;
    }
    ctx.log(`    wrote ${entraSecretName(ctx.env)} to Key Vault (fingerprint ${fingerprint(password)}${added.length === 1 ? `, credential ${added[0]}` : ""})`);
    return;
  }
  if (step.appleProvider) {
    const { slot, tags } = await liveAppleSlot(ctx);
    const certificateData = trimOneNewline(await out(ctx, "az", ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", appleKeySecretName(slot, ctx.env), "--query", "value", "-o", "tsv", ...SUB]));
    const apple = ctx.record.apple;
    // The key and the record's Key ID must be the pair the import tagged (Task 7 review C1).
    const problem = appleKeyProblem({ tags, recordedKeyId: apple.keyIds?.[slot], value: certificateData });
    if (problem) throw new Error(`Apple key slot ${slot} for ${ctx.env} can't be sent: ${problem}. Nothing was sent; re-import the slot with --apple-key-file.`);
    const body = { "@odata.type": APPLE_TYPE, displayName: "Sign in with Apple", developerId: apple.developerId, serviceId: apple.serviceId, keyId: apple.keyIds?.[slot], certificateData };
    await execCall(ctx, step.calls[1], JSON.stringify(body));
    ctx.log(`    created the Apple provider with key slot ${slot}`);
    const renewedAt = new Date(ctx.now()).toISOString();
    await out(ctx, "az", appleActiveSetArgs(ctx.env, renewedAt), { input: slot });
    ctx.log(`    recorded slot ${slot} as live in ${appleActiveSecretName(ctx.env)}, ${APPLE_RENEWED_TAG} ${renewedAt}`);
    return;
  }
  let last = "";
  for (const stepCall of step.calls) last = await execCall(ctx, stepCall);
  if (step.creates?.app) ctx.created.apps[step.creates.app] = JSON.parse(last || "{}");
  if (step.creates?.servicePrincipal) ctx.created.servicePrincipals.add(step.creates.servicePrincipal);
  if (step.creates?.flow) ctx.created.flow = true;
}

// The key slot to send: a, unless it is tagged revoked.
async function liveAppleSlot(ctx) {
  for (const slot of ["a", "b"]) {
    const tags = (await maybe(() => azJson(ctx, ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", appleKeySecretName(slot, ctx.env), "--query", "tags", "-o", "json", ...SUB]))) ?? null;
    if (tags && !isRevoked(tags)) return { slot, tags };
  }
  throw new Error(`Neither Apple key slot for ${ctx.env} is imported and unrevoked; import one with --apple-key-file.`);
}

function updateRecord(record, state) {
  const next = structuredClone(record);
  if (state.tenant?.id) next.tenant = { name: state.tenant.name, subdomain: state.tenant.subdomain ?? state.tenant.name, id: state.tenant.id, domain: state.tenant.domain };
  else if (state.tenant?.name) next.tenant = { ...(next.tenant ?? {}), name: state.tenant.name };
  if (state.storage) next.storage = { account: state.storage.account, id: state.storage.id, endpoint: state.storage.endpoint };
  for (const key of ["gatewayIdentity", "checksIdentity"]) {
    if (state[key]) next[key] = { name: state[key].name, id: state[key].id, clientId: state[key].clientId, principalId: state[key].principalId, tenantId: state[key].tenantId };
  }
  if (state.vaultId) next.keyVault = { name: VAULT, id: state.vaultId, entraClientSecret: entraSecretName(record.env) };
  for (const key of ["gatewayApp", "automationApp"]) {
    if (state[key]) next[key] = { appId: state[key].appId, objectId: state[key].id, servicePrincipalId: state[key].servicePrincipalId };
  }
  if (state.apple) next.apple = { ...(next.apple ?? {}), providerId: state.apple.id };
  if (state.userFlow) next.userFlow = { id: state.userFlow.id, displayName: USER_FLOW_NAME };
  return next;
}

async function vaultId(ctx) {
  return (await out(ctx, "az", ["keyvault", "show", "-n", VAULT, "--query", "id", "-o", "tsv", ...SUB])).trim();
}

async function reconcile(ctx) {
  ctx.vaultId = await vaultId(ctx);
  ctx.vaultReadable = await ensureOperatorRole(ctx, "Key Vault Secrets Officer", ctx.vaultId);
  if (!ctx.vaultReadable) ctx.log("The operator can't read Key Vault until that role exists, so this dry run plans every vault secret as missing.");
  let previous = null;
  for (let pass = 0; pass < 30; pass += 1) {
    const state = await readState(ctx);
    if (!ctx.dryRun) {
      ctx.record = updateRecord(ctx.record, state);
      saveRecord(ctx.record, ctx.recordDir);
    }
    const steps = plan({ env: ctx.env, state, record: ctx.record });
    if (steps.length === 0) {
      ctx.log(`${ctx.env}: everything is in place.`);
      return;
    }
    if (ctx.dryRun) {
      for (const step of steps) {
        ctx.log(`==> ${step.name}`);
        for (const stepCall of step.calls) ctx.log(`    would run: ${describe(stepCall)}`);
        if (step.stop) {
          ctx.log(step.stop);
          break;
        }
      }
      ctx.log("Dry run: nothing was changed.");
      return;
    }
    const names = steps.map(({ name }) => name).join("|");
    if (names === previous) throw new Error(`These steps didn't take effect: ${steps.map(({ name }) => name).join(", ")}.`);
    previous = names;
    for (const step of steps) {
      ctx.log(`==> ${step.name}`);
      await execStep(ctx, step);
      if (step.stop) {
        ctx.log(step.stop);
        throw new Stop(step.stop.split("\n")[0]);
      }
      if (step.reread) break;
    }
  }
  throw new Error("The reconcile did not settle after 30 passes.");
}

// --- Apple key import --------------------------------------------------------------------------------------------

// Apple names each downloaded key AuthKey_<Key ID>.p8; the .p8 itself holds no Key ID.
const KEY_ID = /^[A-Z0-9]{10}$/;
function appleKeyIdFor(ctx, { file, slot, keyId: given }) {
  const fromName = /^AuthKey_([A-Z0-9]{10})\.p8$/.exec(basename(file))?.[1];
  if (given !== undefined && !KEY_ID.test(given)) throw new Error(`--apple-key-id ${given} is not an Apple Key ID (10 capital letters or digits).`);
  if (given && fromName && given !== fromName) throw new Error(`${basename(file)} names Key ID ${fromName}, but --apple-key-id says ${given}; nothing was imported.`);
  const keyId = given ?? fromName;
  if (!keyId) throw new Error(`${basename(file)} isn't named AuthKey_<Key ID>.p8; pass the key's Key ID with --apple-key-id.`);
  const other = slot === "a" ? "b" : "a";
  if (ctx.record.apple?.keyIds?.[other] === keyId) throw new Error(`Key ID ${keyId} is already recorded for slot ${other} in identity-${ctx.env}.json; one key can't fill both slots. Nothing was imported.`);
  return keyId;
}

async function importAppleKey(ctx, { file, slot, keepFile, keyId: givenKeyId }) {
  const name = appleKeySecretName(slot, ctx.env);
  const keyId = appleKeyIdFor(ctx, { file, slot, keyId: givenKeyId });
  const key = readFileSync(file, "utf8");
  if (!key.includes("PRIVATE KEY")) throw new Error(`${file} is not a .p8 private key.`);
  // The Key ID and fingerprint bind this key to its slot's recorded Key ID; the renewal checks both (review C1).
  const setArgs = ["keyvault", "secret", "set", "--vault-name", VAULT, "--name", name, "--file", "/dev/stdin", "--encoding", "utf-8", "--tags", `imported-at=${new Date(ctx.now()).toISOString()}`, `${KEY_ID_TAG}=${keyId}`, `${FINGERPRINT_TAG}=${fingerprint(key)}`, "--query", "id", "-o", "tsv", ...SUB];
  if (ctx.dryRun) {
    await ensureOperatorRole(ctx, "Key Vault Secrets Officer", await vaultId(ctx));
    ctx.log(`    would run: az ${setArgs.join(" ")} (stdin: ***)`);
    ctx.log(`    would delete ${file} once Key Vault returns the same key${keepFile ? " (no: --keep-file)" : ""}`);
    return;
  }
  await ensureOperatorRole(ctx, "Key Vault Secrets Officer", await vaultId(ctx));
  // A new version carries only the tags given here, so a `revoked` tag on the slot's old key is cleared.
  await propagated(ctx, () => out(ctx, "az", setArgs, { input: key }), "Writing to Key Vault");
  const stored = trimOneNewline(await out(ctx, "az", ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", name, "--query", "value", "-o", "tsv", ...SUB]));
  if (fingerprint(stored) !== fingerprint(key)) throw new Error(`${name} as read back does not match ${file}; the file was kept.`);
  const tags = (await azJson(ctx, ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", name, "--query", "tags", "-o", "json", ...SUB])) ?? {};
  if (isRevoked(tags)) throw new Error(`${name} still carries a revoked tag after the import; the file was kept.`);
  if (tags[KEY_ID_TAG] !== keyId || tags[FINGERPRINT_TAG] !== fingerprint(key)) throw new Error(`${name} as read back lacks its Key ID or fingerprint tag; the file was kept.`);
  ctx.log(`Imported ${name} (Key ID ${keyId}, fingerprint ${fingerprint(key)}); revoked tag clear.`);
  const recorded = ctx.record.apple?.keyIds?.[slot] ?? null;
  if (recorded !== keyId) {
    ctx.record = { ...ctx.record, apple: { ...(ctx.record.apple ?? {}), keyIds: { ...(ctx.record.apple?.keyIds ?? {}), [slot]: keyId } } };
    saveRecord(ctx.record, ctx.recordDir);
    ctx.log(`Changed identity-${ctx.env}.json apple.keyIds.${slot} from ${recorded ?? "null"} to ${keyId}; commit it to main, or the renewal refuses this slot.`);
  }
  if (keepFile) {
    ctx.log(`Kept ${file} (--keep-file).`);
  } else {
    unlinkSync(file);
    ctx.log(`Deleted ${file}.`);
  }
}

// --- Seeding and invites -----------------------------------------------------------------------------------------

// The accounts store, as the signed-in operator, who first gets Storage Table Data Contributor on this env's
// accounts storage account (review I3).
async function storeFor(ctx) {
  const endpoint = ctx.record.storage?.endpoint;
  const id = ctx.record.storage?.id;
  if (!endpoint || !id) throw new Error(`identity-${ctx.env}.json has no accounts store yet; run provision-identity.mjs --env ${ctx.env} first.`);
  await ensureOperatorRole(ctx, "Storage Table Data Contributor", id);
  return ctx.openStore({ endpoint, record: ctx.record });
}

async function seedAri(ctx) {
  if (ctx.dryRun) {
    ctx.log(`Would seed Ari's account (binding ${ctx.settings.repo}) in ${ctx.record.storage?.endpoint ?? `${ctx.settings.storage} once created`}.`);
    return;
  }
  const store = await storeFor(ctx);
  const known = ctx.record.ari?.accountId;
  // An existing account is never seeded again: seed() writes deskAccess true and the binding, which would undo a
  // deliberate "access off" or binding change.
  if (known && (await propagated(ctx, () => store.getAccount(known), "Reading the accounts store"))) {
    ctx.log(`Ari's account ${known} exists; left as it is.`);
  } else {
    const binding = { kind: "github", repo: ctx.settings.repo, author: { name: ARI.displayName, email: ARI.authorEmail } };
    const { accountId } = await propagated(ctx, () => seed({ store, displayName: ARI.displayName, binding, ...(known ? { accountId: known } : {}) }), "Writing to the accounts store");
    ctx.record = { ...ctx.record, ari: { accountId, githubUserId: ARI.githubUserId, githubLogin: ARI.githubLogin } };
    saveRecord(ctx.record, ctx.recordDir);
    ctx.log(`Seeded Ari's account ${accountId}, bound to ${ctx.settings.repo}; recorded in identity-${ctx.env}.json.`);
  }
}

async function inviteAri(ctx) {
  const accountId = ctx.record.ari?.accountId;
  if (!accountId) throw new Error(`identity-${ctx.env}.json records no accountId for Ari; run --seed-ari first.`);
  const ttlMs = ctx.settings.inviteTtlMs;
  if (ctx.dryRun) {
    ctx.log(`Would issue an invite to ${accountId} for ${ttlMs / 3600_000} hours.`);
    return;
  }
  const store = await storeFor(ctx);
  const { token } = await propagated(ctx, () => issueInvite({ store, accountId, ttlMs, now: ctx.now() }), "Writing to the accounts store");
  const link = `${ctx.settings.publicUrl}/invite/${token}`;
  if (ctx.env !== "prod") {
    ctx.log(`Invite link for ${accountId} (test tenant, ${ttlMs / 3600_000} hours): ${link}`);
    return;
  }
  // Production's link is a bearer credential: a 0600 file, opened in the browser, never printed.
  const dir = join(ctx.home, ".ouro");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `invite-${ctx.env}.url`);
  writeFileSync(file, `${link}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  ctx.log(`Issued an invite to ${accountId} for ${ttlMs / 3600_000} hours; the link is in ${file} (mode 0600) and is not printed.`);
  if (ctx.browserContext && ctx.openerCommand) {
    await out(ctx, ctx.openerCommand.cmd, [...ctx.openerCommand.args, "--url-file", file, "--context", ctx.browserContext]);
    ctx.log(`Opened it in browser context ${ctx.browserContext}.`);
  } else {
    ctx.log("Open it with the CDP opener in the browser context that will start the claude.ai connection (set DESK_CDP_OPENER and pass --browser-context <name>).");
  }
}

// --- Container App secrets ---------------------------------------------------------------------------------------

const appArgs = (app) => ["-n", app, "-g", APPS_RESOURCE_GROUP];
const showApp = async (ctx, app) => azJson(ctx, ["containerapp", "show", ...appArgs(app), "-o", "json", ...SUB]);
const readAppSecret = async (ctx, app, name) => out(ctx, "az", ["containerapp", "secret", "show", ...appArgs(app), "--secret-name", name, "--query", "value", "-o", "tsv", ...SUB]);
const latestRevision = async (ctx, app) => (await out(ctx, "az", ["containerapp", "show", ...appArgs(app), "--query", "properties.latestReadyRevisionName", "-o", "tsv", ...SUB])).trim();
const gatewayEnv = (shown) => (shown.properties.template.containers.find(({ name }) => name === "gateway") ?? shown.properties.template.containers[0]).env ?? [];

// Writes the whole app with `changes` (app-yaml.mjs) and deletes the document afterwards.
async function updateApp(ctx, app, shown, changes, summary) {
  // Staging never holds production's pull identity (re-review N-I1).
  const forbidIdentities = app === STAGING_APP ? [PROD_PULL_IDENTITY] : [];
  const text = buildAppYaml({ shownYaml: shown, ...changes, forbidIdentities });
  if (ctx.dryRun) {
    ctx.log(`    would run: az containerapp update ${appArgs(app).join(" ")} --yaml <whole app, ${summary}, secret values ***>`);
    return false;
  }
  const { file, dir } = writeAppYaml(text);
  try {
    await out(ctx, "az", ["containerapp", "update", ...appArgs(app), "--yaml", file, "--output", "none", ...SUB]);
  } catch (error) {
    // Nothing in updateApp writes to the app before this update.
    if (isKeyVaultFillFailure(error.stderr)) throw new Error(keyVaultFillFailure());
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // az rewrites the document before sending it (it fills value-less secrets, Key Vault references included, and
  // drops the identity map), so every write is checked against the app as it now is (review C1 and I1).
  const after = await showApp(ctx, app);
  const secretList = (await azJson(ctx, ["containerapp", "secret", "list", ...appArgs(app), "-o", "json", ...SUB])) ?? [];
  checkWritten({ before: shown, after, secretList, keyVaultSecrets: changes.keyVaultSecrets ?? {}, forbidIdentities });
  ctx.log(`Checked ${app}: every secret, Key Vault reference and identity is still there.`);
  return true;
}

async function restartLatest(ctx, app) {
  const revision = await latestRevision(ctx, app);
  if (!revision) throw new Error(`${app} has no ready revision to restart; it reads the secrets when its next revision starts.`);
  await out(ctx, "az", ["containerapp", "revision", "restart", ...appArgs(app), "--revision", revision, "--output", "none", ...SUB]);
  ctx.log(`Restarted ${app} revision ${revision} so it reads the secrets.`);
}

function requireTest(ctx, flag) {
  if (ctx.env !== "test") throw new Error(`${flag} runs only with --env test: it changes the staging app.`);
}

async function copyAppSecrets(ctx) {
  requireTest(ctx, "--copy-app-secrets");
  const values = {};
  for (const name of APP_SECRETS) {
    const value = trimOneNewline(await readAppSecret(ctx, PROD_APP, name));
    if (!value || value === "unset") throw new Error(`${PROD_APP}'s ${name} is not set; nothing was copied.`);
    values[name] = value;
  }
  const shown = await showApp(ctx, STAGING_APP);
  if (await updateApp(ctx, STAGING_APP, shown, { setSecrets: values }, "the GitHub App's four secrets from production")) await restartLatest(ctx, STAGING_APP);
  for (const name of APP_SECRETS) ctx.log(`${ctx.dryRun ? "Would copy" : "Copied"} ${name} to ${STAGING_APP} (fingerprint ${fingerprint(values[name])}).`);
}

async function clearAppSecrets(ctx) {
  requireTest(ctx, "--clear-app-secrets");
  const shown = await showApp(ctx, STAGING_APP);
  if (await updateApp(ctx, STAGING_APP, shown, { setSecrets: Object.fromEntries(APP_SECRETS.map((name) => [name, "unset"])) }, "the four desk-app secrets as unset")) {
    await restartLatest(ctx, STAGING_APP);
    ctx.log(`Wrote unset over ${APP_SECRETS.join(", ")} on ${STAGING_APP}.`);
  }
}

// --- Signing keys (Task 3's checks in signing-keys.mjs, wired to the runner) --------------------------------------

async function keysLine(ctx, app, revision) {
  const text = await out(ctx, "az", ["containerapp", "logs", "show", ...appArgs(app), "--revision", revision, "--type", "console", "--tail", "500", "--format", "text", ...SUB]);
  return newestKeysLine(text, { revision });
}

async function probe(ctx, when) {
  const name = ctx.settings.probe;
  await out(ctx, ctx.probeCommand.cmd, [...ctx.probeCommand.args, "status", "--name", name]);
  ctx.log(`Probe ${name} passed ${when}.`);
}

// After an update that changed the template: the new revision's name, once it is ready.
async function newRevision(ctx, app, before) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const revision = await latestRevision(ctx, app);
    if (revision && revision !== before) return revision;
    await ctx.sleep(POLL_MS);
  }
  throw new Error(`${app} has no new ready revision after ${(40 * POLL_MS) / 60_000} minutes.`);
}

async function newKeysLine(ctx, app, revision) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const line = await keysLine(ctx, app, revision);
    if (line) return line;
    await ctx.sleep(POLL_MS);
  }
  return null;
}

async function migrateClientKey(ctx) {
  const app = ctx.settings.app;
  const shown = await showApp(ctx, app);
  const env = gatewayEnv(shown);
  const held = new Set(shown.properties.configuration.secrets.map(({ name }) => name));
  const signingKey = secretFromAz(await readAppSecret(ctx, app, "desk-signing-key"), "desk-signing-key");
  if (env.some(({ name, secretRef }) => name === "DESK_CLIENT_KEY" && secretRef === CLIENT_KEY_MIGRATION.secret) && held.has(CLIENT_KEY_MIGRATION.secret)) {
    const clientKey = secretFromAz(await readAppSecret(ctx, app, CLIENT_KEY_MIGRATION.secret), CLIENT_KEY_MIGRATION.secret);
    checkReadBack({ clientKey, signingKey });
    ctx.log(`${app} is already migrated: DESK_CLIENT_KEY reads desk-client-key, fingerprint ${fingerprint(clientKey)}, equal to desk-signing-key's.`);
    return;
  }
  const revision = await latestRevision(ctx, app);
  const logged = await keysLine(ctx, app, revision);
  const source = checkCopySource({ signingKey, logged });
  ctx.log(`desk-signing-key fingerprint ${fingerprint(signingKey)}; ${source.probe ? `revision ${revision} logs no keys line (an image before v1b-1), so the probe stands in` : `matches revision ${revision}'s logged signing key`}.`);
  if (ctx.dryRun) {
    await updateApp(ctx, app, shown, { setSecrets: { [CLIENT_KEY_MIGRATION.secret]: signingKey }, secretRefs: CLIENT_KEY_MIGRATION.env }, "desk-client-key = desk-signing-key, DESK_CLIENT_KEY -> desk-client-key");
    return;
  }
  if (source.probe) await probe(ctx, "before the copy");
  await updateApp(ctx, app, shown, { setSecrets: { [CLIENT_KEY_MIGRATION.secret]: signingKey }, secretRefs: CLIENT_KEY_MIGRATION.env }, "client key");
  const clientKey = secretFromAz(await readAppSecret(ctx, app, CLIENT_KEY_MIGRATION.secret), CLIENT_KEY_MIGRATION.secret);
  checkReadBack({ clientKey, signingKey: secretFromAz(await readAppSecret(ctx, app, "desk-signing-key"), "desk-signing-key") });
  ctx.log(`desk-client-key reads back with fingerprint ${fingerprint(clientKey)}, equal to desk-signing-key's.`);
  const restarted = await newRevision(ctx, app, revision);
  const after = source.probe ? await keysLine(ctx, app, restarted) : await newKeysLine(ctx, app, restarted);
  const result = checkClientKeyLine({ signingKey, logged: after });
  if (result.probe) {
    await probe(ctx, "after the copy");
    ctx.log(`Revision ${restarted} logs no keys line, so the client key is unconfirmed until an image that logs it starts; the probe confirms the signing key only.`);
  } else {
    ctx.log(`Revision ${restarted} logs client ${after.client} client-from DESK_CLIENT_KEY: confirmed.`);
  }
}

// After a write or restart: polls the app's latest ready revision until its newest keys line passes `accepts`, and
// returns that line, or the last line seen (null if none) when it never does. The revision is read again each time,
// because an update may start a new revision after the poll begins.
async function awaitKeysLine(ctx, app, accepts, tries = 20) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const revision = await latestRevision(ctx, app);
    last = revision ? await keysLine(ctx, app, revision) : null;
    if (last && accepts(last)) return { line: last, confirmed: true };
    await ctx.sleep(POLL_MS);
  }
  return { line: last, confirmed: false };
}

// For a signing key that may have leaked (Task 3 review M5): nothing sealed with the old keys stays valid.
async function emergencyRotate(ctx) {
  const app = ctx.settings.app;
  const shown = await showApp(ctx, app);
  const changes = emergencyChanges({ appEnv: gatewayEnv(shown), heldSecrets: shown.properties.configuration.secrets.map(({ name }) => name) });
  ctx.log(`Emergency rotation on ${app}: new signing key ${fingerprint(changes.setSecrets["desk-signing-key"])}, new client key ${fingerprint(changes.setSecrets["desk-client-key"])}, no previous key. Every token and registered client stops working, so every client must register and sign in again.`);
  if (!(await updateApp(ctx, app, shown, changes, "new desk-signing-key and desk-client-key, no previous key"))) return;
  await restartLatest(ctx, app);
  const expected = (line) => {
    try {
      checkEmergencyLine({ changes, after: line });
      return true;
    } catch {
      return false;
    }
  };
  const { line } = await awaitKeysLine(ctx, app, expected);
  checkEmergencyLine({ changes, after: line });
  ctx.log(`${app} logs signing ${line.signing}, client ${line.client} from DESK_CLIENT_KEY and no previous key: the emergency rotation is confirmed.`);
}

// Rotates the gateway's Entra client secret without a sign-in outage and without ever writing an empty value (Task 8
// review findings 1 and 2). The old credential is deleted only when the gateway's own startup line shows the new
// secret's fingerprint; until then it stays, and a rerun picks the rotation up where it stopped.
async function rotateEntraSecret(ctx) {
  const { env, record } = ctx;
  const app = ctx.settings.app;
  const appId = record.gatewayApp?.appId;
  if (!appId || !record.tenant?.id) throw new Error(`identity-${env}.json records no gateway app or tenant; run provision-identity.mjs --env ${env} first.`);
  const signedIn = (await out(ctx, "az", ["account", "show", "--query", "tenantId", "-o", "tsv"])).trim();
  if (signedIn !== record.tenant.id) {
    throw new Error(`az's current account is in tenant ${signedIn || "(none)"}, not ${record.tenant.name} (${record.tenant.id}). Run: az login --tenant ${record.tenant.id} --allow-no-subscriptions, then az account set --subscription ${record.tenant.id}, and run this again.`);
  }
  const name = entraSecretName(env);
  await ensureOperatorRole(ctx, "Key Vault Secrets Officer", await vaultId(ctx));
  const tags = (await propagated(ctx, () => azJson(ctx, ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", name, "--query", "tags", "-o", "json", ...SUB]), "Reading Key Vault")) ?? {};
  const keyIds = async () => lines(await out(ctx, "az", ["ad", "app", "credential", "list", "--id", appId, "--query", "[].keyId", "-o", "tsv"]));
  const credentials = await keyIds();
  const pending = tags[PREVIOUS_KEY_ID_TAG] && credentials.includes(tags[PREVIOUS_KEY_ID_TAG]) && tags[KEY_ID_TAG] && credentials.includes(tags[KEY_ID_TAG]);
  let old;
  let newFingerprint;
  if (pending) {
    old = tags[PREVIOUS_KEY_ID_TAG];
    newFingerprint = fingerprint(secretFromAz(await out(ctx, "az", ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", name, "--query", "value", "-o", "tsv", ...SUB]), name));
    ctx.log(`A rotation is under way: ${name} holds credential ${tags[KEY_ID_TAG]} (fingerprint ${newFingerprint}); the old credential ${old} is still on the app.`);
  } else {
    old = tags[KEY_ID_TAG] && credentials.includes(tags[KEY_ID_TAG]) ? tags[KEY_ID_TAG] : null;
    if (!old && credentials.length === 1) {
      [old] = credentials;
      ctx.log(`${name} names no credential on the app; the app has one, ${old}, so that is the one the gateway holds.`);
    }
    if (!old) throw new Error(`Can't tell which of the gateway app's ${credentials.length} credentials ${name} holds: its key-id tag is missing or names none of them. Find the credential (az ad app credential list --id ${appId}) and tag the secret with key-id=<keyId>; nothing was changed.`);
    if (ctx.dryRun) {
      ctx.log(`    would run: az ad app credential reset --id ${appId} --append --display-name desk-gateway-${env} --years 1 --query password -o tsv`);
      ctx.log(`    would run: az keyvault secret set --vault-name ${VAULT} --name ${name} --file /dev/stdin --tags ${KEY_ID_TAG}=<new> ${PREVIOUS_KEY_ID_TAG}=${old} (stdin: ***)`);
      ctx.log(`    would restart ${app} and delete credential ${old} once the gateway logs the new fingerprint`);
      return;
    }
    const before = new Set(credentials);
    const removeAdded = async () => {
      for (const keyId of (await keyIds()).filter((id) => !before.has(id))) {
        await out(ctx, "az", ["ad", "app", "credential", "delete", "--id", appId, "--key-id", keyId]);
        ctx.log(`    removed the unsaved credential ${keyId} from ${GATEWAY_APP_NAME}`);
      }
    };
    let password;
    let added;
    try {
      // secretFromAz refuses an empty or whitespace value, so a failed or odd reset never reaches Key Vault.
      password = secretFromAz(await out(ctx, "az", ["ad", "app", "credential", "reset", "--id", appId, "--append", "--display-name", `desk-gateway-${env}`, "--years", "1", "--query", "password", "-o", "tsv"]), "The gateway's new client secret");
      added = (await keyIds()).filter((id) => !before.has(id));
      for (let attempt = 0; added.length !== 1 && attempt < GRAPH_LAG_TRIES; attempt += 1) {
        await ctx.sleep(GRAPH_LAG_MS);
        added = (await keyIds()).filter((id) => !before.has(id));
      }
      if (added.length !== 1) throw new Error(`Could not tell which credential the reset added (${added.length} new); nothing was written to Key Vault.`);
      await propagated(ctx, () => out(ctx, "az", ["keyvault", "secret", "set", "--vault-name", VAULT, "--name", name, "--file", "/dev/stdin", "--encoding", "utf-8", "--tags", `${KEY_ID_TAG}=${added[0]}`, `${PREVIOUS_KEY_ID_TAG}=${old}`, "--query", "id", "-o", "tsv", ...SUB], { input: password }), "Writing to Key Vault");
    } catch (error) {
      await removeAdded();
      throw error;
    }
    const stored = secretFromAz(await out(ctx, "az", ["keyvault", "secret", "show", "--vault-name", VAULT, "--name", name, "--query", "value", "-o", "tsv", ...SUB]), name);
    newFingerprint = fingerprint(password);
    if (fingerprint(stored) !== newFingerprint) throw new Error(`${name} reads back as ${fingerprint(stored)}, not the new secret's ${newFingerprint}; the old credential ${old} is kept.`);
    ctx.log(`Wrote ${name} (credential ${added[0]}, fingerprint ${newFingerprint}); the old credential ${old} stays until the gateway shows the new secret.`);
  }
  await restartLatest(ctx, app);
  const { line, confirmed } = await awaitKeysLine(ctx, app, (candidate) => candidate.entra === newFingerprint);
  if (!confirmed) {
    const seen = !line ? "logs no keys line" : line.entra ? `still logs entra ${line.entra}` : "logs no entra fingerprint (an image before this check)";
    throw new Stop(`${app} ${seen}, not the new secret's ${newFingerprint}, so the old credential ${old} is kept and sign-in keeps working. Run --rotate entra-secret again later (the platform reads a new Key Vault version within about 30 minutes); it deletes ${old} once the gateway shows the new secret.`);
  }
  ctx.log(`${app} revision ${line.revision} logs entra ${newFingerprint}: the gateway holds the new secret.`);
  await out(ctx, "az", ["ad", "app", "credential", "delete", "--id", appId, "--key-id", old]);
  ctx.log(`Deleted the old credential ${old} from ${GATEWAY_APP_NAME}.`);
}

async function rotate(ctx) {
  const app = ctx.settings.app;
  if (ctx.env !== "test") refuseRotation({ env: ctx.env, appEnv: [], now: ctx.now() });
  const shown = await showApp(ctx, app);
  refuseRotation({ env: ctx.env, appEnv: gatewayEnv(shown), now: ctx.now() });
  const signingKey = secretFromAz(await readAppSecret(ctx, app, "desk-signing-key"), "desk-signing-key");
  const revision = await latestRevision(ctx, app);
  const before = await keysLine(ctx, app, revision);
  const changes = rotationChanges({ signingKey, logged: before, now: ctx.now() });
  const newKey = changes.setSecrets["desk-signing-key"];
  ctx.log(`Rotating: signing ${fingerprint(signingKey)} -> ${fingerprint(newKey)}; previous ${fingerprint(signingKey)} until ${changes.setEnv.DESK_SIGNING_KEY_PREVIOUS_UNTIL}; client ${before.client} unchanged.`);
  if (!(await updateApp(ctx, app, shown, changes, "new desk-signing-key, desk-signing-key-previous, DESK_SIGNING_KEY_PREVIOUS_UNTIL"))) return;
  const restarted = await newRevision(ctx, app, revision);
  const after = await newKeysLine(ctx, app, restarted);
  checkRotatedLine({ before, after });
  ctx.log(`Revision ${restarted} logs signing ${after.signing}, previous ${after.previous} until ${after.until}, client ${after.client} from DESK_CLIENT_KEY: rotation confirmed.`);
}

// --- Entry -------------------------------------------------------------------------------------------------------

export function parseFlags(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      env: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "apple-key-file": { type: "string" },
      "apple-key-slot": { type: "string" },
      "apple-key-id": { type: "string" },
      "keep-file": { type: "boolean", default: false },
      "seed-ari": { type: "boolean", default: false },
      "invite-ari": { type: "boolean", default: false },
      "copy-app-secrets": { type: "boolean", default: false },
      "clear-app-secrets": { type: "boolean", default: false },
      migrate: { type: "string" },
      rotate: { type: "string" },
      emergency: { type: "boolean", default: false },
      "browser-context": { type: "string" },
    },
  });
  environment(values.env);
  const actions = ["apple-key-file", "seed-ari", "invite-ari", "copy-app-secrets", "clear-app-secrets", "migrate", "rotate"].filter((name) => values[name] !== undefined && values[name] !== false);
  if (actions.length > 1) throw new Error(`Run one action at a time; got ${actions.map((name) => `--${name}`).join(", ")}.`);
  if (values.migrate !== undefined && values.migrate !== "client-key") throw new Error("Only --migrate client-key exists.");
  if (values.rotate !== undefined && values.rotate !== "signing-key" && values.rotate !== "entra-secret") throw new Error("Only --rotate signing-key and --rotate entra-secret exist.");
  if (values.emergency && values.rotate !== "signing-key") throw new Error("--emergency goes only with --rotate signing-key.");
  if (values["apple-key-file"] && !["a", "b"].includes(values["apple-key-slot"])) throw new Error("--apple-key-file needs --apple-key-slot a or b.");
  return {
    env: values.env,
    flags: {
      dryRun: values["dry-run"],
      appleKeyFile: values["apple-key-file"],
      appleKeySlot: values["apple-key-slot"],
      keepFile: values["keep-file"],
      seedAri: values["seed-ari"],
      inviteAri: values["invite-ari"],
      copyAppSecrets: values["copy-app-secrets"],
      clearAppSecrets: values["clear-app-secrets"],
      migrate: values.migrate,
      rotate: values.rotate,
      browserContext: values["browser-context"],
      appleKeyId: values["apple-key-id"],
      emergency: values.emergency,
    },
  };
}

async function defaultOpenStore({ endpoint, record }) {
  const [{ createTableStore }, { AzureCliCredential }] = await Promise.all([import("../src/accounts/store.js"), import("@azure/identity")]);
  // The operator's own az sign-in to the Azure tenant that holds the storage account.
  return createTableStore({ endpoint, credential: new AzureCliCredential(record.gatewayIdentity?.tenantId ? { tenantId: record.gatewayIdentity.tenantId } : {}) });
}

export async function run({
  env,
  flags = {},
  runner = defaultRunner,
  log = (line) => console.log(line),
  home = homedir(),
  now = Date.now,
  recordDir = HERE,
  openStore = defaultOpenStore,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  probeCommand = { cmd: process.execPath, args: [join(HERE, "mcp-probe.mjs")] },
  openerCommand = process.env.DESK_CDP_OPENER ? { cmd: process.execPath, args: [process.env.DESK_CDP_OPENER] } : null,
}) {
  const settings = environment(env);
  const ctx = { env, settings, record: loadRecord(env, recordDir), created: { apps: {}, servicePrincipals: new Set(), flow: false }, runner, log, home, now, recordDir, openStore, sleep, probeCommand, openerCommand, dryRun: Boolean(flags.dryRun), browserContext: flags.browserContext };
  if (ctx.dryRun) log(`Dry run for ${env}: reads only; every write is printed instead, secret input as ***.`);
  if (flags.appleKeyFile) return importAppleKey(ctx, { file: flags.appleKeyFile, slot: flags.appleKeySlot, keepFile: flags.keepFile, keyId: flags.appleKeyId });
  if (flags.inviteAri) return inviteAri(ctx);
  if (flags.copyAppSecrets) return copyAppSecrets(ctx);
  if (flags.clearAppSecrets) return clearAppSecrets(ctx);
  if (flags.migrate === "client-key") return migrateClientKey(ctx);
  if (flags.rotate === "signing-key") return flags.emergency ? emergencyRotate(ctx) : rotate(ctx);
  if (flags.rotate === "entra-secret") return rotateEntraSecret(ctx);
  try {
    await reconcile(ctx);
  } catch (error) {
    // Seeding needs only the accounts store, so a stop on a later step (Apple under outcome B) doesn't block it.
    if (flags.seedAri && error instanceof Stop && ctx.record.storage?.id) await seedAri(ctx);
    throw error;
  }
  if (flags.seedAri) await seedAri(ctx);
}

export { defaultRunner };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { env, flags } = parseFlags(process.argv.slice(2));
    await run({ env, flags });
  } catch (error) {
    process.stderr.write(`provision-identity: ${error.message}\n`);
    process.exit(error instanceof Stop ? 2 : 1);
  }
}
