import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"

const require = createRequire(import.meta.url)
const gh = async (args) => ({ code: 0, stdout: args[0] === "--version" ? "gh version 2.54.0\n" : "", stderr: "" })

async function deskWithUntrackedFiles() {
  const root = await mkTempRoot("desk-read-only-child-")
  await fs.mkdir(path.join(root, "_meta"))
  await fs.mkdir(path.join(root, "_archive"))
  execFileSync("git", ["init", "-q"], { cwd: root })
  const untracked = ["stray-a.md", "stray-b.md"].map((name) => path.join(root, name))
  for (const file of untracked) await fs.writeFile(file, "mine\n")
  return { root, untracked }
}

const boot = (root, env, calls) => bootOnce({
  env: { DESK: root, ...env }, cwd: root, homeDir: root, gh,
  jq: async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" }),
  migrationsFn: async () => [],
  factoryStatusFn: () => ({ store: null, consent: "held", stores: [], warnings: [] }),
  syncFn: async () => { calls.push("sync"); return { state: "synced" } },
  backgroundFetchFn: () => calls.push("fetch"),
  cardGuardFn: () => { calls.push("guard"); return { state: "installed" } },
})

test("a read-only child's startup reads the desk and syncs, fetches, installs and moves nothing", async () => {
  const { root, untracked } = await deskWithUntrackedFiles()
  const calls = []
  const result = await boot(root, { DESK_READ_ONLY_CHILD: "1" }, calls)
  assert.deepEqual(calls, [])
  assert.equal(result.sync?.state, "skipped")
  for (const file of untracked) assert.equal(await fs.readFile(file, "utf8"), "mine\n")
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
  assert.equal(status.trim().split("\n").sort().join("|"), "?? stray-a.md|?? stray-b.md")
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: root }).status !== 0, true, "nothing was committed")
})

test("the same desk still syncs for a session that is not a read-only child", async () => {
  const { root } = await deskWithUntrackedFiles()
  const calls = []
  await boot(root, { DESK_READ_ONLY_CHILD: "0" }, calls)
  assert.ok(calls.includes("sync"))
  assert.ok(calls.includes("guard"))
})

test("a read-only child's hooks skip the session-end sync and the tidy repair launch", async () => {
  const flag = require("../../../../../plugins/desk/mcp/src/factory/headless-flag.cjs")
  assert.equal(flag.startupChangesNothing({ DESK_READ_ONLY_CHILD: "1" }), true)
  assert.equal(flag.startupChangesNothing({ DESK_READ_ONLY_CHILD: "0" }), false)
  assert.equal(flag.startupChangesNothing({}), false)
  const syncEnd = require("../../../../../plugins/desk/hooks/lib/sync-end.cjs")
  assert.equal(await syncEnd.runHook({ host: "claude", payload: {}, env: { DESK_READ_ONLY_CHILD: "1" } }), "headless")
  const { runBootChecks } = require("../../../../../plugins/desk/hooks/lib/boot-checks.cjs")
  assert.equal(await runBootChecks({ env: { DESK_READ_ONLY_CHILD: "1" } }), "")
})
