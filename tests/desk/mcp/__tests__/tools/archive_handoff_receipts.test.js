// IPC controls are separate from suites imported by real Windows qualification.
import "../_isolated_env.mjs"
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { promises as io } from "node:fs"
import path from "node:path"
import { ART, exists, fixture, spawnActor, actorMessage, send, finishActor, drainActors,
  persistNativeObservations, drainWithNativeObservations } from "./archive_handoff_qualification_child.mjs"

const persistedActorChecks = []
const target = path.join(ART, "ipc-receipts.json")
after(async () => {
  await drainWithNativeObservations(drainActors, () => persistNativeObservations(target))
  const artifact = JSON.parse(await io.readFile(target, "utf8"))
  assert.deepEqual(artifact.variants, [{ ownedControl: true }])
  assert.equal(artifact.actorReceipts.length, persistedActorChecks.length)
  for (const check of persistedActorChecks) check(artifact)
})
fs.writeFileSync(target, JSON.stringify({ variants: [{ ownedControl: true }] }) + "\n")

test("actor receipts retain early capture refusal through actual IPC and parent persistence", { timeout: 35000 }, async () => {
  const f = await fixture("receipt-early-capture", { status: "done" })
  const original = await io.readFile(f.card)
  const preload = new URL("./archive_handoff_receipt_capture.mjs", import.meta.url).href
  const previous = process.execArgv.length
  let actor
  try {
    process.execArgv.push("--import", preload)
    actor = spawnActor("archive", f)
  } finally { process.execArgv.length = previous }
  try {
    await actor.ready
    send(actor, { cmd: "start" })
    const outcome = await actorMessage(actor, "result")
    assert.equal(outcome.result, null)
    assert.equal(outcome.error.code, "ARCHIVE_NATIVE_MOVE")
    assert.match(outcome.error.message, /^Owned synthetic capture refusal/u)
    assert.equal(outcome.renameReturned, false)
    assert.equal(outcome.moveObservation, null)
    assert.equal((await io.readFile(f.card)).equals(original), true)
    assert.equal(exists(f.archived), false)
    persistedActorChecks.push(artifact => {
      const retained = artifact.actorReceipts.find(row => row.actorPid === actor.pid)
      assert.equal(retained.receiptReceived, true, "Early capture receipt was lost before parent persistence")
      assert.equal(retained.productionAttempts.length, 1)
      const observation = retained.productionAttempts[0]
      assert.equal(observation.sourceCapture, "capture_failed")
      assert.deepEqual(observation.native, {
        scope: "synthetic_capture_refusal", capturedValidated: false, admissionValidated: false,
        cleanupConfirmed: true, cleanupFailure: false,
        events: [{ type: "capture_requested", sequence: 1 }, { type: "session_settled", sequence: 2 }],
        archiveMove: { released: false, closed: true, forced: false,
          movement: "not_released", retirement: "confirmed" },
      })
      assert.deepEqual(retained.receipt, observation)
      assert.ok(retained.missingNativeStages.includes("native_spawn"))
      assert.deepEqual(outcome.productionAttempts, retained.productionAttempts)
    })
  } finally { await finishActor(actor) }
  assert.equal(actor.exit.code, 0)
})

test("actor receipts preserve successful production attempts without replacing the move observation", { timeout: 35000 }, async () => {
  const f = await fixture("receipt-success", { status: "done" })
  const actor = spawnActor("archive", f)
  try {
    await actor.ready
    send(actor, { cmd: "start" })
    const outcome = await actorMessage(actor, "result")
    assert.equal(outcome.error, null)
    assert.equal(outcome.result.status, "archived")
    assert.equal(outcome.renameReturned, true)
    persistedActorChecks.push(artifact => {
      const retained = artifact.actorReceipts.find(row => row.actorPid === actor.pid)
      assert.equal(retained.receiptReceived, true)
      assert.deepEqual(retained.receipt, outcome.moveObservation)
      assert.equal(retained.productionAttempts.length, 1)
      assert.equal(retained.productionAttempts[0].sourceCapture, "captured_before_corresponding_preparation")
      assert.deepEqual(retained.productionAttempts, outcome.productionAttempts)
    })
  } finally { await finishActor(actor) }
  assert.equal(actor.exit.code, 0)
})

test("actor receipts keep absent observations unknown after abort before action", { timeout: 35000 }, async () => {
  const f = await fixture("receipt-absent", { status: "done" })
  const actor = spawnActor("archive", f)
  try { await actor.ready } finally { await finishActor(actor) }
  const outcome = actor.messages.find(message => message.type === "result")
  assert.equal(outcome.result, null)
  assert.equal(outcome.error.message, "Owned qualification aborted before action")
  assert.equal(outcome.moveObservation, null)
  persistedActorChecks.push(artifact => {
    const retained = artifact.actorReceipts.find(row => row.actorPid === actor.pid)
    assert.equal(retained.receiptReceived, false)
    assert.equal(retained.receipt, null)
    assert.notEqual(retained.missingNativeStages.length, 0)
    assert.deepEqual(retained.productionAttempts, [])
    assert.deepEqual(outcome.productionAttempts, [])
  })
  assert.equal(actor.exit.code, 0)
})
