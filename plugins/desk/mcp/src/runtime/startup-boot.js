// The session boot, run by Desk itself so no agent is ever told to run a script.
//
// A startup hook (or, with no hook, the Desk server's first tool reply) starts `scripts/session-boot.js --deliver <file>` as a
// detached process and the result lands in a file keyed by the session. One of three places hands the finished text to the agent,
// whichever is first and exactly once: the first-prompt hook (Copilot), the session-start hook (Claude, and a resumed Copilot
// session), or the first Desk tool reply (the server, which can wait longer than a hook's time limit). Three small files per
// session, all in Desk's state folder:
//
//   <hash>.start      claimed with an exclusive create by whoever starts the boot, so two starters start one boot
//   <hash>.txt        the boot's text, written to a temporary name and renamed, so a reader never sees half of it
//   <hash>.delivered  claimed with an exclusive create by whoever hands the text to the agent
//
// The key is the Copilot session id (the hooks get it as `sessionId`, the server as COPILOT_AGENT_SESSION_ID) and otherwise the
// session's folder (Claude: CLAUDE_PROJECT_DIR for both). Nothing here throws: a session must start whether or not its boot did.
// A boot that cannot start or finish never blocks the agent; the text says so and `desk_status` reports the desk's state.

import { createHash } from "node:crypto"
import { spawn as nodeSpawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest, looksLikeNodeTestRunner } from "./test-state-guard.js"
import { renameWithRetry } from "../util/rename-retry.js"

export const BOOT_RESULT_DIR = "boot-results"
export const AUTO_BOOT_SWITCH = "DESK_AUTO_BOOT"
/** How long the server's first tool reply waits for a boot that is still running; the boot's own budget is 15 s. */
export const SERVER_WAIT_MS = 12_000
const POLL_MS = 50
const STALE_MS = 7 * 24 * 60 * 60 * 1000

const hasText = (value) => typeof value === "string" && value.trim() !== ""
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The session script this module starts: `<plugin>/mcp/scripts/session-boot.js`, found from this file's own place in the plugin. */
export const BOOT_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "session-boot.js")

/**
 * The session's key, or null when there is nothing to key on. A Copilot session id wins; Claude has no id the server shares with
 * its hook, so the project folder stands in (a new session in a folder starts a new boot, see `startBoot`'s `fresh`).
 */
export function bootKey({ sessionId, folder } = {}) {
  if (hasText(sessionId)) return `s:${sessionId}`
  return hasText(folder) && path.isAbsolute(folder) ? `f:${path.resolve(folder)}` : null
}

/** The key the Desk server computes from its own environment; it must equal the one the hook computed. */
export function serverBootKey(env = process.env) {
  return bootKey({ sessionId: env.COPILOT_AGENT_SESSION_ID, folder: env.CLAUDE_PROJECT_DIR })
}

/** False when the operator turned automatic boots off (`DESK_AUTO_BOOT=0`), for a headless evaluator session, or inside a node:test run that did not ask for one. */
export function autoBootEnabled(env = process.env, { allowInTest = false } = {}) {
  if (String(env[AUTO_BOOT_SWITCH] ?? "").trim() === "0") return false
  const headless = String(env.DESK_FACTORY_HEADLESS ?? "")
  if (headless !== "" && headless !== "0") return false
  return allowInTest || !looksLikeNodeTestRunner(env)
}

/** The three files of a session's boot. */
export function bootPaths({ stateDir, key }) {
  const base = path.join(stateDir, BOOT_RESULT_DIR, createHash("sha256").update(String(key)).digest("hex").slice(0, 32))
  return { text: `${base}.txt`, start: `${base}.start`, delivered: `${base}.delivered` }
}

function pruneStale(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      try {
        const file = path.join(dir, name)
        if (now - statSync(file).mtimeMs > STALE_MS) unlinkSync(file)
      } catch {
        // Gone already, or not ours: skip it.
      }
    }
  } catch {
    // No folder yet.
  }
}

