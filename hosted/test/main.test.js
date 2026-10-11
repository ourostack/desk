import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "../src/clone.js";
import { once } from "node:events";
import { fingerprint, seal } from "../src/auth/seal.js";
import {
  readConfig,
  keysStartupLine,
  redirectStartupLines,
  identityStartupLines,
  deskChildEnv,
  deskChildArgs,
  deskPushArgs,
  pushDesk,
  stopGateway,
  startAccountSweep,
  checkLegacyAccounts,
  createAuthorLookup,
  startDiscovery,
  START_DISCOVERY_BOUND_MS,
  buildGateway,
} from "../src/main.js";
import { createMemoryStore } from "../src/accounts/memory-store.js";
import { createAccountCache } from "../src/accounts/cache.js";
import { seed } from "../src/accounts/invites.js";

const BINDING = { kind: "github", repo: "arimendelow/desk", installationId: 12345678, author: { name: "Ari Mendelow", email: "16390116+arimendelow@users.noreply.github.com" } };

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

test("the key startup line carries fingerprints, where the client key came from, the previous key's until-time and the revision", () => {
  const rotated = { ...FULL, DESK_SIGNING_KEY_PREVIOUS: "old-key", DESK_SIGNING_KEY_PREVIOUS_UNTIL: UNTIL, DESK_CLIENT_KEY: "client-key", CONTAINER_APP_REVISION: "ouro-desk-hosted--abc123" };
  assert.equal(
    keysStartupLine(readConfig(rotated)),
    `keys: signing ${fingerprint("signing-key")} client ${fingerprint("client-key")} client-from DESK_CLIENT_KEY previous ${fingerprint("old-key")} until 2026-12-01T00:00:00.000Z revision ouro-desk-hosted--abc123`,
  );
  // Before a rotation, an explicit copy and the fallback have the same
  // fingerprint, so only client-from tells them apart.
  assert.equal(keysStartupLine(readConfig(FULL)), `keys: signing ${fingerprint("signing-key")} client ${fingerprint("signing-key")} client-from DESK_SIGNING_KEY previous none revision unknown`);
  assert.equal(
    keysStartupLine(readConfig({ ...FULL, DESK_CLIENT_KEY: "signing-key" })),
    `keys: signing ${fingerprint("signing-key")} client ${fingerprint("signing-key")} client-from DESK_CLIENT_KEY previous none revision unknown`,
  );
});

