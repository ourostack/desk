// Privacy routes and the offline-evaluation seam.
//
// Two audiences read this file. The owner needs the recording boundary and the
// inspect/correct/delete rights to be real: a private ledger that cannot be
// switched off, read back, corrected or destroyed by the person it describes is
// surveillance, not measurement. A separate offline-evaluation owner needs to
// invoke these same routes against synthetic state and get an honest answer,
// where a route that does not exist reports unavailable rather than quietly
// passing. Both requirements point at the same rule: say what is actually
// bound, and refuse rather than pretend.

import { test } from "node:test"
import { strict as assert } from "node:assert"

import { callTool } from "../../src/server.js"
import { CAPTURE_ROUTES, LEDGER_ACTIONS } from "../../src/measurement/actions.js"
import { mkLedgerFixture, useHostEnv, cleanup, writeSessionRecords } from "./_helpers.js"

const PERSON = "rowan"

function body(result) {
  const text = result.content[0].text
  try {
    return JSON.parse(text)
  } catch {
    return { status: "unroutable", message: text }
  }
}

async function ledger({ deskRoot, input, person = PERSON }) {
  return callTool({ deskRoot, name: "desk_work_ledger", input, person })
}

async function seedItem(fixture, person = PERSON) {
  const created = body(
    await ledger({
      deskRoot: fixture.deskRoot,
      person,
      input: { action: "intake", request: "One measurable outcome." },
    }),
  )
  assert.equal(created.status, "intake_recorded", created.message ?? "")
  return created.work_item.work_item_id
}

// The anti-mock requirement. A hardcoded list of route names would satisfy a
// naive reader and lie to a real one. Two things have to hold: the disclosure
// is derived from the same dispatch table the tool actually routes on, and each
// route it calls available executes to a real outcome when called correctly.
// Probing with junk and accepting a validation error would pass against a tool
// that implements nothing, so every probe below is a well-formed call and the
// assertion is on the outcome, not on the absence of one error string.
test("capabilities is derived from the dispatch table, not a hardcoded list", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const caps = body(
      await ledger({ deskRoot: fixture.deskRoot, input: { action: "capabilities" } }),
    )
    assert.equal(caps.status, "ok")
    assert.ok(Array.isArray(caps.routes), "capabilities must list routes")

    // The disclosure is the dispatch table. Not a superset, not a subset.
    const { LEDGER_ACTIONS } = await import("../../src/measurement/actions.js")
    assert.deepEqual(
      caps.routes.map((r) => r.route).sort(),
      Object.keys(LEDGER_ACTIONS).sort(),
      "capabilities must enumerate the routes the dispatcher actually holds",
    )

    for (const route of ["inspect", "correct", "delete", "set_recording", "report"]) {
      const entry = caps.routes.find((r) => r.route === route)
      assert.ok(entry, `route ${route} must be disclosed`)
      assert.equal(entry.availability, "available")
      assert.equal(entry.bound, true)
    }

    // Each advertised route, called properly, produces its own real outcome.
    const workItemId = await seedItem(fixture)
    const validCalls = {
      inspect: { action: "inspect", work_item_id: workItemId },
      report: { action: "report", work_item_id: workItemId },
      correct: {
        action: "correct",
        work_item_id: workItemId,
        field: "request",
        value: "A clearer statement of the same outcome.",
        expected_revision: 1,
        reason: "The first wording was ambiguous.",
      },
      set_recording: { action: "set_recording", enabled: true },
    }
    const expectedStatus = {
      inspect: "ok",
      report: "ok",
      correct: "corrected",
      set_recording: "recording_enabled",
    }
    for (const [route, input] of Object.entries(validCalls)) {
      const result = await ledger({ deskRoot: fixture.deskRoot, input })
      assert.equal(result.isError ?? false, false, `advertised route ${route} failed a valid call`)
      assert.equal(
        body(result).status,
        expectedStatus[route],
        `advertised route ${route} must produce its own outcome, not a generic acknowledgement`,
      )
    }

    // Delete last: it is the one that removes the subject of the others.
    const deleted = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: { action: "delete", work_item_id: workItemId, confirm: true },
      }),
    )
    assert.equal(deleted.status, "deleted")

    const missing = caps.routes.find((r) => r.route === "publish")
    assert.ok(missing === undefined || missing.availability === "unavailable")
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

