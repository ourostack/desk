// Keeps the desk's `.state/` folder (the search index, readiness fences) out of `git status`. A desk made by
// first-run-bootstrap has `.state/` in its `.gitignore`, but an older or hand-made desk may not, and then every session
// shows an untracked `.state/` that agents tidy up or commit. Desk creates the folder, so Desk makes sure it is ignored:
// it adds the pattern to the repository's own `info/exclude`, which is local to the checkout and never committed, so no
// file in the desk changes and nothing needs a commit.

import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

const handled = new Set()

/**
 * Makes sure git ignores `<root>/.state/`. Does nothing when the desk is not a git repository or already ignores the folder
 * (its `.gitignore`, a global ignore or an earlier call). Returns whether it added the pattern. Never throws: the folder is
 * more important than the tidiness, so a failure leaves things as they were. Asks git once per desk per process.
 */
export function ensureStateIgnored(root, { spawnGit = spawnSync } = {}) {
  if (handled.has(root)) return false
  try {
    const exclude = spawnGit("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", timeout: 5000 })
    if (exclude.status !== 0) return false
    handled.add(root)
    if (spawnGit("git", ["-C", root, "check-ignore", "-q", ".state/desk-index.sqlite"], { timeout: 5000 }).status === 0) return false
    const file = path.resolve(root, exclude.stdout.trim())
    mkdirSync(path.dirname(file), { recursive: true })
    const existing = existsSync(file) ? readFileSync(file, "utf8") : ""
    appendFileSync(file, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}.state/\n`)
    return true
  } catch {
    return false
  }
}
