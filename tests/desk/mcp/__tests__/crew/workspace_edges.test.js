// The crew workspace script's less common paths: what it does with odd input, unusual repositories and GitHub answers
// it did not expect. Each refusal happens before anything is written, and each failure puts the clone back.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { CIT_SHAPED, branches, fakeGh, git, noWait, onMain, pushFromElsewhere, teamRepo } from "./_fixtures.js"
import { crewStatus, joinWorkspace, startWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { readCrewRoster } from "../../../../../plugins/desk/mcp/src/desk/crew-roster.js"

const NOW = () => 1767225600000
const adopt = (repo, extra = {}) => ({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, tooling: { repo: "acme/team-tooling" }, wait: noWait, now: NOW, ...extra })
const BLOCKED = () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }) })

test("with no gh given, the real gh runs; signed in to nothing, it writes nothing and names the sign-in it needs", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR }
  // No token and an empty gh configuration, so gh refuses before reaching GitHub (or is not installed at all).
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  process.env.GH_CONFIG_DIR = await mkTempRoot("crew-no-gh-config-")
  try {
    const result = await startWorkspace(adopt(repo, { apply: true, gh: undefined, tooling: undefined }))
    assert.equal(result.state, "failed")
    assert.equal(result.stage, "account")
    assert.match(result.reason, /no signed-in GitHub account can push to acme\/team \((no gh account is signed in|gh is not installed or could not start)\)/u)
    assert.deepEqual(branches(repo.bare), ["main"])
    assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("with no wait given, the pause before asking again whether a queued pull request merged is real", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  let views = 0
  const { gh } = fakeGh(repo.bare, {
    merge: (state) => {
      spawnSync("git", ["--git-dir", repo.bare, "update-ref", "refs/heads/main", `refs/heads/${state.head}`])
      return { code: 0, stdout: "", stderr: "" }
    },
    view: () => {
      views += 1
      const merged = { state: "MERGED", mergeCommit: { oid: git(repo.bare, ["rev-parse", "main"]) } }
      return { code: 0, stdout: JSON.stringify(views === 1 ? { state: "OPEN", mergeStateStatus: "CLEAN" } : merged), stderr: "" }
    },
  })
  const started = Date.now()
  const result = await startWorkspace(adopt(repo, { apply: true, gh, wait: undefined }))
  assert.equal(result.state, "published", result.message)
  assert.equal(views, 2)
  assert.ok(Date.now() - started >= 1900)
})

test("status of things that are not a clone", async () => {
  assert.equal((await crewStatus({ repo: "" })).state, "not_git")
  assert.equal((await crewStatus({ repo: undefined })).state, "not_git")
  assert.equal((await crewStatus({ repo: path.join(await mkTempRoot("crew-missing-"), "nope") })).state, "not_git")
  const dir = await mkTempRoot("crew-broken-git-")
  // A Git that answers nothing at all.
  assert.equal((await crewStatus({ repo: dir, spawnGit: () => ({ status: 1 }) })).state, "not_git")
})

test("tooling inside the workspace is found by either plugin manifest; other folders and files are not tooling", async () => {
  const repo = await teamRepo({
    "desks/_template/AGENTS.md": "x",
    "plugins/README.md": "not a plugin",
    "plugins/aaa-notes/notes.md": "not a plugin either",
    "plugins/zeta/.claude-plugin/plugin.json": "{}",
  })
  const status = await crewStatus({ repo: repo.clone })
  assert.equal(status.tooling.path, "plugins/zeta")
})

test("an AGENTS.md with no final newline; a dual-repo workspace counts a leftover plugins/ as outside the shape", async () => {
  const repo = await teamRepo({ ...CIT_SHAPED, "AGENTS.md": "# Agents\n\nNo final newline", "plugins/old/plugin.json": "{}\n", ".github/workflows/notes.txt": "gh pr merge is mentioned here but this is not a workflow\n" })
  const { gh } = fakeGh(repo.bare)
  const plan = await startWorkspace(adopt(repo))
  assert.deepEqual(plan.outside, ["context/", "guides/", "plugins/", "team/"])
  const result = await startWorkspace(adopt(repo, { apply: true, gh, tooling: {} }))
  assert.equal(result.state, "published", result.message)
  assert.match(onMain(repo.bare, "AGENTS.md"), /^# Agents\n\nNo final newline\n\n## Crew workspace\n/u)
})

test("an ambient GH_TOKEN counts as the account when gh has none signed in, as at Desk's boot", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR }
  delete process.env.GH_TOKEN
  process.env.GITHUB_TOKEN = "  placeholder-not-a-token  "
  process.env.GH_CONFIG_DIR = await mkTempRoot("crew-env-token-gh-config-")
  try {
    // The real gh is asked with that token and GitHub refuses it (or gh is missing): either way nothing is written.
    const result = await startWorkspace(adopt(repo, { apply: true, gh: undefined, tooling: undefined }))
    assert.equal(result.state, "failed")
    assert.equal(result.stage, "account")
    assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("an answer GitHub could not give is an open pull request in an unknown state", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const { gh } = fakeGh(repo.bare, { merge: () => ({ code: 1, stderr: "x" }), view: () => ({ code: 1, stdout: "not json" }) })
  const result = await startWorkspace(adopt(repo, { apply: true, gh }))
  assert.equal(result.state, "pr_open")
  assert.equal(result.reason, "unknown")
  assert.match(result.message, /has not merged: GitHub reports unknown\. GitHub said: x\./u)
})

test("a merged pull request with no merge commit in GitHub's answer uses the fetched default branch", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const { gh } = fakeGh(repo.bare, { view: (state) => ({ code: 0, stdout: JSON.stringify(state.merged ? { state: "MERGED" } : { state: "OPEN" }) }) })
  const result = await startWorkspace(adopt(repo, { apply: true, gh }))
  assert.equal(result.state, "published", result.message)
  assert.equal(result.commit, git(repo.bare, ["rev-parse", "main"]))
})