test("disabling recording stops capture and says so, rather than dropping writes silently", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const workItemId = await seedItem(fixture)

    const off = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: { action: "set_recording", enabled: false, reason: "Stepping off the record." },
      }),
    )
    assert.equal(off.status, "recording_disabled")
    assert.equal(off.recording.enabled, false)

    // Driven from the shared capture registry rather than a hand-kept list, so
    // a route added later cannot quietly escape the switch. Every input below
    // is otherwise valid: the only reason each is refused is that recording is
    // off, not that the call was malformed.
    const validCaptureInputs = {
      intake: { action: "intake", request: "Something during the quiet window." },
      commit: {
        action: "commit",
        work_item_id: workItemId,
        outcome: "Restart-safe intake queue.",
        scope: "The queue module only.",
        evidence: "Replay test output.",
        delivery_endpoint: "desks/rowan/delivery/intake-queue/task.md",
        operator_go: { by: "operator", at: "2026-09-08T18:00:00Z" },
      },
      size: {
        action: "size",
        work_item_id: workItemId,
        work_type: "feature",
        scope: "one module",
        systems: ["queue"],
        uncertainty: "low",
        risk: "low",
        verification: "replay test",
      },
      phase: {
        action: "phase",
        work_item_id: workItemId,
        phase: "doing",
        started_at: "2026-09-08T18:00:00.000Z",
        ended_at: "2026-09-08T18:10:00.000Z",
      },
      scope_change: {
        action: "scope_change",
        work_item_id: workItemId,
        kind: "widened",
        change: "Restart path added.",
        reason: "The operator asked.",
        agreed_by: "operator",
      },
      link: {
        action: "link",
        work_item_id: workItemId,
        related_work_item_id: workItemId,
        relation: "related",
      },
      complete: {
        action: "complete",
        work_item_id: workItemId,
        endpoint: "desks/rowan/delivery/intake-queue/task.md",
        evidence: "Delivered and checked.",
      },
      close: { action: "close", work_item_id: workItemId, state: "cancelled", reason: "Stopped." },
      import_usage: {
        action: "import_usage",
        work_item_id: workItemId,
        source: "copilot_local_session_records",
        session_id: "session-one",
        machine_id: "workstation-a",
      },
      cost_basis: {
        action: "cost_basis",
        work_item_id: workItemId,
        amount: 4.2,
        currency: "USD",
        rate: 1,
        rate_unit: "request_multiplier",
        source: "an internal rate card",
        effective_date: "2026-09-01",
      },
      link_evaluation_receipt: {
        action: "link_evaluation_receipt",
        work_item_id: workItemId,
        measurement_kind: "offline_evaluation",
        receipt_ref: "runs/run-set-1/run-9/case-3/receipt.json",
        receipt_sha256: "d".repeat(64),
        run_set_id: "run-set-1",
        run_id: "run-9",
        case_id: "case-3",
        status: "passed",
        grade: null,
        availability: "available",
      },
    }
    assert.deepEqual(
      Object.keys(validCaptureInputs).sort(),
      [...CAPTURE_ROUTES].sort(),
      "every advertised capture route must appear in this matrix",
    )
    for (const input of Object.values(validCaptureInputs)) {
      const refused = await ledger({ deskRoot: fixture.deskRoot, input })
      assert.equal(refused.isError, true, `${input.action} must refuse while recording is off`)
      assert.match(body(refused).message, /recording (is )?disabled/iu)
    }

    // Precedence: the recording gate runs before field validation, so a call
    // that is *also* malformed is told the real reason it was refused rather
    // than being sent away to fix a field that was never going to be recorded.
    const malformed = await ledger({
      deskRoot: fixture.deskRoot,
      input: { action: "close", work_item_id: workItemId, disposition: "cancelled", reason: "Stopped." },
    })
    assert.equal(malformed.isError, true)
    assert.match(body(malformed).message, /recording (is )?disabled/iu)
    assert.doesNotMatch(body(malformed).message, /disposition/iu)
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

// Switching capture off must not lock the owner out of the data already held.
// Inspection, correction and deletion are the rights that make the store
// legitimate; they survive the recording boundary.
test("inspect, correct and delete stay available while recording is disabled", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const workItemId = await seedItem(fixture)
    await ledger({
      deskRoot: fixture.deskRoot,
      input: { action: "set_recording", enabled: false },
    })

    const seen = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: { action: "inspect", work_item_id: workItemId },
      }),
    )
    assert.equal(seen.status, "ok")

    const corrected = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: {
          action: "correct",
          work_item_id: workItemId,
          field: "request",
          value: "A clearer statement of the same outcome.",
          expected_revision: 1,
          reason: "The first wording was ambiguous.",
        },
      }),
    )
    assert.equal(corrected.status, "corrected")

    const deleted = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: { action: "delete", work_item_id: workItemId, confirm: true },
      }),
    )
    assert.equal(deleted.status, "deleted")
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

