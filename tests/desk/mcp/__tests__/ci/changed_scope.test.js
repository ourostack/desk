// The offline eval job skips its tests when a change cannot affect them. A missing or unknown base must run everything, never skip.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".github", "scripts")
const { decide, touches } = await import(pathToFileURL(path.join(scripts, "changed-scope.mjs")).href)

const scope = ["evals/", "scripts/skill-evals.cjs"]
const fakeGit = ({ commit = true, diff = { status: 0, stdout: "", stderr: "" } } = {}) => (args) =>
  args[0] === "cat-file" ? { status: commit ? 0 : 128, stdout: "", stderr: "" } : diff

test("a folder entry matches by prefix and a file entry matches exactly", () => {
  assert.equal(touches(["evals/offline/core.mjs"], scope), true)
  assert.equal(touches(["scripts/skill-evals.cjs"], scope), true)
  assert.equal(touches(["scripts/skill-evals.cjs.bak", "evalsx/a.mjs", "plugins/desk/mcp/src/server.js"], scope), false)
})

test("a change outside the scope skips, and one inside runs", () => {
  assert.equal(decide("base", scope, fakeGit({ diff: { status: 0, stdout: "plugins/desk/mcp/src/server.js\nREADME.md\n", stderr: "" } })).run, false)
  assert.equal(decide("base", scope, fakeGit({ diff: { status: 0, stdout: "README.md\nevals/offline/cli.mjs\n", stderr: "" } })).run, true)
})

test("no base, an all-zero base, an unknown base or a failed diff runs everything", () => {
  for (const base of ["", "0000000000000000000000000000000000000000"]) assert.equal(decide(base, scope, fakeGit()).run, true, base)
  assert.equal(decide("missing", scope, fakeGit({ commit: false })).run, true)
  assert.equal(decide("base", scope, fakeGit({ diff: { status: 1, stdout: "", stderr: "bad" } })).run, true)
})
