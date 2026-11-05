import { crewWorkspaceAbove } from "../util/paths.js"
import { promises as fs } from "node:fs"
import path from "node:path"
import { readInspectionGit } from "./git-inspection.js"
import { nativeGitPath, samePath, insidePath } from "./native-path.js"

const SHA = /^[0-9a-f]{40,64}$/u
const INCOMPLETE = "unsaved-work: inspection incomplete; local publication state unknown."
const UNSAVED_WORK_BUDGET_LINE = "unsaved-work: not checked (boot budget exhausted); local publication state unknown."

function worktreePaths(raw) {
  const entries = raw.split("\0\0").filter(Boolean)
  if (!entries.length) throw new Error("empty inventory")
  return entries.map((entry) => {
    const first = entry.split("\0")[0]
    if (!first.startsWith("worktree ") || first.length === 9) throw new Error("invalid inventory")
    const fields = entry.split("\0")
    const oid = fields.find((field) => field.startsWith("HEAD "))?.slice(5)
    if (!SHA.test(oid)) throw new Error("invalid worktree head")
    return {
      path: nativeGitPath(first.slice(9)), oid: /^0+$/u.test(oid) ? "(initial)" : oid,
      branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(7),
      detached: fields.includes("detached"),
    }
  })
}

// --debug's stat fields are not a stable porcelain protocol. Reject any other shape rather than guessing clean.
function indexEntries(raw) {
  const entries = []
  let rest = raw
  while (rest) {
    const nul = rest.indexOf("\0")
    const header = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/u.exec(rest.slice(0, nul))
    if (nul < 0 || !header) throw new Error("invalid index entry")
    rest = rest.slice(nul + 1)
    const stat = /^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: (\d+)\tgid: (\d+)\n  size: (\d+)\tflags: ([0-9a-f]+)(?:\n|$)/u.exec(rest)
    if (!stat) throw new Error("invalid index stat")
    entries.push({ mode: header[1], stage: header[3], name: header[4], stat: stat.slice(1, 10).map(BigInt), flags: stat[10] })
    rest = rest.slice(stat[0].length)
  }
  return entries
}

function metadataMatches(entry, current, platform) {
  const small = (value) => BigInt.asUintN(32, value)
  // Git for Windows records creation time as ctime and zeroes dev/ino/uid/gid.
  const ctime = platform === "win32" ? current.birthtimeNs : current.ctimeNs
  const values = [
    ctime / 1_000_000_000n, ctime % 1_000_000_000n,
    current.mtimeNs / 1_000_000_000n, current.mtimeNs % 1_000_000_000n,
    ...(platform === "win32" ? [0n, 0n, 0n, 0n] : [current.dev, current.ino, current.uid, current.gid]), current.size,
  ]
  const typeMatches = entry.mode === "120000" ? current.isSymbolicLink() : current.isFile()
  return typeMatches && values.every((value, i) => small(value) === entry.stat[i])
}

