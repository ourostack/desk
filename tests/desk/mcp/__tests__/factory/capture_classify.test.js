// The capture buckets: every root session on a host lands in exactly one, and its owner says whose record may count it.
// Every desk, store, folder and session id here is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"

import { BUCKETS, OWNER_NONE, OWNER_WITHHELD, ORPHAN_PASS_UNAVAILABLE, ORPHAN_UNSPLIT, assertPartition, classifySessions } from "../../../../../plugins/desk/mcp/src/factory/capture-classify.js"

const SENTINEL = "SENTINEL-do-not-leak"
const PUBLIC = "acme/public-store"
const PRIVATE = "acme/private-store"
const BINDING = 5
const folderOf = (root) => root.replace(/[^A-Za-z0-9]/gu, "-")
const DESK_A = "/desk/alpha"
const DESK_B = "/desk/beta"
const n = (host, id) => `${host}-${id}.json`
const session = (host, id, folder) => ({ name: n(host, id), id, folder })
const base = (over = {}) => ({
  hosts: {}, markers: {}, receipts: {}, copies: [], quarantined: [], consent: { [PUBLIC]: { contribute: true } },
  places: () => "here", orphans: { ran_at: "x", rebuilt: 0, current: 0, pending: 0, frozen: {} }, bindingVersion: BINDING, folderOf, ...over
})
const claude = (...sessions) => ({ "claude-code": { state: "counted", sessions } })
const one = (input, host = "claude-code") => {
  const out = classifySessions(base(input))[host]
  assertPartition(out)
  return out
}
const bucketOf = (out) => BUCKETS.find((bucket) => out[bucket] === 1)
const marker = (over = {}) => ({ desk_root: DESK_A, route: { kind: "store", store: PUBLIC }, store: PUBLIC, unproven: false, ...over })
const C1 = session("claude-code", "c1", "-folder-c1")

test("the owner markers are fixed", () => {
  assert.equal(OWNER_NONE, "-")
  assert.equal(OWNER_WITHHELD, "?")
  assert.deepEqual(BUCKETS, ["derived", "held", "frozen", "pending", "not_seen", "not_in_a_desk"])
})

test("every row of the decision table puts a session in its bucket", () => {
  const name = C1.name
  const hosts = claude(C1)
  const copy = [{ name, store: PUBLIC }]
  const m = { [name]: marker() }
  const cases = [
    ["1 quarantined copy is held", { hosts, copies: copy, quarantined: [name] }, "held"],
    ["2 orphan not current is frozen whatever the orphan pass's pending says", { hosts, copies: copy, orphans: { pending: 1, frozen: {} } }, "frozen"],
    ["2 orphan not current, nothing pending", { hosts, copies: copy, orphans: { pending: 0, frozen: {} } }, "frozen"],
    ["2 orphan with an old receipt", { hosts, copies: copy, receipts: { [name]: { binding_version: 4 } }, orphans: { pending: 1, frozen: {} } }, "frozen"],
    ["3 place unknown", { hosts, copies: copy, markers: m, places: () => "unknown" }, "frozen"],
    ["3 place stale", { hosts, copies: copy, markers: m, places: () => "stale" }, "frozen"],
    ["3 place stalled", { hosts, copies: copy, markers: m, places: () => "stalled" }, "frozen"],
    ["4 copy of a current orphan", { hosts, copies: copy, receipts: { [name]: { binding_version: BINDING } } }, "derived"],
    ["4 copy with a marker", { hosts, copies: copy, markers: m, places: () => "away" }, "derived"],
    ["5 marker without a desk", { hosts, markers: { [name]: marker({ desk_root: null }) } }, "not_in_a_desk"],
    ["6 no route resolves to a store", { hosts, markers: { [name]: marker({ route: { kind: "derived" }, store: null }) } }, "held"],
    ["7 store lacks consent", { hosts, markers: m, consent: { [PUBLIC]: { contribute: false } } }, "held"],
    ["7 store has no consent entry", { hosts, markers: m, consent: {} }, "held"],
    ["7 unproven default route", { hosts, markers: { [name]: marker({ unproven: true }) } }, "held"],
    ["8 the sweep would derive it", { hosts, markers: m }, "pending"],
    ["9 no marker in a known desk's folder", { receipts: { "claude-code-other.json": { desk_root: DESK_A, store: PUBLIC } }, hosts: claude({ ...C1, folder: folderOf(DESK_A) }, session("claude-code", "other", "-gone")) }, "not_seen"],
    ["10 no marker in any other folder", { hosts }, "not_in_a_desk"]
  ]
  for (const [label, input, expected] of cases) assert.equal(bucketOf(one(input)), expected, label)
})

