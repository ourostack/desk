// Who may manage and read hooks: the holder of a GitHub token whose user id DESK_GITHUB_ACCOUNTS maps to a Desk account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { githubIdentity } from "../src/hooks/identity.js";
import { readGithubAccounts } from "../src/identity-config.js";

const ACCOUNTS = readGithubAccounts({ DESK_GITHUB_ACCOUNTS: "16390116=acct-ari", DESK_GITHUB_LOGINS: "16390116=arimendelow" });
const NOW = Date.parse("2026-11-20T21:00:00Z");

function fakeGithub(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return { ok: answer.status === 200, status: answer.status, headers: new Headers(answer.headers ?? {}), json: async () => (answer.body instanceof Error ? Promise.reject(answer.body) : answer.body) };
  };
  return { fetch, calls };
}

test("a missing or non-Bearer header is a 401 that says what to send", async () => {
  const identity = githubIdentity({ accounts: ACCOUNTS, fetch: fakeGithub([]).fetch, now: () => NOW });
  for (const header of [undefined, "", "Basic abc", "Bearer ", "Bearer two words"]) {
    assert.deepEqual(await identity(header), { status: 401, error: "send Authorization: Bearer <GitHub token>" });
  }
});

test("a mapped GitHub user gets its Desk account", async () => {
  const github = fakeGithub([{ status: 200, body: { id: 16390116, login: "arimendelow" } }]);
  const identity = githubIdentity({ accounts: ACCOUNTS, fetch: github.fetch, now: () => NOW });
  assert.deepEqual(await identity("Bearer gho_token"), { accountId: "acct-ari" });
  assert.deepEqual(github.calls, [{ url: "https://api.github.com/user", authorization: "Bearer gho_token" }]);
});

test("an unmapped user is a 401 naming the login to poll with", async () => {
  const github = fakeGithub([{ status: 200, body: { id: 42, login: "ari-work" } }]);
  const identity = githubIdentity({ accounts: ACCOUNTS, fetch: github.fetch, now: () => NOW });
  assert.deepEqual(await identity("Bearer gho_work"), { status: 401, error: "GitHub user ari-work (42) has no Desk account; poll with gh auth token --user arimendelow" });
});

test("a token GitHub refuses is a 401", async () => {
  const identity = githubIdentity({ accounts: ACCOUNTS, fetch: fakeGithub([{ status: 401, body: {} }]).fetch, now: () => NOW });
  assert.deepEqual(await identity("Bearer bad"), { status: 401, error: "GitHub refused the token (HTTP 401); sign in again with gh auth login" });
});

test("an answer is cached for 5 minutes under the token's hash, then asked again", async () => {
  let now = NOW;
  const github = fakeGithub([{ status: 200, body: { id: 16390116, login: "arimendelow" } }, { status: 200, body: { id: 16390116, login: "arimendelow" } }]);
  const identity = githubIdentity({ accounts: ACCOUNTS, fetch: github.fetch, now: () => now });
  await identity("Bearer t");
  now += 5 * 60_000 - 1;
  assert.deepEqual(await identity("Bearer t"), { accountId: "acct-ari" });
  assert.equal(github.calls.length, 1);
  now += 2;
  await identity("Bearer t");
  assert.equal(github.calls.length, 2);
});

test("GitHub down with nothing cached is a 503; a fresh cached answer still serves", async () => {
  let now = NOW;
  const github = fakeGithub([new Error("connect ECONNREFUSED"), { status: 200, body: { id: 16390116, login: "arimendelow" } }, { status: 502, body: {} }]);
  const identity = githubIdentity({ accounts: ACCOUNTS, fetch: github.fetch, now: () => now });
  assert.deepEqual(await identity("Bearer t"), { status: 503, error: "GitHub could not confirm the token (connect ECONNREFUSED); try again shortly" });
  assert.deepEqual(await identity("Bearer t"), { accountId: "acct-ari" });
  now += 5 * 60_000 + 1;
  assert.deepEqual(await identity("Bearer t"), { status: 503, error: "GitHub could not confirm the token (HTTP 502); try again shortly" });
});

test("the cache keeps at most its limit of tokens", async () => {
  const answers = Array.from({ length: 4 }, () => ({ status: 200, body: { id: 16390116, login: "arimendelow" } }));
  const github = fakeGithub(answers);
  const identity = githubIdentity({ accounts: ACCOUNTS, fetch: github.fetch, now: () => NOW, maxCached: 2 });
  for (const token of ["a", "b", "c", "a"]) await identity(`Bearer ${token}`);
  assert.equal(github.calls.length, 4, "the oldest token was dropped and asked again");
});

test("GitHub's rate limit, or an answer that isn't JSON, is a 503 to try again, not a bad token", async () => {
  const github = fakeGithub([{ status: 403, headers: { "x-ratelimit-remaining": "0" }, body: {} }, { status: 429, body: {} }, { status: 200, body: new SyntaxError("bad json") }, { status: 403, headers: { "x-ratelimit-remaining": "12" }, body: {} }]);
  const identity = githubIdentity({ accounts: ACCOUNTS, fetch: github.fetch, now: () => NOW });
  assert.deepEqual(await identity("Bearer a"), { status: 503, error: "GitHub's rate limit stopped it confirming the token (HTTP 403); try again shortly" });
  assert.deepEqual(await identity("Bearer b"), { status: 503, error: "GitHub's rate limit stopped it confirming the token (HTTP 429); try again shortly" });
  assert.deepEqual(await identity("Bearer c"), { status: 503, error: "GitHub's answer about the token was not JSON; try again shortly" });
  assert.deepEqual(await identity("Bearer d"), { status: 401, error: "GitHub refused the token (HTTP 403); sign in again with gh auth login" });
});
