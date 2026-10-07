// session-sync.js — session-start's own sync step (M4-6 "agents never fight
// the desk" Part 3, Task 3; spec.md §2 "Session-start pull").
//
// Real synthetic Git repos throughout (a bare origin plus clones), per
// spec.md §7 — never mocked command shapes, except for the one TOCTOU race
// (a stray path vanishing between being listed and being moved) that real
// Git/the filesystem cannot be made to hit deterministically, which uses a
// scripted `spawnGit` that falls through to the real command for everything
// it does not deliberately intercept — the same pattern
// `runtime/sync_worker.test.js` already uses for its own forced-failure
// paths.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import {
  queueDeskProblemFiling,
  runSessionSyncCli,
  syncWorkspace,
} from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function mkBareOrigin() {
  const root = await mkTempRoot("desk-session-sync-origin-")
  git(root, ["init", "--bare", "-q"])
  return root
}

async function mkClone(originDir, label, { trackMain = false } = {}) {
  const root = await mkTempRoot(`desk-session-sync-${label}-`)
  git(root, ["clone", "-q", originDir, "."])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  if (trackMain) git(root, ["checkout", "-q", "-B", "main", "origin/main"])
  else git(root, ["symbolic-ref", "HEAD", "refs/heads/main"])
  return root
}

async function writeAndCommit(root, name, content, message) {
  await fs.writeFile(path.join(root, name), content)
  git(root, ["add", "--", name])
  git(root, ["commit", "-q", "-m", message])
}

// Every real desk's `.gitignore` includes `_cache/` (the quarantine directory itself is
// git-ignored, never committed -- `first-run-bootstrap/SKILL.md`'s own fresh-create step), so the
// fixtures mirror that here: without it, `untrackedPaths` would sweep up a same-day quarantine
// directory as more stray content to quarantine.
async function mkOriginWithClone() {
  const origin = await mkBareOrigin()
  const cloneA = await mkClone(origin, "a")
  await writeAndCommit(cloneA, ".gitignore", "_cache/\n", "gitignore _cache")
  await writeAndCommit(cloneA, "seed.md", "seed\n", "seed")
  git(cloneA, ["push", "-q", "-u", "origin", "main"])
  return { origin, cloneA }
}

async function mkPlainRepo() {
  const root = await mkTempRoot("desk-session-sync-plain-")
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  return root
}

// origin has one commit (seed.md, pushed from cloneA). cloneB then adds
// stray.txt and pushes it, while cloneA independently gets an *untracked*,
// uncommitted stray.txt of its own — the classic dirty-index pull failure:
// `git pull --rebase --autostash` fetches cloneB's commit fine, but refuses
// to check it out because the incoming tracked stray.txt would overwrite
// cloneA's own untracked one.
async function mkDirtyIndexFixture() {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneB, "stray.txt", "from origin\n", "add stray from origin")
  git(cloneB, ["push", "-q"])
  await fs.writeFile(path.join(cloneA, "stray.txt"), "local uncommitted\n")
  return { origin, cloneA, cloneB }
}

// origin gets a conflicting edit to seed.md from cloneB; cloneA commits its
// own conflicting edit to the same file locally, never pushed — a genuine
// tracked-file rebase conflict, with no untracked path to blame.
async function mkConflictFixture() {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneB, "seed.md", "seed\nfrom origin\n", "origin edits seed")
  git(cloneB, ["push", "-q"])
  await writeAndCommit(cloneA, "seed.md", "seed\nfrom local\n", "local edits seed")
  return { origin, cloneA, cloneB }
}

const env = process.env

// ---------------------------------------------------------------------------
// The "nothing to sync against" guards (no remote at all, or no upstream yet).
// ---------------------------------------------------------------------------

test("syncWorkspace reports synced, without ever pulling, on a plain repo with no remote configured", async () => {
  const root = await mkPlainRepo()
  await writeAndCommit(root, "seed.md", "seed\n", "seed")
  const result = await syncWorkspace({ root, env })
  assert.deepEqual(result, { state: "synced", nothingToSync: "no_remote" })
})

test("syncWorkspace reports synced when a remote exists but the current branch has no upstream", async () => {
  const origin = await mkBareOrigin()
  const root = await mkPlainRepo()
  git(root, ["remote", "add", "origin", origin])
  await writeAndCommit(root, "seed.md", "seed\n", "seed")
  const result = await syncWorkspace({ root, env })
  assert.deepEqual(result, { state: "synced", nothingToSync: "no_upstream" })
})

