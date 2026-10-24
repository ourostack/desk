import { test } from "node:test"
import assert from "node:assert/strict"
import fsNative from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { link, mkdtemp, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { readStatus, serializeTaskContext, setConsent, taskContextPath, updateStatus, updateTaskContextState, writeTaskContextFile } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { contextPayloadHash } from "../../../../../plugins/desk/mcp/src/factory/context-schema.js"
import { contextFacts, contextRecord, CONTEXT_JOB } from "./_context_fixture.js"
import { osEnv } from "../_os_env.js"

const queue = await import("../../../../../plugins/desk/mcp/src/factory/context-outbox.js").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return null
  throw error
})
const STORE = "ourostack/factory"
const VERSION = "3.2.0-alpha.1"
const json = (value) => `${JSON.stringify(value)}\n`
async function fixture({ prose = true, contribute = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desk-context-queue-")))
  const env = osEnv({ HOME: root, XDG_STATE_HOME: join(root, "state") })
  const desk = join(root, "desk")
  await mkdir(join(desk, "_meta"), { recursive: true })
  await writeFile(join(desk, "_meta", "factory.json"), json({ schema_version: 1, store: STORE }))
  if (prose) await writeFile(join(desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: true } }))
  await setConsent(env, { store: STORE, contribute, account: "synthetic" })
  const facts = contextFacts()
  const log = join(root, "session.jsonl")
  await writeFile(log, '{"synthetic":"private evidence"}\n')
  const entries = [{ facts, deskRoot: desk, personPrefix: "", localJobs: [{ local: CONTEXT_JOB, published: CONTEXT_JOB }], logPath: log, clockOrigin: "2026-10-01T00:00:00.000Z" }]
  return { env, root, desk, facts, entries, options: { store: STORE, entries, pluginVersion: VERSION, clock: () => 0 } }
}
async function prepared() {
  const f = await fixture()
  await queue.prepareTaskContexts(f.env, f.options)
  const [work] = await queue.listContextWork(f.env, { store: STORE })
  return { ...f, work }
}
async function cardFixture() {
  const f = await fixture()
  const git = (...args) => execFileSync("git", args, { cwd: f.desk, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const remote = "https://github.com/synthetic/desk.git"
  git("init", "-qb", "main")
  git("config", "user.email", "16390116+arimendelow@users.noreply.github.com")
  git("config", "user.name", "Context Test")
  git("config", "commit.gpgsign", "false")
  git("remote", "add", "origin", remote)
  const card = join(f.desk, "sample", "safe", "task.md")
  await mkdir(join(f.desk, "sample", "safe"), { recursive: true })
  const original = "---\nstatus: done\ncreated: '2026-10-01T00:00:00Z'\nupdated: '2026-10-02T00:00:00Z'\n---\nPrivate source: waiting for a software update.\n"
  await writeFile(card, original)
  git("add", "sample")
  git("commit", "-qm", "task")
  const job = jobId({ deskRemote: remote, personPrefix: "", track: "sample", slug: "safe" })
  f.facts.jobs[0].job = job
  f.facts.outcomes[0].job = job
  f.entries[0].localJobs = [{ local: job, published: job }]
  return { ...f, job, card, original }
}
async function withFsFault(t, overrides, body, target = fsNative) {
  for (const [name, override] of Object.entries(overrides)) {
    const original = target[name]
    const wrapped = (...args) => override(original.bind(target), ...args)
    if (Object.hasOwn(original, "native")) Object.defineProperty(wrapped, "native", Object.getOwnPropertyDescriptor(original, "native"))
    t.mock.method(target, name, wrapped)
  }
  syncBuiltinESMExports()
  try { return await body() } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}
const candidate = (facts, job = CONTEXT_JOB) => ({ ...contextRecord(facts, job), privacy: null })
async function acceptedCandidate(f) {
  return queue.acceptContextCandidate(f.env, { store: STORE, job: f.work.job, basis: f.work.basis, bytes: json(candidate(f.facts, f.work.job)) })
}
const review = (hash, verdict = "approved") => ({
  schema: "desk.factory.context-review/1", verdict, payload_sha256: hash,
  reviewer: { plugin_version: VERSION, rubric: "1" }, reason: verdict === "approved" ? "safe" : "sensitive",
})
const capabilityClient = { api: async () => ({
  status: 200, json: { type: "file", encoding: "base64", content: Buffer.from('{"task_context":1}').toString("base64") },
}) }
async function reviewed() {
  const f = await prepared()
  const accepted = await acceptedCandidate(f)
  assert.equal((await queue.acceptContextPrivacy(f.env, {
    store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)),
  })).result, "context_accepted")
  const plan = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  assert.equal(plan.ready.length, 1)
  return { ...f, plan, item: plan.ready[0] }
}
async function reviewedJobs(count) {
  const f = await reviewed()
  for (let index = 0; index < count - 1; index += 1) {
    const job = String(index).repeat(32)
    const entry = structuredClone(f.entries[0])
    entry.facts.session.id = `${String(index).padStart(8, "0")}-1234-4abc-8abc-123456789abc`
    entry.facts.jobs[0].job = job
    entry.facts.outcomes[0].job = job
    entry.localJobs = [{ local: job, published: job }]
    f.entries.push(entry)
    await queue.prepareTaskContexts(f.env, f.options)
    const work = (await queue.listContextWork(f.env, { store: STORE })).find((item) => item.job === job)
    const accepted = await queue.acceptContextCandidate(f.env, {
      store: STORE, job, basis: work.basis, bytes: json(candidate(entry.facts, job)),
    })
    assert.equal((await queue.acceptContextPrivacy(f.env, {
      store: STORE, job, basis: work.basis, bytes: json(review(accepted.payload_sha256)),
    })).result, "context_accepted")
  }
  return f
}
async function online(f, changes = {}) {
  return queue.prepareContextPublication(f.env, { store: STORE, plan: f.plan, client: capabilityClient,
    direct: true, ref: "main", now: 1000, readMain: async () => ({ blobs: new Map(), unknown: false }), ...changes })
}
async function storedState(f) {
  return JSON.parse(await readFile(await taskContextPath(f.env, STORE, f.work.job, "state.json"), "utf8"))
}
async function nextGeneration(f) {
  const before = await storedState(f)
  f.facts.session.duration_ms += 1
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 1)
  const after = await storedState(f)
  assert.notEqual(after.basis, before.basis)
  const file = await taskContextPath(f.env, STORE, f.work.job, "state.json")
  await writeFile(file, json(before))
  return { file, before, after }
}
async function atStateLock(t, f, replacement, body) {
  const file = await taskContextPath(f.env, STORE, f.work.job, "state.json")
  let changed = false
  await withFsFault(t, { open: (original, target, ...args) => {
    if (String(target) === `${file}.lock` && !changed) {
      changed = true
      fsNative.writeFileSync(file, json(replacement))
    }
    return original(target, ...args)
  } }, body, fsNative.promises)
  assert.equal(changed, true, "the concurrent state change must occur before the real atomic update")
}

test("numeric-only consent and an absent prose policy prepare no task context", async () => {
  assert.ok(queue, "the context queue is not implemented")
  for (const options of [{ prose: false }, { contribute: false }]) {
    const f = await fixture(options)
    assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 0)
    assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
  }
})

test("only an exact regular per-desk store policy authorizes prose", async () => {
  assert.ok(queue)
  const f = await fixture({ prose: false })
  const policy = join(f.desk, "_meta", "factory-context.json")
  assert.equal(queue.contextPermission(f.desk, STORE), "not_opted_in")
  await writeFile(policy, json({ schema_version: 1, stores: { [STORE]: true }, SENTINEL: "private" }))
  assert.equal(queue.contextPermission(f.desk, STORE), "policy_invalid")
  const linked = await fixture({ prose: false })
  const target = join(linked.root, "policy.json")
  await writeFile(target, json({ schema_version: 1, stores: { [STORE]: true } }))
  await symlink(target, join(linked.desk, "_meta", "factory-context.json"))
  assert.equal(queue.contextPermission(linked.desk, STORE), "policy_invalid")
})

test("prose permission refuses invalid roots, malformed policies, oversized files and hard links", async () => {
  const f = await fixture()
  for (const root of [null, "relative", []]) assert.equal(queue.contextPermission(root, STORE), "policy_invalid")
  assert.equal(queue.contextPermission(f.desk, "invalid-store"), "policy_invalid")
  assert.equal(queue.contextPermission(join(f.root, "missing"), STORE), "not_opted_in")
  const policy = join(f.desk, "_meta", "factory-context.json")
  for (const value of ["{", " ".repeat(16385), json(null), json([]), json({ schema_version: 2, stores: {} }),
    json({ schema_version: 1, stores: [] }), json({ schema_version: 1, stores: { "invalid-store": true } }),
    json({ schema_version: 1, stores: { [STORE]: "yes" } })]) {
    await writeFile(policy, value)
    assert.equal(queue.contextPermission(f.desk, STORE), "policy_invalid")
  }
  await writeFile(policy, json({ schema_version: 1, stores: { [STORE]: true } }))
  await link(policy, join(f.root, "policy-preserved.json"))
  assert.equal(queue.contextPermission(f.desk, STORE), "policy_invalid")
  const other = await fixture()
  await rename(join(other.desk, "_meta"), join(other.desk, "_meta-preserved"))
  await writeFile(join(other.desk, "_meta"), "not a directory")
  assert.equal(queue.contextPermission(other.desk, STORE), "policy_invalid")
})

test("invalid mappings are ignored and ambiguous local or desk identities cannot merge source groups", async () => {
  const f = await fixture()
  const entry = f.entries[0]
  assert.equal((await queue.prepareTaskContexts(f.env, {
    ...f.options, entries: [{ ...entry, facts: {} }],
  })).prepared, 0)
  assert.equal((await queue.prepareTaskContexts(f.env, {
    ...f.options, entries: [{ ...entry, localJobs: [{ local: "invalid", published: CONTEXT_JOB },
      { local: CONTEXT_JOB, published: "f".repeat(32) }] }],
  })).prepared, 0)
  for (const other of [
    { ...entry, localJobs: [{ local: "f".repeat(32), published: CONTEXT_JOB }] },
    { ...entry, deskRoot: (await fixture()).desk },
  ]) await assert.rejects(queue.prepareTaskContexts(f.env, { ...f.options, entries: [entry, other] }), /context_identity_ambiguous/u)
})

