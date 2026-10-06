// The outcome record a task card carries, and the rules for writing it. Three
// keys, written only by the task tools: `signoff` (the human's answer to a
// delivery), `flow` (where the card has been) and `returns` (one line per
// time work went backwards). Every function here is pure: it returns a new
// record and never changes its input. Times are ISO strings, as the card
// holds them. A malformed part of a record reads as absent (`null`), never
// as a guess.

export const SIGNOFF_STATES = ["delivered_unsigned", "accepted", "refused"]
export const OUTCOME_STATES = ["not_delivered", "not_recorded", "delivered_unsigned", "accepted", "refused", "reopened"]
export const REFUSAL_REASONS = ["not_what_was_asked", "defect", "changed_ask", "incomplete", "other"]
export const RETURN_REASONS = ["agent_error", "changed_ask", "new_information", "external"]
export const CATCH_POINTS = ["in_task", "at_review", "after_delivery"]
export const WAIT_CLASSES = ["lt_1h", "lt_1d", "lt_7d", "ge_7d"]
export const SIGNOFF_ALARM_DAYS = 7

const FLOW_SINCE = ["created", "adopted"]
const REACHED = ["drafting", "processing", "validating", "done"]
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

// The class of a wait in milliseconds. An edge value belongs to the higher
// class. A wait that is negative or not a finite number is a bug upstream, so
// it throws rather than being filed under a class.
export function waitClass(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new RangeError("a wait is a finite, non-negative number of milliseconds")
  if (ms < HOUR_MS) return "lt_1h"
  if (ms < DAY_MS) return "lt_1d"
  if (ms < 7 * DAY_MS) return "lt_7d"
  return "ge_7d"
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
const oneOf = (list, value) => (list.includes(value) ? value : null)
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null)

// The ISO string for a time the card holds (a string) or a YAML reader made
// (a Date); null for anything else.
function timeOf(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value))) return value
  return null
}

function requireTime(value) {
  const iso = value instanceof Date || typeof value === "string" ? timeOf(value) : null
  if (iso === null) throw Object.assign(new Error("the time is not an ISO time"), { code: "invalid_time" })
  return iso
}

function readSignoff(value) {
  if (!isObject(value)) return null
  const state = oneOf(SIGNOFF_STATES, value.state)
  if (state === null) return null
  return {
    state,
    at: timeOf(value.at),
    verified: value.verified === true || value.verified === false ? value.verified : null,
    reason: oneOf(REFUSAL_REASONS, value.reason),
  }
}

function readFlow(value) {
  if (!isObject(value)) return null
  return {
    since: oneOf(FLOW_SINCE, value.since),
    rev: count(value.rev),
    reached: oneOf(REACHED, value.reached),
    first_validating_at: timeOf(value.first_validating_at),
    first_delivered_at: timeOf(value.first_delivered_at),
    delivered_at: timeOf(value.delivered_at),
    deliveries: count(value.deliveries),
  }
}

const keptLine = (line) => typeof line === "string" && line.trim() !== ""

// The readable return lines and a count of what was dropped: a blank or non-string entry, or a value that is present but not a list, counts as one.
function readReturns(value) {
  if (Array.isArray(value)) {
    const lines = value.filter(keptLine)
    return { lines, damaged: value.length - lines.length }
  }
  return { lines: [], damaged: value === undefined || value === null ? 0 : 1 }
}

// `{ signoff, flow, returns, returns_damaged }` from parsed frontmatter. `returns_damaged` counts the `returns` entries that had to be dropped, so a damaged list is never read as an empty one; it adds to the count a record already carries.
export function readRecord(data) {
  const source = isObject(data) ? data : {}
  const { lines, damaged } = readReturns(source.returns)
  return { signoff: readSignoff(source.signoff), flow: readFlow(source.flow), returns: lines, returns_damaged: damaged + (count(source.returns_damaged) ?? 0) }
}

