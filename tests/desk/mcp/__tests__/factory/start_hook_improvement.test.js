// The boot checks that tell a session what the improvement loop is doing: the labels, andon and improvement checks.
// Desks, cards and state folders are throwaway fixtures; nothing starts a process or reaches the network.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { factoryStateRoot, requestEvaluation, quarantine, setConsent, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { openImprovement, cardKey } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { indexJob } from "./_index_helper.js"
import { STORE, scratch } from "./_session_helpers.js"

import { andonCheck, checks, improvementCheck, labelsCheck, runBootChecks } from "../../../../../plugins/desk/hooks/lib/boot-checks.cjs"
const quiet = { launchRepair: async () => { throw new Error("no repair may start") }, launch: async () => {}, record: async () => {} }
const JOB = "9f2c4b1a7d3e5f60718293a4b5c6d7e8"
const HELD = "5e6f708192a3b4c5d6e7f8091a2b3c4d"
const DAY = 24 * 60 * 60 * 1000

const interactive = (env) => {
  const clean = { ...env }
  for (const name of ["CI", "GITHUB_ACTIONS", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "DESK_FACTORY_HEADLESS"]) delete clean[name]
  return clean
}
const run = (env, check, options = {}) => runBootChecks({ ...quiet, host: "claude", env, checks: [check], checkBudgets: { [check.id]: 5000 }, totalBudgetMs: 5000, ...options })
async function card(desk, key, daysAgo, personPrefix = "") {
  const source = key.slice(0, key.indexOf(":"))
  const result = await openImprovement({ deskRoot: desk, personPrefix, key, source, evidence: [], plugin: "desk", signal: null, now: Date.now() - daysAgo * DAY })
  assert.equal(result.result, "opened")
}

test("the improvement check is the last check and names the open cards, once, with the planned wording", () => scratch(async ({ env: raw, desk }) => {
  const env = interactive(raw)
  assert.equal(checks.at(-1).id, "improvement")
  assert.equal(await run(env, improvementCheck), "", "no card, no line")
  await card(desk, cardKey("andon", `${STORE}#7`), 3.5)
  await card(desk, cardKey("loop_alarm", "headless_blocked"), 1)
  assert.equal(await run(env, improvementCheck), "Desk boot pre-checks: Improvement cards: 2 open (oldest 3 days). Standing, pre-authorized work: when your foreground work allows, hand the oldest to a background subagent through improvement_next")
}))

test("the improvement check reads a crew desk's own person folder and says an unreadable folder out loud", () => scratch(async ({ env: raw, desk }) => {
  const env = { ...interactive(raw), DESK_PERSON: "sam" }
  await fs.mkdir(path.join(desk, "desks", "sam", "_meta"), { recursive: true })
  await card(desk, cardKey("andon", `${STORE}#7`), 2, "desks/sam")
  assert.match(await run(env, improvementCheck), /Improvement cards: 1 open \(oldest 2 days\)/u)
  assert.equal(await run({ ...env, DESK_PERSON: "../bad" }, improvementCheck), "", "an invalid person alias reads the desk's own folder, which has no cards")
  // A file where the folder belongs makes the whole folder unreadable.
  await fs.rm(path.join(desk, "desks", "sam", "_meta", "improvement"), { recursive: true })
  await fs.writeFile(path.join(desk, "desks", "sam", "_meta", "improvement"), "x")
  assert.equal(await run(env, improvementCheck), "Desk boot pre-checks: Improvement cards: unreadable (check the improvement folder under _meta on the desk)")
}))

