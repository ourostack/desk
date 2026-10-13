// How the triage qualification record comes to exist (the command and the loop worker's bounded automatic attempt), and
// the loader that finds the runner on an installed desk. Every effect that would launch, sign in or touch the ledger is a
// recorded seam; folders, renames, the lock and the marker are real, in a throwaway state root.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const qualify = await import("../../../../../plugins/desk/mcp/src/factory/triage-qualify.js")
const home = await import("../../../../../plugins/desk/mcp/src/factory/triage-home.js")
const { LOOP_LOCK_NAME } = await import("../../../../../plugins/desk/mcp/src/factory/evaluate-kick.js")
const { takeLock, releaseLock } = await import("../../../../../plugins/desk/mcp/src/factory/process-lock.js")
const factory = await import("../../../../../plugins/desk/mcp/scripts/factory.js")

const HOUR = 60 * 60 * 1000
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const T0 = Date.parse("2030-03-10T09:00:00.000Z")
const ENV = Object.freeze({ HOME: "/unit-home" })

function scratch() {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "desk-triage-qualify-")))
}

// A world where every gate passes and the qualifier writes a record; `over` replaces any seam.
function world(root, over = {}) {
  const calls = { qualify: [], reserve: [], finish: [], peek: [], signIn: 0, restore: [] }
  let random = 0
  const impls = {
    host: () => true,
    measurement: () => false,
    stateRoot: async () => root,
    restore: async (options) => {
      calls.restore.push(options)
      return { state: "missing" }
    },
    peek: async (env, request) => {
      calls.peek.push(request)
      return { state: "ok" }
    },
    locate: () => "/unit/engine",
    childEnv: (env) => ({ ...env, DESK_FACTORY_HEADLESS: "1" }),
    signIn: async () => {
      calls.signIn++
      return { state: "subscription" }
    },
    qualify: async (options) => {
      calls.qualify.push(options)
      await options.reserve()
      await fs.mkdir(options.out, { recursive: true })
      await fs.writeFile(path.join(options.out, "qualification.json"), "{}\n")
      return { state: "qualified", resources: { launches: 2 } }
    },
    reserve: async (env, request) => {
      calls.reserve.push(request)
      return { state: "reserved", token: { kind: "triage", launches: 2 } }
    },
    finish: async (env, request) => {
      calls.finish.push(request)
      return { state: "recorded" }
    },
    random: () => (random++ === 0 ? "abcd" : `abc${random}`),
    ...over,
  }
  return { impls, calls }
}

const marker = async (root) => JSON.parse(await fs.readFile(qualify.triagePaths(root).marker, "utf8"))
const BLANK = Object.freeze({ version: 1, day: null, started_at: null, trigger: null, streak: 0, result: null, reason: null, sealed: false, retry_after: null, retry_reason: null })
const listing = async (root) => (await fs.readdir(path.join(root, "triage"))).sort()

test("triagePaths names the record, its folder and the marker", () => {
  const s = path.join(path.sep, "s")
  assert.deepEqual(qualify.triagePaths(s), {
    dir: path.join(s, "triage"), out: path.join(s, "triage", "qualification"), recordFile: path.join(s, "triage", "qualification", "qualification.json"),
    marker: path.join(s, "triage", "auto-qualify.json"),
  })
})

test("the command qualifies under the worker's lock and reserves both launches just before the first", async () => {
  const root = scratch()
  const { impls, calls } = world(root)
  const result = await qualify.qualifyTriage(ENV, { now: () => T0, impls })
  assert.deepEqual(result, { state: "qualified", reason: null, launched: true })
  assert.equal(calls.qualify[0].cli, "/unit/engine")
  assert.equal(calls.qualify[0].out, path.join(root, "triage", "qualification"))
  assert.equal(calls.qualify[0].deadline, undefined, "the command keeps the qualifier's own deadline")
  assert.deepEqual(calls.reserve, [{ kind: "triage", launches: 2, generation: null, now: T0, legacyEvaluator: undefined }])
  assert.deepEqual(calls.peek, [{ kind: "triage", launches: 2, now: T0 }], "the ledger is read before anything runs")
  assert.deepEqual(await marker(root), { ...BLANK, sealed: true }, "a qualified record is remembered as sealed on this host")
  assert.deepEqual(calls.finish.map((x) => x.state), ["ran"])
  await assert.rejects(fs.lstat(path.join(root, "locks", LOOP_LOCK_NAME)), { code: "ENOENT" }, "the lock is released")
})

