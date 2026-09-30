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
// Injected Git runners stand in for workspace tidy's own, so they keep its per-call limit rather than the hooks' 2 s default.
const tidyInspectionGit = (cwd, args) => readInspectionGit(cwd, args, {}, { timeoutMs: TIDY_GIT_TIMEOUT_MS })
import { serializeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { dispositionRecord, mergeTidyEvidence } from "../../../../../plugins/desk/mcp/src/runtime/workspace-evidence.js"
import { withWorkspaceClaim } from "../../../../../plugins/desk/mcp/src/runtime/workspace-claim.js"
const boot = createRequire(import.meta.url)("../../../../../plugins/desk/hooks/boot-checks.cjs")

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/runtime/workspace-tidy.js", import.meta.url)
const tidy = await import(moduleUrl).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
  return {}
})
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim()

async function fixture() {
  const root = await mkTempRoot("desk-workspace-tidy-")
  const desk = path.join(root, "desk")
  const repo = path.join(root, "repo")
  const remote = path.join(root, "remote.git")
  for (const dir of [desk, repo]) {
    await fs.mkdir(dir)
    git(dir, "init", "-b", "main")
    git(dir, "config", "user.name", "Fixture")
    git(dir, "config", "user.email", "fixture@example.invalid")
    await fs.writeFile(path.join(dir, "tracked"), "base\n")
    git(dir, "add", "tracked")
    git(dir, "commit", "-m", "base")
  }
  git(root, "init", "--bare", remote)
  git(repo, "remote", "add", "origin", remote)
  git(repo, "push", "-u", "origin", "main")
  const card = path.join(desk, "track", "task", "task.md")
  await fs.mkdir(path.dirname(card), { recursive: true })
  await fs.writeFile(card, `---\nstatus: done\nupdated: "${new Date().toISOString()}"\nrepos:\n  - name: repo\n    local_path: ${JSON.stringify(repo)}\n    mode: local\n---\n`)
  return { root, desk, repo, remote, card }
}

