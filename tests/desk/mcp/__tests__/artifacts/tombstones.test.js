import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { isTombstoned, loadTombstoneLedger } from "../../../../../plugins/desk/mcp/src/artifacts/tombstones.js"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"

const HASH = `sha256:${"a".repeat(64)}`

async function ledgerRoot(body) {
  const root = await mkTempRoot("desk-tombstones-")
  if (body !== undefined) {
    await fs.mkdir(path.join(root, "artifacts", "tombstones"), { recursive: true })
    await fs.writeFile(path.join(root, "artifacts", "tombstones", "tombstones.jsonl"), body)
  }
  return root
}

test("no plugin root or no ledger file means no redactions", async () => {
  assert.deepEqual(await loadTombstoneLedger(), [])
  assert.deepEqual(await loadTombstoneLedger({ pluginRoot: "  " }), [])
  assert.deepEqual(await loadTombstoneLedger({ pluginRoot: await ledgerRoot() }), [])
})

test("valid rows load and blank lines are skipped", async () => {
  const row = { document_path: "track/task.md", document_hash: HASH, reason: "redacted" }
  assert.deepEqual(await loadTombstoneLedger({ pluginRoot: await ledgerRoot(`\n${JSON.stringify(row)}\n\n`) }), [row])
})

test("an unreadable ledger fails closed", async () => {
  const root = await ledgerRoot()
  await fs.mkdir(path.join(root, "artifacts", "tombstones", "tombstones.jsonl"), { recursive: true })
  await assert.rejects(loadTombstoneLedger({ pluginRoot: root }), {
    code: "artifact_tombstone_ledger_invalid",
    diagnostics: ["tombstone ledger file could not be read"],
  })
})

test("every malformed row is reported and the ledger fails closed", async () => {
  const bad = [
    "{not json",
    "null",
    JSON.stringify({ document_path: "", document_hash: HASH }),
    JSON.stringify({ document_path: "track\\task.md", document_hash: HASH }),
    JSON.stringify({ document_path: "/track/task.md", document_hash: HASH }),
    JSON.stringify({ document_path: "C:/track/task.md", document_hash: HASH }),
    JSON.stringify({ document_path: "track/../task.md", document_hash: HASH }),
    JSON.stringify({ document_path: "track/task.md", document_hash: 7 }),
    JSON.stringify({ document_path: "track/task.md", document_hash: "sha256:short" }),
  ]
  await assert.rejects(loadTombstoneLedger({ pluginRoot: await ledgerRoot(bad.join("\n")) }), (error) => {
    assert.equal(error.code, "artifact_tombstone_ledger_invalid")
    assert.equal(error.diagnostics.length, bad.length)
    assert.equal(error.diagnostics[0], "tombstone ledger line 1 must be valid JSON")
    assert.match(error.diagnostics[1], /^tombstone ledger line 2 must name a normalized relative document_path/u)
    return true
  })
})

test("a document matches a row by its path, with either slash, and its content hash", () => {
  const rows = [{ document_path: "track/task.md", document_hash: HASH }]
  assert.equal(isTombstoned(rows, { path: "track\\task.md", hash: "a".repeat(64) }), true)
  assert.equal(isTombstoned(rows, { path: "track/task.md", hash: HASH }), true)
  assert.equal(isTombstoned(rows, { path: "track/task.md", hash: `sha256:${"b".repeat(64)}` }), false)
  assert.equal(isTombstoned(rows, { path: "track/other.md", hash: HASH }), false)
})

test("the plugin ships its redaction ledger, and it loads", async () => {
  const pluginRoot = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
  // Deleting the file would turn redaction off without an error, so its presence is checked here.
  await fs.access(path.join(pluginRoot, "artifacts", "tombstones", "tombstones.jsonl"))
  assert.ok(Array.isArray(await loadTombstoneLedger({ pluginRoot })))
})
