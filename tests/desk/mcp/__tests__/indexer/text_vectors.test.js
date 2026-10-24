// Section vectors keyed by text: a save checks that the section still exists, an index from an older build keeps its valid vectors without embedding them again, and vectors no section can use are removed in short batches while older builds keep reading their own table.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { closeDb, getMeta, openDb, setMeta } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { rebuildIndex } from "../../../../../plugins/desk/mcp/src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../../../../plugins/desk/mcp/src/indexer/spec.js"
import {
  ACTIVE_VECTOR_SPACE,
  UNUSED_TEXT_VECTOR_GRACE_MS,
  discardedVector,
  migrateRowVectors,
  prepareTextVectorSave,
  removeUnusableVectors,
  vectorSpaceFor,
} from "../../../../../plugins/desk/mcp/src/indexer/text-vectors.js"
import { ensureIndex } from "../../../../../plugins/desk/mcp/src/server-helpers.js"
import { inspectLocalDb, inspectStatusIndex } from "../../../../../plugins/desk/mcp/src/db/status-read.js"
import { mkTempRoot } from "../_temp_roots.js"

const NO_ARTIFACTS = { snapshots: false, vectorPacks: false }
const PROVENANCE = JSON.stringify({
  schema_version: 1,
  embedding_spec: {
    id: ACTIVE_EMBEDDING_SPEC.id,
    model: ACTIVE_EMBEDDING_SPEC.model,
    model_revision: ACTIVE_EMBEDDING_SPEC.model_revision,
    dimension: ACTIVE_EMBEDDING_SPEC.dimension,
    chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
    normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
  },
})
const vector = (value) => Array(ACTIVE_EMBEDDING_SPEC.dimension).fill(value)

async function deskWith(files) {
  const root = await mkTempRoot("desk-text-vectors-")
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), body, "utf8")
  }
  return root
}

// An embedding service that answers every section with the same vector and records what it was asked.
function recordingEmbed({ during } = {}) {
  const prompts = []
  return {
    prompts,
    fetch: async (_url, request) => {
      const prompt = JSON.parse(request.body).prompt
      prompts.push(prompt)
      await during?.(prompt)
      return new Response(JSON.stringify({ embedding: vector(0.25) }))
    },
  }
}

function inDb(root, action) {
  const db = openDb(root)
  try { return action(db) } finally { closeDb(db) }
}

const THREE_SECTIONS = "# Card\n\nalpha section.\n\n## Two\n\nbravo section.\n\n## Three\n\ncharlie section.\n"

test("a section deleted between its embedding and the save gets no vector, and its vector is reused if the text comes back", async () => {
  const root = await deskWith({ "track/a/task.md": THREE_SECTIONS })
  let removed = null
  const embed = recordingEmbed({
    // Another Desk build re-indexes the card without this section while its vector is being made.
    async during(prompt) {
      if (!prompt.includes("bravo")) return
      removed = inDb(root, (db) => {
        const rows = db.prepare("SELECT * FROM chunks WHERE text LIKE '%bravo%'").all()
        db.prepare("DELETE FROM chunks WHERE text LIKE '%bravo%'").run()
        return rows
      })
    },
  })
  const summary = await rebuildIndex(root, { embed: { fetch: embed.fetch } })
  assert.equal(embed.prompts.length, 3)
  assert.equal(summary.vectors_saved, 2)
  assert.equal(summary.vectors_discarded, 1)
  inDb(root, (db) => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM text_vectors").get().n, 2)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM text_vectors WHERE text_hash = ?").get(removed[0].text_hash).n, 0,
      "no vector is stored for a section that no longer exists")
  })
  assert.ok(discardedVector(ACTIVE_VECTOR_SPACE, removed[0].text_hash))

  // The other build commits the card again with the section back: its vector is saved without asking the service again.
  inDb(root, (db) => {
    const { id: _id, ...row } = removed[0]
    db.prepare(`INSERT INTO chunks (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(", ")})`).run(row)
  })
  const again = recordingEmbed()
  const resumed = await rebuildIndex(root, { embed: { fetch: again.fetch } })
  assert.deepEqual(again.prompts, [])
  assert.equal(resumed.vectors_saved, 1)
  assert.equal(discardedVector(ACTIVE_VECTOR_SPACE, removed[0].text_hash), undefined)
  inDb(root, (db) => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM text_vectors").get().n, 3))
})

