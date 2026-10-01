// The local-only exemption for `done` evidence and the five ways round 9's review found to fake it: remove the remote, use
// a commit that predates the task, `git init` a repo inside the done call, name an unreachable commit, and point at a
// folder inside the desk. The rule: only a repo entry already on the card, carrying `local_only: true` that Desk recorded
// itself, with no `url`, in a clone outside the desk, with a reachable commit made after the card was created.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { assertCodeRepoEvidence } from "../../../../../plugins/desk/mcp/src/tools/done-evidence.js"
import { assertLocalOnlyUnchanged, isLocalOnlyClone, recordLocalOnlyOnCards, repoKey, withLocalOnlyRecorded } from "../../../../../plugins/desk/mcp/src/tools/local-only.js"
import { mkTempRoot } from "../_temp_roots.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

async function makeRepo({ date } = {}) {
  const base = await mkTempRoot("desk-local-only-")
  const clone = path.join(base, "clone")
  await fs.mkdir(clone)
  git(clone, "init", "-q", "-b", "main")
  git(clone, "config", "user.email", "t@example.com")
  git(clone, "config", "user.name", "T")
  await commit(clone, "first", date)
  return clone
}

async function commit(clone, name, date) {
  await fs.writeFile(path.join(clone, `${name}.txt`), `${name}\n`)
  git(clone, "add", ".")
  const env = date === undefined ? process.env : { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }
  const result = spawnSync("git", ["-C", clone, "commit", "-q", "-m", name], { encoding: "utf8", env })
  assert.equal(result.status, 0, result.stderr)
  return git(clone, "rev-parse", "HEAD")
}

const entry = (clone, extra = {}) => ({ name: "greenhouse", local_path: clone, mode: "local", ...extra })

async function cardWith(repos, root) {
  root ??= await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "ship-it", title: "T", status: "processing", repos } })
  return root
}

const done = (root, evidence, frontmatter = {}) =>
  task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter: { status: "done", ...frontmatter }, evidence } })

const cardRepos = async (root) => (await readFront(path.join(root, "t", "ship-it", "task.md"))).data.repos

// A pause so a commit made after the card sorts strictly after its `created` even at one-second resolution.
const tick = () => new Promise((resolve) => setTimeout(resolve, 1100))

test("task_create records local_only on a repo whose clone has no remote and no url, and only on that one", async () => {
  const local = await makeRepo()
  const withRemote = await makeRepo()
  git(withRemote, "remote", "add", "origin", "https://github.com/acme/widgets.git")
  const root = await cardWith([entry(local), { ...entry(withRemote), name: "widgets" }, { ...entry(local), name: "with-url", url: "https://github.com/acme/x.git" }, { name: "bare-name" }, "just-a-string"])
  const repos = await cardRepos(root)
  assert.equal(repos[0].local_only, true)
  assert.equal(repos[1].local_only, undefined)
  assert.equal(repos[2].local_only, undefined)
  assert.equal(repos[3].local_only, undefined)
  assert.equal(repos[4], "just-a-string")
})

test("a local_only the caller writes at create time is dropped unless the clone earns it", async () => {
  const withRemote = await makeRepo()
  git(withRemote, "remote", "add", "origin", "https://github.com/acme/widgets.git")
  const root = await cardWith([entry(withRemote, { local_only: true })])
  assert.equal((await cardRepos(root))[0].local_only, undefined)
})

test("a commit made after the task was created, in the recorded local-only clone, is valid done evidence", async () => {
  const clone = await makeRepo()
  const root = await cardWith([entry(clone)])
  await tick()
  const sha = await commit(clone, "after")
  assert.equal((await done(root, { kind: "commit", ref: sha })).status, "updated")
  assert.equal((await readFront(path.join(root, "t", "ship-it", "task.md"))).data.evidence.ref, sha)
})