// ---------------------------------------------------------------------------
// The ordinary happy path.
// ---------------------------------------------------------------------------

test("syncWorkspace reports synced when the pull needs nothing (already up to date)", async () => {
  const { cloneA } = await mkOriginWithClone()
  const result = await syncWorkspace({ root: cloneA, env })
  assert.deepEqual(result, { state: "synced" })
})

// ---------------------------------------------------------------------------
// Dirty-index pull failure -> quarantine -> retry succeeds.
// ---------------------------------------------------------------------------

test("a dirty-index pull failure is resolved by quarantining the stray paths and retrying", async () => {
  const { cloneA } = await mkDirtyIndexFixture()
  const today = new Date().toISOString().slice(0, 10)
  const result = await syncWorkspace({ root: cloneA, env })
  assert.equal(result.state, "quarantined")
  assert.deepEqual(result.quarantinedPaths, [path.join("_cache", `stray-${today}`, "stray.txt")])
  assert.ok(existsSync(path.join(cloneA, "_cache", `stray-${today}`, "stray.txt")))
  assert.equal(await fs.readFile(path.join(cloneA, "_cache", `stray-${today}`, "stray.txt"), "utf8"), "local uncommitted\n")
  // The pull actually completed: the incoming tracked stray.txt landed too, cleanly.
  assert.equal(await fs.readFile(path.join(cloneA, "stray.txt"), "utf8"), "from origin\n")
  assert.ok(!git(cloneA, ["status", "--porcelain"]).includes("stray.txt"))
})

test("a second (and third) same-day quarantine does not clobber the ones before it", async () => {
  const { cloneA } = await mkDirtyIndexFixture()
  const today = new Date().toISOString().slice(0, 10)
  const firstDir = path.join(cloneA, "_cache", `stray-${today}`)
  const secondDir = path.join(cloneA, "_cache", `stray-${today}-2`)
  mkdirSync(firstDir, { recursive: true })
  writeFileSync(path.join(firstDir, "existing.txt"), "from an earlier quarantine today\n")
  mkdirSync(secondDir, { recursive: true })
  writeFileSync(path.join(secondDir, "existing2.txt"), "from a second earlier quarantine today\n")

  const result = await syncWorkspace({ root: cloneA, env })
  assert.equal(result.state, "quarantined")
  assert.deepEqual(result.quarantinedPaths, [path.join("_cache", `stray-${today}-3`, "stray.txt")])
  assert.ok(existsSync(path.join(cloneA, "_cache", `stray-${today}-3`, "stray.txt")))
  // Both earlier quarantine directories are untouched.
  assert.equal(await fs.readFile(path.join(firstDir, "existing.txt"), "utf8"), "from an earlier quarantine today\n")
  assert.equal(await fs.readFile(path.join(secondDir, "existing2.txt"), "utf8"), "from a second earlier quarantine today\n")
  assert.ok(!existsSync(path.join(firstDir, "stray.txt")))
  assert.ok(!existsSync(path.join(secondDir, "stray.txt")))
})

test("quarantine skips a stray path that no longer exists by the time it runs, and does not lose the real one", async () => {
  const { cloneA } = await mkDirtyIndexFixture()
  const spawnGit = (cmd, args, opts) => {
    const result = spawnSync(cmd, args, opts)
    if (args.includes("ls-files")) return { ...result, stdout: `${result.stdout.replace(/\n+$/u, "")}\nghost.txt\n` }
    return result
  }
  const result = await syncWorkspace({ root: cloneA, env, spawnGit })
  assert.equal(result.state, "quarantined")
  assert.ok(result.quarantinedPaths.some((p) => p.endsWith("stray.txt")))
  assert.ok(!result.quarantinedPaths.some((p) => p.includes("ghost")))
  assert.ok(!existsSync(path.join(cloneA, "_cache", `stray-${new Date().toISOString().slice(0, 10)}`, "ghost.txt")))
})

// ---------------------------------------------------------------------------
// Unresolved: a genuine tracked-file conflict, with nothing to quarantine.
// ---------------------------------------------------------------------------

