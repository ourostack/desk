import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkTempRoot } from "../_temp_roots.js"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"
import { readInspectionGit } from "../../../../../plugins/desk/mcp/src/runtime/git-inspection.js"
import { TIDY_GIT_TIMEOUT_MS } from "../../../../../plugins/desk/mcp/src/runtime/workspace-tidy.js"
import { serializeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { pathToFileURL } from "node:url"
import { dispositionRecord, mergeTidyEvidence } from "../../../../../plugins/desk/mcp/src/runtime/workspace-evidence.js"
import { withWorkspaceClaim } from "../../../../../plugins/desk/mcp/src/runtime/workspace-claim.js"
import { acknowledgeRepair, readReport, reportPath, runBootChecks, runRepair } from "../../../../../plugins/desk/hooks/lib/boot-checks.cjs"
import { different } from "../_file_identity.js"
import { fixture, git, moduleUrl, squashFixture, tidy, tidyInspectionGit, worktree } from "./_workspace_tidy_fixture.js"

test("workspace tidy exposes the deferred repair and bounded inventory", () => {
  assert.equal(typeof tidy.inspectWorkspace, "function")
  assert.equal(typeof tidy.repairWorkspace, "function")
})

test("removes an exactly released clean merged worktree and its local branch, twice", async () => {
  const f = await fixture()
  for (const branch of ["first", "second"]) {
    const w = await worktree(f, branch)
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 1, JSON.stringify({ left: result.left, issues: result.issues }))
    assert.equal(result.removed[0].path, w.directory)
    assert.equal(result.removed[0].branchRemoved, true)
    await assert.rejects(fs.stat(w.directory), { code: "ENOENT" })
    assert.doesNotMatch(git(f.repo, "worktree", "list", "--porcelain"), new RegExp(branch))
    assert.throws(() => git(f.repo, "show-ref", "--verify", `refs/heads/${branch}`))
    assert.equal(git(f.repo, "branch", "--show-current"), "main")
  }
})

const refusals = [
  ["tracked changes", async (f, w) => fs.writeFile(path.join(w.directory, "tracked"), "dirty")],
  ["untracked files", async (f, w) => fs.writeFile(path.join(w.directory, "untracked"), "keep")],
  ["ignored files", async (f, w) => { await fs.writeFile(path.join(w.directory, ".gitignore"), "ignored\n"); git(w.directory, "add", ".gitignore"); git(w.directory, "commit", "-m", "ignore"); git(f.repo, "merge", "--ff-only", w.record.branch); w.record.head = git(w.directory, "rev-parse", "HEAD"); w.record.delivered = w.record.head; await w.save(); await fs.writeFile(path.join(w.directory, "ignored"), "keep") }],
  ["local commits", async (f, w) => { await fs.writeFile(path.join(w.directory, "tracked"), "local"); git(w.directory, "commit", "-am", "local") }],
  ["locked", async (f, w) => git(f.repo, "worktree", "lock", w.directory)],
  ["git operation", async (f, w) => fs.writeFile(path.join(w.admin, "MERGE_HEAD"), w.record.head)],
  ["git operation", async (f, w) => fs.writeFile(path.join(w.admin, "index.lock"), "")],
  ["ownership", async (f, w) => fs.unlink(w.receipt)],
  // A receipt is read whole, so one over 64 KiB is unreadable rather than cut short.
  ["ownership", async (f, w) => { w.record.padding = "x".repeat(70_000); await w.save() }],
  ["ownership", async (f, w) => { w.record.branch = "refs/heads/unrelated"; await w.save() }],
  ["ownership", async (f, w) => { w.record.repository = f.desk; await w.save() }],
  ["ownership", async (f, w) => { w.record.task = "../outside/task.md"; await w.save() }],
  ["identity", async (f, w) => { w.record.identity.ino = different(w.record.identity.ino); await w.save() }],
  ["retained", async (f, w) => { w.record.disposition = "retained-with-trigger"; await w.save() }],
  ["writer", async (f, w) => { w.record.release.processes = [{ pid: process.pid, start: await readProcessStart(process.pid) }]; await w.save() }],
  ["writer", async (f, w) => { w.record.release.complete = false; await w.save() }],
  ["writer", async (f, w) => { w.record.release.processes = []; await w.save() }],
  ["consumer", async (f, w) => { w.record.release.consumers = ["remote-job"]; await w.save() }],
  ["detached", async (f, w) => git(w.directory, "switch", "--detach")],
  ["ownership", async (f, w) => fs.writeFile(w.receipt, "{broken")],
  ["ownership", async (f, w) => { await fs.rename(w.receipt, `${w.receipt}.real`); await fs.symlink(`${w.receipt}.real`, w.receipt) }],
]
for (const [reason, mutate] of refusals) {
  test(`refuses ${reason}: ${mutate.toString().slice(17, 86)}`, async () => {
    const f = await fixture()
    const w = await worktree(f)
    await mutate(f, w)
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
    assert.match(result.left.find((entry) => entry.path === w.directory)?.reason ?? "", new RegExp(reason))
    assert.ok((await fs.stat(w.directory)).isDirectory())
  })
}

