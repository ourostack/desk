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

const ok = (file) => ({ file, exitCode: 0, timedOut: false, pass: 1, fail: 0, skipped: 0 })
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

test("each shard is judged by its latest run attempt, so a passing rerun of a failed shard counts and a failing rerun is not hidden", () => {
  const failed = { ...ok("b.test.js"), fail: 1 }
  const shard1 = { "windows-standard-shard-1-attempt-1": { shard: "1/2", results: [ok("a.test.js")] } }
  const rerunPassed = verdictOf({ ...shard1, "windows-standard-shard-2-attempt-1": { shard: "2/2", results: [failed] }, "windows-standard-shard-2-attempt-2": { shard: "2/2", results: [ok("b.test.js")] } }, 2)
  assert.equal(rerunPassed.status, 0, rerunPassed.out)
  const rerunFailed = verdictOf({ ...shard1, "windows-standard-shard-2-attempt-1": { shard: "2/2", results: [ok("b.test.js")] }, "windows-standard-shard-2-attempt-2": { shard: "2/2", results: [failed] } }, 2)
  assert.equal(rerunFailed.status, 1)
  assert.match(rerunFailed.out, /windows-standard-shard-2-attempt-2: b\.test\.js failed/u)
  // Attempt 10 is later than attempt 9 (numbers, not text), and an unsuffixed folder counts as before every attempt.
  const tenth = verdictOf({ ...shard1, "windows-standard-shard-2": { shard: "2/2", results: [failed] }, "windows-standard-shard-2-attempt-9": { shard: "2/2", results: [failed] }, "windows-standard-shard-2-attempt-10": { shard: "2/2", results: [ok("b.test.js")] } }, 2)
  assert.equal(tenth.status, 0, tenth.out)
  const wrong = verdictOf({ ...shard1, "windows-standard-shard-2-attempt-3": { shard: "1/2", results: [ok("b.test.js")] } }, 2)
  assert.match(wrong.out, /windows-standard-shard-2-attempt-3: its results say shard 1\/2, not 2\/2/u)
})

test("a file that ran no tests fails, and a file whose tests were all skipped does not", () => {
  const none = (file) => ({ ...ok(file), pass: 0 })
  const empty = verdictOf(two([ok("a.test.js")], [none("b.test.js")]), 2)
  assert.notEqual(empty.status, 0)
  assert.match(empty.out, /b\.test\.js ran no tests/u)
  const skipped = verdictOf(two([ok("a.test.js")], [{ ...none("b.test.js"), skipped: 3 }]), 2)
  assert.equal(skipped.status, 0, skipped.out)
})

test("with an only filter, the suite is the files the filter selects", () => {
  assert.equal(verdictOf(two([ok("a.test.js")], []), 2, ["a.test.js", "b.test.js"], ["^a"]).status, 0)
})

