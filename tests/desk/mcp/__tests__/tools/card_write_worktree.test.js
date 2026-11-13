// A card written from a worktree on a feature branch lands on the remote's default branch. The worktree's own branch gets no
// commit, and the main checkout's HEAD, index and working tree are left as they were.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { friction_add } from "../../../../../plugins/desk/mcp/src/tools/friction.js"
import { commitPaths } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
import { deliveryIsPublication } from "../../../../../plugins/desk/mcp/src/util/main-publish.js"
import { deliver } from "../../../../../plugins/desk/mcp/src/runtime/deliver.js"
import { schedulePush } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { mkTempDeskRoot } from "./_helpers.js"

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

// A main checkout on `main`, pushed to a bare origin whose default branch `origin/HEAD` names, and a worktree on `feature-card` made from origin/main.
async function mainAndWorktree() {
  const root = await mkTempDeskRoot()
  const origin = `${root}-origin.git`
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8" })
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  await fs.writeFile(path.join(root, "README.md"), "seed\n", "utf8")
  git(root, ["add", "README.md"])
  git(root, ["commit", "-q", "-m", "seed"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-q", "-u", "origin", "main"])
  git(root, ["remote", "set-head", "origin", "main"])
  const worktree = `${root}-feature`
  git(root, ["worktree", "add", "-q", "-b", "feature-card", worktree, "origin/main"])
  return { root, origin, worktree }
}

const remoteFile = (origin, rel) => spawnSync("git", ["--git-dir", origin, "show", `main:${rel}`], { encoding: "utf8" })
const noPush = () => {}

test("a card written from a worktree on a feature branch lands on origin/main, and the main checkout is not disturbed", async () => {
  const { root, origin, worktree } = await mainAndWorktree()
  await fs.writeFile(path.join(root, "unrelated.txt"), "not mine\n", "utf8")
  const mainHead = git(root, ["rev-parse", "HEAD"])
  const mainStatus = git(root, ["status", "--porcelain"])
  const result = await friction_add({ deskRoot: worktree, input: { body: "## 2026-11-12 — worktree write\n\nLands on main." }, schedulePush: noPush })

  assert.equal(result.commit, undefined, `committed on the default branch: ${JSON.stringify(result.commit)}`)
  assert.match(remoteFile(origin, "_meta/friction.md").stdout, /Lands on main\./u, "origin/main holds the card")
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), git(worktree, ["rev-parse", "origin/main"]), "the feature branch has no commit of its own: it fast-forwards to the published one")
  assert.equal(git(worktree, ["status", "--porcelain"]), "", "nothing is left staged in the worktree")
  assert.equal(git(root, ["rev-parse", "HEAD"]), mainHead, "the main checkout's HEAD did not move")
  assert.equal(git(root, ["status", "--porcelain"]), mainStatus, "the main checkout's working tree and index are as they were")
  assert.equal(await fs.readFile(path.join(root, "unrelated.txt"), "utf8"), "not mine\n")
  await assert.rejects(fs.access(path.join(root, "_meta", "friction.md")), "the main checkout has no copy of the card")
})

test("a second card write from the same worktree lands on origin/main too", async () => {
  const { origin, worktree } = await mainAndWorktree()
  await friction_add({ deskRoot: worktree, input: { body: "## 2026-11-12 — first\n\nFirst entry." }, schedulePush: noPush })

  const second = await friction_add({ deskRoot: worktree, input: { body: "## 2026-11-12 — second\n\nSecond entry." }, schedulePush: noPush })

  assert.equal(second.commit, undefined, `committed on the default branch: ${JSON.stringify(second.commit)}`)
  const remote = remoteFile(origin, "_meta/friction.md").stdout
  assert.match(remote, /First entry\./u)
  assert.match(remote, /Second entry\./u)
})

