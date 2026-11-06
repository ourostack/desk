// A commit that times out can still have landed (#561, #556). Git's own hooks run inside the commit call (the card guard
// before it, Git LFS after it), so on a busy shared checkout the call can run out of time after the commit is already in
// HEAD. Each tool reads back what HEAD holds before it reports: a commit that landed is committed and its push is
// scheduled, one that did not land is failed, and one Desk cannot read back is unknown, never replayed. Every result
// that is not committed carries route_around, and running that route by hand finishes the commit.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { lesson_add as lessonAdd } from "../../../../../plugins/desk/mcp/src/tools/lesson.js"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { track_create } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { friction_add } from "../../../../../plugins/desk/mcp/src/tools/friction.js"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { writeCardCommitted } from "../../../../../plugins/desk/mcp/src/tools/_card-commit.js"
import { mkTempDeskRoot } from "./_helpers.js"
import { assertRoute } from "./_route_around.js"

const SOLO = async () => ({ status: "ok", personPrefix: "" })
const SCOPE = "europe trip planning and bookings; not day-to-day expenses"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout
}

async function repo() {
  const root = await mkTempDeskRoot()
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  return root
}

const isCommit = (args) => args.includes("commit") && !args.includes("rev-parse")
const timeout = () => Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" })

// The commit runs for real and lands, then the call reports what a 10-second timeout reports: no status and ETIMEDOUT.
// This is what a slow post-commit hook (Git LFS) does to spawnSync.
const landedThenTimedOut = (cmd, args, opts) => {
  const real = spawnSync(cmd, args, opts)
  return isCommit(args) ? { ...real, status: null, signal: "SIGTERM", error: timeout() } : real
}

// The call times out before the commit lands: what a slow pre-commit hook (the card guard) does.
const timedOutBeforeCommit = (cmd, args, opts) => (isCommit(args) ? { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: timeout() } : spawnSync(cmd, args, opts))

// Desk cannot read back: the commit times out and every read of HEAD after it fails.
function unreadable() {
  let committed = false
  return (cmd, args, opts) => {
    if (isCommit(args)) {
      committed = true
      return { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: timeout() }
    }
    if (committed && args.includes("rev-parse")) return { status: 128, stdout: "", stderr: "fatal: cannot lock ref" }
    return spawnSync(cmd, args, opts)
  }
}

const subject = (root) => git(root, ["log", "-1", "--format=%s"]).trim()

// R6 (0972 on #625): the route hands the push to Desk's worker with exactly the root a successful call schedules (deskRoot), never the
// nested folder a card or lesson was committed from. The worker's lock and delivery state are keyed by that literal root, so any other
// root would start a second worker for the same repository instead of taking its turn behind the first.
function publishRoots(route) {
  return route.steps.flatMap((step) => (Array.isArray(step.argv?.[0]) ? step.argv : step.argv ? [step.argv] : []))
    .filter((argv) => argv.some((arg) => String(arg).endsWith("sync-push.js")))
    .map((argv) => argv[argv.indexOf("--root") + 1])
}
const clean = (root, rel) => git(root, ["status", "--porcelain", "--", rel]) === ""

// ── lesson_add (the case the operator hit) ─────────────────────────────────

const lesson = (args) => lessonAdd({ env: {}, personOf: SOLO, input: { scope: "personal", topic: "Rule", body: "Do it." }, ...args })

test("lesson_add: a commit that landed but timed out is committed, in effect and pushed", async () => {
  const root = await repo()
  const pushes = []
  const result = await lesson({ deskRoot: root, spawnGit: landedThenTimedOut, schedulePush: (opts) => pushes.push(opts) })
  assert.equal(result.commit, undefined, "no commit failure is reported for a commit that is in HEAD")
  assert.equal(result.in_effect, true)
  assert.equal(result.route_around, undefined)
  assert.equal(subject(root), "lesson_add: personal rule")
  assert.ok(clean(root, "AGENTS.md"))
  assert.deepEqual(pushes, [{ root }], "the push is scheduled, so the lesson reaches the remote")
})

