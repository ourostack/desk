// No code may rely on the synchronous removal's own retry options. In Node 24.18 the native `rmSync` does not retry a Windows
// access-denied (it retries EPERM only as `operation_not_permitted`, and a Windows access-denied is `permission_denied`), and it
// waits `i * retryDelay / 1000` (whole seconds on POSIX, milliseconds divided by a thousand on Windows), so a delay under a second
// is no wait at all. Those options look like a retry and are not one. Use `removeTree` (tests/desk/mcp/__tests__/_remove_tree.js,
// async) or `removeWithRetry` (plugins/desk/mcp/src/util/remove-retry.js, sync).
//
// The rule is deliberately blunt, because the call can hide behind an alias (`const remove = fs.rmSync`, `{ rmSync: remove }`,
// `fs["rmSync"]`, `.call`) and its options can be built elsewhere or spread in: a file that names the synchronous removal must not
// also name the retry option. The allowed files below name both for a reason given with each.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const SELF = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(SELF), "..", "..", "..", "..", "..")
const SCANNED = ["plugins", "tests", "scripts", "evals", "hosted"]
const SKIPPED = new Set(["node_modules", ".git"])
const ALLOWED = new Map([
  [path.relative(repoRoot, SELF), "this guard names both to describe the rule"],
  [path.join("evals", "boot-acceptance", "lib.mjs"), "its retry options are on the async rm in cleanupRunDir; its one rmSync has none"],
])

const namesSyncRemoval = (text) => /\brmSync\b/u.test(text)
const namesRetryOption = (text) => /\bmaxRetries\b/u.test(text)
const offends = (text) => namesSyncRemoval(text) && namesRetryOption(text)

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

test("no file both names the synchronous removal and its retry option, whose retries Node 24.18 does not honour", () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(path.join(repoRoot, dir)))
  assert.ok(files.length > 500, `the scan reached the code (${files.length} files)`)
  const offenders = files
    .map((file) => path.relative(repoRoot, file))
    .filter((file) => !ALLOWED.has(file) && offends(readFileSync(path.join(repoRoot, file), "utf8")))
  assert.deepEqual(offenders, [])
})

test("every allowed file still exists and still names both, so the list cannot go stale", () => {
  for (const [file, reason] of ALLOWED) assert.ok(offends(readFileSync(path.join(repoRoot, file), "utf8")), `${file} (${reason})`)
})

test("the rule catches the aliased and indirect forms, and leaves a file with only one of the two names alone", () => {
  for (const text of [
    "rmSync(root, { recursive: true, force: true, maxRetries: 5 })",
    "const originalRm = fs.rmSync\noriginalRm(dir, { recursive: true, maxRetries: 3 })",
    "const { rmSync: remove } = fs\nremove(dir, options)\nconst options = { maxRetries: 3 }",
    'fs["rmSync"].call(fs, dir, { ...base, maxRetries: 2 })',
  ]) assert.equal(offends(text), true, text)
  for (const text of [
    "rmSync(root, { recursive: true, force: true })",
    "await fs.promises.rm(root, { recursive: true, maxRetries: 10 })",
  ]) assert.equal(offends(text), false, text)
})
