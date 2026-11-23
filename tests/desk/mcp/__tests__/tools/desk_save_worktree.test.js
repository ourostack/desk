import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { publishCardCommit } from "../../../../../plugins/desk/mcp/src/util/main-publish.js"
import { mkTempDeskRoot } from "./_helpers.js"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

async function fixture({ diverged = false, pullRequest = false } = {}) {
  const base = await mkTempDeskRoot()
  const root = path.join(base, "desk")
  const origin = path.join(base, "origin.git")
  const worktree = path.join(base, "worktree")
  await fs.mkdir(root)
  git(base, ["init", "-q", "--bare", "-b", "main", origin])
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  await fs.mkdir(path.join(root, "track/outcome"), { recursive: true })
  await fs.writeFile(path.join(root, "track/outcome/task.md"), "---\nschema_version: 1\ntitle: Outcome\nstatus: cancelled\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Outcome\n")
  await fs.writeFile(path.join(root, "unrelated.md"), "original\n")
  await fs.mkdir(path.join(root, "notes"))
  await fs.writeFile(path.join(root, "notes/old.md"), "old\n")
  if (pullRequest) {
    await fs.mkdir(path.join(root, ".desk"))
    await fs.writeFile(path.join(root, ".desk/publication.json"), JSON.stringify({ schema_version: 1, mode: "pull-request", required_checks: ["ci"] }))
  }
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Seed"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-q", "-u", "origin", "main"])
  git(root, ["remote", "set-head", "origin", "main"])
  git(root, ["worktree", "add", "-q", "-b", "save-lane", worktree, "origin/main"])
  if (diverged) {
    await fs.writeFile(path.join(worktree, "lane.md"), "Earlier local archive work\n")
    git(worktree, ["add", "lane.md"])
    git(worktree, ["commit", "-qm", "Earlier local work"])
  }
  for (let i = 0; i < 31; i += 1) git(root, ["commit", "--allow-empty", "-qm", `Other work ${i}`])
  git(root, ["push", "-q", "origin", "main"])
  return { root, worktree }
}

const save = (deskRoot, name, extra = {}) => desk_save({
  deskRoot,
  input: { files: [{ path: `track/outcome/${name}.md`, content: `${name}\n` }], message: `Save ${name}` },
  schedulePush() { throw new Error("An already published save needs no background push") },
  ...extra,
})

test("two saves from a stale worktree return the commits containing their own files", async () => {
  const { root, worktree } = await fixture({ diverged: true })
  const first = await save(worktree, "first", { schedulePush() {} })
  const second = await save(worktree, "second", { env: { ...process.env, DESK_HOSTED: "1" }, schedulePush() {} })
  assert.equal(first.status, "committed")
  assert.equal(second.status, "committed")
  assert.notEqual(first.desk_commit, second.desk_commit)
  assert.equal(git(worktree, ["show", `${first.desk_commit}:track/outcome/first.md`]), "first")
  assert.equal(git(worktree, ["show", `${second.desk_commit}:track/outcome/second.md`]), "second")
  assert.equal(git(root, ["show", "origin/main:track/outcome/second.md"]), "second")
  assert.equal(second.desk_pushed, true)
})

test("a published new companion is tracked locally and can be archived without adopting dirty files", async () => {
  const { worktree } = await fixture({ diverged: true })
  const result = await save(worktree, "proof", { schedulePush() {} })
  assert.equal(result.status, "committed")
  assert.equal(git(worktree, ["status", "--porcelain"]), "")
  assert.equal(git(worktree, ["show", "HEAD:track/outcome/proof.md"]), "proof")
  assert.equal(git(worktree, ["show", "HEAD:lane.md"]), "Earlier local archive work")
  const archived = await task_archive({ deskRoot: worktree, input: { track: "track", slug: "outcome" }, schedulePush() {} })
  assert.equal(archived.status, "archived", JSON.stringify(archived))
  assert.equal(git(worktree, ["show", "HEAD:track/_archive/outcome/proof.md"]), "proof")
  assert.equal(git(worktree, ["status", "--porcelain"]), "")
})