test("a deleted remote branch never authorizes loss of unmerged or local-only content", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await fs.writeFile(path.join(w.directory, "tracked"), "unmerged")
  git(w.directory, "commit", "-am", "unmerged")
  git(w.directory, "push", "origin", "topic")
  git(w.directory, "push", "origin", "--delete", "topic")
  w.record.head = git(w.directory, "rev-parse", "HEAD")
  w.record.remote = { name: "origin", branch: "refs/heads/topic", endpoint: pathToFileURL(f.remote).href }
  await w.save()
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left[0].reason, /local commits|delivery/)
})

test("remote-deleted squash delivery removes the worktree but conservatively retains an unmerged local ref", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await fs.writeFile(path.join(w.directory, "tracked"), "delivered")
  git(w.directory, "commit", "-am", "topic")
  git(w.directory, "push", "origin", "topic")
  git(f.repo, "merge", "--squash", "topic")
  git(f.repo, "commit", "-m", "squash")
  git(f.repo, "push", "origin", "main")
  git(f.repo, "push", "origin", "--delete", "topic")
  w.record.head = git(w.directory, "rev-parse", "HEAD")
  w.record.delivered = git(f.repo, "rev-parse", "main")
  w.record.remote = { name: "origin", branch: "refs/heads/topic", endpoint: pathToFileURL(f.remote).href }
  await w.save()
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 1, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.equal(result.removed[0].branchRemoved, false)
  assert.match(result.left[0].reason, /branch.*retained/)
  assert.equal(git(f.repo, "rev-parse", "topic"), w.record.head)
})

test("inventory scopes repositories to bound desk and active/recent task cards, including archives", async () => {
  const f = await fixture()
  await worktree(f)
  const archived = path.join(f.desk, "_archive", "old-track", "_archive", "finished")
  await fs.mkdir(archived, { recursive: true })
  await fs.rename(f.card, path.join(archived, "task.md"))
  const recent = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
  assert.deepEqual(recent.repositories.sort(), [f.desk, f.repo].sort())
  assert.equal(recent.worktrees.length, 1)
  const file = path.join(archived, "task.md")
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/updated: .*/, 'updated: "2000-01-01T00:00:00Z"'))
  assert.deepEqual((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).repositories, [f.desk])
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("status: done", "status: processing"))
  assert.equal((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).worktrees.length, 1)
})

test("inventory never inspects unrecorded repositories or follows task-directory symlinks", async () => {
  const f = await fixture()
  const other = await fixture()
  await worktree(other)
  await fs.symlink(path.dirname(other.card), path.join(f.desk, "track", "linked"), "dir")
  const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
  assert.ok(!result.repositories.includes(other.repo))
  assert.equal(result.worktrees.length, 0)
})

