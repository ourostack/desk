import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { beat, findings, keepersCheck, peerFindings, readKeeperConfig } from "../../../../../plugins/desk/mcp/src/runtime/keepers.js"

const NOW = Date.parse("2026-11-26T12:00:00Z")
const at = (min) => new Date(NOW + min * 60_000).toISOString()
const wait = (card, min, on = "Ari", t = -60) => ({ card, at: at(t), ending: { kind: "waiting", on, wake: "w", expires: at(min), blocks: "x" } })

test("an expired wait becomes a finding; a live one, a done card and a blocked one do not", () => {
  const endings = [wait("a", -5), wait("b", 30), { card: "c", at: at(-10), ending: { kind: "done", shipped: "u" } }, { card: "d", at: at(-10), ending: { kind: "blocked", on: "Ari", resume: "ask" } }]
  assert.deepEqual(findings({ endings, now: NOW }).map((f) => [f.kind, f.card]), [["wait_expired", "a"]])
})

test("gaming: renewing a wait on the same thing again and again is a finding while it is still unexpired", () => {
  const endings = [wait("a", -30, "Ari", -150), wait("a", -10, "Ari", -90), wait("a", 60, "Ari", -30)]
  assert.deepEqual(findings({ endings, now: NOW }).map((f) => f.kind), ["wait_renewed"])
  // Waiting on something different each time is not a chain.
  assert.deepEqual(findings({ endings: [wait("a", -30, "Ari", -150), wait("a", -10, "review", -90), wait("a", 60, "deploy", -30)], now: NOW }), [])
})

test("a wait on a system we own that ran past its expiry becomes a job to fix that system; one on a person or outside system stays a wait", () => {
  const endings = [wait("a", -5, "CI on PR 12"), wait("b", -5, "the merge queue"), wait("c", -5, "Ari's reply"), wait("d", -5, "vendor approval")]
  assert.deepEqual(findings({ endings, now: NOW }).map((f) => [f.kind, f.card]), [["fix_system", "a"], ["fix_system", "b"], ["wait_expired", "c"], ["wait_expired", "d"]])
})

test("gaming: renewing a wait on an owned system, or wording it vaguely, still surfaces a finding", () => {
  const renewed = [wait("a", -30, "release", -150), wait("a", -10, "release", -90), wait("a", 60, "release", -30)]
  assert.deepEqual(findings({ endings: renewed, now: NOW }).map((f) => f.kind), ["fix_system"])
  assert.deepEqual(findings({ endings: [wait("a", -5, "it")], now: NOW }).map((f) => f.kind), ["wait_expired"])
})

test("gaming: a later ending replaces an earlier one, so a done after an expired wait clears it, and an unverified end is a finding", () => {
  assert.equal(findings({ endings: [wait("a", -5), { card: "a", at: at(-1), ending: { kind: "done", shipped: "u" } }], now: NOW }).length, 0)
  assert.equal(findings({ endings: [{ card: "a", at: at(-1), ending: { kind: "unverified", why: "no wake" } }], now: NOW })[0].kind, "unverified_end")
})

test("gaming: the findings take no session status, so a session that is busy cannot hide one", () => {
  assert.equal(findings({ endings: [wait("a", -5)], leases: [], now: NOW, busy: true, sessions: [{ running: true }] }).length, 1)
})

test("lapsed and ownerless claims are findings", () => {
  const leases = [{ card: "a", state: "lapsed", why: "x" }, { card: "b", state: "ownerless", why: "y" }, { card: "c", state: "held", why: "z" }]
  assert.deepEqual(findings({ leases, now: NOW }).map((f) => f.kind), ["lease_lapsed", "no_owner"])
})

test("two hosts check each other: a peer with a missing, old, future or unreadable heartbeat is silent", () => {
  const peers = [{ host: "mini", ssh: "m" }]
  const beatAt = (min) => () => JSON.stringify({ host: "mini", at: at(min) })
  assert.equal(peerFindings({ peers, now: NOW, read: beatAt(-5) }).length, 0)
  assert.equal(peerFindings({ peers, now: NOW, read: beatAt(-30) }).length, 1)
  assert.equal(peerFindings({ peers, now: NOW, read: beatAt(+500) }).length, 1)
  assert.equal(peerFindings({ peers, now: NOW, read: () => null }).length, 1)
  assert.equal(peerFindings({ peers, now: NOW, read: () => "garbage" }).length, 1)
})

test("a run shows this host's heartbeat, which its peer can then read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keepers-"))
  const config = { host: "laptop", peers: [{ host: "mini", ssh: "m" }] }
  const r = await keepersCheck({ config, heartbeatDir: dir, endings: [], leases: [], now: NOW, read: () => null })
  assert.equal(JSON.parse(readFileSync(path.join(dir, "laptop.json"), "utf8")).at, at(0))
  assert.equal(r.findings[0].kind, "peer_silent")
  assert.equal(beat({ dir, host: "x", now: NOW }).endsWith("x.json"), true)
})

test("a missing or malformed config names no host and no peers", () => {
  assert.deepEqual(readKeeperConfig(path.join(tmpdir(), "no-such-keepers.json")), { host: null, peers: [] })
})

test("gaming: a corrupted keepers.json stops the check; it does not read as no peers and switch the peer check off", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keepers-bad-"))
  const file = path.join(dir, "keepers.json")
  writeFileSync(file, "{nope")
  assert.throws(() => readKeeperConfig(file), (error) => typeof error.keepersConfigInvalid === "string")
  assert.deepEqual(readKeeperConfig(path.join(dir, "missing.json")), { host: null, peers: [] })
})