test("lesson_add: a commit that timed out before landing is failed, not in effect, and carries route_around", async () => {
  const root = await repo()
  const pushes = []
  const result = await lesson({ deskRoot: root, spawnGit: timedOutBeforeCommit, schedulePush: (opts) => pushes.push(opts) })
  assert.equal(result.in_effect, false)
  assert.equal(result.commit.status, "failed")
  assertRoute(result.commit.route_around)
  assert.deepEqual(result.route_around, result.commit.route_around, "the route is at the top of the result too")
  assert.deepEqual(publishRoots(result.route_around), [root])
  assert.deepEqual(pushes, [])
})

test("lesson_add: a commit Desk cannot read back is unknown, and its route reads back before committing again", async () => {
  const root = await repo()
  const result = await lesson({ deskRoot: root, spawnGit: unreadable(), schedulePush: () => assert.fail("no push for an unknown commit") })
  // R5 (0972 on #625): unknown stays unknown in the fields and the words. `in_effect` is null, never a false that claims
  // absence (and never a truthy value an old `if (in_effect)` would read as done).
  assert.equal(result.in_effect, null)
  assert.equal(result.commit.status, "unknown")
  assertRoute(result.route_around)
  assert.ok(result.route_around.steps[0].argv.includes("status"), "step 1 is the read-back, never a second commit")
  assert.match(result.message, /cannot tell whether the commit landed/u)
  assert.doesNotMatch(result.message, /not committed|not in effect|do not have it/u)
})

test("lesson_add: a file that held another session's edit gets a route that keeps that edit out of the commit", async () => {
  const root = await repo()
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk\n", "utf8")
  git(root, ["add", "AGENTS.md"])
  git(root, ["commit", "-q", "-m", "init"])
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk\n\nAnother session's edit.\n", "utf8")
  const result = await lesson({ deskRoot: root, schedulePush: () => assert.fail("no push") })
  assert.equal(result.in_effect, false)
  assertRoute(result.route_around)
  assert.match(result.route_around.never, /Never commit AGENTS\.md whole/u)
})

// ── the other callers of the shared commit helper ──────────────────────────

