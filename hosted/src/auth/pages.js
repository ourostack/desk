// The few HTML pages the gateway shows a browser during sign-in. Every value
// put into a page is HTML-escaped, and every page refuses to be framed.

export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const document = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Desk sign-in</title></head><body>${body}</body></html>`;

// A page holding one message.
export const page = (status, message) => ({ status, html: document(`<p>${escapeHtml(message)}</p>`) });

// Asks the person whether this client may sign in. Approve posts the sealed
// request back to the gateway, which only then sends the browser to GitHub.
export function consentPage({ clientName, redirectUri, consent }) {
  const name = typeof clientName === "string" && clientName.trim() !== "" ? clientName : "an app";
  const host = new URL(redirectUri).host;
  return {
    status: 200,
    html: document(
      `<p>Connect ${escapeHtml(name)} to Hosted Desk? After you sign in with GitHub, it will be sent to ${escapeHtml(host)}.</p>` +
        `<form method="post" action="/oauth/consent"><input type="hidden" name="consent" value="${escapeHtml(consent)}"><button type="submit">Approve</button></form>`,
    ),
  };
}

// Sends a page with headers that keep it out of frames and caches.
export function sendPage(res, { status, html }) {
  res
    .status(status)
    .set({
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    })
    .type("html")
    .send(html);
}
