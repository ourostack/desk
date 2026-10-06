// The sign-off witness: prompt and stop records, the Claude Code ticket, the Copilot session read and the verdict. A sign-off counts as a human's only when every record agrees; anything the witness cannot see is unverified with a reason code.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { assertActionable } from "./_guard_text.js"
import {
  MAIN_AGENT_WAIT_MS,
  PROMPT_SKEW_MS,
  TICKET_DIR,
  TICKET_TTL_MS,
  WITNESS_DIR,
  WITNESS_REASONS,
  copilotLastPromptIsHuman,
  issueTicket,
  lastHumanPrompt,
  recordPrompt,
  recordStop,
  ticketFile,
  witnessFile,
  witnessFor,
  witnessVerdict,
} from "../../../../../plugins/desk/mcp/src/runtime/signoff-witness.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "signoff-witness.cjs")
const ROOT = mkdtempSync(path.join(tmpdir(), "signoff-witness-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const fresh = (name) => path.join(ROOT, `${name}-${(counter += 1)}`)

const T0 = Date.parse("2026-10-05T10:00:00.000Z")
const iso = (ms) => new Date(ms).toISOString()
const SENTINEL = "SENTINEL-secret-text-9f3a"

// ---- transcript lines as the host writes them (shapes from the structure probe) ----
const human = (at, extra = {}) => ({ type: "user", timestamp: iso(at), promptSource: "typed", turnOrigin: "human", origin: { kind: "human" }, message: { role: "user", content: "please look" }, ...extra })
const notification = (at) => ({ type: "user", timestamp: iso(at), promptSource: "system", turnOrigin: "task_notification", origin: { kind: "task-notification" }, message: { role: "user", content: "a background task ended" } })
const peer = (at) => ({ type: "user", timestamp: iso(at), isMeta: true, promptSource: "system", turnOrigin: "peer", origin: { kind: "peer" }, message: { role: "user", content: "a message from another session" } })
// A scheduled wake-up as the host writes it: a meta line, marked system, with a scheduled turn origin, a scheduled id and no origin.
const scheduledWake = (at, extra = {}) => ({ type: "user", timestamp: iso(at), isMeta: true, promptSource: "system", turnOrigin: "scheduled", scheduledTaskId: "task-1", message: { role: "user", content: "wake up" }, ...extra })
const hookOutput = (at, extra = {}) => ({ type: "user", timestamp: iso(at), isMeta: true, message: { role: "user", content: "hook output" }, ...extra })
const toolResult = (at) => ({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } })
const interrupt = (at) => ({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })
const headless = (at) => ({ type: "user", timestamp: iso(at), promptSource: "sdk", turnOrigin: "sdk", message: { role: "user", content: "run this" } })
const assistant = (at) => ({ type: "assistant", timestamp: iso(at), message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })

function transcript(...lines) {
  const file = fresh("t") + ".jsonl"
  writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n")
  return file
}

// The call's own line in the root transcript, which is the proof that the main agent made it; tests that do not look at the wait use an instant clock.
const CALL_ID = "toolu_signoff_1"
const callLine = (at, id = CALL_ID, extra = {}) => ({ type: "assistant", timestamp: iso(at), message: { role: "assistant", content: [{ type: "text", text: "recording it" }, { type: "tool_use", id, name: "mcp__desk__task_signoff", input: { note: "x" } }] }, ...extra })
const callTranscript = (...lines) => transcript(...lines, callLine(T0 + 50_000))
let fakeNow = 0
const FAST = { clock: () => fakeNow, sleep: (ms) => { fakeNow += ms } }

// The server runs inside Claude Code: the mark the host sets in its environment.
const CLAUDE_ENV = { CLAUDECODE: "1" }
const TASK = { track: "greenhouse-ops", slug: "watering-api", outcome: "accepted" }
const signoffCall = (stateDir, file, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: "s1", transcript_path: file, tool_name: "mcp__desk__task_signoff", tool_use_id: CALL_ID, tool_input: { ...TASK }, ...extra })

/**
 * One sign-off, played in time order: the prompt hook ran at `promptHookAt`, the stop hook at each of `stops`, the transcript holds `lines`, the call came at `callAt`, and the work was delivered at `deliveredAt`.
 */
function signoff({ lines, promptHookAt, stops = [], callAt = T0 + 60_000, deliveredAt, extra = {} }) {
  const stateDir = fresh("state")
  const events = [...stops.map((at) => ["stop", at]), ...(promptHookAt === undefined ? [] : [["prompt", promptHookAt]])].sort((a, b) => a[1] - b[1])
  for (const [kind, at] of events) (kind === "stop" ? recordStop : recordPrompt)({ session_id: "s1" }, { stateDir, now: () => at })
  const file = callTranscript(...lines)
  const output = issueTicket(signoffCall(stateDir, file, extra), { ...FAST, stateDir, now: () => callAt })
  const witness = witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => callAt + 1000 })
  return { output, witness, stateDir, verdict: witnessVerdict({ ...(witness ?? {}), deliveredAt }) }
}

// ---- the verdict ----

const CLEAN = { promptAt: 100, stopAt: 50, deliveredAt: 60, mainAgent: true, humanOrigin: true }

test("a prompt then a sign-off call in a later turn than the delivery is witnessed", () => {
  assert.deepEqual(witnessVerdict(CLEAN), { verified: true, why: "witnessed" })
  assert.deepEqual(witnessVerdict({ ...CLEAN, stopAt: undefined, deliveredAt: undefined }), { verified: true, why: "witnessed" })
  assert.deepEqual(witnessVerdict({ ...CLEAN, stopAt: null, deliveredAt: null }), { verified: true, why: "witnessed" })
})

test("the closed list of reasons is exported", () => {
  assert.deepEqual(WITNESS_REASONS, ["witnessed", "no_witness", "subagent", "subagent_not_ruled_out", "not_human_origin", "human_origin_unknown", "no_prompt_since_stop", "same_turn_as_delivery"])
})

test("a sign-off in the turn that delivered the work is unverified as same_turn_as_delivery", () => {
  assert.deepEqual(witnessVerdict({ ...CLEAN, deliveredAt: 100 }), { verified: false, why: "same_turn_as_delivery" })
  assert.deepEqual(witnessVerdict({ ...CLEAN, deliveredAt: 150 }), { verified: false, why: "same_turn_as_delivery" })
})

test("a sign-off with no prompt since the last stop is unverified as no_prompt_since_stop", () => {
  assert.deepEqual(witnessVerdict({ ...CLEAN, stopAt: 100 }), { verified: false, why: "no_prompt_since_stop" })
  assert.deepEqual(witnessVerdict({ ...CLEAN, stopAt: 200 }), { verified: false, why: "no_prompt_since_stop" })
  assert.deepEqual(witnessVerdict({ ...CLEAN, stopAt: "soon" }), { verified: false, why: "no_prompt_since_stop" })
})

