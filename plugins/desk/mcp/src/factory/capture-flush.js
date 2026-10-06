// What the flush does with the capture record (`capture-publish.js`): when one is due, whether the store takes it, and what is kept in
// `status.capture[<store>]` about it. `flush.js` calls this file at three seams (the early "nothing pending" return, the batch, the rejection read)
// and never decides anything about the record itself.
//
// Bookkeeping lives only in `status.capture[store]`, never in a delivered record, so an older Desk's flush ignores it. Its keys, all optional,
// and every value a fixed code, a number, a timestamp or a git blob sha (never a name, a count or a path):
//   blob         the sha of the record the default branch is known to hold (the empty record's is forgotten once it is there)
//   sent_at      when a record was last pushed
//   pr           the number of the pull request that carried it, until the default branch holds it or the store refuses it
//   sent_bytes   the exact record pushed in `pr` (counts of this machine's own store scope only), so an open pull request keeps carrying those bytes
//   refused      the fixed code of the store's refusal that named the record
//   skipped      `store_not_ready`: the store's `capture.json` is not exactly `{"capture":1}`
//   invalid      `capture_invalid`: the record failed its own gate (a bug in the caller or the coverage); nothing is sent
//   check_unavailable  how many times in a row the store's own check could not read the record's commits (stale, not a refusal); cleared when a record settles
//   retry_after  nothing is considered before it: +24 h for skipped, +7 days for refused, +1 day for invalid
// Keys this file does not know are kept as they are.
//
// Due, with no network: coverage whose `ran_at` is a parsable time not in the future and under three days old (a failed pass leaves the earlier
// coverage in place, so it is used only while that holds; none, or a stale one, sends nothing and retracts nothing), now past `retry_after`, a record
// (or the empty record that retracts one sent before) whose blob differs from `blob`, and 20 hours since `sent_at`. A record whose pull request is
// still open (`pr` is set while the flush has a batch it has not seen settled) is carried in every rebuild of the branch, so it is never dropped
// from the open pull request by an unrelated rebuild.
//
// The store's acceptance is read from its own file at the root of the default branch, `capture.json`, whose content is exactly the JSON object
// `{"capture":1}`: `GET repos/<store>/contents/capture.json?ref=<default branch>`, the file decoded from base64 and parsed as JSON, and the record goes
// only when the parsed value is an object whose only key is `capture` and whose value is the number 1. Anything else (no file, an error answer, not JSON,
// an extra key, another value) is `store_not_ready`. `factory.json` is deliberately not read or changed, so an older client's andon parser keeps working.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { EMPTY_RECORD, captureFor, isCaptureInvalid } from "./capture-publish.js"
import { CAPTURE_PATH } from "./capture-schema.js"
import { loopSlotFrom } from "./loop-slot.js"
import { gitBlobSha, readStatus, writeStatus } from "./outbox.js"

export const CAPTURE_FLAG = 1
export const SEND_INTERVAL_MS = 20 * 60 * 60 * 1000
export const FRESH_MS = 3 * 24 * 60 * 60 * 1000
export const NOT_READY_MS = 24 * 60 * 60 * 1000
export const INVALID_MS = 24 * 60 * 60 * 1000
export const REFUSED_MS = 7 * 24 * 60 * 60 * 1000
export const NOT_READY = "store_not_ready"
export const INVALID = "capture_invalid"

const SHA = /^[0-9a-f]{40}$/u
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const timeOf = (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN)
const iso = (ms) => new Date(ms).toISOString()
const RECORD_KEYS = ["blob", "sent_at", "pr", "refused", "skipped", "invalid", "retry_after", "check_unavailable"]

/** The coverage the record may be built from: parsable `ran_at`, not in the future, under three days old; else null. */
export function freshCoverage(status, nowMs) {
  const coverage = status?.coverage
  if (!isObject(coverage)) return null
  const ranAt = timeOf(coverage.ran_at)
  return Number.isFinite(ranAt) && ranAt <= nowMs && nowMs - ranAt < FRESH_MS ? coverage : null
}

