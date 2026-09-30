import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseFrontmatterLite } from "../desk/frontmatter-lite.js"
import { isCredentialLike } from "../desk/naming.js"
import { readInspectionGit } from "./git-inspection.js"
import { readProcessStart } from "../readiness/process-start.js"
import { withWorkspaceClaim } from "./workspace-claim.js"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dispositionRecord } from "./workspace-evidence.js"

const RECENT_MS = 30 * 24 * 60 * 60 * 1000
const MAX_BYTES = 64 * 1024
const SHA = /^[0-9a-f]{40,64}$/u
const REF = /^refs\/(?:heads|remotes)\/[^\s~^:?*[\\]+$/u
const text = (value) => typeof value === "string" && value.length > 0
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`)
const cleanLine = (value) => String(value).replace(/[\x00-\x1f\x7f]/gu, " ")
// Workspace tidy's Git calls run in the detached repair, the CLI and the boot check's inspection. Only the boot check answers a host, and its whole-check budget aborts its calls through their signal, so each call may take far longer than a hook's 2 s: under load the 2 s limit killed repairs' ls-remote and rev-parse calls and left worktrees retained.
export const TIDY_GIT_TIMEOUT_MS = 20_000
export const tidyGit = (cwd, args, options) => readInspectionGit(cwd, ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {}, { timeoutMs: TIDY_GIT_TIMEOUT_MS, ...options })
const gitDefault = tidyGit

// A task card's leading front matter block, read with one bounded read of at
// most MAX_BYTES from the start of the file, however large the card is. A
// card's body (a pasted log, a long transcript) never matters here: only the
// front matter says which task owns which repositories. The block is returned
// with its opening and closing `---` lines, split the way frontmatter-lite
// splits it; a small card with no closing line runs to its end, as there. The
// same text is compared again before a removal, so any change to the front
// matter still stops that removal.
//
// Throws a `CardSkip` for a problem with this one card: it is not a regular
// file with one link, it changed identity while being read, or its front
// matter does not close within MAX_BYTES. The inventory then skips that card
// by name instead of abandoning the whole desk.
class CardSkip extends Error {}

// One bounded read of a regular, singly linked file that must keep its
// identity while open: at most MAX_BYTES + 1 bytes, so `truncated` says whether
// the file is longer than MAX_BYTES. `Fail` is the error class to throw.
async function boundedRead(file, Fail) {
  const info = await fs.lstat(file)
  if (!info.isFile() || info.nlink !== 1) throw new Fail("not a regular file")
  const handle = await fs.open(file, "r")
  try {
    const current = await handle.stat()
    if (current.ino !== info.ino || current.dev !== info.dev) throw new Fail("file identity changed")
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return { raw: buffer.toString("utf8", 0, Math.min(bytesRead, MAX_BYTES)), truncated: bytesRead > MAX_BYTES }
  } finally {
    await handle.close()
  }
}

async function cardFrontmatter(file) {
  const { raw, truncated } = await boundedRead(file, CardSkip)
  const lines = raw.replace(/\r\n/gu, "\n").split("\n")
  const close = lines[0].trim() === "---" ? lines.findIndex((line, index) => index > 0 && line.trim() === "---") : -1
  if (close > 0) return lines.slice(0, close + 1).join("\n")
  if (truncated) throw new CardSkip("front matter not closed within 64 KiB")
  return raw
}

// A skipped card's path for the boot line and report: relative to the desk,
// with any segment that looks like it holds a secret's value redacted.
function cardLabel(root, file) {
  return path.relative(root, file).split(path.sep).map((segment) => (isCredentialLike(segment) ? "<redacted segment>" : segment)).join("/")
}

function skippedIssue(root, skipped) {
  const sorted = [...skipped].sort((a, b) => a.file.localeCompare(b.file, "en"))
  const shown = sorted.slice(0, 3).map(({ file, reason }) => `${cardLabel(root, file)} (${reason})`).join(", ")
  const more = skipped.length > 3 ? `, and ${skipped.length - 3} more` : ""
  return `${skipped.length} task card${skipped.length === 1 ? "" : "s"} skipped: ${shown}${more}`
}

function unreadableReposIssue(root, unreadable) {
  const sorted = [...unreadable].sort((a, b) => a.file.localeCompare(b.file, "en"))
  const shown = sorted.slice(0, 3).map(({ file, reason }) => `${cardLabel(root, file)} (${reason})`).join(", ")
  const more = unreadable.length > 3 ? `, and ${unreadable.length - 3} more` : ""
  return `${unreadable.length} task card${unreadable.length === 1 ? "" : "s"} with unreadable repos: ${shown}${more}; their repositories were not inspected`
}

async function smallFile(file) {
  const { raw, truncated } = await boundedRead(file, Error)
  if (truncated) throw new Error("oversized file")
  return raw
}

// Only the ordinary block-list form is admitted without a YAML runtime. Other
// shapes are reported, never guessed or broadened into filesystem discovery.
function cardRepositories(matter) {
  const block = /^repos:\s*\n((?:[ \t]+[^\n]*\n?|[ \t]*\n)*)/mu.exec(matter)
  if (!block) {
    if (/^repos:\s*\[\s*\]\s*$/mu.test(matter)) return []
    throw new Error("repos must be a block list or []")
  }
  const lines = block[1].split("\n")
  const indent = /^([ \t]+)- /u.exec(lines.find((line) => /^[ \t]+- /u.test(line)) ?? "")?.[1]
  if (!indent) throw new Error("repos must contain repository-level list items")
  const items = []
  for (const line of lines) {
    if (line.startsWith(`${indent}- `)) items.push([line.slice(indent.length + 2)])
    else if (line.trim()) {
      if (!items.length || !line.startsWith(`${indent}  `)) throw new Error("unsupported repository indentation")
      items.at(-1).push(line.slice(indent.length + 2))
    }
  }
  return items.map((item) => {
    const body = item.join("\n")
    const { data } = parseFrontmatterLite(`---\n${body}\n---`)
    if (!["local", "remote"].includes(data.mode)) throw new Error("repo mode missing")
    if (data.mode === "remote") return null
    if (!text(data.local_path)) throw new Error("local repo path missing")
    return data.local_path
  }).filter(Boolean)
}

// One signal that aborts when any of `signals` does, with that signal's
// reason. Hooks run in whatever Node the host puts first on PATH, and Node 16
// has no AbortSignal.any, so the listeners are wired here and removed by
// `cleanup` once the caller is done.
export function anySignal(signals) {
  const controller = new AbortController()
  const listeners = []
  const cleanup = () => {
    for (const [signal, listener] of listeners.splice(0)) signal.removeEventListener("abort", listener)
  }
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const listener = () => {
      controller.abort(signal.reason)
      cleanup()
    }
    signal.addEventListener("abort", listener, { once: true })
    listeners.push([signal, listener])
  }
  if (controller.signal.aborted) cleanup()
  return { signal: controller.signal, cleanup }
}

// The bound desk's one identity: its real path. Task lookup, report storage,
// report lookup and locking all key off it, so a desk bound through a symlink
// alias is the same desk as its real path. A root that cannot be resolved is
// returned as given; the inventory then reports it.
export async function canonicalDeskRoot(deskRoot) {
  try {
    return await fs.realpath(deskRoot)
  } catch {
    return deskRoot
  }
}

// A card's repositories, as real paths. A card with no `repos:` has none
// besides the desk. One whose `repos:` Desk cannot read (another YAML shape,
// a relative or missing path) throws here; the inventory then counts it in
// one issue and gives that card no repositories at all, so it authorizes no
// removal, while every other card still counts.
//
// The error's message is what the boot line shows for the card, so it names
// the repository path as the card wrote it (redacted like a card path) when
// the path is the problem, and is a fixed phrase otherwise.
class RepoProblem extends Error {}

function shownPath(value) {
  return value.split("/").map((segment) => (isCredentialLike(segment) ? "<redacted segment>" : segment)).join("/")
}

async function resolveCardRepositories(matter, homeDir) {
  if (!/^repos:/mu.test(matter)) return []
  let values
  try {
    values = cardRepositories(matter)
  } catch {
    throw new RepoProblem("repos list not readable")
  }
  const resolved = []
  for (const value of values) {
    const repo = value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value
    if (!path.isAbsolute(repo)) throw new RepoProblem(`repo ${shownPath(value)} is not an absolute or ~/ path`)
    try {
      resolved.push(await fs.realpath(repo))
    } catch {
      throw new RepoProblem(`repo ${shownPath(value)} not found`)
    }
  }
  return resolved
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
  maxCards = 128, maxDirectories = 512, maxEntries = 4096, maxRepositories = 16, maxWorktrees = 128, git = gitDefault, signal,
} = {}) {
  const result = { repositories: [], cards: [], cardRecords: {}, worktrees: [], issues: [], complete: true }
  let expired = false
  const cancellation = new AbortController()
  const combined = anySignal([signal, cancellation.signal])
  const stopSignal = combined.signal
  let timer
  const stop = () => { if (expired || stopSignal.aborted) throw new Error("workspace-tidy budget exceeded") }
  const inventory = async () => {
    const root = await fs.realpath(deskRoot)
    stop()
    const repositories = new Set([root])
    const queue = [{ dir: root, depth: 0 }]
    let directories = 0
    let entryCount = 0
    const unreadableRepos = []
    const skipped = []
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
      if (entries.some((entry) => entry.name === "task.md")) {
        if (result.cards.length >= maxCards) throw new Error("workspace-tidy card budget exceeded")
        const file = path.join(dir, "task.md")
        // One card that cannot be read is skipped by name; it authorizes no
        // removal, and every other card still counts.
        let body, data, matter
        try {
          body = await cardFrontmatter(file)
          ;({ data, matter } = parseFrontmatterLite(body))
          if (!text(data.status)) throw new CardSkip("no readable status")
        } catch (error) {
          skipped.push({ file, reason: error instanceof CardSkip ? error.message : "unreadable card" })
          continue
        }
        const terminal = ["done", "cancelled"].includes(data.status)
        const updated = Date.parse(data.updated)
        if (!terminal || !Number.isFinite(updated) || now - updated <= RECENT_MS) {
          result.cards.push(file)
          let cardRepos
          try {
            cardRepos = [root, ...await resolveCardRepositories(matter, homeDir)]
          } catch (error) {
            unreadableRepos.push({ file, reason: error.message })
            cardRepos = []
          }
          stop()
          for (const canonical of cardRepos) {
            repositories.add(canonical)
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
    if (skipped.length) result.issues.push(skippedIssue(root, skipped))
    if (unreadableRepos.length) result.issues.push(unreadableReposIssue(root, unreadableRepos))
    result.repositories = [...repositories]
    const commonDirs = new Set()
    for (const repo of repositories) {
      stop()
      const common = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal: stopSignal })
      stop()
      if (!common.ok) throw new Error(`cannot inspect repository: ${repo}`)
      if (repo === root) result.commonDirectory = common.stdout
      if (commonDirs.has(common.stdout)) continue
      commonDirs.add(common.stdout)
      const listing = await git(repo, ["worktree", "list", "--porcelain", "-z"], { signal: stopSignal })
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
      cancellation.abort()
      resolve({ ...result, complete: false, issues: [...result.issues, "workspace-tidy budget exceeded; inspection deferred"] })
    }, budgetMs)
  })
  try {
    return await Promise.race([inventory().catch((error) => ({ ...result, complete: false, issues: [...result.issues, error.message] })), deadline])
  } finally {
    clearTimeout(timer)
    combined.cleanup()
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

export async function normalizeDeliveryEndpoint(value, cwd) {
  if (!text(value) || /[\x00-\x20\x7f]/u.test(value) && !path.isAbsolute(value)) throw new Error("invalid delivery endpoint")
  if (path.isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) {
    return pathToFileURL(await fs.realpath(path.resolve(cwd, value))).href
  }
  const scp = /^(?:([^/@:]+)@)?([^/:]+):(.+)$/u.exec(value)
  const url = new URL(!value.includes("://") && scp ? `ssh://${scp[1] ? `${scp[1]}@` : ""}${scp[2]}/${scp[3]}` : value)
  if (url.protocol === "file:") return pathToFileURL(await fs.realpath(fileURLToPath(url))).href
  if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash ||
      (url.protocol === "https:" && url.username)) throw new Error("unsupported or credential-bearing delivery endpoint")
  url.hostname = url.hostname.toLowerCase()
  return url.href.replace(/\/$/u, "")
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
  if (record.version !== 2 || !text(record.owner) || record.worktree !== cwd || record.repository !== common || record.branch !== item.branch ||
      !inventory.cardRecords[card]?.repositories.includes(item.repository)) throw new Error("exact ownership mismatch")
  if (await cardFrontmatter(card) !== inventory.cardRecords[card].body) throw new Error("task ownership changed")
  if (record.disposition !== "remove") throw new Error("intentionally retained worktree")
  if (record.identity?.dev !== info.dev || record.identity?.ino !== info.ino) throw new Error("worktree identity changed")
  if (!SHA.test(record.head) || item.head !== record.head) throw new Error("local commits or HEAD changed since release")
  if (!REF.test(record.base) || !SHA.test(record.delivered)) throw new Error("delivery reference unverified")
  await releasedWriters(record.release, { processStart, signal })
  const flags = await mustGit(git, cwd, ["ls-files", "-v", "-z"])
  if (flags.split("\0").some((entry) => entry && !entry.startsWith("H "))) throw new Error("index flags prevent reliable tracked-content inspection")
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
    const urls = (await mustGit(git, cwd, ["remote", "get-url", "--push", "--all", remote.name])).split("\n")
    if (urls.length !== 1) throw new Error("ambiguous delivery push endpoints")
    const endpoint = await normalizeDeliveryEndpoint(urls[0], cwd)
    if (endpoint !== remote.endpoint) throw new Error("delivery endpoint missing or changed since release")
    const queryUrl = await mustGit(git, cwd, ["ls-remote", "--get-url", "--", endpoint])
    if (await normalizeDeliveryEndpoint(queryUrl, cwd) !== endpoint) throw new Error("delivery query endpoint changed by URL rewriting")
    const remoteState = await git(cwd, ["ls-remote", "--exit-code", "--refs", "--", endpoint, remote.branch])
    if (remoteState.ok || remoteState.code !== 2) throw new Error("remote branch exists or is unobservable")
  }
  return { record, raw, receiptPath, merged }
}

