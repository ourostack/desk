// Andon: the build stops the line when a plugin version makes quality
// clearly worse.
//
// Andon watches only the plugins the store tracks: the `andon.plugins` list
// in the store's `factory.json` (`parseStoreConfig`). That file lies outside
// the intake paths, so changing it is a maintenance pull request a
// maintainer merges; a facts pull request cannot add plugins for andon to
// raise issues about.
//
// On every build, for each tracked plugin, quality measure
// (`QUALITY_MEASURES`) and job class, andon looks at finished jobs whose
// every session ran exactly one version of the plugin and that have a value
// for the measure. A version is comparable when its jobs form at least
// `MIN_GROUPS_PER_SIDE` independent groups (`clusterJobs`), the fewest for
// which a distribution-free 95% interval for a median can exist. The latest
// comparable version is compared with the comparable version before it,
// never with a version too thin to compare. When `compareMedians`' interval
// for the change in median lies wholly on the worse side of zero (every
// quality measure is worse when it goes up), the build opens an issue
// labeled `andon` titled `Andon: <plugin> <version> <measure> <job class>`,
// or updates or reopens the one it opened before; it never opens a second
// issue with the same title. The body gives the numbers, every compared job
// as evidence, and the other plugins whose versions also changed between the
// two sets of jobs: the regression then belongs to that set of versions, not
// to one plugin.
//
// The build closes its own andon issue, with a comment saying why, when,
// with enough groups on each side:
//   - the alarm's version is no longer clearly worse than its baseline; or
//   - a later comparable version is no longer clearly worse than that
//     baseline (a later version brings the measure back).
// With too few groups to compare, it neither opens nor closes anything.
//
// A reviewer who judges an alarm not to be a real regression labels it
// `andon-dismissed` (`DISMISSED_LABEL`). The build never reopens or closes a
// dismissed issue, but when its numbers change it updates the body and adds
// a comment with the new numbers, so a regression that later becomes clear
// is still seen.
//
// Only issues the build's own account opened are read or changed, and only
// for tracked plugins. An issue whose calls fail is reported as `failed`
// with a stable code, and andon goes on to the next one. Quality comes
// first: andon watches quality measures only, so no flow gain can offset a
// quality regression. Nothing here names a person, date or time.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { PATTERNS } from "../schema.js"
import { CONFIDENCE, MIN_GROUPS_PER_SIDE, clusterJobs, compareMedians, seedFromText } from "./compare.js"
import { JOB_CLASSES, QUALITY_MEASURES, formatMeasure } from "./rollups.js"
import { compareVersions, isVersion } from "./versions.js"

export const ANDON_LABEL = "andon"
export const ANDON_MARKER = "<!-- desk-andon -->"
export const DISMISSED_LABEL = "andon-dismissed"
const BOT_LOGIN = "github-actions[bot]"
const WORSE = "up"
const MAX_TRACKED_PLUGINS = 64

/**
 * `parseStoreConfig(text) -> { ok: true, plugins } | { ok: false, code }`:
 * the store's `factory.json`, `{ "andon": { "plugins": [<plugin>, ...] } }`,
 * or `null` text for a store without one (andon then tracks nothing). Codes:
 * `invalid_json`, `invalid_config` (any other shape, unknown key, bad or
 * repeated plugin name, or more than 64 plugins).
 */
