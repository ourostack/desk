// The session-start status lines of the improvement loop: the evaluator line, the quarantined-labels line, the andon
// line and the improvement-card line, all from stored numbers. Every desk and state folder is a throwaway fixture.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { factoryStateRoot, requestEvaluation, setConsent, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { labelsBootCheck, labelsLine, labelsQuarantinedLine, andonLine, improvementBootCheck, improvementLine, cardOpenState } from "../../../../../plugins/desk/mcp/src/factory/boot-check.js"
import { openImprovement, updateCard, claimNext, cardKey } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { STORE, scratch } from "./_session_helpers.js"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-10-05T12:00:00.000Z")
const FORBIDDEN = /run the evaluator|tell the operator|offer a curator pass|start an evaluator/iu
const JOB_A = "9f2c4b1a7d3e5f60718293a4b5c6d7e8"
const JOB_B = "5e6f708192a3b4c5d6e7f8091a2b3c4d"

async function open(desk, key, daysAgo) {
  const source = key.slice(0, key.indexOf(":"))
  const result = await openImprovement({ deskRoot: desk, personPrefix: "", key, source, evidence: [], plugin: "desk", signal: null, now: NOW - daysAgo * DAY })
  assert.equal(result.result, "opened")
}

async function evaluatorStatus(env, evaluator) {
  await writeStatus(env, { evaluator })
}

const running = (over = {}) => ({ expired_total: 0, gave_up: 0, waiting: 0, headless: { state: "ran", blocked_days: 0 }, ...over })

test("labelsBootCheck adds the age of the oldest waiting request and the stored evaluator numbers, never a made-up zero", () => scratch(async ({ env, desk }) => {
  assert.deepEqual(labelsBootCheck({ env, now: NOW }), { count: 0, quarantined: 0, oldest_days: null, evaluator: null })
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  assert.deepEqual(labelsBootCheck({ env, now: NOW }), { count: 0, quarantined: 0, oldest_days: null, evaluator: null })
  await requestEvaluation(env, { job: JOB_A, deskRoot: desk })
  await requestEvaluation(env, { job: JOB_B, deskRoot: desk })
  const root = await factoryStateRoot(env)
  const file = (job) => path.join(root, "evaluate-requests", `${job}.json`)
  const write = async (job, daysAgo) => fs.writeFile(file(job), JSON.stringify({ schema_version: 1, job, desk_root: desk, requested_at: new Date(NOW - daysAgo * DAY).toISOString() }))
  await write(JOB_A, 3.5)
  await write(JOB_B, 9.2)
  // No status yet: the evaluator is not recorded, which is not the same as zero.
  assert.deepEqual(labelsBootCheck({ env, now: NOW }), { count: 2, quarantined: 0, oldest_days: 9, evaluator: null })
  await evaluatorStatus(env, running({ expired_total: 4, gave_up: 1, headless: { state: "ran" } }))
  assert.deepEqual(labelsBootCheck({ env, now: NOW }).evaluator, { state: "ran", expired_total: 4, gave_up: 1, lag_minutes: null, unsupported_jobs: [], gave_up_jobs: [] })
  // An absent number stays absent; an unknown state is not a state.
  await evaluatorStatus(env, { headless: { state: "tomorrow" }, gave_up: -1, expired_total: "many" })
  assert.deepEqual(labelsBootCheck({ env, now: NOW }).evaluator, { state: "unrecognized", expired_total: null, gave_up: null, lag_minutes: null, unsupported_jobs: [], gave_up_jobs: [] })
  await evaluatorStatus(env, { gave_up: 1 })
  assert.deepEqual(labelsBootCheck({ env, now: NOW }).evaluator, { state: null, expired_total: null, gave_up: 1, lag_minutes: null, unsupported_jobs: [], gave_up_jobs: [] })
  await evaluatorStatus(env, { headless: {}, gave_up: 1 })
  assert.deepEqual(labelsBootCheck({ env, now: NOW }).evaluator, { state: null, expired_total: null, gave_up: 1, lag_minutes: null, unsupported_jobs: [], gave_up_jobs: [] })
  // A request file that does not parse does not give an age, and the rest still do.
  await fs.writeFile(file(JOB_B), "not json")
  assert.equal(labelsBootCheck({ env, now: NOW }).oldest_days, 3)
  await fs.writeFile(file(JOB_A), "not json")
  assert.equal(labelsBootCheck({ env, now: NOW }).oldest_days, null)
}))

