// Verified GitHub linking (spec item 17): a signed-in account links a GitHub repository as its desk only when the
// "Ouro Desk" App is installed on it and the person can push to it, as GitHub itself says. The user token is used
// during the callback and dropped; every later check uses the App's installation token. Driven over HTTP against
// a fake GitHub API; no test reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createGitHubLink, suspendedMessage } from "../src/auth/github-link.js";
import { seed } from "../src/accounts/invites.js";
import { TENANT_ID } from "./fixtures/stub-tenant.mjs";
import { GATEWAY, browser, pageSignIn, startAccountGateway } from "./fixtures/account-gateway.mjs";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const JORDAN_OID = "7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const JORDAN = { id: 4242, login: "jordan-dev", name: "Jordan Q", email: "jordan@example.com" };
const DESK_REPO = "jordan-dev/desk";
const INSTALLATION = 777001;

// A fake GitHub: the OAuth token exchange, the user endpoints a user token reads, and the App endpoints an App JWT or
// installation token reads. `state.repos` maps owner/name to `{ installationId, collaborators: {login: role}, files }`.
// Every request is recorded with the token it carried.
function fakeGitHub({ user = JORDAN, repos = {}, appId } = {}) {
  // `failures` are `{ path: RegExp, status }`: a matching API call answers with that status.
  const state = { user, repos, calls: [], userTokens: new Set(), installationTokens: new Map(), down: false, failures: [], appId };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let counter = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET";
    const auth = init.headers?.authorization ?? init.headers?.Authorization ?? "";
    const bearer = auth.replace(/^Bearer /, "");
    state.calls.push({ method, path: url.pathname, bearer });
    if (state.down) throw new TypeError("fetch failed");
    if (url.href === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(init.body);
      if (body.get("code") !== "good-code") return json(200, { error: "bad_verification_code" });
      const token = `ghu_user_${++counter}_${randomUUID()}`;
      state.userTokens.add(token);
      return json(200, { access_token: token, token_type: "bearer" });
    }
    const path = url.pathname;
    const failure = state.failures.find((f) => f.path.test(path));
    if (failure) return json(failure.status, { message: "failing on purpose" });
    const isUser = state.userTokens.has(bearer);
    const installationOf = (token) => state.installationTokens.get(token);
    if (path === "/user") return isUser ? json(200, state.user) : json(401, {});
    if (path === "/user/installations") {
      if (!isUser) return json(401, {});
      const ids = [...new Set(Object.values(state.repos).filter((r) => r.collaborators[state.user.login]).map((r) => r.installationId))];
      return json(200, { total_count: ids.length, installations: ids.map((id) => ({ id, app_id: state.appId })) });
    }
    let match = path.match(/^\/user\/installations\/(\d+)\/repositories$/);
    if (match) {
      if (!isUser) return json(401, {});
      const id = Number(match[1]);
      const list = Object.entries(state.repos)
        .filter(([, r]) => r.installationId === id && r.collaborators[state.user.login])
        .map(([full_name, r]) => {
          const role = r.collaborators[state.user.login];
          return { full_name, permissions: { admin: role === "admin", maintain: role === "maintain", push: ["admin", "maintain", "write"].includes(role), pull: true } };
        });
      return json(200, { total_count: list.length, repositories: list });
    }
    match = path.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/);
    if (match) {
      const repo = state.repos[match[1]];
      return repo ? json(200, { id: repo.installationId }) : json(404, {});
    }
    match = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (match) {
      const token = `ghs_inst_${++counter}`;
      state.installationTokens.set(token, Number(match[1]));
      return json(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    match = path.match(/^\/user\/(\d+)$/);
    if (match) {
      if (!installationOf(bearer)) return json(401, {});
      return Number(match[1]) === state.user.id ? json(200, { id: state.user.id, login: state.user.login }) : json(404, {});
    }
    match = path.match(/^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/);
    if (match) {
      const repo = state.repos[match[1]];
      if (!repo || installationOf(bearer) !== repo.installationId) return json(404, {});
      const role = repo.collaborators[match[2]] ?? "none";
      const permission = { admin: "admin", maintain: "write", write: "write", triage: "read", read: "read", none: "none" }[role];
      return json(200, { permission, role_name: role, user: { login: match[2] } });
    }
    match = path.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
    if (match) {
      const repo = state.repos[match[1]];
      if (!repo || installationOf(bearer) !== repo.installationId) return json(404, {});
      return (repo.files ?? []).includes(match[2]) ? json(200, [{ type: "file", name: "readme.md" }]) : json(404, { message: "Not Found" });
    }
    return json(404, { message: `fake GitHub has no ${method} ${path}` });
  };
  return { state, fetch };
}

