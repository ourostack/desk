import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  APP_SECRETS,
  appManifest,
  convertManifestCode,
  createdHandler,
  installUrl,
  manifestFormPage,
  restartRevision,
  secretsFromConversion,
  setSecrets,
  waitForInstallation,
} from "../infra/create-github-app.mjs";

const CONVERSION = {
  id: 424242,
  slug: "ouro-desk",
  html_url: "https://github.com/apps/ouro-desk",
  client_id: "Iv23liCLIENT",
  client_secret: "client-secret-value",
  webhook_secret: null,
  pem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }),
};
const TARGET = { app: "ouro-desk-hosted", resourceGroup: "rg-ouro-work-substrate", subscription: "sub-id" };
const AZ_TARGET = ["--name", "ouro-desk-hosted", "--resource-group", "rg-ouro-work-substrate", "--subscription", "sub-id"];

test("the manifest describes the Ouro Desk App with only the permissions hosted Desk needs and no webhook", () => {
  assert.deepEqual(appManifest({ publicUrl: "https://desk.ouro.bot", redirectUrl: "http://127.0.0.1:8787/created" }), {
    name: "Ouro Desk",
    url: "https://desk.ouro.bot",
    callback_urls: [
      "https://desk.ouro.bot/oauth/github/callback",
      "https://ouro-desk-hosted.blueflower-44af4710.eastus2.azurecontainerapps.io/oauth/github/callback",
    ],
    redirect_url: "http://127.0.0.1:8787/created",
    public: true,
    request_oauth_on_install: false,
    default_permissions: { contents: "write", pull_requests: "read", metadata: "read" },
    hook_attributes: { url: "https://desk.ouro.bot/", active: false },
  });
});

test("the manifest's callbacks cover both the Azure address and desk.ouro.bot, so the DNS cut-over needs no App change", () => {
  const both = [
    "https://desk.ouro.bot/oauth/github/callback",
    "https://ouro-desk-hosted.blueflower-44af4710.eastus2.azurecontainerapps.io/oauth/github/callback",
  ];
  const onAzure = appManifest({ publicUrl: "https://ouro-desk-hosted.blueflower-44af4710.eastus2.azurecontainerapps.io/", redirectUrl: "x" });
  assert.equal(onAzure.url, "https://ouro-desk-hosted.blueflower-44af4710.eastus2.azurecontainerapps.io");
  assert.deepEqual(onAzure.callback_urls, [both[1], both[0]]);
  const elsewhere = appManifest({ publicUrl: "https://test.example", redirectUrl: "x" });
  assert.deepEqual(elsewhere.callback_urls, ["https://test.example/oauth/github/callback", ...both]);
});

test("the form page posts the manifest and state to the organization's new-App page and submits itself", () => {
  const manifest = appManifest({ publicUrl: "https://desk.ouro.bot", redirectUrl: "http://127.0.0.1:8787/created" });
  const html = manifestFormPage({ org: "ourostack", manifest, state: "st4te" });
  assert.match(html, /<form[^>]+method="post"[^>]+action="https:\/\/github\.com\/organizations\/ourostack\/settings\/apps\/new\?state=st4te"/);
  const value = html.match(/name="manifest" value="([^"]*)"/)[1];
  const decoded = value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  assert.deepEqual(JSON.parse(decoded), manifest);
  assert.match(html, /\.submit\(\)/);
});

test("convertManifestCode posts the code to GitHub's conversion endpoint and returns the App", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json(CONVERSION, { status: 201 });
  };
  assert.deepEqual(await convertManifestCode("abc123", { fetch }), CONVERSION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/app-manifests/abc123/conversions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.accept, "application/vnd.github+json");
});

test("convertManifestCode refuses a code that is not a plain token, and reports GitHub's refusal", async () => {
  const fetch = async () => Response.json({ message: "Not Found" }, { status: 404 });
  await assert.rejects(convertManifestCode("../x", { fetch }), /code/);
  await assert.rejects(convertManifestCode("abc", { fetch }), /404/);
});

test("the conversion maps onto the Container App's secrets", () => {
  assert.deepEqual(secretsFromConversion(CONVERSION), [
    { name: "desk-app-id", value: "424242" },
    { name: "desk-app-client-id", value: "Iv23liCLIENT" },
    { name: "desk-app-client-secret", value: "client-secret-value" },
    { name: "desk-app-key", value: CONVERSION.pem },
  ]);
  assert.deepEqual(APP_SECRETS, ["desk-app-id", "desk-app-client-id", "desk-app-client-secret", "desk-app-key"]);
  assert.throws(() => secretsFromConversion({ ...CONVERSION, pem: "" }), /pem/);
});

