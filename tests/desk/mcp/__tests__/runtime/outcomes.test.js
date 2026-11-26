import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"
import { endingsDir, progressOf, readEndings } from "../../../../../plugins/desk/mcp/src/runtime/outcomes.js"

const PR1 = "https://github.com/ourostack/desk/pull/1"
const PR2 = "https://github.com/ourostack/desk/pull/2"
const done = (card, shipped, at = "2026-11-26T10:00:00Z") => ({ card, at, ending: { kind: "done", shipped } })
const lookup = (url) => ({ [PR1]: { merged: true, mergedAt: "2026-11-26T11:00:00Z" }, [PR2]: { merged: false, mergedAt: null } })[url] ?? null

test("a merged pull request counts, once, however often it is claimed", () => {
  const r = progressOf({ card: "t/c", endings: [done("t/c", PR1), done("t/c", PR1)], lookup })
  assert.equal(r.count, 1)
})

test("gaming: an unmerged pull request, an unknown one, a bare sha and another card's pull request add nothing", () => {
  const r = progressOf({ card: "t/c", endings: [done("t/c", PR2), done("t/c", "https://github.com/ourostack/desk/pull/9"), done("t/c", "abcdef1"), done("t/other", PR1)], lookup })
  assert.equal(r.count, 0)
  assert.equal(r.unverified.length, 3)
})

test("gaming: waiting, blocked, no-ready-work endings, messages and busy never count", () => {
  const endings = [{ card: "t/c", ending: { kind: "waiting", on: "ci" } }, { card: "t/c", ending: { kind: "no_ready_work", checked: "x" } }, { card: "t/c", ending: { kind: "unverified" } }]
  assert.equal(progressOf({ card: "t/c", endings, lookup, messages: 500, commits: 50, busy: true }).count, 0)
})

test("an acceptance check counts only as passed on a named version", () => {
  const acceptance = [{ card: "t/c", check: "smoke", version: "v1.2.0", passed: true }, { card: "t/c", check: "smoke", version: "", passed: true }, { card: "t/c", check: "smoke", version: "v1.2.0", passed: false }]
  const r = progressOf({ card: "t/c", acceptance, lookup })
  assert.equal(r.count, 1)
  assert.equal(r.shipped[0].ref, "smoke@v1.2.0")
})

test("readEndings skips damaged lines and orders by time", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "endings-"))
  writeFileSync(path.join(dir, "a.jsonl"), `${JSON.stringify({ at: "2", card: "b" })}\nnot json\n${JSON.stringify({ at: "1", card: "a" })}\n`)
  assert.deepEqual(readEndings(dir).map((e) => e.card), ["a", "b"])
})

test("endingsDir follows XDG_STATE_HOME when absolute and HOME otherwise", () => {
  assert.equal(endingsDir({ HOME: "/h", XDG_STATE_HOME: "/x" }), path.join("/x", "ouroboros-skills", "desk", "turn-ends"))
  assert.equal(endingsDir({ HOME: "/h", XDG_STATE_HOME: "rel" }), path.join("/h", ".local", "state", "ouroboros-skills", "desk", "turn-ends"))
})

// A stand-in `gh` that answers `pr view` from the PR number in the URL: 1 merged, 2 open, anything else fails.
function withFakeGh(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "fakegh-"))
  mkdirSync(dir, { recursive: true })
  const gh = path.join(dir, "gh")
  writeFileSync(gh, `#!/bin/sh\ncase "$3" in\n*/pull/1) printf 'MERGED\\t2026-11-26T11:00:00Z\\n';;\n*/pull/2) printf 'OPEN\\t\\n';;\n*) exit 1;;\nesac\n`)
  chmodSync(gh, 0o755)
  const before = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${before}`
  return Promise.resolve(fn()).finally(() => { process.env.PATH = before })
}

test("drains progress counts only what GitHub confirms merged, through the real lookup", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "state-"))
  const dir = path.join(state, "ouroboros-skills", "desk", "turn-ends")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "s.jsonl"), [done("t/c", PR1), done("t/c", PR2), done("t/c", "https://github.com/ourostack/desk/pull/3"), done("t/c", "not a url")].map((e) => JSON.stringify(e)).join("\n"))
  const run = async (argv) => {
    const out = []; const err = []
    const io = { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) } }
    const code = await runDrainsCli({ argv, script: "drains", io, env: { ...process.env, XDG_STATE_HOME: state } })
    return { code, out: out.join(""), err: err.join("") }
  }
  await withFakeGh(async () => {
    const ok = await run(["progress", "--card", "t/c"])
    assert.equal(ok.code, 0)
    assert.match(ok.out, /1 shipped, 3 claimed but not confirmed/)
    const none = await run(["progress", "--card", " "])
    assert.notEqual(none.code, 0)
    assert.match(none.err + none.out, /no card was given/)
  })
})
