// crew.js in clones that convert line endings, as Git for Windows does by default (core.autocrlf=true) and as many
// macOS and Linux setups do on commit (core.autocrlf=input). The test environment switches off Git's system and global
// settings, so each clone here sets the option itself, and these tests run the same on every platform, the Windows
// shards included. A start or join that merged is reported as merged: the read-back compares what Git stores, not the
// files as the clone shows them.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CIT_SHAPED, ORIGIN, fakeGh, git, noWait, onMain, teamRepo } from "./_fixtures.js"
import { crewStatus, joinWorkspace, startWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"

const NOW = () => 1767225600000
const LATER = () => 1767225600999
const TOOLING = { repo: "acme/team-tooling" }

function memberClone(repo, name, autocrlf) {
  const clone = path.join(repo.base, name)
  spawnSync("git", ["clone", "-q", "-c", `core.autocrlf=${autocrlf}`, repo.bare, clone])
  git(clone, ["config", "user.email", `${name}@example.com`])
  git(clone, ["config", "user.name", name])
  git(clone, ["remote", "set-url", "origin", `${ORIGIN}.git`])
  return { ...repo, clone }
}

for (const autocrlf of ["true", "input"]) {
  test(`core.autocrlf=${autocrlf}: a start and a join that merged are reported as done, and GitHub holds LF files`, async () => {
    for (const files of [CIT_SHAPED, { "README.md": "# Team\n", "notes/a.md": "x\n" }]) {
      const repo = await teamRepo(files, { cloneConfig: { "core.autocrlf": autocrlf } })
      const start = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: TOOLING, founder: { alias: "founder", identity: "founder_example" } })
      assert.equal(start.state, "published", start.message)
      assert.equal(start.confirmed, undefined)
      assert.doesNotMatch(onMain(repo.bare, "_meta/crew.json"), /\r/u)
      assert.doesNotMatch(onMain(repo.bare, "AGENTS.md"), /\r/u)
      assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
      if (autocrlf === "true") assert.match(readFileSync(path.join(repo.clone, "_meta", "crew.json"), "utf8"), /\r\n/u)
      const member = memberClone(repo, "member", autocrlf)
      const join = await joinWorkspace({ repo: member.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, identity: "newbie_example", alias: "newbie", wait: noWait, now: LATER, apply: true })
      assert.equal(join.state, "joined", join.message)
      assert.doesNotMatch(onMain(repo.bare, "_meta/desks.md"), /\r/u)
      assert.equal((await crewStatus({ repo: member.clone, identity: "newbie_example" })).member.alias, "newbie")
      assert.equal(git(member.clone, ["status", "--porcelain"]), "")
    }
  })
}
