import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { commitWaitingLogs } from "../../../../../plugins/desk/mcp/src/runtime/append-lane.js"
import { commitPaths, indexLooksLost } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
import { publishCardCommit } from "../../../../../plugins/desk/mcp/src/util/main-publish.js"
import { removeTree } from "../_remove_tree.js"

// A card or log publish may change only the card paths it was asked for, and never builds from a lost index.

const git = (root, args) => {
  const where = root.endsWith(".git") ? ["--git-dir", root] : ["-C", root]
  const result = spawnSync("git", [...where, ...args], { encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

// A desk with 30 files on origin/main and a worktree on another branch, so card writes publish.
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "desk-publish-guards-"))
  t.after(() => removeTree(base))
  const root = path.join(base, "desk")
  const origin = path.join(base, "origin.git")
  const lane = path.join(base, "lane")
  await fs.mkdir(root)
  git(base, ["init", "-q", "--bare", "-b", "main", origin])
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  await fs.mkdir(path.join(root, "t/card"), { recursive: true })
  await fs.writeFile(path.join(root, "t/card/task.md"), "card\n")
  await fs.writeFile(path.join(root, "t/card/log.md"), "old\n")
  for (let i = 0; i < 30; i += 1) await fs.writeFile(path.join(root, `other-${i}.md`), `${i}\n`)
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Seed"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-q", "-u", "origin", "main"])
  git(root, ["remote", "set-head", "origin", "main"])
  git(root, ["worktree", "add", "-q", "-b", "lane", lane, "origin/main"])
  return { lane, origin }
}

const filesOn = (origin) => git(origin, ["ls-tree", "-r", "--name-only", "main"]).split("\n").length

test("a requested path that is the repository root is refused and nothing is published", async (t) => {
  const { lane, origin } = await fixture(t)
  const before = git(origin, ["rev-parse", "main"])
  for (const rel of ["", "."]) {
    const result = publishCardCommit({ root: lane, relPaths: [rel], message: "wipe", defaultBranch: "main", spawnGit: spawnSync })
    assert.equal(result.ok, false)
    assert.match(result.stderr, /repository root/u)
  }
  assert.equal(git(origin, ["rev-parse", "main"]), before)
  assert.equal(filesOn(origin), 32)
})

test("a build that lost the remote's files is refused even when the requested card paths match", async (t) => {
  const { lane, origin } = await fixture(t)
  const before = git(origin, ["rev-parse", "main"])
  await fs.rm(path.join(lane, "t/card/log.md"))
  git(lane, ["add", "-A", "t/card/log.md"])
  // The private index vanishes just before the tree is written, the way a second publisher's cleanup removed it.
  const clobbering = (command, args, options) => {
    if (args.includes("write-tree") && options?.env?.GIT_INDEX_FILE) rmSync(options.env.GIT_INDEX_FILE, { force: true })
    return spawnSync(command, args, options)
  }
  const result = publishCardCommit({ root: lane, relPaths: ["t/card/log.md"], message: "log", defaultBranch: "main", spawnGit: clobbering })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /outside the card/u)
  assert.equal(git(origin, ["rev-parse", "main"]), before)
  assert.equal(filesOn(origin), 32)
})

test("two publishers never share a private index file", async (t) => {
  const { lane } = await fixture(t)
  await fs.writeFile(path.join(lane, "t/card/log.md"), "new\n")
  git(lane, ["add", "t/card/log.md"])
  const seen = new Set()
  const watching = (command, args, options) => {
    if (options?.env?.GIT_INDEX_FILE) seen.add(options.env.GIT_INDEX_FILE)
    return spawnSync(command, args, options)
  }
  publishCardCommit({ root: lane, relPaths: ["t/card/log.md"], message: "one", defaultBranch: "main", spawnGit: watching })
  await fs.writeFile(path.join(lane, "t/card/log.md"), "newer\n")
  git(lane, ["add", "t/card/log.md"])
  publishCardCommit({ root: lane, relPaths: ["t/card/log.md"], message: "two", defaultBranch: "main", spawnGit: watching })
  assert.equal(seen.size, 2)
})

test("a checkout whose index lost most of HEAD's files commits nothing", async (t) => {
  const { lane, origin } = await fixture(t)
  const before = git(origin, ["rev-parse", "main"])
  await fs.writeFile(path.join(lane, "t/card/log.md"), "new\n")
  git(lane, ["read-tree", "--empty"])
  git(lane, ["add", "t/card/log.md"])
  const result = commitPaths(lane, ["t/card/log.md"], "log", spawnSync)
  assert.equal(result.ok, false)
  assert.match(result.stderr, /under half of HEAD/u)
  assert.equal(git(origin, ["rev-parse", "main"]), before)
  assert.equal(commitWaitingLogs(lane), "commit_failed")
  assert.equal(git(origin, ["rev-parse", "main"]), before)
})

test("a build Git cannot compare with the remote is refused", async (t) => {
  const { lane, origin } = await fixture(t)
  const before = git(origin, ["rev-parse", "main"])
  await fs.writeFile(path.join(lane, "t/card/log.md"), "new\n")
  git(lane, ["add", "t/card/log.md"])
  const failing = (command, args, options) => (args.includes("diff-tree") ? { status: 1, stdout: "", stderr: "boom" } : spawnSync(command, args, options))
  const result = publishCardCommit({ root: lane, relPaths: ["t/card/log.md"], message: "log", defaultBranch: "main", spawnGit: failing })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /diff-tree/u)
  assert.equal(git(origin, ["rev-parse", "main"]), before)
})

test("an index file Desk cannot read as an index is not treated as lost", async (t) => {
  const { lane } = await fixture(t)
  const index = git(lane, ["rev-parse", "--absolute-git-dir"]) + "/index"
  await fs.writeFile(index, "not an index at all")
  assert.equal(indexLooksLost(lane, spawnSync), false)
  await fs.writeFile(index, "DIR")
  assert.equal(indexLooksLost(lane, spawnSync), false)
})
