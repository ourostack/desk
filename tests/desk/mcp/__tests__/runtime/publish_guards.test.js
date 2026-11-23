import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { commitWaitingLogs } from "../../../../../plugins/desk/mcp/src/runtime/append-lane.js"
import { commitIndexPaths, commitPaths, indexEntries } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
import { publishCardCommit } from "../../../../../plugins/desk/mcp/src/util/main-publish.js"
import { removeTree } from "../_remove_tree.js"

// A card or log publish may change only the paths it was asked for, regardless of unrelated index entries.

const git = (root, args) => {
  const where = root.endsWith(".git") ? ["--git-dir", root] : ["-C", root]
  const result = spawnSync("git", [...where, ...args], { encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

// A desk with 30 files on origin/main and a worktree on another branch, so card writes publish.
async function fixture(t, otherFiles = 30) {
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
  for (let i = 0; i < otherFiles; i += 1) await fs.writeFile(path.join(root, `other-${i}.md`), `${i}\n`)
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Seed"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-q", "-u", "origin", "main"])
  git(root, ["remote", "set-head", "origin", "main"])
  git(root, ["worktree", "add", "-q", "-b", "lane", lane, "origin/main"])
  return { root, lane, origin, base }
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

test("two overlapping publishers preserve both captures and never share a private index file", async (t) => {
  const { lane, origin, base } = await fixture(t)
  await fs.writeFile(path.join(lane, "t/card/log.md"), "new\n")
  await fs.writeFile(path.join(lane, "t/card/task.md"), "new card\n")
  await fs.writeFile(path.join(lane, "other-0.md"), "user\n")
  git(lane, ["add", "t/card/log.md", "t/card/task.md", "other-0.md"])
  const staged = git(lane, ["ls-files", "-s", "--", "other-0.md"])
  const module = new URL("../../../../../plugins/desk/mcp/src/util/main-publish.js", import.meta.url).href
  // Both processes have populated their indexes before either writes its tree. A shared index name would now
  // mix their captures or disappear when the other process finishes.
  const worker = `
    import { spawnSync } from "node:child_process"
    import { existsSync, writeFileSync } from "node:fs"
    import { publishCardCommit } from ${JSON.stringify(module)}
    const [root, rel, ready, peer] = process.argv.slice(1)
    const indexes = new Set()
    let met = false
    const watching = (command, args, options) => {
      if (options?.env?.GIT_INDEX_FILE) indexes.add(options.env.GIT_INDEX_FILE)
      if (!met && args.includes("write-tree") && options?.env?.GIT_INDEX_FILE) {
        writeFileSync(ready, "ready")
        const deadline = Date.now() + 10000
        while (!existsSync(peer)) {
          if (Date.now() >= deadline) throw new Error("peer publisher never reached the build")
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        }
        met = true
      }
      return spawnSync(command, args, options)
    }
    const result = publishCardCommit({ root, relPaths: [rel], message: rel, defaultBranch: "main", spawnGit: watching })
    console.log(JSON.stringify({ result, indexes: [...indexes], met }))
  `
  const launch = (rel, ready, peer) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker, lane, rel, path.join(base, ready), path.join(base, peer)], { timeout: 30000, windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`publisher exited ${code}: ${stderr}`))
      else {
        try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
      }
    })
  })
  const answers = await Promise.all([
    launch("t/card/log.md", "log-ready", "card-ready"),
    launch("t/card/task.md", "card-ready", "log-ready"),
  ])
  for (const answer of answers) {
    assert.equal(answer.met, true)
    assert.equal(answer.result.ok, true, answer.result.stderr)
  }
  assert.notEqual(answers[0].indexes[0], answers[1].indexes[0])
  assert.equal(git(origin, ["show", "main:t/card/log.md"]), "new")
  assert.equal(git(origin, ["show", "main:t/card/task.md"]), "new card")
  assert.equal(git(origin, ["show", "main:other-0.md"]), "0")
  assert.equal(filesOn(origin), 32)
  assert.equal(git(lane, ["ls-files", "-s", "--", "other-0.md"]), staged)
})

const outsideLog = (root, ref) => git(root, ["ls-tree", "-r", ref]).split("\n").filter((line) => !line.endsWith("\tt/card/log.md"))

