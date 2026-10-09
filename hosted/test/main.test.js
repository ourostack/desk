import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig, deskChildEnv, deskChildArgs } from "../src/main.js";

const FULL = {
  PORT: "9000",
  DESK_PUBLIC_URL: "https://desk-hosted.example.azurecontainerapps.io",
  DESK_SIGNING_KEY: "signing-key",
  DESK_APP_ID: "123",
  DESK_APP_KEY_FILE: "/secrets/app.pem",
  DESK_APP_CLIENT_ID: "Iv1.abc",
  DESK_APP_CLIENT_SECRET: "client-secret",
  DESK_REPO: "arimendelow/desk",
  DESK_ALLOWED_LOGINS: "arimendelow, someone",
  DESK_CLONE_DIR: "/data/desk",
  DESK_PLUGIN_DIR: "/app/plugins/desk",
};

test("readConfig derives the issuer, resource and GitHub callback from DESK_PUBLIC_URL", () => {
  const config = readConfig(FULL);
  assert.equal(config.port, 9000);
  assert.equal(config.issuer, "https://desk-hosted.example.azurecontainerapps.io");
  assert.equal(config.resource, "https://desk-hosted.example.azurecontainerapps.io/mcp");
  assert.equal(config.githubCallbackUrl, "https://desk-hosted.example.azurecontainerapps.io/oauth/github/callback");
  assert.deepEqual(config.allowedLogins, ["arimendelow", "someone"]);
  assert.equal(config.appReady, true);
});

test("readConfig defaults the public URL to https://desk.ouro.bot", () => {
  const { DESK_PUBLIC_URL: _, ...env } = FULL;
  const config = readConfig(env);
  assert.equal(config.issuer, "https://desk.ouro.bot");
  assert.equal(config.resource, "https://desk.ouro.bot/mcp");
});

test("readConfig treats a missing or 'unset' GitHub App setting as not set up", () => {
  assert.equal(readConfig({ ...FULL, DESK_APP_CLIENT_SECRET: "unset" }).appReady, false);
  const { DESK_APP_ID: _, ...missing } = FULL;
  assert.equal(readConfig(missing).appReady, false);
});

test("readConfig refuses to start without a signing key", () => {
  const { DESK_SIGNING_KEY: _, ...env } = FULL;
  assert.throws(() => readConfig(env), /DESK_SIGNING_KEY/);
});

test("a Desk child runs Desk's MCP server on the clone", () => {
  assert.deepEqual(deskChildArgs(readConfig(FULL)), ["/app/plugins/desk/mcp/index.js", "--root", "/data/desk"]);
});

test("a Desk child's environment carries the user's Git identity and tokens, and no App secret", () => {
  const base = { ...FULL, PATH: "/usr/bin", HOME: "/home/desk", OTHER_SECRET: "x" };
  const env = deskChildEnv({
    config: readConfig(FULL),
    user: { login: "arimendelow", userId: 16390116, name: "Ari Mendelow" },
    token: "ghs_installation",
    socketPath: "/run/desk/git-token.sock",
    baseEnv: base,
  });
  assert.equal(env.DESK_HOSTED, "1");
  assert.equal(env.DESK, "/data/desk");
  assert.equal(env.GIT_AUTHOR_NAME, "Ari Mendelow");
  assert.equal(env.GIT_COMMITTER_NAME, "Ari Mendelow");
  assert.equal(env.GIT_AUTHOR_EMAIL, "16390116+arimendelow@users.noreply.github.com");
  assert.equal(env.GIT_COMMITTER_EMAIL, "16390116+arimendelow@users.noreply.github.com");
  assert.equal(env.GH_TOKEN, "ghs_installation");
  assert.equal(env.DESK_TOKEN_SOCKET, "/run/desk/git-token.sock");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/desk");
  for (const value of Object.values(env)) {
    for (const secret of ["signing-key", "client-secret", "/secrets/app.pem", "x"]) assert.notEqual(value, secret);
  }
  for (const key of Object.keys(env)) assert.ok(!key.startsWith("DESK_APP") && key !== "DESK_SIGNING_KEY" && key !== "OTHER_SECRET", key);
});

test("a user without a display name commits under their login", () => {
  const env = deskChildEnv({
    config: readConfig(FULL),
    user: { login: "arimendelow", userId: 16390116, name: null },
    token: "t",
    socketPath: "/s",
    baseEnv: {},
  });
  assert.equal(env.GIT_AUTHOR_NAME, "arimendelow");
});
