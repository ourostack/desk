// The test preload fails a run that changes the Git configuration of the checkout it runs in. Proven against a temporary repository standing in for that checkout.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "./_temp_roots.js"
import { GUARDED_CHECKOUT } from "./_isolated_env.mjs"

const preload = fileURLToPath(new URL("./_isolated_env.mjs", import.meta.url))

async function repository(prefix) {
  const root = await mkTempRoot(prefix)
  execFileSync("git", ["init", "-q", root])
  return root
}

// A process that preloads the guard, standing in for the checkout at `guarded`, and runs `git config` with `args` in `target`.
function runWithGuard({ guarded, target, args, underRunner = false }) {
  const env = { ...process.env, [GUARDED_CHECKOUT]: guarded }
  delete env.NODE_TEST_CONTEXT
  if (underRunner) env.NODE_TEST_CONTEXT = "child-v8"
  const script = args ? `require("node:child_process").execFileSync("git", ${JSON.stringify(["-C", target, "config", ...args])})` : ""
  return spawnSync(process.execPath, ["--import", preload, "-e", script], { env, encoding: "utf8" })
}

test("a test run that writes the checkout's Git configuration fails and names what changed", async () => {
  const checkout = await repository("desk-guarded-checkout-")
  const result = runWithGuard({ guarded: checkout, target: checkout, args: ["--local", "desk.protected", "true"] })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /test isolation: the Git configuration of the checkout .* changed while this test run ran/u)
  assert.match(result.stderr, /added: local desk\.protected=true/u)
})

test("an include the checkout picks up counts as a change, the includeIf key itself does not", async () => {
  const checkout = await repository("desk-guarded-include-")
  const gitDir = execFileSync("git", ["-C", checkout, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim()
  const marker = path.join(gitDir, "desk-protected.config")
  execFileSync("git", ["config", "--file", marker, "desk.protected", "true"])
  const applied = runWithGuard({ guarded: checkout, target: checkout, args: ["--local", `includeIf.gitdir:${gitDir}.path`, marker] })
  assert.equal(applied.status, 1, applied.stderr)
  assert.match(applied.stderr, /desk\.protected=true/u)
  const other = await repository("desk-guarded-other-")
  const unrelated = runWithGuard({ guarded: checkout, target: checkout, args: ["--local", "includeIf.gitdir:/elsewhere/.git.path", path.join(other, "none.config")] })
  assert.equal(unrelated.status, 0, unrelated.stderr)
})

test("writes to temporary repositories and runs that write nothing pass", async () => {
  const checkout = await repository("desk-guarded-clean-")
  const scratch = await repository("desk-guarded-scratch-")
  assert.equal(runWithGuard({ guarded: checkout, target: scratch, args: ["--local", "desk.protected", "true"] }).status, 0)
  const quiet = runWithGuard({ guarded: checkout })
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.equal(quiet.stderr, "")
})

test("under the test runner a file's process names itself and leaves failing the run to the runner", async () => {
  const checkout = await repository("desk-guarded-runner-")
  const result = runWithGuard({ guarded: checkout, target: checkout, args: ["--local", "desk.protected", "true"], underRunner: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /test isolation: the Git configuration of the checkout .* changed while/u)
})
