// The "Ouro Desk" GitHub App's credentials: an App JWT signed with the App's
// private key, exchanged for an installation token scoped to the desk
// repository. Only the gateway holds the key; Git gets installation tokens
// through the token socket.
import { createSign } from "node:crypto";

const API = "https://api.github.com";
const REFRESH_BEFORE_MS = 5 * 60_000;

const base64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

// `now` is in seconds since the epoch. GitHub allows at most ten minutes of
// validity and the clock may drift, so the token starts a minute in the past.
export function appJwt({ appId, privateKeyPem, now = Math.floor(Date.now() / 1000) }) {
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem);
  return `${unsigned}.${signature.toString("base64url")}`;
}

async function call(fetch, path, jwt, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "ouro-desk-hosted",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${init.method ?? "GET"} ${path}`);
  return response.json();
}

async function mint({ appId, privateKeyPem, repo, fetch, now }) {
  const jwt = appJwt({ appId, privateKeyPem, now: Math.floor(now() / 1000) });
  const installation = await call(fetch, `/repos/${repo}/installation`, jwt);
  const granted = await call(fetch, `/app/installations/${installation.id}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions: { contents: "write", pull_requests: "read" } }),
  });
  return { token: granted.token, expiresAt: Date.parse(granted.expires_at) };
}

// One cached token (or request in flight) per App and repository.
const cache = new Map();

// Returns `{ token, expiresAt }` (expiresAt in milliseconds since the epoch).
// A token is reused until five minutes before it expires; concurrent callers
// share one request, and a failed request is not cached.
export function installationToken({ appId, privateKeyPem, repo, fetch = globalThis.fetch, now = Date.now }) {
  const key = `${appId}\0${repo}`;
  const cached = cache.get(key);
  if (cached?.pending) return cached.pending;
  if (cached && cached.expiresAt - REFRESH_BEFORE_MS > now()) return Promise.resolve(cached);
  const pending = mint({ appId, privateKeyPem, repo, fetch, now }).then(
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
