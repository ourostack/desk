// Copilot gives the Desk MCP server no session folder: its working folder is the plugin's own, `roots/list` answers an empty list, and the only per-session value in its environment is COPILOT_AGENT_SESSION_ID.
// The `sessionStart` hook sees the folder and the same session id, so it records both in a file keyed by that id, and the server reads the file every time it resolves its root.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { COPILOT_SESSION_DIR, copilotBootClaimFile, copilotSessionFile, markBootDirected, readCopilotSession, recordCopilotSession } from "../../../../../plugins/desk/mcp/src/runtime/copilot-session.js"
import { resolveStartupActivationConfigPath, resolveStartupDeskRoot } from "../../../../../plugins/desk/mcp/src/runtime/startup-resolve.js"
import { resolveAdmissionInputs } from "../../../../../plugins/desk/mcp/src/runtime/admission-worker.js"

const ROOT = mkdtempSync(path.join(tmpdir(), "copilot-session-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const fresh = (name) => path.join(ROOT, `${name}-${(counter += 1)}`)
const desk = (name = "desk") => {
  const dir = fresh(name)
  mkdirSync(path.join(dir, "_meta"), { recursive: true })
  mkdirSync(path.join(dir, "_archive"), { recursive: true })
  return dir
}
// An environment with its own HOME and state folder, so nothing leaks from the machine that runs the tests.
const envFor = (extra = {}) => {
  const home = fresh("home")
  mkdirSync(home, { recursive: true })
  return { HOME: home, XDG_STATE_HOME: path.join(home, "state"), ...extra }
}
const stateDirOf = (env) => path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk")

test("the record lives under a digest of the session id, so no id can name another path", () => {
  const file = copilotSessionFile("/state", "../../etc/passwd")
  assert.equal(path.dirname(file), path.join("/state", COPILOT_SESSION_DIR))
  assert.match(path.basename(file), /^[0-9a-f]{32}\.json$/u)
  assert.notEqual(copilotSessionFile("/state", "a"), copilotSessionFile("/state", "b"))
  assert.equal(copilotSessionFile("/state", "a"), copilotSessionFile("/state", "a"))
})

test("the hook records the session folder and the saved binding it saw, and the server reads them back", () => {
  const env = envFor()
  const folder = desk()
  const binding = path.join(fresh("plugin-data"), "desk.activation.json")
  mkdirSync(path.dirname(binding), { recursive: true })
  writeFileSync(binding, "{}")
  const wrote = recordCopilotSession({ sessionId: "s-1", folder, activationConfig: binding, env })
  assert.equal(wrote, true)
  const file = copilotSessionFile(stateDirOf(env), "s-1")
  assert.equal((statSync(file).mode & 0o777), 0o600)
  assert.equal((statSync(path.dirname(file)).mode & 0o777), 0o700)
  assert.deepEqual(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "s-1" } }), { folder, activationConfig: binding })
})

test("a record with no saved binding reads back with none", () => {
  const env = envFor()
  const folder = desk()
  recordCopilotSession({ sessionId: "s-2", folder, activationConfig: null, env })
  assert.deepEqual(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "s-2" } }), { folder, activationConfig: null })
})

test("a hook without a usable id or folder records nothing", () => {
  const env = envFor()
  for (const input of [{ sessionId: "", folder: "/x" }, { sessionId: undefined, folder: "/x" }, { sessionId: "s", folder: "" }, { sessionId: "s", folder: "relative/dir" }, { sessionId: "s", folder: undefined }]) {
    assert.equal(recordCopilotSession({ ...input, env }), false)
  }
  assert.equal(existsSync(stateDirOf(env)), false)
})

test("a write failure is swallowed: the hook must never block a session start", () => {
  const env = envFor()
  mkdirSync(path.dirname(stateDirOf(env)), { recursive: true })
  // A file where the state folder should be makes the write impossible.
  writeFileSync(stateDirOf(env), "in the way")
  assert.equal(recordCopilotSession({ sessionId: "s", folder: desk(), env }), false)
})

