import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { readToolCommits, recordToolCommit } from "../../../../../plugins/desk/mcp/src/util/tool-commits.js"
import { lastStartRootKey, resolveDeskStateDir } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"

const git = (root, args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`)
  return result.stdout.trim()
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "desk-tool-commits-"))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const root = path.join(base, "desk")
  mkdirSync(root)
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["config", "user.email", "test@example.com"])
  writeFileSync(path.join(root, "seed.md"), "seed\n")
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Seed"])
  return { base, root, env: { ...process.env, XDG_STATE_HOME: path.join(base, "state") } }
}

test("a commit Desk's tools made is listed for its repository, and a folder that is no repository lists none", async (t) => {
  const { base, root, env } = await fixture(t)
  recordToolCommit(root, env)
  assert.deepEqual([...readToolCommits(root, env)], [git(root, ["rev-parse", "HEAD"])])
  assert.equal(readToolCommits(path.join(base, "elsewhere"), env).size, 0)
  const plain = path.join(base, "plain")
  mkdirSync(plain)
  recordToolCommit(plain, env)
  assert.equal(readToolCommits(plain, env).size, 0)
})

test("a ledger past twice its keep is cut back to the newest ids", async (t) => {
  const { root, env } = await fixture(t)
  recordToolCommit(root, env)
  const file = path.join(resolveDeskStateDir({ env }), "tool-commits", `${lastStartRootKey(realpathSync(root))}.txt`)
  const old = Array.from({ length: 4001 }, (_, index) => index.toString(16).padStart(40, "0"))
  writeFileSync(file, `${old.join("\n")}\n`)
  recordToolCommit(root, env)
  const kept = readFileSync(file, "utf8").split("\n").filter(Boolean)
  assert.equal(kept.length, 2000)
  assert.equal(kept.at(-1), git(root, ["rev-parse", "HEAD"]))
})
