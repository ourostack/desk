// The factory's local status for desk_status, desk_doctor and the task
// tools: which store the bound desk reports to, its consent decision, the
// counts of undelivered and quarantined files, and the last flush's result
// code. Read-only, bounded, and free of paths, secrets, accounts and
// content. Every desk and store here is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { factoryStateRoot, markDelivered, quarantine, readMachineSecret, setConsent, writeLocalFacts, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { factoryBootCheck, FACTORY_NO_CONSENT_LINE } from "../../../../../plugins/desk/mcp/src/factory/boot-check.js"
import { jobLink } from "../../../../../plugins/desk/mcp/src/factory/pipeline/build.js"
import { main as factoryCli } from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { STORE, json, scratch } from "./_session_helpers.js"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/factory/local-status.js", import.meta.url)
async function load() {
  assert.ok(existsSync(moduleUrl), "the factory local status module must exist")
  return import(moduleUrl)
}

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const OTHER = "example-org/team-factory"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

async function outboxFile(env, store, n) {
  const facts = structuredClone(GOLDEN)
  facts.session.id = sessionId(n)
  const written = await writeLocalFacts(env, store, facts)
  assert.equal(written.written, true)
  return written.name
}

async function cli(env, ...argv) {
  let out = ""
  const code = await factoryCli({ argv, env, write: (text) => { out += text }, logError: () => {} })
  assert.equal(code, 0)
  return JSON.parse(out)
}

test("with no factory state the bound desk reports to the default store, undecided, and nothing is created", () => scratch(async ({ desk, env }) => {
  const { factoryLocalStatus } = await load()
  const status = factoryLocalStatus({ env, deskRoot: desk })
  assert.deepEqual(status, {
    store: STORE,
    source: "default",
    consent: "undecided",
    stores: [{ store: STORE, consent: "undecided", pending: 0, quarantined: 0, last_flush: null }],
    warnings: [],
  })
  assert.equal(existsSync(env.XDG_STATE_HOME), false, "status never creates factory state")
}))

for (const answer of ["yes", "no"]) {
  test(`a recorded ${answer} through factory.js consent is reported and the start never asks again`, () => scratch(async ({ desk, env }) => {
    const { factoryLocalStatus } = await load()
    assert.deepEqual(factoryBootCheck({ env, deskRoot: desk }), { line: FACTORY_NO_CONSENT_LINE })
    const recorded = await cli(env, "consent", "--store", STORE, "--contribute", answer, ...(answer === "yes" ? ["--account", "example-user"] : []))
    assert.equal(recorded.contribute, answer === "yes")
    const status = factoryLocalStatus({ env, deskRoot: desk })
    assert.equal(status.consent, answer)
    assert.equal(status.stores[0].consent, answer)
    assert.equal(factoryBootCheck({ env, deskRoot: desk }).line, undefined, "a recorded decision is never asked again")
  }))
}

test("counts are per store: undelivered outbox files, quarantined files and the last flush code", () => scratch(async ({ desk, env }) => {
  const { factoryLocalStatus } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  const [delivered, rejected] = [await outboxFile(env, STORE, 1), await outboxFile(env, STORE, 2)]
  await outboxFile(env, STORE, 3)
  await outboxFile(env, STORE, 4)
  await markDelivered(env, STORE, { name: delivered, publishedBlobSha: "a".repeat(40) })
  await quarantine(env, STORE, rejected, "timestamp_in_field")
  await writeStatus(env, { last_flush: { [STORE]: { at: "2026-09-27T12:00:00.000Z", result: "delivered_pr_open" } } })
  const status = factoryLocalStatus({ env, deskRoot: desk })
  assert.deepEqual(status.stores, [{ store: STORE, consent: "yes", pending: 2, quarantined: 1, last_flush: "delivered_pr_open" }])
}))

test("the desk's declaration picks the store, and every other decided store is listed after it", () => scratch(async ({ desk, env }) => {
  const { factoryLocalStatus } = await load()
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: OTHER })
  await setConsent(env, { store: STORE, contribute: false })
  await setConsent(env, { store: OTHER, contribute: true, account: "example-user" })
  await outboxFile(env, OTHER, 5)
  await writeStatus(env, { last_flush: { [OTHER]: { at: "2026-09-27T12:00:00.000Z", result: "offline" } } })
  const status = factoryLocalStatus({ env, deskRoot: desk })
  assert.equal(status.store, OTHER)
  assert.equal(status.source, "desk")
  assert.equal(status.consent, "yes")
  assert.deepEqual(status.stores, [
    { store: OTHER, consent: "yes", pending: 1, quarantined: 0, last_flush: "offline" },
    { store: STORE, consent: "no", pending: 0, quarantined: 0, last_flush: null },
  ])
}))

