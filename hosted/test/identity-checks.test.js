// identity-checks.mjs and .github/workflows/identity-checks.yml against a recording fake az. Nothing here reaches
// Azure, Graph or GitHub. These cover Review Focus 8 (no key material in output or argv) and 11 (the renewal never
// sends a key tagged revoked).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertText, ALERT_PHRASES, main, parseFlags, runChecks } from "../infra/identity-checks.mjs";

const NOW = Date.parse("2026-10-10T06:00:00Z");
const DAY = 24 * 3600 * 1000;
const TENANT = "c12edfb6-c5ab-4bf8-b1d5-1f053311d396";
const PROD_TENANT = "de8841c3-7799-4523-bbad-44f8a2426eaa";
const OTHER_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const GATEWAY_OBJECT = "0b0b0b0b-0000-4000-8000-00000000000b";
const GATEWAY_APP_ID = "0c0c0c0c-0000-4000-8000-00000000000c";
const ACCOUNT = "acct_7Qx2Lm9PzW4n";
const KEY_A = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgAPPLEKEYSLOTAAAAAA\n-----END PRIVATE KEY-----\n";
const KEY_B = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgAPPLEKEYSLOTBBBBBB\n-----END PRIVATE KEY-----\n";
const SECRET_HINT = "Gw~";
const GRAPH = "https://graph.microsoft.com/v1.0/";
const iso = (ms) => new Date(ms).toISOString();

class CallFailed extends Error {
  constructor(message, stderr) {
    super(message);
    this.stderr = stderr;
  }
}

function record(env, { outcome = "A", releasedAt = null, legacyCutoff = null, gatewayApp = { appId: GATEWAY_APP_ID, objectId: GATEWAY_OBJECT } } = {}) {
  return {
    env,
    tenant: { name: env === "prod" ? "ourobot" : "ourobottest", subdomain: env === "prod" ? "ourobot" : "ourobottest", id: env === "prod" ? PROD_TENANT : TENANT },
    gatewayApp,
    apple: { outcome, developerId: "TEAMID1234", serviceId: "bot.ouro.identity.test", keyIds: { a: "KEYIDAAAAA", b: "KEYIDBBBBB" }, providerId: "Apple-Managed-OIDC" },
    ari: { accountId: ACCOUNT, githubUserId: 16390116, githubLogin: "arimendelow" },
    legacyCutoff,
    releasedAt,
  };
}

// A cloud where every check passes: a gateway secret ending in 11 months, Apple renewed 10 days ago on slot a.
function healthyCloud(env = "test") {
  return {
    tenantId: env === "prod" ? PROD_TENANT : TENANT,
    passwordCredentials: [
      { keyId: "k-old", endDateTime: iso(NOW + 5 * DAY), hint: SECRET_HINT, displayName: "desk-gateway-old" },
      { keyId: "k-new", endDateTime: iso(NOW + 330 * DAY), hint: SECRET_HINT, displayName: "desk-gateway-new" },
    ],
    provider: { id: "Apple-Managed-OIDC", "@odata.type": "#microsoft.graph.appleManagedIdentityProvider", keyId: "KEYIDAAAAA", certificateData: KEY_A },
    patchFailure: null,
    vault: {
      [`apple-siwa-key-a-${env}`]: { value: KEY_A, tags: { "imported-at": iso(NOW - 40 * DAY) } },
      [`apple-siwa-key-b-${env}`]: { value: KEY_B, tags: { "imported-at": iso(NOW - 40 * DAY) } },
      [`apple-siwa-active-${env}`]: { value: "a", tags: { "apple-renewed-at": iso(NOW - 10 * DAY) } },
    },
    appEnv: {
      "ouro-desk-hosted": [
        { name: "DESK_GITHUB_ACCOUNTS", value: `16390116=${ACCOUNT}` },
        { name: "DESK_LEGACY_CUTOFF", value: iso(NOW + 10 * DAY) },
        { name: "DESK_SIGNING_KEY", secretRef: "desk-signing-key" },
      ],
    },
  };
}

