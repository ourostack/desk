// The admin API pieces of an Ouro tenant (infra/admin-api.mjs): the gateway app's `desk.admin` scope and `ouro.admin`
// role, the ouro CLI's public client, and the role's assignments. Everything runs against a fake Graph behind the
// admin app's real client (admin-graph.mjs), so nothing here reaches Entra.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_ROLES, createAdminGraph } from "../infra/admin-graph.mjs";
import { ADMIN_SCOPE, ADMIN_SCOPE_ID, ADMIN_ROLE_ID, CLI_APP_NAME, CLI_REDIRECT, reconcileAdminApi } from "../infra/admin-api.mjs";
import { parseFlags, run } from "../infra/provision-identity.mjs";
import { ADMIN_ROLE } from "../src/admin.js";

const TENANT = "c12edfb6-c5ab-4bf8-b1d5-1f053311d396";
const ADMIN_APP = "8d518663-4a25-4c58-ba35-3ec34fa99072";
const GATEWAY_APP = "dde1f13f-10b1-4346-b403-5f454d7c2fc8";
const GATEWAY_OBJECT = "3fb9cdf3-2fff-446c-bef7-104ae40620ef";
const GATEWAY_SP = "78077de8-d844-47c3-8660-335280d79a1b";
const FLOW = "a2433c80-0a14-4914-b23b-af2130b469e3";
const ARI = "4850d5fc-552c-4b0d-88a3-2d0329bf4b25";
const OTHER = "3b31358c-6659-4cb1-9b51-f872d8a72b19";
const GRAPH = "https://graph.microsoft.com/v1.0/";

const record = (extra = {}) => ({
  env: "test",
  tenant: { name: "ourobottest", subdomain: "ourobottest", id: TENANT },
  gatewayApp: { appId: GATEWAY_APP, objectId: GATEWAY_OBJECT, servicePrincipalId: GATEWAY_SP },
  adminApp: { appId: ADMIN_APP },
  userFlow: { id: FLOW },
  adminApi: { admins: [ARI] },
  ...extra,
});

// A directory with the gateway app as v1b-1 left it: v2 tokens, no API, no roles.
function directory() {
  return {
    apps: [{ id: GATEWAY_OBJECT, appId: GATEWAY_APP, displayName: "ouro-desk-hosted", identifierUris: [], appRoles: [], api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [], preAuthorizedApplications: [] }, publicClient: { redirectUris: [] }, requiredResourceAccess: [] }],
    sps: [{ id: GATEWAY_SP, appId: GATEWAY_APP }],
    assignments: [],
    flowApps: [GATEWAY_APP],
    writes: [],
    lag: {},
    spLag: {},
    assignLag: {},
    flowLag: {},
    users: [ARI, OTHER],
    next: 1,
  };
}

