// Fixtures shared by the task_move and track_rename tests, which are split over two files so the Windows suite can run them at the same time.
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { track_create } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { readFront } from "./_helpers.js"

export const SCOPE = "fixture track scope; not anything else"

// A fixture card defaults to `status: drafting` -- non-terminal -- so
// archiving one now needs evidence (task.js's `assertDoneEvidence`/the
// archive evidence gate) to reach `done`, the status these move/rename
// fixtures assume once archived.
export const DONE_EVIDENCE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/1" }

export function tasksTableBody(rows) {
  const rowLines = rows.map((slug) => `| \`${slug}\` | drafting | - | - | - |`)
  return [
    "## Scope",
    "",
    "Fixture body.",
    "",
    "## Tasks",
    "",
    "| Slug | State | Repos | Tracker link | Doing doc |",
    "|------|-------|-------|--------------|-----------|",
    ...rowLines,
  ].join("\n")
}

export function initGit(root) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  }
  run(["init", "-q"])
  run(["config", "user.email", "test@example.com"])
  run(["config", "user.name", "Test"])
}

// The tools refuse to move a folder with unstaged changes or untracked files
// (another session may be working there), so Git tests commit their fixture
// first.
export function commitAll(root) {
  for (const args of [["add", "-A"], ["commit", "-q", "--allow-empty", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
}

export function gitStatus(root) {
  const result = spawnSync("git", ["-C", root, "status", "--short"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

export function gitLog(root) {
  const result = spawnSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" })
  return result.stdout
}

export function lastCommitMessage(root) {
  const result = spawnSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

// Fix round 1, Important: no refusal may quote a candidate. Checking every
// 4-character substring is equivalent to checking every substring longer
// than 3 characters — any longer run contains a 4-character run as a prefix.
export function assertNoCandidateLeak(message, candidate) {
  for (let i = 0; i <= candidate.length - 4; i += 1) {
    const chunk = candidate.slice(i, i + 4)
    assert.equal(
      message.includes(chunk),
      false,
      `error message must not leak "${chunk}" from candidate ${JSON.stringify(candidate)}: ${message}`,
    )
  }
}

export async function mkTrack(root, slug, { rows = [], title } = {}) {
  await track_create({
    deskRoot: root,
    input: { slug, title: title ?? slug, scope: SCOPE, body: tasksTableBody(rows) },
  })
}

export async function trackBody(root, slug) {
  const { content } = await readFront(path.join(root, slug, "track.md"))
  return content
}

// ── task_move: same-track rename ────────────────────────────────────────────
