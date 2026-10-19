// Source-default qualification. No candidate flag, test helper or injected transport.
import "../_isolated_env.mjs"
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import * as harness from "./archive_handoff_qualification_child.mjs"

if (process.platform === "win32") {
  assert.notEqual(process.env.DESK_TEST_ARCHIVE_HANDLE_CANDIDATE, "1", "production qualification cannot select the historical candidate")
  await import("./archive_handoff_qualification.test.js")
}
const nativeCase = (name, body) => test(`actual Windows production default: ${name}`,
  { skip: process.platform !== "win32", timeout: 35000 }, body)

nativeCase("occupied destination after real freshness refuses without publication", async () => {
  const f = await harness.fixture("source-late-occupied", { onGit: true, status: "done" })
  const original = await fs.readFile(f.card), foreign = Buffer.from("OWNED_OCCUPIED_DESTINATION\n")
  const head = harness.git(f.root, "rev-parse", "HEAD"), index = harness.git(f.root, "ls-files", "-s")
  const requests = await harness.requests(f)
  await assert.rejects(harness.archiveOwned(f, { input: { track: "t", slug: harness.SLUG } }, {
    candidate: false,
    decorateMove: delegate => (source, destination, atUse) => delegate(source, destination, async () => {
      await atUse()
      await fs.mkdir(destination)
      await fs.writeFile(path.join(destination, "task.md"), foreign)
    }),
  }), error => {
    assert.equal(error.archiveMove.movement, "refused")
    assert.equal(error.archiveMove.retirement, "confirmed")
    return true
  })
  assert.equal((await fs.readFile(f.card)).equals(original), true)
  assert.equal((await fs.readFile(f.archived)).equals(foreign), true)
  assert.equal(harness.git(f.root, "rev-parse", "HEAD"), head)
  assert.equal(harness.git(f.root, "ls-files", "-s"), index)
  assert.deepEqual(await harness.requests(f), requests)
})

nativeCase("Unicode/apostrophe/metacharacter payload moves through the real default", async () => {
  const f = await harness.fixture("source-身份's & $(literal)", { status: "done" })
  const original = await fs.readFile(f.card), companion = await fs.readFile(path.join(f.src, "companion.txt"))
  assert.equal((await harness.archiveOwned(f, { input: { track: "t", slug: harness.SLUG } }, { candidate: false })).status, "archived")
  assert.equal(harness.exists(f.src), false)
  assert.equal((await fs.readFile(f.archived)).equals(original), true)
  assert.equal((await fs.readFile(path.join(f.dst, "companion.txt"))).equals(companion), true)
})

nativeCase("capture precedes creation of the destination parent", async () => {
  const f = await harness.fixture("source-missing-parent", { status: "done" })
  const original = await fs.readFile(f.card), parent = path.dirname(f.dst)
  assert.deepEqual(await fs.readdir(parent), [])
  await fs.rename(parent, path.join(f.base, "owned-empty-parent"))
  assert.equal((await harness.archiveOwned(f, { input: { track: "t", slug: harness.SLUG } }, { candidate: false })).status, "archived")
  assert.equal((await fs.readFile(f.archived)).equals(original), true)
  const observation = harness.archiveProductionObservations().at(-1)
  assert.equal(observation.destinationParentAtCapture, "deferred_until_admit")
  assert.equal(observation.native.destinationParentValidation, "validated")
})

async function substitute(f, reparse) {
  const original = new Map()
  for (const name of await fs.readdir(f.src)) {
    assert.equal((await fs.lstat(path.join(f.src, name))).isFile(), true)
    original.set(name, await fs.readFile(path.join(f.src, name)))
  }
  const retained = path.join(f.base, "native-original")
  await fs.rename(f.src, retained)
  const replacement = new Map(original)
  replacement.set("companion.txt", Buffer.from("OWNED_INDEPENDENT_REPLACEMENT\n"))
  const target = reparse ? path.join(f.base, "owned-reparse-target") : f.src
  await fs.mkdir(target)
  for (const [name, bytes] of replacement) await fs.writeFile(path.join(target, name), bytes)
  if (reparse) await fs.symlink(target, f.src, "junction")
  return { original, replacement, retained, target }
}

