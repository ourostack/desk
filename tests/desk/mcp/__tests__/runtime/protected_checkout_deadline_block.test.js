// protected-checkout.cjs's own 9 s deadline is migrated onto the failure
// contract only for a *repeated* timeout of the exact same command (spec.md
// §1's table, row 5, Part 5) -- see protected-checkout-repeat.js for the
// counting itself. `deadlineDecision` and `commandTextFromRawInput` are
// tested here directly, in-process (no subprocess, no `gh`); one e2e test at
// the bottom drives the real hook process to the repeat threshold, with
// HOME/XDG redirected to a throwaway fixture root so the detached filer it
// really spawns can reach no real gh credentials and no network.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { REPEAT_TIMEOUT_THRESHOLD, commandSignature } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout-repeat.js"
import { protectCheckout } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout.js"
import { processesWithCwdUnder, reapProcessesUnder, removeFixtureAfter, slowGit } from "../_process_hygiene.js"

const require = createRequire(import.meta.url)
const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hookPath = path.join(plugin, "hooks", "protected-checkout.cjs")
const { commandTextFromRawInput, deadlineDecision } = require(hookPath)

function fixtureEnv(t) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-protected-checkout-deadline-"))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  return { root, env: { HOME: root } }
}

// A minimal protected checkout: just enough for `git checkout topic` to need
// a Git read the inspector can be made to block on (below), so the hook's own
// 9 s deadline is the thing that answers, never the inspector itself.
async function protectedRepoFixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-protected-checkout-deadline-repo-")))
  removeFixtureAfter(t, root)
  const home = path.join(root, "home")
  mkdirSync(home)
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n")
  const env = { HOME: home, GIT_CONFIG_NOSYSTEM: "1", PATH: process.env.PATH }
  const prot = path.join(root, "prot")
  const git = (...args) => execFileSync("git", ["-C", prot, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  execFileSync("git", ["init", "-q", "-b", "main", prot], { env })
  writeFileSync(path.join(prot, "file.txt"), "base\n")
  git("add", "file.txt")
  git("commit", "-qm", "first")
  git("branch", "topic")
  await protectCheckout({ root: prot, stateBranch: "main" })
  return { root, home, env, prot }
}

test("commandTextFromRawInput reads tool_input.command from a Claude-shaped payload", () => {
  assert.equal(commandTextFromRawInput(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git checkout topic" } })), "git checkout topic")
})

test("commandTextFromRawInput reads toolArgs.command, and unwraps a stringified toolArgs, from a Copilot-shaped payload", () => {
  assert.equal(commandTextFromRawInput(JSON.stringify({ toolArgs: { command: "git checkout topic" } })), "git checkout topic")
  assert.equal(commandTextFromRawInput(JSON.stringify({ toolArgs: JSON.stringify({ command: "git checkout topic" }) })), "git checkout topic")
})

test("commandTextFromRawInput returns '' for unparseable, incomplete or command-less input, never throwing", () => {
  assert.equal(commandTextFromRawInput("not json"), "")
  assert.equal(commandTextFromRawInput(""), "")
  assert.equal(commandTextFromRawInput(JSON.stringify({ tool_name: "Bash" })), "")
  assert.equal(commandTextFromRawInput(JSON.stringify({ tool_input: { command: 42 } })), "")
})

test("deadlineDecision's plain deny decision is unchanged, and no block is added, below the repeat threshold", async (t) => {
  const { env } = fixtureEnv(t)
  const rawInput = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git checkout topic" } })
  for (let count = 1; count < REPEAT_TIMEOUT_THRESHOLD; count += 1) {
    const { decision, block } = await deadlineDecision({ rawInput, host: "claude", deadlineMs: 9000, env })
    assert.equal(decision.permissionDecision, "deny")
    assert.match(decision.permissionDecisionReason, /could not finish checking it in time/u)
    assert.equal(block, null)
  }
})

test("deadlineDecision adds a Desk problem: protected-checkout block and queues the filer once the same command repeats past the threshold", async (t) => {
  const { env } = fixtureEnv(t)
  const rawInput = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git checkout topic" } })
  const calls = []
  let result
  for (let count = 0; count < REPEAT_TIMEOUT_THRESHOLD; count += 1) {
    result = await deadlineDecision({ rawInput, host: "claude", deadlineMs: 9000, env, spawnFiler: (args) => calls.push(args) })
  }
  assert.equal(result.decision.permissionDecision, "deny")
  assert.match(result.decision.permissionDecisionReason, /could not finish checking it in time/u)
  assert.match(result.block, /^Desk problem: protected-checkout — the same command keeps timing out\n/u)
  assert.match(result.block, /file: filing in background/u)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].mechanism, "protected-checkout")
  assert.equal(calls[0].host, "claude")
  assert.match(calls[0].reason, /repeated timeout \(3x\)/u)
  assert.equal(calls[0].launchSignature, commandSignature("git checkout topic"), "the filer is told which throttle stamp to clear")
})

test("deadlineDecision throttles the filer spawn to once per hour even though the block keeps rendering on every later repeated timeout", async (t) => {
  const { env } = fixtureEnv(t)
  const rawInput = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git checkout topic" } })
  const calls = []
  let result
  // Ramp up to the threshold, exactly as the "...once the same command repeats past the threshold" test above does.
  for (let count = 0; count < REPEAT_TIMEOUT_THRESHOLD; count += 1) {
    result = await deadlineDecision({ rawInput, host: "claude", deadlineMs: 9000, env, spawnFiler: (args) => calls.push(args) })
  }
  assert.equal(calls.length, 1)
  assert.match(result.block, /file: filing in background/u)
  // Every later repeated timeout still renders the block, but the spawn itself is throttled.
  for (let extra = 0; extra < 6; extra += 1) {
    result = await deadlineDecision({ rawInput, host: "claude", deadlineMs: 9000, env, spawnFiler: (args) => calls.push(args) })
    assert.match(result.block, /^Desk problem: protected-checkout — the same command keeps timing out\n/u, `extra call ${extra}`)
  }
  assert.equal(calls.length, 1)
  assert.match(result.block, /file: filing already queued \(within the last hour\)/u)
})

test("deadlineDecision never lets a broken spawnFiler change the decision or block text", async (t) => {
  const { env } = fixtureEnv(t)
  const rawInput = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git checkout topic" } })
  let result
  for (let count = 0; count < REPEAT_TIMEOUT_THRESHOLD; count += 1) {
    result = await deadlineDecision({ rawInput, host: "claude", deadlineMs: 9000, env, spawnFiler: () => { throw new Error("spawn unavailable") } })
  }
  assert.match(result.block, /file: filing in background/u)
})

test("deadlineDecision never counts or blocks when the raw input carries no command at all", async (t) => {
  const { env } = fixtureEnv(t)
  for (let count = 0; count < REPEAT_TIMEOUT_THRESHOLD + 2; count += 1) {
    const result = await deadlineDecision({ rawInput: "not json", host: "claude", deadlineMs: 9000, env })
    assert.equal(result.block, null)
  }
})

test("deadlineDecision never throws even when the repeat module itself cannot be imported", async () => {
  const result = await deadlineDecision({ rawInput: "not json", host: "claude", deadlineMs: 9000, env: { HOME: "/nonexistent-protected-checkout-deadline-home" } })
  assert.equal(result.decision.permissionDecision, "deny")
  assert.equal(result.block, null)
})

// ── End-to-end: the real hook process, driven to the repeat threshold ──────

test("the real hook process denies with the plain reason every time, and adds the Desk problem: block only on the Nth repeated timeout", { skip: process.platform === "win32" ? "mkfifo is POSIX-only" : false }, async (t) => {
  const f = await protectedRepoFixture(t)
  // Git that never answers inside the guard's own budget, so every call below genuinely times out
  // at the hook's 300 ms deadline rather than racing it with a fast real decision.
  slowGit(t, f.prot, f.env, 60000)
  // The filer this hook can really spawn on the Nth call gets its own throwaway HOME/XDG state and
  // no real gh credentials, so even a real detached spawn can reach no network and no real account.
  const env = {
    ...f.env,
    XDG_CONFIG_HOME: path.join(f.home, ".config"),
    XDG_STATE_HOME: path.join(f.home, ".local", "state"),
    DESK_GUARD_DEADLINE_MS: "300",
  }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git checkout topic" }, cwd: f.prot })
  for (let count = 1; count < REPEAT_TIMEOUT_THRESHOLD; count += 1) {
    const result = spawnSync(process.execPath, [hookPath, "claude"], { cwd: f.prot, env, input, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /could not finish checking it in time/u)
    assert.equal(result.stderr, "")
  }
  const last = spawnSync(process.execPath, [hookPath, "claude"], { cwd: f.prot, env, input, encoding: "utf8" })
  assert.equal(last.status, 0, last.stderr)
  assert.match(JSON.parse(last.stdout).hookSpecificOutput.permissionDecisionReason, /could not finish checking it in time/u)
  assert.match(last.stderr, /^Desk problem: protected-checkout — the same command keeps timing out\n/u)
  assert.match(last.stderr, /file: filing in background/u)
  // The hook exited at its own deadline while Git was still blocked on the FIFO; it must not leave that Git behind.
  // Only Git is the subject. The Nth call also starts the detached filer on purpose, a Node process that inherits the hook's working directory and may legitimately still be starting when the hook has exited, so a list of every process under the fixture fails on a slow runner without any defect. The fixture cleanup stops the filer.
  const stillRunning = async () => processesWithCwdUnder(f.root).filter((entry) => /^git(?:\.exe)?$/u.test(entry.command))
  // Git is signalled before the hook exits; the loop only waits for the OS to finish ending it, and has no bearing on what is asserted.
  for (let attempt = 0; attempt < 200 && (await stillRunning()).length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(await stillRunning(), [])
  // The only thing the hook may leave is the detached filer it started on purpose (a Node process, launched detached with ignored stdio and never awaited: "launchCommand starts detached with ignored stdio and never waits for the child" in factory/start_hook.test.js). Whatever remains is Node, and once reaped nothing replaces it: the hook is gone and spawned no second helper.
  assert.ok(processesWithCwdUnder(f.root).every((entry) => /^node(?:\.exe)?$/u.test(entry.command)), JSON.stringify(processesWithCwdUnder(f.root)))
  await reapProcessesUnder(f.root)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(processesWithCwdUnder(f.root), [], "nothing is left after the filer is reaped, and nothing restarted it")
})
