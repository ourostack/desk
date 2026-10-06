// desk_save is Desk's commit path, so the desk's pre-commit hook trusts it; it must therefore never commit a task card (round 12).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"

test("desk_save refuses a live task card path, and still takes a card's other files", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-save-card-")))
  try {
    mkdirSync(path.join(root, "t", "s"), { recursive: true })
    writeFileSync(path.join(root, "t", "s", "task.md"), "x")
    await assert.rejects(desk_save({ deskRoot: root, input: { paths: ["t/s/task.md"], message: "m" }, spawnGit: () => assert.fail("no git call") }), /remove t\/s\/task\.md from .paths. and write the task card with task_update/u)
    await assert.rejects(desk_save({ deskRoot: root, input: { paths: ["./t/s/TASK.md"], message: "m" } }), /write the task card with task_update/u)
    const calls = []
    const result = await desk_save({ deskRoot: root, input: { paths: ["t/s/notes.md"], message: "m" }, spawnGit: (...args) => (calls.push(args), { status: 1, stdout: "", stderr: "" }) })
    assert.equal(result.status, "nothing_to_commit")
    assert.ok(calls.length > 0, "a non-card path goes on to git")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
