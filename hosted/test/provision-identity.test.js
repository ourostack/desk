// provision-identity.mjs against a recording fake runner (fixtures/fake-cloud.mjs). Nothing here reaches Azure,
// Graph or GitHub. These cover Review Focus 8 and Task 3 review I4 (the key subcommands' wiring and the
// no-key-in-output test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../src/auth/seal.js";
import { keysStartupLine, readConfig } from "../src/main.js";
import { createMemoryStore } from "../src/accounts/memory-store.js";
import { hashToken } from "../src/accounts/invites.js";
import { plan, run, parseFlags } from "../infra/provision-identity.mjs";
import { addContainerApp, createFakeRunner, emptyCloud, OPERATOR, OPERATOR_TOKEN, TEST_TENANT, VAULT_ID } from "./fixtures/fake-cloud.mjs";
import { defaultRunner } from "../infra/provision-identity.mjs";

const shownFixture = JSON.parse(readFileSync(new URL("./fixtures/containerapp-shown.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-01T00:00:00Z");
const APPLE_KEY = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgAPPLEKEYMATERIAL\n-----END PRIVATE KEY-----\n";
const SIGNING = "5".repeat(64);
const APP_SECRETS = { "desk-app-id": "123456", "desk-app-client-id": "Iv23liCLIENTID", "desk-app-client-secret": "c0ffee".repeat(7), "desk-app-key": "-----BEGIN RSA PRIVATE KEY-----\nAPPKEYMATERIAL\n-----END RSA PRIVATE KEY-----\n" };

function setup(t, { env = "test", record = {}, cloud = emptyCloud() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "desk-provision-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recordDir = join(dir, "records");
  const home = join(dir, "home");
  for (const path of [recordDir, home]) mkdirSync(path, { recursive: true });
  const base = {
    env,
    tenant: { name: env === "test" ? "ourobottest" : "ourobot" },
    apple: { outcome: "A", developerId: "TEAMID1234", serviceId: "bot.ouro.identity.test", appId: "bot.ouro.identity.testapp", keyIds: { a: "KEYIDAAAAA", b: "KEYIDBBBBB" } },
    ...record,
  };
  writeFileSync(join(recordDir, `identity-${env}.json`), JSON.stringify(base));
  cloud.probeCommand = "probe";
  cloud.openerCommand = "opener";
  const fake = createFakeRunner(cloud);
  const logs = [];
  // The accounts store refuses the operator (HTTP 403, as Table Storage does) until it holds Storage Table Data
  // Contributor on the env's storage account; `storeRefusals` more calls after that are refused too (propagation).
  const memory = createMemoryStore();
  let storeRefusals = 0;
  let wasGranted = false;
  const store = new Proxy(memory, {
    get(target, name) {
      const method = target[name];
      if (typeof method !== "function") return method;
      return async (...args) => {
        if (cloud.storeRbac) {
          const granted = cloud.roles.some((role) => role.principalId === OPERATOR && role.role === "Storage Table Data Contributor" && /storageAccounts\/stouroa/.test(role.scope));
          if (granted && !wasGranted) storeRefusals = cloud.storePropagation ?? 0;
          wasGranted = granted;
          if (!granted || storeRefusals-- > 0) throw new Error(`${String(name)} on table accounts (HTTP 403 AuthorizationPermissionMismatch)`);
        }
        return method.apply(target, args);
      };
    },
  });
  const go = (flags = {}, options = {}) =>
    run({
      env,
      flags,
      runner: fake.runner,
      log: (line) => logs.push(line),
      home,
      now: () => NOW,
      recordDir,
      openStore: async () => store,
      sleep: async () => {},
      probeCommand: { cmd: "probe", args: [] },
      openerCommand: { cmd: "opener", args: [] },
      ...options,
    });
  const readRecord = () => JSON.parse(readFileSync(join(recordDir, `identity-${env}.json`), "utf8"));
  return { dir, home, recordDir, fake, logs, store, go, readRecord, cloud };
}

// Everything a run showed or passed on: its log lines, every child's argv, and every stdin that isn't meant to
// carry a secret (writes of secrets go through stdin, which is how they are kept out of argv).
const everythingShown = ({ logs, fake }) => [...logs, ...fake.calls.map(({ cmd, args }) => [cmd, ...args].join(" "))].join("\n");
const writes = (fake) => fake.calls.filter(({ write }) => write);
const assertNoneOf = (text, secrets) => {
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `a secret appeared: ${secret.slice(0, 6)}…`);
    const firstLine = secret.split("\n").find((line) => line.length > 12 && !line.startsWith("-----"));
    if (firstLine) assert.ok(!text.includes(firstLine), "a secret's line appeared");
  }
};

function withAppleKeyInVault(cloud, slot = "a") {
  cloud.vault.secrets[`apple-siwa-key-${slot}-test`] = { value: APPLE_KEY, tags: {} };
  return cloud;
}

// A staging app and production app in the fake cloud, as the gateway would log at start.
function gatewayLine({ secrets, shown }) {
  const env = {};
  for (const entry of shown.properties.template.containers[0].env) env[entry.name] = entry.secretRef ? secrets[entry.secretRef] : entry.value;
  const keys = {};
  for (const name of ["DESK_SIGNING_KEY", "DESK_CLIENT_KEY", "DESK_SIGNING_KEY_PREVIOUS", "DESK_SIGNING_KEY_PREVIOUS_UNTIL"]) if (env[name] !== undefined) keys[name] = env[name];
  return `2026-11-01T00:00:00Z desk-hosted: ${keysStartupLine(readConfig({ ...keys, CONTAINER_APP_REVISION: shown.properties.latestReadyRevisionName }))}`;
}
function addStaging(cloud, { shown, secrets, logsLine = true } = {}) {
  const app = addContainerApp(cloud, { name: "ouro-desk-hosted-staging", shown, secrets, readYaml: (path) => readFileSync(path, "utf8") });
  if (logsLine) app.logs.push({ revision: shown.properties.latestReadyRevisionName, text: gatewayLine(app) });
  app.onUpdate = (updated) => {
    // A template change starts a new revision, which logs its own keys line when its image does.
    const number = Number(updated.shown.properties.latestReadyRevisionName.split("--")[1] ?? 0) + 1;
    updated.shown.properties.latestReadyRevisionName = `ouro-desk-hosted-staging--${String(number).padStart(7, "0")}`;
    if (logsLine) updated.logs.push({ revision: updated.shown.properties.latestReadyRevisionName, text: gatewayLine(updated) });
  };
  return app;
}
// Staging as provision.sh creates it on today's image: a signing key and no client key.
function todaysShown() {
  const shown = structuredClone(shownFixture);
  shown.properties.configuration.secrets = shown.properties.configuration.secrets.filter(({ name }) => !["desk-client-key", "desk-signing-key-previous", "entra-client-secret"].includes(name));
  shown.properties.template.containers[0].env = shown.properties.template.containers[0].env.filter(({ name }) => !["DESK_CLIENT_KEY", "DESK_SIGNING_KEY_PREVIOUS", "DESK_SIGNING_KEY_PREVIOUS_UNTIL", "DESK_ENTRA_CLIENT_SECRET"].includes(name));
  return shown;
}

// --- Dry run and idempotence ------------------------------------------------------------------------------------

test("a dry run makes no write call and prints each would-be write with every secret-bearing argument shown as ***", async (t) => {
  const { go, fake, logs } = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  await go({ dryRun: true });
  assert.deepEqual(writes(fake), []);
  const shown = logs.join("\n");
  assert.match(shown, /would run: az ad app create --display-name ouro-desk-hosted /);
  assert.match(shown, /would run: az ad app credential reset .*--append.*\n.*would run: az keyvault secret set .*--file \/dev\/stdin.*\(stdin: \*\*\*\)/);
  assert.match(shown, /would run: az rest --method post --url https:\/\/graph\.microsoft\.com\/v1\.0\/identity\/identityProviders .*\(stdin: \*\*\*\)/);
  assert.match(shown, /would run: gh api -X PUT repos\/ourostack\/desk\/environments\/identity/);
  assert.match(shown, /would run: az storage account create -n stouroacctstest261e0b .*--sku Standard_ZRS.*--min-tls-version TLS1_2.*--allow-shared-key-access false/);
  assertNoneOf(everythingShown({ logs, fake }), [APPLE_KEY]);
  // A dry run reads the Apple key only when it would really send it, so not at all.
  assert.ok(!fake.calls.some(({ args }) => args.includes("apple-siwa-key-a-test")));
});

test("a second run on a fully reconciled state makes no writes", async (t) => {
  const { go, fake, readRecord } = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  addContainerApp(fake.cloud, { name: "ouro-desk-hosted", shown: { ...shownFixture, id: "/subscriptions/s/containerApps/ouro-desk-hosted" }, secrets: {} });
  addContainerApp(fake.cloud, { name: "ouro-desk-hosted-staging", shown: shownFixture, secrets: {} });
  await go();
  assert.ok(writes(fake).length > 10);
  const firstRecord = readRecord();
  fake.calls.length = 0;
  await go();
  assert.deepEqual(writes(fake).map(({ args }) => args.slice(0, 4).join(" ")), []);
  assert.deepEqual(readRecord(), firstRecord);
});

test("plan() lists only the missing pieces for a given state", () => {
  const steps = plan({ env: "test", state: { tenant: { id: TEST_TENANT, name: "ourobottest" }, email: { state: "enabled", allowExternalIdToUseEmailOtp: "enabled" } } });
  const names = steps.map(({ name }) => name);
  assert.ok(!names.includes("email one-time code"));
  assert.ok(names.includes("storage account"));
});

// --- Apple key import -------------------------------------------------------------------------------------------

function appleFile(dir) {
  const file = join(dir, "AuthKey_KEYIDAAAAA.p8");
  writeFileSync(file, APPLE_KEY, { mode: 0o600 });
  return file;
}

test("the key is sent only through input", async (t) => {
  const context = setup(t);
  const file = appleFile(context.dir);
  await context.go({ appleKeyFile: file, appleKeySlot: "a" });
  const set = context.fake.calls.find(({ args }) => args[0] === "keyvault" && args[2] === "set");
  assert.deepEqual(set.args.slice(0, 7), ["keyvault", "secret", "set", "--vault-name", "kv-ouro-identity-261e0b", "--name", "apple-siwa-key-a-test"]);
  assert.ok(set.args.includes("/dev/stdin"));
  assert.equal(set.input, APPLE_KEY);
  assertNoneOf(everythingShown(context), [APPLE_KEY]);
});

test("the revoked tag on that slot is cleared", async (t) => {
  const cloud = emptyCloud();
  cloud.vault.secrets["apple-siwa-key-a-test"] = { value: "old", tags: { revoked: "2026-10-30" } };
  const context = setup(t, { cloud });
  await context.go({ appleKeyFile: appleFile(context.dir), appleKeySlot: "a" });
  assert.equal(cloud.vault.secrets["apple-siwa-key-a-test"].tags.revoked, undefined);
  assert.ok(cloud.vault.secrets["apple-siwa-key-a-test"].tags["imported-at"]);
});

test("the file is deleted only after the fake Key Vault confirms the write", async (t) => {
  const context = setup(t);
  const file = appleFile(context.dir);
  let existedAtConfirm = null;
  const runner = context.fake.runner;
  const watching = async (cmd, args, options) => {
    if (args[0] === "keyvault" && args[2] === "show" && args.includes("value")) existedAtConfirm = existsSync(file);
    return runner(cmd, args, options);
  };
  await context.go({ appleKeyFile: file, appleKeySlot: "a" }, { runner: watching });
  assert.equal(existedAtConfirm, true);
  assert.equal(existsSync(file), false);
});

test("the file is kept when the write fails or with --keep-file", async (t) => {
  const failing = emptyCloud();
  failing.failKeyVaultWrites = true;
  const first = setup(t, { cloud: failing });
  const file = appleFile(first.dir);
  await assert.rejects(first.go({ appleKeyFile: file, appleKeySlot: "a" }));
  assert.ok(existsSync(file));

  const corrupt = emptyCloud();
  corrupt.corruptKeyVaultWrites = true;
  const second = setup(t, { cloud: corrupt });
  const secondFile = appleFile(second.dir);
  await assert.rejects(second.go({ appleKeyFile: secondFile, appleKeySlot: "a" }), /does not match/);
  assert.ok(existsSync(secondFile));

  const third = setup(t);
  const kept = appleFile(third.dir);
  await third.go({ appleKeyFile: kept, appleKeySlot: "b", keepFile: true });
  assert.ok(existsSync(kept));
  assert.equal(third.cloud.vault.secrets["apple-siwa-key-b-test"].value, APPLE_KEY);
});

// --- Gateway secret and copies ----------------------------------------------------------------------------------

test("the gateway secret is created with --append and written without a trailing newline, and appears in no argv or output", async (t) => {
  const context = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  await context.go();
  const reset = context.fake.calls.find(({ args }) => args.slice(0, 4).join(" ") === "ad app credential reset");
  assert.ok(reset.args.includes("--append"));
  const secret = context.cloud.lastGatewaySecret;
  assert.equal(context.cloud.vault.secrets["entra-client-secret-test"].value, secret);
  const set = context.fake.calls.find(({ args }) => args.includes("entra-client-secret-test") && args[2] === "set");
  assert.equal(set.input, secret);
  assertNoneOf(everythingShown(context), [secret]);
});

test("--copy-app-secrets reads with --query value, writes through the YAML builder, and logs only fingerprints", async (t) => {
  const context = setup(t);
  addContainerApp(context.cloud, { name: "ouro-desk-hosted", shown: { ...shownFixture, name: "ouro-desk-hosted" }, secrets: Object.fromEntries(Object.entries(APP_SECRETS).map(([name, value]) => [name, value])) });
  // The fake's -o tsv adds one newline to each value, as az does.
  const staging = addStaging(context.cloud, { shown: shownFixture, secrets: { "desk-app-id": "unset", "desk-app-client-id": "unset", "desk-app-client-secret": "unset", "desk-app-key": "unset", "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  await context.go({ copyAppSecrets: true });
  const reads = context.fake.calls.filter(({ args }) => args[1] === "secret" && args[2] === "show");
  assert.equal(reads.length, 4);
  for (const read of reads) {
    assert.ok(read.args.includes("ouro-desk-hosted"));
    assert.deepEqual(read.args.slice(read.args.indexOf("--query"), read.args.indexOf("--query") + 4), ["--query", "value", "-o", "tsv"]);
  }
  assert.equal(staging.updates.length, 1);
  for (const [name, value] of Object.entries(APP_SECRETS)) {
    // The PEM keeps its own last newline; only az's one is trimmed.
    assert.equal(staging.secrets[name], value, name);
  }
  assert.ok(!context.fake.calls.some(({ args }) => args.includes("--secrets")));
  for (const name of Object.keys(APP_SECRETS)) assert.ok(context.logs.some((line) => line.includes(name) && line.includes(fingerprint(APP_SECRETS[name]))));
  assertNoneOf(everythingShown(context), Object.values(APP_SECRETS).filter((value) => value.length > 8));
  assert.ok(staging.restarts.length === 1, "staging restarts to read the copied secrets");
});

test("--copy-app-secrets and --clear-app-secrets refuse production", async (t) => {
  const context = setup(t, { env: "prod" });
  await assert.rejects(context.go({ copyAppSecrets: true }), /--env test/);
  await assert.rejects(context.go({ clearAppSecrets: true }), /--env test/);
});

test("--clear-app-secrets writes unset over all four desk-app secrets and nothing else", async (t) => {
  const context = setup(t);
  const secrets = { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING, "desk-signing-key-previous": "6".repeat(64) };
  const staging = addStaging(context.cloud, { shown: shownFixture, secrets });
  await context.go({ clearAppSecrets: true });
  const document = staging.updates[0];
  const valued = document.properties.configuration.secrets.filter((secret) => "value" in secret);
  assert.deepEqual(valued, Object.keys(APP_SECRETS).map((name) => ({ name, value: "unset" })));
  assert.deepEqual(document.properties.template.containers[0].env, shownFixture.properties.template.containers[0].env);
  assert.equal(staging.secrets["desk-signing-key"], SIGNING);
});

test("the identity-checks identity gets exactly Key Vault Secrets Officer on the vault and Reader on each env's app from that env's run, and its federated subject is the identity environment", async (t) => {
  const context = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  addContainerApp(context.cloud, { name: "ouro-desk-hosted", shown: { ...shownFixture, id: "/apps/ouro-desk-hosted" }, secrets: {} });
  addContainerApp(context.cloud, { name: "ouro-desk-hosted-staging", shown: { ...shownFixture, id: "/apps/ouro-desk-hosted-staging" }, secrets: {} });
  await context.go();
  const checks = context.cloud.identities["id-ouro-identity-checks"];
  const roles = context.cloud.roles.filter(({ principalId }) => principalId === checks.principalId).map(({ role, scope }) => `${role} @ ${scope.split("/").at(-1)}`);
  // A test run touches only the staging app (review m2); a prod run gives Reader on production's app.
  assert.deepEqual(roles.sort(), ["Key Vault Secrets Officer @ kv-ouro-identity-261e0b", "Reader @ ouro-desk-hosted-staging"]);
  assert.deepEqual(checks.federated.map(({ subject, issuer, audiences }) => [subject, issuer, audiences]), [
    ["repo:ourostack@265728804/desk@1386529300:environment:identity", "https://token.actions.githubusercontent.com", "api://AzureADTokenExchange"],
  ]);
  const automation = context.cloud.graph.apps.find(({ displayName }) => displayName === "ouro-identity-automation");
  assert.deepEqual(automation.federated.map(({ subject }) => subject), ["repo:ourostack@265728804/desk@1386529300:environment:identity"]);
  const sp = context.cloud.graph.sps.find(({ appId }) => appId === automation.appId);
  assert.deepEqual(sp.appRoleAssignments, ["90db2b9a-d928-4d33-a4dd-8442ae3d41e4"]);
  // Staging's gateway has its own identity, with roles only on the test secret and the test accounts storage (I2).
  assert.equal(context.cloud.identities["id-ouro-desk-hosted"], undefined);
  const gateway = context.cloud.identities["id-ouro-desk-hosted-staging"];
  const gatewayRoles = context.cloud.roles.filter(({ principalId }) => principalId === gateway.principalId).map(({ role, scope }) => `${role} @ ${scope.split("/").at(-1)}`);
  assert.deepEqual(gatewayRoles.sort(), ["Key Vault Secrets User @ entra-client-secret-test", "Storage Table Data Contributor @ stouroacctstest261e0b"]);
  assert.ok(!context.cloud.roles.some(({ scope }) => /entra-client-secret-prod|stouroaccounts261e0b|\/ouro-desk-hosted$/.test(scope)), "a test run grants nothing on production");
  // The GitHub environment deploys from main only.
  assert.deepEqual(context.cloud.gh.env.policy, { protected_branches: false, custom_branch_policies: true });
  assert.deepEqual(context.cloud.gh.env.branches, ["main"]);
  assert.equal(context.cloud.gh.variables.AZURE_CHECKS_CLIENT_ID, checks.clientId);
  assert.equal(context.cloud.gh.variables.OURO_AUTOMATION_CLIENT_ID_TEST, automation.appId);
});

// --- Seeding and invites ----------------------------------------------------------------------------------------

test("--seed-ari records the accountId and issues no invite", async (t) => {
  const context = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  await context.go({ seedAri: true });
  const { ari } = context.readRecord();
  assert.ok(ari.accountId);
  assert.equal(ari.githubUserId, 16390116);
  assert.equal(ari.githubLogin, "arimendelow");
  const account = await context.store.getAccount(ari.accountId);
  assert.equal(account.deskAccess, true);
  assert.deepEqual(await context.store.getBinding(ari.accountId), { kind: "github", repo: "arimendelow/desk-rehearsal", author: { name: "Ari Mendelow", email: "16390116+arimendelow@users.noreply.github.com" } });
  assert.ok(!context.logs.some((line) => /invite/i.test(line)));
  // A second seed keeps the same account.
  await context.go({ seedAri: true });
  assert.equal(context.readRecord().ari.accountId, ari.accountId);
});

test("--invite-ari in prod writes a 0600 file, passes no token in argv and logs none; in test it may print the link", async (t) => {
  const storage = { account: "stouroaccounts261e0b", id: "/subscriptions/s/resourceGroups/rg-ouro-identity/providers/Microsoft.Storage/storageAccounts/stouroaccounts261e0b", endpoint: "https://stouroaccounts261e0b.table.core.windows.net" };
  const prod = setup(t, { env: "prod", record: { storage, ari: { accountId: "acct-ari", githubUserId: 16390116, githubLogin: "arimendelow" } } });
  await prod.store.ensureTables();
  await prod.store.putAccount({ accountId: "acct-ari", displayName: "Ari Mendelow", deskAccess: true });
  await prod.go({ inviteAri: true, browserContext: "claude-second" });
  const file = join(prod.home, ".ouro", "invite-prod.url");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(prod.home, ".ouro")).mode & 0o777, 0o700);
  const link = readFileSync(file, "utf8").trim();
  const token = link.match(/^https:\/\/desk\.ouro\.bot\/invite\/([A-Za-z0-9_-]{43})$/)[1];
  const invite = await prod.store.getInvite(hashToken(token));
  assert.equal(invite.accountId, "acct-ari");
  assert.equal(invite.expiresAt, NOW + 24 * 3600 * 1000);
  assertNoneOf(everythingShown(prod), [token]);
  const opener = prod.fake.calls.find(({ cmd }) => cmd === "opener");
  assert.deepEqual(opener.args, ["--url-file", file, "--context", "claude-second"]);

  const test_ = setup(t, { record: { storage, ari: { accountId: "acct-ari-test", githubUserId: 16390116, githubLogin: "arimendelow" } } });
  await test_.store.ensureTables();
  await test_.store.putAccount({ accountId: "acct-ari-test", displayName: "Ari Mendelow", deskAccess: true });
  await test_.go({ inviteAri: true });
  const printed = test_.logs.join("\n").match(/https:\/\/ouro-desk-hosted-staging\.[^/]+\/invite\/([A-Za-z0-9_-]{43})/);
  assert.ok(printed);
  assert.equal((await test_.store.getInvite(hashToken(printed[1]))).expiresAt, NOW + 7 * 24 * 3600 * 1000);
});

test("--invite-ari refuses when no accountId is recorded", async (t) => {
  const context = setup(t);
  await assert.rejects(context.go({ inviteAri: true }), /--seed-ari/);
});

// --- Records and edge cases -------------------------------------------------------------------------------------

test("identity-<env>.json holds tenant id, subdomain, app ids, Services ID, Key IDs, user-flow id and Ari's accountId, and no value matching a secret fixture", async (t) => {
  const context = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  await context.go({ seedAri: true });
  const record = context.readRecord();
  assert.equal(record.tenant.id, TEST_TENANT);
  assert.equal(record.tenant.subdomain, "ourobottest");
  assert.match(record.gatewayApp.appId, /^[0-9a-f-]{36}$/);
  assert.match(record.automationApp.appId, /^[0-9a-f-]{36}$/);
  assert.equal(record.apple.serviceId, "bot.ouro.identity.test");
  assert.deepEqual(record.apple.keyIds, { a: "KEYIDAAAAA", b: "KEYIDBBBBB" });
  assert.equal(record.apple.providerId, "Apple-Managed-OIDC");
  assert.match(record.userFlow.id, /^[0-9a-f-]{36}$/);
  assert.ok(record.ari.accountId);
  assert.equal(record.storage.endpoint, "https://stouroacctstest261e0b.table.core.windows.net");
  assert.ok(record.gatewayIdentity.clientId && record.checksIdentity.clientId);
  const text = JSON.stringify(record);
  assertNoneOf(text, [APPLE_KEY, context.cloud.lastGatewaySecret]);
  // The user flow offers email and Apple, and the gateway app signs in through it.
  const flow = context.cloud.graph.flows[0];
  assert.deepEqual(flow.idps, ["EmailOtpSignup-OAUTH", "Apple-Managed-OIDC"]);
  assert.deepEqual(flow.apps, [record.gatewayApp.appId]);
  const app = context.cloud.graph.apps.find(({ appId }) => appId === record.gatewayApp.appId);
  assert.deepEqual(app.web.redirectUris, ["https://ouro-desk-hosted-staging.blueflower-44af4710.eastus2.azurecontainerapps.io/oauth/entra/callback"]);
  assert.equal(app.api.requestedAccessTokenVersion, 2);
  assert.deepEqual(context.cloud.graph.email, { state: "enabled", allowExternalIdToUseEmailOtp: "enabled" });
});

test("a tenant name already taken moves to the next candidate", async (t) => {
  const cloud = emptyCloud();
  cloud.ciam = {};
  cloud.taken.add("ourobottest");
  const context = setup(t, { cloud, record: { tenant: null } });
  await assert.rejects(context.go(), /being created/);
  const put = context.fake.calls.find(({ args }) => args[0] === "rest" && args.includes("put"));
  assert.match(put.args.join(" "), /ciamDirectories\/ouroidtest\?/);
  assert.deepEqual(JSON.parse(put.input).properties.createTenantProperties, { displayName: "Ouro (test)", countryCode: "US" });
});

test("under outcome B the Apple step stops with the admin-center text instead of calling Graph", async (t) => {
  const context = setup(t, { cloud: withAppleKeyInVault(emptyCloud()), record: { apple: { outcome: "B", developerId: "TEAMID1234", serviceId: "bot.ouro.identity.test", keyIds: { a: "KEYIDAAAAA" } } } });
  await assert.rejects(context.go(), /admin center/);
  assert.ok(!context.fake.calls.some(({ args }) => args.includes("post") && args.some((arg) => arg.endsWith("identity/identityProviders"))));
  assert.ok(!context.fake.calls.some(({ args }) => args.includes("apple-siwa-key-a-test")));
  assert.match(context.logs.join("\n"), /All identity providers/);
});

test("Graph steps refuse to run against a tenant other than the record's", async (t) => {
  const cloud = withAppleKeyInVault(emptyCloud());
  cloud.account.tenantId = "de8841c3-7799-4523-bbad-44f8a2426eaa";
  const context = setup(t, { cloud });
  await assert.rejects(context.go(), /az login --tenant c12edfb6/);
  assert.ok(!context.fake.calls.some(({ args }) => args[0] === "ad"));
});

// --- Signing keys (Task 3's checks, wired; review I4) -----------------------------------------------------------

test("--migrate client-key copies the read key byte-exactly through the YAML builder, after checking the gateway's logged fingerprint", async (t) => {
  const context = setup(t);
  const shown = todaysShown();
  const staging = addStaging(context.cloud, { shown, secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING } });
  await context.go({ migrate: "client-key" });
  const document = staging.updates[0];
  assert.deepEqual(document.properties.configuration.secrets.find(({ name }) => name === "desk-client-key"), { name: "desk-client-key", value: SIGNING });
  assert.deepEqual(document.properties.template.containers[0].env.find(({ name }) => name === "DESK_CLIENT_KEY"), { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" });
  for (const entry of shown.properties.template.containers[0].env) assert.ok(document.properties.template.containers[0].env.some(({ name }) => name === entry.name));
  assert.equal(staging.secrets["desk-client-key"], SIGNING);
  assert.ok(context.logs.some((line) => line.includes(fingerprint(SIGNING)) && /client-from DESK_CLIENT_KEY|confirmed/.test(line)));
  assert.ok(!context.fake.calls.some(({ cmd }) => cmd === "probe"), "with a logged line, no probe is needed");
  assertNoneOf(everythingShown(context), [SIGNING]);
});

test("--migrate client-key on today's image uses the probe before and after, and says the client key is unconfirmed", async (t) => {
  const context = setup(t);
  const staging = addStaging(context.cloud, { shown: todaysShown(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING }, logsLine: false });
  await context.go({ migrate: "client-key" });
  const probes = context.fake.calls.filter(({ cmd }) => cmd === "probe");
  assert.deepEqual(probes.map(({ args }) => args), [["status", "--name", "staging-legacy"], ["status", "--name", "staging-legacy"]]);
  const order = context.fake.calls.map(({ cmd, args }) => (cmd === "probe" ? "probe" : args.slice(0, 2).join(" "))).filter((step) => step === "probe" || step === "containerapp update");
  assert.deepEqual(order, ["probe", "containerapp update", "probe"]);
  assert.equal(staging.secrets["desk-client-key"], SIGNING);
  assert.match(context.logs.join("\n"), /unconfirmed/);
});

test("--migrate client-key stops without writing when the read key doesn't match the gateway's logged fingerprint, or a probe fails", async (t) => {
  const context = setup(t);
  const staging = addStaging(context.cloud, { shown: todaysShown(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING } });
  staging.secrets["desk-signing-key"] = "7".repeat(64);
  await assert.rejects(context.go({ migrate: "client-key" }), /nothing was written/);
  assert.equal(staging.updates.length, 0);

  const second = setup(t);
  const probed = addStaging(second.cloud, { shown: todaysShown(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING }, logsLine: false });
  second.cloud.probe = () => {
    throw new Error("probe refused: invalid_grant");
  };
  await assert.rejects(second.go({ migrate: "client-key" }));
  assert.equal(probed.updates.length, 0);
});

test("--migrate client-key fails when the read-back fingerprints differ", async (t) => {
  const context = setup(t);
  const staging = addStaging(context.cloud, { shown: todaysShown(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING } });
  const original = staging.onUpdate;
  staging.onUpdate = (app) => {
    app.secrets["desk-client-key"] = "8".repeat(64);
    original(app);
  };
  await assert.rejects(context.go({ migrate: "client-key" }), /reads back as/);
});

test("--migrate client-key after a migration only checks the copy and writes nothing", async (t) => {
  const context = setup(t);
  const shown = structuredClone(shownFixture);
  shown.properties.template.containers[0].env = shown.properties.template.containers[0].env.filter(({ name }) => !name.startsWith("DESK_SIGNING_KEY_PREVIOUS"));
  shown.properties.configuration.secrets = shown.properties.configuration.secrets.filter(({ name }) => name !== "desk-signing-key-previous");
  addStaging(context.cloud, { shown, secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  await context.go({ migrate: "client-key" });
  assert.deepEqual(writes(context.fake), []);
  assert.match(context.logs.join("\n"), /already/);
});

test("--rotate signing-key writes the old key as previous and a new one through the builder, keeps the client key and the Key Vault reference, and confirms the new startup line", async (t) => {
  const context = setup(t);
  const shown = structuredClone(shownFixture);
  shown.properties.template.containers[0].env = shown.properties.template.containers[0].env.filter(({ name }) => !name.startsWith("DESK_SIGNING_KEY_PREVIOUS"));
  shown.properties.configuration.secrets = shown.properties.configuration.secrets.filter(({ name }) => name !== "desk-signing-key-previous");
  const staging = addStaging(context.cloud, { shown, secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  await context.go({ rotate: "signing-key" });
  assert.equal(staging.updates.length, 1);
  assert.equal(staging.secrets["desk-signing-key-previous"], SIGNING);
  assert.match(staging.secrets["desk-signing-key"], /^[0-9a-f]{64}$/);
  assert.notEqual(staging.secrets["desk-signing-key"], SIGNING);
  assert.equal(staging.secrets["desk-client-key"], SIGNING);
  const env = staging.shown.properties.template.containers[0].env;
  assert.deepEqual(env.find(({ name }) => name === "DESK_SIGNING_KEY_PREVIOUS"), { name: "DESK_SIGNING_KEY_PREVIOUS", secretRef: "desk-signing-key-previous" });
  assert.equal(env.find(({ name }) => name === "DESK_SIGNING_KEY_PREVIOUS_UNTIL").value, new Date(NOW + (30 * 24 + 1) * 3600 * 1000).toISOString());
  assert.deepEqual(env.find(({ name }) => name === "DESK_CLIENT_KEY"), { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" });
  assert.ok(staging.shown.properties.configuration.secrets.find(({ name }) => name === "entra-client-secret").keyVaultUrl);
  assert.ok(context.fake.calls.some(({ args }) => args.slice(0, 3).join(" ") === "containerapp secret list"));
});

test("--rotate signing-key puts no key in stdout, stderr or argv", async (t) => {
  const context = setup(t);
  const shown = structuredClone(shownFixture);
  shown.properties.template.containers[0].env = shown.properties.template.containers[0].env.filter(({ name }) => !name.startsWith("DESK_SIGNING_KEY_PREVIOUS"));
  shown.properties.configuration.secrets = shown.properties.configuration.secrets.filter(({ name }) => name !== "desk-signing-key-previous");
  const staging = addStaging(context.cloud, { shown, secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  await context.go({ rotate: "signing-key" });
  const newKey = staging.secrets["desk-signing-key"];
  const text = everythingShown(context);
  assertNoneOf(text, [SIGNING, newKey]);
  // Only fingerprints, which the log does carry.
  assert.ok(text.includes(fingerprint(SIGNING)) && text.includes(fingerprint(newKey)));
  // And stdin carried keys only inside the 0600 document az reads, never as an argument.
  for (const { args } of context.fake.calls) for (const arg of args) assert.ok(!/[0-9a-f]{64}/.test(arg), arg);
});

test("--rotate signing-key is refused in production, without an explicit client key, and when the logged key differs", async (t) => {
  const prod = setup(t, { env: "prod" });
  await assert.rejects(prod.go({ rotate: "signing-key" }), /--env test/);

  const noClient = setup(t);
  addStaging(noClient.cloud, { shown: todaysShown(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING } });
  await assert.rejects(noClient.go({ rotate: "signing-key" }), /DESK_CLIENT_KEY is not set/);

  const mismatch = setup(t);
  const shown = structuredClone(shownFixture);
  shown.properties.template.containers[0].env = shown.properties.template.containers[0].env.filter(({ name }) => !name.startsWith("DESK_SIGNING_KEY_PREVIOUS"));
  shown.properties.configuration.secrets = shown.properties.configuration.secrets.filter(({ name }) => name !== "desk-signing-key-previous");
  const staging = addStaging(mismatch.cloud, { shown, secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  staging.secrets["desk-signing-key"] = "9".repeat(64);
  await assert.rejects(mismatch.go({ rotate: "signing-key" }), /nothing was written/);
  assert.equal(staging.updates.length, 0);
});

test("every subcommand's errors and logs hold no secret fixture", async (t) => {
  const secrets = [SIGNING, APPLE_KEY, ...Object.values(APP_SECRETS).filter((value) => value.length > 8)];
  const context = setup(t);
  addStaging(context.cloud, { shown: todaysShown(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING } });
  for (const flags of [{ migrate: "client-key", dryRun: true }, { copyAppSecrets: true, dryRun: true }, { clearAppSecrets: true, dryRun: true }, { rotate: "signing-key", dryRun: true }]) {
    try {
      await context.go(flags);
    } catch (error) {
      context.logs.push(error.message);
    }
  }
  assertNoneOf(everythingShown(context), secrets);
  assert.deepEqual(writes(context.fake), []);
});

test("the command line takes the plan's flags", () => {
  assert.deepEqual(parseFlags(["--env", "test", "--dry-run", "--apple-key-file", "/k.p8", "--apple-key-slot", "a", "--keep-file"]), {
    env: "test",
    flags: { dryRun: true, appleKeyFile: "/k.p8", appleKeySlot: "a", keepFile: true, seedAri: false, inviteAri: false, copyAppSecrets: false, clearAppSecrets: false, migrate: undefined, rotate: undefined, browserContext: undefined },
  });
  assert.equal(parseFlags(["--env", "prod", "--migrate", "client-key"]).flags.migrate, "client-key");
  assert.throws(() => parseFlags(["--env", "test", "--migrate", "signing-key"]), /--migrate client-key/);
  assert.throws(() => parseFlags(["--env", "test", "--rotate", "client-key"]), /--rotate signing-key/);
  assert.throws(() => parseFlags(["--env", "test", "--apple-key-file", "/k.p8"]), /--apple-key-slot/);
  assert.throws(() => parseFlags(["--env", "staging"]), /test or prod/);
});

// --- Review fix round 1 -----------------------------------------------------------------------------------------

const KV_REF_SHOWN = () => {
  const shown = structuredClone(shownFixture);
  shown.properties.template.containers[0].env = shown.properties.template.containers[0].env.filter(({ name }) => !name.startsWith("DESK_SIGNING_KEY_PREVIOUS"));
  shown.properties.configuration.secrets = shown.properties.configuration.secrets.filter(({ name }) => name !== "desk-signing-key-previous");
  return shown;
};

test("I1: every app write is checked afterwards, and fails when az turned a Key Vault reference into a value (rotation, migration, copy, clear)", async (t) => {
  const cases = [
    ["rotate", { rotate: "signing-key" }, () => KV_REF_SHOWN(), { "desk-client-key": SIGNING }],
    ["migrate", { migrate: "client-key" }, () => {
      const shown = todaysShown();
      shown.properties.configuration.secrets.push(structuredClone(shownFixture.properties.configuration.secrets.find(({ name }) => name === "entra-client-secret")));
      return shown;
    }, {}],
    ["clear", { clearAppSecrets: true }, () => KV_REF_SHOWN(), { "desk-client-key": SIGNING }],
  ];
  for (const [label, flags, makeShown, extra] of cases) {
    const context = setup(t);
    context.cloud.resolveRefs = true;
    addStaging(context.cloud, { shown: makeShown(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, ...extra } });
    await assert.rejects(context.go(flags), /entra-client-secret is no longer a Key Vault reference/, label);
  }
  const copy = setup(t);
  copy.cloud.resolveRefs = true;
  addContainerApp(copy.cloud, { name: "ouro-desk-hosted", shown: { ...shownFixture, name: "ouro-desk-hosted" }, secrets: APP_SECRETS });
  addStaging(copy.cloud, { shown: KV_REF_SHOWN(), secrets: { "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  await assert.rejects(copy.go({ copyAppSecrets: true }), /no longer a Key Vault reference/);
});

test("C1: a write that loses an identity fails its check", async (t) => {
  const context = setup(t);
  context.cloud.dropIdentitiesOnUpdate = true;
  addStaging(context.cloud, { shown: KV_REF_SHOWN(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  await assert.rejects(context.go({ clearAppSecrets: true }), /is no longer attached/);
});

test("I3: the operator gets Key Vault Secrets Officer before any vault read, from the token's oid, and the run waits out propagation", async (t) => {
  const cloud = withAppleKeyInVault(emptyCloud());
  cloud.propagation = 2;
  const context = setup(t, { cloud });
  await context.go();
  const grant = context.fake.calls.findIndex(({ args }) => args.slice(0, 3).join(" ") === "role assignment create" && args.includes(OPERATOR));
  const firstVaultRead = context.fake.calls.findIndex(({ args }) => args[0] === "keyvault" && args[1] === "secret");
  assert.ok(grant !== -1 && grant < firstVaultRead);
  assert.deepEqual(cloud.roles.filter(({ principalId }) => principalId === OPERATOR).map(({ role, scope, principalType }) => [role, scope, principalType]), [["Key Vault Secrets Officer", VAULT_ID, "User"]]);
  assert.match(context.logs.join("\n"), /retrying/);
  assertNoneOf(everythingShown(context), [OPERATOR_TOKEN]);
});

test("I3: --seed-ari grants the operator Storage Table Data Contributor on that env's accounts storage before seeding, and retries while it propagates", async (t) => {
  const cloud = withAppleKeyInVault(emptyCloud());
  cloud.storeRbac = true;
  cloud.storePropagation = 2;
  const context = setup(t, { cloud });
  await context.go({ seedAri: true });
  const storageRole = cloud.roles.find(({ principalId, role }) => principalId === OPERATOR && role === "Storage Table Data Contributor");
  assert.match(storageRole.scope, /storageAccounts\/stouroacctstest261e0b$/);
  assert.equal(storageRole.principalType, "User");
  assert.ok(context.readRecord().ari.accountId);
});

test("I3: --invite-ari also uses the operator's storage role", async (t) => {
  const cloud = emptyCloud();
  cloud.storeRbac = true;
  const storage = { account: "stouroacctstest261e0b", id: "/subscriptions/s/resourceGroups/rg-ouro-identity/providers/Microsoft.Storage/storageAccounts/stouroacctstest261e0b", endpoint: "https://stouroacctstest261e0b.table.core.windows.net" };
  const context = setup(t, { cloud, record: { storage, ari: { accountId: "acct-ari-test", githubUserId: 16390116, githubLogin: "arimendelow" } } });
  cloud.roles.push({ principalId: OPERATOR, role: "Storage Table Data Contributor", scope: storage.id });
  await context.store.ensureTables();
  await context.store.putAccount({ accountId: "acct-ari-test", displayName: "Ari Mendelow", deskAccess: true });
  await context.go({ inviteAri: true });
  assert.match(context.logs.join("\n"), /\/invite\//);
});

test("I4: a first run and a dry run work before the GitHub environment exists, and list its variables only once it does", async (t) => {
  const dry = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  await dry.go({ dryRun: true });
  assert.ok(!dry.fake.calls.some(({ cmd, args }) => cmd === "gh" && args[0] === "variable" && args[1] === "list"));
  const real = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  await real.go();
  assert.ok(real.cloud.gh.env);
});

test("I5: a create that Graph doesn't show yet is waited for, never created twice", async (t) => {
  const cloud = withAppleKeyInVault(emptyCloud());
  cloud.graphLag = 3;
  const context = setup(t, { cloud });
  await context.go();
  assert.equal(cloud.graph.apps.filter(({ displayName }) => displayName === "ouro-desk-hosted").length, 1);
  assert.equal(cloud.graph.apps.filter(({ displayName }) => displayName === "ouro-identity-automation").length, 1);
  assert.equal(cloud.graph.flows.length, 1);
  assert.equal(cloud.graph.sps.length, 2);

  const stuck = withAppleKeyInVault(emptyCloud());
  stuck.graphLag = 1000;
  const second = setup(t, { cloud: stuck });
  await assert.rejects(second.go(), /Graph doesn't show it yet/);
  assert.equal(stuck.graph.apps.length, 1);
});

test("I5: two app registrations with the gateway's name stop the run instead of picking one", async (t) => {
  const context = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  await context.go();
  context.cloud.graph.apps.push({ ...structuredClone(context.cloud.graph.apps[0]), appId: "dup", id: "dup" });
  await assert.rejects(context.go(), /2 app registrations named ouro-desk-hosted/);
});

test("M1: the Apple provider is created with slot b when slot a is tagged revoked", async (t) => {
  const cloud = emptyCloud();
  const keyB = APPLE_KEY.replace("APPLEKEY", "BPPLEKEY");
  cloud.vault.secrets["apple-siwa-key-a-test"] = { value: APPLE_KEY, tags: { revoked: "2026-10-30" } };
  cloud.vault.secrets["apple-siwa-key-b-test"] = { value: keyB, tags: {} };
  const context = setup(t, { cloud });
  await context.go();
  const provider = cloud.graph.providers[0];
  assert.equal(provider.keyId, "KEYIDBBBBB");
  assert.equal(provider.certificateData, keyB);
});

test("M2: --seed-ari leaves an existing account as it is, access off and binding included", async (t) => {
  const context = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  await context.go({ seedAri: true });
  const { accountId } = context.readRecord().ari;
  await context.store.putAccount({ accountId, displayName: "Ari Mendelow", deskAccess: false });
  await context.store.putBinding(accountId, { kind: "github", repo: "arimendelow/other", author: { name: "Ari", email: "a@example.com" } });
  await context.go({ seedAri: true });
  assert.equal((await context.store.getAccount(accountId)).deskAccess, false);
  assert.equal((await context.store.getBinding(accountId)).repo, "arimendelow/other");
});

test("M7: a dry run leaves identity-<env>.json untouched", async (t) => {
  const context = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  const before = readFileSync(join(context.recordDir, "identity-test.json"), "utf8");
  await context.go({ dryRun: true });
  assert.equal(readFileSync(join(context.recordDir, "identity-test.json"), "utf8"), before);
});

test("M8: an import whose revoked tag survives the write fails and keeps the file", async (t) => {
  const cloud = emptyCloud();
  cloud.keepTagsOnSet = true;
  cloud.vault.secrets["apple-siwa-key-a-test"] = { value: "old", tags: { revoked: "2026-10-30" } };
  const context = setup(t, { cloud });
  const file = appleFile(context.dir);
  await assert.rejects(context.go({ appleKeyFile: file, appleKeySlot: "a" }), /still carries a revoked tag/);
  assert.ok(existsSync(file));
});

test("M9: --copy-app-secrets refuses a production secret that is still unset, and writes nothing", async (t) => {
  const context = setup(t);
  addContainerApp(context.cloud, { name: "ouro-desk-hosted", shown: { ...shownFixture, name: "ouro-desk-hosted" }, secrets: { ...APP_SECRETS, "desk-app-key": "unset" } });
  const staging = addStaging(context.cloud, { shown: shownFixture, secrets: { "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  await assert.rejects(context.go({ copyAppSecrets: true }), /desk-app-key is not set/);
  assert.equal(staging.updates.length, 0);
});

const reconciledState = () => ({
  tenant: { id: TEST_TENANT, name: "ourobottest" },
  graph: true,
  storage: { account: "stouroacctstest261e0b", id: "/st", endpoint: "https://x", sharedKey: false, tls: "TLS1_2" },
  vaultId: VAULT_ID,
  vaultSecrets: ["entra-client-secret-test"],
  gatewayApp: { appId: "g", redirects: [], tokenVersion: 2, passwords: 1, servicePrincipalId: "sp" },
});

test("M10: the gateway secret is made again when either Key Vault or the app lacks it", () => {
  const names = (state) => plan({ env: "test", state }).map(({ name }) => name);
  assert.ok(!names(reconciledState()).includes("gateway client secret"));
  assert.ok(names({ ...reconciledState(), vaultSecrets: [] }).includes("gateway client secret"));
  assert.ok(names({ ...reconciledState(), gatewayApp: { ...reconciledState().gatewayApp, passwords: 0 } }).includes("gateway client secret"));
});

test("M13: storage that allows shared keys or old TLS is corrected", () => {
  const names = (storage) => plan({ env: "test", state: { ...reconciledState(), storage: { ...reconciledState().storage, ...storage } } }).map(({ name }) => name);
  assert.ok(!names({}).includes("storage account settings"));
  assert.ok(names({ sharedKey: true }).includes("storage account settings"));
  assert.ok(names({ tls: "TLS1_0" }).includes("storage account settings"));
});

test("M14: an existing user flow without Apple gets the Apple provider linked", async (t) => {
  const cloud = withAppleKeyInVault(emptyCloud());
  cloud.graph.providers.push({ id: "Apple-Managed-OIDC", "@odata.type": "#microsoft.graph.appleManagedIdentityProvider" });
  cloud.graph.flows.push({ id: "flow-1", displayName: "Ouro sign-in", idps: ["EmailOtpSignup-OAUTH"], apps: [] });
  const context = setup(t, { cloud });
  await context.go();
  assert.deepEqual(cloud.graph.flows[0].idps, ["EmailOtpSignup-OAUTH", "Apple-Managed-OIDC"]);
});

test("m1: a gateway secret that Key Vault refuses is removed from the app again", async (t) => {
  const cloud = withAppleKeyInVault(emptyCloud());
  const context = setup(t, { cloud });
  const runner = context.fake.runner;
  const failing = async (cmd, args, options) => {
    if (args.includes("entra-client-secret-test") && args[2] === "set") throw Object.assign(new Error("az keyvault secret set failed"), { stderr: "ERROR: BadRequest" });
    return runner(cmd, args, options);
  };
  await assert.rejects(context.go({}, { runner: failing }));
  const app = cloud.graph.apps.find(({ displayName }) => displayName === "ouro-desk-hosted");
  assert.deepEqual(app.passwordCredentials, []);
});

test("m3: one action at a time, and seeding still runs when the Apple step stops", async (t) => {
  assert.throws(() => parseFlags(["--env", "test", "--seed-ari", "--invite-ari"]), /one action at a time/);
  const context = setup(t, { cloud: withAppleKeyInVault(emptyCloud()), record: { apple: { outcome: "B", serviceId: "bot.ouro.identity.test", keyIds: {} } } });
  await assert.rejects(context.go({ seedAri: true }), /admin center/);
  assert.ok(context.readRecord().ari.accountId);
});

test("m4: the default runner's error names the command's first words and stderr, never later arguments or stdin", async () => {
  const error = await defaultRunner(process.execPath, ["-e", "process.stdin.resume(); process.stderr.write('ERROR: refused\\n'); process.exit(3)", "--", "SECRET-ARGUMENT"], { input: "SECRET-INPUT" }).catch((caught) => caught);
  assert.match(error.message, /failed: ERROR: refused/);
  assert.ok(!error.message.includes("SECRET-ARGUMENT") && !error.message.includes("SECRET-INPUT"));
  assert.equal((await defaultRunner(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "piped" })).stdout, "piped");
});

// --- Fix round 2 ------------------------------------------------------------------------------------------------

const PROD_PULL_ID = "/subscriptions/261e0bf1-934d-41ab-9295-229b0d254418/resourceGroups/rg-ouro-work-substrate/providers/Microsoft.ManagedIdentity/userAssignedIdentities/ouro-prod-services-mi";

test("N-I1: a test-env run never names production's pull identity, and a staging write refuses an app that holds it", async (t) => {
  const { go, fake, logs } = setup(t, { cloud: withAppleKeyInVault(emptyCloud()) });
  addStaging(fake.cloud, { shown: KV_REF_SHOWN(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  await go();
  await go({ clearAppSecrets: true });
  assert.ok(!everythingShown({ logs, fake }).includes("ouro-prod-services-mi"));
  const held = setup(t);
  const shown = KV_REF_SHOWN();
  shown.identity.userAssignedIdentities[PROD_PULL_ID] = {};
  addStaging(held.cloud, { shown, secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  await assert.rejects(held.go({ clearAppSecrets: true }), /must not hold identity ouro-prod-services-mi/);
  assert.equal(held.cloud.containerApps["ouro-desk-hosted-staging"].updates.length, 0);
  // The check after a write refuses it too, should a write ever bring it back.
  const after = setup(t);
  addStaging(after.cloud, { shown: KV_REF_SHOWN(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  const app = after.cloud.containerApps["ouro-desk-hosted-staging"];
  const onUpdate = app.onUpdate;
  app.onUpdate = (updated) => {
    onUpdate(updated);
    updated.shown.properties.configuration.registries[0].identity = PROD_PULL_ID;
  };
  await assert.rejects(after.go({ clearAppSecrets: true }), /must not hold identity ouro-prod-services-mi after the write/);
});

test("N-m1: when listSecrets returns a Key Vault reference without a value, az's KeyError becomes a clear message and the app is unchanged", async (t) => {
  const { go, fake } = setup(t);
  fake.cloud.refsWithoutValue = true;
  addStaging(fake.cloud, { shown: KV_REF_SHOWN(), secrets: { ...APP_SECRETS, "desk-signing-key": SIGNING, "desk-client-key": SIGNING } });
  const before = structuredClone(fake.cloud.containerApps["ouro-desk-hosted-staging"].shown);
  await assert.rejects(go({ clearAppSecrets: true }), (error) => {
    assert.match(error.message, /listSecrets returned a Key Vault reference without a value/);
    assert.match(error.message, /Nothing was sent; the app is unchanged/);
    assert.ok(!error.message.includes("Traceback"));
    return true;
  });
  assert.deepEqual(fake.cloud.containerApps["ouro-desk-hosted-staging"].shown, before);
  assert.deepEqual(fake.cloud.containerApps["ouro-desk-hosted-staging"].restarts, []);
});
