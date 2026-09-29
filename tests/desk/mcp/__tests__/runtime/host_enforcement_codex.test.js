// Codex CLI's `[hooks] PreToolUse` wiring for Desk-only enforcement (spec
// §5, Part 8): the same `.cjs` entry point Claude Code and Copilot use,
// reading Codex's own snake_case stdin shape (shared with Claude Code's --
// `docs/host-enforcement-live-proof.md`) and holding to Codex's own
// `PreToolUse` contract, which has no JSON shape at all: a deny is exit code
// 2 with the reason on stderr, an allow is silent. Codex's own denied-tool
// list is empty for all five surfaces today (see `host-enforcement.js`'s own
// header comment), so no real payload can drive this process to a deny;
// that contract is proved directly against `hookProcessOutput` in
// `host_enforcement.test.js` instead. This suite proves the wiring this
// process itself owns: the allow path -- the only one reachable today --
// writes nothing at all on either stream, unlike Claude Code and Copilot,
// which both always write a JSON `{}`; and an internal error still exits 1,
// never 2, so Desk's own failure can never be mistaken for a deliberate
// deny under Codex's exit-code convention.
//
// Codex's hook-trust gate (`docs/host-enforcement-live-proof.md`) means this
// hook is registered but not actually invoked by a real, unmodified Codex
// CLI today; this suite exercises the same script directly, the way Codex's
// own hook runner would once trust is granted.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as path from "node:path"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "host-enforcement.cjs")

function runHook(input, env = process.env) {
  return spawnSync(process.execPath, [hook, "codex"], { input: JSON.stringify(input), env, encoding: "utf8" })
}

test("a tool Codex has no denied entry for is allowed through silently: no stdout, no stderr, exit 0 -- unlike Claude Code and Copilot's always-JSON {}", () => {
  const result = runHook({ session_id: "s-1", tool_name: "Bash" })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
})

test("a missing tool_name is allowed through the same silent way", () => {
  const result = runHook({ session_id: "s-2" })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "")
})

test("malformed stdin fails open with exit code 1, never 2 -- Codex would read a 2 as a deliberate deny", () => {
  const broken = spawnSync(process.execPath, [hook, "codex"], { input: "not json", env: process.env, encoding: "utf8" })
  assert.notEqual(broken.status, 2)
  assert.equal(broken.status, 1)
})
