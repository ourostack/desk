// The shared launch ledger: one crash-safe count of evaluation and triage launches under the 30-a-day ceiling, kept in three witnesses
// (ledger, guard, status high-water mark). Every test uses a throwaway HOME and state folder. Interruptions are driven through the
// ledger's own fault points, which stop a transaction exactly where a crash would.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { osEnv } from "../_os_env.js"
import { NO_FILE_SYMLINKS } from "../_platform.js"

import {
  FAULT_POINTS,
  GUARD_FILE,
  LEDGER_FILE,
  consumeEvaluationContinuation,
  createEvaluationContinuation,
  createHeadlessLedger,
  evaluationContinuationBasis,
  evaluationQuotaOpen,
  finishAgentLaunch,
  peekAgentLaunch,
  quotaFor,
  reserveAgentLaunch,
  validGuard,
  validLedger,
  validWitness,
} from "../../../../../plugins/desk/mcp/src/factory/headless-ledger.js"
import { evaluateDue } from "../../../../../plugins/desk/mcp/src/factory/evaluate-kick.js"
import { recordStep } from "../../../../../plugins/desk/mcp/src/factory/loop-status.js"
import { factoryStateRoot, readStatus, updateStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const D0 = Date.parse("2030-03-10T00:00:00.000Z")
const at = (day, hours, minutes = 0) => D0 + day * DAY + hours * HOUR + minutes * 60 * 1000
const dayText = (day) => new Date(D0 + day * DAY).toISOString().slice(0, 10)
// A legacy evaluator record from an earlier day: valid evidence of no launch today.
const LEGACY = { headless: { day: dayText(-1), jobs: 4 } }
const sha = (text) => createHash("sha256").update(text).digest("hex")

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-headless-ledger-")))
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state"), PATH: path.join(base, "no-bin") })
  try {
    // A status file exists, as on any machine that has run the factory: only a sound legacy record gives a first allowance.
    await updateStatus(env, (current) => ({ ...current }))
    return await run(env, await factoryStateRoot(env), base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const reserve = (env, kind, now, extra = {}) => reserveAgentLaunch(env, { kind, generation: null, now, legacyEvaluator: LEGACY, ...extra })
const mark = async (env) => (await readStatus(env)).loop?.agent_launch_highwater
const ledgerOf = async (root) => JSON.parse(await fs.readFile(path.join(root, LEDGER_FILE), "utf8"))
const readBytes = async (root) => ({ ledger: await fs.readFile(path.join(root, LEDGER_FILE), "utf8"), guard: await fs.readFile(path.join(root, GUARD_FILE), "utf8") })
async function restorePair(root, bytes) {
  await fs.writeFile(path.join(root, LEDGER_FILE), bytes.ledger, { mode: 0o600 })
  await fs.writeFile(path.join(root, GUARD_FILE), bytes.guard, { mode: 0o600 })
}

async function reserveMany(env, kind, now, times, extra = {}) {
  const states = []
  for (let index = 0; index < times; index += 1) states.push((await reserve(env, kind, now, extra)).state)
  return states
}

// Writes three agreeing witnesses for `fields` directly, for states no normal run reaches.
async function forge(env, root, fields, { witness = {}, guard = {} } = {}) {
  const kind = { launched: 0, ran: 0, failed: 0, not_started: 0, finished_revision: 0 }
  const ledger = {
    schema: "desk.factory.agent-launch-ledger/1",
    epoch: "ab".repeat(16),
    revision: 5,
    day: dayText(0),
    last_clock_ms: at(0, 1),
    spent: 0,
    evaluate: kind,
    triage: kind,
    windows: [0, 0, 0, 0],
    last_triage_at: null,
    issued_serial: 0,
    consumed_through: 0,
    continuations: [],
    ...fields,
  }
  const bytes = `${JSON.stringify(ledger)}\n`
  const ledgerSha = sha(bytes)
  const guardRecord = { schema: "desk.factory.agent-launch-guard/1", epoch: ledger.epoch, revision: ledger.revision, day: ledger.day, last_clock_ms: ledger.last_clock_ms, spent: ledger.spent, windows: ledger.windows, last_triage_at: ledger.last_triage_at, issued_serial: ledger.issued_serial, consumed_through: ledger.consumed_through, ledger_sha256: ledgerSha, ...guard }
  const markRecord = { schema: "desk.factory.agent-launch-highwater/1", epoch: ledger.epoch, max_revision: ledger.revision, max_acknowledged_revision: ledger.revision, max_day: ledger.day, spent_at_max_day: ledger.spent, max_clock_ms: ledger.last_clock_ms, windows: ledger.windows, last_triage_at: ledger.last_triage_at, max_issued_serial: ledger.issued_serial, consumed_through: ledger.consumed_through, target_sha256: ledgerSha, phase: "acknowledged", ...witness }
  await fs.writeFile(path.join(root, LEDGER_FILE), bytes, { mode: 0o600 })
  await fs.writeFile(path.join(root, GUARD_FILE), `${JSON.stringify(guardRecord)}\n`, { mode: 0o600 })
  await updateStatus(env, (current) => ({ ...current, loop: { ...current.loop, agent_launch_highwater: markRecord } }))
  return { ledger, guard: guardRecord, mark: markRecord }
}

// A ledger whose transactions stop at `point` (once, or every time with `always`).
function faulty(point, { always = false, ...seams } = {}) {
  let fired = false
  return createHeadlessLedger({
    ...seams,
    fault: async (name) => {
      if (name === point && (always || !fired)) {
        fired = true
        throw new Error(`crash at ${name}`)
      }
    },
  })
}

// ---------------------------------------------------------------------------

test("protected_windows_and_spent_migration", async (t) => {
  await t.test("four unused windows hold evaluation to 26; each expired window returns one; triage borrows nothing", () => scratch(async (env, root) => {
    assert.deepEqual(await reserveMany(env, "evaluate", at(0, 0, 1), 26), Array(26).fill("reserved"))
    assert.deepEqual(await reserve(env, "evaluate", at(0, 1)), { state: "window_protected", day: dayText(0), remaining: 0 })
    assert.deepEqual(await reserveMany(env, "evaluate", at(0, 6), 2), ["reserved", "window_protected"], "the first window ended unused: a 27th")
    assert.deepEqual(await reserveMany(env, "evaluate", at(0, 12), 2), ["reserved", "window_protected"], "a 28th")
    assert.deepEqual(await reserveMany(env, "evaluate", at(0, 18), 2), ["reserved", "window_protected"], "a 29th; the last window is still triage's")
    const triage = await reserve(env, "triage", at(0, 18, 30))
    assert.equal(triage.state, "reserved")
    assert.equal(triage.remaining, 0)
    assert.deepEqual(await reserve(env, "triage", at(0, 23, 59)), { state: "quota_exhausted", day: dayText(0), remaining: 0 })
    assert.equal((await reserve(env, "evaluate", at(0, 23, 59))).state, "quota_exhausted")
    const ledger = await ledgerOf(root)
    assert.equal(ledger.spent, 30, "never more than the ceiling")
    assert.equal(ledger.evaluate.launched, 29)
    assert.equal(ledger.triage.launched, 1)
    assert.deepEqual(ledger.windows, [0, 0, 0, 1])
    assert.equal((await mark(env)).spent_at_max_day, 30)
  }))

  await t.test("a migrated day of 30 evaluator runs permits neither kind until the next UTC day", () => scratch(async (env) => {
    const legacyEvaluator = { headless: { day: dayText(0), jobs: 30 } }
    assert.equal((await reserve(env, "evaluate", at(0, 9), { legacyEvaluator })).state, "quota_exhausted")
    assert.equal((await reserve(env, "triage", at(0, 9), { legacyEvaluator })).state, "quota_exhausted")
    assert.equal((await reserve(env, "triage", at(1, 0, 5))).state, "reserved")
    assert.equal((await reserve(env, "evaluate", at(1, 0, 6))).state, "reserved")
  }))

  await t.test("today's legacy count is spent, an earlier day's is not, and more than 30 counts as 30", () => scratch(async (env, root) => {
    const today = await reserve(env, "evaluate", at(0, 13), { legacyEvaluator: { headless: { day: dayText(0), jobs: 6 } } })
    assert.deepEqual(today, { state: "reserved", token: { epoch: (await ledgerOf(root)).epoch, revision: 2, kind: "evaluate", day: dayText(0) }, day: dayText(0), remaining: 30 - 2 - 7 })
    assert.equal((await ledgerOf(root)).evaluate.launched, 7)
    await scratch(async (other, otherRoot) => {
      await reserve(other, "evaluate", at(0, 13), { legacyEvaluator: { headless: { day: dayText(0), jobs: 45 } } })
      assert.equal((await ledgerOf(otherRoot)).spent, 30)
    })
  }))

  await t.test("without sound legacy evidence the first day is spent, never zero", () => scratch(async (env, root) => {
    assert.equal((await reserve(env, "evaluate", at(0, 9), { legacyEvaluator: undefined })).state, "quota_exhausted")
    assert.equal((await ledgerOf(root)).spent, 30)
    for (const legacyEvaluator of [{ headless: "damaged" }, { headless: { day: "2030-13-01", jobs: 1 } }, { headless: { day: dayText(0), jobs: -1 } }, "damaged", {}, null]) {
      await scratch(async (other, otherRoot) => {
        assert.equal((await reserve(other, "evaluate", at(0, 9), { legacyEvaluator })).state, "quota_exhausted", JSON.stringify(legacyEvaluator))
        assert.equal((await ledgerOf(otherRoot)).spent, 30)
      })
    }
  }))

  await t.test("a legacy day after the clock blocks and writes nothing", () => scratch(async (env, root) => {
    assert.deepEqual(await reserve(env, "evaluate", at(0, 9), { legacyEvaluator: { headless: { day: dayText(1), jobs: 0 } } }), { state: "legacy_future_dated" })
    assert.equal(await mark(env), undefined)
    await assert.rejects(fs.stat(path.join(root, LEDGER_FILE)), { code: "ENOENT" })
  }))

  await t.test("only a machine whose status file does not exist yet starts at zero without a legacy record", async () => {
    const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-headless-ledger-")))
    const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state"), PATH: path.join(base, "no-bin") })
    try {
      const root = await factoryStateRoot(env)
      assert.equal((await reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 9) })).state, "reserved")
      assert.equal((await ledgerOf(root)).spent, 1)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

test("late_window_cooldown_survives_midnight", () => scratch(async (env) => {
  assert.equal((await reserve(env, "triage", at(0, 5, 59))).state, "reserved")
  assert.equal((await reserve(env, "triage", at(0, 6))).state, "triage_cooldown", "a new window does not make triage due again")
  assert.equal((await reserve(env, "triage", at(0, 11, 58))).state, "triage_cooldown")
  assert.equal((await reserve(env, "triage", at(0, 11, 59))).state, "reserved", "six hours after the last actual launch")
  assert.equal((await reserve(env, "triage", at(0, 23))).state, "reserved")
  assert.equal((await reserve(env, "triage", at(1, 0, 30))).state, "triage_cooldown", "the gap crosses midnight")
  assert.equal((await reserve(env, "triage", at(1, 5))).state, "reserved")
  const ledger = (await readStatus(env)).loop.agent_launch_highwater
  assert.equal(ledger.last_triage_at, new Date(at(1, 5)).toISOString())
  assert.deepEqual(ledger.windows, [1, 0, 0, 0])
}))

test("a used current window refuses triage even past the gap", () => scratch(async (env, root) => {
  await forge(env, root, { spent: 1, triage: { launched: 1, ran: 0, failed: 0, not_started: 0, finished_revision: 0 }, windows: [0, 1, 0, 0], last_triage_at: new Date(at(-2, 0)).toISOString(), last_clock_ms: at(0, 6) })
  assert.equal((await reserve(env, "triage", at(0, 7))).state, "window_used")
  assert.equal((await reserve(env, "triage", at(0, 12))).state, "reserved")
}))

test("consecutive_days_both_queues_progress", () => scratch(async (env, root) => {
  // Healthy host invocations every 15 minutes for two UTC days. Each worker generation has one agent slot: due triage with eligible work
  // takes it, otherwise the always-runnable evaluation queue does.
  const perDay = new Map()
  for (let minute = 0; minute < 2 * 24 * 60; minute += 15) {
    const now = D0 + minute * 60 * 1000
    const day = dayText(Math.floor(minute / (24 * 60)))
    const counts = perDay.get(day) ?? { triage: 0, evaluate: 0 }
    if ((await reserve(env, "triage", now)).state === "reserved") counts.triage += 1
    else if ((await reserve(env, "evaluate", now)).state === "reserved") counts.evaluate += 1
    perDay.set(day, counts)
  }
  for (const [day, counts] of perDay) {
    assert.ok(counts.triage >= 1 && counts.evaluate >= 1, `${day}: both queues launched (${JSON.stringify(counts)})`)
    assert.ok(counts.triage + counts.evaluate <= 30, `${day}: within the ceiling`)
  }
  assert.deepEqual(perDay.get(dayText(0)), { triage: 4, evaluate: 26 })
  assert.deepEqual(perDay.get(dayText(1)), { triage: 4, evaluate: 26 })
  assert.equal((await ledgerOf(root)).spent, 30)
}))

test("crash_and_reset_never_refund", async (t) => {
  // Each case first spends 10 launches, then damages one witness. No case may answer `reserved` again that day.
  async function spentTen(env) {
    assert.deepEqual(await reserveMany(env, "evaluate", at(0, 9), 10), Array(10).fill("reserved"))
  }

  await t.test("a damaged ledger or guard blocks", () => scratch(async (env, root) => {
    await spentTen(env)
    await fs.writeFile(path.join(root, LEDGER_FILE), "{ damaged")
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "ledger_unreadable" })
    await scratch(async (other, otherRoot) => {
      await spentTen(other)
      await fs.writeFile(path.join(otherRoot, GUARD_FILE), JSON.stringify({ schema: "desk.factory.agent-launch-guard/1" }))
      assert.deepEqual(await reserve(other, "evaluate", at(0, 10)), { state: "ledger_unreadable" })
    })
  }))

  await t.test("a missing ledger or guard blocks and is not rebuilt", () => scratch(async (env, root) => {
    await spentTen(env)
    await fs.rename(path.join(root, LEDGER_FILE), path.join(root, "moved-ledger.json"))
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "ledger_missing" })
    assert.deepEqual(await reserve(env, "evaluate", at(5, 10)), { state: "ledger_missing" }, "a later day does not reset it either")
    await assert.rejects(fs.stat(path.join(root, LEDGER_FILE)), { code: "ENOENT" })
  }))

  await t.test("a missing or damaged status mark is written again from the pair, with today sealed as spent", () => scratch(async (env, root) => {
    await spentTen(env)
    assert.equal((await reserve(env, "triage", at(0, 9, 30))).state, "reserved")
    const before = await ledgerOf(root)
    await updateStatus(env, (current) => ({ ...current, loop: { ...current.loop, agent_launch_highwater: { schema: "desk.factory.agent-launch-highwater/1" } } }))
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "witness_reset_sealed" })
    const sealed = await ledgerOf(root)
    assert.equal(sealed.spent, 30, "nothing refunded: the rest of the day is spent")
    assert.equal(sealed.revision, before.revision + 1)
    assert.equal(sealed.epoch, before.epoch)
    assert.equal((await mark(env)).phase, "acknowledged", "all three witnesses agree again")
    assert.equal((await reserve(env, "evaluate", at(0, 11))).state, "quota_exhausted")
    // Removed outright, again and again the same day: each time the day is sealed, never a launch.
    for (const hour of [12, 13]) {
      await updateStatus(env, (current) => {
        const { agent_launch_highwater: _gone, ...loop } = current.loop
        return { ...current, loop }
      })
      assert.deepEqual(await reserve(env, "evaluate", at(0, hour)), { state: "witness_reset_sealed" })
    }
    assert.equal((await reserve(env, "triage", at(0, 14))).state, "quota_exhausted")
    assert.equal((await ledgerOf(root)).last_triage_at, new Date(at(0, 9, 30)).toISOString(), "the triage clock survives the reset")
    assert.equal((await reserve(env, "evaluate", at(1, 0, 5))).state, "reserved", "the next UTC day is a normal one")
  }))

  await t.test("a damaged mark beside a damaged or missing pair file still blocks", () => scratch(async (env, root) => {
    await spentTen(env)
    await updateStatus(env, (current) => ({ ...current, loop: { ...current.loop, agent_launch_highwater: "damaged" } }))
    await fs.writeFile(path.join(root, GUARD_FILE), "{ damaged")
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "ledger_unreadable" })
    await fs.rename(path.join(root, GUARD_FILE), path.join(root, "moved-guard.json"))
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "witness_invalid" })
    await updateStatus(env, (current) => {
      const { agent_launch_highwater: _gone, ...loop } = current.loop
      return { ...current, loop }
    })
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "witness_missing" })
    await assert.rejects(fs.stat(path.join(root, GUARD_FILE)), { code: "ENOENT" }, "nothing rebuilt from half a pair")
    await fs.rename(path.join(root, LEDGER_FILE), path.join(root, "moved-ledger.json"))
    await updateStatus(env, (current) => ({ ...current, loop: { ...current.loop, agent_launch_highwater: "damaged" } }))
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "witness_invalid" }, "a damaged mark with no pair at all is not a fresh install")
  }))

  await t.test("a lost mark beside an older guard of the same ledger is not resealed: the pair must agree", () => scratch(async (env, root) => {
    await reserveMany(env, "evaluate", at(0, 9), 2)
    const olderGuard = await fs.readFile(path.join(root, GUARD_FILE), "utf8")
    await reserveMany(env, "evaluate", at(0, 9), 2)
    await fs.writeFile(path.join(root, GUARD_FILE), olderGuard, { mode: 0o600 })
    await updateStatus(env, (current) => {
      const { agent_launch_highwater: _gone, ...loop } = current.loop
      return { ...current, loop }
    })
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "inconsistent" })
    assert.deepEqual(await reserve(env, "evaluate", at(1, 10)), { state: "inconsistent" }, "a later day does not clear it")
    assert.equal((await readStatus(env)).loop.agent_launch_highwater, undefined, "nothing is written from the pair")
  }))

  await t.test("the documented full reset clears a blocked ledger, keeps the day sealed with nothing refunded, and the next UTC day launches", () => scratch(async (env, root) => {
    // Reserve as the evaluator step does, passing the stored evaluator record.
    const r = async (kind, now) => reserveAgentLaunch(env, { kind, generation: null, now, legacyEvaluator: (await readStatus(env)).evaluator })
    // The evaluator record is from yesterday. Today: one triage launch, one evaluator launch that ran and one the runner reported as not
    // started (the evaluator's own count takes that one back, the ledger does not).
    await updateStatus(env, (current) => ({ ...current, evaluator: { headless: { state: "idle", day: dayText(-1), jobs: 7 } } }))
    assert.equal((await r("triage", at(0, 1))).state, "reserved")
    const ran = await r("evaluate", at(0, 1))
    const notStarted = await r("evaluate", at(0, 1))
    assert.equal((await finishAgentLaunch(env, { token: ran.token, state: "ran", now: at(0, 1) })).state, "recorded")
    assert.equal((await finishAgentLaunch(env, { token: notStarted.token, state: "not_started", now: at(0, 1) })).state, "recorded")
    await updateStatus(env, (current) => ({ ...current, evaluator: { headless: { state: "ran", day: dayText(0), jobs: 1 } } }))
    assert.equal((await r("triage", at(0, 2))).state, "window_used")
    const spentBefore = (await ledgerOf(root)).spent
    assert.equal(spentBefore, 3)
    // Blocked: an older guard of the same ledger put back beside the newer ledger and mark.
    await fs.writeFile(path.join(root, GUARD_FILE), (await readBytes(root)).guard.replace(/"revision": ?\d+/u, '"revision": 1'), { mode: 0o600 })
    assert.equal((await r("evaluate", at(0, 2))).state, "rollback_detected")
    // The repair exactly as "Repairing a blocked launch ledger" says: move both agent-launch-*.json files aside, and delete both
    // loop.agent_launch_highwater and evaluator.headless from status.json.
    await fs.rename(path.join(root, LEDGER_FILE), path.join(root, "agent-launch-ledger.json.aside"))
    await fs.rename(path.join(root, GUARD_FILE), path.join(root, "agent-launch-guard.json.aside"))
    await updateStatus(env, (current) => {
      const { agent_launch_highwater: _mark, ...loop } = current.loop
      const { headless: _headless, ...evaluator } = current.evaluator
      return { ...current, loop, evaluator }
    })
    // The same day: triage (in the window it already used, and in a later one) and evaluation are refused; nothing is given back.
    assert.equal((await r("triage", at(0, 3))).state, "quota_exhausted")
    assert.equal((await r("evaluate", at(0, 3))).state, "quota_exhausted")
    assert.equal((await r("triage", at(0, 13))).state, "quota_exhausted")
    const resetDay = await ledgerOf(root)
    assert.equal(resetDay.day, dayText(0))
    assert.equal(resetDay.spent, 30)
    assert.ok(resetDay.spent >= spentBefore, "no refund")
    // The next UTC day launches both kinds.
    assert.equal((await r("triage", at(1, 1))).state, "reserved")
    assert.equal((await r("evaluate", at(1, 1))).state, "reserved")
    assert.equal((await ledgerOf(root)).spent, 2)
  }))

  await t.test("a set-aside file older than the ledger does not move the seal off today", () => scratch(async (env, root) => {
    const aside = path.join(root, "status.json.corrupt-json-1")
    await fs.writeFile(aside, "{}")
    await fs.utimes(aside, new Date(at(-3, 1)), new Date(at(-3, 1)))
    await spentTen(env)
    await updateStatus(env, (current) => {
      const { agent_launch_highwater: _gone, ...loop } = current.loop
      return { ...current, loop }
    })
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "witness_reset_sealed" })
  }))

  await t.test("a pair from two ledgers, or dated after the clock, is not used to write the mark again", () => scratch(async (env, root) => {
    await spentTen(env)
    const guard = JSON.parse(await fs.readFile(path.join(root, GUARD_FILE), "utf8"))
    const clear = (current) => {
      const { agent_launch_highwater: _gone, ...loop } = current.loop
      return { ...current, loop }
    }
    await updateStatus(env, clear)
    assert.deepEqual(await reserve(env, "evaluate", at(0, 8)), { state: "clock_regressed" })
    await fs.writeFile(path.join(root, GUARD_FILE), `${JSON.stringify({ ...guard, epoch: "cd".repeat(16) })}\n`)
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "epoch_mismatch" })
    assert.equal(await mark(env), undefined)
  }))

  await t.test("a status file the reader sets aside seals that day; the next UTC day launches", () => scratch(async (env, root) => {
    const today = Date.now()
    const todayText = new Date(today).toISOString().slice(0, 10)
    assert.equal((await reserve(env, "evaluate", today, { legacyEvaluator: { headless: { day: todayText, jobs: 0 } } })).state, "reserved")
    await fs.writeFile(path.join(root, "status.json"), "{ damaged")
    assert.deepEqual(await reserve(env, "evaluate", today), { state: "witness_reset_sealed" })
    assert.deepEqual(await reserve(env, "evaluate", today), { state: "status_reset" }, "the rest of that day stays refused")
    await fs.writeFile(path.join(root, "status.json"), "{ damaged again")
    assert.deepEqual(await reserve(env, "evaluate", today), { state: "witness_reset_sealed" })
    const next = Date.parse(`${todayText}T00:00:00.000Z`) + DAY + 60 * 1000
    assert.equal((await reserve(env, "evaluate", next)).state, "reserved")
  }))

  await t.test("a reset noticed only on a later day seals the reset's own day, not the later one", () => scratch(async (env, root) => {
    const today = Date.now()
    const todayText = new Date(today).toISOString().slice(0, 10)
    assert.equal((await reserve(env, "evaluate", today, { legacyEvaluator: { headless: { day: todayText, jobs: 0 } } })).state, "reserved")
    // The status reader sets the damaged file aside today, but nothing reserves until the next day.
    await fs.writeFile(path.join(root, "status.json"), "{ damaged")
    await readStatus(env)
    const next = Date.parse(`${todayText}T00:00:00.000Z`) + DAY + 60 * 1000
    const answer = await reserve(env, "evaluate", next)
    assert.equal(answer.state, "reserved")
    assert.equal((await ledgerOf(root)).consumed_through, (await ledgerOf(root)).issued_serial, "older tokens are burned")
  }))

  await t.test("a mark or ledger dated after the clock blocks as a clock regression", () => scratch(async (env) => {
    await spentTen(env)
    assert.deepEqual(await reserve(env, "evaluate", at(0, 8)), { state: "clock_regressed" })
    assert.deepEqual(await reserve(env, "evaluate", at(-1, 23)), { state: "clock_regressed" })
    assert.equal((await mark(env)).max_clock_ms, at(0, 9))
  }))

  await t.test("a pair from another epoch blocks", () => scratch(async (env, root) => {
    const { ledger } = await forge(env, root, { spent: 3, evaluate: { launched: 3, ran: 0, failed: 0, not_started: 0, finished_revision: 0 } })
    await forge(env, root, { ...ledger, epoch: "cd".repeat(16) }, { witness: { epoch: "ab".repeat(16) } })
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "epoch_mismatch" })
    await forge(env, root, { ...ledger }, { guard: { epoch: "ef".repeat(16) } })
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "epoch_mismatch" })
  }))

  await t.test("a ledger symlink is never followed", { skip: NO_FILE_SYMLINKS }, () => scratch(async (env, root, base) => {
    await spentTen(env)
    const elsewhere = path.join(base, "elsewhere.json")
    await fs.rename(path.join(root, LEDGER_FILE), elsewhere)
    await fs.symlink(elsewhere, path.join(root, LEDGER_FILE))
    assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "ledger_unreadable" })
  }))

  await t.test("concurrent reservations never pass the ceiling", () => scratch(async (env, root) => {
    // At 23:00 the last window is still unused: evaluation may take 29.
    const states = await Promise.all(Array.from({ length: 34 }, () => reserve(env, "evaluate", at(0, 23)).then((answer) => answer.state)))
    assert.equal(states.filter((state) => state === "reserved").length, 29)
    assert.equal(states.filter((state) => state === "window_protected").length, 5)
    assert.equal((await ledgerOf(root)).spent, 29)
  }))
})

