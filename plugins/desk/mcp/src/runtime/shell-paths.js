import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import * as path from "node:path"
import { UNKNOWN } from "./guard-unknowns.js"

// A directory `mktemp -d` would create. It does not exist while the command is inspected, so
// it stands for a new, empty child of an existing parent; Git run there finds the parent's repository.
export const MKTEMP_PREFIX = ".desk-guard-mktemp-"

function resolveExisting(target) {
  try {
    const resolved = realpathSync.native(target)
    return statSync(resolved).isDirectory() ? resolved : null
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return null
    throw error
  }
}

// path.resolve/join collapse ".." before the OS traverses symlinks. Git -C and
// physical cd instead perform one real chdir at a time. An unknown operand, or a
// relative one from an unknown directory, gives an unknown directory.
export function physicalDirectory(cwd, operand) {
  if (operand.includes("\0") || (!path.isAbsolute(operand) && cwd.includes("\0"))) return UNKNOWN
  const target = path.isAbsolute(operand) ? operand : `${cwd}${path.sep}${operand}`
  const resolved = resolveExisting(target)
  if (resolved !== null) return resolved
  const lexical = path.resolve(target)
  if (!path.basename(lexical).startsWith(MKTEMP_PREFIX)) return null
  const parent = resolveExisting(path.dirname(lexical))
  return parent && path.join(parent, path.basename(lexical))
}

/** The directory Git would inspect for `dir`: itself, or the parent of a pending mktemp directory. */
export function existingDirectory(dir) {
  return path.basename(dir).startsWith(MKTEMP_PREFIX) ? path.dirname(dir) : dir
}

/** Where `mktemp [-d] [-p dir | --tmpdir[=dir] | -t] [template]` would create its file. */
export function mktempPath(args, cwd, vars, serial) {
  let parent = null, template = null, temporary = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-p") parent = args[++i] ?? ""
    else if (arg.startsWith("--tmpdir=")) parent = arg.slice(9)
    else if (arg === "-t" || arg === "--tmpdir") temporary = true
    else if (!arg.startsWith("-")) template = arg
  }
  const base = vars.TMPDIR || "/tmp"
  if (parent === null) parent = template?.includes("/") ? path.dirname(template) : template && !temporary ? "." : base
  const dir = physicalDirectory(cwd, parent || base)
  return dir && `${dir}${path.sep}${MKTEMP_PREFIX}${serial}`
}

/** The top level of the Git checkout containing `dir` (the nearest ancestor with a .git entry), or unknown. */
export function gitToplevel(dir) {
  if (dir.includes(UNKNOWN)) return UNKNOWN
  for (let current = dir; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) return current
    if (path.dirname(current) === current) return UNKNOWN
  }
}

// The branch HEAD names in the checkout containing `dir`, read from its HEAD file without running Git.
function currentBranch(dir, abbreviated) {
  const top = gitToplevel(dir)
  if (top === UNKNOWN) return UNKNOWN
  let gitDir = path.join(top, ".git")
  try {
    if (statSync(gitDir).isFile()) gitDir = path.resolve(top, /^gitdir: (.+)$/mu.exec(readFileSync(gitDir, "utf8"))[1].trim())
    const head = /^ref: refs\/heads\/(.+)$/u.exec(readFileSync(path.join(gitDir, "HEAD"), "utf8").trim())
    return head ? head[1] : abbreviated ? "HEAD" : ""
  } catch {
    return UNKNOWN
  }
}

/**
 * The output of a read-only Git command Desk can answer from the file system: `git rev-parse --show-toplevel`,
 * `git branch --show-current` and `git rev-parse --abbrev-ref HEAD`. null for any other command, and unknown
 * when a Git location variable is set.
 */
export function staticGitOutput(words, cwd, env) {
  const text = words.join(" ")
  const known = ["git rev-parse --show-toplevel", "git branch --show-current", "git rev-parse --abbrev-ref HEAD"]
  if (!known.includes(text)) return null
  if (Object.keys(env).some((key) => /^GIT_(?:DIR|WORK_TREE)$/iu.test(key))) return UNKNOWN
  return text === known[0] ? gitToplevel(cwd) : currentBranch(cwd, text === known[2])
}