test("a genuine tracked-file conflict with no untracked paths is unresolved, files through the detached filer, and leaves no rebase in progress", async () => {
  const { cloneA } = await mkConflictFixture()
  let filed = null
  const fileProblem = (args) => { filed = args }
  const result = await syncWorkspace({ root: cloneA, env, fileProblem })

  assert.equal(result.state, "unresolved")
  assert.equal(result.quarantinedPaths, undefined)
  assert.match(result.diagnostic, /^Desk problem: session-sync — session-start pull did not resolve$/mu)
  assert.match(result.diagnostic, /pull_rebase_failed\)/u)
  assert.match(result.diagnostic, /conflicted: seed\.md/u)
  assert.match(result.diagnostic, /filing in background/u)

  assert.deepEqual(filed, { root: cloneA, env, reason: "pull_rebase_failed:conflict", host: "unknown" })
  // The abort actually ran: no rebase left mid-flight, and the working tree is restored to
  // cloneA's own (still-local, unpushed) commit, clean of conflict markers.
  assert.ok(!existsSync(path.join(cloneA, ".git", "rebase-apply")))
  assert.ok(!existsSync(path.join(cloneA, ".git", "rebase-merge")))
  assert.equal(git(cloneA, ["status", "--porcelain"]).trim(), "")
})

test("a quarantine retry that still fails is unresolved, reports the quarantined paths, and files through the detached filer", async () => {
  const { cloneA, cloneB } = await mkDirtyIndexFixture()
  // Make the retry fail too, for a different (tracked-file conflict) reason: cloneA commits a
  // conflicting local edit to seed.md that origin also changed.
  await writeAndCommit(cloneB, "seed.md", "seed\nfrom origin\n", "origin edits seed")
  git(cloneB, ["push", "-q"])
  await writeAndCommit(cloneA, "seed.md", "seed\nfrom local\n", "local edits seed")

  let filed = null
  const fileProblem = (args) => { filed = args }
  const result = await syncWorkspace({ root: cloneA, env, fileProblem })

  assert.equal(result.state, "unresolved")
  assert.ok(Array.isArray(result.quarantinedPaths) && result.quarantinedPaths.length === 1)
  assert.match(result.diagnostic, /pull_rebase_failed_after_quarantine\)/u)
  assert.match(result.diagnostic, /conflicted: seed\.md/u)
  assert.equal(filed.reason, "pull_rebase_failed_after_quarantine:conflict")
  assert.ok(!existsSync(path.join(cloneA, ".git", "rebase-merge")))
})

test("conflictedPaths and untrackedPaths degrade to empty when their own git commands fail, still reaching unresolved", async () => {
  const { cloneA } = await mkDirtyIndexFixture()
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("ls-files") || args.includes("--diff-filter=U")) return { status: 1, stdout: "" }
    return spawnSync(cmd, args, opts)
  }
  let filed = null
  const result = await syncWorkspace({ root: cloneA, env, spawnGit, fileProblem: (args) => { filed = args } })
  assert.equal(result.state, "unresolved")
  assert.equal(result.quarantinedPaths, undefined)
  assert.doesNotMatch(result.diagnostic, /conflicted:/u)
  assert.equal(filed.reason, "pull_rebase_failed:conflict")
})

// ---------------------------------------------------------------------------
// GIT_SSH_COMMAND (fix round, controller ruling 4): every git call disables
// interactive SSH prompts too, the same way GIT_TERMINAL_PROMPT=0 already
// disables the HTTPS one, extending rather than replacing any value the
// caller's own environment already set. Mirrors `sync-worker.js`'s own
// equivalent test.
// ---------------------------------------------------------------------------

test("syncWorkspace's own git calls extend an already-set GIT_SSH_COMMAND with -o BatchMode=yes, rather than replacing it", async () => {
  const { cloneA } = await mkOriginWithClone()
  const originalSsh = process.env.GIT_SSH_COMMAND
  process.env.GIT_SSH_COMMAND = "ssh -i /custom/identity"
  try {
    let captured = null
    const spawnGit = (cmd, args, opts) => {
      if (captured === null && opts?.env?.GIT_SSH_COMMAND) captured = opts.env.GIT_SSH_COMMAND
      return spawnSync(cmd, args, opts)
    }
    await syncWorkspace({ root: cloneA, env, spawnGit })
    assert.equal(captured, "ssh -i /custom/identity -o BatchMode=yes")
  } finally {
    if (originalSsh === undefined) delete process.env.GIT_SSH_COMMAND
    else process.env.GIT_SSH_COMMAND = originalSsh
  }
})