async function worktree(f, branch = "topic") {
  const directory = path.join(f.root, branch)
  git(f.repo, "worktree", "add", "-b", branch, directory, "main")
  const admin = git(directory, "rev-parse", "--absolute-git-dir")
  const info = await fs.stat(directory)
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  await once(child, "spawn")
  const start = await readProcessStart(child.pid)
  child.kill()
  await once(child, "exit")
  const record = {
    version: 2, task: path.relative(f.desk, f.card), owner: "task/attempt-1", disposition: "remove",
    repository: git(f.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    worktree: directory, branch: `refs/heads/${branch}`, head: git(directory, "rev-parse", "HEAD"),
    base: "refs/heads/main", delivered: git(f.repo, "rev-parse", "main"),
    identity: { dev: info.dev, ino: info.ino },
    release: { complete: true, host: "fixture", machine: os.hostname(), evidence: "host-operation/1", consumers: [], processes: [{ pid: child.pid, start }] },
  }
  const receipt = path.join(admin, "desk-closeout.json")
  const save = () => fs.writeFile(receipt, JSON.stringify(record), { mode: 0o600 })
  await save()
  return { directory, admin, record, receipt, save }
}

test("workspace tidy exposes the deferred repair and bounded inventory", () => {
  assert.equal(typeof tidy.inspectWorkspace, "function")
  assert.equal(typeof tidy.repairWorkspace, "function")
})

test("removes an exactly released clean merged worktree and its local branch, twice", async () => {
  const f = await fixture()
  for (const branch of ["first", "second"]) {
    const w = await worktree(f, branch)
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 1)
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
  ["identity", async (f, w) => { w.record.identity.ino += 1; await w.save() }],
  ["retained", async (f, w) => { w.record.disposition = "retained-with-trigger"; await w.save() }],
  ["writer", async (f, w) => { w.record.release.processes = [{ pid: process.pid, start: await readProcessStart(process.pid) }]; await w.save() }],
  ["writer", async (f, w) => { w.record.release.complete = false; await w.save() }],
  ["writer", async (f, w) => { w.record.release.processes = []; await w.save() }],
  ["consumer", async (f, w) => { w.record.release.consumers = ["remote-job"]; await w.save() }],
  ["detached", async (f, w) => git(w.directory, "switch", "--detach")],
  ["protected", async (f, w) => git(w.directory, "config", "desk.protected", "true")],
  ["ownership", async (f, w) => fs.writeFile(w.receipt, "{broken")],
  ["ownership", async (f, w) => { await fs.rename(w.receipt, `${w.receipt}.real`); await fs.symlink(`${w.receipt}.real`, w.receipt) }],
]
for (const [reason, mutate] of refusals) {
  test(`refuses ${reason}: ${mutate.toString().slice(17, 86)}`, async () => {
    const f = await fixture()
    const w = await worktree(f)
    await mutate(f, w)
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 0)
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
  assert.equal(result.removed.length, 0)
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
  assert.equal(result.removed.length, 1)
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
  assert.equal(result.removed.length, 1)
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
  assert.equal(result.removed.length, 1)
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
  assert.equal(result.removed.length, 0)
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
  assert.equal(result.removed.length, 0)
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
      handle.stat = async () => ({ ...await stat(), ino: -1 })
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
  assert.equal(result.removed.length, 1)
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
  assert.equal(result.removed.length, 0)
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
  assert.deepEqual(tidy.parseWorktrees("worktree /a\0HEAD abc\0unknown future\0\0", "/repo"), [{ repository: "/repo", path: "/a", head: "abc" }])
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
    assert.equal(result.removed.length, 0)
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
    assert.equal(result.removed.length, 0)
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
    ["admin", /ownership/], ["protected", /policy/], ["status", /inspection/],
    ["unregistered", /registration/], ["receipt", /ownership changed/], ["remove", /removal refused/],
    ["absence", /absence unverified/], ["prunable", /missing/],
  ]) {
    let lists = 0
    const run = async (cwd, args) => {
      if (fault === "admin" && args.includes("--absolute-git-dir")) return { ok: true, stdout: w.record.repository }
      if (fault === "protected" && args.includes("desk.protected")) return { ok: false, code: 128 }
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
  const fail = t.mock.method(fs, "lstat", (file) => file === path.join(w.admin, "index.lock")
    ? Promise.reject(Object.assign(new Error("operation state unreadable"), { code: "EACCES" })) : lstat(file))
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
  assert.equal(result.removed.length, 0)
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

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`R1 preserves tracked bytes hidden by ${flag}`, async () => {
    const f = await fixture()
    const w = await worktree(f)
    git(w.directory, "update-index", flag, "tracked")
    await fs.writeFile(path.join(w.directory, "tracked"), "uncommitted irreplaceable bytes\n")
    assert.equal(git(w.directory, "status", "--porcelain=v1"), "")
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 0)
    assert.match(result.left[0].reason, /index.*flags/)
    assert.equal(await fs.readFile(path.join(w.directory, "tracked"), "utf8"), "uncommitted irreplaceable bytes\n")
    assert.equal(git(w.directory, "rev-parse", "HEAD"), w.record.head)
  })
}

test("R4 symlinked task card stops traversal into code and evidence", async () => {
  const f = await fixture()
  const other = await fixture()
  const original = await fs.readFile(f.card, "utf8")
  const target = path.join(f.root, "outside-card.md")
  await fs.writeFile(target, original)
  await fs.unlink(f.card)
  await fs.symlink(target, f.card)
  const nested = path.join(path.dirname(f.card), "repo", "cache", "task.md")
  await fs.mkdir(path.dirname(nested), { recursive: true })
  await fs.writeFile(nested, await fs.readFile(other.card, "utf8"))
  const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
  assert.equal(result.complete, true)
  assert.deepEqual(result.issues, ["1 task card skipped: track/task/task.md (not a regular file)"])
  assert.ok(!result.cards.includes(nested))
  assert.ok(!result.repositories.includes(other.repo))
})

test("R6 real canonical serializer supports nested paths and long folded tilde paths", async () => {
  const f = await fixture()
  const long = path.join(f.root, "long portable workspace ".repeat(5), "repo")
  await fs.mkdir(path.dirname(long), { recursive: true })
  await fs.rename(f.repo, long)
  for (const value of [
    { name: "repo", local_path: `~/${path.relative(f.root, long)}`, mode: "local" },
    { name: "repo", local_path: `~/${path.relative(f.root, long)}`, mode: "local", paths: ["src/**", "test/**"], metadata: { branches: ["one", "two"] } },
  ]) {
    const body = serializeMarkdown({ status: "processing", repos: [value, { name: "remote", mode: "remote", local_path: "", paths: ["a"] }] }, "")
    assert.match(body, /local_path: >-/)
    await fs.writeFile(f.card, body)
    const result = await tidy.inspectWorkspace({ deskRoot: f.desk, homeDir: f.root, budgetMs: 5000 })
    assert.equal(result.complete, true, result.issues.join("; "))
    assert.deepEqual(result.repositories, [f.desk, long])
  }
})

test("R2 exclusive cleanup claim refuses compliant revocation and consumer reacquisition", async () => {
  assert.equal(typeof tidy.revokeWorkspaceRelease, "function")
  const f = await fixture()
  const w = await worktree(f)
  let statusCount = 0
  let revoked = false
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "status" && ++statusCount === 2) {
      await assert.rejects(tidy.revokeWorkspaceRelease({
        repository: w.record.repository, worktree: w.directory, branch: w.record.branch, owner: w.record.owner,
      }), /claimed/)
      revoked = true
    }
    return result
  }
  const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
  assert.equal(revoked, true)
  assert.equal(result.removed.length, 1)
})

