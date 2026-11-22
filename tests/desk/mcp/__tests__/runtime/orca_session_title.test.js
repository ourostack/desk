// Desk names an Orca terminal after the task its main agent focuses (desk#1478), and never takes a name a person typed.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  ORCA_TITLE_MAX,
  nameOrcaSession,
  orcaTitleFor,
  isOrcaDefaultTitle,
  shortTitle,
  defaultRunOrca,
} from "../../../../../plugins/desk/mcp/src/runtime/orca-session-title.js"

const HANDLE = "term_0b1c2d3e-0000-4000-8000-000000000001"
const env = { ORCA_TERMINAL_HANDLE: HANDLE }
const stateDir = () => mkdtempSync(path.join(os.tmpdir(), "orca-title-"))
const STATE_FILE = "orca-session-titles.json"
const LOG_FILE = "orca-session-titles.log"

const focusResult = (extra = {}) => [{ type: "text", text: JSON.stringify({ status: "focused", track: "desk-plugin", slug: "name-orca", title: "Name Orca sessions", ...extra }) }]
const focusInput = (extra = {}) => ({
  hook_event_name: "PostToolUse",
  tool_name: "mcp__plugin_desk_desk__task_focus",
  tool_input: { track: "desk-plugin", slug: "name-orca" },
  tool_response: focusResult(),
  ...extra,
})

// A fake Orca CLI: one terminal whose title the test controls, recording every call.
function fakeOrca({ title = "claude", agentIdentity = "claude", conditional = false, renameStatus = 0, titleAfterRename, showStatus = 0 } = {}) {
  const calls = []
  let current = title
  const run = async (args) => {
    calls.push(args)
    const [group, command] = args
    if (group === "terminal" && command === "show") {
      if (showStatus !== 0) return { status: showStatus, stdout: "" }
      return { status: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: HANDLE, title: current, agentIdentity } } }) }
    }
    if (group === "terminal" && command === "rename" && args.includes("--help")) {
      return { status: 0, stdout: `Usage: orca terminal rename [--terminal <handle>] [--title <text>]${conditional ? " [--if-title <text>]" : ""}` }
    }
    if (group === "terminal" && command === "rename") {
      if (renameStatus !== 0) return { status: renameStatus, stdout: "" }
      current = titleAfterRename ?? args[args.indexOf("--title") + 1]
      return { status: 0, stdout: "{}" }
    }
    throw new Error(`unexpected orca call ${args.join(" ")}`)
  }
  return { run, calls, renames: () => calls.filter((args) => args[1] === "rename" && !args.includes("--help")), title: () => current }
}

const logCodes = (dir) => readFileSync(path.join(dir, LOG_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line).code)

test("an Orca default title is replaced by the focused task's title, read back and recorded as Desk's", async () => {
  const dir = stateDir()
  const orca = fakeOrca({ title: "claude" })
  const outcome = await nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: dir, now: () => 1000 })
  assert.deepEqual(outcome, { code: "applied", title: "Name Orca sessions" })
  assert.deepEqual(orca.renames(), [["terminal", "rename", "--terminal", HANDLE, "--title", "Name Orca sessions", "--json"]])
  assert.equal(orca.title(), "Name Orca sessions")
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, STATE_FILE), "utf8")).terminals[HANDLE], { title: "Name Orca sessions", at: 1000 })
  assert.deepEqual(logCodes(dir), ["applied"])
})

test("a title Desk set earlier is replaced when the session focuses another task", async () => {
  const dir = stateDir()
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ terminals: { [HANDLE]: { title: "Older task", at: 1 } } }))
  const orca = fakeOrca({ title: "Older task" })
  const outcome = await nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: dir })
  assert.equal(outcome.code, "applied")
  assert.equal(orca.title(), "Name Orca sessions")
})

test("a title a person typed is kept: Desk never renames over it", async () => {
  const dir = stateDir()
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ terminals: { [HANDLE]: { title: "Older task", at: 1 } } }))
  const orca = fakeOrca({ title: "Ari's own name" })
  const outcome = await nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: dir })
  assert.deepEqual(outcome, { code: "manual_title_kept" })
  assert.deepEqual(orca.renames(), [])
  assert.equal(orca.title(), "Ari's own name")
  assert.deepEqual(logCodes(dir), ["manual_title_kept"])
})