// Stands in for one git call (matched on its arguments) with a fixed answer; every other call runs for real.
const answering = (matches, result) => (command, args, options) => (matches(command, args) ? result : spawnSync(command, args, options))
const gitCall = (...words) => (command, args) => command === "git" && words.every((word) => args.includes(word))

test("a card written from a worktree is published by Desk's own path, and its delivery never moves the feature branch", async () => {
  const { root, worktree } = await mainAndWorktree()
  assert.equal(deliveryIsPublication(worktree), true)
  assert.equal(deliveryIsPublication(root), false)
  const spawned = []
  schedulePush({ root: worktree, env: {}, spawnWorker: (options) => spawned.push(options) })
  schedulePush({ root, env: {}, spawnWorker: (options) => spawned.push(options) })
  assert.deepEqual(spawned.map((options) => options.root), [root], "only the main checkout schedules the push worker")
  const head = git(worktree, ["rev-parse", "HEAD"])
  const delivered = deliver({ root: worktree })
  assert.equal(delivered.state, "nothing")
  assert.equal(delivered.checkout.state, "other_branch")
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), head)
})

test("a commit the remote cannot take is refused with what happened, its cause and the next step, and leaves the feature branch alone", async () => {
  const { worktree } = await mainAndWorktree()
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])
  const head = git(worktree, ["rev-parse", "HEAD"])
  const cases = [
    [gitCall("--full-name"), { status: 1, stdout: "", stderr: "" }, /could not read the staged entries/u, "absent"],
    [gitCall("--full-name"), { status: 0, stdout: "100644 0123456789012345678901234567890123456789 1\tnotes.md\0", stderr: "" }, /has a merge conflict/u, "absent"],
    [gitCall("fetch"), { status: null }, /could not fetch origin\/main: git fetch failed/u, "unknown"],
    [gitCall("read-tree"), { status: 1, stdout: "", stderr: "" }, /could not read origin\/main into a private index/u, "absent"],
    [gitCall("update-index"), { status: 1, stdout: "", stderr: "" }, /could not stage notes\.md/u, "absent"],
    [gitCall("write-tree"), { status: 1, stdout: "", stderr: "" }, /could not write the tree/u, "absent"],
    [gitCall("commit-tree"), { status: 1, stdout: "", stderr: "" }, /could not create the commit/u, "absent"],
    [gitCall("push"), { status: 128, stdout: "", stderr: "fatal: unrelated" }, /remote refused the push to main\. Probable cause: the remote rejected the commit/u, "absent"],
    [gitCall("push"), { status: null, stdout: "", stderr: "" }, /the push was cut off/u, "unknown"],
  ]
  for (const [matches, result, message, readback] of cases) {
    const refused = commitPaths(worktree, ["notes.md"], "notes", answering(matches, result))
    assert.equal(refused.ok, false, String(message))
    assert.match(refused.stderr, /^Desk did not commit notes\.md: .*Probable cause: .*Look further: .*Keep working: /u)
    assert.match(refused.stderr, message)
    assert.equal(refused.readback, readback)
  }
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), head, "the feature branch got no commit")
})

test("a push the remote keeps rejecting is tried a bounded number of times, then reported", async () => {
  const { origin, worktree } = await mainAndWorktree()
  await fs.writeFile(path.join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho declined >&2\nexit 1\n", "utf8")
  await fs.chmod(path.join(origin, "hooks", "pre-receive"), 0o755)
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])
  const refused = commitPaths(worktree, ["notes.md"], "notes", spawnSync)
  assert.equal(refused.ok, false)
  assert.match(refused.stderr, /kept rejecting the push to main after 3 tries/u)
})

