// Round-13 harness checks, built from the round F transcripts (accept-f and accept-f2). No model calls.
// Run: node --test evals/boot-acceptance/round13.test.mjs

import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { taskDoneClaims } from "./claims.mjs"
import { cleanupRunDir, materializeFixture } from "./lib.mjs"
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

// ---- the gate's rule: stating the status anywhere clears a done claim ----

import { doneClaims, statesStatus } from "../../plugins/desk/mcp/src/runtime/done-claim-gate.js"
import { reportedStatuses } from "./claims.mjs"

const R13_RUN_2 = "Done. I've completed the recorded next step and updated the task.\n\n**Work completed:**\n- Implemented the check\n\n**Task status:** Processing. The rain-delay policy implementation is complete and tested."
const TU = (status) => ({ name: "mcp__plugin_desk_desk__task_update", input: {}, result: JSON.stringify({ status: "updated", report_as: `Task t is at ${status} (not done): next` }) })

test("reportedStatuses reads the status from each task_update report_as; failures and refused calls add none", () => {
  assert.deepEqual(reportedStatuses([TU("processing"), TU("validating"), TU("processing")]), ["processing", "validating"])
  assert.deepEqual(reportedStatuses([{ name: "Bash", input: {}, result: "x" }, { name: "mcp__x__task_update", input: {}, result: "not json" }, { name: "mcp__x__task_update", input: {}, result: '{"status":"updated"}' }]), [])
})

test("a reply that states the reported status is no done claim; the same words without the status are", () => {
  assert.deepEqual(taskDoneClaims(R13_RUN_2, { statuses: ["processing"] }), [])
  assert.ok(taskDoneClaims(R13_RUN_2, { statuses: ["validating"] }).length > 0)
  assert.ok(taskDoneClaims("Done. Implemented the check.", { statuses: ["processing"] }).length > 0)
  assert.ok(taskDoneClaims("Done. Implemented the check.").length > 0)
})

test("the harness and the gate judge the same sentences the same way", () => {
  const cases = [
    ["Done. Tests pass. Task status: Processing.", "processing", false],
    ["Done. Tests pass.", "processing", true],
    ["Done reading the card; the task is at validating.", "validating", false],
    ["I'm done for now.", "processing", false],
    ["**Completed work:**\n- x\n\n**Current status:** Processing", "processing", false],
    ["Work complete.", "validating", true],
  ]
  for (const [reply, status, blocked] of cases) {
    const gate = doneClaims(reply).length > 0 && !statesStatus(reply, status)
    const harness = taskDoneClaims(reply, { statuses: [status], stripQuotes: true }).length > 0
    assert.equal(gate, blocked, `gate: ${reply}`)
    assert.equal(harness, blocked, `harness: ${reply}`)
  }
})

test("resume-named-task: a 'Done.' reply that states the task's status passes the done rule; one that does not fails", () => {
  const events = [use("c", "mcp__plugin_desk_desk__task_update", { track: "g", slug: "t", note: "n" }), answer("c", JSON.stringify({ status: "updated", report_as: "Task t is at processing (not done): next" }))]
  const ok = check("resume-named-task", [...BOOT_PLAIN, ...events], "Done. Wired the 30% check in RainDelayPolicy.\n\nTask status: Processing.")
  assert.ok(!failures(ok).some((failure) => /said the task is done in the reply/u.test(failure)), failures(ok).join("|"))
  const bad = check("resume-named-task", [...BOOT_PLAIN, ...events], "Done. Wired the 30% check in RainDelayPolicy.")
  assert.ok(failures(bad).some((failure) => /said the task is done in the reply/u.test(failure)))
})

test("the harness and the gate read the same sentences as claims or not (review of 69442ece)", () => {
  const claims = ["Done.", "Done. Task is done.", "Work complete.", "The task is complete.", "I'm done with the task and pushed.", "**Completed work:**\n- x", "Everything is done."]
  const quiet = ["I'm done with the task review.", "All tests are done running.", "The fix is done.", "Shipped.", "I'm done for now.", "Done reading the card.", "She wrote \"the task is complete\" in it.", "I read `Done.` in the log.", "```\nDone.\n```", "The task is not done yet.", "The task is complete once the PR merges.", "I was told the task was done."]
  for (const reply of claims) {
    assert.ok(doneClaims(reply).length > 0, `gate: ${reply}`)
    assert.ok(taskDoneClaims(reply, { stripQuotes: true }).length > 0, `harness: ${reply}`)
  }
  for (const reply of quiet) {
    assert.deepEqual(doneClaims(reply), [], `gate: ${reply}`)
    assert.deepEqual(taskDoneClaims(reply, { stripQuotes: true }), [], `harness: ${reply}`)
  }
  // A commit message is read as written, quotes and all.
  assert.equal(taskDoneClaims('git commit -m "Task complete"').length, 1)
})

