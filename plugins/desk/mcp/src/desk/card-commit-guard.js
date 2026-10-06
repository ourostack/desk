// The desk's own git pre-commit hook: a commit that changes a live task card (`<track>/<slug>/task.md`, or the same under
// `desks/<alias>/`) is refused unless Desk itself is committing.
//
// Why (boot acceptance round E, run 8): an agent rewrote a live card with a node script and committed it by hand, which skips
// every check `task_update` makes (valid transitions, `done` evidence, the dated progress note). The tool-call guard
// (`runtime/task-status-guard.js`) sees host Edit/Write calls and, best effort, shell commands that name a card; it cannot see
// a script that builds the path in pieces. This hook is the other layer: whatever wrote the file, the commit that records it
// has to come from Desk. Desk's own commits all go through `util/git-stage.js`'s `commitPaths`, which sets `DESK_TOOL_COMMIT=1`
// for the git call; the one hand-run commit Desk's own flows ask for (the one-time tidy, `migrations/02-tidy-desk.md`) sets it too.
//
// What counts as a change to a live card: a card added or modified in the commit, a type change, or a rename that also edits it
// (`R<100`). Deleting a card and a pure rename (`R100`) pass, so archiving and moving a task by `git mv` still commit by hand.
// The check reads `git diff --cached`, which is the index the commit is made from (a `git commit -- <paths>` uses a temporary
// index and git points `GIT_INDEX_FILE` at it for the hook, so the check sees exactly what would be committed).
//
// Installing. `installCardGuard` writes `pre-commit` into the hooks folder git itself resolves (`git rev-parse --git-path hooks`,
// so a `core.hooksPath` is respected, never replaced). A pre-commit hook that is not Desk's is renamed to
// `pre-commit.desk-chained` and Desk's hook runs it after its own check, with git's arguments, so nothing the desk already
// enforced is lost. Desk's hook carries a marker line and a version: installing again with the current text changes nothing, and
// an older Desk hook is rewritten in place. The hook only acts in a folder that looks like a desk (`_meta/` plus `_archive/` or
// `desks/`), so a shared hooks folder does not guard other repositories.
//
// Re-entry and conflicts. The hook sets `DESK_CARD_GUARD_RUNNING` while it runs and exits 0 when it is entered again, because the pre-commit
// framework moves the hook it finds to `pre-commit.legacy` and runs it from its own hook, which Desk's hook would chain back to. It runs the chained hook
// as a child (not `exec`) and never chains a file that carries the Desk marker. While a merge, cherry-pick or revert is in progress (`MERGE_HEAD`,
// `CHERRY_PICK_HEAD`, `REVERT_HEAD`) the hook passes: resolving a conflict in a card is a git operation, not a card write. A staged card whose
// frontmatter does not parse also passes, so a corrupted card that `task_update` cannot read can be repaired by hand.
//
// A foreign tool that rewrites `pre-commit` later (husky regenerating its hooks) is handled by the next install: the new foreign hook replaces the stale
// chained one, the old chained file is kept as `pre-commit.desk-chained.bak-<timestamp>`, and Desk's hook goes back in front. A `core.hooksPath` that
// points into tracked files is never modified: the install reports "tracked" and the boot gives the manual remedy. `uninstallCardGuard` removes the hook
// and puts a chained hook back as `pre-commit`.
//
// Out of scope, by design: `DESK_TOOL_COMMIT=1 git commit` and `git commit --no-verify` skip the hook. A deliberate override is
// the operator's or the agent's own decision, and the hook's purpose is to stop the accident, not to be a lock. A hook that
// cannot be installed (a read-only hooks folder, a chained hook already in the way) is reported by the boot as a degraded line.

import { spawnSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { DEFERRED_TOOLS_LOAD_HINT } from "../util/deferred-tools.js"

/** The environment variable Desk's own commit path sets for the git call. */
export const TOOL_COMMIT_ENV = "DESK_TOOL_COMMIT"
/** The first marker line of the hook Desk writes. */
export const HOOK_MARKER = "# desk-card-commit-guard"
export const HOOK_VERSION = 5
export const CHAINED_NAME = "pre-commit.desk-chained"
/** Set by the hook while it runs; a second entry (the pre-commit framework's `pre-commit.legacy` chain) exits 0 instead of looping. */
export const RUNNING_ENV = "DESK_CARD_GUARD_RUNNING"
/** The name the pre-commit framework gives the hook it found when it installed itself. */
export const LEGACY_NAME = "pre-commit.legacy"

const GIT_TIMEOUT_MS = 5000

const AWK_PROGRAM = `
function live(p,  n, parts, q) {
  q = tolower(p)
  n = split(q, parts, "/")
  if (parts[n] != "task.md") return 0
  if (parts[1] == "desks") {
    if (n != 5) return 0
    return substr(parts[3], 1, 1) != "_" && substr(parts[3], 1, 1) != "."
  }
  if (n != 3) return 0
  return substr(parts[1], 1, 1) != "_" && substr(parts[1], 1, 1) != "."
}
{ if (live($0)) print $0 }
`

// A staged card is "readable" when it opens with a \`---\` line, has a closing \`---\` and at least one \`key:\` line between them. Anything else is a card
// \`task_update\` cannot parse, which a human may repair by hand. Tolerates CRLF.
const STRUCTURE_AWK = `NR == 1 { if ($0 !~ /^---[ \\t\\r]*$/) exit 1; next } /^---[ \\t\\r]*$/ { if (keys > 0) ok = 1; exit } /^[A-Za-z_][A-Za-z0-9_-]*:/ { keys++ } END { exit ok ? 0 : 1 }`

/** The hook's text: a POSIX shell script with LF line endings, so it runs wherever git runs hooks (Git for Windows ships `sh`). */
export function hookScript() {
  const hint = DEFERRED_TOOLS_LOAD_HINT.replace(/'/gu, "'\\''")
  return `#!/bin/sh
${HOOK_MARKER} v${HOOK_VERSION}
# Installed by Desk (and rewritten by it when it changes). Refuses a commit that changes a live task card unless Desk itself
# is committing. Any pre-commit hook that was here before is kept as ${CHAINED_NAME} and runs after this check.
# To remove it, see "Removing the card guard" in the Desk README (uninstallCardGuard).
[ -n "$${RUNNING_ENV}" ] && exit 0
${RUNNING_ENV}=1
export ${RUNNING_ENV}
desk_card_readable() {
  awk '${STRUCTURE_AWK}'
}
desk_card_guard() {
  [ -n "$${TOOL_COMMIT_ENV}" ] && return 0
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  [ -d "$top/_meta" ] || return 0
  [ -d "$top/_archive" ] || [ -d "$top/desks" ] || return 0
  gitdir=$(git rev-parse --git-dir 2>/dev/null) || return 0
  for state in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
    [ -f "$gitdir/$state" ] && return 0
  done
  cards=$(git diff --cached -z --name-only --diff-filter=AMT -M100% | tr '\\0' '\\n' | awk '${AWK_PROGRAM}')
  [ -n "$cards" ] || return 0
  refused=$(echo "$cards" | while IFS= read -r card; do
    if git show ":$card" 2>/dev/null | desk_card_readable; then echo "$card"; fi
  done)
  [ -n "$refused" ] || return 0
  {
    first=$(echo "$refused" | head -n 1)
    unstage="git -C \\"$top\\" restore --staged \\"$first\\""
    if [ "\${#unstage}" -le 100 ]; then echo "Run $unstage and call task_update for it."; else echo "Run the command below, then call task_update for the card."; echo "$unstage"; fi
    echo "Desk refused this commit because it changes a task card, and a card is written only through Desk's tools, which commit it for you:"
    echo "$refused" | sed 's/^/  /'
    echo "Use task_update (status, repos, a progress note, the next step, more body text), task_create, task_move or task_archive: each writes the card and commits it for you."
    echo '${hint}'
    echo "To commit your other work, take each card out of this commit first (git restore --staged <card path>), then use task_update for the card itself."
  } >&2
  return 1
}
desk_card_guard || exit 1
chained="$(dirname "$0")/${CHAINED_NAME}"
if [ -x "$chained" ] && ! grep -q '${HOOK_MARKER}' "$chained" 2>/dev/null; then
  "$chained" "$@"
  exit $?
fi
exit 0
`
}

/**
 * Whether a path relative to the desk root (either slash style) is a live task card: `<track>/<slug>/task.md`, or the same under
 * `desks/<alias>/`, with a track that is not a `_` or `.` folder. The shell hook applies the same rule to the paths of a commit.
 */
export function isLiveCardPath(relativePath) {
  const parts = String(relativePath).toLowerCase().split(/[\\/]+/u).filter((part) => part !== "" && part !== ".")
  if (parts.at(-1) !== "task.md") return false
  const inner = parts[0] === "desks" ? parts.slice(2) : parts
  return inner.length === 3 && !inner[0].startsWith("_") && !inner[0].startsWith(".")
}

function git(spawnGit, root, args) {
  return spawnGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS })
}