test("vectors survive re-indexing: an edit embeds only the sections it changes", async () => {
  const root = await deskWith({ "track/a/task.md": THREE_SECTIONS })
  const first = recordingEmbed()
  await rebuildIndex(root, { embed: { fetch: first.fetch } })
  assert.equal(first.prompts.length, 3)
  await fs.writeFile(path.join(root, "track/a/task.md"), THREE_SECTIONS.replace("charlie section.", "charlie section, edited."), "utf8")
  const second = recordingEmbed()
  const summary = await rebuildIndex(root, { embed: { fetch: second.fetch } })
  assert.equal(summary.docs_indexed, 1, "the card is re-indexed")
  assert.deepEqual(second.prompts, ["## Three\n\ncharlie section, edited."])
  // The same text in two places is embedded once.
  await fs.mkdir(path.join(root, "track/b"), { recursive: true })
  await fs.writeFile(path.join(root, "track/b/task.md"), "# Copy\n\nalpha section.\n\n## Two\n\nbravo section.\n", "utf8")
  const third = recordingEmbed()
  await rebuildIndex(root, { embed: { fetch: third.fetch } })
  assert.deepEqual(third.prompts, ["# Copy\n\nalpha section."], "a section whose text another card already has is not embedded")
})

test("re-indexing a card keeps the rows of its unchanged sections and replaces only the rest", async () => {
  const root = await deskWith({ "track/a/task.md": THREE_SECTIONS })
  await rebuildIndex(root, { embed: { fetch: recordingEmbed().fetch } })
  const rows = () => inDb(root, (db) => db.prepare("SELECT id, chunk_index, text FROM chunks ORDER BY chunk_index").all())
  const before = rows()
  // An older build's vector for an unchanged row stays readable by row.
  inDb(root, (db) => db.prepare("INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)").run(BigInt(before[0].id), new Float32Array(vector(0.3))))

  await fs.appendFile(path.join(root, "track/a/task.md"), "\n## Four\n\ndelta section.\n", "utf8")
  const appended = await rebuildIndex(root, { embed: { fetch: recordingEmbed().fetch } })
  assert.equal(appended.chunks_inserted, 1)
  const after = rows()
  assert.deepEqual(after.slice(0, 3), before, "unchanged sections keep their rows")
  inDb(root, (db) => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs WHERE chunk_id = ?").get(BigInt(before[0].id)).n, 1))

  // An edit in the middle moves the offsets of the sections after it, so those rows are replaced; a removed section's row goes, and so does a stray second row at the same position.
  inDb(root, (db) => {
    const { id: _id, ...row } = db.prepare("SELECT * FROM chunks WHERE chunk_index = 1").get()
    db.prepare(`INSERT INTO chunks (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(", ")})`).run(row)
  })
  await fs.writeFile(path.join(root, "track/a/task.md"), THREE_SECTIONS.replace("bravo section.", "bravo section, longer now."), "utf8")
  const edited = await rebuildIndex(root, { embed: { fetch: recordingEmbed().fetch } })
  assert.equal(edited.chunks_inserted, 2)
  const final = rows()
  assert.equal(final.length, 3)
  assert.deepEqual(final[0], before[0])
  assert.match(final[1].text, /longer now/u)
  assert.ok(!final.slice(1).some((row) => before.some((old) => old.id === row.id)), "changed sections get new rows")
})

test("after the embedding service did not answer, only the changed documents' sections are tried", async () => {
  const root = await deskWith({ "track/a/task.md": THREE_SECTIONS, "track/b/task.md": "# Other\n\ndelta section.\n" })
  await rebuildIndex(root, { skipEmbed: true })
  await fs.writeFile(path.join(root, "track/b/task.md"), "# Other\n\ndelta section, edited.\n", "utf8")
  const changed = recordingEmbed()
  await rebuildIndex(root, { embedChangedOnly: true, embed: { fetch: changed.fetch } })
  assert.deepEqual(changed.prompts, ["# Other\n\ndelta section, edited."])
  // A repair asks for every missing text whatever changed.
  const repair = recordingEmbed()
  await rebuildIndex(root, { embedChangedOnly: true, reembedMissing: true, embed: { fetch: repair.fetch } })
  assert.equal(repair.prompts.length, 3)
})

test("vectors made with another model are kept apart from the active model's", async () => {
  const root = await deskWith({ "track/a/task.md": THREE_SECTIONS })
  await rebuildIndex(root, { embed: { model: "other-model", fetch: recordingEmbed().fetch } })
  assert.equal(vectorSpaceFor("other-model"), `${ACTIVE_VECTOR_SPACE}+model:other-model`)
  inDb(root, (db) => {
    assert.deepEqual(db.prepare("SELECT DISTINCT vector_space FROM text_vectors").all().map((row) => row.vector_space), [vectorSpaceFor("other-model")])
  })
  const active = recordingEmbed()
  await rebuildIndex(root, { embed: { fetch: active.fetch } })
  assert.equal(active.prompts.length, 3, "the active model's vectors are made separately")
})

// An index as an older build leaves it: vectors only in the row-keyed table, and most of them for rows that are gone.
async function legacyIndex({ trusted }) {
  const root = await deskWith({ "track/a/task.md": THREE_SECTIONS, "track/b/task.md": "# Other\n\ndelta section.\n" })
  await rebuildIndex(root, { skipEmbed: true })
  const live = inDb(root, (db) => {
    const insert = db.prepare("INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)")
    const chunks = db.prepare("SELECT id, text, text_hash FROM chunks ORDER BY id").all()
    // Every live section has a vector, each with its own value.
    chunks.forEach((chunk, i) => insert.run(BigInt(chunk.id), new Float32Array(vector(0.1 * (i + 1)))))
    // Vectors saved onto rows another build had already replaced.
    for (let id = 900_000; id < 900_050; id += 1) insert.run(BigInt(id), new Float32Array(vector(0.9)))
    if (trusted) setMeta(db, "active_vector_provenance", PROVENANCE)
    db.prepare("DELETE FROM text_vectors").run()
    return chunks
  })
  return { root, live }
}

test("first start carries valid old vectors over by text, with no embedding, and leaves orphaned ones behind", async () => {
  const { root, live } = await legacyIndex({ trusted: true })
  const embed = recordingEmbed()
  const result = await ensureIndex(root, { ...NO_ARTIFACTS, embed: { fetch: embed.fetch } })
  assert.deepEqual(embed.prompts, [], "nothing is embedded, not even a service check")
  assert.equal(result.semantic.missing_vectors, 0)
  inDb(root, (db) => {
    const stored = db.prepare("SELECT text_hash, embedding FROM text_vectors ORDER BY text_hash").all()
    assert.equal(stored.length, live.length)
    live.forEach((chunk, i) => {
      const row = stored.find((entry) => entry.text_hash === chunk.text_hash)
      assert.ok(Math.abs(row.embedding.readFloatLE(0) - 0.1 * (i + 1)) < 1e-6, "the old vector itself was carried over")
    })
    assert.equal(stored.some((row) => Math.abs(row.embedding.readFloatLE(0) - 0.9) < 1e-6), false, "orphaned vectors are not carried over")
    assert.equal(getMeta(db, "text_vectors_migrated_from_chunk_vecs"), ACTIVE_VECTOR_SPACE)
    assert.deepEqual(migrateRowVectors(db, { trusted: true }), { migrated: false, vectors_copied: 0 }, "the copy runs once")
  })
})

test("old vectors of unknown provenance are not carried over", async () => {
  const { root, live } = await legacyIndex({ trusted: false })
  const embed = recordingEmbed()
  const result = await ensureIndex(root, { ...NO_ARTIFACTS, embed: { fetch: embed.fetch } })
  assert.equal(embed.prompts.filter((prompt) => prompt !== "desk semantic health probe").length, live.length, "every section is embedded under the active model")
  assert.equal(result.semantic.missing_vectors, 0)
  inDb(root, (db) => {
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n > 0, "the older builds' table is left for them")
  })
})

