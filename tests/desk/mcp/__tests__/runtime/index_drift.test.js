// Index tracing's shared primitive: a before/after staged-path snapshot diff,
// and the five-field `Desk problem:` block formatter every later part of the
// design reuses. See spec.md §3 "Index tracing".
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { diffStagedPaths, formatDeskProblem, snapshotStagedPaths } from "../../../../../plugins/desk/mcp/src/runtime/index-drift.js"

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-index-drift-")))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@example.invalid" }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS|GLOBAL))/u.test(key)) delete env[key]
  const spawnGit = (command, args) => {
    try {
      const stdout = execFileSync(command, args, { env, encoding: "utf8" })
      return { status: 0, stdout, stderr: "" }
    } catch (error) {
      return { status: typeof error.status === "number" ? error.status : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }
    }
  }
  execFileSync("git", ["init", "-q", "-b", "main", root], { env })
  writeFileSync(path.join(root, "committed.md"), "base\n")
  execFileSync("git", ["-C", root, "add", "committed.md"], { env })
  execFileSync("git", ["-C", root, "commit", "-qm", "first"], { env })
  return { root, env, spawnGit }
}

test("snapshotStagedPaths reports exactly the currently staged paths", (t) => {
  const { root, env, spawnGit } = fixture(t)
  assert.deepEqual(snapshotStagedPaths({ root, spawnGit }), [])
  writeFileSync(path.join(root, "stray.txt"), "x\n")
  execFileSync("git", ["-C", root, "add", "stray.txt"], { env })
  assert.deepEqual(snapshotStagedPaths({ root, spawnGit }), ["stray.txt"])
})

test("snapshotStagedPaths never throws on a failing git, and reports no staged paths", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-index-drift-notgit-")))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const spawnGit = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" })
  assert.deepEqual(snapshotStagedPaths({ root, spawnGit }), [])
  const throwingSpawnGit = () => { throw new Error("git not found") }
  assert.deepEqual(snapshotStagedPaths({ root, spawnGit: throwingSpawnGit }), [])
})

test("diffStagedPaths returns only the paths newly present in after", () => {
  assert.deepEqual(diffStagedPaths(["a.md"], ["a.md", "b.png"]), ["b.png"])
  assert.deepEqual(diffStagedPaths([], []), [])
  assert.deepEqual(diffStagedPaths(["a.md", "b.png"], ["a.md"]), [])
})

test("formatDeskProblem renders the five fields in order", () => {
  assert.equal(
    formatDeskProblem({ mechanism: "index-drift", broke: "x", means: "y", fix: "z", file: "not filed: no filer yet", tell: "t" }),
    "Desk problem: index-drift — x\n  broke: x\n  means: y\n  fix: z\n  file: not filed: no filer yet\n  tell: t",
  )
})
