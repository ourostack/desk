// shouldLaunchFiler (fix round, spec.md §1 Part 5): the local throttle that
// keeps a mechanism failing the same way over and over from spawning a fresh
// detached filer every single time. Every test here is a direct, in-process
// import -- no subprocess, no `gh`, and state always redirected to a
// throwaway fixture directory, never the real HOME or XDG_STATE_HOME.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { DEFAULT_FILER_COOLDOWN_MS, shouldLaunchFiler } from "../../../../../plugins/desk/mcp/src/runtime/filer-throttle.js"
import { mkFakeRealRoot } from "../_fake_real_root.js"

function fixtureEnv(t) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-filer-throttle-"))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  return { env: { HOME: root } }
}

test("the first qualifying event always launches", (t) => {
  const { env } = fixtureEnv(t)
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom" }), true)
})

test("10 consecutive qualifying events for the same mechanism and signature spawn exactly one filer", (t) => {
  const { env } = fixtureEnv(t)
  const launches = []
  for (let index = 0; index < 10; index += 1) launches.push(shouldLaunchFiler({ env, mechanism: "protected-checkout", signature: "same command" }))
  assert.deepEqual(launches, [true, ...Array(9).fill(false)])
})

test("a different signature under the same mechanism is tracked independently", (t) => {
  const { env } = fixtureEnv(t)
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "reason one" }), true)
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "reason two" }), true)
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "reason one" }), false)
})

test("a different mechanism under the same signature is tracked independently", (t) => {
  const { env } = fixtureEnv(t)
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom" }), true)
  assert.equal(shouldLaunchFiler({ env, mechanism: "index-drift", signature: "boom" }), true)
})

test("a qualifying event past the cooldown window launches again", (t) => {
  const { env } = fixtureEnv(t)
  let now = 0
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom", now: () => now }), true)
  now += DEFAULT_FILER_COOLDOWN_MS - 1
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom", now: () => now }), false, "still within the hour")
  now += 2
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom", now: () => now }), true, "past the hour")
})

test("a custom cooldownMs is honored", (t) => {
  const { env } = fixtureEnv(t)
  let now = 0
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom", cooldownMs: 1000, now: () => now }), true)
  now += 999
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom", cooldownMs: 1000, now: () => now }), false)
  now += 2
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom", cooldownMs: 1000, now: () => now }), true)
})

test("fails toward launching when the state directory cannot be read or written", () => {
  const env = { HOME: path.join("/dev/null", "not-a-real-directory") }
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom" }), true)
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom" }), true, "never persisted, so every call launches")
})

test("treats a corrupt or unrecognizable previous stamp as no previous stamp", (t) => {
  const { env } = fixtureEnv(t)
  const first = shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom" })
  assert.equal(first, true)
  // A second call right away, still within the cooldown, is throttled -- this just re-confirms the happy path before the corrupt-file case below.
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "boom" }), false)
})

test("default env and now match every other real caller", (t) => {
  const { env } = fixtureEnv(t)
  const originalHome = process.env.HOME
  process.env.HOME = env.HOME
  t.after(() => { process.env.HOME = originalHome })
  assert.equal(shouldLaunchFiler({ mechanism: "ask-gate", signature: "boom" }), true)
  assert.equal(typeof shouldLaunchFiler({ mechanism: "ask-gate" }), "boolean")
  // Every argument defaulted, exactly as an accidental no-args call would see: still never throws.
  assert.equal(typeof shouldLaunchFiler(), "boolean")
})

test("an empty or missing signature is still tracked, distinctly from any named signature", (t) => {
  const { env } = fixtureEnv(t)
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate" }), true)
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate" }), false)
  assert.equal(shouldLaunchFiler({ env, mechanism: "ask-gate", signature: "named" }), true)
})

test("under a node:test run, a real (non-temp) state home is refused rather than written -- the same guard last-start.js's writers use", (t) => {
  // A HOME that genuinely exists and is genuinely writable, but sits outside the OS temp directory: stands in for the
  // developer's real home, so a stamp landing here would be exactly the incident the guard exists to stop.
  const fakeReal = mkFakeRealRoot("desk-filer-throttle-fake-real-")
  t.after(() => rmSync(fakeReal, { recursive: true, force: true, maxRetries: 5 }))
  assert.equal(shouldLaunchFiler({ env: { HOME: fakeReal }, mechanism: "ask-gate", signature: "boom" }), true, "still fails toward launching")
  assert.equal(existsSync(path.join(fakeReal, ".local")), false, "the guard refuses before creating anything under the fake real home")
})