const DESK_FILES = ["_meta", "_archive"];

// A gateway whose GitHub linking talks to `github`. Jordan has an account, signs in through the stub tenant and has
// no binding yet. `initDesk` stands in for running desk-init.js in the account's realm.
async function startLinking(t, { repos = { [DESK_REPO]: { installationId: INSTALLATION, collaborators: { "jordan-dev": "write" }, files: DESK_FILES } }, user, initDesk } = {}) {
  const appId = Math.floor(Math.random() * 1e9);
  const github = fakeGitHub({ user, repos, appId });
  const inits = [];
  const linked = [];
  const ctx = await startAccountGateway(t, {
    githubLink: ({ store, sessions, log, now }) =>
      createGitHubLink({
        key: "test-key-0123456789abcdef0123456789abcdef",
        store,
        sessions,
        issuer: GATEWAY,
        clientId: "Iv1.ouro-desk",
        clientSecret: "secret",
        callbackUrl: `${GATEWAY}/oauth/github/callback`,
        // As main.js passes it: DESK_APP_ID is text.
        appId: String(appId),
        privateKeyPem: PRIVATE_KEY,
        fetch: github.fetch,
        initDesk: async (args) => {
          inits.push(args);
          return initDesk ? initDesk(args) : { status: "created", commit: "abc1234" };
        },
        onLinked: (accountId) => linked.push(accountId),
        now,
        log,
      }),
  });
  const accountId = randomUUID();
  await ctx.store.putAccount({ accountId, displayName: "Jordan Q", deskAccess: true });
  await ctx.store.tables.create("identities", { partitionKey: TENANT_ID, rowKey: JORDAN_OID, accountId });
  const jordan = browser(ctx);
  const signedIn = await pageSignIn(ctx, jordan, { oid: JORDAN_OID, next: "/link/github" });
  assert.equal(signedIn.status, 303, signedIn.text);
  return { ...ctx, github, jordan, jordanId: accountId, inits, linked };
}

