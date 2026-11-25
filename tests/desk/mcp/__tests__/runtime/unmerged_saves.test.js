// A Desk save always reaches the desk's main by itself, and when it cannot, everyone hears: every publication PR carries the
// merge-when-green label after policy qualification, a conflicting save is rebuilt on the newest main, a save that is
// already on main is closed as superseded with the evidence, and a save still unmerged after ten minutes is named in tool
// replies, boot and `drains status`. Real Git repositories; `gh` is a fake that merges into the bare origin.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { runner } from "../../../../../plugins/desk/mcp/src/runtime/deliver.js"
import { publishPullRequest } from "../../../../../plugins/desk/mcp/src/runtime/pr-publication.js"
import { readSyncStatus, runPushWorker, updateSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { abandonedComment, allStuckSaves, repositoryOf, savesFor, settleSaves, stuckLine, stuckSaves, withStuckSaves } from "../../../../../plugins/desk/mcp/src/runtime/unmerged-saves.js"
import { syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { resolveDeskStateDir } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"

const MINUTE = 60_000
const upstream = { remote: "origin", merge: "refs/heads/main", tracking: "refs/remotes/origin/main" }
const policy = { schema_version: 1, mode: "pull-request", required_checks: ["workspace-policy"] }

function git(root, args) {
  const location = existsSync(path.join(root, "HEAD")) ? ["--git-dir", root] : ["-C", root]
  const result = spawnSync("git", [...location, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

// A bare origin whose main holds a log, and a desk clone of it.
async function world(label) {
  const origin = await mkTempRoot(`desk-saves-origin-${label}-`)
  git(origin, ["init", "-q", "--bare", "-b", "main"])
  const seed = await mkTempRoot(`desk-saves-seed-${label}-`)
  git(seed, ["clone", "-q", origin, "."])
  git(seed, ["config", "user.email", "test@example.com"])
  git(seed, ["config", "user.name", "Test"])
  await fs.writeFile(path.join(seed, "log.md"), "# Log\n\n- first\n")
  await fs.mkdir(path.join(seed, ".desk"))
  await fs.writeFile(path.join(seed, ".desk", "publication.json"), JSON.stringify(policy))
  git(seed, ["add", "."])
  git(seed, ["commit", "-q", "-m", "seed"])
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  const desk = await mkTempRoot(`desk-saves-desk-${label}-`)
  git(desk, ["clone", "-q", origin, "."])
  git(desk, ["config", "user.email", "test@example.com"])
  git(desk, ["config", "user.name", "Test"])
  git(desk, ["branch", "-q", "--set-upstream-to", "origin/main"])
  const state = await mkTempRoot(`desk-saves-state-${label}-`)
  return { origin, seed, desk, env: { ...process.env, XDG_STATE_HOME: state } }
}

async function appendTo(root, line, message) {
  await fs.appendFile(path.join(root, "log.md"), `${line}\n`)
  git(root, ["add", "log.md"])
  git(root, ["commit", "-q", "-m", message])
  return git(root, ["rev-parse", "HEAD"])
}

// A `gh` that keeps pull requests in memory and merges them into the bare origin's main by fast-forward.
function fakeGh(origin, options = {}) {
  const calls = []
  const prs = new Map()
  const fake = (command, args, spawnOptions) => {
    // Git is real; only the remote's address reads as a GitHub one.
    if (command === "git") {
      if (args.includes("get-url")) return { status: 0, stdout: "https://github.example/team/workspace.git\n", stderr: "" }
      return spawnSync(command, args, spawnOptions)
    }
    assert.equal(command, "gh")
    if (options.authFailed) return { status: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }
    calls.push(args)
    const ok = (value) => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value) })
    const main = () => git(origin, ["rev-parse", "refs/heads/main"])
    const byBranch = (branch) => [...prs.values()].find((pr) => pr.branch === branch)
    const byRef = (ref) => [...prs.values()].find((pr) => pr.url === ref || String(pr.number) === ref)
    if (args[0] === "label") return ok("")
    if (args[0] === "pr" && args[1] === "list" && !args.includes("--head")) {
      return ok([...prs.values()].filter((pr) => pr.state === "OPEN").map((pr) => ({ ...view(pr), headRefName: pr.branch, createdAt: new Date(Date.now() - 480 * 60_000).toISOString() })))
    }
    if (args[0] === "pr" && args[1] === "list") return ok(byBranch(args[args.indexOf("--head") + 1]) ? [view(byBranch(args[args.indexOf("--head") + 1]))] : [])
    if (args[0] === "pr" && args[1] === "create") {
      const branch = args[args.indexOf("--head") + 1]
      const number = prs.size + 1
      prs.set(number, { number, branch, url: `https://github.example/team/workspace/pull/${number}`, state: "OPEN", labels: [], head: git(origin, ["rev-parse", `refs/heads/${branch}`]) })
      return ok(prs.get(number).url)
    }
    if (args[0] === "pr" && args[1] === "edit") { byRef(args[2]).labels.push(args[args.indexOf("--add-label") + 1]); return ok("") }
    if (args[0] === "api" && args.some((arg) => /\/issues\/\d+\/labels$/u.test(arg))) {
      const pr = byRef(args.find((arg) => /\/issues\/\d+\/labels$/u.test(arg)).match(/issues\/(\d+)/u)[1])
      pr.labels.push(args[args.indexOf("-f") + 1].slice("labels[]=".length))
      return ok(pr.labels.map((name) => ({ name })))
    }
    if (args[0] === "pr" && args[1] === "merge") return options.autoMergeRefused ? { status: 1, stderr: "Auto merge is not allowed for this repository" } : ok("")
    if (args[0] === "pr" && args[1] === "view") return ok(view(byRef(args[2])))
    if (args[0] === "pr" && args[1] === "close") {
      const pr = byRef(args[2])
      pr.state = "CLOSED"
      pr.closedWith = args[args.indexOf("--comment") + 1]
      if (args.includes("--delete-branch")) git(origin, ["update-ref", "-d", `refs/heads/${pr.branch}`])
      return ok("")
    }
    if (args[0] === "api" && args.some((arg) => arg.includes("/rules/branches/"))) return ok([[]])
    if (args[0] === "api" && args.some((arg) => /\/branches\/[^/]+$/u.test(arg))) return ok({ protected: false })
    if (args[0] === "api" && args.some((arg) => arg.includes("/status?"))) return ok([{ statuses: [] }])
    if (args[0] === "api" && args.some((arg) => arg.includes("/check-runs"))) return ok([{ check_runs: [{ id: 7, name: "workspace-policy", status: options.pending ? "in_progress" : "completed", conclusion: options.pending ? null : options.failed ? "failure" : "success" }] }])
    if (args[0] === "api" && args.includes("PUT")) {
      const pr = byRef(args[args.findIndex((arg) => /\/pulls\/\d+\/merge$/u.test(arg))].match(/pulls\/(\d+)/u)[1])
      git(origin, ["update-ref", "refs/heads/main", pr.head, main()])
      pr.state = "MERGED"
      return ok({ merged: true, sha: pr.head })
    }
    assert.fail(`unexpected gh call: ${args.join(" ")}`)
  }
  // A pull request is conflicting when main no longer holds the commit it was built on.
  const view = (pr) => ({
    number: pr.number, url: pr.url, state: pr.state, isDraft: false, headRefOid: pr.head, baseRefName: "main", baseRefOid: main(),
    mergeCommit: pr.state === "MERGED" ? { oid: pr.head } : null,
    mergeable: git(origin, ["rev-parse", `${pr.head}^`]) === main() ? "MERGEABLE" : options.conflicting ? "CONFLICTING" : "MERGEABLE",
  })
  const main = () => git(origin, ["rev-parse", "refs/heads/main"])
  fake.calls = calls
  fake.prs = prs
  return fake
}

const clockOf = () => { let now = 0; return { now: () => (now += 100_000), sleep: () => {} } }

function publish({ desk, env, gh, head, onto, track = true, clock = clockOf() }) {
  return publishPullRequest({ git: runner(gh, desk), spawnGit: gh, root: desk, upstream, head, onto, policy, clock, ...(track ? { track: savesFor({ root: desk, env, now: Date.now }) } : {}) })
}

test("independent publication roots preserve unmatched card candidates and settle landed duplicates with evidence", async () => {
  const { origin, seed, desk, env } = await world("independent-roots")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const card = "work/saved/task.md"
  const text = "---\ntitle: saved\nstatus: processing\n---\n\nA card write that friction does not contain.\n"
  await fs.mkdir(path.dirname(path.join(desk, card)), { recursive: true })
  await fs.writeFile(path.join(desk, card), text)
  git(desk, ["add", card])
  git(desk, ["commit", "-q", "-m", "save card"])
  const head = git(desk, ["rev-parse", "HEAD"])
  const options = { pending: true }
  const gh = fakeGh(origin, options)
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  const first = gh.prs.get(1)

  await fs.mkdir(path.join(seed, "_meta"))
  await fs.writeFile(path.join(seed, "_meta", "friction.md"), "Unrelated friction.\n")
  git(seed, ["add", "_meta/friction.md"])
  git(seed, ["commit", "-q", "-m", "save friction"])
  const secondHead = git(seed, ["rev-parse", "HEAD"])
  options.pending = false
  publish({ desk: seed, env, gh, head: secondHead, onto })
  assert.equal(first.state, "OPEN", "root B must not close root A's unmatched candidate")
  assert.equal(git(origin, ["rev-parse", `refs/heads/${first.branch}`]), head)
  assert.equal(gh.prs.get(2).state, "MERGED")
  assert.notEqual(spawnSync("git", ["--git-dir", origin, "cat-file", "-e", `refs/heads/main:${card}`]).status, 0)
  assert.equal(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE })[0].url, first.url)

  await fs.mkdir(path.dirname(path.join(seed, card)), { recursive: true })
  await fs.writeFile(path.join(seed, card), text)
  git(seed, ["add", card])
  git(seed, ["commit", "-q", "-m", "land identical card"])
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  const settled = settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() })
  assert.deepEqual(settled.closed, [first.url])
  assert.match(first.closedWith, /Superseded: .*already on main.*work\/saved\/task\.md is identical on main/u)
  assert.deepEqual(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }), [])
  assert.notEqual(spawnSync("git", ["--git-dir", origin, "show-ref", "--verify", `refs/heads/${first.branch}`]).status, 0)
})

