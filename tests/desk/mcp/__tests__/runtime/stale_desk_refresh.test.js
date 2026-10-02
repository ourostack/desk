// The automatic refresh of a stale Desk: the host's own command, detached, claimed once an hour, never waited for by boot.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, promises as fs, readFileSync, utimesSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { waitForNoProcessesUnder, processesWithCwdUnder, reapProcessesUnder } from "../_process_hygiene.js"
import { runBootCli } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { staleDeskFinding } from "../../../../../plugins/desk/mcp/src/runtime/stale-desk.js"
import {
  REFRESH_CLAIM_FILE,
  REFRESH_CLAIM_STALE_MS,
  REFRESH_STAMP_FILE,
  REFRESH_TTL_MS,
  claudeMarketplace,
  copilotInstalled,
  deriveAgencySpec,
  isAgencySession,
  planStaleRefresh,
  refreshPlan,
  startStaleRefresh,
  startedLine,
} from "../../../../../plugins/desk/mcp/src/runtime/stale-desk-refresh.js"

const SPEC = "copilot:github:ourostack/desk:plugins/desk@main"
const CLAUDE_SPEC = "claude:github:ourostack/desk:plugins/desk@main"
const CLAUDE_ROOT = "/h/.claude/plugins/cache/ourostack/desk/3.2.0-alpha.153"
const posix = process.platform !== "win32"

// An Agency data directory as the real one is laid out: a cache index, cached copies, and a per-session plugin copy.
async function agency({ version = "3.2.0-alpha.153", index } = {}) {
  const home = await mkTempRoot("desk-refresh-home-")
  const plugins = path.join(home, ".local", "agency", "plugins")
  const cache = path.join(plugins, "cache")
  const entries = index ?? {
    [SPEC]: { dir_name: "aaa" },
    [CLAUDE_SPEC]: { dir_name: "ccc" },
    "copilot:github:ourostack/desk:plugins/crew@main": { dir_name: "bbb" },
    "copilot:github:ourostack/ouroboros-skills:plugins/desk@v2-alpha": { dir_name: "ddd" },
    "copilot:github:someone/desk:plugins/desk@main": { dir_name: "ddd" },
    "copilot:github:ourostack/desk:plugins/desk@v2": { dir_name: "ddd" },
  }
  for (const [dir, v] of [["aaa", version], ["ccc", version], ["ddd", version]]) {
    await fs.mkdir(path.join(cache, "entries", dir), { recursive: true })
    await fs.writeFile(path.join(cache, "entries", dir, "plugin.json"), JSON.stringify({ name: "desk", version: v }))
  }
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
  assert.equal(isAgencySession({ env: {}, pluginRoot: "/x/plugins/sessions" }), false)
})

