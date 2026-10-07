// The improvement-card pickup text in the one-call boot: what a card is, that it is standing work, when to take one,
// and the one authority paragraph the improvement tools export. Throwaway desks; every outside call is a fake.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce, improvementInstructions } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { AUTHORITY } from "../../../../../plugins/desk/mcp/src/tools/improvement.js"
import { openImprovement, cardKey } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"

const DAY = 24 * 60 * 60 * 1000
const ok = { code: 0, stdout: "gh version 2.54.0\njq-1.7\n", stderr: "" }
const runner = async (args) => (args.join(" ").startsWith("auth status") ? { code: 0, stdout: "", stderr: "" } : ok)
const summary = (over = {}) => ({ status: "ok", open: 3, oldest_days: 6, open_keys: [], truncated: false, set_aside: 0, unreadable_files: 0, ...over })

async function desk() {
  const root = await mkTempRoot("desk-boot-improvement-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  return root
}

function boot(root, extra = {}) {
  return bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh: runner, jq: runner,
    migrationsFn: async () => [], repoFn: () => ({ states: [], pending: [] }), prFn: async () => ({ prs: [], pending: [] }),
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    ...extra,
  })
}

test("improvementInstructions says what a card is, that it is standing work, when to take one and who to ask, with the exported authority paragraph", () => {
  const [text, ...rest] = improvementInstructions(summary())
  assert.equal(rest.length, 0)
  assert.match(text, /^Improvement cards: 3 open \(oldest 6 days\)\./u)
  assert.match(text, /one finding of the factory about our own tooling, with its evidence/u)
  assert.match(text, /standing, pre-authorized work/u)
  assert.match(text, /when your foreground work allows it, this is an interactive session and the machine is under its cap/u)
  assert.match(text, /through improvement_next, which refuses and says why when the session or the machine's cap does not allow it/u)
  assert.ok(text.endsWith(AUTHORITY), "the one authority paragraph, not a second wording")
  assert.equal(text.split(AUTHORITY).length, 2)
  assert.doesNotMatch(text, /tell the operator|offer a curator pass|run the evaluator/iu)
})

test("improvementInstructions carries the authority paragraph only when cards are open", () => {
  assert.deepEqual(improvementInstructions(null), [])
  assert.deepEqual(improvementInstructions(summary({ open: 0, oldest_days: null })), [])
  assert.deepEqual(improvementInstructions(undefined), [])
  assert.deepEqual(improvementInstructions(summary({ status: "unreadable", open: 0, oldest_days: null })), ["Improvement cards: unreadable (check the improvement folder under _meta on the desk)"])
  const noted = improvementInstructions(summary({ open: 0, oldest_days: null, set_aside: 2 }))
  assert.equal(noted.length, 1)
  assert.match(noted[0], /^Improvement cards: 2 files were set aside as invalid/u)
  assert.ok(!noted[0].includes(AUTHORITY))
  const both = improvementInstructions(summary({ set_aside: 1 }))
  assert.equal(both.length, 2)
  assert.ok(both[0].endsWith(AUTHORITY))
  assert.match(both[1], /^Improvement cards: 1 file was set aside as invalid/u)
  assert.match(improvementInstructions(summary({ truncated: true }))[0], /^Improvement cards: at least 3 open \(oldest 6 days among those read\)\./u)
})

test("bootOnce carries the pickup text for open cards in an interactive session, read from the desk's own cards", async () => {
  const root = await desk()
  const quiet = await boot(root)
  assert.ok(!quiet.instructions.some((line) => line.startsWith("Improvement cards")), "no open card, no instruction")
  for (const [key, days] of [[cardKey("andon", "ourostack/factory#1"), 4.5], [cardKey("loop_alarm", "headless_blocked"), 1]]) {
    const result = await openImprovement({ deskRoot: root, personPrefix: "", key, source: key.split(":")[0], evidence: [], plugin: "desk", signal: null, now: Date.now() - days * DAY })
    assert.equal(result.result, "opened")
  }
  const result = await boot(root)
  const line = result.instructions.find((entry) => entry.startsWith("Improvement cards"))
  assert.match(line, /^Improvement cards: 2 open \(oldest 4 days\)\./u)
  assert.ok(line.endsWith(AUTHORITY))
  // Each noninteractive or headless session hears nothing.
  for (const env of [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CI: "true" }, { DESK_FACTORY_HEADLESS: "1" }]) {
    const silent = await boot(root, { env: { DESK: root, ...env } })
    assert.ok(!silent.instructions.some((entry) => entry.startsWith("Improvement cards")), JSON.stringify(env))
  }
})

