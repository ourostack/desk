// The release ships only what main's full CI passed: it waits for the newest main run of each workflow that covers the release's commit
// and refuses a failed, cancelled, missing or unfinished one.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".github", "scripts")
const { gate, newestRun } = await import(pathToFileURL(path.join(scripts, "main-ci-gate.mjs")).href)

const run = (sha, created, extra = {}) => ({ head_sha: sha.padEnd(40, "0"), head_branch: "main", event: "push", status: "completed", conclusion: "success", created_at: created, html_url: `https://example/${sha}`, ...extra })
const carried = new Set(["a", "b", "c"].map((sha) => sha.padEnd(40, "0")))
const isAncestor = (sha) => carried.has(sha)

function harness(byWorkflow, { timeoutMs = 60_000 } = {}) {
  let clock = 0
  const logs = []
  const calls = {}
  return {
    logs,
    run: () => gate({
      workflows: Object.keys(byWorkflow),
      listRuns: (workflow) => {
        calls[workflow] = (calls[workflow] ?? 0) + 1
        const value = byWorkflow[workflow]
        return typeof value === "function" ? value(calls[workflow]) : value
      },
      isAncestor, log: (line) => logs.push(line), now: () => clock, sleep: async (ms) => { clock += ms }, pollMs: 10_000, timeoutMs,
    }),
  }
}

test("the newest main run the release's commit carries is the one judged", () => {
  const runs = [
    run("b", "2026-11-07T10:00:00Z"),
    run("c", "2026-11-07T11:00:00Z"),
    run("z", "2026-11-07T12:00:00Z"),
    run("c", "2026-11-07T13:00:00Z", { event: "pull_request" }),
    run("c", "2026-11-07T13:00:00Z", { head_branch: "feature" }),
  ]
  assert.equal(newestRun(runs, isAncestor).created_at, "2026-11-07T11:00:00Z", "a later commit main does not carry, a pull request run and a branch run do not count")
  assert.equal(newestRun([run("z", "2026-11-07T12:00:00Z")], isAncestor), null)
  assert.equal(newestRun([run("a", "2026-11-07T09:00:00Z", { event: "workflow_dispatch" })], isAncestor).event, "workflow_dispatch")
})

test("every workflow passing lets the release go", async () => {
  const { run: go, logs } = harness({ "x.yml": [run("c", "2026-11-07T11:00:00Z")], "y.yml": [run("b", "2026-11-07T10:00:00Z")] })
  assert.deepEqual(await go(), [])
  assert.equal(logs.filter((line) => /passed/u.test(line)).length, 2)
})

test("a failed, cancelled or missing run stops the release and names the workflow", async () => {
  const problems = await harness({
    "red.yml": [run("c", "2026-11-07T11:00:00Z", { conclusion: "failure" })],
    "stopped.yml": [run("c", "2026-11-07T11:00:00Z", { conclusion: "cancelled" })],
    "none.yml": [],
  }).run()
  assert.equal(problems.length, 3)
  assert.match(problems[0], /^red\.yml: failure/u)
  assert.match(problems[1], /^stopped\.yml: cancelled/u)
  assert.match(problems[2], /^none\.yml: no run on main/u)
})

test("a run still going is waited for, and one that outlasts the time limit stops the release", async () => {
  const finishing = (call) => [run("c", "2026-11-07T11:00:00Z", call < 3 ? { status: "in_progress", conclusion: null } : {})]
  assert.deepEqual(await harness({ "w.yml": finishing }).run(), [])
  const stuck = await harness({ "w.yml": [run("c", "2026-11-07T11:00:00Z", { status: "queued", conclusion: null })] }, { timeoutMs: 30_000 }).run()
  assert.equal(stuck.length, 1)
  assert.match(stuck[0], /still queued .* after the time limit/u)
})

test("the command line refuses missing arguments", () => {
  const result = spawnSync(process.execPath, [path.join(scripts, "main-ci-gate.mjs"), "--repo", "o/r", "--head", "nope"], { encoding: "utf8" })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage/u)
})
