// Counts the root sessions each host still keeps on disk, from folder listings alone.
//
// This is the denominator of capture coverage: how many sessions exist, whether or not any marker or facts file does. It never reads a transcript's content. Claude Code and Copilot CLI are counted by names; Codex needs the first record's parent field to tell a root from a child, so it reads at most 16 KiB of the first line, keeps one boolean per file and caches it by name, size and mtime. The cache lives in memory for the caller and is never written anywhere.
//
// Work is bounded per host: a cap on directory entries and a time budget. A host past either bound is `capped` and lists no sessions, so a slow disk can never become a smaller, believable number. A Codex rollout whose first line cannot be told within the bound is counted under `undetermined` and left out of `sessions`, never as a root and never as a child.
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const HOSTS = Object.freeze(["claude-code", "copilot-cli", "codex-cli"])
export const COUNT_CAPS = Object.freeze({ entriesPerHost: 20000, budgetMs: 3000 })

const FIRST_LINE_BYTES = 16 * 1024
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const CLAUDE_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/u

class Stop extends Error {
  constructor(state) {
    super(state)
    this.state = state
  }
}

/** The folder a Claude Code session of `deskRoot` lives in: every character outside letters and digits becomes `-`. Local use only. */
export function claudeFolderOf(deskRoot) {
  return deskRoot.replace(/[^A-Za-z0-9]/gu, "-")
}

function budgetOf(caps, now) {
  const started = now()
  let entries = 0
  return {
    // Called with 1 per directory entry read, and with 0 before a file read (time only); throws when either bound is passed.
    spend(n = 1) {
      entries += n
      if (entries > caps.entriesPerHost || now() - started > caps.budgetMs) throw new Stop("capped")
    },
  }
}

// A directory listing as `[{ name, dir }]`, counted entry by entry as it is read so the cap trips before a huge folder is in memory. A missing top folder is absent, any other failure unreadable; a folder that vanishes mid-pass is unreadable for this pass.
async function list(folder, budget, top) {
  const entries = []
  try {
    for await (const entry of await fs.opendir(folder)) {
      budget.spend()
      entries.push({ name: entry.name, dir: entry.isDirectory() })
    }
  } catch (error) {
    if (error instanceof Stop || typeof error?.code !== "string") throw error
    throw new Stop(top && error?.code === "ENOENT" ? "absent" : "unreadable")
  }
  return entries
}

// A plain file with one name: not a link either way (the same guard `sourceStamp` applies before a source is trusted).
async function plainFile(file) {
  try {
    const stat = await fs.lstat(file)
    return stat.isFile() && stat.nlink === 1 ? stat : null
  } catch {
    return null
  }
}

async function countClaude(configDir, budget) {
  const projects = path.join(configDir, "projects")
  const sessions = []
  for (const folder of await list(projects, budget, true)) {
    if (!folder.dir) continue
    for (const file of await list(path.join(projects, folder.name), budget, false)) {
      const match = CLAUDE_FILE.exec(file.name)
      if (file.dir || match === null || (await plainFile(path.join(projects, folder.name, file.name))) === null) continue
      sessions.push({ name: `claude-code-${match[1]}.json`, id: match[1], folder: folder.name })
    }
  }
  return { sessions }
}

async function countCopilot(copilotHome, budget) {
  const state = path.join(copilotHome, "session-state")
  const sessions = []
  for (const entry of await list(state, budget, true)) {
    if (!entry.dir || !SESSION_ID.test(entry.name)) continue
    if ((await plainFile(path.join(state, entry.name, "events.jsonl"))) !== null) sessions.push({ name: `copilot-cli-${entry.name}.json`, id: entry.name })
  }
  return { sessions }
}

// The first line of a rollout, only if it ends within the bound; `null` when it does not.
async function boundedFirstLine(file) {
  const handle = await fs.open(file, "r").catch(() => null)
  if (handle === null) return null
  try {
    const buffer = Buffer.alloc(FIRST_LINE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_BYTES, 0)
    const text = buffer.toString("utf8", 0, bytesRead)
    const newline = text.indexOf("\n")
    if (newline !== -1) return text.slice(0, newline)
    return bytesRead < FIRST_LINE_BYTES ? text : null
  } finally {
    await handle.close()
  }
}

