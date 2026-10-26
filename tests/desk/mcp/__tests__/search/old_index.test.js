import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { removeOldIndex, runCommand } from "../../../../../plugins/desk/mcp/src/search/old-index.js"
import { mkTempRoot } from "../_temp_roots.js"

async function stateWithOldIndex() {
  const stateDir = path.join(await mkTempRoot("desk-old-index-"), ".state")
  mkdirSync(stateDir, { recursive: true })
  for (const name of ["desk-index.sqlite", "desk-index.sqlite-wal", "desk-index.sqlite-shm", "desk-index.sqlite.corrupt-17", "desk-vectors.sqlite"]) {
    writeFileSync(path.join(stateDir, name), "x".repeat(1000))
  }
  return stateDir
}

const lsof = (result) => async (command, args) => {
  assert.equal(command, "lsof")
  assert.deepEqual(args.slice(0, 2), ["-t", "--"])
  return result
}

test("the old index is removed when no process has it open, and the new vectors file is kept", async () => {
  const stateDir = await stateWithOldIndex()
  assert.deepEqual(await removeOldIndex(stateDir, { platform: "darwin", run: lsof({ status: 1, stdout: "" }) }), { removed: true, bytes: 4000 })
  assert.deepEqual(readdirSync(stateDir), ["desk-vectors.sqlite"])
})

test("the old index is kept while a process has it open, or when that cannot be checked", async () => {
  const stateDir = await stateWithOldIndex()
  for (const result of [{ status: 0, stdout: "4242\n" }, { error: new Error("spawn lsof ENOENT"), status: null, stdout: "" }]) {
    assert.deepEqual(await removeOldIndex(stateDir, { platform: "linux", run: lsof(result) }), { removed: false, bytes: 0 })
  }
  assert.equal(readdirSync(stateDir).length, 5)
})

test("on Windows the deletion itself is the check, and a file that cannot be deleted is left for the next start", async () => {
  const stateDir = await stateWithOldIndex()
  // A folder under the old index's name cannot be deleted as a file, as a file another process holds open cannot be on Windows.
  mkdirSync(path.join(stateDir, "desk-index.sqlite.corrupt-18"))
  const result = await removeOldIndex(stateDir, { platform: "win32", run: () => assert.fail("no lsof on Windows") })
  assert.deepEqual(result, { removed: true, bytes: 4000 })
  assert.ok(existsSync(path.join(stateDir, "desk-index.sqlite.corrupt-18")))
})

test("a desk with no old index, or no state folder, has nothing to remove", async () => {
  const root = await mkTempRoot("desk-old-index-")
  assert.deepEqual(await removeOldIndex(path.join(root, "missing")), { removed: false, bytes: 0 })
  assert.deepEqual(await removeOldIndex(root, { run: () => assert.fail("nothing to check") }), { removed: false, bytes: 0 })
})

test("runCommand reports a command's exit status and output, or why it could not run", async () => {
  assert.deepEqual(await runCommand(process.execPath, ["-e", "process.stdout.write('4242')"]), { status: 0, stdout: "4242" })
  assert.deepEqual(await runCommand(process.execPath, ["-e", "process.exit(1)"]), { status: 1, stdout: "" })
  const missing = await runCommand(path.join(path.dirname(process.execPath), "no-such-command-desk"), [])
  assert.equal(missing.error.code, "ENOENT")
})