test("the command moves an earlier record aside, never deletes it, and leaves a qualified record alone", async () => {
  const root = scratch()
  const out = qualify.triagePaths(root).out
  await fs.mkdir(out, { recursive: true })
  await fs.writeFile(path.join(out, "qualification.json"), "old\n")
  const { impls } = world(root, { restore: async () => ({ state: "damaged", reason: "structure" }) })
  assert.equal((await qualify.qualifyTriage(ENV, { now: () => T0, impls })).state, "qualified")
  const names = (await listing(root)).filter((name) => name !== "auto-qualify.json")
  assert.deepEqual(names, ["qualification", "qualification.aside-20300310T090000000Z-abcd"])
  assert.equal(await fs.readFile(path.join(root, "triage", names[1], "qualification.json"), "utf8"), "old\n")
  const same = world(root, { restore: async () => ({ state: "qualified", qualification: {} }) })
  assert.deepEqual(await qualify.qualifyTriage(ENV, { now: () => T0, impls: same.impls }), { state: "qualified", reason: "already_qualified", launched: false })
  assert.equal(same.calls.qualify.length, 0)
})

test("the command refuses before anything launches", async () => {
  const root = scratch()
  const cases = [
    [{ host: () => false }, ENV, "host_unsupported"],
    [{}, { ...ENV, DESK_FACTORY_HEADLESS: "1" }, "headless_session"],
    [{}, { ...ENV, ANTHROPIC_API_KEY: "unit-not-a-key" }, "disabled_would_bill"],
    [{ measurement: () => true }, ENV, "measurement_active"],
    [{ locate: () => null }, ENV, "engine_unpinned"],
    [{ childEnv: () => { throw new Error("environment_unsafe") } }, ENV, "environment_unsafe"],
    [{ signIn: async () => ({ state: "no_credentials" }) }, ENV, "no_credentials"],
  ]
  for (const [over, env, reason] of cases) {
    const { impls, calls } = world(root, over)
    assert.deepEqual(await qualify.qualifyTriage(env, { now: () => T0, impls }), { state: "refused", reason, launched: false }, reason)
    assert.equal(calls.qualify.length, 0, reason)
  }
  const held = await takeLock(root, { name: LOOP_LOCK_NAME })
  try {
    const { impls } = world(root)
    assert.deepEqual(await qualify.qualifyTriage(ENV, { impls }), { state: "refused", reason: "busy", launched: false })
    assert.deepEqual(await qualify.checkTriageQualification(ENV, { impls }), { state: "busy" })
  } finally {
    await releaseLock(held)
  }
})

test("a ledger that would refuse is answered first: nothing runs, nothing is written or moved", async () => {
  const root = scratch()
  const out = qualify.triagePaths(root).out
  await fs.mkdir(out, { recursive: true })
  await fs.writeFile(path.join(out, "qualification.json"), "earlier\n")
  const retry = new Date(T0 + 3 * HOUR).toISOString()
  const { impls, calls } = world(root, { peek: async () => ({ state: "window_used", retry_at: retry }) })
  assert.deepEqual(await qualify.qualifyTriage(ENV, { now: () => T0, impls }), { state: "refused", reason: "window_used", launched: false, retry_at: retry })
  assert.equal(calls.signIn, 0)
  assert.equal(calls.qualify.length, 0)
  assert.deepEqual(await listing(root), ["qualification"])
  // An unreadable ledger leaves the decision to the reservation.
  const unknown = world(root, { peek: async () => ({ state: "unknown" }) })
  assert.equal((await qualify.qualifyTriage(ENV, { now: () => T0, impls: unknown.impls })).state, "qualified")
})