test("the Agency spec is the pinned ourostack/desk plugin on main for the session's engine, from the cache index, at the running version", async () => {
  const { home, pluginRoot } = await agency()
  const derive = (extra = {}) => deriveAgencySpec({ env: { AGENCY_ENGINE: "copilot" }, agentHost: "copilot", pluginRoot, running: "3.2.0-alpha.153", homeDir: home, ...extra })
  assert.equal(derive(), SPEC)
  assert.equal(derive({ running: "9.9.9" }), null)
  assert.equal(derive({ readFile: () => { throw new Error("nope") } }), null)
  // Claude under Agency has no AGENCY_ENGINE here: the engine comes from the agent host, not a copilot default.
  assert.equal(derive({ env: {}, agentHost: "claude" }), CLAUDE_SPEC)
  assert.equal(derive({ env: {}, agentHost: "copilot" }), SPEC)
  assert.equal(derive({ env: {}, agentHost: "codex" }), null)
  assert.equal(derive({ env: { AGENCY_ENGINE: "claude" }, agentHost: "copilot" }), CLAUDE_SPEC)
  // Other orgs, other refs and other plugins in the index are never touched.
  for (const key of ["copilot:github:someone/desk:plugins/desk@main", "copilot:github:ourostack/desk:plugins/desk@v2", "copilot:github:ourostack/ouroboros-skills:plugins/desk@v2-alpha"]) {
    const odd = await agency({ index: { [key]: { dir_name: "ddd" } } })
    assert.equal(deriveAgencySpec({ env: {}, agentHost: "copilot", pluginRoot: odd.pluginRoot, running: "3.2.0-alpha.153", homeDir: odd.home }), null, key)
  }
  const none = await agency({ index: {} })
  assert.equal(deriveAgencySpec({ env: {}, agentHost: "copilot", pluginRoot: none.pluginRoot, running: "3.2.0-alpha.153", homeDir: none.home }), null)
  await fs.writeFile(path.join(none.home, ".local", "agency", "plugins", "cache", "cache_index.json"), JSON.stringify({}))
  assert.equal(deriveAgencySpec({ env: {}, agentHost: "copilot", pluginRoot: none.pluginRoot, running: "3.2.0-alpha.153", homeDir: none.home }), null)
  const nullEntry = await agency({ index: { [SPEC]: null } })
  assert.equal(deriveAgencySpec({ env: {}, agentHost: "copilot", pluginRoot: nullEntry.pluginRoot, running: "3.2.0-alpha.153", homeDir: nullEntry.home }), null)
  // A path that only looks like a session copy falls back to the home directory's Agency data.
  assert.equal(deriveAgencySpec({ env: {}, agentHost: "copilot", pluginRoot: "/x/plugins/sessions", running: "3.2.0-alpha.153", homeDir: home }), SPEC)
})

test("the plan per host; Copilot only for an installed plugin, never a dev checkout or --plugin-dir", async () => {
  const { home, pluginRoot } = await agency()
  const base = { running: "3.2.0-alpha.153", homeDir: home }
  const viaAgency = refreshPlan({ ...base, env: { AGENCY_ENGINE: "copilot" }, pluginRoot, agentHost: "copilot" })
  assert.deepEqual([viaAgency.host, viaAgency.command, viaAgency.args], ["agency", "agency", ["plugin", "cache", "remove", "-f", SPEC]])
  assert.equal(viaAgency.doing, "refreshing the Agency plugin cache")
  assert.equal(refreshPlan({ ...base, env: { AGENCY_ENGINE: "copilot" }, pluginRoot, agentHost: "copilot", running: "1.0.0" }), null)
  const installed = path.join(home, ".copilot", "installed-plugins", "ourostack", "desk")
  const direct = refreshPlan({ ...base, env: {}, pluginRoot: installed, agentHost: "copilot" })
  assert.deepEqual([direct.command, direct.args], ["copilot", ["plugin", "update", "desk"]])
  assert.equal(refreshPlan({ ...base, env: {}, pluginRoot: "/Users/me/code/desk/plugins/desk", agentHost: "copilot" }), null)
  assert.equal(refreshPlan({ ...base, env: {}, pluginRoot: path.join(home, ".copilot", "installed-plugins"), agentHost: "copilot" }), null)
  assert.equal(refreshPlan({ ...base, env: {}, pluginRoot: path.join(home, ".copilot", "other", "desk"), agentHost: "copilot" }), null)
  assert.equal(copilotInstalled({ env: { COPILOT_HOME: "/c" }, pluginRoot: "/c/installed-plugins/m/desk", homeDir: home }), true)
  assert.equal(copilotInstalled({ env: { COPILOT_HOME: "/c" }, pluginRoot: installed, homeDir: home }), false)
  const claude = refreshPlan({ ...base, env: {}, pluginRoot: CLAUDE_ROOT, agentHost: "claude" })
  assert.deepEqual([claude.command, claude.args, claude.doing], ["claude", ["plugin", "update", "desk@ourostack"], "running claude plugin update desk@ourostack"])
  assert.equal(refreshPlan({ ...base, env: {}, pluginRoot: "/some/checkout/plugins/desk", agentHost: "claude" }), null)
  assert.equal(refreshPlan({ ...base, env: {}, pluginRoot: "/x", agentHost: "codex" }), null)
  assert.equal(claudeMarketplace({ pluginRoot: "/h/.claude/plugins/cache/odd name/desk/1.0.0" }), null)
  assert.equal(claudeMarketplace({ pluginRoot: "/h/.claude/plugins/cache/ourostack/desk/1.0.0/extra" }), null)
})

