import { realpathSync, statSync } from "node:fs"
import * as path from "node:path"

// path.resolve/join collapse ".." before the OS traverses symlinks. Git -C and
// physical cd instead perform one real chdir at a time.
export function physicalDirectory(cwd, operand) {
  if (operand.includes("\0")) throw new Error("unresolved shell directory")
  const target = path.isAbsolute(operand) ? operand : `${cwd}${path.sep}${operand}`
  try {
    const resolved = realpathSync.native(target)
    return statSync(resolved).isDirectory() ? resolved : null
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return null
    throw error
  }
}
