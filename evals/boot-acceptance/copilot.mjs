// The Copilot CLI host of the boot-acceptance harness.
//
// `run.mjs --host copilot` runs the same scenarios through `copilot -p ...`
// instead of `claude -p ...`. This module holds everything that differs:
//
//   - finding the newest installed Copilot CLI;
//   - the auth method (see `resolveCopilotAuth`): one narrowly scoped
//     environment variable on the child process, never a file;
//   - the isolated Copilot profile (`<HOME>/.copilot`) and installing Desk into
//     it with `copilot plugin install`, the way a Copilot user gets it;
//   - the command-line flags and the child environment;
//   - `parseCopilotTranscript`, which turns Copilot's JSONL event log into the
//     stream-json shape `buildContext` reads, so claims.mjs and scenarios.mjs
//     judge a Copilot run with no change.
//
// What the normalizer cannot make equal is listed in `copilotNotApplicable`.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

// ---------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------

const VERSION_DIR = /^\d+(?:\.\d+)*$/
const compareVersions = (a, b) => {
  const x = a.split(".").map(Number)
  const y = b.split(".").map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/**
 * The Copilot CLI to run: `$DESK_HARNESS_COPILOT_BIN`, else the newest `~/.copilot-cli/<version>/copilot`, else `copilot` on PATH. Returns an absolute path or null.
 */
export function findCopilotBinary({ env = process.env, home = os.homedir(), exists = existsSync, list = (dir) => readdirSync(dir) } = {}) {
  if (env.DESK_HARNESS_COPILOT_BIN) return exists(env.DESK_HARNESS_COPILOT_BIN) ? env.DESK_HARNESS_COPILOT_BIN : null
  const root = path.join(home, ".copilot-cli")
  try {
    const versions = list(root).filter((name) => VERSION_DIR.test(name) && exists(path.join(root, name, "copilot"))).sort(compareVersions)
    if (versions.length > 0) return path.join(root, versions.at(-1), "copilot")
  } catch {
    // No versioned install: fall back to PATH.
  }
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) if (dir && exists(path.join(dir, "copilot"))) return path.join(dir, "copilot")
  return null
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const COPILOT_TOKEN_VAR = "COPILOT_GITHUB_TOKEN"

/** The login Copilot itself last signed in as, read from its config without touching any secret field. Returns null when there is none. */
export function copilotLastLogin(home = os.homedir()) {
  try {
    const text = readFileSync(path.join(home, ".copilot", "config.json"), "utf8")
    const block = text.match(/"lastLoggedInUser"\s*:\s*\{[^}]*\}/)?.[0] ?? ""
    return block.match(/"login"\s*:\s*"([^"]+)"/)?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * The Copilot credential for one harness invocation, or `{ token: null, problem }`. Copilot checks `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`
 * (`copilot help environment`) ahead of any stored login, so the child needs exactly one environment variable and no `~/.copilot` login state, keychain entry or
 * file. Where the value comes from, in order:
 *   1. `COPILOT_GITHUB_TOKEN` in the parent's environment: use it as is. A fine-grained personal access token with only the "Copilot Requests" permission is the
 *      narrowest credential Copilot accepts, so this is the recommended way to run the harness unattended;
 *   2. otherwise the GitHub CLI's stored token for the account Copilot itself last signed in as (`gh auth token --user <login>`, run in the parent with the
 *      real HOME). The login name is public; the token comes back on a pipe, is held in memory and goes only into the child's environment.
 * Classic tokens (`ghp_`) are not accepted by Copilot, and the value is never put in an argument list, a file or a log line.
 */
export function resolveCopilotAuth({ parentEnv = process.env, home = os.homedir(), run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }), lastLogin = copilotLastLogin } = {}) {
  const fromEnv = (parentEnv[COPILOT_TOKEN_VAR] ?? "").trim()
  if (fromEnv) return checkToken(fromEnv, `${COPILOT_TOKEN_VAR} in the parent environment`)
  const login = (parentEnv.DESK_HARNESS_COPILOT_LOGIN ?? "").trim() || lastLogin(home)
  if (!login) return { token: null, problem: `no Copilot credential: ${COPILOT_TOKEN_VAR} is unset and Copilot has no last-signed-in login in ~/.copilot/config.json (set ${COPILOT_TOKEN_VAR}, or DESK_HARNESS_COPILOT_LOGIN to a gh account that has Copilot)` }
  const r = run("gh", ["auth", "token", "--user", login])
  const token = (r.stdout ?? "").trim()
  if (r.status !== 0 || !token) return { token: null, problem: `no Copilot credential: \`gh auth token --user ${login}\` returned nothing (is that account signed in to gh? set ${COPILOT_TOKEN_VAR} instead)` }
  return checkToken(token, `the gh keychain token for ${login}`)
}

