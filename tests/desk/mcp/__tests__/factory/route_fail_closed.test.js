// An overlay whose manifest cannot be read, or a plugin registry that is missing, routes nowhere: never to the default (public) store,
// never remembered as a default route, and corrected once the manifest reads again (fail-open scan row 1, 2026-10-06). Every fixture
// is synthetic and lives in a temporary HOME; no real plugin registry or factory state is read.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { factoryStateRoot, listMarkers, setConsent, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { markerRoute, proofIndex, provenBy, sessionPlace, sessionRoute } from "../../../../../plugins/desk/mcp/src/factory/session-route.js"
import { placesFor } from "../../../../../plugins/desk/mcp/src/factory/capture-sweep.js"
import { deriveMarker } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { ID, STORE, json, recent, scratch, session } from "./_session_helpers.js"

const PRIVATE = "corp/private-factory"
const require = createRequire(import.meta.url)
const hook = () => require(fileURLToPath(new URL("../../../../../plugins/desk/hooks/factory-end.cjs", import.meta.url)))
const TRUNCATED = '{"name":"corp","version":"1.0.0","desk":{"factory":{"store":"corp/private-fac'
const HEALTHY = JSON.stringify({ name: "corp", version: "1.0.0", desk: { factory: { store: PRIVATE } } })

// A Claude Code home whose registry lists Desk (an old version, so this checkout may derive its sessions) and the corp overlay, with the overlay's manifest holding `manifest` text.
async function claudeHome(ctx, manifest) {
  const desk = path.join(ctx.base, "installed", "desk")
  const corp = path.join(ctx.base, "installed", "corp")
  await json(path.join(desk, "plugin.json"), { name: "desk", version: "1.0.0" })
  await fs.mkdir(corp, { recursive: true })
  await fs.writeFile(path.join(corp, "plugin.json"), manifest)
  await json(path.join(ctx.base, ".claude/plugins/installed_plugins.json"), { version: 2, plugins: {
    "desk@ourostack": [{ version: "1.0.0", installPath: desk }], "corp@corp": [{ version: "1.0.0", installPath: corp }],
  } })
  return { desk, corp, manifest: path.join(corp, "plugin.json") }
}

const endPayload = (ctx, marker, event = "SessionEnd") => ({ session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: event, reason: "prompt_input_exit" })
const runClaude = (ctx, payload) => hook().runHook({ host: "claude", payload, env: ctx.env, launch: async () => {} })
const outboxHas = async (env, store) => existsSync(path.join(await factoryStateRoot(env), "outbox", store.replace("/", "__"), `claude-code-${ID}.json`))

test("reproduction r1 through the end hook: an overlay truncated mid-write records no store, and the session is held", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const { manifest } = await claudeHome(ctx, TRUNCATED)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal(await runClaude(ctx, endPayload(ctx, marker)), "written")
  const [saved] = await listMarkers(ctx.env)
  assert.deepEqual(saved.routing, { store: null, source: "invalid_declaration", warnings: [{ code: "manifest_unparseable", manifest }] })
  assert.deepEqual(markerRoute(saved), saved.routing)
  assert.deepEqual(sessionRoute(saved, { siblings: () => [saved] }), { kind: "unknown" })
  assert.deepEqual(await deriveMarker(ctx.env, saved, { quietMs: 0, requireStored: true }), { result: "held", store: null })
  assert.equal(await outboxHas(ctx.env, STORE), false, "nothing reaches the public store's outbox")
}))

test("once the overlay reads again, the held session routes to the store it declares, not the default", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const { manifest } = await claudeHome(ctx, TRUNCATED)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await setConsent(ctx.env, { store: PRIVATE, contribute: true })
  await runClaude(ctx, endPayload(ctx, marker))
  const [saved] = await listMarkers(ctx.env)
  await fs.writeFile(manifest, HEALTHY)
  assert.deepEqual(markerRoute(saved), { store: PRIVATE, source: "overlay", warnings: [] })
  assert.deepEqual(sessionRoute(saved, { siblings: () => [saved] }), { kind: "store", store: PRIVATE })
  assert.deepEqual(await deriveMarker(ctx.env, saved, { quietMs: 0, requireStored: true }), { result: "written", store: PRIVATE })
  assert.equal(await outboxHas(ctx.env, STORE), false)
  // A later hook run for a live session records the healthy route outright.
  await runClaude(ctx, endPayload(ctx, marker, "Stop"))
  assert.deepEqual((await listMarkers(ctx.env))[0].routing, { store: PRIVATE, source: "overlay", warnings: [] })
}))

