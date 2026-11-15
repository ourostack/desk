import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { task_update, task_create } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { taskFocus } from "../../../../../plugins/desk/mcp/src/tools/task-focus.js"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { drainAppendLanes, pendingCount, flushAppends } from "../../../../../plugins/desk/mcp/src/runtime/append-lane.js"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"

const POLICY = {
  schema_version: 1,
  mode: "declared-purpose",
  repository: "sample/context",
  context_purposes: ["coordination", "metadata"],
  product_purposes: ["product-contract"],
}
const CARD = "---\nschema_version: 1\ntitle: Work\nstatus: processing\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Work\n\n**Next step:** Keep going.\n"
const git = (root, args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`)
  return result.stdout.trim()
}
async function fixture(t, { policy = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-task-log-"))
  t.after(async () => {
    await drainAppendLanes()
    await fs.rm(root, { recursive: true, force: true })
  })
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["config", "user.email", "test@example.com"])
  await fs.mkdir(path.join(root, "track/work"), { recursive: true })
  await fs.writeFile(path.join(root, "track/work/task.md"), CARD)
  if (policy) {
    await fs.mkdir(path.join(root, ".desk"))
    await fs.writeFile(path.join(root, ".desk/content-home.json"), JSON.stringify(POLICY))
  }
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Published"])
  git(root, ["remote", "add", "origin", "https://github.com/sample/context.git"])
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"])
  git(root, ["config", "branch.main.remote", "origin"])
  git(root, ["config", "branch.main.merge", "refs/heads/main"])
  return root
}
const commits = (root) => Number(git(root, ["rev-list", "--count", "HEAD"]))
const content_home = { purpose: "coordination", lifecycle: "current" }
const call = (root, input, extra = {}) => task_update({ deskRoot: root, input: { track: "track", slug: "work", ...input }, schedulePush() {}, ...extra })

test("ten rapid log entries are one commit and one push, and every reader sees each at once", async (t) => {
  const root = await fixture(t)
  const before = commits(root)
  let pushes = 0
  for (let i = 0; i < 10; i += 1) {
    const answer = await call(root, { log: `Ruling ${i}: keep it cheap.` }, { schedulePush: () => { pushes += 1 }, appendLane: { quietMs: 600_000, maxWaitMs: 600_000 } })
    assert.equal(answer.status, "logged")
    assert.equal(answer.path, "track/work/log.md")
    assert.match(await fs.readFile(path.join(root, "track/work/log.md"), "utf8"), new RegExp(`Ruling ${i}:`, "u"))
  }
  assert.equal(commits(root), before)
  assert.equal(pendingCount(root), 1)
  await drainAppendLanes()
  assert.equal(commits(root), before + 1)
  assert.equal(pushes, 1)
  assert.equal(git(root, ["status", "--porcelain"]), "")
  const text = await fs.readFile(path.join(root, "track/work/log.md"), "utf8")
  assert.equal(text.match(/^# Log: track\/work$/gmu).length, 1)
  assert.equal(text.match(/^## \d{4}-\d\d-\d\d \d\d:\d\d$/gmu).length, 10)
})

test("a log entry waits no longer than the window for its commit", async (t) => {
  const root = await fixture(t)
  const before = commits(root)
  await call(root, { log: "One." }, { appendLane: { quietMs: 30, maxWaitMs: 100 } })
  for (let waited = 0; commits(root) === before && waited < 60_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(commits(root), before + 1)
  assert.equal(pendingCount(root), 0)
})

test("a log entry rides with the rest of the call and the card keeps its own commit", async (t) => {
  const root = await fixture(t)
  const answer = await call(root, { log: "Ruling: ship it.", note: "Shipped." })
  assert.equal(answer.status, "updated")
  assert.deepEqual(answer.log, { path: "track/work/log.md", commit: "queued" })
  assert.match(git(root, ["log", "-1", "--format=%s"]), /task_update: track\/work/u)
  await drainAppendLanes()
  assert.match(git(root, ["log", "-1", "--format=%s"]), /task_update: log track\/work/u)
})

test("a log entry needs a task and a non-empty entry", async (t) => {
  const root = await fixture(t)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "track", slug: "absent", log: "x" }, schedulePush() {} }), /task does not exist/u)
  await assert.rejects(call(root, { log: "  " }), /non-empty string/u)
  assert.equal(pendingCount(root), 0)
})

test("under a purpose policy, entries queue behind Desk's own unpublished commit instead of being refused", async (t) => {
  const root = await fixture(t, { policy: true })
  await call(root, { note: "First write.", content_home })
  const held = git(root, ["rev-parse", "HEAD"])
  assert.notEqual(held, git(root, ["rev-parse", "@{upstream}"]))
  for (let i = 0; i < 3; i += 1) assert.equal((await call(root, { log: `Entry ${i}.`, content_home })).status, "logged")
  await call(root, { note: "Another write.", content_home })
  await drainAppendLanes()
  assert.equal(git(root, ["status", "--porcelain"]), "")
  assert.match(await fs.readFile(path.join(root, "track/work/log.md"), "utf8"), /Entry 2\./u)
})

test("a commit made by hand still blocks a policy write, and a hand edit of the log is not adopted", async (t) => {
  const root = await fixture(t, { policy: true })
  await fs.writeFile(path.join(root, "held.md"), "Unpublished source.\n")
  git(root, ["add", "held.md"])
  git(root, ["commit", "-qm", "Held source"])
  await assert.rejects(call(root, { log: "x", content_home }), /content_home_unpublished_base/u)
  git(root, ["reset", "-q", "--hard", "@{upstream}"])
  await call(root, { log: "Mine.", content_home })
  await drainAppendLanes()
  await fs.appendFile(path.join(root, "track/work/log.md"), "\nHand edit.\n")
  await assert.rejects(call(root, { log: "Next.", content_home }), /content_home_dirty_target/u)
})

test("a write names the session or temp paths it keeps, and still saves them", async (t) => {
  const root = await fixture(t)
  const answer = await call(root, { note: "Brief at ~/.copilot/session-state/84b913b0/files/art-pass-2-brief.md and /tmp/ghw." })
  assert.match(answer.scratch_paths, /^Copy the file into the task's folder with desk_save/u)
  assert.match(answer.scratch_paths, /art-pass-2-brief\.md/u)
  assert.match(await fs.readFile(path.join(root, "track/work/task.md"), "utf8"), /art-pass-2-brief/u)
  const quiet = await call(root, { note: "See https://example.com/tmp/x and src/tmp/y." })
  assert.equal(quiet.scratch_paths, undefined)
  const logged = await call(root, { log: "Evidence in /tmp/ghw." })
  assert.match(logged.scratch_paths, /\/tmp\/ghw/u)
  const created = await task_create({ deskRoot: root, input: { track: "track", slug: "new-work", title: "New", body: "Notes in `~/.copilot/session-state/x/files/n.md`." }, schedulePush() {} })
  assert.match(created.scratch_paths, /session-state/u)
})

test("the active task list counts the scratch paths a card names, and boot leads with the fix", async (t) => {
  const root = await fixture(t)
  await call(root, { note: "Brief at ~/.copilot/session-state/84b913b0/files/a.md and /tmp/ghw." })
  const tracks = (await activeTasks(root)).tracks
  assert.equal(tracks[0].tasks[0].scratch_paths, 2)
  assert.match(tracks[0].tasks[0].scratch_fix, /^Copy those files into the task's folder with desk_save and link that: this card names 2 paths/u)
  assert.match(formatBootText({ status: "ready", active_tasks: await activeTasks(root) }), /\n {2}Copy those files into the task's folder with desk_save/u)
})

test("a file saved under handoffs/ comes back with the repository URL to hand over", async (t) => {
  const root = await fixture(t)
  const answer = await desk_save({ deskRoot: root, input: { message: "Hand off", files: [{ path: "track/work/handoffs/art-pass-2-brief.md", content: "Brief.\n" }, { path: "track/work/notes.md", content: "Notes.\n" }] }, schedulePush() {} })
  assert.equal(answer.status, "committed")
  assert.deepEqual(answer.handoff_references, [{ path: "track/work/handoffs/art-pass-2-brief.md", url: "https://github.com/sample/context/blob/main/track/work/handoffs/art-pass-2-brief.md" }])
  assert.match(answer.handoff_note, /never a path in a session folder/u)
})

test("task_focus points at the log's newest entry", async (t) => {
  const root = await fixture(t)
  assert.equal((await taskFocus({ deskRoot: root, input: { track: "track", slug: "work" } })).log, undefined)
  await call(root, { log: "Ruling: first." })
  await call(root, { log: "Ruling: second." })
  flushAppends(root)
  const { log } = await taskFocus({ deskRoot: root, input: { track: "track", slug: "work" } })
  assert.equal(log.path, "track/work/log.md")
  assert.equal(log.entries, 2)
  assert.match(log.latest, /^\d{4}-\d\d-\d\d \d\d:\d\d: Ruling: second\.$/u)
})
