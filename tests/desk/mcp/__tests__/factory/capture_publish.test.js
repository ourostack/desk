// The scoped capture record and its retraction. The privacy rule under test: the record for a store counts only
// that store's sessions and unowned ones; another store, withheld sessions and uncounted hosts change nothing.
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { CAPTURE_INVALID, EMPTY_RECORD, captureFor, isCaptureInvalid } from "../../../../../plugins/desk/mcp/src/factory/capture-publish.js"
import { CAPTURE_HOST_KEYS, CAPTURE_LOOP_KEY, CAPTURE_PATH, CAPTURE_TOP_KEYS, CAPTURE_SCHEMA, validateCaptureBytes } from "../../../../../plugins/desk/mcp/src/factory/capture-schema.js"
import { classifySessions } from "../../../../../plugins/desk/mcp/src/factory/capture-classify.js"
import { gitBlobSha } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

const SENTINEL = "SENTINEL-2031-01-02-/Users/someone/desk-secret-0a1b2c3d-1111-4222-8333-444455556666"
const ID = "0123456789abcdef"
const PUBLIC = "ourostack/factory"
const PRIVATE = "acme/private-store"
const zero = { derived: 0, held: 0, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: 0 }
const bucket = (over) => ({ ...zero, ...over })
const sumOf = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0)

// A counted host built from by_owner rows, so the host totals always partition on_disk.
function host(byOwner, { withDesk = true, unverified = false } = {}) {
  const keys = ["derived", "held", "frozen", "pending", "not_seen", "not_in_a_desk"]
  const rows = Object.values(byOwner)
  const total = Object.fromEntries(keys.map((key) => [key, sumOf(rows, key)]))
  if (!withDesk) total.not_in_a_desk = null
  return { state: "counted", on_disk: keys.reduce((sum, key) => sum + (total[key] ?? 0), 0), ...total, unverified, frozen_by_reason: {}, by_owner: byOwner }
}
const coverage = (hosts) => ({ method: 1, ran_at: "2031-01-02T03:04:05Z", hosts })
const records = (result) => JSON.parse(result.bytes)
const mine = { derived: 5, held: 1, frozen: 2, pending: 3, not_seen: 4 }
const ask = (cov, over = {}) => captureFor(cov, { store: PUBLIC, intakeId: ID, sentBefore: false, contributing: 1, ...over })

test("the record for a store counts only that store's and unowned sessions", () => {
  const cov = coverage({
    "claude-code": host({
      [PUBLIC]: bucket(mine),
      "-": bucket({ not_in_a_desk: 7, not_seen: 1 }),
      [PRIVATE]: bucket({ derived: 100, not_seen: 50 }),
      "?": bucket({ not_seen: 9 }),
    }),
  })
  const got = records(ask(cov))
  assert.deepEqual(got.hosts["claude-code"], { on_disk: 23, derived: 5, held: 1, frozen: 2, pending: 3, not_seen: 5, not_in_a_desk: 7, unverified: false })
  assert.equal(got.schema, CAPTURE_SCHEMA)
  assert.equal(got.basis, "still_on_disk")
  assert.equal(Object.hasOwn(got, CAPTURE_LOOP_KEY), false)
})

test("sessions owned by another store change nothing in this store's record", () => {
  const base = { [PUBLIC]: bucket(mine), "-": bucket({ not_in_a_desk: 2 }) }
  const without = ask(coverage({ "claude-code": host(base), "copilot-cli": host({ [PUBLIC]: bucket({ derived: 1 }) }, { withDesk: false }) }))
  // The other store's sessions, one carrying a SENTINEL store name, and a desk path nowhere in the input shape.
  const other = { ...base, [PRIVATE]: bucket({ derived: 40, held: 3, not_seen: 8 }), [`${SENTINEL}/x`]: bucket({ derived: 11, not_in_a_desk: 6 }) }
  const withOther = ask(coverage({ "claude-code": host(other), "copilot-cli": host({ [PUBLIC]: bucket({ derived: 1 }), [PRIVATE]: bucket({ derived: 9 }) }, { withDesk: false }) }))
  assert.equal(withOther.bytes, without.bytes)
  assert.equal(withOther.sha, without.sha)
  assert.equal(withOther.bytes.includes("SENTINEL"), false)
})

