// A task whose card names code repos can only reach `done` with code evidence from those repos: a PR URL in one of
// them, or a pushed commit that resolves in a recorded clone. Never a desk commit, `ci_run` or `non_code`
// (boot acceptance round 6: an agent that could not open its PR recorded a desk commit as `commit` evidence).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { assertCodeRepoEvidence, recordedRepos } from "../../../../../plugins/desk/mcp/src/tools/done-evidence.js"
import { mkTempRoot } from "../_temp_roots.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

function identity(dir) {
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "Test")
}

// A clone whose origin looks like github.com/<slug> and whose `main` is pushed (so a remote-tracking branch holds it).
async function makeClone(slug, { upstream } = {}) {
  const base = await mkTempRoot("desk-done-repo-")
  const bare = path.join(base, "remote.git")
  const clone = path.join(base, "clone")
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  spawnSync("git", ["clone", "-q", bare, clone])
  identity(clone)
  git(clone, "checkout", "-q", "-b", "main")
  await fs.writeFile(path.join(clone, "a.txt"), "a\n")
  git(clone, "add", ".")
  git(clone, "commit", "-q", "-m", "first")
  git(clone, "push", "-q", "origin", "main")
  const pushed = git(clone, "rev-parse", "HEAD")
  git(clone, "remote", "set-url", "origin", `https://github.com/${slug}.git`)
  if (upstream) git(clone, "remote", "add", "upstream", `git@github.com:${upstream}.git`)
  await fs.writeFile(path.join(clone, "b.txt"), "b\n")
  git(clone, "add", ".")
  git(clone, "commit", "-q", "-m", "second, not pushed")
  return { clone, pushed, unpushed: git(clone, "rev-parse", "HEAD") }
}

async function codeTask(repos, root) {
  root ??= await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "ship-it", title: "T", status: "processing", repos } })
  return root
}

const done = (root, evidence, extra = {}) =>
  task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter: { status: "done" }, evidence, ...extra } })

test("a card with repos accepts a PR URL in one of them and records it", async () => {
  const { clone } = await makeClone("acme/widgets")
  const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
  const ref = "https://github.com/acme/widgets/pull/7"
  assert.equal((await done(root, { kind: "pr", ref })).status, "updated")
  const { data } = await readFront(path.join(root, "t", "ship-it", "task.md"))
  assert.equal(data.evidence.ref, ref)
})

test("a PR in a repo the card does not list is refused, and the error names the task's repos", async () => {
  const { clone } = await makeClone("acme/widgets")
  const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
  await assert.rejects(
    done(root, { kind: "pr", ref: "https://github.com/anthropics/claude-code/pull/1" }),
    /is not in this task's repos \(acme\/widgets \(.*clone\)\)\. Supply a PR URL in one of those repos/,
  )
  const { data } = await readFront(path.join(root, "t", "ship-it", "task.md"))
  assert.equal(data.status, "processing")
})

test("a PR is accepted on the upstream a fork-route clone also records, and on the fork itself", async () => {
  const { clone } = await makeClone("me/widgets", { upstream: "acme/widgets" })
  const root = await codeTask([{ name: "widgets", local_path: clone, mode: "local" }])
  assert.equal((await done(root, { kind: "pr", ref: "https://github.com/acme/widgets/pull/9" })).status, "updated")
  const second = await codeTask([{ name: "widgets", local_path: clone, mode: "local" }])
  assert.equal((await done(second, { kind: "pr", ref: "https://github.com/me/widgets/pull/9/files" })).status, "updated")
})