test("R2 revoked release before cleanup preserves a live reacquired consumer", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await tidy.revokeWorkspaceRelease({
    repository: w.record.repository, worktree: w.directory, branch: w.record.branch, owner: w.record.owner,
  })
  const consumer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: w.directory, stdio: "ignore" })
  await once(consumer, "spawn")
  try {
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 0)
    assert.match(result.left[0].reason, /ownership/)
    assert.ok((await fs.stat(w.directory)).isDirectory())
    assert.equal(consumer.exitCode, null)
  } finally { consumer.kill(); await once(consumer, "exit") }
})

test("R2 raw receipt revocation after final status is observed before removal", async () => {
  const f = await fixture()
  const w = await worktree(f)
  let count = 0
  let consumer
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "status" && ++count === 2) {
      await fs.unlink(w.receipt)
      consumer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: w.directory, stdio: "ignore" })
      await once(consumer, "spawn")
    }
    return result
  }
  try {
    const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
    assert.equal(result.removed.length, 0)
    assert.ok((await fs.stat(w.directory)).isDirectory())
    assert.equal(consumer.exitCode, null)
  } finally { if (consumer) { consumer.kill(); await once(consumer, "exit") } }
})

test("R2 atomic expected-head deletion preserves a reacquired ref already merged on main", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await fs.writeFile(path.join(f.repo, "tracked"), "new base")
  git(f.repo, "commit", "-am", "new base")
  const newHead = git(f.repo, "rev-parse", "HEAD")
  let changed = false
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "rev-parse" && args.includes("--quiet") && args.includes(w.record.branch)) {
      git(f.repo, "update-ref", w.record.branch, newHead)
      changed = true
    }
    return result
  }
  const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
  assert.equal(changed, true)
  assert.equal(result.removed.length, 1)
  assert.equal(result.removed[0].branchRemoved, false)
  assert.equal(git(f.repo, "rev-parse", "topic"), newHead)
})

async function squashFixture() {
  const f = await fixture()
  const w = await worktree(f)
  await fs.writeFile(path.join(w.directory, "tracked"), "squash delivery\n")
  git(w.directory, "commit", "-am", "topic")
  git(w.directory, "push", "origin", "topic")
  git(f.repo, "merge", "--squash", "topic")
  git(f.repo, "commit", "-m", "squash")
  git(f.repo, "push", "origin", "main")
  w.record.head = git(w.directory, "rev-parse", "HEAD")
  w.record.delivered = git(f.repo, "rev-parse", "main")
  w.record.base = "refs/remotes/origin/main"
  w.record.remote = { name: "origin", branch: "refs/heads/topic", endpoint: pathToFileURL(f.remote).href }
  await w.save()
  return { f, w }
}

test("R7 push repository, not fetch URL, decides remote deletion", async () => {
  const { f, w } = await squashFixture()
  const fork = path.join(f.root, "fork.git")
  git(f.root, "init", "--bare", fork)
  git(f.repo, "remote", "set-url", "--push", "origin", fork)
  git(w.directory, "push", "origin", "topic")
  // The upstream delivery exists but its topic is absent; the actual push
  // repository still owns topic and must veto cleanup.
  git(f.root, "--git-dir", f.remote, "update-ref", "-d", "refs/heads/topic")
  w.record.remote.endpoint = pathToFileURL(fork).href
  await w.save()
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 0)
  assert.match(result.left[0].reason, /remote branch exists/)
  assert.ok(git(f.root, "--git-dir", fork, "rev-parse", "topic"))
})

