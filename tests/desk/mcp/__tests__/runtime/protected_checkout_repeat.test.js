// protected-checkout.cjs's own 9 s deadline is migrated onto the failure
// contract only for a *repeated* timeout of the exact same command (spec.md
// §1's table, row 5, Part 5) -- see protected-checkout-repeat.js's own header
// for why a single timeout stays a plain denial. Every test here is a direct,
// in-process import: no subprocess is spawned, no `gh` is ever invoked, and
// state is always redirected to a throwaway fixture directory, never the
// real HOME or XDG_STATE_HOME.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  REPEAT_TIMEOUT_THRESHOLD, commandSignature, recordTimeout, repeatedTimeoutDeskProblem,
} from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout-repeat.js"

function fixtureEnv(t) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-protected-checkout-repeat-"))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  return { root, env: { HOME: root } }
}

test("commandSignature is stable for the same text and trims surrounding whitespace", () => {
  assert.equal(commandSignature("git checkout main"), commandSignature("git checkout main"))
  assert.equal(commandSignature("git checkout main"), commandSignature("  git checkout main  "))
  assert.notEqual(commandSignature("git checkout main"), commandSignature("git checkout other"))
  assert.match(commandSignature("git checkout main"), /^[0-9a-f]{32}$/u)
})

test("recordTimeout counts up from 1 for the same command, and keeps separate counts per command", (t) => {
  const { env } = fixtureEnv(t)
  assert.equal(recordTimeout({ env, command: "git checkout main" }), 1)
  assert.equal(recordTimeout({ env, command: "git checkout main" }), 2)
  assert.equal(recordTimeout({ env, command: "git checkout main" }), 3)
  assert.equal(recordTimeout({ env, command: "git reset --hard" }), 1)
})

test("recordTimeout persists atomically (a temp file renamed into place) under Desk's own state directory, never the desk", (t) => {
  const { root, env } = fixtureEnv(t)
  recordTimeout({ env, command: "git checkout main", now: () => 1000 })
  const file = path.join(root, ".local", "state", "ouroboros-skills", "desk", "protected-checkout-timeouts", `${commandSignature("git checkout main")}.json`)
  const record = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(record.count, 1)
  assert.equal(record.at, 1000)
})

test("recordTimeout starts the count over once more than an hour has passed since the last timeout of the same command", (t) => {
  const { env } = fixtureEnv(t)
  let now = 0
  assert.equal(recordTimeout({ env, command: "git checkout main", now: () => now }), 1)
  now += 30 * 60 * 1000
  assert.equal(recordTimeout({ env, command: "git checkout main", now: () => now }), 2, "within the window: keeps counting")
  now += 61 * 60 * 1000
  assert.equal(recordTimeout({ env, command: "git checkout main", now: () => now }), 1, "past the window: starts over")
})

test("recordTimeout fails toward 1 (not 0, not a throw) when the state directory cannot be read or written", () => {
  // A HOME under a file, not a directory, so mkdirSync/readFileSync/writeFileSync all fail the same way a real permissions problem would.
  const env = { HOME: path.join("/dev/null", "not-a-real-directory") }
  assert.equal(recordTimeout({ env, command: "git checkout main" }), 1)
  assert.equal(recordTimeout({ env, command: "git checkout main" }), 1, "never persisted, so every call starts fresh")
})

