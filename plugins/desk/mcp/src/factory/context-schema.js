// Public explanations are separate from numerical facts. The privacy verdict is
// an independent judgment bound to these exact bytes, not a semantic guarantee.
import { createHash } from "node:crypto"
import {
  PATTERNS, addError, arrayField, customField, enumField,
  nullableObjectField, objectField, patternField, rangeIntField, validateCanonicalBytes, validateObject,
} from "./schema.js"
import { SESSION_ID_V4, validatePublished } from "./published-schema.js"
import { normalizePublished, stableStringify } from "./pipeline/normalize.js"

export const CONTEXT_SCHEMA = "desk.factory.context/1"
export const CONTEXT_PATH = /^context\/([0-9a-f]{32})\.json$/u
export const CONTEXT_MAX_BYTES = 128 * 1024
const SHA256 = /^[0-9a-f]{64}$/u
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:-(?:alpha|beta|rc)\.[0-9]{1,4})?$/u
const hash = (value) => createHash("sha256").update(stableStringify(value)).digest("hex")
const answer = (errors) => ({ ok: errors.length === 0, errors })

const UNSAFE = [
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u,
  /[<>`{}]/u,
  /(?:https?:\/\/|file:|www\.|[A-Z]:\\|~\/|(?:^|\s)\/[A-Za-z])/iu,
  /[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+/u,
  /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/u,
  /(?:gh[pousr]_|github_pat_|(?:^|[^A-Za-z0-9])sk-|Bearer\s|-----BEGIN|(?:password|secret|token)\s*[:=])/iu,
  /\b[0-9a-f]{24,}\b/iu,
  /(?:\+?\d[\d ().-]{8,}\d)/u,
]
function textField(max) {
  return customField((value, path, errors) => {
    if (value === null) return true
    if (typeof value !== "string") { addError(errors, "type", path); return false }
    if (value.length === 0 || [...value].length > max || value.trim() !== value) { addError(errors, "range", path); return false }
    if (UNSAFE.some((pattern) => pattern.test(value))) { addError(errors, "unsafe_text", path); return false }
    return true
  })
}
const VERSION_SPEC = { plugin_version: patternField(VERSION), rubric: enumField(["1"]) }
const SOURCE_SPEC = { session: patternField(SESSION_ID_V4), sha256: patternField(SHA256) }
const RANGE = customField((value, path, errors) => {
  if (value === null) return true
  if (!Array.isArray(value) || value.length !== 2 || !value.every((number) => Number.isSafeInteger(number) && number >= 0) || value[1] <= value[0]) {
    addError(errors, "range", path)
    return false
  }
  return true
})
const REF_SPEC = {
  session: patternField(SESSION_ID_V4), source: patternField(SHA256),
  anchor: enumField(["interval", "start", "end", "interval_start", "interval_end", "share_start", "share_end"]), range: RANGE,
}
const EVENT_SPEC = {
  id: patternField(/^[0-9a-f]{16}$/u),
  kind: enumField(["work", "waiting", "result"]),
  lean: enumField(["value", "support", "waiting", "unknown"]),
  explanation: textField(240),
  reason: textField(160), prerequisite: textField(160), resumption: textField(160),
  confidence: enumField(["high", "medium", "low"]),
  evidence: arrayField(objectField(REF_SPEC), 8),
}
const TOP = {
  schema: enumField([CONTEXT_SCHEMA]), job: patternField(PATTERNS.jobId),
  evaluator: objectField(VERSION_SPEC),
  state: enumField(["published", "withheld", "unavailable"]),
  heading: textField(120),
  events: arrayField(objectField(EVENT_SPEC), 64),
  sources: arrayField(objectField(SOURCE_SPEC), 512),
  coverage: objectField({
    state: enumField(["measured", "partial", "unavailable"]),
    reasons: arrayField(enumField(["not_recorded", "withheld", "omitted", "unplaced", "review_pending"]), 5),
    omitted_events: rangeIntField(0, 1000000),
  }),
  privacy: nullableObjectField({
    verdict: enumField(["approved", "not_required"]),
    payload_sha256: patternField(SHA256),
    reviewer: nullableObjectField(VERSION_SPEC),
  }),
}

/** Hash the exact proposed public payload, excluding only its privacy verdict. */
export function contextPayloadHash(value) {
  const { privacy: _privacy, ...payload } = value
  return hash(payload)
}

/** Validate a candidate's closed shape; publication additionally requires its bound review. */
export function validateContext(value, { candidate = false } = {}) {
  const errors = []
  validateObject(value, "", TOP, errors)
  if (errors.length > 0) return answer(errors)
  if (Buffer.byteLength(JSON.stringify(value)) > CONTEXT_MAX_BYTES) return answer([{ code: "too_large", path: "" }])
  if (value.privacy === null) {
    if (!candidate) addError(errors, "review_missing", "privacy")
  } else {
    if (value.privacy.payload_sha256 !== contextPayloadHash(value)) addError(errors, "review_mismatch", "privacy")
    if (value.privacy.verdict === "approved" && value.privacy.reviewer === null) addError(errors, "inconsistent", "privacy")
    if (value.privacy.verdict === "not_required" && (value.state === "published" || value.heading !== null ||
        value.events.length > 0 || value.privacy.reviewer !== null)) addError(errors, "inconsistent", "privacy")
  }
  const { state, reasons, omitted_events: omitted } = value.coverage
  if ((state === "measured" && (reasons.length > 0 || omitted > 0)) ||
      (state !== "measured" && reasons.length === 0) ||
      (omitted > 0 && (state !== "partial" || !reasons.includes("omitted"))) ||
      (omitted === 0 && reasons.includes("omitted"))) addError(errors, "inconsistent", "coverage")
  if (new Set(reasons).size !== reasons.length) addError(errors, "duplicate", "coverage.reasons")
  if (reasons.includes("review_pending") && value.state !== "unavailable") addError(errors, "inconsistent", "coverage")
  if (omitted > 0 && value.events.at(-1)?.kind !== "result") addError(errors, "inconsistent", "events")
  if (value.state === "published") {
    if (value.events.length === 0 || value.sources.length === 0 || state === "unavailable") addError(errors, "inconsistent", "state")
  } else if (value.heading !== null || value.events.length > 0 || state !== "unavailable" ||
      !(value.state === "withheld" ? reasons.includes("withheld") : reasons.includes("not_recorded") || reasons.includes("review_pending"))) addError(errors, "inconsistent", "state")
  const sources = new Map()
  for (const [index, source] of value.sources.entries()) {
    if (sources.has(source.session)) addError(errors, "duplicate", `sources.${index}`)
    sources.set(source.session, source.sha256)
  }
  const ids = new Set()
  for (const [index, event] of value.events.entries()) {
    const at = `events.${index}`
    if (ids.has(event.id)) addError(errors, "duplicate", `${at}.id`)
    ids.add(event.id)
    if (event.explanation === null || event.evidence.length === 0) addError(errors, "inconsistent", at)
    if (event.kind === "waiting") {
      if (event.lean !== "waiting" || event.reason === null || event.prerequisite === null) addError(errors, "inconsistent", at)
    } else if (event.lean === "waiting" || event.reason !== null || event.prerequisite !== null || event.resumption !== null) addError(errors, "inconsistent", at)
    for (const [refIndex, ref] of event.evidence.entries()) {
      const refPath = `${at}.evidence.${refIndex}`
      if (sources.get(ref.session) !== ref.source) addError(errors, "source_unmatched", refPath)
      if (!["start", "end"].includes(ref.anchor) !== (ref.range !== null)) addError(errors, "inconsistent", refPath)
    }
  }
  return answer(errors)
}

export function validateContextBytes(bytes) {
  if (!(typeof bytes === "string" || Buffer.isBuffer(bytes))) return answer([{ code: "type", path: "" }])
  if (Buffer.byteLength(bytes) > CONTEXT_MAX_BYTES) return answer([{ code: "too_large", path: "" }])
  return validateCanonicalBytes(bytes, validateContext)
}

/** Only public clock, binding and outcome evidence affects freshness, never model/token totals. */
export function contextSource(facts, job) {
  if (!validatePublished(facts).ok || !facts.jobs.some((entry) => entry.job === job)) throw new TypeError("contextSource: valid bound published facts required")
  const normalized = normalizePublished(facts)
  return {
    session: normalized.session.id,
    sha256: hash({
      session: normalized.session,
      binding: normalized.jobs.find((entry) => entry.job === job),
      intervals: normalized.intervals,
      outcomes: normalized.outcomes?.filter((entry) => entry.job === job) ?? [],
      unavailable: normalized.unavailable,
    }),
  }
}

export function contextShare(facts, job) {
  const binding = facts.jobs.find((entry) => entry.job === job)
  if (Object.hasOwn(binding, "segments")) return binding.segments
  return !Object.hasOwn(binding, "agents") && facts.jobs.length === 1 ? [{ start_ms: 0, end_ms: facts.session.duration_ms }] : []
}

/** Recheck every source and anchor against the actual store facts, not an evaluator's copy. */
export function checkContextAgainstFacts(value, facts, options) {
  const checked = validateContext(value, options)
  if (!checked.ok) return checked
  if (!Array.isArray(facts)) return answer([{ code: "type", path: "sources" }])
  const errors = []
  const bySession = new Map()
  if (value.state === "published" && facts.some((item) => item?.jobs?.some((entry) => entry.job === value.job) &&
      !value.sources.some((source) => source.session === item.session?.id))) addError(errors, "source_set_changed", "sources")
  for (const [index, source] of value.sources.entries()) {
    const matches = facts.filter((item) => item?.session?.id === source.session)
    const at = `sources.${index}`
    if (matches.length !== 1) { addError(errors, matches.length === 0 ? "facts_missing" : "facts_ambiguous", at); continue }
    const item = matches[0]
    if (!validatePublished(item).ok) { addError(errors, "facts_invalid", at); continue }
    if (!item.jobs.some((entry) => entry.job === value.job)) { addError(errors, "job_mismatch", at); continue }
    if (contextSource(item, value.job).sha256 !== source.sha256) { addError(errors, "source_changed", at); continue }
    bySession.set(source.session, item)
  }
  for (const [index, event] of value.events.entries()) {
    if (event.kind === "waiting" && !event.evidence.some((ref) => ref.anchor === "interval")) {
      const paired = event.evidence.some((end) => ["end", "interval_end", "share_end"].includes(end.anchor) && event.evidence.some((start) => {
        if (!["start", "interval_start", "share_start"].includes(start.anchor)) return false
        const left = bySession.get(end.session)
        const right = bySession.get(start.session)
        if (!left || !right) return false
        const from = left.jobs.find((entry) => entry.job === value.job).session_offset_ms
        const to = right.jobs.find((entry) => entry.job === value.job).session_offset_ms
        const endAt = end.range === null ? left.session.duration_ms : end.range[1]
        const startAt = start.range === null ? 0 : start.range[0]
        if (start.session === end.session) return endAt < startAt
        return from === null || to === null || from + endAt < to + startAt
      }))
      if (!paired) addError(errors, "evidence_unmatched", `events.${index}.evidence`)
    }
    for (const [refIndex, ref] of event.evidence.entries()) {
      const item = bySession.get(ref.session)
      if (!item) continue
      const at = `events.${index}.evidence.${refIndex}`
      const share = contextShare(item, value.job)
      if (item.jobs.find((entry) => entry.job === value.job).session_offset_ms === null &&
          !(value.coverage.state === "partial" && value.coverage.reasons.includes("unplaced"))) addError(errors, "placement_unknown", at)
      if (["interval", "interval_start", "interval_end"].includes(ref.anchor)) {
        const interval = item.intervals.find((entry) => entry.start_ms === ref.range[0] && entry.end_ms === ref.range[1])
        if (!interval || (ref.anchor === "interval" && event.kind === "waiting" && !["human_wait", "permission_wait", "api_retry"].includes(interval.kind))) addError(errors, "evidence_unmatched", at)
        if (!share.some((span) => ref.range[0] >= span.start_ms && ref.range[1] <= span.end_ms)) addError(errors, "outside_share", at)
      } else if (["share_start", "share_end"].includes(ref.anchor)) {
        if (!share.some((span) => span.start_ms === ref.range[0] && span.end_ms === ref.range[1])) addError(errors, "evidence_unmatched", at)
      } else {
        if (ref.anchor === "end" && item.session.ended !== true) addError(errors, "evidence_unmatched", at)
        const boundary = ref.anchor === "start" ? 0 : item.session.duration_ms
        if (!share.some((span) => boundary >= span.start_ms && boundary <= span.end_ms)) addError(errors, "outside_share", at)
      }
    }
  }
  return answer(errors)
}
