import { randomUUID } from "node:crypto";

// A fake GitHub for the gateway's tests, which never reach the network: the OAuth token exchange, the user endpoints
// a user token reads (as `user`), and the App endpoints an App JWT or installation token reads. `state.repos` maps owner/name to `{ installationId, collaborators: {login: role}, files }`.
// Every request is recorded with the token it carried.
export function fakeGitHub({ user, repos = {}, appId } = {}) {
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
    // `onCall(path)`, when set, runs before each answer: a test's way to change something mid-request.
    await state.onCall?.(url.pathname);
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
