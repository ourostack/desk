import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppYaml, parseShown, writeAppYaml } from "../infra/app-yaml.mjs";
import { rotationChanges, newestKeysLine, CLIENT_KEY_MIGRATION } from "../infra/signing-keys.mjs";
import { keysStartupLine, readConfig } from "../src/main.js";

const shownYaml = readFileSync(new URL("./fixtures/containerapp-shown.json", import.meta.url), "utf8");
const shown = JSON.parse(shownYaml);
const KV_IDENTITY = "/subscriptions/261e0bf1-934d-41ab-9295-229b0d254418/resourceGroups/rg-ouro-identity/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-ouro-desk-hosted-staging";
const SECRET = "c".repeat(64);

const built = (options = {}) => JSON.parse(buildAppYaml({ shownYaml, ...options }));
const envOf = (app) => app.properties.template.containers[0].env;
const secretsOf = (app) => app.properties.configuration.secrets;
const strip = (app) => {
  // Everything except the parts a change may touch.
  const copy = structuredClone(app);
  delete copy.properties.configuration.secrets;
  delete copy.properties.template.containers[0].env;
  return copy;
};

test("every existing secret name, env var, volume, probe, identity and registry survives", () => {
  const app = built({ setSecrets: { "desk-app-id": "12345" }, setEnv: { DESK_LEGACY_CUTOFF: "2026-11-15T00:00:00Z" } });
  assert.deepEqual(
    secretsOf(app).map((secret) => secret.name),
    shown.properties.configuration.secrets.map((secret) => secret.name),
  );
  for (const entry of envOf(shown)) assert.deepEqual(envOf(app).find((candidate) => candidate.name === entry.name), entry, entry.name);
  assert.deepEqual(app.properties.template.volumes, shown.properties.template.volumes);
  assert.deepEqual(app.properties.template.containers[0].probes, shown.properties.template.containers[0].probes);
  assert.deepEqual(app.properties.template.containers[0].volumeMounts, shown.properties.template.containers[0].volumeMounts);
  assert.deepEqual(app.identity, shown.identity);
  assert.deepEqual(app.properties.configuration.registries, shown.properties.configuration.registries);
  assert.deepEqual(app.properties.configuration.ingress, shown.properties.configuration.ingress);
  assert.deepEqual(app.properties.template.scale, shown.properties.template.scale);
  assert.equal(app.properties.template.containers[0].image, shown.properties.template.containers[0].image);
});

test("a Key Vault reference secret keeps keyVaultUrl and identity and gains no value", () => {
  const app = built({ setSecrets: { "desk-signing-key": SECRET } });
  const reference = secretsOf(app).find((secret) => secret.name === "entra-client-secret");
  assert.deepEqual(reference, {
    name: "entra-client-secret",
    keyVaultUrl: "https://kv-ouro-identity-261e0b.vault.azure.net/secrets/entra-client-secret-test",
    identity: KV_IDENTITY,
  });
  // Giving a Key Vault reference a plain value would turn it into a Container App secret.
  assert.throws(() => built({ setSecrets: { "entra-client-secret": SECRET } }), /Key Vault reference/);
});

test("only the named secrets and env vars change", () => {
  const app = built({
    setSecrets: { "desk-app-id": "12345", "desk-new": "fresh" },
    setEnv: { DESK_REPO: "arimendelow/other", DESK_NEW: "x" },
    secretRefs: { DESK_NEW_SECRET: "desk-new" },
  });
  assert.deepEqual(strip(app), strip(shown));
  const changedSecrets = secretsOf(app).filter((secret) => "value" in secret);
  assert.deepEqual(changedSecrets, [
    { name: "desk-app-id", value: "12345" },
    { name: "desk-new", value: "fresh" },
  ]);
  const before = new Map(envOf(shown).map((entry) => [entry.name, entry]));
  const changedEnv = envOf(app).filter((entry) => JSON.stringify(before.get(entry.name)) !== JSON.stringify(entry));
  assert.deepEqual(changedEnv, [
    { name: "DESK_REPO", value: "arimendelow/other" },
    { name: "DESK_NEW", value: "x" },
    { name: "DESK_NEW_SECRET", secretRef: "desk-new" },
  ]);
  // An existing env var keeps its place in the list.
  assert.equal(envOf(app).findIndex((entry) => entry.name === "DESK_REPO"), envOf(shown).findIndex((entry) => entry.name === "DESK_REPO"));
});

