// The loop's `verify` step. It looks once a day at every improvement card that is open, claimed, shipped or
// verifying and decides what the evidence allows: set the version a countermeasure shipped in, close a card whose
// fix is confirmed (or whose source recovered), reopen a card whose fix did not work, and escalate thin data after
// a fixed number of checks. A person never closes a card or types a version.
//
// What decides each card.
// - A card with a mirror issue (`kaizen_url`): the store's verdict labels on that issue. `confirmed` closes the card
//   (`closed_confirmed`) and the issue; `not-confirmed` reopens the card (the library counts the reopen, clears the
//   countermeasure and version, and keeps the card's place at the front of the queue) and resets the issue's
//   `countermeasure` and `version`; neither label is a thin check.
// - A card whose source has its own recovery signal reads the loop's conditions record (`conditionOf`), or for a
//   reconcile class the reconcile summary's own streaks. `andon` and `store_build` recover at 1 clear observation;
//   `loop_alarm`, `evaluator` and `flush_health` at 2; a reconcile class at `clear` of 2 or more (it is present again
//   at `consecutive` of 3 or more after its version); a Desk problem 7 days after its version, when the conditions
//   record says its issue is no longer open and the known-hit record says no machine hit it at a version at or after
//   the fix (`closed_confirmed`; a record that could have lost a hit closes it `closed_unverified`).
// - A recovered `open` or `claimed` card closes `closed_unverified` with the reason `source_recovered`; a recovered
//   `shipped` or `verifying` card closes `closed_confirmed`.
// - A fix nothing can measure (no plugin release mapping, or a friction note with no measure) closes
//   `closed_unverified` once its pull request is merged with green checks.
// - After `THIN_CHECKS_BEFORE_ESCALATION` checks without a decision the card closes `closed_unverified` with the reason
//   `thin_data_after_14_checks` when its pull request is merged with green checks, or when that could not be read
//   (never `closed_confirmed`); otherwise it goes back to `open`, so it is worked and not parked.
// - A reading that could not be made (a failed fetch, an unreadable record) decides nothing. It is never read as
//   "clear", "not merged" or "no release yet"; it counts as a waiting check so a permanent failure still reaches the
//   deadline.
//
// Bounds. One check a day per card: a card checked less than `CHECK_GAP_HOURS` ago is skipped. At most
// `MAX_CHECKS_PER_RUN` shipped or verifying cards are checked in one run, the card checked longest ago (or never)
// first; the rest are counted as `deferred` and, because every checked card is stamped, go first on the next run, so
// none is starved. Recovered `open` or `claimed` cards are closed up to the same cap.
//
// Card writes go through `writeCardCommitted` (injected, so tests never touch Git) wrapping the card library's
// `updateCard`. A claimed card is patched with its own claim id read from the card. The card holds pointers only.
// A mirror issue gets, at most, its `countermeasure` and `version` lines changed and one fixed comment when it is
// closed; nothing from a card is written to the store beyond that.
//
// Result. `runVerifyStep(env, { deskRoot, personPrefix, runner, now, ...seams }) -> { ok, result, counts }`. `result`
// is `verified`, `nothing_to_verify`, `cards_unreadable`, `headless_session` (nothing written, nothing recorded), a
// code of the store access (`route_unknown`, `store_invalid`, `not_opted_in`, `no_account`, `gh_missing`,
// `auth_failed`) or `unexpected_error`; the last two groups have `ok: false` and change no card. `counts` is a count
// per code. A run is recorded through `recordStep(env, "verify", ...)`.

import * as path from "node:path"

import { readCards, updateCard } from "../desk/improvement-cards.js"
import { cardCommitMessage, writeCardCommitted as writeCardCommittedDefault } from "../tools/_card-commit.js"
import { ghRunner } from "./flush.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { armKnownHits, knownHitsSince } from "./desk-problem-known.js"
import { storeFor } from "./kaizen-file.js"
import { conditionOf } from "./loop-conditions.js"
import { recordStep } from "./loop-status.js"
import { readConsent, readStatus } from "./outbox.js"
import { VERDICT_LABELS } from "./pipeline/kaizen.js"
import { mergedWithGreenChecks } from "./pr-green.js"
import { githubReader, shippedVersion } from "./release-version.js"
import { issuesClient } from "./store-issues.js"

