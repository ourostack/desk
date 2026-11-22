// Names an Orca terminal after the task its main agent just focused (desk#1478), so the phone's session list says what
// each session is doing. Claude Code's PostToolUse hook (hooks/lib/orca-session-title.cjs) hands in the finished
// task_focus or focused task_create call.
//
// Whose title it is decides everything. Orca's CLI has one setter, `terminal rename`, and it writes the same custom
// title a person types, so Desk keeps its own record of the last title it set on each terminal. Desk renames only when
// the terminal still shows that title or an Orca default (an agent or shell name, Claude Code's own status title);
// any other title is a person's and stays. The caller's terminal is the one Orca names in ORCA_TERMINAL_HANDLE, never
// "the active terminal", and a subagent (its hook input carries `agent_id`) or a Desk child process never renames.
// Where the installed Orca supports `--if-title`, the rename only lands if the title is still the one Desk read, which
// closes the gap between reading and writing; otherwise that gap (a person renaming in the same instant) is the known
// limit, and the readback after the rename reports it.
//
// Every outcome is one line in Desk's state folder, `orca-session-titles.log`; nothing is shown to the agent and
// nothing here can fail the tool call.

import { execFile } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { startupChangesNothing } from "../factory/headless-flag.js"
import { makeSessionLabelProposal } from "./session-label.js"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

/** The longest title Desk sets, in code points: about what Orca's phone list shows before it cuts a name. */
export const ORCA_TITLE_MAX = 32

const STATE_FILE = "orca-session-titles.json"
const LOG_FILE = "orca-session-titles.log"
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const ORCA_TIMEOUT_MS = 4000
const HANDLE = /^term_[\w-]+$/u
// The session-label rules check text alone; the task they also ask for plays no part in the answer.
const SAFETY_TASK = { track: "orca", slug: "title" }
// What Orca shows before anyone names a tab: the agent or shell running in it, Orca's own "Terminal N", or the
// status title Claude Code writes (a spinner or ✳ glyph, then its summary).
const DEFAULT_TITLES = new Set(["", "terminal", "claude", "claude code", "codex", "copilot", "gemini", "opencode", "ouro", "zsh", "-zsh", "bash", "-bash", "fish", "sh", "desk:worker"])
const AGENT_STATUS_TITLE = /^[⠀-⣿✳✢✶✻✽·*]\s/u

/** True for a title Orca or the agent CLI made up, which Desk may replace. */
export function isOrcaDefaultTitle(title, agentIdentity) {
  if (typeof title !== "string") return false
  const text = title.trim().toLowerCase()
  return DEFAULT_TITLES.has(text) || /^terminal \d+$/u.test(text) || AGENT_STATUS_TITLE.test(title.trim()) ||
    (typeof agentIdentity === "string" && text === agentIdentity.trim().toLowerCase())
}

/** `text` cut to ORCA_TITLE_MAX code points, at a word when one ends in the second half, ending in an ellipsis. */
export function shortTitle(text) {
  const points = [...text]
  if (points.length <= ORCA_TITLE_MAX) return text
  let cut = points.slice(0, ORCA_TITLE_MAX - 1).join("")
  const space = cut.lastIndexOf(" ")
  if (space >= ORCA_TITLE_MAX / 2) cut = cut.slice(0, space)
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
  const text = candidate.trim().replace(/ {2,}/gu, " ")
  const checked = makeSessionLabelProposal({ task: SAFETY_TASK, displayLabel: text })
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
    return stdout.includes("--if-title")
  } catch {
    return false
  }
}

function readState(stateDir) {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, STATE_FILE), "utf8"))
    return value?.terminals !== null && typeof value?.terminals === "object" && !Array.isArray(value.terminals) ? value.terminals : {}
  } catch {
    return {}
  }
}

function recordTitle(stateDir, handle, title, at) {
  try {
    assertNotRealStateUnderTest(stateDir)
    const terminals = Object.fromEntries(Object.entries(readState(stateDir)).filter(([, entry]) => typeof entry?.at === "number" && at - entry.at < KEEP_MS))
    terminals[handle] = { title, at }
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, STATE_FILE), `${JSON.stringify({ terminals }, null, 2)}\n`)
  } catch {}
}

function logOutcome(stateDir, at, handle, code) {
  try {
    assertNotRealStateUnderTest(stateDir)
    mkdirSync(stateDir, { recursive: true })
    appendFileSync(path.join(stateDir, LOG_FILE), `${JSON.stringify({ at: new Date(at).toISOString(), terminal: handle ?? null, code })}\n`)
  } catch {}
}

/**
 * Names the caller's Orca terminal after the task a finished hook call focused. Returns `{ code, title? }`, where
 * `code` is `applied`, `unchanged`, `manual_title_kept`, `conditional_rename_refused`, `readback_mismatch`,
 * `rename_failed`, `orca_unavailable`, `not_in_orca`, `child_agent`, `not_naming_tool`, `not_focused`, `no_result`,
 * `no_label` or `unsafe_label`. Never throws.
 */
export async function nameOrcaSession({ hookInput, env = process.env, runOrca = defaultRunOrca(env), stateDir = resolveDeskStateDir({ env }), now = Date.now }) {
  const handle = typeof env.ORCA_TERMINAL_HANDLE === "string" && HANDLE.test(env.ORCA_TERMINAL_HANDLE) ? env.ORCA_TERMINAL_HANDLE : null
  const finish = (outcome) => {
    logOutcome(stateDir, now(), handle, outcome.code)
    return outcome
  }
  const toolName = typeof hookInput?.tool_name === "string" ? hookInput.tool_name : ""
  if (!/__task_(?:focus|create)$/u.test(toolName)) return finish({ code: "not_naming_tool" })
  if (handle === null) return finish({ code: "not_in_orca" })
  if ((typeof hookInput.agent_id === "string" && hookInput.agent_id !== "") || startupChangesNothing(env)) return finish({ code: "child_agent" })
  const result = parseToolResult(hookInput.tool_response)
  if (result === null) return finish({ code: "no_result" })
  if (!focusedNow(toolName, hookInput.tool_input, result)) return finish({ code: "not_focused" })
  const label = orcaTitleFor({ toolName, toolInput: hookInput.tool_input, result })
  if (label.title === undefined) return finish(label)

  const [terminal, conditional] = await Promise.all([readTerminal(runOrca, handle), supportsConditionalRename(runOrca)])
  if (terminal === null) return finish({ code: "orca_unavailable" })
  const lastSet = readState(stateDir)[handle]?.title
  if (terminal.title === label.title) return finish({ code: "unchanged" })
  if (terminal.title !== lastSet && !isOrcaDefaultTitle(terminal.title, terminal.agentIdentity)) return finish({ code: "manual_title_kept" })

  const args = ["terminal", "rename", "--terminal", handle, "--title", label.title, "--json", ...(conditional ? ["--if-title", terminal.title] : [])]
  let renamed
  try {
    renamed = await runOrca(args)
  } catch {
    renamed = { status: 1 }
  }
  if (renamed.status !== 0) return finish({ code: conditional ? "conditional_rename_refused" : "rename_failed" })
  const after = await readTerminal(runOrca, handle)
  if (after?.title !== label.title) return finish({ code: "readback_mismatch" })
  recordTitle(stateDir, handle, label.title, now())
  return finish({ code: "applied", title: label.title })
}
