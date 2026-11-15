import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
const require = createRequire(import.meta.url)
const verifier = require("../../../../../scripts/test-desk-host-manifests.cjs")
const read = (name) => JSON.parse(readFileSync(new URL(`../../../../../plugins/desk/hooks/${name}`, import.meta.url), "utf8"))

test("host manifests register only the session-end events, no per-turn factory hook, and detect drift", () => {
  assert.equal(typeof verifier.validateFactoryHooks, "function")
  assert.deepEqual(verifier.validateFactoryHooks(read("hooks.json"), read("copilot-hooks.json")), [])
  assert.equal(verifier.validateFactoryHooks({}, {}).length, 2)
  for (const event of ["SessionEnd", "sessionEnd"]) {
    const claude = read("hooks.json")
    const copilot = read("copilot-hooks.json")
    const manifest = /^[A-Z]/u.test(event) ? claude : copilot
    manifest.hooks[event] = []
    assert.equal(verifier.validateFactoryHooks(claude, copilot).length, 1)
  }
  const claude = read("hooks.json")
  const copilot = read("copilot-hooks.json")
  claude.hooks.Stop = [{ hooks: [{ type: "command", command: "other-command" }] }]
  copilot.hooks.agentStop = [{ type: "command", bash: "other-command" }]
  assert.equal(verifier.validateFactoryHooks(claude, copilot).length, 2)
})
