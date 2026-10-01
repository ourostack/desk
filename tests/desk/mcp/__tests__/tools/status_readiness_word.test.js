// `desk_status.readiness.state` is one word for agents; the controller's own state name and convergence sit under
// `readiness.detail` (round 5: the raw RECOVERING beside an admission `ready` read as an outage).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"

const router = { snapshot: async () => ({
  state: "READY",
  lexical: { generation: null, event_cursor: null, pending_changes: null, certain: false, current_automatic_action: null, serving_path: "direct" },
  semantic: { mode: "unsupported", current: false, generation: null, vectors_indexed: 0, missing_vectors: 0, current_automatic_action: null, diagnostic: null },
}) }

async function readinessFor(controller) {
  const root = mkdtempSync(path.join(tmpdir(), "status-word-"))
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  try {
    const body = await desk_status({ deskRoot: root, statusContext: controller === undefined ? {} : { admission: { controller } }, queryRouter: router })
    return body.readiness
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const ok = { status: "succeeded", semantic: null, diagnostic: null }
const failed = { status: "failed", semantic: null, diagnostic: { message: "journal has unsafe state directory ancestry" } }

for (const [controllerState, convergence, word] of [
  ["READY", ok, "ready"],
  ["LEXICAL_READY", ok, "ready"],
  ["RECOVERING", failed, "degraded"],
  ["RECOVERING", undefined, "degraded"],
  ["LEXICAL_READY", failed, "degraded"],
  ["CONTROL_READY", { status: "not_checked", semantic: null, diagnostic: null }, "converging"],
  ["LEXICAL_CONVERGING", { status: "pending", semantic: null, diagnostic: null }, "converging"],
  ["SEMANTIC_CONVERGING", ok, "converging"],
  ["RESOLVING", ok, "converging"],
  ["TERMINAL", ok, "unavailable"],
]) {
  test(`controller ${controllerState} with convergence ${convergence?.status ?? "missing"} is reported as the one word ${word}`, async () => {
    const readiness = await readinessFor({ status: async () => ({ state: controllerState, ...(convergence === undefined ? {} : { convergence }) }) })
    assert.equal(readiness.state, word)
    assert.equal(readiness.detail.controller_state, controllerState)
    assert.equal(typeof readiness.meaning, "string")
    assert.ok(readiness.meaning.length > 20)
    assert.ok(!Object.hasOwn(readiness, "convergence"), "the convergence snapshot lives under detail")
    assert.deepEqual(readiness.detail.convergence, convergence ?? { status: "not_checked", semantic: null, diagnostic: null })
  })
}

test("a desk_status with no readiness controller reports not_checked, and a controller that throws reports unavailable", async () => {
  const none = await readinessFor(undefined)
  assert.equal(none.state, "not_checked")
  assert.equal(none.detail.controller_state, "not_checked")
  const broken = await readinessFor({ status: async () => { throw new Error("connection closed") } })
  assert.equal(broken.state, "unavailable")
  assert.equal(broken.detail.controller_state, "unavailable")
  assert.equal(broken.detail.convergence.diagnostic.message, "connection closed")
})

test("the degraded meaning tells agents the top-level state decides whether Desk's tools work", async () => {
  const readiness = await readinessFor({ status: async () => ({ state: "RECOVERING", convergence: failed }) })
  assert.match(readiness.meaning, /top-level `state`/u)
  assert.match(readiness.meaning, /search falls back to direct reads/u)
})

test("LEXICAL_READY's meaning does not claim full convergence, while READY's does", async () => {
  const lexical = await readinessFor({ status: async () => ({ state: "LEXICAL_READY", convergence: ok }) })
  assert.equal(lexical.state, "ready")
  assert.match(lexical.meaning, /semantic \(embedding\) search is not fully available/u)
  assert.doesNotMatch(lexical.meaning, /has converged/u)
  const full = await readinessFor({ status: async () => ({ state: "READY", convergence: ok }) })
  assert.match(full.meaning, /has converged/u)
})
