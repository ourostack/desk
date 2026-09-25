// In-place recovery: fix the injected condition while Desk runs, and desk_status reaches ready with no restart and an unchanged tool list.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { git, makeGitDesk, readLastStart, settled, startDesk, writeActivation, writeFile } from "./_admission_fixtures.js"

async function waitFor(predicate, { deadlineMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error("condition not reached in time")
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

test("a missing root recovers in place once the desk appears: ready, same tool list, a write lands", async (t) => {
  const fixture = await makeGitDesk()
  const pending = path.join(fixture.root, "later-desk")
  const configPath = writeActivation({ ...fixture, desk: pending })
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--root", pending] })
  t.after(() => session.close())
  const before = session.tools.result.tools
  const degraded = await session.statusUntil(settled)
  assert.equal(degraded.state, "degraded:root_unavailable")
  git(fixture.root, "clone", fixture.origin, pending)
  const ready = await session.statusUntil((payload) => payload.state === "ready")
  assert.equal(ready.status, "ok")
  assert.equal(ready.admission.state, "ready")
  const after = await session.request("tools/list")
  assert.deepEqual(after.result.tools, before)
  const write = await session.call("task_create", { track: "ops", slug: "recovered-write-check", title: "After recovery" })
  assert.equal(write.isError, false, JSON.stringify(write.payload))
  assert.equal(existsSync(path.join(pending, "ops", "recovered-write-check", "task.md")), true)
  assert.equal(readLastStart(fixture).state, "ready")
})

test("a malformed activation config recovers in place once it is fixed", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = path.join(fixture.root, "fixable.activation.json")
  writeFile(configPath, "{not json")
  const session = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => session.close())
  assert.equal((await session.statusUntil(settled)).state, "degraded:activation_config_invalid")
  writeActivation(fixture)
  writeFile(configPath, readFileSync(path.join(fixture.root, "desk.activation.json"), "utf8"))
  assert.equal((await session.statusUntil((payload) => payload.state === "ready")).state, "ready")
})

test("a detached HEAD with a local-only commit recovers once the commit is pushed: repaired, then ready", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "checkout", "--detach")
  writeFile(path.join(fixture.desk, "ops", "rescue.md"), "rescue\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "local work")
  const sha = git(fixture.desk, "rev-parse", "HEAD")
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] })
  t.after(() => session.close())
  const before = session.tools.result.tools
  const degraded = await session.statusUntil(settled)
  assert.equal(degraded.state, "degraded:state_branch_detached")
  // What the fix tells the agent to do: keep the commit on a pushed branch.
  git(fixture.desk, "push", "origin", "HEAD:refs/heads/rescue-work")
  const ready = await session.statusUntil((payload) => payload.state === "ready")
  assert.equal(ready.repair, `repaired: detached HEAD → main (was ${sha.slice(0, 12)})`)
  assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "main")
  assert.deepEqual((await session.request("tools/list")).result.tools, before)
})

test("a HEAD change is noticed without a tool call: the .git/HEAD watch re-runs admission", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] })
  t.after(() => session.close())
  assert.equal((await session.statusUntil(settled)).state, "ready")
  git(fixture.desk, "checkout", "--detach")
  writeFile(path.join(fixture.desk, "ops", "unpushed.md"), "unpushed\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "unpushed")
  // No desk_status call: only the watch can move the recorded state.
  await waitFor(() => existsSync(path.join(fixture.stateDir, "last-start.json")) && readLastStart(fixture).state === "degraded:state_branch_detached")
  git(fixture.desk, "switch", "main")
  await waitFor(() => readLastStart(fixture).state === "ready")
})

test("a lost readiness controller is re-elected in the background by the surviving session", { skip: process.platform === "win32" ? "POSIX signals" : false }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  mkdirSync(fixture.stateDir, { recursive: true })
  const first = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => first.close())
  assert.equal((await first.statusUntil(settled)).state, "ready")
  const second = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => second.close())
  assert.equal((await second.statusUntil(settled)).state, "ready")
  // The first session owns the controller; kill it the way a closed host session would.
  first.child.kill("SIGKILL")
  await new Promise((resolve) => first.child.once("exit", resolve))
  const search = await second.call("desk_search", { query: "lighthouse" })
  assert.equal(search.isError, false)
  const write = await second.call("task_create", { track: "ops", slug: "after-owner-loss", title: "Survivor write" })
  assert.equal(write.isError, false, JSON.stringify(write.payload))
  assert.equal((await second.statusUntil((payload) => payload.state === "ready")).readiness.state !== "unavailable", true)
})
