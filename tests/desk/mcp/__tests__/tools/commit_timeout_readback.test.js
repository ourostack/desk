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
import { existsSync, readdirSync } from "node:fs"
import * as os from "node:os"
import { lesson_add as lessonAdd } from "../../../../../plugins/desk/mcp/src/tools/lesson.js"
import { task_create, task_update, stageAndCommitCard } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { track_create } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { friction_add } from "../../../../../plugins/desk/mcp/src/tools/friction.js"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { task_move } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { writeCardCommitted } from "../../../../../plugins/desk/mcp/src/tools/_card-commit.js"
import { commitRoute } from "../../../../../plugins/desk/mcp/src/util/route-around.js"
import { resolveDeskStateDir } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { mkTempDeskRoot } from "./_helpers.js"
import { AGENTS_MD_CAP_BYTES } from "../../../../../plugins/desk/mcp/src/runtime/agents-md.js"
import { assertRoute, readsOnly } from "./_route_around.js"

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
// task_move and track_rename commit through a private index (commit-tree), not `git commit`.
const timedOutBeforeCommitTree = (cmd, args, opts) => (args.includes("commit-tree") ? { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: timeout() } : spawnSync(cmd, args, opts))

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
  assert.ok(readsOnly(result.route_around.steps[0]), "step 1 is the read-back, never a second commit")
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
    card: true,
    rel: "europe-trip/book-flights/task.md",
    run: (root, spawnGit, schedulePush) => task_create({ deskRoot: root, input: { track: "europe-trip", slug: "book-flights", title: "Book the Paris flights" }, spawnGit, schedulePush }),
  },
  {
    name: "task_update",
    card: true,
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
    // A live card's route finishes Desk's recorded change (capture-record.js), so it is not held and publishes the desk root like any route.
    assert.equal(result.commit.route_around.held, undefined)
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

// Follows a route the way its words say: step 1's exit code picks the path, a step that runs "only if step 1 exited 3" runs only
// then, a Desk tool step goes to `tools`, and "Stop here" stops. Returns step 1's exit code and output, and the exit code of the
// newer-edits check (null when the route has none); that check's non-zero exit is its answer, not a failure of the route.
async function followRoute(route, tools = {}) {
  const first = runArgv(route.steps[0].argv)
  const code = first.at(-1).status
  let newer = null
  for (const step of route.steps.slice(1)) {
    if (/^Stop here/u.test(step.step)) break
    if (/^Only if step 1 exited 3/u.test(step.step) && code !== 3) continue
    if (step.tool) { await tools[step.tool](step.arguments); continue }
    if (/^Read whether these paths hold anything newer/u.test(step.step)) { newer = runArgv(step.argv).at(-1).status; continue }
    for (const ran of runArgv(step.argv)) assert.equal(ran.status, 0, `${step.step}: ${ran.stdout}${ran.stderr}`)
  }
  return { code, first, newer }
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

const remoteShow = (origin, rel) => spawnSync("git", ["--git-dir", origin, "show", `main:${rel}`], { encoding: "utf8" })
const indexState = (root, rels) => ({ head: git(root, ["rev-parse", "HEAD"]), index: git(root, ["ls-files", "-s", "--", ...rels]), cached: git(root, ["diff", "--cached", "--", ...rels]), worktree: git(root, ["diff", "--", ...rels]) })

test("the route of a commit that did not land, run by hand, commits exactly the captured change once and publishes it", async () => {
  const { root, origin } = await repoWithOrigin()
  await fs.writeFile(path.join(root, "unrelated.txt"), "not mine\n", "utf8")
  const result = await friction_add({ deskRoot: root, input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." }, spawnGit: timedOutBeforeCommit, schedulePush: () => assert.fail("no push") })
  const route = result.commit.route_around
  const seed = git(root, ["rev-parse", "HEAD"]).trim()
  const { code, first, newer } = await followRoute(route)
  assert.equal(code, 3, first[0].stdout)
  assert.match(first[0].stdout, /"state":"ready"/u)
  assert.equal(newer, 0, "nothing newer than the change is left at the path")
  const local = runArgv(route.committed_locally_when.argv)[0]
  assert.equal(local.status, 0, local.stdout)
  assert.match(local.stdout, /"state":"committed"/u, "committed here")
  assert.equal(git(root, ["rev-parse", "HEAD~1"]).trim(), seed, "exactly one commit")
  for (const ran of runArgv(route.published_when.argv)) assert.equal(ran.status, 0, `published: ${ran.stdout}${ran.stderr}`)
  const remote = remoteShow(origin, "_meta/friction.md")
  assert.equal(remote.status, 0, remote.stderr)
  assert.match(remote.stdout, /onboarding hurts/u, "the remote holds the change")
  assert.match(git(root, ["status", "--porcelain"]), /\?\? unrelated\.txt/u, "nothing else was committed")
})

// 0972 #1 on ae1395e4: a move names folders, and the folder it moved from is gone. The route finishes the move, every leaf of
// the old folder removed and the new one added, never a copy that keeps both.
test("the route of a task move that did not land, run by hand, commits the move itself and publishes it, never a copy", async () => {
  const { root, origin } = await repoWithOrigin()
  await track_create({ deskRoot: root, input: { slug: "trip", title: "Trip", scope: SCOPE }, schedulePush: () => {} })
  await task_create({ deskRoot: root, input: { track: "trip", slug: "old-name", title: "T" }, schedulePush: () => {} })
  await fs.writeFile(path.join(root, "trip", "old-name", "notes.md"), "notes\n", "utf8")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "fixture"])
  const result = await task_move({ deskRoot: root, input: { track: "trip", slug: "old-name", to_slug: "new-name" }, spawnGit: timedOutBeforeCommitTree, schedulePush: () => assert.fail("no push") })
  const route = result.commit.route_around
  assertRoute(route)
  const { code, first } = await followRoute(route)
  assert.equal(code, 3, first[0].stdout)
  const local = runArgv(route.committed_locally_when.argv)[0]
  assert.equal(local.status, 0, local.stdout)
  const tree = git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", "trip"]).split("\n").filter(Boolean)
  assert.deepEqual(tree.filter((p) => p.includes("old-name")), [], "nothing is left at the old name")
  assert.ok(tree.includes("trip/new-name/task.md") && tree.includes("trip/new-name/notes.md"), tree.join(" "))
  assert.equal(git(root, ["status", "--porcelain"]), "", "the checkout agrees with HEAD")
  for (const ran of runArgv(route.published_when.argv)) assert.equal(ran.status, 0, `published: ${ran.stdout}${ran.stderr}`)
  assert.notEqual(remoteShow(origin, "trip/old-name/task.md").status, 0, "the remote holds no copy at the old name")
  assert.equal(remoteShow(origin, "trip/new-name/notes.md").stdout, "notes\n")
})

// A live card's route finishes Desk's own record of the change (capture-record.js), never the command line: the finish names the
// record by its id, and the card guard lets through only that recorded commit. A new task_update is still a new write, never a finish.
function assertCardRecorded(route, card) {
  assertRoute(route)
  assert.equal(route.held, undefined, "the route of a live card with Desk's record is not held")
  for (const step of route.steps) {
    assert.equal(step.tool, undefined, `no Desk tool step: ${step.step}`)
    assert.ok(step.argv === undefined || readsOnly(step) || /^Only if step 1 exited 3/u.test(step.step) || /^Read whether|^Publish/u.test(step.step), `only the finish commits: ${step.step}`)
  }
  const finish = route.steps[1].argv
  assert.ok(finish.includes("--capture-id") && !finish.includes("--entry"), "the finish names the record and carries no captured entries")
  assert.match(route.steps[1].step, /^Only if step 1 exited 3 \(ready\)/u)
  assert.doesNotMatch(JSON.stringify(route), /DESK_TOOL_COMMIT/u, "the card guard's override is never named")
  assert.doesNotMatch(route.steps[1].step, /desk_save/u, "a card is finished by Desk's finish, never saved with desk_save")
  assert.match(route.summary, new RegExp(`card ${card} `, "u"))
}

// Each live-card case gets its own state folder, so the records it leaves are its own.
async function cardTimedOut(stateHome) {
  process.env.XDG_STATE_HOME = stateHome ?? await fs.mkdtemp(path.join(os.tmpdir(), "desk-captures-"))
  const { root, origin } = await repoWithOrigin()
  await track_create({ deskRoot: root, input: { slug: "t", title: "T", scope: SCOPE }, schedulePush: () => {} })
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })
  assert.equal(git(root, ["status", "--porcelain"]), "", "the fixture is committed")
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "book-flights", frontmatter: { status: "processing" } }, spawnGit: timedOutBeforeCommit, schedulePush: () => assert.fail("no push") })
  assert.equal(result.commit?.status, "failed")
  return { root, origin, route: result.commit.route_around, result }
}

