import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { ensureClone, runGit } from "../src/clone.js";
import { serveTokens } from "../src/token-socket.js";

const HELPER = fileURLToPath(new URL("../bin/git-credential-desk.js", import.meta.url));

// Runs the credential helper with `input` on stdin.
async function helper(op, input, env) {
  const child = spawn(process.execPath, [HELPER, op], { env: { PATH: process.env.PATH, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input);
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

async function tokenSocket(t) {
  const dir = mkdtempSync(join(tmpdir(), "desk-helper-"));
  const socketPath = join(dir, "git-token.sock");
  const server = serveTokens({ socketPath, mint: async () => ({ token: "ghs_fromsocket", expiresAt: 0 }) });
  await once(server, "listening");
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return socketPath;
}

test("the credential helper answers a GitHub get with the token from the socket", async (t) => {
  const socketPath = await tokenSocket(t);
  const result = await helper("get", "protocol=https\nhost=github.com\n\n", { DESK_TOKEN_SOCKET: socketPath });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "username=x-access-token\npassword=ghs_fromsocket\n");
});

test("the credential helper prints nothing for store, erase or another host", async (t) => {
  const socketPath = await tokenSocket(t);
  const env = { DESK_TOKEN_SOCKET: socketPath };
  for (const [op, input] of [
    ["store", "protocol=https\nhost=github.com\nusername=x-access-token\npassword=p\n\n"],
    ["erase", "protocol=https\nhost=github.com\n\n"],
    ["get", "protocol=https\nhost=gitlab.com\n\n"],
  ]) {
    const result = await helper(op, input, env);
    assert.equal(result.code, 0, `${op} exits 0`);
    assert.equal(result.stdout, "", `${op} prints nothing`);
  }
});

test("the credential helper fails with a message when the socket is unreachable", async () => {
  const result = await helper("get", "protocol=https\nhost=github.com\n\n", { DESK_TOKEN_SOCKET: join(tmpdir(), "no-such-desk.sock") });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /could not reach the gateway's token socket/);
});

// A local bare repository standing in for github.com/arimendelow/desk, and a
// git runner that rewrites https://github.com/ to it.
function fakeRemote(t) {
  const root = mkdtempSync(join(tmpdir(), "desk-clone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remotes = join(root, "remotes");
  const bare = join(remotes, "arimendelow", "desk.git");
  mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  execFileSync("git", ["-C", bare, "config", "uploadpack.allowFilter", "true"]);
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "AGENTS.md"), "# Desk\n");
  const id = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
  execFileSync("git", [...id, "-C", seed, "add", "."]);
  execFileSync("git", [...id, "-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", bare, "main"]);
  const calls = [];
  const git = (args, options = {}) => {
    calls.push(args);
    return runGit(args, {
      ...options,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/",
      },
    });
  };
  return { root, git, calls };
}

const config = (dir, key) => execFileSync("git", ["-C", dir, "config", "--local", "--get-all", key], { encoding: "utf8" }).split("\n").slice(0, -1);

test("ensureClone clones the desk once and points Git at the credential helper", async (t) => {
  const { root, git, calls } = fakeRemote(t);
  const dir = join(root, "desk");
  await ensureClone({ dir, repo: "arimendelow/desk", git });
  assert.ok(existsSync(join(dir, "AGENTS.md")));
  assert.deepEqual(config(dir, "remote.origin.url"), ["https://github.com/arimendelow/desk.git"]);
  assert.deepEqual(config(dir, "credential.https://github.com.helper"), ["", `!node '${HELPER}'`]);
  assert.deepEqual(config(dir, "credential.useHttpPath"), ["false"]);
  assert.deepEqual(config(dir, "pull.rebase"), ["true"]);
  assert.deepEqual(config(dir, "remote.origin.partialclonefilter"), ["blob:none"], "a partial clone: blobs come on demand");
  assert.deepEqual(config(dir, "remote.origin.promisor"), ["true"]);

  const cloneCall = calls.find((args) => args.includes("clone"));
  assert.ok(cloneCall.includes("credential.helper="), "the clone clears inherited helpers");
  assert.ok(cloneCall.includes(`credential.helper=!node '${HELPER}'`), "the clone authenticates through the helper");

  const clones = () => calls.filter((args) => args.includes("clone")).length;
  assert.equal(clones(), 1);
  await ensureClone({ dir, repo: "arimendelow/desk", git });
  assert.equal(clones(), 1);
  assert.deepEqual(config(dir, "credential.https://github.com.helper"), ["", `!node '${HELPER}'`]);
});

test("ensureClone clones into an empty directory, such as a fresh volume mount", async (t) => {
  const { root, git } = fakeRemote(t);
  const dir = join(root, "mount");
  mkdirSync(dir);
  await ensureClone({ dir, repo: "arimendelow/desk", git });
  assert.ok(existsSync(join(dir, "AGENTS.md")));
});

test("ensureClone refuses a directory that holds files but no Git checkout", async (t) => {
  const { root, git } = fakeRemote(t);
  const dir = join(root, "stray");
  mkdirSync(dir);
  writeFileSync(join(dir, "notes.txt"), "x");
  await assert.rejects(ensureClone({ dir, repo: "arimendelow/desk", git }), /not a Git checkout/);
});

test("in the clone, Git takes GitHub credentials from the token socket and not from an inherited helper", async (t) => {
  const { root, git } = fakeRemote(t);
  const dir = join(root, "desk");
  await ensureClone({ dir, repo: "arimendelow/desk", git });
  const socketPath = await tokenSocket(t);
  const globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, '[credential]\n\thelper = "!f() { echo username=inherited; echo password=inherited; }; f"\n');
  const child = spawn("git", ["-C", dir, "credential", "fill"], {
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", DESK_TOKEN_SOCKET: socketPath },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stdin.end("protocol=https\nhost=github.com\npath=arimendelow/desk.git\n\n");
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.match(stdout, /^username=x-access-token$/m);
  assert.match(stdout, /^password=ghs_fromsocket$/m);
});
