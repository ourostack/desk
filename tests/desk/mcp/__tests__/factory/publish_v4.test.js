// The publishing transform writes published facts /4: each job's UTC finish day and its source, whether the session created each PR, and the
// stop facts of each human wait. Every input is synthetic.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { toPublished } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { FINISHED_ON_MIN, PUBLISHED_SCHEMA, validatePublished } from "../../../../../plugins/desk/mcp/src/factory/published-schema.js"
import { validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_GOLDEN = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
const SECRET = Buffer.alloc(32, 7)
const visibility = (repo) => (repo.startsWith("ourostack/") ? "public" : "unknown")

const JOB = "1a2b3c4d5e6f708192a3b4c5d6e7f809"

function local(jobs, extra = {}) {
  const value = structuredClone(LOCAL_GOLDEN)
  value.jobs = jobs
  Object.assign(value, extra)
  assert.deepEqual(validateLocalFacts(value).errors, [])
  return value
}

function publish(value, deskVisibility = "private") {
  const { published } = toPublished(value, { visibility, deskVisibility, machineSecret: SECRET })
  assert.equal(published.schema, PUBLISHED_SCHEMA)
  assert.equal(PUBLISHED_SCHEMA, "desk.factory.published/4")
  assert.deepEqual(validatePublished(published).errors, [])
  return published
}

const job = (fields) => ({ job: JOB, basis: ["desk_tool"], task_created_at: "2026-09-24T08:00:00.000Z", transitions: [], observed: null, ...fields })
const finish = (published) => published.jobs.map(({ finished_on: day, finished_basis: basis }) => ({ day, basis }))

test("every published file is /4, and the golden local file publishes valid /4 facts", () => {
  publish(structuredClone(LOCAL_GOLDEN))
})

test("a finished job's day is the UTC day of the session's last transition into the observed status", () => {
  const published = publish(local([job({
    transitions: [
      { to: "done", at: "2026-09-25T08:10:00.000Z" },
      { to: "processing", at: "2026-09-25T08:20:00.000Z" },
      // 23:30 in Pacific time on 25 September is 26 September in UTC.
      { to: "done", at: "2026-09-26T06:30:00.000Z" },
    ],
    observed: { status: "done", at: "2026-09-28T09:00:00.000Z" },
  })]))
  assert.deepEqual(finish(published), [{ day: "2026-09-26", basis: "transition" }])
})

test("with no transition into the observed status, the day is the card's update, an upper bound", () => {
  const published = publish(local([job({
    transitions: [{ to: "done", at: "2026-09-25T08:10:00.000Z" }],
    observed: { status: "cancelled", at: "2026-09-27T23:59:59.999Z" },
  })]))
  assert.deepEqual(finish(published), [{ day: "2026-09-27", basis: "card_updated" }])
})

test("an open job, a job with no observation and a job with no readable card creation time carry no day", () => {
  const published = publish(local([
    job({ job: "11111111111111111111111111111111", transitions: [{ to: "done", at: "2026-09-25T08:10:00.000Z" }], observed: { status: "processing", at: null } }),
    job({ job: "22222222222222222222222222222222", observed: null }),
    job({ job: "33333333333333333333333333333333", task_created_at: null, transitions: [{ to: "done", at: "2026-09-25T08:10:00.000Z" }], observed: { status: "done", at: "2026-09-25T09:00:00.000Z" } }),
    // A terminal card seen with no time and no transition says nothing about its day.
    job({ job: "44444444444444444444444444444444", observed: { status: "done", at: null } }),
  ]))
  assert.deepEqual(finish(published), Array(4).fill({ day: null, basis: null }))
})

test("a transition whose offset is lost cannot be the source; the card's update is used instead", () => {
  const published = publish(local([job({
    task_created_at: "2026-09-24T08:00:00.000Z",
    // More than ten years after the card's creation: the offset is withheld, so the transition is not published.
    transitions: [{ to: "done", at: "2037-01-01T00:00:00.000Z" }],
    observed: { status: "done", at: "2026-09-25T09:00:00.000Z" },
  })]))
  assert.deepEqual(finish(published), [{ day: "2026-09-25", basis: "card_updated" }])
})

test("a desk that withholds job timing publishes no finish day", () => {
  const published = publish(local([job({ transitions: [{ to: "done", at: "2026-09-25T08:10:00.000Z" }], observed: { status: "done", at: "2026-09-25T09:00:00.000Z" } })]), "public")
  assert.deepEqual(finish(published), [{ day: null, basis: null }])
})

const PRS = [
  { repo: "ourostack/desk", number: 1, agent: 0, created: true },
  { repo: "ourostack/desk", number: 2, agent: 0, created: false },
  // Written before the deriver kept the flag: nothing shows the session created it.
  { repo: "ourostack/desk", number: 3, agent: 0 },
]

test("a PR is marked created exactly when the local facts say the session created it", () => {
  const published = publish(local([], { refs: { ...LOCAL_GOLDEN.refs, prs: structuredClone(PRS) } }))
  assert.deepEqual(published.refs.prs.map(({ number, created }) => ({ number, created })), [{ number: 1, created: true }, { number: 2, created: false }, { number: 3, created: false }])
})

test("a desk that withholds job timing marks no PR created", () => {
  const published = publish(local([], { refs: { ...LOCAL_GOLDEN.refs, prs: structuredClone(PRS) } }), "public")
  assert.deepEqual(published.refs.prs.map(({ created }) => created), [false, false, false])
})

test("a human wait publishes its stop facts, and one derived before they were recorded says not_recorded", () => {
  const intervals = [
    { kind: "human_wait", agent: 0, start: "2026-09-25T08:01:00.000Z", end: "2026-09-25T08:02:00.000Z", stop: { end: "ask_question", asks: null, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: "2026-09-25T08:03:00.000Z", end: "2026-09-25T08:04:00.000Z", stop: { end: "end_turn", asks: true, pending_agents: false } },
    { kind: "human_wait", agent: 0, start: "2026-09-25T08:05:00.000Z", end: "2026-09-25T08:06:00.000Z" },
    { kind: "turn", agent: 0, start: "2026-09-25T08:06:00.000Z", end: "2026-09-25T08:07:00.000Z" },
  ]
  const published = publish(local([], { intervals }))
  assert.deepEqual(published.intervals, [
    { kind: "human_wait", agent: 0, start_ms: 60000, end_ms: 120000, stop: { end: "ask_question", asks: null, pending_agents: null } },
    { kind: "human_wait", agent: 0, start_ms: 180000, end_ms: 240000, stop: { end: "end_turn", asks: true, pending_agents: false } },
    { kind: "human_wait", agent: 0, start_ms: 300000, end_ms: 360000, stop: { end: "not_recorded", asks: null, pending_agents: null } },
    { kind: "turn", agent: 0, start_ms: 360000, end_ms: 420000 },
  ])
})

test("given the clock, a finish day after today is withheld, because the store refuses it; without it the transform reads no clock", () => {
  const value = local([job({ observed: { status: "done", at: "2026-10-09T00:00:00.000Z" } })])
  const at = (now) => finish(toPublished(value, { visibility, deskVisibility: "private", now }).published)
  assert.deepEqual(at(Date.parse("2026-10-08T23:59:59.999Z")), [{ day: null, basis: null }])
  assert.deepEqual(at(Date.parse("2026-10-09T00:00:00.000Z")), [{ day: "2026-10-09", basis: "card_updated" }])
  assert.deepEqual(at(undefined), [{ day: "2026-10-09", basis: "card_updated" }])
  assert.deepEqual(at(Number.NaN), [{ day: "2026-10-09", basis: "card_updated" }])
})

test("a finish day before the gate's earliest day is withheld, because the store refuses it, and the earliest day itself publishes", () => {
  assert.equal(FINISHED_ON_MIN, "2025-01-01")
  const before = local([job({ task_created_at: "2024-12-30T00:00:00.000Z", observed: { status: "done", at: "2024-12-31T23:00:00.000Z" } })])
  assert.deepEqual(finish(publish(before)), [{ day: null, basis: null }])
  const first = local([job({ task_created_at: "2024-12-30T00:00:00.000Z", observed: { status: "done", at: `${FINISHED_ON_MIN}T00:00:00.000Z` } })])
  assert.deepEqual(finish(publish(first)), [{ day: FINISHED_ON_MIN, basis: "card_updated" }])
})
