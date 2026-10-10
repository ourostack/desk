// provision.sh, run with a fake az (fixtures/fake-az.mjs) and dig on PATH. Every write to the Container App must go
// through app-yaml.mjs from the shown app, so a rerun keeps every secret, env var, volume, probe, identity and
// registry (Task 3 review I1), and no secret value is ever an argument.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../infra/provision.sh", import.meta.url));
const fakeAz = fileURLToPath(new URL("./fixtures/fake-az.mjs", import.meta.url));
const shown = JSON.parse(readFileSync(new URL("./fixtures/containerapp-shown.json", import.meta.url), "utf8"));
const STAGING_URL = "https://ouro-desk-hosted-staging.blueflower-44af4710.eastus2.azurecontainerapps.io";
const GATEWAY_IDENTITY = "/subscriptions/261e0bf1-934d-41ab-9295-229b0d254418/resourceGroups/rg-ouro-identity/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-ouro-desk-hosted";

export const completeRecord = (env = "test") => ({
  env,
  tenant: { name: "ourobottest", subdomain: "ourobottest", id: "c12edfb6-c5ab-4bf8-b1d5-1f053311d396", domain: "ourobottest.onmicrosoft.com" },
  gatewayApp: { appId: "55555555-5555-5555-5555-555555555555", objectId: "66666666-6666-6666-6666-666666666666" },
  storage: { account: "stouroacctstest261e0b", endpoint: "https://stouroacctstest261e0b.table.core.windows.net" },
  gatewayIdentity: { name: "id-ouro-desk-hosted", id: GATEWAY_IDENTITY, clientId: "33333333-3333-3333-3333-333333333333", principalId: "44444444-4444-4444-4444-444444444444" },
  ari: { accountId: "acct-ari-test", githubUserId: 16390116, githubLogin: "arimendelow" },
  legacyCutoff: "2026-11-15T00:00:00Z",
  releasedAt: "2026-11-01T00:00:00Z",
});

function runProvision(t, { app, env = {}, record } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "desk-provision-sh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(fakeAz, join(dir, "az"));
  chmodSync(join(dir, "az"), 0o755);
  writeFileSync(join(dir, "dig"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "dig"), 0o755);
  if (app) writeFileSync(join(dir, "app.json"), JSON.stringify(app));
  const identityDir = join(dir, "identity");
  execFileSync("mkdir", [identityDir]);
  if (record) writeFileSync(join(identityDir, `identity-${record.env}.json`), JSON.stringify(record));
  const result = spawnSync("bash", [script], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, FAKE_AZ_DIR: dir, IDENTITY_DIR: identityDir, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  // Both streams: a secret must appear in neither.
  const output = `${result.stdout}${result.stderr}`;
  const argv = readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const updatesDir = join(dir, "updates");
  const documents = existsSync(updatesDir)
    ? readdirSync(updatesDir).sort((a, b) => parseInt(a) - parseInt(b)).map((name) => readFileSync(join(updatesDir, name), "utf8"))
    : [];
  return { output, argv, documents };
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
  assert.equal(value("DESK_LEGACY_CUTOFF").value, "2026-11-15T00:00:00Z");
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