test("the workflow has a single job named Windows suite that needs the shards and runs the verdict script", () => {
  const workflow = readFileSync(path.resolve(path.dirname(runner), "..", "workflows", "desk-windows-suite.yml"), "utf8")
  assert.match(workflow, /name: Windows suite\n\s+needs: windows-suite\n\s+if: \$\{\{ always\(\) \}\}/u)
  assert.match(workflow, /windows-suite-verdict\.mjs shard-results 8/u)
  // Each attempt keeps its own results; overwriting would lose the earlier attempt's evidence.
  assert.match(workflow, /name: windows-\$\{\{ matrix\.mode \}\}-shard-\$\{\{ matrix\.shard \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u)
  assert.doesNotMatch(workflow, /overwrite: true/u)
})

// These tiny actual-runner selections retain their owned fixtures/results.
// They do not execute the existing timeout fixture or a browser runtime.
const nativeMarker = "DESK_NATIVE_GENERATION_DIAGNOSTIC_V1 "
const nativeFile = "launch/browser_context_runtime.test.js"
const nativeLoader = path.resolve(path.dirname(runner), "../../tests/desk/mcp/__tests__/launch/fixtures/native-template-loader.cjs")
const nativeRecord = {
  setupPhase: "signedWorkerFixture.initial-daemon", originalCode: "NATIVE_CODE_UNAVAILABLE",
  status: "unknown", signal: "unknown",
  guard: { file: "plugins/desk/mcp/web-extension-credential.cjs", line: 562 },
}
const nativeUnknown = {
  setupPhase: "unknown", originalCode: "unknown", status: "unknown", signal: "unknown",
  guard: { file: "unknown", line: "unknown" },
}

function nativeFixtureRun(files) {
  const dir = mkdtempSync(path.join(process.env.DESK_TEST_RUN_DIR ?? os.tmpdir(), "native-retention-"))
  const tests = path.join(dir, "tests")
  mkdirSync(tests)
  writeFileSync(path.join(tests, "package.json"), '{"type":"commonjs"}\n')
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(tests, ...name.split("/"))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const out = path.join(dir, "results.json")
  const result = spawnSync(process.execPath, [
    runner, "--shard", "1/1", "--tests-root", tests, "--out", out, "--timeout-ms", "10000",
  ], { encoding: "utf8", timeout: 20000, env })
  writeFileSync(path.join(dir, "runner-stdout.txt"), result.stdout ?? "")
  writeFileSync(path.join(dir, "runner-stderr.txt"), result.stderr ?? "")
  assert.equal(result.error, undefined, "tiny synthetic runner must complete")
  return { status: result.status, ...JSON.parse(readFileSync(out, "utf8")) }
}

function nativeFailedCases(cases) {
  return 'const {test}=require("node:test");\n' + cases.map(({ name, lines = [], pass = false }) =>
    `test(${JSON.stringify(name)},t=>{` +
    lines.map(line => `t.diagnostic(${JSON.stringify(line)});`).join("") +
    (pass ? "" : 'const error=new Error("SYNTHETIC_REFUSAL");error.stack="Error: SYNTHETIC_REFUSAL";throw error;') +
    "});\n").join("")
}

// Break caught: depending on firstFailures/outputTail loses a complete diagnostic.
for (const position of [1, 28, 49, 56]) test(
  "native generation retention keeps the full safe record at failure position " + position, () => {
    const source = 'const {test}=require("node:test");\n' +
      `const {observeNextVerifyGeneration}=require(${JSON.stringify(nativeLoader)});\n` +
      `for(let index=1;index<=56;index++)test("synthetic-case-"+index,t=>{` +
      `if(index!==${position}){if(index>${position})t.diagnostic("SAFE_PADDING_"+"x".repeat(512));return;}` +
      'const error=Object.assign(new Error("NATIVE_CODE_UNAVAILABLE"),{code:"NATIVE_CODE_UNAVAILABLE"});' +
      'Object.defineProperty(error,"stack",{value:"Error: NATIVE_CODE_UNAVAILABLE\\n"+' +
      '"    at syntheticGuard (safe-fixture/web-extension-credential.cjs:562:12)\\n".repeat(40)});' +
      'let calls=0;const context={verifyGeneration(){calls++;throw error}};' +
      'observeNextVerifyGeneration(context,"signedWorkerFixture.initial-daemon",' +
      `record=>t.diagnostic(${JSON.stringify(nativeMarker)}+JSON.stringify(record)));` +
      'try{context.verifyGeneration()}catch(value){' +
      'if(value!==error||calls!==1)throw Error("SYNTHETIC_IDENTITY_BROKEN");throw value}' +
      '});\n'
    const { status, results } = nativeFixtureRun({ [nativeFile]: source })
    assert.equal(status, 1)
    assert.equal(results[0].exitCode, 1)
    assert.equal(results[0].timedOut, false)
    assert.equal(results[0].pass, 55)
    assert.equal(results[0].fail, 1)
    assert.equal(results[0].failures.length, 1)
    assert.equal(results[0].failures[0].name, "synthetic-case-" + position)
    assert.deepEqual(results[0].failures[0].nativeGenerationDiagnostic, nativeRecord)
  })

// Break caught: accepting arbitrary JSON would copy private paths/extra fields.
test("native generation retention rejects malformed oversized duplicate and private fields explicitly", () => {
  const valid = JSON.stringify(nativeRecord)
  const invalid = [
    "{", "null", "[]", JSON.stringify("PRIVATE_TEST_VALUE"),
    JSON.stringify({ ...nativeRecord, path: "/private/PRIVATE_TEST_VALUE" }),
    JSON.stringify({ ...nativeRecord, message: "PRIVATE_TEST_VALUE" }),
    JSON.stringify({ ...nativeRecord, setupPhase: "PRIVATE_TEST_VALUE" }),
    JSON.stringify({ ...nativeRecord, originalCode: "PRIVATE_TEST_VALUE" }),
    JSON.stringify({ ...nativeRecord, signal: "SIGTERM PRIVATE_TEST_VALUE" }),
    JSON.stringify({ ...nativeRecord, status: "PRIVATE_TEST_VALUE" }),
    JSON.stringify({ ...nativeRecord, status: 2 ** 40 }),
    JSON.stringify({ ...nativeRecord, guard: { file: "/private/web-extension-credential.cjs", line: 562 } }),
    JSON.stringify({ ...nativeRecord, guard: { file: "unknown", line: 562 } }),
    JSON.stringify({ ...nativeRecord, guard: { ...nativeRecord.guard, line: 100000 } }),
    JSON.stringify({ ...nativeRecord, guard: { ...nativeRecord.guard, extra: "PRIVATE_TEST_VALUE" } }),
    valid.replace('"status":"unknown"', '"__proto__":{},"status":"unknown"'),
  ].map((value, i) => ({ name: "malformed-" + i, lines: [nativeMarker + value], reason: "malformed" }))
  invalid.push(
    { name: "oversize", lines: [nativeMarker + " ".repeat(513)], reason: "oversize" },
    { name: "duplicate", lines: [nativeMarker + valid, nativeMarker + valid], reason: "duplicate" },
    { name: "invalid-then-valid", lines: [nativeMarker + "{", nativeMarker + valid], reason: "duplicate" },
    { name: "valid-then-invalid", lines: [nativeMarker + valid, nativeMarker + "{"], reason: "duplicate" },
    { name: "bare-marker", lines: [nativeMarker.trimEnd()], reason: "malformed" },
  )
  const { status, results } = nativeFixtureRun({ [nativeFile]: nativeFailedCases(invalid) })
  assert.equal(status, 1)
  assert.equal(results[0].fail, invalid.length)
  assert.equal(results[0].failures.length, invalid.length)
  for (const [index, item] of invalid.entries()) {
    const failure = results[0].failures[index]
    assert.equal(failure.name, item.name)
    assert.deepEqual(failure.nativeGenerationDiagnostic, { unavailable: item.reason })
    assert.equal(JSON.stringify(failure.nativeGenerationDiagnostic).includes("PRIVATE"), false)
    assert.equal(JSON.stringify(failure.nativeGenerationDiagnostic).includes("/private/"), false)
  }
})

// Break caught: normalizing real unknowns or clipping valid codes changes meaning.
test("native generation retention preserves explicit unknowns and bounded useful fields", () => {
  const records = [
    nativeUnknown,
    { ...nativeRecord, setupPhase: "signedWorkerFixture.codec-binding", originalCode: "EIO" },
    { ...nativeRecord, originalCode: "EPERM", status: -2147483648, signal: "SIGTERM" },
    { ...nativeRecord, originalCode: "ENOENT", status: 4294967295, signal: "SIGKILL",
      guard: { file: "plugins/desk/mcp/web-playwright-patch.cjs", line: 99999 } },
    { ...nativeRecord, originalCode: "ETIMEDOUT", status: 0, signal: "unknown" },
  ]
  const cases = records.map((record, i) => ({ name: "safe-" + i, lines: [nativeMarker + JSON.stringify(record)] }))
  const { status, results } = nativeFixtureRun({ [nativeFile]: nativeFailedCases(cases) })
  assert.equal(status, 1)
  assert.equal(results[0].fail, records.length)
  assert.deepEqual(results[0].failures.map(f => f.nativeGenerationDiagnostic), records)
})

// Break caught: matching any filename or moving diagnostics across cases broadens scope.
test("native generation retention is exact-file and failed-case scoped without changing normal shape", () => {
  const second = { ...nativeRecord, originalCode: "EIO", status: 2, signal: "unknown" }
  const otherCases = nativeFailedCases([
    { name: "ordinary-pass", pass: true },
    { name: "ordinary-failure", lines: [nativeMarker + JSON.stringify(nativeRecord)] },
  ])
  const { status, results } = nativeFixtureRun({
    [nativeFile]: nativeFailedCases([
      { name: "passing-diagnostic", pass: true, lines: [nativeMarker + JSON.stringify(second)] },
      { name: "first", lines: [nativeMarker + JSON.stringify(nativeRecord)] },
      { name: "none" },
      { name: "second", lines: [nativeMarker + JSON.stringify(second)] },
      { name: "last-pass", pass: true, lines: [nativeMarker + JSON.stringify(second)] },
    ]),
    "ordinary.test.js": otherCases,
    "other/browser_context_runtime.test.js": otherCases,
    "launch/browser_context_runtime_extra.test.js": otherCases,
  })
  assert.equal(status, 1)
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), [
      "exitCode", "fail", "failedTests", "failures", "file", "firstFailures", "ms",
      "outputTail", "pass", "skipped", "stuck", "tail", "timedOut",
    ].sort())
    assert.equal(result.exitCode, 1)
    assert.equal(result.timedOut, false)
    if (result.file === nativeFile) {
      assert.equal(result.pass, 2)
      assert.equal(result.fail, 3)
      assert.deepEqual(result.failures.map(f => f.name), ["first", "none", "second"])
      assert.deepEqual(result.failures[0].nativeGenerationDiagnostic, nativeRecord)
      assert.equal(Object.hasOwn(result.failures[1], "nativeGenerationDiagnostic"), false)
      assert.deepEqual(result.failures[2].nativeGenerationDiagnostic, second)
    } else {
      assert.equal(result.pass, 1)
      assert.equal(result.fail, 1)
      assert.deepEqual(Object.keys(result.failures[0]).sort(), ["error", "name", "stack"])
    }
  }
})

