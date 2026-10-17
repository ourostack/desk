import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { readCleanupIndex } from "../../../../../plugins/desk/mcp/src/desk/cleanup-index.js"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { task_move } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

const target = { track: "t", slug: "finish-work" }
const active = "t/finish-work/task.md"
const archived = "t/_archive/finish-work/task.md"
const schedulePush = () => {}
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
async function fixture({ status = "processing", gitDesk = false } = {}) {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { ...target, title: "Finish work", status, body: "Original\n\n**Next step:** check it\n" }, schedulePush })
  if (gitDesk) {
    git(root, "init", "-q")
    git(root, "config", "user.name", "Test")
    git(root, "config", "user.email", "test@example.com")
    git(root, "add", "--", active)
    git(root, "commit", "-qm", "fixture")
  }
  return root
}

test("terminal update relocates the complete mixed update and returns the real path", async () => {
  const root = await fixture()
  const result = await task_update({
    deskRoot: root, schedulePush,
    input: { ...target, status: "cancelled", frontmatter: { category: "kept" }, note: "Stopped intentionally", next_step: "No further work", body_append: "Final record" },
  })
  assert.equal(result.path, archived)
  assert.equal(await exists(path.join(root, active)), false)
  const card = await readFront(path.join(root, archived))
  assert.equal(card.data.status, "cancelled")
  assert.equal(card.data.category, "kept")
  assert.match(card.content, /Stopped intentionally/)
  assert.match(card.content, /No further work/)
  assert.match(card.content, /Final record/)
})

test("same-terminal archived retry is read-only; append-bearing retry is refused without replay", async () => {
  const root = await fixture()
  await task_update({ deskRoot: root, input: { ...target, status: "cancelled", body_append: "once" }, schedulePush })
  const file = path.join(root, archived)
  const before = await fs.readFile(file, "utf8")
  const result = await task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush })
  assert.equal(result.path, archived)
  assert.equal(await fs.readFile(file, "utf8"), before)
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled", body_append: "once" }, schedulePush }),
    (error) => error.message.includes(archived) && /not reapplied|non-reapplication/i.test(error.message) && /unarchive/i.test(error.message))
  assert.equal(await fs.readFile(file, "utf8"), before)
})

test("active already-terminal explicit status completes archival without a new delivery", async () => {
  const root = await fixture({ status: "done" })
  const result = await task_update({ deskRoot: root, input: { ...target, status: "done" }, schedulePush })
  assert.equal(result.path, archived)
  assert.equal((await readFront(path.join(root, archived))).data.evidence, undefined)
  assert.equal(result.signoff_packet, undefined)
})

test("collision refuses the terminal update before changing the active bytes", async () => {
  const root = await fixture()
  const before = await fs.readFile(path.join(root, active), "utf8")
  await fs.mkdir(path.dirname(path.join(root, archived)), { recursive: true })
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush }), /destination.*exist/i)
  assert.equal(await fs.readFile(path.join(root, active), "utf8"), before)
})

test("automatic archive refuses dirty companions without publishing or changing the card", async () => {
  const root = await fixture({ gitDesk: true })
  await fs.writeFile(path.join(root, "t/finish-work/foreign.txt"), "not admitted")
  const before = await fs.readFile(path.join(root, active), "utf8")
  const head = git(root, "rev-parse", "HEAD")
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush }), /companion|uncommitted/i)
  assert.equal(git(root, "rev-parse", "HEAD"), head)
  assert.equal(await fs.readFile(path.join(root, active), "utf8"), before)
})

test("terminal update makes one final commit including the real track row and retains foreign staged bytes", async () => {
  const root = await fixture({ gitDesk: true })
  await fs.writeFile(path.join(root, "t/track.md"), "# Track\n\n## Tasks\n\n| Slug | State |\n| --- | --- |\n| finish-work | processing |\n")
  git(root, "add", "--", "t/track.md")
  git(root, "commit", "-qm", "track fixture")
  await fs.writeFile(path.join(root, "foreign.txt"), "foreign")
  git(root, "add", "--", "foreign.txt")
  const before = Number(git(root, "rev-list", "--count", "HEAD"))
  let pushes = 0
  const result = await task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush: () => pushes++ })
  assert.equal(result.path, archived)
  assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), before + 1)
  assert.equal(pushes, 1)
  assert.match(await fs.readFile(path.join(root, "t/track.md"), "utf8"), /finish-work.*cancelled/)
  assert.equal(git(root, "diff", "--cached", "--name-only"), "foreign.txt")
  assert.equal(result.desk_commit, git(root, "rev-parse", "--short", "HEAD"))
  assert.equal(spawnSync("git", ["-C", root, "cat-file", "-e", `HEAD:${active}`]).status, 128)
})

