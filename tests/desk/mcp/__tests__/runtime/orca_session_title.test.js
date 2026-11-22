// Desk names an Orca terminal after the task its main agent focuses (desk#1478), and never takes a name a person typed.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs"
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
const LOG_FILE = "orca-session-titles.log"
const stateFile = (dir, handle = HANDLE) => path.join(dir, "orca-session-titles", `${handle}.json`)
const seed = (dir, titles, handle = HANDLE) => {
  mkdirSync(path.dirname(stateFile(dir, handle)), { recursive: true })
  writeFileSync(stateFile(dir, handle), JSON.stringify({ titles, requested: null, at: Date.now() }))
}
const recorded = (dir) => JSON.parse(readFileSync(stateFile(dir), "utf8")).titles

const focusResult = (extra = {}) => [{ type: "text", text: JSON.stringify({ status: "focused", track: "desk-plugin", slug: "name-orca", title: "Name Orca sessions", ...extra }) }]
const focusInput = (extra = {}) => ({
  hook_event_name: "PostToolUse",
  tool_name: "mcp__plugin_desk_desk__task_focus",
  tool_input: { track: "desk-plugin", slug: "name-orca" },
  tool_response: focusResult(),
  ...extra,
})

// A fake Orca CLI: one terminal whose title the test controls, recording every call.
function fakeOrca({ title = "claude", agentIdentity = "claude", conditional = false, renameStatus = 0, renameStdout = "", titleAfterRename, showStatus = 0, onShow } = {}) {
  const calls = []
  let current = title
  const run = async (args) => {
    calls.push(args)
    const [group, command] = args
    if (group === "terminal" && command === "show") {
      onShow?.()
      if (showStatus !== 0) return { status: showStatus, stdout: "" }
      return { status: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: HANDLE, title: current, agentIdentity } } }) }
    }
    if (group === "terminal" && command === "rename" && args.includes("--help")) {
      return { status: 0, stdout: `Usage: orca terminal rename [--terminal <handle>] [--title <text>]${conditional ? " [--if-manual-title <text>]" : ""}` }
    }
    if (group === "terminal" && command === "rename") {
      if (renameStatus !== 0) return { status: renameStatus, stdout: renameStdout }
      current = titleAfterRename ?? args[args.indexOf("--title") + 1]
      return { status: 0, stdout: "{}" }
    }
    throw new Error(`unexpected orca call ${args.join(" ")}`)
  }
  return { run, calls, renames: () => calls.filter((args) => args[1] === "rename" && !args.includes("--help")), title: () => current }
}

const name = (orca, dir, extra = {}) => nameOrcaSession({ hookInput: focusInput(), env, runOrca: orca.run, stateDir: dir, platform: "darwin", ...extra })
const logCodes = (dir) => readFileSync(path.join(dir, LOG_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line).code)

test("an Orca default title is replaced by the focused task's title, read back and recorded as Desk's", async () => {
  const dir = stateDir()
  const orca = fakeOrca({ title: "claude" })
  assert.deepEqual(await name(orca, dir), { code: "applied", title: "Name Orca sessions" })
  assert.deepEqual(orca.renames(), [["terminal", "rename", "--terminal", HANDLE, "--title", "Name Orca sessions", "--json"]])
  assert.equal(orca.title(), "Name Orca sessions")
  assert.deepEqual(recorded(dir), ["Name Orca sessions"])
  assert.deepEqual(logCodes(dir), ["applied"])
})

test("a title Desk set earlier is replaced when the session focuses another task, and the older titles stay Desk's", async () => {
  const dir = stateDir()
  seed(dir, ["Older task", "Oldest", "Third", "Fourth"])
  const orca = fakeOrca({ title: "Oldest" })
  assert.equal((await name(orca, dir)).code, "applied")
  assert.equal(orca.title(), "Name Orca sessions")
  assert.deepEqual(recorded(dir), ["Name Orca sessions", "Older task", "Oldest"])
})

test("a title a person typed is kept: Desk never renames over it", async () => {
  const dir = stateDir()
  seed(dir, ["Older task"])
  const orca = fakeOrca({ title: "Ari's own name" })
  assert.deepEqual(await name(orca, dir), { code: "manual_title_kept" })
  assert.deepEqual(orca.renames(), [])
  assert.equal(orca.title(), "Ari's own name")
  assert.deepEqual(recorded(dir), ["Older task"])
  assert.deepEqual(logCodes(dir), ["manual_title_kept"])
})

