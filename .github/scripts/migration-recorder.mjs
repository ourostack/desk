export const MIGRATION_RECORDER_MARKER = "[desk-migration-recorder]"
export const RECORDER_MAX_EVENTS = 128
export const RECORDER_MAX_BYTES = 32_768
export const COLLECTOR_MAX_EVENTS = 256
export const COLLECTOR_MAX_BYTES = 65_536

const reasons = new Set([
  "event-limit", "byte-limit", "unexpected-case", "source-mismatch", "unpatchable-handle",
  "source-unreadable", "unexpected-source-path", "unexpected-source-command",
  "clock-invalid",
])
const labels = {
  "run-block": new Set(["exit-output", "descendant-timeout", "missing-bash", "windows-descendants", "bounded-output"]),
  budget: new Set(["01-slow-detect:detect", "02-slow-check:detect", "03-slow-migrate:detect", "02-slow-check:safety-check", "03-slow-migrate:safety-check", "03-slow-migrate:migrate"]),
}
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
const identity = (value) => Number.isSafeInteger(value) && value > 0
const boolean = (value) => typeof value === "boolean"
const oneOf = (...values) => (value) => values.includes(value)
const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
const shape = (value, fields) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(fields).length && Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
const streamFields = { endObserved: boolean, closeObserved: boolean }
const processFields = {
  spawnObserved: boolean, exitObserved: boolean, closeObserved: boolean,
  stdout: (value) => shape(value, streamFields), stderr: (value) => shape(value, streamFields),
}
const facts = (value, context) => shape(value, {
  child: (child) => shape(child, processFields),
  helper: (helper) => context === "budget" ? helper === "UNOBSERVED" : shape(helper, {
    ...processFields, entryObserved: boolean, returnObserved: boolean, callbackObserved: boolean, callbackReturnedObserved: boolean,
  }),
})
const eventDetails = {
  case: { sourceSha256: sha, sourceMatched: oneOf(true, false, "UNOBSERVED"), timeoutMs: (value) => finite(value) || value === "UNOBSERVED" },
  "spawn-entry": {
    commandSha256: sha, argsSha256: sha,
    options: (value) => shape(value, {
      detached: boolean, stdio: (stdio) => Array.isArray(stdio) && JSON.stringify(stdio) === '["ignore","pipe","pipe"]',
      windowsHide: boolean, envIdentity: identity, cwdIdentity: identity,
    }),
  },
  "spawn-return": {},
  "helper-entry": {
    commandSha256: sha, argsSha256: sha,
    options: (value) => shape(value, { timeoutMs: finite, killSignal: oneOf("SIGKILL"), maxBuffer: finite, encoding: oneOf("utf8"), windowsHide: boolean }),
  },
  "helper-return": {},
  "helper-callback": { success: boolean },
  "helper-callback-return": {},
  "destroy-entry": { stream: oneOf("child.stdout", "child.stderr", "helper.stdout", "helper.stderr") },
  "promise-settled": { outcome: oneOf("fulfilled", "rejected"), boundary: oneOf("block", "context") },
  "source-after-promise": { boundary: oneOf("block", "context"), present: oneOf(true, false, "UNOBSERVED", "NOT_APPLICABLE") },
  "observer-release": {},
  "transport-throw": { operation: oneOf("spawn", "exec-file", "callback", "run-block") },
  "budget-options": { budgetMs: finite, blockLimitMs: finite },
  unqualified: { reason: (value) => reasons.has(value) },
  overflow: { reason: oneOf("event-limit", "byte-limit") },
}
for (const role of ["child", "helper"]) {
  for (const event of ["spawn", "exit", "close"]) eventDetails[`${role}-${event}`] = {}
  for (const stream of ["stdout", "stderr"]) for (const event of ["end", "close"]) eventDetails[`${role}-${stream}-${event}`] = {}
}

function validRecord(record) {
  if (!shape(record, {
    version: oneOf(1), context: (value) => typeof value === "string" && Object.hasOwn(labels, value),
    qualification: oneOf("QUALIFIED", "UNQUALIFIED"), reason: (value) => value === null || reasons.has(value),
    events: Array.isArray,
  })) return false
  if ((record.qualification === "QUALIFIED") !== (record.reason === null) || record.events.length > RECORDER_MAX_EVENTS) return false
  if (record.qualification === "QUALIFIED" && (!record.events.some((event) => event?.event === "case") || !record.events.some((event) => event?.event === "promise-settled"))) return false
  let previousMs = 0
  return record.events.every((event, index) => {
    if (event === null || typeof event !== "object" || typeof event.event !== "string" || !Object.hasOwn(eventDetails, event.event)) return false
    const fields = {
      n: (value) => value === index + 1,
      ms: (value) => finite(value) && value >= previousMs,
      case: (value) => value === "context" || labels[record.context].has(value),
      event: oneOf(event.event),
      ...eventDetails[event.event],
      ...(event.event === "destroy-entry" ? { facts: (value) => facts(value, record.context) } : {}),
    }
    if (!shape(event, fields)) return false
    if (record.qualification === "QUALIFIED" && (event.event === "unqualified" || event.event === "overflow" || event.sourceMatched === false)) return false
    previousMs = event.ms
    return true
  })
}

// Only this file's fixed marker is admitted to results.json. Arbitrary TAP is never forwarded.
export function collectMigrationRecorder(output, file) {
  if (file !== "runtime/pending_migrations.test.js") return undefined
  const records = []
  const issues = new Set()
  let bytes = 0
  let events = 0
  for (const match of output.matchAll(/^\s*# \[desk-migration-recorder\]([^\r\n]*)/gmu)) {
    const text = match[1]
    if (text.length > RECORDER_MAX_BYTES || Buffer.byteLength(text) > RECORDER_MAX_BYTES) {
      issues.add("record-byte-limit")
      continue
    }
    let record
    try { record = JSON.parse(text) } catch {
      issues.add("malformed-json")
      continue
    }
    if (Array.isArray(record?.events) && record.events.length > RECORDER_MAX_EVENTS) {
      issues.add("record-event-limit")
      continue
    }
    if (!validRecord(record)) {
      issues.add("invalid-schema")
      continue
    }
    if (records.some((prior) => prior.context === record.context)) {
      issues.add("duplicate-context")
      continue
    }
    const size = Buffer.byteLength(text)
    if (bytes + size > COLLECTOR_MAX_BYTES - 1024 || events + record.events.length > COLLECTOR_MAX_EVENTS) {
      issues.add("aggregate-limit")
      continue
    }
    records.push(record)
    bytes += size
    events += record.events.length
    if (record.qualification === "UNQUALIFIED") issues.add("recorder-unqualified")
  }
  if (records.length !== 2) issues.add("missing-context")
  return {
    qualification: issues.size === 0 ? "QUALIFIED" : "UNQUALIFIED",
    scope: "observations-only-not-native-cause",
    issues: [...issues], records,
  }
}
