import { existsSync } from "node:fs"
import * as path from "node:path"

const WIN = path.win32

// `bash.exe` in System32 or WindowsApps is the WSL relay. With no distro installed it starts, prints "execvpe(/bin/bash) failed" and
// exits 1, so a script run through it fails without ever running.
function isWslRelay(file) {
  return /\\(?:windows\\(?:system32|sysnative)|windowsapps)\\/iu.test(file)
}

/**
 * resolveBash({ platform, env, exists }) -> string
 *
 * The bash to run Desk's scripts with. Off Windows, `bash` from PATH. On Windows, Git for Windows' bash first (next to the `git` on
 * PATH, then the usual install folders, which are the standard `Program Files` folders when the environment names none), then any other `bash.exe` on PATH that is not the WSL relay. When none exists it returns
 * `null`, never plain `bash`, because plain `bash` there is the relay. A Git for Windows in a custom folder is found only when its
 * `git.exe` is on PATH (there is no registry lookup).
 */
export function resolveBash({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== "win32") return "bash"
  const dirs = (env.PATH ?? env.Path ?? "").split(";").filter((dir) => dir !== "")
  const git = []
  const other = []
  for (const dir of dirs) {
    if (exists(WIN.join(dir, "git.exe"))) git.push(WIN.join(dir, "..", "bin", "bash.exe"), WIN.join(dir, "..", "usr", "bin", "bash.exe"))
    const candidate = WIN.join(dir, "bash.exe")
    if (!isWslRelay(candidate)) other.push(candidate)
  }
  const roots = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA && WIN.join(env.LOCALAPPDATA, "Programs")].filter(Boolean)
  // A host that starts Desk with a minimal environment may pass none of these variables; the standard folders then stand in.
  const drive = env.SystemDrive ?? "C:"
  roots.push(WIN.join(`${drive}\\`, "Program Files"), WIN.join(`${drive}\\`, "Program Files (x86)"))
  const installed = roots.map((root) => WIN.join(root, "Git", "bin", "bash.exe"))
  return [...git, ...installed, ...other].find((candidate) => exists(candidate)) ?? null
}