const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];
const fieldOf = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Starts linking from /link/github and comes back from GitHub with `code`. Returns the page GitHub's redirect lands on.
async function linkThroughGitHub(ctx, who = ctx.jordan, { code = "good-code", callbackIn = who } = {}) {
  const page = await who.request("/link/github");
  assert.equal(page.status, 200, page.text);
  const started = await who.request("/link/github", { method: "POST", form: { action: "start", csrf: decode(csrfOf(page.text)) } });
  assert.equal(started.status, 303, started.text);
  const authorize = new URL(started.location);
  assert.equal(authorize.origin + authorize.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(authorize.searchParams.get("redirect_uri"), `${GATEWAY}/oauth/github/callback`);
  return callbackIn.request(`/oauth/github/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get("state"))}`, { site: "cross-site" });
}

// Chooses `repo` on the page the callback showed. Returns the result page.
async function choose(ctx, chooser, repo, extra = {}, who = ctx.jordan) {
  return who.request("/link/github", { method: "POST", form: { action: "choose", csrf: decode(csrfOf(chooser.text)), choice: decode(fieldOf(chooser.text, "choice")), repo, ...extra } });
}

const allRows = async (store) => {
  const rows = [];
  for (const table of ["accounts", "identities", "invites", "bindings"]) rows.push(...(await store.tables.list(table)));
  return rows;
};

test("a repo the App is installed on and the person can push to is linked, and its author is their GitHub noreply address", async (t) => {
  const ctx = await startLinking(t);
  const chooser = await linkThroughGitHub(ctx);
  assert.equal(chooser.status, 200, chooser.text);
  assert.match(chooser.text, /jordan-dev\/desk/);
  const done = await choose(ctx, chooser, DESK_REPO);
  assert.equal(done.status, 200, done.text);
  assert.match(done.text, /linked/i);
  const binding = await ctx.store.getBinding(ctx.jordanId);
  assert.deepEqual(binding, {
    kind: "github",
    repo: DESK_REPO,
    installationId: INSTALLATION,
    githubUserId: JORDAN.id,
    login: JORDAN.login,
    author: { name: "Jordan Q", email: "4242+jordan-dev@users.noreply.github.com" },
  });
  assert.deepEqual(ctx.linked, [ctx.jordanId]);
  assert.equal(ctx.inits.length, 0, "an existing desk is not initialised");
});

test("after linking, the author becomes the GitHub noreply address and never an Apple-relay or real email", async (t) => {
  const ctx = await startLinking(t, { user: { ...JORDAN, email: "abc123@privaterelay.appleid.com" } });
  await ctx.store.putBinding(ctx.jordanId, { kind: "github", repo: "someone/old", author: { name: "Jordan Q", email: "abc123@privaterelay.appleid.com" } });
  const chooser = await linkThroughGitHub(ctx);
  await choose(ctx, chooser, DESK_REPO);
  const { author } = await ctx.store.getBinding(ctx.jordanId);
  assert.equal(author.email, "4242+jordan-dev@users.noreply.github.com");
  for (const row of await allRows(ctx.store)) {
    const text = JSON.stringify(row);
    assert.ok(!text.includes("privaterelay.appleid.com"), `a row keeps the Apple relay address: ${text}`);
    assert.ok(!text.includes("jordan@example.com"), `a row keeps the real email: ${text}`);
  }
});

test("user token is not stored", async (t) => {
  const ctx = await startLinking(t);
  const chooser = await linkThroughGitHub(ctx);
  assert.equal((await choose(ctx, chooser, DESK_REPO)).status, 200);
  assert.ok(ctx.github.state.userTokens.size >= 1);
  const rows = JSON.stringify(await allRows(ctx.store));
  for (const token of ctx.github.state.userTokens) {
    assert.ok(!rows.includes(token), "a store row holds the user token");
    assert.ok(!chooser.text.includes(token), "the page carries the user token");
    for (const line of ctx.logs) assert.ok(!line.includes(token), `a log line holds the user token: ${line}`);
  }
  const afterCallback = ctx.github.state.calls.filter((call) => ctx.github.state.userTokens.has(call.bearer) && call.path !== "/user" && !call.path.startsWith("/user/installations"));
  assert.deepEqual(afterCallback, [], "the user token reads only the user and their installations");
});

test("repo not in user installations is refused", async (t) => {
  const ctx = await startLinking(t, {
    repos: {
      [DESK_REPO]: { installationId: INSTALLATION, collaborators: { "jordan-dev": "write" }, files: DESK_FILES },
      "ari/desk": { installationId: 999, collaborators: { ari: "admin" }, files: DESK_FILES },
    },
  });
  const chooser = await linkThroughGitHub(ctx);
  assert.doesNotMatch(chooser.text, /ari\/desk/);
  const refused = await choose(ctx, chooser, "ari/desk");
  assert.equal(refused.status, 403, refused.text);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null);
  assert.ok(ctx.logs.some((line) => /link refused: not_offered account/.test(line)), ctx.logs.join("\n"));
});

test("a person whose installations reach no repo they can push to is told to install the App, and nothing is linked", async (t) => {
  const ctx = await startLinking(t, { repos: { "other/desk": { installationId: 5, collaborators: { someone: "admin" }, files: DESK_FILES } } });
  const page = await linkThroughGitHub(ctx);
  assert.equal(page.status, 200);
  assert.match(page.text, /install the Ouro Desk GitHub App/i);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null);
});

test("read-only collaborator is refused", async (t) => {
  const ctx = await startLinking(t, {
    repos: {
      [DESK_REPO]: { installationId: INSTALLATION, collaborators: { "jordan-dev": "write" }, files: DESK_FILES },
      "team/desk": { installationId: INSTALLATION, collaborators: { "jordan-dev": "read" }, files: DESK_FILES },
    },
  });
  const chooser = await linkThroughGitHub(ctx);
  assert.doesNotMatch(chooser.text, /team\/desk/, "a read-only repo is not offered");
  const refused = await choose(ctx, chooser, "team/desk");
  assert.equal(refused.status, 403);
  // Write access taken away between the callback and the choice: the installation token's check refuses it.
  ctx.github.state.repos[DESK_REPO].collaborators["jordan-dev"] = "triage";
  const late = await choose(ctx, chooser, DESK_REPO);
  assert.equal(late.status, 403, late.text);
  assert.match(late.text, /write access/i);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null);
});