test("copilot and codex report not_in_a_desk as null and count unmarked sessions as not_seen", () => {
  for (const host of ["copilot-cli", "codex-cli"]) {
    const out = one({ hosts: { [host]: { state: "counted", sessions: [session(host, "x1", undefined)] } } }, host)
    assert.equal(out.not_seen, 1)
    assert.equal(out.not_in_a_desk, null)
    assert.equal(Object.hasOwn(out.by_owner[OWNER_NONE], "not_in_a_desk"), false)
  }
  const out = one({ hosts: { "copilot-cli": { state: "counted", sessions: [session("copilot-cli", "m1")] } }, markers: { "copilot-cli-m1.json": marker({ desk_root: null }) } }, "copilot-cli")
  assert.equal(out.not_in_a_desk, null)
  assert.equal(out.not_seen, 1)
})

test("a host that is not counted yields only its state and unverified", () => {
  const out = classifySessions(base({ hosts: { "claude-code": { state: "capped", sessions: [] }, "copilot-cli": { state: "absent" }, "codex-cli": { state: "unreadable", sessions: [] } } }))
  assert.deepEqual(out, { "claude-code": { state: "capped", unverified: true }, "copilot-cli": { state: "absent", unverified: true }, "codex-cli": { state: "unreadable", unverified: true } })
  for (const host of Object.values(out)) assertPartition(host)
})

test("a host that was not given is left out, and a fallback enumeration is unverified", () => {
  assert.deepEqual(classifySessions(base({ hosts: {} })), {})
  assert.equal(one({ hosts: { "claude-code": { state: "counted", sessions: [], fallback: true } } }).unverified, true)
  assert.equal(one({ hosts: claude() }).unverified, false)
})

test("codex is unverified until one codex receipt exists for a listed session", () => {
  const hosts = { "codex-cli": { state: "counted", sessions: [session("codex-cli", "r1")] } }
  assert.equal(one({ hosts }, "codex-cli").unverified, true)
  assert.equal(one({ hosts, receipts: { "codex-cli-r1.json": { store: PUBLIC } } }, "codex-cli").unverified, false)
  assert.equal(one({ hosts, receipts: { "codex-cli-gone.json": { store: PUBLIC } } }, "codex-cli").unverified, true)
})

test("undetermined makes a host unverified when above zero and is passed through only when present", () => {
  const codex = (undetermined) => ({ "codex-cli": { state: "counted", sessions: [session("codex-cli", "r1")], ...(undetermined === undefined ? {} : { undetermined }) } })
  const receipts = { "codex-cli-r1.json": { store: PUBLIC } }
  const none = one({ hosts: codex(), receipts }, "codex-cli")
  assert.equal(Object.hasOwn(none, "undetermined"), false)
  assert.equal(none.unverified, false)
  const zero = one({ hosts: codex(0), receipts }, "codex-cli")
  assert.equal(zero.undetermined, 0)
  assert.equal(zero.unverified, false)
  const some = one({ hosts: codex(3), receipts }, "codex-cli")
  assert.equal(some.undetermined, 3)
  assert.equal(some.unverified, true)
  assert.equal(Object.hasOwn(one({ hosts: codex("x"), receipts }, "codex-cli"), "undetermined"), false)
  assert.deepEqual(classifySessions(base({ hosts: { "codex-cli": { state: "capped", sessions: [], undetermined: 2 } } })), { "codex-cli": { state: "capped", unverified: true } })
})

test("a marker or receipt with no listed session is ignored", () => {
  const known = { ...C1, folder: folderOf(DESK_A) }
  // The only evidence that DESK_A is a desk belongs to a session nothing lists, so the folder is not a known desk's.
  const out = one({ hosts: claude(known), markers: { "claude-code-gone.json": marker() }, receipts: { "claude-code-gone.json": { desk_root: DESK_A, store: PUBLIC } } })
  assert.equal(out.not_in_a_desk, 1)
  assert.equal(out.not_seen, 0)
})

test("a marker without an explicit null desk_root is a desk marker", () => {
  const out = one({ hosts: claude(C1), markers: { [C1.name]: marker({ desk_root: undefined }) } })
  assert.equal(out.not_in_a_desk, 0)
  assert.equal(out.pending, 1)
})

