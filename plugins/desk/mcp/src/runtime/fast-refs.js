// Reads a checkout's branch, upstream and the commits both point at straight from `.git`, without starting Git. Each Git
// process costs tens of milliseconds on a quiet machine and seconds when the machine is loaded, so the pull path asks Git
// only what it cannot read from a file. Anything unusual (a detached HEAD, a branch with no upstream, an unreadable file)
// answers null and the caller asks Git instead.

import { readFileSync, statSync } from "node:fs"
import * as path from "node:path"

const SHA = /^[0-9a-f]{40,64}$/u

function readText(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

// The directory holding this checkout's HEAD, and the one holding refs and config (the same unless this is a linked worktree).
function gitDirs(root) {
  const dot = path.join(root, ".git")
  const stats = statSync(dot, { throwIfNoEntry: false })
  if (stats === undefined) return null
  if (stats.isDirectory()) return { gitDir: dot, commonDir: dot }
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readText(dot))
  if (pointer === null) return null
  const gitDir = path.resolve(root, pointer[1])
  const common = readText(path.join(gitDir, "commondir")).trim()
  return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir }
}

function branchSettings(config, branch) {
  const header = `[branch "${branch}"]`
  const settings = {}
  let inside = false
  for (const raw of config.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.startsWith("[")) inside = line.toLowerCase() === header.toLowerCase()
    else if (inside) {
      const match = /^(remote|merge)\s*=\s*(.+)$/iu.exec(line)
      if (match !== null) settings[match[1].toLowerCase()] = match[2].trim()
    }
  }
  return settings
}

function refValue(commonDir, ref) {
  const loose = readText(path.join(commonDir, ref)).trim()
  if (SHA.test(loose)) return loose
  for (const line of (readText(path.join(commonDir, "packed-refs"))).split(/\r?\n/u)) {
    const [sha, name] = line.split(" ")
    if (name === ref && SHA.test(sha)) return sha
  }
  return null
}

/**
 * `{ branch, remote, merge, tracking, head, target }` for the checked-out branch and the remote-tracking ref it follows, or
 * null when this is not a plain branch with a plain upstream Git can be left out of.
 */
export function readUpstreamRefs(root) {
  const dirs = gitDirs(root)
  if (dirs === null) return null
  const branch = /^ref: refs\/heads\/(.+?)\s*$/u.exec(readText(path.join(dirs.gitDir, "HEAD")))?.[1]
  const config = readText(path.join(dirs.commonDir, "config"))
  if (branch === undefined || config === "") return null
  const { remote, merge } = branchSettings(config, branch)
  if (remote === undefined || remote === "." || merge === undefined || !merge.startsWith("refs/heads/")) return null
  const tracking = `refs/remotes/${remote}/${merge.slice("refs/heads/".length)}`
  const head = refValue(dirs.commonDir, `refs/heads/${branch}`)
  const target = refValue(dirs.commonDir, tracking)
  return head === null || target === null ? null : { branch, remote, merge, tracking, head, target }
}