test("the evaluator line says the plugin does the work, and gives the last result and the age", () => {
  const base = { count: 3, oldest_days: 5, evaluator: { state: "ran", expired_total: null, gave_up: null } }
  assert.equal(labelsLine(base), "Factory evaluator: 3 finished jobs wait for labels (oldest 5 days); the plugin labels them in the background, last result ran")
  assert.equal(labelsLine({ ...base, count: 1, oldest_days: 1 }), "Factory evaluator: 1 finished job waits for labels (oldest 1 day); the plugin labels them in the background, last result ran")
  assert.equal(labelsLine({ ...base, oldest_days: null, evaluator: null }), "Factory evaluator: 3 finished jobs wait for labels; the plugin labels them in the background, no result recorded yet")
  assert.equal(labelsLine({ ...base, evaluator: { state: null, expired_total: 0, gave_up: 0 } }), "Factory evaluator: 3 finished jobs wait for labels (oldest 5 days); the plugin labels them in the background, no result recorded yet")
  assert.equal(
    labelsLine({ ...base, evaluator: { state: "idle", expired_total: 2, gave_up: 2 } }),
    "Factory evaluator: 3 finished jobs wait for labels (oldest 5 days); the plugin labels them in the background, last result idle; 2 have been tried three times without an accepted result; 2 evaluation requests expired and are counted",
  )
  assert.match(labelsLine({ ...base, evaluator: { state: "ran", expired_total: 1, gave_up: 1 } }), /; 1 has been tried three times without an accepted result; 1 evaluation request expired and is counted$/u)
  assert.equal(labelsLine({ ...base, evaluator: { state: "unrecognized", expired_total: null, gave_up: null } }), "Factory evaluator: 3 finished jobs wait for labels (oldest 5 days); the plugin labels them in the background, last result not recognised by this version")
  assert.equal(labelsLine({ ...base, evaluator: { state: "disabled", expired_total: null, gave_up: null } }), "Factory evaluator: switched off on this machine; 3 finished jobs wait for labels (oldest 5 days)")
})

test("a blocked evaluator line names the state, never starts anything, and claims a card only when one is open", () => {
  for (const state of ["no_agent_cli", "no_credentials", "unsupported_host", "sign_in_unknown"]) {
    const summary = { count: 2, oldest_days: 4, evaluator: { state, expired_total: null, gave_up: null } }
    assert.equal(labelsLine(summary, { cardOpen: true }), `Factory evaluator: cannot run (${state}); 2 finished jobs wait (oldest 4 days); a card is open for it`)
    assert.equal(labelsLine(summary, { cardOpen: false }), `Factory evaluator: cannot run (${state}); 2 finished jobs wait (oldest 4 days); the state is shown on the health record`)
    assert.equal(labelsLine(summary), `Factory evaluator: cannot run (${state}); 2 finished jobs wait (oldest 4 days); the state is shown on the health record`)
    assert.equal(labelsLine(summary, { cardOpen: null }), labelsLine(summary, { cardOpen: false }))
  }
  const billed = labelsLine({ count: 2, oldest_days: 4, evaluator: { state: "disabled_would_bill", expired_total: 3, gave_up: 1 } }, { cardOpen: true })
  assert.equal(billed, "Factory evaluator: does not run because this sign-in would be billed per token, and nothing is spent; 2 finished jobs wait (oldest 4 days); 1 has been tried three times without an accepted result; 3 evaluation requests expired and are counted")
  assert.doesNotMatch(billed, /card/u)
  const gaveUp = labelsLine({ count: 2, oldest_days: null, evaluator: { state: "no_credentials", expired_total: 0, gave_up: 2 } }, { cardOpen: false })
  assert.equal(gaveUp, "Factory evaluator: cannot run (no_credentials); 2 finished jobs wait; 2 have been tried three times without an accepted result; the state is shown on the health record")
})

