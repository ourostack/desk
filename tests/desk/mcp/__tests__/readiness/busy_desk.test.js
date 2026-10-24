// A busy desk shared with older Desk builds that cannot be changed: they re-index a large card over and over, giving its sections new row numbers each time. Meaning-based search must still become ready and stay ready, and an edit must embed only the sections it adds.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { Worker } from "node:worker_threads"
import { execFileSync } from "node:child_process"
import { promises as fs, mkdirSync } from "node:fs"
import * as path from "node:path"
import { desk_recall } from "../../../../../plugins/desk/mcp/src/tools/search.js"
import { createDeskQueryRouter } from "../../../../../plugins/desk/mcp/src/readiness/query-router.js"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { startReadinessController } from "../../../../../plugins/desk/mcp/src/readiness/controller-server.js"
import { removeUnusableVectors } from "../../../../../plugins/desk/mcp/src/indexer/text-vectors.js"
import { controllerIdentity } from "../../../../../plugins/desk/mcp/src/readiness/identity.js"
import { readinessContracts } from "../../../../../plugins/desk/mcp/src/readiness/contracts.js"
import { openDb, closeDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { rebuildIndex } from "../../../../../plugins/desk/mcp/src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../../../../plugins/desk/mcp/src/indexer/spec.js"
import { ensureIndex, getSemanticCoverage } from "../../../../../plugins/desk/mcp/src/server-helpers.js"
import { makeEmbedFetch, mkTempDeskRoot, writeFile } from "../tools/_search_helpers.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PROBE_TEXT = "desk semantic health probe"
const SECTIONS = 1_000
const CARD = "track/busy/task.md"

// An embedding service that answers each request after a fixed delay, so a pass over the whole card takes far longer than an older build waits between re-indexes. It records the document sections it is asked to embed.
function slowEmbed(delayMs) {
  const fetch = makeEmbedFetch()
  const counter = { sections: 0, prompts: [] }
  counter.fetch = async (url, options) => {
    const prompt = JSON.parse(options.body).prompt
    if (prompt !== PROBE_TEXT) {
      counter.sections += 1
      counter.prompts.push(prompt)
    }
    await sleep(delayMs)
    return fetch(url, options)
  }
  return counter
}

function cardBody() {
  const sections = Array.from({ length: SECTIONS }, (_, i) => `## Entry ${i}\n\nquartz progress note ${i}: the rollout step ${i} finished and was checked.`)
  return `---\nstatus: processing\nschema_version: 1\n---\n# Busy card\n\n${sections.join("\n\n")}\n`
}

// An older Desk build in its own thread, as an older session runs in its own process (fixtures/legacy-desk-writer.mjs).
function startLegacyWriter(root, { journal, record, intervalMs, embedDelayMs = null }) {
  const worker = new Worker(new URL("./fixtures/legacy-desk-writer.mjs", import.meta.url), {
    workerData: { root, card: CARD, journal, record, intervalMs, embedDelayMs },
  })
  const done = new Promise((resolve, reject) => {
    worker.once("message", resolve)
    worker.once("error", reject)
  })
  let result = null
  return {
    async stop() {
      if (result === null) {
        worker.postMessage("stop")
        result = await done
        await worker.terminate()
      }
      return result
    },
  }
}

// The owning build's controller, catching up the way the production handler in server.js does.
async function ownerController(t, root, stateHome, embed, catchUps = []) {
  const build = "0".repeat(64)
  const version = "3.2.0-alpha.900"
  const contracts = { ...readinessContracts({ lexical: "required" }, { build }), semanticContract: { mode: "background", embedding_spec: ACTIVE_EMBEDDING_SPEC } }
  const id = controllerIdentity({ root, ...contracts }).id
  const controller = await connectOrStartController({
    root, stateHome, ephemeral: true, ...contracts, version,
    watcher: { fence: async () => ({ certain: true }) },
    handlers: { async beginConvergence({ eventCursor, journal }) {
      const started = performance.now()
      const options = { startup: false, snapshots: false, vectorPacks: false, vectorCleanup: false, embed: { fetch: embed.fetch }, eventCursor, writer: { version, build, controller: id } }
      const result = await ensureIndex(root, options)
      const db = openDb(root)
      try {
        if (!result.summary?.lexical_generation) {
          result.summary = await rebuildIndex(root, { ...options, db, reembedMissing: true })
          result.semantic = { ...result.semantic, ...getSemanticCoverage(db) }
        }
        await journal.compact({ db, generationId: result.summary.lexical_generation })
      } finally { closeDb(db) }
      result.semantic.query_embedding = { available: true, diagnostic: { model: ACTIVE_EMBEDDING_SPEC.model } }
      catchUps.push(Math.round(performance.now() - started))
      return result
    },
    // As server.js does, on the controller's own timer while this build owns the index.
    async cleanupVectors() {
      const db = openDb(root)
      try { return await removeUnusableVectors(db) } finally { closeDb(db) }
    } },
    // A shorter idle pause than the production minute, so the test sees the last orphans go.
    startController: (options) => startReadinessController({ ...options, cleanupIdleMs: 1_000 }),
  })
  t.after(() => controller.close())
  return { controller, version }
}

function rowOrphans(root) {
  const db = openDb(root)
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs v WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = v.chunk_id)").get().n
  } finally { closeDb(db) }
}