test("repo already bound to another account is refused", async (t) => {
  const ctx = await startLinking(t);
  const { accountId: other } = await seed({ store: ctx.store, displayName: "Someone Else", binding: { kind: "github", repo: DESK_REPO, installationId: INSTALLATION, author: { name: "x", email: "1+x@users.noreply.github.com" } } });
  const chooser = await linkThroughGitHub(ctx);
  const refused = await choose(ctx, chooser, DESK_REPO);
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.text, /already the desk of another account/i);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null);
  assert.equal((await ctx.store.getBinding(other)).repo, DESK_REPO);
});

test("relinking the account's own repo is allowed", async (t) => {
  const ctx = await startLinking(t);
  await choose(ctx, await linkThroughGitHub(ctx), DESK_REPO);
  const again = await choose(ctx, await linkThroughGitHub(ctx), DESK_REPO);
  assert.equal(again.status, 200, again.text);
});

test("forged installation id is refused", async (t) => {
  const ctx = await startLinking(t);
  const chooser = await linkThroughGitHub(ctx);
  // A choice is sealed, so a hand-edited one is not accepted at all.
  const choice = decode(fieldOf(chooser.text, "choice"));
  const [body, signature] = choice.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  payload.candidates[0].installationId = 31337;
  const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
  const refused = await ctx.jordan.request("/link/github", { method: "POST", form: { action: "choose", csrf: decode(csrfOf(chooser.text)), choice: forged, repo: DESK_REPO } });
  assert.equal(refused.status, 400, refused.text);
  // The App answering from another installation for the repo than the one GitHub listed: refused, nothing bound.
  ctx.github.state.repos[DESK_REPO].installationId = 31337;
  const moved = await choose(ctx, chooser, DESK_REPO);
  assert.equal(moved.status, 403, moved.text);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null);
});

test("GitHub's answer must come back to the browser of the account that started linking", async (t) => {
  const ctx = await startLinking(t);
  const stranger = browser(ctx);
  const elsewhere = await linkThroughGitHub(ctx, ctx.jordan, { callbackIn: stranger });
  assert.equal(elsewhere.status, 303, "a browser with no session goes to sign in");
  assert.match(elsewhere.location, /^\/signin\?next=%2Flink%2Fgithub$/);
  // Another account's session can't finish Jordan's linking.
  const ari = browser(ctx);
  assert.equal((await pageSignIn(ctx, ari, { oid: (await import("./fixtures/account-gateway.mjs")).ARI_OID })).status, 303);
  const crossed = await linkThroughGitHub(ctx, ctx.jordan, { callbackIn: ari });
  assert.equal(crossed.status, 400, crossed.text);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null);
  const denied = await linkThroughGitHub(ctx, ctx.jordan, { code: "bad-code" });
  assert.equal(denied.status, 502, denied.text);
});

test("starting or choosing without the session's CSRF token is refused", async (t) => {
  const ctx = await startLinking(t);
  const started = await ctx.jordan.request("/link/github", { method: "POST", form: { action: "start" } });
  assert.equal(started.status, 403);
  const chooser = await linkThroughGitHub(ctx);
  const crossSite = await ctx.jordan.request("/link/github", { method: "POST", site: "cross-site", form: { action: "choose", csrf: decode(csrfOf(chooser.text)), choice: decode(fieldOf(chooser.text, "choice")), repo: DESK_REPO } });
  assert.equal(crossSite.status, 403);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null);
});

test("link page offers init for a non-desk repo; declining records no binding", async (t) => {
  const ctx = await startLinking(t, { repos: { "jordan-dev/notes": { installationId: INSTALLATION, collaborators: { "jordan-dev": "admin" }, files: [] } } });
  const chooser = await linkThroughGitHub(ctx);
  const offer = await choose(ctx, chooser, "jordan-dev/notes");
  assert.equal(offer.status, 200, offer.text);
  assert.match(offer.text, /isn't a desk yet/i);
  assert.match(offer.text, /value="init"/);
  const declined = await ctx.jordan.request("/link/github", { method: "POST", form: { action: "decline", csrf: decode(csrfOf(offer.text)), pick: decode(fieldOf(offer.text, "pick")) } });
  assert.equal(declined.status, 200);
  assert.match(declined.text, /Nothing was linked/);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null);
  assert.equal(ctx.inits.length, 0);
});

