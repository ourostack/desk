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

import { factoryStateRoot, markDelivered, quarantine, readMachineSecret, setConsent, writeLocalFacts, writeMarker, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { factoryBootCheck } from "../../../../../plugins/desk/mcp/src/factory/boot-check.js"
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
    stores: [{ store: STORE, consent: "undecided", pending: 0, route_changed: 0, quarantined: 0, last_flush: null }],
    warnings: [],
  })
  assert.equal(existsSync(env.XDG_STATE_HOME), false, "status never creates factory state")
}))

for (const answer of ["yes", "no"]) {
  test(`a recorded ${answer} through factory.js consent is reported and the start never asks again`, () => scratch(async ({ desk, env }) => {
    const { factoryLocalStatus } = await load()
    assert.deepEqual(factoryBootCheck({ env, deskRoot: desk }), { jobs: [] })
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
  assert.deepEqual(status.stores, [{ store: STORE, consent: "yes", pending: 2, route_changed: 0, quarantined: 1, last_flush: "delivered_pr_open" }])
}))

test("an outbox file whose session now routes to another store is route_changed, never pending, read as the flush reads routes", () => scratch(async ({ base, desk, env }) => {
  const { factoryLocalStatus } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  const away = path.join(base, "away-desk")
  await json(path.join(away, "_meta", "factory.json"), { schema_version: 1, store: OTHER })
  const plain = path.join(base, "plain-desk")
  await fs.mkdir(plain)
  const marker = (n, deskRoot, host = "claude-code") => writeMarker(env, { schema_version: 1, host, session_id: sessionId(n), log_path: path.join(base, `log-${n}.jsonl`), cwd: base, desk_root: deskRoot, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString() })
  // 1 and 2: routed to the other store, one delivered and one not. 3: routed here. 4: no marker, so its derive-time route (this store).
  // 5: a malformed marker says nothing new. 6: a Codex default route nothing proves keeps its derive-time route too.
  const names = []
  for (const n of [1, 2, 3, 4, 5]) names.push(await outboxFile(env, STORE, n))
  await marker(1, away)
  await marker(2, away)
  await marker(3, desk)
  await fs.writeFile(path.join(await factoryStateRoot(env), "markers", names[4]), "{ not json", { mode: 0o600 })
  const codex = structuredClone(GOLDEN)
  codex.session.id = sessionId(6)
  codex.session.host = "codex-cli"
  assert.equal((await writeLocalFacts(env, STORE, codex)).written, true)
  await marker(6, plain, "codex-cli")
  await markDelivered(env, STORE, { name: names[0], publishedBlobSha: "a".repeat(40) })
  const status = factoryLocalStatus({ env, deskRoot: desk })
  assert.deepEqual(status.stores, [{ store: STORE, consent: "yes", pending: 4, route_changed: 2, quarantined: 0, last_flush: null }])
}))

test("tombstoned, stale and stalled copies count as route_changed, never pending; an unknown route still waits as pending", () => scratch(async ({ base, env }) => {
  const { factoryLocalStatus } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  const root = await factoryStateRoot(env)
  const moved = path.join(base, "moved-desk")
  await json(path.join(moved, "_meta", "factory.json"), { schema_version: 1, store: OTHER })
  const broken = path.join(base, "broken-desk")
  await fs.mkdir(path.join(broken, "_meta"), { recursive: true })
  await fs.writeFile(path.join(broken, "_meta", "factory.json"), "{ not json")
  // 1: a finished retraction (tombstone), marker pruned. 2: a stale copy, its receipt naming the other store. 3: a retraction still open with
  // no positive route. 4: marker pruned, its receipt's desk root now declares the other store. 5: an unresolvable marker and nothing known.
  const names = []
  for (const n of [1, 2, 3, 4, 5]) names.push(await outboxFile(env, STORE, n))
  const blob = "b".repeat(40)
  const retracting = path.join(root, "retracting", `${STORE.replace("/", "__")}.json`)
  await json(retracting, { [names[0]]: { path: `facts/${names[0]}`, blob, done: true }, [names[2]]: { path: `facts/${names[2]}`, blob }, junk: 7 })
  await writeStatus(env, { derivations: { [names[1]]: { store: OTHER }, [names[3]]: { store: STORE, desk_root: moved } } })
  await writeMarker(env, { schema_version: 1, host: "claude-code", session_id: sessionId(5), log_path: path.join(base, "log-5.jsonl"), cwd: base, desk_root: broken, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString() })
  assert.deepEqual(factoryLocalStatus({ env, deskRoot: base }).stores[0], { store: STORE, consent: "yes", pending: 1, route_changed: 4, quarantined: 0, last_flush: null })
  // An unreadable retracting file reads as none: the tombstoned and stalled copies count as pending again.
  await fs.writeFile(retracting, "{ not json")
  assert.deepEqual(factoryLocalStatus({ env, deskRoot: base }).stores[0], { store: STORE, consent: "yes", pending: 3, route_changed: 2, quarantined: 0, last_flush: null })
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
    { store: OTHER, consent: "yes", pending: 1, route_changed: 0, quarantined: 0, last_flush: "offline" },
    { store: STORE, consent: "no", pending: 0, route_changed: 0, quarantined: 0, last_flush: null },
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
  assert.deepEqual(status.stores, [{ store: STORE, consent: "unreadable", pending: 0, route_changed: 0, quarantined: 0, last_flush: null }])
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
  assert.deepEqual(status.stores, [{ store: STORE, consent: "yes", pending: 1, route_changed: 0, quarantined: 0, last_flush: null }], "an unreadable delivered record counts the file as pending")
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
    assert.equal(boot.line, undefined, `${entry.name}: the boot check never adds a consent line, whatever desk_status says`)
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

test("an invalid declaration freezes the session: it counts as pending, never route_changed, whether its marker is present or pruned", () => scratch(async ({ base, env }) => {
  const { factoryLocalStatus } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  const broken = path.join(base, "broken-desk")
  await fs.mkdir(path.join(broken, "_meta"), { recursive: true })
  await fs.writeFile(path.join(broken, "_meta", "factory.json"), "{ not json")
  // Both sessions last routed to the other store, so a readable route would make them stale here. 1 has a marker in the broken desk;
  // 2's marker is pruned and its receipt names the broken desk.
  const one = await outboxFile(env, STORE, 1)
  const two = await outboxFile(env, STORE, 2)
  await writeStatus(env, { derivations: { [one]: { store: STORE, route: OTHER }, [two]: { store: STORE, route: OTHER, desk_root: broken } } })
  await writeMarker(env, { schema_version: 1, host: "claude-code", session_id: sessionId(1), log_path: path.join(base, "log-1.jsonl"), cwd: base, desk_root: broken, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString() })
  assert.deepEqual(factoryLocalStatus({ env, deskRoot: base }).stores[0], { store: STORE, consent: "yes", pending: 2, route_changed: 0, quarantined: 0, last_flush: null })
}))

test("the orphan pass reads as one line, and a failed, interrupted or stalled pass is a finding", async () => {
  const { orphanPassFinding, orphanPassLine, orphansHung, ownVersion, ORPHAN_INTERRUPTED_MS, ORPHAN_FINDING_ADVICE } = await load()
  const now = Date.parse("2026-10-06T12:00:00.000Z")
  const ran = { started_at: "2026-10-06T11:59:00.000Z", ran_at: "2026-10-06T11:59:10.000Z", examined: 25, unexamined: 75, pending: 2, frozen: { no_facts: 3, derive_failed: 1 }, rebuilt: 1, current: 20, cursor: "claude-code-x.json", last_wrap_at: "2026-10-05T00:00:00.000Z", sweeps_in_walk: 4 }
  assert.equal(orphanPassLine(ran, now), "orphan pass: ran 2026-10-06T11:59:10.000Z, examined 25, unexamined 75, pending 2, frozen 4, last full walk 2026-10-05T00:00:00.000Z, 4 sweeps into the walk")
  assert.equal(orphanPassFinding(ran, now), null, "ceil(100 / 25) = 4 sweeps is the most a walk takes")
  assert.equal(orphanPassFinding({ ...ran, sweeps_in_walk: 5 }, now), "walk_not_advancing")
  assert.equal(orphanPassFinding({ ...ran, examined: 0, unexamined: 3, sweeps_in_walk: 4 }, now), "walk_not_advancing", "nothing examined: three sweeps at most")
  assert.equal(orphanPassFinding({ ...ran, examined: 0, unexamined: 0, sweeps_in_walk: 0 }, now), null)
  assert.equal(orphanPassFinding({ ...ran, examined: "x" }, now), null, "a count that is not a count says nothing")
  // Orphans frozen by cheap checks take no slot: only the ones that did work set how long a walk takes.
  assert.equal(orphanPassFinding({ ...ran, examined: 425, worked: 25, unexamined: 75, sweeps_in_walk: 4 }, now), null, "ceil(100 / 25) = 4 sweeps, however many were frozen cheaply")
  assert.equal(orphanPassFinding({ ...ran, examined: 425, worked: 25, unexamined: 75, sweeps_in_walk: 5 }, now), "walk_not_advancing")
  const active = { active: true }
  assert.equal(orphanPassFinding({ ...ran, ran_at: "2026-10-04T11:59:59.000Z" }, now, active), "pass_stale", "not run for more than two days, on a machine that ended a session lately")
  assert.equal(orphanPassFinding({ ...ran, ran_at: "2026-10-04T11:59:59.000Z" }, now), null, "a machine that stopped contributing is not alarmed")
  assert.equal(orphanPassFinding({ ...ran, ran_at: "2026-10-04T12:00:01.000Z" }, now, active), null)
  assert.equal(orphanPassFinding({ ...ran, ran_at: "not a time" }, now, active), null, "an unreadable end time is not a stale one")
  const hung = { ...ran, hung: { "claude-code-a.json": { strikes: 2, version: "1.0.0" }, "claude-code-b.json": { strikes: 1, version: "1.0.0" }, "claude-code-d.json": { strikes: 3, version: "0.9.0" }, c: "x" } }
  const v1 = { version: "1.0.0" }
  assert.equal(orphanPassFinding(hung, now, v1), "orphans_hung")
  assert.equal(orphanPassFinding(hung, now, { version: "2.0.0" }), null, "strikes of another Desk version do not count")
  assert.equal(orphansHung(hung, "1.0.0"), 1, "one strike is not hung, and another version's strikes are not this one's")
  assert.equal(orphansHung(hung, null), 0)
  assert.equal(orphansHung({ ...ran, hung: "x" }, "1.0.0"), 0)
  assert.equal(orphansHung(undefined, "1.0.0"), 0)
  assert.match(orphanPassLine(hung, now, v1), /frozen 4 \(1 hung\), last full walk/u)
  assert.equal(typeof ownVersion(), "string")
  assert.equal(ownVersion(() => { throw new Error("gone") }), null)
  assert.equal(ownVersion(() => "{}"), null)
  assert.match(ORPHAN_FINDING_ADVICE, /`node mcp\/scripts\/factory\.js status`/u)
  const failed = { started_at: ran.started_at, ran_at: ran.ran_at, cursor: null, last_wrap_at: null, sweeps_in_walk: 0, failed: "pass_failed" }
  assert.equal(orphanPassFinding(failed, now), "pass_failed")
  assert.equal(orphanPassLine(failed, now), "orphan pass: failed (pass_failed), last full walk never")
  assert.equal(orphanPassLine({ ...failed, failed: "/private/path message" }, now), "orphan pass: failed (unknown), last full walk never", "a failure is a fixed class, never a message")
  const started = { started_at: "2026-10-06T11:58:00.000Z", cursor: null, last_wrap_at: null, sweeps_in_walk: 0 }
  assert.equal(orphanPassFinding(started, now), null, "a pass that began a moment ago is still running")
  assert.equal(orphanPassLine(started, now), "orphan pass: running, started 2026-10-06T11:58:00.000Z, last full walk never")
  const old = { ...started, started_at: new Date(now - ORPHAN_INTERRUPTED_MS - 1).toISOString() }
  assert.equal(orphanPassFinding(old, now), "pass_interrupted")
  assert.equal(orphanPassLine(old, now).startsWith("orphan pass: interrupted, started "), true)
  assert.equal(orphanPassLine({ ...old, started_at: 5 }, now).includes("started unknown"), true)
  assert.equal(orphanPassFinding({ ...started, started_at: "garbage" }, now), "pass_interrupted", "a start time that does not parse is never running")
  assert.equal(orphanPassFinding({ cursor: null }, now), "pass_interrupted")
  assert.equal(orphanPassFinding(undefined, now), null)
  assert.equal(orphanPassLine(undefined, now), "orphan pass: no record yet")
  assert.match(orphanPassLine({ ...ran, frozen: { a: "x", b: 2 } }, now), /frozen 2, /u, "a count that is not a count adds nothing")
  assert.equal(orphanPassLine({ ran_at: ran.ran_at, frozen: 7, examined: -1 }, now), "orphan pass: ran 2026-10-06T11:59:10.000Z, examined unknown, unexamined unknown, pending unknown, frozen 0, last full walk never, unknown sweeps into the walk")
})

test("sessions held back for want of a visibility answer are a finding only after seven days", async () => {
  const { visibilityUnasked, UNASKED_REPORT_MS, UNASKED_ADVICE } = await load()
  const now = Date.parse("2026-10-20T00:00:00.000Z")
  const since = (ms) => new Date(now - ms).toISOString()
  const flush = { "a/old": { visibility_unasked: 3, visibility_unasked_since: since(UNASKED_REPORT_MS + 1) }, "a/new": { visibility_unasked: 2, visibility_unasked_since: since(UNASKED_REPORT_MS - 1) }, "a/none": { result: "x" }, "a/zero": { visibility_unasked: 0, visibility_unasked_since: since(UNASKED_REPORT_MS + 1) } }
  assert.deepEqual(visibilityUnasked(flush, ["a/old", "a/new", "a/none", "a/zero", "a/absent"], now), [{ store: "a/old", sessions: 3 }])
  assert.deepEqual(visibilityUnasked({ "a/bad": { visibility_unasked: 4, visibility_unasked_since: "garbage" }, "a/missing": { visibility_unasked: 1 } }, ["a/bad", "a/missing"], now), [{ store: "a/bad", sessions: 4, age: "unknown" }, { store: "a/missing", sessions: 1, age: "unknown" }], "an unreadable or missing start is a deferral of unknown age")
  assert.deepEqual(visibilityUnasked(undefined, ["a/old"], now), [])
  assert.match(UNASKED_ADVICE("a/old"), /`node mcp\/scripts\/factory\.js flush --store a\/old`/u)
})