// #1749: a save whose exact content reached main as another commit is not "unmerged", and is settled without waiting for a later write.
test("a recorded save whose content reached main through another commit is not reported unmerged, and a sync schedules its settlement", async () => {
  const { origin, seed, desk, env } = await world("landed-elsewhere")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const card = "work/saved/task.md"
  const text = "---\ntitle: saved\n---\n\nLanded twice.\n"
  await fs.mkdir(path.dirname(path.join(desk, card)), { recursive: true })
  await fs.writeFile(path.join(desk, card), text)
  git(desk, ["add", card])
  git(desk, ["commit", "-q", "-m", "save card"])
  const head = git(desk, ["rev-parse", "HEAD"])
  const gh = fakeGh(origin, { pending: true })
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  const later = () => Date.now() + 60 * MINUTE
  const scheduled = []
  // Each sync is a minute later, so none reads the previous one's fetch as fresh.
  let tick = Date.now()
  const sync = () => { tick += MINUTE; return syncWorkspace({ scheduleDelivery: (options) => scheduled.push(options), root: desk, env, now: () => tick }) }

  await fs.mkdir(path.dirname(path.join(seed, card)), { recursive: true })
  await fs.writeFile(path.join(seed, card), "---\ntitle: saved\n---\n\nDifferent words.\n")
  git(seed, ["add", card])
  git(seed, ["commit", "-q", "-m", "differing card"])
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  await sync()
  assert.equal(stuckSaves({ root: desk, env, now: later }).length, 1, "differing content on main keeps the save listed")
  assert.equal(scheduled.length, 1, "this save's commit is still undelivered, so the worker runs as before")

  await fs.writeFile(path.join(seed, card), text)
  git(seed, ["add", card])
  git(seed, ["commit", "-q", "-m", "land identical card"])
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  const unreadable = (command, args, options) => (command === "git" && args.includes("rev-parse") ? { status: 1, stdout: "", stderr: "" } : spawnSync(command, args, options))
  assert.equal(stuckSaves({ root: desk, env, now: later }).length, 1, "main not fetched yet: still listed")
  await sync()
  assert.equal(stuckSaves({ root: desk, env, now: later, spawnGit: unreadable }).length, 1, "an unreadable comparison stays listed")
  assert.equal(stuckSaves({ root: desk, env, now: later, spawnGit: () => { throw new Error("git is gone") } }).length, 1, "a failing comparison stays listed")
  assert.deepEqual(stuckSaves({ root: desk, env, now: later }), [], "proven equal to fetched main: not reported")
  assert.equal(gh.prs.get(1).state, "OPEN", "boot reads only; the worker closes the pull request")
  assert.equal(scheduled.length, 2)
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() }).closed, [gh.prs.get(1).url])
})

