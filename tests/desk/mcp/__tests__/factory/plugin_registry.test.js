import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { backfillPluginSources, registrySource } from "../../../../../plugins/desk/mcp/src/factory/plugin-registry.js"
import { deriveMarker } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { factoryStateRoot, readMarker, setConsent, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { toPublished } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { ID, STORE, json, scratch, session } from "./_session_helpers.js"

const hook = createRequire(import.meta.url)("../../../../../plugins/desk/hooks/factory-end.cjs")

// A Claude Code plugin cache under <base>/cc/plugins/cache: each entry is [marketplace, plugin, version]. A marketplace is a GitHub marketplace (repo ourostack/desk, listing "listed" plugins) unless it is named in "nonGithub".
async function claudeRegistry({ base, env }, entries, { listed = ["desk", "twice", "old"], nonGithub = [] } = {}) {
  const dir = path.join(base, "cc")
  env.CLAUDE_CONFIG_DIR = dir
  const known = {}
  for (const [marketplace, plugin, version] of entries) {
    await fs.mkdir(path.join(dir, "plugins", "cache", marketplace, plugin, version), { recursive: true })
    const location = path.join(base, "market", marketplace)
    known[marketplace] = { source: nonGithub.includes(marketplace) ? { source: "directory", path: location } : { source: "github", repo: "ourostack/desk" }, installLocation: location }
    await json(path.join(location, ".claude-plugin", "marketplace.json"), { plugins: listed.map((name) => ({ name, source: `./plugins/${name}` })) })
  }
  await json(path.join(dir, "plugins", "known_marketplaces.json"), known)
}

test("a Claude Code plugin takes the source of the one marketplace whose cache holds its name and version, even when that version is no longer installed", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["ourostack", "desk", "3.2.0"], ["ourostack", "old", "1.0.0"]])
  assert.equal(registrySource("claude-code", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
  assert.deepEqual(backfillPluginSources("claude-code", [{ name: "old", version: "1.0.0" }], { env: ctx.env }), [{ name: "old", version: "1.0.0", source: "ourostack/desk" }])
}))

test("a missing cache folder, a version held by two marketplaces, a non-GitHub marketplace and an unlisted plugin leave the source absent", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["ourostack", "desk", "3.2.0"], ["ourostack", "twice", "1.0.0"], ["other", "twice", "1.0.0"], ["local", "old", "1.0.0"], ["ourostack", "unlisted", "1.0.0"]], { nonGithub: ["local"] })
  const plugins = [{ name: "desk", version: "3.3.0" }, { name: "twice", version: "1.0.0" }, { name: "old", version: "1.0.0" }, { name: "unlisted", version: "1.0.0" }, { name: "absent", version: "1.0.0" }, { name: "../x", version: "1.0.0" }, { name: "desk", version: "../3" }]
  assert.deepEqual(backfillPluginSources("claude-code", plugins, { env: ctx.env }), plugins)
  for (const plugin of plugins) assert.equal(Object.hasOwn(backfillPluginSources("claude-code", [plugin], { env: ctx.env })[0], "source"), false)
}))

test("a missing cache, an unreadable known-marketplaces file and a stray file in the cache leave the source absent", () => scratch(async (ctx) => {
  const plugins = [{ name: "desk", version: "3.2.0" }]
  ctx.env.CLAUDE_CONFIG_DIR = path.join(ctx.base, "nowhere")
  assert.deepEqual(backfillPluginSources("claude-code", plugins, { env: ctx.env }), plugins)
  await claudeRegistry(ctx, [["ourostack", "desk", "3.2.0"]])
  await fs.writeFile(path.join(ctx.base, "cc", "plugins", "cache", "stray-file"), "x")
  await fs.mkdir(path.join(ctx.base, "cc", "plugins", "cache", ".hidden", "desk", "3.2.0"), { recursive: true })
  assert.equal(registrySource("claude-code", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
  await fs.writeFile(path.join(ctx.base, "cc", "plugins", "known_marketplaces.json"), "{not json")
  assert.deepEqual(backfillPluginSources("claude-code", plugins, { env: ctx.env }), plugins)
}))

test("a plugin that already has a source key, even null, is untouched", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["ourostack", "desk", "3.2.0"]])
  const plugins = [{ name: "desk", version: "3.2.0", source: null }, { name: "desk", version: "3.2.0", source: "acme/fork" }]
  const result = backfillPluginSources("claude-code", plugins, { env: ctx.env })
  assert.deepEqual(result, plugins)
  assert.equal(result[0], plugins[0])
}))