test("an overlay declaration beside Desk routes the desk, with manifest warnings as codes only", () => scratch(async ({ base, desk, env }) => {
  const { factoryLocalStatus } = await load()
  const broken = path.join(base, "plugins", "broken")
  const overlay = path.join(base, "plugins", "overlay")
  await fs.mkdir(broken, { recursive: true })
  await fs.writeFile(path.join(broken, "plugin.json"), "{ not json")
  await json(path.join(overlay, "plugin.json"), { name: "overlay", desk: { factory: { store: OTHER } } })
  const status = factoryLocalStatus({ env, deskRoot: desk, pluginDirs: [broken, overlay] })
  assert.equal(status.store, OTHER)
  assert.equal(status.source, "overlay")
  assert.deepEqual(status.warnings, ["manifest_unparseable"])
  assert.doesNotMatch(JSON.stringify(status), new RegExp(base.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"))
}))

test("an invalid declaration or an incomplete plugin scan holds routing and names no store", () => scratch(async ({ desk, env }) => {
  const { factoryLocalStatus } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  assert.deepEqual(
    (({ store, source, consent }) => ({ store, source, consent }))(factoryLocalStatus({ env, deskRoot: desk, pluginScanIncomplete: true })),
    { store: null, source: "plugin_scan_incomplete", consent: "held" },
  )
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 2, store: STORE })
  const status = factoryLocalStatus({ env, deskRoot: desk })
  assert.deepEqual({ store: status.store, source: status.source, consent: status.consent }, { store: null, source: "invalid_declaration", consent: "held" })
  assert.deepEqual(status.stores.map((entry) => entry.store), [STORE], "decided stores are still listed")
}))

test("no bound desk, and unreadable consent, are reported as codes", () => scratch(async ({ desk, env }) => {
  const { factoryLocalStatus } = await load()
  assert.deepEqual(
    (({ store, source, consent }) => ({ store, source, consent }))(factoryLocalStatus({ env, deskRoot: null })),
    { store: null, source: "no_desk", consent: "held" },
  )
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "consent.json"), "{ corrupt", { mode: 0o600 })
  const status = factoryLocalStatus({ env, deskRoot: desk })
  assert.equal(status.consent, "unreadable")
  assert.deepEqual(status.stores, [{ store: STORE, consent: "unreadable", pending: 0, quarantined: 0, last_flush: null }])
}))

test("status carries no machine secret, account, intake ID, token, path or content", () => scratch(async ({ base, desk, env }) => {
  const { factoryLocalStatus } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "private-login" })
  const secret = await readMachineSecret(env)
  const name = await outboxFile(env, STORE, 6)
  await quarantine(env, STORE, name, "invalid")
  await writeStatus(env, { last_flush: { [STORE]: { at: "2026-09-27T12:00:00.000Z", result: "auth_failed", note: "ghp_SENTINEL" } } })
  const consent = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(env), "consent.json"), "utf8"))
  const text = JSON.stringify(factoryLocalStatus({ env, deskRoot: desk }))
  for (const forbidden of [base, desk, "private-login", consent.stores[STORE].intake_id, "ghp_SENTINEL", secret.toString("hex"), secret.toString("base64"), GOLDEN.session.id, "2026-09-27"]) {
    assert.equal(text.includes(forbidden), false, `status must not carry ${forbidden}`)
  }
}))

test("the report link is written only when the resolved store has consent, and matches factory.js job-link", () => scratch(async ({ desk, env }) => {
  const { factoryReportLink } = await load()
  const task = { env, deskRoot: desk, deskRemote: "https://github.com/example-user/example-desk.git", personPrefix: "desks/alice", track: "track", slug: "finished-work" }
  assert.equal(factoryReportLink(task), null, "undecided: no link")
  await setConsent(env, { store: STORE, contribute: false })
  assert.equal(factoryReportLink(task), null, "declined: no link")
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  const link = factoryReportLink(task)
  assert.equal(link, jobLink({ store: STORE, deskRemote: task.deskRemote, personPrefix: "desks/alice", track: "track", slug: "finished-work" }))
  const printed = await cli(env, "job-link", "--store", STORE, "--desk-remote", task.deskRemote, "--person-prefix", "desks/alice", "--track", "track", "--slug", "finished-work")
  assert.equal(link, printed.link)
  assert.match(link, /^https:\/\/github\.com\/ourostack\/factory\/blob\/reports\/jobs\/[0-9a-f]{32}\.md$/u)
  assert.equal(factoryReportLink({ ...task, pluginScanIncomplete: true }), null, "held routing: no link")
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: OTHER })
  assert.equal(factoryReportLink(task), null, "the desk's own store has no consent yet")
  await setConsent(env, { store: OTHER, contribute: true, account: "example-user" })
  assert.match(factoryReportLink(task), /^https:\/\/github\.com\/example-org\/team-factory\/blob\/reports\/jobs\//u)
}))

