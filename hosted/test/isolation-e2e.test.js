// Isolation between two accounts, end to end (spec v1b-2). The kernel, filesystem, token-socket, path and error
// boundaries between two realms run natively in the Linux fixture (fixtures/isolation-e2e-native.js, selected by
// DESK_NATIVE_ISOLATION=1 in the native job). This file covers the part that runs on any OS: one account cannot
// carry another account's GitHub linking into its own session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createGitHubLink } from "../src/auth/github-link.js";
import { TENANT_ID } from "./fixtures/stub-tenant.mjs";
import { GATEWAY, browser, pageSignIn, startAccountGateway } from "./fixtures/account-gateway.mjs";
import { fakeGitHub } from "./fixtures/fake-github-api.mjs";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const ARI = { id: 1001, login: "ari", name: "Ari", email: "ari@example.com" };
const JORDAN = { id: 4242, login: "jordan-dev", name: "Jordan Q", email: "jordan@example.com" };
const DESK_FILES = ["_meta", "_archive"];
const REPOS = {
  "ari/desk": { installationId: 501, collaborators: { ari: "admin" }, files: DESK_FILES },
  "ari/notes": { installationId: 501, collaborators: { ari: "admin" }, files: [] },
  "jordan-dev/desk": { installationId: 502, collaborators: { "jordan-dev": "write" }, files: DESK_FILES },
};

const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];
const fieldOf = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// One gateway, two signed-in accounts. GitHub answers as whoever `github.state.user` names when a code is exchanged.
async function twoAccounts(t) {
  const appId = 7001;
  const github = fakeGitHub({ user: ARI, repos: structuredClone(REPOS), appId });
  const inits = [];
  const ctx = await startAccountGateway(t, {
    githubLink: ({ store, sessions, log, now }) => createGitHubLink({
      key: "test-key-0123456789abcdef0123456789abcdef", store, sessions, issuer: GATEWAY,
      clientId: "Iv1.ouro-desk", clientSecret: "secret", callbackUrl: `${GATEWAY}/oauth/github/callback`,
      appId: String(appId), privateKeyPem: PRIVATE_KEY, fetch: github.fetch,
      initDesk: async (args) => { inits.push(args); return { status: "created", commit: "abc1234" }; },
      onLinked: () => {}, now, log,
    }),
  });
  const person = async (displayName) => {
    const accountId = randomUUID();
    const oid = randomUUID();
    await ctx.store.putAccount({ accountId, displayName, deskAccess: true });
    await ctx.store.tables.create("identities", { partitionKey: TENANT_ID, rowKey: oid, accountId });
    const who = browser(ctx);
    const signedIn = await pageSignIn(ctx, who, { oid, next: "/link/github" });
    assert.equal(signedIn.status, 303, signedIn.text);
    return { accountId, who };
  };
  return { ...ctx, github, inits, ari: await person("Ari"), jordan: await person("Jordan Q") };
}

// Starts linking in `who`'s browser with GitHub answering as `user`; returns the page the callback lands on.
async function linkAs(ctx, { who }, user) {
  ctx.github.state.user = user;
  const page = await who.request("/link/github");
  const started = await who.request("/link/github", { method: "POST", form: { action: "start", csrf: decode(csrfOf(page.text)) } });
  assert.equal(started.status, 303, started.text);
  const state = new URL(started.location).searchParams.get("state");
  return who.request(`/oauth/github/callback?code=good-code&state=${encodeURIComponent(state)}`, { site: "cross-site" });
}

// The CSRF token of `who`'s own session, read from the link page it is shown.
async function csrfFor({ who }) {
  return decode(csrfOf((await who.request("/link/github")).text));
}