test("without HOME in the environment the registry is under the operating system's home directory", () => scratch(async (ctx) => {
  await fs.mkdir(path.join(ctx.base, ".claude", "plugins", "cache"), { recursive: true })
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = ctx.base
  process.env.USERPROFILE = ctx.base
  try {
    assert.equal(registrySource("claude-code", "desk", "3.2.0", { env: {} }), null)
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
}))

test("the Claude Code registry falls back to ~/.claude without an override, and a Codex marker has nothing to fill", () => scratch(async (ctx) => {
  delete ctx.env.CLAUDE_CONFIG_DIR
  assert.equal(registrySource("claude-code", "desk", "3.2.0", { env: ctx.env }), null)
  assert.equal(registrySource("codex-cli", "desk", "3.2.0", { env: ctx.env }), null)
}))

async function copilotRegistry({ env }, installed, marketplaces) {
  await fs.mkdir(env.COPILOT_HOME, { recursive: true })
  await fs.writeFile(path.join(env.COPILOT_HOME, "config.json"), `// Copilot config\n${JSON.stringify({ installedPlugins: installed })}`)
  await json(path.join(env.COPILOT_HOME, "settings.json"), { extraKnownMarketplaces: marketplaces })
}

test("a Copilot CLI plugin takes the source of its one install record, and ambiguity leaves it absent", () => scratch(async (ctx) => {
  ctx.env.COPILOT_HOME = path.join(ctx.base, "custom-copilot")
  await copilotRegistry(ctx, [
    { name: "desk", version: "3.2.0", marketplace: "ours" },
    { name: "dup", version: "1.0.0", marketplace: "ours" }, { name: "dup", version: "1.0.0", marketplace: "ours" },
  ], { ours: { source: { source: "github", repo: "ourostack/desk" } } })
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
  assert.equal(registrySource("copilot-cli", "desk", "3.1.0", { env: ctx.env }), null)
  assert.equal(registrySource("copilot-cli", "dup", "1.0.0", { env: ctx.env }), null)
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: { ...ctx.env, COPILOT_HOME: path.join(ctx.base, "nowhere") } }), null)
  delete ctx.env.COPILOT_HOME
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), null)
}))

test("a Copilot CLI plugin copied from Agency's cache takes the cached entry's GitHub source", () => scratch(async (ctx) => {
  const cache = path.join(ctx.base, ".local", "agency", "plugins", "cache")
  await json(path.join(cache, "cache_index.json"), { entries: { "copilot:github:ourostack/desk:plugins/desk@main": { dir_name: "desk-1" } } })
  await json(path.join(cache, "entries", "desk-1", "plugin.json"), { name: "desk", version: "3.2.0" })
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
  assert.equal(registrySource("copilot-cli", "desk", "3.3.0", { env: ctx.env }), null)
}))

test("the backfill gives the same source as the end hook's own metadata for the same installed plugin", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["ourostack", "desk", "3.2.0"]])
  await json(path.join(ctx.base, "cc", "plugins", "installed_plugins.json"), { plugins: { "desk@ourostack": [{ version: "3.2.0", installPath: path.join(ctx.base, "cc", "plugins", "cache", "ourostack", "desk", "3.2.0") }] } })
  const { PATTERNS } = await import("../../../../../plugins/desk/mcp/src/factory/schema.js")
  const { readSmallText } = await import("../../../../../plugins/desk/mcp/src/factory/marker.js")
  const metadata = hook.metadata({ host: "claude", pluginRoot: ctx.base, home: ctx.base, env: ctx.env, readSmallText, PATTERNS })
  const [hooked] = metadata.plugins
  assert.equal(registrySource("claude-code", hooked.name, hooked.version, { env: ctx.env }), hooked.source)
  assert.equal(hooked.source, "ourostack/desk")
}))

async function agencyIndex({ base }, specs) {
  const cache = path.join(base, ".local", "agency", "plugins", "cache")
  const entries = {}
  let n = 0
  for (const [spec, version] of specs) {
    const dir = `entry-${n++}`
    entries[spec] = { dir_name: dir }
    await json(path.join(cache, "entries", dir, "plugin.json"), { name: "desk", version })
  }
  await json(path.join(cache, "cache_index.json"), { entries })
}
const PLAIN_A = [{ name: "desk", version: "3.2.0", marketplace: "ours" }]
const MARKETS_A = { ours: { source: { source: "github", repo: "ourostack/desk" } } }
const AGENCY_A = "copilot:github:ourostack/desk:plugins/desk@main"

