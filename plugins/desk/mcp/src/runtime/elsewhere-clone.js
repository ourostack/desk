// The clone guard: denies a `git clone` or `git fetch` (or `gh repo clone`) of a repository that a task card in the desk marks as living on another machine.
//
// Why (boot acceptance rounds W and X, wrong-push-account): boot already tells the agent "not here: do not clone or fetch to look for it", and Copilot agents still ran
// `cd ~/code && git clone https://github.com/anthropics/claude-code.git` to look for a branch the card says is only on the other laptop. A note is advice; this is the stop.
//
// It reuses boot's own detection (`saysElsewhere`, elsewhere-note.js) over the desk's active task cards (`activeTasks`), so the guard and the note can never disagree about
// which task is "not here". A card marks a repo as elsewhere when its next step or blocker says so AND the repo is one the card names: in its `repos` list, or in that next
// step or blocker. A clone of anything else, and every command that is not a clone or fetch naming a repository URL, passes.
//
// Cost. Most commands are not git clones, so the first test is one regular expression over the command text, and nothing else is loaded or read for them. Only a command that
// names `clone` or `fetch` together with a repository reads the desk's cards (bounded reads of at most 64 KiB each, the same listing `desk_status` serves).

import * as path from "node:path"
import { saysElsewhere } from "./elsewhere-note.js"

// A command that names `clone` or `fetch` and Git or gh anywhere (a chained command, `bash -c "..."`, a PowerShell statement). Two linear tests, so a long command costs no more than one pass each.
const NAMES_CLONE_OR_FETCH = /\b(?:clone|fetch)\b/iu
const NAMES_GIT = /\b(?:git|gh)(?:\.exe)?\b/iu
// A repository URL (https://host/owner/repo.git, ssh://git@host/owner/repo, git@host:owner/repo.git) and a bare `owner/repo` after `gh repo clone`.
const REPO_URL = /(?:[a-z][\w+.-]*:\/\/|[\w.-]+@)[^\s'"]*?[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s'"/;&|)]|$)/giu
const GH_CLONE_TARGET = /\bgh(?:\.exe)?\s+repo\s+clone\s+['"]?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s'"]|$)/iu

/** The `owner/repo` names (lower case) a command's clone or fetch points at; empty for a command that is not a clone or fetch of a named repository. */
export function clonedRepos(command) {
  if (!NAMES_CLONE_OR_FETCH.test(command) || !NAMES_GIT.test(command)) return []
  const found = new Set()
  for (const match of command.matchAll(REPO_URL)) found.add(`${match[1]}/${match[2]}`.toLowerCase())
  const target = GH_CLONE_TARGET.exec(command)
  if (target !== null) found.add(`${target[1]}/${target[2]}`.toLowerCase())
  return [...found]
}

// The branch a card's next step says to push: "push `relay-heartbeat-15s` and open a pull request" -> "relay-heartbeat-15s"; "the branch" when it names none or one longer than 30 characters.
function branchOf(text) {
  const named = /\bpush(?:ing)?\s+(?:the\s+)?(?:branch\s+)?`([^`\s]{1,30})`/iu.exec(text ?? "")
  return named === null ? "the branch" : named[1]
}

/** The card, if any, that marks one of `repos` as on another machine: `{ task, branch }`, or null. */
function elsewhereCard(tasks, repos) {
  for (const task of tasks) {
    if (!saysElsewhere(task)) continue
    const text = `${task.next_step ?? ""} ${task.blocker ?? ""}`.toLowerCase()
    const names = new Set(task.repos.map((repo) => String(repo.name ?? "").toLowerCase()))
    if (repos.some((repo) => names.has(repo) || names.has(repo.split("/")[1]) || text.includes(repo))) return { task, branch: branchOf(task.next_step) }
  }
  return null
}

/**
 * `{ deny: true, reason }` when `command` clones or fetches a repository a task card marks as on another machine, else `{ deny: false }`. The reason leads with the action.
 * `load` supplies the desk's active tasks (`[{ slug, repos, next_step, blocker }]`); it is only called for a command that names a repository to clone or fetch.
 */
export async function elsewhereCloneDenial({ command, cwd, env, load = loadDeskTasks }) {
  const repos = clonedRepos(command)
  if (repos.length === 0) return { deny: false }
  const card = elsewhereCard(await load({ cwd, env }), repos)
  if (card === null) return { deny: false }
  return { deny: true, reason: `Ask the operator to push ${card.branch} from the other machine; do not clone or fetch to look for it. The card for task ${card.task.slug} says that work is not on this machine.` }
}

// The desk the session works in: the desk folder the command's own folder sits in (up to seven levels up), else the one the host binds (`resolveHookDeskRoot`: project folder, saved binding, $DESK, home fallbacks).
async function loadDeskTasks({ cwd, env }) {
  const [{ resolveHookDeskRoot }, { activeTasks }, { isDeskWorkspace }] = await Promise.all([import("../../scripts/resolve-desk-root.js"), import("../desk/active-tasks.js"), import("../util/paths.js")])
  let root = null
  for (let dir = path.resolve(cwd), depth = 0; root === null && depth < 7; depth += 1, dir = path.dirname(dir)) {
    if (isDeskWorkspace(dir)) root = dir
  }
  root ??= resolveHookDeskRoot({ env, cwd }).root
  return root === null ? [] : activeTasks(root).tracks.flatMap((track) => track.tasks)
}