test("restore_matching_old_pair_never_refunds", () => scratch(async (env, root) => {
  // Revision 1 migrates 18 runs from today; 7 more make revision 8 with 25 spent.
  const legacyEvaluator = { headless: { day: dayText(0), jobs: 18 } }
  assert.deepEqual(await reserveMany(env, "evaluate", at(0, 18, 30), 1, { legacyEvaluator }), ["reserved"])
  await reserveMany(env, "evaluate", at(0, 18, 30), 6)
  const old = await readBytes(root)
  assert.equal(JSON.parse(old.ledger).revision, 8)
  assert.equal(JSON.parse(old.ledger).spent, 25)
  await reserveMany(env, "evaluate", at(0, 18, 31), 4)
  assert.equal((await reserve(env, "triage", at(0, 18, 32))).state, "reserved")
  assert.equal((await ledgerOf(root)).revision, 13)
  assert.equal((await ledgerOf(root)).spent, 30)
  // The independent status mark survives; the old pair is restored exactly.
  await restorePair(root, old)
  assert.deepEqual(await reserve(env, "evaluate", at(0, 19)), { state: "rollback_detected" })
  assert.deepEqual(await reserve(env, "triage", at(1, 1)), { state: "rollback_detected" }, "no later day refunds it either")
  assert.equal((await mark(env)).spent_at_max_day, 30)
  assert.equal((await mark(env)).max_revision, 13)
}))

