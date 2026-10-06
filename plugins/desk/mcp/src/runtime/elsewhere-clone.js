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

// A command that names `clone`, `fetch` or `pull` and Git or gh anywhere (a chained command, `bash -c "..."`, a PowerShell statement). Two linear tests, so a command that is not one costs one pass each.
const NAMES_CLONE_OR_FETCH = /\b(?:clone|fetch|pull)\b/iu
const NAMES_GIT = /\b(?:git|gh)(?:\.exe)?\b/iu
// A repository URL as one whole word: https://host/owner/repo.git, ssh://git@host/owner/repo, git@host:owner/repo.git. (A pull request or file URL has more path and is no repository operand.)
const REPO_URL = /^(?:[a-z][\w+.-]*:\/\/|[\w.-]+@)[^\s'"/:]+(?::\d+)?[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu
const OWNER_REPO = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u
// Git options that take their value as the next word.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"])
const SHELLS = new Set(["bash", "sh", "zsh", "dash"])

// The simple commands of `text` as lists of words: split at `;`, `&`, `|`, `&&`, `||` and line breaks outside quotes, words split at blanks outside quotes, quotes dropped.
function simpleCommands(text) {
  const commands = []
  let words = []
  let word = ""
  let quote = null
  const endWord = () => { if (word !== "") words.push(word); word = "" }
  const endCommand = () => { endWord(); if (words.length > 0) commands.push(words); words = [] }
  for (const char of text) {
    if (quote !== null) { if (char === quote) quote = null; else word += char } else if (char === "'" || char === '"') quote = char
    else if (/\s/u.test(char) && char !== "\n") endWord()
    else if (char === ";" || char === "&" || char === "|" || char === "\n") endCommand()
    else word += char
  }
  endCommand()
  return commands
}

// The repositories one simple command clones, fetches or pulls by URL or `owner/repo`: the operands of `git [options] clone|fetch|pull ...` and `gh repo clone ...`, and, for `bash -c "..."`, of the commands inside.
function repositoriesOf(words, found) {
  const stripped = words.slice(words.findIndex((word) => !/^[\w]+=/u.test(word)))
  const [program, ...args] = stripped
  const name = String(program).split(/[\\/]/u).pop().replace(/\.exe$/iu, "")
  if (SHELLS.has(name)) {
    const script = args.indexOf("-c")
    if (script !== -1 && args[script + 1] !== undefined) for (const inner of simpleCommands(args[script + 1])) repositoriesOf(inner, found)
  } else if (name === "git") {
    let at = 0
    while (at < args.length && args[at].startsWith("-")) at += GIT_VALUE_OPTIONS.has(args[at]) ? 2 : 1
    if (["clone", "fetch", "pull"].includes(args[at]?.toLowerCase())) {
      for (const operand of args.slice(at + 1)) {
        const match = REPO_URL.exec(operand)
        if (match !== null) found.add(`${match[1]}/${match[2]}`.toLowerCase())
      }
    }
  } else if (name === "gh" && args[0] === "repo" && args[1]?.toLowerCase() === "clone") {
    const target = args.slice(2).find((operand) => !operand.startsWith("-"))
    const match = target === undefined ? null : OWNER_REPO.exec(target) ?? REPO_URL.exec(target)
    if (match !== null) found.add(`${match[1]}/${match[2]}`.toLowerCase())
  }
}

/** The `owner/repo` names (lower case) that `git clone`, `git fetch`, `git pull` or `gh repo clone` in `command` take as an operand; empty for any other command (a URL given to `gh pr view` or `curl` is no clone). */
export function clonedRepos(command) {
  if (!NAMES_CLONE_OR_FETCH.test(command) || !NAMES_GIT.test(command)) return []
  const found = new Set()
  for (const words of simpleCommands(command)) repositoriesOf(words, found)
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
 * `{ deny: true, reason }` when `command` clones or fetches a repository a task card marks as on another machine, else `{ deny: false }`. The reason leads with the action, then says the way out: record the operator's word in the card.
 * `load` supplies the desk's active tasks (`[{ slug, repos, next_step, blocker }]`); it is only called for a command that names a repository to clone or fetch.
 */
export async function elsewhereCloneDenial({ command, cwd, env, load = loadDeskTasks }) {
  const repos = clonedRepos(command)
  if (repos.length === 0) return { deny: false }
  const card = elsewhereCard(await load({ cwd, env }), repos)
  if (card === null) return { deny: false }
  return { deny: true, reason: `Ask the operator to push ${card.branch} from the other machine; do not clone or fetch to look for it. If the operator says it is pushed now, record that with task_update (rewrite the next step so it no longer says the work is on another machine), then retry. The card for task ${card.task.slug} says that work is not on this machine.` }
}

// The desk the session works in: the desk folder the command's own folder sits in (up to seven levels up), else the one the host binds (`resolveHookDeskRoot`: project folder, saved binding, $DESK, home fallbacks).
export async function loadDeskTasks({ cwd, env, ensureDependencies = defaultEnsureDependencies }) {
  // Task cards list their repositories in a nested `repos:` block that only gray-matter reads. A hook runs from the bare plugin folder, where no node_modules is installed, so (like boot) it restores the runtime pack
  // first. Without this the dependency-free reader returns no repos and the guard never matches a card (boot acceptance round AA: 4 of 4 `elsewhere-clone` runs cloned freely).
  // It must run before `active-tasks.js` is first imported, which picks its card reader once, at load.
  await ensureDependencies(env)
  const [{ resolveHookDeskRoot }, { activeTasks }, { isDeskWorkspace }] = await Promise.all([import("../../scripts/resolve-desk-root.js"), import("../desk/active-tasks.js"), import("../util/paths.js")])
  let root = null
  for (let dir = path.resolve(cwd), depth = 0; root === null && depth < 7; depth += 1, dir = path.dirname(dir)) {
    if (isDeskWorkspace(dir)) root = dir
  }
  root ??= resolveHookDeskRoot({ env, cwd }).root
  return root === null ? [] : activeTasks(root).tracks.flatMap((track) => track.tasks)
}

async function defaultEnsureDependencies(env) {
  const { ensureHookDependencies } = await import("./hook-dependencies.js")
  ensureHookDependencies({ hook: "elsewhere-clone", env })
}