test("a local branch already named like the change's branch: refused at the branch step, the clone untouched", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  git(repo.clone, ["branch", "crew/start-mjuohs00"])
  const result = await startWorkspace(adopt(repo, { apply: true, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "branch")
  assert.equal(git(repo.clone, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("an unexpected error is thrown, not dressed up as a result, and the clone is put back first", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const fake = fakeGh(repo.bare).gh
  await assert.rejects(startWorkspace(adopt(repo, { apply: true, gh: async (args, options) => { if (args[0] === "pr" && args[1] === "create") throw new Error("boom"); return fake(args, options) } })), /boom/u)
  assert.equal(git(repo.clone, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.deepEqual(branches(repo.bare), ["main"])
})

test("a teammate who started the crew at the same time: the rebuild refuses to overwrite, and closes its pull request", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  let created = false
  const { gh, calls } = fakeGh(repo.bare)
  const racing = async (args) => {
    const answer = await gh(args)
    if (args[1] === "create" && !created) {
      created = true
      await pushFromElsewhere(repo, { "_meta/crew.json": "{}\n" })
    }
    return answer
  }
  const result = await startWorkspace(adopt(repo, { apply: true, gh: racing }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "rebuild")
  assert.match(result.message, /_meta\/crew\.json appeared on the default branch meanwhile/u)
  // The pull request has nothing left to do, so it is closed with its branch.
  assert.equal(result.pr, undefined)
  assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "close"))
  assert.deepEqual(branches(repo.bare), ["main"])
  assert.equal(git(repo.clone, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
})

test("a Git step that fails with no message is named by its command", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const spawnGit = (cmd, args, options) => (args.includes("commit") ? { status: 1, stdout: "", stderr: "" } : repo.spawnGit(cmd, args, options))
  const result = await startWorkspace(adopt(repo, { apply: true, spawnGit, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "commit")
  assert.match(result.reason, /the commit was refused \(this repository's commit hooks or signing\): git commit failed$/u)
})

test("apply on a detached HEAD is refused", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  git(repo.clone, ["switch", "-q", "--detach"])
  const result = await startWorkspace(adopt(repo, { apply: true }))
  assert.equal(result.state, "refused")
  assert.match(result.message, /is on a detached HEAD, not the default branch main/u)
})

test("a founder in a local start with no origin gets a row with no repository", async () => {
  const dir = await mkTempRoot("crew-start-founder-")
  spawnSync("git", ["init", "-q", "-b", "main", dir])
  git(dir, ["config", "user.email", "m@example.com"])
  git(dir, ["config", "user.name", "M"])
  const result = await startWorkspace({ repo: dir, apply: true, now: NOW, founder: { alias: "first", identity: "first_example" } })
  assert.equal(result.state, "committed", result.message)
  assert.match(await fs.readFile(path.join(dir, "_meta", "desks.md"), "utf8"), /\| first \| first_example \| desks\/first \|  \| crew \| desks\/first \|/u)
})

test("join: a roster file with no roster table gets one; extra columns are left empty", async () => {
  const repo = await teamRepo({ "desks/_template/AGENTS.md": "# {{alias}}\n", "_meta/desks.md": "# Desks\n\nNo table yet\n\n\n" })
  const result = await joinWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, identity: "a_example", alias: "a", apply: true, wait: noWait, now: NOW })
  assert.equal(result.state, "joined", result.message)
  assert.match(onMain(repo.bare, "_meta/desks.md"), /^# Desks\n\nNo table yet\n\n\| alias \| identity \|/u)
  const wide = await teamRepo({ "desks/_template/AGENTS.md": "# {{alias}}\n", "_meta/desks.md": "| alias | identity | notes |\n|---|---|---|\n| b | b_example | placeholder |\n" })
  const plan = await joinWorkspace({ repo: wide.clone, identity: "c_example", alias: "c" })
  assert.equal(plan.row, "| c | c_example |  |")
})

test("join: a roster row that cannot merge leaves the desk pushed and the pull request open", async () => {
  const repo = await teamRepo({ "desks/_template/AGENTS.md": "# {{alias}}\n" })
  const { gh } = fakeGh(repo.bare, { merge: () => ({ code: 1, stderr: "blocked" }), view: BLOCKED })
  const result = await joinWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh, identity: "a_example", alias: "a", apply: true, wait: noWait, now: NOW })
  assert.equal(result.state, "pr_open")
  assert.match(result.message, /^Not joined yet: desks\/a\/ is pushed, and the pull request https:\/\/github\.com\/acme\/team\/pull\/12 is open on branch crew\/join-a-mjuohs00 and has not merged: GitHub's rules for main block merging it/u)
  assert.ok(onMain(repo.bare, "desks/a/AGENTS.md") !== null)
  // The plan for a desk that is already in place says only the roster row is left.
  const plan = await joinWorkspace({ repo: repo.clone, identity: "a_example", alias: "a" })
  assert.match(plan.message, /desks\/a\/ is already in place, so joining adds the roster row for a_example/u)
})

test("join refuses a dirty clone and a clone with no origin", async () => {
  const repo = await teamRepo({ "desks/_template/AGENTS.md": "# {{alias}}\n" })
  await fs.writeFile(path.join(repo.clone, "scratch.txt"), "x")
  const dirty = await joinWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, identity: "a_example", alias: "a", apply: true })
  assert.equal(dirty.state, "refused")
  assert.match(dirty.message, /has uncommitted changes/u)
  const dir = await mkTempRoot("crew-join-local-")
  spawnSync("git", ["init", "-q", "-b", "main", dir])
  await fs.mkdir(path.join(dir, "desks", "_template"), { recursive: true })
  await fs.writeFile(path.join(dir, "desks", "_template", "AGENTS.md"), "x")
  git(dir, ["-c", "user.email=m@example.com", "-c", "user.name=M", "add", "-A"])
  git(dir, ["-c", "user.email=m@example.com", "-c", "user.name=M", "commit", "-qm", "seed"])
  const local = await joinWorkspace({ repo: dir, identity: "a_example", alias: "a", apply: true })
  assert.equal(local.state, "refused")
  assert.match(local.message, /has no origin with a default branch to push the desk to/u)
  assert.deepEqual(readCrewRoster(dir), null)
})

test("a monorepo with a declared plugin path is named in the AGENTS.md section", async () => {
  const repo = await teamRepo({ "README.md": "# New\n", "plugins/team/plugin.json": "{}\n" })
  const { gh } = fakeGh(repo.bare)
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh, wait: noWait, now: NOW, apply: true, tooling: { path: "plugins/team", plugin: "team" } })
  assert.equal(result.state, "published", result.message)
  assert.equal(result.setup, "monorepo")
  assert.match(onMain(repo.bare, "AGENTS.md"), /- \*\*Team tooling\*\*: the team's plugin is in `plugins\/team\/`\./u)
})

test("text added to files with Windows line endings keeps them: the AGENTS.md section and the roster row", async () => {
  const repo = await teamRepo({ "AGENTS.md": "# Rules\r\n\r\nLine.\r\n", "README.md": "# Team\r\n" })
  const started = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true })
  assert.equal(started.state, "published", started.message)
  const agents = onMain(repo.bare, "AGENTS.md")
  assert.ok(agents.startsWith("# Rules\r\n\r\nLine.\r\n\r\n## Crew workspace\r\n"))
  assert.equal(/(?<!\r)\n/u.test(agents), false, "no line ends with a bare LF")
  const crlf = await teamRepo({ "desks/_template/AGENTS.md": "# {{alias}}\n", "_meta/desks.md": "# Desks\r\n\r\n| alias | identity |\r\n|---|---|\r\n| pat | pat_example |\r\n\r\nAfter.\r\n" })
  const joined = await joinWorkspace({ repo: crlf.clone, spawnGit: crlf.spawnGit, gh: fakeGh(crlf.bare).gh, identity: "a_example", alias: "a", apply: true, wait: noWait, now: NOW })
  assert.equal(joined.state, "joined", joined.message)
  assert.equal(onMain(crlf.bare, "_meta/desks.md"), "# Desks\r\n\r\n| alias | identity |\r\n|---|---|\r\n| pat | pat_example |\r\n| a | a_example |\r\n\r\nAfter.\r\n")
  const noTable = await teamRepo({ "desks/_template/AGENTS.md": "# {{alias}}\n", "_meta/desks.md": "# Desks\r\n\r\nNo table yet\r\n\r\n" })
  const first = await joinWorkspace({ repo: noTable.clone, spawnGit: noTable.spawnGit, gh: fakeGh(noTable.bare).gh, identity: "a_example", alias: "a", apply: true, wait: noWait, now: NOW })
  assert.equal(first.state, "joined", first.message)
  assert.equal(/(?<!\r)\n/u.test(onMain(noTable.bare, "_meta/desks.md")), false)
})