test("a restored status mark is found by the newer pair that survived", () => scratch(async (env, root) => {
  await reserveMany(env, "evaluate", at(0, 9), 3)
  const oldMark = await mark(env)
  await reserveMany(env, "evaluate", at(0, 9), 3)
  await updateStatus(env, (current) => ({ ...current, loop: { ...current.loop, agent_launch_highwater: oldMark } }))
  assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "status_rollback" })
}))

test("a guard restored alone, or a pair that disagrees with the mark, blocks", () => scratch(async (env, root) => {
  await reserveMany(env, "evaluate", at(0, 9), 2)
  const old = await readBytes(root)
  await reserveMany(env, "evaluate", at(0, 9), 2)
  await fs.writeFile(path.join(root, GUARD_FILE), old.guard)
  assert.deepEqual(await reserve(env, "evaluate", at(0, 10)), { state: "rollback_detected" })
  await scratch(async (other, otherRoot) => {
    const { mark: forged } = await forge(other, otherRoot, { spent: 2, evaluate: { launched: 2, ran: 0, failed: 0, not_started: 0, finished_revision: 0 } })
    await updateStatus(other, (current) => ({ ...current, loop: { ...current.loop, agent_launch_highwater: { ...forged, spent_at_max_day: 1 } } }))
    assert.deepEqual(await reserve(other, "evaluate", at(0, 10)), { state: "inconsistent" })
  })
}))