test("the server reads nothing when it has no session id, no record, or a record it cannot trust", () => {
  const env = envFor()
  assert.equal(readCopilotSession({ env }), null, "no session id")
  assert.equal(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "" } }), null, "empty session id")
  assert.equal(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "never-recorded" } }), null, "no record")
  const write = (id, text) => {
    const file = copilotSessionFile(stateDirOf(env), id)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const read = (id) => readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: id } })
  write("garbled", "{not json")
  write("array", "[]")
  write("future", JSON.stringify({ version: 2, folder: "/x" }))
  write("relative", JSON.stringify({ version: 1, folder: "x/y" }))
  write("no-folder", JSON.stringify({ version: 1 }))
  write("odd-binding", JSON.stringify({ version: 1, folder: "/x", activation_config: 7 }))
  write("relative-binding", JSON.stringify({ version: 1, folder: "/x", activation_config: "b.json" }))
  for (const id of ["garbled", "array", "future", "relative", "no-folder"]) assert.equal(read(id), null, id)
  // A record whose binding path is unusable still gives the folder.
  assert.deepEqual(read("odd-binding"), { folder: "/x", activationConfig: null })
  assert.deepEqual(read("relative-binding"), { folder: "/x", activationConfig: null })
})

test("concurrent sessions keep separate records, and recording again replaces a session's own", () => {
  const env = envFor()
  const [one, two, three] = [desk("one"), desk("two"), desk("three")]
  recordCopilotSession({ sessionId: "a", folder: one, env })
  recordCopilotSession({ sessionId: "b", folder: two, env })
  const readAs = (id) => readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: id } }).folder
  assert.equal(readAs("a"), one)
  assert.equal(readAs("b"), two)
  recordCopilotSession({ sessionId: "a", folder: three, env })
  assert.equal(readAs("a"), three, "a resumed session records again")
  assert.equal(readAs("b"), two)
  assert.deepEqual(readdirSync(path.join(stateDirOf(env), COPILOT_SESSION_DIR)).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind")
})

test("recording prunes records no session has touched for a month, and no one else's files", () => {
  const env = envFor()
  recordCopilotSession({ sessionId: "old", folder: desk(), env })
  recordCopilotSession({ sessionId: "recent", folder: desk(), env })
  const dir = path.join(stateDirOf(env), COPILOT_SESSION_DIR)
  const long = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  utimesSync(copilotSessionFile(stateDirOf(env), "old"), long, long)
  mkdirSync(path.join(dir, "a-folder"))
  utimesSync(path.join(dir, "a-folder"), long, long)
  recordCopilotSession({ sessionId: "new", folder: desk(), env })
  assert.equal(existsSync(copilotSessionFile(stateDirOf(env), "old")), false)
  assert.equal(existsSync(copilotSessionFile(stateDirOf(env), "recent")), true)
  assert.equal(existsSync(copilotSessionFile(stateDirOf(env), "new")), true)
  assert.equal(existsSync(path.join(dir, "a-folder")), true, "a directory is not a record and is left alone")
})

test("the server binds the desk the hook recorded, even though the server started first", () => {
  const env = envFor({ COPILOT_AGENT_SESSION_ID: "s-bind" })
  const folder = desk()
  const home = env.HOME
  // Before the hook runs there is nothing to bind: the server answers setup_required and retries on every call.
  assert.throws(() => resolveStartupDeskRoot({ env, homeDir: home }), (error) => error.code === "DESK_ROOT_NOT_FOUND")
  recordCopilotSession({ sessionId: "s-bind", folder, env })
  const bound = resolveStartupDeskRoot({ env, homeDir: home })
  assert.equal(bound.root, path.resolve(folder))
  assert.equal(bound.source, "host-project")
  // The same call through admission's own entry point.
  assert.equal(resolveAdmissionInputs({ args: {}, env, cwd: home, homeDir: home }).root.root, path.resolve(folder))
})

test("a session never binds another session's desk", () => {
  const env = envFor()
  const mine = desk("mine")
  const theirs = desk("theirs")
  recordCopilotSession({ sessionId: "mine", folder: mine, env })
  recordCopilotSession({ sessionId: "theirs", folder: theirs, env })
  assert.equal(resolveStartupDeskRoot({ env: { ...env, COPILOT_AGENT_SESSION_ID: "mine" }, homeDir: env.HOME }).root, path.resolve(mine))
  assert.equal(resolveStartupDeskRoot({ env: { ...env, COPILOT_AGENT_SESSION_ID: "theirs" }, homeDir: env.HOME }).root, path.resolve(theirs))
  assert.throws(() => resolveStartupDeskRoot({ env: { ...env, COPILOT_AGENT_SESSION_ID: "a-third" }, homeDir: env.HOME }), (error) => error.code === "DESK_ROOT_NOT_FOUND")
})

