import { test } from "node:test"
import assert from "node:assert/strict"
import { fork, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamTransport } from "./_in_process_desk.js"
import { mkTempRoot } from "../_temp_roots.js"
import { recordCopilotSession } from "../../../../../plugins/desk/mcp/src/runtime/copilot-session.js"
import { indexDbPath } from "../../../../../plugins/desk/mcp/src/db/init.js"

for (const phase of ["rootStatus", "inspectLocalDb", "openSnapshot"]) {
test(`actual MCP and controller processes retain 200 ms status/list/ping caps through blocked ${phase} and late destination`, async (t) => {
  const base = await mkTempRoot("status-process-")
  const home = path.join(base, "home")
  const a = path.join(home, "desk")
  const b = path.join(base, "b")
  const cwd = path.join(base, "code")
  mkdirSync(cwd)
  for (const root of [a, b]) {
    mkdirSync(path.join(root, "_meta"), { recursive: true })
    mkdirSync(path.join(root, "_archive"))
    writeFileSync(path.join(root, "task.md"), "# Current status destination\n")
    for (const args of [
      ["init", "-b", "main"], ["config", "user.name", "Fixture"],
      ["config", "user.email", "fixture@example.invalid"], ["add", "."], ["commit", "-m", "fixture"],
    ]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
    }
  }
  const marker = path.join(base, "sql-entered.json")
  const seam = path.join(base, "sql-seam.mjs")
  const from = new URL("../../../../../plugins/desk/mcp/package.json", import.meta.url).href
  writeFileSync(seam, `
    import { createRequire } from "node:module";
    import { writeFileSync } from "node:fs";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const Database = createRequire(${JSON.stringify(from)})("better-sqlite3");
    const original = Database.prototype.prepare;
    let blocked = false;
    Database.prototype.prepare = function(...args) {
      if (!blocked && ${JSON.stringify(phase)} !== "rootStatus" && new Error().stack.includes(${JSON.stringify(phase)})) {
        blocked = true;
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, root: this.name}));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      }
      return original.apply(this, args);
    };
    const exists = fs.existsSync;
    fs.existsSync = function(...args) {
      if (!blocked && ${JSON.stringify(phase)} === "rootStatus" && new Error().stack.includes("rootStatus")) {
        blocked = true;
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, root: args[0]}));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      }
      return exists.apply(this, args);
    };
    syncBuiltinESMExports();
  `)
  const config = path.join(base, "binding.json")
  writeFileSync(config, JSON.stringify({ schema_version: 1, desk: { root: a, state_branch: "main" },
    desk_runtime: { semantic: "unsupported" } }))
  const env = { ...process.env, HOME: home, DESK_TEST_RUN_DIR: base,
    XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_RUNTIME_DIR: path.join(base, "runtime"),
    COPILOT_AGENT_SESSION_ID: `status-process-${process.pid}`,
  }
  for (const name of ["DESK", "DESK_ACTIVATION_CONFIG", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR", "CODEX_HOME"]) delete env[name]
  assert.equal(recordCopilotSession({ sessionId: env.COPILOT_AGENT_SESSION_ID, folder: cwd, activationConfig: config, env }), true)
  const child = fork(fileURLToPath(new URL("./_status_process.js", import.meta.url)), [seam, marker, phase], {
    cwd, env, execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk })
  let closedReport
  child.on("message", (message) => { if (message.type === "closed") closedReport = message })
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code))
  })
  const client = new Client({ name: "status-process-test", version: "1" })
  t.after(async () => {
    await client.close()
    child.stdin.end()
    assert.equal(await exited, 0, stderr)
    assert.deepEqual(closedReport?.children, 0, "all exact-owned status readers and controllers must close")
    assert.equal(closedReport.maxReaders, 1, "status calls must never pile up concurrent reader processes")
    t.diagnostic(JSON.stringify({ owningMcpPid: child.pid, ownedChildrenAfterClose: closedReport.children,
      inspectedPid: closedReport.inspected, maxReaders: closedReport.maxReaders, exitCode: 0 }))
  })
  await client.connect(new StreamTransport({ toServer: child.stdin, fromServer: child.stdout }))
  const statusTimes = []
  const status = async () => {
    const start = Date.now()
    const response = await client.callTool({ name: "desk_status", arguments: { detail: true } })
    assert.ok(Date.now() - start < 200, `actual process status exceeded cap: ${Date.now() - start} ms; ${stderr}`)
    statusTimes.push(Date.now() - start)
    return JSON.parse(response.content[0].text)
  }
  const current = async (root) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const value = await status()
      if (value.root?.path === root && value.local_db?.state === "available") return value
      if (value.root?.path && value.root.path !== root) {
        assert.equal(value.root.path, a, "only the still-admitted A context may be shown while B is unresolved")
        assert.equal(value.admission.phase, "resolving_inputs")
        assert.equal(value.admission.writes, "refused")
        assert.match(value.status_detail, /^cached: .*Destination verification is pending/u)
        assert.ok(Number.isFinite(Date.parse(value.status_detail_from)))
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.fail(`no completed same-context status for ${root}; ${stderr}`)
  }
  const first = await current(a)
  assert.equal(first.write_scope.mode, "workspace")
  assert.ok(first.status_detail_from, "slow current detail must retain its real computation start")
  assert.ok(existsSync(marker), "qualification must traverse the real SQLite seam")
  const inspection = JSON.parse(readFileSync(marker, "utf8"))
  assert.notEqual(inspection.pid, child.pid, "SQLite must run outside the MCP answering process")
  assert.equal(inspection.root, phase === "rootStatus" ? a : indexDbPath(a))
  // Start a new blocked computation and qualify protocol control traffic on
  // another process, not on a stream with an in-process controller.
  await status()
  const controlStarted = Date.now()
  await Promise.all([client.ping(), client.listTools()])
  const controlMs = Date.now() - controlStarted
  assert.ok(controlMs < 200, "actual process tools/list and ping exceeded cap")
  writeFileSync(config, JSON.stringify({ schema_version: 1, desk: { root: b, state_branch: "main" },
    desk_runtime: { semantic: "unsupported" } }))
  const second = await current(b)
  assert.equal(second.root.path, b)
  assert.equal(second.local_db.path, indexDbPath(b))
  assert.equal(second.write_scope.mode, "workspace")
  assert.notEqual(second.status_detail_from, first.status_detail_from)
  t.diagnostic(JSON.stringify({ phase, maxStatusMs: Math.max(...statusTimes), statusCalls: statusTimes.length,
    controlMs, capMs: 200, currentDestinationAfterReplacement: true,
    fields: ["state", "root.path", "local_db.path", "write_scope.mode", "status_detail_from"] }))
})
}
