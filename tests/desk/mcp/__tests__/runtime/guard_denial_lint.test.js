// Every denial Desk shows an agent opens with the fix. Hosts cut a denial at about one line (Copilot's UI showed one line of a
// real denial on 2026-10-01, so the agent never saw the fix and spent turns on it), so the first sentence is at most 120
// characters and starts with an imperative verb or the command to run; the reason follows it. This test builds every denial
// the code can produce, from representative inputs and the exported message constants, and applies that rule. A new guard
// message belongs in the tests above: the registry test at the end fails when a file gains or loses a denial site, naming the file.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { assertActionable, firstSentence } from "./_guard_text.js"
import { assertNotRealStateUnderTest as assertNotRealRuntimeState } from "../../../../../plugins/desk/mcp/src/runtime/test-state-guard.js"
import { assertNotRealStateUnderTest as assertNotRealFactoryState } from "../../../../../plugins/desk/mcp/src/factory/test-state-guard.js"
import { hookScript } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))

// ---- the rule itself ----

test("the rule: a first sentence of at most 120 characters that starts with a verb or the command to run", () => {
  assert.equal(firstSentence("Run git status. More."), "Run git status.")
  assert.equal(firstSentence("Run this instead: git status | Format-Table\nMore. Text."), "Run this instead: git status | Format-Table")
  assert.equal(firstSentence("Retry"), "Retry")
  assertActionable(assert, "Use your own worktree: git worktree add --detach x y. Why.")
  assertActionable(assert, "git status is fine. Why.")
  assert.throws(() => assertActionable(assert, "Desk denies this. Use git status."), /imperative verb/u)
  assert.throws(() => assertActionable(assert, `Use ${"x".repeat(120)}. Why.`), /over 120/u)
  assert.throws(() => assertActionable(assert, 5), /is text/u)
})

test("the pre-commit card guard's refusal opens with the fix, naming the staged card", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "lint-precommit-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "none"), GIT_CONFIG_NOSYSTEM: "1" } })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture")
  mkdirSync(path.join(root, "_meta")); mkdirSync(path.join(root, "_archive")); mkdirSync(path.join(root, "greenhouse", "watering-api"), { recursive: true })
  writeFileSync(path.join(root, "_meta", "x.md"), "x\n")
  writeFileSync(path.join(root, "greenhouse", "watering-api", "task.md"), "---\ntitle: W\nstatus: processing\n---\n\nbody\n")
  const hook = path.join(root, ".git", "hooks", "pre-commit")
  writeFileSync(hook, hookScript())
  chmodSync(hook, 0o755)
  git("add", "-A")
  const result = git("commit", "-qm", "edit")
  assert.notEqual(result.status, 0)
  assertActionable(assert, result.stderr, "pre-commit")
  // The command names the repository root, so it opens the line when it fits and follows it when the root is long.
  assert.match(result.stderr, /git -C "[^"]+" restore --staged "greenhouse\/watering-api\/task\.md"/u)
  assert.match(firstSentence(result.stderr), /^Run (?:git -C .* restore --staged .* and call task_update for it|the command below, then call task_update for the card)/u)
})

test("the test-isolation refusals open with the fix", () => {
  for (const guard of [assertNotRealRuntimeState, assertNotRealFactoryState]) {
    assert.throws(() => guard("/home/someone/.local/state/ouroboros-skills/desk", { env: { NODE_TEST_CONTEXT: "child" }, platform: "linux" }), (error) => (assertActionable(assert, error.message, "test state"), true))
  }
})

// ---- the registry: a new denial must be added to this file ----

test("every file under plugins/desk that emits a denial is accounted for in this test", () => {
  const sites = /[^.\w]unresolved\(|decision: "block"|permissionDecision: "deny"|permissionDecisionReason: |unstage="git -C|echo "Desk refused this commit|new Error\(\s*`Resolve state/gmu
  // Files that build a denial's own text, with how many sites each has. A new guard adds its messages to the tests above
  // and its count here; a count that moves fails, so a message cannot be added or removed unnoticed.
  const expected = {
    "mcp/src/runtime/test-state-guard.js": 1, "mcp/src/factory/test-state-guard.js": 1,
    "mcp/src/desk/card-commit-guard.js": 2,
    // Its `unresolved` is a sync outcome, not a denial.
    "mcp/src/runtime/session-sync.js": 6,
  }
  // Comment lines do not emit anything.
  const code = (file) => readFileSync(path.join(plugin, file), "utf8").split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join("\n")
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(full)
    return /\.(?:js|cjs|mjs)$/u.test(entry.name) ? [full] : []
  })
  const found = {}
  for (const file of files(plugin)) {
    const relative = path.relative(plugin, file).split(path.sep).join("/")
    const count = [...code(relative).matchAll(sites)].length
    if (count > 0) found[relative] = count
  }
  assert.deepEqual(found, expected, "a file gained or lost a denial site: add its message to guard_denial_lint.test.js and update this table")
})
