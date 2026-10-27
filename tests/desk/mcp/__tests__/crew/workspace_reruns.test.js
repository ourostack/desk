// crew.js run again after something went wrong, and run while teammates do the same. A failed start leaves no trace
// that could pass for a workspace; a start the clone holds but GitHub does not is pushed by the rerun; a pull request a
// run left open is reused, never doubled; and a rebuild after a teammate's change checks again who holds each alias,
// identity and desk, and never overwrites what a teammate added.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { appendFileSync, mkdirSync, promises as fs, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CIT_SHAPED, PR, branches, fakeGh, git, mainFiles, noWait, onMain, pushFromElsewhere, secondClone, teamRepo } from "./_fixtures.js"
import { crewStatus, joinWorkspace, startWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { readCrewRoster } from "../../../../../plugins/desk/mcp/src/desk/crew-roster.js"

const NOW = () => 1767225600000
const LATER = () => 1767225600999

function memberClone(repo, name = "member") {
  const clone = path.join(repo.base, name)
  spawnSync("git", ["clone", "-q", repo.bare, clone])
  git(clone, ["config", "user.email", "new@example.com"])
  git(clone, ["config", "user.name", "New Member"])
  git(clone, ["remote", "set-url", "origin", "https://github.com/acme/team.git"])
  return { ...repo, clone }
}

async function started() {
  const repo = await teamRepo(CIT_SHAPED)
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: { repo: "acme/team-tooling" }, founder: { alias: "test-founder", identity: "test-founder-placeholder" } })
  assert.equal(result.state, "published", result.message)
  return memberClone(repo)
}

const join = (repo, extra = {}) => ({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, identity: "newbie_example", alias: "newbie", wait: noWait, now: NOW, ...extra })

// A gh that lets `race` change "GitHub" right after the pull request opens, the way a teammate's merge would.
function racing(repo, race, options) {
  const fake = fakeGh(repo.bare, options)
  let done = false
  const gh = async (args, more) => {
    const answer = await fake.gh(args, more)
    if (args[0] === "pr" && args[1] === "create" && !done) {
      done = true
      await race()
    }
    return answer
  }
  return { ...fake, gh }
}

const rosterOnMain = (repo) => onMain(repo.bare, "_meta/desks.md")
const rows = (repo) => rosterOnMain(repo).split("\n").filter((line) => /^\| (?!alias|---)/u.test(line))

test("a first push to an empty repository that is refused takes the commit back, so a rerun starts again for real", async () => {
  const repo = await teamRepo({})
  const refuse = (cmd, args, options) => (args.includes("push") ? { status: 1, stdout: "", stderr: "remote: Permission denied" } : repo.spawnGit(cmd, args, options))
  const failed = await startWorkspace({ repo: repo.clone, spawnGit: refuse, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, founder: { alias: "first", identity: "first_example" } })
  assert.equal(failed.state, "failed")
  assert.equal(failed.stage, "push")
  // No commit, no file and no folder of Crew's is left: the clone is as empty as it was, and not a Crew workspace.
  assert.equal(spawnSync("git", ["-C", repo.clone, "rev-parse", "--verify", "--quiet", "HEAD"]).status, 1)
  assert.deepEqual((await fs.readdir(repo.clone)).filter((name) => name !== ".git"), [])
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal((await crewStatus({ repo: repo.clone })).state, "not_crew")
  const again = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, founder: { alias: "first", identity: "first_example" } })
  assert.equal(again.state, "published", again.message)
  assert.ok(mainFiles(repo.bare).includes("desks/first/AGENTS.md"))
})

test("a refused commit in a repository with history takes back only what the start wrote", async () => {
  const repo = await teamRepo({})
  await fs.writeFile(path.join(repo.clone, "notes.md"), "Placeholder\n")
  git(repo.clone, ["add", "notes.md"])
  git(repo.clone, ["commit", "-qm", "local history"])
  const before = git(repo.clone, ["rev-parse", "HEAD"])
  const refuse = (cmd, args, options) => (args.includes("commit") && !args.includes("local history") ? { status: 1, stdout: "", stderr: "hook says no" } : repo.spawnGit(cmd, args, options))
  const failed = await startWorkspace({ repo: repo.clone, spawnGit: refuse, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true })
  assert.equal(failed.stage, "commit")
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), before)
  assert.deepEqual((await fs.readdir(repo.clone)).filter((name) => name !== ".git").sort(), ["notes.md"])
})

