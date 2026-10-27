// crew.js start: give a new or existing repository Crew's shape in one step, as a monorepo (the team's plugin in its own
// plugins/ folder) or a dual-repo workspace (the plugin in a separate tooling repository). A plan comes first and changes
// nothing; `apply` writes, commits and lands the change through a pull request merged at once. Starting deletes, moves
// and overwrites nothing: existing files stay byte-identical, and the root AGENTS.md only gains a section at its end.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { CIT_SHAPED, PR, branches, fakeGh, git, mainFiles, noWait, onMain, pushFromElsewhere, teamRepo, toBare } from "./_fixtures.js"
import { crewStatus, startWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { crewWorkspace, readCrewRoster } from "../../../../../plugins/desk/mcp/src/desk/crew-roster.js"

const NOW = () => 1767225600000
const TOOLING = { repo: "acme/team-tooling", path: "plugins/team", plugin: "team" }
const startCit = (repo, extra = {}) => ({ repo: repo.clone, spawnGit: repo.spawnGit, tooling: TOOLING, wait: noWait, now: NOW, ...extra })

const bytes = (bare, file) => spawnSync("git", ["--git-dir", bare, "show", `main:${file}`]).stdout

test("start on an existing team repository: the plan lists what it adds and the folders outside Crew's shape, and writes nothing", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const before = git(repo.clone, ["rev-parse", "HEAD"])
  const plan = await startWorkspace(startCit(repo))
  assert.equal(plan.state, "plan")
  assert.equal(plan.setup, "dual-repo")
  assert.deepEqual(plan.changes, [
    { path: "AGENTS.md", change: "append" },
    { path: "_meta/crew.json", change: "add" },
    { path: "_meta/desks.md", change: "add" },
    { path: "_shared/decisions/README.md", change: "add" },
    { path: "_shared/landscape/README.md", change: "add" },
    { path: "desks/_template/AGENTS.md", change: "add" },
    { path: "desks/_template/README.md", change: "add" },
    { path: "desks/_template/_meta/friction.md", change: "add" },
  ])
  assert.deepEqual(plan.outside, ["context/", "guides/", "team/"])
  assert.equal(plan.declaration.shared_writes.merge_workflow, ".github/workflows/merge-agent-prs.yml")
  assert.equal(plan.message, "Plan only: nothing was written. Starting a dual-repo crew adds 7 files and appends a section to AGENTS.md. These top-level folders are outside Crew's shape, and nothing in them is moved: context/, guides/, team/. Move their content into the shape with the team afterwards. Run again with --apply to make the change.")
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), before)
})