test("rename failure reports terminal bytes written at the active path, not successful archival", async (t) => {
  const root = await fixture()
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    if (from === path.join(root, "t/finish-work")) throw new Error("injected relocation failure")
    return rename(from, to)
  })
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush }),
    (error) => error.phase === "written_active" && error.path === active)
  assert.equal((await readFront(path.join(root, active))).data.status, "cancelled")
  assert.equal(await exists(path.join(root, archived)), false)
})

test("journal failure preserves relocated placement and reports the actual path", async () => {
  const root = await fixture()
  await assert.rejects(task_update({
    deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush,
    readiness: { recordChange: async () => { throw new Error("journal unavailable") }, markUncertain: async () => {} },
  }), (error) => error.phase === "relocated_uncommitted" && error.path === archived)
  assert.equal((await readFront(path.join(root, archived))).data.status, "cancelled")
})

test("explicit archive still returns already_archived after terminal update", async () => {
  const root = await fixture()
  await task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush })
  const result = await task_archive({ deskRoot: root, input: target, schedulePush })
  assert.equal(result.status, "already_archived")
  assert.equal(result.path, archived)
})

test("terminal resource update indexes the actual archive and keeps the narrow archived disposition path", async () => {
  const root = await fixture()
  const identity = `worktree:${path.join(root, "never-created-resource")}`
  await task_update({ deskRoot: root, schedulePush, input: {
    ...target, status: "cancelled", resource: { identity, intended: "retain until reviewed" },
  } })
  assert.deepEqual(await readCleanupIndex(root), ["t/_archive/finish-work"])
  const before = (await readFront(path.join(root, archived))).data
  const result = await task_update({ deskRoot: root, schedulePush, input: {
    ...target, resource: { identity, disposition: "retained-with-trigger", details: "Owned fixture reference only; never created." },
  } })
  assert.equal(result.path, archived)
  assert.deepEqual((await readFront(path.join(root, archived))).data, before)
  assert.deepEqual(await readCleanupIndex(root), [])
  await assert.rejects(task_update({ deskRoot: root, schedulePush, input: {
    ...target, note: "do not replay", resource: { identity, disposition: "retained-with-trigger", details: "same" },
  } }), (error) => error.message.includes(archived) && /not reapplied/.test(error.message) && /unarchive/.test(error.message))
})

test("pinned archive commit does not adopt an edit made after staging", async () => {
  const root = await fixture({ gitDesk: true })
  const companion = path.join(root, "t/finish-work/proof.txt")
  await fs.writeFile(companion, "admitted\n")
  git(root, "add", "--", "t/finish-work/proof.txt")
  git(root, "commit", "-qm", "proof")
  let edited = false
  const spawnGit = (command, args, options) => {
    const result = spawnSync(command, args, options)
    if (!edited && args[2] === "add") {
      edited = true
      writeFileSync(path.join(root, "t/_archive/finish-work/proof.txt"), "external later edit\n")
    }
    return result
  }
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, spawnGit, schedulePush }),
    (error) => error.phase === "committed" && /external/.test(error.message))
  assert.equal(git(root, "show", "HEAD:t/_archive/finish-work/proof.txt"), "admitted")
  assert.equal(await fs.readFile(path.join(root, "t/_archive/finish-work/proof.txt"), "utf8"), "external later edit\n")
})

