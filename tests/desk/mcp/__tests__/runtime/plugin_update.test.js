// The plugin-update notice: the session's sibling plugin roots against the newest release Agency has fetched, the one
// line (with and without Housesitter's auto-restart job), and boot's line and JSON field.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, promises as fs, writeFileSync } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import {
  checkPluginUpdate,
  HOUSESITTER_AGENT_LABEL,
  housesitterRestartsApp,
  loadedPlugins,
  newestFetched,
  pluginUpdateFinding,
  pluginUpdateLine,
} from "../../../../../plugins/desk/mcp/src/runtime/plugin-update.js"

const SHA = "a".repeat(40)

function plugin(dir, name, version, claude = false) {
  const where = claude ? path.join(dir, ".claude-plugin") : dir
  mkdirSync(where, { recursive: true })
  writeFileSync(path.join(where, "plugin.json"), JSON.stringify({ name, version }))
}

// An Agency data folder: one session folder with a root per plugin, and a cache of fetched releases.
async function agency({ loaded, fetched }) {
  const home = await mkTempRoot("desk-plugin-update-")
  const plugins = path.join(home, ".local", "agency", "plugins")
  const session = path.join(plugins, "sessions", "agency-plugin-abc.p123")
  Object.entries(loaded).forEach(([name, version], index) => plugin(path.join(session, `root-${index}`, name), name, version, name === "crew"))
  const entries = {}
  fetched.forEach(({ spec, name, version, at = 1000 }, index) => {
    plugin(path.join(plugins, "cache", "entries", `e${index}`), name, version)
    entries[spec] = { spec, dir_name: `e${index}`, fetched_at: at, resolved_sha: SHA }
  })
  mkdirSync(path.join(plugins, "cache"), { recursive: true })
  writeFileSync(path.join(plugins, "cache", "cache_index.json"), JSON.stringify({ entries }))
  return { home, pluginRoot: path.join(session, "root-0", Object.keys(loaded)[0]), session, cache: path.join(plugins, "cache") }
}

const spec = (name, ref = "main", engine = "copilot") => `${engine}:github:org/repo:plugins/${name}@${ref}`
const env = { AGENCY_ENGINE: "copilot" }

test("loadedPlugins reads every root beside Desk's, in both manifest places", async () => {
  const a = await agency({ loaded: { desk: "3.2.154", crew: "0.2.23", cit: "0.1.81" }, fetched: [] })
  assert.deepEqual(loadedPlugins(a.session).map((p) => `${p.name} ${p.version}`).sort(), ["cit 0.1.81", "crew 0.2.23", "desk 3.2.154"])
  assert.deepEqual(loadedPlugins(path.join(a.home, "nowhere")), [])
})

test("newestFetched takes this engine's branch and tag entries, never a pinned commit, the newest fetch per plugin", async () => {
  const a = await agency({
    loaded: { desk: "1.0.0" },
    fetched: [
      { spec: spec("desk", "release"), name: "desk", version: "3.2.167", at: 2000 },
      { spec: spec("desk", "b".repeat(40)), name: "desk", version: "3.2.82", at: 3000 },
      { spec: spec("desk", "main", "claude"), name: "desk", version: "9.9.9", at: 4000 },
      { spec: spec("cit"), name: "cit", version: "0.1.82", at: 10 },
    ],
  })
  assert.deepEqual([...newestFetched(a.cache, "copilot")].sort(), [["cit", "0.1.82"], ["desk", "3.2.167"]])
  assert.equal(newestFetched(path.join(a.home, "none"), "copilot").size, 0)
})

test("a loaded plugin older than the newest fetched release is named, with the oldest loaded version, in the manual line", async () => {
  const a = await agency({
    loaded: { desk: "3.2.154", cit: "0.1.81", "ms-desk": "2.32.0" },
    fetched: [
      { spec: spec("desk", "release"), name: "desk", version: "3.2.167" },
      { spec: spec("cit"), name: "cit", version: "0.1.82" },
      { spec: spec("ms-desk"), name: "ms-desk", version: "2.32.0" },
    ],
  })
  const finding = pluginUpdateFinding({ env, pluginRoot: a.pluginRoot, homeDir: a.home, platform: "darwin" })
  assert.deepEqual(finding.plugins, [{ name: "cit", from: "0.1.81", to: "0.1.82" }, { name: "desk", from: "3.2.154", to: "3.2.167" }])
  assert.equal(finding.line, "There's an update to cit (0.1.81 → 0.1.82), desk (3.2.154 → 3.2.167); restart the Copilot app when it suits you to pick it up.")
  assert.equal(finding.auto_restart, false)
  assert.match(finding.relay, /once per session/u)
})