export const THIN_CHECKS_BEFORE_ESCALATION = 14
export const MAX_CHECKS_PER_RUN = 25
export const CHECK_GAP_HOURS = 23
export const DESK_PROBLEM_QUIET_DAYS = 7
// A "clear" or "present" reading older than this is unavailable: a collector that stopped is not a recovery.
export const MAX_READING_AGE_HOURS = 72
// A card with its own signal that reads measured present at this many verifying checks reopens then.
export const RECURRING_VERIFYING_CHECKS = 3
export const RECONCILE_CLEAR_RUNS = 2
export const RECONCILE_RECURRING_RUNS = 3
export const CONFIRMED_COMMENT = "Closed by the Desk loop: the check confirmed this change."
export const UNVERIFIED_COMMENT = "Closed by the Desk loop: this change could not be verified by this measure."

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS
// Clear observations in a row that mean a source has recovered, per source.
const CLEAR_RUNS = { andon: 1, store_build: 1, desk_problem: 1, loop_alarm: 2, evaluator: 2, flush_health: 2 }
const RECOVERY_REASON = { andon: "andon_closed", store_build: "store_build_closed", reconcile_class: "reconcile_zero_twice", loop_alarm: "condition_cleared", evaluator: "condition_cleared", flush_health: "condition_cleared" }
const NO_MEASURE = new Set(["plugin_unmapped", "countermeasure_unparsed"])
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d{0,8})$/u
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const isCount = (value) => Number.isSafeInteger(value) && value >= 0

/** `githubAccess(env, { deskRoot, runner }) -> { ok: true, reader, issues(repo) } | { ok: false, code }`: the desk's store, the consenting account and its token, read the way the kaizen filer reads them. */
export async function githubAccess(env, { deskRoot, runner }) {
  const store = await storeFor(env, deskRoot)
  if (store === undefined) return { ok: false, code: "route_unknown" }
  if (store === null) return { ok: false, code: "store_invalid" }
  const consent = (await readConsent(env)).stores[store]
  if (consent?.contribute !== true) return { ok: false, code: "not_opted_in" }
  if (typeof consent.account !== "string") return { ok: false, code: "no_account" }
  const auth = await runner(["auth", "token", "--user", consent.account])
  if (auth.spawnError === "ENOENT") return { ok: false, code: "gh_missing" }
  const token = auth.code === 0 ? String(auth.stdout).trim() : ""
  if (token === "") return { ok: false, code: "auth_failed" }
  return { ok: true, reader: githubReader({ runner, token }), issues: (repo) => issuesClient({ runner, repo, token }) }
}

/** `withFields(body, countermeasure, version) -> string | null`: the issue body with its card block's `countermeasure` and `version` lines set (`null` writes the word null); null when the block does not hold exactly one of each. */
export function withFields(body, countermeasure, version) {
  const lines = String(body).split("\n")
  const find = (name) => lines.reduce((found, line, index) => (line.startsWith(`${name}:`) ? [...found, index] : found), [])
  const at = [find("countermeasure"), find("version")]
  if (at[0].length !== 1 || at[1].length !== 1) return null
  lines[at[0][0]] = `countermeasure: ${countermeasure ?? "null"}`
  lines[at[1][0]] = `version: ${version ?? "null"}`
  return lines.join("\n")
}

// A reading is fresh when it was observed no more than MAX_READING_AGE_HOURS ago (and not in the future).
function isFresh(at, now) {
  const age = new Date(now).getTime() - (typeof at === "string" ? Date.parse(at) : Number.NaN)
  return age >= 0 && age <= MAX_READING_AGE_HOURS * HOUR_MS
}

/** `reading(status, card, now) -> { kind: "recovered" | "present" | "clearing" | "unavailable" | "none" }`: what the source's own record says about a card's condition. `none` is a source without a recovery signal; a reading older than `MAX_READING_AGE_HOURS` is `unavailable`. */
export function reading(status, card, now) {
  const id = card.key.slice(card.source.length + 1)
  if (card.source === "reconcile_class") {
    const runs = status?.reconcile?.runs
    if (!isFresh(status?.reconcile?.at, now)) return { kind: "unavailable" }
    const run = isObject(runs) && Object.hasOwn(runs, id) ? runs[id] : undefined
    if (!isObject(run) || !isCount(run.clear) || !isCount(run.consecutive)) return { kind: "unavailable" }
    if (run.clear >= RECONCILE_CLEAR_RUNS) return { kind: "recovered" }
    return { kind: run.consecutive >= RECONCILE_RECURRING_RUNS ? "present" : "clearing" }
  }
  if (!Object.hasOwn(CLEAR_RUNS, card.source)) return { kind: "none" }
  const condition = conditionOf(status, card.key)
  if (condition.state !== "measured" || !isFresh(condition.observed_at, now)) return { kind: "unavailable" }
  if (condition.present) return { kind: "present" }
  return { kind: condition.clear_runs >= CLEAR_RUNS[card.source] ? "recovered" : "clearing" }
}

