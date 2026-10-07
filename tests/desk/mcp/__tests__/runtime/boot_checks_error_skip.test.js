// A boot check that throws (spec.md §1's table, "boot-checks.cjs's own
// error-skip path"): before Part 5, `runBootChecks` simply skipped the
// check's line and repair, recording only `{ id, reason: "error" }` in the
// protected status.json -- the agent's own startup context never learned
// anything failed. Migrated onto the failure contract: the skip itself is
// unchanged (a broken check must never keep the registry from running the
// rest), but a `Desk problem: <check id> — ...` block is now added to the
// startup line, and the same detached-filer repair every other migrated
// mechanism uses is queued through the registry's own post-loop repair
// launcher -- never inline, never awaited on this check's own budget. Every
// desk and process here is a throwaway fixture; nothing reaches the real
// HOME or the network -- `launchRepair` is the same test seam
// `index_drift` boot checks already use.
import { test, after } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { strict as assert } from "node:assert"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const BOOT = fileURLToPath(new URL("../../../../../plugins/desk/hooks/boot-checks.cjs", import.meta.url))
const { runBootChecks } = require(BOOT)
// Every call gets its own throwaway HOME, so the filing throttle's stamp files never land under the process HOME and a rerun within the hour is never "already queued".
const tempHomes = []
const isolatedEnv = () => {
  const home = mkdtempSync(path.join(tmpdir(), "desk-error-skip-home-"))
  tempHomes.push(home)
  return { HOME: home, XDG_STATE_HOME: path.join(home, "state") }
}
after(() => { for (const home of tempHomes) rmSync(home, { recursive: true, force: true }) })
const quiet = { launchRepair: async () => {}, launch: async () => {}, record: async () => {} }

test("a check that throws produces a Desk problem: <id> block, queues the detached filer, and never throws itself", async () => {
  const launched = []
  const line = await runBootChecks({
    ...quiet,
    host: "claude",
    env: isolatedEnv(),
    checks: [{ id: "probe", budgetMs: 50, run: async () => { throw new Error("probe blew up") } }],
    launchRepair: async (command, env) => { launched.push({ command, env }) },
  })
  assert.match(line, /Desk problem: probe — the check failed internally at startup/)
  assert.match(line, /broke: probe blew up/)
  assert.match(line, /file: filing in background/)
  assert.equal(launched.length, 1)
  assert.ok(launched[0].command.some((part) => part.endsWith("file-desk-problem.js")))
  assert.ok(launched[0].command.includes("--mechanism"))
  assert.ok(launched[0].command.includes("probe"))
  assert.ok(launched[0].command.includes("--host"))
  assert.ok(launched[0].command.includes("claude"))
})

test("a check that throws a non-Error value still produces a block, with a stringified reason", async () => {
  const line = await runBootChecks({
    ...quiet,
    env: isolatedEnv(),
    checks: [{ id: "probe", budgetMs: 50, run: async () => { throw "not an Error object" } }],
  })
  assert.match(line, /Desk problem: probe — the check failed internally at startup/)
  assert.match(line, /broke: not an Error object/)
})

test("a check that only overruns its own budget (boot_check_budget) is skipped with no Desk problem: block", async () => {
  const line = await runBootChecks({
    ...quiet,
    env: isolatedEnv(),
    checks: [{ id: "probe", budgetMs: 50, run: async () => { throw Object.assign(new Error("over budget"), { code: "boot_check_budget" }) } }],
  })
  assert.equal(line, "")
  assert.doesNotMatch(line, /Desk problem/)
})

test("a check that genuinely times out (never settles) is skipped with no Desk problem: block", async () => {
  const line = await runBootChecks({
    ...quiet,
    env: isolatedEnv(),
    checks: [{ id: "probe", budgetMs: 20, run: () => new Promise(() => {}) }],
  })
  assert.equal(line, "")
  assert.doesNotMatch(line, /Desk problem/)
})

test("several checks that each throw produce a block per check, in order, alongside any well-behaved check's own line", async () => {
  const line = await runBootChecks({
    ...quiet,
    env: isolatedEnv(),
    checks: [
      { id: "first-probe", budgetMs: 50, run: async () => { throw new Error("first failure") } },
      { id: "quiet-check", budgetMs: 50, run: async () => ({ line: "fine" }) },
      { id: "second-probe", budgetMs: 50, run: async () => { throw new Error("second failure") } },
    ],
  })
  assert.match(line, /Desk problem: first-probe — the check failed internally at startup/)
  assert.match(line, /broke: first failure/)
  assert.match(line, /Desk problem: second-probe — the check failed internally at startup/)
  assert.match(line, /broke: second failure/)
  assert.match(line, /fine/)
  assert.ok(line.indexOf("first-probe") < line.indexOf("second-probe"))
})

test("a repair that cannot start is swallowed, exactly like every other check's own repair: the block still reports 'filing in background'", async () => {
  const line = await runBootChecks({
    ...quiet,
    env: isolatedEnv(),
    checks: [{ id: "probe", budgetMs: 50, run: async () => { throw new Error("boom") } }],
    launchRepair: async () => { throw new Error("spawn unavailable") },
  })
  assert.match(line, /Desk problem: probe — the check failed internally at startup/)
  assert.match(line, /file: filing in background/)
})

test("a check's filer argv carries the fixed 'reason unavailable' placeholder, never the raw reason, when argvSafeReason itself fails to load", async () => {
  // Fix round, spec.md §1 Part 5: a redaction helper that cannot load must
  // never fall back to passing its unredacted input straight through -- a
  // spawned process's argv (`ps`-visible machine-wide) is a materially wider
  // audience than the block this function still shows the operator. The
  // check below throws a path-shaped, sensitive-looking reason; the block
  // (the operator-facing `broke:` field) still shows it in full, but the
  // launched repair command's own `--reason` argument must not.
  const launched = []
  const line = await runBootChecks({
    ...quiet,
    env: isolatedEnv(),
    checks: [{ id: "probe", budgetMs: 50, run: async () => { throw new Error("/Users/someone/.ssh/id_rsa is unreadable") } }],
    launchRepair: async (command, env) => { launched.push({ command, env }) },
    loadArgvSafeReason: async () => { throw new Error("argv-safe-reason module missing") },
  })
  assert.match(line, /broke: \/Users\/someone\/\.ssh\/id_rsa is unreadable/)
  assert.equal(launched.length, 1)
  const reasonIndex = launched[0].command.indexOf("--reason")
  assert.ok(reasonIndex >= 0)
  assert.equal(launched[0].command[reasonIndex + 1], "reason unavailable (redactor not loaded)")
})

test("the failing check's own skip is still recorded in the protected status.json, exactly as before", async () => {
  const recorded = []
  await runBootChecks({
    ...quiet,
    env: isolatedEnv(),
    checks: [{ id: "probe", budgetMs: 50, run: async () => { throw new Error("boom") } }],
    record: async (env, skipped) => { recorded.push(skipped) },
  })
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0][0].id, "probe")
  assert.equal(recorded[0][0].reason, "error")
})

test("the error-skip tests never write the filing throttle under the process HOME", async () => {
  const before = process.env.HOME
  const env = isolatedEnv()
  await runBootChecks({ ...quiet, env, checks: [{ id: "probe-isolated", budgetMs: 50, run: async () => { throw new Error("boom") } }], launchRepair: async () => {} })
  const { existsSync } = await import("node:fs")
  assert.ok(existsSync(path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk")), "the throttle stamp lands under the test's own state dir")
  assert.equal(process.env.HOME, before)
})
