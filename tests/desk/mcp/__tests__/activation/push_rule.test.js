"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const skill = fs.readFileSync(path.join(__dirname, "../../../../../plugins/desk/skills/git-hygiene/SKILL.md"), "utf8")

test("git-hygiene gives one push rule that reads the remote head back", () => {
  assert.match(skill, /`git push -u origin HEAD`, never a bare `git push`/u)
  assert.match(skill, /`git rev-parse HEAD` equals the sha in `git ls-remote origin refs\/heads\/<branch>`/u)
  assert.match(skill, /the push failed[^.]*never report a silent success/u)
  assert.match(skill, /Never pass `--delete-branch` to `gh pr merge`/u)
  assert.match(skill, /`gh pr edit <n> --base <base>`/u)
})
