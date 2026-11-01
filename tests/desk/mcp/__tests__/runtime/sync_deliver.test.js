// Desk's own commits always reach the remote (#396). The background push worker used to rebase the shared checkout
// itself (`git pull --rebase --autostash`), so anything else in that checkout could stop every later push: an untracked
// file in the way of an incoming one, or a conflict on a task card while other sessions' files were dirty. Both
// incidents are reproduced here with real Git repositories: the local commits must land on the remote, and every other
// session's uncommitted file must be exactly as it was.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, existsSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { deskPushNote, readSyncStatus, runPushWorker, updateSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { blockedWords, deliver, mergeDeskText, undeliveredCommits } from "../../../../../plugins/desk/mcp/src/runtime/deliver.js"
import { syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"

const instantClock = { sleep: () => Promise.resolve() }

function git(root, args, where = ["-C", root]) {
  const result = spawnSync("git", [...where, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function write(root, name, content) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
  await fs.writeFile(path.join(root, name), content)
}

// Commits only `name`, as Desk does, so another session's staged file stays staged.
async function commit(root, name, content, message) {
  await write(root, name, content)
  git(root, ["add", "--", name])
  git(root, ["commit", "-q", "-m", message, "--", name])
}

async function clone(origin, label) {
  const root = await mkTempRoot(`desk-deliver-${label}-`)
  git(root, ["clone", "-q", origin, "."])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["checkout", "-q", "-B", "main", "origin/main"])
  git(root, ["branch", "-q", "--set-upstream-to", "origin/main"])
  return root
}

const card = ({ status, updated, progress }) => `---\ntitle: Ship it\nstatus: ${status}\nupdated: ${updated}\n---\n\n## Progress\n\n${progress.map((line) => `- ${line}`).join("\n")}\n`

// A shared checkout (the desk) and another machine, both cloned from one bare origin seeded with a card.
async function mkShared() {
  const origin = await mkTempRoot("desk-deliver-origin-")
  bare(origin, ["init", "--bare", "-q", "--initial-branch=main"])
  const seed = await mkTempRoot("desk-deliver-seed-")
  git(seed, ["init", "-q", "--initial-branch=main"])
  git(seed, ["config", "user.email", "test@example.com"])
  git(seed, ["config", "user.name", "Test"])
  await commit(seed, "tasks/ship.md", card({ status: "doing", updated: "2026-10-28T10:00:00Z", progress: ["started"] }), "seed card")
  await commit(seed, "notes/shared.md", "shared notes\n", "seed notes")
  git(seed, ["remote", "add", "origin", origin])
  git(seed, ["push", "-q", "-u", "origin", "main"])
  return { origin, desk: await clone(origin, "desk"), elsewhere: await clone(origin, "elsewhere") }
}

// Other sessions' uncommitted work in the shared checkout: a modified tracked file, a staged new file and an untracked one.
async function dirtyOtherWork(desk) {
  await write(desk, "notes/shared.md", "shared notes\nanother session is mid-edit\n")
  await write(desk, "drafts/staged.md", "staged by another session\n")
  git(desk, ["add", "--", "drafts/staged.md"])
  await write(desk, "drafts/untracked.md", "untracked work in progress\n")
  return snapshot(desk)
}

async function snapshot(desk) {
  const files = {}
  for (const name of ["notes/shared.md", "drafts/staged.md", "drafts/untracked.md"]) files[name] = await fs.readFile(path.join(desk, name), "utf8")
  const status = git(desk, ["status", "--porcelain", "--", "notes", "drafts"])
  return { files, status }
}

// A bare repository is read through --git-dir: some hosts set safe.bareRepository=explicit.
const bare = (origin, args) => git(origin, args, [`--git-dir=${origin}`])

function subjectsOnOrigin(origin) {
  return bare(origin, ["log", "--format=%s", "main"]).trim().split("\n")
}

test("incident 1: an untracked file matching an incoming tracked one never stops Desk's commits reaching the remote", async () => {
  const { origin, desk, elsewhere } = await mkShared()
  await commit(elsewhere, "_meta/factory.json", "{\"enabled\":true}\n", "track factory.json")
  git(elsewhere, ["push", "-q", "origin", "main"])

  // The same file sits untracked in the shared checkout, and Desk has committed card updates there since.
  await write(desk, "_meta/factory.json", "{\"enabled\":true}\n")
  const before = await dirtyOtherWork(desk)
  await commit(desk, "tasks/ship.md", card({ status: "doing", updated: "2026-10-28T21:03:00Z", progress: ["started", "card update one"] }), "desk: card update one")
  await commit(desk, "tasks/other.md", card({ status: "doing", updated: "2026-10-28T21:04:00Z", progress: ["new card"] }), "desk: card update two")

  const result = await runPushWorker({ root: desk, env: process.env, clock: instantClock, fileProblem: () => {} })

  assert.equal(result.result, "ok", JSON.stringify(result))
  const subjects = subjectsOnOrigin(origin)
  assert.ok(subjects.includes("desk: card update one"), subjects.join(", "))
  assert.ok(subjects.includes("desk: card update two"), subjects.join(", "))
  assert.ok(subjects.includes("track factory.json"), "nothing on the remote was rewritten")
  assert.deepEqual(await snapshot(desk), before, "other sessions' uncommitted files are untouched")
  assert.equal(existsSync(path.join(desk, ".git", "rebase-merge")), false)
  assert.equal(git(desk, ["stash", "list"]), "", "nothing was stashed")
  assert.equal(readSyncStatus({ root: desk, env: process.env }).blocked, false)
  assert.equal(git(desk, ["rev-parse", "HEAD"]), bare(origin, ["rev-parse", "main"]), "the shared checkout followed the remote")
  assert.equal(git(desk, ["status", "--porcelain", "--", "_meta"]), "", "the identical untracked file is now the tracked one")
})

test("incident 2: a task card conflict while other files are dirty resolves itself and Desk's commit reaches the remote", async () => {
  const { origin, desk, elsewhere } = await mkShared()
  // The operator signs off on another machine: newer progress line, but an older update time than the desk's own write.
  await commit(elsewhere, "tasks/ship.md", card({ status: "doing", updated: "2026-10-29T09:00:00Z", progress: ["started", "operator signed off"] }), "elsewhere: sign-off")
  git(elsewhere, ["push", "-q", "origin", "main"])

  const before = await dirtyOtherWork(desk)
  await commit(desk, "tasks/ship.md", card({ status: "done", updated: "2026-10-29T14:00:00Z", progress: ["started", "desk archived the work"] }), "desk: mark done")

  const result = await runPushWorker({ root: desk, env: process.env, clock: instantClock, fileProblem: () => {} })

  assert.equal(result.result, "ok", JSON.stringify(result))
  const subjects = subjectsOnOrigin(origin)
  assert.ok(subjects.includes("desk: mark done"), subjects.join(", "))
  assert.ok(subjects.includes("elsewhere: sign-off"), "nothing on the remote was rewritten")
  const landed = bare(origin, ["show", "main:tasks/ship.md"])
  assert.match(landed, /^- operator signed off$/mu, "both progress lines are kept")
  assert.match(landed, /^- desk archived the work$/mu, "both progress lines are kept")
  assert.match(landed, /^status: done$/mu, "the newer frontmatter wins")
  assert.match(landed, /^updated: 2026-10-29T14:00:00Z$/mu)
  assert.doesNotMatch(landed, /<<<<<<<|>>>>>>>/u)
  assert.deepEqual(await snapshot(desk), before, "other sessions' uncommitted files are untouched")
  assert.equal(git(desk, ["stash", "list"]), "", "nothing was stashed")
  assert.equal(git(desk, ["rev-parse", "HEAD"]), bare(origin, ["rev-parse", "main"]), "the shared checkout followed the remote")
})

// ---------------------------------------------------------------------------
// Delivery, piece by piece.
// ---------------------------------------------------------------------------

const intercept = (match, answer) => (cmd, args, opts) => (match(args) ? answer(args) : spawnSync(cmd, args, opts))

// The desk is behind its remote and has its own commit: delivery has to replay, not fast-forward.
async function mkDiverged({ deskFile = "tasks/mine.md", deskContent = "mine\n" } = {}) {
  const shared = await mkShared()
  await commit(shared.elsewhere, "notes/remote.md", "remote\n", "elsewhere: remote change")
  git(shared.elsewhere, ["push", "-q", "origin", "main"])
  await commit(shared.desk, deskFile, deskContent, "desk: local change")
  return shared
}

test("blockedWords names each recorded reason in plain words, with the paths it concerns", () => {
  assert.equal(blockedWords("auth_failed"), "the remote refused this machine's credentials")
  assert.equal(blockedWords("conflict", ["state.json"]), "a conflict Desk could not resolve on its own: state.json")
  assert.equal(blockedWords("odd_reason"), "the push failed (odd_reason)")
  assert.equal(blockedWords(null), "the push failed (reason unknown)")
})

test("mergeDeskText keeps both bodies' lines and merges frontmatter key by key, the newer side winning a key both changed", () => {
  const union = (base, ours, theirs) => [...new Set([...ours.split("\n"), ...theirs.split("\n")])].filter(Boolean).join("\n") + "\n"
  const base = "---\n# kept preface\ntitle: T\nstatus: doing\nowner: ari\ntags:\n  - one\nupdated: 2026-10-28T10:00:00Z\n---\nbody\n"
  const ours = "---\n# kept preface\ntitle: T\nstatus: review\nowner: ari\ntags:\n  - one\n  - two\nupdated: 2026-10-29T09:00:00Z\n---\nbody\nours line\n"
  const theirs = "---\n# kept preface\ntitle: T\nstatus: done\ntags:\n  - one\nupdated: 2026-10-29T14:00:00Z\nsignoff: yes\n---\nbody\ntheirs line\n"
  const merged = mergeDeskText({ base, ours, theirs, oursIsNewer: true, union })
  assert.equal(merged, "---\n# kept preface\ntitle: T\nstatus: done\ntags:\n  - one\n  - two\nupdated: 2026-10-29T14:00:00Z\nsignoff: yes\n---\nbody\nours line\ntheirs line\n")

  // Without update times, the caller's commit-time answer decides; the older side's deletion of an untouched key stands.
  const plain = (fields) => `---\n${fields}---\nx\n`
  assert.equal(mergeDeskText({ base: plain("a: 1\nb: 1\n"), ours: plain("a: 2\nb: 1\n"), theirs: plain("a: 3\n"), oursIsNewer: true, union }), "---\na: 2\n---\nx\n")
  assert.equal(mergeDeskText({ base: plain("a: 1\n"), ours: plain("a: 2\n"), theirs: plain("a: 3\n"), oursIsNewer: false, union }), "---\na: 3\n---\nx\n")
  assert.equal(mergeDeskText({ base: plain("a: 1\nupdated: not a date\n"), ours: plain("a: 2\nupdated: not a date\n"), theirs: plain("a: 3\nupdated: not a date\n"), oursIsNewer: true, union }), "---\na: 2\nupdated: not a date\n---\nx\n")
  // A file without frontmatter on every side is one line merge.
  assert.equal(mergeDeskText({ base: "a\n", ours: "---\nk: v\n---\na\n", theirs: "a\nb\n", oursIsNewer: true, union }), "---\nk: v\na\nb\n")
})

test("undeliveredCommits is null without an upstream, and leaves out commits already delivered as a resolved copy", async () => {
  const { desk } = await mkShared()
  await commit(desk, "tasks/a.md", "a\n", "a")
  await commit(desk, "tasks/b.md", "b\n", "b")
  const [first, second] = undeliveredCommits({ root: desk })
  assert.deepEqual(undeliveredCommits({ root: desk, delivered: [first] }), [second])
  git(desk, ["branch", "-q", "--unset-upstream"])
  assert.equal(undeliveredCommits({ root: desk }), null)
})

test("deliver refuses a checkout with no branch or upstream, and reports a fetch that fails or times out", async () => {
  const { desk } = await mkShared()
  await commit(desk, "tasks/a.md", "a\n", "a")
  const fetchFails = (answer) => intercept((args) => args.includes("fetch"), answer)
  assert.deepEqual(deliver({ root: desk, spawnGit: fetchFails(() => ({ status: 1, stdout: "", stderr: "\nfatal: refusing for an odd reason\n" })) }),
    { state: "failed", reason: "fetch_failed", error: "fatal: refusing for an odd reason", delivered: [], skipped: [] })
  assert.equal(deliver({ root: desk, spawnGit: fetchFails(() => ({ status: null, stdout: null, stderr: null })) }).reason, "deadline")
  git(desk, ["checkout", "-q", "--detach"])
  assert.equal(deliver({ root: desk }).reason, "no_upstream")
})

test("deliver stops at once when the push fails for an unreachable remote, and reports a worktree it cannot make", async () => {
  const { desk } = await mkDiverged()
  let pushes = 0
  const unreachable = intercept((args) => args.includes("push"), () => {
    pushes += 1
    return { status: 128, stdout: "", stderr: "fatal: unable to access 'https://example.invalid/desk.git/': Could not resolve host: example.invalid\n" }
  })
  assert.equal(deliver({ root: desk, spawnGit: unreachable }).reason, "unreachable")
  assert.equal(pushes, 1)
  const noWorktree = intercept((args) => args.includes("worktree") && args.includes("add"), () => ({ status: 128, stdout: "", stderr: "fatal: no space left on device\n" }))
  assert.deepEqual(deliver({ root: desk, spawnGit: noWorktree }), { state: "failed", reason: "replay_failed", error: "fatal: no space left on device", delivered: [], skipped: [] })
})

test("a lone commit Desk cannot merge is left local, nothing is pushed, and the checkout stays where it is", async () => {
  const { origin, desk, elsewhere } = await mkShared()
  await commit(elsewhere, "state.json", "{\"b\":1}\n", "elsewhere state")
  git(elsewhere, ["push", "-q", "origin", "main"])
  await commit(desk, "state.json", "{\"a\":1}\n", "desk state")
  const before = bare(origin, ["rev-parse", "main"])
  const outcome = deliver({ root: desk })
  assert.equal(outcome.state, "delivered")
  assert.deepEqual(outcome.delivered, [])
  assert.deepEqual(outcome.skipped.map((skip) => skip.paths), [["state.json"]])
  assert.deepEqual(outcome.checkout, { state: "behind", reason: "skipped_commits" })
  assert.equal(bare(origin, ["rev-parse", "main"]), before)
})

test("in a Crew workspace only the desk's own folder is merged automatically; binary and shared files stay real conflicts", async () => {
  const { origin, desk, elsewhere } = await mkShared()
  for (const [file, remote, local] of [["desks/ari/tasks/card.md", "remote\n", "local\n"], ["_shared/team.md", "remote\n", "local\n"], ["desks/ari/blob.md", "remote\0\n", "local\0\n"]]) {
    await commit(elsewhere, file, remote, `elsewhere ${file}`)
    await commit(desk, file, local, `desk ${file}`)
  }
  git(elsewhere, ["push", "-q", "origin", "main"])
  const outcome = deliver({ root: path.join(desk, "desks", "ari") })
  assert.deepEqual(outcome.skipped.map((skip) => skip.paths), [["_shared/team.md"], ["desks/ari/blob.md"]])
  assert.equal(bare(origin, ["show", "main:desks/ari/tasks/card.md"]), "remote\nlocal\n")
})

test("a card one side deleted and the other changed keeps the changed copy, and two new copies of a log keep both", async () => {
  const { origin, desk, elsewhere } = await mkShared()
  git(elsewhere, ["rm", "-q", "tasks/ship.md"])
  git(elsewhere, ["commit", "-q", "-m", "elsewhere removes the card"])
  await commit(elsewhere, "log.jsonl", "{\"from\":\"b\"}\n", "elsewhere log")
  git(elsewhere, ["push", "-q", "origin", "main"])
  await commit(desk, "tasks/ship.md", card({ status: "done", updated: "2026-10-29T14:00:00Z", progress: ["started", "finished"] }), "desk finishes the card")
  await commit(desk, "log.jsonl", "{\"from\":\"a\"}\n", "desk log")
  const outcome = deliver({ root: desk })
  assert.deepEqual(outcome.skipped, [])
  assert.match(bare(origin, ["show", "main:tasks/ship.md"]), /^- finished$/mu)
  assert.equal(bare(origin, ["show", "main:log.jsonl"]), "{\"from\":\"b\"}\n{\"from\":\"a\"}\n")
  assert.equal(outcome.checkout.state, "caught_up")
})

test("a commit with nothing left to deliver is counted delivered, and one Git will not commit is left local", async () => {
  const { desk } = await mkDiverged()
  git(desk, ["commit", "-q", "--allow-empty", "-m", "desk: empty"])
  const delivered = deliver({ root: desk })
  assert.equal(delivered.delivered.length, 2)
  assert.deepEqual(delivered.skipped, [])

  const again = await mkShared()
  await commit(again.elsewhere, "tasks/ship.md", "remote\n", "elsewhere card")
  git(again.elsewhere, ["push", "-q", "origin", "main"])
  await commit(again.desk, "tasks/ship.md", "local\n", "desk card")
  const refuse = intercept((args) => args.includes("--continue"), () => ({ status: 1, stdout: "", stderr: "error: could not commit\n" }))
  assert.deepEqual(deliver({ root: again.desk, spawnGit: refuse }).skipped.map((skip) => skip.paths), [[]])
})

test("the shared checkout never moves over another session's change or untracked file, and names what is in the way", async () => {
  const { desk } = await mkDiverged()
  await write(desk, "notes/remote.md", "another session's different file\n")
  const untracked = deliver({ root: desk })
  assert.equal(untracked.state, "delivered")
  assert.deepEqual(untracked.checkout, { state: "behind", reason: "local_changes", paths: ["notes/remote.md"] })
  assert.equal(await fs.readFile(path.join(desk, "notes/remote.md"), "utf8"), "another session's different file\n")

  const dirty = await mkShared()
  await commit(dirty.elsewhere, "notes/shared.md", "remote edit\n", "elsewhere edits notes")
  git(dirty.elsewhere, ["push", "-q", "origin", "main"])
  await commit(dirty.desk, "tasks/mine.md", "mine\n", "desk: local change")
  await write(dirty.desk, "notes/shared.md", "mid-edit\n")
  assert.deepEqual(deliver({ root: dirty.desk }).checkout, { state: "behind", reason: "local_changes", paths: ["notes/shared.md"] })
  assert.equal(await fs.readFile(path.join(dirty.desk, "notes/shared.md"), "utf8"), "mid-edit\n")
})

test("the checkout is left alone when its branch moved during delivery, and put back when the branch moves under the catch-up", async () => {
  const { desk } = await mkDiverged()
  const commitDuringPush = (cmd, args, opts) => {
    const result = spawnSync(cmd, args, opts)
    if (args.includes("push")) {
      writeFileSync(path.join(desk, "tasks/late.md"), "late\n")
      git(desk, ["add", "--", "tasks/late.md"])
      git(desk, ["commit", "-q", "-m", "late", "--", "tasks/late.md"])
    }
    return result
  }
  assert.deepEqual(deliver({ root: desk, spawnGit: commitDuringPush }).checkout, { state: "behind", reason: "moved" })

  const raced = await mkDiverged()
  const head = git(raced.desk, ["rev-parse", "HEAD"])
  const refuseMove = intercept((args) => args.includes("update-ref") && args.includes("-m"), () => ({ status: 1, stdout: "", stderr: "fatal: cannot lock ref" }))
  assert.deepEqual(deliver({ root: raced.desk, spawnGit: refuseMove }).checkout, { state: "behind", reason: "moved" })
  assert.equal(git(raced.desk, ["rev-parse", "HEAD"]), head)
  assert.equal(git(raced.desk, ["status", "--porcelain"]), "", "the files match the branch again")
})

test("a change the remote already has is nothing to deliver, and the checkout catches up", async () => {
  const { desk, elsewhere } = await mkShared()
  await commit(elsewhere, "tasks/same.md", "same\n", "elsewhere same")
  git(elsewhere, ["push", "-q", "origin", "main"])
  await commit(desk, "tasks/same.md", "same\n", "desk same")
  const outcome = deliver({ root: desk })
  assert.deepEqual(outcome, { state: "nothing", delivered: [], skipped: [], checkout: { state: "caught_up" } })
})

// ---------------------------------------------------------------------------
// The worker's loop, and what write tools and boot say.
// ---------------------------------------------------------------------------

test("the worker reports an unreadable pending list as nothing to push, and stops a delivery that never finishes", async () => {
  const { desk } = await mkShared()
  await commit(desk, "tasks/a.md", "a\n", "a")
  const unreadable = intercept((args) => args.includes("--cherry-pick"), () => ({ status: 1, stdout: "", stderr: "" }))
  assert.deepEqual(await runPushWorker({ root: desk, clock: instantClock, spawnGit: unreadable }), { result: "ok" })

  const sha = git(desk, ["rev-parse", "HEAD"]).trim()
  let filed = null
  const stuck = intercept((args) => args.includes("--cherry-pick"), () => ({ status: 0, stdout: `${sha}\n`, stderr: "" }))
  const result = await runPushWorker({ root: desk, clock: instantClock, spawnGit: stuck, fileProblem: (args) => { filed = args } })
  assert.deepEqual(result, { result: "blocked", reason: "push_incomplete", unpushed: 1 })
  assert.equal(filed.reason, "push_incomplete")

  let reads = 0
  const fadingRead = intercept((args) => args.includes("--cherry-pick"), () => (reads++ < 1 ? { status: 0, stdout: `${sha}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "" }))
  const offline = (cmd, args, opts) => (args.includes("fetch") ? { status: 128, stdout: "", stderr: "fatal: Could not read from remote repository.\n" } : fadingRead(cmd, args, opts))
  assert.deepEqual(await runPushWorker({ root: desk, clock: instantClock, spawnGit: offline, fileProblem: () => assert.fail("not filed") }), { result: "blocked", reason: "unreachable", unpushed: 0 })
})

test("a commit made just after the worker's last check, while its own worker found the lock held, is still pushed", async () => {
  const { origin, desk } = await mkShared()
  await commit(desk, "tasks/a.md", "a\n", "a")
  let injected = false
  const lateCommit = (cmd, args, opts) => {
    const result = spawnSync(cmd, args, opts)
    if (!injected && args.includes("--cherry-pick") && result.stdout.trim() === "") {
      injected = true
      writeFileSync(path.join(desk, "tasks/late.md"), "late\n")
      git(desk, ["add", "--", "tasks/late.md"])
      git(desk, ["commit", "-q", "-m", "late", "--", "tasks/late.md"])
    }
    return result
  }
  assert.deepEqual(await runPushWorker({ root: desk, clock: instantClock, spawnGit: lateCommit }), { result: "ok" })
  assert.equal(injected, true)
  assert.equal(bare(origin, ["log", "-1", "--format=%s", "main"]).trim(), "late")
})

test("a write tool's note says the work is only local, how much and why, while the last push is blocked", async () => {
  const { desk } = await mkShared()
  const note = "Desk committed this card and is pushing it in the background."
  assert.deepEqual(deskPushNote({ root: desk, note }), { desk_note: note })
  updateSyncStatus(desk, process.env, { blocked: true, reason: "auth_failed", paths: [] })
  assert.deepEqual(deskPushNote({ root: desk, note }), { desk_note: note }, "a stale record with nothing local says nothing")
  await commit(desk, "tasks/a.md", "a\n", "a")
  await commit(desk, "tasks/b.md", "b\n", "b")
  const blocked = deskPushNote({ root: desk, note })
  assert.equal(blocked.desk_unpushed, 2)
  assert.equal(blocked.desk_push_blocked, "auth_failed")
  assert.match(blocked.desk_note, /NOT on the remote yet: the last push failed because the remote refused this machine's credentials, so 2 local Desk commit\(s\) are only on this machine/u)
  assert.doesNotMatch(blocked.desk_note, /pushing it in the background/u)
  updateSyncStatus(desk, process.env, { blocked: true, reason: null, paths: "state.json" })
  assert.equal(deskPushNote({ root: desk, note }).desk_push_blocked, null)
  updateSyncStatus(desk, process.env, { reason: "conflict", paths: ["state.json"] })
  assert.match(deskPushNote({ root: desk, note }).desk_note, /could not resolve on its own: state\.json/u)
  assert.equal(deskPushNote({ root: desk, note, spawnGit: () => { throw new Error("boom") } }).desk_note, note)
  assert.equal(deskPushNote({ root: desk, note, spawnGit: () => ({ status: 1, stdout: "", stderr: "" }) }).desk_note, note)
})

test("desk_save's reply says its commit is only local, never that it is pushing, while the push is blocked", async () => {
  const { desk } = await mkShared()
  updateSyncStatus(desk, process.env, { blocked: true, reason: "unreachable", paths: [] })
  const result = await desk_save({ deskRoot: desk, input: { files: [{ path: "tasks/notes.md", content: "notes\n" }], message: "save notes" }, schedulePush: () => {} })
  assert.equal(result.desk_pushed, false)
  assert.equal(result.desk_unpushed, 1)
  assert.match(result.desk_note, /^Desk committed this, but it is NOT on the remote yet: the last push failed because the remote could not be reached/u)
})

test("boot starts delivery for local commits unless the remote cannot be used, and says how many and why", async () => {
  const { desk } = await mkShared()
  await commit(desk, "tasks/a.md", "a\n", "a")
  const started = []
  const scheduleDelivery = (args) => started.push(args)
  const ok = await syncWorkspace({ root: desk, env: process.env, scheduleDelivery })
  assert.deepEqual(ok.unpushed, { count: 1, delivering: true, reason: null, paths: [] })
  assert.deepEqual(started.map((args) => args.debounceMs), [0])

  updateSyncStatus(desk, process.env, { blocked: true, reason: "conflict", paths: ["state.json"], delivered: "not a list" })
  assert.deepEqual((await syncWorkspace({ root: desk, env: process.env, scheduleDelivery })).unpushed, { count: 1, delivering: true, reason: "conflict", paths: ["state.json"] })
  updateSyncStatus(desk, process.env, { blocked: true, reason: undefined, paths: "x", delivered: [] })
  assert.deepEqual((await syncWorkspace({ root: desk, env: process.env, scheduleDelivery })).unpushed, { count: 1, delivering: true, reason: null, paths: [] })
  updateSyncStatus(desk, process.env, { blocked: false })

  git(desk, ["remote", "set-url", "origin", path.join(desk, "no-such-origin")])
  const offline = await syncWorkspace({ root: desk, env: process.env, scheduleDelivery, fileProblem: () => ({ file: "none" }) })
  assert.equal(offline.state, "unresolved")
  assert.deepEqual(offline.unpushed, { count: 1, delivering: false, reason: offline.cause, paths: [] })
  assert.ok(["unreachable", "auth_failed"].includes(offline.cause), offline.cause)
  assert.match(offline.diagnostic, /the remote cannot be used from this machine right now/u)
  assert.equal(started.length, 3, "nothing is started while the remote cannot be used")
})

test("boot adds nothing when the pending list cannot be read", async () => {
  const { desk } = await mkShared()
  await commit(desk, "tasks/a.md", "a\n", "a")
  const unreadable = intercept((args) => args.includes("--cherry-pick"), () => ({ status: 1, stdout: "", stderr: "" }))
  const result = await syncWorkspace({ root: desk, env: process.env, spawnGit: unreadable, scheduleDelivery: () => assert.fail("nothing to deliver") })
  assert.equal("unpushed" in result, false)
})