test("a turn started by a line that is not human-origin is unverified as not_human_origin", () => {
  assert.deepEqual(witnessVerdict({ ...CLEAN, humanOrigin: false }), { verified: false, why: "not_human_origin" })
})

test("an origin that is unknown is unverified as human_origin_unknown, and anything but exactly true is not human", () => {
  for (const humanOrigin of [null, undefined, "yes", 1]) assert.deepEqual(witnessVerdict({ ...CLEAN, humanOrigin }), { verified: false, why: "human_origin_unknown" })
})

test("a subagent is unverified as subagent, and a main agent that is not proven is subagent_not_ruled_out", () => {
  assert.deepEqual(witnessVerdict({ ...CLEAN, mainAgent: false }), { verified: false, why: "subagent" })
  for (const mainAgent of [null, undefined, "true", 1]) assert.deepEqual(witnessVerdict({ ...CLEAN, mainAgent }), { verified: false, why: "subagent_not_ruled_out" })
})

test("with no witness file the verdict is unverified as no_witness", () => {
  assert.deepEqual(witnessVerdict(null), { verified: false, why: "no_witness" })
  assert.deepEqual(witnessVerdict(undefined), { verified: false, why: "no_witness" })
  assert.deepEqual(witnessVerdict({}), { verified: false, why: "no_witness" })
  for (const promptAt of [null, undefined, NaN, Infinity, "100"]) assert.deepEqual(witnessVerdict({ ...CLEAN, promptAt }), { verified: false, why: "no_witness" })
})

test("the reasons apply in the order no_witness, subagent, subagent_not_ruled_out, not_human_origin, human_origin_unknown, no_prompt_since_stop, same_turn_as_delivery", () => {
  const worst = { promptAt: 100, stopAt: 200, deliveredAt: 300, mainAgent: false, humanOrigin: false }
  assert.equal(witnessVerdict({ ...worst, promptAt: null }).why, "no_witness")
  assert.equal(witnessVerdict(worst).why, "subagent")
  assert.equal(witnessVerdict({ ...worst, mainAgent: null }).why, "subagent_not_ruled_out")
  assert.equal(witnessVerdict({ ...worst, mainAgent: true }).why, "not_human_origin")
  assert.equal(witnessVerdict({ ...worst, mainAgent: true, humanOrigin: null }).why, "human_origin_unknown")
  assert.equal(witnessVerdict({ ...worst, mainAgent: true, humanOrigin: true }).why, "no_prompt_since_stop")
  assert.equal(witnessVerdict({ ...worst, mainAgent: true, humanOrigin: true, stopAt: 50 }).why, "same_turn_as_delivery")
})

// ---- the records ----

test("the prompt hook sets prompt_at and the stop hook sets stop_at, each keeping the other", () => {
  const stateDir = fresh("state")
  assert.deepEqual(recordPrompt({ session_id: "s1" }, { stateDir, now: () => 100 }), {})
  assert.deepEqual(JSON.parse(readFileSync(witnessFile(stateDir, "s1"), "utf8")), { prompt_at: 100, stop_at: null })
  assert.deepEqual(recordStop({ hook_event_name: "Stop", session_id: "s1" }, { stateDir, now: () => 200 }), {})
  assert.deepEqual(JSON.parse(readFileSync(witnessFile(stateDir, "s1"), "utf8")), { prompt_at: 100, stop_at: 200 })
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => 300 })
  assert.deepEqual(JSON.parse(readFileSync(witnessFile(stateDir, "s1"), "utf8")), { prompt_at: 300, stop_at: 200 })
  assert.equal(statSync(witnessFile(stateDir, "s1")).mode & 0o777, 0o600)
})

test("a stop recorded before any prompt leaves prompt_at empty", () => {
  const stateDir = fresh("state")
  recordStop({ session_id: "s1" }, { stateDir, now: () => 200 })
  assert.deepEqual(JSON.parse(readFileSync(witnessFile(stateDir, "s1"), "utf8")), { prompt_at: null, stop_at: 200 })
})

test("a corrupt session file is replaced by the next record", () => {
  const stateDir = fresh("state")
  mkdirSync(path.dirname(witnessFile(stateDir, "s1")), { recursive: true })
  writeFileSync(witnessFile(stateDir, "s1"), "{not json")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => 100 })
  assert.deepEqual(JSON.parse(readFileSync(witnessFile(stateDir, "s1"), "utf8")), { prompt_at: 100, stop_at: null })
  writeFileSync(witnessFile(stateDir, "s1"), "[1]")
  recordStop({ session_id: "s1" }, { stateDir, now: () => 200 })
  assert.deepEqual(JSON.parse(readFileSync(witnessFile(stateDir, "s1"), "utf8")), { prompt_at: null, stop_at: 200 })
})

test("a subagent's stop does not move stop_at", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => 100 })
  recordStop({ hook_event_name: "SubagentStop", session_id: "s1" }, { stateDir, now: () => 200 })
  recordStop({ hook_event_name: "Stop", session_id: "s1", agent_id: "agent-1" }, { stateDir, now: () => 300 })
  assert.deepEqual(JSON.parse(readFileSync(witnessFile(stateDir, "s1"), "utf8")), { prompt_at: 100, stop_at: null })
})

test("a payload with no session id records nothing, and a refused state folder never throws", () => {
  const stateDir = fresh("state")
  for (const payload of [{}, { session_id: "" }, null, undefined]) {
    assert.deepEqual(recordPrompt(payload, { stateDir }), {})
    assert.deepEqual(recordStop(payload, { stateDir }), {})
  }
  assert.equal(existsSync(stateDir), false)
  // A write into the real state folder is refused by the test guard; the hook still answers {}.
  assert.deepEqual(recordPrompt({ session_id: "s1" }, { stateDir: "/var/nonexistent-real-state/desk" }), {})
})

test("old witness and ticket files are pruned when a new one is written", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "old" }, { stateDir, now: () => T0 })
  const oldFile = witnessFile(stateDir, "old")
  const past = (T0 - 10 * 24 * 60 * 60 * 1000) / 1000
  utimesSync(oldFile, past, past)
  // An old entry that cannot be removed (a folder) is skipped, not fatal.
  const stray = path.join(path.dirname(oldFile), "stray")
  mkdirSync(stray)
  utimesSync(stray, past, past)
  recordPrompt({ session_id: "new" }, { stateDir, now: () => T0 })
  assert.equal(existsSync(oldFile), false)
  assert.equal(existsSync(stray), true)
  assert.equal(existsSync(witnessFile(stateDir, "new")), true)
})

// ---- the transcript read ----

