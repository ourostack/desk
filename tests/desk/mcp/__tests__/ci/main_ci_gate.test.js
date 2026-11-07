// The release ships only what main's full CI passed: it waits for the newest run of each workflow that covers the release's commit
// (nothing changed since that run would have started the workflow) and refuses a failed, cancelled, missing or unfinished one.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".github", "scripts")
const workflowsDir = path.join(scripts, "..", "workflows")
const { gate, coveringRun, pushFilters, triggers, globRegExp } = await import(pathToFileURL(path.join(scripts, "main-ci-gate.mjs")).href)

const sha = (name) => name.padEnd(40, "0")
const run = (name, created, extra = {}) => ({ head_sha: sha(name), head_branch: "main", event: "push", status: "completed", conclusion: "success", created_at: created, html_url: `https://example/${name}`, display_title: "Merge", ...extra })
const docsOnly = { ignore: ["docs/**", "LICENSE"] }
// Files that differ between each commit and the release's head "h". Unknown commits are unavailable (null).
const diffs = { [sha("h")]: [], [sha("d")]: ["docs/a.md"], [sha("c")]: ["plugins/desk/mcp/src/x.js"], [sha("f")]: ["docs/a.md", "plugins/desk/mcp/src/factory/y.js"] }
const changedSince = (commit) => diffs[commit] ?? null

function harness(byWorkflow, { timeoutMs = 60_000, appearMs = 20_000, filters = docsOnly } = {}) {
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
      filtersFor: () => filters, changedSince,
      log: (line) => logs.push(line), now: () => clock, sleep: async (ms) => { clock += ms }, pollMs: 10_000, timeoutMs, appearMs,
    }),
  }
}

test("path filter globs follow GitHub's rules", () => {
  assert.ok(globRegExp("docs/**").test("docs/a/b.md"))
  assert.ok(!globRegExp("docs/**").test("plugins/docs/a.md"))
  assert.ok(globRegExp("scripts/*.cjs").test("scripts/a.cjs"))
  assert.ok(!globRegExp("scripts/*.cjs").test("scripts/x/a.cjs"))
  assert.ok(globRegExp("**/package.json").test("package.json"))
  assert.ok(globRegExp("**/package.json").test("a/b/package.json"))
  assert.ok(!globRegExp("a.b").test("axb"))
})

test("a change starts the workflow by its paths or paths-ignore filter", () => {
  assert.equal(triggers(docsOnly, []), false, "no change starts nothing")
  assert.equal(triggers(docsOnly, ["docs/a.md", "LICENSE"]), false)
  assert.equal(triggers(docsOnly, ["docs/a.md", "README.md"]), true)
  const factory = { paths: ["plugins/desk/mcp/src/factory/**", "!plugins/desk/mcp/src/factory/notes.md"] }
  assert.equal(triggers(factory, ["plugins/desk/mcp/src/x.js"]), false)
  assert.equal(triggers(factory, ["plugins/desk/mcp/src/factory/y.js"]), true)
  assert.equal(triggers(factory, ["plugins/desk/mcp/src/factory/notes.md"]), false)
  assert.equal(triggers({}, ["anything"]), true)
})

test("the gate reads each main workflow's push filter as GitHub does", () => {
  const read = (name) => pushFilters(readFileSync(path.join(workflowsDir, name), "utf8"))
  for (const name of ["desk-mcp-tests.yml", "desk-windows-suite.yml"]) {
    const filters = read(name)
    assert.equal(filters.paths, undefined, name)
    assert.ok(filters.ignore.includes("docs/**"), name)
  }
  assert.ok(read("factory-macos-protection.yml").paths.includes("plugins/desk/mcp/src/factory/**"))
  assert.throws(() => pushFilters("on:\n  pull_request:\n"), /no push trigger/u)
  assert.deepEqual(pushFilters("on:\n  push:\n    branches:\n      - main\njobs:\n"), {})
})

test("the newest run that covers the commit is the one judged", () => {
  const runs = [
    run("d", "2026-11-07T10:00:00Z"),
    run("c", "2026-11-07T12:00:00Z"),
    run("x", "2026-11-07T13:00:00Z"),
    run("h", "2026-11-07T13:00:00Z", { event: "pull_request" }),
    run("h", "2026-11-07T13:00:00Z", { head_branch: "feature" }),
    run("h", "2026-11-07T14:00:00Z", { event: "workflow_dispatch", display_title: "Partial: only crew/" }),
  ]
  assert.equal(coveringRun(runs, docsOnly, changedSince).head_sha, sha("d"),
    "a run whose commit differs in tested code, an unknown commit, a pull request run, a branch push and a partial dispatch do not count")
  assert.equal(coveringRun([run("c", "2026-11-07T12:00:00Z")], docsOnly, changedSince), null)
  const refresh = run("h", "2026-11-07T09:00:00Z", { event: "workflow_dispatch", head_branch: "superpowers-upstream" })
  assert.equal(coveringRun([refresh], docsOnly, changedSince), refresh, "a full dispatch on a branch with the same tree counts")
  assert.equal(coveringRun([run("c", "2026-11-07T12:00:00Z")], { paths: ["plugins/desk/mcp/src/factory/**"] }, changedSince).head_sha, sha("c"),
    "changes outside a positive filter leave an older run covering")
})

