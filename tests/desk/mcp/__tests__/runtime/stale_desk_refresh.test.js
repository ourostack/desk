// The automatic refresh of a stale Desk: the host's own command, once an hour, with failures falling back to the manual line.
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { promises as fs, readFileSync, existsSync } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { runBootCli } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { staleDeskFinding } from "../../../../../plugins/desk/mcp/src/runtime/stale-desk.js"
import {
  REFRESH_STAMP_FILE,
  REFRESH_TTL_MS,
  claudeMarketplace,
  deriveAgencySpec,
  isAgencySession,
  planStaleRefresh,
  refreshPlan,
  runCommand,
  runStaleRefresh,
} from "../../../../../plugins/desk/mcp/src/runtime/stale-desk-refresh.js"

const SPEC = "copilot:github:ourostack/desk:plugins/desk@main"

// An Agency data directory as the real one is laid out: a cache index, cached copies, and a per-session plugin copy.
async function agency({ version = "3.2.0-alpha.153", index } = {}) {
  const home = await mkTempRoot("desk-refresh-home-")
  const plugins = path.join(home, ".local", "agency", "plugins")
  const cache = path.join(plugins, "cache")
  const entries = index ?? {
    [SPEC]: { spec: SPEC, dir_name: "aaa" },
    "copilot:github:ourostack/desk:plugins/crew@main": { dir_name: "bbb" },
    "claude:github:ourostack/desk:plugins/desk@main": { dir_name: "ccc" },
    "copilot:github:ourostack/ouroboros-skills:plugins/desk@v2-alpha": { dir_name: "ddd" },
  }
  await fs.mkdir(path.join(cache, "entries", "aaa"), { recursive: true })
  await fs.writeFile(path.join(cache, "entries", "aaa", "plugin.json"), JSON.stringify({ name: "desk", version }))
  await fs.mkdir(path.join(cache, "entries", "ddd"), { recursive: true })
  await fs.writeFile(path.join(cache, "entries", "ddd", "plugin.json"), JSON.stringify({ name: "desk", version: "3.2.0-alpha.5" }))
  await fs.writeFile(path.join(cache, "cache_index.json"), JSON.stringify({ entries }))
  const pluginRoot = path.join(plugins, "sessions", "agency-plugin-abc.p1", "desk")
  await fs.mkdir(pluginRoot, { recursive: true })
  return { home, pluginRoot }
}

const finding = (agentHost = "claude") => staleDeskFinding({ running: "3.2.0-alpha.153", latest: "3.2.0-alpha.172", agentHost })

test("Agency is detected from its environment and from the session copy path", async () => {
  const { pluginRoot } = await agency()
  assert.equal(isAgencySession({ env: { AGENCY_ENGINE: "copilot" }, pluginRoot: "/x/desk" }), true)
  assert.equal(isAgencySession({ env: { AGENCY_SESSION_ID: "id" }, pluginRoot: "/x/desk" }), true)
  assert.equal(isAgencySession({ env: {}, pluginRoot }), true)
  assert.equal(isAgencySession({ env: { COPILOT_CLI: "1" }, pluginRoot: "/Users/a/.copilot/installed-plugins/desk" }), false)
})

test("the Agency spec is derived from the cache index by engine, folder name and running version, never invented", async () => {
  const { home, pluginRoot } = await agency()
  assert.equal(deriveAgencySpec({ env: { AGENCY_ENGINE: "copilot" }, pluginRoot, running: "3.2.0-alpha.153", homeDir: home }), SPEC)
  // The same index with no matching version, or no env engine (defaults to copilot), or an unreadable index.
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot, running: "3.2.0-alpha.153", homeDir: home }), SPEC)
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot, running: "9.9.9", homeDir: home }), null)
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot: "/x/y/desk", running: "3.2.0-alpha.153", homeDir: home }), SPEC)
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot, running: "3.2.0-alpha.153", homeDir: home, readFile: () => { throw new Error("nope") } }), null)
  // A second copilot desk entry with the same version is ambiguous: no guess.
  const twin = await agency({ index: { [SPEC]: { dir_name: "aaa" }, "copilot:github:someone/else:plugins/desk@main": { dir_name: "aaa" } } })
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot: twin.pluginRoot, running: "3.2.0-alpha.153", homeDir: twin.home }), null)
  // A spec with shell-looking characters is never used.
  const odd = await agency({ index: { "copilot:github:o/r:plugins/desk@a b;c": { dir_name: "aaa" } } })
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot: odd.pluginRoot, running: "3.2.0-alpha.153", homeDir: odd.home }), null)
})

