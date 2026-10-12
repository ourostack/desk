// How the triage runner's qualification record comes to exist, and when it is made again.
//
// The record lives at `<factory state>/triage/qualification/qualification.json`. Two callers make it, through one transaction:
//
//   - `qualifyTriage(env)`: the supported command (`factory.js triage-qualify`). It takes the loop worker's lock, so no worker
//     reads a half-written record, and qualifies whenever the record does not restore.
//   - `autoQualifyTriage(env, { lock, deadline, ... })`: the loop worker, holding its own lock, when restore says `missing` or a
//     `stale` reason that qualifying again can clear. At most one attempt launches per UTC day (the marker
//     `triage/auto-qualify.json` is written once the ledger has reserved the launches, and a marker that cannot be read counts as
//     today's attempt), at least 20 minutes must remain before the worker's deadline, and after three failed attempts in a row
//     for the same reason it stops until the command runs. A success, or a ledger refusal, does not count toward that.
//
// Before anything launches: a Darwin arm64 host, no headless session, no billing variable, no coverage or loader measurement,
// the pinned engine installed at a location only this account can change, and a subscription sign-in. The two native launches
// are reserved together in the shared launch ledger only after the qualifier's own checks pass, just before the first launch;
// a refusal there launches nothing and puts the earlier record back. An earlier record is moved aside
// (`qualification.aside-<UTC stamp>-<hex>`), never deleted.

import { randomBytes } from "node:crypto"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import { qualifyTriageRunner } from "../../scripts/qualify-triage-runner.js"
import { LOOP_LOCK_NAME } from "./evaluate-kick.js"
import { billingVariableBlocks, probeSignIn } from "./headless.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { finishAgentLaunch, reserveAgentLaunch } from "./headless-ledger.js"
import { ensureOwnerOnlyDirectory } from "./os-protect.js"
import { factoryStateRoot } from "./outbox.js"
import { releaseLock, takeLock } from "./process-lock.js"
import { ownedCatalogHostSupport } from "./triage-custody.js"
import { locatePinnedEngine, qualificationMeasurementActive, restoreTriageQualification, triageChildEnvironment } from "./triage-runner.js"

/** The least time, before the worker's deadline, an automatic qualification needs (a full qualification took about 66 s). */
const AUTO_MIN_REMAINING_MS = 20 * 60 * 1000
/** Failed automatic attempts in a row for the same reason before automatic qualification stops for that reason. */
export const AUTO_STREAK_LIMIT = 3
// Reasons a new release or engine pin causes, not the host: these never count toward the streak.
const STREAK_EXEMPT = new Set(["record_version", "source_changed", "engine_changed"])
const NAMING = { label: "triage qualification", subject: "folder" }
const MARKER_KEYS = ["version", "day", "started_at", "trigger", "streak", "result", "reason"]

