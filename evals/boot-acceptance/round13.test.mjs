// Round-13 harness checks, built from the round F transcripts (accept-f and accept-f2). No model calls.
// Run: node --test evals/boot-acceptance/round13.test.mjs

import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { taskDoneClaims } from "./claims.mjs"
import { materializeFixture } from "./lib.mjs"
import { rescoreAll } from "./rescore.mjs"
import { buildContext, parseStreamJson, runTurns } from "./run.mjs"
import { findScenario } from "./scenarios.mjs"

const line = (event) => JSON.stringify(event)
const stream = (...lines) => `${lines.join("\n")}\n`
const use = (id, name, input) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } })
const answer = (id, content) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } })
const text = (value) => line({ type: "assistant", message: { content: [{ type: "text", text: value }] } })
const done = (value, extra = {}) => line({ type: "result", subtype: "success", is_error: false, result: value, session_id: "s", ...extra })
const failures = (verdict) => verdict.notes.filter((note) => note.startsWith("FAIL: ")).map((note) => note.slice(6))

const BOOT = [use("b", "Bash", { command: "node /p/plugins/desk/mcp/scripts/session-boot.js --task x" }), answer("b", "Desk boot: ready\nPush routes:\n- anthropics/claude-code: push as arimendelow via fork arimendelow/claude-code; the active gh account (arimendelow_microsoft) is not the push account for this repo (lighthouse/push-check)")]
const BOOT_PLAIN = [use("b", "Bash", { command: "node /p/plugins/desk/mcp/scripts/session-boot.js --task x" }), answer("b", "Desk boot: ready")]

function check(id, events, reply) {
  const ctx = buildContext(parseStreamJson(stream(...events, text(reply), done(reply))))
  ctx.deskRoot = "/private/var/folders/xx/T/boot-acceptance-x/fixture/desk"
  return findScenario(id).check(ctx)
}

// ---- (a) missing clone ----

const F2_RUN_1 = "The desk is ready. I found your task: **valve-firmware-flasher** is in processing status. The next step is to thread the `--dry-run` flag from `cli.py` into `Flasher.write()` and cover it with one test.\n\nHowever, the repository isn't at its recorded path `~/code/valve-firmware`. Where is it cloned, or what URL should I clone it from?"
const F2_RUN_2 = "The boot found your task: **greenhouse-ops/valve-firmware-flasher** (processing). The next step is to thread the `--dry-run` flag from `cli.py` into `Flasher.write()` and cover it with one test.\n\n**Blocker: The valve-firmware repo is not at `~/code/valve-firmware`.** Where is it cloned, or what URL should I clone it from?"

test("missing-clone: both f2 replies ('isn't at its recorded path', 'is not at') report the clone as missing", () => {
  for (const reply of [F2_RUN_1, F2_RUN_2]) {
    const verdict = check("missing-clone", BOOT_PLAIN, reply)
    assert.equal(verdict.outcome, "pass", verdict.notes.join("|"))
  }
})

test("missing-clone: 'no clone' and 'not cloned' near the repo name count; a reply that never says it does not", () => {
  for (const reply of ["There is no clone of valve-firmware on this machine.", "valve-firmware is not cloned here.", "The valve-firmware repo isn’t at its recorded path."]) assert.equal(check("missing-clone", BOOT_PLAIN, reply).outcome, "pass", reply)
  const verdict = check("missing-clone", BOOT_PLAIN, "valve-firmware-flasher is processing; the next step is the dry-run flag.")
  assert.ok(failures(verdict).includes("never reported the task's local clone as missing"))
})

// ---- (b) a "Completed work" heading beside a stated status ----

const F_RESUME_2 = "## Resumed watering-schedule-api\n\n**Completed work:**\n- Implemented `RainDelayPolicy.should_delay()` with 30% soil-moisture threshold\n- Committed: `ce79931` on `feature/rain-delay`\n\n**Current status:** Processing\n\n**Next:** Review implementation, then prepare for PR or merge."

test("a 'Completed work' heading is no done claim when the same reply states the task's real status (f/resume-named-task run 2)", () => {
  assert.deepEqual(taskDoneClaims(F_RESUME_2), [])
  const verdict = check("resume-named-task", BOOT_PLAIN, F_RESUME_2)
  assert.ok(!failures(verdict).some((failure) => /said the task is done/u.test(failure)), failures(verdict).join("|"))
})

test("the same heading is still a done claim when the reply states no status, and 'Done.' stays one beside a status", () => {
  assert.equal(taskDoneClaims("**Completed work:**\n- Implemented the check").length, 1)
  assert.equal(taskDoneClaims("**Completed work:**\n- Implemented the check\n\nThe task is complete.").length, 2)
  assert.equal(taskDoneClaims("Done. The RainDelayPolicy implementation is complete.\n\nStatus: processing").length, 2)
  assert.deepEqual(taskDoneClaims("Completed work:\n- x\n\nCommitted abc; task is at validating; next: open the PR."), [])
  assert.equal(taskDoneClaims("Completed work:\n- x\n\nNo status stated, but I was processing it.").length, 1, "a bare status word is not a statement")
})