test("a refusal at the reservation launches nothing, leaves no aside and puts the earlier record back", async () => {
  const root = scratch()
  const out = qualify.triagePaths(root).out
  await fs.mkdir(out, { recursive: true })
  await fs.writeFile(path.join(out, "qualification.json"), "earlier\n")
  const retry = new Date(T0 + 6 * HOUR).toISOString()
  const qualifyThen = async (options) => {
    await fs.mkdir(options.out, { recursive: true })
    await fs.writeFile(path.join(options.out, "qualification.json"), "blocked\n")
    try {
      await options.reserve()
    } catch {
      return { state: "blocked", reason: "diagnostic_inadequate", resources: { launches: 0 } }
    }
    return { state: "qualified", resources: { launches: 2 } }
  }
  const { impls, calls } = world(root, {
    restore: async () => ({ state: "stale", reason: "source_changed", requalify: true }),
    reserve: async () => ({ state: "quota_exhausted", retry_at: retry }),
    qualify: qualifyThen,
  })
  assert.deepEqual(await qualify.qualifyTriage(ENV, { now: () => T0, impls }), { state: "refused", reason: "quota_exhausted", launched: false, retry_at: retry })
  assert.equal(calls.finish.length, 0, "nothing reserved, nothing to finish")
  assert.equal(await fs.readFile(path.join(out, "qualification.json"), "utf8"), "earlier\n")
  assert.deepEqual(await listing(root), ["qualification"])
  // Without an earlier record nothing is left; a state that blocks every launch waits for the next UTC day.
  const bare = scratch()
  const again = world(bare, { reserve: async () => ({ state: "ledger_damaged" }), qualify: qualifyThen })
  assert.deepEqual(await qualify.qualifyTriage(ENV, { now: () => T0, impls: again.impls }),
    { state: "refused", reason: "ledger_damaged", launched: false, retry_at: "2030-03-11T00:00:00.000Z" })
  assert.deepEqual(await listing(bare), [])
})

test("a failed or throwing qualifier finishes the ledger by what actually started", async () => {
  const root = scratch()
  const failed = world(root, { qualify: async (options) => {
    await options.reserve()
    return { state: "blocked", reason: "launch_chain_unknown", resources: { launches: 1 } }
  } })
  assert.deepEqual(await qualify.qualifyTriage(ENV, { now: () => T0, impls: failed.impls }), { state: "failed", reason: "launch_chain_unknown", launched: true })
  assert.deepEqual(failed.calls.finish.map((x) => x.state), ["failed"])
  const unstarted = world(root, { qualify: async (options) => {
    await options.reserve()
    return { state: "blocked" }
  } })
  assert.deepEqual(await qualify.qualifyTriage(ENV, { now: () => T0, impls: unstarted.impls }), { state: "failed", reason: "diagnostic_inadequate", launched: false })
  assert.deepEqual(unstarted.calls.finish.map((x) => x.state), ["not_started"])
  const thrown = world(root, { qualify: async () => { throw new Error("unit") } })
  assert.deepEqual(await qualify.qualifyTriage(ENV, { now: () => T0, impls: thrown.impls }), { state: "failed", reason: "diagnostic_inadequate", launched: false })
  assert.equal(thrown.calls.finish.length, 0)
})

test("--check answers what restore says, under the lock, without the record object", async () => {
  const root = scratch()
  const { impls } = world(root, { restore: async ({ recordFile }) => ({ state: "qualified", qualification: { recordFile } }) })
  assert.deepEqual(await qualify.checkTriageQualification(ENV, { impls }), { state: "qualified" })
  await assert.rejects(fs.lstat(path.join(root, "locks", LOOP_LOCK_NAME)), { code: "ENOENT" })
})

async function workerLock(root) {
  return takeLock(root, { name: LOOP_LOCK_NAME })
}

test("automatic qualification needs the worker's own lock and a reason qualifying can clear", async () => {
  const root = scratch()
  const deadline = T0 + HOUR
  const { impls, calls } = world(root)
  assert.equal((await qualify.autoQualifyTriage(ENV, { now: () => T0, deadline, impls })).reason, "lock_not_held")
  assert.equal((await qualify.autoQualifyTriage(ENV, { lock: { file: "/elsewhere", token: "x" }, now: () => T0, deadline, impls })).reason, "lock_not_held")
  const lock = await workerLock(root)
  try {
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock: { ...lock, token: "other" }, now: () => T0, deadline, impls })).reason, "lock_not_held")
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock: { ...lock, token: 1 }, now: () => T0, deadline, impls })).reason, "lock_not_held")
    const otherProcess = world(root, { readLock: async () => ({ token: lock.token, pid: process.pid + 1 }) })
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline, impls: otherProcess.impls })).reason, "lock_not_held",
      "the lock's token alone is not proof: this process must hold it")
    const unreadable = world(root, { readLock: async () => { throw new Error("unit") } })
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline, impls: unreadable.impls })).reason, "lock_not_held")
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline, impls: world(root, { host: () => false }).impls })).reason, "host_unsupported")
    for (const [restored, reason] of [
      [{ state: "qualified", qualification: {} }, "qualified"],
      [{ state: "stale", reason: "engine_unpinned", requalify: false }, "not_requalifiable"],
      [{ state: "damaged", reason: "receipts" }, "not_requalifiable"],
    ]) {
      const skip = world(root, { restore: async () => restored })
      const result = await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline, impls: skip.impls })
      assert.equal(result.state, "skipped")
      assert.equal(result.reason, reason)
      assert.equal(skip.calls.qualify.length, 0)
    }
    assert.equal(calls.qualify.length, 0)
    const result = await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline, generation: "g1", legacyEvaluator: { x: 1 }, impls })
    assert.deepEqual(result, { state: "qualified", reason: null, launched: true })
    assert.equal(calls.qualify[0].deadline, deadline)
    assert.deepEqual(calls.reserve[0], { kind: "triage", launches: 2, generation: "g1", now: T0, legacyEvaluator: { x: 1 } })
    assert.deepEqual(await marker(root), { ...BLANK, day: "2030-03-10", started_at: new Date(T0).toISOString(), trigger: "missing", result: "qualified", sealed: true })
    // Once a UTC day.
    const again = await qualify.autoQualifyTriage(ENV, { lock, now: () => T0 + HOUR, deadline: T0 + 3 * HOUR, impls })
    assert.deepEqual(again, { state: "skipped", reason: "attempted_today", launched: false })
  } finally {
    await releaseLock(lock)
  }
})

