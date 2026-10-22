import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, truncate } from "node:fs/promises"
import { join } from "node:path"
import {
  factoryStateRoot, listTaskContextJobs, readTaskContextFile, serializeTaskContext,
  taskContextPath, updateTaskContextState, writeTaskContextFile,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { scratch, STORE } from "./_session_helpers.js"

const JOB = "a".repeat(32)

test("private context reads enforce the actual file size before reading oversized bytes", () => scratch(async ({ env }) => {
  const name = "0123456789abcdef.candidate.json"
  const file = await writeTaskContextFile(env, STORE, JOB, name, { safe: true })
  assert.equal((await readTaskContextFile(env, STORE, JOB, name)).toString("utf8"), serializeTaskContext({ safe: true }))
  await truncate(file, 16 * 1024 * 1024 + 1)
  await assert.rejects(readTaskContextFile(env, STORE, JOB, name), /context file is too large/u)
}))

test("private state updates refuse nonobjects and oversized results without committing partial state", () => scratch(async ({ env }) => {
  await assert.rejects(updateTaskContextState(env, STORE, JOB, () => []), /record/u)
  await assert.rejects(updateTaskContextState(env, STORE, JOB, () => ({ value: "x".repeat(512 * 1024) })), /context state is too large/u)
  assert.deepEqual(await updateTaskContextState(env, STORE, JOB, (before) => {
    assert.equal(before, null)
    return { phase: "candidate" }
  }), { phase: "candidate" })
}))

test("private context paths admit only exact job and protocol filenames", () => scratch(async ({ env }) => {
  await assert.rejects(taskContextPath(env, STORE, "../job", "state.json"), /job/u)
  for (const name of ["../state.json", "other.json", "0123456789abcdef.output.json"]) {
    await assert.rejects(taskContextPath(env, STORE, JOB, name), /name/u)
  }
  assert.equal(await readTaskContextFile(env, STORE, JOB, "state.json"), null)
}))

test("job discovery ignores unrelated local names and retains stable valid job ordering", () => scratch(async ({ env }) => {
  await writeTaskContextFile(env, STORE, "f".repeat(32), "state.json", {})
  await writeTaskContextFile(env, STORE, JOB, "discovery.json", {})
  const root = await factoryStateRoot(env)
  await mkdir(join(root, "task-context", "ourostack__factory", "notes"))
  assert.deepEqual(await listTaskContextJobs(env, STORE), [JOB, "f".repeat(32)])
}))