const DEFAULT_IMPLS = Object.freeze({
  host: () => ownedCatalogHostSupport().provenance && process.arch === "arm64",
  measurement: qualificationMeasurementActive,
  stateRoot: (env) => factoryStateRoot(env),
  takeLock,
  releaseLock,
  readLock: async (file) => JSON.parse(await fsp.readFile(file, "utf8")),
  mkdir: (dir) => ensureOwnerOnlyDirectory(dir, process.platform, NAMING),
  restore: restoreTriageQualification,
  locate: locatePinnedEngine,
  signIn: probeSignIn,
  childEnv: triageChildEnvironment,
  qualify: qualifyTriageRunner,
  reserve: reserveAgentLaunch,
  finish: finishAgentLaunch,
  exists: async (file) => {
    try {
      await fsp.lstat(file)
      return true
    } catch (error) {
      if (error.code === "ENOENT") return false
      throw error
    }
  },
  rename: (from, to) => fsp.rename(from, to),
  readMarker: (file) => fsp.readFile(file, "utf8"),
  writeMarker: async (file, value) => {
    const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`
    await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" })
    await fsp.rename(temporary, file)
  },
  random: () => randomBytes(4).toString("hex"),
})

/** `triagePaths(root)`: where the record, its folder and the automatic marker live under the factory state root. */
export function triagePaths(root) {
  const dir = path.join(root, "triage")
  const out = path.join(dir, "qualification")
  return { dir, out, recordFile: path.join(out, "qualification.json"), marker: path.join(dir, "auto-qualify.json") }
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:.]/gu, "")

// The marker, or `null` when there is none. A marker that cannot be read or has another shape answers `"damaged"`.
async function readMarker(file, impl) {
  let text
  try {
    text = await impl.readMarker(file)
  } catch (error) {
    return error?.code === "ENOENT" ? null : "damaged"
  }
  try {
    const value = JSON.parse(text)
    const keys = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : []
    if (keys.join() !== [...MARKER_KEYS].sort().join() || value.version !== 1 || typeof value.day !== "string" ||
      !Number.isSafeInteger(value.streak) || value.streak < 0) return "damaged"
    return value
  } catch {
    return "damaged"
  }
}

const answer = (state, reason, extra = {}) => ({ state, reason, launched: false, ...extra })

// The shared gates: nothing below them launches or writes when one fails.
function gate(env, impl) {
  if (!impl.host()) return "host_unsupported"
  if (isHeadlessFactorySession(env)) return "headless_session"
  if (billingVariableBlocks(env)) return "disabled_would_bill"
  if (impl.measurement()) return "measurement_active"
  return null
}

async function lockHeld(lock, root, impl) {
  if (lock === null || typeof lock !== "object" || lock.file !== path.join(root, "locks", LOOP_LOCK_NAME) || typeof lock.token !== "string") return false
  try {
    const held = await impl.readLock(lock.file)
    return held.token === lock.token && held.pid === process.pid
  } catch {
    return false
  }
}

/**
 * `checkTriageQualification(env, { impls }) -> { state, reason?, requalify? }`: what restore says now, read under the loop worker's
 * lock (`busy` while a worker or a qualification holds it). It launches nothing.
 */
export async function checkTriageQualification(env, { impls = {} } = {}) {
  const impl = { ...DEFAULT_IMPLS, ...impls }
  const root = await impl.stateRoot(env)
  const lock = await impl.takeLock(root, { name: LOOP_LOCK_NAME })
  if (lock === null) return { state: "busy" }
  try {
    const { qualification, ...restored } = await impl.restore({ recordFile: triagePaths(root).recordFile, env })
    return restored
  } finally {
    await impl.releaseLock(lock)
  }
}

/** `qualifyTriage(env, { now, impls }) -> { state, reason, launched }`: the supported command. See the header. */
export async function qualifyTriage(env, { now = Date.now, impls = {} } = {}) {
  const impl = { ...DEFAULT_IMPLS, ...impls }
  const refused = gate(env, impl)
  if (refused) return answer("refused", refused)
  const root = await impl.stateRoot(env)
  const lock = await impl.takeLock(root, { name: LOOP_LOCK_NAME })
  if (lock === null) return answer("refused", "busy")
  try {
    const paths = triagePaths(root)
    await impl.mkdir(paths.dir)
    const restored = await impl.restore({ recordFile: paths.recordFile, env })
    if (restored.state === "qualified") return answer("qualified", "already_qualified")
    const outcome = await qualifyInPlace(env, paths, { now, deadline: null, generation: null, legacyEvaluator: undefined }, impl)
    // A command run, whatever its result, ends an automatic streak: a person has looked.
    const marker = await readMarker(paths.marker, impl)
    if (marker !== null && marker !== "damaged" && marker.streak !== 0) await impl.writeMarker(paths.marker, { ...marker, streak: 0 })
    return outcome
  } finally {
    await impl.releaseLock(lock)
  }
}

/**
 * `autoQualifyTriage(env, { lock, now, deadline, generation, legacyEvaluator, impls }) -> { state, reason, launched }`: the loop
 * worker's bounded attempt. `lock` is the worker's own held `loop-worker.running` lock. `state` is `qualified`, `failed`,
 * `refused` (a gate, the ledger, or the lock) or `skipped` (nothing to do, or not today). `launched` is true whenever a native
 * run started, so the caller treats the agent slot as used.
 */
export async function autoQualifyTriage(env, { lock, now = Date.now, deadline, generation = null, legacyEvaluator, impls = {} }) {
  const impl = { ...DEFAULT_IMPLS, ...impls }
  const refused = gate(env, impl)
  if (refused) return answer("refused", refused)
  const root = await impl.stateRoot(env)
  if (!(await lockHeld(lock, root, impl))) return answer("refused", "lock_not_held")
  const paths = triagePaths(root)
  await impl.mkdir(paths.dir)
  const restored = await impl.restore({ recordFile: paths.recordFile, env })
  if (restored.state === "qualified") return answer("skipped", "qualified")
  if (!(restored.state === "missing" || (restored.state === "stale" && restored.requalify))) return answer("skipped", "not_requalifiable", { restore: restored })
  const trigger = restored.state === "missing" ? "missing" : restored.reason
  const nowMs = now()
  const today = dayOf(nowMs)
  const marker = await readMarker(paths.marker, impl)
  if (marker === "damaged") {
    // Fail closed: a marker that cannot be read is today's attempt.
    await impl.writeMarker(paths.marker, { version: 1, day: today, started_at: null, trigger: null, streak: 0, result: "marker_damaged", reason: null })
    return answer("skipped", "attempted_today")
  }
  if (marker?.day === today) return answer("skipped", "attempted_today")
  // `streak` counts this trigger's failed attempts in a row; an attempt that never finished counts as failed.
  const counted = !STREAK_EXEMPT.has(trigger)
  const failures = counted && marker?.trigger === trigger && ["failed", "started"].includes(marker.result) ? marker.streak : 0
  if (failures >= AUTO_STREAK_LIMIT) return answer("skipped", "auto_suspended", { trigger })
  if (!Number.isSafeInteger(deadline) || deadline - nowMs < AUTO_MIN_REMAINING_MS) return answer("skipped", "no_time")
  const started = { version: 1, day: today, started_at: new Date(nowMs).toISOString(), trigger, streak: counted ? failures + 1 : 0, result: "started", reason: null }
  let attempted = false
  // Written once the ledger has reserved the launches: a refusal before that (no engine, signed out, the ledger) is not an
  // attempt, and the next due tick may try again.
  const reserved = async () => {
    await impl.writeMarker(paths.marker, started)
    attempted = true
  }
  const outcome = await qualifyInPlace(env, paths, { now, deadline, generation, legacyEvaluator, reserved }, impl)
  if (attempted) {
    await impl.writeMarker(paths.marker, { ...started, streak: outcome.state === "failed" && counted ? failures + 1 : 0, result: outcome.state, reason: outcome.reason })
  }
  return outcome
}

// The transaction under the lock: engine, sign-in, move-aside, qualifier, ledger. `reserved` runs once the ledger reserved the
// launches, before the first one; a throw there launches nothing.
async function qualifyInPlace(env, paths, { now, deadline, generation, legacyEvaluator, reserved: onReserved = async () => {} }, impl) {
  const cli = impl.locate({ env })
  if (!cli) return answer("refused", "engine_unpinned")
  let childEnv
  try {
    childEnv = impl.childEnv(env)
  } catch {
    return answer("refused", "environment_unsafe")
  }
  const signIn = await impl.signIn({ cli, env: childEnv })
  if (signIn.state !== "subscription") return answer("refused", signIn.state)
  const nowMs = now()
  const aside = (await impl.exists(paths.out)) ? `${paths.out}.aside-${stamp(nowMs)}-${impl.random()}` : null
  if (aside) await impl.rename(paths.out, aside)
  let token = null
  let ledger = null
  const reserve = async () => {
    const reservation = await impl.reserve(env, { kind: "triage", launches: 2, generation, now: now(), legacyEvaluator })
    if (reservation.state !== "reserved") {
      ledger = reservation.state
      throw new Error("quota_refused")
    }
    token = reservation.token
    await onReserved()
  }
  let result
  try {
    result = await impl.qualify({ out: paths.out, cli, env, deadline: deadline ?? undefined, reserve })
  } catch {
    result = { state: "blocked", reason: "diagnostic_inadequate", resources: { launches: 0 } }
  }
  const launched = (result.resources?.launches ?? 0) > 0
  if (token !== null) {
    await impl.finish(env, { token, state: launched ? (result.state === "qualified" ? "ran" : "failed") : "not_started", now: now() })
  }
  if (ledger !== null) {
    // Nothing launched: keep this attempt's evidence beside the record, and put the earlier record back.
    if (await impl.exists(paths.out)) await impl.rename(paths.out, `${paths.out}.aside-${stamp(nowMs)}-${impl.random()}-unstarted`)
    if (aside) await impl.rename(aside, paths.out)
    return answer("refused", ledger)
  }
  return answer(result.state === "qualified" ? "qualified" : "failed", result.state === "qualified" ? null : result.reason ?? "diagnostic_inadequate", { launched })
}