/** How many stores have `contribute: true`, a store counted once however its name is spelled and only when every spelling says so (as the sweep reads consent). */
export function contributingStores(stores) {
  const merged = new Map()
  for (const [name, entry] of Object.entries(stores)) merged.set(name.toLowerCase(), (merged.get(name.toLowerCase()) ?? true) && isObject(entry) && entry.contribute === true)
  return [...merged.values()].filter(Boolean).length
}

const bookkeeping = (status, store) => (isObject(status?.capture) && isObject(status.capture[store]) ? status.capture[store] : {})

/**
 * `planCapture({ status, consent, store, intakeId, nowMs, mayBeOpen }) -> { work, due, carry, record, cap, invalid }`, from local state only.
 * `consent` is the `stores` map the flush read. `record` is `{ path, bytes (a Buffer), sha, capture: true, empty }` or null. `work` is true when
 * the flush has to go online for the record; `invalid` is true when the record failed its own gate (the caller records it).
 */
export function planCapture({ status, consent, store, intakeId, nowMs, mayBeOpen }) {
  const cap = bookkeeping(status, store)
  const none = { work: false, due: false, carry: false, record: null, cap, invalid: false }
  const coverage = freshCoverage(status, nowMs)
  if (coverage === null || nowMs < timeOf(cap.retry_after)) return none
  const sentBefore = (typeof cap.blob === "string" && SHA.test(cap.blob)) || Number.isSafeInteger(cap.pr)
  const loop = loopSlotFrom(isObject(status?.loop) ? status.loop.health : null, nowMs)
  const made = captureFor(coverage, { store, intakeId, sentBefore, loop, contributing: contributingStores(consent) })
  if (isCaptureInvalid(made)) return { ...none, invalid: true }
  if (made === null || made.sha === cap.blob) return none
  const sentAt = timeOf(cap.sent_at)
  const due = !(sentAt <= nowMs && nowMs - sentAt < SEND_INTERVAL_MS)
  const carry = Number.isSafeInteger(cap.pr) && mayBeOpen === true
  const fresh = { path: made.path, bytes: Buffer.from(made.bytes, "utf8"), sha: made.sha, capture: true, empty: made.bytes === EMPTY_RECORD }
  if (due) return { work: true, due, carry, record: fresh, cap, invalid: false }
  // Not due: an open pull request carries exactly the bytes sent, never newer ones, so nothing is pushed to it inside the 20 hours.
  const kept = typeof cap.sent_bytes === "string" ? Buffer.from(cap.sent_bytes, "utf8") : null
  const record = carry && kept !== null ? { ...fresh, bytes: kept, sha: gitBlobSha(kept), empty: cap.sent_bytes === EMPTY_RECORD } : null
  return { work: record !== null, due, carry, record, cap, invalid: false }
}

// The bookkeeping of `store` after `change(cap)`; an empty one is removed. Unknown keys stay.
async function update(env, store, change) {
  const status = await readStatus(env)
  const all = isObject(status.capture) ? status.capture : {}
  const next = change(bookkeeping(status, store))
  const { [store]: _old, ...others } = all
  await writeStatus(env, { capture: Object.keys(next).length === 0 ? others : { ...others, [store]: next } })
}

const without = (cap, keys) => Object.fromEntries(Object.entries(cap).filter(([key]) => !keys.includes(key)))
const SIGNALS = ["pr", "sent_bytes", "refused", "skipped", "invalid", "retry_after"]
const SETTLED_CLEARS = [...SIGNALS, "check_unavailable"]

/**
 * The store's own check could not read the commits for the pull request that carried the record: one more in a row. The record is not blamed
 * (it goes again in its turn), but a store that keeps failing must show, so the count is kept (`check_unavailable`) and `retentionLines` reads it. A delivery that settles clears it.
 */
export const saveCheckUnavailable = (env, store) => update(env, store, (cap) => ({ ...cap, check_unavailable: (Number.isSafeInteger(cap.check_unavailable) ? cap.check_unavailable : 0) + 1 }))

/** The record failed its own gate: only the fixed code is kept, and nothing is considered for a day. */
export const saveInvalid = (env, store, nowMs) => update(env, store, (cap) => ({ ...without(cap, ["refused", "skipped"]), invalid: INVALID, retry_after: iso(nowMs + INVALID_MS) }))