test("duplicate or more than 512 session sources stay held rather than creating partial context input", async () => {
  const f = await fixture()
  const original = f.entries[0]
  const duplicate = await queue.prepareTaskContexts(f.env, { ...f.options, entries: [original, structuredClone(original)] })
  assert.equal(duplicate.held, 1)
  assert.equal(duplicate.prepared, 0)
  const entries = Array.from({ length: 513 }, (_, index) => {
    const entry = structuredClone(original)
    entry.facts.session.id = `${index.toString(16).padStart(8, "0")}-1234-4abc-8abc-123456789abc`
    return entry
  })
  const oversized = await queue.prepareTaskContexts(f.env, { ...f.options, entries })
  assert.equal(oversized.held, 1)
  assert.equal(oversized.prepared, 0)
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
})

test("the complete readable private input is held when bounded individual sources exceed the aggregate byte limit", async () => {
  const f = await fixture()
  const entries = Array.from({ length: 192 }, (_, index) => {
    const entry = structuredClone(f.entries[0])
    entry.facts.session.id = `${index.toString(16).padStart(8, "0")}-1234-4abc-8abc-123456789abc`
    entry.facts.intervals = Array.from({ length: 1000 }, (_, n) => ({ kind: "turn", agent: 0, start_ms: n * 1000, end_ms: (n + 1) * 1000 }))
    return entry
  })
  assert.ok(Buffer.byteLength(serializeTaskContext({ sources: entries.map((entry) => entry.facts) })) > 16 * 1024 * 1024)
  const result = await queue.prepareTaskContexts(f.env, { ...f.options, entries })
  assert.equal(result.held, 1)
  assert.equal(result.prepared, 0)
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
})

test("malformed state and input bytes are explicit failures while invalid input shapes remain held", async () => {
  const f = await prepared()
  const stateFile = await taskContextPath(f.env, STORE, CONTEXT_JOB, "state.json")
  const state = await readFile(stateFile, "utf8")
  await writeFile(stateFile, "{")
  await assert.rejects(queue.listContextWork(f.env, { store: STORE }), /context_state_invalid/u)
  await writeFile(stateFile, state)
  const input = JSON.parse(await readFile(f.work.input, "utf8"))
  await writeFile(f.work.input, "{")
  await assert.rejects(queue.listContextWork(f.env, { store: STORE }), /context_input_invalid/u)
  for (const value of [null, [], { ...input, schema: "other" }, { ...input, job: "f".repeat(32) },
    { ...input, basis: "f".repeat(64) }, { ...input, sources: null }, { ...input, private_evidence: null },
    { ...input, store: "other/store" }]) {
    await writeFile(f.work.input, json(value))
    assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
  }
})

test("malformed and oversized discovery state cannot guide the next candidate read", async () => {
  for (const content of ["{", " ".repeat(257)]) {
    const f = await fixture()
    const file = await taskContextPath(f.env, STORE, CONTEXT_JOB, "discovery.json")
    await writeTaskContextFile(f.env, STORE, CONTEXT_JOB, "discovery.json", {})
    await writeFile(file, content)
    await assert.rejects(queue.prepareTaskContexts(f.env, f.options), /context_discovery_invalid/u)
  }
})

test("a missing or non-file private log is recorded as unavailable and unexpected path errors remain explicit", async () => {
  for (const missing of [true, false]) {
    const f = await fixture()
    f.entries[0].logPath = missing ? join(f.root, "missing.jsonl") : f.root
    await queue.prepareTaskContexts(f.env, f.options)
    const [work] = await queue.listContextWork(f.env, { store: STORE })
    assert.equal(work.source.private_evidence[0].log_path, null)
    assert.equal(work.source.private_evidence[0].fingerprint, null)
  }
  const invalid = await fixture()
  invalid.entries[0].logPath = join(invalid.root, "invalid\0")
  await assert.rejects(queue.prepareTaskContexts(invalid.env, invalid.options), { code: "ERR_INVALID_ARG_VALUE" })
})

test("the default preparation clock and default diagnostic code need no caller-specific wiring", async () => {
  const f = await fixture()
  const { clock: _clock, ...options } = f.options
  assert.equal((await queue.prepareTaskContexts(f.env, options)).prepared, 1)
  assert.equal((await queue.planContextPublication(f.env, { ...options, now: Date.now() })).states.length, 1)
  await queue.recordContextError(f.env, STORE)
  assert.equal((await readStatus(f.env)).context_publication[STORE].code, "context_error")
})

test("duplicate live and archived card paths are resolved once while the remaining job is searched", async () => {
  const f = await cardFixture()
  await mkdir(join(f.desk, "sample", "_archive", "safe"), { recursive: true })
  await writeFile(join(f.desk, "sample", "_archive", "safe", "task.md"), f.original)
  const other = structuredClone(f.facts.jobs[0])
  other.job = "f".repeat(32)
  f.facts.jobs.push(other)
  f.entries[0].localJobs.push({ local: other.job, published: other.job })
  const { resolveJobIdentity } = await import("../../../../../plugins/desk/mcp/src/factory/desk-repo.js")
  let calls = 0
  await queue.prepareTaskContexts(f.env, { ...f.options, resolveIdentity: (options) => {
    calls += 1
    return resolveJobIdentity(options)
  } })
  assert.equal(calls, 1)
})

test("card discovery never reads a file that changed type or escaped the desk after identity resolution", async (t) => {
  const { resolveJobIdentity } = await import("../../../../../plugins/desk/mcp/src/factory/desk-repo.js")
  for (const failure of ["directory", "outside", "missing", "io"]) {
    const f = await cardFixture()
    const outside = join(f.root, "outside", "task.md")
    await mkdir(join(f.root, "outside"), { recursive: true })
    await writeFile(outside, f.original)
    let identified = false
    const directory = fsNative.lstatSync(join(f.desk, "sample", "safe"))
    const options = { ...f.options, resolveIdentity: (options) => {
      const birth = resolveJobIdentity(options)
      identified = true
      return birth
    } }
    await withFsFault(t, {
      lstatSync: (original, file, ...args) => {
        if (String(file) === f.card && identified) {
          if (failure === "directory") return directory
          if (failure === "missing" || failure === "io") throw Object.assign(new Error("synthetic_card_read"), { code: failure === "missing" ? "ENOENT" : "EIO" })
        }
        return original(file, ...args)
      },
      realpathSync: (original, file, ...args) => String(file) === f.card && identified && failure === "outside" ? outside : original(file, ...args),
      readFileSync: (original, file, ...args) => {
        if (String(file) === f.card && identified) assert.fail("an unsafe card must not be read for hashing")
        return original(file, ...args)
      },
    }, async () => {
      if (failure === "io") await assert.rejects(queue.prepareTaskContexts(f.env, options), { code: "EIO" })
      else {
        await queue.prepareTaskContexts(f.env, options)
        const [work] = await queue.listContextWork(f.env, { store: STORE })
        assert.equal(work.source.task_card, null)
      }
    })
    assert.equal(identified, true)
  }
})

test("an unexpected walk-clock failure cannot look like a successful empty discovery", async (t) => {
  const f = await cardFixture()
  let walking = false
  await withFsFault(t, { lstatSync: (original, file, ...args) => {
    const value = original(file, ...args)
    if (String(file) === f.card) walking = true
    return value
  } }, async () => {
    await assert.rejects(queue.prepareTaskContexts(f.env, { ...f.options, clock: () => {
      if (walking) throw Object.assign(new Error("synthetic_walk_clock"), { code: "clock_failed" })
      return 0
    } }), { code: "clock_failed" })
  })
})

test("a retained card that disappears or becomes nonregular, linked or oversized invalidates its private input", async () => {
  for (const failure of ["missing", "directory", "symlink", "hardlink", "oversize"]) {
    const f = await cardFixture()
    await queue.prepareTaskContexts(f.env, f.options)
    assert.equal((await queue.listContextWork(f.env, { store: STORE })).length, 1)
    const kept = `${f.card}.preserved`
    if (failure === "hardlink") await link(f.card, kept)
    else if (failure === "oversize") await writeFile(f.card, "x".repeat(1024 * 1024 + 1))
    else {
      await rename(f.card, kept)
      if (failure === "directory") await mkdir(f.card)
      if (failure === "symlink") await symlink(kept, f.card)
    }
    assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
  }
})

test("unexpected retained-card IO failures surface instead of being mistaken for missing evidence", async (t) => {
  const f = await cardFixture()
  await queue.prepareTaskContexts(f.env, f.options)
  await withFsFault(t, { lstatSync: (original, file, ...args) => {
    if (String(file) === f.card) throw Object.assign(new Error("synthetic_retained_card_io"), { code: "EIO" })
    return original(file, ...args)
  } }, async () => assert.rejects(queue.listContextWork(f.env, { store: STORE }), { code: "EIO" }))
})

for (const stores of [
  { "OuroStack/Factory": true, [STORE]: false },
  { [STORE]: false, "OuroStack/Factory": true },
]) test(`a case alias cannot override denied prose permission: ${Object.keys(stores).join(", ")}`, async () => {
  const f = await fixture()
  await writeFile(join(f.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores }))
  assert.equal(queue.contextPermission(f.desk, STORE), "not_opted_in")
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 0)
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
})