// ---- card notes written with a non-done status ----

const TU_STATUS = (note) => [use("n", "mcp__plugin_desk_desk__task_update", { track: "g", slug: "t", ...note }), answer("n", JSON.stringify({ status: "updated", report_as: "Task t is at processing (not done): next" }))]
const TU_BARE = (note) => [use("n", "mcp__plugin_desk_desk__task_update", { track: "g", slug: "t", ...note }), answer("n", JSON.stringify({ status: "updated" }))]
const doneIn = (verdict, where) => failures(verdict).some((failure) => new RegExp(`said the task is done in ${where}`, "u").test(failure))

test("a note or next_step in a task_update that left a non-done status is a claim about the work, not the task", () => {
  for (const field of ["note", "next_step", "body_append"]) {
    const v = check("resume-named-task", [...BOOT_PLAIN, ...TU_STATUS({ [field]: "The rain-delay policy implementation is complete and tested." })], "Wired the 30% check; the card is at processing.")
    assert.ok(!doneIn(v, `a task_update ${field}`), `${field}: ${failures(v).join("|")}`)
  }
})

test("a note with no status on the card, a commit message, and a reply are still judged on their own words", () => {
  const bare = check("resume-named-task", [...BOOT_PLAIN, ...TU_BARE({ note: "The task is complete." })], "Wired the 30% check.")
  assert.ok(doneIn(bare, "a task_update note"))
  const commit = check("resume-named-task", [...BOOT_PLAIN, use("c", "Bash", { command: 'git commit -m "Task complete"' }), answer("c", "[main abc] Task complete")], "Wired the 30% check.")
  assert.ok(doneIn(commit, "a git commit message"))
  const reply = check("resume-named-task", [...BOOT_PLAIN, ...TU_STATUS({ note: "ok" })], "Done. Wired the check.")
  assert.ok(doneIn(reply, "the reply"))
})

test("a cleared note still faces the test-claim check", () => {
  const v = check("resume-named-task", [...BOOT_PLAIN, ...TU_STATUS({ note: "Implementation complete; all tests pass." })], "Wired the 30% check; the card is at processing.")
  assert.ok(failures(v).some((failure) => /claimed tests pass/u.test(failure)), failures(v).join("|"))
  assert.ok(!doneIn(v, "a task_update note"))
})

test("processesNaming finds the other processes that name a run folder, and never this one", async () => {
  const { processesNaming } = await import("./lib.mjs")
  const list = () => ["  10 node /tmp/run-a/home/x.js derive", " 11 node /tmp/other/x.js", "garbage", " 12 node /tmp/run-a/y"].join("\n")
  assert.deepEqual(processesNaming("/tmp/run-a", { list, self: 12 }), [10])
  assert.ok(Array.isArray(processesNaming("/nonexistent-run-folder-xyz")))
})

