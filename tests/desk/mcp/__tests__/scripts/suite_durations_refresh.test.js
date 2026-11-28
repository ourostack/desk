// The weekly shard-duration refresh picks only full main runs, leaves a quiet table alone, and runs as a locked-down Linux workflow.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { removeTreeSync } from "../_remove_tree.js"

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".github", "scripts")
const { pickRuns, movedFiles } = await import(pathToFileURL(path.join(scripts, "refresh-suite-durations.mjs")).href)
const require = createRequire(import.meta.url)
const { load } = require("js-yaml")

test("only successful, full main runs are measured, newest first", () => {
  const run = (databaseId, extra = {}) => ({ databaseId, displayTitle: "Merge", headBranch: "main", conclusion: "success", ...extra })
  const runs = [run(5, { conclusion: "failure" }), run(4, { displayTitle: "Partial: only ^a$" }), run(3, { headBranch: "other" }), run(2), run(1)]
  assert.deepEqual(pickRuns(runs, 4), [2, 1])
  assert.deepEqual(pickRuns([run(9), run(8), run(7)], 2), [9, 8])
})

test("a weight must move by 2 seconds and 25% to count, and added or dropped files always count", () => {
  const previous = { files: { "a.test.js": 100, "b.test.js": 4, "c.test.js": 100, "gone.test.js": 3 } }
  const next = { files: { "a.test.js": 110, "b.test.js": 5.5, "c.test.js": 140, "new.test.js": 1 } }
  assert.deepEqual(movedFiles(previous, next), ["c.test.js", "gone.test.js", "new.test.js"])
  assert.deepEqual(movedFiles(previous, previous), [])
})

test("a run whose medians match the table changes nothing and reports changed=false", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-durations-refresh-"))
  try {
    const tests = path.join(dir, "tests")
    mkdirSync(tests)
    writeFileSync(path.join(tests, "a.test.js"), "")
    const table = path.join(dir, "table.json")
    const original = JSON.stringify({ note: "n", generated: "2020-01-01", inputs: 1, defaultSeconds: 10, files: { "a.test.js": 10 } }, null, 1) + "\n"
    writeFileSync(table, original)
    // A stand-in gh: lists two main runs and "downloads" a results file that says a.test.js took 10.4 seconds.
    const bin = path.join(dir, "bin")
    mkdirSync(bin)
    const fake = path.join(bin, "gh")
    writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "run" && args[1] === "list") {
  console.log(JSON.stringify([{ databaseId: 2, displayTitle: "Merge", headBranch: "main", conclusion: "success" }, { databaseId: 1, displayTitle: "Merge", headBranch: "main", conclusion: "success" }]))
} else if (args[0] === "run" && args[1] === "download") {
  const fs = require("node:fs"), path = require("node:path")
  const dir = path.join(args[args.indexOf("--dir") + 1], "windows-standard-shard-1")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ results: [{ file: "a.test.js", ms: 10400 }] }))
} else process.exit(1)
`)
    chmodSync(fake, 0o755)
    const output = path.join(dir, "output.txt")
    const run = spawnSync(process.execPath, [path.join(scripts, "refresh-suite-durations.mjs"), "--table", table, "--tests-root", tests], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_OUTPUT: output },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(readFileSync(output, "utf8"), "changed=false\n")
    assert.equal(readFileSync(table, "utf8"), original, "the date-only difference must not rewrite the table")

    const slower = readFileSync(fake, "utf8").replace("ms: 10400", "ms: 30000")
    writeFileSync(fake, slower)
    const again = spawnSync(process.execPath, [path.join(scripts, "refresh-suite-durations.mjs"), "--table", table, "--tests-root", tests], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_OUTPUT: output },
    })
    assert.equal(again.status, 0, again.stderr)
    assert.match(readFileSync(output, "utf8"), /changed=true\n$/u)
    assert.equal(JSON.parse(readFileSync(table, "utf8")).files["a.test.js"], 30)
  } finally {
    removeTreeSync(dir)
  }
})

test("the workflow is weekly and manual, Linux only, bounded, never overlaps, and writes only through its own branch", () => {
  const workflow = load(readFileSync(path.join(scripts, "..", "workflows", "suite-durations-refresh.yml"), "utf8"))
  assert.ok(workflow.on.schedule.length === 1 && "workflow_dispatch" in workflow.on)
  assert.equal(workflow.concurrency["cancel-in-progress"], false)
  assert.ok(workflow.concurrency.group)
  assert.deepEqual(workflow.permissions, {})
  const job = workflow.jobs.refresh
  assert.equal(job["runs-on"], "ubuntu-latest")
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 30)
  assert.equal(job.env.GH_TOKEN, "${{ github.token }}")
  const steps = job.steps.map((step) => step.run ?? "").join("\n")
  assert.match(steps, /gh pr merge .* --auto --squash/u)
  assert.match(steps, /git push --force origin "HEAD:refs\/heads\/\$BRANCH"/u)
  assert.equal(job.steps.find((s) => s.id === "refresh").run.includes("git push"), false, "the no-change path pushes nothing")
  assert.match(job.steps.find((s) => s.run?.includes("git push"))["if"], /steps\.refresh\.outputs\.changed == 'true'/u)
})
