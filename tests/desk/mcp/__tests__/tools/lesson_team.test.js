// lesson_add team: the tool writes the lesson into the team repository's root AGENTS.md itself, through a pull request it
// merges, and says what happened. Git runs for real against a local bare repository that stands in for GitHub (Git rewrites
// https://github.com/acme/cit.git to it, and the clone's origin is never used); `gh` and the account choice are fakes
// that act on that repository.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { addTeamLesson } from "../../../../../plugins/desk/mcp/src/tools/lesson-team.js"
import { AGENTS_MD_CAP_BYTES } from "../../../../../plugins/desk/mcp/src/runtime/agents-md.js"
import { mkTempDeskRoot } from "./_helpers.js"

const DAY = /\d{4}-\d{2}-\d{2}/u.source
const URL = "https://github.com/acme/cit"
const PR = `${URL}/pull/7`

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

// A bare "GitHub" repository holding `files` on main, and a clone of it whose origin reads as `origin`. Only the tool's
// own route, https://github.com/acme/cit.git, reaches the bare repository: the origin itself leads nowhere.
async function team(files = { "AGENTS.md": "# Team\n" }, { userName = "Ari Mendelow", origin = URL } = {}) {
  const base = await mkTempDeskRoot()
  const bare = path.join(base, "origin.git")
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  const seed = path.join(base, "seed")
  spawnSync("git", ["init", "-q", "-b", "main", seed])
  git(seed, ["config", "user.email", "t@example.com"])
  git(seed, ["config", "user.name", "Seed"])
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(seed, name)), { recursive: true })
    await fs.writeFile(path.join(seed, name), content, "utf8")
  }
  git(seed, ["add", "-A"])
  git(seed, ["commit", "-q", "-m", "seed"])
  git(seed, ["push", "-q", bare, "main"])
  const clone = path.join(base, "clone")
  spawnSync("git", ["clone", "-q", bare, clone])
  git(clone, ["config", "user.email", "t@example.com"])
  if (userName !== null) git(clone, ["config", "user.name", userName])
  git(clone, ["remote", "set-url", "origin", origin])
  git(clone, ["config", `url.${bare}.insteadOf`, `${URL}.git`])
  return { base, bare, seed, clone }
}

const onMain = (bare, file = "AGENTS.md") => spawnSync("git", ["--git-dir", bare, "show", `main:${file}`], { encoding: "utf8" }).stdout
const lessonBranches = (bare) => spawnSync("git", ["--git-dir", bare, "branch", "--list", "lesson/*"], { encoding: "utf8" }).stdout.trim()

