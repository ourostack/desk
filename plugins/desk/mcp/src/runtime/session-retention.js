// Session retention keeps the disk used by agent sessions, their worktrees and logs bounded. It is opt-in: nothing in Desk runs it;
// an operator schedules the CLI (scripts/session-retention.js). A dry run is the default and `--apply` deletes. See docs/session-retention.md.
//
// It reads directory entries and stats only removal candidates, never walks inside a regenerable tree, measures what it freed from
// free-space readings, and deletes by moving a folder aside and removing it in rate-limited pieces: a per-file walk of a busy machine's
// agent storage can saturate its disk for hours.
import { execFile } from "node:child_process"
import { promises as fsp } from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveStateHome } from "../util/paths.js"

const DAY = 86_400_000
const GB = 1_073_741_824
const MB = 1_048_576
const BUILD_DIRS = new Set(["node_modules", "dist", "target", ".vite", ".next", ".turbo", ".parcel-cache", ".svelte-kit", "DerivedData", ".build"])
const MEDIA = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"])
const TRACE = new Set([".trace", ".cpuprofile", ".heapsnapshot", ".heapprofile", ".har"])
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"])
// A session's history and plan stay, whatever its state.
const SESSION_KEEP_TOP = new Set(["events.jsonl", "checkpoints", "workspace.yaml", "session.db", "plan.md", "research", ".workspace-fork.lock"])
const SMALL_TEXT = /\.(?:md|txt|json|ya?ml|jsonl|csv|log)$/iu
const GIT_BUSY = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]
const SKIPPABLE = new Set(["logs", "sessions", "worktrees", "state"])
// A workspace session's archive state lives on its workspace; sessions.archived_at covers only sessions without one.
const QUERIES = {
  protectedIds: `select session_id as v from workspaces where archived_at is null and session_id is not null
    union select a.session_id from workspace_session_aliases a join workspaces w on w.id = a.workspace_id where w.archived_at is null
    union select s.id from sessions s where s.is_running = 1 or (s.archived_at is null
      and not exists (select 1 from workspaces w where w.session_id = s.id)
      and not exists (select 1 from workspace_session_aliases a where a.session_id = s.id))`,
  protectedPaths: `select t.path as v from workspaces w join worktrees t on t.id = w.worktree_id where w.archived_at is null
    union select source_path from workspaces where archived_at is null and source_path is not null`,
  openPr: `select session_id as v from workspaces where created_pr_state = 'open' and session_id is not null
    union select a.session_id from workspace_session_aliases a join workspaces w on w.id = a.workspace_id where w.created_pr_state = 'open'`,
  archivedIds: `select id as v from sessions where archived_at is not null
    union select session_id from workspaces where archived_at is not null and session_id is not null
    union select a.session_id from workspace_session_aliases a join workspaces w on w.id = a.workspace_id where w.archived_at is not null`,
  knownWorktrees: "select path as v from worktrees",
}

const BOOLEAN_FLAGS = { "--apply": "apply", "--ceiling": "ceiling", "--json": "json", "--sizes": "sizes", "--verbose": "verbose" }
const PATH_FLAGS = { "--app-db": "appDb", "--report-dir": "reportDir", "--session-state": "sessionState", "--trash": "trash" }
const LIST_FLAGS = { "--code-roots": "codeRoots", "--log-dirs": "logDirs", "--state-roots": "stateRoots" }
const NUMBER_FLAGS = {
  "--artifact-days": "artifactDays", "--ceiling-gb": "ceilingGB", "--gb-per-min": "gbPerMin", "--git-pause-ms": "gitPauseMs",
  "--load-limit": "loadLimit", "--log-days": "logDays", "--recent-hours": "recentHours", "--scan-depth": "scanDepth", "--worktree-depth": "worktreeDepth",
}