test("bypass 1: removing the remote from a clone does not make it local-only", async () => {
  const clone = await makeRepo()
  git(clone, "remote", "add", "origin", "https://github.com/acme/widgets.git")
  const root = await cardWith([entry(clone)])
  git(clone, "remote", "remove", "origin")
  await tick()
  const sha = await commit(clone, "after")
  await assert.rejects(done(root, { kind: "commit", ref: sha }), /greenhouse has no remote, but it does not qualify as a local-only repo.*leave the task at `validating` and tell the operator the commit sha/s)
})

test("a recorded local-only clone that later gains a remote needs the commit pushed again", async () => {
  const clone = await makeRepo()
  const root = await cardWith([entry(clone)])
  git(clone, "remote", "add", "origin", "https://github.com/acme/widgets.git")
  await tick()
  const sha = await commit(clone, "after")
  await assert.rejects(done(root, { kind: "commit", ref: sha }), /no remote-tracking branch contains it/)
})

test("bypass 2: a commit that predates the task is refused even in a recorded local-only clone", async () => {
  const clone = await makeRepo({ date: "2020-01-01T00:00:00Z" })
  const old = git(clone, "rev-parse", "HEAD")
  const root = await cardWith([entry(clone)])
  await assert.rejects(done(root, { kind: "commit", ref: old }), /greenhouse is recorded as local-only, but commit \w{7} was made before the task was created/)
})

test("bypass 3: a repo added in the done call, even a fresh git init, earns no exemption", async () => {
  const clone = await makeRepo()
  const fresh = await mkTempRoot("desk-local-only-fresh-")
  const root = await cardWith([{ name: "widgets", local_path: path.join(clone, "missing"), mode: "local" }])
  git(fresh, "init", "-q", "-b", "main")
  git(fresh, "config", "user.email", "t@example.com")
  git(fresh, "config", "user.name", "T")
  await tick()
  const sha = await commit(fresh, "x")
  await assert.rejects(done(root, { kind: "commit", ref: sha }, { repos: [{ name: "fresh", local_path: fresh, mode: "local" }] }), /no local clone|does not resolve|exists in fresh/)
  // Claiming the mark in the call is refused outright, whatever the clone looks like.
  await assert.rejects(done(root, { kind: "commit", ref: sha }, { repos: [{ name: "fresh", local_path: fresh, mode: "local", local_only: true }] }), /`local_only` on a repos entry is written by Desk itself/)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter: { repos: [{ name: "widgets", local_path: path.join(clone, "missing"), mode: "local", local_only: true }] } } }), /written by Desk itself/)
})

test("bypass 3b: a clone created after the card, at a path the card recorded, is not recorded as local-only", async () => {
  const base = await mkTempRoot("desk-local-only-late-")
  const later = path.join(base, "late")
  const root = await cardWith([entry(later)])
  await fs.mkdir(later)
  git(later, "init", "-q", "-b", "main")
  git(later, "config", "user.email", "t@example.com")
  git(later, "config", "user.name", "T")
  await tick()
  const sha = await commit(later, "x")
  await assert.rejects(done(root, { kind: "commit", ref: sha }), /greenhouse has no remote, but it does not qualify/)
})

test("bypass 4: a commit that no branch or HEAD reaches is refused", async () => {
  const clone = await makeRepo()
  const root = await cardWith([entry(clone)])
  await tick()
  const dangling = await commit(clone, "after")
  git(clone, "reset", "-q", "--hard", "HEAD~1")
  await assert.rejects(done(root, { kind: "commit", ref: dangling }), /greenhouse is recorded as local-only, but commit \w{7} is not reachable from HEAD or any local branch/)
})

test("a commit on a detached HEAD that no local branch holds is reachable from HEAD", async () => {
  const clone = await makeRepo()
  const root = await cardWith([entry(clone)])
  await tick()
  git(clone, "checkout", "-q", "--detach")
  const sha = await commit(clone, "detached")
  assert.equal((await done(root, { kind: "commit", ref: sha })).status, "updated")
})