test("a bare repo name matches a GitHub PR on any owner's repo of that name, but a full name pins the owner", async () => {
  const root = await codeTask([{ name: "widgets", local_path: "", mode: "remote" }])
  assert.equal((await done(root, { kind: "pr", ref: "https://github.com/anyone/widgets/pull/1" })).status, "updated")
  const pinned = await codeTask([{ name: "acme/widgets", local_path: "", mode: "remote" }])
  await assert.rejects(done(pinned, { kind: "pr", ref: "https://github.com/other/widgets/pull/1" }), /not in this task's repos \(acme\/widgets \(no local clone recorded\)\)/)
})

test("an Azure DevOps pull request matches by repo name, from the recorded name or a clone's remote", async () => {
  const root = await codeTask([{ name: "OrderService", local_path: "", mode: "remote" }])
  const ado = "https://dev.azure.com/org/proj/_git/OrderService/pullrequest/12"
  assert.equal((await done(root, { kind: "pr", ref: ado })).status, "updated")
  const { clone } = await makeClone("acme/other")
  git(clone, "remote", "set-url", "origin", "https://dev.azure.com/org/proj/_git/Billing")
  const viaRemote = await codeTask([{ name: "x", local_path: clone, mode: "local" }])
  assert.equal((await done(viaRemote, { kind: "pr", ref: "https://dev.azure.com/org/proj/_git/Billing/pullrequest/3" })).status, "updated")
  const wrong = await codeTask([{ name: "OrderService", local_path: "", mode: "remote" }])
  await assert.rejects(done(wrong, { kind: "pr", ref: "https://dev.azure.com/org/proj/_git/Other/pullrequest/3" }), /not in this task's repos/)
})

test("a PR URL with no repo segment names no repo of the task's", async () => {
  const root = await codeTask([{ name: "acme/widgets", local_path: "", mode: "remote" }])
  await assert.rejects(done(root, { kind: "pr", ref: "https://github.com/pull/5" }), /not in this task's repos/)
})

test("non_code and ci_run evidence cannot finish a task that names code repos, and the error says what to supply", async () => {
  const { clone } = await makeClone("acme/widgets")
  const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
  await fs.writeFile(path.join(root, "t", "proof.md"), "proof\n")
  await assert.rejects(
    done(root, { kind: "non_code", ref: "t/proof.md" }),
    /`non_code` evidence cannot complete a task that names code repos.*kind: "pr".*kind: "commit".*a repo Desk recorded as local-only.*A commit in the desk itself does not count.*leave it at `validating` and tell the operator the commit sha/s,
  )
  await assert.rejects(done(root, { kind: "ci_run", ref: "https://ci.example.invalid/1" }), /`ci_run` evidence cannot complete a task that names code repos/)
})

test("a commit made in the desk is refused for a card with repos, even though it is pushed-looking and real", async () => {
  const { clone } = await makeClone("acme/widgets")
  const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
  git(root, "init", "-q")
  identity(root)
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "card edit only")
  const deskSha = git(root, "rev-parse", "HEAD")
  await assert.rejects(done(root, { kind: "commit", ref: deskSha }), new RegExp(`commit ${deskSha} does not resolve in any of this task's repo clones.*A commit made in the desk`, "s"))
})

test("a repo whose recorded clone is the desk itself never vouches for a commit", async () => {
  const root = await mkTempDeskRoot()
  git(root, "init", "-q")
  identity(root)
  await codeTask([{ name: "acme/desk", local_path: root, mode: "local" }], root)
  git(root, "add", ".")
  git(root, "commit", "-q", "--allow-empty", "-m", "x")
  await assert.rejects(done(root, { kind: "commit", ref: git(root, "rev-parse", "HEAD") }), /does not resolve in any of this task's repo clones/)
})

test("a commit in a recorded clone that no remote-tracking branch contains is refused as not pushed", async () => {
  const { clone, unpushed } = await makeClone("acme/widgets")
  const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
  await assert.rejects(
    done(root, { kind: "commit", ref: unpushed }),
    new RegExp(`commit ${unpushed} exists in acme/widgets \\(.*\\) but no remote-tracking branch contains it.*push the branch.*open a pull request.*leave the task at \`validating\` and tell the operator the commit sha ${unpushed.slice(0, 7)}`, "s"),
  )
})

// A clone with no remote at all (never pushed anywhere, nowhere to push), before any work is committed in it.
async function makeLocalOnlyRepo() {
  const dir = await mkTempRoot("desk-done-local-")
  const clone = path.join(dir, "clone")
  await fs.mkdir(clone)
  git(clone, "init", "-q", "-b", "main")
  identity(clone)
  return clone
}

async function commitWork(clone, name = "a") {
  await fs.writeFile(path.join(clone, `${name}.txt`), `${name}\n`)
  git(clone, "add", ".")
  git(clone, "commit", "-q", "-m", "work")
  return git(clone, "rev-parse", "HEAD")
}

// A commit that exists in it is the finished work, but only a commit made after the card was created: the rule compares
// the commit's whole-second time with the card's `created`, so the work is committed after `codeTask`, never before it.
test("a commit in a recorded clone that has no remote configured at all is valid done evidence", async () => {
  const clone = await makeLocalOnlyRepo()
  const root = await codeTask([{ name: "greenhouse", local_path: clone, mode: "local" }])
  const sha = await commitWork(clone)
  assert.equal((await done(root, { kind: "commit", ref: sha })).status, "updated")
  const { data } = await readFront(path.join(root, "t", "ship-it", "task.md"))
  assert.equal(data.evidence.ref, sha)
})

test("a local-only clone still has to contain the commit, and one with a remote still needs it pushed", async () => {
  const clone = await makeLocalOnlyRepo()
  await commitWork(clone)
  const root = await codeTask([{ name: "greenhouse", local_path: clone, mode: "local" }])
  await assert.rejects(done(root, { kind: "commit", ref: "a1b2c3d4" }), /does not resolve in any of this task's repo clones/)
  git(clone, "remote", "add", "origin", "https://github.com/acme/widgets.git")
  await fs.writeFile(path.join(clone, "b.txt"), "b\n")
  git(clone, "add", ".")
  git(clone, "commit", "-q", "-m", "more")
  await assert.rejects(done(root, { kind: "commit", ref: git(clone, "rev-parse", "HEAD") }), /no remote-tracking branch contains it/)
})

test("a remote-less lookalike does not count when git cannot list the remotes", () => {
  const repos = [{ name: "w", localPath: "/c", mode: "local" }]
  const spawnGit = (cmd, args) => (args.includes("cat-file") ? { status: 0, stdout: "" } : args.includes("for-each-ref") ? { status: 0, stdout: "" } : { status: 1, stdout: "" })
  assert.throws(() => assertCodeRepoEvidence({ toolName: "t", evidence: { kind: "commit", ref: "a1b2c3d4" }, repos, deskRoot: "/d", spawnGit }), /not pushed|no remote-tracking branch/)
})

test("a commit is looked up in every recorded clone: found in a later one, and refused as unpushed when two clones both hold it unpushed", async () => {
  const { clone, pushed, unpushed } = await makeClone("acme/widgets")
  const second = await makeClone("acme/other")
  const both = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }, { name: "acme/widgets-copy", local_path: clone, mode: "local" }])
  await assert.rejects(done(both, { kind: "commit", ref: unpushed }), /but no remote-tracking branch contains it/)
  const root = await codeTask([{ name: "acme/other", local_path: second.clone, mode: "local" }, { name: "acme/widgets", local_path: clone, mode: "local" }])
  assert.equal((await done(root, { kind: "commit", ref: pushed })).status, "updated")
})

test("a pushed commit in a recorded clone is accepted as a bare sha, with a branch suffix, and as a commit URL", async () => {
  const { clone, pushed } = await makeClone("acme/widgets")
  for (const ref of [pushed, `${pushed.slice(0, 9)} on origin/main`, `https://github.com/acme/widgets/commit/${pushed}`]) {
    const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
    assert.equal((await done(root, { kind: "commit", ref })).status, "updated", ref)
  }
})

test("a commit URL in another repo is refused before any git lookup", async () => {
  const { clone, pushed } = await makeClone("acme/widgets")
  const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
  await assert.rejects(done(root, { kind: "commit", ref: `https://github.com/someone/else/commit/${pushed}` }), /not in this task's repos/)
  await assert.rejects(done(root, { kind: "commit", ref: `https://github.com/commit/${pushed}` }), /not in this task's repos/)
})

test("commit evidence with no recorded local clone says to supply a PR URL or record the clone", async () => {
  const root = await codeTask([{ name: "acme/widgets", local_path: "", mode: "remote" }])
  await assert.rejects(done(root, { kind: "commit", ref: "a1b2c3d4" }), /needs a local clone to check.*Supply a pull request URL instead/s)
})

test("a tilde local_path resolves against the call's HOME", async () => {
  const { clone, pushed } = await makeClone("acme/widgets")
  const home = path.dirname(clone)
  const root = await codeTask([{ name: "acme/widgets", local_path: "~/clone", mode: "local" }])
  const result = await task_update({
    deskRoot: root, env: { HOME: home },
    input: { track: "t", slug: "ship-it", frontmatter: { status: "done" }, evidence: { kind: "commit", ref: pushed } },
  })
  assert.equal(result.status, "updated")
})

test("a recorded clone that does not exist on disk resolves nothing", async () => {
  const root = await codeTask([{ name: "acme/widgets", local_path: path.join(root0(), "absent"), mode: "local" }])
  await assert.rejects(done(root, { kind: "commit", ref: "a1b2c3d4" }), /does not resolve in any of this task's repo clones/)
})
function root0() { return path.join("/", "definitely-not-here") }

test("a call cannot drop the card's repos to skip the check, in one call or across two", async () => {
  const root = await codeTask([{ name: "acme/widgets", local_path: "", mode: "remote" }])
  const update = (frontmatter, extra = {}) => task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter, ...extra } })
  const proof = { kind: "non_code", ref: "https://example.invalid/x" }
  await assert.rejects(update({ status: "done", repos: [] }, { evidence: proof }), /would remove every repo from a card that names code repos.*status: "cancelled"/s)
  await assert.rejects(update({ repos: [] }), /would remove every repo/)
  await assert.rejects(update({ repos: [{ name: " " }, null] }), /would remove every repo/)
  await assert.rejects(update({ repos: "none" }), /would remove every repo/)
  const { data } = await readFront(path.join(root, "t", "ship-it", "task.md"))
  assert.equal(data.repos.length, 1)
  // Replacing the repos, adding to them and leaving them alone are fine; so is clearing them while cancelling.
  assert.equal((await update({ repos: [{ name: "acme/other", local_path: "", mode: "remote" }] })).status, "updated")
  assert.equal((await update({ title: "renamed" })).status, "updated")
  assert.equal((await update({ status: "cancelled", repos: [] })).status, "updated")
  // A card with no repos may set them to an empty list.
  const plain = await mkTempDeskRoot()
  await task_create({ deskRoot: plain, input: { track: "t", slug: "p", title: "T", status: "processing" } })
  assert.equal((await task_update({ deskRoot: plain, input: { track: "t", slug: "p", frontmatter: { repos: [] } } })).status, "updated")
})

test("a card whose repos are plain names counts as having repos", async () => {
  const root = await codeTask(["widgets"])
  await fs.writeFile(path.join(root, "t", "proof.md"), "proof\n")
  await assert.rejects(done(root, { kind: "non_code", ref: "t/proof.md" }), /`non_code` evidence cannot complete a task that names code repos.*\(widgets \(no local clone recorded\)\)/s)
  assert.equal((await done(root, { kind: "pr", ref: "https://github.com/acme/widgets/pull/4" })).status, "updated")
})

test("a GitHub PR URL must have exactly owner/repo/pull/N, so a repo name smuggled into a path or another host does not match", async () => {
  const { clone } = await makeClone("acme/widgets")
  const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
  const bad = [
    "https://github.com/evil/x/issues/https://github.com/acme/widgets/pull/5",
    "https://github.com/evil/x/pull/1/https://github.com/acme/widgets/pull/5",
    "https://evil.example/a/widgets/pull/1",
    "https://evil.example/acme/widgets/pull/1",
    "https://github.com/acme/widgets/issues/5",
    "https://github.com/acme/widgets/pull/x",
    "https://github.com/acme/pull/5",
  ]
  for (const ref of bad) await assert.rejects(done(root, { kind: "pr", ref }), /is not in this task's repos|not a checkable pr reference/, ref)
  for (const ref of ["https://github.com/acme/widgets/pull/5", "https://www.github.com/Acme/Widgets/pull/5/files", "https://github.com/acme/widgets/pull/5#issuecomment-1", "https://github.com/acme/widgets/pull/5?diff=split"]) {
    const fresh = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
    assert.equal((await done(fresh, { kind: "pr", ref })).status, "updated", ref)
  }
})

test("a non-GitHub PR URL needs an Azure DevOps shape or a host a recorded clone has a remote on", async () => {
  const { clone } = await makeClone("acme/widgets")
  git(clone, "remote", "set-url", "origin", "https://ghe.corp.example/acme/widgets.git")
  const root = await codeTask([{ name: "widgets", local_path: clone, mode: "local" }])
  assert.equal((await done(root, { kind: "pr", ref: "https://ghe.corp.example/acme/widgets/pull/3" })).status, "updated")
  const other = await codeTask([{ name: "widgets", local_path: clone, mode: "local" }])
  await assert.rejects(done(other, { kind: "pr", ref: "https://evil.example/acme/widgets/pull/3" }), /is not in this task's repos/)
  const ado = await codeTask([{ name: "widgets", local_path: "", mode: "remote" }])
  await assert.rejects(done(ado, { kind: "pr", ref: "https://evil.example/org/proj/_git/widgets/pullrequest/3" }), /is not in this task's repos/)
  await assert.rejects(done(ado, { kind: "pr", ref: "https://dev.azure.com/org/proj/widgets/pullrequest/3" }), /is not in this task's repos/)
  for (const ref of ["https://org.visualstudio.com/proj/_git/widgets/pullrequest/3", "https://dev.azure.com/org/_git/widgets/pullrequest/3?x=1"]) {
    const fresh = await codeTask([{ name: "widgets", local_path: "", mode: "remote" }])
    assert.equal((await done(fresh, { kind: "pr", ref })).status, "updated", ref)
  }
})

test("a commit URL is held to the same exact shapes", async () => {
  const { clone, pushed } = await makeClone("acme/widgets")
  const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
  await assert.rejects(done(root, { kind: "commit", ref: `https://github.com/evil/x/issues/https://github.com/acme/widgets/commit/${pushed}` }), /not in this task's repos/)
  await assert.rejects(done(root, { kind: "commit", ref: `https://evil.example/a/widgets/commit/${pushed}` }), /not in this task's repos/)
  const ado = await codeTask([{ name: "widgets", local_path: clone, mode: "local" }])
  assert.equal((await done(ado, { kind: "commit", ref: `https://dev.azure.com/o/p/_git/widgets/commit/${pushed}` })).status, "updated")
})

test("commit errors say to git fetch in the recorded clone first", async () => {
  const { clone, unpushed } = await makeClone("acme/widgets")
  const root = await codeTask([{ name: "acme/widgets", local_path: clone, mode: "local" }])
  await assert.rejects(done(root, { kind: "commit", ref: unpushed }), /run `git fetch` in that clone and repeat this call.*Otherwise push the branch/s)
  await assert.rejects(done(root, { kind: "commit", ref: "a1b2c3d4" }), /run `git fetch` in the recorded clone first and repeat this call/)
})

test("a relative local_path resolves against the desk root, not the process's working directory", async () => {
  const { clone, pushed } = await makeClone("acme/widgets")
  const root = await mkTempDeskRoot()
  await fs.symlink(clone, path.join(root, "clone-link"))
  await task_create({ deskRoot: root, input: { track: "t", slug: "ship-it", title: "T", status: "processing", repos: [{ name: "acme/widgets", local_path: "clone-link", mode: "local" }] } })
  assert.equal((await done(root, { kind: "commit", ref: pushed })).status, "updated")
})

test("a call that adds repos while finishing the task is checked against them too", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "ship-it", title: "T", status: "processing" } })
  await assert.rejects(
    task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter: { status: "done", repos: [{ name: "acme/widgets", local_path: "", mode: "remote" }] }, evidence: { kind: "ci_run", ref: "https://ci.example.invalid/1" } } }),
    /`ci_run` evidence cannot complete/,
  )
})