test("a stale record falls through to the other bindings: a folder that is no longer a desk binds nothing", () => {
  const env = envFor({ COPILOT_AGENT_SESSION_ID: "s-stale" })
  const folder = desk()
  recordCopilotSession({ sessionId: "s-stale", folder, env })
  rmSync(path.join(folder, "_meta"), { recursive: true })
  assert.throws(() => resolveStartupDeskRoot({ env, homeDir: env.HOME }), (error) => error.code === "DESK_ROOT_NOT_FOUND")
  const fallback = desk("fallback")
  assert.equal(resolveStartupDeskRoot({ env: { ...env, DESK: fallback }, homeDir: env.HOME }).source, "env:DESK", "$DESK still binds")
  // A project folder that is a desk wins over $DESK, as it does on Claude Code.
  const other = desk("other")
  recordCopilotSession({ sessionId: "s-stale", folder: other, env })
  assert.equal(resolveStartupDeskRoot({ env: { ...env, DESK: fallback }, homeDir: env.HOME }).root, path.resolve(other))
})

test("the Copilot session record, when one exists, wins over an inherited CLAUDE_PROJECT_DIR; without a record CLAUDE_PROJECT_DIR binds", () => {
  const env = envFor({ COPILOT_AGENT_SESSION_ID: "s-claude" })
  const recorded = desk("recorded")
  const projectDir = desk("project")
  recordCopilotSession({ sessionId: "s-claude", folder: recorded, env })
  assert.equal(resolveStartupDeskRoot({ env: { ...env, CLAUDE_PROJECT_DIR: projectDir }, homeDir: env.HOME }).root, path.resolve(recorded), "a CLAUDE_PROJECT_DIR the shell inherited does not override the session's own folder")
  assert.equal(resolveStartupDeskRoot({ env: { ...env, CLAUDE_PROJECT_DIR: "" }, homeDir: env.HOME }).root, path.resolve(recorded), "an empty value is no value")
  const norecord = envFor({ COPILOT_AGENT_SESSION_ID: "s-none" })
  assert.equal(resolveStartupDeskRoot({ env: { ...norecord, CLAUDE_PROJECT_DIR: projectDir }, homeDir: norecord.HOME }).root, path.resolve(projectDir), "no record: Claude's project folder binds")
  const claude = envFor()
  assert.equal(resolveStartupDeskRoot({ env: { ...claude, CLAUDE_PROJECT_DIR: projectDir }, homeDir: claude.HOME }).root, path.resolve(projectDir), "no session id at all: Claude's project folder binds")
})

test("the saved binding the hook saw is the server's too, because Copilot gives the server no plugin data folder", () => {
  const env = envFor({ COPILOT_AGENT_SESSION_ID: "s-saved" })
  const saved = desk("saved")
  const notDesk = fresh("not-a-desk")
  mkdirSync(notDesk, { recursive: true })
  const binding = path.join(fresh("plugin-data"), "desk.activation.json")
  mkdirSync(path.dirname(binding), { recursive: true })
  writeFileSync(binding, JSON.stringify({ schema_version: 1, desk: { root: saved } }))
  recordCopilotSession({ sessionId: "s-saved", folder: notDesk, activationConfig: binding, env })
  assert.equal(resolveStartupActivationConfigPath({ args: {}, env }), binding)
  const bound = resolveStartupDeskRoot({ args: {}, env, homeDir: env.HOME })
  assert.equal(bound.root, path.resolve(saved))
  assert.equal(bound.source, "activation-config")
  // The server's own configuration, when it has any, wins over the hook's record.
  const own = path.join(fresh("own"), "own.json")
  mkdirSync(path.dirname(own), { recursive: true })
  writeFileSync(own, JSON.stringify({ schema_version: 1, desk: { root: desk("own-desk") } }))
  assert.equal(resolveStartupActivationConfigPath({ args: {}, env: { ...env, DESK_ACTIVATION_CONFIG: own } }), own)
  // A binding file that has gone is not used.
  rmSync(binding)
  assert.equal(resolveStartupActivationConfigPath({ args: {}, env }), null)
})

test("the record file is plain JSON a person can read, naming only the folder, the binding and when it was written", () => {
  const env = envFor()
  const folder = desk()
  recordCopilotSession({ sessionId: "s-json", folder, activationConfig: null, env, now: () => 1790000000000 })
  const record = JSON.parse(readFileSync(copilotSessionFile(stateDirOf(env), "s-json"), "utf8"))
  assert.deepEqual(record, { version: 1, folder, activation_config: null, recorded_at: new Date(1790000000000).toISOString() })
})