test("a machine with a public and a private desk gets two records that never share a count", () => {
  const cov = coverage({ "claude-code": host({ [PUBLIC]: bucket({ derived: 6 }), [PRIVATE]: bucket({ derived: 31, held: 2 }), "-": bucket({ not_in_a_desk: 4 }) }) })
  const pub = records(ask(cov)).hosts["claude-code"]
  const priv = records(ask(cov, { store: PRIVATE, intakeId: "fedcba9876543210" })).hosts["claude-code"]
  assert.equal(pub.on_disk, 10)
  assert.equal(priv.on_disk, 37)
  assert.equal(pub.derived, 6)
  assert.equal(priv.derived, 31)
  assert.equal(pub.held, 0)
  assert.equal(priv.held, 2)
  // Only the unowned bucket is shared, and it is the same in both.
  assert.equal(pub.not_in_a_desk, priv.not_in_a_desk)
})

test("leak hunt: nothing but this store's own sessions moves the public record", () => {
  const publicOnly = { [PUBLIC]: bucket(mine), "-": bucket({ not_in_a_desk: 3 }) }
  const baseline = ask(coverage({ "claude-code": host(publicOnly) })).bytes
  const cases = {
    "a private store's sessions": { ...publicOnly, [PRIVATE]: bucket({ derived: 20, not_seen: 5, held: 1 }) },
    "withheld sessions": { ...publicOnly, "?": bucket({ not_seen: 12, derived: 0 }) },
    "an owner spelled with different case, for another store": { ...publicOnly, "Acme/Private-Store": bucket({ derived: 8 }), [PRIVATE.toUpperCase()]: bucket({ held: 4 }) },
    "two contributing stores, where unowned sessions are withheld": { ...publicOnly, [PRIVATE]: bucket({ pending: 6 }), "?": bucket({ not_in_a_desk: 14 }) },
  }
  for (const [name, byOwner] of Object.entries(cases)) {
    assert.equal(ask(coverage({ "claude-code": host(byOwner) })).bytes, baseline, name)
  }
  // A desk with desk evidence and no store: its not_seen sessions are withheld ("?"), so nothing moves.
  const noStore = { ...publicOnly, "?": bucket({ not_seen: 30 }) }
  assert.equal(ask(coverage({ "claude-code": host(noStore) })).bytes, baseline, "a desk with desk evidence and no store")
  // The same spelling of the store in a different case is this store's sessions (the sweep lower-cases every store name).
  const cased = ask(coverage({ "claude-code": host({ "ourostack/factory": bucket(mine), "-": bucket({ not_in_a_desk: 3 }) }) }), { store: "OuroStack/Factory" })
  assert.equal(cased.bytes, baseline)
  // No leak through the other direction either: a store whose only sessions are another store's says nothing.
  assert.equal(ask(coverage({ "claude-code": host({ [PRIVATE]: bucket({ derived: 9 }) }) })), null)
  assert.equal(ask(coverage({ "claude-code": host({ "?": bucket({ not_seen: 9 }) }) })), null)
})

