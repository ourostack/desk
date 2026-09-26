// The local outbox and consent: owner-only state, never inside a Git
// checkout, never through a symlink. Every test runs against a throwaway
// HOME/XDG_STATE_HOME (never the real `~/.local/state`) and always cleans up.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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

function scratch(run) {
  const base = mkdtempSync(path.join(os.tmpdir(), "desk-factory-outbox-"))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return run(env, base)
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

function noSymlinkFiles(dir) {
  return readdirSync(dir)
}

// ---------------------------------------------------------------------------
// factoryStateRoot: the protected root.
// ---------------------------------------------------------------------------

test("factoryStateRoot creates an owner-only directory chain ending in ouroboros-skills/desk/factory", () => {
  scratch((env) => {
    const root = factoryStateRoot(env)
    assert.equal(root, path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory"))
    let cursor = env.XDG_STATE_HOME
    for (const segment of ["ouroboros-skills", "desk", "factory"]) {
      cursor = path.join(cursor, segment)
      assert.equal(readFileSyncMode(cursor), 0o700)
    }
  })
})

function readFileSyncMode(target) {
  return statSync(target).mode & 0o777
}

test("factoryStateRoot falls back to ~/.local/state when XDG_STATE_HOME is unset or blank", () => {
  scratch((env) => {
    const noXdg = { HOME: env.HOME }
    assert.equal(factoryStateRoot(noXdg), path.join(env.HOME, ".local", "state", "ouroboros-skills", "desk", "factory"))
    const blankXdg = { HOME: env.HOME, XDG_STATE_HOME: "   " }
    assert.equal(factoryStateRoot(blankXdg), path.join(env.HOME, ".local", "state", "ouroboros-skills", "desk", "factory"))
  })
})

test("factoryStateRoot defaults to process.env when no env is given", () => {
  scratch((env) => {
    const originalHome = process.env.HOME
    const originalXdg = process.env.XDG_STATE_HOME
    process.env.HOME = env.HOME
    process.env.XDG_STATE_HOME = env.XDG_STATE_HOME
    try {
      assert.equal(factoryStateRoot(), path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory"))
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalXdg === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = originalXdg
    }
  })
})

test("factoryStateRoot falls back to os.homedir() when HOME itself is unset, as long as XDG_STATE_HOME is explicit", () => {
  scratch((env) => {
    const noHome = { XDG_STATE_HOME: env.XDG_STATE_HOME }
    assert.equal(factoryStateRoot(noHome), path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory"))
  })
})

test("factoryStateRoot is idempotent and repairs a mode that drifted", () => {
  scratch((env) => {
    const root = factoryStateRoot(env)
    chmodSync(root, 0o755)
    assert.equal(factoryStateRoot(env), root)
    assert.equal(statSync(root).mode & 0o777, 0o700)
  })
})

test("factoryStateRoot refuses a state root inside a Git checkout", () => {
  scratch((env) => {
    mkdirSync(env.XDG_STATE_HOME, { recursive: true })
    mkdirSync(path.join(env.HOME, ".git"), { recursive: true })
    assert.throws(() => factoryStateRoot(env), (error) => {
      assert.equal(error.code, "unsafe_state_root")
      assert.match(error.message, /Git checkout/u)
      return true
    })
  })
})

test("factoryStateRoot refuses a symlinked path component", () => {
  scratch((env) => {
    const root = factoryStateRoot(env)
    const deskDir = path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk")
    rmSync(root, { recursive: true, force: true })
    rmSync(deskDir, { recursive: true, force: true })
    const decoy = path.join(env.HOME, "decoy")
    mkdirSync(decoy, { recursive: true })
    symlinkSync(decoy, deskDir)
    assert.throws(() => factoryStateRoot(env), (error) => {
      assert.equal(error.code, "unsafe_state_root")
      assert.match(error.message, /symlink/u)
      return true
    })
  })
})

test("factoryStateRoot refuses a path component that is a plain file, not a directory", () => {
  scratch((env) => {
    mkdirSync(env.XDG_STATE_HOME, { recursive: true })
    mkdirSync(path.join(env.XDG_STATE_HOME, "ouroboros-skills"), { recursive: true })
    writeFileSync(path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk"), "not a directory")
    assert.throws(() => factoryStateRoot(env), (error) => {
      assert.equal(error.code, "unsafe_state_root")
      assert.match(error.message, /not a directory/u)
      return true
    })
  })
})

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

test("readConsent defaults to an empty decision set", () => {
  scratch((env) => {
    assert.deepEqual(readConsent(env), { schema_version: 1, stores: {} })
  })
})

test("setConsent creates an intake_id on the first yes and keeps it on a later no", () => {
  scratch((env) => {
    const yes = setConsent(env, { store: STORE, contribute: true }, { now: () => "2026-01-01T00:00:00.000Z" })
    const record = yes.stores[STORE]
    assert.equal(record.contribute, true)
    assert.match(record.intake_id, /^[0-9a-f]{16}$/u)
    assert.equal(record.account, null)
    assert.equal(record.decided_at, "2026-01-01T00:00:00.000Z")

    const no = setConsent(env, { store: STORE, contribute: false, account: "ari" }, { now: () => "2026-01-02T00:00:00.000Z" })
    const later = no.stores[STORE]
    assert.equal(later.contribute, false)
    assert.equal(later.intake_id, record.intake_id, "a later no keeps the existing intake_id")
    assert.equal(later.account, "ari")
    assert.equal(readConsent(env).stores[STORE].intake_id, record.intake_id)
  })
})

test("setConsent keeps intake_id null across repeated no decisions, and only mints one on a later yes", () => {
  scratch((env) => {
    const first = setConsent(env, { store: STORE, contribute: false })
    assert.equal(first.stores[STORE].intake_id, null)
    const second = setConsent(env, { store: STORE, contribute: false })
    assert.equal(second.stores[STORE].intake_id, null)
    const third = setConsent(env, { store: STORE, contribute: true })
    assert.match(third.stores[STORE].intake_id, /^[0-9a-f]{16}$/u)
  })
})

test("setConsent rejects a malformed store, a non-boolean contribute, a malformed account, and a missing options object", () => {
  scratch((env) => {
    assert.throws(() => setConsent(env, { store: "not-a-repo", contribute: true }), TypeError)
    assert.throws(() => setConsent(env, { store: STORE, contribute: "yes" }), TypeError)
    assert.throws(() => setConsent(env, { store: STORE, contribute: true, account: "" }), TypeError)
    assert.throws(() => setConsent(env), TypeError)
  })
})

test("setConsent refuses to write through a symlinked consent.json", () => {
  scratch((env) => {
    const root = factoryStateRoot(env)
    const decoy = path.join(env.HOME, "decoy-consent.json")
    writeFileSync(decoy, "{}")
    symlinkSync(decoy, path.join(root, "consent.json"))
    assert.throws(() => readConsent(env), (error) => {
      assert.equal(error.code, "unsafe_state_root")
      assert.match(error.message, /symlink/u)
      return true
    })
  })
})

test("setConsent writes are atomic: two writes leave no temp files and the final content is the second write", () => {
  scratch((env) => {
    setConsent(env, { store: STORE, contribute: true })
    setConsent(env, { store: STORE, contribute: false })
    const root = factoryStateRoot(env)
    const leftovers = noSymlinkFiles(root).filter((name) => name.startsWith(".tmp-"))
    assert.deepEqual(leftovers, [])
    assert.equal(readConsent(env).stores[STORE].contribute, false)
    assert.equal(statSync(path.join(root, "consent.json")).mode & 0o777, 0o600)
  })
})

// ---------------------------------------------------------------------------
// writeLocalFacts.
// ---------------------------------------------------------------------------

test("writeLocalFacts is a no-op when the store has no consent decision", () => {
  scratch((env) => {
    const result = writeLocalFacts(env, STORE, validLocalFacts())
    assert.deepEqual(result, { written: false, errors: [] })
    const root = factoryStateRoot(env)
    assert.deepEqual(noSymlinkFiles(root).includes("outbox"), false)
  })
})

test("writeLocalFacts is a no-op when the store's consent is contribute: false", () => {
  scratch((env) => {
    setConsent(env, { store: STORE, contribute: false })
    const result = writeLocalFacts(env, STORE, validLocalFacts())
    assert.deepEqual(result, { written: false, errors: [] })
  })
})

test("writeLocalFacts never writes invalid facts, and reports the validator's errors", () => {
  scratch((env) => {
    setConsent(env, { store: STORE, contribute: true })
    const broken = validLocalFacts()
    delete broken.session.host
    const result = writeLocalFacts(env, STORE, broken)
    assert.equal(result.written, false)
    assert.ok(result.errors.length > 0)
    const root = factoryStateRoot(env)
    assert.deepEqual(noSymlinkFiles(root).includes("outbox"), false)
  })
})

test("writeLocalFacts writes valid facts to the outbox, owner-only, canonical bytes plus one newline", () => {
  scratch((env) => {
    setConsent(env, { store: STORE, contribute: true })
    const facts = validLocalFacts()
    const result = writeLocalFacts(env, STORE, facts)
    assert.equal(result.written, true)
    assert.equal(result.name, "claude-code-3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60.json")
    const file = path.join(factoryStateRoot(env), "outbox", "ourostack__factory", result.name)
    const bytes = readFileSync(file)
    assert.equal(bytes.toString("utf8"), `${JSON.stringify(facts)}\n`)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })
})

// ---------------------------------------------------------------------------
// pendingFiles / markDelivered / quarantine.
// ---------------------------------------------------------------------------

function published(tag) {
  return Buffer.from(JSON.stringify({ tag }))
}

test("pendingFiles is empty when the store has never been written to", () => {
  scratch((env) => {
    assert.deepEqual(pendingFiles(env, STORE, { publishedBytesFor: () => published("x") }), [])
  })
})

test("pendingFiles requires publishedBytesFor to be a function", () => {
  scratch((env) => {
    assert.throws(() => pendingFiles(env, STORE, {}), TypeError)
  })
})

test("pendingFiles lists undelivered files, re-sends a file whose published bytes changed, skips an unchanged delivered one, excludes quarantine, and skips a file the transform can't publish", () => {
  scratch((env) => {
    setConsent(env, { store: STORE, contribute: true })
    const a = writeLocalFacts(env, STORE, validLocalFacts()).name
    const b = writeLocalFacts(env, STORE, validLocalFacts({
      session: { ...validLocalFacts().session, id: "4c1d2e5f-9b2e-5d3f-af4b-2c3d4e5f6071" },
    })).name
    const c = writeLocalFacts(env, STORE, validLocalFacts({
      session: { ...validLocalFacts().session, id: "5d2e3f60-ac3f-6e40-b05c-3d4e5f607182" },
    })).name

    // Nothing delivered yet: everything publishable is pending.
    const bytesFor = { [a]: published("a1"), [b]: published("b1"), [c]: null }
    let pending = pendingFiles(env, STORE, { publishedBytesFor: (facts) => bytesFor[`${facts.session.host}-${facts.session.id}.json`] })
    assert.deepEqual(pending.map((entry) => entry.name).sort(), [a, b].sort())
    assert.ok(Buffer.isBuffer(pending[0].localBytes))

    markDelivered(env, STORE, { name: a, publishedBlobSha: gitBlobSha(bytesFor[a]) })
    markDelivered(env, STORE, { name: b, publishedBlobSha: gitBlobSha(bytesFor[b]) })
    pending = pendingFiles(env, STORE, { publishedBytesFor: (facts) => bytesFor[`${facts.session.host}-${facts.session.id}.json`] })
    assert.deepEqual(pending, [])

    // a's published bytes changed since delivery: it comes back; b is untouched and stays delivered.
    bytesFor[a] = published("a2")
    pending = pendingFiles(env, STORE, { publishedBytesFor: (facts) => bytesFor[`${facts.session.host}-${facts.session.id}.json`] })
    assert.deepEqual(pending.map((entry) => entry.name), [a])

    // Quarantining a excludes it even though it is pending again.
    quarantine(env, STORE, a, "implausible_session_span")
    pending = pendingFiles(env, STORE, { publishedBytesFor: (facts) => bytesFor[`${facts.session.host}-${facts.session.id}.json`] })
    assert.deepEqual(pending, [])
  })
})

test("markDelivered rejects a bad name or a malformed blob sha", () => {
  scratch((env) => {
    assert.throws(() => markDelivered(env, STORE, { name: "", publishedBlobSha: "a".repeat(40) }), TypeError)
    assert.throws(() => markDelivered(env, STORE, { name: "x.json", publishedBlobSha: "not-a-sha" }), TypeError)
  })
})

test("markDelivered merges into the existing delivered map rather than replacing it", () => {
  scratch((env) => {
    const shaA = gitBlobSha("a")
    const shaB = gitBlobSha("b")
    markDelivered(env, STORE, { name: "a.json", publishedBlobSha: shaA })
    const next = markDelivered(env, STORE, { name: "b.json", publishedBlobSha: shaB })
    assert.deepEqual(next, { "a.json": shaA, "b.json": shaB })
  })
})

test("quarantine rejects a path-shaped name and a malformed reason code", () => {
  scratch((env) => {
    assert.throws(() => quarantine(env, STORE, "a/b.json", "implausible_session_span"), TypeError)
    assert.throws(() => quarantine(env, STORE, "a.json", "Not-Valid!"), TypeError)
  })
})

test("quarantine writes { reason, at } under the outbox file's own name", () => {
  scratch((env) => {
    const record = quarantine(env, STORE, "a.json", "session_id_not_v4", { now: () => "2026-01-01T00:00:00.000Z" })
    assert.deepEqual(record, { reason: "session_id_not_v4", at: "2026-01-01T00:00:00.000Z" })
    const file = path.join(factoryStateRoot(env), "quarantine", "ourostack__factory", "a.json")
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), record)
  })
})

// ---------------------------------------------------------------------------
// Markers.
// ---------------------------------------------------------------------------

test("writeMarker writes markers/<host>-<session_id>.json and listMarkers reads it back", () => {
  scratch((env) => {
    const marker = validMarker()
    writeMarker(env, marker)
    assert.deepEqual(listMarkers(env), [marker])
  })
})

test("writeMarker rejects a non-object, a wrong key set, a bad schema_version, a bad host and a bad session_id", () => {
  scratch((env) => {
    assert.throws(() => writeMarker(env, null), TypeError)
    assert.throws(() => writeMarker(env, { ...validMarker(), extra: "field" }), TypeError)
    const missingKey = validMarker()
    delete missingKey.cwd
    assert.throws(() => writeMarker(env, missingKey), TypeError)
    assert.throws(() => writeMarker(env, validMarker({ schema_version: 2 })), TypeError)
    assert.throws(() => writeMarker(env, validMarker({ host: "cursor" })), TypeError)
    assert.throws(() => writeMarker(env, validMarker({ session_id: "not-a-uuid" })), TypeError)
    assert.throws(() => writeMarker(env, validMarker({ updated_at: "2026-01-01" })), TypeError)
  })
})

test("listMarkers is empty when nothing has been written yet", () => {
  scratch((env) => {
    assert.deepEqual(listMarkers(env), [])
  })
})

test("listMarkers prunes a marker older than 30 days and keeps a fresh one", () => {
  scratch((env) => {
    const stale = validMarker({ session_id: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60", updated_at: "2026-01-01T00:00:00.000Z" })
    const fresh = validMarker({ session_id: "4c1d2e5f-9b2e-5d3f-af4b-2c3d4e5f6071", updated_at: "2026-03-01T00:00:00.000Z" })
    writeMarker(env, stale)
    writeMarker(env, fresh)
    const now = () => "2026-03-05T00:00:00.000Z"
    const kept = listMarkers(env, { now })
    assert.deepEqual(kept, [fresh])
    const dir = path.join(factoryStateRoot(env), "markers")
    assert.deepEqual(readdirSync(dir), [`claude-code-${fresh.session_id}.json`])
  })
})

// ---------------------------------------------------------------------------
// Status.
// ---------------------------------------------------------------------------

test("readStatus defaults to an empty last_flush map", () => {
  scratch((env) => {
    assert.deepEqual(readStatus(env), { last_flush: {} })
  })
})

test("writeStatus merges last_flush per store rather than replacing the whole map", () => {
  scratch((env) => {
    writeStatus(env, { last_flush: { [STORE]: { at: "2026-01-01T00:00:00.000Z", result: "ok" } } })
    const next = writeStatus(env, { last_flush: { "other/store": { at: "2026-01-02T00:00:00.000Z", result: "error" } } })
    assert.deepEqual(next.last_flush[STORE], { at: "2026-01-01T00:00:00.000Z", result: "ok" })
    assert.deepEqual(next.last_flush["other/store"], { at: "2026-01-02T00:00:00.000Z", result: "error" })
    assert.deepEqual(readStatus(env), next)
  })
})

test("writeStatus merges top-level fields that aren't last_flush too", () => {
  scratch((env) => {
    const next = writeStatus(env, { note: "example" })
    assert.equal(next.note, "example")
    assert.deepEqual(next.last_flush, {})
  })
})

test("writeStatus rejects a non-object patch", () => {
  scratch((env) => {
    assert.throws(() => writeStatus(env, null), TypeError)
    assert.throws(() => writeStatus(env, []), TypeError)
  })
})

// ---------------------------------------------------------------------------
// Visibility cache.
// ---------------------------------------------------------------------------

test("readVisibilityCache defaults to empty and writeVisibilityCache adds entries", () => {
  scratch((env) => {
    assert.deepEqual(readVisibilityCache(env), {})
    const next = writeVisibilityCache(env, { [STORE]: { visibility: "public", checked_at: "2026-01-01T00:00:00.000Z" } })
    assert.deepEqual(next[STORE], { visibility: "public", checked_at: "2026-01-01T00:00:00.000Z" })
  })
})

test("readVisibilityCache omits an entry older than 7 days but keeps a fresh one", () => {
  scratch((env) => {
    writeVisibilityCache(env, {
      stale: { visibility: "public", checked_at: "2026-01-01T00:00:00.000Z" },
      fresh: { visibility: "private", checked_at: "2026-01-07T00:00:00.000Z" },
    })
    const cache = readVisibilityCache(env, { now: () => "2026-01-09T00:00:00.000Z" })
    assert.deepEqual(Object.keys(cache), ["fresh"])
  })
})

test("writeVisibilityCache rejects a non-object patch", () => {
  scratch((env) => {
    assert.throws(() => writeVisibilityCache(env, "nope"), TypeError)
  })
})

// ---------------------------------------------------------------------------
// The machine secret.
// ---------------------------------------------------------------------------

test("readMachineSecret creates 32 owner-only bytes once and returns the same bytes afterward", () => {
  scratch((env) => {
    const first = readMachineSecret(env)
    assert.equal(first.length, 32)
    const second = readMachineSecret(env)
    assert.deepEqual(first, second)
    const file = path.join(factoryStateRoot(env), "machine-secret")
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })
})

test("readMachineSecret is never printed by this module", () => {
  scratch((env) => {
    const logs = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args) => logs.push(args.join(" "))
    console.error = (...args) => logs.push(args.join(" "))
    try {
      const secret = readMachineSecret(env)
      const hex = secret.toString("hex")
      for (const line of logs) assert.equal(line.includes(hex), false)
      assert.deepEqual(logs, [])
    } finally {
      console.log = originalLog
      console.error = originalError
    }
  })
})

test("readMachineSecret surfaces an unexpected error rather than silently treating it as absent", () => {
  scratch((env) => {
    const root = factoryStateRoot(env)
    mkdirSync(path.join(root, "machine-secret"))
    assert.throws(() => readMachineSecret(env))
  })
})

// ---------------------------------------------------------------------------
// Finalize requests.
// ---------------------------------------------------------------------------

test("requestFinalize writes finalize/<job>.json and listFinalizeRequests reads it back", () => {
  scratch((env) => {
    const record = requestFinalize(env, { job: JOB, deskRoot: "/tmp/desk" }, { now: () => "2026-01-01T00:00:00.000Z" })
    assert.deepEqual(record, { schema_version: 1, job: JOB, desk_root: "/tmp/desk", requested_at: "2026-01-01T00:00:00.000Z" })
    assert.deepEqual(listFinalizeRequests(env), [record])
  })
})

test("requestFinalize rejects a malformed job id or a relative desk root", () => {
  scratch((env) => {
    assert.throws(() => requestFinalize(env, { job: "not-hex", deskRoot: "/tmp/desk" }), TypeError)
    assert.throws(() => requestFinalize(env, { job: JOB, deskRoot: "relative/path" }), TypeError)
  })
})

test("listFinalizeRequests is empty when nothing is pending", () => {
  scratch((env) => {
    assert.deepEqual(listFinalizeRequests(env), [])
  })
})

test("clearFinalize removes a request and is a no-op when it's already gone", () => {
  scratch((env) => {
    requestFinalize(env, { job: JOB, deskRoot: "/tmp/desk" })
    clearFinalize(env, JOB)
    assert.deepEqual(listFinalizeRequests(env), [])
    clearFinalize(env, JOB)
  })
})

test("clearFinalize rejects a malformed job id", () => {
  scratch((env) => {
    assert.throws(() => clearFinalize(env, "nope"), TypeError)
  })
})

test("clearFinalize surfaces an unexpected error rather than silently treating it as already gone", () => {
  scratch((env) => {
    const root = factoryStateRoot(env)
    mkdirSync(path.join(root, "finalize", `${JOB}.json`), { recursive: true })
    assert.throws(() => clearFinalize(env, JOB))
  })
})

// ---------------------------------------------------------------------------
// Jobs index.
// ---------------------------------------------------------------------------

test("readJobsIndex defaults to empty and updateJobsIndex adds and dedupes file names", () => {
  scratch((env) => {
    assert.deepEqual(readJobsIndex(env), {})
    updateJobsIndex(env, JOB, "claude-code-a.json")
    const next = updateJobsIndex(env, JOB, "claude-code-a.json")
    assert.deepEqual(next[JOB], ["claude-code-a.json"])
    const withSecond = updateJobsIndex(env, JOB, "claude-code-b.json")
    assert.deepEqual(withSecond[JOB], ["claude-code-a.json", "claude-code-b.json"])
  })
})

test("updateJobsIndex rejects a malformed job id or file name", () => {
  scratch((env) => {
    assert.throws(() => updateJobsIndex(env, "nope", "a.json"), TypeError)
    assert.throws(() => updateJobsIndex(env, JOB, ""), TypeError)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting fs robustness: a corrupted layout surfaces the real error
// rather than being silently swallowed as "not there".
// ---------------------------------------------------------------------------

test("a JSON read surfaces an unexpected error when a directory sits where a file belongs", () => {
  scratch((env) => {
    const root = factoryStateRoot(env)
    mkdirSync(path.join(root, "consent.json"))
    assert.throws(() => readConsent(env))
  })
})

test("a directory listing surfaces an unexpected error when a file sits where a directory belongs", () => {
  scratch((env) => {
    const root = factoryStateRoot(env)
    writeFileSync(path.join(root, "markers"), "not a directory")
    assert.throws(() => listMarkers(env))
  })
})

test("storeSlug rejects a store that is not owner/repo", () => {
  scratch((env) => {
    assert.throws(() => writeLocalFacts(env, "not-a-repo", validLocalFacts()), TypeError)
  })
})