test("bypass 5: a local_path inside the desk never counts, nor does a clone that holds the desk", async () => {
  const root = await mkTempDeskRoot()
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "t@example.com")
  git(root, "config", "user.name", "T")
  await fs.mkdir(path.join(root, "sub"))
  await fs.writeFile(path.join(root, "sub", "f.txt"), "f\n")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "seed")
  await cardWith([entry(path.join(root, "sub"))], root)
  assert.equal((await cardRepos(root))[0].local_only, undefined)
  await tick()
  await fs.writeFile(path.join(root, "sub", "g.txt"), "g\n")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "more")
  await assert.rejects(done(root, { kind: "commit", ref: git(root, "rev-parse", "HEAD") }), /does not resolve in any of this task's repo clones|has no remote/)
  assert.equal(isLocalOnlyClone(path.join(root, "sub"), { deskRoot: root }), false)
  const outer = await mkTempRoot("desk-local-only-outer-")
  git(outer, "init", "-q", "-b", "main")
  const inner = path.join(outer, "desk")
  await fs.mkdir(inner)
  assert.equal(isLocalOnlyClone(outer, { deskRoot: inner }), false)
})

test("isLocalOnlyClone: not a repository, a repository with a remote, a folder that vanished, and a plain repo", async () => {
  const root = await mkTempDeskRoot()
  const plain = await mkTempRoot("desk-local-only-plain-")
  assert.equal(isLocalOnlyClone(plain, { deskRoot: root }), false)
  const repo = await makeRepo()
  assert.equal(isLocalOnlyClone(repo, { deskRoot: root }), true)
  assert.equal(isLocalOnlyClone(repo, { deskRoot: path.join(root, "gone-folder") }), false)
  git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git")
  assert.equal(isLocalOnlyClone(repo, { deskRoot: root }), false)
})

test("an entry with a url never qualifies, even if a card carries the mark", async () => {
  const clone = await makeRepo()
  const root = await cardWith([entry(clone)])
  const file = path.join(root, "t", "ship-it", "task.md")
  const raw = await fs.readFile(file, "utf8")
  await fs.writeFile(file, raw.replace("local_only: true", "local_only: true\n    url: https://github.com/acme/widgets.git"))
  await tick()
  const sha = await commit(clone, "after")
  await assert.rejects(done(root, { kind: "commit", ref: sha }), /not pushed|no remote-tracking branch/)
  // A url added to the entry in the done call disqualifies the recorded entry too.
  const second = await cardWith([entry(clone)], await mkTempDeskRoot())
  await assert.rejects(done(second, { kind: "commit", ref: sha }, { repos: [entry(clone, { local_only: true, url: "https://github.com/acme/widgets.git" })] }), /written by Desk itself|not pushed|no remote-tracking/)
  await fs.writeFile(path.join(second, "t", "ship-it", "task.md"), raw.replace("local_only: true", "local_only: true\n    url: x"))
})

test("task_update refuses to set or change local_only, and copies of the recorded entry pass", async () => {
  const clone = await makeRepo()
  const root = await cardWith([entry(clone)])
  const recorded = (await cardRepos(root))[0]
  await task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter: { repos: [recorded] } } })
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter: { repos: [{ ...recorded, local_path: "/elsewhere" }] } } }), /written by Desk itself/)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter: { repos: [{ ...recorded, local_only: false }] } } }), /written by Desk itself/)
  assertLocalOnlyUnchanged(undefined, [])
  assertLocalOnlyUnchanged([null, "x", { name: "y" }], undefined)
  assert.throws(() => assertLocalOnlyUnchanged([{ name: "n", local_only: true }], "not a list"), /written by Desk itself/)
  assert.equal(repoKey(undefined), "\u0000")
})

test("withLocalOnlyRecorded leaves a non-list alone", () => {
  assert.equal(withLocalOnlyRecorded(undefined, { deskRoot: "/d" }), undefined)
})

