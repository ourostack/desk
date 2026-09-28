// Leftover partitions of the retired manual work ledger.
//
// The ledger kept one owner-only folder per desk-and-person binding under
// `<state home>/ouroboros-skills/desk/work-ledger/`. It retired when the
// factory started accounting for finished jobs automatically, and its private
// records stay where they are: nothing migrates or deletes them. This module
// only counts the partition folders, so `desk_doctor` can tell the operator
// they exist. It lists one folder and never opens, reads or follows anything
// inside it, and it creates nothing.

import { lstatSync, readdirSync } from "node:fs"
import * as path from "node:path"

import { resolveStateHome } from "../util/paths.js"

export const LEGACY_LEDGER_SEGMENTS = Object.freeze(["ouroboros-skills", "desk", "work-ledger"])

/**
 * `{ partitions, path }`: how many partition folders the retired ledger left
 * under this user's state home, `0` when it never existed. When the folder is
 * there but cannot be counted, `partitions` is `null` with `unavailable` set to
 * `not_a_directory` (including a symlink, which is never followed) or
 * `unreadable`, never a made-up zero.
 */
export function legacyLedgerPartitions({ env }) {
  // The same state-home lookup the protected stores (and so the retired ledger) use.
  const dir = path.join(resolveStateHome(env), ...LEGACY_LEDGER_SEGMENTS)
  let stat
  try {
    stat = lstatSync(dir)
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { partitions: 0, path: dir }
    return { partitions: null, path: dir, unavailable: "unreadable" }
  }
  if (!stat.isDirectory()) return { partitions: null, path: dir, unavailable: "not_a_directory" }
  try {
    // `withFileTypes` reads the entries' own types, so a symlinked entry is not a partition and nothing is followed.
    const partitions = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    return { partitions, path: dir }
  } catch {
    return { partitions: null, path: dir, unavailable: "unreadable" }
  }
}

/** The human-readable doctor section, or `null` when there is nothing to report. */
export function legacyLedgerSummary(result) {
  if (result.partitions === 0) return null
  if (result.partitions === null) return `Retired work ledger\n  the legacy folder could not be counted (${result.unavailable}): ${result.path}`
  const noun = result.partitions === 1 ? "partition" : "partitions"
  return [
    "Retired work ledger",
    `  ${result.partitions} private ${noun} remain under ${result.path}.`,
    "  Desk no longer reads or writes them and never deletes them; the factory now accounts for finished jobs. Remove the folder yourself when you no longer want those records.",
  ].join("\n")
}
