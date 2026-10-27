// The team's roster as Crew reads it: the starter a new team gets, the interview questions a team can change in its
// own roster, whether a member is listed, and the three-way merge that lands an entry next to a teammate's change.
// Every name is an invented placeholder.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { DEFAULT_PEOPLE, DEFAULT_QUESTIONS, listedIn, mergePeople, peopleQuestions, starterRoster, toLf } from "../../../../../plugins/desk/mcp/src/crew/people.js"
import { CIT_SHAPED } from "./_fixtures.js"

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
})
