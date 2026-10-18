// Diagnostic branch only: the original eight criteria and deadlines are unchanged.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { moveOwnedDirectory } from "./_windows_archive_move.cjs"

process.env.DESK_TEST_ARCHIVE_MOVE_NATIVE = "directory_move"
await import("./archive_handoff_qualification.test.js")

test("the actual native candidate refuses an occupied directory without changing either payload",
  { skip:process.platform !== "win32", timeout:15000 }, async () => {
    const root = await mkTempRoot("desk-native-move-occupied-")
    const source = path.join(root, "source"), destination = path.join(root, "destination")
    await fs.mkdir(source)
    await fs.mkdir(destination)
    await fs.writeFile(path.join(source, "payload"), "owned source\n")
    await fs.writeFile(path.join(destination, "payload"), "owned destination\n")
    await assert.rejects(moveOwnedDirectory(source, destination), error => {
      assert.equal(error.code, "OWNED_NATIVE_MOVE_REFUSED")
      assert.equal(error.nativeMove.result.moved, false)
      assert.equal(error.nativeMove.closed, true)
      assert.equal(error.nativeMove.forced, false)
      return true
    })
    assert.equal(await fs.readFile(path.join(source, "payload"), "utf8"), "owned source\n")
    assert.equal(await fs.readFile(path.join(destination, "payload"), "utf8"), "owned destination\n")
  })
