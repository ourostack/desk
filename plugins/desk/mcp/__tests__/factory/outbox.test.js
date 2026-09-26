// The local outbox and consent: owner-only state, never inside a Git
// checkout, never through a symlink or a hard link. Every test runs against
// a throwaway HOME/XDG_STATE_HOME (never the real `~/.local/state`) and
// always cleans up.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  clearFinalize,
  factoryStateRoot,
  gitBlobSha,
  listFinalizeRequests,
  listMarkers,
  markDelivered,
  pendingFiles,
  quarantine,
  readConsent,
  readJobsIndex,
  readMachineSecret,
  readStatus,
  readVisibilityCache,
  requestFinalize,
  setConsent,
  updateJobsIndex,
  writeLocalFacts,
  writeMarker,
  writeStatus,
  writeVisibilityCache,
} from "../../src/factory/outbox.js"

const nativeMac = { skip: process.platform !== "darwin" }

// Every best-effort cleanup unlink in outbox.js ends `.catch(() => {})`: the
// target might already be gone (another process's own cleanup, or a
// stale-lock race), and that must never surface as an error. Exercising the
// swallow itself (not just the surrounding function) means making that
// specific unlink genuinely fail: this pre-removes `targetFile` for real the
// moment code under test tries to unlink it, so the real `fs.unlink` call
// that follows throws an authentic `ENOENT` rather than a fabricated one —
// safe to call more than once, since every call after the first also finds
// it already gone.
async function withFailingUnlink(t, targetFile, run) {
  return withFailingUnlinkMatching(t, (target) => target === targetFile, run)
}

// Same as `withFailingUnlink`, but for a target whose exact path can't be
// known ahead of time (a randomly-named temp file): `matches(target)` picks
// which calls to force-fail.
async function withFailingUnlinkMatching(t, matches, run) {
  const original = fs.unlink.bind(fs)
  const mocked = t.mock.method(fs, "unlink", async (target, ...rest) => {
    if (matches(target)) await original(target).catch(() => {})
    return original(target, ...rest)
  })
  try {
    return await run()
  } finally {
    mocked.mock.restore()
  }
}

async function scratch(run) {
  // macOS's tmpdir() is itself a symlink (`/var` -> `/private/var`); realpath
  // it up front so every test's expected path already matches what
  // `factoryStateRoot`'s own realpath resolution returns.
  const rawBase = mkdtempSync(path.join(os.tmpdir(), "desk-factory-outbox-"))
  const base = await fs.realpath(rawBase)
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return await run(env, base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function validLocalFacts(overrides = {}) {
  return {
    schema: "desk.factory.local/1",
    session: {
      host: "claude-code",
      id: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60",
      host_version: "2.1.282",
      entrypoint: "desktop",
      started_at: "2026-09-25T08:00:00.000Z",
      ended_at: "2026-09-25T09:30:00.000Z",
      end_reason: "prompt_input_exit",
      derived_through: "2026-09-25T09:30:00.000Z",
    },
    plugins: [{ name: "desk", version: "3.2.0-alpha.20" }],
    models: [{ id: "claude-opus-5-5", requests: 412, tokens: { input: 1200, output: 88000, cache_read: 9100000, cache_write: 410000, reasoning: null } }],
    agents: [{ n: 0, parent: null, model: "claude-opus-5-5" }],
    intervals: [{ kind: "turn", agent: 0, start: "2026-09-25T08:00:01.000Z", end: "2026-09-25T08:04:10.000Z" }],
    counts: { tool_calls: { shell: 1 }, tool_failures: {}, tool_retries: 0, api_retries: 0, compactions: 0 },
    refs: { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } },
    jobs: [],
    unavailable: [],
    ...overrides,
  }
}

const STORE = "ourostack/factory"
const JOB = "9f2c4b1a7d3e5f60718293a4b5c6d7e8"

function validMarker(overrides = {}) {
  return {
    schema_version: 1,
    host: "claude-code",
    session_id: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60",
    log_path: "/tmp/session.log",
    cwd: "/tmp/project",
    desk_root: "/tmp/desk",
    end_reason: "prompt_input_exit",
    ended_at: "2026-09-25T09:30:00.000Z",
    plugins: [{ name: "desk", version: "3.2.0-alpha.20" }],
    updated_at: "2026-09-25T09:30:00.000Z",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// factoryStateRoot: the protected root.
// ---------------------------------------------------------------------------

test("factoryStateRoot creates an owner-only directory chain ending in ouroboros-skills/desk/factory", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  assert.equal(root, path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory"))
  let cursor = env.XDG_STATE_HOME
  for (const segment of ["ouroboros-skills", "desk", "factory"]) {
    cursor = path.join(cursor, segment)
    assert.equal((await fs.stat(cursor)).mode & 0o777, 0o700)
  }
}))

test("factoryStateRoot defaults to process.env when no env is given", () => scratch(async (env) => {
  const originalHome = process.env.HOME
  const originalXdg = process.env.XDG_STATE_HOME
  process.env.HOME = env.HOME
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME
  try {
    assert.equal(await factoryStateRoot(), path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory"))
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalXdg === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalXdg
  }
}))

test("factoryStateRoot falls back to os.homedir() when HOME itself is unset or blank, as long as XDG_STATE_HOME is explicit", () => scratch(async (env) => {
  assert.equal(await factoryStateRoot({ XDG_STATE_HOME: env.XDG_STATE_HOME }), path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory"))
  assert.equal(await factoryStateRoot({ HOME: "   ", XDG_STATE_HOME: env.XDG_STATE_HOME }), path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory"))
}))

test("factoryStateRoot expands a ~ XDG_STATE_HOME against HOME, and ignores a blank one", () => scratch(async (env) => {
  const expanded = await factoryStateRoot({ HOME: env.HOME, XDG_STATE_HOME: "~/custom-state" })
  assert.equal(expanded, path.join(env.HOME, "custom-state", "ouroboros-skills", "desk", "factory"))
  const blank = await factoryStateRoot({ HOME: env.HOME, XDG_STATE_HOME: "   " })
  assert.equal(blank, path.join(env.HOME, ".local", "state", "ouroboros-skills", "desk", "factory"))
}))

test("factoryStateRoot is idempotent and repairs a mode that drifted", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  await fs.chmod(root, 0o755)
  assert.equal(await factoryStateRoot(env), root)
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700)
}))

test("factoryStateRoot refuses a state root inside a Git checkout", () => scratch(async (env) => {
  mkdirSync(env.XDG_STATE_HOME, { recursive: true })
  mkdirSync(path.join(env.HOME, ".git"), { recursive: true })
  await assert.rejects(() => factoryStateRoot(env), /refusing to write private factory state inside the Git checkout/u)
}))

test("factoryStateRoot refuses a symlinked ancestor of XDG_STATE_HOME before creating anything (resolved via realpath)", () => scratch(async (env, base) => {
  const realTarget = path.join(base, "elsewhere")
  mkdirSync(realTarget, { recursive: true })
  mkdirSync(path.join(realTarget, ".git"), { recursive: true })
  const linkedStateHome = path.join(base, "linked-state")
  symlinkSync(realTarget, linkedStateHome)
  await assert.rejects(
    () => factoryStateRoot({ HOME: env.HOME, XDG_STATE_HOME: path.join(linkedStateHome, "sub") }),
    /Git checkout/u,
  )
  // Nothing was created inside the checkout by the refused call.
  assert.deepEqual(readdirSync(realTarget).sort(), [".git"])
}))

test("factoryStateRoot refuses a symlinked path component among its own three segments", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const deskDir = path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk")
  rmSync(root, { recursive: true, force: true })
  rmSync(deskDir, { recursive: true, force: true })
  const decoy = path.join(env.HOME, "decoy")
  mkdirSync(decoy, { recursive: true })
  symlinkSync(decoy, deskDir)
  await assert.rejects(() => factoryStateRoot(env), /is a symlink/u)
}))