test("a title Desk set for another terminal does not make this terminal's typed title Desk's", async () => {
  const dir = stateDir()
  seed(dir, ["Ari's own name"], "term_other")
  assert.equal((await name(fakeOrca({ title: "Ari's own name" }), dir)).code, "manual_title_kept")
})

test("outside Orca, and on Windows, nothing runs and the skip is logged", async () => {
  const dir = stateDir()
  const orca = fakeOrca()
  assert.deepEqual(await name(orca, dir, { env: {} }), { code: "not_in_orca" })
  assert.deepEqual(await name(orca, dir, { env: { ORCA_TERMINAL_HANDLE: "active" } }), { code: "not_in_orca" })
  assert.deepEqual(await name(orca, dir, { platform: "win32" }), { code: "unsupported_platform" })
  assert.deepEqual(orca.calls, [])
  assert.deepEqual(logCodes(dir), ["not_in_orca", "not_in_orca", "unsupported_platform"])
})

test("a child agent never renames: a subagent, a headless claude -p started in the same terminal, or a Desk child", async () => {
  const dir = stateDir()
  const orca = fakeOrca()
  assert.deepEqual(await name(orca, dir, { hookInput: focusInput({ agent_id: "a1b2", agent_type: "general-purpose" }) }), { code: "child_agent" })
  for (const childEnv of [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { DESK_READ_ONLY_CHILD: "1" }, { DESK_FACTORY_HEADLESS: "1" }]) {
    assert.deepEqual(await name(orca, dir, { env: { ...env, ...childEnv } }), { code: "child_agent" }, JSON.stringify(childEnv))
  }
  assert.deepEqual(orca.calls, [])
})

test("the main agent of a terminal session, or of one started with --agent, renames", async () => {
  assert.equal((await name(fakeOrca(), stateDir(), { hookInput: focusInput({ agent_type: "desk:worker" }) })).code, "applied")
  assert.equal((await name(fakeOrca(), stateDir(), { env: { ...env, CLAUDE_CODE_ENTRYPOINT: "cli" } })).code, "applied")
})

test("a readback that does not match is logged; the title Desk wrote stays Desk's so naming carries on", async () => {
  const dir = stateDir()
  const orca = fakeOrca({ titleAfterRename: "Someone else" })
  assert.deepEqual(await name(orca, dir), { code: "readback_mismatch" })
  assert.deepEqual(recorded(dir), ["Name Orca sessions"])
  assert.deepEqual(logCodes(dir), ["readback_mismatch"])
})

test("with Orca's conditional rename, Desk asks for no manual name over a default and for its own over its own", async () => {
  const orca = fakeOrca({ title: "⠂ Working", conditional: true })
  assert.equal((await name(orca, stateDir())).code, "applied")
  assert.deepEqual(orca.renames(), [["terminal", "rename", "--terminal", HANDLE, "--title", "Name Orca sessions", "--json", "--if-manual-title", ""]])
  const dir = stateDir()
  seed(dir, ["Older task"])
  const own = fakeOrca({ title: "Older task", conditional: true })
  assert.equal((await name(own, dir)).code, "applied")
  assert.deepEqual(own.renames()[0].slice(-2), ["--if-manual-title", "Older task"])
})

test("a conditional rename Orca refuses is told apart from one that failed", async () => {
  const refused = fakeOrca({ conditional: true, renameStatus: 1, renameStdout: JSON.stringify({ ok: false, error: { code: "terminal_title_changed" } }) })
  assert.deepEqual(await name(refused, stateDir()), { code: "conditional_rename_refused" })
  const failed = fakeOrca({ conditional: true, renameStatus: 1, renameStdout: "timeout" })
  assert.deepEqual(await name(failed, stateDir()), { code: "rename_failed" })
})

test("a rename that fails or throws is logged as rename_failed, and an unreadable help means no conditional flag", async () => {
  assert.deepEqual(await name(fakeOrca({ renameStatus: 1 }), stateDir()), { code: "rename_failed" })
  const throwing = fakeOrca()
  const run = async (args) => {
    if (args[1] === "rename") throw new Error("spawn failed")
    return throwing.run(args)
  }
  assert.deepEqual(await nameOrcaSession({ hookInput: focusInput(), env, runOrca: run, stateDir: stateDir(), platform: "darwin" }), { code: "rename_failed" })
})