test("variants: an overlay that later declares nothing stays held, and one that is removed stays held", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const { corp, manifest } = await claudeHome(ctx, TRUNCATED)
  await runClaude(ctx, endPayload(ctx, marker))
  const [saved] = await listMarkers(ctx.env)
  await fs.writeFile(manifest, JSON.stringify({ name: "corp", version: "1.0.0" }))
  assert.equal(markerRoute(saved).store, null, "what the plugins after it declared was never recorded")
  await fs.rm(corp, { recursive: true })
  assert.equal(markerRoute(saved).store, null)
  assert.deepEqual(sessionRoute(saved, { siblings: () => [saved] }), { kind: "unknown" })
}))

test("a missing Claude Code plugin registry holds the route instead of choosing the default", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  await runClaude(ctx, endPayload(ctx, marker))
  const [saved] = await listMarkers(ctx.env)
  assert.deepEqual(saved.routing, { store: null, source: "invalid_declaration", warnings: [] })
  // The desk's own declaration still routes: it never depends on the plugin scan.
  await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: STORE })
  await runClaude(ctx, endPayload(ctx, marker))
  assert.deepEqual((await listMarkers(ctx.env))[0].routing, { store: STORE, source: "desk", warnings: [] })
}))

test("a Copilot overlay whose plugin.json cannot be parsed holds the route", () => scratch(async (ctx) => {
  const marker = await session(ctx, "copilot-cli")
  const plugins = path.join(ctx.base, ".copilot", "installed-plugins", "set")
  const pluginRoot = path.join(plugins, "desk")
  await json(path.join(pluginRoot, "plugin.json"), { name: "desk", version: "1.0.0" })
  await fs.mkdir(path.join(plugins, "corp"), { recursive: true })
  await fs.writeFile(path.join(plugins, "corp", "plugin.json"), TRUNCATED)
  assert.equal(await hook().runHook({ host: "copilot", payload: { sessionId: ID, cwd: ctx.desk, reason: "complete" }, env: ctx.env, pluginRoot, launch: async () => {} }), "written")
  const [saved] = await listMarkers(ctx.env)
  assert.equal(saved.log_path, marker.log_path)
  assert.deepEqual(saved.routing, { store: null, source: "invalid_declaration", warnings: [{ code: "manifest_unparseable", manifest: path.join(plugins, "corp", "plugin.json") }] })
}))

test("an existing marker that recorded the default after skipping a broken overlay is held, then corrected by the next sweep", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const { manifest } = await claudeHome(ctx, TRUNCATED)
  // What a Desk before 2026-10-06 wrote: the default store, with the broken overlay only as a warning.
  const legacy = { ...marker, end_reason: "prompt_input_exit", ended_at: recent(), updated_at: recent(), routing: { store: STORE, source: "default", warnings: [{ code: "manifest_unparseable", manifest }] } }
  await writeMarker(ctx.env, legacy)
  const name = `claude-code-${ID}.json`
  // Its facts already sit in the public store's outbox, from the derive that the old route allowed.
  const receipts = { [name]: { store: STORE, desk_root: ctx.desk } }
  const places = () => placesFor({ markers: [legacy], receipts, retracting: new Map() })(name, STORE)
  assert.equal(places(), "unknown", "frozen: never published, never deleted, while the overlay cannot be read")
  assert.equal(sessionPlace(STORE, sessionRoute(legacy, { siblings: () => [legacy] }), STORE), "unknown")
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.deepEqual(await deriveMarker(ctx.env, legacy, { quietMs: 0, requireStored: true }), { result: "held", store: null })
  await fs.writeFile(manifest, HEALTHY)
  assert.equal(places(), "away", "the overlay reads again: the session belongs to the private store, so the public copy is retracted")
  await fs.writeFile(manifest, JSON.stringify({ name: "corp", version: "1.0.0" }))
  assert.equal(places(), "here", "the overlay declares nothing: the recorded default was right after all")
}))

test("a default route recorded with a warning never proves a Codex default route", () => scratch(async (ctx) => {
  const { manifest } = await claudeHome(ctx, HEALTHY)
  const codex = { schema_version: 1, host: "codex-cli", session_id: ID, log_path: "/x", cwd: ctx.desk, desk_root: ctx.desk, end_reason: "other", ended_at: recent(), plugins: [], updated_at: recent() }
  const sibling = (warnings) => ({ ...codex, host: "claude-code", session_id: "00000000-0000-4000-8000-000000000001", routing: { store: STORE, source: "default", warnings } })
  assert.equal(provenBy(codex, proofIndex([sibling([])])), true)
  assert.equal(provenBy(codex, proofIndex([sibling([{ code: "manifest_unparseable", manifest }])])), false)
  assert.deepEqual(sessionRoute(codex, { siblings: () => [sibling([{ code: "manifest_unparseable", manifest }])] }), { kind: "derived" })
}))
