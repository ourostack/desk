// Which other sessions are working on this machine, in the repo this session starts in. Several Copilot app sessions often run at
// once, in sibling worktrees of one repo and sometimes in its shared main checkout, and an agent that does not know that stashes
// a neighbour's work, resets a checkout or removes a worktree that is not its own. Boot prints what it can see in a few lines, and
// the few rules that follow from it, only when there is someone else to be careful about.
//
// Everything comes from the machine: `git worktree list`, the time of each worktree's last git activity, and (where `ps` and `lsof`
// exist) the running `agency copilot` and `copilot` processes whose working directory is in the repo. A step that is missing or
// slow is skipped, so the lines say less and never fail or hold boot past `BUDGET_MS`.

import { execFile } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

const BUDGET_MS = 2500
const SHOWN = 6
const QUIET_MS = 24 * 60 * 60 * 1000
const MAX_CANDIDATES = 40
// An `agency copilot ...` process is one session; a bare `copilot` or `copilot-runtime` is one too, unless it is a helper of one (an extension or a child of an `agency copilot`).
const SESSION_COMMAND = /(?:^|[\\/])(?:agency(?:\.exe)?\s+copilot|copilot(?:-runtime)?(?:\.exe)?)(?:\s|$)/u

const here = (dir, home) => (home !== "" && (dir === home || dir.startsWith(home + path.sep)) ? `~${dir.slice(home.length)}` : dir)

/** The worktrees `git worktree list --porcelain` prints, main checkout first: `{ dir, branch, bare }`. */
export function parseWorktrees(porcelain) {
  const trees = []
  for (const block of String(porcelain).split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u)
    const dir = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    if (dir === undefined || dir === "") continue
    if (lines.some((line) => line === "prunable" || line.startsWith("prunable "))) continue
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//u, "")
    trees.push({ dir: path.resolve(dir), branch: branch ?? (lines.includes("detached") ? "detached HEAD" : "no branch"), bare: lines.includes("bare") })
  }
  return trees
}

/** `ps -axo pid=,ppid=,etime=,command=` rows as `{ pid, ppid, up, command }`. */
export function parseProcesses(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const [, pid, ppid, days = "0", hours = "0", minutes, seconds, command] = match
    rows.push({ pid: Number(pid), ppid: Number(ppid), up: (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000, command })
  }
  return rows
}

/** The sessions among `rows`: one per `agency copilot` or `copilot` process that is not a helper of another, and none of the `hostPid`'s own ancestors (this session). */
export function sessionProcesses(rows, { hostPid = null } = {}) {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const own = new Set()
  for (let pid = hostPid; pid !== null && byPid.has(pid) && !own.has(pid); pid = byPid.get(pid).ppid) own.add(pid)
  const sessions = rows.filter((row) => SESSION_COMMAND.test(row.command) && !/\bextension_bootstrap\b/u.test(row.command) && !own.has(row.pid))
  const kept = new Set(sessions.map((row) => row.pid))
  return sessions.filter((row) => !kept.has(row.ppid)).slice(0, MAX_CANDIDATES)
}

function gitDirOf(dir) {
  try {
    const dotGit = path.join(dir, ".git")
    if (statSync(dotGit).isDirectory()) return dotGit
    const pointer = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"))
    return pointer === null ? null : path.resolve(dir, pointer[1].trim())
  } catch {
    return null
  }
}

/** When something last happened in the worktree's git (a commit, checkout or staged change), in ms since the epoch, or null. */
function lastGitActivity(dir) {
  const gitDir = gitDirOf(dir)
  if (gitDir === null) return null
  let latest = null
  for (const name of ["index", "HEAD", path.join("logs", "HEAD")]) {
    try {
      const at = statSync(path.join(gitDir, name)).mtimeMs
      if (latest === null || at > latest) latest = at
    } catch {
      // Not every file exists in every state.
    }
  }
  return latest
}

function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return "just now"
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

function upFor(ms) {
  const minutes = Math.round(ms / 60000)
  return minutes < 90 ? `${Math.max(minutes, 1)} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`
}