export async function runVerifyStep(env, {
  deskRoot, personPrefix = "", runner = ghRunner({ env }), now = new Date(),
  shipped = shippedVersion, merged = mergedWithGreenChecks, access = githubAccess,
  writeCardCommitted = writeCardCommittedDefault, readCardsImpl = readCards, readStatusImpl = readStatus,
  armImpl = armKnownHits, recordStepImpl = recordStep,
}) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("deskRoot: must be an absolute path")
  const nowMs = new Date(now).getTime()
  if (Number.isNaN(nowMs)) throw new TypeError("now: must be a valid time")
  const nowIso = new Date(nowMs).toISOString()
  const counts = {}
  const count = (code, n = 1) => { counts[code] = (counts[code] ?? 0) + n }
  if (isHeadlessFactorySession(env)) return { ok: false, result: "headless_session", counts }

  const finish = async (ok, result) => {
    try {
      await recordStepImpl(env, "verify", { ok, result, now: new Date(nowMs) })
    } catch {
      // the bookkeeping must never turn a finished run into a throw
    }
    return { ok, result, counts }
  }

  let read
  try {
    read = await readCardsImpl({ deskRoot, personPrefix })
  } catch {
    return finish(false, "cards_unreadable")
  }
  if (read.unreadable === true) return finish(false, "cards_unreadable")
  let status = null
  try {
    status = await readStatusImpl(env)
  } catch {
    // an unreadable status leaves every reading unavailable, which decides nothing
  }

  const isDue = (card) => {
    const last = card.last_check_at === null ? Number.NaN : Date.parse(card.last_check_at)
    const elapsed = nowMs - last
    return Number.isNaN(elapsed) || elapsed < 0 || elapsed >= CHECK_GAP_HOURS * HOUR_MS
  }
  const waitingKinds = read.cards.filter((card) => card.state === "shipped" || card.state === "verifying")
  const due = waitingKinds.filter(isDue).sort((a, b) => (`${a.last_check_at ?? ""} ${a.key}` < `${b.last_check_at ?? ""} ${b.key}` ? -1 : 1))
  const recovered = read.cards
    .filter((card) => (card.state === "open" || card.state === "claimed") && reading(status, card, nowMs).kind === "recovered")
    .sort((a, b) => (a.key < b.key ? -1 : 1))
  const checks = due.slice(0, MAX_CHECKS_PER_RUN)
  const closes = recovered.slice(0, MAX_CHECKS_PER_RUN)
  if (due.length > checks.length) count("deferred", due.length - checks.length)
  if (recovered.length > closes.length) count("deferred", recovered.length - closes.length)
  if (checks.length + closes.length === 0) return finish(true, "nothing_to_verify")

  let reader = null
  let issues = null
  if (checks.length > 0 || closes.some((card) => card.kaizen_url !== null)) {
    let granted
    try {
      granted = await access(env, { deskRoot, runner })
    } catch {
      granted = { ok: false, code: "unexpected_error" }
    }
    if (granted.ok !== true) return finish(false, granted.code)
    reader = granted.reader
    issues = granted.issues
  }

  const store = async (card, patch, okCode) => {
    try {
      const written = await writeCardCommitted({
        deskRoot,
        personPrefix,
        write: () => updateCard({ deskRoot, personPrefix, key: card.key, claim_id: card.state === "claimed" ? card.claim.claim_id : undefined, patch, now }),
        message: (outcome) => cardCommitMessage("verify", outcome.file_name),
      })
      if (written.result.result === "updated") {
        if (okCode !== undefined) count(okCode)
        return true
      }
    } catch {
      // counted below
    }
    count("card_write_failed")
    return false
  }

  const issueOf = (card) => {
    const [, repo, number] = ISSUE_URL.exec(card.kaizen_url)
    return { repo, number: Number(number) }
  }
  const readIssue = async (card) => {
    const { repo, number } = issueOf(card)
    const issue = await reader.get(`repos/${repo}/issues/${number}`)
    if (!isObject(issue) || !Array.isArray(issue.labels) || typeof issue.body !== "string") throw new Error("unexpected_answer")
    return { ...issue, names: issue.labels.map((label) => (isObject(label) ? label.name : label)) }
  }
  // Closes the mirror issue, then leaves one fixed comment. The close comes first so that a retry after a failed
  // close can never post a second comment; a missing comment is harmless. An issue already closed gets neither.
  // False when the store refused the close.
  const closeMirror = async (card, comment) => {
    try {
      const { repo, number } = issueOf(card)
      const issue = await readIssue(card)
      if (issue.state === "closed") return true
      const client = issues(repo)
      await client.updateIssue(number, { state: "closed", state_reason: comment === CONFIRMED_COMMENT ? "completed" : "not_planned" })
      try {
        await client.createComment(number, comment)
      } catch {
        count("comment_failed")
      }
      return true
    } catch {
      count("issue_failed")
      return false
    }
  }
  const close = async (card, state, reason) => {
    if (card.kaizen_url !== null && !(await closeMirror(card, state === "closed_confirmed" ? CONFIRMED_COMMENT : UNVERIFIED_COMMENT))) return
    if (await store(card, { state, close_reason: reason })) {
      count(state)
      count(reason)
    }
  }
  const reopen = async (card, note, extra = {}) => {
    if (!(await store(card, { state: "open", ...extra }))) return false
    count("reopened")
    count(note)
    if (card.kaizen_url !== null) {
      try {
        const { repo, number } = issueOf(card)
        const issue = await readIssue(card)
        const body = withFields(issue.body, null, null)
        if (body !== null) await issues(repo).updateIssue(number, { body })
      } catch {
        count("issue_failed")
      }
    }
    return true
  }

  // A reading that failed or is absent: the card keeps its state and its count, is stamped so it is looked at
  // once a day, and is counted under one stable code. Only the improvement age alarm surfaces a card that stays so.
  const stamp = async (card, result, code = "unreadable") => {
    await store(card, { last_check_at: nowIso, last_check_result: result }, code)
  }
  // A measured check that decided nothing: the count goes up by one.
  const waiting = async (card, result) => {
    await store(card, { checks_run: card.checks_run + 1, last_check_at: nowIso, last_check_result: result }, result)
  }
  // At the deadline the merge state decides, and only a read one: green closes unverified, not merged reopens, and
  // checks that are not green or not finished (or a merge state that could not be read) wait without advancing.
  const settle = async (card, state, result) => {
    if (state === "unavailable") return stamp(card, "waiting")
    if (state === "merged_not_green") return stamp(card, "checks_not_green", "checks_not_green")
    if (card.checks_run + 1 >= THIN_CHECKS_BEFORE_ESCALATION) {
      if (state === "merged_green") return close(card, "closed_unverified", "thin_data_after_14_checks")
      return reopen(card, "countermeasure_not_merged")
    }
    return waiting(card, result)
  }
  const mergedState = async (card) => (await merged({ countermeasure: card.countermeasure, client: reader })).state

  // Sets the version on the mirror issue (and clears a stale verdict label) and then on the card.
  const setVersion = async (card, version) => {
    if (!VERSION.test(version)) return stamp(card, "version_unavailable")
    if (card.kaizen_url !== null) {
      try {
        const { repo, number } = issueOf(card)
        const issue = await readIssue(card)
        const body = withFields(issue.body, card.countermeasure, version)
        if (body === null) throw new Error("unrecognised")
        const client = issues(repo)
        if (body !== issue.body) await client.updateIssue(number, { body })
        for (const label of Object.values(VERDICT_LABELS)) if (issue.names.includes(label)) await client.removeLabel(number, label)
      } catch {
        count("issue_failed")
        return stamp(card, "version_unavailable")
      }
    }
    // The library stamps the time the card entered verification and starts its checks again from zero.
    if (!(await store(card, { state: "verifying", shipped_version: version, last_check_at: nowIso, last_check_result: "version_set" }))) return undefined
    count("version_set")
    if (card.source === "desk_problem" && (await armImpl(env, { now: () => nowMs })).armed !== true) count("known_hits_not_armed")
    return undefined
  }

  const lookup = async (card, immediateNoMeasure) => {
    const found = await shipped({ plugin: card.plugin, countermeasure: card.countermeasure, client: reader })
    if (found.state === "version") return setVersion(card, found.version)
    if (found.state === "not_merged") return settle(card, "not_merged", "countermeasure_not_merged")
    // Not released yet says the pull request merged, not that its checks passed: only at the deadline is the merge state read.
    if (found.state === "not_released_yet") return card.checks_run + 1 < THIN_CHECKS_BEFORE_ESCALATION ? waiting(card, "waiting") : settle(card, await mergedState(card), "waiting")
    if (!NO_MEASURE.has(found.reason)) return stamp(card, "version_unavailable")
    const state = await mergedState(card)
    if (immediateNoMeasure && state === "merged_green") return close(card, "closed_unverified", "version_unavailable")
    return settle(card, state, state === "not_merged" ? "countermeasure_not_merged" : "waiting")
  }

  const verdict = async (card) => {
    let changed = false
    let issue
    try {
      issue = await readIssue(card)
      const body = withFields(issue.body, card.countermeasure, card.shipped_version)
      if (body === null) throw new Error("unrecognised")
      if (body !== issue.body) {
        await issues(issueOf(card).repo).updateIssue(issueOf(card).number, { body })
        changed = true
      }
    } catch {
      count("issue_failed")
      return stamp(card, "waiting")
    }
    // The store has not compared against this version yet, so any label on the issue is older than the body.
    if (changed) return thin(card)
    const confirmed = issue.names.includes(VERDICT_LABELS.confirmed)
    const notConfirmed = issue.names.includes(VERDICT_LABELS.not_confirmed)
    if (confirmed && !notConfirmed) return close(card, "closed_confirmed", "confirmed")
    if (notConfirmed && !confirmed) {
      const { repo, number } = issueOf(card)
      return reopen(card, "not_confirmed", { evidence: [...new Set([...card.evidence, `issue:${repo}#${number}`])].slice(-10) })
    }
    return thin(card)
  }
  // Measured thin data: the 14th such check decides by the merge state.
  const thin = async (card) => {
    if (card.checks_run + 1 < THIN_CHECKS_BEFORE_ESCALATION) return waiting(card, "thin_data")
    return settle(card, await mergedState(card), "thin_data")
  }

  const deskProblem = async (card) => {
    const number = Number(card.key.slice(card.source.length + 1).split("#")[1])
    const since = new Date(nowMs - DESK_PROBLEM_QUIET_DAYS * DAY_MS)
    const hits = knownHitsSince(status, number, card.shipped_version, { since })
    if (hits.state === "measured" && hits.hit) return reopen(card, "still_recurring")
    const condition = conditionOf(status, card.key)
    if (condition.state !== "measured" || !isFresh(condition.observed_at, nowMs)) return stamp(card, "waiting")
    if (condition.present) return card.checks_run + 1 >= RECURRING_VERIFYING_CHECKS ? reopen(card, "still_recurring") : waiting(card, "waiting")
    const quiet = Date.parse(card.verifying_since) <= since.getTime()
    if (condition.clear_runs >= 1 && quiet) return close(card, hits.state === "measured" ? "closed_confirmed" : "closed_unverified", "desk_problem_quiet")
    return waiting(card, "waiting")
  }

  const recovery = async (card) => {
    const seen = reading(status, card, nowMs)
    if (seen.kind === "recovered") return close(card, "closed_confirmed", RECOVERY_REASON[card.source])
    if (card.state === "shipped") return lookup(card, false)
    if (seen.kind === "unavailable") return stamp(card, "waiting")
    if (seen.kind === "present" && card.checks_run + 1 >= RECURRING_VERIFYING_CHECKS) return reopen(card, "still_recurring")
    return waiting(card, "waiting")
  }

  const check = async (card) => {
    // A card with a mirror issue is decided by the store's verdict, not by its source's recovery signal.
    if (card.kaizen_url !== null && card.state === "verifying") return verdict(card)
    if (card.source === "desk_problem" && card.kaizen_url === null) return card.state === "verifying" ? deskProblem(card) : lookup(card, false)
    if (Object.hasOwn(CLEAR_RUNS, card.source) || card.source === "reconcile_class") {
      if (card.kaizen_url === null) return recovery(card)
      return lookup(card, false)
    }
    if (card.source === "friction_candidate" && card.signal === null && card.kaizen_url === null) {
      const state = await mergedState(card)
      if (state === "merged_green") return close(card, "closed_unverified", "merged_without_signal")
      return settle(card, state, state === "not_merged" ? "countermeasure_not_merged" : "waiting")
    }
    return card.state === "shipped" ? lookup(card, true) : waiting(card, "waiting")
  }

  for (const card of closes) await close(card, "closed_unverified", "source_recovered")
  for (const card of checks) {
    try {
      await check(card)
    } catch {
      count("unexpected_error")
    }
  }
  return finish(true, "verified")
}