test("commit failure reports the relocated card and preserves all prepared bytes", async () => {
  const root = await fixture({ gitDesk: true })
  const head = git(root, "rev-parse", "HEAD")
  const spawnGit = (command, args, options) => args[2] === "commit"
    ? { status: 1, stdout: "", stderr: "injected commit failure" }
    : spawnSync(command, args, options)
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled", note: "kept" }, spawnGit, schedulePush }),
    (error) => error.path === archived && error.phase === "relocated_uncommitted" && /commit failed/.test(error.message))
  assert.equal(git(root, "rev-parse", "HEAD"), head)
  assert.match((await readFront(path.join(root, archived))).content, /kept/)
})

test("unsigned delivery queues finalize/evaluation exactly once and status retry creates no new delivery", async (t) => {
  const root = await fixture()
  const env = { ...process.env, XDG_STATE_HOME: await mkTempDeskRoot() }
  await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "proof.md"), "fixture verification complete")
  const requests = []
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    if (String(to).includes(`${path.sep}finalize${path.sep}`)) requests.push("finalize")
    if (String(to).includes(`${path.sep}evaluate-requests${path.sep}`)) requests.push("evaluate")
    return rename(from, to)
  })
  const result = await task_update({ deskRoot: root, env, schedulePush, input: { ...target, status: "done", evidence: { kind: "non_code", ref: "proof.md" } } })
  assert.equal(result.signoff, "delivered_unsigned")
  assert.deepEqual(requests.sort(), ["evaluate", "finalize"])
  const card = await fs.readFile(path.join(root, archived), "utf8")
  await task_update({ deskRoot: root, env, schedulePush, input: { ...target, frontmatter: { status: "done" } } })
  assert.equal(await fs.readFile(path.join(root, archived), "utf8"), card)
  assert.equal(requests.length, 2)
})

test("person-scoped terminal move uses that person's real track and refuses escaped symlinks", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, person: "alice", schedulePush, input: { ...target, title: "Mine", status: "processing" } })
  const mine = path.join(root, "desks/alice")
  await fs.writeFile(path.join(mine, "t/track.md"), "| Slug | State |\n|---|---|\n| finish-work | processing |\n")
  const result = await task_update({ deskRoot: root, person: "alice", schedulePush, input: { ...target, status: "cancelled" } })
  assert.equal(result.path, "desks/alice/t/_archive/finish-work/task.md")
  assert.match(await fs.readFile(path.join(mine, "t/track.md"), "utf8"), /finish-work.*cancelled/)
  const other = await fixture()
  const foreign = await mkTempDeskRoot()
  await fs.mkdir(path.join(other, "t/_archive"))
  await fs.symlink(foreign, path.join(other, "t/_archive/finish-work"), process.platform === "win32" ? "junction" : "dir")
  const before = await fs.readFile(path.join(other, active), "utf8")
  await assert.rejects(task_update({ deskRoot: other, schedulePush, input: { ...target, status: "cancelled" } }))
  assert.equal(await fs.readFile(path.join(other, active), "utf8"), before)
  assert.deepEqual(await fs.readdir(foreign), [])
})

test("late cleanup-index failure retains the final commit and actual archived path", async () => {
  const root = await fixture({ gitDesk: true })
  const blocked = path.join(root, "blocked-state")
  await fs.writeFile(blocked, "not a directory")
  const before = Number(git(root, "rev-list", "--count", "HEAD"))
  await assert.rejects(task_update({
    deskRoot: root, env: { ...process.env, XDG_STATE_HOME: blocked }, schedulePush,
    input: { ...target, status: "cancelled", resource: { identity: `worktree:${path.join(root, "not-created")}` } },
  }), (error) => error.path === archived && error.phase === "committed" && typeof error.committed === "string")
  assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), before + 1)
  assert.equal((await readFront(path.join(root, archived))).data.status, "cancelled")
})

test("late terminal-sync failure is not a success-shaped terminal result", async (t) => {
  const root = await fixture({ gitDesk: true })
  const env = { ...process.env, XDG_STATE_HOME: await mkTempDeskRoot() }
  await factoryStateRoot(env)
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    if (String(to).includes(`${path.sep}evaluate-requests${path.sep}`)) throw new Error("injected request failure")
    return rename(from, to)
  })
  await assert.rejects(task_update({ deskRoot: root, env, schedulePush, input: { ...target, status: "cancelled" } }),
    (error) => error.path === archived && error.phase === "committed" && /sync deferred/.test(error.message))
  assert.equal((await readFront(path.join(root, archived))).data.status, "cancelled")
})