test("the last prompt-like root line is read for its origin and its own time", () => {
  assert.deepEqual(lastHumanPrompt(transcript(human(T0 - 5000), assistant(T0 - 4000), human(T0))), { human: true, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { promptSource: "queued" }))), { human: true, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { promptSource: "suggestion_accepted", message: { role: "user", content: [{ type: "text", text: "yes" }] } }))), { human: true, at: T0 })
})

test("hook output, a tool result and a subagent line are never the human line", () => {
  const sidechain = human(T0 + 4000, { isSidechain: true })
  const compact = human(T0 + 5000, { isCompactSummary: true })
  const lines = [human(T0), hookOutput(T0 + 1000), toolResult(T0 + 2000), assistant(T0 + 3000), sidechain, compact]
  assert.deepEqual(lastHumanPrompt(transcript(...lines)), { human: true, at: T0 })
})

test("a line from another origin is not human, and carries its own time", () => {
  assert.deepEqual(lastHumanPrompt(transcript(human(T0 - 9000), notification(T0))), { human: false, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0 - 9000), human(T0, { origin: { kind: "other-kind" } }))), { human: false, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0 - 9000), human(T0, { origin: undefined, promptSource: "system" }))), { human: false, at: T0 })
  // An origin of human on a line that is not a prompt at all (no content) is not a human prompt either.
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { message: { role: "user", content: [] } }))), { human: false, at: T0 })
})

test("a line with no origin mark, an unreadable file, an empty tail or a time that does not parse is unknown", () => {
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { origin: undefined, turnOrigin: undefined, promptSource: "sdk" }))), { human: null, at: T0 }, "an old-format line with no mark")
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { origin: undefined }))), { human: null, at: T0 }, "turnOrigin human with no origin")
  assert.deepEqual(lastHumanPrompt(transcript(interrupt(T0))), { human: null, at: T0 })
  assert.deepEqual(lastHumanPrompt(path.join(ROOT, "missing.jsonl")), { human: null, at: null })
  assert.deepEqual(lastHumanPrompt(ROOT), { human: null, at: null }, "a folder opens but cannot be read")
  assert.deepEqual(lastHumanPrompt(undefined), { human: null, at: null })
  assert.deepEqual(lastHumanPrompt(""), { human: null, at: null })
  assert.deepEqual(lastHumanPrompt(transcript(assistant(T0), toolResult(T0 + 1000))), { human: null, at: null })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { timestamp: "not a time" }))), { human: null, at: null })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { timestamp: undefined }))), { human: null, at: null })
  assert.deepEqual(lastHumanPrompt(transcript("not json", "[1]", "null")), { human: null, at: null })
})

test("only the tail is read: a line cut by the byte limit is skipped, an older line out of range is not seen", () => {
  const file = transcript(human(T0 - 9000), assistant(T0 - 8000), human(T0))
  const size = statSync(file).size
  const lastLine = JSON.stringify(human(T0)).length + 1
  assert.deepEqual(lastHumanPrompt(file, { maxBytes: lastLine + 5 }), { human: true, at: T0 })
  assert.deepEqual(lastHumanPrompt(file, { maxBytes: size }), { human: true, at: T0 })
  const older = transcript(human(T0 - 9000), { type: "assistant", timestamp: iso(T0), message: { role: "assistant", content: [{ type: "text", text: "x".repeat(400) }] } })
  assert.deepEqual(lastHumanPrompt(older, { maxBytes: 300 }), { human: null, at: null })
})

// ---- the ticket and the threat cases ----

test("a verified turn: a human line, a later hook record, a delivery before the prompt", () => {
  const { witness, verdict, output } = signoff({ lines: [human(T0)], promptHookAt: T0 + 200, deliveredAt: T0 - 60_000 })
  assert.deepEqual(output, {})
  assert.deepEqual(witness, { promptAt: T0, stopAt: null, mainAgent: true, humanOrigin: true })
  assert.deepEqual(verdict, { verified: true, why: "witnessed" })
})

test("the ticket holds the human line's own time, not the hook's clock, and times and booleans only", () => {
  const stateDir = fresh("state")
  recordStop({ session_id: "s1" }, { stateDir, now: () => T0 - 5000 })
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 + 500 })
  issueTicket(signoffCall(stateDir, callTranscript(human(T0))), { ...FAST, stateDir, now: () => T0 + 9000 })
  const ticket = JSON.parse(readFileSync(ticketFile(stateDir, TASK), "utf8"))
  assert.deepEqual(ticket, { issued_at: T0 + 9000, prompt_at: T0, stop_at: T0 - 5000, main_agent: true, human_origin: true })
  assert.equal(statSync(ticketFile(stateDir, TASK)).mode & 0o777, 0o600)
})

test("a sign-off in the turn that delivered the work is unverified as same_turn_as_delivery (full flow)", () => {
  const { verdict } = signoff({ lines: [human(T0)], promptHookAt: T0 + 100, deliveredAt: T0 + 5000 })
  assert.deepEqual(verdict, { verified: false, why: "same_turn_as_delivery" })
})

test("a background-task notification started the turn (origin task-notification): not_human_origin", () => {
  const { verdict } = signoff({ lines: [human(T0 - 120_000), notification(T0)], promptHookAt: T0 + 100, stops: [], deliveredAt: T0 - 200_000 })
  assert.deepEqual(verdict, { verified: false, why: "not_human_origin" })
})

test("a scheduled wake-up started the turn: not_human_origin when the line says so, and no_prompt_since_stop when the stop record is newer", () => {
  assert.deepEqual(signoff({ lines: [human(T0 - 120_000), scheduledWake(T0)], promptHookAt: T0 + 100, deliveredAt: T0 - 200_000 }).verdict, { verified: false, why: "not_human_origin" })
  // The host did not fire the prompt hook for the wake-up: the last human line is old and the stop record is newer than it.
  assert.deepEqual(signoff({ lines: [human(T0 - 120_000)], promptHookAt: T0 - 119_900, stops: [T0 - 100_000], deliveredAt: T0 - 200_000 }).verdict, { verified: false, why: "no_prompt_since_stop" })
})

test("a scheduled wake-up line as observed is the last turn starter and is not human", () => {
  assert.deepEqual(lastHumanPrompt(transcript(human(T0 - 9000), scheduledWake(T0))), { human: false, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0 - 9000), scheduledWake(T0, { scheduledTaskId: undefined, scheduledFireId: "fire-1" }))), { human: false, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0 - 9000), scheduledWake(T0, { scheduledTaskId: undefined, turnOrigin: "system", promptSource: undefined }))), { human: false, at: T0 }, "a meta line with only a turn origin")
  assert.deepEqual(lastHumanPrompt(transcript(human(T0 - 9000), scheduledWake(T0, { scheduledTaskId: undefined, turnOrigin: undefined, promptSource: undefined, origin: { kind: "peer" } }))), { human: false, at: T0 }, "a meta line with only an origin")
})

