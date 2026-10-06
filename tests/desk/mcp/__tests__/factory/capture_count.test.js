// Capture counting: root sessions on disk, per host, from folder listings alone.
// Every transcript here carries SENTINEL; the result must never hold it.
import "../_isolated_env.mjs"
import assert from "node:assert/strict"
import { chmod, cp, link, mkdir, mkdtemp, readdir, realpath, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { COUNT_CAPS, HOSTS, claudeFolderOf, listRootSessions } from "../../../../../plugins/desk/mcp/src/factory/capture-count.js"
import { deriveCodexSession } from "../../../../../plugins/desk/mcp/src/factory/derive-codex.js"
import { SENTINEL } from "./_session_helpers.js"

const A = "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60"
const B = "4b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f61"
const C = "5b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f62"
const here = path.dirname(fileURLToPath(import.meta.url))

async function home(run) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "desk-capture-count-")))
  try {
    return await run(base, { HOME: base })
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

const put = async (file, text = `${JSON.stringify({ text: SENTINEL })}\n`) => {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

const codexMeta = (id, parent, extra = {}) => `${JSON.stringify({
  timestamp: "2026-09-25T08:00:00.000Z", type: "session_meta",
  payload: { id, cwd: SENTINEL, cli_version: "0.142.0", source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli", ...(parent ? { parent_thread_id: parent } : {}), ...extra },
})}\n`
const rollout = (base, id, day = "25") => path.join(base, ".codex", "sessions", "2026", "09", day, `rollout-2026-09-${day}T08-00-00-${id}.jsonl`)

test("claude: counts only top-level uuid transcripts and ignores nested subagent logs and non-uuid files", () => home(async (base, env) => {
  const projects = path.join(base, ".claude", "projects")
  await put(path.join(projects, "-work-one", `${A}.jsonl`))
  await put(path.join(projects, "-work-one", `${B}.jsonl`))
  await put(path.join(projects, "-work-two", `${C}.jsonl`))
  await put(path.join(projects, "-work-one", A, "subagents", `agent-${B}.jsonl`))
  await put(path.join(projects, "-work-one", `${A}.jsonl.bak`))
  await put(path.join(projects, "-work-one", "notes.jsonl"))
  await mkdir(path.join(projects, "-work-one", `${C}.jsonl`))
  await put(path.join(projects, "stray-file.txt"))
  const result = await listRootSessions(env)
  const claude = result.hosts["claude-code"]
  assert.equal(claude.state, "counted")
  assert.deepEqual(claude.sessions.map((s) => s.name).sort(), [`claude-code-${A}.json`, `claude-code-${B}.json`, `claude-code-${C}.json`].sort())
  assert.deepEqual(claude.sessions.find((s) => s.id === C), { name: `claude-code-${C}.json`, id: C, folder: "-work-two" })
  assert.deepEqual(Object.keys(result.hosts).sort(), [...HOSTS].sort())
}))

test("claude: CLAUDE_CONFIG_DIR wins over HOME", () => home(async (base, env) => {
  await put(path.join(base, "elsewhere", "projects", "-f", `${A}.jsonl`))
  await put(path.join(base, ".claude", "projects", "-f", `${B}.jsonl`))
  const result = await listRootSessions({ ...env, CLAUDE_CONFIG_DIR: path.join(base, "elsewhere") })
  assert.deepEqual(result.hosts["claude-code"].sessions.map((s) => s.id), [A])
}))

test("copilot: counts only session folders that hold events.jsonl", () => home(async (base, env) => {
  const state = path.join(base, ".copilot", "session-state")
  await put(path.join(state, A, "events.jsonl"))
  await put(path.join(state, B, "other.json"))
  await mkdir(path.join(state, C))
  await put(path.join(state, "not-a-uuid", "events.jsonl"))
  await put(path.join(state, `${C}.txt`))
  await mkdir(path.join(state, B, "events.jsonl"))
  const copilot = (await listRootSessions(env)).hosts["copilot-cli"]
  assert.equal(copilot.state, "counted")
  assert.deepEqual(copilot.sessions, [{ name: `copilot-cli-${A}.json`, id: A }])
}))

test("copilot: COPILOT_HOME wins over HOME", () => home(async (base, env) => {
  await put(path.join(base, "cp", "session-state", A, "events.jsonl"))
  const copilot = (await listRootSessions({ ...env, COPILOT_HOME: path.join(base, "cp") })).hosts["copilot-cli"]
  assert.deepEqual(copilot.sessions.map((s) => s.id), [A])
}))

test("codex: counts root rollouts and leaves child rollouts out, reading at most 16 KiB of the first line and caching the answer by name, size and mtime", () => home(async (base, env) => {
  await put(rollout(base, A), codexMeta(A, null))
  await put(rollout(base, B), codexMeta(B, A))
  await put(rollout(base, C, "26"), codexMeta(C, null, { parent_thread_id: null }) + `${"x".repeat(200000)}\n`)
  const first = await listRootSessions(env)
  const codex = first.hosts["codex-cli"]
  assert.equal(codex.state, "counted")
  assert.deepEqual(codex.sessions.map((s) => s.id).sort(), [A, C].sort())
  assert.equal(codex.sessions[0].folder, undefined)
  assert.equal(codex.undetermined, 0)

  // The cache answers again without opening the file: a rollout whose bytes cannot be read still has its cached answer.
  const second = await listRootSessions(env, { cache: first.cache })
  assert.deepEqual(second.hosts["codex-cli"].sessions.map((s) => s.id).sort(), [A, C].sort())
  // A changed size misses the cache and is read again.
  await put(rollout(base, A), codexMeta(A, B))
  const third = await listRootSessions(env, { cache: second.cache })
  assert.deepEqual(third.hosts["codex-cli"].sessions.map((s) => s.id), [C])
  // Entries for files that are gone are dropped from the cache.
  await rm(rollout(base, C, "26"))
  const fourth = await listRootSessions(env, { cache: third.cache })
  assert.equal(Object.keys(fourth.cache).length, 2)
}))

test("codex: a first line that is not a complete session_meta within 16 KiB is undetermined, not counted and not zeroed", () => home(async (base, env) => {
  await put(rollout(base, A), codexMeta(A, null, { instructions: "y".repeat(20000) }))
  await put(rollout(base, B), "not json\n")
  await put(rollout(base, C), `${JSON.stringify({ type: "event_msg", payload: {} })}\n`)
  await put(rollout(base, "6b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f63"), codexMeta("not-a-uuid", null))
  await put(rollout(base, "7b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f64"), "")
  await put(path.join(base, ".codex", "sessions", "2026", "09", "25", "note.txt"))
  await put(path.join(base, ".codex", "sessions", "junk", "09", "25", `rollout-x-${A}.jsonl`))
  const codex = (await listRootSessions(env)).hosts["codex-cli"]
  assert.equal(codex.state, "counted")
  assert.deepEqual(codex.sessions, [])
  assert.equal(codex.undetermined, 5)
}))

test("codex: a child that names its parent only inside source is still a child, and a null parent is a root", () => home(async (base, env) => {
  await put(rollout(base, A), codexMeta(A, null, { source: { subagent: { thread_spawn: { parent_thread_id: B } } } }))
  await put(rollout(base, C), codexMeta(C, null, { source: { subagent: { thread_spawn: {} } }, parent_thread_id: "nope" }))
  const codex = (await listRootSessions(env)).hosts["codex-cli"]
  assert.deepEqual(codex.sessions.map((s) => s.id), [C])
}))

test("a host folder that does not exist is absent, one that cannot be listed is unreadable", () => home(async (base, env) => {
  await put(path.join(base, ".claude", "projects", "-f", `${A}.jsonl`))
  await put(path.join(base, ".copilot", "session-state"), "a file where a folder should be")
  const result = await listRootSessions(env)
  assert.deepEqual(result.hosts["codex-cli"], { state: "absent", sessions: [] })
  assert.deepEqual(result.hosts["copilot-cli"], { state: "unreadable", sessions: [] })
  assert.equal(result.hosts["claude-code"].state, "counted")
  // A project folder that cannot be listed makes the host unreadable rather than a smaller number.
  await put(path.join(base, ".claude", "projects", "-g"), "a file, not a folder")
  assert.equal((await listRootSessions(env)).hosts["claude-code"].state, "counted")
  await put(path.join(base, ".codex", "sessions"), "a file where a folder should be")
  assert.equal((await listRootSessions(env)).hosts["codex-cli"].state, "unreadable")
  // A project folder the process may not list makes the whole host unreadable, never a smaller number.
  if (process.getuid?.() !== 0) {
    await chmod(path.join(base, ".claude", "projects", "-f"), 0)
    try {
      assert.deepEqual((await listRootSessions(env)).hosts["claude-code"], { state: "unreadable", sessions: [] })
    } finally {
      await chmod(path.join(base, ".claude", "projects", "-f"), 0o755)
    }
  }
}))

test("a host past the entry cap or the time budget is capped and lists no sessions", () => home(async (base, env) => {
  for (const id of [A, B, C]) await put(path.join(base, ".claude", "projects", "-f", `${id}.jsonl`))
  await put(path.join(base, ".copilot", "session-state", A, "events.jsonl"))
  await put(rollout(base, A), codexMeta(A, null))
  await put(path.join(base, ".claude", "projects", "-f", `6b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f63.jsonl`))
  await put(path.join(base, ".claude", "projects", "-f", `7b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f64.jsonl`))
  const capped = await listRootSessions(env, { caps: { entriesPerHost: 4, budgetMs: 3000 } })
  assert.deepEqual(capped.hosts["claude-code"], { state: "capped", sessions: [] })
  assert.equal(capped.hosts["copilot-cli"].state, "counted")
  assert.equal(capped.hosts["codex-cli"].state, "counted")
  // The clock jumps past the budget after the first reading.
  let clock = 0
  const slow = await listRootSessions(env, { caps: { entriesPerHost: 100, budgetMs: 10 }, now: () => (clock += 400) })
  assert.deepEqual(slow.hosts, Object.fromEntries(HOSTS.map((host) => [host, { state: "capped", sessions: [] }])))
  assert.ok(COUNT_CAPS.entriesPerHost > 0 && COUNT_CAPS.budgetMs > 0)
  assert.throws(() => { COUNT_CAPS.budgetMs = 1 }, TypeError)
}))

test("no transcript content is kept: sessions hold names, ids and a folder only", () => home(async (base, env) => {
  await put(path.join(base, ".claude", "projects", "-f", `${A}.jsonl`))
  await put(path.join(base, ".copilot", "session-state", B, "events.jsonl"))
  await put(rollout(base, C), codexMeta(C, null))
  const result = await listRootSessions(env)
  const text = JSON.stringify(result)
  assert.ok(!text.includes(SENTINEL))
  for (const host of Object.values(result.hosts)) for (const s of host.sessions) assert.deepEqual(Object.keys(s).filter((k) => !["name", "id", "folder"].includes(k)), [])
  assert.equal(result.hosts["codex-cli"].sessions.length, 1)
}))

test("a symlinked or hard-linked transcript is not counted as a root session", () => home(async (base, env) => {
  const dir = path.join(base, ".claude", "projects", "-f")
  await put(path.join(dir, `${A}.jsonl`))
  await symlink(path.join(dir, `${A}.jsonl`), path.join(dir, `${B}.jsonl`))
  await link(path.join(dir, `${A}.jsonl`), path.join(base, "second-name"))
  await put(path.join(dir, `${C}.jsonl`))
  const state = path.join(base, ".copilot", "session-state")
  await put(path.join(state, A, "events.jsonl"))
  await put(path.join(base, "target", "events.jsonl"))
  await symlink(path.join(base, "target"), path.join(state, B))
  await put(path.join(state, C, "real.jsonl"))
  await symlink(path.join(state, A, "events.jsonl"), path.join(state, C, "events.jsonl"))
  await put(rollout(base, A), codexMeta(A, null))
  await symlink(rollout(base, A), rollout(base, B))
  await put(rollout(base, C, "26"), codexMeta(C, null))
  await link(rollout(base, C, "26"), path.join(base, "other-name"))
  await symlink(path.join(base, ".claude", "projects", "-f"), path.join(base, ".claude", "projects", "-linked"))
  const result = await listRootSessions(env)
  assert.deepEqual(result.hosts["claude-code"].sessions.map((s) => s.id), [C])
  assert.deepEqual(result.hosts["copilot-cli"].sessions.map((s) => s.id), [A])
  assert.deepEqual(result.hosts["codex-cli"].sessions.map((s) => s.id), [A])
}))

test("claudeFolderOf maps a desk root to the folder name the host uses", () => {
  assert.equal(claudeFolderOf("/Users/someone/some-desk"), "-Users-someone-some-desk")
  assert.equal(claudeFolderOf("/Users/someone/.local/state"), "-Users-someone--local-state")
  assert.equal(claudeFolderOf("/tmp/a_b c.d"), "-tmp-a-b-c-d")
  assert.equal(claudeFolderOf("C:\\Users\\me\\desk"), "C--Users-me-desk")
  assert.equal(claudeFolderOf("/Users/s\u00e9ance"), "-Users-s-ance")
})

test("the Codex root rule agrees with deriveCodexSession on the existing fixtures", async () => {
  const fixtureHome = path.join(here, "fixtures", "codex")
  const copy = await realpath(await mkdtemp(path.join(os.tmpdir(), "desk-capture-codex-")))
  try {
    await cp(path.join(fixtureHome, "sessions"), path.join(copy, ".codex", "sessions"), { recursive: true })
    const result = await listRootSessions({ HOME: copy })
    const codex = result.hosts["codex-cli"]
    const listed = new Set(codex.sessions.map((s) => s.id))
    const files = (await readdir(path.join(copy, ".codex", "sessions"), { recursive: true })).filter((f) => f.endsWith(".jsonl"))
    assert.equal(files.length, 8)
    let derivable = 0
    for (const file of files) {
      const id = file.match(/([0-9a-f-]{36})\.jsonl$/u)[1]
      const derived = await deriveCodexSession({ rolloutPath: path.join(copy, ".codex", "sessions", file), codexHome: path.join(copy, ".codex"), plugins: [], endReason: "complete" })
      // Children are the rollouts some root joins, so a derivation that finds an unreadable first record is the only other case.
      if (derived.facts === null) assert.equal(listed.has(id), false)
      else derivable += 1
    }
    const joined = new Set()
    for (const id of listed) {
      const file = files.find((f) => f.includes(id))
      const derived = await deriveCodexSession({ rolloutPath: path.join(copy, ".codex", "sessions", file), codexHome: path.join(copy, ".codex"), plugins: [], endReason: "complete" })
      assert.ok(derived.facts)
      joined.add(derived.facts.agents.length)
    }
    // Roots in the fixtures: root, truncated, unrelated. The five others are children or have no session_meta.
    assert.equal(listed.size, 3)
    assert.equal(codex.undetermined, 1)
    assert.ok(derivable >= listed.size)
    assert.ok([...joined].some((n) => n > 1))
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
})

test("an entry that is a file where a Codex year, month or day folder should be is skipped, and a size change is noticed", () => home(async (base, env) => {
  await put(path.join(base, ".codex", "sessions", "2026", "file-month"))
  await put(rollout(base, A), codexMeta(A, null))
  await truncate(rollout(base, A), 5)
  const codex = (await listRootSessions(env)).hosts["codex-cli"]
  assert.equal(codex.undetermined, 1)
}))

test("a rollout that cannot be opened is undetermined, not a root", { skip: process.getuid?.() === 0 }, () => home(async (base, env) => {
  await put(rollout(base, A), codexMeta(A, null))
  await chmod(rollout(base, A), 0)
  const codex = (await listRootSessions(env)).hosts["codex-cli"]
  assert.deepEqual([codex.sessions, codex.undetermined], [[], 1])
}))

test("only dated folders and rollout files are walked in the Codex tree", () => home(async (base, env) => {
  const month = path.join(base, ".codex", "sessions", "2026", "09")
  await put(path.join(month, "24"))
  await put(path.join(month, "xx", `rollout-x-${A}.jsonl`))
  await put(path.join(base, ".codex", "sessions", "2026", "x9", "25", `rollout-x-${A}.jsonl`))
  await put(rollout(base, B), codexMeta(B, null))
  await mkdir(path.join(month, "25", "rollout-dir.jsonl"), { recursive: true })
  const codex = (await listRootSessions(env)).hosts["codex-cli"]
  assert.deepEqual(codex.sessions.map((s) => s.id), [B])
}))

test("the host homes fall back to the process home only when no variable names them, and a clock that fails is not hidden", () => home(async (base) => {
  await put(path.join(base, "c", "projects", "-f", `${A}.jsonl`))
  const explicit = { CLAUDE_CONFIG_DIR: path.join(base, "c"), COPILOT_HOME: path.join(base, "cp"), CODEX_HOME: path.join(base, "cx") }
  const result = await listRootSessions(explicit)
  assert.deepEqual(result.hosts["claude-code"].sessions.map((s) => s.id), [A])
  assert.equal(result.hosts["copilot-cli"].state, "absent")
  assert.equal(result.hosts["codex-cli"].state, "absent")
  let clock = 0
  await assert.rejects(listRootSessions(explicit, { now: () => { if (clock++ > 0) throw new Error("clock"); return 0 } }), /clock/u)
}))

test("the cache is used: a rollout rewritten at the same size and mtime keeps its cached answer", () => home(async (base, env) => {
  const when = new Date(1_700_000_000_000)
  await put(rollout(base, A), codexMeta(A, null))
  await utimes(rollout(base, A), when, when)
  const first = await listRootSessions(env)
  assert.deepEqual(first.hosts["codex-cli"].sessions.map((s) => s.id), [A])
  // Same length (both ids are 36 characters), same mtime: only the cache can still say A.
  await put(rollout(base, A), codexMeta(C, null))
  await utimes(rollout(base, A), when, when)
  const cached = await listRootSessions(env, { cache: first.cache })
  assert.deepEqual(cached.hosts["codex-cli"].sessions.map((s) => s.id), [A])
  const fresh = await listRootSessions(env)
  assert.deepEqual(fresh.hosts["codex-cli"].sessions.map((s) => s.id), [C])
}))

// A clock that reads 0 for the first `calls` readings and 1000 after, so a budget of 10 ms allows that many readings.
const clockAllowing = (calls) => { let n = 0; return () => (++n <= calls ? 0 : 1000) }

test("a capped Codex pass keeps its progress, so repeated sweeps converge and end counted", () => home(async (base, env) => {
  const ids = [A, B, C]
  for (const id of ids) await put(rollout(base, id), codexMeta(id, null))
  const caps = { entriesPerHost: 100, budgetMs: 10 }
  // Readings: three host starts, year, month, day, three files, then one before each uncached read; 11 allows two reads.
  const old = { "old-key": null }
  const first = await listRootSessions(env, { caps, now: clockAllowing(11), cache: old })
  assert.deepEqual(first.hosts["codex-cli"], { state: "capped", sessions: [] })
  assert.equal(Object.keys(first.cache).length, 3)
  assert.ok("old-key" in first.cache)
  const second = await listRootSessions(env, { caps, now: clockAllowing(11), cache: first.cache })
  assert.equal(second.hosts["codex-cli"].state, "counted")
  assert.deepEqual(second.hosts["codex-cli"].sessions.map((s) => s.id).sort(), [...ids].sort())
  // A pass that counts replaces the cache with exactly what it saw.
  assert.equal(Object.keys(second.cache).length, 3)
}))

test("an absent or unreadable Codex folder returns the old cache unchanged", () => home(async (base, env) => {
  const old = { kept: { id: A, root: true } }
  assert.deepEqual((await listRootSessions(env, { cache: old })).cache, old)
  await put(path.join(base, ".codex", "sessions"), "a file where a folder should be")
  const result = await listRootSessions(env, { cache: old })
  assert.equal(result.hosts["codex-cli"].state, "unreadable")
  assert.deepEqual(result.cache, old)
}))
