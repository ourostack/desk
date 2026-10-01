import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { LIFECYCLE_STATES, TERMINAL_STATES, invalidStatusMessage, normalizeStatus } from "../../../../../plugins/desk/mcp/src/desk/lifecycle.js"
import { ENUMS } from "../../../../../plugins/desk/mcp/src/factory/schema.js"

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/mcp/src")

test("the lifecycle lists are the eight states and the two terminal ones, and are frozen", () => {
  assert.deepEqual([...LIFECYCLE_STATES], ["drafting", "processing", "validating", "collaborating", "paused", "blocked", "done", "cancelled"])
  assert.deepEqual([...TERMINAL_STATES], ["done", "cancelled"])
  assert.ok(Object.isFrozen(LIFECYCLE_STATES) && Object.isFrozen(TERMINAL_STATES))
})

test("normalizeStatus returns a valid state unchanged", () => {
  for (const state of LIFECYCLE_STATES) assert.deepEqual(normalizeStatus(state), { status: state, known: true })
})

test("normalizeStatus maps every ghost status, folding case and separators", () => {
  const cases = {
    processing: ["active", "Active", "doing", "DOING", "in progress", "in-progress", "in_progress", "IN_PROGRESS", " In  Progress ", "in-_ progress", "Processing"],
    drafting: ["planning", "Planning", "backlog", "BACKLOG"],
    collaborating: ["needs review", "needs_review", "NEEDS_REVIEW", "Needs-Review"],
    blocked: ["waiting", "Waiting"],
    done: ["Done"],
  }
  for (const [state, values] of Object.entries(cases)) {
    for (const value of values) assert.deepEqual(normalizeStatus(value), { status: state, known: true }, value)
  }
})

test("normalizeStatus never guesses at other values", () => {
  for (const value of ["on hold", "wip", "", "  ", "in progress now", null, undefined, 3, {}, "__proto__", "constructor"]) {
    assert.deepEqual(normalizeStatus(value), { status: null, known: false }, String(value))
  }
})

test("invalidStatusMessage names the value and lists the eight states", () => {
  const message = invalidStatusMessage("active")
  assert.match(message, /"active"/)
  for (const state of LIFECYCLE_STATES) assert.ok(message.includes(state))
  assert.match(invalidStatusMessage(3), /invalid status 3:/)
  assert.match(invalidStatusMessage(undefined), /invalid status undefined:/)
})

// The factory imports only `node:` modules and its own files, so it keeps its own copies of the lists. They must not drift.
function setLiteral(file, name) {
  const text = readFileSync(path.join(src, file), "utf8")
  const match = new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\)`, "u").exec(text)
  assert.ok(match, `${file} defines ${name}`)
  return JSON.parse(match[1])
}

test("the factory's copies of the lifecycle lists equal lifecycle.js", () => {
  assert.deepEqual([...ENUMS.jobStatus], [...LIFECYCLE_STATES])
  for (const [file, name] of [
    ["factory/binding.js", "TERMINAL"],
    ["factory/boot-check.js", "TERMINAL"],
    ["factory/pipeline/formulas.js", "TERMINAL_STATUSES"],
    ["factory/pipeline/rollups.js", "TERMINAL_STATUSES"],
  ]) {
    assert.deepEqual(setLiteral(file, name), [...TERMINAL_STATES], `${file} ${name}`)
  }
})