test("the automatic marker fails closed, gates the deadline and stops a repeating reason", async () => {
  const root = scratch()
  const lock = await workerLock(root)
  const paths = qualify.triagePaths(root)
  const stale = (reason) => {
    const run = world(root)
    run.impls.restore = async (options) => (run.calls.restore.push(options), { state: "stale", reason, requalify: true })
    return run
  }
  try {
    await fs.mkdir(paths.dir, { recursive: true })
    for (const bad of ["not json", "[]", "null", JSON.stringify({ version: 2 }), JSON.stringify({ ...BLANK, version: 2 }), JSON.stringify({ ...BLANK, day: 1 }),
      JSON.stringify({ ...BLANK, streak: -1 }), JSON.stringify({ ...BLANK, streak: 0.5 }), JSON.stringify({ ...BLANK, sealed: 0 }),
      JSON.stringify({ ...BLANK, retry_after: "soon" }), JSON.stringify({ ...BLANK, retry_after: 1 }), JSON.stringify({ ...BLANK, retry_reason: 1 }),
      JSON.stringify({ version: 1, day: "d", started_at: null, trigger: null, streak: 0, result: "x", reason: null })]) {
      await fs.writeFile(paths.marker, bad)
      const { impls, calls } = stale("runtime_changed")
      assert.deepEqual(await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline: T0 + HOUR, impls }), { state: "skipped", reason: "attempted_today", launched: false }, bad)
      assert.equal(calls.qualify.length, 0)
      assert.deepEqual(await marker(root), { ...BLANK, day: "2030-03-10", result: "marker_damaged", sealed: true })
      assert.equal(calls.restore[0].sealedBefore, true, "a damaged marker may hide a sealed qualification")
    }
    const unreadable = stale("runtime_changed")
    unreadable.impls.readMarker = async () => { throw Object.assign(new Error("unit"), { code: "EACCES" }) }
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0 + 24 * HOUR, deadline: T0 + 25 * HOUR, impls: unreadable.impls })).reason, "attempted_today")
    // The deadline gate.
    for (const deadline of [undefined, T0 + 48 * HOUR + qualify.AUTO_MIN_REMAINING_MS - 1]) {
      const short = stale("runtime_changed")
      assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0 + 48 * HOUR, deadline, impls: short.impls })).reason, "no_time")
    }
    // Day by day, one attempt each.
    let day = 48
    const attempt = async (reason, over = {}) => {
      const run = stale(reason)
      Object.assign(run.impls, over)
      const result = await qualify.autoQualifyTriage(ENV, { lock, now: () => T0 + day * HOUR, deadline: T0 + (day + 1) * HOUR, impls: run.impls })
      day += 24
      return result
    }
    const failing = { qualify: async (options) => {
      await options.reserve()
      return { state: "blocked", reason: "launch_chain_unknown", resources: { launches: 2 } }
    } }
    // Successful requalifications never count: an OS update every few months keeps recovering.
    for (let i = 0; i <= qualify.AUTO_STREAK_LIMIT; i++) {
      assert.equal((await attempt("chain_changed")).state, "qualified", `success ${i + 1}`)
      assert.equal((await marker(root)).streak, 0)
    }
    // Three failures in a row for the same host-side reason, then it stops.
    for (let streak = 1; streak <= qualify.AUTO_STREAK_LIMIT; streak++) {
      assert.equal((await attempt("runtime_changed", failing)).state, "failed")
      assert.equal((await marker(root)).streak, streak)
    }
    assert.deepEqual(await attempt("runtime_changed"), { state: "skipped", reason: "auto_suspended", launched: false, trigger: "runtime_changed" })
    assert.equal((await attempt("source_changed", failing)).state, "failed")
    assert.equal((await marker(root)).streak, 0, "a release-driven reason never counts")
    assert.equal((await attempt("environment_changed", failing)).state, "failed")
    assert.equal((await marker(root)).streak, 1, "another reason starts again")
    // An attempt that never finished counts as a failure.
    await fs.writeFile(paths.marker, JSON.stringify({ ...(await marker(root)), streak: qualify.AUTO_STREAK_LIMIT, result: "started" }))
    assert.equal((await attempt("environment_changed")).reason, "auto_suspended")
    await fs.writeFile(paths.marker, JSON.stringify({ ...(await marker(root)), streak: 1, result: "failed" }))
    // A refusal before the reservation is not an attempt: the marker and the day stay unused.
    const before = await marker(root)
    assert.equal((await attempt("environment_changed", { signIn: async () => ({ state: "no_credentials" }) })).reason, "no_credentials")
    assert.deepEqual(await marker(root), before)
    // A refusal at the reservation neither uses the day nor counts, but no attempt starts before the ledger's own time.
    const at = T0 + day * HOUR
    const retry = new Date(at + 2 * HOUR).toISOString()
    const race = stale("environment_changed")
    Object.assign(race.impls, { reserve: async () => ({ state: "triage_cooldown", retry_at: retry }), ...failing })
    assert.deepEqual(await qualify.autoQualifyTriage(ENV, { lock, now: () => at, deadline: at + HOUR, impls: race.impls }),
      { state: "refused", reason: "triage_cooldown", launched: false, retry_at: retry })
    assert.deepEqual(await marker(root), { ...before, retry_after: retry, retry_reason: "triage_cooldown" })
    const waiting = stale("environment_changed")
    assert.deepEqual(await qualify.autoQualifyTriage(ENV, { lock, now: () => at + HOUR, deadline: at + 2 * HOUR, impls: waiting.impls }),
      { state: "skipped", reason: "triage_cooldown", launched: false, retry_at: retry })
    assert.equal(waiting.calls.peek.length + waiting.calls.signIn + waiting.calls.qualify.length, 0)
    const later = stale("environment_changed")
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => at + 2 * HOUR, deadline: at + 3 * HOUR, impls: later.impls })).state, "qualified",
      "the same day may try again once the ledger's time has come")
    assert.deepEqual(await marker(root), { ...BLANK, day: dayOf(at), started_at: new Date(at + 2 * HOUR).toISOString(), trigger: "environment_changed", result: "qualified", sealed: true })
  } finally {
    await releaseLock(lock)
  }
})