test("listing is read-only and stops at its time and cardinality budgets", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const before = git(f.repo, "worktree", "list", "--porcelain")
  const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
  assert.equal(result.worktrees[0].path, w.directory)
  assert.equal(git(f.repo, "worktree", "list", "--porcelain"), before)
  const started = performance.now()
  const slow = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 40, git: () => new Promise(() => {}) })
  assert.ok(performance.now() - started < 200, "a blocked Git listing must not hold boot")
  assert.equal(slow.complete, false)
  assert.match(slow.issues.join(" "), /budget/)
  const capped = await tidy.inspectWorkspace({ deskRoot: f.desk, maxCards: 0 })
  assert.equal(capped.complete, false)
})

test("one bounded line accounts for every leftover, with overflow details retained", () => {
  const left = Array.from({ length: 100 }, (_, i) => ({ path: `/work/${i}\nmalicious`, reason: i % 2 ? "local commits" : "live writer" }))
  const line = tidy.tidyLine({ removed: [{ path: "/a" }], left, issues: [] })
  assert.ok(line.length <= 480)
  assert.equal(line.split("\n").length, 1)
  assert.match(line, /Tidied 1 stale worktree/)
  assert.match(line, /100 left/)
  assert.match(line, /50.*local commits/)
  assert.match(line, /50.*live writer/)
})

test("another checkout acquiring the released branch prevents branch deletion", async () => {
  const f = await fixture()
  await worktree(f)
  const other = path.join(f.root, "new-consumer")
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "worktree" && args[1] === "remove" && result.ok) git(f.repo, "worktree", "add", other, "topic")
    return result
  }
  const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
  assert.equal(result.removed.length, 1, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.equal(result.removed[0].branchRemoved, false)
  assert.equal(git(other, "symbolic-ref", "HEAD"), "refs/heads/topic")
  assert.doesNotThrow(() => git(f.repo, "rev-parse", "--verify", "topic"))
})

test("branch absence after worktree removal is recorded, not mislabeled as a leftover worktree", async () => {
  const f = await fixture()
  await worktree(f)
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "worktree" && args[1] === "remove" && result.ok) git(f.repo, "branch", "-d", "topic")
    return result
  }
  const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
  assert.equal(result.removed.length, 1, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.equal(result.removed[0].branchRemoved, true)
  assert.deepEqual(result.left, [])
})

test("a receipt cannot borrow another task's repository authority", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const other = path.join(f.desk, "track", "other", "task.md")
  await fs.mkdir(path.dirname(other))
  await fs.writeFile(other, "---\nstatus: processing\nrepos: []\n---\n")
  w.record.task = path.relative(f.desk, other)
  await w.save()
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left[0].reason, /ownership/)
})

test("a changed task card revokes an already listed release", async () => {
  const f = await fixture()
  await worktree(f)
  let lists = 0
  const run = async (cwd, args) => {
    if (cwd === f.repo && args[0] === "worktree" && args[1] === "list" && ++lists === 2) await fs.writeFile(f.card, "---\nstatus: processing\nrepos: []\n---\n")
    return tidyInspectionGit(cwd, args)
  }
  const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left[0].reason, /ownership|task.*changed/)
})

test("an fsmonitor configured by a repository is not executed during cleanup inspection", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const marker = path.join(f.root, "executed")
  git(f.repo, "config", "core.fsmonitor", `echo BAD > '${marker}'; false`)
  await tidy.repairWorkspace({ deskRoot: f.desk })
  await assert.rejects(fs.stat(marker), { code: "ENOENT" })
  assert.ok(w)
})

