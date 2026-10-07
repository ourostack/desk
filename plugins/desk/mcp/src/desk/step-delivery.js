// A step's state from its source: Desk reads review, merge and delivery from the step's pull requests, and a delegated step from its own card.
//
// Evidence holding GitHub pull request URLs: each is read with the repository's own delivery rule (`.desk/delivery.json`, tools/delivery-gate.js
// `prDelivery`): open -> `in review`; merged but not delivered -> `merged`; delivered -> `delivered`. A step with several takes the least advanced
// state. A pull request closed without a merge is noted and left out of the reading. If any pull request cannot be read (not verified, not found,
// out of time) the cell stays as it is and says so. Evidence `task:<track>/<slug>` follows that card: done -> delivered, blocked -> blocked,
// cancelled -> blocked (the agent decides whether to drop the step), any other -> in progress. A dropped step is never derived, and neither is a
// blocked one that points at a pull request (the agent's own reason). Evidence with neither a GitHub pull request nor a `task:` reference (an Azure
// DevOps pull request, a commit) is the agent's declaration and is left alone (desk/steps.js).
//
// Bounded: at most 4 pull requests are asked about at once, each request under prDelivery's own budget, and the whole refresh under a total budget
// (10 seconds); steps not checked by then stay as they are, with one note. The ordinary refresh skips steps already delivered; the `close` mode
// (the done check) reads every step with a GitHub pull request again, delivered ones included: a delivered cell whose pull request is unreachable stays
// delivered (fail open, as the gate does), and one whose pull request is readably not delivered, or closed without a merge, blocks the close.
// Boot and desk_status never call this. In a node:test run with no `fetchFn` no pull request is asked about.

import { findPullRequests, prDelivery } from "../tools/delivery-gate.js"
import { looksLikeNodeTestRunner } from "../runtime/test-state-guard.js"

const TOTAL_BUDGET_MS = 10000
const CONCURRENCY = 4
const ADVANCE = ["in review", "merged", "delivered"]
const TASK_EVIDENCE = /^task:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u

/** Does this evidence say where Desk can read the step's state (a GitHub pull request or a `task:` reference)? Then callers cannot set it by hand. */
export const isDerivable = (evidence) => findPullRequests(evidence).length > 0 || /^task:/u.test(evidence.trim())

/**
 * Derive each step's state. `rows` are the table's rows; `cardStatus(track, slug)` returns the status of a delegated card, or null when there is none (it may throw).
 * Returns `{ changes, notes, why, blocks }`: `changes` maps a step name to `{ state, evidence }` for every step whose derived state differs from its cell;
 * `notes` are sentences for the answer; `why` maps a step name to why it is where it is; `blocks` maps a delivered step the close must not accept to why.
 */