const cases = [
  {
    name: "task_create",
    rel: "europe-trip/book-flights/task.md",
    run: (root, spawnGit, schedulePush) => task_create({ deskRoot: root, input: { track: "europe-trip", slug: "book-flights", title: "Book the Paris flights" }, spawnGit, schedulePush }),
  },
  {
    name: "task_update",
    rel: "t/book-flights/task.md",
    setup: (root) => task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} }),
    run: (root, spawnGit, schedulePush) => task_update({ deskRoot: root, input: { track: "t", slug: "book-flights", frontmatter: { status: "processing" } }, spawnGit, schedulePush }),
  },
  {
    name: "track_create",
    rel: "europe-trip/track.md",
    run: (root, spawnGit, schedulePush) => track_create({ deskRoot: root, input: { slug: "europe-trip", title: "Europe trip 2026", scope: SCOPE }, spawnGit, schedulePush }),
  },
  {
    name: "friction_add",
    rel: "_meta/friction.md",
    run: (root, spawnGit, schedulePush) => friction_add({ deskRoot: root, input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." }, spawnGit, schedulePush }),
  },
  {
    name: "desk_save",
    rel: "notes.md",
    setup: (root) => fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8"),
    run: (root, spawnGit, schedulePush) => desk_save({ deskRoot: root, input: { paths: ["notes.md"], message: "save notes" }, spawnGit, schedulePush }),
  },
]

for (const c of cases) {
  test(`${c.name}: a commit that landed but timed out is committed and pushed`, async () => {
    const root = await repo()
    await c.setup?.(root)
    const pushes = []
    const result = await c.run(root, landedThenTimedOut, (opts) => pushes.push(opts))
    assert.equal(result.commit, undefined, `${c.name} reports no commit failure for a commit that is in HEAD`)
    assert.ok(clean(root, c.rel))
    assert.deepEqual(pushes, [{ root }])
  })

  test(`${c.name}: a commit that timed out before landing carries route_around and schedules no push`, async () => {
    const root = await repo()
    await c.setup?.(root)
    const pushes = []
    const result = await c.run(root, timedOutBeforeCommit, (opts) => pushes.push(opts))
    assert.equal(result.commit?.status, "failed")
    assertRoute(result.commit.route_around)
    assert.deepEqual(publishRoots(result.commit.route_around), [root], "the route publishes the desk root a success would schedule")
    assert.equal(clean(root, c.rel), false, "the write is kept")
    assert.deepEqual(pushes, [])
  })

  test(`${c.name}: a commit Desk cannot read back is unknown, never replayed`, async () => {
    const root = await repo()
    await c.setup?.(root)
    let commits = 0
    const inner = unreadable()
    const spawnGit = (cmd, args, opts) => {
      if (isCommit(args)) commits += 1
      return inner(cmd, args, opts)
    }
    const result = await c.run(root, spawnGit, () => assert.fail("no push for an unknown commit"))
    assert.equal(result.commit?.status, "unknown")
    assertRoute(result.commit.route_around)
    assert.equal(commits, 1, "one commit dispatch per call, even when the outcome is unknown")
  })
}

// The real case behind #561: desk_save on two newly written JSON records returned
// { status: "nothing_to_commit", commit: { status: "failed", reason: "timeout" } }, yet HEAD held both files with their full
// contents and the requested message. The commit landed after the timeout; it was not missing.
test("desk_save: two new records whose commit landed but timed out are committed and pushed, never nothing_to_commit", async () => {
  const root = await repo()
  await fs.mkdir(path.join(root, "records"), { recursive: true })
  const records = { "records/review.json": '{"review":"approved"}\n', "records/merge.json": '{"merge":"done"}\n' }
  for (const [rel, text] of Object.entries(records)) await fs.writeFile(path.join(root, rel), text, "utf8")
  let commits = 0
  const spawnGit = (cmd, args, opts) => {
    if (isCommit(args)) commits += 1
    return landedThenTimedOut(cmd, args, opts)
  }
  const pushes = []
  const result = await desk_save({ deskRoot: root, input: { paths: Object.keys(records), message: "record review and merge" }, spawnGit, schedulePush: (opts) => pushes.push(opts) })
  assert.equal(result.status, "committed")
  assert.equal(result.commit, undefined)
  assert.ok(git(root, ["rev-parse", "HEAD"]).startsWith(result.desk_commit), "desk_commit names the commit in HEAD")
  assert.equal(subject(root), "record review and merge")
  for (const [rel, text] of Object.entries(records)) assert.equal(git(root, ["show", `HEAD:${rel}`]), text)
  assert.equal(commits, 1, "the write is never replayed")
  assert.deepEqual(pushes, [{ root }], "the push is scheduled")
})

// desk_save's own file write, then a commit whose response is lost after it lands, with an unrelated entry staged by someone
// else. The commit holds exactly the written bytes, the push is scheduled so the commit is published (a later desk_save of
// the same path finds nothing to commit, so nothing else would ever push it), Git is dispatched once and the index is left alone.
async function savedNotes(spawnGitFor) {
  const root = await repo()
  await fs.writeFile(path.join(root, "base.md"), "base\n", "utf8")
  git(root, ["add", "base.md"])
  git(root, ["commit", "-q", "-m", "base"])
  const base = git(root, ["rev-parse", "HEAD"]).trim()
  await fs.writeFile(path.join(root, "other.md"), "someone else's staged work\n", "utf8")
  git(root, ["add", "other.md"])
  let commits = 0
  const spawnGit = (cmd, args, opts) => {
    if (isCommit(args)) commits += 1
    return spawnGitFor(cmd, args, opts)
  }
  const pushes = []
  const result = await desk_save({ deskRoot: root, input: { files: [{ path: "notes.md", content: "Exact notes.\n" }], message: "save notes" }, spawnGit, schedulePush: (opts) => pushes.push(opts) })
  return { root, base, result, commits: () => commits, pushes }
}

test("desk_save: written bytes whose commit landed but timed out are committed and pushed, once, leaving another staged entry alone", async () => {
  const { root, base, result, commits, pushes } = await savedNotes(landedThenTimedOut)
  assert.equal(result.status, "committed")
  assert.equal(result.commit, undefined)
  assert.deepEqual(pushes, [{ root }], "the push is scheduled, so the commit that landed is published")
  assert.equal(commits(), 1, "exactly one commit dispatch")
  assert.equal(git(root, ["show", "HEAD:notes.md"]), "Exact notes.\n")
  assert.equal(git(root, ["diff", "--name-only", base, "HEAD"]), "notes.md\n", "the commit holds exactly notes.md")
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "other.md\n", "the unrelated staged entry is still staged")
})