test("higher_guard_recovery_retains_clock_highwater", () => scratch(async (env, root) => {
  await reserveMany(env, "evaluate", at(0, 9), 3)
  // A reservation at 11:00 crashes after its guard was renamed and flushed, before its ledger.
  assert.deepEqual(await faulty("guard_synced").reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 11), legacyEvaluator: LEGACY }), { state: "write_failed" })
  const guard = JSON.parse(await fs.readFile(path.join(root, GUARD_FILE), "utf8"))
  assert.equal(guard.last_clock_ms, at(0, 11))
  assert.equal((await ledgerOf(root)).last_clock_ms, at(0, 9))
  // Recovery at 10:30 refuses the earlier clock and keeps the 11:00 witness.
  assert.deepEqual(await reserve(env, "evaluate", at(0, 10, 30)), { state: "clock_regressed" })
  assert.equal((await mark(env)).max_clock_ms, at(0, 11))
  assert.equal((await mark(env)).phase, "pending")
  // At 11:30 the day is sealed as spent in a new witnessed revision; nothing launches and nothing is refunded.
  assert.equal((await reserve(env, "evaluate", at(0, 11, 30))).state, "quota_exhausted")
  const sealed = await ledgerOf(root)
  assert.equal(sealed.spent, 30)
  assert.equal(sealed.last_clock_ms, at(0, 11, 30))
  assert.equal(sealed.evaluate.launched, 3, "the unknown launch is not credited to a kind, and not counted as zero spend")
  assert.equal((await mark(env)).phase, "acknowledged")
  assert.equal((await reserve(env, "evaluate", at(1, 0, 1))).state, "reserved", "a strictly later UTC day starts again")
}))