const CARD = ["t/book-flights/task.md", "t/track.md"]
const capturesLeft = () => {
  const dir = path.join(resolveDeskStateDir(), "pending-captures")
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : []
}

test("the route of a live card finishes Desk's recorded change: it reads, commits once, publishes, and removes the record", async () => {
  const { root, origin, route, result } = await cardTimedOut()
  assert.deepEqual(Object.keys(result).slice(0, 2), ["next", "status"], "the answer opens with the next step, then its status")
  assert.equal(result.status, "updated", "the status is unchanged: the note is on disk")
  assert.match(result.next, /^The change is on disk but not committed or on the remote yet: run commit\.route_around\.steps now, in order, then read back the remote\.$/u)
  const { code, first, newer } = await followRoute(route, { task_update: () => assert.fail("the route never calls task_update") })
  assert.equal(code, 3, first[0].stdout)
  assertCardRecorded(route, "t/book-flights")
  assert.equal(git(root, ["status", "--porcelain"]), "", "the checkout agrees with HEAD")
  assert.deepEqual(git(root, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n"), ["t/book-flights/task.md"], "exactly the card")
  assert.equal(newer, 0, "nothing newer than the recorded change")
  assert.equal(spawnSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim(), git(root, ["rev-parse", "HEAD"]).trim(), "the remote holds the commit")
  assert.equal(runArgv(route.committed_locally_when.argv)[0].status, 0, "the read-back now says committed")
  assert.deepEqual(capturesLeft(), [], "the record is removed once its commit is proven landed")
})

test("the route of a live card leaves another session's later staged and unstaged edits to the card and track.md exactly as they were", async () => {
  const { root, route } = await cardTimedOut()
  await fs.appendFile(path.join(root, "t", "track.md"), "\nAnother session's staged edit.\n", "utf8")
  await fs.appendFile(path.join(root, "t", "book-flights", "task.md"), "\nAnother session's staged edit.\n", "utf8")
  git(root, ["add", "--", ...CARD])
  await fs.appendFile(path.join(root, "t", "book-flights", "task.md"), "\nAnother session's unstaged edit.\n", "utf8")
  await fs.appendFile(path.join(root, "t", "track.md"), "\nAnother session's unstaged edit.\n", "utf8")
  const before = indexState(root, CARD)
  const head = git(root, ["rev-parse", "HEAD"])
  assertCardRecorded(route, "t/book-flights")
  const { code, first } = await followRoute(route, { task_update: () => assert.fail("the route never calls task_update") })
  assert.equal(code, 4, first[0].stdout)
  assert.deepEqual(indexState(root, CARD), before, "the other session's staged and unstaged work is untouched")
  assert.equal(git(root, ["rev-parse", "HEAD"]), head, "HEAD does not move")
  assert.equal(capturesLeft().length, 1, "the record stays while its commit has not landed")
})

test("a live card whose change Desk cannot record is held: its route only reads and commits nothing", async () => {
  const saved = process.env.XDG_STATE_HOME
  const blocker = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "desk-captures-")), "not-a-folder")
  await fs.writeFile(blocker, "x")
  try {
    const { root, route, result } = await cardTimedOut(blocker)
    assertRoute(route)
    assert.equal(route.held, true, "without a record the route of a live card is held")
    assert.match(result.next, /^The change is on disk but not committed, and Desk will not finish it from here: read back with commit\.route_around\.steps step 1 \(it only reads\), then report its JSON together with the tool's failure\.$/u, "a held route says to report the read-back, not to run the steps")
    assert.doesNotMatch(result.next, /can't|cannot finish|not in effect/u)
    for (const step of route.steps) assert.ok(step.argv === undefined || readsOnly(step), `every step only reads: ${step.step}`)
    assert.doesNotMatch(JSON.stringify(route), /--capture-id/u)
    assert.notEqual(git(root, ["status", "--porcelain"]), "", "the change is kept, uncommitted")
  } finally {
    process.env.XDG_STATE_HOME = saved
  }
})

// R2 (0972 on #625): a clean status is no proof. The change was unstaged and its file removed after the failure: status is clean,
// HEAD never held the change. The route says held, commits nothing, and its local read-back fails.
test("the route of a commit that did not land, whose change then vanished with a clean status, is held and commits nothing", async () => {
  const { root } = await repoWithOrigin()
  const result = await desk_save({ deskRoot: root, input: { files: [{ path: "notes.md", content: "Exact notes.\n" }], message: "save notes" }, spawnGit: timedOutBeforeCommit, schedulePush: () => assert.fail("no push") })
  git(root, ["rm", "-q", "--cached", "notes.md"])
  await fs.rm(path.join(root, "notes.md"))
  assert.equal(git(root, ["status", "--porcelain"]), "")
  const before = indexState(root, ["notes.md"])
  const route = result.commit.route_around
  const { code } = await followRoute(route)
  assert.equal(code, 4, "held")
  assert.deepEqual(indexState(root, ["notes.md"]), before)
  assert.notEqual(runArgv(route.committed_locally_when.argv)[0].status, 0, "the local read-back does not call it committed")
})

// R2: after an UNKNOWN dispatch that landed, a later edit at the path may be another session's. The route reads the change in,
// commits nothing more, and publishes only what landed.
test("the route of an unknown commit that landed never commits the dirt that came after it, and publishes only what landed", async () => {
  const { root, origin } = await repoWithOrigin()
  const landedUnreadable = (() => {
    let landed = false
    return (cmd, args, opts) => {
      if (isCommit(args)) { landed = true; return landedThenTimedOut(cmd, args, opts) }
      if (landed && args.includes("rev-parse")) return { status: 128, stdout: "", stderr: "fatal: cannot lock ref" }
      return spawnSync(cmd, args, opts)
    }
  })()
  const result = await desk_save({ deskRoot: root, input: { files: [{ path: "notes.md", content: "Exact notes.\n" }], message: "save notes" }, spawnGit: landedUnreadable, schedulePush: () => assert.fail("no push for an unknown commit") })
  assert.equal(result.commit.status, "unknown")
  await fs.writeFile(path.join(root, "notes.md"), "Exact notes.\nSomeone else's line.\n", "utf8")
  git(root, ["add", "notes.md"])
  await fs.writeFile(path.join(root, "notes.md"), "Exact notes.\nSomeone else's line.\nAnd more.\n", "utf8")
  const before = indexState(root, ["notes.md"])
  const route = result.commit.route_around
  const { code, newer } = await followRoute(route)
  assert.equal(code, 0, "already committed")
  assert.equal(newer, 1, "the later edit is reported as newer than the save, so it is not delivered")
  const { head, ...rest } = indexState(root, ["notes.md"])
  assert.deepEqual({ head, ...rest }, before, "nothing was committed, staged or reset")
  for (const ran of runArgv(route.published_when.argv)) assert.equal(ran.status, 0, `published: ${ran.stdout}${ran.stderr}`)
  assert.equal(remoteShow(origin, "notes.md").stdout, "Exact notes.\n", "the remote holds exactly what landed")
})

async function heldLesson({ staged = false, shelf = false } = {}) {
  const { root, origin } = await repoWithOrigin()
  const old = Array.from({ length: 5 }, (_, index) => `- **Old ${index}.** ${"w".repeat(60)} (2026-01-0${index + 1})`)
  const agents = shelf ? `# Desk\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 300)}\n\n## Lessons\n\n${old.join("\n")}\n` : "# Desk\n"
  await fs.writeFile(path.join(root, "AGENTS.md"), agents, "utf8")
  git(root, ["add", "AGENTS.md"])
  git(root, ["commit", "-q", "-m", "init"])
  git(root, ["push", "-q"])
  // Another session's edit: a staged line, and an unstaged one after it.
  if (staged) {
    await fs.writeFile(path.join(root, "AGENTS.md"), agents.replace("# Desk\n", "# Desk\n\nAnother session's staged edit.\n"), "utf8")
    git(root, ["add", "AGENTS.md"])
  }
  const current = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  await fs.writeFile(path.join(root, "AGENTS.md"), current.replace("# Desk\n", "# Desk\n\nAnother session's edit.\n"), "utf8")
  const before = indexState(root, ["AGENTS.md", "LESSONS.md"])
  const result = await lesson({ deskRoot: root, schedulePush: () => assert.fail("no push") })
  return { root, origin, result, before }
}

// R1 (0972 on #625): the route never resets another session's index entries. Staged and unstaged work stays exactly as it was.
test("the route for a file that held another session's staged and unstaged edit only reads, and leaves that work exactly as it was", async () => {
  const { root, result } = await heldLesson({ staged: true })
  const route = result.route_around
  assertRoute(route)
  const index = git(root, ["ls-files", "-s", "--", "AGENTS.md"])
  const cached = git(root, ["diff", "--cached", "--", "AGENTS.md"])
  const text = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  const shown = runArgv(route.steps[0].argv)
  for (const ran of shown) assert.equal(ran.status, 0, ran.stderr)
  assert.match(shown[0].stdout, /Another session's staged edit/u, "step 1 shows the other session's work, so the route stops here")
  await followRoute(route, { desk_save: async () => {} })
  assert.equal(git(root, ["ls-files", "-s", "--", "AGENTS.md"]), index, "the staged entry is unchanged")
  assert.equal(git(root, ["diff", "--cached", "--", "AGENTS.md"]), cached, "the staged selection is unchanged")
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), text, "the working tree is unchanged")
  assert.match(cached, /Another session's staged edit/u)
})

test("the route for a file that held another session's edit commits this change through desk_save once the file holds nothing else", async () => {
  const { root, origin, result } = await heldLesson()
  const route = result.route_around
  assertRoute(route)
  assert.match(route.never, /Never commit AGENTS\.md whole/u)
  // The other session settles its edit (here, drops it); then step 1 shows only the lesson and desk_save commits it.
  const text = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  await fs.writeFile(path.join(root, "AGENTS.md"), text.replace("\nAnother session's edit.\n", ""), "utf8")
  assert.doesNotMatch(runArgv(route.steps[0].argv)[0].stdout, /Another session's edit/u)
  await followRoute(route, { desk_save: async (args) => assert.equal((await desk_save({ deskRoot: root, input: args, schedulePush: () => {} })).status, "committed") })
  const local = runArgv(route.committed_locally_when.argv)
  assert.equal(local[0].status, 0, local[0].stdout)
  assert.equal(local[1].stdout.trim(), result.route_around.steps[1].arguments.message)
  for (const ran of runArgv(route.published_when.argv)) assert.equal(ran.status, 0, `published: ${ran.stdout}${ran.stderr}`)
  assert.match(remoteShow(origin, "AGENTS.md").stdout, /Do it\./u, "the lesson is on the remote")
})

// R7 (0972 on #625): a lesson that moves older topics to a new LESSONS.md shelf is one change across both files. The route reads
// both (the new file too), names the whole change, and commits both together once they hold nothing else.
test("the route for a held lesson that opens a new shelf file reads both files and commits the whole change, the new shelf included", async () => {
  const { root, origin, result } = await heldLesson({ shelf: true })
  const route = result.route_around
  assertRoute(route)
  assert.deepEqual(route.steps[1].arguments.paths.sort(), ["AGENTS.md", "LESSONS.md"])
  assert.match(route.steps[1].step, /LESSONS\.md/u, "the change names the shelf")
  assert.match(route.steps[1].step, /moved from AGENTS\.md to LESSONS\.md/u, "the change names the move")
  const moved = route.steps[1].step.match(/Old \d/gu)
  assert.ok(moved?.length, "the change names the moved topics")
  const shown = runArgv(route.steps[0].argv)
  for (const ran of shown) assert.equal(ran.status, 0, ran.stderr)
  assert.match(shown[1].stdout, /\?\? LESSONS\.md/u, "step 1 shows the new shelf file")
  // 0972 on ae1395e4: neither read shows a new file's content, so step 1 says so and names the file to read whole.
  assert.match(route.steps[0].step, /`\?\?` is new/u, "step 1 says a file marked ?? is new and has no diff")
  for (const name of ["AGENTS.md", "LESSONS.md"]) assert.ok(route.steps[0].step.includes(path.join(root, name)), `step 1 names ${name} to read whole`)
  const text = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  await fs.writeFile(path.join(root, "AGENTS.md"), text.replace("\nAnother session's edit.\n", ""), "utf8")
  await followRoute(route, { desk_save: async (args) => assert.equal((await desk_save({ deskRoot: root, input: args, schedulePush: () => {} })).status, "committed") })
  for (const ran of runArgv(route.published_when.argv)) assert.equal(ran.status, 0, `published: ${ran.stdout}${ran.stderr}`)
  for (const topic of moved) assert.match(remoteShow(origin, "LESSONS.md").stdout, new RegExp(topic, "u"), "the shelf is on the remote")
  assert.match(remoteShow(origin, "AGENTS.md").stdout, /Do it\./u, "the lesson is on the remote")
})

// R2 (0972 on #625): without the change Desk captured before dispatch, no read of the paths can say which bytes are this call's,
// so a route never commits, saves, updates a card or publishes on the strength of a diff, a log line or a clean status. It reads,
// stops, and says so; the next write of the same thing commits it through the tool.
function assertHeldReadOnly(route) {
  assertRoute(route)
  assert.equal(route.held, true, "a route without a captured change is held")
  for (const step of route.steps) {
    assert.equal(step.tool, undefined, `no Desk tool step: ${step.step}`)
    assert.ok(step.argv === undefined || readsOnly(step), `every step only reads: ${step.step}`)
  }
  assert.doesNotMatch(JSON.stringify(route), /sync-push\.js|finish-commit\.js[^"]*--commit/u, "nothing is published or committed")
  assert.doesNotMatch(JSON.stringify(route.steps), /the commit is in|publish/iu, "no read is promoted to proof of the commit")
  assert.match(route.committed_locally_when.expect, /no read here proves/u)
}

test("a route without a captured change is held and only reads, whether the commit did not land or Desk cannot tell", () => {
  for (const readback of ["absent", "unknown"]) {
    assertHeldReadOnly(commitRoute({ root: "/desk", paths: ["notes.md"], message: "save notes", readback }))
    assertHeldReadOnly(commitRoute({ root: "/desk", paths: ["track/slug/task.md", "track/track.md"], message: "task_update", readback, card: "track/slug" }))
  }
})

test("a background writer that defers its card gets a held route that commits nothing, saves nothing and updates no card", async () => {
  const { deskRoot, write } = await cardRepo()
  await fs.writeFile(path.join(deskRoot, ".git", "index.lock"), "")
  process.env.DESK_GIT_YIELD = "1"
  try {
    const out = await writeCardCommitted({ deskRoot, write, message: "improvement: open card", schedulePush: () => assert.fail("no push") })
    assert.equal(out.commit, "deferred")
    assertHeldReadOnly(out.route_around)
  } finally {
    delete process.env.DESK_GIT_YIELD
    await fs.rm(path.join(deskRoot, ".git", "index.lock"), { force: true })
  }
})

test("desk_save on a detached HEAD, which the tool refuses, gets a held route that never saves the paths again", async () => {
  const { root } = await repoWithOrigin()
  git(root, ["checkout", "-q", "--detach"])
  const result = await desk_save({ deskRoot: root, input: { files: [{ path: "notes.md", content: "Exact notes.\n" }], message: "save notes" }, schedulePush: () => assert.fail("no push") })
  const route = result.commit?.route_around ?? result.route_around
  if (route) assertHeldReadOnly(route)
  else assert.notEqual(result.status, "committed")
})

// A held lesson that lands on the shelf itself, moving exactly one older lesson: the route names the whole change in the
// singular, the shelf as where the line went, and both files.
test("the route for a held lesson that goes to the shelf and moves one older lesson names that one lesson and the shelf", async () => {
  const root = await repo()
  const agents = `# Desk\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 20)}\n\n## Lessons\n\n- **Hidden.** ${"w".repeat(40)} (2026-01-01)\n`
  await fs.writeFile(path.join(root, "AGENTS.md"), agents, "utf8")
  git(root, ["add", "AGENTS.md"])
  git(root, ["commit", "-q", "-m", "init"])
  await fs.writeFile(path.join(root, "AGENTS.md"), agents.replace("# Desk\n", "# Desk\n\nAnother session's edit.\n"), "utf8")
  const before = indexState(root, ["AGENTS.md", "LESSONS.md"])
  const result = await lesson({ deskRoot: root, schedulePush: () => assert.fail("no push") })
  assert.equal(result.tier, "shelf")
  assert.deepEqual(result.shelved?.topics, ["Hidden"])
  const route = result.route_around
  assertRoute(route)
  assert.match(route.steps[1].step, /the lesson line .* on LESSONS\.md, and the older lesson on Hidden moved from AGENTS\.md to LESSONS\.md/u)
  assert.deepEqual(route.steps[1].arguments.paths.sort(), ["AGENTS.md", "LESSONS.md"])
  const { head, ...rest } = indexState(root, ["AGENTS.md", "LESSONS.md"])
  assert.deepEqual({ head, index: rest.index, cached: rest.cached }, { head: before.head, index: before.index, cached: before.cached }, "nothing staged, committed or reset")
})

// A commit Desk cannot read back, written for a desk session start cannot place: both are said, joined, and in_effect is
// false because the not-loaded half is known.
test("lesson_add: an unknown commit for a lesson session start would not print says both, and is not in effect", async () => {
  const root = await repo()
  const result = await lesson({ deskRoot: root, spawnGit: unreadable(), personOf: async () => ({ status: "unknown", reason: "no person" }), schedulePush: () => assert.fail("no push for an unknown commit") })
  assert.equal(result.in_effect, false)
  assert.equal(result.commit.status, "unknown")
  assert.match(result.message, /^Written to AGENTS\.md, but not in effect: session start on this desk cannot tell whose desk this is \(no person\).*; and Desk cannot tell whether the commit landed/u)
})

// stageAndCommitCard named with only the file, the message and git: it commits that one file, names no live card, and roots
// the route at the file's own folder, so the route itself finishes the captured change.
test("stageAndCommitCard with no extra paths, card or desk root routes the file alone, from its own folder, and its route finishes it", async () => {
  const { root, origin } = await repoWithOrigin()
  const file = path.join(root, "notes.md")
  await fs.writeFile(file, "kept\n", "utf8")
  const seed = git(root, ["rev-parse", "HEAD"]).trim()
  const commit = stageAndCommitCard(file, "save notes", timedOutBeforeCommit)
  assert.equal(commit.status, "failed")
  const route = commit.route_around
  assertRoute(route)
  assert.equal(route.held, undefined, "no live card is named, so the captured change is not held")
  assert.doesNotMatch(JSON.stringify(route), /live card|task_update/u)
  const { code, first } = await followRoute(route)
  assert.equal(code, 3, first[0].stdout)
  assert.equal(runArgv(route.committed_locally_when.argv)[0].status, 0)
  assert.equal(git(root, ["rev-parse", "HEAD~1"]).trim(), seed, "exactly one commit")
  assert.deepEqual(git(root, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n"), ["notes.md"])
  for (const ran of runArgv(route.published_when.argv)) assert.equal(ran.status, 0, `published: ${ran.stdout}${ran.stderr}`)
  assert.equal(remoteShow(origin, "notes.md").stdout, "kept\n")
})