test("bootOnce reads a crew desk's person folder, says an unreadable folder, and treats a slow or failing read as pending, never a hang", async () => {
  const root = await desk()
  let seen
  const reader = (summaryValue) => async (args) => { seen = args; return summaryValue }
  await boot(root, { env: { DESK: root, DESK_PERSON: "sam" }, improvementFn: reader(summary()) })
  assert.equal(seen.deskRoot, root)
  assert.equal(seen.personPrefix, path.posix.join("desks", "sam"))
  assert.equal(seen.env.DESK_PERSON, "sam")
  assert.equal(typeof seen.now, "number")
  const unreadable = await boot(root, { improvementFn: reader(summary({ status: "unreadable", open: 0, oldest_days: null })) })
  assert.ok(unreadable.instructions.includes("Improvement cards: unreadable (check the improvement folder under _meta on the desk)"))
  const slow = await boot(root, { improvementFn: () => new Promise(() => {}), budgetMs: 40 })
  assert.ok(slow.pending.includes("improvement: boot_budget_exceeded"))
  assert.ok(!slow.instructions.some((entry) => entry.startsWith("Improvement cards")))
  const failing = await boot(root, { improvementFn: async () => { throw new Error("boom") } })
  assert.ok(failing.degraded.some((entry) => entry.startsWith("improvement: ")))
  // No desk, no card read.
  const emptyHome = await mkTempRoot("desk-boot-improvement-none-")
  let called = false
  await bootOnce({ env: {}, cwd: emptyHome, homeDir: emptyHome, gh: runner, jq: runner, improvementFn: async () => { called = true; return summary() } })
  assert.equal(called, false)
})

test("bootOnce never stops for a bad DESK_PERSON, and finds a crew desk's person the way the launcher does", async () => {
  const root = await desk()
  let seen = []
  const reader = async (args) => { seen.push(args); return summary() }
  for (const bad of ["a/b", "..", "x..y"]) {
    const result = await boot(root, { env: { DESK: root, DESK_PERSON: bad }, improvementFn: reader })
    assert.ok(result.instructions.some((line) => line.startsWith("Improvement cards: 3 open")), bad)
  }
  assert.ok(seen.every((args) => args.personPrefix === ""), "a bad alias reads the desk's own folder, as the hook does")
  // A crew desk: the roster and DESK_IDENTITY name the person.
  await fs.mkdir(path.join(root, "desks", "alex"), { recursive: true })
  await fs.writeFile(path.join(root, "_meta", "desks.md"), "| alias | identity | path |\n|---|---|---|\n| alex | agarcia | desks/alex |\n| bob | bsmith | desks/bob |\n")
  seen = []
  await boot(root, { env: { DESK: root, DESK_IDENTITY: "bsmith" }, improvementFn: reader })
  assert.equal(seen[0].personPrefix, path.posix.join("desks", "bob"))
  // Nobody known without a network call: the boot says the cards were not checked, and does not read the solo folder.
  seen = []
  const unknown = await boot(root, { env: { DESK: root, HOME: root, XDG_STATE_HOME: path.join(root, "state") }, improvementFn: reader })
  assert.deepEqual(seen, [])
  assert.ok(unknown.instructions.some((line) => line.startsWith("Improvement cards: not checked, because this crew desk has several people")))
  const stranger = await boot(root, { env: { DESK: root, DESK_IDENTITY: "nobody" }, improvementFn: reader })
  assert.ok(stranger.instructions.some((line) => line.includes("matches no member of this crew desk's roster")))
})
