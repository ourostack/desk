import { test } from "node:test"
import assert from "node:assert/strict"

import { ANDON_MARKER, DISMISSED_LABEL, andonTitle, parseAndonTitle, parseStoreConfig, planAndon, syncAndon } from "../../../src/factory/pipeline/andon.js"
import { VERDICT_LABELS } from "../../../src/factory/pipeline/kaizen.js"
import { MEASURE_IDS, QUALITY_MEASURES } from "../../../src/factory/pipeline/rollups.js"
import { BOT, fakeIssues } from "./_fake_issues.js"

const J = (n) => String(n).padStart(32, "0")
const DESK = { plugins: ["desk"] }
let counter = 0

// A finished job, in a session of its own, whose every session ran `desk` at `version`, with tool_retries and the other quality measures.
function job(version, retries, overrides = {}) {
  counter += 1
  const values = { tool_retries: retries, tool_failures: 0, api_retries: 0, retouches: 0, "muda_time.defects": 0 }
  const measures = Object.fromEntries(MEASURE_IDS.map((id) => [id, id in values ? { value: values[id] } : { excluded: "not_in_fixture" }]))
  return { job: J(counter), job_class: "other", finished: true, plugins: { desk: { min: version, max: version } }, sessions: [`s${counter}`], measures, ...overrides }
}

const jobs = (version, values, overrides) => values.map((value) => job(version, value, overrides))
const LOW = [1, 2, 1, 2, 1, 2]
const HIGH = [8, 9, 10, 8, 9, 10]
const TITLE = "Andon: desk 1.1.0 tool_retries other"

test("parseStoreConfig reads the tracked plugins from the store's factory.json, and a store without one tracks none", () => {
  assert.deepEqual(parseStoreConfig(null), { ok: true, plugins: [] })
  assert.deepEqual(parseStoreConfig('{"andon":{"plugins":["superpowers","desk"]}}'), { ok: true, plugins: ["desk", "superpowers"] })
  assert.deepEqual(parseStoreConfig('{"andon":{"plugins":[]}}'), { ok: true, plugins: [] })
  assert.deepEqual(parseStoreConfig("{not json"), { ok: false, code: "invalid_json" })
  const invalid = [
    "null",
    "[]",
    '{"andon":{"plugins":["desk"]},"extra":1}',
    '{"andon":{"plugins":["desk"],"extra":1}}',
    '{"andon":[]}',
    '{"andon":{"plugins":"desk"}}',
    '{"andon":{"plugins":["Desk!"]}}',
    '{"andon":{"plugins":[7]}}',
    '{"andon":{"plugins":["desk","desk"]}}',
    JSON.stringify({ andon: { plugins: Array.from({ length: 65 }, (_, index) => `plugin-${index}`) } }),
  ]
  for (const text of invalid) assert.deepEqual(parseStoreConfig(text), { ok: false, code: "invalid_config" }, text)
})

test("andon titles name the plugin, version, measure and job class, and parse back only when well formed", () => {
  assert.equal(andonTitle("desk", "3.1.0-alpha.7", "tool_retries", "other"), "Andon: desk 3.1.0-alpha.7 tool_retries other")
  assert.deepEqual(parseAndonTitle("Andon: desk 3.1.0-alpha.7 tool_retries other"), { plugin: "desk", version: "3.1.0-alpha.7", measure: "tool_retries", jobClass: "other" })
  assert.deepEqual(parseAndonTitle("Andon: desk 1.0.0 muda_time.defects review"), { plugin: "desk", version: "1.0.0", measure: "muda_time.defects", jobClass: "review" })
  for (const title of ["Andon: desk 1.0 tool_retries other", "Andon: desk 1.0.0 lead_time other", "Andon: Desk! 1.0.0 tool_retries other", "andon: desk 1.0.0 tool_retries other", "Andon: desk 1.0.0 tool_retries sales", "Andon: desk 1.0.0 tool_retries", "Andon: desk 1.0.0 tool_retries other extra", ""]) {
    assert.equal(parseAndonTitle(title), null, title)
  }
})

