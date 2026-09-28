import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { factoryStateRoot, listFinalizeRequests } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { scratch } from "./_session_helpers.js"

for (const status of ["done", "cancelled"]) {
  test(`task_update to ${status} queues the same local job used by binding`, () => scratch(async ({ desk, env }) => {
    await factoryStateRoot(env)
    await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
    const result = await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status } } })
    assert.equal(result.status, "updated")
    const [request] = await listFinalizeRequests(env)
    assert.ok(request, "completion must leave a finalize request")
    assert.equal(request.job, jobId({ deskRemote: `local:${desk}`, personPrefix: "", track: "track", slug: "finished-work" }))
    assert.equal(request.desk_root, desk)
  }))
}

test("task archive queues one job, including repeat archive and person scoping", () => scratch(async ({ desk, env }) => {
  await factoryStateRoot(env)
  await task_create({ deskRoot: desk, person: "alice", input: { track: "track", slug: "finished-work", title: "fixture" } })
  for (const expected of ["archived", "already_archived"]) {
    assert.equal((await task_archive({ deskRoot: desk, env, person: "alice", input: { track: "track", slug: "finished-work" } })).status, expected)
    const [request] = await listFinalizeRequests(env)
    assert.ok(request)
    assert.equal(request.job, jobId({ deskRemote: `local:${desk}`, personPrefix: "desks/alice", track: "track", slug: "finished-work" }))
  }
}))

test("no factory state is created by completion; unavailable factory state never fails a task update", () => scratch(async ({ desk, env }) => {
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
  const options = { deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status: "done" } } }
  assert.equal((await task_update(options)).status, "updated")
  await assert.rejects(fs.stat(env.XDG_STATE_HOME), { code: "ENOENT" })
  await fs.mkdir(env.XDG_STATE_HOME, { recursive: true })
  await fs.writeFile(path.join(env.XDG_STATE_HOME, "ouroboros-skills"), "unsafe")
  assert.equal((await task_update(options)).status, "updated")
}))
