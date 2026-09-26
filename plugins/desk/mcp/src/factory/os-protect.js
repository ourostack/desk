// The shared path-protection primitives behind both of this machine's
// private state roots: `src/protected/store.js` (the SQLite-backed feedback
// and work-ledger stores) and `factory/outbox.js` (the flat JSON-file
// factory outbox). There is exactly one implementation of "owner-only,
// never inside a Git checkout, never through a symlink or a hard link, no
// surviving macOS extended ACL" on this machine; `store.js` delegates its
// directory-chain and leaf-file guards to the functions here instead of
// keeping its own copy.
//
// Every function takes a `naming` object (`{ label, subject }`) exactly as
// `store.js` already did, so a caller's error text is unchanged by moving
// the implementation here: `label` prefixes the message and `subject` names
// the thing inside it, both module-internal constants of the caller, never
// tool input.
//
// Filesystem calls go through `fs.promises` and `node:child_process`'s
// default import, called as `fsp.mkdir(...)` / `childProcess.execFileSync(
// ...)` (property access), not a named import bound to a local identifier:
// `store.js`'s existing tests mock exactly these properties
// (`t.mock.method(fs, "mkdir", ...)`, `t.mock.method(childProcess,
// "execFileSync", ...)`) to simulate a racing creator, a creation failure
// and a failed or ACL-retaining native provider, and a named-import binding
// does not reliably observe that kind of mutation. Property access keeps
// this module a genuine drop-in for what was inline in `store.js`.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files; this module needs `node:child_process`, `node:fs` and `node:path`
// only.

import childProcess from "node:child_process"
import { promises as fsp } from "node:fs"
import * as path from "node:path"

const OWNER_DIR_MODE = 0o700
const OWNER_FILE_MODE = 0o600

/** `~` and `~/...` expansion, the same convention `src/util/paths.js` uses. */
export function expandHome(value, homeDir) {
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2))
  if (value === "~") return homeDir
  return value
}

/** `lstat`, or `null` when the path is absent; any other failure (including `EACCES`) is a thrown, labeled error — a permission problem must never read as "not there". */
export async function lstatIfPresent(target, naming) {
  const { label, subject } = naming
  try {
    return await fsp.lstat(target)
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw new Error(`${label}: private ${subject} path ${target} could not be inspected (${error.code})`)
  }
}

/** Refuses when `dir` itself contains a `.git` entry. */
export async function assertNotGitCheckout(dir, naming) {
  const { label, subject } = naming
  if ((await lstatIfPresent(path.join(dir, ".git"), naming)) !== null) {
    throw new Error(
      `${label}: refusing to write private ${subject} inside the Git checkout at ${dir}. ` +
        "Point XDG_STATE_HOME at a directory that is not under version control.",
    )
  }
}

/** Walks from `startDir` up to the filesystem root, refusing a `.git` at any ancestor. */
export async function assertOutsideGitWorkspace(startDir, naming) {
  let cursor = startDir
  while (true) {
    await assertNotGitCheckout(cursor, naming)
    const parent = path.dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
}

/**
 * The deepest already-existing ancestor of `target`, resolved with
 * `realpath` (so a symlinked ancestor is caught before anything is
 * created), plus the remaining path segments that don't exist yet. Running
 * the Git-checkout walk on this before any directory is created means a
 * refused call never leaves new folders behind (unlike creating the whole
 * chain first and refusing afterward).
 */
export async function realpathExistingPrefix(target) {
  let cursor = target
  const remainder = []
  while (true) {
    try {
      return { real: await fsp.realpath(cursor), remainder }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      remainder.unshift(path.basename(cursor))
      cursor = parent
    }
  }
}

/** macOS ACL grants can survive `chmod 0700`/`0600`; a no-op on every other platform. */
export function clearExtendedAcl(target, platform, naming) {
  if (platform !== "darwin") return
  const { label, subject } = naming
  const options = { encoding: "utf8", timeout: 5000, maxBuffer: 65536 }
  childProcess.execFileSync("/bin/chmod", ["-N", target], options)
  const listing = childProcess.execFileSync("/bin/ls", ["-ldeq", target], options)
  if (/^\s*\d+:/mu.test(listing)) {
    throw new Error(`${label}: private ${subject} path retains an extended ACL: ${target}`)
  }
}

/**
 * Creates (if needed) and verifies one owner-only directory: refuses a
 * symlink or a non-directory, repairs a drifted mode, and clears a macOS
 * extended ACL (skipped on Windows, whose protection is a separate ACL
 * step). Returns whether this call created it.
 */
export async function ensureOwnerOnlyDirectory(dir, platform, naming) {
  const { label, subject } = naming
  let existing = await lstatIfPresent(dir, naming)
  let created = false
  if (existing === null) {
    try {
      await fsp.mkdir(dir, { mode: OWNER_DIR_MODE })
      created = true
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    existing = await fsp.lstat(dir)
  }
  if (existing.isSymbolicLink()) {
    throw new Error(`${label}: private ${subject} path component is a symlink and will not be used: ${dir}`)
  }
  if (!existing.isDirectory()) {
    throw new Error(`${label}: private ${subject} path component is not a directory: ${dir}`)
  }
  if (platform !== "win32") {
    clearExtendedAcl(dir, platform, naming)
    if ((existing.mode & 0o777) !== OWNER_DIR_MODE) {
      await fsp.chmod(dir, OWNER_DIR_MODE)
    }
  }
  return created
}

/**
 * Verifies an already-written leaf file: refuses a symlink, refuses a hard
 * link (`nlink !== 1`), refuses a non-regular file, repairs a drifted mode
 * and clears a macOS extended ACL (skipped on Windows).
 */
export async function protectLeafFile(file, platform, naming) {
  const { label, subject } = naming
  const stat = await fsp.lstat(file)
  if (stat.isSymbolicLink()) {
    throw new Error(`${label}: private ${subject} path is a symlink and will not be used: ${file}`)
  }
  if (!stat.isFile()) {
    throw new Error(`${label}: private ${subject} path is not a regular file: ${file}`)
  }
  if (stat.nlink !== 1) {
    throw new Error(`${label}: private ${subject} is hard-linked and will not be used: ${file}`)
  }
  if (platform !== "win32") {
    clearExtendedAcl(file, platform, naming)
    if ((stat.mode & 0o777) !== OWNER_FILE_MODE) {
      await fsp.chmod(file, OWNER_FILE_MODE)
    }
  }
}