test("a line marked origin human that also carries a scheduled id is not human", () => {
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { scheduledTaskId: "task-1" }))), { human: false, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { scheduledFireId: "fire-1" }))), { human: false, at: T0 })
  const { verdict } = signoff({ lines: [human(T0, { scheduledTaskId: "task-1" })], promptHookAt: T0 + 100, deliveredAt: T0 - 60_000 })
  assert.deepEqual(verdict, { verified: false, why: "not_human_origin" })
})

test("a line marked origin human with a turn origin of sdk is not human", () => {
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { turnOrigin: "sdk" }))), { human: false, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { turnOrigin: "scheduled" }))), { human: false, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { promptSource: "system" }))), { human: false, at: T0 })
})

test("a turnOrigin human line with no origin is unknown, and a headless prompt is not human", () => {
  assert.deepEqual(lastHumanPrompt(transcript(human(T0, { origin: undefined }))), { human: null, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(headless(T0))), { human: false, at: T0 })
})

test("a plain meta line after a human prompt is skipped and the human prompt stands", () => {
  assert.deepEqual(lastHumanPrompt(transcript(human(T0), hookOutput(T0 + 1000))), { human: true, at: T0 })
  assert.deepEqual(lastHumanPrompt(transcript(human(T0), hookOutput(T0 + 1000, { message: { role: "user", content: [{ type: "text", text: "x" }] } }))), { human: true, at: T0 })
})

test("a message from another session is the last turn starter, so it is not human and the stop record does not decide", () => {
  const rest = signoff({ lines: [human(T0), peer(T0 + 20_000)], promptHookAt: T0 + 100, deliveredAt: T0 - 60_000 })
  assert.deepEqual(rest.witness, { promptAt: T0 + 20_000, stopAt: null, mainAgent: true, humanOrigin: false })
  assert.deepEqual(rest.verdict, { verified: false, why: "not_human_origin" })
})

test("hook output and a tool result line are never the human line (full flow)", () => {
  const { witness } = signoff({ lines: [human(T0), assistant(T0 + 1000), toolResult(T0 + 2000), hookOutput(T0 + 3000)], promptHookAt: T0 + 100 })
  assert.equal(witness.promptAt, T0)
  assert.equal(witness.humanOrigin, true)
})

test("the interrupt marker line gives human_origin_unknown", () => {
  const { verdict, witness } = signoff({ lines: [human(T0 - 100_000), interrupt(T0)], promptHookAt: T0 + 100, deliveredAt: T0 - 200_000 })
  assert.equal(witness.humanOrigin, null)
  assert.deepEqual(verdict, { verified: false, why: "human_origin_unknown" })
})

test("a headless prompt (turnOrigin sdk, promptSource sdk, no origin) is not_human_origin", () => {
  const { verdict } = signoff({ lines: [headless(T0)], promptHookAt: T0 + 100, deliveredAt: T0 - 200_000 })
  assert.deepEqual(verdict, { verified: false, why: "not_human_origin" })
})

test("an unreadable transcript gives human origin unknown, no prompt time and an unverified verdict", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  issueTicket(signoffCall(stateDir, path.join(ROOT, "missing.jsonl")), { ...FAST, stateDir, now: () => T0 + 1000 })
  const witness = witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 2000 })
  assert.deepEqual(witness, { promptAt: null, stopAt: null, mainAgent: null, humanOrigin: null }, "no line time, no fallback to the hook's clock")
  assert.deepEqual(witnessVerdict(witness), { verified: false, why: "no_witness" })
  assert.deepEqual(witnessVerdict({ ...witness, promptAt: T0, mainAgent: true }), { verified: false, why: "human_origin_unknown" })
})

test("the current turn's line is not yet in the transcript: the stop record makes the older human line unverified", () => {
  // The host did not run the prompt hook for the current turn, so the hook's record is still the older turn's.
  const { verdict } = signoff({ lines: [human(T0 - 100_000)], promptHookAt: T0 - 99_900, stops: [T0 - 50_000], deliveredAt: T0 - 200_000 })
  assert.deepEqual(verdict, { verified: false, why: "no_prompt_since_stop" })
})

test("the current turn's line is not yet in the transcript: the 30-second rule makes the older human line unverified", () => {
  assert.equal(PROMPT_SKEW_MS, 30_000)
  const late = signoff({ lines: [human(T0 - 100_000)], promptHookAt: T0, deliveredAt: T0 - 200_000 })
  assert.deepEqual(late.witness, { promptAt: T0 - 100_000, stopAt: null, mainAgent: true, humanOrigin: false })
  assert.deepEqual(late.verdict, { verified: false, why: "not_human_origin" })
  // Exactly at the limit is still the same turn; one millisecond over is not.
  assert.equal(signoff({ lines: [human(T0)], promptHookAt: T0 + PROMPT_SKEW_MS, deliveredAt: T0 - 5000 }).verdict.verified, true)
  assert.equal(signoff({ lines: [human(T0)], promptHookAt: T0 + PROMPT_SKEW_MS + 1, deliveredAt: T0 - 5000 }).verdict.verified, false)
})

test("when the prompt hook did not run the ticket has no prompt time and the verdict is no_witness", () => {
  const { witness, verdict } = signoff({ lines: [human(T0)], deliveredAt: T0 - 5000 })
  assert.deepEqual(witness, { promptAt: null, stopAt: null, mainAgent: true, humanOrigin: true })
  assert.deepEqual(verdict, { verified: false, why: "no_witness" })
  // A transcript with no prompt line and no hook record: nothing to witness.
  assert.equal(signoff({ lines: [assistant(T0)] }).verdict.why, "no_witness")
})

test("a subagent's call is denied on Claude Code and no ticket is written", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  const file = callTranscript(human(T0))
  for (const extra of [{ agent_id: "agent-7", agent_type: "general-purpose" }, { hook_event_name: "SubagentStart" }, { hook_event_name: "SubagentStop" }]) {
    const output = issueTicket(signoffCall(stateDir, file, extra), { ...FAST, stateDir, now: () => T0 + 1000 })
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse")
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny")
    assert.equal(existsSync(ticketFile(stateDir, TASK)), false)
  }
  assert.equal(existsSync(path.join(stateDir, TICKET_DIR)), false)
})

test("the denial a subagent reads names the one thing to do, in the host's own words", () => {
  const output = issueTicket(signoffCall(fresh("state"), callTranscript(human(T0)), { agent_id: "agent-7" }), { ...FAST, stateDir: fresh("state"), now: () => T0 })
  const reason = output.hookSpecificOutput.permissionDecisionReason
  assertActionable(assert, reason, "the task_signoff subagent denial")
  assert.match(reason, /Report what you found to the main agent/u)
  assert.match(reason, /only the main agent may call task_signoff/u)
  assert.match(reason, /records the operator's answer/u)
  assert.ok(reason.length < 200)
})

test("an empty agent_id is not a subagent", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  assert.deepEqual(issueTicket(signoffCall(stateDir, callTranscript(human(T0)), { agent_id: "" }), { ...FAST, stateDir, now: () => T0 + 1000 }), {})
  assert.equal(existsSync(ticketFile(stateDir, TASK)), true)
})