const unsigned = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Graph's answers for the calls admin-api.mjs makes, and the token endpoint.
function fakeFetch(dir) {
  const id = () => `00000000-0000-4000-8000-${String(dir.next++).padStart(12, "0")}`;
  return async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (url.startsWith("https://login.microsoftonline.com/")) return answer(200, { access_token: unsigned({ tid: TENANT, roles: ADMIN_ROLES }), expires_in: 3599 });
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v1\.0\//, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (method !== "GET") dir.writes.push({ method, path, body });
    let match;
    if (method === "GET" && path === "applications") {
      const filter = parsed.searchParams.get("$filter") ?? "";
      const name = /displayName eq '([^']+)'/.exec(filter)?.[1];
      return answer(200, { value: dir.apps.filter((app) => app.displayName === name && !(dir.lag[app.appId] > 0 && dir.lag[app.appId]--)) });
    }
    if ((match = /^applications\/([^/]+)$/.exec(path))) {
      const app = dir.apps.find((candidate) => candidate.id === match[1]);
      if (!app) return answer(404, { error: { code: "Request_ResourceNotFound", message: "not found" } });
      if (method === "GET") return answer(200, app);
      if (method === "PATCH") {
        if (body.api?.preAuthorizedApplications?.some((pre) => pre.delegatedPermissionIds.some((sid) => !(body.api.oauth2PermissionScopes ?? app.api.oauth2PermissionScopes).some((scope) => scope.id === sid)))) return answer(400, { error: { code: "InvalidValue", message: "preauthorized scope does not exist" } });
        Object.assign(app, { ...body, api: { ...app.api, ...(body.api ?? {}) } });
        return answer(204);
      }
    }
    if (method === "POST" && path === "applications") {
      const app = { id: id(), appId: id(), identifierUris: [], appRoles: [], api: { oauth2PermissionScopes: [], preAuthorizedApplications: [] }, publicClient: { redirectUris: [] }, requiredResourceAccess: [], ...body };
      dir.apps.push(app);
      dir.lag[app.appId] = dir.lagOnCreate ?? 0;
      return answer(201, app);
    }
    if (method === "GET" && path === "servicePrincipals") {
      const appId = /appId eq '([^']+)'/.exec(parsed.searchParams.get("$filter") ?? "")?.[1];
      return answer(200, { value: dir.sps.filter((sp) => sp.appId === appId && !(dir.spLag[sp.id] > 0 && dir.spLag[sp.id]--)) });
    }
    if (method === "POST" && path === "servicePrincipals") {
      if (dir.spRefusals > 0) {
        dir.spRefusals -= 1;
        return answer(400, { error: { code: "Request_BadRequest", message: "The appId of the service principal does not reference a valid application object." } });
      }
      if (dir.sps.some((sp) => sp.appId === body.appId)) return answer(409, { error: { code: "Request_MultipleObjectsWithSameKeyValue", message: "conflicting object: a service principal with this appId already exists" } });
      const sp = { id: id(), appId: body.appId };
      dir.sps.push(sp);
      dir.spLag[sp.id] = dir.spLagOnCreate ?? 0;
      return answer(201, sp);
    }
    if ((match = /^servicePrincipals\/([^/]+)\/appRoleAssignedTo$/.exec(path))) {
      if (method === "GET") {
        const all = dir.assignments.filter((a) => a.resourceId === match[1] && !(dir.assignLag[a.id] > 0 && dir.assignLag[a.id]--));
        const skip = Number(parsed.searchParams.get("$skiptoken") ?? 0);
        const page = all.slice(skip, skip + (dir.pageSize ?? 100));
        return answer(200, { value: page, ...(skip + page.length < all.length ? { "@odata.nextLink": `${GRAPH}${path}?$skiptoken=${skip + page.length}` } : {}) });
      }
      if (dir.refuseAssign > 0) {
        dir.refuseAssign -= 1;
        return answer(400, { error: { code: "Request_BadRequest", message: "Permission being assigned was not found on application" } });
      }
      if (!dir.users.includes(body.principalId)) return answer(404, { error: { code: "Request_ResourceNotFound", message: `Resource '${body.principalId}' does not exist or one of its queried reference-property objects are not present.` } });
      if (dir.assignments.some((a) => a.principalId === body.principalId && a.appRoleId === body.appRoleId && a.resourceId === body.resourceId)) return answer(400, { error: { code: "Request_BadRequest", message: "Permission being assigned already exists on the object" } });
      const assignment = { id: id(), ...body };
      dir.assignments.push(assignment);
      dir.assignLag[assignment.id] = dir.assignLagOnCreate ?? 0;
      return answer(201, assignment);
    }
    if ((match = /^servicePrincipals\/([^/]+)\/appRoleAssignedTo\/([^/]+)$/.exec(path)) && method === "DELETE") {
      dir.assignments = dir.assignments.filter((a) => a.id !== match[2]);
      return answer(204);
    }
    if (path === `identity/authenticationEventsFlows/${FLOW}/conditions/applications/includeApplications`) {
      if (method === "GET") return answer(200, { value: dir.flowApps.filter((appId) => !(dir.flowLag[appId] > 0 && dir.flowLag[appId]--)).map((appId) => ({ appId })) });
      if (dir.flowApps.includes(body.appId)) return answer(409, { error: { code: "ObjectConflict", message: "The application already exists in the flow" } });
      dir.flowApps.push(body.appId);
      dir.flowLag[body.appId] = dir.flowLagOnCreate ?? 0;
      return answer(201, body);
    }
    return answer(404, { error: { code: "Request_ResourceNotFound", message: `fake has no ${method} ${path}` } });
  };
}

