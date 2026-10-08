// The store's intake gate. A pull request may add or modify two kinds of
// data file, and a trusted maintainer may also delete them (a retraction: a
// session whose desk now routes to another store), and nothing else:
//   - published facts at `facts/<host>-<session id>.json`, and
//   - published labels at `labels/<job>/<session id>.json` (`label-schema.js`),
//     each checked against that session's facts file, which the caller reads
//     from the tree the merge would leave (see `scripts/factory.js`) and passes
//     in as `facts: [{ path, bytes }]`. A modified labels file also needs its
//     `previousBytes`: a replacement must come from an evaluator whose plugin
//     version and rubric are both no lower (else `evaluator_downgrade`).
//   - the machine's capture record at `capture/<intake id>.json`
//     (`capture-schema.js`): checked on its own bytes, with no rule against the
//     bytes it replaces (counts may fall, which is the alarm).
// A facts file's job finish days (`jobs[].finished_on`, `desk.factory.published/4`)
// may not be after the UTC day the gate runs (`future`): `now`, in
// milliseconds since 1970, defaults to the clock, and a value that is not a
// finite number is refused at `now` rather than skipping the check.
// A delete is accepted only when the caller says the author is a trusted
// maintainer (`trustedMaintainer: true`; `scripts/factory.js` derives it from
// the author association), else it is `removal`. It must be at one of those
// path shapes (any other path is `removal_path`), has no content to validate,
// and a rename stays refused.
// Every value arrives as bytes and is only parsed as JSON, never loaded or
// run, and errors carry only stable codes and safe paths.
import { CAPTURE_PATH, validateCaptureBytes } from "../capture-schema.js"
import { checkLabelsAgainstFacts, evaluatorDowngrade, validateLabelsBytes } from "../label-schema.js"
import { validatePublishedBytes } from "../published-schema.js"

const FACT_HOSTS = Object.freeze(["claude-code", "copilot-cli", "codex-cli"])
const SESSION_ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const FACT_PATH = new RegExp(`^facts/(${FACT_HOSTS.join("|")})-(${SESSION_ID})\\.json$`, "u")
const LABEL_PATH = new RegExp(`^labels/([0-9a-f]{32})/(${SESSION_ID})\\.json$`, "u")
const STATUSES = new Set(["added", "modified"])
const MAX_CHANGES = 500

function error(code, path) {
  return { code, path }
}

function parseBytes(bytes, validateBytes) {
  try {
    const validation = validateBytes(bytes)
    if (!validation.ok) return { validation }
    const text = typeof bytes === "string" ? bytes : bytes.toString("utf8")
    return { validation, value: JSON.parse(text) }
  } catch {
    return { validation: { ok: false, errors: [error("type", "")] } }
  }
}

const parsePublished = (bytes) => parseBytes(bytes, validatePublishedBytes)

export function isFactsPath(value) {
  return typeof value === "string" && FACT_PATH.test(value)
}

export function isCapturePath(value) {
  return typeof value === "string" && CAPTURE_PATH.test(value)
}

/** `{ job, session }` from an exact `labels/<job>/<session id>.json` path, else `null`. */
export function labelsPathParts(value) {
  const match = typeof value === "string" ? LABEL_PATH.exec(value) : null
  return match === null ? null : { job: match[1], session: match[2] }
}

/** Every path a session's published facts file may have, one per host. */
export function factsPathsForSession(sessionId) {
  return FACT_HOSTS.map((host) => `facts/${host}-${sessionId}.json`)
}