export const USAGE = `usage: node session-retention.js [--apply] [--ceiling] [options]

Keeps agent session storage bounded. A dry run by default: it lists what it would remove and writes a report. --apply deletes.
Run it at low priority, for example: nice -n 19 node session-retention.js --apply --ceiling

  --apply                 delete what the dry run lists
  --ceiling               after the main pass, prune the oldest inactive sessions until agent storage is under --ceiling-gb
  --ceiling-gb <n>        storage ceiling in GB (60)
  --session-state <dir>   Copilot session folders (<COPILOT_HOME>/session-state)
  --app-db <file>         Copilot app database, read only (<COPILOT_HOME>/data.db)
  --code-roots <dirs>     folders holding session worktrees (default: the parents of the worktrees the app database knows)
  --log-dirs <dirs>       log folders pruned by age (<COPILOT_HOME>/logs)
  --state-roots <dirs>    other agent state folders: only old node_modules and unused browser profiles go (none)
  --log-days <n>          log age to remove (7)
  --artifact-days <n>     age of screenshots, build folders and browser profiles to remove (3)
  --recent-hours <n>      a session written within this many hours counts as active (24)
  --worktree-depth <n>    how deep to look for worktrees under each code root (3)
  --scan-depth <n>        how deep to look inside a session folder (7)
  --load-limit <n>        load average above which the scan and deletion slow down (12)
  --gb-per-min <n>        most GB deleted per minute (3)
  --git-pause-ms <n>      pause before checking each worktree with Git (1000)
  --skip <list>           comma-separated parts to skip: logs, sessions, worktrees, state
  --trash <dir>           where folders wait to be deleted, on the same volume (<state>/desk/session-retention/trash)
  --report-dir <dir>      where the JSON report goes (<state>/desk/session-retention)
  --sizes                 measure each listed folder with du (slower)
  --json                  print the report as JSON
  --verbose               list every checkout left in place and why

Folder lists are separated by "${path.delimiter}".`

/** Options with their defaults, then the flags in `argv` applied. Returns `{ options }`, `{ help: true }` or `{ error }`. */
export function parseRetentionArgs(argv, { env = process.env, homeDir = os.homedir() } = {}) {
  const home = env.HOME || homeDir
  const copilot = env.COPILOT_HOME || path.join(home, ".copilot")
  const state = path.join(resolveStateHome({ ...env, HOME: home }), "desk", "session-retention")
  const options = {
    apply: false, ceiling: false, json: false, sizes: false, verbose: false,
    sessionState: path.join(copilot, "session-state"),
    appDb: path.join(copilot, "data.db"),
    codeRoots: null,
    logDirs: [path.join(copilot, "logs")],
    stateRoots: [],
    logDays: 7, artifactDays: 3, recentHours: 24, ceilingGB: 60, loadLimit: 12,
    worktreeDepth: 3, scanDepth: 7, gbPerMin: 3, gitPauseMs: 1000,
    trash: path.join(state, "trash"),
    reportDir: state,
    skip: new Set(),
    home,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--help" || flag === "-h") return { help: true }
    if (BOOLEAN_FLAGS[flag]) { options[BOOLEAN_FLAGS[flag]] = true; continue }
    const value = argv[++i]
    if (value === undefined) return { code: "retention_flag_needs_value", error: `Pass a value: ${flag} needs a value` }
    if (PATH_FLAGS[flag]) options[PATH_FLAGS[flag]] = path.resolve(value)
    else if (LIST_FLAGS[flag]) options[LIST_FLAGS[flag]] = value.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p))
    else if (NUMBER_FLAGS[flag]) {
      const n = Number(value)
      if (value.trim() === "" || !Number.isFinite(n) || n < 0) return { code: "retention_flag_needs_number", error: `Pass a number of zero or more: ${flag} needs a number of zero or more, not ${value}` }
      options[NUMBER_FLAGS[flag]] = n
    } else if (flag === "--skip") {
      const parts = value.split(",").filter(Boolean)
      const unknown = parts.filter((p) => !SKIPPABLE.has(p))
      if (unknown.length) return { code: "retention_skip_unknown_name", error: `Pass only the listed names to --skip: --skip takes ${[...SKIPPABLE].join(", ")}, not ${unknown.join(", ")}` }
      options.skip = new Set(parts)
    } else return { code: "retention_unknown_option", error: `Remove the unknown option: unknown option ${flag}` }
  }
  return { options }
}

