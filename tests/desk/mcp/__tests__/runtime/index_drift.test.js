// Index tracing's shared primitive: a before/after staged-path snapshot diff,
// the `Desk problem:` block formatter, and the index-drift wording every
// call site (boot checks, migration blocks) shares. See spec.md §3 "Index
// tracing".
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { diffStagedPaths, formatDeskProblem, formatIndexDriftProblem, snapshotStagedPaths } from "../../../../../plugins/desk/mcp/src/runtime/index-drift.js"

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

test("snapshotStagedPaths never throws on a failing, timed-out or missing git, and reports null (not empty) — a failed read is unknown, not 'nothing staged'", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-index-drift-notgit-")))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const failingSpawnGit = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" })
  assert.equal(snapshotStagedPaths({ root, spawnGit: failingSpawnGit }), null)
  const throwingSpawnGit = () => { throw new Error("git not found") }
  assert.equal(snapshotStagedPaths({ root, spawnGit: throwingSpawnGit }), null)
  // What Node's own spawnSync reports for a timed-out child: status null,
  // signal set, and `error` carrying ETIMEDOUT — never thrown.
  const timedOutSpawnGit = () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) })
  assert.equal(snapshotStagedPaths({ root, spawnGit: timedOutSpawnGit }), null)
})

test("snapshotStagedPaths hardens and bounds its own git call: fsmonitor and hooks off, optional locks off, a short timeout", (t) => {
  const { root, spawnGit: realSpawnGit } = fixture(t)
  const calls = []
  const spawnGit = (command, args, options) => {
    calls.push({ command, args, options })
    return realSpawnGit(command, args, options)
  }
  snapshotStagedPaths({ root, spawnGit })
  assert.equal(calls.length, 1)
  const { args, options } = calls[0]
  assert.ok(args.includes("-c"), args.join(" "))
  assert.ok(args.includes("core.fsmonitor=false"), args.join(" "))
  assert.ok(args.includes("core.hooksPath=/dev/null"), args.join(" "))
  assert.ok(args.includes("diff") && args.includes("--cached") && args.includes("--name-only"), args.join(" "))
  assert.equal(typeof options.timeout, "number")
  assert.ok(options.timeout > 0 && options.timeout <= 1000, options.timeout)
  assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0")
})

test("diffStagedPaths returns only the paths newly present in after", () => {
  assert.deepEqual(diffStagedPaths(["a.md"], ["a.md", "b.png"]), ["b.png"])
  assert.deepEqual(diffStagedPaths([], []), [])
  assert.deepEqual(diffStagedPaths(["a.md", "b.png"], ["a.md"]), [])
})

test("formatDeskProblem renders the six fields in order, the header carrying symptom, not broke", () => {
  assert.equal(
    formatDeskProblem({ mechanism: "index-drift", symptom: "s", broke: "x", means: "y", fix: "z", file: "not filed: no filer yet", tell: "t" }),
    "Desk problem: index-drift — s\n  broke: x\n  means: y\n  fix: z\n  file: not filed: no filer yet\n  tell: t",
  )
})

test("formatIndexDriftProblem names one file in the singular, without accusing the check or migration of staging it", async () => {
  const block = await formatIndexDriftProblem({ kind: "boot check", label: "probe", drift: ["stray.txt"] })
  assert.match(block, /^Desk problem: index-drift — unexpected file staged during probe\n/)
  assert.match(block, /\n {2}broke: probe: unexpected staged path\(s\) appeared during this boot check: stray\.txt\n/)
  assert.match(block, /\n {2}means: stray\.txt appeared in the index while boot check "probe" ran — it may have staged it, or another session may have staged it at the same time\n/)
  assert.match(block, /\n {2}tell: A file appeared in the index while "probe" ran \(stray\.txt\); it may have staged it, or another session may have staged it at the same time\. Left as-is so you can inspect it\.$/)
  assert.doesNotMatch(block, /\bstaged a file it should never touch\b/)
  assert.doesNotMatch(block, /unexpectedly staged/)
})

test("formatIndexDriftProblem names several files in the plural", async () => {
  const block = await formatIndexDriftProblem({ kind: "migration block", label: "01-a:migrate", drift: ["a.txt", "b.txt"] })
  assert.match(block, /^Desk problem: index-drift — unexpected files staged during 01-a:migrate\n/)
  assert.match(block, /\n {2}means: a\.txt, b\.txt appeared in the index while migration block "01-a:migrate" ran — it may have staged them, or another session may have staged them at the same time\n/)
  assert.match(block, /\n {2}tell: Files appeared in the index while "01-a:migrate" ran \(a\.txt, b\.txt\); it may have staged them, or another session may have staged them at the same time\. Left as-is so you can inspect it\.$/)
})

// ── index-drift is migrated onto real filing too (spec.md §1, Part 5) ──────

test("formatIndexDriftProblem renders 'not filed: filer_unavailable' by default, filing nothing itself", async () => {
  const block = await formatIndexDriftProblem({ kind: "boot check", label: "probe", drift: ["stray.txt"] })
  assert.match(block, /\n {2}file: not filed: filer_unavailable\n/)
})

test("formatIndexDriftProblem reports whatever the injected fileProblem returns, and passes it the drift's own reason", async () => {
  const calls = []
  const block = await formatIndexDriftProblem({
    kind: "boot check", label: "probe", drift: ["stray.txt"], env: { X: "1" }, host: "claude",
    fileProblem: async ({ env, host, reason }) => { calls.push({ env, host, reason }); return { file: "filing in background" } },
  })
  assert.match(block, /\n {2}file: filing in background\n/)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].env, { X: "1" })
  assert.equal(calls[0].host, "claude")
  assert.match(calls[0].reason, /probe: unexpected staged path\(s\) appeared during this boot check: stray\.txt/)
})
