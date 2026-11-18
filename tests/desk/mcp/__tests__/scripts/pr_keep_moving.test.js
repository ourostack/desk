// pr-keep-moving tells a PR's author what blocks it, once per head commit, and never nags a PR that is only behind.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".github", "scripts")
const { decide, message, alreadySent } = await import(pathToFileURL(path.join(scripts, "pr-keep-moving.mjs")).href)
const required = ["CI gate", "Windows suite"]

test("a conflict is reported first, whatever the checks say", () => {
  assert.deepEqual(decide({ mergeable: "CONFLICTING", behind: true, checks: [], required }), { action: "conflict" })
})

test("only a red required check calls for a message; a red optional check or a pending one does not", () => {
  const checks = [{ name: "CI gate", conclusion: "SUCCESS" }, { name: "Black-box tester", conclusion: "FAILURE" }, { name: "Windows suite", conclusion: "" }]
  assert.equal(decide({ mergeable: "MERGEABLE", behind: false, checks, required }).action, "none")
  const red = decide({ mergeable: "MERGEABLE", behind: true, checks: [{ name: "Windows suite", conclusion: "FAILURE" }], required })
  assert.deepEqual(red, { action: "red", red: ["Windows suite"], behind: true })
})

test("the message names the files or checks, says to merge main when behind, and is recognised once sent", () => {
  const conflict = message({ kind: "conflict", author: "ari", sha: "abc1234567", files: ["a.js", "b.js"] })
  assert.match(conflict, /@ari.*`a\.js`, `b\.js`/su)
  const red = message({ kind: "red", author: "ari", sha: "abc1234567", red: ["Windows suite"], behind: true })
  assert.match(red, /`Windows suite`.*abc123456.*merge main in/su)
  assert.ok(alreadySent([{ body: conflict }], "conflict", "abc1234567"))
  assert.ok(!alreadySent([{ body: conflict }], "conflict", "def"), "a new head commit is told again")
  assert.ok(!alreadySent([{ body: conflict }], "red", "abc1234567"))
})
