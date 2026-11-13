// Every failing Desk tool result says how to finish the job by hand (#561, #623). A failure, a pending or unknown state, a timeout
// or a pull request left open is a result object that names one of those statuses. This test reads every source file under
// src/tools and fails when such an object carries no `route_around`. It is a textual check: it finds the innermost object
// literal around each status, so a route built by a helper (commitFailure, commitRoute, retryRoute) counts only when the object
// names `route_around`. `in_effect: false` counts only inside an object that also has a `status`, because a state alone (a
// lesson-team result being built) is not a result yet. Genuine exceptions sit in route_around_allow.json; that list can only shrink.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const toolsRoot = path.resolve(here, "../../../../../plugins/desk/mcp/src/tools")
const ALLOW_FILE = path.join(here, "route_around_allow.json")

// The allow-list can only shrink: lower this number when an entry is deleted.
const ALLOWED_AT_MOST = 7

const FAILURE_STATUS = /\bstatus: "(?:failed|pending|timeout|unknown|pr_open)"/gu
const NOT_IN_EFFECT = /\bin_effect: false\b/gu

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) return sourceFiles(file)
    return name.endsWith(".js") ? [file] : []
  })
}

// The source with comment lines blanked, same length, so offsets and line numbers still line up.
function withoutComments(source) {
  return source.split("\n").map((line) => (/^\s*(?:\/\/|\/\*|\*)/u.test(line) ? "" : line)).join("\n")
}

// The same text with string contents blanked, so braces inside quoted text cannot unbalance the object search.
function braceView(code) {
  return code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu, (quoted) => quoted[0] + " ".repeat(quoted.length - 2) + quoted[0])
}

// The object literal that holds `index`: from its innermost unclosed `{` to the matching `}`, or null at the top level.
function enclosingObject(code, index) {
  let depth = 0
  let open = -1
  for (let i = index - 1; i >= 0 && open < 0; i -= 1) {
    if (code[i] === "}") depth += 1
    else if (code[i] === "{") {
      if (depth === 0) open = i
      else depth -= 1
    }
  }
  if (open < 0) return null
  depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1
    else if (code[i] === "}") {
      depth -= 1
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  return null
}

// Each failing result in one file that carries no `route_around`, as { line, text }.
function unroutedFailures(source) {
  const code = withoutComments(source)
  const braces = braceView(code)
  const lines = source.split("\n")
  const found = new Map()
  const check = (pattern, needsStatus) => {
    for (const match of code.matchAll(pattern)) {
      const object = enclosingObject(braces, match.index)
      if (object === null || (needsStatus && !/\bstatus:/u.test(object))) continue
      if (/\broute_around\b/u.test(object)) continue
      const line = code.slice(0, match.index).split("\n").length
      if (!found.has(line)) found.set(line, { line, text: lines[line - 1].trim() })
    }
  }
  check(FAILURE_STATUS, false)
  check(NOT_IN_EFFECT, true)
  return [...found.values()].sort((a, b) => a.line - b.line)
}

function findings() {
  return sourceFiles(toolsRoot).flatMap((file) => {
    const rel = path.relative(toolsRoot, file).split(path.sep).join("/")
    return unroutedFailures(readFileSync(file, "utf8")).map((finding) => ({ file: rel, ...finding }))
  })
}

const allowList = () => JSON.parse(readFileSync(ALLOW_FILE, "utf8"))
const allows = (entry, finding) => entry.file === finding.file && finding.text.includes(entry.match)

test("the scan finds a failing result without a route, and passes one that carries it", () => {
  assert.deepEqual(unroutedFailures('const a = {\n  status: "failed",\n  reason: "x",\n}\n'), [{ line: 2, text: 'status: "failed",' }])
  assert.deepEqual(unroutedFailures('return { status: "failed", reason, route_around: commitRoute({}) }\n'), [])
  assert.deepEqual(unroutedFailures('return { ...result, in_effect: false, message: "x" }\n'), [], "a bare state is not a failure")
  assert.equal(unroutedFailures('return { ...result, status: "pr_open", in_effect: false }\n').length, 1)
  assert.deepEqual(unroutedFailures('if (x) return { status: "unchanged" }\n'), [])
})

test("every failing result under src/tools carries route_around, or is on the shrinking allow-list", () => {
  const allow = allowList()
  const unrouted = findings()
  const uncovered = unrouted.filter((finding) => !allow.some((entry) => allows(entry, finding)))
  assert.deepEqual(uncovered.map((finding) => `${finding.file}:${finding.line} ${finding.text}`), [], "a failing result has no route_around: build it with commitRoute, commitFailure or a retry route (see util/route-around.js)")
})

test("the allow-list only shrinks: every entry still matches a failing result, with a reason, and stays within the cap", () => {
  const allow = allowList()
  const unrouted = findings()
  for (const entry of allow) assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, `${entry.file} has a reason`)
  const stale = allow.filter((entry) => !unrouted.some((finding) => allows(entry, finding)))
  assert.deepEqual(stale.map((entry) => `${entry.file}: ${entry.match}`), [], "an allow-list entry matches no failing result: delete it and lower ALLOWED_AT_MOST")
  assert.ok(allow.length <= ALLOWED_AT_MOST, `the allow-list holds ${allow.length}; it can only shrink, to at most ${ALLOWED_AT_MOST}`)
})
