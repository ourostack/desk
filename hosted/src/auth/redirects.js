// Which redirect URIs a client may name. A client's sign-in code goes to its
// redirect, so this list decides where a code can ever be sent.
//
// `configured` is DESK_REDIRECTS: comma-separated exact URLs. Unset or blank,
// it is DEFAULT_REDIRECTS; set, it replaces all of them. Two kinds of redirect are allowed whatever it
// says: loopback over http on any port (native and command-line clients pick
// a free port each time), and ChatGPT's per-connector callback, whose last
// segment differs for every ChatGPT connector, so listing them would need a
// redeploy for each one.

// Claude's callbacks, and VS Code's web relays, which VS Code registers
// alongside its loopback redirects; it is refused unless every one is allowed.
export const DEFAULT_REDIRECTS = Object.freeze([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://vscode.dev/redirect",
  "https://insiders.vscode.dev/redirect",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
// Matched on the raw string, so nothing a URL parser would normalize (a dot
// segment, an encoded character, a default port) can slip through.
const CHATGPT_CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;

function isLoopback(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password && !uri.includes("#");
}

export function createRedirectPolicy(configured) {
  const listed = (configured ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Entries are matched as exact text, so each must already be in the form a
  // URL parser writes (lower-case host, no default port), or it would never
  // match. A redirect may not carry a fragment or user info (RFC 6749 3.1.2),
  // and must be https unless it is loopback.
  for (const entry of listed) {
    const url = URL.canParse(entry) ? new URL(entry) : null;
    const usable = url && url.href === entry && !entry.includes("#") && !url.username && !url.password && (url.protocol === "https:" || isLoopback(entry));
    if (!usable) {
      throw new Error(`DESK_REDIRECTS holds an entry that is not a canonical https or loopback URL without a fragment or user info: ${entry}`);
    }
  }
  const effective = listed.length ? listed : [...DEFAULT_REDIRECTS];
  const exact = new Set(effective);

  return {
    // The exact URLs in force, for the start-up log.
    listed: effective,
    allows(uri) {
      if (typeof uri !== "string") return false;
      return exact.has(uri) || CHATGPT_CALLBACK.test(uri) || isLoopback(uri);
    },
  };
}
