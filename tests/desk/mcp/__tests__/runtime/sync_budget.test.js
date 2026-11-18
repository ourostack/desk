// The sync budget: a Desk save returns in under a second on a repository the size of the CIT desk (about 12,000 files) even
// when a post-commit hook (Git LFS's whole-tree walk) takes seconds, a failed sync says why and what to do, a transient failure
// is retried, and a stuck sync never holds up the next save.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { commitPaths, stagePaths } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
import { installSessionTrailerHooks } from "../../../../../plugins/desk/mcp/src/runtime/session-trailer.js"
import { fastGitAnswer, readUpstreamRefs, stripspace } from "../../../../../plugins/desk/mcp/src/runtime/fast-refs.js"
import { fetchAhead, syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { lfsSkipEnv } from "../../../../../plugins/desk/mcp/src/runtime/deliver.js"
import { acquireSyncLock, readSyncStatus, runPushWorker, runSyncPushCli } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"

const SAVE_BUDGET_MS = 1000
const FILES = 12000
const instantClock = { sleep: () => Promise.resolve() }

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function bigRepo({ slowPostCommit = true } = {}) {
  const origin = await mkTempRoot("desk-budget-origin-")
  git(origin, ["init", "--bare", "-q"])
  const root = await mkTempRoot("desk-budget-")
  git(root, ["clone", "-q", origin, "."])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"])
  for (let dir = 0; dir < 120; dir += 1) {
    const folder = path.join(root, "docs", `d${dir}`)
    mkdirSync(folder, { recursive: true })
    for (let file = 0; file < FILES / 120; file += 1) writeFileSync(path.join(folder, `f${file}.md`), `file ${dir}/${file}\n`)
  }
  mkdirSync(path.join(root, "tasks"), { recursive: true })
  writeFileSync(path.join(root, "tasks", "card.md"), "card\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "seed"])
  git(root, ["push", "-q", "-u", "origin", "main"])
  if (slowPostCommit) {
    const hook = path.join(root, ".git", "hooks", "post-commit")
    writeFileSync(hook, "#!/bin/sh\nsleep 3\n")
    chmodSync(hook, 0o755)
  }
  return { origin, root }
}

function save(root, text) {
  writeFileSync(path.join(root, "tasks", "card.md"), text)
  const staged = stagePaths(root, ["tasks/card.md"], spawnSync)
  assert.equal(staged.ok, true, staged.stderr)
  const started = Date.now()
  const committed = commitPaths(root, ["tasks/card.md"], `save ${text.trim()}`, spawnSync)
  return { committed, ms: Date.now() - started }
}

test("a save on a 12,000-file repository returns in under a second even when the post-commit hook takes seconds", { skip: process.platform === "win32" ? "POSIX hook" : false }, async () => {
  const { root } = await bigRepo()
  save(root, "warm up\n")
  const { committed, ms } = save(root, "one\n")
  assert.equal(committed.ok, true, committed.stderr)
  assert.ok(ms < SAVE_BUDGET_MS, `the save took ${ms} ms; the budget is ${SAVE_BUDGET_MS} ms`)
  assert.match(git(root, ["log", "-1", "--format=%s"]), /save one/u)
})

test("a stuck sync worker never blocks the next save", { skip: process.platform === "win32" ? "POSIX hook" : false }, async () => {
  const { root } = await bigRepo()
  const lock = await acquireSyncLock({ root, env: process.env })
  assert.ok(lock && !lock.refused && !lock.release === false, "the test holds the sync lock, as a worker stuck in a push does")
  try {
    save(root, "warm up\n")
    const { committed, ms } = save(root, "while stuck\n")
    assert.equal(committed.ok, true, committed.stderr)
    assert.ok(ms < SAVE_BUDGET_MS, `the save took ${ms} ms while a sync held the lock`)
  } finally {
    lock.release()
  }
})

test("a transient fetch failure is retried by the worker with backoff and then pushes", async () => {
  const { origin, root } = await bigRepo({ slowPostCommit: false })
  save(root, "to push\n")
  let fetches = 0
  const waits = []
  const spawnGit = (cmd, args, options) => {
    if (args.includes("fetch") && fetches++ < 1) return { status: 128, stdout: "", stderr: "fatal: unable to access 'https://example.invalid/': Could not resolve host: example.invalid\n" }
    return spawnSync(cmd, args, options)
  }
  const clock = { sleep: (ms) => { waits.push(ms); return Promise.resolve() } }
  const result = await runPushWorker({ root, env: process.env, debounceMs: 0, clock, spawnGit, fileProblem: () => assert.fail("a network failure is not a Desk defect") })
  assert.equal(result.result, "ok")
  assert.ok(waits.some((ms) => ms >= 2000), "the worker backed off before trying again")
  assert.match(git(origin, ["log", "-1", "--format=%s", "main"]), /save to push/u)
})

test("a push that keeps failing ends blocked with the cause on the status record and on sync-push's stderr", async () => {
  const { root } = await bigRepo({ slowPostCommit: false })
  save(root, "never pushed\n")
  const spawnGit = (cmd, args, options) => (args.includes("push") ? { status: 1, stdout: "", stderr: "remote: Permission to desk denied\nfatal: unable to access: The requested URL returned error: 403\n" } : spawnSync(cmd, args, options))
  const result = await runPushWorker({ root, env: process.env, debounceMs: 0, clock: instantClock, spawnGit, fileProblem: () => {} })
  assert.equal(result.result, "blocked")
  assert.equal(readSyncStatus({ root, env: process.env }).blocked, true)

  let stderr = ""
  const io = { stdout: { write: () => true }, stderr: { write: (chunk) => { stderr += chunk; return true } } }
  const code = await runSyncPushCli({ argv: ["--root", root], env: process.env, runWorker: async () => result, io })
  assert.notEqual(code, 0)
  assert.match(stderr, /blocked/iu, "the failure is never silent")
  assert.match(stderr, /desk_status/u, "and says where to look next")
})

test("the push skips Git LFS's upload scan only when it can see that no pushed file is an LFS file", () => {
  const skip = { GIT_LFS_SKIP_PUSH: "1" }
  const answer = (diff, attrs) => (args) => (args[0] === "diff" ? diff : attrs)
  const ok = (stdout) => ({ status: 0, stdout })
  const bad = { status: 1, stdout: "" }
  assert.deepEqual(lfsSkipEnv(answer(bad), "a", "b"), {}, "a diff Git cannot read keeps the scan")
  assert.deepEqual(lfsSkipEnv(answer(ok("")), "a", "b"), skip, "nothing changed has nothing to upload")
  assert.deepEqual(lfsSkipEnv(answer(ok("x.md\0"), bad), "a", "b"), {}, "attributes Git cannot read keep the scan")
  assert.deepEqual(lfsSkipEnv(answer(ok("x.png\0"), ok("x.png\0filter\0lfs\0")), "a", "b"), {}, "an LFS file keeps the scan")
  assert.deepEqual(lfsSkipEnv(answer(ok("x.md\0"), ok("x.md\0filter\0unspecified\0")), "a", "b"), skip)
})

test("sync-push says what it does not know when the worker ends in an unrecognized state", async () => {
  let stderr = ""
  const io = { stdout: { write: () => true }, stderr: { write: (chunk) => { stderr += chunk; return true } } }
  const code = await runSyncPushCli({ argv: ["--root", "/tmp/anywhere"], env: process.env, runWorker: async () => ({ result: "weird" }), io })
  assert.notEqual(code, 0)
  assert.match(stderr, /does not know/u)
})

test("Desk's commit and push hooks each run in under 50 ms", { skip: process.platform === "win32" ? "POSIX hooks" : false }, async () => {
  const { root } = await bigRepo({ slowPostCommit: false })
  assert.equal(installSessionTrailerHooks(root).state, "ok")
  const hooks = path.join(root, ".git", "hooks")
  const message = path.join(root, "message.txt")
  writeFileSync(message, "save\n")
  const env = { ...process.env, COPILOT_AGENT_SESSION_ID: "budget-session" }
  const sha = git(root, ["rev-parse", "HEAD"]).trim()
  const fastest = (name, args, input) => {
    const times = []
    for (let run = 0; run < 7; run += 1) {
      const started = process.hrtime.bigint()
      const result = spawnSync(path.join(hooks, name), args, { cwd: root, env, input, encoding: "utf8" })
      times.push(Number(process.hrtime.bigint() - started) / 1e6)
      assert.equal(result.status, 0, result.stderr)
    }
    return Math.min(...times)
  }
  const prepare = fastest("prepare-commit-msg", [message], undefined)
  const push = fastest("pre-push", ["origin", "x"], `refs/heads/f ${sha} refs/heads/f ${sha}\n`)
  assert.ok(prepare < 50, `prepare-commit-msg took ${prepare.toFixed(0)} ms`)
  assert.ok(push < 50, `pre-push took ${push.toFixed(0)} ms`)
})

async function remoteChange(origin, file, text) {
  const other = await mkTempRoot("desk-budget-other-")
  git(other, ["clone", "-q", "-b", "main", origin, "."])
  git(other, ["config", "user.email", "test@example.com"])
  git(other, ["config", "user.name", "Test"])
  writeFileSync(path.join(other, file), text)
  git(other, ["add", "-A"])
  git(other, ["commit", "-q", "-m", "remote change"])
  git(other, ["push", "-q"])
}

const PULL_BUDGET_MS = 1000
const pull = async (root, extra = {}) => {
  const started = Date.now()
  const result = await syncWorkspace({ root, env: process.env, scheduleDelivery: () => assert.fail("nothing is waiting to push"), ...extra })
  return { result, ms: Date.now() - started }
}

test("a pull on a 12,000-file repository takes under a second, and one right after a fetch reads what was fetched", { skip: process.platform === "win32" ? "POSIX paths" : false }, async () => {
  const { origin, root } = await bigRepo({ slowPostCommit: false })
  await remoteChange(origin, "docs/d0/new.md", "from the remote\n")
  const behind = await pull(root)
  assert.equal(behind.result.state, "synced")
  assert.equal(readFileSync(path.join(root, "docs", "d0", "new.md"), "utf8"), "from the remote\n")
  assert.ok(behind.ms < PULL_BUDGET_MS, `a pull that fetched and fast-forwarded took ${behind.ms} ms; the budget is ${PULL_BUDGET_MS} ms`)

  await remoteChange(origin, "docs/d0/newer.md", "later\n")
  const fresh = await pull(root)
  assert.equal(fresh.result.state, "synced")
  assert.equal(git(root, ["ls-files", "docs/d0/newer.md"]), "", "a pull within the fetch cadence does not ask the remote again")
  assert.ok(fresh.ms < 250, `a pull of what was already fetched took ${fresh.ms} ms`)

  const later = await pull(root, { now: () => Date.now() + 60_000 })
  assert.equal(later.result.state, "synced")
  assert.equal(readFileSync(path.join(root, "docs", "d0", "newer.md"), "utf8"), "later\n")
})

test("a pull moves the checkout even when the index holds stale file stamps", { skip: process.platform === "win32" ? "POSIX paths" : false }, async () => {
  const { origin, root } = await bigRepo({ slowPostCommit: false })
  await remoteChange(origin, "docs/d1/f1.md", "changed upstream\n")
  const stamp = new Date(Date.now() + 5000)
  utimesSync(path.join(root, "docs", "d1", "f1.md"), stamp, stamp)
  const { result } = await pull(root)
  assert.equal(result.state, "synced")
  assert.equal(readFileSync(path.join(root, "docs", "d1", "f1.md"), "utf8"), "changed upstream\n")
})

test("the branch and upstream are read from .git for a plain checkout and a linked worktree, and null whenever Git has to be asked", async () => {
  const { root } = await bigRepo({ slowPostCommit: false })
  const head = git(root, ["rev-parse", "HEAD"]).trim()
  const plain = readUpstreamRefs(root)
  assert.deepEqual(plain, { branch: "main", remote: "origin", merge: "refs/heads/main", tracking: "refs/remotes/origin/main", head, target: head })
  git(root, ["pack-refs", "--all"])
  assert.equal(readUpstreamRefs(root).target, head, "a packed ref is read too")

  const linked = path.join(await mkTempRoot("desk-budget-linked-"), "w")
  git(root, ["worktree", "add", "-q", "-b", "feature", linked, "main"])
  assert.equal(readUpstreamRefs(linked), null, "a branch with no upstream is Git's to answer")
  git(linked, ["branch", "--set-upstream-to=origin/main"])
  assert.equal(readUpstreamRefs(linked).branch, "feature")
  assert.equal(readUpstreamRefs(linked).target, head)
  git(linked, ["checkout", "-q", "--detach"])
  assert.equal(readUpstreamRefs(linked), null, "a detached HEAD has no branch")

  git(root, ["config", "branch.main.remote", "."])
  assert.equal(readUpstreamRefs(root), null, "a branch that follows a local branch has no remote-tracking ref")
  git(root, ["config", "branch.main.remote", "origin"])
  git(root, ["update-ref", "-d", "refs/remotes/origin/main"])
  assert.equal(readUpstreamRefs(root), null, "an upstream that was never fetched")
  assert.equal(readUpstreamRefs(await mkTempRoot("desk-budget-none-")), null, "not a git checkout")
  const apart = await mkTempRoot("desk-budget-apart-")
  git(apart, ["init", "-q", "-b", "main", "--separate-git-dir", path.join(await mkTempRoot("desk-budget-gitdir-"), "g")])
  assert.equal(readUpstreamRefs(apart), null, "a checkout whose git directory is kept elsewhere is read, and has no upstream here")
  const broken = await mkTempRoot("desk-budget-broken-")
  writeFileSync(path.join(broken, ".git"), "not a pointer\n")
  assert.equal(readUpstreamRefs(broken), null, "a .git file that points nowhere")
})

// Each git process costs 100-250 ms on a loaded machine, so the count per step is pinned: a step that adds a process fails here.
async function countGit(run) {
  const bin = await mkTempRoot("desk-budget-bin-")
  const log = path.join(bin, "count.log")
  const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`)
  chmodSync(path.join(bin, "git"), 0o755)
  const saved = { PATH: process.env.PATH, GIT_LFS_SKIP_SMUDGE: process.env.GIT_LFS_SKIP_SMUDGE }
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`
  try {
    await run()
  } finally {
    process.env.PATH = saved.PATH
  }
  let lines = []
  try { lines = readFileSync(log, "utf8").split("\n").filter(Boolean) } catch {}
  return lines
}

const PULL_PROCESSES = 2
const SAVE_PROCESSES = 17

test("a pull the background fetch prepared starts at most two git processes, and a save a bounded number", { skip: process.platform === "win32" ? "POSIX paths" : false }, async () => {
  const { origin, root } = await bigRepo({ slowPostCommit: false })
  await pull(root)
  await remoteChange(origin, "docs/d0/new.md", "from the remote\n")
  await fetchAhead({ root, env: process.env })
  const behind = await countGit(() => pull(root))
  assert.equal(readFileSync(path.join(root, "docs", "d0", "new.md"), "utf8"), "from the remote\n")
  assert.ok(behind.length <= PULL_PROCESSES, `a pull with something new started ${behind.length} git processes: ${behind.join(" | ")}`)
  const noop = await countGit(() => pull(root))
  assert.ok(noop.length <= 1, `a no-op pull started ${noop.length} git processes: ${noop.join(" | ")}`)

  const saved = await countGit(async () => { const made = save(root, "counted\n"); assert.equal(made.committed.ok, true, JSON.stringify(made.committed)) })
  assert.ok(saved.length <= SAVE_PROCESSES, `a save started ${saved.length} git processes: ${saved.join(" | ")}`)
})

test("hooks, gpgSign and stripspace are answered from files only when that is certain, and match Git", { skip: process.platform === "win32" ? "POSIX paths" : false }, async () => {
  const { root } = await bigRepo({ slowPostCommit: false })
  const hookRun = (name) => fastGitAnswer(root, ["hook", "run", "--ignore-missing", name])
  assert.equal(hookRun("pre-commit")?.skipped, true, "no hook file means nothing to run")
  writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n")
  assert.equal(hookRun("pre-commit"), null, "a hook file is Git's to run")
  git(root, ["config", "core.hooksPath", "elsewhere"])
  assert.equal(hookRun("commit-msg"), null, "a configured hooks path is Git's to read")
  git(root, ["config", "--unset", "core.hooksPath"])
  const gpg = () => fastGitAnswer(root, ["config", "--type=bool", "--get", "commit.gpgSign"])
  assert.equal(gpg()?.status, 1)
  git(root, ["config", "commit.gpgSign", "false"])
  assert.equal(gpg(), null, "a configured value is Git's to read")
  git(root, ["config", "--unset", "commit.gpgSign"])
  for (const text of ["a  \n\n\n\nb\t\n\n", "\n\nonly", "   \n", "x\r\ny\n"]) {
    const real = spawnSync("git", ["stripspace"], { input: text, encoding: "utf8" }).stdout
    assert.equal(stripspace(text), real, JSON.stringify(text))
  }
})
