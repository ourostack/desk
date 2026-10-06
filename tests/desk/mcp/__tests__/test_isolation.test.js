// Guard for the global test setup (_isolated_env.mjs): every test process runs under a temporary HOME and XDG folders, Desk's default state paths resolve there, and a write under the real home fails.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, promises as fsPromises, readdirSync, rmSync, writeFile, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { REAL_HOME_WRITE, isRealHomeWrite, testRun } from "./_isolated_env.mjs"
import { mkTempRoot } from "./_temp_roots.js"
import { mkFakeRealRoot } from "./_fake_real_root.js"
import { resolveDeskStateDir, resolveReadinessStateHome } from "../../../../plugins/desk/mcp/src/runtime/last-start.js"

// A nested `node --test` of a factory or tools file writes private stores, and every protected write starts Windows PowerShell; boot_check.test.js alone ran 100 to 180 s on a CI runner, past the 120 s that macOS and Linux need.
const NESTED_RUN_MS = process.platform === "win32" ? 360000 : 120000

const inside = (child, parent) => !path.relative(parent, child).startsWith("..") && !path.isAbsolute(path.relative(parent, child))

test("HOME and every XDG folder point into this run's temporary folder, never the real home", () => {
  assert.equal(process.env.DESK_TEST_RUN_DIR, testRun.runDir)
  for (const name of ["HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) {
    assert.ok(inside(process.env[name], testRun.runDir), `${name}=${process.env[name]} is outside ${testRun.runDir}`)
    assert.equal(existsSync(process.env[name]), true)
  }
  assert.ok(inside(os.homedir(), testRun.runDir))
  assert.notEqual(path.resolve(os.homedir()), path.resolve(testRun.realHome))
})

test("Desk's default state and readiness folders resolve into the run's folder", () => {
  assert.ok(inside(resolveDeskStateDir(), testRun.runDir))
  assert.ok(inside(resolveReadinessStateHome(), testRun.runDir))
})

test("a write under the real home is refused in every fs form, and nothing is created", async () => {
  const probe = path.join(testRun.realHome, `.desk-test-isolation-probe-${process.pid}`)
  assert.equal(isRealHomeWrite(probe), true)
  assert.throws(() => writeFileSync(probe, "x"), { code: REAL_HOME_WRITE })
  assert.throws(() => mkdirSync(path.join(probe, "nested"), { recursive: true }), { code: REAL_HOME_WRITE })
  await assert.rejects(fsPromises.writeFile(probe, "x"), { code: REAL_HOME_WRITE })
  await assert.rejects(fsPromises.open(probe, "w"), { code: REAL_HOME_WRITE })
  const callbackError = await new Promise((resolve) => writeFile(probe, "x", resolve))
  assert.equal(callbackError?.code, REAL_HOME_WRITE)
  assert.equal(existsSync(probe), false)
})

test("writes under the temporary folders and reads anywhere still work", async () => {
  const root = await mkTempRoot("desk-test-isolation-")
  writeFileSync(path.join(root, "ok.txt"), "ok")
  assert.equal(isRealHomeWrite(path.join(root, "ok.txt")), false)
  assert.equal(isRealHomeWrite(path.join(os.homedir(), "state.json")), false)
  assert.equal(isRealHomeWrite(pathToFileURL(path.join(root, "ok.txt"))), false)
  assert.equal(isRealHomeWrite(Buffer.from(path.join(testRun.realHome, "x"))), true)
  assert.equal(isRealHomeWrite(3), false, "a file descriptor is not a path")
})

test("npm test and the coverage runner both preload the setup, so a test file that never imports it is isolated too", async () => {
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../plugins/desk/mcp")
  const pkg = JSON.parse(await fsPromises.readFile(path.join(mcpRoot, "package.json"), "utf8"))
  assert.match(pkg.scripts.test, /^node --import \.\.\/\.\.\/\.\.\/tests\/desk\/mcp\/__tests__\/_isolated_env\.mjs --test /u)
  assert.match(await fsPromises.readFile(path.join(mcpRoot, "src", "coverage", "runner.js"), "utf8"), /defaultTestRoot, "_isolated_env\.mjs"/u)
})

test("a factory test file run on its own with node --test never reads the machine's recorded factory consent", async () => {
  // A machine that contributes to a factory store has consent.json under its real state folder. boot_check.test.js reads
  // the default environment on purpose, so run alone without the preload it must still see its own temporary state.
  // The test file path below is relative to tests/desk/mcp, the folder that holds the tests.
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const machine = await mkTempRoot("desk-machine-home-")
  const consent = path.join(machine, ".local", "state", "ouroboros-skills", "desk", "factory", "consent.json")
  mkdirSync(path.dirname(consent), { recursive: true })
  writeFileSync(consent, JSON.stringify({ schema_version: 1, stores: { "ourostack/factory": { contribute: true, account: "machine-owner", decided_at: "2026-09-01T00:00:00.000Z" } } }))
  const env = { ...process.env, HOME: machine, USERPROFILE: machine, DESK_TEST_REAL_HOME: machine }
  for (const key of ["DESK_TEST_RUN_DIR", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "NODE_OPTIONS", "NODE_TEST_CONTEXT"]) delete env[key]
  const { spawnSync } = await import("node:child_process")
  const run = spawnSync(process.execPath, ["--test", path.join("__tests__", "factory", "boot_check.test.js")], { cwd: mcpRoot, env, encoding: "utf8", timeout: NESTED_RUN_MS })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.split("\n").filter((line) => /^not ok|expected|actual|Error/u.test(line)).join("\n"))
})