test("the record has the closed key set and no string but the enums", () => {
  const cov = coverage({
    "claude-code": host({ [PUBLIC]: bucket(mine) }),
    "copilot-cli": host({ "-": bucket({ derived: 2, not_seen: 3 }) }, { withDesk: false, unverified: true }),
    "codex-cli": host({ [PUBLIC]: bucket({ derived: 1 }) }, { withDesk: false }),
  })
  const got = records(ask(cov, { loop: { state: "ok", count: 3 } }))
  assert.deepEqual(Object.keys(got), ["schema", "basis", "hosts", "loop"])
  assert.deepEqual(Object.keys(got.hosts), ["claude-code", "copilot-cli", "codex-cli"])
  const strings = []
  const walk = (value, atKey) => {
    if (typeof value === "string") strings.push(value)
    else if (value !== null && typeof value === "object") for (const [key, entry] of Object.entries(value)) walk(entry, key)
    else if (!(typeof value === "number" || typeof value === "boolean" || value === null)) assert.fail(`unexpected value at ${atKey}`)
  }
  const { loop, ...rest } = got
  walk(rest)
  assert.deepEqual(strings.sort(), ["desk.factory.capture/1", "still_on_disk"])
  for (const entry of Object.values(got.hosts)) {
    assert.deepEqual(Object.keys(entry), ["on_disk", "derived", "held", "frozen", "pending", "not_seen", "not_in_a_desk", "unverified"])
  }
  assert.equal(got.hosts["copilot-cli"].not_in_a_desk, null)
  assert.equal(got.hosts["codex-cli"].not_in_a_desk, null)
  assert.equal(got.hosts["copilot-cli"].unverified, true)
  assert.equal(got.hosts["claude-code"].unverified, false)
  assert.equal(validateCaptureBytes(ask(cov).bytes).ok, true)
})

test("no session id, path, store name, date or SENTINEL appears in the bytes", () => {
  const cov = coverage({
    "claude-code": { ...host({ [PUBLIC]: bucket(mine), [`${SENTINEL}`]: bucket({ derived: 3 }), "-": bucket({ not_in_a_desk: 1 }) }), frozen_by_reason: { [SENTINEL]: 3 } },
  })
  cov.ran_at = SENTINEL
  const result = ask(cov, { loop: { note: "fine" } })
  for (const text of [result.bytes, result.path, JSON.stringify(result)]) {
    assert.equal(/SENTINEL|ourostack|acme|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(text.replace(`capture/${ID}.json`, "").replace(CAPTURE_SCHEMA, "")), false, text)
  }
})

test("the path is capture/<intake_id>.json and nothing else", () => {
  const cov = coverage({ "claude-code": host({ [PUBLIC]: bucket(mine) }) })
  const result = ask(cov)
  assert.equal(result.path, `capture/${ID}.json`)
  assert.equal(CAPTURE_PATH.test(result.path), true)
  assert.deepEqual(Object.keys(result), ["path", "bytes", "sha"])
  assert.equal(result.sha, gitBlobSha(result.bytes))
  for (const intakeId of ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "../etc/passwd", "", null, undefined, 12345]) {
    const bad = ask(cov, { intakeId })
    assert.deepEqual(bad, { invalid: CAPTURE_INVALID })
    assert.equal(isCaptureInvalid(bad), true)
  }
  for (const store of ["", null, undefined, 4, "?", "-", "nostore", "a/b/c", "a b/c"]) assert.deepEqual(ask(cov, { store }), { invalid: CAPTURE_INVALID })
  assert.deepEqual(captureFor(cov), { invalid: CAPTURE_INVALID })
  assert.equal(isCaptureInvalid(result), false)
  assert.equal(isCaptureInvalid(null), false)
})

test("an uncounted host is left out, not written as zero", () => {
  const cov = coverage({
    "claude-code": host({ [PUBLIC]: bucket(mine) }),
    "copilot-cli": { state: "absent", unverified: true },
    "codex-cli": { state: "absent", unverified: true },
  })
  const got = records(ask(cov))
  assert.deepEqual(Object.keys(got.hosts), ["claude-code"])
  // A counted host with nothing in this store's scope is left out too: all zeros cannot be told from uncounted.
  const scoped = records(ask(coverage({ "claude-code": host({ [PUBLIC]: bucket(mine) }), "codex-cli": host({ [PRIVATE]: bucket({ derived: 4 }) }, { withDesk: false }), "copilot-cli": host({ [PUBLIC]: bucket() }, { withDesk: false }) })))
  assert.deepEqual(Object.keys(scoped.hosts), ["claude-code"])
  for (const state of ["unreadable", "capped", "absent", "other"]) {
    assert.equal(ask(coverage({ "claude-code": { state, unverified: true } })), null)
  }
})

