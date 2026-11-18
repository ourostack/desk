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

async function heldLesson({ staged = false } = {}) {
  const { root, origin } = await repoWithOrigin()
  const shelf = "# Shelved lessons\n"
  await fs.writeFile(path.join(root, "LESSONS.md"), shelf, "utf8")
  git(root, ["add", "LESSONS.md"])
  git(root, ["commit", "-q", "-m", "init"])
  git(root, ["push", "-q"])
  // Another session's edit: a staged line, and an unstaged one after it.
  if (staged) {
    await fs.writeFile(path.join(root, "LESSONS.md"), shelf.replace("# Shelved lessons\n", "# Shelved lessons\n\nAnother session's staged edit.\n"), "utf8")
    git(root, ["add", "LESSONS.md"])
  }
  const current = await fs.readFile(path.join(root, "LESSONS.md"), "utf8")
  await fs.writeFile(path.join(root, "LESSONS.md"), current.replace("# Shelved lessons\n", "# Shelved lessons\n\nAnother session's edit.\n"), "utf8")
  const before = indexState(root, ["LESSONS.md"])
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

// R1 (0972 on #625): the route never resets another session's index entries. Staged and unstaged work stays exactly as it was.
test("the route for a file that held another session's staged and unstaged edit only reads, and leaves that work exactly as it was", async () => {
  const { root, result } = await heldLesson({ staged: true })
  const route = result.route_around
  assertRoute(route)
  const index = git(root, ["ls-files", "-s", "--", "LESSONS.md"])
  const cached = git(root, ["diff", "--cached", "--", "LESSONS.md"])
  const text = await fs.readFile(path.join(root, "LESSONS.md"), "utf8")
  const shown = runArgv(route.steps[0].argv)
  for (const ran of shown) assert.equal(ran.status, 0, ran.stderr)
  assert.match(shown[0].stdout, /Another session's staged edit/u, "step 1 shows the other session's work, so the route stops here")
  await followRoute(route, { desk_save: async () => {} })
  assert.equal(git(root, ["ls-files", "-s", "--", "LESSONS.md"]), index, "the staged entry is unchanged")
  assert.equal(git(root, ["diff", "--cached", "--", "LESSONS.md"]), cached, "the staged selection is unchanged")
  assert.equal(await fs.readFile(path.join(root, "LESSONS.md"), "utf8"), text, "the working tree is unchanged")
  assert.match(cached, /Another session's staged edit/u)
})

test("the route for a file that held another session's edit commits this change through desk_save once the file holds nothing else", async () => {
  const { root, origin, result } = await heldLesson()
  const route = result.route_around
  assertRoute(route)
  assert.match(route.never, /Never commit LESSONS\.md whole/u)
  // The other session settles its edit (here, drops it); then step 1 shows only the lesson and desk_save commits it.
  const text = await fs.readFile(path.join(root, "LESSONS.md"), "utf8")
  await fs.writeFile(path.join(root, "LESSONS.md"), text.replace("\nAnother session's edit.\n", ""), "utf8")
  assert.doesNotMatch(runArgv(route.steps[0].argv)[0].stdout, /Another session's edit/u)
  await followRoute(route, { desk_save: async (args) => assert.equal((await desk_save({ deskRoot: root, input: args, schedulePush: () => {} })).status, "committed") })
  const local = runArgv(route.committed_locally_when.argv)
  assert.equal(local[0].status, 0, local[0].stdout)
  assert.equal(local[1].stdout.trim(), result.route_around.steps[1].arguments.message)
  for (const ran of runArgv(route.published_when.argv)) assert.equal(ran.status, 0, `published: ${ran.stdout}${ran.stderr}`)
  assert.match(remoteShow(origin, "LESSONS.md").stdout, /Do it\./u, "the lesson is on the remote")
})

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

// A commit Desk cannot read back, written for a desk session start cannot place: both are said, joined, and in_effect is
// false because the not-loaded half is known.
test("lesson_add: an unknown commit for a lesson session start would not print says both, and is not in effect", async () => {
  const root = await repo()
  const result = await lesson({ deskRoot: root, spawnGit: unreadable(), personOf: async () => ({ status: "unknown", reason: "no person" }), schedulePush: () => assert.fail("no push for an unknown commit") })
  assert.equal(result.in_effect, false)
  assert.equal(result.commit.status, "unknown")
  assert.match(result.message, /^Written to LESSONS\.md, but not in effect: session start on this desk cannot tell whose desk this is \(no person\).*; and Desk cannot tell whether the commit landed/u)
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