test("a call that names no task or outcome, or no session, writes no ticket", () => {
  const stateDir = fresh("state")
  const file = callTranscript(human(T0))
  for (const payload of [signoffCall(stateDir, file, { tool_input: {} }), signoffCall(stateDir, file, { tool_input: { track: "a", slug: "b" } }), signoffCall(stateDir, file, { tool_input: "x" }), signoffCall(stateDir, file, { session_id: "" }), null, undefined]) {
    assert.deepEqual(issueTicket(payload, { ...FAST, stateDir, now: () => T0 }), {})
  }
  assert.equal(existsSync(path.join(stateDir, TICKET_DIR)), false)
  assert.deepEqual(issueTicket(signoffCall("/var/nonexistent-real-state/desk", file), { ...FAST, stateDir: "/var/nonexistent-real-state/desk", now: () => T0 }), {})
})

test("a ticket is read once and a second read finds none", () => {
  const { stateDir } = signoff({ lines: [human(T0)], promptHookAt: T0 + 100 })
  assert.equal(existsSync(ticketFile(stateDir, TASK)), false, "the first read deleted it")
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 2000 }), null)
})

test("a ticket older than two minutes is ignored", () => {
  assert.equal(TICKET_TTL_MS, 120_000)
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  const file = callTranscript(human(T0))
  issueTicket(signoffCall(stateDir, file), { ...FAST, stateDir, now: () => T0 })
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + TICKET_TTL_MS + 1 }), null)
  issueTicket(signoffCall(stateDir, file), { ...FAST, stateDir, now: () => T0 })
  assert.ok(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + TICKET_TTL_MS }), "exactly two minutes is still fresh")
})

test("a ticket for another task or another outcome is not used", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  issueTicket(signoffCall(stateDir, callTranscript(human(T0))), { ...FAST, stateDir, now: () => T0 })
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, slug: "other-task", now: () => T0 + 1000 }), null)
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, outcome: "refused", now: () => T0 + 1000 }), null)
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, track: "other", slug: TASK.slug, outcome: TASK.outcome, now: () => T0 + 1000 }), null)
  assert.ok(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 1000 }))
  assert.notEqual(ticketFile("/s", { track: "ab", slug: "c", outcome: "x" }), ticketFile("/s", { track: "a", slug: "bc", outcome: "x" }))
})

test("a corrupt, partial or untrusted ticket is no witness", () => {
  const stateDir = fresh("state")
  const write = (content) => {
    mkdirSync(path.dirname(ticketFile(stateDir, TASK)), { recursive: true })
    writeFileSync(ticketFile(stateDir, TASK), content)
  }
  const now = () => T0 + 1000
  write("{nope")
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now }), null)
  write("[1]")
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now }), null)
  write(JSON.stringify({ prompt_at: 1 }))
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now }), null)
  write(JSON.stringify({ issued_at: T0, prompt_at: "x", stop_at: "y", main_agent: "true", human_origin: "yes" }))
  assert.deepEqual(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now }), { promptAt: null, stopAt: null, mainAgent: null, humanOrigin: null })
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, track: 1, slug: "a", outcome: "b", now }), null)
})

test("the later of two tickets for the same task wins and nothing of the first is kept", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  issueTicket(signoffCall(stateDir, callTranscript(human(T0))), { ...FAST, stateDir, now: () => T0 + 1000 })
  issueTicket(signoffCall(stateDir, callTranscript(notification(T0))), { ...FAST, stateDir, now: () => T0 + 2000 })
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 3000 }).humanOrigin, false)
})

test("codex or hooks off: no witness file and no ticket gives no_witness", () => {
  const stateDir = fresh("state")
  const witness = witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 })
  assert.equal(witness, null)
  assert.deepEqual(witnessVerdict(witness), { verified: false, why: "no_witness" })
})

// ---- the proof that the main agent made the call ----

/** A fake clock and sleep that move together, and the number of times the transcript was read between them. */
function stopwatch() {
  let at = 0
  const sleeps = []
  return { clock: () => at, sleep: (ms) => { sleeps.push(ms); at += ms }, sleeps }
}
const ticketOf = (stateDir) => JSON.parse(readFileSync(ticketFile(stateDir, TASK), "utf8"))
function tickets(file, { extra = {}, options = {} } = {}) {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  const output = issueTicket(signoffCall(stateDir, file, extra), { stateDir, now: () => T0 + 1000, ...options })
  return { output, stateDir }
}

test("the root transcript holds the call's tool_use id: main_agent is true", () => {
  const watch = stopwatch()
  const { stateDir } = tickets(callTranscript(human(T0)), { options: watch })
  assert.equal(ticketOf(stateDir).main_agent, true)
  assert.deepEqual(watch.sleeps, [], "found at once, no wait")
})

test("the call's id is only on a sidechain line: main_agent is null", () => {
  const watch = stopwatch()
  const { stateDir } = tickets(transcript(human(T0), callLine(T0 + 1, CALL_ID, { isSidechain: true })), { options: watch })
  assert.equal(ticketOf(stateDir).main_agent, null)
})

test("the call's id belongs to another call or to a user line: main_agent is null", () => {
  const userLine = { type: "user", timestamp: iso(T0), message: { role: "user", content: [{ type: "tool_use", id: CALL_ID }] } }
  const { stateDir } = tickets(transcript(human(T0), callLine(T0 + 1, "toolu_other"), userLine, { type: "assistant", message: { content: "text only" } }), { options: stopwatch() })
  assert.equal(ticketOf(stateDir).main_agent, null)
})

test("the call's line is not yet written: main_agent is null after the wait, and the wait is bounded", () => {
  assert.equal(MAIN_AGENT_WAIT_MS, 1500)
  const watch = stopwatch()
  const { stateDir } = tickets(transcript(human(T0)), { options: watch })
  assert.equal(ticketOf(stateDir).main_agent, null)
  assert.equal(watch.clock(), MAIN_AGENT_WAIT_MS)
  assert.ok(watch.sleeps.length >= 2 && watch.sleeps.every((ms) => ms > 0 && ms <= 200))
})

test("the call's line appears on the second read: main_agent is true", () => {
  const file = transcript(human(T0))
  let sleeps = 0
  const watch = stopwatch()
  const sleep = (ms) => {
    watch.sleep(ms)
    sleeps += 1
    if (sleeps === 1) writeFileSync(file, [human(T0), callLine(T0 + 1)].map((line) => JSON.stringify(line)).join("\n") + "\n")
  }
  const { stateDir } = tickets(file, { options: { clock: watch.clock, sleep } })
  assert.equal(sleeps, 1)
  assert.equal(ticketOf(stateDir).main_agent, true)
})