test("a start the clone holds but GitHub does not, such as a local start given an origin later, is pushed by a rerun", async () => {
  const repo = await teamRepo({})
  git(repo.clone, ["remote", "remove", "origin"])
  const local = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, now: NOW, apply: true })
  assert.equal(local.state, "committed", local.message)
  assert.match(local.message, /add the team's GitHub repository as origin, then run start again to push it/u)
  git(repo.clone, ["remote", "add", "origin", "https://github.com/acme/team.git"])
  const plan = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, now: NOW })
  assert.equal(plan.state, "plan")
  assert.match(plan.message, /^Plan only: nothing was written\. This clone already holds a Crew workspace that is not on GitHub yet: its origin has no commits\. Run again with --apply to push it to main\.$/u)
  assert.deepEqual(mainFiles(repo.bare), [])
  // A rerun that cannot reach GitHub to see whether it has the start says so.
  const offline = await startWorkspace({ repo: repo.clone, spawnGit: (cmd, args, options) => (args.includes("ls-remote") ? { status: 128, stderr: "fatal: unable to access" } : repo.spawnGit(cmd, args, options)), gh: fakeGh(repo.bare).gh, now: NOW, apply: true })
  assert.equal(offline.state, "failed")
  assert.equal(offline.stage, "fetch")
  const pushed = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, now: NOW, apply: true })
  assert.equal(pushed.state, "published", pushed.message)
  assert.equal(git(repo.bare, ["rev-parse", "main"]), local.commit)
  // Once GitHub has it, a rerun has nothing to do.
  assert.equal((await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, now: NOW, apply: true })).state, "already_crew")
})

test("a rebuild appends to an AGENTS.md a teammate added meanwhile instead of replacing it", async () => {
  const files = { ...CIT_SHAPED }
  delete files["AGENTS.md"]
  const repo = await teamRepo(files)
  const { gh } = racing(repo, () => pushFromElsewhere(repo, { "AGENTS.md": "# Teammate's own agent rules\n\nKeep this line.\n" }))
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh, wait: noWait, now: NOW, apply: true, tooling: { repo: "acme/team-tooling" } })
  assert.equal(result.state, "published", result.message)
  assert.match(onMain(repo.bare, "AGENTS.md"), /^# Teammate's own agent rules\n\nKeep this line\.\n\n## Crew workspace\n/u)
})

test("start run again after it left a pull request open reuses that pull request and merges it", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  let blocked = true
  const fake = fakeGh(repo.bare, {
    merge: (state) => {
      if (blocked) return { code: 1, stdout: "", stderr: "Protected branch" }
      spawnSync("git", ["--git-dir", repo.bare, "update-ref", "refs/heads/main", `refs/heads/${state.head}`])
      state.merged = true
      return { code: 0, stdout: "", stderr: "" }
    },
    view: (state) => ({ code: 0, stdout: JSON.stringify(state.merged ? { state: "MERGED", mergeCommit: { oid: git(repo.bare, ["rev-parse", "main"]) } } : { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }) }),
  })
  const start = (now) => startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fake.gh, wait: noWait, now, apply: true, tooling: { repo: "acme/team-tooling" } })
  const first = await start(NOW)
  assert.equal(first.state, "pr_open")
  blocked = false
  const second = await start(LATER)
  assert.equal(second.state, "published", second.message)
  assert.equal(second.pr, PR)
  assert.equal(second.reused, true)
  assert.equal(fake.calls.filter((args) => args[0] === "pr" && args[1] === "create").length, 1)
  assert.deepEqual(branches(repo.bare), ["main"])
  assert.ok(mainFiles(repo.bare).includes("_meta/crew.json"))
})

test("a reused pull request that conflicts is rebuilt on its own branch", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  let blocked = true
  const fake = fakeGh(repo.bare, {
    merge: (state) => {
      if (blocked || spawnSync("git", ["--git-dir", repo.bare, "merge-base", "--is-ancestor", "main", state.head]).status !== 0) return { code: 1, stdout: "", stderr: "not mergeable" }
      spawnSync("git", ["--git-dir", repo.bare, "update-ref", "refs/heads/main", `refs/heads/${state.head}`])
      state.merged = true
      return { code: 0, stdout: "", stderr: "" }
    },
    view: (state) => ({ code: 0, stdout: JSON.stringify(state.merged ? { state: "MERGED", mergeCommit: { oid: git(repo.bare, ["rev-parse", "main"]) } } : blocked ? { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } : { state: "OPEN", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) }),
  })
  const start = (now) => startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fake.gh, wait: noWait, now, apply: true, tooling: { repo: "acme/team-tooling" } })
  assert.equal((await start(NOW)).state, "pr_open")
  await pushFromElsewhere(repo, { "guides/late.md": "Placeholder\n" })
  // The open pull request now conflicts; the rerun rebuilds it in place and merges it.
  blocked = false
  const second = await start(LATER)
  assert.equal(second.state, "published", second.message)
  assert.equal(fake.calls.filter((args) => args[1] === "create").length, 1)
  assert.ok(mainFiles(repo.bare).includes("guides/late.md"))
  assert.ok(mainFiles(repo.bare).includes("_meta/crew.json"))
})