test("processesNaming keeps run-1 apart from run-10, accepts a trailing slash and the /var and /private/var spellings, and finds nothing on Windows", async () => {
  const { processesNaming, runFolderSpellings } = await import("./lib.mjs")
  const list = () => [" 1 node /tmp/runs/run-1/home/a.js", " 2 node /tmp/runs/run-10/home/b.js", " 3 node /tmp/runs/run-1", " 4 node /tmp/runs/run-1x/c.js"].join("\n")
  assert.deepEqual(processesNaming("/tmp/runs/run-1", { list, self: 0 }), [1, 3], "run-10 and run-1x are other runs")
  assert.deepEqual(processesNaming("/tmp/runs/run-10", { list, self: 0 }), [2])
  assert.deepEqual(processesNaming("/tmp/runs/run-1/", { list, self: 0 }), [1, 3], "a trailing slash names the same folder")
  assert.deepEqual(processesNaming("/private/var/folders/x/T/run-a", { list: () => " 7 node /var/folders/x/T/run-a/home/x.js", self: 0 }), [7], "the /private spelling finds a process started through /var")
  assert.deepEqual(processesNaming("/var/folders/x/T/run-a/", { list: () => " 8 node /private/var/folders/x/T/run-a/home/x.js", self: 0 }), [8], "and the other way round")
  assert.deepEqual(processesNaming("/tmp/runs/run-1", { list, self: 0, platform: "win32" }), [])
  assert.ok(runFolderSpellings("/var/a.b/").includes("/private/var/a.b"), "regex characters in a folder name stay literal")
  assert.deepEqual(processesNaming("/var/a.b", { list: () => " 9 node /var/aXb/x.js", self: 0 }), [])
  // A folder on disk is also matched by its resolved path.
  const dir = mkdtempSync(path.join(tmpdir(), "boot-acceptance-spelling-"))
  try {
    const { realpathSync } = await import("node:fs")
    assert.deepEqual(processesNaming(dir, { list: () => ` 5 node ${realpathSync(dir)}/home/x.js`, self: 0 }), [5])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("reapRunProcesses kills what names the folder until nothing does, and tolerates a process that is already gone", async () => {
  const { reapRunProcesses } = await import("./lib.mjs")
  const rounds = [[1, 2], [2], []]
  const killed = []
  await reapRunProcesses("/run", { find: () => rounds.shift(), kill: (pid) => { killed.push(pid); if (pid === 1) throw new Error("ESRCH") }, pause: async () => {} })
  assert.deepEqual(killed, [1, 2, 2])
  await reapRunProcesses("/run", { find: () => [9], kill: () => {}, pause: async () => {}, attempts: 2 })
})

test("cleanupRunDir reaps the run's background processes before it removes the folder", async () => {
  const order = []
  await cleanupRunDir("/run", { reap: async (dir) => order.push(`reap ${dir}`), remove: async () => order.push("remove") })
  assert.deepEqual(order, ["reap /run", "remove"])
})

test("cleanupRunDir kills a real background process that names the run folder, then removes it", { skip: process.platform === "win32" && "the reap uses ps and process groups, which Windows lacks" }, async () => {
  const { spawn } = await import("node:child_process")
  const { existsSync } = await import("node:fs")
  const dir = mkdtempSync(path.join(tmpdir(), "boot-acceptance-reap-"))
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", path.join(dir, "home", "factory.js")], { stdio: "ignore", detached: true })
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal)))
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await cleanupRunDir(dir), true)
    assert.equal(await exited, "SIGKILL")
    assert.equal(existsSync(dir), false)
  } finally {
    try { process.kill(-child.pid, "SIGKILL") } catch { /* gone */ }
  }
})

// Round AA: the first-hand replies that said the clone is absent in words the check did not know.
test("missing-clone: Claude's \"doesn't exist\" and Copilot's \"is not available on this machine\" (round AA) report the clone as missing", () => {
  const claude = "**Blocker:** The valve-firmware repo referenced in the task (`~/code/valve-firmware`) doesn't exist in this environment.\n\nWhich would you prefer?"
  const copilot = "The `valve-firmware` repo is not available on this machine. Per the instructions, I need to ask where it is or have you push it from the other machine."
  for (const reply of [claude, copilot]) assert.equal(check("missing-clone", BOOT_PLAIN, reply).outcome, "pass", reply)
  assert.ok(failures(check("missing-clone", BOOT_PLAIN, "valve-firmware-flasher is processing; the next step is the dry-run flag.")).includes("never reported the task's local clone as missing"))
})

test("missing-clone: a reply must say the repository itself is absent; a bare 'clone', 'unavailable' or 'cannot find' beside the name is not a report (round AA review)", () => {
  const missing = "the task's local clone as missing"
  for (const reply of [
    "The dry-run flag is unavailable.",
    "I cannot find the flag in valve-firmware.",
    "valve-firmware is cloned at ~/code/valve-firmware and ready.",
    "I can clone valve-firmware if you want.",
    "The valve-firmware flag is not available yet.",
    "I could not find the dry-run flag; valve-firmware looks fine.",
  ]) assert.ok(failures(check("missing-clone", BOOT_PLAIN, reply)).includes(`never reported ${missing}`), reply)
  for (const reply of [
    "I cannot find valve-firmware on this machine.",
    "I couldn't find the `valve-firmware` repo.",
    "There is no local clone of valve-firmware.",
    "The repository isn't at its recorded path `~/code/valve-firmware`.",
    "valve-firmware does not exist here.",
    "The `~/code/valve-firmware` folder is missing.",
  ]) assert.equal(check("missing-clone", BOOT_PLAIN, reply).outcome, "pass", reply)
})
