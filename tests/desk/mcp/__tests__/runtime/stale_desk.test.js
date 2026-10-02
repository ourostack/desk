// Boot's stale-Desk warning: version ordering, the one-line text and JSON field, the cache, and the hard budget.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import {
  AGENCY_CACHE_COMMAND,
  LATEST_PLUGIN_URL,
  VERSION_CACHE_FILE,
  VERSION_CACHE_TTL_MS,
  VERSION_FAILURE_TTL_MS,
  checkStaleDesk,
  compareVersions,
  parseVersion,
  refreshStep,
  releasesBehind,
  staleDeskFinding,
} from "../../../../../plugins/desk/mcp/src/runtime/stale-desk.js"

async function fixture(version) {
  const pluginRoot = await mkTempRoot("desk-stale-plugin-")
  const stateDir = await mkTempRoot("desk-stale-state-")
  if (version !== null) await fs.writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "desk", version }))
  return { pluginRoot, stateDir }
}

const answering = (version, calls = []) => async (url, init) => {
  calls.push({ url, init })
  return { ok: true, text: async () => JSON.stringify({ name: "desk", version }) }
}

test("semver comparison orders prerelease counters numerically", () => {
  assert.equal(compareVersions("3.2.0-alpha.9", "3.2.0-alpha.10"), -1)
  assert.equal(compareVersions("3.2.0-alpha.10", "3.2.0-alpha.9"), 1)
  assert.equal(compareVersions("3.2.0-alpha.153", "3.2.0-alpha.172"), -1)
  assert.equal(compareVersions("3.2.0-alpha.5", "3.2.0-alpha.5"), 0)
  assert.equal(compareVersions("3.2.0-alpha.172", "3.2.0"), -1)
  assert.equal(compareVersions("3.2.0", "3.2.0-alpha.1"), 1)
  assert.equal(compareVersions("3.2.0", "3.2.0"), 0)
  assert.equal(compareVersions("3.2.0-alpha.1", "3.3.0-alpha.1"), -1)
  assert.equal(compareVersions("4.0.0-alpha.1", "3.9.9"), 1)
  assert.equal(compareVersions("3.2.0-alpha", "3.2.0-alpha.1"), -1)
  assert.equal(compareVersions("3.2.0-alpha.1", "3.2.0-alpha"), 1)
  assert.equal(compareVersions("3.2.0-1", "3.2.0-alpha"), -1)
  assert.equal(compareVersions("3.2.0-alpha", "3.2.0-1"), 1)
  assert.equal(compareVersions("3.2.0-alpha.1", "3.2.0-beta.1"), -1)
  assert.equal(compareVersions("3.2.0-beta.1", "3.2.0-alpha.1"), 1)
  assert.equal(compareVersions("3.2.0+build.1", "3.2.0"), 0)
  assert.equal(compareVersions("nope", "3.2.0"), null)
  assert.equal(compareVersions("3.2.0", undefined), null)
  assert.equal(parseVersion(" 1.2.3-alpha.4 ").pre.join("."), "alpha.4")
})

test("releases behind is counted only on one alpha line", () => {
  assert.equal(releasesBehind("3.2.0-alpha.153", "3.2.0-alpha.172"), 19)
  assert.equal(releasesBehind("3.2.0-alpha.9", "3.2.0-alpha.10"), 1)
  assert.equal(releasesBehind("3.2.0-alpha.9", "3.2.0-alpha.9"), null)
  assert.equal(releasesBehind("3.2.0-alpha.9", "3.3.0-alpha.1"), null)
  assert.equal(releasesBehind("3.2.0-alpha.9", "3.2.0-beta.12"), null)
  assert.equal(releasesBehind("3.2.0-alpha.9", "3.2.0"), null)
  assert.equal(releasesBehind("3.2.0-alpha.x", "3.2.0-alpha.12"), null)
  assert.equal(releasesBehind("bad", "3.2.0-alpha.12"), null)
})

test("the refresh step names the right command for each host", () => {
  assert.match(refreshStep("claude"), /\/plugin/u)
  const copilot = refreshStep("copilot")
  assert.match(copilot, /copilot plugin update desk/u)
  assert.ok(copilot.includes(AGENCY_CACHE_COMMAND))
  assert.equal(AGENCY_CACHE_COMMAND, 'agency plugin cache remove "copilot:github:ourostack/desk:plugins/desk@main"')
  assert.match(refreshStep("unknown"), /update the Desk plugin/u)
})

