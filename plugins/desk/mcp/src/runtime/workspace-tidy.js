import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseFrontmatterLite } from "../desk/frontmatter-lite.js"
import { readInspectionGit } from "./git-inspection.js"
import { readProcessStart } from "../readiness/process-start.js"

const RECENT_MS = 30 * 24 * 60 * 60 * 1000
const MAX_BYTES = 64 * 1024
const SHA = /^[0-9a-f]{40,64}$/u
const REF = /^refs\/(?:heads|remotes)\/[^\s~^:?*[\\]+$/u
const text = (value) => typeof value === "string" && value.length > 0
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`)
const cleanLine = (value) => String(value).replace(/[\x00-\x1f\x7f]/gu, " ")
const gitDefault = (cwd, args) => readInspectionGit(cwd, ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {})

async function smallFile(file) {
  const info = await fs.lstat(file)
  if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error("unsafe or oversized file")
  const handle = await fs.open(file, "r")
  try {
    const current = await handle.stat()
    if (current.ino !== info.ino || current.dev !== info.dev) throw new Error("file identity changed")
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_BYTES) throw new Error("oversized file")
    return buffer.toString("utf8", 0, bytesRead)
  } finally {
    await handle.close()
  }
}

// Only the ordinary block-list form is admitted without a YAML runtime. Other
// shapes are reported, never guessed or broadened into filesystem discovery.
function cardRepositories(matter) {
  const block = /^repos:\s*\n((?:[ \t]+[^\n]*\n?|[ \t]*\n)*)/mu.exec(matter)
  if (!block) {
    if (/^repos:\s*\[\s*\]\s*$/mu.test(matter)) return []
    throw new Error("repos must be a block list or []")
  }
  const items = block[1].split(/^\s+- /mu).filter((item) => item.trim())
  return items.map((item) => {
    const lines = item.trimEnd().split("\n")
    const body = [lines[0], ...lines.slice(1).map((line) => line.trimStart())].join("\n")
    const { data } = parseFrontmatterLite(`---\n${body}\n---`)
    if (!["local", "remote"].includes(data.mode)) throw new Error("repo mode missing")
    if (data.mode === "remote") return null
    if (!text(data.local_path)) throw new Error("local repo path missing")
    return data.local_path
  }).filter(Boolean)
}

export function parseWorktrees(output, repository) {
  return output.split("\0\0").filter(Boolean).map((block) => {
    const item = { repository }
    for (const line of block.split("\0")) {
      const space = line.indexOf(" ")
      const key = space < 0 ? line : line.slice(0, space)
      const value = space < 0 ? true : line.slice(space + 1)
      if (key === "worktree") item.path = value
      else if (key === "HEAD") item.head = value
      else if (["branch", "locked", "prunable", "detached", "bare"].includes(key)) item[key] = value
    }
    return item
  })
}

export async function inspectWorkspace({
  deskRoot, homeDir = os.homedir(), now = Date.now(), budgetMs = 200,
  maxCards = 128, maxDirectories = 512, maxEntries = 4096, maxRepositories = 16, maxWorktrees = 128, git = gitDefault,
} = {}) {
  const result = { repositories: [], cards: [], cardRecords: {}, worktrees: [], issues: [], complete: true }
  let expired = false
  let timer
  const stop = () => { if (expired) throw new Error("workspace-tidy budget exceeded") }
  const inventory = async () => {
    const root = await fs.realpath(deskRoot)
    stop()
    const repositories = new Set([root])
    const queue = [{ dir: root, depth: 0 }]
    let directories = 0
    let entryCount = 0
    while (queue.length) {
      stop()
      if (++directories > maxDirectories) throw new Error("workspace-tidy directory budget exceeded")
      const { dir, depth } = queue.shift()
      const entries = []
      const directory = await fs.opendir(dir)
      for await (const entry of directory) {
        stop()
        if (++entryCount > maxEntries) throw new Error("workspace-tidy entry budget exceeded")
        entries.push(entry)
      }
      stop()
      if (entries.some((entry) => entry.name === "task.md" && entry.isFile())) {
        if (result.cards.length >= maxCards) throw new Error("workspace-tidy card budget exceeded")
        const file = path.join(dir, "task.md")
        const body = await smallFile(file)
        const { data, matter } = parseFrontmatterLite(body)
        if (!text(data.status)) throw new Error(`unreadable task status: ${file}`)
        const terminal = ["done", "cancelled"].includes(data.status)
        const updated = Date.parse(data.updated)
        if (!terminal || !Number.isFinite(updated) || now - updated <= RECENT_MS) {
          result.cards.push(file)
          const cardRepos = [root]
          for (const value of cardRepositories(matter)) {
            const repo = value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value
            if (!path.isAbsolute(repo)) throw new Error(`unresolved repo path: ${file}`)
            const canonical = await fs.realpath(repo)
            repositories.add(canonical)
            cardRepos.push(canonical)
            if (repositories.size > maxRepositories) throw new Error("workspace-tidy repository budget exceeded")
          }
          result.cardRecords[file] = { body, repositories: cardRepos }
        }
        continue
      }
      // Desk layout only: tracks/tasks, their archives, and crew desks. Never
      // recurse into a task's code, evidence or a symlink.
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || (entry.name.startsWith("_") && entry.name !== "_archive")) continue
        if (["node_modules", "artifacts"].includes(entry.name)) continue
        if (depth >= 6) throw new Error("workspace-tidy layout depth budget exceeded")
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
    result.repositories = [...repositories]
    const commonDirs = new Set()
    for (const repo of repositories) {
      stop()
      const common = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      stop()
      if (!common.ok) throw new Error(`cannot inspect repository: ${repo}`)
      if (repo === root) result.commonDirectory = common.stdout
      if (commonDirs.has(common.stdout)) continue
      commonDirs.add(common.stdout)
      const listing = await git(repo, ["worktree", "list", "--porcelain", "-z"])
      stop()
      if (!listing.ok) throw new Error(`cannot list worktrees: ${repo}`)
      const worktrees = parseWorktrees(listing.stdout, repo)
      // The first entry is the primary checkout, which is never a cleanup target.
      result.worktrees.push(...worktrees.slice(1).filter((item) => item.path !== root))
      if (result.worktrees.length > maxWorktrees) throw new Error("workspace-tidy worktree budget exceeded")
    }
    return result
  }
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true
      resolve({ ...result, complete: false, issues: [...result.issues, "workspace-tidy budget exceeded; inspection deferred"] })
    }, budgetMs)
  })
  try {
    return await Promise.race([inventory().catch((error) => ({ ...result, complete: false, issues: [...result.issues, error.message] })), deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function mustGit(git, cwd, args) {
  const result = await git(cwd, args)
  if (!result.ok) throw new Error(`Git inspection failed: ${args[0]}`)
  return result.stdout
}

async function absent(file) {
  try { await fs.lstat(file); return false } catch (error) {
    if (error.code === "ENOENT") return true
    throw error
  }
}

async function releasedWriters(release, { processStart, signal }) {
  if (!release || release.complete !== true || !text(release.host) || !text(release.evidence) || release.machine !== os.hostname()) throw new Error("writer release unverified")
  if (!Array.isArray(release.consumers) || release.consumers.length) throw new Error("live or unobservable consumer")
  if (!Array.isArray(release.processes) || !release.processes.length) throw new Error("writer generations missing")
  for (const writer of release.processes) {
    if (!Number.isSafeInteger(writer.pid) || writer.pid <= 0 || !text(writer.start)) throw new Error("writer generation unverified")
    try {
      signal(writer.pid, 0)
    } catch (error) {
      if (error.code === "ESRCH") continue
      throw new Error("writer liveness unobservable")
    }
    const current = await processStart(writer.pid)
    if (current === null || current === writer.start) throw new Error("live or unobservable writer")
  }
}

async function candidate(item, inventory, options) {
  const { git, processStart, signal } = options
  const cwd = item.path
  if (item.locked) throw new Error("locked worktree")
  if (item.prunable || item.bare) throw new Error("missing or bare worktree")
  if (!item.branch || item.detached) throw new Error("detached worktree")
  if (await fs.realpath(cwd) !== cwd) throw new Error("worktree identity is symlinked")
  const common = await mustGit(git, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const admin = await mustGit(git, cwd, ["rev-parse", "--absolute-git-dir"])
  if (admin === common || !inside(path.join(common, "worktrees"), admin)) throw new Error("worktree ownership unverified")
  const protectedFlag = await git(cwd, ["config", "--type=bool", "--get", "desk.protected"])
  if (protectedFlag.ok && protectedFlag.stdout === "true") throw new Error("protected checkout")
  if (!protectedFlag.ok && protectedFlag.code !== 1) throw new Error("protected policy unreadable")
  for (const marker of ["index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"]) {
    if (!await absent(path.join(admin, marker))) throw new Error("git operation in progress")
  }
  const receiptPath = path.join(admin, "desk-closeout.json")
  let raw, record
  try { raw = await smallFile(receiptPath); record = JSON.parse(raw) } catch { throw new Error("exact ownership receipt missing or unreadable") }
  const info = await fs.stat(cwd)
  const card = path.resolve(options.deskRoot, record.task ?? "")
  if (record.version !== 1 || !text(record.owner) || record.worktree !== cwd || record.repository !== common || record.branch !== item.branch ||
      !inventory.cardRecords[card]?.repositories.includes(item.repository)) throw new Error("exact ownership mismatch")
  if (await smallFile(card) !== inventory.cardRecords[card].body) throw new Error("task ownership changed")
  if (record.disposition !== "remove") throw new Error("intentionally retained worktree")
  if (record.identity?.dev !== info.dev || record.identity?.ino !== info.ino) throw new Error("worktree identity changed")
  if (!SHA.test(record.head) || item.head !== record.head) throw new Error("local commits or HEAD changed since release")
  if (!REF.test(record.base) || !SHA.test(record.delivered)) throw new Error("delivery reference unverified")
  await releasedWriters(record.release, { processStart, signal })
  const status = await mustGit(git, cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"])
  if (status) {
    if (status.startsWith("??")) throw new Error("untracked files")
    if (status.startsWith("!!")) throw new Error("ignored files")
    throw new Error("tracked changes or untracked files")
  }
  const deliveredOnBase = await git(cwd, ["merge-base", "--is-ancestor", record.delivered, record.base])
  if (!deliveredOnBase.ok) throw new Error("delivery is not on recorded base")
  const merged = (await git(cwd, ["merge-base", "--is-ancestor", record.head, record.base])).ok
  if (!merged) {
    const diff = await mustGit(git, cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", record.delivered, record.head, "--"])
    if (diff) throw new Error("local commits not preserved at delivery")
    const remote = record.remote
    if (!remote || !text(remote.name) || !/^refs\/heads\/[^\s~^:?*[\\]+$/u.test(remote.branch)) throw new Error("unmerged branch; remote deletion unverified")
    const names = (await mustGit(git, cwd, ["remote"])).split("\n")
    if (!names.includes(remote.name) || remote.name.startsWith("-")) throw new Error("remote ownership unverified")
    const remoteState = await git(cwd, ["ls-remote", "--exit-code", "--refs", remote.name, remote.branch])
    if (remoteState.ok || remoteState.code !== 2) throw new Error("remote branch exists or is unobservable")
  }
  return { record, raw, receiptPath, merged }
}

export async function repairWorkspace({ deskRoot, git = gitDefault, processStart = readProcessStart, signal = process.kill, ...inspection } = {}) {
  const inventory = await inspectWorkspace({ ...inspection, deskRoot, git, budgetMs: 30_000 })
  const result = { removed: [], left: [], issues: inventory.issues }
  if (!inventory.complete) {
    result.left = inventory.worktrees.map((item) => ({ path: item.path, reason: "incomplete inventory; retained" }))
    return result
  }
  for (const item of inventory.worktrees) {
    let resource = item.path
    try {
      const options = { deskRoot, git, processStart, signal }
      const first = await candidate(item, inventory, options)
      // Re-read registration, receipt, identity, status and writer evidence at
      // the deletion boundary. No force, reset, prune or process termination.
      const fresh = parseWorktrees(await mustGit(git, item.repository, ["worktree", "list", "--porcelain", "-z"]), item.repository)
      const current = fresh.find((entry) => entry.path === item.path)
      if (!current) throw new Error("worktree registration changed")
      const checked = await candidate(current, inventory, options)
      if (first.raw !== checked.raw) throw new Error("ownership changed during repair")
      const removed = await git(item.repository, ["worktree", "remove", "--", item.path])
      if (!removed.ok) throw new Error("worktree removal refused")
      const listing = await mustGit(git, item.repository, ["worktree", "list", "--porcelain", "-z"])
      if (!await absent(item.path) || parseWorktrees(listing, item.repository).some((entry) => entry.path === item.path)) throw new Error("worktree absence unverified")
      const entry = { path: item.path, branch: checked.record.branch, owner: checked.record.owner, branchRemoved: false }
      result.removed.push(entry)
      resource = `${item.repository}:${entry.branch}`
      // Git's non-forced branch deletion also refuses a newly attached writer.
      // A squash branch remains named; never force-delete it by inference.
      const head = await git(item.repository, ["rev-parse", "--verify", "--quiet", checked.record.branch])
      if (head.code === 1) {
        entry.branchRemoved = true
      } else if (checked.merged && head.ok && head.stdout === checked.record.head) {
        await git(item.repository, ["branch", "-d", "--", checked.record.branch.slice("refs/heads/".length)])
        const exists = await git(item.repository, ["show-ref", "--verify", "--quiet", checked.record.branch])
        entry.branchRemoved = exists.code === 1
      }
      if (!entry.branchRemoved) result.left.push({ path: resource, reason: "branch retained; owner must reconcile" })
    } catch (error) {
      result.left.push({ path: resource, reason: cleanLine(error.message) })
    }
  }
  return result
}

export function tidyLine({ removed = [], left = [], issues = [] } = {}) {
  const prefix = `Tidied ${removed.length} stale worktrees; ${left.length} left`
  const details = left.map((entry) => `${cleanLine(entry.path)}: ${cleanLine(entry.reason)}`).join("; ")
  const suffix = issues.map(cleanLine).join("; ")
  const full = `${prefix}${details ? `: ${details}` : ""}${suffix ? `; ${suffix}` : ""}`
  if (full.length <= 480) return full
  const counts = new Map()
  for (const entry of left) counts.set(cleanLine(entry.reason), (counts.get(cleanLine(entry.reason)) ?? 0) + 1)
  const grouped = [...counts].map(([reason, count]) => `${count} ${reason}`).join("; ")
  return `${prefix}: ${grouped}; details in workspace-tidy report${suffix ? `; ${suffix}` : ""}`.slice(0, 480)
}
