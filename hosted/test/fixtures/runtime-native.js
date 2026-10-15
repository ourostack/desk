import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdirSync, writeFileSync, statSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { createMemoryStore } from "../../src/accounts/memory-store.js";
import * as runtime from "../../src/account-runtime.js";
import { assertGatewayKernelBoundary, isolationArgs } from "../../src/isolation.js";

assertGatewayKernelBoundary({ status: readFileSync("/proc/1/status", "utf8"), uid: 1000 });

const root = "/data/runtime-native";
mkdirSync(root, { recursive: true, mode: 0o711 });
const bare = "/data/runtime-native-remote";
const seed = "/data/runtime-native-seed";
for (const path of [bare, seed, "/data/runtime-native-bin"]) mkdirSync(path, { recursive: true });
function fixtureGit(cwd, args) {
  const result = spawnSync("/usr/bin/git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_EMAIL: "fixture@example.com" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
fixtureGit(bare, ["init", "--quiet", "--bare", "-b", "main"]);
fixtureGit(seed, ["init", "--quiet", "-b", "main"]);
writeFileSync(join(seed, "marker"), "synthetic marker");
fixtureGit(seed, ["add", "."]);
fixtureGit(seed, ["commit", "--quiet", "-m", "seed"]);
fixtureGit(seed, ["push", "--quiet", bare, "main"]);
fixtureGit(bare, ["config", "http.receivepack", "true"]);
fixtureGit(bare, ["config", "uploadpack.allowFilter", "true"]);
for (const entry of readdirSync(bare, { recursive: true })) {
  const path = join(bare, entry);
  chmodSync(path, statSync(path).isDirectory() ? 0o755 : 0o644);
}
chmodSync(bare, 0o755);
const slowFetches = new Set();
const http = createServer(async (req, res) => {
  const delayMode = req.headers["x-desk-timeout"];
  if (delayMode && !slowFetches.has(delayMode)) {
    slowFetches.add(delayMode);
    await new Promise(resolve => setTimeout(resolve, delayMode === "escaped" ? 70_000 : 65_000));
    if (res.destroyed) return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, "http://localhost");
  const backend = spawn("/usr/lib/git-core/git-http-backend", [], {
    env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: "/data", GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length),
      REMOTE_USER: "synthetic", HTTP_GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
    },
  });
  const output = [];
  backend.stdin.on("error", error => { if (error.code !== "EPIPE") throw error; });
  backend.stdout.on("data", chunk => output.push(chunk));
  backend.stderr.pipe(process.stderr, { end: false });
  backend.stdin.end(body);
  await once(backend, "close");
  const buffer = Buffer.concat(output);
  const split = buffer.indexOf("\r\n\r\n");
  assert.ok(split >= 0, "Git HTTP backend must produce CGI headers");
  const headers = {};
  let status = 200;
  for (const line of buffer.subarray(0, split).toString().split("\r\n")) {
    const colon = line.indexOf(":");
    if (line.startsWith("Status:")) status = Number(line.slice(colon + 1).trim().split(" ")[0]);
    else headers[line.slice(0, colon)] = line.slice(colon + 1).trim();
  }
  res.writeHead(status, headers);
  res.end(buffer.subarray(split + 4));
});
await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${http.address().port}/runtime-native-remote`;
writeFileSync("/data/runtime-native-bin/git", `#!/usr/bin/env node
const { existsSync, appendFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
if (existsSync("/data/runtime-native-fail") && process.argv[2] === "fetch") process.exit(1);
if (existsSync("/data/runtime-native-fail-push") && process.argv[2] === "rev-list") process.exit(1);
appendFileSync(process.env.XDG_STATE_HOME + "/git-argv.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
const env = {
  ...process.env, GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: ${JSON.stringify(`url.${origin}.insteadOf`)},
  GIT_CONFIG_VALUE_0: "https://github.com/synthetic/desk.git",
  GIT_CONFIG_KEY_1: "safe.bareRepository", GIT_CONFIG_VALUE_1: "all",
};
const run = () => {
  if (process.argv[2] === "fetch" && existsSync("/data/runtime-native-slow-fetch")) {
    const fs = require("node:fs"), path = require("node:path");
    const mode = fs.readFileSync("/data/runtime-native-slow-fetch", "utf8");
    const child = spawn("/usr/bin/git", process.argv.slice(2), {
      env: { ...env, GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_2: "http.extraHeader", GIT_CONFIG_VALUE_2: "X-Desk-Timeout: " + mode },
      stdio: "inherit", detached: mode === "escaped",
    });
    import("file:///app/plugins/desk/mcp/src/readiness/process-start.js").then(async ({ readProcessStart }) => {
      fs.writeFileSync(path.join(path.dirname(process.env.DESK), "fetch-started"), JSON.stringify({ mode, pid: child.pid, start: await readProcessStart(child.pid) }));
    });
    child.once("close", code => {
      fs.writeFileSync(path.join(path.dirname(process.env.DESK), "fetch-finished"), "finished");
      process.exit(code ?? 1);
    });
    return;
  }
  const result = spawnSync("/usr/bin/git", process.argv.slice(2), { env, stdio: "inherit" });
  process.exit(result.status ?? 1);
};
if (process.argv.includes("late desk write")) setTimeout(run, 1500);
else run();
`, { mode: 0o755 });
const key = join(root, "synthetic-key");
writeFileSync(key, "not a credential", { mode: 0o600 });
const store = createMemoryStore();
await store.ensureTables();
const binding = {
  kind: "github", repo: "synthetic/desk", installationId: 123,
  author: { name: "Synthetic", email: "synthetic@users.noreply.github.com" },
};
for (const accountId of ["account-a", "account-b"]) {
  await store.putAccount({ accountId, displayName: "Synthetic", deskAccess: true });
  await store.putBinding(accountId, binding);
}
const config = { identity: {}, repo: binding.repo, pluginDir: "/app/plugins/desk", appKeyFile: key };
chmodSync(root, 0o777);
assert.throws(() => runtime.createAccountRuntime({ config, store, rootDir: join(root, "unsafe-parent") }), /protected|confined/);
chmodSync(root, 0o711);
chmodSync(key, 0o644);
assert.throws(() => runtime.createAccountRuntime({ config, store, rootDir: join(root, "unsafe-key") }), /confined/);
chmodSync(key, 0o600);
const manager = runtime.createAccountRuntime({
  config, store, rootDir: join(root, "realms"), baseEnv: { PATH: "/data/runtime-native-bin:/usr/local/bin:/usr/bin:/bin", DESK_SIGNING_KEY: "secret" },
  mint: async (repo) => {
    assert.equal(repo, "synthetic/desk");
    return { token: "synthetic-token" };
  },
});
await assert.rejects(manager.prepare("missing"));
await store.putBinding("account-b", { ...binding, repo: "unverified/other" });
await assert.rejects(manager.prepare("account-b"));
await store.putBinding("account-b", binding);
writeFileSync("/data/runtime-native-fail", "synthetic forced fetch failure");
await assert.rejects(manager.prepare("account-a"));
unlinkSync("/data/runtime-native-fail");
const [a, again, b] = await Promise.all([manager.prepare("account-a"), manager.prepare("account-a"), manager.prepare("account-b")]);
assert.equal(a, again);
assert.equal(a.realm.uid, 10000, "failed preparation reserves, rather than recycling, its UID");
assert.notEqual(a.realm.uid, b.realm.uid);
assert.notEqual(a.realm.root, b.realm.root);
for (const prepared of [a, b]) {
  assert.equal(Object.isFrozen(prepared.realm), true);
  const info = await prepared.git(["status", "--porcelain"]);
  assert.equal(info, "");
  assert.equal(prepared.env.DESK_SIGNING_KEY, undefined);
}
const childScript = "/app/hosted/test/fixtures/runtime-child.js";
assert.throws(() => a.launch([childScript, "--root", a.env.DESK]), /public/);
const child = a.launch([childScript]);
let output = "";
child.stdout.on("data", chunk => { output += chunk; });
await new Promise((resolve, reject) => {
  child.on("message", message => { if (message.ready) resolve(); });
  child.once("error", reject);
});
const report = JSON.parse(output.trim());
assert.equal(report.uid, a.realm.uid);
assert.equal(report.cwd, a.env.DESK);
assert.equal(report.neighborDenied, true);
assert.equal(report.gatewayKeyDenied, true);
assert.equal(report.capsCleared, true);
assert.equal(report.runtimeContextExcluded, true);
assert.equal(report.socketUid, a.realm.uid);
assert.equal(report.socketMode, 0o600);
assert.equal(statSync(a.realm.root).mode & 0o777, 0o700);
assert.equal(report.homeUid, a.realm.uid);
assert.throws(() => process.kill(child.pid, "SIGTERM"), { code: "EPERM" });
const transport = a.launch(["/app/hosted/bin/git-remote-desk", "origin", "origin"]);
let capabilities = "";
const transportReady = new Promise(resolve => transport.stdout.on("data", chunk => {
  capabilities += chunk;
  if (capabilities.includes("\n\n")) resolve();
}));
transport.stdin.write("capabilities\n");
await transportReady;
let observedHttps = false;
for (const entry of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
  let argv;
  try { argv = readFileSync(`/proc/${entry}/cmdline`, "utf8"); } catch { continue; }
  if (argv.includes("git-remote-https")) {
    observedHttps = true;
    assert.ok(argv.endsWith("\0desk-http\0"), "actual HTTPS helper has only a public alias argument");
  }
  assert.ok(!argv.includes(a.realm.root) && !argv.includes(b.realm.root), "no long-lived gateway/Desk boundary argv exposes a realm");
  assert.ok(!argv.includes("https://github.com/synthetic/desk.git"));
}
assert.equal(observedHttps, true);
transport.stdin.end("\n");
assert.equal((await once(transport, "close"))[0], 0);
assert.throws(() => child.kill("SIGUSR1"), /Unsupported/);
child.kill("SIGTERM");
const [code] = await once(child, "close");
assert.equal(code, 0);
assert.equal(child.kill("SIGKILL"), false, "closed child generation cannot signal a replacement");
await store.putBinding("account-a", { ...binding, author: { ...binding.author, name: "Changed" } });
await assert.rejects(manager.prepare("account-a"), /authority/);
await store.putBinding("account-a", binding);
await store.putAccount({ accountId: "account-a", displayName: "Synthetic", deskAccess: false });
await assert.rejects(manager.prepare("account-a"));
await assert.rejects(a.git(["-C", b.env.DESK, "status"]), /private|context/i);
const tokenChild = a.launch(["/app/hosted/bin/git-credential-desk.js", "get"]);
let token = "";
tokenChild.stdout.on("data", chunk => { token += chunk; });
tokenChild.stdin.end("protocol=https\nhost=github.com\n\n");
assert.equal((await once(tokenChild, "close"))[0], 0);
assert.match(token, /password=synthetic-token/);
await a.git(["commit", "--quiet", "--allow-empty", "-m", "owned desk write"]);
const lateWrite = b.git(["commit", "--quiet", "--allow-empty", "-m", "late desk write"]);
await manager.close();
await lateWrite;
const pushed = spawnSync("/usr/bin/setpriv", isolationArgs({
  uid: a.realm.uid, command: process.execPath,
  args: ["-e", `const fs=require("node:fs"); const calls=fs.readFileSync(process.env.XDG_STATE_HOME+"/git-argv.jsonl","utf8").trim().split("\\n").map(JSON.parse); if(calls.some(args=>args.some(arg=>arg.includes(process.env.DESK)||arg.includes("https://github.com/synthetic/desk.git")||arg==="-C")))process.exit(1);`],
}), { env: a.env, encoding: "utf8" });
assert.equal(pushed.status, 0, pushed.stderr);
const subjects = fixtureGit(bare, ["log", "--format=%s"]);
assert.match(subjects, /owned desk write/);
assert.match(subjects, /late desk write/, "close must drain gateway Git operations before its final push");
await assert.rejects(manager.prepare("account-b"));
assert.equal(readFileSync(key, "utf8"), "not a credential");
await store.putAccount({ accountId: "account-c", displayName: "Synthetic", deskAccess: true });
await store.putBinding("account-c", binding);
const nextManager = runtime.createAccountRuntime({
  config, store, rootDir: join(root, "next-realms"),
  baseEnv: { PATH: "/data/runtime-native-bin:/usr/local/bin:/usr/bin:/bin" },
  mint: async () => ({ token: "synthetic-token" }),
});
const c = await nextManager.prepare("account-c");
assert.notEqual(c.realm.uid, a.realm.uid, "manager replacement cannot recycle a prior account's UID");
await assert.rejects(a.git(["status"]), /closed/);
writeFileSync("/data/runtime-native-fail-push", "synthetic failed push count");
await assert.rejects(nextManager.close(), /shutdown/);
const retainedSocket = spawn("/usr/bin/setpriv", isolationArgs({
  uid: c.realm.uid, command: process.execPath,
  args: ["/app/hosted/bin/git-credential-desk.js", "get"],
}), { env: c.env });
let retainedToken = "";
retainedSocket.stdout.on("data", chunk => { retainedToken += chunk; });
retainedSocket.stdin.end("protocol=https\nhost=github.com\n\n");
assert.equal((await once(retainedSocket, "close"))[0], 0);
assert.match(retainedToken, /synthetic-token/, "failed shutdown retains the broker rather than silently losing writes");
unlinkSync("/data/runtime-native-fail-push");
let timeoutCases;
if (process.env.DESK_NATIVE_TIMEOUTS === "1") {
  const { runTimeoutCases } = await import("./runtime-timeout-native.js");
  timeoutCases = await runTimeoutCases({
    config, store, binding, root,
    originSubjects: () => fixtureGit(bare, ["log", "--format=%s"]),
    async waitForSlowFetch(mode) {
      const deadline = Date.now() + 10_000;
      while (!slowFetches.has(mode) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(slowFetches.has(mode), `real HTTP ${mode} fetch must reach the fixture`);
    },
  });
}
let mainRouted = false;
if (process.env.DESK_NATIVE_MAIN === "1") {
  const { main } = await import("../../src/main.js");
  const { seal } = await import("../../src/auth/seal.js");
  const plugin = "/data/runtime-native-plugin";
  mkdirSync(join(plugin, "mcp"), { recursive: true, mode: 0o755 });
  writeFileSync(join(plugin, "mcp/package.json"), '{"type":"module"}');
  writeFileSync(join(plugin, "mcp/index.js"),
    readFileSync("/app/hosted/test/fixtures/echo-desk.js", "utf8")
      .replace('name: "echo-desk"', 'name: `owning-uid-${process.getuid()}`'));
  symlinkSync("/app/plugins/desk/mcp/src", join(plugin, "mcp/src"));
  await store.putAccount({ accountId: "account-main", displayName: "Synthetic", deskAccess: true });
  await store.putBinding("account-main", binding);
  const discovery = JSON.parse(readFileSync("/app/hosted/test/fixtures/entra-discovery-ourobottest.json", "utf8"));
  const server = await main({
    DESK_MULTI_USER: "1", PORT: "0", PATH: "/data/runtime-native-bin:/usr/local/bin:/usr/bin:/bin",
    DESK_SIGNING_KEY: "synthetic", DESK_PUBLIC_URL: "http://127.0.0.1",
    DESK_APP_ID: "1", DESK_APP_KEY_FILE: key, DESK_APP_CLIENT_ID: "synthetic", DESK_APP_CLIENT_SECRET: "synthetic",
    DESK_REPO: binding.repo, DESK_PLUGIN_DIR: plugin, DESK_CLONE_DIR: "/data/unused-legacy-clone",
    DESK_ENTRA_TENANT_ID: "c12edfb6-c5ab-4bf8-b1d5-1f053311d396", DESK_ENTRA_SUBDOMAIN: "ourobottest",
    DESK_ENTRA_CLIENT_ID: "11111111-2222-3333-4444-555555555555", DESK_ENTRA_CLIENT_SECRET: "synthetic",
    DESK_ACCOUNTS_ENDPOINT: "https://synthetic.invalid",
  }, { store, fetch: async () => new Response(JSON.stringify(discovery), { headers: { "content-type": "application/json" } }) });
  const token = seal("access", { clientId: "native", accountId: "account-main", authTime: Math.floor(Date.now() / 1000) }, { key: "synthetic", ttlSec: 300 });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "native", version: "1" } },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /owning-uid-10003/);
  mainRouted = true;
}
await new Promise(resolve => http.close(resolve));
console.log(JSON.stringify({
  passed: true, accounts: 2, ownCwd: true, owningUidGit: true, socketOwnership: true,
  signalBoundary: true, immutableAuthority: true, retry: true, shutdownPush: true,
  uidNeverRecycled: true, shutdownFailureSurfaced: true, failedPushSocketRetained: true,
  mainRouted,
  timeoutCases,
  retainedRoots: readdirSync(join(root, "realms")).map(name => join(root, "realms", name)),
  nextRoots: readdirSync(join(root, "next-realms")).map(name => join(root, "next-realms", name)),
}));
// The failed-shutdown case deliberately retains its broker. End this fixture's
// replica after verifying retention; inherited IPC disconnect stops its helpers.
if (mainRouted) process.kill(process.pid, "SIGTERM");
else process.exit(0);
