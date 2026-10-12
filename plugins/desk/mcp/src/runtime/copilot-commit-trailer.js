// Copilot CLI tells its agent to end every commit with a `Co-authored-by: Copilot` trailer unless the user setting
// `includeCoAuthoredBy` is false (`copilot help config`). Desk's foundation forbids AI attribution, so Desk's Copilot session start
// turns the setting off once, in the operator's own Copilot settings file, and never again: an explicit value, on or off, is the
// operator's and is left alone.
//
// Copilot builds a session's instructions before the hook runs, so the change applies from the next session; the line says so.
// Nothing here throws: a session must start whatever state the settings file is in.

import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"

const KEY = "includeCoAuthoredBy"

function isFolder(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null)

/**
 * `{ state, line }`. `state` is `set`, `already` (off), `kept` (the operator gave it a value), `unreadable` (the file is not a plain
 * JSON object and was left alone), `changed` (the file changed while this ran, so nothing was written; the next session tries again),
 * `failed` (it could not be written) or `no_copilot_home`. `line` is one sentence for the session, or "" when there is nothing to say.
 * `recheck` reads the file again just before it is replaced; tests pass their own.
 */
export function disableCoAuthorTrailer({ env = process.env, home = env.HOME || env.USERPROFILE || homedir(), recheck = readText } = {}) {
  const folder = env.COPILOT_HOME || path.join(home, ".copilot")
  if (!isFolder(folder)) return { state: "no_copilot_home", line: "" }
  const file = path.join(folder, "settings.json")
  const unreadable = { state: "unreadable", line: `Desk startup: could not read ${file}, so Copilot's commit trailer setting is unchanged; run \`copilot config ${KEY} false\` once.` }

  let original
  let settings = {}
  // A settings file kept as a symlink (a dotfiles folder, for example) is edited where it really lives, so the link stays.
  let target = file
  try {
    original = readText(file)
    if (original !== null) {
      settings = JSON.parse(original)
      target = realpathSync(file)
    }
  } catch {
    return unreadable
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return unreadable
  if (settings[KEY] === false) return { state: "already", line: "" }
  if (settings[KEY] !== undefined) return { state: "kept", line: "" }

  // Written beside the file and renamed over it, so Copilot never reads half a file.
  const temporary = `${target}.desk-${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...settings, [KEY]: false }, null, 2)}\n`, { mode: 0o600 })
    // Copilot may have written the file since it was read; then leave it alone.
    if (recheck(file) !== original) return { state: "changed", line: "" }
    renameSync(temporary, target)
  } catch {
    return { state: "failed", line: "" }
  } finally {
    rmSync(temporary, { force: true })
  }
  return { state: "set", line: `Desk startup: set \`${KEY}: false\` in ${file}, so Copilot stops asking for an AI co-author trailer on commits from the next session; add none in this session either.` }
}
