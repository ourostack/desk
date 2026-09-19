import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { connectOrStartController } from "../../src/readiness/controller-client.js"
import { mkTempRoot } from "../_temp_roots.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(options = {}) {
  const directory = await mkTempRoot("desk-fence-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  return { root, stateHome: path.join(directory, "state"), ephemeral: true, ...options }
}

async function fenceModule() {
  const module = await import("../../src/readiness/watcher.js").catch((error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
    return {}
  })
  assert.equal(typeof module.fenceEvents, "function", "event fence must exist")
  return module
}

for (const reason of ["overflow", "lost_history", "journal_corrupt", "clock_uncertain", "unclean_shutdown", "unsupported_flush"]) {
  test(`fence never converts ${reason} into certainty`, async () => {
    const { fenceEvents } = await fenceModule()
    const cursor = { journal_id: "fixture", sequence: 4 }
    const invalidations = []
    const controller = {
      watcher: reason === "unsupported_flush" ? {} : { fence: async () => ({ certain: false, reason }) },
      journal: { cursor, replay: () => ({ certain: true }) },
      markUncertain: (value) => invalidations.push(value),
    }
    assert.deepEqual(await fenceEvents({ controller }), { certain: false, cursor, reason })
    assert.deepEqual(invalidations, [reason])
  })
}

test("fence checks journal corruption even when the backend claims a complete flush", async () => {
  const { fenceEvents } = await fenceModule()
  let invalidated
  const controller = {
    watcher: { fence: async () => ({ certain: true }) },
    journal: { cursor: { journal_id: "fixture", sequence: 1 }, replay: () => ({ certain: false, reason: "journal_corrupt" }) },
    markUncertain: (reason) => { invalidated = reason },
  }
  assert.equal((await fenceEvents({ controller })).certain, false)
  assert.equal(invalidated, "journal_corrupt")
})

test("cancelling a fence cannot produce current evidence", async () => {
  const { fenceEvents } = await fenceModule()
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(fenceEvents({ controller: {}, signal: abort.signal }), { name: "AbortError" })
})

test("controller persists changes before acknowledging and blocks readiness until reconciliation", async () => {
  const entered = deferred()
  const release = deferred()
  let calls = 0
  const options = await fixture({ handlers: { async beginConvergence() {
    if (++calls > 1) { entered.resolve(); await release.promise }
    return { indexed: true }
  } } })
  const client = await connectOrStartController(options)
  try {
    await client.beginConvergence()
    fs.writeFileSync(path.join(options.root, "task.md"), "# changed")
    const ack = await client.recordChange({ path: "task.md", operation: "write" })
    assert.equal(ack.recorded, true)
    assert.equal(ack.cursor?.sequence, 1)
    const log = fs.readFileSync(path.join(options.stateHome, client.id, "journal", "changes.jsonl"), "utf8")
    assert.equal(JSON.parse(log.trim()).path, "task.md")
    await entered.promise
    assert.equal((await client.barrier({ capability: "lexical" })).current, false)
    assert.equal((await client.status()).freshness.certain, false)
    release.resolve()
    assert.equal((await client.barrier({ capability: "lexical", wait: true })).current, true)
  } finally { release.resolve(); await client.close() }
})

test("external write immediately before a fence is durably delivered, not silently covered", async () => {
  const events = []
  const entered = deferred()
  const release = deferred()
  let passes = 0
  const options = await fixture({
    watcher: { async fence({ recordChange }) {
      for (const event of events.splice(0)) await recordChange(event)
      return { certain: true }
    } },
    handlers: { async beginConvergence() {
      if (++passes > 1) { entered.resolve(); await release.promise }
      return { indexed: true }
    } },
  })
  const client = await connectOrStartController(options)
  try {
    await client.beginConvergence()
    fs.writeFileSync(path.join(options.root, "external.md"), "# just written")
    events.push({ path: "external.md", operation: "write" })
    assert.equal(typeof client.fenceEvents, "function", "client must expose event fences")
    const fence = await client.fenceEvents()
    assert.equal(fence.certain, true)
    assert.equal(fence.cursor.sequence, 1)
    await entered.promise
    assert.equal((await client.barrier({ capability: "lexical" })).current, false)
    release.resolve()
    await client.barrier({ capability: "lexical", wait: true })
  } finally { release.resolve(); await client.close() }
})

test("uncertainty during convergence cannot be overwritten by the old pass", async () => {
  const entered = deferred()
  const release = deferred()
  const again = deferred()
  const releaseAgain = deferred()
  let calls = 0
  const options = await fixture({ handlers: { async beginConvergence() {
    if (++calls === 1) { entered.resolve(); await release.promise }
    if (calls === 2) { again.resolve(); await releaseAgain.promise }
    return { indexed: true }
  } } })
  const client = await connectOrStartController(options)
  let running
  try {
    running = client.beginConvergence()
    await entered.promise
    assert.equal(typeof client.markUncertain, "function", "controller needs freshness invalidation")
    await client.markUncertain("overflow")
    assert.equal((await client.status()).state, "RECOVERING")
    release.resolve()
    await running
    await again.promise
    assert.equal((await client.barrier({ capability: "lexical" })).current, false)
    releaseAgain.resolve()
    assert.equal((await client.barrier({ capability: "lexical", wait: true })).current, true)
  } finally {
    release.resolve(); releaseAgain.resolve()
    await running
    await client.close()
  }
})

test("journal append failure is returned as an error and marks controller freshness uncertain", async () => {
  const hold = deferred()
  let calls = 0
  const options = await fixture({ handlers: { async beginConvergence() {
    if (++calls > 1) await hold.promise
    return { indexed: true }
  } } })
  const client = await connectOrStartController(options)
  try {
    await client.beginConvergence()
    fs.linkSync(
      path.join(options.stateHome, client.id, "journal", "changes.jsonl"),
      path.join(options.root, "unsafe-hardlink"),
    )
    await assert.rejects(client.recordChange("task.md"), /unsafe.*file/)
    assert.equal((await client.barrier({ capability: "lexical" })).current, false)
    assert.equal((await client.status()).freshness.certain, false)
  } finally { hold.resolve(); await client.close() }
})
