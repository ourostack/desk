// The team's roster in a Crew workspace: `start --people` records where it is (a roster the team already keeps stays
// byte-identical; a missing one is created from Crew's starter), `status` reports it, and a join lands the newcomer's
// entry, written by their agent in the roster's own format, in the same pull request as their desk-list row, merged
// three ways with what teammates changed meanwhile. `--about` and `--preferences` go into the new desk before its first
// push. Every name is an invented placeholder.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CIT_SHAPED, ORIGIN, fakeGh, git, mainFiles, noWait, onMain, pushFromElsewhere, teamRepo } from "./_fixtures.js"
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

const read = (repo, rel) => readFileSync(path.join(repo.clone, ...rel.split("/")), "utf8")
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
  assert.match(refused.message, /people: "_meta\/people\.md" is not a Markdown file inside this repository/u)
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
  assert.match(first.message, /stopped at people \(a teammate changed the same lines of the team's roster _shared\/landscape\/roster\.md first\)\. desks\/newbie\/ is pushed; run join again to add the desk-list row\. Next: read the team's roster _shared\/landscape\/roster\.md again as it is now, write the entry again in it, and run join --apply again; it adds only what is missing\.$/u)
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
  assert.equal(read(repo, STARTER), withEntry(starterRoster()))
  assert.equal(onMain(repo.bare, STARTER), starterRoster())
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
    const shown = read(repo, CIT_ROSTER)
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
