// The admin API of an Ouro tenant, reconciled through the ouro-identity-admin app's app-only Graph token
// (admin-graph.mjs), so a run needs only the keychain, not az signed in to the tenant:
//
// - the gateway app (ouro-desk-hosted) exposes the delegated scope `desk.admin` at api://<appId> and defines the app
//   role `ouro.admin` for users, with v2 access tokens (src/admin.js requires `scp` and the role);
// - the ouro CLI's public client (ouro-cli) requests that scope on the loopback redirect and is preauthorized for it,
//   so signing in shows no consent page, and the tenant's user flow signs its users in. An external tenant's users
//   can't consent to anything themselves, so the CLI asks for `desk.admin` alone, never openid or offline_access;
//   it is not a fallback public client, so device-code and password flows stay off for an admin token;
// - exactly the record's `adminApi.admins` (user object ids) hold `ouro.admin`.
//
// The scope is a "User" scope on purpose: it lets a client ask for a token to the admin routes, and the routes refuse
// every token without the `ouro.admin` role, which only this script assigns.
import { ADMIN_ROLE } from "../src/admin.js";

export const ADMIN_SCOPE = "desk.admin";
// Fixed ids, the same in every tenant, so a rerun recognizes what an earlier run made.
export const ADMIN_SCOPE_ID = "ac1e467b-e81b-418e-a588-b6edc8cdf4fe";
export const ADMIN_ROLE_ID = "e3a25780-801e-4a1f-90a7-74ee1f27651c";
export const CLI_APP_NAME = "ouro-cli";
// Entra ignores a loopback redirect's port for a public client (RFC 8252 section 7.3); the CLI picks a free one.
export const CLI_REDIRECT = "http://127.0.0.1/callback";

const GRAPH = "https://graph.microsoft.com/v1.0/";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSES = 20;
const LAG_MS = 5_000;
// What Graph answers while a new app, service principal or role isn't visible everywhere yet. A user flow refuses a
// new service principal's app id as invalid for about 30 seconds (provision-identity.mjs SP_LAG).
const LAG = /Request_ResourceNotFound|does not exist|was not found|does not reference a valid application|application id .*invalid|HTTP 404|\(404\)/i;
// A create Graph had already applied before a lagging read missed it.
const DONE = /already exists|ObjectConflict|conflicting object|HTTP 409|\(409\)/i;

const SCOPE = {
  id: ADMIN_SCOPE_ID,
  value: ADMIN_SCOPE,
  type: "User",
  isEnabled: true,
  adminConsentDisplayName: "Administer Hosted Desk",
  adminConsentDescription: "Lets the app call Hosted Desk's admin routes for the signed-in user, which still need the ouro.admin role.",
  userConsentDisplayName: "Administer Hosted Desk",
  userConsentDescription: "Lets the app manage Hosted Desk invites and accounts on your behalf, if you are an Ouro admin.",
};
const ROLE = {
  id: ADMIN_ROLE_ID,
  value: ADMIN_ROLE,
  allowedMemberTypes: ["User"],
  isEnabled: true,
  displayName: "Ouro admin",
  description: "Issues Hosted Desk invites, turns desk access on and off, and deletes accounts.",
};

