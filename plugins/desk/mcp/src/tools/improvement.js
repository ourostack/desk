// improvement_open, improvement_next and improvement_update: the agent's three doors to the improvement cards that
// live on the desk (`desk/improvement-cards.js`). Every card write goes through `writeCardCommitted`, the same
// commit-and-push protocol the task tools and friction_add use.
//
// Answers carry the card's file name and stable codes, never an absolute path, an account or text from outside the
// card. A writing tool: the headless guard refuses all three under DESK_FACTORY_HEADLESS because none is on its
// read-only list.

import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { personPrefix } from "../util/paths.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { isNoninteractive } from "../runtime/boot.js"
import { isHeadlessFactorySession } from "../factory/headless-flag.js"
import { cardKey, openImprovement, claimNext, updateCard, readCards, MAX_CARD_FILES } from "../desk/improvement-cards.js"
import { writeCardCommitted, cardCommitMessage } from "./_card-commit.js"
import { AUTHORITY } from "../desk/improvement-authority.js"

export const IMPROVEMENT_OPEN_FIELDS = ["source", "id", "title", "evidence", "plugin", "signal"]
export const IMPROVEMENT_NEXT_FIELDS = ["session"]
export const IMPROVEMENT_UPDATE_FIELDS = ["key", "claim_id", "state", "countermeasure", "close_reason"]

/** The fixed paragraph printed with every pickup (the authority-statement ruling). */
export { AUTHORITY }

/** What each refusal of `improvement_next` means, in one fixed sentence. */
export const NEXT_REFUSALS = Object.freeze({
  claim_held: "This machine already holds a live claim; finish or release that card first.",
  cap_reached: "This machine has taken its claims for today; try again tomorrow.",
  none_open: "No improvement card is open.",
  too_many_cards: "The card folder holds more files than can be read safely; close or archive finished cards.",
  machine_key_unavailable: "This machine has no factory state, so it cannot take improvement cards.",
  noninteractive: "Improvement cards are only taken in a session with an operator present.",
})

/** The close reasons an agent may give for a card it holds. */
export const AGENT_CLOSE_REASONS = Object.freeze(["wont_fix", "duplicate", "not_reproducible"])

const OPENED = new Set(["opened", "duplicate", "reopened"])

// The card library takes the person prefix relative to the desk root: "" or desks/<alias>.
function prefixOf(deskRoot, person) {
  return path.relative(deskRoot, personPrefix(deskRoot, person))
}

function withCommit(answer, commit, setAside, leftAlone) {
  if (commit !== "committed" && commit !== "no_files" && commit !== "no_change") answer.commit = commit
  if (setAside) answer.set_aside = setAside
  if (leftAlone) answer.left_alone = leftAlone
  return answer
}

const messageFor = (verb) => (result) => cardCommitMessage(verb, result.file_name ?? "set_aside")

async function record(deskRoot, readiness, prefix, fileName) {
  if (fileName) await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: path.join(prefix, "_meta", "improvement", fileName) }] })
}

/**
 * improvement_open({ source, id, title?, evidence?, plugin?, signal? }) -> { status, result, file_name?, commit?, set_aside? }
 * `status` is "ok" when the card is opened, reopened or already open, else "refused"; `result` is the library's code.
 * `title` is never accepted (refused `title_not_allowed`): the library builds every title.
 */