// A fake `gh` that opens and merges pull requests on the bare repository. `merge(state)` decides each merge: by default a
// branch that contains main is fast-forwarded into it, and one that does not is a conflict. `parents` names the repository
// a fork was made from.
function fakeGh(bare, { token = "tok", base = "main", create = { code: 0 }, merge, view, parents = {} } = {}) {
  const calls = []
  const state = { head: null, merged: false, merges: 0, closed: false }
  const gh = async (args, options = {}) => {
    calls.push({ args, token: options.token })
    const [a, b] = args
    if (a === "auth" && b === "token") return token === "" ? { code: 1 } : { code: 0, stdout: `${token}\n` }
    if (a === "api") return base === "" ? { code: 1, stdout: "" } : { code: 0, stdout: `${JSON.stringify({ base, parent: parents[b.replace(/^repos\//u, "")] ?? null })}\n` }
    if (a === "pr" && b === "close") {
      state.closed = true
      return { code: 0 }
    }
    if (a === "pr" && b === "create") {
      state.head = args[args.indexOf("--head") + 1]
      if (create.stdout !== undefined) return create
      return create.code === 0 ? { code: 0, stdout: `Creating pull request\n${PR}\n` } : { code: 1, stdout: "", stderr: "GraphQL: no permission\nmore" }
    }
    if (a === "pr" && b === "merge") {
      state.merges += 1
      if (merge !== undefined) return merge(state)
      const ok = spawnSync("git", ["--git-dir", bare, "merge-base", "--is-ancestor", "main", state.head]).status === 0
      if (ok) {
        spawnSync("git", ["--git-dir", bare, "update-ref", "refs/heads/main", `refs/heads/${state.head}`])
        state.merged = true
      }
      return { code: ok ? 0 : 1, stdout: "", stderr: ok ? "" : "not mergeable" }
    }
    if (a === "pr" && b === "view") {
      if (view !== undefined) return view(state)
      const oid = spawnSync("git", ["--git-dir", bare, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim()
      return { code: 0, stdout: JSON.stringify(state.merged ? { state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", mergeCommit: { oid } } : { state: "OPEN", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", mergeCommit: null }) }
    }
    throw new Error(`unexpected gh ${args.join(" ")}`)
  }
  return { gh, calls, state }
}

const direct = async () => ({ result: "account_found", account: "arimendelow", route: "direct" })
const lesson = (extra) => ({ person: null, topic: "Build what was asked", body: "When someone asks for a List, build a List.", source: "Ari in the CIT channel, 2026-10-26", chooseAccount: direct, wait: async () => {}, ...extra })

test("team lesson in a repository that is not a desk: written, merged and said to be in effect", async () => {
  const repo = await team()
  const { gh, calls } = fakeGh(repo.bare)
  const desk = await mkTempDeskRoot()
  const result = await addTeamLesson(lesson({ deskRoot: desk, repo: repo.clone, gh }))
  assert.equal(result.status, "merged")
  assert.equal(result.in_effect, true)
  assert.equal(result.repo, "acme/cit")
  assert.equal(result.pr, PR)
  assert.equal(result.account, "arimendelow")
  assert.equal(result.commit, git(repo.bare, ["rev-parse", "main"]))
  assert.equal(result.claude_code_loads, false)
  assert.match(result.line, new RegExp(`^- \\*\\*Build what was asked\\.\\*\\* When someone asks for a List, build a List\\. \\(Ari Mendelow, ${DAY}; Ari in the CIT channel, 2026-10-26\\)$`, "u"))
  assert.match(result.message, /^In effect: merged in https:\/\/github\.com\/acme\/cit\/pull\/7\. Copilot CLI and Codex load it in acme\/cit; Claude Code does not, because this repository's CLAUDE\.md does not import AGENTS\.md/u)
  assert.equal(onMain(repo.bare), `# Team\n\n## Lessons\n\n${result.line}\n`)
  // Every gh call after the account choice used that account's token.
  assert.deepEqual([...new Set(calls.slice(1).map((call) => call.token))], ["tok"])
  // The clone's own checkout, branches and worktrees are as they were; the pushed branch is gone.
  assert.equal(git(repo.clone, ["status", "--short"]), "")
  assert.equal(git(repo.clone, ["worktree", "list"]).split("\n").length, 1)
  assert.deepEqual(git(repo.clone, ["branch", "--format=%(refname:short)"]).split("\n"), ["main"])
  assert.equal(lessonBranches(repo.bare), "")
})

test("team lesson goes to github.com with the chosen account even when the clone's origin is an SSH address", async () => {
  const repo = await team(undefined, { origin: "git@github.com:acme/cit.git" })
  const accounts = []
  const chooseAccount = async ({ store }) => (accounts.push(store), direct())
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fakeGh(repo.bare).gh, chooseAccount }))
  assert.deepEqual([result.status, result.repo, accounts], ["merged", "acme/cit", ["acme/cit"]])
  assert.match(onMain(repo.bare), /Build what was asked/u)
})

test("team lesson from a fork goes to the repository it was forked from, with an account that can push there", async () => {
  const repo = await team(undefined, { origin: "https://github.com/me/cit" })
  const accounts = []
  const chooseAccount = async ({ store }) => (accounts.push(store), direct())
  const fake = fakeGh(repo.bare, { parents: { "me/cit": "acme/cit" } })
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fake.gh, chooseAccount }))
  assert.deepEqual([result.status, result.repo, accounts], ["merged", "acme/cit", ["me/cit", "acme/cit"]])
  const create = fake.calls.find((call) => call.args[1] === "create").args
  assert.equal(create[create.indexOf("--repo") + 1], "acme/cit")
})