test("R7 changed and multiple push endpoints cannot reuse a release receipt", async () => {
  const { f, w } = await squashFixture()
  const unrelated = path.join(f.root, "unrelated.git")
  git(f.root, "init", "--bare", unrelated)
  git(f.repo, "remote", "set-url", "origin", unrelated)
  const changed = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(changed.removed.length, 0)
  assert.match(changed.left[0].reason, /endpoint.*changed/)
  git(f.repo, "remote", "set-url", "origin", f.remote)
  git(f.repo, "remote", "set-url", "--add", "--push", "origin", unrelated)
  git(f.repo, "remote", "set-url", "--add", "--push", "origin", f.remote)
  const multiple = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(multiple.removed.length, 0)
  assert.match(multiple.left[0].reason, /ambiguous.*push/)
  assert.ok((await fs.stat(w.directory)).isDirectory())
})

test("R7 an exact delivery endpoint cannot be rewritten to another repository for inspection", async () => {
  const { f } = await squashFixture()
  const unrelated = path.join(f.root, "unrelated.git")
  git(f.root, "init", "--bare", unrelated)
  git(f.repo, "config", `url.${unrelated}.insteadOf`, pathToFileURL(f.remote).href)
  assert.equal(git(f.repo, "remote", "get-url", "--push", "origin"), f.remote)
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 0)
  assert.match(result.left[0].reason, /query endpoint.*changed/)
  assert.ok(git(f.root, "--git-dir", f.remote, "rev-parse", "topic"))
})

test("R3 two repairs preserve squash branch and removed-resource evidence until canonical acknowledgement", async () => {
  const { f, w } = await squashFixture()
  git(f.repo, "push", "origin", "--delete", "topic")
  const first = await boot.runRepair(f.desk)
  assert.equal(first.removed.length, 1)
  assert.match(first.left[0].reason, /branch retained/)
  const second = await boot.runRepair(f.desk)
  assert.equal(second.removed.length, 1)
  assert.match(second.left[0].reason, /branch retained/)
  assert.equal(git(f.repo, "rev-parse", "topic"), w.record.head)
  const file = boot.reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  const persisted = await boot.readReport(file)
  assert.equal(persisted.removed.length, 1)
  assert.equal(persisted.resources[0].receipt.release.evidence, w.record.release.evidence)
  const resource = persisted.resources[0]
  await assert.rejects(boot.acknowledgeRepair(f.desk, { id: resource.id, digest: "stale", canonicalEvidence: "task.md#resources" }), /changed/)
  const acknowledged = await boot.acknowledgeRepair(f.desk, { id: resource.id, digest: resource.digest, canonicalEvidence: "task.md#resources" })
  assert.equal(acknowledged.resources.length, 0)
  const third = await boot.runRepair(f.desk)
  assert.deepEqual(third.left, [])
  assert.deepEqual(third.removed, [])
  assert.equal(git(f.repo, "rev-parse", "topic"), w.record.head)
})

test("cards with no repos, or repos Desk cannot read, among valid ones never stop the tidy for the desk", async () => {
  const f = await fixture()
  const plain = path.join(f.desk, "track", "no-repos-field", "task.md")
  const broken = path.join(f.desk, "track", "unreadable-repos", "task.md")
  const other = path.join(f.desk, "track", "unreadable-too", "task.md")
  for (const [file, body] of [
    [plain, "---\nstatus: processing\n---\n"],
    [broken, "---\nstatus: processing\nrepos: [{mode: local}]\n---\n"],
    [other, "---\nstatus: processing\nrepos:\n  - mode: local\n    local_path: ./relative\n---\n"],
  ]) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body)
  }
  const inventory = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
  assert.equal(inventory.complete, true)
  assert.deepEqual(inventory.issues, ["2 task cards with unreadable repos: track/unreadable-repos/task.md (repos list not readable), track/unreadable-too/task.md (repo ./relative is not an absolute or ~/ path); their repositories were not inspected"])
  assert.deepEqual(inventory.cardRecords[plain].repositories, [f.desk], "no repos field: the desk only")
  assert.ok(inventory.repositories.includes(await fs.realpath(f.repo)), "the valid card's repository is still inspected")

  const w = await worktree(f, "still-tidied")
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.deepEqual(result.removed.map((entry) => entry.path), [w.directory])
})