test("the started line says what was started and the new version", () => {
  const plan = refreshPlan({ env: {}, pluginRoot: CLAUDE_ROOT, agentHost: "claude", running: "x", homeDir: "/h" })
  assert.equal(startedLine(finding(), plan), "Desk 3.2.0-alpha.153 is 19 releases behind main (3.2.0-alpha.172); running claude plugin update desk@ourostack in the background, so a new session will run 3.2.0-alpha.172.")
  assert.equal(startedLine({ ...finding(), behind: null }, { doing: "refreshing the Agency plugin cache" }), "Desk 3.2.0-alpha.153 is behind main (3.2.0-alpha.172); refreshing the Agency plugin cache in the background, so a new session will run 3.2.0-alpha.172.")
})

async function ctx(over = {}) {
  const stateDir = await mkTempRoot("desk-refresh-state-")
  return { stateDir, options: { finding: finding(), env: {}, pluginRoot: CLAUDE_ROOT, agentHost: "claude", stateDir, root: "/desk", allowInTest: true, ...over } }
}

test("planning: the switch and the node:test default disable it; a recent stamp skips or reports the failed attempt; otherwise it is ready", async () => {
  const { options, stateDir } = await ctx()
  assert.equal(planStaleRefresh({ ...options, env: { DESK_BOOT_AUTO_REFRESH: "0" } }).state, "disabled")
  assert.equal(planStaleRefresh({ ...options, allowInTest: undefined }).state, "disabled")
  assert.equal(planStaleRefresh(options).state, "ready")
  assert.equal(planStaleRefresh({ ...options, pluginRoot: undefined }).state, "unavailable")
  assert.equal(planStaleRefresh({ ...options, pluginRoot: "/some/checkout" }).state, "unavailable")
  const stamp = path.join(stateDir, REFRESH_STAMP_FILE)
  const at = Date.parse("2026-10-01T00:00:00Z")
  for (const [ok, expected] of [[null, "skipped"], [true, "skipped"], [false, "failed"]]) {
    await fs.writeFile(stamp, JSON.stringify({ attempted_at: new Date(at).toISOString(), ok }))
    assert.equal(planStaleRefresh({ ...options, now: () => at + REFRESH_TTL_MS - 1000 }).state, expected)
    assert.equal(planStaleRefresh({ ...options, now: () => at + REFRESH_TTL_MS + 1000 }).state, "ready")
  }
  await fs.writeFile(stamp, JSON.stringify({ attempted_at: "2999-01-01T00:00:00Z" }))
  assert.equal(planStaleRefresh(options).state, "ready")
  await fs.writeFile(stamp, JSON.stringify({ attempted_at: "yesterday-ish" }))
  assert.equal(planStaleRefresh(options).state, "ready")
  const xdg = await mkTempRoot("desk-refresh-xdg-")
  assert.equal(planStaleRefresh({ ...options, stateDir: undefined, env: { XDG_STATE_HOME: xdg } }).state, "ready")
})

const fakeSpawn = (calls) => (command, args, opts) => { calls.push({ command, args, opts }); return { unref() { calls.at(-1).unref = true } } }

