// The redaction ledger shipped with the plugin (`artifacts/tombstones/tombstones.jsonl`): each row names a document by
// path and content hash that must never be indexed. The search engine and the file search that runs before it starts
// both leave these documents out.
import { promises as fs } from "node:fs"
import * as path from "node:path"

const TOMBSTONE_LEDGER_PATH = path.join("artifacts", "tombstones", "tombstones.jsonl")
const TOMBSTONE_FIELDS = new Set([
  "schema_version",
  "document_path",
  "document_hash",
  "reason",
  "redacted_at",
  "effective_from",
  "artifact_rotation_id",
  "actor",
])
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const HASH_RE = /^sha256:[a-f0-9]{64}$/u

function validateTombstoneRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return ["tombstone row must be an object"]
  }

  const diagnostics = []
  for (const field of TOMBSTONE_FIELDS) {
    if (!Object.hasOwn(row, field)) {
      diagnostics.push(`tombstone row missing ${field}`)
    }
  }
  for (const field of Object.keys(row)) {
    if (!TOMBSTONE_FIELDS.has(field)) {
      diagnostics.push(`tombstone row has unsupported field ${field}`)
    }
  }
  if (Object.hasOwn(row, "schema_version") && row.schema_version !== 1) {
    diagnostics.push("tombstone row schema_version is unsupported")
  }
  if (Object.hasOwn(row, "document_path") && !isNormalizedRelativePath(row.document_path)) {
    diagnostics.push("tombstone row document_path must be a normalized relative path")
  }
  if (Object.hasOwn(row, "document_hash") && !isSha256(row.document_hash)) {
    diagnostics.push("tombstone row document_hash must be a sha256 digest")
  }
  if (Object.hasOwn(row, "reason") && !["deleted", "redacted"].includes(row.reason)) {
    diagnostics.push("tombstone row reason is unsupported")
  }
  if (Object.hasOwn(row, "redacted_at") && !isDateTime(row.redacted_at)) {
    diagnostics.push("tombstone row redacted_at must be a date-time string")
  }
  if (Object.hasOwn(row, "effective_from") && !isDateTime(row.effective_from)) {
    diagnostics.push("tombstone row effective_from must be a date-time string")
  }
  if (Object.hasOwn(row, "artifact_rotation_id") && !hasNonEmptyText(row.artifact_rotation_id)) {
    diagnostics.push("tombstone row artifact_rotation_id must be non-empty text")
  }
  if (Object.hasOwn(row, "actor") && !hasNonEmptyText(row.actor)) {
    diagnostics.push("tombstone row actor must be non-empty text")
  }
  return diagnostics
}

export async function loadTombstoneLedger({ pluginRoot } = {}) {
  if (typeof pluginRoot !== "string" || pluginRoot.trim() === "") {
    return {
      valid: true,
      present: false,
      rows: [],
      diagnostics: [],
      ledger_path: null,
    }
  }
  const ledgerPath = path.join(pluginRoot, TOMBSTONE_LEDGER_PATH)
  let body
  try {
    body = await fs.readFile(ledgerPath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        valid: true,
        present: false,
        rows: [],
        diagnostics: [],
        ledger_path: ledgerPath,
      }
    }
    return invalidLedger({
      diagnostics: ["tombstone ledger file could not be read"],
      ledgerPath,
      present: true,
    })
  }

  const rows = []
  const diagnostics = []
  const lines = body.split(/\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === "") continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      diagnostics.push(`tombstone ledger line ${index + 1} must be valid JSON`)
      continue
    }
    diagnostics.push(...validateTombstoneRow(row))
    rows.push(row)
  }

  if (diagnostics.length > 0) {
    return invalidLedger({ diagnostics, ledgerPath, present: true })
  }
  return {
    valid: true,
    present: true,
    rows,
    diagnostics: [],
    ledger_path: ledgerPath,
  }
}

export function tombstoneDecisionForDoc({ ledger, doc } = {}) {
  if (!ledger?.valid || !Array.isArray(ledger.rows) || !doc) {
    return { tombstoned: false }
  }
  const docHash = canonicalDocumentHash(doc.hash)
  const docPath = typeof doc.path === "string" ? doc.path.replaceAll("\\", "/") : doc.path
  let latest = null
  for (const row of ledger.rows) {
    if (row.document_path === docPath && row.document_hash === docHash) {
      latest = row
    }
  }
  if (!latest) return { tombstoned: false }
  return {
    tombstoned: true,
    reason: latest.reason,
    artifact_rotation_id: latest.artifact_rotation_id,
  }
}

function invalidLedger({ diagnostics, ledgerPath, present }) {
  return {
    valid: false,
    present,
    rows: [],
    diagnostics,
    ledger_path: ledgerPath,
  }
}

function isNormalizedRelativePath(value) {
  if (typeof value !== "string") return false
  if (value.trim() === "" || value !== value.trim()) return false
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false
  if (value.includes("\\") || value.includes("//")) return false
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false
  }
  return path.posix.normalize(value) === value
}

function isSha256(value) {
  return typeof value === "string" && HASH_RE.test(value)
}

function canonicalDocumentHash(value) {
  return String(value).startsWith("sha256:") ? value : `sha256:${value}`
}

function isDateTime(value) {
  if (typeof value !== "string" || !DATE_TIME_RE.test(value)) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  return new Date(parsed).toISOString() === normalizeDateTime(value)
}

function normalizeDateTime(value) {
  return value.includes(".") ? value : value.replace(/Z$/u, ".000Z")
}

function hasNonEmptyText(value) {
  return typeof value === "string" && value.trim() !== ""
}