function checkToken(token, source) {
  if (token.startsWith("ghp_")) return { token: null, problem: `the credential from ${source} is a classic token (ghp_...), which Copilot does not accept; use a fine-grained token with the "Copilot Requests" permission, or a gh/Copilot OAuth token` }
  return { token, source }
}

// ---------------------------------------------------------------------------
// The isolated profile
// ---------------------------------------------------------------------------

/**
 * Writes the run's Copilot profile under `<homeDir>/.copilot` (also `COPILOT_HOME` in the child): the same host defaults the Desk setup sets on a real machine
 * (SETUP.md: `memory: false`, `includeCoAuthoredBy: false`), the run's folders trusted so no prompt can ever wait for an answer, and no login of any kind.
 */
export function writeCopilotProfile({ homeDir, trustedFolders }) {
  const copilotHome = path.join(homeDir, ".copilot")
  mkdirSync(copilotHome, { recursive: true })
  const config = { memory: false, includeCoAuthoredBy: false, autoUpdate: false, trustedFolders: [...trustedFolders] }
  writeFileSync(path.join(copilotHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`)
  return copilotHome
}

/** Shares Copilot's unpacked runtime (about 140 MB per HOME, no user data) between runs, so only the first run pays for it. */
export function shareCopilotPackageCache({ homeDir, sharedDir }) {
  const caches = path.join(homeDir, "Library", "Caches", "copilot")
  mkdirSync(caches, { recursive: true })
  mkdirSync(sharedDir, { recursive: true })
  symlinkSync(sharedDir, path.join(caches, "pkg"))
}

const PLUGINS = ["desk", "superpowers", "plain-language"]

/**
 * Installs Desk and the two roots it declares (`agency.json`) into the run's Copilot profile with `copilot plugin install <folder>`, the install a Copilot user
 * runs, from the plugin folders under test instead of from GitHub. `run` is the foreground runner (tests pass a fake). Returns `{ ok, log, installedDesk }`.
 */
export function installCopilotPlugins({ copilot, pluginDir, env, cwd, run = (args) => spawnSync(copilot, args, { cwd, env, encoding: "utf8" }) }) {
  const log = []
  for (const name of PLUGINS) {
    const r = run(["plugin", "install", path.join(pluginDir, name)])
    log.push(`${name}: exit ${r.status}: ${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0]}`)
    if (r.status !== 0) return { ok: false, log, installedDesk: null }
  }
  const installedDesk = path.join(env.COPILOT_HOME ?? path.join(env.HOME, ".copilot"), "installed-plugins", "_direct", "desk")
  return { ok: existsSync(installedDesk), log, installedDesk }
}

/** The installed copy of the plugin's boot script, as a realpath (the gh shim hands a raw token only to this exact file). */
export function installedBootScript(installedDesk) {
  const file = path.join(installedDesk, "mcp", "scripts", "session-boot.js")
  return existsSync(file) ? realpathSync(file) : null
}

// ---------------------------------------------------------------------------
// Flags and environment
// ---------------------------------------------------------------------------

export const COPILOT_DEFAULT_MODEL = "claude-haiku-4.5"

/**
 * The flags of every `copilot -p` call. `--allow-all-tools --allow-all-paths` is Claude's `bypassPermissions` here (no URL grant: a run reaches no real host);
 * `--disable-builtin-mcps` removes the built-in GitHub MCP server, which would act on GitHub with the run's credential; `--secret-env-vars` strips the credential
 * from every shell and MCP server the agent starts and redacts it from output.
 */
export function copilotFlags({ model }) {
  return [
    "--model", model,
    "--output-format", "json",
    "--stream", "off",
    "--allow-all-tools",
    "--allow-all-paths",
    "--no-ask-user",
    "--disable-builtin-mcps",
    "--no-auto-update",
    "--no-remote",
    "--no-color",
    `--secret-env-vars=${COPILOT_TOKEN_VAR}`,
  ]
}

/** The arguments that continue an earlier session in the critique turn. */
export const copilotResumeArgs = (sessionId) => [`--resume=${sessionId}`]

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

// Copilot's own tool names, mapped to the names claims.mjs and scenarios.mjs test for.
const TOOL_NAMES = {
  bash: "Bash",
  powershell: "Bash",
  view: "Read",
  create: "Write",
  edit: "Edit",
  str_replace_editor: "Edit",
  str_replace_based_edit_tool: "Edit",
  apply_patch: "Edit",
  grep: "Grep",
  glob: "Glob",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  skill: "Skill",
  task: "Task",
  ask_user: "AskUserQuestion",
}

/** `{ name, input }` of one Copilot tool call in the names and argument shapes the checks read. */
export function mapToolCall({ toolName, arguments: args, mcpServerName, mcpToolName }) {
  const input = { ...(args ?? {}) }
  // An MCP tool is `mcp__<server>__<tool>` on Claude Code; every check that names one matches the end (`task_update`).
  if (mcpServerName && mcpToolName) return { name: `mcp__${mcpServerName}__${mcpToolName}`, input }
  const name = TOOL_NAMES[toolName] ?? toolName
  if (name === "Edit" || name === "Write" || name === "Read") {
    if (input.path !== undefined && input.file_path === undefined) input.file_path = input.path
    if (name === "Edit") {
      if (input.old_str !== undefined && input.old_string === undefined) input.old_string = input.old_str
      if (input.new_str !== undefined && input.new_string === undefined) input.new_string = input.new_str
    }
    if (name === "Write" && input.file_text !== undefined && input.content === undefined) input.content = input.file_text
  }
  return { name, input }
}

/** Copilot's JSONL (one event per line) as events. A non-JSON line is dropped, as the stream-json parser does. */
export function parseCopilotJsonl(text) {
  const events = []
  for (const raw of String(text).split("\n")) {
    const line = raw.trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Not an event.
    }
  }
  return events
}

/**
 * Copilot's event log as the stream-json events `buildContext` reads: an `assistant` event per assistant message with its text and tool calls, a `user` event
 * per tool result, and one closing `result` event carrying the last assistant text. Tool results come from `tool.execution_complete`; a failed tool, or a shell
 * command with a non-zero exit, is an error result, as it is on Claude Code. A tool the host denied (a `preToolUse` hook, a permission rule) is an error result
 * whose text starts the way Claude Code's denial text does (`PreToolUse:<Tool> hook error: ...`), which is the form `wasDenied` looks for.
 */
export function copilotToStreamEvents(copilotEvents) {
  const out = []
  const seen = new Set()
  const names = new Map()
  let sessionId = null
  let finalText = ""
  let usage = null
  let exitCode = null
  let turns = 0
  let started = null
  let ended = null
  const emitCall = (id, call) => {
    if (seen.has(id)) return
    seen.add(id)
    names.set(id, call.name)
    out.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name: call.name, input: call.input }] } })
  }
  for (const event of copilotEvents) {
    const data = event.data ?? {}
    started ??= event.timestamp ?? null
    if (event.timestamp) ended = event.timestamp
    if (typeof event.sessionId === "string") sessionId ??= event.sessionId
    if (typeof data.sessionId === "string") sessionId ??= data.sessionId
    switch (event.type) {
      case "assistant.message": {
        const blocks = []
        const text = typeof data.content === "string" ? data.content : ""
        if (text.trim()) blocks.push({ type: "text", text })
        const requests = Array.isArray(data.toolRequests) ? data.toolRequests : []
        for (const request of requests) {
          const call = mapToolCall({ toolName: request.name, arguments: request.arguments, mcpServerName: request.mcpServerName, mcpToolName: request.mcpToolName })
          if (!seen.has(request.toolCallId)) {
            seen.add(request.toolCallId)
            names.set(request.toolCallId, call.name)
            blocks.push({ type: "tool_use", id: request.toolCallId, name: call.name, input: call.input })
          }
        }
        if (blocks.length > 0) out.push({ type: "assistant", message: { content: blocks } })
        if (requests.length === 0 && text.trim()) finalText = text
        break
      }
      case "assistant.turn_start":
        turns += 1
        break
      case "tool.execution_start": {
        // Normally already announced by the assistant message; this covers a call that arrives without one.
        const call = mapToolCall({ toolName: data.toolName, arguments: data.arguments, mcpServerName: data.mcpServerName, mcpToolName: data.mcpToolName })
        emitCall(data.toolCallId, call)
        break
      }
      case "tool.execution_complete": {
        const text = completeText(data)
        const exit = data.shellExecution?.exitCode
        const isError = data.success === false || (typeof exit === "number" && exit !== 0)
        out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: data.toolCallId, content: wasRefused(data) ? denialPrefix(names.get(data.toolCallId), text) : text, is_error: isError }] } })
        break
      }
      case "result":
        usage = event.usage ?? null
        exitCode = typeof event.exitCode === "number" ? event.exitCode : null
        if (typeof event.sessionId === "string") sessionId = event.sessionId
        break
      default:
    }
  }
  // The session id leads, as Claude Code's init event does, so `buildContext` finds it first.
  out.unshift({ type: "system", subtype: "init", session_id: sessionId })
  out.push({
    type: "result",
    subtype: exitCode === 0 || exitCode === null ? "success" : "error",
    is_error: exitCode !== null && exitCode !== 0,
    result: finalText,
    session_id: sessionId,
    duration_ms: started && ended ? Date.parse(ended) - Date.parse(started) : null,
    duration_api_ms: usage?.totalApiDurationMs ?? null,
    // Copilot bills in premium requests, not dollars: the dollar cost is not known.
    total_cost_usd: null,
    premium_requests: usage?.premiumRequests ?? null,
    num_turns: turns || null,
  })
  return out
}

function completeText(data) {
  const result = data.result
  if (typeof result === "string") return result
  if (typeof result?.content === "string") return result.content
  if (typeof data.error === "string") return data.error
  if (typeof data.error?.message === "string") return data.error.message
  return ""
}

// A tool the host refused (a `preToolUse` hook, or a permission rule) completes with `success: false` and `error: { code: "denied", message: "Denied by preToolUse hook: ..." }`.
// A tool that merely failed has some other code, and a shell command that printed "permission denied" completed with a non-zero exit instead: neither is a refusal.
function wasRefused(data) {
  return data.success === false && (data.error?.code === "denied" || /^Denied by /.test(completeText(data)))
}

// Claude Code words the same refusal `PreToolUse:<Tool> hook error: <reason>`, the form `wasDenied` in claims.mjs reads, so the same checks see a refusal on either host.
function denialPrefix(tool, text) {
  return `PreToolUse:${tool ?? "Tool"} hook error: ${text}`
}

/** Copilot JSONL text as stream-json events: the parser the Copilot host uses in place of `parseStreamJson`. */
export function parseCopilotTranscript(text) {
  return copilotToStreamEvents(parseCopilotJsonl(text))
}

/**
 * The saved form of a Copilot transcript: the durable events only. A streaming run also logs every token delta as an `ephemeral` event, and each assistant
 * message carries an opaque encrypted reasoning blob; neither is evidence of anything and both bulk the file, so they are dropped. Everything else is kept as Copilot wrote it.
 */
export function compactCopilotTranscript(text) {
  const kept = []
  for (const raw of String(text).split("\n")) {
    const line = raw.trim()
    if (!line) continue
    try {
      const event = JSON.parse(line)
      if (event.ephemeral === true) continue
      if (event.data && typeof event.data === "object") for (const key of ["reasoningOpaque", "encryptedContent"]) delete event.data[key]
      kept.push(JSON.stringify(event))
    } catch {
      kept.push(line)
    }
  }
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// What does not carry over
// ---------------------------------------------------------------------------

/**
 * Checks and behaviours the Copilot host cannot judge the way the Claude host does. Each is reported in a run's notes as `N/A on copilot: ...` and in the
 * summary's `not_applicable`: an unjudged check is never counted as a pass.
 */
export const COPILOT_NOT_APPLICABLE = [
  "dollar cost: Copilot reports premium requests, not USD (summary.premium_requests holds the figure); there is no per-run budget cap",
  "the Claude-only guards: Desk registers only the protected-checkout guard for Copilot (its host enforcement denies nothing there), so the card-status guard, the ask gate and the denial of Claude's own task and plan tools have no Copilot counterpart",
  "hook-denied notes: a refusal reaches the checks as Claude's `PreToolUse:<Tool> hook error:` text (normalized from Copilot's `Denied by preToolUse hook`), so a direct card edit that no guard refuses on Copilot is judged as the write it is",
]

/** The not-applicable list a run on `host` reports (empty on Claude Code). */
export function notApplicableFor(host) {
  return host === "copilot" ? [...COPILOT_NOT_APPLICABLE] : []
}
