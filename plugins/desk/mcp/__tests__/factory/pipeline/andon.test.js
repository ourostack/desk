import { test } from "node:test"
import assert from "node:assert/strict"

import { ANDON_MARKER, andonTitle, parseAndonTitle, planAndon, syncAndon } from "../../../src/factory/pipeline/andon.js"
import { MEASURE_IDS, QUALITY_MEASURES } from "../../../src/factory/pipeline/rollups.js"
import { BOT, fakeIssues } from "./_fake_issues.js"

const J = (n) => String(n).padStart(32, "0")
let counter = 0

// A finished job whose every session ran `desk` at `version`, with tool_retries and the other quality measures.
function job(version, retries, overrides = {}) {
  counter += 1
  const values = { tool_retries: retries, tool_failures: 0, api_retries: 0, retouches: 0, "muda_time.defects": 0 }
  const measures = Object.fromEntries(MEASURE_IDS.map((id) => [id, id in values ? { value: values[id] } : { excluded: "not_in_fixture" }]))
  return { job: J(counter), job_class: "other", finished: true, plugins: { desk: { min: version, max: version } }, measures, ...overrides }
}

const jobs = (version, values, overrides) => values.map((value) => job(version, value, overrides))

test("andon titles name the plugin, version and measure, and parse back only when well formed", () => {
  assert.equal(andonTitle("desk", "3.2.0-alpha.95", "tool_retries"), "Andon: desk 3.2.0-alpha.95 tool_retries")
  assert.deepEqual(parseAndonTitle("Andon: desk 3.2.0-alpha.95 tool_retries"), { plugin: "desk", version: "3.2.0-alpha.95", measure: "tool_retries" })
  assert.deepEqual(parseAndonTitle("Andon: desk 1.0.0 muda_time.defects"), { plugin: "desk", version: "1.0.0", measure: "muda_time.defects" })
  for (const title of ["Andon: desk 1.0 tool_retries", "Andon: desk 1.0.0 lead_time", "Andon: Desk! 1.0.0 tool_retries", "andon: desk 1.0.0 tool_retries", "Andon: desk 1.0.0 tool_retries extra", ""]) {
    assert.equal(parseAndonTitle(title), null, title)
  }
})

test("planAndon fires for a quality measure clearly worse on the latest version than the one before", () => {
  const records = [...jobs("1.0.0", [1, 2, 1]), ...jobs("1.1.0", [8, 9, 10])]
  const alarms = planAndon(records)
  assert.equal(alarms.length, 1)
  const [alarm] = alarms
  assert.equal(alarm.title, "Andon: desk 1.1.0 tool_retries")
  assert.equal(alarm.baseline, "1.0.0")
  assert.equal(alarm.classes.length, 1)
  assert.equal(alarm.classes[0].job_class, "other")
  assert.deepEqual(alarm.classes[0].comparison.before, { jobs: 3, median: 1 })
  assert.deepEqual(alarm.classes[0].comparison.after, { jobs: 3, median: 9 })
  assert.equal(alarm.classes[0].comparison.direction, "up")
  assert.ok(alarm.body.startsWith(`${ANDON_MARKER}\n### Andon: \`tool_retries\` is clearly worse on \`desk\` 1.1.0\n`))
  for (const record of records) assert.ok(alarm.body.includes(record.job), "every compared job is listed as evidence")
  assert.doesNotMatch(alarm.body, /\d{4}-\d{2}-\d{2}/u)
  assert.deepEqual(planAndon(records), alarms, "byte-stable")
})

test("planAndon does not fire below two jobs a side, for a better or unclear version, or on flow measures", () => {
  assert.deepEqual(planAndon([...jobs("1.0.0", [1, 2, 1]), ...jobs("1.1.0", [9])]), [])
  assert.deepEqual(planAndon([...jobs("1.0.0", [9, 8, 9]), ...jobs("1.1.0", [1, 2])]), [])
  assert.deepEqual(planAndon([...jobs("1.0.0", [1, 9, 5]), ...jobs("1.1.0", [2, 8, 5])]), [])
  assert.deepEqual(planAndon(jobs("1.0.0", [1, 2])), [], "one version has nothing to compare")
  const flow = (version, lead) => job(version, 0, { measures: { ...job(version, 0).measures, lead_time: { value: lead } } })
  assert.deepEqual(planAndon([flow("1.0.0", 1), flow("1.0.0", 2), flow("1.1.0", 90), flow("1.1.0", 99)]), [])
  assert.ok(QUALITY_MEASURES.every((id) => !id.startsWith("lead")))
})

