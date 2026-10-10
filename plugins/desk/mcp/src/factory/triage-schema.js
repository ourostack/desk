// Additive triage contracts, not a producer. Public bytes contain only closed
// codes and public pointers. Candidate prose is returned only to a protected
// parent; successful candidate validation is NOT permission to store it in Git.
import {
  PATTERNS, addError, arrayField, booleanField, customField, enumField,
  isPlainObject, joinPath, nullableEnumField, objectField, patternField,
  rangeIntField, validateCanonicalBytes, validateObject,
} from "./schema.js"
import { publicPatternField } from "./published-schema.js"
import { isCredentialLike } from "./credential.js"

export const TRIAGE_SCHEMA = "desk.factory.triage/1"
export const TRIAGE_RESULT_SCHEMA = "desk.factory.triage-result/1"
export const TRIAGE_PATH = /^triage\/[0-9a-f]{16}\.json$/u
export const TRIAGE_ROUTES = Object.freeze(["agent_ready", "investigate", "human_decision"])
export const TRIAGE_GATES = Object.freeze(["intent", "scope", "approval", "voice", "spend", "account", "irreversible"])
export const TRIAGE_AUTHORITY_CODES = Object.freeze(["existing_scope", "approved_plan", "investigation_only", "human_gate"])
// Shared with the future Task 6 runner, not its local qualified/blocked record.
export const TRIAGE_RUNNER_STATES = Object.freeze([
  "ran", "no_agent_cli", "unsupported_host", "no_credentials", "disabled_would_bill",
  "sign_in_unknown", "scope_unqualified", "scope_changed", "timeout", "budget_exceeded",
  "failed", "headless_session", "no_time_for_a_run",
])
// Factory modules cannot import the Desk runtime. Parity is tested against the
// canonical exports, as with other existing factory schema vocabularies.
export const TRIAGE_SOURCES = Object.freeze(["andon", "friction_candidate", "reconcile_class", "desk_problem", "store_build", "evaluator", "loop_alarm", "flush_health"])
export const TRIAGE_LIFECYCLES = Object.freeze(["open", "claimed", "shipped", "verifying", "closed_confirmed", "closed_unverified"])
export const TRIAGE_MAX_ROWS = 20
export const TRIAGE_MAX_ROW_BYTES = 16 * 1024
const MAX_BYTES = TRIAGE_MAX_ROWS * TRIAGE_MAX_ROW_BYTES + 4096
const AGE = ["recent", "aging", "stale", "never", "unknown"]
const HEX32 = /^[0-9a-f]{32}$/u
const HEX16 = /^[0-9a-f]{16}$/u
const positive = () => rangeIntField(1, Number.MAX_SAFE_INTEGER)
const nullable = (field) => customField((v, p, e, ctx) => v === null || field.check(v, p, e, ctx))
const version = () => customField((v, p, e) => {
  if (typeof v === "string" && v.length > 64) { addError(e, "size", p); return false }
  return publicPatternField(PATTERNS.semver).check(v, p, e)
})