// A tampered installation id inside one account's own sealed choice is covered by github-link.test.js ("forged
// installation id is refused"); these cases carry another account's choice or repository into a session.
test("forged installation id or repo at linking is refused: one account's GitHub choice cannot bind in another's session", async (t) => {
  const ctx = await twoAccounts(t);
  const ariChooser = await linkAs(ctx, ctx.ari, ARI);
  assert.equal(ariChooser.status, 200, ariChooser.text);
  const ariChoice = decode(fieldOf(ariChooser.text, "choice"));
  assert.ok(ariChoice, "Ari is offered his repositories");

  // Jordan replays Ari's sealed choice, naming Ari's desk and its installation, with Jordan's own session and CSRF token.
  const replayed = await ctx.jordan.who.request("/link/github", {
    method: "POST", form: { action: "choose", csrf: await csrfFor(ctx.jordan), choice: ariChoice, repo: "ari/desk" },
  });
  assert.equal(replayed.status, 400, replayed.text);
  assert.match(replayed.text, /expired or isn(&#39;|')t valid/);

  // Jordan's own choice, with Ari's repository (and so Ari's installation) named in place of one Jordan was offered.
  const jordanChooser = await linkAs(ctx, ctx.jordan, JORDAN);
  assert.doesNotMatch(jordanChooser.text, /ari\//, "Jordan is never offered Ari's repositories");
  const forged = await ctx.jordan.who.request("/link/github", {
    method: "POST", form: { action: "choose", csrf: decode(csrfOf(jordanChooser.text)), choice: decode(fieldOf(jordanChooser.text, "choice")), repo: "ari/desk" },
  });
  assert.equal(forged.status, 403, forged.text);
  assert.match(forged.text, /isn(&#39;|')t one you can link/, "refused as not offered, not for a missing CSRF token");
  assert.ok(ctx.logs.some((line) => /link refused: not_offered account/.test(line)), ctx.logs.join("\n"));

  assert.equal(await ctx.store.getBinding(ctx.jordan.accountId), null, "Jordan has no binding");
  assert.equal(await ctx.store.getBinding(ctx.ari.accountId), null, "nothing was bound for Ari by Jordan's requests");
  assert.ok(!ctx.logs.some((line) => line.startsWith("linked:")), ctx.logs.join("\n"));
  for (const page of [replayed, forged]) assert.ok(!page.text.includes(ctx.ari.accountId), "Jordan's pages never name Ari's account");
});

test("one account's desk-init offer cannot run in another account's session", async (t) => {
  const ctx = await twoAccounts(t);
  // ari/notes is not a desk yet, so choosing it offers desk init in a sealed offer bound to Ari.
  const chooser = await linkAs(ctx, ctx.ari, ARI);
  const offered = await ctx.ari.who.request("/link/github", {
    method: "POST", form: { action: "choose", csrf: decode(csrfOf(chooser.text)), choice: decode(fieldOf(chooser.text, "choice")), repo: "ari/notes" },
  });
  assert.equal(offered.status, 200, offered.text);
  const pick = decode(fieldOf(offered.text, "pick"));
  assert.ok(pick, `Ari is offered desk init: ${offered.text}`);

  const replayed = await ctx.jordan.who.request("/link/github", {
    method: "POST", form: { action: "init", csrf: await csrfFor(ctx.jordan), pick },
  });
  assert.equal(replayed.status, 400, replayed.text);
  assert.match(replayed.text, /expired or isn(&#39;|')t valid/);
  assert.deepEqual(ctx.inits, [], "no desk init ran");
  assert.equal(await ctx.store.getBinding(ctx.jordan.accountId), null);
  assert.equal(await ctx.store.getBinding(ctx.ari.accountId), null);
});

test("the native job runs the two-realm isolation cases from the production image", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/hosted-tests.yml", import.meta.url), "utf8");
  const dockerfile = readFileSync(new URL("./fixtures/runtime-native.Dockerfile", import.meta.url), "utf8");
  const fixture = readFileSync(new URL("./fixtures/runtime-native.js", import.meta.url), "utf8");
  assert.match(workflow, /isolation\) flags=\(-e DESK_NATIVE_ISOLATION=1\)/);
  assert.match(workflow, /for mode in [^;]*\bisolation\b/);
  assert.match(workflow, /isolation-e2e-native\.js/);
  assert.match(dockerfile, /isolation-e2e-native\.js/);
  assert.match(fixture, /DESK_NATIVE_ISOLATION === "1"/);
});