test("re-enabling recording resumes capture and leaves the gap visible in the report", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    await ledger({
      deskRoot: fixture.deskRoot,
      input: { action: "set_recording", enabled: false, reason: "Off the record." },
    })
    const on = body(
      await ledger({ deskRoot: fixture.deskRoot, input: { action: "set_recording", enabled: true } }),
    )
    assert.equal(on.status, "recording_enabled")
    assert.equal(on.recording.enabled, true)

    await seedItem(fixture)

    const report = body(
      await ledger({ deskRoot: fixture.deskRoot, input: { action: "report" } }),
    )
    assert.equal(report.recording.enabled, true)
    assert.equal(report.recording.class, "declared")
    assert.ok(
      Array.isArray(report.recording_gaps) && report.recording_gaps.length >= 1,
      "a window with recording off is a gap in coverage, not an absence of work",
    )
    const gap = report.recording_gaps[0]
    assert.ok(gap.disabled_at)
    assert.ok(gap.enabled_at)

    // A gap that is still open has no end yet. Reporting one would date the
    // silence to whenever the report happened to run.
    await ledger({
      deskRoot: fixture.deskRoot,
      input: { action: "set_recording", enabled: false, reason: "Off again." },
    })
    const during = body(await ledger({ deskRoot: fixture.deskRoot, input: { action: "report" } }))
    const openGap = during.recording_gaps.at(-1)
    assert.ok(openGap.disabled_at)
    assert.equal(openGap.enabled_at, null)
    assert.equal(openGap.open, true)
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

// Not an authorization check. Each person resolves to their own protected
// partition, so another person's work item is not refused, it is absent: there
// is no row of that identifier in the store this caller opened. The distinction
// matters because an authorization check can be misconfigured open, and an
// absent row cannot.
test("a work item is absent from another person's partition, not merely refused", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const rowansItem = await seedItem(fixture, "rowan")

    for (const input of [
      { action: "inspect", work_item_id: rowansItem },
      {
        action: "correct",
        work_item_id: rowansItem,
        field: "request",
        value: "Reaching into someone else's ledger.",
        expected_revision: 1,
        reason: "Should not be possible.",
      },
      { action: "delete", work_item_id: rowansItem, confirm: true },
    ]) {
      const crossed = await ledger({ deskRoot: fixture.deskRoot, person: "quinn", input })
      assert.equal(crossed.isError, true, `${input.action} must not cross person bindings`)
      // The diagnostic must read as absence, not as a denied permission.
      assert.match(body(crossed).message, /not found|unknown work item/iu)
      assert.doesNotMatch(body(crossed).message, /permission|forbidden|not authori[sz]ed/iu)
    }

    const stillThere = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        person: "rowan",
        input: { action: "inspect", work_item_id: rowansItem },
      }),
    )
    assert.equal(stillThere.status, "ok", "the owner's own item must be untouched")
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

