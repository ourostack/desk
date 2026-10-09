import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "plugins", "desk", "mcp", "src")

// Each of these writes a state file by writing a temp file and renaming it over the real one, so each must retry the rename that
// Windows briefly refuses (Defender, the search indexer). A bare `renameSync` here would put the first-attempt EPERM back.
const RETRIED = [
  "runtime/copilot-session.js",
  "runtime/sync-worker.js",
  "runtime/release-alert.js",
  "runtime/filer-throttle.js",
  "runtime/stale-desk.js",
  "runtime/stale-desk-refresh.js",
  "runtime/signoff-listed.js",
  "factory/filer-launch.js",
  "activation/support-matrix.js",
]

const ALLOWED = {
  "runtime/sync-worker.js": ["renameSync(temporary, lockPath)"],
  "runtime/stale-desk-refresh.js": ['fs.renameSync(cfg.stamp + ".run.tmp", cfg.stamp)'],
}

test("the state-file writers retry their final rename instead of calling renameSync", () => {
  for (const file of RETRIED) {
    const text = readFileSync(path.join(src, file), "utf8")
    assert.match(text, /renameWithRetry\(/u, `${file} retries its rename`)
    // Any `renameSync(` call counts, including `fs.renameSync(`. Two are kept on purpose, each allowed by its exact line: the sync lock takeover, and
    // the line inside the detached refresh runner's RUNNER_SOURCE string.
    const bare = text.split("\n").filter((line) => /\brenameSync\(/u.test(line) && !ALLOWED[file]?.includes(line.trim()))
    assert.equal(bare.length, 0, `${file}: ${bare.join(" | ")}`)
    assert.equal(text.split("\n").filter((line) => /\brenameSync\(/u.test(line)).length, ALLOWED[file]?.length ?? 0, `${file} keeps exactly its allowed renames`)
  }
})