test("desk_save: written bytes whose commit timed out before landing are not committed, never replayed, and leave another staged entry alone", async () => {
  const { root, base, result, commits, pushes } = await savedNotes(timedOutBeforeCommit)
  assert.equal(result.commit?.status, "failed")
  assert.equal(result.commit.reason, "timeout")
  assertRoute(result.commit.route_around)
  assert.deepEqual(pushes, [], "nothing landed, so nothing is pushed")
  assert.equal(commits(), 1, "exactly one commit dispatch: the failure is never retried")
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), base)
  assert.match(git(root, ["diff", "--cached", "--name-only"]), /^other\.md$/m, "the unrelated staged entry is still staged")
})

test("desk_save: a commit that timed out before landing keeps nothing_to_commit and the timeout, and adds its route", async () => {
  const root = await repo()
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")
  const result = await desk_save({ deskRoot: root, input: { paths: ["notes.md"], message: "save notes" }, spawnGit: timedOutBeforeCommit, schedulePush: () => assert.fail("no push") })
  const { route_around: route, ...commit } = result.commit
  assert.deepEqual({ ...result, commit }, { status: "nothing_to_commit", commit: { status: "failed", reason: "timeout" } })
  assertRoute(route)
})

// ── the improvement-card path (string commit codes) ────────────────────────

async function cardRepo() {
  const deskRoot = await repo()
  const folder = path.join(deskRoot, "_meta", "improvement")
  await fs.mkdir(folder, { recursive: true })
  const write = async () => {
    await fs.writeFile(path.join(folder, "2026-05-22-card.md"), "card", "utf8")
    return { result: "opened", file: path.join(folder, "2026-05-22-card.md") }
  }
  return { deskRoot, write }
}

test("writeCardCommitted: a commit that landed but timed out is committed and pushed", async () => {
  const { deskRoot, write } = await cardRepo()
  const pushes = []
  const out = await writeCardCommitted({ deskRoot, write, message: "improvement: open card", spawnGit: landedThenTimedOut, schedulePush: (arg) => pushes.push(arg) })
  assert.equal(out.commit, "committed")
  assert.equal(out.route_around, undefined)
  assert.deepEqual(pushes, [{ root: deskRoot }])
  assert.equal(subject(deskRoot), "improvement: open card")
})

test("writeCardCommitted: a commit that did not land is commit_failed with route_around", async () => {
  const { deskRoot, write } = await cardRepo()
  const out = await writeCardCommitted({ deskRoot, write, message: "improvement: open card", spawnGit: timedOutBeforeCommit, schedulePush: () => assert.fail("no push") })
  assert.equal(out.commit, "commit_failed")
  assertRoute(out.route_around)
})

test("writeCardCommitted: a commit Desk cannot read back is commit_unknown with route_around", async () => {
  const { deskRoot, write } = await cardRepo()
  const out = await writeCardCommitted({ deskRoot, write, message: "improvement: open card", spawnGit: unreadable(), schedulePush: () => assert.fail("no push") })
  assert.equal(out.commit, "commit_unknown")
  assertRoute(out.route_around)
})

// ── running the route by hand finishes the job ─────────────────────────────

function runArgv(argv) {
  const list = Array.isArray(argv[0]) ? argv : [argv]
  return list.map(([cmd, ...args]) => spawnSync(cmd, args, { encoding: "utf8" }))
}