test("Copilot: a plain install and an absent Agency entry give the plain source; an absent plain install and an Agency entry give the Agency source", () => scratch(async (ctx) => {
  await copilotRegistry(ctx, PLAIN_A, MARKETS_A)
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
  await copilotRegistry(ctx, [], {})
  await agencyIndex(ctx, [[AGENCY_A, "3.2.0"]])
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
}))

test("Copilot: plain and Agency naming the same repository agree; naming different repositories, or Agency holding a non-GitHub entry at that version, block", () => scratch(async (ctx) => {
  await copilotRegistry(ctx, PLAIN_A, MARKETS_A)
  await agencyIndex(ctx, [[AGENCY_A, "3.2.0"]])
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
  await agencyIndex(ctx, [["copilot:github:acme/other:plugins/desk@main", "3.2.0"]])
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), null)
  await agencyIndex(ctx, [["copilot:url:https://example.com/desk.git", "3.2.0"]])
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), null)
  // A different version in Agency's cache does not conflict.
  await agencyIndex(ctx, [["copilot:url:https://example.com/desk.git", "3.1.0"]])
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
}))

test("Copilot: a plain record with no GitHub marketplace blocks even when Agency names a repository", () => scratch(async (ctx) => {
  await copilotRegistry(ctx, PLAIN_A, { ours: { source: { source: "url", url: "https://example.com" } } })
  await agencyIndex(ctx, [[AGENCY_A, "3.2.0"]])
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), null)
}))

test("Copilot: a corrupt, unreadable or wrongly shaped Agency index blocks a plain record, and a missing index does not", () => scratch(async (ctx) => {
  await copilotRegistry(ctx, PLAIN_A, MARKETS_A)
  const index = path.join(ctx.base, ".local", "agency", "plugins", "cache", "cache_index.json")
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk", "missing index")
  await fs.mkdir(path.dirname(index), { recursive: true })
  for (const body of ["{not json", "[]", "null", '{"entries": []}', '{"other": {}}', '{"entries": "x"}']) {
    await fs.writeFile(index, body)
    assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), null, body)
  }
  await json(index, { entries: {} })
  assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk", "empty index")
  await fs.chmod(index, 0)
  try {
    assert.equal(registrySource("copilot-cli", "desk", "3.2.0", { env: ctx.env }), null, "unreadable")
  } finally {
    await fs.chmod(index, 0o600)
  }
}))

test("the hook's own lookups still answer only a repository or null", () => scratch(async (ctx) => {
  const { PATTERNS } = await import("../../../../../plugins/desk/mcp/src/factory/schema.js")
  const { readSmallText } = await import("../../../../../plugins/desk/mcp/src/factory/marker.js")
  await copilotRegistry(ctx, PLAIN_A, MARKETS_A)
  await agencyIndex(ctx, [["copilot:url:https://example.com/desk.git", "3.2.0"]])
  const plain = hook.copilotSources(ctx.env.COPILOT_HOME, readSmallText, PATTERNS, () => false)
  const agency = hook.agencySources(ctx.base, readSmallText, PATTERNS, () => false)
  assert.equal(plain("desk", "3.2.0"), "ourostack/desk")
  assert.equal(plain("desk", "9.9.9"), null)
  assert.equal(agency("desk", "3.2.0"), null)
  assert.equal(agency("other", "3.2.0"), null)
  await fs.writeFile(path.join(ctx.base, ".local", "agency", "plugins", "cache", "cache_index.json"), "{not json")
  assert.equal(hook.agencySources(ctx.base, readSmallText, PATTERNS, () => false)("desk", "3.2.0"), null)
}))

test("a symlinked plugin or version folder in the Claude Code cache does not count", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["ourostack", "desk", "3.2.0"], ["ourostack", "old", "1.0.0"]])
  const cache = path.join(ctx.base, "cc", "plugins", "cache", "ourostack")
  await fs.mkdir(path.join(ctx.base, "elsewhere"), { recursive: true })
  await fs.symlink(path.join(ctx.base, "elsewhere"), path.join(cache, "desk", "3.3.0"))
  await fs.rm(path.join(cache, "old"), { recursive: true })
  await fs.symlink(path.join(cache, "desk"), path.join(cache, "old"))
  assert.equal(registrySource("claude-code", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
  assert.equal(registrySource("claude-code", "desk", "3.3.0", { env: ctx.env }), null)
  assert.equal(registrySource("claude-code", "old", "1.0.0", { env: ctx.env }), null)
}))