test("planAndon compares only finished single-version jobs, within each job class", () => {
  const straddling = job("1.0.0", 50, { plugins: { desk: { min: "1.0.0", max: "1.1.0" } } })
  const open = job("1.1.0", 50, { finished: false })
  const noPlugin = job("1.1.0", 50, { plugins: { desk: null } })
  const unmeasured = job("1.1.0", 0, { measures: Object.fromEntries(MEASURE_IDS.map((id) => [id, { excluded: "partial" }])) })
  const base = [...jobs("1.0.0", [1, 2, 1]), ...jobs("1.1.0", [1, 2])]
  assert.deepEqual(planAndon([...base, straddling, open, noPlugin, unmeasured]), [])
  const review = [...jobs("1.0.0", [1, 2], { job_class: "review" }), ...jobs("1.1.0", [9, 9], { job_class: "review" })]
  const [alarm] = planAndon([...base, ...review])
  assert.deepEqual(alarm.classes.map((entry) => entry.job_class), ["review"])
  const both = [...jobs("1.0.0", [1, 2]), ...jobs("1.1.0", [9, 8]), ...review]
  assert.deepEqual(planAndon(both)[0].classes.map((entry) => entry.job_class), ["review", "other"], "job classes run in the catalog's order")
})

test("syncAndon opens one issue per alarm, never duplicates it and writes nothing when nothing changed", async () => {
  const records = [...jobs("1.0.0", [1, 2, 1]), ...jobs("1.1.0", [8, 9, 10])]
  const github = fakeIssues({ issues: [{ number: 1, title: "Andon: desk 1.1.0 tool_retries", body: "a person's look-alike", labels: ["andon"], author: "someone" }] })
  const first = await syncAndon({ client: github.client, records })
  assert.deepEqual(first, { alarms: [{ number: 2, title: "Andon: desk 1.1.0 tool_retries", action: "opened" }] })
  assert.deepEqual(github.issue(2).labels, ["andon"])
  assert.equal(github.issue(1).body, "a person's look-alike", "an issue someone else opened is never touched")
  const writes = github.writes()
  const again = await syncAndon({ client: github.client, records })
  assert.deepEqual(again, { alarms: [{ number: 2, title: "Andon: desk 1.1.0 tool_retries", action: "unchanged" }] })
  assert.equal(github.writes(), writes)
  const more = [...records, ...jobs("1.1.0", [11])]
  assert.equal((await syncAndon({ client: github.client, records: more })).alarms[0].action, "updated")
  assert.match(github.issue(2).body, /\| After \(1\.1\.0\) \| 4 \|/u)
})