test("main logs fingerprints and never a key", async (t) => {
  const keys = { DESK_SIGNING_KEY: randomBytes(32).toString("hex"), DESK_SIGNING_KEY_PREVIOUS: randomBytes(32).toString("hex"), DESK_CLIENT_KEY: randomBytes(32).toString("hex") };
  const gateway = spawn(process.execPath, [fileURLToPath(new URL("../src/main.js", import.meta.url))], {
    env: { PATH: process.env.PATH, PORT: "0", DESK_PUBLIC_URL: "http://127.0.0.1", DESK_SIGNING_KEY_PREVIOUS_UNTIL: UNTIL, CONTAINER_APP_REVISION: "rev-1", ...keys },
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
    output.includes(
      `desk-hosted: keys: signing ${fingerprint(keys.DESK_SIGNING_KEY)} client ${fingerprint(keys.DESK_CLIENT_KEY)} client-from DESK_CLIENT_KEY previous ${fingerprint(keys.DESK_SIGNING_KEY_PREVIOUS)} until 2026-12-01T00:00:00.000Z revision rev-1\n`,
    ),
    output,
  );
  for (const [name, value] of Object.entries(keys)) assert.ok(!output.includes(value), `${name} appears in the gateway's output`);
});

// ---- Ouro accounts (spec items 9 to 13) ----

const ARI_ACCOUNT = "0b8e2f4c-1d3a-4e5b-9c7d-6f8a0b1c2d3e";
const TENANT = "c12edfb6-c5ab-4bf8-b1d5-1f053311d396";
const IDENTITY = {
  DESK_ENTRA_TENANT_ID: TENANT,
  DESK_ENTRA_SUBDOMAIN: "ourobottest",
  DESK_ENTRA_CLIENT_ID: "7d0f5b52-1c4e-4c7e-9a43-2f6f3d1e8a10",
  DESK_ENTRA_CLIENT_SECRET: "entra-client-secret",
  DESK_ACCOUNTS_ENDPOINT: "https://stouroaccounts261e0b.table.core.windows.net",
  AZURE_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  DESK_GITHUB_SIGNIN: "on",
  DESK_GITHUB_ACCOUNTS: `16390116=${ARI_ACCOUNT}`,
  DESK_GITHUB_LOGINS: "16390116=arimendelow",
  DESK_LEGACY_CUTOFF: "2026-11-15T00:00:00Z",
};

test("readConfig with today's production env has no Ouro accounts and keeps DESK_ALLOWED_LOGINS", () => {
  const config = readConfig(FULL);
  assert.equal(config.identity, null);
  assert.deepEqual(config.allowedLogins, ["arimendelow", "someone"]);
});

test("readConfig reads the Ouro tenant, the accounts store, the GitHub fallback and the legacy mapping", () => {
  const { identity } = readConfig({ ...FULL, ...IDENTITY });
  assert.equal(identity.tenantId, TENANT);
  assert.equal(identity.subdomain, "ourobottest");
  assert.equal(identity.clientId, IDENTITY.DESK_ENTRA_CLIENT_ID);
  assert.equal(identity.clientSecret, "entra-client-secret");
  assert.equal(identity.callbackUrl, "https://desk-hosted.example.azurecontainerapps.io/oauth/entra/callback");
  assert.equal(identity.accountsEndpoint, IDENTITY.DESK_ACCOUNTS_ENDPOINT);
  assert.equal(identity.azureClientId, IDENTITY.AZURE_CLIENT_ID);
  assert.equal(identity.githubSignIn, true);
  assert.deepEqual([...identity.legacy.byUserId], [[16390116, { login: "arimendelow", accountId: ARI_ACCOUNT }]]);
  assert.equal(identity.legacy.cutoff.toISOString(), "2026-11-15T00:00:00.000Z");
  const minimal = readConfig({ ...FULL, ...IDENTITY, DESK_GITHUB_SIGNIN: "unset", DESK_GITHUB_ACCOUNTS: "unset", DESK_GITHUB_LOGINS: "unset", DESK_LEGACY_CUTOFF: "unset" }).identity;
  assert.equal(minimal.githubSignIn, false);
  assert.equal(minimal.legacy.byUserId.size, 0);
  assert.equal(minimal.legacy.cutoff, null);
  assert.equal(readConfig({ ...FULL, ...IDENTITY, DESK_GITHUB_SIGNIN: "off" }).identity.githubSignIn, false);
});

test("readConfig refuses a DESK_LEGACY_CUTOFF that doesn't parse", () => {
  for (const cutoff of ["soon", "2026-13-45T00:00:00Z", "1764547200", "2026-11-15"]) {
    assert.throws(() => readConfig({ ...FULL, ...IDENTITY, DESK_LEGACY_CUTOFF: cutoff }), /DESK_LEGACY_CUTOFF/, cutoff);
  }
});

test("readConfig refuses a partial Ouro tenant, a bad GitHub mapping or switch, and an Entra secret with whitespace", () => {
  for (const name of ["DESK_ENTRA_TENANT_ID", "DESK_ENTRA_SUBDOMAIN", "DESK_ENTRA_CLIENT_ID", "DESK_ENTRA_CLIENT_SECRET", "DESK_ACCOUNTS_ENDPOINT"]) {
    const { [name]: _, ...partial } = IDENTITY;
    assert.throws(() => readConfig({ ...FULL, ...partial }), new RegExp(name), name);
  }
  assert.throws(() => readConfig({ ...FULL, DESK_LEGACY_CUTOFF: IDENTITY.DESK_LEGACY_CUTOFF }), /DESK_ENTRA_TENANT_ID/);
  assert.throws(() => readConfig({ ...FULL, ...IDENTITY, DESK_GITHUB_SIGNIN: "yes" }), /DESK_GITHUB_SIGNIN/);
  for (const accounts of ["arimendelow=x", "16390116", `16390116=${ARI_ACCOUNT},16390116=${ARI_ACCOUNT}`, "16390116=a/b"]) {
    assert.throws(() => readConfig({ ...FULL, ...IDENTITY, DESK_GITHUB_ACCOUNTS: accounts }), /DESK_GITHUB_ACCOUNTS/, accounts);
  }
  assert.throws(() => readConfig({ ...FULL, ...IDENTITY, DESK_GITHUB_LOGINS: "1=someone" }), /DESK_GITHUB_LOGINS/);
  assert.throws(() => readConfig({ ...FULL, ...IDENTITY, DESK_GITHUB_LOGINS: "unset" }), /DESK_GITHUB_LOGINS/);
  for (const bad of ["entra-client-secret\n", " entra-client-secret", "a b"]) {
    assert.throws(
      () => readConfig({ ...FULL, ...IDENTITY, DESK_ENTRA_CLIENT_SECRET: bad }),
      (error) => /DESK_ENTRA_CLIENT_SECRET/.test(error.message) && /whitespace/.test(error.message) && !error.message.includes("entra-client-secret"),
    );
  }
});

test("the identity startup lines name the tenant, the fallback, the cutoff and the mapped accounts, and that DESK_ALLOWED_LOGINS is ignored", () => {
  const lines = identityStartupLines(readConfig({ ...FULL, ...IDENTITY }));
  assert.deepEqual(lines, [
    `Ouro sign-in: tenant ${TENANT} (ourobottest); GitHub fallback on; legacy cutoff 2026-11-15T00:00:00.000Z; mapped accounts ${ARI_ACCOUNT}`,
    "DESK_ALLOWED_LOGINS is ignored with Ouro accounts; the legacy mapping and the GitHub fallback admit only DESK_GITHUB_ACCOUNTS",
  ]);
  assert.deepEqual(identityStartupLines(readConfig(FULL)), []);
  for (const line of lines) assert.ok(!line.includes("entra-client-secret") && !line.includes("arimendelow"));
});

// A stand-in relay with open sessions per account, recording closeAccount.
function sweepRelay(accountIds) {
  const open = new Set(accountIds);
  const closed = [];
  return {
    closed,
    openAccounts: () => new Set(open),
    closeAccount(accountId) {
      closed.push(accountId);
      open.delete(accountId);
      return 1;
    },
  };
}

test("the sweep closes an idle session within one interval after access is turned off", async (t) => {
  // setInterval runs on a mocked clock, so the test counts intervals instead of timing them.
  mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => mock.timers.reset());
  const store = createMemoryStore();
  const { accountId } = await seed({ store, displayName: "Ari", binding: BINDING });
  const accounts = createAccountCache({ store });
  await accounts.account(accountId);
  const relay = sweepRelay([accountId]);
  const lines = [];
  const sweep = startAccountSweep({ relay, accounts, intervalMs: 60_000, retryMs: 10, log: (line) => lines.push(line) });
  t.after(() => sweep.stop());
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(relay.closed, [], "access on: nothing closed");
  // Turned off just after a sweep, while the cached row is still young: the next interval closes it.
  await store.putAccount({ accountId, displayName: "Ari", deskAccess: false });
  mock.timers.tick(59_999);
  await settle();
  assert.deepEqual(relay.closed, [], "not before the interval");
  mock.timers.tick(1);
  await settle();
  assert.deepEqual(relay.closed, [accountId]);
  assert.ok(lines.some((line) => line.includes(`account ${accountId}`) && line.includes("access off")));
});