// `{ id, root }` from a first line, or `null` when it is not a usable `session_meta`. A rollout is a child when it names a parent thread, at the top of the payload or under its subagent spawn.
function rootOfFirstLine(text) {
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  const payload = record?.payload
  if (record?.type !== "session_meta" || payload === null || typeof payload !== "object" || Array.isArray(payload)) return null
  if (typeof payload.id !== "string" || !SESSION_ID.test(payload.id)) return null
  const parents = [payload.parent_thread_id, payload.source?.subagent?.thread_spawn?.parent_thread_id]
  return { id: payload.id, root: !parents.some((parent) => typeof parent === "string" && SESSION_ID.test(parent)) }
}

async function countCodex(codexHome, budget, cache, seen) {
  const base = path.join(codexHome, "sessions")
  const sessions = []
  let undetermined = 0
  for (const year of await list(base, budget, true)) {
    if (!year.dir || !/^\d{4}$/u.test(year.name)) continue
    for (const month of await list(path.join(base, year.name), budget, false)) {
      if (!month.dir || !/^\d{2}$/u.test(month.name)) continue
      for (const day of await list(path.join(base, year.name, month.name), budget, false)) {
        if (!day.dir || !/^\d{2}$/u.test(day.name)) continue
        const folder = path.join(base, year.name, month.name, day.name)
        for (const file of await list(folder, budget, false)) {
          if (file.dir || !ROLLOUT_NAME.test(file.name)) continue
          const stat = await plainFile(path.join(folder, file.name))
          if (stat === null) continue
          const key = `${year.name}/${month.name}/${day.name}/${file.name}\0${stat.size}\0${stat.mtimeMs}`
          let answer = cache[key]
          if (answer === undefined) {
            budget.spend(0)
            const line = await boundedFirstLine(path.join(folder, file.name))
            answer = (line === null ? null : rootOfFirstLine(line)) ?? null
          }
          seen[key] = answer
          if (answer === null) undetermined += 1
          else if (answer.root) sessions.push({ name: `codex-cli-${answer.id}.json`, id: answer.id })
        }
      }
    }
  }
  return { sessions, undetermined }
}

/**
 * Root sessions on disk per host: `{ hosts: { [host]: { state, sessions: [{ name, id, folder? }], undetermined? } }, cache }`.
 * `state` is `counted`, `absent` (no host folder), `unreadable` or `capped`; only a `counted` host lists sessions. `name` is `<host>-<id>.json`; `folder` is set for Claude Code only. `undetermined` (Codex only) counts rollouts whose first line could not be told, which are in no bucket and not in `sessions`: the consumer must treat `undetermined > 0` as the host being unverified (it can be momentary, such as a rollout still being created). `cache` is the Codex answer cache to pass back in next time; keep it in memory only. A capped Codex pass returns the old cache plus the answers read so far, so repeated sweeps converge; an absent or unreadable Codex folder returns the old cache unchanged.
 */
export async function listRootSessions(env, { now = Date.now, caps = COUNT_CAPS, cache = {} } = {}) {
  const home = env.HOME || os.homedir()
  const roots = {
    "claude-code": env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    "copilot-cli": env.COPILOT_HOME || path.join(home, ".copilot"),
    "codex-cli": env.CODEX_HOME || path.join(home, ".codex"),
  }
  const hosts = {}
  const seen = {}
  let codexState = null
  for (const host of HOSTS) {
    const budget = budgetOf(caps, now)
    try {
      const counted = host === "claude-code" ? await countClaude(roots[host], budget)
        : host === "copilot-cli" ? await countCopilot(roots[host], budget)
          : await countCodex(roots[host], budget, cache, seen)
      hosts[host] = { state: "counted", ...counted }
    } catch (error) {
      if (!(error instanceof Stop)) throw error
      hosts[host] = { state: error.state, sessions: [] }
      if (host === "codex-cli") codexState = error.state
    }
  }
  // A capped Codex pass keeps what it read, so the next sweep starts further on; any other non-counted outcome keeps the old answers untouched.
  return { hosts, cache: codexState === null ? seen : codexState === "capped" ? { ...cache, ...seen } : cache }
}