test("starting claims and stamps the attempt before it spawns, detached and unref'd; a second planner loses the claim", async () => {
  const { options, stateDir } = await ctx()
  const calls = []
  const first = planStaleRefresh(options)
  const second = planStaleRefresh(options)
  assert.equal(first.state, "ready")
  assert.equal(second.state, "ready")
  const spawnFn = (...args) => {
    // At spawn time the claim and a pending stamp already exist.
    assert.equal(existsSync(path.join(stateDir, REFRESH_CLAIM_FILE)), true)
    assert.equal(JSON.parse(readFileSync(path.join(stateDir, REFRESH_STAMP_FILE), "utf8")).ok, null)
    return fakeSpawn(calls)(...args)
  }
  assert.equal(startStaleRefresh({ ...options, prepared: first, spawn: spawnFn }).state, "started")
  assert.equal(startStaleRefresh({ ...options, prepared: second, spawn: spawnFn }).state, "claimed_elsewhere")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.detached, true)
  assert.equal(calls[0].opts.stdio, "ignore")
  assert.equal(calls[0].unref, true)
  const config = JSON.parse(calls[0].args[2])
  assert.equal(config.shown, "claude plugin update desk@ourostack")
  assert.equal(config.timeoutMs, 8000)
})

test("a stale claim is taken over; a live one is respected; a stamp written after planning wins over a late claim", async () => {
  const { options, stateDir } = await ctx()
  const claim = path.join(stateDir, REFRESH_CLAIM_FILE)
  const calls = []
  const prepared = planStaleRefresh(options)
  writeFileSync(claim, "")
  assert.equal(startStaleRefresh({ ...options, prepared, spawn: fakeSpawn(calls) }).state, "claimed_elsewhere")
  const old = new Date(Date.now() - REFRESH_CLAIM_STALE_MS - 5000)
  utimesSync(claim, old, old)
  assert.equal(startStaleRefresh({ ...options, prepared, spawn: fakeSpawn(calls) }).state, "started")
  assert.equal(calls.length, 1)
  // The stamp the winner just wrote is fresh, so a boot that planned earlier backs off even after the claim is released.
  await fs.rm(claim)
  assert.equal(startStaleRefresh({ ...options, prepared, spawn: fakeSpawn(calls) }).state, "claimed_elsewhere")
  assert.equal(existsSync(claim), false)
  assert.equal(calls.length, 1)
})

test("two boots finding the same stale claim: one takes it over, the other backs off", async () => {
  const { options, stateDir } = await ctx()
  const claim = path.join(stateDir, REFRESH_CLAIM_FILE)
  writeFileSync(claim, "")
  const old = new Date(Date.now() - REFRESH_CLAIM_STALE_MS - 5000)
  utimesSync(claim, old, old)
  const prepared = planStaleRefresh(options)
  const results = [startStaleRefresh({ ...options, prepared, spawn: fakeSpawn([]) }), startStaleRefresh({ ...options, prepared, spawn: fakeSpawn([]) })]
  assert.deepEqual(results.map((r) => r.state), ["started", "claimed_elsewhere"])
})

test("a spawn that throws, or a state directory that cannot be made, is a failed start, logged, never a throw", async () => {
  const { options, stateDir } = await ctx()
  const prepared = planStaleRefresh(options)
  assert.equal(startStaleRefresh({ ...options, prepared, spawn: () => { throw new Error("denied") } }).state, "failed")
  assert.match(readFileSync(path.join(stateDir, "repairs.log"), "utf8"), /stale Desk refresh could not start \(claude\): denied/u)
  await fs.rm(path.join(stateDir, REFRESH_STAMP_FILE))
  assert.equal(startStaleRefresh({ ...options, prepared, root: undefined, spawn: fakeSpawn([]) }).state, "started")
  assert.equal(JSON.parse(readFileSync(path.join(stateDir, REFRESH_STAMP_FILE), "utf8")).ok, null)
  const file = path.join(await mkTempRoot("desk-refresh-file-"), "not-a-dir")
  writeFileSync(file, "x")
  assert.equal(startStaleRefresh({ ...options, stateDir: file, prepared: { ...prepared, dir: file }, root: undefined }).state, "failed")
})

const out = () => { const chunks = []; return { chunks, stdout: { write: (c) => chunks.push(c) } } }
const stale = (agentHost) => async () => ({ boot_complete: true, status: "ok", degraded: [], pending: [], instructions: [], root: { path: "/desk" }, host: { agent: agentHost }, stale_desk: finding(agentHost) })

