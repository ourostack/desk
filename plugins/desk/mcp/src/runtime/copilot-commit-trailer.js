// Copilot CLI tells its agent to end every commit with a `Co-authored-by: Copilot` trailer unless the user setting
// `includeCoAuthoredBy` is false (`copilot help config`). Desk's foundation forbids AI attribution, so Desk's Copilot session start
// turns the setting off once, in the operator's own Copilot settings file, and never again: an explicit value, on or off, is the
// operator's and is left alone.
// The question form (`askUser`) is handled the same way: Desk's worker asks in plain chat, as Claude's worker does with
// AskUserQuestion disallowed, so Desk turns the form off once when the operator has not chosen.
// Native memory is different: Desk owns durable context, so every Desk startup forces memory off, including an explicit true.
//
// Copilot builds a session's instructions before the hook runs, so the change applies from the next session; the line says so.
// Nothing here throws: a session must start whatever state the settings file is in.

import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"

function isFolder(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

// Copilot reads its settings with comments and trailing commas allowed. This reads such a file only to see whether the setting has a
// value; a file plain JSON cannot parse is never rewritten, because that would drop the operator's comments.
function withoutComments(text) {
  let out = ""
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === "\\") out += text[(index += 1)] ?? ""
      else if (char === '"') inString = false
    } else if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index)
      index = end === -1 ? text.length : end - 1
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2)
      index = end === -1 ? text.length : end + 1
    } else {
      out += char
      inString = char === '"'
    }
  }
  return out.replace(/,(\s*[}\]])/gu, "$1")
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null)

/**
 * `{ state, line }`. `state` is `set`, `already` (off), `kept` (the operator gave it a value), `unreadable` (the file is not a JSON
 * object and was left alone), `not_plain_json` (it has comments or trailing commas and no value for the setting, and was left alone), `changed` (the file changed while this ran, so nothing was written; the next session tries again),
 * `failed` (it could not be written) or `no_copilot_home`. `line` is one sentence for the session, or "" when there is nothing to say:
 * Trailer repair stays quiet on a concurrent change; mandatory memory repair reports every unsuccessful state.
 * `recheck` reads the file again just before it is replaced; tests pass their own.
 */
export function disableCoAuthorTrailer(options) {
  return disableCopilotSetting(options, SETTINGS.trailer)
}

export function disableNativeMemory(options) {
  return disableCopilotSetting(options, SETTINGS.memory)
}

export function disableAskUser(options) {
  return disableCopilotSetting(options, SETTINGS.askUser)
}

const SETTINGS = {
  trailer: { key: "includeCoAuthoredBy", subject: "commit trailer", sessionRule: "add no AI co-author trailer to commits in this session", effect: "Copilot stops asking for an AI co-author trailer on commits", setRule: "add none in this session either", stillOn: "Copilot still asks for an AI co-author trailer on commits" },
  askUser: { key: "askUser", subject: "question form", sessionRule: "ask in plain chat, never with ask_user", effect: "the ask_user form is off", stillOn: "the ask_user form stays on" },
  memory: { key: "memory", memory: true, subject: "native memory", sessionRule: "do not use native memory tools; keep durable context in the Git-backed desk" },
}

function disableCopilotSetting({ env = process.env, home = env.HOME || env.USERPROFILE || homedir(), recheck = readText } = {}, setting) {
  const { key: KEY, memory = false, subject, sessionRule } = setting
  const repair = `run \`copilot config ${KEY} false\` once, and ${sessionRule}.`
  const folder = env.COPILOT_HOME || path.join(home, ".copilot")
  if (!isFolder(folder)) return { state: "no_copilot_home", line: memory ? `Desk memory: no Copilot settings folder was found, so native memory could not be disabled; ${repair}` : "" }
  const file = path.join(folder, "settings.json")
  const unreadable = { state: "unreadable", line: `${memory ? "Desk memory" : "Desk startup"}: could not read ${file} as a JSON object, so Copilot's ${subject} setting is unchanged; ${repair}` }

  let original
  let settings = {}
  // A settings file kept as a symlink (a dotfiles folder, for example) is edited where it really lives, so the link stays.
  let target = file
  try {
    original = readText(file)
    // An empty file is a settings file with nothing set, as Copilot reads it.
    if (original !== null && original.trim() !== "") settings = JSON.parse(original)
    if (original !== null) target = realpathSync(file)
  } catch {
    let relaxed
    try {
      relaxed = JSON.parse(withoutComments(original.replace(/^\uFEFF/u, "")))
    } catch {
      return unreadable
    }
    if (!isObject(relaxed)) return unreadable
    if (relaxed[KEY] === false) return { state: "already", line: "" }
    if (relaxed[KEY] !== undefined && !memory) return { state: "kept", line: "" }
    return { state: "not_plain_json", line: memory ?
      `Desk memory: ${file} has comments or trailing commas, so native memory could not be disabled without changing them; ${repair}` :
      `Desk startup: ${file} has comments or trailing commas, so Desk did not rewrite it; add \`"${KEY}": false\` to it once so ${setting.effect}, and ${sessionRule}.` }
  }
  if (!isObject(settings)) return unreadable
  if (settings[KEY] === false) return { state: "already", line: "" }
  if (settings[KEY] !== undefined && !memory) return { state: "kept", line: "" }

  // Written beside the file and renamed over it, so Copilot never reads half a file.
  const temporary = `${target}.desk-${process.pid}.tmp`
  try {
    // The file keeps its own permissions; a new one is private, as Copilot writes it.
    const mode = original === null ? 0o600 : statSync(target).mode & 0o777
    writeFileSync(temporary, `${JSON.stringify({ ...settings, [KEY]: false }, null, 2)}\n`, { mode })
    chmodSync(temporary, mode)
    // Copilot may have written the file since it was read; then leave it alone.
    if (recheck(file) !== original) return { state: "changed", line: memory ? `Desk memory: ${file} changed during native memory repair; ${repair}` : "" }
    renameSync(temporary, target)
  } catch {
    return { state: "failed", line: memory ?
      `Desk memory: could not write ${file}, so native memory could not be disabled; ${repair}` :
      `Desk startup: could not write ${file}, so ${setting.stillOn}; ${repair}` }
  } finally {
    rmSync(temporary, { force: true })
  }
  return { state: "set", line: memory ?
    `Desk memory: set \`memory: false\` in ${file}; native memory is disabled in settings. Running sessions must not use native memory tools; durable context belongs in the Git-backed desk.` :
    `Desk startup: set \`${KEY}: false\` in ${file}, so ${setting.effect} from the next session; ${setting.setRule ?? sessionRule}.` }
}