test("published saves preserve unrelated staged and unstaged work", async () => {
  const { root, worktree } = await fixture({ diverged: true })
  await fs.writeFile(path.join(worktree, "unrelated.md"), "local edit\n")
  await fs.writeFile(path.join(worktree, "other.md"), "staged work\n")
  git(worktree, ["add", "other.md"])
  const result = await save(worktree, "proof", { schedulePush() {} })
  assert.equal(result.status, "committed")
  assert.equal(git(worktree, ["status", "--porcelain"]), "A  other.md\n M unrelated.md")
  assert.equal(await fs.readFile(path.join(worktree, "unrelated.md"), "utf8"), "local edit\n")
  assert.equal(git(root, ["show", "origin/main:unrelated.md"]), "original")
  assert.equal(git(worktree, ["show", "HEAD:track/outcome/proof.md"]), "proof")
  assert.equal(git(worktree, ["show", "HEAD:lane.md"]), "Earlier local archive work")
})

test("a refused fast-forward commits the published save locally without overwriting conflicting work", async () => {
  const { root, worktree } = await fixture()
  await fs.writeFile(path.join(root, "unrelated.md"), "remote edit\n")
  git(root, ["add", "unrelated.md"])
  git(root, ["commit", "-qm", "Remote edit"])
  git(root, ["push", "-q", "origin", "main"])
  await fs.writeFile(path.join(worktree, "unrelated.md"), "local edit\n")
  const result = await save(worktree, "proof", { schedulePush() {} })
  assert.equal(result.status, "committed")
  assert.equal(result.desk_pushed, true)
  assert.equal(result.checkout.state, "saved_locally")
  assert.equal(result.checkout.reason, "local_changes")
  assert.equal(git(worktree, ["show", `${result.desk_commit}:track/outcome/proof.md`]), "proof")
  assert.equal(git(worktree, ["show", "HEAD:track/outcome/proof.md"]), "proof")
  assert.equal(await fs.readFile(path.join(worktree, "unrelated.md"), "utf8"), "local edit\n")
})

test("a refused local commit reports publication separately and keeps the captured save staged", async () => {
  const { worktree } = await fixture({ diverged: true })
  const refuseCommit = (command, args, options) => args.includes("write-tree") && options.env?.GIT_INDEX_FILE?.includes("desk-finish-")
    ? { status: 1, stdout: "", stderr: "local index write refused" }
    : spawnSync(command, args, options)
  const result = await save(worktree, "proof", { spawnGit: refuseCommit, schedulePush() {} })
  assert.equal(result.status, "committed")
  assert.equal(result.desk_pushed, true)
  assert.equal(result.checkout.state, "behind")
  assert.equal(result.checkout.local_commit.status, "failed")
  assert.match(result.checkout.local_commit.reason, /local index write refused/)
  assert.equal(git(worktree, ["show", `${result.desk_commit}:track/outcome/proof.md`]), "proof")
  assert.equal(git(worktree, ["show", ":track/outcome/proof.md"]), "proof")
})

test("a folder save publishes its captured children and removes deleted children", async () => {
  const { root, worktree } = await fixture({ diverged: true })
  await fs.unlink(path.join(worktree, "notes/old.md"))
  await fs.writeFile(path.join(worktree, "notes/proof.md"), "folder proof\n")
  const result = await desk_save({
    deskRoot: worktree,
    input: { paths: ["notes/"], message: "Save folder" },
    schedulePush() {},
  })
  assert.equal(result.status, "committed")
  assert.equal(git(root, ["show", "origin/main:notes/proof.md"]), "folder proof")
  assert.equal(git(root, ["ls-tree", "-r", "--name-only", "origin/main", "--", "notes/"]), "notes/proof.md")
  assert.equal(git(worktree, ["show", `${result.desk_commit}:notes/proof.md`]), "folder proof")
  assert.equal(result.checkout.state, "saved_locally", JSON.stringify(result.checkout))
  assert.equal(git(worktree, ["status", "--porcelain"]), "")
})

