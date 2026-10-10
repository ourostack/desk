// A recording fake of the az, gh and Graph calls provision-identity.mjs makes, over an in-memory cloud. Each call is
// kept in `calls` as { cmd, args, input, write }; `write` is this fake's own judgement of whether the call changes
// anything, independent of the script's, so a test can assert that a dry run or a reconciled rerun makes no write.
import { createHash } from "node:crypto";

export const SUB = "261e0bf1-934d-41ab-9295-229b0d254418";
export const TEST_TENANT = "c12edfb6-c5ab-4bf8-b1d5-1f053311d396";
export const AZURE_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const GRAPH = "https://graph.microsoft.com/v1.0/";
const VAULT_ID = `/subscriptions/${SUB}/resourceGroups/rg-ouro-identity/providers/Microsoft.KeyVault/vaults/kv-ouro-identity-261e0b`;

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
const notFound = (what) => {
  throw new CallFailed(`not found: ${what}`, `ERROR: (ResourceNotFound) ${what} was not found. HTTP 404`);
};

export function emptyCloud() {
  return {
    account: { tenantId: TEST_TENANT },
    ciam: { ourobottest: { tenantId: TEST_TENANT, domainName: "ourobottest.onmicrosoft.com" } },
    taken: new Set(["ouro", "ourotest"]),
    graph: { email: { state: "disabled", allowExternalIdToUseEmailOtp: "default" }, providers: [], flows: [], apps: [], sps: [] },
    vault: { secrets: {} },
    identities: {},
    roles: [],
    storage: {},
    containerApps: {},
    gh: { env: null, variables: {} },
    failKeyVaultWrites: false,
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

  function graph(method, url, body) {
    const path = url.slice(GRAPH.length);
    const g = cloud.graph;
    if (path === "policies/authenticationMethodsPolicy/authenticationMethodConfigurations/email") {
      if (method === "get") return g.email;
      Object.assign(g.email, { state: body.state, allowExternalIdToUseEmailOtp: body.allowExternalIdToUseEmailOtp });
      return {};
    }
    if (path === "identity/identityProviders") {
      if (method === "get") return { value: g.providers.map(({ certificateData, ...rest }) => rest) };
      const provider = { id: "Apple-Managed-OIDC", ...body };
      g.providers.push(provider);
      return provider;
    }
    if (path === "identity/authenticationEventsFlows") {
      if (method === "get") return { value: g.flows.map(({ apps, ...flow }) => flow) };
      const flow = { id: guid(), displayName: body.displayName, idps: body.onAuthenticationMethodLoadStart.identityProviders.map(({ id }) => id), apps: [] };
      g.flows.push(flow);
      return { id: flow.id, displayName: flow.displayName };
    }
    let match = path.match(/^identity\/authenticationEventsFlows\/([^/]+)\/conditions\/applications\/includeApplications$/);
    if (match) {
      const flow = g.flows.find(({ id }) => id === match[1]) ?? notFound(match[1]);
      if (method === "get") return { value: flow.apps.map((appId) => ({ appId })) };
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
    match = path.match(/^servicePrincipals\/([^/]+)\/appRoleAssignments$/);
    if (match) {
      const sp = g.sps.find(({ id }) => id === match[1]) ?? notFound(match[1]);
      return { value: sp.appRoleAssignments.map((appRoleId) => ({ appRoleId })) };
    }
    throw new CallFailed(`fake Graph has no ${method} ${path}`, "");
  }

  function az(args, input) {
    const joined = args.join(" ");
    const g = cloud.graph;
    if (joined.startsWith("account show")) return tsv(cloud.account.tenantId);
    if (args[0] === "rest") {
      const method = opt(args, "--method");
      const url = opt(args, "--url");
      const body = input ? JSON.parse(input) : undefined;
      if (url.startsWith(GRAPH)) return json(graph(method, url, body));
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
      const apps = g.apps.filter((app) => app.displayName === opt(args, "--display-name"));
      return json(apps.map((app) => ({ appId: app.appId, id: app.id, redirects: app.web.redirectUris, tokenVersion: app.api.requestedAccessTokenVersion, passwords: app.passwordCredentials.length, access: app.requiredResourceAccess })));
    }
    if (joined.startsWith("ad app create")) {
      const app = { appId: guid(), id: guid(), displayName: opt(args, "--display-name"), web: { redirectUris: [] }, api: { requestedAccessTokenVersion: null }, passwordCredentials: [], requiredResourceAccess: [], federated: [] };
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
      app.passwordCredentials.push({ keyId: guid() });
      cloud.lastGatewaySecret = password;
      return tsv(password);
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
      return tsv(g.sps.filter((sp) => sp.appId === appId).map(({ id }) => id).join("\n"));
    }
    if (joined.startsWith("ad sp create")) {
      g.sps.push({ id: guid(), appId: opt(args, "--id"), appRoleAssignments: [] });
      return { stdout: "" };
    }
    // Key Vault.
    if (joined.startsWith("keyvault show")) return tsv(VAULT_ID);
    if (joined.startsWith("keyvault secret list")) return tsv(Object.keys(cloud.vault.secrets).join("\n"));
    if (joined.startsWith("keyvault secret set")) {
      if (cloud.failKeyVaultWrites) throw new CallFailed("az keyvault secret set failed", "ERROR: Forbidden");
      const tags = {};
      const index = args.indexOf("--tags");
      if (index !== -1) for (let i = index + 1; i < args.length && !args[i].startsWith("--"); i += 1) tags[args[i].split("=")[0]] = args[i].split("=")[1];
      if (cloud.corruptKeyVaultWrites) input = `${input}x`;
      cloud.vault.secrets[opt(args, "--name")] = { value: input, tags };
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
      cloud.roles.push({ principalId: opt(args, "--assignee-object-id"), role: opt(args, "--role"), scope: opt(args, "--scope") });
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
      if (joined.startsWith("containerapp secret list")) {
        return tsv(app.shown.properties.configuration.secrets.filter(({ name: secretName }) => secretName === "entra-client-secret").map(({ keyVaultUrl }) => keyVaultUrl ?? "").join("\n"));
      }
      if (joined.startsWith("containerapp logs show")) return { stdout: app.logs.filter((line) => line.revision === opt(args, "--revision")).map(({ text }) => text).join("\n") };
      if (joined.startsWith("containerapp update")) {
        const document = JSON.parse(app.readYaml(opt(args, "--yaml")));
        app.updates.push(structuredClone(document));
        for (const secret of document.properties.configuration.secrets) if ("value" in secret) app.secrets[secret.name] = secret.value;
        document.properties.configuration.secrets = document.properties.configuration.secrets.map(({ value, ...rest }) => rest);
        app.shown = document;
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
    if (joined.startsWith("variable list")) return json(Object.entries(cloud.gh.variables).map(([name, value]) => ({ name, value })));
    if (joined.startsWith("variable set")) {
      cloud.gh.variables[args[2]] = opt(args, "--body");
      return { stdout: "" };
    }
    throw new CallFailed(`fake gh has no ${joined}`, "");
  }

  const WRITES = [
    /^rest --method (put|post|patch|delete)/i,
    /^ad (app|sp) (create|update)/,
    /^ad app (credential reset|permission add|permission admin-consent|federated-credential create)/,
    /^keyvault secret (set|set-attributes|delete)/,
    /^identity (create|federated-credential create)/,
    /^role assignment create/,
    /^storage account (create|update)/,
    /^containerapp (update|create|revision restart|secret set)/,
    /^api -X (PUT|POST|PATCH|DELETE)/,
    /^variable set/,
  ];

  async function runner(cmd, args, { input } = {}) {
    const joined = args.join(" ");
    // The name check is a POST that changes nothing.
    const write = cmd === "probe" || cmd === "opener" || joined.includes("/checkNameAvailability") ? false : WRITES.some((pattern) => pattern.test(joined));
    calls.push({ cmd, args: [...args], input, write });
    if (cmd === "az") return az(args, input);
    if (cmd === "gh") return gh(args, input);
    if (cmd === cloud.probeCommand) return cloud.probe?.(args) ?? { stdout: "ok\n" };
    if (cmd === cloud.openerCommand) return { stdout: "" };
    throw new CallFailed(`fake runner has no ${cmd}`, "");
  }
  return { runner, calls, cloud };
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// A Container App in the fake cloud: `shown` as az shows it, `secrets` its values.
export function addContainerApp(cloud, { name, shown, secrets, readYaml, logs = [] }) {
  cloud.containerApps[name] = { shown: structuredClone(shown), secrets: { ...secrets }, logs, updates: [], restarts: [], readYaml };
  return cloud.containerApps[name];
}
