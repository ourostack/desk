// crew.js start when GitHub and the clone disagree about what happened: a first push GitHub took although its answer
// was lost, a local start whose origin GitHub created with a README, and a merge whose follow-up fetch failed. Each
// answer says what is true on GitHub. And a repository whose README or AGENTS.md is spelled in another case keeps that
// file instead of gaining a second one.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CIT_SHAPED, ORIGIN, fakeGh, git, mainFiles, noWait, onMain, teamRepo } from "./_fixtures.js"
import { crewStatus, joinWorkspace, startWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"

const NOW = () => 1767225600000
const LATER = () => 1767225600999
const TOOLING = { repo: "acme/team-tooling" }

test("a first push GitHub took although its answer was lost: the rerun finds the workspace on GitHub and brings the clone up to date", async () => {
  const repo = await teamRepo({})
  const lost = (cmd, args, options) => {
    if (!args.includes("push")) return repo.spawnGit(cmd, args, options)
    repo.spawnGit(cmd, args, options)
    return { status: 128, stdout: "", stderr: "fatal: the remote end hung up unexpectedly" }
  }
  const first = await startWorkspace({ repo: repo.clone, spawnGit: lost, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true })
  assert.equal(first.state, "failed")
  assert.equal(first.stage, "push")
  assert.ok(mainFiles(repo.bare).includes("_meta/crew.json"))
  const again = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: LATER, apply: true })
  assert.equal(again.state, "already_crew", again.message)
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), git(repo.bare, ["rev-parse", "main"]))
  assert.equal((await crewStatus({ repo: repo.clone })).state, "crew")
})

test("a local start whose origin GitHub created with a README is not reported as on GitHub", async () => {
  const repo = await teamRepo({ "README.md": "# New repo\n" })
  const local = path.join(repo.base, "local")
  spawnSync("git", ["init", "-q", "-b", "main", local])
  git(local, ["config", "user.email", "a@example.com"])
  git(local, ["config", "user.name", "A"])
  assert.equal((await startWorkspace({ repo: local, spawnGit: repo.spawnGit, now: NOW, apply: true })).state, "committed")
  git(local, ["remote", "add", "origin", `${ORIGIN}.git`])
  for (const apply of [true, true, false]) {
    const rerun = await startWorkspace({ repo: local, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply })
    assert.equal(rerun.state, "refused", rerun.message)
    assert.match(rerun.message, /^Nothing was pushed: this clone holds a Crew workspace that is not on GitHub, and acme\/team's main already has commits this clone does not share \(GitHub's "Add a README" option makes one\)\. Create the GitHub repository empty and run start again, or clone it and run start in that clone\.$/u)
  }
  assert.deepEqual(mainFiles(repo.bare), ["README.md"])
  // Once GitHub holds this clone's start, the rerun has nothing to do.
  const pushed = path.join(repo.base, "pushed")
  spawnSync("git", ["clone", "-q", repo.bare, pushed])
  git(local, ["push", "-q", "--force", repo.bare, "HEAD:refs/heads/main"])
  assert.equal((await startWorkspace({ repo: local, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true })).state, "already_crew")
})

test("GitHub merged the start but the fetch after it failed: published, with a note to pull; the rerun has nothing to do", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  let failNext = false
  const flaky = (cmd, args, options) => {
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
  const first = await startWorkspace({ repo: repo.clone, spawnGit: flaky, gh, wait: noWait, now: NOW, apply: true, tooling: TOOLING })
  assert.equal(first.state, "published", first.message)
  assert.equal(first.confirmed, false)
  assert.match(first.message, /^Started: GitHub merged the pull request https:\/\/github\.com\/acme\/team\/pull\/12, so the change is in effect\. This computer could not download it afterwards to double-check, probably a brief network problem\. Next: once the network is back, update this copy of the workspace and check its status\. Teammates join it with crew:join-crew\.$/u)
  assert.equal(first.reason, "fatal: unable to access: Could not resolve host")
  assert.ok(mainFiles(repo.bare).includes("_meta/crew.json"))
  const again = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: LATER, apply: true, tooling: TOOLING })
  assert.equal(again.state, "already_crew", again.message)
})

test("GitHub merged the roster row but the fetch after it failed: joined, with a note to pull", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  assert.equal((await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: TOOLING })).state, "published")
  let failNext = false
  const flaky = (cmd, args, options) => {
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
  const result = await joinWorkspace({ repo: repo.clone, spawnGit: flaky, gh, identity: "fay_example", alias: "fay", wait: noWait, now: NOW, apply: true })
  assert.equal(result.state, "joined", result.message)
  assert.equal(result.confirmed, false)
  assert.match(result.message, /^Joined: GitHub merged the pull request https:\/\/github\.com\/acme\/team\/pull\/12, so the change is in effect\. This computer could not download it afterwards to double-check, probably a brief network problem\. Next: once the network is back, update this copy of the workspace and check its status\. A Desk session started in this clone writes to desks\/fay\/ while gh is signed in as fay_example; crew\.js status --identity fay_example checks it\./u)
  assert.doesNotMatch(result.message, /fatal|git pull/u)
  assert.match(onMain(repo.bare, "_meta/desks.md"), /\| fay \| fay_example \|/u)
})

test("a README or AGENTS.md spelled in another case is kept and appended to, never joined by a second file", async () => {
  const repo = await teamRepo({ "readme.md": "# Lower-case readme\n", "Agents.md": "# Mixed-case agents\n", "notes.md": "x\n" })
  const plan = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, now: NOW, tooling: TOOLING })
  assert.deepEqual(plan.changes.filter((change) => !change.path.includes("/")), [{ path: "Agents.md", change: "append" }])
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: TOOLING })
  assert.equal(result.state, "published", result.message)
  const top = mainFiles(repo.bare).filter((file) => !file.includes("/")).sort()
  assert.deepEqual(top, ["Agents.md", "notes.md", "readme.md"])
  assert.match(onMain(repo.bare, "Agents.md"), /^# Mixed-case agents\n\n## Crew workspace\n/u)
})