test("the sweep retries a failed read once before closing", async () => {
  const store = createMemoryStore();
  const { accountId } = await seed({ store, displayName: "Ari", binding: BINDING });
  let clock = 0;
  const accounts = createAccountCache({ store, now: () => clock });
  await accounts.account(accountId);
  const getAccount = store.getAccount;
  let failures = 0;
  let reads = 0;
  store.getAccount = async (id) => {
    reads++;
    if (failures-- > 0) throw Object.assign(new Error("down"), { name: "StoreError" });
    return getAccount(id);
  };

  // One failed read, then a good one: nothing closed.
  clock = 61_000;
  failures = 1;
  let relay = sweepRelay([accountId]);
  await startAccountSweep({ relay, accounts, intervalMs: 60_000, retryMs: 10, log: () => {} }).sweepOnce();
  assert.equal(reads, 2);
  assert.deepEqual(relay.closed, []);

  // Two failed reads while the cached row is older than a minute: closed after the retry.
  clock += 61_000;
  failures = 2;
  reads = 0;
  relay = sweepRelay([accountId]);
  const lines = [];
  await startAccountSweep({ relay, accounts, intervalMs: 60_000, retryMs: 10, log: (line) => lines.push(line) }).sweepOnce();
  assert.equal(reads, 2);
  assert.deepEqual(relay.closed, [accountId]);
  assert.ok(lines.some((line) => line.includes(`account ${accountId}`) && line.includes("can't be confirmed")));

  // Two failed reads while the cached row is still young: kept.
  clock += 1_000;
  await accounts.account(accountId, { fresh: true }).catch(() => {});
  failures = 0;
  await accounts.account(accountId, { fresh: true });
  failures = 2;
  relay = sweepRelay([accountId]);
  clock += 30_000;
  await startAccountSweep({ relay, accounts, intervalMs: 60_000, retryMs: 10, log: () => {} }).sweepOnce();
  assert.deepEqual(relay.closed, []);
});