test("no evaluator, quarantined or andon line holds an instruction the plugin owns, or an offer", () => {
  const lines = [
    labelsLine({ count: 2, oldest_days: 4, evaluator: { state: "ran", expired_total: 1, gave_up: 1 } }),
    labelsLine({ count: 2, oldest_days: 4, evaluator: { state: "no_agent_cli", expired_total: 1, gave_up: 1 } }, { cardOpen: true }),
    labelsLine({ count: 2, oldest_days: 4, evaluator: { state: "disabled_would_bill", expired_total: 1, gave_up: 1 } }),
    labelsQuarantinedLine(2, { cardOpen: true }),
    labelsQuarantinedLine(2, { cardOpen: false }),
    andonLine(STORE, [{ number: 1 }], { openKeys: [] }),
  ]
  for (const line of lines) assert.doesNotMatch(line, FORBIDDEN, line)
})

test("the quarantined-labels line says a card is open only when one is", () => {
  assert.equal(labelsQuarantinedLine(2, { cardOpen: true }), "Factory: 2 finished jobs have quarantined waste labels; a card is open for it")
  assert.equal(labelsQuarantinedLine(1, { cardOpen: true }), "Factory: 1 finished job has quarantined waste labels; a card is open for it")
  assert.equal(labelsQuarantinedLine(2, { cardOpen: false }), "Factory: 2 finished jobs have quarantined waste labels; no card is open for it yet")
  assert.equal(labelsQuarantinedLine(2), "Factory: 2 finished jobs have quarantined waste labels; no card is open for it yet")
  assert.equal(labelsQuarantinedLine(2, { cardOpen: null }), "Factory: 2 finished jobs have quarantined waste labels; the improvement cards could not be fully read")
})

test("the andon line says each issue has a card only when every issue has one", () => {
  const issues = [{ number: 12 }, { number: 15 }]
  const keys = [cardKey("andon", `${STORE}#12`), cardKey("andon", `${STORE}#15`)]
  assert.equal(andonLine(STORE, issues, { openKeys: keys }), "Factory: 2 open andon issues in ourostack/factory (#12, #15); each has an improvement card")
  assert.equal(andonLine(STORE, [{ number: 12 }], { openKeys: [keys[0]] }), "Factory: 1 open andon issue in ourostack/factory (#12); it has an improvement card")
  assert.equal(andonLine(STORE, issues, { openKeys: [keys[0], "andon:other/store#15"] }), "Factory: 2 open andon issues in ourostack/factory (#12, #15); 1 of them has an improvement card, and the rest get one at the next background step")
  assert.equal(andonLine(STORE, [...issues, { number: 20 }], { openKeys: keys }), "Factory: 3 open andon issues in ourostack/factory (#12, #15, #20); 2 of them have an improvement card, and the rest get one at the next background step")
  assert.equal(andonLine(STORE, issues, { openKeys: [] }), "Factory: 2 open andon issues in ourostack/factory (#12, #15); none has an improvement card yet, and each gets one at the next background step")
  assert.equal(andonLine(STORE, [{ number: 12 }], { openKeys: [] }), "Factory: 1 open andon issue in ourostack/factory (#12); it has no improvement card yet, and gets one at the next background step")
  assert.equal(andonLine(STORE, issues, { openKeys: null }), "Factory: 2 open andon issues in ourostack/factory (#12, #15); the improvement cards could not be fully read")
  assert.equal(andonLine(STORE, issues), "Factory: 2 open andon issues in ourostack/factory (#12, #15); the improvement cards could not be fully read")
})

