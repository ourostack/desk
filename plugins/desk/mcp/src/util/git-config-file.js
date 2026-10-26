// A clone's remotes read straight from its Git config file, with no `git` process. Boot asks this for every repo of
// every open task, and on a busy machine each `git` spawn costs 40 to 80 ms, so 70 repos cost 3 to 6 s of boot.
// The answer is only a fast path: `null` means "could not tell from the file" (no `.git` at that folder, an unreadable
// file, an `[include]`), and the caller asks git itself.

import { readFileSync, statSync } from "node:fs"
import * as path from "node:path"

const MAX_CONFIG_BYTES = 256 * 1024

function readSmall(file) {
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) return null
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

/** The config file of the clone whose top folder is `dir` (a plain clone or a linked worktree), or null. */
function configPath(dir) {
  const dotGit = path.join(dir, ".git")
  let info
  try {
    info = statSync(dotGit)
  } catch {
    return null
  }
  if (info.isDirectory()) return path.join(dotGit, "config")
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readSmall(dotGit) ?? "")
  if (pointer === null) return null
  const gitDir = path.resolve(dir, pointer[1])
  const common = readSmall(path.join(gitDir, "commondir"))?.trim()
  return path.join(common ? path.resolve(gitDir, common) : gitDir, "config")
}

/** A config value as git reads it: quotes removed, escapes applied, a `#` or `;` comment outside quotes cut off; null for a value this reader does not follow (an open quote or a continued line). */
function configValue(raw) {
  let out = ""
  let quoted = false
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === "#" || char === ";")) break
    else if (char === "\\") {
      index += 1
      if (index === raw.length) return null
      const next = raw[index]
      out += next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next
    } else out += char
  }
  return quoted ? null : out.trim()
}

/**
 * `{ remotes: { <name>: <url or null> } }` from the clone's config file, or null when the file cannot answer for git
 * (no clone at `dir`, unreadable, an `[include]` that could add remotes, the old `[remote.origin]` section form, or a
 * url value this reader does not follow).
 */
export function readRemotes(dir) {
  const file = typeof dir === "string" && dir !== "" ? configPath(dir) : null
  const text = file === null ? null : readSmall(file)
  if (text === null) return null
  const remotes = {}
  let current = null
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/u.exec(line)
    if (section !== null) {
      const name = section[1].toLowerCase()
      if (name === "include" || name === "includeif" || name.startsWith("remote.")) return null
      current = name === "remote" && section[2] !== undefined ? section[2] : null
      if (current !== null && !(current in remotes)) remotes[current] = null
      continue
    }
    if (current === null) continue
    const url = /^url\s*=(.*)$/iu.exec(line)
    if (url === null) continue
    const value = configValue(url[1])
    if (value === null) return null
    remotes[current] = value
  }
  return { remotes }
}
