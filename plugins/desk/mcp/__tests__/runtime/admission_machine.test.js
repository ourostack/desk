// The background admission state machine: states, backoff, refresh, degrade and the ready-state check, on fake timers.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  ADMISSION_BACKOFF_MS, ADMISSION_STEADY_MS, admissionRetryDelay, createAdmission, exceptionOutcome,
} from "../../src/runtime/admission.js"

function fakeTimers() {
  let now = 0
  let next = 1
  const pending = new Map()
  return {
    now: () => now,
    pending,
    setTimeout(callback, ms) {
      const id = next++
      pending.set(id, { at: now + ms, callback, ms })
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    delays() {
      return [...pending.values()].map((entry) => entry.ms)
    },
    async fire() {
      const [id, entry] = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      pending.delete(id)
      now = entry.at
      entry.callback()
      await flush()
    },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const degraded = (code) => ({ state: "degraded", code, fix: `fix ${code}`, summary: `summary ${code}` })

test("the retry delays are 1, 2, 5, 10 and 30 s, then every 60 s", () => {
  assert.deepEqual(ADMISSION_BACKOFF_MS, [1000, 2000, 5000, 10000, 30000])
  assert.equal(ADMISSION_STEADY_MS, 60000)
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(admissionRetryDelay), [1000, 2000, 5000, 10000, 30000, 60000, 60000])
})

test("a degraded machine retries on the backoff until an attempt is ready, and reports each transition", async () => {
  const timers = fakeTimers()
  const outcomes = [degraded("a"), degraded("a"), degraded("b"), degraded("b"), degraded("b"), degraded("b"), { state: "ready", repair: "repaired: x" }]
  const transitions = []
  const machine = createAdmission({
    timers,
    now: timers.now,
    attempt: async () => outcomes.shift(),
    onTransition: (snapshot) => transitions.push(`${snapshot.state}|${snapshot.repair}`),
  })
  assert.equal(machine.snapshot().state, "admitting")
  await machine.start()
  const seen = [machine.snapshot().state]
  const delays = []
  while (machine.snapshot().state !== "ready") {
    delays.push(...timers.delays())
    await timers.fire()
    seen.push(machine.snapshot().state)
  }
  assert.deepEqual(delays, [1000, 2000, 5000, 10000, 30000, 60000])
  assert.deepEqual(seen, ["degraded:a", "degraded:a", "degraded:b", "degraded:b", "degraded:b", "degraded:b", "ready"])
  assert.deepEqual(transitions, ["degraded:a|null", "degraded:b|null", "ready|repaired: x"])
  const ready = machine.snapshot()
  assert.equal(ready.failures, 0)
  assert.equal(ready.attempts, 7)
  assert.equal(ready.code, null)
  assert.equal(ready.fix, null)
  assert.equal(ready.summary, "Desk is admitted: reads and writes are available.")
  // With no check, a ready machine schedules nothing.
  assert.deepEqual(timers.delays(), [])
})

test("refresh joins a running attempt, waits at most waitMs, and a ready machine answers at once unless forced", async () => {
  const timers = fakeTimers()
  let release
  let calls = 0
  const machine = createAdmission({
    timers,
    now: timers.now,
    attempt: () => {
      calls += 1
      return calls === 1 ? new Promise((resolve) => { release = resolve }) : { state: "ready" }
    },
  })
  const first = machine.start()
  assert.equal(machine.running, true)
  const joined = machine.refresh({ waitMs: 5 })
  await flush()
  assert.equal(calls, 1, "refresh joins the running attempt")
  // The wait timer fires before the attempt settles.
  await timers.fire()
  assert.equal((await joined).state, "admitting")
  release(degraded("slow"))
  await first
  assert.equal(machine.snapshot().state, "degraded:slow")
  assert.equal((await machine.idle()).state, "degraded:slow", "idle answers at once when nothing runs")
  assert.equal((await machine.refresh()).state, "ready")
  assert.equal(calls, 2)
  assert.equal((await machine.refresh()).state, "ready")
  assert.equal(calls, 2, "a ready machine answers without an attempt")
  await machine.refresh({ force: true })
  assert.equal(calls, 3)
  const idleWhileRunning = machine.idle({ waitMs: 1000 })
  assert.equal((await idleWhileRunning).state, "ready")
})

test("a thrown attempt becomes degraded:admission_exception with the cause and a fix", async () => {
  const timers = fakeTimers()
  const machine = createAdmission({ timers, now: timers.now, attempt: () => { throw Object.assign(new TypeError("boom"), { code: "E_BOOM" }) } })
  const snapshot = await machine.start()
  assert.equal(snapshot.state, "degraded:admission_exception")
  assert.match(snapshot.fix, /desk_status/u)
  assert.deepEqual(snapshot.diagnostic.observed, { name: "TypeError", message: "boom", failure_code: "E_BOOM" })
  assert.deepEqual(exceptionOutcome("plain").diagnostic.observed, { name: "unknown", message: "plain" })
})

test("a ready machine checks every 60 s, and a failed check degrades and re-admits at once", async () => {
  const timers = fakeTimers()
  const checks = [null, degraded("controller_unavailable")]
  const outcomes = [{ state: "ready" }, degraded("controller_unavailable"), { state: "ready" }]
  const machine = createAdmission({
    timers,
    now: timers.now,
    attempt: async () => outcomes.shift(),
    check: async () => checks.shift(),
  })
  await machine.start()
  assert.deepEqual(timers.delays(), [60000])
  await timers.fire()
  assert.equal(machine.snapshot().state, "ready")
  assert.deepEqual(timers.delays(), [60000], "a passing check schedules the next one")
  await timers.fire()
  await flush()
  // The check failed: degraded, then an immediate re-admission that also failed, now on the backoff.
  assert.equal(machine.snapshot().state, "degraded:controller_unavailable")
  assert.equal(machine.snapshot().failures, 2)
  assert.deepEqual(timers.delays(), [2000])
  await timers.fire()
  assert.equal(machine.snapshot().state, "ready")
})

test("a check that throws is treated as a degraded outcome", async () => {
  const timers = fakeTimers()
  const transitions = []
  const machine = createAdmission({
    timers,
    now: timers.now,
    attempt: async () => ({ state: "ready" }),
    check: async () => { throw new Error("check broke") },
    onTransition: (snapshot) => transitions.push(snapshot.state),
  })
  await machine.start()
  await timers.fire()
  await flush()
  assert.deepEqual(transitions, ["ready", "degraded:admission_exception", "ready"])
})

test("dispose stops retries, and later calls answer with the last snapshot", async () => {
  const timers = fakeTimers()
  const machine = createAdmission({ timers, now: timers.now, attempt: async () => degraded("x"), check: async () => null })
  await machine.start()
  assert.equal(timers.pending.size, 1)
  machine.dispose()
  assert.equal(timers.pending.size, 0)
  assert.equal((await machine.start()).state, "degraded:x")
  assert.equal((await machine.degrade(degraded("y"))).state, "degraded:x")
  machine.dispose()
})

test("an outcome that settles after dispose schedules nothing", async () => {
  const timers = fakeTimers()
  let release
  const machine = createAdmission({ timers, now: timers.now, attempt: () => new Promise((resolve) => { release = resolve }) })
  const running = machine.start()
  await flush()
  machine.dispose()
  release(degraded("late"))
  assert.equal((await running).state, "degraded:late")
  assert.equal(timers.pending.size, 0)
  const readyMachine = createAdmission({ timers, now: timers.now, attempt: () => new Promise((resolve) => { release = resolve }), check: async () => null })
  const readyRun = readyMachine.start()
  await flush()
  readyMachine.dispose()
  release({ state: "ready" })
  await readyRun
  assert.equal(timers.pending.size, 0)
})

test("the default timers are real and unreferenced", async () => {
  const machine = createAdmission({ attempt: async () => degraded("real") })
  const snapshot = await machine.start()
  assert.equal(snapshot.state, "degraded:real")
  assert.equal(typeof snapshot.next_retry_at, "string")
  assert.equal((await machine.refresh({ waitMs: 1 })).state, "degraded:real")
  machine.dispose()
  assert.deepEqual(createAdmission({ attempt: async () => ({ state: "ready" }) }).context, {})
})

test("a bare degraded outcome, an external degrade while a check is pending, and idle during an attempt", async () => {
  const timers = fakeTimers()
  const outcomes = [{ state: "ready" }, { state: "degraded", code: "bare" }, { state: "ready" }]
  let release = null
  const machine = createAdmission({
    timers,
    now: timers.now,
    attempt: () => {
      const outcome = outcomes.shift()
      return outcome.state === "ready" && outcomes.length === 0 ? new Promise((resolve) => { release = () => resolve(outcome) }) : outcome
    },
    check: async () => null,
  })
  await machine.start()
  assert.deepEqual(timers.delays(), [60000])
  // The caller found the controller gone: the pending check is replaced by an immediate re-admission.
  const degrading = machine.degrade({ code: "controller_unavailable" })
  const bare = await degrading
  assert.equal(bare.state, "degraded:bare")
  assert.equal(bare.fix, null)
  assert.equal(bare.summary, null)
  const running = machine.refresh({ waitMs: 1 })
  await flush()
  const waiting = machine.idle({ waitMs: 5 })
  await flush()
  await timers.fire()
  await timers.fire()
  await running
  assert.equal((await waiting).state, "degraded:bare")
  release()
  await flush()
  assert.equal(machine.snapshot().state, "ready")
})

test("a check that finishes after dispose schedules nothing", async () => {
  const timers = fakeTimers()
  let finish
  const machine = createAdmission({
    timers,
    now: timers.now,
    attempt: async () => ({ state: "ready" }),
    check: () => new Promise((resolve) => { finish = resolve }),
  })
  await machine.start()
  await timers.fire()
  machine.dispose()
  finish(null)
  await flush()
  assert.equal(timers.pending.size, 0)
})

test("fail() records a degraded state and waits for the backoff instead of re-admitting at once", async () => {
  const timers = fakeTimers()
  let attempts = 0
  const machine = createAdmission({ timers, now: timers.now, attempt: async () => { attempts += 1; return { state: "ready" } } })
  await machine.start()
  const failed = machine.fail({ code: "runtime_exception", fix: "keep serving" })
  assert.equal(failed.state, "degraded:runtime_exception")
  assert.equal(attempts, 1, "no attempt runs at once")
  assert.deepEqual(timers.delays(), [1000])
  await timers.fire()
  assert.equal(machine.snapshot().state, "ready")
  machine.dispose()
  assert.equal(machine.fail({ code: "late" }).state, "ready", "a disposed machine keeps its last state")
})
