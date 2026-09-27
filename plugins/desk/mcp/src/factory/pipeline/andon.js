// Andon: the build stops the line when a plugin version makes quality
// clearly worse.
//
// On every build, for each plugin, the latest version with finished jobs is
// compared with the version before it that has finished jobs, for each
// quality measure (`QUALITY_MEASURES`) within each job class. Only finished
// jobs whose every session ran exactly one version of the plugin count.
// When `compareMedians`' 95% bootstrap interval for the change in median
// lies wholly on the worse side of zero (every quality measure is worse when
// it goes up), the build opens an issue labeled `andon` titled `Andon:
// <plugin> <version> <measure>`, or updates or reopens the one it opened
// before; it never opens a second issue with the same title. The body gives
// the numbers per job class and every compared job as evidence.
//
// The build closes its own andon issue, with a comment saying why, when:
//   - a later version brings the measure back: in every job class where the
//     alarm's version is clearly worse than its baseline, the latest
//     version has at least two jobs and is no longer clearly worse than
//     that baseline; or
//   - the data no longer shows the alarm's version clearly worse than its
//     baseline in any class.
// An andon issue a reviewer labeled `not-confirmed` has been judged not to be
// a real regression: the build leaves it as it is, open or closed, and
// reports it as `dismissed`. Only issues the build's own account opened are read or changed. Quality
// comes first: andon watches quality measures only, so no flow gain can
// offset a quality regression. There is no fixed percentage or job count
// beyond the comparison's own two jobs a side. Nothing here names a person,
// date or time.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { PATTERNS } from "../schema.js"
import { CONFIDENCE, MIN_JOBS_PER_SIDE, compareMedians, seedFromText } from "./compare.js"
import { JOB_CLASSES, QUALITY_MEASURES, formatMeasure } from "./rollups.js"
import { compareVersions, isVersion } from "./versions.js"

export const ANDON_LABEL = "andon"
export const ANDON_MARKER = "<!-- desk-andon -->"
export const DISMISSED_LABEL = "not-confirmed"
const BOT_LOGIN = "github-actions[bot]"
const WORSE = "up"

/** `andonTitle(plugin, version, measure) -> string`: the one title an alarm's issue has. */
export function andonTitle(plugin, version, measure) {
  return `Andon: ${plugin} ${version} ${measure}`
}

/** `parseAndonTitle(title) -> { plugin, version, measure } | null`: the parts of a well-formed andon title. */
export function parseAndonTitle(title) {
  const parts = /^Andon: (\S+) (\S+) (\S+)$/u.exec(title)
  if (parts === null || !PATTERNS.pluginName.test(parts[1]) || !isVersion(parts[2]) || !QUALITY_MEASURES.includes(parts[3])) return null
  return { plugin: parts[1], version: parts[2], measure: parts[3] }
}

// Finished jobs that ran exactly one version of `plugin`, by version, oldest first.
function jobsByVersion(records, plugin) {
  const byVersion = new Map()
  for (const record of records) {
    const range = record.plugins[plugin] ?? null
    if (!record.finished || range === null || range.min !== range.max) continue
    if (!byVersion.has(range.min)) byVersion.set(range.min, [])
    byVersion.get(range.min).push(record)
  }
  return new Map([...byVersion.entries()].sort(([left], [right]) => compareVersions(left, right)))
}

function measured(records, measure, jobClass) {
  return records.filter((record) => record.job_class === jobClass && "value" in record.measures[measure])
}

// Each job class where `after` is clearly worse than `before` on `measure`.
function worseClasses({ plugin, measure, before, after, version, baseline }) {
  return JOB_CLASSES.flatMap((jobClass) => {
    const beforeJobs = measured(before, measure, jobClass)
    const afterJobs = measured(after, measure, jobClass)
    const seed = seedFromText(`${plugin} ${baseline} ${version} ${measure} ${jobClass}`)
    const comparison = compareMedians(beforeJobs.map((record) => record.measures[measure].value), afterJobs.map((record) => record.measures[measure].value), { seed })
    if (comparison.direction !== WORSE) return []
    return [{ job_class: jobClass, comparison, before_jobs: beforeJobs.map((record) => record.job).sort(), after_jobs: afterJobs.map((record) => record.job).sort() }]
  })
}

