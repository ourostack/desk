// The loop's `mirror` step. An open or claimed improvement card that names a measure (`signal`) and has no
// `kaizen_url` gets its issue in the desk's factory store, through the existing kaizen filer, and the issue's URL is
// stored on the card. The store's build then checks the issue once a countermeasure ships.
//
// Public text. The filer decides what a store sees: a public store gets only structured fields (the plugin, the
// friction class, the measure and the evidence jobs). This step hands it nothing from a card beyond its title, plugin,
// signal and `job:` evidence pointers, plus one fixed sentence as the body; a `friction_candidate` title has already
// passed `isGeneric` when the card was opened, and the library builds every other title from a frozen table.
//
// Rate limit. The filer's five-a-day cap stays. A card the filer holds back is left as it is and tried again on a
// later run. A hold that belongs to the whole store (`held_cap`, `route_unknown`, `not_opted_in`, `store_invalid`,
// `no_account`, `gh_missing`, `auth_failed`) ends the run: every card not yet tried is counted under that code instead
// of asking the filer again. At most `MAX_ATTEMPTS` cards are tried in one run, oldest first; the rest are `deferred`.
//
// Result. `runMirrorStep(env, { deskRoot, personPrefix, now, ...seams }) -> { ok, result, mirrored, counts }`.
// `mirrored` lists the keys that now carry a URL. `counts` is a count per code: `filed`, `duplicate`, every code the filer
// held a card under, `no_signal` (a candidate state with no measure), `deferred`, `card_write_failed`, `unexpected_error`.
// `result` is one of `mirrored`, `mirrored_some_held`, `nothing_to_mirror`, `all_held` (every card was held back: the
// counts say why), `delivery_failed` (nothing mirrored and the filer, GitHub or the network failed; `ok` is false),
// `card_write_failed` (the issue exists but the card could not record it; the next run finds the issue as a duplicate),
// `cards_unreadable`, and `headless_session`. A run is recorded through `recordStep(env, "mirror", ...)` except for a
// headless session, which writes nothing.
//
// Card writes go through `writeCardCommitted` (injected, so tests never touch Git) wrapping `updateCard` with a system
// patch. A card that is claimed is patched with its own recorded claim id read from the card file (the patch touches
// only `kaizen_url`, never the claim), because the library refuses any patch to a live claim without it.

import * as path from "node:path"

import { readCards, updateCard } from "../desk/improvement-cards.js"
import { cardCommitMessage, writeCardCommitted as writeCardCommittedDefault } from "../tools/_card-commit.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { fileKaizenCard } from "./kaizen-file.js"
import { recordStep } from "./loop-status.js"
import { PATTERNS } from "./schema.js"

export const MAX_ATTEMPTS = 20
export const MIRROR_BODY = "An improvement card on a Desk machine names this measure. A public card carries structured fields only."

const STORE_LEVEL = new Set(["held_cap", "route_unknown", "not_opted_in", "store_invalid", "no_account", "gh_missing", "auth_failed"])
// Codes that mean the filer or GitHub failed rather than that a rule held the card back.
const DELIVERY = new Set(["gh_missing", "auth_failed", "timeout", "unexpected_answer", "too_many_issues", "gh_failed", "unexpected_error"])
const FILER_CODE = /^[a-z0-9_]{1,40}$/u
const FACTORY_SOURCES = new Set(["andon", "evaluator", "reconcile_class"])

const isDelivery = (code) => DELIVERY.has(code) || /^http_\d{3}$/u.test(code)

/** `frictionClassOf(source) -> string`: `factory` for andon, evaluator and reconcile cards, `hook` for flush health, `other` for the rest; always a member of `FRICTION_CLASSES`. */
export function frictionClassOf(source) {
  if (FACTORY_SOURCES.has(source)) return "factory"
  return source === "flush_health" ? "hook" : "other"
}

const jobsOf = (card) => card.evidence.filter((pointer) => pointer.startsWith("job:")).map((pointer) => pointer.slice(4)).filter((job) => PATTERNS.jobId.test(job))

export async function runMirrorStep(env, {
  deskRoot, personPrefix, now,
  fileCard = fileKaizenCard, writeCardCommitted = writeCardCommittedDefault, readCardsImpl = readCards, recordStepImpl = recordStep,
}) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("deskRoot: must be an absolute path")
  const nowMs = new Date(now).getTime()
  if (Number.isNaN(nowMs)) throw new TypeError("now: must be a valid time")
  const mirrored = []
  const counts = {}
  const count = (code, n = 1) => { counts[code] = (counts[code] ?? 0) + n }
  if (isHeadlessFactorySession(env)) return { ok: false, result: "headless_session", mirrored, counts }

  const finish = async (ok, result) => {
    try {
      await recordStepImpl(env, "mirror", { ok, result, now: new Date(nowMs) })
    } catch {
      // the bookkeeping must never turn a finished run into a throw
    }
    return { ok, result, mirrored, counts }
  }

  let read
  try {
    read = await readCardsImpl({ deskRoot, personPrefix })
  } catch {
    return finish(false, "cards_unreadable")
  }
  if (read.unreadable === true) return finish(false, "cards_unreadable")

  const live = read.cards.filter((card) => (card.state === "open" || card.state === "claimed") && card.kaizen_url === null)
  const noSignal = live.filter((card) => card.signal === null).length
  if (noSignal > 0) count("no_signal", noSignal)
  const candidates = live.filter((card) => card.signal !== null).sort((a, b) => (`${a.opened_at} ${a.key}` < `${b.opened_at} ${b.key}` ? -1 : 1))

  let attempts = 0
  let delivery = 0
  let writeFailed = 0
  for (const [index, card] of candidates.entries()) {
    if (attempts === MAX_ATTEMPTS) {
      count("deferred", candidates.length - index)
      break
    }
    attempts += 1
    let answer
    try {
      answer = await fileCard(env, { deskRoot, title: card.title, body: MIRROR_BODY, plugin: card.plugin, frictionClass: frictionClassOf(card.source), signal: card.signal, evidenceJobs: jobsOf(card) })
    } catch {
      answer = { result: "unexpected_error" }
    }
    const code = typeof answer?.result === "string" && FILER_CODE.test(answer.result) ? answer.result : "unexpected_error"
    if (code === "filed" || code === "duplicate") {
      if (await store(card, answer.url)) {
        mirrored.push(card.key)
        count(code)
      } else {
        writeFailed += 1
        count("card_write_failed")
      }
      continue
    }
    count(code)
    if (isDelivery(code)) delivery += 1
    if (STORE_LEVEL.has(code)) {
      count(code, candidates.length - index - 1)
      break
    }
  }

  const held = candidates.length - mirrored.length
  let result
  if (candidates.length === 0) result = "nothing_to_mirror"
  else if (mirrored.length > 0) result = held === 0 ? "mirrored" : "mirrored_some_held"
  else if (writeFailed > 0) result = "card_write_failed"
  else result = delivery > 0 ? "delivery_failed" : "all_held"
  return finish(result !== "delivery_failed" && result !== "card_write_failed", result)

  async function store(card, url) {
    try {
      const written = await writeCardCommitted({
        deskRoot,
        personPrefix,
        write: () => updateCard({ deskRoot, personPrefix, key: card.key, claim_id: card.state === "claimed" ? card.claim.claim_id : undefined, patch: { kaizen_url: url }, now }),
        message: (outcome) => cardCommitMessage("mirror", outcome.file_name ?? "card"),
      })
      return written.result.result === "updated"
    } catch {
      return false
    }
  }
}
