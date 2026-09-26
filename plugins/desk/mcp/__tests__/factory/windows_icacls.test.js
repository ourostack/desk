// The factory outbox's Windows owner-only protection: a synchronous
// `icacls.exe` call, injected platform and runner throughout so this runs
// identically on every CI platform.

import { test } from "node:test"
import assert from "node:assert/strict"

import { protectWindowsPathSync } from "../../src/factory/windows-icacls.js"

test("protectWindowsPathSync is a no-op off win32, even with no options object, or no runner or env, at all", () => {
  assert.doesNotThrow(() => protectWindowsPathSync("/some/path", "file", { platform: "linux" }))
  assert.doesNotThrow(() => protectWindowsPathSync("/some/path", "directory", { platform: "darwin" }))
  if (process.platform !== "win32") {
    assert.doesNotThrow(() => protectWindowsPathSync("/some/path", "file"))
  }
})

test("protectWindowsPathSync grants the current user full control on a file, stripping inheritance", () => {
  const calls = []
  protectWindowsPathSync("C:\\state\\secret", "file", {
    platform: "win32",
    env: { USERNAME: "ari" },
    runner: (command, args) => calls.push([command, args]),
  })
  assert.deepEqual(calls, [["icacls.exe", ["C:\\state\\secret", "/inheritance:r", "/grant:r", "ari:(F)"]]])
})

test("protectWindowsPathSync grants an inheritable full-control rule on a directory", () => {
  const calls = []
  protectWindowsPathSync("C:\\state\\factory", "directory", {
    platform: "win32",
    env: { USERNAME: "ari" },
    runner: (command, args) => calls.push([command, args]),
  })
  assert.deepEqual(calls, [["icacls.exe", ["C:\\state\\factory", "/inheritance:r", "/grant:r", "ari:(OI)(CI)(F)"]]])
})

test("protectWindowsPathSync falls back to env.USER when USERNAME is absent", () => {
  const calls = []
  protectWindowsPathSync("C:\\state\\x", "file", {
    platform: "win32",
    env: { USER: "quinn" },
    runner: (command, args) => calls.push([command, args]),
  })
  assert.deepEqual(calls[0][1].at(-1), "quinn:(F)")
})

test("protectWindowsPathSync refuses when neither USERNAME nor USER identifies the owner", () => {
  assert.throws(
    () => protectWindowsPathSync("C:\\state\\x", "file", { platform: "win32", env: {}, runner: () => {} }),
    /desk_factory: Windows ACL protection needs USERNAME/u,
  )
  assert.throws(
    () => protectWindowsPathSync("C:\\state\\x", "file", { platform: "win32", env: { USERNAME: "   " }, runner: () => {} }),
    /desk_factory: Windows ACL protection needs USERNAME/u,
  )
})

test("protectWindowsPathSync propagates the runner's own failure", () => {
  const failure = new Error("icacls refused")
  assert.throws(
    () => protectWindowsPathSync("C:\\state\\x", "file", {
      platform: "win32",
      env: { USERNAME: "ari" },
      runner: () => {
        throw failure
      },
    }),
    (error) => error === failure,
  )
})

test("protectWindowsPathSync's default runner is used when none is injected, and it really shells out", () => {
  // On win32 this runs the real icacls.exe against a path that doesn't
  // exist, which fails; off win32 (this suite's usual host) `icacls.exe`
  // isn't even a known command. Either way the default runner's own body
  // executes and throws, rather than being silently skipped.
  assert.throws(() => protectWindowsPathSync(
    "C:\\definitely\\not\\a\\real\\path\\zzz",
    "file",
    { platform: "win32", env: { USERNAME: "ari" } },
  ))
})
