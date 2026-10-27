// The team's roster in a Crew workspace: `start --people` records where it is (a roster the team already keeps stays
// byte-identical; a missing one is created from Crew's starter), `status` reports it, and a join lands the newcomer's
// entry, written by their agent in the roster's own format, in the same pull request as their desk-list row, merged
// three ways with what teammates changed meanwhile. `--about` and `--preferences` go into the new desk before its first
// push. Every name is an invented placeholder.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, unlinkSync, existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CIT_SHAPED, CIT_STANDIN_ROSTER, ORIGIN, fakeGh, git, mainFiles, noWait, onMain, pushFromElsewhere, teamRepo } from "./_fixtures.js"
import { crewStatus, joinWorkspace, startWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { DEFAULT_QUESTIONS, starterRoster } from "../../../../../plugins/desk/mcp/src/crew/people.js"

const NOW = () => 1767225600000
const LATER = () => 1767225600999
const TOOLING = { repo: "acme/team-tooling" }
const STARTER = "_shared/landscape/roster.md"
const CIT_ROSTER = "team/roster.md"

function memberClone(repo, name = "member", config = {}) {
  const clone = path.join(repo.base, name)
  spawnSync("git", ["clone", "-q", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${value}`]), repo.bare, clone])
  git(clone, ["config", "user.email", `${name}@example.com`])
  git(clone, ["config", "user.name", name])
  git(clone, ["remote", "set-url", "origin", `${ORIGIN}.git`])
  return { ...repo, clone }
}

async function started(files = CIT_SHAPED, extra = {}) {
  const repo = await teamRepo(files)
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: TOOLING, founder: { alias: "founder", identity: "founder_example" }, ...extra })
  assert.equal(result.state, "published", result.message)
  return repo
}

// The clone's file as Git would store it: on Windows, Git for Windows' core.autocrlf=true shows it with CRLF.
const readRaw = (repo, rel) => readFileSync(path.join(repo.clone, ...rel.split("/")), "utf8")
const read = (repo, rel) => readRaw(repo, rel).replace(/\r\n/gu, "\n")
const write = (repo, rel, text) => {
  mkdirSync(path.dirname(path.join(repo.clone, ...rel.split("/"))), { recursive: true })
  writeFileSync(path.join(repo.clone, ...rel.split("/")), text)
}
const ENTRY = "### Newbie Example (newbie)\n\n- Role: placeholder role, told us when joining, 2026-10-27\n- Pronouns: not shared\n- Source: told us when joining, 2026-10-27\n\n"
// The starter roster with `entry` added at the end of Teammates, as an agent writes it.
const withEntry = (text, entry = ENTRY) => text.replace("## Contacts\n", `${entry}## Contacts\n`)
const citRow = (name, alias) => `| ${name} | ${alias} | Placeholder title | not shared | told us when joining, 2026-10-27 |\n`

const join = (repo, extra = {}) => ({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, identity: "newbie_example", alias: "newbie", wait: noWait, now: LATER, ...extra })

function notes(repo) {
  const about = path.join(repo.base, "about.md")
  const preferences = path.join(repo.base, "preferences.md")
  writeFileSync(about, "## About me\r\n\r\nPlaceholder role. Go to me for placeholders.\r\n")
  writeFileSync(preferences, "## How I like my agent to work\n\nShort answers; just get it done.\n")
  return { about, preferences }
}

test("start --people with the roster a team already keeps: recorded, and the file stays byte-identical", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const plan = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, now: NOW, tooling: TOOLING, people: "./team/roster.md" })
  assert.equal(plan.state, "plan")
  assert.deepEqual(plan.people, { path: CIT_ROSTER, change: "keep" })
  assert.equal(plan.changes.some((change) => change.path.endsWith("roster.md")), false)
  assert.match(plan.message, /The team's roster is the existing team\/roster\.md, left as it is\./u)
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: TOOLING, people: "team/roster.md" })
  assert.equal(result.state, "published", result.message)
  assert.deepEqual(JSON.parse(onMain(repo.bare, "_meta/crew.json")), { schema_version: 1, tooling: TOOLING, people: CIT_ROSTER })
  assert.equal(onMain(repo.bare, CIT_ROSTER), CIT_SHAPED[CIT_ROSTER])
  assert.equal(mainFiles(repo.bare).includes(STARTER), false)
  assert.match(onMain(repo.bare, "AGENTS.md"), /\*\*The team's roster\*\* is `team\/roster\.md`: everyone the team works with[^\n]*`crew:roster`/u)
  assert.match(onMain(repo.bare, "AGENTS.md"), /asks them a few questions, adds their desk, then their roster entry and their desk-list row/u)
})

test("start --people with a file that does not exist creates it from Crew's starter; without --people, the default", async () => {
  const repo = await teamRepo({ "README.md": "# Team\n", "notes/a.md": "x\n" })
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: TOOLING, people: "people/roster.md" })
  assert.equal(result.state, "published", result.message)
  assert.equal(onMain(repo.bare, "people/roster.md"), starterRoster())
  assert.equal(JSON.parse(onMain(repo.bare, "_meta/crew.json")).people, "people/roster.md")
  const plain = await teamRepo({ "README.md": "# Team\n" })
  const plan = await startWorkspace({ repo: plain.clone, spawnGit: plain.spawnGit, gh: fakeGh(plain.bare).gh, now: NOW, tooling: TOOLING })
  assert.deepEqual(plan.people, { path: STARTER, change: "add" })
  assert.ok(plan.changes.some((change) => change.path === STARTER && change.change === "add"))
  const refused = await startWorkspace({ repo: plain.clone, spawnGit: plain.spawnGit, gh: fakeGh(plain.bare).gh, now: NOW, tooling: TOOLING, people: "_meta/people.md", apply: true })
  assert.equal(refused.state, "refused")
  assert.match(refused.message, /people: "_meta\/people\.md" is not a Markdown file in a folder of this repository/u)
})