test("one host that could not be counted keeps the record already there, even beside a counted host", () => {
  for (const state of ["capped", "unreadable"]) {
    const cov = coverage({ "claude-code": host({ [PUBLIC]: bucket(mine) }), "codex-cli": { state, unverified: true } })
    assert.equal(ask(cov), null)
    assert.equal(ask(cov, { sentBefore: true }), null)
  }
  assert.notEqual(ask(coverage({ "claude-code": host({ [PUBLIC]: bucket(mine) }), "codex-cli": { state: "absent", unverified: true } }), { sentBefore: true }), null)
})

test("nothing counted and nothing sent before is null; nothing counted and sent before is the empty record", () => {
  for (const cov of [coverage({}), coverage({ "claude-code": { state: "absent", unverified: true } }), coverage({ "claude-code": host({ [PRIVATE]: bucket({ derived: 2 }) }) })]) {
    assert.equal(ask(cov), null)
    assert.equal(ask(cov, { sentBefore: undefined }), null)
    const retract = ask(cov, { sentBefore: true, loop: { state: "ok" } })
    assert.equal(retract.bytes, EMPTY_RECORD)
    assert.equal(retract.path, `capture/${ID}.json`)
    assert.equal(retract.sha, gitBlobSha(EMPTY_RECORD))
  }
  assert.equal(EMPTY_RECORD, `{"schema":"desk.factory.capture/1","basis":"still_on_disk","hosts":{}}\n`)
  assert.equal(validateCaptureBytes(EMPTY_RECORD).ok, true)
  assert.equal(EMPTY_RECORD.includes("loop"), false)
})

test("the same coverage twice gives identical bytes", () => {
  const make = (order) => coverage({ "claude-code": host(Object.fromEntries(order.map((key) => [key, bucket(mine)])), { unverified: false }) })
  const one = ask(make([PUBLIC, "-"]))
  const two = ask(make(["-", PUBLIC]))
  assert.equal(one.bytes, two.bytes)
  assert.equal(one.sha, two.sha)
  const looped = (loop) => ask(coverage({ "claude-code": host({ [PUBLIC]: bucket(mine) }) }), { loop })
  assert.equal(looped({ b: 1, a: 2 }).bytes, looped({ a: 2, b: 1 }).bytes)
  assert.equal(JSON.parse(looped({ b: 1, a: 2 }).bytes).loop.a, 2)
})

test("the loop slot is carried only when given and valid, and never invented", () => {
  const cov = coverage({ "claude-code": host({ [PUBLIC]: bucket(mine) }) })
  assert.equal(Object.hasOwn(records(ask(cov)), "loop"), false)
  assert.deepEqual(records(ask(cov, { loop: { state: "ok", runs: 2, live: true } })).loop, { live: true, runs: 2, state: "ok" })
  for (const loop of [null, undefined, "text", [], 5, { nested: { a: 1 } }, { state: SENTINEL }, { "Bad Key": 1 }, { n: -1 }, { n: 1.5 }]) {
    const got = ask(cov, { loop })
    assert.equal(Object.hasOwn(records(got), "loop"), false)
    assert.equal(got.bytes.includes("SENTINEL"), false)
  }
})

