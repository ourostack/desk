#!/usr/bin/env node
// The legacy probe: an MCP client of hosted Desk, built on the MCP SDK's OAuth client, that an operator or agent runs
// by hand to check that one connection keeps working (after a deploy, a key migration, a rollback, and on the day of
// the legacy cutoff), without touching anyone's claude.ai connector.
//
//   node hosted/infra/mcp-probe.mjs connect --url <https://host/mcp> --name <n>
//       registers a client, prints the authorization URL to open in the signed-in browser (or opens it with
//       DESK_PROBE_OPENER, a command that gets the URL as its last argument), takes the code on a loopback callback,
//       and stores the client and its tokens in ~/.ouro/probe-<n>.json (mode 0600)
//   node hosted/infra/mcp-probe.mjs status --name <n>
//       refreshes the tokens, rewrites the file atomically with the rotated refresh token, and calls desk_status
//   node hosted/infra/mcp-probe.mjs task-update --name <n> --card <track>/<slug> [--note <text>]
//       refreshes the same way and makes one task_update with a note
//
// It prints results, never tokens. A refused refresh exits 1 with the OAuth error code (for example invalid_grant)
// and leaves the file as it was.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { auth, discoverOAuthServerInfo, refreshAuthorization, selectResourceURL } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const tokenFile = (home, name) => join(home, ".ouro", `probe-${name}.json`);

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Writes the probe file through a 0600 temporary file in the same directory and a rename, so a crash never leaves a
// half-written file and the rotated refresh token is never lost to a partial write.
function saveAtomically(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function load(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(text);
}

// The OAuth error code of a refused refresh, or a short description of any other failure. Never a token: the SDK's
// errors carry the server's error and description only.
function describe(error) {
  if (error?.errorCode) return `${error.errorCode}${error.message ? `: ${error.message}` : ""}`;
  return error?.message ?? String(error);
}

async function refresh(saved, fetchFn) {
  const info = await discoverOAuthServerInfo(new URL(saved.url), { fetchFn });
  const resource = await selectResourceURL(new URL(saved.url), {}, info.resourceMetadata);
  const tokens = await refreshAuthorization(info.authorizationServerUrl, {
    metadata: info.authorizationServerMetadata,
    clientInformation: saved.clientInformation,
    refreshToken: saved.tokens.refresh_token,
    resource,
    fetchFn,
  });
  return { ...tokens, refresh_token: tokens.refresh_token ?? saved.tokens.refresh_token };
}

async function callTool(url, accessToken, name, args, fetchFn) {
  const client = new Client({ name: "desk-mcp-probe", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: fetchFn,
  });
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

function resultText(result) {
  const text = (result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

// `connect`: a loopback callback, dynamic registration and one browser sign-in through the SDK's own auth flow.
async function connect({ url, file, io, fetchFn, opener }) {
  const callback = createServer();
  await new Promise((resolve) => callback.listen(0, "127.0.0.1", resolve));
  const redirectUrl = `http://127.0.0.1:${callback.address().port}/callback`;
  const expectedState = randomBytes(16).toString("hex");
  const pending = { url, clientInformation: undefined, tokens: undefined, codeVerifier: undefined };
  const codePromise = new Promise((resolve, reject) => {
    callback.on("request", (req, res) => {
      const got = new URL(req.url, redirectUrl);
      if (got.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("The probe has the code; you can close this tab.\n");
      if (got.searchParams.get("state") !== expectedState) return reject(new Error("the callback's state did not match"));
      if (got.searchParams.get("error")) return reject(new Error(`sign-in refused: ${got.searchParams.get("error")}`));
      resolve(got.searchParams.get("code"));
    });
  });
  const provider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return {
        client_name: `Desk probe (${file.split("probe-").pop().replace(/\.json$/, "")})`,
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state: () => expectedState,
    clientInformation: () => pending.clientInformation,
    saveClientInformation: (value) => {
      pending.clientInformation = value;
    },
    tokens: () => pending.tokens,
    saveTokens: (value) => {
      pending.tokens = value;
    },
    saveCodeVerifier: (value) => {
      pending.codeVerifier = value;
    },
    codeVerifier: () => pending.codeVerifier,
    redirectToAuthorization: async (authorizationUrl) => {
      io.stdout(`Open this URL in the browser that is signed in, and approve: ${authorizationUrl.href}`);
      if (opener) spawn(opener[0], [...opener.slice(1), authorizationUrl.href], { stdio: "ignore", detached: true }).unref();
    },
  };
  try {
    const first = await auth(provider, { serverUrl: new URL(url), fetchFn });
    if (first !== "REDIRECT") throw new Error(`unexpected sign-in result ${first}`);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("no callback within 10 minutes")), 600_000).unref());
    const code = await Promise.race([codePromise, timeout]);
    const second = await auth(provider, { serverUrl: new URL(url), authorizationCode: code, fetchFn });
    if (second !== "AUTHORIZED" || !pending.tokens?.refresh_token) throw new Error("the gateway issued no refresh token");
  } finally {
    callback.close();
  }
  saveAtomically(file, { url, clientInformation: pending.clientInformation, tokens: pending.tokens, connectedAt: new Date().toISOString() });
  io.stdout(`connected: ${url}; client and tokens stored in ${file} (0600)`);
}

export async function main(argv, { home = homedir(), stdout = (s) => console.log(s), stderr = (s) => console.error(s), fetchFn = fetch, opener = null } = {}) {
  const io = { stdout, stderr };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { url: { type: "string" }, name: { type: "string" }, card: { type: "string" }, note: { type: "string" } },
    });
  } catch (error) {
    stderr(error.message);
    return 2;
  }
  const [command] = parsed.positionals;
  const { url, name, card, note } = parsed.values;
  if (!["connect", "status", "task-update"].includes(command) || !name || !NAME.test(name)) {
    stderr("usage: mcp-probe.mjs connect --url <mcp url> --name <n> | status --name <n> | task-update --name <n> --card <track>/<slug> [--note <text>]");
    return 2;
  }
  mkdirSync(join(home, ".ouro"), { recursive: true, mode: 0o700 });
  const file = tokenFile(home, name);
  try {
    if (command === "connect") {
      if (!url) {
        stderr("connect needs --url <mcp url>");
        return 2;
      }
      await connect({ url, file, io, fetchFn, opener });
      return 0;
    }
    const saved = load(file);
    if (!saved?.tokens?.refresh_token) {
      stderr(`no probe ${name} in ${file}; run connect --url <mcp url> --name ${name} first`);
      return 1;
    }
    let tokens;
    try {
      tokens = await refresh(saved, fetchFn);
    } catch (error) {
      stderr(`refresh refused: ${describe(error)}`);
      return 1;
    }
    saveAtomically(file, { ...saved, tokens, refreshedAt: new Date().toISOString() });
    if (command === "status") {
      const result = await callTool(saved.url, tokens.access_token, "desk_status", {}, fetchFn);
      stdout(`refreshed; desk_status ${result.isError ? "returned an error" : "ok"}: ${resultText(result)}`);
      return result.isError ? 1 : 0;
    }
    const [track, slug, extra] = (card ?? "").split("/");
    if (!track || !slug || extra !== undefined) {
      stderr("task-update needs --card <track>/<slug>");
      return 2;
    }
    const args = { track, slug, note: note ?? `probe ${name} at ${new Date().toISOString()}` };
    const result = await callTool(saved.url, tokens.access_token, "task_update", args, fetchFn);
    stdout(`refreshed; task_update ${result.isError ? "returned an error" : "ok"}: ${resultText(result)}`);
    return result.isError ? 1 : 0;
  } catch (error) {
    stderr(`failed: ${describe(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const opener = process.env.DESK_PROBE_OPENER ? process.env.DESK_PROBE_OPENER.split(" ").filter(Boolean) : null;
  process.exitCode = await main(process.argv.slice(2), { opener });
}