test("accepting the offer links the repo and makes it a desk; a failed init leaves the previous binding", async (t) => {
  const outcomes = [{ status: "error", step: "commit", message: "x" }, { status: "created", commit: "abc1234" }];
  const ctx = await startLinking(t, { repos: { "jordan-dev/notes": { installationId: INSTALLATION, collaborators: { "jordan-dev": "admin" }, files: [] } }, initDesk: () => outcomes.shift() });
  const accept = async () => {
    const offer = await choose(ctx, await linkThroughGitHub(ctx), "jordan-dev/notes");
    return ctx.jordan.request("/link/github", { method: "POST", form: { action: "init", csrf: decode(csrfOf(offer.text)), pick: decode(fieldOf(offer.text, "pick")) } });
  };
  const failed = await accept();
  assert.equal(failed.status, 502, failed.text);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null, "a failed init records no binding");
  const made = await accept();
  assert.equal(made.status, 200, made.text);
  assert.match(made.text, /made it a desk/i);
  assert.equal((await ctx.store.getBinding(ctx.jordanId)).repo, "jordan-dev/notes");
  assert.equal(ctx.inits.length, 2);
  assert.deepEqual(Object.keys(ctx.inits[1]).sort(), ["accountId", "binding"]);
  assert.equal(ctx.inits[1].accountId, ctx.jordanId);
});

test("permission revoked suspends at next session start and shows relink page", async (t) => {
  const ctx = await startLinking(t);
  assert.equal((await choose(ctx, await linkThroughGitHub(ctx), DESK_REPO)).status, 200);
  const link = ctx.link;
  assert.equal(await link.recheckBinding({ accountId: ctx.jordanId }), "ok");
  ctx.github.state.repos[DESK_REPO].collaborators["jordan-dev"] = "read";
  assert.equal(await link.recheckBinding({ accountId: ctx.jordanId }), "suspended");
  assert.equal((await ctx.store.getBinding(ctx.jordanId)).suspended, true);
  const relink = await ctx.jordan.request("/link/github");
  assert.equal(relink.status, 200);
  assert.match(relink.text, /suspended/i);
  assert.match(relink.text, /jordan-dev\/desk/);
  assert.match(relink.text, /value="start"/);
  assert.match(suspendedMessage(GATEWAY), new RegExp(`${GATEWAY}/link/github`));
  // GitHub down is not a revocation: the session is refused for now, and the binding is not suspended for it.
  ctx.github.state.repos[DESK_REPO].collaborators["jordan-dev"] = "write";
  ctx.github.state.down = true;
  assert.equal(await link.recheckBinding({ accountId: ctx.jordanId }), "unavailable");
  ctx.github.state.down = false;
  assert.equal(await link.recheckBinding({ accountId: ctx.jordanId }), "ok", "write access back clears the suspension");
  assert.equal((await ctx.store.getBinding(ctx.jordanId)).suspended, undefined);
  // The App uninstalled from the repo suspends it too.
  delete ctx.github.state.repos[DESK_REPO];
  assert.equal(await link.recheckBinding({ accountId: ctx.jordanId }), "suspended");
});

test("a binding the operator seeded (no GitHub user) and an account with no binding are not rechecked against GitHub", async (t) => {
  const ctx = await startLinking(t);
  const calls = ctx.github.state.calls.length;
  assert.equal(await ctx.link.recheckBinding({ accountId: ctx.accountId }), "ok", "Ari's seeded binding");
  assert.equal(await ctx.link.recheckBinding({ accountId: ctx.jordanId }), "none");
  assert.equal(ctx.github.state.calls.length, calls);
});

test("our App's own failures and GitHub's rate limits are 'try again', never a suspension", async (t) => {
  const ctx = await startLinking(t);
  assert.equal((await choose(ctx, await linkThroughGitHub(ctx), DESK_REPO)).status, 200);
  for (const [what, failure] of [
    ["the App's JWT refused", { path: /\/installation$/, status: 401 }],
    ["access tokens rate-limited", { path: /\/access_tokens$/, status: 403 }],
    ["permission rate-limited", { path: /\/permission$/, status: 403 }],
    ["permission 429", { path: /\/permission$/, status: 429 }],
    ["GitHub 502", { path: /\/permission$/, status: 502 }],
  ]) {
    ctx.github.state.failures = [failure];
    assert.equal(await ctx.link.recheckBinding({ accountId: ctx.jordanId }), "unavailable", what);
    assert.equal((await ctx.store.getBinding(ctx.jordanId)).suspended, undefined, what);
  }
  ctx.github.state.failures = [{ path: /\/installation$/, status: 404 }];
  assert.equal(await ctx.link.recheckBinding({ accountId: ctx.jordanId }), "suspended", "the App uninstalled");
});

