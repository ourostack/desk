// The shared restore for hooks that read task cards (boot acceptance round AA), and the signal that a guard which could not restore it is degraded: a marker the next boot reports as a `Desk problem:`.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { osEnv } from "../_os_env.js"

import { degradedHooks, ensureHookDependencies } from "../../../../../plugins/desk/mcp/src/runtime/hook-dependencies.js"

const require = createRequire(import.meta.url)
const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const { hookDependenciesCheck, runBootChecks } = require(path.join(plugin, "hooks", "boot-checks.cjs"))

const scratch = () => realpathSync(mkdtempSync(path.join(tmpdir(), "hook-deps-")))
const markers = (home) => { try { return readdirSync(path.join(home, ".local", "state", "ouroboros-skills", "desk", "hook-degraded")) } catch { return [] } }

test("a failed restore leaves a marker naming the hook and why; a later successful restore removes it", () => {
  const home = scratch()
  const env = { HOME: home }
  try {
    const failed = ensureHookDependencies({ hook: "elsewhere-clone", env, ensure: () => ({ source: "none", reason: "EACCES: cache is not writable" }), now: () => new Date("2026-10-05T12:00:00Z") })
    assert.equal(failed.source, "none")
    assert.deepEqual(degradedHooks({ env }), [{ hook: "elsewhere-clone", reason: "EACCES: cache is not writable", at: "2026-10-05T12:00:00.000Z" }])
    ensureHookDependencies({ hook: "task-status-guard", env, ensure: () => ({ source: "none" }) })
    assert.deepEqual(degradedHooks({ env }).map((entry) => [entry.hook, entry.reason]), [["elsewhere-clone", "EACCES: cache is not writable"], ["task-status-guard", "unknown"]])
    assert.equal(ensureHookDependencies({ hook: "elsewhere-clone", env, ensure: () => ({ source: "runtime-cache" }) }).source, "runtime-cache")
    assert.deepEqual(degradedHooks({ env }).map((entry) => entry.hook), ["task-status-guard"])
    ensureHookDependencies({ hook: "task-status-guard", env, ensure: () => ({ source: "installed" }) })
    assert.deepEqual(degradedHooks({ env }), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the defaults read the process environment: HOME as the isolation harness set it", () => {
  const before = process.env.HOME
  const home = scratch()
  process.env.HOME = home
  try {
    assert.equal(ensureHookDependencies({ hook: "defaults", ensure: () => ({ source: "none", reason: "r" }) }).source, "none")
    assert.deepEqual(degradedHooks().map((entry) => entry.hook), ["defaults"])
    ensureHookDependencies({ hook: "defaults", ensure: () => ({ source: "installed" }) })
    assert.deepEqual(degradedHooks(), [])
  } finally {
    process.env.HOME = before
    rmSync(home, { recursive: true, force: true })
  }
})

test("the marker is only a signal: an unwritable state folder changes nothing, and unreadable markers are skipped", () => {
  const home = scratch()
  try {
    writeFileSync(path.join(home, ".local"), "a file where the state folder should be")
    assert.equal(ensureHookDependencies({ hook: "x", env: { HOME: home }, ensure: () => ({ source: "none", reason: "r" }) }).source, "none")
    assert.deepEqual(degradedHooks({ env: { HOME: home } }), [])
    rmSync(path.join(home, ".local"))
    const dir = path.join(home, ".local", "state", "ouroboros-skills", "desk", "hook-degraded")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "bad.json"), "{not json")
    writeFileSync(path.join(dir, "nohook.json"), "{}")
    assert.deepEqual(degradedHooks({ env: { HOME: home } }), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the boot check says nothing when no guard is degraded, and files one Desk problem naming the degraded guards when one is", async () => {
  const home = scratch()
  const env = { HOME: home }
  try {
    assert.equal(await runBootChecks({ host: "claude", env, checks: [hookDependenciesCheck], launchRepair: async () => {} }), "")
    ensureHookDependencies({ hook: "elsewhere-clone", env, ensure: () => ({ source: "none", reason: "ENOTDIR: /dev/null/x" }) })
    const launched = []
    const line = await runBootChecks({ host: "claude", env, checks: [hookDependenciesCheck], launchRepair: async (command) => { launched.push(command) } })
    assert.match(line, /Desk problem: hook-dependencies — the elsewhere-clone guard could not restore its dependencies/u)
    assert.match(line, /broke: elsewhere-clone: ENOTDIR/u)
    assert.match(line, /file: filing in background/u)
    assert.equal(launched.length, 1)
    assert.ok(launched[0].includes("hook-dependencies") && launched[0].some((part) => part.endsWith("file-desk-problem.js")))
    // The same failure again within the hour is throttled: the block still shows, the filer is not spawned twice.
    const again = []
    const second = await runBootChecks({ host: "claude", env, checks: [hookDependenciesCheck], launchRepair: async (command) => { again.push(command) } })
    assert.match(second, /file: filing already queued/u)
    assert.deepEqual(again, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The end-to-end case the coordinator named: an unwritable runtime cache (DESK_RUNTIME_CACHE_DIR under a regular file) from a bare plugin folder. The guard still fails open, and the next boot reports it.
test("a bare-folder clone guard with an unwritable runtime cache fails open, leaves a marker, and the next boot reports the degraded guard", async () => {
  const bare = scratch()
  const desk = path.join(bare, "desk")
  try {
    for (const dir of ["_meta", "_archive", path.join("track", "fork")]) mkdirSync(path.join(desk, dir), { recursive: true })
    writeFileSync(path.join(desk, "track", "fork", "task.md"), "---\ntitle: fork\nstatus: processing\nrepos:\n  - name: ari-fixture/listed-only\n    mode: remote\n---\n\n**Next step:** push `b` from my other laptop.\n")
    const copy = path.join(bare, "plugin")
    cpSync(plugin, copy, { recursive: true, dereference: true, filter: (file) => path.basename(file) !== "node_modules" })
    // A folder cannot be made under a regular file on any platform; `/dev/null/x` would be a creatable path on Windows.
    writeFileSync(path.join(bare, "cache-is-a-file"), "x")
    const env = osEnv({ PATH: process.env.PATH, HOME: bare, DESK_RUNTIME_CACHE_DIR: path.join(bare, "cache-is-a-file", "x") })
    const result = spawnSync(process.execPath, [path.join(copy, "hooks", "protected-checkout.cjs"), "claude"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git clone https://github.com/ari-fixture/listed-only.git" }, cwd: desk }), encoding: "utf8", env,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "{}")
    assert.deepEqual(markers(bare), ["elsewhere-clone.json"])
    assert.equal(JSON.parse(readFileSync(path.join(bare, ".local", "state", "ouroboros-skills", "desk", "hook-degraded", "elsewhere-clone.json"), "utf8")).hook, "elsewhere-clone")
    const line = await runBootChecks({ host: "claude", env: osEnv({ HOME: bare }), checks: [hookDependenciesCheck], launchRepair: async () => {} })
    assert.match(line, /Desk problem: hook-dependencies — the elsewhere-clone guard could not restore its/u)
    assert.ok(existsSync(copy))
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})