test("status reports the roster: path, whether it exists, whether it lists the member, and the questions to ask", async () => {
  const repo = await started(CIT_SHAPED, { people: CIT_ROSTER })
  const anyone = await crewStatus({ repo: repo.clone })
  assert.deepEqual(anyone.people, { path: CIT_ROSTER, exists: true, listed: null, questions: [...DEFAULT_QUESTIONS], questions_from: "crew" })
  assert.equal((await crewStatus({ repo: repo.clone, identity: "stranger" })).people.listed, null, "no desk-list row: nothing to look for")
  assert.equal((await crewStatus({ repo: repo.clone, identity: "founder_example" })).people.listed, false)
  write(repo, CIT_ROSTER, `${CIT_SHAPED[CIT_ROSTER]}${citRow("Founder Person", "founder")}`)
  assert.equal((await crewStatus({ repo: repo.clone, identity: "FOUNDER_EXAMPLE" })).people.listed, true)
  // The starter: the team's own questions, and nothing missing.
  const starter = await started({ "README.md": "# Team\n" })
  const status = await crewStatus({ repo: starter.clone, identity: "founder_example" })
  assert.deepEqual({ ...status.people, questions: status.people.questions.length }, { path: STARTER, exists: true, listed: false, questions: DEFAULT_QUESTIONS.length, questions_from: "roster" })
  // A workspace made before the setting, with no roster file: the default path, and the starter to create it from.
  const older = await teamRepo({ "_meta/desks.md": "| alias | identity |\n|---|---|\n| pat | pat_example |\n", "desks/_template/AGENTS.md": "# {{alias}}\n" })
  const old = await crewStatus({ repo: older.clone, identity: "pat_example" })
  assert.equal(old.people.path, STARTER)
  assert.equal(old.people.exists, false)
  assert.equal(old.people.listed, false)
  assert.equal(old.people.starter, starterRoster())
})

