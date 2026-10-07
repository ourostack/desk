// An overlay whose manifest cannot be read, or a plugin registry that is missing, routes nowhere: never to the default (public) store,
// never remembered as a default route, and corrected once the manifest reads again (fail-open scan row 1, 2026-10-06). Every fixture
// is synthetic and lives in a temporary HOME; no real plugin registry or factory state is read.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"

import { runHook } from "../../../../../plugins/desk/hooks/lib/factory-end.cjs"
import { metadata } from "../../../../../plugins/desk/mcp/src/factory/plugin-sources.cjs"
import { factoryStateRoot, listMarkers, setConsent, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { markerRoute, proofIndex, provenBy, sessionPlace, sessionRoute } from "../../../../../plugins/desk/mcp/src/factory/session-route.js"
import { placesFor } from "../../../../../plugins/desk/mcp/src/factory/capture-sweep.js"
import { deriveMarker, sweep } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { HOLD_REMEDIES, holdReason, routeHolds } from "../../../../../plugins/desk/mcp/src/factory/held-route.js"
import { factoryLocalStatus } from "../../../../../plugins/desk/mcp/src/factory/local-status.js"
import { readSmallText } from "../../../../../plugins/desk/mcp/src/factory/marker.js"
import { PATTERNS } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { resolveStore } from "../../../../../plugins/desk/mcp/src/factory/store-route.js"
import { factoryFindingLines } from "../../../../../plugins/desk/mcp/src/tools/factory-context.js"
import { ID, STORE, json, recent, scratch, session } from "./_session_helpers.js"

const PRIVATE = "corp/private-factory"
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
// The hook runs from Desk's registered install folder, as an installed Desk does (`claudeHome`).
const runClaude = (ctx, payload, pluginRoot = path.join(ctx.base, "installed", "desk")) => runHook({ host: "claude", payload, env: ctx.env, pluginRoot, launch: async () => {} })
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
  assert.equal(await runHook({ host: "copilot", payload: { sessionId: ID, cwd: ctx.desk, reason: "complete" }, env: ctx.env, pluginRoot, launch: async () => {} }), "written")
  const [saved] = await listMarkers(ctx.env)
  assert.equal(saved.log_path, marker.log_path)
  assert.deepEqual(saved.routing, { store: null, source: "invalid_declaration", warnings: [{ code: "manifest_unparseable", manifest: path.join(plugins, "corp", "plugin.json") }] })
}))

test("an existing marker that recorded the default after skipping a broken overlay is held, and a reread never releases it to the public store", () => scratch(async (ctx) => {
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
  // Review round 2, M2: the warned path now declares nothing (an overlay update moved its declaration, or another plugin took the folder).
  // The older Desk's recorded default is not proof, so the session stays held.
  await fs.writeFile(manifest, JSON.stringify({ name: "corp", version: "1.0.0" }))
  assert.equal(places(), "unknown", "the overlay declares nothing: still held, never the recorded public default")
  assert.deepEqual(await deriveMarker(ctx.env, legacy, { quietMs: 0, requireStored: true }), { result: "held", store: null })
  await fs.writeFile(manifest, JSON.stringify({ name: "other", desk: { factory: { store: STORE } } }))
  assert.equal(places(), "unknown", "a plugin at the warned path that declares the public store does not release it either")
}))