test("start a CIT-shaped repository as a dual-repo workspace: a merged pull request, every existing file byte-identical", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const { gh, calls } = fakeGh(repo.bare)
  const before = new Map(Object.keys(CIT_SHAPED).map((file) => [file, bytes(repo.bare, file)]))
  const result = await startWorkspace(startCit(repo, { apply: true, gh }))
  assert.equal(result.state, "published", result.message)
  assert.equal(result.pr, PR)
  assert.equal(result.commit, git(repo.bare, ["rev-parse", "main"]))
  assert.match(result.message, /^Started: this repository is now a dual-repo Crew workspace\. The change merged in https:\/\/github\.com\/acme\/team\/pull\/12\./u)
  // Nothing that was there moved or changed, except AGENTS.md, which only grew at its end.
  for (const [file, content] of before) {
    if (file === "AGENTS.md") continue
    assert.ok(bytes(repo.bare, file).equals(content), `${file} must be byte-identical`)
  }
  const agents = onMain(repo.bare, "AGENTS.md")
  assert.ok(agents.startsWith(CIT_SHAPED["AGENTS.md"]), "the team's AGENTS.md text stays intact")
  const section = agents.slice(CIT_SHAPED["AGENTS.md"].length)
  assert.match(section, /^\n## Crew workspace\n/u)
  assert.match(section, /\*\*Team facts\*\* go in `_shared\/landscape\/`/u)
  assert.match(section, /\*\*Agreed team decisions\*\* go in `_shared\/decisions\/`/u)
  assert.match(section, /separate \[acme\/team-tooling\]\(https:\/\/github\.com\/acme\/team-tooling\) repository/u)
  assert.match(section, /\.github\/workflows\/merge-agent-prs\.yml/u)
  assert.match(section, /\*\*Not yet in Crew's shape\*\*: `context\/`, `guides\/`, `team\/`\./u)
  assert.match(section, /join-crew/u)
  const files = mainFiles(repo.bare)
  for (const added of ["_shared/landscape/README.md", "_shared/decisions/README.md", "desks/_template/_meta/friction.md", "_meta/desks.md"]) assert.ok(files.includes(added), added)
  assert.equal(files.some((file) => file.startsWith("plugins/")), false)
  assert.deepEqual(JSON.parse(onMain(repo.bare, "_meta/crew.json")), {
    schema_version: 1,
    tooling: { repo: "acme/team-tooling", path: "plugins/team", plugin: "team" },
    shared_writes: { merge_workflow: ".github/workflows/merge-agent-prs.yml" },
  })
  // The clone is on main at the merged commit, clean, with no leftover branch here or on "GitHub".
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal(git(repo.clone, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), result.commit)
  assert.deepEqual(branches(repo.bare), ["main"])
  assert.equal(git(repo.clone, ["branch", "--list", "crew/*"]), "")
  // Desk sees a Crew workspace with no member yet; status reports the setup and how to install the team's plugin.
  assert.deepEqual(crewWorkspace(repo.clone), { crew: true, roster: [] })
  const status = await crewStatus({ repo: repo.clone })
  assert.equal(status.setup, "dual-repo")
  assert.equal(status.tooling.install.copilot, "agency plugin install github:acme/team-tooling:plugins/team@main --engine copilot")
  const created = calls.find((args) => args[0] === "pr" && args[1] === "create")
  assert.deepEqual(created.slice(0, 8), ["pr", "create", "--repo", "acme/team", "--base", "main", "--head", "crew/start-mjuohs00"])
  // Running it again changes nothing.
  const again = await startWorkspace(startCit(repo, { apply: true, gh }))
  assert.equal(again.state, "already_crew")
  assert.match(again.message, /already a Crew workspace/u)
})

test("start with a founder: the founder's desk and roster row land in the same change", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const { gh } = fakeGh(repo.bare)
  const result = await startWorkspace(startCit(repo, { apply: true, gh, founder: { alias: "test-founder", identity: "test-founder-placeholder" } }))
  assert.equal(result.state, "published", result.message)
  assert.deepEqual(readCrewRoster(repo.clone), [{ alias: "test-founder", identity: "test-founder-placeholder" }])
  assert.match(onMain(repo.bare, "_meta/desks.md"), /\| test-founder \| test-founder-placeholder \| desks\/test-founder \| acme\/team \| crew \| desks\/test-founder \|/u)
  assert.equal(onMain(repo.bare, "desks/test-founder/AGENTS.md"), onMain(repo.bare, "desks/_template/AGENTS.md").replaceAll("{{alias}}", "test-founder"))
  assert.ok(mainFiles(repo.bare).includes("desks/test-founder/_meta/friction.md"))
})

test("start a monorepo: its plugins/ folder is part of the shape, and the plugin is named and found", async () => {
  const repo = await teamRepo({ "README.md": "# Mono\n", "plugins/team/plugin.json": "{\"name\":\"team\"}\n", "notes/idea.md": "Placeholder idea\n" })
  const { gh } = fakeGh(repo.bare)
  const plan = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, now: NOW })
  assert.equal(plan.setup, "monorepo")
  assert.deepEqual(plan.outside, ["notes/"])
  assert.match(plan.message, /^Plan only: nothing was written\. Starting a monorepo crew adds 8 files\./u)
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh, wait: noWait, now: NOW, apply: true })
  assert.equal(result.state, "published", result.message)
  assert.match(result.message, /now a monorepo Crew workspace/u)
  assert.deepEqual(JSON.parse(onMain(repo.bare, "_meta/crew.json")), { schema_version: 1 })
  assert.match(onMain(repo.bare, "AGENTS.md"), /\*\*Team tooling\*\*: the team's plugin is in `plugins\/team\/`\./u)
  const status = await crewStatus({ repo: repo.clone })
  assert.equal(status.setup, "monorepo")
  assert.equal(status.tooling.install.copilot, "agency plugin install github:acme/team:plugins/team@main --engine copilot")
})

