import { validatePublishedBytes } from "../published-schema.js"

const FACT_PATH = /^facts\/(claude-code|copilot-cli)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u
const STATUSES = new Set(["added", "modified"])
const MAX_CHANGES = 500

function error(code, path) {
  return { code, path }
}

function parsePublished(bytes) {
  try {
    const validation = validatePublishedBytes(bytes)
    if (!validation.ok) return { validation }
    const text = typeof bytes === "string" ? bytes : bytes.toString("utf8")
    return { validation, value: JSON.parse(text) }
  } catch {
    return { validation: { ok: false, errors: [error("type", "")] } }
  }
}

export function isFactsPath(value) {
  return typeof value === "string" && FACT_PATH.test(value)
}

export function validatePr(input) {
  const changes = input?.changes
  if (!Array.isArray(changes)) return { ok: false, errors: [error("type", "changes")] }
  if (changes.length > MAX_CHANGES) return { ok: false, errors: [error("too_many_changes", "changes")] }

  const errors = []
  changes.forEach((change, index) => {
    if (change === null || typeof change !== "object" || Array.isArray(change)) {
      errors.push(error("type", `changes.${index}`))
      return
    }

    const match = typeof change.path === "string" ? FACT_PATH.exec(change.path) : null
    if (match === null) {
      errors.push(error("path", `changes.${index}`))
      return
    }
    const safePath = change.path
    if (change.status === "removed") {
      errors.push(error("removal", safePath))
      return
    }
    if (!STATUSES.has(change.status)) {
      errors.push(error("status", safePath))
      return
    }

    const current = parsePublished(change.bytes)
    if (!current.validation.ok) {
      for (const item of current.validation.errors) errors.push(error(item.code, safePath))
      return
    }
    if (current.value.session.host !== match[1]) errors.push(error("host_mismatch", safePath))
    if (current.value.session.id !== match[2]) errors.push(error("session_mismatch", safePath))

    if (change.status !== "modified") return
    if (change.previousBytes === undefined) {
      errors.push(error("previous_missing", safePath))
      return
    }
    const previous = parsePublished(change.previousBytes)
    if (!previous.validation.ok) {
      errors.push(error("previous_invalid", safePath))
      return
    }
    if (current.value.session.host !== previous.value.session.host || current.value.session.id !== previous.value.session.id) {
      errors.push(error("identity_changed", safePath))
    } else if (current.value.session.duration_ms < previous.value.session.duration_ms) {
      errors.push(error("duration_decreased", safePath))
    }
  })
  return { ok: errors.length === 0, errors }
}
