// crew.js status: whether a clone is a Crew workspace, and if it is, its setup (monorepo or dual-repo), where the team's
// plugin comes from and who the session is in it. A repository that is not a Crew workspace yet gets one plain message
// that points to starting a crew in it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { CIT_SHAPED, teamRepo } from "./_fixtures.js"
import { crewStatus } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { git } from "./_fixtures.js"

const NOT_CREW = "This repository is not a Crew workspace yet. To make it one, start a crew in it with crew:start-crew, which adds Crew's layout and keeps everything already here; then teammates join it with crew:join-crew."

const ROSTER = "# Desks\n\n| alias | identity | path | repo | worker_variant | write_subtree |\n|---|---|---|---|---|---|\n| pat | pat_example | desks/pat | acme/team | crew | desks/pat |\n"

test("a folder that is not a Git clone", async () => {
  const dir = await mkTempRoot("crew-status-plain-")
  const status = await crewStatus({ repo: dir })
  assert.equal(status.state, "not_git")
  assert.match(status.message, /is not a Git clone/u)
})

test("a repository with no Crew layout, new or full of content, gets the one plain message", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const status = await crewStatus({ repo: repo.clone, spawnGit: repo.spawnGit })
  assert.equal(status.state, "not_crew")
  assert.equal(status.message, NOT_CREW)
  const empty = await teamRepo({ "README.md": "# New\n", LICENSE: "MIT\n", ".github/CODEOWNERS": "* @acme\n" })
  assert.equal((await crewStatus({ repo: empty.clone })).message, NOT_CREW)
})

test("a Crew workspace made before the declaration existed: a monorepo, the roster and the member", async () => {
  const repo = await teamRepo({ "_meta/desks.md": ROSTER, "desks/_template/AGENTS.md": "# {{alias}}\n", "desks/pat/AGENTS.md": "# pat\n" })
  const status = await crewStatus({ repo: repo.clone, identity: "PAT_EXAMPLE" })
  assert.equal(status.state, "crew")
  assert.equal(status.origin, "acme/team")
  assert.equal(status.setup, "monorepo")
  assert.deepEqual(status.roster, ["pat"])
  assert.equal(status.template, true)
  assert.deepEqual(status.member, { alias: "pat", desk: "desks/pat" })
  assert.equal(status.tooling, null)
  assert.match(status.message, /pat_example is on the roster as pat/iu)
  const stranger = await crewStatus({ repo: repo.clone, identity: "new_person" })
  assert.equal(stranger.member, null)
  assert.match(stranger.message, /new_person has no roster row yet; join with crew:join-crew/u)
  const anonymous = await crewStatus({ repo: repo.clone })
  assert.match(anonymous.message, /^This is a Crew workspace with 1 desk \(pat\)\.$/u)
})

test("a dual-repo workspace reports its tooling repository and the install commands, which always fetch the current plugin", async () => {
  const declaration = { tooling: { repo: "acme/team-tooling", path: "plugins/team", plugin: "team", marketplace: "acme" } }
  const repo = await teamRepo({ "_meta/crew.json": JSON.stringify(declaration), "_meta/desks.md": ROSTER, "desks/_template/AGENTS.md": "x" })
  const status = await crewStatus({ repo: repo.clone })
  assert.equal(status.setup, "dual-repo")
  assert.equal(status.merge_workflow, undefined)
  assert.deepEqual(status.tooling, {
    repo: "acme/team-tooling", path: "plugins/team", plugin: "team", ref: "main", marketplace: "acme",
    install: { copilot: "agency plugin install github:acme/team-tooling:plugins/team@main --engine copilot --cache-policy auto --cache-ttl 0", claude: ["claude plugin marketplace add acme/team-tooling", "claude plugin install team@acme"] },
    message: "Install the team's tooling, plugin team from acme/team-tooling.",
  })
  assert.deepEqual(status.problems, [])
})

