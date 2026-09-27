// The crew roster: the `_meta/desks.md` table that binds each person's
// identity to their own desk, as `desk:session-start` Step 2.6 documents it:
//
//   | alias | identity | path | repo | worker_variant | write_subtree |
//
// Only this table makes a workspace a crew workspace. The same file name also
// holds other registries: a single-owner hub keeps a cross-desk routing
// registry there (its own "Solo desks" and "Crew desks" tables), and a spoke
// desk keeps a pointer to its hub. Neither has a crew roster, so both are
// single-owner desks, tidied and checked at their own root.
//
// A table is the roster when its header names both `alias` and `identity`.
// Those two columns are the identity-to-desk binding the roster exists for,
// and no other registry uses them. The other four columns describe each desk;
// requiring them too would turn a real crew roster that leaves one out into a
// single-owner desk, and a tidy would then write at the crew root, outside the
// person's own desk. A missing roster must never fail open that way.
//
// Dependency-free: `scripts/tidy-status.js` runs this straight from the
// installed plugin, and hooks may run it on an old Node.

import { readFileSync } from "node:fs"
import * as path from "node:path"

export const CREW_ROSTER_FILE = path.join("_meta", "desks.md")
export const CREW_ROSTER_KEY_COLUMNS = Object.freeze(["alias", "identity"])

function tableCells(trimmed) {
  return trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())
}

/**
 * Every Markdown table in `raw`, in order: `[{ header, rows }]`. The header
 * is lowercased; separator rows (`|---|:--:|`) are left out. A table is a run
 * of consecutive lines that start with `|`; any other line ends it.
 */
export function markdownTables(raw) {
  const tables = []
  let current = null
  for (const line of String(raw).split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) {
      current = null
      continue
    }
    const cells = tableCells(trimmed)
    if (current === null) {
      current = { header: cells.map((cell) => cell.toLowerCase()), rows: [] }
      tables.push(current)
      continue
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    current.rows.push(cells)
  }
  return tables
}

/**
 * The crew roster in `raw` as `[{ alias, identity }]`, one entry per row
 * (either cell may be empty), or null when `raw` has no crew roster table.
 * The first table whose header names every key column is the roster.
 */
export function parseCrewRoster(raw) {
  const roster = markdownTables(raw).find((table) => CREW_ROSTER_KEY_COLUMNS.every((column) => table.header.includes(column)))
  if (roster === undefined) return null
  const aliasAt = roster.header.indexOf("alias")
  const identityAt = roster.header.indexOf("identity")
  return roster.rows.map((cells) => ({ alias: cells[aliasAt] ?? "", identity: cells[identityAt] ?? "" }))
}

/**
 * The crew roster of the desk at `deskRoot`, or null when the desk is not a
 * crew workspace: no `_meta/desks.md`, an unreadable one, or one without the
 * roster table (a hub's routing registry, a spoke's pointer).
 */
export function readCrewRoster(deskRoot) {
  if (typeof deskRoot !== "string" || deskRoot === "") return null
  let raw
  try {
    raw = readFileSync(path.join(deskRoot, CREW_ROSTER_FILE), "utf8")
  } catch {
    return null
  }
  return parseCrewRoster(raw)
}
