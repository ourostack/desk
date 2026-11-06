import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { scratch } from "./_session_helpers.js"
import { stableStringify } from "../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"

const api = await import("../../../../../plugins/desk/mcp/src/factory/contribution-authority.js").catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {}
  throw error
})
const sha = bytes => createHash("sha256").update(bytes).digest("hex")
const seal = (key, value) => ({ ...value, seal: createHmac("sha256", key).update(stableStringify(value)).digest("hex") })
const requireAuthority = () => assert.equal(typeof api.readContributionAuthority, "function", "source-owned authority reader is missing")
const STORE = "synthetic/proofs", SESSION = "12345678-1234-4123-8123-123456789abc", INTAKE = "b".repeat(16)

async function fixture(ctx) {
  requireAuthority()
  const root = join(ctx.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory")
  const intake = join(root, "contribution-control", "synthetic__proofs", INTAKE)
  for (const dir of [intake, join(root, "markers"), join(root, "outbox", "synthetic__proofs")])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const key = Buffer.alloc(32, 7)
  const request = { store: STORE, host: "copilot-cli", session: SESSION, deskRoot: ctx.desk, personPrefix: "" }
  const marker = {
    schema_version: 1, host: request.host, session_id: SESSION, log_path: join(ctx.base, "never-read.jsonl"),
    cwd: ctx.desk, desk_root: ctx.desk, person_prefix: "", ended_at: null, end_reason: null,
    plugins: [{ name: "desk", version: "3.2.51" }], updated_at: "2026-11-02T00:00:00.000Z",
    routing: { store: STORE, source: "desk", warnings: [] },
  }
  const { updated_at: _time, ...content } = marker
  const facts = JSON.parse(await fs.readFile(new URL("./fixtures/local-golden.json", import.meta.url), "utf8"))
  facts.session.id = SESSION
  facts.session.host = request.host
  const name = `${request.host}-${SESSION}.json`
  const write = (file, value) => fs.writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await fs.writeFile(join(root, "machine-secret"), key, { mode: 0o600 })
  await write(join(root, "consent.json"), { schema_version: 1, stores: { [STORE]: { contribute: true, account: "fixture", intake_id: INTAKE } } })
  await write(join(root, "markers", name), marker)
  await write(join(root, "outbox", "synthetic__proofs", name), facts)
  await write(join(root, "status.json"), { last_flush: {}, derivations: { [name]: {
    desk_root: ctx.desk, store: STORE, checked_route: STORE, marker: sha(JSON.stringify(content)), binding_version: 8,
  } } })
  const witness = seal(key, { schema: "desk.factory.contribution-qualification/1", store: STORE, intake: INTAKE,
    deskRoot: ctx.desk, personPrefix: "", protocol: 1, publisher: await api.contributionPublisherFingerprint(),
    storeWitness: "c".repeat(64) })
  await write(join(intake, "qualification.json"), witness)
  return { ...ctx, root, intake, key, request, marker, name, write, witness }
}

test("ContributionAuthority_ActualStoredChainProducesCheckedAuthorityWithoutWrites", () => scratch(async ctx => {
  const f = await fixture(ctx)
  const before = await fs.stat(join(f.root, "machine-secret"))
  const result = await api.readContributionAuthority(f.env, f.request, { platform: "linux" })
  assert.equal(result.result, "qualified")
  assert.equal(result.authority.local.target.session, SESSION)
  assert.equal(result.authority.local.owner.deskRoot, f.desk)
  assert.equal(api.checkedContributionAuthority(structuredClone(result.authority)), null)
  assert.ok(api.checkedContributionAuthority(result.authority))
  assert.equal((await fs.stat(join(f.root, "machine-secret"))).ctimeMs, before.ctimeMs)
  await assert.rejects(fs.stat(f.marker.log_path), { code: "ENOENT" })
}))

for (const fault of ["secret_missing", "consent_false", "marker_only", "foreign_owner", "wrong_session", "witness_seal", "publisher_changed"]) {
  test(`ContributionAuthority_${fault}RefusesNoRepairOrPermissiveGrant`, () => scratch(async ctx => {
    const f = await fixture(ctx)
    if (fault === "secret_missing") await fs.rename(join(f.root, "machine-secret"), join(f.root, "secret.retained"))
    if (fault === "consent_false") await f.write(join(f.root, "consent.json"), { schema_version: 1, stores: { [STORE]: { contribute: false, intake_id: INTAKE } } })
    if (fault === "marker_only") await fs.rename(join(f.root, "status.json"), join(f.root, "status.retained"))
    if (fault === "foreign_owner") f.request.deskRoot = join(ctx.base, "foreign")
    if (fault === "wrong_session") f.request.session = "87654321-1234-4123-8123-123456789abc"
    if (fault === "witness_seal") await f.write(join(f.intake, "qualification.json"), { ...f.witness, storeWitness: "e".repeat(64) })
    if (fault === "publisher_changed") {
      const { seal: _seal, ...witness } = f.witness
      await f.write(join(f.intake, "qualification.json"), seal(f.key, { ...witness, publisher: "e".repeat(64) }))
    }
    const result = await api.readContributionAuthority(f.env, f.request, { platform: "linux" })
    assert.notEqual(result.result, "qualified")
    assert.equal(result.authority, undefined)
    assert.ok(!JSON.stringify(result).includes(SESSION))
    assert.ok(!JSON.stringify(result).includes(f.desk))
  }))
}

test("ContributionAuthority_AbsentRootAndUnsupportedPlatformDoNotCreateOrFabricateAuthority", () => scratch(async ctx => {
  requireAuthority()
  const request = { store: STORE, host: "copilot-cli", session: SESSION, deskRoot: ctx.desk, personPrefix: "" }
  assert.equal((await api.readContributionAuthority(ctx.env, request, { platform: "linux" })).result, "ownership_unknown")
  assert.equal((await api.readContributionAuthority(ctx.env, request, { platform: "win32" })).result, "platform_unqualified")
  await assert.rejects(fs.stat(ctx.env.XDG_STATE_HOME), { code: "ENOENT" })
}))

test("ContributionAuthority_ClosedPrivateRequestReadsOnceWithoutCreatingState", () => scratch(async ctx => {
  requireAuthority()
  assert.equal(typeof api.readContributionRequest, "function", "private request reader is missing")
  const request = { store: STORE, host: "copilot-cli", session: SESSION, deskRoot: ctx.desk, personPrefix: "" }
  const directory = join(ctx.base, "private-request")
  await fs.mkdir(directory, { mode: 0o700 })
  const file = join(directory, "request.json")
  await fs.writeFile(file, `${JSON.stringify(request)}\n`, { mode: 0o600 })
  const before = await fs.stat(file)
  const result = await api.readContributionRequest(file, { platform: "linux" })
  assert.equal(result.result, "request_read")
  assert.deepEqual(result.request, request)
  assert.equal((await fs.stat(file)).ctimeMs, before.ctimeMs)
  await assert.rejects(fs.stat(ctx.env.XDG_STATE_HOME), { code: "ENOENT" })
}))

for (const fault of ["extra_field", "malformed", "symlink", "linked", "unsafe_mode", "oversized"]) {
  test(`ContributionAuthority_PrivateRequest${fault}RefusesWithoutEchoOrRepair`, () => scratch(async ctx => {
    requireAuthority()
    assert.equal(typeof api.readContributionRequest, "function", "private request reader is missing")
    const request = { store: STORE, host: "copilot-cli", session: SESSION, deskRoot: ctx.desk, personPrefix: "" }
    const directory = join(ctx.base, "private-request")
    await fs.mkdir(directory, { mode: 0o700 })
    const file = join(directory, "request.json")
    await fs.writeFile(file, fault === "malformed" ? "PRIVATE_SENTINEL" : fault === "oversized" ? " ".repeat(16385) :
      JSON.stringify(fault === "extra_field" ? { ...request, PRIVATE_SENTINEL: true } : request), { mode: 0o600 })
    if (fault === "symlink") { await fs.rename(file, `${file}.retained`); await fs.symlink(`${file}.retained`, file) }
    if (fault === "linked") await fs.link(file, `${file}.retained`)
    if (fault === "unsafe_mode") await fs.chmod(file, 0o644)
    const before = await fs.lstat(file)
    const result = await api.readContributionRequest(file, { platform: "linux" })
    assert.equal(result.result, "invalid_request")
    assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"))
    assert.equal((await fs.lstat(file)).mode, before.mode)
  }))
}

test("ContributionAuthority_SourcePathChangedAfterHeldReadRefusesCompatibility", t => scratch(async ctx => {
  const f = await fixture(ctx)
  const lstat = fs.lstat
  t.mock.method(fs, "lstat", async (...args) => {
    const stat = await lstat(...args)
    if (String(args[0]).endsWith("/contribution-authority.js")) return new Proxy(stat, {
      get(target, name) {
        if (name === "ino") return typeof target.ino === "bigint" ? target.ino + 1n : target.ino + 1
        const value = Reflect.get(target, name)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    return stat
  })
  const result = await api.readContributionAuthority(f.env, f.request, { platform: "linux" })
  assert.equal(result.result, "compatibility_unqualified")
}))

for (const person of [undefined, "", "desks/other"]) {
  test(`AIX1_ExplicitPersonLineage_${person === undefined ? "missing" : person === "" ? "root" : "member"}`, () => scratch(async ctx => {
    const f = await fixture(ctx)
    if (person === undefined) delete f.marker.person_prefix
    else { f.marker.person_prefix = person; f.request.personPrefix = person }
    const { updated_at: _time, ...content } = f.marker
    await f.write(join(f.root, "markers", f.name), f.marker)
    const status = JSON.parse(await fs.readFile(join(f.root, "status.json")))
    status.derivations[f.name].marker = sha(JSON.stringify(content))
    await f.write(join(f.root, "status.json"), status)
    const { seal: _seal, ...witness } = f.witness
    await f.write(join(f.intake, "qualification.json"), seal(f.key, {
      ...witness, personPrefix: f.request.personPrefix,
    }))
    const before = await fs.readFile(join(f.root, "status.json"))
    const result = await api.readContributionAuthority(f.env, f.request, { platform: "linux" })
    assert.equal(result.result, person === undefined ? "ownership_unknown" : "qualified")
    assert.deepEqual(await fs.readFile(join(f.root, "status.json")), before)
    if (person === undefined) assert.equal(result.authority, undefined)
    else {
      const foreign = await api.readContributionAuthority(f.env, {
        ...f.request, personPrefix: person === "" ? "desks/foreign" : "",
      }, { platform: "linux" })
      assert.equal(foreign.result, "ownership_unknown")
      assert.ok(!JSON.stringify(foreign).includes(f.desk))
    }
  }))
}
