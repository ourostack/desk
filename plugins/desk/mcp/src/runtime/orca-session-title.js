// Names an Orca terminal after the task its main agent just focused (desk#1478), so the phone's session list says what
// each session is doing. Claude Code's PostToolUse hook (hooks/lib/orca-session-title.cjs) hands in the finished
// task_focus or focused task_create call.
//
// Whose title it is decides everything. Orca's CLI has one setter, `terminal rename`, and it writes the same custom
// title a person types, so Desk keeps its own record of the titles it set on each terminal. Desk renames only when the
// terminal still shows one of those or an Orca default (an agent or shell name, a working-folder title, Claude Code's
// own status title); any other title is a person's and stays. The caller's terminal is the one Orca names in
// ORCA_TERMINAL_HANDLE, never "the active terminal". A subagent (its hook input carries `agent_id`), a headless
// `claude -p` child (CLAUDE_CODE_ENTRYPOINT `sdk-*`) and Desk's own child processes never rename.
// Where the installed Orca supports `--if-manual-title`, the rename lands only if the tab's manual name is still the
// one Desk saw (none, or Desk's own), which closes the gap between reading and writing; otherwise that gap (a person
// renaming in the same instant) is the known limit, and the readback after the rename reports it.
//
// Every outcome is one line in Desk's state folder, `orca-session-titles.log`; nothing is shown to the agent and
// nothing here can fail the tool call.

import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { startupChangesNothing } from "../factory/headless-flag.js"
import { isNoninteractive } from "../factory/session-kind.js"
import { makeSessionLabelProposal } from "./session-label.js"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

/** The longest title Desk sets, in user-perceived characters: about what Orca's phone list shows before it cuts a name. */
export const ORCA_TITLE_MAX = 32

const STATE_DIR = "orca-session-titles"
const LOG_FILE = "orca-session-titles.log"
const LOG_MAX_BYTES = 256 * 1024
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const KEEP_TITLES = 3
const ORCA_TIMEOUT_MS = 2500
const HANDLE = /^term_[\w-]+$/u
// The session-label rules check text alone; the task they also ask for plays no part in the answer.
const SAFETY_TASK = { track: "orca", slug: "title" }
// What Orca shows before anyone names a tab: the agent or shell running in it, Orca's own "Terminal N", the shell's
// working-folder title, or the status title Claude Code writes (a braille spinner frame or ✳, then its summary).
const DEFAULT_TITLES = new Set(["", "terminal", "claude", "claude code", "codex", "copilot", "gemini", "opencode", "ouro", "zsh", "-zsh", "bash", "-bash", "fish", "sh", "desk:worker"])
const AGENT_STATUS_TITLE = /^[⠀-⣿✳]\s/u
const FOLDER_TITLE = /^(?:[^\s@]+@[^\s:]+:)?[~/]/u

/** True for a title Orca, the shell or the agent CLI made up, which Desk may replace. */
export function isOrcaDefaultTitle(title, agentIdentity) {
  if (typeof title !== "string") return false
  const trimmed = title.trim()
  const text = trimmed.toLowerCase()
  return DEFAULT_TITLES.has(text) || /^terminal \d+$/u.test(text) || AGENT_STATUS_TITLE.test(trimmed) || FOLDER_TITLE.test(trimmed) ||
    (typeof agentIdentity === "string" && text === agentIdentity.trim().toLowerCase())
}

const graphemes = (text) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment)

/** `text` cut to ORCA_TITLE_MAX characters, at a word when one ends in the second half, ending in an ellipsis. */
export function shortTitle(text) {
  const parts = graphemes(text)
  if (parts.length <= ORCA_TITLE_MAX) return text
  const kept = parts.slice(0, ORCA_TITLE_MAX - 1)
  const space = kept.lastIndexOf(" ")
  const cut = (space >= ORCA_TITLE_MAX / 2 ? kept.slice(0, space) : kept).join("")
  return `${cut.replace(/[\s:;,.\-–—]+$/u, "")}…`
}

