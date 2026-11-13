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

// The innermost `{ ... }` block that holds `index`, as { start, text }, or null at the top level.
function enclosingBlock(code, index) {
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
      if (depth === 0) return { start: open, text: code.slice(open, i + 1) }
    }
  }
  return null
}

function enclosingObject(code, index) {
  return enclosingBlock(code, index)?.text ?? null
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

// A result that carries a route also leads with the `next` sentence that says to run it (#623). A route written into an object
// literal is covered when that literal names `next`, calls unfinishedNext or withNext, or is withNext's argument. A route built
// for another result to carry (a commit's route, a card's route) is on route_next_allow.json instead; that list can only shrink.
const NEXT_ALLOW_FILE = path.join(here, "route_next_allow.json")
const NEXT_ALLOWED_AT_MOST = 17

const ROUTE_WRITTEN = /\b\w*route_around\b\s*(?::|=(?!=))/gu
const NEXT_BESIDE = /\bnext:|\bwithNext\(|\bunfinishedNext\(/u

// The source with comments, strings and template literals blanked, same length, so offsets and braces still line up.
function codeOnly(source) {
  return withoutComments(source).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu, (quoted) => quoted[0] + " ".repeat(quoted.length - 2) + quoted[0])
}

// Each route written into a result with no `next` beside it, as { line, text }.
function unnextedRoutes(source) {
  const code = codeOnly(source)
  const lines = source.split("\n")
  const found = new Map()
  for (const match of code.matchAll(ROUTE_WRITTEN)) {
    const block = enclosingBlock(code, match.index)
    if (block !== null && /\b(?:const|let|var)\s*$/u.test(code.slice(Math.max(0, block.start - 10), block.start))) continue
    const wrapped = block !== null && /\bwithNext\(\s*$/u.test(code.slice(Math.max(0, block.start - 20), block.start))
    if (block !== null && (wrapped || NEXT_BESIDE.test(block.text))) continue
    const line = code.slice(0, match.index).split("\n").length
    if (!found.has(line)) found.set(line, { line, text: lines[line - 1].trim() })
  }
  return [...found.values()].sort((a, b) => a.line - b.line)
}

function nextFindings() {
  return sourceFiles(toolsRoot).flatMap((file) => {
    const rel = path.relative(toolsRoot, file).split(path.sep).join("/")
    return unnextedRoutes(readFileSync(file, "utf8")).map((finding) => ({ file: rel, ...finding }))
  })
}

const nextAllowList = () => JSON.parse(readFileSync(NEXT_ALLOW_FILE, "utf8"))

test("the next scan finds a route without its next sentence, and passes one that carries it", () => {
  assert.deepEqual(unnextedRoutes('return { status: "failed", route_around: commitRoute({}) }\n'), [{ line: 1, text: 'return { status: "failed", route_around: commitRoute({}) }' }])
  assert.deepEqual(unnextedRoutes('return withNext({ status: "failed", route_around: commitRoute({}) })\n'), [])
  assert.deepEqual(unnextedRoutes('return { next: unfinishedNext(r, "route_around"), status: "failed", route_around: r }\n'), [])
  assert.deepEqual(unnextedRoutes('const text = `set route_around: x`\n'), [], "a route named in text is not a route")
  assert.deepEqual(unnextedRoutes('return { status: "failed", reason, route: commitRoute({}) }\n'), [], "only a route_around key counts")
})

test("every result that carries route_around leads with next, or is on the shrinking next allow-list", () => {
  const allow = nextAllowList()
  const uncovered = nextFindings().filter((finding) => !allow.some((entry) => allows(entry, finding)))
  assert.deepEqual(uncovered.map((finding) => `${finding.file}:${finding.line} ${finding.text}`), [], "a result with route_around has no next sentence: build it with withNext(), or put next: unfinishedNext(route, where) beside the route (see util/route-around.js)")
})

test("the next allow-list only shrinks: every entry still matches a route, with a reason, and stays within the cap", () => {
  const allow = nextAllowList()
  const findings = nextFindings()
  for (const entry of allow) assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, `${entry.file} has a reason`)
  const stale = allow.filter((entry) => !findings.some((finding) => allows(entry, finding)))
  assert.deepEqual(stale.map((entry) => `${entry.file}: ${entry.match}`), [], "a next allow-list entry matches no route: delete it and lower NEXT_ALLOWED_AT_MOST")
  assert.ok(allow.length <= NEXT_ALLOWED_AT_MOST, `the next allow-list holds ${allow.length}; it can only shrink, to at most ${NEXT_ALLOWED_AT_MOST}`)
})