test("factoryStateRoot refuses a path component that is a plain file, not a directory", () => scratch(async (env) => {
  mkdirSync(env.XDG_STATE_HOME, { recursive: true })
  mkdirSync(path.join(env.XDG_STATE_HOME, "ouroboros-skills"), { recursive: true })
  writeFileSync(path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk"), "not a directory")
  await assert.rejects(() => factoryStateRoot(env), /is not a directory/u)
}))

test("factoryStateRoot clears an inherited macOS ACL grant on its own segments", nativeMac, () => scratch(async (env) => {
  mkdirSync(env.XDG_STATE_HOME, { recursive: true })
  execFileSync("/bin/chmod", ["+a", "everyone allow list,search", env.XDG_STATE_HOME], { timeout: 5000 })
  const root = await factoryStateRoot(env)
  for (const target of [path.join(env.XDG_STATE_HOME, "ouroboros-skills"), root]) {
    assert.doesNotMatch(execFileSync("/bin/ls", ["-ldeq", target], { encoding: "utf8" }), /^\s*\d+:/mu)
  }
  assert.match(execFileSync("/bin/ls", ["-ldeq", env.XDG_STATE_HOME], { encoding: "utf8" }), /everyone allow/u, "the shared state home is not ours to reconfigure")
}))

// ---------------------------------------------------------------------------
// Windows protection: injected platform: "win32" and a fake icacls runner,
// so this exercises the real call path on every CI platform, not only
// native Windows.
// ---------------------------------------------------------------------------

test("factoryStateRoot protects its own three segments on Windows via icacls, and never touches the shared state home", () => scratch(async (env) => {
  const calls = []
  const runner = (command, args) => calls.push([command, args])
  const root = await factoryStateRoot({ ...env, USERNAME: "ari" }, { platform: "win32", runner })
  assert.equal(calls.length, 3)
  for (const [command, args] of calls) {
    assert.equal(command, "icacls.exe")
    assert.deepEqual(args.slice(1, 3), ["/inheritance:r", "/grant:r"])
    assert.match(args.at(-1), /:\(OI\)\(CI\)\(F\)$/u)
  }
  assert.equal(calls.at(-1)[1][0], root)
  assert.equal(calls[0][1][0], path.join(env.XDG_STATE_HOME, "ouroboros-skills"))
}))

test("writeLocalFacts protects the outbox directory chain and the written file on Windows", () => scratch(async (env) => {
  const winEnv = { ...env, USERNAME: "ari" }
  await setConsent(winEnv, { store: STORE, contribute: true }, { platform: "win32", runner: () => {} })
  const calls = []
  const runner = (command, args) => calls.push(args)
  const result = await writeLocalFacts(winEnv, STORE, validLocalFacts(), { platform: "win32", runner })
  assert.equal(result.written, true)
  const fileCalls = calls.filter((args) => args.at(-1).endsWith("(F)") && !args.at(-1).includes("(OI)(CI)"))
  assert.ok(fileCalls.some((args) => args[0].endsWith(result.name)))
}))

test("readMachineSecret protects the secret file on Windows, both on creation and on a later read", () => scratch(async (env) => {
  const winEnv = { ...env, USERNAME: "ari" }
  const createCalls = []
  await readMachineSecret(winEnv, { platform: "win32", runner: (command, args) => createCalls.push(args) })
  assert.ok(createCalls.some((args) => args.at(-1).endsWith(":(F)") && path.basename(args[0]) === "machine-secret"))

  const readCalls = []
  await readMachineSecret(winEnv, { platform: "win32", runner: (command, args) => readCalls.push(args) })
  assert.ok(readCalls.some((args) => path.basename(args[0]) === "machine-secret"))
}))

test("the Windows ACL step refuses when neither USERNAME nor USER identifies the owner", () => scratch(async (env) => {
  await assert.rejects(
    () => factoryStateRoot(env, { platform: "win32", runner: () => {} }),
    /desk_factory: Windows ACL protection needs USERNAME/u,
  )
}))

// ---------------------------------------------------------------------------
// gitBlobSha: must match `git hash-object`.
// ---------------------------------------------------------------------------

test("gitBlobSha matches git hash-object for three sample payloads", () => {
  for (const sample of ["", "hello world\n", JSON.stringify({ a: 1, b: [2, 3] })]) {
    const expected = execFileSync("git", ["hash-object", "--stdin"], { input: sample, encoding: "utf8" }).trim()
    assert.equal(gitBlobSha(sample), expected)
    assert.equal(gitBlobSha(Buffer.from(sample, "utf8")), expected)
  }
})

// ---------------------------------------------------------------------------
// Consent.
// ---------------------------------------------------------------------------

test("readConsent defaults to an empty decision set", () => scratch(async (env) => {
  assert.deepEqual(await readConsent(env), { schema_version: 1, stores: {} })
}))

test("setConsent creates an intake_id on the first yes and keeps it on a later no", () => scratch(async (env) => {
  const yes = await setConsent(env, { store: STORE, contribute: true }, { now: () => "2026-01-01T00:00:00.000Z" })
  const record = yes.stores[STORE]
  assert.equal(record.contribute, true)
  assert.match(record.intake_id, /^[0-9a-f]{16}$/u)
  assert.equal(record.account, null)
  assert.equal(record.decided_at, "2026-01-01T00:00:00.000Z")

  const no = await setConsent(env, { store: STORE, contribute: false, account: "ari" }, { now: () => "2026-01-02T00:00:00.000Z" })
  const later = no.stores[STORE]
  assert.equal(later.contribute, false)
  assert.equal(later.intake_id, record.intake_id, "a later no keeps the existing intake_id")
  assert.equal(later.account, "ari")
  assert.equal((await readConsent(env)).stores[STORE].intake_id, record.intake_id)
}))

test("setConsent keeps intake_id null across repeated no decisions, and only mints one on a later yes", () => scratch(async (env) => {
  const first = await setConsent(env, { store: STORE, contribute: false })
  assert.equal(first.stores[STORE].intake_id, null)
  const second = await setConsent(env, { store: STORE, contribute: false })
  assert.equal(second.stores[STORE].intake_id, null)
  const third = await setConsent(env, { store: STORE, contribute: true })
  assert.match(third.stores[STORE].intake_id, /^[0-9a-f]{16}$/u)
}))

test("setConsent rejects a malformed store, a non-boolean contribute, a malformed account, and a missing options object", () => scratch(async (env) => {
  await assert.rejects(() => setConsent(env, { store: "not-a-repo", contribute: true }), TypeError)
  await assert.rejects(() => setConsent(env, { store: STORE, contribute: "yes" }), TypeError)
  await assert.rejects(() => setConsent(env, { store: STORE, contribute: true, account: "" }), TypeError)
  await assert.rejects(() => setConsent(env), TypeError)
}))

test("setConsent refuses to write through a symlinked consent.json", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const decoy = path.join(env.HOME, "decoy-consent.json")
  writeFileSync(decoy, "{}")
  symlinkSync(decoy, path.join(root, "consent.json"))
  await assert.rejects(() => readConsent(env), /is a symlink/u)
}))