test("a sync with nothing to deliver schedules settlement only for a save fetched main already holds, and never when unreachable", async () => {
  const { origin, seed, desk, env } = await world("sync-settles")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const head = await appendTo(desk, "- landed elsewhere", "save")
  const gh = fakeGh(origin, { pending: true })
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  updateSyncStatus(desk, env, { delivered: [head] })
  const scheduled = []
  let tick = Date.now()
  const sync = (options = {}) => { tick += MINUTE; return syncWorkspace({ scheduleDelivery: (call) => scheduled.push(call), root: desk, env, now: () => tick, ...options }) }
  await sync()
  assert.equal(scheduled.length, 0, "a waiting save is not on main, so nothing to settle and no worker per sync")

  // Main gains every line the save adds, in another order and file shape: settlement may close it, boot must not hide it.
  await appendTo(seed, "- other", "another")
  await appendTo(seed, "- landed elsewhere", "same line, different file")
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  await sync()
  assert.equal(scheduled.length, 0, "only exact content counts as proof before settlement")
  assert.equal(stuckSaves({ root: desk, env, now: () => tick + 60 * MINUTE }).length, 1)

  const identical = await world("sync-settles-identical")
  const same = await appendTo(identical.desk, "- landed elsewhere", "save")
  const gh2 = fakeGh(identical.origin, { pending: true })
  assert.throws(() => publish({ desk: identical.desk, env: identical.env, gh: gh2, head: same, onto: git(identical.desk, ["rev-parse", "HEAD~1"]) }), /checks still missing or pending/u)
  updateSyncStatus(identical.desk, identical.env, { delivered: [same] })
  await appendTo(identical.seed, "- landed elsewhere", "same content, another commit")
  git(identical.seed, ["push", "-q", "origin", "HEAD:main"])
  const again = (options) => { tick += MINUTE; return syncWorkspace({ scheduleDelivery: (call) => scheduled.push(call), root: identical.desk, env: identical.env, now: () => tick, ...options }) }
  await again()
  assert.equal(scheduled.length, 1, "diverged checkout with nothing undelivered")
  git(identical.desk, ["reset", "-q", "--hard", "origin/main"])
  await again()
  assert.equal(scheduled.length, 2, "checkout exactly at main")
  git(identical.desk, ["remote", "set-url", "origin", "/nonexistent/remote.git"])
  await again()
  assert.equal(scheduled.length, 2, "an unreachable remote cannot settle anything")
})

// #1749 review: only exact path identity hides a save; mode changes and failed reads do not, a deletion main also made does.
test("boot hides a landed save only on exact path identity: modes and failed reads keep it listed, a shared deletion hides it", async () => {
  const later = () => Date.now() + 60 * MINUTE
  let tick = Date.now()
  const fetchMain = (desk, env) => { tick += MINUTE; return syncWorkspace({ scheduleDelivery: () => {}, root: desk, env, now: () => tick }) }
  const failing = (needle) => (command, args, options) => (command === "git" && args.includes(needle) ? { status: 1, stdout: "", stderr: "" } : spawnSync(command, args, options))

  const modes = await world("mode-only")
  const onto = git(modes.desk, ["rev-parse", "HEAD"])
  git(modes.desk, ["update-index", "--chmod=+x", "log.md"])
  git(modes.desk, ["commit", "-q", "-m", "make executable"])
  const head = git(modes.desk, ["rev-parse", "HEAD"])
  assert.throws(() => publish({ desk: modes.desk, env: modes.env, gh: fakeGh(modes.origin, { pending: true }), head, onto }), /checks still missing or pending/u)
  await fs.writeFile(path.join(modes.seed, "other.md"), "unrelated\n")
  git(modes.seed, ["add", "other.md"])
  git(modes.seed, ["commit", "-q", "-m", "main moves on"])
  git(modes.seed, ["push", "-q", "origin", "HEAD:main"])
  await fetchMain(modes.desk, modes.env)
  assert.equal(git(modes.desk, ["rev-parse", "origin/main"]), git(modes.origin, ["rev-parse", "refs/heads/main"]), "main was fetched")
  assert.equal(git(modes.desk, ["rev-parse", "origin/main:log.md"]), git(modes.desk, ["rev-parse", `${head}:log.md`]), "main holds the same blob under another mode")
  assert.equal(stuckSaves({ root: modes.desk, env: modes.env, now: later }).length, 1, "same blob text on main but a mode-only change is not on main")

  const gone = await world("shared-deletion")
  await fs.writeFile(path.join(gone.desk, "gone.md"), "bye\n")
  git(gone.desk, ["add", "gone.md"])
  git(gone.desk, ["commit", "-q", "-m", "add gone"])
  git(gone.desk, ["push", "-q", "origin", "HEAD:main"])
  const base = git(gone.desk, ["rev-parse", "HEAD"])
  git(gone.desk, ["rm", "-q", "gone.md"])
  git(gone.desk, ["commit", "-q", "-m", "delete gone"])
  const deletion = git(gone.desk, ["rev-parse", "HEAD"])
  const gh = fakeGh(gone.origin, { pending: true })
  assert.throws(() => publish({ desk: gone.desk, env: gone.env, gh, head: deletion, onto: base }), /checks still missing or pending/u)
  git(gone.seed, ["pull", "-q", "origin", "main"])
  git(gone.seed, ["rm", "-q", "gone.md"])
  git(gone.seed, ["commit", "-q", "-m", "delete gone elsewhere"])
  git(gone.seed, ["push", "-q", "origin", "HEAD:main"])
  await fetchMain(gone.desk, gone.env)
  assert.deepEqual(stuckSaves({ root: gone.desk, env: gone.env, now: later }), [], "main also deleted it")
  // Pathspec metacharacters are literal: main keeps `a[1].md` and lost only `a1.md`, so the save's deletion of `a[1].md` is not on main.
  const glob = await world("literal-path")
  for (const name of ["a[1].md", "a1.md"]) await fs.writeFile(path.join(glob.desk, name), `${name}\n`)
  git(glob.desk, ["add", "."])
  git(glob.desk, ["commit", "-q", "-m", "add both"])
  git(glob.desk, ["push", "-q", "origin", "HEAD:main"])
  const globBase = git(glob.desk, ["rev-parse", "HEAD"])
  git(glob.desk, ["rm", "-q", "a[1].md"])
  git(glob.desk, ["commit", "-q", "-m", "delete bracket file"])
  assert.throws(() => publish({ desk: glob.desk, env: glob.env, gh: fakeGh(glob.origin, { pending: true }), head: git(glob.desk, ["rev-parse", "HEAD"]), onto: globBase }), /checks still missing or pending/u)
  git(glob.seed, ["pull", "-q", "origin", "main"])
  git(glob.seed, ["rm", "-q", "a1.md"])
  git(glob.seed, ["commit", "-q", "-m", "delete the sibling only"])
  git(glob.seed, ["push", "-q", "origin", "HEAD:main"])
  await fetchMain(glob.desk, glob.env)
  assert.equal(stuckSaves({ root: glob.desk, env: glob.env, now: later }).length, 1, "a literal path main still holds is not absent")
  for (const needle of ["ls-tree", "--raw"]) {
    assert.equal(stuckSaves({ root: gone.desk, env: gone.env, now: later, spawnGit: failing(needle) }).length, 1, `a failed ${needle} read proves nothing, so the save stays listed`)
  }
})