test("vectors no section can use are removed in bounded batches, and an older build still reads its own table afterwards", async () => {
  const { root, live } = await legacyIndex({ trusted: true })
  const db = openDb(root)
  try {
    const insert = db.prepare("INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)")
    db.transaction(() => { for (let id = 1_000_000; id < 1_001_150; id += 1) insert.run(BigInt(id), new Float32Array(vector(0.9))) })()
    const orphans = () => db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs v WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = v.chunk_id)").get().n
    assert.equal(orphans(), 1_200)
    const runs = []
    for (;;) {
      const run = await removeUnusableVectors(db, { batchSize: 100, budgetMs: 0 })
      runs.push(run)
      if (run.complete) break
    }
    assert.equal(orphans(), 0)
    assert.ok(runs.length >= 12, `each run stopped after one batch of at most 100 (${runs.length} runs)`)
    assert.ok(runs.every((run) => run.row_vectors_removed <= 100))
    assert.equal(runs.reduce((sum, run) => sum + run.row_vectors_removed, 0), 1_200)

    // A longer budget takes several batches in one run.
    db.transaction(() => { for (let id = 2_000_000; id < 2_000_250; id += 1) insert.run(BigInt(id), new Float32Array(vector(0.9))) })()
    assert.deepEqual(await removeUnusableVectors(db, { batchSize: 100, budgetMs: 60_000 }),
      { text_vectors_removed: 0, row_vectors_removed: 250, complete: true })

    // An older build reads its own table as before: by row, and by nearest neighbour.
    const byRow = db.prepare("SELECT c.id FROM chunks c JOIN chunk_vecs v ON v.chunk_id = c.id ORDER BY c.id").all().map((row) => row.id)
    assert.deepEqual(byRow, live.map((chunk) => chunk.id))
    const nearest = db.prepare("SELECT chunk_id FROM chunk_vecs WHERE embedding MATCH ? AND k = 1").get(new Float32Array(vector(0.1)))
    assert.equal(nearest.chunk_id, live[0].id)
  } finally { closeDb(db) }
})

