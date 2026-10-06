// Desk-only enforcement is only as good as its own registration (spec §5's
// "closed instead by desk_status and the boot checks verifying ... and
// reporting a missing registration through the failure contract as a
// `Desk problem:` block"). This module only verifies registration and
// formats the block; it never files by itself -- `hookRegistrationDeskProblem`'s
// `fileProblem` has no filing default, so with none given the block still
// renders honestly with `file: not filed: filer_unavailable`. Each real
// caller's own filing step (the boot check's detached launch, desk_status's
// read-only report) is tested where it lives: boot_checks_host_enforcement.test.js
// and status_host_enforcement.test.js; the real filer itself is
// desk_problem_file.test.js's job.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import {
  hookRegistrationDeskProblem,
  verifyHookRegistered,
} from "../../../../../plugins/desk/mcp/src/runtime/host-enforcement-registration.js"

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
  const result = await verifyHookRegistered({ host: "some-future-host", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON) })
  assert.deepEqual(result, { applicable: false, registered: null })
})

test("verifyHookRegistered reads the real hooks.json from this checkout by default (no readFile override)", async () => {
  const pluginRoot = new URL("../../../../../plugins/desk/", import.meta.url).pathname.replace(/\/$/, "")
  const result = await verifyHookRegistered({ host: "claude", pluginRoot })
  assert.deepEqual(result, { applicable: true, registered: true })
})

test("verifyHookRegistered reports registered: false when hooks.json has no PreToolUse array at all", async () => {
  const result = await verifyHookRegistered({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(JSON.stringify({ hooks: {} })) })
  assert.equal(result.registered, false)
  assert.match(result.reason, /missing from hooks\.json/)
})

test("hookRegistrationDeskProblem reports nothing for a host that isn't applicable", async () => {
  const result = await hookRegistrationDeskProblem({ host: "some-future-host", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON) })
  assert.deepEqual(result, { registered: null, block: null })
})

test("hookRegistrationDeskProblem reports registered with no block when the hook is registered", async () => {
  const result = await hookRegistrationDeskProblem({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON) })
  assert.deepEqual(result, { registered: true, block: null })
})

test("hookRegistrationDeskProblem renders the five-field Desk problem: block, honestly not filed, when no fileProblem is given", async () => {
  const result = await hookRegistrationDeskProblem({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_HOOKS_JSON) })
  assert.equal(result.registered, false)
  assert.match(result.block, /^Desk problem: host-enforcement — /)
  assert.match(result.block, /\n {2}broke: /)
  assert.match(result.block, /\n {2}means: /)
  assert.match(result.block, /\n {2}fix: /)
  assert.match(result.block, /\n {2}file: not filed: filer_unavailable/)
  assert.match(result.block, /\n {2}tell: /)
})

test("verifyHookRegistered reports registered: false for Copilot when copilot-hooks.json has no preToolUse array at all", async () => {
  const result = await verifyHookRegistered({ host: "copilot", pluginRoot: "/fixture", readFile: readFileReturning(JSON.stringify({ hooks: {} })) })
  assert.equal(result.registered, false)
  assert.match(result.reason, /missing from copilot-hooks\.json/)
})

test("hookRegistrationDeskProblem defaults to the real hooks.json and the honest not-filed default when called with no arguments at all", async () => {
  const result = await hookRegistrationDeskProblem()
  assert.equal(result.registered, null)
  assert.equal(result.block, null)
})

test("hookRegistrationDeskProblem's filing step is swappable: a different fileProblem changes the block's file: field, and is given the host and the reason", async () => {
  const calls = []
  const fileProblem = async (args) => {
    calls.push(args)
    return { file: "https://github.com/ourostack/desk/issues/999" }
  }
  const result = await hookRegistrationDeskProblem({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_HOOKS_JSON), env: { FAKE: "1" }, fileProblem })
  assert.match(result.block, /\n {2}file: https:\/\/github\.com\/ourostack\/desk\/issues\/999/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].host, "claude")
  assert.deepEqual(calls[0].env, { FAKE: "1" })
  assert.match(calls[0].reason, /missing from hooks\.json/)
})

test("hookRegistrationDeskProblem never calls fileProblem when the hook is registered or the host isn't applicable", async () => {
  const fileProblem = async () => { throw new Error("must not be called") }
  await hookRegistrationDeskProblem({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON), fileProblem })
  await hookRegistrationDeskProblem({ host: "some-future-host", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_HOOKS_JSON), fileProblem })
})

const REGISTERED_COPILOT_HOOKS_JSON = JSON.stringify({
  hooks: {
    preToolUse: [
      { type: "command", bash: "node \"${PLUGIN_ROOT}/hooks/protected-checkout.cjs\" copilot", powershell: "node \"${PLUGIN_ROOT}/hooks/protected-checkout.cjs\" copilot", timeoutSec: 10 },
      { type: "command", bash: "node \"${PLUGIN_ROOT}/hooks/host-enforcement.cjs\" copilot", powershell: "node \"${PLUGIN_ROOT}/hooks/host-enforcement.cjs\" copilot", timeoutSec: 10 },
    ],
  },
})