test("team lesson already on the default branch is in effect, with no pull request", async () => {
  const repo = await team()
  await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fakeGh(repo.bare).gh }))
  const fake = fakeGh(repo.bare)
  const again = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fake.gh }))
  assert.deepEqual([again.status, again.in_effect, again.pr], ["unchanged", true, undefined])
  assert.match(again.message, /^Already in effect: the default branch of acme\/cit holds this exact line\. Copilot CLI and Codex load it/u)
  assert.equal(fake.calls.some((call) => call.args[1] === "create"), false)
})

test("team lesson closes its pull request when someone else merged the same line first", async () => {
  const repo = await team()
  const fake = fakeGh(repo.bare)
  let line
  const gh = async (args, options) => {
    if (args[0] === "pr" && args[1] === "create") line = args[args.length - 1].split("\n").pop()
    if (args[0] === "pr" && args[1] === "merge" && fake.state.merges === 0) {
      await fs.writeFile(path.join(repo.seed, "AGENTS.md"), `# Team\n\n## Lessons\n\n${line}\n`, "utf8")
      git(repo.seed, ["commit", "-q", "-am", "teammate"])
      git(repo.seed, ["push", "-q", repo.bare, "main"])
    }
    return fake.gh(args, options)
  }
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh }))
  assert.deepEqual([result.status, result.in_effect, result.pr, fake.state.closed], ["unchanged", true, undefined, true])
  assert.equal(lessonBranches(repo.bare), "")
})

test("team lesson says Claude Code loads it when the repository's CLAUDE.md imports AGENTS.md or links to it", async () => {
  const imported = await team({ "AGENTS.md": "# Team\n", "CLAUDE.md": "# Claude\n\n@AGENTS.md\n" })
  const one = await addTeamLesson(lesson({ deskRoot: imported.base, repo: imported.clone, gh: fakeGh(imported.bare).gh }))
  assert.equal(one.claude_code_loads, true)
  assert.match(one.message, /, and Claude Code does too, through CLAUDE\.md, from each session that starts after the merge\.$/u)
  const linked = await team()
  await fs.symlink("AGENTS.md", path.join(linked.seed, "CLAUDE.md")).catch(() => {})
  git(linked.seed, ["add", "-A"])
  git(linked.seed, ["commit", "-q", "-m", "link"])
  git(linked.seed, ["push", "-q", linked.bare, "main"])
  const two = await addTeamLesson(lesson({ deskRoot: linked.base, repo: linked.clone, gh: fakeGh(linked.bare).gh }))
  assert.equal(two.claude_code_loads, process.platform !== "win32" || two.claude_code_loads)
})

test("team lesson starts AGENTS.md in a repository that has none", async () => {
  const repo = await team({ "README.md": "hi\n" })
  const tmpRoot = path.join(repo.base, "tmp")
  await fs.mkdir(tmpRoot)
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fakeGh(repo.bare).gh, tmpRoot }))
  assert.equal(result.status, "merged")
  assert.equal(onMain(repo.bare), `## Lessons\n\n${result.line}\n`)
  assert.deepEqual(await fs.readdir(tmpRoot), [], "the temporary worktree is gone")
})

test("team lesson replaces the topic's old line and names it", async () => {
  const repo = await team({ "AGENTS.md": "# Team\n\n## Lessons\n\n- **Build what was asked.** Old. (bo, 2026-01-01; Bo, 2026-01-01)\n" })
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fakeGh(repo.bare).gh }))
  assert.equal(result.replaces, "- **Build what was asked.** Old. (bo, 2026-01-01; Bo, 2026-01-01)")
  assert.equal(onMain(repo.bare).includes("Old."), false)
})

test("team lesson rebuilds on the new default branch when someone else changed it first, then merges", async () => {
  const repo = await team()
  let moved = false
  const fake = fakeGh(repo.bare)
  const gh = async (args, options) => {
    // Just before the first merge, a teammate's change lands on main.
    if (args[0] === "pr" && args[1] === "merge" && !moved) {
      moved = true
      await fs.writeFile(path.join(repo.seed, "README.md"), "hi\n", "utf8")
      git(repo.seed, ["add", "README.md"])
      git(repo.seed, ["commit", "-q", "-m", "teammate"])
      git(repo.seed, ["push", "-q", repo.bare, "main"])
    }
    return fake.gh(args, options)
  }
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh }))
  assert.equal(result.status, "merged")
  assert.equal(fake.state.merges, 2)
  assert.equal(onMain(repo.bare, "README.md"), "hi\n")
  assert.match(onMain(repo.bare), /Build what was asked/u)
})

