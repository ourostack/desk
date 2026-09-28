import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import Database from "better-sqlite3"
import { tombstoneDecisionForDoc } from "../../src/artifacts/tombstones.js"
import { configureRuntimeArtifacts } from "../../src/server-helpers.js"
import { directLexicalSearch } from "../../src/readiness/direct-lexical.js"
import { indexedSearch } from "../../src/tools/search.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { mkTempDeskRoot, writeFile, makeFailingFetch } from "../tools/_search_helpers.js"

const now = Date.parse("2026-09-19T12:00:00Z")
const p = (...parts) => path.join(...parts)

function redaction(documentPath, body, rotation = "read-consistency") {
  return {
    schema_version: 1, document_path: documentPath,
    document_hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    reason: "redacted", redacted_at: "2026-09-19T00:00:00Z",
    effective_from: "2026-09-19T00:00:00Z", artifact_rotation_id: rotation, actor: "fixture",
  }
}

async function nestedRedactionFixture(t) {
  const deskRoot = await mkTempDeskRoot()
  const pluginRoot = await mkTempDeskRoot()
  await writeFile(deskRoot, p("track", "work", "task.md"), "quartz redacted")
  await writeFile(deskRoot, p("track", "public", "task.md"), "quartz public")
  await writeFile(pluginRoot, "artifacts/tombstones/tombstones.jsonl",
    JSON.stringify(redaction("track/work/task.md", "quartz redacted")) + "\n")
  configureRuntimeArtifacts({ pluginRoot })
  t.after(() => configureRuntimeArtifacts())
  return { deskRoot, pluginRoot }
}

test("portable tombstones match nested Windows and native document paths without mutating them", () => {
  const row = redaction("track/private/task.md", "quartz redacted")
  for (const documentPath of ["track\\private\\task.md", p("track", "private", "task.md")]) {
    const doc = { path: documentPath, hash: row.document_hash }
    assert.equal(tombstoneDecisionForDoc({ ledger: { valid: true, rows: [row] }, doc }).tombstoned, true)
    assert.equal(doc.path, documentPath)
    assert.equal(tombstoneDecisionForDoc({
      ledger: { valid: true, rows: [row] }, doc: { ...doc, hash: "different-content" },
    }).tombstoned, false, "redaction remains content-specific")
  }
})

test("portable nested tombstones exclude native paths from direct lexical results", async (t) => {
  const { deskRoot } = await nestedRedactionFixture(t)
  const result = await directLexicalSearch({ deskRoot, query: "quartz" })
  assert.deepEqual(result.results.map((r) => r.path), [p("track", "public", "task.md")])
  assert.equal(existsSync(path.join(deskRoot, ".state", "desk-index.sqlite")), false)
})

test("portable nested tombstones exclude native paths from indexed results and generation documents", async (t) => {
  const { deskRoot, pluginRoot } = await nestedRedactionFixture(t)
  await rebuildIndex(deskRoot, { skipEmbed: true, tombstones: { pluginRoot } })
  const db = new Database(path.join(deskRoot, ".state", "desk-index.sqlite"), { readonly: true })
  try {
    const generation = db.prepare("SELECT documents FROM lexical_generations").get()
    assert.deepEqual(JSON.parse(generation.documents).map((doc) => doc.path), [p("track", "public", "task.md")])
    const result = await indexedSearch({ deskRoot, db, input: { query: "quartz" }, opts: { lexicalOnly: true } })
    assert.deepEqual(result.results.map((r) => r.path), [p("track", "public", "task.md")])
  } finally { db.close() }
})

