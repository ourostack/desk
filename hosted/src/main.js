// Starts the hosted Desk gateway from its environment: clones the desk,
// serves installation tokens to Git, and relays each Claude session to its
// own Desk child (`node <plugin>/mcp/index.js --root <clone>`).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProvider } from "./auth/provider.js";
import { fingerprint } from "./auth/seal.js";
import { createRedirectPolicy } from "./auth/redirects.js";
import { createDiscovery, createEntraSignIn, createInvites, DISCOVERY_TIMEOUT_MS } from "./auth/entra.js";
import { createTableStore } from "./accounts/store.js";
import { createAccountCache } from "./accounts/cache.js";
import { ensureClone, runGit } from "./clone.js";
import { installationToken } from "./github-app.js";
import { createRelay } from "./relay.js";
import { createApp, createDeepHealth } from "./server.js";
import { serveTokens } from "./token-socket.js";

export const NOT_SET_UP = "Hosted Desk is not set up yet: its GitHub App is missing.";
const APP_SETTINGS = ["DESK_APP_ID", "DESK_APP_KEY_FILE", "DESK_APP_CLIENT_ID", "DESK_APP_CLIENT_SECRET"];
// The only parts of the gateway's own environment a Git or Desk child gets.
// The two Git config locations let whoever starts the gateway pin which Git
// config every child reads (the end-to-end test uses them to stay hermetic).
const PASSED_THROUGH = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];

// The gh shim's directory, put first on a Desk child's PATH.
const SHIM_DIR = fileURLToPath(new URL("../bin", import.meta.url));

const log = (message) => process.stderr.write(`desk-hosted: ${message}\n`);
const isSet = (value) => typeof value === "string" && value.trim() !== "" && value.trim() !== "unset";

