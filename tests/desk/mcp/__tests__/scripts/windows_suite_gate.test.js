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

// The aggregate "Windows suite" job counts the uploaded per-file results, so it is red for a failure the shard jobs did not report.
const verdictScript = path.resolve(path.dirname(runner), "windows-suite-verdict.mjs")

function verdictOf(shards, expected) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-suite-verdict-"))
  try {
    for (const [name, results] of Object.entries(shards)) {
      mkdirSync(path.join(dir, name))
      writeFileSync(path.join(dir, name, "results.json"), JSON.stringify({ results }))
    }
    const result = spawnSync(process.execPath, [verdictScript, dir, String(expected)], { encoding: "utf8" })
    return { status: result.status, out: result.stdout }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const OK = { file: "a.test.js", exitCode: 0, timedOut: false, fail: 0 }

test("the aggregate verdict is zero only when every shard reported and every file passed", () => {
  assert.equal(verdictOf({ "windows-standard-shard-1": [OK], "windows-standard-shard-2": [OK] }, 2).status, 0)
})

test("the aggregate verdict fails for a failed file, a failed test, a timeout and a missing shard", () => {
  const shards = (extra) => ({ "windows-standard-shard-1": [OK], "windows-standard-shard-2": [extra] })
  assert.equal(verdictOf(shards({ ...OK, exitCode: 1 }), 2).status, 1)
  assert.equal(verdictOf(shards({ ...OK, fail: 1 }), 2).status, 1)
  const timeout = verdictOf(shards({ ...OK, exitCode: null, timedOut: true }), 2)
  assert.equal(timeout.status, 1)
  assert.match(timeout.out, /a\.test\.js timed out/u)
  const missing = verdictOf({ "windows-standard-shard-1": [OK] }, 2)
  assert.equal(missing.status, 1)
  assert.match(missing.out, /1 of 2 shards reported/u)
})

test("the workflow has a single job named Windows suite that needs the shards and runs the verdict script", () => {
  const workflow = readFileSync(path.resolve(path.dirname(runner), "..", "workflows", "desk-windows-suite.yml"), "utf8")
  assert.match(workflow, /name: Windows suite\n\s+needs: windows-suite\n\s+if: \$\{\{ always\(\) \}\}/u)
  assert.match(workflow, /windows-suite-verdict\.mjs shard-results 6/u)
})