test("a bucket sum error in the input is refused, not repaired", () => {
  const good = host({ [PUBLIC]: bucket(mine) })
  const bad = [
    { ...good, on_disk: good.on_disk + 1 },
    { ...good, derived: good.derived + 1 },
    { ...good, held: -1 },
    // The owner rows over every owner must add up to the host's buckets: too many, too few, and in another owner's row.
    { ...good, by_owner: { [PUBLIC]: bucket({ ...mine, derived: 500 }) } },
    { ...good, by_owner: { [PUBLIC]: bucket({ ...mine, derived: 4 }) } },
    { ...good, by_owner: { [PUBLIC]: bucket(mine), [PRIVATE]: bucket({ held: 1 }) } },
    { ...good, unverified: "yes" },
    { ...good, unverified: undefined },
    { ...good, held: 1.5 },
    { ...good, on_disk: "15" },
    { ...good, by_owner: null },
    { ...good, by_owner: { [PUBLIC]: null } },
    { ...good, by_owner: { [PUBLIC]: { derived: 1 } } },
    { ...good, by_owner: { [PUBLIC]: { ...bucket(mine), derived: Number.NaN } } },
    // The host cannot tell not_in_a_desk, yet an owner row carries sessions in it.
    { ...host({ [PUBLIC]: bucket({ derived: 1 }) }, { withDesk: false }), by_owner: { [PUBLIC]: bucket({ derived: 1, not_in_a_desk: 2 }) } },
    // Over the schema's count limit.
    host({ [PUBLIC]: bucket({ derived: 1000001 }) }),
  ]
  // Under every host key, so the refusal is pinned for Codex too (where the value is not otherwise read).
  for (const entry of bad) for (const key of ["claude-code", "codex-cli"]) assert.deepEqual(ask(coverage({ [key]: entry })), { invalid: CAPTURE_INVALID })
  // An owner row for a null-desk host with a zero or null bucket is fine.
  const fine = host({ [PUBLIC]: { derived: 2, held: 0, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: null } }, { withDesk: false })
  assert.equal(records(ask(coverage({ "copilot-cli": fine }))).hosts["copilot-cli"].on_disk, 2)
})

test("an unknown host or a prototype name in the input is ignored, and coverage of the wrong shape says nothing", () => {
  const cov = coverage({ "claude-code": host({ [PUBLIC]: bucket(mine) }), "other-host": host({ [PUBLIC]: bucket(mine) }), constructor: 1 })
  assert.deepEqual(Object.keys(records(ask(cov)).hosts), ["claude-code"])
  assert.equal(ask({ hosts: [] }), null)
  assert.equal(ask({ hosts: "x" }), null)
  assert.equal(ask("coverage"), null)
  assert.equal(ask(coverage({ "claude-code": null })), null)
})

test("no coverage is not an emptied scope: null whatever sentBefore says", () => {
  for (const cov of [null, undefined, "coverage", 5, {}, { hosts: null }, { hosts: [] }, { hosts: "x" }]) {
    assert.equal(ask(cov, { sentBefore: true }), null)
    assert.equal(ask(cov), null)
  }
})

test("a capped or unreadable host never retracts; absent hosts do", () => {
  const empty = host({ [PRIVATE]: bucket({ derived: 2 }) })
  for (const state of ["capped", "unreadable"]) {
    assert.equal(ask(coverage({ "claude-code": empty, "copilot-cli": { state, unverified: true } }), { sentBefore: true }), null)
  }
  assert.equal(ask(coverage({ "claude-code": empty, "copilot-cli": null }), { sentBefore: true }), null)
  assert.equal(ask(coverage({ "claude-code": empty, "copilot-cli": { state: "absent", unverified: true } }), { sentBefore: true }).bytes, EMPTY_RECORD)
})

test("unowned sessions count only while at most one store contributes", () => {
  const cov = coverage({ "claude-code": host({ [PUBLIC]: bucket({ derived: 2 }), "-": bucket({ not_seen: 3 }) }) })
  assert.equal(records(ask(cov, { contributing: 1 })).hosts["claude-code"].on_disk, 5)
  assert.equal(records(ask(cov, { contributing: 2 })).hosts["claude-code"].on_disk, 2)
  assert.equal(records(ask(cov, { contributing: 7 })).hosts["claude-code"].not_seen, 0)
  // Stale coverage swept under one contributor stays out of a public record once a second store contributes.
  assert.equal(ask(coverage({ "copilot-cli": host({ "-": bucket({ not_seen: 3 }) }, { withDesk: false }) }), { contributing: 2 }), null)
  for (const contributing of [undefined, null, 0, -1, 1.5, "1", Number.NaN]) assert.deepEqual(ask(cov, { contributing }), { invalid: CAPTURE_INVALID })
  assert.deepEqual(captureFor(cov, { store: PUBLIC, intakeId: ID }), { invalid: CAPTURE_INVALID })
})