test("R8 a desk bound through a symlink alias is the same desk: task lookup, report, lock and next boot agree", async () => {
  const f = await fixture()
  const alias = path.join(f.root, "desk-alias")
  await fs.symlink(f.desk, alias)
  const direct = await worktree(f, "direct")
  const result = await tidy.repairWorkspace({ deskRoot: alias })
  assert.deepEqual(result.left, [], "the receipt's task resolves under the alias exactly as under the real path")
  assert.equal(result.removed[0].path, direct.directory)

  const viaHook = await worktree(f, "via-hook")
  const repaired = await boot.runRepair(alias)
  assert.equal(repaired.removed[0].path, viaHook.directory)
  assert.equal(repaired.root, f.desk, "the report's identity is the real path")
  const file = boot.reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  const persisted = await boot.readReport(file)
  assert.equal(persisted.root, f.desk)
  assert.equal("bound" in persisted, false, "the report stores one identity, the real path")
  assert.equal((await boot.runRepair(f.desk)).root, f.desk, "the real path reaches the same report")

  const env = { ...process.env, DESK: alias, DESK_ACTIVATION_CONFIG: "", HOME: f.root }
  const boots = async () => {
    let line
    for (let attempt = 0; attempt < 20; attempt += 1) {
      line = await boot.runBootChecks({ host: "claude", env, launch: async () => {} })
      if (!line.includes("budget exceeded")) break
    }
    return line
  }
  assert.match(await boots(), /Last repair: Tidied 1 stale worktrees/, "the next boot through the alias finds the repair's report")
  await fs.writeFile(`${file}.lock`, "another-owner")
  assert.match(await boots(), /repair lock/, "and the lock the repair holds")
  assert.deepEqual(await boot.runRepair(alias), { busy: true, lock: `${file}.lock` })
  await fs.unlink(`${file}.lock`)

  // A report written before roots were canonical names the alias; it still belongs to this desk.
  await fs.writeFile(file, JSON.stringify({ ...persisted, root: alias }))
  assert.match(await boots(), /Last repair:/)

  // An issue the last repair already named is not repeated in the live part of the line.
  await fs.mkdir(path.join(f.desk, "track", "unfinished"), { recursive: true })
  await fs.writeFile(path.join(f.desk, "track", "unfinished", "task.md"), "---\ntitle: unfinished\n---\n")
  const issue = "1 task card skipped: track/unfinished/task.md (no readable status)"
  assert.ok((await boots()).includes(`deferred (0 listed); ${issue}`), "a live issue the report lacks is named")
  await fs.writeFile(file, JSON.stringify({ ...persisted, issues: [issue] }))
  const line = await boots()
  assert.equal(line.split(issue).length - 1, 1, line)
})

test("inspection combines its cancellation signals without AbortSignal.any, and releases its listeners", async (t) => {
  const original = AbortSignal.any
  t.after(() => { AbortSignal.any = original })
  AbortSignal.any = undefined
  const f = await fixture()
  const outer = new AbortController()
  const blocked = []
  const stalled = (cwd, args, options) => new Promise((resolve) => {
    blocked.push(options.signal)
    options.signal.addEventListener("abort", () => resolve({ ok: false, stdout: "", code: 1 }))
  })
  const pending = tidy.inspectWorkspace({ deskRoot: f.desk, git: stalled, budgetMs: 5_000, signal: outer.signal })
  while (blocked.length === 0) await new Promise((resolve) => setImmediate(resolve))
  outer.abort(new Error("host deadline"))
  const inventory = await pending
  assert.equal(inventory.complete, false)
  assert.equal(blocked[0].aborted, true, "the caller's abort reaches the running Git inspection")
  assert.equal(blocked[0].reason.message, "host deadline")

  const early = new AbortController()
  early.abort("already")
  const combined = tidy.anySignal([undefined, early.signal, new AbortController().signal])
  assert.equal(combined.signal.aborted, true)
  assert.equal(combined.signal.reason, "already")

  const first = new AbortController()
  const second = new AbortController()
  const removed = []
  const watch = (controller) => {
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.removeEventListener = (type, listener) => { removed.push(type); remove(type, listener) }
  }
  watch(first)
  watch(second)
  const live = tidy.anySignal([first.signal, second.signal])
  assert.equal(live.signal.aborted, false)
  second.abort("second")
  assert.equal(live.signal.reason, "second")
  assert.deepEqual(removed, ["abort", "abort"], "both listeners are removed once one signal aborts")
  const idle = tidy.anySignal([new AbortController().signal])
  idle.cleanup()
  idle.cleanup()
  assert.equal(idle.signal.aborted, false)
})

