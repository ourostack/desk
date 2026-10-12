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
import { createRedirectPolicy } from "./auth/redirects.js";
import { ensureClone, runGit } from "./clone.js";
import { installationToken } from "./github-app.js";
import { createRelay } from "./relay.js";
import { createApp } from "./server.js";
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

export function readConfig(env) {
  if (!isSet(env.DESK_SIGNING_KEY)) throw new Error("DESK_SIGNING_KEY must be set: it signs every client id, code and token.");
  const publicUrl = (env.DESK_PUBLIC_URL || "https://desk.ouro.bot").replace(/\/+$/, "");
  const appReady = APP_SETTINGS.every((name) => isSet(env[name]));
  const config = {
    port: Number(env.PORT || 8080),
    issuer: publicUrl,
    resource: `${publicUrl}/mcp`,
    githubCallbackUrl: `${publicUrl}/oauth/github/callback`,
    signingKey: env.DESK_SIGNING_KEY,
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

export const deskChildArgs = (config) => [join(config.pluginDir, "mcp", "index.js"), "--root", config.cloneDir];

const passedThrough = (baseEnv) => Object.fromEntries(PASSED_THROUGH.filter((name) => baseEnv[name] !== undefined).map((name) => [name, baseEnv[name]]));

// A Desk child's whole environment. Its detached push worker inherits it, so
// it carries the token socket; it never carries a token, the App's key or its
// secrets. Git gets tokens through the credential helper and gh through the
// shim first on PATH, each fresh from the socket.
export function deskChildEnv({ config, user, socketPath, baseEnv }) {
  const name = user.name || user.login;
  const email = user.userId ? `${user.userId}+${user.login}@users.noreply.github.com` : `${user.login}@users.noreply.github.com`;
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

export async function main(env = process.env) {
  const config = readConfig(env);
  let relay = null;
  let push;
  let closeTokenSocket;

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

    // The shutdown push commits a rebase under the last signed-in user, or
    // the first allowed login if nobody has signed in since this start.
    let lastUser = { login: config.allowedLogins[0] };
    relay = createRelay({
      spawnDesk: ({ auth }) => {
        lastUser = auth.extra;
        return spawn(process.execPath, deskChildArgs(config), {
          stdio: "pipe",
          env: deskChildEnv({ config, user: auth.extra, socketPath, baseEnv: env }),
        });
      },
    });
    push = () =>
      pushDesk({ dir: config.cloneDir, args: deskPushArgs(config), env: deskChildEnv({ config, user: lastUser, socketPath, baseEnv: env }), git });
  } else {
    log(NOT_SET_UP);
  }

  const provider = createProvider({
    key: config.signingKey,
    issuer: config.issuer,
    github: { clientId: config.appClientId ?? "unset", clientSecret: config.appClientSecret ?? "unset" },
    allowedLogins: config.allowedLogins,
    resource: config.resource,
    redirects: config.redirects,
    deskRepo: config.repo,
  });
  const app = createApp({
    provider,
    relay,
    githubCallback: provider.githubCallback,
    issuer: config.issuer,
    resource: config.resource,
    unavailable: config.appReady ? undefined : NOT_SET_UP,
  });
  const server = app.listen(config.port);
  await once(server, "listening");
  log(`listening on ${config.port} for ${config.resource}; GitHub callback ${config.githubCallbackUrl}`);
  for (const line of redirectStartupLines(config.redirects)) log(line);

  let stopping = null;
  const shutdown = () => {
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