function missingVectors(root) {
  const db = openDb(root)
  try { return getSemanticCoverage(db).missing_vectors } finally { closeDb(db) }
}

test("beside older builds that keep re-indexing a 1,000-section card, recall stays ready and an edit embeds only its new sections", { timeout: 180_000 }, async (t) => {
  const root = await fs.realpath(await mkTempDeskRoot())
  // A desk is a Git repository. Desk asks Git once per process whether the index folder is ignored, and asks again on
  // every index opening when the folder is not a repository, which would add a Git start to every catch-up here.
  execFileSync("git", ["init", "-q", root])
  await writeFile(root, CARD, cardBody())
  for (const name of ["one", "two"]) {
    await writeFile(root, `track/${name}/task.md`, `---\nstatus: processing\nschema_version: 1\n---\nquartz small card ${name}\n`)
  }
  const stateHome = path.join(root, "controller-state")
  mkdirSync(stateHome, { recursive: true, mode: 0o700 })
  const ownerEmbed = slowEmbed(2)
  const catchUps = []
  const owner = await ownerController(t, root, stateHome, ownerEmbed, catchUps)
  await owner.controller.beginConvergence()
  assert.equal(missingVectors(root), 0, "the owner embedded the desk once")

  // A lower build that still writes (records its writer, cannot stand aside), and a build from before writers were recorded that re-indexes the card every 50 ms.
  const lower = startLegacyWriter(root, { journal: "alpha-348-journal", intervalMs: 100, embedDelayMs: 2,
    record: { version: "3.2.0-alpha.348", build: "f".repeat(64), controller: "lower-build-controller" } })
  const pre461 = startLegacyWriter(root, { journal: "pre-461-journal", intervalMs: 50, embedDelayMs: 0.05, record: null })
  t.after(async () => { await lower.stop(); await pre461.stop() })
  await sleep(300)

  const router = createDeskQueryRouter({ controller: owner.controller, version: owner.version, semanticDeadlineMs: 5_000 })
  const recall = () => desk_recall({ deskRoot: root, queryRouter: router, input: { topic: "quartz rollout", limit: 3 }, opts: { embed: { fetch: makeEmbedFetch() } } })
  const embeddedBefore = ownerEmbed.sections
  // The old table's vectors whose rows are gone, sampled while the older builds keep saving onto replaced rows.
  const orphanSamples = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      orphanSamples.push(rowOrphans(root))
      await sleep(500)
    }
  })()

  let appends = 0
  let writing = true
  const appender = (async () => {
    // On a fixed schedule, so a slow append or catch-up request does not stretch the gaps after it.
    const start = Date.now()
    while (Date.now() - start < 10_000) {
      await sleep(Math.max(0, start + (appends + 1) * 500 - Date.now()))
      appends += 1
      await fs.appendFile(path.join(root, CARD), `\n## Appended ${appends}\n\nquartz appended note ${appends}: a new step was logged.\n`)
      await owner.controller.markUncertain("pending_change")
    }
    writing = false
  })()
  const outcomes = []
  while (writing) {
    const started = Date.now()
    const answer = await recall()
    outcomes.push({ answered: Array.isArray(answer.results) && answer.results.length > 0, reason: answer.diagnostic?.reason ?? null, message: answer.diagnostic?.message, detail: answer.diagnostic?.detail, technical: answer.diagnostic?.technical, ms: Date.now() - started })
    await sleep(Math.max(0, 250 - (Date.now() - started)))
  }
  await appender
  const stoppedAt = Date.now()
  let settledMs = null
  while (Date.now() - stoppedAt < 10_000) {
    const answer = await recall()
    if (Array.isArray(answer.results) && answer.results.length > 0) { settledMs = Date.now() - stoppedAt; break }
  }

  const embedded = ownerEmbed.sections - embeddedBefore
  const embeddedTexts = ownerEmbed.prompts.slice(embeddedBefore)
  const answered = outcomes.filter((outcome) => outcome.answered).length
  t.diagnostic(`${appends} appends, ${embedded} sections embedded, ${answered} of ${outcomes.length} recalls answered, answered ${settledMs} ms after the writes stopped`)
  const sorted = catchUps.slice(1).sort((a, b) => a - b)
  const refusals = Object.entries(Object.groupBy(outcomes.filter((outcome) => !outcome.answered), (outcome) => outcome.reason)).map(([reason, list]) => `${reason} ${list.length}`)
  t.diagnostic(`${sorted.length} catch-ups after the first: median ${sorted[Math.floor(sorted.length / 2)]} ms, slowest ${sorted.at(-1)} ms; recall times ${outcomes.map((outcome) => outcome.ms).join(" ")} ms; refusals: ${refusals.join(", ") || "none"}`)
  assert.ok(appends >= 15, `the run appended ${appends} times`)
  assert.ok(embedded <= appends, `the owner embedded ${embedded} sections for ${appends} appended sections`)
  // Each append is embedded at most once, and nothing but the appended sections is embedded.
  assert.equal(new Set(embeddedTexts).size, embeddedTexts.length, "no section was embedded twice")
  assert.deepEqual(embeddedTexts.filter((text) => !/^## Appended \d+\n\nquartz appended note \d+/u.test(text)), [], "only appended sections were embedded")
  assert.ok(answered >= 0.9 * outcomes.length,
    `${answered} of ${outcomes.length} recalls answered; refusals: ${JSON.stringify(outcomes.filter((outcome) => !outcome.answered).slice(0, 5))}`)
  assert.ok(settledMs !== null && settledMs <= 2_000, `recall answered ${settledMs} ms after the writes stopped`)

  // The older builds keep re-indexing the card; the owner's coverage does not change.
  for (let sample = 0; sample < 10; sample += 1) {
    assert.equal(missingVectors(root), 0, `sample ${sample}: re-indexing by an older build left sections without a vector`)
    await sleep(60)
  }
  const older = { lower: await lower.stop(), pre461: await pre461.stop() }
  sampling = false
  await sampler
  const savedByOlder = older.lower.saved + older.pre461.saved
  t.diagnostic(`older builds: lower ${older.lower.commits} commits, pre-#461 ${older.pre461.commits} commits, ${savedByOlder} old-table vectors saved; orphans sampled every 500 ms: ${orphanSamples.join(" ")}`)
  assert.deepEqual([...older.lower.errors, ...older.pre461.errors], [], "the older builds kept working")
  assert.ok(older.lower.saved > 0 && older.pre461.saved > 0 && older.pre461.commits > appends,
    `the older builds kept re-indexing and saving by row (lower ${older.lower.commits} commits, ${older.lower.saved} saved; pre-#461 ${older.pre461.commits} commits, ${older.pre461.saved} saved)`)

  // The owner's cleanup keeps removing the old table's vectors whose rows are gone while the older builds add them, and removes the last ones once they stop.
  const peak = Math.max(...orphanSamples)
  assert.ok(peak < savedByOlder / 2, `at most ${peak} orphans at once, of ${savedByOlder} saved`)
  // A sample may never catch one if each round removes them first.
  assert.ok(peak === 0 || orphanSamples.some((count, i) => i > 0 && count < orphanSamples[i - 1]), "the orphan count fell while the older builds kept saving")
  let left = rowOrphans(root)
  for (let waited = 0; waited < 10_000 && left > 0; waited += 100) {
    await sleep(100)
    left = rowOrphans(root)
  }
  assert.equal(left, 0, "the last orphans were removed after the older builds stopped")

  const db = openDb(root)
  try {
    const stranded = db.prepare(`SELECT COUNT(*) AS n FROM text_vectors t
      WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.text_hash = t.text_hash)`).get().n
    assert.equal(stranded, 0, "every stored vector belongs to a section that exists")
  } finally { closeDb(db) }
})