test("the automatic minimum fits inside the time the loop worker gives its steps", async () => {
  const { LOOP_BUDGET_MS, LATER_STEPS_RESERVE_MS } = await import("../../../../../plugins/desk/mcp/src/factory/loop-worker.js")
  assert.ok(qualify.AUTO_MIN_REMAINING_MS <= LOOP_BUDGET_MS - LATER_STEPS_RESERVE_MS, "a worker's deadline must be able to admit an attempt")
  assert.ok(qualify.AUTO_MIN_REMAINING_MS >= 3 * 90 * 1000, "at least three times the slowest measured qualification (87 s)")
})

test("the command resets an automatic streak", async () => {
  const root = scratch()
  const paths = qualify.triagePaths(root)
  await fs.mkdir(paths.dir, { recursive: true })
  const suspended = { ...BLANK, day: "2030-03-09", trigger: "runtime_changed", streak: 3, result: "failed" }
  await fs.writeFile(paths.marker, JSON.stringify(suspended))
  const failing = world(root, { qualify: async (options) => {
    await options.reserve()
    return { state: "blocked", reason: "launch_chain_unknown", resources: { launches: 2 } }
  } })
  assert.equal((await qualify.qualifyTriage(ENV, { now: () => T0, impls: failing.impls })).state, "failed")
  assert.deepEqual(await marker(root), { ...suspended, streak: 0 }, "a failed run ends the streak and seals nothing")
  assert.equal((await qualify.qualifyTriage(ENV, { now: () => T0, impls: world(root).impls })).state, "qualified")
  assert.deepEqual(await marker(root), { ...suspended, streak: 0, sealed: true })
  await fs.writeFile(paths.marker, "damaged")
  assert.equal((await qualify.qualifyTriage(ENV, { now: () => T0 + 1, impls: world(root).impls })).state, "qualified")
  assert.equal(await fs.readFile(paths.marker, "utf8"), "damaged", "a damaged marker is left for the automatic path")
  await fs.writeFile(paths.marker, JSON.stringify({ ...suspended, streak: 0, sealed: true }))
  const unchanged = world(root, { writeMarker: async () => { throw new Error("must not write") } })
  assert.equal((await qualify.qualifyTriage(ENV, { now: () => T0 + 2, impls: unchanged.impls })).state, "qualified")
  assert.equal(unchanged.calls.restore[0].sealedBefore, true)
  const already = world(root, { restore: async () => ({ state: "qualified", qualification: {} }), writeMarker: unchanged.impls.writeMarker })
  assert.equal((await qualify.qualifyTriage(ENV, { now: () => T0 + 3, impls: already.impls })).reason, "already_qualified")
})

