import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { createRequire } from "node:module"
import { backfillPluginSources, registrySource } from "../../../../../plugins/desk/mcp/src/factory/plugin-registry.js"
import { deriveMarker } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { factoryStateRoot, readMarker, setConsent, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { toPublished } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { ID, STORE, json, scratch, session } from "./_session_helpers.js"

const hook = createRequire(import.meta.url)("../../../../../plugins/desk/hooks/factory-end.cjs")

// A Claude Code registry under <base>/cc: each entry is [key, version], all from one GitHub marketplace repository.
async function claudeRegistry({ base, env }, entries, { repo = "ourostack/desk", listed = ["desk"] } = {}) {
  const dir = path.join(base, "cc")
  const market = path.join(base, "market")
  env.CLAUDE_CONFIG_DIR = dir
  const plugins = {}
  for (const [key, version] of entries) (plugins[key] ??= []).push({ version, installPath: path.join(base, "install", key, version) })
  await json(path.join(dir, "plugins", "installed_plugins.json"), { version: 2, plugins })
  await json(path.join(dir, "plugins", "known_marketplaces.json"), { ourostack: { source: { source: "github", repo }, installLocation: market }, other: { source: { source: "github", repo }, installLocation: market } })
  await json(path.join(market, ".claude-plugin", "marketplace.json"), { plugins: listed.map((name) => ({ name, source: `./plugins/${name}` })) })
}

test("a Claude Code plugin takes the source of the single installed entry with the same name and version", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["desk@ourostack", "3.2.0"], ["desk@ourostack", "3.1.0"]])
  assert.equal(registrySource("claude-code", "desk", "3.2.0", { env: ctx.env }), "ourostack/desk")
  assert.deepEqual(backfillPluginSources("claude-code", [{ name: "desk", version: "3.2.0" }], { env: ctx.env }), [{ name: "desk", version: "3.2.0", source: "ourostack/desk" }])
}))

test("a version mismatch, two matches, an unlisted plugin and an unknown plugin leave the source absent", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["desk@ourostack", "3.2.0"], ["twice@ourostack", "1.0.0"], ["twice@other", "1.0.0"], ["unlisted@ourostack", "1.0.0"]], { listed: ["desk", "twice"] })
  const plugins = [{ name: "desk", version: "3.3.0" }, { name: "twice", version: "1.0.0" }, { name: "unlisted", version: "1.0.0" }, { name: "absent", version: "1.0.0" }]
  assert.deepEqual(backfillPluginSources("claude-code", plugins, { env: ctx.env }), plugins)
  for (const plugin of plugins) assert.equal(Object.hasOwn(backfillPluginSources("claude-code", [plugin], { env: ctx.env })[0], "source"), false)
}))

test("a missing registry, a corrupt registry and a registry without a plugins object leave the source absent", () => scratch(async (ctx) => {
  const plugins = [{ name: "desk", version: "3.2.0" }]
  ctx.env.CLAUDE_CONFIG_DIR = path.join(ctx.base, "nowhere")
  assert.deepEqual(backfillPluginSources("claude-code", plugins, { env: ctx.env }), plugins)
  const file = path.join(ctx.base, "cc", "plugins", "installed_plugins.json")
  ctx.env.CLAUDE_CONFIG_DIR = path.join(ctx.base, "cc")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "{not json")
  assert.deepEqual(backfillPluginSources("claude-code", plugins, { env: ctx.env }), plugins)
  await json(file, { plugins: [] })
  assert.deepEqual(backfillPluginSources("claude-code", plugins, { env: ctx.env }), plugins)
  await json(file, { plugins: { "desk@ourostack": "not a list" } })
  assert.deepEqual(backfillPluginSources("claude-code", plugins, { env: ctx.env }), plugins)
}))

test("a plugin that already has a source key, even null, is untouched", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["desk@ourostack", "3.2.0"]])
  const plugins = [{ name: "desk", version: "3.2.0", source: null }, { name: "desk", version: "3.2.0", source: "acme/fork" }]
  const result = backfillPluginSources("claude-code", plugins, { env: ctx.env })
  assert.deepEqual(result, plugins)
  assert.equal(result[0], plugins[0])
}))

test("without HOME in the environment the registry is under the operating system's home directory", () => scratch(async (ctx) => {
  await json(path.join(ctx.base, ".claude", "plugins", "installed_plugins.json"), { plugins: {} })
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
  assert.equal(registrySource("claude-code", "desk", "3.2.0", { env: { HOME: ctx.base } }), null)
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

test("the backfill reads the registry through the end hook's own lookups", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["desk@ourostack", "3.2.0"]])
  const { PATTERNS } = await import("../../../../../plugins/desk/mcp/src/factory/schema.js")
  const { readSmallText } = await import("../../../../../plugins/desk/mcp/src/factory/marker.js")
  const metadata = hook.metadata({ host: "claude", pluginRoot: ctx.base, home: ctx.base, env: ctx.env, readSmallText, PATTERNS })
  const [hooked] = metadata.plugins
  assert.equal(registrySource("claude-code", hooked.name, hooked.version, { env: ctx.env }), hooked.source)
  assert.equal(hooked.source, "ourostack/desk")
}))

test("a re-derive of a marker without sources publishes desk:worker by name, and the marker file is not rewritten", () => scratch(async (ctx) => {
  await claudeRegistry(ctx, [["desk@ourostack", "3.2.0"]])
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
