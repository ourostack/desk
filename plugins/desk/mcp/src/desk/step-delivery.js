// A step's state from its source: Desk reads review, merge and delivery from the step's pull request, and a delegated step from its own card.
//
// Evidence holding a GitHub pull request URL: open -> `in review`; merged but not delivered by the repository's own rule
// (`.desk/delivery.json`, tools/delivery-gate.js `prDelivery`) -> `merged`; delivered -> `delivered`. A pull request closed without a merge leaves
// the declared state and says so. An answer GitHub could not give (`not_verified`, or a pull request it does not know) leaves the cell as it is and says
// so, as the done-gate fails open offline. Evidence `task:<track>/<slug>` follows that card's status: done -> delivered, blocked -> blocked,
// any other -> in progress. A dropped step is never derived, and neither is a blocked one that points at a pull request (the agent's own reason).
//
// Bounded: one derivation per call, one request set per distinct pull request, each request under prDelivery's own budget, all in parallel.
// Boot and desk_status never call this; task_update and the done check do. In a node:test run with no `fetchFn` no pull request is asked about.

import { findPullRequest, prDelivery } from "../tools/delivery-gate.js"
import { looksLikeNodeTestRunner } from "../runtime/test-state-guard.js"

const TASK_EVIDENCE = /^task:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u

/**
 * Derive each step's state. `rows` are the table's rows; `cardStatus(track, slug)` returns the status of a delegated card, or null when there is no such card.
 * Returns `{ changes, notes, why }`: `changes` maps a step name to `{ state, evidence }` for every step whose derived state differs from its cell;
 * `notes` are sentences for the answer (a closed pull request, an answer not verified); `why` maps a step name to why it is where it is.
 */
export async function deriveSteps(rows, { env, fetchFn, budgetMs, cardStatus }) {
  const asked = new Map()
  const ask = (pr) => {
    if (!asked.has(pr.url)) asked.set(pr.url, prDelivery({ repo: pr.repo, number: pr.number, env, fetchFn, budgetMs }))
    return asked.get(pr.url)
  }
  const offline = fetchFn === undefined && looksLikeNodeTestRunner(env)
  const changes = new Map()
  const notes = []
  const why = new Map()
  await Promise.all(
    rows.map(async (row) => {
      if (row.state === "dropped") return
      const task = TASK_EVIDENCE.exec(row.evidence)
      let derived = null
      if (task !== null) {
        const status = await cardStatus(task[1], task[2])
        if (status === null) notes.push(`step ${row.id}: the card ${row.evidence.slice(5)} was not found, so its state is left as it is`)
        else {
          derived = status === "done" ? "delivered" : status === "blocked" ? "blocked" : "in progress"
          why.set(row.id, `its card ${row.evidence.slice(5)} is ${status}`)
        }
      } else {
        const pr = row.state === "blocked" || offline ? null : findPullRequest(row.evidence)
        if (pr === null) return
        const answer = await ask(pr)
        const named = `${pr.repo}#${pr.number}`
        if (answer.status === "delivered") {
          derived = "delivered"
          why.set(row.id, `${named} is delivered (${answer.basis})`)
        } else if (answer.status === "undelivered" && answer.merged) {
          derived = "merged"
          why.set(row.id, `${named} is merged but not delivered: it must ${answer.unmet.map((entry) => entry.need).join(" and ")}`)
        } else if (answer.status === "undelivered" && answer.state === "open") {
          derived = "in review"
          why.set(row.id, `${named} is open`)
        } else if (answer.status === "undelivered") {
          notes.push(`step ${row.id}: PR closed without merge (${named}); its state is left as ${row.state}`)
          why.set(row.id, `PR closed without merge (${named})`)
        } else if (answer.status === "not_found") {
          notes.push(`step ${row.id}: GitHub does not know ${named}, so its state is left as it is`)
          why.set(row.id, `${named} does not exist on GitHub`)
        } else {
          notes.push(`step ${row.id}: not verified (${answer.reason}), so its state is left as ${row.state}`)
          why.set(row.id, `not verified: ${answer.reason}`)
        }
      }
      if (derived !== null && derived !== row.state) changes.set(row.id, { state: derived, evidence: row.evidence })
    }),
  )
  return { changes, notes: notes.sort(), why }
}

/** The steps a `done` move still waits for, each as a sentence with its state and why: none for a card whose every step is delivered or dropped. */
export function unsettledSteps(rows, { changes, why }) {
  return rows
    .map((row) => ({ id: row.id, state: changes.get(row.id)?.state ?? row.state, reason: why.get(row.id) ?? (row.state === "blocked" ? row.evidence : "") }))
    .filter((row) => row.state !== "delivered" && row.state !== "dropped")
    .map((row) => `${row.id} is ${row.state}${row.reason === "" ? "" : ` (${row.reason})`}`)
}