test("recordLocalOnlyOnCards marks a clone boot first sees with no remote, once, and never throws", async () => {
  const clone = await makeRepo()
  const root = await mkTempDeskRoot()
  const dir = path.join(root, "t", "ship-it")
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, "task.md")
  await fs.writeFile(file, `---\ntitle: T\nstatus: processing\nrepos:\n  - name: greenhouse\n    local_path: ${clone}\n    mode: local\n---\nbody\n`)
  const card = (data, f = file) => ({ file: f, track: "t", slug: "ship-it", data })
  const open = { status: "processing", repos: [{ name: "greenhouse", local_path: clone, mode: "local" }] }
  const noop = [
    card({ status: "done", repos: open.repos }),
    card({ status: "processing" }),
    card({ status: "processing", repos: [{ name: "x", local_path: clone, mode: "local", local_only: true }, { name: "y" }] }),
  ]
  assert.deepEqual(await recordLocalOnlyOnCards({ cards: [...noop, card(open), card(open, path.join(root, "missing", "task.md")), card(undefined)], deskRoot: root }), ["t/ship-it"])
  assert.equal((await readFront(file)).data.repos[0].local_only, true)
  assert.deepEqual(await recordLocalOnlyOnCards({ cards: [card((await readFront(file)).data)], deskRoot: root }), [])
})

test("task_archive also applies the rule: an old commit is refused, a new one in a recorded clone passes", async () => {
  const clone = await makeRepo({ date: "2020-01-01T00:00:00Z" })
  const old = git(clone, "rev-parse", "HEAD")
  const root = await cardWith([entry(clone)])
  await assert.rejects(task_archive({ deskRoot: root, input: { track: "t", slug: "ship-it", evidence: { kind: "commit", ref: old } } }), /was made before the task was created/)
  await tick()
  const sha = await commit(clone, "after")
  assert.equal((await task_archive({ deskRoot: root, input: { track: "t", slug: "ship-it", evidence: { kind: "commit", ref: sha } } })).status, "archived")
})

test("a card with no readable created time cannot be matched to a commit date, and an unreadable commit date is refused", async () => {
  const desk = await mkTempDeskRoot()
  const clone = await mkTempRoot("desk-local-only-mock-")
  const spawnGit = (cmd, args) => {
    const joined = args.join(" ")
    if (joined.includes("rev-parse --show-toplevel")) return { status: 0, stdout: `${clone}\n` }
    if (joined.includes("cat-file")) return { status: 0, stdout: "" }
    if (joined.includes("config")) return { status: 0, stdout: "" }
    if (joined.includes("remote")) return { status: 0, stdout: "\n" }
    if (joined.includes("refs/heads")) return { status: 0, stdout: "refs/heads/main\n" }
    if (joined.includes("show -s")) return { status: 0, stdout: "not-a-number\n" }
    return { status: 0, stdout: "" }
  }
  const repos = [{ name: "w", localPath: clone, mode: "local", url: false }]
  const existingRepos = [{ name: "w", local_path: clone, mode: "local", local_only: true }]
  const run = (created) => assertCodeRepoEvidence({ toolName: "t", evidence: { kind: "commit", ref: "a1b2c3d4" }, repos, deskRoot: desk, spawnGit, existingRepos, created })
  assert.throws(() => run("not a date"), /no readable `created` time/)
  assert.throws(() => run(new Date()), /was made before the task was created/)
})

// A scripted git: each command is answered by the first matching rule, so a reachability or date lookup can fail on its own.
function scriptedGit(rules) {
  return (cmd, args) => {
    const joined = args.join(" ")
    for (const [pattern, answer] of rules) if (joined.includes(pattern)) return answer
    return { status: 0, stdout: "" }
  }
}