test("startup logs LEGACY ACCOUNT MISSING for a mapped accountId with no row", async () => {
  const store = createMemoryStore();
  const { accountId } = await seed({ store, displayName: "Ari", binding: BINDING });
  const lines = [];
  await checkLegacyAccounts({ store, accountIds: [accountId, ARI_ACCOUNT], log: (line) => lines.push(line) });
  assert.deepEqual(lines, [`LEGACY ACCOUNT MISSING ${ARI_ACCOUNT}`]);
  const down = { getAccount: async () => Promise.reject(Object.assign(new Error("secret detail"), { name: "StoreError" })) };
  lines.length = 0;
  await checkLegacyAccounts({ store: down, accountIds: [ARI_ACCOUNT], log: (line) => lines.push(line) });
  assert.deepEqual(lines, [`could not check legacy account ${ARI_ACCOUNT} (StoreError)`]);
});

test("a Desk child's Git author comes from the binding", async () => {
  const store = createMemoryStore();
  const author = { name: "Ari Mendelow", email: "16390116+arimendelow@users.noreply.github.com" };
  const { accountId } = await seed({ store, displayName: "Display Name Not Used", binding: { ...BINDING, author } });
  const authorFor = createAuthorLookup({ store, repo: "arimendelow/desk" });
  const env = deskChildEnv({ config: readConfig(FULL), author: await authorFor(accountId), socketPath: "/s", baseEnv: {} });
  assert.equal(env.GIT_AUTHOR_NAME, author.name);
  assert.equal(env.GIT_COMMITTER_NAME, author.name);
  assert.equal(env.GIT_AUTHOR_EMAIL, author.email);
  assert.equal(env.GIT_COMMITTER_EMAIL, author.email);
  // An account whose binding names another desk, or none, gets no Desk child.
  const other = await seed({ store, displayName: "Other", binding: { ...BINDING, repo: "someone/desk" } });
  await assert.rejects(authorFor(other.accountId), /no desk/);
  await assert.rejects(createAuthorLookup({ store, repo: "arimendelow/desk" })("9f1e3d5c-7b9a-4c2d-8e0f-1a2b3c4d5e6f"), /no desk/);
});