const DEFAULT_DEPS = {
  now: () => Date.now(),
  loadavg: () => os.loadavg(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  kill: (pid, signal) => process.kill(pid, signal),
  freeBytes: async (dir) => {
    const s = await fsp.statfs(dir)
    return s.bavail * s.bsize
  },
  // null when the size cannot be measured (no du, as on Windows); the ceiling then reports itself unmeasured.
  diskUsage: async (target) => {
    const r = await runCommand("du", ["-sk", target], { timeout: 1_800_000 })
    return r.ok ? Number(r.stdout.split("\t")[0]) * 1024 : null
  },
  openAppDb: async (file) => {
    const { default: Database } = await import("better-sqlite3")
    const db = new Database(file, { readonly: true, fileMustExist: true })
    return { all: (sql) => db.prepare(sql).all(), close: () => db.close() }
  },
  run: (cmd, argv, options) => runCommand(cmd, argv, options),
  rm: (target) => fsp.rm(target, { recursive: true, force: true }),
  rename: (from, to) => fsp.rename(from, to),
  // Load from other processes can stay high for hours, so pacing slows the job down but never stalls it.
  paceEvery: 200,
  deleteBatch: 1024,
}

function runCommand(cmd, argv, { cwd, timeout = 120_000 } = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
  return new Promise((resolve) => {
    execFile(cmd, argv, { cwd, timeout, env, windowsHide: true, maxBuffer: 64 * MB }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }))
  })
}

async function lstat(p) {
  try {
    return await fsp.lstat(p)
  } catch {
    return null
  }
}

