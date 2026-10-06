// A small per-machine index of the cards that have resource rows with no disposition yet, so a cleanup reminder is not lost
// when the card is finished and archived (boot scans only live, unfinished cards).
//
// It lives in Desk's state directory, keyed by the desk root like the sync files: `cleanup/<root key>.json`, `{ schema_version, cards: [<card folder relative to the desk root>] }`, most recently recorded first.
// It is written only when a `resource` call writes a row (`recordCleanupCard`), which also drops every card that has no open row left or is gone. It holds no due-ness: boot recomputes that from the card itself
// each time (active-tasks.js), so a card finished by any path is picked up. Because the index is per machine, only the machine that recorded a row reminds about it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { lastStartRootKey, resolveDeskStateDir } from "../runtime/last-start.js"
import { assertNotRealStateUnderTest } from "../runtime/test-state-guard.js"
import { openResources } from "./resources.js"

/** How many indexed cards boot reads, and how many the file keeps. */
export const BOOT_CARDS = 20
const FILE_CARDS = 50

export const cleanupIndexPath = (deskRoot, env = process.env) => path.join(resolveDeskStateDir({ env }), "cleanup", `${lastStartRootKey(deskRoot)}.json`)

/** The card's file at its live path and under its track's `_archive` (the two-path lookup of tools/task-focus.js), for a folder relative to the desk root. */
export const cardFiles = (deskRoot, rel) => [path.join(deskRoot, rel, "task.md"), path.join(deskRoot, path.dirname(rel), "_archive", path.basename(rel), "task.md")]

const safe = (rel) => typeof rel === "string" && rel !== "" && !path.isAbsolute(rel) && !rel.split(/[\\/]/u).includes("..")

/** The indexed card folders, newest first, at most `BOOT_CARDS`; an unreadable or odd file reads as empty. */
export function readCleanupIndex(deskRoot, env = process.env) {
  try {
    const { cards } = JSON.parse(readFileSync(cleanupIndexPath(deskRoot, env), "utf8"))
    return cards.filter(safe).slice(0, BOOT_CARDS)
  } catch {
    return []
  }
}

const stillOpen = (deskRoot, rel) => cardFiles(deskRoot, rel).some((file) => existsSync(file) && openResources(readFileSync(file, "utf8")).length > 0)

/** Record that the card at `rel` was just written: it goes first when it has an open row, and every card with none left, or gone, is dropped. */
export function recordCleanupCard(deskRoot, folder, hasOpen, env = process.env) {
  // An archived card is listed by its live folder name, as the lookup in `cardFiles` expects.
  const rel = path.basename(path.dirname(folder)) === "_archive" ? path.join(path.dirname(path.dirname(folder)), path.basename(folder)) : folder
  const file = cleanupIndexPath(deskRoot, env)
  assertNotRealStateUnderTest(path.dirname(path.dirname(file)))
  let before = []
  try {
    before = JSON.parse(readFileSync(file, "utf8")).cards.filter(safe)
  } catch {
    // No index yet, or one that cannot be read: start again from this card.
  }
  const cards = [...(hasOpen ? [rel] : []), ...before.filter((card) => card !== rel && stillOpen(deskRoot, card))].slice(0, FILE_CARDS)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ schema_version: 1, cards })}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}
