// Starts the hosted Desk gateway from its environment: clones the desk,
// serves installation tokens to Git, and relays each Claude session to its
// own Desk child (`node <plugin>/mcp/index.js --root <clone>`).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProvider } from "./auth/provider.js";
import { ensureClone, runGit } from "./clone.js";
import { installationToken } from "./github-app.js";
import { createRelay } from "./relay.js";
import { createApp } from "./server.js";
import { serveTokens } from "./token-socket.js";

export const NOT_SET_UP = "Hosted Desk is not set up yet: its GitHub App is missing.";
const APP_SETTINGS = ["DESK_APP_ID", "DESK_APP_KEY_FILE", "DESK_APP_CLIENT_ID", "DESK_APP_CLIENT_SECRET"];
// The only parts of the gateway's own environment a Git or Desk child gets.
const PASSED_THROUGH = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR"];

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
    cloneDir: env.DESK_CLONE_DIR,
    pluginDir: env.DESK_PLUGIN_DIR,
  };
  if (appReady) {
    for (const name of ["DESK_CLONE_DIR", "DESK_PLUGIN_DIR"]) if (!isSet(env[name])) throw new Error(`${name} must be set.`);
  }
  return config;
}

export const deskChildArgs = (config) => [join(config.pluginDir, "mcp", "index.js"), "--root", config.cloneDir];

const passedThrough = (baseEnv) => Object.fromEntries(PASSED_THROUGH.filter((name) => baseEnv[name] !== undefined).map((name) => [name, baseEnv[name]]));

// A Desk child's whole environment. Its detached push worker inherits it, so
// it carries the token socket; it never carries the App's key or secrets.
export function deskChildEnv({ config, user, token, socketPath, baseEnv }) {
  const name = user.name || user.login;
  const email = `${user.userId}+${user.login}@users.noreply.github.com`;
  return {
    ...passedThrough(baseEnv),
    GIT_TERMINAL_PROMPT: "0",
    DESK_HOSTED: "1",
    DESK: config.cloneDir,
    GIT_AUTHOR_NAME: name,
    GIT_COMMITTER_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_EMAIL: email,
    GH_TOKEN: token,
    DESK_TOKEN_SOCKET: socketPath,
  };
}

export async function main(env = process.env) {
  const config = readConfig(env);
  const cleanups = [];
  let relay = null;

  if (config.appReady) {
    const runtimeDir = mkdtempSync(join(tmpdir(), "desk-hosted-")); // mode 0700
    cleanups.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
    const socketPath = join(runtimeDir, "git-token.sock");
    const privateKeyPem = readFileSync(config.appKeyFile, "utf8");
    const mint = () => installationToken({ appId: config.appId, privateKeyPem, repo: config.repo });
    const tokenServer = serveTokens({ socketPath, mint });
    await once(tokenServer, "listening");
    cleanups.push(() => tokenServer.close());

    const gitEnv = { ...passedThrough(env), GIT_TERMINAL_PROMPT: "0", DESK_TOKEN_SOCKET: socketPath };
    await ensureClone({ dir: config.cloneDir, repo: config.repo, git: (args, options) => runGit(args, { ...options, env: gitEnv }) });
    log(`desk clone ready at ${config.cloneDir}`);

    // spawnDesk runs synchronously inside the relay, so the token and the
    // user's identity are fetched before a new session reaches it.
    const users = new Map();
    let token = null;
    const deskRelay = createRelay({
      spawnDesk: ({ login }) =>
        spawn(process.execPath, deskChildArgs(config), {
          stdio: "pipe",
          env: deskChildEnv({ config, user: users.get(login), token, socketPath, baseEnv: env }),
        }),
    });
    cleanups.push(() => deskRelay.close());
    relay = {
      async handle(req, res, auth) {
        if (req.headers["mcp-session-id"] === undefined) {
          users.set(auth.extra.login, auth.extra);
          try {
            token = (await mint()).token;
          } catch (error) {
            log(`could not mint an installation token: ${error.message}`);
            return res.status(502).json({ jsonrpc: "2.0", error: { code: -32000, message: "Desk could not get GitHub access; try again shortly." }, id: null });
          }
        }
        return deskRelay.handle(req, res, auth);
      },
    };
  } else {
    log(NOT_SET_UP);
  }

  const provider = createProvider({
    key: config.signingKey,
    issuer: config.issuer,
    github: { clientId: config.appClientId ?? "unset", clientSecret: config.appClientSecret ?? "unset" },
    allowedLogins: config.allowedLogins,
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

  const shutdown = async () => {
    server.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    server.closeAllConnections();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log(error.message);
    process.exit(1);
  });
}
