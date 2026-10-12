// No code may rely on the synchronous removal's own retry options. In Node 24.18 the native `rmSync` does not retry a Windows
// access-denied (it retries EPERM only as `operation_not_permitted`, and a Windows access-denied is `permission_denied`), and its
// Windows wait rounds a delay under a second to nothing, so those options look like a retry and are not one. Use
// `removeTree` (tests/desk/mcp/__tests__/_remove_tree.js, async) or `removeWithRetry` (plugins/desk/mcp/src/util/remove-retry.js, sync).
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const SELF = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(SELF), "..", "..", "..", "..", "..")
const SCANNED = ["plugins", "tests", "scripts", "evals", "hosted"]
const SKIPPED = new Set(["node_modules", ".git"])
// A call to the synchronous removal whose arguments, up to its closing parenthesis, name the retry option.
const RETRYING_SYNC_REMOVAL = /\brmSync\s*\((?:[^()]|\([^()]*\))*?\bmaxRetries\b/su

function sourceFiles(directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  return entries.flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return []
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(?:c|m)?js$/u.test(entry.name) ? [full] : []
  })
}

test("no code passes retry options to the synchronous removal, whose retries Node 24.18 does not honour on Windows", () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(path.join(repoRoot, dir)))
  assert.ok(files.length > 500, `the scan reached the code (${files.length} files)`)
  const offenders = files
    .filter((file) => file !== SELF && RETRYING_SYNC_REMOVAL.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(repoRoot, file))
  assert.deepEqual(offenders, [])
})

test("the guard recognises the forms it forbids and leaves the others alone", () => {
  const matches = (text) => RETRYING_SYNC_REMOVAL.test(text)
  assert.equal(matches("rmSync(root, { recursive: true, force: true, maxRetries: 5 })"), true)
  assert.equal(matches("fs.rmSync(\n  root,\n  { recursive: true, maxRetries: windows ? 40 : 5 },\n)"), true)
  assert.equal(matches("rmSync(path.join(root, name), { recursive: true, maxRetries: 3 })"), true)
  assert.equal(matches("rmSync(root, { recursive: true, force: true })"), false)
  assert.equal(matches("rmSync(root, { recursive: true })\nawait fs.rm(other, { maxRetries: 10 })"), false)
})
