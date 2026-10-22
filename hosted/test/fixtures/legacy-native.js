// Single-desk (DESK_MULTI_USER=0) gateway in the production image: the entrypoint
// drops to node (uid 1000) with no capabilities, and the real Desk the legacy
// relay starts, with the environment it is given, must reach ready with its
// state under the gateway user's own home.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { deskChildArgs, deskChildEnv } from "../../src/main.js";

const bound = setTimeout(() => { console.error("Legacy native fixture exceeded 180 seconds."); process.exit(1); }, 180_000);

const status = readFileSync("/proc/self/status", "utf8");
assert.match(status, /Uid:\s+1000\s+1000\s+1000\s+1000/, "the legacy gateway runs as node");
for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
  assert.match(status, new RegExp(`${name}:\\s+0000000000000000`), `${name} is empty on the legacy gateway`);
}
assert.equal(process.env.HOME, "/home/node", "the legacy gateway's HOME is node's home");
assert.equal(process.env.USER, "node", "the legacy gateway's USER is node");
assert.equal(homedir(), "/home/node");

const cloneDir = "/data/legacy-native-desk";
mkdirSync(cloneDir, { recursive: true });
const git = (args) => {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: cloneDir, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_EMAIL: "fixture@example.com" },
  });
  assert.equal(result.status, 0, result.stderr);
};
git(["init", "--quiet", "-b", "main"]);
writeFileSync(join(cloneDir, "marker"), "legacy marker");
git(["add", "."]);
git(["commit", "--quiet", "-m", "seed"]);

// Exactly the arguments and environment the legacy relay gives each Desk child.
const config = { pluginDir: "/app/plugins/desk", cloneDir, issuer: null };
const env = deskChildEnv({
  config, author: { name: "Synthetic", email: "synthetic@users.noreply.github.com" },
  socketPath: "/data/legacy-native-no-socket", baseEnv: process.env,
});
assert.equal(env.HOME, "/home/node", "Desk children inherit the gateway user's home");
const child = spawn(process.execPath, deskChildArgs(config), { stdio: "pipe", env });
child.stderr.pipe(process.stderr, { end: false });
const transport = {
  async start() {
    createInterface({ input: child.stdout }).on("line", line => {
      if (line.trim()) this.onmessage?.(JSON.parse(line));
    });
    child.once("close", () => this.onclose?.());
    child.once("error", error => this.onerror?.(error));
  },
  async send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
  async close() {
    const closed = once(child, "close");
    child.stdin.end();
    await closed;
  },
};
const client = new Client({ name: "legacy-native", version: "1" });
await client.connect(transport);
const result = await client.callTool({ name: "desk_status", arguments: {} }, undefined, { timeout: 120_000 });
assert.ok(!result.isError, JSON.stringify(result));
const deskStatus = JSON.parse(result.content.find(part => part.type === "text").text);
console.log(JSON.stringify({ legacyDeskStatus: deskStatus.state }));
assert.equal(deskStatus.state, "ready", `legacy Desk reaches ready: ${JSON.stringify(deskStatus).slice(0, 2000)}`);
await client.close();

// Desk's default state folders are under the gateway user's home. The readiness
// one exists; the handle key is written the first time Desk names a folder, so
// two Desk processes with this environment must name one folder alike.
const readiness = join(homedir(), ".cache", "ouroboros-skills", "desk", "readiness");
assert.ok(existsSync(readiness), `${readiness} was created`);
const nameFolder = () => {
  const named = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const { folderHandle } = await import("/app/plugins/desk/mcp/src/desk/handles.js"); console.log(folderHandle("task", ${JSON.stringify(cloneDir)}, ${JSON.stringify(join(cloneDir, "track", "task"))}));`,
  ], { env, encoding: "utf8" });
  assert.equal(named.status, 0, named.stderr);
  return named.stdout.trim();
};
const firstHandle = nameFolder();
assert.match(firstHandle, /^task-[0-9a-f]{10}$/);
assert.equal(nameFolder(), firstHandle, "handles are stable across Desk processes");
const handleKey = join(homedir(), ".local", "state", "ouroboros-skills", "desk", "handle-key");
assert.ok(existsSync(handleKey), `${handleKey} was created`);
clearTimeout(bound);
console.log(JSON.stringify({ passed: true, home: homedir(), readiness: true, handleKey: true }));
process.exit(0);