test("boot writes its text, with the started line near the top, before the refresh starts", async () => {
  const { stateDir } = await ctx()
  const calls = []
  const io = out()
  let written
  const spawnFn = (...args) => { written = io.chunks.length; return fakeSpawn(calls)(...args) }
  await runBootCli({ argv: [], env: {}, io, bootFn: stale("claude"), refreshOptions: { stateDir, allowInTest: true, pluginRoot: CLAUDE_ROOT, spawn: spawnFn } })
  assert.equal(written, 1, "the output was already written when the refresh started")
  assert.equal(io.chunks.length, 1)
  const lines = io.chunks[0].split("\n")
  assert.match(lines[0], /^Desk boot: ok$/u)
  assert.equal(lines[1], "Desk 3.2.0-alpha.153 is 19 releases behind main (3.2.0-alpha.172); running claude plugin update desk@ourostack in the background, so a new session will run 3.2.0-alpha.172.")
  assert.equal(calls.length, 1)
})

test("--json is written before the refresh starts and says it started", async () => {
  const { stateDir } = await ctx()
  const io = out()
  let written
  const spawnFn = (...args) => { written = io.chunks.length; return fakeSpawn([])(...args) }
  await runBootCli({ argv: ["--json"], env: {}, io, bootFn: stale("claude"), refreshOptions: { stateDir, allowInTest: true, pluginRoot: CLAUDE_ROOT, spawn: spawnFn } })
  assert.equal(written, 1)
  const json = JSON.parse(io.chunks[0])
  assert.equal(json.stale_desk.auto_refresh, "started")
  assert.match(json.stale_desk.line, /in the background, so a new session will run 3\.2\.0-alpha\.172\.$/u)
  assert.equal(json.stale_desk.behind, 19)
})

test("a recorded failure shows in the next boot as the manual step; an attempt within the hour is skipped; nothing runs", async () => {
  const { stateDir } = await ctx()
  const calls = []
  const refreshOptions = { stateDir, allowInTest: true, pluginRoot: CLAUDE_ROOT, spawn: fakeSpawn(calls) }
  await fs.writeFile(path.join(stateDir, REFRESH_STAMP_FILE), JSON.stringify({ attempted_at: new Date().toISOString(), ok: false, reason: "nonzero_exit" }))
  const io = out()
  await runBootCli({ argv: ["--json"], env: {}, io, bootFn: stale("claude"), refreshOptions })
  const json = JSON.parse(io.chunks[0])
  assert.equal(json.stale_desk.auto_refresh, "failed")
  assert.equal(json.stale_desk.line, "Desk 3.2.0-alpha.153 is 19 releases behind main (3.2.0-alpha.172); update it with /plugin, then start a new session.")
  await fs.writeFile(path.join(stateDir, REFRESH_STAMP_FILE), JSON.stringify({ attempted_at: new Date().toISOString(), ok: true }))
  const again = out()
  await runBootCli({ argv: [], env: {}, io: again, bootFn: stale("claude"), refreshOptions })
  assert.match(again.chunks[0], /^Desk boot: ok\nDesk 3\.2\.0-alpha\.153 is 19 releases behind main \(3\.2\.0-alpha\.172\); update it with \/plugin/u)
  assert.equal(calls.length, 0)
})

test("current Desk, a Copilot dev checkout and an underivable host start nothing", async () => {
  const { stateDir } = await ctx()
  const calls = []
  const refreshOptions = { stateDir, allowInTest: true, spawn: fakeSpawn(calls) }
  const io = out()
  await runBootCli({ argv: [], env: {}, io, bootFn: async () => ({ boot_complete: true, status: "ok", degraded: [], pending: [], instructions: [], stale_desk: null }), refreshOptions })
  const dev = out()
  await runBootCli({ argv: ["--json"], env: {}, io: dev, bootFn: stale("copilot"), refreshOptions: { ...refreshOptions, pluginRoot: "/Users/me/code/desk/plugins/desk" } })
  const json = JSON.parse(dev.chunks[0])
  assert.equal(json.stale_desk.auto_refresh, "unavailable")
  assert.match(json.stale_desk.line, /run copilot plugin update desk, or, if Agency launched this session/u)
  assert.equal(calls.length, 0)
  assert.equal(existsSync(path.join(stateDir, REFRESH_STAMP_FILE)), false)
})