test("a timed-out push names the save commit even when a later remote commit replaces its bytes", async () => {
  const { root, worktree } = await fixture({ diverged: true })
  let replaced = false
  const cutAfterPush = (command, args, options) => {
    const result = spawnSync(command, args, options)
    if (!replaced && args.includes("push") && result.status === 0) {
      replaced = true
      git(root, ["fetch", "-q", "origin", "main"])
      git(root, ["merge", "--ff-only", "-q", "origin/main"])
      writeFileSync(path.join(root, "track/outcome/proof.md"), "later writer\n")
      git(root, ["add", "track/outcome/proof.md"])
      git(root, ["commit", "-qm", "Later writer"])
      git(root, ["push", "-q", "origin", "main"])
      return { status: null, stdout: "", stderr: "" }
    }
    return result
  }
  const result = await save(worktree, "proof", { spawnGit: cutAfterPush, schedulePush() {} })
  assert.equal(result.status, "committed")
  assert.equal(result.desk_pushed, true)
  assert.equal(git(root, ["show", "origin/main:track/outcome/proof.md"]), "later writer")
  assert.equal(git(worktree, ["show", `${result.desk_commit}:track/outcome/proof.md`]), "proof")
  git(worktree, ["merge-base", "--is-ancestor", result.desk_commit, "origin/main"])
})

for (const cutOff of [false, true]) {
  test(`a merged publication PR ${cutOff ? "with a cut-off reply" : "with a normal reply"} names the save before a later writer replaces its bytes`, async () => {
    const { root, worktree } = await fixture({ diverged: true, pullRequest: true })
    let pr
    const mergeThenReplace = (command, args, options) => {
      if (command === "git" && args.includes("get-url")) return { status: 0, stdout: "https://github.com/sample/context.git\n", stderr: "" }
      if (command !== "gh") return spawnSync(command, args, options)
      if (pr === undefined) {
        const branch = args.find((word) => word.startsWith("desk/publish/"))
        const candidate = branch.slice("desk/publish/".length)
        git(root, ["fetch", "-q", "origin", branch])
        git(root, ["merge", "--ff-only", "-q", "FETCH_HEAD"])
        git(root, ["push", "-q", "origin", "main"])
        pr = { number: 1, url: "https://github.com/sample/context/pull/1", state: "MERGED", isDraft: false, headRefOid: candidate, baseRefName: "main", mergeCommit: { oid: candidate } }
        writeFileSync(path.join(root, "track/outcome/proof.md"), "later writer\n")
        git(root, ["commit", "-qam", "Later writer"])
        git(root, ["push", "-q", "origin", "main"])
        if (cutOff) return { status: null, stdout: "", stderr: "" }
      }
      return { status: 0, stdout: JSON.stringify(args.includes("list") ? [pr] : pr), stderr: "" }
    }
    const result = await save(worktree, "proof", { spawnGit: mergeThenReplace, schedulePush() {} })
    assert.equal(result.status, "committed", JSON.stringify(result))
    assert.equal(result.desk_pushed, true)
    assert.equal(git(root, ["show", "origin/main:track/outcome/proof.md"]), "later writer")
    assert.equal(git(worktree, ["show", `${result.desk_commit}:track/outcome/proof.md`]), "proof")
    git(worktree, ["merge-base", "--is-ancestor", result.desk_commit, "origin/main"])
    assert.equal(result.checkout.state, "saved_locally")
    assert.equal(git(worktree, ["show", "HEAD:track/outcome/proof.md"]), "proof")
    assert.equal(git(worktree, ["status", "--porcelain"]), "")
  })
}

