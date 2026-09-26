import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkTempRoot } from "../_temp_roots.js"
import { readProcessStart } from "../../src/readiness/process-start.js"
import { readInspectionGit } from "../../src/runtime/git-inspection.js"
import { serializeMarkdown } from "../../src/util/fm.js"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
const boot = createRequire(import.meta.url)("../../../hooks/boot-checks.cjs")

const moduleUrl = new URL("../../src/runtime/workspace-tidy.js", import.meta.url)
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
    const result = await readInspectionGit(cwd, args, {})
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
    const result = await readInspectionGit(cwd, args, {})
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
    return readInspectionGit(cwd, args, {})
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

test("malformed, inaccessible and oversized cards fail closed without broadening scope", async (t) => {
  const f = await fixture()
  const original = await fs.readFile(f.card, "utf8")
  for (const [body, reason] of [
    ["---\nrepos: []\n---", /status/],
    ['---\nstatus: processing\nrepos: [{mode: local}]\n---', /block list/],
    ['---\nstatus: processing\nrepos:\n  - local_path: "/x"\n---', /mode/],
    ['---\nstatus: processing\nrepos:\n  - mode: local\n---', /path missing/],
    ['---\nstatus: processing\nrepos:\n  - mode: local\n    local_path: ./relative\n---', /unresolved/],
    ["x".repeat(65537), /oversized/],
  ]) {
    await fs.writeFile(f.card, body)
    const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
    assert.equal(result.complete, false)
    assert.match(result.issues.join(" "), reason)
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
  assert.match((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).issues[0], /identity changed/)
  mock.mock.restore()
  const growing = t.mock.method(fs, "open", async (file, ...args) => {
    if (file === f.card) await fs.appendFile(file, "x".repeat(65537))
    return open(file, ...args)
  })
  assert.match((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).issues[0], /oversized/)
  growing.mock.restore()
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
    const run = (cwd, args) => args[0] === command ? Promise.resolve({ ok: false, code: 128 }) : readInspectionGit(cwd, args, {})
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
      const result = await readInspectionGit(cwd, args, {})
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
  assert.equal(result.complete, false)
  assert.match(result.issues[0], /unsafe/)
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
    const result = await readInspectionGit(cwd, args, {})
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
    const result = await readInspectionGit(cwd, args, {})
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
    const result = await readInspectionGit(cwd, args, {})
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
    const result = await readInspectionGit(cwd, args, {})
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

test("R6 canonical nested paths alone work and malformed repository indentation refuses", async () => {
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
    assert.equal((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).complete, false)
  }
  await fs.writeFile(f.card, "---\nstatus: processing\nrepos:\n  - mode: remote\n\n\n---")
  assert.equal((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).complete, true)
})