function renderBody({ plugin, version, baseline, measure, classes }) {
  const format = (value) => formatMeasure(measure, value)
  return [
    ANDON_MARKER,
    `### Andon: \`${measure}\` is clearly worse on \`${plugin}\` ${version}`,
    "",
    `The build compared finished jobs whose every session ran \`${plugin}\` ${version} with those whose every session ran ${baseline}, the version before it with finished jobs. In each job class below, the whole ${CONFIDENCE * 100}% bootstrap interval for the change in median lies on the worse side of zero.`,
    "",
    ...classes.flatMap(({ job_class: jobClass, comparison, before_jobs: beforeJobs, after_jobs: afterJobs }) => [
      `#### Job class \`${jobClass}\``,
      "",
      "| Jobs | Count | Median |",
      "| --- | ---: | ---: |",
      `| Before (${baseline}) | ${comparison.before.jobs} | ${format(comparison.before.median)} |`,
      `| After (${version}) | ${comparison.after.jobs} | ${format(comparison.after.median)} |`,
      "",
      `- Change in median (after minus before): ${format(comparison.change)}.`,
      `- ${CONFIDENCE * 100}% bootstrap interval: [${format(comparison.interval[0])}, ${format(comparison.interval[1])}].`,
      `- Evidence jobs on ${baseline}: ${beforeJobs.map((job) => `\`${job}\``).join(", ")}.`,
      `- Evidence jobs on ${version}: ${afterJobs.map((job) => `\`${job}\``).join(", ")}.`,
      "",
    ]),
    `The build closes this issue itself when a later version brings the measure back: when, in every job class above, that version has at least ${MIN_JOBS_PER_SIDE} finished jobs and is no longer clearly worse than ${baseline}. Andon watches quality measures, so no flow gain offsets this.`,
    "",
  ].join("\n")
}

function versionsFor(records, plugin) {
  const byVersion = jobsByVersion(records, plugin)
  return { byVersion, versions: [...byVersion.keys()] }
}

/**
 * `planAndon(records) -> alarms`: every alarm the latest versions raise, as
 * `{ plugin, version, baseline, measure, title, classes, body }`, ordered by
 * plugin and then by `QUALITY_MEASURES`' order. `records` are the rollups'
 * job records.
 */
export function planAndon(records) {
  const plugins = [...new Set(records.flatMap((record) => Object.keys(record.plugins)))].sort()
  return plugins.flatMap((plugin) => {
    const { byVersion, versions } = versionsFor(records, plugin)
    if (versions.length < 2) return []
    const version = versions.at(-1)
    const baseline = versions.at(-2)
    return QUALITY_MEASURES.flatMap((measure) => {
      const classes = worseClasses({ plugin, measure, before: byVersion.get(baseline), after: byVersion.get(version), version, baseline })
      if (classes.length === 0) return []
      return [{ plugin, version, baseline, measure, title: andonTitle(plugin, version, measure), classes, body: renderBody({ plugin, version, baseline, measure, classes }) }]
    })
  })
}

// What should happen to an open alarm the latest versions no longer raise.
function reviewAlarm(records, { plugin, version, measure }) {
  const { byVersion, versions } = versionsFor(records, plugin)
  const at = versions.indexOf(version)
  const baseline = at > 0 ? versions[at - 1] : null
  const classes = baseline === null ? [] : worseClasses({ plugin, measure, before: byVersion.get(baseline), after: byVersion.get(version), version, baseline })
  if (classes.length === 0) {
    const against = baseline === null ? "the version before it" : baseline
    return { close: `${ANDON_MARKER}\nClosed by the build: with the data now in the store, \`${measure}\` on \`${plugin}\` ${version} is no longer clearly worse than ${against}.\n` }
  }
  const latest = versions.at(-1)
  const recovered = latest !== version && classes.every(({ job_class: jobClass }) => {
    const beforeValues = measured(byVersion.get(baseline), measure, jobClass).map((record) => record.measures[measure].value)
    const latestValues = measured(byVersion.get(latest), measure, jobClass).map((record) => record.measures[measure].value)
    const comparison = compareMedians(beforeValues, latestValues, { seed: seedFromText(`${plugin} ${baseline} ${latest} ${measure} ${jobClass}`) })
    return comparison.interval !== null && comparison.direction !== WORSE
  })
  if (recovered) {
    return { close: `${ANDON_MARKER}\nClosed by the build: ${latest} brings \`${measure}\` back; in every job class where ${version} was clearly worse than ${baseline}, ${latest}'s jobs no longer are.\n` }
  }
  return { body: renderBody({ plugin, version, baseline, measure, classes }) }
}

