// desk_status and desk_doctor report the factory: the bound desk's store and
// how it was chosen, consent per store, undelivered and quarantined counts,
// and the last flush's result code. The plugin set is read the way the
// session's host installed it. Every desk, plugin and store is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"

import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"
import { doctorRuntime } from "../../../../../plugins/desk/mcp/src/tools/doctor.js"
import { setConsent, writeLocalFacts, writeMarker, writeStatus, readMachineSecret } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { STORE, json, scratch } from "../factory/_session_helpers.js"
import { factoryStateDir } from "../../../../../plugins/desk/mcp/src/factory/boot-check.js"

const contextUrl = new URL("../../../../../plugins/desk/mcp/src/tools/factory-context.js", import.meta.url)
async function load() {
  assert.ok(existsSync(contextUrl), "the tools' factory context must exist")
  return import(contextUrl)
}

const OTHER = "example-org/team-factory"

/** A host plugin folder: Desk plus an overlay that declares OTHER, as siblings (Copilot) and in Claude's registry. */
async function plugins(base, env, { declare = true } = {}) {
  const root = path.join(base, "installed")
  const desk = path.join(root, "desk")
  const overlay = path.join(root, "overlay")
  await json(path.join(desk, "plugin.json"), { name: "desk", version: "3.2.0" })
  await json(path.join(overlay, "plugin.json"), { name: "overlay", version: "1.0.0", ...(declare ? { desk: { factory: { store: OTHER } } } : {}) })
  const claudeConfig = path.join(base, "claude-config")
  await json(path.join(claudeConfig, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: { "desk@market": [{ version: "3.2.0", installPath: desk }], "overlay@market": [{ version: "1.0.0", installPath: overlay }] },
  })
  const hostEnv = { ...env, DESK_PLUGIN_ROOT: desk, CLAUDE_CONFIG_DIR: claudeConfig }
  delete hostEnv.CLAUDE_PLUGIN_ROOT
  return { desk, overlay, env: hostEnv, claudeEnv: { ...hostEnv, CLAUDE_PLUGIN_ROOT: desk } }
}

