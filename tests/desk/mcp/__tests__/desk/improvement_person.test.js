// Which person's card folder a session start reads: DESK_PERSON, else the crew roster matched with the session's
// identity, using only what is known without a network call. Throwaway desks; no process is started.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { mkTempRoot } from "../_temp_roots.js"
import { improvementPerson } from "../../../../../plugins/desk/mcp/src/desk/improvement-person.js"

const ROSTER = "| alias | identity | path |\n|---|---|---|\n| alex | agarcia | desks/alex |\n| bob | bsmith | desks/bob |\n"

async function crewDesk() {
  const root = await mkTempRoot("desk-improvement-person-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "desks", "alex"), { recursive: true })
  await fs.writeFile(path.join(root, "_meta", "desks.md"), ROSTER)
  return root
}

test("DESK_PERSON names the person, a bad alias is the solo folder, and a solo desk has no person", async () => {
  const root = await mkTempRoot("desk-improvement-person-solo-")
  assert.deepEqual(await improvementPerson({ deskRoot: root, env: {} }), { status: "ok", personPrefix: "" })
  assert.deepEqual(await improvementPerson({ deskRoot: root, env: { DESK_PERSON: " sam " } }), { status: "ok", personPrefix: path.posix.join("desks", "sam") })
  for (const bad of ["a/b", "..", "x..y", "."]) assert.deepEqual(await improvementPerson({ deskRoot: root, env: { DESK_PERSON: bad } }), { status: "ok", personPrefix: "" }, bad)
  assert.deepEqual(await improvementPerson({ deskRoot: root, env: { DESK_PERSON: "   " } }), { status: "ok", personPrefix: "" })
})

test("a crew desk's person comes from the roster and DESK_IDENTITY, or the cached login, and is otherwise unresolved", async () => {
  const root = await crewDesk()
  const state = await mkTempRoot("desk-improvement-person-state-")
  const env = { HOME: state, XDG_STATE_HOME: path.join(state, "state") }
  assert.deepEqual(await improvementPerson({ deskRoot: root, env: { ...env, DESK_IDENTITY: "BSmith" } }), { status: "ok", personPrefix: path.posix.join("desks", "bob") })
  assert.deepEqual(await improvementPerson({ deskRoot: root, env: { ...env, DESK_IDENTITY: "nobody" } }), { status: "unresolved", reason: "no_matching_member" })
  // Nothing cached and no identity: no lookup is started, and the answer says so.
  assert.deepEqual(await improvementPerson({ deskRoot: root, env }), { status: "unresolved", reason: "login_not_cached" })
  assert.deepEqual(await fs.readdir(state), [], "nothing was written")
  // A fresh cached login is used.
  const now = Date.now()
  const cache = path.join(state, "state", "ouroboros-skills", "desk", "identity-cache.json")
  await fs.mkdir(path.dirname(cache), { recursive: true })
  await fs.writeFile(cache, JSON.stringify({ [await fs.realpath(root)]: { identity: "agarcia", checked_at: now } }))
  assert.deepEqual(await improvementPerson({ deskRoot: root, env, now }), { status: "ok", personPrefix: path.posix.join("desks", "alex") })
  // DESK_PERSON still wins on a crew desk.
  assert.deepEqual(await improvementPerson({ deskRoot: root, env: { ...env, DESK_PERSON: "bob" }, now }), { status: "ok", personPrefix: path.posix.join("desks", "bob") })
})

test("a roster alias that is not a valid folder name is unresolved, not a crash", async () => {
  const root = await crewDesk()
  await fs.writeFile(path.join(root, "_meta", "desks.md"), "| alias | identity | path |\n|---|---|---|\n| a..b | bsmith | desks/x |\n")
  assert.deepEqual(await improvementPerson({ deskRoot: root, env: { DESK_IDENTITY: "bsmith" } }), { status: "unresolved", reason: "invalid_member" })
})

test("the boot's settled member decides the person; without one the signed-in logins do", async () => {
  const root = await crewDesk()
  const state = await mkTempRoot("desk-improvement-person-member-")
  const env = { HOME: state, XDG_STATE_HOME: path.join(state, "state") }
  const member = (fields) => ({ crew: true, person: null, source: null, identity: null, problem: null, ...fields })
  assert.deepEqual(await improvementPerson({ deskRoot: root, env, member: member({ person: "bob", source: "crew-roster" }) }), { status: "ok", personPrefix: path.posix.join("desks", "bob") })
  assert.deepEqual(await improvementPerson({ deskRoot: root, env, member: member({ person: "a/b" }) }), { status: "unresolved", reason: "invalid_member" })
  assert.deepEqual(await improvementPerson({ deskRoot: root, env, member: member({ problem: "several_accounts" }) }), { status: "unresolved", reason: "several_accounts" })
  assert.deepEqual(await improvementPerson({ deskRoot: root, env, member: member({ problem: "not_on_roster" }) }), { status: "unresolved", reason: "no_matching_member" })
  // No member passed: the logins signed in to gh, read from gh's own hosts.yml.
  const gh = await mkTempRoot("desk-improvement-person-gh-")
  const signedIn = async (...logins) => {
    await fs.writeFile(path.join(gh, "hosts.yml"), `github.com:\n    users:\n${logins.map((login) => `        ${login}:\n`).join("")}    user: ${logins[0]}\n`)
    return improvementPerson({ deskRoot: root, env: { ...env, GH_CONFIG_DIR: gh } })
  }
  assert.deepEqual(await signedIn("agarcia"), { status: "ok", personPrefix: path.posix.join("desks", "alex") })
  assert.deepEqual(await signedIn("agarcia", "bsmith"), { status: "unresolved", reason: "several_accounts" })
  assert.deepEqual(await signedIn("stranger"), { status: "unresolved", reason: "no_matching_member" })
})

test("with no login signed in, a cached login that is not on the roster, or whose alias is not a folder name, is unresolved", async () => {
  const root = await crewDesk()
  const state = await mkTempRoot("desk-improvement-person-cached-")
  const env = { HOME: state, XDG_STATE_HOME: path.join(state, "state") }
  const now = Date.now()
  const cache = path.join(state, "state", "ouroboros-skills", "desk", "identity-cache.json")
  await fs.mkdir(path.dirname(cache), { recursive: true })
  const cached = async (identity) => fs.writeFile(cache, JSON.stringify({ [await fs.realpath(root)]: { identity, checked_at: now } }))
  await cached("stranger")
  assert.deepEqual(await improvementPerson({ deskRoot: root, env, now }), { status: "unresolved", reason: "no_matching_member" })
  await fs.writeFile(path.join(root, "_meta", "desks.md"), "| alias | identity | path |\n|---|---|---|\n| a..b | bsmith | desks/x |\n")
  await cached("bsmith")
  assert.deepEqual(await improvementPerson({ deskRoot: root, env, now }), { status: "unresolved", reason: "invalid_member" })
})
