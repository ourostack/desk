// The "Ouro Desk" GitHub App's credentials: an App JWT signed with the App's
// private key, exchanged for an installation token scoped to the desk
// repository. Only the gateway holds the key; Git gets installation tokens
// through the token socket.
import { createSign } from "node:crypto";

const API = "https://api.github.com";
const REFRESH_BEFORE_MS = 5 * 60_000;
// A GitHub call that has not answered by then fails, so a hung request
// cannot hold up every Git and gh call that waits on the token.
const CALL_TIMEOUT_MS = 10_000;

const base64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

// `now` is in seconds since the epoch. GitHub allows at most ten minutes of
// validity and the clock may drift, so the token starts a minute in the past.
export function appJwt({ appId, privateKeyPem, now = Math.floor(Date.now() / 1000) }) {
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem);
  return `${unsigned}.${signature.toString("base64url")}`;
}

async function call(fetch, path, jwt, init = {}, timeoutMs = CALL_TIMEOUT_MS) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "ouro-desk-hosted",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub answered ${response.status} to ${init.method ?? "GET"} ${path}`), { status: response.status });
  return response.json();
}

async function mint({ appId, privateKeyPem, repo, installationId, fetch, now, timeoutMs }) {
  const jwt = appJwt({ appId, privateKeyPem, now: Math.floor(now() / 1000) });
  const installation = await call(fetch, `/repos/${repo}/installation`, jwt, {}, timeoutMs);
  // A binding records the installation it was linked through; a repository now served by another installation is
  // not that binding's desk any more.
  if (installationId !== undefined && installation.id !== installationId) {
    throw Object.assign(new Error(`the App's installation for ${repo} is not the one its binding names`), { code: "installation_mismatch" });
  }
  const body = JSON.stringify({ repositories: [repo.split("/")[1]], permissions: { contents: "write", pull_requests: "read" } });
  const granted = await call(fetch, `/app/installations/${installation.id}/access_tokens`, jwt, { method: "POST", body }, timeoutMs);
  return { token: granted.token, expiresAt: Date.parse(granted.expires_at) };
}

// One cached token (or request in flight) per App, repository and expected installation.
const cache = new Map();

// Returns `{ token, expiresAt }` (expiresAt in milliseconds since the epoch).
// A token is reused until five minutes before it expires; concurrent callers
// share one request, and a failed request (or one that timed out) is not
// cached.
// `installationId`, when given, is the installation the token must come from.
export function installationToken({ appId, privateKeyPem, repo, installationId, fetch = globalThis.fetch, now = Date.now, timeoutMs = CALL_TIMEOUT_MS }) {
  const key = `${appId}\0${repo}\0${installationId ?? ""}`;
  const cached = cache.get(key);
  if (cached?.pending) return cached.pending;
  if (cached && cached.expiresAt - REFRESH_BEFORE_MS > now()) return Promise.resolve(cached);
  const pending = mint({ appId, privateKeyPem, repo, installationId, fetch, now, timeoutMs }).then(
    (minted) => {
      cache.set(key, minted);
      return minted;
    },
    (error) => {
      cache.delete(key);
      throw error;
    },
  );
  cache.set(key, { pending });
  return pending;
}
