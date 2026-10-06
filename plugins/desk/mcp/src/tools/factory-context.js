// The factory as the Desk MCP tools see it: the host's plugin set, read the
// way the end hook reads it, and the local status and report link built on
// it (`src/factory/local-status.js`).
//
// The host is the one that started this server. Claude Code sets
// `CLAUDE_PLUGIN_ROOT` for a plugin's MCP server and Copilot does not, so
// with it set the scan reads Claude's plugin registry, and without it the
// folders beside Desk's plugin root (`DESK_PLUGIN_ROOT`: Claude's launcher
// sets it, and on every other host the server's entrypoint, `mcp/index.js`,
// sets it to its own installed plugin folder; else this checkout's own). The scan is
// the end hook's own `metadata`, loaded from that plugin root because an
// installed server runs from a source mirror without `hooks/`, so the tools,
// the hooks and the boot check route a desk to the same store. A scan that
// fails is incomplete, which holds routing unless the desk declares its own
// store.

import * as os from "node:os"
import * as path from "node:path"

import { withLoopSwitch } from "../factory/loop-health.js"
import { loadEndHook, pluginRootFor } from "../factory/end-hook.js"
import { readSmallText } from "../factory/marker.js"
import { factoryStateDir } from "../factory/boot-check.js"
import { PATTERNS, isPlainObject } from "../factory/schema.js"
import { CAPTURE_CHECK_ADVICE, ORPHAN_FINDING_ADVICE, RETENTION_FINDING_ADVICE, UNASKED_ADVICE, factoryLocalStatus, factoryReportLink } from "../factory/local-status.js"
import { signoffStatus, unsignedDeliveries } from "../desk/unsigned-deliveries.js"

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value : null)

/** `{ dirs, incomplete }`: the plugin folders installed beside Desk for this server's host; see the header. */
export function factoryPluginScan(env) {
  const claudeRoot = text(env.CLAUDE_PLUGIN_ROOT)
  const pluginRoot = pluginRootFor(env)
  // An installed server runs from a source mirror, where `hooks/` is not beside this file; `loadEndHook` finds it.
  const hook = loadEndHook(env)
  try {
    const { metadata } = hook
    const { dirs, incomplete } = metadata({ host: claudeRoot === null ? "copilot" : "claude", pluginRoot, home: text(env.HOME) ?? os.homedir(), env, readSmallText, PATTERNS })
    return { dirs, incomplete }
  } catch {
    return { dirs: [], incomplete: true }
  }
}

// The sign-off counts of the desk (never a task name). The scan reads every unreadable thing as absent, so it does not throw.
function signoffCounts(deskRoot) {
  const now = Date.now()
  return signoffStatus(unsignedDeliveries(deskRoot, { now }), now)
}

const LOOP_SCHEMA = "desk.factory.loop/1"
const QUIET_AFTER_HOURS = 72
const LOOP_STEPS = ["evaluate", "route", "mirror", "reconcile", "verify", "measure", "deliver"]

/** The loop's health record the measure step stored in `status.json` (`loop.health`), or `null` when there is none or it is not a loop record. Read only. */
function storedLoop(env) {
  try {
    const status = JSON.parse(readSmallText(path.join(factoryStateDir(env), "status.json"), 8 * 1024 * 1024))
    const record = isPlainObject(status) && isPlainObject(status.loop) ? status.loop.health : undefined
    return isPlainObject(record) && record.schema === LOOP_SCHEMA ? record : null
  } catch {
    return null
  }
}

/** `factoryLocalStatus` for `deskRoot` (or no desk) with this host's plugin set, the sign-off counts, and `loop`: the stored loop record or `null`. */
export function factoryStatus({ env, deskRoot }) {
  const { dirs, incomplete } = factoryPluginScan(env)
  const status = { ...factoryLocalStatus({ env, deskRoot, pluginDirs: dirs, pluginScanIncomplete: incomplete }), loop: withLoopSwitch(storedLoop(env), env) }
  return deskRoot === null || deskRoot === undefined ? status : { ...status, signoff: signoffCounts(deskRoot) }
}

