// The Desk release never waits for a run. It builds at once when its pull request was tested against the main it landed on, holds
// when main moved meanwhile until main's own runs passed on the commit, and holds while a "main is red" issue is open.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import path from "node:path"
import { pathToFileURL } from "node:url"

const scripts = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", ".github", "scripts")
const { gate, mainVerified, movedSince } = await import(pathToFileURL(path.join(scripts, "release-gate.mjs")).href)

const REPO = "o/r"
const SHA = "a".repeat(40)
const run = (conclusion, extra = {}) => ({ event: "push", status: "completed", conclusion, created_at: "2026-11-14T02:00:00Z", ...extra })

// A fake GitHub: `prs` for the commit, the pull request's CI runs, main's commits after the run started, and main's own runs.
function fakeApi({ prs, prRuns = [{ conclusion: "success", created_at: "2026-11-14T01:00:00Z", run_started_at: "2026-11-14T01:00:05Z" }], commits = [], mainRuns = {} }) {
  return (route) => {
    if (route.includes("/pulls")) return prs
    if (route.includes("event=pull_request")) return { workflow_runs: prRuns }
    if (route.includes("/commits?")) return commits
    const workflow = /workflows\/([^/]+)\/runs/u.exec(route)[1]
    return { workflow_runs: mainRuns[workflow] ?? [] }
  }
}
const mergedPr = [{ number: 7, merged_at: "2026-11-14T01:10:00Z", merge_commit_sha: SHA, head: { sha: "b".repeat(40) } }]
const green = { "desk-mcp-tests.yml": [run("success")], "desk-windows-suite.yml": [run("success")] }
const decide = (options) => gate({ repo: REPO, head: SHA, event: "push", redMain: () => [], ...options })

test("a merge whose pull request was tested against the main it landed on is released at once, with no main run yet", () => {
  const result = decide({ api: fakeApi({ prs: mergedPr, commits: [{ sha: SHA, author: { login: "someone" }, commit: { message: "Change (#7)" } }, { sha: "c".repeat(40), author: { login: "github-actions[bot]" }, commit: { message: "Release Desk 3.2.1" } }] }) })
  assert.equal(result.release, true)
})

test("when another change landed on main while the pull request's checks ran, the release holds until main's own runs passed", () => {
  const other = { sha: "d".repeat(40), author: { login: "someone" }, commit: { message: "Other change (#8)" } }
  const held = decide({ api: fakeApi({ prs: mergedPr, commits: [other] }) })
  assert.equal(held.release, false)
  assert.match(held.reason, /main moved while #7/u)
  assert.equal(decide({ api: fakeApi({ prs: mergedPr, commits: [other], mainRuns: green }) }).release, true, "main's own runs passed on the combination")
  assert.equal(decide({ api: fakeApi({ prs: mergedPr, commits: [other], mainRuns: { ...green, "desk-windows-suite.yml": [run("failure")] } }) }).release, false)
})

test("a commit no pull request's passing checks cover is released only after main's runs passed on it", () => {
  assert.equal(decide({ api: fakeApi({ prs: [] }) }).release, false)
  assert.equal(decide({ api: fakeApi({ prs: [], mainRuns: green }) }).release, true)
  assert.equal(decide({ api: fakeApi({ prs: mergedPr, prRuns: [{ conclusion: "failure", created_at: "2026-11-14T01:00:00Z" }] }) }).release, false, "a pull request whose newest run failed is not evidence")
})

test("a workflow_run starts the release only for the tip of main, and only when both main runs passed", () => {
  const api = fakeApi({ prs: [], mainRuns: green })
  const finished = (trigger) => gate({ repo: REPO, head: SHA, event: "workflow_run", trigger, api, redMain: () => [] })
  assert.equal(finished({ sha: SHA, conclusion: "success" }).release, true)
  assert.equal(finished({ sha: "e".repeat(40), conclusion: "success" }).release, false, "a run for a superseded commit releases nothing; a newer run follows it")
  assert.equal(finished({ sha: SHA, conclusion: "failure" }).release, false)
  const half = gate({ repo: REPO, head: SHA, event: "workflow_run", trigger: { sha: SHA, conclusion: "success" }, api: fakeApi({ prs: [], mainRuns: { ...green, "desk-windows-suite.yml": [run(null, { status: "in_progress" })] } }), redMain: () => [] })
  assert.equal(half.release, false)
  assert.match(half.reason, /still running/u)
})

test("an open main is red issue holds every release, whatever the pull request showed", () => {
  const result = decide({ api: fakeApi({ prs: mergedPr }), redMain: () => ["#9 main is red: CI gate"] })
  assert.equal(result.release, false)
  assert.deepEqual(result.red, ["#9 main is red: CI gate"])
})

test("main's newest run counts, a partial dispatch never does, and a missing run is not green", () => {
  const older = run("failure", { created_at: "2026-11-14T01:00:00Z" })
  const newer = run("success", { created_at: "2026-11-14T02:00:00Z" })
  assert.equal(mainVerified(SHA, () => [older, newer]).ok, true)
  assert.equal(mainVerified(SHA, () => [newer, run("success", { event: "workflow_dispatch", display_title: "Partial: only x", created_at: "2026-11-14T03:00:00Z" })]).ok, true)
  assert.equal(mainVerified(SHA, () => [run("failure", { event: "workflow_dispatch", display_title: "Partial: only x", created_at: "2026-11-14T03:00:00Z" }), newer]).ok, true)
  assert.match(mainVerified(SHA, () => []).reason, /has no run on this commit/u)
  assert.equal(movedSince(SHA, []), false)
})