test("a title Desk set for another terminal does not make this terminal's typed title Desk's", async () => {
  const dir = stateDir()
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ terminals: { term_other: { title: "Ari's own name", at: 1 } } }))
  const orca = fakeOrca({ title: "Ari's own name" })
  assert.equal((await nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: dir })).code, "manual_title_kept")
})

test("outside Orca nothing runs and the skip is logged", async () => {
  const dir = stateDir()
  const orca = fakeOrca()
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env: {}, runOrca: orca.run, stateDir: dir }), { code: "not_in_orca" })
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env: { ORCA_TERMINAL_HANDLE: "active" }, runOrca: orca.run, stateDir: dir }), { code: "not_in_orca" })
  assert.deepEqual(orca.calls, [])
  assert.deepEqual(logCodes(dir), ["not_in_orca", "not_in_orca"])
})

test("a child agent never renames: a subagent's hook input carries agent_id, and Desk's own children are flagged in the environment", async () => {
  const dir = stateDir()
  const orca = fakeOrca()
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput({ agent_id: "a1b2", agent_type: "general-purpose" }), env, runOrca: orca.run, stateDir: dir }), { code: "child_agent" })
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env: { ...env, DESK_READ_ONLY_CHILD: "1" }, runOrca: orca.run, stateDir: dir }), { code: "child_agent" })
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env: { ...env, DESK_FACTORY_HEADLESS: "1" }, runOrca: orca.run, stateDir: dir }), { code: "child_agent" })
  assert.deepEqual(orca.calls, [])
})

test("a main thread started with --agent (agent_type without agent_id) is the main agent", async () => {
  const orca = fakeOrca()
  assert.equal((await nameOrcaSession({ hookInput: focusInput({ agent_type: "desk:worker" }), env, runOrca: orca.run, stateDir: stateDir() })).code, "applied")
})

test("a readback that does not match is logged and not recorded as Desk's title", async () => {
  const dir = stateDir()
  const orca = fakeOrca({ titleAfterRename: "Someone else" })
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: dir }), { code: "readback_mismatch" })
  assert.throws(() => readFileSync(path.join(dir, STATE_FILE)), { code: "ENOENT" })
  assert.deepEqual(logCodes(dir), ["readback_mismatch"])
})

test("when Orca supports a conditional rename, Desk passes the title it read so a racing manual rename wins", async () => {
  const dir = stateDir()
  const orca = fakeOrca({ title: "claude", conditional: true })
  assert.equal((await nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: dir })).code, "applied")
  assert.deepEqual(orca.renames(), [["terminal", "rename", "--terminal", HANDLE, "--title", "Name Orca sessions", "--json", "--if-title", "claude"]])
  const refused = fakeOrca({ title: "claude", conditional: true, renameStatus: 1 })
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: refused.run, stateDir: dir }), { code: "conditional_rename_refused" })
})

test("an unconditional rename that fails or throws is logged as rename_failed", async () => {
  const orca = fakeOrca({ renameStatus: 1 })
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: stateDir() }), { code: "rename_failed" })
  const throwing = fakeOrca()
  const run = async (args) => {
    if (args[1] === "rename" && !args.includes("--help")) throw new Error("spawn failed")
    return throwing.run(args)
  }
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: run, stateDir: stateDir() }), { code: "rename_failed" })
})

test("an unsafe or missing title stops before Orca is called", async () => {
  const orca = fakeOrca()
  const run = (title) => nameOrcaSession({ hookInput: focusInput({ tool_response: focusResult({ title }) }), env, runOrca: orca.run, stateDir: stateDir() })
  assert.deepEqual(await run("Read https://example.invalid"), { code: "unsafe_label" })
  assert.deepEqual(await run(undefined), { code: "no_label" })
  assert.deepEqual(orca.calls, [])
})

