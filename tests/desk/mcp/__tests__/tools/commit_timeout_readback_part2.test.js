// commit_timeout_readback, continued: the same suite as commit_timeout_readback.test.js, split so no single file sets a Windows shard's time.

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
import { moveTask } from "../../../../../plugins/desk/mcp/src/tools/move.js"
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
// task_update and track_update commit through a private index (commit-tree), not `git commit`.
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
  const result = await moveTask({ deskRoot: root, input: { track: "trip", slug: "old-name", to_slug: "new-name" }, spawnGit: timedOutBeforeCommitTree, schedulePush: () => assert.fail("no push") })
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

test("the route of a live card finishes Desk's recorded change: it reads, commits once, publishes, and removes the record", async () => {
  const { root, origin, route, result } = await cardTimedOut()
  assert.deepEqual(Object.keys(result).slice(0, 2), ["next", "status"], "the answer opens with the next step, then its status")
  assert.equal(result.status, "commit_failed", "the note is on disk but its commit did not land")
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
  assert.equal(result.status, "commit_unknown", "a commit that may have landed is never nothing_to_commit")
  assert.match(result.commit.reason, /^timeout: git commit was cut off by the clock \(ETIMEDOUT: .*; signal SIGTERM; exit status none\) after 10000 ms, so whether it landed rests on the read-back$/u, "the answer names the cut-off call, its error and signal, and its budget")
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