// Current public issue/PR URL spelling and build.js's jobReportUrl spelling;
// these are syntax gates only. Positive visibility/consent belongs to the
// trusted parent/store, never to a URL-looking untrusted payload.
const REPO = "[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}"
const POINTERS = {
  issue: new RegExp(`^https://github\\.com/${REPO}/issues/[1-9][0-9]{0,9}$`, "u"),
  pr: new RegExp(`^https://github\\.com/${REPO}/pull/[1-9][0-9]{0,9}$`, "u"),
  job: new RegExp(`^https://github\\.com/${REPO}/blob/reports/jobs/[0-9a-f]{32}\\.md$`, "u"),
}
const evidenceField = () => objectField({
  kind: enumField(["issue", "pr", "job"]),
  ref: customField((v, p, e, ctx) => {
    const pattern = POINTERS[ctx?.kind]
    if (!pattern) { addError(e, "pattern", p); return false }
    if (!publicPatternField(pattern).check(v, p, e)) return false
    const [, owner, repo] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//u.exec(v)
    if (isCredentialLike(owner) || isCredentialLike(repo)) { addError(e, "credential_like", p); return false }
    return true
  }),
  revision: positive(),
})
// Pass the sibling kind to the shared walker without a second object checker.
const publicEvidence = () => customField((v, p, e) => evidenceField().check(v, p, e, { kind: v?.kind }))
const evidenceList = () => arrayField(publicEvidence(), 16)
const rowSpec = {
  id: patternField(HEX32),
  revision: positive(),
  state: enumField(["reviewed", "stale", "withdrawn", "source_unknown"]),
  source: enumField(TRIAGE_SOURCES),
  lifecycle: nullableEnumField(TRIAGE_LIFECYCLES),
  ownership: enumField(["claimed", "not_published"]),
  route: nullableEnumField(TRIAGE_ROUTES),
  gate: nullableEnumField(TRIAGE_GATES),
  evidence: evidenceList(),
  basis: objectField({ generation: patternField(HEX32), evidence_revisions: evidenceList() }),
  related_ids: arrayField(patternField(HEX32), 16),
  duplicate_ids: arrayField(patternField(HEX32), 16),
  age: enumField(AGE),
  producer_version: version(),
  rubric_version: positive(),
}
const boundedObject = (spec, post) => customField((v, p, e, ctx) => {
  if (Buffer.byteLength(JSON.stringify(v) ?? "") > TRIAGE_MAX_ROW_BYTES) {
    addError(e, "size", p); return false
  }
  return objectField(spec, post).check(v, p, e, ctx)
})
const publicRow = boundedObject(rowSpec, (v, p, _results, e) => {
  if ((v.state === "reviewed" && v.route === null) ||
      (v.state === "withdrawn" && (v.route !== null || v.gate !== null)) ||
      (v.route === "human_decision" ? v.gate === null : v.gate !== null)) addError(e, "inconsistent", p)
})
const publicSpec = {
  schema: enumField([TRIAGE_SCHEMA]),
  batch: patternField(HEX16),
  producer_version: version(),
  rubric_version: positive(),
  coverage: objectField({
    generation: patternField(HEX32), scan: enumField(["complete", "truncated", "unreadable"]),
    reviewed: nullable(rangeIntField(0, Number.MAX_SAFE_INTEGER)),
    unreviewed: nullable(rangeIntField(0, Number.MAX_SAFE_INTEGER)),
    refused: nullable(rangeIntField(0, Number.MAX_SAFE_INTEGER)),
    deferred: nullable(rangeIntField(0, Number.MAX_SAFE_INTEGER)),
    more_unreviewed: nullable(booleanField()),
  }),
  runner: objectField({ state: enumField(TRIAGE_RUNNER_STATES), last_success_age: enumField(AGE) }),
  rows: arrayField(publicRow, TRIAGE_MAX_ROWS),
}
function bytesGate(bytes, validate) {
  if (typeof bytes !== "string" && !Buffer.isBuffer(bytes)) return { ok: false, errors: [{ code: "type", path: "" }] }
  if (Buffer.byteLength(bytes) > MAX_BYTES) return { ok: false, errors: [{ code: "size", path: "" }] }
  return validateCanonicalBytes(bytes, validate)
}
export function validateTriageBytes(bytes) {
  return bytesGate(bytes, (v) => {
    const errors = []
    validateObject(v, "", publicSpec, errors)
    return { ok: errors.length === 0, errors }
  })
}
export const isTriagePath = (path) => typeof path === "string" && TRIAGE_PATH.test(path)

/** Separate contextual intake gate. Status is normalized by a trusted Git
 * reader: only an added regular blob with no previous blob is eligible.
 * Missing authority is unavailable, not a known stranger or a maintainer.
 */
export function validateTriageChange({ path, status, bytes, previousBytes, trustedMaintainer } = {}) {
  const safePath = isTriagePath(path) ? path : ""
  const errors = []
  if (!isTriagePath(path)) addError(errors, "path", "")
  if (status !== "added" || previousBytes !== undefined) addError(errors, "triage_immutable", safePath)
  if (trustedMaintainer !== true) addError(errors, trustedMaintainer === false ? "triage_untrusted_producer" : "triage_authority_check_unavailable", safePath)
  if (errors.length) return { ok: false, errors }
  const result = validateTriageBytes(bytes)
  if (!result.ok) return { ok: false, errors: result.errors.map((e) => ({ code: e.code, path: safePath })) }
  const value = JSON.parse(bytes.toString())
  if (`triage/${value.batch}.json` !== path) addError(errors, "triage_batch_mismatch", safePath)
  return { ok: errors.length === 0, errors }
}

