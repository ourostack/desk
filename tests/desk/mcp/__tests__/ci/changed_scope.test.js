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

test("with outside, a change runs when any file lies outside the skippable paths, and skips only when every file is inside", () => {
  const docs = ["docs/", "README.md"]
  const diff = (stdout) => fakeGit({ diff: { status: 0, stdout, stderr: "" } })
  assert.equal(decide("base", docs, diff("docs/roadmap/boot.md\nREADME.md\n"), { outside: true }).run, false)
  assert.equal(decide("base", docs, diff("docs/roadmap/boot.md\nplugins/desk/mcp/src/server.js\n"), { outside: true }).run, true)
  // An empty diff has nothing outside, so it skips; a missing base still runs everything.
  assert.equal(decide("base", docs, diff(""), { outside: true }).run, false)
  assert.equal(decide("", docs, diff(""), { outside: true }).run, true)
})

test("the command line takes --outside before the base", async () => {
  const { spawnSync } = await import("node:child_process")
  const script = path.join(scripts, "changed-scope.mjs")
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
  // An all-zero base never reaches git, so these run anywhere.
  assert.match(run(["--outside", "0000000000000000000000000000000000000000", "docs/"]).stdout, /^run=true$/mu)
  assert.match(run(["", "evals/"]).stdout, /^run=true$/mu)
})