// #1749 review: the worker a landed save schedules settles every recorded save, so each must meet the same exact-proof guards.
test("the scheduled worker closes only the save main holds exactly; a mode-only save or one whose reads fail stays open", async () => {
  const { origin, seed, desk, env } = await world("worker-coexisting")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const options = { pending: true }
  const gh = fakeGh(origin, options)
  const savedFile = async (name, text) => { await fs.writeFile(path.join(desk, name), text); git(desk, ["add", name]); git(desk, ["commit", "-q", "-m", `save ${name}`]); return git(desk, ["rev-parse", "HEAD"]) }
  const landed = await savedFile("landed.md", "landed\n")
  assert.throws(() => publish({ desk, env, gh, head: landed, onto }), /checks still missing or pending/u)
  await fs.writeFile(path.join(seed, "mode.md"), "same text\n")
  git(seed, ["add", "mode.md"])
  git(seed, ["commit", "-q", "-m", "main has mode.md"])
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  git(desk, ["fetch", "-q", "origin"])
  git(desk, ["reset", "-q", "--hard", "origin/main"])
  const mainWithMode = git(desk, ["rev-parse", "HEAD"])
  git(desk, ["update-index", "--chmod=+x", "mode.md"])
  git(desk, ["commit", "-q", "-m", "make mode.md executable"])
  const modeOnly = git(desk, ["rev-parse", "HEAD"])
  assert.throws(() => publish({ desk, env, gh, head: modeOnly, onto: mainWithMode }), /checks still missing or pending/u)
  await fs.writeFile(path.join(seed, "landed.md"), "landed\n")
  git(seed, ["add", "landed.md"])
  git(seed, ["commit", "-q", "-m", "landed.md arrives through another commit"])
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  const [landedPr, modePr] = [...gh.prs.values()]
  assert.notEqual(landedPr.url, modePr.url)

  const failing = (needle) => (command, args, options) => (command === "git" && args.includes(needle) ? { status: 1, stdout: "", stderr: "" } : gh(command, args, options))
  const clock = clockOf()
  for (const needle of ["diff-tree", "ls-tree"]) {
    assert.deepEqual(settleSaves({ root: desk, env, spawnGit: failing(needle), clock }).closed, [], `a failed ${needle} read closes nothing`)
  }

  const scheduled = []
  let tick = Date.now()
  await syncWorkspace({ scheduleDelivery: (options) => scheduled.push(options), root: desk, env, now: () => (tick += MINUTE) })
  assert.equal(scheduled.length, 1, "the landed save schedules the worker")
  // The mode-only save is left to qualification, which ends the worker once its checks fail.
  const result = await runPushWorker({ ...scheduled[0], spawnGit: gh, retryDelaysMs: [1], publicationClock: clockOf(), clock: { now: Date.now, sleep: async () => { options.pending = false; options.failed = true } }, fileProblem: () => assert.fail("not a Desk defect") })
  assert.equal(result.result, "blocked")
  assert.equal(gh.prs.get(1).state, "CLOSED", "the exactly-landed save is closed")
  assert.equal(gh.prs.get(2).state, "OPEN", "the mode-only save is not on main")
  const recorded = readSyncStatus({ root: desk, env }).unmerged_saves.map((save) => save.url)
  assert.ok(!recorded.includes(landedPr.url) && recorded.includes(modePr.url), "the closed save is forgotten and the mode-only save stays recorded")
})

test("publication qualifies its checks and merges without asking gh for auto-merge", async () => {
  const { origin, desk, env } = await world("refused")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const head = await appendTo(desk, "- second", "save")
  const gh = fakeGh(origin, { autoMergeRefused: true })
  const done = publish({ desk, env, gh, head, onto })
  assert.equal(git(origin, ["rev-parse", "refs/heads/main"]), head)
  assert.deepEqual(gh.prs.get(1).labels, ["merge-when-green"])
  assert.equal(done.receipt.labelled, true)
  assert.ok(!gh.calls.some((args) => args[0] === "pr" && args[1] === "merge"), "only the qualified exact-head merge is requested")
  assert.deepEqual(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }), [], "a merged save is no longer waiting")
})