test("task_archive applies the same rule when it bumps a card with repos to done", async () => {
  const root = await codeTask([{ name: "acme/widgets", local_path: "", mode: "remote" }])
  await assert.rejects(
    task_archive({ deskRoot: root, input: { track: "t", slug: "ship-it", evidence: { kind: "non_code", ref: "https://example.invalid/x" } } }),
    /task_archive: `non_code` evidence cannot complete a task that names code repos/,
  )
  const ok = await task_archive({ deskRoot: root, input: { track: "t", slug: "ship-it", evidence: { kind: "pr", ref: "https://github.com/acme/widgets/pull/2" } } })
  assert.equal(ok.status, "archived")
})

test("a card with no repos is unchanged, but a non_code ref may not be the task card itself", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "ship-it", title: "T", status: "processing" } })
  await assert.rejects(
    done(root, { kind: "non_code", ref: "t/ship-it/task.md" }),
    /is the task card itself.*point at a separate proof/s,
  )
  await assert.rejects(done(root, { kind: "non_code", ref: "t/../t/ship-it/task.md" }), /is the task card itself/)
  await fs.writeFile(path.join(root, "t", "ship-it", "outcome.md"), "the outcome\n")
  assert.equal((await done(root, { kind: "non_code", ref: "t/ship-it/outcome.md" })).status, "updated")
})