function real(target) {
  try {
    return realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

function present(file) {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

function isDeskHook(text) {
  return text.split("\n", 3).some((line) => line.startsWith(HOOK_MARKER))
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)
}

/**
 * Makes sure the desk at `root` has Desk's pre-commit hook. Returns `{ state, path?, chained?, reason?, remedy? }`:
 *   - "skipped": `root` is not the top of a git work tree (not a repository, or a folder inside another one), so there is nothing to guard;
 *   - "installed" / "updated" / "current": the hook was written, rewritten (an older Desk version, CRLF line endings) or already as it should be;
 *     `chained: true` when a pre-existing hook was moved to `pre-commit.desk-chained` (a stale chained hook is kept as a timestamped backup);
 *     "current" with `via: "legacy"` when the pre-commit framework holds Desk's hook as `pre-commit.legacy` and runs it;
 *   - "tracked": `core.hooksPath` points at files the repository tracks; nothing was changed, `remedy` says what to do by hand;
 *   - "failed": the hook could not be written, with the reason.
 * Never throws.
 */
export function installCardGuard(root, { spawnGit = spawnSync } = {}) {
  try {
    const top = git(spawnGit, root, ["rev-parse", "--show-toplevel"])
    if (top.status !== 0) return { state: "skipped", reason: "not a git repository" }
    if (real(top.stdout.trim()) !== real(root)) return { state: "skipped", reason: "the desk is not the top of its repository" }
    const hooksPath = git(spawnGit, root, ["rev-parse", "--git-path", "hooks"])
    if (hooksPath.status !== 0 || hooksPath.stdout.trim() === "") return { state: "failed", reason: "git did not say where its hooks live" }
    const dir = path.resolve(root, hooksPath.stdout.trim())
    const file = path.join(dir, "pre-commit")
    const wanted = hookScript()
    const tracked = git(spawnGit, root, ["ls-files", "--", dir])
    if (tracked.status === 0 && tracked.stdout.trim() !== "") {
      return {
        state: "tracked",
        path: file,
        reason: `core.hooksPath (${hooksPath.stdout.trim()}) holds tracked files, so Desk left it alone`,
        remedy: "to guard card commits here, add this to the tracked pre-commit hook: refuse a commit that adds or modifies <track>/<slug>/task.md unless Desk itself is committing (the hook text is hookScript() in plugins/desk/mcp/src/desk/card-commit-guard.js)",
      }
    }
    let state = "installed"
    let chained = false
    if (present(file)) {
      const current = readFileSync(file, "utf8")
      if (isDeskHook(current)) {
        if (current === wanted) {
          chmodSync(file, 0o755)
          return { state: "current", path: file }
        }
        state = "updated"
      } else {
        const legacy = path.join(dir, LEGACY_NAME)
        if (present(legacy) && isDeskHook(readFileSync(legacy, "utf8"))) return { state: "current", path: legacy, via: "legacy" }
        const chainedFile = path.join(dir, CHAINED_NAME)
        if (present(chainedFile)) renameSync(chainedFile, `${chainedFile}.bak-${stamp()}`)
        renameSync(file, chainedFile)
        chained = true
      }
    } else {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(file, wanted)
    chmodSync(file, 0o755)
    return chained ? { state, path: file, chained } : { state, path: file }
  } catch (error) {
    return { state: "failed", reason: error.message }
  }
}

/**
 * Removes Desk's pre-commit hook from the desk at `root`. A chained hook goes back to `pre-commit`. Returns `{ state, path? }` with state
 * "removed", "absent" (no Desk hook there) or "failed". Never throws.
 */
export function uninstallCardGuard(root, { spawnGit = spawnSync } = {}) {
  try {
    const hooksPath = git(spawnGit, root, ["rev-parse", "--git-path", "hooks"])
    if (hooksPath.status !== 0 || hooksPath.stdout.trim() === "") return { state: "absent", reason: "not a git repository" }
    const dir = path.resolve(root, hooksPath.stdout.trim())
    const file = path.join(dir, "pre-commit")
    if (!present(file) || !isDeskHook(readFileSync(file, "utf8"))) return { state: "absent", path: file }
    unlinkSync(file)
    const chainedFile = path.join(dir, CHAINED_NAME)
    if (present(chainedFile)) renameSync(chainedFile, file)
    return { state: "removed", path: file }
  } catch (error) {
    return { state: "failed", reason: error.message }
  }
}

const installed = new Set()

/**
 * `installCardGuard`, once per desk per process, for the places that run on every start (the index opening in `db/init.js`): the boot and the tidy
 * install it directly. Returns the result of the install, or null when this process already did it for `root`. A failed install is tried again next time.
 */
export function ensureCardGuard(root, options = {}) {
  if (installed.has(root)) return null
  const result = installCardGuard(root, options)
  if (result.state !== "failed") installed.add(root)
  return result
}