export async function improvement_open({ deskRoot, input, person = null, readiness, now, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  let key
  try {
    key = cardKey(values.source, values.id)
  } catch {
    return { status: "refused", result: "invalid_source" }
  }
  const prefix = prefixOf(deskRoot, person)
  const { result, commit, left_alone: leftAlone } = await writeCardCommitted({
    deskRoot,
    personPrefix: prefix,
    message: messageFor("open"),
    spawnGit,
    schedulePush,
    write: () => openImprovement({
      deskRoot, personPrefix: prefix, key, source: values.source, title: values.title,
      evidence: values.evidence ?? [], plugin: values.plugin ?? "desk", signal: values.signal ?? null, now,
    }),
  })
  await record(deskRoot, readiness, prefix, result.file_name)
  const answer = { status: OPENED.has(result.result) ? "ok" : "refused", result: result.result }
  if (result.file_name) answer.file_name = result.file_name
  return withCommit(answer, commit, result.set_aside, leftAlone)
}

/**
 * improvement_next({ session? }) -> { status: "claimed", card, claim_id, authority } | { status: <code>, meaning }
 * The codes are the keys of NEXT_REFUSALS, plus the library's own (`invalid_session`, `unreadable_folder`, `lock_busy`,
 * `invalid_location`).
 */
export async function improvement_next({ deskRoot, input, person = null, readiness, env = process.env, now, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  if (isNoninteractive(env) || isHeadlessFactorySession(env)) return { status: "noninteractive", meaning: NEXT_REFUSALS.noninteractive }
  const prefix = prefixOf(deskRoot, person)
  const { result, commit, left_alone: leftAlone } = await writeCardCommitted({
    deskRoot,
    personPrefix: prefix,
    message: messageFor("claim"),
    spawnGit,
    schedulePush,
    write: () => claimNext({ env, deskRoot, personPrefix: prefix, now, session: input?.session }),
  })
  if (result.result !== "claimed") {
    const answer = { status: result.result }
    if (NEXT_REFUSALS[result.result]) answer.meaning = NEXT_REFUSALS[result.result]
    if (result.result === "claim_held") answer.key = result.key
    return withCommit(answer, commit, result.set_aside, leftAlone)
  }
  await record(deskRoot, readiness, prefix, result.file_name)
  const { key, source, title, evidence, state, plugin, signal, countermeasure, kaizen_url: kaizenUrl, recurrences, reopened, checks_run: checksRun } = result.card
  const card = { key, source, title, evidence, state, plugin, signal, countermeasure, kaizen_url: kaizenUrl, recurrences, reopened, checks_run: checksRun }
  return withCommit({ status: "claimed", card, claim_id: result.claim_id, authority: AUTHORITY }, commit, result.set_aside, leftAlone)
}

// What the holder of a claim may do, as the library patch it means; null when the input asks for something else.
function holderPatch(values) {
  const { state, countermeasure, close_reason: reason } = values
  if (countermeasure !== undefined && (state === undefined || state === "shipped") && reason === undefined) return { state: "shipped", countermeasure }
  if (state === "open" && countermeasure === undefined && reason === undefined) return { state: "open" }
  if (state === "closed_unverified" && countermeasure === undefined && AGENT_CLOSE_REASONS.includes(reason)) return { state, close_reason: reason }
  return null
}

/**
 * improvement_update({ key, claim_id, state?, countermeasure?, close_reason? }) -> { status: "updated", state } | { status: "refused", result }
 * Allowed for the holder of the card's claim, and only these three: ship (`countermeasure`, with `state` "shipped" or
 * omitted), release (`state: "open"`) and close (`state: "closed_unverified"` with a `close_reason` from
 * AGENT_CLOSE_REASONS). Everything the verify step owns is out of reach.
 */
export async function improvement_update({ deskRoot, input, person = null, readiness, now, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  const prefix = prefixOf(deskRoot, person)
  const patch = holderPatch(values)
  if (patch === null) return { status: "refused", result: "invalid_patch" }
  if (typeof values.key !== "string" || typeof values.claim_id !== "string") return { status: "refused", result: "not_your_claim" }
  const held = await readCards({ deskRoot, personPrefix: prefix, limit: MAX_CARD_FILES })
  if (held.unreadable) return { status: "refused", result: "unreadable_folder" }
  const card = held.cards.find((candidate) => candidate.key === values.key)
  if (!card) return { status: "refused", result: "not_found" }
  if (card.state !== "claimed" || card.claim?.claim_id !== values.claim_id) return { status: "refused", result: "not_your_claim" }
  const { result, commit, left_alone: leftAlone } = await writeCardCommitted({
    deskRoot,
    personPrefix: prefix,
    message: messageFor("update"),
    spawnGit,
    schedulePush,
    write: () => updateCard({ deskRoot, personPrefix: prefix, key: values.key, claim_id: values.claim_id, patch, now }),
  })
  if (result.result !== "updated") {
    return withCommit({ status: "refused", result: result.result }, commit, result.set_aside, leftAlone)
  }
  await record(deskRoot, readiness, prefix, result.file_name)
  return withCommit({ status: "updated", state: result.card.state }, commit, result.set_aside, leftAlone)
}