test("no route accepts a caller-chosen location for the private store", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    // Probing one read-only route would leave the writing routes untested,
    // which are the ones that would actually create a store somewhere else.
    const workItemId = await seedItem(fixture)
    const actionMatrix = [
      { action: "capabilities" },
      { action: "intake", request: "One measurable outcome." },
      { action: "inspect", work_item_id: workItemId },
      { action: "report", work_item_id: workItemId },
      { action: "set_recording", enabled: true },
      {
        action: "import_usage",
        work_item_id: workItemId,
        source: "copilot_local_session_records",
        session_id: "session-one",
      },
      { action: "delete", work_item_id: workItemId, confirm: true },
    ]
    const locationFields = ["desk_root", "db_path", "store_path", "state_home", "namespace", "source_path", "person", "root"]

    // The probes above exercise a representative subset at runtime. The
    // property itself, though, has to hold for every route, including the ones
    // whose prerequisites make a live probe awkward — so it is also asserted
    // against the registry that actually decides which fields a route admits.
    // A route added later cannot open a location seam without failing here.
    const routes = Object.entries(LEDGER_ACTIONS)
    assert.ok(routes.length > 0, "the registry must actually list routes")
    for (const [action, admittedFields] of routes) {
      assert.ok(
        Array.isArray(admittedFields) && admittedFields.includes("action"),
        `${action} must publish a real field allow-list`,
      )
      for (const field of locationFields) {
        assert.equal(
          admittedFields.includes(field),
          false,
          `${action} must not admit ${field}: the store's location is not caller-chosen`,
        )
      }
    }

    for (const field of locationFields.filter((name) => name !== "person")) {
      for (const call of actionMatrix) {
        const refused = await ledger({
          deskRoot: fixture.deskRoot,
          input: { ...call, [field]: "/somewhere/else" },
        })
        assert.equal(refused.isError, true, `${call.action} must not accept ${field}`)
        assert.match(body(refused).message, /unknown input field/iu)
      }
    }
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

// The offline-evaluation owner produces its own receipts and hands over a
// reference, never a payload. Ingestion is explicit, bound to a work item the
// caller names, and carries nothing that would duplicate a transcript or invent
// a price.
test("an offline evaluation receipt is referenced explicitly, never ingested implicitly", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const workItemId = await seedItem(fixture)
    const receipt = {
      action: "link_evaluation_receipt",
      work_item_id: workItemId,
      measurement_kind: "offline_evaluation",
      receipt_ref: "runs/run-set-1/run-9/case-3/receipt.json",
      receipt_sha256: "a".repeat(64),
      run_set_id: "run-set-1",
      run_id: "run-9",
      case_id: "case-3",
      status: "passed",
      grade: null,
      availability: "available",
    }

    const linked = body(await ledger({ deskRoot: fixture.deskRoot, input: receipt }))
    assert.equal(linked.status, "evaluation_receipt_linked", linked.message ?? "")
    assert.equal(linked.receipt.measurement_kind, "offline_evaluation")
    assert.equal(linked.receipt.grade, null, "a null grade is not admitted, and never becomes a pass")

    const orphan = await ledger({
      deskRoot: fixture.deskRoot,
      input: { ...receipt, work_item_id: "work-item-that-does-not-exist" },
    })
    assert.equal(orphan.isError, true)
    assert.match(body(orphan).message, /not found|unknown work item/iu)
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

test("a linked receipt cannot smuggle in transcripts, usage rows or a price", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const workItemId = await seedItem(fixture)
    const base = {
      action: "link_evaluation_receipt",
      work_item_id: workItemId,
      measurement_kind: "offline_evaluation",
      receipt_ref: "runs/run-set-1/run-9/case-3/receipt.json",
      receipt_sha256: "b".repeat(64),
      run_set_id: "run-set-1",
      run_id: "run-9",
      case_id: "case-3",
      status: "passed",
      grade: null,
      availability: "available",
    }

    for (const smuggled of [
      { transcript: "the whole conversation" },
      { facts: { key: "value" } },
      { events: [{ role: "assistant", content: "..." }] },
      { financial_cost: 12.5 },
      { cost_usd: 12.5 },
      { usage: { input_tokens: 100 } },
    ]) {
      const refused = await ledger({
        deskRoot: fixture.deskRoot,
        input: { ...base, ...smuggled },
      })
      assert.equal(
        refused.isError,
        true,
        `${Object.keys(smuggled)[0]} must not ride in on a receipt`,
      )
      assert.match(body(refused).message, /unknown input field/iu)
    }

    const wrongKind = await ledger({
      deskRoot: fixture.deskRoot,
      input: { ...base, measurement_kind: "online_measurement" },
    })
    assert.equal(wrongKind.isError, true)
    assert.match(body(wrongKind).message, /measurement_kind/iu)
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

test("a linked receipt reports as declared evidence and never as measured usage", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const workItemId = await seedItem(fixture)
    await ledger({
      deskRoot: fixture.deskRoot,
      input: {
        action: "link_evaluation_receipt",
        work_item_id: workItemId,
        measurement_kind: "offline_evaluation",
        receipt_ref: "runs/run-set-1/run-9/case-3/receipt.json",
        receipt_sha256: "c".repeat(64),
        run_set_id: "run-set-1",
        run_id: "run-9",
        case_id: "case-3",
        status: "passed",
        grade: null,
        availability: "available",
      },
    })

    const item = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: { action: "report", work_item_id: workItemId },
      }),
    ).items[0]

    assert.equal(item.evaluations.class, "declared")
    assert.equal(item.evaluations.value.length, 1)
    assert.equal(item.evaluations.value[0].measurement_kind, "offline_evaluation")
    assert.equal(
      item.tokens.class,
      "unavailable",
      "an offline evaluation receipt is not online usage and must not populate token counts",
    )
    assert.equal(item.model_time_ms.class, "unavailable")
    assert.equal(item.financial_cost.class, "unavailable")
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

// The seam T04 preserved is not limited to offline evaluation. An
// independently checked online action profile is the same shape of thing —
// evidence an owner holds outside Git, referenced here by a pointer and a
// hash — so it is linked through the exact same route, against a canonical
// task-bound item, and it reads back byte-for-byte through a real JSON
// roundtrip rather than as a live in-process reference.
test("an online action profile is linked as a declared pointer against a canonical-task-bound item", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    await callTool({
      deskRoot: fixture.deskRoot,
      name: "task_create",
      person: PERSON,
      input: { track: "delivery", slug: "profile-task", title: "Profile task" },
    })
    const workItemId = await seedItem(fixture)
    const committed = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: {
          action: "commit",
          work_item_id: workItemId,
          outcome: "An outcome an online action profile can be linked against.",
          scope: "The profiled action only.",
          evidence: "Profile receipt attached to the task card.",
          delivery_endpoint: "desks/rowan/delivery/profile-task/task.md",
          operator_go: { by: "operator", at: "2026-09-08T18:00:00Z" },
          task_ref: { track: "delivery", slug: "profile-task" },
        },
      }),
    )
    assert.equal(committed.status, "committed", committed.message ?? "")

    const receiptValues = {
      action: "link_evaluation_receipt",
      work_item_id: workItemId,
      measurement_kind: "online_action_profile",
      receipt_ref: "private:synthetic-job/profile.json",
      receipt_sha256: "a".repeat(64),
      status: "captured",
      availability: "available",
    }

    const before = body(
      await ledger({ deskRoot: fixture.deskRoot, input: { action: "report", work_item_id: workItemId } }),
    ).items[0]
    assert.equal(before.evaluations.value.length, 0, "no receipt exists before this call")

    const raw = await ledger({ deskRoot: fixture.deskRoot, input: receiptValues })
    // Serialize and reparse the response the way a real caller would, over a
    // real transport, so a field that only survives as a live in-process
    // reference is caught rather than passing by accident.
    const linked = JSON.parse(JSON.stringify(body(raw)))
    assert.equal(linked.status, "evaluation_receipt_linked", linked.message ?? "")
    assert.equal(linked.receipt.class, "declared")
    assert.equal(linked.receipt.measurement_kind, "online_action_profile")
    assert.equal(linked.receipt.receipt_ref, receiptValues.receipt_ref)
    assert.equal(linked.receipt.receipt_sha256, receiptValues.receipt_sha256)
    assert.equal(linked.receipt.status, "captured")
    assert.equal(linked.receipt.availability, "available")

    const inspected = body(
      await ledger({ deskRoot: fixture.deskRoot, input: { action: "inspect", work_item_id: workItemId } }),
    )
    assert.equal(inspected.evaluation_receipts.length, 1)
    const storedRow = inspected.evaluation_receipts[0]
    assert.equal(storedRow.measurement_kind, "online_action_profile")
    assert.equal(storedRow.receipt_ref, receiptValues.receipt_ref)
    assert.equal(storedRow.receipt_sha256, receiptValues.receipt_sha256)
    assert.equal(storedRow.status, "captured")
    assert.equal(storedRow.availability, "available")

    const reported = body(
      await ledger({ deskRoot: fixture.deskRoot, input: { action: "report", work_item_id: workItemId } }),
    ).items[0]
    assert.equal(reported.evaluations.class, "declared")
    assert.equal(reported.evaluations.value.length, 1)
    assert.equal(reported.evaluations.value[0].measurement_kind, "online_action_profile")
    assert.equal(
      reported.tokens.class,
      "unavailable",
      "a declared profile pointer is not measured usage",
    )
    assert.equal(reported.financial_cost.class, "unavailable")
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