for (const [kind, phase] of [["lexical", "discovery"], ["lexical", "evaluation"], ["timeline", "discovery"]]) {
  for (const change of ["valid", "invalid", "repeated"]) {
    test(`direct policy read consistency handles ${change} change during ${kind} ${phase}`, async (t) => {
      const deskRoot = await mkTempDeskRoot()
      const pluginRoot = await mkTempDeskRoot()
      const ledgerPath = "artifacts/tombstones/tombstones.jsonl"
      await writeFile(deskRoot, "track/work/task.md", "quartz redacted")
      await writeFile(deskRoot, "track/public/task.md", "quartz public")
      await writeFile(deskRoot, "_meta/featured.md", "track\n")
      await writeFile(pluginRoot, ledgerPath, "")
      configureRuntimeArtifacts({ pluginRoot })
      t.after(() => configureRuntimeArtifacts())
      const target = path.join(deskRoot, ...(phase === "discovery"
        ? ["track", "work", "task.md"] : ["_meta", "featured.md"]))
      let scans = 0
      const readFile = fs.readFile
      t.mock.method(fs, "readFile", async (file, ...args) => {
        const contents = await readFile(file, ...args)
        if (file === target) {
          scans++
          if (change === "invalid") {
            await writeFile(pluginRoot, ledgerPath, "{broken")
          } else if (scans === 1 || change === "repeated") {
            const rows = [redaction("track/work/task.md", "quartz redacted")]
            if (scans > 1) rows.push(redaction("track/public/task.md", "quartz public"))
            await writeFile(pluginRoot, ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
          }
        }
        return contents
      })
      const pending = directLexicalSearch({ deskRoot, kind, query: "quartz", now })
      if (change === "valid") {
        const result = await pending
        assert.deepEqual(result.results.map((r) => r.path), [p("track", "public", "task.md")])
        assert.equal(scans, 2, "a valid policy change discards the old corpus and retries once")
      } else {
        await assert.rejects(pending, {
          code: change === "invalid" ? "artifact_tombstone_ledger_invalid" : "readiness_changed_during_read",
        })
        assert.equal(scans, change === "invalid" ? 1 : 2, "invalid or unstable policy cannot cause an unbounded scan")
      }
      assert.equal(existsSync(path.join(deskRoot, ".state", "desk-index.sqlite")), false)
    })
  }
}

async function fixture() {
  const root = await mkTempDeskRoot()
  await writeFile(root, "_meta/featured.md", "alpha\n")
  await writeFile(root, "alpha/work/task.md", `---
status: processing
updated: 2026-09-18
iterations:
  history:
    - outcome: in-progress
      path: ./iteration
---
quartz retry architecture
`)
  await writeFile(root, "alpha/work/iteration/doing.md", "quartz retry implementation\n")
  await writeFile(root, "beta/done/task.md", "---\nstatus: done\nupdated: 2025-01-01\n---\nquartz retry architecture\n")
  await writeFile(root, "beta/blocked/task.md", "---\nstatus: blocked\nupdated: 2026-09-17\n---\nquartz quartz blocking concern\n")
  await writeFile(root, "alpha/_archive/old/task.md", "---\nstatus: done\nupdated: 2024-01-01\n---\nquartz ancient retry\n")
  await writeFile(root, "desks/sam/gamma/item/planning.md", "quartz across desks\n")
  await writeFile(root, "_shared/landscape/fact.md", `${"context ".repeat(80)}quartz ${"detail ".repeat(80)}`)
  await writeFile(root, "ignored/task.md", "quartz ignored")
  await writeFile(root, ".gitignore", "ignored/\n")
  await writeFile(root, "README.md", "quartz not an indexable document")
  return root
}

test("fresh direct lexical search matches indexed paths, filters, ranking, snippets and limits", async (t) => {
  const root = await fixture()
  const directBeforeIndex = await directLexicalSearch({ deskRoot: root, query: "quartz", now })
  assert.equal(existsSync(path.join(root, ".state", "desk-index.sqlite")), false)
  assert.equal(directBeforeIndex.results.length, 6)
  assert.equal(directBeforeIndex.results[0].path, p("beta", "blocked", "task.md"))
  assert.equal(directBeforeIndex.results.find((r) =>
    r.path === p("alpha", "work", "iteration", "doing.md")).score_breakdown.pin, 0.3)
  assert.ok(directBeforeIndex.results.some((r) => r.path === p("desks", "sam", "gamma", "item", "planning.md")))
  assert.ok(directBeforeIndex.results.find((r) => r.kind === "shared").snippet.includes("quartz"))
  await rebuildIndex(root, { skipEmbed: true })
  for (const input of [
    { query: "quartz" },
    { query: "quartz", scope: "all" },
    { query: "quartz", scope: "archived" },
    { query: "quartz", scope: "invalid" },
    { query: "quartz", filters: { track: "alpha" } },
    { query: "quartz", filters: { track: ["alpha", "beta"], status: ["processing", "blocked"] } },
    { query: "quartz", filters: { kind: ["shared", "planning"] } },
    { query: "quartz", filters: { since: "2026-01-01", until: "2026-09-18" } },
    { query: "quartz", filters: { status: ["", null], kind: [] } },
    { query: "quartz retry", limit: 0 },
    { query: "quartz", limit: 2.9 },
    { query: "quartz", limit: 999 },
    { query: "quartz", limit: NaN },
    { query: "absent" },
    { query: "q" },
    { query: "" },
  ]) {
    await t.test(JSON.stringify(input), async () => {
      const indexed = await indexedSearch({ deskRoot: root, input, opts: { now, embed: { fetch: makeFailingFetch() } } })
      const direct = await directLexicalSearch({ deskRoot: root, ...input, now })
      assert.deepEqual(direct.results, indexed.results)
      assert.equal(direct.query, indexed.query)
      assert.equal(direct.search_mode, indexed.search_mode)
    })
  }
})

test("direct lexical reads fresh content and never repairs an existing index", async () => {
  const root = await fixture()
  await rebuildIndex(root, { skipEmbed: true })
  await writeFile(root, "alpha/work/task.md", "---\nstatus: blocked\n---\nnewcanonicaltoken\n")
  const result = await directLexicalSearch({ deskRoot: root, query: "newcanonicaltoken", now })
  assert.deepEqual(result.results.map((r) => [r.path, r.status]), [[p("alpha", "work", "task.md"), "blocked"]])
})

test("direct lexical clamps the actual maximum to fifty", async () => {
  const root = await mkTempDeskRoot()
  for (let i = 0; i < 55; i++) await writeFile(root, `track/item-${i}/task.md`, "quartz")
  assert.equal((await directLexicalSearch({ deskRoot: root, query: "quartz", limit: 999, now })).results.length, 50)
  assert.equal((await directLexicalSearch({ deskRoot: root, query: "quartz", limit: 0, now })).results.length, 1)
  assert.equal(existsSync(path.join(root, ".state")), false)
})

test("lexical tie ordering and candidate limits do not depend on index insertion history", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "track/zebra/task.md", "quartz equal")
  await rebuildIndex(root, { skipEmbed: true })
  for (const slug of ["alpha", "bravo", "charlie", "delta", "echo"]) {
    await writeFile(root, `track/${slug}/task.md`, "quartz equal")
  }
  await rebuildIndex(root, { skipEmbed: true })
  for (const limit of [1, 50]) {
    const request = { deskRoot: root, query: "quartz", now, limit }
    const direct = await directLexicalSearch(request)
    const indexed = await indexedSearch({ deskRoot: root, input: request, opts: { now, lexicalOnly: true } })
    assert.deepEqual(indexed.results, direct.results)
    assert.equal(indexed.results[0].path, path.join("track", "alpha", "task.md"))
  }
})