test("a payload with no tool_use_id gives main_agent null without waiting", () => {
  const watch = stopwatch()
  const { stateDir } = tickets(callTranscript(human(T0)), { extra: { tool_use_id: undefined }, options: watch })
  assert.equal(ticketOf(stateDir).main_agent, null)
  assert.equal(watch.clock(), 0)
  const second = tickets(callTranscript(human(T0)), { extra: { tool_use_id: "" }, options: watch })
  assert.equal(ticketOf(second.stateDir).main_agent, null)
})

test("the default sleep really waits a moment between reads", () => {
  let ticks = 0
  const started = Date.now()
  const { stateDir } = tickets(transcript(human(T0)), { options: { clock: () => (ticks += 800) } })
  assert.equal(ticketOf(stateDir).main_agent, null)
  assert.ok(Date.now() - started >= 90, "the real sleep ran")
})

test("an unreadable transcript gives main_agent null", () => {
  const { stateDir } = tickets(path.join(ROOT, "missing.jsonl"), { options: stopwatch() })
  assert.equal(ticketOf(stateDir).main_agent, null)
})

test("with agent_id present the call is still denied and no ticket is written, whatever the transcript holds", () => {
  const { output, stateDir } = tickets(callTranscript(human(T0)), { extra: { agent_id: "agent-3" }, options: stopwatch() })
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny")
  assert.equal(existsSync(ticketFile(stateDir, TASK)), false)
})

test("a ticket without main-agent proof is unverified as subagent_not_ruled_out", () => {
  const { stateDir } = tickets(transcript(human(T0)), { options: stopwatch() })
  const witness = witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 2000 })
  assert.equal(witness.mainAgent, null)
  assert.deepEqual(witnessVerdict({ ...witness, deliveredAt: T0 - 5000 }), { verified: false, why: "subagent_not_ruled_out" })
})

test("a human line whose time cannot be parsed gives human null and a ticket with no prompt time", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  issueTicket(signoffCall(stateDir, callTranscript(human(T0, { timestamp: "not a time" }))), { ...FAST, stateDir, now: () => T0 + 1000 })
  const witness = witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 2000 })
  assert.deepEqual(witness, { promptAt: null, stopAt: null, mainAgent: true, humanOrigin: null })
  assert.deepEqual(witnessVerdict(witness), { verified: false, why: "no_witness" })
})

// ---- which host the server runs under, and a ticket left behind ----

test("a ticket exists and the server environment is Codex-like: no witness, and the ticket is left alone", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  issueTicket(signoffCall(stateDir, callTranscript(human(T0))), { ...FAST, stateDir, now: () => T0 + 1000 })
  for (const env of [{}, { CODEX_HOME: "/x" }, { CODEX_THREAD_ID: "t" }]) {
    assert.equal(witnessFor({ env, stateDir, ...TASK, now: () => T0 + 2000 }), null)
    assert.equal(existsSync(ticketFile(stateDir, TASK)), true, "a call from another host does not use it up")
  }
})

test("the server environment is Claude Code: the ticket is read once", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  issueTicket(signoffCall(stateDir, callTranscript(human(T0))), { ...FAST, stateDir, now: () => T0 + 1000 })
  for (const env of [{ CLAUDECODE: "1" }, { CLAUDE_PLUGIN_ROOT: "/p" }, { CLAUDE_PROJECT_DIR: "/d" }]) {
    issueTicket(signoffCall(stateDir, callTranscript(human(T0))), { ...FAST, stateDir, now: () => T0 + 1000 })
    assert.equal(witnessFor({ env, stateDir, ...TASK, now: () => T0 + 2000 }).humanOrigin, true)
    assert.equal(existsSync(ticketFile(stateDir, TASK)), false)
    assert.equal(witnessFor({ env, stateDir, ...TASK, now: () => T0 + 2000 }), null)
  }
})

test("Copilot's session id set together with an inherited Claude mark: the Copilot path is taken", () => {
  const stateDir = fresh("state")
  const home = copilotLog(copilotEvent("user.message", {}))
  recordPrompt({ session_id: "cs1" }, { stateDir, now: () => T0 })
  issueTicket(signoffCall(stateDir, callTranscript(human(T0))), { ...FAST, stateDir, now: () => T0 + 1000 })
  const witness = witnessFor({ env: { CLAUDECODE: "1", COPILOT_AGENT_SESSION_ID: "cs1", COPILOT_HOME: home }, stateDir, ...TASK, now: () => T0 + 2000 })
  assert.equal(witness.mainAgent, null)
  assert.equal(existsSync(ticketFile(stateDir, TASK)), true, "the Copilot path does not touch a ticket")
})

test("a hook run for a main-agent call removes an older ticket for the same task and outcome, even when it writes none; a denied subagent call leaves it", () => {
  const stateDir = fresh("state")
  const file = callTranscript(human(T0))
  const strand = () => {
    recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
    issueTicket(signoffCall(stateDir, file), { ...FAST, stateDir, now: () => T0 + 1000 })
    assert.equal(existsSync(ticketFile(stateDir, TASK)), true)
  }
  strand()
  assert.equal(issueTicket(signoffCall(stateDir, file, { agent_id: "agent-1" }), { ...FAST, stateDir, now: () => T0 + 2000 }).hookSpecificOutput.permissionDecision, "deny")
  assert.equal(existsSync(ticketFile(stateDir, TASK)), true, "a denied subagent call never reaches the server, so the main agent's waiting ticket stays")
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 3000 }).humanOrigin, true, "the main agent's call still finds its ticket")
  strand()
  issueTicket(signoffCall(stateDir, file, { session_id: "" }), { ...FAST, stateDir, now: () => T0 + 2000 })
  assert.equal(existsSync(ticketFile(stateDir, TASK)), false, "a call that writes none leaves no older one")
  strand()
  issueTicket(signoffCall(stateDir, file, { transcript_path: undefined }), { ...FAST, stateDir, now: () => T0 + 2000 })
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 3000 }).mainAgent, null, "the new run's ticket replaced the old")
  // A call that never reached the server leaves its own ticket for 120 seconds; a hookless caller on Claude Code still finds it. This is the window the ruling accepts.
  strand()
  assert.equal(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 99_000 }).humanOrigin, true)
})

test("taking a ticket leaves no file behind, and a second taker finds none", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  issueTicket(signoffCall(stateDir, callTranscript(human(T0))), { ...FAST, stateDir, now: () => T0 + 1000 })
  assert.ok(witnessFor({ env: CLAUDE_ENV, stateDir, ...TASK, now: () => T0 + 2000 }))
  assert.deepEqual(readdirSync(path.join(stateDir, TICKET_DIR)), [])
})

// ---- Copilot ----

