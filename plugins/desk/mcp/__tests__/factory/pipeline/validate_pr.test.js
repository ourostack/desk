import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { factsPathsForSession, isFactsPath, isLabelsPath, validatePr } from "../../../src/factory/pipeline/validate-pr.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_BYTES = readFileSync(path.join(here, "..", "fixtures", "published-golden.json"))
const GOLDEN = JSON.parse(GOLDEN_BYTES.toString("utf8"))
const VALID_PATH = `facts/${GOLDEN.session.host}-${GOLDEN.session.id}.json`
const SENTINEL = "SENTINEL-VALIDATE-PR"
const LABELS_BYTES = readFileSync(path.join(here, "..", "fixtures", "labels-golden.json"))
const LABELS = JSON.parse(LABELS_BYTES.toString("utf8"))
const LABEL_PATH = `labels/${LABELS.job}/${LABELS.session}.json`
const LABEL_FACTS = [{ path: VALID_PATH, bytes: GOLDEN_BYTES }]
const TOKEN_SENTINEL = "ghp_SENTINEL0123456789abcdefghijklmnopqrstuv"

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
  for (const input of [null, {}, { changes: null }, { changes: new Array(1) }, { changes: [null] }, { changes: [[]] }, { changes: [{ path: 42, status: "added", bytes: GOLDEN_BYTES }] }, { changes: [{ path: VALID_PATH, status: "added", bytes: 42 }] }]) {
    const result = validatePr(input)
    assert.equal(result.ok, false)
    assert.equal(Array.isArray(result.errors), true)
    assert.equal(JSON.stringify(result).includes(SENTINEL), false)
  }
})

// ---------------------------------------------------------------------------
// Labels: `labels/<job>/<session id>.json`, checked against the session's facts.
// ---------------------------------------------------------------------------

