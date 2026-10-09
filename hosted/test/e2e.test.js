// End to end: the real gateway (src/main.js) with the real Desk plugin
// (plugins/desk) against a scratch desk, driven by the MCP SDK's own client
// over Streamable HTTP. Runs only with DESK_E2E=1, because it needs Desk's
// dependencies installed (`npm ci` in plugins/desk/mcp) and takes tens of
// seconds.
//
// Nothing reaches the network. The desk's origin is a local bare repository:
// a scratch HOME's Git config rewrites https://github.com/<repo>.git to it, so
// the gateway's own clone and Desk's own pushes run unchanged. The GitHub API
// is a stub preloaded into the gateway (fixtures/stub-github.mjs), and the gh
// the shim finds is a fake that refuses every call. The bearer token is sealed
// with the gateway's own seal module and a test signing key.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { seal, TTL } from "../src/auth/seal.js";

const ENABLED = process.env.DESK_E2E === "1";
const MAIN = fileURLToPath(new URL("../src/main.js", import.meta.url));
const STUB_GITHUB = fileURLToPath(new URL("./fixtures/stub-github.mjs", import.meta.url));
const PLUGIN_DIR = fileURLToPath(new URL("../../plugins/desk", import.meta.url));
const DESK_MCP = pathToFileURL(join(PLUGIN_DIR, "mcp", "/")).href;
const REPO = "arimendelow/desk";
const LOGIN = "e2e-user";
const TRACK = "e2e";
const SLUG = "scratch-card";

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const originLog = (origin) => git(["--git-dir", origin, "log", "--format=%H %P %s", "main"]).split("\n").filter(Boolean);
const originSubjects = (origin) => originLog(origin).map((line) => line.split(" ").slice(2).join(" "));