for (const [treeRead, unread, published] of [[1, true, false], [2, false, false], [3, true, true]]) {
  test(`publication refuses ${["", "an unreadable remote capture", "a built tree missing saved bytes", "an unreadable published receipt"][treeRead]} without inventing success`, async () => {
    const { root, worktree } = await fixture()
    await fs.writeFile(path.join(worktree, "track/outcome/proof.md"), "proof\n")
    git(worktree, ["add", "track/outcome/proof.md"])
    let reads = 0
    const refuseTree = (command, args, options) => args.includes("ls-tree") && args.includes("-r") && ++reads === treeRead
      ? { status: unread ? 1 : 0, stdout: "", stderr: "tree unreadable" }
      : spawnSync(command, args, options)
    const result = publishCardCommit({ root: worktree, relPaths: ["track/outcome/proof.md"], message: "Save proof", defaultBranch: "main", spawnGit: refuseTree })
    assert.equal(result.ok, false)
    assert.equal(result.readback, published ? "unknown" : "absent")
    const remote = spawnSync("git", ["-C", root, "show", "origin/main:track/outcome/proof.md"], { encoding: "utf8" })
    assert.equal(remote.status === 0, published)
    assert.equal(git(worktree, ["show", ":track/outcome/proof.md"]), "proof")
  })
}

for (const reason of ["head_unread", "ancestry_unread"]) {
  test(`a published save with ${reason} preserves local history through a scoped capture commit`, async () => {
    const { worktree } = await fixture({ diverged: true })
    const earlier = git(worktree, ["rev-parse", "HEAD"])
    const unreadCheckout = (command, args, options) => (reason === "head_unread" && args.includes("HEAD^{commit}")) || (reason === "ancestry_unread" && args.includes("merge-base"))
      ? { status: 2, stdout: "", stderr: "checkout read refused" }
      : spawnSync(command, args, options)
    const result = await save(worktree, "proof", { spawnGit: unreadCheckout, schedulePush() {} })
    assert.equal(result.status, "committed")
    assert.equal(result.desk_pushed, true)
    assert.deepEqual(result.checkout, { state: "saved_locally", reason })
    git(worktree, ["merge-base", "--is-ancestor", earlier, "HEAD"])
    assert.equal(git(worktree, ["show", "HEAD:track/outcome/proof.md"]), "proof")
  })
}

for (const status of [1, 0]) {
  test(`an unreadable local branch (exit ${status}) leaves a published save staged and reports the separate checkout failure`, async () => {
    const { worktree } = await fixture({ diverged: true })
    let published = false
    const unreadBranch = (command, args, options) => {
      if (published && args.includes("symbolic-ref")) return { status, stdout: "", stderr: "branch unreadable" }
      const result = spawnSync(command, args, options)
      if (args.includes("push") && result.status === 0) published = true
      return result
    }
    const result = await save(worktree, "proof", { spawnGit: unreadBranch, schedulePush() {} })
    assert.equal(result.status, "committed")
    assert.equal(result.desk_pushed, true)
    assert.equal(result.checkout.local_commit.status, "failed")
    assert.match(result.checkout.local_commit.reason, /branch could not be read/)
    assert.equal(git(worktree, ["show", `${result.desk_commit}:track/outcome/proof.md`]), "proof")
    assert.equal(git(worktree, ["show", ":track/outcome/proof.md"]), "proof")
  })
}

test("a cut-off local branch update with unreadable readback reports unknown local state without losing the published receipt", async () => {
  const { worktree } = await fixture({ diverged: true })
  let cut = false
  const cutLocalUpdate = (command, args, options) => {
    if (args.includes("update-ref") && args.includes("refs/heads/save-lane")) cut = true
    return cut && (args.includes("update-ref") || (args.includes("rev-parse") && (args.includes("HEAD") || args.includes("refs/heads/save-lane"))))
      ? { status: null, stdout: "", stderr: "" }
      : spawnSync(command, args, options)
  }
  const result = await save(worktree, "proof", { spawnGit: cutLocalUpdate, schedulePush() {} })
  assert.equal(result.status, "committed")
  assert.equal(result.desk_pushed, true)
  assert.equal(result.checkout.local_commit.status, "unknown")
  assert.equal(git(worktree, ["show", `${result.desk_commit}:track/outcome/proof.md`]), "proof")
  assert.equal(git(worktree, ["show", ":track/outcome/proof.md"]), "proof")
})
