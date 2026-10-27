// crew.js status reports what a Desk session started in the clone binds: the clone, and the member it writes as, from
// Desk's own resolvers. A join checks this in the same session before it presents the result as delivered.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { teamRepo } from "./_fixtures.js"
import { crewStatus } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { forgetMemberAnswers } from "../../../../../plugins/desk/mcp/src/desk/crew-member.js"
import { main } from "../../../../../plugins/desk/mcp/scripts/crew.js"

const ROSTER = "# Desks\n\n| alias | identity | path | repo | worker_variant | write_subtree |\n|---|---|---|---|---|---|\n| pat | pat_example | desks/pat | acme/team | crew | desks/pat |\n"

async function ghConfig(login) {
  const dir = await mkTempRoot("crew-session-gh-")
  writeFileSync(path.join(dir, "hosts.yml"), `github.com:\n    users:\n        ${login}:\n    user: ${login}\n`)
  return dir
}

async function personalDesk() {
  const dir = await mkTempRoot("crew-session-personal-")
  mkdirSync(path.join(dir, "_meta"))
  mkdirSync(path.join(dir, "_archive"))
  return dir
}

test("a member's clone is ready: the clone binds, even with a user-wide DESK, and the member writes to their desk", async () => {
  forgetMemberAnswers()
  const repo = await teamRepo({ "_meta/desks.md": ROSTER, "desks/pat/AGENTS.md": "# pat\n" })
  const env = { ...process.env, DESK: await personalDesk(), GH_CONFIG_DIR: await ghConfig("pat_example") }
  delete env.CLAUDE_PLUGIN_DATA
  delete env.DESK_ACTIVATION_CONFIG
  delete env.DESK_PERSON
  delete env.DESK_IDENTITY
  const status = await crewStatus({ repo: repo.clone, identity: "pat_example", session: true, env })
  assert.deepEqual(status.session, {
    ready: true, root: realpathSync(repo.clone), root_source: "host-project", person: "pat", person_source: "crew-roster", identity: "pat_example", write_path: "desks/pat",
    message: "A Desk session started in this clone binds it and writes to desks/pat/ (crew roster, GitHub account pat_example).",
  })
  assert.match(status.message, /pat_example is on the roster as pat\. A Desk session started in this clone binds it/u)
})

test("an account that is not on the roster is not ready, with the one plain message", async () => {
  forgetMemberAnswers()
  const repo = await teamRepo({ "_meta/desks.md": ROSTER, "desks/pat/AGENTS.md": "# pat\n" })
  const env = { HOME: process.env.HOME, GH_CONFIG_DIR: await ghConfig("someone_else") }
  const status = await crewStatus({ repo: repo.clone, identity: "pat_example", session: true, env })
  assert.equal(status.session.ready, false)
  assert.equal(status.session.person, null)
  assert.match(status.session.message, /^This session's GitHub account \(someone_else\) is not on this team workspace's roster/u)
})

test("a session that would write as someone else, or bind another desk, is not ready", async () => {
  const repo = await teamRepo({ "_meta/desks.md": ROSTER, "desks/pat/AGENTS.md": "# pat\n" })
  const other = await crewStatus({ repo: repo.clone, identity: "pat_example", session: true, env: { HOME: process.env.HOME, DESK_PERSON: "sam" } })
  assert.equal(other.session.ready, false)
  assert.equal(other.session.message, "A Desk session started in this clone writes as sam (DESK_PERSON), not as pat.")
  const nobody = await crewStatus({ repo: repo.clone, identity: "new_person", session: true, env: { HOME: process.env.HOME, DESK_PERSON: "sam" } })
  assert.equal(nobody.session.message, "A Desk session started in this clone writes as sam (DESK_PERSON), not as new_person, who has no roster row.")
  const anyone = await crewStatus({ repo: repo.clone, session: true, env: { HOME: process.env.HOME, DESK_PERSON: "sam" } })
  assert.equal(anyone.session.ready, true, "with no identity given, any person will do")
  // A clone with a roster but no desks/ folder yet is not a desk a session binds: it binds DESK, or nothing.
  const bare = await teamRepo({ "_meta/desks.md": ROSTER })
  const personal = await personalDesk()
  const elsewhere = await crewStatus({ repo: bare.clone, identity: "pat_example", session: true, env: { HOME: process.env.HOME, DESK: personal }, memberFn: async () => assert.fail("not asked") })
  assert.equal(elsewhere.session.ready, false)
  assert.equal(elsewhere.session.message, `A Desk session started in this clone would bind ${personal} (env:DESK), not this clone.`)
  const none = await crewStatus({ repo: bare.clone, identity: "pat_example", session: true, env: { HOME: await mkTempRoot("crew-session-home-") }, memberFn: async () => assert.fail("not asked") })
  assert.equal(none.session.message, "A Desk session started in this clone would bind no desk (nothing found), not this clone.")
})

test("crew.js status asks for the session; join and other callers do not", async () => {
  const calls = []
  const engine = { crewStatus: async (options) => { calls.push(options); return { state: "crew" } } }
  await main({ argv: ["status", "--repo", "/work/team", "--identity", "pat_example"], write: () => {}, engine })
  assert.deepEqual(calls, [{ repo: "/work/team", identity: "pat_example", session: true }])
  const repo = await teamRepo({ "_meta/desks.md": ROSTER })
  assert.equal((await crewStatus({ repo: repo.clone, memberFn: async () => assert.fail("no session unless asked") })).session, undefined)
})