test("when a newer focus claims the terminal while this one reads, the older one stands down", async () => {
  const dir = stateDir()
  let claimed = false
  const orca = fakeOrca({
    onShow: () => {
      if (claimed) return
      claimed = true
      writeFileSync(stateFile(dir), JSON.stringify({ titles: [], requested: "newer" }))
    },
  })
  assert.deepEqual(await name(orca, dir), { code: "superseded" })
  assert.deepEqual(orca.renames(), [])
})

test("an unreachable Orca is logged, never thrown", async () => {
  const dir = stateDir()
  const runner = (runOrca) => nameOrcaSession({ hookInput: focusInput(), env, runOrca, stateDir: dir, platform: "darwin" })
  assert.deepEqual(await runner(fakeOrca({ showStatus: 1 }).run), { code: "orca_unavailable" })
  assert.deepEqual(await runner(async () => { throw new Error("spawn ENOENT") }), { code: "orca_unavailable" })
  assert.deepEqual(await runner(async () => ({ status: 0, stdout: "not json" })), { code: "orca_unavailable" })
  assert.deepEqual(await runner(async () => ({ status: 0, stdout: JSON.stringify({ result: { terminal: {} } }) })), { code: "orca_unavailable" })
})

test("a title that already matches is left alone", async () => {
  const orca = fakeOrca({ title: "Name Orca sessions" })
  assert.deepEqual(await name(orca, stateDir()), { code: "unchanged" })
  assert.deepEqual(orca.renames(), [])
})

test("clearing focus, a failed call, other tools and unfocused creates leave the title alone", async () => {
  const orca = fakeOrca()
  const run = (hookInput) => name(orca, stateDir(), { hookInput })
  assert.equal((await run(focusInput({ tool_input: { clear: true }, tool_response: [{ type: "text", text: JSON.stringify({ status: "cleared" }) }] }))).code, "not_focused")
  assert.equal((await run(focusInput({ tool_response: [{ type: "text", text: "card not found" }] }))).code, "no_result")
  assert.equal((await run(focusInput({ tool_response: "plain text" }))).code, "no_result")
  assert.equal((await run(focusInput({ tool_response: [{ type: "text", text: "null" }] }))).code, "no_result")
  assert.equal((await run(focusInput({ tool_name: "mcp__plugin_desk_desk__task_update" }))).code, "not_naming_tool")
  assert.equal((await run(focusInput({ tool_name: undefined }))).code, "not_naming_tool")
  assert.equal((await run({ tool_name: "mcp__plugin_desk_desk__task_create", tool_input: { track: "t", slug: "s", title: "Parked" }, tool_response: [{ type: "text", text: JSON.stringify({ status: "created" }) }] })).code, "not_focused")
  assert.equal((await run(null)).code, "not_naming_tool")
  assert.deepEqual(orca.calls, [])
})

test("an unsafe or missing title stops before Orca is called", async () => {
  const orca = fakeOrca()
  const run = (title) => name(orca, stateDir(), { hookInput: focusInput({ tool_response: focusResult({ title }) }) })
  assert.deepEqual(await run("Read https://example.invalid"), { code: "unsafe_label" })
  assert.deepEqual(await run(undefined), { code: "no_label" })
  assert.deepEqual(orca.calls, [])
})

test("a focused create names the session from its title", async () => {
  const hookInput = {
    tool_name: "mcp__desk__task_create",
    tool_input: { track: "spoonjoy", slug: "covers", title: "Recipe covers load fast", focus: true },
    tool_response: { content: [{ type: "text", text: JSON.stringify({ status: "created", focused: true }) }] },
  }
  assert.deepEqual(await name(fakeOrca({ title: "" }), stateDir(), { hookInput }), { code: "applied", title: "Recipe covers load fast" })
})

test("with no arguments beyond the hook input it reads the process environment and Desk's state folder", async () => {
  assert.deepEqual(await nameOrcaSession({ hookInput: null }), { code: "not_naming_tool" })
})

test("label: the agent's display label wins, else the card title; unsafe text is refused whole", () => {
  const focus = (result, input = { track: "t", slug: "s" }) => orcaTitleFor({ toolName: "mcp__desk__task_focus", toolInput: input, result })
  assert.deepEqual(focus({ status: "focused", title: "Card title", session_label: { proposal: { text: "Authored label" } } }), { title: "Authored label" })
  assert.deepEqual(focus({ status: "focused", title: "  Card   title  " }), { title: "Card title" })
  assert.deepEqual(focus({ status: "focused" }), { code: "no_label" })
  assert.deepEqual(focus({ status: "focused", title: 42 }), { code: "no_label" })
  for (const unsafe of ["See https://example.invalid", "/Users/example/work", "Mail user@example.invalid", "password=hunter2hunter2", "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", "a\u0000b"]) {
    assert.deepEqual(focus({ status: "focused", title: unsafe }), { code: "unsafe_label" }, unsafe)
  }
})