test("owner: the marker's positive route, then the receipt, then the marker's resolved store, then the copy's store", () => {
  const name = C1.name
  const owners = (input) => Object.keys(one({ hosts: claude(C1), ...input }).by_owner)
  assert.deepEqual(owners({ markers: { [name]: marker({ route: { kind: "store", store: PRIVATE } }) }, consent: { [PRIVATE]: { contribute: true } } }), [PRIVATE])
  assert.deepEqual(owners({ markers: { [name]: marker({ route: { kind: "derived" }, store: null }) }, receipts: { [name]: { route: PRIVATE, store: PUBLIC } } }), [PRIVATE])
  assert.deepEqual(owners({ markers: { [name]: marker({ route: { kind: "derived" }, store: null }) }, receipts: { [name]: { store: PRIVATE } } }), [PRIVATE])
  assert.deepEqual(owners({ markers: { [name]: marker({ route: { kind: "derived" }, store: PRIVATE }) } }), [PRIVATE])
  assert.deepEqual(owners({ copies: [{ name, store: PRIVATE }] }), [PRIVATE])
  assert.deepEqual(owners({ markers: { [name]: marker({ route: undefined, store: PRIVATE }) } }), [OWNER_WITHHELD])
})

test("a private desk with an unknown route never counts toward the default store", () => {
  const name = C1.name
  const consent = { [PUBLIC]: { contribute: true } }
  const out = one({ hosts: claude(C1), markers: { [name]: marker({ route: { kind: "unknown" }, store: PUBLIC }) }, consent })
  assert.deepEqual(Object.keys(out.by_owner), [OWNER_WITHHELD])
  assert.equal(out.held + out.pending, 1)
})

test("the owner is asserted for the copy rows and the quarantined rows, with distinguishable owners", () => {
  const name = C1.name
  const hosts = claude(C1)
  const two = { [PUBLIC]: { contribute: true }, [PRIVATE]: { contribute: true } }
  const owned = (input) => one({ hosts, consent: two, copies: [{ name, store: PRIVATE }], ...input }).by_owner
  assert.deepEqual(owned({ quarantined: [name] }), { [PRIVATE]: { derived: 0, held: 1, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: 0 } })
  assert.deepEqual(owned({ orphans: { pending: 1, frozen: {} } }), { [PRIVATE]: { derived: 0, held: 0, frozen: 1, pending: 0, not_seen: 0, not_in_a_desk: 0 } })
  assert.deepEqual(owned({ orphans: null }), { [PRIVATE]: { derived: 0, held: 0, frozen: 1, pending: 0, not_seen: 0, not_in_a_desk: 0 } })
  const current = { receipts: { [name]: { binding_version: BINDING } } }
  assert.deepEqual(owned(current), { [PRIVATE]: { derived: 1, held: 0, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: 0 } })
  assert.deepEqual(owned({ ...current, places: () => "unknown" }), { [PRIVATE]: { derived: 0, held: 0, frozen: 1, pending: 0, not_seen: 0, not_in_a_desk: 0 } })
  // The place is asked for the owning store.
  let asked
  owned({ ...current, places: (n, store) => ((asked = [n, store]), "here") })
  assert.deepEqual(asked, [name, PRIVATE])
})

test("a session with desk evidence but no tellable store is owner ?, and one without desk evidence follows the consent rule", () => {
  const name = C1.name
  const untold = marker({ route: { kind: "derived" }, store: null })
  assert.deepEqual(Object.keys(one({ hosts: claude(C1), markers: { [name]: untold } }).by_owner), [OWNER_WITHHELD])
  assert.deepEqual(Object.keys(one({ hosts: claude(C1), receipts: { [name]: { desk_root: DESK_A } }, copies: [] }).by_owner), [OWNER_WITHHELD])
  assert.deepEqual(Object.keys(one({ hosts: claude(C1), markers: { [name]: marker({ desk_root: null, route: undefined, store: null }) } }).by_owner), [OWNER_NONE])
  const stores = (...contribute) => Object.fromEntries(contribute.map((flag, i) => [`acme/s${i}`, { contribute: flag }]))
  for (const [consent, owner] of [[{}, "-"], [stores(false), "-"], [stores(true), "-"], [stores(true, false), "-"], [stores(true, true), "?"], [stores(true, true, false), "?"]]) {
    assert.deepEqual(Object.keys(one({ hosts: claude(C1), consent }).by_owner), [owner])
  }
  assert.deepEqual(Object.keys(one({ hosts: { "copilot-cli": { state: "counted", sessions: [session("copilot-cli", "k")] } }, consent: stores(true, true) }, "copilot-cli").by_owner), [OWNER_WITHHELD])
})

