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

import { loadEndHook, pluginRootFor } from "../factory/end-hook.js"
import { readSmallText } from "../factory/marker.js"
import { PATTERNS } from "../factory/schema.js"
import { ORPHAN_FINDING_ADVICE, UNASKED_ADVICE, factoryLocalStatus, factoryReportLink } from "../factory/local-status.js"
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

/** `factoryLocalStatus` for `deskRoot` (or no desk) with this host's plugin set. */
export function factoryStatus({ env, deskRoot }) {
  const { dirs, incomplete } = factoryPluginScan(env)
  const status = factoryLocalStatus({ env, deskRoot, pluginDirs: dirs, pluginScanIncomplete: incomplete })
  return deskRoot === null || deskRoot === undefined ? status : { ...status, signoff: signoffCounts(deskRoot) }
}

/** `factoryReportLink` with this host's plugin set: the task card's `factory_report`, or `null` without consent. */
export function reportLink({ env, deskRoot, deskRemote, personPrefix, track, slug }) {
  const { dirs, incomplete } = factoryPluginScan(env)
  return factoryReportLink({ env, deskRoot, deskRemote, personPrefix, track, slug, pluginDirs: dirs, pluginScanIncomplete: incomplete })
}

/** The human-readable "Factory" section desk_doctor adds to its summary: store names, codes and counts only. */
export function factorySummary(status) {
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
  if (status.orphans !== undefined) lines.push(`  orphan pass needs attention: ${status.orphans}${status.orphans_hung > 0 ? ` (${status.orphans_hung} orphans hung)` : ""}. ${ORPHAN_FINDING_ADVICE}`)
  if (status.warnings.length > 0) lines.push(`  plugin manifests skipped: ${status.warnings.join(", ")}`)
  if (status.signoff) lines.push(signoffLine(status.signoff))
  return lines.join("\n")
}

// "sign-off: 3 delivered tasks await sign-off, oldest 9 days; 2 delivered before sign-off was recorded". A lower bound says "at least".
function signoffLine({ unsigned, oldest_unsigned_age_days: oldest, not_recorded: notRecorded }) {
  if (unsigned.state === "unavailable") return `  sign-off: not checked (${unsigned.reason})`
  const least = (figure) => (figure.state === "partial" ? "at least " : "")
  const days = (n) => `${n} ${n === 1 ? "day" : "days"}`
  const count = unsigned.value
  const earlier = notRecorded.state === "unavailable" || notRecorded.value === 0 ? "" : `; ${least(notRecorded)}${notRecorded.value} delivered before sign-off was recorded`
  if (count === 0) return `  sign-off: no delivered tasks await sign-off${earlier}`
  const head = `${least(unsigned)}${count} delivered ${count === 1 ? "task awaits" : "tasks await"} sign-off`
  const age = oldest.state === "unavailable" ? "age unknown" : `${least(oldest)}${days(oldest.value)}`
  return `  sign-off: ${head}, oldest ${age}${earlier}`
}