test("the boot direction is claimed once per session id, before or after the sessionStart hook has recorded the session", () => {
  const env = envFor()
  const folder = desk()
  // Copilot fires the first prompt's hook before sessionStart: no record exists yet, and the first prompt is directed anyway.
  assert.equal(markBootDirected({ sessionId: "boot-new", env }), true, "the first prompt is directed with no record")
  assert.equal(markBootDirected({ sessionId: "boot-new", env }), false, "a later prompt is not")
  // The claim binds nothing and is not the record: the server reads no folder from it, and the record's file does not exist.
  assert.equal(existsSync(copilotSessionFile(stateDirOf(env), "boot-new")), false)
  assert.equal(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "boot-new" } }), null)
  // sessionStart then records the folder; the claim is its own file, so neither write touches the other.
  assert.equal(recordCopilotSession({ sessionId: "boot-new", folder, source: "new", env }), true)
  assert.equal(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "boot-new" } }).folder, folder)
  assert.equal(existsSync(copilotBootClaimFile(stateDirOf(env), "boot-new")), true)
  assert.equal(markBootDirected({ sessionId: "boot-new", env }), false)
  // A start record with no source (an older payload) clears nothing either.
  recordCopilotSession({ sessionId: "boot-new", folder, env })
  assert.equal(markBootDirected({ sessionId: "boot-new", env }), false)
  // A resumed session clears the claim, so its next prompt is directed again, once, and the record is unchanged.
  recordCopilotSession({ sessionId: "boot-new", folder, source: "resume", env })
  assert.equal(existsSync(copilotBootClaimFile(stateDirOf(env), "boot-new")), false)
  assert.equal(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "boot-new" } }).folder, folder)
  assert.equal(markBootDirected({ sessionId: "boot-new", env }), true)
  assert.equal(markBootDirected({ sessionId: "boot-new", env }), false)
  // Resuming a session that never claimed is harmless.
  assert.equal(recordCopilotSession({ sessionId: "boot-fresh-resume", folder, source: "resume", env }), true)

  // A session with no usable id claims nothing.
  assert.equal(markBootDirected({ sessionId: "", env }), false)
  assert.equal(markBootDirected({ sessionId: undefined, env }), false)
  // A claim file that cannot be created (its place is taken by a folder) claims nothing, and a claim that cannot be cleared leaves the record written.
  const claim = copilotBootClaimFile(stateDirOf(env), "boot-ro")
  mkdirSync(claim)
  assert.equal(markBootDirected({ sessionId: "boot-ro", env }), false)
  assert.equal(recordCopilotSession({ sessionId: "boot-ro", folder, source: "resume", env }), true)
  assert.ok(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "boot-ro" } }))
  // The record write can fail without the claim being involved.
  const ro = copilotSessionFile(stateDirOf(env), "boot-ro-record")
  mkdirSync(ro)
  assert.equal(recordCopilotSession({ sessionId: "boot-ro-record", folder, env }), false)
})

test("concurrent first prompts claim exactly once, and a record written in the middle does not lose the claim", async () => {
  const env = envFor()
  const folder = desk()
  const module = new URL("../../../../../plugins/desk/mcp/src/runtime/copilot-session.js", import.meta.url).href
  const script = `import { markBootDirected, recordCopilotSession } from ${JSON.stringify(module)}
const env = JSON.parse(process.argv[1])
if (process.argv[2] === "record") process.stdout.write(String(recordCopilotSession({ sessionId: "race", folder: process.argv[3], source: "new", env })))
else process.stdout.write(String(markBootDirected({ sessionId: "race", env })))`
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(env), ...args], { env: { ...process.env, ...env } })
    let out = ""
    child.stdout.on("data", (d) => { out += d })
    child.on("close", () => resolve(out))
  })
  const results = await Promise.all([run("claim"), run("claim"), run("record", folder), run("claim"), run("claim"), run("record", folder)])
  assert.equal(results.filter((r, i) => r === "true" && ![2, 5].includes(i)).length, 1, `exactly one claim wins: ${results}`)
  assert.equal(results[2], "true")
  assert.equal(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "race" } }).folder, folder, "the record survived the claims")
  assert.equal(markBootDirected({ sessionId: "race", env }), false, "the claim survived the records")
})

test("every entry point has a safe default environment: no argument, no session id and no record claim nothing", () => {
  assert.equal(recordCopilotSession(), false)
  assert.equal(readCopilotSession(), null)
  assert.equal(markBootDirected(), false)
  // With no environment given, the claim goes under the process's own state folder (the isolated one under test) and is still once per session id.
  assert.equal(markBootDirected({ sessionId: "default-env-session" }), true)
  assert.equal(markBootDirected({ sessionId: "default-env-session" }), false)
  assert.equal(readCopilotSession({}), null)
})