test("a re-derive of a marker without sources publishes desk:worker by name, and the marker file is not rewritten", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["ourostack", "desk", "3.2.0"]])
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = { ...await session(ctx), plugins: [{ name: "desk", version: "3.2.0" }], end_reason: "complete", ended_at: "2026-09-26T08:01:00.000Z" }
  const sub = path.join(path.dirname(marker.log_path), ID, "subagents")
  await json(path.join(sub, "agent-1.meta.json"), { agentType: "desk:worker", model: "claude-sonnet-5" })
  await fs.writeFile(path.join(sub, "agent-1.jsonl"), `${JSON.stringify({ type: "assistant", sessionId: ID, timestamp: "2026-09-26T08:00:30.000Z", message: { id: "w1", model: "claude-sonnet-5", content: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n`)
  await writeMarker(ctx.env, marker)
  const markerFile = path.join(await factoryStateRoot(ctx.env), "markers", `claude-code-${ID}.json`)
  const before = await fs.readFile(markerFile, "utf8")
  assert.deepEqual(await deriveMarker(ctx.env, marker, { ownVersion: () => "3.2.0" }), { result: "written", store: STORE })
  const facts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `claude-code-${ID}.json`), "utf8"))
  assert.equal(validateLocalFacts(facts).ok, true)
  assert.deepEqual(facts.plugins, [{ name: "desk", version: "3.2.0", source: "ourostack/desk" }])
  assert.equal(await fs.readFile(markerFile, "utf8"), before)
  assert.deepEqual((await readMarker(ctx.env, markerFile)).plugins, [{ name: "desk", version: "3.2.0" }])
  const { published } = toPublished(facts, { visibility: (repo) => (repo === "ourostack/desk" ? "public" : "unknown"), deskVisibility: "private", storeVisibility: "public" })
  assert.ok(facts.agents.some((agent) => agent.agent_type === "desk:worker"))
  assert.ok(published.agents.some((agent) => agent.agent_type === "desk:worker"))
  assert.deepEqual(published.plugins.map((plugin) => plugin.name), ["desk"])
}))

test("when the end hook cannot be found the backfill finds no source and leaves the plugin hidden, without throwing", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["ourostack", "desk", "3.2.0"]])
  const plugins = [{ name: "desk", version: "3.2.0" }]
  assert.equal(registrySource("claude-code", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
  // A throwing getter makes the root lookup itself fail; the helper still answers null.
  const broken = new Proxy({ ...ctx.env }, { get(target, key) { if (key === "DESK_PLUGIN_ROOT") throw new Error("boom"); return target[key] } })
  assert.equal(registrySource("claude-code", "desk", "3.2.0", { env: broken }), null)
  assert.deepEqual(backfillPluginSources("claude-code", plugins, { env: broken }), plugins)
}))

test("loadEndHook answers the module from the named root or its own, and null from a mirror with no hooks folder", () => scratch(async (ctx) => {
  const source = "../../../../../plugins/desk/mcp/src/factory/end-hook.js"
  const { loadEndHook } = await import(source)
  assert.equal(typeof loadEndHook({}).metadata, "function")
  assert.equal(typeof loadEndHook({ DESK_PLUGIN_ROOT: path.join(ctx.base, "nowhere") }).metadata, "function")
  assert.equal(loadEndHook(null), null)
  // The installed shape: the same file in a source mirror with no hooks/ beside it, and no root that has one.
  const mirror = path.join(ctx.base, "mirror", "mcp", "src", "factory")
  await fs.mkdir(mirror, { recursive: true })
  await fs.copyFile(new URL(source, import.meta.url), path.join(mirror, "end-hook.js"))
  const mirrored = await import(pathToFileURL(path.join(mirror, "end-hook.js")).href)
  assert.equal(mirrored.loadEndHook({ DESK_PLUGIN_ROOT: path.join(ctx.base, "nowhere") }), null)
  // And the registry's own answer for a mirror is covered above by the broken-environment case.
}))
