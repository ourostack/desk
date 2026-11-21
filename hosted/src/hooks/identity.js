// Sign-in for managing and reading hooks: `Authorization: Bearer <GitHub token>`, the token `gh auth token` prints.
// GitHub's GET /user names the token's user, who must be in DESK_GITHUB_ACCOUNTS, the mapping the gateway already
// trusts. No new secret reaches the Mac. Each answer is cached for 5 minutes under the token's SHA-256 (never the token
// itself), so a poll every minute asks GitHub about once in five; when GitHub can't answer, a cached answer still
// serves until it is 5 minutes old, and after that the call fails with 503 so the poller tries again.
import { createHash } from "node:crypto";

const CACHE_MS = 5 * 60_000;
const NO_TOKEN = { status: 401, error: "send Authorization: Bearer <GitHub token>" };

/** `accounts`: a Map from GitHub user id to `{ login, accountId }`, as readGithubAccounts reads it. */
export function githubIdentity({ accounts, fetch, now = Date.now, maxCached = 1000 }) {
  const cache = new Map();
  const mappedLogins = [...accounts.values()].map((entry) => entry.login).join(" or ");

  async function ask(token) {
    let response;
    try {
      response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "desk-hooks" }, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      return { status: 503, error: `GitHub could not confirm the token (${error.message}); try again shortly` };
    }
    // GitHub answers 403 (or 429) when its rate limit is spent; that is a wait, not a bad token.
    if (response.status === 429 || (response.status === 403 && response.headers?.get?.("x-ratelimit-remaining") === "0")) return { status: 503, error: `GitHub's rate limit stopped it confirming the token (HTTP ${response.status}); try again shortly` };
    if (response.status === 401 || response.status === 403) return { status: 401, error: `GitHub refused the token (HTTP ${response.status}); sign in again with gh auth login` };
    if (!response.ok) return { status: 503, error: `GitHub could not confirm the token (HTTP ${response.status}); try again shortly` };
    let user;
    try {
      user = await response.json();
    } catch {
      return { status: 503, error: "GitHub's answer about the token was not JSON; try again shortly" };
    }
    const mapped = accounts.get(Number(user.id));
    if (!mapped) return { status: 401, error: `GitHub user ${user.login} (${user.id}) has no Desk account; poll with gh auth token --user ${mappedLogins}`, cache: true };
    return { accountId: mapped.accountId, cache: true };
  }

  return async function identify(authorization) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
    if (!match) return NO_TOKEN;
    const key = createHash("sha256").update(match[1]).digest("base64url");
    const cached = cache.get(key);
    if (cached && now() - cached.at <= CACHE_MS) return cached.result;
    const { cache: keep, ...result } = await ask(match[1]);
    if (keep) {
      cache.delete(key);
      cache.set(key, { at: now(), result });
      if (cache.size > maxCached) cache.delete(cache.keys().next().value);
    }
    return result;
  };
}