function labelBytes(mutate) {
  const value = structuredClone(LABELS)
  mutate(value)
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

function noEcho(result) {
  for (const planted of [SENTINEL, TOKEN_SENTINEL, "ghp_"]) assert.equal(JSON.stringify(result).includes(planted), false)
}

test("validatePr accepts an added or modified labels file whose evidence matches the session's facts", () => {
  for (const status of ["added", "modified"]) {
    assert.deepEqual(validatePr({ changes: [{ path: LABEL_PATH, status, bytes: LABELS_BYTES, facts: LABEL_FACTS }] }), { ok: true, errors: [] })
  }
  assert.deepEqual(validatePr({
    changes: [
      { path: VALID_PATH, status: "added", bytes: GOLDEN_BYTES },
      { path: LABEL_PATH, status: "added", bytes: LABELS_BYTES.toString("utf8"), facts: [{ path: VALID_PATH, bytes: GOLDEN_BYTES.toString("utf8") }] },
    ],
  }), { ok: true, errors: [] })
})

test("isLabelsPath and factsPathsForSession recognize only the exact contracts", () => {
  assert.equal(isLabelsPath(LABEL_PATH), true)
  for (const candidate of [
    null,
    `labels/${LABELS.job}/${SENTINEL}.json`,
    `labels/${LABELS.job.toUpperCase()}/${LABELS.session}.json`,
    `labels/${LABELS.job}/c232ab00-9414-11ec-b3c8-9f6bdeced846.json`,
    `labels/${LABELS.job}/${LABELS.session}.json.bak`,
    `labels/${LABELS.job}/nested/${LABELS.session}.json`,
    `labels/${LABELS.session}.json`,
    `facts/${LABELS.job}/${LABELS.session}.json`,
  ]) assert.equal(isLabelsPath(candidate), false, String(candidate))
  assert.equal(isFactsPath(LABEL_PATH), false)
  assert.deepEqual(factsPathsForSession(LABELS.session), [`facts/claude-code-${LABELS.session}.json`, `facts/copilot-cli-${LABELS.session}.json`])
  for (const factsPath of factsPathsForSession(LABELS.session)) assert.equal(isFactsPath(factsPath), true)
})

test("validatePr rejects label paths outside the exact contract, removals and unknown statuses", () => {
  const badPaths = [`labels/${LABELS.job}/${TOKEN_SENTINEL}.json`, `labels/${TOKEN_SENTINEL}/${LABELS.session}.json`]
  const result = validatePr({
    changes: [
      ...badPaths.map((candidatePath) => ({ path: candidatePath, status: "added", bytes: LABELS_BYTES, facts: LABEL_FACTS })),
      { path: LABEL_PATH, status: "removed" },
      { path: LABEL_PATH, status: "renamed", bytes: LABELS_BYTES, facts: LABEL_FACTS },
    ],
  })
  assert.deepEqual(result, {
    ok: false,
    errors: [
      { code: "path", path: "changes.0" },
      { code: "path", path: "changes.1" },
      { code: "removal", path: LABEL_PATH },
      { code: "status", path: LABEL_PATH },
    ],
  })
  noEcho(result)
})

test("validatePr rejects invalid label bytes with stable codes and no candidate content", () => {
  const result = validatePr({
    changes: [
      { path: LABEL_PATH, status: "added", bytes: Buffer.from(`{"${TOKEN_SENTINEL}":`), facts: LABEL_FACTS },
      { path: LABEL_PATH, status: "added", bytes: Buffer.from(JSON.stringify(LABELS, null, 1)), facts: LABEL_FACTS },
      { path: LABEL_PATH, status: "added", bytes: labelBytes((value) => { value.notes = TOKEN_SENTINEL }), facts: LABEL_FACTS },
      { path: LABEL_PATH, status: "added", bytes: labelBytes((value) => { value.evaluator.model = `free text ${TOKEN_SENTINEL}` }), facts: LABEL_FACTS },
      { path: LABEL_PATH, status: "added", bytes: labelBytes((value) => { value.stretches[0].waste = TOKEN_SENTINEL }), facts: LABEL_FACTS },
      { path: LABEL_PATH, status: "added", bytes: labelBytes((value) => { value.stretches[1].start_ms = 60000 }), facts: LABEL_FACTS },
      { path: LABEL_PATH, status: "added", bytes: 42, facts: LABEL_FACTS },
    ],
  })
  assert.deepEqual(result, {
    ok: false,
    errors: [
      { code: "json", path: LABEL_PATH },
      { code: "canonical", path: LABEL_PATH },
      { code: "unknown_key", path: LABEL_PATH },
      { code: "pattern", path: LABEL_PATH },
      { code: "enum", path: LABEL_PATH },
      { code: "overlap", path: LABEL_PATH },
      { code: "type", path: LABEL_PATH },
    ],
  })
  noEcho(result)
})

test("validatePr rejects labels whose job or session differs from their path", () => {
  const otherJob = `labels/${"b".repeat(32)}/${LABELS.session}.json`
  const otherSession = `labels/${LABELS.job}/22222222-2222-4222-8222-222222222222.json`
  const otherFacts = [{ path: "facts/claude-code-22222222-2222-4222-8222-222222222222.json", bytes: sessionBytes({ id: "22222222-2222-4222-8222-222222222222" }) }]
  assert.deepEqual(validatePr({
    changes: [
      { path: otherJob, status: "added", bytes: LABELS_BYTES, facts: LABEL_FACTS },
      { path: otherSession, status: "added", bytes: LABELS_BYTES, facts: otherFacts },
    ],
  }), {
    ok: false,
    errors: [
      { code: "job_mismatch", path: otherJob },
      { code: "session_mismatch", path: otherSession },
    ],
  })
})

test("validatePr requires exactly one sound facts file for the labeled session", () => {
  const copilotPath = `facts/copilot-cli-${LABELS.session}.json`
  const copilotBytes = sessionBytes({ host: "copilot-cli" })
  const change = (facts) => ({ path: LABEL_PATH, status: "added", bytes: LABELS_BYTES, facts })
  // Either host's facts file serves.
  assert.deepEqual(validatePr({ changes: [change([{ path: copilotPath, bytes: copilotBytes }])] }), { ok: true, errors: [] })
  const result = validatePr({
    changes: [
      change([]),
      change([...LABEL_FACTS, { path: copilotPath, bytes: copilotBytes }]),
      change([{ path: VALID_PATH, bytes: Buffer.from(`{"${TOKEN_SENTINEL}":1}`) }]),
      change([{ path: VALID_PATH, bytes: sessionBytes({ host: "copilot-cli" }) }]),
      change([{ path: VALID_PATH, bytes: sessionBytes({ id: "22222222-2222-4222-8222-222222222222" }) }]),
      change([{ path: "facts/claude-code-22222222-2222-4222-8222-222222222222.json", bytes: GOLDEN_BYTES }]),
      change([{ path: `facts/${TOKEN_SENTINEL}.json`, bytes: GOLDEN_BYTES }]),
      change([null]),
      change(undefined),
    ],
  })
  assert.deepEqual(result, {
    ok: false,
    errors: [
      { code: "facts_missing", path: LABEL_PATH },
      { code: "facts_ambiguous", path: LABEL_PATH },
      { code: "facts_invalid", path: LABEL_PATH },
      { code: "facts_invalid", path: LABEL_PATH },
      { code: "facts_invalid", path: LABEL_PATH },
      { code: "type", path: LABEL_PATH },
      { code: "type", path: LABEL_PATH },
      { code: "type", path: LABEL_PATH },
      { code: "type", path: LABEL_PATH },
    ],
  })
  noEcho(result)
})

test("validatePr rejects labels whose evidence, stretches or job do not fit the facts", () => {
  const change = (mutate) => ({ path: LABEL_PATH, status: "added", bytes: labelBytes(mutate), facts: LABEL_FACTS })
  const unboundJob = "c".repeat(32)
  const unboundPath = `labels/${unboundJob}/${LABELS.session}.json`
  const result = validatePr({
    changes: [
      change((value) => { value.stretches[0].evidence = [[5000, 9001]] }),
      change((value) => { value.stretches[0].evidence = [[9500, 30000]] }),
      change((value) => { value.stretches[3].end_ms = GOLDEN.session.duration_ms + 1 }),
      { path: unboundPath, status: "added", bytes: labelBytes((value) => { value.job = unboundJob }), facts: LABEL_FACTS },
    ],
  })
  assert.deepEqual(result, {
    ok: false,
    errors: [
      { code: "evidence_unmatched", path: LABEL_PATH },
      { code: "evidence_unmatched", path: LABEL_PATH },
      { code: "range", path: LABEL_PATH },
      { code: "job_unbound", path: unboundPath },
    ],
  })
})