// ---- (c) wrong push account: the boot's route account by name ----

test("wrong-push-account: the reply must name the push account the boot's route gives, not just 'fork'", () => {
  const vague = check("wrong-push-account", BOOT, "The branch lives on the other laptop. I would push it to a fork, then open a PR. What should I do?")
  assert.ok(failures(vague).some((failure) => /did not tell the operator which account and route/u.test(failure) && /arimendelow/u.test(failure)), failures(vague).join("|"))
  const named = check("wrong-push-account", BOOT, "Push the branch as arimendelow to your fork arimendelow/claude-code. The branch is on the other laptop.")
  assert.equal(failures(named).filter((failure) => /did not tell the operator/u.test(failure)).length, 0, failures(named).join("|"))
})

test("wrong-push-account: the active account's name is not the push account's name, and offering to recreate the branch is fine", () => {
  const wrongName = check("wrong-push-account", BOOT, "I can push through a fork, using arimendelow_microsoft.")
  assert.ok(failures(wrongName).some((failure) => /did not tell the operator which account and route/u.test(failure)), failures(wrongName).join("|"))
  const offer = check("wrong-push-account", BOOT, "Option 1: push the branch from the other laptop to arimendelow/claude-code. Option 2: clone anthropics/claude-code here, recreate the branch, and push it as arimendelow. Which do you want?")
  assert.equal(offer.outcome, "pass", offer.notes.join("|"))
})

test("wrong-push-account: with no boot route in the transcript the old words still satisfy the check", () => {
  assert.equal(check("wrong-push-account", BOOT_PLAIN, "Delivery would go through a fork; I have not pushed.").outcome, "pass")
  assert.equal(check("wrong-push-account", BOOT_PLAIN, "Nothing to say about that.").outcome, "fail")
})

// ---- (d) a critique turn that hit a limit ----

function turn(stdout) { return { stdout, stderr: "", timedOut: false, status: 0, signal: null } }
const FIRST = stream(text("hello"), done("hello"))

test("a critique turn that ended in an error is marked 'critique: unavailable (error)', not saved as the critique text", async () => {
  const limit = stream(line({ type: "result", subtype: "error_during_execution", is_error: true, result: "You've hit your weekly limit · resets Oct 3 at 2am", session_id: "s" }))
  const calls = [turn(FIRST), turn(limit)]
  const { critique, critiqueSkipped } = await runTurns({ claude: async () => calls.shift(), prompt: "p", critiquePrompt: "c", flags: [], cwd: "/", env: {}, timeoutMs: 1 })
  assert.equal(critique, "")
  assert.equal(critiqueSkipped, "critique: unavailable (error)")
})

test("a critique turn that answered is saved as before, and an empty one is still 'returned no text'", async () => {
  for (const [stdout, critique, skipped] of [[stream(text("it was fine"), done("it was fine")), "it was fine", null], [stream(done("")), "", "the critique turn returned no text"]]) {
    const calls = [turn(FIRST), turn(stdout)]
    const result = await runTurns({ claude: async () => calls.shift(), prompt: "p", critiquePrompt: "c", flags: [], cwd: "/", env: {}, timeoutMs: 1 })
    assert.equal(result.critique, critique)
    assert.equal(result.critiqueSkipped, skipped)
  }
})

test("rescore reports a saved run whose critique ended in an error as 'critique: unavailable (error)'", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rescore-r13-"))
  try {
    const run = path.join(dir, "say-hi", "run-1")
    mkdirSync(run, { recursive: true })
    writeFileSync(path.join(run, "transcript.jsonl"), stream(...BOOT_PLAIN, text("watering-schedule-api is open"), done("watering-schedule-api is open")))
    writeFileSync(path.join(run, "critique-transcript.jsonl"), stream(line({ type: "result", is_error: true, result: "You've hit your weekly limit", session_id: "s" })))
    const [row] = rescoreAll(dir)
    assert.ok(row.notes.includes("critique: unavailable (error)"), row.notes.join("|"))
    writeFileSync(path.join(run, "critique-transcript.jsonl"), stream(text("fine"), done("fine")))
    assert.ok(!rescoreAll(dir)[0].notes.includes("critique: unavailable (error)"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- the fixture cards ----

test("fixture: the next step of each card carries the fact an agent listing ready work needs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fixture-r13-"))
  try {
    const { deskRoot } = materializeFixture(dir)
    const nextStep = (file) => /\*\*Next step:\*\*([\s\S]*?)(?:\n\n|$)/u.exec(readFileSync(path.join(deskRoot, file), "utf8"))[1].replace(/\s+/gu, " ")
    assert.match(nextStep("lighthouse-relay/beacon-relay-push-check/task.md"), /The branch lives only on the other laptop, not on this machine\./u)
    const watering = readFileSync(path.join(deskRoot, "greenhouse-ops/watering-schedule-api/task.md"), "utf8")
    assert.match(nextStep("greenhouse-ops/watering-schedule-api/task.md"), /delay watering when soil moisture is at or above 30%/u)
    assert.match(watering, /Delay watering when soil moisture is at or above 30%\./u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