test("an empty loop slot is dropped", () => {
  const cov = coverage({ "claude-code": host({ [PUBLIC]: bucket(mine) }) })
  assert.equal(Object.hasOwn(records(ask(cov, { loop: {} })), "loop"), false)
  assert.equal(Object.hasOwn(records(ask(cov, { loop: Object.create({ inherited: 1 }) })), "loop"), false)
})

// Through the real classifier. `state` picks what exists for Codex: the public store's own derived session without a receipt,
// another store's derived session with a receipt, or a receipt that names only a route.
function classified({ privateReceipt = false, publicReceipt = null, pending = false, privateFirst = false } = {}) {
  const sessions = (names) => names.map((name) => ({ name, id: name.slice(-8), folder: null }))
  const pub = "codex-cli-aaaaaaaa.json"
  const priv = "codex-cli-bbbbbbbb.json"
  const receipts = {}
  if (privateReceipt) receipts[priv] = { route: PRIVATE, store: PRIVATE, desk_root: "/d/private", binding_version: 9 }
  if (publicReceipt !== null) receipts[pub] = publicReceipt
  // A pending public session: a marker routing it to the public store and no copy yet.
  const markers = pending ? { [pub]: { desk_root: "/d/public", route: { kind: "store", store: PUBLIC }, store: PUBLIC, unproven: false } } : {}
  return classifySessions({
    hosts: { "codex-cli": { state: "counted", sessions: sessions(privateReceipt ? [pub, priv] : [pub]) } },
    markers,
    receipts,
    copies: [...(pending ? [] : [{ name: pub, store: PUBLIC }]), ...(privateReceipt ? [{ name: priv, store: PRIVATE }] : [])],
    quarantined: [],
    consent: { [PUBLIC]: { contribute: true }, [PRIVATE]: { contribute: true } },
    places: () => "here",
    orphans: null,
    bindingVersion: 9,
    folderOf: (root) => root.replace(/[^A-Za-z0-9]/gu, "-"),
  })
}

test("leak hunt through the real classifier: no receipt of another store moves the public Codex flag", () => {
  const states = {
    "a copy without a receipt": classified(),
    "another store's derived session with a receipt": classified({ privateReceipt: true }),
    "a route-only receipt": classified({ publicReceipt: { route: PUBLIC } }),
  }
  // The machine-wide flag does differ between these states (the leak the record must not carry).
  assert.equal(states["a copy without a receipt"]["codex-cli"].unverified, true)
  assert.equal(states["another store's derived session with a receipt"]["codex-cli"].unverified, false)
  const bytes = Object.values(states).map((state) => ask(coverage(state), { contributing: 2 }).bytes)
  assert.equal(new Set(bytes).size, 1)
  const entry = JSON.parse(bytes[0]).hosts["codex-cli"]
  assert.equal(entry.derived, 1)
  assert.equal(entry.unverified, false)
  // The private store's record is its own.
  assert.equal(records(ask(coverage(states["another store's derived session with a receipt"]), { store: PRIVATE, intakeId: "fedcba9876543210", contributing: 2 })).hosts["codex-cli"].unverified, false)
})

test("leak hunt through the real classifier: with the public Codex session pending, the same three states give one record, unverified", () => {
  const states = [classified({ pending: true }), classified({ pending: true, privateReceipt: true }), classified({ pending: true, publicReceipt: { route: PUBLIC } })]
  assert.equal(states[0]["codex-cli"].unverified, true)
  assert.equal(states[1]["codex-cli"].unverified, false)
  const bytes = states.map((state) => ask(coverage(state), { contributing: 2 }).bytes)
  assert.equal(new Set(bytes).size, 1)
  const entry = JSON.parse(bytes[0]).hosts["codex-cli"]
  assert.equal(entry.pending, 1)
  assert.equal(entry.derived, 0)
  assert.equal(entry.unverified, true)
})

