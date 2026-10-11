import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { mkTempRoot } from "../_temp_roots.js"
import { cardFile, openImprovement, readCards } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { validateTriageResultBytes } from "../../../../../plugins/desk/mcp/src/factory/triage-schema.js"
import {
  canonicalCardPath, checkTriageBasis, defaultRulingPaths, readRulings, readTriageBasis, safeDeskPath,
} from "../../../../../plugins/desk/mcp/src/factory/triage-basis.js"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/v12-triage-local.json", import.meta.url)))
const KEY = fixture.key
const T0 = Date.parse("2026-10-11T12:00:00.000Z")
const HOUR = 3600 * 1000
const ISSUE = "issue:example-org/example-repo#101"

async function desk({ prefix = "", agents = "Agents may fix factory defects in existing scope.\n", evidence = [ISSUE] } = {}) {
  const deskRoot = await mkTempRoot("triage-basis-")
  if (agents !== null) await fs.writeFile(path.join(deskRoot, "AGENTS.md"), agents)
  const opened = await openImprovement({ deskRoot, personPrefix: prefix, key: KEY, source: "andon", evidence, plugin: "desk", signal: null, now: T0 })
  assert.equal(opened.result, "opened")
  return { deskRoot, card: opened.file }
}

// Rewrites the card's front matter as a live claim that expires at `expiresAt`, the way `claimNext` leaves it.
async function claim(file, expiresAt) {
  const text = await fs.readFile(file, "utf8")
  const value = { claim_id: randomUUID(), claimed_at: new Date(T0).toISOString(), expires_at: new Date(expiresAt).toISOString(), machine: "abcdef0123456789", session: null }
  await fs.writeFile(file, text.replace('state: "open"', 'state: "claimed"').replace("claim: null", `claim: ${JSON.stringify(value)}`))
}

const resolveIssue = async (pointer) => (pointer.startsWith("issue:")
  ? { revision: 3, public: { kind: "issue", ref: "https://github.com/example-org/example-repo/issues/101", revision: 3 } }
  : { revision: 1, public: null })

function briefFor(read, basisToken = "basis-token") {
  return {
    batch: "0123456789abcdef", producer_version: "1.4.0", rubric_version: 1,
    cards: [{ key: KEY, basis: basisToken, evidence_ids: read.briefEvidence.map((item) => item.id), ruling_ids: read.authority.ruling_ids, authority_codes: read.authority.codes }],
  }
}

function candidate(read, overrides) {
  return {
    key: KEY, basis: "basis-token", route: "agent_ready", problem: "p", observed_impact: "o", unknowns: [], next_step: "n",
    authority: { code: "existing_scope", ruling_ids: read.authority.ruling_ids }, evidence: read.briefEvidence.map((item) => item.id),
    related: [], duplicates: [], decision: null, gate_reason: null, recommendation: null, safe_continuation: null, ...overrides,
  }
}
const resultBytes = (results) => `${JSON.stringify({ schema: "desk.factory.triage-result/1", batch: "0123456789abcdef", rubric_version: 1, producer_version: "1.4.0", results })}\n`

