// readRemotes: a clone's remotes from its Git config file, without running git. It answers only when the file can
// answer for git; anything it cannot read as git would returns null, and the caller asks git.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { readRemotes } from "../../../../../plugins/desk/mcp/src/util/git-config-file.js"

const git = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })

test("readRemotes: a real clone's remotes match what git reports, quoted and unquoted, with and without a url", async () => {
  const dir = await mkTempRoot("desk-git-config-")
  git(dir, "init", "-q")
  git(dir, "remote", "add", "origin", "https://github.com/acme/widgets.git")
  git(dir, "remote", "add", "fork", "git@github.com:ari/widgets.git")
  await fs.appendFile(path.join(dir, ".git", "config"), [
    "# a comment", "; another", "[remote \"quoted\"]", "\turl = \"https://example.com/q.git\"", "[remote \"bare\"]", "\tfetch = +refs/heads/*:refs/remotes/bare/*",
    "[branch \"main\"]", "\tremote = origin", "[core] # trailing", "\tbare = false", "[remote]", "\turl = https://example.com/unnamed.git",
    "[remote \"origin\"]", "\tpushurl = https://example.com/push.git", "",
  ].join("\n"))
  assert.deepEqual(readRemotes(dir), {
    remotes: {
      origin: "https://github.com/acme/widgets.git",
      fork: "git@github.com:ari/widgets.git",
      quoted: "https://example.com/q.git",
      bare: null,
    },
  })
})

test("readRemotes: a clone with no remote has none, and a linked worktree reads its main clone's config", async () => {
  const dir = await mkTempRoot("desk-git-config-")
  git(dir, "init", "-q", "-b", "main")
  assert.deepEqual(readRemotes(dir), { remotes: {} })
  git(dir, "remote", "add", "origin", "https://github.com/acme/widgets.git")
  git(dir, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init")
  const worktree = path.join(await mkTempRoot("desk-git-config-wt-"), "wt")
  git(dir, "worktree", "add", "-q", worktree)
  assert.deepEqual(readRemotes(worktree), { remotes: { origin: "https://github.com/acme/widgets.git" } })
})

test("readRemotes: a gitdir pointer with no commondir reads that folder's own config", async () => {
  const root = await mkTempRoot("desk-git-config-")
  const gitDir = path.join(root, "separate.git")
  await fs.mkdir(gitDir)
  await fs.writeFile(path.join(gitDir, "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/separate.git\n")
  const dir = path.join(root, "work")
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, ".git"), "gitdir: ../separate.git\n")
  assert.deepEqual(readRemotes(dir), { remotes: { origin: "https://github.com/acme/separate.git" } })
})

test("readRemotes: null whenever the file cannot answer for git", async () => {
  assert.equal(readRemotes(""), null)
  assert.equal(readRemotes(undefined), null)
  const root = await mkTempRoot("desk-git-config-")
  assert.equal(readRemotes(path.join(root, "missing")), null, "no folder")
  assert.equal(readRemotes(root), null, "a folder that is not a clone")
  const pointer = path.join(root, "pointer")
  await fs.mkdir(pointer)
  await fs.writeFile(path.join(pointer, ".git"), "not a gitdir line\n")
  assert.equal(readRemotes(pointer), null, "a .git file that points nowhere")
  const noConfig = path.join(root, "no-config")
  await fs.mkdir(path.join(noConfig, ".git"), { recursive: true })
  assert.equal(readRemotes(noConfig), null, "a .git folder with no config")
  for (const section of ["[include]\n\tpath = other", "[includeIf \"gitdir:~/x/\"]\n\tpath = other"]) {
    const dir = path.join(root, `inc-${section.length}`)
    await fs.mkdir(path.join(dir, ".git"), { recursive: true })
    await fs.writeFile(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = u\n${section}\n`)
    assert.equal(readRemotes(dir), null, "an include could add remotes")
  }
  const big = path.join(root, "big")
  await fs.mkdir(path.join(big, ".git"), { recursive: true })
  await fs.writeFile(path.join(big, ".git", "config"), `[core]\n${"#".repeat(300 * 1024)}\n`)
  assert.equal(readRemotes(big), null, "a config too large to read quickly")
  const bigPointer = path.join(root, "big-pointer")
  await fs.mkdir(bigPointer)
  await fs.writeFile(path.join(bigPointer, ".git"), "x".repeat(300 * 1024))
  assert.equal(readRemotes(bigPointer), null, "a .git file too large to be a pointer")
})