const graphFor = (dir) => createAdminGraph({ tenantId: TENANT, appId: ADMIN_APP, secret: "s", fetch: fakeFetch(dir), sleep: async () => {} });
const go = (dir, options = {}) => {
  const logs = [];
  return reconcileAdminApi({ graph: graphFor(dir), record: record(options.record), log: (line) => logs.push(line), sleep: async () => {}, dryRun: options.dryRun }).then((result) => ({ ...result, logs }));
};

test("a tenant without the admin API gets the scope, the role, the CLI client and the admin's assignment, and a rerun writes nothing", async () => {
  const dir = directory();
  const { cliApp, adminApi } = await go(dir);
  const gateway = dir.apps.find((app) => app.appId === GATEWAY_APP);
  assert.deepEqual(gateway.identifierUris, [`api://${GATEWAY_APP}`]);
  assert.equal(gateway.api.requestedAccessTokenVersion, 2);
  assert.deepEqual(gateway.api.oauth2PermissionScopes.map(({ id, value, type, isEnabled }) => ({ id, value, type, isEnabled })), [{ id: ADMIN_SCOPE_ID, value: ADMIN_SCOPE, type: "User", isEnabled: true }]);
  assert.deepEqual(gateway.appRoles.map(({ id, value, allowedMemberTypes, isEnabled }) => ({ id, value, allowedMemberTypes, isEnabled })), [{ id: ADMIN_ROLE_ID, value: ADMIN_ROLE, allowedMemberTypes: ["User"], isEnabled: true }]);
  const cli = dir.apps.find((app) => app.displayName === CLI_APP_NAME);
  assert.equal(cli.isFallbackPublicClient, false, "no device-code or password flow can get an admin token");
  assert.equal(cli.signInAudience, "AzureADMyOrg");
  assert.deepEqual(cli.publicClient.redirectUris, [CLI_REDIRECT]);
  assert.deepEqual(cli.requiredResourceAccess, [{ resourceAppId: GATEWAY_APP, resourceAccess: [{ id: ADMIN_SCOPE_ID, type: "Scope" }] }]);
  assert.deepEqual(gateway.api.preAuthorizedApplications, [{ appId: cli.appId, delegatedPermissionIds: [ADMIN_SCOPE_ID] }]);
  assert.ok(dir.sps.some((sp) => sp.appId === cli.appId), "the CLI client has a service principal");
  assert.ok(dir.flowApps.includes(cli.appId), "the user flow signs the CLI client's users in");
  assert.deepEqual(dir.assignments.map(({ principalId, resourceId, appRoleId }) => ({ principalId, resourceId, appRoleId })), [{ principalId: ARI, resourceId: GATEWAY_SP, appRoleId: ADMIN_ROLE_ID }]);
  assert.deepEqual(cliApp, { appId: cli.appId, objectId: cli.id, servicePrincipalId: dir.sps.find((sp) => sp.appId === cli.appId).id });
  assert.deepEqual(adminApi, { admins: [ARI], scope: `api://${GATEWAY_APP}/${ADMIN_SCOPE}`, scopeId: ADMIN_SCOPE_ID, roleId: ADMIN_ROLE_ID });

  dir.writes = [];
  const again = await go(dir);
  assert.deepEqual(dir.writes, [], "a rerun changes nothing");
  assert.ok(again.logs.some((line) => /admin API: everything is in place/.test(line)));
});