test("setConsent writes are atomic: two writes leave no temp files and the final content is the second write", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  await setConsent(env, { store: STORE, contribute: false })
  const root = await factoryStateRoot(env)
  const leftovers = readdirSync(root).filter((name) => name.startsWith(".tmp-"))
  assert.deepEqual(leftovers, [])
  assert.equal((await readConsent(env)).stores[STORE].contribute, false)
  assert.equal((await fs.stat(path.join(root, "consent.json"))).mode & 0o777, 0o600)
}))

test("setConsent serializes 16 concurrent decisions for different stores so all 16 survive", () => scratch(async (env) => {
  const stores = Array.from({ length: 16 }, (_, index) => `owner/store-${index}`)
  await Promise.all(stores.map((store) => setConsent(env, { store, contribute: true })))
  const consent = await readConsent(env)
  assert.deepEqual(Object.keys(consent.stores).sort(), stores.slice().sort())
  for (const store of stores) assert.equal(consent.stores[store].contribute, true)
}))

test("a corrupt consent.json is moved aside and read as empty, not thrown", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const file = path.join(root, "consent.json")
  writeFileSync(file, "{ not valid json", { mode: 0o600 })
  const consent = await readConsent(env)
  assert.deepEqual(consent, { schema_version: 1, stores: {} })
  const siblings = readdirSync(root).filter((name) => name.startsWith("consent.json.corrupt-json"))
  assert.equal(siblings.length, 1)
}))

test("a second corrupt consent.json in the same session picks the next free corrupt-json sibling name", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const file = path.join(root, "consent.json")
  writeFileSync(`${file}.corrupt-json-1`, "already taken", { mode: 0o600 })
  writeFileSync(file, "{ not valid json", { mode: 0o600 })
  await readConsent(env)
  const siblings = readdirSync(root).filter((name) => name.startsWith("consent.json.corrupt-json")).sort()
  assert.deepEqual(siblings, ["consent.json.corrupt-json-1", "consent.json.corrupt-json-2"])
}))

// ---------------------------------------------------------------------------
// writeLocalFacts.
// ---------------------------------------------------------------------------

test("writeLocalFacts is a no-op when the store has no consent decision", () => scratch(async (env) => {
  const result = await writeLocalFacts(env, STORE, validLocalFacts())
  assert.deepEqual(result, { written: false, errors: [] })
  const root = await factoryStateRoot(env)
  assert.deepEqual(readdirSync(root).includes("outbox"), false)
}))

test("writeLocalFacts is a no-op when the store's consent is contribute: false", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: false })
  const result = await writeLocalFacts(env, STORE, validLocalFacts())
  assert.deepEqual(result, { written: false, errors: [] })
}))

test("writeLocalFacts never writes invalid facts, and reports the validator's errors", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const broken = validLocalFacts()
  delete broken.session.host
  const result = await writeLocalFacts(env, STORE, broken)
  assert.equal(result.written, false)
  assert.ok(result.errors.length > 0)
  const root = await factoryStateRoot(env)
  assert.deepEqual(readdirSync(root).includes("outbox"), false)
}))

