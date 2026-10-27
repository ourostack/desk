// The team's roster as Crew reads it: the starter a new team gets, the interview questions a team can change in its
// own roster, whether a member is listed, and the three-way merge that lands an entry next to a teammate's change.
// Every name is an invented placeholder.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { DEFAULT_PEOPLE, DEFAULT_QUESTIONS, listedIn, mergePeople, peopleQuestions, starterRoster, toLf } from "../../../../../plugins/desk/mcp/src/crew/people.js"
import { CIT_SHAPED, CIT_STANDIN_ROSTER } from "./_fixtures.js"

test("the starter roster: purpose, writing rules, the questions, Teammates and Contacts", () => {
  const starter = starterRoster()
  assert.equal(DEFAULT_PEOPLE, "_shared/landscape/roster.md")
  for (const heading of ["# Roster", "## How to write in it", "## What we ask new teammates", "## Teammates", "## Contacts"]) assert.ok(starter.includes(`\n${heading}\n`) || starter.startsWith(`${heading}\n`), heading)
  assert.match(starter, /Never guess pronouns: write "not shared"/u)
  assert.match(starter, /`### Name \(alias\)`/u)
  assert.deepEqual(peopleQuestions(starter), { questions: [...DEFAULT_QUESTIONS], from: "roster" })
  assert.equal(DEFAULT_QUESTIONS.length, 6)
  assert.ok(starter.endsWith("\n") && !starter.includes("\r"))
})

test("questions come from the roster's own heading, at any level, numbered or bulleted; otherwise Crew's defaults", () => {
  const own = "# Team\r\n\r\n### what WE ask new teammates ###\r\n\r\nIntro.\r\n\r\n1) Favorite tool?\r\n- Which customers do you know?\r\n  * Nested counts too\r\n\r\n## Next\r\n\r\n1. Not a question\r\n"
  assert.deepEqual(peopleQuestions(own), { questions: ["Favorite tool?", "Which customers do you know?", "Nested counts too"], from: "roster" })
  assert.deepEqual(peopleQuestions(CIT_SHAPED["team/roster.md"]), { questions: [...DEFAULT_QUESTIONS], from: "crew" })
  assert.deepEqual(peopleQuestions("## What we ask new teammates\n\nNothing listed.\n"), { questions: [...DEFAULT_QUESTIONS], from: "crew" })
  assert.deepEqual(peopleQuestions(null), { questions: [...DEFAULT_QUESTIONS], from: "crew" })
})

test("listed: an alias or identity as a whole word, ignoring case", () => {
  const roster = "| Name | Alias |\n|---|---|\n| Pat Example | pexample |\n\n### Sam Sample (ssample)\n\nTold us when joining. Ask sam.\n"
  assert.equal(listedIn(roster, ["PEXAMPLE"]), true)
  assert.equal(listedIn(roster, ["nobody", "ssample"]), true)
  assert.equal(listedIn(roster, ["sam"]), true, "a sentence's full stop ends the word")
  assert.equal(listedIn(roster, ["pex"]), false)
  assert.equal(listedIn(roster, ["example"]), true)
  assert.equal(listedIn(roster, ["pexample_x", "s.sample", "", null]), false)
  assert.equal(listedIn("pat_example and pat-x", ["pat"]), false)
})

const BASE = "# Roster\n\n## Teammates\n\nOne section per teammate, newest last.\n\n### Pat Example (pat)\n\nRole: placeholder\n\n## Contacts\n\nNone.\n"
const add = (text, section) => text.replace("\n## Contacts", `\n${section}\n## Contacts`)

