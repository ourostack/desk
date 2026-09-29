// Part 6 — Scratch out of the desk: content assertions over the two skill
// files this PR touches. Neither skill file has executable behavior to test
// directly; the contract is the text itself, so these tests read it exactly
// the way content_routing.test.js reads content-routing/SKILL.md.

import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const bootstrapSkillPath = path.join(repoRoot, "plugins", "desk", "skills", "first-run-bootstrap", "SKILL.md")
const sessionStartSkillPath = path.join(repoRoot, "plugins", "desk", "skills", "session-start", "SKILL.md")

test("first-run-bootstrap's fresh-create .gitignore template widens to cover scratch shapes and the Desk-problem quarantine dir", () => {
  const skill = readFileSync(bootstrapSkillPath, "utf8")
  const gitignoreLine = skill.split("\n").find((line) => line.includes(".machine-local.yml"))
  assert.ok(gitignoreLine, "expected the fresh-create bullet naming .machine-local.yml to still exist")
  for (const pattern of ["*.txt", "*.png", "*.jpg", "*.log", "undefined/", "_cache/"]) {
    assert.ok(gitignoreLine.includes(pattern), `expected the .gitignore template line to include ${pattern}`)
  }
  // The two patterns this PR did not touch must still be present, unmoved.
  assert.ok(gitignoreLine.includes(".state/"))
  assert.ok(gitignoreLine.includes("~$*"))
})

test("session-start warns against running non-desk work with the desk root as cwd", () => {
  const skill = readFileSync(sessionStartSkillPath, "utf8")
  assert.match(skill, /should not use the desk root as its working directory/)
})
