// Older Desk builds kept a shared search index in `.state/desk-index.sqlite`, which could grow to many gigabytes. This
// build never reads it, so it removes it at start, but only when no process has it open: an older build still running
// in another session keeps it (and may recreate it), and a later start tries again.
import { execFile } from "node:child_process"
import { readdir, stat, unlink } from "node:fs/promises"
import * as path from "node:path"

const OLD_INDEX = /^desk-index\.sqlite(?:\.corrupt-\d+)?(?:-wal|-shm)?$/u

// True only when `lsof` ran and found none of `files` open: it exits 1 with no output then. Windows has no lsof, and
// there a file another process has open cannot be deleted, so the deletion itself is the check.
async function noneOpen(files, { platform, run }) {
  if (platform === "win32") return true
  const result = await run("lsof", ["-t", "--", ...files])
  return result.error === undefined && result.status === 1 && String(result.stdout).trim() === ""
}

/** Runs a command and resolves with its exit status and output, or with the error that kept it from running. */
export function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
      resolve(error === null ? { status: 0, stdout } : typeof error.code === "number" ? { status: error.code, stdout } : { error, stdout })
    })
  })
}

export async function removeOldIndex(stateDir, { platform = process.platform, run = runCommand } = {}) {
  let files
  try {
    files = (await readdir(stateDir)).filter((name) => OLD_INDEX.test(name)).map((name) => path.join(stateDir, name))
  } catch {
    return { removed: false, bytes: 0 }
  }
  if (files.length === 0 || !await noneOpen(files, { platform, run })) return { removed: false, bytes: 0 }
  let bytes = 0
  for (const file of files) {
    try {
      const size = (await stat(file)).size
      await unlink(file)
      bytes += size
    } catch {
      // In use (Windows) or already gone: left for the next start.
    }
  }
  return { removed: bytes > 0, bytes }
}
