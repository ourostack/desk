// A Desk save always reaches the desk's main by itself, and when it cannot, everyone hears: every publication PR carries the
// merge-when-green label whether or not auto-merge is allowed, a conflicting save is rebuilt on the newest main, a save that is
// already on main is closed as superseded with the evidence, and a save still unmerged after ten minutes is named in tool
// replies, boot and `drains status`. Real Git repositories; `gh` is a fake that merges into the bare origin.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { runner } from "../../../../../plugins/desk/mcp/src/runtime/deliver.js"
import { publishPullRequest } from "../../../../../plugins/desk/mcp/src/runtime/pr-publication.js"
import { allStuckSaves, savesFor, settleSaves, stuckSaves, withStuckSaves } from "../../../../../plugins/desk/mcp/src/runtime/unmerged-saves.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"

const MINUTE = 60_000
const upstream = { remote: "origin", merge: "refs/heads/main", tracking: "refs/remotes/origin/main" }
const policy = { schema_version: 1, mode: "pull-request", required_checks: ["workspace-policy"] }

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
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
    calls.push(args)
    const ok = (value) => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value) })
    const main = () => git(origin, ["rev-parse", "refs/heads/main"])
    const byBranch = (branch) => [...prs.values()].find((pr) => pr.branch === branch)
    const byRef = (ref) => [...prs.values()].find((pr) => pr.url === ref || String(pr.number) === ref)
    if (args[0] === "label") return ok("")
    if (args[0] === "pr" && args[1] === "list") return ok(byBranch(args[args.indexOf("--head") + 1]) ? [view(byBranch(args[args.indexOf("--head") + 1]))] : [])
    if (args[0] === "pr" && args[1] === "create") {
      const branch = args[args.indexOf("--head") + 1]
      const number = prs.size + 1
      prs.set(number, { number, branch, url: `https://github.example/team/workspace/pull/${number}`, state: "OPEN", labels: [], head: git(origin, ["rev-parse", `refs/heads/${branch}`]) })
      return ok(prs.get(number).url)
    }
    if (args[0] === "pr" && args[1] === "edit") { byRef(args[2]).labels.push(args[args.indexOf("--add-label") + 1]); return ok("") }
    if (args[0] === "pr" && args[1] === "merge") return options.autoMergeRefused ? { status: 1, stderr: "Auto merge is not allowed for this repository" } : ok("")
    if (args[0] === "pr" && args[1] === "view") return ok(view(byRef(args[2])))
    if (args[0] === "pr" && args[1] === "close") { const pr = byRef(args[2]); pr.state = "CLOSED"; pr.closedWith = args[args.indexOf("--comment") + 1]; return ok("") }
    if (args[0] === "api" && args.some((arg) => arg.includes("/rules/branches/"))) return ok([[]])
    if (args[0] === "api" && args.some((arg) => /\/branches\/[^/]+$/u.test(arg))) return ok({ protected: false })
    if (args[0] === "api" && args.some((arg) => arg.includes("/status?"))) return ok([{ statuses: [] }])
    if (args[0] === "api" && args.some((arg) => arg.includes("/check-runs"))) return ok([{ check_runs: [{ id: 7, name: "workspace-policy", status: options.pending ? "in_progress" : "completed", conclusion: options.pending ? null : "success" }] }])
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
  return publishPullRequest({ git: runner(gh, desk), spawnGit: gh, root: desk, upstream, head, onto, policy, clock, ...(track ? { track: savesFor({ root: desk, env }) } : {}) })
}

test("a repository that refuses auto-merge still gets the relay's label and merges", async () => {
  const { origin, desk, env } = await world("refused")
  const onto = git(desk, ["rev-parse", "HEAD"])
  const head = await appendTo(desk, "- second", "save")
  const gh = fakeGh(origin, { autoMergeRefused: true })
  const done = publish({ desk, env, gh, head, onto })
  assert.equal(git(origin, ["rev-parse", "refs/heads/main"]), head)
  assert.deepEqual(gh.prs.get(1).labels, ["merge-when-green"])
  assert.equal(done.receipt.labelled, true)
  assert.equal(done.receipt.auto_merge, "refused")
  assert.ok(gh.calls.some((args) => args[0] === "pr" && args[1] === "merge" && args.includes("--auto")), "auto-merge is still asked for")
  assert.deepEqual(stuckSaves({ root: desk, env, now: () => Date.now() + 60 * MINUTE }), [], "a merged save is no longer waiting")
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
  assert.match(gh.prs.get(1).closedWith, /every line the save adds to log\.md is on main/u)
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