test("review round 2, M1: a different plugin swapped into a held Copilot plugin folder cannot release the session to the public store", () => scratch(async (ctx) => {
  // A Copilot plugin folder carries no version, so the file at the warned path may be another plugin than the one the session ran with.
  const folder = path.join(ctx.base, ".copilot/installed-plugins/corp")
  const manifest = path.join(folder, "plugin.json")
  await fs.mkdir(folder, { recursive: true })
  const routing = { store: null, source: "invalid_declaration", warnings: [{ code: "manifest_unparseable", manifest }] }
  const held = { ...(await session(ctx)), host: "copilot-cli", end_reason: "other", ended_at: recent(), updated_at: recent(), plugins: [{ name: "corp", version: "1.0.0" }], routing }
  await writeMarker(ctx.env, held)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  for (const swapped of [{ name: "other", desk: { factory: { store: STORE } } }, { name: "other", desk: { factory: { store: "OuroStack/Factory" } } }, { name: "other" }]) {
    await fs.writeFile(manifest, JSON.stringify(swapped))
    assert.deepEqual(markerRoute(held), { store: null, source: "invalid_declaration", warnings: routing.warnings })
    assert.deepEqual(await deriveMarker(ctx.env, held, { quietMs: 0, requireStored: true }), { result: "held", store: null })
  }
  await fs.writeFile(manifest, JSON.stringify({ name: "corp", desk: { factory: { store: PRIVATE } } }))
  assert.deepEqual(markerRoute(held), { store: PRIVATE, source: "overlay", warnings: [] }, "a private declaration at its own path still releases it")
}))

test("a default route recorded with a warning never proves a Codex default route", () => scratch(async (ctx) => {
  const { manifest } = await claudeHome(ctx, HEALTHY)
  const codex = { schema_version: 1, host: "codex-cli", session_id: ID, log_path: "/x", cwd: ctx.desk, desk_root: ctx.desk, end_reason: "other", ended_at: recent(), plugins: [], updated_at: recent() }
  const sibling = (warnings) => ({ ...codex, host: "claude-code", session_id: "00000000-0000-4000-8000-000000000001", plugins: [{ name: "desk", version: "1.0.0" }], routing: { store: STORE, source: "default", warnings } })
  assert.equal(provenBy(codex, proofIndex([sibling([])])), true)
  assert.equal(provenBy(codex, proofIndex([sibling([{ code: "manifest_unparseable", manifest }])])), false)
  assert.deepEqual(sessionRoute(codex, { siblings: () => [sibling([{ code: "manifest_unparseable", manifest }])] }), { kind: "derived" })
}))

// ---------------------------------------------------------------------------
// Fix round 1 (#193 review, findings 1 to 7).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000
const registry = (ctx, plugins) => json(path.join(ctx.base, ".claude/plugins/installed_plugins.json"), { version: 2, plugins })

test("finding 1: a held legacy marker stays unknown whatever its age, and whether or not its desk folder resolves", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const { manifest } = await claudeHome(ctx, TRUNCATED)
  const legacy = { ...marker, routing: { store: STORE, source: "default", warnings: [{ code: "manifest_unparseable", manifest }] } }
  const route = (m, now) => sessionRoute(m, { siblings: () => [m], deskRoot: ctx.desk, now })
  assert.deepEqual(route(legacy, Date.now() + 31 * DAY), { kind: "unknown" })
  assert.deepEqual(route({ ...legacy, desk_root: path.join(ctx.base, "moved") }, Date.now()), { kind: "unknown" })
  // Settled once the overlay reads: the usual rules apply again.
  await fs.writeFile(manifest, HEALTHY)
  assert.deepEqual(route(legacy, Date.now()), { kind: "store", store: PRIVATE })
}))

test("finding 2: an overlay the registry lists whose folder is missing holds the route, and is released when the folder returns and declares its store", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const desk = path.join(ctx.base, "installed", "desk")
  const corp = path.join(ctx.base, "installed", "corp")
  await json(path.join(desk, "plugin.json"), { name: "desk", version: "1.0.0" })
  await registry(ctx, { "desk@ourostack": [{ version: "1.0.0", installPath: desk }], "corp@corp": [{ version: "1.0.0", installPath: corp }] })
  await runClaude(ctx, endPayload(ctx, marker))
  const [saved] = await listMarkers(ctx.env)
  assert.deepEqual(saved.routing, { store: null, source: "invalid_declaration", warnings: [{ code: "manifest_unreadable", manifest: corp }] })
  assert.deepEqual(sessionRoute(saved, { siblings: () => [saved] }), { kind: "unknown" })
  // The plugin finishes installing, with its manifest where Claude Code keeps it.
  await json(path.join(corp, ".claude-plugin", "plugin.json"), { name: "corp", version: "1.0.0", desk: { factory: { store: PRIVATE } } })
  assert.deepEqual(markerRoute(saved), { store: PRIVATE, source: "overlay", warnings: [] })
  // A folder present with no manifest at all declares nothing, as a Claude Code plugin may.
  assert.deepEqual(resolveStore({ deskRoot: ctx.desk, pluginDirs: [desk] }), { store: STORE, source: "default", warnings: [] })
}))

