// Boot acceptance: Desk runs the boot itself, so a run passes only when the boot reached the agent and the agent did not run the script. No model calls.
// Run: node --test evals/boot-acceptance/autoboot.test.mjs
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { autoBootRan } from "./run.mjs"
import { discountCancelledStart } from "./gates.mjs"
import { findScenario } from "./scenarios.mjs"

const ctxFor = (overrides = {}) => ({
  toolCalls: [],
  critiqueToolCalls: [],
  assistantTexts: ["You have watering-schedule-api open: the rain delay is next."],
  finalResultText: "You have watering-schedule-api open: the rain delay is next.",
  tokenLeaks: 0,
  isError: false,
  ...overrides,
})
const outcome = (ctx) => findScenario("say-hi").check(ctx)

test("a run Desk booted for passes, and says so", () => {
  const result = outcome(ctxFor({ autoBoot: true }))
  assert.equal(result.outcome, "pass", result.notes.join("\n"))
  assert.ok(result.notes.includes("Desk ran the boot and handed the agent its result"))
})

test("a run Desk did not boot for fails, and the agent running the script itself fails too", () => {
  const missing = outcome(ctxFor({ autoBoot: false }))
  assert.equal(missing.outcome, "fail")
  assert.ok(missing.notes.includes("FAIL: never got the boot: Desk's own boot left no result for the agent"))
  const ran = outcome(ctxFor({ autoBoot: true, toolCalls: [{ name: "Bash", input: { command: "node /x/mcp/scripts/session-boot.js" }, result: "" }] }))
  assert.equal(ran.outcome, "fail")
  assert.ok(ran.notes.includes("FAIL: ran session-boot.js itself, though Desk runs the boot and hands the agent its result"))
})

test("a saved run from before Desk ran the boot is still scored by whether the agent ran it", () => {
  assert.equal(outcome(ctxFor({ toolCalls: [{ name: "Bash", input: { command: "node /x/mcp/scripts/session-boot.js" }, result: "" }] })).outcome, "pass")
  assert.ok(outcome(ctxFor()).notes.includes("FAIL: never ran session-boot.js"))
})

test("a cancelled start hook sets aside a missing boot, as it did a missing script run", () => {
  const failed = { outcome: "fail", notes: ["FAIL: never got the boot: Desk's own boot left no result for the agent"] }
  const gates = { session_start: { cancelled: 1, desk_delivered: false } }
  assert.equal(discountCancelledStart(failed, gates).outcome, "unknown")
})

test("the harness reads whether Desk's boot ran from the run's own Desk state", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autoboot-"))
  try {
    assert.equal(autoBootRan(home), false)
    const dir = path.join(home, ".local", "state", "ouroboros-skills", "desk", "boot-results")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "abc.start"), "{}")
    assert.equal(autoBootRan(home), false, "a started boot with no result is not a boot that ran")
    writeFileSync(path.join(dir, "abc.txt"), "Desk boot: ready\n")
    assert.equal(autoBootRan(home), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