export async function revokeWorkspaceRelease(resource) {
  return withWorkspaceClaim(resource, async (assertHeld) => {
    const admin = await mustGit(gitDefault, resource.worktree, ["rev-parse", "--absolute-git-dir"])
    const file = path.join(admin, "desk-closeout.json")
    const record = JSON.parse(await smallFile(file))
    for (const key of ["repository", "worktree", "branch", "owner"]) {
      if (record[key] !== resource[key]) throw new Error("release revocation ownership mismatch")
    }
    await assertHeld()
    await fs.unlink(file)
    if (!await absent(file)) throw new Error("release revocation absence unverified")
    return { revoked: true, ...resource }
  })
}

export async function repairWorkspace({ deskRoot: boundRoot, git = gitDefault, processStart = readProcessStart, signal = process.kill, onDisposition = async () => {}, ...inspection } = {}) {
  // Resolved once: the inventory's card keys and each receipt's task lookup
  // use the same real path, whichever spelling bound the desk.
  const deskRoot = await canonicalDeskRoot(boundRoot)
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
      await withWorkspaceClaim(first.record, async (assertHeld) => {
        // Re-read registration, receipt, identity, status and writer evidence at
        // the deletion boundary. No force, reset, prune or writer termination.
        const fresh = parseWorktrees(await mustGit(git, item.repository, ["worktree", "list", "--porcelain", "-z"]), item.repository)
        const current = fresh.find((entry) => entry.path === item.path)
        if (!current) throw new Error("worktree registration changed")
        const checked = await candidate(current, inventory, options)
        if (first.raw !== checked.raw) throw new Error("ownership changed during repair")
        await assertHeld()
        if (await smallFile(checked.receiptPath) !== checked.raw) throw new Error("release revoked or changed during repair")
        await onDisposition(dispositionRecord(checked.record, "cleanup_pending"))
        const removed = await git(item.repository, ["worktree", "remove", "--", item.path])
        if (!removed.ok) throw new Error("worktree removal refused")
        const listing = await mustGit(git, item.repository, ["worktree", "list", "--porcelain", "-z"])
        if (!await absent(item.path) || parseWorktrees(listing, item.repository).some((entry) => entry.path === item.path)) throw new Error("worktree absence unverified")
        await assertHeld()
        const entry = { path: item.path, branch: checked.record.branch, owner: checked.record.owner, branchRemoved: false }
        result.removed.push(entry)
        resource = `${checked.record.repository}:${entry.branch}`
        // The claim coordinates reacquisition; Git's expected-old-value delete
        // also rejects an uncoordinated ref update atomically. No unmerged refs.
        const head = await git(item.repository, ["rev-parse", "--verify", "--quiet", checked.record.branch])
        if (head.code === 1) {
          entry.branchRemoved = true
        } else if (checked.merged && head.ok && head.stdout === checked.record.head) {
          const registrations = parseWorktrees(await mustGit(git, item.repository, ["worktree", "list", "--porcelain", "-z"]), item.repository)
          if (!registrations.some((entry) => entry.branch === checked.record.branch)) {
            await assertHeld()
            await git(item.repository, ["update-ref", "--no-deref", "-d", checked.record.branch, checked.record.head])
          }
          const exists = await git(item.repository, ["show-ref", "--verify", "--quiet", checked.record.branch])
          entry.branchRemoved = exists.code === 1
        }
        if (!entry.branchRemoved) result.left.push({ path: resource, reason: "branch retained; owner must reconcile" })
        await onDisposition(dispositionRecord(checked.record, "removed", entry.branchRemoved))
        await assertHeld()
      })
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
