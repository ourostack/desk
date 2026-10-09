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

test("the state-file writers retry their final rename instead of calling renameSync", () => {
  for (const file of RETRIED) {
    const text = readFileSync(path.join(src, file), "utf8")
    assert.match(text, /renameWithRetry\(/u, `${file} retries its rename`)
    // The sync lock takeover and the detached refresh runner script keep their own rename on purpose; nothing else may.
    const bare = text.split("\n").filter((line) => /(?<![.\w])renameSync\(/u.test(line))
    assert.equal(bare.length, file === "runtime/sync-worker.js" ? 1 : 0, `${file}: ${bare.join(" | ")}`)
  }
})
