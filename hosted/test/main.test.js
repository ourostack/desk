import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "../src/clone.js";
import { fingerprint } from "../src/auth/seal.js";
import { readConfig, keysStartupLine, redirectStartupLines, deskChildEnv, deskChildArgs, deskPushArgs, pushDesk, stopGateway } from "../src/main.js";

const PLUGIN_DIR = fileURLToPath(new URL("../../plugins/desk", import.meta.url));

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

test("readConfig reads the redirect allowlist from DESK_REDIRECTS, defaulting to Claude's callbacks", () => {
  const defaults = readConfig(FULL).redirects;
  assert.equal(defaults.allows("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(defaults.allows("https://vscode.dev/redirect"), true);
  assert.equal(defaults.allows("https://example.dev/redirect"), false);
  const configured = readConfig({ ...FULL, DESK_REDIRECTS: "https://example.dev/redirect" }).redirects;
  assert.equal(configured.allows("https://example.dev/redirect"), true);
  assert.equal(configured.allows("https://vscode.dev/redirect"), false, "DESK_REDIRECTS replaces every default");
  assert.equal(configured.allows("https://claude.ai/api/mcp/auth_callback"), false);
  assert.equal(readConfig({ ...FULL, DESK_REDIRECTS: "unset" }).redirects.allows("https://claude.ai/api/mcp/auth_callback"), true);
  assert.throws(() => readConfig({ ...FULL, DESK_REDIRECTS: "nope" }), /DESK_REDIRECTS/);
});

test("readConfig refuses to start without a signing key", () => {
  const { DESK_SIGNING_KEY: _, ...env } = FULL;
  assert.throws(() => readConfig(env), /DESK_SIGNING_KEY/);
});

test("a Desk child runs Desk's MCP server on the clone", () => {
  assert.deepEqual(deskChildArgs(readConfig(FULL)), ["/app/plugins/desk/mcp/index.js", "--root", "/data/desk"]);
});

test("a Desk child's environment carries the user's Git identity, the token socket and the gh shim, and no token or App secret", () => {
  const base = { ...FULL, PATH: "/usr/bin", HOME: "/home/desk", OTHER_SECRET: "x" };
  const env = deskChildEnv({
    config: readConfig(FULL),
    user: { login: "arimendelow", userId: 16390116, name: "Ari Mendelow" },
    socketPath: "/run/desk/git-token.sock",
    baseEnv: base,
  });
  assert.equal(env.DESK_HOSTED, "1");
  assert.equal(env.DESK, "/data/desk");
  assert.equal(env.GIT_AUTHOR_NAME, "Ari Mendelow");
  assert.equal(env.GIT_COMMITTER_NAME, "Ari Mendelow");
  assert.equal(env.GIT_AUTHOR_EMAIL, "16390116+arimendelow@users.noreply.github.com");
  assert.equal(env.GIT_COMMITTER_EMAIL, "16390116+arimendelow@users.noreply.github.com");
  assert.equal(env.GH_TOKEN, undefined, "gh gets a fresh token per call from the shim instead");
  assert.equal(env.DESK_TOKEN_SOCKET, "/run/desk/git-token.sock");
  assert.deepEqual(env.PATH.split(":"), [fileURLToPath(new URL("../bin", import.meta.url)), "/usr/bin"], "the gh shim comes first on PATH");
  assert.equal(env.HOME, "/home/desk");
  for (const value of Object.values(env)) {
    for (const secret of ["signing-key", "client-secret", "/secrets/app.pem", "x"]) assert.notEqual(value, secret);
  }
  for (const key of Object.keys(env)) assert.ok(!key.startsWith("DESK_APP") && key !== "DESK_SIGNING_KEY" && key !== "OTHER_SECRET", key);
});

test("a Desk child keeps the gateway's Git config location settings, so an operator or a test can pin which Git config applies", () => {
  const env = deskChildEnv({
    config: readConfig(FULL),
    user: { login: "arimendelow" },
    socketPath: "/s",
    baseEnv: { GIT_CONFIG_GLOBAL: "/etc/desk/gitconfig", GIT_CONFIG_NOSYSTEM: "1", GIT_DIR: "/elsewhere" },
  });
  assert.equal(env.GIT_CONFIG_GLOBAL, "/etc/desk/gitconfig");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_DIR, undefined, "other Git settings stay out");
});

test("a user without a display name commits under their login", () => {
  const env = deskChildEnv({
    config: readConfig(FULL),
    user: { login: "arimendelow", userId: 16390116, name: null },
    socketPath: "/s",
    baseEnv: {},
  });
  assert.equal(env.GIT_AUTHOR_NAME, "arimendelow");
});

test("a user known only by login commits under the login's noreply address", () => {
  const env = deskChildEnv({ config: readConfig(FULL), user: { login: "arimendelow" }, socketPath: "/s", baseEnv: {} });
  assert.equal(env.GIT_COMMITTER_NAME, "arimendelow");
  assert.equal(env.GIT_COMMITTER_EMAIL, "arimendelow@users.noreply.github.com");
});

test("Desk's own push runs its push script on the clone with no debounce", () => {
  assert.deepEqual(deskPushArgs(readConfig(FULL)), ["/app/plugins/desk/mcp/scripts/sync-push.js", "--root", "/data/desk", "--debounce-ms", "0"]);
});

test("shutdown stops new connections, then every Desk child, then pushes the desk, and only then closes the token socket", async () => {
  const order = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  await stopGateway({
    server: { close: () => order.push("server stops accepting"), closeAllConnections: () => order.push("connections closed") },
    relay: {
      close: async () => {
        order.push("children stopping");
        await tick();
        order.push("children stopped");
      },
    },
    pushDesk: async () => {
      order.push("Desk push started");
      await tick();
      order.push("Desk push finished");
    },
    closeTokenSocket: () => order.push("token socket closed"),
  });
  assert.deepEqual(order, [
    "server stops accepting",
    "children stopping",
    "children stopped",
    "Desk push started",
    "Desk push finished",
    "token socket closed",
    "connections closed",
  ]);
});

test("shutdown before the GitHub App is set up only stops the server", async () => {
  const order = [];
  await stopGateway({ server: { close: () => order.push("close"), closeAllConnections: () => order.push("closeAll") }, relay: null });
  assert.deepEqual(order, ["close", "closeAll"]);
});

// A bare remote, a partial clone of it holding one unpushed desk write, and a newer
// commit on the remote that the clone has not seen, so a plain push is
// rejected and Desk must pull with rebase and push again.
function deskWithUnpushedWrite(t) {
  const root = mkdtempSync(join(tmpdir(), "desk-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const bare = join(root, "remote.git");
  git("init", "--bare", "-q", "-b", "main", bare);
  git("-C", bare, "config", "uploadpack.allowFilter", "true");
  const other = join(root, "other");
  git("clone", "-q", bare, other);
  writeFileSync(join(other, "AGENTS.md"), "# Desk\n");
  git(...id, "-C", other, "add", ".");
  git(...id, "-C", other, "commit", "-q", "-m", "seed");
  git("-C", other, "push", "-q", "origin", "main");
  // A blob-less partial clone, as the gateway makes.
  const dir = join(root, "desk");
  git("clone", "-q", "--filter=blob:none", `file://${bare}`, dir);
  assert.equal(git("-C", dir, "config", "remote.origin.promisor"), "true");
  writeFileSync(join(other, "remote.md"), "elsewhere\n");
  git(...id, "-C", other, "add", ".");
  git(...id, "-C", other, "commit", "-q", "-m", "a write from elsewhere");
  git("-C", other, "push", "-q", "origin", "main");
  writeFileSync(join(dir, "task.md"), "hosted write\n");
  git(...id, "-C", dir, "add", ".");
  git(...id, "-C", dir, "commit", "-q", "-m", "a hosted desk write");
  const home = join(root, "home");
  const env = deskChildEnv({
    config: { cloneDir: dir },
    user: { login: "arimendelow", userId: 16390116, name: "Ari Mendelow" },
    socketPath: join(root, "no-socket"),
    baseEnv: { PATH: process.env.PATH, HOME: home },
  });
  return { dir, bare, env, git, config: { pluginDir: PLUGIN_DIR, cloneDir: dir } };
}

test("pushDesk runs Desk's own push, which rebases over a newer remote and lands the desk write on origin", async (t) => {
  const { dir, bare, env, git, config } = deskWithUnpushedWrite(t);
  const left = await pushDesk({ dir, args: deskPushArgs(config), env, git: runGit });
  assert.deepEqual(left, []);
  assert.equal(git("-C", bare, "log", "-1", "--format=%s", "main"), "a hosted desk write");
  assert.equal(git("-C", bare, "log", "-1", "--format=%s", "main~1"), "a write from elsewhere");
  assert.equal(git("-C", bare, "log", "-1", "--format=%cn <%ce>", "main"), "Ari Mendelow <16390116+arimendelow@users.noreply.github.com>");
});

test("pushDesk names every commit it could not push", async (t) => {
  const { dir, env, git } = deskWithUnpushedWrite(t);
  const sha = git("-C", dir, "rev-parse", "HEAD");
  const lines = [];
  const stderr = t.mock.method(process.stderr, "write", (line) => lines.push(String(line)) || true);
  // A push that does nothing, as when another push worker holds Desk's lock.
  const left = await pushDesk({ dir, args: ["-e", ""], env, git: runGit, timeoutMs: 400, retryMs: 100 });
  stderr.mock.restore();
  assert.deepEqual(left, [sha]);
  assert.ok(lines.some((line) => line.includes(`DESK WRITES NOT PUSHED: 1 commit(s) in ${dir}`) && line.includes(sha)), lines.join(""));
});

test("pushDesk stops a push that runs past its time limit", async (t) => {
  const { dir, env } = deskWithUnpushedWrite(t);
  const lines = [];
  const stderr = t.mock.method(process.stderr, "write", (line) => lines.push(String(line)) || true);
  const started = Date.now();
  const left = await pushDesk({ dir, args: ["-e", "setInterval(() => {}, 1000)"], env, git: runGit, timeoutMs: 300 });
  stderr.mock.restore();
  assert.ok(Date.now() - started < 5_000);
  assert.equal(left.length, 1);
  assert.ok(lines.some((line) => line.includes("Desk's push did not finish within 0.3 s; stopping it")), lines.join(""));
});

test("pushDesk does nothing when origin already has every commit", async (t) => {
  const { dir, env } = deskWithUnpushedWrite(t);
  execFileSync("git", ["-C", dir, "reset", "-q", "--hard", "@{u}"]);
  const left = await pushDesk({ dir, args: ["-e", "process.exit(9)"], env, git: runGit });
  assert.deepEqual(left, []);
});

test("the gateway logs its redirect allowlist at start, and warns when Claude's callback is missing from it", () => {
  assert.deepEqual(redirectStartupLines(readConfig(FULL).redirects), [
    "redirect allowlist: https://claude.ai/api/mcp/auth_callback, https://claude.com/api/mcp/auth_callback, https://vscode.dev/redirect, https://insiders.vscode.dev/redirect (plus loopback and ChatGPT connector callbacks)",
  ]);
  const lines = redirectStartupLines(readConfig({ ...FULL, DESK_REDIRECTS: "https://example.dev/redirect" }).redirects);
  assert.equal(lines[0], "redirect allowlist: https://example.dev/redirect (plus loopback and ChatGPT connector callbacks)");
  assert.match(lines[1], /^WARNING: DESK_REDIRECTS leaves out https:\/\/claude\.ai\/api\/mcp\/auth_callback/);
  assert.equal(redirectStartupLines(readConfig({ ...FULL, DESK_REDIRECTS: "https://claude.ai/api/mcp/auth_callback" }).redirects).length, 1);
});

// Signing-key ring (spec item 15). Today's production sets only
// DESK_SIGNING_KEY; that must keep meaning what it means today.
const UNTIL = "2026-12-01T00:00:00Z";

test("readConfig with only DESK_SIGNING_KEY signs and seals clients with it, as today", () => {
  const config = readConfig(FULL);
  assert.deepEqual(config.signingKeys, [{ key: "signing-key" }]);
  assert.equal(config.clientKey, "signing-key");
});

test("readConfig reads the previous signing key, its until-time and an explicit client key", () => {
  const config = readConfig({ ...FULL, DESK_SIGNING_KEY_PREVIOUS: "old-key", DESK_SIGNING_KEY_PREVIOUS_UNTIL: UNTIL, DESK_CLIENT_KEY: "client-key" });
  assert.deepEqual(config.signingKeys, [{ key: "signing-key" }, { key: "old-key", until: Date.parse(UNTIL) }]);
  assert.equal(config.clientKey, "client-key");
  assert.equal(readConfig({ ...FULL, DESK_CLIENT_KEY: "client-key" }).clientKey, "client-key");
  // provision.sh writes "unset" for a setting it has no value for.
  const unset = readConfig({ ...FULL, DESK_SIGNING_KEY_PREVIOUS: "unset", DESK_SIGNING_KEY_PREVIOUS_UNTIL: "unset", DESK_CLIENT_KEY: "unset" });
  assert.deepEqual(unset.signingKeys, [{ key: "signing-key" }]);
  assert.equal(unset.clientKey, "signing-key");
});

test("readConfig refuses a signing, previous or client key with a trailing newline or space", () => {
  const rotated = { ...FULL, DESK_SIGNING_KEY_PREVIOUS: "old-key", DESK_SIGNING_KEY_PREVIOUS_UNTIL: UNTIL, DESK_CLIENT_KEY: "client-key" };
  for (const name of ["DESK_SIGNING_KEY", "DESK_SIGNING_KEY_PREVIOUS", "DESK_CLIENT_KEY"]) {
    for (const bad of [`${rotated[name]}\n`, `${rotated[name]} `, ` ${rotated[name]}`, `${rotated[name]}\r\n`, "a b"]) {
      assert.throws(
        () => readConfig({ ...rotated, [name]: bad }),
        (error) => error.message.includes(name) && /whitespace/.test(error.message) && !error.message.includes(bad.trim()),
        `${name} ${JSON.stringify(bad)}`,
      );
    }
  }
});

test("readConfig refuses DESK_SIGNING_KEY_PREVIOUS without a valid UNTIL time", () => {
  const base = { ...FULL, DESK_SIGNING_KEY_PREVIOUS: "old-key", DESK_CLIENT_KEY: "client-key" };
  for (const until of [undefined, "", "unset", "soon", "2026-13-45T00:00:00Z", "1764547200"]) {
    assert.throws(() => readConfig({ ...base, DESK_SIGNING_KEY_PREVIOUS_UNTIL: until }), /DESK_SIGNING_KEY_PREVIOUS_UNTIL/, String(until));
  }
});

test("readConfig refuses a previous signing key while DESK_CLIENT_KEY is unset, so a rotation never re-keys clients", () => {
  assert.throws(
    () => readConfig({ ...FULL, DESK_SIGNING_KEY_PREVIOUS: "old-key", DESK_SIGNING_KEY_PREVIOUS_UNTIL: UNTIL }),
    /DESK_CLIENT_KEY/,
  );
});

test("the key startup line carries fingerprints and never a key", () => {
  const line = keysStartupLine(readConfig({ ...FULL, DESK_SIGNING_KEY_PREVIOUS: "old-key", DESK_SIGNING_KEY_PREVIOUS_UNTIL: UNTIL, DESK_CLIENT_KEY: "client-key" }));
  assert.equal(line, `keys: signing ${fingerprint("signing-key")} client ${fingerprint("client-key")} previous ${fingerprint("old-key")}`);
  assert.equal(keysStartupLine(readConfig(FULL)), `keys: signing ${fingerprint("signing-key")} client ${fingerprint("signing-key")} previous none`);
});

test("main logs fingerprints and never a key", async (t) => {
  const keys = { DESK_SIGNING_KEY: randomBytes(32).toString("hex"), DESK_SIGNING_KEY_PREVIOUS: randomBytes(32).toString("hex"), DESK_CLIENT_KEY: randomBytes(32).toString("hex") };
  const gateway = spawn(process.execPath, [fileURLToPath(new URL("../src/main.js", import.meta.url))], {
    env: { PATH: process.env.PATH, PORT: "0", DESK_PUBLIC_URL: "http://127.0.0.1", DESK_SIGNING_KEY_PREVIOUS_UNTIL: UNTIL, ...keys },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => gateway.kill("SIGKILL"));
  let output = "";
  gateway.stdout.on("data", (chunk) => (output += chunk));
  gateway.stderr.on("data", (chunk) => (output += chunk));
  const started = await new Promise((resolve) => {
    const check = () => output.includes("listening on") && resolve(true);
    gateway.stderr.on("data", check);
    gateway.once("exit", () => resolve(false));
  });
  assert.ok(started, output);
  assert.ok(
    output.includes(`desk-hosted: keys: signing ${fingerprint(keys.DESK_SIGNING_KEY)} client ${fingerprint(keys.DESK_CLIENT_KEY)} previous ${fingerprint(keys.DESK_SIGNING_KEY_PREVIOUS)}\n`),
    output,
  );
  for (const [name, value] of Object.entries(keys)) assert.ok(!output.includes(value), `${name} appears in the gateway's output`);
});
