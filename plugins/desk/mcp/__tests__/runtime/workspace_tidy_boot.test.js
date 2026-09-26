import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkTempRoot } from "../_temp_roots.js"

const require = createRequire(import.meta.url)
const hookPath = new URL("../../../hooks/boot-checks.cjs", import.meta.url)
let boot = {}
try { boot = require(hookPath.pathname) } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error }
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

async function fixture() {
  const root = await mkTempRoot("desk-tidy-boot-")
  const desk = path.join(root, "desk")
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  git(desk, "init", "-b", "main")
  git(desk, "config", "user.name", "Fixture")
  git(desk, "config", "user.email", "fixture@example.invalid")
  git(desk, "commit", "--allow-empty", "-m", "init")
  return { root, desk, env: { ...process.env, HOME: root, DESK: desk, DESK_ACTIVATION_CONFIG: "" } }
}

test("boot check queues a detached repair, returns without waiting, and records complete leftovers", async () => {
  assert.equal(typeof boot.runBootChecks, "function")
  const f = await fixture()
  const w = path.join(f.root, "unowned")
  git(f.desk, "worktree", "add", "-b", "unowned", w)
  const started = performance.now()
  const line = await boot.runBootChecks({ host: "copilot", env: f.env, sessionFolder: f.desk })
  assert.ok(performance.now() - started < 1000)
  assert.match(line, /^Desk boot: workspace-tidy/)
  assert.match(line, /deferred/)
  assert.equal(line.split("\n").length, 1)
  const reportPath = boot.reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  const deadline = Date.now() + 10_000
  let report
  while (Date.now() < deadline) {
    try { report = JSON.parse(await fs.readFile(reportPath, "utf8")); break } catch (error) { if (error.code !== "ENOENT") throw error }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(report?.left.length, 1)
  assert.equal(report.left[0].path, w)
  assert.match(report.left[0].reason, /ownership/)
  assert.ok((await fs.stat(w)).isDirectory())
  const next = await boot.runBootChecks({ host: "copilot", env: f.env, sessionFolder: f.desk, launch: async () => {} })
  assert.match(next, /1 left/)
  assert.match(next, /ownership/)
})

test("ambiguous Copilot binding never launches cleanup against a guessed desk", async () => {
  const f = await fixture()
  const other = path.join(f.root, "other")
  await fs.mkdir(path.join(other, "_meta"), { recursive: true })
  await fs.mkdir(path.join(other, "_archive"))
  const line = await boot.runBootChecks({ host: "copilot", env: f.env, sessionFolder: other })
  assert.match(line, /binding.*ambiguous/)
  assert.equal((await fs.readdir(path.join(f.desk, ".git"))).some((name) => name.startsWith("desk-workspace")), false)
})

test("boot failure degrades in one bounded line and never blocks session start", async () => {
  const f = await fixture()
  const bad = path.join(f.root, "bad.json")
  await fs.writeFile(bad, "{")
  const line = await boot.runBootChecks({ host: "claude", env: { ...f.env, DESK_ACTIVATION_CONFIG: bad } })
  assert.match(line, /^Desk boot:/)
  assert.match(line, /binding|configuration/)
  assert.ok(line.length <= 512)
})

test("both actual startup hooks include exactly one boot line without changing their host envelope", async () => {
  const f = await fixture()
  const plugin = path.resolve(hookPath.pathname, "../..")
  const env = { ...f.env, PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: f.desk }
  for (const host of ["copilot", "claude"]) {
    const result = host === "copilot"
      ? execFileSync(process.execPath, [path.join(plugin, "hooks", "copilot-session-start.cjs")], { env, input: JSON.stringify({ cwd: f.desk }), encoding: "utf8" })
      : execFileSync("bash", [path.join(plugin, "hooks", "session-start.sh")], { env, encoding: "utf8" })
    const parsed = JSON.parse(result)
    const context = parsed.additionalContext ?? parsed.hookSpecificOutput.additionalContext
    assert.equal((context.match(/Desk boot:/gu) ?? []).length, 1)
    assert.match(context, /Desk startup:/)
  }
  // Let the exact fixture-only repairs finish before the fixture owner removes the root.
  await new Promise((resolve) => setTimeout(resolve, 300))
})

test("the complete boot check has a deadline even when launching repair stalls", async () => {
  const f = await fixture()
  const started = performance.now()
  const line = await boot.runBootChecks({ host: "copilot", env: f.env, sessionFolder: f.desk, budgetMs: 60, launch: () => new Promise(() => {}) })
  assert.ok(performance.now() - started < 300)
  assert.match(line, /budget.*deferred/)
})

test("existing repair locks expose the exact pending resource without stealing it", async () => {
  const f = await fixture()
  const file = boot.reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  await fs.writeFile(`${file}.lock`, "another-owner")
  const result = await boot.runRepair(f.desk)
  assert.equal(result.busy, true)
  assert.equal(await fs.readFile(`${file}.lock`, "utf8"), "another-owner")
  const line = await boot.runBootChecks({ host: "copilot", env: f.env, sessionFolder: f.desk, launch: async () => {} })
  assert.match(line, /repair lock/)
})
