// Makes every agent commit traceable to its session. Desk's Copilot session start installs two git hooks in the repository the
// session works in (worktrees share the repository's hooks folder, so one install covers them all):
//   - `prepare-commit-msg` appends `Session: <id>` to the message, with `git interpret-trailers`, so a message that already has a
//     Session trailer is left alone, and so is a merge, a squash or a fixup/squash/amend! commit;
//   - `pre-push` prints one warning when the branch tip on the remote carries a different session's trailer. It never refuses.
// The id is `COPILOT_AGENT_SESSION_ID`, else `AGENCY_SESSION_ID`. With neither set (a person committing) both hooks do nothing, so a
// hooks folder shared with a person's own commits is safe.
//
// Install rules match the card guard (desk/card-commit-guard.js): the folder is the one git resolves (`core.hooksPath` is respected),
// a hook that is not Desk's is kept as `<name>.desk-chained` and runs after Desk's, a tracked `core.hooksPath` is never modified, and
// installing again with the current text changes nothing. A `Session:` trailer matches none of the attribution checks (they look
// for `Co-authored-by`, `Generated with` and `...-by:` lines that name an AI tool or a bot).

import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"

export const SESSION_MARKER = "# desk-session-trailer"
const HOOK_VERSION = 1
const CHAINED_SUFFIX = ".desk-chained"
const GIT_TIMEOUT_MS = 5000

const SESSION_ID = `sid=$(printf '%s' "\${COPILOT_AGENT_SESSION_ID:-\${AGENCY_SESSION_ID:-}}" | tr -d '\\r\\n')`

const chainTail = (name, withStdin) => `chained="$(dirname "$0")/${name}${CHAINED_SUFFIX}"
if [ -x "$chained" ] && ! grep -q '${SESSION_MARKER}' "$chained" 2>/dev/null; then
${withStdin ? `  printf '%s\\n' "$input" | "$chained" "$@"` : `  "$chained" "$@"`}
  exit $?
fi
exit 0
`

const header = (name) => `#!/bin/sh
${SESSION_MARKER} ${name} v${HOOK_VERSION}
# Installed by Desk (and rewritten by it when it changes). A hook that was here before is kept as ${name}${CHAINED_SUFFIX} and runs after this one.
`

/** The `prepare-commit-msg` hook text. */
export function prepareCommitMsgScript() {
  return `${header("prepare-commit-msg")}${SESSION_ID}
add_session() {
  [ -n "$sid" ] || return 0
  case "\${2:-}" in merge|squash) return 0 ;; esac
  case "$(head -n 1 "$1" 2>/dev/null)" in fixup!*|squash!*|amend!*) return 0 ;; esac
  git interpret-trailers --parse "$1" 2>/dev/null | grep -qi '^Session:' && return 0
  git interpret-trailers --in-place --if-exists doNothing --trailer "Session: $sid" "$1" 2>/dev/null
  return 0
}
add_session "$@"
${chainTail("prepare-commit-msg", false)}`
}

/** The `pre-push` hook text. */
export function prePushScript() {
  return `${header("pre-push")}${SESSION_ID}
input=$(cat)
warn_other_session() {
  [ -n "$sid" ] || return 0
  printf '%s\\n' "$input" | while read -r _ _ remote_ref remote_sha; do
    case "$remote_sha" in ""|*[!0]*) ;; *) continue ;; esac
    [ -n "$remote_sha" ] || continue
    other=$(git log -1 --format='%(trailers:key=Session,valueonly,separator=%x2C)' "$remote_sha" 2>/dev/null | tr -d '\\r\\n')
    [ -n "$other" ] && [ "$other" != "$sid" ] || continue
    echo "Warning: the latest commit on $remote_ref was made by session $other, and this is session $sid. Another session may be working on that branch; check before pushing more commits there." >&2
  done
  return 0
}
warn_other_session
${chainTail("pre-push", true)}`
}

const git = (spawnGit, cwd, args) => spawnGit("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true })

function installHook(dir, name, wanted) {
  const file = path.join(dir, name)
  let chained = false
  let state = "installed"
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8")
    if (current.includes(SESSION_MARKER)) {
      if (current === wanted) {
        chmodSync(file, 0o755)
        return { name, state: "current" }
      }
      state = "updated"
    } else {
      const chainedFile = `${file}${CHAINED_SUFFIX}`
      if (existsSync(chainedFile)) renameSync(chainedFile, `${chainedFile}.bak-${new Date().toISOString().replace(/\D/gu, "").slice(0, 14)}`)
      renameSync(file, chainedFile)
      chained = true
    }
  } else {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(file, wanted)
  chmodSync(file, 0o755)
  return chained ? { name, state, chained } : { name, state }
}

/**
 * Installs the session-trailer hooks for the repository containing `folder`. Returns `{ state, hooks?, reason? }`: "skipped" (not a git
 * repository), "tracked" (`core.hooksPath` holds tracked files, so nothing was changed), "failed" (with the reason) or "ok" with the
 * per-hook result (`installed`, `updated`, `current`). Never throws.
 */
export function installSessionTrailerHooks(folder, { spawnGit = spawnSync } = {}) {
  try {
    const hooksPath = git(spawnGit, folder, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
    if (hooksPath.status !== 0 || hooksPath.stdout.trim() === "") return { state: "skipped", reason: "not a git repository" }
    const dir = hooksPath.stdout.trim()
    const tracked = git(spawnGit, folder, ["ls-files", "--", dir])
    if (tracked.status === 0 && tracked.stdout.trim() !== "") return { state: "tracked", reason: `core.hooksPath (${dir}) holds tracked files, so Desk left it alone` }
    return {
      state: "ok",
      hooks: [installHook(dir, "prepare-commit-msg", prepareCommitMsgScript()), installHook(dir, "pre-push", prePushScript())],
    }
  } catch (error) {
    return { state: "failed", reason: error.message }
  }
}
