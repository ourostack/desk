import path from "node:path"
import { realpathSync } from "node:fs"

// Git for Windows reports every path with forward slashes (`C:/Users/me/repo`), while the desk, a receipt written from the owner's own paths and `fs` use backslashes, a different drive-letter case or an 8.3 short name (`RUNNER~1`) for the same folder. A path read from Git is turned into the platform's own spelling first, and two paths are the same folder when they match after that, ignoring case on Windows, or after the file system expands both. Off Windows every spelling is exact, as before.
export const nativeGitPath = (value, platform = process.platform) => platform === "win32" && typeof value === "string" ? path.win32.normalize(value) : value
const expandNative = (value) => { try { return realpathSync.native(value) } catch { return value } }
export const foldPath = (value, platform = process.platform) => platform === "win32" ? path.win32.normalize(value).toLowerCase() : value
export const samePath = (a, b, platform = process.platform, expand = expandNative) =>
  foldPath(a, platform) === foldPath(b, platform) || (platform === "win32" && foldPath(expand(a), platform) === foldPath(expand(b), platform))
export const insidePath = (root, target, platform = process.platform, expand = expandNative) => {
  const sep = platform === "win32" ? "\\" : "/"
  const within = (r, t) => t === r || t.startsWith(`${r}${sep}`)
  return within(foldPath(root, platform), foldPath(target, platform)) || (platform === "win32" && within(foldPath(expand(root), platform), foldPath(expand(target), platform)))
}