test("repeated automatic calls while the ledger would refuse run no preflight and leave nothing behind", async () => {
  const root = scratch()
  const lock = await workerLock(root)
  const paths = qualify.triagePaths(root)
  try {
    await fs.mkdir(paths.out, { recursive: true })
    await fs.writeFile(path.join(paths.out, "qualification.json"), "earlier\n")
    const retry = new Date(T0 + 3 * HOUR).toISOString()
    for (const prior of [null, { ...BLANK, day: "2030-03-09", trigger: "runtime_changed", streak: 2, result: "failed", sealed: true }]) {
      if (prior) await fs.writeFile(paths.marker, JSON.stringify(prior))
      for (let i = 0; i < 3; i++) {
        const { impls, calls } = world(root, {
          restore: async (options) => (calls.restore.push(options), { state: "stale", reason: "runtime_changed", requalify: true }),
          peek: async (env, request) => (calls.peek.push(request), { state: "window_used", retry_at: retry }),
        })
        assert.deepEqual(await qualify.autoQualifyTriage(ENV, { lock, now: () => T0 + i * 60000, deadline: T0 + HOUR, impls }),
          { state: "skipped", reason: "window_used", launched: false, retry_at: retry })
        assert.deepEqual(calls.peek, [{ kind: "triage", launches: 2, now: T0 + i * 60000 }])
        assert.equal(calls.signIn + calls.qualify.length + calls.reserve.length, 0, "no preflight")
        assert.deepEqual(await listing(root), prior ? ["auto-qualify.json", "qualification"] : ["qualification"], "no marker and no aside")
        if (prior) assert.deepEqual(await marker(root), prior, "the streak is untouched")
      }
    }
  } finally {
    await releaseLock(lock)
  }
})

test("a first automatic attempt records the ledger's time after a refused reservation, then qualifies and remembers the seal", async () => {
  const root = scratch()
  const lock = await workerLock(root)
  try {
    const retry = new Date(T0 + HOUR).toISOString()
    const race = world(root, { reserve: async () => ({ state: "window_used", retry_at: retry }), qualify: async (options) => {
      await options.reserve().catch(() => {})
      return { state: "blocked", resources: { launches: 0 } }
    } })
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline: T0 + HOUR, impls: race.impls })).reason, "window_used")
    assert.deepEqual(await marker(root), { ...BLANK, retry_after: retry, retry_reason: "window_used" })
    const later = world(root)
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0 + HOUR, deadline: T0 + 2 * HOUR, impls: later.impls })).state, "qualified")
    assert.equal(later.calls.restore[0].sealedBefore, false)
    assert.deepEqual(await marker(root), { ...BLANK, day: "2030-03-10", started_at: new Date(T0 + HOUR).toISOString(), trigger: "missing", result: "qualified", sealed: true })
  } finally {
    await releaseLock(lock)
  }
})

