// crew.js join: a new teammate's desk is copied from the template and pushed first, as their own desk, then their
// roster row lands through a pull request merged at once. The result says how to install the team's plugin, from the
// tooling repository (dual-repo) or from the workspace's own plugins/ (monorepo). A returning identity is recognized and
// nothing is written; a repository that is not a Crew workspace yet gets the plain message pointing to start-crew.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { appendFileSync, mkdirSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CIT_SHAPED, PR, branches, fakeGh, git, mainFiles, noWait, onMain, pushFromElsewhere, teamRepo } from "./_fixtures.js"
import { crewStatus, joinWorkspace, startWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { readCrewRoster } from "../../../../../plugins/desk/mcp/src/desk/crew-roster.js"

const NOW = () => 1767225600000

// The new member works from their own fresh clone.
function memberClone(repo) {
  const clone = path.join(repo.base, "member")
  spawnSync("git", ["clone", "-q", repo.bare, clone])
  git(clone, ["config", "user.email", "new@example.com"])
  git(clone, ["config", "user.name", "New Member"])
  git(clone, ["remote", "set-url", "origin", "https://github.com/acme/team.git"])
  return { ...repo, clone }
}

// A CIT-shaped repository started as a dual-repo workspace with a placeholder founder, as the end-to-end run leaves it.
async function adopted({ tooling = { repo: "acme/team-tooling" } } = {}) {
  const repo = await teamRepo(CIT_SHAPED)
  const { gh } = fakeGh(repo.bare)
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh, wait: noWait, now: NOW, apply: true, tooling, founder: { alias: "test-founder", identity: "test-founder-placeholder" } })
  assert.equal(result.state, "published", result.message)
  return memberClone(repo)
}

const join = (repo, extra = {}) => ({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, identity: "newbie_example", alias: "newbie", wait: noWait, now: NOW, ...extra })

