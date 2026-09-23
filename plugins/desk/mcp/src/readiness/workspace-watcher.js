import { randomUUID } from "node:crypto"
import { lstatSync, readdirSync, watch as watchNative } from "node:fs"
import { mkdir, unlink, writeFile } from "node:fs/promises"
import * as path from "node:path"

const IGNORED_ROOTS = new Set([".git", ".state", "node_modules"])

export async function createWorkspaceWatcher({
  root,
  ignoredPaths = [],
  timeoutMs = 2_000,
  watchFactory = watchNative,
} = {}) {
  const markerDir = path.join(root, ".state", "readiness-fences")
  await mkdir(markerDir, { recursive: true, mode: 0o700 })

  const changes = new Map()
  const markers = new Map()
  let failureReason = null
  let sequence = 0
  let closed = false
  let fenceWork = Promise.resolve()
  const ignoredRelativePaths = ignoredPaths
    .map((candidate) => path.relative(root, candidate).replaceAll("\\", "/"))
    .filter((candidate) => candidate && candidate !== "." && !candidate.startsWith("../"))
  let baseline = scanWorkspace(root, ignoredRelativePaths)

  const watcher = watchFactory(root, { recursive: true, persistent: false }, (eventType, filename) => {
    if (filename === null || filename === undefined) {
      failureReason = "lost_history"
      return
    }
    const relative = normalizeRelativePath(filename)
    if (relative === null) {
      failureReason = "lost_history"
      return
    }
    const marker = markers.get(relative)
    if (marker) {
      marker()
      return
    }
    if (IGNORED_ROOTS.has(relative.split("/")[0]) ||
        ignoredRelativePaths.some((ignored) => relative === ignored || relative.startsWith(`${ignored}/`))) {
      return
    }
    changes.set(relative, {
      sequence: ++sequence,
    })
  })
  watcher.on?.("error", () => {
    failureReason = "watcher_failed"
  })

  async function runFence({ recordChange, signal } = {}) {
    signal?.throwIfAborted()
    if (closed || failureReason !== null) {
      return { certain: false, reason: failureReason ?? "watcher_closed" }
    }

    const markerName = `${randomUUID()}.fence`
    const markerRelative = `.state/readiness-fences/${markerName}`
    const markerPath = path.join(markerDir, markerName)
    let resolveMarker
    let rejectMarker
    const observed = new Promise((resolve, reject) => {
      resolveMarker = resolve
      rejectMarker = reject
    })
    markers.set(markerRelative, resolveMarker)

    const abort = () => rejectMarker(signal.reason)
    signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => rejectMarker(Object.assign(
      new Error("workspace watcher fence timed out"),
      { code: "clock_uncertain" },
    )), timeoutMs)

    try {
      await writeFile(markerPath, markerName, { encoding: "utf8", mode: 0o600 })
      await observed
      await new Promise((resolve) => setImmediate(resolve))
      signal?.throwIfAborted()
      if (failureReason !== null) return { certain: false, reason: failureReason }
    } catch (error) {
      signal?.throwIfAborted()
      failureReason = error.code === "clock_uncertain" ? "clock_uncertain" : "watcher_failed"
      return { certain: false, reason: failureReason }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      markers.delete(markerRelative)
      await unlink(markerPath).catch((error) => {
        if (error.code !== "ENOENT") failureReason = "watcher_failed"
      })
    }
    if (failureReason !== null) return { certain: false, reason: failureReason }

    let current
    try {
      current = scanWorkspace(root, ignoredRelativePaths)
    } catch {
      failureReason = "watcher_failed"
      return { certain: false, reason: failureReason }
    }
    const captured = new Map(changes)
    const changedPaths = new Set([...baseline.keys(), ...current.keys()])
    for (const changedPath of [...changedPaths].sort()) {
      const before = baseline.get(changedPath)
      const after = current.get(changedPath)
      if (before === after) continue
      await recordChange({
        path: changedPath,
        operation: after === undefined ? "delete" : "write",
        observedAt: new Date().toISOString(),
      })
    }
    baseline = current
    for (const [changedPath, change] of captured) {
      if (changes.get(changedPath)?.sequence === change.sequence) changes.delete(changedPath)
    }
    return { certain: true }
  }

  return {
    fence(request) {
      const result = fenceWork.then(() => runFence(request))
      fenceWork = result.catch(() => {})
      return result
    },
    close() {
      closed = true
      watcher.close()
    },
  }
}

function normalizeRelativePath(filename) {
  const value = Buffer.isBuffer(filename) ? filename.toString("utf8") : String(filename)
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "")
  if (!normalized || path.posix.isAbsolute(normalized) ||
      normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    return null
  }
  return normalized
}

function scanWorkspace(root, ignoredRelativePaths) {
  const files = new Map()
  walk(root, "")
  return files

  function walk(directory, relativeDirectory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (IGNORED_ROOTS.has(relative.split("/")[0]) ||
          ignoredRelativePaths.some((ignored) => relative === ignored || relative.startsWith(`${ignored}/`))) {
        continue
      }
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(absolute, relative)
        continue
      }
      if (!entry.isFile()) continue
      const stat = lstatSync(absolute, { bigint: true })
      files.set(relative, [
        stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs,
      ].join(":"))
    }
  }
}
