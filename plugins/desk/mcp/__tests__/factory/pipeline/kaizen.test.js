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

// A finished job at one Desk version with one value per measure, in a session of its own.
function job(n, version, values = {}, overrides = {}) {
  const measures = Object.fromEntries(MEASURE_IDS.map((id) => [id, id in values ? { value: values[id] } : { excluded: "not_in_fixture" }]))
  return { job: J(n), job_class: "other", finished: true, plugins: { desk: version === null ? null : { min: version, max: version } }, sessions: [`s${n}`], measures, ...overrides }
}

// Jobs numbered from `first`, one per tool_retries value, at `version`.
const retries = (first, version, values, overrides) => values.map((value, index) => job(first + index, version, { tool_retries: value }, overrides))
// Six jobs a side, before (alpha.44) and after (alpha.45) the card's version.
const sides = (before, after) => [...retries(1, "3.2.0-alpha.44", before), ...retries(101, "3.2.0-alpha.45", after)]
const FEWER = sides([10, 12, 11, 10, 12, 11], [2, 3, 2, 3, 2, 3])
const MORE = sides([1, 2, 1, 2, 1, 2], [8, 9, 8, 9, 8, 9])

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
    "job_class: other",
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
      job_class: "other",
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
  // A real job class that published facts cannot carry yet: the card says so instead of waiting forever.
  assert.deepEqual(codes(body(CARD.replace("job_class: any", "job_class: engineering"))), [{ code: "job_class_not_published", field: "job_class" }])
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
    ...retries(1, "3.2.0-alpha.43", [9, 10]),
    ...retries(3, "3.2.0-alpha.44", [11, 10, 12, 9]),
    ...retries(21, "3.2.0-alpha.45", [2, 3]),
    ...retries(23, "3.2.0-alpha.46", [1, 2]),
    ...retries(25, "3.2.0", [3, 2]),
    job(7, "3.2.0-alpha.44", { tool_retries: 0 }, { plugins: { desk: { min: "3.2.0-alpha.44", max: "3.2.0-alpha.45" } } }),
    job(8, null, { tool_retries: 0 }),
    job(9, "3.2.0-alpha.45", {}, { finished: false }),
    job(10, "3.2.0-alpha.45", {}),
    job(11, "3.2.0-alpha.45", { tool_retries: 0 }, { plugins: {} }),
  ]
  const result = checkCard(card, records, { seed: 17 })
  assert.equal(result.status, "checked")
  assert.equal(result.verdict, "confirmed")
  assert.deepEqual(result.comparison.before, { jobs: 6, groups: 6, median: 10 })
  assert.deepEqual(result.comparison.after, { jobs: 6, groups: 6, median: 2 })
  assert.equal(result.comparison.change, -8)
  assert.equal(result.comparison.direction, "down")
  assert.equal(result.jobs, 17)
  assert.deepEqual(result.excluded, [
    { reason: "mixed_versions", jobs: 1 },
    { reason: "not_in_fixture", jobs: 1 },
    { reason: "open_job", jobs: 1 },
    { reason: "plugin_not_reported", jobs: 2 },
  ])
})

test("checkCard tells too few independent jobs apart from no clear change, and labels not-confirmed only when the interval lies wholly the other way", () => {
  const { card } = parseCard(body(CARD))
  assert.equal(checkCard(card, MORE, { seed: 3 }).verdict, "not_confirmed")
  const unclear = sides([1, 9, 2, 8, 3, 7], [2, 8, 1, 9, 3, 7])
  const noChange = checkCard(card, unclear, { seed: 3 })
  assert.equal(noChange.verdict, "no_clear_change")
  assert.ok(noChange.comparison.interval[0] < 0 && noChange.comparison.interval[1] > 0)
  // Fully separated, but five jobs before: a 95% interval cannot exist yet.
  const thin = checkCard(card, sides([10, 12, 11, 10, 12], [2, 3, 2, 3, 2, 3]), { seed: 3 })
  assert.equal(thin.verdict, "too_few_jobs")
  assert.equal(thin.comparison.interval, null)
  const up = parseCard(body(CARD.replace("direction: down", "direction: up"))).card
  assert.equal(checkCard(up, MORE, { seed: 3 }).verdict, "confirmed")
})

test("checkCard counts jobs that share a session as one independent group", () => {
  const { card } = parseCard(body(CARD))
  // Six after jobs, but pairs share a session: three groups, so no verdict yet.
  const shared = [...retries(1, "3.2.0-alpha.44", [10, 12, 11, 10, 12, 11]), ...retries(101, "3.2.0-alpha.45", [2, 3, 2, 3, 2, 3]).map((record, index) => ({ ...record, sessions: [`shared${Math.floor(index / 2)}`] }))]
  const result = checkCard(card, shared, { seed: 3 })
  assert.deepEqual(result.comparison.after, { jobs: 6, groups: 3, median: 2 })
  assert.equal(result.verdict, "too_few_jobs")
  assert.match(kaizenComment({ card, result }), /\| After \(3\.2\.0-alpha\.45 or later\) \| 6 \| 3 \| 2 \|/u)
})

test("checkCard keeps to the card's job class unless it says any", () => {
  const { card } = parseCard(body(CARD.replace("job_class: any", "job_class: other")))
  const records = [job(1, "3.2.0-alpha.44", { tool_retries: 9 }), job(2, "3.2.0-alpha.45", { tool_retries: 1 }, { job_class: "review" })]
  const result = checkCard(card, records, { seed: 1 })
  assert.equal(result.jobs, 1)
  assert.deepEqual(result.comparison.after, { jobs: 0, groups: 0, median: null })
  assert.match(kaizenComment({ card, result }), /for finished `other` jobs whose every session ran/u)
})