test("preparation is source-current, idempotent and protected without publishing private paths", async () => {
  assert.ok(queue)
  const f = await prepared()
  assert.equal(f.work.phase, "candidate")
  const input = JSON.parse(await readFile(f.work.input, "utf8"))
  assert.equal(input.private_evidence[0].log_path, f.entries[0].logPath)
  assert.equal(input.sources[0].session.id, f.facts.session.id)
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).unchanged, 1)
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("optional card and successful Git discovery share one aggregate preparation deadline", async () => {
  const f = await fixture()
  for (let index = 0; index < 10; index += 1) {
    const folder = join(f.desk, "sample", `task-${index}`)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\n")
  }
  let elapsed = 0
  let resolutions = 0
  const counts = await queue.prepareTaskContexts(f.env, {
    ...f.options, deadline: 2000, clock: () => elapsed,
    readRemote: () => { elapsed += 500; return "https://github.com/synthetic/desk.git" },
    resolveIdentity: ({ track, slug }) => { resolutions += 1; elapsed += 500; return { track, slug } },
  })
  assert.equal(counts.prepared, 0)
  assert.deepEqual(counts.deferred, [CONTEXT_JOB])
  assert.equal(resolutions, 1, "a slow successful Git response must not start another card")
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
})

test("bounded discovery makes progress on a found task even when other task identities remain unresolved", async () => {
  const f = await fixture()
  const remote = "https://github.com/synthetic/desk.git"
  const known = jobId({ deskRemote: remote, personPrefix: "", track: "sample", slug: "a-known" })
  f.facts.jobs[0].job = known
  f.facts.outcomes[0].job = known
  f.entries[0].localJobs = [{ local: known, published: known }]
  const other = structuredClone(f.entries[0])
  other.facts.session.id = "22bc1234-1234-4abc-8abc-123456789abc"
  other.facts.jobs[0].job = "f".repeat(32)
  other.facts.outcomes[0].job = "f".repeat(32)
  other.localJobs = [{ local: "f".repeat(32), published: "f".repeat(32) }]
  f.entries.push(other)
  for (const slug of ["a-known", "z-one", "z-two", "z-three", "z-four"]) {
    const folder = join(f.desk, "sample", slug)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\n")
  }
  let elapsed = 0
  const options = {
    ...f.options, deadline: 2000, clock: () => elapsed,
    readRemote: () => { elapsed += 200; return remote },
    resolveIdentity: ({ track, slug }) => { elapsed += 400; return { track, slug } },
  }
  const counts = await queue.prepareTaskContexts(f.env, options)
  assert.equal(counts.prepared, 1)
  assert.equal(counts.held, 1)
  assert.deepEqual((await queue.listContextWork(f.env, { store: STORE })).map((work) => work.job), [known])
})

for (const cutoff of ["card cap", "walk deadline"]) {
  test(`a renamed task in the inspected prefix progresses after the discovery ${cutoff}`, async () => {
    const f = await fixture()
    const git = (...args) => execFileSync("git", args, { cwd: f.desk, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    const remote = "https://github.com/synthetic/desk.git"
    git("init", "-qb", "main")
    git("config", "user.email", "16390116+arimendelow@users.noreply.github.com")
    git("config", "user.name", "Context Test")
    git("config", "commit.gpgsign", "false")
    git("remote", "add", "origin", remote)
    await mkdir(join(f.desk, "sample", "old-name"), { recursive: true })
    await writeFile(join(f.desk, "sample", "old-name", "task.md"), "---\nstatus: done\ncreated: '2026-10-01T00:00:00Z'\n---\nObserved a connection problem.\n")
    git("add", "sample")
    git("commit", "-qm", "create task")
    git("mv", "sample/old-name", "sample/a-current")
    git("commit", "-qm", "rename task")
    const job = jobId({ deskRemote: remote, personPrefix: "", track: "sample", slug: "old-name" })
    f.facts.jobs[0].job = job
    f.facts.outcomes[0].job = job
    f.entries[0].localJobs = [{ local: job, published: job }]
    for (let index = 0; index < 1000; index += 1) {
      const folder = join(f.desk, "sample", `z-${String(index).padStart(4, "0")}`)
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\n")
    }
    let elapsed = 0
    const counts = await queue.prepareTaskContexts(f.env, {
      ...f.options, deadline: 2000, clock: () => cutoff === "card cap" ? 0 : elapsed++,
    })
    assert.equal(counts.prepared, 1)
    const [work] = await queue.listContextWork(f.env, { store: STORE })
    assert.equal(work.job, job)
    assert.equal(work.source.task_card.path, join(f.desk, "sample", "a-current", "task.md"))
    assert.ok(elapsed < 2000)
  })
}

test("successive bounded passes reach a renamed candidate beyond one fallback budget", async () => {
  const f = await fixture()
  const remote = "https://github.com/synthetic/desk.git"
  const job = jobId({ deskRemote: remote, personPrefix: "", track: "sample", slug: "birth-name" })
  f.facts.jobs[0].job = job
  f.facts.outcomes[0].job = job
  f.entries[0].localJobs = [{ local: job, published: job }]
  for (let index = 0; index < 12; index += 1) {
    const folder = join(f.desk, "sample", `current-${String(index).padStart(2, "0")}`)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\n")
  }
  let elapsed = 0
  let prepared = false
  for (let pass = 0; pass < 4; pass += 1) {
    elapsed = 0
    const counts = await queue.prepareTaskContexts(f.env, {
      ...f.options, deadline: 2000, clock: () => elapsed, readRemote: () => remote,
      resolveIdentity: ({ track, slug }) => {
        elapsed += 200
        return { track, slug: slug === "current-10" ? "birth-name" : slug }
      },
    })
    assert.ok(elapsed <= 2000, "progress never raises the aggregate preparation allowance")
    if (counts.prepared === 1) { prepared = true; break }
    assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [], "unresolved identities are not guessed publishable")
  }
  assert.equal(prepared, true, "each bounded retry must resume discovery rather than rechecking the same prefix forever")
  const [work] = await queue.listContextWork(f.env, { store: STORE })
  assert.equal(work.source.task_card.path, join(f.desk, "sample", "current-10", "task.md"))
})

test("successive bounded passes refresh every previous association rather than repeating its prefix", async () => {
  const f = await fixture()
  const remote = "https://github.com/synthetic/desk.git"
  const template = f.entries[0]
  f.entries.length = 0
  for (let index = 0; index < 5; index += 1) {
    const slug = `task-${index}`
    const job = jobId({ deskRemote: remote, personPrefix: "", track: "sample", slug })
    const facts = contextFacts()
    facts.session.id = `${String(index).padStart(8, "0")}-1234-4abc-8abc-123456789abc`
    facts.jobs[0].job = job
    facts.outcomes[0].job = job
    f.entries.push({ ...template, facts, localJobs: [{ local: job, published: job }] })
    const folder = join(f.desk, "sample", slug)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\nOriginal observation.\n")
  }
  const options = {
    ...f.options, readRemote: () => remote, resolveIdentity: ({ track, slug }) => ({ track, slug }),
  }
  assert.equal((await queue.prepareTaskContexts(f.env, options)).prepared, 5)
  for (let index = 0; index < 5; index += 1) {
    await writeFile(join(f.desk, "sample", `task-${index}`, "task.md"), "---\nstatus: done\n---\nRetesting resumed.\n")
  }
  const refreshed = new Set()
  for (let pass = 0; pass < 3; pass += 1) {
    let elapsed = 0
    await queue.prepareTaskContexts(f.env, {
      ...options, deadline: 2000, clock: () => elapsed,
      resolveIdentity: ({ track, slug, deadline, timeoutMs }) => {
        assert.ok(deadline <= 1000)
        assert.equal(timeoutMs, 500)
        elapsed += 200
        return { track, slug }
      },
    })
    assert.ok(elapsed <= 2000)
    for (const work of await queue.listContextWork(f.env, { store: STORE })) refreshed.add(work.job)
  }
  assert.equal(refreshed.size, 5, "the fifth prior card must eventually get a fresh identity and source hash")
})

test("a resumed mixed discovery cursor refreshes known work without traversing the unrelated tail", async () => {
  const f = await fixture()
  const remote = "https://github.com/synthetic/desk.git"
  const template = f.entries[0]
  f.entries.length = 0
  const jobs = []
  for (let index = 0; index < 4; index += 1) {
    const slug = `known-${index}`
    const job = jobId({ deskRemote: remote, personPrefix: "", track: "sample", slug })
    const facts = contextFacts()
    facts.session.id = `${String(index).padStart(8, "0")}-1234-4abc-8abc-123456789abc`
    facts.jobs[0].job = job
    facts.outcomes[0].job = job
    jobs.push(job)
    f.entries.push({ ...template, facts, localJobs: [{ local: job, published: job }] })
    const folder = join(f.desk, "sample", slug)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\nObserved work.\n")
  }
  for (let index = 0; index < 12; index += 1) {
    const folder = join(f.desk, "sample", `unrelated-${index}`)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\n")
  }
  const options = {
    ...f.options, readRemote: () => remote, resolveIdentity: ({ track, slug }) => ({ track, slug }),
  }
  assert.equal((await queue.prepareTaskContexts(f.env, options)).prepared, 4)
  await writeTaskContextFile(f.env, STORE, [...jobs].sort()[0], "discovery.json", {
    schema: "desk.factory.context-discovery/1", cursor: 8,
  })
  let elapsed = 0
  const version = "3.2.0-alpha.2"
  const counts = await queue.prepareTaskContexts(f.env, {
    ...options, pluginVersion: version, deadline: 2000, clock: () => elapsed,
    resolveIdentity: ({ track, slug, deadline, timeoutMs }) => {
      assert.ok(deadline <= 1000)
      assert.equal(timeoutMs, 500)
      elapsed += 200
      return { track, slug }
    },
  })
  assert.ok(elapsed <= 2000, "useful progress must retain the existing preparation allowance")
  assert.ok(counts.prepared > 0, "a persisted fallback cursor must not hide every known task after a release")
  const refreshed = (await queue.listContextWork(f.env, { store: STORE })).filter((work) => work.source.evaluator.plugin_version === version)
  assert.ok(refreshed.length > 0)
  assert.ok(refreshed.every((work) => jobs.includes(work.job)), "unrelated cards never become task evidence")
})

test("a shortened preparation turn can resolve and persist a real task within its remaining allowance", async () => {
  const f = await cardFixture()
  let elapsed = 0
  const result = await queue.prepareTaskContexts(f.env, {
    ...f.options, deadline: 417, clock: () => elapsed,
    readRemote: () => {
      elapsed += 115
      return "https://github.com/synthetic/desk.git"
    },
    resolveIdentity: ({ track, slug }) => {
      elapsed += 134
      return { track, slug }
    },
  })
  assert.equal(result.prepared, 1, "nested budget splits must not reject a task that fits the remaining preparation turn")
  const [work] = await queue.listContextWork(f.env, { store: STORE })
  assert.equal(work.job, f.job)
  assert.equal(work.source.task_card.path, f.card)
  assert.equal(work.source.evaluator.plugin_version, VERSION)
  assert.ok(elapsed < 417, "the ordinary preparation deadline must remain unchanged")
})

test("a previous association Git timeout cannot starve later prior and renamed candidates", async () => {
  const f = await fixture()
  const remote = "https://github.com/synthetic/desk.git"
  const entries = []
  const jobs = []
  for (const [index, slug] of ["a-failing", "b-valid", "birth-name"].entries()) {
    const job = jobId({ deskRemote: remote, personPrefix: "", track: "sample", slug })
    const facts = contextFacts()
    facts.session.id = `${String(index).padStart(8, "0")}-1234-4abc-8abc-123456789abc`
    facts.jobs[0].job = job
    facts.outcomes[0].job = job
    jobs.push(job)
    entries.push({ ...f.entries[0], facts, localJobs: [{ local: job, published: job }] })
    if (index === 2) continue
    const folder = join(f.desk, "sample", slug)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\nOriginal observation.\n")
  }
  const options = {
    ...f.options, entries: entries.slice(0, 2), readRemote: () => remote,
    resolveIdentity: ({ track, slug }) => ({ track, slug }),
  }
  assert.equal((await queue.prepareTaskContexts(f.env, options)).prepared, 2)
  for (const slug of ["a-failing", "b-valid", "z-renamed"]) {
    const folder = join(f.desk, "sample", slug)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\nRetesting resumed.\n")
  }
  for (let pass = 0; pass < 3; pass += 1) {
    let elapsed = 0
    await queue.prepareTaskContexts(f.env, {
      ...options, entries, deadline: 2000, clock: () => elapsed,
      resolveIdentity: ({ track, slug, deadline, timeoutMs }) => {
        assert.ok(deadline <= 1000)
        assert.equal(timeoutMs, 500)
        elapsed += slug === "a-failing" ? 500 : 200
        if (slug === "a-failing") throw Object.assign(new Error("git_deadline"), { code: "git_deadline" })
        return { track, slug: slug === "z-renamed" ? "birth-name" : slug }
      },
    })
    assert.ok(elapsed <= 2000)
  }
  const work = await queue.listContextWork(f.env, { store: STORE })
  assert.deepEqual(work.map((item) => item.job).sort(), jobs.slice(1).sort(), "unvalidated first card stays held while later work progresses")
  assert.equal(work.find((item) => item.job === jobs[2]).source.task_card.path, join(f.desk, "sample", "z-renamed", "task.md"))
})

test("invalid discovery progress cannot select evidence or create a runnable context", async () => {
  for (const value of [
    { schema: "desk.factory.context-discovery/1", cursor: -1 },
    { schema: "desk.factory.context-discovery/1", cursor: 1000 },
    { schema: "desk.factory.context-discovery/1", cursor: 0.5 },
    { schema: "desk.factory.context-discovery/1", cursor: 0, path: "PRIVATE" },
  ]) {
    const f = await fixture()
    await writeTaskContextFile(f.env, STORE, CONTEXT_JOB, "discovery.json", value)
    await assert.rejects(queue.prepareTaskContexts(f.env, f.options), /context_discovery_invalid/u)
    assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
  }
})

test("the private file limit counts the actual readable serialization, not the smaller compact value", async () => {
  const f = await fixture()
  const value = Array(3500000).fill(0)
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 16 * 1024 * 1024)
  assert.ok(Buffer.byteLength(serializeTaskContext(value)) > 16 * 1024 * 1024)
  await assert.rejects(writeTaskContextFile(f.env, STORE, CONTEXT_JOB, "0123456789abcdef.brief.json", value), /context file is too large/u)
})