test("start brings a clone that is behind up to date before writing", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  await pushFromElsewhere(repo, { "context/collection-gamma/notes.md": "Placeholder from a teammate\n" })
  const result = await startWorkspace(startCit(repo, { apply: true, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.state, "published", result.message)
  assert.ok(mainFiles(repo.bare).includes("context/collection-gamma/notes.md"))
  assert.ok(mainFiles(repo.bare).includes("_meta/crew.json"))
})

test("start: a new repository gets Crew's shape and a plain front page", async () => {
  const repo = await teamRepo({ "README.md": "# Fresh\n", ".gitignore": "node_modules\n" })
  const { gh } = fakeGh(repo.bare)
  const plan = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, team: "Placeholder Crew", now: NOW })
  assert.deepEqual(plan.changes.map((change) => change.path), ["AGENTS.md", "_meta/crew.json", "_meta/desks.md", "_shared/decisions/README.md", "_shared/landscape/README.md", "desks/_template/AGENTS.md", "desks/_template/README.md", "desks/_template/_meta/friction.md"])
  assert.equal(plan.changes[0].change, "add")
  assert.deepEqual(plan.outside, [])
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh, wait: noWait, now: NOW, apply: true, tooling: { repo: "acme/crew-tooling", path: "plugins/crew-tools", plugin: "crew-tools" } })
  assert.equal(result.state, "published", result.message)
  assert.equal(onMain(repo.bare, "README.md"), "# Fresh\n", "an existing README is kept")
  assert.deepEqual(JSON.parse(onMain(repo.bare, "_meta/crew.json")), { schema_version: 1, tooling: { repo: "acme/crew-tooling", path: "plugins/crew-tools", plugin: "crew-tools" } })
  assert.match(onMain(repo.bare, "AGENTS.md"), /^# Agents in this workspace\n/u)
  assert.doesNotMatch(onMain(repo.bare, "AGENTS.md"), /Not yet in Crew's shape/u)
})

test("start on an empty GitHub repository: the first commit is pushed, since there is nothing to merge into yet", async () => {
  const repo = await teamRepo({})
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, team: "Placeholder Crew", apply: true, now: NOW })
  assert.equal(result.state, "published", result.message)
  assert.match(result.message, /first commit was pushed straight to main/u)
  assert.match(onMain(repo.bare, "README.md"), /^# Placeholder Crew\n/u)
  assert.ok(mainFiles(repo.bare).includes("_shared/landscape/README.md"))
})

test("start on a local repository with no origin: committed, and the push is left to the agent", async () => {
  const dir = await mkTempRoot("crew-start-local-")
  spawnSync("git", ["init", "-q", "-b", "main", dir])
  git(dir, ["config", "user.email", "m@example.com"])
  git(dir, ["config", "user.name", "M"])
  const result = await startWorkspace({ repo: dir, apply: true, now: NOW })
  assert.equal(result.state, "committed", result.message)
  assert.match(result.message, /no origin/u)
  assert.equal(git(dir, ["status", "--porcelain"]), "")
  assert.match(await fs.readFile(path.join(dir, "README.md"), "utf8"), new RegExp(`^# ${path.basename(dir)}\\n`, "u"))
  assert.equal((await crewStatus({ repo: dir })).state, "crew")
})

test("start refuses what it cannot honor before writing anything, and never overwrites a file", async () => {
  const repo = await teamRepo({ ...CIT_SHAPED, "_shared/decisions/README.md": "Existing decisions index\n", "_shared/landscape/notes.md": "Existing facts\n" })
  const cases = [
    [{ tooling: { repo: "not a repo" } }, /tooling\.repo: "not a repo" is not owner\/name/u],
    [{ mergeWorkflow: "../outside.yml" }, /shared_writes\.merge_workflow: "\.\.\/outside\.yml" is not a file inside the repository/u],
    [{ founder: { alias: "Bad Alias", identity: "x" } }, /"Bad Alias" is not a valid alias/u],
    [{ founder: { alias: "ok", identity: "a|b" } }, /is not a valid identity/u],
  ]
  for (const [extra, reason] of cases) {
    const result = await startWorkspace(startCit(repo, { apply: true, ...extra }))
    assert.equal(result.state, "refused", JSON.stringify(extra))
    assert.match(result.message, reason)
  }
  // Existing _shared/decisions/ and _shared/landscape/ folders are kept as they are: nothing is added to them.
  const kept = await startWorkspace(startCit(repo))
  assert.equal(kept.changes.some((change) => change.path.startsWith("_shared/")), false)
  const taken = await teamRepo({ ...CIT_SHAPED, "_meta/crew.json": "{\"note\":\"someone else's\"}\n" })
  const refused = await startWorkspace(startCit(taken, { apply: true }))
  assert.equal(refused.state, "refused")
  assert.match(refused.message, /_meta\/crew\.json already exists, and starting a crew never overwrites a file/u)
  const registry = await teamRepo({ ...CIT_SHAPED, "_meta/desks.md": "# Routing\n\n| desk | path |\n|---|---|\n| a | b |\n" })
  assert.match((await startWorkspace(startCit(registry, { apply: true }))).message, /_meta\/desks\.md already exists/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("apply refuses a checkout it cannot safely write: dirty, off the default branch, or ahead of origin", async () => {
  const dirty = await teamRepo(CIT_SHAPED)
  await fs.writeFile(path.join(dirty.clone, "scratch.txt"), "x")
  assert.match((await startWorkspace(startCit(dirty, { apply: true }))).message, /has uncommitted changes/u)
  const side = await teamRepo(CIT_SHAPED)
  git(side.clone, ["switch", "-q", "-c", "topic"])
  assert.match((await startWorkspace(startCit(side, { apply: true }))).message, /is on topic, not the default branch main/u)
  const ahead = await teamRepo(CIT_SHAPED)
  git(ahead.clone, ["commit", "-q", "--allow-empty", "-m", "local only"])
  assert.match((await startWorkspace(startCit(ahead, { apply: true }))).message, /has commits that are not on origin\/main/u)
  const offline = await teamRepo(CIT_SHAPED)
  const result = await startWorkspace(startCit(offline, { apply: true, spawnGit: toBare(path.join(offline.base, "missing.git")) }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "fetch")
  assert.equal(git(offline.clone, ["status", "--porcelain"]), "")
})

test("a pull request that cannot merge stays open with its branch, and the clone goes back to main", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const { gh } = fakeGh(repo.bare, { merge: () => ({ code: 1, stderr: "Protected branch: review required" }), view: () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }) }) })
  const result = await startWorkspace(startCit(repo, { apply: true, gh }))
  assert.equal(result.state, "pr_open")
  assert.equal(result.branch, "crew/start-mjuohs00")
  assert.match(result.message, /^Not in effect yet: the pull request https:\/\/github\.com\/acme\/team\/pull\/12 is open on branch crew\/start-mjuohs00 and has not merged \(BLOCKED\)\. This repository's merge workflow is \.github\/workflows\/merge-agent-prs\.yml\./u)
  assert.ok(branches(repo.bare).includes("crew/start-mjuohs00"))
  assert.equal(git(repo.clone, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("a merge that only queues the pull request is reported as queued, not merged", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const { gh } = fakeGh(repo.bare, { merge: () => ({ code: 0 }), view: () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }) }) })
  const result = await startWorkspace(startCit(repo, { apply: true, gh }))
  assert.equal(result.state, "pr_open")
  assert.match(result.message, /it is queued to merge/u)
})