test("GIT_SSH_COMMAND defaults to -o BatchMode=yes alone when nothing was already set", async () => {
  const { cloneA } = await mkOriginWithClone()
  const originalSsh = process.env.GIT_SSH_COMMAND
  delete process.env.GIT_SSH_COMMAND
  try {
    let captured = null
    const spawnGit = (cmd, args, opts) => {
      if (captured === null && opts?.env?.GIT_SSH_COMMAND) captured = opts.env.GIT_SSH_COMMAND
      return spawnSync(cmd, args, opts)
    }
    await syncWorkspace({ root: cloneA, env, spawnGit })
    assert.equal(captured, "ssh -o BatchMode=yes")
  } finally {
    if (originalSsh !== undefined) process.env.GIT_SSH_COMMAND = originalSsh
  }
})

// ---------------------------------------------------------------------------
// Fix round, controller ruling 2: a status-0 `git pull --rebase --autostash`
// is not proof the tree ended up clean -- popping the autostash can itself
// conflict without failing the pull's own exit code. Verified directly with
// real git before writing this test: with a plain dirty (uncommitted, no
// local commit needed) tracked-file edit that collides with an incoming
// fast-forward pull, `git pull --rebase --autostash` prints "Applying
// autostash resulted in conflicts..." yet still exits 0, leaves `UU seed.md`
// in `git status --porcelain`, and does not drop its own stash entry.
// ---------------------------------------------------------------------------

test("syncWorkspace treats a pull that succeeds but leaves its own autostash pop conflicted as unresolved, and leaves no rebase in progress", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneB, "seed.md", "seed\nfrom origin\n", "origin edits seed")
  git(cloneB, ["push", "-q"])

  // An uncommitted, working-tree-only edit to the very file origin just
  // changed -- no local commit needed at all -- is what autostash then fails
  // to pop cleanly.
  await fs.writeFile(path.join(cloneA, "seed.md"), "seed\nfrom A working tree\n")

  let filed = null
  const result = await syncWorkspace({ root: cloneA, env, fileProblem: (args) => { filed = args } })

  assert.equal(result.state, "unresolved")
  assert.equal(result.quarantinedPaths, undefined)
  assert.match(result.diagnostic, /autostash_pop_conflict\)/u)
  assert.match(result.diagnostic, /conflicted: seed\.md/u)
  assert.equal(filed.reason, "autostash_pop_conflict")

  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-merge")), false, "never left mid-rebase")
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-apply")), false, "never left mid-rebase")
  assert.match(git(cloneA, ["status", "--porcelain"]), /^UU seed\.md/mu, "the stash-pop conflict is real, left on disk exactly as real git leaves it")
  assert.match(git(cloneA, ["stash", "list"]), /autostash/u, "the stash entry is deliberately not dropped, exactly as real git leaves it")
})

// The retry pull (after a dirty-index quarantine) can leave its own
// autostash pop conflicted too, not just the first pull -- a separate branch
// in syncWorkspace from the one above. A fresh dirty tracked-file edit is
// injected as a side effect of the one `ls-files` call `untrackedPaths` makes
// right before quarantine runs -- the same "mutate the real repo from inside
// a scripted spawnGit" pattern `sync_worker.test.js`'s own "the loop
// re-checks for new commits" test already uses -- since quarantine only ever
// moves the untracked paths it already found, never touching a tracked file.
test("syncWorkspace treats the retry-after-quarantine pull's own autostash pop conflict as unresolved too, with the reason and quarantined paths both reported", async () => {
  const { origin, cloneA } = await mkDirtyIndexFixture()
  const cloneB2 = await mkClone(origin, "b2", { trackMain: true })
  await writeAndCommit(cloneB2, "seed.md", "seed\nfrom origin\n", "origin edits seed too")
  git(cloneB2, ["push", "-q"])

  let injected = false
  const spawnGit = (cmd, args, opts) => {
    if (!injected && args.includes("ls-files")) {
      injected = true
      writeFileSync(path.join(cloneA, "seed.md"), "seed\nfrom A working tree\n")
    }
    return spawnSync(cmd, args, opts)
  }
  let filed = null
  const result = await syncWorkspace({ root: cloneA, env, spawnGit, fileProblem: (args) => { filed = args } })

  assert.equal(result.state, "unresolved")
  assert.ok(Array.isArray(result.quarantinedPaths) && result.quarantinedPaths.some((p) => p.endsWith("stray.txt")), "the original stray path was still quarantined before the retry ran")
  assert.match(result.diagnostic, /autostash_pop_conflict_after_quarantine\)/u)
  assert.match(result.diagnostic, /conflicted: seed\.md/u)
  assert.equal(filed.reason, "autostash_pop_conflict_after_quarantine")

  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-merge")), false, "never left mid-rebase")
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-apply")), false, "never left mid-rebase")
  assert.match(git(cloneA, ["status", "--porcelain"]), /^UU seed\.md/mu, "the retry's own stash-pop conflict is real, left on disk exactly as real git leaves it")
})

