import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { factoryStateRoot, listFinalizeRequests } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { scratch } from "./_session_helpers.js"

// task_update's evidence gate (the invented-completion finding) only fires on the
// transition into `done`; these fixture calls carry it so the `done` half
// of each `[done, cancelled]` pair still exercises the finalize/evaluation
// path it's actually testing, not the evidence gate itself.
const DONE_EVIDENCE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/1" }

for (const status of ["done", "cancelled"]) {
  test(`task_update to ${status} queues the same local job used by binding`, () => scratch(async ({ desk, env }) => {
    await factoryStateRoot(env)
    await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
    const result = await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status }, ...(status === "done" ? { evidence: DONE_EVIDENCE } : {}) } })
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

test("a completed task renamed outside the tools still queues the job at its birth path (ourostack/desk#76)", () => scratch(async ({ desk, env }) => {
  await factoryStateRoot(env)
  const git = (...args) => execFileSync("git", args, { cwd: desk, encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  // task_create commits the new card itself (M4-6 Part 2), so there is
  // nothing left to add or commit here.
  await task_create({ deskRoot: desk, input: { track: "track", slug: "origin-slug", title: "fixture" } })
  // A rename made outside the task tools (an editor, `git mv`, a track rename): the card moves, but its identity should not.
  await fs.rename(path.join(desk, "track", "origin-slug"), path.join(desk, "track", "renamed-slug"))
  git("add", "-A")
  git("commit", "-q", "-m", "rename the task")
  const result = await task_update({ deskRoot: desk, env, input: { track: "track", slug: "renamed-slug", frontmatter: { status: "done" }, evidence: DONE_EVIDENCE } })
  assert.equal(result.status, "updated")
  const [request] = await listFinalizeRequests(env)
  assert.ok(request, "completion must leave a finalize request")
  assert.equal(request.job, jobId({ deskRemote: `local:${desk}`, personPrefix: "", track: "track", slug: "origin-slug" }), "the queued job is the task's birth path, not the renamed one")
}))

test("no factory state is created by completion; unavailable factory state never fails a task update", () => scratch(async ({ desk, env }) => {
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
  const options = { deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status: "done" }, evidence: DONE_EVIDENCE } }
  assert.equal((await task_update(options)).status, "updated")
  await assert.rejects(fs.stat(env.XDG_STATE_HOME), { code: "ENOENT" })
  await fs.mkdir(env.XDG_STATE_HOME, { recursive: true })
  await fs.writeFile(path.join(env.XDG_STATE_HOME, "ouroboros-skills"), "unsafe")
  assert.equal((await task_update(options)).status, "updated")
}))
