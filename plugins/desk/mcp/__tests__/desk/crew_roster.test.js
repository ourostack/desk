// The crew roster (`_meta/desks.md`'s alias/identity table) is the only thing
// that makes a desk a crew workspace. A hub's routing registry and a spoke's
// pointer share the file name but are single-owner desks. Fixtures are
// synthetic and live in temporary folders only.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import {
  CREW_ROSTER_FILE,
  CREW_ROSTER_KEY_COLUMNS,
  markdownTables,
  parseCrewRoster,
  readCrewRoster,
} from "../../src/desk/crew-roster.js"

const ROSTER = [
  "# Desks",
  "",
  "| alias | identity | path | repo | worker_variant | write_subtree |",
  "|-------|----------|------|------|----------------|---------------|",
  "| alex  | agarcia_corp | desks/alex | example-org/crew-workspace | crew | desks/alex |",
  "| bob   | bsmith | desks/bob | example-org/crew-workspace | crew | desks/bob |",
  "",
].join("\n")

// Only the shape follows a real hub: two routing tables, neither a roster.
const HUB = [
  "# Desks — an operator's desk registry",
  "",
  "## Solo desks",
  "| desk | local path | repo | account | launch |",
  "|---|---|---|---|---|",
  "| work-desk | ~/work-desk | example-org/work-desk | example-login | desk-work |",
  "",
  "## Crew desks",
  "| crew | local path | repo | your alias | launch |",
  "|---|---|---|---|---|",
  "| example-crew | ~/crews/example | example-org/crew | alex | crew-example |",
  "",
].join("\n")

const SPOKE = "# Desks — registry pointer (spoke desk)\n\nSee the hub desk.\n"

async function deskWith(registry) {
  const root = await mkTempRoot("desk-crew-roster-")
  if (registry !== null) {
    await fs.mkdir(path.join(root, "_meta"), { recursive: true })
    await fs.writeFile(path.join(root, CREW_ROSTER_FILE), registry)
  }
  return root
}

test("the roster's key columns are alias and identity, in _meta/desks.md", () => {
  assert.deepEqual([...CREW_ROSTER_KEY_COLUMNS], ["alias", "identity"])
  assert.ok(Object.isFrozen(CREW_ROSTER_KEY_COLUMNS))
  assert.equal(CREW_ROSTER_FILE, path.join("_meta", "desks.md"))
})

test("markdownTables splits each table on its own header and drops separator rows", () => {
  assert.deepEqual(markdownTables(HUB), [
    { header: ["desk", "local path", "repo", "account", "launch"], rows: [["work-desk", "~/work-desk", "example-org/work-desk", "example-login", "desk-work"]] },
    { header: ["crew", "local path", "repo", "your alias", "launch"], rows: [["example-crew", "~/crews/example", "example-org/crew", "alex", "crew-example"]] },
  ])
  assert.deepEqual(markdownTables("| A | B\n|:--|--:\n| x | y"), [{ header: ["a", "b"], rows: [["x", "y"]] }], "a missing trailing pipe is tolerated")
  assert.deepEqual(markdownTables(SPOKE), [])
  assert.deepEqual(markdownTables(""), [])
})

test("the documented roster parses to alias and identity rows", () => {
  assert.deepEqual(parseCrewRoster(ROSTER), [
    { alias: "alex", identity: "agarcia_corp" },
    { alias: "bob", identity: "bsmith" },
  ])
})

test("a hub's routing registry, a spoke's pointer and a partial table are not a roster", () => {
  assert.equal(parseCrewRoster(HUB), null)
  assert.equal(parseCrewRoster(SPOKE), null)
  assert.equal(parseCrewRoster("| alias | path |\n|---|---|\n| alex | desks/alex |\n"), null, "alias alone is not the binding")
  assert.equal(parseCrewRoster("| identity | path |\n|---|---|\n| agarcia | desks/alex |\n"), null, "identity alone is not the binding")
})

test("the roster is found in any table position and column order, and short rows read as empty cells", () => {
  const raw = `${HUB}\n## Roster\n\n| path | Identity | ALIAS |\n|---|---|---|\n| desks/cam | cam-login | cam |\n| desks/dee |\n`
  assert.deepEqual(parseCrewRoster(raw), [
    { alias: "cam", identity: "cam-login" },
    { alias: "", identity: "" },
  ])
})

test("readCrewRoster reads the desk's roster and is null for every desk without one", async () => {
  assert.deepEqual(readCrewRoster(await deskWith(ROSTER)), [
    { alias: "alex", identity: "agarcia_corp" },
    { alias: "bob", identity: "bsmith" },
  ])
  assert.equal(readCrewRoster(await deskWith(HUB)), null)
  assert.equal(readCrewRoster(await deskWith(SPOKE)), null)
  assert.equal(readCrewRoster(await deskWith(null)), null, "no file")
  const unreadable = await deskWith(null)
  await fs.mkdir(path.join(unreadable, CREW_ROSTER_FILE), { recursive: true })
  assert.equal(readCrewRoster(unreadable), null, "a directory in the file's place")
  assert.equal(readCrewRoster(null), null)
  assert.equal(readCrewRoster(""), null)
})