test("finding 3: a Copilot overlay installed as a link to its folder is read through the link; a link that resolves nowhere holds the route", () => scratch(async (ctx) => {
  await session(ctx, "copilot-cli")
  const plugins = path.join(ctx.base, ".copilot", "installed-plugins", "set")
  const pluginRoot = path.join(plugins, "desk")
  await json(path.join(pluginRoot, "plugin.json"), { name: "desk", version: "1.0.0" })
  const real = path.join(ctx.base, "dev", "corp")
  await json(path.join(real, "plugin.json"), { name: "corp", version: "1.0.0", desk: { factory: { store: PRIVATE } } })
  await fs.symlink(real, path.join(plugins, "corp"))
  const run = () => runHook({ host: "copilot", payload: { sessionId: ID, cwd: ctx.desk, reason: "complete" }, env: ctx.env, pluginRoot, launch: async () => {} })
  assert.equal(await run(), "written")
  assert.deepEqual((await listMarkers(ctx.env))[0].routing, { store: PRIVATE, source: "overlay", warnings: [] })
  await fs.rm(real, { recursive: true })
  assert.equal(await run(), "written")
  assert.deepEqual((await listMarkers(ctx.env))[0].routing, { store: null, source: "invalid_declaration", warnings: [{ code: "manifest_unreadable", manifest: path.join(plugins, "corp") }] })
}))

test("finding 6: a Desk the registry does not list (claude --plugin-dir) holds the route, and the doctor names why and what to do", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  await claudeHome(ctx, HEALTHY)
  await runClaude(ctx, endPayload(ctx, marker), path.join(ctx.base, "dev", "desk"))
  assert.deepEqual((await listMarkers(ctx.env))[0].routing, { store: null, source: "invalid_declaration", warnings: [] })
  const scan = metadata({ host: "claude", pluginRoot: path.join(ctx.base, "dev", "desk"), home: ctx.base, env: ctx.env, readSmallText, PATTERNS })
  assert.equal(scan.reason, "desk_not_in_registry")
  const status = factoryLocalStatus({ env: ctx.env, deskRoot: ctx.desk, pluginDirs: scan.dirs, pluginScanIncomplete: scan.incomplete, pluginScanReason: scan.reason })
  assert.deepEqual(status.held_by, [{ reason: "desk_not_in_registry", path: null, remedy: HOLD_REMEDIES.desk_not_in_registry }])
  assert.match(factoryFindingLines(status).join("\n"), /desk_not_in_registry: start sessions from an installed Desk \(not `claude --plugin-dir`\)/u)
}))

test("finding 7: an older Claude Code marker with a default route and no plugins at all read a missing registry as empty: held, and never a Codex proof", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const legacy = { ...marker, plugins: [], routing: { store: STORE, source: "default", warnings: [] } }
  assert.deepEqual(sessionRoute(legacy, { siblings: () => [legacy] }), { kind: "unknown" })
  assert.equal(proofIndex([legacy]).length, 0)
  // With its plugin list, the same route is a positive one.
  const listed = { ...legacy, plugins: [{ name: "desk", version: "1.0.0" }] }
  assert.deepEqual(sessionRoute(listed, { siblings: () => [listed] }), { kind: "store", store: STORE })
}))

