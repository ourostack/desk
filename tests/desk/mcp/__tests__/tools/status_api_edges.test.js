import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"
import { closeDb, indexDbPath, openDb, setMeta } from "../../../../../plugins/desk/mcp/src/db/init.js"

test("status's direct API defaults its context without provisioning missing state", async (t) => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "status-default-context-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const body = await desk_status({ deskRoot: root })
  assert.equal(body.status, "ok")
  assert.equal(body.root.path, root)
  assert.deepEqual(body.write_scope, { mode: "workspace", person: null, relative_path: "." })
  assert.equal(existsSync(indexDbPath(root)), false)
  assert.deepEqual(readdirSync(root), [])
})
