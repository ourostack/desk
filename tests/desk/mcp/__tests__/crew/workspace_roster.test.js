// crew.js roster: a member's edit to the team's roster (a contact who came up in the work, or their own entry offered
// later) lands on its own through a pull request merged at once, merged three ways with what teammates changed
// meanwhile. Only a member on the desk list changes it. Every name is an invented placeholder.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CIT_SHAPED, ORIGIN, PR, fakeGh, git, noWait, onMain, pushFromElsewhere, teamRepo } from "./_fixtures.js"
import { startWorkspace, updateRoster } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { starterRoster } from "../../../../../plugins/desk/mcp/src/crew/people.js"

const NOW = () => 1767225600000
const STARTER = "_shared/landscape/roster.md"
const CONTACT = "### Partner Person\n\n- Go to them for: billing questions\n- Source: founder's call with them, 2026-10-27\n\n"
const withContact = (text) => text.replace(/\n$/u, `\n\n${CONTACT.trimEnd()}\n`)

function memberClone(repo, name = "member", config = {}) {
  const clone = path.join(repo.base, name)
  spawnSync("git", ["clone", "-q", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${value}`]), repo.bare, clone])
  git(clone, ["config", "user.email", `${name}@example.com`])
  git(clone, ["config", "user.name", name])
  git(clone, ["remote", "set-url", "origin", `${ORIGIN}.git`])
  return { ...repo, clone }
}

async function started(config) {
  const repo = await teamRepo({ "README.md": "# Team\n" })
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: { repo: "acme/team-tooling" }, founder: { alias: "founder", identity: "founder_example" } })
  assert.equal(result.state, "published", result.message)
  return memberClone(repo, "member", config)
}

const file = (repo) => path.join(repo.clone, ...STARTER.split("/"))
// The clone's file as Git would store it: on Windows, Git for Windows' core.autocrlf=true shows it with CRLF.
const readRaw = (repo) => readFileSync(file(repo), "utf8")
const read = (repo) => readRaw(repo).replace(/\r\n/gu, "\n")
const edit = (repo) => writeFileSync(file(repo), withContact(read(repo)))
// Where a run keeps a roster change until it lands.
const readdirOf = (dir) => readdirSync(dir)
const keptAt = (repo) => path.join(repo.clone, ".git", "crew-roster-edit.json")
const KEPT = /kept at \S+crew-roster-edit\.json/u
const roster = (repo, extra = {}) => ({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, identity: "founder_example", wait: noWait, now: NOW, ...extra })

test("a member adds a contact: the plan shows the change, and the change merges at once", async () => {
  const repo = await started()
  edit(repo)
  const plan = await updateRoster(roster(repo))
  assert.equal(plan.state, "plan")
  assert.equal(plan.alias, "founder")
  assert.equal(plan.people.change, "edit")
  assert.match(plan.people.diff, /^\+### Partner Person$/mu)
  const fake = fakeGh(repo.bare)
  const result = await updateRoster(roster(repo, { gh: fake.gh, apply: true }))
  assert.equal(result.state, "updated", result.message)
  assert.equal(result.message, `Updated: the change to the team's roster ${STARTER} merged in ${PR}.`)
  assert.equal(onMain(repo.bare, STARTER), withContact(starterRoster()))
  const created = fake.calls.find((args) => args[1] === "create")
  assert.equal(created[created.indexOf("--title") + 1], "Crew: founder updates the team's roster")
  assert.match(created[created.indexOf("--head") + 1], /^crew\/roster-founder-/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("nothing to land, a non-member, no identity and a repository that is not a Crew workspace", async () => {
  const repo = await started()
  const nothing = await updateRoster(roster(repo, { apply: true }))
  assert.equal(nothing.state, "unchanged")
  assert.match(nothing.message, /^Nothing to land: the team's roster _shared\/landscape\/roster\.md has no change in this clone, and no earlier run kept one\./u)
  edit(repo)
  const stranger = await updateRoster(roster(repo, { identity: "stranger", apply: true }))
  assert.equal(stranger.state, "refused")
  assert.match(stranger.message, /stranger is not on the desk list, and the team's roster is changed by a teammate who is; join first with crew:join-crew/u)
  assert.match((await updateRoster(roster(repo, { identity: undefined }))).message, /an identity is required/u)
  writeFileSync(path.join(repo.clone, "README.md"), "# Changed\n")
  assert.match((await updateRoster(roster(repo))).message, /uncommitted changes outside the team's roster _shared\/landscape\/roster\.md \(README\.md\)/u)
  const plain = await teamRepo(CIT_SHAPED)
  const notCrew = await updateRoster({ repo: plain.clone, identity: "x" })
  assert.equal(notCrew.state, "not_crew")
  assert.equal(notCrew.action, "roster")
})

test("a teammate changed the same lines first: stage people, the clone clean on the new main, the change kept until a new one replaces it", async () => {
  const repo = await started()
  writeFileSync(file(repo), read(repo).replace("One section per teammate, newest last.", "One section per teammate, by team."))
  await pushFromElsewhere(repo, { [STARTER]: starterRoster().replace("One section per teammate, newest last.", "One section per teammate, by name.") })
  const result = await updateRoster(roster(repo, { apply: true }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "people")
  assert.match(result.message, /Next: read the team's roster _shared\/landscape\/roster\.md again as it is now, write the entry again in it \(what was written before is kept at \S+crew-roster-edit\.json\), and run roster --apply again; it adds only what is missing\.$/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.match(read(repo), /by name\./u)
  assert.match(JSON.parse(readFileSync(keptAt(repo), "utf8")).ours, /by team\./u)
  // With nothing new in the clone, the kept change is the change: never "nothing to land".
  const again = await updateRoster(roster(repo))
  assert.equal(again.state, "plan")
  assert.equal(again.people.from, "kept")
  assert.match(again.people.kept, /crew-roster-edit\.json$/u)
  assert.equal(again.people.diff, undefined)
  assert.match(again.message, /The change is the one an earlier run kept at \S+crew-roster-edit\.json\./u)
  assert.equal((await updateRoster(roster(repo, { apply: true }))).stage, "people")
  // The entry written again on the roster as it is now replaces the kept change, and lands; nothing stays kept.
  writeFileSync(file(repo), read(repo).replace("by name.", "by name, then team."))
  const replaced = await updateRoster(roster(repo))
  assert.equal(replaced.people.from, "clone")
  assert.match(replaced.message, /It replaces the change an earlier run kept at \S+crew-roster-edit\.json\./u)
  const landed = await updateRoster(roster(repo, { apply: true }))
  assert.equal(landed.state, "updated", landed.message)
  assert.match(onMain(repo.bare, STARTER), /by name, then team\./u)
  assert.equal(existsSync(keptAt(repo)), false)
})

test("left open: the edit is back in the clone, and the rerun reuses the pull request", async () => {
  const repo = await started()
  edit(repo)
  let blocked = "Pull request is blocked by a required review"
  const fake = fakeGh(repo.bare, { blocked: () => blocked })
  const first = await updateRoster(roster(repo, { gh: fake.gh, apply: true }))
  assert.equal(first.state, "pr_open", first.message)
  assert.match(first.message, /^Not in effect yet: the pull request/u)
  assert.equal(read(repo), withContact(starterRoster()))
  blocked = null
  const second = await updateRoster(roster(repo, { gh: fake.gh, apply: true }))
  assert.equal(second.state, "updated", second.message)
  assert.equal(second.reused, true)
  assert.equal(fake.calls.filter((args) => args[1] === "create").length, 1)
})

test("the default branch already has the change: nothing to land, and the clone is clean", async () => {
  const repo = await started()
  edit(repo)
  await pushFromElsewhere(repo, { [STARTER]: withContact(starterRoster()) })
  const result = await updateRoster(roster(repo, { apply: true }))
  assert.equal(result.state, "unchanged", result.message)
  assert.equal(result.message, `Nothing to land: the team's main branch already has this change to ${STARTER}.`)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("merged, but the fetch after it failed: updated, unconfirmed", async () => {
  const repo = await started()
  edit(repo)
  let failNext = false
  const spawnGit = (cmd, args, options) => {
    if (failNext && args.includes("fetch")) {
      failNext = false
      return { status: 128, stdout: "", stderr: "fatal: unable to access: Could not resolve host" }
    }
    return repo.spawnGit(cmd, args, options)
  }
  const fake = fakeGh(repo.bare)
  const gh = async (args, options) => {
    const answer = await fake.gh(args, options)
    if (args[0] === "pr" && args[1] === "merge" && answer.code === 0) failNext = true
    return answer
  }
  const result = await updateRoster(roster(repo, { spawnGit, gh, apply: true }))
  assert.equal(result.state, "updated")
  assert.equal(result.confirmed, false)
  assert.match(result.message, /Teammates see the change once their copies are up to date\.$/u)
})

test("a clone it cannot write from gets the edit back; an edit that no longer merges onto the clone is left out", async () => {
  const repo = await started()
  edit(repo)
  git(repo.clone, ["switch", "-q", "-c", "elsewhere"])
  const off = await updateRoster(roster(repo, { apply: true }))
  assert.equal(off.state, "refused")
  assert.match(off.message, /not the default branch main/u)
  assert.equal(read(repo), withContact(starterRoster()))
  git(repo.clone, ["switch", "-q", "main"])
  git(repo.clone, ["branch", "-q", "-D", "elsewhere"])
  // No origin at all.
  const local = await started()
  edit(local)
  git(local.clone, ["remote", "remove", "origin"])
  const none = await updateRoster(roster(local, { apply: true }))
  assert.equal(none.state, "refused")
  assert.match(none.message, /no origin with a default branch to land the change on/u)
  assert.equal(read(local), withContact(starterRoster()))
  // The clone is brought up to a main whose roster conflicts with the edit, then the write stops (GitHub does not
  // answer): the edit cannot go back in the clone, so it stays kept, and the message says where and what a rerun does.
  writeFileSync(file(repo), read(repo).replace("One section per teammate, newest last.", "One section per teammate, by team."))
  await pushFromElsewhere(repo, { [STARTER]: starterRoster().replace("One section per teammate, newest last.", "One section per teammate, by name.") })
  const stopped = await updateRoster(roster(repo, { gh: fakeGh(repo.bare, { methods: null }).gh, apply: true }))
  assert.equal(stopped.state, "failed")
  assert.equal(stopped.stage, "pull_request")
  assert.match(stopped.message, /The change to the team's roster could not be put back in _shared\/landscape\/roster\.md as it is now; it is kept at \S+crew-roster-edit\.json, and running roster --apply again lands it, or says what to do if it still does not merge\.$/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.match(JSON.parse(readFileSync(keptAt(repo), "utf8")).ours, /by team\./u)
  const rerun = await updateRoster(roster(repo, { apply: true }))
  assert.equal(rerun.stage, "people")
  assert.match(rerun.message, KEPT)
})

test("a failure after the fetch, with the same change already on main: nothing to put back, and nothing stays kept", async () => {
  const repo = await started()
  edit(repo)
  await pushFromElsewhere(repo, { [STARTER]: withContact(starterRoster()) })
  const fake = fakeGh(repo.bare)
  const gh = async (args, options) => (args[0] === "pr" && args[1] === "list" ? { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" } : fake.gh(args, options))
  const result = await updateRoster(roster(repo, { gh, apply: true }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "pull_request")
  assert.doesNotMatch(result.message, KEPT)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal(existsSync(keptAt(repo)), false)
})

test("a run stopped partway (a crash, a closed terminal) keeps the change, and the next run lands it", async () => {
  const repo = await started()
  edit(repo)
  const spawnGit = (cmd, args, options) => {
    if (args.includes("fetch")) throw new Error("the process was stopped")
    return repo.spawnGit(cmd, args, options)
  }
  await assert.rejects(updateRoster(roster(repo, { spawnGit, apply: true })), /the process was stopped/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  const plan = await updateRoster(roster(repo))
  assert.equal(plan.state, "plan")
  assert.equal(plan.people.from, "kept")
  const result = await updateRoster(roster(repo, { apply: true }))
  assert.equal(result.state, "updated", result.message)
  assert.equal(onMain(repo.bare, STARTER), withContact(starterRoster()))
  assert.equal(existsSync(keptAt(repo)), false)
})

test("a kept change Crew cannot read, or one for another roster file, is refused with what to do", async () => {
  const repo = await started()
  writeFileSync(keptAt(repo), "{}")
  const unreadable = await updateRoster(roster(repo))
  assert.equal(unreadable.state, "refused")
  assert.match(unreadable.message, /keeps an earlier change to the team's roster at \S+crew-roster-edit\.json that Crew cannot read; copy what is still needed from it into _shared\/landscape\/roster\.md, move it out of the way/u)
  writeFileSync(keptAt(repo), JSON.stringify({ path: "team/roster.md", base: null, ours: "# Roster\n", eol: "\n" }))
  const other = await updateRoster(roster(repo))
  assert.equal(other.state, "refused")
  assert.match(other.message, /keeps an earlier change to team\/roster\.md at \S+crew-roster-edit\.json, but the team's roster is now _shared\/landscape\/roster\.md/u)
})

test("a committed roster change is refused with the command that keeps it uncommitted; the rerun lands it", async () => {
  const repo = await started()
  edit(repo)
  git(repo.clone, ["commit", "-qam", "roster"])
  const refused = await updateRoster(roster(repo, { apply: true }))
  assert.equal(refused.state, "refused")
  assert.match(refused.message, /has the change to the team's roster _shared\/landscape\/roster\.md committed, and Crew lands it from the uncommitted change; undo the commit and keep the change with git reset --soft origin\/main, then run this again/u)
  git(repo.clone, ["reset", "-q", "--soft", "origin/main"])
  const result = await updateRoster(roster(repo, { apply: true }))
  assert.equal(result.state, "updated", result.message)
  assert.equal(onMain(repo.bare, STARTER), withContact(starterRoster()))
})

test("a roster saved as UTF-16 is refused; a byte-order mark an editor added is left out", async () => {
  const repo = await started()
  writeFileSync(file(repo), Buffer.from(`\uFEFF${withContact(read(repo))}`, "utf16le"))
  const utf16 = await updateRoster(roster(repo))
  assert.equal(utf16.state, "refused")
  assert.match(utf16.message, /has the team's roster _shared\/landscape\/roster\.md saved as something other than UTF-8 text; save it again as UTF-8/u)
  writeFileSync(file(repo), `\uFEFF${withContact(starterRoster())}`)
  const result = await updateRoster(roster(repo, { apply: true }))
  assert.equal(result.state, "updated", result.message)
  assert.equal(onMain(repo.bare, STARTER), withContact(starterRoster()))
})

// A teammate's commit that makes `link` (a path in the repository) a symbolic link to `target`.
function pushLink(repo, link, target) {
  const other = memberClone(repo, `linker-${Math.random().toString(36).slice(2, 8)}`)
  git(other.clone, ["rm", "-rq", "--ignore-unmatch", link])
  mkdirSync(path.dirname(path.join(other.clone, link)), { recursive: true })
  symlinkSync(target, path.join(other.clone, link))
  git(other.clone, ["add", link])
  git(other.clone, ["commit", "-qm", "link"])
  git(other.clone, ["push", "-q", repo.bare, "HEAD:main"])
}

test("a roster behind a symbolic link that leads outside the clone is never read or written", { skip: process.platform === "win32" && "Git for Windows checks links out as plain files" }, async () => {
  const repo = await started()
  const outside = mkdtempSync(path.join(os.tmpdir(), "crew-outside-"))
  pushLink(repo, "_shared/landscape", outside)
  git(repo.clone, ["pull", "-q", repo.bare, "main"])
  const refused = await updateRoster(roster(repo, { apply: true }))
  assert.equal(refused.state, "refused")
  assert.equal(refused.message, "Nothing was written: Crew writes only inside this clone, and a symbolic link leads outside it at _shared/landscape/roster.md; ask the teammate who added the link to replace it with a real folder or file.")
  assert.equal(existsSync(path.join(outside, "roster.md")), false)
})

test("a link that arrives with the fetch stops the write before anything is written outside; the change stays kept", { skip: process.platform === "win32" && "Git for Windows checks links out as plain files" }, async () => {
  const repo = await started()
  edit(repo)
  const outside = mkdtempSync(path.join(os.tmpdir(), "crew-outside-"))
  pushLink(repo, "_shared/landscape", outside)
  const result = await updateRoster(roster(repo, { apply: true }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "outside")
  assert.match(result.message, /a symbolic link leads outside it at _shared\/landscape\/roster\.md;/u)
  assert.match(result.message, KEPT)
  assert.deepEqual(readdirOf(outside), [])
  assert.match(JSON.parse(readFileSync(keptAt(repo), "utf8")).ours, /Partner Person/u)
})

test("core.autocrlf=true: an LF contact added to a CRLF file lands with LF on GitHub, and the clone is clean", async () => {
  const repo = await started({ "core.autocrlf": "true" })
  assert.match(readRaw(repo), /\r\n/u)
  writeFileSync(file(repo), `${readRaw(repo)}\n${CONTACT.trimEnd()}\n`)
  const result = await updateRoster(roster(repo, { apply: true }))
  assert.equal(result.state, "updated", result.message)
  assert.equal(onMain(repo.bare, STARTER), withContact(starterRoster()))
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})