test("the plugin scan follows the host: Copilot reads Desk's siblings, Claude reads its plugin registry", () => scratch(async ({ base, env }) => {
  const { factoryPluginScan } = await load()
  const host = await plugins(base, env)
  const copilot = factoryPluginScan(host.env)
  assert.equal(copilot.incomplete, false)
  assert.deepEqual([...copilot.dirs].sort(), [host.desk, host.overlay].sort())
  const claude = factoryPluginScan(host.claudeEnv)
  assert.equal(claude.incomplete, false)
  assert.deepEqual(claude.dirs, [host.desk, host.overlay])
  await fs.writeFile(path.join(host.claudeEnv.CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json"), "{ broken")
  assert.equal(factoryPluginScan(host.claudeEnv).incomplete, true, "an unreadable registry is an incomplete scan")
  assert.deepEqual(factoryPluginScan({ ...host.env, DESK_PLUGIN_ROOT: path.join(base, "missing", "desk") }), { dirs: [], incomplete: true })
  const homeless = { ...host.claudeEnv, HOME: "" }
  assert.equal(factoryPluginScan(homeless).incomplete, true, "an empty HOME falls back to the OS home and the scan still answers")
}))

// Live proof finding: the MCP server runs from a source mirror in the cache, where `hooks/` is not beside its code, so the
// scan must load the end hook from the plugin root the launcher names in DESK_PLUGIN_ROOT, falling back to its own checkout.
test("the plugin scan loads the end hook from the launcher's plugin root, not from where the server's code runs", () => scratch(async ({ base, env }) => {
  const { factoryPluginScan } = await load()
  const host = await plugins(base, env)
  await fs.mkdir(path.join(host.desk, "hooks"), { recursive: true })
  await fs.writeFile(path.join(host.desk, "hooks", "factory-end.cjs"), `module.exports = { metadata: ({ pluginRoot }) => ({ plugins: [], dirs: [pluginRoot + "#from-launcher-root"], incomplete: false }) }\n`)
  assert.deepEqual(factoryPluginScan(host.env), { dirs: [`${host.desk}#from-launcher-root`], incomplete: false })
  await fs.rm(path.join(host.desk, "hooks"), { recursive: true })
  assert.equal(factoryPluginScan(host.env).incomplete, false, "a plugin root without hooks falls back to this checkout's own end hook")
}))

test("desk_status reports the factory for the bound desk, routed by the overlay the host installed", () => scratch(async ({ base, desk, env }) => {
  const host = await plugins(base, env)
  await setConsent(host.env, { store: OTHER, contribute: true, account: "example-user" })
  await writeStatus(host.env, { last_flush: { [OTHER]: { at: "2026-09-27T12:00:00.000Z", result: "nothing_pending" } } })
  for (const hostEnv of [host.env, host.claudeEnv]) {
    const body = await desk_status({ deskRoot: desk, env: hostEnv })
    const { signoff, ...factory } = body.factory
    assert.equal(signoff.unsigned.value, 0, "the desk's sign-off counts ride along, without a task name")
    assert.deepEqual(factory, {
      store: OTHER,
      source: "overlay",
      consent: "yes",
      stores: [{ store: OTHER, consent: "yes", pending: 0, route_changed: 0, quarantined: 0, last_flush: "nothing_pending" }],
      warnings: [],
      loop: null,
    })
  }
}))

test("desk_status without an overlay reports the default store undecided, and creates no factory state", () => scratch(async ({ base, desk, env }) => {
  const host = await plugins(base, env, { declare: false })
  const body = await desk_status({ deskRoot: desk, env: host.env })
  assert.deepEqual({ store: body.factory.store, source: body.factory.source, consent: body.factory.consent }, { store: STORE, source: "default", consent: "undecided" })
  assert.equal(existsSync(env.XDG_STATE_HOME), false)
}))

test("desk_status with no usable root holds routing", () => scratch(async ({ base, env }) => {
  const host = await plugins(base, env, { declare: false })
  const body = await desk_status({ deskRoot: path.join(base, "missing-desk"), env: host.env, statusContext: { root: { root: path.join(base, "missing-desk"), source: "explicit-root", unavailable: true } } })
  assert.equal(body.factory.source, "no_desk")
  assert.equal(body.factory.consent, "held")
}))

test("desk_doctor reports the factory as data and as a summary section, and says who asks when undecided", () => scratch(async ({ base, desk, env }) => {
  const host = await plugins(base, env, { declare: false })
  let body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.equal(body.factory.consent, "undecided")
  assert.match(body.summary, /\n\nFactory\n  this desk reports to ourostack\/factory \(default\); contribution not decided yet \(raised once, after the operator's own work; never first or in a noninteractive session\)\n  ourostack\/factory: undecided, 0 pending, 0 quarantined, no flush yet/u)
  await setConsent(host.env, { store: STORE, contribute: true, account: "example-user" })
  await writeStatus(host.env, { last_flush: { [STORE]: { at: "2026-09-27T12:00:00.000Z", result: "auth_failed" } } })
  body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.match(body.summary, /\n\nFactory\n  this desk reports to ourostack\/factory \(default\); contribution: yes\n  ourostack\/factory: yes, 0 pending, 0 quarantined, last flush auth_failed/u)
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: "not a store" })
  body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.match(body.summary, /\n\nFactory\n  no store resolved \(invalid_declaration\); facts are held on this machine\n  ourostack\/factory: yes/u)
}))

test("desk_doctor names skipped plugin manifests by code only", () => scratch(async ({ base, desk, env }) => {
  const host = await plugins(base, env, { declare: false })
  await fs.writeFile(path.join(host.overlay, "plugin.json"), "{ broken")
  const body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.deepEqual(body.factory.warnings, ["manifest_unparseable"])
  assert.match(body.summary, /\n  plugin manifests skipped: manifest_unparseable\n(  sign-off:[^\n]*\n)?Loop\n  no loop record yet/u)
  assert.equal(body.summary.includes(base), false)
}))

test("desk_doctor's preview and no-desk paths carry no factory data", () => scratch(async ({ base, env }) => {
  const host = await plugins(base, env, { declare: false })
  const preview = doctorRuntime({ input: { format: "preview" }, deskRoot: "/private/desk", env: host.env })
  assert.equal(Object.hasOwn(preview, "factory"), false)
  const bare = doctorRuntime({ env: host.env })
  assert.equal(Object.hasOwn(bare, "factory"), false)
}))

test("desk_status and desk_doctor never print a path, secret, account, token or content from factory state", () => scratch(async ({ base, desk, env }) => {
  const host = await plugins(base, env)
  await setConsent(host.env, { store: OTHER, contribute: true, account: "private-login" })
  const secret = await readMachineSecret(host.env)
  await writeStatus(host.env, { last_flush: { [OTHER]: { at: "2026-09-27T12:00:00.000Z", result: "delivered_pr_open", token: "ghp_SENTINEL" } } })
  const facts = JSON.parse(await fs.readFile(new URL("../factory/fixtures/local-golden.json", import.meta.url), "utf8"))
  assert.equal((await writeLocalFacts(host.env, OTHER, facts)).written, true)
  const factory = JSON.stringify({ status: (await desk_status({ deskRoot: desk, env: host.env })).factory, doctor: doctorRuntime({ deskRoot: desk, env: host.env }).factory })
  const summary = doctorRuntime({ deskRoot: desk, env: host.env }).summary.split("\n\nFactory\n", 2)[1]
  for (const text of [factory, summary]) {
    for (const forbidden of [base, "private-login", "ghp_SENTINEL", secret.toString("hex"), facts.session.id, "2026-09-27", "manifest"]) {
      assert.equal(text.includes(forbidden), false, `must not carry ${forbidden}`)
    }
  }
}))

test("the doctor's summary names files routed elsewhere only when there are some", async () => {
  const { factorySummary } = await import("../../../../../plugins/desk/mcp/src/tools/factory-context.js")
  const status = (routeChanged) => ({ store: STORE, source: "desk", consent: "yes", stores: [{ store: STORE, consent: "yes", pending: 1, route_changed: routeChanged, quarantined: 0, last_flush: null }], warnings: [] })
  assert.match(factorySummary(status(2)), /ourostack\/factory: yes, 1 pending, 2 routed elsewhere, 0 quarantined, no flush yet/u)
  assert.match(factorySummary(status(0)), /ourostack\/factory: yes, 1 pending, 0 quarantined, no flush yet/u)
})

test("desk_doctor reports a failed, interrupted or stalled orphan pass by its code, and says nothing for a healthy one", () => scratch(async ({ base, desk, env }) => {
  const host = await plugins(base, env, { declare: false })
  const orphans = (patch) => writeStatus(host.env, { orphans: { started_at: new Date().toISOString(), ran_at: new Date().toISOString(), cursor: null, last_wrap_at: null, sweeps_in_walk: 0, examined: 5, unexamined: 0, ...patch } })
  await orphans({})
  let body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.equal(body.factory.orphans, undefined)
  assert.equal(body.summary.includes("orphan pass"), false)
  await orphans({ failed: "pass_failed" })
  body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.equal(body.factory.orphans, "pass_failed")
  assert.match(body.summary, /\n  orphan pass needs attention: pass_failed\. Run `node mcp\/scripts\/factory\.js status` from the Desk plugin folder and read its orphan_pass line; if the pass keeps failing or stalling, file a Desk problem\./u)
  await orphans({ sweeps_in_walk: 9 })
  assert.equal(doctorRuntime({ deskRoot: desk, env: host.env }).factory.orphans, "walk_not_advancing")
  const { ownVersion } = await import("../../../../../plugins/desk/mcp/src/factory/local-status.js")
  await orphans({ hung: { "claude-code-a.json": { strikes: 2, version: "0.0.1" } } })
  assert.equal(doctorRuntime({ deskRoot: desk, env: host.env }).factory.orphans, undefined, "strikes under another Desk version are no finding")
  await orphans({ hung: { "claude-code-a.json": { strikes: 2, version: ownVersion() } } })
  body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.equal(body.factory.orphans, "orphans_hung")
  assert.equal(body.factory.orphans_hung, 1, "reported by count")
  assert.match(body.summary, /orphan pass needs attention: orphans_hung \(1 orphans hung\)\./u)
  await orphans({ ran_at: "2020-01-01T00:00:00.000Z" })
  assert.equal(doctorRuntime({ deskRoot: desk, env: host.env }).factory.orphans, undefined, "no session ended lately: a machine that stopped contributing is not alarmed")
  await writeMarker(host.env, { schema_version: 1, host: "claude-code", session_id: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60", log_path: path.join(base, "log.jsonl"), cwd: desk, desk_root: desk, end_reason: "complete", ended_at: new Date().toISOString(), plugins: [], updated_at: new Date().toISOString() })
  assert.equal(doctorRuntime({ deskRoot: desk, env: host.env }).factory.orphans, undefined, "markers alone, without contribution switched on, do not alarm")
  await setConsent(host.env, { store: STORE, contribute: true, account: "example-user" })
  assert.equal(doctorRuntime({ deskRoot: desk, env: host.env }).factory.orphans, "pass_stale")
  await writeStatus(host.env, { orphans: { started_at: "2026-01-01T00:00:00.000Z", cursor: null, last_wrap_at: null, sweeps_in_walk: 0 } })
  assert.equal(doctorRuntime({ deskRoot: desk, env: host.env }).factory.orphans, "pass_interrupted")
}))

test("desk_doctor reports sessions held back unasked for over seven days, with the command to run", () => scratch(async ({ base, desk, env }) => {
  const host = await plugins(base, env, { declare: false })
  await setConsent(host.env, { store: STORE, contribute: true, account: "example-user" })
  const since = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  await writeStatus(host.env, { last_flush: { [STORE]: { at: since(0), result: "nothing_pending", visibility_unasked: 2, visibility_unasked_since: since(3) } } })
  assert.equal(doctorRuntime({ deskRoot: desk, env: host.env }).factory.visibility_unasked, undefined)
  await writeStatus(host.env, { last_flush: { [STORE]: { at: since(0), result: "nothing_pending", visibility_unasked: 2, visibility_unasked_since: since(8) } } })
  const body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.deepEqual(body.factory.visibility_unasked, [{ store: STORE, sessions: 2 }])
  assert.match(body.summary, new RegExp(`${STORE}: 2 sessions wait because their desk's visibility could not be asked for over 7 days\\. Run .node mcp/scripts/factory\\.js flush --store ${STORE}. from the Desk plugin folder`, "u"))
}))

test("desk_doctor's store line says how many sessions wait for a visibility answer from the first deferral, and an unreadable start time is a deferral of unknown age", () => scratch(async ({ base, desk, env }) => {
  const host = await plugins(base, env, { declare: false })
  await setConsent(host.env, { store: STORE, contribute: true, account: "example-user" })
  const at = new Date().toISOString()
  await writeStatus(host.env, { last_flush: { [STORE]: { at, result: "nothing_pending", visibility_unasked: 2, visibility_unasked_since: at } } })
  let body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.equal(body.factory.stores[0].waiting_for_visibility, 2)
  assert.match(body.summary, new RegExp(`${STORE}: yes, \\d+ pending, 2 waiting for a visibility answer, 0 quarantined, last flush nothing_pending`, "u"))
  assert.equal(body.factory.visibility_unasked, undefined, "the 7-day finding waits for 7 days")
  await writeStatus(host.env, { last_flush: { [STORE]: { at, result: "nothing_pending", visibility_unasked: 2, visibility_unasked_since: "garbage" } } })
  body = doctorRuntime({ deskRoot: desk, env: host.env })
  assert.deepEqual(body.factory.visibility_unasked, [{ store: STORE, sessions: 2, age: "unknown" }])
  assert.match(body.summary, /2 sessions wait because their desk's visibility could not be asked for an unknown time\. Run/u)
  await writeStatus(host.env, { last_flush: { [STORE]: { at, result: "nothing_pending" } } })
  assert.equal(doctorRuntime({ deskRoot: desk, env: host.env }).factory.stores[0].waiting_for_visibility, undefined)
}))

test("the factory summary says how many delivered tasks await sign-off", async () => {
  const { factorySummary } = await import("../../../../../plugins/desk/mcp/src/tools/factory-context.js")
  const base = { store: STORE, source: "desk", consent: "yes", stores: [], warnings: [] }
  const m = (value) => ({ state: "measured", value })
  const line = (signoff) => factorySummary({ ...base, signoff }).split("\n").find((entry) => entry.includes("sign-off"))
  assert.equal(line({ unsigned: m(3), oldest_unsigned_age_days: m(9), not_recorded: m(2) }), "  sign-off: 3 delivered tasks await sign-off, oldest 9 days; 2 delivered before sign-off was recorded")
  assert.equal(line({ unsigned: m(1), oldest_unsigned_age_days: m(1), not_recorded: m(0) }), "  sign-off: 1 delivered task awaits sign-off, oldest 1 day")
  assert.equal(line({ unsigned: m(0), oldest_unsigned_age_days: { state: "unavailable", reason: "none_unsigned" }, not_recorded: m(4) }), "  sign-off: no delivered tasks await sign-off; 4 delivered before sign-off was recorded")
  const partial = (value) => ({ state: "partial", value, reason: "archive_cap" })
  assert.equal(line({ unsigned: partial(500), oldest_unsigned_age_days: partial(30), not_recorded: partial(1) }), "  sign-off: at least 500 delivered tasks await sign-off, oldest at least 30 days; at least 1 delivered before sign-off was recorded")
  assert.equal(line({ unsigned: m(2), oldest_unsigned_age_days: { state: "unavailable", reason: "age_unknown" }, not_recorded: m(0) }), "  sign-off: 2 delivered tasks await sign-off, oldest age unknown")
  const failed = { state: "unavailable", reason: "scan_failed" }
  assert.equal(line({ unsigned: failed, oldest_unsigned_age_days: failed, not_recorded: failed }), "  sign-off: not checked (scan_failed)")
  assert.equal(line(undefined), undefined, "a status with no sign-off figures prints no sign-off line")
})

test("desk_status carries the sign-off counts for the bound desk and no task name", () => scratch(async ({ desk, env }) => {
  const { factoryStatus } = await load()
  await fs.mkdir(path.join(desk, "alpha", "PRIVATE-slug"), { recursive: true })
  await fs.writeFile(path.join(desk, "alpha", "PRIVATE-slug", "task.md"), "---\ntitle: PRIVATE-title\nstatus: done\nsignoff:\n  state: delivered_unsigned\n  at: null\n  verified: null\n  reason: null\nflow:\n  since: created\n  rev: 1\n  reached: done\n  delivered_at: '2026-10-01T00:00:00.000Z'\n  deliveries: 1\n---\n")
  const status = factoryStatus({ env, deskRoot: desk })
  assert.equal(status.signoff.unsigned.value, 1)
  assert.equal(JSON.stringify(status.signoff).includes("PRIVATE"), false)
  assert.equal(factoryStatus({ env, deskRoot: null }).signoff, undefined)
}))

const LOOP = {
  schema: "desk.factory.loop/1",
  written_at: "2026-10-05T12:00:00.000Z",
  desk_version: "3.2.0-alpha.9",
  improvement: {
    open: { state: "measured", value: 3, reasons: [] }, claimed: { state: "measured", value: 1, reasons: [] }, claim_expired: { state: "measured", value: 0, reasons: [] }, shipped: { state: "measured", value: 2, reasons: [] }, verifying: { state: "measured", value: 1, reasons: [] },
    oldest_open_age_days: { state: "measured", value: 8, reasons: [] }, oldest_in_verification_age_days: { state: "unavailable", value: null, reasons: ["none_in_verification"] },
  },
  alarms: { andon_open: { state: "measured", value: 1, reasons: [] }, store_build_failing: { state: "unavailable", value: null, reasons: ["stale"] }, desk_problems_open: { state: "measured", value: 0, reasons: [] }, loop_alarms_open: { state: "measured", value: 2, reasons: [] } },
  evaluator: { waiting: { state: "measured", value: 4, reasons: [] }, gave_up: { state: "measured", value: 1, reasons: [] }, headless: { state: "no_credentials" } },
  steps: { mirror: { stale: true }, verify: { stale: true }, route: { stale: false }, bogus: { stale: true } },
}

test("the doctor's summary has a Loop block from the stored record: counts, unavailable numbers named, and the stale steps", async () => {
  const { factorySummary } = await import("../../../../../plugins/desk/mcp/src/tools/factory-context.js")
  const status = { store: STORE, source: "desk", consent: "yes", stores: [], warnings: [], loop: LOOP }
  const text = factorySummary(status)
  const block = text.slice(text.indexOf("Loop"))
  assert.match(block, /^Loop\n/u)
  assert.match(block, /3 open, 1 claimed, 0 claim expired, 2 shipped, 1 verifying/u)
  assert.match(block, /oldest open 8 days; oldest in verification unavailable \(none in verification\)/u)
  assert.match(block, /andon 1, store build failing unavailable \(stale\), desk problems 0, loop alarm cards 2/u)
  assert.match(block, /headless evaluator no_credentials, 4 waiting, 1 gave up/u)
  assert.match(block, /stale steps: mirror, verify/u)
  assert.doesNotMatch(block, /bogus/u)
  assert.match(block, /record written 2026-10-05T12:00:00.000Z by Desk 3.2.0-alpha.9/u)
  const quiet = factorySummary({ ...status, loop: { ...LOOP, steps: {}, evaluator: { headless: {} }, improvement: {}, alarms: {} } })
  assert.match(quiet, /stale steps: none/u)
  assert.match(quiet, /headless evaluator unavailable, unavailable waiting, unavailable gave up/u)
  assert.match(quiet, /unavailable open, unavailable claimed/u)
  const old = factorySummary({ ...status, loop: LOOP }, { now: Date.parse("2026-10-08T12:00:01.000Z") })
  assert.match(old, /record written 2026-10-05T12:00:00.000Z by Desk 3.2.0-alpha.9 \(older than 72 hours: this machine is quiet\)/u)
  const edge = factorySummary({ ...status, loop: LOOP }, { now: Date.parse("2026-10-08T12:00:00.000Z") })
  assert.doesNotMatch(edge, /quiet/u)
  const sparse = factorySummary({ ...status, loop: { schema: "desk.factory.loop/1" } })
  assert.match(sparse, /stale steps: none/u)
})

test("the doctor's summary says there is no loop record and never prints zeros for it", async () => {
  const { factorySummary } = await import("../../../../../plugins/desk/mcp/src/tools/factory-context.js")
  for (const loop of [null, undefined]) {
    const text = factorySummary({ store: STORE, source: "desk", consent: "yes", stores: [], warnings: [], loop })
    assert.match(text, /Loop\n  no loop record yet/u)
    assert.doesNotMatch(text.slice(text.indexOf("Loop")), /\b0\b/u)
  }
})

test("with the loop switched off, the factory status and the doctor's summary say disabled over an old completed record", () => scratch(async ({ base, desk, env }) => {
  const { factoryStatus, factorySummary } = await load()
  const host = await plugins(base, env)
  const completed = { ...LOOP, worker: { last_result: "completed", last_ran_at: "2026-10-05T11:00:00.000Z" } }
  await writeStatus(host.env, { loop: { health: completed } })
  assert.deepEqual(factoryStatus({ env: host.env, deskRoot: desk }).loop.worker, { last_result: "completed", last_ran_at: "2026-10-05T11:00:00.000Z" })
  const off = { ...host.env, DESK_FACTORY_LOOP: "off" }
  const status = factoryStatus({ env: off, deskRoot: desk })
  assert.deepEqual(status.loop.worker, { last_result: "disabled", last_ran_at: "2026-10-05T11:00:00.000Z" })
  assert.deepEqual({ ...status.loop, worker: undefined }, { ...completed, worker: undefined }, "nothing else changes")
  assert.match(factorySummary(status), /\n  loop worker: last result disabled \(switched off on this machine\)/u)
  assert.match(factorySummary(factoryStatus({ env: host.env, deskRoot: desk })), /\n  loop worker: last result completed$/u)
  assert.match(factorySummary({ ...status, loop: { ...status.loop, worker: { last_result: "Bad Code/x" } } }), /loop worker: last result unavailable/u)
  await fs.writeFile(path.join(factoryStateDir(host.env), "status.json"), "{ broken")
  assert.equal(factoryStatus({ env: off, deskRoot: desk }).loop, null, "no record stays no record")
}))

test("the factory status carries the stored loop record, and null when the record is absent or not a loop record", () => scratch(async ({ base, desk, env }) => {
  const { factoryStatus } = await load()
  const host = await plugins(base, env)
  assert.equal(factoryStatus({ env: host.env, deskRoot: desk }).loop, null)
  await writeStatus(host.env, { loop: { health: LOOP } })
  assert.deepEqual(factoryStatus({ env: host.env, deskRoot: desk }).loop, LOOP)
  await writeStatus(host.env, { loop: { health: { schema: "other" } } })
  assert.equal(factoryStatus({ env: host.env, deskRoot: desk }).loop, null)
  await writeStatus(host.env, { loop: "damaged" })
  assert.equal(factoryStatus({ env: host.env, deskRoot: desk }).loop, null)
  await fs.writeFile(path.join(factoryStateDir(host.env), "status.json"), "{ broken")
  assert.equal(factoryStatus({ env: host.env, deskRoot: desk }).loop, null)
}))