test("with no arguments beyond the hook input it reads the process environment and Desk's state folder", async () => {
  assert.deepEqual(await nameOrcaSession({ hookInput: null }), { code: "not_naming_tool" })
})

test("an unreachable Orca is logged, never thrown", async () => {
  const dir = stateDir()
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: fakeOrca({ showStatus: 1 }).run, stateDir: dir }), { code: "orca_unavailable" })
  const throwing = async () => { throw new Error("spawn ENOENT") }
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: throwing, stateDir: dir }), { code: "orca_unavailable" })
  const garbage = async () => ({ status: 0, stdout: "not json" })
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: garbage, stateDir: dir }), { code: "orca_unavailable" })
  const noTitle = async () => ({ status: 0, stdout: JSON.stringify({ result: { terminal: {} } }) })
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: noTitle, stateDir: dir }), { code: "orca_unavailable" })
})

test("a title that already matches is left alone", async () => {
  const dir = stateDir()
  const orca = fakeOrca({ title: "Name Orca sessions" })
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ terminals: { [HANDLE]: { title: "Name Orca sessions", at: 1 } } }))
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: dir }), { code: "unchanged" })
  assert.deepEqual(orca.renames(), [])
})

test("a matching title Desk did not set stays the person's: it is not adopted as Desk's", async () => {
  const dir = stateDir()
  const orca = fakeOrca({ title: "Name Orca sessions" })
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: dir }), { code: "unchanged" })
  assert.throws(() => readFileSync(path.join(dir, STATE_FILE)), { code: "ENOENT" })
})

test("clearing focus, a failed call, other tools and unfocused creates leave the title alone", async () => {
  const orca = fakeOrca()
  const run = (hookInput) => nameOrcaSession({ hookInput, env, runOrca: orca.run, stateDir: stateDir() })
  assert.equal((await run(focusInput({ tool_input: { clear: true }, tool_response: [{ type: "text", text: JSON.stringify({ status: "cleared" }) }] }))).code, "not_focused")
  assert.equal((await run(focusInput({ tool_response: [{ type: "text", text: "card not found" }] }))).code, "no_result")
  assert.equal((await run(focusInput({ tool_name: "mcp__plugin_desk_desk__task_update" }))).code, "not_naming_tool")
  assert.equal((await run(focusInput({ tool_name: undefined }))).code, "not_naming_tool")
  assert.equal((await run({ tool_name: "mcp__plugin_desk_desk__task_create", tool_input: { track: "t", slug: "s", title: "Parked" }, tool_response: [{ type: "text", text: JSON.stringify({ status: "created" }) }] })).code, "not_focused")
  assert.equal((await run(null)).code, "not_naming_tool")
  assert.equal((await run(focusInput({ tool_response: "plain text" }))).code, "no_result")
  assert.equal((await run(focusInput({ tool_response: [{ type: "text", text: "null" }] }))).code, "no_result")
  assert.deepEqual(orca.calls, [])
})

test("a focused create names the session from its title", async () => {
  const orca = fakeOrca({ title: "" })
  const hookInput = {
    tool_name: "mcp__desk__task_create",
    tool_input: { track: "spoonjoy", slug: "covers", title: "Recipe covers load fast", focus: true },
    tool_response: { content: [{ type: "text", text: JSON.stringify({ status: "created", focused: true }) }] },
  }
  assert.deepEqual(await nameOrcaSession({ hookInput, env, runOrca: orca.run, stateDir: stateDir() }), { code: "applied", title: "Recipe covers load fast" })
})

test("label: the agent's display label wins, else the card title; unsafe text is refused whole", () => {
  const focus = (result, input = { track: "t", slug: "s" }) => orcaTitleFor({ toolName: "mcp__desk__task_focus", toolInput: input, result })
  assert.deepEqual(focus({ status: "focused", title: "Card title", session_label: { proposal: { text: "Authored label" } } }), { title: "Authored label" })
  assert.deepEqual(focus({ status: "focused", title: "  Card   title  " }), { title: "Card title" })
  assert.deepEqual(focus({ status: "focused" }), { code: "no_label" })
  assert.deepEqual(focus({ status: "focused", title: 42 }), { code: "no_label" })
  for (const unsafe of ["See https://example.invalid", "/Users/example/work", "Mail user@example.invalid", "password=hunter2hunter2", "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", "a\u0000b", "~/desk"]) {
    assert.deepEqual(focus({ status: "focused", title: unsafe }), { code: "unsafe_label" }, unsafe)
  }
})