// ---------------------------------------------------------------------------
// The 20s wall-clock budget (fix round, controller ruling 5): each git call
// gets whatever of the budget remains, and the whole sequence gives up as
// `unresolved` (reason `sync_deadline_exceeded`) rather than pushing ahead
// with an unbounded or zero-timeout call once it is gone. `now` is an
// injected clock throughout -- never a real sleep.
// ---------------------------------------------------------------------------

// A clock for the budget tests below, driven by which part of `syncWorkspace` is reading it, never by how many reads came before: the sync reads `now` once to set its deadline, then through `remaining()` at its named checkpoints and through `budgetedTimeout()` before each git step. Counting reads made these tests stop reaching their checkpoint, and still pass, whenever a read was added elsewhere. Here a read that does not come from `remaining` sets the deadline (time 0). The checkpoint that is `exhaustedAtCheckpoint` (1-based, in the order `remaining()` is called directly) and everything after it reports the budget long gone; `budgetedTimeout()` reads report it gone only from that checkpoint on, or from the start when `exhaustedFromFirstStep` is set. `checkpoints()` says how many were reached, so a test can assert it got to the one it means.
function checkpointClock({ exhaustedAtCheckpoint, exhaustedFromFirstStep = false }) {
  let reached = 0
  const now = () => {
    const stack = new Error().stack
    if (!stack.includes("at remaining (")) return 0
    if (!stack.includes("at budgetedTimeout (")) {
      reached += 1
      return reached >= exhaustedAtCheckpoint ? 999_999 : 0
    }
    return reached >= exhaustedAtCheckpoint || exhaustedFromFirstStep ? 999_999 : 0
  }
  return { now, checkpoints: () => reached }
}

test("syncWorkspace reports sync_deadline_exceeded and never attempts a pull when the budget is already exhausted", async () => {
  const { cloneA } = await mkOriginWithClone()
  const clock = checkpointClock({ exhaustedAtCheckpoint: 1 })
  const now = clock.now
  let pullCalled = false
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("pull")) pullCalled = true
    return spawnSync(cmd, args, opts)
  }
  let filed = null
  const result = await syncWorkspace({ root: cloneA, env, spawnGit, now, fileProblem: (args) => { filed = args } })
  assert.equal(result.state, "unresolved")
  assert.match(result.diagnostic, /sync_deadline_exceeded/u)
  assert.equal(clock.checkpoints(), 1, "the sequence stopped at its first budget checkpoint")
  assert.equal(pullCalled, false, "no real pull was ever attempted once the budget was already exhausted")
  assert.equal(filed, null, "a deadline is not a Desk defect, so nothing is filed")
})

test("syncWorkspace reports sync_deadline_exceeded, without attempting a second pull, when the budget runs out after quarantining", async () => {
  const { cloneA } = await mkDirtyIndexFixture()
  let exhausted = false
  const now = () => (exhausted ? 999_999 : 0)
  let pullCalls = 0
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("ls-files")) exhausted = true
    if (args.includes("pull")) pullCalls += 1
    return spawnSync(cmd, args, opts)
  }
  let filed = null
  const result = await syncWorkspace({ root: cloneA, env, spawnGit, now, fileProblem: (args) => { filed = args } })
  assert.equal(result.state, "unresolved")
  assert.match(result.diagnostic, /sync_deadline_exceeded/u)
  assert.equal(pullCalls, 1, "only the first pull attempt ran; the sequence gave up before a second")
  assert.ok(Array.isArray(result.quarantinedPaths) && result.quarantinedPaths.some((p) => p.endsWith("stray.txt")), "the stray path was still quarantined before the budget ran out")
  assert.equal(filed, null, "a deadline is not a Desk defect, so nothing is filed")
})