test("discovery that never answers holds the start for at most its bound, and an issuer mismatch stops it", async () => {
  const lines = [];
  const hanging = { start: () => new Promise(() => {}) };
  const started = Date.now();
  await startDiscovery(hanging, { boundMs: 100, log: (line) => lines.push(line) });
  assert.ok(Date.now() - started < 1_000);
  assert.ok(lines.some((line) => /still loading/.test(line)));
  await assert.rejects(startDiscovery({ start: async () => Promise.reject(new Error("issuer mismatch")) }, { boundMs: 1_000, log: () => {} }), /issuer mismatch/);
  // A mismatch found after the bound is logged, never an unhandled rejection.
  let reject;
  lines.length = 0;
  await startDiscovery({ start: () => new Promise((_, no) => (reject = no)) }, { boundMs: 20, log: (line) => lines.push(line) });
  reject(new Error("late issuer mismatch"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(lines.some((line) => line.includes("late issuer mismatch")));
});

test("the start waits for discovery at most 10 s by default", async (t) => {
  assert.equal(START_DISCOVERY_BOUND_MS, 10_000);
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let done = false;
  const waiting = startDiscovery({ start: () => new Promise(() => {}) }, { log: () => {} }).then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(9_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  mock.timers.tick(1);
  await waiting;
  assert.equal(done, true);
});

test("startup logs LEGACY ACCOUNT MAPPING EMPTY when account mode has no mapped account", async () => {
  const lines = [];
  await checkLegacyAccounts({ store: createMemoryStore(), accountIds: [], log: (line) => lines.push(line) });
  assert.deepEqual(lines, ["LEGACY ACCOUNT MAPPING EMPTY: DESK_GITHUB_ACCOUNTS names no account, so legacy tokens and the GitHub fallback admit nobody"]);
});

// Today's production env (provision.sh's: no Ouro tenant or accounts settings) must give today's gateway.
test("with today's production env, sign-in, consent, tokens and routes behave exactly as today", async (t) => {
  const config = readConfig({ ...FULL, DESK_PUBLIC_URL: "https://desk.ouro.bot" });
  const relay = { handle: (req, res, auth) => res.json({ extra: auth.extra }) };
  const { app, provider } = buildGateway({ config, relay, log: () => {} });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = provider.clientsStore.registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post" });
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "c", code_challenge_method: "S256", state: "s" });
  const html = await (await fetch(authorize)).text();
  assert.match(html, /After you sign in with GitHub/);
  assert.ok(!html.includes('name="method"'), "today's consent page has no sign-in choice");
  const consent = html.match(/name="consent" value="([^"]+)"/)[1];
  // Even a method=entra field changes nothing: approval goes to GitHub, with no cookie.
  const approved = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ consent, method: "entra" }),
    redirect: "manual",
  });
  assert.equal(approved.status, 303);
  assert.ok(approved.headers.get("location").startsWith("https://github.com/login/oauth/authorize?"));
  assert.deepEqual(approved.headers.getSetCookie(), []);
  for (const path of ["/oauth/entra/callback?code=x&state=y", "/invite/abc", "/invite"]) {
    assert.equal((await fetch(`${base}${path}`, { redirect: "manual" })).status, 404, path);
  }
  assert.equal((await fetch(`${base}/healthz/deep`)).status, 200);
  // A v1a token still verifies to its GitHub login, as today.
  const token = seal("access", { clientId: client.client_id, scopes: [], login: "arimendelow", userId: 16390116, name: "Ari" }, { key: "signing-key", ttlSec: 3600 });
  const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  assert.deepEqual((await mcp.json()).extra, { login: "arimendelow", userId: 16390116, name: "Ari" });
});

test("Task 8 review 2: with Ouro sign-in, the key startup line also carries the Entra client secret's fingerprint, never the secret", () => {
  const line = keysStartupLine(readConfig({ ...FULL, ...IDENTITY, CONTAINER_APP_REVISION: "rev-1" }));
  assert.ok(line.endsWith(` revision rev-1 entra ${fingerprint("entra-client-secret")}`), line);
  assert.ok(!line.includes("entra-client-secret"));
  // Without the Ouro tenant the line is as before, so older parsers and tests read it unchanged.
  assert.ok(!keysStartupLine(readConfig(FULL)).includes(" entra "));
});
