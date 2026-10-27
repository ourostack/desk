// Who a session's person is in a Crew workspace: an explicit --person, DESK_PERSON, or the roster row of the GitHub login
// the session acts as. Throwaway desks and synthetic gh configs; GitHub is a fake runner.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import {
  forgetMemberAnswers, localMember, memberMessage, memberSourceLabel, originRepository, resolveMember, settleMember,
} from "../../../../../plugins/desk/mcp/src/desk/crew-member.js"

const ROSTER = "| alias | identity | path |\n|---|---|---|\n| ari | ari_microsoft | desks/ari |\n| bob | bob_microsoft | desks/bob |\n| empty |  | desks/empty |\n"

async function crewClone({ roster = ROSTER, origin = "https://github.com/acme/team.git" } = {}) {
  const root = await mkTempRoot("desk-crew-member-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "desks", "ari"), { recursive: true })
  await fs.writeFile(path.join(root, "_meta", "desks.md"), roster)
  await fs.mkdir(path.join(root, ".git"), { recursive: true })
  await fs.writeFile(path.join(root, ".git", "config"), origin === null ? "[core]\n\tbare = false\n" : `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
  return root
}

const logins = (...names) => () => names

// A fake gh: `answers` maps a joined argument list (and the token, after "@") to { code, stdout, stderr }.
function fakeGh(answers) {
  const calls = []
  const gh = async (args, options = {}) => {
    const key = `${args.join(" ")}${options.token ? `@${options.token}` : ""}`
    calls.push(key)
    return answers[key] ?? { code: 1, stdout: "", stderr: "no answer" }
  }
  gh.calls = calls
  return gh
}

test("a personal desk has a person only from --person, and DESK_PERSON never changes it", async () => {
  const root = await mkTempRoot("desk-crew-member-solo-")
  assert.deepEqual(localMember({ deskRoot: root, env: { DESK_PERSON: "ari" } }), { crew: false, person: null, source: null, identity: null, problem: null })
  assert.deepEqual(localMember({ deskRoot: root, person: " ari ", env: {} }), { crew: false, person: "ari", source: "launch-argument", identity: null, problem: null })
  assert.equal(memberMessage(localMember({ deskRoot: root, env: {} })), null)
})

test("in a Crew workspace an explicit person wins, then DESK_PERSON, then the roster", async () => {
  const root = await crewClone()
  const env = { DESK_PERSON: "bob" }
  assert.deepEqual(localMember({ deskRoot: root, person: "carol", env, readLogins: logins("ari_microsoft") }), { crew: true, person: "carol", source: "launch-argument", identity: null, problem: null })
  assert.deepEqual(localMember({ deskRoot: root, env, readLogins: logins("ari_microsoft") }), { crew: true, person: "bob", source: "env:DESK_PERSON", identity: null, problem: null })
  assert.deepEqual(localMember({ deskRoot: root, env: {}, readLogins: logins("ARI_microsoft") }),
    { crew: true, person: "ari", source: "crew-roster", identity: "ari_microsoft", logins: ["ARI_microsoft"], problem: null })
})

test("the roster match uses the signed-in logins with no network call, DESK_IDENTITY first", async () => {
  const root = await crewClone()
  // A personal account and the member's EMU account signed in: only one is on the roster.
  const member = localMember({ deskRoot: root, env: {}, readLogins: logins("ari-personal", "ari_microsoft") })
  assert.equal(member.person, "ari")
  assert.equal(member.source, "crew-roster")
  assert.equal(await settleMember(member, { deskRoot: root, gh: () => assert.fail("no GitHub call") }), member)
  assert.equal(localMember({ deskRoot: root, env: { DESK_IDENTITY: "bob_microsoft" }, readLogins: logins("ari_microsoft") }).person, "bob")
  const nobody = localMember({ deskRoot: root, env: { DESK_IDENTITY: "nobody" }, readLogins: logins("ari_microsoft") })
  assert.equal(nobody.problem, "not_on_roster")
  assert.match(memberMessage(nobody), /^This session's GitHub account \(nobody\) is not on this team workspace's roster, so Desk keeps this team workspace read-only in this session\. To write to your own desk, join with crew:join-crew, or sign in to gh as the account you joined with \(gh auth login\); then call desk_status, which checks again\.$/u)
  // A row with no identity never matches, and a broken login reader counts as no login.
  assert.equal(localMember({ deskRoot: root, env: {}, readLogins: logins("") }).pending, "whoami")
  assert.equal(localMember({ deskRoot: root, env: {}, readLogins: () => { throw new Error("unreadable") } }).pending, "whoami")
})

test("a real gh hosts.yml is read from GH_CONFIG_DIR", async () => {
  const root = await crewClone()
  const config = await mkTempRoot("desk-crew-member-gh-")
  await fs.writeFile(path.join(config, "hosts.yml"), "github.com:\n    users:\n        bob_microsoft:\n    user: bob_microsoft\n")
  const member = localMember({ deskRoot: root, env: { GH_CONFIG_DIR: config } })
  assert.equal(member.person, "bob")
  assert.equal(memberSourceLabel(member), "crew roster, GitHub account bob_microsoft")
})

test("an alias that is not a folder name is a problem, not a person", async () => {
  const root = await crewClone({ roster: "| alias | identity |\n|---|---|\n| a..b | ari_microsoft |\n" })
  const member = localMember({ deskRoot: root, env: {}, readLogins: logins("ari_microsoft") })
  assert.equal(member.problem, "invalid_alias")
  assert.match(memberMessage(member), /ari_microsoft is on this team workspace's roster with an alias that is not a valid folder name/u)
})

test("several roster accounts signed in: GitHub says which one can push, once per process", async () => {
  forgetMemberAnswers()
  const root = await crewClone()
  const local = localMember({ deskRoot: root, env: {}, readLogins: logins("bob_microsoft", "ari_microsoft") })
  assert.equal(local.pending, "choose")
  const gh = fakeGh({
    "auth token --hostname github.com --user bob_microsoft": { code: 0, stdout: "tb\n" },
    "api repos/acme/team --jq .permissions.push@tb": { code: 1, stdout: "", stderr: "HTTP 404: Not Found (HTTP 404)" },
    "auth token --hostname github.com --user ari_microsoft": { code: 0, stdout: "ta\n" },
    "api repos/acme/team --jq .permissions.push@ta": { code: 0, stdout: "true\n" },
  })
  const settled = await settleMember(local, { deskRoot: root, gh })
  assert.deepEqual({ person: settled.person, source: settled.source, identity: settled.identity, pending: settled.pending }, { person: "ari", source: "crew-roster", identity: "ari_microsoft", pending: undefined })
  const calls = gh.calls.length
  assert.equal((await settleMember(local, { deskRoot: root, gh })).person, "ari")
  assert.equal(gh.calls.length, calls, "the answer is kept for the process")
})

test("several roster accounts and no answer: a problem with one message, asked again after a minute", async () => {
  forgetMemberAnswers()
  const root = await crewClone()
  const local = localMember({ deskRoot: root, env: {}, readLogins: logins("ari_microsoft", "bob_microsoft") })
  let clock = 1000
  const offline = fakeGh({ "auth token --hostname github.com --user ari_microsoft": { code: 0, stdout: "ta\n" } })
  const settled = await settleMember(local, { deskRoot: root, gh: offline, now: () => clock })
  assert.equal(settled.person, null)
  assert.equal(settled.problem, "several_accounts")
  assert.match(memberMessage(settled), /^Several GitHub accounts signed in to gh are on this team workspace's roster \(ari_microsoft, bob_microsoft\)/u)
  const asked = offline.calls.length
  await settleMember(local, { deskRoot: root, gh: offline, now: () => clock })
  assert.equal(offline.calls.length, asked, "a failed answer is kept for a minute")
  clock += 60001
  await settleMember(local, { deskRoot: root, gh: offline, now: () => clock })
  assert.ok(offline.calls.length > asked, "and asked again after it")
  // A token that cannot be read is no answer either.
  forgetMemberAnswers()
  assert.equal((await settleMember(local, { deskRoot: root, gh: fakeGh({}) })).problem, "several_accounts")
  // A clone with no GitHub origin cannot be asked at all.
  const local2 = await crewClone({ origin: null })
  assert.equal((await settleMember(localMember({ deskRoot: local2, env: {}, readLogins: logins("ari_microsoft", "bob_microsoft") }), { deskRoot: local2, gh: fakeGh({}) })).problem, "several_accounts")
})

test("gh lists no login: gh api user names the login, with an ambient token when one is set", async () => {
  forgetMemberAnswers()
  const root = await crewClone()
  const gh = fakeGh({ "api user --jq .login@ambient": { code: 0, stdout: "bob_microsoft\n" } })
  const member = await resolveMember({ deskRoot: root, env: { GH_TOKEN: "ambient" }, gh, readLogins: logins() })
  assert.deepEqual({ person: member.person, source: member.source, identity: member.identity }, { person: "bob", source: "crew-roster", identity: "bob_microsoft" })
  forgetMemberAnswers()
  const offline = await resolveMember({ deskRoot: root, env: {}, gh: fakeGh({}), readLogins: logins() })
  assert.equal(offline.problem, "not_on_roster")
  assert.match(memberMessage(offline), /^No GitHub account signed in to gh is not on|^No GitHub account signed in to gh is/u)
  forgetMemberAnswers()
  const stranger = await resolveMember({ deskRoot: root, env: {}, gh: fakeGh({ "api user --jq .login": { code: 0, stdout: "stranger\n" } }), readLogins: logins() })
  assert.equal(stranger.problem, "not_on_roster")
})

test("a Crew clone with desks/ but no roster file has nobody on its roster", async () => {
  forgetMemberAnswers()
  const root = await mkTempRoot("desk-crew-member-noroster-")
  await fs.mkdir(path.join(root, "desks", "ari"), { recursive: true })
  assert.equal(localMember({ deskRoot: root, env: {}, readLogins: logins("ari_microsoft") }).problem, "not_on_roster")
  const asked = await resolveMember({ deskRoot: root, env: {}, gh: fakeGh({ "api user --jq .login": { code: 0, stdout: "ari_microsoft\n" } }), readLogins: logins() })
  assert.equal(asked.problem, "not_on_roster")
})

test("the origin is read from the clone's Git config in every GitHub spelling", async () => {
  for (const [url, repo] of [
    ["https://github.com/acme/team.git", "acme/team"],
    ["https://token@github.com/acme/team", "acme/team"],
    ["git@github.com:acme/team.git", "acme/team"],
    ["git@github-emu:acme_x/team.git", "acme_x/team"],
    ["ssh://git@github.com/acme/team.git", "acme/team"],
    ["https://gitlab.com/acme/team.git", null],
  ]) {
    assert.equal(originRepository(await crewClone({ origin: url })), repo, url)
  }
  assert.equal(originRepository(await crewClone({ origin: null })), null)
  assert.equal(originRepository(await mkTempRoot("desk-crew-member-nogit-")), null)
})

test("labels and messages for each source", () => {
  assert.equal(memberSourceLabel({ source: "env:DESK_PERSON" }), "DESK_PERSON")
  assert.equal(memberSourceLabel({ source: "launch-argument" }), "--person")
  assert.equal(memberSourceLabel({ source: null }), "authority provider")
  assert.equal(memberMessage({ crew: true, person: "ari", problem: null }), null)
  assert.equal(memberMessage(null), null)
})
