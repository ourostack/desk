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
import { deriveMarker, sweep } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { HOLD_REMEDIES, holdReason, routeHolds, settleHeldMarkers } from "../../../../../plugins/desk/mcp/src/factory/held-route.js"
import { factoryLocalStatus } from "../../../../../plugins/desk/mcp/src/factory/local-status.js"
import { readSmallText } from "../../../../../plugins/desk/mcp/src/factory/marker.js"
import { PATTERNS } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { resolveStore } from "../../../../../plugins/desk/mcp/src/factory/store-route.js"
import { factoryFindingLines } from "../../../../../plugins/desk/mcp/src/tools/factory-context.js"
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
// The hook runs from Desk's registered install folder, as an installed Desk does (`claudeHome`).
const runClaude = (ctx, payload, pluginRoot = path.join(ctx.base, "installed", "desk")) => hook().runHook({ host: "claude", payload, env: ctx.env, pluginRoot, launch: async () => {} })
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

test("finding 2: an overlay the registry lists whose folder is missing holds the route, and settles when the folder returns", () => scratch(async (ctx) => {
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
  const run = () => hook().runHook({ host: "copilot", payload: { sessionId: ID, cwd: ctx.desk, reason: "complete" }, env: ctx.env, pluginRoot, launch: async () => {} })
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
  const scan = hook().metadata({ host: "claude", pluginRoot: path.join(ctx.base, "dev", "desk"), home: ctx.base, env: ctx.env, readSmallText, PATTERNS })
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

test("finding 4: a hold whose cause cleared is settled by the next complete scan on that host, and a hold is counted, named and kept past 30 days until then", () => scratch(async (ctx) => {
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
  // The overlay heals to declare nothing: the hold stays, waiting for a scan, and says so.
  await fs.writeFile(manifest, JSON.stringify({ name: "corp", version: "1.0.0" }))
  assert.equal(holdReason(manifest, { code: "manifest_unparseable" }), "awaiting_settle")
  // Another session ends on this host with a complete scan: the held one is routed as a session there would be now, the default.
  const other = { ...endPayload(ctx, marker), session_id: "00000000-0000-4000-8000-000000000002" }
  await runClaude(ctx, other)
  ;[saved] = (await listMarkers(ctx.env)).filter((m) => m.session_id === ID)
  assert.deepEqual(saved.routing, { store: STORE, source: "default", warnings: [] })
  assert.ok(Date.parse(saved.updated_at) > Date.now() - DAY, "settled now, so it has its 30 days to be derived")
  await sweep(ctx.env, { quietMs: 0 })
  status = factoryLocalStatus({ env: ctx.env, deskRoot: ctx.desk })
  assert.equal(status.route_holds, undefined)
}))

test("finding 4: a hold whose warned manifest is still unreadable is never settled, and a held marker pruned at 90 days is counted for the doctor", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  await claudeHome(ctx, TRUNCATED)
  await runClaude(ctx, endPayload(ctx, marker))
  const [saved] = await listMarkers(ctx.env)
  assert.deepEqual(await settleHeldMarkers(ctx.env, { host: "claude", dirs: [] }), [])
  // A scan that read no plugin list settles only on a declaration, never the default.
  const noList = { ...saved, session_id: "00000000-0000-4000-8000-000000000003", plugins: [], routing: { store: null, source: "invalid_declaration", warnings: [] } }
  await writeMarker(ctx.env, noList)
  assert.deepEqual(await settleHeldMarkers(ctx.env, { host: "claude", dirs: [] }), [])
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
  assert.equal(holdReason(path.join(dir, "folder")), "awaiting_settle")
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
  for (const reason of ["plugin_scan_incomplete", "registry_missing", "manifest_missing", "plugin_missing", "awaiting_settle", "plugin_unreadable", "manifest_too_large"]) assert.equal(typeof HOLD_REMEDIES[reason], "string")
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

test("settling stops at its deadline, and held markers pruned at 90 days add up even when the count cannot be written", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const held = { ...marker, ended_at: recent(), routing: { store: null, source: "invalid_declaration", warnings: [] } }
  await writeMarker(ctx.env, held)
  assert.deepEqual(await settleHeldMarkers(ctx.env, { host: "claude", dirs: [], deadline: 0 }), [])
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