test("a Claude session in a known desk's folder with no marker is not_seen, and in an unknown folder is not_in_a_desk", () => {
  const known = { ...C1, folder: folderOf(DESK_A) }
  const other = session("claude-code", "c2", "-elsewhere")
  const marked = session("claude-code", "m", "-m")
  const out = one({ hosts: claude(known, other, marked), markers: { [marked.name]: marker() } })
  assert.equal(out.not_seen, 1)
  assert.equal(out.not_in_a_desk, 1)
  assert.equal(out.by_owner[PUBLIC].not_seen, 1)
  assert.equal(out.by_owner[OWNER_NONE].not_in_a_desk, 1)
})

test("a desk whose receipts name two stores withholds its not_seen sessions from every owner", () => {
  const known = { ...C1, folder: folderOf(DESK_A) }
  const receipts = { "claude-code-a.json": { desk_root: DESK_A, store: PUBLIC }, "claude-code-b.json": { desk_root: DESK_A, store: PRIVATE } }
  const listed = [known, session("claude-code", "a", "-x"), session("claude-code", "b", "-y")]
  const out = one({ hosts: claude(...listed), receipts })
  assert.equal(out.by_owner[OWNER_WITHHELD].not_seen, 1)
  assert.equal(out.not_seen, 1)
  // A desk known only by a session with no tellable store is withheld too.
  const untold = one({ hosts: claude(known, session("claude-code", "a", "-x")), receipts: { "claude-code-a.json": { desk_root: DESK_A } } })
  assert.equal(untold.by_owner[OWNER_WITHHELD].not_seen, 1)
  assert.equal(untold.not_seen, 1)
  // One session of the desk naming a store and one naming none: still withheld.
  const mixed = one({ hosts: claude(known, session("claude-code", "a", "-x"), session("claude-code", "b", "-y")), receipts: { "claude-code-a.json": { desk_root: DESK_A, store: PUBLIC }, "claude-code-b.json": { desk_root: DESK_A } } })
  assert.equal(mixed.by_owner[OWNER_WITHHELD].not_seen, 1)
  assert.equal(Object.hasOwn(mixed.by_owner, PUBLIC) ? mixed.by_owner[PUBLIC].not_seen : 0, 0)
  // Two receipts that agree on one store give that store the session.
  const agree = one({ hosts: claude(known, session("claude-code", "a", "-x"), session("claude-code", "b", "-y")), receipts: { "claude-code-a.json": { desk_root: DESK_A, store: PUBLIC }, "claude-code-b.json": { desk_root: DESK_A, store: PUBLIC } } })
  assert.equal(agree.by_owner[PUBLIC].not_seen, 1)
  assert.equal(agree.not_seen, 1)
})

test("every not-current orphan is frozen as orphan_unsplit, whatever the orphan pass's pending count says", () => {
  const sessions = ["a", "b", "c"].map((id) => session("claude-code", id, "-f"))
  for (const pending of [0, 1, 2, 99, "x", -1, undefined]) {
    const out = one({ hosts: claude(...sessions), copies: sessions.map(({ name }) => ({ name, store: PUBLIC })), orphans: { pending, frozen: { route_unknown: 1, [ORPHAN_UNSPLIT]: 1 }, cursor: 7, extra: { more: true }, oldest_pending_age: 1 } })
    assert.equal(out.pending, 0)
    assert.equal(out.frozen, 3)
    // The pass's own window reasons are not added: each orphan is counted once, so the reasons add up to `frozen`.
    assert.deepEqual(out.frozen_by_reason, { [ORPHAN_UNSPLIT]: 3 })
    assert.equal(Object.values(out.frozen_by_reason).reduce((sum, count) => sum + count, 0), out.frozen)
  }
})

test("without status.orphans or with a failed pass every not-current orphan is frozen as orphan_pass_unavailable", () => {
  const sessions = ["a", "b"].map((id) => session("claude-code", id, "-f"))
  const copies = sessions.map(({ name }) => ({ name, store: PUBLIC }))
  for (const orphans of [null, { ran_at: "x", failed: "pass_failed" }, undefined, "junk"]) {
    const out = one({ hosts: claude(...sessions), copies, orphans })
    assert.equal(out.frozen, 2)
    assert.equal(out.pending, 0)
    assert.deepEqual(out.frozen_by_reason, { [ORPHAN_PASS_UNAVAILABLE]: 2 })
  }
})