test("a conflict rebuilds the branch on the new main and merges; GitHub still working out mergeability is a wait", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  let views = 0
  const { gh, state } = fakeGh(repo.bare, {
    view: (current) => {
      views += 1
      if (current.merged) return { code: 0, stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: git(repo.bare, ["rev-parse", "main"]) } }) }
      return { code: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: views === 1 ? "UNKNOWN" : "CONFLICTING", mergeStateStatus: "DIRTY" }) }
    },
  })
  // A teammate lands a change after the branch is pushed, so the first merge cannot fast-forward.
  let created = false
  const racing = async (args) => {
    const answer = await gh(args)
    if (args[1] === "create" && !created) {
      created = true
      await pushFromElsewhere(repo, { "guides/new-guide.md": "Placeholder\n" })
    }
    return answer
  }
  const result = await startWorkspace(startCit(repo, { apply: true, gh: racing }))
  assert.equal(result.state, "published", result.message)
  assert.ok(state.merges >= 2)
  assert.ok(mainFiles(repo.bare).includes("guides/new-guide.md"))
  assert.ok(mainFiles(repo.bare).includes("_meta/crew.json"))
})

test("a pull request that cannot be opened is a failure, and its pushed branch is removed", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const { gh } = fakeGh(repo.bare, { create: { code: 1 } })
  const result = await startWorkspace(startCit(repo, { apply: true, gh }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "pull_request")
  assert.match(result.message, /^Not in effect: the shared write stopped at pull_request \(could not open the pull request: GraphQL: no permission\)\./u)
  assert.deepEqual(branches(repo.bare), ["main"])
  assert.equal(git(repo.clone, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("a pull request route needs an origin on GitHub", async () => {
  const repo = await teamRepo(CIT_SHAPED, { origin: "https://gitlab.example.com/acme/team.git" })
  const spawnGit = (cmd, args, options) => spawnSync(cmd, args, { ...options, env: { ...(options.env ?? process.env), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${repo.bare}.insteadOf`, GIT_CONFIG_VALUE_0: "https://gitlab.example.com/acme/team.git" } })
  const result = await startWorkspace(startCit(repo, { apply: true, spawnGit }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "pull_request")
  assert.match(result.message, /origin is not on GitHub/u)
})

test("a commit the repository's hooks refuse is reported, and the clone is put back", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  await fs.writeFile(path.join(repo.clone, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'policy says no' >&2\nexit 1\n", { mode: 0o755 })
  const result = await startWorkspace(startCit(repo, { apply: true, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "commit")
  assert.match(result.message, /policy says no/u)
  assert.equal(git(repo.clone, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("a folder that is not a Git clone is refused", async () => {
  const dir = await mkTempRoot("crew-setup-plain-")
  const result = await startWorkspace({ repo: dir })
  assert.equal(result.state, "refused")
  assert.match(result.message, /is not a Git clone/u)
})
