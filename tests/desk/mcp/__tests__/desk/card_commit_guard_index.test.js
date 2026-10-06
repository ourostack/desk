// The two tests that open the real index (better-sqlite3) live apart from the Git-heavy card guard tests: on Windows, Node 24 aborts with
// "Assertion failed: (env) != nullptr" in a Database destructor while it tears down a test file that ran long, so the file that opens a
// database stays short.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { ensureCardGuard, hookScript, TOOL_COMMIT_ENV } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { openDb } from "../../../../../plugins/desk/mcp/src/db/init.js"

const CARD = "---\ntitle: x\nstatus: processing\n---\n\nbody\n"

function sh(cwd, args, env = {}) {
  const base = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }
  delete base[TOOL_COMMIT_ENV]
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...base, ...env } })
}

function makeDesk({ withMarkers = true } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "card-guard-")))
  assert.equal(sh(root, ["init", "-q", "-b", "main"]).status, 0)
  // Desk's own commit path (commitPaths) runs git with the process environment, so the identity lives in the repository.
  assert.equal(sh(root, ["config", "user.name", "t"]).status, 0)
  assert.equal(sh(root, ["config", "user.email", "t@example.com"]).status, 0)
  if (withMarkers) {
    mkdirSync(path.join(root, "_meta"), { recursive: true })
    mkdirSync(path.join(root, "_archive"), { recursive: true })
    writeFileSync(path.join(root, "_meta", "keep.md"), "x\n")
  }
  mkdirSync(path.join(root, "greenhouse", "watering-api"), { recursive: true })
  writeFileSync(path.join(root, "greenhouse", "watering-api", "task.md"), CARD)
  writeFileSync(path.join(root, "README.md"), "hi\n")
  assert.equal(sh(root, ["add", "-A"]).status, 0)
  assert.equal(sh(root, ["commit", "-q", "-m", "seed", "--no-verify"]).status, 0)
  return root
}


test("ensureCardGuard installs once per desk per process and tries again after a failure; openDb installs it for the real index path only", async () => {
  const root = makeDesk()
  try {
    const failing = (cmd, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: `${root}\n` } : { status: 1, stdout: "", stderr: "" })
    assert.equal(ensureCardGuard(root, { spawnGit: failing }).state, "failed")
    const first = ensureCardGuard(root)
    assert.equal(first.state, "installed")
    assert.equal(ensureCardGuard(root), null, "the second call in this process does nothing")

    const other = makeDesk()
    try {
      openDb(other, { dbPath: path.join(other, "elsewhere.sqlite") }).close()
      assert.equal(existsSync(path.join(other, ".git", "hooks", "pre-commit")), false, "a test's dbPath override says nothing about the desk")
      openDb(other).close()
      assert.equal(readFileSync(path.join(other, ".git", "hooks", "pre-commit"), "utf8"), hookScript())
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