/**
 * The title for a finished focusing call: the agent's own `display_label` (the result's session_label proposal) when
 * it gave one, else the card's title. Either passes the session-label safety rules whole or not at all, so no path,
 * URL, address or credential reaches a tab. Returns `{ title }` or `{ code }`.
 */
export function orcaTitleFor({ toolName, toolInput, result }) {
  const authored = result?.session_label?.proposal?.text
  const candidate = typeof authored === "string" ? authored : toolName.endsWith("__task_create") ? toolInput?.title : result?.title
  if (typeof candidate !== "string" || candidate.trim() === "") return { code: "no_label" }
  const checked = makeSessionLabelProposal({ task: SAFETY_TASK, displayLabel: candidate.trim().replace(/ {2,}/gu, " ") })
  if (checked.proposal === undefined) return { code: "unsafe_label" }
  return { title: shortTitle(checked.proposal.text) }
}

function parseToolResult(response) {
  const content = Array.isArray(response) ? response : response?.content
  const text = Array.isArray(content) ? content.find((block) => block?.type === "text")?.text : undefined
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === "object" ? value : null
  } catch {
    return null
  }
}

function focusedNow(toolName, toolInput, result) {
  if (toolName.endsWith("__task_focus")) return result.status === "focused"
  return toolInput?.focus === true && result.focused === true
}

const isChild = (hookInput, env) => (typeof hookInput.agent_id === "string" && hookInput.agent_id !== "") || startupChangesNothing(env) || isNoninteractive(env)

/** Runs the Orca CLI Orca itself names (ORCA_CLI_COMMAND), else `orca` on PATH; answers `{ status, stdout }`, never throws. */
export function defaultRunOrca(env) {
  const command = env.ORCA_CLI_COMMAND || "orca"
  return (args) => new Promise((resolve) => {
    execFile(command, args, { timeout: ORCA_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout })
    })
  })
}

async function readTerminal(runOrca, handle) {
  try {
    const { status, stdout } = await runOrca(["terminal", "show", "--terminal", handle, "--json"])
    const terminal = status === 0 ? JSON.parse(stdout)?.result?.terminal : null
    return typeof terminal?.title === "string" ? terminal : null
  } catch {
    return null
  }
}

async function supportsConditionalRename(runOrca) {
  try {
    const { stdout } = await runOrca(["terminal", "rename", "--help"])
    return stdout.includes("--if-manual-title")
  } catch {
    return false
  }
}

// One small file per terminal, replaced whole, so sessions naming different terminals never write the same file.
const stateFile = (stateDir, handle) => path.join(stateDir, STATE_DIR, `${handle}.json`)

function readState(stateDir, handle) {
  try {
    const value = JSON.parse(readFileSync(stateFile(stateDir, handle), "utf8"))
    return {
      titles: Array.isArray(value?.titles) ? value.titles.filter((title) => typeof title === "string") : [],
      requested: typeof value?.requested === "string" ? value.requested : null,
    }
  } catch {
    return { titles: [], requested: null }
  }
}

function writeState(stateDir, handle, state, at) {
  try {
    assertNotRealStateUnderTest(stateDir)
    const dir = path.join(stateDir, STATE_DIR)
    mkdirSync(dir, { recursive: true })
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      if (at - statSync(file).mtimeMs > KEEP_MS) rmSync(file, { force: true })
    }
    const target = stateFile(stateDir, handle)
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ ...state, at })}\n`)
    renameSync(temporary, target)
    return true
  } catch {
    return false
  }
}

function logOutcome(stateDir, at, handle, code) {
  try {
    assertNotRealStateUnderTest(stateDir)
    mkdirSync(stateDir, { recursive: true })
    const file = path.join(stateDir, LOG_FILE)
    try {
      if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.old`)
    } catch {}
    appendFileSync(file, `${JSON.stringify({ at: new Date(at).toISOString(), terminal: handle ?? null, code })}\n`)
  } catch {}
}

