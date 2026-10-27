// Who a session's person is in a Crew workspace: an explicit --person, DESK_PERSON, or the roster row of the GitHub login
// the session acts as. Throwaway desks and synthetic gh configs; GitHub is a fake runner.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { ghLogins } from "../../../../../plugins/desk/mcp/src/desk/gh-logins.js"
import { isCrewWorkspace } from "../../../../../plugins/desk/mcp/src/desk/crew-roster.js"
import { envValue } from "../../../../../plugins/desk/mcp/src/util/env-value.js"
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
  assert.match(memberMessage(settled), /^Desk could not reach GitHub to ask which of the GitHub accounts signed in to gh and on this team workspace's roster \(ari_microsoft, bob_microsoft\) is yours/u)
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
  assert.equal(offline.problem, "github_unreachable")
  assert.match(memberMessage(offline), /^gh lists no signed-in account here and Desk could not ask GitHub which account gh acts as, so Desk keeps this team workspace read-only in this session\. To write to your own desk, sign in to gh as the account you joined with \(gh auth login\) and check that GitHub can be reached; then call desk_status, which checks again\.$/u)
  forgetMemberAnswers()
  const stranger = await resolveMember({ deskRoot: root, env: {}, gh: fakeGh({ "api user --jq .login": { code: 0, stdout: "stranger\n" } }), readLogins: logins() })
  assert.equal(stranger.problem, "not_on_roster")
})