test("removeEnv drops only the named env vars, and a Key Vault reference and identity can be added", () => {
  const app = built({
    removeEnv: ["DESK_ALLOWED_LOGINS"],
    keyVaultSecrets: { "kv-new": { keyVaultUrl: "https://kv-ouro-identity-261e0b.vault.azure.net/secrets/x", identity: KV_IDENTITY } },
    addIdentities: ["/subscriptions/s/resourceGroups/r/providers/Microsoft.ManagedIdentity/userAssignedIdentities/new"],
  });
  assert.ok(!envOf(app).some((entry) => entry.name === "DESK_ALLOWED_LOGINS"));
  assert.equal(envOf(app).length, envOf(shown).length - 1);
  assert.deepEqual(secretsOf(app).at(-1), { name: "kv-new", keyVaultUrl: "https://kv-ouro-identity-261e0b.vault.azure.net/secrets/x", identity: KV_IDENTITY });
  assert.deepEqual(Object.keys(app.identity.userAssignedIdentities).length, Object.keys(shown.identity.userAssignedIdentities).length + 1);
  assert.equal(app.identity.type, "UserAssigned");
});

test("Task 3's rotation changes, secretRefs included, apply through the builder without dropping the client key", () => {
  const revision = "ouro-desk-hosted-staging--0000003";
  const signing = "a".repeat(64);
  const line = keysStartupLine(readConfig({ DESK_SIGNING_KEY: signing, DESK_CLIENT_KEY: signing, CONTAINER_APP_REVISION: revision }));
  const changes = rotationChanges({ signingKey: signing, logged: newestKeysLine(line, { revision }), now: Date.parse("2026-11-01T00:00:00Z") });
  const app = built(changes);
  assert.deepEqual(envOf(app).find((entry) => entry.name === "DESK_SIGNING_KEY_PREVIOUS"), { name: "DESK_SIGNING_KEY_PREVIOUS", secretRef: "desk-signing-key-previous" });
  assert.deepEqual(envOf(app).find((entry) => entry.name === "DESK_CLIENT_KEY"), { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" });
  assert.equal(secretsOf(app).find((secret) => secret.name === "desk-signing-key-previous").value, signing);
  // The client-key migration's env shape is the same secretRefs contract.
  const migrated = built({ setSecrets: { [CLIENT_KEY_MIGRATION.secret]: signing }, secretRefs: CLIENT_KEY_MIGRATION.env });
  assert.deepEqual(envOf(migrated).find((entry) => entry.name === "DESK_CLIENT_KEY"), { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" });
});

test("a secretRef or volume naming a secret the app doesn't hold is refused", () => {
  assert.throws(() => built({ secretRefs: { DESK_X: "no-such-secret" } }), /no-such-secret/);
});

test("the shown app may be az's JSON or the same document as YAML-compatible JSON text, and nothing else", () => {
  assert.equal(parseShown(shownYaml).name, "ouro-desk-hosted-staging");
  assert.equal(parseShown(shown).name, "ouro-desk-hosted-staging");
  assert.throws(() => parseShown("name: x\nproperties: {}\n"), /-o json/);
});

test("the file is 0600 in a 0700 directory", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "desk-app-yaml-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const { file, dir } = writeAppYaml(buildAppYaml({ shownYaml, setSecrets: { "desk-app-id": "12345" } }), { parent });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).name, "ouro-desk-hosted-staging");
});

test("the command line generates a missing secret inside the process and never prints a value", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "desk-app-yaml-cli-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const shownFile = join(parent, "shown.json");
  const app = structuredClone(shown);
  app.properties.configuration.secrets = app.properties.configuration.secrets.filter((secret) => secret.name !== "desk-signing-key" && secret.name !== "desk-app-key");
  writeFileSync(shownFile, JSON.stringify(app));
  const script = fileURLToPath(new URL("../infra/app-yaml.mjs", import.meta.url));
  const output = execFileSync(
    process.execPath,
    [script, "--shown", shownFile, "--out", parent, "--ensure-secret", "desk-signing-key", "--ensure-placeholder", "desk-app-key", "--ensure-placeholder", "desk-app-id", "--set-env", "DESK_REPO=arimendelow/desk"],
    { encoding: "utf8" },
  );
  const file = output.trim();
  const written = JSON.parse(readFileSync(file, "utf8"));
  const key = written.properties.configuration.secrets.find((secret) => secret.name === "desk-signing-key").value;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!output.includes(key));
  assert.equal(written.properties.configuration.secrets.find((secret) => secret.name === "desk-app-key").value, "unset");
  // An existing secret is never overwritten by --ensure-placeholder.
  assert.ok(!("value" in written.properties.configuration.secrets.find((secret) => secret.name === "desk-app-id")));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

// --- After a write: what az really sent (review C1 and I1) -------------------------------------------------------

import { azUpdateModel } from "./fixtures/az-update-model.mjs";
import { checkWritten, missingIdentities } from "../infra/app-yaml.mjs";

const secretList = (app) => app.properties.configuration.secrets.map(({ value, ...rest }) => rest);

test("az's update pipeline drops the identity map, so an identity must be attached before the update", () => {
  const added = "/subscriptions/s/resourceGroups/rg-ouro-identity/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-ouro-desk-hosted-staging";
  const sent = azUpdateModel(JSON.parse(buildAppYaml({ shownYaml, addIdentities: [added] })), {});
  assert.deepEqual(sent.identity, { type: "UserAssigned" });
  assert.deepEqual(missingIdentities(shown, [added]), [added]);
  // Compared without case: ARM may lower-case resource group names in ids.
  assert.deepEqual(missingIdentities(shown, [KV_IDENTITY.toLowerCase()]), []);
});

test("checkWritten passes when every secret, Key Vault reference and identity is still there", () => {
  checkWritten({ before: shown, after: shown, secretList: secretList(shown) });
});

test("checkWritten fails when a Key Vault reference came back as a plain value", () => {
  const list = secretList(shown).map((secret) => (secret.name === "entra-client-secret" ? { name: secret.name } : secret));
  assert.throws(() => checkWritten({ before: shown, after: shown, secretList: list }), /entra-client-secret is no longer a Key Vault reference/);
});

test("checkWritten fails when a new Key Vault reference didn't arrive, a secret is gone, or an identity is gone", () => {
  const without = (name) => secretList(shown).filter((secret) => secret.name !== name);
  assert.throws(() => checkWritten({ before: shown, after: shown, secretList: without("desk-client-key") }), /desk-client-key is gone/);
  assert.throws(() => checkWritten({ before: shown, after: shown, secretList: secretList(shown), keyVaultSecrets: { "kv-new": {} } }), /kv-new is no longer a Key Vault reference/);
  const after = structuredClone(shown);
  delete after.identity.userAssignedIdentities[KV_IDENTITY];
  assert.throws(() => checkWritten({ before: shown, after, secretList: secretList(shown) }), /id-ouro-desk-hosted-staging is no longer attached/);
  assert.throws(() => checkWritten({ before: structuredClone(after), after, secretList: secretList(shown), expectIdentities: [KV_IDENTITY] }), /no longer attached/);
});

test("a volume that mounts a secret the app doesn't hold is refused", () => {
  const app = structuredClone(shown);
  app.properties.configuration.secrets = app.properties.configuration.secrets.filter(({ name }) => name !== "desk-app-key");
  assert.throws(() => buildAppYaml({ shownYaml: app }), /Volume app-key mounts secret desk-app-key/);
});

// --- Fix round 2: staging never holds production's pull identity (re-review N-I1) -------------------------------

const PROD_PULL_ID = "/subscriptions/261e0bf1-934d-41ab-9295-229b0d254418/resourceGroups/rg-ouro-work-substrate/providers/Microsoft.ManagedIdentity/userAssignedIdentities/ouro-prod-services-mi";

test("buildAppYaml refuses an app that holds a forbidden identity, attached or as its registry identity", () => {
  buildAppYaml({ shownYaml, forbidIdentities: ["ouro-prod-services-mi"] });
  const attached = structuredClone(shown);
  attached.identity.userAssignedIdentities[PROD_PULL_ID] = {};
  assert.throws(() => buildAppYaml({ shownYaml: attached, forbidIdentities: ["ouro-prod-services-mi"] }), /must not hold identity ouro-prod-services-mi/);
  const registry = structuredClone(shown);
  registry.properties.configuration.registries[0].identity = PROD_PULL_ID.toUpperCase();
  assert.throws(() => buildAppYaml({ shownYaml: registry, forbidIdentities: ["ouro-prod-services-mi"] }), /must not hold identity ouro-prod-services-mi/);
});

test("checkWritten refuses a forbidden identity after the write, and a registry that doesn't pull with the expected identity", () => {
  const ok = { before: shown, secretList: secretList(shown) };
  checkWritten({ ...ok, after: shown, forbidIdentities: ["ouro-prod-services-mi"], registryIdentity: KV_IDENTITY.toLowerCase() });
  const attached = structuredClone(shown);
  attached.identity.userAssignedIdentities[PROD_PULL_ID] = {};
  assert.throws(() => checkWritten({ ...ok, after: attached, forbidIdentities: ["ouro-prod-services-mi"] }), /must not hold identity ouro-prod-services-mi/);
  const registry = structuredClone(shown);
  registry.properties.configuration.registries[0].identity = PROD_PULL_ID;
  assert.throws(() => checkWritten({ ...ok, after: registry, registryIdentity: KV_IDENTITY }), /pulls from ouroworkprodk2aumligevt3e\.azurecr\.io with ouro-prod-services-mi, not id-ouro-desk-hosted-staging/);
  const none = structuredClone(shown);
  none.properties.configuration.registries = [];
  assert.throws(() => checkWritten({ ...ok, after: none, registryIdentity: KV_IDENTITY }), /no registry/);
});