// Every red case the seam has to hold against, gathered in one place: an item
// that was never intaken, an item that exists but in someone else's private
// partition, an unknown kind, a structured value where the digest column can
// only hold a scalar, and the raw evidence payloads the seam refuses under any
// kind. A snapshot of the full receipt rows is taken immediately after every
// single rejection — not once at the end — because only a populated item can
// witness that a rejection left its existing content untouched, and only an
// immediate check can pin the rejection to the specific call that caused it.
test("linking an online action profile refuses every malformed or foreign call and changes nothing", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const workItemId = await seedItem(fixture, PERSON)
    const base = {
      action: "link_evaluation_receipt",
      measurement_kind: "online_action_profile",
      receipt_ref: "private:synthetic-job/profile.json",
      receipt_sha256: "f".repeat(64),
      status: "captured",
      availability: "available",
    }

    async function evaluations(person = PERSON) {
      const report = body(
        await ledger({
          deskRoot: fixture.deskRoot,
          person,
          input: { action: "report", work_item_id: workItemId },
        }),
      ).items[0]
      return report.evaluations.value
    }

    // Seed one valid, real receipt first, through the real route. An empty
    // item cannot witness that a rejection left existing content untouched —
    // only a populated one can, and it has to be a receipt this same route
    // actually wrote, not a fixture inserted around the seam.
    const seeded = body(await ledger({ deskRoot: fixture.deskRoot, input: { ...base, work_item_id: workItemId } }))
    assert.equal(seeded.status, "evaluation_receipt_linked", seeded.message ?? "")
    const baseline = await evaluations()
    assert.equal(baseline.length, 1)
    assert.equal(baseline[0].receipt_sha256, "f".repeat(64))

    // Missing item: the work_item_id names nothing this ledger ever intook.
    // Checked immediately after: the fake id stays absent too, so the
    // rejected call did not implicitly create the item it was refused for.
    const fakeId = "11111111-2222-3333-4444-555555555555"
    const missing = await ledger({ deskRoot: fixture.deskRoot, input: { ...base, work_item_id: fakeId } })
    assert.equal(missing.isError, true)
    assert.match(body(missing).message, /not found|no work item/iu)
    const afterMissing = await ledger({
      deskRoot: fixture.deskRoot,
      input: { action: "inspect", work_item_id: fakeId },
    })
    assert.equal(afterMissing.isError, true, "a rejected call must not implicitly create the item it named")
    assert.match(body(afterMissing).message, /not found|no work item/iu)
    assert.deepEqual(
      await evaluations(),
      baseline,
      "the real item's receipts must be untouched by a call naming a different id",
    )

    // Foreign owner: the item is real, but it belongs to a different
    // person's private partition. Checked immediately after: it still reads
    // as absent (not denied), it left no shadow item in the caller's own
    // partition, and the real owner's receipts are untouched.
    const foreign = await ledger({
      deskRoot: fixture.deskRoot,
      person: "quinn",
      input: { ...base, work_item_id: workItemId },
    })
    assert.equal(foreign.isError, true)
    assert.match(body(foreign).message, /not found|no work item/iu)
    const quinnView = await ledger({
      deskRoot: fixture.deskRoot,
      person: "quinn",
      input: { action: "inspect", work_item_id: workItemId },
    })
    assert.equal(quinnView.isError, true, "quinn's partition must not gain a shadow item under rowan's id")
    assert.match(body(quinnView).message, /not found|no work item/iu)
    assert.deepEqual(
      await evaluations(),
      baseline,
      "the owner's receipts must be untouched by another person's call against the same id",
    )

    // Recording off: the capture route stops here, before any field is even
    // considered, and the refusal names the real reason. Checked immediately
    // after, before the switch is turned back on — not after re-enabling,
    // which would not distinguish "never written" from "written and undone".
    await ledger({ deskRoot: fixture.deskRoot, input: { action: "set_recording", enabled: false } })
    const whileOff = await ledger({ deskRoot: fixture.deskRoot, input: { ...base, work_item_id: workItemId } })
    assert.equal(whileOff.isError, true)
    assert.match(body(whileOff).message, /recording (is )?disabled/iu)
    assert.deepEqual(
      await evaluations(),
      baseline,
      "a refused capture while recording is off must not have written anything, before re-enabling",
    )
    await ledger({ deskRoot: fixture.deskRoot, input: { action: "set_recording", enabled: true } })

    // A digest is a scalar column, required and shape-checked for this kind.
    // An array or an object used to be accepted, stored as SQLite's own
    // stringification, and echoed back in the shape it arrived in — so the
    // response and the record disagreed about what had actually been
    // written. Checked immediately after each one.
    for (const badDigest of [["a".repeat(64)], { sha256: "a".repeat(64) }]) {
      const arrayOrObject = await ledger({
        deskRoot: fixture.deskRoot,
        input: { ...base, work_item_id: workItemId, receipt_sha256: badDigest },
      })
      assert.equal(
        arrayOrObject.isError,
        true,
        `receipt_sha256 must refuse ${Array.isArray(badDigest) ? "an array" : "an object"}`,
      )
      assert.match(body(arrayOrObject).message, /receipt_sha256/iu)
      assert.deepEqual(
        await evaluations(),
        baseline,
        "a rejected digest shape must leave the existing receipt untouched",
      )
    }

    // An unknown measurement_kind is not a third owner this seam recognizes.
    // Checked immediately after.
    const unknownKind = await ledger({
      deskRoot: fixture.deskRoot,
      input: { ...base, work_item_id: workItemId, measurement_kind: "embedded_transcript" },
    })
    assert.equal(unknownKind.isError, true)
    assert.match(body(unknownKind).message, /measurement_kind/iu)
    assert.deepEqual(await evaluations(), baseline, "an unknown kind must leave the existing receipt untouched")

    // Raw transcript or facts payloads never ride in on any kind, online or
    // offline — the seam is a pointer plus a hash, never a payload. Checked
    // immediately after each one.
    for (const smuggled of [
      { transcript: "the whole conversation" },
      { facts: { turns: 12 } },
    ]) {
      const refused = await ledger({
        deskRoot: fixture.deskRoot,
        input: { ...base, work_item_id: workItemId, ...smuggled },
      })
      assert.equal(refused.isError, true, `${Object.keys(smuggled)[0]} must not ride in on a receipt`)
      assert.match(body(refused).message, /unknown input field/iu)
      assert.deepEqual(
        await evaluations(),
        baseline,
        `${Object.keys(smuggled)[0]} must leave the existing receipt untouched`,
      )
    }
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

// The immutable-pointer promise depends on the pointer actually carrying a
// digest. An online action profile is required to name one, shaped as exactly
// 64 hexadecimal characters, case-insensitive — a check on the pointer's
// shape only, never a fetch of the artefact and never a claim that anything
// was independently re-verified. Offline evaluation's pre-existing, hash-
// optional behavior is unchanged and re-proven here, not merely assumed.
test("an online action profile requires a well-formed 64-character hex digest; offline receipts stay hash-optional", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const workItemId = await seedItem(fixture, PERSON)
    const base = {
      action: "link_evaluation_receipt",
      work_item_id: workItemId,
      measurement_kind: "online_action_profile",
      receipt_ref: "private:synthetic-job/profile.json",
      status: "captured",
      availability: "available",
    }

    async function evaluations(itemId = workItemId) {
      const report = body(
        await ledger({ deskRoot: fixture.deskRoot, input: { action: "report", work_item_id: itemId } }),
      ).items[0]
      return report.evaluations.value
    }

    // Seed one valid, real receipt first. An empty item cannot witness that a
    // rejection left existing content untouched — only a populated one can:
    // an omitted/null/empty/whitespace/short/non-hex digest that instead
    // deleted or silently replaced the seeded row would still pass an
    // "ends up empty" assertion, but not a "matches the seeded baseline"
    // assertion.
    const seeded = body(
      await ledger({ deskRoot: fixture.deskRoot, input: { ...base, receipt_sha256: "c".repeat(64) } }),
    )
    assert.equal(seeded.status, "evaluation_receipt_linked", seeded.message ?? "")
    const baseline = await evaluations()
    assert.equal(baseline.length, 1)
    assert.equal(baseline[0].receipt_sha256, "c".repeat(64))

    const malformed = {
      omitted: undefined,
      null: null,
      empty: "",
      whitespace: "   ",
      short: "a".repeat(63),
      "non-hex": `${"a".repeat(63)}g`,
    }
    for (const [label, value] of Object.entries(malformed)) {
      const input = { ...base }
      if (value === undefined) {
        delete input.receipt_sha256
      } else {
        input.receipt_sha256 = value
      }
      const refused = await ledger({ deskRoot: fixture.deskRoot, input })
      assert.equal(
        refused.isError,
        true,
        `an ${label} receipt_sha256 must be refused for online_action_profile`,
      )
      assert.match(body(refused).message, /receipt_sha256/iu)
      // Checked immediately after this specific rejection, not only once at
      // the end, and against the seeded baseline, not merely against zero.
      assert.deepEqual(
        await evaluations(),
        baseline,
        `an ${label} digest must leave the seeded receipt untouched`,
      )
    }

    // Valid and case-insensitive: lowercase is accepted, stored, and echoed
    // back exactly as sent — not normalized to another case behind the
    // caller's back. A fresh item keeps this success case from being
    // entangled with the untouched-baseline witness above.
    const lowerItemId = await seedItem(fixture, PERSON)
    const lower = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: { ...base, work_item_id: lowerItemId, receipt_sha256: "a".repeat(64) },
      }),
    )
    assert.equal(lower.status, "evaluation_receipt_linked", lower.message ?? "")
    assert.equal(lower.receipt.receipt_sha256, "a".repeat(64))
    assert.equal((await evaluations(lowerItemId))[0].receipt_sha256, "a".repeat(64))

    // Uppercase is equally valid, on its own fresh item too.
    const upperItemId = await seedItem(fixture, PERSON)
    const upper = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: { ...base, work_item_id: upperItemId, receipt_sha256: "B".repeat(64) },
      }),
    )
    assert.equal(upper.status, "evaluation_receipt_linked", upper.message ?? "")
    assert.equal(upper.receipt.receipt_sha256, "B".repeat(64))
    assert.equal((await evaluations(upperItemId))[0].receipt_sha256, "B".repeat(64))

    // The seeded baseline itself is still exactly as it was after all of the
    // above, on the item that carried it throughout.
    assert.deepEqual(await evaluations(), baseline, "the seeded receipt must still be exactly as it was")

    // The hashless offline regression: legacy behavior is completely
    // unaffected. offline_evaluation still accepts no receipt_sha256 at all,
    // unlike the new kind, and this is unchanged by the requirement above.
    const offlineItemId = await seedItem(fixture, PERSON)
    const offline = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: {
          action: "link_evaluation_receipt",
          work_item_id: offlineItemId,
          measurement_kind: "offline_evaluation",
          receipt_ref: "runs/legacy/no-hash/receipt.json",
          status: "passed",
          availability: "available",
        },
      }),
    )
    assert.equal(offline.status, "evaluation_receipt_linked", offline.message ?? "")
    assert.equal(offline.receipt.receipt_sha256, null, "offline receipts remain hash-optional, unlike the new kind")
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})