test("install commands: a stub repository, a repository plugin with no marketplace, and tooling inside the workspace", async () => {
  const toolingOf = async (tooling, origin) => {
    const repo = await teamRepo({ "_meta/crew.json": JSON.stringify({ tooling }), "desks/_template/AGENTS.md": "x" })
    if (origin !== undefined) git(repo.clone, ["remote", "set-url", "origin", origin])
    const { install, message } = (await crewStatus({ repo: repo.clone })).tooling
    return { install, message }
  }
  assert.deepEqual(await toolingOf({ repo: "acme/stub" }), {
    install: null, message: "The team's tooling repository acme/stub declares no plugin yet, so there is nothing to install. Read it at https://github.com/acme/stub.",
  })
  assert.deepEqual((await toolingOf({ repo: "acme/tools", plugin: "tools", ref: "dev" })).install, { copilot: "agency plugin install github:acme/tools@dev --engine copilot --cache-policy auto --cache-ttl 0", claude: null })
  assert.deepEqual(await toolingOf({ path: "plugins/team", plugin: "team" }), { install: { copilot: "agency plugin install github:acme/team:plugins/team@main --engine copilot --cache-policy auto --cache-ttl 0", claude: null }, message: "Install the team's tooling, plugin team from plugins/team in this workspace." })
  assert.deepEqual(await toolingOf({ path: "plugins/team", plugin: "team" }, "https://gitlab.example.com/acme/team.git"), { install: null, message: "The team's tooling is plugins/team inside this workspace; this clone's origin is not on GitHub, so install it from the clone." })
})

test("a monorepo with its plugin inside plugins/ and no declaration keeps working as before", async () => {
  const repo = await teamRepo({ "_meta/desks.md": ROSTER, "desks/_template/AGENTS.md": "x", "plugins/team/plugin.json": "{\"name\":\"team\"}", "plugins/notes.md": "x" })
  const status = await crewStatus({ repo: repo.clone })
  assert.equal(status.setup, "monorepo")
  assert.equal(status.tooling.path, "plugins/team")
  assert.equal(status.tooling.plugin, "team")
  assert.equal(status.tooling.install.copilot, "agency plugin install github:acme/team:plugins/team@main --engine copilot --cache-policy auto --cache-ttl 0")
})

test("a monorepo with several plugins and no declaration names none of them, and says why", async () => {
  const repo = await teamRepo({ "_meta/desks.md": ROSTER, "desks/_template/AGENTS.md": "x", "plugins/alpha-helpers/plugin.json": "{}", "plugins/team/plugin.json": "{}" })
  const status = await crewStatus({ repo: repo.clone })
  assert.equal(status.setup, "monorepo")
  assert.deepEqual(status.tooling.several, ["alpha-helpers", "team"])
  assert.equal(status.tooling.plugin, null)
  assert.equal(status.tooling.install, null)
  assert.match(status.tooling.message, /^This workspace has several plugins in plugins\/ \(alpha-helpers, team\), and _meta\/crew\.json does not say which one is the team's, so none is installed\./u)
  // Named in the declaration, the team's plugin is the one installed.
  const named = await teamRepo({ "_meta/crew.json": JSON.stringify({ tooling: { path: "plugins/team", plugin: "team" } }), "_meta/desks.md": ROSTER, "desks/_template/AGENTS.md": "x", "plugins/alpha-helpers/plugin.json": "{}", "plugins/team/plugin.json": "{}" })
  assert.equal((await crewStatus({ repo: named.clone })).tooling.install.copilot, "agency plugin install github:acme/team:plugins/team@main --engine copilot --cache-policy auto --cache-ttl 0")
})

test("an unreadable declaration and a missing template are reported", async () => {
  const repo = await teamRepo({ "_meta/crew.json": "{", "_meta/desks.md": ROSTER, "desks/pat/AGENTS.md": "x" })
  const status = await crewStatus({ repo: repo.clone })
  assert.deepEqual(status.problems, ["_meta/crew.json is not a JSON object"])
  assert.equal(status.template, false)
})

test("a clone with no origin, or one not on GitHub", async () => {
  const dir = await mkTempRoot("crew-status-local-")
  spawnSync("git", ["init", "-q", "-b", "main", dir])
  await fs.mkdir(path.join(dir, "desks", "_template"), { recursive: true })
  await fs.writeFile(path.join(dir, "desks", "_template", "AGENTS.md"), "x")
  const status = await crewStatus({ repo: dir })
  assert.equal(status.state, "crew")
  assert.equal(status.origin, null)
  assert.deepEqual(status.roster, [])
})

test("the origin is read as owner/name from the remote spellings people use", async () => {
  const repo = await teamRepo({ "desks/_template/AGENTS.md": "x" })
  const spellings = {
    "https://github.com/Acme/Team.git": "Acme/Team",
    "https://github.com/acme/team": "acme/team",
    "git@github.com:acme/team.git": "acme/team",
    "git@github-emu:acme/team.git": "acme/team",
    "ssh://git@github.com/acme/team.git/": "acme/team",
    "https://x-access-token@github.com/acme/team.git": "acme/team",
    "https://gitlab.com/acme/team.git": null,
    "/tmp/origin.git": null,
  }
  for (const [url, origin] of Object.entries(spellings)) {
    git(repo.clone, ["remote", "set-url", "origin", url])
    assert.equal((await crewStatus({ repo: repo.clone })).origin, origin, url)
  }
})