test("writeLocalFacts writes valid facts to the outbox, owner-only, canonical bytes plus one newline", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const facts = validLocalFacts()
  const result = await writeLocalFacts(env, STORE, facts)
  assert.equal(result.written, true)
  assert.equal(result.name, "claude-code-3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60.json")
  const file = path.join(await factoryStateRoot(env), "outbox", "ourostack__factory", result.name)
  const bytes = await fs.readFile(file)
  assert.equal(bytes.toString("utf8"), `${JSON.stringify(facts)}\n`)
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
}))

test("storeSlug rejects a store that is not owner/repo", () => scratch(async (env) => {
  await assert.rejects(() => writeLocalFacts(env, "not-a-repo", validLocalFacts()), TypeError)
}))

test("a JSON read refuses a directory sitting where the file belongs, rather than silently treating it as absent", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "consent.json"))
  await assert.rejects(() => readConsent(env), /is not a regular file/u)
}))

test("a directory listing surfaces an unexpected error when a file sits where a directory belongs", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  writeFileSync(path.join(root, "markers"), "not a directory")
  await assert.rejects(() => listMarkers(env), (error) => error.code === "ENOTDIR")
}))

// ---------------------------------------------------------------------------
// pendingFiles / markDelivered / quarantine.
// ---------------------------------------------------------------------------

function published(tag) {
  return Buffer.from(JSON.stringify({ tag }))
}

test("pendingFiles is empty when the store has never been written to", () => scratch(async (env) => {
  assert.deepEqual(await pendingFiles(env, STORE, { publishedBytesFor: () => published("x") }), [])
}))

test("pendingFiles requires publishedBytesFor to be a function", () => scratch(async (env) => {
  await assert.rejects(() => pendingFiles(env, STORE, {}), TypeError)
}))

test("pendingFiles lists undelivered files, re-sends a file whose published bytes changed, skips an unchanged delivered one, excludes quarantine, and skips a file the transform can't publish", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const a = (await writeLocalFacts(env, STORE, validLocalFacts())).name
  const b = (await writeLocalFacts(env, STORE, validLocalFacts({
    session: { ...validLocalFacts().session, id: "4c1d2e5f-9b2e-5d3f-af4b-2c3d4e5f6071" },
  }))).name
  const c = (await writeLocalFacts(env, STORE, validLocalFacts({
    session: { ...validLocalFacts().session, id: "5d2e3f60-ac3f-6e40-b05c-3d4e5f607182" },
  }))).name

  const bytesFor = { [a]: published("a1"), [b]: published("b1"), [c]: null }
  const publishedBytesFor = (facts) => bytesFor[`${facts.session.host}-${facts.session.id}.json`]

  let pending = await pendingFiles(env, STORE, { publishedBytesFor })
  assert.deepEqual(pending.map((entry) => entry.name).sort(), [a, b].sort())
  assert.ok(Buffer.isBuffer(pending[0].localBytes))

  await markDelivered(env, STORE, { name: a, publishedBlobSha: gitBlobSha(bytesFor[a]) })
  await markDelivered(env, STORE, { name: b, publishedBlobSha: gitBlobSha(bytesFor[b]) })
  pending = await pendingFiles(env, STORE, { publishedBytesFor })
  assert.deepEqual(pending, [])

  bytesFor[a] = published("a2")
  pending = await pendingFiles(env, STORE, { publishedBytesFor })
  assert.deepEqual(pending.map((entry) => entry.name), [a])

  await quarantine(env, STORE, a, "implausible_session_span")
  pending = await pendingFiles(env, STORE, { publishedBytesFor })
  assert.deepEqual(pending, [])
}))

test("pendingFiles quarantines a file that fails to parse as JSON with reason invalid, rather than throwing", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const name = (await writeLocalFacts(env, STORE, validLocalFacts())).name
  const root = await factoryStateRoot(env)
  const outboxFile = path.join(root, "outbox", "ourostack__factory", name)
  await fs.writeFile(outboxFile, "{ not valid", { mode: 0o600 })
  const pending = await pendingFiles(env, STORE, { publishedBytesFor: () => published("x") })
  assert.deepEqual(pending, [])
  const quarantineFile = path.join(root, "quarantine", "ourostack__factory", name)
  assert.deepEqual(JSON.parse(await fs.readFile(quarantineFile, "utf8")).reason, "invalid")
}))

test("pendingFiles never follows a symlink planted in the outbox directory", () => scratch(async (env, base) => {
  await setConsent(env, { store: STORE, contribute: true })
  await writeLocalFacts(env, STORE, validLocalFacts())
  const root = await factoryStateRoot(env)
  const outboxDir = path.join(root, "outbox", "ourostack__factory")
  const secret = path.join(base, "secret.json")
  writeFileSync(secret, JSON.stringify(validLocalFacts({ session: { ...validLocalFacts().session, id: "6e3f4071-bd40-7f51-c16d-4e5f60718293" } })))
  const evilName = "claude-code-6e3f4071-bd40-7f51-c16d-4e5f60718293.json"
  symlinkSync(secret, path.join(outboxDir, evilName))
  const pending = await pendingFiles(env, STORE, { publishedBytesFor: () => published("x") })
  assert.deepEqual(pending.map((entry) => entry.name).sort(), [(await writeLocalFacts(env, STORE, validLocalFacts())).name].filter(Boolean).sort())
  assert.equal(pending.some((entry) => entry.name === evilName), false)
}))

test("markDelivered rejects a bad name or a malformed blob sha", () => scratch(async (env) => {
  await assert.rejects(() => markDelivered(env, STORE, { name: "", publishedBlobSha: "a".repeat(40) }), TypeError)
  await assert.rejects(() => markDelivered(env, STORE, { name: "x.json", publishedBlobSha: "not-a-sha" }), TypeError)
}))

