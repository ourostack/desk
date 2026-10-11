// provision.sh, run with a fake az (fixtures/fake-az.mjs) and dig on PATH. Every write to the Container App must go
// through app-yaml.mjs from the shown app, so a rerun keeps every secret, env var, volume, probe, identity and
// registry (Task 3 review I1), and no secret value is ever an argument.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../infra/provision.sh", import.meta.url));
const fakeAz = fileURLToPath(new URL("./fixtures/fake-az.mjs", import.meta.url));
const shown = JSON.parse(readFileSync(new URL("./fixtures/containerapp-shown.json", import.meta.url), "utf8"));
const STAGING_URL = "https://ouro-desk-hosted-staging.blueflower-44af4710.eastus2.azurecontainerapps.io";
const GATEWAY_IDENTITY = "/subscriptions/261e0bf1-934d-41ab-9295-229b0d254418/resourceGroups/rg-ouro-identity/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-ouro-desk-hosted-staging";

// Dates relative to today, so the record stays valid as time passes: released yesterday, cutoff 14 days after.
const DAY = 24 * 3600 * 1000;
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const RELEASED_AT = isoSeconds(Math.floor(Date.now() / 1000) * 1000 - DAY);
const LEGACY_CUTOFF = isoSeconds(Date.parse(RELEASED_AT) + 14 * DAY);

export const completeRecord = (env = "test") => ({
  env,
  tenant: { name: "ourobottest", subdomain: "ourobottest", id: "c12edfb6-c5ab-4bf8-b1d5-1f053311d396", domain: "ourobottest.onmicrosoft.com" },
  gatewayApp: { appId: "55555555-5555-5555-5555-555555555555", objectId: "66666666-6666-6666-6666-666666666666" },
  storage: { account: "stouroacctstest261e0b", endpoint: "https://stouroacctstest261e0b.table.core.windows.net" },
  gatewayIdentity: { name: "id-ouro-desk-hosted-staging", id: GATEWAY_IDENTITY, clientId: "33333333-3333-3333-3333-333333333333", principalId: "44444444-4444-4444-4444-444444444444" },
  ari: { accountId: "acct-ari-test", githubUserId: 16390116, githubLogin: "arimendelow" },
  legacyCutoff: LEGACY_CUTOFF,
  releasedAt: RELEASED_AT,
});

function runProvision(t, { app, env = {}, record, created, expectFailure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "desk-provision-sh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A wrapper, so the fake loads its model from the fixtures folder.
  writeFileSync(join(dir, "az"), `#!/bin/sh\nexec "${process.execPath}" "${fakeAz}" "$@"\n`);
  chmodSync(join(dir, "az"), 0o755);
  writeFileSync(join(dir, "dig"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "dig"), 0o755);
  if (app) writeFileSync(join(dir, "app.json"), JSON.stringify(app));
  if (created) writeFileSync(join(dir, "created.json"), JSON.stringify(created));
  const identityDir = join(dir, "identity");
  execFileSync("mkdir", [identityDir]);
  if (record) writeFileSync(join(identityDir, `identity-${record.env}.json`), JSON.stringify(record));
  const result = spawnSync("bash", [script], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, FAKE_AZ_DIR: dir, IDENTITY_DIR: identityDir, ...(created ? { FAKE_CREATED_APP: join(dir, "created.json") } : {}), ...env },
    encoding: "utf8",
  });
  if (expectFailure) assert.notEqual(result.status, 0, "provision.sh should have failed");
  else assert.equal(result.status, 0, result.stderr);
  // Both streams: a secret must appear in neither.
  const output = `${result.stdout}${result.stderr}`;
  // A script that stops before its first az call leaves no log.
  const argv = existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const updatesDir = join(dir, "updates");
  const documents = existsSync(updatesDir)
    ? readdirSync(updatesDir).sort((a, b) => parseInt(a) - parseInt(b)).map((name) => readFileSync(join(updatesDir, name), "utf8"))
    : [];
  const final = existsSync(join(dir, "app.json")) ? JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) : null;
  return { output, argv, documents, final };
}