test("leak hunt through the real classifier: the orphan pass's pending count and a private orphan move nothing in the public record", () => {
  const sessions = (names) => names.map((name) => ({ name, id: name.slice(-8), folder: "-f" }))
  const pubNames = ["claude-code-aaaaaaa1.json", "claude-code-aaaaaaa2.json"]
  const privNames = ["claude-code-0000000a.json", "claude-code-0000000b.json"]
  const run = (withPrivate, orphans) => classifySessions({
    hosts: { "claude-code": { state: "counted", sessions: sessions(withPrivate ? [...privNames, ...pubNames] : pubNames) } },
    markers: {},
    receipts: {},
    copies: [...pubNames.map((name) => ({ name, store: PUBLIC })), ...(withPrivate ? privNames.map((name) => ({ name, store: PRIVATE })) : [])],
    quarantined: [],
    consent: { [PUBLIC]: { contribute: true }, [PRIVATE]: { contribute: true } },
    places: () => "here",
    orphans,
    bindingVersion: 9,
    folderOf: (root) => root,
  })
  const outputs = new Set()
  for (const withPrivate of [false, true]) {
    for (const pending of [0, 1, 2, 3, 40, undefined]) outputs.add(ask(coverage(run(withPrivate, { pending, frozen: {} })), { contributing: 2 }).bytes)
  }
  assert.equal(outputs.size, 1)
  const entry = JSON.parse([...outputs][0]).hosts["claude-code"]
  assert.deepEqual([entry.pending, entry.frozen], [0, 2])
})

test("the Codex entry is verified only with a derived session in scope, no undetermined session and no fallback", () => {
  const codex = (over, byOwner = { [PUBLIC]: bucket({ derived: 1 }) }) => records(ask(coverage({ "codex-cli": { ...host(byOwner, { withDesk: false, unverified: true }), ...over } }))).hosts["codex-cli"].unverified
  // The host's own flag is never read for Codex.
  assert.equal(codex({}), false)
  assert.equal(codex({}, { [PUBLIC]: bucket({ pending: 1 }) }), true)
  assert.equal(codex({ undetermined: 0 }), false)
  assert.equal(codex({ undetermined: 2 }), true)
  assert.equal(codex({ undetermined: "0" }), true)
  assert.equal(codex({ fallback: true }), true)
  assert.equal(codex({ fallback: false }), false)
  // Another host with a verified listing and no derived session is published as verified.
  for (const name of ["claude-code", "copilot-cli"]) {
    const entry = records(ask(coverage({ [name]: host({ [PUBLIC]: bucket({ pending: 2 }) }, { withDesk: name === "claude-code", unverified: false }) }))).hosts[name]
    assert.equal(entry.derived, 0)
    assert.equal(entry.unverified, false)
  }
})

test("the documented key list equals the schema's key list", () => {
  const doc = readFileSync(new URL("../../../../../plugins/desk/docs/factory-local-capture.md", import.meta.url), "utf8")
  const block = /```text capture-record-keys\n([\s\S]*?)```/u.exec(doc)
  assert.ok(block, "the doc holds a fenced block tagged `text capture-record-keys`")
  const lists = Object.fromEntries(block[1].trim().split("\n").map((line) => {
    const [name, rest] = line.split(":")
    return [name.trim(), rest.trim().split(/\s+/u)]
  }))
  assert.deepEqual(Object.keys(lists), ["top", "host"])
  assert.deepEqual(lists.top, [...CAPTURE_TOP_KEYS])
  assert.deepEqual(lists.host, [...CAPTURE_HOST_KEYS])
})