// The three lines a nondeterministic (real-clock) run can cover only by
// accident, depending on how long the surrounding git calls happen to take
// on a given machine: `run`'s own `timeoutMs <= 0` guard, `stashCount`'s
// fallback when its own `git stash list` call fails, and the checkpoint
// right after the *first* pull's own failure is captured and aborted (as
// distinct from the two checkpoints above it, which sit before the first
// pull and after quarantining respectively). Each gets one dedicated,
// clock-scripted test so coverage of these lines no longer depends on how
// fast the real git calls around them happen to run.

test("run() itself refuses to spawn once the per-call budget is exhausted, never calling spawnGit for any of the remaining steps", async () => {
  const { cloneA } = await mkOriginWithClone()
  // The deadline is set, the pre-pull checkpoint is still within budget, and every git step from stashCount onward finds the budget
  // long gone, so each hits run()'s own `timeoutMs <= 0` guard instead of ever reaching spawnGit.
  const clock = checkpointClock({ exhaustedAtCheckpoint: 2, exhaustedFromFirstStep: true })
  const now = clock.now
  let spawnGitCalled = false
  const spawnGit = (cmd, args, opts) => {
    if (["stash", "pull", "diff", "rebase"].some((verb) => args.includes(verb))) spawnGitCalled = true
    return spawnSync(cmd, args, opts)
  }
  let filed = null
  const result = await syncWorkspace({ root: cloneA, env, spawnGit, now, fileProblem: (args) => { filed = args } })
  assert.ok(clock.checkpoints() >= 1, "the pre-pull checkpoint was passed within budget")
  assert.equal(spawnGitCalled, false, "run()'s own budget-exhausted guard synthesized every remaining step's failure without ever spawning git for it")
  assert.equal(result.state, "unresolved")
  assert.match(result.diagnostic, /sync_deadline_exceeded/u)
  assert.equal(filed, null, "a deadline is not a Desk defect, so nothing is filed")
})

test("stashCount falls back to 0 when its own git stash list call fails, and again when it returns non-string stdout", async () => {
  const { cloneA: cloneStatus } = await mkOriginWithClone()
  const failingStatus = (cmd, args, opts) => {
    if (args.includes("stash") && args.includes("list")) return { status: 1, stdout: "" }
    return spawnSync(cmd, args, opts)
  }
  assert.deepEqual(await syncWorkspace({ root: cloneStatus, env, spawnGit: failingStatus }), { state: "synced" }, "a stashCount lookup that fails outright still resolves synced on an already-clean pull")

  const { cloneA: cloneStdout } = await mkOriginWithClone()
  const nonStringStdout = (cmd, args, opts) => {
    if (args.includes("stash") && args.includes("list")) return { status: 0, stdout: undefined }
    return spawnSync(cmd, args, opts)
  }
  assert.deepEqual(await syncWorkspace({ root: cloneStdout, env, spawnGit: nonStringStdout }), { state: "synced" }, "a stashCount lookup with non-string stdout falls back the same way")
})

test("syncWorkspace reports sync_deadline_exceeded right after the first pull's own conflict is captured and aborted, carrying firstConflicted through", async () => {
  const { cloneA } = await mkConflictFixture()
  // The deadline, the pre-pull checkpoint and the git steps up to the abort are all within budget. The second checkpoint is the one
  // right after that abort (`if (remaining() <= 0) return deadlineExceeded(firstConflicted)`), which this scripts as exhausted so
  // the sequence gives up there instead of ever reaching untrackedPaths/quarantine.
  const clock = checkpointClock({ exhaustedAtCheckpoint: 2 })
  const now = clock.now
  let untrackedCalled = false
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("ls-files")) untrackedCalled = true
    return spawnSync(cmd, args, opts)
  }
  let filed = null
  const result = await syncWorkspace({ root: cloneA, env, spawnGit, now, fileProblem: (args) => { filed = args } })
  assert.equal(result.state, "unresolved")
  assert.equal(result.quarantinedPaths, undefined, "the budget ran out before quarantine was ever attempted")
  assert.equal(clock.checkpoints(), 2, "the sequence stopped at the checkpoint right after the first pull's abort")
  assert.equal(untrackedCalled, false, "untrackedPaths was never reached once this checkpoint gave up")
  assert.match(result.diagnostic, /sync_deadline_exceeded/u)
  assert.match(result.diagnostic, /conflicted: seed\.md/u, "firstConflicted -- captured before the abort that cleared it -- was carried through into the diagnostic")
  assert.equal(filed, null, "a deadline is not a Desk defect, so nothing is filed")
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-merge")), false, "the defensive abort still ran before this checkpoint gave up")
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-apply")), false)
})

