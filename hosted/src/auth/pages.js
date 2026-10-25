// The few HTML pages the gateway shows a browser during sign-in. Every value
// put into a page is HTML-escaped, and every page refuses to be framed.

export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const document = (body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Desk sign-in</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="/assets/desk.css"></head><body><header class="brand"><img src="/assets/desk-logo.png" width="80" height="80" alt=""><h1>Hosted Desk</h1></header><main>${body}</main></body></html>`;

// Where a signed-in person links a GitHub repository as their desk (github-link.js LINK_PATH).
const LINK_GITHUB = "/link/github";

// A page whose body is `bodyHtml`, which the caller has already escaped.
export const htmlPage = (status, bodyHtml) => ({ status, html: document(bodyHtml) });

// A page holding one message.
export const page = (status, message) => ({ status, html: document(`<p>${escapeHtml(message)}</p>`) });

// Asks the person whether this client may sign in. Approve posts the sealed
// request back to the gateway, which only then sends the browser on to sign in.
// `clientHost`, for a client known by its metadata document's URL, is that
// URL's host, shown above the name the document gives itself.
//
// `signIn` says where sign-in goes. Without it (today's gateway, with no Ouro
// tenant configured) the page offers GitHub alone. With `{ entra: true }` the
// page offers the Ouro tenant ("Apple or email"), plus a second button for
// GitHub only when `github` (the fallback) is on; that button posts the same
// form with `method=github`.
export function consentPage({ clientName, clientHost, redirectUri, consent, signIn }) {
  const name = typeof clientName === "string" && clientName.trim() !== "" ? clientName : "an app";
  const host = new URL(redirectUri).host;
  const from = clientHost ? `<p>From <strong>${escapeHtml(clientHost)}</strong></p>` : "";
  const field = `<input type="hidden" name="consent" value="${escapeHtml(consent)}">`;
  if (!signIn?.entra) {
    return {
      status: 200,
      html: document(
        from +
          `<p>Connect ${escapeHtml(name)} to Hosted Desk? After you sign in with GitHub, it will be sent to ${escapeHtml(host)}.</p>` +
          `<form method="post" action="/oauth/consent">${field}<button type="submit">Approve</button></form>`,
      ),
    };
  }
  const github = signIn.github ? `<button type="submit" name="method" value="github">Continue with GitHub</button>` : "";
  return {
    status: 200,
    html: document(
      from +
        `<p>Connect ${escapeHtml(name)} to Hosted Desk? After you sign in, it will be sent to ${escapeHtml(host)}.</p>` +
        `<form method="post" action="/oauth/consent">${field}<button type="submit" name="method" value="entra">Continue with Apple or email</button>${github}</form>`,
    ),
  };
}

// Pages for sign-in through the Ouro tenant and for invites.
export const startingUpPage = () => page(503, "Sign-in is starting up. Please try again shortly.");
// `{ page: true }` words a page for a sign-in to the gateway's own pages (/signin), which starts again there, not in
// Claude.
const again = ({ page: forPage } = {}) => (forPage ? "sign in again" : "start again from Claude");
const Again = (options) => again(options).replace(/^s/, "S");
export const signInUnavailablePage = (options) => page(503, `Sign-in can't be completed right now. Please try again shortly, then ${again(options)}.`);
export const startAgainPage = (options) => page(400, `This sign-in link has expired, or it was started in another browser. ${Again(options)}.`);
export const inviteOnlyPage = (options) => page(403, `Hosted Desk is invite-only. Open your invite link in this browser first, then ${again(options)}.`);
export const inviteRefusedPage = () => page(403, "This invite has already been used or has expired. Ask for a new invite.");
export const accessOffPage = () => page(403, "Desk access is turned off for this account.");
// `link`: the gateway links GitHub desks (a multi-user gateway), so the page sends the person there.
export const noDeskPage = ({ link = false } = {}) =>
  link
    ? htmlPage(403, `<p>There is no desk for this account yet on this Hosted Desk.</p><p><a href="${LINK_GITHUB}">Link a GitHub repository as your desk</a>, then connect Hosted Desk from Claude again.</p>`)
    : page(403, "There is no desk for this account yet on this Hosted Desk.");
export const inviteInvalidPage = () => page(404, "This invite link isn't valid: it may have expired or already been used. Ask for a new invite.");
// `linkGitHub`: the gateway links GitHub desks, so the person first signs in here and links the repository that is
// their desk, then connects Claude.
export const invitePage = ({ issuer, linkGitHub = false } = {}) => {
  const connector = `add a custom connector${issuer ? ` with the URL <strong>${escapeHtml(new URL("/mcp", issuer).href)}</strong>` : ""}`;
  return {
    status: 200,
    html: document(
      "<p>You're invited to Hosted Desk.</p>" +
        (linkGitHub
          ? `<p>First, <a href="/signin?next=${LINK_GITHUB}">sign in and link the GitHub repository for your desk</a>. Sign in with Apple or email in this browser. Your invite is used the first time you sign in.</p>` +
            `<p>Then, in Claude, ${connector} and connect it.</p>`
          : `<p>In Claude, ${connector}, then connect it and sign in with Apple or email in this browser. Your invite is used the first time you sign in.</p>`),
    ),
  };
};

// Pages of the browser session (browser-session.js).
export const signInCancelledPage = () => page(400, "Sign-in was cancelled. Sign in again to continue.");
export const signedOutPage = ({ everywhere = true } = {}) =>
  page(200, everywhere ? "You're signed out of Hosted Desk." : "You're signed out of Hosted Desk in this browser. Hosted Desk couldn't sign out your other browsers just now; to do that, sign in and sign out again later.");
export const pageRefusedPage = () => page(403, "This change didn't come from a Hosted Desk page in this browser. Reload the page and try again.");
// The signed-in account's page: who is signed in, a link to its GitHub desk when the gateway links them
// (`linkGitHub`), and a sign-out form carrying the session's CSRF token.
export const accountPage = ({ displayName, csrf, linkGitHub = false }) => ({
  status: 200,
  html: document(
    `<p>You're signed in to Hosted Desk as <strong>${escapeHtml(displayName || "your account")}</strong>.</p>` +
      (linkGitHub ? `<p><a href="${LINK_GITHUB}">Your GitHub desk</a></p>` : "") +
      `<form method="post" action="/signout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Sign out</button></form>`,
  ),
});

// Sends a page with headers that keep it out of frames and caches, plus any
// `headers` the page carries.
export function sendPage(res, { status, html, headers = {} }) {
  res
    .status(status)
    .set({
      ...headers,
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'self'; frame-ancestors 'none'",
    })
    .type("html")
    .send(html);
}