export function parseStoreConfig(text) {
  if (text === null) return { ok: true, plugins: [] }
  let config
  try {
    config = JSON.parse(text)
  } catch {
    return { ok: false, code: "invalid_json" }
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  const plugins = config?.andon?.plugins
  const shaped = isObject(config) && Object.keys(config).join() === "andon" && isObject(config.andon) && Object.keys(config.andon).join() === "plugins" && Array.isArray(plugins)
  if (!shaped || plugins.length > MAX_TRACKED_PLUGINS || !plugins.every((name) => typeof name === "string" && PATTERNS.pluginName.test(name)) || new Set(plugins).size !== plugins.length) {
    return { ok: false, code: "invalid_config" }
  }
  return { ok: true, plugins: [...plugins].sort() }
}

/** `andonTitle(plugin, version, measure, jobClass) -> string`: the one title an alarm's issue has. */
export function andonTitle(plugin, version, measure, jobClass) {
  return `Andon: ${plugin} ${version} ${measure} ${jobClass}`
}

/** `parseAndonTitle(title) -> { plugin, version, measure, jobClass } | null`: the parts of a well-formed andon title. */
export function parseAndonTitle(title) {
  const parts = /^Andon: (\S+) (\S+) (\S+) (\S+)$/u.exec(title)
  if (parts === null || !PATTERNS.pluginName.test(parts[1]) || !isVersion(parts[2]) || !QUALITY_MEASURES.includes(parts[3]) || !JOB_CLASSES.includes(parts[4])) return null
  return { plugin: parts[1], version: parts[2], measure: parts[3], jobClass: parts[4] }
}

// For one plugin, measure and job class: the finished single-version jobs
// with a value, by version, and the comparable versions, oldest first.
function series(records, { plugin, measure, jobClass }) {
  const byVersion = new Map()
  for (const record of records) {
    const range = record.plugins[plugin] ?? null
    if (!record.finished || range === null || range.min !== range.max || record.job_class !== jobClass || !("value" in record.measures[measure])) continue
    if (!byVersion.has(range.min)) byVersion.set(range.min, [])
    byVersion.get(range.min).push(record)
  }
  const groups = new Map([...byVersion.entries()].map(([version, jobs]) => [version, clusterJobs(jobs.map((record) => ({ job: record.job, sessions: record.sessions, value: record.measures[measure].value })))]))
  const comparable = [...byVersion.keys()].filter((version) => groups.get(version).length >= MIN_GROUPS_PER_SIDE).sort(compareVersions)
  return { byVersion, groups, comparable }
}

function compare({ plugin, measure, jobClass }, data, baseline, version) {
  return compareMedians(data.groups.get(baseline), data.groups.get(version), { seed: seedFromText(`${plugin} ${baseline} ${version} ${measure} ${jobClass}`) })
}

// Each other plugin's versions over a set of jobs, as one comparable text.
function versionsText(jobs, plugin) {
  const versions = new Set()
  for (const record of jobs) {
    const range = record.plugins[plugin] ?? null
    if (range === null) versions.add("not reported")
    else versions.add(range.min).add(range.max)
  }
  return [...versions].sort((left, right) => (left === "not reported" ? 1 : right === "not reported" ? -1 : compareVersions(left, right))).join(", ")
}

// The other plugins whose versions differ between the two sets of jobs.
function coChanged(plugin, before, after) {
  const names = [...new Set([...before, ...after].flatMap((record) => Object.keys(record.plugins)))].filter((name) => name !== plugin).sort()
  return names.flatMap((name) => {
    const was = versionsText(before, name)
    const now = versionsText(after, name)
    return was === now ? [] : [{ plugin: name, before: was, after: now }]
  })
}

function renderBody({ plugin, version, baseline, measure, jobClass, comparison, before, after }) {
  const format = (value) => formatMeasure(measure, value)
  const others = coChanged(plugin, before, after)
  return [
    ANDON_MARKER,
    `### Andon: \`${measure}\` is clearly worse on \`${plugin}\` ${version} (job class \`${jobClass}\`)`,
    "",
    `The build compared finished \`${jobClass}\` jobs whose every session ran \`${plugin}\` ${version} with those whose every session ran ${baseline}, the latest earlier version with enough jobs to compare. Jobs that share a session count as one independent group. The whole ${CONFIDENCE * 100}% bootstrap interval for the change in median lies on the worse side of zero.`,
    "",
    "| Jobs | Count | Independent groups | Median |",
    "| --- | ---: | ---: | ---: |",
    `| Before (${baseline}) | ${comparison.before.jobs} | ${comparison.before.groups} | ${format(comparison.before.median)} |`,
    `| After (${version}) | ${comparison.after.jobs} | ${comparison.after.groups} | ${format(comparison.after.median)} |`,
    "",
    `- Change in median (after minus before): ${format(comparison.change)}.`,
    `- ${CONFIDENCE * 100}% bootstrap interval: [${format(comparison.interval[0])}, ${format(comparison.interval[1])}].`,
    `- Evidence jobs on ${baseline}: ${before.map((record) => `\`${record.job}\``).sort().join(", ")}.`,
    `- Evidence jobs on ${version}: ${after.map((record) => `\`${record.job}\``).sort().join(", ")}.`,
    "",
    ...(others.length === 0
      ? [`No other plugin's version changed between these two sets of jobs.`]
      : [
          `Other plugins also changed between these two sets of jobs, so the change belongs to this set of versions, not necessarily to \`${plugin}\` alone:`,
          "",
          ...others.map((other) => `- \`${other.plugin}\`: ${other.before} before, ${other.after} after.`),
        ]),
    "",
    `The build closes this issue itself when, with at least ${MIN_GROUPS_PER_SIDE} independent groups of jobs a side, ${version} or a later version is no longer clearly worse than ${baseline}. A reviewer who finds it is not a real regression labels it \`${DISMISSED_LABEL}\`: the build then never reopens it, but still posts new numbers here. Andon watches quality measures, so no flow gain offsets this.`,
    "",
  ].join("\n")
}