test("open pull requests that cannot be listed stop the run before it could open a second one", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const result = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare, { list: () => ({ code: 1, stdout: "", stderr: "HTTP 502" }) }).gh, wait: noWait, now: NOW, apply: true, tooling: { repo: "acme/team-tooling" } })
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "pull_request")
  assert.match(result.reason, /could not list the open pull requests: HTTP 502/u)
  // An answer that is not a list is no open pull request.
  const odd = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare, { list: () => ({ code: 0, stdout: "{}" }) }).gh, wait: noWait, now: NOW, apply: true, tooling: { repo: "acme/team-tooling" } })
  assert.equal(odd.state, "published", odd.message)
})

test("two people joining at once with the same alias: the second is refused, its pull request closed, one row stays", async () => {
  const repo = await started()
  const { gh, state } = racing(repo, async () => pushFromElsewhere(repo, { "_meta/desks.md": `${rosterOnMain(repo)}| newbie | someone_else | desks/newbie | acme/team | crew | desks/newbie |\n` }))
  const result = await joinWorkspace(join(repo, { apply: true, gh }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "alias")
  assert.match(result.message, /the alias newbie belongs to someone_else; choose another alias\. desks\/newbie\/ is pushed and unused/u)
  assert.doesNotMatch(result.message, /run join again/u)
  assert.equal(state.closed, true)
  assert.equal(result.pr, undefined)
  assert.deepEqual(rows(repo).map((line) => line.split("|")[2].trim()), ["test-founder-placeholder", "someone_else"])
  assert.deepEqual(branches(repo.bare), ["main"])
})

test("one person joining from two machines at once ends with one row: the second run reports the first one's alias", async () => {
  const repo = await started()
  const { gh, state } = racing(repo, async () => pushFromElsewhere(repo, { "_meta/desks.md": `${rosterOnMain(repo)}| newbie2 | newbie_example | desks/newbie2 | acme/team | crew | desks/newbie2 |\n` }))
  const result = await joinWorkspace(join(repo, { apply: true, gh }))
  assert.equal(result.state, "member", result.message)
  assert.equal(result.alias, "newbie2")
  assert.match(result.message, /^newbie_example is already on the roster as newbie2; nothing to add\. It joined as newbie2 from another machine meanwhile, so desks\/newbie\/ is unused\./u)
  assert.equal(state.closed, true)
  assert.equal(rows(repo).filter((line) => line.includes("newbie_example")).length, 1)
  // A rerun after the row landed elsewhere finds the member before writing anything.
  const again = await joinWorkspace(join(memberClone(repo, "third"), { apply: true }))
  assert.equal(again.state, "member")
})

test("a join run again after its row merged elsewhere finds the member after bringing the clone up to date", async () => {
  const repo = await started()
  const other = memberClone(repo, "other")
  assert.equal((await joinWorkspace(join(other, { apply: true }))).state, "joined")
  // This clone is behind: locally the identity has no row, on GitHub it has.
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "member", result.message)
  assert.equal(rows(repo).filter((line) => line.includes("newbie_example")).length, 1)
  // And another identity that wants the alias meanwhile is refused at the same point.
  const late = memberClone(repo, "late")
  git(late.clone, ["reset", "-q", "--hard", "HEAD~2"])
  const refused = await joinWorkspace(join(late, { identity: "late_example", apply: true }))
  assert.equal(refused.state, "refused")
  assert.match(refused.message, /the alias newbie belongs to newbie_example/u)
})

test("a desk pushed for one identity whose row has not landed cannot be claimed by another identity", async () => {
  const repo = await started()
  // The first person's join pushed the desk and stopped before the row.
  const first = await joinWorkspace(join(repo, { apply: true, gh: fakeGh(repo.bare, { create: { code: 1 } }).gh }))
  assert.equal(first.state, "failed")
  assert.match(first.message, /desks\/newbie\/ is pushed; run join again to add the roster row/u)
  const intruder = memberClone(repo, "intruder")
  const refused = await joinWorkspace(join(intruder, { identity: "intruder_example" }))
  assert.equal(refused.state, "refused")
  assert.match(refused.message, /desks\/newbie\/ is already on the default branch, added for newbie_example, whose roster row has not landed; choose another alias/u)
  // A desk with no record of whose it is is not claimed either.
  await pushFromElsewhere(repo, { "desks/stray/AGENTS.md": "x", "desks/stray/README.md": "x", "desks/stray/_meta/friction.md": "x" })
  const stray = await joinWorkspace(join(memberClone(repo, "stray"), { identity: "stray_example", alias: "stray", apply: true }))
  assert.match(stray.message, /desks\/stray\/ is already on the default branch with no roster row, and nothing records whose it is; choose another alias/u)
  // The person it was pushed for finishes the join, from any clone, case aside.
  const resumed = await joinWorkspace(join(memberClone(repo, "again"), { identity: "NEWBIE_EXAMPLE", apply: true }))
  assert.equal(resumed.state, "joined", resumed.message)
  assert.equal(resumed.resumed, true)
})