test("settlement requalifies a recorded nonconflicting save after its checks finish", async () => {
  const { origin, desk, env } = await world("eventual")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const head = await appendTo(desk, "- delayed check", "save")
  const options = { pending: true }
  const gh = fakeGh(origin, options)
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  assert.deepEqual(gh.prs.get(1).labels, [])
  const waiting = settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() })
  assert.deepEqual(waiting.waiting, [gh.prs.get(1).url])
  assert.equal(git(origin, ["rev-parse", "refs/heads/main"]), onto)
  options.pending = false
  const settled = settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() })
  assert.deepEqual(settled.waiting, [])
  assert.equal(git(origin, ["rev-parse", "refs/heads/main"]), head)
  assert.equal(gh.prs.get(1).state, "MERGED")
  assert.deepEqual(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }), [])
})

test("the background worker keeps qualifying pending checks beyond its network retry budget", async () => {
  for (const retryDelaysMs of [[1], []]) {
    const { origin, desk, env } = await world("worker-eventual")
    const head = await appendTo(desk, "- delayed check", "save")
    const options = { pending: true }
    const gh = fakeGh(origin, options)
    let retries = 0
    const result = await runPushWorker({
      root: desk, env, spawnGit: gh, debounceMs: 0, retryDelaysMs,
      publicationClock: clockOf(),
      clock: { now: Date.now, sleep: async (ms) => { if (ms === (retryDelaysMs[0] ?? 60_000) && ++retries === 3) options.pending = false } },
      fileProblem: () => assert.fail("pending checks are not a Desk defect"),
    })

    assert.equal(result.result, "ok")
    assert.equal(retries, 3)
    assert.equal(git(origin, ["rev-parse", "refs/heads/main"]), head)
    assert.equal(gh.prs.get(1).state, "MERGED")
  }
})

test("a pending-check worker stops with a visible failure when checks fail or authentication is refused", async () => {
  for (const failure of ["failed", "authFailed"]) {
    const { origin, desk, env } = await world("worker-failed")
    await appendTo(desk, "- cannot qualify", "save")
    const options = { pending: true }
    const gh = fakeGh(origin, options)
    let retries = 0
    const result = await runPushWorker({
      root: desk, env, spawnGit: gh, debounceMs: 0, retryDelaysMs: [1],
      publicationClock: clockOf(),
      clock: { now: Date.now, sleep: async (ms) => {
        if (ms === 1) { retries++; options.pending = false; options[failure] = true }
      } },
      fileProblem: () => assert.fail("failed qualification is not a Desk defect"),
    })
    assert.equal(result.result, "blocked")
    assert.equal(retries, 1, "a permanent refusal must not inherit pending-check retries")
    const status = readSyncStatus({ root: desk, env })
    assert.match(status.error, failure === "failed" ? /failed \(FAILURE\)/u : /gh auth status/u)
    assert.notEqual(status.publication?.pending_checks, true)
    assert.equal(gh.prs.get(1).state, "OPEN")
    assert.deepEqual(gh.prs.get(1).labels, [])
  }
})

test("a conflicting append is rebuilt on the newest main and merged, and the old pull request is closed", async () => {
  const { origin, seed, desk, env } = await world("conflict")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const head = await appendTo(desk, "- mine", "save")
  const gh = fakeGh(origin, { pending: true, conflicting: true })
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  assert.equal(git(origin, ["rev-parse", "refs/heads/main"]), onto, "the save is not on main yet")
  await appendTo(seed, "- theirs", "another save")
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  const green = fakeGh(origin, { conflicting: true })
  green.prs.set(1, gh.prs.get(1))
  const outcome = settleSaves({ root: desk, env, spawnGit: green, clock: clockOf() })
  assert.deepEqual(outcome.rebased, ["https://github.example/team/workspace/pull/1"])
  const log = git(origin, ["show", "refs/heads/main:log.md"])
  assert.match(log, /- mine/u)
  assert.match(log, /- theirs/u)
  assert.equal(green.prs.get(1).state, "CLOSED")
  assert.match(green.prs.get(1).closedWith, /Rebased onto .* as https:\/\/github\.example\/team\/workspace\/pull\/2/u)
  assert.deepEqual(green.prs.get(2).labels, ["merge-when-green"])
  assert.deepEqual(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }), [])
})

test("a save already on main is closed as superseded with the evidence", async () => {
  const { origin, seed, desk, env } = await world("superseded")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const head = await appendTo(desk, "- same line", "save")
  const gh = fakeGh(origin, { pending: true, conflicting: true })
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  await appendTo(seed, "- same line", "another save said it first")
  await appendTo(seed, "- later", "and a later one")
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  const outcome = settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() })
  assert.deepEqual(outcome.closed, ["https://github.example/team/workspace/pull/1"])
  assert.equal(gh.prs.get(1).state, "CLOSED")
  assert.match(gh.prs.get(1).closedWith, /Superseded: this save is already on main/u)
  assert.match(gh.prs.get(1).closedWith, /every line the save adds to log\.md is already on main/u)
  assert.equal(gh.prs.size, 1, "no new pull request is opened for it")
  assert.deepEqual(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }), [])
})