test("finding 4: a hold is counted, named and kept past 30 days; once its manifest reads and declares nothing it still waits, and only the desk's declaration releases it", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const { manifest } = await claudeHome(ctx, TRUNCATED)
  await runClaude(ctx, endPayload(ctx, marker))
  let [saved] = await listMarkers(ctx.env)
  assert.equal(saved.routing.store, null)
  // The sweep counts the hold with its reason and path; doctor and boot print them.
  await sweep(ctx.env, { quietMs: 0 })
  let status = factoryLocalStatus({ env: ctx.env, deskRoot: ctx.desk })
  assert.deepEqual(status.route_holds, { count: 1, reasons: [{ reason: "manifest_unparseable", path: manifest, remedy: HOLD_REMEDIES.manifest_unparseable, sessions: 1 }] })
  assert.match(factoryFindingLines(status).join("\n"), /1 ended session is held because the store they route to cannot be read/u)
  // A held marker outlives the usual 30 days.
  await writeMarker(ctx.env, { ...saved, updated_at: recent(-40 * DAY) })
  assert.equal((await listMarkers(ctx.env)).length, 1)
  // The overlay heals to declare nothing, and another session ends on this host: the held one is not inferred to the default.
  await fs.writeFile(manifest, JSON.stringify({ name: "corp", version: "1.0.0" }))
  assert.equal(holdReason(manifest, { code: "manifest_unparseable" }), "needs_declaration")
  await runClaude(ctx, { ...endPayload(ctx, marker), session_id: "00000000-0000-4000-8000-000000000002" })
  ;[saved] = (await listMarkers(ctx.env)).filter((m) => m.session_id === ID)
  assert.equal(saved.routing.store, null)
  assert.equal(markerRoute(saved).store, null)
  await sweep(ctx.env, { quietMs: 0 })
  assert.equal(await outboxHas(ctx.env, STORE), false)
  status = factoryLocalStatus({ env: ctx.env, deskRoot: ctx.desk })
  assert.equal(status.route_holds.reasons[0].reason, "needs_declaration")
  // The desk declares its store: that positive declaration releases the hold.
  await json(path.join(ctx.desk, "_meta", "factory.json"), { schema_version: 1, store: PRIVATE })
  assert.deepEqual(markerRoute(saved), { store: PRIVATE, source: "desk", warnings: [] })
}))

test("finding 4: a held marker pruned at 90 days is counted for the doctor", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  await claudeHome(ctx, TRUNCATED)
  await runClaude(ctx, endPayload(ctx, marker))
  const [saved] = await listMarkers(ctx.env)
  await writeMarker(ctx.env, { ...saved, updated_at: recent(-91 * DAY) })
  await listMarkers(ctx.env)
  const status = factoryLocalStatus({ env: ctx.env, deskRoot: ctx.desk })
  assert.equal(status.held_pruned.count, 1)
  assert.match(factoryFindingLines(status).join("\n"), /1 held session was pruned after 90 days without being captured/u)
}))

test("finding 5: the doctor names a linked manifest as linked, with its path and remedy", () => scratch(async (ctx) => {
  await claudeHome(ctx, HEALTHY)
  const corp = path.join(ctx.base, "installed", "corp")
  await fs.rename(path.join(corp, "plugin.json"), path.join(corp, "real.json"))
  await fs.symlink(path.join(corp, "real.json"), path.join(corp, "plugin.json"))
  const dirs = [path.join(ctx.base, "installed", "desk"), corp]
  const status = factoryLocalStatus({ env: ctx.env, deskRoot: ctx.desk, pluginDirs: dirs })
  assert.deepEqual(status.held_by, [{ reason: "manifest_symlinked", path: path.join(corp, "plugin.json"), remedy: HOLD_REMEDIES.manifest_symlinked }])
  assert.match(factoryFindingLines(status).join("\n"), /manifest_symlinked at .*plugin\.json: install the plugin without links/u)
  await fs.rm(path.join(corp, "plugin.json"))
  await fs.link(path.join(corp, "real.json"), path.join(corp, "plugin.json"))
  assert.equal(holdReason(path.join(corp, "plugin.json")), "manifest_hardlinked")
}))