test("direct lexical honors the same configured tombstone policy as controller indexing", async (t) => {
  const { configureRuntimeArtifacts } = await import("../../src/server-helpers.js")
  const root = await mkTempDeskRoot()
  const pluginRoot = await mkTempDeskRoot()
  const body = "quartz redacted"
  await writeFile(root, "task.md", body)
  await writeFile(pluginRoot, "artifacts/tombstones/tombstones.jsonl", JSON.stringify({
    schema_version: 1, document_path: "task.md",
    document_hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    reason: "redacted", redacted_at: "2026-09-19T00:00:00Z",
    effective_from: "2026-09-19T00:00:00Z", artifact_rotation_id: "fixture", actor: "fixture",
  }) + "\n")
  configureRuntimeArtifacts({ pluginRoot })
  t.after(() => configureRuntimeArtifacts())
  await rebuildIndex(root, { skipEmbed: true, tombstones: { pluginRoot } })
  assert.deepEqual((await indexedSearch({
    deskRoot: root, input: { query: "quartz" }, opts: { lexicalOnly: true },
  })).results, [])
  assert.deepEqual((await directLexicalSearch({ deskRoot: root, query: "quartz" })).results, [])
  await writeFile(pluginRoot, "artifacts/tombstones/tombstones.jsonl", "invalid ledger")
  await assert.rejects(directLexicalSearch({ deskRoot: root, query: "quartz" }),
    { code: "artifact_tombstone_ledger_invalid" })
})
