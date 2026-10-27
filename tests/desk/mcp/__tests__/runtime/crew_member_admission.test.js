// The tool server scopes a Crew workspace session to the member's own desk with no --person: the roster row of the GitHub
// login the session acts as. With no match it serves reads and refuses every write with one plain message. A personal
// desk is unchanged. Throwaway desks and synthetic gh configs; no network.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { callTool, waitForStatusInspection } from "../../../../../plugins/desk/mcp/src/server.js"
import { forgetMemberAnswers } from "../../../../../plugins/desk/mcp/src/desk/crew-member.js"
import { idleSearchEngine, startInProcess } from "./_in_process_desk.js"
import { mkTempRoot } from "../_temp_roots.js"

const ROSTER = "| alias | identity | path |\n|---|---|---|\n| ari | ari_microsoft | desks/ari |\n| bob | bob_microsoft | desks/bob |\n"

async function crewRoot() {
  const root = await mkTempRoot("desk-crew-admission-")
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  mkdirSync(path.join(root, "desks", "ari"), { recursive: true })
  mkdirSync(path.join(root, "desks", "bob"), { recursive: true })
  writeFileSync(path.join(root, "_meta", "desks.md"), ROSTER)
  return root
}

async function ghConfig(...logins) {
  const dir = await mkTempRoot("desk-crew-admission-gh-")
  writeFileSync(path.join(dir, "hosts.yml"), `github.com:\n    users:\n${logins.map((login) => `        ${login}:\n`).join("")}    user: ${logins[0]}\n`)
  return dir
}

async function start(t, { root, argv = [], env = {} }) {
  forgetMemberAnswers()
  const desk = await startInProcess({
    argv: ["--root", root, ...argv],
    env,
    readinessPolicy: { semantic: "unsupported" },
    runtimeImporter: async () => ({ callTool, waitForStatusInspection, createSearchEngine: () => idleSearchEngine() }),
  })
  t.after(async () => {
    await desk.handle.admission.idle({ waitMs: 10000 })
    await desk.close()
  })
  return desk
}

test("a member's session writes only to their own desk, found from the roster with no --person", async (t) => {
  const root = await crewRoot()
  const desk = await start(t, { root, env: { GH_CONFIG_DIR: await ghConfig("ari-personal", "ari_microsoft") } })
  const created = await desk.call("task_create", { track: "ops", slug: "member-write", title: "A member's write" })
  assert.equal(created.isError, false, JSON.stringify(created.payload))
  assert.equal(created.payload.path, "desks/ari/ops/member-write/task.md")
  assert.equal(existsSync(path.join(root, "ops")), false, "nothing at the workspace root")
  const status = await desk.statusUntil((payload) => payload.write_scope !== undefined)
  assert.deepEqual(status.write_scope, { mode: "person", person: "ari", relative_path: "desks/ari", source: "crew-roster", identity: "ari_microsoft" })
  assert.equal(desk.handle.session.context.person, "ari")
  const compact = (await desk.call("desk_status")).payload
  assert.deepEqual(compact.write_scope, { mode: "person", person: "ari", source: "crew-roster" })
})

test("an account that is not on the roster can read but every write is refused with one plain message", async (t) => {
  const root = await crewRoot()
  const desk = await start(t, { root, env: { GH_CONFIG_DIR: await ghConfig("stranger") } })
  const refused = await desk.call("task_create", { track: "ops", slug: "stranger-write", title: "Not a member" })
  assert.equal(refused.isError, true)
  assert.equal(refused.payload.code, "crew_member_unknown")
  assert.equal(refused.payload.fix, "This session's GitHub account (stranger) is not on this team workspace's desk list, so Desk keeps this team workspace read-only in this session. To write to your own desk, join with crew:join-crew, or sign in to gh as the account you joined with (gh auth login); then call desk_status, which checks again.")
  assert.deepEqual(readdirSync(path.join(root, "desks", "ari")), [], "nothing was written")
  assert.equal(existsSync(path.join(root, "ops")), false)
  const read = await desk.call("desk_search", { query: "anything" })
  assert.equal(read.isError, false, JSON.stringify(read.payload))
  const status = await desk.statusUntil((payload) => payload.write_scope !== undefined)
  assert.equal(status.state, "degraded:crew_member_unknown")
  assert.deepEqual(status.write_scope, { mode: "read_only", person: null, relative_path: null, source: null, problem: refused.payload.fix })
})

test("an explicit --person wins in a Crew workspace under the default policy, and DESK_PERSON comes next", async (t) => {
  const root = await crewRoot()
  const gh = await ghConfig("ari_microsoft")
  const explicit = await start(t, { root, argv: ["--person", "bob"], env: { GH_CONFIG_DIR: gh, DESK_PERSON: "ari" } })
  const created = await explicit.call("task_create", { track: "ops", slug: "explicit", title: "Explicit person" })
  assert.equal(created.payload.path, "desks/bob/ops/explicit/task.md", JSON.stringify(created.payload))
  assert.equal((await explicit.statusUntil((payload) => payload.write_scope !== undefined)).write_scope.source, "launch-argument")

  const named = await start(t, { root, env: { GH_CONFIG_DIR: await ghConfig("stranger"), DESK_PERSON: "bob" } })
  const viaEnv = await named.call("task_create", { track: "ops", slug: "named", title: "DESK_PERSON" })
  assert.equal(viaEnv.payload.path, "desks/bob/ops/named/task.md", JSON.stringify(viaEnv.payload))
  assert.equal((await named.statusUntil((payload) => payload.write_scope !== undefined)).write_scope.source, "env:DESK_PERSON")
})

test("an explicit person that is not a folder name is refused, not used", async (t) => {
  const root = await crewRoot()
  const desk = await start(t, { root, env: { DESK_PERSON: "../escape" } })
  const refused = await desk.call("task_create", { track: "ops", slug: "escape", title: "Escape" })
  assert.equal(refused.payload.code, "authority_invalid")
  assert.equal(existsSync(path.join(root, "ops")), false)
})

test("a personal desk is unchanged: DESK_PERSON is ignored and writes stay at the root", async (t) => {
  const root = await mkTempRoot("desk-crew-admission-solo-")
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  mkdirSync(path.join(root, "_archive"), { recursive: true })
  const desk = await start(t, { root, env: { DESK_PERSON: "ari", GH_CONFIG_DIR: await ghConfig("ari_microsoft") } })
  const created = await desk.call("task_create", { track: "ops", slug: "solo", title: "Solo write" })
  assert.equal(created.payload.path, "ops/solo/task.md", JSON.stringify(created.payload))
  const status = await desk.statusUntil((payload) => payload.write_scope !== undefined)
  assert.deepEqual(status.write_scope, { mode: "workspace", person: null, relative_path: "." })
})

test("a personal desk with a track folder named desks still writes: only a real Crew workspace gets member scoping", async (t) => {
  const root = await mkTempRoot("desk-crew-admission-desks-track-")
  for (const dir of ["_meta", "_archive", "desks"]) mkdirSync(path.join(root, dir), { recursive: true })
  writeFileSync(path.join(root, "desks", "track.md"), "---\nname: desks\n---\n# Desks\n")
  const desk = await start(t, { root, env: { GH_CONFIG_DIR: await ghConfig("someone") } })
  const created = await desk.call("task_create", { track: "ops", slug: "solo", title: "Solo write" })
  assert.equal(created.isError, false, JSON.stringify(created.payload))
  assert.equal(created.payload.path, "ops/solo/task.md")
})
