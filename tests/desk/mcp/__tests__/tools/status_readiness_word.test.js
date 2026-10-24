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
  assert.match(readiness.meaning, /searches read the files directly/u)
})

test("LEXICAL_READY's meaning says meaning-based search is not fully available, while READY's says the index is current", async () => {
  const lexical = await readinessFor({ status: async () => ({ state: "LEXICAL_READY", convergence: ok }) })
  assert.equal(lexical.state, "ready")
  assert.match(lexical.meaning, /meaning-based search is not fully available/u)
  const full = await readinessFor({ status: async () => ({ state: "READY", convergence: ok }) })
  assert.equal(full.meaning, "The search index is current; nothing to do.")
})

const lowerBuild = (state, reason) => ({ status: async () => ({
  state, convergence: ok, freshness: { certain: reason === null, reason, cursor: null },
  index_owner: { version: "1.2.3", build: "0".repeat(64), this_controller: false },
}) })

test("a build that cannot read the newer owner's index says so and what helps, instead of 'still catching up'", async () => {
  const readiness = await readinessFor(lowerBuild("LEXICAL_CONVERGING", "index_owned_by_newer_desk"))
  assert.equal(readiness.state, "degraded")
  assert.equal(readiness.meaning, "A newer Desk in another session owns the search index and builds it with other settings, so this session cannot read it and writes nothing to it. Searches here read the files and stay correct, but meaning-based search is not available in this session. To use the index here, restart this session on the newer Desk; once the other session ends, this session takes the index over.")
  assert.doesNotMatch(readiness.meaning, /Nothing to fix/u)
})

test("a build waiting for the owner says it waits for the owner", async () => {
  const catchingUp = await readinessFor(lowerBuild("LEXICAL_CONVERGING", "index_owner_catching_up"))
  assert.equal(catchingUp.state, "converging")
  assert.equal(catchingUp.meaning, "The Desk session that owns the search index has not finished updating it. Searches here read the files meanwhile and stay correct; this session checks again shortly, and again at its next meaning-based search or desk change. Nothing to fix.")
  const embedding = await readinessFor(lowerBuild("LEXICAL_READY", null))
  assert.equal(embedding.state, "ready")
  assert.equal(embedding.meaning, "Exact-word search uses the search index, which the Desk session that owns it keeps current. That session has not finished preparing all desk text for meaning-based search; this session checks again shortly, and again at its next meaning-based search.")
})

test("every search status meaning is plain", async () => {
  const { READINESS_STATUS_WORDING } = await import("../../../../../plugins/desk/mcp/src/tools/status.js")
  assert.ok(READINESS_STATUS_WORDING.length >= 9)
  const jargon = /converg|semantic|generation|lexical|controller|barrier|journal|reconcil|\bproo?f\b|\bproven\b|RECOVERING|_READY\b|embedding probe/iu
  for (const text of READINESS_STATUS_WORDING) {
    const prose = text.replace(/`[^`]*`|"[^"]*"|\b[a-z]+(?:[_.][a-z]+)+\b/gu, "")
    assert.doesNotMatch(prose, jargon, text)
  }
})