function alarmFor(key, data, baseline, version) {
  const comparison = compare(key, data, baseline, version)
  if (comparison.direction !== WORSE) return { comparison }
  const before = data.byVersion.get(baseline)
  const after = data.byVersion.get(version)
  return { comparison, body: renderBody({ ...key, version, baseline, comparison, before, after }) }
}

/**
 * `planAndon(records, { plugins }) -> alarms`: every alarm the tracked
 * `plugins` raise, as `{ plugin, version, baseline, measure, job_class,
 * title, comparison, body }`, ordered by plugin, then `QUALITY_MEASURES`,
 * then `JOB_CLASSES`. `records` are the rollups' job records.
 */
export function planAndon(records, { plugins }) {
  return [...plugins].sort().flatMap((plugin) => QUALITY_MEASURES.flatMap((measure) => JOB_CLASSES.flatMap((jobClass) => {
    const key = { plugin, measure, jobClass }
    const data = series(records, key)
    if (data.comparable.length < 2) return []
    const version = data.comparable.at(-1)
    const baseline = data.comparable.at(-2)
    const { comparison, body } = alarmFor(key, data, baseline, version)
    if (body === undefined) return []
    return [{ plugin, version, baseline, measure, job_class: jobClass, title: andonTitle(plugin, version, measure, jobClass), comparison, body }]
  })))
}

// What should happen to an open alarm the latest versions no longer raise:
// `{ close }` with the comment, `{ body }` with its current numbers, or `{}`
// when there are too few groups to say.
function reviewAlarm(records, key) {
  const { version, measure } = key
  const data = series(records, key)
  const at = data.comparable.indexOf(version)
  if (at < 1) return {}
  const baseline = data.comparable[at - 1]
  const alarm = alarmFor(key, data, baseline, version)
  if (alarm.body === undefined) {
    return { close: `${ANDON_MARKER}\nClosed by the build: with the data now in the store, \`${measure}\` on \`${key.plugin}\` ${version} is no longer clearly worse than ${baseline} for \`${key.jobClass}\` jobs.\n` }
  }
  const latest = data.comparable.at(-1)
  if (latest !== version && compare(key, data, baseline, latest).direction !== WORSE) {
    return { close: `${ANDON_MARKER}\nClosed by the build: ${latest} brings \`${measure}\` back; for \`${key.jobClass}\` jobs it is no longer clearly worse than ${baseline}, the version before ${version}.\n` }
  }
  return { body: alarm.body }
}

function numbersComment(body) {
  return `${ANDON_MARKER}\nThis alarm was dismissed, so the build will not reopen it, but its numbers changed:\n\n${body.slice(ANDON_MARKER.length + 1)}`
}