const envOf = (app) => app.properties.template.containers[0].env;
const secretsOf = (app) => app.properties.configuration.secrets;
const HEX64 = /[0-9a-f]{64}/;

test("provision.sh's missing-secret path no longer passes a value in argv", (t) => {
  const app = structuredClone(shown);
  app.properties.configuration.secrets = secretsOf(app).filter((secret) => !["desk-signing-key", "desk-app-key"].includes(secret.name));
  app.properties.template.volumes = [];
  const { argv, documents, output } = runProvision(t, { app, env: { STAGE: "staging" } });
  assert.ok(!argv.some((args) => args.includes("secret") && args.includes("set")), "no az containerapp secret set");
  for (const args of argv) for (const arg of args) assert.ok(!HEX64.test(arg) && !/=unset$/.test(arg), `argument ${arg}`);
  assert.equal(documents.length, 1);
  const written = JSON.parse(documents[0]);
  assert.match(secretsOf(written).find((secret) => secret.name === "desk-signing-key").value, /^[0-9a-f]{64}$/);
  assert.equal(secretsOf(written).find((secret) => secret.name === "desk-app-key").value, "unset");
  assert.ok(!HEX64.test(output));
});

test("a rerun after the client-key migration and a rotation keeps the client key, the previous key and every other secret, env var, volume, probe, identity and registry", (t) => {
  const { documents } = runProvision(t, { app: shown, env: { STAGE: "staging" } });
  assert.equal(documents.length, 1);
  const written = JSON.parse(documents[0]);
  for (const entry of envOf(shown)) assert.deepEqual(envOf(written).find((candidate) => candidate.name === entry.name), entry, entry.name);
  assert.deepEqual(secretsOf(written), secretsOf(shown), "names only, the Key Vault reference intact, no value");
  assert.deepEqual(written.properties.template.volumes, shown.properties.template.volumes);
  assert.deepEqual(written.properties.template.containers[0].probes, shown.properties.template.containers[0].probes);
  assert.deepEqual(written.identity, shown.identity);
  assert.deepEqual(written.properties.configuration.registries, shown.properties.configuration.registries);
  assert.deepEqual(written.properties.configuration.ingress.customDomains, shown.properties.configuration.ingress.customDomains);
  assert.deepEqual(written.properties.template.scale, shown.properties.template.scale);
});

test("a production rerun keeps the app's public URL and redirects unless they are passed, and an empty DESK_REDIRECTS clears them", (t) => {
  const app = structuredClone(shown);
  app.name = "ouro-desk-hosted";
  envOf(app)[0].value = "https://desk.ouro.bot";
  envOf(app).push({ name: "DESK_REDIRECTS", value: "https://claude.ai/api/mcp/auth_callback" });
  envOf(app).find((entry) => entry.name === "DESK_REPO").value = "arimendelow/desk";
  const kept = JSON.parse(runProvision(t, { app }).documents[0]);
  assert.equal(envOf(kept).find((entry) => entry.name === "DESK_PUBLIC_URL").value, "https://desk.ouro.bot");
  assert.equal(envOf(kept).find((entry) => entry.name === "DESK_REDIRECTS").value, "https://claude.ai/api/mcp/auth_callback");
  assert.equal(envOf(kept).find((entry) => entry.name === "DESK_REPO").value, "arimendelow/desk");
  const cleared = JSON.parse(runProvision(t, { app, env: { DESK_REDIRECTS: "" } }).documents[0]);
  assert.ok(!envOf(cleared).some((entry) => entry.name === "DESK_REDIRECTS"));
});