async function repoWithOrigin() {
  const root = await repo()
  const origin = `${root}-origin.git`
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8" })
  git(root, ["checkout", "-q", "-b", "main"])
  await fs.writeFile(path.join(root, "README.md"), "seed\n", "utf8")
  git(root, ["add", "README.md"])
  git(root, ["commit", "-q", "-m", "seed"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-q", "-u", "origin", "main"])
  return { root, origin }
}

test("the route of a commit that did not land, run by hand, commits exactly the paths and publishes them", async () => {
  const { root, origin } = await repoWithOrigin()
  await fs.writeFile(path.join(root, "unrelated.txt"), "not mine\n", "utf8")
  const result = await friction_add({ deskRoot: root, input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." }, spawnGit: timedOutBeforeCommit, schedulePush: () => assert.fail("no push") })
  const route = result.commit.route_around
  for (const step of route.steps) {
    if (!step.argv) continue
    // Step 1 is the read-back; the hand commit runs only because it listed the path.
    if (route.steps.indexOf(step) === 0) {
      assert.match(runArgv(step.argv)[0].stdout, /_meta\/friction\.md/u)
      continue
    }
    for (const ran of runArgv(step.argv)) assert.equal(ran.status, 0, ran.stderr)
  }
  assert.equal(runArgv(route.committed_locally_when.argv)[0].stdout, "", "committed here")
  for (const ran of runArgv(route.published_when.argv)) assert.equal(ran.status, 0, `published: ${ran.stdout}${ran.stderr}`)
  const remote = spawnSync("git", ["--git-dir", origin, "show", "main:_meta/friction.md"], { encoding: "utf8" })
  assert.equal(remote.status, 0, remote.stderr)
  assert.match(remote.stdout, /onboarding hurts/u, "the remote holds the change")
  assert.match(git(root, ["status", "--porcelain"]), /\?\? unrelated\.txt/u, "nothing else was committed")
})

test("the route for a file that held another session's edit commits only this change and leaves that edit uncommitted", async () => {
  const { root, origin } = await repoWithOrigin()
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk\n", "utf8")
  git(root, ["add", "AGENTS.md"])
  git(root, ["commit", "-q", "-m", "init"])
  git(root, ["push", "-q"])
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk\n\nAnother session's edit.\n", "utf8")
  const result = await lesson({ deskRoot: root, schedulePush: () => assert.fail("no push") })
  const route = result.route_around
  const worktree = route.steps[0].argv[0][8]
  for (const ran of runArgv(route.steps[0].argv)) assert.equal(ran.status, 0, ran.stderr)
  // Step 2 is in words: make the same change in the worktree's copy. Here that is adding the lesson to the committed text.
  const ours = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  await fs.writeFile(path.join(worktree, "AGENTS.md"), ours.replace("Another session's edit.\n\n", ""), "utf8")
  for (const step of route.steps.slice(2, 5)) for (const ran of runArgv(step.argv)) assert.equal(ran.status, 0, ran.stderr)
  await fs.rm(worktree, { recursive: true, force: true })
  for (const ran of runArgv(route.steps[5].argv)) assert.equal(ran.status, 0, ran.stderr)
  for (const ran of runArgv(route.steps[6].argv)) assert.equal(ran.status, 0, ran.stderr)
  assert.equal(runArgv(route.committed_locally_when.argv)[0].stdout.includes("+Another session's edit."), true, "the other session's edit is still uncommitted")
  for (const ran of runArgv(route.published_when.argv)) assert.equal(ran.status, 0, `published: ${ran.stdout}${ran.stderr}`)
  const remote = spawnSync("git", ["--git-dir", origin, "show", "main:AGENTS.md"], { encoding: "utf8" }).stdout
  assert.match(remote, /Do it\./u, "the lesson is on the remote")
  assert.doesNotMatch(remote, /Another session's edit/u, "the other session's edit is not")
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /Another session's edit\.[^]*Do it\./u, "the working tree still has both")
})