test("holdReason reads each recorded path as it is now: missing, a link, too large, unparseable, or readable and awaiting the next scan", () => scratch(async (ctx) => {
  const dir = path.join(ctx.base, "reasons")
  await fs.mkdir(path.join(dir, "folder"), { recursive: true })
  assert.equal(holdReason(null), "plugin_scan_incomplete")
  assert.equal(holdReason(path.join(dir, "installed_plugins.json")), "registry_missing")
  assert.equal(holdReason(path.join(dir, "gone", "plugin.json")), "manifest_missing")
  assert.equal(holdReason(path.join(dir, "gone")), "plugin_missing")
  assert.equal(holdReason(path.join(dir, "folder")), "needs_declaration")
  // A plugin folder recorded as a link: to a file it does not read as a plugin, and to nothing it is missing.
  await fs.writeFile(path.join(dir, "file.txt"), "x")
  await fs.symlink(path.join(dir, "file.txt"), path.join(dir, "to-file"))
  assert.equal(holdReason(path.join(dir, "to-file")), "plugin_unreadable")
  await fs.symlink(path.join(dir, "nowhere"), path.join(dir, "dangling"))
  assert.equal(holdReason(path.join(dir, "dangling")), "plugin_missing")
  // A registry that is a file but cannot be parsed keeps the recorded code's meaning.
  await fs.writeFile(path.join(dir, "installed_plugins.json"), "{ broken")
  assert.equal(holdReason(path.join(dir, "installed_plugins.json")), "manifest_unreadable")
  assert.equal(holdReason(path.join(dir, "installed_plugins.json"), { code: "manifest_unparseable" }), "manifest_unparseable")
  await fs.mkdir(path.join(dir, "big"))
  await fs.writeFile(path.join(dir, "big", "plugin.json"), " ".repeat(64 * 1024 + 1))
  assert.equal(holdReason(path.join(dir, "big", "plugin.json")), "manifest_too_large")
  for (const reason of ["plugin_scan_incomplete", "registry_missing", "manifest_missing", "plugin_missing", "needs_declaration", "plugin_unreadable", "manifest_too_large"]) assert.equal(typeof HOLD_REMEDIES[reason], "string")
}))

test("routeHolds counts held sessions by reason, the most common first, and names a hold with no warning as an incomplete scan", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const held = (n, warnings) => ({ ...marker, session_id: `0000000${n}-0000-4000-8000-000000000000`, routing: { store: null, source: "invalid_declaration", warnings } })
  const broken = [{ code: "manifest_unparseable", manifest: path.join(ctx.base, "missing", "plugin.json") }]
  const holds = routeHolds([held(1, []), held(2, broken), held(3, broken), { ...marker, desk_root: null }, marker])
  assert.deepEqual(holds, { count: 3, reasons: [{ code: "manifest_unparseable", path: broken[0].manifest, sessions: 2 }, { code: "plugin_scan_incomplete", path: null, sessions: 1 }] })
  // The doctor's lines for several holds and several pruned sessions.
  const lines = factoryFindingLines({ store: STORE, source: "default", consent: "yes", stores: [], warnings: [], route_holds: { count: 2, reasons: [{ reason: "plugin_scan_incomplete", path: null, remedy: HOLD_REMEDIES.plugin_scan_incomplete, sessions: 2 }] }, held_pruned: { count: 2, last_at: "2026-10-01T00:00:00.000Z" } }).join("\n")
  assert.match(lines, /2 ended sessions are held because/u)
  assert.match(lines, /plugin_scan_incomplete: start sessions from an installed Desk .* \(2 sessions\)/u)
  assert.match(lines, /2 held sessions were pruned after 90 days without being captured, the last on 2026-10-01\./u)
}))