test("restore learns whether a sealed record has qualified on this host", async () => {
  const root = scratch()
  const lock = await workerLock(root)
  const paths = qualify.triagePaths(root)
  try {
    const qualified = world(root, { restore: async (options) => (qualified.calls.restore.push(options), { state: "qualified", qualification: {} }) })
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline: T0 + HOUR, impls: qualified.impls })).reason, "qualified")
    assert.equal(qualified.calls.restore[0].sealedBefore, false)
    assert.deepEqual(await marker(root), { ...BLANK, sealed: true })
    const again = world(root, { restore: qualified.impls.restore, writeMarker: async () => { throw new Error("must not write") } })
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline: T0 + HOUR, impls: again.impls })).reason, "qualified")
    assert.equal(qualified.calls.restore[1].sealedBefore, true)
    await fs.writeFile(paths.marker, "damaged")
    assert.equal((await qualify.autoQualifyTriage(ENV, { lock, now: () => T0, deadline: T0 + HOUR, impls: again.impls })).reason, "qualified")
    assert.equal(await fs.readFile(paths.marker, "utf8"), "damaged")
  } finally {
    await releaseLock(lock)
  }
  const check = world(root)
  await qualify.checkTriageQualification(ENV, { impls: check.impls })
  assert.equal(check.calls.restore[0].sealedBefore, true)
  await fs.writeFile(paths.marker, JSON.stringify({ ...BLANK, sealed: true }))
  await qualify.checkTriageQualification(ENV, { impls: check.impls })
  await fs.writeFile(paths.marker, JSON.stringify(BLANK))
  await qualify.checkTriageQualification(ENV, { impls: check.impls })
  assert.deepEqual(check.calls.restore.map((x) => x.sealedBefore), [true, true, false])
})

test("the default seams answer from the real host", async () => {
  const root = scratch()
  const lock = await workerLock(root)
  try {
    // Only the launch-capable seams are replaced; the gates, lock reader, ledger read, folders and marker writer are the real ones.
    const result = await qualify.autoQualifyTriage({ HOME: root, XDG_STATE_HOME: path.join(root, "xdg") }, { lock, now: () => T0, deadline: T0 + HOUR, impls: {
      stateRoot: async () => root, measurement: () => false, restore: async () => ({ state: "missing" }),
      locate: () => null,
    } })
    const host = process.platform === "darwin" && process.arch === "arm64"
    assert.deepEqual(result, host ? { state: "refused", reason: "engine_unpinned", launched: false } : { state: "refused", reason: "host_unsupported", launched: false })
  } finally {
    await releaseLock(lock)
  }
  const exists = world(root).impls
  delete exists.random
  const out = qualify.triagePaths(root).out
  await fs.mkdir(out, { recursive: true })
  const moved = await qualify.qualifyTriage(ENV, { now: () => T0, impls: { ...exists, host: () => true } })
  assert.equal(moved.state, "qualified")
  assert.match((await listing(root)).find((name) => name.includes("aside")), /^qualification\.aside-20300310T090000000Z-[0-9a-f]{8}$/u)
  const broken = world(root, { exists: undefined })
  delete broken.impls.exists
  const lstat = fs.lstat
  fs.lstat = async (file) => (file === out ? Promise.reject(Object.assign(new Error("unit"), { code: "EACCES" })) : lstat(file))
  try {
    await assert.rejects(qualify.qualifyTriage(ENV, { now: () => T0, impls: broken.impls }), { code: "EACCES" })
  } finally {
    fs.lstat = lstat
  }
  const autoDefaults = await qualify.autoQualifyTriage({ ...ENV, DESK_FACTORY_HEADLESS: "1" }, {})
  assert.equal(autoDefaults.state, "refused")
  const defaults = await qualify.qualifyTriage({ ...ENV, DESK_FACTORY_HEADLESS: "1" })
  assert.deepEqual(defaults, { state: "refused", reason: process.platform === "darwin" && process.arch === "arm64" ? "headless_session" : "host_unsupported", launched: false })
})