const copilotEvent = (type, data = {}) => JSON.stringify({ type, data })
function copilotLog(...lines) {
  const home = fresh("copilot-home")
  const sessionDir = path.join(home, "session-state", "cs1")
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(path.join(sessionDir, "events.jsonl"), lines.join("\n") + "\n")
  return home
}

test("on Copilot a last prompt with a source is not human-origin", () => {
  const read = (...lines) => copilotLastPromptIsHuman("cs1", { env: { COPILOT_HOME: copilotLog(...lines) } })
  assert.equal(read(copilotEvent("user.message", { content: "hi" })), true)
  assert.equal(read(copilotEvent("user.message", {}), copilotEvent("assistant.message", {})), true)
  assert.equal(read(copilotEvent("user.message", {}), copilotEvent("user.message", { source: "schedule-daily" })), false)
  assert.equal(read(copilotEvent("user.message", { source: "agent-helper" })), false)
  assert.equal(read(copilotEvent("user.message", { source: "autopilot" })), false)
  assert.equal(read(copilotEvent("user.message", { isAutopilotContinuation: true })), false)
  assert.equal(read(copilotEvent("user.message", {}), "not json", "[1]"), true)
  assert.equal(read(JSON.stringify({ type: "user.message", data: "text" })), true)
  assert.equal(read(copilotEvent("assistant.message", {})), null)
  assert.equal(copilotLastPromptIsHuman("cs1", { env: { COPILOT_HOME: fresh("nothing") } }), null)
  assert.equal(copilotLastPromptIsHuman("", { env: {} }), null)
  assert.equal(copilotLastPromptIsHuman(undefined, { env: {} }), null)
})

test("the Copilot event log is found under COPILOT_HOME or the home folder, or at an injected path", () => {
  const home = copilotLog(copilotEvent("user.message", {}))
  assert.equal(copilotLastPromptIsHuman("cs1", { env: { COPILOT_HOME: home } }), true)
  const userHome = fresh("user-home")
  mkdirSync(path.join(userHome, ".copilot", "session-state", "cs1"), { recursive: true })
  writeFileSync(path.join(userHome, ".copilot", "session-state", "cs1", "events.jsonl"), copilotEvent("user.message", { source: "x" }) + "\n")
  assert.equal(copilotLastPromptIsHuman("cs1", { env: {}, homeDir: userHome }), false)
  assert.equal(copilotLastPromptIsHuman("cs1", { env: {}, eventsPath: path.join(home, "session-state", "cs1", "events.jsonl") }), true)
  // A session id cannot name a path outside the session folder.
  assert.equal(copilotLastPromptIsHuman("../cs1", { env: { COPILOT_HOME: home } }), null)
})

test("on Copilot the server reads the session file by the session id in its environment", () => {
  const stateDir = fresh("state")
  const home = copilotLog(copilotEvent("user.message", {}))
  recordStop({ session_id: "cs1" }, { stateDir, now: () => T0 - 5000 })
  recordPrompt({ session_id: "cs1" }, { stateDir, now: () => T0 })
  const env = { COPILOT_AGENT_SESSION_ID: "cs1", COPILOT_HOME: home }
  const witness = witnessFor({ env, stateDir, ...TASK, now: () => T0 + 1000 })
  assert.deepEqual(witness, { promptAt: T0, stopAt: T0 - 5000, mainAgent: null, humanOrigin: true })
})

test("on Copilot a sign-off is unverified as subagent_not_ruled_out even with a clean human prompt", () => {
  const stateDir = fresh("state")
  const home = copilotLog(copilotEvent("user.message", {}))
  recordPrompt({ session_id: "cs1" }, { stateDir, now: () => T0 })
  const witness = witnessFor({ env: { COPILOT_AGENT_SESSION_ID: "cs1", COPILOT_HOME: home }, stateDir, ...TASK, now: () => T0 + 1000 })
  assert.equal(witness.humanOrigin, true)
  assert.deepEqual(witnessVerdict({ ...witness, deliveredAt: T0 - 5000 }), { verified: false, why: "subagent_not_ruled_out" })
})

test("on Copilot a missing session file is no witness, and a ticket on disk is not used", () => {
  const stateDir = fresh("state")
  const home = copilotLog(copilotEvent("user.message", {}))
  const env = { COPILOT_AGENT_SESSION_ID: "cs1", COPILOT_HOME: home }
  assert.equal(witnessFor({ env, stateDir, ...TASK, now: () => T0 }), null)
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => T0 })
  issueTicket(signoffCall(stateDir, callTranscript(human(T0))), { ...FAST, stateDir, now: () => T0 })
  assert.equal(witnessFor({ env, stateDir, ...TASK, now: () => T0 }), null)
})

test("on Copilot an unreadable event log gives human origin unknown", () => {
  const stateDir = fresh("state")
  recordPrompt({ session_id: "cs1" }, { stateDir, now: () => T0 })
  const witness = witnessFor({ env: { COPILOT_AGENT_SESSION_ID: "cs1", COPILOT_HOME: fresh("empty") }, stateDir, ...TASK, now: () => T0 })
  assert.deepEqual(witness, { promptAt: T0, stopAt: null, mainAgent: null, humanOrigin: null })
})

// ---- privacy ----

test("witness and ticket files hold times and booleans only, and their names carry no task or session text", () => {
  const stateDir = fresh("state")
  const session = `sess-${SENTINEL}`
  const call = { hook_event_name: "PreToolUse", session_id: session, tool_use_id: CALL_ID, tool_input: { track: `track-${SENTINEL}`, slug: `slug-${SENTINEL}`, outcome: "accepted", note: SENTINEL } }
  recordPrompt({ session_id: session, prompt: SENTINEL }, { stateDir, now: () => T0 })
  recordStop({ session_id: session, last_assistant_message: SENTINEL }, { stateDir, now: () => T0 + 5 })
  recordPrompt({ session_id: session, prompt: SENTINEL }, { stateDir, now: () => T0 + 10 })
  const sentinelCall = { type: "assistant", timestamp: iso(T0 + 15), message: { role: "assistant", content: [{ type: "text", text: SENTINEL }, { type: "tool_use", id: CALL_ID, name: "x", input: { note: SENTINEL } }] } }
  const file = transcript(human(T0 + 10, { message: { role: "user", content: SENTINEL } }), sentinelCall)
  issueTicket({ ...call, transcript_path: file }, { ...FAST, stateDir, now: () => T0 + 20 })
  const names = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else names.push(full)
    }
  }
  walk(stateDir)
  assert.equal(names.length, 2)
  assert.equal(JSON.parse(readFileSync(names.find((name) => name.includes(`${path.sep}${TICKET_DIR}${path.sep}`)), "utf8")).main_agent, true)
  for (const name of names) {
    const relative = path.relative(stateDir, name)
    assert.doesNotMatch(relative, /SENTINEL|sess|track|slug|accepted/u)
    assert.match(path.basename(name), /^[0-9a-f]{32}\.json$/u)
    const content = readFileSync(name, "utf8")
    assert.doesNotMatch(content, /SENTINEL/u)
    for (const value of Object.values(JSON.parse(content))) assert.ok(value === null || typeof value === "boolean" || typeof value === "number", `${name}: ${value}`)
  }
  const relatives = names.map((name) => path.relative(stateDir, name).split(path.sep)[0]).sort()
  assert.deepEqual(relatives, [TICKET_DIR, WITNESS_DIR])
  assert.ok(names.includes(witnessFile(stateDir, session)))
})