test("held markers pruned at 90 days add up, even when the count cannot be written", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const held = { ...marker, ended_at: recent(), routing: { store: null, source: "invalid_declaration", warnings: [] } }
  const old = recent(-91 * DAY)
  await writeMarker(ctx.env, { ...held, updated_at: old })
  await listMarkers(ctx.env)
  await writeMarker(ctx.env, { ...held, session_id: "00000000-0000-4000-8000-000000000002", updated_at: old })
  await listMarkers(ctx.env)
  assert.equal(factoryLocalStatus({ env: ctx.env, deskRoot: ctx.desk }).held_pruned.count, 2)
  // A status file that cannot be written never stops the listing.
  const status = path.join(await factoryStateRoot(ctx.env), "status.json")
  await fs.rm(status)
  await fs.mkdir(status)
  await writeMarker(ctx.env, { ...held, session_id: "00000000-0000-4000-8000-000000000003", updated_at: old })
  assert.deepEqual(await listMarkers(ctx.env), [])
}))

test("a derive from an older hook's marker with no recorded route checks no route: once its marker is gone, its copy is frozen", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const { routing, ...marker } = await session(ctx)
  assert.equal(routing.store, STORE)
  await writeMarker(ctx.env, { ...marker, end_reason: "complete", ended_at: recent(-3600000), updated_at: recent(-3600000) })
  assert.equal((await sweep(ctx.env, { quietMs: 0 })).written, 1)
  const receipts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(ctx.env), "status.json"), "utf8")).derivations
  const [receipt] = Object.values(receipts)
  assert.equal(receipt.store, STORE)
  assert.equal(Object.hasOwn(receipt, "checked_route"), false)
}))

// ---------------------------------------------------------------------------
// Fix round 2: a hold never settles to the default store from another session's scan (re-review N2), and a Desk updated while a session
// ran is still listed (N3).
// ---------------------------------------------------------------------------

const OTHER_ID = "00000000-0000-4000-8000-000000000002"
const publicOutboxNames = async (env) => {
  try {
    return await fs.readdir(path.join(await factoryStateRoot(env), "outbox", STORE.replace("/", "__")))
  } catch {
    return []
  }
}

test("N2 repro S1: a session that loaded a private overlay through claude --plugin-dir stays held after a normal session ends, and nothing reaches the public store", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = await session(ctx)
  // The registry lists only the installed Desk; session A ran a development Desk and the corp overlay, both passed with --plugin-dir.
  const installed = path.join(ctx.base, "installed", "desk")
  await json(path.join(installed, "plugin.json"), { name: "desk", version: "1.0.0" })
  await registry(ctx, { "desk@ourostack": [{ version: "1.0.0", installPath: installed }] })
  await json(path.join(ctx.base, "dev", "corp", "plugin.json"), JSON.parse(HEALTHY))
  await runClaude(ctx, endPayload(ctx, marker), path.join(ctx.base, "dev", "desk"))
  const held = (await listMarkers(ctx.env)).find((m) => m.session_id === ID)
  assert.deepEqual(held.routing, { store: null, source: "invalid_declaration", warnings: [] })
  // Session B ends normally from the installed Desk, with a complete scan.
  await runClaude(ctx, { ...endPayload(ctx, marker), session_id: OTHER_ID }, installed)
  const after = (await listMarkers(ctx.env)).find((m) => m.session_id === ID)
  assert.deepEqual(after.routing, held.routing, "another session's scan never routes this one")
  assert.deepEqual(sessionRoute(after, { siblings: () => [after] }), { kind: "unknown" })
  assert.deepEqual(await deriveMarker(ctx.env, after, { quietMs: 0, requireStored: true }), { result: "held", store: null })
  await sweep(ctx.env, { quietMs: 0 })
  assert.equal((await publicOutboxNames(ctx.env)).includes(`claude-code-${ID}.json`), false)
}))