test("one malformed, inaccessible or oversized card is skipped by name; every other card still counts", async (t) => {
  const f = await fixture()
  const original = await fs.readFile(f.card, "utf8")
  const sibling = path.join(f.desk, "track", "sibling", "task.md")
  await fs.mkdir(path.dirname(sibling), { recursive: true })
  await fs.writeFile(sibling, original)
  for (const [body, reason] of [
    ["---\nrepos: []\n---", "no readable status"],
    ["no front matter at all\n", "no readable status"],
    ["---\nstatus: done\nstatus: done\n---\n", "unreadable card"],
    [`---\nstatus: processing\nnotes: ${"x".repeat(65537)}\n---\n`, "front matter not closed within 64 KiB"],
  ]) {
    await fs.writeFile(f.card, body)
    const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
    assert.equal(result.complete, true, reason)
    assert.deepEqual(result.issues, [`1 task card skipped: track/task/task.md (${reason})`])
    assert.deepEqual(result.cards, [sibling], "the skipped card authorizes nothing; its sibling still counts")
    assert.deepEqual(result.cardRecords[sibling].repositories, [await fs.realpath(f.desk), await fs.realpath(f.repo)])
  }
  // A card whose repos Desk cannot read is one card's issue, never the whole desk's, and it authorizes nothing.
  await fs.rm(path.dirname(sibling), { recursive: true })
  for (const [body, reason] of [
    ['---\nstatus: processing\nrepos: [{mode: local}]\n---', "repos list not readable"],
    ['---\nstatus: processing\nrepos:\n  - local_path: "/x"\n---', "repos list not readable"],
    ['---\nstatus: processing\nrepos:\n  - mode: local\n---', "repos list not readable"],
    ['---\nstatus: processing\nrepos:\n  - mode: local\n    local_path: ./relative\n---', "repo ./relative is not an absolute or ~/ path"],
    ['---\nstatus: processing\nrepos:\n  - mode: local\n    local_path: /no/such/repository\n---', "repo /no/such/repository not found"],
    ['---\nstatus: processing\nrepos:\n  - mode: local\n    local_path: /no/such/pw hunter2\n---', "repo /no/such/<redacted segment> not found"],
  ]) {
    await fs.writeFile(f.card, body)
    const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
    assert.equal(result.complete, true, body)
    assert.deepEqual(result.issues, [`1 task card with unreadable repos: track/task/task.md (${reason}); their repositories were not inspected`], body)
    assert.deepEqual(result.cardRecords[f.card].repositories, [])
  }
  await fs.writeFile(f.card, original)
  const open = fs.open.bind(fs)
  const mock = t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args)
    if (file === f.card) {
      const stat = handle.stat.bind(handle)
      handle.stat = async (...args) => { const real = await stat(...args); return { ...real, ino: different(real.ino) } }
    }
    return handle
  })
  assert.match((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).issues[0], /skipped: .*identity changed/)
  mock.mock.restore()
  const unreadable = t.mock.method(fs, "open", async (file, ...args) => {
    if (file === f.card) throw Object.assign(new Error("denied"), { code: "EACCES" })
    return open(file, ...args)
  })
  assert.deepEqual((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).issues, ["1 task card skipped: track/task/task.md (unreadable card)"])
  unreadable.mock.restore()
})

test("a swapped task card is noticed when file ids are above 2^53, where two ids are one Number", async (t) => {
  const f = await fixture()
  await worktree(f)
  const WINDOWS_ID = 10414574139658612n
  assert.equal(Number(WINDOWS_ID), Number(WINDOWS_ID + 1n), "the premise: as Numbers these two ids are equal")
  const lstat = fs.lstat.bind(fs)
  t.mock.method(fs, "lstat", async (file, ...args) => {
    const real = await lstat(file, ...args)
    return file === f.card ? { ...real, isFile: () => true, nlink: 1n, dev: 1n, ino: WINDOWS_ID } : real
  })
  const open = fs.open.bind(fs)
  let reopened = WINDOWS_ID + 1n
  t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args)
    if (file === f.card) {
      const stat = handle.stat.bind(handle)
      handle.stat = async (...statArgs) => ({ ...await stat(...statArgs), dev: 1n, ino: reopened })
    }
    return handle
  })
  assert.match((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).issues[0], /skipped: .*identity changed/)
  reopened = WINDOWS_ID
  assert.deepEqual((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).issues, [], "the same id is the same file")
})