/** The store's refusal named the record: the code and a week's wait; the pull request that carried it is closed. */
export const saveRefused = (env, store, code, nowMs) => update(env, store, (cap) => ({ ...without(cap, ["pr", "sent_bytes", "skipped", "invalid"]), refused: code, retry_after: iso(nowMs + REFUSED_MS) }))

/** The store's `capture.json` does not say `{"capture":1}`: nothing is sent, and it is asked again after a day. */
export const saveNotReady = (env, store, nowMs) => update(env, store, (cap) => ({ ...without(cap, ["refused", "invalid"]), skipped: NOT_READY, retry_after: iso(nowMs + NOT_READY_MS) }))

/** The record was pushed in pull request `pr`. */
export const saveSent = (env, store, item, pr, nowMs) => update(env, store, (cap) => ({ ...without(cap, SIGNALS), pr, sent_bytes: item.bytes.toString("utf8"), sent_at: item.fresh === false ? cap.sent_at : iso(nowMs) }))

/** The default branch holds the record's bytes (`sha`); an empty record that is there is forgotten, with everything else kept about the delivery. */
export const saveSettled = (env, store, item) => update(env, store, (cap) => (item.empty ? without(cap, [...RECORD_KEYS]) : { ...without(cap, SETTLED_CLEARS), blob: item.sha }))

/** A push left the record out of the pull request, so nothing is pending for it any more: a later refusal of that pull request is not the record's. */
export const dropPending = (env, store) => update(env, store, (cap) => without(cap, ["pr", "sent_bytes"]))

/** An empty record with nothing on the default branch to retract: forgotten. */
export const saveForgotten = (env, store) => update(env, store, (cap) => without(cap, RECORD_KEYS))

/**
 * What a settled lookup (`landed(item)`, the default branch's blob at the item's path, `undefined` for none) means for the record `item`:
 * `"settled"` (the bytes are there), `"forget"` (an empty record with nothing to retract) or `"send"`. A listing that cannot say sends.
 */
export function judge(item, found, { pending = false } = {}) {
  if (found === item.sha) return "settled"
  // An empty record with nothing to retract on the default branch is forgotten, unless an open pull request still holds the earlier record: it is replaced.
  return item.empty && found === undefined && !pending ? "forget" : "send"
}

/** Whether the store's default branch holds a `capture.json` that is exactly `{"capture":1}`; see the header. `client` is the flush's client. */
export async function storeAcceptsCapture(client, store, branch) {
  const answer = await client.api("GET", `repos/${store}/contents/capture.json?ref=${encodeURIComponent(branch)}`)
  if (answer.status !== 200 || !isObject(answer.json) || answer.json.encoding !== "base64" || typeof answer.json.content !== "string") return false
  try {
    const config = JSON.parse(Buffer.from(answer.json.content, "base64").toString("utf8"))
    return isObject(config) && Object.keys(config).join() === "capture" && config.capture === CAPTURE_FLAG
  } catch {
    return false
  }
}

/** The blob sha at each `capture/<name>` of a tree, read through `read(treeSha) -> Map(name -> { type, sha })`. */
export async function captureOnBranch(read, treeSha) {
  const blobs = new Map()
  const dir = (await read(treeSha)).get("capture")
  if (dir?.type !== "tree") return blobs
  for (const [name, entry] of await read(dir.sha)) {
    if (entry.type === "blob" && CAPTURE_PATH.test(`capture/${name}`)) blobs.set(`capture/${name}`, entry.sha)
  }
  return blobs
}

/** The store's own check could not read the commits: its infrastructure failed, not the record. Never the record's refusal, so it never costs a week. */
export const CHECK_UNAVAILABLE = "capture_check_unavailable"

/**
 * Whether a refusal `code` names the record: a `capture_` code (but not `capture_check_unavailable`, a failure of the store's own check, which is
 * stale like a conflict: the next batch goes again), or any code that is not a stale one (`stale`) on the pull request that carried the
 * record (`onRecordedPr`). The store's own validator may refuse the record with the plain schema codes facts use, so on that pull request the
 * facts are not blamed: they go again without the record, and a real facts error is refused (and quarantined) on the next pull request.
 */
export const namesRecord = (code, { onRecordedPr, stale }) => (code.startsWith("capture_") && code !== CHECK_UNAVAILABLE) || (onRecordedPr && !stale.has(code))
