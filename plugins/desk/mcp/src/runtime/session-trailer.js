// Makes every agent commit traceable to its session. Desk's Copilot session start installs three git hooks in the repository the
// session works in (worktrees share the repository's hooks folder, so one install covers them all):
//   - `prepare-commit-msg` appends `Session: <id>` to the message, with `git interpret-trailers`, so a message that already has a
//     Session trailer is left alone, and so is a merge, a squash or a fixup/squash/amend! commit;
//   - `commit-msg` removes `Co-authored-by` lines that name an AI tool or a bot, but only in a repository that has
//     `.github/scripts/attribution.mjs` (one that rejects AI attribution), so no one needs a force-push to fix a commit;
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

const SESSION_MARKER = "# desk-session-trailer"
const HOOK_VERSION = 2
const CHAINED_SUFFIX = ".desk-chained"
const GIT_TIMEOUT_MS = 5000

// Shell built-ins only on the usual path: every program a hook starts costs a process, and a hook runs on every commit and push.
const SESSION_ID = `sid="\${COPILOT_AGENT_SESSION_ID:-\${AGENCY_SESSION_ID:-}}"
case "$sid" in *[![:graph:]]*) sid=$(printf '%s' "$sid" | tr -d '\\r\\n') ;; esac`

const chainTail = (name, withStdin) => `chained="\${0%/*}/${name}${CHAINED_SUFFIX}"
if [ -x "$chained" ] && ! grep -q '${SESSION_MARKER}' "$chained" 2>/dev/null; then
${withStdin ? `  printf '%s' "$input" | "$chained" "$@"` : `  "$chained" "$@"`}
  exit $?
fi
exit 0
`

const header = (name) => `#!/bin/sh
${SESSION_MARKER} ${name} v${HOOK_VERSION}
# Installed by Desk (and rewritten by it when it changes). A hook that was here before is kept as ${name}${CHAINED_SUFFIX} and runs after this one.
`

/** The `prepare-commit-msg` hook text. */
function prepareCommitMsgScript() {
  return `${header("prepare-commit-msg")}${SESSION_ID}
add_session() {
  [ -n "$sid" ] || return 0
  case "\${2:-}" in merge|squash) return 0 ;; esac
  read -r first < "$1" 2>/dev/null
  case "$first" in fixup!*|squash!*|amend!*) return 0 ;; esac
  git interpret-trailers --in-place --if-exists doNothing --trailer "Session: $sid" "$1" 2>/dev/null
  return 0
}
add_session "$@"
${chainTail("prepare-commit-msg", false)}`
}

// Runs the repository's own attribution checker (`findings`), so the hook removes exactly the Co-authored-by lines that checker rejects
// and keeps a person's. Written without single quotes: it sits inside a single-quoted shell word.
const STRIP_SCRIPT = [
  'import{readFileSync,writeFileSync}from"node:fs";import{resolve}from"node:path";import{pathToFileURL}from"node:url";',
  'const f=process.argv[1];',
  'const{findings}=await import(pathToFileURL(resolve(".github/scripts/attribution.mjs")).href);',
  'const text=readFileSync(f,"utf8");',
  'const drop=new Set(findings(text).filter(x=>x.reason.startsWith("Co-authored-by")).map(x=>x.line));',
  'if(drop.size)writeFileSync(f,text.split(/\\r?\\n/).filter((_,i)=>!drop.has(i+1)).join("\\n"));',
].join("")

/**
 * The `commit-msg` hook text. A foreign `commit-msg` hook runs first, and keeps its failure; then, in a repository with
 * `.github/scripts/attribution.mjs`, the final message loses the Co-authored-by lines that checker rejects. A failed check refuses the commit.
 */
function commitMsgScript() {
  return `${header("commit-msg")}chained="\${0%/*}/commit-msg${CHAINED_SUFFIX}"
if [ -x "$chained" ] && ! grep -q '${SESSION_MARKER}' "$chained" 2>/dev/null; then
  "$chained" "$@" || exit $?
fi
[ -f .github/scripts/attribution.mjs ] || exit 0
if ! node --input-type=module -e '${STRIP_SCRIPT}' "$1"; then
  echo "Desk commit-msg: could not check this commit message against .github/scripts/attribution.mjs (is node installed?), so the commit is refused. Remove any AI Co-authored-by line by hand." >&2
  exit 1
fi
exit 0
`
}

/** The `pre-push` hook text. */
function prePushScript() {
  return `${header("pre-push")}${SESSION_ID}
nl='
'
input=""
while IFS= read -r line || [ -n "$line" ]; do input="$input$line$nl"; done
warn_other_session() {
  [ -n "$sid" ] || return 0
  printf '%s' "$input" | while read -r _ _ remote_ref remote_sha; do
    case "$remote_sha" in ""|*[!0]*) ;; *) continue ;; esac
    [ -n "$remote_sha" ] || continue
    remote_branch=\${remote_ref#refs/heads/}
    case "$remote_branch" in main|master) continue ;; esac
    other=$(git log -1 --format='%(trailers:key=Session,valueonly,separator=%x2C)' "$remote_sha" 2>/dev/null)
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
      hooks: [installHook(dir, "prepare-commit-msg", prepareCommitMsgScript()), installHook(dir, "commit-msg", commitMsgScript()), installHook(dir, "pre-push", prePushScript())],
    }
  } catch (error) {
    return { state: "failed", reason: error.message }
  }
}