test("external companion bytes changed before staging are retained but never committed", async (t) => {
  const root = await fixture({ gitDesk: true })
  const proof = path.join(root, "t/finish-work/proof.txt")
  await fs.writeFile(proof, "admitted")
  git(root, "add", "--", "t/finish-work/proof.txt")
  git(root, "commit", "-qm", "proof")
  const head = git(root, "rev-parse", "HEAD")
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    const result = await rename(from, to)
    if (from === path.join(root, "t/finish-work")) await fs.writeFile(path.join(to, "proof.txt"), "external")
    return result
  })

  await assert.rejects(task_update({ deskRoot: root, schedulePush, input: { ...target, status: "cancelled" } }),
    (error) => error.path === archived && error.phase === "relocated_uncommitted" && /changed/.test(error.message))
  assert.equal(git(root, "rev-parse", "HEAD"), head)
  assert.equal(await fs.readFile(path.join(root, "t/_archive/finish-work/proof.txt"), "utf8"), "external")
})

test("a rename acknowledgement failure reports relocation when the original directory actually moved", async (t) => {
  const root = await fixture()
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    const result = await rename(from, to)
    if (from === path.join(root, "t/finish-work")) throw new Error("rename acknowledgement lost")
    return result
  })
  await assert.rejects(task_update({ deskRoot: root, schedulePush, input: { ...target, status: "cancelled" } }),
    (error) => error.path === archived && error.phase === "relocated_uncommitted")
  assert.equal(await exists(path.join(root, active)), false)
  assert.equal((await readFront(path.join(root, archived))).data.status, "cancelled")
})

test("unmerged archive paths refuse before writing, while ordinary card edits retain their disclosure", async () => {
  const root = await fixture({ gitDesk: true })
  const before = await fs.readFile(path.join(root, active), "utf8")
  const sha = git(root, "rev-parse", `HEAD:${active}`)
  const conflict = spawnSync("git", ["-C", root, "update-index", "--index-info"], {
    encoding: "utf8", input: `0 ${"0".repeat(40)}\t${active}\n100644 ${sha} 1\t${active}\n100644 ${sha} 2\t${active}\n100644 ${sha} 3\t${active}\n`,
  })
  assert.equal(conflict.status, 0, conflict.stderr)
  await assert.rejects(task_update({ deskRoot: root, schedulePush, input: { ...target, status: "cancelled" } }), /unmerged/)
  assert.equal(await fs.readFile(path.join(root, active), "utf8"), before)
  const editable = await fixture({ gitDesk: true })
  await fs.appendFile(path.join(editable, active), "\nAn earlier card edit.\n")
  const result = await task_update({ deskRoot: editable, schedulePush, input: { ...target, status: "cancelled" } })
  assert.match(result.included_uncommitted_changes, /already held uncommitted changes/)
  assert.match(await fs.readFile(path.join(editable, archived), "utf8"), /An earlier card edit/)
})

test("a foreign destination observed after the card write is retained, never overwritten", async (t) => {
  const root = await fixture()
  const writtenTarget = await fs.realpath(path.join(root, active))
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    const result = await rename(from, to)
    if (to === writtenTarget) {
      await fs.mkdir(path.dirname(path.join(root, archived)), { recursive: true })
      await fs.writeFile(path.join(path.dirname(path.join(root, archived)), "foreign.txt"), "foreign")
    }
    return result
  })
  await assert.rejects(task_update({ deskRoot: root, schedulePush, input: { ...target, status: "cancelled" } }),
    (error) => error.phase === "written_active" && error.path === active)
  assert.equal(await fs.readFile(path.join(path.dirname(path.join(root, archived)), "foreign.txt"), "utf8"), "foreign")
  assert.equal((await readFront(path.join(root, active))).data.status, "cancelled")
})