test("the gateway's other scopes, roles and preauthorized clients are kept", async () => {
  const dir = directory();
  const gateway = dir.apps[0];
  const otherScope = { id: "11111111-1111-4111-8111-111111111111", value: "other.read", type: "User", isEnabled: true };
  const otherRole = { id: "22222222-2222-4222-8222-222222222222", value: "ouro.reader", allowedMemberTypes: ["User"], isEnabled: true };
  gateway.identifierUris = ["api://custom-uri"];
  gateway.api.oauth2PermissionScopes = [otherScope];
  gateway.appRoles = [otherRole];
  gateway.api.preAuthorizedApplications = [{ appId: "33333333-3333-4333-8333-333333333333", delegatedPermissionIds: [otherScope.id] }];
  await go(dir);
  assert.deepEqual(gateway.identifierUris, ["api://custom-uri", `api://${GATEWAY_APP}`]);
  assert.deepEqual(gateway.api.oauth2PermissionScopes.map(({ value }) => value), ["other.read", ADMIN_SCOPE]);
  assert.deepEqual(gateway.appRoles.map(({ value }) => value), ["ouro.reader", ADMIN_ROLE]);
  assert.deepEqual(gateway.api.preAuthorizedApplications.map(({ appId }) => appId), ["33333333-3333-4333-8333-333333333333", dir.apps.find((app) => app.displayName === CLI_APP_NAME).appId]);
});

test("an ouro.admin assignment for someone not in the record's admins is removed; other roles' assignments stay", async () => {
  const dir = directory();
  await go(dir);
  dir.assignments.push({ id: "stale", principalId: OTHER, resourceId: GATEWAY_SP, appRoleId: ADMIN_ROLE_ID }, { id: "kept", principalId: OTHER, resourceId: GATEWAY_SP, appRoleId: "22222222-2222-4222-8222-222222222222" });
  dir.writes = [];
  await go(dir);
  assert.deepEqual(dir.writes.map(({ method, path }) => `${method} ${path}`), [`DELETE servicePrincipals/${GATEWAY_SP}/appRoleAssignedTo/stale`]);
  assert.deepEqual(dir.assignments.map(({ id }) => id).filter((id) => id === "stale" || id === "kept"), ["kept"]);
});

test("a desk.admin scope or ouro.admin role with another id stops the run before any write", async () => {
  for (const clash of ["scope", "role"]) {
    const dir = directory();
    if (clash === "scope") dir.apps[0].api.oauth2PermissionScopes = [{ id: "44444444-4444-4444-8444-444444444444", value: ADMIN_SCOPE, type: "User", isEnabled: true }];
    else dir.apps[0].appRoles = [{ id: "44444444-4444-4444-8444-444444444444", value: ADMIN_ROLE, allowedMemberTypes: ["User"], isEnabled: true }];
    await assert.rejects(go(dir), new RegExp(`${clash === "scope" ? ADMIN_SCOPE : ADMIN_ROLE}.*44444444`));
    assert.deepEqual(dir.writes, [], clash);
  }
});

test("a record without admins is refused, so a run never removes every admin", async () => {
  for (const admins of [undefined, []]) {
    const dir = directory();
    await assert.rejects(go(dir, { record: { adminApi: admins === undefined ? undefined : { admins } } }), /adminApi\.admins/);
    assert.deepEqual(dir.writes, []);
  }
  const dir = directory();
  await assert.rejects(go(dir, { record: { adminApi: { admins: ["not-a-guid"] } } }), /adminApi\.admins/);
});

test("a dry run reads and prints the writes but changes nothing", async () => {
  const dir = directory();
  const { logs } = await go(dir, { dryRun: true });
  assert.deepEqual(dir.writes, []);
  assert.ok(logs.some((line) => /would PATCH applications\/3fb9cdf3/.test(line)), logs.join("\n"));
  assert.ok(logs.some((line) => /would POST applications /.test(line)), logs.join("\n"));
  assert.ok(logs.some((line) => /Dry run: nothing was changed/.test(line)));
});