test("markDelivered merges into the existing delivered map rather than replacing it, even under 16 concurrent writers", () => scratch(async (env) => {
  const names = Array.from({ length: 16 }, (_, index) => `claude-code-${String(index).padStart(8, "0")}-0000-4000-8000-000000000000.json`)
  await Promise.all(names.map((name) => markDelivered(env, STORE, { name, publishedBlobSha: gitBlobSha(name) })))
  const root = await factoryStateRoot(env)
  const delivered = JSON.parse(await fs.readFile(path.join(root, "delivered", "ourostack__factory.json"), "utf8"))
  assert.equal(Object.keys(delivered).length, 16)
  for (const name of names) assert.equal(delivered[name], gitBlobSha(name))
}))

test("quarantine rejects a name that isn't a real outbox file name (including .. and .) and a malformed reason code", () => scratch(async (env) => {
  await assert.rejects(() => quarantine(env, STORE, "..", "implausible_session_span"), TypeError)
  await assert.rejects(() => quarantine(env, STORE, ".", "implausible_session_span"), TypeError)
  await assert.rejects(() => quarantine(env, STORE, "a/b.json", "implausible_session_span"), TypeError)
  await assert.rejects(() => quarantine(env, STORE, "not-a-real-name.json", "implausible_session_span"), TypeError)
  const validName = "claude-code-3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60.json"
  await assert.rejects(() => quarantine(env, STORE, validName, "Not-Valid!"), TypeError)
}))

test("quarantine writes { reason, at } under the outbox file's own name", () => scratch(async (env) => {
  const validName = "claude-code-3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60.json"
  const record = await quarantine(env, STORE, validName, "session_id_not_v4", { now: () => "2026-01-01T00:00:00.000Z" })
  assert.deepEqual(record, { reason: "session_id_not_v4", at: "2026-01-01T00:00:00.000Z" })
  const file = path.join(await factoryStateRoot(env), "quarantine", "ourostack__factory", validName)
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), record)
}))

// ---------------------------------------------------------------------------
// Markers.
// ---------------------------------------------------------------------------

test("writeMarker writes markers/<host>-<session_id>.json and listMarkers reads it back", () => scratch(async (env) => {
  const marker = validMarker()
  await writeMarker(env, marker)
  assert.deepEqual(await listMarkers(env), [marker])
}))

test("writeMarker rejects a non-object, a wrong key set, a bad schema_version, a bad host and a bad session_id", () => scratch(async (env) => {
  await assert.rejects(() => writeMarker(env, null), TypeError)
  await assert.rejects(() => writeMarker(env, { ...validMarker(), extra: "field" }), TypeError)
  const missingKey = validMarker()
  delete missingKey.cwd
  await assert.rejects(() => writeMarker(env, missingKey), TypeError)
  await assert.rejects(() => writeMarker(env, validMarker({ schema_version: 2 })), TypeError)
  await assert.rejects(() => writeMarker(env, validMarker({ host: "cursor" })), TypeError)
  await assert.rejects(() => writeMarker(env, validMarker({ session_id: "not-a-uuid" })), TypeError)
  await assert.rejects(() => writeMarker(env, validMarker({ updated_at: "2026-01-01" })), TypeError)
}))

test("listMarkers is empty when nothing has been written yet", () => scratch(async (env) => {
  assert.deepEqual(await listMarkers(env), [])
}))

test("listMarkers ignores an entry whose name doesn't match the marker shape at all, such as a fresh leftover temp file", () => scratch(async (env) => {
  const marker = validMarker()
  await writeMarker(env, marker)
  const dir = path.join(await factoryStateRoot(env), "markers")
  writeFileSync(path.join(dir, ".tmp-not-a-marker-12345-abcdef00"), "leftover", { mode: 0o600 })
  assert.deepEqual(await listMarkers(env), [marker])
}))

test("listMarkers prunes a marker older than 30 days and keeps a fresh one", () => scratch(async (env) => {
  const stale = validMarker({ session_id: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60", updated_at: "2026-01-01T00:00:00.000Z" })
  const fresh = validMarker({ session_id: "4c1d2e5f-9b2e-5d3f-af4b-2c3d4e5f6071", updated_at: "2026-03-01T00:00:00.000Z" })
  await writeMarker(env, stale)
  await writeMarker(env, fresh)
  const now = () => "2026-03-05T00:00:00.000Z"
  const kept = await listMarkers(env, { now })
  assert.deepEqual(kept, [fresh])
  const dir = path.join(await factoryStateRoot(env), "markers")
  assert.deepEqual(readdirSync(dir), [`claude-code-${fresh.session_id}.json`])
}))

test("listMarkers prunes a marker whose updated_at cannot be parsed, rather than keeping it forever", () => scratch(async (env) => {
  const marker = validMarker()
  await writeMarker(env, marker)
  const file = path.join(await factoryStateRoot(env), "markers", `${marker.host}-${marker.session_id}.json`)
  await fs.writeFile(file, JSON.stringify({ ...marker, updated_at: "2026-01-01T00:00:00.000Z" }).replace('"updated_at":"2026-01-01T00:00:00.000Z"', '"updated_at":"garbage"'), { mode: 0o600 })
  assert.deepEqual(await listMarkers(env), [])
}))

test("a corrupt marker is dropped without blocking the rest", () => scratch(async (env) => {
  const good = validMarker()
  await writeMarker(env, good)
  const root = await factoryStateRoot(env)
  const badFile = path.join(root, "markers", "claude-code-4c1d2e5f-9b2e-5d3f-af4b-2c3d4e5f6071.json")
  await fs.writeFile(badFile, "{ not valid json", { mode: 0o600 })
  assert.deepEqual(await listMarkers(env), [good])
}))

test("dropping a corrupt marker tolerates it already being gone", (t) => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const badFile = path.join(root, "markers", "claude-code-4c1d2e5f-9b2e-5d3f-af4b-2c3d4e5f6071.json")
  await fs.mkdir(path.dirname(badFile), { recursive: true })
  await fs.writeFile(badFile, "{ not valid json", { mode: 0o600 })
  await withFailingUnlink(t, badFile, async () => {
    assert.deepEqual(await listMarkers(env), [])
  })
}))