test("team lesson leaves the pull request open, not in effect, when it cannot merge now", async () => {
  const repo = await team()
  const blocked = fakeGh(repo.bare, { merge: () => ({ code: 1 }), view: () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }) }) })
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: blocked.gh }))
  assert.equal(result.status, "pr_open")
  assert.equal(result.in_effect, false)
  assert.equal(result.reason, "BLOCKED")
  assert.equal(result.message, `Not in effect: the pull request ${PR} is open on branch ${result.branch} and has not merged (BLOCKED). It takes effect when it merges.`)
  assert.equal(blocked.state.merges, 1)
  // The open pull request keeps its branch.
  assert.equal(lessonBranches(repo.bare), result.branch)
  // Conflicts every time: three tries, then the pull request is left open.
  const dirty = fakeGh(repo.bare, { merge: () => ({ code: 1 }) })
  const again = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: dirty.gh }))
  assert.equal(again.status, "pr_open")
  assert.equal(again.reason, "DIRTY")
  assert.equal(dirty.state.merges, 3)
  // gh answers nothing readable about the pull request.
  const silent = fakeGh(repo.bare, { merge: () => ({ code: 1 }), view: () => ({ code: 1, stdout: "" }) })
  const unknown = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: silent.gh }))
  assert.equal(unknown.reason, "unknown")
})

test("team lesson counts a merge command that only queued the pull request as open, not merged", async () => {
  const repo = await team()
  const waits = []
  const open = { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }
  const queued = fakeGh(repo.bare, { merge: () => ({ code: 0 }), view: () => ({ code: 0, stdout: JSON.stringify(open) }) })
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: queued.gh, wait: async (ms) => waits.push(ms) }))
  assert.deepEqual([result.status, result.in_effect, result.reason, result.commit], ["pr_open", false, "QUEUED", undefined])
  assert.match(result.message, /has not merged \(it is queued to merge\)/u)
  assert.deepEqual(waits, [2000, 2000, 2000, 2000, 2000])
  assert.equal(lessonBranches(repo.bare), result.branch)
  // Queued, then merged a moment later: merged.
  const views = [open, open, { state: "MERGED", mergeCommit: { oid: "abc" } }]
  const later = fakeGh(repo.bare, { merge: () => ({ code: 0 }), view: () => ({ code: 0, stdout: JSON.stringify(views.shift()) }) })
  const merged = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: later.gh, topic: "Another" }))
  assert.deepEqual([merged.status, merged.commit, merged.branch], ["merged", "abc", undefined])
})

