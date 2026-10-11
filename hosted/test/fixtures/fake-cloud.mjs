// A recording fake of the az, gh and Graph calls provision-identity.mjs makes, over an in-memory cloud. Each call is
// kept in `calls` as { cmd, args, input, write }; `write` is this fake's own judgement of whether the call changes
// anything, independent of the script's, so a test can assert that a dry run or a reconciled rerun makes no write.
import { createHash } from "node:crypto";
import { armPatch, azUpdateModel, LISTED_WITHOUT_VALUE } from "./az-update-model.mjs";

export const SUB = "261e0bf1-934d-41ab-9295-229b0d254418";
export const TEST_TENANT = "c12edfb6-c5ab-4bf8-b1d5-1f053311d396";
export const AZURE_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const GRAPH = "https://graph.microsoft.com/v1.0/";
export const VAULT_ID = `/subscriptions/${SUB}/resourceGroups/rg-ouro-identity/providers/Microsoft.KeyVault/vaults/kv-ouro-identity-261e0b`;
export const OPERATOR = "0a0a0a0a-0000-4000-8000-0000000000aa";
// An ARM token for the operator, as az prints it: only its payload matters here.
export const OPERATOR_TOKEN = ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify({ oid: OPERATOR, tid: AZURE_TENANT })).toString("base64url"), "c2lnbmF0dXJlLW5vdC1jaGVja2Vk"].join(".");

let counter = 0;
const guid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

export class CallFailed extends Error {
  constructor(message, stderr) {
    super(message);
    this.stderr = stderr;
  }
}
// Graph's answer to a refused call: az rest turns it into stderr, fetch into a status and a JSON body.
export class GraphRefused extends Error {
  constructor(status, reason, code, message) {
    super(message);
    Object.assign(this, { status, reason, code });
  }
}
const refuse = (status, reason, code, message) => {
  throw new GraphRefused(status, reason, code, message);
};
// Microsoft Graph's service principal in the tenant, with the application roles the scripts look up by name.
export const GRAPH_SP_ID = "0f0f0f0f-0000-4000-8000-00000000000f";
export const GRAPH_ROLES = {
  "IdentityProvider.ReadWrite.All": "90db2b9a-d928-4d33-a4dd-8442ae3d41e4",
  "Application.Read.All": "9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30",
  "Application.ReadWrite.All": "1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9",
  "IdentityUserFlow.ReadWrite.All": "65319a09-a2be-469d-8782-f6b07debf789",
  "EventListener.ReadWrite.All": "0edf5e9e-4ce8-468a-8f2d-2c4a4aa8bd0a",
  "Policy.ReadWrite.AuthenticationMethod": "29c18626-4985-4dcd-85c0-193eef327366",
  "User.Read.All": "df021288-bdef-4463-88db-98f22de89214",
};
// The role a Graph path needs from an app-only token, for the paths az's delegated token can't reach (spike Step 3).
function roleFor(path) {
  if (path.startsWith("identity/identityProviders")) return "IdentityProvider.ReadWrite.All";
  if (path.startsWith("identity/authenticationEventsFlows")) return "EventListener.ReadWrite.All";
  if (path.startsWith("policies/authenticationMethodsPolicy")) return "Policy.ReadWrite.AuthenticationMethod";
  return null;
}
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;
export const APPLE_TYPE = "#microsoft.graph.appleManagedIdentityProvider";

const notFound = (what) => {
  throw new CallFailed(`not found: ${what}`, `ERROR: (ResourceNotFound) ${what} was not found. HTTP 404`);
};