test("the finding is one line, with a count when reliable and just behind otherwise", () => {
  const counted = staleDeskFinding({ running: "3.2.0-alpha.153", latest: "3.2.0-alpha.172", agentHost: "claude" })
  assert.equal(counted.line, "Desk 3.2.0-alpha.153 is 19 releases behind main (3.2.0-alpha.172); update it with /plugin, then start a new session.")
  assert.deepEqual(Object.keys(counted), ["running", "latest", "behind", "channel", "refresh", "auto_refresh", "line"])
  assert.equal(counted.behind, 19)
  assert.equal(counted.channel, "main")
  assert.match(staleDeskFinding({ running: "3.2.0-alpha.171", latest: "3.2.0-alpha.172", agentHost: "claude" }).line, /is 1 release behind main/u)
  const vague = staleDeskFinding({ running: "3.2.0-alpha.153", latest: "3.3.0", agentHost: "copilot" })
  assert.equal(vague.behind, null)
  assert.match(vague.line, /^Desk 3\.2\.0-alpha\.153 is behind main \(3\.3\.0\); run copilot plugin update desk, or, if Agency launched this session, run agency plugin cache remove /u)
  assert.equal(staleDeskFinding({ running: "3.2.0-alpha.172", latest: "3.2.0-alpha.172", agentHost: "claude" }), null)
  assert.equal(staleDeskFinding({ running: "3.2.0-alpha.173", latest: "3.2.0-alpha.172", agentHost: "claude" }), null)
})

test("a running version behind the stubbed latest is reported, and the request carries no credentials", async () => {
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  const calls = []
  const found = await checkStaleDesk({ env: {}, pluginRoot, stateDir, agentHost: "claude", fetchFn: answering("3.2.0-alpha.172", calls) })
  assert.equal(found.behind, 19)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, LATEST_PLUGIN_URL)
  assert.equal(calls[0].init.headers, undefined)
  assert.equal(calls[0].init.credentials, "omit")
})

test("an equal or newer running version shows nothing", async () => {
  for (const running of ["3.2.0-alpha.172", "3.2.0-alpha.180", "3.2.0"]) {
    const { pluginRoot, stateDir } = await fixture(running)
    assert.equal(await checkStaleDesk({ env: {}, pluginRoot, stateDir, agentHost: "claude", fetchFn: answering("3.2.0-alpha.172") }), null, running)
  }
})

test("a failed, malformed or refused fetch shows nothing", async () => {
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  const run = (fetchFn, dir = stateDir) => checkStaleDesk({ env: {}, pluginRoot, stateDir: dir, agentHost: "claude", fetchFn })
  assert.equal(await run(async () => { throw new Error("offline") }), null)
  assert.equal(await run(async () => ({ ok: false, text: async () => "" }), await mkTempRoot("desk-stale-state-")), null)
  assert.equal(await run(async () => ({ ok: true, text: async () => "not json" }), await mkTempRoot("desk-stale-state-")), null)
  assert.equal(await run(async () => ({ ok: true, text: async () => JSON.stringify({ version: "banana" }) }), await mkTempRoot("desk-stale-state-")), null)
})

test("a fetch that never answers is cut off inside the budget, even when it ignores the abort signal", async () => {
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  const started = Date.now()
  const found = await checkStaleDesk({ env: {}, pluginRoot, stateDir, agentHost: "claude", budgetMs: 60, fetchFn: () => new Promise(() => {}) })
  assert.equal(found, null)
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
})

test("a fetch that honors the abort signal rejects at the budget and shows nothing", async () => {
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  const fetchFn = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
  assert.equal(await checkStaleDesk({ env: {}, pluginRoot, stateDir, agentHost: "claude", budgetMs: 40, fetchFn }), null)
})

