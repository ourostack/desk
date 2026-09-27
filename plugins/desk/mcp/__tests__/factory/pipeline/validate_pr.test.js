import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { isFactsPath, validatePr } from "../../../src/factory/pipeline/validate-pr.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_BYTES = readFileSync(path.join(here, "..", "fixtures", "published-golden.json"))
const GOLDEN = JSON.parse(GOLDEN_BYTES.toString("utf8"))
const VALID_PATH = `facts/${GOLDEN.session.host}-${GOLDEN.session.id}.json`
const SENTINEL = "SENTINEL-VALIDATE-PR"

function bytes(changes = {}) {
  return Buffer.from(`${JSON.stringify({
    ...structuredClone(GOLDEN),
    ...changes,
  })}\n`)
}

function sessionBytes(changes) {
  const value = structuredClone(GOLDEN)
  Object.assign(value.session, changes)
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

test("validatePr accepts one added canonical published facts file", () => {
  assert.deepEqual(validatePr({
    changes: [{ path: VALID_PATH, status: "added", bytes: GOLDEN_BYTES }],
  }), { ok: true, errors: [] })
})

test("validatePr accepts canonical string bytes and recognizes only exact fact paths", () => {
  assert.deepEqual(validatePr({
    changes: [{ path: VALID_PATH, status: "added", bytes: GOLDEN_BYTES.toString("utf8") }],
  }), { ok: true, errors: [] })
  assert.equal(isFactsPath(VALID_PATH), true)
  assert.equal(isFactsPath(null), false)
  assert.equal(isFactsPath(`facts/${SENTINEL}.json`), false)
})

test("validatePr accepts a modification that keeps identity and does not reduce duration", () => {
  for (const duration_ms of [GOLDEN.session.duration_ms, GOLDEN.session.duration_ms + 1]) {
    assert.deepEqual(validatePr({
      changes: [{
        path: VALID_PATH,
        status: "modified",
        bytes: sessionBytes({ duration_ms }),
        previousBytes: GOLDEN_BYTES,
      }],
    }), { ok: true, errors: [] })
  }
})

test("validatePr rejects more than 500 changes without reading candidate values", () => {
  const changes = Array.from({ length: 501 }, () => ({
    get path() {
      throw new Error(SENTINEL)
    },
  }))
  assert.deepEqual(validatePr({ changes }), {
    ok: false,
    errors: [{ code: "too_many_changes", path: "changes" }],
  })
})

test("validatePr rejects removals and unknown statuses", () => {
  assert.deepEqual(validatePr({
    changes: [
      { path: VALID_PATH, status: "removed" },
      { path: VALID_PATH, status: "renamed", bytes: GOLDEN_BYTES },
    ],
  }), {
    ok: false,
    errors: [
      { code: "removal", path: VALID_PATH },
      { code: "status", path: VALID_PATH },
    ],
  })
})

test("validatePr rejects paths outside the exact facts filename contract without echoing them", () => {
  const invalid = [
    `src/${SENTINEL}.js`,
    `facts/nested/${SENTINEL}.json`,
    `facts/${SENTINEL}.json`,
    "facts/claude-code-c232ab00-9414-11ec-b3c8-9f6bdeced846.json",
    "facts/copilot-cli-22222222-2222-4222-7222-222222222222.json",
  ]
  const result = validatePr({
    changes: invalid.map((candidatePath) => ({ path: candidatePath, status: "added", bytes: GOLDEN_BYTES })),
  })
  assert.deepEqual(result, {
    ok: false,
    errors: invalid.map((_, index) => ({ code: "path", path: `changes.${index}` })),
  })
  assert.equal(JSON.stringify(result).includes(SENTINEL), false)
})

test("validatePr rejects filename/content host and session mismatches", () => {
  const otherHostPath = `facts/copilot-cli-${GOLDEN.session.id}.json`
  const otherIdPath = "facts/claude-code-22222222-2222-4222-8222-222222222222.json"
  assert.deepEqual(validatePr({
    changes: [
      { path: otherHostPath, status: "added", bytes: GOLDEN_BYTES },
      { path: otherIdPath, status: "added", bytes: GOLDEN_BYTES },
    ],
  }), {
    ok: false,
    errors: [
      { code: "host_mismatch", path: otherHostPath },
      { code: "session_mismatch", path: otherIdPath },
    ],
  })
})

test("validatePr rejects invalid published bytes using stable schema codes and no candidate content", () => {
  const invalidJson = Buffer.from(`{"${SENTINEL}":`)
  const nonCanonical = Buffer.from(`{ "schema": "${SENTINEL}" }`)
  const invalidSchema = bytes({ [SENTINEL]: SENTINEL })
  const result = validatePr({
    changes: [
      { path: VALID_PATH, status: "added", bytes: invalidJson },
      { path: VALID_PATH, status: "added", bytes: nonCanonical },
      { path: VALID_PATH, status: "added", bytes: invalidSchema },
    ],
  })
  assert.deepEqual(result, {
    ok: false,
    errors: [
      { code: "json", path: VALID_PATH },
      { code: "canonical", path: VALID_PATH },
      { code: "unknown_key", path: VALID_PATH },
    ],
  })
  assert.equal(JSON.stringify(result).includes(SENTINEL), false)
})

test("validatePr rejects modified files with missing or invalid previous bytes", () => {
  assert.deepEqual(validatePr({
    changes: [
      { path: VALID_PATH, status: "modified", bytes: GOLDEN_BYTES },
      { path: VALID_PATH, status: "modified", bytes: GOLDEN_BYTES, previousBytes: Buffer.from("{") },
    ],
  }), {
    ok: false,
    errors: [
      { code: "previous_missing", path: VALID_PATH },
      { code: "previous_invalid", path: VALID_PATH },
    ],
  })
})

test("validatePr rejects modifications that change host or session identity or reduce duration", () => {
  const otherHost = sessionBytes({ host: "copilot-cli" })
  const otherId = sessionBytes({ id: "22222222-2222-4222-8222-222222222222" })
  const shorter = sessionBytes({ duration_ms: GOLDEN.session.duration_ms - 1 })
  assert.deepEqual(validatePr({
    changes: [
      { path: `facts/copilot-cli-${GOLDEN.session.id}.json`, status: "modified", bytes: otherHost, previousBytes: GOLDEN_BYTES },
      { path: "facts/claude-code-22222222-2222-4222-8222-222222222222.json", status: "modified", bytes: otherId, previousBytes: GOLDEN_BYTES },
      { path: VALID_PATH, status: "modified", bytes: shorter, previousBytes: GOLDEN_BYTES },
    ],
  }), {
    ok: false,
    errors: [
      { code: "identity_changed", path: `facts/copilot-cli-${GOLDEN.session.id}.json` },
      { code: "identity_changed", path: "facts/claude-code-22222222-2222-4222-8222-222222222222.json" },
      { code: "duration_decreased", path: VALID_PATH },
    ],
  })
})

test("validatePr rejects malformed calls without throwing or echoing values", () => {
  for (const input of [null, {}, { changes: null }, { changes: [null] }, { changes: [[]] }, { changes: [{ path: 42, status: "added", bytes: GOLDEN_BYTES }] }, { changes: [{ path: VALID_PATH, status: "added", bytes: 42 }] }]) {
    const result = validatePr(input)
    assert.equal(result.ok, false)
    assert.equal(Array.isArray(result.errors), true)
    assert.equal(JSON.stringify(result).includes(SENTINEL), false)
  }
})