// A Count as a phrase: the number, or `unavailable (reason)`. Anything that is not a Count reads unavailable, never 0.
function countText(value) {
  if (isPlainObject(value) && value.state === "measured" && Number.isSafeInteger(value.value)) return String(value.value)
  const reason = isPlainObject(value) && value.state === "unavailable" && Array.isArray(value.reasons) && typeof value.reasons[0] === "string" && /^[a-z_]{1,40}$/u.test(value.reasons[0]) ? ` (${value.reasons[0].replaceAll("_", " ")})` : ""
  return `unavailable${reason}`
}

const ageText = (value) => (isPlainObject(value) && value.state === "measured" && Number.isSafeInteger(value.value) ? `${value.value} days` : countText(value))

const part = (record, name) => (isPlainObject(record?.[name]) ? record[name] : {})

/** The "Loop" block: counts and the stale step names from the stored record; with no record it says so and prints no number. */
function loopLines(loop, now) {
  if (!isPlainObject(loop)) return ["Loop", "  no loop record yet: the loop's measure step has not run on this machine"]
  const improvement = part(loop, "improvement")
  const alarms = part(loop, "alarms")
  const evaluator = part(loop, "evaluator")
  const headless = part(evaluator, "headless")
  const steps = part(loop, "steps")
  const stale = LOOP_STEPS.filter((name) => isPlainObject(steps[name]) && steps[name].stale === true)
  const state = typeof headless.state === "string" && /^[a-z_]{1,40}$/u.test(headless.state) ? headless.state : "unavailable"
  const written = typeof loop.written_at === "string" && PATTERNS.timestamp.test(loop.written_at) ? loop.written_at : null
  const version = typeof loop.desk_version === "string" && /^[0-9A-Za-z.+-]{1,40}$/u.test(loop.desk_version) ? loop.desk_version : null
  const lines = ["Loop"]
  const quiet = written !== null && now - Date.parse(written) > QUIET_AFTER_HOURS * 3600 * 1000 ? " (older than 72 hours: this machine is quiet)" : ""
  const by = version === null ? "" : ` by Desk ${version}`
  if (written !== null) lines.push(`  record written ${written}${by}${quiet}`)
  lines.push(`  improvement cards: ${countText(improvement.open)} open, ${countText(improvement.claimed)} claimed, ${countText(improvement.claim_expired)} claim expired, ${countText(improvement.shipped)} shipped, ${countText(improvement.verifying)} verifying`)
  lines.push(`  oldest open ${ageText(improvement.oldest_open_age_days)}; oldest in verification ${ageText(improvement.oldest_in_verification_age_days)}`)
  lines.push(`  alarms: andon ${countText(alarms.andon_open)}, store build failing ${countText(alarms.store_build_failing)}, desk problems ${countText(alarms.desk_problems_open)}, loop alarm cards ${countText(alarms.loop_alarms_open)}`)
  lines.push(`  headless evaluator ${state}, ${countText(evaluator.waiting)} waiting, ${countText(evaluator.gave_up)} gave up`)
  lines.push(`  stale steps: ${stale.length === 0 ? "none" : stale.join(", ")}`)
  if (isPlainObject(loop.worker)) {
    const result = typeof loop.worker.last_result === "string" && /^[a-z0-9_:-]{1,64}$/u.test(loop.worker.last_result) ? loop.worker.last_result : "unavailable"
    lines.push(`  loop worker: last result ${result}${result === "disabled" ? " (switched off on this machine)" : ""}`)
  }
  return lines
}

/** `factoryReportLink` with this host's plugin set: `{ link }`, `{ link: null, reason }`, or `{ link: null }` without consent. */
export function reportLink({ env, deskRoot, deskRemote, personPrefix, track, slug }) {
  const { dirs, incomplete } = factoryPluginScan(env)
  return factoryReportLink({ env, deskRoot, deskRemote, personPrefix, track, slug, pluginDirs: dirs, pluginScanIncomplete: incomplete })
}

/**
 * The factory findings that need someone to act, one plain sentence each, as both the doctor's summary and the plain-text boot print them: the
 * orphan pass, local retention, and each contributed store whose own capture check keeps failing (the boot prefixes each with `Factory: `). Store names, codes and counts only.
 */