async function noteDismissed(client, issue, body) {
  if (body === undefined || body === issue.body) return issue.state === "open" ? "dismissed" : null
  await client.updateIssue(issue.number, { body })
  await client.createComment(issue.number, numbersComment(body))
  return "dismissed-updated"
}

async function raise(client, issue, alarm) {
  if (issue === undefined) return { number: (await client.createIssue({ title: alarm.title, body: alarm.body, labels: [ANDON_LABEL] })).number, action: "opened" }
  if (issue.labels.includes(DISMISSED_LABEL)) return { number: issue.number, action: await noteDismissed(client, issue, alarm.body) }
  if (issue.state === "closed") {
    await client.updateIssue(issue.number, { state: "open", body: alarm.body })
    return { number: issue.number, action: "reopened" }
  }
  if (issue.body === alarm.body) return { number: issue.number, action: "unchanged" }
  await client.updateIssue(issue.number, { body: alarm.body })
  return { number: issue.number, action: "updated" }
}

async function review(client, records, issue) {
  const result = reviewAlarm(records, parseAndonTitle(issue.title))
  if (issue.labels.includes(DISMISSED_LABEL)) return noteDismissed(client, issue, result.body)
  if (result.close !== undefined) {
    await client.createComment(issue.number, result.close)
    await client.updateIssue(issue.number, { state: "closed", state_reason: "completed" })
    return "closed"
  }
  if (result.body === undefined || result.body === issue.body) return "unchanged"
  await client.updateIssue(issue.number, { body: result.body })
  return "updated"
}

const failureCode = (error) => (typeof error.code === "string" ? error.code : "failed")

/**
 * `syncAndon({ client, records, plugins, author }) -> { tracked, alarms,
 * failed }`: opens, updates, reopens and closes the build's andon issues for
 * the tracked `plugins` through `client` (`store-issues.js`). Each entry is
 * `{ number, title, action }` with `action` one of `opened`, `updated`,
 * `reopened`, `closed`, `unchanged`, `dismissed` (an open dismissed issue),
 * `dismissed-updated` or `failed` (then with `code`), ordered by issue
 * number (a failed opening has `number: null` and comes last). Closed
 * dismissed issues with no new numbers are not listed. Issues not opened by
 * `author`, for untracked plugins, pull requests and titles that do not
 * parse are left alone.
 */
export async function syncAndon({ client, records, plugins, author = BOT_LOGIN }) {
  const tracked = new Set(plugins)
  const own = (await client.listIssues({ label: ANDON_LABEL, state: "all" }))
    .filter((issue) => !issue.pull_request && issue.author === author && tracked.has(parseAndonTitle(issue.title)?.plugin))
    .sort((left, right) => left.number - right.number)
  const byTitle = new Map()
  for (const issue of own) if (!byTitle.has(issue.title)) byTitle.set(issue.title, issue)
  const results = []
  const raised = new Set()
  for (const alarm of planAndon(records, { plugins })) {
    raised.add(alarm.title)
    const issue = byTitle.get(alarm.title)
    try {
      const { number, action } = await raise(client, issue, alarm)
      if (action !== null) results.push({ number, title: alarm.title, action })
    } catch (error) {
      results.push({ number: issue?.number ?? null, title: alarm.title, action: "failed", code: failureCode(error) })
    }
  }
  for (const issue of byTitle.values()) {
    if (issue.state !== "open" || raised.has(issue.title)) continue
    try {
      results.push({ number: issue.number, title: issue.title, action: await review(client, records, issue) })
    } catch (error) {
      results.push({ number: issue.number, title: issue.title, action: "failed", code: failureCode(error) })
    }
  }
  const order = (entry) => entry.number ?? Number.MAX_SAFE_INTEGER
  return { tracked: [...tracked].sort(), alarms: results.sort((left, right) => order(left) - order(right)), failed: results.filter((entry) => entry.action === "failed").length }
}