// The point of the switch is that the window stays empty. A ledger that
// refuses writes while off but then imports the same period once switched
// back on has recorded the window anyway, just later. Native records carry
// their own timestamps, so this has to be enforced against the record's own
// time, not against when the import ran.
test("re-enabling recording never backfills the window that was switched off", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const workItemId = await seedItem(fixture)
    await ledger({
      deskRoot: fixture.deskRoot,
      input: { action: "set_recording", enabled: false, reason: "Off the record." },
    })
    await ledger({ deskRoot: fixture.deskRoot, input: { action: "set_recording", enabled: true } })

    const report = body(await ledger({ deskRoot: fixture.deskRoot, input: { action: "report" } }))
    const gap = report.recording_gaps.at(-1)

    // Native rows stamped inside the closed window, offered after it reopened.
    writeSessionRecords(fixture.sourcePath, {
      sessions: [{ id: "session-during-gap", cwd: "/work/repo", host_type: "cli" }],
      events: [
        {
          id: 1,
          session_id: "session-during-gap",
          turn_index: 0,
          model: "model-a",
          input_tokens: 10,
          output_tokens: 5,
          total_nano_aiu: 1000,
          created_at: gap.disabled_at,
        },
        {
          id: 2,
          session_id: "session-during-gap",
          turn_index: 1,
          model: "model-a",
          input_tokens: 10,
          output_tokens: 5,
          total_nano_aiu: 1000,
          created_at: gap.enabled_at,
        },
      ],
    })

    const imported = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: {
          action: "import_usage",
          work_item_id: workItemId,
          source: "copilot_local_session_records",
          session_id: "session-during-gap",
        },
      }),
    )
    assert.equal(imported.status, "usage_imported")
    assert.equal(
      imported.skipped_recording_disabled,
      2,
      "rows stamped inside a disabled window are not admitted after the fact",
    )
    assert.equal(imported.imported_events, 0)

    const item = body(
      await ledger({
        deskRoot: fixture.deskRoot,
        input: { action: "report", work_item_id: workItemId },
      }),
    ).items[0]
    assert.equal(item.observed_events.value, 0)
    assert.equal(item.coverage.recording_gaps_overlapping, 1)
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