test("an author's own approval is refused; a separate hash-bound privacy judgment makes context ready", async () => {
  assert.ok(queue)
  const f = await prepared()
  const selfApproved = await queue.acceptContextCandidate(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(contextRecord(f.facts)) })
  assert.equal(selfApproved.result, "review_not_independent")
  const accepted = await acceptedCandidate(f)
  assert.equal(accepted.result, "candidate_accepted")
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
  const [privacy] = await queue.listContextWork(f.env, { store: STORE })
  assert.equal(privacy.phase, "privacy")
  const checked = await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)) })
  assert.equal(checked.result, "context_accepted")
  const [item] = await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries })
  assert.equal(item.path, `context/${CONTEXT_JOB}.json`)
  const publicText = item.bytes.toString("utf8")
  assert.equal(publicText.includes(f.root), false)
  assert.equal(publicText.includes("clock_origin"), false)
  assert.equal(JSON.parse(publicText).privacy.payload_sha256, accepted.payload_sha256)
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
})

test("candidate acceptance refuses wrong phases, malformed bytes, wrong identities and unsafe content", async () => {
  const f = await prepared()
  const accept = (bytes) => queue.acceptContextCandidate(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes })
  for (const bytes of [undefined, "{", "null", " ".repeat(128 * 1024 + 1)]) assert.equal((await accept(bytes)).result, "invalid_candidate")
  const wrongJob = candidate(f.facts)
  wrongJob.job = "f".repeat(32)
  assert.equal((await accept(json(wrongJob))).result, "identity_mismatch")
  const wrongEvaluator = candidate(f.facts)
  wrongEvaluator.evaluator.plugin_version = "3.2.0-alpha.2"
  assert.equal((await accept(json(wrongEvaluator))).result, "identity_mismatch")
  const unsafe = candidate(f.facts)
  unsafe.heading = "SENTINEL@example.com"
  const rejected = await accept(json(unsafe))
  assert.equal(rejected.result, "invalid_candidate")
  assert.equal(JSON.stringify(rejected).includes("SENTINEL"), false)
  assert.equal((await queue.acceptContextPrivacy(f.env, {
    store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review("f".repeat(64))),
  })).result, "phase_changed")
  await acceptedCandidate(f)
  assert.equal((await accept(json(candidate(f.facts)))).result, "phase_changed")
})

test("privacy acceptance refuses malformed reviews, changed candidate bytes and invalid reviewed content", async () => {
  const f = await prepared()
  const accepted = await acceptedCandidate(f)
  const good = review(accepted.payload_sha256)
  for (const value of [null, [], { ...good, extra: true }, { ...good, schema: "other" },
    { ...good, verdict: "unknown" }, { ...good, reason: "unknown" }, { ...good, reviewer: { ...good.reviewer, plugin_version: "3.2.0-alpha.2" } }]) {
    assert.equal((await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(value) })).result, "invalid_review")
  }
  await updateTaskContextState(f.env, STORE, CONTEXT_JOB, (state) => {
    state.candidate.events[0].explanation = "Changed unreviewed words."
    return state
  })
  assert.equal((await queue.acceptContextPrivacy(f.env, {
    store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(good),
  })).result, "review_mismatch")
  let hash
  await updateTaskContextState(f.env, STORE, CONTEXT_JOB, (state) => {
    state.candidate.heading = "SENTINEL@example.com"
    hash = state.candidate_hash = contextPayloadHash(state.candidate)
    return state
  })
  assert.equal((await queue.acceptContextPrivacy(f.env, {
    store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(hash)),
  })).result, "invalid_review")
})

test("permission changes stop both eligible work and final ready reads without reusing an earlier positive policy", async () => {
  const f = await prepared()
  await writeFile(join(f.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: false } }))
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
  assert.equal((await acceptedCandidate(f)).result, "source_changed")
  await setConsent(f.env, { store: STORE, contribute: false, account: "synthetic" })
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("a privacy refusal or an edited payload hash cannot reach the public outbox", async () => {
  assert.ok(queue)
  for (const verdict of ["withheld", "wrong_hash"]) {
    const f = await prepared()
    const accepted = await acceptedCandidate(f)
    const value = review(verdict === "wrong_hash" ? "f".repeat(64) : accepted.payload_sha256, verdict === "withheld" ? "withheld" : "approved")
    const result = await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(value) })
    assert.notEqual(result.result, "context_accepted")
    assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
  }
})

test("a source update between generation and privacy invalidates the old phase", async () => {
  assert.ok(queue)
  const f = await prepared()
  const accepted = await acceptedCandidate(f)
  f.facts.intervals[0].end_ms += 1
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 1)
  const result = await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)) })
  assert.equal(result.result, "source_changed")
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("revoking prose permission or changing the route stops a reviewed record", async () => {
  assert.ok(queue)
  for (const route of [false, true]) {
    const f = await prepared()
    const accepted = await acceptedCandidate(f)
    await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)) })
    if (route) await writeFile(join(f.desk, "_meta", "factory.json"), json({ schema_version: 1, store: "example/private" }))
    else await writeFile(join(f.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: false } }))
    assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
  }
})

test("final online preparation rechecks private evidence and prose permission instead of sending an earlier ready snapshot", async () => {
  for (const change of ["log", "permission"]) {
    const f = await prepared()
    const accepted = await acceptedCandidate(f)
    await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)) })
    const plan = await queue.planContextPublication(f.env, { ...f.options, now: Date.now() })
    assert.equal(plan.ready.length, 1)
    let changed = false
    const items = await queue.prepareContextPublication(f.env, {
      store: STORE, plan, direct: true, ref: "a".repeat(40), now: Date.now(),
      client: { api: async () => {
        changed = true
        if (change === "log") await writeFile(f.entries[0].logPath, '{"synthetic":"changed during the online capability read"}\n')
        else await writeFile(join(f.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: false } }))
        return { status: 200, json: { type: "file", encoding: "base64", content: Buffer.from('{"task_context":1}').toString("base64") } }
      } },
      readMain: async () => ({ blobs: new Map(), unknown: false }),
    })
    assert.equal(changed, true)
    assert.deepEqual(items, [], change)
  }
})

