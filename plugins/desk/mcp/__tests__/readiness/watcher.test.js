import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import * as net from "node:net"
import { connectOrStartController } from "../../src/readiness/controller-client.js"
import { controllerIdentity, deriveControllerEndpoint } from "../../src/readiness/identity.js"
import { createWorkspaceWatcher } from "../../src/readiness/workspace-watcher.js"
import { mkTempRoot } from "../_temp_roots.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function createWatchHarness() {
  let callback = null
  let errorHandler = null
  let closed = false
  return {
    watchFactory(root, options, handler) {
      callback = handler
      return {
        on(event, listener) {
          if (event === "error") errorHandler = listener
        },
        close() {
          closed = true
        },
      }
    },
    emit(eventType, filename) {
      callback(eventType, filename)
    },
    fail(error = new Error("watcher exploded")) {
      errorHandler?.(error)
    },
    isClosed() {
      return closed
    },
  }
}

async function waitForFenceMarker(root) {
  const markerDir = path.join(root, ".state", "readiness-fences")
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [marker] = fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : []
    if (marker) return path.join(markerDir, marker)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("workspace watcher marker was never created")
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

test("workspace watcher construction without a root fails immediately", async () => {
  await assert.rejects(
    () => createWorkspaceWatcher(),
    { code: "ERR_INVALID_ARG_TYPE" },
  )
})

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

test("production workspace watcher fences and delivers external writes", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const watcher = await createWorkspaceWatcher({ root, timeoutMs: 5_000 })
  t.after(() => watcher.close())

  fs.writeFileSync(path.join(root, "external.md"), "# external")
  const changes = []
  const fence = await watcher.fence({
    recordChange(change) {
      changes.push(change)
      return { recorded: true }
    },
  })

  assert.deepEqual(fence, { certain: true })
  assert.deepEqual(changes.map(({ path, operation }) => ({ path, operation })), [
    { path: "external.md", operation: "write" },
  ])
})

test("production workspace watcher propagates durable recording failures", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-recording-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, timeoutMs: 5_000, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  fs.writeFileSync(path.join(root, "external.md"), "# external")
  harness.emit("change", "external.md")
  const fence = watcher.fence({
    recordChange() {
      throw new Error("durable recording failed")
    },
  })
  const marker = await waitForFenceMarker(root)
  harness.emit("change", path.relative(root, marker))
  await assert.rejects(
    fence,
    /durable recording failed/u,
  )
})

test("workspace watcher reports lost history when the backend omits the filename", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-lost-history-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  harness.emit("change", null)
  assert.deepEqual(await watcher.fence(), { certain: false, reason: "lost_history" })
})

test("workspace watcher reports lost history when the backend emits an unsafe relative path", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-invalid-path-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  harness.emit("change", "../outside.md")
  assert.deepEqual(await watcher.fence(), { certain: false, reason: "lost_history" })
})

test("workspace watcher fails closed after a timeout waiting for the marker event", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-timeout-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, timeoutMs: 20, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  assert.deepEqual(await watcher.fence(), { certain: false, reason: "clock_uncertain" })
})

test("workspace watcher fails closed when marker creation cannot be written", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-write-failure-")
  const root = path.join(directory, "workspace")
  const markerDir = path.join(root, ".state", "readiness-fences")
  fs.mkdirSync(root, { recursive: true })
  const watcher = await createWorkspaceWatcher({ root })
  t.after(() => watcher.close())

  fs.rmSync(markerDir, { recursive: true, force: true })
  fs.mkdirSync(markerDir)
  fs.writeFileSync(path.join(markerDir, "sentinel"), "occupied")
  fs.writeFileSync(path.join(markerDir, "forced-file"), "forced")
  fs.rmSync(markerDir, { recursive: true, force: true })
  fs.writeFileSync(markerDir, "not a directory")
  assert.deepEqual(await watcher.fence(), { certain: false, reason: "watcher_failed" })
})

test("workspace watcher aborts an in-flight fence without inferring certainty", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-abort-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  const abort = new AbortController()
  const fence = watcher.fence({ signal: abort.signal })
  await waitForFenceMarker(root)
  abort.abort(new Error("caller stopped waiting"))
  await assert.rejects(fence, /caller stopped waiting/u)
})

