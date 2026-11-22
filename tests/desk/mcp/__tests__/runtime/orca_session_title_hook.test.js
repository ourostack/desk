// The PostToolUse hook that hands a finished task_focus or task_create to the Orca tab naming (desk#1478).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough, Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { readInput, runHook } from "../../../../../plugins/desk/hooks/lib/orca-session-title.cjs"

const repository = fileURLToPath(new URL("../../../../../", import.meta.url))
const SCRIPT = path.join(repository, "plugins", "desk", "hooks", "orca-session-title.cjs")

test("hooks.json runs the Orca naming hook in the background after Desk's focusing tools only", () => {
  const hooks = JSON.parse(readFileSync(path.join(repository, "plugins", "desk", "hooks", "hooks.json"), "utf8"))
  const [entry, ...others] = hooks.hooks.PostToolUse
  assert.deepEqual(others, [])
  const matcher = new RegExp(entry.matcher, "u")
  for (const name of ["mcp__plugin_desk_desk__task_focus", "mcp__plugin_desk_desk__task_create", "mcp__desk__task_focus", "mcp__desk__task_create"]) assert.match(name, matcher)
  for (const name of ["mcp__plugin_desk_desk__task_update", "mcp__other__task_focus", "Bash", "mcp__plugin_desk_desk__task_focus_extra"]) assert.doesNotMatch(name, matcher)
  assert.deepEqual(entry.hooks, [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/orca-session-title.cjs"', timeout: 15, async: true }])
})

test("readInput takes one JSON object and nothing else", async () => {
  assert.deepEqual(await readInput(Readable.from([Buffer.from('{"tool_name":'), Buffer.from('"x"}')])), { tool_name: "x" })
  assert.equal(await readInput(Readable.from(["[1]"])), null)
  assert.equal(await readInput(Readable.from(["null"])), null)
  assert.equal(await readInput(Readable.from(["not json"])), null)
  assert.equal(await readInput(Readable.from(["x".repeat(1024 * 1024 + 1)])), null)
  const silent = new PassThrough()
  assert.equal(await readInput(silent, 10), null)
  const broken = new PassThrough()
  const reading = readInput(broken)
  broken.emit("error", new Error("closed"))
  assert.equal(await reading, null)
})

test("runHook hands the input to the naming module and never throws", async () => {
  const seen = []
  const load = async () => ({ nameOrcaSession: async (args) => { seen.push(args); return { code: "applied" } } })
  assert.equal(await runHook({ stdin: Readable.from(['{"tool_name":"t"}']), env: { A: "1" }, load }), "applied")
  assert.deepEqual(seen, [{ hookInput: { tool_name: "t" }, env: { A: "1" } }])
  assert.equal(await runHook({ stdin: Readable.from(["{}"]), env: {}, load: async () => { throw new Error("no module") } }), "unavailable")
})

test("runHook loads the real module by default", async () => {
  assert.equal(await runHook({ stdin: Readable.from(["{}"]), env: {} }), "not_naming_tool")
})

test("the hook script prints nothing and exits 0 outside Orca, logging the skip", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "orca-hook-"))
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, "state") }
  delete env.ORCA_TERMINAL_HANDLE
  const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "mcp__plugin_desk_desk__task_focus", tool_input: { track: "t", slug: "s" }, tool_response: [{ type: "text", text: JSON.stringify({ status: "focused", title: "T" }) }] })
  const result = spawnSync(process.execPath, [SCRIPT], { input, env, encoding: "utf8", timeout: 20000 })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "")
  const log = readFileSync(path.join(home, "state", "ouroboros-skills", "desk", "orca-session-titles.log"), "utf8")
  assert.equal(JSON.parse(log.trim()).code, "not_in_orca")
})

test("a session started on an older Desk runs the newest release's hook script", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "orca-hook-release-"))
  const plugins = path.join(home, ".local", "agency", "plugins")
  const desk = path.join(plugins, "sessions", "agency-plugin-abc.p1", "root-0", "desk")
  cpSync(path.dirname(SCRIPT), path.join(desk, "hooks"), { recursive: true })
  writeFileSync(path.join(desk, "plugin.json"), JSON.stringify({ name: "desk", version: "3.2.100" }))
  const newer = path.join(plugins, "cache", "entries", "desk2")
  mkdirSync(path.join(newer, "hooks"), { recursive: true })
  writeFileSync(path.join(newer, "plugin.json"), JSON.stringify({ name: "desk", version: "3.2.101" }))
  writeFileSync(path.join(newer, "hooks", "orca-session-title.cjs"), "process.stdout.write('newer release ran')\n")
  const spec = "copilot:github:ourostack/desk:plugins/desk@release"
  writeFileSync(path.join(plugins, "cache", "cache_index.json"), JSON.stringify({ entries: { [spec]: { spec, dir_name: "desk2", fetched_at: 1, resolved_sha: "a".repeat(40) } } }))
  const result = spawnSync(process.execPath, [path.join(desk, "hooks", "orca-session-title.cjs")], { input: "{}", encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, XDG_CACHE_HOME: path.join(home, ".cache") } })
  assert.equal(result.stdout, "newer release ran")
})