test("a task card is associated by its real job identity and changes invalidate its context input", async () => {
  assert.ok(queue)
  const f = await cardFixture()
  const { job, card, original } = f
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 1)
  const [work] = await queue.listContextWork(f.env, { store: STORE })
  const input = JSON.parse(await readFile(work.input, "utf8"))
  assert.equal(input.task_card.path, card)
  assert.match(input.task_card.sha256, /^[0-9a-f]{64}$/u)
  assert.equal(JSON.stringify(input).includes("Private source"), false)
  await writeFile(card, `${original}\nThe software update was installed and retesting resumed.\n`)
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 1)
  assert.notEqual((await queue.listContextWork(f.env, { store: STORE }))[0].basis, work.basis)
  for (let index = 0; index < 25; index += 1) {
    const folder = join(f.desk, "before", `unrelated-${index}`)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\n")
  }
  const resolved = []
  const { resolveJobIdentity } = await import("../../../../../plugins/desk/mcp/src/factory/desk-repo.js")
  assert.equal((await queue.prepareTaskContexts(f.env, {
    ...f.options, resolveIdentity: (options) => {
      resolved.push(`${options.track}/${options.slug}`)
      return resolveJobIdentity(options)
    },
  })).unchanged, 1)
  assert.deepEqual(resolved, ["sample/safe"], "prioritize the nominal candidate without resolving every unrelated card again")
})

test("changed private evidence invalidates review even before the next preparation pass", async () => {
  const f = await prepared()
  const accepted = await acceptedCandidate(f)
  await writeFile(f.entries[0].logPath, '{"synthetic":"new private evidence"}\n')
  const checked = await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)) })
  assert.equal(checked.result, "source_changed")
})

test("editing a prepared input cannot silently change the source basis", async () => {
  const f = await prepared()
  const input = JSON.parse(await readFile(f.work.input, "utf8"))
  input.sources[0].intervals[0].end_ms += 1
  await writeFile(f.work.input, json(input))
  const changed = candidate(input.sources[0])
  const checked = await queue.acceptContextCandidate(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(changed) })
  assert.equal(checked.result, "source_changed")
})

test("a child-written ready flag cannot bypass the separate privacy acceptance receipt", async () => {
  const f = await prepared()
  const stateFile = await taskContextPath(f.env, STORE, CONTEXT_JOB, "state.json")
  const state = JSON.parse(await readFile(stateFile, "utf8"))
  state.phase = "ready"
  state.record = contextRecord(f.facts)
  await writeFile(stateFile, json(state))
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("normal formatted local model responses are checked then canonically serialized for publication", async () => {
  const f = await prepared()
  const accepted = await queue.acceptContextCandidate(f.env, {
    store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: JSON.stringify(candidate(f.facts), null, 2),
  })
  assert.equal(accepted.result, "candidate_accepted")
  assert.equal((await queue.acceptContextPrivacy(f.env, {
    store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: JSON.stringify(review(accepted.payload_sha256), null, 2),
  })).result, "context_accepted")
  const [item] = await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries })
  assert.equal(item.bytes.toString("utf8"), `${JSON.stringify(JSON.parse(item.bytes.toString("utf8")))}\n`)
})

for (const phase of ["candidate", "privacy", "withheld"]) {
  test(`a new source generation arriving at the ${phase} update cannot be replaced by the stale result`, async (t) => {
    const f = await prepared()
    const proposed = candidate(f.work.source.sources[0])
    const accepted = phase === "candidate" ? null : await acceptedCandidate(f)
    const changed = await nextGeneration(f)
    let result
    await atStateLock(t, f, changed.after, async () => {
      result = phase === "candidate"
        ? await queue.acceptContextCandidate(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(proposed) })
        : await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis,
          bytes: json(review(accepted.payload_sha256, phase === "withheld" ? "withheld" : "approved")) })
    })
    assert.equal(result.result, phase === "withheld" ? "context_withheld" : "source_changed")
    assert.deepEqual(await storedState(f), changed.after)
    assert.equal((await queue.listContextWork(f.env, { store: STORE }))[0].basis, changed.after.basis)
  })
}

test("deferred jobs and a changed public source set cannot reuse an earlier ready record", async () => {
  const f = await reviewed()
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries, skipJobs: new Set([CONTEXT_JOB]) }), [])
  f.facts.intervals[0].end_ms += 1
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("unpublished candidates cannot spend the publication budget reading private inputs", async (t) => {
  const f = await reviewed()
  const pendingJob = "0".repeat(32)
  const pending = structuredClone(f.entries[0])
  pending.facts.session.id = "22bc1234-1234-4abc-8abc-123456789abc"
  pending.facts.jobs[0].job = pendingJob
  pending.facts.outcomes[0].job = pendingJob
  pending.localJobs = [{ local: pendingJob, published: pendingJob }]
  f.entries.push(pending)
  await queue.prepareTaskContexts(f.env, f.options)
  const state = JSON.parse(await readFile(await taskContextPath(f.env, STORE, pendingJob, "state.json"), "utf8"))
  const input = await taskContextPath(f.env, STORE, pendingJob, state.input)
  let elapsed = 0
  const ready = await withFsFault(t, {
    readFile: (original, file, ...args) => {
      if (String(file) === input) elapsed += 2000
      return original(file, ...args)
    },
  }, () => queue.readyTaskContexts(f.env, {
    store: STORE, entries: f.entries, deadline: 2000, clock: () => elapsed,
  }), fsNative.promises)
  assert.deepEqual(ready.map((item) => item.job), [CONTEXT_JOB])
  assert.equal(elapsed, 0, "a candidate with no prior publication has nothing to send or invalidate")
})

test("empty private job directories and invalid protected inputs create no publication work", async () => {
  const empty = await fixture()
  await writeTaskContextFile(empty.env, STORE, CONTEXT_JOB, "discovery.json", { schema: "desk.factory.context-discovery/1", cursor: 0 })
  const plan = await queue.planContextPublication(empty.env, { ...empty.options, entries: [], now: 1000 })
  assert.equal(plan.work, false)
  assert.deepEqual(plan.states, [])
  const invalid = await reviewed()
  await writeFile(invalid.work.input, "{}\n")
  assert.deepEqual(await online(invalid), [])
  const held = await queue.planContextPublication(invalid.env, { ...invalid.options, now: 1000 })
  assert.equal(held.work, false)
  assert.deepEqual(held.states, [])
})

test("bounded publication preserves ready progress and resumes beyond its first input", async (t) => {
  const f = await reviewed()
  const otherJob = "0".repeat(32)
  const other = structuredClone(f.entries[0])
  other.facts.session.id = "22bc1234-1234-4abc-8abc-123456789abc"
  other.facts.jobs[0].job = otherJob
  other.facts.outcomes[0].job = otherJob
  other.localJobs = [{ local: otherJob, published: otherJob }]
  f.entries.push(other)
  await queue.prepareTaskContexts(f.env, f.options)
  const work = (await queue.listContextWork(f.env, { store: STORE })).find((item) => item.job === otherJob)
  const accepted = await queue.acceptContextCandidate(f.env, {
    store: STORE, job: otherJob, basis: work.basis, bytes: json(candidate(other.facts, otherJob)),
  })
  assert.equal((await queue.acceptContextPrivacy(f.env, {
    store: STORE, job: otherJob, basis: work.basis, bytes: json(review(accepted.payload_sha256)),
  })).result, "context_accepted")
  const seen = new Set()
  for (let pass = 0; pass < 3; pass += 1) {
    let elapsed = 0
    const plan = await withFsFault(t, {
      readFile: (original, file, ...args) => {
        if (/input-[a-f0-9]{64}\.json$/u.test(String(file))) elapsed += 700
        return original(file, ...args)
      },
    }, () => queue.planContextPublication(f.env, {
      ...f.options, now: 1000, deadline: 2000, clock: () => elapsed,
    }), fsNative.promises)
    assert.ok(plan.ready.length > 0, "a later slow input cannot discard a completed ready record")
    assert.equal(plan.work, true)
    assert.equal(plan.deferred, true)
    for (const item of plan.ready) seen.add(item.job)
  }
  assert.deepEqual([...seen].sort(), [otherJob, CONTEXT_JOB].sort(), "bounded retries cannot repeat only the first ready job")
})

test("publication receipts are mandatory for existing ownership fields and absent jobs cannot be marked sent", async () => {
  const missing = await fixture()
  await assert.rejects(queue.saveContextSent(missing.env, STORE, [{ job: CONTEXT_JOB, basis: "a".repeat(64), sha: "b".repeat(40) }], 101),
    /context_publication_receipt_invalid/u)
  const f = await reviewed()
  await updateTaskContextState(f.env, STORE, CONTEXT_JOB, (state) => ({ ...state, published_sha: "f".repeat(40) }))
  await assert.rejects(queue.saveContextSent(f.env, STORE, [f.item], 101), /context_publication_receipt_invalid/u)
  await assert.rejects(queue.planContextPublication(f.env, { ...f.options, now: 1000 }), /context_publication_receipt_invalid/u)
  await assert.rejects(online(f), /context_publication_receipt_invalid/u)
})

