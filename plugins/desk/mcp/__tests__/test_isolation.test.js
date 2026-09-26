// Guard for the global test setup (_isolated_env.mjs): every test process runs under a temporary HOME and XDG folders, Desk's default state paths resolve there, and a write under the real home fails.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, promises as fsPromises, writeFile, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { REAL_HOME_WRITE, isRealHomeWrite, testRun } from "./_isolated_env.mjs"
import { mkTempRoot } from "./_temp_roots.js"
import { resolveDeskStateDir, resolveReadinessStateHome } from "../src/runtime/last-start.js"

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
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const pkg = JSON.parse(await fsPromises.readFile(path.join(mcpRoot, "package.json"), "utf8"))
  assert.match(pkg.scripts.test, /^node --import \.\/__tests__\/_isolated_env\.mjs --test /u)
  assert.match(await fsPromises.readFile(path.join(mcpRoot, "src", "coverage", "runner.js"), "utf8"), /"__tests__", "_isolated_env\.mjs"/u)
})