test("team lesson waits while GitHub is still working out whether it can merge", async () => {
  const repo = await team()
  const views = [{ state: "OPEN", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, { state: "MERGED", mergeCommit: null }]
  const fake = fakeGh(repo.bare, { merge: (state) => ({ code: state.merges === 1 ? 1 : 0 }), view: () => ({ code: 0, stdout: JSON.stringify(views.shift()) }) })
  // The real wait, once: two seconds.
  const result = await addTeamLesson({ ...lesson({ deskRoot: repo.base, repo: repo.clone, gh: fake.gh }), wait: undefined })
  assert.equal(result.status, "merged")
  assert.equal(result.commit, null)
})

test("team lesson reports where the remote work stopped, with nothing claimed in effect", async () => {
  const repo = await team()
  const run = (extra) => addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fakeGh(repo.bare).gh, ...extra }))
  const none = await run({ chooseAccount: async () => ({ result: "no_account_can_deliver" }) })
  assert.deepEqual([none.status, none.stage, none.in_effect], ["failed", "account", false])
  assert.match(none.reason, /no signed-in GitHub account can push to acme\/cit \(no_account_can_deliver\)/u)
  const fork = await run({ chooseAccount: async () => ({ result: "account_found", account: "x", route: "fork" }) })
  assert.match(fork.reason, /only through a fork/u)
  const noToken = await run({ gh: fakeGh(repo.bare, { token: "" }).gh })
  assert.match(noToken.reason, /gh has no token for arimendelow/u)
  const noBase = await run({ gh: fakeGh(repo.bare, { base: "" }).gh })
  assert.equal(noBase.stage, "default_branch")
  const noPr = await run({ gh: fakeGh(repo.bare, { create: { code: 1 } }).gh })
  assert.deepEqual([noPr.stage, noPr.reason], ["pull_request", "could not open the pull request: GraphQL: no permission"])
  assert.equal(noPr.message, "Not in effect: the team write stopped at pull_request (could not open the pull request: GraphQL: no permission).")
  // No branch is left behind for a pull request that never opened.
  assert.equal(lessonBranches(repo.bare), "")
  const noUrl = await run({ gh: fakeGh(repo.bare, { create: { code: 0, stdout: "something else" } }).gh })
  assert.deepEqual([noUrl.stage, noUrl.reason], ["pull_request", "could not open the pull request: "])
  const noFetch = await run({ gh: fakeGh(repo.bare, { base: "no-such-branch" }).gh })
  assert.equal(noFetch.stage, "fetch")
  assert.match(noFetch.reason, /no-such-branch/u)
  // A merge that fails after the pull request opened names the open pull request.
  const late = fakeGh(repo.bare, { merge: () => { throw new Error("gh crashed") } })
  await assert.rejects(() => run({ gh: late.gh }), /gh crashed/u)
  assert.equal(git(repo.clone, ["worktree", "list"]).split("\n").length, 1)
})

test("team lesson failure after the pull request opened says the pull request is open", async () => {
  const repo = await team()
  const fake = fakeGh(repo.bare, { merge: () => ({ code: 1 }) })
  let calls = 0
  // The rebuild after a conflict fails: the push is refused.
  const spawnGit = (cmd, args, options) => (args.includes("push") && args.includes("--force") && (calls += 1) === 2 ? { status: 1, stdout: "", stderr: "remote: denied" } : spawnSync(cmd, args, options))
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fake.gh, spawnGit }))
  assert.equal(result.status, "failed")
  assert.equal(result.stage, "push")
  assert.equal(result.message, `Not in effect: the team write stopped at push (the push was refused: remote: denied). The pull request ${PR} is open, on branch ${result.branch}.`)
  // A commit hook or signing that refuses is reported as such, never skipped.
  const silent = (cmd, args, options) => (args.includes("commit") ? { status: 1 } : spawnSync(cmd, args, options))
  const noCommit = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fake.gh, spawnGit: silent }))
  assert.deepEqual([noCommit.stage, noCommit.reason], ["commit", "the commit was refused (this repository's commit hooks or signing): commit failed"])
})

test("team lesson refuses a change that would pass the AGENTS.md size session start prints", async () => {
  const big = "x".repeat(AGENTS_MD_CAP_BYTES)
  const repo = await team({ "AGENTS.md": big })
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fakeGh(repo.bare).gh }))
  assert.deepEqual([result.status, result.stage, result.in_effect], ["failed", "size", false])
  assert.match(result.reason, /after the first 16 KB/u)
  assert.equal(git(repo.clone, ["worktree", "list"]).split("\n").length, 1)
  // When the default branch grows past the size while the pull request is open, the reply names the open pull request.
  const late = await team()
  const fake = fakeGh(late.bare)
  const gh = async (args, options) => {
    if (args[0] === "pr" && args[1] === "merge" && fake.state.merges === 0) {
      await fs.writeFile(path.join(late.seed, "AGENTS.md"), big, "utf8")
      git(late.seed, ["commit", "-q", "-am", "teammate"])
      git(late.seed, ["push", "-q", late.bare, "main"])
    }
    return fake.gh(args, options)
  }
  const grown = await addTeamLesson(lesson({ deskRoot: late.base, repo: late.clone, gh }))
  assert.deepEqual([grown.stage, grown.pr], ["size", PR])
  assert.match(grown.message, new RegExp(`The pull request ${PR} is open, on branch lesson/`, "u"))
})