test("the orphan pass's own reasons (any of them, unknown ones too) never reach frozen_by_reason or on_disk", () => {
  const out = one({ hosts: claude(), orphans: { pending: -3, frozen: { no_facts: 4, no_transcript: 2, derive_failed: 1, brand_new_reason: 5, bad: "x" } } })
  assert.equal(out.on_disk, 0)
  assert.deepEqual(out.frozen_by_reason, {})
  assert.deepEqual(one({ hosts: claude(), orphans: { pending: 1 } }).frozen_by_reason, {})
})

test("no consent at all holds a marked session and leaves unowned sessions unowned", () => {
  const out = one({ hosts: claude(C1), markers: { [C1.name]: marker() }, consent: null })
  assert.equal(out.held, 1)
})

test("a quarantined copy is held, not derived", () => {
  const out = one({ hosts: claude(C1), copies: [{ name: C1.name, store: PUBLIC }], markers: { [C1.name]: marker() }, quarantined: new Set([C1.name]) })
  assert.equal(out.held, 1)
  assert.equal(out.derived, 0)
})

test("a store named like a prototype key is an ordinary key", () => {
  const out = one({ hosts: claude(C1), copies: [{ name: C1.name, store: "__proto__" }], orphans: { pending: 0, frozen: { __proto__x: 1, constructor: 2 } } })
  assert.equal(Object.hasOwn(out.by_owner, "__proto__") || Object.keys(out.by_owner).length === 1, true)
  assert.equal(Object.keys(out.by_owner).length, 1)
  assert.equal(Object.getPrototypeOf({}).frozen, undefined)
  assert.equal(Object.getPrototypeOf({}).derived, undefined)
  assert.deepEqual(out.frozen_by_reason, { orphan_unsplit: 1 })
})

test("a prototype key in a name is not a marker or a receipt", () => {
  const out = one({ hosts: claude(session("claude-code", "p", "-f")), markers: null, receipts: null })
  assert.equal(out.not_in_a_desk, 1)
  const weird = { name: "constructor", id: "constructor", folder: "-f" }
  assert.equal(one({ hosts: claude(weird) }).not_in_a_desk, 1)
})

test("a copy for a name the host copy does not list is not counted", () => {
  assert.equal(one({ hosts: claude(), copies: [{ name: "claude-code-ghost.json", store: PUBLIC }] }).on_disk, 0)
})

test("the buckets and by_owner buckets always sum, over 500 seeded random cases", () => {
  let seed = 12345
  const rand = (limit) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % limit
  }
  const stores = [PUBLIC, PRIVATE, null, undefined]
  for (let round = 0; round < 500; round += 1) {
    const hosts = {}
    const markers = {}
    const receipts = {}
    const copies = []
    const quarantined = []
    for (const host of ["claude-code", "copilot-cli", "codex-cli"]) {
      const state = ["counted", "counted", "counted", "capped", "absent", "unreadable"][rand(6)]
      const sessions = []
      for (let i = 0, count = rand(8); i < count; i += 1) {
        const s = session(host, `${round}-${i}`, [folderOf(DESK_A), folderOf(DESK_B), "-other"][rand(3)])
        sessions.push(s)
        if (rand(2)) markers[s.name] = marker({ desk_root: [DESK_A, DESK_B, null][rand(3)], route: rand(2) ? { kind: "store", store: stores[rand(4)] } : { kind: "derived" }, store: stores[rand(4)], unproven: rand(5) === 0 })
        if (rand(3) === 0) receipts[s.name] = { desk_root: [DESK_A, DESK_B, undefined][rand(3)], store: stores[rand(4)], route: stores[rand(4)], binding_version: rand(7) }
        if (rand(3) === 0) copies.push({ name: s.name, store: stores[rand(2)] })
        if (rand(8) === 0) quarantined.push(s.name)
      }
      hosts[host] = { state, sessions }
    }
    const consent = { [PUBLIC]: { contribute: rand(2) === 0 }, [PRIVATE]: { contribute: rand(2) === 0 } }
    const orphans = [null, { pending: rand(4), frozen: {} }, { failed: "pass_failed" }][rand(3)]
    const out = classifySessions(base({ hosts, markers, receipts, copies, quarantined, consent, orphans, places: () => ["here", "away", "stale", "stalled", "unknown"][rand(5)] }))
    for (const host of Object.values(out)) assertPartition(host)
  }
})

