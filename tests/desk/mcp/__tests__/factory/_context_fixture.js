import { readFileSync } from "node:fs"
import { createHmac } from "node:crypto"
import { contextPayloadHash, contextSource } from "../../../../../plugins/desk/mcp/src/factory/context-schema.js"
import { readMachineSecret, updateTaskContextState, writeTaskContextFile } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { stableStringify } from "../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"

export async function replaceContextInput(env, store, work, input) {
  const file = `input-${input.basis}.json`
  const inputSeal = createHmac("sha256", await readMachineSecret(env))
    .update(stableStringify({ kind: "input", basis: input.basis, value: input })).digest("hex")
  await writeTaskContextFile(env, store, work.job, file, input)
  await updateTaskContextState(env, store, work.job, (state) => ({
    ...state, basis: input.basis, input: file, input_seal: inputSeal,
  }))
}

export const CONTEXT_JOB = "1a2b3c4d5e6f708192a3b4c5d6e7f809"
export const contextFacts = () => {
  const facts = JSON.parse(readFileSync(new URL("./fixtures/published-golden.json", import.meta.url), "utf8"))
  facts.jobs = [facts.jobs[0]]
  facts.outcomes = facts.outcomes.filter((entry) => entry.job === CONTEXT_JOB)
  return facts
}
export function reviewContext(value) {
  value.privacy = { verdict: "approved", payload_sha256: contextPayloadHash(value), reviewer: { plugin_version: "3.2.0-alpha.1", rubric: "1" } }
  return value
}
export function contextRecord(facts = contextFacts(), job = CONTEXT_JOB) {
  const source = contextSource(facts, job)
  return reviewContext({
    schema: "desk.factory.context/1",
    job,
    evaluator: { plugin_version: "3.2.0-alpha.1", rubric: "1" },
    state: "published",
    heading: "Restore the device connection",
    events: [{
      id: "0123456789abcdef", kind: "work", lean: "support",
      explanation: "Tested the connection and recorded the observed behavior.",
      reason: null, prerequisite: null, resumption: null, confidence: "high",
      evidence: [{ session: source.session, source: source.sha256, anchor: "interval", range: [1000, 250000] }],
    }],
    sources: [source],
    coverage: { state: "measured", reasons: [], omitted_events: 0 },
    privacy: null,
  })
}