test("label: long titles are cut at a word to the Orca limit with an ellipsis, never inside a character", () => {
  assert.equal(ORCA_TITLE_MAX, 32)
  assert.equal(shortTitle("Name Orca sessions after their focused task"), "Name Orca sessions after their…")
  assert.equal(shortTitle("Supercalifragilisticexpialidocious-and-more-words"), "Supercalifragilisticexpialidoci…")
  assert.equal(shortTitle("Ship it: the first part, the second part"), "Ship it: the first part, the…")
  assert.equal(shortTitle("Exactly thirty-two characters!!!"), "Exactly thirty-two characters!!!")
  const family = "\u{1f468}‍\u{1f469}‍\u{1f467}"
  assert.equal(shortTitle(family.repeat(40)), `${family.repeat(31)}…`)
})

test("Orca's own default titles are recognised, a person's names are not", () => {
  for (const title of ["", "  ", "claude", "Claude Code", "Terminal", "Terminal 3", "zsh", "-zsh", "bash", "desk:worker", "codex", "copilot", "✳ Claude Code", "⠂ Fixing the build", "~/desk", "~", "/tmp", "ari@host:~/desk"]) {
    assert.equal(isOrcaDefaultTitle(title, "claude"), true, title)
  }
  assert.equal(isOrcaDefaultTitle("opencode", "opencode"), true)
  for (const title of ["PR clock", "Inbox: HEY noise cleanup", "claude stuff", "My terminal", "* hotfix", "· notes", "✻ ideas"]) {
    assert.equal(isOrcaDefaultTitle(title, "claude"), false, title)
  }
  assert.equal(isOrcaDefaultTitle(null), false)
})

test("a corrupt record reads as empty, and records untouched for a month are removed when Desk next writes", async () => {
  const dir = stateDir()
  mkdirSync(path.dirname(stateFile(dir)), { recursive: true })
  writeFileSync(stateFile(dir), "{not json")
  assert.equal((await name(fakeOrca(), dir)).code, "applied")
  writeFileSync(stateFile(dir), JSON.stringify({ titles: "not a list", requested: 7 }))
  assert.equal((await name(fakeOrca(), dir)).code, "applied")
  writeFileSync(stateFile(dir), JSON.stringify({ titles: ["Kept", 7] }))
  assert.equal((await name(fakeOrca({ title: "Kept" }), dir)).code, "applied")
  seed(dir, ["Old"], "term_old")
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  utimesSync(stateFile(dir, "term_old"), old, old)
  assert.equal((await name(fakeOrca(), dir)).code, "applied")
  assert.deepEqual(readdirSync(path.join(dir, "orca-session-titles")), [`${HANDLE}.json`])
})

test("the log is rotated once it passes its size limit", async () => {
  const dir = stateDir()
  writeFileSync(path.join(dir, LOG_FILE), "x".repeat(256 * 1024 + 1))
  await name(fakeOrca(), dir, { env: {} })
  assert.deepEqual(logCodes(dir), ["not_in_orca"])
  assert.ok(statSync(path.join(dir, `${LOG_FILE}.old`)).size > 256 * 1024)
})

test("a state folder Desk cannot write still names the session; the record and log fail quietly", async () => {
  const blocked = path.join(stateDir(), "blocked")
  writeFileSync(blocked, "a file where the folder should be")
  assert.equal((await name(fakeOrca(), blocked)).code, "applied")
})

test("the default runner calls the Orca CLI Orca names, with a bounded wait", async () => {
  const run = defaultRunOrca({ ORCA_CLI_COMMAND: process.execPath })
  assert.deepEqual(await run(["-e", "process.stdout.write('args:' + process.argv.slice(1).join(' '))", "terminal", "show"]), { status: 0, stdout: "args:terminal show" })
  assert.equal((await run(["-e", "process.exit(3)"])).status, 3)
  assert.equal((await defaultRunOrca({ ORCA_CLI_COMMAND: path.join(stateDir(), "missing-orca") })(["x"])).status, 1)
  assert.equal(typeof defaultRunOrca({}), "function")
})
