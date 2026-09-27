import { test } from "node:test"
import assert from "node:assert/strict"

import {
  KAIZEN_MARKER,
  checkCard,
  kaizenComment,
  parseCard,
  planCard,
  syncKaizenCards,
} from "../../../src/factory/pipeline/kaizen.js"
import { MEASURE_IDS } from "../../../src/factory/pipeline/rollups.js"
import { fakeIssues } from "./_fake_issues.js"

const J = (n) => String(n).padStart(32, "0")
const CARD = [
  "kaizen: 1",
  "signal: tool_retries            # a measureId from the catalog",
  "job_class: any",
  `evidence_jobs: [${J(1)}, ${J(2)}]`,
  "countermeasure: https://github.com/ourostack/desk/pull/123",
  "plugin: desk",
  "version: 3.2.0-alpha.45",
  "hypothesis: { measure: tool_retries, direction: down }",
].join("\n")
const body = (yaml, before = "Shell retries dominate.\n\n") => `${before}\`\`\`yaml\n${yaml}\n\`\`\`\n`

// A finished job at one Desk version with one value per measure.
function job(n, version, values = {}, overrides = {}) {
  const measures = Object.fromEntries(MEASURE_IDS.map((id) => [id, id in values ? { value: values[id] } : { excluded: "not_in_fixture" }]))
  return { job: J(n), job_class: "other", finished: true, plugins: { desk: version === null ? null : { min: version, max: version } }, measures, ...overrides }
}

test("parseCard reads the one fenced yaml block of the plan's card shape", () => {
  assert.deepEqual(parseCard(body(CARD)), {
    ok: true,
    card: {
      kaizen: 1,
      signal: "tool_retries",
      job_class: "any",
      evidence_jobs: [J(1), J(2)],
      countermeasure: "https://github.com/ourostack/desk/pull/123",
      plugin: "desk",
      version: "3.2.0-alpha.45",
      hypothesis: { measure: "tool_retries", direction: "down" },
    },
  })
})

test("parseCard accepts block-style lists and maps, quotes, yml fences, CRLF and optional keys left out", () => {
  const yaml = [
    "# a card before its countermeasure ships",
    "kaizen: 1",
    'signal: "muda_time.defects"',
    "job_class: engineering",
    "evidence_jobs:",
    `  - ${J(3)}`,
    "",
    "plugin: 'desk'",
    "version: ~",
    "hypothesis:",
    "  measure: muda_time.defects",
    "  direction: down",
  ].join("\r\n")
  const parsed = parseCard(`Intro\r\n\`\`\`yml\r\n${yaml}\r\n\`\`\`\r\n`)
  assert.deepEqual(parsed, {
    ok: true,
    card: {
      kaizen: 1,
      signal: "muda_time.defects",
      job_class: "engineering",
      evidence_jobs: [J(3)],
      countermeasure: null,
      plugin: "desk",
      version: null,
      hypothesis: { measure: "muda_time.defects", direction: "down" },
    },
  })
  const minimal = parseCard(body("kaizen: 1\nsignal: lead_time\njob_class: any\nplugin: desk\nevidence_jobs: []\ncountermeasure:\nhypothesis: {measure: lead_time, direction: up}"))
  assert.equal(minimal.ok, true)
  assert.deepEqual(minimal.card.evidence_jobs, [])
  const bare = parseCard(body("kaizen: 1\nsignal: lead_time\njob_class: any\nplugin: desk\nhypothesis: {measure: lead_time, direction: up}"))
  assert.deepEqual(bare.card.evidence_jobs, [])
  assert.equal(minimal.card.countermeasure, null)
  assert.equal(minimal.card.version, null)
})

