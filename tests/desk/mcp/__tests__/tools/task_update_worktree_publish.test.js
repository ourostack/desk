// task_update from a worktree on a feature branch, in a repository whose published content-home policy needs HEAD to be the
// published commit: the card is published to the default branch, the worktree catches up, and the next write is admitted.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot } from "./_helpers.js"

const POLICY = {
  schema_version: 1,
  mode: "declared-purpose",
  repository: "sample/context",
  context_purposes: ["coordination"],
  product_purposes: ["product-contract"],
}
const CARD = "---\nschema_version: 1\ntitle: Existing work\nstatus: processing\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Existing work\n\n**Next step:** Keep the existing owner.\n"
const CONTEXT = { purpose: "coordination", lifecycle: "current" }

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

async function fixture() {
  const root = await mkTempDeskRoot()
  const origin = `${root}-origin.git`
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8" })
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  await fs.mkdir(path.join(root, "track/existing"), { recursive: true })
  await fs.mkdir(path.join(root, ".desk"))
  await fs.writeFile(path.join(root, "track/existing/task.md"), CARD)
  await fs.writeFile(path.join(root, ".desk/content-home.json"), JSON.stringify(POLICY))
  git(root, ["add", "."])
  git(root, ["commit", "-q", "-m", "Published context"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-q", "-u", "origin", "main"])
  git(root, ["remote", "set-head", "origin", "main"])
  const worktree = `${root}-feature`
  git(root, ["worktree", "add", "-q", "-b", "feature-card", worktree, "origin/main"])
  return { origin, worktree }
}

const update = (deskRoot, input, spawnGit) => task_update({ deskRoot, input: { track: "track", slug: "existing", content_home: CONTEXT, ...input }, schedulePush() {}, ...(spawnGit ? { spawnGit } : {}) })
const remoteCard = (origin) => spawnSync("git", ["--git-dir", origin, "show", "main:track/existing/task.md"], { encoding: "utf8" }).stdout

test("a task_update from a worktree is published, leaves nothing staged, and does not block the next one", async () => {
  const { origin, worktree } = await fixture()

  const first = await update(worktree, { note: "First update." })

  assert.equal(first.status, "updated")
  assert.equal(first.desk_pushed, true, "the card is already on the remote")
  assert.match(first.desk_note, /already on the remote/u)
  assert.equal(first.desk_commit, git(worktree, ["rev-parse", "--short", "origin/main"]))
  assert.equal(first.commit, undefined)
  assert.match(remoteCard(origin), /First update\./u)
  assert.equal(git(worktree, ["status", "--porcelain"]), "", "no staged or modified file is left behind")
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), git(worktree, ["rev-parse", "@{upstream}"]), "HEAD is the published commit, which the content-home check needs")

  const second = await update(worktree, { note: "Second update." })

  assert.equal(second.status, "updated")
  const remote = remoteCard(origin)
  assert.match(remote, /First update\./u)
  assert.match(remote, /Second update\./u)
  assert.equal(git(worktree, ["status", "--porcelain"]), "")
})

test("a push cut off after the remote took the card is reported as published", async () => {
  const { origin, worktree } = await fixture()
  const cutOff = (command, args, options) => {
    const result = spawnSync(command, args, options)
    return command === "git" && args.includes("push") ? { status: null, stdout: "", stderr: "" } : result
  }

  const answer = await update(worktree, { note: "Cut off." }, cutOff)

  assert.equal(answer.status, "updated")
  assert.equal(answer.commit, undefined, `a landed write has no failure: ${JSON.stringify(answer.commit)}`)
  assert.equal(answer.desk_pushed, true)
  assert.match(remoteCard(origin), /Cut off\./u)
  assert.equal(git(worktree, ["status", "--porcelain"]), "")
})