test("authority_and_claim_are_live_inputs", async () => {
  const { deskRoot, card } = await desk()
  await claim(card, T0 + HOUR)
  const cardBytes = await fs.readFile(card)
  const agentsBytes = await fs.readFile(path.join(deskRoot, "AGENTS.md"))

  const live = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { resolve: resolveIssue } })
  assert.equal(live.state, "ready")
  assert.deepEqual(live.authority, { state: "resolved", codes: ["existing_scope", "investigation_only", "human_gate"], ruling_ids: ["AGENTS.md"] })
  assert.deepEqual(live.basis.claim, { state: "live", expires_at: new Date(T0 + HOUR).toISOString() })
  assert.match(live.basis.canonical_revision, /^[0-9a-f]{40}$/u)
  assert.match(live.basis.fingerprint, /^[0-9a-f]{64}$/u)
  assert.deepEqual(live.basis.public_evidence_revisions, [{ kind: "issue", ref: "https://github.com/example-org/example-repo/issues/101", revision: 3 }])
  assert.deepEqual((await checkTriageBasis({ deskRoot, personPrefix: "", basis: live.basis, now: T0 + 1000 })), { state: "current", reason: null })

  // The claim expires with the card bytes unchanged: effective ownership changes, so the basis does.
  const expired = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0 + 2 * HOUR, evidence: { resolve: resolveIssue } })
  assert.equal(expired.basis.canonical_revision, live.basis.canonical_revision, "same card bytes")
  assert.equal(expired.basis.claim.state, "expired")
  assert.notEqual(expired.basis.fingerprint, live.basis.fingerprint)
  assert.deepEqual(await checkTriageBasis({ deskRoot, personPrefix: "", basis: live.basis, now: T0 + 2 * HOUR }), { state: "stale", reason: "claim_changed" })

  // Scope revoked in the ruling, card bytes unchanged: the basis is no longer the reviewed one.
  await fs.writeFile(path.join(deskRoot, "AGENTS.md"), "Factory defects now need the operator's approval.\n")
  const revoked = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { resolve: resolveIssue } })
  assert.equal(revoked.basis.canonical_revision, live.basis.canonical_revision)
  assert.notEqual(revoked.basis.fingerprint, live.basis.fingerprint)
  assert.deepEqual(await checkTriageBasis({ deskRoot, personPrefix: "", basis: live.basis, now: T0 + 1000 }), { state: "stale", reason: "authority_changed" })
  await fs.writeFile(path.join(deskRoot, "AGENTS.md"), agentsBytes)

  // No ruling at all: an investigation or a human gate only, never existing scope.
  await fs.rename(path.join(deskRoot, "AGENTS.md"), path.join(deskRoot, "AGENTS.moved"))
  const none = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { resolve: resolveIssue } })
  assert.equal(none.state, "ready")
  assert.deepEqual(none.authority, { state: "unresolved", codes: ["investigation_only", "human_gate"], ruling_ids: [] })
  assert.deepEqual(await checkTriageBasis({ deskRoot, personPrefix: "", basis: live.basis, now: T0 + 1000 }), { state: "stale", reason: "authority_changed" })
  // A ruling that appears later also changes the basis that was read without it.
  await fs.rename(path.join(deskRoot, "AGENTS.moved"), path.join(deskRoot, "AGENTS.md"))
  assert.deepEqual(await checkTriageBasis({ deskRoot, personPrefix: "", basis: none.basis, now: T0 + 1000 }), { state: "stale", reason: "authority_changed" })

  // Canonical file bytes and the claim are untouched by every read.
  assert.deepEqual(await fs.readFile(card), cardBytes)
  assert.deepEqual(await fs.readFile(path.join(deskRoot, "AGENTS.md")), agentsBytes)
})

test("missing_ruling_or_evidence_is_unknown_not_agent_ready", async () => {
  const { deskRoot } = await desk()
  const missingPlan = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { prepared: [{ kind: "plan", path: "plans/missing.md" }], resolve: resolveIssue } })
  assert.equal(missingPlan.state, "authority_unknown")
  assert.deepEqual(missingPlan.authority, { state: "authority_unknown", codes: ["investigation_only", "human_gate"], ruling_ids: [] })

  const unknownEvidence = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0 })
  assert.equal(unknownEvidence.state, "evidence_unknown", "an issue pointer needs the parent's resolver")
  assert.deepEqual(unknownEvidence.briefEvidence, [])
  assert.deepEqual(unknownEvidence.authority.codes, ["investigation_only", "human_gate"])
  assert.deepEqual(unknownEvidence.authority.ruling_ids, [])
  const badRevision = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { resolve: async () => ({ revision: 0 }) } })
  assert.equal(badRevision.state, "evidence_unknown")

  // An unreadable ruling (here a folder where the file should be) is unknown authority, not absent authority.
  await fs.rename(path.join(deskRoot, "AGENTS.md"), path.join(deskRoot, "AGENTS.txt"))
  await fs.mkdir(path.join(deskRoot, "AGENTS.md"))
  const unreadable = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { resolve: resolveIssue } })
  assert.equal(unreadable.state, "authority_unknown")
  assert.deepEqual(unreadable.authority.codes, ["investigation_only", "human_gate"])
})

