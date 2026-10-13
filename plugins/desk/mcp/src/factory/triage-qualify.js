// How the triage runner's qualification record comes to exist, and when it is made again.
//
// The record lives at `<factory state>/triage/qualification/qualification.json`. Two callers make it, through one transaction:
//
//   - `qualifyTriage(env)`: the supported command (`factory.js triage-qualify`). It takes the loop worker's lock, so no worker
//     reads a half-written record, and qualifies whenever the record does not restore.
//   - `autoQualifyTriage(env, { lock, deadline, ... })`: the loop worker, holding its own lock, when restore says `missing` or a
//     `stale` reason that qualifying again can clear. At most one attempt runs per UTC day (the marker
//     `triage/auto-qualify.json` is written when the qualification starts, so one that fails before any launch counts; a
//     command run that failed counts as today's too, and a marker that cannot be read counts as today's attempt), at least `AUTO_MIN_REMAINING_MS` (6 minutes) must remain before the worker's deadline, and after three failed attempts in a row
//     for the same reason it stops until the command runs. A success, or a ledger refusal, does not count toward that.
//
// Before anything else, both callers ask the shared launch ledger, read-only, whether it would take two triage launches now; a
// refusal there is answered at once (`skipped` for the worker), with nothing run, written or moved. Then: a Darwin arm64 host, no
// headless session, no billing variable, no coverage or loader measurement, the pinned engine installed at a location only this
// account can change, and a subscription sign-in. The two native launches are reserved together only after the qualifier's own
// checks pass, just before the first launch. A refusal there (the ledger changed since the read) launches nothing, removes this
// attempt's folder and puts the earlier record back; the worker then waits until the ledger's own `retry_at`. An earlier record
// is moved aside (`qualification.aside-<UTC stamp>-<hex>`), never deleted in place; only the newest two set-aside records are kept.
// The command passes the stored `status.evaluator` to the ledger as the loop does, so the ledger's first migration counts it.
//
// The marker also keeps `sealed`: true once a sealed record has qualified on this host (or the marker is damaged), which restore
// takes as `sealedBefore`, so an unsealed record shape is damaged from then on rather than stale.

import { randomBytes } from "node:crypto"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import { qualifyTriageRunner } from "../../scripts/qualify-triage-runner.js"
import { LOOP_LOCK_NAME } from "./evaluate-kick.js"
import { billingVariableBlocks, probeSignIn } from "./headless.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { finishAgentLaunch, peekAgentLaunch, reserveAgentLaunch } from "./headless-ledger.js"
import { ensureOwnerOnlyDirectory } from "./os-protect.js"
import { factoryStateRoot, readStatus } from "./outbox.js"
import { releaseLock, takeLock } from "./process-lock.js"
import { ownedCatalogHostSupport } from "./triage-custody.js"
import { locatePinnedEngine, qualificationMeasurementActive, restoreTriageQualification, triageChildEnvironment } from "./triage-runner.js"

/**
 * The least time, before the worker's deadline, an automatic qualification needs. Native qualifications took 83 s and 87 s;
 * the two launches have no time limit of their own beyond the deadline the worker passes, so this is that measurement with
 * about four times margin. It must fit inside the loop worker's budget less what it keeps for later steps (17 minutes); a test
 * holds the two together.
 */
export const AUTO_MIN_REMAINING_MS = 6 * 60 * 1000
/** Failed automatic attempts in a row for the same reason before automatic qualification stops for that reason. */
export const AUTO_STREAK_LIMIT = 3
/** Earlier records kept beside the installed one (`qualification.aside-<stamp>-<hex>`); older ones are removed. */
export const KEPT_ASIDES = 2
/** The furthest ahead a marker's `retry_after` is believed: the ledger's own answers are never later than the next UTC day. */
const RETRY_HORIZON_MS = 24 * 60 * 60 * 1000
// Reasons a new release or engine pin causes, not the host: these never count toward the streak.
const STREAK_EXEMPT = new Set(["record_version", "source_changed", "engine_changed"])
const NAMING = { label: "triage qualification", subject: "folder" }
const MARKER_KEYS = ["version", "day", "started_at", "trigger", "streak", "result", "reason", "sealed", "retry_after", "retry_reason"]
const BLANK_MARKER = Object.freeze({ version: 1, day: null, started_at: null, trigger: null, streak: 0, result: null, reason: null,
  sealed: false, retry_after: null, retry_reason: null })

/** `triageQualifyHost(support, arch)`: whether this host can qualify: process provenance (Darwin) on arm64. The arguments are test seams. */
export const triageQualifyHost = (support = ownedCatalogHostSupport(), arch = process.arch) => support.provenance === true && arch === "arm64"