test("task_archive also refuses the card itself as non_code proof", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "ship-it", title: "T", status: "processing" } })
  await assert.rejects(task_archive({ deskRoot: root, input: { track: "t", slug: "ship-it", evidence: { kind: "non_code", ref: "t/ship-it/task.md" } } }), /is the task card itself/)
})

test("recordedRepos reads only usable entries and treats anything else as no repos", () => {
  assert.deepEqual(recordedRepos("acme/widgets"), [])
  assert.deepEqual(recordedRepos(undefined), [])
  assert.deepEqual(recordedRepos([null, 3, { name: "  " }, { local_path: "x" }, "  "]), [])
  assert.deepEqual(recordedRepos([" foo "]), [{ name: "foo", localPath: "", mode: undefined, url: false }])
  assert.deepEqual(recordedRepos([{ name: " a/b ", local_path: " ~/b ", mode: "local" }, { name: "c" }]), [
    { name: "a/b", localPath: "~/b", mode: "local", url: false },
    { name: "c", localPath: "", mode: undefined, url: false },
  ])
})

test("assertCodeRepoEvidence does nothing without repos, and survives odd git results and remotes", () => {
  assertCodeRepoEvidence({ toolName: "t", evidence: { kind: "non_code", ref: "x" }, repos: [], deskRoot: "/d" })
  const repos = [{ name: "acme/widgets", localPath: "/c", mode: "local" }]
  const odd = (outputs) => (cmd, args) => (args.includes("config") ? outputs.config : outputs.other)
  // No result at all, a nonzero status and a non-string stdout all read as "git said nothing".
  for (const config of [undefined, { status: 1, stdout: "" }, { status: 0, stdout: null }]) {
    assert.throws(
      () => assertCodeRepoEvidence({ toolName: "t", evidence: { kind: "pr", ref: "https://github.com/other/x/pull/1" }, repos, deskRoot: "/d", spawnGit: odd({ config }) }),
      /not in this task's repos/,
    )
  }
  // A key with no URL, a non-URL remote and a host-only URL are skipped or read without a path.
  const config = { status: 0, stdout: "remote.a.url\nremote.b.url /srv/git/x.git\nremote.c.url https://github.com\nremote.d.url https://dev.azure.com\n" }
  assert.throws(
    () => assertCodeRepoEvidence({ toolName: "t", evidence: { kind: "pr", ref: "https://github.com/other/x/pull/1" }, repos, deskRoot: "/d", spawnGit: odd({ config }) }),
    /not in this task's repos/,
  )
})