test("a task card over 64 KiB is read by its front matter alone, so a large body never stops the tidy", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const frontMatter = await fs.readFile(f.card, "utf8")
  // A real card on a live desk carried a 256 KB body of notes and transcripts.
  await fs.writeFile(f.card, `${frontMatter}\n# Notes\n\n${"a long pasted log line\n".repeat(12_000)}`)
  assert.ok((await fs.stat(f.card)).size > 256 * 1024)
  const inventory = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
  assert.equal(inventory.complete, true)
  assert.deepEqual(inventory.issues, [])
  assert.deepEqual(inventory.cards, [f.card])
  assert.equal(inventory.cardRecords[f.card].body, frontMatter.replace(/\n$/u, ""))
  // The card still authorizes the exactly released worktree, and a change to its body alone never counts as an ownership change.
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.deepEqual(result.left, [])
  assert.equal(result.removed.length, 1, JSON.stringify({ left: result.left, issues: result.issues }))
  await assert.rejects(fs.stat(w.directory), { code: "ENOENT" })
})

test("a large card whose front matter changes before removal stops that removal", async (t) => {
  const f = await fixture()
  const w = await worktree(f)
  const frontMatter = await fs.readFile(f.card, "utf8")
  await fs.writeFile(f.card, `${frontMatter}${"x".repeat(70_000)}\n`)
  const lstat = fs.lstat.bind(fs)
  let seen = 0
  const mock = t.mock.method(fs, "lstat", async (file, ...args) => {
    if (file === f.card && ++seen === 3) await fs.writeFile(f.card, `${frontMatter.replace("status: done", "status: processing")}${"x".repeat(70_000)}\n`)
    return lstat(file, ...args)
  })
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  mock.mock.restore()
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left.find((entry) => entry.path === w.directory)?.reason ?? "", /task ownership changed/)
  assert.ok((await fs.stat(w.directory)).isDirectory())
})

test("skipped cards are listed three at a time, with credential-like segments redacted", async () => {
  const f = await fixture()
  const names = ["alpha", "bravo", "charlie", "delta", "echo"]
  for (const name of names) {
    const card = path.join(f.desk, "track", name, "task.md")
    await fs.mkdir(path.dirname(card), { recursive: true })
    await fs.writeFile(card, "---\nrepos: []\n---\n")
  }
  const { issues } = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
  assert.equal(issues.length, 1)
  assert.match(issues[0], /^5 task cards skipped: track\/alpha\/task\.md \(no readable status\), track\/bravo\/task\.md \(no readable status\), track\/charlie\/task\.md \(no readable status\), and 2 more$/)
  for (const name of names.slice(1)) await fs.rm(path.join(f.desk, "track", name), { recursive: true })
  await fs.rename(path.join(f.desk, "track", "alpha"), path.join(f.desk, "track", "hi-set-pw-hunter2"))
  assert.deepEqual((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).issues, ["1 task card skipped: track/<redacted segment>/task.md (no readable status)"])
})

test("all inventory budgets and missing Git answers are explicit, including incomplete repair", async () => {
  const f = await fixture()
  await worktree(f)
  for (const options of [{ maxDirectories: 0 }, { maxCards: 0 }, { maxRepositories: 1 }, { maxWorktrees: 0 }]) {
    const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000, ...options })
    assert.equal(result.complete, false)
    assert.match(result.issues[0], /budget/)
  }
  const repair = await tidy.repairWorkspace({ deskRoot: f.desk, maxWorktrees: 0 })
  assert.equal(repair.removed.length, 0)
  assert.equal(repair.left.length, 1)
  assert.match(repair.left[0].reason, /incomplete/)
  for (const command of ["rev-parse", "worktree"]) {
    const run = (cwd, args) => args[0] === command ? Promise.resolve({ ok: false, code: 128 }) : tidyInspectionGit(cwd, args)
    const result = await tidy.inspectWorkspace({ deskRoot: f.desk, git: run, budgetMs: 5000 })
    assert.equal(result.complete, false)
    assert.match(result.issues[0], /cannot/)
  }
  await fs.mkdir(path.join(f.desk, "deep", "a", "b", "c", "d", "e", "f"), { recursive: true })
  assert.match((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).issues[0], /depth budget/)
  assert.equal((await tidy.inspectWorkspace()).complete, false)
  assert.equal((await tidy.repairWorkspace()).removed.length, 0)
})

