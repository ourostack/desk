import * as filesystem from "node:fs"
import * as path from "node:path"

const UNSAFE = "journal has unsafe state directory ancestry"

// The state directory itself must be a real directory the controller made, never a link someone placed there. A link
// *above* it is the user's own layout (a home under /home -> /export/home, ~/.cache moved to another disk, a temp folder
// under macOS's /var -> /private/var), so the existing ancestors are resolved to their real path and the journal lives
// under that. The journal's own ancestry check then sees only real directories. A real user with such a layout used to
// lose the search index to "unsafe state directory ancestry" (boot acceptance round 6).
//
// What contains the state directory must also be trusted: after resolving, the deepest existing directory on the path
// (the state directory's parent when it exists) has to belong to the current user or root, and must not be writable by
// group or others unless it is sticky (a shared temp folder). Otherwise another local user could swap what we create
// under it. Not checked on Windows, which has no such modes.
export function resolveStateDirectory(stateDir, io = filesystem, platform = process.platform, uid = process.getuid?.()) {
  stateDir = path.resolve(stateDir)
  const present = (file) => {
    try { return io.lstatSync(file) } catch (error) {
      if (error.code === "ENOENT") return null
      if (error.code === "ENOTDIR") throw new Error(UNSAFE)
      throw error
    }
  }
  const own = present(stateDir)
  if (own && (!own.isDirectory() || own.isSymbolicLink())) throw new Error(UNSAFE)
  const missing = [path.basename(stateDir)]
  let ancestor = path.dirname(stateDir)
  while (!present(ancestor)) {
    missing.unshift(path.basename(ancestor))
    ancestor = path.dirname(ancestor)
  }
  let real
  try {
    real = io.realpathSync(ancestor)
  } catch {
    throw new Error(UNSAFE)
  }
  const realStat = io.lstatSync(real)
  if (!realStat.isDirectory()) throw new Error(UNSAFE)
  if (platform !== "win32" && uid != null) {
    const trustedOwner = realStat.uid === uid || realStat.uid === 0
    const writableByOthers = (realStat.mode & 0o022) !== 0 && (realStat.mode & 0o1000) === 0
    if (!trustedOwner || writableByOthers) throw new Error(`${UNSAFE}: ${real} must be owned by the current user or root and not writable by group or others`)
  }
  return path.join(real, ...missing)
}