test("a newcomer's join: the plan shows the roster change; the desk gets their words; the roster entry lands with the row", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  const plan = await joinWorkspace(join(repo, notes(repo)))
  assert.equal(plan.state, "plan", plan.message)
  assert.equal(plan.people.change, "edit")
  assert.match(plan.people.diff, /^\+### Newbie Example \(newbie\)$/mu)
  assert.deepEqual(plan.answers, ["desks/newbie/README.md", "desks/newbie/AGENTS.md"])
  assert.match(plan.message, /The change to the team's roster _shared\/landscape\/roster\.md lands in the same pull request as the row\. What they told us goes into desks\/newbie\/README\.md and desks\/newbie\/AGENTS\.md\./u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), `M ${STARTER}`)
  const fake = fakeGh(repo.bare)
  const result = await joinWorkspace(join(repo, { ...notes(repo), gh: fake.gh, apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(result.people.listed, true)
  assert.match(result.message, /The team's roster _shared\/landscape\/roster\.md lists them\./u)
  assert.equal(onMain(repo.bare, STARTER), withEntry(starterRoster()))
  assert.equal(onMain(repo.bare, "desks/newbie/README.md"), "# newbie\n\nnewbie's working desk: tracks, tasks and notes. Everything here is newbie's own view unless it says otherwise.\n\n## About me\n\nPlaceholder role. Go to me for placeholders.\n")
  assert.match(onMain(repo.bare, "desks/newbie/AGENTS.md"), /otherwise\.|team goes in the root `AGENTS\.md`\.\n\n## How I like my agent to work\n\nShort answers; just get it done\.\n$/u)
  // One pull request held the desk-list row and the roster entry; the desk was pushed before it.
  assert.deepEqual(git(repo.bare, ["log", "--format=%s", "-n", "2", "main"]).split("\n"), ["Crew: add newbie to the team (#12)", "Crew: add newbie's desk"])
  assert.deepEqual(git(repo.bare, ["show", "--name-only", "--format=", "main"]).split("\n").sort(), ["_meta/desks.md", STARTER])
  const created = fake.calls.find((args) => args[1] === "create")
  assert.match(created[created.indexOf("--body") + 1], /^Crew: add newbie to the team: the desk-list row and the team's roster\./u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal((await crewStatus({ repo: repo.clone, identity: "newbie_example" })).people.listed, true)
})

test("a team's own table roster (CIT's shape): the agent's row lands with the desk-list row", async () => {
  const repo = memberClone(await started(CIT_SHAPED, { people: CIT_ROSTER }))
  write(repo, CIT_ROSTER, `${CIT_SHAPED[CIT_ROSTER]}${citRow("Newbie Example", "newbie")}`)
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(repo.bare, CIT_ROSTER), `${CIT_SHAPED[CIT_ROSTER]}${citRow("Newbie Example", "newbie")}`)
  assert.equal(result.people.listed, true)
  assert.deepEqual(result.answers, [])
})

test("a join without a roster change still works, and says the roster does not list them yet", async () => {
  const repo = memberClone(await started(CIT_SHAPED, { people: CIT_ROSTER }))
  const plan = await joinWorkspace(join(repo))
  assert.equal(plan.people.change, "none")
  assert.match(plan.message, /The team's roster team\/roster\.md has no change in this clone, so it will not list newbie_example yet\./u)
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(result.people.listed, false)
  assert.match(result.message, /The team's roster team\/roster\.md does not list them yet\./u)
  assert.equal(onMain(repo.bare, CIT_ROSTER), CIT_SHAPED[CIT_ROSTER])
})

test("any other uncommitted change is refused, before the plan and before writing; the roster edit stays", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  write(repo, "notes/stray.md", "stray\n")
  writeFileSync(path.join(repo.clone, "README.md"), "# Changed\n")
  for (const apply of [false, true]) {
    const result = await joinWorkspace(join(repo, { apply }))
    assert.equal(result.state, "refused")
    assert.equal(result.message, "Nothing was written: this clone has uncommitted changes outside the team's roster _shared/landscape/roster.md (README.md, notes/stray.md); commit or stash them first, then run this again.")
  }
  assert.equal(mainFiles(repo.bare).includes("desks/newbie/AGENTS.md"), false)
  assert.match(read(repo, STARTER), /### Newbie Example/u)
  // A deleted roster is not a change a join makes.
  unlinkSync(path.join(repo.clone, "README.md"))
  git(repo.clone, ["checkout", "--", "README.md"])
  unlinkSync(path.join(repo.clone, "notes", "stray.md"))
  unlinkSync(path.join(repo.clone, ...STARTER.split("/")))
  const deleted = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(deleted.state, "refused")
  assert.match(deleted.message, /has the team's roster _shared\/landscape\/roster\.md deleted, and Crew never removes it/u)
})

test("a teammate changed the same roster lines first: stage people, the desk pushed, the clone on the new main; a rerun adds only what is missing", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  // The newcomer's agent rewrites a line a teammate changes on main meanwhile.
  write(repo, STARTER, withEntry(read(repo, STARTER)).replace("One section per teammate, newest last.", "One section per teammate (newbie's edit)."))
  const teammate = withEntry(starterRoster(), "### Other Person (other)\n\n").replace("One section per teammate, newest last.", "One section per teammate, oldest first.")
  await pushFromElsewhere(repo, { [STARTER]: teammate })
  const first = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(first.state, "failed")
  assert.equal(first.stage, "people")
  assert.match(first.message, /stopped at people \(a teammate changed the same entry of the team's roster _shared\/landscape\/roster\.md first\)\. desks\/newbie\/ is pushed; run join again to add the desk-list row\. Next: read the team's roster _shared\/landscape\/roster\.md again as it is now, write the entry again in it \(what was written before is kept at \S+crew-roster-edit\.json\), and run join --apply again; it adds only what is missing\.$/u)
  assert.ok(mainFiles(repo.bare).includes("desks/newbie/AGENTS.md"))
  assert.doesNotMatch(onMain(repo.bare, "_meta/desks.md"), /newbie/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal(read(repo, STARTER), teammate, "the clone shows the roster as it is now")
  // The agent writes the entry again on the roster as it is now.
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  const again = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(again.state, "joined", again.message)
  assert.equal(again.resumed, true)
  assert.equal(onMain(repo.bare, STARTER), withEntry(teammate))
  assert.equal(git(repo.bare, ["log", "--format=%s", "main"]).split("\n").filter((subject) => subject === "Crew: add newbie's desk").length, 1)
})

test("two people adding entries at the same place both land, the teammate's first", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  await pushFromElsewhere(repo, { [STARTER]: withEntry(starterRoster(), "### Other Person (other)\n\n") })
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(repo.bare, STARTER), withEntry(starterRoster(), `### Other Person (other)\n\n${ENTRY}`))
})

test("a workspace made before the setting, with no roster file: the join creates it, from the starter or with the entry", async () => {
  const files = { "README.md": "# Team\n", "_meta/desks.md": "| alias | identity |\n|---|---|\n| pat | pat_example |\n", "desks/_template/AGENTS.md": "# {{alias}}\n", "desks/pat/AGENTS.md": "# pat\n" }
  // No interview: the starter, with no entry for them.
  const quiet = memberClone(await teamRepo(files))
  const plan = await joinWorkspace(join(quiet))
  assert.equal(plan.people.change, "starter")
  assert.match(plan.message, /The team's roster _shared\/landscape\/roster\.md does not exist yet; it is created from Crew's starter, with no entry for newbie_example yet\./u)
  const plain = await joinWorkspace(join(quiet, { apply: true }))
  assert.equal(plain.state, "joined", plain.message)
  assert.equal(onMain(quiet.bare, STARTER), starterRoster())
  assert.equal(plain.people.listed, false)
  // With an interview: the agent writes the starter with the entry; a teammate created it meanwhile.
  const repo = memberClone(await teamRepo(files))
  write(repo, STARTER, withEntry(starterRoster()))
  const created = await joinWorkspace(join(repo))
  assert.equal(created.people.change, "create")
  assert.match(created.message, /The team's roster _shared\/landscape\/roster\.md is created as this clone has it/u)
  await pushFromElsewhere(repo, { [STARTER]: withEntry(starterRoster(), "### Pat Person (pat)\n\n") })
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(repo.bare, STARTER), withEntry(starterRoster(), `### Pat Person (pat)\n\n${ENTRY}`))
  // Nobody else created it: the agent's file lands as it is, and a staged file is taken too.
  const fresh = memberClone(await teamRepo(files))
  write(fresh, STARTER, withEntry(starterRoster()))
  git(fresh.clone, ["add", STARTER])
  const landed = await joinWorkspace(join(fresh, { apply: true }))
  assert.equal(landed.state, "joined", landed.message)
  assert.equal(onMain(fresh.bare, STARTER), withEntry(starterRoster()))
  assert.equal(git(fresh.clone, ["status", "--porcelain"]), "")
})

test("a roster another teammate removed meanwhile: stage people", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  const other = path.join(repo.base, "remover")
  spawnSync("git", ["clone", "-q", repo.bare, other])
  git(other, ["-c", "user.email=r@example.com", "-c", "user.name=R", "rm", "-q", STARTER])
  git(other, ["-c", "user.email=r@example.com", "-c", "user.name=R", "commit", "-q", "-m", "remove"])
  git(other, ["push", "-q", "origin", "main"])
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.stage, "people", result.message)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("git that cannot merge the roster stops at stage people with Git's words", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  const spawnGit = (cmd, args, options) => (args[0] === "merge-file" ? { status: 255, stdout: "", stderr: "error: could not merge\n" } : repo.spawnGit(cmd, args, options))
  const result = await joinWorkspace(join(repo, { apply: true, spawnGit }))
  assert.equal(result.stage, "people")
  assert.match(result.reason, /could not be merged: error: could not merge$/u)
  // With no entry of their own (Crew's starter for a workspace that had no roster), the message names no kept change.
  const older = memberClone(await teamRepo({ "_meta/desks.md": "| alias | identity |\n|---|---|\n| pat | pat_example |\n", "desks/_template/AGENTS.md": "# {{alias}}\n" }), "older")
  await pushFromElsewhere(older, { [STARTER]: "# Our people\n" })
  const starter = await joinWorkspace(join(older, { apply: true, spawnGit: (cmd, args, options) => (args[0] === "merge-file" ? { status: 255, stdout: "", stderr: "error: could not merge\n" } : older.spawnGit(cmd, args, options)) }))
  assert.equal(starter.stage, "people", starter.message)
  assert.match(starter.message, /write the entry again in it, and run join --apply again/u)
})

test("a pull request left open: the roster edit is back in the clone, and the rerun reuses the pull request", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  let blocked = "Pull request is blocked by a required review"
  const fake = fakeGh(repo.bare, { blocked: () => blocked })
  const first = await joinWorkspace(join(repo, { apply: true, gh: fake.gh }))
  assert.equal(first.state, "pr_open", first.message)
  assert.equal(read(repo, STARTER), withEntry(starterRoster()))
  assert.equal(git(repo.clone, ["status", "--porcelain"]), `M ${STARTER}`)
  blocked = null
  const second = await joinWorkspace(join(repo, { apply: true, gh: fake.gh }))
  assert.equal(second.state, "joined", second.message)
  assert.equal(second.reused, true)
  assert.equal(fake.calls.filter((args) => args[1] === "create").length, 1)
  assert.equal(onMain(repo.bare, STARTER), withEntry(starterRoster()))
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("joined from another machine meanwhile: a member, and the roster edit stays in the clone", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  const fake = fakeGh(repo.bare)
  let done = false
  const gh = async (args, more) => {
    const answer = await fake.gh(args, more)
    if (args[0] === "pr" && args[1] === "create" && !done) {
      done = true
      await pushFromElsewhere(repo, { "_meta/desks.md": `${onMain(repo.bare, "_meta/desks.md")}| newbie2 | newbie_example | desks/newbie2 | acme/team | crew | desks/newbie2 |\n` })
    }
    return answer
  }
  const result = await joinWorkspace(join(repo, { apply: true, gh }))
  assert.equal(result.state, "member", result.message)
  assert.match(result.message, /The change to the team's roster _shared\/landscape\/roster\.md has not landed: land it with crew\.js roster --apply\./u)
  assert.equal(read(repo, STARTER), withEntry(starterRoster()))
  assert.equal(onMain(repo.bare, STARTER), starterRoster())
  // Run again, the join answers at once that they are a member, and still names the change to land.
  const again = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(again.state, "member")
  assert.match(again.message, /has not landed: land it with crew\.js roster --apply\./u)
  // Without a change, or with one the clone cannot take, it says nothing about the roster.
  write(repo, "README.md", "# Changed\n")
  assert.doesNotMatch((await joinWorkspace(join(repo))).message, /has not landed/u)
})

// ── CIT's roster: one table row per teammate ─────────────────────────────────────────────────────────────────────

const CIT_FILES = { ...CIT_SHAPED, [CIT_ROSTER]: CIT_STANDIN_ROSTER }
const standinRow = (name) => CIT_STANDIN_ROSTER.split("\n").find((line) => line.startsWith(`| ${name} |`))
const fixRow = (text, name, from, to) => text.replace(standinRow(name), standinRow(name).replace(from, to))
const joiner = (alias) => ({ identity: `${alias}_example`, alias })

test("CIT's roster: two joiners each fixing their own neighbouring row both land, with no conflict", async () => {
  const team = await started(CIT_FILES, { people: CIT_ROSTER })
  const theo = memberClone(team, "theo")
  const mina = memberClone(team, "mina")
  write(theo, CIT_ROSTER, fixRow(read(theo, CIT_ROSTER), "Theo Lindqvist", "| not recorded |", "| he/him |"))
  write(mina, CIT_ROSTER, fixRow(read(mina, CIT_ROSTER), "Mina Castellanos", "pronouns confirmed by Robin", "told us when joining"))
  assert.equal((await joinWorkspace(join(theo, { apply: true, ...joiner("tlindqvist") }))).state, "joined")
  const second = await joinWorkspace(join(mina, { apply: true, ...joiner("minac") }))
  assert.equal(second.state, "joined", second.message)
  const both = fixRow(fixRow(CIT_STANDIN_ROSTER, "Theo Lindqvist", "| not recorded |", "| he/him |"), "Mina Castellanos", "pronouns confirmed by Robin", "told us when joining")
  assert.equal(onMain(team.bare, CIT_ROSTER), both)
})

test("CIT's roster: a new row added under a row a teammate just edited lands after it", async () => {
  const team = await started(CIT_FILES, { people: CIT_ROSTER })
  const repo = memberClone(team)
  const theo = standinRow("Theo Lindqvist")
  const newRow = citRow("Newbie Example", "newbie")
  write(repo, CIT_ROSTER, read(repo, CIT_ROSTER).replace(`${theo}\n`, `${theo}\n${newRow}`))
  const edited = fixRow(CIT_STANDIN_ROSTER, "Theo Lindqvist", "| not recorded |", "| he/him |")
  await pushFromElsewhere(repo, { [CIT_ROSTER]: edited })
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(team.bare, CIT_ROSTER), edited.replace(`${theo.replace("| not recorded |", "| he/him |")}\n`, `${theo.replace("| not recorded |", "| he/him |")}\n${newRow}`))
})

test("CIT's roster: the same row changed both ways, and GitHub failing after the fetch: the entry is kept, never dropped, and lands once written again", async () => {
  const repo = memberClone(await started(CIT_FILES, { people: CIT_ROSTER }))
  write(repo, CIT_ROSTER, fixRow(read(repo, CIT_ROSTER), "Theo Lindqvist", "| not recorded |", "| he/him (told us when joining) |"))
  const teammate = fixRow(CIT_STANDIN_ROSTER, "Theo Lindqvist", "| not recorded |", "| they/them (per teammate) |")
  await pushFromElsewhere(repo, { [CIT_ROSTER]: teammate })
  // GitHub does not answer the merge-method question: the run stops at pull_request, after the fetch.
  const first = await joinWorkspace(join(repo, { apply: true, ...joiner("tlindqvist"), gh: fakeGh(repo.bare, { methods: null }).gh }))
  assert.equal(first.state, "failed")
  assert.equal(first.stage, "pull_request")
  assert.match(first.message, /desks\/tlindqvist\/ is pushed; run join again to add the desk-list row\. The change to the team's roster could not be put back in team\/roster\.md as it is now; it is kept at \S+crew-roster-edit\.json, and running join --apply again lands it, or says what to do if it still does not merge\.$/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  // The rerun takes the kept entry, and stops at people: the same row really changed both ways.
  const plan = await joinWorkspace(join(repo, joiner("tlindqvist")))
  assert.equal(plan.people.from, "kept")
  const second = await joinWorkspace(join(repo, { apply: true, ...joiner("tlindqvist") }))
  assert.equal(second.stage, "people")
  assert.match(second.message, /what was written before is kept at \S+crew-roster-edit\.json/u)
  // Written again on the row as it is now, it lands, and nothing stays kept.
  write(repo, CIT_ROSTER, read(repo, CIT_ROSTER).replace("| they/them (per teammate) |", "| he/him (told us when joining) |"))
  const third = await joinWorkspace(join(repo, { apply: true, ...joiner("tlindqvist") }))
  assert.equal(third.state, "joined", third.message)
  assert.match(onMain(repo.bare, CIT_ROSTER), /\| Theo Lindqvist \| tlindqvist \| Principal TPM \| he\/him \(told us when joining\) \|/u)
  assert.equal(existsSync(path.join(repo.clone, ".git", "crew-roster-edit.json")), false)
})

test("a committed roster entry is refused with the command that keeps it uncommitted", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  git(repo.clone, ["commit", "-qam", "entry"])
  const refused = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(refused.state, "refused")
  assert.match(refused.message, /has the change to the team's roster _shared\/landscape\/roster\.md committed, and Crew lands it from the uncommitted change; undo the commit and keep the change with git reset --soft origin\/main/u)
  // Any other commit gets the general refusal.
  write(repo, "notes/x.md", "x\n")
  git(repo.clone, ["add", "notes/x.md"])
  git(repo.clone, ["commit", "-qm", "x"])
  assert.match((await joinWorkspace(join(repo, { apply: true }))).message, /has commits that are not on origin\/main; push or drop them first/u)
})

test("--about saved as UTF-16 is refused; a byte-order mark is left out of the desk", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  const utf16 = path.join(repo.base, "about-utf16.md")
  writeFileSync(utf16, Buffer.from("\uFEFF## About me\r\n\r\nPlaceholder.\r\n", "utf16le"))
  const refused = await joinWorkspace(join(repo, { apply: true, about: utf16 }))
  assert.equal(refused.state, "refused")
  assert.match(refused.message, /--about \S+about-utf16\.md is not UTF-8 text; write it again as UTF-8/u)
  const bom = path.join(repo.base, "about-bom.md")
  writeFileSync(bom, "\uFEFF## About me\n\nPlaceholder.\n")
  const result = await joinWorkspace(join(repo, { apply: true, about: bom }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(repo.bare, "desks/newbie/README.md").includes("\uFEFF"), false)
})

// ── Symbolic links: Crew reads and writes only inside the clone ─────────────────────────────────────────────────

const NO_LINKS = process.platform === "win32" && "Git for Windows checks links out as plain files"

// A teammate's commit that makes `link` a symbolic link to `target`.
function pushLink(repo, link, target) {
  const other = memberClone(repo, `linker-${Math.random().toString(36).slice(2, 8)}`)
  git(other.clone, ["rm", "-rq", "--ignore-unmatch", link])
  mkdirSync(path.dirname(path.join(other.clone, ...link.split("/"))), { recursive: true })
  symlinkSync(target, path.join(other.clone, ...link.split("/")))
  git(other.clone, ["add", link])
  git(other.clone, ["commit", "-qm", "link"])
  git(other.clone, ["push", "-q", repo.bare, "HEAD:main"])
  return other
}

test("a roster folder linked outside the clone: status does not read it, and the join is refused before anything is written", { skip: NO_LINKS }, async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  const outside = mkdtempSync(path.join(os.tmpdir(), "crew-outside-"))
  writeFileSync(path.join(outside, "roster.md"), "# Elsewhere\n\n## What we ask new teammates\n\n1. Not ours?\n")
  pushLink(repo, "_shared/landscape", outside)
  git(repo.clone, ["pull", "-q", repo.bare, "main"])
  const status = await crewStatus({ repo: repo.clone, identity: "newbie_example" })
  assert.equal(status.people.problem, "Crew writes only inside this clone, and a symbolic link leads outside it at _shared/landscape/roster.md; ask the teammate who added the link to replace it with a real folder or file")
  assert.equal(status.people.exists, false)
  assert.deepEqual(status.people.questions, [...DEFAULT_QUESTIONS])
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "refused")
  assert.equal(result.message, `Nothing was written: ${status.people.problem}.`)
  assert.deepEqual(readdirSync(outside), ["roster.md"])
  assert.equal(mainFiles(repo.bare).includes("desks/newbie/AGENTS.md"), false)
})

test("a desk folder, a roster file, a link into .git or a link to nothing: each refused", { skip: NO_LINKS }, async () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "crew-outside-"))
  for (const [link, target, shown] of [
    ["desks/newbie", outside, "desks/newbie"],
    ["_shared/landscape/roster.md", "../../README.md", STARTER],
    ["_shared/landscape", "../.git", STARTER],
    ["_shared/landscape", "../no-such-folder", STARTER],
  ]) {
    const repo = memberClone(await started({ "README.md": "# Team\n" }))
    pushLink(repo, link, target)
    git(repo.clone, ["pull", "-q", repo.bare, "main"])
    const result = await joinWorkspace(join(repo, { apply: true }))
    assert.equal(result.state, "refused", link)
    assert.match(result.message, new RegExp(`a symbolic link leads outside it at ${shown.replace(/[/.]/gu, "\\$&")};`, "u"), link)
  }
  assert.deepEqual(readdirSync(outside), [])
})

test("a link that arrives with the fetch stops the join before anything is written outside, and the entry stays kept", { skip: NO_LINKS }, async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  const outside = mkdtempSync(path.join(os.tmpdir(), "crew-outside-"))
  pushLink(repo, "_shared/landscape", outside)
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "outside")
  assert.match(result.message, /kept at \S+crew-roster-edit\.json/u)
  assert.deepEqual(readdirSync(outside), [])
  // A desk folder linked the same way is not a desk this join may use.
  const other = memberClone(await started({ "README.md": "# Team\n" }), "other")
  pushLink(other, "desks/newbie", outside)
  const desk = await joinWorkspace(join(other, { apply: true }))
  assert.equal(desk.state, "refused")
  assert.match(desk.message, /desks\/newbie\/ already exists and does not match the template/u)
  assert.deepEqual(readdirSync(outside), [])
})

test("a link that arrives with the fetch stops a start before anything is written outside", { skip: NO_LINKS }, async () => {
  const repo = await teamRepo({ "README.md": "# Team\n", "_shared/notes.md": "x\n" })
  const outside = mkdtempSync(path.join(os.tmpdir(), "crew-outside-"))
  pushLink(repo, "_shared/landscape", outside)
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: TOOLING })
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "outside")
  assert.match(result.message, /Crew writes only inside this clone, and a symbolic link leads outside it at _shared\/landscape\/README\.md, _shared\/landscape\/roster\.md;/u)
  assert.deepEqual(readdirSync(outside), [])
})