test("kaizenComment renders each status in plain words behind the marker, with no dates", () => {
  const { card } = parseCard(body(CARD))
  const records = [...FEWER, job(5, "3.2.0-alpha.45", {}, { finished: false })]
  const checked = kaizenComment({ card, result: checkCard(card, records, { seed: 5 }) })
  assert.ok(checked.startsWith(`${KAIZEN_MARKER}\n### Kaizen check: confirmed\n`))
  assert.match(checked, /\| Before \(earlier than 3\.2\.0-alpha\.45\) \| 6 \| 6 \| 11 \|/u)
  assert.match(checked, /\| After \(3\.2\.0-alpha\.45 or later\) \| 6 \| 6 \| 2 \|/u)
  assert.match(checked, /- Change in median \(after minus before\): -9\./u)
  assert.match(checked, /Each side needs at least 6 groups, the fewest for which a distribution-free 95% interval for a median can exist\./u)
  assert.match(checked, /- 95% bootstrap interval: \[-?\d+, -\d+\]\./u)
  assert.match(checked, /- Jobs left out: open_job 1\./u)
  assert.doesNotMatch(checked, /\d{4}-\d{2}-\d{2}/u)
  assert.equal(checked, kaizenComment({ card, result: checkCard(card, records, { seed: 5 }) }), "byte-stable")

  const gathering = kaizenComment({ card, result: checkCard(card, [job(1, "3.2.0-alpha.44", { tool_retries: 10 })], { seed: 5 }) })
  assert.match(gathering, /### Kaizen check: not enough independent jobs yet/u)
  assert.match(gathering, /\| After \(3\.2\.0-alpha\.45 or later\) \| 0 \| 0 \| none \|/u)
  assert.match(gathering, /- Change in median \(after minus before\): none yet\./u)
  assert.match(gathering, /- 95% bootstrap interval: none yet; each side needs at least 6 independent groups of jobs for a 95% interval to exist\./u)
  assert.match(gathering, /- Jobs left out: none\./u)

  const durationCard = parseCard(body(CARD.replaceAll("tool_retries", "lead_time"))).card
  const leads = (first, version, values) => values.map((value, index) => job(first + index, version, { lead_time: value }))
  const durations = kaizenComment({ card: durationCard, result: checkCard(durationCard, [...leads(1, "3.2.0-alpha.44", [1000, 1200, 900, 1300, 1000, 1100]), ...leads(101, "3.2.0-alpha.45", [1000, 1300, 900, 1200, 1000, 1100])], { seed: 2 }) })
  assert.match(durations, /### Kaizen check: no clear change so far/u)
  assert.match(durations, /\| 1000 ms \|/u)
  assert.match(durations, /- Change in median \(after minus before\): 0 ms\./u)
  assert.match(durations, /- 95% bootstrap interval: \[-?\d+ ms, \d+ ms\]\./u)

  const notConfirmed = kaizenComment({ card, result: checkCard(card, MORE, { seed: 5 }) })
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
  const records = FEWER
  const confirmed = planCard({ number: 4, body: body(CARD), records })
  assert.equal(confirmed.status, "confirmed")
  assert.equal(confirmed.label, "confirmed")
  const broken = planCard({ number: 4, body: "no block", records })
  assert.equal(broken.status, "invalid")
  assert.equal(broken.label, null)
  assert.equal(planCard({ number: 4, body: body(CARD.replace("version: 3.2.0-alpha.45\n", "")), records }).status, "waiting_for_version")
  const worse = planCard({ number: 4, body: body(CARD.replace("direction: down", "direction: up")), records })
  assert.equal(worse.label, "not-confirmed")
  const thin = planCard({ number: 4, body: body(CARD), records: records.slice(0, 11) })
  assert.equal(thin.status, "too_few_jobs")
  assert.equal(thin.label, null)
})

test("syncKaizenCards keeps one comment per open card, updates it in place, fixes verdict labels and never closes a card", async () => {
  const records = FEWER
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
  assert.deepEqual(first, { cards: [{ number: 1, status: "confirmed", comment: "created", labels: ["confirmed"] }, { number: 2, status: "invalid", comment: "created", labels: [] }], failed: 0 })
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

test("syncKaizenCards reports a card whose calls fail with a stable code and still checks the others", async () => {
  const github = fakeIssues({
    issues: [
      { number: 1, title: "Too many comments", body: body(CARD), labels: ["kaizen"] },
      { number: 2, title: "Fine", body: body(CARD), labels: ["kaizen"] },
      { number: 3, title: "Odd failure", body: body(CARD), labels: ["kaizen"] },
    ],
  })
  const listComments = github.client.listComments
  github.client.listComments = async (number) => {
    if (number === 1) throw Object.assign(new Error("factory issues: too_many_comments"), { code: "too_many_comments" })
    if (number === 3) throw new Error("no code")
    return listComments(number)
  }
  const result = await syncKaizenCards({ client: github.client, records: FEWER })
  assert.deepEqual(result, {
    cards: [
      { number: 1, status: "failed", code: "too_many_comments" },
      { number: 2, status: "confirmed", comment: "created", labels: ["confirmed"] },
      { number: 3, status: "failed", code: "failed" },
    ],
    failed: 2,
  })
  assert.equal(github.botComments(2).length, 1)
})