test("a factory test file with no isolation import at all is still refused from ever touching a non-temp state home, under a bare node --test", async () => {
  // _uninsulated_state_guard_fixture.fixture.js imports no isolation helper whatsoever and calls factoryStateRoot()
  // with the process's own, unmodified environment — the exact shape of the incident this guards against
  // (ourostack/desk, 2026-09-29: 34 evaluate-requests files recorded under a developer's real
  // ~/.local/state/ouroboros-skills/desk/factory/). Its own name deliberately does not end in .test.js, so `npm test`
  // and the coverage runner's own glob never pick it up as a normal suite member; it is only ever run explicitly,
  // here, standing in for a bare `node --test <file>` an agent ran directly. A fake HOME outside the OS temp
  // directory stands in for a real one, so this never touches this machine's actual home.
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const fakeReal = mkFakeRealRoot(`desk-fake-real-home-${process.pid}-`)
  try {
    const env = { ...process.env, HOME: fakeReal, USERPROFILE: fakeReal }
    for (const key of ["DESK_TEST_RUN_DIR", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "NODE_OPTIONS"]) delete env[key]
    const { spawnSync } = await import("node:child_process")
    const run = spawnSync(process.execPath, ["--test", path.join("__tests__", "factory", "_uninsulated_state_guard_fixture.fixture.js")], { cwd: mcpRoot, env, encoding: "utf8", timeout: NESTED_RUN_MS })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.split("\n").filter((line) => /^not ok|expected|actual|Error/u.test(line)).join("\n"))
    assert.equal(existsSync(path.join(fakeReal, ".local")), false, "the guard must refuse before creating anything under the fake real home")
  } finally {
    rmSync(fakeReal, { recursive: true, force: true })
  }
})

test("a tools test file run on its own with node --test never writes the machine's real factory state, even while driving a task to done/cancelled", async () => {
  // task_archive.test.js builds its own temp desk root (tools/_helpers.js's mkTempDeskRoot) and drives tasks to
  // `done`/`cancelled`, which requests both a finalize and a waste-evaluation record for the job
  // (tools/task.js's requestTaskTerminalSync). Those defaults to `env = process.env`, so run alone without the
  // preload the request must still land nowhere but its own temporary state, never the machine's real one — this
  // reproduces the exact shape of the leak this test guards against (ourostack/desk: 26 evaluate-requests files
  // recorded under a developer's real ~/.local/state/ouroboros-skills/desk/factory/, each naming a `desk-test-*`
  // fixture root as its desk_root).
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const machine = await mkTempRoot("desk-machine-home-")
  const factoryDir = path.join(machine, ".local", "state", "ouroboros-skills", "desk", "factory")
  // requestTaskFinalize/requestTaskEvaluation each check `factoryStateRoot(env, { create: false })` first and are a
  // no-op when it does not exist yet, so a "machine" with no prior factory state would pass this guard test
  // vacuously (nothing ever attempts a write) whether or not isolation held. Pre-create the folder, as a real
  // machine that has ever run a session with a consented store would have, so the write is actually attempted.
  mkdirSync(factoryDir, { recursive: true, mode: 0o700 })
  const env = { ...process.env, HOME: machine, USERPROFILE: machine, DESK_TEST_REAL_HOME: machine }
  for (const key of ["DESK_TEST_RUN_DIR", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "NODE_OPTIONS", "NODE_TEST_CONTEXT"]) delete env[key]
  const { spawnSync } = await import("node:child_process")
  const run = spawnSync(process.execPath, ["--test", path.join("__tests__", "tools", "task_archive.test.js")], { cwd: mcpRoot, env, encoding: "utf8", timeout: NESTED_RUN_MS })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.split("\n").filter((line) => /^not ok|expected|actual|Error/u.test(line)).join("\n"))
  const listing = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
  assert.deepEqual(listing(path.join(factoryDir, "finalize")), [], "task_archive's terminal-status transitions must never create real finalize requests under the machine's own home")
  assert.deepEqual(listing(path.join(factoryDir, "evaluate-requests")), [], "task_archive's terminal-status transitions must never create real evaluate-requests under the machine's own home")
})

