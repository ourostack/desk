// A test that fakes "a different file" with `ino + 1` silently tests nothing on Windows, where a file id can exceed 2^53 and a Number cannot tell n from n + 1. This fails any test file that does arithmetic on `ino` or `dev`; `_file_identity.js` is the one way to make a different identity.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { different, otherFile } from "../_file_identity.js"

const testsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

// Left alone for now because two open pull requests (#226 and #227) both change it; drop this entry when they land and the file uses `different`.
const EXEMPT = new Set(["readiness/journal_integrity.test.js"])

// An operator directly before or after `ino` or `dev` (through any `a.b.` prefix). A `/` counts only with a space on each side, so a regular expression such as /\/dev\/null/ is not division.
const OPERATOR = String.raw`(?:\+\+|--|\+=|-=|\*=?|%=?|\+(?![+=])|-(?![-=>])|\s/\s)`
const ARITHMETIC = new RegExp(String.raw`(?<![\w.$/\\])(?:\w+\.)*(?:ino|dev)\b\s*${OPERATOR}|${OPERATOR}\s*(?:\w+\.)*(?:ino|dev)\b(?!\s*:)`, "u")

// Strings and comments are blanked first, so "/dev/null", "dev.azure.com" and prose such as "dev-only" never match.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, "")
    .replace(/`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/gu, '""')
}

function arithmeticOnIdentity(source) {
  return codeOnly(source).split("\n").flatMap((line, index) => (ARITHMETIC.test(line) ? [{ line: index + 1, text: line.trim() }] : []))
}

function* testFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures" && entry.name !== "node_modules") yield* testFiles(full)
    } else if (/\.(?:test\.js|test\.mjs|js|mjs)$/u.test(entry.name)) yield full
  }
}

test("no test does arithmetic on a file identity", () => {
  const offenders = []
  for (const file of testFiles(testsRoot)) {
    const relative = path.relative(testsRoot, file).split(path.sep).join("/")
    if (EXEMPT.has(relative) || relative === "_file_identity.js" || relative === "ci/file_identity_arithmetic.test.js") continue
    for (const hit of arithmeticOnIdentity(readFileSync(file, "utf8"))) offenders.push(`${relative}:${hit.line}: ${hit.text}`)
  }
  assert.deepEqual(offenders, [], "use different() or otherFile() from _file_identity.js instead of arithmetic on ino or dev")
})

test("the guard sees arithmetic on ino and dev but not paths, prose or object keys", () => {
  for (const code of ["ino + 1", "stat.ino - 1", "{ ino: stat.ino + 1 }", "x.ino += 1", "ino / 2", "dev * 2", "Math.floor(stat.dev / 2)", "1 + stat.ino", "n - stat.dev"]) {
    assert.equal(arithmeticOnIdentity(code).length, 1, code)
  }
  for (const code of ['"/dev/null"', "// ino + 1", "/* dev - 1 */", "const { dev, ino } = stat", "{ dev: stat.dev, ino: stat.ino }", "ino: -1", "stat.ino === other.ino", "a.dev !== b.dev", "https://dev.azure.com/x", '"unit-6d-dev-only"', "ino => ino"]) {
    assert.equal(arithmeticOnIdentity(code).length, 0, code)
  }
})

test("different() never returns its argument, at any size or type", () => {
  const huge = 10414574139658612
  assert.equal(huge + 1, huge + 1 === huge ? huge : huge + 1, "the premise: a Number this large cannot always tell n from n + 1")
  for (const value of [0, 1, 2, 12345, Number.MAX_SAFE_INTEGER, 2 ** 53, huge, 2 ** 60, 2 ** 63, 0n, 1n, 10414574139658613n, 2n ** 64n, "0", "10414574139658612"]) {
    assert.notEqual(different(value), value, String(value))
    assert.equal(typeof different(value), typeof value)
  }
  assert.deepEqual(Object.keys(otherFile({ dev: 7, ino: huge })), ["dev", "ino"])
  assert.equal(otherFile({ dev: 7, ino: huge }).dev, 7)
  assert.notEqual(otherFile({ dev: 7, ino: huge }).ino, huge)
})