// The switch is a durable fact about the store, not a variable in one process.
// If it did not survive reopening, a restart would silently resume capture the
// owner had switched off.
test("the recording state and its history survive reopening the store", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    for (const [enabled, reason] of [
      [false, "First quiet window."],
      [true, "Back on."],
      [false, "Second quiet window."],
    ]) {
      const toggled = body(
        await ledger({
          deskRoot: fixture.deskRoot,
          input: { action: "set_recording", enabled, reason },
        }),
      )
      assert.equal(
        toggled.status,
        enabled ? "recording_enabled" : "recording_disabled",
        toggled.message ?? "",
      )
      assert.equal(toggled.recording.enabled, enabled)
    }

    // Every call above opened and closed the store; this one is a fresh read.
    const after = body(await ledger({ deskRoot: fixture.deskRoot, input: { action: "report" } }))
    assert.equal(after.recording.enabled, false)
    assert.equal(after.recording_gaps.length, 2, "each disabled window is retained separately")
    assert.equal(after.recording_gaps[0].reason, "First quiet window.")
    assert.equal(after.recording_gaps[0].open, false)
    assert.equal(after.recording_gaps[1].reason, "Second quiet window.")
    assert.equal(after.recording_gaps[1].open, true)

    // Redundant toggles do not manufacture empty gaps.
    await ledger({ deskRoot: fixture.deskRoot, input: { action: "set_recording", enabled: false } })
    const again = body(await ledger({ deskRoot: fixture.deskRoot, input: { action: "report" } }))
    assert.equal(again.recording_gaps.length, 2)
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})