test("the loader finds the runner here, in a prepared mirror, or answers a quiet code", async () => {
  const own = path.resolve(fileURLToPath(new URL("../../../../../plugins/desk/mcp/", import.meta.url))) + path.sep
  assert.equal(home.packagesResolve(own), true)
  assert.equal(home.packagesResolve("/nonexistent-desk-root/"), false)
  assert.deepEqual(await home.triageRuntimeRoot(), { state: "found", root: own })
  const never = () => { throw new Error("unresolved") }
  const mirror = path.resolve(path.sep, "unit", "mirror")
  const resolve = (root) => { if (root !== path.join(mirror, path.sep)) throw new Error("unresolved") }
  assert.deepEqual(await home.triageRuntimeRoot({ ownRoot: "/plugin/", resolve, prepare: async () => mirror }), { state: "found", root: path.join(mirror, path.sep) })
  for (const prepare of [async () => "relative", async () => null, async () => { throw new Error("pack") }, async () => "/other"]) {
    assert.deepEqual(await home.triageRuntimeRoot({ ownRoot: "/plugin/", resolve, prepare }), { state: "unavailable", reason: "runtime_unavailable" })
  }
  assert.deepEqual(await home.importTriageRunner(ENV, { ownRoot: "/plugin/", resolve: never, prepare: async () => null }), { state: "unavailable", reason: "runtime_unavailable" })
  assert.deepEqual(await home.importTriageRunner(ENV, { ownRoot: "/plugin/", resolve, prepare: async () => mirror, load: async () => { throw new Error("unit") } }), { state: "unavailable", reason: "runtime_unloadable" })
  const loaded = await home.importTriageRunner(ENV)
  assert.equal(loaded.state, "loaded")
  assert.equal(loaded.root, own)
  assert.equal(typeof loaded.runner.restoreTriageQualification, "function")
  assert.equal(typeof loaded.custody.ownedSourceIdentity, "function")
  assert.equal(typeof loaded.qualify.autoQualifyTriage, "function")
  assert.deepEqual(home.TRIAGE_ENGINE_CARD, { source: "loop_alarm", id: "triage_engine_unpinned", title: "The triage runner's engine pin is behind the installed Claude Code" })
  // The default preparation reads only the account's home, never an ambient cache selector, and names this exact source.
  const seenPrepare = []
  const bootstrap = { hashCurrentSource: (root) => `hash-of-${root}`, prepareRuntime: (options) => (seenPrepare.push(options), { sourceMirrorPath: mirror }) }
  assert.equal(await home.prepareSourceMirror({ mcpRoot: "/plugin/" }, { load: async (url) => (seenPrepare.push(url), bootstrap), homedir: () => "/passwd-home" }), mirror)
  assert.deepEqual(seenPrepare, [pathToFileURL("/plugin/src/runtime/bootstrap.js").href, { mcpRoot: "/plugin/", env: { HOME: "/passwd-home" }, sourceIdentity: "sha256:hash-of-/plugin/" }])
  await assert.rejects(home.prepareSourceMirror({ mcpRoot: "/nonexistent-desk-root/" }))
  seenPrepare.length = 0
  await home.prepareSourceMirror({ mcpRoot: "/plugin/" }, { load: async () => bootstrap })
  assert.equal(seenPrepare[0].env.HOME, os.userInfo().homedir)
})

test("factory.js triage-qualify loads the runner and answers codes only", async () => {
  await assert.rejects(factory.runTriageQualifyCommand({ argv: ["--force"], env: ENV }), /Usage: factory.js triage-qualify/u)
  await assert.rejects(factory.runTriageQualifyCommand({ argv: ["--check", "x"], env: ENV }), /Usage/u)
  assert.deepEqual(await factory.runTriageQualifyCommand({ argv: [], env: ENV, load: async () => ({ state: "unavailable", reason: "runtime_unavailable" }) }), { state: "unavailable", reason: "runtime_unavailable" })
  const seen = []
  const fake = { state: "loaded", qualify: {
    qualifyTriage: async (env) => (seen.push(["qualify", env]), { state: "qualified", reason: null, launched: true }),
    checkTriageQualification: async (env) => (seen.push(["check", env]), { state: "stale", reason: "chain_changed", requalify: true }),
  } }
  assert.equal((await factory.runTriageQualifyCommand({ argv: [], env: ENV, load: async () => fake })).state, "qualified")
  assert.equal((await factory.runTriageQualifyCommand({ argv: ["--check"], env: ENV, load: async () => fake })).reason, "chain_changed")
  assert.deepEqual(seen.map(([name]) => name), ["qualify", "check"])
  assert.ok(factory.SUPPORTED_COMMANDS.includes("triage-qualify"))
  // End to end through main: under the test runner's loader the measurement guard (or a non-Darwin host) holds, quietly.
  const base = scratch()
  const lines = []
  // Windows protects the state folder through the system PowerShell, which needs %SystemRoot%.
  const system = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}
  const code = await factory.main({ argv: ["triage-qualify", "--check"], env: { ...system, HOME: base, XDG_STATE_HOME: path.join(base, "state") }, write: (text) => lines.push(text) })
  assert.equal(code, 0)
  assert.equal(JSON.parse(lines[0]).state, "stale")
  const failed = []
  assert.equal(await factory.main({ argv: ["triage-qualify"], env: { ...system, HOME: base, XDG_STATE_HOME: path.join(base, "state"), DESK_FACTORY_HEADLESS: "1" }, write: (text) => failed.push(text) }), 1)
  assert.equal(JSON.parse(failed[0]).state, "refused")
})
