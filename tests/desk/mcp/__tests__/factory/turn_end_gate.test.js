import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { checkTurnEnd, endingOf } from "../../../../../plugins/desk/hooks/lib/turn-end-gate.cjs"
import { scratch, ID, START, END } from "./_session_helpers.js"

const NOW = Date.parse(END)
const PR = "https://github.com/ourostack/desk/pull/1900"
const FOCUS = { track: "desk-plugin", slug: "keep-moving" }
const focused = (status = "processing") => ({ status: "focused", track: FOCUS.track, slug: FOCUS.slug, task_status: status })
const future = hours => new Date(NOW + hours * 3600_000).toISOString()

// Each step is [toolName, args, result]; the session ends its turn with `reply`.
async function fixture(ctx, host, { steps = [["task_focus", FOCUS, focused()]], reply, edit, stopActive = false } = {}) {
  const log = host === "copilot" ? path.join(ctx.env.COPILOT_HOME, "session-state", ID, "events.jsonl") : path.join(ctx.base, ".claude/projects/test", `${ID}.jsonl`)
  const name = n => n.startsWith("desk:") ? n.slice(5) : (host === "copilot" ? (/^(task_)/.test(n) ? `desk-${n}` : n) : (/^(task_)/.test(n) ? `mcp__desk__${n}` : n))
  const payload = host === "copilot"
    ? { sessionId: ID, cwd: ctx.desk, timestamp: Date.parse(END), transcriptPath: log, stopReason: "end_turn", stop_hook_active: stopActive }
    : { session_id: ID, cwd: ctx.desk, transcript_path: log, hook_event_name: "Stop", stop_hook_active: stopActive, last_assistant_message: reply }
  const lines = host === "copilot"
    ? [{ type: "session.start", timestamp: START, data: { sessionId: ID, context: { cwd: ctx.desk } } },
      { type: "user.message", timestamp: START, data: { content: "Go.", interactionId: "h1" } }]
    : [{ type: "user", sessionId: ID, cwd: ctx.desk, timestamp: START, origin: { kind: "human" }, message: { role: "user", content: "Go." } }]
  steps.forEach(([tool, args, result], i) => {
    const content = typeof result === "string" ? result : JSON.stringify(result)
    if (host === "copilot") lines.push(
      { type: "tool.execution_start", timestamp: START, data: { toolCallId: `c${i}`, toolName: name(tool), arguments: args } },
      { type: "tool.execution_complete", timestamp: START, data: { toolCallId: `c${i}`, success: true, interactionId: "h1", result: { content } } })
    else lines.push(
      { type: "assistant", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_use", id: `c${i}`, name: name(tool), input: args }] } },
      { type: "user", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_result", tool_use_id: `c${i}`, content }] } })
  })
  if (host === "copilot") lines.push({ type: "assistant.message", timestamp: END, data: { content: reply, interactionId: "h1", toolRequests: [] } })
  else lines.push({ type: "assistant", sessionId: ID, timestamp: END, message: { stop_reason: "end_turn", content: [{ type: "text", text: reply }] } })
  if (edit) edit(lines)
  await fs.mkdir(path.dirname(log), { recursive: true })
  await fs.writeFile(log, lines.map(x => JSON.stringify(x)).join("\n") + "\n")
  return { host, payload, env: ctx.env, now: () => NOW }
}
const ledger = async ctx => (await fs.readFile(path.join(ctx.env.XDG_STATE_HOME, "ouroboros-skills/desk/turn-ends", `${ID}.jsonl`), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse)
const WAKE_STEP = ["schedule_wake", { id: "wake-ci-77", at: future(2) }, { registered: "wake-ci-77" }]

for (const host of ["copilot", "claude"]) {
  test(`${host}: an open card with no Ending line gets one correction naming the four endings`, () => scratch(async ctx => {
    const r = await checkTurnEnd(await fixture(ctx, host, { reply: "Working on it, more soon." }))
    assert.equal(r.status, "correction")
    assert.match(r.output.reason, /\[DESK_TURN_END_GATE\]/u)
    for (const kind of ["done;", "waiting;", "blocked;", "no ready work;"]) assert.ok(r.output.reason.includes(`Ending: ${kind}`))
  }))
  test(`${host}: the correction is spent once, so the gate cannot loop`, () => scratch(async ctx => {
    const r = await checkTurnEnd(await fixture(ctx, host, { reply: "Still going.", stopActive: true }))
    assert.deepEqual(r, { status: "unverified", diagnostic: "turn_end_gate_exhausted" })
    assert.equal((await ledger(ctx))[0].ending.kind, "unverified")
  }))
  test(`${host}: "no ready work" is a valid, recorded ending`, () => scratch(async ctx => {
    const r = await checkTurnEnd(await fixture(ctx, host, { reply: "Nothing to do.\nEnding: no ready work; checked: roadmap ready list and the issue queue" }))
    assert.equal(r.status, "complete")
    assert.deepEqual((await ledger(ctx))[0].ending, { kind: "no_ready_work", checked: "roadmap ready list and the issue queue" })
  }))
  test(`${host}: a wait needs a wake this session registered, a near expiry and what it blocks`, () => scratch(async ctx => {
    const ok = `Ending: waiting; on: CI run 77; wake: wake-ci-77; expires: ${future(2)}; blocks: the merge of ${PR}`
    const steps = [["task_focus", FOCUS, focused()], WAKE_STEP]
    assert.equal((await checkTurnEnd(await fixture(ctx, host, { steps, reply: ok }))).status, "complete")
    assert.equal((await ledger(ctx))[0].ending.wake, "wake-ci-77")
  }))
  test(`${host}: gaming a wait fails (invented wake, far or past expiry, no blocks)`, () => scratch(async ctx => {
    const steps = [["task_focus", FOCUS, focused()], WAKE_STEP]
    const bad = [
      `Ending: waiting; on: CI; wake: wake-made-up; expires: ${future(2)}; blocks: merge`,
      `Ending: waiting; on: CI; wake: wake-ci-77; expires: ${future(24 * 30)}; blocks: merge`,
      `Ending: waiting; on: CI; wake: wake-ci-77; expires: ${future(-1)}; blocks: merge`,
      `Ending: waiting; on: CI; wake: wake-ci-77; expires: ${future(2)}`,
    ]
    for (const reply of bad) assert.equal((await checkTurnEnd(await fixture(ctx, host, { steps, reply }))).status, "correction", reply)
  }))
  test(`${host}: a wake cited only in the reply, or from a tool that registers none, is no wake`, () => scratch(async ctx => {
    const steps = [["task_focus", FOCUS, focused()], ["bash", { command: "echo wake-ci-77" }, "wake-ci-77"]]
    const reply = `Ending: waiting; on: CI; wake: wake-ci-77; expires: ${future(2)}; blocks: merge`
    assert.equal((await checkTurnEnd(await fixture(ctx, host, { steps, reply }))).status, "correction")
  }))
  test(`${host}: blocked needs a named person and a resume step`, () => scratch(async ctx => {
    assert.equal((await checkTurnEnd(await fixture(ctx, host, { reply: "Ending: blocked; on: Ari; resume: say go and I rerun the release" }))).status, "complete")
    for (const reply of ["Ending: blocked; on: CI; resume: rerun the release later", "Ending: blocked; on: me; resume: keep going", "Ending: blocked; on: Ari; resume: ok"]) {
      assert.equal((await checkTurnEnd(await fixture(ctx, host, { reply }))).status, "correction", reply)
    }
  }))
  test(`${host}: done must cite something a tool of this session produced, not a typed link`, () => scratch(async ctx => {
    const steps = [["task_focus", FOCUS, focused()], ["bash", { command: "gh ouro-pr" }, `opened ${PR}`]]
    assert.equal((await checkTurnEnd(await fixture(ctx, host, { steps, reply: `Ending: done; shipped: ${PR}` }))).status, "complete")
    assert.equal((await checkTurnEnd(await fixture(ctx, host, { steps, reply: "Ending: done; shipped: https://github.com/ourostack/desk/pull/1" }))).status, "correction")
    assert.equal((await checkTurnEnd(await fixture(ctx, host, { steps, reply: "Ending: done; shipped: 1234567890abcdef1234567890abcdef12345678" }))).status, "correction")
  }))
  test(`${host}: a closed, drafting or missing card has no open job`, () => scratch(async ctx => {
    for (const steps of [[["task_focus", FOCUS, focused("done")]], [["task_focus", FOCUS, focused("drafting")]], [],
      [["task_focus", FOCUS, focused()], ["task_update", { ...FOCUS, status: "done" }, { status: "updated" }]],
      [["task_focus", FOCUS, focused()], ["task_focus", { clear: true }, { status: "cleared" }]]]) {
      assert.equal((await checkTurnEnd(await fixture(ctx, host, { steps, reply: "Done talking." }))).status, "no_open_job")
    }
  }))
  test(`${host}: an interrupted turn is never corrected`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { reply: "Stopped.", edit(lines) {
      if (host === "copilot") lines.splice(2, 0, { type: "abort", timestamp: START, data: {} })
      else lines.splice(1, 0, { type: "user", sessionId: ID, timestamp: START, message: { content: "[Request interrupted by user]" } })
    } })
    assert.equal((await checkTurnEnd(f)).status, "no_open_job")
  }))
}

test("a headless factory session and a subagent are excluded", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { reply: "x" })
  assert.equal((await checkTurnEnd({ ...f, env: { ...f.env, DESK_FACTORY_HEADLESS: "1" } })).status, "excluded")
  assert.equal((await checkTurnEnd({ ...f, payload: { ...f.payload, agentId: "a" } })).status, "excluded")
}))

test("the Ending line is read only from the reply's last lines", () => {
  assert.equal(endingOf("Ending: no ready work; checked: roadmap\n" + "x\n".repeat(8)), null)
  assert.equal(endingOf("**Ending: blocked; on: Ari; resume: say go**").kind, "blocked")
})
