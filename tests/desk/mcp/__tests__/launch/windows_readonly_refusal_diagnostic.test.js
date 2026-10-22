// Diagnostic only: retain existing transport evidence for the unchanged current policy case.
import "../_isolated_env.mjs"
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"

const run = promisify(execFile)
const policyCase = "native Windows readonly backend rechecks adverse DACLs and kind/reparse/link policy without repairing them"
const argsFor = (target, observer, name) =>
  [...process.execArgv, "--require", observer, "--test", "--test-reporter=tap", "--test-name-pattern=^" + name + "$", target]
function envFor(log) {
  const env = { ...process.env, DESK_OWNED_PRIVATE_PATH_OBSERVER: log }
  // A fresh node --test controller must create its own child context; retain every isolation preload and location.
  delete env.NODE_TEST_CONTEXT
  return env
}
const assertNestedStderr = stderr => assert.match(stderr,
  /^(?:\(node:[0-9]+\) Warning: Using the inspector with --test forces running at a concurrency of 1\. Use the inspectPort option to run with concurrency\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/u)

function summarize(rows) {
  const firstRefusal = rows.find(row => row.event === "reply" && row.token === "refused") ?? null
  return {
    events: rows.length,
    helpers: rows.filter(row => row.event === "spawn" && row.isMainThread === false),
    refusalCount: rows.filter(row => row.event === "reply" && row.token === "refused").length,
    firstRefusal,
    firstRefuserEvents: firstRefusal ? rows.filter(row => row.pid === firstRefusal.pid).slice(0, 12) : [],
    closes: rows.filter(row => row.event === "close"),
  }
}

test("transport summary does not invent close certainty from a refusal or EOF", () => {
  const rows = [{ event: "spawn", pid: 123, isMainThread: false },
    { event: "reply", pid: 123, token: "refused" }, { event: "eof", pid: 123 }]
  assert.equal(summarize(rows).refusalCount, 1)
  assert.deepEqual(summarize(rows).closes, [])
  rows.push({ event: "close", pid: 123, code: 1, signal: null })
  assert.equal(summarize(rows).closes[0].code, 1)
  assert.equal(summarize(rows).firstRefuserEvents.length, 4)
})

test("nested command retains the inherited inspector warning but rejects unrelated stderr", () => {
  const warning = "(node:5168) Warning: Using the inspector with --test forces running at a concurrency of 1. Use the inspectPort option to run with concurrency\n" +
    "(Use `node --trace-warnings ...` to show where the warning was created)\n"
  assertNestedStderr("")
  assertNestedStderr(warning)
  assert.throws(() => assertNestedStderr(warning + "UNEXPECTED_STDERR"))
  assert.throws(() => assertNestedStderr("UNEXPECTED_STDERR"))
})

test("nested diagnostic keeps the real preload and selects only the unchanged requested case", async () => {
  const base = await mkTempRoot("native-refusal-command-"), target = path.join(base, "selected.test.cjs")
  const observer = fileURLToPath(new URL("./fixtures/native-private-path-observer.cjs", import.meta.url))
  await fs.writeFile(target, `const test=require('node:test'),assert=require('node:assert/strict');test('selected',()=>{
assert.equal(typeof process.env.NODE_TEST_CONTEXT,'string');assert.ok(process.env.DESK_TEST_RUN_DIR)});
test('must not execute',()=>{throw new Error('UNSELECTED_CASE_EXECUTED')});\n`)
  const result = await run(process.execPath, argsFor(target, observer, "selected"), {
    env: envFor(path.join(base, "observer.jsonl")),
    timeout: 10000, maxBuffer: 65536,
  })
  assert.match(result.stdout, /ok 1 - selected/u)
  assert.doesNotMatch(result.stdout, /UNSELECTED_CASE_EXECUTED/u)
  assertNestedStderr(result.stderr)
})

test("actual Windows unchanged readonly policy case retains refusal and real helper close outcomes", {
  skip: process.platform !== "win32", timeout: 150000,
}, async t => {
  const base = await mkTempRoot("native-refusal-diagnostic-"), log = path.join(base, "transport.jsonl")
  const target = fileURLToPath(new URL("./native_private_path_worker.test.js", import.meta.url))
  const observer = fileURLToPath(new URL("./fixtures/native-private-path-observer.cjs", import.meta.url))
  const args = argsFor(target, observer, policyCase)
  let result
  try {
    const completed = await run(process.execPath, args, {
      env: envFor(log),
      windowsHide: true, timeout: 140000, maxBuffer: 1024 * 1024,
    })
    result = { code: 0, signal: null, ...completed }
  } catch (error) {
    if (!Number.isInteger(error.code) && error.killed !== true) throw error
    result = { code: error.code ?? null, signal: error.signal ?? null,
      stdout: error.stdout, stderr: error.stderr }
  }
  let text
  try { text = await fs.readFile(log, "utf8") }
  catch (error) {
    if (error.code !== "ENOENT") throw error
    text = ""
  }
  const rows = text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : []
  if (result.code !== 0) {
    t.diagnostic("Original unchanged case stdout:\n" + result.stdout.slice(-16000))
    t.diagnostic("Original unchanged case stderr:\n" + result.stderr.slice(-4000))
  }
  const summary = summarize(rows)
  t.diagnostic("DESK_READONLY_REFUSAL_DIAGNOSTIC_V1 " + JSON.stringify({
    scope: "diagnostic_only_not_normal_full_qualification", nodeVersion: process.version,
    originalCaseExit: result.code, originalCaseSignal: result.signal, ...summary,
  }))
  assert.equal(result.code, 0, "original policy/repair assertions must pass unchanged")
  assert.equal(result.signal, null)
  assert.ok(summary.refusalCount > 0, "the actual original adverse-policy branch must execute")
  assert.ok(summary.closes.some(row => row.pid === summary.firstRefusal.pid && row.code === 0 && row.signal === null),
    "the retired refused helper must actually close normally, not merely receive EOF")
})