test("invalid publication cursors cannot select or publish task evidence", async () => {
  const f = await reviewed()
  for (const value of [
    "{",
    json({ schema: "desk.factory.context-publication-cursor/1", cursor: -1 }),
    json({ schema: "desk.factory.context-publication-cursor/1", cursor: 1000 }),
    json({ schema: "desk.factory.context-publication-cursor/1", cursor: 0.5 }),
    json({ schema: "desk.factory.context-publication-cursor/1", cursor: 0, path: "PRIVATE" }),
    " ".repeat(257),
  ]) {
    await writeFile(await taskContextPath(f.env, STORE, CONTEXT_JOB, "publication.json"), value)
    await assert.rejects(queue.planContextPublication(f.env, { ...f.options, now: 1000 }),
      /context_publication_cursor_invalid/u)
  }
})

test("preparation exhaustion before publication returns no unvalidated records", async (t) => {
  const f = await reviewed()
  await updateStatus(f.env, (status) => ({ ...status, context_planning: { [STORE]: "prepare" } }))
  let elapsed = 0
  let consentReads = 0
  const plan = await withFsFault(t, {
    readFile: (original, file, ...args) => {
      if (/[\\/]consent\.json$/u.test(String(file)) && ++consentReads === 2) elapsed = 2000
      return original(file, ...args)
    },
  }, () => queue.planContextPublication(f.env, {
    ...f.options, now: 1000, deadline: 2000, clock: () => elapsed,
  }), fsNative.promises)
  assert.equal(plan.deferred, true)
  assert.equal(plan.work, false)
  assert.deepEqual(plan.ready, [])
})

test("unexpected discovery errors are not converted into a successful partial plan", async () => {
  const f = await reviewed()
  await assert.rejects(queue.planContextPublication(f.env, {
    ...f.options, now: 1000, readRemote: () => { throw new Error("synthetic source failure") },
  }), /synthetic source failure/u)
})

test("publication planning preserves numerical-only consent and expired deadlines", async () => {
  const off = await fixture({ contribute: false })
  const noConsent = await queue.planContextPublication(off.env, { ...off.options, now: 1000 })
  assert.equal(noConsent.work, false)
  assert.equal(noConsent.deferred, false)
  const f = await reviewed()
  const expired = await queue.planContextPublication(f.env, { ...f.options, now: 1000, deadline: 0 })
  assert.equal(expired.work, false)
  assert.equal(expired.deferred, true)
  assert.deepEqual(expired.ready, [])
})

test("a ready input that spends the remaining budget is held rather than returned late", async (t) => {
  const f = await reviewed()
  let elapsed = 0
  const plan = await withFsFault(t, {
    readFile: (original, file, ...args) => {
      if (String(file) === f.work.input) elapsed = 2000
      return original(file, ...args)
    },
  }, () => queue.planContextPublication(f.env, {
    ...f.options, now: 1000, deadline: 2000, clock: () => elapsed,
  }), fsNative.promises)
  assert.equal(plan.deferred, true)
  assert.deepEqual(plan.ready, [])
})

test("a freshness check that spends the publication allowance cannot return a late ready item", async (t) => {
  const f = await reviewed()
  let elapsed = 0
  let inputRead = false
  const plan = await withFsFault(t, {
    readFile: (original, file, ...args) => {
      if (String(file) === f.work.input) inputRead = true
      return original(file, ...args)
    },
  }, () => withFsFault(t, {
    lstatSync: (original, file, ...args) => {
      if (inputRead && String(file) === f.entries[0].logPath) elapsed = 1000
      return original(file, ...args)
    },
  }, () => queue.planContextPublication(f.env, {
    ...f.options, now: 1000, deadline: 2000, clock: () => elapsed,
  })), fsNative.promises)
  assert.equal(plan.deferred, true)
  assert.deepEqual(plan.ready, [])
})

test("a refreshed publication state disappearing before readback cannot publish old wording", async (t) => {
  const f = await reviewed()
  await updateStatus(f.env, (status) => ({ ...status, context_planning: { [STORE]: "prepare" } }))
  await queue.saveContextSent(f.env, STORE, [f.item], 102)
  await online(f, { readMain: async () => ({ blobs: new Map([[f.item.path, f.item.sha]]), unknown: false }) })
  await writeFile(f.entries[0].logPath, '{"synthetic":"changed private evidence"}\n')
  const stateFile = await taskContextPath(f.env, STORE, f.work.job, "state.json")
  let moved = false
  let installed = false
  let installedChecks = 0
  let discoveryPasses = 0
  const plan = await withFsFault(t, {
    rename: async (original, from, to) => {
      const result = await original(from, to)
      if (String(to) === stateFile) installed = true
      return result
    },
    lstat: async (original, file, ...args) => {
      if (String(file) === stateFile && installed && !moved && ++installedChecks === 2) {
        moved = true
        await fsNative.promises.rename(stateFile, `${stateFile}.held`)
      }
      return original(file, ...args)
    },
  }, () => queue.planContextPublication(f.env, {
    ...f.options, now: 1000,
    readRemote: () => {
      if (++discoveryPasses === 1) throw Object.assign(new Error("deferred first discovery"), { code: "context_preparation_deferred" })
      return null
    },
  }), fsNative.promises)
  assert.equal(moved, true)
  assert.deepEqual(plan.ready, [])
})

for (const code of [null, "context_preparation_deferred", "synthetic_source_failure"]) {
  test(`a stale replacement ${code ?? "succeeding after early discovery defers"} never republishes its earlier wording`, async (t) => {
    const f = await reviewed()
    await updateStatus(f.env, (status) => ({ ...status, context_planning: { [STORE]: "prepare" } }))
    await queue.saveContextSent(f.env, STORE, [f.item], 102)
    await online(f, { readMain: async () => ({ blobs: new Map([[f.item.path, f.item.sha]]), unknown: false }) })
    await writeFile(f.entries[0].logPath, '{"synthetic":"changed private evidence"}\n')
    const stateFile = await taskContextPath(f.env, STORE, f.work.job, "state.json")
    let reads = 0
    let discoveryPasses = 0
    const run = () => withFsFault(t, {
      readFile: (original, file, ...args) => {
        if (String(file) === stateFile && ++reads === 2 && code !== null) throw Object.assign(new Error(code), { code })
        return original(file, ...args)
      },
    }, () => queue.planContextPublication(f.env, {
      ...f.options, now: 1000,
      readRemote: () => {
        if (++discoveryPasses === 1) throw Object.assign(new Error("deferred first discovery"), { code: "context_preparation_deferred" })
        return null
      },
    }), fsNative.promises)
    if (code === "synthetic_source_failure") await assert.rejects(run(), { code })
    else {
      const plan = await run()
      assert.equal(plan.deferred, true)
      assert.ok(plan.ready.every((item) => item.invalidation === true))
      for (const item of plan.ready) {
        const record = JSON.parse(item.bytes)
        assert.equal(record.heading, null)
        assert.deepEqual(record.events, [])
        assert.equal(record.privacy.verdict, "not_required")
      }
      if (code === null) {
        const state = await storedState(f)
        assert.notEqual(state.basis, f.work.basis)
        assert.equal(state.phase, "candidate")
      } else {
        assert.deepEqual(plan.ready, [])
      }
    }
    assert.equal(discoveryPasses, 2)
  })
}

test("an exhausted numeric flush does not report deferred context when no context work exists", async () => {
  const f = await fixture()
  const plan = await queue.planContextPublication(f.env, { ...f.options, entries: [], deadline: -2000, now: 0 })
  assert.deepEqual(plan, { work: false, ready: [], states: [], deferred: false, prs: new Set() })
})

test("publication batches retain the eight-record limit and rotate to later ready jobs", async () => {
  const f = await reviewedJobs(9)
  const first = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  const second = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  assert.equal(first.ready.length, 8)
  assert.equal(second.ready.length, 8)
  assert.equal(first.deferred, true)
  assert.equal(new Set([...first.ready, ...second.ready].map((item) => item.job)).size, 9)
})

test("a partial plan accounts for every owned member of the refused pull request", async () => {
  const f = await reviewedJobs(9)
  const sent = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  await queue.saveContextSent(f.env, STORE, sent.ready, 102)
  const partial = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  await queue.saveContextRefused(f.env, STORE, { ...partial, refusedPrs: new Set([102]) }, "context_source_changed", 1000)
  for (const item of sent.ready) {
    const state = JSON.parse(await readFile(await taskContextPath(f.env, STORE, item.job, "state.json"), "utf8"))
    assert.equal(state.refusals, 1, "a store-wide rejection watermark cannot skip an omitted batch member")
    assert.equal(state.pr, null)
    assert.equal(state.hold_until, 1000 + 24 * 3600 * 1000)
  }
})

test("a pending context batch stays stable while the planner rotates to later jobs", async () => {
  const f = await reviewedJobs(9)
  const sent = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  await queue.saveContextSent(f.env, STORE, sent.ready, 102)
  const partial = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  const items = await queue.prepareContextPublication(f.env, {
    store: STORE, plan: partial, entries: f.entries, pendingPr: 102, client: capabilityClient,
    direct: true, ref: "main", now: 1000, readMain: async () => ({ blobs: new Map(), unknown: false }),
  })
  assert.deepEqual(items.map((item) => item.path).sort(), sent.ready.map((item) => item.path).sort(),
    "ordinary retries must not replace a still-valid unacknowledged batch")
  const withoutSlice = await queue.prepareContextPublication(f.env, {
    store: STORE, plan: { work: false, ready: [], states: [] }, entries: f.entries, pendingPr: 102,
    client: capabilityClient, direct: true, ref: "main", now: 1000,
    readMain: async () => ({ blobs: new Map(), unknown: false }),
  })
  assert.deepEqual(withoutSlice.map((item) => item.path).sort(), sent.ready.map((item) => item.path).sort())
  const completePlan = await queue.prepareContextPublication(f.env, {
    store: STORE, plan: sent, pendingPr: 102, client: capabilityClient,
    direct: true, ref: "main", now: 1000, readMain: async () => ({ blobs: new Map(), unknown: false }),
  })
  assert.deepEqual(completePlan.map((item) => item.path).sort(), sent.ready.map((item) => item.path).sort())
  assert.deepEqual(await queue.prepareContextPublication(f.env, {
    store: STORE, plan: partial, entries: [], pendingPr: 102, client: capabilityClient,
    direct: true, ref: "main", now: 1000, readMain: async () => ({ blobs: new Map(), unknown: false }),
  }), [], "pending ownership cannot stand in for missing current source facts")
})