// A key setting's value, or undefined when it is missing or "unset". A key
// holding any whitespace is refused rather than trimmed: the HMAC uses every
// byte, so a stray newline would silently be a different key. The message
// never repeats the value.
function keySetting(env, name) {
  if (!isSet(env[name])) return undefined;
  if (/\s/.test(env[name])) throw new Error(`${name} contains whitespace; set it to the key alone, with no newline or spaces.`);
  return env[name];
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// The signing-key ring and the client key (spec item 15). Codes and tokens
// are sealed with DESK_SIGNING_KEY; during a rollover DESK_SIGNING_KEY_PREVIOUS
// is still accepted until DESK_SIGNING_KEY_PREVIOUS_UNTIL (an ISO time). Client
// ids are sealed with DESK_CLIENT_KEY, which falls back to DESK_SIGNING_KEY
// only while there is no previous key: that is how the gateway ran before, and
// a rotation that silently re-keyed clients would void every registration.
function readKeys(env) {
  const signing = keySetting(env, "DESK_SIGNING_KEY");
  if (!signing) throw new Error("DESK_SIGNING_KEY must be set: it signs every code and token.");
  const previous = keySetting(env, "DESK_SIGNING_KEY_PREVIOUS");
  const client = keySetting(env, "DESK_CLIENT_KEY");
  const signingKeys = [{ key: signing }];
  if (previous) {
    const until = env.DESK_SIGNING_KEY_PREVIOUS_UNTIL;
    if (!ISO_TIME.test(until ?? "") || Number.isNaN(Date.parse(until))) {
      throw new Error("DESK_SIGNING_KEY_PREVIOUS needs DESK_SIGNING_KEY_PREVIOUS_UNTIL, the ISO time until which it is accepted.");
    }
    if (!client) throw new Error("DESK_SIGNING_KEY_PREVIOUS is set but DESK_CLIENT_KEY is not; set DESK_CLIENT_KEY to the key that sealed today's clients.");
    signingKeys.push({ key: previous, until: Date.parse(until) });
  }
  return { signingKeys, clientKey: client ?? signing, clientKeyFrom: client ? "DESK_CLIENT_KEY" : "DESK_SIGNING_KEY" };
}

// What the gateway logs about its keys at start, which key operations compare
// with their own reads: fingerprints only, never a key. `client-from` names
// where the client key came from, because before a rotation an explicit
// DESK_CLIENT_KEY and the fallback have the same fingerprint. `until` shows
// how long the previous key stays accepted. `revision` is the Container App
// revision (Azure sets CONTAINER_APP_REVISION), so a script reads the line of
// the revision it restarted, not an older one.
export function keysStartupLine({ signingKeys, clientKey, clientKeyFrom, revision }) {
  const [current, previous] = signingKeys;
  const previousPart = previous ? `${fingerprint(previous.key)} until ${new Date(previous.until).toISOString()}` : "none";
  return `keys: signing ${fingerprint(current.key)} client ${fingerprint(clientKey)} client-from ${clientKeyFrom} previous ${previousPart} revision ${revision ?? "unknown"}`;
}

// The Ouro tenant and the accounts store (spec items 9 to 13). Without any of their settings, as in today's
// production, the gateway runs as it always has: GitHub sign-in for DESK_ALLOWED_LOGINS. With them, every setting in
// IDENTITY_REQUIRED must be set; a partial set is refused, so a typo can't quietly leave the old sign-in running.
const IDENTITY_REQUIRED = ["DESK_ENTRA_TENANT_ID", "DESK_ENTRA_SUBDOMAIN", "DESK_ENTRA_CLIENT_ID", "DESK_ENTRA_CLIENT_SECRET", "DESK_ACCOUNTS_ENDPOINT"];
const IDENTITY_OPTIONAL = ["DESK_GITHUB_SIGNIN", "DESK_GITHUB_ACCOUNTS", "DESK_GITHUB_LOGINS", "DESK_LEGACY_CUTOFF"];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// `<GitHub user id>=<value>,...` as a Map keyed by the numeric id.
function userIdMap(env, name, valuePattern) {
  const map = new Map();
  if (!isSet(env[name])) return map;
  for (const entry of env[name].split(",").map((part) => part.trim()).filter(Boolean)) {
    const [id, value, extra] = entry.split("=");
    const userId = /^\d{1,15}$/.test(id ?? "") ? Number(id) : NaN;
    if (!Number.isSafeInteger(userId) || userId <= 0 || !valuePattern.test(value ?? "") || extra !== undefined || map.has(userId)) {
      throw new Error(`${name} must be a comma-separated list of <GitHub user id>=<value>, each id once.`);
    }
    map.set(userId, value);
  }
  return map;
}

function readIdentity(env, publicUrl) {
  const present = [...IDENTITY_REQUIRED, ...IDENTITY_OPTIONAL].filter((name) => isSet(env[name]));
  if (present.length === 0) return null;
  const missing = IDENTITY_REQUIRED.filter((name) => !isSet(env[name]));
  if (missing.length) throw new Error(`Ouro sign-in is partly configured (${present.join(", ")} set); also set ${missing.join(", ")}.`);
  if (!GUID.test(env.DESK_ENTRA_TENANT_ID)) throw new Error("DESK_ENTRA_TENANT_ID must be the tenant's id, a GUID.");
  if (!GUID.test(env.DESK_ENTRA_CLIENT_ID)) throw new Error("DESK_ENTRA_CLIENT_ID must be the gateway app's client id, a GUID.");
  const clientSecret = keySetting(env, "DESK_ENTRA_CLIENT_SECRET");

  const signIn = isSet(env.DESK_GITHUB_SIGNIN) ? env.DESK_GITHUB_SIGNIN.trim() : "off";
  if (signIn !== "on" && signIn !== "off") throw new Error("DESK_GITHUB_SIGNIN must be on or off.");

  const accounts = userIdMap(env, "DESK_GITHUB_ACCOUNTS", ACCOUNT_ID);
  const logins = userIdMap(env, "DESK_GITHUB_LOGINS", GITHUB_LOGIN);
  const ids = (map) => [...map.keys()].sort().join(",");
  if (ids(accounts) !== ids(logins)) throw new Error("DESK_GITHUB_LOGINS must name the GitHub login of exactly the user ids in DESK_GITHUB_ACCOUNTS.");
  const byUserId = new Map([...accounts].map(([userId, accountId]) => [userId, { login: logins.get(userId), accountId }]));

  let cutoff = null;
  if (isSet(env.DESK_LEGACY_CUTOFF)) {
    if (!ISO_TIME.test(env.DESK_LEGACY_CUTOFF) || Number.isNaN(Date.parse(env.DESK_LEGACY_CUTOFF))) {
      throw new Error("DESK_LEGACY_CUTOFF must be an ISO time with its zone, such as 2026-11-15T00:00:00Z.");
    }
    cutoff = new Date(env.DESK_LEGACY_CUTOFF);
  }

  return {
    tenantId: env.DESK_ENTRA_TENANT_ID,
    subdomain: env.DESK_ENTRA_SUBDOMAIN,
    clientId: env.DESK_ENTRA_CLIENT_ID,
    clientSecret,
    callbackUrl: `${publicUrl}/oauth/entra/callback`,
    accountsEndpoint: env.DESK_ACCOUNTS_ENDPOINT,
    azureClientId: isSet(env.AZURE_CLIENT_ID) ? env.AZURE_CLIENT_ID : undefined,
    githubSignIn: signIn === "on",
    legacy: { byUserId, cutoff },
    allowedLoginsIgnored: isSet(env.DESK_ALLOWED_LOGINS),
  };
}

// What the gateway logs about Ouro sign-in at start: account ids and the tenant id only, never a login or secret.
// Nothing without the Ouro tenant.
export function identityStartupLines({ identity }) {
  if (!identity) return [];
  const mapped = [...identity.legacy.byUserId.values()].map(({ accountId }) => accountId);
  const lines = [
    `Ouro sign-in: tenant ${identity.tenantId} (${identity.subdomain}); GitHub fallback ${identity.githubSignIn ? "on" : "off"}; legacy cutoff ${identity.legacy.cutoff ? identity.legacy.cutoff.toISOString() : "none"}; mapped accounts ${mapped.length ? mapped.join(", ") : "none"}`,
  ];
  if (identity.allowedLoginsIgnored) {
    lines.push("DESK_ALLOWED_LOGINS is ignored with Ouro accounts; the legacy mapping and the GitHub fallback admit only DESK_GITHUB_ACCOUNTS");
  }
  return lines;
}

export function readConfig(env) {
  const { signingKeys, clientKey, clientKeyFrom } = readKeys(env);
  const publicUrl = (env.DESK_PUBLIC_URL || "https://desk.ouro.bot").replace(/\/+$/, "");
  const appReady = APP_SETTINGS.every((name) => isSet(env[name]));
  const config = {
    port: Number(env.PORT || 8080),
    issuer: publicUrl,
    resource: `${publicUrl}/mcp`,
    githubCallbackUrl: `${publicUrl}/oauth/github/callback`,
    signingKeys,
    clientKey,
    clientKeyFrom,
    revision: isSet(env.CONTAINER_APP_REVISION) && /^\S+$/.test(env.CONTAINER_APP_REVISION) ? env.CONTAINER_APP_REVISION : undefined,
    appReady,
    appId: env.DESK_APP_ID,
    appKeyFile: env.DESK_APP_KEY_FILE,
    appClientId: env.DESK_APP_CLIENT_ID,
    appClientSecret: env.DESK_APP_CLIENT_SECRET,
    repo: env.DESK_REPO || "arimendelow/desk",
    allowedLogins: (env.DESK_ALLOWED_LOGINS || "arimendelow")
      .split(",")
      .map((login) => login.trim())
      .filter(Boolean),
    // Built here so a malformed DESK_REDIRECTS stops the gateway at start.
    redirects: createRedirectPolicy(isSet(env.DESK_REDIRECTS) ? env.DESK_REDIRECTS : undefined),
    cloneDir: env.DESK_CLONE_DIR,
    pluginDir: env.DESK_PLUGIN_DIR,
    identity: readIdentity(env, publicUrl),
  };
  if (appReady) {
    for (const name of ["DESK_CLONE_DIR", "DESK_PLUGIN_DIR"]) if (!isSet(env[name])) throw new Error(`${name} must be set.`);
  }
  return config;
}

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

// What the gateway logs about its redirect allowlist at start. A
// DESK_REDIRECTS without claude.ai's callback starts cleanly but shuts out
// every claude.ai connector, so it gets a warning of its own.
export function redirectStartupLines(redirects) {
  const lines = [`redirect allowlist: ${redirects.listed.join(", ")} (plus loopback and ChatGPT connector callbacks)`];
  if (!redirects.listed.includes(CLAUDE_CALLBACK)) {
    lines.push(`WARNING: DESK_REDIRECTS leaves out ${CLAUDE_CALLBACK}, so claude.ai connectors cannot sign in or refresh`);
  }
  return lines;
}

// A GitHub user's Git author: their name (or login) and their noreply address.
export function authorOf(user) {
  const name = user.name || user.login;
  const email = user.userId ? `${user.userId}+${user.login}@users.noreply.github.com` : `${user.login}@users.noreply.github.com`;
  return { name, email };
}

// With Ouro accounts, a Desk child's Git author comes from the account's binding (Ari's is seeded with his GitHub
// noreply author), never from token claims. An account whose binding doesn't name this gateway's desk gets no child.
export function createAuthorLookup({ store, repo }) {
  return async (accountId) => {
    const binding = await store.getBinding(accountId);
    if (binding?.kind !== "github" || binding.repo !== repo || !binding.author) throw new Error(`account ${accountId} has no desk on this gateway`);
    return binding.author;
  };
}

// Reads each account the legacy mapping and the GitHub fallback name, once, and logs any that is missing: a typo or
// another tenant's id would otherwise refuse Ari's old connector at deploy. /healthz/deep fails on the same condition.
export async function checkLegacyAccounts({ store, accountIds, log: write = log }) {
  for (const accountId of accountIds) {
    try {
      if ((await store.getAccount(accountId)) === null) write(`LEGACY ACCOUNT MISSING ${accountId}`);
    } catch (error) {
      write(`could not check legacy account ${accountId} (${typeof error?.name === "string" && /^\w{1,64}$/.test(error.name) ? error.name : "error"})`);
    }
  }
}

// Fetches the Ouro tenant's discovery document before the gateway listens, waiting at most `boundMs`: a document
// naming another issuer stops the start (the returned promise rejects), and one that can't be fetched in time leaves
// the document loading in the background while the legacy and GitHub paths serve. A mismatch found after the bound
// is logged (and fails /healthz/deep), never an unhandled rejection.
export async function startDiscovery(discovery, { boundMs = DISCOVERY_TIMEOUT_MS + 1_000, log: write = log } = {}) {
  const started = discovery.start();
  started.catch((error) => write(error?.message ?? "Entra discovery failed"));
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve("bound"), boundMs);
  });
  try {
    if ((await Promise.race([started.then(() => "started"), bound])) === "bound") {
      write(`Entra discovery is still loading after ${boundMs / 1000} s; starting without it, and Ouro sign-in waits for it`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Every 60 s, re-reads each account with an open session and closes all of that account's sessions, idle ones too,
// when its Desk access is off or it is gone (spec item 11). A read that fails is retried once after `retryMs`; the
// sessions close only if the cache then can't vouch for the account either (its row is older than 60 s).
export function startAccountSweep({ relay, accounts, intervalMs = 60_000, retryMs = 2_000, log: write = log }) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function read(accountId) {
    try {
      return { row: await accounts.account(accountId, { fresh: true }) };
    } catch {
      await pause(retryMs);
      try {
        return { row: await accounts.account(accountId, { fresh: true }) };
      } catch {
        return { unconfirmed: true };
      }
    }
  }
  async function sweepOnce() {
    for (const accountId of relay.openAccounts()) {
      const { row, unconfirmed } = await read(accountId);
      if (unconfirmed) write(`sweep: account ${accountId} can't be confirmed; closed ${relay.closeAccount(accountId)} session(s)`);
      else if (!row?.deskAccess) write(`sweep: account ${accountId} has Desk access off; closed ${relay.closeAccount(accountId)} session(s)`);
    }
  }
  let running = null;
  const timer = setInterval(() => {
    running ??= sweepOnce()
      .catch((error) => write(`sweep failed (${error?.name ?? "error"})`))
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  timer.unref?.();
  return { sweepOnce, stop: () => clearInterval(timer) };
}

// The Ouro tenant's parts, built from config.identity: the accounts store and its cache, discovery (fetched, within
// its bound, before the gateway listens), the tenant's sign-in, invites and the deep health check. `deps.store` and
// `deps.fetch` stand in for the Table store and the network in tests.
export async function startIdentity(config, deps = {}) {
  const { identity } = config;
  const fetch = deps.fetch ?? globalThis.fetch;
  const store = deps.store ?? createTableStore({ endpoint: identity.accountsEndpoint, clientId: identity.azureClientId });
  const accounts = createAccountCache({ store });
  const discovery = createDiscovery({ subdomain: identity.subdomain, tenantId: identity.tenantId, fetch });
  await startDiscovery(discovery, deps.discoveryBoundMs ? { boundMs: deps.discoveryBoundMs } : {});
  const entra = createEntraSignIn({
    keys: config.signingKeys,
    discovery,
    tenantId: identity.tenantId,
    clientId: identity.clientId,
    clientSecret: identity.clientSecret,
    callbackUrl: identity.callbackUrl,
    store,
    repo: config.repo,
    fetch,
  });
  const invites = createInvites({ keys: config.signingKeys, store, issuer: config.issuer });
  const accountIds = [...identity.legacy.byUserId.values()].map(({ accountId }) => accountId);
  const deepHealth = createDeepHealth({ discovery, store, accountIds });
  return { store, accounts, discovery, entra, invites, deepHealth, accountIds };
}

// The provider and the Express app. `parts` is startIdentity's, or absent on a gateway without the Ouro tenant, which
// then serves exactly what it always has.
export function buildGateway({ config, relay, parts, log: write }) {
  const provider = createProvider({
    signingKeys: config.signingKeys,
    clientKey: config.clientKey,
    issuer: config.issuer,
    github: { clientId: config.appClientId ?? "unset", clientSecret: config.appClientSecret ?? "unset", signIn: config.identity?.githubSignIn === true },
    allowedLogins: config.allowedLogins,
    resource: config.resource,
    redirects: config.redirects,
    ...(write ? { log: write } : {}),
    ...(parts ? { accounts: parts.accounts, store: parts.store, repo: config.repo, entra: parts.entra, legacy: config.identity.legacy } : {}),
  });
  const app = createApp({
    provider,
    relay,
    githubCallback: provider.githubCallback,
    issuer: config.issuer,
    resource: config.resource,
    unavailable: config.appReady ? undefined : NOT_SET_UP,
    entra: parts?.entra,
    invites: parts?.invites,
    deepHealth: parts?.deepHealth,
  });
  return { provider, app };
}

export const deskChildArgs = (config) => [join(config.pluginDir, "mcp", "index.js"), "--root", config.cloneDir];

const passedThrough = (baseEnv) => Object.fromEntries(PASSED_THROUGH.filter((name) => baseEnv[name] !== undefined).map((name) => [name, baseEnv[name]]));

// A Desk child's whole environment. Its detached push worker inherits it, so
// it carries the token socket; it never carries a token, the App's key or its
// secrets. Git gets tokens through the credential helper and gh through the
// shim first on PATH, each fresh from the socket.
//
// `author` is the Git author: with Ouro accounts, the account's binding's
// (createAuthorLookup); without, the GitHub user of the token (`user`).
export function deskChildEnv({ config, user, author = authorOf(user), socketPath, baseEnv }) {
  const { name, email } = author;
  return {
    ...passedThrough(baseEnv),
    PATH: [SHIM_DIR, baseEnv.PATH].filter(Boolean).join(delimiter),
    GIT_TERMINAL_PROMPT: "0",
    DESK_HOSTED: "1",
    DESK: config.cloneDir,
    GIT_AUTHOR_NAME: name,
    GIT_COMMITTER_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_EMAIL: email,
    DESK_TOKEN_SOCKET: socketPath,
  };
}

// Desk's own push: the script Desk's detached push worker runs, with no
// debounce. It takes Desk's sync lock, pushes, and on a rejection pulls with
// rebase and pushes once more.
export const deskPushArgs = (config) => [join(config.pluginDir, "mcp", "scripts", "sync-push.js"), "--root", config.cloneDir, "--debounce-ms", "0"];

// The commits in `dir` that origin does not have yet, newest first.
async function unpushed(dir, git) {
  try {
    return (await git(["-C", dir, "rev-list", "@{u}..HEAD"])).split("\n").filter(Boolean);
  } catch (error) {
    log(`could not count unpushed desk commits: ${error.message}`);
    return [];
  }
}

// Runs Desk's own push on the clone until origin has every commit or
// `timeoutMs` runs out. Desk's push returns at once when another push worker
// holds its lock, so it runs again while commits remain, `retryMs` apart. A
// push still running at the deadline is killed. Commits still unpushed then
// are logged by SHA, because the next start clones origin afresh.
export async function pushDesk({ dir, args, env, git, timeoutMs = 60_000, retryMs = 2_000 }) {
  const deadline = Date.now() + timeoutMs;
  let ahead = await unpushed(dir, git);
  while (ahead.length > 0 && Date.now() < deadline) {
    const push = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "inherit"], env });
    const exited = new Promise((resolve) => {
      push.once("close", resolve);
      push.once("error", (error) => {
        log(`could not run Desk's push: ${error.message}`);
        resolve();
      });
    });
    const timer = setTimeout(() => {
      log(`Desk's push did not finish within ${timeoutMs / 1000} s; stopping it`);
      push.kill("SIGKILL");
    }, Math.max(deadline - Date.now(), 0));
    await exited;
    clearTimeout(timer);
    ahead = await unpushed(dir, git);
    if (ahead.length > 0 && Date.now() + retryMs < deadline) await new Promise((resolve) => setTimeout(resolve, retryMs));
    else break;
  }
  if (ahead.length > 0) log(`DESK WRITES NOT PUSHED: ${ahead.length} commit(s) in ${dir} are not on origin and will be lost: ${ahead.join(" ")}`);
  return ahead;
}

// Stops the gateway without losing desk writes: no new connections or
// sessions, every Desk child stopped, then Desk's own push of whatever the
// clone still holds, and only then the token socket that push authenticates
// through.
export async function stopGateway({ server, relay, pushDesk: push, closeTokenSocket }) {
  server.close();
  await relay?.close();
  await push?.();
  await closeTokenSocket?.();
  server.closeAllConnections();
}

export async function main(env = process.env, deps = {}) {
  const config = readConfig(env);
  log(keysStartupLine(config));
  for (const line of identityStartupLines(config)) log(line);
  let relay = null;
  let push;
  let closeTokenSocket;
  // The Ouro tenant comes first, so a tenant naming another issuer stops the start before the clone.
  const parts = config.identity ? await startIdentity(config, deps) : null;
  if (parts) checkLegacyAccounts({ store: parts.store, accountIds: parts.accountIds });
  const authorFor = parts ? createAuthorLookup({ store: parts.store, repo: config.repo }) : null;

  if (config.appReady) {
    const runtimeDir = mkdtempSync(join(tmpdir(), "desk-hosted-")); // mode 0700
    const socketPath = join(runtimeDir, "git-token.sock");
    const privateKeyPem = readFileSync(config.appKeyFile, "utf8");
    const mint = () => installationToken({ appId: config.appId, privateKeyPem, repo: config.repo });
    const tokenServer = serveTokens({ socketPath, mint });
    await once(tokenServer, "listening");
    closeTokenSocket = () => {
      tokenServer.close();
      rmSync(runtimeDir, { recursive: true, force: true });
    };

    const gitEnv = { ...passedThrough(env), GIT_TERMINAL_PROMPT: "0", DESK_TOKEN_SOCKET: socketPath };
    const git = (args, options) => runGit(args, { ...options, env: gitEnv });
    await ensureClone({ dir: config.cloneDir, repo: config.repo, git });
    log(`desk clone ready at ${config.cloneDir}`);

    // The shutdown push commits a rebase under the last signed-in user's
    // author. If nobody has signed in since this start, that is the first
    // allowed login's or, with Ouro accounts, the first mapped account's
    // binding's (or a neutral one when it can't be read).
    let lastAuthor = parts ? null : authorOf({ login: config.allowedLogins[0] });
    relay = createRelay({
      spawnDesk: async ({ auth }) => {
        const author = authorFor ? await authorFor(auth.extra.accountId) : authorOf(auth.extra);
        lastAuthor = author;
        return spawn(process.execPath, deskChildArgs(config), {
          stdio: "pipe",
          env: deskChildEnv({ config, author, socketPath, baseEnv: env }),
        });
      },
    });
    const shutdownAuthor = async () =>
      lastAuthor ??
      (parts.accountIds.length ? await authorFor(parts.accountIds[0]).catch(() => null) : null) ?? { name: "Hosted Desk", email: "hosted-desk@users.noreply.desk.ouro.bot" };
    push = async () =>
      pushDesk({ dir: config.cloneDir, args: deskPushArgs(config), env: deskChildEnv({ config, author: await shutdownAuthor(), socketPath, baseEnv: env }), git });
  } else {
    log(NOT_SET_UP);
  }

  const { app } = buildGateway({ config, relay, parts });
  const server = app.listen(config.port);
  await once(server, "listening");
  log(`listening on ${config.port} for ${config.resource}; GitHub callback ${config.githubCallbackUrl}`);
  for (const line of redirectStartupLines(config.redirects)) log(line);
  const sweep = parts && relay ? startAccountSweep({ relay, accounts: parts.accounts }) : null;

  let stopping = null;
  const shutdown = () => {
    sweep?.stop();
    parts?.discovery.stop();
    stopping ??= stopGateway({ server, relay, pushDesk: push, closeTokenSocket }).then(
      () => process.exit(0),
      (error) => {
        log(`shutdown failed: ${error.message}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log(error.message);
    process.exit(1);
  });
}