/**
 * `syncAndon({ client, records, author }) -> { alarms }`: opens, updates,
 * reopens and closes the build's andon issues through `client`
 * (`store-issues.js`). Each entry is `{ number, title, action }` with
 * `action` one of `opened`, `updated`, `reopened`, `closed`, `dismissed` or `unchanged`,
 * ordered by issue number. Issues not opened by `author`, pull requests
 * and titles that do not parse are left alone.
 */
export async function syncAndon({ client, records, author = BOT_LOGIN }) {
  const own = (await client.listIssues({ label: ANDON_LABEL, state: "all" }))
    .filter((issue) => !issue.pull_request && issue.author === author && parseAndonTitle(issue.title) !== null)
    .sort((left, right) => left.number - right.number)
  const byTitle = new Map()
  for (const issue of own) if (!byTitle.has(issue.title)) byTitle.set(issue.title, issue)
  const results = []
  const raised = new Set()
  for (const alarm of planAndon(records)) {
    raised.add(alarm.title)
    const issue = byTitle.get(alarm.title)
    if (issue !== undefined && issue.labels.includes(DISMISSED_LABEL)) {
      results.push({ number: issue.number, title: alarm.title, action: "dismissed" })
    } else if (issue === undefined) {
      const created = await client.createIssue({ title: alarm.title, body: alarm.body, labels: [ANDON_LABEL] })
      results.push({ number: created.number, title: alarm.title, action: "opened" })
    } else if (issue.state === "closed") {
      await client.updateIssue(issue.number, { state: "open", body: alarm.body })
      results.push({ number: issue.number, title: alarm.title, action: "reopened" })
    } else if (issue.body !== alarm.body) {
      await client.updateIssue(issue.number, { body: alarm.body })
      results.push({ number: issue.number, title: alarm.title, action: "updated" })
    } else {
      results.push({ number: issue.number, title: alarm.title, action: "unchanged" })
    }
  }
  for (const issue of byTitle.values()) {
    if (issue.state !== "open" || raised.has(issue.title)) continue
    if (issue.labels.includes(DISMISSED_LABEL)) {
      results.push({ number: issue.number, title: issue.title, action: "dismissed" })
      continue
    }
    const review = reviewAlarm(records, parseAndonTitle(issue.title))
    if (review.close !== undefined) {
      await client.createComment(issue.number, review.close)
      await client.updateIssue(issue.number, { state: "closed", state_reason: "completed" })
      results.push({ number: issue.number, title: issue.title, action: "closed" })
    } else if (review.body !== issue.body) {
      await client.updateIssue(issue.number, { body: review.body })
      results.push({ number: issue.number, title: issue.title, action: "updated" })
    } else {
      results.push({ number: issue.number, title: issue.title, action: "unchanged" })
    }
  }
  return { alarms: results.sort((left, right) => left.number - right.number) }
}