export function emptyCloud() {
  return {
    account: { tenantId: TEST_TENANT },
    ciam: { ourobottest: { tenantId: TEST_TENANT, domainName: "ourobottest.onmicrosoft.com" } },
    taken: new Set(["ouro", "ourotest"]),
    graph: { email: { state: "disabled", allowExternalIdToUseEmailOtp: "default" }, providers: [], flows: [], apps: [], sps: [], grants: [] },
    // The operator's macOS keychain: generic passwords by service, each { account, password }.
    keychain: {},
    // A user flow refuses a new service principal's app id ("The application id ... is invalid") for this many tries.
    flowLinkLag: 0,
    // A new service principal's first appRoleAssignments POSTs answer 404 (replication) this many times.
    grantLag: 0,
    // The next this-many appRoleAssignments reads come back empty (a stale replica).
    staleRoleReads: 0,
    // A new password credential is missing from `ad app credential list` for this many lists.
    credentialListLag: 0,
    // `security -i` fails ("fail") or stores a different value ("corrupt").
    keychainWrite: "ok",
    vault: { secrets: {} },
    identities: {},
    roles: [],
    storage: {},
    containerApps: {},
    gh: { env: null, variables: {} },
    failKeyVaultWrites: false,
    // Key Vault uses RBAC: its data plane answers 403 until the operator holds Key Vault Secrets Officer, and for
    // `propagation` more calls after that role is created.
    vaultRbac: true,
    propagation: 0,
    // Graph's reads miss a new app, service principal or flow for this many reads after its create.
    graphLag: 0,
    // az fills a Key Vault reference's value from listSecrets before sending an update (the review's worst case).
    resolveRefs: false,
    // listSecrets returns a Key Vault reference without a value, on which az's update fails before sending.
    refsWithoutValue: false,
    keepTagsOnSet: false,
  };
}