test("a card that was not found in a cut-off read is unknown, never absent", () => {
  const keys = [cardKey("andon", `${STORE}#12`)]
  const issues = [{ number: 12 }, { number: 15 }]
  assert.equal(andonLine(STORE, issues, { openKeys: keys, complete: false }), "Factory: 2 open andon issues in ourostack/factory (#12, #15); the improvement cards could not be fully read")
  assert.equal(andonLine(STORE, [{ number: 12 }], { openKeys: keys, complete: false }), "Factory: 1 open andon issue in ourostack/factory (#12); it has an improvement card")
  assert.equal(andonLine(STORE, issues, { openKeys: keys, complete: true }), "Factory: 2 open andon issues in ourostack/factory (#12, #15); 1 of them has an improvement card, and the rest get one at the next background step")
  const ok = { status: "ok", open: 1, oldest_days: 1, open_keys: ["loop_alarm:headless_blocked"], truncated: false, set_aside: 0, unreadable_files: 0 }
  assert.equal(cardOpenState(ok, "loop_alarm:headless_blocked"), true)
  assert.equal(cardOpenState(ok, "loop_alarm:labels_quarantined"), false)
  assert.equal(cardOpenState({ ...ok, truncated: true }, "loop_alarm:headless_blocked"), true)
  assert.equal(cardOpenState({ ...ok, truncated: true }, "loop_alarm:labels_quarantined"), null)
  assert.equal(cardOpenState({ status: "unreadable" }, "x:y"), null)
  assert.equal(cardOpenState({ status: "unchecked", reason: "login_not_cached" }, "x:y"), null)
  assert.equal(cardOpenState(null, "x:y"), null)
})

test("improvementBootCheck counts the cards a session may take, with the age of the oldest, and lists the keys that still have an open card", () => scratch(async ({ env, desk }) => {
  const empty = await improvementBootCheck({ deskRoot: desk, personPrefix: "", env, now: NOW })
  assert.deepEqual(empty, { status: "ok", open: 0, oldest_days: null, open_keys: [], truncated: false, set_aside: 0, unreadable_files: 0 })
  const old = cardKey("andon", `${STORE}#1`)
  const young = cardKey("andon", `${STORE}#2`)
  const held = cardKey("andon", `${STORE}#3`)
  const closed = cardKey("andon", `${STORE}#4`)
  await open(desk, old, 6.5)
  await open(desk, young, 1)
  await open(desk, held, 2)
  await open(desk, closed, 3)
  const claimed = await claimNext({ env, deskRoot: desk, personPrefix: "", now: NOW - 1000 })
  assert.equal(claimed.result, "claimed")
  assert.equal(claimed.card.key, old, "the oldest card was claimed first")
  // A live claim is not offered, so it is not counted open; the card still exists, so its key is listed.
  const summary = await improvementBootCheck({ deskRoot: desk, personPrefix: "", env, now: NOW })
  assert.equal(summary.open, 3)
  assert.equal(summary.oldest_days, 3)
  assert.deepEqual(summary.open_keys.sort(), [old, young, held, closed].sort())
  // Once the claim has run out, the card counts again, with its age.
  const later = NOW + 5 * 60 * 60 * 1000
  const expired = await improvementBootCheck({ deskRoot: desk, personPrefix: "", env, now: later })
  assert.equal(expired.open, 4)
  assert.equal(expired.oldest_days, 6)
  // A closed card is no longer an open card, and does not count.
  const shut = await updateCard({ deskRoot: desk, personPrefix: "", key: closed, patch: { state: "closed_unverified", close_reason: "wont_fix" }, now: later })
  assert.equal(shut.result, "updated")
  const after = await improvementBootCheck({ deskRoot: desk, personPrefix: "", env, now: later })
  assert.equal(after.open_keys.includes(closed), false)
  assert.equal(after.open, 3)
}))