test("STAGE=staging creates ouro-desk-hosted-staging on the pinned image, scaling to zero at 1 vCPU / 2 GiB, with its own URL and the rehearsal desk, and no domain or deploy credential", (t) => {
  const { argv, documents, output } = runProvision(t, { env: { STAGE: "staging", IMAGE: "abc123" } });
  assert.equal(documents.length, 1);
  const spec = documents[0];
  assert.match(spec, /^name: ouro-desk-hosted-staging$/m);
  assert.match(spec, /image: ouroworkprodk2aumligevt3e\.azurecr\.io\/ouro-desk-hosted:abc123$/m);
  assert.match(spec, /minReplicas: 0\n\s+maxReplicas: 1/);
  assert.match(spec, /cpu: 1\.0\n\s+memory: 2Gi/);
  assert.match(spec, new RegExp(`name: DESK_PUBLIC_URL\\n\\s+value: ${STAGING_URL.replaceAll(".", "\\.")}`));
  assert.match(spec, /name: DESK_REPO\n\s+value: arimendelow\/desk-rehearsal/);
  assert.match(spec, /name: DESK_ALLOWED_LOGINS\n\s+value: arimendelow/);
  assert.ok(!argv.some((args) => args[0] === "acr" && args[1] === "build"), "the pinned image is not rebuilt");
  assert.ok(!argv.some((args) => args.includes("hostname")), "no custom domain");
  assert.ok(!argv.some((args) => args.includes("federated-credential")), "no deploy credential");
  assert.ok(!output.includes("gh variable set"), "no deploy variables for staging");
});