test("parseCard reports stable codes, never the card's own text", () => {
  const codes = (text) => parseCard(text).errors
  assert.deepEqual(codes("No block here."), [{ code: "no_block" }])
  assert.deepEqual(codes(`${body(CARD)}${body(CARD, "")}`), [{ code: "multiple_blocks" }])
  assert.deepEqual(codes(body("")), [{ code: "missing_key", field: "kaizen" }, { code: "missing_key", field: "signal" }, { code: "missing_key", field: "job_class" }, { code: "missing_key", field: "plugin" }, { code: "missing_key", field: "hypothesis" }])
  const wrong = [
    "kaizen: 2",
    "signal: happiness",
    "job_class: sales",
    "evidence_jobs: [not-a-job]",
    "countermeasure: https://example.com/pull/1",
    "plugin: Desk!",
    "version: 3.2",
    "hypothesis: { measure: tool_retries, direction: sideways }",
  ].join("\n")
  assert.deepEqual(codes(body(wrong)), [
    { code: "unsupported_card_version", field: "kaizen" },
    { code: "unknown_measure", field: "signal" },
    { code: "invalid_job_class", field: "job_class" },
    { code: "invalid_evidence_jobs", field: "evidence_jobs" },
    { code: "invalid_countermeasure", field: "countermeasure" },
    { code: "invalid_plugin", field: "plugin" },
    { code: "invalid_version", field: "version" },
    { code: "invalid_hypothesis", field: "hypothesis" },
  ])
  assert.deepEqual(codes(body(CARD.replace("hypothesis: { measure: tool_retries, direction: down }", "hypothesis: { measure: happiness, direction: down, why: because }"))), [{ code: "invalid_hypothesis", field: "hypothesis" }])
  assert.deepEqual(codes(body(CARD.replace("hypothesis: { measure: tool_retries, direction: down }", "hypothesis: tool_retries"))), [{ code: "invalid_hypothesis", field: "hypothesis" }])
  assert.deepEqual(codes(body(CARD.replace(`evidence_jobs: [${J(1)}, ${J(2)}]`, "evidence_jobs: 7"))), [{ code: "invalid_evidence_jobs", field: "evidence_jobs" }])
  assert.deepEqual(codes(body(`${CARD}\nsecret_owner: someone`)), [{ code: "unknown_key", line: 9 }])
  assert.deepEqual(codes(body(`${CARD}\nplugin: desk`)), [{ code: "duplicate_key", line: 9 }])
  assert.deepEqual(codes(body(`${CARD}\njust some words`)), [{ code: "syntax", line: 9 }])
  assert.deepEqual(codes(body(`  kaizen: 1\n${CARD}`)), [{ code: "syntax", line: 1 }])
  assert.deepEqual(codes(body(CARD.replace("job_class: any", "job_class: [any"))), [{ code: "syntax", line: 3 }])
  assert.deepEqual(codes(body(CARD.replace("job_class: any", "job_class: { a: b"))), [{ code: "syntax", line: 3 }])
  assert.deepEqual(codes(body(CARD.replace("job_class: any", "job_class: {a}"))), [{ code: "syntax", line: 3 }])
  assert.deepEqual(codes(body(CARD.replace("job_class: any", 'job_class: "any'))), [{ code: "syntax", line: 3 }])
  // A nested line with nothing to nest under, and a nested line of the wrong kind.
  assert.deepEqual(codes(body(`${CARD.replace("plugin: desk", "plugin: desk\n  - extra")}`)), [{ code: "syntax", line: 7 }])
  assert.deepEqual(codes(body(CARD.replace("hypothesis: { measure: tool_retries, direction: down }", "hypothesis:\n  measure: tool_retries\n  - down"))), [{ code: "syntax", line: 10 }])
  assert.deepEqual(codes(body(CARD.replace("hypothesis: { measure: tool_retries, direction: down }", "hypothesis:\n  measure: tool_retries\n  measure: tool_failures"))), [{ code: "syntax", line: 10 }])
  assert.deepEqual(codes(body(CARD.replace("hypothesis: { measure: tool_retries, direction: down }", "hypothesis:\n  just words"))), [{ code: "syntax", line: 9 }])
  assert.deepEqual(codes(body(CARD.replace("job_class: any", "job_class: an]y"))), [{ code: "syntax", line: 3 }])
  assert.deepEqual(codes(body(CARD.replace(`evidence_jobs: [${J(1)}, ${J(2)}]`, `evidence_jobs: [${J(1)}, [${J(2)}]]`))), [{ code: "syntax", line: 4 }])
  assert.deepEqual(codes(body(CARD.replace(`evidence_jobs: [${J(1)}, ${J(2)}]`, `evidence_jobs: [${J(1)}, , ${J(2)}]`))), [{ code: "syntax", line: 4 }])
  assert.deepEqual(codes(body(CARD.replace("hypothesis: { measure: tool_retries, direction: down }", "hypothesis: { measure: tool_retries, measure: down }"))), [{ code: "syntax", line: 8 }])
  assert.deepEqual(codes(body(CARD.replace(`evidence_jobs: [${J(1)}, ${J(2)}]`, `evidence_jobs:\n  - ${J(1)}\n  job: ${J(2)}`))), [{ code: "syntax", line: 6 }])
  assert.deepEqual(codes(body(CARD.replace(`evidence_jobs: [${J(1)}, ${J(2)}]`, "evidence_jobs:\n  -"))), [{ code: "invalid_evidence_jobs", field: "evidence_jobs" }], "a bare dash is a null item")
  assert.deepEqual(codes(body(CARD.replace("hypothesis: { measure: tool_retries, direction: down }", "hypothesis: { measure:, direction: down }"))), [{ code: "invalid_hypothesis", field: "hypothesis" }])
  assert.deepEqual(codes(body(`${"x".repeat(5000)}`)), [{ code: "too_large" }])
  assert.equal(JSON.stringify(parseCard(body(`${CARD}\nsecret_owner: someone`))).includes("someone"), false)
  assert.equal(JSON.stringify(parseCard(null)), JSON.stringify({ ok: false, errors: [{ code: "no_block" }] }))
})

