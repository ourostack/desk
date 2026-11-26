import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { headlessCheck } from "../../../../../plugins/desk/hooks/lib/turn-end-gate.cjs"

const GATE = fileURLToPath(new URL("../../../../../plugins/desk/hooks/lib/turn-end-gate.cjs", import.meta.url))
const PR = "https://github.com/o/r/pull/9"
const run = (output, prExists) => {
  const home = mkdtempSync(path.join(tmpdir(), "gate-"))
  const r = headlessCheck({ session: "s1", output, repo: "o/r", head: "lane/x", prExists, env: { HOME: home } })
  const ledger = readFileSync(path.join(home, ".local/state/ouroboros-skills/desk/turn-ends/s1.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  return { ...r, ledger }
}

test("done passes only when GitHub shows a PR for the lane branch, and is recorded", () => {
  const ok = run("Ending: done; shipped: x", () => PR)
  assert.equal(ok.code, 0)
  assert.deepEqual(ok.ledger[0].ending, { kind: "done", shipped: PR })
  const no = run("Ending: done; shipped: " + PR, () => null)
  assert.equal(no.code, 10)
  assert.match(no.text, /no pull request for lane\/x/)
  assert.equal(no.ledger[0].ending.kind, "unverified")
})

test("a headless lane cannot end waiting, or blocked on itself, or with no Ending line", () => {
  const wait = run("Ending: waiting; on: CI; wake: abcd1234; expires: 2999-01-01T00:00:00Z; blocks: all", () => PR)
  assert.equal(wait.code, 10)
  assert.match(wait.text, /cannot register a wake/)
  assert.equal(run("Ending: blocked; on: CI; resume: rerun the whole thing", () => PR).code, 10)
  assert.equal(run("all done, trust me", () => PR).code, 10)
})

test("blocked on a person and no ready work are valid recorded endings", () => {
  assert.equal(run("Ending: blocked; on: Ari; resume: grant the privacy permission then rerun", () => null).code, 0)
  const idle = run("Ending: no ready work; checked: roadmap ready list and issue queue", () => null)
  assert.equal(idle.code, 0)
  assert.equal(idle.ledger[0].ending.kind, "no_ready_work")
})

test("the command exits 10 with resume text, and 2 on a bad call", () => {
  const home = mkdtempSync(path.join(tmpdir(), "gate-"))
  const file = path.join(home, "out.txt")
  writeFileSync(file, "Ending: no ready work; checked: nothing yet")
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: "" }
  const bad = spawnSync(process.execPath, [GATE, "check", "--session", "s2", "--evidence-file", file, "--pr-head", "lane/x", "--repo", "o/r"], { env, encoding: "utf8" })
  assert.equal(bad.status, 0, bad.stderr)
  writeFileSync(file, "no ending")
  const r = spawnSync(process.execPath, [GATE, "check", "--session", "s2", "--evidence-file", file, "--pr-head", "lane/x", "--repo", "o/r"], { env, encoding: "utf8" })
  assert.equal(r.status, 10)
  assert.match(r.stdout, /Ending: done/)
  assert.equal(spawnSync(process.execPath, [GATE, "check"], { env, encoding: "utf8" }).status, 2)
  assert.ok(readdirSync(path.join(home, ".local/state/ouroboros-skills/desk/turn-ends")).includes("s2.jsonl"))
})
