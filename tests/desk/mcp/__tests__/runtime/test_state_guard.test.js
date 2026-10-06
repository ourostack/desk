// Direct unit tests of the node:test-run detector and the guard it drives (see the module's own header comment for
// why each detection signal exists and how it was verified on Node v22.23.3). `test_isolation.test.js` has the
// end-to-end regression proving the factory-side twin of this guard actually stops a real write from a bare `node
// --test`; this file exists because `src/runtime/**` keeps its own copy rather than importing the factory one (see
// the module's own header comment on why).

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  DESK_ALLOW_REAL_STATE_IN_TEST,
  DESK_TEST_REAL_STATE,
  assertNotRealStateUnderTest,
  isUnderOsTmpdir,
  looksLikeNodeTestRunner,
  tmpdirSpellingsOf,
} from "../../../../../plugins/desk/mcp/src/runtime/test-state-guard.js"

test("looksLikeNodeTestRunner is true whenever NODE_TEST_CONTEXT is a non-blank string", () => {
  assert.equal(looksLikeNodeTestRunner({ NODE_TEST_CONTEXT: "child-v8" }), true)
})

test("looksLikeNodeTestRunner defaults env to process.env", () => {
  // The real process.env here always looks like a node:test run (this file itself runs under node:test), so this is
  // safe to assert unconditionally.
  assert.equal(looksLikeNodeTestRunner(), true)
})

test("looksLikeNodeTestRunner falls back to the entry script's own name when NODE_TEST_CONTEXT is unset or blank", () => {
  // This file's own argv[1] already ends in .test.js while these assertions run, so a blank/missing
  // NODE_TEST_CONTEXT still falls through to a true result here.
  assert.equal(looksLikeNodeTestRunner({}), true)
  assert.equal(looksLikeNodeTestRunner({ NODE_TEST_CONTEXT: "   " }), true)
})

test("looksLikeNodeTestRunner recognizes every test-file extension, and is false for anything else", () => {
  const original = process.argv[1]
  try {
    for (const entry of ["/x/thing.test.js", "/x/thing.test.cjs", "/x/thing.test.mjs"]) {
      process.argv[1] = entry
      assert.equal(looksLikeNodeTestRunner({}), true, entry)
    }
    process.argv[1] = "/x/plain-script.js"
    assert.equal(looksLikeNodeTestRunner({}), false)
    process.argv[1] = undefined
    assert.equal(looksLikeNodeTestRunner({}), false)
  } finally {
    process.argv[1] = original
  }
})

test("isUnderOsTmpdir recognizes the OS temp directory itself, a subdirectory, and the realpath spelling, but nothing outside it", async () => {
  const tmp = os.tmpdir()
  const realTmp = await fs.realpath(tmp)
  assert.equal(isUnderOsTmpdir(tmp), true, "the temp directory itself")
  assert.equal(isUnderOsTmpdir(path.join(tmp, "desk-test-x")), true, "a plain subdirectory")
  assert.equal(isUnderOsTmpdir(path.join(realTmp, "desk-test-x")), true, "a subdirectory of the realpath spelling")
  assert.equal(isUnderOsTmpdir(path.join(path.dirname(realTmp), "definitely-not-tmp")), false, "a sibling of the temp directory")
})

test("tmpdirSpellingsOf keeps the operating system's long spelling of a short temp path (Windows 8.3 names) and survives a path that cannot be resolved", () => {
  const spellings = tmpdirSpellingsOf("C:\\Users\\RUNNER~1\\Temp", {
    realpath: (target) => target,
    native: () => "C:\\Users\\runneradmin\\Temp",
  })
  assert.deepEqual([...spellings].sort(), ["C:\\Users\\RUNNER~1\\Temp", "C:\\Users\\runneradmin\\Temp"])
  const unresolved = tmpdirSpellingsOf("/gone", { realpath: () => { throw new Error("ENOENT") }, native: () => { throw new Error("ENOENT") } })
  assert.deepEqual([...unresolved], ["/gone"])
})

test("isUnderOsTmpdir folds path casing only under an injected win32 platform; every other platform stays case-sensitive", () => {
  const tmp = os.tmpdir()
  const swapped = tmp.toUpperCase() === tmp ? tmp.toLowerCase() : tmp.toUpperCase()
  assert.notEqual(swapped, tmp, "the OS temp directory must contain a letter for this to be a meaningful check")
  assert.equal(isUnderOsTmpdir(path.join(swapped, "x"), { platform: "win32" }), true)
  // On Windows node's own path.relative folds case whatever platform is injected, so the case-sensitive half can only be observed elsewhere.
  if (process.platform !== "win32") assert.equal(isUnderOsTmpdir(path.join(swapped, "x"), { platform: "linux" }), false)
})

test("assertNotRealStateUnderTest is a no-op outside anything that looks like a node:test run", () => {
  const original = process.argv[1]
  try {
    process.argv[1] = "/x/plain-script.js"
    assert.doesNotThrow(() => assertNotRealStateUnderTest("/definitely/not/tmp/desk-state", { env: {} }))
  } finally {
    process.argv[1] = original
  }
})

test("assertNotRealStateUnderTest allows a state directory under the OS temp directory", () => {
  assert.doesNotThrow(() => assertNotRealStateUnderTest(path.join(os.tmpdir(), "desk-state-x"), { env: { NODE_TEST_CONTEXT: "child-v8" } }))
})

test("assertNotRealStateUnderTest honors the explicit opt-in", () => {
  assert.doesNotThrow(() =>
    assertNotRealStateUnderTest("/definitely/not/tmp/desk-state", {
      env: { NODE_TEST_CONTEXT: "child-v8", [DESK_ALLOW_REAL_STATE_IN_TEST]: "1" },
    }),
  )
})

test("assertNotRealStateUnderTest refuses a non-temp state directory under what looks like a node:test run", () => {
  assert.throws(
    () => assertNotRealStateUnderTest("/definitely/not/tmp/desk-state", { env: { NODE_TEST_CONTEXT: "child-v8" } }),
    (error) => {
      assert.equal(error.code, DESK_TEST_REAL_STATE)
      assert.match(error.message, /refused the real Desk state folder/u)
      assert.match(error.message, new RegExp(DESK_ALLOW_REAL_STATE_IN_TEST, "u"))
      return true
    },
  )
})

test("assertNotRealStateUnderTest defaults env to process.env", () => {
  // The real process.env here always looks like a node:test run and never opts in, so the only thing this can
  // exercise safely is the allowed (temp) path — the refusing path is exercised above with an explicit env.
  assert.doesNotThrow(() => assertNotRealStateUnderTest(path.join(os.tmpdir(), "desk-state-default-env")))
})

test("tmpdirSpellingsOf keeps the operating system's long spelling of a short temp path (Windows 8.3 names) and survives a path that cannot be resolved", () => {
  const spellings = tmpdirSpellingsOf("C:\\Users\\RUNNER~1\\Temp", {
    realpath: (target) => target,
    native: () => "C:\\Users\\runneradmin\\Temp",
  })
  assert.deepEqual([...spellings].sort(), ["C:\\Users\\RUNNER~1\\Temp", "C:\\Users\\runneradmin\\Temp"])
  const unresolved = tmpdirSpellingsOf("/gone", { realpath: () => { throw new Error("ENOENT") }, native: () => { throw new Error("ENOENT") } })
  assert.deepEqual([...unresolved], ["/gone"])
})