// Pushes a complete desk for `alias` straight to main, as another join of `identity` would, without waiting.
function pushDeskNow(repo, alias, identity) {
  const other = path.join(repo.base, `sneak-${Math.random().toString(36).slice(2, 8)}`)
  spawnSync("git", ["clone", "-q", repo.bare, other])
  for (const rel of ["AGENTS.md", "README.md", "_meta/friction.md"]) {
    mkdirSync(path.dirname(path.join(other, "desks", alias, rel)), { recursive: true })
    writeFileSync(path.join(other, "desks", alias, rel), `# ${alias}\n`)
  }
  git(other, ["add", "-A"])
  git(other, ["-c", "user.email=o@example.com", "-c", "user.name=O", "commit", "-qm", `Crew: add ${alias}'s desk\n\nCrew-Identity: ${identity}`])
  git(other, ["push", "-q", "origin", "main"])
}

// Git that lets another join push its desk just before this one's own desk push.
const sneaking = (repo, identity) => {
  let done = false
  return (cmd, args, options) => {
    if (!done && args.includes("push") && args.includes("HEAD:refs/heads/main")) {
      done = true
      pushDeskNow(repo, "newbie", identity)
    }
    return repo.spawnGit(cmd, args, options)
  }
}

test("a desk another identity pushes while this join pushes its own is not taken over; the same identity's is reused", async () => {
  const repo = await started()
  const result = await joinWorkspace(join(repo, { apply: true, spawnGit: sneaking(repo, "winner_example") }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "desk")
  assert.match(result.message, /desks\/newbie\/ is already on the default branch, added for winner_example/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal(readCrewRoster(repo.clone).some((row) => row.alias === "newbie"), false)
  const same = await started()
  const joined = await joinWorkspace(join(same, { apply: true, spawnGit: sneaking(same, "newbie_example") }))
  assert.equal(joined.state, "joined", joined.message)
  assert.equal(onMain(same.bare, "desks/newbie/AGENTS.md"), "# newbie\n")
})

test("one person's other machine landing its row while this one pushes the desk: no pull request, one row", async () => {
  const repo = await started()
  let done = false
  const spawnGit = (cmd, args, options) => {
    if (!done && args.includes("push") && args.includes("HEAD:refs/heads/main")) {
      done = true
      const other = path.join(repo.base, "machine-two")
      spawnSync("git", ["clone", "-q", repo.bare, other])
      appendFileSync(path.join(other, "_meta", "desks.md"), "| newbie2 | newbie_example | desks/newbie2 | acme/team | crew | desks/newbie2 |\n")
      git(other, ["-c", "user.email=o@example.com", "-c", "user.name=O", "commit", "-qam", "row from machine two"])
      git(other, ["push", "-q", "origin", "main"])
    }
    return repo.spawnGit(cmd, args, options)
  }
  const fake = fakeGh(repo.bare)
  const result = await joinWorkspace(join(repo, { apply: true, spawnGit, gh: fake.gh }))
  assert.equal(result.state, "member", result.message)
  assert.equal(result.alias, "newbie2")
  assert.match(result.message, /so desks\/newbie\/ is unused/u)
  assert.equal(fake.calls.filter((args) => args[1] === "create").length, 0)
  assert.equal(git(repo.clone, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
})

test("join run again after it left the roster row's pull request open reuses it; another person's open join is not reused", async () => {
  const repo = await started()
  let blocked = true
  const fake = fakeGh(repo.bare, {
    merge: (state) => {
      if (blocked) return { code: 1, stdout: "", stderr: "blocked" }
      spawnSync("git", ["--git-dir", repo.bare, "update-ref", "refs/heads/main", `refs/heads/${state.head}`])
      state.merged = true
      return { code: 0, stdout: "", stderr: "" }
    },
    view: (state) => ({ code: 0, stdout: JSON.stringify(state.merged ? { state: "MERGED", mergeCommit: { oid: git(repo.bare, ["rev-parse", "main"]) } } : { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }) }),
  })
  const first = await joinWorkspace(join(repo, { apply: true, gh: fake.gh }))
  assert.equal(first.state, "pr_open")
  assert.match(first.message, /Running the same command again reuses this pull request and tries to merge it again; it never opens a second one\.$/u)
  const created = fake.calls.find((args) => args[1] === "create")
  assert.match(created[created.indexOf("--body") + 1], /\nCrew-Identity: newbie_example$/u)
  const stillBlocked = await joinWorkspace(join(repo, { apply: true, gh: fake.gh, now: LATER }))
  assert.equal(stillBlocked.state, "pr_open")
  blocked = false
  const second = await joinWorkspace(join(repo, { apply: true, gh: fake.gh, now: LATER }))
  assert.equal(second.state, "joined", second.message)
  assert.equal(fake.calls.filter((args) => args[1] === "create").length, 1)
  assert.equal(rows(repo).filter((line) => line.includes("newbie_example")).length, 1)
  // An open join pull request for the same alias by someone else is not this run's to reuse.
  const other = await started()
  const list = () => ({ code: 0, stdout: JSON.stringify([{ url: "https://github.com/acme/team/pull/99", headRefName: "crew/join-newbie-zzz", body: "Crew-Identity: someone_else" }]) })
  const fresh = fakeGh(other.bare, { list })
  assert.equal((await joinWorkspace(join(other, { apply: true, gh: fresh.gh }))).state, "joined")
  assert.equal(fresh.calls.filter((args) => args[1] === "create").length, 1)
})

test("a rebuilt roster row whose push is refused leaves its pull request open for the rerun and says so", async () => {
  const repo = await started()
  const { gh, state } = racing(repo, async () => pushFromElsewhere(repo, { "_meta/desks.md": `${rosterOnMain(repo)}| other | other_example | desks/other | acme/team | crew | desks/other |\n` }))
  const spawnGit = (cmd, args, options) => (args.includes("push") && args.includes("--force") ? { status: 1, stdout: "", stderr: "remote: Permission denied" } : repo.spawnGit(cmd, args, options))
  const result = await joinWorkspace(join(repo, { apply: true, gh, spawnGit }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "push")
  assert.match(result.message, / The pull request https:\/\/github\.com\/acme\/team\/pull\/12 is open\. desks\/newbie\/ is pushed; run join again to add the roster row\.$/u)
  assert.equal(state.closed, false)
})

test("a desk another identity pushed after this clone last fetched is found once the clone is brought up to date", async () => {
  const repo = await started()
  pushDeskNow(repo, "newbie", "winner_example")
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "refused")
  assert.match(result.message, /desks\/newbie\/ is already on the default branch, added for winner_example/u)
})

test("one person's other machine joining with the same alias while this one pushes the desk: the desk is reused, one row", async () => {
  const repo = await started()
  let done = false
  const spawnGit = (cmd, args, options) => {
    if (!done && args.includes("push") && args.includes("HEAD:refs/heads/main")) {
      done = true
      pushDeskNow(repo, "newbie", "newbie_example")
      const other = path.join(repo.base, "machine-two")
      spawnSync("git", ["clone", "-q", repo.bare, other])
      appendFileSync(path.join(other, "_meta", "desks.md"), "| newbie | newbie_example | desks/newbie | acme/team | crew | desks/newbie |\n")
      git(other, ["-c", "user.email=o@example.com", "-c", "user.name=O", "commit", "-qam", "row from machine two"])
      git(other, ["push", "-q", "origin", "main"])
    }
    return repo.spawnGit(cmd, args, options)
  }
  const result = await joinWorkspace(join(repo, { apply: true, spawnGit }))
  assert.equal(result.state, "member", result.message)
  assert.equal(result.alias, "newbie")
  assert.equal(result.message, "newbie_example is already on the roster as newbie; nothing to add. Desk sessions in this clone find that desk from the roster.")
  assert.equal(rows(repo).filter((line) => line.includes("newbie_example")).length, 1)
})

test("a workspace the team took Crew out of meanwhile is not joined", async () => {
  const repo = await started()
  const other = await secondClone(repo)
  git(other, ["rm", "-rq", "_meta/desks.md", "desks"])
  git(other, ["commit", "-qm", "no longer a crew"])
  git(other, ["push", "-q", "origin", "main"])
  const result = await joinWorkspace(join(repo, { apply: true }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "roster")
  assert.match(result.message, /the default branch on GitHub is no longer a Crew workspace: its roster and desks\/ are gone\)\.$/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})
