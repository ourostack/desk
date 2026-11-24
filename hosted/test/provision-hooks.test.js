// provision-hooks.sh and its spec builder, hooks-app.mjs, with a fake az and curl on PATH. The receiver's spec comes
// from the gateway as shown, and DESK_CLIENT_KEY's value travels only through a private file: never an argument,
// never printed, and never read at all in a dry run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hooksAppSpec, masked } from "../infra/hooks-app.mjs";

const script = fileURLToPath(new URL("../infra/provision-hooks.sh", import.meta.url));
const CLIENT_KEY = "client-key-value-that-must-not-leak";
const PULL = "/subscriptions/s/resourcegroups/rg-ouro-work-substrate/providers/Microsoft.ManagedIdentity/userAssignedIdentities/ouro-prod-services-mi";
const STORE = "/subscriptions/s/resourcegroups/rg-ouro-identity/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-ouro-desk-hosted";
const IMAGE = "ouroworkprodk2aumligevt3e.azurecr.io/ouro-desk-hosted:abc123";

const gateway = () => ({
  location: "East US 2",
  identity: { type: "UserAssigned", userAssignedIdentities: { [STORE]: { clientId: "store-client-id" }, [PULL]: { clientId: "pull-client-id" } } },
  properties: {
    managedEnvironmentId: "/subscriptions/s/resourceGroups/rg-ouro-work-substrate/providers/Microsoft.App/managedEnvironments/ouro-prod-cae",
    configuration: { registries: [{ server: "ouroworkprodk2aumligevt3e.azurecr.io", identity: PULL }] },
    template: {
      containers: [
        {
          image: IMAGE,
          env: [
            { name: "DESK_SIGNING_KEY", secretRef: "desk-signing-key", value: "" },
            { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key", value: "" },
            { name: "DESK_ACCOUNTS_ENDPOINT", value: "https://stouroaccounts261e0b.table.core.windows.net" },
            { name: "AZURE_CLIENT_ID", value: "store-client-id" },
            { name: "DESK_GITHUB_ACCOUNTS", value: "16390116=acct-ari" },
            { name: "DESK_GITHUB_LOGINS", value: "16390116=arimendelow" },
            { name: "DESK_ENTRA_CLIENT_SECRET", secretRef: "entra-client-secret", value: "" },
          ],
        },
      ],
    },
  },
});

const FAKE_AZ = `
const fs = require("fs"), path = require("path");
const dir = process.env.FAKE_DIR, args = process.argv.slice(2), has = (...words) => words.every((w) => args.includes(w));
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(args) + "\\n");
const created = path.join(dir, "created.json");
if (has("hostname") || has("update")) { process.exit(0); }
if (has("env", "show")) { console.log(args.some((a) => a.includes("VerificationId")) ? "VERIFY-ID" : "blueflower-44af4710.eastus2.azurecontainerapps.io"); process.exit(0); }
if (has("secret", "show")) { console.log(${JSON.stringify(CLIENT_KEY)}); process.exit(0); }
if (has("create")) { fs.copyFileSync(args[args.indexOf("--yaml") + 1], created); process.exit(0); }
if (has("show", "ouro-desk-hosted")) { process.stdout.write(fs.readFileSync(path.join(dir, "gateway.json"), "utf8")); process.exit(0); }
if (has("show", "ouro-desk-hooks")) {
  if (!fs.existsSync(created) && !process.env.FAKE_EXISTS) { console.error("ERROR: (ResourceNotFound) The Resource was not found."); process.exit(1); }
  const query = args[args.indexOf("--query") + 1] || "";
  if (query.includes("customDomains")) { console.log(process.env.FAKE_BOUND || ""); process.exit(0); }
  if (query.includes("DESK_HOOKS_PUBLIC_URL")) { console.log(process.env.FAKE_PUBLIC_URL || ""); process.exit(0); }
  console.log(args.includes("name") ? "ouro-desk-hooks" : "ouro-desk-hooks--r1"); process.exit(0);
}
console.error("fake az: unexpected " + args.join(" ")); process.exit(3);
`;

function run(t, { args = [], env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "desk-provision-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "fake-az.cjs"), FAKE_AZ);
  writeFileSync(join(dir, "az"), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-az.cjs")}" "$@"\n`);
  writeFileSync(join(dir, "curl"), "#!/bin/sh\nprintf 200\n");
  // dig answers from FAKE_CNAME and FAKE_TXT, so a test chooses whether ouro.bot's DNS has the records.
  writeFileSync(join(dir, "dig"), '#!/bin/sh\ncase "$*" in *CNAME*) [ -n "$FAKE_CNAME" ] && echo "$FAKE_CNAME." ;; *TXT*) [ -n "$FAKE_TXT" ] && echo "\\"$FAKE_TXT\\"" ;; esac\nexit 0\n');
  chmodSync(join(dir, "dig"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
  chmodSync(join(dir, "curl"), 0o755);
  writeFileSync(join(dir, "gateway.json"), JSON.stringify(gateway()));
  const result = spawnSync("bash", [script, ...args], { env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, FAKE_DIR: dir, READY_POLL_SECONDS: "0", ...env }, encoding: "utf8" });
  const argv = existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const created = existsSync(join(dir, "created.json")) ? JSON.parse(readFileSync(join(dir, "created.json"), "utf8")) : null;
  return { status: result.status, output: `${result.stdout}${result.stderr}`, argv, created };
}

test("the receiver's spec: 0.25 vCPU, 0.5 GiB, one replica always on, external ingress on 8080, the gateway's settings", () => {
  const spec = hooksAppSpec({ gateway: gateway(), image: IMAGE, publicUrl: "https://ouro-desk-hooks.example", clientKey: CLIENT_KEY });
  const container = spec.properties.template.containers[0];
  assert.deepEqual(container.resources, { cpu: 0.25, memory: "0.5Gi" });
  assert.deepEqual(spec.properties.template.scale, { minReplicas: 1, maxReplicas: 1 });
  assert.deepEqual(spec.properties.configuration.ingress, { external: true, targetPort: 8080, transport: "auto", allowInsecure: false });
  assert.deepEqual(container.args, ["node", "hosted/src/hooks/main.js"]);
  assert.equal(container.image, IMAGE);
  assert.deepEqual(container.env.map((entry) => entry.name), ["DESK_GITHUB_ACCOUNTS", "DESK_GITHUB_LOGINS", "DESK_ACCOUNTS_ENDPOINT", "AZURE_CLIENT_ID", "DESK_HOOKS_PUBLIC_URL", "DESK_CLIENT_KEY"]);
  assert.deepEqual(container.env.at(-1), { name: "DESK_CLIENT_KEY", secretRef: "desk-client-key" });
  assert.deepEqual(Object.keys(spec.identity.userAssignedIdentities).sort(), [PULL, STORE].sort());
  assert.deepEqual(spec.properties.configuration.registries, [{ server: "ouroworkprodk2aumligevt3e.azurecr.io", identity: PULL }]);
  assert.equal(masked(spec).properties.configuration.secrets[0].value, "***");
  assert.equal(spec.properties.configuration.secrets[0].value, CLIENT_KEY, "masking copies, never changes the spec");
  assert.ok(!JSON.stringify(spec).includes("desk-signing-key") && !JSON.stringify(spec).includes("entra"), "nothing else of the gateway's is carried");
});

test("the spec refuses a gateway without the settings it needs", () => {
  const without = (name) => {
    const app = gateway();
    app.properties.template.containers[0].env = app.properties.template.containers[0].env.filter((entry) => entry.name !== name);
    return app;
  };
  const build = (app, extra = {}) => () => hooksAppSpec({ gateway: app, image: IMAGE, publicUrl: "https://h.example", clientKey: CLIENT_KEY, ...extra });
  assert.throws(build(without("DESK_GITHUB_ACCOUNTS")), /no DESK_GITHUB_ACCOUNTS/);
  assert.throws(build(without("DESK_CLIENT_KEY")), /no DESK_CLIENT_KEY/);
  const noStore = gateway();
  noStore.identity.userAssignedIdentities[STORE].clientId = "other";
  assert.throws(build(noStore), /AZURE_CLIENT_ID/);
  const noRegistry = gateway();
  noRegistry.properties.configuration.registries = [];
  assert.throws(build(noRegistry), /without an identity/);
  assert.throws(build(gateway(), { publicUrl: "http://h" }), /https origin/);
  assert.throws(build(gateway(), { clientKey: "" }), /empty/);
});

test("a dry run prints the masked spec and never reads the client key", (t) => {
  const { status, output, argv, created } = run(t, { args: ["--dry-run"] });
  assert.equal(status, 0, output);
  assert.equal(created, null);
  assert.ok(!argv.some((args) => args.includes("secret")), "no secret read");
  assert.match(output, /"cpu": 0\.25/);
  assert.match(output, /"value": "\*\*\*"/);
  assert.match(output, /would run: az containerapp create -n ouro-desk-hooks/);
  assert.match(output, /Dry run: nothing was changed/);
  assert.match(output, /Public URL: https:\/\/ouro-desk-hooks\.blueflower-44af4710\.eastus2\.azurecontainerapps\.io/);
});

test("a real run copies the client key only through the spec file and waits for health", (t) => {
  const { status, output, argv, created } = run(t);
  assert.equal(status, 0, output);
  assert.equal(created.properties.configuration.secrets[0].value, CLIENT_KEY);
  assert.equal(created.properties.template.containers[0].image, IMAGE);
  assert.ok(!output.includes(CLIENT_KEY), "never printed");
  for (const args of argv) assert.ok(!args.includes(CLIENT_KEY), "never an argument");
  assert.match(output, /Done\. ouro-desk-hooks answers at https:\/\/ouro-desk-hooks\./);
});

test("IMAGE picks another image, an existing app is left alone, and unknown arguments are refused", (t) => {
  assert.equal(run(t, { env: { IMAGE: "registry/other:1" } }).created.properties.template.containers[0].image, "registry/other:1");
  const existing = run(t, { env: { FAKE_EXISTS: "1" } });
  assert.equal(existing.status, 0);
  assert.match(existing.output, /exists at https:\/\/ouro-desk-hooks\./);
  assert.ok(!existing.argv.some((args) => args.includes("create")));
  assert.equal(run(t, { args: ["--force"] }).status, 2);
});

const AZURE = "ouro-desk-hooks.blueflower-44af4710.eastus2.azurecontainerapps.io";
const DNS = { FAKE_CNAME: AZURE, FAKE_TXT: "VERIFY-ID" };
const calls = (argv, word) => argv.filter((args) => args[0] === "containerapp" && args[1] === word);

test("without DNS records it prints the two records to add and binds nothing", (t) => {
  const { status, output, argv } = run(t, { env: { FAKE_EXISTS: "1" } });
  assert.equal(status, 0, output);
  assert.match(output, new RegExp(`CNAME +hooks\\.ouro\\.bot +${AZURE.replaceAll(".", "\\.")}`));
  assert.match(output, /TXT +asuid\.hooks\.ouro\.bot +VERIFY-ID/);
  assert.deepEqual(calls(argv, "hostname"), []);
  assert.deepEqual(calls(argv, "update"), []);
  assert.match(output, new RegExp(`Done\\. ouro-desk-hooks answers at https://${AZURE.replaceAll(".", "\\.")}`));
});

test("with the DNS records it binds hooks.ouro.bot with a managed certificate and points the public URL at it", (t) => {
  const { status, output, argv } = run(t, { env: { FAKE_EXISTS: "1", ...DNS } });
  assert.equal(status, 0, output);
  const hostname = calls(argv, "hostname");
  assert.deepEqual(hostname.map((args) => args[2]), ["add", "bind"]);
  assert.ok(hostname[1].includes("--validation-method") && hostname[1].includes("CNAME"));
  const [update] = calls(argv, "update");
  assert.ok(update.includes("DESK_HOOKS_PUBLIC_URL=https://hooks.ouro.bot"), JSON.stringify(update));
  assert.match(output, /Done\. ouro-desk-hooks answers at https:\/\/hooks\.ouro\.bot/);
});

test("a bound domain is left alone, and the public URL is set only when it differs", (t) => {
  const settled = run(t, { env: { FAKE_EXISTS: "1", FAKE_BOUND: "SniEnabled", FAKE_PUBLIC_URL: "https://hooks.ouro.bot" } });
  assert.equal(settled.status, 0, settled.output);
  assert.deepEqual(calls(settled.argv, "hostname"), []);
  assert.deepEqual(calls(settled.argv, "update"), []);
  assert.match(settled.output, /hooks\.ouro\.bot is bound with a certificate/);
  const stale = run(t, { env: { FAKE_EXISTS: "1", FAKE_BOUND: "SniEnabled", FAKE_PUBLIC_URL: `https://${AZURE}` } });
  assert.equal(calls(stale.argv, "update").length, 1);
});

test("a dry run with the DNS records says what it would bind and changes nothing", (t) => {
  const { status, output, argv } = run(t, { args: ["--dry-run"], env: { FAKE_EXISTS: "1", ...DNS } });
  assert.equal(status, 0, output);
  assert.match(output, /would run: az containerapp hostname add and bind -n ouro-desk-hooks --hostname hooks\.ouro\.bot/);
  assert.deepEqual(calls(argv, "hostname"), []);
  assert.deepEqual(calls(argv, "update"), []);
  assert.match(output, /Dry run: nothing was changed/);
});

test("a binding left Disabled is bound again without a second add", (t) => {
  const { status, output, argv } = run(t, { env: { FAKE_EXISTS: "1", FAKE_BOUND: "Disabled", ...DNS } });
  assert.equal(status, 0, output);
  assert.deepEqual(calls(argv, "hostname").map((args) => args[2]), ["bind"]);
});

test("a new app is created and then bound in the same run", (t) => {
  const { status, output, argv, created } = run(t, { env: DNS });
  assert.equal(status, 0, output);
  assert.ok(created, "the app was created");
  assert.deepEqual(calls(argv, "hostname").map((args) => args[2]), ["add", "bind"]);
  assert.ok(calls(argv, "update")[0].includes("DESK_HOOKS_PUBLIC_URL=https://hooks.ouro.bot"));
});

test("a CNAME pointing elsewhere, or a missing verification value, binds nothing", (t) => {
  for (const env of [{ ...DNS, FAKE_CNAME: "somewhere.else.example" }, { ...DNS, FAKE_TXT: "other-id" }]) {
    const { status, output, argv } = run(t, { env: { FAKE_EXISTS: "1", ...env } });
    assert.equal(status, 0, output);
    assert.deepEqual(calls(argv, "hostname"), []);
    assert.match(output, /dns-missing: skipping hooks\.ouro\.bot until its DNS exists/);
  }
});

test("a dry run names the public-URL change a bound domain still needs", (t) => {
  const { status, output, argv } = run(t, { args: ["--dry-run"], env: { FAKE_EXISTS: "1", FAKE_BOUND: "SniEnabled", FAKE_PUBLIC_URL: `https://${AZURE}` } });
  assert.equal(status, 0, output);
  assert.match(output, /would run: az containerapp update -n ouro-desk-hooks --set-env-vars DESK_HOOKS_PUBLIC_URL=https:\/\/hooks\.ouro\.bot/);
  assert.deepEqual(calls(argv, "update"), []);
});