test("workspace watcher ignores .state and configured state roots, reports nested deletes, and accepts an idle fence", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-ignore-")
  const root = path.join(directory, "workspace")
  const stateHome = path.join(directory, "state-home")
  const externalStateRoot = path.join(root, "external-state")
  const nestedDir = path.join(root, "nested")
  fs.mkdirSync(root)
  fs.mkdirSync(stateHome)
  fs.mkdirSync(externalStateRoot)
  fs.mkdirSync(nestedDir)
  fs.writeFileSync(path.join(nestedDir, "task.md"), "# nested")
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({
    root,
    ignoredPaths: [stateHome, externalStateRoot, path.join(directory, "outside-state")],
    watchFactory: harness.watchFactory,
  })
  t.after(() => watcher.close())

  const idleFence = watcher.fence({ recordChange() { assert.fail("idle fence should not record changes") } })
  const idleMarker = await waitForFenceMarker(root)
  harness.emit("change", path.relative(root, idleMarker))
  assert.deepEqual(await idleFence, { certain: true })

  fs.writeFileSync(path.join(root, ".state", "transient.md"), "ignored state")
  fs.writeFileSync(path.join(externalStateRoot, "ignored.md"), "ignored state root")
  fs.unlinkSync(path.join(nestedDir, "task.md"))
  harness.emit("change", ".state/transient.md")
  harness.emit("change", "external-state/ignored.md")
  harness.emit("change", "nested/task.md")
  const changes = []
  const fence = watcher.fence({
    recordChange(change) {
      changes.push(change)
      return { recorded: true }
    },
  })
  const marker = await waitForFenceMarker(root)
  harness.emit("change", path.relative(root, marker))
  assert.deepEqual(await fence, { certain: true })
  assert.deepEqual(changes.map(({ path, operation }) => ({ path, operation })), [
    { path: "nested/task.md", operation: "delete" },
  ])
})

test("workspace watcher accepts buffered relative filenames and does not require an error listener", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-buffer-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  let callback
  const watcher = await createWorkspaceWatcher({
    root,
    watchFactory(_root, _options, handler) {
      callback = handler
      return {
        close() {},
      }
    },
  })
  t.after(() => watcher.close())

  fs.writeFileSync(path.join(root, "buffered.md"), "# buffered")
  const changes = []
  callback("change", Buffer.from("./buffered.md"))
  const fence = watcher.fence({
    recordChange(change) {
      changes.push(change)
      return { recorded: true }
    },
  })
  const marker = await waitForFenceMarker(root)
  callback("change", Buffer.from(path.relative(root, marker)))
  assert.deepEqual(await fence, { certain: true })
  assert.deepEqual(changes.map(({ path, operation }) => ({ path, operation })), [
    { path: "buffered.md", operation: "write" },
  ])
})

test("workspace watcher closes cleanly and then fails closed", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-close-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })

  watcher.close()
  t.after(() => watcher.close())
  assert.equal(harness.isClosed(), true)
  assert.deepEqual(await watcher.fence(), { certain: false, reason: "watcher_closed" })
})

test("workspace watcher returns watcher_failed when the backend reports an error", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-error-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  harness.fail()
  assert.deepEqual(await watcher.fence(), { certain: false, reason: "watcher_failed" })
})

test("workspace watcher fails closed when marker cleanup cannot unlink the marker path", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-marker-cleanup-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  const fence = watcher.fence()
  const markerPath = await waitForFenceMarker(root)
  fs.unlinkSync(markerPath)
  fs.mkdirSync(markerPath)
  harness.emit("change", path.relative(root, markerPath))
  assert.deepEqual(await fence, { certain: false, reason: "watcher_failed" })
})

test("workspace watcher tolerates a marker path already removed by cleanup racing with the callback", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-marker-enoent-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  const fence = watcher.fence()
  const markerPath = await waitForFenceMarker(root)
  fs.unlinkSync(markerPath)
  harness.emit("change", path.relative(root, markerPath))
  assert.deepEqual(await fence, { certain: true })
})

test("workspace watcher fails closed when it cannot rescan the workspace after a marker event", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-scan-failure-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  fs.writeFileSync(path.join(root, "external.md"), "# external")
  harness.emit("change", "external.md")
  const fence = watcher.fence()
  const markerPath = await waitForFenceMarker(root)
  fs.rmSync(root, { recursive: true, force: true })
  harness.emit("change", path.relative(root, markerPath))
  assert.deepEqual(await fence, { certain: false, reason: "watcher_failed" })
})

test("workspace watcher fails closed when the backend fails after observing the marker but before the certainty check", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-post-marker-failure-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  const fence = watcher.fence()
  const markerPath = await waitForFenceMarker(root)
  harness.emit("change", path.relative(root, markerPath))
  harness.fail()
  assert.deepEqual(await fence, { certain: false, reason: "watcher_failed" })
})