test("start refuses a roster path that leads outside, and a roster file that is not committed", async (t) => {
  const repo = await teamRepo({ "README.md": "# Team\n", ".gitignore": "team/private.md\n" })
  write(repo, "team/roster.md", "# Ours, not committed\n")
  const untracked = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, now: NOW, tooling: TOOLING, people: "team/roster.md" })
  assert.equal(untracked.state, "refused")
  assert.match(untracked.message, /team\/roster\.md is in this folder but not committed, so teammates' clones would not have it; commit it first, or name another file with --people/u)
  write(repo, "team/private.md", "# Ignored\n")
  assert.equal((await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, now: NOW, tooling: TOOLING, people: "team/private.md" })).state, "refused")
  if (NO_LINKS) return t.skip(NO_LINKS)
  const outside = mkdtempSync(path.join(os.tmpdir(), "crew-outside-"))
  symlinkSync(outside, path.join(repo.clone, "people"))
  const linked = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, now: NOW, tooling: TOOLING, people: "people/roster.md" })
  assert.equal(linked.state, "refused")
  assert.match(linked.message, /a symbolic link leads outside it at people\/roster\.md;/u)
})

test("--about and --preferences: unreadable or empty is refused; a template without the file gets one; a resumed desk is not changed", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  const empty = path.join(repo.base, "empty.md")
  writeFileSync(empty, "  \n")
  for (const [extra, message] of [[{ about: path.join(repo.base, "missing.md") }, /--about \S+missing\.md cannot be read or is empty/u], [{ preferences: empty }, /--preferences \S+empty\.md cannot be read or is empty/u]]) {
    const result = await joinWorkspace(join(repo, { apply: true, ...extra }))
    assert.equal(result.state, "refused")
    assert.match(result.message, message)
  }
  // A template with no README.md, and an AGENTS.md with no final newline.
  const bare = memberClone(await teamRepo({ "_meta/desks.md": "| alias | identity |\n|---|---|\n| pat | pat_example |\n", "desks/_template/AGENTS.md": "# {{alias}}", [STARTER]: starterRoster() }))
  const result = await joinWorkspace(join(bare, { apply: true, ...notes(bare) }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(bare.bare, "desks/newbie/README.md"), "## About me\n\nPlaceholder role. Go to me for placeholders.\n")
  assert.equal(onMain(bare.bare, "desks/newbie/AGENTS.md"), "# newbie\n\n## How I like my agent to work\n\nShort answers; just get it done.\n")
  // The desk was pushed by a run that stopped before its row: the words are not added again.
  const resumed = memberClone(await started({ "README.md": "# Team\n" }), "resumed")
  const stopped = await joinWorkspace(join(resumed, { apply: true, gh: fakeGh(resumed.bare, { create: { code: 1 } }).gh, ...notes(resumed) }))
  assert.equal(stopped.state, "failed")
  const plan = await joinWorkspace(join(resumed, notes(resumed)))
  assert.deepEqual(plan.answers, [])
  assert.match(plan.message, /desks\/newbie\/ is already pushed, so --about and --preferences are not added to it again\./u)
  assert.equal(existsSync(path.join(resumed.base, "about.md")), true)
})