function fakeAz(cloud) {
  const calls = [];
  const opt = (args, flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const json = (value) => ({ stdout: `${JSON.stringify(value)}\n` });
  const tsv = (value) => ({ stdout: `${value}\n` });
  const notFound = (what) => {
    throw new CallFailed(`not found: ${what}`, `ERROR: (SecretNotFound) A secret with (name/id) ${what} was not found in this key vault. HTTP 404`);
  };
  function graph(method, url, body) {
    const path = url.slice(GRAPH.length).split("?")[0];
    if (path === `applications/${GATEWAY_OBJECT}` && method === "get") return { id: GATEWAY_OBJECT, appId: GATEWAY_APP_ID, passwordCredentials: cloud.passwordCredentials };
    if (path === `identity/identityProviders/${cloud.provider?.id}`) {
      if (method === "get") {
        const { certificateData, ...shown } = cloud.provider;
        void certificateData;
        return shown;
      }
      if (method === "patch") {
        if (cloud.patchFailure) throw new CallFailed("az rest failed", cloud.patchFailure);
        Object.assign(cloud.provider, body);
        cloud.patches.push(body);
        return null;
      }
    }
    if (path === "identity/identityProviders" && method === "get") return { value: cloud.provider ? [(({ certificateData, ...rest }) => rest)(cloud.provider)] : [] };
    throw new CallFailed(`fake Graph has no ${method} ${path}`, "");
  }
  async function runner(cmd, args, { input } = {}) {
    calls.push({ cmd, args: [...args], input });
    if (cmd !== "az") throw new CallFailed(`fake has no ${cmd}`, "");
    const joined = args.join(" ");
    if (joined.startsWith("account show")) return tsv(cloud.tenantId);
    if (args[0] === "rest") {
      const result = graph(opt(args, "--method"), opt(args, "--url"), input ? JSON.parse(input) : undefined);
      return result === null ? { stdout: "" } : json(result);
    }
    if (joined.startsWith("keyvault secret show")) {
      const secret = cloud.vault[opt(args, "--name")] ?? notFound(opt(args, "--name"));
      if (opt(args, "--query") === "tags") return json(secret.tags);
      return tsv(secret.value);
    }
    if (joined.startsWith("keyvault secret set")) {
      const tags = {};
      const index = args.indexOf("--tags");
      if (index !== -1) for (let i = index + 1; i < args.length && !args[i].startsWith("--"); i += 1) tags[args[i].split("=")[0]] = args[i].slice(args[i].indexOf("=") + 1);
      cloud.vault[opt(args, "--name")] = { value: input, tags };
      cloud.sets.push({ name: opt(args, "--name"), at: calls.length });
      return tsv("https://kv/secrets/x/v2");
    }
    if (joined.startsWith("containerapp show")) {
      const env = cloud.appEnv[opt(args, "-n")] ?? notFound(opt(args, "-n"));
      // As the query --query "properties.template.containers[].env[] | [?value || secretRef].name" prints it.
      return json(env.filter((entry) => entry.value || entry.secretRef).map(({ name }) => name));
    }
    throw new CallFailed(`fake az has no ${joined}`, "");
  }
  cloud.patches ??= [];
  cloud.sets ??= [];
  return { runner, calls };
}

function setup(t, { env = "test", rec = record(env), cloud = healthyCloud(env) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "desk-identity-checks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, `identity-${env}.json`), JSON.stringify(rec));
  const fake = fakeAz(cloud);
  const logs = [];
  const go = (options = {}) => runChecks({ env, runner: fake.runner, now: () => NOW, recordDir: dir, log: (line) => logs.push(line), ...options });
  // The command line, with its streams captured.
  const cli = async (argv) => {
    const out = [];
    const err = [];
    const code = await main(argv, { runner: fake.runner, now: () => NOW, recordDir: dir, stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
    return { code, stdout: out.join(""), stderr: err.join("") };
  };
  return { dir, cloud, fake, logs, go, cli };
}

const failed = (result) => result.results.filter(({ ok }) => !ok).map(({ check }) => check);
const patchCalls = (fake) => fake.calls.filter(({ args }) => args[0] === "rest" && args.includes("patch"));
const markerTag = (cloud, env = "test") => cloud.vault[`apple-siwa-active-${env}`]?.tags["apple-renewed-at"];

// --- The plan's tests -------------------------------------------------------------------------------------------

test("refuses when the Graph tenant isn't the file's tenant", async (t) => {
  const { go, fake, cloud, cli } = setup(t);
  cloud.tenantId = OTHER_TENANT;
  const result = await go({ renewApple: true });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ["graph-tenant"]);
  // Nothing past the tenant check runs: no Graph read, no Key Vault, no app read, no PATCH.
  assert.deepEqual(fake.calls.map(({ args }) => args.slice(0, 2).join(" ")), ["account show"]);
  const { code, stderr } = await cli(["--env", "test"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /^identity-checks: graph-tenant: az's current account is not in this env's Ouro tenant/m);
  assert.equal(stderr.trim().split("\n").length, 1, "one line");
});

test("renewal writes apple-renewed-at only after a 2xx PATCH and alternates key slots", async (t) => {
  const { go, fake, cloud } = setup(t);
  const result = await go({ renewApple: true });
  assert.equal(result.ok, true, JSON.stringify(result.results));
  assert.equal(cloud.patches.length, 1);
  assert.deepEqual(cloud.patches[0], { "@odata.type": "#microsoft.graph.appleManagedIdentityProvider", keyId: "KEYIDBBBBB", certificateData: KEY_B });
  // The tag is written after the PATCH, never before.
  const patchIndex = fake.calls.findIndex(({ args }) => args[0] === "rest" && args.includes("patch"));
  const setIndex = fake.calls.findIndex(({ args }) => args.slice(0, 3).join(" ") === "keyvault secret set");
  assert.ok(patchIndex !== -1 && setIndex > patchIndex);
  assert.equal(markerTag(cloud), iso(NOW));
  assert.equal(cloud.vault["apple-siwa-active-test"].value, "b");
  // The key went through stdin only, and the PATCH body is the only input that held it.
  assert.ok(!fake.calls.some(({ args }) => args.some((arg) => arg.includes("PRIVATE KEY"))));
  // Next month the other slot goes back.
  const second = await go({ renewApple: true, now: () => NOW + 31 * DAY });
  assert.equal(second.ok, true);
  assert.equal(cloud.patches[1].keyId, "KEYIDAAAAA");
  assert.equal(cloud.patches[1].certificateData, KEY_A);
  assert.equal(cloud.vault["apple-siwa-active-test"].value, "a");
});

test("renewal never sends a slot tagged revoked, re-sends the live slot and exits non-zero", async (t) => {
  const { go, cloud, fake, cli } = setup(t);
  cloud.vault["apple-siwa-key-b-test"].tags.revoked = "2026-10-01";
  const before = markerTag(cloud);
  const result = await go({ renewApple: true });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ["apple-renewal"]);
  assert.equal(cloud.patches.length, 1);
  assert.equal(cloud.patches[0].keyId, "KEYIDAAAAA");
  assert.equal(cloud.patches[0].certificateData, KEY_A);
  // The revoked key is never even read, and a re-send can't prove a new client secret, so the age keeps counting.
  assert.ok(!fake.calls.some(({ args }) => args.includes("apple-siwa-key-b-test") && args.includes("value")));
  assert.equal(markerTag(cloud), before);
  const { code, stderr } = await cli(["--env", "test", "--renew-apple"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /apple-renewal: the next key slot is revoked or missing/);
});

test("a slot that was never imported counts as unusable, and with both slots unusable nothing is sent", async (t) => {
  const { go, cloud } = setup(t);
  delete cloud.vault["apple-siwa-key-b-test"];
  const resent = await go({ renewApple: true });
  assert.deepEqual(failed(resent), ["apple-renewal"]);
  assert.equal(cloud.patches.at(-1).keyId, "KEYIDAAAAA");
  cloud.vault["apple-siwa-key-a-test"].tags.revoked = "2026-10-02";
  const count = cloud.patches.length;
  const none = await go({ renewApple: true });
  assert.deepEqual(failed(none), ["apple-renewal"]);
  assert.equal(cloud.patches.length, count, "no PATCH when neither slot is usable");
  assert.ok(none.results.find(({ check }) => check === "apple-renewal").code === "no-usable-slot");
});

test("a live slot tagged revoked is replaced by the other slot as a normal renewal", async (t) => {
  const { go, cloud } = setup(t);
  cloud.vault["apple-siwa-key-a-test"].tags.revoked = "2026-10-02";
  const result = await go({ renewApple: true });
  assert.equal(result.ok, true);
  assert.equal(cloud.patches[0].keyId, "KEYIDBBBBB");
  assert.equal(markerTag(cloud), iso(NOW));
});

test("a 4xx PATCH leaves the tag unchanged and exits non-zero", async (t) => {
  const { go, cloud, cli } = setup(t);
  cloud.patchFailure = `ERROR: Bad Request({"error":{"code":"Request_BadRequest","message":"Invalid key"}})`;
  const before = structuredClone(cloud.vault["apple-siwa-active-test"]);
  const result = await go({ renewApple: true });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ["apple-renewal"]);
  assert.deepEqual(cloud.vault["apple-siwa-active-test"], before);
  assert.deepEqual(cloud.sets, []);
  const { code, stderr } = await cli(["--env", "test", "--renew-apple"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /apple-renewal: Graph refused the update; the renewal date is unchanged/);
});

test("alerts when the Entra client secret ends within 30 days", async (t) => {
  const { go, cloud } = setup(t);
  assert.equal((await go()).ok, true, "the newest credential counts, not an older one about to end");
  cloud.passwordCredentials[1].endDateTime = iso(NOW + 29 * DAY);
  const soon = await go();
  assert.deepEqual(failed(soon), ["entra-client-secret"]);
  const entry = soon.results.find(({ check }) => check === "entra-client-secret");
  assert.equal(entry.code, "ends-soon");
  assert.deepEqual(entry.dates, ["2026-11-08"]);
  cloud.passwordCredentials = [{ keyId: "k", endDateTime: iso(NOW - DAY), hint: SECRET_HINT }];
  assert.equal((await go()).results.find(({ check }) => check === "entra-client-secret").code, "ended");
  cloud.passwordCredentials = [];
  assert.equal((await go()).results.find(({ check }) => check === "entra-client-secret").code, "none");
});

test("the gateway app is read by object id, selecting passwordCredentials only", async (t) => {
  const { go, fake } = setup(t);
  await go();
  const read = fake.calls.find(({ args }) => args[0] === "rest" && args.some((arg) => arg.includes("applications/")));
  assert.equal(read.args[read.args.indexOf("--url") + 1], `${GRAPH}applications/${GATEWAY_OBJECT}?$select=passwordCredentials`);
});

test("alerts when the Apple secret is older than 5 months", async (t) => {
  const { go, cloud } = setup(t);
  cloud.vault["apple-siwa-active-test"].tags["apple-renewed-at"] = "2026-05-01T06:00:00.000Z";
  const old = await go();
  assert.deepEqual(failed(old), ["apple-secret-age"]);
  const entry = old.results.find(({ check }) => check === "apple-secret-age");
  assert.equal(entry.code, "ends-soon");
  assert.deepEqual(entry.dates, ["2026-05-01", "2026-11-01"]);
  // Four months old is fine: the six-month secret ends more than 30 days out.
  cloud.vault["apple-siwa-active-test"].tags["apple-renewed-at"] = "2026-06-12T06:00:00.000Z";
  assert.equal((await go()).ok, true);
  // No recorded renewal is an alert too.
  delete cloud.vault["apple-siwa-active-test"];
  assert.equal((await go()).results.find(({ check }) => check === "apple-secret-age").code, "unrecorded");
});

test("alerts when production has no cutoff a day after releasedAt", async (t) => {
  const released = iso(NOW - 2 * DAY);
  const { go, cloud } = setup(t, { env: "prod", rec: record("prod", { releasedAt: released }) });
  cloud.appEnv["ouro-desk-hosted"] = cloud.appEnv["ouro-desk-hosted"].filter(({ name }) => name !== "DESK_LEGACY_CUTOFF");
  const missing = await go();
  assert.deepEqual(failed(missing), ["legacy-cutoff"]);
  assert.deepEqual(missing.results.find(({ check }) => check === "legacy-cutoff").dates, ["2026-10-08"]);
  // Within a day of the release it isn't due yet.
  assert.equal((await go({ now: () => Date.parse(released) + 23 * 3600 * 1000 })).ok, true);
  // Set on the app: fine.
  cloud.appEnv["ouro-desk-hosted"].push({ name: "DESK_LEGACY_CUTOFF", value: iso(NOW + 12 * DAY) });
  assert.equal((await go()).ok, true);
  // An empty value counts as unset.
  cloud.appEnv["ouro-desk-hosted"].at(-1).value = "";
  assert.deepEqual(failed(await go()), ["legacy-cutoff"]);
});

test("the cutoff check is production's only, and waits for releasedAt", async (t) => {
  const testRun = setup(t);
  await testRun.go();
  assert.ok(!testRun.fake.calls.some(({ args }) => args[0] === "containerapp"));
  const prod = setup(t, { env: "prod", rec: record("prod", { releasedAt: null }) });
  prod.cloud.appEnv["ouro-desk-hosted"] = [];
  const result = await prod.go();
  assert.equal(result.ok, true);
  assert.equal(result.results.find(({ check }) => check === "legacy-cutoff").code, "not-released");
});

test("no key material appears in stdout, stderr or argv", async (t) => {
  for (const scenario of ["renew", "revoked", "refused", "all-failing"]) {
    const { cloud, fake, cli, dir } = setup(t);
    if (scenario === "revoked") cloud.vault["apple-siwa-key-b-test"].tags.revoked = "2026-10-01";
    if (scenario === "refused") cloud.patchFailure = `ERROR: Bad Request({"error":{"message":"certificateData ${KEY_B.split("\n")[1]} is invalid"}})`;
    if (scenario === "all-failing") {
      cloud.passwordCredentials = [{ keyId: "k", endDateTime: iso(NOW + DAY), hint: SECRET_HINT }];
      cloud.vault["apple-siwa-active-test"].tags["apple-renewed-at"] = "2026-01-01T00:00:00Z";
    }
    const alertFile = join(dir, "alert.md");
    const { stdout, stderr } = await cli(["--env", "test", "--renew-apple", "--alert-file", alertFile]);
    const argv = fake.calls.map(({ cmd, args }) => [cmd, ...args].join(" ")).join("\n");
    // Inputs other than the PATCH (the marker's slot letter) carry no key either.
    const otherInputs = fake.calls.filter(({ args }) => !(args[0] === "rest" && args.includes("patch"))).map(({ input }) => input ?? "").join("\n");
    const alert = existsSync(alertFile) ? readFileSync(alertFile, "utf8") : "";
    for (const text of [stdout, stderr, argv, otherInputs, alert]) {
      for (const key of [KEY_A, KEY_B]) {
        assert.ok(!text.includes(key.split("\n")[1]), `${scenario}: key material appeared`);
        assert.ok(!text.includes(key.split("\n")[1].slice(-20)), `${scenario}: part of a key appeared`);
      }
      assert.ok(!text.includes(ACCOUNT), `${scenario}: an accountId appeared`);
      assert.ok(!text.includes(SECRET_HINT), `${scenario}: the client secret's hint appeared`);
    }
  }
});

test("the alert text holds only check names and dates", async (t) => {
  // Every check failing in every way it can, each rendered into the alert.
  const { cloud, cli, dir } = setup(t, { env: "prod", rec: record("prod", { releasedAt: iso(NOW - 3 * DAY) }) });
  cloud.passwordCredentials = [{ keyId: "k", endDateTime: iso(NOW + 2 * DAY), hint: SECRET_HINT }];
  cloud.vault["apple-siwa-active-prod"].tags["apple-renewed-at"] = "2026-03-01T00:00:00Z";
  cloud.vault["apple-siwa-key-b-prod"].tags.revoked = "2026-10-01";
  cloud.appEnv["ouro-desk-hosted"] = [{ name: "DESK_GITHUB_ACCOUNTS", value: `16390116=${ACCOUNT}` }];
  const alertFile = join(dir, "alert.md");
  const { code } = await cli(["--env", "prod", "--renew-apple", "--alert-file", alertFile]);
  assert.notEqual(code, 0);
  const alert = readFileSync(alertFile, "utf8");
  const lines = alert.trim().split("\n");
  assert.equal(lines[0], "Identity checks for prod failed on 2026-10-10.");
  const allowed = new Set(Object.entries(ALERT_PHRASES).flatMap(([check, phrases]) => Object.values(phrases).map((phrase) => `- ${check}: ${phrase}`)));
  const body = lines.slice(1).filter(Boolean);
  assert.equal(body.length, 4, alert);
  for (const line of body) assert.ok(allowed.has(line.replace(/\d{4}-\d{2}-\d{2}/g, "{date}")), `not a known phrase: ${line}`);
  for (const id of [ACCOUNT, PROD_TENANT, GATEWAY_OBJECT, GATEWAY_APP_ID, "KEYIDAAAAA", "KEYIDBBBBB", "Apple-Managed-OIDC", "TEAMID1234", SECRET_HINT]) assert.ok(!alert.includes(id), `alert holds ${id}`);
  // A read that fails renders as a fixed phrase, never as az's error text.
  const failing = alertText({ env: "test", now: NOW, results: [{ check: "entra-client-secret", ok: false, code: "unreadable", dates: [], detail: `tenant ${TENANT} said no for ${ACCOUNT}` }] });
  assert.ok(!failing.includes(TENANT) && !failing.includes(ACCOUNT));
});

// --- Outcomes, flags and the outcome-B record ---------------------------------------------------------------------

test("--renew-apple runs only under outcome A; with null or B the checks alert from the tag age and send nothing", async (t) => {
  for (const outcome of [null, "B"]) {
    const { go, cloud } = setup(t, { rec: record("test", { outcome }) });
    const refused = await go({ renewApple: true });
    assert.deepEqual(failed(refused), ["apple-renewal"]);
    assert.equal(refused.results.find(({ check }) => check === "apple-renewal").code, "not-outcome-a");
    assert.deepEqual(cloud.patches, []);
    // The daily run still checks the age of the last manual upload.
    cloud.vault["apple-siwa-active-test"].tags["apple-renewed-at"] = "2026-04-01T00:00:00Z";
    const daily = await go();
    assert.deepEqual(failed(daily), ["apple-secret-age"]);
    assert.deepEqual(cloud.patches, []);
  }
});

test("--record-apple-upload records a manual upload once Graph shows that slot's key, and refuses otherwise", async (t) => {
  const { go, cloud } = setup(t, { rec: record("test", { outcome: "B" }) });
  delete cloud.vault["apple-siwa-active-test"];
  const wrong = await go({ recordAppleUpload: "b" });
  assert.equal(wrong.ok, false);
  assert.equal(cloud.vault["apple-siwa-active-test"], undefined);
  const right = await go({ recordAppleUpload: "a" });
  assert.equal(right.ok, true, JSON.stringify(right.results));
  assert.equal(cloud.vault["apple-siwa-active-test"].value, "a");
  assert.equal(markerTag(cloud), iso(NOW));
  assert.deepEqual(cloud.patches, []);
});

test("the command line takes --env, --renew-apple, --record-apple-upload and --alert-file, one action at a time", () => {
  assert.deepEqual(parseFlags(["--env", "prod"]), { env: "prod", renewApple: false, recordAppleUpload: undefined, alertFile: undefined });
  assert.deepEqual(parseFlags(["--env", "test", "--renew-apple", "--alert-file", "/x"]), { env: "test", renewApple: true, recordAppleUpload: undefined, alertFile: "/x" });
  assert.throws(() => parseFlags(["--env", "staging"]), /--env must be test or prod/);
  assert.throws(() => parseFlags(["--env", "test", "--renew-apple", "--record-apple-upload", "a"]), /one action/);
  assert.throws(() => parseFlags(["--env", "test", "--record-apple-upload", "c"]), /a or b/);
});

test("a passing run exits 0, prints one ok line per check and writes no alert", async (t) => {
  const { cli, dir } = setup(t, { env: "prod", rec: record("prod", { releasedAt: iso(NOW - 5 * DAY) }) });
  const alertFile = join(dir, "alert.md");
  const { code, stdout, stderr } = await cli(["--env", "prod", "--alert-file", alertFile]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(stdout.trim().split("\n").filter((line) => /^(ok|FAIL) /.test(line)).map((line) => line.split(":")[0]), ["ok graph-tenant", "ok entra-client-secret", "ok apple-secret-age", "ok legacy-cutoff"]);
  assert.equal(stderr, "");
  assert.equal(existsSync(alertFile), false);
});

test("a failing read is an alert with a fixed phrase, and the other checks still run", async (t) => {
  const { go, cloud } = setup(t);
  cloud.passwordCredentials = undefined;
  const original = cloud.vault;
  cloud.vault = new Proxy(original, { get: (target, name) => (name === "apple-siwa-active-test" ? (() => { throw new Error("boom"); })() : target[name]) });
  const result = await go();
  assert.ok(failed(result).includes("apple-secret-age"));
  assert.ok(result.results.some(({ check }) => check === "entra-client-secret"));
});

// --- The workflow -----------------------------------------------------------------------------------------------

const workflow = readFileSync(new URL("../../.github/workflows/identity-checks.yml", import.meta.url), "utf8");

test("the workflow runs daily at 06:00 UTC for both envs in the identity environment, from main only", () => {
  assert.match(workflow, /^ {4}- cron: "0 6 \* \* \*"$/m);
  assert.match(workflow, /^ {4}environment: identity$/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /- env: test\n\s+tenant: OURO_TENANT_ID_TEST\n\s+automation: OURO_AUTOMATION_CLIENT_ID_TEST/);
  assert.match(workflow, /- env: prod\n\s+tenant: OURO_TENANT_ID_PROD\n\s+automation: OURO_AUTOMATION_CLIENT_ID_PROD/);
  assert.match(workflow, /args=\(--env "\$ENV" /);
  assert.match(workflow, /node hosted\/infra\/identity-checks\.mjs "\$\{args\[@\]\}"/);
});

test("the workflow signs in twice: the checks identity for Azure, then the automation app for the tenant", async () => {
  const { CHECKS_IDENTITY } = await import("../infra/identity-record.mjs");
  const logins = [...workflow.matchAll(/uses: azure\/login@v2\n\s+with:\n((?:\s+[a-z-]+: .+\n)+)/g)].map((match) => match[1]);
  assert.equal(logins.length, 2);
  assert.match(logins[0], /client-id: \$\{\{ vars\.AZURE_CHECKS_CLIENT_ID \}\}/);
  assert.match(logins[0], /subscription-id: \$\{\{ vars\.AZURE_SUBSCRIPTION_ID \}\}/);
  assert.match(logins[1], /client-id: \$\{\{ vars\[matrix\.automation\] \}\}/);
  assert.match(logins[1], /tenant-id: \$\{\{ vars\[matrix\.tenant\] \}\}/);
  assert.match(logins[1], /allow-no-subscriptions: true/);
  assert.ok(workflow.includes(CHECKS_IDENTITY));
  assert.match(workflow, /id-token: write/);
});

test("the workflow renews Apple only under outcome A, on the first of the month or by dispatch", () => {
  assert.match(workflow, /\.apple\?\.outcome/);
  assert.match(workflow, /if \[ "\$outcome" = A \]/);
  assert.match(workflow, /date -u \+%d\)" = 01/);
  assert.match(workflow, /--renew-apple/);
});

test("on failure the workflow opens or comments on one identity-alert issue from the alert files only", () => {
  assert.match(workflow, /--alert-file "\$RUNNER_TEMP\/identity-alert-\$ENV\.md"/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /gh issue list --label identity-alert --state open/);
  assert.match(workflow, /gh issue comment "\$number" --body-file/);
  assert.match(workflow, /gh issue create --title "Identity checks failed" --label identity-alert --body-file/);
  // The issue body never takes the run's log.
  assert.ok(!/--body "\$\(/.test(workflow));
  // Every job's permissions start from none.
  assert.match(workflow, /^permissions: \{\}$/m);
});

test("an error that names the accountId reaches the run log with it masked", async (t) => {
  const { cloud, cli } = setup(t);
  Object.defineProperty(cloud, "passwordCredentials", { get: () => { throw new Error(`lookup for ${ACCOUNT} failed`); } });
  const { code, stdout, stderr } = await cli(["--env", "test"]);
  assert.notEqual(code, 0);
  assert.match(stdout, /lookup for <accountId> failed/);
  assert.ok(!`${stdout}${stderr}`.includes(ACCOUNT));
});