test("sync-push.js, run directly with an inherited NODE_TEST_CONTEXT and a real (non-temp) HOME, degrades and exits 0 instead of crashing", async () => {
  // Fix round for PR #101 (review: CHANGES NEEDED). The reviewer's own reproduction: `env NODE_TEST_CONTEXT=1 node
  // plugins/desk/mcp/scripts/sync-push.js --root /tmp/x --debounce-ms 0` crashed with an uncaught throw from
  // acquireSyncLock, propagated through runPushWorker and the script's own top-level await. NODE_TEST_CONTEXT is
  // inherited by every child process of a `node --test` run, so a real session's detached push worker, launched
  // from inside any agent session that happens to be running under `node --test` (a coding-harness self-test, for
  // instance), would silently stop pushing with a crash nobody sees (`stdio: "ignore"` on the real spawn). This
  // spawns the actual script file, not just the exported function, so a regression in the one-line CLI wrapper
  // itself (script.js:10's own try/catch) would be caught here too.
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../plugins/desk/mcp")
  const fakeReal = mkFakeRealRoot(`desk-fake-real-home-syncpush-${process.pid}-`)
  try {
    const env = { ...process.env, HOME: fakeReal, USERPROFILE: fakeReal, NODE_TEST_CONTEXT: "1" }
    for (const key of ["DESK_TEST_RUN_DIR", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "NODE_OPTIONS"]) delete env[key]
    const { spawnSync } = await import("node:child_process")
    const run = spawnSync(
      process.execPath,
      [path.join(mcpRoot, "scripts", "sync-push.js"), "--root", "/tmp/desk-test-isolation-sync-push-root", "--debounce-ms", "0"],
      { cwd: mcpRoot, env, encoding: "utf8", timeout: 120000 },
    )
    assert.equal(run.status, 0, `expected a clean exit, got:\n${run.stdout}\n${run.stderr}`)
    assert.doesNotMatch(run.stderr, /Uncaught|throw new Error|at acquireSyncLock|at runPushWorker/u, "must degrade, not crash with a stack trace")
    assert.match(run.stderr, /test_isolation_refused|DESK_TEST_REAL_STATE/u, "the refusal must be visible, not silent")
    assert.equal(existsSync(path.join(fakeReal, ".local")), false, "the guard must refuse before creating anything under the fake real home")
  } finally {
    rmSync(fakeReal, { recursive: true, force: true })
  }
})

test("sync-push.js's own top-level catch reports a genuine failure and exits 1, instead of an uncaught stack trace", async () => {
  // Ruling (c)'s backstop, exercised for a failure the guard fix does not itself remove: runSyncPushCli still throws
  // synchronously when --root is missing (argument validation, not the test-isolation guard), so this is the one
  // remaining live path through sync-push.js's own try/catch. Deliberately does NOT touch HOME/NODE_OPTIONS -- this
  // failure has nothing to do with test isolation, and leaving the environment untouched keeps this runnable in
  // whatever environment (instrumented or not) spawns it.
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../plugins/desk/mcp")
  const { spawnSync } = await import("node:child_process")
  const run = spawnSync(
    process.execPath,
    [path.join(mcpRoot, "scripts", "sync-push.js")],
    { cwd: mcpRoot, encoding: "utf8", timeout: 120000 },
  )
  assert.equal(run.status, 1)
  assert.doesNotMatch(run.stderr, /Uncaught|at runSyncPushCli/u, "must degrade to a clean message, not an uncaught stack trace")
  assert.match(run.stderr, /sync-push\.js:.*--root <path> is required/u)
})