test("a save unmerged past ten minutes is named in tool replies, boot and drains status", async () => {
  const { origin, desk, env } = await world("stuck")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const head = await appendTo(desk, "- waiting", "save")
  const gh = fakeGh(origin, { pending: true })
  const started = Date.now()
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  const url = "https://github.example/team/workspace/pull/1"
  const at = (minutes) => () => started + minutes * MINUTE
  assert.deepEqual(stuckSaves({ root: desk, env, now: at(9) }), [], "nothing is loud before ten minutes")
  const [stuck] = stuckSaves({ root: desk, env, now: at(11) })
  assert.equal(stuck.url, url)
  assert.ok(stuck.minutes >= 10)

  const reply = withStuckSaves({ status: "committed", desk_note: "pushing in the background" }, { root: desk, env, now: at(11) })
  assert.equal(reply.desk_unmerged_saves[0].pr, url)
  assert.match(reply.desk_unmerged_note, /not on main after \d+ min: https:\/\/github\.example\/team\/workspace\/pull\/1/u)
  assert.deepEqual(withStuckSaves({ status: "committed" }, { root: desk, env, now: at(9) }), { status: "committed" })

  const boot = formatBootText({ status: "ready", unmerged_saves: [{ url, minutes: 11 }] })
  assert.match(boot, /## Unmerged saves\n\n- https:\/\/github\.example\/team\/workspace\/pull\/1: not on main after 11 min/u)

  assert.equal(allStuckSaves({ env, now: at(11) })[0].url, url)
  const out = []
  const code = await runDrainsCli({ argv: ["status"], script: path.resolve("plugins/desk/mcp/scripts/drains.js"), env, now: at(11), io: { stdout: { write: (text) => out.push(text) }, stderr: { write: () => {} } } })
  assert.equal(code, 0)
  assert.ok(JSON.parse(out.join("")).status.some((line) => line.startsWith("unmerged save: ") && line.includes(url)))
})

// Saves that cannot be settled stay recorded and named; each way out is exercised here.
test("settling leaves a save it cannot settle recorded, and forgets one that is gone", async () => {
  const { origin, seed, desk, env } = await world("waiting")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const gh = fakeGh(origin, { pending: true })
  const head = await appendTo(desk, "- unique", "save")
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  const url = "https://github.example/team/workspace/pull/1"
  const settle = (spawn, extra = {}) => settleSaves({ root: desk, env, spawnGit: spawn, clock: clockOf(), ...extra })
  const failing = (match) => (command, args, options) => (match(command, args) ? { status: 1 } : gh(command, args, options))

  // No fetch, no unreadable PR, nothing superseded and nothing conflicting: waiting each time.
  assert.deepEqual(settle(failing((command, args) => command === "git" && args.includes("fetch"))).waiting, [url])
  assert.deepEqual(settle(failing((command, args) => command === "gh" && args[1] === "view")).waiting, [url])
  assert.deepEqual(settle(gh).waiting, [url])
  const garbled = (command, args, options) => (command === "gh" && args[1] === "view" ? { status: 0, stdout: "not json" } : gh(command, args, options))
  assert.deepEqual(settle(garbled).waiting, [url])

  // The save's head is fetched from its branch when this clone lacks it.
  git(desk, ["reset", "-q", "--hard", onto])
  for (const ref of git(desk, ["for-each-ref", "--format=%(refname)", "refs/heads/desk", "refs/remotes/origin/desk"]).split("\n").filter(Boolean)) git(desk, ["update-ref", "-d", ref])
  git(desk, ["reflog", "expire", "--expire=now", "--all"])
  git(desk, ["gc", "-q", "--prune=now"])
  assert.deepEqual(settle(gh).waiting, [url])

  // A PR that closed on its own is forgotten.
  gh.prs.get(1).state = "CLOSED"
  assert.deepEqual(settle(gh), { closed: [], rebased: [], waiting: [] })
  assert.deepEqual(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }), [])
  assert.deepEqual(settle(gh), { closed: [], rebased: [], waiting: [] })
})

test("a save that main already contains is forgotten, and a failed close keeps it recorded", async () => {
  const { origin, seed, desk, env } = await world("merged")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const gh = fakeGh(origin, { pending: true })
  const head = await appendTo(desk, "- landed", "save")
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  const url = "https://github.example/team/workspace/pull/1"
  await appendTo(seed, "- landed", "another save said it first")
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  const refusing = (command, args, options) => (command === "gh" && args[1] === "close" ? { status: 1, stdout: "", stderr: "" } : gh(command, args, options))
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: refusing, clock: clockOf() }).waiting, [url])
  git(origin, ["update-ref", "refs/heads/main", head])
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() }), { closed: [], rebased: [], waiting: [] })
  assert.deepEqual(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }), [])
})

test("a deleted file and re-set frontmatter count as superseded only when main agrees", async () => {
  const { origin, seed, desk, env } = await world("kinds")
  // Main's later commits carry a later date than the save's.
  const later = new Date(Date.now() + 3600_000).toISOString()
  const write = async (root, file, text) => {
    await fs.writeFile(path.join(root, file), text)
    git(root, ["add", file])
    process.env.GIT_COMMITTER_DATE = later
    try { git(root, ["commit", "-q", "-m", `write ${file}`]) } finally { delete process.env.GIT_COMMITTER_DATE }
  }
  await write(seed, "gone.md", "x\n")
  await write(seed, "card.md", "---\nstatus: open\n---\nbody\n")
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  git(desk, ["pull", "-q", "--ff-only"])
  const onto = git(desk, ["rev-parse", "HEAD"])
  const gh = fakeGh(origin, { pending: true })
  git(desk, ["rm", "-q", "gone.md"])
  await fs.writeFile(path.join(desk, "card.md"), "---\nstatus: done\n---\nbody\n")
  git(desk, ["add", "card.md"])
  git(desk, ["commit", "-q", "-m", "save"])
  const head = git(desk, ["rev-parse", "HEAD"])
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  const url = "https://github.example/team/workspace/pull/1"

  // Main still has gone.md: not superseded.
  await write(seed, "card.md", "---\nstatus: cancelled\n---\nbody\n")
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() }).waiting, [url])
  // Main deleted it too, and set the field again after the save: superseded.
  git(seed, ["rm", "-q", "gone.md"])
  git(seed, ["commit", "-q", "-m", "gone"])
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  const outcome = settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() })
  assert.deepEqual(outcome.closed, [url])
  assert.match(gh.prs.get(1).closedWith, /gone\.md is absent on main/u)
})