test("resolveLocalPath expands ~, resolves a relative path against the desk root, and falls back to the working directory", async () => {
  const { resolveLocalPath } = await import("../../../../../plugins/desk/mcp/src/util/paths.js")
  assert.equal(resolveLocalPath("a/b", { homeDir: "/h", deskRoot: "/desk" }), "/desk/a/b")
  assert.equal(resolveLocalPath("~/a", { homeDir: "/h", deskRoot: "/desk" }), "/h/a")
  assert.equal(resolveLocalPath("/abs", { homeDir: "/h", deskRoot: "/desk" }), "/abs")
  assert.equal(resolveLocalPath("a"), path.resolve("a"))
})

test("removing every repo needs a repos_removed_reason, is recorded on the card, and never finishes the task in the same call", async () => {
  const root = await codeTask([{ name: "acme/widgets", local_path: "", mode: "remote" }, { name: "acme/other", local_path: "", mode: "remote" }])
  const update = (input) => task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", ...input } })
  const proof = { kind: "non_code", ref: "https://example.invalid/x" }
  await assert.rejects(update({ frontmatter: { repos: [] } }), /repos_removed_reason: "<one line on why>".*separate call.*status: "cancelled".*task-lifecycle/s)
  await assert.rejects(update({ frontmatter: { repos: [] }, repos_removed_reason: "   " }), /repos_removed_reason/)
  await assert.rejects(update({ frontmatter: { repos: [] }, repos_removed_reason: 7 }), /repos_removed_reason/)
  await assert.rejects(
    update({ frontmatter: { status: "done", repos: [] }, repos_removed_reason: "never touched them", evidence: proof }),
    /cannot also set `status: "done"`.*separate call with `non_code` evidence that is not the task card itself/s,
  )
  let { data } = await readFront(path.join(root, "t", "ship-it", "task.md"))
  assert.equal(data.repos.length, 2)
  assert.equal(data.repos_removed, undefined)
  assert.equal((await update({ frontmatter: { repos: [] }, repos_removed_reason: " the work was docs only " })).status, "updated")
  ;({ data } = await readFront(path.join(root, "t", "ship-it", "task.md")))
  assert.deepEqual(data.repos_removed.map((entry) => [entry.name, entry.reason]), [["acme/widgets", "the work was docs only"], ["acme/other", "the work was docs only"]])
  assert.match(data.repos_removed[0].at, /^\d{4}-\d{2}-\d{2}T/)
  // Finishing is a separate call; non_code works now, but not the card itself.
  await assert.rejects(update({ frontmatter: { status: "done" }, evidence: { kind: "non_code", ref: "t/ship-it/task.md" } }), /is the task card itself/)
  await fs.writeFile(path.join(root, "t", "outcome.md"), "outcome\n")
  assert.equal((await update({ frontmatter: { status: "done" }, evidence: { kind: "non_code", ref: "t/outcome.md" } })).status, "updated")
})

