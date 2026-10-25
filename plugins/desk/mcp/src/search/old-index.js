// Older Desk builds kept a shared search index in `.state/desk-index.sqlite`, which could grow to many gigabytes. This
// build never reads it, so it removes it at start, but only when no process has it open: an older build still running
// in another session keeps it (and may recreate it), and a later start tries again.
import { spawnSync } from "node:child_process"
import { readdirSync, statSync, unlinkSync } from "node:fs"
import * as path from "node:path"

const OLD_INDEX = /^desk-index\.sqlite(?:\.corrupt-\d+)?(?:-wal|-shm)?$/u

// True only when `lsof` ran and found none of `files` open. Windows has no lsof: there a file another process has
// open cannot be deleted, so the deletion itself is the check.
function noneOpen(files, { platform, run }) {
  if (platform === "win32") return true
  const result = run("lsof", ["-t", "--", ...files], { encoding: "utf8", timeout: 10_000 })
  return result.error === undefined && result.status === 1 && String(result.stdout).trim() === ""
}

export function removeOldIndex(stateDir, { platform = process.platform, run = spawnSync } = {}) {
  let files
  try {
    files = readdirSync(stateDir).filter((name) => OLD_INDEX.test(name)).map((name) => path.join(stateDir, name))
  } catch {
    return { removed: false, bytes: 0 }
  }
  if (files.length === 0 || !noneOpen(files, { platform, run })) return { removed: false, bytes: 0 }
  let bytes = 0
  for (const file of files) {
    try {
      const size = statSync(file).size
      unlinkSync(file)
      bytes += size
    } catch {
      // In use (Windows) or already gone: left for the next start.
    }
  }
  return { removed: bytes > 0, bytes }
}