test("team lesson in a repository with decision records cites one", async () => {
  const repo = await team({ "AGENTS.md": "# Team\n", "_shared/decisions/2026-10-20-lists.md": "# Lists\n" })
  const run = (source) => addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fakeGh(repo.bare).gh, source }))
  // A decision recorded only in this clone, not yet merged, is not the team's decision.
  await fs.writeFile(path.join(repo.clone, "_shared", "decisions", "2026-10-26-local.md"), "# Local\n", "utf8")
  for (const source of ["Ari, 2026-10-26", "_shared/decisions/missing.md", "_shared/decisions/../../AGENTS.md", "_shared/decisions", "_shared/decisions/2026-10-26-local.md"]) {
    const refused = await run(source)
    assert.deepEqual([refused.status, refused.stage], ["failed", "source"], source)
    assert.match(refused.reason, /_shared\/decisions\/ on its default branch/u)
  }
  const result = await run("_shared/decisions/2026-10-20-lists.md")
  assert.match(result.line, /; _shared\/decisions\/2026-10-20-lists\.md\)$/u)
  assert.equal(result.status, "merged")
})

test("team lesson checks its input before any remote work", async () => {
  const repo = await team()
  const desk = await mkTempDeskRoot()
  const gh = async () => assert.fail("no gh call")
  const run = (extra) => addTeamLesson(lesson({ deskRoot: desk, repo: repo.clone, gh, ...extra }))
  await assert.rejects(() => run({ repo: undefined }), /needs `repo`/u)
  // With nothing injected, the real gh runner and account choice are only set up: input is checked first.
  await assert.rejects(() => addTeamLesson({ deskRoot: desk, topic: "Rule", body: "Do it." }), /needs `repo`/u)
  await assert.rejects(() => run({ repo: desk }), /not a Git clone/u)
  await assert.rejects(() => run({ source: undefined }), /`source` is required/u)
  const local = await team()
  git(local.clone, ["remote", "set-url", "origin", local.bare])
  await assert.rejects(() => run({ repo: local.clone }), /origin is not on GitHub/u)
  git(local.clone, ["remote", "remove", "origin"])
  await assert.rejects(() => run({ repo: local.clone }), /origin is not on GitHub/u)
  const nameless = await team(undefined, { userName: null })
  await assert.rejects(() => run({ repo: nameless.clone, person: "" }), /no person and the clone has no Git user name/u)
  // A subfolder of the clone is the clone.
  await fs.mkdir(path.join(repo.clone, "sub"))
  const sub = await addTeamLesson(lesson({ deskRoot: desk, repo: path.join(repo.clone, "sub"), person: "ari", gh: fakeGh(repo.bare).gh }))
  assert.match(sub.line, /\(ari, /u)
})

test("team lesson without decision records needs a source with a date", async () => {
  const repo = await team()
  const result = await addTeamLesson(lesson({ deskRoot: repo.base, repo: repo.clone, gh: fakeGh(repo.bare).gh, source: "Ari said so" }))
  assert.deepEqual([result.status, result.stage], ["failed", "source"])
  assert.match(result.reason, /YYYY-MM-DD/u)
})

test("team lesson in a Crew shared workspace defaults to the desk itself and needs a person", async () => {
  const repo = await team({ "AGENTS.md": "# Crew\n", "_meta/desks.md": "| alias | identity |\n| --- | --- |\n| ari | ari@example.com |\n", "desks/ari/AGENTS.md": "# Ari\n", "_shared/decisions/2026-10-20-lists.md": "# Lists\n" })
  await assert.rejects(() => addTeamLesson(lesson({ deskRoot: repo.clone, gh: fakeGh(repo.bare).gh })), /shared workspace is attributed to its person/u)
  const result = await addTeamLesson(lesson({ deskRoot: repo.clone, person: "ari", source: "_shared/decisions/2026-10-20-lists.md", gh: fakeGh(repo.bare).gh }))
  assert.equal(result.status, "merged")
  assert.equal(result.claude_code_loads, true)
  assert.match(result.message, /every teammate's Desk session start prints it, from each session/u)
  assert.match(onMain(repo.bare), /\(ari, \d{4}-\d{2}-\d{2}; _shared\/decisions\/2026-10-20-lists\.md\)/u)
})
