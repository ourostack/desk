import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { desk_reindex } from "../../src/tools/reindex.js"
import { indexDbPath, openDb, closeDb } from "../../src/db/init.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { connectOrStartController } from "../../src/readiness/controller-client.js"
import { mkTempDeskRoot, writeFile } from "./_search_helpers.js"

test("alpha reindex without a controller refuses mutation even with force", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "track/work/task.md", "quartz")
  await rebuildIndex(root, { skipEmbed: true })
  const before = await fs.readFile(indexDbPath(root))
  const result = await desk_reindex({ deskRoot: root, input: { force: true } })
  assert.equal(result.code, "required_capability_unavailable")
  assert.deepEqual(await fs.readFile(indexDbPath(root)), before)
})

test("alpha reindex and force refresh through the controller without dropping generations", async (t) => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "track/work/task.md", "before")
  const controller = await connectOrStartController({
    root, stateHome: path.join(root, ".state", "controller"), ephemeral: true,
    handlers: { async beginConvergence({ eventCursor }) {
      return { summary: await rebuildIndex(root, { skipEmbed: true, eventCursor }) }
    } },
  })
  t.after(() => controller.close())
  const first = await desk_reindex({ deskRoot: root, readiness: controller })
  assert.equal(first.status, "ok")
  assert.equal(first.action, "controller_convergence")
  await writeFile(root, "track/work/task.md", "after")
  const second = await desk_reindex({ deskRoot: root, readiness: controller, input: { force: true } })
  assert.equal(second.status, "ok")
  const db = openDb(root)
  try {
    assert.equal(db.prepare("SELECT text FROM chunks").get().text, "after")
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lexical_generations").get().n, 2)
  } finally { closeDb(db) }
})

test("alpha reindex exposes controller failure rather than success-shaped counts", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(desk_reindex({
    deskRoot: root,
    readiness: { beginConvergence: async () => { throw new Error("journal failed") } },
  }), /journal failed/)
  await assert.rejects(fs.stat(path.join(root, ".state")), { code: "ENOENT" })
})

test("alpha reindex cannot report success when the controller finishes without current readiness", async () => {
  const result = await desk_reindex({
    readiness: {
      beginConvergence: async () => ({ accepted: true }),
      barrier: async () => ({ capability: "lexical", current: false, state: "RECOVERING" }),
    },
  })
  assert.equal(result.status, "error")
  assert.equal(result.code, "required_capability_unavailable")
})
