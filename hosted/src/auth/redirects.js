// Which redirect URIs a client may name. A client's sign-in code goes to its
// redirect, so this list decides where a code can ever be sent.
//
// `configured` is DESK_REDIRECTS: comma-separated exact URLs. Unset or blank,
// it is Claude's two callbacks. Two kinds of redirect are allowed whatever it
// says: loopback over http on any port (native and command-line clients pick
// a free port each time), and ChatGPT's per-connector callback, whose last
// segment differs for every ChatGPT connector, so listing them would need a
// redeploy for each one.

const DEFAULT_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
// Matched on the raw string, so nothing a URL parser would normalize (a dot
// segment, an encoded character, a default port) can slip through.
const CHATGPT_CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;

export function createRedirectPolicy(configured) {
  const listed = (configured ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of listed) {
    if (!URL.canParse(entry)) throw new Error(`DESK_REDIRECTS holds an entry that is not an absolute URL: ${entry}`);
  }
  const exact = new Set(listed.length ? listed : DEFAULT_REDIRECTS);

  function isLoopback(uri) {
    let url;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password;
  }

  return {
    allows(uri) {
      if (typeof uri !== "string") return false;
      return exact.has(uri) || CHATGPT_CALLBACK.test(uri) || isLoopback(uri);
    },
  };
}
