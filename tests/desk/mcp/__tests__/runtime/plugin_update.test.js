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
  changesPerProcess,
  checkPluginUpdate,
  HOUSESITTER_AGENT_LABEL,
  housesitterRestartsApp,
  loadedPlugins,
  newestFetched,
  pluginUpdateFinding,
  pluginUpdateLine,
} from "../../../../../plugins/desk/mcp/src/runtime/plugin-update.js"

const SHA = "a".repeat(40)

function plugin(dir, name, version, claude = false, files = {}) {
  const where = claude ? path.join(dir, ".claude-plugin") : dir
  mkdirSync(where, { recursive: true })
  writeFileSync(path.join(where, "plugin.json"), JSON.stringify({ name, version }))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
}

// An Agency data folder: one session folder with a root per plugin, and a cache of fetched releases.
async function agency({ loaded, fetched }) {
  const home = await mkTempRoot("desk-plugin-update-")
  const plugins = path.join(home, ".local", "agency", "plugins")
  const session = path.join(plugins, "sessions", "agency-plugin-abc.p123")
  Object.entries(loaded).forEach(([name, version], index) => plugin(path.join(session, `root-${index}`, name), name, version, name === "crew", { "skills/s/SKILL.md": "old text", "mcp/src/server.js": "v1", "mcp/src/tool-schemas.js": "v1" }))
  const entries = {}
  fetched.forEach(({ spec, name, version, at = 1000, files = { "skills/s/SKILL.md": "new text" } }, index) => {
    plugin(path.join(plugins, "cache", "entries", `e${index}`), name, version, false, { "mcp/src/server.js": "v1", "mcp/src/tool-schemas.js": "v1", ...files })
    entries[spec] = { spec, dir_name: `e${index}`, fetched_at: at, resolved_sha: SHA }
  })
  mkdirSync(path.join(plugins, "cache"), { recursive: true })
  writeFileSync(path.join(plugins, "cache", "cache_index.json"), JSON.stringify({ entries }))
  return { home, pluginRoot: path.join(session, "root-0", Object.keys(loaded)[0]), session, cache: path.join(plugins, "cache") }
}

const spec = (name, ref = "main", engine = "copilot") => `${engine}:github:org/repo:plugins/${name}@${ref}`
const env = { AGENCY_ENGINE: "copilot" }
const find = (a, extra = {}) => pluginUpdateFinding({ env, pluginRoot: a.pluginRoot, agentHost: undefined, homeDir: a.home, skip: [], ...extra })

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
      { spec: spec("desk", "older"), name: "desk", version: "3.2.100", at: 1500 },
      { spec: spec("desk", "newer"), name: "desk", version: "3.2.168", at: 2500 },
    ],
  })
  assert.deepEqual([...newestFetched(a.cache, "copilot")].sort(), [["cit", "0.1.82"], ["desk", "3.2.168"]], "the most recently fetched entry wins, whatever its version")
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
  const finding = find(a)
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
  assert.equal(housesitterRestartsApp(a.home), true)
  assert.equal(housesitterRestartsApp(path.join(a.home, "elsewhere")), false)
  const finding = find(a)
  assert.equal(finding.auto_restart, true)
  assert.equal(finding.line, pluginUpdateLine(finding.plugins, true))
  assert.match(finding.line, /^There's an update to cit \(0\.1\.81 → 0\.1\.82\); Housesitter on this Mac will restart the app to pick it up when nobody is using it/u)
})

