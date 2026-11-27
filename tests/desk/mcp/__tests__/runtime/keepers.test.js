import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { beat, findings, keepersCheck, peerFindings, publish, readKeeperConfig } from "../../../../../plugins/desk/mcp/src/runtime/keepers.js"

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
  assert.equal(peerFindings({ now: NOW, read: beatAt(-5) }).length, 0)
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
  assert.deepEqual(readKeeperConfig(path.join(tmpdir(), "no-such-keepers.json")), { host: null, repo: null, peers: [] })
})

test("gaming: a corrupted keepers.json stops the check; it does not read as no peers and switch the peer check off", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keepers-bad-"))
  const file = path.join(dir, "keepers.json")
  writeFileSync(file, "{nope")
  assert.throws(() => readKeeperConfig(file), (error) => typeof error.keepersConfigInvalid === "string")
  assert.deepEqual(readKeeperConfig(path.join(dir, "missing.json")), { host: null, repo: null, peers: [] })
})

test("two hosts check each other through a shared git remote, with no ssh", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "keepers-git-"))
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" })
  git(root, "init", "-q", "--bare", "origin.git")
  // GitHub refuses a ref that points at a bare blob; the same rule here keeps the publish honest.
  const hook = path.join(root, "origin.git", "hooks", "pre-receive")
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do [ "$(git cat-file -t "$new")" = commit ] || { echo "not a commit" >&2; exit 1; }; done\n', { mode: 0o755 })
  for (const n of ["a", "b"]) git(root, "clone", "-q", "origin.git", n)
  const cfg = (host, peer, n) => ({ host, repo: path.join(root, n), peers: [{ host: peer }] })
  const run = (config, now) => keepersCheck({ config, heartbeatDir: mkdtempSync(path.join(tmpdir(), "hb-")), endings: [], leases: [], now })
  assert.equal((await run(cfg("laptop", "mini", "a"), NOW)).findings.length, 1, "the peer has shown nothing yet")
  assert.equal((await run(cfg("mini", "laptop", "b"), NOW)).findings.length, 0, "the mini reads the laptop's published heartbeat")
  assert.equal((await run(cfg("laptop", "mini", "a"), NOW + 5 * 60_000)).findings.length, 0, "and the laptop reads the mini's")
  const quiet = await run(cfg("laptop", "mini", "a"), NOW + 60 * 60_000)
  assert.equal(quiet.findings[0].kind, "peer_silent", "a keeper that stops publishing goes quiet within half an hour")
})

test("a heartbeat that cannot be published says so and is still shown locally", async () => {
  const notRepo = mkdtempSync(path.join(tmpdir(), "keepers-no-repo-"))
  assert.equal(publish({ repo: notRepo, host: "mini", now: NOW }), false, "a folder that is no git repository publishes nothing")
  const result = await keepersCheck({ config: { host: "mini", repo: notRepo, peers: [] }, heartbeatDir: mkdtempSync(path.join(tmpdir(), "hb-")), endings: [], leases: [], now: NOW })
  assert.equal(result.status[0], "mini: heartbeat shown locally only; publishing to the shared repo failed")
})