test("the Ouro settings come from identity-<env>.json with the names readConfig reads, and DESK_ALLOWED_LOGINS stays", (t) => {
  const { documents } = runProvision(t, { app: shown, env: { STAGE: "staging" }, record: completeRecord("test") });
  const written = JSON.parse(documents[0]);
  const value = (name) => envOf(written).find((entry) => entry.name === name);
  assert.equal(value("DESK_ENTRA_TENANT_ID").value, "c12edfb6-c5ab-4bf8-b1d5-1f053311d396");
  assert.equal(value("DESK_ENTRA_SUBDOMAIN").value, "ourobottest");
  assert.equal(value("DESK_ENTRA_CLIENT_ID").value, "55555555-5555-5555-5555-555555555555");
  assert.deepEqual(value("DESK_ENTRA_CLIENT_SECRET"), { name: "DESK_ENTRA_CLIENT_SECRET", secretRef: "entra-client-secret" });
  assert.equal(value("DESK_ACCOUNTS_ENDPOINT").value, "https://stouroacctstest261e0b.table.core.windows.net");
  assert.equal(value("AZURE_CLIENT_ID").value, "33333333-3333-3333-3333-333333333333");
  assert.equal(value("DESK_GITHUB_SIGNIN").value, "on");
  assert.equal(value("DESK_GITHUB_ACCOUNTS").value, "16390116=acct-ari-test");
  assert.equal(value("DESK_GITHUB_LOGINS").value, "16390116=arimendelow");
  assert.equal(value("DESK_LEGACY_CUTOFF").value, LEGACY_CUTOFF);
  assert.equal(value("DESK_ALLOWED_LOGINS").value, "arimendelow");
  assert.deepEqual(value("DESK_CLIENT_KEY"), { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" });
  assert.deepEqual(secretsOf(written).find((secret) => secret.name === "entra-client-secret"), {
    name: "entra-client-secret",
    keyVaultUrl: "https://kv-ouro-identity-261e0b.vault.azure.net/secrets/entra-client-secret-test",
    identity: GATEWAY_IDENTITY,
  });
  assert.ok(GATEWAY_IDENTITY in written.identity.userAssignedIdentities);
});

test("the Entra client secret reference is added to an app that doesn't have it yet, through the gateway identity", (t) => {
  const app = structuredClone(shown);
  app.properties.configuration.secrets = secretsOf(app).filter((secret) => secret.name !== "entra-client-secret");
  app.properties.template.containers[0].env = envOf(app).filter((entry) => entry.name !== "DESK_ENTRA_CLIENT_SECRET");
  delete app.identity.userAssignedIdentities[GATEWAY_IDENTITY];
  const { documents } = runProvision(t, { app, env: { STAGE: "staging" }, record: completeRecord("test") });
  const written = JSON.parse(documents[0]);
  const reference = secretsOf(written).find((secret) => secret.name === "entra-client-secret");
  assert.equal(reference.identity, GATEWAY_IDENTITY);
  assert.ok(!("value" in reference));
  assert.ok(GATEWAY_IDENTITY in written.identity.userAssignedIdentities);
});

test("the gateway identity is attached with az containerapp identity assign before the update that references it, because az drops the identity map from the update", (t) => {
  const app = structuredClone(shown);
  app.properties.configuration.secrets = secretsOf(app).filter((secret) => secret.name !== "entra-client-secret");
  app.properties.template.containers[0].env = envOf(app).filter((entry) => entry.name !== "DESK_ENTRA_CLIENT_SECRET");
  delete app.identity.userAssignedIdentities[GATEWAY_IDENTITY];
  const { argv, final } = runProvision(t, { app, env: { STAGE: "staging" }, record: completeRecord("test") });
  const assign = argv.findIndex((args) => args.slice(0, 3).join(" ") === "containerapp identity assign");
  const update = argv.findIndex((args) => args.slice(0, 2).join(" ") === "containerapp update");
  assert.ok(assign !== -1 && assign < update, "assign runs before the update");
  assert.equal(argv[assign][argv[assign].indexOf("--user-assigned") + 1], GATEWAY_IDENTITY);
  // What the app holds after az's pipeline and ARM's PATCH: the identity (from the assign) and the reference.
  assert.ok(GATEWAY_IDENTITY in final.identity.userAssignedIdentities);
  assert.ok(secretsOf(final).find((secret) => secret.name === "entra-client-secret").keyVaultUrl);
  // A second run attaches nothing more.
  const again = runProvision(t, { app: final, env: { STAGE: "staging" }, record: completeRecord("test") });
  assert.ok(!again.argv.some((args) => args.slice(0, 3).join(" ") === "containerapp identity assign"));
});

test("every update is checked afterwards: a Key Vault reference that comes back as a plain value stops the script", (t) => {
  const { output, argv } = runProvision(t, { app: shown, env: { STAGE: "staging", FAKE_RESOLVE_REFS: "1" }, expectFailure: true });
  assert.match(output, /entra-client-secret is no longer a Key Vault reference/);
  assert.ok(argv.some((args) => args.slice(0, 3).join(" ") === "containerapp secret list"));
  const clean = runProvision(t, { app: shown, env: { STAGE: "staging" } });
  assert.match(clean.output, /Checked: every secret, Key Vault reference and identity is still on the app/);
});

test("a created app gets its Ouro settings through the same assign, update and check", (t) => {
  const created = structuredClone(shown);
  created.properties.configuration.secrets = secretsOf(created).filter((secret) => secret.name !== "entra-client-secret");
  created.properties.template.containers[0].env = envOf(created).filter((entry) => entry.name !== "DESK_ENTRA_CLIENT_SECRET");
  delete created.identity.userAssignedIdentities[GATEWAY_IDENTITY];
  const { argv, final, output } = runProvision(t, { env: { STAGE: "staging", IMAGE: "abc" }, record: completeRecord("test"), created });
  const steps = argv.map((args) => args.slice(0, 3).join(" ")).filter((step) => /containerapp (create|identity assign|update)/.test(step) || step.startsWith("containerapp update"));
  assert.deepEqual(steps.map((step) => step.split(" ").slice(0, 2).join(" ")), ["containerapp create", "containerapp identity", "containerapp update"]);
  assert.ok(GATEWAY_IDENTITY in final.identity.userAssignedIdentities);
  assert.match(output, /Checked:/);
});

test("an incomplete identity record sets no Ouro setting, and says which facts are missing", (t) => {
  const record = completeRecord("test");
  record.ari = null;
  const { documents, output } = runProvision(t, { app: shown, env: { STAGE: "staging" }, record });
  const written = JSON.parse(documents[0]);
  assert.deepEqual(envOf(written), envOf(shown));
  assert.match(output, /ari\.accountId/);
});

test("a dry run shows the document it would send with every secret value as ***, and writes nothing", (t) => {
  const app = structuredClone(shown);
  app.properties.configuration.secrets = secretsOf(app).filter((secret) => secret.name !== "desk-signing-key");
  const { argv, documents, output } = runProvision(t, { app, env: { STAGE: "staging", DRY_RUN: "1" } });
  assert.equal(documents.length, 0);
  assert.ok(!argv.some((args) => args.includes("update") || args.includes("create")));
  assert.match(output, /"name": "desk-signing-key",\n\s+\| +"value": "\*\*\*"/);
  assert.ok(!HEX64.test(output));
});

// --- Fix round 2: staging never holds production's pull identity (re-review N-I1) -------------------------------

const PROD_PULL = "ouro-prod-services-mi";
const REGISTRY_ID = "/subscriptions/261e0bf1-934d-41ab-9295-229b0d254418/resourceGroups/rg-ouro-work-substrate/providers/Microsoft.ContainerRegistry/registries/ouroworkprodk2aumligevt3e";
const names = (argv, text) => argv.some((args) => args.some((arg) => arg.includes(text)));
const grants = (argv) => argv.filter((args) => args.slice(0, 3).join(" ") === "role assignment create");

test("STAGE=staging never names ouro-prod-services-mi: it pulls images with its own identity, already holding AcrPull, and grants nothing", (t) => {
  const { argv, documents, output } = runProvision(t, { env: { STAGE: "staging", IMAGE: "abc123" } });
  assert.ok(!names(argv, PROD_PULL), "no az call names production's pull identity");
  assert.ok(!output.includes(PROD_PULL));
  assert.ok(!documents[0].includes(PROD_PULL), "the template doesn't name it");
  assert.match(documents[0], new RegExp(`registries:\\n\\s+- server: ouroworkprodk2aumligevt3e\\.azurecr\\.io\\n\\s+identity: ${GATEWAY_IDENTITY}$`, "m"));
  assert.match(documents[0], new RegExp(`userAssignedIdentities:\\n\\s+${GATEWAY_IDENTITY}: \\{\\}`));
  assert.deepEqual(grants(argv), [], "AcrPull is already held: read first, no write");
  assert.ok(argv.some((args) => args.slice(0, 3).join(" ") === "role assignment list" && args.includes(REGISTRY_ID) && args.includes("AcrPull")));
});

test("staging creates its own identity and grants it AcrPull on the registry only, before the app is created", (t) => {
  const { argv, documents } = runProvision(t, { env: { STAGE: "staging", IMAGE: "abc123", FAKE_NO_STAGING_IDENTITY: "1" } });
  const create = argv.findIndex((args) => args.slice(0, 2).join(" ") === "identity create");
  assert.deepEqual(argv[create].slice(0, 8), ["identity", "create", "-n", "id-ouro-desk-hosted-staging", "-g", "rg-ouro-identity", "-l", "eastus2"]);
  const [grant] = grants(argv);
  assert.equal(grants(argv).length, 1);
  const opt = (flag) => grant[grant.indexOf(flag) + 1];
  assert.equal(opt("--role"), "AcrPull");
  assert.equal(opt("--scope"), REGISTRY_ID);
  assert.equal(opt("--assignee-principal-type"), "ServicePrincipal");
  assert.equal(opt("--assignee-object-id"), "99999999-0000-4000-8000-000000000099");
  const appCreate = argv.findIndex((args) => args.slice(0, 2).join(" ") === "containerapp create");
  assert.ok(create < argv.indexOf(grant) && argv.indexOf(grant) < appCreate);
  assert.ok(!names(argv, PROD_PULL));
  assert.ok(!documents[0].includes(PROD_PULL));
  // An identity that exists without the role gets only the grant.
  const again = runProvision(t, { env: { STAGE: "staging", IMAGE: "abc123", FAKE_NO_ACRPULL: "1" } });
  assert.ok(!again.argv.some((args) => args.slice(0, 2).join(" ") === "identity create"));
  assert.equal(grants(again.argv).length, 1);
});

test("a staging dry run prints the identity and AcrPull grant it would make, and writes nothing", (t) => {
  const { argv, output } = runProvision(t, { env: { STAGE: "staging", IMAGE: "abc123", DRY_RUN: "1", FAKE_NO_STAGING_IDENTITY: "1" } });
  assert.ok(!argv.some((args) => /^(identity create|role assignment create|containerapp create)/.test(args.join(" "))));
  assert.match(output, /would run: az identity create -n id-ouro-desk-hosted-staging -g rg-ouro-identity/);
  assert.match(output, /would run: az role assignment create --assignee-object-id <id-ouro-desk-hosted-staging principal id> --assignee-principal-type ServicePrincipal --role AcrPull --scope \/subscriptions\/.*\/registries\/ouroworkprodk2aumligevt3e/);
  assert.ok(!output.includes(PROD_PULL));
});

test("production keeps pulling with ouro-prod-services-mi and makes no identity or role write", (t) => {
  const { argv, documents } = runProvision(t, { env: { IMAGE: "abc123" } });
  assert.match(documents[0], /registries:\n\s+- server: ouroworkprodk2aumligevt3e\.azurecr\.io\n\s+identity: \/subscriptions\/.*\/rg-ouro-work-substrate\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/ouro-prod-services-mi$/m);
  assert.ok(!argv.some((args) => /^(identity create|role assignment create)/.test(args.join(" "))));
  assert.ok(!names(argv, "id-ouro-desk-hosted-staging"));
});

test("a staging app that holds production's pull identity is refused before any write, and the check after a write refuses it too", (t) => {
  const app = structuredClone(shown);
  const prodId = `/subscriptions/261e0bf1-934d-41ab-9295-229b0d254418/resourceGroups/rg-ouro-work-substrate/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${PROD_PULL}`;
  app.identity.userAssignedIdentities[prodId] = { clientId: "c", principalId: "p" };
  const held = runProvision(t, { app, env: { STAGE: "staging" }, expectFailure: true });
  assert.match(held.output, /ouro-prod-services-mi/);
  assert.match(held.output, /must not hold/);
  assert.equal(held.documents.length, 0, "nothing was sent");
  const registry = structuredClone(shown);
  registry.properties.configuration.registries[0].identity = prodId;
  const pulled = runProvision(t, { app: registry, env: { STAGE: "staging" }, expectFailure: true });
  assert.match(pulled.output, /must not hold/);
  assert.equal(pulled.documents.length, 0);
});

// --- Fix round 2: re-review minors ------------------------------------------------------------------------------

test("when listSecrets returns a Key Vault reference without a value, az's KeyError becomes a clear message and nothing changes (N-m1)", (t) => {
  const { output, final } = runProvision(t, { app: shown, env: { STAGE: "staging", FAKE_REFS_WITHOUT_VALUE: "1" }, expectFailure: true });
  assert.match(output, /listSecrets returned a Key Vault reference without a value/);
  assert.match(output, /none of this update's changes reached the app\. Nothing else was sent to the app before it in this step\./);
  assert.ok(!/the app is unchanged/.test(output));
  assert.ok(!output.includes("Traceback"), "az's traceback is not passed through");
  assert.deepEqual(final, shown);
});

test("after an identity attach, the KeyError message says the attach was already sent and stays (Task 2 re-review Minor)", async (t) => {
  const app = structuredClone(shown);
  delete app.identity.userAssignedIdentities[GATEWAY_IDENTITY];
  const { output } = runProvision(t, { app, env: { STAGE: "staging", FAKE_REFS_WITHOUT_VALUE: "1" }, record: completeRecord("test"), expectFailure: true });
  const { keyVaultFillFailure } = await import("../infra/app-yaml.mjs");
  assert.ok(output.includes(keyVaultFillFailure({ sentBefore: [`the identity attach of ${GATEWAY_IDENTITY.split("/").at(-1)}`] })), output);
  assert.ok(!/Nothing else was sent/.test(output));
  assert.ok(!/the app is unchanged/.test(output));
});

test("the check after the update compares with the app as it was before the identity assign, which rewrites the secrets (N-m2)", (t) => {
  const app = structuredClone(shown);
  secretsOf(app).push({ name: "kept-by-hand" });
  delete app.identity.userAssignedIdentities[GATEWAY_IDENTITY];
  const { output } = runProvision(t, { app, env: { STAGE: "staging", FAKE_ASSIGN_DROPS_SECRET: "kept-by-hand" }, record: completeRecord("test"), expectFailure: true });
  assert.match(output, /Secret kept-by-hand is gone from the app after the write/);
});

test("provision.sh's identity names and KeyError message match identity-record.mjs and app-yaml.mjs", async () => {
  const { GATEWAY_IDENTITIES, PROD_PULL_IDENTITY } = await import("../infra/identity-record.mjs");
  const { KEY_VAULT_FILL_FAILURE, KEY_VAULT_FILL_NOT_SENT, KEY_VAULT_FILL_NOTHING_BEFORE, KEY_VAULT_FILL_SENT_BEFORE, KEY_VAULT_FILL_NEXT } = await import("../infra/app-yaml.mjs");
  const text = readFileSync(script, "utf8");
  assert.match(text, new RegExp(`^PROD_PULL_IDENTITY=${PROD_PULL_IDENTITY}$`, "m"));
  assert.match(text, new RegExp(`PULL_IDENTITY=${GATEWAY_IDENTITIES.test} PULL_IDENTITY_GROUP=rg-ouro-identity`));
  for (const part of [KEY_VAULT_FILL_FAILURE, KEY_VAULT_FILL_NOT_SENT, KEY_VAULT_FILL_NOTHING_BEFORE, KEY_VAULT_FILL_SENT_BEFORE, KEY_VAULT_FILL_NEXT]) assert.ok(text.includes(part), part);
});

test("the check after a staging update refuses an app that came back pulling with production's identity", (t) => {
  const prodId = `/subscriptions/261e0bf1-934d-41ab-9295-229b0d254418/resourceGroups/rg-ouro-work-substrate/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${PROD_PULL}`;
  const { output } = runProvision(t, { app: shown, env: { STAGE: "staging", FAKE_UPDATE_REGISTRY_IDENTITY: prodId }, expectFailure: true });
  assert.match(output, /must not hold identity ouro-prod-services-mi after the write/);
  const other = runProvision(t, { app: shown, env: { STAGE: "staging", FAKE_UPDATE_REGISTRY_IDENTITY: "/subscriptions/s/resourceGroups/r/providers/Microsoft.ManagedIdentity/userAssignedIdentities/someone-else" }, expectFailure: true });
  assert.match(other.output, /pulls from ouroworkprodk2aumligevt3e\.azurecr\.io with someone-else, not id-ouro-desk-hosted-staging/);
});

// Combined fix round: bad settings never pass silently, DESK_GITHUB_SIGNIN keeps its value, and the script waits for
// the revision its update made.
const updates = (argv) => argv.filter((args) => args.slice(0, 2).join(" ") === "containerapp update");

test("combined round: a legacy cutoff without a zone, not after releasedAt, or newly set in the past is refused before any update", (t) => {
  const cases = {
    "no zone": { legacyCutoff: LEGACY_CUTOFF.replace("Z", "") },
    "not a time": { legacyCutoff: "next tuesday" },
    "before releasedAt": { legacyCutoff: isoSeconds(Date.parse(RELEASED_AT) - DAY) },
    "equal to releasedAt": { legacyCutoff: RELEASED_AT },
    "releasedAt without a zone": { releasedAt: RELEASED_AT.replace("Z", "") },
    "newly set in the past": { releasedAt: isoSeconds(Date.now() - 30 * DAY), legacyCutoff: isoSeconds(Date.now() - 16 * DAY) },
  };
  for (const [name, change] of Object.entries(cases)) {
    const { argv, output } = runProvision(t, { app: shown, env: { STAGE: "staging" }, record: { ...completeRecord("test"), ...change }, expectFailure: true });
    assert.deepEqual(updates(argv), [], name);
    assert.match(output, /legacyCutoff|releasedAt|DESK_LEGACY_CUTOFF/, name);
  }
});

test("combined round: a cutoff already on the app may be in the past, so a rerun after day 14 still works", (t) => {
  const past = isoSeconds(Date.now() - 16 * DAY);
  const app = structuredClone(shown);
  envOf(app).push({ name: "DESK_LEGACY_CUTOFF", value: past });
  const { documents } = runProvision(t, { app, env: { STAGE: "staging" }, record: { ...completeRecord("test"), releasedAt: isoSeconds(Date.now() - 30 * DAY), legacyCutoff: past } });
  assert.equal(envOf(JSON.parse(documents[0])).find(({ name }) => name === "DESK_LEGACY_CUTOFF").value, past);
});

test("combined round: other Ouro settings the gateway would refuse stop the script before any update", (t) => {
  const cases = {
    "tenant id": (record) => { record.tenant.id = "ourobottest"; },
    "gateway app id": (record) => { record.gatewayApp.appId = "not-a-guid"; },
    "GitHub login": (record) => { record.ari.githubLogin = "ari mendelow"; },
    "account id": (record) => { record.ari.accountId = "acct/ari"; },
    "GitHub user id": (record) => { record.ari.githubUserId = "ari"; },
    "accounts endpoint": (record) => { record.storage.endpoint = "http://stouroacctstest261e0b.table.core.windows.net"; },
    "subdomain": (record) => { record.tenant.subdomain = "ourobot test"; },
    "gateway identity client id": (record) => { record.gatewayIdentity.clientId = "id-ouro"; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const record = completeRecord("test");
    change(record);
    const { argv } = runProvision(t, { app: shown, env: { STAGE: "staging" }, record, expectFailure: true });
    assert.deepEqual(updates(argv), [], name);
  }
});

test("combined round: DESK_GITHUB_SIGNIN keeps the app's value unless it is passed, and only on or off is accepted", (t) => {
  const app = structuredClone(shown);
  envOf(app).push({ name: "DESK_GITHUB_SIGNIN", value: "off" });
  const signIn = (written) => envOf(JSON.parse(written)).find(({ name }) => name === "DESK_GITHUB_SIGNIN")?.value;
  assert.equal(signIn(runProvision(t, { app, env: { STAGE: "staging" }, record: completeRecord("test") }).documents[0]), "off");
  assert.equal(signIn(runProvision(t, { app, env: { STAGE: "staging", DESK_GITHUB_SIGNIN: "on" }, record: completeRecord("test") }).documents[0]), "on");
  const turnedOn = structuredClone(shown);
  assert.equal(signIn(runProvision(t, { app: turnedOn, env: { STAGE: "staging" }, record: completeRecord("test") }).documents[0]), "on", "first turn-on defaults to on");
  assert.equal(signIn(runProvision(t, { app: turnedOn, env: { STAGE: "staging", DESK_GITHUB_SIGNIN: "off" }, record: completeRecord("test") }).documents[0]), "off");
  const bad = runProvision(t, { app, env: { STAGE: "staging", DESK_GITHUB_SIGNIN: "yes" }, record: completeRecord("test"), expectFailure: true });
  assert.deepEqual(updates(bad.argv), []);
  assert.match(bad.output, /DESK_GITHUB_SIGNIN must be on or off/);
});

test("combined round: after an update the script waits until the new revision is the ready one, and fails if it fails or never gets there", (t) => {
  const ready = runProvision(t, { app: shown, env: { STAGE: "staging" }, record: completeRecord("test") });
  assert.match(ready.output, /Revision \S+ is ready/);
  const later = runProvision(t, { app: shown, env: { STAGE: "staging", FAKE_READY_AFTER_POLLS: "2", READY_POLL_SECONDS: "0" }, record: completeRecord("test") });
  assert.match(later.output, /Revision \S+ is ready/);
  assert.ok(later.argv.filter((args) => args.includes("properties.latestReadyRevisionName")).length >= 2, "it polled until ready");
  const failed = runProvision(t, { app: shown, env: { STAGE: "staging", FAKE_REVISION_STATE: "Failed", READY_POLL_SECONDS: "0" }, record: completeRecord("test"), expectFailure: true });
  assert.match(failed.output, /did not start/);
  const stuck = runProvision(t, { app: shown, env: { STAGE: "staging", FAKE_READY_AFTER_POLLS: "1000", READY_POLL_SECONDS: "0", READY_TIMEOUT_SECONDS: "0" }, record: completeRecord("test"), expectFailure: true });
  assert.match(stuck.output, /was not ready/);
});