test("improvementBootCheck reports an unreadable folder, set-aside files and a cut-off read, and never throws for a bad read", async () => {
  const cards = (n) => Array.from({ length: n }, (_, i) => ({ key: `andon:${STORE}#${i + 1}`, state: "open", claim: null, last_opened_at: new Date(NOW - i * DAY).toISOString() }))
  const read = (value) => async (args) => { read.args = args; return { cards: [], truncated: false, unreadable: false, skipped: {}, set_aside_total: 0, unreadable_files: 0, ...value } }
  const call = (reader) => improvementBootCheck({ deskRoot: "/desk", personPrefix: "desks/sam", env: {}, now: NOW, readCards: reader })
  assert.deepEqual(await call(read({ unreadable: true })), { status: "unreadable", open: 0, oldest_days: null, open_keys: [], truncated: false, set_aside: 0, unreadable_files: 0 })
  assert.equal((await call(async () => { throw new Error("boom") })).status, "unreadable")
  const odd = await call(read({ cards: cards(2), set_aside_total: 3, unreadable_files: 1, truncated: true }))
  assert.deepEqual({ ...odd, open_keys: undefined }, { status: "ok", open: 2, oldest_days: 1, open_keys: undefined, truncated: true, set_aside: 3, unreadable_files: 1 })
  assert.deepEqual(read.args, { deskRoot: "/desk", personPrefix: "desks/sam" })
  // Garbage in a card's fields gives no age, not a made-up one.
  const bad = await call(read({ cards: [{ key: "andon:x", state: "open", claim: null, last_opened_at: "yesterday" }] }))
  assert.equal(bad.open, 1)
  assert.equal(bad.oldest_days, null)
})

test("the card read is inside the check's budget for 200 cards, and past the deadline it stops with boot_check_budget", async () => {
  const cards = Array.from({ length: 200 }, (_, i) => ({ key: `andon:${STORE}#${i + 1}`, state: "open", claim: null, last_opened_at: new Date(NOW - (i % 30) * DAY).toISOString() }))
  const reader = async () => ({ cards, truncated: false, unreadable: false, skipped: {}, set_aside_total: 0, unreadable_files: 0 })
  const fast = await improvementBootCheck({ deskRoot: "/desk", personPrefix: "", env: {}, now: NOW, readCards: reader, deadline: 40, clock: () => 10 })
  assert.equal(fast.open, 200)
  assert.equal(fast.oldest_days, 29)
  let ticks = 0
  const slow = () => improvementBootCheck({ deskRoot: "/desk", personPrefix: "", env: {}, now: NOW, readCards: reader, deadline: 40, clock: () => (ticks += 25) })
  await assert.rejects(slow, (error) => error.code === "boot_check_budget")
  await assert.rejects(() => improvementBootCheck({ deskRoot: "/desk", personPrefix: "", env: {}, now: NOW, readCards: async () => { throw new Error("never read") }, deadline: 40, clock: () => 50 }), (error) => error.code === "boot_check_budget")
})