test("every workflow passing lets the release go", async () => {
  const { run: go, logs } = harness({ "x.yml": [run("h", "2026-11-07T11:00:00Z")], "y.yml": [run("d", "2026-11-07T10:00:00Z")] })
  assert.deepEqual(await go(), [])
  assert.equal(logs.filter((line) => /passed/u.test(line)).length, 2)
})

test("a failed, cancelled or missing run stops the release and names the workflow", async () => {
  const problems = await harness({
    "red.yml": [run("h", "2026-11-07T11:00:00Z", { conclusion: "failure" })],
    "stopped.yml": [run("h", "2026-11-07T11:00:00Z", { conclusion: "cancelled" })],
    "none.yml": [],
  }).run()
  assert.equal(problems.length, 3)
  assert.match(problems[0], /^red\.yml: failure/u)
  assert.match(problems[1], /^stopped\.yml: cancelled/u)
  assert.match(problems[2], /^none\.yml: no run covers this commit/u)
})

test("a commit that changed tested code waits for its own run instead of passing on an older one", async () => {
  // Only an older green run on a commit that differs in tested code is listed at first; head's run appears on the third poll.
  const lagging = (call) => [run("c", "2026-11-07T10:00:00Z"), ...(call >= 3 ? [run("h", "2026-11-07T11:00:00Z", { conclusion: "failure" })] : [])]
  const problems = await harness({ "w.yml": lagging }).run()
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^w\.yml: failure on h/u)
  const never = await harness({ "w.yml": [run("c", "2026-11-07T10:00:00Z")] }).run()
  assert.match(never[0], /no run covers this commit/u)
})

test("a run still going is waited for, and one that outlasts the time limit stops the release", async () => {
  const finishing = (call) => [run("h", "2026-11-07T11:00:00Z", call < 3 ? { status: "in_progress", conclusion: null } : {})]
  assert.deepEqual(await harness({ "w.yml": finishing }).run(), [])
  const stuck = await harness({ "w.yml": [run("h", "2026-11-07T11:00:00Z", { status: "queued", conclusion: null })] }, { timeoutMs: 30_000 }).run()
  assert.equal(stuck.length, 1)
  assert.match(stuck[0], /still queued .* after the time limit/u)
})

test("a listing error is retried, and only one that lasts past the time limit stops the release", async () => {
  const flaky = (call) => {
    if (call < 3) throw new Error("HTTP 502")
    return [run("h", "2026-11-07T11:00:00Z")]
  }
  const { run: go, logs } = harness({ "w.yml": flaky })
  assert.deepEqual(await go(), [])
  assert.equal(logs.filter((line) => /retrying \(HTTP 502\)/u.test(line)).length, 2)
  const down = await harness({ "w.yml": () => { throw new Error("HTTP 502") } }, { timeoutMs: 30_000 }).run()
  assert.match(down[0], /could not list its runs before the time limit \(HTTP 502\)/u)
})

test("the Windows suite marks a dispatch that ran only some files, so the gate never counts it", () => {
  const text = readFileSync(path.join(workflowsDir, "desk-windows-suite.yml"), "utf8")
  const runName = /^run-name: (.+)$/mu.exec(text)?.[1] ?? ""
  assert.match(runName, /inputs\.only != '' && format\('Partial: /u)
})

test("the release waits on every workflow that moved off pull requests", () => {
  const release = readFileSync(path.join(workflowsDir, "desk-release.yml"), "utf8")
  const listed = /main-ci-gate\.mjs [^\n]*--workflows (\S+)/u.exec(release)[1].split(",")
  assert.deepEqual(listed.sort(), ["desk-mcp-tests.yml", "desk-windows-suite.yml", "factory-macos-protection.yml"])
})

test("the command line refuses missing arguments", () => {
  const result = spawnSync(process.execPath, [path.join(scripts, "main-ci-gate.mjs"), "--repo", "o/r", "--head", "nope"], { encoding: "utf8" })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage/u)
})