test("complex_authorized_work_may_be_agent_ready_and_small_irreversible_work_a_human_gate", async () => {
  const many = Array.from({ length: 10 }, (_, index) => `job:${String(index).padStart(32, "0")}`)
  const big = await desk({ evidence: many })
  await fs.mkdir(path.join(big.deskRoot, "plans"))
  await fs.writeFile(path.join(big.deskRoot, "plans", "approved.md"), "Approved plan: rebuild the delivery pipeline across many files.\n")
  const read = await readTriageBasis({ deskRoot: big.deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { prepared: [{ kind: "plan", path: "plans/approved.md" }] } })
  assert.equal(read.state, "ready")
  assert.equal(read.briefEvidence.length, 10, "self-describing pointers resolve without a resolver")
  assert.deepEqual(read.authority.codes, ["existing_scope", "approved_plan", "investigation_only", "human_gate"])
  assert.deepEqual(read.authority.ruling_ids, ["AGENTS.md", "plans/approved.md"])
  const agentReady = validateTriageResultBytes(resultBytes([candidate(read, { authority: { code: "approved_plan", ruling_ids: ["plans/approved.md"] } })]), { brief: briefFor(read) })
  assert.equal(agentReady.ok, true, JSON.stringify(agentReady.errors))
  assert.deepEqual(await checkTriageBasis({ deskRoot: big.deskRoot, personPrefix: "", basis: read.basis, now: T0 }), { state: "current", reason: null })
  await fs.writeFile(path.join(big.deskRoot, "plans", "approved.md"), "Plan withdrawn.\n")
  assert.deepEqual(await checkTriageBasis({ deskRoot: big.deskRoot, personPrefix: "", basis: read.basis, now: T0 }), { state: "stale", reason: "authority_changed" })

  const small = await desk()
  const smallRead = await readTriageBasis({ deskRoot: small.deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { resolve: resolveIssue } })
  const human = validateTriageResultBytes(resultBytes([candidate(smallRead, {
    route: "human_decision", authority: { code: "human_gate", ruling_ids: [] }, decision: "d", gate_reason: "irreversible", recommendation: "r", safe_continuation: "s",
  })]), { brief: briefFor(smallRead) })
  assert.equal(human.ok, true, JSON.stringify(human.errors))
  // Without a ruling, the same small change cannot be agent-ready.
  const unresolved = await readTriageBasis({ deskRoot: small.deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { resolve: resolveIssue, prepared: [{ kind: "plan", path: "plans/none.md" }] } })
  const refused = validateTriageResultBytes(resultBytes([candidate(unresolved)]), { brief: briefFor(unresolved) })
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.errors.map((error) => error.code), ["triage_authority_unproved"])
})