test("a conflicting save that cannot be rebuilt waits, and one whose new PR is still open is still replaced", async () => {
  const { origin, seed, desk, env } = await world("rebuild")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const gh = fakeGh(origin, { pending: true, conflicting: true })
  const head = await appendTo(desk, "- mine", "save")
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  const url = "https://github.example/team/workspace/pull/1"
  await appendTo(seed, "- theirs", "another save")
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  // Rebuilding the new PR fails before GitHub makes it: the old one stays.
  const noCreate = (command, args, options) => (command === "gh" && args[1] === "create" ? { status: 1, stdout: "", stderr: "" } : gh(command, args, options))
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: noCreate, clock: clockOf() }).waiting, [url])
  // A close that GitHub refuses leaves the old one waiting, though its replacement is made and recorded.
  const refusing = (command, args, options) => (command === "gh" && args[1] === "close" ? { status: 1, stdout: "", stderr: "" } : gh(command, args, options))
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: refusing, clock: clockOf() }).waiting, [url])
  assert.equal(gh.prs.get(2).state, "OPEN")
  // The close goes through on the next settle; the replacement's checks are still pending, so it stays recorded.
  const outcome = settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() })
  assert.deepEqual(outcome.rebased, [url])
  assert.equal(gh.prs.get(1).state, "CLOSED")
  assert.ok(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }).length > 0)
})

test("a policy-less or unreadable-policy repository leaves any save waiting without merge triggers", async () => {
  for (const conflicting of [true, false]) {
    const { origin, seed, desk, env } = await world("nopolicy")
    const onto = git(desk, ["rev-parse", "HEAD"])
    const gh = fakeGh(origin, { pending: true, conflicting })
    const head = await appendTo(desk, "- mine", "save")
    assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
    git(seed, ["pull", "-q", "origin", "main"])
    git(seed, ["rm", "-q", "-r", ".desk"])
    await appendTo(seed, "- theirs", "another save and no policy")
    git(seed, ["push", "-q", "origin", "HEAD:main"])
    assert.equal(settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() }).waiting.length, 1)
    await fs.writeFile(path.join(seed, ".desk-x"), "")
    await fs.mkdir(path.join(seed, ".desk"))
    await fs.writeFile(path.join(seed, ".desk", "publication.json"), "{")
    git(seed, ["add", "."])
    git(seed, ["commit", "-q", "-m", "broken policy"])
    git(seed, ["push", "-q", "origin", "HEAD:main"])
    assert.equal(settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() }).waiting.length, 1)
    assert.deepEqual(gh.prs.get(1).labels, [])
  }
})

test("a PR a rebuild replaced is closed as superseded or as rebuilt", () => {
  assert.match(abandonedComment({ target: "a".repeat(40), branch: "main" }), /Superseded: .* landed it directly or left nothing to add/u)
  assert.match(abandonedComment({ target: "a".repeat(40), branch: "main", publication: { url: "https://github.example/x/y/pull/9" } }), /Rebuilt on the newest main as https:\/\/github\.example\/x\/y\/pull\/9/u)
})

test("a settle that throws, an unreadable state, a corrupt status file and a non-object reply never break the caller", async () => {
  const { origin, desk, env } = await world("hostile")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const gh = fakeGh(origin, { pending: true })
  const head = await appendTo(desk, "- unique", "save")
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  const exploding = () => { throw new Error("spawn failed") }
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: exploding }), { closed: [], rebased: [], waiting: [] })

  // With two waiting saves, the one waiting longest is named first.
  savesFor({ root: desk, env, now: () => Date.now() - 30 * MINUTE }).record({ url: "https://github.example/team/workspace/pull/0", head, branch: "b", base: "main" })
  const later = () => Date.now() + 60 * MINUTE
  assert.deepEqual(stuckSaves({ root: desk, env, now: later }).map((save) => save.url.split("/").pop()), ["0", "1"])
  assert.deepEqual(allStuckSaves({ env, now: later }).map((save) => save.url.split("/").pop()), ["0", "1"])

  const dir = path.join(resolveDeskStateDir({ env }), "sync")
  await fs.writeFile(path.join(dir, "corrupt.status.json"), "{")
  assert.equal(allStuckSaves({ env, now: later }).length, 2, "the readable desk is still reported")
  assert.deepEqual(allStuckSaves({ env: { ...env, XDG_STATE_HOME: path.join(env.XDG_STATE_HOME, "missing") }, now: Date.now }), [])

  const blocked = path.join(env.XDG_STATE_HOME, "blocked")
  await fs.writeFile(blocked, "a file where the state directory should be")
  const hostile = { ...env, XDG_STATE_HOME: blocked }
  const receipt = { url: "https://github.example/team/workspace/pull/1", head, branch: "b", base: "main" }
  const track = savesFor({ root: desk, env: hostile, now: Date.now })
  track.record(receipt)
  track.clear(receipt)
  assert.deepEqual(stuckSaves({ root: desk, env: hostile, now: Date.now }), [])
  for (const reply of [null, "text", ["a"]]) assert.equal(withStuckSaves(reply, { root: desk, env }), reply)
  const noDesk = { status: "error" }
  assert.equal(withStuckSaves(noDesk, { root: undefined, env }), noDesk, "a call with no desk root has no saves to name")
})

test("a conflict Desk cannot resolve leaves the save waiting", async () => {
  const { origin, seed, desk, env } = await world("truecon")
  const gh = fakeGh(origin, { pending: true, conflicting: true })
  await fs.writeFile(path.join(seed, "app.json"), "{}\n")
  git(seed, ["add", "."])
  git(seed, ["commit", "-q", "-m", "app"])
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  git(desk, ["pull", "-q", "--ff-only"])
  await fs.writeFile(path.join(desk, "app.json"), "{\"a\":1}\n")
  git(desk, ["commit", "-q", "-am", "save"])
  const head = git(desk, ["rev-parse", "HEAD"])
  const onto = git(desk, ["rev-parse", "HEAD^"])
  assert.throws(() => publish({ desk, env, gh, head, onto }), /checks still missing or pending/u)
  await fs.writeFile(path.join(seed, "app.json"), "{\"b\":2}\n")
  git(seed, ["commit", "-q", "-am", "same line, different words"])
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() }).waiting, ["https://github.example/team/workspace/pull/1"])
  assert.equal(gh.prs.size, 1, "no second pull request is opened for a save that cannot be rebuilt")
})