test("N2 repro S2: a hold on a broken manifest, then the manifest fixed and the private overlay uninstalled, stays held after a normal session ends", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = await session(ctx)
  const desk = path.join(ctx.base, "installed", "desk")
  const broken = path.join(ctx.base, "installed", "broken")
  const corp = path.join(ctx.base, "installed", "corp")
  await json(path.join(desk, "plugin.json"), { name: "desk", version: "1.0.0" })
  await fs.mkdir(broken, { recursive: true })
  await fs.writeFile(path.join(broken, "plugin.json"), TRUNCATED)
  await json(path.join(corp, "plugin.json"), JSON.parse(HEALTHY))
  await registry(ctx, { "desk@ourostack": [{ version: "1.0.0", installPath: desk }], "broken@x": [{ version: "1.0.0", installPath: broken }], "corp@corp": [{ version: "1.0.0", installPath: corp }] })
  await runClaude(ctx, endPayload(ctx, marker))
  const held = (await listMarkers(ctx.env)).find((m) => m.session_id === ID)
  assert.equal(held.routing.store, null)
  // The broken plugin is fixed to declare nothing, and the corp overlay is uninstalled.
  await json(path.join(broken, "plugin.json"), { name: "broken", version: "1.0.0" })
  await fs.rm(corp, { recursive: true })
  await registry(ctx, { "desk@ourostack": [{ version: "1.0.0", installPath: desk }], "broken@x": [{ version: "1.0.0", installPath: broken }] })
  await runClaude(ctx, { ...endPayload(ctx, marker), session_id: OTHER_ID })
  const after = (await listMarkers(ctx.env)).find((m) => m.session_id === ID)
  assert.equal(after.routing.store, null)
  assert.equal(markerRoute(after).store, null)
  await sweep(ctx.env, { quietMs: 0 })
  assert.equal((await publicOutboxNames(ctx.env)).includes(`claude-code-${ID}.json`), false)
}))

test("N2: a held marker never vouches for the same desk's Codex default route, before or after another session ends", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const installed = path.join(ctx.base, "installed", "desk")
  await json(path.join(installed, "plugin.json"), { name: "desk", version: "1.0.0" })
  await registry(ctx, { "desk@ourostack": [{ version: "1.0.0", installPath: installed }] })
  await runClaude(ctx, endPayload(ctx, marker), path.join(ctx.base, "dev", "desk"))
  const codex = { schema_version: 1, host: "codex-cli", session_id: "01927a3b-8c00-7abc-8def-0123456789ab", log_path: "/x", cwd: ctx.desk, desk_root: ctx.desk, end_reason: "complete", ended_at: recent(), plugins: [], updated_at: recent(), routing: { store: STORE, source: "default", warnings: [] } }
  let markers = await listMarkers(ctx.env)
  assert.equal(proofIndex(markers).length, 0)
  assert.notDeepEqual(sessionRoute(codex, { siblings: () => markers }), { kind: "store", store: STORE })
  // A normal session ends on this host: the held marker is not settled by it, so it is still no proof (only that session's own marker is).
  await runClaude(ctx, { ...endPayload(ctx, marker), session_id: OTHER_ID }, installed)
  markers = await listMarkers(ctx.env)
  const held = markers.find((m) => m.session_id === ID)
  assert.equal(held.routing.store, null)
  assert.equal(proofIndex([held]).length, 0)
  assert.equal(provenBy(codex, proofIndex([held])), false)
}))

test("N3: a Desk updated while the session ran is listed through its sibling version in the same cache folder, so the session is not held", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const cache = path.join(ctx.base, ".claude", "plugins", "cache", "ourostack", "desk")
  const [old, current] = [path.join(cache, "1.0.0"), path.join(cache, "1.1.0")]
  for (const [dir, version] of [[old, "1.0.0"], [current, "1.1.0"]]) await json(path.join(dir, "plugin.json"), { name: "desk", version })
  await registry(ctx, { "desk@ourostack": [{ version: "1.1.0", installPath: current }] })
  await runClaude(ctx, endPayload(ctx, marker), old)
  assert.deepEqual((await listMarkers(ctx.env))[0].routing, { store: STORE, source: "default", warnings: [] })
  // A Desk outside that cache folder is still not listed.
  const scan = metadata({ host: "claude", pluginRoot: path.join(ctx.base, "dev", "desk"), home: ctx.base, env: ctx.env, readSmallText, PATTERNS })
  assert.equal(scan.reason, "desk_not_in_registry")
}))