for (const stage of ["capture_before_prepare", "prepare_before_admit", "freshness_before_delete", "reparse_before_delete"]) {
  nativeCase(`complete native admission rejects ${stage}`, async () => {
    const f = await harness.fixture(`source-${stage}`, { status: "done" }), requests = await harness.requests(f)
    let changed, callbacks = 0
    const change = async () => { assert.equal(changed, undefined); changed = await substitute(f, stage === "reparse_before_delete") }
    await assert.rejects(harness.archiveOwned(f, { input: { track: "t", slug: harness.SLUG } }, {
      candidate: false,
      afterCapture: stage === "capture_before_prepare" ? change : undefined,
      beforeAdmit: stage === "prepare_before_admit" ? change : undefined,
      decorateMove: delegate => (source, destination, atUse) => delegate(source, destination, async () => {
        await atUse()
        callbacks++
        if (stage === "freshness_before_delete" || stage === "reparse_before_delete") await change()
      }),
    }), error => {
      const released = stage === "freshness_before_delete" || stage === "reparse_before_delete"
      assert.equal(error.archiveMove.released, released)
      assert.equal(error.archiveMove.movement, released ? "refused" : "not_released")
      assert.equal(error.archiveMove.closed, true)
      assert.equal(error.archiveMove.forced, false)
      assert.equal(error.archiveMove.retirement, "confirmed")
      return true
    })
    assert.ok(changed)
    assert.equal(callbacks, stage === "capture_before_prepare" || stage === "prepare_before_admit" ? 0 : 1)
    assert.equal(harness.exists(f.dst), false)
    for (const [name, bytes] of changed.original)
      assert.equal((await fs.readFile(path.join(changed.retained, name))).equals(bytes), true)
    for (const [name, bytes] of changed.replacement)
      assert.equal((await fs.readFile(path.join(changed.target, name))).equals(bytes), true)
    assert.equal((await fs.lstat(f.src)).isSymbolicLink(), stage === "reparse_before_delete")
    assert.deepEqual(await harness.requests(f), requests)
  })
}

after(async () => {
  if (process.platform !== "win32") return
  const target = new URL("../../../../../windows-archive-race-observations.json", import.meta.url)
  const artifact = JSON.parse(await fs.readFile(target, "utf8"))
  const observations = [...harness.archiveProductionObservations(),
    ...artifact.actorReceipts.map(actor => actor.receipt).filter(receipt => receipt?.kind === "production_default_archive_session")]
  assert.ok(observations.length > 0)
  for (const observation of observations) {
    assert.equal(observation.kind, "production_default_archive_session")
    assert.equal(observation.scope, "production_default_factory")
    assert.equal(observation.cleanupFailure, null)
    assert.equal(observation.droppedEvents, 0)
    const native = observation.native
    assert.equal(native.scope, "archive_native_preadmission_session")
    assert.equal(native.programSha256, "dda35c5729626c8499a568e9945ce3c4f8b2d0e80a43b2c9e04e521d746bc160")
    assert.equal(native.capturedValidated, true)
    assert.equal(native.additionalNativeAdmission, true)
    assert.equal(native.nodeIdentityBridge, false)
    assert.equal(native.cleanupConfirmed, true)
    assert.equal(native.handles.confirmedDisposed, true)
    assert.equal(native.archiveMove.closed, true)
    assert.equal(native.archiveMove.forced, false)
    assert.equal(native.archiveMove.retirement, "confirmed")
    assert.deepEqual(native.protocolIssues, [])
  }
  artifact.sourceProductionDefault = { qualifiedScope: "actual_production_default_only", observations }
  await fs.writeFile(target, JSON.stringify(artifact, null, 2) + "\n")
})
