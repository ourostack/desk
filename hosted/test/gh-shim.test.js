import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { serveTokens } from "../src/token-socket.js";

const SHIM = fileURLToPath(new URL("../bin/gh", import.meta.url));
const SHIM_DIR = dirname(SHIM);

// A fake real gh that reports the token and arguments it was given.
function fakeGh(t) {
  const dir = mkdtempSync(join(tmpdir(), "desk-fake-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gh");
  writeFileSync(path, '#!/bin/sh\necho "token=$GH_TOKEN args=$*"\nexit 3\n');
  chmodSync(path, 0o755);
  return { dir, path };
}

async function tokenSocket(t) {
  const dir = mkdtempSync(join(tmpdir(), "desk-gh-socket-"));
  const socketPath = join(dir, "git-token.sock");
  let n = 0;
  const server = serveTokens({ socketPath, mint: async () => ({ token: `ghs_call${++n}`, expiresAt: 0 }) });
  await once(server, "listening");
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return socketPath;
}

async function run(args, env) {
  const child = spawn(SHIM, args, { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

// PATH as a Desk child sees it: the shim's directory first.
const childPath = (...dirs) => [SHIM_DIR, ...dirs, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);

test("the gh shim runs the next gh on PATH with a fresh socket token for each call", async (t) => {
  const socketPath = await tokenSocket(t);
  const fake = fakeGh(t);
  const env = { PATH: childPath(fake.dir), DESK_TOKEN_SOCKET: socketPath, GH_TOKEN: "stale" };
  const first = await run(["pr", "list", "--repo", "arimendelow/desk"], env);
  assert.equal(first.stdout, "token=ghs_call1 args=pr list --repo arimendelow/desk\n");
  assert.equal(first.code, 3, "the real gh's exit code comes back");
  const second = await run(["api", "user"], env);
  assert.equal(second.stdout, "token=ghs_call2 args=api user\n");
});

test("the gh shim runs DESK_REAL_GH when it is set", async (t) => {
  const socketPath = await tokenSocket(t);
  const fake = fakeGh(t);
  const result = await run(["status"], { PATH: childPath(), DESK_REAL_GH: fake.path, DESK_TOKEN_SOCKET: socketPath });
  assert.equal(result.stdout, "token=ghs_call1 args=status\n");
});

test("the gh shim fails with a message, and runs nothing, when the socket is unreachable", async (t) => {
  const fake = fakeGh(t);
  const result = await run(["api", "user"], { PATH: childPath(fake.dir), DESK_TOKEN_SOCKET: join(tmpdir(), "no-such-desk.sock") });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /could not reach the gateway's token socket/);
});