test("the improvement line has the planned wording, says nothing when no card is open, and never hides an unreadable folder", () => {
  const ok = { status: "ok", open: 3, oldest_days: 6, open_keys: [], truncated: false, set_aside: 0, unreadable_files: 0 }
  assert.equal(improvementLine(ok), "Improvement cards: 3 open (oldest 6 days). Standing, pre-authorized work: when your foreground work allows, hand the oldest to a background subagent through improvement_next")
  assert.equal(improvementLine({ ...ok, open: 1, oldest_days: 1 }), "Improvement cards: 1 open (oldest 1 day). Standing, pre-authorized work: when your foreground work allows, hand the oldest to a background subagent through improvement_next")
  assert.equal(improvementLine({ ...ok, oldest_days: null }), "Improvement cards: 3 open. Standing, pre-authorized work: when your foreground work allows, hand the oldest to a background subagent through improvement_next")
  assert.equal(improvementLine({ ...ok, truncated: true }), "Improvement cards: at least 3 open (oldest 6 days among those read). Standing, pre-authorized work: when your foreground work allows, hand the oldest to a background subagent through improvement_next")
  assert.equal(improvementLine({ ...ok, open: 0, oldest_days: null }), "")
  assert.equal(improvementLine({ ...ok, open: 0, oldest_days: null, open_keys: ["andon:x#1"] }), "")
  assert.equal(improvementLine({ status: "unreadable", open: 0, oldest_days: null, open_keys: [], truncated: false, set_aside: 0, unreadable_files: 0 }), "Improvement cards: unreadable (check the improvement folder under _meta on the desk)")
  assert.equal(improvementLine(null), "")
  assert.equal(improvementLine({ status: "unchecked", reason: "login_not_cached" }), "Improvement cards: not checked, because this crew desk has several people and this session's person is not known without a network call (set DESK_PERSON to read your cards)")
  assert.equal(improvementLine({ status: "unchecked", reason: "no_matching_member" }), "Improvement cards: not checked, because this session's identity matches no member of this crew desk's roster (set DESK_PERSON to read your cards)")
  assert.equal(improvementLine({ status: "unchecked", reason: "something_new" }), "Improvement cards: not checked, because this session's person is not known")
  assert.equal(improvementLine({ status: "unchecked", reason: "invalid_member" }), "Improvement cards: not checked, because the crew roster names an alias that is not a valid folder name")
  assert.doesNotMatch(improvementLine(ok), FORBIDDEN)
})

test("set-aside and unreadable card files are counted in the line, with the one repair only a session can make", () => {
  const base = { status: "ok", open: 0, oldest_days: null, open_keys: [], truncated: false, set_aside: 2, unreadable_files: 0 }
  assert.equal(improvementLine(base), "Improvement cards: 2 files were set aside as invalid in the improvement folder under _meta (restore or delete them and commit)")
  assert.equal(improvementLine({ ...base, set_aside: 1 }), "Improvement cards: 1 file was set aside as invalid in the improvement folder under _meta (restore or delete it and commit)")
  assert.equal(improvementLine({ ...base, set_aside: 0, unreadable_files: 2 }), "Improvement cards: 2 card files could not be read and were left in place (fix their permissions or delete them and commit)")
  assert.equal(improvementLine({ ...base, set_aside: 0, unreadable_files: 1 }), "Improvement cards: 1 card file could not be read and was left in place (fix its permissions or delete it and commit)")
  const both = improvementLine({ ...base, open: 4, oldest_days: 2, unreadable_files: 1 })
  assert.equal(both, "Improvement cards: 4 open (oldest 2 days). Standing, pre-authorized work: when your foreground work allows, hand the oldest to a background subagent through improvement_next; 2 files were set aside as invalid in the improvement folder under _meta (restore or delete them and commit); 1 card file could not be read and was left in place (fix its permissions or delete it and commit)")
})

test("the evaluator line says how long ago the oldest unlabeled job finished, and when that is past the 1-hour target", () => {
  const base = { count: 2, oldest_days: 0, evaluator: { state: "ran", expired_total: null, gave_up: null } }
  const line = (lag) => labelsLine({ ...base, evaluator: { ...base.evaluator, lag_minutes: lag } })
  assert.equal(line(45), "Factory evaluator: 2 finished jobs wait for labels (oldest 0 days), and the oldest unlabeled one finished 45 minutes ago; the plugin labels them in the background, last result ran")
  assert.match(line(1), /finished 1 minute ago;/u)
  assert.match(line(61), /finished 61 minutes ago, past the 1-hour target;/u)
  assert.match(line(150), /finished 2 hours ago, past the 1-hour target;/u)
  assert.match(line(3 * 1440 + 5), /finished 3 days ago, past the 1-hour target;/u)
  for (const lag of [0, null, undefined]) assert.doesNotMatch(line(lag), /finished .* ago/u)
  assert.match(labelsLine({ count: 1, oldest_days: null, evaluator: { state: "disabled", lag_minutes: 90 } }), /^Factory evaluator: switched off on this machine; 1 finished job waits for labels, and the oldest unlabeled one finished 90 minutes ago, past the 1-hour target$/u)
})