test("R3 cleanup requires persisted pending evidence before destructive removal", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const states = []
  const result = await tidy.repairWorkspace({
    deskRoot: f.desk,
    onDisposition: async (entry) => { states.push(entry.state); throw new Error("evidence store unavailable") },
  })
  assert.deepEqual(states, ["cleanup_pending"])
  assert.equal(result.removed.length, 0)
  assert.match(result.left[0].reason, /evidence store/)
  assert.ok((await fs.stat(w.directory)).isDirectory())
})

test("R2 legacy receipts and mismatched revocation owners remain report-only", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await assert.rejects(tidy.revokeWorkspaceRelease({ ...w.record, owner: "different" }), /ownership mismatch/)
  w.record.version = 1
  await w.save()
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 0)
  assert.match(result.left[0].reason, /ownership/)
})

test("R2 late changed receipt and failed revocation absence are explicit refusals", async (t) => {
  const f = await fixture()
  const w = await worktree(f)
  let count = 0
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "status" && ++count === 2) {
      w.record.owner = "new owner"
      await w.save()
    }
    return result
  }
  const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
  assert.equal(result.removed.length, 0)
  assert.match(result.left[0].reason, /release.*changed/)
  const unlink = fs.unlink.bind(fs)
  const mock = t.mock.method(fs, "unlink", (file) => file === w.receipt ? Promise.resolve() : unlink(file))
  await assert.rejects(tidy.revokeWorkspaceRelease(w.record), /absence unverified/)
  mock.mock.restore()
})

test("R6 canonical nested paths alone work and malformed repository indentation leaves that card's repositories uninspected", async () => {
  const f = await fixture()
  await fs.writeFile(f.card, serializeMarkdown({
    status: "processing", repos: [{ name: "repo", local_path: "~/repo", mode: "local", paths: ["src/**"] }],
  }, ""))
  assert.equal((await tidy.inspectWorkspace({ deskRoot: f.desk, homeDir: f.root, budgetMs: 5000 })).complete, true)
  for (const body of [
    "---\nstatus: processing\nrepos:\n  invalid: map\n---",
    "---\nstatus: processing\nrepos:\n  invalid: map\n  - mode: remote\n---",
    "---\nstatus: processing\nrepos:\n  - mode: remote\n bad-indent: x\n---",
  ]) {
    await fs.writeFile(f.card, body)
    const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
    assert.deepEqual(result.cardRecords[f.card].repositories, [], "the malformed card authorizes nothing")
    assert.match(result.issues.join(" "), /1 task card with unreadable repos/)
  }
  await fs.writeFile(f.card, "---\nstatus: processing\nrepos:\n  - mode: remote\n\n\n---")
  assert.equal((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).complete, true)
})

