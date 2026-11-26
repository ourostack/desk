import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { LEASE_MS, assessLease, claimCard, leaseStatus, takeClaim } from "../../../../../plugins/desk/mcp/src/runtime/leases.js"

const NOW = Date.parse("2026-11-26T12:00:00Z")
const ago = (ms) => new Date(NOW - ms).toISOString()
const claim = (ms) => ({ card: "t/c", owner: "s1", claimedAt: ago(ms) })
const MIN = 60_000

test("a claim lapses after two hours with nothing pushed, and a push renews it", () => {
  assert.equal(assessLease({ claim: claim(119 * MIN), now: NOW }).state, "held")
  assert.equal(assessLease({ claim: claim(LEASE_MS), now: NOW }).state, "lapsed")
  assert.equal(assessLease({ claim: claim(5 * LEASE_MS), now: NOW, lastPushMs: NOW - 10 * MIN }).state, "held")
})

test("a goal owned by a session that ended has no owner, however recent its push", () => {
  assert.equal(assessLease({ claim: claim(MIN), now: NOW, lastPushMs: NOW, ownerEnded: true }).state, "ownerless")
})

test("gaming: a future start, a future push or a renewed-at in the claim file never stretch a lease", () => {
  assert.equal(assessLease({ claim: { ...claim(LEASE_MS), claimedAt: new Date(NOW + 10 * LEASE_MS).toISOString() }, now: NOW + LEASE_MS }).state, "lapsed")
  assert.equal(assessLease({ claim: claim(LEASE_MS), now: NOW, lastPushMs: NOW + 10 * LEASE_MS }).state, "lapsed")
  assert.equal(assessLease({ claim: { ...claim(LEASE_MS), renewedAt: ago(0), lastMessageAt: ago(0) }, now: NOW }).state, "lapsed")
  assert.equal(assessLease({ claim: { card: "t/c", owner: "s1" }, now: NOW }).state, "lapsed")
})

test("gaming: claiming a held card again, by anyone, neither restarts its lease nor takes it", () => {
  const claims = [claim(110 * MIN)]
  const assess = (c) => assessLease({ claim: c, now: NOW })
  for (const owner of ["s1", "s2"]) {
    const r = takeClaim({ claims, card: "t/c", owner, now: NOW, assess })
    assert.equal(r.taken, false)
    assert.equal(r.claims[0].claimedAt, claims[0].claimedAt)
  }
  const lapsed = takeClaim({ claims: [claim(3 * LEASE_MS)], card: "t/c", owner: "s2", now: NOW, assess })
  assert.equal(lapsed.taken, true)
  assert.equal(lapsed.claims[0].owner, "s2")
})

test("claims are kept on disk, a repeated claim is refused, and a missing owner history makes the claim ownerless", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "leases-"))
  const paths = { claims: path.join(home, "claims.json") }
  const env = { ...process.env, COPILOT_HOME: path.join(home, "copilot") }
  const push = () => null
  assert.equal((await claimCard({ paths, card: "t/c", owner: "s1", repo: "o/r", branch: "b", now: NOW, env, push })).taken, true)
  // The owner's history does not exist here, so the session counts as ended and the card can be taken.
  assert.equal((await claimCard({ paths, card: "t/c", owner: "s2", now: NOW + MIN, env, push })).owner, "s2")
  const status = await leaseStatus({ paths, now: NOW + 2 * MIN, env, push })
  assert.equal(status.leases[0].state, "ownerless")
})