test("the plan per host", async () => {
  const { home, pluginRoot } = await agency()
  const base = { running: "3.2.0-alpha.153", latest: "3.2.0-alpha.172", homeDir: home }
  const viaAgency = refreshPlan({ ...base, env: { AGENCY_ENGINE: "copilot" }, pluginRoot, agentHost: "copilot" })
  assert.deepEqual([viaAgency.host, viaAgency.command, viaAgency.args], ["agency", "agency", ["plugin", "cache", "remove", "-f", SPEC]])
  assert.equal(viaAgency.done, "refreshed the Agency plugin cache, so a new session will run 3.2.0-alpha.172")
  assert.equal(refreshPlan({ ...base, env: { AGENCY_ENGINE: "copilot" }, pluginRoot, agentHost: "copilot", running: "1.0.0" }), null)
  const direct = refreshPlan({ ...base, env: {}, pluginRoot: "/h/.copilot/installed-plugins/desk", agentHost: "copilot" })
  assert.deepEqual([direct.command, direct.args], ["copilot", ["plugin", "update", "desk"]])
  const claudeRoot = "/h/.claude/plugins/cache/ourostack/desk/3.2.0-alpha.153"
  const claude = refreshPlan({ ...base, env: {}, pluginRoot: claudeRoot, agentHost: "claude" })
  assert.deepEqual([claude.command, claude.args], ["claude", ["plugin", "update", "desk@ourostack"]])
  assert.equal(claude.done, "ran claude plugin update desk@ourostack, so a new session will run 3.2.0-alpha.172")
  assert.equal(refreshPlan({ ...base, env: {}, pluginRoot: "/some/checkout/plugins/desk", agentHost: "claude" }), null)
  assert.equal(refreshPlan({ ...base, env: {}, pluginRoot: "/x", agentHost: "codex" }), null)
  assert.equal(claudeMarketplace({ pluginRoot: "/h/.claude/plugins/cache/odd name/desk/1.0.0" }), null)
  assert.equal(claudeMarketplace({ pluginRoot: "/h/.claude/plugins/cache/ourostack/desk/1.0.0/extra" }), null)
})

async function ctx(agentHost = "claude", pluginRoot = "/h/.claude/plugins/cache/ourostack/desk/3.2.0-alpha.153") {
  const stateDir = await mkTempRoot("desk-refresh-state-")
  const calls = []
  const runner = async (command, args) => { calls.push([command, ...args]); return { ok: true, code: 0, reason: "ok" } }
  return { stateDir, calls, runner, options: { finding: finding(agentHost), env: {}, pluginRoot, agentHost, stateDir, runner, root: "/desk" } }
}

const out = () => { const chunks = []; return { chunks, stdout: { write: (c) => chunks.push(c) } } }
const stale = (agentHost) => async () => ({ boot_complete: true, status: "ok", degraded: [], pending: [], instructions: [], root: { path: "/desk" }, host: { agent: agentHost }, stale_desk: finding(agentHost) })
const parseJson = (chunks) => JSON.parse(chunks.join(""))

test("behind: the refresh runs after the boot text and one line says what it did", async () => {
  const { calls, options, stateDir, runner } = await ctx()
  const io = out()
  const order = []
  const wrapped = async (...args) => { order.push(io.chunks.length); return runner(...args) }
  await runBootCli({ argv: [], env: {}, io, bootFn: stale("claude"), refreshOptions: { stateDir, runner: wrapped, pluginRoot: options.pluginRoot } })
  assert.deepEqual(calls, [["claude", "plugin", "update", "desk@ourostack"]])
  assert.equal(order[0], 1, "the boot text is already written when the command starts")
  assert.equal(io.chunks.length, 2)
  assert.doesNotMatch(io.chunks[0], /releases behind/u)
  assert.equal(io.chunks[1], "Desk 3.2.0-alpha.153 is 19 releases behind main (3.2.0-alpha.172); ran claude plugin update desk@ourostack, so a new session will run 3.2.0-alpha.172.\n")
  assert.equal(JSON.parse(readFileSync(path.join(stateDir, REFRESH_STAMP_FILE), "utf8")).ok, true)
  assert.match(readFileSync(path.join(stateDir, "repairs.log"), "utf8"), /stale Desk refresh ran \(claude: claude plugin update desk@ourostack\)/u)
})

test("current: no finding, no command", async () => {
  const { calls, stateDir, runner } = await ctx()
  const io = out()
  await runBootCli({ argv: [], env: {}, io, bootFn: async () => ({ boot_complete: true, status: "ok", degraded: [], pending: [], instructions: [], stale_desk: null }), refreshOptions: { stateDir, runner } })
  assert.equal(calls.length, 0)
  assert.equal(existsSync(path.join(stateDir, REFRESH_STAMP_FILE)), false)
})