test("merge: a teammate's change elsewhere and ours both land", () => {
  const ours = add(BASE, "### Newbie (newbie)\n\nRole: new\n")
  const theirs = BASE.replace("None.", "None.\n\n### Partner Person\n\nGo to them for: billing\n")
  const { text } = mergePeople({ base: BASE, ours, theirs })
  assert.match(text, /### Newbie \(newbie\)/u)
  assert.match(text, /### Partner Person/u)
})

test("merge: two people adding at the same place both land, the teammate's first", () => {
  const ours = add(BASE, "### Newbie (newbie)\n\nRole: new\n")
  const theirs = add(BASE, "### Other (other)\n\nRole: earlier\n")
  const { text } = mergePeople({ base: BASE, ours, theirs })
  assert.ok(text.indexOf("### Other (other)") < text.indexOf("### Newbie (newbie)"), text)
  assert.equal(text.match(/## Contacts/gu).length, 1)
  // A table: two rows added at its end.
  const table = CIT_SHAPED["team/roster.md"]
  const rows = mergePeople({ base: table, ours: `${table}| New Person | newbie | Placeholder | not shared | told us when joining |\n`, theirs: `${table}| Other Person | other | Placeholder | not shared | Invented |\n` })
  assert.match(rows.text, /\| Other Person \|.*\n\| New Person \|/u)
})

// The stand-in for CIT's roster: one table row per teammate, keyed on the Alias column.
const CIT = CIT_STANDIN_ROSTER
const row = (name) => CIT.split("\n").find((line) => line.startsWith(`| ${name} |`))
const edit = (text, name, to) => text.replace(row(name), to)
const THEO = "| Theo Lindqvist | tlindqvist | Principal TPM | he/him | Directory profile 2026-10-27; told us when joining, 2026-10-27 |"
const MINA = "| Mina Castellanos | minac | Principal Product Manager | she/her | Directory profile 2026-10-27; told us when joining, 2026-10-27 |"
const NEW = "| New Person | newp | Engineer | they/them | told us when joining, 2026-10-27 |"

test("merge, CIT's table: two joiners each fixing their own neighbouring row both land", () => {
  const { text } = mergePeople({ base: CIT, ours: edit(CIT, "Theo Lindqvist", THEO), theirs: edit(CIT, "Mina Castellanos", MINA) })
  assert.equal(text, edit(edit(CIT, "Theo Lindqvist", THEO), "Mina Castellanos", MINA))
})

test("merge, CIT's table: a row added under a row a teammate just edited lands after it", () => {
  const ours = CIT.replace(`${row("Theo Lindqvist")}\n`, `${row("Theo Lindqvist")}\n${NEW}\n`)
  const { text } = mergePeople({ base: CIT, ours, theirs: edit(CIT, "Theo Lindqvist", THEO) })
  assert.equal(text, CIT.replace(`${row("Theo Lindqvist")}\n`, `${THEO}\n${NEW}\n`))
  // Added at the top, it stays at the top; a teammate's own new row at the same place comes first.
  const header = "|---|---|---|---|---|\n"
  const first = mergePeople({ base: CIT, ours: CIT.replace(header, `${header}${NEW}\n`), theirs: CIT.replace(header, `${header}| Other | other | x | x | x |\n`) }).text
  assert.ok(first.includes(`${header}| Other | other | x | x | x |\n${NEW}\n${row("Robin Okafor")}`), first)
})

test("merge, CIT's table: the same row changed both ways is a conflict; the same change, or a removal, is not", () => {
  const theirs = edit(CIT, "Theo Lindqvist", THEO.replace("he/him", "they/them"))
  assert.deepEqual(mergePeople({ base: CIT, ours: edit(CIT, "Theo Lindqvist", THEO), theirs }), { conflict: true })
  assert.deepEqual(mergePeople({ base: CIT, ours: edit(CIT, "Theo Lindqvist", THEO), theirs: edit(CIT, "Theo Lindqvist", THEO) }), { text: edit(CIT, "Theo Lindqvist", THEO) })
  // A row a teammate removed stays removed next to our change to its neighbour; removing a row they changed conflicts.
  const removed = CIT.replace(`${row("Mina Castellanos")}\n`, "")
  assert.equal(mergePeople({ base: CIT, ours: edit(CIT, "Theo Lindqvist", THEO), theirs: removed }).text, edit(removed, "Theo Lindqvist", THEO))
  assert.deepEqual(mergePeople({ base: CIT, ours: CIT.replace(`${row("Theo Lindqvist")}\n`, ""), theirs }), { conflict: true })
})

test("merge, a table with no Alias column: whole rows; both replacing the same row conflicts", () => {
  const agent = CIT.split("\n").find((line) => line.startsWith("| Each teammate's agent |"))
  const mine = CIT.replace(agent, agent.replace("Invented for this test", "ours"))
  const yours = CIT.replace(agent, agent.replace("Invented for this test", "theirs"))
  assert.deepEqual(mergePeople({ base: CIT, ours: mine, theirs: yours }), { conflict: true })
  // One side replaces the row, the other adds one under it: both land, the teammate's new row first.
  const shared = "| A shared agent | One for the team | Robin | Invented |"
  const added = CIT.replace(`${agent}\n`, `${agent}\n${shared}\n`)
  assert.equal(mergePeople({ base: CIT, ours: mine, theirs: added }).text, CIT.replace(`${agent}\n`, `${shared}\n${agent.replace("Invented for this test", "ours")}\n`))
  // A row with no alias in an Alias table is keyed on the whole row, as is one too short to have the column.
  const short = "| Name | Title | Alias |\n|---|---|---|\n| Pat | x |\n| Sam | y | |\n"
  assert.equal(mergePeople({ base: short, ours: `${short}| New | z | new |\n`, theirs: short.replace("| Pat | x |", "| Pat | x2 |") }).text, `${short.replace("| Pat | x |", "| Pat | x2 |")}| New | z | new |\n`)
})

test("merge: a table Crew cannot key row by row is merged line by line, where neighbouring changes conflict", () => {
  const neighbours = (text) => mergePeople({ base: text, ours: text.replace("| one | a |", "| uno | a |"), theirs: text.replace("| two | b |", "| dos | b |") })
  const table = "| Name | Alias |\n|---|---|\n| one | a |\n| two | b |\n"
  assert.equal(neighbours(table).text, "| Name | Alias |\n|---|---|\n| uno | a |\n| dos | b |\n")
  // The same header twice, two rows with one alias, or a file that holds Crew's own placeholder: line by line.
  assert.deepEqual(neighbours(`${table}\n| Name | Alias |\n|---|---|\n| three | c |\n`), { conflict: true })
  assert.deepEqual(neighbours(`${table}| three | A |\n`), { conflict: true })
  assert.deepEqual(neighbours(`${table}\ncrew-roster-table-rows 0\n`), { conflict: true })
  // Text next to a table merges as before, line by line around it.
  const prose = `Intro.\n\n${table}\nAfter.\n`
  assert.equal(mergePeople({ base: prose, ours: prose.replace("After.", "After, ours."), theirs: prose.replace("| two | b |", "| dos | b |") }).text, `Intro.\n\n${table.replace("| two | b |", "| dos | b |")}\nAfter, ours.\n`)
})

test("merge: the same existing lines changed on both sides is a conflict; the same change on both is not", () => {
  const ours = BASE.replace("Role: placeholder", "Role: ours")
  assert.deepEqual(mergePeople({ base: BASE, ours, theirs: BASE.replace("Role: placeholder", "Role: theirs") }), { conflict: true })
  assert.deepEqual(mergePeople({ base: BASE, ours, theirs: ours }), { text: ours })
})

test("merge: line endings and a missing final newline do not make a conflict", () => {
  const ours = add(BASE, "### Newbie (newbie)\n")
  const { text } = mergePeople({ base: BASE.replace(/\n/gu, "\r\n"), ours: ours.replace(/\n$/u, ""), theirs: BASE })
  assert.equal(text, ours)
  assert.equal(toLf("a\r\nb\n"), "a\nb\n")
})

test("merge: git that cannot run is an error, not a conflict; every run hides its window", () => {
  const seen = []
  const failing = (cmd, args, options) => (seen.push(options.windowsHide), { status: null, stdout: null, stderr: null })
  assert.deepEqual(mergePeople({ base: BASE, ours: BASE, theirs: BASE, spawnGit: failing }), { error: "git merge-file did not run" })
  const broken = (cmd, args, options) => spawnSync(cmd, [...args.slice(0, -1), "/no/such/file"], options)
  assert.match(mergePeople({ base: BASE, ours: BASE, theirs: BASE, spawnGit: broken }).error, /\S/u)
  assert.deepEqual(seen, [true])
  // A temporary folder Windows will not let go of yet is left for the system, not turned into a failure.
  const stuck = () => {
    throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
  }
  assert.deepEqual(mergePeople({ base: BASE, ours: BASE, theirs: BASE, remove: stuck }), { text: BASE })
})