test("settled publication inventory leaves bounded preparation progress for a new task", async (t) => {
  const f = await reviewedJobs(8)
  const sent = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  await queue.saveContextSent(f.env, STORE, sent.ready, 102)
  await queue.prepareContextPublication(f.env, {
    store: STORE, plan: sent, client: capabilityClient, direct: true, ref: "main", now: 1000,
    readMain: async () => ({ blobs: new Map(sent.ready.map((item) => [item.path, item.sha])), unknown: false }),
  })
  const job = "f".repeat(32)
  const entry = structuredClone(f.entries[0])
  entry.facts.session.id = "ffbc1234-1234-4abc-8abc-123456789abc"
  entry.facts.jobs[0].job = job
  entry.facts.outcomes[0].job = job
  entry.localJobs = [{ local: job, published: job }]
  f.entries.push(entry)
  for (let pass = 0; pass < 3; pass += 1) {
    let elapsed = 0
    await withFsFault(t, {
      readFile: (original, file, ...args) => {
        if (/input-[a-f0-9]{64}\.json$/u.test(String(file))) elapsed += 150
        return original(file, ...args)
      },
    }, () => queue.planContextPublication(f.env, {
      ...f.options, now: 1000, deadline: 2000, clock: () => elapsed,
    }), fsNative.promises)
  }
  assert.ok((await queue.listContextWork(f.env, { store: STORE })).some((work) => work.job === job),
    "already-delivered records cannot spend every turn's entire preparation allowance")
})

test("preparation starts before a large reviewed input spends the remaining publication turn", async (t) => {
  const f = await cardFixture()
  await queue.prepareTaskContexts(f.env, f.options)
  const [work] = await queue.listContextWork(f.env, { store: STORE })
  const accepted = await acceptedCandidate({ ...f, work })
  await queue.acceptContextPrivacy(f.env, {
    store: STORE, job: work.job, basis: work.basis, bytes: json(review(accepted.payload_sha256)),
  })
  let elapsed = 0
  const version = "3.2.0-alpha.2"
  await withFsFault(t, {
    readFile: (original, file, ...args) => {
      if (String(file) === work.input) elapsed += 1700
      return original(file, ...args)
    },
  }, () => queue.planContextPublication(f.env, {
    ...f.options, pluginVersion: version, now: 1000, deadline: 2000, clock: () => elapsed,
    readRemote: () => {
      elapsed += 115
      return "https://github.com/synthetic/desk.git"
    },
    resolveIdentity: ({ track, slug }) => {
      elapsed += 134
      return { track, slug }
    },
  }), fsNative.promises)
  const current = await queue.listContextWork(f.env, { store: STORE })
  assert.equal(current.length, 1, "publication inventory must not keep the next generation unevaluable")
  assert.equal(current[0].source.evaluator.plugin_version, version)
  assert.equal(current[0].source.task_card.path, f.card)
  assert.ok(elapsed <= 2000, "the two-second preparation/publication allowance remains unchanged")
})

test("inventory overhead cannot halve the first preparation stage below a complete identity lookup", async (t) => {
  const f = await cardFixture()
  await queue.prepareTaskContexts(f.env, f.options)
  const [work] = await queue.listContextWork(f.env, { store: STORE })
  const stateFile = await taskContextPath(f.env, STORE, work.job, "state.json")
  const storeDir = join(stateFile, "..", "..")
  let elapsed = 0
  let consentReads = 0
  await withFsFault(t, {
    readdir: async (original, file, ...args) => {
      const result = await original(file, ...args)
      if (String(file) === storeDir) elapsed += 500
      return result
    },
    readFile: (original, file, ...args) => {
      if (String(file).endsWith("consent.json") && ++consentReads === 2) elapsed += 100
      return original(file, ...args)
    },
  }, () => queue.planContextPublication(f.env, {
    ...f.options, pluginVersion: "3.2.0-alpha.2", now: 1000, deadline: 2000, clock: () => elapsed,
    readRemote: () => {
      elapsed += 52
      return "https://github.com/synthetic/desk.git"
    },
    resolveIdentity: ({ track, slug }) => {
      elapsed += 206 + 178
      return { track, slug }
    },
  }), fsNative.promises)
  const current = await queue.listContextWork(f.env, { store: STORE })
  assert.equal(current.length, 1)
  assert.equal(current[0].source.evaluator.plugin_version, "3.2.0-alpha.2")
  assert.equal(current[0].source.task_card.path, f.card)
  assert.ok(elapsed <= 2000)
})

test("a cold multi-command identity finishes and persists before another discovery unit starts", async (t) => {
  const f = await cardFixture()
  await queue.prepareTaskContexts(f.env, f.options)
  const secondCard = join(f.desk, "sample", "second", "task.md")
  await mkdir(join(f.desk, "sample", "second"), { recursive: true })
  await writeFile(secondCard, f.original)
  const job = jobId({ deskRemote: "https://github.com/synthetic/desk.git", personPrefix: "", track: "sample", slug: "second" })
  const entry = structuredClone(f.entries[0])
  entry.facts.session.id = "22222222-1234-4abc-8abc-123456789abc"
  entry.facts.jobs[0].job = job
  entry.facts.outcomes[0].job = job
  entry.localJobs = [{ local: job, published: job }]
  f.entries.push(entry)
  const stateFile = await taskContextPath(f.env, STORE, f.job, "state.json")
  const storeDir = join(stateFile, "..", "..")
  let elapsed = 0
  let consentReads = 0
  await withFsFault(t, {
    readdir: async (original, file, ...args) => {
      const value = await original(file, ...args)
      if (String(file) === storeDir) elapsed += 500
      return value
    },
    readFile: (original, file, ...args) => {
      if (String(file).endsWith("consent.json") && ++consentReads === 2) elapsed += 100
      return original(file, ...args)
    },
  }, () => queue.planContextPublication(f.env, {
    ...f.options, pluginVersion: "3.2.0-alpha.2", now: 1000, deadline: 2000, clock: () => elapsed,
    readRemote: () => {
      elapsed += 80
      return "https://github.com/synthetic/desk.git"
    },
    resolveIdentity: ({ track, slug }) => {
      elapsed += 120 + 528
      return { track, slug }
    },
  }), fsNative.promises)
  const work = (await queue.listContextWork(f.env, { store: STORE })).find((item) => item.job === f.job)
  assert.equal(work.source.evaluator.plugin_version, "3.2.0-alpha.2")
  assert.equal(work.source.task_card.path, f.card)
  const anchor = [f.job, job].sort()[0]
  const cursor = JSON.parse(await readFile(await taskContextPath(f.env, STORE, anchor, "discovery.json"), "utf8"))
  assert.equal(cursor.cursor, 1)
  assert.ok(elapsed <= 2000)
})

for (const withdraw of [false, true]) {
  test(`unchanged preparation cannot starve ${withdraw ? "a published withdrawal" : "reviewed publication"} across planning turns`, async (t) => {
    const f = await reviewedJobs(2)
    const activeFiles = new Set(await Promise.all(f.entries.map((entry) =>
      taskContextPath(f.env, STORE, entry.localJobs[0].published, "state.json"))))
    let withdrawnJob = null
    if (withdraw) {
      const g = await fixture()
      const entry = g.entries[0]
      withdrawnJob = `${"0".repeat(31)}1`
      entry.facts.session.id = "11111111-1234-4abc-8abc-123456789abc"
      entry.facts.jobs[0].job = withdrawnJob
      entry.facts.outcomes[0].job = withdrawnJob
      entry.localJobs = [{ local: withdrawnJob, published: withdrawnJob }]
      f.entries.push(entry)
      await queue.prepareTaskContexts(f.env, f.options)
      const work = (await queue.listContextWork(f.env, { store: STORE })).find((item) => item.job === withdrawnJob)
      const accepted = await queue.acceptContextCandidate(f.env, {
        store: STORE, job: work.job, basis: work.basis, bytes: json(candidate(entry.facts, work.job)),
      })
      await queue.acceptContextPrivacy(f.env, {
        store: STORE, job: work.job, basis: work.basis, bytes: json(review(accepted.payload_sha256)),
      })
      const plan = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
      const item = plan.ready.find((record) => record.job === withdrawnJob)
      await queue.saveContextSent(f.env, STORE, [item], 102)
      await online(f, { plan, readMain: async () => ({ blobs: new Map([[item.path, item.sha]]), unknown: false }) })
      await writeFile(join(g.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: false } }))
    }
    await updateStatus(f.env, (status) => ({ ...status, context_planning: { [STORE]: "prepare" } }))
    const storeDir = join([...activeFiles][0], "..", "..")
    const published = new Set()
    let withdrawal = false
    for (let turn = 0; turn < 4; turn += 1) {
      let elapsed = 0
      const plan = await withFsFault(t, {
        readdir: async (original, file, ...args) => {
          const result = await original(file, ...args)
          if (String(file) === storeDir) elapsed += 1200
          return result
        },
        readFile: (original, file, ...args) => {
          if (activeFiles.has(String(file))) elapsed += 400
          return original(file, ...args)
        },
      }, () => queue.planContextPublication(f.env, {
        ...f.options, now: 1000, deadline: 2000, clock: () => elapsed,
      }), fsNative.promises)
      for (const item of plan.ready) published.add(item.job)
      withdrawal ||= plan.work && plan.states.some((item) => item.state.job === withdrawnJob && item.withdrawn)
      assert.ok(elapsed <= 2000)
    }
    assert.equal(published.size, 2, "reviewed tasks must advance even when preparation uses all of its first turn")
    if (withdraw) assert.equal(withdrawal, true, "revoked prose cannot wait forever behind unchanged preparation")
  })
}