test("label: long titles are cut at a word to the Orca limit with an ellipsis", () => {
  assert.equal(ORCA_TITLE_MAX, 32)
  assert.equal(shortTitle("Name Orca sessions after their focused task"), "Name Orca sessions after their…")
  assert.equal([...shortTitle("Name Orca sessions after their focused task")].length <= ORCA_TITLE_MAX, true)
  assert.equal(shortTitle("Supercalifragilisticexpialidocious-and-more-words"), "Supercalifragilisticexpialidoci…")
  assert.equal(shortTitle("Ship it: the first part, the second part"), "Ship it: the first part, the…")
  assert.equal(shortTitle("Exactly thirty-two characters!!!"), "Exactly thirty-two characters!!!")
  assert.equal(shortTitle(String.fromCodePoint(0x1f9ea).repeat(40)), `${String.fromCodePoint(0x1f9ea).repeat(31)}…`)
})

test("Orca's own default titles are recognised, a person's names are not", () => {
  for (const title of ["", "  ", "claude", "Claude Code", "Terminal", "Terminal 3", "zsh", "-zsh", "bash", "desk:worker", "codex", "copilot", "✳ Claude Code", "⠂ Fixing the build", "✳ Name things"]) {
    assert.equal(isOrcaDefaultTitle(title, "claude"), true, title)
  }
  assert.equal(isOrcaDefaultTitle("opencode", "opencode"), true)
  for (const title of ["PR clock", "Inbox: HEY noise cleanup", "claude stuff", "My terminal"]) {
    assert.equal(isOrcaDefaultTitle(title, "claude"), false, title)
  }
  assert.equal(isOrcaDefaultTitle(null), false)
})

test("a corrupt state file reads as empty, and old entries are pruned when Desk records a new title", async () => {
  const dir = stateDir()
  writeFileSync(path.join(dir, STATE_FILE), "{not json")
  assert.equal((await nameOrcaSession({ hookInput: focusInput(), env, runOrca: fakeOrca().run, stateDir: dir })).code, "applied")
  const day = 24 * 60 * 60 * 1000
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ terminals: { term_old: { title: "Old", at: 0 }, term_bad: null, term_recent: { title: "Recent", at: 40 * day } } }))
  assert.equal((await nameOrcaSession({ hookInput: focusInput(), env, runOrca: fakeOrca().run, stateDir: dir, now: () => 60 * day })).code, "applied")
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(dir, STATE_FILE), "utf8")).terminals).sort(), [HANDLE, "term_recent"])
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify([]))
  assert.equal((await nameOrcaSession({ hookInput: focusInput(), env, runOrca: fakeOrca().run, stateDir: dir })).code, "applied")
})

test("a state folder Desk cannot write still names the session; the record and log fail quietly", async () => {
  const dir = stateDir()
  const blocked = path.join(dir, "blocked")
  writeFileSync(blocked, "a file where the folder should be")
  assert.equal((await nameOrcaSession({ hookInput: focusInput(), env, runOrca: fakeOrca().run, stateDir: blocked })).code, "applied")
})

test("the default runner calls the Orca CLI Orca names, with a bounded wait", async () => {
  const run = defaultRunOrca({ ORCA_CLI_COMMAND: process.execPath })
  assert.deepEqual(await run(["-e", "process.stdout.write('args:' + process.argv.slice(1).join(' '))", "terminal", "show"]), { status: 0, stdout: "args:terminal show" })
  assert.equal((await run(["-e", "process.exit(3)"])).status, 3)
  assert.equal((await defaultRunOrca({ ORCA_CLI_COMMAND: path.join(stateDir(), "missing-orca") })(["x"])).status, 1)
  assert.equal(typeof defaultRunOrca({}), "function")
})
