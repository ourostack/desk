import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { scratch } from "./_session_helpers.js"
import { stableStringify } from "../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { readContributionAuthority, contributionPublisherFingerprint, checkedContributionAuthority } from "../../../../../plugins/desk/mcp/src/factory/contribution-authority.js"
import { readContributionFiles } from "../../../../../plugins/desk/mcp/src/factory/contribution-storage.js"
import { planSessionExclusion, applySessionExclusion, readContributionPolicy } from "../../../../../plugins/desk/mcp/src/factory/contribution-policy.js"

const api = await import("../../../../../plugins/desk/mcp/src/factory/contribution-index.js").catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {}
  throw error
})
const requireIndex = () => assert.equal(typeof api.commitContributionImages, "function", "authenticated contribution index is missing")
const sha = bytes => createHash("sha256").update(bytes).digest("hex")
const mac = (key, value) => createHmac("sha256", key).update(stableStringify(value)).digest("hex")
const seal = (key, value) => ({ ...value, seal: mac(key, value) })
const encode = value => `${JSON.stringify(value)}\n`
const STORE = "synthetic/proofs", SESSION = "12345678-1234-4123-8123-123456789abc", NONCE = "b".repeat(16)
async function fixture(ctx) {
  requireIndex()
  const root = join(ctx.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory")
  const intake = join(root, "contribution-control", "synthetic__proofs", NONCE)
  for (const dir of [join(intake, "receipts"), join(root, "locks"), join(root, "deriving"), join(root, "contribution-policy"),
    join(root, "markers"), join(root, "outbox", "synthetic__proofs")])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const key = Buffer.alloc(32, 7)
  const request = { store: STORE, host: "copilot-cli", session: SESSION, deskRoot: ctx.desk, personPrefix: "" }
  const marker = { schema_version: 1, host: request.host, session_id: SESSION,
    log_path: join(ctx.base, "never-read.jsonl"), cwd: ctx.desk, desk_root: ctx.desk, person_prefix: "",
    ended_at: null, end_reason: null, plugins: [{ name: "desk", version: "3.2.51" }],
    updated_at: "2026-11-02T00:00:00.000Z", routing: { store: STORE, source: "desk", warnings: [] } }
  const { updated_at: _time, ...content } = marker
  const facts = JSON.parse(await fs.readFile(new URL("./fixtures/local-golden.json", import.meta.url), "utf8"))
  facts.session.id = SESSION; facts.session.host = request.host
  const name = `${request.host}-${SESSION}.json`
  const write = (file, value) => fs.writeFile(file, encode(value), { mode: 0o600 })
  await fs.writeFile(join(root, "machine-secret"), key, { mode: 0o600 })
  await write(join(root, "consent.json"), { schema_version: 1, stores: { [STORE]: { contribute: true, account: "fixture", intake_id: NONCE } } })
  await write(join(root, "markers", name), marker)
  await write(join(root, "outbox", "synthetic__proofs", name), facts)
  await write(join(root, "status.json"), { last_flush: {}, derivations: { [name]: {
    desk_root: ctx.desk, store: STORE, checked_route: STORE, marker: sha(JSON.stringify(content)), binding_version: 8,
  } } })
  await write(join(intake, "qualification.json"), seal(key, {
    schema: "desk.factory.contribution-qualification/1", store: STORE, intake: NONCE,
    deskRoot: ctx.desk, personPrefix: "", protocol: 1, publisher: await contributionPublisherFingerprint(), storeWitness: "c".repeat(64),
  }))
  const read = () => readContributionAuthority(ctx.env, request, { platform: "linux" })
  const qualified = await read()
  assert.equal(qualified.result, "qualified")
  const authority = qualified.authority
  const scope = mac(key, { owner: authority.local.owner, store: STORE })
  const identity = { schema: "desk.factory.exclusion/1", ownerScope: scope, store: STORE, generation: 1 }
  const intentId = "d".repeat(64)
  const ledger = seal(key, { ...identity, exclusions: { [intentId]: {
    target: { host: request.host, session: SESSION }, localDigest: "e".repeat(64), observedRemoteDigest: "f".repeat(64),
    tokenHash: "1".repeat(64), generation: 1, revision: 0, remote: { state: "never_submitted" }, withdrawal: "not_needed", effects: [],
  } } })
  const activation = seal(key, identity)
  await write(join(intake, "index.json"), seal(key, { schema: "desk.factory.contribution-index/1", store: STORE,
    intake: NONCE, mode: "never_activated", generation: 0, revision: 0, owners: {}, transaction: null }))
  return { ...ctx, root, intake, key, request, authority, scope, intentId, ledger, activation, read, write }
}

test("ContributionIndex_AbsentIndexIsUnknownAndReadOnly", () => scratch(async ctx => {
  const f = await fixture(ctx)
  await fs.rename(join(f.intake, "index.json"), join(f.intake, "index.retained"))
  assert.equal((await api.readContributionIndex(f.authority)).state, "unavailable")
  await assert.rejects(fs.stat(join(f.intake, "index.json")), { code: "ENOENT" })
  await assert.rejects(fs.stat(join(f.root, "locks", "contribution-policy.lock")), { code: "ENOENT" })
}))

test("ContributionIndex_ActualCommitKeepsOneIntentAndGenerationOnRetry", () => scratch(async ctx => {
  const f = await fixture(ctx)
  const initial = await readContributionFiles(checkedContributionAuthority(f.authority).root,
    [{ role: "index" }, { role: "transaction" }, { role: "ledger" }, { role: "activation" }])
  assert.equal(initial.state, "ready", JSON.stringify(initial))
  assert.equal((await api.readContributionIndex(f.authority)).state, "ready", JSON.stringify(initial))
  const input = { ledger: f.ledger, activation: f.activation, intentId: f.intentId }
  const result = await api.commitContributionImages(f.authority, input)
  assert.equal(result.result, "committed")
  assert.equal(result.generation, 1)
  const retry = await api.commitContributionImages(f.authority, input)
  assert.equal(retry.result, "already_committed")
  assert.equal(retry.generation, 1)
  const current = await api.readContributionIndex(f.authority)
  assert.equal(current.state, "ready")
  assert.equal(current.index.generation, 1)
  assert.equal(current.index.revision, 1)
  assert.equal(current.index.owners[f.scope].generation, 1)
}))

for (const boundary of ["transaction.json", "index.json", ".active.json", `${"owner"}.json`]) {
  test(`ContributionIndex_InterruptedAfter${boundary}_ReadOnlyPendingAndAuthorizedRetryFinishesOnce`, t => scratch(async ctx => {
    const f = await fixture(ctx)
    const rename = fs.rename
    let interrupted = false
    const ends = boundary === "owner.json" ? `${f.scope}.json` : boundary
    const mock = t.mock.method(fs, "rename", async (...args) => {
      await rename(...args)
      if (!interrupted && args[1].endsWith(ends)) {
        interrupted = true
        throw Object.assign(new Error("synthetic crash after atomic replacement"), { code: "EIO" })
      }
    })
    const input = { ledger: f.ledger, activation: f.activation, intentId: f.intentId }
    try { assert.equal((await api.commitContributionImages(f.authority, input)).result, "storage_failed") }
    finally { mock.mock.restore() }
    assert.equal(interrupted, true)
    const before = await fs.readFile(join(f.intake, "transaction.json"))
    assert.equal((await api.readContributionIndex(f.authority)).state, "transaction_pending")
    assert.deepEqual(await fs.readFile(join(f.intake, "transaction.json")), before)
    const recovered = await api.reconcileContributionTransaction(f.authority)
    assert.equal(recovered.result, "committed")
    assert.equal(recovered.generation, 1)
    assert.equal((await api.commitContributionImages(f.authority, input)).result, "already_committed")
    assert.equal((await api.readContributionIndex(f.authority)).index.revision, 1)
  }))
}

test("ContributionIndex_ForeignChangedImageDuringPendingTransactionRefusesWithoutOverwriting", t => scratch(async ctx => {
  const f = await fixture(ctx)
  const rename = fs.rename
  let stopped = false
  const mock = t.mock.method(fs, "rename", async (...args) => {
    await rename(...args)
    if (!stopped && args[1].endsWith(".active.json")) {
      stopped = true
      throw Object.assign(new Error("synthetic stop"), { code: "EIO" })
    }
  })
  try { assert.equal((await api.commitContributionImages(f.authority, {
    ledger: f.ledger, activation: f.activation, intentId: f.intentId,
  })).result, "storage_failed") }
  finally { mock.mock.restore() }
  const file = join(f.root, "contribution-policy", `${f.scope}.active.json`)
  await fs.writeFile(file, "PRIVATE_SENTINEL foreign bytes", { mode: 0o600 })
  assert.equal((await api.reconcileContributionTransaction(f.authority)).result, "transaction_conflict")
  assert.equal(await fs.readFile(file, "utf8"), "PRIVATE_SENTINEL foreign bytes")
}))

test("ContributionIndex_UnbrandedAuthorityAndLostTransactionNeverManufactureLegacySuccess", () => scratch(async ctx => {
  const f = await fixture(ctx)
  assert.equal((await api.commitContributionImages(structuredClone(f.authority), {
    ledger: f.ledger, activation: f.activation, intentId: f.intentId,
  })).result, "ownership_unknown")
  await f.write(join(f.intake, "transaction.json"), { schema: "PRIVATE_SENTINEL" })
  assert.equal((await api.readContributionIndex(f.authority)).state, "unavailable")
  assert.equal((await api.reconcileContributionTransaction(f.authority)).result, "transaction_conflict")
}))

test("ContributionIndex_EffectRevisionDoesNotAdvanceEffectiveOwnerOrIntakeGeneration", () => scratch(async ctx => {
  const f = await fixture(ctx)
  assert.equal((await api.commitContributionImages(f.authority, {
    ledger: f.ledger, activation: f.activation, intentId: f.intentId,
  })).result, "committed")
  const { seal: _seal, ...value } = structuredClone(f.ledger)
  value.exclusions[f.intentId].revision = 1
  value.exclusions[f.intentId].remote = { state: "unknown" }
  value.exclusions[f.intentId].withdrawal = "unknown"
  value.exclusions[f.intentId].effects = [{ remote: { state: "unknown" }, withdrawal: "unknown" }]
  assert.equal((await api.commitContributionImages(f.authority, {
    ledger: seal(f.key, value), activation: f.activation, intentId: f.intentId,
  })).result, "committed")
  const read = await api.readContributionIndex(f.authority)
  assert.equal(read.index.revision, 2)
  assert.equal(read.index.generation, 1)
  assert.equal(read.index.owners[f.scope].generation, 1)
}))

test("ContributionIndex_NativeAuthorityCannotErasePreviouslyExcludedIntentThroughImages", () => scratch(async ctx => {
  const f = await fixture(ctx)
  await api.commitContributionImages(f.authority, { ledger: f.ledger, activation: f.activation, intentId: f.intentId })
  const before = await fs.readFile(join(f.intake, "index.json"))
  const { seal: _seal, ...value } = structuredClone(f.ledger)
  const replacement = "2".repeat(64)
  value.generation = 2
  value.exclusions = { [replacement]: { ...value.exclusions[f.intentId], generation: 2 } }
  const { seal: _activationSeal, ...active } = f.activation
  const result = await api.commitContributionImages(f.authority, {
    ledger: seal(f.key, value), activation: seal(f.key, { ...active, generation: 2 }), intentId: replacement,
  })
  assert.equal(result.result, "invalid_images")
  assert.deepEqual(await fs.readFile(join(f.intake, "index.json")), before)
}))

test("ContributionIndex_UnsafeReadReturnsExplicitUnavailableNotThrow", () => scratch(async ctx => {
  const f = await fixture(ctx)
  await fs.chmod(join(f.intake, "index.json"), 0o644)
  let result
  await assert.doesNotReject(async () => { result = await api.readContributionIndex(f.authority) })
  assert.equal(result.state, "unavailable")
  assert.equal((await fs.stat(join(f.intake, "index.json"))).mode & 0o777, 0o644)
}))

test("ContributionIndex_FinalIndexResponseLostRecoversWithoutReplayingOwnerWrites", t => scratch(async ctx => {
  const f = await fixture(ctx)
  const rename = fs.rename
  let indexWrites = 0
  const mock = t.mock.method(fs, "rename", async (...args) => {
    await rename(...args)
    if (args[1] === join(f.intake, "index.json") && ++indexWrites === 2)
      throw Object.assign(new Error("synthetic final index response lost"), { code: "EIO" })
  })
  try {
    assert.equal((await api.commitContributionImages(f.authority, {
      ledger: f.ledger, activation: f.activation, intentId: f.intentId,
    })).result, "storage_failed")
  } finally { mock.mock.restore() }
  const ledgerFile = join(f.root, "contribution-policy", `${f.scope}.json`)
  const original = await fs.stat(ledgerFile)
  assert.equal((await api.reconcileContributionTransaction(f.authority)).result, "committed")
  assert.equal((await fs.stat(ledgerFile)).ctimeMs, original.ctimeMs)
  assert.equal((await api.readContributionIndex(f.authority)).index.generation, 1)
}))

test("ContributionIndex_SecondOwnerChangeAdvancesIntakeInsteadOfTakingMaximumOwnerGeneration", () => scratch(async ctx => {
  const f = await fixture(ctx)
  await api.commitContributionImages(f.authority, { ledger: f.ledger, activation: f.activation, intentId: f.intentId })
  const request = { ...f.request, session: "87654321-1234-4123-8123-123456789abc", personPrefix: "desks/other" }
  const name = `${request.host}-${request.session}.json`
  const marker = JSON.parse(await fs.readFile(join(f.root, "markers", `${f.request.host}-${SESSION}.json`)))
  marker.session_id = request.session; marker.person_prefix = request.personPrefix
  const { updated_at: _time, ...content } = marker
  const facts = JSON.parse(await fs.readFile(join(f.root, "outbox", "synthetic__proofs", `${f.request.host}-${SESSION}.json`)))
  facts.session.id = request.session
  await f.write(join(f.root, "markers", name), marker)
  await f.write(join(f.root, "outbox", "synthetic__proofs", name), facts)
  const status = JSON.parse(await fs.readFile(join(f.root, "status.json")))
  status.derivations[name] = { ...Object.values(status.derivations)[0], marker: sha(JSON.stringify(content)) }
  await f.write(join(f.root, "status.json"), status)
  await f.write(join(f.intake, "qualification.json"), seal(f.key, {
    schema: "desk.factory.contribution-qualification/1", store: STORE, intake: NONCE,
    protocol: 1, publisher: await contributionPublisherFingerprint(), storeWitness: "c".repeat(64),
  }))
  const checked = await readContributionAuthority(f.env, request, { platform: "linux" })
  assert.equal(checked.result, "qualified")
  const secondScope = mac(f.key, { owner: checked.authority.local.owner, store: STORE })
  const { seal: _seal, ...ledger } = structuredClone(f.ledger)
  ledger.ownerScope = secondScope; ledger.exclusions[f.intentId].target.session = request.session
  const { seal: _activeSeal, ...activation } = f.activation
  const result = await api.commitContributionImages(checked.authority, {
    ledger: seal(f.key, ledger), activation: seal(f.key, { ...activation, ownerScope: secondScope }), intentId: f.intentId,
  })
  assert.equal(result.result, "committed")
  assert.equal(result.generation, 2)
  const read = await api.readContributionIndex(checked.authority)
  assert.equal(read.index.owners[f.scope].generation, 1)
  assert.equal(read.index.owners[secondScope].generation, 1)
  assert.equal((await api.readContributionIndex(f.authority)).state, "ready")
}))

test("ContributionIndex_StoredAuthorityRevokedAfterQualificationIsNotReusableAdmission", () => scratch(async ctx => {
  const f = await fixture(ctx)
  await f.write(join(f.root, "consent.json"), { schema_version: 1, stores: { [STORE]: { contribute: false, intake_id: NONCE } } })
  assert.equal((await api.readContributionIndex(f.authority)).state, "unavailable")
  assert.notEqual((await api.commitContributionImages(f.authority, {
    ledger: f.ledger, activation: f.activation, intentId: f.intentId,
  })).result, "committed")
  await assert.rejects(fs.stat(join(f.intake, "transaction.json")), { code: "ENOENT" })
}))

test("ContributionIndex_PolicyUsesActualAuthorityAndIndexTransactionWithoutReadSideEffects", () => scratch(async ctx => {
  const f = await fixture(ctx)
  const dependencies = { platform: "linux", readAuthority: async () => (await f.read()).authority,
    observeRemote: async () => ({ state: "unknown" }) }
  const originalIndex = await fs.readFile(join(f.intake, "index.json"))
  const plan = await planSessionExclusion(f.env, f.request, dependencies)
  assert.equal(plan.result, "planned")
  assert.deepEqual(await fs.readFile(join(f.intake, "index.json")), originalIndex)
  await assert.rejects(fs.stat(join(f.root, "locks", "contribution-policy.lock")), { code: "ENOENT" })
  const applied = await applySessionExclusion(f.env, { request: f.request, expectedPlan: plan.planToken }, dependencies)
  assert.equal(applied.result, "excluded")
  assert.equal(applied.generation, 1)
  const retry = await applySessionExclusion(f.env, { request: f.request, expectedPlan: plan.planToken }, dependencies)
  assert.equal(retry.result, "already_excluded")
  assert.equal(retry.intentId, applied.intentId)
  assert.equal((await api.readContributionIndex(f.authority)).index.generation, 1)
  const policy = await readContributionPolicy(f.env, f.request, dependencies)
  assert.equal(policy.state, "ready")
  assert.equal(Object.keys(policy.exclusions).length, 1)
}))

test("ContributionIndex_PolicyRetryCompletesItsAuthenticatedInterruptedIntentOnce", t => scratch(async ctx => {
  const f = await fixture(ctx)
  const dependencies = { platform: "linux", readAuthority: async () => (await f.read()).authority,
    observeRemote: async () => ({ state: "unknown" }) }
  const plan = await planSessionExclusion(f.env, f.request, dependencies)
  assert.equal(plan.result, "planned")
  const rename = fs.rename
  let stopped = false
  const mock = t.mock.method(fs, "rename", async (...args) => {
    await rename(...args)
    if (!stopped && args[1].endsWith(".active.json")) {
      stopped = true
      throw Object.assign(new Error("synthetic interrupted policy transaction"), { code: "EIO" })
    }
  })
  const input = { request: f.request, expectedPlan: plan.planToken }
  try { assert.equal((await applySessionExclusion(f.env, input, dependencies)).result, "storage_failed") }
  finally { mock.mock.restore() }
  const pending = await fs.readFile(join(f.intake, "transaction.json"))
  assert.equal((await planSessionExclusion(f.env, f.request, dependencies)).result, "policy_unavailable")
  assert.deepEqual(await fs.readFile(join(f.intake, "transaction.json")), pending)
  const retry = await applySessionExclusion(f.env, input, dependencies)
  assert.equal(retry.result, "already_excluded")
  assert.equal(retry.generation, 1)
  assert.equal((await api.readContributionIndex(f.authority)).index.generation, 1)
}))

test("ContributionIndex_CheckedAuthorityFailureNeverSelectsHistoricalInertFallback", () => scratch(async ctx => {
  const f = await fixture(ctx)
  const dependencies = { platform: "linux", readAuthority: async () => f.authority, trusted: true }
  const plan = await planSessionExclusion(f.env, f.request, dependencies)
  assert.equal(plan.result, "planned")
  await fs.rename(join(f.intake, "index.json"), join(f.intake, "index.retained"))
  assert.equal((await planSessionExclusion(f.env, f.request, dependencies)).result, "policy_unavailable")
  assert.equal((await applySessionExclusion(f.env, {
    request: f.request, expectedPlan: plan.planToken,
  }, dependencies)).result, "policy_unavailable")
  await assert.rejects(fs.stat(join(f.root, "contribution-policy", `${f.scope}.json`)), { code: "ENOENT" })
  await assert.rejects(fs.stat(join(f.intake, "transaction.json")), { code: "ENOENT" })
}))

test("ContributionIndex_DefaultPolicyCannotReceiveTrustedBranchFromCallerFlags", () => scratch(async ctx => {
  const f = await fixture(ctx)
  const before = await fs.readFile(join(f.intake, "index.json"))
  const result = await planSessionExclusion(f.env, f.request, {
    platform: "linux", trusted: true, authority: f.authority, ownerScope: f.scope,
  })
  assert.equal(result.result, "ownership_unknown")
  assert.deepEqual(await fs.readFile(join(f.intake, "index.json")), before)
}))

test("ContributionIndex_ReceiptBoundToAnotherIndexRevisionCannotAuthorizeMutation", () => scratch(async ctx => {
  const f = await fixture(ctx)
  await api.commitContributionImages(f.authority, { ledger: f.ledger, activation: f.activation, intentId: f.intentId })
  const index = JSON.parse(await fs.readFile(join(f.intake, "index.json")))
  delete index.seal
  index.revision += 1
  await f.write(join(f.intake, "index.json"), seal(f.key, index))
  const before = await fs.readFile(join(f.intake, "transaction.json"))
  const { seal: _seal, ...ledger } = structuredClone(f.ledger)
  ledger.exclusions[f.intentId].revision = 1
  ledger.exclusions[f.intentId].effects = [{ remote: { state: "never_submitted" }, withdrawal: "not_needed" }]
  const result = await api.commitContributionImages(f.authority, {
    ledger: seal(f.key, ledger), activation: f.activation, intentId: f.intentId,
  })
  assert.equal(result.result, "policy_unavailable")
  assert.deepEqual(await fs.readFile(join(f.intake, "transaction.json")), before)
}))
