// The Windows suite splits the test files over its shards by measured duration. The split must give every file to exactly one shard, come out the same every time, keep the shards close to even, and stay in step with the workflow and the checked-in duration table.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".github", "scripts")
const { assignShards, shardFiles, loadDurations, defaultTablePath } = await import(pathToFileURL(path.join(scripts, "suite-shards.mjs")).href)
const { checkTable, refreshTable } = await import(pathToFileURL(path.join(scripts, "suite-durations.mjs")).href)
const { suiteFiles } = await import(pathToFileURL(path.join(scripts, "suite-files.mjs")).href)
const require = createRequire(import.meta.url)
const { load } = require("js-yaml")
const testsRoot = path.resolve(scripts, "..", "..", "tests", "desk", "mcp", "__tests__")

const table = { defaultSeconds: 10, files: { "big.test.js": 100, "mid1.test.js": 50, "mid2.test.js": 50, "small.test.js": 5 } }

test("the heaviest file goes first to the lightest shard, ties go by name and then the lowest shard", () => {
  const plan = assignShards(["small.test.js", "mid2.test.js", "big.test.js", "mid1.test.js"], 2, table)
  // big (100) -> shard 1; mid1 (50) -> shard 2; mid2 (50) -> shard 2 (50 < 100); small (5) -> shard 1 (a 100 to 100 tie goes to the lowest shard).
  assert.deepEqual(plan[0].files, ["big.test.js", "small.test.js"])
  assert.deepEqual(plan[1].files, ["mid1.test.js", "mid2.test.js"])
  assert.deepEqual(plan.map((s) => s.seconds), [105, 100])
})

test("a file the table does not list gets the default weight", () => {
  const plan = assignShards(["big.test.js", "new.test.js"], 2, table)
  assert.deepEqual(plan.map((s) => s.seconds), [100, 10])
  assert.ok(plan[1].files.includes("new.test.js"))
})

test("the plan is the same for any input order and any repeat", () => {
  const files = ["a.test.js", "b.test.js", "c.test.js", "d.test.js", "big.test.js", "mid1.test.js", "mid2.test.js", "small.test.js"]
  const first = assignShards(files, 3, table)
  assert.deepEqual(assignShards([...files].reverse(), 3, table), first)
  assert.deepEqual(assignShards(files, 3, table), first)
})

test("every file lands on exactly one shard, for the real suite at every shard count", () => {
  const files = suiteFiles(testsRoot)
  const real = loadDurations()
  for (const total of [1, 2, 7, 8, 9, 50]) {
    const assigned = assignShards(files, total, real).flatMap((s) => s.files)
    assert.equal(assigned.length, files.length, `${total} shards`)
    assert.deepEqual([...assigned].sort(), [...files].sort(), `${total} shards`)
    assert.equal(new Set(assigned).size, files.length, `${total} shards`)
  }
  assert.deepEqual(shardFiles(files, 1, 8, real), assignShards(files, 8, real)[0].files)
})

test("more shards than files leaves empty shards, and a shard count that is not a positive integer is refused", () => {
  assert.deepEqual(assignShards(["a.test.js"], 3, table).map((s) => s.files.length), [1, 0, 0])
  assert.throws(() => assignShards(["a.test.js"], 0, table))
  assert.throws(() => assignShards(["a.test.js"], 1.5, table))
})

test("with no table every file weighs the same, so the split is even by count", () => {
  const files = Array.from({ length: 10 }, (_, i) => `f${i}.test.js`)
  const plan = assignShards(files, 4, loadDurations(path.join(os.tmpdir(), "no-such-table.json")))
  assert.deepEqual(plan.map((s) => s.files.length).sort(), [2, 2, 3, 3])
})

test("the checked-in table plans eight shards inside the budget: none over 30 minutes and none far above the mean", () => {
  const real = loadDurations()
  const plan = assignShards(suiteFiles(testsRoot), 8, real)
  const mean = plan.reduce((n, s) => n + s.seconds, 0) / plan.length
  const worst = Math.max(...plan.map((s) => s.seconds))
  assert.ok(worst <= 30 * 60, `the longest shard is predicted at ${Math.round(worst / 60)} min`)
  assert.ok(worst <= mean * 1.1, `the longest shard (${Math.round(worst)} s) is more than 10% above the mean (${Math.round(mean)} s)`)
  // The per-file limit is 30 minutes; a file near it cannot be balanced away and needs its own fix.
  assert.ok(Math.max(...Object.values(real.files)) < 25 * 60, "a single file is near the 30 minute limit")
})