test("missing_unreadable_or_incomplete_card_is_not_live", async () => {
  const { deskRoot, card } = await desk()
  const absent = await readTriageBasis({ deskRoot, personPrefix: "", key: "andon:example-org/example-repo#999", now: T0 })
  assert.equal(absent.state, "card_missing")
  assert.equal(absent.card, null)
  assert.equal(absent.basis.canonical_revision, null)
  assert.deepEqual(absent.authority.codes, ["investigation_only", "human_gate"])

  const truncated = await readTriageBasis({ deskRoot, personPrefix: "", key: "andon:example-org/example-repo#999", now: T0, readCards: async () => ({ cards: [], truncated: true, unreadable: false }) })
  assert.equal(truncated.state, "source_unknown", "a truncated read cannot prove removal")
  const folder = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0, readCards: async () => ({ cards: [], truncated: false, unreadable: true }) })
  assert.equal(folder.state, "source_unreadable")
  const badLocation = await readTriageBasis({ deskRoot, personPrefix: "../elsewhere", key: KEY, now: T0 })
  assert.equal(badLocation.state, "source_unreadable")
  assert.equal(badLocation.basis, null)

  // Bytes that change between the two reads around the canonical reader.
  const changing = await readTriageBasis({
    deskRoot, personPrefix: "", key: KEY, now: T0,
    readCards: async (args) => {
      const listing = await readCards(args)
      await fs.appendFile(card, "\n")
      return listing
    },
  })
  assert.equal(changing.state, "source_unknown")
  const read = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { resolve: resolveIssue } })

  // A card file that no longer parses is unreadable, not missing; the basis check reports the source as unknown.
  await fs.writeFile(card, "not a card\n")
  assert.equal((await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0 })).state, "source_unreadable")
  assert.deepEqual(await checkTriageBasis({ deskRoot, personPrefix: "", basis: read.basis, now: T0 }), { state: "source_unknown", reason: "source_incomplete" })
  // A card file replaced by a link is unreadable too (links need privileges on Windows).
  await fs.rename(card, `${card}.old`)
  if (process.platform !== "win32") {
    await fs.symlink(`${card}.old`, card)
    assert.equal((await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0 })).state, "source_unreadable")
    await fs.unlink(card)
  }
  assert.deepEqual(await checkTriageBasis({ deskRoot, personPrefix: "", basis: read.basis, now: T0 }), { state: "card_missing", reason: "card_removed" })

  // Changed card bytes make the reviewed basis stale.
  const other = await desk()
  const before = await readTriageBasis({ deskRoot: other.deskRoot, personPrefix: "", key: KEY, now: T0, evidence: { resolve: resolveIssue } })
  const text = await fs.readFile(other.card, "utf8")
  await fs.writeFile(other.card, text.replace(`evidence: ${JSON.stringify([ISSUE])}`, `evidence: ${JSON.stringify([ISSUE, "issue:example-org/example-repo#7"])}`))
  assert.deepEqual(await checkTriageBasis({ deskRoot: other.deskRoot, personPrefix: "", basis: before.basis, now: T0 }), { state: "stale", reason: "basis_changed" })
})

