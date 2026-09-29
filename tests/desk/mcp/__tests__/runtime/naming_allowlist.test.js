// The `UserPromptSubmit` half of controller ruling 3 ("named by the operator"
// is read from every operator message, not only the first): a deterministic
// pattern match names a denied surface from prompt text, and a small
// session-scoped allowlist remembers it for the rest of the session so
// `host-enforcement.js`'s deny layer can skip it. See Review Focus: a negated
// mention ("don't use an artifact") must not count as naming.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  isAllowedThisSession,
  loadSessionAllowlist,
  namedSurfaceFrom,
  recordNamedSurface,
  saveSessionAllowlist,
  sessionAllowlistPath,
} from "../../../../../plugins/desk/mcp/src/runtime/naming-allowlist.js"
import { mkFakeRealRoot } from "../_fake_real_root.js"

function fixtureEnv() {
  const home = mkdtempSync(path.join(tmpdir(), "desk-naming-allowlist-"))
  return { env: { XDG_STATE_HOME: path.join(home, "state") }, home }
}

test("a negated mention does not name the surface", () => {
  assert.equal(namedSurfaceFrom("don't use an artifact for this"), null)
})

test("the positive case names the surface", () => {
  assert.equal(namedSurfaceFrom("use an artifact for this"), "artifact")
})

test("other negation lead-ins (never, not) also suppress naming", () => {
  assert.equal(namedSurfaceFrom("never use plan mode here"), null)
  assert.equal(namedSurfaceFrom("please do not enter plan mode"), null)
})

test("a later pattern in the same surface's list still names it", () => {
  assert.equal(namedSurfaceFrom("go ahead and ask me a question about the schema"), "ask-user")
})

test("naming in a later sentence is still found", () => {
  assert.equal(namedSurfaceFrom("Ship the fix first. Then make a Claude Doc for the writeup."), "artifact")
})

test("ordinary prompt text with no denied surface named returns null", () => {
  assert.equal(namedSurfaceFrom("run the test suite and fix whatever fails"), null)
})

test("non-string or empty prompt text never names a surface", () => {
  assert.equal(namedSurfaceFrom(null), null)
  assert.equal(namedSurfaceFrom(""), null)
})

test("a surface named earlier stays allowed across later, unrelated record calls in the same session (Review Focus companion: durability, not one-shot)", () => {
  const sessionState = new Set()
  recordNamedSurface(sessionState, "artifact")
  assert.equal(isAllowedThisSession(sessionState, "artifact"), true)
  // Two more "messages" that name nothing new -- the earlier grant is untouched.
  assert.equal(isAllowedThisSession(sessionState, "artifact"), true)
  assert.equal(isAllowedThisSession(sessionState, "plan-mode"), false)
})

test("sessionAllowlistPath is namespaced under Desk's own state directory, keyed by session id, never inside the desk repo", () => {
  const { env, home } = fixtureEnv()
  try {
    const file = sessionAllowlistPath({ env, sessionId: "session-a" })
    assert.ok(file.startsWith(path.join(home, "state")))
    assert.notEqual(sessionAllowlistPath({ env, sessionId: "session-a" }), sessionAllowlistPath({ env, sessionId: "session-b" }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("loadSessionAllowlist returns an empty set when nothing was ever recorded for this session", () => {
  const { env, home } = fixtureEnv()
  try {
    assert.deepEqual(loadSessionAllowlist({ env, sessionId: "never-seen" }), new Set())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("save then load round-trips the recorded surfaces for the same session id", () => {
  const { env, home } = fixtureEnv()
  try {
    const sessionState = new Set(["artifact", "plan-mode"])
    assert.equal(saveSessionAllowlist({ env, sessionId: "roundtrip", sessionState }), true)
    assert.deepEqual(loadSessionAllowlist({ env, sessionId: "roundtrip" }), new Set(["artifact", "plan-mode"]))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a corrupt allowlist file is read as empty, never thrown", () => {
  const { env, home } = fixtureEnv()
  try {
    const file = sessionAllowlistPath({ env, sessionId: "corrupt" })
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "not json")
    assert.deepEqual(loadSessionAllowlist({ env, sessionId: "corrupt" }), new Set())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("an allowlist file missing its 'allowed' array, or holding non-string entries, is read as the filtered/empty set rather than thrown", () => {
  const { env, home } = fixtureEnv()
  try {
    const noArrayFile = sessionAllowlistPath({ env, sessionId: "no-array" })
    mkdirSync(path.dirname(noArrayFile), { recursive: true })
    writeFileSync(noArrayFile, JSON.stringify({}))
    assert.deepEqual(loadSessionAllowlist({ env, sessionId: "no-array" }), new Set())

    const mixedFile = sessionAllowlistPath({ env, sessionId: "mixed" })
    writeFileSync(mixedFile, JSON.stringify({ allowed: ["artifact", 42, null] }))
    assert.deepEqual(loadSessionAllowlist({ env, sessionId: "mixed" }), new Set(["artifact"]))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("saveSessionAllowlist never throws when its directory cannot be created, and reports the failure", () => {
  const { env, home } = fixtureEnv()
  try {
    const file = sessionAllowlistPath({ env, sessionId: "blocked" })
    // A plain file sitting where the allowlist directory needs to be created makes mkdirSync fail (ENOTDIR).
    mkdirSync(path.dirname(path.dirname(file)), { recursive: true })
    writeFileSync(path.dirname(file), "occupied")
    assert.equal(saveSessionAllowlist({ env, sessionId: "blocked", sessionState: new Set(["artifact"]) }), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("under a node:test run, saveSessionAllowlist refuses a real (non-temp) state home rather than writing to it", () => {
  // A HOME that genuinely exists and is genuinely writable, but sits outside the OS temp directory: stands in for the
  // developer's real home, so a write landing here would be exactly the incident the guard exists to stop.
  const fakeReal = mkFakeRealRoot("desk-naming-allowlist-fake-real-")
  try {
    const env = { XDG_STATE_HOME: path.join(fakeReal, "state") }
    assert.equal(saveSessionAllowlist({ env, sessionId: "fake-real", sessionState: new Set(["artifact"]) }), false, "never persisted")
    assert.equal(existsSync(path.join(fakeReal, "state")), false, "the guard refuses before creating anything under the fake real home")
  } finally {
    rmSync(fakeReal, { recursive: true, force: true })
  }
})

test("sessionAllowlistPath, loadSessionAllowlist and saveSessionAllowlist all default to process.env when no env is given", () => {
  // The global test isolation setup (_isolated_env.mjs) already points process.env.XDG_STATE_HOME at a throwaway
  // directory, so exercising each function's default `env = process.env` parameter here is safe under test.
  const sessionId = "default-env-session"
  const path1 = sessionAllowlistPath({ sessionId })
  assert.equal(path1, sessionAllowlistPath({ env: process.env, sessionId }))
  assert.deepEqual(loadSessionAllowlist({ sessionId }), new Set())
  assert.equal(saveSessionAllowlist({ sessionId, sessionState: new Set(["artifact"]) }), true)
  assert.deepEqual(loadSessionAllowlist({ sessionId }), new Set(["artifact"]))
})