// Protected strings never enter the public schema or its errors.
const text = () => customField((v, p, e) => {
  if (typeof v !== "string") { addError(e, "type", p); return false }
  if (v.trim() === "" || v.length > 1200) { addError(e, "size", p); return false }
  if (/[\p{Cc}\p{Cf}]/u.test(v)) { addError(e, "control", p); return false }
  return true
})
const textList = () => arrayField(text(), 16)
const resultSpec = {
  key: text(), basis: text(), route: enumField(TRIAGE_ROUTES),
  problem: text(), observed_impact: text(), unknowns: textList(), next_step: text(),
  authority: objectField({ code: enumField(TRIAGE_AUTHORITY_CODES), ruling_ids: textList() }),
  evidence: textList(), related: textList(),
  duplicates: arrayField(objectField({ key: text(), evidence_ids: textList() }), 16),
  decision: nullable(text()), gate_reason: nullableEnumField(TRIAGE_GATES),
  recommendation: nullable(text()), safe_continuation: nullable(text()),
}
const candidateSpec = {
  schema: enumField([TRIAGE_RESULT_SCHEMA]), batch: patternField(HEX16),
  rubric_version: positive(), producer_version: version(),
  // Per-result checks happen independently to preserve valid siblings.
  results: arrayField(customField(() => true), TRIAGE_MAX_ROWS),
}

/** Parent-supplied authorization projection:
 * brief = {batch,producer_version,rubric_version,cards:[{
 *   key,basis,evidence_ids,ruling_ids,authority_codes
 * }]}.
 * The parent resolves IDs and authority before supplying this projection.
 * Additional prepared prose is never interpreted as authorization.
 * Returns {ok,errors,valid,refused}; refused entries are protected
 * {index,result,errors}, not suitable for logs/Git. No content is persisted.
 */
export function validateTriageResultBytes(bytes, { brief } = {}) {
  let candidate
  const top = bytesGate(bytes, (v) => {
    const errors = []
    validateObject(v, "", candidateSpec, errors)
    if (errors.length === 0) candidate = v
    return { ok: errors.length === 0, errors }
  })
  if (!top.ok) return { ...top, valid: [], refused: [] }
  const cards = brief?.cards
  const validBrief = isPlainObject(brief) && Array.isArray(cards) && cards.length <= TRIAGE_MAX_ROWS &&
    cards.every((c) => isPlainObject(c) && typeof c.key === "string" && typeof c.basis === "string" &&
      ["evidence_ids", "ruling_ids", "authority_codes"].every((k) => Array.isArray(c[k]) && c[k].every((id) => typeof id === "string")) &&
      c.authority_codes.every((code) => TRIAGE_AUTHORITY_CODES.includes(code))) &&
    new Set(cards.map((c) => c.key)).size === cards.length
  if (!validBrief || candidate.batch !== brief.batch || candidate.producer_version !== brief.producer_version || candidate.rubric_version !== brief.rubric_version) {
    return { ok: false, errors: [{ code: "triage_brief_mismatch", path: "" }], valid: [], refused: [] }
  }
  const byKey = new Map(cards.map((c) => [c.key, c]))
  const seen = new Set(), valid = [], refused = [], errors = []
  candidate.results.forEach((result, index) => {
    const path = joinPath("results", index), ownErrors = []
    boundedObject(resultSpec).check(result, path, ownErrors)
    if (ownErrors.length === 0) {
      const card = byKey.get(result.key)
      if (!card) addError(ownErrors, "triage_key_unknown", path)
      else {
        if (result.basis !== card.basis) addError(ownErrors, "triage_basis_mismatch", path)
        if (!card.authority_codes.includes(result.authority.code) || result.authority.ruling_ids.some((id) => !card.ruling_ids.includes(id)) ||
            (["existing_scope","approved_plan"].includes(result.authority.code) && result.authority.ruling_ids.length === 0)) addError(ownErrors, "triage_authority_unproved", path)
        if (result.evidence.some((id) => !card.evidence_ids.includes(id)) || result.related.some((key) => !byKey.has(key) || key === result.key)) addError(ownErrors, "triage_evidence_unknown", path)
        for (const duplicate of result.duplicates) {
          const other = byKey.get(duplicate.key)
          if (!other || duplicate.key === result.key || duplicate.evidence_ids.length === 0 ||
              duplicate.evidence_ids.some((id) => !card.evidence_ids.includes(id) || !other.evidence_ids.includes(id) || !result.evidence.includes(id))) addError(ownErrors, "triage_duplicate_unproved", path)
        }
      }
      if (seen.has(result.key)) addError(ownErrors, "duplicate", path)
      seen.add(result.key)
      const human = result.route === "human_decision"
      if ((human ? result.authority.code !== "human_gate" : result.authority.code === "human_gate") ||
          (result.route === "agent_ready" && !["existing_scope","approved_plan"].includes(result.authority.code)) ||
          ["decision","gate_reason","recommendation","safe_continuation"].some((k) => human ? result[k] === null : result[k] !== null)) addError(ownErrors, "triage_route_fields", path)
    }
    if (ownErrors.length) { errors.push(...ownErrors); refused.push({ index, result, errors: ownErrors }) }
    else valid.push(result)
  })
  return { ok: errors.length === 0, errors, valid, refused }
}
