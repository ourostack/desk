// The few HTML pages the gateway shows a browser: the front door at /, the
// consent page and the sign-in error pages. Every value put into a page is
// HTML-escaped, and every page refuses to be framed. The pages load only the
// gateway's own stylesheet and Desk icon (served by assetRoute), so their
// policy allows styles and images from 'self' and nothing else.
import { readFileSync } from "node:fs";

export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const PRIVACY_URL = "https://ouroboros.bot/privacy/";
export const TERMS_URL = "https://ouroboros.bot/terms/";
export const DESK_PAGE_URL = "https://ouroboros.bot/desk/";

const ICON = '<img src="/assets/desk-icon.svg" class="icon" width="72" height="72" alt="Hosted Desk icon">';
const legal = `<a href="${PRIVACY_URL}">Privacy</a><a href="${TERMS_URL}">Terms</a>`;

const document = (title, body, { home = true } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/desk.css"><link rel="icon" href="/assets/desk-icon.svg" type="image/svg+xml"></head>` +
  `<body><main>${ICON}${body}<footer>${home ? '<a href="/">About Hosted Desk</a>' : ""}${legal}</footer></main></body></html>`;

// The front door at /: what hosted Desk is and that it is not open yet.
export const frontDoor = () => ({
  status: 200,
  html: document(
    "Hosted Desk",
    `<span class="tag">Not open yet</span><h1>Hosted Desk</h1>` +
      `<p class="lede">Hosted Desk runs Desk as a service, so Claude on claude.ai can read and update your desk: the tasks, notes and decisions you keep in a GitHub repository.</p>` +
      `<p>Today it serves one desk, and only one GitHub account can sign in.</p>` +
      `<a class="btn" href="${DESK_PAGE_URL}">Read about Desk</a>`,
    { home: false },
  ),
});

// A sign-in page holding one message: an expired link, a refused login, a
// gateway that is not set up yet.
export const page = (status, message) => ({
  status,
  html: document("Hosted Desk sign-in", `<h1>Sign-in stopped</h1><p class="lede">${escapeHtml(message)}</p>`),
});

// Asks the person whether this client may sign in. Approve posts the sealed
// request back to the gateway, which only then sends the browser to GitHub.
// What the client can and cannot do follows what the gateway allows: every
// Desk tool on one desk repository, including the destructive ones
// (runtime/hosted.js), through an installation token that can write only to
// that repository (it can still read public repositories), with no shell, and
// a GitHub user token used once and dropped while the grant keeps the login,
// user id and name (auth/github.js). The disconnect line is shown only to
// claude.ai, where Claude's settings remove the connector.
// `clientHost`, for a client known by its metadata document's URL, is that
// URL's host, shown under the heading, above the name the document gives itself.
export function consentPage({ clientName, clientHost, redirectUri, consent, deskRepo }) {
  const named = typeof clientName === "string" && clientName.trim() !== "";
  const name = escapeHtml(named ? clientName : "an app");
  const Name = named ? name : "An app";
  const host = escapeHtml(new URL(redirectUri).host);
  const fromClaude = new URL(redirectUri).host === "claude.ai";
  const repo = typeof deskRepo === "string" && deskRepo !== "" ? `<code>${escapeHtml(deskRepo)}</code>` : "your desk repository";
  return {
    status: 200,
    html: document(
      "Connect to Hosted Desk",
      `<h1>Connect ${name} to your desk</h1>` +
        (clientHost ? `<p class="from">From <strong>${escapeHtml(clientHost)}</strong></p>` : "") +
        `<p class="lede">When you approve, you sign in with GitHub, and then Hosted Desk sends you back to <strong>${host}</strong>.</p>` +
        `<div class="scopes">` +
        `<h2>${Name} will be able to:</h2><ul class="can">` +
        `<li>${escapeHtml("Read and search your desk: its tasks, tracks, notes and Desk's skills.")}</li>` +
        `<li>Create and change anything in your desk, including archiving and moving tasks, renaming tracks, replacing files and running repairs. Each change is committed and pushed to ${repo}.</li>` +
        `</ul><h2>${Name} will not be able to:</h2><ul class="cannot">` +
        `<li>Change any repository other than ${repo}.</li>` +
        `<li>Run commands or reach your computer.</li>` +
        `<li>Keep your GitHub sign-in. Hosted Desk keeps only your GitHub username, user id and name, and discards the GitHub token.</li>` +
        `</ul></div>` +
        `<form method="post" action="/oauth/consent"><input type="hidden" name="consent" value="${escapeHtml(consent)}"><button type="submit">Approve</button></form>` +
        `<p class="note">To cancel, close this page.</p>` +
        (fromClaude ? `<p class="note">${escapeHtml("You can disconnect at any time in Claude's settings, under Customize > Connectors.")}</p>` : ""),
    ),
  };
}

const PAGE_POLICY = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'";

// Sends a page with headers that keep it out of frames and caches.
export function sendPage(res, { status, html }) {
  res
    .status(status)
    .set({
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "content-security-policy": PAGE_POLICY,
    })
    .type("html")
    .send(html);
}

// The pages' two files, read once at start. Only these names are served.
const ASSETS = {
  "desk-icon.svg": { type: "image/svg+xml", policy: "default-src 'none'; style-src 'unsafe-inline'; sandbox" },
  "desk.css": { type: "text/css; charset=utf-8", policy: "default-src 'none'" },
};
const assetBytes = Object.fromEntries(
  Object.keys(ASSETS).map((name) => [name, readFileSync(new URL(`../../public/${name}`, import.meta.url))]),
);

// The Express route for GET /assets/:name.
export function assetRoute(req, res, next) {
  const name = req.params.name;
  if (!Object.hasOwn(ASSETS, name)) return next();
  res
    .status(200)
    .set({
      "content-type": ASSETS[name].type,
      "x-content-type-options": "nosniff",
      "content-security-policy": ASSETS[name].policy,
      "cache-control": "public, max-age=3600",
    })
    .send(assetBytes[name]);
}