test("setSecrets writes every secret in one az call", async () => {
  const calls = [];
  const run = async (command, args) => calls.push([command, ...args]);
  await setSecrets({ secrets: secretsFromConversion(CONVERSION), ...TARGET, run });
  assert.deepEqual(calls, [
    [
      "az", "containerapp", "secret", "set", ...AZ_TARGET, "--output", "none", "--secrets",
      "desk-app-id=424242",
      "desk-app-client-id=Iv23liCLIENT",
      "desk-app-client-secret=client-secret-value",
      `desk-app-key=${CONVERSION.pem}`,
    ],
  ]);
});

test("restartRevision restarts the latest ready revision, and refuses when there is none", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    return args.includes("show") ? "ouro-desk-hosted--0000003\n" : "";
  };
  await restartRevision({ ...TARGET, run });
  assert.deepEqual(calls, [
    ["az", "containerapp", "show", ...AZ_TARGET, "--query", "properties.latestReadyRevisionName", "--output", "tsv"],
    ["az", "containerapp", "revision", "restart", ...AZ_TARGET, "--revision", "ouro-desk-hosted--0000003", "--output", "none"],
  ]);
  await assert.rejects(restartRevision({ ...TARGET, run: async () => "\n" }), /no ready revision/);
});

test("waitForInstallation polls the desk repository's installation with an App JWT until it exists", async () => {
  const statuses = [404, 404, 200];
  const seen = [];
  const sleeps = [];
  const fetch = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return Response.json({}, { status: statuses.shift() });
  };
  await waitForInstallation({ conversion: CONVERSION, repo: "arimendelow/desk", fetch, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].url, "https://api.github.com/repos/arimendelow/desk/installation");
  assert.match(seen[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(sleeps, [5000, 5000]);
});

test("waitForInstallation gives up at its deadline and on any answer but 404", async () => {
  let clock = 0;
  const notFound = async () => Response.json({}, { status: 404 });
  const options = { conversion: CONVERSION, repo: "arimendelow/desk", now: () => clock, timeoutMs: 10_000 };
  await assert.rejects(waitForInstallation({ ...options, fetch: notFound, sleep: async (ms) => (clock += ms) }), /not installed .* within/);
  await assert.rejects(waitForInstallation({ ...options, fetch: async () => Response.json({}, { status: 401 }), sleep: async () => {} }), /401/);
});

test("the install URL opens the App's installation page", () => {
  assert.equal(installUrl(CONVERSION), "https://github.com/apps/ouro-desk/installations/new");
});

// Runs the /created handler with a fake GitHub and az, and captures what it prints.
async function created(search, { fetch, run } = {}) {
  const printed = [];
  const handle = createdHandler({
    state: "st4te",
    ...TARGET,
    fetch: fetch ?? (async () => Response.json(CONVERSION, { status: 201 })),
    run: run ?? (async () => ""),
    print: (line) => printed.push(line),
  });
  const result = await handle(new URLSearchParams(search));
  return { result, printed: printed.join("\n") };
}

test("the /created handler stores the secrets, prints the install URL and never prints a secret", async () => {
  const runs = [];
  const { result, printed } = await created("code=abc&state=st4te", {
    run: async (command, args) => runs.push(args.slice(0, 3).join(" ")),
  });
  assert.equal(result.ok, true);
  assert.equal(result.conversion.id, CONVERSION.id);
  assert.deepEqual(runs, ["containerapp secret set"]);
  assert.match(printed, /https:\/\/github\.com\/apps\/ouro-desk\/installations\/new/);
  assert.match(printed, /arimendelow\/desk/);
  for (const secret of [CONVERSION.client_secret, CONVERSION.pem.split("\n")[1], CONVERSION.client_id]) {
    assert.equal(printed.includes(secret), false, `printed output must not contain ${secret}`);
    assert.equal(result.html.includes(secret), false, `the page must not contain ${secret}`);
  }
});

test("the /created handler refuses a wrong state before calling GitHub", async () => {
  let fetched = false;
  const { result } = await created("code=abc&state=other", {
    fetch: async () => {
      fetched = true;
      return Response.json(CONVERSION, { status: 201 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(fetched, false);
});

test("a failed az call is reported without the secret values it carried, with how to recover the lost credentials", async () => {
  const { result, printed } = await created("code=abc&state=st4te", {
    run: async () => {
      throw new Error("az containerapp secret set failed: (AuthorizationFailed) no access");
    },
  });
  assert.equal(result.ok, false);
  assert.match(printed, /AuthorizationFailed/);
  assert.match(printed, /https:\/\/github\.com\/organizations\/ourostack\/settings\/apps\/ouro-desk/);
  assert.match(printed, /client secret and a new private key/);
  assert.equal(printed.includes(CONVERSION.client_secret), false);
  assert.equal(printed.includes(CONVERSION.pem.split("\n")[1]), false);
});