// ---- the hook script ----

function runHook(mode, payload, { env = {}, raw } = {}) {
  const result = spawnSync("node", [hook, mode], { input: raw ?? JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
const hookEnv = (stateDir) => ({ HOME: stateDir, XDG_STATE_HOME: path.join(stateDir, "state") })
const hookState = (stateDir) => path.join(stateDir, "state", "ouroboros-skills", "desk")

test("the hook script prints an empty object and exits 0 on malformed input", () => {
  for (const mode of ["prompt", "stop", "ticket", "other", undefined]) {
    const result = spawnSync("node", [hook, ...(mode === undefined ? [] : [mode])], { input: "{not json", encoding: "utf8" })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, "{}\n")
  }
  assert.equal(runHook("prompt", null).stdout, "{}\n")
  assert.equal(runHook("other", { session_id: "s1" }).stdout, "{}\n")
})

test("the hook script records prompt and stop and issues the ticket end to end, and denies a subagent", () => {
  const stateDir = fresh("home")
  const env = hookEnv(stateDir)
  const state = hookState(stateDir)
  mkdirSync(state, { recursive: true })
  assert.equal(runHook("prompt", { session_id: "s9", prompt: SENTINEL }, { env }).stdout, "{}\n")
  assert.equal(runHook("stop", { session_id: "s9", hook_event_name: "Stop" }, { env }).stdout, "{}\n")
  assert.equal(runHook("stop", { session_id: "s9", hook_event_name: "SubagentStop", agent_id: "a" }, { env }).stdout, "{}\n")
  const record = JSON.parse(readFileSync(witnessFile(state, "s9"), "utf8"))
  assert.equal(typeof record.prompt_at, "number")
  assert.equal(typeof record.stop_at, "number")
  const file = transcript(human(Date.now()), callLine(Date.now()))
  const ok = runHook("ticket", { hook_event_name: "PreToolUse", session_id: "s9", tool_use_id: CALL_ID, transcript_path: file, tool_input: TASK }, { env })
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout, "{}\n")
  assert.equal(existsSync(ticketFile(state, TASK)), true)
  rmSync(ticketFile(state, TASK))
  const denied = runHook("ticket", { hook_event_name: "PreToolUse", session_id: "s9", tool_use_id: CALL_ID, agent_id: "a1", transcript_path: file, tool_input: TASK }, { env })
  assert.equal(denied.status, 0)
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny")
  assert.equal(existsSync(ticketFile(state, TASK)), false)
})

test("the hook script reads a Copilot payload in Copilot's own shape", () => {
  const stateDir = fresh("home")
  const env = hookEnv(stateDir)
  const state = hookState(stateDir)
  mkdirSync(state, { recursive: true })
  assert.equal(runHook("prompt", { sessionId: "cs7", timestamp: 1, cwd: "/x", prompt: SENTINEL }, { env }).stdout, "{}\n")
  assert.equal(runHook("stop", { sessionId: "cs7", timestamp: 2, cwd: "/x", transcriptPath: "/x", stopReason: "end_turn" }, { env }).stdout, "{}\n")
  const record = JSON.parse(readFileSync(witnessFile(state, "cs7"), "utf8"))
  assert.equal(typeof record.prompt_at, "number")
  assert.equal(typeof record.stop_at, "number")
  assert.doesNotMatch(readFileSync(witnessFile(state, "cs7"), "utf8"), /SENTINEL/u)
})

// ---- registration ----

const loadJson = (...parts) => JSON.parse(readFileSync(path.join(plugin, ...parts), "utf8"))
const commandsOf = (entries) => entries.flatMap((entry) => (entry.hooks ?? [entry]).map((hookEntry) => hookEntry.command ?? hookEntry.bash))

test("the Claude registration has the task_signoff matcher and the Copilot registration has no per-tool witness entry", () => {
  const claude = loadJson("hooks", "hooks.json").hooks
  const witnessEntries = (event) => claude[event].filter((entry) => entry.hooks.some((hookEntry) => hookEntry.command.includes("signoff-witness.cjs")))
  const matcher = witnessEntries("PreToolUse")
  assert.equal(matcher.length, 1)
  assert.equal(matcher[0].matcher, "mcp__.*__task_signoff")
  assert.equal(matcher[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/signoff-witness.cjs" ticket')
  assert.ok(new RegExp(`^(?:${matcher[0].matcher})$`, "u").test("mcp__plugin_desk_desk__task_signoff"))
  assert.ok(!new RegExp(`^(?:${matcher[0].matcher})$`, "u").test("mcp__plugin_desk_desk__task_update"))
  assert.equal(witnessEntries("UserPromptSubmit")[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/signoff-witness.cjs" prompt')
  assert.equal(witnessEntries("Stop")[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/signoff-witness.cjs" stop')
  // New entries come last, after every existing one.
  assert.ok(commandsOf(claude.Stop).at(-1).includes("signoff-witness.cjs"))
  assert.ok(commandsOf(claude.UserPromptSubmit).at(-1).includes("signoff-witness.cjs"))
  assert.ok(commandsOf(claude.PreToolUse).at(-1).includes("signoff-witness.cjs"))

  const copilot = loadJson("hooks", "copilot-hooks.json").hooks
  const copilotWitness = (event) => copilot[event].filter((entry) => entry.bash.includes("signoff-witness.cjs"))
  assert.equal(copilotWitness("userPromptSubmitted").length, 1)
  assert.equal(copilotWitness("userPromptSubmitted")[0].bash, 'node "${PLUGIN_ROOT}/hooks/signoff-witness.cjs" prompt')
  assert.equal(copilotWitness("agentStop").length, 1)
  assert.equal(copilotWitness("agentStop")[0].bash, 'node "${PLUGIN_ROOT}/hooks/signoff-witness.cjs" stop')
  assert.equal(copilotWitness("agentStop")[0].powershell, copilotWitness("agentStop")[0].bash)
  assert.ok(commandsOf(copilot.agentStop).at(-1).includes("signoff-witness.cjs"))
  assert.ok(commandsOf(copilot.userPromptSubmitted).at(-1).includes("signoff-witness.cjs"))
  for (const event of ["preToolUse", "postToolUse"]) assert.equal(copilotWitness(event).length, 0, `no ${event} witness entry`)
})