test("interruption at every transaction point: no refund, and recovery or a sealed day", async (t) => {
  // What the next call sees after a crash at each point, with 2 launches already spent today.
  const expected = {
    before_witness_pending: { next: "reserved", spent: 3 },
    after_witness_pending: { next: "quota_exhausted", spent: 30 },
    guard_temp_written: { next: "quota_exhausted", spent: 30 },
    guard_renamed: { next: "quota_exhausted", spent: 30 },
    guard_synced: { next: "quota_exhausted", spent: 30 },
    ledger_temp_written: { next: "quota_exhausted", spent: 30 },
    ledger_renamed: { next: "reserved", spent: 4 },
    ledger_synced: { next: "reserved", spent: 4 },
    before_witness_acknowledged: { next: "reserved", spent: 4 },
    after_witness_acknowledged: { next: "reserved", spent: 4 },
  }
  assert.deepEqual(Object.keys(expected), FAULT_POINTS)
  for (const point of FAULT_POINTS) {
    await t.test(point, () => scratch(async (env, root) => {
      await reserveMany(env, "evaluate", at(0, 9), 2)
      const crashed = await faulty(point).reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 10), legacyEvaluator: LEGACY })
      assert.deepEqual(crashed, { state: "write_failed" }, "a crashed reservation never answers reserved, so nothing is launched")
      assert.equal((await reserve(env, "evaluate", at(0, 10, 1))).state, expected[point].next)
      assert.equal((await ledgerOf(root)).spent, expected[point].spent)
      const witness = await mark(env)
      assert.equal(witness.phase, "acknowledged")
      assert.equal(witness.spent_at_max_day, expected[point].spent)
      // Whatever happened, the next UTC day is a normal one.
      assert.equal((await reserve(env, "evaluate", at(1, 0, 5))).state, "reserved")
    }))
  }

  await t.test("a crash in the very first transaction seals that day", async () => {
    for (const point of ["after_witness_pending", "guard_synced"]) {
      await scratch(async (env, root) => {
        assert.deepEqual(await faulty(point).reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 9), legacyEvaluator: LEGACY }), { state: "write_failed" })
        assert.equal((await reserve(env, "evaluate", at(0, 9, 1))).state, "quota_exhausted")
        assert.equal((await ledgerOf(root)).spent, 30)
      })
    }
  })

  await t.test("a crash while recovering is recovered again", () => scratch(async (env, root) => {
    await reserveMany(env, "evaluate", at(0, 9), 2)
    await faulty("guard_synced").reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 10), legacyEvaluator: LEGACY })
    // The recovery's own transaction stops after its guard: the guard is now two revisions ahead of the ledger.
    assert.deepEqual(await faulty("guard_synced").reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 10, 1) }), { state: "write_failed" })
    assert.equal((await reserve(env, "evaluate", at(0, 10, 2))).state, "quota_exhausted")
    assert.equal((await ledgerOf(root)).spent, 30)
  }))

  await t.test("a triage reservation that stops after its guard seals the day and keeps its triage clock", () => scratch(async (env, root) => {
    assert.equal((await reserve(env, "triage", at(0, 1))).state, "reserved")
    await faulty("guard_synced").reserveAgentLaunch(env, { kind: "triage", now: at(0, 7), legacyEvaluator: LEGACY })
    assert.equal((await reserve(env, "evaluate", at(0, 8))).state, "quota_exhausted")
    const ledger = await ledgerOf(root)
    assert.equal(ledger.last_triage_at, new Date(at(0, 7)).toISOString(), "the crashed launch's time is witnessed, so its gap holds")
    assert.deepEqual(ledger.windows, [1, 1, 0, 0])
    assert.equal((await reserve(env, "triage", at(1, 0, 59))).state, "reserved", "the next day starts normally")
  }))

  await t.test("a later-day recovery that itself stops leaves an older-day guard that is still recovered", () => scratch(async (env, root) => {
    await reserveMany(env, "evaluate", at(0, 9), 2)
    await faulty("guard_synced").reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 10), legacyEvaluator: LEGACY })
    // On the next day the recovery's own transaction stops after its pending mark: the guard is from the day before.
    assert.deepEqual(await faulty("after_witness_pending").reserveAgentLaunch(env, { kind: "evaluate", now: at(1, 1) }), { state: "write_failed" })
    assert.equal((await mark(env)).max_day, dayText(1))
    assert.equal((await reserve(env, "evaluate", at(1, 2))).state, "quota_exhausted", "the pending day is sealed in turn")
    assert.equal((await ledgerOf(root)).day, dayText(1))
  }))

  await t.test("a recovery on a later UTC day starts that day with older tokens burned", () => scratch(async (env, root) => {
    await reserve(env, "evaluate", at(0, 8))
    const basis = { ...evaluationContinuationBasis({}), ready_now: 1 }
    const { token } = await createEvaluationContinuation(env, { generation: "g-1", expectedEvaluation: basis, now: at(0, 9) })
    await faulty("guard_synced").reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 10), legacyEvaluator: LEGACY })
    assert.equal((await reserve(env, "evaluate", at(1, 2))).state, "reserved")
    const ledger = await ledgerOf(root)
    assert.equal(ledger.spent, 1)
    assert.equal(ledger.consumed_through, token.serial)
    assert.deepEqual(ledger.continuations, [])
  }))

  await t.test("an unknown status-write outcome is not taken as nothing written", () => scratch(async (env, root) => {
    await reserveMany(env, "evaluate", at(0, 9), 2)
    // The status write lands, then the writer fails: the caller cannot tell which happened.
    let calls = 0
    const ledger = createHeadlessLedger({
      updateStatus: async (...args) => {
        const written = await updateStatus(...args)
        calls += 1
        if (calls === 1) throw new Error("lost answer")
        return written
      },
    })
    assert.deepEqual(await ledger.reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 10) }), { state: "write_failed" })
    assert.equal((await reserve(env, "evaluate", at(0, 10, 1))).state, "quota_exhausted")
    assert.equal((await ledgerOf(root)).spent, 30)
  }))

  await t.test("a guard ahead of what the pending mark witnessed blocks", () => scratch(async (env, root) => {
    await reserveMany(env, "evaluate", at(0, 9), 2)
    await faulty("guard_synced").reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 10), legacyEvaluator: LEGACY })
    const guard = JSON.parse(await fs.readFile(path.join(root, GUARD_FILE), "utf8"))
    await fs.writeFile(path.join(root, GUARD_FILE), `${JSON.stringify({ ...guard, spent: guard.spent + 1 })}\n`)
    assert.deepEqual(await reserve(env, "evaluate", at(0, 11)), { state: "inconsistent" })
  }))

  await t.test("a pending mark beside a ledger it never acknowledged blocks", () => scratch(async (env, root) => {
    await reserveMany(env, "evaluate", at(0, 9), 2)
    const old = await readBytes(root)
    await reserveMany(env, "evaluate", at(0, 9), 1)
    await faulty("after_witness_pending").reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 10), legacyEvaluator: LEGACY })
    await restorePair(root, old)
    assert.deepEqual(await reserve(env, "evaluate", at(0, 11)), { state: "rollback_detected" })
    await scratch(async (other, otherRoot) => {
      await faulty("after_witness_pending").reserveAgentLaunch(other, { kind: "evaluate", now: at(0, 9), legacyEvaluator: LEGACY })
      const pending = await mark(other)
      await forge(other, otherRoot, { epoch: pending.epoch, revision: 1, last_clock_ms: at(0, 8) }, { witness: pending })
      assert.deepEqual(await reserve(other, "evaluate", at(0, 11)), { state: "inconsistent" })
    })
  }))
})

test("coordinated restoration of all three witnesses is outside the detectable boundary", () => scratch(async (env, root) => {
  // Not a detection claim: with every witness restored together, this machine has nothing left that remembers the later launches.
  await reserveMany(env, "evaluate", at(0, 20), 25)
  const snapshot = { ...(await readBytes(root)), status: await fs.readFile(path.join(root, "status.json"), "utf8") }
  await reserveMany(env, "evaluate", at(0, 20), 4)
  assert.equal((await reserve(env, "evaluate", at(0, 20, 1))).state, "window_protected")
  await restorePair(root, snapshot)
  await fs.writeFile(path.join(root, "status.json"), snapshot.status)
  assert.equal((await reserve(env, "evaluate", at(0, 20, 2))).state, "reserved", "the documented limit: no outside authority, no detection")
}))

test("consume_crash_old_token_never_replays", async (t) => {
  const basis = { ...evaluationContinuationBasis({}), ready_now: 2 }

  await t.test("an older pair restored after consumption, with the newer mark surviving, cannot replay the token", () => scratch(async (env, root) => {
    await reserve(env, "evaluate", at(0, 9))
    const { state, token } = await createEvaluationContinuation(env, { generation: "gen-1", expectedEvaluation: basis, now: at(0, 9) })
    assert.equal(state, "issued")
    const old = await readBytes(root)
    assert.deepEqual(await consumeEvaluationContinuation(env, { token, now: at(0, 10), status: { evaluator: { ready_now: 2 } } }), { state: "consumed" })
    assert.deepEqual(await consumeEvaluationContinuation(env, { token, now: at(0, 10), status: { evaluator: { ready_now: 2 } } }), { state: "already_consumed" })
    await restorePair(root, old)
    assert.deepEqual(await consumeEvaluationContinuation(env, { token, now: at(0, 11), status: { evaluator: { ready_now: 2 } } }), { state: "rollback_detected" })
    assert.equal((await mark(env)).consumed_through, token.serial)
  }))

  await t.test("a crash while consuming burns the token rather than replays it", async () => {
    for (const point of ["after_witness_pending", "guard_synced", "ledger_synced"]) {
      await scratch(async (env) => {
        await reserve(env, "evaluate", at(0, 9))
        const { token } = await createEvaluationContinuation(env, { generation: "gen-1", expectedEvaluation: basis, now: at(0, 9) })
        assert.deepEqual(await faulty(point).consumeEvaluationContinuation(env, { token, now: at(0, 10), status: { evaluator: { ready_now: 2 } } }), { state: "write_failed" })
        assert.deepEqual(await consumeEvaluationContinuation(env, { token, now: at(0, 10, 1), status: { evaluator: { ready_now: 2 } } }), { state: "already_consumed" }, point)
      })
    }
  })

  await t.test("tokens are checked for epoch, issue and basis", () => scratch(async (env) => {
    await reserve(env, "evaluate", at(0, 9))
    assert.deepEqual(await createEvaluationContinuation(env, { generation: "gen-0", expectedEvaluation: evaluationContinuationBasis({}), now: at(0, 9) }), { state: "not_runnable" })
    const first = await createEvaluationContinuation(env, { generation: "gen-1", expectedEvaluation: basis, now: at(0, 9) })
    assert.deepEqual(await createEvaluationContinuation(env, { generation: "gen-1", expectedEvaluation: basis, now: at(0, 9) }), { state: "exists", token: first.token })
    const second = await createEvaluationContinuation(env, { generation: "gen-2", expectedEvaluation: basis, now: at(0, 9) })
    assert.equal(second.token.serial, first.token.serial + 1)
    const status = { evaluator: { ready_now: 2 } }
    assert.deepEqual(await consumeEvaluationContinuation(env, { token: first.token, now: at(0, 9), status }), { state: "unknown_token" }, "a newer token replaced it")
    assert.deepEqual(await consumeEvaluationContinuation(env, { token: { ...second.token, epoch: "00".repeat(16) }, now: at(0, 9), status }), { state: "wrong_epoch" })
    assert.deepEqual(await consumeEvaluationContinuation(env, { token: { ...second.token, serial: 99 }, now: at(0, 9), status }), { state: "unknown_token" })
    assert.deepEqual(await consumeEvaluationContinuation(env, { token: second.token, now: at(0, 9), status: { evaluator: { ready_now: 1 } } }), { state: "eligibility_changed" })
    assert.deepEqual(await consumeEvaluationContinuation(env, { token: second.token, now: at(0, 9), status }), { state: "already_consumed" }, "a changed basis cancels the token")
  }))
})

