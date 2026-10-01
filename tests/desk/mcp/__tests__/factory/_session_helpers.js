// The global test setup, so a factory test file run on its own with `node --test <file>` reads and writes only temporary state, never the machine's own factory consent.
import "../_isolated_env.mjs"
import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

export const ID = "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60"
export const STORE = "ourostack/factory"
export const START = "2026-09-26T08:00:00.000Z"
export const END = "2026-09-26T08:01:00.000Z"
export const SENTINEL = "PRIVATE prompt and assistant content must never persist"

export async function scratch(run) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "desk-factory-session-")))
  const desk = path.join(base, "desk")
  await mkdir(path.join(desk, "_meta"), { recursive: true })
  await mkdir(path.join(desk, "_archive"))
  const env = { ...process.env, HOME: base, USERPROFILE: base, XDG_STATE_HOME: path.join(base, "state"), COPILOT_HOME: path.join(base, ".copilot"), DESK: desk }
  for (const key of ["DESK_ACTIVATION_CONFIG", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR", "CODEX_HOME", "DESK_PERSON", "CLAUDE_CONFIG_DIR"]) delete env[key]
  try {
    return await run({ base, desk, env })
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

export async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value))
}

export async function session({ base, desk, env }, host = "claude-code") {
  const log = host === "claude-code"
    ? path.join(base, ".claude", "projects", "test", `${ID}.jsonl`)
    : path.join(env.COPILOT_HOME, "session-state", ID, "events.jsonl")
  await mkdir(path.dirname(log), { recursive: true })
  const lines = host === "claude-code" ? [
    { type: "user", sessionId: ID, timestamp: START, version: "2.1.282", entrypoint: "cli", message: { content: SENTINEL } },
    { type: "assistant", sessionId: ID, timestamp: END, message: { id: "msg-1", model: "claude-sonnet-5", content: [{ type: "text", text: SENTINEL }], usage: { input_tokens: 1, output_tokens: 2 } } },
  ] : [
    { type: "session.start", timestamp: START, data: { copilotVersion: "1.0.88", context: { cwd: desk } } },
    { type: "user.message", timestamp: START, data: { content: SENTINEL } },
    { type: "assistant.message", timestamp: END, data: { content: SENTINEL } },
  ]
  await writeFile(log, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  return {
    schema_version: 1, host, session_id: ID, log_path: log, cwd: desk, desk_root: desk,
    end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString(),
  }
}

/** A marker `updated_at` on the real clock: `listMarkers` prunes a marker whose `updated_at` is over 30 days old, so a fixed date would rot. */
export const recent = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

/**
 * Routes session `sessionId` of `host` to `store`, as a delivery needs: a flush publishes a session only while its marker positively routes to the
 * store. The desk `env.DESK` declares `store` (written once), and the session's marker names it as its desk root. A marker already there is kept.
 */
export async function routeTo(env, sessionId, { host = "claude-code", store = STORE } = {}) {
  const { factoryStateRoot, writeMarker } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  const { existsSync } = await import("node:fs")
  const declaration = path.join(env.DESK, "_meta", "factory.json")
  if (!existsSync(declaration)) await json(declaration, { schema_version: 1, store })
  const marker = path.join(await factoryStateRoot(env), "markers", `${host}-${sessionId}.json`)
  if (existsSync(marker)) return
  const log = path.join(env.DESK, "..", `route-${host}-${sessionId}.jsonl`)
  await writeFile(log, "{}\n")
  // A quiet log: the session ended long enough ago for finalize to stop waiting on it.
  const { utimes } = await import("node:fs/promises")
  const old = new Date(Date.now() - 60 * 60 * 1000)
  await utimes(log, old, old)
  await writeMarker(env, { schema_version: 1, host, session_id: sessionId, log_path: log, cwd: env.DESK, desk_root: env.DESK, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString() })
}
