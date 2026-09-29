// Part 6 — Scratch out of the desk: content assertions over the two skill
// files this PR touches, plus a real-git behavioral check on the widened
// .gitignore template. Neither skill file has executable behavior to test
// directly; the contract is the text itself, so the content assertions read
// it exactly the way content_routing.test.js reads content-routing/SKILL.md.
// The anchoring the template documents (root and one level down only, never
// deeper) is a real Git-semantics claim, so it is verified against a real
// `git check-ignore` in a synthetic repo rather than only asserted in prose.

import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const bootstrapSkillPath = path.join(repoRoot, "plugins", "desk", "skills", "first-run-bootstrap", "SKILL.md")
const sessionStartSkillPath = path.join(repoRoot, "plugins", "desk", "skills", "session-start", "SKILL.md")

// The exact patterns the fresh-create bullet documents, in the order it
// names them. `/*.<ext>` (the desk root) and `/*/*.<ext>` (one level down)
// are anchored, never a bare `*.<ext>`, so a real deliverable two levels
// into a task folder or deeper is never silently ignored (fix round,
// independent review: a bare glob matched at every depth).
const GITIGNORE_LINES = [
  ".state/",
  ".machine-local.yml",
  "~$*",
  "/*.txt",
  "/*/*.txt",
  "/*.png",
  "/*/*.png",
  "/*.jpg",
  "/*/*.jpg",
  "/*.log",
  "/*/*.log",
  "undefined/",
  "_cache/",
]

test("first-run-bootstrap's fresh-create .gitignore template lists every anchored scratch pattern and the quarantine dir", () => {
  const skill = readFileSync(bootstrapSkillPath, "utf8")
  const gitignoreLine = skill.split("\n").find((line) => line.includes(".machine-local.yml"))
  assert.ok(gitignoreLine, "expected the fresh-create bullet naming .machine-local.yml to still exist")
  for (const pattern of GITIGNORE_LINES) {
    assert.ok(gitignoreLine.includes(pattern), `expected the .gitignore template line to include ${pattern}`)
  }
})

test("session-start warns against running non-desk work with the desk root as cwd", () => {
  const skill = readFileSync(sessionStartSkillPath, "utf8")
  assert.match(skill, /should not use the desk root as its working directory/)
})

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" })
}

function isIgnored(root, relPath) {
  return git(root, ["check-ignore", "--quiet", relPath]).status === 0
}

test("the widened .gitignore template ignores scratch files at the desk root and one level down, never a real deliverable two levels down or deeper", () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-gitignore-test-"))
  try {
    assert.equal(git(root, ["init", "-q"]).status, 0)
    writeFileSync(path.join(root, ".gitignore"), `${GITIGNORE_LINES.join("\n")}\n`)

    const paths = {
      "a.png": null,
      "track/a.png": "track",
      "track/notes.txt": "track",
      "track/task/a.png": path.join("track", "task"),
      "track/task/notes.txt": path.join("track", "task"),
      "track/task/desk/2026-09-28-x/shot.png": path.join("track", "task", "desk", "2026-09-28-x"),
    }
    for (const [relPath, relDir] of Object.entries(paths)) {
      if (relDir) mkdirSync(path.join(root, relDir), { recursive: true })
      writeFileSync(path.join(root, relPath), "")
    }

    // Root and one level down: ignored.
    assert.ok(isIgnored(root, "a.png"), "a.png at the desk root should be ignored")
    assert.ok(isIgnored(root, "track/a.png"), "track/a.png one level down should be ignored")
    assert.ok(isIgnored(root, "track/notes.txt"), "track/notes.txt one level down should be ignored")

    // Two levels down or deeper: never ignored — a real task deliverable.
    assert.ok(!isIgnored(root, "track/task/a.png"), "track/task/a.png two levels down must not be ignored")
    assert.ok(!isIgnored(root, "track/task/notes.txt"), "track/task/notes.txt two levels down must not be ignored")
    assert.ok(
      !isIgnored(root, "track/task/desk/2026-09-28-x/shot.png"),
      "a real per-repo-iteration screenshot deep in a task folder must not be ignored",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