test("triage_deferral_is_not_failure_cooldown", () => scratch(async (env) => {
  await reserve(env, "evaluate", at(0, 8))
  const ranAt = new Date(at(0, 8))
  await recordStep(env, "evaluate", { ok: true, result: "ran", now: ranAt })
  await updateStatus(env, (current) => ({ ...current, evaluator: { ready_now: 1, ready_later: 0, accepted_last_step: 1, headless: { day: dayText(0), jobs: 1 } } }))
  const before = await readStatus(env)
  // Triage takes the slot at 08:30: evaluation is deferred, not attempted. Its step record and counters stay as they were.
  assert.equal((await reserve(env, "triage", at(0, 8, 30))).state, "reserved")
  const { token } = await createEvaluationContinuation(env, { generation: "gen-triage", expectedEvaluation: evaluationContinuationBasis(before), now: at(0, 8, 30) })
  const after = await readStatus(env)
  assert.deepEqual(after.loop.steps.evaluate, before.loop.steps.evaluate, "no evaluation step or attempt stamped by the deferral")
  assert.deepEqual(after.evaluator, before.evaluator)
  assert.equal(evaluateDue(after, at(0, 8, 31)), true, "a draining queue stays due after a mere deferral")
  assert.deepEqual(await consumeEvaluationContinuation(env, { token, now: at(0, 8, 31), status: after }), { state: "consumed" })

  // A genuine failure is different: it changes the basis, and its own gap applies; a continuation minted before it is refused.
  const { token: later } = await createEvaluationContinuation(env, { generation: "gen-triage-2", expectedEvaluation: evaluationContinuationBasis(after), now: at(0, 8, 32) })
  await recordStep(env, "evaluate", { ok: false, result: "step_error", now: new Date(at(0, 8, 33)) })
  const failed = await readStatus(env)
  assert.equal(evaluateDue(failed, at(0, 8, 40)), false, "the failure's gap holds")
  assert.deepEqual(await consumeEvaluationContinuation(env, { token: later, now: at(0, 8, 41), status: failed }), { state: "eligibility_changed" })
}))

test("finishAgentLaunch adds outcome evidence only", () => scratch(async (env, root) => {
  const first = await reserve(env, "evaluate", at(0, 9))
  const second = await reserve(env, "triage", at(0, 9))
  assert.deepEqual(await finishAgentLaunch(env, { token: first.token, state: "ran", now: at(0, 9, 10) }), { state: "recorded" })
  assert.deepEqual(await finishAgentLaunch(env, { token: first.token, state: "failed", now: at(0, 9, 10) }), { state: "stale_token" }, "once per launch")
  assert.deepEqual(await finishAgentLaunch(env, { token: second.token, state: "not_started", now: at(0, 9, 11) }), { state: "recorded" })
  const ledger = await ledgerOf(root)
  assert.equal(ledger.spent, 2, "a launch that did not start stays spent")
  assert.deepEqual(ledger.evaluate, { launched: 1, ran: 1, failed: 0, not_started: 0, finished_revision: first.token.revision })
  assert.deepEqual(ledger.triage, { launched: 1, ran: 0, failed: 0, not_started: 1, finished_revision: second.token.revision })
  assert.deepEqual(ledger.windows, [0, 1, 0, 0])
  assert.deepEqual(await finishAgentLaunch(env, { token: { ...first.token, epoch: "00".repeat(16) }, state: "ran", now: at(0, 9, 12) }), { state: "stale_token" })
  assert.deepEqual(await finishAgentLaunch(env, { token: { ...first.token, revision: 999 }, state: "ran", now: at(0, 9, 12) }), { state: "stale_token" })
  assert.deepEqual(await finishAgentLaunch(env, { token: { ...first.token, revision: ledger.revision }, state: "ran", now: at(0, 9, 12) }), { state: "stale_token" }, "not a reservation of this kind")
  const third = await reserve(env, "evaluate", at(0, 23))
  assert.deepEqual(await finishAgentLaunch(env, { token: third.token, state: "failed", now: at(1, 0, 1) }), { state: "day_closed" }, "its day's counts are closed; the launch stays spent")
  assert.deepEqual(await finishAgentLaunch(env, { token: third.token, state: "failed", now: at(0, 1) }), { state: "clock_regressed" })
}))

test("contract violations throw", async () => {
  await assert.rejects(reserveAgentLaunch({}, { kind: "other", now: at(0, 1) }), TypeError)
  await assert.rejects(reserveAgentLaunch({}, { kind: "evaluate", generation: "bad generation", now: at(0, 1) }), TypeError)
  await assert.rejects(reserveAgentLaunch({}, { kind: "evaluate", now: "not a time" }), TypeError)
  await assert.rejects(reserveAgentLaunch({}, { kind: "evaluate", now: null }), TypeError)
  await assert.rejects(reserveAgentLaunch({}), TypeError)
  await assert.rejects(finishAgentLaunch({}, { token: {}, state: "ran", now: at(0, 1) }), TypeError)
  await assert.rejects(finishAgentLaunch({}, { token: null, state: "ran", now: at(0, 1) }), TypeError)
  await assert.rejects(finishAgentLaunch({}, { token: { kind: "evaluate", revision: 1, epoch: "x", day: 1 }, state: "ran", now: at(0, 1) }), TypeError)
  await assert.rejects(finishAgentLaunch({}), TypeError)
  await assert.rejects(createEvaluationContinuation({}, { generation: "", expectedEvaluation: evaluationContinuationBasis({}), now: at(0, 1) }), TypeError)
  await assert.rejects(createEvaluationContinuation({}, { generation: "g", expectedEvaluation: { ready_now: 1 }, now: at(0, 1) }), TypeError)
  await assert.rejects(createEvaluationContinuation({}), TypeError)
  await assert.rejects(consumeEvaluationContinuation({}, { token: { serial: "1", epoch: "x" }, now: at(0, 1) }), TypeError)
  await assert.rejects(consumeEvaluationContinuation({}, { token: null, now: at(0, 1) }), TypeError)
  await assert.rejects(consumeEvaluationContinuation({}), TypeError)
  const reserved = await scratch((env) => reserveAgentLaunch(env, { kind: "evaluate", now: new Date(at(0, 1)), legacyEvaluator: LEGACY }))
  assert.equal(reserved.state, "reserved", "a Date is a time too")
  const iso = await scratch((env) => reserveAgentLaunch(env, { kind: "evaluate", now: new Date(at(0, 1)).toISOString(), legacyEvaluator: LEGACY }))
  assert.equal(iso.state, "reserved")
})

