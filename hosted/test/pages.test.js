import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createProvider } from "../src/auth/provider.js";
import { createApp } from "../src/server.js";
import { consentPage, page } from "../src/auth/pages.js";

const KEY = "test-key-0123456789abcdef0123456789abcdef";
const ISSUER = "https://desk.ouro.bot";
const RESOURCE = "https://desk.ouro.bot/mcp";
const NOT_SET_UP = "Hosted Desk is not set up yet: its GitHub App is missing.";
const PRIVACY = "https://ouroboros.bot/privacy/";
const TERMS = "https://ouroboros.bot/terms/";
const DESK_PAGE = "https://ouroboros.bot/desk/";
// The Desk icon is copied byte for byte from the brand work, never redrawn.
const ICON_SHA256 = "abc21db46f75faa36a38e3cc6369596d916ba5a177e2b90be405a87cdfccfc6e";

async function start(t, { unavailable } = {}) {
  const provider = createProvider({
    key: KEY,
    issuer: ISSUER,
    github: { clientId: "Iv1.ouro-desk", clientSecret: "secret", fetch: () => assert.fail("no GitHub call expected") },
    allowedLogins: ["arimendelow"],
    resource: RESOURCE,
    deskRepo: "arimendelow/desk",
    log: () => {},
  });
  const relay = { handle: () => assert.fail("no relay expected") };
  const app = createApp({ provider, relay, githubCallback: provider.githubCallback, issuer: ISSUER, resource: RESOURCE, unavailable });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// Every page shares the Desk look: the icon, the stylesheet, and links to the
// privacy notice and terms.
function assertDeskLook(html) {
  assert.match(html, /<link rel="stylesheet" href="\/assets\/desk\.css">/);
  assert.match(html, /<link rel="icon" href="\/assets\/desk-icon\.svg" type="image\/svg\+xml">/);
  assert.match(html, /<img src="\/assets\/desk-icon\.svg"[^>]* alt="Desk icon"/);
  assert.ok(html.includes(`href="${PRIVACY}"`), "links to the privacy notice");
  assert.ok(html.includes(`href="${TERMS}"`), "links to the terms");
}

function assertPageHeaders(response) {
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

test("GET / is a front door that says what hosted Desk is, that it is not open yet and single-user today", async (t) => {
  const base = await start(t);
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assertPageHeaders(response);
  const html = await response.text();
  assertDeskLook(html);
  assert.match(html, /<title>Hosted Desk<\/title>/);
  assert.match(html, /<h1>Hosted Desk<\/h1>/);
  assert.match(html, /Not open yet/);
  assert.match(html, /Hosted Desk runs Desk as a service, so Claude on claude\.ai can read and update your desk/);
  assert.match(html, /Today it serves one desk, and only one GitHub account can sign in\./);
  assert.ok(html.includes(`href="${DESK_PAGE}"`), "links to the Desk page on ouroboros.bot");
});

test("GET / answers the same while the gateway is not set up, and HEAD / works", async (t) => {
  const base = await start(t, { unavailable: NOT_SET_UP });
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Not open yet/);
  const head = await fetch(`${base}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
});

test("the Desk icon is served byte for byte from the brand file", async (t) => {
  const base = await start(t);
  const response = await fetch(`${base}/assets/desk-icon.svg`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ICON_SHA256);
  const file = readFileSync(new URL("../public/desk-icon.svg", import.meta.url));
  assert.equal(createHash("sha256").update(file).digest("hex"), ICON_SHA256);
});

test("the stylesheet is served as CSS", async (t) => {
  const base = await start(t);
  const response = await fetch(`${base}/assets/desk.css`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/css/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(await response.text(), /prefers-color-scheme: dark/);
});

test("an unknown asset is a 404, not a file read outside the asset list", async (t) => {
  const base = await start(t);
  for (const path of ["/assets/missing.svg", "/assets/..%2Fpackage.json", "/assets/../package.json"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test("the consent page lists what the client can and cannot do, from what the gateway actually allows", () => {
  const { status, html } = consentPage({
    clientName: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    consent: "sealed",
    deskRepo: "arimendelow/desk",
  });
  assert.equal(status, 200);
  assertDeskLook(html);
  assert.match(html, /<h1>Connect Claude to your desk<\/h1>/);
  assert.match(html, /When you approve, you sign in with GitHub, and then Hosted Desk sends you back to <strong>claude\.ai<\/strong>\./);
  assert.match(html, /Claude will be able to:/);
  assert.match(html, /Read and search your desk: its tasks, tracks, notes and Desk&#39;s skills\./);
  assert.match(html, /Create and update tasks and tracks, record friction and lessons, and save files to your desk\. Each change is committed and pushed to <code>arimendelow\/desk<\/code>\./);
  assert.match(html, /Claude will not be able to:/);
  assert.match(html, /Reach any repository other than <code>arimendelow\/desk<\/code>\./);
  assert.match(html, /Run commands or reach your computer\./);
  assert.match(html, /Keep your GitHub sign-in\. Hosted Desk reads your GitHub username once to check it, then discards the GitHub token\./);
  assert.match(html, /<form method="post" action="\/oauth\/consent"><input type="hidden" name="consent" value="sealed"><button type="submit">Approve<\/button><\/form>/);
  assert.match(html, /To cancel, close this page\./);
});

test("the consent page without a desk repository names it generically", () => {
  const { html } = consentPage({ clientName: "", redirectUri: "http://127.0.0.1:33418/callback", consent: "sealed" });
  assert.match(html, /<h1>Connect an app to your desk<\/h1>/);
  assert.match(html, /An app will be able to:/);
  assert.match(html, /committed and pushed to your desk repository\./);
  assert.match(html, /Reach any repository other than your desk repository\./);
  assert.match(html, /sends you back to <strong>127\.0\.0\.1:33418<\/strong>\./);
});

test("a sign-in error page shares the Desk look, escapes its message and links home", () => {
  const { status, html } = page(403, "This Desk is not open to <b>mallory</b>.");
  assert.equal(status, 403);
  assertDeskLook(html);
  assert.match(html, /<h1>Sign-in stopped<\/h1>/);
  assert.match(html, /This Desk is not open to &lt;b&gt;mallory&lt;\/b&gt;\./);
  assert.match(html, /<a href="\/">About hosted Desk<\/a>/);
});

test("the not-set-up page on /authorize is a styled 503", async (t) => {
  const base = await start(t, { unavailable: NOT_SET_UP });
  const response = await fetch(`${base}/authorize?client_id=x`);
  assert.equal(response.status, 503);
  assertPageHeaders(response);
  const html = await response.text();
  assertDeskLook(html);
  assert.match(html, /<h1>Sign-in stopped<\/h1>/);
  assert.ok(html.includes(NOT_SET_UP));
});