test("core.autocrlf=true and input: the entry lands with LF on GitHub, and the clone is clean", async () => {
  for (const autocrlf of ["true", "input"]) {
    const origin = await started({ "README.md": "# Team\n" }, { people: CIT_ROSTER, founder: undefined })
    await pushFromElsewhere(origin, { [CIT_ROSTER]: CIT_SHAPED[CIT_ROSTER] })
    const repo = memberClone(origin, `crlf-${autocrlf}`, { "core.autocrlf": autocrlf })
    const shown = readRaw(repo, CIT_ROSTER)
    if (autocrlf === "true") assert.match(shown, /\r\n/u)
    // The agent appends an LF row to a file the clone shows with CRLF.
    writeFileSync(path.join(repo.clone, ...CIT_ROSTER.split("/")), `${shown}${citRow("Newbie Example", "newbie")}`)
    const result = await joinWorkspace(join(repo, { apply: true, ...notes(repo) }))
    assert.equal(result.state, "joined", result.message)
    assert.equal(onMain(repo.bare, CIT_ROSTER), `${CIT_SHAPED[CIT_ROSTER]}${citRow("Newbie Example", "newbie")}`)
    assert.doesNotMatch(onMain(repo.bare, "desks/newbie/README.md"), /\r/u)
    assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  }
})

test("a clone off the default branch is refused before writing, and the roster edit is back in it", async () => {
  const repo = memberClone(await started({ "README.md": "# Team\n" }))
  write(repo, STARTER, withEntry(read(repo, STARTER)))
  git(repo.clone, ["switch", "-q", "-c", "elsewhere"])
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "refused")
  assert.match(result.message, /this clone is on elsewhere, not the default branch main/u)
  assert.equal(read(repo, STARTER), withEntry(starterRoster()))
  assert.equal(mainFiles(repo.bare).includes("desks/newbie/AGENTS.md"), false)
})