test("a cached answer is reused within the TTL and refetched after it", async () => {
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  const calls = []
  let clock = Date.parse("2026-10-01T00:00:00Z")
  const now = () => clock
  const run = () => checkStaleDesk({ env: {}, pluginRoot, stateDir, now, agentHost: "claude", fetchFn: answering("3.2.0-alpha.172", calls) })
  assert.equal((await run()).behind, 19)
  assert.equal(JSON.parse(readFileSync(path.join(stateDir, VERSION_CACHE_FILE), "utf8")).latest, "3.2.0-alpha.172")
  clock += VERSION_CACHE_TTL_MS - 1000
  assert.equal((await run()).behind, 19)
  assert.equal(calls.length, 1)
  clock += 2000
  assert.equal((await run()).behind, 19)
  assert.equal(calls.length, 2)
})

test("a failed lookup is remembered briefly so an offline machine does not retry every boot", async () => {
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  let calls = 0
  let clock = Date.parse("2026-10-01T00:00:00Z")
  const fetchFn = async () => { calls += 1; throw new Error("offline") }
  const run = () => checkStaleDesk({ env: {}, pluginRoot, stateDir, now: () => clock, agentHost: "claude", fetchFn })
  assert.equal(await run(), null)
  assert.equal(await run(), null)
  assert.equal(calls, 1)
  clock += VERSION_FAILURE_TTL_MS + 1000
  assert.equal(await run(), null)
  assert.equal(calls, 2)
})

test("a corrupt or future-dated cache is ignored", async () => {
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  const file = path.join(stateDir, VERSION_CACHE_FILE)
  const run = (calls) => checkStaleDesk({ env: {}, pluginRoot, stateDir, agentHost: "claude", fetchFn: answering("3.2.0-alpha.172", calls) })
  writeFileSync(file, "{broken")
  const first = []
  assert.equal((await run(first)).behind, 19)
  assert.equal(first.length, 1)
  writeFileSync(file, JSON.stringify({ checked_at: "2999-01-01T00:00:00Z", latest: "3.2.0-alpha.1" }))
  const second = []
  assert.equal((await run(second)).behind, 19)
  assert.equal(second.length, 1)
})

test("the off switch, a node:test run without a stub, and an unreadable plugin version all skip the lookup", async () => {
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  const calls = []
  const fetchFn = answering("3.2.0-alpha.172", calls)
  assert.equal(await checkStaleDesk({ env: { DESK_BOOT_VERSION_CHECK: "0" }, pluginRoot, stateDir, fetchFn }), null)
  assert.equal(await checkStaleDesk({ env: {}, pluginRoot, stateDir }), null)
  const bare = await fixture(null)
  assert.equal(await checkStaleDesk({ env: {}, pluginRoot: bare.pluginRoot, stateDir: bare.stateDir, fetchFn }), null)
  assert.equal(calls.length, 0)
  assert.equal(existsSync(path.join(stateDir, VERSION_CACHE_FILE)), false)
})

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}

async function deskRoot() {
  const root = await mkTempRoot("desk-stale-boot-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  return root
}

const boot = (root, extra = {}) =>
  bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states: [], pending: [] }),
    ...extra,
  })

test("boot shows the line right under the status line and fills the JSON field when behind", async () => {
  const root = await deskRoot()
  const finding = staleDeskFinding({ running: "3.2.0-alpha.153", latest: "3.2.0-alpha.172", agentHost: "claude" })
  const result = await boot(root, { staleDeskFn: async () => finding })
  assert.deepEqual(result.stale_desk, finding)
  const lines = formatBootText(result).split("\n")
  assert.match(lines[0], /^Desk boot: /u)
  assert.equal(lines[1], finding.line)
  assert.equal(formatBootText(result).split(finding.line).length, 2)
})

test("boot with the real check against a stubbed latest, and a boot that is not behind, add nothing when current", async () => {
  const root = await deskRoot()
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  const behind = await boot(root, { staleDeskFn: (args) => checkStaleDesk({ ...args, pluginRoot, stateDir, fetchFn: answering("3.2.0-alpha.172") }) })
  assert.equal(behind.stale_desk.behind, 19)
  assert.match(formatBootText(behind), /Desk 3\.2\.0-alpha\.153 is 19 releases behind main/u)
  const current = await boot(root, { staleDeskFn: (args) => checkStaleDesk({ ...args, pluginRoot, stateDir: path.join(stateDir, "fresh"), fetchFn: answering("3.2.0-alpha.153") }) })
  assert.equal(current.stale_desk, null)
  assert.doesNotMatch(formatBootText(current), /releases? behind|is behind/u)
})