async function mockedCall({ rules, existingRepos, repos, created = "2026-01-01T00:00:00Z" }) {
  const desk = await mkTempDeskRoot()
  const clone = await mkTempRoot("desk-local-only-script-")
  const spawnGit = scriptedGit([["rev-parse --show-toplevel", { status: 0, stdout: `${clone}\n` }], ["remote", { status: 0, stdout: "\n" }], ...rules])
  const entryFor = (extra = {}) => ({ name: "w", local_path: clone, mode: "local", ...extra })
  return () => assertCodeRepoEvidence({
    toolName: "t", evidence: { kind: "commit", ref: "a1b2c3d4" }, deskRoot: desk, spawnGit, created,
    repos: typeof repos === "function" ? repos(clone) : (repos ?? [{ name: "w", localPath: clone, mode: "local", url: false }]),
    existingRepos: existingRepos === undefined ? [entryFor({ local_only: true })] : typeof existingRepos === "function" ? existingRepos(entryFor) : existingRepos,
  })
}

test("reachability and the commit date each fail on their own, and either lookup failing is a refusal", async () => {
  const reachable = [["refs/heads", { status: 0, stdout: "refs/heads/main\n" }]]
  const old = ["show -s", { status: 0, stdout: `${Math.floor(Date.parse("2020-01-01T00:00:00Z") / 1000)}\n` }]
  const fresh = ["show -s", { status: 0, stdout: `${Math.floor(Date.now() / 1000)}\n` }]
  const base = [["cat-file", { status: 0, stdout: "" }]]
  // Reachable by HEAD alone (no branch lists it) and made after the card: accepted.
  assert.doesNotThrow(await mockedCall({ rules: [...base, ["refs/heads", { status: 0, stdout: "\n" }], ["merge-base", { status: 0, stdout: "" }], fresh] }))
  // Reachable by a branch though HEAD does not hold it: accepted.
  assert.doesNotThrow(await mockedCall({ rules: [...base, ...reachable, ["merge-base", { status: 1, stdout: "" }], fresh] }))
  // The branch lookup itself failing leaves HEAD to decide.
  assert.doesNotThrow(await mockedCall({ rules: [...base, ["refs/heads", { status: 1, stdout: "" }], ["merge-base", { status: 0, stdout: "" }], fresh] }))
  // Neither reaches it.
  assert.throws(await mockedCall({ rules: [...base, ["refs/heads", { status: 0, stdout: "\n" }], ["merge-base", { status: 1, stdout: "" }], fresh] }), /is not reachable from HEAD or any local branch/)
  // A commit date git cannot print, or one before the card, is refused.
  assert.throws(await mockedCall({ rules: [...base, ...reachable, ["show -s", { status: 1, stdout: "" }]] }), /was made before the task was created/)
  assert.throws(await mockedCall({ rules: [...base, ...reachable, old] }), /was made before the task was created/)
})

test("only recorded entries without a url on the card qualify, whichever list shows the url", async () => {
  const base = [["cat-file", { status: 0, stdout: "" }], ["refs/heads", { status: 0, stdout: "refs/heads/main\n" }], ["show -s", { status: 0, stdout: `${Math.floor(Date.now() / 1000)}\n` }]]
  assert.doesNotThrow(await mockedCall({ rules: base }))
  // A url on the recorded entry itself, with the call's own list silent about it.
  assert.throws(await mockedCall({ rules: base, existingRepos: (entry) => [entry({ local_only: true, url: "https://github.com/a/b.git" })] }), /not pushed|no remote-tracking/)
  // A url on the same clone in the call's list.
  assert.throws(await mockedCall({ rules: base, repos: (clone) => [{ name: "w", localPath: clone, mode: "local", url: true }], existingRepos: (entry) => [entry({ local_only: true })] }), /not pushed|no remote-tracking/)
  // Not a list, null, a string and an entry without the mark: nothing qualifies.
  for (const existingRepos of ["nope", [null, "w", { name: "w" }]]) assert.throws(await mockedCall({ rules: base, existingRepos }), /not pushed|no remote-tracking|does not qualify/)
})