// ---------------------------------------------------------------------------
// queueDeskProblemFiling — the real default `fileProblem`, tested directly
// with an injected `spawnImpl` so the real detached filer never actually
// launches from a test (it really does shell out toward `gh`).
// ---------------------------------------------------------------------------

// A fresh, throwaway HOME per test -- never `process.env` itself, whose own
// `XDG_STATE_HOME` is one shared directory for this whole test-file run (set
// once by `_isolated_env.mjs`), which would let one test's throttle stamp
// leak into a sibling test using the same mechanism+reason pair. Matches
// `filer_throttle.test.js`'s own `fixtureEnv` exactly.
function fixtureFilerEnv(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-session-sync-filer-"))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  return { HOME: root }
}

test("queueDeskProblemFiling spawns the detached filer with mechanism session-sync and the given reason/host", (t) => {
  let captured = null
  const spawnImpl = (cmd, args, opts) => {
    captured = { cmd, args, opts }
    return { on: (event, handler) => { if (event === "error") handler(new Error("unused")) }, unref: () => {} }
  }
  const env = fixtureFilerEnv(t)
  queueDeskProblemFiling({ root: "/some/root", env, reason: "pull_rebase_failed", host: "claude", spawnImpl })
  assert.equal(captured.cmd, process.execPath)
  assert.ok(captured.args.includes("--mechanism"))
  assert.ok(captured.args.includes("session-sync"))
  assert.ok(captured.args.includes("--reason"))
  assert.ok(captured.args.includes("pull_rebase_failed"))
  assert.ok(captured.args.includes("--host"))
  assert.ok(captured.args.includes("claude"))
  assert.ok(captured.args.includes("--fix-attempt"))
  assert.equal(captured.opts.detached, true)
  assert.equal(captured.opts.stdio, "ignore")
  assert.equal(captured.opts.cwd, "/some/root")
  assert.equal(captured.opts.env, env)
})

test("queueDeskProblemFiling never throws, even when the spawn implementation itself throws", (t) => {
  assert.doesNotThrow(() => queueDeskProblemFiling({ root: "/x", env: fixtureFilerEnv(t), reason: "x", host: "unknown", spawnImpl: () => { throw new Error("boom") } }))
})