test("rulings_are_read_only_from_validated_desk_paths", async () => {
  const { deskRoot } = await desk({ prefix: "desks/ari" })
  assert.deepEqual(defaultRulingPaths("desks/ari"), ["AGENTS.md", "desks/ari/_meta/operator-rules.md"])
  assert.deepEqual(defaultRulingPaths(""), ["AGENTS.md", "_meta/operator-rules.md"])
  await fs.writeFile(path.join(deskRoot, "desks", "ari", "_meta", "operator-rules.md"), "Ask before spending.\n")
  const card = { key: KEY }
  const both = await readRulings({ deskRoot, personPrefix: "desks/ari", card, preparedEvidence: [{ kind: "ruling", path: "AGENTS.md" }] })
  assert.equal(both.state, "resolved")
  assert.deepEqual(both.refs.map((ref) => ref.id), ["AGENTS.md", "desks/ari/_meta/operator-rules.md"], "a repeated path is read once")
  assert.deepEqual(both.scope, { codes: ["existing_scope", "investigation_only", "human_gate"], plan_ids: [] })
  await fs.mkdir(path.join(deskRoot, "specs"))
  await fs.writeFile(path.join(deskRoot, "specs", "s.md"), "spec\n")
  assert.deepEqual((await readRulings({ deskRoot, personPrefix: "desks/ari", card })).refs.map((ref) => ref.id), ["AGENTS.md", "desks/ari/_meta/operator-rules.md"], "no prepared evidence: the defaults only")
  // A prepared non-plan ruling is part of the basis and is rechecked as a ruling.
  const withRuling = await readTriageBasis({ deskRoot, personPrefix: "desks/ari", key: KEY, now: T0, evidence: { prepared: [{ kind: "ruling", path: "specs/s.md" }], resolve: resolveIssue } })
  assert.deepEqual(withRuling.authority.codes, ["existing_scope", "investigation_only", "human_gate"])
  assert.deepEqual(await checkTriageBasis({ deskRoot, personPrefix: "desks/ari", basis: withRuling.basis, now: T0 }), { state: "current", reason: null })
  const spec = await readRulings({ deskRoot, personPrefix: "desks/ari", card, preparedEvidence: [{ kind: "spec", path: "specs/s.md" }] })
  assert.deepEqual(spec.scope.plan_ids, ["specs/s.md"])

  for (const preparedEvidence of [
    "plans/x.md", Array.from({ length: 17 }, () => ({ kind: "ruling", path: "AGENTS.md" })), [{ kind: "ruling", path: "../outside.md" }],
    [{ kind: "ruling", path: "/etc/passwd" }], [{ kind: "note", path: "AGENTS.md" }], [null], [{ kind: "ruling", path: "specs/../AGENTS.md" }],
  ]) {
    const refused = await readRulings({ deskRoot, personPrefix: "desks/ari", card, preparedEvidence })
    assert.equal(refused.state, "authority_unknown", JSON.stringify(preparedEvidence))
  }
  // A link anywhere on the path is not followed (links need privileges on Windows).
  if (process.platform !== "win32") {
    await fs.symlink(path.join(deskRoot, "specs"), path.join(deskRoot, "linked"))
    assert.equal((await readRulings({ deskRoot, personPrefix: "desks/ari", card, preparedEvidence: [{ kind: "ruling", path: "linked/s.md" }] })).state, "authority_unknown")
  }
  // An oversized ruling is not read.
  await fs.writeFile(path.join(deskRoot, "specs", "big.md"), Buffer.alloc(256 * 1024 + 1, 97))
  assert.equal((await readRulings({ deskRoot, personPrefix: "desks/ari", card, preparedEvidence: [{ kind: "ruling", path: "specs/big.md" }] })).state, "authority_unknown")
  // A permission fault while walking the path is unknown, not absent.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await fs.chmod(path.join(deskRoot, "specs"), 0o000)
    try {
      assert.equal((await readRulings({ deskRoot, personPrefix: "desks/ari", card, preparedEvidence: [{ kind: "ruling", path: "specs/s.md" }] })).state, "authority_unknown")
    } finally {
      await fs.chmod(path.join(deskRoot, "specs"), 0o700)
    }
  }

  for (const bad of ["", "a/../b", "/abs", "a\\b", "a//b", ".", "x".repeat(513), 7]) assert.equal(safeDeskPath(bad), null, String(bad))
  assert.equal(safeDeskPath("desks/ari/_meta/operator-rules.md"), "desks/ari/_meta/operator-rules.md")
  assert.equal(canonicalCardPath(deskRoot, "desks/ari", KEY), path.relative(deskRoot, cardFile(deskRoot, "desks/ari", KEY)).split(path.sep).join("/"))
  assert.equal(canonicalCardPath(deskRoot, "desks/ari", "not a key"), null)
})

test("unreadable_card_file_contents_are_unreadable", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX permissions" : false }, async () => {
  const { deskRoot, card } = await desk()
  await fs.chmod(card, 0o000)
  try {
    const read = await readTriageBasis({ deskRoot, personPrefix: "", key: KEY, now: T0 })
    assert.equal(read.state, "source_unreadable")
  } finally {
    await fs.chmod(card, 0o600)
  }
})
