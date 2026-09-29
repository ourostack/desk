// Desk-only enforcement is only as good as its own registration (spec §5's
// "closed instead by desk_status and the boot checks verifying ... and
// reporting a missing registration through the failure contract as a
// `Desk problem:` block"). `fileHookRegistrationProblem` files through the
// real Desk-problem filer (factory/desk-problem-file.js) when given an
// `env`; with none, there is nothing to resolve an account or a `gh` binary
// from, so it stays `not filed: filer_unavailable` -- both proven below,
// the filing case with a fully mocked runner so no test here ever makes a
// real network call.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  fileHookRegistrationProblem,
  hookRegistrationDeskProblem,
  verifyHookRegistered,
} from "../../../../../plugins/desk/mcp/src/runtime/host-enforcement-registration.js"
import { MAX_PROBLEMS_PER_DAY, STORE } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-file.js"
import { deskProblemFingerprint, normalizeErrorSignature } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-fingerprint.js"

const VERSION = "gh version 2.54.0 (2024-07-31)\n"
const PUSH = { full_name: STORE, private: false, allow_forking: true, default_branch: "main", permissions: { push: true, pull: true } }

/** A minimal one-account, push-capable gh model -- see desk_problem_file.test.js's fuller version for the shape this mirrors. */
function fakeGh({ issues = [], create = { number: 1, html_url: `https://github.com/${STORE}/issues/1` } } = {}) {
  return async (args) => {
    if (args[0] === "--version") return { code: 0, stdout: VERSION, stderr: "" }
    if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account contributor (keyring)\n  - Active account: true\n", stderr: "" }
    if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: "token-contributor\n", stderr: "" }
    if (args[0] === "api") {
      const route = args[7]
      if (route === `repos/${STORE}`) return { code: 0, stdout: JSON.stringify(PUSH), stderr: "" }
      if (route.startsWith(`repos/${STORE}/issues?`)) return { code: 0, stdout: JSON.stringify(issues), stderr: "" }
      if (args[2] === "POST" && route === `repos/${STORE}/issues`) return { code: 0, stdout: JSON.stringify(create), stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "unexpected call\n" }
  }
}

const REGISTERED_HOOKS_JSON = JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/protected-checkout.cjs\" claude" }] },
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/host-enforcement.cjs\" claude" }] },
    ],
  },
})

const UNREGISTERED_HOOKS_JSON = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/protected-checkout.cjs\" claude" }] }] },
})

function readFileReturning(content) {
  return async () => content
}

test("verifyHookRegistered reports registered: true when hooks.json's PreToolUse array carries host-enforcement.cjs", async () => {
  const result = await verifyHookRegistered({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON) })
  assert.deepEqual(result, { applicable: true, registered: true })
})

test("verifyHookRegistered reports registered: false with a reason when hooks.json exists but has no host-enforcement.cjs entry", async () => {
  const result = await verifyHookRegistered({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_HOOKS_JSON) })
  assert.equal(result.applicable, true)
  assert.equal(result.registered, false)
  assert.match(result.reason, /missing from hooks\.json/)
})

test("verifyHookRegistered never throws on an unreadable or corrupt hooks.json, and reports it as not registered", async () => {
  const unreadable = await verifyHookRegistered({
    host: "claude", pluginRoot: "/fixture", readFile: async () => { throw new Error("ENOENT: no such file") },
  })
  assert.equal(unreadable.registered, false)
  assert.match(unreadable.reason, /ENOENT/)

  const corrupt = await verifyHookRegistered({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning("not json") })
  assert.equal(corrupt.registered, false)
})

test("verifyHookRegistered claims nothing for a host it does not check", async () => {
  const result = await verifyHookRegistered({ host: "copilot", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON) })
  assert.deepEqual(result, { applicable: false, registered: null })
})

test("verifyHookRegistered reads the real hooks.json from this checkout by default (no readFile override)", async () => {
  const pluginRoot = new URL("../../../../../plugins/desk/", import.meta.url).pathname.replace(/\/$/, "")
  const result = await verifyHookRegistered({ host: "claude", pluginRoot })
  assert.deepEqual(result, { applicable: true, registered: true })
})

test("hookRegistrationDeskProblem reports nothing for a host that isn't applicable", async () => {
  const result = await hookRegistrationDeskProblem({ host: "copilot", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON) })
  assert.deepEqual(result, { registered: null, block: null })
})

test("hookRegistrationDeskProblem reports registered with no block when the hook is registered", async () => {
  const result = await hookRegistrationDeskProblem({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON) })
  assert.deepEqual(result, { registered: true, block: null })
})