/**
 * Names the caller's Orca terminal after the task a finished hook call focused. Returns `{ code, title? }`, where
 * `code` is `applied`, `unchanged`, `manual_title_kept`, `superseded`, `conditional_rename_refused`,
 * `readback_mismatch`, `rename_failed`, `orca_unavailable`, `not_in_orca`, `unsupported_platform`, `child_agent`,
 * `not_naming_tool`, `not_focused`, `no_result`, `no_label` or `unsafe_label`. Never throws.
 */
export async function nameOrcaSession({ hookInput, env = process.env, runOrca = defaultRunOrca(env), stateDir = resolveDeskStateDir({ env }), now = Date.now, platform = process.platform }) {
  const handle = typeof env.ORCA_TERMINAL_HANDLE === "string" && HANDLE.test(env.ORCA_TERMINAL_HANDLE) ? env.ORCA_TERMINAL_HANDLE : null
  const finish = (outcome) => {
    logOutcome(stateDir, now(), handle, outcome.code)
    return outcome
  }
  const toolName = typeof hookInput?.tool_name === "string" ? hookInput.tool_name : ""
  if (!/__task_(?:focus|create)$/u.test(toolName)) return finish({ code: "not_naming_tool" })
  if (handle === null) return finish({ code: "not_in_orca" })
  // Orca's Windows CLI is a .cmd shim, which execFile cannot start without a shell; quoting a label for cmd.exe is not worth the risk.
  if (platform === "win32") return finish({ code: "unsupported_platform" })
  if (isChild(hookInput, env)) return finish({ code: "child_agent" })
  const result = parseToolResult(hookInput.tool_response)
  if (result === null) return finish({ code: "no_result" })
  if (!focusedNow(toolName, hookInput.tool_input, result)) return finish({ code: "not_focused" })
  const label = orcaTitleFor({ toolName, toolInput: hookInput.tool_input, result })
  if (label.title === undefined) return finish(label)

  // Hooks run in the background and can overlap; the newest call claims the terminal, and an older one stands down.
  // A state folder Desk cannot write holds no claim, so the call goes ahead on what it read.
  const request = `${now()}-${randomBytes(6).toString("hex")}`
  const claimed = writeState(stateDir, handle, { ...readState(stateDir, handle), requested: request }, now())
  const [terminal, conditional] = await Promise.all([readTerminal(runOrca, handle), supportsConditionalRename(runOrca)])
  if (terminal === null) return finish({ code: "orca_unavailable" })
  if (terminal.title === label.title) return finish({ code: "unchanged" })
  const state = readState(stateDir, handle)
  const desks = state.titles.includes(terminal.title)
  const isDefault = !desks && isOrcaDefaultTitle(terminal.title, terminal.agentIdentity)
  if (!desks && !isDefault) return finish({ code: "manual_title_kept" })
  if (claimed && state.requested !== request) return finish({ code: "superseded" })

  // Recorded before the write, keeping the titles before it: a rename that times out or reads back late still leaves
  // the tab's title recognisably Desk's, so naming carries on next time instead of mistaking it for a person's.
  writeState(stateDir, handle, { titles: [label.title, ...state.titles.filter((title) => title !== label.title)].slice(0, KEEP_TITLES), requested: request }, now())
  const args = ["terminal", "rename", "--terminal", handle, "--title", label.title, "--json", ...(conditional ? ["--if-manual-title", isDefault ? "" : terminal.title] : [])]
  let renamed
  try {
    renamed = await runOrca(args)
  } catch {
    renamed = { status: 1, stdout: "" }
  }
  if (renamed.status !== 0) return finish({ code: String(renamed.stdout).includes("terminal_title_changed") ? "conditional_rename_refused" : "rename_failed" })
  const after = await readTerminal(runOrca, handle)
  if (after?.title !== label.title) return finish({ code: "readback_mismatch" })
  return finish({ code: "applied", title: label.title })
}
