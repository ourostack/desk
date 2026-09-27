// The factory.js CLI: its first subcommand, `consent`. Direct calls to the
// exported functions exercise every branch in-process; a couple of real
// subprocess invocations prove the shebang, argv/env defaults and the actual
// process exit code, against a throwaway HOME/XDG_STATE_HOME only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  isMainModule,
  main,
  parseOptions,
  runBuildCommand,
  runConsentCommand,
  runDeriveCommand,
  runJobLinkCommand,
  runStatusCommand,
  runValidatePrCommand,
} from "../../scripts/factory.js"
import { readConsent } from "../../src/factory/outbox.js"

const SCRIPT = fileURLToPath(new URL("../../scripts/factory.js", import.meta.url))
const FIXTURE_STORE = fileURLToPath(new URL("fixtures/store", import.meta.url))

async function scratch(run) {
  const rawBase = mkdtempSync(path.join(os.tmpdir(), "desk-factory-cli-"))
  const base = await fs.realpath(rawBase)
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return await run(env)
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
  assert.equal(parseOptions(["--store", "a/b", "--store", "c/d"]), null)
})

test("status returns local factory health without exposing marker paths or secrets", () => scratch(async (env) => {
  let output = ""
  assert.equal(await main({ argv: ["status"], env, write: (text) => { output += text }, logError: () => assert.fail("status must succeed") }), 0)
  const result = JSON.parse(output)
  assert.equal(result.markers, 0)
  assert.equal(result.finalize, 0)
  assert.equal(output.includes(env.HOME), false)
}))

test("derive refuses an arbitrary marker path without echoing it", () => scratch(async (env) => {
  let output = ""
  assert.equal(await main({ argv: ["derive", "--marker", "/private/sentinel.json"], env, write: (text) => { output += text }, logError: () => assert.fail("invalid marker is a structured outcome") }), 0)
  assert.deepEqual(JSON.parse(output), { result: "invalid", store: null })
}))

test("derive and status reject malformed options and out-of-budget quiet waits", () => scratch(async (env) => {
  for (const argv of [[], ["--marker"], ["--other", "x"], ["--marker", "x", "--other", "y"]]) {
    await assert.rejects(runDeriveCommand({ argv, env }), /Usage:/u)
  }
  for (const wait of ["-1", "NaN", "30001", "9999999"]) {
    await assert.rejects(runDeriveCommand({ argv: ["--marker", "x", "--wait-quiet", wait], env }), /wait-quiet must/u)
  }
  assert.deepEqual(await runDeriveCommand({ argv: ["--marker", "x", "--wait-quiet", "0"], env }), { result: "invalid", store: null })
  await assert.rejects(runStatusCommand({ argv: ["extra"], env }), /Usage:/u)
}))

test("build writes the deterministic report tree and job-link returns the accepted URL", () => scratch(async (env) => {
  const store = path.join(env.HOME, "store")
  const out = path.join(store, "_out")
  cpSync(FIXTURE_STORE, store, { recursive: true })
  assert.deepEqual(await runBuildCommand({ argv: ["--store", store, "--out", out] }), { jobs: 2, sessions: 4 })
  assert.equal(JSON.parse(readFileSync(path.join(out, "jobs", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"), "utf8")).job, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  assert.deepEqual(await runJobLinkCommand({ argv: ["--store", "ourostack/factory", "--desk-remote", "git@github.com:OuroStack/Desk.git", "--person-prefix", "", "--track", "factory", "--slug", "store-pipeline"] }), {
    link: "https://github.com/ourostack/factory/blob/reports/jobs/3e7101c7c7d8774223be31b99495dd7f.md",
  })
  await assert.rejects(runBuildCommand({ argv: ["--store", store] }), /Usage: factory\.js build/u)
  await assert.rejects(runJobLinkCommand({ argv: ["--store", "ourostack/factory"] }), /Usage: factory\.js job-link/u)
}))

test("validate-pr reads base and head as Git data, enforces facts for contributors, and marks maintainer changes", () => scratch(async (env) => {
  const repo = path.join(env.HOME, "store")
  const facts = path.join(repo, "facts")
  await fs.mkdir(facts, { recursive: true })
  const fixtureName = "claude-code-11111111-1111-4111-8111-111111111111.json"
  const fixture = readFileSync(path.join(FIXTURE_STORE, "facts", fixtureName), "utf8")
  await fs.writeFile(path.join(facts, fixtureName), fixture)
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo })
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo })
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo })
  execFileSync("git", ["add", "facts"], { cwd: repo })
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo })
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()

  const updated = JSON.parse(fixture)
  updated.session.duration_ms += 1
  await fs.writeFile(path.join(facts, fixtureName), `${JSON.stringify(updated)}\n`)
  execFileSync("git", ["add", "facts"], { cwd: repo })
  execFileSync("git", ["commit", "-q", "-m", "facts"], { cwd: repo })
  const factsHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", base, "--head", factsHead, "--author-association", "CONTRIBUTOR"], cwd: repo }), {
    ok: true,
    maintenance: false,
    errors: [],
  })

  const marker = path.join(env.HOME, "executed")
  await fs.writeFile(path.join(repo, "candidate.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`)
  execFileSync("git", ["add", "candidate.js"], { cwd: repo })
  execFileSync("git", ["commit", "-q", "-m", "candidate"], { cwd: repo })
  const maintenanceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", factsHead, "--head", maintenanceHead, "--author-association", "OWNER"], cwd: repo }), {
    ok: true,
    maintenance: true,
    errors: [],
  })
  assert.deepEqual(await runValidatePrCommand({ argv: ["--base", factsHead, "--head", maintenanceHead, "--author-association", "NONE"], cwd: repo }), {
    ok: false,
    maintenance: false,
    errors: [{ code: "path", path: "changes.0" }],
  })
  assert.equal(existsSync(marker), false)
}))