test("Agency: the real session shape removes only this Desk's derived cache spec, with -f, and says so", async () => {
  const { home, pluginRoot } = await agency()
  const { stateDir } = await ctx()
  const calls = []
  const io = out()
  await runBootCli({ argv: [], env: { AGENCY_ENGINE: "copilot", AGENCY_SESSION_ID: "x" }, io, bootFn: stale("copilot"), refreshOptions: { stateDir, homeDir: home, pluginRoot, allowInTest: true, spawn: fakeSpawn(calls) } })
  assert.equal(JSON.parse(calls[0].args[2]).shown, `agency plugin cache remove -f ${SPEC}`)
  assert.match(io.chunks[0], /refreshing the Agency plugin cache in the background, so a new session will run 3\.2\.0-alpha\.172\./u)
})

// ---- Real processes -------------------------------------------------------------------------------------------------------

const HARNESS = (url) => `
import { planStaleRefresh, startStaleRefresh } from ${JSON.stringify(url)}
const finding = { running: "3.2.0-alpha.153", latest: "3.2.0-alpha.172", behind: 19 }
const base = { finding, env: process.env, pluginRoot: ${JSON.stringify(CLAUDE_ROOT)}, agentHost: "claude", stateDir: process.argv[2], allowInTest: true, root: "/desk" }
const prepared = planStaleRefresh(base)
process.stdout.write("plan:" + prepared.state + "\\n")
if (prepared.state === "ready") process.stdout.write("start:" + startStaleRefresh({ ...base, prepared, timeoutMs: Number(process.argv[3]) }).state + "\\n")
`

// A fake `claude` on PATH. "hang" leaves a grandchild sleeping in the background, as an npm or launcher shim can; "count" records each run.
async function shimmed(kind) {
  const dir = await mkTempRoot("desk-refresh-shim-")
  const log = path.join(dir, "ran.log")
  const body = kind === "hang" ? "sleep 600 &\nwait\n" : `echo run >> "${log}"\n`
  await fs.writeFile(path.join(dir, "claude"), `#!/bin/sh\n${body}`, { mode: 0o755 })
  const stateDir = await mkTempRoot("desk-refresh-real-state-")
  const harness = path.join(dir, "harness.mjs")
  await fs.writeFile(harness, HARNESS(new URL("../../../../../plugins/desk/mcp/src/runtime/stale-desk-refresh.js", import.meta.url).href))
  return { dir, log, stateDir, harness, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } }
}

function runHarness({ harness, stateDir, env }, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [harness, stateDir, String(timeoutMs)], { env, stdio: ["ignore", "pipe", "inherit"] })
    let stdout = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.on("exit", () => resolve({ stdout, elapsed: Date.now() - started }))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return true; await sleep(50) }
  return check()
}

