import { test } from "node:test"
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveSuperpowersContext } from "../../src/activation/superpowers-context.js"

test("context preserves a canonical task stat error after successful root validation without changing files", async (t) => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "superpowers-canonical-stat-"))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const deskRoot = path.join(base, "desk")
  const taskPath = path.join(deskRoot, "task")
  const iterationPath = path.join(taskPath, "iteration")
  const taskCard = path.join(taskPath, "task.md")
  const planPath = path.join(iterationPath, "planning.md")
  const progressPath = path.join(iterationPath, "doing.md")
  const evidenceRoot = path.join(base, "evidence")
  const canonical = [[taskCard, "task\n"], [planPath, "plan\n"], [progressPath, "progress\n"]]
  await fs.mkdir(iterationPath, { recursive: true })
  for (const [file, content] of canonical) await fs.writeFile(file, content)

  const failure = Object.assign(new Error("fixture canonical task stat denied"), { code: "EACCES" })
  const originalStat = fs.stat
  const observed = []
  t.mock.method(fs, "stat", async (candidate, ...options) => {
    observed.push(candidate)
    if (candidate === taskCard) throw failure
    return originalStat(candidate, ...options)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      resolveSuperpowersContext({ deskRoot, taskPath, iterationPath, planPath, evidenceRoot, step: 1, attempt: 1 }),
      (error) => error === failure,
    )
    assert.deepEqual(observed, [deskRoot, taskCard], "the failure must occur at canonical-file stat, not the preceding root stat")
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  for (const [file, content] of canonical) assert.equal(await fs.readFile(file, "utf8"), content)
  assert.deepEqual(await fs.readdir(base), ["desk"])
  assert.deepEqual(await fs.readdir(deskRoot), ["task"])
  assert.deepEqual((await fs.readdir(taskPath)).sort(), ["iteration", "task.md"])
  assert.deepEqual((await fs.readdir(iterationPath)).sort(), ["doing.md", "planning.md"])
})

test("default progress selection surfaces a permission error instead of silently falling back to the task card", async (t) => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "superpowers-default-progress-"))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const deskRoot = path.join(base, "desk")
  const taskPath = path.join(deskRoot, "task")
  const iterationPath = path.join(taskPath, "iteration")
  const taskCard = path.join(taskPath, "task.md")
  const progressPath = path.join(iterationPath, "doing.md")
  const evidenceRoot = path.join(base, "evidence")
  await fs.mkdir(iterationPath, { recursive: true })
  await fs.writeFile(taskCard, "task\n")
  await fs.writeFile(progressPath, "progress\n")

  const failure = Object.assign(new Error("fixture default progress stat denied"), { code: "EACCES" })
  const originalStat = fs.stat
  t.mock.method(fs, "stat", async (candidate, ...options) => {
    if (candidate === progressPath) throw failure
    return originalStat(candidate, ...options)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      resolveSuperpowersContext({ deskRoot, taskPath, iterationPath, evidenceRoot, step: 1, attempt: 1 }),
      (error) => error === failure,
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.deepEqual((await fs.readdir(taskPath)).sort(), ["iteration", "task.md"])
  assert.deepEqual(await fs.readdir(iterationPath), ["doing.md"])
})

test("an absent iteration progress record falls back to the canonical task card without creating either", async (t) => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "superpowers-task-card-only-"))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const deskRoot = path.join(base, "desk")
  const taskPath = path.join(deskRoot, "task")
  const iterationPath = path.join(taskPath, "iteration")
  const taskCard = path.join(taskPath, "task.md")
  await fs.mkdir(iterationPath, { recursive: true })
  await fs.writeFile(taskCard, "task\n")

  const output = await resolveSuperpowersContext({
    deskRoot,
    taskPath,
    iterationPath,
    evidenceRoot: path.join(base, "evidence"),
    step: 1,
    attempt: 1,
  })
  assert.equal(output.planPath, null)
  assert.equal(output.progressPath, taskCard)
  assert.equal(output.rulingsPath, taskCard)
  assert.deepEqual(await fs.readdir(iterationPath), [])
  assert.deepEqual(await fs.readdir(base), ["desk"])
})