test("syncAndon closes its issue when a later version brings the measure back, and keeps it open until then", async () => {
  const regressed = [...jobs("1.0.0", [1, 2, 1]), ...jobs("1.1.0", [8, 9, 10])]
  const github = fakeIssues()
  await syncAndon({ client: github.client, records: regressed })
  // A later version with too little data leaves the alarm up.
  const early = [...regressed, ...jobs("1.2.0", [1])]
  assert.deepEqual((await syncAndon({ client: github.client, records: early })).alarms, [{ number: 1, title: "Andon: desk 1.1.0 tool_retries", action: "unchanged" }])
  assert.equal(github.issue(1).state, "open")
  // A later version still clearly worse than the baseline leaves it up too.
  const stillBad = [...regressed, ...jobs("1.2.0", [9, 9, 9])]
  assert.equal((await syncAndon({ client: github.client, records: stillBad })).alarms[0].action, "unchanged")
  assert.equal(github.issue(1).state, "open")
  // More data on the regressed version, with the later version still thin, updates the open alarm in place.
  const grown = [...early, ...jobs("1.1.0", [12])]
  assert.equal((await syncAndon({ client: github.client, records: grown })).alarms[0].action, "updated")
  assert.match(github.issue(1).body, /\| After \(1\.1\.0\) \| 4 \|/u)
  const fixed = [...regressed, ...jobs("1.2.0", [1, 2, 1])]
  const result = await syncAndon({ client: github.client, records: fixed })
  assert.deepEqual(result.alarms, [{ number: 1, title: "Andon: desk 1.1.0 tool_retries", action: "closed" }])
  assert.equal(github.issue(1).state, "closed")
  assert.equal(github.issue(1).state_reason, "completed")
  assert.match(github.botComments(1).at(-1).body, /1\.2\.0 brings `tool_retries` back/u)
  // Closed stays closed while nothing fires, and a closed issue is reopened if the same alarm fires again.
  assert.deepEqual((await syncAndon({ client: github.client, records: fixed })).alarms, [])
  assert.equal((await syncAndon({ client: github.client, records: regressed })).alarms[0].action, "reopened")
  assert.equal(github.issue(1).state, "open")
  assert.equal(github.issues().length, 1)
  // A reviewer who finds the alarm is not a real regression labels it not-confirmed and closes it:
  // the build then leaves it closed and unchanged, and never opens a second issue for it.
  await github.client.addLabels(1, ["not-confirmed"])
  await github.client.updateIssue(1, { state: "closed", state_reason: "not_planned" })
  assert.deepEqual((await syncAndon({ client: github.client, records: regressed })).alarms, [{ number: 1, title: "Andon: desk 1.1.0 tool_retries", action: "dismissed" }])
  assert.equal(github.issue(1).state, "closed")
  assert.equal(github.issues().length, 1)
})

test("syncAndon closes an alarm the data no longer shows, and ignores pull requests and titles it cannot read", async () => {
  const github = fakeIssues({
    issues: [
      { number: 1, title: "Andon: desk 1.1.0 tool_retries", body: "old", labels: ["andon"] },
      { number: 2, title: "Andon: desk 1.1.0 retouches", body: "old", labels: ["andon"], pull_request: true },
      { number: 3, title: "Andon: something else", body: "old", labels: ["andon"] },
      { number: 4, title: "Andon: desk 0.9.0 tool_failures", body: "old", labels: ["andon"] },
      { number: 5, title: "Andon: other-plugin 1.0.0 tool_failures", body: "old", labels: ["andon"] },
      { number: 6, title: "Andon: desk 1.1.0 tool_retries", body: "a second copy", labels: ["andon"] },
      { number: 7, title: "Andon: desk 1.1.0 api_retries", body: "old", labels: ["andon", "not-confirmed"] },
    ],
  })
  const calm = [...jobs("1.0.0", [1, 2, 1]), ...jobs("1.1.0", [1, 2, 2])]
  const result = await syncAndon({ client: github.client, records: calm })
  assert.deepEqual(result.alarms, [
    { number: 1, title: "Andon: desk 1.1.0 tool_retries", action: "closed" },
    { number: 4, title: "Andon: desk 0.9.0 tool_failures", action: "closed" },
    { number: 5, title: "Andon: other-plugin 1.0.0 tool_failures", action: "closed" },
    { number: 7, title: "Andon: desk 1.1.0 api_retries", action: "dismissed" },
  ])
  assert.equal(github.issue(7).state, "open", "a dismissed alarm is the reviewer's to close")
  assert.match(github.botComments(1).at(-1).body, /no longer clearly worse than 1\.0\.0/u)
  assert.match(github.botComments(4).at(-1).body, /no longer clearly worse than the version before it/u)
  assert.equal(github.issue(2).state, "open")
  assert.equal(github.issue(3).state, "open")
  assert.equal(github.issue(6).state, "open", "only the first issue with a title is the alarm's")
})

test("syncAndon uses the given author for its own issues", async () => {
  const github = fakeIssues({ author: "other[bot]", issues: [{ number: 1, title: "Andon: desk 1.1.0 tool_retries", body: "old", labels: ["andon"] }] })
  const records = [...jobs("1.0.0", [1, 2, 1]), ...jobs("1.1.0", [1, 2, 2])]
  assert.deepEqual((await syncAndon({ client: github.client, records })).alarms, [])
  assert.deepEqual((await syncAndon({ client: github.client, records, author: "other[bot]" })).alarms.map((alarm) => alarm.action), ["closed"])
  assert.equal(BOT, "github-actions[bot]")
})