test("the basis and quota readers", () => {
  assert.deepEqual(evaluationContinuationBasis(undefined), { last_ran_at: null, last_result: null, ready_now: 0, ready_later: 0, headless_day: null, accepted_last_step: 0 })
  assert.deepEqual(evaluationContinuationBasis({ evaluator: { ready_now: 2, ready_later: -1, accepted_last_step: 1, headless: { day: "2030-03-10" } }, loop: { steps: { evaluate: { last_ran_at: "x", last_result: "ran" } } } }), { last_ran_at: "x", last_result: "ran", ready_now: 2, ready_later: 0, headless_day: "2030-03-10", accepted_last_step: 1 })
  const witness = { schema: "desk.factory.agent-launch-highwater/1", epoch: "ab".repeat(16), max_revision: 3, max_acknowledged_revision: 3, max_day: dayText(0), spent_at_max_day: 25, max_clock_ms: at(0, 1), windows: [0, 0, 0, 0], last_triage_at: null, max_issued_serial: 0, consumed_through: 0, target_sha256: "0".repeat(64), phase: "acknowledged" }
  const status = (mark) => ({ loop: { agent_launch_highwater: mark } })
  assert.equal(evaluationQuotaOpen({}, at(0, 2)), true, "no mark yet: the step decides")
  assert.equal(evaluationQuotaOpen(undefined, at(0, 2)), true)
  assert.equal(evaluationQuotaOpen(status(witness), at(0, 2)), true, "25 + 1 <= 26")
  assert.equal(evaluationQuotaOpen(status({ ...witness, spent_at_max_day: 26 }), at(0, 2)), false)
  assert.equal(evaluationQuotaOpen(status({ ...witness, spent_at_max_day: 26 }), at(0, 6)), true, "an expired window returns")
  assert.equal(evaluationQuotaOpen(status({ ...witness, spent_at_max_day: 30 }), at(1, 0)), true, "a new day")
  assert.equal(evaluationQuotaOpen(status({ ...witness, max_day: dayText(1) }), at(0, 2)), false, "a mark dated later")
  assert.equal(evaluationQuotaOpen(status({ ...witness, max_clock_ms: at(0, 3) }), at(0, 2)), false)
  assert.equal(evaluationQuotaOpen(status({ ...witness, phase: "unknown" }), at(0, 2)), true, "a damaged mark is left to the reservation, which may reseal it")
  assert.equal(evaluationQuotaOpen(status({ ...witness, phase: "pending" }), at(0, 2)), true, "pending must lag its acknowledged revision, or the mark is damaged")
  assert.equal(evaluationQuotaOpen(status({ ...witness, phase: "pending", max_acknowledged_revision: 2 }), at(0, 2)), true)
  assert.equal(evaluationQuotaOpen({ loop: "damaged" }, at(0, 2)), true)
  assert.equal(validWitness({ ...witness, epoch: "x" }), false)
  assert.equal(validWitness({ ...witness, max_revision: 0, max_acknowledged_revision: 0 }), false)
  assert.equal(validWitness({ ...witness, max_acknowledged_revision: 4 }), false)
  assert.equal(validWitness({ ...witness, target_sha256: "x" }), false)
  assert.equal(validWitness({ ...witness, last_triage_at: "2030-03-10" }), false)
  assert.equal(validWitness({ ...witness, last_triage_at: new Date(at(0, 2)).toISOString() }), false, "a triage after the clock")
  assert.equal(validWitness({ ...witness, windows: [0, 0, 0] }), false)
  assert.equal(validWitness({ ...witness, windows: [1, 1, 0, 0], spent_at_max_day: 1 }), false)
  assert.equal(validWitness({ ...witness, max_day: "2030-02-30" }), false)
  assert.equal(validWitness({ ...witness, max_clock_ms: at(1, 1) }), false, "a clock after its day")
  assert.equal(validWitness({ ...witness, spent_at_max_day: 31 }), false)
  assert.equal(validWitness({ ...witness, consumed_through: 1 }), false)
  assert.equal(validWitness({ ...witness, extra: 1 }), false)
  assert.equal(validWitness({ ...witness, schema: "other" }), false)
  const kind = { launched: 0, ran: 0, failed: 0, not_started: 0, finished_revision: 0 }
  const ledger = { schema: "desk.factory.agent-launch-ledger/1", epoch: "ab".repeat(16), revision: 1, day: dayText(0), last_clock_ms: at(0, 1), spent: 1, evaluate: { ...kind, launched: 1 }, triage: kind, windows: [0, 0, 0, 0], last_triage_at: null, issued_serial: 1, consumed_through: 0, continuations: [{ epoch: "ab".repeat(16), serial: 1, generation: "g", expected_evaluation: "0".repeat(64) }] }
  assert.equal(validLedger(ledger), true)
  assert.equal(validLedger({ ...ledger, revision: 0 }), false)
  assert.equal(validLedger({ ...ledger, schema: "other" }), false)
  assert.equal(validLedger({ ...ledger, evaluate: { ...kind, launched: 1, ran: 2 } }), false)
  assert.equal(validLedger({ ...ledger, evaluate: { ...kind, launched: -1 } }), false)
  assert.equal(validLedger({ ...ledger, evaluate: { ...kind, launched: 2 } }), false, "more launches than spent")
  assert.equal(validLedger({ ...ledger, triage: "x" }), false)
  assert.equal(validLedger({ ...ledger, continuations: "x" }), false)
  assert.equal(validLedger({ ...ledger, continuations: [ledger.continuations[0], ledger.continuations[0]] }), false)
  for (const token of [{ ...ledger.continuations[0], epoch: "cd".repeat(16) }, { ...ledger.continuations[0], serial: 0 }, { ...ledger.continuations[0], serial: 2 }, { ...ledger.continuations[0], serial: 1.5 }, { ...ledger.continuations[0], generation: 1 }, { ...ledger.continuations[0], generation: "a b" }, { ...ledger.continuations[0], expected_evaluation: 1 }, { ...ledger.continuations[0], expected_evaluation: "x" }, { ...ledger.continuations[0], extra: 1 }]) {
    assert.equal(validLedger({ ...ledger, continuations: [token] }), false, JSON.stringify(token))
  }
  const guard = { schema: "desk.factory.agent-launch-guard/1", epoch: ledger.epoch, revision: 1, day: ledger.day, last_clock_ms: ledger.last_clock_ms, spent: 1, windows: [0, 0, 0, 0], last_triage_at: null, issued_serial: 1, consumed_through: 0, ledger_sha256: "0".repeat(64) }
  assert.equal(validGuard(guard), true)
  assert.equal(validGuard({ ...guard, revision: 0 }), false)
  assert.equal(validGuard({ ...guard, schema: "x" }), false)
  assert.equal(validGuard({ ...guard, ledger_sha256: 1 }), false)
  assert.equal(validGuard({ ...guard, ledger_sha256: "x" }), false)
  assert.equal(validGuard({ ...guard, day: 1 }), false)
  assert.equal(validGuard({ ...guard, epoch: 1 }), false)
  assert.equal(validGuard({ ...guard, last_clock_ms: -1 }), false)
  assert.equal(validGuard({ ...guard, spent: "1" }), false)
  assert.equal(validGuard({ ...guard, windows: "x" }), false)
  assert.equal(validGuard({ ...guard, windows: [0, 0, 0, 2] }), false)
  assert.equal(validGuard({ ...guard, last_triage_at: 5 }), false)
  assert.equal(validGuard({ ...guard, issued_serial: -1 }), false)
  assert.equal(validGuard({ ...guard, consumed_through: -1 }), false)
  assert.equal(validGuard({ ...guard, consumed_through: 2 }), false)
  assert.equal(validGuard([]), false)
  const rolled = { day: dayText(0), spent: 0, windows: [0, 0, 0, 0], last_triage_at: null }
  assert.deepEqual(quotaFor(rolled, "triage", at(0, 1)), { state: "ok", remaining: 29 })
  assert.deepEqual(quotaFor({ ...rolled, spent: 30 }, "evaluate", at(0, 1)), { state: "quota_exhausted", remaining: 0 })
})

test("file writes on Windows wait out a busy rename and skip the folder flush", () => scratch(async (env, root) => {
  let refusals = 0
  const ledger = createHeadlessLedger({
    platform: "win32",
    rename: async (from, to) => {
      if (refusals < 2) {
        refusals += 1
        throw Object.assign(new Error("busy"), { code: "EBUSY" })
      }
      return fs.rename(from, to)
    },
  })
  assert.equal((await ledger.reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 1), legacyEvaluator: LEGACY })).state, "reserved")
  assert.equal(refusals, 2)
  assert.equal((await ledgerOf(root)).spent, 1)
}))

