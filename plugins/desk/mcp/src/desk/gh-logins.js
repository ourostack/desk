// The GitHub logins this machine's `gh` is signed in as, read from gh's own
// hosts config. A track may not be named after the operator's GitHub login
// (controller ruling, 2026-09-25), and these logins are how Desk knows it.
//
// Local and bounded: no network call, `gh` is never started, and at most
// `MAX_HOSTS_BYTES` of `hosts.yml` is read. Only each host's `user:` value
// and the keys under its `users:` map are kept; token values are never
// returned or stored. A missing, unreadable or malformed file gives no
// logins. Dependency-free: the tidy's Detect runs this from the installed
// plugin, where no npm dependency is installed.

import { closeSync, openSync, readSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const MAX_HOSTS_BYTES = 64 * 1024

function hasText(value) {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * gh's config directory, resolved the way gh resolves it: `GH_CONFIG_DIR`,
 * else `$XDG_CONFIG_HOME/gh`, else `%AppData%\GitHub CLI` on Windows, else
 * `~/.config/gh`.
 */
export function ghConfigDir({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  if (hasText(env.GH_CONFIG_DIR)) return env.GH_CONFIG_DIR
  if (hasText(env.XDG_CONFIG_HOME)) return path.join(env.XDG_CONFIG_HOME, "gh")
  if (platform === "win32" && hasText(env.AppData)) return path.join(env.AppData, "GitHub CLI")
  return path.join(homeDir, ".config", "gh")
}

function scalar(text) {
  const value = text.replace(/\s+#.*$/, "").trim()
  const quoted = /^(["'])(.*)\1$/.exec(value)
  return quoted ? quoted[2] : value
}

/**
 * The logins in a `hosts.yml` text: each host's `user:` value and every key
 * under its `users:` map, in file order. Anything else, including every
 * token, is skipped.
 */
export function parseGhHostLogins(raw) {
  const logins = []
  let hostIndent = null
  let usersIndent = null
  let userKeyIndent = null
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const entry = /^([^:#]+):(?:\s+(.*))?$/.exec(trimmed)
    if (entry === null) continue
    const indent = line.length - line.trimStart().length
    const key = scalar(entry[1])
    if (indent === 0) {
      hostIndent = null
      usersIndent = null
      continue
    }
    if (hostIndent === null) hostIndent = indent
    if (indent <= hostIndent) {
      usersIndent = key === "users" ? indent : null
      userKeyIndent = null
      if (key === "user" && entry[2] !== undefined && scalar(entry[2]) !== "") logins.push(scalar(entry[2]))
      continue
    }
    if (usersIndent === null) continue
    userKeyIndent ??= indent
    if (indent === userKeyIndent) logins.push(key)
  }
  return logins
}

function readBounded(file) {
  let fd
  try {
    fd = openSync(file, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(MAX_HOSTS_BYTES)
    const bytesRead = readSync(fd, buffer, 0, MAX_HOSTS_BYTES, 0)
    return buffer.toString("utf8", 0, bytesRead)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** The GitHub logins in gh's hosts config, or [] when there is none. */
export function ghLogins({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  const raw = readBounded(path.join(ghConfigDir({ env, platform, homeDir }), "hosts.yml"))
  return raw === null ? [] : parseGhHostLogins(raw)
}