const DEFAULT_IMPLS = Object.freeze({
  host: () => triageQualifyHost(),
  measurement: qualificationMeasurementActive,
  stateRoot: (env) => factoryStateRoot(env),
  // The stored `status.evaluator`, which the ledger's first migration reads: without it a host that has a status file and no ledger
  // yet would have its ledger made with the day fully spent.
  legacyEvaluator: async (env) => (await readStatus(env)).evaluator,
  list: (dir) => fsp.readdir(dir),
  takeLock,
  releaseLock,
  readLock: async (file) => JSON.parse(await fsp.readFile(file, "utf8")),
  mkdir: (dir) => ensureOwnerOnlyDirectory(dir, process.platform, NAMING),
  restore: restoreTriageQualification,
  locate: locatePinnedEngine,
  signIn: probeSignIn,
  childEnv: triageChildEnvironment,
  qualify: qualifyTriageRunner,
  peek: peekAgentLaunch,
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
  removeTree: (dir) => fsp.rm(dir, { recursive: true, force: true }),
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
const nextDay = (ms) => new Date(Date.parse(`${dayOf(ms)}T00:00:00.000Z`) + 86400000).toISOString()
const nullOr = (value, test) => value === null || test(value)

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
    if (keys.join() !== [...MARKER_KEYS].sort().join() || value.version !== 1 || !nullOr(value.day, (x) => typeof x === "string") ||
      !Number.isSafeInteger(value.streak) || value.streak < 0 || typeof value.sealed !== "boolean" ||
      !nullOr(value.retry_after, (x) => typeof x === "string" && Number.isFinite(Date.parse(x))) ||
      !nullOr(value.retry_reason, (x) => typeof x === "string")) return "damaged"
    return value
  } catch {
    return "damaged"
  }
}

const answer = (state, reason, extra = {}) => ({ state, reason, launched: false, ...extra })
// Whether a sealed record has qualified on this host; a damaged marker answers yes, the conservative side.
const sealedOn = (marker) => marker === "damaged" || marker?.sealed === true

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
    const paths = triagePaths(root)
    const sealedBefore = sealedOn(await readMarker(paths.marker, impl))
    const { qualification, ...restored } = await impl.restore({ recordFile: paths.recordFile, env, sealedBefore })
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
    const before = await readMarker(paths.marker, impl)
    const restored = await impl.restore({ recordFile: paths.recordFile, env, sealedBefore: sealedOn(before) })
    const { outcome } = restored.state === "qualified" ? { outcome: answer("qualified", "already_qualified") }
      : await qualifyInPlace(env, paths, { now, deadline: null, generation: null, legacyEvaluator: await impl.legacyEvaluator(env) }, impl)
    // A command run, whatever its result, ends an automatic streak: a person has looked. A damaged marker stays as it is.
    const marker = await readMarker(paths.marker, impl)
    if (marker === "damaged") return outcome
    const current = marker ?? BLANK_MARKER
    // A qualification that ran and failed here is today's attempt for the loop worker too: it does not run the same one again today.
    const next = { ...current, streak: 0, sealed: current.sealed || outcome.state === "qualified", ...(outcome.state === "failed" ? { day: dayOf(now()) } : {}) }
    if (JSON.stringify(next) !== JSON.stringify(current)) await impl.writeMarker(paths.marker, next)
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
  const marker = await readMarker(paths.marker, impl)
  const restored = await impl.restore({ recordFile: paths.recordFile, env, sealedBefore: sealedOn(marker) })
  if (restored.state === "qualified") {
    if (marker !== "damaged" && marker?.sealed !== true) await impl.writeMarker(paths.marker, { ...(marker ?? BLANK_MARKER), sealed: true })
    return answer("skipped", "qualified")
  }
  if (!(restored.state === "missing" || (restored.state === "stale" && restored.requalify))) return answer("skipped", "not_requalifiable", { restore: restored })
  const trigger = restored.state === "missing" ? "missing" : restored.reason
  const nowMs = now()
  const today = dayOf(nowMs)
  if (marker === "damaged") {
    // Fail closed: a marker that cannot be read is today's attempt, and a sealed record may have qualified here.
    await impl.writeMarker(paths.marker, { ...BLANK_MARKER, day: today, result: "marker_damaged", sealed: true })
    return answer("skipped", "attempted_today")
  }
  if (marker?.day === today) return answer("skipped", "attempted_today")
  // The ledger refused a reservation after the read below had passed: no new attempt before the time it gave. The ledger never
  // names a time more than a day ahead, so a later one is not the ledger's and is ignored; the next refusal overwrites it.
  const wait = marker?.retry_after ? Date.parse(marker.retry_after) - nowMs : 0
  if (wait > 0 && wait <= RETRY_HORIZON_MS) return answer("skipped", marker.retry_reason, { retry_at: marker.retry_after })
  // `streak` counts this trigger's failed attempts in a row; an attempt that never finished counts as failed.
  const counted = !STREAK_EXEMPT.has(trigger)
  const failures = counted && marker?.trigger === trigger && ["failed", "started"].includes(marker.result) ? marker.streak : 0
  if (failures >= AUTO_STREAK_LIMIT) return answer("skipped", "auto_suspended", { trigger })
  if (!Number.isSafeInteger(deadline) || deadline - nowMs < AUTO_MIN_REMAINING_MS) return answer("skipped", "no_time")
  const started = { ...BLANK_MARKER, day: today, started_at: new Date(nowMs).toISOString(), trigger, streak: counted ? failures + 1 : 0,
    result: "started", sealed: marker?.sealed === true }
  let attempted = false
  // Written when the qualification starts, before its own checks: one that fails before any launch is today's attempt too, so it
  // is not run again on every tick. A refusal before that (no engine, signed out, the ledger's read) is not an attempt, and the
  // next due tick may try again.
  const onStarted = async () => {
    await impl.writeMarker(paths.marker, started)
    attempted = true
  }
  const { outcome, ledger } = await qualifyInPlace(env, paths, { now, deadline, generation, legacyEvaluator, started: onStarted }, impl)
  // Read before any preflight: nothing ran, nothing was written, and it is not an attempt.
  if (ledger === "read") return { ...outcome, state: "skipped" }
  if (ledger === "reservation") {
    // The ledger refused the launches after the qualifier's own checks passed: not an attempt, and the marker says when to ask again.
    await impl.writeMarker(paths.marker, { ...(marker ?? BLANK_MARKER), retry_after: outcome.retry_at, retry_reason: outcome.reason })
    return outcome
  }
  if (attempted) {
    await impl.writeMarker(paths.marker, { ...started, streak: outcome.state === "failed" && counted ? failures + 1 : 0, result: outcome.state,
      reason: outcome.reason, sealed: started.sealed || outcome.state === "qualified" })
  }
  return outcome
}