test("a newer release that changes only what updates in place is not announced; a skill, hook, agent or Desk tool-schema change is", async () => {
  const fetched = (files) => [{ spec: spec("desk", "release"), name: "desk", version: "3.2.168", files }]
  const runtime = await agency({ loaded: { desk: "3.2.154" }, fetched: fetched({ "skills/s/SKILL.md": "old text", "mcp/src/server.js": "v2", "docs/x.md": "new", "README.md": "new" }) })
  assert.equal(find(runtime), null, "a Desk release that touches only its runtime and docs needs no restart")
  const skill = await agency({ loaded: { desk: "3.2.154" }, fetched: fetched({ "skills/s/SKILL.md": "edited" }) })
  assert.deepEqual(find(skill).plugins, [{ name: "desk", from: "3.2.154", to: "3.2.168" }])
  const schema = await agency({ loaded: { desk: "3.2.154" }, fetched: fetched({ "skills/s/SKILL.md": "old text", "mcp/src/tool-schemas.js": "v2" }) })
  assert.equal(find(schema).plugins[0].name, "desk", "the MCP session layer is fixed per process")
  const other = await agency({ loaded: { cit: "0.1.81" }, fetched: [{ spec: spec("cit"), name: "cit", version: "0.1.82", files: { "skills/s/SKILL.md": "old text", "mcp/src/tool-schemas.js": "v2", "hooks/h.cjs": "new hook" } }] })
  assert.equal(find(other).plugins[0].name, "cit", "a new hook counts for any plugin")
  const a = await agency({ loaded: { cit: "0.1.81" }, fetched: [] })
  const old = path.join(a.session, "root-0", "cit")
  const next = path.join(a.home, "next")
  plugin(next, "cit", "0.1.82", false, { "skills/s/SKILL.md": "old text", "mcp/src/server.js": "v1", "mcp/src/tool-schemas.js": "changed, but only Desk's is fixed" })
  assert.equal(changesPerProcess(old, next, "cit"), false, "a version bump, and a file only Desk treats as fixed, are nothing for another plugin")
  assert.equal(changesPerProcess(old, next, "desk"), true)
  const broken = path.join(a.home, "broken")
  plugin(broken, "cit", "0.1.82", false, { "skills/s/SKILL.md": "old text", "mcp/src/server.js": "v1", "mcp/src/tool-schemas.js": "v1", ".claude-plugin/plugin.json": "{not json" })
  assert.equal(changesPerProcess(old, broken, "cit"), true, "a manifest that cannot be read is a change, not a reason to stay silent")
})

test("nothing is said when every loaded plugin is current or newer, a plugin has no fetched release, or Desk is skipped", async () => {
  const a = await agency({
    loaded: { desk: "3.2.154", cit: "0.1.83", other: "1.0.0" },
    fetched: [{ spec: spec("desk", "release"), name: "desk", version: "3.2.167" }, { spec: spec("cit"), name: "cit", version: "0.1.82" }],
  })
  assert.equal(find(a, { skip: ["desk"] }), null)
})

test("it says nothing outside an Agency session folder, without an engine, or when the cache is missing; it never throws", async () => {
  const a = await agency({ loaded: { cit: "0.1.81" }, fetched: [{ spec: spec("cit"), name: "cit", version: "0.1.82" }] })
  assert.equal(find(a, { env: {}, pluginRoot: "/somewhere/plugins/desk" }), null, "not a session root")
  assert.equal(find(a, { env: {} }), null, "no engine to pick cache entries by")
  const unreadable = { get DESK_PLUGIN_ROOT() { throw new Error("env") } }
  assert.equal(find(a, { env: unreadable }), null, "a failing read is no finding")
  await fs.rm(a.cache, { recursive: true })
  assert.equal(find(a), null)
})

test("the launcher's own root is used when Desk runs from a newer release copy outside the session folder", async () => {
  const a = await agency({ loaded: { cit: "0.1.81" }, fetched: [{ spec: spec("cit"), name: "cit", version: "0.1.82" }] })
  const finding = find(a, { env: { ...env, DESK_PLUGIN_ROOT: a.pluginRoot }, pluginRoot: "/home/x/.cache/release-copies/3.2.167" })
  assert.equal(finding.plugins[0].name, "cit")
})

test("checkPluginUpdate stays off inside a node:test run", async () => {
  const a = await agency({ loaded: { cit: "0.1.81" }, fetched: [{ spec: spec("cit"), name: "cit", version: "0.1.82" }] })
  assert.equal(checkPluginUpdate({ env, pluginRoot: a.pluginRoot, agentHost: undefined, homeDir: a.home, skip: [] }), null)
})

test("a manifest that is missing, unreadable, nameless or without a semver version is not a plugin, and a cache entry with no copy is skipped", async () => {
  const a = await agency({ loaded: { cit: "0.1.81" }, fetched: [{ spec: spec("cit"), name: "cit", version: "0.1.82" }, { spec: spec("gone"), name: "gone", version: "1.0.0" }] })
  const root = path.join(a.session, "root-1")
  writeFileSync(path.join(a.session, "stray-file"), "x")
  mkdirSync(path.join(root, "empty"), { recursive: true })
  mkdirSync(path.join(root, "broken"), { recursive: true })
  writeFileSync(path.join(root, "broken", "plugin.json"), "{not json")
  plugin(path.join(root, "nameless"), 7, "1.0.0")
  plugin(path.join(root, "loose"), "loose", "banana")
  assert.deepEqual(loadedPlugins(a.session).map((p) => p.name), ["cit"])
  await fs.rm(path.join(a.cache, "entries", "e1"), { recursive: true })
  assert.deepEqual([...newestFetched(a.cache, "copilot")], [["cit", "0.1.82"]])
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