test("a repository whose publication policy cannot be read refuses the write before anything is pushed", async () => {
  const { root, origin, worktree } = await mainAndWorktree()
  await fs.mkdir(path.join(root, ".desk"))
  await fs.writeFile(path.join(root, ".desk", "publication.json"), "not json\n", "utf8")
  git(root, ["add", ".desk"])
  git(root, ["commit", "-q", "-m", "policy"])
  git(root, ["push", "-q", "origin", "main"])
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])
  const refused = commitPaths(worktree, ["notes.md"], "notes", spawnSync)
  assert.equal(refused.ok, false)
  assert.match(refused.stderr, /is not valid JSON/u)
  assert.notEqual(spawnSync("git", ["--git-dir", origin, "show", "main:notes.md"], { encoding: "utf8" }).status, 0, "nothing reached main")
})

test("a repository with a pull-request policy hands the commit to its pull request, and a failed pull request is reported", async () => {
  const { root, worktree } = await mainAndWorktree()
  await fs.mkdir(path.join(root, ".desk"))
  await fs.writeFile(path.join(root, ".desk", "publication.json"), JSON.stringify({ schema_version: 1, mode: "pull-request", required_checks: ["ci"] }), "utf8")
  git(root, ["add", ".desk"])
  git(root, ["commit", "-q", "-m", "policy"])
  git(root, ["push", "-q", "origin", "main"])
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])
  const refused = commitPaths(worktree, ["notes.md"], "notes", answering((command) => command === "gh", { status: 1, stdout: "", stderr: "" }))
  assert.equal(refused.ok, false)
  assert.match(refused.stderr, /publication pull request did not merge/u)
  assert.equal(refused.readback, "unknown")
})

test("a card write that changes nothing on the default branch succeeds without a new commit, and a removed card is removed from it", async () => {
  const { origin, worktree } = await mainAndWorktree()
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])
  assert.equal(commitPaths(worktree, ["notes.md"], "notes", spawnSync).ok, true)
  const once = spawnSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim()
  assert.equal(commitPaths(worktree, ["notes.md"], "again", spawnSync).ok, true)
  assert.equal(spawnSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim(), once, "no commit for an unchanged card")
  git(worktree, ["rm", "-q", "README.md"])
  assert.equal(commitPaths(worktree, ["README.md"], "remove", spawnSync).ok, true)
  assert.notEqual(spawnSync("git", ["--git-dir", origin, "cat-file", "-e", "main:README.md"], { encoding: "utf8" }).status, 0, "the removal reached main")
})

test("a worktree branch with commits of its own keeps them, and the published card is not left staged", async () => {
  const { worktree } = await mainAndWorktree()
  await fs.writeFile(path.join(worktree, "own.txt"), "mine\n", "utf8")
  git(worktree, ["add", "own.txt"])
  git(worktree, ["commit", "-q", "-m", "own work"])
  const head = git(worktree, ["rev-parse", "HEAD"])

  const result = await friction_add({ deskRoot: worktree, input: { body: "## 2026-11-12 — own commits\n\nStill published." }, schedulePush: noPush })

  assert.equal(result.commit, undefined)
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), head, "the branch's own commit stays where it was")
  assert.equal(git(worktree, ["diff", "--cached", "--name-only"]), "", "the published card is no longer staged")
  assert.match(await fs.readFile(path.join(worktree, "_meta", "friction.md"), "utf8"), /Still published\./u, "the card on disk is untouched")
})

// Runs the call for real, then reports it cut off, as a client's timeout would look from the tool.
const cutOffAfter = (matches, extra) => (command, args, options) => {
  const result = spawnSync(command, args, options)
  return matches(command, args) ? (extra?.(args), { status: null, stdout: "", stderr: "" }) : result
}

test("a push cut off after the remote took the commit is a landed write, not a failure", async () => {
  const { origin, worktree } = await mainAndWorktree()
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])

  const written = commitPaths(worktree, ["notes.md"], "notes", cutOffAfter(gitCall("push")))

  assert.equal(written.ok, true, written.stderr)
  assert.equal(remoteFile(origin, "notes.md").stdout, "hi\n")
  assert.equal(git(worktree, ["status", "--porcelain"]), "")
})

