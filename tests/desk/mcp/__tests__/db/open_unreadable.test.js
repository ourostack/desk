// An index database that is not a database fails openDb on its first pragma. The failed call must not leave the file open: the readiness controller moves a corrupt index aside and rebuilds it, and Windows refuses to rename a file that still has an open handle.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { mkdirSync, renameSync, writeFileSync, existsSync } from "node:fs"
import { openDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { mkTempRoot } from "../_temp_roots.js"

test("openDb on a truncated database throws and leaves the file free to move aside", async () => {
  const root = await mkTempRoot("desk-open-unreadable-")
  const dbPath = path.join(root, ".state", "desk-index.sqlite")
  mkdirSync(path.dirname(dbPath), { recursive: true })
  writeFileSync(dbPath, "SQLite format 3\u0000truncated")
  assert.throws(() => openDb(root, { dbPath }), (error) => error?.code === "SQLITE_NOTADB" || error?.code === "SQLITE_CORRUPT")
  const target = `${dbPath}.corrupt-1`
  renameSync(dbPath, target)
  assert.equal(existsSync(target), true)
  assert.equal(existsSync(dbPath), false)
})
