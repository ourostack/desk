import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { isTombstoned } from "../../../../../plugins/desk/mcp/src/artifacts/tombstones.js"
import { directLexicalSearch } from "../../../../../plugins/desk/mcp/src/search/direct-lexical.js"
import { indexedSearch } from "../../../../../plugins/desk/mcp/src/tools/search.js"
import { mkTempDeskRoot, writeFile, buildFixtureIndex, fixtureDb } from "../tools/_search_helpers.js"

const now = Date.parse("2026-09-19T12:00:00Z")
const p = (...parts) => path.posix.join(...parts)

// The search engine and direct search read the redaction ledger from the plugin folder.
function usePluginRoot(t, pluginRoot) {
  const before = process.env.DESK_PLUGIN_ROOT
  process.env.DESK_PLUGIN_ROOT = pluginRoot
  t.after(() => {
    if (before === undefined) delete process.env.DESK_PLUGIN_ROOT
    else process.env.DESK_PLUGIN_ROOT = before
  })
}

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
  usePluginRoot(t, pluginRoot)
  return { deskRoot, pluginRoot }
}

test("portable tombstones match nested Windows and native document paths without mutating them", () => {
  const row = redaction("track/private/task.md", "quartz redacted")
  for (const documentPath of ["track\\private\\task.md", path.join("track", "private", "task.md")]) {
    const doc = { path: documentPath, hash: row.document_hash }
    assert.equal(isTombstoned([row], doc), true)
    assert.equal(isTombstoned([row], { ...doc, hash: row.document_hash.slice("sha256:".length) }), true, "a bare hex hash matches too")
    assert.equal(doc.path, documentPath)
    assert.equal(isTombstoned([row], { ...doc, hash: "different-content" }), false, "redaction remains content-specific")
  }
})

test("portable nested tombstones exclude native paths from direct lexical results", async (t) => {
  const { deskRoot } = await nestedRedactionFixture(t)
  const result = await directLexicalSearch({ deskRoot, query: "quartz" })
  assert.deepEqual(result.results.map((r) => r.path), [p("track", "public", "task.md")])
  assert.equal(existsSync(path.join(deskRoot, ".state", "desk-index.sqlite")), false)
})

test("portable nested tombstones exclude native paths from indexed results", async (t) => {
  const { deskRoot, pluginRoot } = await nestedRedactionFixture(t)
  await buildFixtureIndex(deskRoot, { tombstones: { pluginRoot } })
  const result = await indexedSearch({ deskRoot, db: fixtureDb(deskRoot), input: { query: "quartz" } })
  assert.deepEqual(result.results.map((r) => r.path), [p("track", "public", "task.md")])
})

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
  await buildFixtureIndex(root)
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
      const indexed = await indexedSearch({ deskRoot: root, db: fixtureDb(root), input, opts: { now } })
      const direct = await directLexicalSearch({ deskRoot: root, ...input, now })
      assert.deepEqual(direct.results, indexed.results)
      assert.equal(direct.query, indexed.query)
      assert.equal(direct.search_mode, indexed.search_mode)
    })
  }
})

test("direct lexical reads fresh content and never repairs an existing index", async () => {
  const root = await fixture()
  await buildFixtureIndex(root)
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
  await buildFixtureIndex(root)
  for (const slug of ["alpha", "bravo", "charlie", "delta", "echo"]) {
    await writeFile(root, `track/${slug}/task.md`, "quartz equal")
  }
  await buildFixtureIndex(root)
  for (const limit of [1, 50]) {
    const request = { deskRoot: root, query: "quartz", now, limit }
    const direct = await directLexicalSearch(request)
    const indexed = await indexedSearch({ deskRoot: root, db: fixtureDb(root), input: request, opts: { now } })
    assert.deepEqual(indexed.results, direct.results)
    assert.equal(indexed.results[0].path, path.posix.join("track", "alpha", "task.md"))
  }
})

test("direct lexical honors the same tombstone ledger as the search engine", async (t) => {
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
  usePluginRoot(t, pluginRoot)
  await buildFixtureIndex(root, { tombstones: { pluginRoot } })
  assert.deepEqual((await indexedSearch({
    deskRoot: root, db: fixtureDb(root), input: { query: "quartz" },
  })).results, [])
  assert.deepEqual((await directLexicalSearch({ deskRoot: root, query: "quartz" })).results, [])
  await writeFile(pluginRoot, "artifacts/tombstones/tombstones.jsonl", "invalid ledger")
  await assert.rejects(directLexicalSearch({ deskRoot: root, query: "quartz" }),
    { code: "artifact_tombstone_ledger_invalid" })
})