async function until(what, check, { timeoutMs = 30_000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A desk as Desk's own tests make one (tests/desk/mcp/__tests__): a Git
// repository with a README and `_cache/` ignored, and a task card written by
// Desk's own task_create. Pushed to a bare origin on `main`.
async function seedDesk({ scratch, origin }) {
  git(["init", "--bare", "-q", "--initial-branch=main", origin]);
  git(["--git-dir", origin, "config", "uploadpack.allowFilter", "true"]);
  const seed = join(scratch, "seed");
  git(["clone", "-q", origin, seed]);
  git(["-C", seed, "config", "user.email", "seed@example.com"]);
  git(["-C", seed, "config", "user.name", "Seed"]);
  git(["-C", seed, "symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(seed, "README.md"), "Scratch desk for the hosted end-to-end test.\n");
  writeFileSync(join(seed, ".gitignore"), "_cache/\n");
  git(["-C", seed, "add", "README.md", ".gitignore"]);
  git(["-C", seed, "commit", "-q", "-m", "init"]);
  const { task_create } = await import(new URL("src/tools/task.js", DESK_MCP));
  await task_create({ deskRoot: seed, input: { track: TRACK, slug: SLUG, title: "Scratch card" }, schedulePush: () => {} });
  git(["-C", seed, "push", "-q", "origin", "main"]);
}

// Another machine's clone, which pushes a commit straight to origin.
function pushFromElsewhere({ scratch, origin, file }) {
  const other = join(scratch, `elsewhere-${randomUUID()}`);
  git(["clone", "-q", origin, other]);
  git(["-C", other, "config", "user.email", "elsewhere@example.com"]);
  git(["-C", other, "config", "user.name", "Elsewhere"]);
  writeFileSync(join(other, file), "Written on another machine.\n");
  git(["-C", other, "add", file]);
  git(["-C", other, "commit", "-q", "-m", `elsewhere: ${file}`]);
  git(["-C", other, "push", "-q", "origin", "main"]);
  return git(["-C", other, "rev-parse", "HEAD"]);
}

const parse = (result) => JSON.parse(result.content.find((item) => item.type === "text").text);

describe("hosted Desk end to end", { skip: !ENABLED && "set DESK_E2E=1 to run (needs npm ci in plugins/desk/mcp)" }, () => {
  let scratch;
  let origin;
  let cloneDir;
  let gateway;
  let gatewayLog = "";
  let baseUrl;
  let token;
  let client;
  const openClients = new Set();

  async function connect() {
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const next = new Client({ name: "desk-e2e", version: "0.0.0" });
    await next.connect(transport);
    openClients.add(next);
    return { client: next, transport };
  }

  async function call(name, args = {}, on = client) {
    const result = await on.callTool({ name, arguments: args });
    return { result, body: parse(result) };
  }

  before(async () => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "desk-hosted-e2e-")));
    origin = join(scratch, "origin.git");
    cloneDir = join(scratch, "clone");
    const home = join(scratch, "home");
    const bin = join(scratch, "bin");
    mkdirSync(home);
    mkdirSync(bin);

    // Desk's in-process task_create below writes its state under this
    // process's HOME and XDG folders; keep them in the scratch folder.
    for (const [name, dir] of [["XDG_STATE_HOME", "state"], ["XDG_CONFIG_HOME", "config"], ["XDG_CACHE_HOME", "cache"], ["XDG_DATA_HOME", "data"]]) {
      process.env[name] = join(scratch, "seed-env", dir);
    }
    await seedDesk({ scratch, origin });

    // The gateway clones https://github.com/<repo>.git; Git, reading this
    // HOME, fetches and pushes the bare origin instead.
    writeFileSync(
      join(home, ".gitconfig"),
      `[url "${pathToFileURL(origin).href}"]\n\tinsteadOf = https://github.com/${REPO}.git\n[init]\n\tdefaultBranch = main\n`,
    );
    // The gh the shim runs: refuses, so nothing reaches GitHub.
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'gh is not available in the end-to-end test' >&2\nexit 1\n");
    chmodSync(join(bin, "gh"), 0o755);
    const keyFile = join(scratch, "app-key.pem");
    writeFileSync(keyFile, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }));

    const signingKey = randomBytes(32).toString("base64url");
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    gateway = spawn(process.execPath, ["--import", pathToFileURL(STUB_GITHUB).href, MAIN], {
      stdio: ["ignore", "inherit", "pipe"],
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        PORT: String(port),
        DESK_PUBLIC_URL: baseUrl,
        DESK_SIGNING_KEY: signingKey,
        DESK_APP_ID: "1",
        DESK_APP_KEY_FILE: keyFile,
        DESK_APP_CLIENT_ID: "Iv1.e2e",
        DESK_APP_CLIENT_SECRET: "e2e-client-secret",
        DESK_REPO: REPO,
        DESK_ALLOWED_LOGINS: LOGIN,
        DESK_CLONE_DIR: cloneDir,
        DESK_PLUGIN_DIR: PLUGIN_DIR,
      },
    });
    gateway.stderr.setEncoding("utf8");
    gateway.stderr.on("data", (chunk) => (gatewayLog += chunk));
    const exited = new Promise((resolve) => gateway.once("exit", (code) => resolve(code)));
    await Promise.race([
      until("the gateway's /healthz", async () => (await fetch(new URL("/healthz", baseUrl)).catch(() => null))?.ok),
      exited.then((code) => {
        throw new Error(`the gateway exited (${code}) before it was ready:\n${gatewayLog}`);
      }),
    ]);

    token = seal(
      "access",
      { clientId: "e2e-client", scopes: ["desk"], login: LOGIN, userId: 4242, name: "E2E User", jti: randomUUID() },
      { key: signingKey, ttlSec: TTL.access },
    );
    ({ client } = await connect());
  });

  after(async () => {
    await Promise.all([...openClients].map((open) => open.close().catch(() => {})));
    if (gateway && gateway.exitCode === null) {
      const exited = new Promise((resolve) => gateway.once("exit", resolve));
      gateway.kill("SIGTERM");
      await exited;
    }
    if (!scratch) return;
    // DESK_E2E_KEEP=1 keeps the scratch folder, with the gateway's log, for a look afterwards.
    if (process.env.DESK_E2E_KEEP === "1") writeFileSync(join(scratch, "gateway.log"), gatewayLog);
    else rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("refuses /mcp without a bearer token", async () => {
    const response = await fetch(new URL("/mcp", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401);
  });

  it("answers initialize with Desk's hosted instructions", () => {
    const instructions = client.getInstructions();
    assert.equal(typeof instructions, "string", gatewayLog);
    assert.match(instructions, /# Hosted Desk/);
    assert.match(instructions, /call desk_status first/);
  });

  it("lists every Desk tool, each with its annotations", async () => {
    const { TOOL_NAMES } = await import(new URL("src/tool-names.js", DESK_MCP));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} has no readOnlyHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} has no destructiveHint`);
    }
    assert.equal(tools.find((tool) => tool.name === "desk_status").annotations.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === "desk_save").annotations.destructiveHint, true);
  });

  // Desk answers the handshake first and admits the desk in the background, so
  // desk_status reports "admitting" until admission is done.
  it("answers desk_status, ready, with the desk's sync state", async () => {
    const body = await until("desk_status to report ready", async () => {
      const { result, body: status } = await call("desk_status");
      assert.notEqual(result.isError, true, JSON.stringify(status));
      return status.state === "ready" ? status : null;
    });
    assert.equal(body.root.path, cloneDir);
    assert.equal(body.sync, "in sync");
  });

  it("commits a task_update and pushes it to origin", async () => {
    const { result, body } = await call("task_update", { track: TRACK, slug: SLUG, note: "First hosted update." });
    assert.notEqual(result.isError, true, JSON.stringify(body));
    const subject = `task_update: ${TRACK}/${SLUG}`;
    assert.equal(git(["-C", cloneDir, "log", "-1", "--format=%s"]), subject);
    const head = git(["-C", cloneDir, "rev-parse", "HEAD"]);
    await until("the task_update commit on origin", () => git(["--git-dir", origin, "rev-parse", "main"]) === head);
  });

  it("rebases onto a commit pushed elsewhere first, and both land on origin", async () => {
    const elsewhere = pushFromElsewhere({ scratch, origin, file: "elsewhere.md" });
    // The gateway's clone has not seen it, so Desk's push is rejected and has to pull and rebase.
    assert.equal(spawnSync("git", ["-C", cloneDir, "cat-file", "-e", `${elsewhere}^{commit}`]).status === 0, false);

    const { result, body } = await call("task_update", { track: TRACK, slug: SLUG, note: "Second hosted update, after a push from elsewhere." });
    assert.notEqual(result.isError, true, JSON.stringify(body));
    await until("the rebased task_update on origin", () => {
      const [tip] = originLog(origin);
      const [, parent, ...subject] = tip.split(" ");
      return parent === elsewhere && subject.join(" ") === `task_update: ${TRACK}/${SLUG}`;
    });
    assert.deepEqual(originSubjects(origin).slice(0, 2), [`task_update: ${TRACK}/${SLUG}`, "elsewhere: elsewhere.md"]);
  });

  it("still pushes a task_update when the session closes right after it", async () => {
    const session = await connect();
    const before = originLog(origin).length;
    const { result, body } = await call("task_update", { track: TRACK, slug: SLUG, note: "Written just before the session closed." }, session.client);
    assert.notEqual(result.isError, true, JSON.stringify(body));
    const head = git(["-C", cloneDir, "rev-parse", "HEAD"]);
    const { sessionId } = session.transport;
    await session.transport.terminateSession();
    await session.client.close();
    openClients.delete(session.client);
    // The gateway removed the session (and stopped its Desk child) before Desk's push ran.
    const gone = await fetch(new URL("/mcp", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(gone.status, 404);
    await until("the last task_update on origin after its session closed", () => git(["--git-dir", origin, "rev-parse", "main"]) === head);
    assert.equal(originLog(origin).length, before + 1);
  });

  it("refuses improvement_next with the hosted refusal", async () => {
    const { body } = await call("improvement_next");
    assert.equal(body.status, "refused");
    assert.equal(body.code, "hosted_unavailable");
    assert.equal(body.tool, "improvement_next");
  });

  it("commits a new file sent through desk_save files and pushes it", async () => {
    const rel = `${TRACK}/${SLUG}/notes/from-claude.md`;
    const content = "# From claude.ai\n\nNo filesystem on this side.\n";
    const { result, body } = await call("desk_save", { files: [{ path: rel, content }], message: "save notes from claude.ai" });
    assert.notEqual(result.isError, true, JSON.stringify(body));
    assert.equal(body.status, "committed");
    await until("the desk_save commit on origin", () => spawnSync("git", ["--git-dir", origin, "cat-file", "-e", `main:${rel}`]).status === 0);
    assert.equal(git(["--git-dir", origin, "show", `main:${rel}`]) + "\n", content);
  });
});