test("with Housesitter's auto-restart job installed the line says the app will restart by itself", async () => {
  const a = await agency({ loaded: { cit: "0.1.81" }, fetched: [{ spec: spec("cit"), name: "cit", version: "0.1.82" }] })
  const dir = path.join(a.home, "Library", "LaunchAgents")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${HOUSESITTER_AGENT_LABEL}.plist`), "<plist/>")
  assert.equal(housesitterRestartsApp({ homeDir: a.home, platform: "darwin" }), true)
  assert.equal(housesitterRestartsApp({ homeDir: a.home, platform: "win32" }), false, "the job is a Mac's launchd agent")
  const finding = pluginUpdateFinding({ env, pluginRoot: a.pluginRoot, homeDir: a.home, platform: "darwin" })
  assert.equal(finding.auto_restart, true)
  assert.equal(finding.line, pluginUpdateLine(finding.plugins, true))
  assert.match(finding.line, /^There's an update to cit \(0\.1\.81 → 0\.1\.82\); Housesitter on this Mac will restart the app to pick it up when nobody is using it/u)
})

test("nothing is said when every loaded plugin is current or newer, a plugin has no fetched release, or Desk is skipped", async () => {
  const a = await agency({
    loaded: { desk: "3.2.154", cit: "0.1.83", other: "1.0.0" },
    fetched: [{ spec: spec("desk", "release"), name: "desk", version: "3.2.167" }, { spec: spec("cit"), name: "cit", version: "0.1.82" }],
  })
  assert.equal(pluginUpdateFinding({ env, pluginRoot: a.pluginRoot, homeDir: a.home, skip: ["desk"] }), null)
})

test("it says nothing outside an Agency session folder, without an engine, or when the cache is missing; it never throws", async () => {
  const a = await agency({ loaded: { cit: "0.1.81" }, fetched: [{ spec: spec("cit"), name: "cit", version: "0.1.82" }] })
  assert.equal(pluginUpdateFinding({ env: {}, pluginRoot: "/somewhere/plugins/desk", homeDir: a.home }), null, "not a session root")
  assert.equal(pluginUpdateFinding({ env: {}, pluginRoot: a.pluginRoot, homeDir: a.home }), null, "no engine to pick cache entries by")
  await fs.rm(a.cache, { recursive: true })
  assert.equal(pluginUpdateFinding({ env, pluginRoot: a.pluginRoot, homeDir: a.home }), null)
  assert.equal(pluginUpdateFinding(), null)
})

test("the launcher's own root is used when Desk runs from a newer release copy outside the session folder", async () => {
  const a = await agency({ loaded: { cit: "0.1.81" }, fetched: [{ spec: spec("cit"), name: "cit", version: "0.1.82" }] })
  const finding = pluginUpdateFinding({ env: { ...env, DESK_PLUGIN_ROOT: a.pluginRoot }, pluginRoot: "/home/x/.cache/release-copies/3.2.167", homeDir: a.home })
  assert.equal(finding.plugins[0].name, "cit")
})

test("checkPluginUpdate stays off inside a node:test run", async () => {
  const a = await agency({ loaded: { cit: "0.1.81" }, fetched: [{ spec: spec("cit"), name: "cit", version: "0.1.82" }] })
  assert.equal(checkPluginUpdate({ env: { ...env, NODE_TEST_CONTEXT: "child-v8" }, pluginRoot: a.pluginRoot, homeDir: a.home }), null)
})

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}

async function boot(extra) {
  const root = await mkTempRoot("desk-plugin-update-boot-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  return bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states: [], pending: [] }),
    staleDeskFn: async () => null,
    ...extra,
  })
}

test("boot prints the line once, right under the status line, and fills plugin_update; Desk is skipped when the stale-Desk line is printed", async () => {
  const finding = { plugins: [{ name: "cit", from: "0.1.81", to: "0.1.82" }], auto_restart: false, relay: "r", line: pluginUpdateLine([{ name: "cit", from: "0.1.81", to: "0.1.82" }], false) }
  const seen = []
  const result = await boot({ pluginUpdateFn: (args) => { seen.push(args.skip); return finding } })
  assert.deepEqual(result.plugin_update, finding)
  const text = formatBootText(result)
  assert.equal(text.split("\n")[1], finding.line)
  assert.equal(text.split(finding.line).length, 2)
  assert.deepEqual(seen, [[]])
  const stale = await boot({ staleDeskFn: async () => ({ line: "Desk is behind." }), pluginUpdateFn: (args) => { seen.push(args.skip); return null } })
  assert.equal(stale.plugin_update, null)
  assert.deepEqual(seen.at(-1), ["desk"])
  const none = await boot({ pluginUpdateFn: () => null })
  assert.equal(none.plugin_update, null)
  assert.ok(!formatBootText(none).includes("There's an update"))
  const broken = await boot({ pluginUpdateFn: () => { throw new Error("disk") } })
  assert.equal(broken.plugin_update, null, "a failing check never breaks boot")
})