test("session start: a suspended desk is refused with the relink message, GitHub down with try again, a good one starts", async (t) => {
  const ctx = await startLinking(t);
  assert.equal((await choose(ctx, await linkThroughGitHub(ctx), DESK_REPO)).status, 200);
  assert.equal(await ctx.link.sessionRefusal(ctx.jordanId), null);
  assert.equal(await ctx.link.sessionRefusal(ctx.accountId), null, "Ari's seeded binding starts without a GitHub call");
  ctx.github.state.down = true;
  assert.match(await ctx.link.sessionRefusal(ctx.jordanId), /Try again/);
  ctx.github.state.down = false;
  ctx.github.state.repos[DESK_REPO].collaborators["jordan-dev"] = "read";
  assert.equal(await ctx.link.sessionRefusal(ctx.jordanId), suspendedMessage(GATEWAY));
  assert.equal(await ctx.link.sessionRefusal(ctx.jordanId), suspendedMessage(GATEWAY), "still refused at the next start");
});

test("one repository is one account's desk whatever its case; a suspended binding no longer holds it", async (t) => {
  const ctx = await startLinking(t);
  const other = randomUUID();
  await ctx.store.putAccount({ accountId: other, displayName: "Old Owner", deskAccess: true });
  await ctx.store.putBinding(other, { kind: "github", repo: "Jordan-Dev/Desk", installationId: INSTALLATION, author: { name: "x", email: "1+x@users.noreply.github.com" } });
  const refused = await choose(ctx, await linkThroughGitHub(ctx), DESK_REPO);
  assert.equal(refused.status, 409, "Jordan-Dev/Desk and jordan-dev/desk are one repository");
  await ctx.store.putBinding(other, { kind: "github", repo: "Jordan-Dev/Desk", installationId: INSTALLATION, suspended: true, author: { name: "x", email: "1+x@users.noreply.github.com" } });
  const linked = await choose(ctx, await linkThroughGitHub(ctx), DESK_REPO);
  assert.equal(linked.status, 200, linked.text);
});

test("a failed init never erases a binding it couldn't read, and tells the runtime after a rollback", async (t) => {
  const ctx = await startLinking(t, { repos: { "jordan-dev/notes": { installationId: INSTALLATION, collaborators: { "jordan-dev": "admin" }, files: [] } }, initDesk: () => ({ status: "error", step: "commit" }) });
  const offer = await choose(ctx, await linkThroughGitHub(ctx), "jordan-dev/notes");
  const pick = { action: "init", csrf: decode(csrfOf(offer.text)), pick: decode(fieldOf(offer.text, "pick")) };
  // A row this gateway can't read as a binding (a v1c hosted desk, say).
  await ctx.store.tables.upsert("bindings", { partitionKey: ctx.jordanId, rowKey: "", kind: "hosted", deskId: "d1" });
  const stopped = await ctx.jordan.request("/link/github", { method: "POST", form: pick });
  assert.equal(stopped.status, 503, stopped.text);
  assert.equal((await ctx.store.tables.get("bindings", ctx.jordanId, "")).entity.kind, "hosted", "the unreadable row is untouched");
  assert.equal(ctx.inits.length, 0);
  await ctx.store.tables.remove("bindings", ctx.jordanId, "");
  const failed = await ctx.jordan.request("/link/github", { method: "POST", form: pick });
  assert.equal(failed.status, 502);
  assert.equal(await ctx.store.getBinding(ctx.jordanId), null);
  assert.deepEqual(ctx.linked, [ctx.jordanId], "the runtime hears about the rollback");
});

test("createGitHubLink refuses an App id that isn't a number", () => {
  const base = { key: "k".repeat(32), store: {}, sessions: {}, issuer: GATEWAY, clientId: "c", clientSecret: "s", callbackUrl: `${GATEWAY}/cb`, privateKeyPem: PRIVATE_KEY, initDesk: () => {} };
  assert.throws(() => createGitHubLink({ ...base, appId: "Iv1.abc" }), /numeric id/);
  assert.throws(() => createGitHubLink({ ...base, appId: undefined }), /numeric id/);
  assert.doesNotThrow(() => createGitHubLink({ ...base, appId: "123" }));
});
