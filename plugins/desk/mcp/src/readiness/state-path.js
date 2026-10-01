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
// everyone unless it is sticky (a shared temp folder). Otherwise another local user could swap what we create under it.
// Group-writable is allowed: a user-private group (umask 002) is a common, harmless layout, and refusing it would cost
// that user the search index. Not checked on Windows, which has no such modes. The refusal names the directory and the
// command that fixes it, so the degraded search note that carries it is actionable.
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
    if (realStat.uid !== uid && realStat.uid !== 0) {
      throw new Error(`${UNSAFE}: ${real} is owned by another user (uid ${realStat.uid}). Desk keeps its state under it, so it must belong to you or root: run \`sudo chown "$USER" "${real}"\`, or point XDG_STATE_HOME at a directory you own.`)
    }
    if ((realStat.mode & 0o002) !== 0 && (realStat.mode & 0o1000) === 0) {
      throw new Error(`${UNSAFE}: ${real} is writable by everyone, so another user could replace what Desk keeps under it. Run \`chmod o-w "${real}"\` (or \`chmod +t "${real}"\` if it is a shared folder), then retry.`)
    }
  }
  return path.join(real, ...missing)
}