test("checkCard waits for a version before comparing anything", () => {
  const { card } = parseCard(body(CARD.replace("version: 3.2.0-alpha.45", "version: null")))
  assert.deepEqual(checkCard(card, [job(1, "3.2.0-alpha.44", { tool_retries: 3 })], { seed: 1 }), { status: "waiting_for_version" })
})

test("checkCard compares finished jobs wholly before and wholly on or after the version, excluding mixed-version jobs", () => {
  const { card } = parseCard(body(CARD))
  const records = [
    job(1, "3.2.0-alpha.43", { tool_retries: 9 }),
    job(2, "3.2.0-alpha.44", { tool_retries: 10 }),
    job(3, "3.2.0-alpha.44", { tool_retries: 11 }),
    job(4, "3.2.0-alpha.45", { tool_retries: 2 }),
    job(5, "3.2.0-alpha.46", { tool_retries: 3 }),
    job(6, "3.2.0", { tool_retries: 1 }),
    job(7, "3.2.0-alpha.44", { tool_retries: 0 }, { plugins: { desk: { min: "3.2.0-alpha.44", max: "3.2.0-alpha.45" } } }),
    job(8, null, { tool_retries: 0 }),
    job(9, "3.2.0-alpha.45", {}, { finished: false }),
    job(10, "3.2.0-alpha.45", {}),
    job(11, "3.2.0-alpha.45", { tool_retries: 0 }, { plugins: {} }),
  ]
  const result = checkCard(card, records, { seed: 17 })
  assert.equal(result.status, "checked")
  assert.equal(result.verdict, "confirmed")
  assert.deepEqual(result.comparison.before, { jobs: 3, median: 10 })
  assert.deepEqual(result.comparison.after, { jobs: 3, median: 2 })
  assert.equal(result.comparison.change, -8)
  assert.equal(result.comparison.direction, "down")
  assert.equal(result.jobs, 11)
  assert.deepEqual(result.excluded, [
    { reason: "mixed_versions", jobs: 1 },
    { reason: "not_in_fixture", jobs: 1 },
    { reason: "open_job", jobs: 1 },
    { reason: "plugin_not_reported", jobs: 2 },
  ])
})

test("checkCard labels not-confirmed only when the interval lies wholly the other way, and keeps gathering otherwise", () => {
  const { card } = parseCard(body(CARD))
  const worse = [job(1, "3.2.0-alpha.44", { tool_retries: 1 }), job(2, "3.2.0-alpha.44", { tool_retries: 2 }), job(3, "3.2.0-alpha.45", { tool_retries: 8 }), job(4, "3.2.0-alpha.45", { tool_retries: 9 })]
  assert.equal(checkCard(card, worse, { seed: 3 }).verdict, "not_confirmed")
  const unclear = [job(1, "3.2.0-alpha.44", { tool_retries: 1 }), job(2, "3.2.0-alpha.44", { tool_retries: 9 }), job(3, "3.2.0-alpha.45", { tool_retries: 2 }), job(4, "3.2.0-alpha.45", { tool_retries: 8 })]
  assert.equal(checkCard(card, unclear, { seed: 3 }).verdict, "gathering")
  const thin = [job(1, "3.2.0-alpha.44", { tool_retries: 9 }), job(2, "3.2.0-alpha.45", { tool_retries: 1 })]
  const one = checkCard(card, thin, { seed: 3 })
  assert.equal(one.verdict, "gathering")
  assert.equal(one.comparison.interval, null, "one job a side is never a verdict")
  const up = parseCard(body(CARD.replace("direction: down", "direction: up"))).card
  assert.equal(checkCard(up, worse, { seed: 3 }).verdict, "confirmed")
})

