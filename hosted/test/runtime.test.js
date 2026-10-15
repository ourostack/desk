import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { main, readConfig } from "../src/main.js";
import { serveTokens } from "../src/token-socket.js";

const base = { DESK_SIGNING_KEY: "synthetic" };

test("multi-user gate preserves legacy defaults and rejects ambiguous or identity-less enablement", () => {
  assert.equal(readConfig(base).multiUser, false);
  assert.equal(readConfig({ ...base, DESK_MULTI_USER: "0" }).multiUser, false);
  for (const value of ["", "true", "01", " 1", "unset"]) {
    assert.throws(() => readConfig({ ...base, DESK_MULTI_USER: value }), /DESK_MULTI_USER/);
  }
  assert.throws(() => readConfig({ ...base, DESK_MULTI_USER: "1" }), /Ouro account identity/);
});

test("token socket readiness includes final private mode and requested ownership; listen failure rejects", async () => {
  const parent = new URL("./.runtime-socket-test/", import.meta.url);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent.pathname, "token.sock");
  const server = serveTokens({
    socketPath: path, uid: process.getuid(), gid: process.getgid(),
    mint: async () => ({ token: "synthetic" }),
  });
  try {
    assert.ok(server.ready instanceof Promise, "readiness must cover chmod/chown, not only listen");
    await server.ready;
    const stat = statSync(path);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.gid, process.getgid());
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const failed = serveTokens({ socketPath: join(parent.pathname, "missing", "token.sock"), mint: async () => ({ token: "" }) });
  assert.ok(failed.ready instanceof Promise);
  await assert.rejects(failed.ready);
});

test("account runtime refuses a non-Linux host instead of silently using legacy execution", async () => {
  const runtime = await import("../src/account-runtime.js").catch(() => ({}));
  assert.equal(typeof runtime.createAccountRuntime, "function", "account runtime not implemented");
  if (process.platform !== "linux") {
    assert.throws(() => runtime.createAccountRuntime({ config: { identity: {} }, store: {} }), /Linux/);
  }
});

test("enabled main fails the local kernel guard before making identity discovery calls", async () => {
  if (process.platform === "linux") return;
  let calls = 0;
  await assert.rejects(main({
    ...base, DESK_MULTI_USER: "1",
    DESK_ENTRA_TENANT_ID: "11111111-2222-3333-4444-555555555555",
    DESK_ENTRA_SUBDOMAIN: "synthetic",
    DESK_ENTRA_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
    DESK_ENTRA_CLIENT_SECRET: "synthetic",
    DESK_ACCOUNTS_ENDPOINT: "https://synthetic.invalid",
  }, { store: {}, fetch: async () => { calls++; throw new Error("Discovery must not run."); } }), /Linux/);
  assert.equal(calls, 0);
});

test("the private remote transport speaks the actual Git helper protocol using private repository context", async () => {
  const helper = fileURLToPath(new URL("../bin/git-remote-desk", import.meta.url));
  assert.ok(existsSync(helper), "sparse-argv remote transport is missing");
  const dir = fileURLToPath(new URL("./.runtime-socket-test/remote", import.meta.url));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  writeFileSync(join(dir, ".git", "desk-repository"), "synthetic/desk", { mode: 0o600 });
  const child = spawn(process.execPath, [helper, "origin", "origin"], {
    env: { PATH: process.env.PATH, DESK: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (stdout.includes("\n\n")) child.stdin.end("\n");
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.write("capabilities\n");
  assert.equal((await once(child, "close"))[0], 0, stderr);
  assert.match(stdout, /fetch\n/);
  assert.match(stdout, /push\n/);
});