function claim(file, content = "") {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const fd = openSync(file, "wx", 0o600)
    try {
      if (content !== "") writeFileSync(fd, content)
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

function writeText(file, text) {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameWithRetry(temp, file)
}

/**
 * Starts the session's boot unless one is already started: returns `{ state: "started" | "already" | "failed", paths }`.
 * `fresh` first forgets an earlier boot under the same key (a resumed session, or a new Claude session in the same folder).
 * The boot is the plugin's own `session-boot.js`, detached, in the session's folder, with the session id in its environment so it
 * binds the desk the server will. A boot that cannot be spawned leaves a one-sentence result in its place.
 */
export function startBoot({ key, folder, sessionId, env = process.env, stateDir = resolveDeskStateDir({ env }), script = BOOT_SCRIPT, spawn = nodeSpawn, now = Date.now, fresh = false } = {}) {
  if (key === null || key === undefined) return { state: "failed", paths: null }
  try {
    assertNotRealStateUnderTest(stateDir)
    const paths = bootPaths({ stateDir, key })
    if (fresh) for (const file of Object.values(paths)) rmSync(file, { force: true })
    if (!claim(paths.start, JSON.stringify({ at: now(), pid: null }))) return { state: "already", paths }
    pruneStale(path.dirname(paths.start), now())
    const childEnv = { ...env }
    if (hasText(sessionId)) childEnv.COPILOT_AGENT_SESSION_ID = sessionId
    const failed = (reason) => {
      try {
        writeText(paths.text, `Desk boot: it could not start (${reason}). desk_status reports the desk's state.\n`)
      } catch {
        // The reader times out and says so.
      }
      return { state: "failed", paths }
    }
    try {
      const child = spawn(process.execPath, [script, "--deliver", paths.text], {
        cwd: hasText(folder) && existsSync(folder) ? folder : undefined,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: childEnv,
      })
      child.on?.("error", () => {})
      child.unref?.()
      if (typeof child.pid === "number") writeFileSync(paths.start, JSON.stringify({ at: now(), pid: child.pid }))
      return { state: "started", paths }
    } catch (error) {
      return failed(String(error?.message ?? error).split("\n")[0].slice(0, 120))
    }
  } catch {
    return { state: "failed", paths: null }
  }
}

function startRecord(paths) {
  try {
    const record = JSON.parse(readFileSync(paths.start, "utf8"))
    return { at: Number.isFinite(record.at) ? record.at : null, pid: Number.isInteger(record.pid) ? record.pid : null }
  } catch {
    return { at: null, pid: null }
  }
}

function alive(pid) {
  if (pid === null) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

function readText(paths) {
  try {
    return readFileSync(paths.text, "utf8")
  } catch {
    return null
  }
}

/**
 * The boot's text as `{ text, seconds }`, once it exists; waits up to `waitMs` for it. Null when it is not there yet, or when the
 * boot's process ended without writing one (`reason: "ended"` in `lastReason`), so a crashed boot never costs a whole wait.
 */
export async function awaitBoot({ paths, waitMs = 0, now = Date.now, pause = sleep } = {}) {
  if (paths === null || paths === undefined) return { boot: null, reason: "none" }
  const deadline = now() + Math.max(0, waitMs)
  for (;;) {
    const text = readText(paths)
    if (text !== null) {
      const { at } = startRecord(paths)
      let seconds = null
      try {
        if (at !== null) seconds = Math.max(0, (statSync(paths.text).mtimeMs - at) / 1000)
      } catch {
        // The duration is a nicety.
      }
      return { boot: { text, seconds }, reason: "ready" }
    }
    if (!existsSync(paths.start)) return { boot: null, reason: "none" }
    if (!alive(startRecord(paths).pid)) return { boot: null, reason: "ended" }
    if (now() >= deadline) return { boot: null, reason: "running" }
    await pause(Math.min(POLL_MS, Math.max(1, deadline - now())))
  }
}

/** True for exactly one caller per session: the one that may hand the boot to the agent. */
export function claimDelivery(paths) {
  return paths !== null && paths !== undefined && claim(paths.delivered)
}

/** Whether the text was already handed over (without claiming it). */
export function wasDelivered(paths) {
  return paths !== null && paths !== undefined && existsSync(paths.delivered)
}

/**
 * The text a hook puts in the agent's context. The boot's own report, behind one framing line: it ran at session start, and its
 * instructions belong to the operator's session. `maxChars` keeps it inside a host's context limit: a longer text is cut at a
 * line and the rest comes with the first Desk tool reply (`whole: false`, so the caller leaves the delivery unclaimed).
 */
export function bootContext({ boot, maxChars = Infinity }) {
  const took = boot.seconds === null ? "" : `, ${boot.seconds.toFixed(1)} s`
  const frame = `Desk boot (Desk ran it for you at session start${took}; its instructions are for the operator's session, so a child agent with a bounded brief follows its brief instead):`
  const whole = boot.text.length + frame.length + 2 <= maxChars
  if (whole) return { whole, text: `${frame}\n\n${boot.text.trimEnd()}` }
  const note = "[The rest of the boot arrives with your first Desk tool reply.]"
  const room = Math.max(0, maxChars - frame.length - note.length - 6)
  const cut = boot.text.lastIndexOf("\n", room)
  return { whole, text: `${frame}\n\n${boot.text.slice(0, cut > 0 ? cut : room).trimEnd()}\n\n${note}` }
}

/** What a hook says when the boot has not finished within its time budget. */
export function pendingBootLine({ seconds } = {}) {
  const ago = typeof seconds === "number" ? ` (it started ${seconds.toFixed(1)} s ago)` : ""
  return `Desk's boot is still running${ago}. Call desk_status for its result (that reply waits for it and carries it) before you say anything about the desk's state; it also comes with your next message.`
}

/** Seconds since the boot started, for the pending line. */
export function bootAgeSeconds(paths, now = Date.now) {
  const { at } = startRecord(paths)
  return at === null ? undefined : Math.max(0, (now() - at) / 1000)
}

const TASK_FOCUS = "task_focus"

/**
 * The Desk server's half. The first tool reply of a session carries the boot text when no hook handed it over (waiting up to
 * `waitMs` for a boot still running, and starting one when no hook did); every later reply only checks for a result that arrived
 * late. A `task_focus` reply also carries the task's push route and repos, which the boot checks for one named task only
 * (`taskBoot`, `runtime/boot.js`'s `--task --task-only`), once per task per session. Replies are only ever appended to.
 * Never throws and never changes an error reply.
 */
export function withStartupBoot({
  callTool,
  env = process.env,
  stateDir = resolveDeskStateDir({ env }),
  waitMs = SERVER_WAIT_MS,
  allowInTest = false,
  start = startBoot,
  taskBoot = defaultTaskBoot,
  pause = sleep,
} = {}) {
  const key = autoBootEnabled(env, { allowInTest }) ? serverBootKey(env) : null
  if (key === null) return callTool
  let waited = false
  const routed = new Set()
  const append = (result, text) => ({ ...result, content: [...(Array.isArray(result?.content) ? result.content : []), { type: "text", text }] })
  return async (call) => {
    let result = await callTool(call)
    if (result?.isError || call?.signal?.aborted) return result
    try {
      const first = !waited
      waited = true
      const pluginRoot = hasText(env.DESK_PLUGIN_ROOT) ? env.DESK_PLUGIN_ROOT : null
      const paths = bootPaths({ stateDir, key })
      if (first && !existsSync(paths.start)) {
        start({ key, folder: env.CLAUDE_PROJECT_DIR, sessionId: env.COPILOT_AGENT_SESSION_ID, env, stateDir, script: pluginRoot === null ? BOOT_SCRIPT : path.join(pluginRoot, "mcp", "scripts", "session-boot.js") })
      }
      if (!wasDelivered(paths)) {
        const { boot } = await awaitBoot({ paths, waitMs: first ? waitMs : 0, pause })
        if (boot !== null && claimDelivery(paths)) {
          result = append(result, bootContext({ boot }).text)
        } else if (boot === null && first && existsSync(paths.start)) {
          result = append(result, "Desk's boot has not finished or did not leave a result. Carry on with the operator's request; desk_status reports the desk's state, and the boot's result arrives with a later Desk reply if it finishes.")
        }
      }
      if (call?.name === TASK_FOCUS) {
        const track = call?.input?.track
        const slug = call?.input?.slug
        const id = `${track}/${slug}`
        if (hasText(track) && hasText(slug) && call.input.clear !== true && !routed.has(id)) {
          routed.add(id)
          const text = await taskBoot({ env, track, slug })
          if (hasText(text)) result = append(result, text)
        }
      }
    } catch {
      // The reply is the tool's own, unchanged.
    }
    return result
  }
}

// The boot for one named task, as text: what `session-boot.js --task <track/slug> --task-only` printed. Loaded when needed, so the
// server's start never loads the boot's modules.
async function defaultTaskBoot({ env, track, slug }) {
  try {
    const { bootOnce } = await import("./boot.js")
    const { formatBootText } = await import("./boot-text.js")
    const result = await Promise.race([
      bootOnce({ env, taskQuery: `${track}/${slug}`, taskOnly: true }),
      new Promise((resolve) => setTimeout(resolve, 10_000, null)),
    ])
    return result === null ? `Push route and repos for ${track}/${slug} were not checked in time; run gh auth status before you push.` : formatBootText(result)
  } catch {
    return ""
  }
}
