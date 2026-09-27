// desk_status and desk_doctor report the factory: the bound desk's store and
// how it was chosen, consent per store, undelivered and quarantined counts,
// and the last flush's result code. The plugin set is read the way the
// session's host installed it. Every desk, plugin and store is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"

import { desk_status } from "../../src/tools/status.js"
import { doctorRuntime } from "../../src/tools/doctor.js"
import { setConsent, writeLocalFacts, writeStatus, readMachineSecret } from "../../src/factory/outbox.js"
import { STORE, json, scratch } from "../factory/_session_helpers.js"

const contextUrl = new URL("../../src/tools/factory-context.js", import.meta.url)
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

test("desk_status reports the factory for the bound desk, routed by the overlay the host installed", () => scratch(async ({ base, desk, env }) => {
  const host = await plugins(base, env)
  await setConsent(host.env, { store: OTHER, contribute: true, account: "example-user" })
  await writeStatus(host.env, { last_flush: { [OTHER]: { at: "2026-09-27T12:00:00.000Z", result: "nothing_pending" } } })
  for (const hostEnv of [host.env, host.claudeEnv]) {
    const body = await desk_status({ deskRoot: desk, env: hostEnv })
    assert.deepEqual(body.factory, {
      store: OTHER,
      source: "overlay",
      consent: "yes",
      stores: [{ store: OTHER, consent: "yes", pending: 0, quarantined: 0, last_flush: "nothing_pending" }],
      warnings: [],
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
  assert.match(body.summary, /\n\nFactory\n  this desk reports to ourostack\/factory \(default\); contribution not decided yet: ask the operator once \(desk:session-start\)\n  ourostack\/factory: undecided, 0 pending, 0 quarantined, no flush yet/u)
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
  assert.match(body.summary, /\n  plugin manifests skipped: manifest_unparseable$/u)
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