// A pull request this desk never recorded (another machine's save, or a lost record) is found by looking at the repository.
async function unrecordedConflict(label, { mine, theirs }) {
  const { origin, seed, desk, env } = await world(label)
  const gh = fakeGh(origin, { pending: true, conflicting: true })
  const onto = git(desk, ["rev-parse", "HEAD"])
  const head = await mine(desk)
  assert.throws(() => publish({ desk, env, gh, head, onto, track: false }), /checks still missing or pending/u)
  await theirs(seed)
  git(seed, ["push", "-q", "origin", "HEAD:main"])
  assert.deepEqual(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }), [], "nothing on this machine knows the pull request")
  return { origin, desk, env, gh, url: "https://github.example/team/workspace/pull/1" }
}

test("a conflicting log append nobody recorded is found, rebuilt on main and its old pull request closed", async () => {
  const { origin, desk, env, gh, url } = await unrecordedConflict("sweep-append", {
    mine: (desk) => appendTo(desk, "- mine", "save"),
    theirs: (seed) => appendTo(seed, "- theirs", "another save"),
  })
  const green = fakeGh(origin, { conflicting: true })
  green.prs.set(1, gh.prs.get(1))
  const outcome = settleSaves({ root: desk, env, spawnGit: green, clock: clockOf() })
  assert.deepEqual(outcome.rebased, [url])
  assert.equal(green.prs.get(1).state, "CLOSED")
  assert.match(green.prs.get(1).closedWith, /Rebased onto .* as https:\/\/github\.example\/team\/workspace\/pull\/2/u)
  const log = git(origin, ["show", "refs/heads/main:log.md"])
  assert.match(log, /- theirs\n- mine$/u, "both entries are on main")
})

test("a duplicate save nobody recorded is closed as superseded with a link to where its content lives", async () => {
  const { origin, desk, env, gh, url } = await unrecordedConflict("sweep-duplicate", {
    mine: (desk) => appendTo(desk, "- same entry", "save"),
    theirs: async (seed) => { await appendTo(seed, "- same entry", "the same entry, saved elsewhere"); await appendTo(seed, "- later", "later") },
  })
  const outcome = settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() })
  assert.deepEqual(outcome.closed, [url])
  assert.equal(gh.prs.get(1).state, "CLOSED")
  const main = git(origin, ["rev-parse", "refs/heads/main"])
  assert.match(gh.prs.get(1).closedWith, new RegExp(`Superseded.*https://github\\.example/team/workspace/blob/${main}/log\\.md`, "u"))
  assert.equal(gh.prs.size, 1, "no replacement is opened")
})

test("a real content conflict nobody recorded stays open and is reported with its file", async () => {
  const { desk, env, gh, url } = await unrecordedConflict("sweep-content", {
    mine: async (desk) => {
      await fs.writeFile(path.join(desk, "app.json"), "{\"a\":1}\n")
      git(desk, ["add", "."])
      git(desk, ["commit", "-q", "-m", "save"])
      return git(desk, ["rev-parse", "HEAD"])
    },
    theirs: async (seed) => {
      await fs.writeFile(path.join(seed, "app.json"), "{\"b\":2}\n")
      git(seed, ["add", "."])
      git(seed, ["commit", "-q", "-m", "other"])
    },
  })
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() }).waiting, [url])
  assert.equal(gh.prs.get(1).state, "OPEN")
  assert.equal(gh.prs.size, 1)
  const [stuck] = stuckSaves({ root: desk, env, now: Date.now })
  assert.equal(stuck.url, url)
  assert.match(stuckLine(stuck), /conflicts with main in app\.json/u)
  const reply = withStuckSaves({}, { root: desk, env, now: Date.now })
  assert.deepEqual(reply.desk_unmerged_saves[0].conflicts, ["app.json"])
  assert.match(formatBootText({ unmerged_saves: [stuck] }), /not on main after \d+ min, conflicting with main in app\.json\./u)
})

test("a pull request list GitHub cannot give, a non-GitHub remote and other pull requests leave the sweep harmless", async () => {
  const { origin, desk, env, gh, url } = await unrecordedConflict("sweep-quiet", {
    mine: (desk) => appendTo(desk, "- mine", "save"),
    theirs: (seed) => appendTo(seed, "- theirs", "another save"),
  })
  gh.prs.set(9, { number: 9, branch: "feature/x", url: "https://github.example/team/workspace/pull/9", state: "OPEN", labels: [], head: gh.prs.get(1).head })
  const unlisted = (command, args, options) => (command === "gh" && args[1] === "list" ? { status: 1, stdout: "", stderr: "" } : gh(command, args, options))
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: unlisted, clock: clockOf() }), { closed: [], rebased: [], waiting: [] })
  // Only the desk/publish branch is taken up, not another pull request that conflicts.
  const local = (command, args, options) => (command === "git" && args.includes("get-url") ? { status: 0, stdout: `${origin}\n`, stderr: "" } : gh(command, args, options))
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: local, clock: clockOf() }).rebased, [])
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: gh, clock: clockOf() }).rebased, [url])
  assert.equal(gh.prs.get(9).state, "OPEN")
})

test("a duplicate save is closed as superseded even when the remote is not a GitHub address", async () => {
  const { origin, desk, env, gh, url } = await unrecordedConflict("local-remote", {
    mine: (desk) => appendTo(desk, "- same entry", "save"),
    theirs: (seed) => appendTo(seed, "- same entry", "the same entry, saved elsewhere"),
  })
  savesFor({ root: desk, env, now: Date.now }).record({ url, head: gh.prs.get(1).head, branch: gh.prs.get(1).branch, base: "main" })
  const local = (command, args, options) => (command === "git" && args.includes("get-url") ? { status: 0, stdout: `${origin}\n`, stderr: "" } : gh(command, args, options))
  assert.deepEqual(settleSaves({ root: desk, env, spawnGit: local, clock: clockOf() }).closed, [url])
})

test("the repository a gh command names comes from --repo or a pull request URL", () => {
  assert.deepEqual(repositoryOf(["pr", "view", "--repo", "github.com/gim-home/CIT"]), { host: "github.com", owner: "gim-home", repo: "CIT" })
  assert.deepEqual(repositoryOf(["pr", "close", "https://github.com/gim-home/CIT/pull/7"]), { host: "github.com", owner: "gim-home", repo: "CIT" })
  assert.equal(repositoryOf(["pr", "list"]), null)
  assert.equal(repositoryOf(["pr", "view", "--repo"]), null)
})
