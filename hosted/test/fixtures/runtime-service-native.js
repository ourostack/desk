import assert from "node:assert/strict";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { spawnSync } from "node:child_process";
import { createAccountRuntime } from "../../src/account-runtime.js";
import { isolationArgs } from "../../src/isolation.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function asDesk(desk, code) {
  const result = spawnSync("/usr/bin/setpriv", isolationArgs({
    uid: desk.realm.uid, command: process.execPath, args: ["--input-type=module", "-e", code],
  }), { env: desk.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function inspect(desk) {
  return JSON.parse(asDesk(desk, `
import fs from "node:fs"; import path from "node:path";
const root = path.dirname(process.env.DESK);
console.log(JSON.stringify({
  started: fs.existsSync(path.join(root, "service-writer-started")) ? fs.readFileSync(path.join(root, "service-writer-started"), "utf8") : null,
  finished: fs.existsSync(path.join(root, "service-writer-finished")),
  lateWrite: fs.existsSync(path.join(process.env.DESK, "_shared/service-late.md")),
  socket: fs.existsSync(process.env.DESK_TOKEN_SOCKET),
  head: (await import("node:child_process")).execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: process.env.DESK, encoding: "utf8" }).trim(),
  refs: (await import("node:child_process")).execFileSync("/usr/bin/git", ["show-ref"], { cwd: process.env.DESK, encoding: "utf8" }).trim(),
}));
`));
}

// The SDK consumes the actual runtime handle rather than spawning a replacement.
async function connect(desk) {
  const child = desk.launch(["/app/plugins/desk/mcp/index.js"]);
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
  const client = new Client({ name: "service-retirement-native", version: "1" });
  await client.connect(transport);
  return { child, client, async call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  } };
}

export async function runServiceCases({ config, store, binding, root, originSubjects, originRefs }) {
  const bound = setTimeout(() => { console.error("Service native fixture exceeded 180 seconds."); process.exit(1); }, 180_000);
  const unproven = process.env.DESK_SERVICE_UNPROVEN === "1";
  const require = createRequire("/app/plugins/desk/mcp/package.json");
  const nativePaths = [
    require.resolve("better-sqlite3"),
    "/app/plugins/desk/mcp/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    require.resolve("sqlite-vec"),
    require.resolve("sqlite-vec-linux-x64/vec0.so"),
    "/app/plugins/desk/mcp/index.js",
    "/app/plugins/desk/mcp/src/readiness/identity.js",
    "/app/hosted/src/account-runtime.js",
    "/app/hosted/src/realm-helper.js",
    "/app/hosted/src/service-lifetime.js",
  ];
  console.log(JSON.stringify({ serviceNativeProvenance: nativePaths.map(path => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") })) }));
  const accounts = ["service-a", "service-b"];
  for (const accountId of accounts) {
    await store.putAccount({ accountId, displayName: "Synthetic", deskAccess: true });
    await store.putBinding(accountId, binding);
  }
  const manager = createAccountRuntime({
    config, store, rootDir: join(root, "service-realms"),
    baseEnv: { PATH: "/data/runtime-native-bin:/usr/local/bin:/usr/bin:/bin" },
    mint: async () => ({ token: "synthetic-token" }),
  });
  const [a, b] = await Promise.all(accounts.map(id => manager.prepare(id)));
  for (const desk of [a, b]) {
    assert.equal(readFileSync("/etc/passwd", "utf8").split("\n").some(row => row.split(":")[2] === String(desk.realm.uid)), false);
  }
  const first = await connect(a);
  const second = await connect(a);
  const neighbor = await connect(b);
  await Promise.all([first.call("desk_status"), second.call("desk_status"), neighbor.call("desk_status")]);
  const processes = [];
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      if (![a, b].some(desk => new RegExp(`Uid:\\s+${desk.realm.uid}\\s`).test(status))) continue;
      assert.match(status, /CapEff:\s+0000000000000000/);
      assert.match(status, /CapPrm:\s+0000000000000000/);
      assert.match(status, /CapAmb:\s+0000000000000000/);
      assert.match(status, /NoNewPrivs:\s+1/);
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      assert.ok(!argv.some(arg => arg.includes(a.realm.root) || arg.includes(b.realm.root)));
      processes.push({ pid, status, argv });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  console.log(JSON.stringify({ serviceKernelProcesses: processes, passwdAbsent: [a.realm.uid, b.realm.uid] }));
  const note = "_shared/service-native.md";
  await first.call("desk_save", { files: [{ path: note, content: "# ServiceRetirementWitness\nActual compiled MCP SQLite Git.\n" }], message: "service native write" });
  await second.call("desk_reindex");
  assert.match(asDesk(a, `
import Database from "/app/plugins/desk/mcp/node_modules/better-sqlite3/lib/index.js";
const db = new Database(process.env.DESK + "/.state/desk-index.sqlite", { readonly: true });
console.log(JSON.stringify(db.prepare("SELECT path FROM docs WHERE path = ?").get("_shared/service-native.md")));
db.close();
`), /service-native.md/);
  assert.match(JSON.stringify(await second.call("desk_search", { query: "ServiceRetirementWitness" })), /service-native.md/);
  const deadline = Date.now() + 90_000;
  while (!originSubjects().includes("service native write") && Date.now() < deadline) await pause(100);
  assert.match(originSubjects(), /service native write/, "automatic sync must reach actual loopback origin");

  // Actual MCP-triggered Git launches a setsid writer with ignored stdio.
  // It waits for the protocol-close witness, not a guessed startup duration.
  const hook = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(`
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const root = path.dirname(process.env.DESK);
fs.writeFileSync(path.join(root, "service-writer-started"), fs.readFileSync("/proc/self/status", "utf8"));
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(root, "service-protocol-closed"))) return;
  clearInterval(timer);
  const begin = Date.now();
  const wait = setInterval(() => {
    if (${unproven} && fs.existsSync(process.env.DESK_TOKEN_SOCKET) && Date.now() - begin < 20000) return;
    clearInterval(wait);
    setTimeout(() => {
    fs.writeFileSync(path.join(process.env.DESK, "_shared/service-late.md"), "detached service write\\n");
    cp.execFileSync("/usr/bin/git", ["add", "_shared/service-late.md"], { cwd: process.env.DESK });
    cp.execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "detached service late write"], { cwd: process.env.DESK });
    fs.writeFileSync(path.join(root, "service-writer-finished"), "finished");
    }, ${unproven ? 1000 : 500});
  }, 25);
}, 25);
`)}], { detached: true, stdio: "ignore", env: process.env }).unref();
`;
  asDesk(a, `import fs from "node:fs"; fs.writeFileSync(process.env.DESK + "/.git/hooks/post-commit", ${JSON.stringify(hook)}, { mode: 0o700 });`);
  await first.call("desk_save", { files: [{ path: note, content: "# ServiceRetirementWitness\nTrigger delayed writer.\n" }], message: "service delayed trigger" });
  const started = Date.now() + 10_000;
  while (!inspect(a).started && Date.now() < started) await pause(25);
  const status = inspect(a).started;
  assert.match(status, new RegExp(`Uid:\\s+${a.realm.uid}\\s+${a.realm.uid}`));
  assert.match(status, /CapEff:\s+0000000000000000/);
  assert.match(status, /NoNewPrivs:\s+1/);
  await first.client.close();
  await second.call("desk_status");
  assert.match(JSON.stringify(await second.call("desk_search", { query: "ServiceRetirementWitness" })), /service-native.md/);
  const terminated = once(second.child, "close");
  assert.equal(second.child.kill("SIGTERM"), true);
  await terminated;
  assert.equal(second.child.kill("SIGKILL"), false);
  asDesk(a, `import fs from "node:fs"; import path from "node:path"; fs.writeFileSync(path.join(path.dirname(process.env.DESK), "service-protocol-closed"), "protocol EOF is not retirement");`);
  const close = a.close();
  assert.equal(a.close(), close, "realm close remains idempotent");
  const closeResult = await close.then(() => ({ ok: true }), error => ({ ok: false, error: error.message }));
  const atClose = {
    ...inspect(a),
    pushed: originSubjects().includes("detached service late write"),
  };
  await pause(2000);
  console.log(JSON.stringify({ serviceRetirement: { atClose, after: inspect(a), closeResult, uidA: a.realm.uid, uidB: b.realm.uid } }));
  if (unproven) {
    assert.equal(closeResult.ok, false, "unretired service activity must reject close");
    assert.equal(atClose.socket, true, "unproven retirement retains the broker");
    await assert.rejects(a.close(), /quiescen|preserv/i);
    await assert.rejects(manager.prepare("service-a"), /quiescen|preserv/i);
    await pause(21_000);
    assert.equal(inspect(a).finished, true, "retained writer eventually finishes without lost evidence");
  } else {
    assert.equal(atClose.finished, true, "service quiescence must precede final push and broker close");
    assert.equal(atClose.pushed, true, "final origin must contain the real detached service write");
    assert.equal(closeResult.ok, true);
  }
  await neighbor.call("desk_status");
  await neighbor.client.close();
  if (unproven) await assert.rejects(manager.close(), /preserv|shutdown/i);
  else await manager.close();
  console.log(JSON.stringify({ serviceFinalState: { a: inspect(a), b: inspect(b), originRefs: originRefs() } }));
  clearTimeout(bound);
  return { actualMcp: true, sqlite: true, automaticSync: true, unproven, detachedWritePreserved: true, sameRealmSessions: 2, neighborUnaffected: true };
}