// A labels file: its own gate, its path identity, the replacement rule, then
// exactly one sound facts file for its session, then the evidence against
// that file. Labels that declare `facts_missing` carry no stretches, so they
// need no facts file; when one exists it is still checked.
function validateLabelsChange(change, parts, safePath) {
  const current = parseBytes(change.bytes, validateLabelsBytes)
  if (!current.validation.ok) return current.validation.errors.map((item) => error(item.code, safePath))
  const errors = []
  if (current.value.job !== parts.job) errors.push(error("job_mismatch", safePath))
  if (current.value.session !== parts.session) errors.push(error("session_mismatch", safePath))
  if (errors.length > 0) return errors

  if (change.status === "modified") {
    if (change.previousBytes === undefined) return [error("previous_missing", safePath)]
    const previous = parseBytes(change.previousBytes, validateLabelsBytes)
    if (!previous.validation.ok) return [error("previous_invalid", safePath)]
    if (evaluatorDowngrade(previous.value, current.value)) return [error("evaluator_downgrade", safePath)]
  }

  const facts = change.facts
  const allowed = new Set(factsPathsForSession(parts.session))
  if (!Array.isArray(facts) || facts.some((entry) => entry === null || typeof entry !== "object" || !allowed.has(entry.path))) {
    return [error("type", safePath)]
  }
  if (facts.length === 0) return current.value.unavailable.includes("facts_missing") ? [] : [error("facts_missing", safePath)]
  if (facts.length > 1) return [error("facts_ambiguous", safePath)]
  const factsMatch = FACT_PATH.exec(facts[0].path)
  const parsed = parsePublished(facts[0].bytes)
  if (!parsed.validation.ok || parsed.value.session.host !== factsMatch[1] || parsed.value.session.id !== factsMatch[2]) {
    return [error("facts_invalid", safePath)]
  }
  return checkLabelsAgainstFacts(current.value, parsed.value).errors.map((item) => error(item.code, safePath))
}

// The UTC day of `now` as `YYYY-MM-DD`, or `null` when `now` is not a usable instant.
function utcDay(now) {
  if (typeof now !== "number" || !Number.isFinite(now)) return null
  const date = new Date(now)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

// Whether any job of a sound facts value finished after `today`. Both are `YYYY-MM-DD`, so text order is day order.
const finishedAfter = (facts, today) => facts.jobs.some((job) => typeof job.finished_on === "string" && job.finished_on > today)

export function validatePr(input) {
  const changes = input?.changes
  if (!Array.isArray(changes)) return { ok: false, errors: [error("type", "changes")] }
  if (changes.length > MAX_CHANGES) return { ok: false, errors: [error("too_many_changes", "changes")] }
  const today = utcDay(input.now === undefined ? Date.now() : input.now)
  if (today === null) return { ok: false, errors: [error("type", "now")] }

  const trusted = input.trustedMaintainer === true
  const errors = []
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]
    if (change === null || typeof change !== "object" || Array.isArray(change)) {
      errors.push(error("type", `changes.${index}`))
      continue
    }

    const match = typeof change.path === "string" ? FACT_PATH.exec(change.path) : null
    const labels = labelsPathParts(change.path)
    const capture = isCapturePath(change.path)
    if (match === null && labels === null && !capture) {
      errors.push(error(change.status === "removed" ? "removal_path" : "path", `changes.${index}`))
      continue
    }
    const safePath = change.path
    if (change.status === "removed") {
      if (!trusted) errors.push(error("removal", safePath))
      continue
    }
    if (!STATUSES.has(change.status)) {
      errors.push(error("status", safePath))
      continue
    }

    if (capture) {
      const validation = validateCaptureBytes(change.bytes)
      for (const item of validation.errors) errors.push(error(item.code, safePath))
      continue
    }

    if (labels !== null) {
      errors.push(...validateLabelsChange(change, labels, safePath))
      continue
    }

    const current = parsePublished(change.bytes)
    if (!current.validation.ok) {
      for (const item of current.validation.errors) errors.push(error(item.code, safePath))
      continue
    }
    if (current.value.session.host !== match[1]) errors.push(error("host_mismatch", safePath))
    if (current.value.session.id !== match[2]) errors.push(error("session_mismatch", safePath))
    if (finishedAfter(current.value, today)) errors.push(error("future", safePath))

    if (change.status !== "modified") continue
    if (change.previousBytes === undefined) {
      errors.push(error("previous_missing", safePath))
      continue
    }
    const previous = parsePublished(change.previousBytes)
    if (!previous.validation.ok) {
      errors.push(error("previous_invalid", safePath))
      continue
    }
    if (current.value.session.host !== previous.value.session.host || current.value.session.id !== previous.value.session.id) {
      errors.push(error("identity_changed", safePath))
    } else if (current.value.session.duration_ms < previous.value.session.duration_ms) {
      errors.push(error("duration_decreased", safePath))
    }
  }
  return { ok: errors.length === 0, errors }
}