test("labelsBootCheck reads the lag from the evaluator step's record, and only while that record is fresh", () => scratch(async ({ env, desk }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await requestEvaluation(env, { job: JOB_A, deskRoot: desk })
  const at = new Date(NOW - 10 * 60 * 1000).toISOString()
  const lagged = async (lag) => {
    await evaluatorStatus(env, running({ lag }))
    return labelsBootCheck({ env, now: NOW }).evaluator.lag_minutes
  }
  assert.equal(await lagged({ at, unlabeled_jobs: 1, oldest_finished_at: new Date(NOW - 125 * 60 * 1000).toISOString() }), 125)
  assert.equal(await lagged({ at, unlabeled_jobs: 1, oldest_finished_at: new Date(NOW + 60 * 1000).toISOString() }), 0)
  assert.equal(await lagged({ at, unlabeled_jobs: 0, oldest_finished_at: null }), 0)
  for (const lag of [
    "x",
    { at: "garbage", unlabeled_jobs: 0, oldest_finished_at: null },
    { at: new Date(NOW - 73 * 3600 * 1000).toISOString(), unlabeled_jobs: 0, oldest_finished_at: null },
    { at: new Date(NOW + 10 * 60 * 1000).toISOString(), unlabeled_jobs: 0, oldest_finished_at: null },
    { at, unlabeled_jobs: 1, oldest_finished_at: "garbage" },
    { at, unlabeled_jobs: 1.5, oldest_finished_at: at },
    { at, unlabeled_jobs: 0, oldest_finished_at: at },
  ]) assert.equal(await lagged(lag), null, JSON.stringify(lag))
}))

test("the evaluator line names the jobs the lag leaves out: a host the plugin cannot label here, and the attempt limit", () => scratch(async ({ env, desk }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await requestEvaluation(env, { job: JOB_A, deskRoot: desk })
  const at = new Date(NOW - 10 * 60 * 1000).toISOString()
  const unsupported = "0123456789abcdef0123456789abcdef"
  const gaveUp = "fedcba9876543210fedcba9876543210"
  await evaluatorStatus(env, running({ gave_up: 1, lag: { at, unlabeled_jobs: 0, oldest_finished_at: null, unsupported_jobs: [unsupported, "not a job"], gave_up_jobs: [gaveUp] } }))
  const summary = labelsBootCheck({ env, now: NOW })
  assert.deepEqual([summary.evaluator.unsupported_jobs, summary.evaluator.gave_up_jobs], [["01234567"], ["fedcba98"]])
  const line = labelsLine(summary)
  assert.match(line, /; 1 has been tried three times without an accepted result \(fedcba98\); 1 has a session the plugin cannot label on this machine \(a Copilot or Codex host\) \(01234567\)/u)
  assert.doesNotMatch(line, /past the 1-hour target/u)
  assert.match(labelsLine({ count: 3, oldest_days: 0, evaluator: { state: "ran", gave_up: 2, unsupported_jobs: ["01234567", "89abcdef"], gave_up_jobs: [] } }), /2 have been tried three times without an accepted result; 2 have sessions the plugin cannot label/u)
  // A stale lag record names nothing.
  await evaluatorStatus(env, running({ lag: { at: new Date(NOW - 73 * 3600 * 1000).toISOString(), unlabeled_jobs: 0, oldest_finished_at: null, unsupported_jobs: [unsupported], gave_up_jobs: [] } }))
  assert.deepEqual(labelsBootCheck({ env, now: NOW }).evaluator.unsupported_jobs, [])
}))