test("no check speaks in a noninteractive session or a headless factory session", () => scratch(async ({ env: raw, desk }) => {
  const env = interactive(raw)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await requestEvaluation(env, { job: JOB, deskRoot: desk })
  await writeStatus(env, { andon: { [STORE]: { checked_at: "2026-10-05T00:00:00.000Z", issues: [{ number: 7, title: "x" }] } } })
  await card(desk, cardKey("andon", `${STORE}#7`), 3)
  for (const check of [labelsCheck, andonCheck, improvementCheck]) assert.notEqual(await run(env, check), "", `${check.id} speaks in an interactive session`)
  for (const quiet of [{ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { CLAUDE_CODE_SESSION_ATTENDED: "0" }, { CI: "true" }, { GITHUB_ACTIONS: "1" }, { DESK_FACTORY_HEADLESS: "1" }]) {
    for (const check of [labelsCheck, andonCheck, improvementCheck]) assert.equal(await run({ ...env, ...quiet }, check), "", `${check.id} under ${Object.keys(quiet)[0]}`)
  }
}))

test("the labels check says a card is open for a blocked evaluator only when the card is open, and starts no repair", () => scratch(async ({ env: raw, desk }) => {
  const env = interactive(raw)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await requestEvaluation(env, { job: JOB, deskRoot: desk })
  await writeStatus(env, { evaluator: { expired_total: 1, gave_up: 0, waiting: 1, headless: { state: "no_credentials", day: "2026-10-05", blocked_days: 3 } } })
  const wait = "Factory evaluator: cannot run (no_credentials); 1 finished job waits (oldest 0 days); "
  assert.equal(await run(env, labelsCheck), `Desk boot pre-checks: ${wait}the state is shown on the health record; 1 evaluation request expired and is counted`)
  await card(desk, cardKey("loop_alarm", "headless_blocked"), 0)
  assert.equal(await run(env, labelsCheck), `Desk boot pre-checks: ${wait}a card is open for it; 1 evaluation request expired and is counted`)
  // The two-line card alarm for another loop condition does not stand in for this one.
  await writeStatus(env, { evaluator: { headless: { state: "disabled_would_bill" } } })
  assert.equal(await run(env, labelsCheck), "Desk boot pre-checks: Factory evaluator: does not run because this sign-in would be billed per token, and nothing is spent; 1 finished job waits (oldest 0 days)")
}))

test("the quarantined-labels and andon lines read the cards, and an unreadable folder is said, not hidden", () => scratch(async ({ env: raw, desk }) => {
  const env = interactive(raw)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await indexJob(env, HELD, "claude-code-00000001-0000-4000-8000-000000000001.json")
  await quarantine(env, STORE, `labels/${HELD}/00000001-0000-4000-8000-000000000001.json`, "facts_quarantined", { facts: "claude-code-00000001-0000-4000-8000-000000000001.json" })
  await writeStatus(env, { andon: { [STORE]: { checked_at: "2026-10-05T00:00:00.000Z", issues: [{ number: 7, title: "x" }, { number: 8, title: "y" }] } } })
  await card(desk, cardKey("loop_alarm", "labels_quarantined"), 1)
  await card(desk, cardKey("andon", `${STORE}#7`), 1)
  assert.equal(await run(env, labelsCheck), "Desk boot pre-checks: Factory: 1 finished job has quarantined waste labels; a card is open for it")
  assert.equal(await run(env, andonCheck), "Desk boot pre-checks: Factory: 2 open andon issues in ourostack/factory (#7, #8); 1 of them has an improvement card, and the rest get one at the next background step")
  await fs.rm(path.join(desk, "_meta", "improvement"), { recursive: true })
  await fs.writeFile(path.join(desk, "_meta", "improvement"), "x")
  assert.equal(await run(env, labelsCheck), "Desk boot pre-checks: Factory: 1 finished job has quarantined waste labels; the improvement cards could not be fully read")
  assert.match(await run(env, andonCheck), /the improvement cards could not be fully read$/u)
  // No bound desk: the cards cannot be read, and the line does not claim a card.
  const unbound = await labelsCheck.run({ env, host: "claude", shared: { root: Promise.resolve(null) }, deadline: Infinity, budgetMs: 100 })
  assert.equal(unbound.line, "Factory: 1 finished job has quarantined waste labels; the improvement cards could not be fully read")
  assert.equal((await improvementCheck.run({ env, host: "claude", shared: { root: Promise.resolve(null) }, deadline: Infinity, budgetMs: 100 })).line, undefined)
}))

test("the cards are read once for the checks of one start, and each check keeps to its own deadline", () => scratch(async ({ env: raw, desk }) => {
  const env = interactive(raw)
  await card(desk, cardKey("andon", `${STORE}#7`), 1)
  const shared = {}
  const ctx = (deadline) => ({ env, host: "claude", shared, deadline, budgetMs: 100 })
  const first = await improvementCheck.run(ctx(performance.now() + 5000))
  assert.match(first.line, /^Improvement cards: 1 open/u)
  const cached = shared.improvement
  assert.ok(cached instanceof Promise, "the read is kept for the next check")
  await improvementCheck.run(ctx(performance.now() + 5000))
  assert.equal(shared.improvement, cached)
  await assert.rejects(() => improvementCheck.run(ctx(performance.now() - 1)), (error) => error.code === "boot_check_budget")
}))

test("the improvement check finds a crew desk's person from the roster and the identity, and says when it cannot", () => scratch(async ({ env: raw, desk }) => {
  const env = { ...interactive(raw), HOME: raw.HOME }
  await fs.mkdir(path.join(desk, "desks", "bob", "_meta"), { recursive: true })
  await fs.writeFile(path.join(desk, "_meta", "desks.md"), "| alias | identity | path |\n|---|---|---|\n| alex | agarcia | desks/alex |\n| bob | bsmith | desks/bob |\n")
  await card(desk, cardKey("andon", `${STORE}#7`), 2, "desks/bob")
  assert.match(await run({ ...env, DESK_IDENTITY: "bsmith" }, improvementCheck), /Improvement cards: 1 open \(oldest 2 days\)/u)
  assert.match(await run(env, improvementCheck), /^Desk boot pre-checks: Improvement cards: not checked, because this crew desk has several people/u)
  assert.match(await run({ ...env, DESK_IDENTITY: "nobody" }, improvementCheck), /matches no member of this crew desk's roster/u)
  assert.equal(await run({ ...env, DESK_PERSON: "a/b" }, improvementCheck), "", "a bad alias reads the desk's own folder, which has no cards")
}))

test("a cut-off card read leaves the card lines unsure, never saying no card is open", () => scratch(async ({ env: raw, desk }) => {
  const env = interactive(raw)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await requestEvaluation(env, { job: JOB, deskRoot: desk })
  await writeStatus(env, { evaluator: { headless: { state: "no_credentials" } }, andon: { [STORE]: { checked_at: "2026-10-05T00:00:00.000Z", issues: [{ number: 7, title: "x" }] } } })
  const cards = { status: "ok", open: 1, oldest_days: 1, open_keys: [], truncated: true, set_aside: 0, unreadable_files: 0 }
  const shared = { root: Promise.resolve(desk), improvement: Promise.resolve(cards) }
  const ctx = { env, host: "claude", shared, deadline: Infinity, budgetMs: 100 }
  assert.match((await andonCheck.run(ctx)).line, /the improvement cards could not be fully read$/u)
  assert.doesNotMatch((await labelsCheck.run(ctx)).line, /a card is open for it/u)
}))