test("pruning an expired marker tolerates it already being gone", (t) => scratch(async (env) => {
  const stale = validMarker({ updated_at: "2026-01-01T00:00:00.000Z" })
  await writeMarker(env, stale)
  const file = path.join(await factoryStateRoot(env), "markers", `${stale.host}-${stale.session_id}.json`)
  await withFailingUnlink(t, file, async () => {
    assert.deepEqual(await listMarkers(env, { now: () => "2026-03-05T00:00:00.000Z" }), [])
  })
}))

// ---------------------------------------------------------------------------
// Status.
// ---------------------------------------------------------------------------

test("readStatus defaults to an empty last_flush map", () => scratch(async (env) => {
  assert.deepEqual(await readStatus(env), { last_flush: {} })
}))

test("writeStatus merges last_flush per store rather than replacing the whole map", () => scratch(async (env) => {
  await writeStatus(env, { last_flush: { [STORE]: { at: "2026-01-01T00:00:00.000Z", result: "ok" } } })
  const next = await writeStatus(env, { last_flush: { "other/store": { at: "2026-01-02T00:00:00.000Z", result: "error" } } })
  assert.deepEqual(next.last_flush[STORE], { at: "2026-01-01T00:00:00.000Z", result: "ok" })
  assert.deepEqual(next.last_flush["other/store"], { at: "2026-01-02T00:00:00.000Z", result: "error" })
  assert.deepEqual(await readStatus(env), next)
}))

test("writeStatus merges top-level fields that aren't last_flush too", () => scratch(async (env) => {
  const next = await writeStatus(env, { note: "example" })
  assert.equal(next.note, "example")
  assert.deepEqual(next.last_flush, {})
}))

test("writeStatus rejects a non-object patch", () => scratch(async (env) => {
  await assert.rejects(() => writeStatus(env, null), TypeError)
  await assert.rejects(() => writeStatus(env, []), TypeError)
}))

// ---------------------------------------------------------------------------
// Visibility cache.
// ---------------------------------------------------------------------------

test("readVisibilityCache defaults to empty and writeVisibilityCache adds entries", () => scratch(async (env) => {
  assert.deepEqual(await readVisibilityCache(env), {})
  const next = await writeVisibilityCache(env, { [STORE]: { visibility: "public", checked_at: "2026-01-01T00:00:00.000Z" } })
  assert.deepEqual(next[STORE], { visibility: "public", checked_at: "2026-01-01T00:00:00.000Z" })
}))

test("readVisibilityCache omits an entry older than 7 days but keeps a fresh one", () => scratch(async (env) => {
  await writeVisibilityCache(env, {
    stale: { visibility: "public", checked_at: "2026-01-01T00:00:00.000Z" },
    fresh: { visibility: "private", checked_at: "2026-01-07T00:00:00.000Z" },
  })
  const cache = await readVisibilityCache(env, { now: () => "2026-01-09T00:00:00.000Z" })
  assert.deepEqual(Object.keys(cache), ["fresh"])
}))

test("writeVisibilityCache rejects a non-object patch and a non-object entry", () => scratch(async (env) => {
  await assert.rejects(() => writeVisibilityCache(env, "nope"), TypeError)
  await assert.rejects(() => writeVisibilityCache(env, { x: "nope" }), TypeError)
}))

test("writeVisibilityCache rejects an unknown visibility value or a malformed checked_at", () => scratch(async (env) => {
  await assert.rejects(() => writeVisibilityCache(env, { x: { visibility: "bogus free text", checked_at: "2026-01-01T00:00:00.000Z" } }), TypeError)
  await assert.rejects(() => writeVisibilityCache(env, { x: { visibility: "public", checked_at: "2026-01-01" } }), TypeError)
}))

// ---------------------------------------------------------------------------
// The machine secret.
// ---------------------------------------------------------------------------

test("readMachineSecret creates 32 owner-only bytes once and returns the same bytes afterward", () => scratch(async (env) => {
  const first = await readMachineSecret(env)
  assert.equal(first.length, 32)
  const second = await readMachineSecret(env)
  assert.deepEqual(first, second)
  const file = path.join(await factoryStateRoot(env), "machine-secret")
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
}))

test("16 concurrent first callers all return the identical machine secret", () => scratch(async (env) => {
  const results = await Promise.all(Array.from({ length: 16 }, () => readMachineSecret(env)))
  for (const result of results) assert.deepEqual(result, results[0])
}))

const isMachineSecretTmp = (target) => path.basename(target).startsWith(".tmp-machine-secret-")

test("creating the machine secret tolerates its own temp file already being gone after a successful link", (t) => scratch(async (env) => {
  await withFailingUnlinkMatching(t, isMachineSecretTmp, async () => {
    const secret = await readMachineSecret(env)
    assert.equal(secret.length, 32)
  })
}))

test("losing the machine-secret creation race tolerates the loser's own temp file already being gone", (t) => scratch(async (env) => {
  // Two callers race from a cold start: neither sees an existing secret, so
  // both reach `createMachineSecret` and attempt `link`; exactly one loses
  // with EEXIST and takes the cleanup path this test targets.
  await withFailingUnlinkMatching(t, isMachineSecretTmp, async () => {
    const [first, second] = await Promise.all([readMachineSecret(env), readMachineSecret(env)])
    assert.deepEqual(first, second)
  })
}))

test("a truncated machine-secret is rotated: moved aside, replaced, and status.json records secret_rotated", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const file = path.join(root, "machine-secret")
  await fs.writeFile(file, Buffer.alloc(3), { mode: 0o600 })
  const secret = await readMachineSecret(env)
  assert.equal(secret.length, 32)
  const siblings = readdirSync(root).filter((name) => name.startsWith("machine-secret.corrupt-"))
  assert.equal(siblings.length, 1)
  const status = await readStatus(env)
  assert.equal(status.machine_secret.status, "secret_rotated")
}))