test("boot is unaffected when the check throws or never answers inside its budget", async () => {
  const root = await deskRoot()
  const thrown = await boot(root, { staleDeskFn: async () => { throw new Error("boom") } })
  assert.equal(thrown.stale_desk, null)
  assert.equal(thrown.boot_complete, true)
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  const started = Date.now()
  const slow = await boot(root, { staleDeskFn: (args) => checkStaleDesk({ ...args, pluginRoot, stateDir, budgetMs: 50, fetchFn: () => new Promise(() => {}) }) })
  assert.equal(slow.stale_desk, null)
  assert.ok(Date.now() - started < 1500)
})

test("a boot with no desk bound starts no lookup", async () => {
  let called = false
  const result = await bootOnce({ env: {}, cwd: await mkTempRoot("desk-stale-none-"), homeDir: await mkTempRoot("desk-stale-home-"), gh, jq, staleDeskFn: async () => { called = true; return null } })
  assert.equal(called, false)
  assert.equal(result.stale_desk, null)
})

test("the state directory comes from the environment when none is given, and an unwritable one only costs a second lookup", async () => {
  const { pluginRoot } = await fixture("3.2.0-alpha.153")
  const stateHome = await mkTempRoot("desk-stale-xdg-")
  const calls = []
  const env = { XDG_STATE_HOME: stateHome }
  assert.equal((await checkStaleDesk({ env, pluginRoot, agentHost: "claude", fetchFn: answering("3.2.0-alpha.172", calls) })).behind, 19)
  assert.equal(existsSync(path.join(stateHome, "ouroboros-skills", "desk", VERSION_CACHE_FILE)), true)
  await checkStaleDesk({ env, pluginRoot, agentHost: "claude", fetchFn: answering("3.2.0-alpha.172", calls) })
  assert.equal(calls.length, 1)
  // A state directory that is a plain file cannot be written; the answer still comes back.
  const file = path.join(await mkTempRoot("desk-stale-file-"), "not-a-dir")
  writeFileSync(file, "x")
  assert.equal((await checkStaleDesk({ env: {}, pluginRoot, stateDir: file, agentHost: "claude", fetchFn: answering("3.2.0-alpha.172") })).behind, 19)
})

test("a cached version that is not semver, or a plugin.json whose version is not, is ignored", async () => {
  const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
  writeFileSync(path.join(stateDir, VERSION_CACHE_FILE), JSON.stringify({ checked_at: new Date().toISOString(), latest: "banana" }))
  const calls = []
  assert.equal((await checkStaleDesk({ env: {}, pluginRoot, stateDir, agentHost: "claude", fetchFn: answering("3.2.0-alpha.172", calls) })).behind, 19)
  assert.equal(calls.length, 1)
  const odd = await fixture("not-a-version")
  assert.equal(await checkStaleDesk({ env: {}, pluginRoot: odd.pluginRoot, stateDir: odd.stateDir, agentHost: "claude", fetchFn: answering("3.2.0-alpha.172", calls) }), null)
  assert.equal(calls.length, 1)
})

test("a remote version is capped at 64 characters, 4 KB of body and safe integers", async () => {
  const run = async (body) => {
    const { pluginRoot, stateDir } = await fixture("3.2.0-alpha.153")
    return checkStaleDesk({ env: {}, pluginRoot, stateDir, agentHost: "claude", fetchFn: async () => ({ ok: true, text: async () => body }) })
  }
  assert.equal((await run(JSON.stringify({ version: "3.2.0-alpha.172" }))).behind, 19)
  assert.equal(await run(JSON.stringify({ version: `3.2.0-alpha.${"9".repeat(60)}` })), null)
  assert.equal(await run(JSON.stringify({ version: "3.2.0-alpha.172", description: "x".repeat(5000) })), null)
  assert.equal(await run(JSON.stringify({ version: "99999999999999999999.0.0" })), null)
  assert.equal(await run(JSON.stringify({ version: "3.2.0-alpha.99999999999999999999" })), null)
  assert.equal(parseVersion("9007199254740991.0.0").core[0], Number.MAX_SAFE_INTEGER)
  assert.equal(parseVersion("9007199254740992.0.0"), null)
})
