import path from "node:path"

// Git for Windows reports every path with forward slashes (`C:/Users/me/repo`), while the desk, a receipt written from the owner's own paths and `fs` use backslashes and may differ in drive-letter or folder case for the same folder. A path read from Git is turned into the platform's own spelling first, and two paths are the same folder when they match after that, ignoring case on Windows. Only the spelling is compared: a symlink or junction alias is a different path, and the callers that need the real path check that themselves. Off Windows every spelling is exact, as before.
export const nativeGitPath = (value, platform = process.platform) => platform === "win32" && typeof value === "string" ? path.win32.normalize(value) : value
export const foldPath = (value, platform = process.platform) => platform === "win32" ? path.win32.normalize(value).toLowerCase() : value
export const samePath = (a, b, platform = process.platform) => foldPath(a, platform) === foldPath(b, platform)
export const insidePath = (root, target, platform = process.platform) => {
  const sep = platform === "win32" ? "\\" : "/"
  const folded = foldPath(root, platform)
  const candidate = foldPath(target, platform)
  return candidate === folded || candidate.startsWith(`${folded}${sep}`)
}