for (const [label, others, surviving, subdir] of [
  ["small HEAD", 10, 0, false],
  ["under half of HEAD", 30, 0, false],
  ["over 1000 surviving entries", 2030, 1000, false],
  ["subdirectory root", 30, 0, true],
]) {
  for (const publication of [false, true]) test(`${label}: a reconstructed index saves only the log ${publication ? "remotely" : "locally"}`, async (t) => {
    const { root, lane, origin } = await fixture(t, others)
    const checkout = publication ? lane : root
    const before = outsideLog(checkout, "HEAD")
    git(checkout, ["read-tree", "--empty"])
    if (surviving) git(checkout, ["add", "--", ...Array.from({ length: surviving }, (_, i) => `other-${i}.md`)])
    await fs.writeFile(path.join(checkout, "other-0.md"), "user's staged work\n")
    git(checkout, ["add", "other-0.md"])
    const staged = git(checkout, ["ls-files", "-s", "--", "other-0.md"])
    await fs.appendFile(path.join(checkout, "t/card/log.md"), "new\n")
    const cwd = subdir ? path.join(checkout, "t/card") : checkout
    assert.equal(commitWaitingLogs(cwd), "committed")
    assert.deepEqual(outsideLog(checkout, "HEAD"), before)
    assert.deepEqual(outsideLog(origin, "main"), before)
    assert.equal(git(checkout, ["show", "HEAD:t/card/log.md"]), "old\nnew")
    assert.equal(git(origin, ["show", "main:t/card/log.md"]), publication ? "old\nnew" : "old")
    assert.equal(git(checkout, ["ls-files", "-s", "--", "other-0.md"]), staged)
  })
}

for (const publication of [false, true]) test(`20 declared deletions in a 32-file HEAD preserve unrelated staged work ${publication ? "remotely" : "locally"}`, async (t) => {
  const { root, lane, origin } = await fixture(t)
  await fs.mkdir(path.join(root, "declared"))
  for (let i = 0; i < 20; i += 1) git(root, ["mv", `other-${i}.md`, `declared/other-${i}.md`])
  git(root, ["commit", "-qm", "folder"])
  git(root, ["push", "-q", "origin", "main"])
  git(lane, ["merge", "--ff-only", "origin/main"])
  const checkout = publication ? lane : root
  const outsideFolder = (where, ref) => git(where, ["ls-tree", "-r", ref]).split("\n").filter((line) => !line.includes("\tdeclared/"))
  const before = outsideFolder(checkout, "HEAD")
  await fs.writeFile(path.join(checkout, "other-20.md"), "user\n")
  git(checkout, ["add", "other-20.md"])
  const staged = git(checkout, ["ls-files", "-s", "--", "other-20.md"])
  await removeTree(path.join(checkout, "declared"))
  git(checkout, ["add", "-A", "--", "declared"])
  const result = commitPaths(checkout, ["declared"], "deliberate deletion", spawnSync)
  assert.equal(result.ok, true, result.stderr)
  assert.equal(git(checkout, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").length, 12)
  assert.equal(filesOn(origin), publication ? 12 : 32)
  assert.deepEqual(outsideFolder(checkout, "HEAD"), before)
  assert.deepEqual(outsideFolder(origin, "main"), before)
  assert.equal(git(checkout, ["show", "HEAD:other-20.md"]), "20")
  assert.equal(git(checkout, ["ls-files", "-s", "--", "other-20.md"]), staged)
})

for (const damaged of ["missing", "corrupt"]) test(`${damaged} real index cannot delete undeclared local or remote files`, async (t) => {
  const { root, lane, origin } = await fixture(t)
  for (const checkout of [root, lane]) {
    const before = outsideLog(checkout, "HEAD")
    const index = path.join(git(checkout, ["rev-parse", "--absolute-git-dir"]), "index")
    await fs.appendFile(path.join(checkout, "t/card/log.md"), "new\n")
    if (damaged === "missing") await fs.rm(index)
    else await fs.writeFile(index, "not an index")
    if (damaged === "corrupt") {
      assert.equal(commitPaths(checkout, ["t/card/log.md"], "log", spawnSync).ok, false)
      assert.equal(commitWaitingLogs(checkout), "empty")
      assert.equal(git(origin, ["show", "main:t/card/log.md"]), "old")
    } else {
      assert.equal(commitWaitingLogs(checkout), "committed")
      assert.equal(git(checkout, ["show", "HEAD:t/card/log.md"]), "old\nnew")
    }
    assert.deepEqual(outsideLog(checkout, "HEAD"), before)
    assert.deepEqual(outsideLog(origin, "main"), before)
  }
})

test("a lost private local index is held even when the captured deletion matches", async (t) => {
  const { root, origin } = await fixture(t)
  const before = git(root, ["rev-parse", "HEAD"])
  await fs.rm(path.join(root, "t/card/log.md"))
  git(root, ["add", "-A", "--", "t/card/log.md"])
  const staged = git(root, ["ls-files", "-s"])
  const clobbering = (command, args, options) => {
    if (args.includes("write-tree") && options?.env?.GIT_INDEX_FILE) rmSync(options.env.GIT_INDEX_FILE, { force: true })
    return spawnSync(command, args, options)
  }
  const result = commitIndexPaths(root, ["t/card/log.md"], indexEntries(root, ["t/card/log.md"], spawnSync), "delete log", clobbering)
  assert.equal(result.ok, false)
  assert.match(result.stderr, /outside the captured paths/u)
  assert.equal(git(root, ["rev-parse", "HEAD"]), before)
  assert.equal(git(origin, ["rev-parse", "main"]), before)
  assert.equal(git(root, ["ls-files", "-s"]), staged)
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