test("an earlier repos_removed list is kept when a later removal appends to it", async () => {
  const root = await codeTask([{ name: "a/one", local_path: "", mode: "remote" }])
  const update = (input) => task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", ...input } })
  await update({ frontmatter: { repos: [] }, repos_removed_reason: "first" })
  await update({ frontmatter: { repos: [{ name: "a/two" }] } })
  await update({ frontmatter: { repos: [] }, repos_removed_reason: "second" })
  const { data } = await readFront(path.join(root, "t", "ship-it", "task.md"))
  assert.deepEqual(data.repos_removed.map((entry) => [entry.name, entry.reason]), [["a/one", "first"], ["a/two", "second"]])
})

test("ssh remotes with a login and a port match the same host in an https PR URL, and legacy visualstudio.com DefaultCollection URLs match", async () => {
  const { clone } = await makeClone("acme/widgets")
  git(clone, "remote", "set-url", "origin", "ssh://git@ghe.corp.example:2222/acme/widgets.git")
  const root = await codeTask([{ name: "widgets", local_path: clone, mode: "local" }])
  assert.equal((await done(root, { kind: "pr", ref: "https://ghe.corp.example:8443/acme/widgets/pull/3" })).status, "updated")
  const ado = await codeTask([{ name: "widgets", local_path: "", mode: "remote" }])
  assert.equal((await done(ado, { kind: "pr", ref: "https://org.visualstudio.com/DefaultCollection/proj/_git/widgets/pullrequest/3" })).status, "updated")
  const bare = await codeTask([{ name: "widgets", local_path: "", mode: "remote" }])
  assert.equal((await done(bare, { kind: "pr", ref: "https://org.visualstudio.com/DefaultCollection/_git/widgets/pullrequest/3" })).status, "updated")
})