test("the checked-in table names no test file that is gone and has only positive numbers", () => {
  const { stale, invalid } = checkTable(JSON.parse(readFileSync(defaultTablePath, "utf8")), testsRoot)
  assert.deepEqual(stale, [], "stale entries: run node .github/scripts/suite-durations.mjs refresh <results folders>")
  assert.deepEqual(invalid, [])
})

test("checkTable names stale, unlisted and invalid entries", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-durations-"))
  try {
    writeFileSync(path.join(dir, "a.test.js"), "")
    writeFileSync(path.join(dir, "b.test.js"), "")
    const result = checkTable({ defaultSeconds: 5, files: { "a.test.js": 3, "gone.test.js": 4, "b.test.js": -1 } }, dir)
    assert.deepEqual(result.stale, ["gone.test.js"])
    assert.deepEqual(result.invalid, ["b.test.js"])
    assert.deepEqual(result.unlisted, [])
    assert.deepEqual(checkTable({ defaultSeconds: 5, files: {} }, dir).unlisted, ["a.test.js", "b.test.js"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("refresh averages the runs, drops files that are gone and keeps an old weight for a file with no new sample", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-durations-"))
  try {
    for (const f of ["a", "b", "c"]) writeFileSync(path.join(dir, `${f}.test.js`), "")
    const results = (name, rows) => { mkdirSync(path.join(dir, "r", name), { recursive: true }); writeFileSync(path.join(dir, "r", name, "results.json"), JSON.stringify({ results: rows })) }
    results("one", [{ file: "a.test.js", ms: 10000 }, { file: "gone.test.js", ms: 5000 }, { file: "c.test.js", ms: 99999, timedOut: true }])
    results("two", [{ file: "a.test.js", ms: 20000 }])
    const out = refreshTable([path.join(dir, "r")], dir, { files: { "b.test.js": 7 } })
    assert.deepEqual(out.files, { "a.test.js": 15, "b.test.js": 7 })
    assert.equal(out.inputs, 2)
    assert.throws(() => refreshTable([], dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the workflow's shard list, shard arguments and verdict all say the same number, and the always-on trigger has no path filter", () => {
  const text = readFileSync(path.join(scripts, "..", "workflows", "desk-windows-suite.yml"), "utf8")
  const workflow = load(text)
  const shards = workflow.jobs["windows-suite"].strategy.matrix.shard
  assert.deepEqual(shards, Array.from({ length: shards.length }, (_, i) => i + 1))
  const totals = [...text.matchAll(/matrix\.shard \}\}\/(\d+)/gu)].map((m) => Number(m[1]))
  assert.ok(totals.length >= 3)
  for (const total of totals) assert.equal(total, shards.length)
  assert.equal(Number(/windows-suite-verdict\.mjs shard-results (\d+)/u.exec(text)[1]), shards.length)
  assert.equal(workflow.on.pull_request?.paths, undefined, "a path filter would leave the required Windows suite check missing on a skipped pull request")
  assert.equal(workflow.on.pull_request?.["paths-ignore"], undefined)
})

test("the shard runner runs only its own files and reports its predicted load", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-shard-run-"))
  try {
    const tests = path.join(dir, "tests")
    mkdirSync(tests)
    for (const f of ["a", "b", "c"]) writeFileSync(path.join(tests, `${f}.test.js`), `import { test } from "node:test"\ntest("${f}", () => {})\n`)
    const durations = path.join(dir, "d.json")
    writeFileSync(durations, JSON.stringify({ defaultSeconds: 1, files: { "a.test.js": 100, "b.test.js": 10, "c.test.js": 10 } }))
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const ran = (n) => {
      const out = path.join(dir, `r${n}.json`)
      const result = spawnSync(process.execPath, [path.join(scripts, "run-suite-files.mjs"), "--shard", `${n}/2`, "--out", out, "--tests-root", tests, "--durations", durations], { encoding: "utf8", env, timeout: 120000 })
      assert.equal(result.status, 0, result.stdout + result.stderr)
      return JSON.parse(readFileSync(out, "utf8")).results.map((r) => r.file)
    }
    assert.deepEqual(ran(1), ["a.test.js"])
    assert.deepEqual(ran(2), ["b.test.js", "c.test.js"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
