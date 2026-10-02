// Round 12 boot changes: a line about missing prerequisites, and the desk's pre-commit hook installed at boot.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { hookScript } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}

async function desk({ git = false } = {}) {
  const root = await mkTempRoot("desk-boot-round12-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  await fs.mkdir(path.join(root, "ops", "relay"), { recursive: true })
  await fs.writeFile(path.join(root, "ops", "relay", "task.md"), "---\nschema_version: 1\ntitle: Relay\nstatus: processing\ncreated: '2026-01-01T00:00:00Z'\nupdated: '2026-01-02T00:00:00Z'\ntrack: ops\n---\n\nBody.\n")
  if (git) assert.equal(spawnSync("git", ["init", "-q", "-b", "main", root]).status, 0)
  return root
}

const boot = (root, extra = {}) =>
  bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states: [], pending: [] }),
    ...extra,
  })

const MISSING = "If the next step needs something that is not on this machine (a branch, a file, a clone), say what is missing and stop; never recreate or simulate it; never clone or fetch to look for it, and never clone inside the desk folder."

test("every boot says to stop and name what is missing instead of recreating or simulating it, once, before the status line", async () => {
  const root = await desk()
  for (const taskQuery of [null, "relay", "nothing-like-it"]) {
    const { instructions } = await boot(root, { taskQuery })
    assert.equal(instructions.filter((line) => line === MISSING).length, 1)
    assert.ok(instructions.indexOf(MISSING) < instructions.findIndex((line) => line.startsWith("When you report on a task")))
  }
})

test("boot installs the desk's pre-commit hook on a git desk, quietly, and again is a no-op", async () => {
  const root = await desk({ git: true })
  const first = await boot(root)
  assert.equal(first.degraded.some((line) => line.startsWith("card guard")), false)
  const hook = path.join(root, ".git", "hooks", "pre-commit")
  assert.equal(readFileSync(hook, "utf8"), hookScript())
  const second = await boot(root)
  assert.equal(second.degraded.some((line) => line.startsWith("card guard")), false)
  assert.equal(readFileSync(hook, "utf8"), hookScript())
})

test("boot skips a desk that is not a git repository without a word", async () => {
  const root = await desk()
  const result = await boot(root)
  assert.equal(existsSync(path.join(root, ".git")), false)
  assert.equal(result.degraded.some((line) => line.startsWith("card guard")), false)
})

test("a hook that cannot be installed, or a throwing install, shows as one degraded line and never stops the boot", async () => {
  const root = await desk()
  const calls = []
  const failed = await boot(root, { cardGuardFn: (rootPath, options) => (calls.push([rootPath, typeof options.spawnGit]), { state: "failed", reason: "the hooks folder is read-only" }) })
  assert.deepEqual(calls, [[root, "function"]])
  assert.ok(failed.degraded.includes("card guard: the hooks folder is read-only"))
  assert.equal(failed.status, "degraded")
  assert.ok(failed.instructions.includes(MISSING))
  const threw = await boot(root, { cardGuardFn: () => { throw new Error("boom") } })
  assert.ok(threw.degraded.includes("card guard: boom"))
  const fine = await boot(root, { cardGuardFn: () => ({ state: "current" }) })
  assert.equal(fine.degraded.some((line) => line.startsWith("card guard")), false)
})

test("a tracked core.hooksPath is not a fault: boot leaves it alone and reports one non-degraded note with the manual remedy", async () => {
  const root = await desk()
  const note = { state: "tracked", reason: "core.hooksPath (.githooks) holds tracked files, so Desk left it alone", remedy: "add the check by hand" }
  const result = await boot(root, { cardGuardFn: () => note })
  assert.equal(result.degraded.some((line) => line.startsWith("card guard")), false)
  assert.ok(result.pending.some((line) => line.startsWith("card guard not installed") && line.includes("add the check by hand")))
  assert.equal(result.status, (await boot(root, { cardGuardFn: () => ({ state: "current" }) })).status, "the note does not change the boot status")
})
