// A card written from a worktree on a feature branch lands on the remote's default branch. The worktree's own branch gets no
// commit, and the main checkout's HEAD, index and working tree are left as they were.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { friction_add } from "../../../../../plugins/desk/mcp/src/tools/friction.js"
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
  const featureHead = git(worktree, ["rev-parse", "HEAD"])

  const result = await friction_add({ deskRoot: worktree, input: { body: "## 2026-11-12 — worktree write\n\nLands on main." }, schedulePush: noPush })

  assert.equal(result.commit, undefined, `committed on the default branch: ${JSON.stringify(result.commit)}`)
  assert.match(remoteFile(origin, "_meta/friction.md").stdout, /Lands on main\./u, "origin/main holds the card")
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), featureHead, "the feature branch got no commit")
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