test("a desk with desks/ is a Crew workspace only with _meta/crew.json or a roster; a marked one with no roster has nobody on it", async () => {
  forgetMemberAnswers()
  const root = await mkTempRoot("desk-crew-member-noroster-")
  await fs.mkdir(path.join(root, "desks", "ari"), { recursive: true })
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  // A personal desk with a track folder named desks: no member scoping, as before Crew.
  assert.deepEqual(localMember({ deskRoot: root, env: {}, readLogins: logins("ari_microsoft") }), { crew: false, person: null, source: null, identity: null, problem: null })
  await fs.writeFile(path.join(root, "_meta", "crew.json"), "{}\n")
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

// gh's hosts.yml with two accounts: `users:` in sign-in order, the active one in `user:`.
async function ghConfig(hosts) {
  const dir = await mkTempRoot("desk-crew-member-hosts-")
  await fs.writeFile(path.join(dir, "hosts.yml"), hosts)
  return dir
}

test("two roster accounts signed in: the session writes as gh's active account, the one crew.js pushes as", async () => {
  forgetMemberAnswers()
  const root = await crewClone()
  const config = await ghConfig("github.com:\n    users:\n        ari_microsoft:\n        bob_microsoft:\n    git_protocol: https\n    user: bob_microsoft\n")
  const local = localMember({ deskRoot: root, env: { GH_CONFIG_DIR: config } })
  assert.equal(local.pending, "choose")
  assert.deepEqual(local.candidates.map((row) => row.identity), ["bob_microsoft", "ari_microsoft"], "active account first")
  // In a team workspace every member can push; the active account is asked first and wins.
  const gh = fakeGh({
    "auth token --hostname github.com --user bob_microsoft": { code: 0, stdout: "tb\n" },
    "api repos/acme/team --jq .permissions.push@tb": { code: 0, stdout: "true\n" },
    "auth token --hostname github.com --user ari_microsoft": { code: 0, stdout: "ta\n" },
    "api repos/acme/team --jq .permissions.push@ta": { code: 0, stdout: "true\n" },
  })
  const settled = await settleMember(local, { deskRoot: root, gh })
  assert.deepEqual({ person: settled.person, identity: settled.identity }, { person: "bob", identity: "bob_microsoft" })
  assert.deepEqual(gh.calls, ["auth token --hostname github.com --user bob_microsoft", "api repos/acme/team --jq .permissions.push@tb"])
})

test("the active account is not on the roster: one other roster account is the member; several are refused", async () => {
  forgetMemberAnswers()
  const root = await crewClone()
  const one = await ghConfig("github.com:\n    users:\n        ari_microsoft:\n        ari-personal:\n    user: ari-personal\n")
  const member = localMember({ deskRoot: root, env: { GH_CONFIG_DIR: one } })
  assert.deepEqual({ person: member.person, pending: member.pending }, { person: "ari", pending: undefined })
  const two = await ghConfig("github.com:\n    users:\n        ari_microsoft:\n        bob_microsoft:\n        ari-personal:\n    user: ari-personal\n")
  const refused = localMember({ deskRoot: root, env: { GH_CONFIG_DIR: two } })
  assert.deepEqual({ person: refused.person, problem: refused.problem, pending: refused.pending }, { person: null, problem: "several_accounts", pending: undefined })
  assert.equal(await settleMember(refused, { deskRoot: root, gh: () => assert.fail("no GitHub call") }), refused)
  assert.equal(memberMessage(refused), "Several GitHub accounts signed in to gh are on this team workspace's roster (ari_microsoft, bob_microsoft), and Desk cannot tell which one is yours: gh's active account is not one of them, or GitHub did not say which of them can push to it, so Desk keeps this team workspace read-only in this session. To write to your own desk, switch gh to your own account (gh auth switch --user <your login>), or start this one session with DESK_PERSON set to your alias; then call desk_status, which checks again.")
})

test("two roster accounts signed in and GitHub unreachable: the refusal leads with the network, not with switching accounts", async () => {
  forgetMemberAnswers()
  const root = await crewClone()
  const local = localMember({ deskRoot: root, env: {}, readLogins: logins("ari_microsoft", "bob_microsoft") })
  const offline = fakeGh({
    "auth token --hostname github.com --user ari_microsoft": { code: 0, stdout: "ta\n" },
    "auth token --hostname github.com --user bob_microsoft": { code: 0, stdout: "tb\n" },
  })
  const settled = await settleMember(local, { deskRoot: root, gh: offline })
  assert.deepEqual({ person: settled.person, problem: settled.problem, unreachable: settled.unreachable }, { person: null, problem: "several_accounts", unreachable: true })
  assert.equal(memberMessage(settled), "Desk could not reach GitHub to ask which of the GitHub accounts signed in to gh and on this team workspace's roster (ari_microsoft, bob_microsoft) is yours, so Desk keeps this team workspace read-only in this session. To write to your own desk, check that GitHub can be reached; then call desk_status, which checks again. If GitHub answers and Desk still cannot tell, switch gh to your own account (gh auth switch --user <your login>).")
  // GitHub answered and neither account can push: the account-choice message, as before.
  forgetMemberAnswers()
  const neither = fakeGh({
    "auth token --hostname github.com --user ari_microsoft": { code: 0, stdout: "ta\n" },
    "api repos/acme/team --jq .permissions.push@ta": { code: 0, stdout: "false\n" },
    "auth token --hostname github.com --user bob_microsoft": { code: 0, stdout: "tb\n" },
    "api repos/acme/team --jq .permissions.push@tb": { code: 1, stdout: "", stderr: "HTTP 404: Not Found (HTTP 404)" },
  })
  const answered = await settleMember(local, { deskRoot: root, gh: neither })
  assert.equal(answered.unreachable, undefined)
  assert.match(memberMessage(answered), /^Several GitHub accounts signed in to gh are on this team workspace's roster/u)
})

test("one GitHub account on two roster rows is refused, not bound to the first row", async () => {
  const root = await crewClone({ roster: "| alias | identity |\n|---|---|\n| ari | ari_microsoft |\n| arimendelow | ARI_microsoft |\n" })
  for (const member of [
    localMember({ deskRoot: root, env: {}, readLogins: logins("ari_microsoft") }),
    localMember({ deskRoot: root, env: { DESK_IDENTITY: "ari_microsoft" } }),
  ]) {
    assert.deepEqual({ person: member.person, problem: member.problem, aliases: member.aliases }, { person: null, problem: "several_rows", aliases: ["ari", "arimendelow"] })
    assert.equal(memberMessage(member), "This session's GitHub account ari_microsoft is on more than one row of this team workspace's roster (ari, arimendelow), so Desk keeps this team workspace read-only in this session. Ask the team to remove the extra row from _meta/desks.md through a pull request; then call desk_status, which checks again.")
  }
  forgetMemberAnswers()
  const asked = await resolveMember({ deskRoot: root, env: {}, gh: fakeGh({ "api user --jq .login": { code: 0, stdout: "ari_microsoft\n" } }), readLogins: logins() })
  assert.equal(asked.problem, "several_rows")
})

test("on Windows, gh's config is found under APPDATA in a plain copy of the environment, as the tool server holds it", async () => {
  const root = await crewClone()
  const home = await mkTempRoot("desk-crew-member-win-")
  const appData = path.join(home, "AppData", "Roaming")
  await fs.mkdir(path.join(appData, "GitHub CLI"), { recursive: true })
  await fs.writeFile(path.join(appData, "GitHub CLI", "hosts.yml"), "github.com:\r\n    users:\r\n        ari_microsoft:\r\n        ari-personal:\r\n    user: ari-personal\r\n")
  // Windows spells it APPDATA; the server's environment is a plain object, so only a lookup that ignores case finds it.
  const env = { APPDATA: appData, USERPROFILE: home, desk_identity: undefined }
  const win32 = (options) => ghLogins({ ...options, platform: "win32" })
  assert.deepEqual(win32({ env, homeDir: home }), ["ari-personal", "ari_microsoft"])
  const member = localMember({ deskRoot: root, env, homeDir: home, readLogins: win32, platform: "win32" })
  assert.deepEqual({ person: member.person, source: member.source, identity: member.identity }, { person: "ari", source: "crew-roster", identity: "ari_microsoft" })
  // Every variable the resolver reads is matched without regard to case on Windows, and only there.
  assert.equal(localMember({ deskRoot: root, env: { Desk_Person: "bob" }, readLogins: logins(), platform: "win32" }).person, "bob")
  assert.equal(localMember({ deskRoot: root, env: { Desk_Identity: "bob_microsoft" }, readLogins: logins("ari_microsoft"), platform: "win32" }).person, "bob")
  assert.equal(localMember({ deskRoot: root, env: { Desk_Person: "bob" }, readLogins: logins("ari_microsoft"), platform: "linux" }).person, "ari")
  assert.equal(envValue({ APPDATA: "a", AppData: "b" }, "AppData", "win32"), "b", "an exact spelling wins")
  assert.equal(envValue({}, "APPDATA", "win32"), undefined)
  assert.equal(envValue(null, "APPDATA", "win32"), undefined)
  assert.equal(envValue({ APPDATA: "a" }, "APPDATA"), "a")
})

test("a folder is a Crew workspace only with _meta/crew.json or a roster with a named row", async () => {
  assert.equal(isCrewWorkspace(await crewClone()), true)
  assert.equal(isCrewWorkspace(await crewClone({ roster: "| alias | identity |\n|---|---|\n" })), false)
  assert.equal(isCrewWorkspace(""), false)
  assert.equal(isCrewWorkspace(undefined), false)
})