test("checkCard keeps to the card's job class unless it says any", () => {
  const { card } = parseCard(body(CARD.replace("job_class: any", "job_class: review")))
  const records = [job(1, "3.2.0-alpha.44", { tool_retries: 9 }), job(2, "3.2.0-alpha.45", { tool_retries: 1 }, { job_class: "review" })]
  const result = checkCard(card, records, { seed: 1 })
  assert.equal(result.jobs, 1)
  assert.deepEqual(result.comparison.before, { jobs: 0, median: null })
  assert.match(kaizenComment({ card, result }), /for finished `review` jobs whose every session ran/u)
})

test("kaizenComment renders each status in plain words behind the marker, with no dates", () => {
  const { card } = parseCard(body(CARD))
  const records = [job(1, "3.2.0-alpha.44", { tool_retries: 10 }), job(2, "3.2.0-alpha.44", { tool_retries: 12 }), job(3, "3.2.0-alpha.45", { tool_retries: 2 }), job(4, "3.2.0-alpha.45", { tool_retries: 3 }), job(5, "3.2.0-alpha.45", {}, { finished: false })]
  const checked = kaizenComment({ card, result: checkCard(card, records, { seed: 5 }) })
  assert.ok(checked.startsWith(`${KAIZEN_MARKER}\n### Kaizen check: confirmed\n`))
  assert.match(checked, /\| Before \(earlier than 3\.2\.0-alpha\.45\) \| 2 \| 10 \|/u)
  assert.match(checked, /\| After \(3\.2\.0-alpha\.45 or later\) \| 2 \| 2 \|/u)
  assert.match(checked, /- Change in median \(after minus before\): -8\./u)
  assert.match(checked, /- 95% bootstrap interval: \[-?\d+, -\d+\]\./u)
  assert.match(checked, /- Jobs left out: open_job 1\./u)
  assert.doesNotMatch(checked, /\d{4}-\d{2}-\d{2}/u)
  assert.equal(checked, kaizenComment({ card, result: checkCard(card, records, { seed: 5 }) }), "byte-stable")

  const gathering = kaizenComment({ card, result: checkCard(card, [job(1, "3.2.0-alpha.44", { tool_retries: 10 })], { seed: 5 }) })
  assert.match(gathering, /### Kaizen check: still gathering data/u)
  assert.match(gathering, /\| After \(3\.2\.0-alpha\.45 or later\) \| 0 \| none \|/u)
  assert.match(gathering, /- Change in median \(after minus before\): none yet\./u)
  assert.match(gathering, /- 95% bootstrap interval: none yet; each side needs at least 2 finished jobs\./u)
  assert.match(gathering, /- Jobs left out: none\./u)

  const durationCard = parseCard(body(CARD.replaceAll("tool_retries", "lead_time"))).card
  const durations = kaizenComment({ card: durationCard, result: checkCard(durationCard, [job(1, "3.2.0-alpha.44", { lead_time: 1000 }), job(2, "3.2.0-alpha.44", { lead_time: 1200 }), job(3, "3.2.0-alpha.45", { lead_time: 1000 }), job(4, "3.2.0-alpha.45", { lead_time: 1300 })], { seed: 2 }) })
  assert.match(durations, /### Kaizen check: still gathering data/u)
  assert.match(durations, /\| 1000 ms \|/u)
  assert.match(durations, /- Change in median \(after minus before\): 0 ms\./u)
  assert.match(durations, /- 95% bootstrap interval: \[-?\d+ ms, \d+ ms\]\./u)

  const notConfirmed = kaizenComment({ card, result: checkCard(card, [job(1, "3.2.0-alpha.44", { tool_retries: 1 }), job(2, "3.2.0-alpha.44", { tool_retries: 2 }), job(3, "3.2.0-alpha.45", { tool_retries: 8 }), job(4, "3.2.0-alpha.45", { tool_retries: 9 })], { seed: 5 }) })
  assert.match(notConfirmed, /### Kaizen check: not confirmed/u)

  const waiting = kaizenComment({ card, result: { status: "waiting_for_version" } })
  assert.match(waiting, /### Kaizen check: waiting for the countermeasure's version/u)
  const errors = kaizenComment({ errors: [{ code: "syntax", line: 3 }, { code: "missing_key", field: "plugin" }, { code: "no_block" }] })
  assert.match(errors, /### Kaizen check: the card has errors/u)
  assert.match(errors, /- `syntax` on line 3 of the block/u)
  assert.match(errors, /- `missing_key` in `plugin`/u)
  assert.match(errors, /- `no_block`$/mu)
})

test("planCard turns an issue into its comment and the verdict label it should carry", () => {
  const records = [job(1, "3.2.0-alpha.44", { tool_retries: 10 }), job(2, "3.2.0-alpha.44", { tool_retries: 12 }), job(3, "3.2.0-alpha.45", { tool_retries: 2 }), job(4, "3.2.0-alpha.45", { tool_retries: 3 })]
  const confirmed = planCard({ number: 4, body: body(CARD), records })
  assert.equal(confirmed.status, "confirmed")
  assert.equal(confirmed.label, "confirmed")
  const broken = planCard({ number: 4, body: "no block", records })
  assert.equal(broken.status, "invalid")
  assert.equal(broken.label, null)
  assert.equal(planCard({ number: 4, body: body(CARD.replace("version: 3.2.0-alpha.45\n", "")), records }).status, "waiting_for_version")
  const worse = planCard({ number: 4, body: body(CARD.replace("direction: down", "direction: up")), records })
  assert.equal(worse.label, "not-confirmed")
  assert.equal(planCard({ number: 4, body: body(CARD), records: records.slice(0, 3) }).label, null)
})

test("syncKaizenCards keeps one comment per open card, updates it in place, fixes verdict labels and never closes a card", async () => {
  const records = [job(1, "3.2.0-alpha.44", { tool_retries: 10 }), job(2, "3.2.0-alpha.44", { tool_retries: 12 }), job(3, "3.2.0-alpha.45", { tool_retries: 2 }), job(4, "3.2.0-alpha.45", { tool_retries: 3 })]
  const github = fakeIssues({
    issues: [
      { number: 1, title: "Retries", body: body(CARD), labels: ["kaizen", "not-confirmed"] },
      { number: 2, title: "Broken", body: "nothing", labels: ["kaizen", "confirmed"] },
      { number: 3, title: "Closed", body: body(CARD), labels: ["kaizen"], state: "closed" },
      { number: 4, title: "Not a card", body: body(CARD), labels: [] },
      { number: 5, title: "A pull request", body: body(CARD), labels: ["kaizen"], pull_request: true },
    ],
    comments: { 1: [{ user: "someone", body: `${KAIZEN_MARKER}\nquoted by a person` }] },
  })
  const first = await syncKaizenCards({ client: github.client, records })
  assert.deepEqual(first, { cards: [{ number: 1, status: "confirmed", comment: "created", labels: ["confirmed"] }, { number: 2, status: "invalid", comment: "created", labels: [] }] })
  assert.deepEqual(github.issue(1).labels, ["kaizen", "confirmed"])
  assert.deepEqual(github.issue(2).labels, ["kaizen"])
  assert.equal(github.botComments(1).length, 1)
  assert.equal(github.comments(1)[0].body, `${KAIZEN_MARKER}\nquoted by a person`, "a person's comment is never edited")
  assert.equal(github.issue(1).state, "open")
  assert.equal(github.botComments(3).length + github.botComments(4).length + github.botComments(5).length, 0)

  const again = await syncKaizenCards({ client: github.client, records })
  assert.deepEqual(again.cards.map((card) => card.comment), ["unchanged", "unchanged"])
  const writes = github.writes()
  await syncKaizenCards({ client: github.client, records })
  assert.equal(github.writes(), writes, "an unchanged build writes nothing")

  const more = [...records, job(6, "3.2.0-alpha.45", {}, { finished: false })]
  const updated = await syncKaizenCards({ client: github.client, records: more })
  assert.equal(updated.cards[0].comment, "updated")
  assert.equal(github.botComments(1).length, 1)
  assert.match(github.botComments(1)[0].body, /open_job 1/u)
})