test("native generation retention leaves a passing diagnostic case and verdict unchanged", () => {
  const { status, results } = nativeFixtureRun({
    [nativeFile]: nativeFailedCases([
      { name: "safe-pass", pass: true, lines: [nativeMarker + JSON.stringify(nativeRecord)] },
    ]),
  })
  assert.equal(status, 0)
  assert.equal(results[0].exitCode, 0)
  assert.equal(results[0].pass, 1)
  assert.equal(results[0].fail, 0)
  assert.deepEqual(results[0].failures, [])
  assert.equal(Object.hasOwn(results[0], "nativeGenerationDiagnostic"), false)
})

// Break caught: a marker quoted inside a YAML error/stack is not a TAP diagnostic.
test("native generation retention ignores a marker quoted inside the failure error", () => {
  const source = 'const {test}=require("node:test");test("quoted-only",()=>{' +
    `const error=new Error(${JSON.stringify("SYNTHETIC_REFUSAL\n# " + nativeMarker + JSON.stringify(nativeRecord))});` +
    'Object.defineProperty(error,"stack",{value:"Error: SYNTHETIC_REFUSAL"});throw error});\n'
  const { status, results } = nativeFixtureRun({ [nativeFile]: source })
  assert.equal(status, 1)
  assert.equal(results[0].fail, 1)
  assert.equal(results[0].failures[0].name, "quoted-only")
  assert.equal(Object.hasOwn(results[0].failures[0], "nativeGenerationDiagnostic"), false)
})