test("a rename that fails for good, or a readback that differs, launches nothing", async (t) => {
  await t.test("a refused rename leaves no temporary file and answers write_failed", () => scratch(async (env, root) => {
    await reserve(env, "evaluate", at(0, 1))
    const refused = createHeadlessLedger({ rename: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) } })
    assert.deepEqual(await refused.reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 2) }), { state: "write_failed" })
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith(".tmp-")), [])
  }))

  await t.test("a Windows refusal that outlasts the wait fails", () => scratch(async (env) => {
    const refused = createHeadlessLedger({ platform: "win32", rename: async () => { throw Object.assign(new Error("busy"), { code: "EPERM" }) } })
    assert.deepEqual(await refused.reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 2), legacyEvaluator: LEGACY }), { state: "write_failed" })
  }))

  await t.test("a file that reads back other bytes fails", () => scratch(async (env) => {
    await reserve(env, "evaluate", at(0, 1))
    const changed = createHeadlessLedger({ rename: async (from, to) => { await fs.rename(from, to); await fs.appendFile(to, " ") } })
    assert.deepEqual(await changed.reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 2) }), { state: "write_failed" })
  }))

  await t.test("a status mark that reads back otherwise fails", async () => {
    // Reads in order: the witnesses, the pending readback, the acknowledged readback.
    for (const [failing, loop] of [[2, {}], [3, "damaged"]]) {
      await scratch(async (env) => {
        await reserve(env, "evaluate", at(0, 1))
        let reads = 0
        const blind = createHeadlessLedger({ readStatus: async (...args) => { reads += 1; const status = await readStatus(...args); return reads === failing ? { ...status, loop } : status } })
        assert.deepEqual(await blind.reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 2) }), { state: "write_failed" })
      })
    }
  })

  await t.test("a status mark changed by someone else mid-transaction fails", () => scratch(async (env) => {
    await reserve(env, "evaluate", at(0, 1))
    const racing = createHeadlessLedger({
      fault: async (point) => {
        if (point === "before_witness_pending") await updateStatus(env, (current) => ({ ...current, loop: { ...current.loop, agent_launch_highwater: { ...current.loop.agent_launch_highwater, max_clock_ms: at(0, 1, 30) } } }))
      },
    })
    assert.deepEqual(await racing.reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 2) }), { state: "write_failed" })
  }))

  await t.test("a lock broken between settling and committing never answers more reservations than the ledger spent", () => scratch(async (env, root) => {
    const answers = [(await reserve(env, "evaluate", at(0, 1))).state]
    let reads = 0
    const racing = createHeadlessLedger({
      readStatus: async (...args) => {
        reads += 1
        // The status read right before this transaction's commit (after settling): another process breaks the stale lock and reserves.
        if (reads === 2) {
          await fs.rm(path.join(root, "locks", "agent-launch-ledger.lock"), { force: true })
          answers.push((await reserve(env, "evaluate", at(0, 2))).state)
        }
        return readStatus(...args)
      },
    })
    const mine = await racing.reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 2), legacyEvaluator: LEGACY })
    answers.push(mine.state)
    assert.equal(mine.state, "write_failed", "this transaction's status write sees the other writer and fails")
    const reserved = answers.filter((state) => state === "reserved").length
    // The other process found this one's pending mark and sealed the day: more spent than launched, never fewer.
    assert.ok((await ledgerOf(root)).spent >= reserved, `${reserved} reserved answers, ${(await ledgerOf(root)).spent} spent`)
  }))

  await t.test("a final readback that disagrees answers readback_mismatch", () => scratch(async (env, root) => {
    await reserve(env, "evaluate", at(0, 1))
    const swapped = createHeadlessLedger({
      fault: async (point) => {
        if (point === "after_witness_acknowledged") await fs.writeFile(path.join(root, LEDGER_FILE), "{ damaged")
      },
    })
    assert.deepEqual(await swapped.reserveAgentLaunch(env, { kind: "evaluate", now: at(0, 2) }), { state: "readback_mismatch" })
  }))

  await t.test("a status file set aside during the transaction answers readback_mismatch", () => scratch(async (env, root) => {
    const today = Date.now()
    await reserve(env, "evaluate", today, { legacyEvaluator: { headless: { day: new Date(today).toISOString().slice(0, 10), jobs: 0 } } })
    const asideMidway = createHeadlessLedger({
      fault: async (point) => {
        if (point === "after_witness_acknowledged") await fs.writeFile(path.join(root, "status.json.corrupt-json-1"), "{}")
      },
    })
    assert.deepEqual(await asideMidway.reserveAgentLaunch(env, { kind: "evaluate", now: today }), { state: "readback_mismatch" })
  }))
})

test("a triage qualification reserves and finishes both launches together", () => scratch(async (env, root) => {
  const pair = await reserve(env, "triage", at(0, 9), { launches: 2 })
  assert.equal(pair.state, "reserved")
  assert.equal(pair.token.launches, 2)
  let ledger = await ledgerOf(root)
  assert.equal(ledger.spent, 2)
  assert.equal(ledger.triage.launched, 2)
  assert.deepEqual(ledger.windows, [0, 1, 0, 0], "it uses the window's one triage opportunity")
  assert.deepEqual(await finishAgentLaunch(env, { token: pair.token, state: "failed", now: at(0, 9, 5) }), { state: "recorded" })
  ledger = await ledgerOf(root)
  assert.deepEqual(ledger.triage, { launched: 2, ran: 0, failed: 2, not_started: 0, finished_revision: pair.token.revision })
  assert.deepEqual(await finishAgentLaunch(env, { token: pair.token, state: "ran", now: at(0, 9, 6) }), { state: "stale_token" }, "once")
  assert.deepEqual(await finishAgentLaunch(env, { token: { ...pair.token, launches: undefined }, state: "ran", now: at(0, 9, 6) }), { state: "stale_token" })
}))

test("a qualification needs room for both launches", () => scratch(async (env, root) => {
  await forge(env, root, { spent: 29 })
  assert.deepEqual(await reserve(env, "triage", at(0, 9), { launches: 2 }), { state: "quota_exhausted", day: dayText(0), remaining: 0, retry_at: new Date(at(1, 0)).toISOString() })
  const one = await reserve(env, "triage", at(0, 9))
  assert.equal(one.state, "reserved", "a single triage launch still fits")
  assert.equal(one.token.launches, undefined)
}))

test("a two-launch refusal says when it could pass, and a peek answers the same without writing", () => scratch(async (env, root) => {
  assert.deepEqual(await peekAgentLaunch(env, { kind: "triage", launches: 2, now: at(0, 9) }), { state: "unknown" }, "no ledger yet: the reservation decides")
  assert.equal((await reserve(env, "triage", at(0, 9), { launches: 2 })).state, "reserved")
  const before = await readBytes(root)
  const marked = await mark(env)
  // The window is used until 12:00, and the cooldown runs to 15:00.
  assert.deepEqual(await peekAgentLaunch(env, { kind: "triage", launches: 2, now: at(0, 10) }), { state: "window_used", retry_at: new Date(at(0, 12)).toISOString() })
  assert.deepEqual(await peekAgentLaunch(env, { kind: "triage", launches: 2, now: at(0, 13) }), { state: "triage_cooldown", retry_at: new Date(at(0, 15)).toISOString() })
  assert.deepEqual(await peekAgentLaunch(env, { kind: "triage", launches: 2, now: at(0, 16) }), { state: "ok" })
  assert.deepEqual(await peekAgentLaunch(env, { kind: "evaluate", now: at(0, 10) }), { state: "ok" })
  assert.deepEqual(await readBytes(root), before, "a peek writes nothing")
  assert.deepEqual(await mark(env), marked)
  const refused = await reserve(env, "triage", at(0, 10), { launches: 2 })
  assert.deepEqual(refused, { state: "window_used", day: dayText(0), remaining: 0, retry_at: new Date(at(0, 12)).toISOString() })
  assert.deepEqual(await reserve(env, "triage", at(0, 13), { launches: 2 }), { state: "triage_cooldown", day: dayText(0), remaining: 0, retry_at: new Date(at(0, 15)).toISOString() })
  assert.deepEqual(await reserve(env, "triage", at(0, 13)), { state: "triage_cooldown", day: dayText(0), remaining: 0 }, "a single-launch refusal is unchanged")
  // A clock behind the ledger's is read as the ledger's, as a reservation reads it.
  assert.equal((await peekAgentLaunch(env, { kind: "triage", now: at(0, 8) })).state, "window_used")
  await forge(env, root, { spent: 29 })
  assert.deepEqual(await peekAgentLaunch(env, { kind: "triage", launches: 2, now: at(0, 23) }), { state: "quota_exhausted", retry_at: new Date(at(1, 0)).toISOString() })
  assert.deepEqual(await peekAgentLaunch(env, { kind: "evaluate", now: at(0, 23) }), { state: "window_protected", retry_at: new Date(at(1, 0)).toISOString() })
  await fs.writeFile(path.join(root, LEDGER_FILE), "not json", { mode: 0o600 })
  assert.deepEqual(await peekAgentLaunch(env, { kind: "triage", now: at(0, 23) }), { state: "unknown" })
  await assert.rejects(peekAgentLaunch(env, { kind: "other", now: at(0, 1) }), TypeError)
  await assert.rejects(peekAgentLaunch(env, { kind: "evaluate", launches: 2, now: at(0, 1) }), TypeError)
  await assert.rejects(peekAgentLaunch(env), TypeError)
}))

test("launches is 1, or 2 for triage only", async () => {
  await assert.rejects(reserveAgentLaunch({}, { kind: "evaluate", launches: 2, now: at(0, 1) }), TypeError)
  await assert.rejects(reserveAgentLaunch({}, { kind: "triage", launches: 3, now: at(0, 1) }), TypeError)
  await assert.rejects(finishAgentLaunch({}, { token: { kind: "triage", revision: 1, epoch: "x", day: "d", launches: 3 }, state: "ran", now: at(0, 1) }), TypeError)
})