test("once per hour: a second boot inside the TTL runs nothing and shows the manual step; after the TTL it runs again", async () => {
  const { calls, options, stateDir, runner } = await ctx()
  let clock = Date.parse("2026-10-01T00:00:00Z")
  const refreshOptions = { stateDir, runner, pluginRoot: options.pluginRoot, now: () => clock }
  const run = async (argv = []) => { const io = out(); await runBootCli({ argv, env: {}, io, bootFn: stale("claude"), refreshOptions }); return io.chunks }
  await run()
  clock += REFRESH_TTL_MS - 1000
  const second = await run()
  assert.equal(calls.length, 1)
  assert.match(second[0], /^Desk boot: ok\nDesk 3\.2\.0-alpha\.153 is 19 releases behind main \(3\.2\.0-alpha\.172\); update it with \/plugin/u)
  const json = parseJson(await run(["--json"]))
  assert.equal(json.stale_desk.auto_refresh, "skipped")
  clock += 2000
  await run()
  assert.equal(calls.length, 2)
})

test("a failing command falls back to the manual step, is logged to the repair log and not to the agent", async () => {
  const { options, stateDir } = await ctx()
  for (const result of [{ ok: false, code: 1, reason: "nonzero_exit" }, { ok: false, code: null, reason: "not_installed" }]) {
    const io = out()
    const dir = await mkTempRoot("desk-refresh-state-")
    await runBootCli({ argv: [], env: {}, io, bootFn: stale("claude"), refreshOptions: { stateDir: dir, runner: async () => result, pluginRoot: options.pluginRoot } })
    assert.equal(io.chunks.length, 2)
    assert.match(io.chunks[1], /^Desk 3\.2\.0-alpha\.153 is 19 releases behind main \(3\.2\.0-alpha\.172\); update it with \/plugin, then start a new session\.\n$/u)
    assert.doesNotMatch(io.chunks.join(""), /refresh failed|not_installed|nonzero_exit/u)
    assert.match(readFileSync(path.join(dir, "repairs.log"), "utf8"), /stale Desk refresh failed \(claude: claude plugin update desk@ourostack\): (nonzero_exit exit 1|not_installed)/u)
    assert.equal(JSON.parse(readFileSync(path.join(dir, REFRESH_STAMP_FILE), "utf8")).ok, false)
  }
  assert.ok(stateDir)
})

test("a runner that throws is a failed refresh, not a failed boot", async () => {
  const { options } = await ctx()
  const dir = await mkTempRoot("desk-refresh-state-")
  const io = out()
  assert.equal(await runBootCli({ argv: [], env: {}, io, bootFn: stale("claude"), refreshOptions: { stateDir: dir, runner: async () => { throw new Error("boom") }, pluginRoot: options.pluginRoot } }), 0)
  assert.match(io.chunks[1], /update it with \/plugin/u)
})

test("with no derivable command the manual line stays at the top and nothing runs", async () => {
  const { calls, stateDir, runner } = await ctx()
  const io = out()
  await runBootCli({ argv: [], env: {}, io, bootFn: stale("claude"), refreshOptions: { stateDir, runner, pluginRoot: "/some/checkout/plugins/desk" } })
  assert.equal(calls.length, 0)
  assert.equal(io.chunks.length, 1)
  assert.match(io.chunks[0], /^Desk boot: ok\nDesk 3\.2\.0-alpha\.153 is 19 releases behind main/u)
})

test("--json carries the outcome in stale_desk.auto_refresh and the one-line text", async () => {
  const { stateDir, runner, options } = await ctx()
  const io = out()
  await runBootCli({ argv: ["--json"], env: {}, io, bootFn: stale("claude"), refreshOptions: { stateDir, runner, pluginRoot: options.pluginRoot } })
  assert.equal(io.chunks.length, 1)
  const json = parseJson(io.chunks)
  assert.equal(json.stale_desk.auto_refresh, "refreshed")
  assert.match(json.stale_desk.line, /ran claude plugin update desk@ourostack, so a new session will run 3\.2\.0-alpha\.172\.$/u)
  assert.equal(json.stale_desk.behind, 19)
})

test("Agency: the real session shape removes only this Desk's derived cache spec, with -f", async () => {
  const { home, pluginRoot } = await agency()
  const stateDir = await mkTempRoot("desk-refresh-state-")
  const calls = []
  const io = out()
  await runBootCli({ argv: [], env: { AGENCY_ENGINE: "copilot", AGENCY_SESSION_ID: "x" }, io, bootFn: stale("copilot"), refreshOptions: { stateDir, homeDir: home, pluginRoot, runner: async (...a) => { calls.push(a.slice(0, 2)); return { ok: true, code: 0 } } } })
  assert.deepEqual(calls, [["agency", ["plugin", "cache", "remove", "-f", SPEC]]])
  assert.equal(io.chunks[1], "Desk 3.2.0-alpha.153 is 19 releases behind main (3.2.0-alpha.172); refreshed the Agency plugin cache, so a new session will run 3.2.0-alpha.172.\n")
})