// Fix round, spec.md §1 Part 5: `reason`'s raw text must never reach the
// spawned filer's own argv unredacted -- `ps` shows a process's argv to every
// account on the machine. Mirrors `boot-checks.cjs`'s own filer-argv
// redaction test (`boot_checks_error_skip.test.js`) and `sync-worker.js`'s
// own equivalent (`sync_worker.test.js`).
test("queueDeskProblemFiling redacts a path-shaped reason out of the spawned filer's own argv", (t) => {
  let captured = null
  const spawnImpl = (cmd, args, opts) => {
    captured = { cmd, args, opts }
    return { on: (event, handler) => { if (event === "error") handler(new Error("unused")) }, unref: () => {} }
  }
  const rawReason = "boom: failed to read /Users/ari/personal-desk/track/task/notes.md"
  queueDeskProblemFiling({ root: "/some/root", env: fixtureFilerEnv(t), reason: rawReason, host: "claude", spawnImpl })
  const reasonIndex = captured.args.indexOf("--reason")
  assert.ok(reasonIndex >= 0)
  const safeReason = captured.args[reasonIndex + 1]
  assert.doesNotMatch(safeReason, /\/Users\//u)
  assert.doesNotMatch(safeReason, /personal-desk/u)
  assert.ok(!captured.args.some((arg) => typeof arg === "string" && arg.includes("/Users/ari")))
})

// Fix round, spec.md §1 Part 5: `shouldLaunchFiler` throttles the actual spawn
// to once per hour per mechanism+reason pair -- the caller still reports a
// `file` field either way.
test("queueDeskProblemFiling does not launch a second filer for the same reason within the cooldown", (t) => {
  const env = fixtureFilerEnv(t)
  let spawnCalls = 0
  const spawnImpl = () => {
    spawnCalls += 1
    return { on: (event, handler) => { if (event === "error") handler(new Error("unused")) }, unref: () => {} }
  }
  const first = queueDeskProblemFiling({ root: "/some/root", env, reason: "pull_rebase_failed", host: "claude", spawnImpl })
  const second = queueDeskProblemFiling({ root: "/some/root", env, reason: "pull_rebase_failed", host: "claude", spawnImpl })
  assert.equal(spawnCalls, 1, "only the first call actually spawns")
  assert.deepEqual(first, { file: "filing in background" })
  assert.deepEqual(second, { file: "filing already queued (within the last hour)" })
})

// ---------------------------------------------------------------------------
// runSessionSyncCli — the CLI surface `mcp/scripts/session-sync.js` wraps.
// ---------------------------------------------------------------------------

function fakeIo() {
  const out = []
  const err = []
  return { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, out, err }
}

test("runSessionSyncCli requires --root (or the DESK env var) and never throws when both are missing", async () => {
  const io = fakeIo()
  const code = await runSessionSyncCli({ argv: [], env: {}, io, syncFn: async () => { throw new Error("must not be called") } })
  assert.equal(code, 0)
  assert.equal(io.out.length, 0)
  assert.match(io.err[0], /--root.*DESK/u)
})

test("runSessionSyncCli's argument parser rejects a malformed flag shape (a bad launch site is a bug in the caller)", async () => {
  await assert.rejects(runSessionSyncCli({ argv: [42, "x"], env: {} }), /unexpected argument/u)
  await assert.rejects(runSessionSyncCli({ argv: ["notflag", "x"], env: {} }), /unexpected argument/u)
  await assert.rejects(runSessionSyncCli({ argv: [undefined, "x"], env: {} }), /unexpected argument ""/u)
})

test("runSessionSyncCli treats an explicit empty --root the same as a missing one", async () => {
  const io = fakeIo()
  const code = await runSessionSyncCli({ argv: ["--root", ""], env: {}, io, syncFn: async () => { throw new Error("must not be called") } })
  assert.equal(code, 0)
  assert.equal(io.out.length, 0)
  assert.match(io.err[0], /--root.*DESK/u)
})

test("runSessionSyncCli falls back to the DESK env var when --root is not passed", async () => {
  const io = fakeIo()
  let seenRoot = null
  const code = await runSessionSyncCli({ argv: [], env: { DESK: "/a/desk" }, io, syncFn: async ({ root }) => { seenRoot = root; return { state: "synced" } } })
  assert.equal(code, 0)
  assert.equal(seenRoot, "/a/desk")
  assert.equal(io.out.length, 0)
})

test("runSessionSyncCli prints nothing for a synced result", async () => {
  const io = fakeIo()
  await runSessionSyncCli({ argv: ["--root", "/a/desk"], env: {}, io, syncFn: async () => ({ state: "synced" }) })
  assert.equal(io.out.length, 0)
  assert.equal(io.err.length, 0)
})

test("runSessionSyncCli prints a one-line summary for a quarantined result", async () => {
  const io = fakeIo()
  await runSessionSyncCli({
    argv: ["--root", "/a/desk"],
    env: {},
    io,
    syncFn: async () => ({ state: "quarantined", quarantinedPaths: ["_cache/stray-2026-09-28/stray.txt"] }),
  })
  assert.equal(io.out.length, 1)
  assert.match(io.out[0], /quarantined 1 stray path\(s\)/u)
  assert.match(io.out[0], /stray\.txt/u)
})

test("runSessionSyncCli prints the diagnostic block for an unresolved result", async () => {
  const io = fakeIo()
  await runSessionSyncCli({
    argv: ["--root", "/a/desk"],
    env: {},
    io,
    syncFn: async () => ({ state: "unresolved", diagnostic: "Desk problem: session-sync — session-start pull did not resolve" }),
  })
  assert.equal(io.out.length, 1)
  assert.match(io.out[0], /^Desk problem: session-sync/u)
})

// ---------------------------------------------------------------------------
// scripts/session-sync.js — the one-line CLI entry point itself, run for
// real as a subprocess (the same pattern scripts/tidy-status.js's own test
// uses). A plain repo with no remote settles into "synced" almost
// instantly and prints nothing, so this is a fast, side-effect-free way to
// exercise the actual shipped file's own single statement.
// ---------------------------------------------------------------------------

test("scripts/session-sync.js runs the command line for real, as a subprocess", async () => {
  const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-sync.js", import.meta.url))
  const root = await mkPlainRepo()
  await writeAndCommit(root, "seed.md", "seed\n", "seed")
  const stdout = execFileSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", env: process.env })
  assert.equal(stdout, "")
})