test("tilde paths, remote-only repos and duplicate common directories stay scoped", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await fs.mkdir(path.join(f.desk, "node_modules"))
  await fs.mkdir(path.join(f.desk, "artifacts"))
  await fs.writeFile(f.card, `---\nstatus: processing\nrepos:\n  - name: remote\n    mode: remote\n  - name: repo\n    mode: local\n    local_path: ~/repo\n  - name: same\n    mode: local\n    local_path: ${JSON.stringify(w.directory)}\n---`)
  const result = await tidy.inspectWorkspace({ deskRoot: f.desk, homeDir: f.root, budgetMs: 5000 })
  assert.equal(result.complete, true)
  assert.equal(result.worktrees.length, 1)
  assert.deepEqual(result.repositories, [f.desk, f.repo, w.directory])
  assert.deepEqual(tidy.parseWorktrees("worktree /a\0HEAD abc\0unknown future\0\0", "/repo"), [{ repository: "/repo", path: tidy.nativeGitPath("/a"), head: "abc" }])
})

test("malformed release and delivery proof never authorizes deletion", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const original = structuredClone(w.record)
  for (const [mutate, reason] of [
    [(r) => { delete r.task }, /ownership/],
    [(r) => { r.base = "--all" }, /delivery/],
    [(r) => { r.delivered = "bad" }, /delivery/],
    [(r) => { r.delivered = "0".repeat(40) }, /delivery/],
    [(r) => { r.release.processes = [{ pid: 0, start: "start" }] }, /writer/],
    [(r) => { r.release.processes = [{ pid: 3 }] }, /writer/],
    [(r) => { r.release.machine = "another-machine" }, /writer/],
    [(r) => { delete r.release }, /writer/],
    [(r) => { delete r.release.consumers }, /consumer/],
  ]) {
    Object.assign(w.record, structuredClone(original))
    mutate(w.record)
    await w.save()
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
    assert.match(result.left[0].reason, reason)
  }
})

test("permission-denied and unknown process generations remain live; PID reuse is not the old writer", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const denied = await tidy.repairWorkspace({ deskRoot: f.desk, signal: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }) } })
  assert.match(denied.left[0].reason, /unobservable/)
  const unknown = await tidy.repairWorkspace({ deskRoot: f.desk, signal: () => {}, processStart: async () => null })
  assert.match(unknown.left[0].reason, /unobservable/)
  const reused = await tidy.repairWorkspace({ deskRoot: f.desk, signal: () => {}, processStart: async () => "different-generation" })
  assert.equal(reused.removed[0].path, w.directory)
})

test("remote-deleted squash cleanup refuses missing, wrong, present and unreachable remote proof", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await fs.writeFile(path.join(w.directory, "tracked"), "squashed\n")
  git(w.directory, "commit", "-am", "topic")
  git(w.directory, "push", "origin", "topic")
  git(f.repo, "merge", "--squash", "topic")
  git(f.repo, "commit", "-m", "squash")
  w.record.head = git(w.directory, "rev-parse", "HEAD")
  w.record.delivered = git(f.repo, "rev-parse", "main")
  for (const remote of [undefined, { name: "missing", branch: "refs/heads/topic" }, { name: "origin", branch: "--all" }, { name: "origin", branch: "refs/heads/topic", endpoint: pathToFileURL(f.remote).href }]) {
    w.record.remote = remote
    await w.save()
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
    assert.match(result.left[0].reason, /remote/)
  }
  git(f.repo, "remote", "set-url", "origin", path.join(f.root, "absent"))
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.match(result.left[0].reason, /ENOENT|endpoint/)
})