/** The lines for the agent: what is where, then the rules. `trees` carry `dir`, `branch`, `activity` (ms or null) and `sessions` (how many other sessions run there). */
export function describe({ trees, current, home, now }) {
  const rules = "Rules while others work here: never stash, reset, clean or switch branches in a shared checkout; never touch, move or remove another session's worktree; branch from origin/main in your own worktree (`git worktree add <dir> -b <branch> origin/main`), and remove only what you created."
  const line = (tree, index) => {
    const parts = []
    if (index === 0) parts.push("the shared main checkout")
    parts.push(tree.branch)
    const where = `- ${here(tree.dir, home)} (${parts.join(", ")})`
    if (tree.dir === current) return `${where}: you are here${tree.sessions > 0 ? `; ${tree.sessions} other session${tree.sessions === 1 ? "" : "s"} run${tree.sessions === 1 ? "s" : ""} here too` : ""}`
    const facts = []
    if (tree.sessions > 0) facts.push(`${tree.sessions} session${tree.sessions === 1 ? "" : "s"} running${tree.upMs === null ? "" : ` (up ${upFor(tree.upMs)})`}`)
    if (tree.activity !== null) facts.push(`last git activity ${ago(now - tree.activity)}`)
    return facts.length === 0 ? where : `${where}: ${facts.join("; ")}`
  }
  const lively = (tree) => tree.dir === current || tree.sessions > 0 || (tree.activity !== null && now - tree.activity < QUIET_MS)
  // This session's own worktree first, then the ones with a running session, then the most recently touched.
  const rank = (tree) => (tree.dir === current ? 0 : tree.sessions > 0 ? 1 : 2)
  const shownTrees = trees.filter(lively).sort((a, b) => rank(a) - rank(b) || (b.activity ?? 0) - (a.activity ?? 0))
  const quiet = trees.length - shownTrees.length
  const listed = shownTrees.slice(0, SHOWN)
  const more = shownTrees.length - listed.length + quiet
  const sessions = trees.reduce((total, tree) => total + tree.sessions, 0)
  const head = `Other work on this machine in this repo: ${trees.length} worktree${trees.length === 1 ? "" : "s"}, ${sessions} other running session${sessions === 1 ? "" : "s"}.`
  return [head, ...listed.map((tree) => line(tree, trees.indexOf(tree))), ...(more > 0 ? [`- and ${more} more worktree${more === 1 ? "" : "s"}, quiet for a day or more or past this list; \`git worktree list\` shows them`] : []), rules]
}

async function sessionsByWorktree({ trees, current, env, platform, exec }) {
  const counts = new Map(trees.map((tree) => [tree.dir, { sessions: 0, upMs: null }]))
  if (platform === "win32") return counts
  const listed = await exec("ps", ["-axo", "pid=,ppid=,etime=,command="])
  const hostPid = Number.parseInt(env.DESK_SESSION_HOST_PID ?? "", 10)
  const ownKnown = Number.isInteger(hostPid)
  const candidates = sessionProcesses(parseProcesses(listed), { hostPid: ownKnown ? hostPid : null })
  if (candidates.length === 0) return counts
  const cwds = await exec("lsof", ["-a", "-p", candidates.map((row) => row.pid).join(","), "-d", "cwd", "-Fpn"])
  const cwdOf = new Map()
  let pid = null
  for (const line of cwds.split(/\r?\n/u)) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== null) cwdOf.set(pid, path.resolve(line.slice(1)))
  }
  // A nested worktree belongs to the deepest tree that holds the folder.
  const byDepth = [...trees].sort((a, b) => b.dir.length - a.dir.length)
  for (const row of candidates) {
    const cwd = cwdOf.get(row.pid)
    const tree = cwd === undefined ? undefined : byDepth.find((candidate) => cwd === candidate.dir || cwd.startsWith(candidate.dir + path.sep))
    if (tree === undefined) continue
    const entry = counts.get(tree.dir)
    entry.sessions += 1
    entry.upMs = entry.upMs === null ? row.up : Math.max(entry.upMs, row.up)
  }
  // Without the host's pid this session is one of the processes in its own folder; it is not "other".
  const mine = counts.get(current)
  if (!ownKnown && mine !== undefined && mine.sessions > 0) mine.sessions -= 1
  return counts
}

/**
 * `{ lines, worktrees, sessions }` for boot, or null when there is nobody else (one worktree and no other running session), no
 * repo, or nothing could be read in `budgetMs`. Never rejects.
 */
export async function otherSessions({ cwd = process.cwd(), env = process.env, now = Date.now, platform = process.platform, home = env.HOME || os.homedir(), budgetMs = BUDGET_MS, exec } = {}) {
  let timer
  const hard = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs) })
  const work = (async () => {
    const call = exec ?? (async (file, args, options = {}) => (await run(file, args, { cwd, timeout: budgetMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options })).stdout)
    const trees = parseWorktrees(await call("git", ["worktree", "list", "--porcelain"])).filter((tree) => !tree.bare)
    const top = path.resolve((await call("git", ["rev-parse", "--show-toplevel"])).trim())
    let counts = new Map(trees.map((tree) => [tree.dir, { sessions: 0, upMs: null }]))
    try {
      counts = await sessionsByWorktree({ trees, current: top, env, platform, exec: (file, args) => call(file, args) })
    } catch {
      // No ps or lsof here: worktrees alone still say who else may be about.
    }
    const full = trees.map((tree) => ({ ...tree, activity: lastGitActivity(tree.dir), ...counts.get(tree.dir) }))
    const others = full.filter((tree) => tree.dir !== top).length
    const sessions = full.reduce((total, tree) => total + tree.sessions, 0)
    if (others === 0 && sessions === 0) return null
    return { lines: describe({ trees: full, current: top, home, now: now() }), worktrees: full.length, sessions }
  })().catch(() => null)
  try {
    return await Promise.race([work, hard])
  } finally {
    clearTimeout(timer)
  }
}