test("boot exits without waiting for a hung refresh; the runner kills the whole group at its own deadline and leaves no orphan", { skip: !posix }, async (t) => {
  const f = await shimmed("hang")
  t.after(() => reapProcessesUnder(f.stateDir))
  const { stdout, elapsed } = await runHarness(f, 1500)
  assert.equal(stdout, "plan:ready\nstart:started\n")
  assert.ok(elapsed < 1200, `the boot process took ${elapsed} ms; it must not wait for the refresh (deadline 1500 ms)`)
  // The runner, the shim and its sleeping grandchild all run in the state directory while the refresh hangs.
  assert.equal(await until(() => processesWithCwdUnder(f.stateDir).length >= 3, 3000), true, JSON.stringify(processesWithCwdUnder(f.stateDir)))
  assert.equal(JSON.parse(readFileSync(path.join(f.stateDir, REFRESH_STAMP_FILE), "utf8")).ok, null)
  // At the deadline the group is killed, the outcome recorded and the claim released, with nothing left running.
  const left = await waitForNoProcessesUnder(f.stateDir, 8000)
  assert.deepEqual(left, [], "orphaned processes after the deadline")
  const stamp = JSON.parse(readFileSync(path.join(f.stateDir, REFRESH_STAMP_FILE), "utf8"))
  assert.deepEqual([stamp.ok, stamp.reason, stamp.host], [false, "timeout", "claude"])
  assert.equal(existsSync(path.join(f.stateDir, REFRESH_CLAIM_FILE)), false)
  assert.match(readFileSync(path.join(f.stateDir, "repairs.log"), "utf8"), /^\S+ \/desk stale Desk refresh failed \(claude: claude plugin update desk@ourostack\): timeout$/mu)
})

test("a refresh that succeeds is recorded as such, and a missing command as not_installed", { skip: !posix }, async (t) => {
  const f = await shimmed("count")
  t.after(() => reapProcessesUnder(f.stateDir))
  await runHarness(f, 4000)
  assert.equal(await until(() => existsSync(path.join(f.stateDir, REFRESH_STAMP_FILE)) && JSON.parse(readFileSync(path.join(f.stateDir, REFRESH_STAMP_FILE), "utf8")).ok === true), true)
  assert.equal(readFileSync(f.log, "utf8"), "run\n")
  assert.match(readFileSync(path.join(f.stateDir, "repairs.log"), "utf8"), /stale Desk refresh ran \(claude: claude plugin update desk@ourostack\); 3\.2\.0-alpha\.153 -> 3\.2\.0-alpha\.172/u)
  const missing = await shimmed("count")
  t.after(() => reapProcessesUnder(missing.stateDir))
  await fs.rm(path.join(missing.dir, "claude"))
  await runHarness({ ...missing, env: { ...process.env, PATH: missing.dir } }, 4000)
  assert.equal(await until(() => existsSync(path.join(missing.stateDir, REFRESH_STAMP_FILE)) && JSON.parse(readFileSync(path.join(missing.stateDir, REFRESH_STAMP_FILE), "utf8")).ok === false), true)
  assert.equal(JSON.parse(readFileSync(path.join(missing.stateDir, REFRESH_STAMP_FILE), "utf8")).reason, "not_installed")
})

test("a command that exits nonzero is recorded as failed", { skip: !posix }, async (t) => {
  const f = await shimmed("count")
  t.after(() => reapProcessesUnder(f.stateDir))
  await fs.writeFile(path.join(f.dir, "claude"), "#!/bin/sh\nexit 3\n", { mode: 0o755 })
  await runHarness(f, 4000)
  assert.equal(await until(() => JSON.parse(readFileSync(path.join(f.stateDir, REFRESH_STAMP_FILE), "utf8")).ok === false), true)
  assert.match(readFileSync(path.join(f.stateDir, "repairs.log"), "utf8"), /nonzero_exit exit 3/u)
})

test("many agents booting together start one refresh", { skip: !posix }, async (t) => {
  const f = await shimmed("count")
  t.after(() => reapProcessesUnder(f.stateDir))
  const results = await Promise.all(Array.from({ length: 12 }, () => runHarness(f, 4000)))
  const started = results.filter((r) => r.stdout.includes("start:started")).length
  assert.equal(started, 1, results.map((r) => r.stdout.replace(/\n/gu, " ")).join(" | "))
  assert.equal(await until(() => existsSync(f.log) && !existsSync(path.join(f.stateDir, REFRESH_CLAIM_FILE))), true)
  await sleep(300)
  assert.equal(readFileSync(f.log, "utf8"), "run\n", "the command ran exactly once")
})