test("corrupt planning turns cannot silently choose a phase or publish wording", async () => {
  const f = await reviewed()
  for (const value of [null, [], "prepare", { [STORE]: null }, { [STORE]: "unexpected" }]) {
    await updateStatus(f.env, (status) => ({ ...status, context_planning: value }))
    await assert.rejects(queue.planContextPublication(f.env, { ...f.options, now: 1000 }),
      { message: "context_planning_state_invalid" })
  }
})

test("planning turns keep other stores' scheduling and readiness records intact", async () => {
  const f = await reviewed()
  await updateStatus(f.env, (status) => ({
    ...status,
    context_planning: { [STORE]: "prepare", "synthetic/other": "publish" },
    context_publication: { "synthetic/other": { ready: false, code: "context_store_not_ready" } },
  }))
  await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  const status = await readStatus(f.env)
  assert.equal(status.context_planning[STORE], "publish")
  assert.equal(status.context_planning["synthetic/other"], "publish")
  assert.deepEqual(status.context_publication["synthetic/other"], { ready: false, code: "context_store_not_ready" })
})

test("prose revoked during discovery cannot create a task input at persistence", async () => {
  const f = await fixture()
  const result = await queue.prepareTaskContexts(f.env, {
    ...f.options,
    readRemote: () => {
      fsNative.writeFileSync(join(f.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: false } }))
      return null
    },
  })
  assert.equal(result.prepared, 0)
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
})

test("source identities becoming duplicates during discovery cannot create an input", async () => {
  const f = await fixture()
  const entry = structuredClone(f.entries[0])
  entry.facts.session.id = "22222222-1234-4abc-8abc-123456789abc"
  f.entries.push(entry)
  const result = await queue.prepareTaskContexts(f.env, {
    ...f.options,
    readRemote: () => {
      entry.facts.session.id = f.facts.session.id
      return null
    },
  })
  assert.equal(result.prepared, 0)
  assert.equal(result.held, 1)
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
})

test("prevalidated task groups cannot prepare new inputs after the prose policy is withdrawn", async (t) => {
  const f = await prepared()
  const stateFile = await taskContextPath(f.env, STORE, f.work.job, "state.json")
  const storeDir = join(stateFile, "..", "..")
  let revoked = false
  await withFsFault(t, {
    readdir: async (original, file, ...args) => {
      const result = await original(file, ...args)
      if (String(file) === storeDir && !revoked) {
        revoked = true
        await writeFile(join(f.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: false } }))
      }
      return result
    },
  }, () => queue.planContextPublication(f.env, { ...f.options, pluginVersion: "3.2.0-alpha.2", now: 1000 }), fsNative.promises)
  assert.equal(revoked, true)
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).basis, f.work.basis)
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
})

test("an atomic send cannot overwrite a different valid publication receipt written before it acquires the lock", async (t) => {
  const f = await reviewed()
  const before = await storedState(f)
  await queue.saveContextSent(f.env, STORE, [f.item], 102)
  const winner = await storedState(f)
  await writeFile(await taskContextPath(f.env, STORE, CONTEXT_JOB, "state.json"), json(before))
  await atStateLock(t, f, winner, () => queue.saveContextSent(f.env, STORE, [f.item], 101))
  assert.deepEqual(await storedState(f), winner)
  const plan = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  assert.deepEqual([...plan.prs], [102])
})

test("refusal accounting preserves a newer publication receipt and retries the same PR without double counting", async (t) => {
  const f = await reviewed()
  await queue.saveContextSent(f.env, STORE, [f.item], 101)
  const before = await storedState(f)
  await queue.saveContextSent(f.env, STORE, [{ ...f.item, sha: "e".repeat(40) }], 101)
  const winner = await storedState(f)
  await writeFile(await taskContextPath(f.env, STORE, CONTEXT_JOB, "state.json"), json(before))
  const plan = { refusedPrs: new Set([101]) }
  await atStateLock(t, f, winner, () => assert.rejects(
    queue.saveContextRefused(f.env, STORE, plan, "context_source_changed", 1000),
    /context_publication_changed/u,
  ))
  assert.deepEqual(await storedState(f), winner)
  await queue.saveContextRefused(f.env, STORE, plan, "context_source_changed", 1000)
  await queue.saveContextRefused(f.env, STORE, plan, "context_source_changed", 1000)
  assert.equal((await storedState(f)).refusals, 1)
  assert.equal((await storedState(f)).pr, null)
})

test("publication holds unknown main and missing authority without sending reviewed context", async () => {
  const unknown = await reviewed()
  assert.deepEqual(await online(unknown, { readMain: async () => ({ blobs: new Map(), unknown: true }) }), [])
  assert.equal((await readStatus(unknown.env)).context_publication[STORE].code, "context_main_unknown")
  const indirect = await reviewed()
  assert.deepEqual(await online(indirect, { direct: false, client: { api: () => assert.fail("no direct authority") } }), [])
  assert.equal((await readStatus(indirect.env)).context_publication[STORE].code, "context_authority_unavailable")
})

test("a job removed or withdrawn during the online check cannot publish a cached ready record", async () => {
  for (const change of ["missing", "consent"]) for (const pendingPr of [null, 101]) {
    const f = await reviewed()
    const client = { api: async (...args) => {
      if (change === "missing") {
        const file = await taskContextPath(f.env, STORE, CONTEXT_JOB, "state.json")
        await rename(file, `${file}.preserved`)
      } else await setConsent(f.env, { store: STORE, contribute: false, account: "synthetic" })
      return capabilityClient.api(...args)
    } }
    assert.deepEqual(await online(f, { client, pendingPr, entries: f.entries }), [])
  }
})

test("a changed review receipt or staged hash cannot pass final online preparation", async () => {
  for (const change of ["review", "hash"]) {
    const f = await reviewed()
    if (change === "review") await updateTaskContextState(f.env, STORE, CONTEXT_JOB, (state) => ({ ...state, review_seal: "f".repeat(64) }))
    else f.plan.ready[0] = { ...f.item, sha: "f".repeat(40) }
    assert.deepEqual(await online(f), [])
  }
})

test("a foreign main blob is a collision, never a record this machine can overwrite or retract", async () => {
  const f = await reviewed()
  const main = { blobs: new Map([[f.item.path, "f".repeat(40)]]), unknown: false }
  assert.deepEqual(await online(f, { readMain: async () => main }), [])
  assert.equal((await readStatus(f.env)).context_publication[STORE].code, "context_collision")
  const owned = await reviewed()
  await queue.saveContextSent(owned.env, STORE, [owned.item], 101)
  assert.deepEqual(await online(owned, { readMain: async () => ({ blobs: new Map([[owned.item.path, owned.item.sha]]), unknown: false }) }), [])
  await writeFile(join(owned.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: false } }))
  owned.plan = await queue.planContextPublication(owned.env, { ...owned.options, now: 1000 })
  assert.deepEqual(await online(owned, { readMain: async () => main }), [])
  assert.equal((await storedState(owned)).published_sha, owned.item.sha)
})

test("refusals belong to the sent basis and an obsolete refusal cannot punish a new source generation", async () => {
  const f = await reviewed()
  await queue.saveContextSent(f.env, STORE, [f.item], 101)
  const plan = await queue.planContextPublication(f.env, { ...f.options, now: 1000 })
  f.facts.session.duration_ms += 1
  await queue.prepareTaskContexts(f.env, f.options)
  const basis = (await storedState(f)).basis
  await queue.saveContextRefused(f.env, STORE, plan, "context_source_changed", 1000)
  const after = await storedState(f)
  assert.equal(after.basis, basis)
  assert.equal(after.refusals, 0)
  assert.equal(after.phase, "candidate")
})

test("three actual sent-basis refusals hold the record even when the older refusal counter is malformed", async () => {
  const f = await reviewed()
  await updateTaskContextState(f.env, STORE, CONTEXT_JOB, (state) => ({ ...state, refusals: null }))
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const now = 1000 + attempt * 86400000
    await queue.saveContextSent(f.env, STORE, [f.item], 100 + attempt)
    const plan = await queue.planContextPublication(f.env, { ...f.options, now })
    await queue.saveContextRefused(f.env, STORE, plan, "context_source_changed", now)
    const state = await storedState(f)
    assert.equal(state.refusals, attempt)
    assert.equal(state.hold_until, now + 86400000)
  }
  assert.equal((await storedState(f)).phase, "refused")
  assert.equal((await storedState(f)).record, null)
})

test("a newly refused explanation withdraws prior owned prose without fabricating privacy approval", async () => {
  const f = await reviewed()
  await queue.saveContextSent(f.env, STORE, [f.item], 101)
  await online(f, { readMain: async () => ({ blobs: new Map([[f.item.path, f.item.sha]]), unknown: false }) })
  f.facts.session.duration_ms += 1
  await queue.prepareTaskContexts(f.env, f.options)
  const [work] = await queue.listContextWork(f.env, { store: STORE })
  const current = { ...f, work }
  const accepted = await acceptedCandidate(current)
  await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: work.basis,
    bytes: json(review(accepted.payload_sha256, "withheld")) })
  const [clear] = await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries })
  const record = JSON.parse(clear.bytes)
  assert.equal(clear.invalidation, true)
  assert.deepEqual(record.coverage.reasons, ["not_recorded"])
  assert.equal(record.privacy.verdict, "not_required")
  assert.equal(record.privacy.reviewer, null)
  assert.equal(record.heading, null)
  assert.deepEqual(record.events, [])
})

test("only exact context blob entries from a Git tree can occupy the public job namespace", async () => {
  const result = await queue.contextOnBranch(async (tree) => tree === "root"
    ? new Map([["context", { type: "tree", sha: "children" }]])
    : new Map([[`${CONTEXT_JOB}.json`, { type: "blob", sha: "a".repeat(40) }],
      ["notes.json", { type: "blob", sha: "b".repeat(40) }],
      [`${"f".repeat(32)}.json`, { type: "tree", sha: "c".repeat(40) }]]), "root")
  assert.deepEqual(result, new Map([[`context/${CONTEXT_JOB}.json`, "a".repeat(40)]]))
})