test("validate-pr rejects malformed options and main exits one while still printing stable validation JSON", () => scratch(async (env) => {
  await assert.rejects(runValidatePrCommand({ argv: ["--base", "x"] }), /Usage: factory\.js validate-pr/u)
  let output = ""
  let logged = ""
  const code = await main({
    argv: ["validate-pr", "--base", "x", "--head", "y", "--author-association", "NONE"],
    env,
    write: (text) => { output += text },
    logError: (text) => { logged += text },
  })
  assert.equal(code, 1)
  assert.equal(output, "")
  assert.match(logged, /base and head/u)
}))

// ---------------------------------------------------------------------------
// runConsentCommand.
// ---------------------------------------------------------------------------

test("runConsentCommand sets consent and returns the store's record", () => scratch(async (env) => {
  const result = await runConsentCommand({ argv: ["--store", "ourostack/factory", "--contribute", "yes"], env })
  assert.equal(result.store, "ourostack/factory")
  assert.equal(result.contribute, true)
  assert.match(result.intake_id, /^[0-9a-f]{16}$/u)
  assert.deepEqual((await readConsent(env)).stores["ourostack/factory"].intake_id, result.intake_id)
}))

test("runConsentCommand accepts an optional --account", () => scratch(async (env) => {
  const result = await runConsentCommand({ argv: ["--store", "ourostack/factory", "--contribute", "yes", "--account", "arimendelow"], env })
  assert.equal(result.account, "arimendelow")
}))

test("runConsentCommand rejects malformed argv, a missing --store, and a --contribute that isn't yes/no", () => scratch(async (env) => {
  await assert.rejects(() => runConsentCommand({ argv: ["--store"], env }), /Usage: factory\.js consent/u)
  await assert.rejects(() => runConsentCommand({ argv: ["--contribute", "yes"], env }), /Usage: factory\.js consent/u)
  await assert.rejects(() => runConsentCommand({ argv: ["--store", "a/b", "--contribute", "maybe"], env }), /Usage: factory\.js consent/u)
}))

test("runConsentCommand rejects an unknown option", () => scratch(async (env) => {
  await assert.rejects(
    () => runConsentCommand({ argv: ["--store", "a/b", "--contribute", "yes", "--extra", "x"], env }),
    /unknown option --extra/u,
  )
}))

// ---------------------------------------------------------------------------
// main: dispatch, exit codes, and the consent round trip.
// ---------------------------------------------------------------------------

test("main dispatches consent, prints one JSON line, and returns exit code 0", () => scratch(async (env) => {
  let written = ""
  const code = await main({ argv: ["consent", "--store", "ourostack/factory", "--contribute", "yes"], env, write: (text) => { written += text }, logError: () => assert.fail("should not log an error") })
  assert.equal(code, 0)
  const parsed = JSON.parse(written)
  assert.equal(parsed.store, "ourostack/factory")
  assert.equal(parsed.contribute, true)
}))

test("main returns exit code 1 and logs one line for an unknown subcommand", () => scratch(async (env) => {
  let logged = ""
  const code = await main({ argv: ["bogus"], env, write: () => assert.fail("should not write"), logError: (text) => { logged += text } })
  assert.equal(code, 1)
  assert.match(logged, /unknown subcommand "bogus"/u)
}))

test("main returns exit code 1 and logs the usage message for a malformed consent call", () => scratch(async (env) => {
  let logged = ""
  const code = await main({ argv: ["consent"], env, write: () => assert.fail("should not write"), logError: (text) => { logged += text } })
  assert.equal(code, 1)
  assert.match(logged, /Usage: factory\.js consent/u)
}))

test("main reports an unknown subcommand as an empty string when argv is empty", () => scratch(async (env) => {
  let logged = ""
  const code = await main({ argv: [], env, write: () => assert.fail("should not write"), logError: (text) => { logged += text } })
  assert.equal(code, 1)
  assert.match(logged, /unknown subcommand ""/u)
}))

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

test("the CLI consent round trip: yes mints an intake_id, a later no keeps it, both visible in the written consent.json", () => scratch(async (env) => {
  const fullEnv = { ...process.env, ...env }
  const yesOut = JSON.parse(runCli(["consent", "--store", "ourostack/factory", "--contribute", "yes"], fullEnv))
  assert.equal(yesOut.contribute, true)
  assert.match(yesOut.intake_id, /^[0-9a-f]{16}$/u)

  const noOut = JSON.parse(runCli(["consent", "--store", "ourostack/factory", "--contribute", "no", "--account", "arimendelow"], fullEnv))
  assert.equal(noOut.contribute, false)
  assert.equal(noOut.intake_id, yesOut.intake_id)
  assert.equal(noOut.account, "arimendelow")

  assert.equal((await readConsent(env)).stores["ourostack/factory"].intake_id, yesOut.intake_id)
}))

test("the real CLI exits non-zero and prints one line to stderr for a bad invocation", () => scratch(async (env) => {
  const fullEnv = { ...process.env, ...env }
  try {
    execFileSync(process.execPath, [SCRIPT, "consent"], { encoding: "utf8", env: fullEnv, stdio: ["ignore", "pipe", "pipe"] })
    assert.fail("expected a non-zero exit")
  } catch (error) {
    assert.equal(error.status, 1)
    assert.match(error.stderr.toString(), /Usage: factory\.js consent/u)
  }
}))
