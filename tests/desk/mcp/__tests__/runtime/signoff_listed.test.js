// The session record of the unsigned deliveries a boot listed, so a resumed or compacted session is not asked twice (Package H).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { SIGNOFF_LISTED_DIR, hostSessionId, listedFile, noteSignoffListed } from "../../../../../plugins/desk/mcp/src/runtime/signoff-listed.js"
import { signoffInstructions } from "../../../../../plugins/desk/mcp/src/desk/unsigned-deliveries.js"

const ROOT = mkdtempSync(path.join(tmpdir(), "signoff-listed-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const fresh = () => path.join(ROOT, `state-${(counter += 1)}`)
const found = (...slugs) => ({ count: slugs.length, tasks: slugs.map((slug) => ({ track: "ops", slug })) })
const CLAUDE = { CLAUDE_CODE_SESSION_ID: " s1 " }

test("hostSessionId reads Claude Code's id, then Copilot's, and null when the host gives none", () => {
  assert.equal(hostSessionId({ CLAUDE_CODE_SESSION_ID: "a", COPILOT_AGENT_SESSION_ID: "b" }), "a")
  assert.equal(hostSessionId({ CLAUDE_CODE_SESSION_ID: "  ", COPILOT_AGENT_SESSION_ID: "b" }), "b")
  assert.equal(hostSessionId({}), null)
  assert.equal(hostSessionId(undefined), null)
})

test("the first boot of a session notes its list; a later boot with the same list (or part of it) is told it was listed", () => {
  const stateDir = fresh()
  assert.equal(noteSignoffListed(CLAUDE, found("a", "b"), { stateDir }), false)
  assert.deepEqual(JSON.parse(readFileSync(listedFile(stateDir, "s1"), "utf8")), { tasks: ["ops/a", "ops/b"] })
  assert.equal(noteSignoffListed(CLAUDE, found("a", "b"), { stateDir }), true)
  assert.equal(noteSignoffListed(CLAUDE, found("b"), { stateDir }), true, "one signed meanwhile: the rest were listed")
  assert.equal(noteSignoffListed(CLAUDE, found("b", "c"), { stateDir }), false, "a new delivery")
  assert.deepEqual(JSON.parse(readFileSync(listedFile(stateDir, "s1"), "utf8")).tasks, ["ops/a", "ops/b", "ops/c"])
  assert.equal(noteSignoffListed({ CLAUDE_CODE_SESSION_ID: "s2" }, found("a"), { stateDir }), false, "another session has its own record")
})

test("nothing to list, no session id or no state folder is not known; a damaged record reads as empty; a write failure is not known", () => {
  const stateDir = fresh()
  assert.equal(noteSignoffListed({}, found("a"), { stateDir }), undefined)
  assert.equal(noteSignoffListed(CLAUDE, found(), { stateDir }), undefined)
  assert.equal(noteSignoffListed(CLAUDE, null, { stateDir }), undefined)
  assert.equal(noteSignoffListed(CLAUDE, { count: 1, tasks: [{ track: "ops" }, null] }, { stateDir }), undefined)
  assert.equal(noteSignoffListed(CLAUDE, found("a"), {}), undefined)
  assert.equal(noteSignoffListed(CLAUDE, found("a")), undefined)
  mkdirSync(path.dirname(listedFile(stateDir, "s1")), { recursive: true })
  writeFileSync(listedFile(stateDir, "s1"), "{not json")
  assert.equal(noteSignoffListed(CLAUDE, found("a"), { stateDir }), false)
  writeFileSync(listedFile(stateDir, "s1"), JSON.stringify({ tasks: "ops/a" }))
  assert.equal(noteSignoffListed(CLAUDE, found("a"), { stateDir }), false)
  writeFileSync(listedFile(stateDir, "s1"), JSON.stringify({ tasks: ["ops/a", 7] }))
  assert.equal(noteSignoffListed(CLAUDE, found("a"), { stateDir }), true)
  const blocked = path.join(ROOT, `file-${(counter += 1)}`)
  writeFileSync(blocked, "x")
  assert.equal(noteSignoffListed(CLAUDE, found("a"), { stateDir: blocked }), undefined)
})

test("a write prunes session records older than a week and skips one it cannot remove", () => {
  const stateDir = fresh()
  const dir = path.join(stateDir, SIGNOFF_LISTED_DIR)
  mkdirSync(path.join(dir, "stuck"), { recursive: true })
  writeFileSync(path.join(dir, "old.json"), "{}")
  const old = new Date(Date.now() - 8 * 86_400_000)
  utimesSync(path.join(dir, "old.json"), old, old)
  utimesSync(path.join(dir, "stuck"), old, old)
  noteSignoffListed(CLAUDE, found("a"), { stateDir })
  const left = readdirSync(dir)
  assert.ok(!left.includes("old.json") && left.includes("stuck"))
})

test("the sign-off line for a list an earlier boot of this session gave says so, and asks for no second raise", () => {
  assert.deepEqual(signoffInstructions({ count: 1, at_least: false, oldest_age_days: 2 }, { noninteractive: false, seen: true }), ["The delivered task that awaits sign-off was already listed by an earlier boot of this session. Raise it only if this session has not raised it yet, never twice, and record the answer with task_signoff when it comes."])
  assert.deepEqual(signoffInstructions({ count: 3, at_least: false, oldest_age_days: 2 }, { noninteractive: false, seen: true }), ["The delivered tasks that await sign-off were already listed by an earlier boot of this session. Raise them only if this session has not raised them yet, never twice, and record each answer with task_signoff when it comes."])
  assert.deepEqual(signoffInstructions({ count: 3, at_least: false, oldest_age_days: 2 }, { noninteractive: true, seen: true }), [])
})