function scalar(raw) {
  const text = raw.trim()
  const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/u.exec(text)
  if (quoted) return quoted[2]
  const bare = text.replace(/\s+#.*$/u, "").trim()
  if (bare === "" || bare === "null" || bare === "~") return null
  if (bare === "true") return true
  if (bare === "false") return false
  if (/^-?\d+$/u.test(bare)) return Number(bare)
  return bare
}

// Splits flow-form text on commas that are not inside quotes.
function splitFlow(text) {
  const parts = []
  let quote = null
  let current = ""
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === ",") {
      parts.push(current)
      current = ""
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.filter((part) => part.trim() !== "")
}

function mapEntry(text) {
  const at = text.indexOf(":")
  return at === -1 ? null : [text.slice(0, at).trim(), scalar(text.slice(at + 1))]
}

function flowMap(text) {
  if (!text.endsWith("}")) return text
  return Object.fromEntries(splitFlow(text.slice(1, -1)).map(mapEntry).filter(Boolean))
}

function blockMap(lines) {
  const out = {}
  let indent = null
  for (const line of lines) {
    const match = /^(\s+)(\S.*)$/u.exec(line)
    if (!match || match[2].startsWith("#")) continue
    indent ??= match[1].length
    if (match[1].length !== indent) continue
    const entry = mapEntry(match[2])
    if (entry) out[entry[0]] = entry[1]
  }
  return out
}

function flowList(text) {
  if (!text.endsWith("]")) return text
  return splitFlow(text.slice(1, -1)).map((part) => scalar(part))
}

function blockList(lines) {
  const out = []
  for (const line of lines) {
    const match = /^\s*-\s*(.*)$/u.exec(line)
    if (match) out.push(scalar(match[1]))
    else if (line.trim() !== "" && !line.trim().startsWith("#")) out.push(null)
  }
  return out
}

// One top-level key from raw frontmatter lines, in the forms the card writer
// and a person's editor produce. Only the first copy of a key is read, as the
// factory's card reader does. A value in any other shape comes back as the
// bare text, which `readRecord` reads as absent.
function topLevel(lines, key, block, flow) {
  const pattern = new RegExp(`^${key}:(.*)$`, "u")
  const at = lines.findIndex((line) => pattern.test(line))
  if (at === -1) return undefined
  const rest = pattern.exec(lines[at])[1].trim().replace(/^#.*$|(?<=[}\]])\s+#.*$/u, "")
  if (rest.startsWith("{") || rest.startsWith("[")) return rest.startsWith("{") ? flowMap(rest) : flowList(rest)
  if (rest !== "") return rest
  const following = []
  for (const line of lines.slice(at + 1)) {
    if (/^[A-Za-z_]/u.test(line)) break
    following.push(line)
  }
  return key === "returns" ? block(following) : flow(following)
}

// One top-level scalar from raw frontmatter lines (`status`, say), read the way `recordFromLines` reads its keys: quotes and trailing comments are dropped. Null when the key is absent or holds anything but a scalar.
export function topLevelScalar(lines, key) {
  const value = topLevel(Array.isArray(lines) ? lines : [], key, blockList, blockMap)
  return typeof value === "string" ? scalar(value) : null
}

// `{ signoff, flow, returns, returns_damaged }` from raw frontmatter lines (the text between the two `---` lines), block or flow form. A line under `returns:` that is not a list item counts as damaged.
export function recordFromLines(lines) {
  const rows = Array.isArray(lines) ? lines : []
  return readRecord({
    signoff: topLevel(rows, "signoff", blockList, blockMap),
    flow: topLevel(rows, "flow", blockList, blockMap),
    returns: topLevel(rows, "returns", blockList, blockMap),
  })
}

// The frontmatter keys a card should carry: only those that exist, in the
// card's order. `returns` is left out when empty.
export function toFrontmatter(record) {
  const out = {}
  const { signoff, flow, returns } = readRecord(record)
  if (signoff) out.signoff = signoff
  if (flow) out.flow = flow
  if (returns.length > 0) out.returns = returns
  return out
}

const startFlow = (reached, deliveries = 0) => ({
  since: "adopted",
  rev: 0,
  reached,
  first_validating_at: null,
  first_delivered_at: null,
  delivered_at: null,
  deliveries,
})

// A card is delivered: it now waits for the human's answer.
export function deliver(record, { at }) {
  const when = requireTime(at)
  const { flow, returns } = readRecord(record)
  const base = flow ?? startFlow("done")
  return {
    signoff: { state: "delivered_unsigned", at: null, verified: null, reason: null },
    flow: {
      ...base,
      rev: (base.rev ?? 0) + 1,
      reached: "done",
      first_validating_at: base.first_validating_at ?? when,
      first_delivered_at: base.first_delivered_at ?? when,
      delivered_at: when,
      deliveries: (base.deliveries ?? 0) + 1,
    },
    returns,
  }
}

const fail = (code, message) => Object.assign(new Error(message), { code })

function checkReasons(outcome, reason, returnReason) {
  const given = (value) => value !== undefined && value !== null
  if (outcome === "accepted") {
    if (given(reason)) throw fail("reason_not_allowed", "an acceptance carries no reason")
    if (given(returnReason)) throw fail("reason_not_allowed", "an acceptance carries no return reason")
    return
  }
  if (!given(reason)) throw fail("reason_required", "a refusal needs the human's reason")
  if (!REFUSAL_REASONS.includes(reason)) throw fail("unknown_reason", "the reason is not one of the listed reasons")
  if (!given(returnReason)) throw fail("return_reason_required", "a refusal needs your own reading of the cause")
  if (!RETURN_REASONS.includes(returnReason)) throw fail("unknown_return_reason", "the return reason is not one of the listed reasons")
}

// The human's answer to a delivery. Evidence may only go up: a call that was
// not witnessed never replaces a witnessed record, and a witnessed call can
// replace one that was not. Saying the same thing again at the same or lower
// evidence changes nothing.
export function sign(record, { status, outcome, reason, returnReason, verified, at }) {
  if (status !== "done") throw fail("not_delivered", "only a delivered task can be signed")
  if (outcome !== "accepted" && outcome !== "refused") throw fail("unknown_outcome", "the outcome is accepted or refused")
  checkReasons(outcome, reason, returnReason)
  const when = requireTime(at)
  const witnessed = verified === true
  const current = readRecord(record)
  const held = current.signoff
  if (held && held.state !== "delivered_unsigned") {
    if (held.state === outcome && (held.verified === true || !witnessed)) return { record: { signoff: current.signoff, flow: current.flow, returns: current.returns }, changed: false }
    if (held.verified === true && !witnessed) throw fail("evidence_lower", "a witnessed record is not replaced by one that was not witnessed")
  }
  const flow = current.flow ?? startFlow("done", 1)
  return {
    record: {
      signoff: { state: outcome, at: when, verified: witnessed, reason: outcome === "refused" ? reason : null },
      flow: { ...flow, rev: (flow.rev ?? 0) + 1 },
      returns: current.returns,
    },
    changed: true,
  }
}

// Where the card's outcome stands. A `done` card with no record is delivered
// before the record existed: never unsigned and never accepted.
export function outcomeState(record, status) {
  const { signoff, flow } = readRecord(record)
  if (status === "done") return signoff ? signoff.state : "not_recorded"
  if ((flow?.deliveries ?? 0) > 0) return signoff?.state === "refused" ? "refused" : "reopened"
  return "not_delivered"
}

// Package F: returns. A return is any status move that sends work back. The rules live in this file so `task_update` and `task_signoff` cannot differ.

export const MAIN_LINE = { drafting: 0, processing: 1, validating: 2, done: 3 }
export const STATUSES = ["drafting", "processing", "validating", "collaborating", "paused", "blocked", "done", "cancelled"]

const isMainLine = (status) => Object.hasOwn(MAIN_LINE, status)

// A move needs a reason when it leaves `done`, or when it lands on a main-line status below the highest one reached since the last return. Side states (`collaborating`, `paused`, `blocked`, `cancelled`) have no rank, so a move into one is never a return unless the card was at `done`. A missing `reached` is read as the status the card is at.
export function needsReturnReason({ from, to, reached }) {
  if (from === to) return false
  if (from === "done") return true
  const held = isMainLine(reached) ? reached : from
  return isMainLine(to) && isMainLine(held) && MAIN_LINE[held] > MAIN_LINE[to]
}

export function catchPoint({ from, reached }) {
  if (from === "done") return "after_delivery"
  return reached === "validating" ? "at_review" : "in_task"
}

const HUMAN_VERIFIED = { verified: true, unverified: false }

// One line of the `returns` list: `<time> <from> <to> <agent reason> <catch point>`, then ` refused=<human reason> <verified|unverified>` for a human refusal. Throws `invalid_return` for an entry that would not read back.
export function formatReturn(entry) {
  const e = isObject(entry) ? entry : {}
  const base = `${e.at} ${e.from} ${e.to} ${e.reason} ${e.caught}`
  const line = e.refusal === null || e.refusal === undefined ? base : `${base} refused=${e.refusal} ${e.refusal_verified === true ? "verified" : "unverified"}`
  if (parseReturn(line) === null) throw fail("invalid_return", "the return entry is not in the listed form")
  return line
}

// The entry a line holds, or null for any line that cannot be read in full.
export function parseReturn(line) {
  if (typeof line !== "string") return null
  const parts = line.split(" ")
  if (parts.length !== 5 && parts.length !== 7) return null
  const [at, from, to, reason, caught, refused, verdict] = parts
  if (typeof timeOf(at) !== "string" || !STATUSES.includes(from) || !STATUSES.includes(to)) return null
  if (!RETURN_REASONS.includes(reason) || !CATCH_POINTS.includes(caught)) return null
  if (from === to || to === "done" || (caught === "after_delivery") !== (from === "done")) return null
  const entry = { at, from, to, reason, caught, refusal: null, refusal_verified: null }
  if (parts.length === 5) return entry
  const human = /^refused=(\S+)$/u.exec(refused)?.[1]
  if (!REFUSAL_REASONS.includes(human) || !Object.hasOwn(HUMAN_VERIFIED, verdict) || from !== "done" || to !== "processing") return null
  return { ...entry, refusal: human, refusal_verified: HUMAN_VERIFIED[verdict] }
}

const knownStatus = (status) => {
  if (!STATUSES.includes(status)) throw fail("unknown_status", "the status is not one of the listed statuses")
}

// A status change. Returns a new record; the input is never changed. Without a status change, or when nothing in the record would change, the input itself comes back. A card with no `flow` gets one, as `adopted`, with `reached` at the status it is at (`drafting` for a side state).
export function move(record, { from, to, at, returnReason }) {
  knownStatus(from)
  knownStatus(to)
  const current = readRecord(record)
  const given = returnReason !== undefined && returnReason !== null
  const flow = current.flow ?? startFlow(isMainLine(from) ? from : "drafting", from === "done" ? 1 : 0)
  const reached = flow.reached ?? (isMainLine(from) ? from : "drafting")
  const needs = needsReturnReason({ from, to, reached })
  if (given && !needs) throw fail("return_reason_not_needed", "this move is not a return and takes no return reason")
  if (from === to) return record
  if (needs && !given) throw fail("return_reason_required", "this move sends work back and needs a return reason")
  if (needs && !RETURN_REASONS.includes(returnReason)) throw fail("unknown_return_reason", "the return reason is not one of the listed reasons")
  const when = requireTime(at)
  const reviewed = to === "validating" || to === "done"
  const marked = { ...flow, reached, first_validating_at: flow.first_validating_at ?? (reviewed ? when : null) }
  if (needs) {
    const line = formatReturn({ at: when, from, to, reason: returnReason, caught: catchPoint({ from, reached }), refusal: null, refusal_verified: null })
    return {
      signoff: from === "done" ? null : current.signoff,
      flow: { ...marked, rev: (flow.rev ?? 0) + 1, reached: isMainLine(to) ? to : "drafting" },
      returns: [...current.returns, line],
    }
  }
  if (to === "done") {
    return deliver({ signoff: current.signoff, flow: marked, returns: current.returns }, { at: when })
  }
  const next = { ...marked, reached: isMainLine(to) && MAIN_LINE[to] > MAIN_LINE[reached] ? to : reached }
  if (current.flow && JSON.stringify(next) === JSON.stringify(flow)) return record
  return { signoff: current.signoff, flow: { ...next, rev: (flow.rev ?? 0) + 1 }, returns: current.returns }
}

// The return a human refusal makes. `task_signoff` calls it after `sign` has written the refusal (without one it throws `not_refused`); `signoff` stays as `sign` left it.
export function refuse(record, { at, reason, returnReason, verified }) {
  checkReasons("refused", reason, returnReason)
  const when = requireTime(at)
  const current = readRecord(record)
  if (current.signoff?.state !== "refused") throw fail("not_refused", "no refusal is recorded on this card")
  const flow = current.flow ?? startFlow("done", 1)
  const line = formatReturn({ at: when, from: "done", to: "processing", reason: returnReason, caught: "after_delivery", refusal: reason, refusal_verified: verified === true })
  return {
    signoff: current.signoff,
    flow: { ...flow, rev: (flow.rev ?? 0) + 1, reached: "processing" },
    returns: [...current.returns, line],
  }
}

// Whether a return counts against first-pass yield: the deciding reason (the human's when a refusal recorded one, else the agent's; a `verified` flag plays no part) is not `changed_ask`, and the return came at review or after delivery, or in the task at or after the first review. The catch point is a recorded fact and needs no milestone; an in-task return with no known first review does not count.
export function returnCounts(entry, firstValidatingAt) {
  const decided = entry.refusal !== null ? entry.refusal : entry.reason
  if (decided === "changed_ask") return false
  if (entry.caught !== "in_task") return true
  const first = timeOf(firstValidatingAt)
  return first !== null && Date.parse(entry.at) >= Date.parse(first)
}

const REASON_CLASS = {
  not_what_was_asked: "ours",
  defect: "ours",
  incomplete: "ours",
  agent_error: "ours",
  changed_ask: "changed",
  new_information: "outside",
  external: "outside",
}

// Do the human's reason and the agent's name the same kind of cause? `null` when either is not comparable (`other`, or off both lists).
export function reasonsAgree(humanReason, agentReason) {
  const human = REASON_CLASS[humanReason]
  const agent = REASON_CLASS[agentReason]
  if (human === undefined || agent === undefined) return null
  return human === agent
}

// The record as the facts carry it. The times are the card's own strings; `delivered_at` falls back to the evidence time only for a card that has been delivered. `returns` lists each readable return as codes and a flag, and `returns_unreadable` counts the lines skipped, so a damaged card never reads as having no returns. A card with no `flow` has no returns recorded.
export function outcomeSnapshot(record, { status, now, evidenceAt }) {
  const read = readRecord(record)
  const state = outcomeState(read, status)
  const flow = read.flow
  const parsed = flow ? read.returns.map(parseReturn) : []
  const entries = parsed.filter(Boolean)
  return {
    rev: flow?.rev ?? 0,
    state,
    verified: read.signoff?.verified ?? null,
    reason: read.signoff?.reason ?? null,
    deliveries: flow?.deliveries ?? 0,
    delivered_at: flow?.delivered_at ?? (state === "not_delivered" ? null : timeOf(evidenceAt)),
    signed_at: read.signoff?.at ?? null,
    observed_at: timeOf(typeof now === "number" && Number.isFinite(now) ? new Date(now) : now),
    since: flow?.since ?? null,
    first_validating_at: flow?.first_validating_at ?? null,
    first_delivered_at: flow?.first_delivered_at ?? null,
    returns: entries.map((entry) => ({
      reason: entry.reason,
      caught: entry.caught,
      counts: returnCounts(entry, flow.first_validating_at),
      refusal: entry.refusal,
      refusal_verified: entry.refusal_verified,
    })),
    returns_unreadable: parsed.length - entries.length + read.returns_damaged,
  }
}