test("a new member: the plan names the desk and the roster row and writes nothing", async () => {
  const repo = await adopted()
  const plan = await joinWorkspace(join(repo))
  assert.equal(plan.state, "plan")
  assert.equal(plan.desk, "desks/newbie")
  assert.deepEqual(plan.files, ["desks/newbie/AGENTS.md", "desks/newbie/README.md", "desks/newbie/_meta/friction.md"])
  assert.equal(plan.row, "| newbie | newbie_example | desks/newbie | acme/team | crew | desks/newbie |")
  assert.match(plan.message, /^Plan only: nothing was written\. Joining adds desks\/newbie\/ \(3 files\) and then the roster row for newbie_example\./u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("a new member joins: own desk pushed first, then the roster row merged; tooling is pointed to", async () => {
  const repo = await adopted()
  const { gh, calls } = fakeGh(repo.bare)
  const result = await joinWorkspace(join(repo, { apply: true, gh }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(result.alias, "newbie")
  assert.equal(result.pr, PR)
  assert.match(result.message, /^Joined: newbie_example is on the roster as newbie, with an own desk at desks\/newbie\/\./u)
  assert.match(result.message, /The team's tooling repository acme\/team-tooling declares no plugin yet, so there is nothing to install\./u)
  assert.deepEqual(readCrewRoster(repo.clone).map((row) => row.alias), ["test-founder", "newbie"])
  assert.equal(onMain(repo.bare, "desks/newbie/AGENTS.md"), onMain(repo.bare, "desks/_template/AGENTS.md").replaceAll("{{alias}}", "newbie"))
  // The desk commit is on main before the roster commit: the row never points at a missing desk.
  const log = git(repo.bare, ["log", "--format=%s", "-n", "2", "main"]).split("\n")
  assert.deepEqual(log, ["Crew: add newbie to the roster (#12)", "Crew: add newbie's desk"])
  // Only the roster row went through the pull request.
  const created = calls.find((args) => args[0] === "pr" && args[1] === "create")
  assert.equal(created[created.indexOf("--head") + 1], "crew/join-newbie-mjuohs00")
  assert.deepEqual(branches(repo.bare), ["main"])
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  // Joining again is recognized as a returning member.
  const again = await joinWorkspace(join(repo, { apply: true, gh }))
  assert.equal(again.state, "member")
  assert.equal(again.alias, "newbie")
  assert.match(again.message, /^newbie_example is already on the roster as newbie; nothing to add\./u)
})

test("a returning identity keeps its recorded alias, whatever alias is offered", async () => {
  const repo = await adopted()
  const result = await joinWorkspace(join(repo, { identity: "TEST-FOUNDER-PLACEHOLDER", alias: "someone-else", apply: true }))
  assert.equal(result.state, "member")
  assert.equal(result.alias, "test-founder")
})

test("a new member of a dual-repo workspace whose tooling repository holds a plugin gets its install command", async () => {
  const repo = await adopted({ tooling: { repo: "acme/team-tooling", path: "plugins/team", plugin: "team" } })
  const result = await joinWorkspace(join(repo, { apply: true, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(result.tooling.install.copilot, "agency plugin install github:acme/team-tooling:plugins/team@main --engine copilot --cache-policy auto --cache-ttl 0")
  assert.match(result.message, /Install the team's tooling, plugin team from acme\/team-tooling\.$/u)
  assert.ok(readCrewRoster(repo.clone).some((row) => row.alias === "newbie"))
})

test("a monorepo made before this change, with no _meta/crew.json: join works as before and installs from plugins/", async () => {
  const roster = "# Desks\n\n| alias | identity | path | repo | worker_variant | write_subtree |\n|---|---|---|---|---|---|\n| pat | pat_example | desks/pat | acme/team | crew | desks/pat |\n"
  const repo = memberClone(await teamRepo({
    "AGENTS.md": "# Placeholder crew\n",
    "_meta/desks.md": roster,
    "desks/_template/AGENTS.md": "# {{alias}}\n",
    "desks/pat/AGENTS.md": "# pat\n",
    "_shared/landscape/README.md": "Facts\n",
    "_shared/decisions/README.md": "Decisions\n",
    "plugins/team/.claude-plugin/plugin.json": "{\"name\":\"team\"}\n",
  }))
  const status = await crewStatus({ repo: repo.clone, spawnGit: repo.spawnGit })
  assert.equal(status.setup, "monorepo")
  const result = await joinWorkspace(join(repo, { apply: true, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(result.tooling.install.copilot, "agency plugin install github:acme/team:plugins/team@main --engine copilot --cache-policy auto --cache-ttl 0")
  assert.match(result.message, /Install the team's tooling, plugin team from plugins\/team in this workspace\.$/u)
  assert.deepEqual(readCrewRoster(repo.clone).map((row) => row.alias), ["pat", "newbie"])
  assert.equal(onMain(repo.bare, "desks/newbie/AGENTS.md"), "# newbie\n")
  assert.equal(onMain(repo.bare, "_meta/crew.json"), null, "join writes no declaration")
})

test("a teammate whose desk lands between fetch and push: the own-desk push is rebuilt and both desks survive", async () => {
  const repo = await adopted()
  let raced = false
  const spawnGit = (cmd, args, options) => {
    // Just before the own-desk push, another newcomer's desk lands on main.
    if (!raced && args.includes("push") && git(repo.clone, ["log", "-1", "--format=%s"]).includes("desk")) {
      raced = true
      const other = path.join(repo.base, "racer")
      spawnSync("git", ["clone", "-q", repo.bare, other])
      mkdirSync(path.join(other, "desks", "other"), { recursive: true })
      appendFileSync(path.join(other, "desks", "other", "AGENTS.md"), "# other\n")
      spawnSync("git", ["-C", other, "add", "-A"])
      spawnSync("git", ["-C", other, "-c", "user.email=o@example.com", "-c", "user.name=O", "commit", "-qm", "other's desk"])
      spawnSync("git", ["-C", other, "push", "-q", "origin", "main"])
    }
    return repo.spawnGit(cmd, args, options)
  }
  const result = await joinWorkspace(join(repo, { apply: true, spawnGit, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.state, "joined", result.message)
  assert.ok(raced)
  const files = mainFiles(repo.bare)
  assert.ok(files.includes("desks/other/AGENTS.md"))
  assert.ok(files.includes("desks/newbie/AGENTS.md"))
})

test("a teammate's conflicting roster change: the roster row is rebuilt on the new main", async () => {
  const repo = await adopted()
  let created = false
  const { gh } = fakeGh(repo.bare)
  const racing = async (args) => {
    const answer = await gh(args)
    if (args[1] === "create" && !created) {
      created = true
      const roster = onMain(repo.bare, "_meta/desks.md")
      await pushFromElsewhere(repo, { "_meta/desks.md": `${roster}| other | other_example | desks/other | acme/team | crew | desks/other |\n` })
    }
    return answer
  }
  const result = await joinWorkspace(join(repo, { apply: true, gh: racing }))
  assert.equal(result.state, "joined", result.message)
  assert.deepEqual(readCrewRoster(repo.clone).map((row) => row.alias), ["test-founder", "other", "newbie"])
})

test("a join interrupted after the desk was pushed finishes the roster row on the next run", async () => {
  const repo = await adopted()
  const { gh } = fakeGh(repo.bare, { create: { code: 1 } })
  const first = await joinWorkspace(join(repo, { apply: true, gh }))
  assert.equal(first.state, "failed")
  assert.match(first.message, /desks\/newbie\/ is pushed; run join again to add the roster row/u)
  assert.ok(mainFiles(repo.bare).includes("desks/newbie/AGENTS.md"))
  const second = await joinWorkspace(join(repo, { apply: true, gh: fakeGh(repo.bare).gh }))
  assert.equal(second.state, "joined", second.message)
  assert.equal(second.resumed, true)
})

test("join refuses before writing: not a Crew workspace, a taken alias, a bad alias, a missing template, a stray desk", async () => {
  const plain = await teamRepo(CIT_SHAPED)
  const notCrew = await joinWorkspace(join(plain, { apply: true }))
  assert.equal(notCrew.state, "not_crew")
  assert.match(notCrew.message, /^This repository is not a Crew workspace yet\. To make it one, start a crew in it with crew:start-crew/u)

  const repo = await adopted()
  const taken = await joinWorkspace(join(repo, { alias: "test-founder", apply: true }))
  assert.equal(taken.state, "refused")
  assert.match(taken.message, /the alias test-founder belongs to test-founder-placeholder; choose another alias/u)
  for (const [alias, reason] of [["", /an alias is required/u], ["_template", /is not a valid alias/u], ["UPPER", /is not a valid alias/u]]) {
    const bad = await joinWorkspace(join(repo, { alias, apply: true }))
    assert.equal(bad.state, "refused")
    assert.match(bad.message, reason)
  }
  assert.match((await joinWorkspace(join(repo, { identity: "", apply: true }))).message, /an identity is required/u)

  const stray = await teamRepo({ ...CIT_SHAPED, "_meta/desks.md": "| alias | identity |\n|---|---|\n| pat | pat_example |\n", "desks/_template/AGENTS.md": "# {{alias}}\n", "desks/newbie/notes.md": "someone's notes\n" })
  const strayResult = await joinWorkspace(join(stray, { apply: true }))
  assert.equal(strayResult.state, "refused")
  assert.match(strayResult.message, /desks\/newbie\/ already exists and does not match the template/u)

  const noTemplate = await teamRepo({ "_meta/desks.md": "| alias | identity |\n|---|---|\n| pat | pat_example |\n", "desks/pat/AGENTS.md": "x" })
  const missing = await joinWorkspace(join(noTemplate, { apply: true }))
  assert.equal(missing.state, "refused")
  assert.match(missing.message, /desks\/_template\/ is missing or empty/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("the template is copied whole: hidden and nested files, and only {{alias}} and {{identity}} change", async () => {
  const repo = await teamRepo({
    "_meta/desks.md": "# Desks\n\n| alias | identity | path |\n|---|---|---|\n| pat | pat_example | desks/pat |\n\nNotes after the table stay.\n",
    "desks/_template/.keep": "",
    "desks/_template/deep/er/note.md": "{{alias}} / {{identity}} / {{other}}\n",
    "desks/pat/x.md": "x",
  }, {})
  const result = await joinWorkspace(join(repo, { apply: true, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(repo.bare, "desks/newbie/.keep"), "")
  assert.equal(onMain(repo.bare, "desks/newbie/deep/er/note.md"), "newbie / newbie_example / {{other}}\n")
  // The row follows the roster's own columns, and the text around the table is kept.
  assert.equal(onMain(repo.bare, "_meta/desks.md"), "# Desks\n\n| alias | identity | path |\n|---|---|---|\n| pat | pat_example | desks/pat |\n| newbie | newbie_example | desks/newbie |\n\nNotes after the table stay.\n")
})

test("a workspace whose desks/ folder has no roster file yet gets one with the first row", async () => {
  const repo = await teamRepo({ "desks/_template/AGENTS.md": "# {{alias}}\n" })
  const result = await joinWorkspace(join(repo, { apply: true, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.state, "joined", result.message)
  assert.match(onMain(repo.bare, "_meta/desks.md"), /\| alias \| identity \| path \| repo \| worker_variant \| write_subtree \|\n\|[-|]+\|\n\| newbie \| newbie_example \| desks\/newbie \| acme\/team \| crew \| desks\/newbie \|\n$/u)
})

test("a join whose own-desk push is refused stops before the roster", async () => {
  const repo = await adopted()
  const spawnGit = (cmd, args, options) => (args.includes("push") ? { status: 1, stdout: "", stderr: "remote: Permission denied\nmore" } : repo.spawnGit(cmd, args, options))
  const result = await joinWorkspace(join(repo, { apply: true, spawnGit }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "push")
  assert.match(result.message, /Permission denied/u)
  assert.equal(readCrewRoster(repo.clone).some((row) => row.alias === "newbie"), false)
  // Nothing half-done is left: the clone is back where it started, and nothing reached main.
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), git(repo.bare, ["rev-parse", "main"]))
  await assert.rejects(fs.access(path.join(repo.clone, "desks", "newbie")))
})
