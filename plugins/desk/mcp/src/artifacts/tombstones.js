// The redaction ledger shipped with the plugin (`artifacts/tombstones/tombstones.jsonl`): each row names a document by
// path and content hash that must never be indexed. The search engine and the file search that runs before it starts
// both leave these documents out.
import { promises as fs } from "node:fs"
import * as path from "node:path"

const TOMBSTONE_LEDGER_PATH = path.join("artifacts", "tombstones", "tombstones.jsonl")
const HASH_RE = /^sha256:[a-f0-9]{64}$/u

/**
 * The ledger's rows. A missing plugin root or ledger file means no rows. An unreadable or malformed ledger throws
 * `artifact_tombstone_ledger_invalid`, so search never runs without the redactions it was meant to apply.
 */
export async function loadTombstoneLedger({ pluginRoot } = {}) {
  if (typeof pluginRoot !== "string" || pluginRoot.trim() === "") return []
  let body
  try {
    body = await fs.readFile(path.join(pluginRoot, TOMBSTONE_LEDGER_PATH), "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw invalidLedger(["tombstone ledger file could not be read"])
  }
  const rows = []
  const diagnostics = []
  for (const [index, line] of body.split("\n").entries()) {
    if (line.trim() === "") continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      diagnostics.push(`tombstone ledger line ${index + 1} must be valid JSON`)
      continue
    }
    if (!isNormalizedRelativePath(row?.document_path) || typeof row.document_hash !== "string" || !HASH_RE.test(row.document_hash)) {
      diagnostics.push(`tombstone ledger line ${index + 1} must name a normalized relative document_path and a sha256 document_hash`)
      continue
    }
    rows.push(row)
  }
  if (diagnostics.length > 0) throw invalidLedger(diagnostics)
  return rows
}

/** True when a ledger row names this document's path (either slash) and content hash. */
export function isTombstoned(rows, doc) {
  const docPath = doc.path.replaceAll("\\", "/")
  const docHash = doc.hash.startsWith("sha256:") ? doc.hash : `sha256:${doc.hash}`
  return rows.some((row) => row.document_path === docPath && row.document_hash === docHash)
}

function invalidLedger(diagnostics) {
  const error = new Error("artifact tombstone ledger is invalid")
  error.code = "artifact_tombstone_ledger_invalid"
  error.diagnostics = diagnostics
  return error
}

function isNormalizedRelativePath(value) {
  return typeof value === "string" && value !== "" && !value.includes("\\") && !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}