/** Read-only, local evidence only. Labels are counts: no user paths, refs, filenames or Git error text reach the boot line. */
export async function inspectUnsavedWork({ deskRoot, deadline, signal, git = readInspectionGit, maxWorktrees = 16, platform = process.platform }) {
  try {
    const root = crewWorkspaceAbove(deskRoot)
    if (!root) return ""
    const read = async (cwd, args) => {
      const remaining = deadline - performance.now()
      if (remaining < 1 || signal?.aborted) throw new Error("budget")
      return git(cwd, ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { signal, timeoutMs: remaining })
    }
    if (performance.now() >= deadline || signal?.aborted) return UNSAVED_WORK_BUDGET_LINE
    const listed = await read(root, ["worktree", "list", "--porcelain", "-z"])
    if (!listed.ok) return INCOMPLETE
    const places = worktreePaths(listed.stdout)
    // Keep the main checkout first, but include the bound clone before other linked worktrees when capped.
    const bound = places.findIndex((place) => samePath(place.path, root))
    if (bound > 1) places.splice(1, 0, ...places.splice(bound, 1))
    const selected = places.slice(0, maxWorktrees)
    const main = await read(root, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"])
    const mainOid = main.ok && SHA.test(main.stdout) ? main.stdout : null
    const totals = { affected: 0, dirty: 0, contentUnknown: 0, ahead: 0, unmerged: 0, noUpstream: 0, detached: 0, unknown: 0, upstreamUnknown: 0, failed: 0 }
    let next = 0
    const worker = async () => {
      while (next < selected.length) {
        const state = selected[next++]
        const place = state.path
        try {
          const index = await read(place, ["ls-files", "--stage", "--debug", "-z"])
          if (!index.ok) throw new Error("index unavailable")
          const entries = indexEntries(index.stdout)
          const staged = state.oid === "(initial)" ? entries.map((entry) => entry.name) : null
          const diff = staged ? null : await read(place, ["diff", "--cached", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "-z"])
          if (diff && !diff.ok) throw new Error("staged comparison unavailable")
          const untracked = await read(place, ["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z"])
          if (!untracked.ok) throw new Error("untracked inventory unavailable")
          const dirty = new Set([...(staged ?? diff.stdout.split("\0")), ...untracked.stdout.split("\0")].filter(Boolean))
          let contentUnknown = 0
          for (const entry of entries) {
            if (performance.now() >= deadline || signal?.aborted) throw new Error("budget")
            if (entry.stage !== "0") dirty.add(entry.name)
            if (dirty.has(entry.name)) continue
            // Never recurse into submodules or compare bytes through Git's clean/process filters.
            if (entry.mode === "160000" || entry.mode === "040000" || entry.flags !== "0") {
              contentUnknown += 1
              continue
            }
            const file = path.resolve(place, entry.name)
            if (!insidePath(place, file)) throw new Error("invalid index path")
            try {
              if (!metadataMatches(entry, await fs.lstat(file, { bigint: true }), platform)) contentUnknown += 1
            } catch (error) {
              if (error.code === "ENOENT" || error.code === "ENOTDIR") contentUnknown += 1
              else throw error
            }
          }
          let ahead = 0
          let upstreamUnknown = false
          let noUpstream = true
          if (state.branch) {
            const tracking = await read(place, ["for-each-ref", "--format=%(upstream)%00%(upstream:track)", state.branch])
            if (!tracking.ok) throw new Error("upstream unavailable")
            const [upstream, rawTrack] = tracking.stdout.split("\0")
            const track = rawTrack?.trim() ?? ""
            noUpstream = !upstream
            upstreamUnknown = Boolean(upstream) && track === "[gone]"
            ahead = Number(/\bahead (\d+)/u.exec(track ?? "")?.[1] ?? 0)
          }
          let unmerged = 0
          const unknown = mainOid === null && state.oid !== "(initial)"
          if (mainOid && state.oid !== "(initial)") {
            const count = await read(place, ["rev-list", "--count", state.oid, "--not", mainOid])
            if (!count.ok || !/^\d+$/u.test(count.stdout)) throw new Error("ancestry unavailable")
            unmerged = Number(count.stdout)
          }
          if (dirty.size || contentUnknown || ahead || unmerged || unknown || upstreamUnknown) {
            totals.affected += 1
            totals.dirty += dirty.size
            totals.contentUnknown += contentUnknown
            totals.ahead += ahead
            totals.unmerged += unmerged
            totals.unknown += Number(unknown)
            totals.noUpstream += Number(noUpstream)
            totals.detached += Number(state.detached)
            totals.upstreamUnknown += Number(upstreamUnknown)
          }
        } catch {
          totals.failed += 1
        }
      }
    }
    await Promise.all([worker(), worker()])
    const current = await read(root, ["worktree", "list", "--porcelain", "-z"])
    if (performance.now() >= deadline || signal?.aborted) return UNSAVED_WORK_BUDGET_LINE
    if (!current.ok) return INCOMPLETE
    if (current.stdout !== listed.stdout) return "unsaved-work: worktree inventory changed during inspection; local publication state unknown."
    const omitted = places.length - selected.length
    if (!totals.affected && !totals.failed && !omitted) return ""
    const details = []
    if (totals.failed) details.push(`${totals.failed} checkout${totals.failed === 1 ? "" : "s"} could not be inspected`)
    if (omitted) details.push(`${omitted} checkout${omitted === 1 ? "" : "s"} not inspected (limit)`)
    if (totals.affected) details.push(`${totals.affected} checkout${totals.affected === 1 ? " needs" : "s need"} publication review`)
    if (totals.dirty) details.push(`${totals.dirty} uncommitted entries`)
    if (totals.contentUnknown) details.push(`${totals.contentUnknown} tracked entries need review (content not compared)`)
    if (totals.ahead) details.push(`${totals.ahead} ahead of upstream`)
    if (totals.unmerged) details.push(`${totals.unmerged} not in local origin/main`)
    if (totals.noUpstream) details.push(`${totals.noUpstream} without upstream`)
    if (totals.detached) details.push(`${totals.detached} detached`)
    if (totals.unknown) details.push(`${totals.unknown} integration unknown (local origin/main unavailable)`)
    if (totals.upstreamUnknown) details.push(`${totals.upstreamUnknown} upstream comparison unavailable`)
    return `unsaved-work: ${details.join("; ")}. Local refs only; review publication without discarding work.`
  } catch {
    return performance.now() >= deadline || signal?.aborted ? UNSAVED_WORK_BUDGET_LINE : INCOMPLETE
  }
}