export function factoryFindingLines(status) {
  if (!isPlainObject(status)) return []
  const lines = []
  if (status.orphans !== undefined) lines.push(`orphan pass needs attention: ${status.orphans}${status.orphans_hung > 0 ? ` (${status.orphans_hung} orphans hung)` : ""}. ${ORPHAN_FINDING_ADVICE}`)
  if (status.retention !== undefined) lines.push(`local retention needs attention: ${status.retention}. ${RETENTION_FINDING_ADVICE}`)
  for (const { store, times } of status.capture_check_unavailable ?? []) lines.push(`${store}: capture record not landing, the store's own check could not read it ${times} times in a row. ${CAPTURE_CHECK_ADVICE(store)}`)
  return lines
}

/** The human-readable "Factory" section desk_doctor adds to its summary: store names, codes and counts only. */
export function factorySummary(status, { now = Date.now() } = {}) {
  const lines = ["Factory"]
  if (status.store === null) {
    lines.push(`  no store resolved (${status.source}); facts are held on this machine`)
  } else if (status.consent === "undecided") {
    lines.push(`  this desk reports to ${status.store} (${status.source}); contribution not decided yet (raised once, after the operator's own work; never first or in a noninteractive session)`)
  } else {
    lines.push(`  this desk reports to ${status.store} (${status.source}); contribution: ${status.consent}`)
  }
  for (const entry of status.stores) {
    const waiting = entry.waiting_for_visibility > 0 ? `, ${entry.waiting_for_visibility} waiting for a visibility answer` : ""
    const moved = entry.route_changed > 0 ? `, ${entry.route_changed} routed elsewhere` : ""
    lines.push(`  ${entry.store}: ${entry.consent}, ${entry.pending} pending${waiting}${moved}, ${entry.quarantined} quarantined, ${entry.last_flush === null ? "no flush yet" : `last flush ${entry.last_flush}`}`)
  }
  for (const { store, sessions, age } of status.visibility_unasked ?? []) lines.push(`  ${store}: ${sessions} sessions wait because their desk's visibility could not be asked for ${age === "unknown" ? "an unknown time" : "over 7 days"}. ${UNASKED_ADVICE(store)}`)
  lines.push(...factoryFindingLines(status).map((line) => `  ${line}`))
  for (const entry of status.stores) {
    if (entry.kept_frozen > 0) lines.push(`  ${entry.store}: ${entry.kept_frozen} kept copies have no route back and are never published (oldest ${entry.kept_frozen_oldest_days === null ? "of unknown age" : `${entry.kept_frozen_oldest_days} days`}); this is the fail-closed cost of a session whose route can no longer be shown, not a fault.`)
  }
  if (status.warnings.length > 0) lines.push(`  plugin manifests skipped: ${status.warnings.join(", ")}`)
  if (status.signoff) lines.push(signoffLine(status.signoff))
  lines.push(...loopLines(status.loop, now))
  return lines.join("\n")
}

// "sign-off: 3 delivered tasks await sign-off, oldest 9 days; 2 delivered before sign-off was recorded". A lower bound says "at least".
function signoffLine({ unsigned, oldest_unsigned_age_days: oldest, not_recorded: notRecorded }) {
  if (unsigned.state === "unavailable") return `  sign-off: not checked (${unsigned.reason})`
  const least = (figure) => (figure.state === "partial" ? "at least " : "")
  const days = (n) => `${n} ${n === 1 ? "day" : "days"}`
  const count = unsigned.value
  const earlier = notRecorded.state === "unavailable" || notRecorded.value === 0 ? "" : `; ${least(notRecorded)}${notRecorded.value} delivered before sign-off was recorded`
  if (count === 0) return unsigned.state === "partial" ? `  sign-off: no delivered task found awaiting sign-off, but not every card was read (${unsigned.reason})${earlier}` : `  sign-off: no delivered tasks await sign-off${earlier}`
  const head = `${least(unsigned)}${count} delivered ${count === 1 ? "task awaits" : "tasks await"} sign-off`
  const age = oldest.state === "unavailable" ? "age unknown" : `${least(oldest)}${days(oldest.value)}`
  return `  sign-off: ${head}, oldest ${age}${earlier}`
}