test("Graph's lag after creating the CLI client or the role is waited out, never answered with a second client", async () => {
  const dir = directory();
  dir.lagOnCreate = 2;
  dir.refuseAssign = 2;
  await go(dir);
  assert.equal(dir.apps.filter((app) => app.displayName === CLI_APP_NAME).length, 1);
  assert.equal(dir.assignments.length, 1);
});

test("two CLI clients with the same name stop the run", async () => {
  const dir = directory();
  dir.apps.push({ id: "a1", appId: "b1", displayName: CLI_APP_NAME }, { id: "a2", appId: "b2", displayName: CLI_APP_NAME });
  await assert.rejects(go(dir), /2 app registrations named ouro-cli/);
});

test("provision-identity --admin-api reconciles through the keychain's admin app without az, and records the CLI client", async (t) => {
  assert.equal(parseFlags(["--env", "test", "--admin-api"]).flags.adminApi, true);
  assert.throws(() => parseFlags(["--env", "test", "--admin-api", "--seed-ari"]), /one action at a time/);
  const dir = mkdtempSync(join(tmpdir(), "desk-admin-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "records"));
  writeFileSync(join(dir, "records", "identity-test.json"), JSON.stringify(record()));
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "security" && args[0] === "find-generic-password") return { stdout: "keychain-secret\n" };
    throw new Error(`unexpected ${cmd}`);
  };
  const graphDir = directory();
  const logs = [];
  await run({ env: "test", flags: { adminApi: true }, runner, fetch: fakeFetch(graphDir), recordDir: join(dir, "records"), log: (line) => logs.push(line), sleep: async () => {} });
  assert.deepEqual(calls, [`security find-generic-password -s ouro-identity-admin-${TENANT} -a ${ADMIN_APP} -w`], "only the keychain read; no az");
  const saved = JSON.parse(readFileSync(join(dir, "records", "identity-test.json"), "utf8"));
  const cli = graphDir.apps.find((app) => app.displayName === CLI_APP_NAME);
  assert.equal(saved.cliApp.appId, cli.appId);
  assert.equal(saved.adminApi.scope, `api://${GATEWAY_APP}/${ADMIN_SCOPE}`);
  assert.ok(!JSON.stringify(logs).includes("keychain-secret"), "the secret is never logged");
});

test("a Graph error other than lag stops the run, and a run that never settles says so", async () => {
  const dir = directory();
  const failing = fakeFetch(dir);
  const graph = createAdminGraph({ tenantId: TENANT, appId: ADMIN_APP, secret: "s", sleep: async () => {}, fetch: async (url, init = {}) => (init.method === "PATCH" ? answer(400, { error: { code: "InvalidValue", message: "bad identifier uri" } }) : failing(url, init)) });
  await assert.rejects(reconcileAdminApi({ graph, record: record(), log: () => {}, sleep: async () => {} }), /bad identifier uri/);
  const stuck = directory();
  stuck.refuseAssign = Infinity;
  await assert.rejects(go(stuck), /did not settle after 20 passes; still pending: ouro\.admin for 4850d5fc/);
});

test("a create that a lagging read misses is not an error: the service principal, the user flow link and the assignment", async () => {
  const dir = directory();
  dir.spLagOnCreate = 2;
  dir.flowLagOnCreate = 2;
  dir.spRefusals = 1;
  const { logs } = await go(dir);
  assert.equal(dir.sps.filter((sp) => sp.appId === dir.apps.find((app) => app.displayName === CLI_APP_NAME).appId).length, 1);
  assert.ok(logs.some((line) => /already done/.test(line)), logs.join("\n"));
  assert.ok(logs.some((line) => /admin API: everything is in place/.test(line)));
});

test("a mistyped admin id fails at once and never removes the admin who holds the role", async () => {
  const dir = directory();
  await go(dir);
  const typo = "4850d5fc-552c-4b0d-88a3-2d0329bf4b26";
  dir.writes = [];
  await assert.rejects(go(dir, { record: { adminApi: { admins: [typo] } } }), new RegExp(`${typo}' does not exist`));
  assert.deepEqual(dir.writes.map(({ method }) => method), ["POST"], "only the failed grant; no removal");
  assert.ok(dir.assignments.some((a) => a.principalId === ARI && a.appRoleId === ADMIN_ROLE_ID), "Ari keeps the role");
});