test("readMachineSecret is never printed by this module", () => scratch(async (env) => {
  const logs = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args) => logs.push(args.join(" "))
  console.error = (...args) => logs.push(args.join(" "))
  try {
    const secret = await readMachineSecret(env)
    const hex = secret.toString("hex")
    for (const line of logs) assert.equal(line.includes(hex), false)
    assert.deepEqual(logs, [])
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}))

test("readMachineSecret propagates an unexpected failure linking the secret into place, rather than swallowing it", (t) => scratch(async (env) => {
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" })
  const mocked = t.mock.method(fs, "link", async () => {
    throw failure
  })
  try {
    await assert.rejects(() => readMachineSecret(env), (error) => error === failure)
  } finally {
    mocked.mock.restore()
  }
}))

test("readMachineSecret refuses a persistently hard-linked machine-secret (not just a transient self-created one)", () => scratch(async (env, base) => {
  await readMachineSecret(env)
  const root = await factoryStateRoot(env)
  const file = path.join(root, "machine-secret")
  const decoy = path.join(base, "decoy-link")
  await fs.link(file, decoy)
  await assert.rejects(() => readMachineSecret(env), /is hard-linked/u)
}))

test("readMachineSecret refuses a symlinked machine-secret", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const decoy = path.join(env.HOME, "decoy-secret")
  writeFileSync(decoy, Buffer.alloc(32))
  symlinkSync(decoy, path.join(root, "machine-secret"))
  await assert.rejects(() => readMachineSecret(env), /is a symlink/u)
}))

// ---------------------------------------------------------------------------
// Finalize requests.
// ---------------------------------------------------------------------------

test("requestFinalize writes finalize/<job>.json and listFinalizeRequests reads it back", () => scratch(async (env) => {
  const record = await requestFinalize(env, { job: JOB, deskRoot: "/tmp/desk" }, { now: () => "2026-01-01T00:00:00.000Z" })
  assert.deepEqual(record, { schema_version: 1, job: JOB, desk_root: "/tmp/desk", requested_at: "2026-01-01T00:00:00.000Z" })
  assert.deepEqual(await listFinalizeRequests(env), [record])
}))

test("requestFinalize rejects a malformed job id or a relative desk root", () => scratch(async (env) => {
  await assert.rejects(() => requestFinalize(env, { job: "not-hex", deskRoot: "/tmp/desk" }), TypeError)
  await assert.rejects(() => requestFinalize(env, { job: JOB, deskRoot: "relative/path" }), TypeError)
}))

test("listFinalizeRequests is empty when nothing is pending, and skips a corrupt request rather than throwing", () => scratch(async (env) => {
  assert.deepEqual(await listFinalizeRequests(env), [])
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "finalize"), { recursive: true })
  await fs.writeFile(path.join(root, "finalize", `${JOB}.json`), "{ not valid", { mode: 0o600 })
  assert.deepEqual(await listFinalizeRequests(env), [])
}))

test("clearFinalize removes a request and is a no-op when it's already gone", () => scratch(async (env) => {
  await requestFinalize(env, { job: JOB, deskRoot: "/tmp/desk" })
  await clearFinalize(env, JOB)
  assert.deepEqual(await listFinalizeRequests(env), [])
  await clearFinalize(env, JOB)
}))

test("clearFinalize rejects a malformed job id", () => scratch(async (env) => {
  await assert.rejects(() => clearFinalize(env, "nope"), TypeError)
}))

test("clearFinalize surfaces an unexpected failure removing the request, rather than treating it as already gone", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "finalize", `${JOB}.json`), { recursive: true })
  await assert.rejects(() => clearFinalize(env, JOB), (error) => error.code !== "ENOENT")
}))

test("withLock propagates an unexpected failure creating the lock file itself", (t) => scratch(async (env) => {
  const failure = Object.assign(new Error("denied"), { code: "EACCES" })
  const mocked = t.mock.method(fs, "open", async () => {
    throw failure
  })
  try {
    await assert.rejects(() => setConsent(env, { store: STORE, contribute: true }), (error) => error === failure)
  } finally {
    mocked.mock.restore()
  }
}))

test("listFinalizeRequests never follows a symlink planted in the finalize directory", () => scratch(async (env, base) => {
  await requestFinalize(env, { job: JOB, deskRoot: "/tmp/desk" })
  const root = await factoryStateRoot(env)
  const secret = path.join(base, "secret-finalize.json")
  writeFileSync(secret, JSON.stringify({ schema_version: 1, job: "a".repeat(32), desk_root: "/tmp/evil", requested_at: "2026-01-01T00:00:00.000Z" }))
  symlinkSync(secret, path.join(root, "finalize", `${"a".repeat(32)}.json`))
  const requests = await listFinalizeRequests(env)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].job, JOB)
}))

// ---------------------------------------------------------------------------
// Jobs index.
// ---------------------------------------------------------------------------

test("readJobsIndex defaults to empty and updateJobsIndex adds and dedupes file names", () => scratch(async (env) => {
  assert.deepEqual(await readJobsIndex(env), {})
  await updateJobsIndex(env, JOB, "claude-code-a.json")
  const next = await updateJobsIndex(env, JOB, "claude-code-a.json")
  assert.deepEqual(next[JOB], ["claude-code-a.json"])
  const withSecond = await updateJobsIndex(env, JOB, "claude-code-b.json")
  assert.deepEqual(withSecond[JOB], ["claude-code-a.json", "claude-code-b.json"])
}))

test("updateJobsIndex rejects a malformed job id or file name", () => scratch(async (env) => {
  await assert.rejects(() => updateJobsIndex(env, "nope", "a.json"), TypeError)
  await assert.rejects(() => updateJobsIndex(env, JOB, ""), TypeError)
}))

test("updateJobsIndex serializes 16 concurrent updates for different jobs so all 16 survive", () => scratch(async (env) => {
  const jobs = Array.from({ length: 16 }, (_, index) => `${String(index).padStart(2, "0")}${JOB.slice(2)}`)
  await Promise.all(jobs.map((job) => updateJobsIndex(env, job, "claude-code-x.json")))
  const index = await readJobsIndex(env)
  assert.deepEqual(Object.keys(index).sort(), jobs.slice().sort())
}))

