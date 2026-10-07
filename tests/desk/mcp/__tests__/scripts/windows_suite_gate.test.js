// The Windows suite job is a pull-request gate, so the runner must exit non-zero for a failed test, a failed file or a timeout, and zero only for a clean run.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".github", "scripts", "run-suite-files.mjs")

const PASSING = `import { test } from "node:test"\ntest("passes", () => {})\n`
const FAILING = `import { test } from "node:test"\nimport assert from "node:assert/strict"\ntest("fails", () => { assert.equal(1, 2) })\n`
const HANGING = `import { test } from "node:test"\ntest("hangs", async () => { await new Promise((resolve) => setTimeout(resolve, 60000)) })\n`

function run(files, extra = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-suite-gate-"))
  try {
    const tests = path.join(dir, "tests")
    mkdirSync(tests)
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(tests, name), body)
    const out = path.join(dir, "results.json")
    // The runner starts `node --test` itself; the outer test runner's context variable would make those children report to it instead of printing their own results.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, [runner, "--shard", "1/1", "--out", out, "--tests-root", tests, ...extra], { encoding: "utf8", timeout: 120000, env })
    return { status: result.status, results: JSON.parse(readFileSync(out, "utf8")).results, summary: readFileSync(path.join(dir, "results-summary.md"), "utf8") }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("a clean run exits zero", () => {
  const { status, results } = run({ "a.test.js": PASSING })
  assert.equal(status, 0)
  assert.equal(results[0].fail, 0)
})

test("a failed test makes the job exit non-zero and is still written to the results and the summary", () => {
  const { status, results, summary } = run({ "a.test.js": PASSING, "b.test.js": FAILING })
  assert.equal(status, 1)
  assert.equal(results.find((r) => r.file === "b.test.js").fail, 1)
  assert.match(summary, /\| 2 \| 1 \| 0 \| 1 \| 1 \|/u)
})

test("a file that hangs past its time limit makes the job exit non-zero", () => {
  const { status, results } = run({ "a.test.js": HANGING }, ["--timeout-ms", "1500"])
  assert.equal(status, 1)
  assert.equal(results[0].timedOut, true)
})

// The aggregate "Windows suite" job counts the uploaded per-file results against the suite's own file list, so it is red for a failure the shard jobs did not report, for a shard that ran nothing and for a file no shard ran.
const verdictScript = path.resolve(path.dirname(runner), "windows-suite-verdict.mjs")

// `shards` maps a folder name to its results file: { shard, results }. `suite` is the test files that exist in the checkout.
function verdictOf(shards, expected, suite = ["a.test.js", "b.test.js"], extra = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-suite-verdict-"))
  try {
    const tests = path.join(dir, "tests")
    mkdirSync(path.join(tests, "sub"), { recursive: true })
    for (const file of suite) writeFileSync(path.join(tests, ...file.split("/")), "")
    writeFileSync(path.join(tests, "helper.js"), "")
    const results = path.join(dir, "results")
    for (const [name, body] of Object.entries(shards)) {
      mkdirSync(path.join(results, name), { recursive: true })
      writeFileSync(path.join(results, name, "results.json"), JSON.stringify(body))
    }
    const result = spawnSync(process.execPath, [verdictScript, results, String(expected), tests, ...extra], { encoding: "utf8" })
    return { status: result.status, out: result.stdout }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ok = (file) => ({ file, exitCode: 0, timedOut: false, fail: 0 })
const two = (a, b) => ({ "windows-standard-shard-1": { shard: "1/2", results: a }, "windows-standard-shard-2": { shard: "2/2", results: b } })

test("the aggregate verdict is zero only when every shard reported its number and the shards ran exactly the suite's files, all passing", () => {
  assert.equal(verdictOf(two([ok("a.test.js")], [ok("b.test.js")]), 2).status, 0)
})

test("the aggregate verdict fails for a failed file, a failed test, a timeout and a missing shard", () => {
  const run = (extra) => verdictOf(two([ok("a.test.js")], [extra]), 2)
  assert.equal(run({ ...ok("b.test.js"), exitCode: 1 }).status, 1)
  assert.equal(run({ ...ok("b.test.js"), fail: 1 }).status, 1)
  const timeout = run({ ...ok("b.test.js"), exitCode: null, timedOut: true })
  assert.equal(timeout.status, 1)
  assert.match(timeout.out, /b\.test\.js timed out/u)
  const missing = verdictOf({ "windows-standard-shard-1": { shard: "1/2", results: [ok("a.test.js"), ok("b.test.js")] } }, 2)
  assert.equal(missing.status, 1)
  assert.match(missing.out, /1 of 2 shards reported/u)
})

test("shards that all upload no results do not pass, and every unreported file is named", () => {
  const empty = verdictOf(two([], []), 2, ["a.test.js", "sub/b.test.js"])
  assert.equal(empty.status, 1)
  assert.match(empty.out, /a\.test\.js: no shard reported it/u)
  assert.match(empty.out, /sub\/b\.test\.js: no shard reported it/u)
  const partial = verdictOf(two([ok("a.test.js")], []), 2)
  assert.equal(partial.status, 1)
  assert.match(partial.out, /b\.test\.js: no shard reported it/u)
})

test("a results file whose shard number does not match its folder, or a file reported twice or not in the suite, fails", () => {
  const wrong = verdictOf({ "windows-standard-shard-1": { shard: "2/2", results: [ok("a.test.js")] }, "windows-standard-shard-2": { shard: "2/2", results: [ok("b.test.js")] } }, 2)
  assert.equal(wrong.status, 1)
  assert.match(wrong.out, /windows-standard-shard-1: its results say shard 2\/2, not 1\/2/u)
  const total = verdictOf({ "windows-standard-shard-1": { shard: "1/6", results: [ok("a.test.js")] }, "windows-standard-shard-2": { shard: "2/6", results: [ok("b.test.js")] } }, 2)
  assert.equal(total.status, 1)
  const twice = verdictOf(two([ok("a.test.js"), ok("b.test.js")], [ok("b.test.js")]), 2)
  assert.equal(twice.status, 1)
  assert.match(twice.out, /b\.test\.js: reported by 2 shards/u)
  const stray = verdictOf(two([ok("a.test.js")], [ok("b.test.js"), ok("ghost.test.js")]), 2)
  assert.equal(stray.status, 1)
  assert.match(stray.out, /ghost\.test\.js: reported but not a test file/u)
  const sameShard = verdictOf({ "x-shard-1": { shard: "1/2", results: [ok("a.test.js")] }, "y-shard-1": { shard: "1/2", results: [ok("b.test.js")] } }, 2)
  assert.equal(sameShard.status, 1)
  assert.match(sameShard.out, /name the same shard/u)
})

test("with an only filter, the suite is the files the filter selects", () => {
  assert.equal(verdictOf(two([ok("a.test.js")], []), 2, ["a.test.js", "b.test.js"], ["^a"]).status, 0)
})

test("the workflow has a single job named Windows suite that needs the shards and runs the verdict script", () => {
  const workflow = readFileSync(path.resolve(path.dirname(runner), "..", "workflows", "desk-windows-suite.yml"), "utf8")
  assert.match(workflow, /name: Windows suite\n\s+needs: windows-suite\n\s+if: \$\{\{ always\(\) \}\}/u)
  assert.match(workflow, /windows-suite-verdict\.mjs shard-results 6/u)
})