test("a text vector no section uses is kept for a grace period, and kept for good if its text comes back", async () => {
  const root = await deskWith({ "track/a/task.md": THREE_SECTIONS })
  await rebuildIndex(root, { embed: { fetch: recordingEmbed().fetch } })
  const db = openDb(root)
  try {
    const bravo = db.prepare("SELECT * FROM chunks WHERE text LIKE '%bravo%'").get()
    db.prepare("DELETE FROM chunks WHERE id = ?").run(bravo.id)
    let now = 1_000_000
    const clock = () => now
    assert.equal((await removeUnusableVectors(db, { now: clock })).text_vectors_removed, 0)
    assert.equal(db.prepare("SELECT unused_since FROM text_vectors WHERE text_hash = ?").get(bravo.text_hash).unused_since, now)
    now += UNUSED_TEXT_VECTOR_GRACE_MS - 1
    assert.equal((await removeUnusableVectors(db, { now: clock })).text_vectors_removed, 0, "still within the grace period")

    // The text comes back: the vector is in use again.
    const { id: _id, ...row } = bravo
    db.prepare(`INSERT INTO chunks (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(", ")})`).run(row)
    now += UNUSED_TEXT_VECTOR_GRACE_MS * 2
    assert.equal((await removeUnusableVectors(db, { now: clock })).text_vectors_removed, 0)
    assert.equal(db.prepare("SELECT unused_since FROM text_vectors WHERE text_hash = ?").get(bravo.text_hash).unused_since, null)

    // Gone for longer than the grace period: removed.
    db.prepare("DELETE FROM chunks WHERE text_hash = ?").run(bravo.text_hash)
    await removeUnusableVectors(db, { now: clock })
    now += UNUSED_TEXT_VECTOR_GRACE_MS
    assert.equal((await removeUnusableVectors(db, { now: clock, batchSize: 1 })).text_vectors_removed, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM text_vectors").get().n, 2)
  } finally { closeDb(db) }
})

test("the memory of discarded vectors stays bounded", async () => {
  const root = await deskWith({})
  inDb(root, (db) => {
    const save = prepareTextVectorSave(db, ACTIVE_VECTOR_SPACE)
    for (let i = 0; i <= 1_000; i += 1) assert.equal(save(`sha256:gone-${i}`, vector(0.5)), false)
    assert.equal(discardedVector(ACTIVE_VECTOR_SPACE, "sha256:gone-0"), undefined, "the oldest is forgotten first")
    assert.ok(discardedVector(ACTIVE_VECTOR_SPACE, "sha256:gone-1000"))
    // Discarding a vector again moves it to the newest place.
    assert.equal(save("sha256:gone-1", vector(0.5)), false)
    for (let i = 1_001; i < 1_002; i += 1) save(`sha256:gone-${i}`, vector(0.5))
    assert.ok(discardedVector(ACTIVE_VECTOR_SPACE, "sha256:gone-1"))
    assert.equal(discardedVector(ACTIVE_VECTOR_SPACE, "sha256:gone-2"), undefined)
  })
})

test("status says in plain words how many sections are too long to embed", async () => {
  const root = await deskWith({ "track/a/task.md": THREE_SECTIONS })
  await rebuildIndex(root, {
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async (_url, request) => JSON.parse(request.body).prompt.includes("alpha")
        ? new Response(JSON.stringify({ embedding: vector(0.2) }))
        : new Response(JSON.stringify({ error: "input (13440 tokens) is too large to process. increase the physical batch size (current batch size: 2048)" }), { status: 500 }),
    },
  })
  const status = inspectLocalDb(root)
  assert.equal(status.document_vectors.known_unembeddable_vectors, 2)
  assert.equal(status.document_vectors.note,
    "2 sections are too long for the embedding model, so meaning-based search skips them; exact-word search (desk_search) still finds them.")
})

test("an index an older build wrote, which has no text vectors yet, reads as having no vectors", async () => {
  const root = await deskWith({ "track/a/task.md": THREE_SECTIONS })
  await rebuildIndex(root, { embed: { fetch: recordingEmbed().fetch } })
  assert.equal(inspectStatusIndex(root).semantic.vectors_indexed, 3)
  inDb(root, (db) => db.exec("DROP TABLE text_vectors"))
  assert.deepEqual(inspectStatusIndex(root).semantic, {
    active_embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id, chunks_total: 3, vectors_indexed: 0, missing_vectors: 3,
  })
})