test("the off switch and the node:test default both keep the refresh from running", async () => {
  const { options, stateDir, runner } = await ctx()
  assert.equal(planStaleRefresh({ ...options, env: { DESK_BOOT_AUTO_REFRESH: "0" } }).state, "disabled")
  assert.equal(planStaleRefresh({ ...options, runner: undefined }).state, "disabled")
  assert.equal(planStaleRefresh({ ...options, stateDir, runner }).state, "ready")
  assert.equal(planStaleRefresh({ finding: null, env: {}, runner }).state, "unavailable")
})

test("runStaleRefresh without a log directory still reports", async () => {
  const { options } = await ctx()
  const prepared = planStaleRefresh(options)
  const result = await runStaleRefresh({ prepared: { ...prepared, dir: "/nonexistent-root-xyz/state", file: "/nonexistent-root-xyz/state/x" }, finding: options.finding, env: {}, runner: async () => ({ ok: true, code: 0 }) })
  assert.equal(result.state, "refreshed")
})

test("runCommand reports success, a failing exit, a missing binary and a timeout", async () => {
  const node = process.execPath
  assert.equal((await runCommand(node, ["-e", "process.exit(0)"])).ok, true)
  assert.deepEqual(await runCommand(node, ["-e", "process.exit(3)"]), { ok: false, code: 3, reason: "nonzero_exit" })
  assert.equal((await runCommand("/no/such/binary-desk-xyz", [])).reason, "not_installed")
  const started = Date.now()
  const slow = await runCommand(node, ["-e", "setTimeout(()=>{}, 20000)"], { timeoutMs: 100 })
  assert.equal(slow.reason, "timeout")
  assert.ok(Date.now() - started < 5000)
  assert.equal((await runCommand("x", [], { spawn: () => { throw new Error("denied") } })).reason, "spawn_failed")
  const emitter = () => { const child = new EventEmitter(); setImmediate(() => child.emit("error", Object.assign(new Error("e"), { code: "EACCES" }))); return child }
  assert.equal((await runCommand("x", [], { spawn: emitter })).reason, "spawn_failed")
})

test("plan edge cases: an index with no entries or a null entry, a session path with nothing after it, a future stamp and no plugin root", async () => {
  const { home, pluginRoot } = await agency({ index: {} })
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot, running: "3.2.0-alpha.153", homeDir: home }), null)
  await fs.writeFile(path.join(home, ".local", "agency", "plugins", "cache", "cache_index.json"), JSON.stringify({}))
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot, running: "3.2.0-alpha.153", homeDir: home }), null)
  const odd = await agency({ index: { [SPEC]: null, "copilot:github:o/r:plugins/desk@x": { dir_name: "missing" } } })
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot: odd.pluginRoot, running: "3.2.0-alpha.153", homeDir: odd.home }), null)
  assert.equal(isAgencySession({ env: {}, pluginRoot: "/x/plugins/sessions" }), false)
  assert.equal(deriveAgencySpec({ env: {}, pluginRoot: "/x/plugins/sessions", running: "1", homeDir: home }), null)
  const { options, stateDir } = await ctx()
  await fs.writeFile(path.join(stateDir, REFRESH_STAMP_FILE), JSON.stringify({ attempted_at: "2999-01-01T00:00:00Z" }))
  assert.equal(planStaleRefresh(options).state, "ready")
  await fs.writeFile(path.join(stateDir, REFRESH_STAMP_FILE), JSON.stringify({ attempted_at: "yesterday-ish" }))
  assert.equal(planStaleRefresh(options).state, "ready")
  assert.equal(planStaleRefresh({ ...options, pluginRoot: undefined }).state, "unavailable")
  const stateHome = await mkTempRoot("desk-refresh-xdg-")
  assert.equal(planStaleRefresh({ ...options, stateDir: undefined, env: { XDG_STATE_HOME: stateHome } }).state, "ready")
})

test("a command that ignores its kill signal and one that cannot be killed still end at the timeout", async () => {
  const stubborn = () => { const child = new EventEmitter(); child.kill = () => { throw new Error("gone") }; return child }
  const started = Date.now()
  assert.equal((await runCommand("x", [], { spawn: stubborn, timeoutMs: 30 })).reason, "timeout")
  assert.ok(Date.now() - started < 2000)
})
