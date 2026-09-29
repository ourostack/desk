// Desk-only enforcement is only as good as its own registration (spec §5's
// "closed instead by desk_status and the boot checks verifying ... and
// reporting a missing registration through the failure contract as a
// `Desk problem:` block"). Part 4's real filer has not merged yet: the
// registration check emits the block with `file: not filed:
// filer_unavailable` behind `fileHookRegistrationProblem`, the single
// function a later PR swaps for a call into the real filer -- proven here by
// swapping it in a test.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  fileHookRegistrationProblem,
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

test("hookRegistrationDeskProblem reports nothing for a host that isn't applicable", async () => {
  const result = await hookRegistrationDeskProblem({ host: "some-future-host", pluginRoot: "/fixture", readFile: readFileReturning(REGISTERED_HOOKS_JSON) })
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

test("verifyHookRegistered reports registered: false for Copilot when copilot-hooks.json has no preToolUse array at all", async () => {
  const result = await verifyHookRegistered({ host: "copilot", pluginRoot: "/fixture", readFile: readFileReturning(JSON.stringify({ hooks: {} })) })
  assert.equal(result.registered, false)
  assert.match(result.reason, /missing from copilot-hooks\.json/)
})

test("hookRegistrationDeskProblem defaults to the real hooks.json and the real filer stub when called with no arguments at all", async () => {
  const result = await hookRegistrationDeskProblem()
  assert.equal(result.registered, null)
  assert.equal(result.block, null)
})

test("fileHookRegistrationProblem is the single swappable filing step, honest about not filing yet", async () => {
  assert.deepEqual(await fileHookRegistrationProblem(), { file: "not filed: filer_unavailable" })
})

test("hookRegistrationDeskProblem's filing step is swappable: a different fileProblem changes the block's file: field", async () => {
  const fileProblem = async () => ({ file: "https://github.com/ourostack/desk/issues/999" })
  const result = await hookRegistrationDeskProblem({ host: "claude", pluginRoot: "/fixture", readFile: readFileReturning(UNREGISTERED_HOOKS_JSON), fileProblem })
  assert.match(result.block, /\n {2}file: https:\/\/github\.com\/ourostack\/desk\/issues\/999/)
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