test("F1-I01 near-boundary history accepts safe cleanup, remains readable, acknowledges and resumes", async (t) => {
  const f = await fixture()
  const w = await worktree(f)
  await fs.unlink(w.receipt)
  await withWorkspaceClaim(w.record, () => w.save())
  const limit = 1_048_576
  const historical = []
  const historyReport = () => ({ ...mergeTidyEvidence({ resources: historical }), root: f.desk, updated: new Date().toISOString() })
  for (let index = 0; ; index += 1) {
    const receipt = { ...structuredClone(w.record), worktree: path.join(f.root, `history-${index}`), branch: `refs/heads/history-${index}`, owner: `history/attempt-${index}` }
    historical.push(dispositionRecord(receipt, "removed", true))
    if (Buffer.byteLength(JSON.stringify(historyReport())) > limit - 512) { historical.pop(); break }
  }
  const spare = limit - 256 - Buffer.byteLength(JSON.stringify(historyReport()))
  const last = historical.at(-1)
  last.receipt.release.evidence += "x".repeat(Math.floor(spare / 2))
  historical[historical.length - 1] = dispositionRecord(last.receipt, "removed", true)
  const before = JSON.stringify(historyReport())
  assert.ok(Buffer.byteLength(before) >= limit - 258 && Buffer.byteLength(before) < limit)
  const file = boot.reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  await fs.writeFile(file, before)

  const result = await boot.runRepair(f.desk)
  assert.ok(result.removed.some((entry) => entry.path === w.directory))
  await assert.rejects(fs.stat(w.directory), { code: "ENOENT" })
  const readable = await boot.readReport(file)
  assert.ok((await fs.stat(file)).size <= limit)
  t.diagnostic(JSON.stringify({ historicalResources: historical.length, bytesBefore: Buffer.byteLength(before), bytesAfter: (await fs.stat(file)).size, acceptedCleanup: true }))
  assert.deepEqual(readable.resources.filter((entry) => entry.path !== w.directory), historical)
  const current = readable.resources.find((entry) => entry.path === w.directory)
  await boot.acknowledgeRepair(f.desk, { id: current.id, digest: current.digest, canonicalEvidence: "task.md#resources" })
  const drained = await boot.readReport(file)
  assert.deepEqual(drained.resources, historical)
  const later = await worktree(f, "later")
  const resumed = await boot.runRepair(f.desk)
  assert.ok(resumed.removed.some((entry) => entry.path === later.directory))
  assert.ok((await fs.stat(file)).size <= limit)
  assert.equal((await boot.readReport(file)).resources.length, historical.length + 1)
})

test("F1-I01 exhausted canonical capacity refuses before cleanup and acknowledgement releases capacity", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const historical = []
  const seed = () => ({ format: "workspace-tidy-compact-v1", resources: historical, issues: [], root: f.desk, updated: new Date().toISOString(), line: "" })
  for (let index = 0; ; index += 1) {
    const receipt = { ...structuredClone(w.record), worktree: path.join(f.root, `history-${index}`), branch: `refs/heads/history-${index}`, owner: `history/attempt-${index}` }
    historical.push(dispositionRecord(receipt, "removed", true))
    if (Buffer.byteLength(JSON.stringify(seed())) > 1_048_000) { historical.pop(); break }
  }
  const last = historical.at(-1)
  last.receipt.release.evidence += "x".repeat(1_048_512 - Buffer.byteLength(JSON.stringify(seed())))
  historical[historical.length - 1] = dispositionRecord(last.receipt, "removed", true)
  const before = JSON.stringify(seed())
  assert.equal(Buffer.byteLength(before), 1_048_512)
  const file = boot.reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  await fs.writeFile(file, before)
  await assert.rejects(boot.runRepair(f.desk), /capacity/)
  assert.ok((await fs.stat(w.directory)).isDirectory())
  assert.equal(git(w.directory, "rev-parse", "HEAD"), w.record.head)
  assert.equal(await fs.readFile(file, "utf8"), before)
  assert.deepEqual((await boot.readReport(file)).resources, historical)
  for (const entry of historical.slice(0, 4)) {
    await boot.acknowledgeRepair(f.desk, { id: entry.id, digest: entry.digest, canonicalEvidence: "task.md#resources" })
  }
  const resumed = await boot.runRepair(f.desk)
  assert.ok(resumed.removed.some((entry) => entry.path === w.directory))
  const after = await boot.readReport(file)
  assert.deepEqual(after.resources.filter((entry) => entry.path !== w.directory), historical.slice(4))
  assert.ok((await fs.stat(file)).size <= 1_048_576)
})

test("the unreadable-repos issue names the first three cards in order and counts the rest", async () => {
  const f = await fixture()
  for (const name of ["e", "d", "c", "b", "a"]) {
    const file = path.join(f.desk, "track", name, "task.md")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `---\nstatus: processing\nrepos:\n  - mode: local\n    local_path: ~/missing-${name}\n---\n`)
  }
  const { issues } = await tidy.inspectWorkspace({ deskRoot: f.desk, homeDir: f.root, budgetMs: 5000 })
  assert.deepEqual(issues, ["5 task cards with unreadable repos: track/a/task.md (repo ~/missing-a not found), track/b/task.md (repo ~/missing-b not found), track/c/task.md (repo ~/missing-c not found), and 2 more; their repositories were not inspected"])
})