test("hookRegistrationDeskProblem renders the five-field Desk problem: block, with the default filer's not-filed reason, when missing", async () => {
  const result = await hookRegistrationDeskProblem({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_HOOKS_JSON) })
  assert.equal(result.registered, false)
  assert.match(result.block, /^Desk problem: host-enforcement — /)
  assert.match(result.block, /\n {2}broke: /)
  assert.match(result.block, /\n {2}means: /)
  assert.match(result.block, /\n {2}fix: /)
  assert.match(result.block, /\n {2}file: not filed: filer_unavailable/)
  assert.match(result.block, /\n {2}tell: /)
})

test("verifyHookRegistered reports registered: false when hooks.json has no PreToolUse array at all", async () => {
  const result = await verifyHookRegistered({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(JSON.stringify({ hooks: {} })) })
  assert.equal(result.registered, false)
  assert.match(result.reason, /missing from hooks\.json/)
})

test("hookRegistrationDeskProblem defaults to the real hooks.json and the real filer stub when called with no arguments at all", async () => {
  const result = await hookRegistrationDeskProblem()
  assert.equal(result.registered, null)
  assert.equal(result.block, null)
})

test("fileHookRegistrationProblem is honest about not filing yet with no env at all (undefined or null)", async () => {
  assert.deepEqual(await fileHookRegistrationProblem(), { file: "not filed: filer_unavailable" })
  assert.deepEqual(await fileHookRegistrationProblem({ env: null, host: "claude" }), { file: "not filed: filer_unavailable" })
})

test("hookRegistrationDeskProblem's filing step is swappable: a different fileProblem changes the block's file: field", async () => {
  const fileProblem = async () => ({ file: "https://github.com/ourostack/desk/issues/999" })
  const result = await hookRegistrationDeskProblem({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_HOOKS_JSON), fileProblem })
  assert.match(result.block, /\n {2}file: https:\/\/github\.com\/ourostack\/desk\/issues\/999/)
})

async function scratchEnv(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "host-enforcement-registration-")))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return await run(env)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

test("fileHookRegistrationProblem given an env files for real through fileDeskProblem, and reports the block's <url> (filed) shape", () => scratchEnv(async (env) => {
  const result = await fileHookRegistrationProblem({ env, host: "claude", reason: "host-enforcement.cjs missing from hooks.json's PreToolUse array", runner: fakeGh() })
  assert.deepEqual(result, { file: `https://github.com/${STORE}/issues/1 (filed)` })
}))

test("fileHookRegistrationProblem reports the known: <url> shape when a matching fingerprint is already filed", () => scratchEnv(async (env) => {
  const reason = "host-enforcement.cjs missing from hooks.json's PreToolUse array"
  const fingerprint = deskProblemFingerprint("host-enforcement", normalizeErrorSignature(reason))
  const runner = fakeGh({
    issues: [{
      number: 7,
      html_url: `https://github.com/${STORE}/issues/7`,
      title: "host enforcement: deny hook not registered",
      body: `<!-- desk-problem-fingerprint: ${fingerprint} -->`,
      labels: [{ name: "desk-problem" }],
      state: "open",
      pull_request: null,
    }],
  })
  const result = await fileHookRegistrationProblem({ env, host: "claude", reason, runner })
  assert.deepEqual(result, { file: `known: https://github.com/${STORE}/issues/7` })
}))

test("fileHookRegistrationProblem reports not filed: <reason> when no account can file, never throwing", () => scratchEnv(async (env) => {
  const result = await fileHookRegistrationProblem({ env: { ...env, PATH: "" }, host: "claude", reason: "hooks.json unreadable (ENOENT)" })
  assert.equal(result.file, "not filed: no_suitable_account")
}))

test("hookRegistrationDeskProblem threads env and a mocked runner through to the real filer end to end", () => scratchEnv(async (env) => {
  const result = await hookRegistrationDeskProblem({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_HOOKS_JSON), env, runner: fakeGh() })
  assert.equal(result.registered, false)
  assert.match(result.block, new RegExp(`file: https://github\\.com/${STORE.replace("/", "\\/")}/issues/1 \\(filed\\)`))
}))

test("fileHookRegistrationProblem falls back to a generic reason when none is given, and still files", () => scratchEnv(async (env) => {
  const result = await fileHookRegistrationProblem({ env, host: "claude", runner: fakeGh() })
  assert.match(result.file, /\(filed\)$/u)
}))

test("fileHookRegistrationProblem reports not filed: held_cap once the day's filing cap is spent", () => scratchEnv(async (env) => {
  const now = () => Date.parse("2026-09-28T10:00:00Z")
  for (let i = 0; i < MAX_PROBLEMS_PER_DAY; i += 1) {
    const result = await fileHookRegistrationProblem({ env, host: "claude", reason: `distinct reason ${i}`, runner: fakeGh(), now })
    assert.match(result.file, /\(filed\)$/u)
  }
  const held = await fileHookRegistrationProblem({ env, host: "claude", reason: `distinct reason ${MAX_PROBLEMS_PER_DAY}`, runner: fakeGh(), now })
  assert.equal(held.file, "not filed: held_cap")
}))
