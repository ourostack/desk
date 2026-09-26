// The factory.js CLI: its first subcommand, `consent`. Direct calls to the
// exported functions exercise every branch in-process; a couple of real
// subprocess invocations prove the shebang, argv/env defaults and the actual
// process exit code, against a throwaway HOME/XDG_STATE_HOME only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { isMainModule, main, parseOptions, runConsentCommand } from "../../scripts/factory.js"
import { readConsent } from "../../src/factory/outbox.js"

const SCRIPT = fileURLToPath(new URL("../../scripts/factory.js", import.meta.url))

function scratch(run) {
  const base = mkdtempSync(path.join(os.tmpdir(), "desk-factory-cli-"))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return run(env)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// parseOptions.
// ---------------------------------------------------------------------------

test("parseOptions reads --flag value pairs into a map", () => {
  assert.deepEqual([...parseOptions(["--store", "a/b", "--contribute", "yes"]).entries()], [["store", "a/b"], ["contribute", "yes"]])
})

test("parseOptions rejects a non-string flag, a flag with no leading --, a bare --, and a dangling flag with no value", () => {
  assert.equal(parseOptions([42, "x"]), null)
  assert.equal(parseOptions(["store", "x"]), null)
  assert.equal(parseOptions(["--", "x"]), null)
  assert.equal(parseOptions(["--store"]), null)
})

// ---------------------------------------------------------------------------
// runConsentCommand.
// ---------------------------------------------------------------------------

test("runConsentCommand sets consent and returns the store's record", () => {
  scratch((env) => {
    const result = runConsentCommand({ argv: ["--store", "ourostack/factory", "--contribute", "yes"], env })
    assert.equal(result.store, "ourostack/factory")
    assert.equal(result.contribute, true)
    assert.match(result.intake_id, /^[0-9a-f]{16}$/u)
    assert.deepEqual(readConsent(env).stores["ourostack/factory"].intake_id, result.intake_id)
  })
})

test("runConsentCommand accepts an optional --account", () => {
  scratch((env) => {
    const result = runConsentCommand({ argv: ["--store", "ourostack/factory", "--contribute", "yes", "--account", "arimendelow"], env })
    assert.equal(result.account, "arimendelow")
  })
})

test("runConsentCommand rejects malformed argv, a missing --store, and a --contribute that isn't yes/no", () => {
  scratch((env) => {
    assert.throws(() => runConsentCommand({ argv: ["--store"], env }), /Usage: factory\.js consent/u)
    assert.throws(() => runConsentCommand({ argv: ["--contribute", "yes"], env }), /Usage: factory\.js consent/u)
    assert.throws(() => runConsentCommand({ argv: ["--store", "a/b", "--contribute", "maybe"], env }), /Usage: factory\.js consent/u)
  })
})

test("runConsentCommand rejects an unknown option", () => {
  scratch((env) => {
    assert.throws(
      () => runConsentCommand({ argv: ["--store", "a/b", "--contribute", "yes", "--extra", "x"], env }),
      /unknown option --extra/u,
    )
  })
})

// ---------------------------------------------------------------------------
// main: dispatch, exit codes, and the consent round trip.
// ---------------------------------------------------------------------------

test("main dispatches consent, prints one JSON line, and returns exit code 0", () => {
  scratch((env) => {
    let written = ""
    const code = main({ argv: ["consent", "--store", "ourostack/factory", "--contribute", "yes"], env, write: (text) => { written += text }, logError: () => assert.fail("should not log an error") })
    assert.equal(code, 0)
    const parsed = JSON.parse(written)
    assert.equal(parsed.store, "ourostack/factory")
    assert.equal(parsed.contribute, true)
  })
})

test("main returns exit code 1 and logs one line for an unknown subcommand", () => {
  scratch((env) => {
    let logged = ""
    const code = main({ argv: ["bogus"], env, write: () => assert.fail("should not write"), logError: (text) => { logged += text } })
    assert.equal(code, 1)
    assert.match(logged, /unknown subcommand "bogus"/u)
  })
})

test("main returns exit code 1 and logs the usage message for a malformed consent call", () => {
  scratch((env) => {
    let logged = ""
    const code = main({ argv: ["consent"], env, write: () => assert.fail("should not write"), logError: (text) => { logged += text } })
    assert.equal(code, 1)
    assert.match(logged, /Usage: factory\.js consent/u)
  })
})

test("main reports an unknown subcommand as an empty string when argv is empty", () => {
  scratch((env) => {
    let logged = ""
    const code = main({ argv: [], env, write: () => assert.fail("should not write"), logError: (text) => { logged += text } })
    assert.equal(code, 1)
    assert.match(logged, /unknown subcommand ""/u)
  })
})

// ---------------------------------------------------------------------------
// isMainModule.
// ---------------------------------------------------------------------------

test("isMainModule is true only when argv[1]'s file URL matches import.meta.url", () => {
  assert.equal(isMainModule("file:///a/b.js", "/a/b.js"), true)
  assert.equal(isMainModule("file:///a/b.js", "/a/other.js"), false)
  assert.equal(isMainModule("file:///a/b.js", undefined), false)
})

// ---------------------------------------------------------------------------
// The real CLI: a subprocess round trip against a throwaway state root.
// ---------------------------------------------------------------------------

function runCli(args, env) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env })
}

test("the CLI consent round trip: yes mints an intake_id, a later no keeps it, both visible in the written consent.json", () => {
  scratch((env) => {
    const fullEnv = { ...process.env, ...env }
    const yesOut = JSON.parse(runCli(["consent", "--store", "ourostack/factory", "--contribute", "yes"], fullEnv))
    assert.equal(yesOut.contribute, true)
    assert.match(yesOut.intake_id, /^[0-9a-f]{16}$/u)

    const noOut = JSON.parse(runCli(["consent", "--store", "ourostack/factory", "--contribute", "no", "--account", "arimendelow"], fullEnv))
    assert.equal(noOut.contribute, false)
    assert.equal(noOut.intake_id, yesOut.intake_id)
    assert.equal(noOut.account, "arimendelow")

    assert.equal(readConsent(env).stores["ourostack/factory"].intake_id, yesOut.intake_id)
  })
})

test("the real CLI exits non-zero and prints one line to stderr for a bad invocation", () => {
  scratch((env) => {
    const fullEnv = { ...process.env, ...env }
    try {
      execFileSync(process.execPath, [SCRIPT, "consent"], { encoding: "utf8", env: fullEnv, stdio: ["ignore", "pipe", "pipe"] })
      assert.fail("expected a non-zero exit")
    } catch (error) {
      assert.equal(error.status, 1)
      assert.match(error.stderr.toString(), /Usage: factory\.js consent/u)
    }
  })
})