const quote = (value) => encodeURIComponent(value.replace(/'/g, "''"));
const get = (graph, path) => graph.call("GET", `${GRAPH}${path}`);
// Every page of a Graph collection.
async function getAll(graph, path) {
  const values = [];
  for (let page = await get(graph, path); page; page = page["@odata.nextLink"] ? await graph.call("GET", page["@odata.nextLink"]) : null) values.push(...(page.value ?? []));
  return values;
}
const isNotFound = (error) => /Request_ResourceNotFound|HTTP 404|\(404\)/i.test(`${error?.message ?? ""}`);

function adminsOf(record) {
  const admins = record.adminApi?.admins;
  if (!Array.isArray(admins) || admins.length === 0 || !admins.every((id) => typeof id === "string" && GUID.test(id))) {
    throw new Error(`identity-${record.env}.json needs adminApi.admins: the object ids of the users who hold ${ADMIN_ROLE}, at least one.`);
  }
  return [...new Set(admins.map((id) => id.toLowerCase()))];
}

async function readState(graph, record) {
  const gatewayObject = record.gatewayApp?.objectId;
  const gatewaySp = record.gatewayApp?.servicePrincipalId;
  if (!gatewayObject || !gatewaySp || !record.userFlow?.id) throw new Error(`identity-${record.env}.json has no gateway app or user flow yet; run provision-identity.mjs --env ${record.env} first.`);
  const gateway = await get(graph, `applications/${gatewayObject}?$select=id,appId,identifierUris,api,appRoles`);
  const cliFields = "id,appId,displayName,signInAudience,isFallbackPublicClient,publicClient,requiredResourceAccess";
  let cli;
  const recorded = record.cliApp?.objectId;
  if (recorded) {
    // Once recorded, the client is read by its object id: a renamed one is still found, and another app given its
    // name is never adopted and preauthorized.
    try {
      cli = await get(graph, `applications/${recorded}?$select=${cliFields}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      throw new Error(`identity-${record.env}.json names ${CLI_APP_NAME} ${recorded}, which no longer exists; check the tenant, remove cliApp from the record, and run this again.`);
    }
  } else {
    const clis = await getAll(graph, `applications?$filter=displayName%20eq%20'${quote(CLI_APP_NAME)}'&$select=${cliFields}`);
    if (clis.length > 1) throw new Error(`There are ${clis.length} app registrations named ${CLI_APP_NAME}; keep one, delete the others, and run this again.`);
    cli = clis[0] ?? null;
  }
  const cliSp = cli ? (await getAll(graph, `servicePrincipals?$filter=appId%20eq%20'${cli.appId}'&$select=id,appId`))[0] ?? null : null;
  const assignments = (await getAll(graph, `servicePrincipals/${gatewaySp}/appRoleAssignedTo`)).filter(({ appRoleId }) => appRoleId === ADMIN_ROLE_ID);
  const flowApps = (await getAll(graph, `identity/authenticationEventsFlows/${record.userFlow.id}/conditions/applications/includeApplications`)).map(({ appId }) => appId);
  return { gateway, gatewaySp, cli, cliSp, assignments, flowApps };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const write = (name, method, path, body, extra = {}) => ({ name, method, path, body, ...extra });

// The writes that bring `state` to the target, in order. A write that needs an id Graph hasn't shown yet waits for a
// later pass (`deferred`).
function plan(state, record) {
  const admins = adminsOf(record);
  const { gateway, gatewaySp, cli, cliSp, assignments, flowApps } = state;
  const api = gateway.api ?? {};
  const scopes = api.oauth2PermissionScopes ?? [];
  const roles = gateway.appRoles ?? [];
  const scopeClash = scopes.find((scope) => scope.value === ADMIN_SCOPE && scope.id !== ADMIN_SCOPE_ID);
  if (scopeClash) throw new Error(`The gateway app already has a ${ADMIN_SCOPE} scope with id ${scopeClash.id}, not ${ADMIN_SCOPE_ID}; disable and remove it in the admin center, then run this again.`);
  const roleClash = roles.find((role) => role.value === ADMIN_ROLE && role.id !== ADMIN_ROLE_ID);
  if (roleClash) throw new Error(`The gateway app already has an ${ADMIN_ROLE} role with id ${roleClash.id}, not ${ADMIN_ROLE_ID}; disable and remove it in the admin center, then run this again.`);

  const steps = [];
  const deferred = [];
  const identifier = `api://${gateway.appId}`;
  const ownScope = scopes.find(({ id }) => id === ADMIN_SCOPE_ID);
  const ownRole = roles.find(({ id }) => id === ADMIN_ROLE_ID);
  const change = {};
  if (!(gateway.identifierUris ?? []).includes(identifier)) change.identifierUris = [...(gateway.identifierUris ?? []), identifier];
  if (!ownScope || !ownScope.isEnabled || api.requestedAccessTokenVersion !== 2) {
    change.api = { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [...scopes.filter(({ id }) => id !== ADMIN_SCOPE_ID), { ...(ownScope ?? SCOPE), isEnabled: true }] };
  }
  if (!ownRole || !ownRole.isEnabled) change.appRoles = [...roles.filter(({ id }) => id !== ADMIN_ROLE_ID), { ...(ownRole ?? ROLE), isEnabled: true }];
  if (Object.keys(change).length) steps.push(write(`gateway app: ${Object.keys(change).join(", ")}`, "PATCH", `applications/${gateway.id}`, change));

  const cliTarget = {
    signInAudience: "AzureADMyOrg",
    isFallbackPublicClient: false,
    publicClient: { redirectUris: [CLI_REDIRECT] },
    requiredResourceAccess: [{ resourceAppId: gateway.appId, resourceAccess: [{ id: ADMIN_SCOPE_ID, type: "Scope" }] }],
  };
  if (!cli) {
    steps.push(write(`${CLI_APP_NAME} app registration`, "POST", "applications", { displayName: CLI_APP_NAME, ...cliTarget }, { creates: "cli" }));
  } else {
    const drift = Object.fromEntries(Object.entries(cliTarget).filter(([key, value]) => !sameJson(cli[key], value)));
    if (Object.keys(drift).length) steps.push(write(`${CLI_APP_NAME}: ${Object.keys(drift).join(", ")}`, "PATCH", `applications/${cli.id}`, drift));
  }
  const cliAppId = cli?.appId ?? null;
  if (!cliAppId) {
    deferred.push(`${CLI_APP_NAME} service principal, preauthorization and user flow`);
  } else {
    if (!cliSp) steps.push(write(`${CLI_APP_NAME} service principal`, "POST", "servicePrincipals", { appId: cliAppId }, { lag: true, create: true }));
    const preauthorized = api.preAuthorizedApplications ?? [];
    const own = preauthorized.find(({ appId }) => appId === cliAppId);
    if (!own || !sameJson(own.delegatedPermissionIds, [ADMIN_SCOPE_ID])) {
      // Graph checks a preauthorization against the scopes it has stored, so the scope lands in an earlier write.
      if (change.api) deferred.push(`${CLI_APP_NAME} preauthorization`);
      else steps.push(write(`gateway app preauthorizes ${CLI_APP_NAME}`, "PATCH", `applications/${gateway.id}`, { api: { preAuthorizedApplications: [...preauthorized.filter(({ appId }) => appId !== cliAppId), { appId: cliAppId, delegatedPermissionIds: [ADMIN_SCOPE_ID] }] } }, { lag: true }));
    }
    if (!flowApps.includes(cliAppId)) {
      steps.push(write(`user flow: ${CLI_APP_NAME}`, "POST", `identity/authenticationEventsFlows/${record.userFlow.id}/conditions/applications/includeApplications`, { "@odata.type": "#microsoft.graph.authenticationConditionApplication", appId: cliAppId }, { lag: true, create: true }));
    }
  }

  // Exactly the record's admins hold the role. Nobody loses it until every listed admin holds it, so a mistyped id
  // can never leave the tenant without an admin. Graph's "does not exist" is lag only while the role itself is new.
  const held = new Set(assignments.map(({ principalId }) => principalId.toLowerCase()));
  const missing = admins.filter((id) => !held.has(id));
  for (const principalId of missing) {
    steps.push(write(`${ADMIN_ROLE} for ${principalId}`, "POST", `servicePrincipals/${gatewaySp}/appRoleAssignedTo`, { principalId, resourceId: gatewaySp, appRoleId: ADMIN_ROLE_ID }, { lag: "role", create: true }));
  }
  const stale = assignments.filter(({ principalId }) => !admins.includes(principalId.toLowerCase()));
  if (missing.length && stale.length) deferred.push(`${ADMIN_ROLE} removed from ${stale.length} principal(s), once every listed admin holds it`);
  else for (const assignment of stale) steps.push(write(`${ADMIN_ROLE} removed from ${assignment.principalId}`, "DELETE", `servicePrincipals/${gatewaySp}/appRoleAssignedTo/${assignment.id}`));
  return { steps, deferred, roleChanged: Boolean(change.appRoles) };
}

// Reconciles the admin API and returns the record's new `cliApp` and `adminApi` fields. In a dry run, prints the
// writes of the first pass and changes nothing.
export async function reconcileAdminApi({ graph, record, log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), dryRun = false }) {
  adminsOf(record);
  let created = null;
  // Set once this run has written the role: until then an assignment's "does not exist" names a wrong principal.
  let roleIsNew = false;
  let pending = [];
  for (let pass = 0; pass < PASSES; pass += 1) {
    const state = await readState(graph, record);
    // A client this run created that Graph doesn't list yet is waited for, never created again.
    if (!state.cli && created) {
      await sleep(LAG_MS);
      continue;
    }
    const { steps, deferred, roleChanged } = plan(state, record);
    if (!steps.length && !deferred.length) {
      log("admin API: everything is in place.");
      return {
        cliApp: { appId: state.cli.appId, objectId: state.cli.id, servicePrincipalId: state.cliSp.id },
        adminApi: { admins: adminsOf(record), scope: `api://${state.gateway.appId}/${ADMIN_SCOPE}`, scopeId: ADMIN_SCOPE_ID, roleId: ADMIN_ROLE_ID },
      };
    }
    if (dryRun) {
      for (const step of steps) log(`==> ${step.name}\n    would ${step.method} ${step.path}${step.body === undefined ? "" : ` ${JSON.stringify(step.body)}`}`);
      for (const name of deferred) log(`==> ${name}: after the writes above`);
      log("Dry run: nothing was changed.");
      return null;
    }
    if (roleChanged) roleIsNew = true;
    let lagged = false;
    for (const step of steps) {
      log(`==> ${step.name}`);
      try {
        const answer = await graph.call(step.method, `${GRAPH}${step.path}`, step.body === undefined ? undefined : JSON.stringify(step.body));
        if (step.creates === "cli") created = answer;
      } catch (error) {
        const message = `${error?.message ?? ""}`;
        if (step.create && DONE.test(message)) {
          // Done, but the read that planned it lags, so the next read waits too.
          log("    already done.");
          lagged = true;
          continue;
        }
        // Something created moments ago may be unknown to the replica that takes the write.
        const lagging = step.lag === "role" ? roleIsNew : Boolean(step.lag);
        if (!lagging || !LAG.test(message)) throw error;
        log("    Graph doesn't show what this needs yet; trying again on the next pass.");
        lagged = true;
      }
    }
    if (lagged || deferred.length) await sleep(LAG_MS);
    pending = [...steps.map(({ name }) => name), ...deferred];
  }
  throw new Error(`The admin API did not settle after ${PASSES} passes; still pending: ${pending.join("; ")}. Check those ids, then run this again in a few minutes.`);
}
