// crew.js roster: a member's edit to the team's roster (a contact who came up in the work, or their own entry offered
// later) lands on its own through a pull request merged at once, merged three ways with what teammates changed
// meanwhile. Only a member on the desk list changes it. Every name is an invented placeholder.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, writeFileSync } from "node:fs"
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
const read = (repo) => readFileSync(file(repo), "utf8")
const edit = (repo) => writeFileSync(file(repo), withContact(read(repo)))
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
  assert.match(nothing.message, /^Nothing to land: the team's roster _shared\/landscape\/roster\.md has no change in this clone\./u)
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

test("a teammate changed the same lines first: stage people, the clone clean on the new main", async () => {
  const repo = await started()
  writeFileSync(file(repo), read(repo).replace("One section per teammate, newest last.", "One section per teammate, by team."))
  await pushFromElsewhere(repo, { [STARTER]: starterRoster().replace("One section per teammate, newest last.", "One section per teammate, by name.") })
  const result = await updateRoster(roster(repo, { apply: true }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "people")
  assert.match(result.message, /Next: read the team's roster _shared\/landscape\/roster\.md again as it is now, write the entry again in it, and run roster --apply again; it adds only what is missing\.$/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.match(read(repo), /by name\./u)
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
  // The clone is brought up to a main whose roster conflicts with the edit, then the write stops: the edit is not put back.
  writeFileSync(file(repo), read(repo).replace("One section per teammate, newest last.", "One section per teammate, by team."))
  await pushFromElsewhere(repo, { [STARTER]: starterRoster().replace("One section per teammate, newest last.", "One section per teammate, by name.") })
  const stopped = await updateRoster(roster(repo, { gh: fakeGh(repo.bare, { methods: null }).gh, apply: true }))
  assert.equal(stopped.state, "failed")
  assert.equal(stopped.stage, "pull_request")
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("core.autocrlf=true: an LF contact added to a CRLF file lands with LF on GitHub, and the clone is clean", async () => {
  const repo = await started({ "core.autocrlf": "true" })
  assert.match(read(repo), /\r\n/u)
  writeFileSync(file(repo), `${read(repo)}\n${CONTACT.trimEnd()}\n`)
  const result = await updateRoster(roster(repo, { apply: true }))
  assert.equal(result.state, "updated", result.message)
  assert.equal(onMain(repo.bare, STARTER), withContact(starterRoster()))
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})
