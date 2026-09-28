// On the transition to `done`, the task tools also record the job's waste-
// evaluator request (`evaluate-requests/<job>.json`), the same way and on
// the same opt-in gate as the finalize request they already write (issue
// #77): a failure here must never fail the task update, and `cancelled`
// requests no evaluation (evaluate-run.js's brief and request are
// consistently the "done step"; only `done` has a finished job to label).

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { task_archive, task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { factoryStateRoot, listEvaluationRequests, listFinalizeRequests } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { scratch } from "./_session_helpers.js"

test("task_update to done queues an evaluation request alongside the finalize request", () => scratch(async ({ desk, env }) => {
  await factoryStateRoot(env)
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
  const result = await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status: "done" } } })
  assert.equal(result.status, "updated")
  const [request] = await listEvaluationRequests(env)
  assert.ok(request, "done must leave an evaluation request")
  assert.equal(request.job, jobId({ deskRemote: `local:${desk}`, personPrefix: "", track: "track", slug: "finished-work" }))
  assert.equal(request.desk_root, desk)
  assert.equal((await listFinalizeRequests(env)).length, 1, "the finalize request still fires too")
}))

test("task_update to cancelled queues no evaluation request, but still queues the finalize request", () => scratch(async ({ desk, env }) => {
  await factoryStateRoot(env)
  await task_create({ deskRoot: desk, input: { track: "track", slug: "abandoned-work", title: "fixture" } })
  const result = await task_update({ deskRoot: desk, env, input: { track: "track", slug: "abandoned-work", frontmatter: { status: "cancelled" } } })
  assert.equal(result.status, "updated")
  assert.equal((await listEvaluationRequests(env)).length, 0, "cancelled must not queue an evaluation request")
  assert.equal((await listFinalizeRequests(env)).length, 1, "cancelled still queues the finalize request")
}))

for (const status of ["drafting", "processing", "validating", "collaborating", "paused", "blocked"]) {
  test(`task_update to ${status} queues no evaluation request and no finalize request`, () => scratch(async ({ desk, env }) => {
    await factoryStateRoot(env)
    await task_create({ deskRoot: desk, input: { track: "track", slug: "in-flight", title: "fixture" } })
    const result = await task_update({ deskRoot: desk, env, input: { track: "track", slug: "in-flight", frontmatter: { status } } })
    assert.equal(result.status, "updated")
    assert.equal((await listEvaluationRequests(env)).length, 0, `${status} must not queue an evaluation request`)
    assert.equal((await listFinalizeRequests(env)).length, 0, `${status} is not terminal and must not queue a finalize request either`)
  }))
}

test("archiving an in-flight task forces it to done and queues one evaluation request, including repeat archive and person scoping", () => scratch(async ({ desk, env }) => {
  await factoryStateRoot(env)
  await task_create({ deskRoot: desk, person: "alice", input: { track: "track", slug: "finished-work", title: "fixture" } })
  for (const expected of ["archived", "already_archived"]) {
    assert.equal((await task_archive({ deskRoot: desk, env, person: "alice", input: { track: "track", slug: "finished-work" } })).status, expected)
    const [request] = await listEvaluationRequests(env)
    assert.ok(request, `${expected} must leave an evaluation request`)
    assert.equal(request.job, jobId({ deskRemote: `local:${desk}`, personPrefix: "desks/alice", track: "track", slug: "finished-work" }))
  }
}))

test("archiving an already-cancelled task queues no evaluation request, but still queues the finalize request", () => scratch(async ({ desk, env }) => {
  await factoryStateRoot(env)
  await task_create({ deskRoot: desk, input: { track: "track", slug: "abandoned-work", title: "fixture", status: "cancelled" } })
  assert.equal((await task_archive({ deskRoot: desk, env, input: { track: "track", slug: "abandoned-work" } })).status, "archived")
  assert.equal((await listEvaluationRequests(env)).length, 0)
  assert.equal((await listFinalizeRequests(env)).length, 1)
}))

test("re-archiving with the archived task.md gone requests no evaluation and does not fail", () => scratch(async ({ desk, env }) => {
  await factoryStateRoot(env)
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
  assert.equal((await task_archive({ deskRoot: desk, env, input: { track: "track", slug: "finished-work" } })).status, "archived")
  await fs.rm(path.join(desk, "track", "_archive", "finished-work", "task.md"))
  await fs.rm(path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory", "evaluate-requests"), { recursive: true, force: true })
  const result = await task_archive({ deskRoot: desk, env, input: { track: "track", slug: "finished-work" } })
  assert.equal(result.status, "already_archived")
  assert.equal((await listEvaluationRequests(env)).length, 0, "an unreadable archived status must not be treated as done")
}))

test("no factory state is created by completion; unavailable factory state never fails an evaluation request", () => scratch(async ({ desk, env }) => {
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
  const options = { deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status: "done" } } }
  assert.equal((await task_update(options)).status, "updated")
  await assert.rejects(fs.stat(env.XDG_STATE_HOME), { code: "ENOENT" }, "completion alone must never create factory state")
  await fs.mkdir(env.XDG_STATE_HOME, { recursive: true })
  await fs.writeFile(path.join(env.XDG_STATE_HOME, "ouroboros-skills"), "unsafe")
  assert.equal((await task_update(options)).status, "updated", "a corrupt factory state must never fail the task update")
}))