test("workspace watcher preserves a newer sequence for the same path across serialized fences", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-sequence-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  const file = path.join(root, "task.md")
  fs.writeFileSync(file, "# first")
  harness.emit("change", "task.md")
  const firstFence = watcher.fence({
    recordChange(change) {
      fs.writeFileSync(file, "# second")
      harness.emit("change", "task.md")
      return { recorded: true, change }
    },
  })
  const firstMarker = await waitForFenceMarker(root)
  harness.emit("change", path.relative(root, firstMarker))
  assert.deepEqual(await firstFence, { certain: true })

  const secondChanges = []
  const secondFence = watcher.fence({
    recordChange(change) {
      secondChanges.push(change)
      return { recorded: true }
    },
  })
  const secondMarker = await waitForFenceMarker(root)
  harness.emit("change", path.relative(root, secondMarker))
  assert.deepEqual(await secondFence, { certain: true })
  assert.deepEqual(secondChanges.map(({ path, operation }) => ({ path, operation })), [
    { path: "task.md", operation: "write" },
  ])
})

test("workspace watcher ignores non-file entries during scans", async (t) => {
  const directory = await mkTempRoot("desk-workspace-watcher-symlink-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const target = path.join(directory, "target.md")
  fs.writeFileSync(target, "# target")
  fs.symlinkSync(target, path.join(root, "linked.md"))
  const harness = createWatchHarness()
  const watcher = await createWorkspaceWatcher({ root, watchFactory: harness.watchFactory })
  t.after(() => watcher.close())

  const fence = watcher.fence({ recordChange() { assert.fail("symlink should not be recorded as a file") } })
  const marker = await waitForFenceMarker(root)
  harness.emit("change", path.relative(root, marker))
  assert.deepEqual(await fence, { certain: true })
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

test("contradictory backend evidence and unspecified journal uncertainty never become certain", async () => {
  const { fenceEvents } = await fenceModule()
  for (const [backend, replay] of [
    [{ certain: true, reason: "overflow" }, { certain: true }],
    [{ certain: true }, { certain: false, reason: null }],
  ]) {
    const controller = {
      watcher: { fence: async () => backend },
      journal: { cursor: { journal_id: "fixture", sequence: 1 }, replay: () => replay },
      markUncertain() {},
    }
    assert.equal((await fenceEvents({ controller })).certain, false)
  }
})

test("a waiting barrier follows invalidation into the queued reconciliation", async () => {
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
  let waiting
  try {
    running = client.beginConvergence()
    await entered.promise
    let settled = false
    waiting = client.barrier({ capability: "lexical", wait: true }).then((value) => { settled = true; return value })
    await client.markUncertain("overflow")
    release.resolve()
    await running
    await again.promise
    // Flush an independent IPC round trip, not an arbitrary sleep.
    await client.status()
    assert.equal(settled, false)
    releaseAgain.resolve()
    assert.equal((await waiting).current, true)
  } finally {
    release.resolve(); releaseAgain.resolve()
    await Promise.allSettled([running, waiting])
    await client.close()
  }
})

test("cancelling a client fence ends only its request, not controller-owned work", async () => {
  const { fenceEvents } = await fenceModule()
  const entered = deferred()
  const release = deferred()
  const options = await fixture({
    watcher: { async fence() { entered.resolve(); await release.promise; return { certain: true } } },
    handlers: { beginConvergence: async () => ({ indexed: true }) },
  })
  const client = await connectOrStartController(options)
  const abort = new AbortController()
  let request
  let settled = false
  try {
    await client.beginConvergence()
    request = fenceEvents({ controller: client, signal: abort.signal })
      .then((value) => { settled = true; return value }, (error) => { settled = true; return error })
    await entered.promise
    abort.abort()
    await client.status()
    assert.equal(settled, true)
    assert.equal((await request).name, "AbortError")
    release.resolve()
    assert.equal((await client.barrier({ capability: "lexical" })).current, true)
  } finally { release.resolve(); await request; await client.close() }
})

test("a live corrupt journal schedules recovery under a new cursor identity", async () => {
  const options = await fixture({
    watcher: { fence: async () => ({ certain: true }) },
    handlers: { beginConvergence: async () => ({ indexed: true }) },
  })
  const client = await connectOrStartController(options)
  try {
    await client.beginConvergence()
    const before = (await client.status()).freshness.cursor
    fs.appendFileSync(path.join(options.stateHome, client.id, "journal", "changes.jsonl"), "corrupt\n")
    assert.equal((await client.fenceEvents()).reason, "journal_corrupt")
    assert.equal((await client.barrier({ capability: "lexical", wait: true })).current, true)
    assert.notEqual((await client.status()).freshness.cursor.journal_id, before.journal_id)
  } finally { await client.close() }
})

test("controller shutdown tolerates removal of its derived journal directory", async () => {
  const options = await fixture({ handlers: { beginConvergence: async () => ({ indexed: true }) } })
  const client = await connectOrStartController(options)
  await client.beginConvergence()
  fs.rmSync(path.join(options.stateHome, client.id), { recursive: true })
  await assert.doesNotReject(client.close())
})

test("a client rejects the legacy no-op recordChange acknowledgement", async () => {
  const options = await fixture()
  const identity = controllerIdentity({ root: options.root, protocolVersion: 1, lexicalContract: {}, semanticContract: null })
  const endpoint = deriveControllerEndpoint({ identity })
  const directory = path.join(options.stateHome, identity.id)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const server = net.createServer((socket) => {
    let pending = ""
    socket.on("data", (data) => {
      pending += data
      if (!pending.includes("\n")) return
      const request = JSON.parse(pending.trim())
      socket.end(`${JSON.stringify({
        id: request.id,
        result: request.method === "handshake" ? { accepted: true, identity } : { recorded: true },
      })}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, resolve)
  })
  fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({
    identity, owner: { token: "ephemeral-test-token" },
  }), { mode: 0o600 })
  let client
  try {
    client = await connectOrStartController(options)
    await assert.rejects(client.recordChange("task.md"), /durable.*acknowledgement/)
  } finally {
    await client?.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("F3 fence marks typed journal uncertainty before propagating a replay read failure", async () => {
  const { fenceEvents } = await fenceModule()
  const cause = Object.assign(new Error("journal read failed"), { code: "EIO" })
  const invalidations = []
  await assert.rejects(fenceEvents({ controller: {
    watcher: { fence: async () => ({ certain: true }) },
    journal: { replay() { throw cause } },
    markUncertain(reason) { invalidations.push(reason) },
  } }), (error) => {
    assert.deepEqual(invalidations, ["journal_integrity_failed"])
    assert.equal(error.code, "journal_integrity_failed")
    assert.equal(error.cause, cause)
    return true
  })
})

test("F3 missing journal rejects the fence and keeps the live barrier non-current until recovery", async () => {
  const entered = deferred()
  const release = deferred()
  let passes = 0
  const options = await fixture({
    watcher: { fence: async () => ({ certain: true }) },
    handlers: { async beginConvergence() {
      if (++passes === 2) { entered.resolve(); await release.promise }
      return { indexed: true }
    } },
  })
  const client = await connectOrStartController(options)
  try {
    await client.beginConvergence()
    assert.equal((await client.barrier({ capability: "lexical" })).current, true)
    const originalCursor = (await client.status()).freshness.cursor
    fs.unlinkSync(path.join(options.stateHome, client.id, "journal", "changes.jsonl"))
    await assert.rejects(client.fenceEvents(), { code: "journal_integrity_failed" })
    await entered.promise
    const status = await client.status()
    assert.equal(status.freshness.certain, false)
    assert.equal(status.freshness.reason, "journal_integrity_failed")
    assert.equal((await client.barrier({ capability: "lexical" })).current, false)
    release.resolve()
    assert.equal((await client.barrier({ capability: "lexical", wait: true })).current, true)
    assert.equal(passes, 2)
    assert.notEqual((await client.status()).freshness.cursor.journal_id, originalCursor.journal_id)
  } finally { release.resolve(); await client.close() }
})

test("controller fence rejects a journal backend that cannot open before watcher evidence is considered", async () => {
  const options = await fixture({
    watcher: { fence: async () => ({ certain: true }) },
    handlers: { beginConvergence: async () => ({ indexed: true }) },
  })
  const client = await connectOrStartController(options)
  try {
    fs.writeFileSync(path.join(options.stateHome, client.id, "journal"), "not a directory")
    await assert.rejects(client.fenceEvents(), { code: "journal_integrity_failed" })
    const status = await client.status()
    assert.equal(status.freshness.certain, false)
    assert.equal(status.freshness.reason, "journal_integrity_failed")
  } finally { await client.close() }
})