export function createFakeRunner(cloud = emptyCloud()) {
  const calls = [];
  const opt = (args, flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const json = (value) => ({ stdout: `${JSON.stringify(value)}\n` });
  const tsv = (value) => ({ stdout: `${value}\n` });

  const visible = (object) => {
    if (!object.hiddenFor) return true;
    object.hiddenFor -= 1;
    return false;
  };
  let pendingPropagation = 0;
  function vaultDataPlane() {
    if (!cloud.vaultRbac) return;
    const granted = cloud.roles.some((role) => role.principalId === OPERATOR && role.role === "Key Vault Secrets Officer" && role.scope === VAULT_ID);
    if (!granted) throw new CallFailed("az keyvault failed", "ERROR: (Forbidden) Caller is not authorized to perform action on resource. Status: 403 (Forbidden)");
    if (pendingPropagation > 0) {
      pendingPropagation -= 1;
      throw new CallFailed("az keyvault failed", "ERROR: (Forbidden) The role assignment is not in effect yet. Status: 403 (Forbidden)");
    }
  }

  // Graph over the in-memory tenant. `caller` is "user" for az rest (az's delegated token) or { appId, roles } for an
  // app-only token. Delegated calls to the identity paths are refused, as live (spike Step 3: no consentable scope).
  function graph(method, url, body, caller = "user") {
    const [path, query = ""] = url.slice(GRAPH.length).split("?");
    const g = cloud.graph;
    const role = roleFor(path);
    if (role && caller === "user") refuse(403, "Forbidden", "Authorization_RequestDenied", "Insufficient privileges to complete the operation.");
    if (role && caller !== "user" && !caller.roles.includes(role)) refuse(403, "Forbidden", "Authorization_RequestDenied", "Insufficient privileges to complete the operation.");
    if (path === "policies/authenticationMethodsPolicy/authenticationMethodConfigurations/email") {
      if (method === "get") return g.email;
      Object.assign(g.email, { state: body.state, allowExternalIdToUseEmailOtp: body.allowExternalIdToUseEmailOtp });
      return {};
    }
    if (path === "identity/identityProviders") {
      if (method === "get") return { value: g.providers.map(({ certificateData, ...rest }) => rest) };
      if (body["@odata.type"] === APPLE_TYPE && g.providers.some((provider) => provider["@odata.type"] === APPLE_TYPE)) refuse(400, "Bad Request", "Request_BadRequest", "An Apple identity provider already exists in this tenant.");
      if (body.certificateData !== undefined && !BASE64_ONLY.test(body.certificateData)) refuse(400, "Bad Request", "Request_BadRequest", "The property 'CertificateData' should be a Base64 encoded string.");
      // An external tenant names the provider with a GUID, not B2C's Apple-Managed-OIDC (spike Step 5).
      const provider = { id: guid(), ...body };
      g.providers.push(provider);
      const { certificateData, ...shown } = provider;
      void certificateData;
      return shown;
    }
    let match = path.match(/^identity\/identityProviders\/([^/]+)$/);
    if (match) {
      const provider = g.providers.find(({ id }) => id === match[1]) ?? notFound(match[1]);
      if (method === "get") {
        const { certificateData, ...shown } = provider;
        void certificateData;
        return shown;
      }
      if (body.certificateData !== undefined && !BASE64_ONLY.test(body.certificateData)) refuse(400, "Bad Request", "Request_BadRequest", "The property 'CertificateData' should be a Base64 encoded string.");
      Object.assign(provider, body);
      return null;
    }
    if (path === "identity/authenticationEventsFlows") {
      if (method === "get") return { value: g.flows.filter(visible).map(({ apps, idps, hiddenFor, ...flow }) => flow) };
      const flow = { id: guid(), displayName: body.displayName, idps: body.onAuthenticationMethodLoadStart.identityProviders.map(({ id }) => id), apps: [], hiddenFor: cloud.graphLag };
      g.flows.push(flow);
      return { id: flow.id, displayName: flow.displayName };
    }
    match = path.match(/^identity\/authenticationEventsFlows\/([^/]+)\/conditions\/applications\/includeApplications$/);
    if (match) {
      const flow = g.flows.find(({ id }) => id === match[1]) ?? notFound(match[1]);
      if (method === "get") return { value: flow.apps.map((appId) => ({ appId })) };
      // A new service principal's app id is refused for about 30 seconds (spike Step 3).
      const sp = g.sps.find(({ appId }) => appId === body.appId);
      if (!sp || sp.flowLinkLag > 0) {
        if (sp) sp.flowLinkLag -= 1;
        refuse(400, "Bad Request", "Request_BadRequest", `The application id ${body.appId} is invalid.`);
      }
      flow.apps.push(body.appId);
      return {};
    }
    match = path.match(/^identity\/authenticationEventsFlows\/([^/]+)\/microsoft\.graph\.externalUsersSelfServiceSignUpEventsFlow\/onAuthenticationMethodLoadStart\/microsoft\.graph\.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp\/identityProviders(\/\$ref)?$/);
    if (match) {
      const flow = g.flows.find(({ id }) => id === match[1]) ?? notFound(match[1]);
      if (method === "get") return { value: flow.idps.map((id) => ({ id })) };
      flow.idps.push(body["@odata.id"].split("/").at(-1));
      return {};
    }
    // Delegated with az's AppRoleAssignment.ReadWrite.All and DelegatedPermissionGrant.ReadWrite.All.
    if (path === "servicePrincipals" && /appId%20eq%20'00000003-0000-0000-c000-000000000000'/.test(query)) {
      return { value: [{ id: GRAPH_SP_ID, appRoles: Object.entries(GRAPH_ROLES).map(([value, id]) => ({ id, value, allowedMemberTypes: ["Application"] })) }] };
    }
    match = path.match(/^servicePrincipals\/([^/]+)\/appRoleAssignments$/);
    if (match) {
      const sp = g.sps.find(({ id }) => id === match[1]) ?? notFound(match[1]);
      if (method === "get") {
        if (cloud.staleRoleReads > 0) {
          cloud.staleRoleReads -= 1;
          return { value: [] };
        }
        return { value: sp.appRoleAssignments.map((appRoleId) => ({ appRoleId, resourceId: GRAPH_SP_ID })) };
      }
      if (sp.grantLag > 0) {
        sp.grantLag -= 1;
        refuse(404, "Not Found", "Request_ResourceNotFound", `Resource '${sp.id}' does not exist or one of its queried reference-property objects are not present.`);
      }
      if (body.principalId !== sp.id || body.resourceId !== GRAPH_SP_ID) refuse(400, "Bad Request", "Request_BadRequest", "principalId or resourceId is wrong.");
      if (sp.appRoleAssignments.includes(body.appRoleId)) refuse(400, "Bad Request", "Request_BadRequest", "Permission being assigned already exists on the object");
      sp.appRoleAssignments.push(body.appRoleId);
      return { id: guid(), ...body };
    }
    if (path === "oauth2PermissionGrants") {
      if (method === "get") {
        const clientId = /clientId%20eq%20'([^']+)'/.exec(query)?.[1];
        return { value: g.grants.filter((grant) => !clientId || grant.clientId === clientId) };
      }
      const grant = { id: guid(), ...body };
      g.grants.push(grant);
      return grant;
    }
    match = path.match(/^oauth2PermissionGrants\/([^/]+)$/);
    if (match) {
      const grant = g.grants.find(({ id }) => id === match[1]) ?? notFound(match[1]);
      Object.assign(grant, body);
      return null;
    }
    throw new CallFailed(`fake Graph has no ${method} ${path}`, "");
  }

  function az(args, input) {
    const joined = args.join(" ");
    const g = cloud.graph;
    if (joined.startsWith("account show")) return tsv(cloud.account.tenantId);
    if (joined.startsWith("account get-access-token")) return tsv(OPERATOR_TOKEN);
    if (args[0] === "rest") {
      const method = opt(args, "--method");
      const url = opt(args, "--url");
      const body = input ? JSON.parse(input) : undefined;
      if (url.startsWith(GRAPH)) {
        try {
          const answer = graph(method, url, body);
          return answer === null ? { stdout: "" } : json(answer);
        } catch (error) {
          if (!(error instanceof GraphRefused)) throw error;
          throw new CallFailed(`az rest failed: ${error.reason}`, `ERROR: ${error.reason}(${JSON.stringify({ error: { code: error.code, message: error.message } })})`);
        }
      }
      if (url.includes("/checkNameAvailability")) return json({ nameAvailable: !cloud.taken.has(body.name) && !cloud.ciam[body.name] });
      const ciam = url.match(/ciamDirectories\/([^?]+)\?/);
      if (ciam && method === "put") {
        cloud.ciam[ciam[1]] = { tenantId: guid(), domainName: `${ciam[1]}.onmicrosoft.com`, body };
        return json({});
      }
      throw new CallFailed(`fake az rest has no ${method} ${url}`, "");
    }
    if (joined.startsWith("resource show") && opt(args, "--resource-type") === "ciamDirectories") {
      const directory = cloud.ciam[opt(args, "-n")] ?? notFound(opt(args, "-n"));
      return json({ tenantId: directory.tenantId, domainName: directory.domainName });
    }
    // Entra apps and service principals.
    if (joined.startsWith("ad app list")) {
      const apps = g.apps.filter((app) => app.displayName === opt(args, "--display-name")).filter(visible);
      return json(apps.map((app) => ({ appId: app.appId, id: app.id, redirects: app.web.redirectUris, tokenVersion: app.api.requestedAccessTokenVersion, passwords: app.passwordCredentials.length, access: app.requiredResourceAccess })));
    }
    if (joined.startsWith("ad app create")) {
      const app = { appId: guid(), id: guid(), displayName: opt(args, "--display-name"), web: { redirectUris: [] }, api: { requestedAccessTokenVersion: null }, passwordCredentials: [], requiredResourceAccess: [], federated: [], hiddenFor: cloud.graphLag };
      const index = args.indexOf("--web-redirect-uris");
      if (index !== -1) for (let i = index + 1; i < args.length && !args[i].startsWith("--"); i += 1) app.web.redirectUris.push(args[i]);
      g.apps.push(app);
      return json({ appId: app.appId, id: app.id });
    }
    const appById = () => g.apps.find((app) => app.appId === opt(args, "--id")) ?? notFound(opt(args, "--id"));
    if (joined.startsWith("ad app update")) {
      const app = appById();
      if (args.includes("--set")) app.api.requestedAccessTokenVersion = Number(opt(args, "--set").split("=")[1]);
      const index = args.indexOf("--web-redirect-uris");
      if (index !== -1) {
        app.web.redirectUris = [];
        for (let i = index + 1; i < args.length && !args[i].startsWith("--"); i += 1) app.web.redirectUris.push(args[i]);
      }
      return { stdout: "" };
    }
    if (joined.startsWith("ad app credential reset")) {
      const app = appById();
      const password = `Gw~${guid()}.secret`;
      app.passwordCredentials.push({ keyId: guid(), displayName: opt(args, "--display-name"), endDateTime: opt(args, "--end-date") ?? null, secretText: password, unlistedFor: cloud.credentialListLag });
      cloud.lastGatewaySecret = password;
      return tsv(password);
    }
    if (joined.startsWith("ad app credential list")) {
      // Only the one JMESPath filter the rotation uses: [?displayName=='<name>'].keyId.
      const named = /^\[\?displayName=='([^']*)'\]\.keyId$/.exec(opt(args, "--query") ?? "");
      const credentials = appById().passwordCredentials.filter((credential) => {
        if (!credential.unlistedFor) return true;
        credential.unlistedFor -= 1;
        return false;
      }).filter(({ displayName }) => !named || displayName === named[1]);
      return tsv(credentials.map(({ keyId }) => keyId).join("\n"));
    }
    if (joined.startsWith("ad app credential delete")) {
      const app = appById();
      app.passwordCredentials = app.passwordCredentials.filter(({ keyId }) => keyId !== opt(args, "--key-id"));
      return { stdout: "" };
    }
    if (joined.startsWith("ad app permission add")) {
      const app = appById();
      const [resourceAppId, list] = [opt(args, "--api"), opt(args, "--api-permissions")];
      const index = args.indexOf("--api-permissions");
      const access = [];
      for (let i = index + 1; i < args.length && !args[i].startsWith("--"); i += 1) {
        const [id, type] = args[i].split("=");
        access.push({ id, type });
      }
      app.requiredResourceAccess.push({ resourceAppId, resourceAccess: access });
      void list;
      return { stdout: "" };
    }
    // az's admin-consent posts to the portal's internal API (main.iam.ad.ext.azure.com), not Graph; the scripts grant
    // roles through appRoleAssignments instead, so this fake refuses it.
    if (joined.startsWith("ad app permission admin-consent") && !cloud.allowAdminConsent) throw new CallFailed("az ad app permission admin-consent failed", "ERROR: the scripts must not use the portal's internal consent API");
    if (joined.startsWith("ad app permission admin-consent")) {
      const app = appById();
      const sp = g.sps.find(({ appId }) => appId === app.appId) ?? notFound("service principal");
      for (const { resourceAccess } of app.requiredResourceAccess) for (const { id, type } of resourceAccess) if (type === "Role") sp.appRoleAssignments.push(id);
      app.consented = true;
      return { stdout: "" };
    }
    if (joined.startsWith("ad app federated-credential list")) return tsv(appById().federated.map(({ subject }) => subject).join("\n"));
    if (joined.startsWith("ad app federated-credential create")) {
      appById().federated.push(JSON.parse(input));
      return { stdout: "" };
    }
    if (joined.startsWith("ad sp list")) {
      const appId = opt(args, "--filter").match(/'([^']+)'/)[1];
      return tsv(g.sps.filter((sp) => sp.appId === appId).filter(visible).map(({ id }) => id).join("\n"));
    }
    if (joined.startsWith("ad sp create")) {
      if (g.sps.some((sp) => sp.appId === opt(args, "--id"))) throw new CallFailed("az ad sp create failed", "ERROR: a service principal for this app already exists");
      g.sps.push({ id: guid(), appId: opt(args, "--id"), appRoleAssignments: [], hiddenFor: cloud.graphLag, flowLinkLag: cloud.flowLinkLag, grantLag: cloud.grantLag });
      return { stdout: "" };
    }
    // Key Vault.
    if (joined.startsWith("keyvault show")) return tsv(VAULT_ID);
    if (joined.startsWith("keyvault secret")) vaultDataPlane();
    if (joined.startsWith("keyvault secret list")) return tsv(Object.keys(cloud.vault.secrets).join("\n"));
    if (joined.startsWith("keyvault secret set")) {
      if (cloud.failKeyVaultWrites) throw new CallFailed("az keyvault secret set failed", "ERROR: Forbidden");
      const tags = {};
      const index = args.indexOf("--tags");
      if (index !== -1) for (let i = index + 1; i < args.length && !args[i].startsWith("--"); i += 1) tags[args[i].split("=")[0]] = args[i].split("=")[1];
      if (cloud.corruptKeyVaultWrites) input = `${input}x`;
      const keptTags = cloud.keepTagsOnSet ? cloud.vault.secrets[opt(args, "--name")]?.tags ?? {} : {};
      cloud.vault.secrets[opt(args, "--name")] = { value: input, tags: { ...keptTags, ...tags } };
      return tsv(`https://kv-ouro-identity-261e0b.vault.azure.net/secrets/${opt(args, "--name")}/v2`);
    }
    if (joined.startsWith("keyvault secret show")) {
      const secret = cloud.vault.secrets[opt(args, "--name")] ?? notFound(opt(args, "--name"));
      if (opt(args, "--query") === "tags") return json(secret.tags);
      return tsv(secret.value);
    }
    // Managed identities and roles.
    if (joined.startsWith("identity show")) {
      const identity = cloud.identities[opt(args, "-n")] ?? notFound(opt(args, "-n"));
      return json({ id: identity.id, clientId: identity.clientId, principalId: identity.principalId, tenantId: identity.tenantId });
    }
    if (joined.startsWith("identity create")) {
      const name = opt(args, "-n");
      cloud.identities[name] = { id: `/subscriptions/${SUB}/resourceGroups/rg-ouro-identity/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`, clientId: guid(), principalId: guid(), tenantId: AZURE_TENANT, federated: [] };
      return json({});
    }
    if (joined.startsWith("identity federated-credential list")) {
      const identity = cloud.identities[opt(args, "--identity-name")] ?? notFound("identity");
      return tsv(identity.federated.map(({ subject }) => subject).join("\n"));
    }
    if (joined.startsWith("identity federated-credential create")) {
      const identity = cloud.identities[opt(args, "--identity-name")] ?? notFound("identity");
      identity.federated.push({ name: opt(args, "--name"), issuer: opt(args, "--issuer"), subject: opt(args, "--subject"), audiences: opt(args, "--audiences") });
      return { stdout: "" };
    }
    if (joined.startsWith("role assignment list")) {
      const scope = opt(args, "--scope");
      return json(cloud.roles.filter((role) => role.scope === scope).map(({ principalId, role }) => ({ principalId, roleDefinitionName: role })));
    }
    if (joined.startsWith("role assignment create")) {
      cloud.roles.push({ principalId: opt(args, "--assignee-object-id"), principalType: opt(args, "--assignee-principal-type"), role: opt(args, "--role"), scope: opt(args, "--scope") });
      if (opt(args, "--assignee-object-id") === OPERATOR) pendingPropagation = cloud.propagation;
      return { stdout: "" };
    }
    // Storage.
    if (joined.startsWith("storage account show")) {
      const account = cloud.storage[opt(args, "-n")] ?? notFound(opt(args, "-n"));
      return json(account);
    }
    if (joined.startsWith("storage account create")) {
      const name = opt(args, "-n");
      cloud.storage[name] = { id: `/subscriptions/${SUB}/resourceGroups/rg-ouro-identity/providers/Microsoft.Storage/storageAccounts/${name}`, endpoint: `https://${name}.table.core.windows.net/`, sharedKey: opt(args, "--allow-shared-key-access") === "true", tls: opt(args, "--min-tls-version"), sku: opt(args, "--sku") };
      return json({});
    }
    if (joined.startsWith("storage account update")) {
      Object.assign(cloud.storage[opt(args, "-n")], { sharedKey: false, tls: "TLS1_2" });
      return { stdout: "" };
    }
    // Container Apps.
    if (args[0] === "containerapp") {
      const name = opt(args, "-n") ?? opt(args, "--name");
      const app = cloud.containerApps[name] ?? notFound(name);
      if (joined.startsWith("containerapp show")) {
        if (opt(args, "--query") === "id") return tsv(app.shown.id);
        if (opt(args, "--query") === "properties.latestReadyRevisionName") return tsv(app.shown.properties.latestReadyRevisionName);
        return json(app.shown);
      }
      if (joined.startsWith("containerapp secret show")) {
        const value = app.secrets[opt(args, "--secret-name")];
        if (value === undefined) notFound(opt(args, "--secret-name"));
        return tsv(value);
      }
      if (joined.startsWith("containerapp secret list")) return json(app.shown.properties.configuration.secrets);
      if (joined.startsWith("containerapp logs show")) return { stdout: app.logs.filter((line) => line.revision === opt(args, "--revision")).map(({ text }) => text).join("\n") };
      if (joined.startsWith("containerapp update")) {
        const document = JSON.parse(app.readYaml(opt(args, "--yaml")));
        app.updates.push(structuredClone(document));
        // What az sends (az-update-model.mjs), and what ARM's PATCH then holds.
        const listed = {};
        for (const secret of app.shown.properties.configuration.secrets) {
          if (!secret.keyVaultUrl) listed[secret.name] = app.secrets[secret.name];
          else if (cloud.resolveRefs) listed[secret.name] = "value-from-key-vault";
          else if (cloud.refsWithoutValue) listed[secret.name] = LISTED_WITHOUT_VALUE;
        }
        let sent;
        try {
          sent = azUpdateModel(document, listed);
        } catch (error) {
          throw new CallFailed(`containerapp update failed: ${error.message}`, error.stderr);
        }
        const { app: next, values } = armPatch(app.shown, sent);
        if (cloud.dropIdentitiesOnUpdate) next.identity = { type: "UserAssigned", userAssignedIdentities: {} };
        Object.assign(app.secrets, values);
        app.shown = next;
        app.onUpdate?.(app);
        return { stdout: "" };
      }
      if (joined.startsWith("containerapp revision restart")) {
        app.restarts.push(opt(args, "--revision"));
        return { stdout: "" };
      }
    }
    throw new CallFailed(`fake az has no ${joined}`, "");
  }

  function gh(args, input) {
    const joined = args.join(" ");
    if (args[0] === "api") {
      const method = opt(args, "-X") ?? "GET";
      const path = args.find((arg) => arg.startsWith("repos/"));
      if (path === "repos/ourostack/desk/environments/identity") {
        if (method === "GET") return cloud.gh.env ? json({ name: "identity" }) : notFound("environment");
        cloud.gh.env = { policy: JSON.parse(input).deployment_branch_policy, branches: [] };
        return json({});
      }
      if (path === "repos/ourostack/desk/environments/identity/deployment-branch-policies") {
        // As `--jq "[.branch_policies[].name]"` prints it.
        if (method === "GET") return json((cloud.gh.env ?? notFound("environment")).branches);
        cloud.gh.env.branches.push(args[args.indexOf("-f") + 1].split("=")[1]);
        return json({});
      }
    }
    if (joined.startsWith("variable list") && !cloud.gh.env) notFound("environment identity (HTTP 404)");
    if (joined.startsWith("variable list")) return json(Object.entries(cloud.gh.variables).map(([name, value]) => ({ name, value })));
    if (joined.startsWith("variable set")) {
      cloud.gh.variables[args[2]] = opt(args, "--body");
      return { stdout: "" };
    }
    throw new CallFailed(`fake gh has no ${joined}`, "");
  }

  // The macOS keychain, through `security`.
  function security(args, input) {
    if (args[0] === "find-generic-password") {
      const item = cloud.keychain[opt(args, "-s")];
      if (!item || (opt(args, "-a") && item.account !== opt(args, "-a"))) throw new CallFailed("security find-generic-password failed: exit 44", "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.");
      return tsv(item.password);
    }
    if (args[0] === "-i") {
      const parsed = /^add-generic-password -U -a (\S+) -s (\S+) -w "([^"]*)"\n$/.exec(input ?? "");
      if (!parsed) throw new CallFailed("security -i failed", "security: unparsed command");
      if (cloud.keychainWrite === "fail") throw new CallFailed("security -i failed: exit 1", "add-generic-password: returned -25308");
      cloud.keychain[parsed[2]] = { account: parsed[1], password: cloud.keychainWrite === "corrupt" ? `${parsed[3]}x` : parsed[3] };
      return { stdout: "" };
    }
    throw new CallFailed(`fake security has no ${args.join(" ")}`, "");
  }

  // fetch, for the admin app's token and its app-only Graph calls. Each is recorded in `calls` as cmd "fetch".
  const appToken = (claims) => ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2ln"].join(".");
  async function fetch(url, { method = "GET", headers = {}, body } = {}) {
    const isToken = url.startsWith("https://login.microsoftonline.com/");
    calls.push({ cmd: "fetch", args: [method, url], input: body, write: !isToken && method !== "GET" });
    const reply = (status, value) => new Response(value === null ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (isToken) {
      const tenant = url.split("/")[3];
      const form = new URLSearchParams(body);
      const app = cloud.graph.apps.find(({ appId }) => appId === form.get("client_id"));
      const sp = app && cloud.graph.sps.find(({ appId }) => appId === app.appId);
      if (tenant !== cloud.account.tenantId || !app || !sp) return reply(400, { error: "unauthorized_client", error_description: "AADSTS700016: Application not found in the directory." });
      const credential = app.passwordCredentials.find(({ secretText }) => secretText === form.get("client_secret"));
      if (!credential || (credential.endDateTime && Date.parse(credential.endDateTime) <= (cloud.now ?? 0))) return reply(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
      if (credential.pendingFor > 0) {
        credential.pendingFor -= 1;
        return reply(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
      }
      const roles = Object.entries(GRAPH_ROLES).filter(([, id]) => sp.appRoleAssignments.includes(id)).map(([name]) => name);
      return reply(200, { token_type: "Bearer", access_token: appToken({ tid: tenant, appid: app.appId, roles }) });
    }
    const bearer = /^Bearer (.+)$/.exec(headers.Authorization ?? "")?.[1];
    let claims = {};
    try {
      claims = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString("utf8"));
    } catch {
      return reply(401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } });
    }
    try {
      const answer = graph(method.toLowerCase(), url, body === undefined ? undefined : JSON.parse(body), { appId: claims.appid, roles: claims.roles ?? [] });
      return reply(answer === null ? 204 : 200, answer);
    } catch (error) {
      if (error instanceof GraphRefused) return reply(error.status, { error: { code: error.code, message: error.message } });
      if (error instanceof CallFailed && /not found/.test(error.message)) return reply(404, { error: { code: "Request_ResourceNotFound", message: error.message } });
      throw error;
    }
  }

  const WRITES = [
    /^rest --method (put|post|patch|delete)/i,
    /^ad (app|sp) (create|update)/,
    /^ad app (credential reset|credential delete|permission add|permission admin-consent|federated-credential create)/,
    /^keyvault secret (set|set-attributes|delete)/,
    /^identity (create|federated-credential create)/,
    /^role assignment create/,
    /^storage account (create|update)/,
    /^containerapp (update|create|revision restart|secret set)/,
    /^api -X (PUT|POST|PATCH|DELETE)/,
    /^variable set/,
    /^-i$/,
  ];

  async function runner(cmd, args, { input } = {}) {
    const joined = args.join(" ");
    // The name check is a POST that changes nothing.
    const write = cmd === "probe" || cmd === "opener" || joined.includes("/checkNameAvailability") ? false : WRITES.some((pattern) => pattern.test(joined));
    calls.push({ cmd, args: [...args], input, write });
    if (cmd === "az") return az(args, input);
    if (cmd === "gh") return gh(args, input);
    if (cmd === "security") return security(args, input);
    if (cmd === cloud.probeCommand) return cloud.probe?.(args) ?? { stdout: "ok\n" };
    if (cmd === cloud.openerCommand) return { stdout: "" };
    throw new CallFailed(`fake runner has no ${cmd}`, "");
  }
  return { runner, fetch, calls, cloud };
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// A Container App in the fake cloud: `shown` as az shows it, `secrets` its values.
export function addContainerApp(cloud, { name, shown, secrets, readYaml, logs = [] }) {
  cloud.containerApps[name] = { shown: structuredClone(shown), secrets: { ...secrets }, logs, updates: [], restarts: [], readYaml };
  return cloud.containerApps[name];
}