test("recordTimeout treats a corrupt or unrecognizable previous record as no previous record", (t) => {
  const { root, env } = fixtureEnv(t)
  const dir = path.join(root, ".local", "state", "ouroboros-skills", "desk", "protected-checkout-timeouts")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${commandSignature("git checkout main")}.json`), "not json at all")
  assert.equal(recordTimeout({ env, command: "git checkout main" }), 1)
})

test("repeatedTimeoutDeskProblem stays null until the threshold, then emits a full Desk problem: block", (t) => {
  const { env } = fixtureEnv(t)
  for (let count = 1; count < REPEAT_TIMEOUT_THRESHOLD; count += 1) {
    const result = repeatedTimeoutDeskProblem({ command: "git checkout main", env, deadlineMs: 9000 })
    assert.equal(result.count, count)
    assert.equal(result.block, null)
  }
  const result = repeatedTimeoutDeskProblem({ command: "git checkout main", env, deadlineMs: 9000 })
  assert.equal(result.count, REPEAT_TIMEOUT_THRESHOLD)
  assert.match(result.block, /^Desk problem: protected-checkout — the same command keeps timing out\n/u)
  assert.match(result.block, /broke: the same command has now timed out 3 times in a row at protected-checkout's own 9000 ms deadline/u)
  assert.match(result.block, /means: protected-checkout may be stuck inspecting this exact command/u)
  assert.match(result.block, /file: filing in background/u)
  assert.match(result.block, /tell: Desk's protected-checkout guard has now timed out 3 times in a row/u)
})

test("repeatedTimeoutDeskProblem keeps emitting a block on every timeout past the threshold, with a growing count", (t) => {
  const { env } = fixtureEnv(t)
  for (let index = 0; index < REPEAT_TIMEOUT_THRESHOLD; index += 1) repeatedTimeoutDeskProblem({ command: "git checkout main", env })
  const result = repeatedTimeoutDeskProblem({ command: "git checkout main", env })
  assert.equal(result.count, REPEAT_TIMEOUT_THRESHOLD + 1)
  assert.match(result.block, /now timed out 4 times in a row/u)
})

test("repeatedTimeoutDeskProblem defaults deadlineMs to 9000 in its own prose when none is given", (t) => {
  const { env } = fixtureEnv(t)
  for (let index = 0; index < REPEAT_TIMEOUT_THRESHOLD; index += 1) repeatedTimeoutDeskProblem({ command: "git checkout main", env })
  const result = repeatedTimeoutDeskProblem({ command: "git checkout main", env })
  assert.match(result.block, /9000 ms deadline/u)
})

test("repeatedTimeoutDeskProblem never counts or blocks for an empty, missing or non-string command", (t) => {
  const { env } = fixtureEnv(t)
  assert.deepEqual(repeatedTimeoutDeskProblem({ command: "", env }), { count: 0, block: null })
  assert.deepEqual(repeatedTimeoutDeskProblem({ command: "   ", env }), { count: 0, block: null })
  assert.deepEqual(repeatedTimeoutDeskProblem({ command: undefined, env }), { count: 0, block: null })
  assert.deepEqual(repeatedTimeoutDeskProblem({ env }), { count: 0, block: null })
})

test("recordTimeout and repeatedTimeoutDeskProblem default env to process.env and now to Date.now, exactly like every other real caller", (t) => {
  const { root } = fixtureEnv(t)
  const originalHome = process.env.HOME
  const originalXdgState = process.env.XDG_STATE_HOME
  process.env.HOME = root
  delete process.env.XDG_STATE_HOME
  t.after(() => {
    process.env.HOME = originalHome
    if (originalXdgState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalXdgState
  })
  assert.equal(recordTimeout({ command: "git checkout main" }), 1)
  const result = repeatedTimeoutDeskProblem({ command: "git checkout main" })
  assert.equal(result.count, 2)
  assert.equal(result.block, null)
  // Every argument defaulted, exactly as an accidental no-args call would see: still never throws.
  assert.equal(typeof recordTimeout(), "number")
})

test("two different commands are tracked independently: one reaching the threshold never blocks the other", (t) => {
  const { env } = fixtureEnv(t)
  for (let index = 0; index < REPEAT_TIMEOUT_THRESHOLD; index += 1) repeatedTimeoutDeskProblem({ command: "git checkout main", env })
  const other = repeatedTimeoutDeskProblem({ command: "git reset --hard", env })
  assert.equal(other.count, 1)
  assert.equal(other.block, null)
})