test("unsafe or malformed state files read as unreadable, never as a guess", () => scratch(async ({ base, desk, env }) => {
  const { factoryLocalStatus } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  await outboxFile(env, STORE, 7)
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "status.json"), "\"not an object\"", { mode: 0o600 })
  await fs.mkdir(path.join(root, "delivered"), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(base, "elsewhere.json"), "{}")
  await fs.symlink(path.join(base, "elsewhere.json"), path.join(root, "delivered", "ourostack__factory.json"))
  let status = factoryLocalStatus({ env, deskRoot: desk })
  assert.deepEqual(status.stores, [{ store: STORE, consent: "yes", pending: 1, quarantined: 0, last_flush: null }], "an unreadable delivered record counts the file as pending")
  for (const consent of ["[]", JSON.stringify({ schema_version: 1, stores: [] })]) {
    await fs.writeFile(path.join(root, "consent.json"), consent, { mode: 0o600 })
    status = factoryLocalStatus({ env, deskRoot: desk })
    assert.equal(status.consent, "unreadable")
  }
  await fs.writeFile(path.join(root, "consent.json"), JSON.stringify({ schema_version: 1, stores: { [STORE]: "yes", "not a store": { contribute: true } } }), { mode: 0o600 })
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({ last_flush: { [STORE]: { result: "Not A Code" } } }), { mode: 0o600 })
  status = factoryLocalStatus({ env, deskRoot: desk })
  assert.equal(status.consent, "undecided", "a record that is not a decision is no decision")
  assert.deepEqual(status.stores.map((entry) => [entry.store, entry.last_flush]), [[STORE, null]], "invalid store keys and result codes are dropped")
}))

// Review M3-11 D1: the startup hook's boot line and desk_status must agree. The line asks exactly when desk_status reports
// `undecided`; `held` (no store resolved), `unreadable`, `yes` and `no` mean there is nothing to ask.
test("the boot line asks exactly when desk_status reports undecided, in every routing and consent state", () => scratch(async ({ desk, env }) => {
  const { factoryLocalStatus } = await load()
  const { factoryStateDir } = await import("../../../../../plugins/desk/mcp/src/factory/boot-check.js")
  const consentFile = path.join(factoryStateDir(env), "consent.json")
  const writeConsent = async (text) => {
    await fs.mkdir(path.dirname(consentFile), { recursive: true, mode: 0o700 })
    await fs.writeFile(consentFile, text, { mode: 0o600 })
  }
  const declaration = path.join(desk, "_meta", "factory.json")
  const cases = [
    { name: "undecided default store", expect: "undecided" },
    { name: "incomplete plugin scan holds routing", scanIncomplete: true, expect: "held" },
    { name: "invalid desk declaration", declare: { schema_version: 1, store: "not a store" }, expect: "held" },
    { name: "desk declaration with an incomplete scan", declare: { schema_version: 1, store: OTHER }, scanIncomplete: true, expect: "undecided" },
    { name: "recorded yes", consent: JSON.stringify({ schema_version: 1, stores: { [STORE]: { contribute: true, account: "example-user" } } }), expect: "yes" },
    { name: "recorded no", consent: JSON.stringify({ schema_version: 1, stores: { [STORE]: { contribute: false } } }), expect: "no" },
    { name: "a record without a boolean decision", consent: JSON.stringify({ schema_version: 1, stores: { [STORE]: { contribute: "maybe" } } }), expect: "undecided" },
    { name: "unparseable consent file", consent: "{ broken", expect: "unreadable" },
    { name: "consent file whose stores is not an object", consent: JSON.stringify({ schema_version: 1, stores: "yes" }), expect: "unreadable" },
  ]
  for (const entry of cases) {
    await fs.rm(declaration, { force: true })
    await fs.rm(consentFile, { force: true })
    if (entry.declare) await json(declaration, entry.declare)
    if (entry.consent) await writeConsent(entry.consent)
    const status = factoryLocalStatus({ env, deskRoot: desk, pluginScanIncomplete: entry.scanIncomplete === true })
    const boot = factoryBootCheck({ env, deskRoot: desk, pluginScanIncomplete: entry.scanIncomplete === true })
    assert.equal(status.consent, entry.expect, `${entry.name}: desk_status consent`)
    assert.equal(boot.line === FACTORY_NO_CONSENT_LINE, status.consent === "undecided", `${entry.name}: the boot line asks only when desk_status says undecided`)
  }
}))

test("an unparseable status or delivery record reads as no last flush and nothing delivered", () => scratch(async ({ desk, env }) => {
  const { factoryLocalStatus } = await load()
  const { factoryStateDir } = await import("../../../../../plugins/desk/mcp/src/factory/boot-check.js")
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  const name = await outboxFile(env, STORE, 7)
  const dir = factoryStateDir(env)
  await fs.writeFile(path.join(dir, "status.json"), "{ broken")
  await fs.mkdir(path.join(dir, "delivered"), { recursive: true })
  await fs.writeFile(path.join(dir, "delivered", "ourostack__factory.json"), "[]")
  const entry = factoryLocalStatus({ env, deskRoot: desk }).stores[0]
  assert.equal(entry.last_flush, null)
  assert.equal(entry.pending, 1, `${name} counts as pending`)
}))