test("assignments on a later page are seen, so they are neither granted twice nor left in place", async () => {
  const dir = directory();
  dir.pageSize = 1;
  dir.users.push("55555555-5555-4555-8555-555555555555");
  dir.assignments.push({ id: "filler", principalId: "55555555-5555-4555-8555-555555555555", resourceId: GATEWAY_SP, appRoleId: "22222222-2222-4222-8222-222222222222" }, { id: "late", principalId: OTHER, resourceId: GATEWAY_SP, appRoleId: ADMIN_ROLE_ID });
  await go(dir);
  assert.deepEqual(dir.assignments.filter((a) => a.appRoleId === ADMIN_ROLE_ID).map(({ principalId }) => principalId), [ARI]);
});

test("a recorded CLI client is read by its object id: a renamed one is kept, a deleted one stops the run, and a namesake is never adopted", async () => {
  const dir = directory();
  const first = await go(dir);
  const cli = dir.apps.find((app) => app.displayName === CLI_APP_NAME);
  cli.displayName = "ouro-cli (renamed)";
  dir.apps.push({ id: "imposter", appId: "imposter-app", displayName: CLI_APP_NAME });
  dir.writes = [];
  await go(dir, { record: { cliApp: first.cliApp } });
  assert.deepEqual(dir.writes, [], "the renamed client is still in place");
  dir.apps = dir.apps.filter((app) => app !== cli);
  await assert.rejects(go(dir, { record: { cliApp: first.cliApp } }), /no longer exists/);
  assert.ok(!dir.apps.find((app) => app.id === "imposter").api, "the namesake was never touched");
  assert.ok(!dir.flowApps.includes("imposter-app"));
});

test("a disabled scope or role is enabled again, v1 tokens go back to v2, and a CLI client that drifted is corrected", async () => {
  const dir = directory();
  await go(dir);
  const gateway = dir.apps[0];
  gateway.api.oauth2PermissionScopes[0].isEnabled = false;
  gateway.appRoles[0].isEnabled = false;
  gateway.api.requestedAccessTokenVersion = 1;
  const cli = dir.apps.find((app) => app.displayName === CLI_APP_NAME);
  cli.isFallbackPublicClient = true;
  cli.publicClient = { redirectUris: ["http://localhost/other"] };
  await go(dir);
  assert.equal(gateway.api.oauth2PermissionScopes[0].isEnabled, true);
  assert.equal(gateway.appRoles[0].isEnabled, true);
  assert.equal(gateway.api.requestedAccessTokenVersion, 2);
  assert.equal(cli.isFallbackPublicClient, false);
  assert.deepEqual(cli.publicClient.redirectUris, [CLI_REDIRECT]);
});

test("replacing one admin with another settles even while the new assignment's read lags, and the old admin goes last", async () => {
  const dir = directory();
  dir.assignments.push({ id: "old", principalId: OTHER, resourceId: GATEWAY_SP, appRoleId: ADMIN_ROLE_ID });
  await go(dir, { record: { adminApi: { admins: [OTHER] } } });
  dir.assignments = dir.assignments.filter((a) => a.id === "old");
  dir.assignLagOnCreate = 5;
  const sleeps = [];
  const graph = graphFor(dir);
  await reconcileAdminApi({ graph, record: record(), log: () => {}, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(dir.assignments.map(({ principalId }) => principalId), [ARI]);
  assert.ok(sleeps.length >= 1, "a pass with deferred work waits before reading again");
  const order = dir.writes.filter(({ path }) => path.includes("appRoleAssignedTo")).map(({ method }) => method);
  assert.equal(order.at(-1), "DELETE", "the old admin loses the role only after the new one holds it");
});
