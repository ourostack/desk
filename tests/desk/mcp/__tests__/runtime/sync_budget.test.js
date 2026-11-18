// The sync budget: a Desk save returns in under a second on a repository the size of the CIT desk (about 12,000 files) even
// when a post-commit hook (Git LFS's whole-tree walk) takes seconds, a failed sync says why and what to do, a transient failure
// is retried, and a stuck sync never holds up the next save.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { commitPaths, stagePaths } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
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