async function readdir(p) {
  try {
    return await fsp.readdir(p, { withFileTypes: true })
  } catch {
    return []
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

// Allocated size; a file system that reports no blocks (or a sparse file) falls back to the length.
const diskBytes = (st) => st.blocks * 512 || st.size
const gb = (bytes) => `${(bytes / GB).toFixed(2)} GB`
const keepTop = (name) => SESSION_KEEP_TOP.has(name) || name.startsWith("inuse.")

/** Runs one retention pass with `options` from parseRetentionArgs; `overrides` replace its clock, processes and file operations in tests. */
export async function runRetention(options, overrides = {}) {
  const o = options
  const d = { ...DEFAULT_DEPS, ...overrides }
  const t0 = d.now()
  const plan = []
  const planned = new Set()
  const skipped = []
  const undeletable = []
  const stats = { sessions: { active: 0, inactive: 0 }, worktrees: { protected: 0, candidates: 0 } }
  const remoteShaCache = new Map()
  let paceBudget = 0
  let batch = 0
  let windowStart = 0
  let windowFree = 0

  const git = (dir, argv, opts) => d.run("git", ["-c", "core.fsmonitor=false", "-C", dir, ...argv], opts)
  // A file that vanished since its folder was read (st is null) never counts as old.
  const old = (st, days) => t0 - st?.mtimeMs > days * DAY

  async function pace() {
    if (++paceBudget < d.paceEvery) return
    paceBudget = 0
    if (d.loadavg()[0] > o.loadLimit) await d.sleep(1500)
  }

  function underPlanned(p) {
    for (let q = p; q !== path.dirname(q); q = path.dirname(q)) if (planned.has(q)) return true
    return false
  }

  async function add(category, p, extra = {}) {
    if (underPlanned(p)) return
    planned.add(p)
    const bytes = extra.bytes ?? (o.sizes ? (await d.diskUsage(p)) || 0 : 0)
    plan.push({ category, path: p, ...extra, bytes })
  }

  // ---------- what is active ----------
  async function loadActive() {
    let db
    try {
      db = await d.openAppDb(o.appDb)
      const read = (sql) => new Set(db.all(sql).map((row) => row.v))
      return Object.fromEntries(Object.entries(QUERIES).map(([key, sql]) => [key, read(sql)]))
    } catch (error) {
      throw Object.assign(new Error(`Check the app database path: cannot read the app database at ${o.appDb} (${error.message}); sessions and worktrees left untouched`), { code: "session_retention_check_the_app_database_path" })
    } finally {
      db?.close()
    }
  }

  function pidAlive(pid) {
    try {
      d.kill(pid, 0)
      return true
    } catch (error) {
      return error.code === "EPERM"
    }
  }

  async function workspacePaths(dir) {
    let text = ""
    try {
      text = await fsp.readFile(path.join(dir, "workspace.yaml"), "utf8")
    } catch {
      return []
    }
    return ["cwd", "git_root"]
      .map((key) => text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "mu")))
      .filter(Boolean)
      .map((m) => m[1].trim().replace(/^["']|["']$/gu, ""))
  }

  async function sessionActivity(dir) {
    let newest = 0
    let live = false
    for (const e of await readdir(dir)) {
      const lock = e.name.match(/^inuse\.(\d+)\.lock$/u)
      if (lock && pidAlive(Number(lock[1]))) live = true
      const st = e.isFile() && await lstat(path.join(dir, e.name))
      if (st) newest = Math.max(newest, st.mtimeMs)
    }
    return { live, newest }
  }

  // ---------- git safety ----------
  async function remoteShas(dir, commonDir) {
    if (remoteShaCache.has(commonDir)) return remoteShaCache.get(commonDir)
    const shas = new Set()
    for (const remote of (await git(dir, ["remote"])).stdout.split("\n").filter(Boolean)) {
      const res = await git(dir, ["ls-remote", remote], { timeout: 60_000 })
      for (const line of (res.ok ? res.stdout : "").split("\n").filter(Boolean)) shas.add(line.split("\t")[0])
    }
    remoteShaCache.set(commonDir, shas)
    return shas
  }

  // Safe means nothing is lost by removing the checkout: clean, idle, and every tip is on a remote (or is a SHA a remote advertises,
  // which covers a squash-merged pull request's head).
  async function gitSafety(dir, linked) {
    const top = await git(dir, ["rev-parse", "--absolute-git-dir", "--git-common-dir"])
    if (!top.ok) return { reason: "git metadata unreadable (broken or orphaned checkout)" }
    const [gitDir, commonRaw] = top.stdout.trim().split("\n")
    const commonDir = path.resolve(dir, commonRaw)
    for (const marker of GIT_BUSY) if (await lstat(path.join(gitDir, marker))) return { reason: `git operation in progress (${marker})` }
    if (linked && await lstat(path.join(gitDir, "locked"))) return { reason: "worktree is locked" }
    const st = await git(dir, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"], { timeout: 300_000 })
    if (!st.ok) return { reason: "git status failed" }
    if (st.stdout.trim()) return { reason: `uncommitted changes (${st.stdout.trim().split("\n").length} paths)` }
    if (!(await git(dir, ["remote"])).stdout.trim()) return { reason: "no git remote" }
    const tips = [["HEAD", (await git(dir, ["rev-parse", "HEAD"])).stdout.trim()]]
    if (!linked) {
      const branches = await git(dir, ["for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/heads"])
      tips.push(...branches.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")))
      if ((await git(dir, ["stash", "list"])).stdout.trim()) return { reason: "has git stash entries" }
    }
    for (const [name, sha] of tips) {
      const unpushed = await git(dir, ["rev-list", "--max-count=1", sha, "--not", "--remotes"])
      if (!unpushed.ok) return { reason: `cannot compare ${name} with remotes` }
      if (!unpushed.stdout.trim() || (await remoteShas(dir, commonDir)).has(sha)) continue
      const count = (await git(dir, ["rev-list", "--count", sha, "--not", "--remotes"])).stdout.trim()
      return { reason: `unpushed commits on ${name} (${count} not on any remote)` }
    }
    return { safe: true, commonDir }
  }

  // ---------- scanners ----------
  const isChromiumProfile = (entries) => entries.some((e) => e.name === "Local State" && e.isFile())

  async function scanTree(dir, ctx, depth = 0) {
    await pace()
    const entries = await readdir(dir)
    if (depth > 0 && ctx.mode !== "state" && entries.some((e) => e.name === ".git") && dir !== ctx.gitRoot) return handleCheckout(dir, entries, ctx, depth)
    if (depth > 0 && ctx.mode === "inactive" && isChromiumProfile(entries)) return add("browser-profiles", dir)
    if (depth > 0 && ctx.mode === "state" && isChromiumProfile(entries)) {
      // A running browser keeps a SingletonLock symlink in its profile.
      const st = await lstat(dir)
      if (!entries.some((e) => e.name === "SingletonLock") && old(st, o.artifactDays)) await add("state-browser-profiles", dir)
      return
    }
    if (depth >= ctx.maxDepth) return
    for (const e of entries) {
      const fp = path.join(dir, e.name)
      if (e.isSymbolicLink() || (depth === 0 && ctx.session && keepTop(e.name))) continue
      if (e.isDirectory()) await scanDir(fp, e.name, ctx, depth)
      else if (e.isFile() && ctx.mode === "inactive") await scanFile(fp, e.name, ctx)
    }
  }

  async function scanDir(fp, name, ctx, depth) {
    if (name === ".git") return
    if (!BUILD_DIRS.has(name) || (ctx.mode === "state" && name !== "node_modules")) return scanTree(fp, ctx, depth + 1)
    if (ctx.mode !== "inactive" && !old(await lstat(fp), o.artifactDays)) return
    // Only ignored build output goes from a checkout: a tracked dist/ is source.
    if (ctx.gitRoot && name !== "node_modules" && !(await git(ctx.gitRoot, ["check-ignore", "-q", fp])).ok) return
    await add("build-output", fp)
  }

  async function scanFile(fp, name, ctx) {
    const ext = path.extname(name).toLowerCase()
    if (MEDIA.has(ext)) return add("videos", fp)
    if (TRACE.has(ext) || (ext === ".zip" && /trace/iu.test(name))) return add("traces", fp)
    if (ext === ".json" && /trace|profile/iu.test(name)) {
      const st = await lstat(fp)
      if (st?.size > 10 * MB) await add("traces", fp, { bytes: diskBytes(st) })
      return
    }
    if (!IMAGE.has(ext) || ctx.keepImages) return
    const st = await lstat(fp)
    if (old(st, o.artifactDays)) await add("screenshots", fp, { bytes: diskBytes(st) })
  }

  async function handleCheckout(dir, entries, ctx, depth) {
    const linked = entries.find((e) => e.name === ".git").isFile()
    if (ctx.mode === "inactive") {
      const s = await gitSafety(dir, linked)
      if (s.safe) return add("session-clones", dir, linked ? { commonDir: s.commonDir } : {})
      skipped.push({ path: dir, reason: s.reason })
    }
    return scanTree(dir, { ...ctx, mode: ctx.mode === "inactive" ? "buildOnly" : ctx.mode, gitRoot: dir }, depth)
  }

  async function scanSessions(active, scanContents) {
    const sessions = []
    for (const e of await readdir(o.sessionState)) {
      if (!e.isDirectory()) continue
      const dir = path.join(o.sessionState, e.name)
      const { live, newest } = await sessionActivity(dir)
      const isActive = active.protectedIds.has(e.name) || live || t0 - newest < o.recentHours * 3_600_000
      if (isActive) for (const p of await workspacePaths(dir)) active.protectedPaths.add(p)
      sessions.push({ id: e.name, dir, isActive, newest, archived: active.archivedIds.has(e.name) })
    }
    for (const s of sessions) {
      stats.sessions[s.isActive ? "active" : "inactive"]++
      if (scanContents) await scanTree(s.dir, { mode: s.isActive ? "active" : "inactive", session: true, keepImages: active.openPr.has(s.id), maxDepth: o.scanDepth })
    }
    return sessions
  }

  async function findCheckouts(root, depth, found) {
    if (depth > o.worktreeDepth) return found
    for (const e of await readdir(root)) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git") continue
      const fp = path.join(root, e.name)
      const dotGit = await lstat(path.join(fp, ".git"))
      if (dotGit) found.push({ path: fp, linked: dotGit.isFile() })
      else await findCheckouts(fp, depth + 1, found)
    }
    return found
  }

  // Without --code-roots, the folders that hold the worktrees the app made. The home folder itself is never a code root.
  function codeRoots(active) {
    if (o.codeRoots) return o.codeRoots
    const parents = [...new Set([...active.knownWorktrees].map((p) => path.dirname(p)))]
      .filter((p) => p !== path.dirname(p) && p !== o.home)
    return parents.filter((p) => !parents.some((q) => q !== p && isInside(p, q)))
  }

  async function scanWorktrees(active, roots) {
    const prot = [...active.protectedPaths]
    // The app keeps a pool of pre-created copilot-prewarm-* worktrees for future sessions, outside its database.
    const isProtected = (p) => path.basename(p).startsWith("copilot-prewarm-") || prot.some((q) => isInside(p, q) || isInside(q, p))
    for (const root of roots) {
      for (const c of await findCheckouts(root, 1, [])) {
        await pace()
        if (c.linked && !isProtected(c.path)) {
          await d.sleep(o.gitPauseMs)
          const s = await gitSafety(c.path, true)
          if (s.safe) {
            stats.worktrees.candidates++
            await add("worktrees", c.path, { commonDir: s.commonDir })
            continue
          }
          skipped.push({ path: c.path, reason: s.reason })
        } else if (c.linked) stats.worktrees.protected++
        await scanTree(c.path, { mode: "active", gitRoot: c.path, maxDepth: o.scanDepth })
      }
    }
  }

  async function scanLogs() {
    const stack = [...o.logDirs]
    while (stack.length) {
      const dir = stack.pop()
      for (const e of await readdir(dir)) {
        const fp = path.join(dir, e.name)
        if (e.isDirectory()) stack.push(fp)
        if (!e.isFile()) continue
        const st = await lstat(fp)
        if (old(st, o.logDays)) await add("logs", fp, { bytes: diskBytes(st) })
      }
    }
  }

  // ---------- ceiling ----------
  async function agentStorageBytes(roots) {
    const tops = [o.sessionState, ...o.logDirs]
    for (const root of roots) for (const c of await findCheckouts(root, 1, [])) if (c.linked) tops.push(c.path)
    let total = 0
    for (const top of tops) {
      if (!(await lstat(top))) continue
      const bytes = await d.diskUsage(top)
      if (bytes === null) return null
      total += bytes
    }
    return total
  }

  async function ceilingPass(sessions, roots) {
    const current = await agentStorageBytes(roots)
    const ceilingBytes = o.ceilingGB * GB
    if (current === null) return { unmeasured: true, ceilingBytes }
    // After --apply the main deletions already happened, so `current` is measured; a dry run projects from the listed sizes (known only with --sizes).
    const projected = current - (o.apply ? 0 : plan.reduce((sum, item) => sum + item.bytes, 0))
    const result = { currentBytes: current, projectedBytes: projected, ceilingBytes, extraBytes: 0, sessionsPruned: 0 }
    let over = projected - ceilingBytes
    const oldestFirst = sessions.filter((s) => !s.isActive).sort((a, b) => (b.archived - a.archived) || (a.newest - b.newest))
    for (const s of oldestFirst) {
      if (over <= 0) break
      let freed = 0
      const stack = [s.dir]
      while (stack.length) {
        const dir = stack.pop()
        for (const e of await readdir(dir)) {
          const fp = path.join(dir, e.name)
          if (e.isSymbolicLink() || underPlanned(fp) || (dir === s.dir && keepTop(e.name))) continue
          if (e.isDirectory()) {
            // Never enter a checkout the main pass did not verify as safe.
            if (e.name !== ".git" && !(await lstat(path.join(fp, ".git")))) stack.push(fp)
            continue
          }
          const st = await lstat(fp)
          if (!st || (SMALL_TEXT.test(e.name) && st.size < MB)) continue
          await add("ceiling", fp, { bytes: diskBytes(st) })
          freed += diskBytes(st)
        }
      }
      over -= freed
      result.extraBytes += freed
      result.sessionsPruned++
    }
    return result
  }

  // ---------- apply ----------
  async function resetWindow() {
    windowStart = d.now()
    windowFree = await d.freeBytes(o.trash)
  }

  async function rateLimit() {
    const elapsed = d.now() - windowStart
    if (elapsed >= 60_000) return resetWindow()
    if ((await d.freeBytes(o.trash)) - windowFree >= o.gbPerMin * GB) {
      await d.sleep(60_000 - elapsed)
      return resetWindow()
    }
    // Deletions wake endpoint scanners, so after each batch the job yields briefly while the 5-minute load is high.
    if (++batch < d.deleteBatch) return
    batch = 0
    if (d.loadavg()[1] >= o.loadLimit) await d.sleep(2000)
  }

  async function rmForce(p) {
    try {
      return await d.rm(p)
    } catch (error) {
      if (error.code !== "EACCES" && error.code !== "EPERM") throw error
    }
    // Some packages ship read-only folders: restore owner write permission and retry once.
    await d.run("chmod", ["-R", "u+w", p], { timeout: 600_000 })
    try {
      await d.rm(p)
    } catch (error) {
      if (undeletable.some((u) => isInside(p, u.path) || isInside(u.path, p))) return
      undeletable.push({ path: p, reason: error.code === "EACCES" || error.code === "EPERM" ? "not removable by this user (left in the trash)" : error.message })
    }
  }

  // Deletes a tree in pieces so no single step frees more than a little at once.
  async function rmChunked(p, depth = 3) {
    if ((await lstat(p))?.isDirectory() && depth > 0) for (const e of await readdir(p)) await rmChunked(path.join(p, e.name), depth - 1)
    await rmForce(p)
    await rateLimit()
  }

  async function apply(items) {
    const result = { removedBytes: 0, byCategory: {}, failed: [] }
    await fsp.mkdir(o.trash, { recursive: true })
    await resetWindow()
    // Whatever an interrupted run left in the trash goes first.
    for (const e of await readdir(o.trash)) await rmChunked(path.join(o.trash, e.name))
    const runDir = path.join(o.trash, String(t0))
    await fsp.mkdir(runDir, { recursive: true })
    const prune = new Set()
    let i = 0
    for (const category of new Set(items.map((item) => item.category))) {
      const before = await d.freeBytes(o.trash)
      for (const item of items.filter((x) => x.category === category)) {
        try {
          if ((await fsp.lstat(item.path)).isDirectory()) {
            // A same-volume rename takes the folder out of place at once; the slow delete happens afterwards.
            let target = path.join(runDir, `${i++}-${path.basename(item.path)}`)
            try {
              await d.rename(item.path, target)
            } catch (error) {
              if (error.code !== "EXDEV") throw error
              target = item.path
            }
            if (item.commonDir) prune.add(item.commonDir)
            await rmChunked(target)
          } else {
            await rmForce(item.path)
            if (i++ % 200 === 0) await rateLimit()
          }
        } catch (error) {
          result.failed.push({ path: item.path, reason: error.message })
        }
      }
      result.byCategory[category] = Math.max(0, (await d.freeBytes(o.trash)) - before)
      result.removedBytes += result.byCategory[category]
    }
    for (const commonDir of prune) await d.run("git", ["--git-dir", commonDir, "worktree", "prune"])
    await rmForce(runDir)
    return result
  }

  // ---------- main ----------
  await fsp.mkdir(o.reportDir, { recursive: true })
  const freeBefore = await d.freeBytes(o.reportDir)
  let active = null
  let classificationError = null
  try {
    active = await loadActive()
  } catch (error) {
    classificationError = error.message
  }
  if (!o.skip.has("logs")) await scanLogs()
  let sessions = []
  let roots = []
  if (active) {
    // Sessions are always classified: an active session's workspace paths protect its worktrees.
    sessions = await scanSessions(active, !o.skip.has("sessions"))
    roots = codeRoots(active)
    if (!o.skip.has("worktrees")) await scanWorktrees(active, roots)
    if (!o.skip.has("state")) for (const r of o.stateRoots) await scanTree(r, { mode: "state", maxDepth: 12 })
  }
  const applied = o.apply ? await apply(plan) : null
  let ceiling = null
  if (active && o.ceiling) {
    const before = plan.length
    ceiling = await ceilingPass(sessions, roots)
    if (applied) {
      const more = await apply(plan.slice(before))
      applied.removedBytes += more.removedBytes
      applied.failed.push(...more.failed)
      for (const [k, v] of Object.entries(more.byCategory)) applied.byCategory[k] = (applied.byCategory[k] || 0) + v
    }
  }
  const categories = {}
  for (const item of plan) {
    categories[item.category] ??= { items: 0, bytes: 0 }
    categories[item.category].items++
    categories[item.category].bytes += item.bytes
  }
  const report = {
    mode: o.apply ? "apply" : "dry-run",
    at: new Date(t0).toISOString(),
    seconds: Math.round((d.now() - t0) / 1000),
    classificationError,
    codeRoots: roots,
    sessions: stats.sessions,
    worktrees: stats.worktrees,
    categories,
    plannedBytes: plan.reduce((sum, item) => sum + item.bytes, 0),
    ceiling,
    freeBefore,
    freeAfter: await d.freeBytes(o.reportDir),
    applied: applied && { ...applied, failed: [...applied.failed, ...undeletable] },
    skipped,
    plan: plan.map(({ category, path: p, bytes }) => ({ category, path: p, bytes })),
  }
  report.file = path.join(o.reportDir, `${report.at.slice(0, 10)}-${report.mode}.json`)
  await fsp.writeFile(report.file, `${JSON.stringify(report, null, 1)}\n`)
  return report
}

function summary(report, o) {
  const lines = [`session-retention ${report.mode} (${report.seconds}s): ${report.plan.length} items ${report.applied ? `removed, ${gb(report.applied.removedBytes)} freed` : "would be removed"}`]
  if (report.classificationError) lines.push(`  ${report.classificationError}`)
  lines.push(`  sessions: ${report.sessions.active} active, ${report.sessions.inactive} inactive; worktrees: ${report.worktrees.candidates} removable, ${report.worktrees.protected} protected`)
  for (const [name, c] of Object.entries(report.categories).sort((a, b) => b[1].items - a[1].items)) {
    const freed = report.applied ? `  freed ${gb(report.applied.byCategory[name] || 0)}` : ""
    lines.push(`  ${name.padEnd(22)} ${String(c.items).padStart(6)} items  ${gb(c.bytes)}${freed}`)
  }
  const c = report.ceiling
  if (c?.unmeasured) lines.push("  ceiling not checked: agent storage could not be measured (du unavailable)")
  else if (c) lines.push(`  agent storage ${gb(c.currentBytes)}, ceiling ${gb(c.ceilingBytes)}; the ceiling pass pruned ${c.sessionsPruned} sessions`)
  lines.push(`  left in place (unsafe to remove): ${report.skipped.length}`)
  if (o.verbose) for (const s of report.skipped) lines.push(`    ${s.path}: ${s.reason}`)
  const failed = report.applied?.failed ?? []
  if (failed.length) lines.push(`  failed: ${failed.length}`, ...failed.slice(0, 20).map((f) => `    ${f.path}: ${f.reason}`))
  lines.push(`  free space: ${gb(report.freeBefore)} -> ${gb(report.freeAfter)}`, `  report: ${report.file}`)
  return `${lines.join("\n")}\n`
}

/** The CLI: parses `argv`, runs one pass and prints a summary (or JSON). Returns the exit code. */
export async function runSessionRetentionCli({ argv, env = process.env, io = process, deps }) {
  const parsed = parseRetentionArgs(argv, { env })
  if (parsed.help) {
    io.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (parsed.error) {
    io.stderr.write(`session-retention: ${parsed.error}\n${USAGE}\n`)
    return 2
  }
  try {
    const report = await runRetention(parsed.options, deps)
    const { plan: _plan, ...brief } = report
    io.stdout.write(parsed.options.json ? `${JSON.stringify(brief, null, 1)}\n` : summary(report, parsed.options))
    return 0
  } catch (error) {
    io.stderr.write(`session-retention failed: ${error.stack}\n`)
    return 1
  }
}
