import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  collectMigrationRecorder, MIGRATION_RECORDER_MARKER,
  RECORDER_MAX_BYTES, RECORDER_MAX_EVENTS, COLLECTOR_MAX_BYTES, COLLECTOR_MAX_EVENTS,
} from "../../../../../.github/scripts/migration-recorder.mjs"

const file = "runtime/pending_migrations.test.js"
const record = (context, outcome = "fulfilled") => ({
  version: 1, context, qualification: "QUALIFIED", reason: null,
  events: [
    { n: 1, ms: 0, case: context === "budget" ? "01-slow-detect:detect" : "descendant-timeout", event: "case", sourceSha256: "a".repeat(64), sourceMatched: true, timeoutMs: context === "budget" ? "UNOBSERVED" : 300 },
    { n: 2, ms: 1200, case: "context", event: "promise-settled", outcome, boundary: context === "budget" ? "context" : "block" },
  ],
})
const line = (value) => `# ${MIGRATION_RECORDER_MARKER}${JSON.stringify(value)}\n`

test("PURE-FAKE migration recorder custody survives early TAP, serialization and every original verdict", () => {
  for (const metadata of [
    { exitCode: 0, timedOut: false, pass: 58, fail: 0, ms: 28_551 },
    { exitCode: 1, timedOut: false, pass: 56, fail: 2, ms: 28_551 },
    { exitCode: null, timedOut: true, pass: 10, fail: 0, ms: 1_800_728 },
  ]) {
    const records = [record("run-block", metadata.exitCode === 0 ? "fulfilled" : "rejected"), record("budget")]
    const output = line(records[0]) + line(records[1]) +
      '# [unrelated-marker]{"env":"private-value","source":"private-source","path":"/private/path","output":"private-output"}\n' +
      "not ok 1 - controlled original failure\n  ---\n  error: original error\n  ...\n" +
      "# unrelated late TAP\n".repeat(400) + "1..58\n# tests 58\n"
    const oldTail = output.slice(-4000)
    const oldFirstFailure = [...output.matchAll(/^\s*not ok \d+ - [\s\S]*?(?=^\s*(?:# Subtest|ok \d+|not ok \d+|1\.\.))/gmu)][0][0].slice(0, 1500)
    assert.ok(!oldTail.includes(MIGRATION_RECORDER_MARKER))
    assert.ok(!oldFirstFailure.includes(MIGRATION_RECORDER_MARKER))
    const original = { file, ...metadata, failedTests: ["controlled original failure"], outputTail: oldTail, firstFailures: oldFirstFailure }
    const results = JSON.parse(JSON.stringify({ results: [{ ...original, migrationRecorder: collectMigrationRecorder(output, file) }] }))
    const { migrationRecorder, ...preserved } = results.results[0]
    assert.deepEqual(preserved, original)
    assert.equal(migrationRecorder.qualification, "QUALIFIED")
    assert.equal(migrationRecorder.scope, "observations-only-not-native-cause")
    assert.deepEqual(migrationRecorder.records, records)
    assert.deepEqual(migrationRecorder.issues, [])
    for (const privateValue of ["private-value", "private-source", "/private/path", "private-output"]) {
      assert.ok(!JSON.stringify(migrationRecorder).includes(privateValue))
    }
  }
})

test("PURE-FAKE migration recorder custody rejects unrelated, malformed and untyped records explicitly", () => {
  const valid = line(record("run-block")) + line(record("budget"))
  assert.equal(collectMigrationRecorder(valid, "runtime/unrelated.test.js"), undefined)
  const unrelated = collectMigrationRecorder('# [unrelated-marker]{"env":"private"}\n', file)
  assert.equal(unrelated.qualification, "UNQUALIFIED")
  assert.deepEqual(unrelated.records, [])
  assert.ok(unrelated.issues.includes("missing-context"))
  for (const [extra, expected] of [
    [`# ${MIGRATION_RECORDER_MARKER}{broken-json}\n`, "malformed-json"],
    [line({ ...record("run-block"), rawSource: "must-not-be-forwarded" }), "invalid-schema"],
    [line({ ...record("run-block"), events: [{ n: 1, ms: 0, case: "context", event: "raw-env", env: "must-not-be-forwarded" }] }), "invalid-schema"],
    [line({ ...record("run-block"), context: { toString: "not-a-function" } }), "invalid-schema"],
    [line({ ...record("run-block"), events: [{ event: { toString: "not-a-function" } }] }), "invalid-schema"],
    [line(record("run-block")), "duplicate-context"],
  ]) {
    const result = collectMigrationRecorder(valid + extra, file)
    assert.equal(result.qualification, "UNQUALIFIED")
    assert.ok(result.issues.includes(expected))
    assert.deepEqual(result.records, [record("run-block"), record("budget")])
    assert.ok(!JSON.stringify(result).includes("must-not-be-forwarded"))
  }
})

test("PURE-FAKE migration recorder custody bounds record bytes, aggregate bytes and event counts", () => {
  const oversized = collectMigrationRecorder(`# ${MIGRATION_RECORDER_MARKER}${" ".repeat(RECORDER_MAX_BYTES + 1)}\n`, file)
  assert.equal(oversized.qualification, "UNQUALIFIED")
  assert.ok(oversized.issues.includes("record-byte-limit"))
  const padded = (context) => {
    const text = JSON.stringify(record(context))
    return `# ${MIGRATION_RECORDER_MARKER}${text}${" ".repeat(RECORDER_MAX_BYTES - text.length)}\n`
  }
  const aggregate = collectMigrationRecorder(padded("run-block") + padded("budget"), file)
  assert.equal(aggregate.qualification, "UNQUALIFIED")
  assert.ok(aggregate.issues.includes("aggregate-limit"))
  const events = (count, context) => {
    const value = record(context)
    value.events.push(...Array.from({ length: count - 2 }, (_, index) => ({
      n: index + 3, ms: 1200, case: "context", event: "observer-release",
    })))
    return value
  }
  const tooMany = collectMigrationRecorder(line(events(RECORDER_MAX_EVENTS + 1, "run-block")), file)
  assert.equal(tooMany.qualification, "UNQUALIFIED")
  assert.ok(tooMany.issues.includes("record-event-limit"))
  const atLimit = collectMigrationRecorder(line(events(RECORDER_MAX_EVENTS, "run-block")) + line(events(RECORDER_MAX_EVENTS, "budget")), file)
  assert.equal(atLimit.qualification, "QUALIFIED")
  assert.equal(atLimit.records.reduce((sum, item) => sum + item.events.length, 0), COLLECTOR_MAX_EVENTS)
  for (const result of [oversized, aggregate, tooMany, atLimit]) assert.ok(Buffer.byteLength(JSON.stringify(result)) <= COLLECTOR_MAX_BYTES)
})

test("PURE-FAKE actual suite runner persists early recorder records for success and failure", (t) => {
  const runner = fileURLToPath(new URL("../../../../../.github/scripts/run-suite-files.mjs", import.meta.url))
  const evidence = process.env.DESK_MIGRATION_RECORDER_EVIDENCE_ROOT
  const root = mkdtempSync(path.join(evidence ?? os.tmpdir(), "desk-migration-recorder-custody-"))
  try {
    for (const failure of [false, true]) {
      const verdict = failure ? "failure" : "success"
      const dir = path.join(root, verdict)
      const tests = path.join(dir, "tests")
      const runtime = path.join(tests, "runtime")
      mkdirSync(runtime, { recursive: true })
      const records = [record("run-block", failure ? "rejected" : "fulfilled"), record("budget")]
      const body = [
        'import { test } from "node:test"',
        'import assert from "node:assert/strict"',
        'test("synthetic early recorder", (t) => {',
        ...records.map((value) => `  t.diagnostic(${JSON.stringify(MIGRATION_RECORDER_MARKER + JSON.stringify(value))})`),
        "})",
        `test("synthetic custody verdict ${verdict}", (t) => {`,
        '  for (let i = 0; i < 450; i++) t.diagnostic("unrelated synthetic tail padding")',
        `  assert.equal(${failure}, false, "controlled synthetic verdict")`,
        "})",
        "",
      ].join("\n")
      writeFileSync(path.join(runtime, "pending_migrations.test.js"), body)
      assert.deepEqual(readdirSync(tests), ["runtime"])
      assert.deepEqual(readdirSync(runtime), ["pending_migrations.test.js"])
      const out = path.join(dir, "results.json")
      const argv = [runner, "--shard", "1/1", "--out", out, "--tests-root", tests, "--timeout-ms", "3000"]
      assert.ok(path.isAbsolute(tests) && path.isAbsolute(out))
      assert.equal(argv.includes("--probe-acl"), false)
      // The runner's children must print their own TAP, not report into this test process.
      const env = { ...process.env }
      delete env.NODE_TEST_CONTEXT
      const child = spawnSync(process.execPath, argv, { encoding: "utf8", env, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65_536 })
      writeFileSync(path.join(dir, "invocation.json"), JSON.stringify({
        executable: process.execPath, argv, pid: child.pid, status: child.status, signal: child.signal,
        errorCode: child.error?.code ?? null,
      }, null, 2) + "\n")
      writeFileSync(path.join(dir, "runner.stdout"), child.stdout ?? "")
      writeFileSync(path.join(dir, "runner.stderr"), child.stderr ?? "")
      assert.equal(child.error, undefined)
      assert.equal(child.signal, null)
      assert.equal(child.status, failure ? 1 : 0, child.stdout + child.stderr)
      const written = readFileSync(out, "utf8")
      const parsed = JSON.parse(written)
      assert.equal(parsed.shard, "1/1")
      assert.equal(parsed.aclProbe, null)
      assert.equal(parsed.results.length, 1)
      const result = parsed.results[0]
      assert.equal(result.file, file)
      assert.equal(result.exitCode, failure ? 1 : 0)
      assert.equal(result.timedOut, false)
      assert.equal(result.pass, failure ? 1 : 2)
      assert.equal(result.fail, failure ? 1 : 0)
      assert.equal(result.skipped, 0)
      assert.deepEqual(result.failedTests, failure ? ["synthetic custody verdict failure"] : [])
      assert.equal(result.migrationRecorder.qualification, "QUALIFIED")
      assert.equal(result.migrationRecorder.scope, "observations-only-not-native-cause")
      assert.deepEqual(result.migrationRecorder.records, records)
      assert.deepEqual(result.migrationRecorder.issues, [])
      assert.equal(result.outputTail.includes(MIGRATION_RECORDER_MARKER), false)
      assert.equal(result.firstFailures.includes(MIGRATION_RECORDER_MARKER), false)
      if (failure) assert.ok(result.outputTail.length > 0 && result.firstFailures.length > 0)
      const summary = readFileSync(path.join(dir, "results-summary.md"), "utf8")
      assert.ok(summary.includes(`| 1 | ${failure ? 1 : 0} | 0 | ${failure ? 1 : 2} | ${failure ? 1 : 0} |`))
      t.diagnostic(`synthetic custody ${verdict}: exit=${child.status} pass=${result.pass} fail=${result.fail} resultsSha256=${createHash("sha256").update(written).digest("hex")}`)
    }
  } finally {
    if (evidence === undefined) rmSync(root, { recursive: true, force: true })
  }
})