// ---------------------------------------------------------------------------
// Locking: stale-lock recovery.
// ---------------------------------------------------------------------------

test("a stale lock file (older than 10 minutes) is recovered rather than waited on forever", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const lockFile = path.join(root, "consent.json.lock")
  await fs.writeFile(lockFile, JSON.stringify({ pid: 999999, started_at: "2000-01-01T00:00:00.000Z" }), { mode: 0o600 })
  // Staleness is judged from the lock file's own filesystem mtime, never
  // from its content (see withLock's comment for why): back-date it for
  // real so this test exercises the actual staleness check.
  const old = new Date(Date.now() - 20 * 60 * 1000)
  await fs.utimes(lockFile, old, old)
  const result = await setConsent(env, { store: STORE, contribute: true })
  assert.equal(result.stores[STORE].contribute, true)
}))

test("a lock file holding unparseable content is still judged by its mtime, not its content", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  await fs.mkdir(root, { recursive: true })
  const lockFile = path.join(root, "consent.json.lock")
  await fs.writeFile(lockFile, "not json", { mode: 0o600 })
  const old = new Date(Date.now() - 20 * 60 * 1000)
  await fs.utimes(lockFile, old, old)
  const result = await setConsent(env, { store: STORE, contribute: true })
  assert.equal(result.stores[STORE].contribute, true)
}))

test("removing a stale lock tolerates it already being gone (another waiter won the same race)", (t) => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const lockFile = path.join(root, "consent.json.lock")
  await fs.writeFile(lockFile, "held", { mode: 0o600 })
  const old = new Date(Date.now() - 20 * 60 * 1000)
  await fs.utimes(lockFile, old, old)
  await withFailingUnlink(t, lockFile, async () => {
    const result = await setConsent(env, { store: STORE, contribute: true })
    assert.equal(result.stores[STORE].contribute, true)
  })
}))

test("releasing a held lock tolerates it already being gone by the time the write finishes", (t) => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const lockFile = path.join(root, "consent.json.lock")
  await withFailingUnlink(t, lockFile, async () => {
    const result = await setConsent(env, { store: STORE, contribute: true })
    assert.equal(result.stores[STORE].contribute, true)
  })
}))

test("a lock file that vanishes between a waiter's failed open and its own staleness check is retried immediately, not treated as a real stale lock", (t) => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const lockFile = path.join(root, "consent.json.lock")
  await fs.writeFile(lockFile, "held", { mode: 0o600 })
  const originalStat = fs.stat.bind(fs)
  let firstCall = true
  const mocked = t.mock.method(fs, "stat", async (target, ...rest) => {
    if (firstCall && target === lockFile) {
      firstCall = false
      await fs.unlink(lockFile).catch(() => {})
      throw Object.assign(new Error("gone"), { code: "ENOENT" })
    }
    return originalStat(target, ...rest)
  })
  try {
    const result = await setConsent(env, { store: STORE, contribute: true })
    assert.equal(result.stores[STORE].contribute, true)
  } finally {
    mocked.mock.restore()
  }
}))

// ---------------------------------------------------------------------------
// Stale temp-file cleanup.
// ---------------------------------------------------------------------------

test("a stale (older than one hour) leftover temp file is swept on the next write to that folder", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const staleTmp = path.join(root, ".tmp-consent.json-99999-deadbeef")
  await fs.writeFile(staleTmp, "leftover", { mode: 0o600 })
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await fs.utimes(staleTmp, old, old)
  await setConsent(env, { store: STORE, contribute: true })
  assert.equal(readdirSync(root).includes(path.basename(staleTmp)), false)
}))

test("the stale-temp-file sweep tolerates its own unlink losing a race (the file is already gone)", (t) => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const staleTmp = path.join(root, ".tmp-consent.json-77777-racedaway")
  await fs.writeFile(staleTmp, "leftover", { mode: 0o600 })
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await fs.utimes(staleTmp, old, old)
  await withFailingUnlink(t, staleTmp, () => setConsent(env, { store: STORE, contribute: true }))
}))

test("a fresh (under one hour) leftover temp file is left alone by an unrelated write", () => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const freshTmp = path.join(root, ".tmp-consent.json-88888-cafebabe")
  await fs.writeFile(freshTmp, "leftover", { mode: 0o600 })
  await setConsent(env, { store: STORE, contribute: true })
  assert.equal(readdirSync(root).includes(path.basename(freshTmp)), true)
}))

test("the stale-temp-file sweep tolerates one entry vanishing mid-sweep (another writer's own cleanup) and still sweeps the rest", (t) => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const vanishing = path.join(root, ".tmp-consent.json-11111-vanish00")
  const stale = path.join(root, ".tmp-consent.json-22222-staleaaa")
  await fs.writeFile(vanishing, "x", { mode: 0o600 })
  await fs.writeFile(stale, "x", { mode: 0o600 })
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await fs.utimes(stale, old, old)
  const originalStat = fs.stat.bind(fs)
  const mocked = t.mock.method(fs, "stat", async (target, ...rest) => {
    if (target === vanishing) throw Object.assign(new Error("gone"), { code: "ENOENT" })
    return originalStat(target, ...rest)
  })
  try {
    await setConsent(env, { store: STORE, contribute: true })
  } finally {
    mocked.mock.restore()
  }
  const remaining = readdirSync(root)
  assert.equal(remaining.includes(path.basename(stale)), false)
}))

test("withLock propagates an unexpected failure checking a held lock's staleness, rather than swallowing it", (t) => scratch(async (env) => {
  const root = await factoryStateRoot(env)
  const lockFile = path.join(root, "consent.json.lock")
  await fs.writeFile(lockFile, "held", { mode: 0o600 })
  const failure = Object.assign(new Error("denied"), { code: "EACCES" })
  const mocked = t.mock.method(fs, "stat", async () => {
    throw failure
  })
  try {
    await assert.rejects(() => setConsent(env, { store: STORE, contribute: true }), (error) => error === failure)
  } finally {
    mocked.mock.restore()
  }
}))