test("Git refusals and state changes at each deletion boundary remain visible", async () => {
  const f = await fixture()
  const w = await worktree(f)
  for (const [fault, reason] of [
    ["admin", /ownership/], ["status", /inspection/],
    ["unregistered", /registration/], ["receipt", /ownership changed/], ["remove", /removal refused/],
    ["absence", /absence unverified/], ["prunable", /missing/],
  ]) {
    let lists = 0
    const run = async (cwd, args) => {
      if (fault === "admin" && args.includes("--absolute-git-dir")) return { ok: true, stdout: w.record.repository }
      if (fault === "status" && args[0] === "status") return { ok: false, code: 128 }
      if (args[0] === "worktree" && args[1] === "remove") {
        if (fault === "remove") return { ok: false, code: 128 }
        if (fault === "absence") return { ok: true, stdout: "" }
      }
      const result = await tidyInspectionGit(cwd, args)
      if (cwd === f.repo && args[0] === "worktree" && args[1] === "list") {
        lists += 1
        if (fault === "prunable") result.stdout = result.stdout.replace(`branch ${w.record.branch}\0`, `branch ${w.record.branch}\0prunable missing\0`)
        if (lists === 2 && fault === "unregistered") result.stdout = result.stdout.split("\0\0").slice(0, 1).join("\0\0") + "\0\0"
        if (lists === 2 && fault === "receipt") { w.record.owner += "-reassigned"; await w.save() }
      }
      return result
    }
    const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
    assert.equal(result.removed.length, 0, fault)
    assert.match(result.left[0].reason, reason, fault)
  }
})

test("filesystem identity and inaccessible Git operation state refuse cleanup", async (t) => {
  const f = await fixture()
  const w = await worktree(f)
  const realpath = fs.realpath.bind(fs)
  const mock = t.mock.method(fs, "realpath", (file) => file === w.directory ? Promise.resolve(`${w.directory}-other`) : realpath(file))
  assert.match((await tidy.repairWorkspace({ deskRoot: f.desk })).left[0].reason, /symlinked/)
  mock.mock.restore()
  const lstat = fs.lstat.bind(fs)
  const fail = t.mock.method(fs, "lstat", (file, ...args) => file === path.join(w.admin, "index.lock")
    ? Promise.reject(Object.assign(new Error("operation state unreadable"), { code: "EACCES" })) : lstat(file, ...args))
  assert.match((await tidy.repairWorkspace({ deskRoot: f.desk })).left[0].reason, /unreadable/)
  fail.mock.restore()
})

test("empty reports, inspection issues and long unique reasons remain one bounded line", () => {
  assert.match(tidy.tidyLine(), /Tidied 0.*0 left/)
  assert.match(tidy.tidyLine({ issues: ["incomplete\ninventory"] }), /incomplete inventory/)
  const left = Array.from({ length: 100 }, (_, i) => ({ path: `/long/${i}`, reason: `reason-${i}` }))
  const line = tidy.tidyLine({ left, issues: ["budget exceeded"] })
  assert.match(line, /100 left/)
  assert.ok(line.length <= 480)
  assert.equal(line.split("\n").length, 1)
})

test("directory entry budget bounds even a single wide directory", async () => {
  const f = await fixture()
  const result = await tidy.inspectWorkspace({ deskRoot: f.desk, maxEntries: 0, budgetMs: 5000 })
  assert.equal(result.complete, false)
  assert.match(result.issues[0], /entry budget/)
})

test("live descendants veto release even when the original root generation has exited", async () => {
  const f = await fixture()
  const w = await worktree(f)
  w.record.release.processes.push({ pid: process.pid, start: await readProcessStart(process.pid) })
  await w.save()
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left[0].reason, /writer/)
})

test("a late read cannot continue inventory after the boot deadline", async () => {
  const f = await fixture()
  let finish, entered
  const reading = new Promise((resolve) => { entered = resolve })
  let calls = 0
  const pending = tidy.inspectWorkspace({
    deskRoot: f.desk, budgetMs: 100,
    git: () => { calls += 1; entered(); return new Promise((resolve) => { finish = resolve }) },
  })
  await reading
  const result = await pending
  assert.equal(result.complete, false)
  finish({ ok: true, stdout: path.join(f.desk, ".git") })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 1)
  assert.equal(result.worktrees.length, 0)
})