test("each session lands in the bucket an independent oracle names, over 500 seeded cases of the marker rows", () => {
  let seed = 777
  const rand = (limit) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % limit
  }
  const expectedBucket = (host, m, contributes) => {
    if (m === null) return host === "claude-code" ? "not_in_a_desk" : "not_seen"
    if (m.desk_root === null) return host === "claude-code" ? "not_in_a_desk" : "not_seen"
    if (m.store === null || !contributes || m.unproven) return "held"
    return "pending"
  }
  for (let round = 0; round < 500; round += 1) {
    const host = ["claude-code", "copilot-cli", "codex-cli"][rand(3)]
    const contributes = rand(2) === 0
    const sessions = []
    const markers = {}
    const expected = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0]))
    for (let i = 0, count = rand(10); i < count; i += 1) {
      const s = session(host, `${round}-${i}`, "-nowhere")
      sessions.push(s)
      const m = rand(4) === 0 ? null : { desk_root: rand(3) === 0 ? null : DESK_A, route: { kind: "derived" }, store: rand(4) === 0 ? null : PUBLIC, unproven: rand(5) === 0 }
      if (m !== null) markers[s.name] = m
      expected[expectedBucket(host, m, contributes)] += 1
    }
    const out = one({ hosts: { [host]: { state: "counted", sessions } }, markers, consent: { [PUBLIC]: { contribute: contributes } } }, host)
    for (const bucket of BUCKETS) assert.equal(out[bucket] ?? 0, host === "claude-code" || bucket !== "not_in_a_desk" ? expected[bucket] : 0, `${host} ${bucket}`)
  }
})

test("assertPartition throws on a broken sum and on counts for an uncounted host", () => {
  const good = { state: "counted", on_disk: 2, derived: 1, held: 0, frozen: 0, pending: 0, not_seen: 1, not_in_a_desk: null, unverified: false, by_owner: { "-": { derived: 1, not_seen: 1 } } }
  assertPartition(good)
  assert.throws(() => assertPartition({ ...good, on_disk: 3 }), /add up to on_disk/u)
  assert.throws(() => assertPartition({ ...good, by_owner: { "-": { derived: 1, not_seen: 0 } } }), /owners' not_seen/u)
  assert.throws(() => assertPartition({ state: "capped", unverified: true, on_disk: 0 }), /not counted/u)
  assertPartition({ state: "absent", unverified: true })
})

test("privacy: nothing from names, ids, desks or folders reaches the output; only counts, fixed enums and store names", () => {
  const root = `/desk/${SENTINEL}`
  const folder = folderOf(root)
  const s1 = session("claude-code", `${SENTINEL}-1`, folder)
  const s2 = session("claude-code", `${SENTINEL}-2`, "-x")
  const out = classifySessions(base({
    hosts: claude(s1, s2), markers: { [s2.name]: marker({ desk_root: root }) }, receipts: { [s2.name]: { desk_root: root, store: PUBLIC } },
    copies: [{ name: s2.name, store: PUBLIC }], orphans: { pending: 0, frozen: {}, [SENTINEL]: SENTINEL }
  }))
  assert.equal(JSON.stringify(out).includes(SENTINEL), false)
  assert.equal(out["claude-code"].not_seen, 1)
})

test("an owner's orphans are frozen for that owner only, and the partition holds", () => {
  const priv = ["p1", "p2", "p3"].map((id) => session("claude-code", id, "-f"))
  const pub = ["a", "b"].map((id) => session("claude-code", id, "-f"))
  const out = one({ hosts: claude(...priv, ...pub), copies: [...priv.map(({ name }) => ({ name, store: PRIVATE })), ...pub.map(({ name }) => ({ name, store: PUBLIC }))], orphans: { pending: 5, frozen: {} } })
  assert.deepEqual([out.pending, out.frozen], [0, 5])
  assert.deepEqual([out.by_owner[PRIVATE].frozen, out.by_owner[PUBLIC].frozen, out.by_owner[PUBLIC].pending], [3, 2, 0])
})

test("a fallback listing flag reaches the host entry only when true", () => {
  const listed = (fallback) => classifySessions(base({ hosts: { "claude-code": { state: "counted", sessions: [], fallback } } }))["claude-code"]
  assert.equal(listed(true).fallback, true)
  assert.equal(listed(true).unverified, true)
  assert.equal(Object.hasOwn(listed(false), "fallback"), false)
  assert.equal(Object.hasOwn(listed(undefined), "fallback"), false)
})