test("an untracked card on an unborn Git branch can make its one final archive commit", async () => {
  const root = await fixture()
  git(root, "init", "-q")
  git(root, "config", "user.name", "Test")
  git(root, "config", "user.email", "test@example.com")
  const result = await task_update({ deskRoot: root, schedulePush, input: { ...target, status: "cancelled" } })
  assert.equal(result.path, archived)
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1")
  assert.equal(git(root, "ls-tree", "-r", "--name-only", "HEAD"), archived)
})

test("a nested bound desk pins paths relative to the enclosing worktree without disturbing other files", async () => {
  const repository = await mkTempDeskRoot()
  git(repository, "init", "-q")
  git(repository, "config", "user.name", "Test")
  git(repository, "config", "user.email", "test@example.com")
  await fs.writeFile(path.join(repository, "outside.md"), "keep")
  git(repository, "add", "--", "outside.md")
  git(repository, "commit", "-qm", "outside")
  const root = path.join(repository, "desks/alice")
  await fs.mkdir(root, { recursive: true })
  await task_create({ deskRoot: root, schedulePush, input: { ...target, title: "Nested", status: "processing" } })
  const result = await task_update({ deskRoot: root, schedulePush, input: { ...target, status: "cancelled" } })
  assert.equal(result.path, archived)
  assert.deepEqual(git(repository, "ls-tree", "-r", "--name-only", "HEAD").split("\n"), [
    "desks/alice/t/_archive/finish-work/task.md", "outside.md",
  ])
  assert.equal(git(repository, "status", "--porcelain"), "")
})

test("an overlapping canonical move cannot enter a terminal relocation paused at its journal boundary", async () => {
  const root = await fixture()
  let entered, release
  const ready = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  let first = true
  const changes = []
  const operation = task_update({
    deskRoot: root, schedulePush, input: { ...target, status: "cancelled" },
    readiness: { recordChange: async (change) => {
      changes.push(change)
      if (first) { first = false; entered(); await wait }
      return { recorded: true }
    }, markUncertain: async () => {} },
  })
  await ready
  try {
    await assert.rejects(task_move({ deskRoot: root, schedulePush, input: { ...target, unarchive: true } }), { code: "desk_mutation_busy" })
    await assert.rejects(task_update({ deskRoot: root, schedulePush, input: { ...target, status: "cancelled" } }), { code: "desk_mutation_busy" })
  } finally {
    release()
  }
  const result = await operation
  assert.equal(result.path, archived)
  assert.deepEqual(changes.map(({ path: file, operation: change }) => [file, change]), [
    ["t/finish-work", "delete"], ["t/_archive/finish-work", "write"],
  ])
  assert.equal(await exists(path.join(root, active)), false)
})

test("MCP dispatch preserves partial terminal placement as an error, not generic success", async () => {
  const root = await fixture()
  const controller = { recordChange: async () => { throw new Error("journal unavailable") }, markUncertain: async () => {} }
  const result = await callTool({ deskRoot: root, name: "task_update", input: { ...target, status: "cancelled" },
    statusContext: { admission: { controller } } })
  assert.equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  assert.equal(body.status, "partial_operation")
  assert.equal(body.phase, "relocated_uncommitted")
  assert.equal(body.path, archived)
  assert.equal(body.retryable, false)
  assert.equal((await readFront(path.join(root, archived))).data.status, "cancelled")
})

test("a track replaced by an external symlink after preflight is refused without writing its referent", async (t) => {
  const root = await fixture()
  const other = await mkTempDeskRoot()
  const before = "| Slug | State |\n|---|---|\n| finish-work | processing |\n"
  const track = path.join(root, "t/track.md")
  const foreign = path.join(other, "foreign.md")
  await fs.writeFile(track, before)
  await fs.writeFile(foreign, before)
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    const result = await rename(from, to)
    if (from === path.join(root, "t/finish-work")) {
      await fs.unlink(track)
      await fs.symlink(foreign, track)
    }
    return result
  })
  await assert.rejects(task_update({ deskRoot: root, schedulePush, input: { ...target, status: "cancelled" } }),
    (error) => error.path === archived && error.phase === "relocated_uncommitted")
  assert.equal(await fs.readFile(foreign, "utf8"), before)
  assert.equal((await fs.lstat(track)).isSymbolicLink(), true)
})