// Earlier records are moved aside, never deleted, but only `KEPT_ASIDES` are kept: a host whose qualification keeps failing would
// otherwise add a folder a day without end. `aside` is the folder this transaction just moved: it is always kept, whatever its name
// sorts as (a clock set back names it older than the others), because a refusal puts it back.
async function pruneAsides(paths, aside, impl) {
  const prefix = `${path.basename(paths.out)}.aside-`
  const others = (await impl.list(paths.dir)).filter((name) => name.startsWith(prefix) && name !== path.basename(aside)).sort()
  for (const name of others.slice(0, Math.max(0, others.length - (KEPT_ASIDES - 1)))) await impl.removeTree(path.join(paths.dir, name))
}

// The transaction under the lock: ledger read, engine, sign-in, move-aside, qualifier, ledger. `started` runs once the refusals
// that need no qualification have passed, just before the qualifier; a throw there starts nothing. `ledger` names where the
// ledger refused (`read` or `reservation`), else null.
async function qualifyInPlace(env, paths, { now, deadline, generation, legacyEvaluator, started: onStarted = async () => {} }, impl) {
  const done = (outcome, ledger = null) => ({ outcome, ledger })
  const peek = await impl.peek(env, { kind: "triage", launches: 2, now: now() })
  if (peek.state !== "ok" && peek.state !== "unknown") return done(answer("refused", peek.state, { retry_at: peek.retry_at }), "read")
  const cli = impl.locate({ env })
  if (!cli) return done(answer("refused", "engine_unpinned"))
  let childEnv
  try {
    childEnv = impl.childEnv(env)
  } catch {
    return done(answer("refused", "environment_unsafe"))
  }
  const signIn = await impl.signIn({ cli, env: childEnv })
  if (signIn.state !== "subscription") return done(answer("refused", signIn.state))
  const nowMs = now()
  const aside = (await impl.exists(paths.out)) ? `${paths.out}.aside-${stamp(nowMs)}-${impl.random()}` : null
  if (aside) {
    await impl.rename(paths.out, aside)
    await pruneAsides(paths, aside, impl)
  }
  await onStarted()
  let token = null
  let ledger = null
  const reserve = async () => {
    const reservation = await impl.reserve(env, { kind: "triage", launches: 2, generation, now: now(), legacyEvaluator })
    if (reservation.state !== "reserved") {
      // A state that blocks every launch carries no time; the next UTC day is the ledger's next settling point.
      ledger = { state: reservation.state, retry_at: reservation.retry_at ?? nextDay(now()) }
      throw new Error("quota_refused")
    }
    token = reservation.token
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
    // Nothing launched: this attempt's folder holds only the direct checks, so it goes, and the earlier record comes back.
    await impl.removeTree(paths.out)
    if (aside) await impl.rename(aside, paths.out)
    return done(answer("refused", ledger.state, { retry_at: ledger.retry_at }), "reservation")
  }
  return done(answer(result.state === "qualified" ? "qualified" : "failed", result.state === "qualified" ? null : result.reason ?? "diagnostic_inadequate", { launched }))
}