export async function deriveSteps(rows, { env, fetchFn, budgetMs, cardStatus, mode = "ordinary", totalBudgetMs = TOTAL_BUDGET_MS }) {
  const offline = fetchFn === undefined && looksLikeNodeTestRunner(env)
  const changes = new Map()
  const notes = []
  const why = new Map()
  const blocks = new Map()
  const live = rows.filter((row) => row.state !== "dropped")
  const taskOf = (row) => TASK_EVIDENCE.exec(row.evidence)
  const prsOf = (row) => (taskOf(row) !== null || row.state === "blocked" || offline || (mode === "ordinary" && row.state === "delivered") ? [] : findPullRequests(row.evidence))

  const distinct = [...new Map(live.flatMap(prsOf).map((pr) => [pr.url, pr])).values()]
  const answers = new Map()
  let expired = false
  let timer
  const out = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true
      resolve(null)
    }, totalBudgetMs)
  })
  const worker = async () => {
    while (distinct.length > 0 && !expired) {
      const pr = distinct.shift()
      const answer = await Promise.race([prDelivery({ repo: pr.repo, number: pr.number, env, fetchFn, budgetMs }), out])
      if (answer !== null) answers.set(pr.url, answer)
    }
  }
  await Promise.race([Promise.all(Array.from({ length: CONCURRENCY }, worker)), out])
  clearTimeout(timer)
  const unchecked = []

  for (const row of live) {
    const task = taskOf(row)
    let derived = null
    if (task !== null) {
      const named = `${task[1]}/${task[2]}`
      let status
      try {
        status = await cardStatus(task[1], task[2])
      } catch (error) {
        notes.push(`step ${row.id}: its card ${named} could not be read (${error.message}), so its state is left as it is`)
        continue
      }
      if (status === null) notes.push(`step ${row.id}: the card ${named} was not found, so its state is left as it is`)
      else if (status === "cancelled") {
        derived = "blocked"
        notes.push(`step ${row.id}: its card ${named} is cancelled, so the step is blocked; decide whether to drop it`)
        why.set(row.id, `card cancelled (${named})`)
      } else {
        derived = status === "done" ? "delivered" : status === "blocked" ? "blocked" : "in progress"
        why.set(row.id, `its card ${named} is ${status}`)
      }
    } else {
      const prs = prsOf(row)
      if (prs.length === 0) continue
      const states = []
      const reasons = []
      const closed = []
      let unresolved = false
      for (const pr of prs) {
        const answer = answers.get(pr.url)
        const named = `${pr.repo}#${pr.number}`
        if (answer === undefined) {
          unresolved = true
          unchecked.push(row.id)
          reasons.push(`not verified: ${named} was not checked in time`)
        } else if (answer.status === "delivered") {
          states.push("delivered")
          reasons.push(`${named} is delivered (${answer.basis})`)
        } else if (answer.status === "undelivered" && answer.merged) {
          states.push("merged")
          reasons.push(`${named} is merged but not delivered: it must ${answer.unmet.map((entry) => entry.need).join(" and ")}`)
        } else if (answer.status === "undelivered" && answer.state === "open") {
          states.push("in review")
          reasons.push(`${named} is open`)
        } else if (answer.status === "undelivered") {
          closed.push(named)
          notes.push(`step ${row.id}: PR closed without merge (${named})`)
          reasons.push(`PR closed without merge (${named})`)
        } else if (answer.status === "not_found") {
          unresolved = true
          notes.push(`step ${row.id}: GitHub does not know ${named}, so its state is left as it is`)
          reasons.push(`${named} does not exist on GitHub`)
        } else {
          unresolved = true
          notes.push(`step ${row.id}: not verified (${answer.reason}), so its state is left as ${row.state}`)
          reasons.push(`not verified: ${answer.reason}`)
        }
      }
      why.set(row.id, reasons.join("; "))
      if (!unresolved && states.length > 0) derived = ADVANCE[Math.min(...states.map((state) => ADVANCE.indexOf(state)))]
      else if (!unresolved && row.state === "delivered") blocks.set(row.id, why.get(row.id))
    }
    if (derived !== null && derived !== row.state) changes.set(row.id, { state: derived, evidence: row.evidence })
  }
  if (unchecked.length > 0) notes.push(`the steps refresh ran out of its ${totalBudgetMs / 1000}-second budget; not checked, so left as they are: ${[...new Set(unchecked)].join(", ")}`)
  return { changes, notes: notes.sort(), why, blocks }
}

/** The steps a `done` move still waits for, as sentences with state and why: none when every step is delivered or dropped and no delivered one is contradicted. Rows are the card's rows after the refresh was written. */
export function unsettledSteps(rows, { why, blocks }) {
  return rows
    .filter((row) => (row.state !== "delivered" && row.state !== "dropped") || blocks.has(row.id))
    .map((row) => {
      const reason = why.get(row.id) ?? (row.state === "blocked" ? row.evidence : "")
      return `${row.id} is ${row.state}${reason === "" ? "" : ` (${reason})`}`
    })
}