test("planAndon fires for a tracked plugin's quality measure clearly worse on the latest version than the one before", () => {
  const records = [...jobs("1.0.0", LOW), ...jobs("1.1.0", HIGH)]
  const alarms = planAndon(records, DESK)
  assert.equal(alarms.length, 1)
  const [alarm] = alarms
  assert.equal(alarm.title, TITLE)
  assert.equal(alarm.baseline, "1.0.0")
  assert.equal(alarm.job_class, "other")
  assert.deepEqual(alarm.comparison.before, { jobs: 6, groups: 6, median: 1 })
  assert.deepEqual(alarm.comparison.after, { jobs: 6, groups: 6, median: 9 })
  assert.equal(alarm.comparison.direction, "up")
  assert.ok(alarm.body.startsWith(`${ANDON_MARKER}\n### Andon: \`tool_retries\` is clearly worse on \`desk\` 1.1.0 (job class \`other\`)\n`))
  assert.match(alarm.body, /\| Before \(1\.0\.0\) \| 6 \| 6 \| 1 \|/u)
  assert.match(alarm.body, /No other plugin's version changed between these two sets of jobs\./u)
  assert.match(alarm.body, /labels it `andon-dismissed`/u)
  for (const record of records) assert.ok(alarm.body.includes(record.job), "every compared job is listed as evidence")
  assert.doesNotMatch(alarm.body, /\d{4}-\d{2}-\d{2}/u)
  assert.deepEqual(planAndon(records, DESK), alarms, "byte-stable")
  assert.deepEqual(planAndon(records, { plugins: [] }), [], "an untracked plugin raises nothing, whatever its data")
})

test("planAndon does not fire below the minimum independent groups a side, for a better or unclear version, or on flow measures", () => {
  assert.deepEqual(planAndon([...jobs("1.0.0", [1, 2, 1, 2, 1]), ...jobs("1.1.0", HIGH)], DESK), [], "five jobs before is too few")
  // Six jobs after, but pairs share a session: three groups.
  const shared = jobs("1.1.0", HIGH).map((record, index) => ({ ...record, sessions: [`pair${Math.floor(index / 2)}`] }))
  assert.deepEqual(planAndon([...jobs("1.0.0", LOW), ...shared], DESK), [])
  assert.deepEqual(planAndon([...jobs("1.0.0", HIGH), ...jobs("1.1.0", LOW)], DESK), [])
  assert.deepEqual(planAndon([...jobs("1.0.0", [1, 9, 5, 2, 8, 4]), ...jobs("1.1.0", [2, 8, 5, 1, 9, 4])], DESK), [])
  assert.deepEqual(planAndon(jobs("1.0.0", LOW), DESK), [], "one version has nothing to compare")
  const flow = (version, lead) => job(version, 0, { measures: { ...job(version, 0).measures, lead_time: { value: lead } } })
  assert.deepEqual(planAndon([...LOW.map((value) => flow("1.0.0", value)), ...HIGH.map((value) => flow("1.1.0", value * 100))], DESK), [])
  assert.ok(QUALITY_MEASURES.every((id) => !id.startsWith("lead")))
})

test("planAndon compares the latest version with enough groups, not a newer version too thin to compare", () => {
  const records = [...jobs("1.0.0", LOW), ...jobs("1.1.0", HIGH), ...jobs("1.2.0", [1, 1])]
  const [alarm] = planAndon(records, DESK)
  assert.equal(alarm.title, TITLE)
  assert.equal(alarm.baseline, "1.0.0")
  // A thin version in between is skipped as a baseline too.
  const between = [...jobs("1.0.0", LOW), ...jobs("1.0.5", [30]), ...jobs("1.1.0", HIGH)]
  assert.equal(planAndon(between, DESK)[0].baseline, "1.0.0")
})

test("planAndon compares only finished single-version jobs, and raises one alarm per job class", () => {
  const straddling = job("1.0.0", 50, { plugins: { desk: { min: "1.0.0", max: "1.1.0" } } })
  const open = job("1.1.0", 50, { finished: false })
  const noPlugin = job("1.1.0", 50, { plugins: { desk: null } })
  const unmeasured = job("1.1.0", 0, { measures: Object.fromEntries(MEASURE_IDS.map((id) => [id, { excluded: "partial" }])) })
  const base = [...jobs("1.0.0", LOW), ...jobs("1.1.0", LOW)]
  assert.deepEqual(planAndon([...base, straddling, open, noPlugin, unmeasured], DESK), [])
  const review = [...jobs("1.0.0", LOW, { job_class: "review" }), ...jobs("1.1.0", HIGH, { job_class: "review" })]
  assert.deepEqual(planAndon([...base, ...review], DESK).map((alarm) => alarm.title), ["Andon: desk 1.1.0 tool_retries review"])
  const both = [...jobs("1.0.0", LOW), ...jobs("1.1.0", HIGH), ...review]
  assert.deepEqual(planAndon(both, DESK).map((alarm) => alarm.job_class), ["review", "other"], "job classes run in the catalog's order")
})

test("planAndon names the other plugins whose versions changed with the same jobs, and attributes the change to the version set", () => {
  const withOthers = (version, values, others) => jobs(version, values).map((record) => ({ ...record, plugins: { ...record.plugins, ...others } }))
  const records = [
    ...withOthers("1.0.0", LOW, { superpowers: { min: "6.4.1", max: "6.4.1" }, steady: { min: "2.0.0", max: "2.0.0" } }),
    ...withOthers("1.1.0", HIGH, { superpowers: { min: "6.4.2", max: "6.4.2" }, steady: { min: "2.0.0", max: "2.0.0" }, added: { min: "0.1.0", max: "0.2.0" } }),
  ]
  const [alarm] = planAndon(records, DESK)
  assert.match(alarm.body, /the change belongs to this set of versions, not necessarily to `desk` alone:/u)
  assert.match(alarm.body, /- `superpowers`: 6\.4\.1 before, 6\.4\.2 after\./u)
  assert.match(alarm.body, /- `added`: not reported before, 0\.1\.0, 0\.2\.0 after\./u)
  assert.doesNotMatch(alarm.body, /`steady`/u)
  // Some jobs lacking a plugin on one side is a change too, and "not reported" sorts last.
  const partly = [...withOthers("1.0.0", LOW, { extra: { min: "1.0.0", max: "1.0.0" } }).slice(0, 3), ...jobs("1.0.0", LOW).slice(3), ...withOthers("1.1.0", HIGH, { extra: { min: "1.0.0", max: "1.0.0" } })]
  assert.match(planAndon(partly, DESK)[0].body, /- `extra`: 1\.0\.0, not reported before, 1\.0\.0 after\./u)
  const reversed = [...withOthers("1.0.0", LOW, { extra: { min: "1.0.0", max: "1.0.0" } }), ...jobs("1.1.0", HIGH).slice(0, 3), ...withOthers("1.1.0", HIGH, { extra: { min: "1.0.0", max: "1.0.0" } }).slice(3)]
  assert.match(planAndon(reversed, DESK)[0].body, /- `extra`: 1\.0\.0 before, 1\.0\.0, not reported after\./u)
})

test("syncAndon opens one issue per alarm, never duplicates it and writes nothing when nothing changed", async () => {
  const records = [...jobs("1.0.0", LOW), ...jobs("1.1.0", HIGH)]
  const github = fakeIssues({ issues: [{ number: 1, title: TITLE, body: "a person's look-alike", labels: ["andon"], author: "someone" }] })
  const first = await syncAndon({ client: github.client, records, plugins: ["desk"] })
  assert.deepEqual(first, { tracked: ["desk"], alarms: [{ number: 2, title: TITLE, action: "opened" }], failed: 0 })
  assert.deepEqual(github.issue(2).labels, ["andon"])
  assert.equal(github.issue(1).body, "a person's look-alike", "an issue someone else opened is never touched")
  const writes = github.writes()
  const again = await syncAndon({ client: github.client, records, plugins: ["desk"] })
  assert.deepEqual(again.alarms, [{ number: 2, title: TITLE, action: "unchanged" }])
  assert.equal(github.writes(), writes)
  const more = [...records, ...jobs("1.1.0", [11])]
  assert.equal((await syncAndon({ client: github.client, records: more, plugins: ["desk"] })).alarms[0].action, "updated")
  assert.match(github.issue(2).body, /\| After \(1\.1\.0\) \| 7 \| 7 \|/u)
})

test("syncAndon closes its issue when a later version brings the measure back, and keeps it open until then", async () => {
  const regressed = [...jobs("1.0.0", LOW), ...jobs("1.1.0", HIGH)]
  const github = fakeIssues()
  const sync = (records) => syncAndon({ client: github.client, records, plugins: ["desk"] })
  await sync(regressed)
  // A later version with too few groups to compare leaves the alarm up and raised.
  const early = [...regressed, ...jobs("1.2.0", [1, 1, 1])]
  assert.deepEqual((await sync(early)).alarms, [{ number: 1, title: TITLE, action: "unchanged" }])
  assert.equal(github.issue(1).state, "open")
  // A later version still clearly worse than the baseline leaves the alarm up.
  const stillBad = [...regressed, ...jobs("1.2.0", HIGH)]
  assert.deepEqual((await sync(stillBad)).alarms.map((entry) => [entry.number, entry.action]), [[1, "unchanged"]])
  assert.equal(github.issue(1).state, "open")
  // More data on the regressed version, with the later version still worse, updates the open alarm in place.
  assert.deepEqual((await sync([...stillBad, ...jobs("1.1.0", [12])])).alarms.map((entry) => [entry.number, entry.action]), [[1, "updated"]])
  assert.match(github.issue(1).body, /\| After \(1\.1\.0\) \| 7 \| 7 \|/u)
  const fixed = [...regressed, ...jobs("1.2.0", LOW)]
  const result = await sync(fixed)
  assert.deepEqual(result.alarms.map((entry) => [entry.number, entry.action]), [[1, "closed"]])
  assert.equal(github.issue(1).state_reason, "completed")
  assert.match(github.botComments(1).at(-1).body, /1\.2\.0 brings `tool_retries` back; for `other` jobs it is no longer clearly worse than 1\.0\.0, the version before 1\.1\.0\./u)
  // Closed stays closed while nothing fires, and a closed issue is reopened if the same alarm fires again.
  assert.deepEqual((await sync(fixed)).alarms, [])
  assert.equal((await sync(regressed)).alarms[0].action, "reopened")
  assert.equal(github.issue(1).state, "open")
})

test("syncAndon never reopens a dismissed alarm, but posts its new numbers when they change", async () => {
  const regressed = [...jobs("1.0.0", LOW), ...jobs("1.1.0", HIGH)]
  const github = fakeIssues()
  const sync = (records) => syncAndon({ client: github.client, records, plugins: ["desk"] })
  await sync(regressed)
  assert.equal(DISMISSED_LABEL, "andon-dismissed")
  assert.ok(!Object.values(VERDICT_LABELS).includes(DISMISSED_LABEL), "dismissal has its own label, not a kaizen verdict")
  await github.client.addLabels(1, [DISMISSED_LABEL])
  assert.deepEqual((await sync(regressed)).alarms, [{ number: 1, title: TITLE, action: "dismissed" }], "an open dismissed issue is listed")
  await github.client.updateIssue(1, { state: "closed", state_reason: "not_planned" })
  const writes = github.writes()
  assert.deepEqual((await sync(regressed)).alarms, [], "a closed dismissed issue with the same numbers is not listed")
  assert.equal(github.writes(), writes)
  const grown = [...regressed, ...jobs("1.1.0", [30])]
  assert.deepEqual((await sync(grown)).alarms, [{ number: 1, title: TITLE, action: "dismissed-updated" }])
  assert.equal(github.issue(1).state, "closed", "never reopened")
  assert.match(github.issue(1).body, /\| After \(1\.1\.0\) \| 7 \| 7 \|/u)
  const note = github.botComments(1).at(-1).body
  assert.ok(note.startsWith(`${ANDON_MARKER}\nThis alarm was dismissed, so the build will not reopen it, but its numbers changed:\n\n### Andon:`))
  assert.equal(github.issues().length, 1)
})

test("syncAndon keeps an open dismissed alarm's numbers current when a later version is compared, and never closes it", async () => {
  const regressed = [...jobs("1.0.0", LOW), ...jobs("1.1.0", HIGH)]
  const github = fakeIssues()
  const sync = (records) => syncAndon({ client: github.client, records, plugins: ["desk"] })
  await sync(regressed)
  await github.client.addLabels(1, [DISMISSED_LABEL])
  const later = [...regressed, ...jobs("1.1.0", [40]), ...jobs("1.2.0", HIGH)]
  const result = await sync(later)
  assert.deepEqual(result.alarms.map((entry) => [entry.number, entry.action]), [[1, "dismissed-updated"]])
  assert.match(github.issue(1).body, /\| After \(1\.1\.0\) \| 7 \| 7 \|/u)
  const recovered = [...regressed, ...jobs("1.1.0", [40]), ...jobs("1.2.0", LOW)]
  assert.deepEqual((await sync(recovered)).alarms.map((entry) => [entry.number, entry.action]), [[1, "dismissed"]])
  assert.equal(github.issue(1).state, "open", "a dismissed alarm is the reviewer's to close")
})

test("syncAndon closes an alarm the data no longer shows, leaves one it cannot judge, and ignores untracked plugins, pull requests and titles it cannot read", async () => {
  const github = fakeIssues({
    issues: [
      { number: 1, title: TITLE, body: "old", labels: ["andon"] },
      { number: 2, title: "Andon: desk 1.1.0 retouches other", body: "old", labels: ["andon"], pull_request: true },
      { number: 3, title: "Andon: something else", body: "old", labels: ["andon"] },
      { number: 4, title: "Andon: desk 0.9.0 tool_failures other", body: "old", labels: ["andon"] },
      { number: 5, title: "Andon: other-plugin 1.0.0 tool_failures other", body: "old", labels: ["andon"] },
      { number: 6, title: TITLE, body: "a second copy", labels: ["andon"] },
      { number: 7, title: "Andon: desk 1.0.0 api_retries other", body: "old", labels: ["andon"] },
    ],
  })
  const calm = [...jobs("1.0.0", LOW), ...jobs("1.1.0", [1, 2, 2, 1, 2, 2])]
  const result = await syncAndon({ client: github.client, records: calm, plugins: ["desk"] })
  assert.deepEqual(result.alarms, [
    { number: 1, title: TITLE, action: "closed" },
    { number: 4, title: "Andon: desk 0.9.0 tool_failures other", action: "unchanged" },
    { number: 7, title: "Andon: desk 1.0.0 api_retries other", action: "unchanged" },
  ])
  assert.match(github.botComments(1).at(-1).body, /no longer clearly worse than 1\.0\.0 for `other` jobs/u)
  assert.equal(github.issue(4).state, "open", "a version with no comparable data is neither opened nor closed")
  assert.equal(github.issue(7).state, "open", "the first comparable version has no baseline to judge against")
  assert.equal(github.issue(5).state, "open", "an untracked plugin's issue is left alone")
  assert.equal(github.issue(2).state, "open")
  assert.equal(github.issue(3).state, "open")
  assert.equal(github.issue(6).state, "open", "only the first issue with a title is the alarm's")
})

test("syncAndon reports an issue whose calls fail with a stable code and goes on with the rest", async () => {
  const github = fakeIssues({ issues: [{ number: 1, title: "Andon: desk 1.1.0 api_retries other", body: "old", labels: ["andon"] }, { number: 2, title: "Andon: desk 1.1.0 retouches other", body: "old", labels: ["andon"] }] })
  const records = [...jobs("1.0.0", LOW), ...jobs("1.1.0", HIGH)]
  github.client.createIssue = async () => {
    throw Object.assign(new Error("factory issues: http_403"), { code: "http_403" })
  }
  const createComment = github.client.createComment
  github.client.createComment = async (number, body) => {
    if (number === 1) throw new Error("no code")
    return createComment(number, body)
  }
  const result = await syncAndon({ client: github.client, records, plugins: ["desk"] })
  assert.deepEqual(result, {
    tracked: ["desk"],
    alarms: [
      { number: 1, title: "Andon: desk 1.1.0 api_retries other", action: "failed", code: "failed" },
      { number: 2, title: "Andon: desk 1.1.0 retouches other", action: "closed" },
      { number: null, title: TITLE, action: "failed", code: "http_403" },
    ],
    failed: 2,
  })
})

test("syncAndon uses the given author for its own issues", async () => {
  const github = fakeIssues({ author: "other[bot]", issues: [{ number: 1, title: TITLE, body: "old", labels: ["andon"] }] })
  const records = [...jobs("1.0.0", LOW), ...jobs("1.1.0", LOW)]
  assert.deepEqual((await syncAndon({ client: github.client, records, plugins: ["desk"] })).alarms, [])
  assert.deepEqual((await syncAndon({ client: github.client, records, plugins: ["desk"], author: "other[bot]" })).alarms.map((alarm) => alarm.action), ["closed"])
  assert.equal(BOT, "github-actions[bot]")
})