test("a publication pull request that merged before the call was cut off is a landed write", async () => {
  const { root, origin, worktree } = await mainAndWorktree()
  await fs.mkdir(path.join(root, ".desk"))
  await fs.writeFile(path.join(root, ".desk", "publication.json"), JSON.stringify({ schema_version: 1, mode: "pull-request", required_checks: ["ci"] }), "utf8")
  git(root, ["add", ".desk"])
  git(root, ["commit", "-q", "-m", "policy"])
  git(root, ["push", "-q", "origin", "main"])
  git(worktree, ["merge", "-q", "--ff-only", "origin/main"])
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])
  // Desk reads the remote as a GitHub repository; GitHub then merges the branch Desk pushed, and the gh call that would have said so is cut off.
  const merging = (command, args, options) => {
    if (gitCall("get-url")(command, args)) return { status: 0, stdout: "https://github.com/sample/context.git\n", stderr: "" }
    if (command !== "gh") return spawnSync(command, args, options)
    const branch = args.find((word) => word.startsWith("desk/publish/"))
    if (branch !== undefined) spawnSync("git", ["--git-dir", origin, "update-ref", "refs/heads/main", branch.replace("desk/publish/", "")], { encoding: "utf8" })
    return { status: null, stdout: "", stderr: "" }
  }

  const written = commitPaths(worktree, ["notes.md"], "notes", merging)

  assert.equal(written.ok, true, written.stderr)
  assert.equal(remoteFile(origin, "notes.md").stdout, "hi\n")
})

test("a worktree that cannot fast-forward without overwriting local work keeps that work, and the published card is unstaged", async () => {
  const { root, worktree } = await mainAndWorktree()
  await fs.writeFile(path.join(root, "README.md"), "moved on\n", "utf8")
  git(root, ["commit", "-q", "-am", "main moved"])
  git(root, ["push", "-q", "origin", "main"])
  await fs.writeFile(path.join(worktree, "README.md"), "my local edit\n", "utf8")
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])
  const head = git(worktree, ["rev-parse", "HEAD"])

  assert.equal(commitPaths(worktree, ["notes.md"], "notes", spawnSync).ok, true)

  assert.equal(git(worktree, ["rev-parse", "HEAD"]), head, "the branch did not move over the local edit")
  assert.equal(await fs.readFile(path.join(worktree, "README.md"), "utf8"), "my local edit\n")
  assert.equal(git(worktree, ["diff", "--cached", "--name-only"]), "")
})

test("a staged card that changed since Desk published it stays staged", async () => {
  const { worktree } = await mainAndWorktree()
  await fs.writeFile(path.join(worktree, "own.txt"), "mine\n", "utf8")
  git(worktree, ["add", "own.txt"])
  git(worktree, ["commit", "-q", "-m", "own work"])
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])
  let listings = 0
  const changedMeanwhile = (command, args, options) => (gitCall("ls-files")(command, args) && (listings += 1) === 2 ? { status: 0, stdout: "", stderr: "" } : spawnSync(command, args, options))

  assert.equal(commitPaths(worktree, ["notes.md"], "notes", changedMeanwhile).ok, true)

  assert.equal(git(worktree, ["diff", "--cached", "--name-only"]), "notes.md")
})

test("a push cut off when the remote cannot be read back is still reported as unknown", async () => {
  const { worktree } = await mainAndWorktree()
  await fs.writeFile(path.join(worktree, "notes.md"), "hi\n", "utf8")
  git(worktree, ["add", "notes.md"])
  let fetches = 0
  const unreachable = (command, args, options) => {
    if (gitCall("push")(command, args)) return { status: null, stdout: "", stderr: "" }
    return gitCall("fetch")(command, args) && (fetches += 1) === 2 ? { status: 128, stdout: "", stderr: "unreachable" } : spawnSync(command, args, options)
  }

  const refused = commitPaths(worktree, ["notes.md"], "notes", unreachable)

  assert.equal(refused.ok, false)
  assert.equal(refused.readback, "unknown")
})