const UNREGISTERED_COPILOT_HOOKS_JSON = JSON.stringify({
  hooks: {
    preToolUse: [
      { type: "command", bash: "node \"${PLUGIN_ROOT}/hooks/protected-checkout.cjs\" copilot", powershell: "node \"${PLUGIN_ROOT}/hooks/protected-checkout.cjs\" copilot", timeoutSec: 10 },
    ],
  },
})

test("verifyHookRegistered reports registered: true for Copilot when copilot-hooks.json's preToolUse array carries host-enforcement.cjs", async () => {
  const result = await verifyHookRegistered({ host: "copilot", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_COPILOT_HOOKS_JSON) })
  assert.deepEqual(result, { applicable: true, registered: true })
})

test("verifyHookRegistered reports registered: false for Copilot with a reason when copilot-hooks.json has no host-enforcement.cjs entry", async () => {
  const result = await verifyHookRegistered({ host: "copilot", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_COPILOT_HOOKS_JSON) })
  assert.equal(result.applicable, true)
  assert.equal(result.registered, false)
  assert.match(result.reason, /missing from copilot-hooks\.json/)
})

test("verifyHookRegistered never throws on an unreadable or corrupt copilot-hooks.json, and reports it as not registered", async () => {
  const unreadable = await verifyHookRegistered({
    host: "copilot", pluginRoot: "/fixture", readFile: async () => { throw new Error("ENOENT: no such file") },
  })
  assert.equal(unreadable.registered, false)
  assert.match(unreadable.reason, /ENOENT/)
})

test("verifyHookRegistered reads the real copilot-hooks.json from this checkout by default (no readFile override)", async () => {
  const pluginRoot = new URL("../../../../../plugins/desk/", import.meta.url).pathname.replace(/\/$/, "")
  const result = await verifyHookRegistered({ host: "copilot", pluginRoot })
  assert.deepEqual(result, { applicable: true, registered: true })
})

test("verifyHookRegistered always reports Codex as registered: false, with a reason naming Codex's own hook-trust gate, never claiming an active deny hook Codex would silently skip", async () => {
  const result = await verifyHookRegistered({ host: "codex", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON) })
  assert.equal(result.applicable, true)
  assert.equal(result.registered, false)
  assert.match(result.reason, /hook.trust/i)
  assert.match(result.reason, /host-enforcement-live-proof\.md/)
})

test("hookRegistrationDeskProblem renders Codex's own not-active block, naming the hook-trust gate rather than telling the operator to reinstall Desk", async () => {
  const result = await hookRegistrationDeskProblem({ host: "codex", pluginRoot: "/fixture" })
  assert.equal(result.registered, false)
  assert.match(result.block, /^Desk problem: host-enforcement — /)
  assert.match(result.block, /\n {2}fix: /)
  assert.doesNotMatch(result.block, /reinstall Desk/)
  assert.match(result.block, /\n {2}tell: .*hook trust/)
})

test("hookRegistrationDeskProblem still renders the generic missing-registration block for Copilot, the same shape as Claude Code's", async () => {
  const result = await hookRegistrationDeskProblem({ host: "copilot", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_COPILOT_HOOKS_JSON) })
  assert.equal(result.registered, false)
  assert.match(result.block, /^Desk problem: host-enforcement — /)
  assert.match(result.block, /\n {2}fix: not auto-repaired -- reinstall Desk to restore it\./)
})

// The sign-off witness is registered next to the host-enforcement hook: one hook script, three modes. The same registration is also checked,
// with the hook's behaviour, in signoff_witness.test.js.
test("the shipped Claude and Copilot registrations carry the sign-off witness in each of its modes", () => {
  const load = (name) => JSON.parse(readFileSync(new URL(`../../../../../plugins/desk/hooks/${name}`, import.meta.url), "utf8")).hooks
  const claude = load("hooks.json")
  const claudeCommands = (event) => claude[event].flatMap((entry) => entry.hooks.map((hook) => hook.command)).filter((command) => command.includes("signoff-witness.cjs"))
  assert.deepEqual(claudeCommands("UserPromptSubmit"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/signoff-witness.cjs" prompt'])
  assert.deepEqual(claudeCommands("Stop"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/signoff-witness.cjs" stop'])
  assert.deepEqual(claudeCommands("PreToolUse"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/signoff-witness.cjs" ticket'])
  const copilot = load("copilot-hooks.json")
  const copilotCommands = (event) => copilot[event].map((entry) => entry.bash).filter((command) => command.includes("signoff-witness.cjs"))
  assert.deepEqual(copilotCommands("userPromptSubmitted"), ['node "${PLUGIN_ROOT}/hooks/signoff-witness.cjs" prompt'])
  assert.deepEqual(copilotCommands("agentStop"), ['node "${PLUGIN_ROOT}/hooks/signoff-witness.cjs" stop'])
  assert.deepEqual(copilotCommands("preToolUse"), [])
})
