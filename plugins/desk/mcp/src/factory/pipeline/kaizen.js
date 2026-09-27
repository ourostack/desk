// Kaizen cards and the kaizen check.
//
// A kaizen card is an open issue labeled `kaizen` in a factory store whose
// body holds exactly one fenced `yaml` block:
//
//   kaizen: 1
//   signal: tool_retries            # a measureId from the rollups' catalog
//   job_class: engineering          # or any
//   evidence_jobs: [<job>, ...]     # optional
//   countermeasure: https://github.com/<owner>/<repo>/pull/<n>   # optional
//   plugin: desk
//   version: 3.2.0-alpha.45         # the first version carrying the countermeasure; optional until it ships
//   hypothesis: { measure: tool_retries, direction: down }
//
// The block is read with a small, strict YAML subset: one `key: value` per
// line; a value is a scalar (plain, single- or double-quoted, `null`, `~`
// or empty, or an integer), a flow list `[a, b]`, a flow map `{ k: v }`, or,
// under a key with no value, an indented block list (`- a`) or block map
// (`k: v`). `#` starts a comment at the start of a line or after a space.
// Anything else is a `syntax` error on that line.
//
// The check, on every build, for each open card with a `version`: of the
// finished jobs in `job_class` (every class for `any`), those whose every
// session ran `plugin` at `version` or later are "after", those whose every
// session ran an earlier version are "before", and the rest are left out
// (`mixed_versions`, `plugin_not_reported`, `open_job`, or the measure's own
// exclusion reason). `compareMedians` compares the hypothesis's measure
// between them with a 95% bootstrap interval seeded with the card's number.
// The card gets `confirmed` when the whole interval lies in the hypothesis's
// direction, `not-confirmed` when it lies wholly in the other, and neither
// otherwise ("still gathering data"). The check keeps exactly one comment of
// its own per card, updated in place, and never closes a card.
//
// Nothing a card says is echoed back: errors are stable codes with a field
// name from the fixed schema or a line number of the block, and the comment
// prints only validated values. Comments name no person, date or time.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { PATTERNS } from "../schema.js"
import { BOOTSTRAP_RESAMPLES, CONFIDENCE, MIN_JOBS_PER_SIDE, compareMedians } from "./compare.js"
import { JOB_CLASSES, MEASURE_IDS, formatMeasure } from "./rollups.js"
import { compareVersions, isVersion } from "./versions.js"

export const KAIZEN_LABEL = "kaizen"
export const KAIZEN_MARKER = "<!-- desk-kaizen-check -->"
export const VERDICT_LABELS = Object.freeze({ confirmed: "confirmed", not_confirmed: "not-confirmed" })
export const BOT_LOGIN = "github-actions[bot]"

const MAX_BLOCK_CHARS = 4096
const MAX_EVIDENCE_JOBS = 100
const BLOCK = /^```ya?ml[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gmu
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/u
const COUNTERMEASURE = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9]\d{0,9}$/u
const FIELDS = Object.freeze(["kaizen", "signal", "job_class", "evidence_jobs", "countermeasure", "plugin", "version", "hypothesis"])
const REQUIRED = new Set(["kaizen", "signal", "job_class", "plugin", "hypothesis"])
const DIRECTIONS = new Set(["down", "up"])

class SyntaxProblem extends Error {
  constructor(line) {
    super("syntax")
    this.line = line
  }
}

// The line up to its comment, outside quotes.
function stripComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== null) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === "#" && (index === 0 || /\s/u.test(line[index - 1]))) {
      return line.slice(0, index)
    }
  }
  return line
}

function scalar(text, line) {
  const value = text.trim()
  if (value === "" || value === "null" || value === "~") return null
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    if (value.length < 2 || value.at(-1) !== quote || value.slice(1, -1).includes(quote)) throw new SyntaxProblem(line)
    return value.slice(1, -1)
  }
  if (/^-?\d{1,15}$/u.test(value)) return Number(value)
  if (/["'[\]{}]/u.test(value)) throw new SyntaxProblem(line)
  return value
}

function flowItems(inner, line) {
  if (/[[\]{}]/u.test(inner)) throw new SyntaxProblem(line)
  return inner.trim() === "" ? [] : inner.split(",")
}

function mapEntry(text, line, into) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/u.exec(text)
  if (match === null || Object.hasOwn(into, match[1])) throw new SyntaxProblem(line)
  into[match[1]] = scalar(match[2] ?? "", line)
}

function inlineValue(text, line) {
  if (text.startsWith("[") || text.startsWith("{")) {
    const close = text.startsWith("[") ? "]" : "}"
    if (!text.endsWith(close)) throw new SyntaxProblem(line)
    const items = flowItems(text.slice(1, -1), line)
    if (close === "]") {
      return items.map((item) => {
        if (item.trim() === "") throw new SyntaxProblem(line)
        return scalar(item, line)
      })
    }
    const map = {}
    for (const item of items) mapEntry(item, line, map)
    return map
  }
  return scalar(text, line)
}

// The indented lines under a key with no inline value: a block list or a block map.
function nestedValue(nested) {
  if (nested.length === 0) return null
  const list = nested[0].text.startsWith("- ") || nested[0].text === "-"
  if (list) {
    return nested.map(({ text, line }) => {
      if (!(text.startsWith("- ") || text === "-")) throw new SyntaxProblem(line)
      return scalar(text.slice(1), line)
    })
  }
  const map = {}
  for (const { text, line } of nested) mapEntry(text, line, map)
  return map
}

function readBlock(text) {
  const lines = text.split(/\r?\n/u).map((raw, index) => ({ text: stripComment(raw).trimEnd(), line: index + 1 }))
  const entries = []
  let index = 0
  while (index < lines.length) {
    const { text: current, line } = lines[index]
    index += 1
    if (current.trim() === "") continue
    const match = /^\s/u.test(current) ? null : KEY_LINE.exec(current)
    if (match === null) throw new SyntaxProblem(line)
    const inline = (match[2] ?? "").trim()
    if (inline !== "") {
      entries.push({ key: match[1], value: inlineValue(inline, line), line })
      continue
    }
    const nested = []
    while (index < lines.length && (lines[index].text.trim() === "" || /^\s/u.test(lines[index].text))) {
      if (lines[index].text.trim() !== "") nested.push({ text: lines[index].text.trim(), line: lines[index].line })
      index += 1
    }
    entries.push({ key: match[1], value: nestedValue(nested), line })
  }
  return entries
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

function validateCard(values) {
  const errors = []
  const fail = (code, field) => errors.push({ code, field })
  for (const field of FIELDS) {
    if (REQUIRED.has(field) && (!Object.hasOwn(values, field) || values[field] === null)) fail("missing_key", field)
  }
  const has = (field) => Object.hasOwn(values, field) && values[field] !== null
  if (has("kaizen") && values.kaizen !== 1) fail("unsupported_card_version", "kaizen")
  if (has("signal") && !MEASURE_IDS.includes(values.signal)) fail("unknown_measure", "signal")
  if (has("job_class") && !(values.job_class === "any" || JOB_CLASSES.includes(values.job_class))) fail("invalid_job_class", "job_class")
  const jobs = values.evidence_jobs ?? []
  if (!Array.isArray(jobs) || jobs.length > MAX_EVIDENCE_JOBS || !jobs.every((job) => typeof job === "string" && PATTERNS.jobId.test(job))) fail("invalid_evidence_jobs", "evidence_jobs")
  if (has("countermeasure") && !(typeof values.countermeasure === "string" && COUNTERMEASURE.test(values.countermeasure))) fail("invalid_countermeasure", "countermeasure")
  if (has("plugin") && !(typeof values.plugin === "string" && PATTERNS.pluginName.test(values.plugin))) fail("invalid_plugin", "plugin")
  if (has("version") && !isVersion(values.version)) fail("invalid_version", "version")
  if (has("hypothesis")) {
    const hypothesis = values.hypothesis
    const shaped = isObject(hypothesis) && Object.keys(hypothesis).sort().join(",") === "direction,measure"
    if (!shaped || !MEASURE_IDS.includes(hypothesis.measure) || !DIRECTIONS.has(hypothesis.direction)) fail("invalid_hypothesis", "hypothesis")
  }
  return errors
}

/**
 * `parseCard(body) -> { ok: true, card } | { ok: false, errors }`: the card
 * in an issue body. `card` has every field, optional ones `null` (or `[]`
 * for `evidence_jobs`) when left out. Each error is `{ code }`, `{ code,
 * field }` or `{ code, line }` (the line within the block); a syntax error
 * stops the parse, and unknown or duplicate keys are reported before any
 * field is checked.
 */
export function parseCard(body) {
  const blocks = typeof body === "string" ? [...body.matchAll(BLOCK)] : []
  if (blocks.length === 0) return { ok: false, errors: [{ code: "no_block" }] }
  if (blocks.length > 1) return { ok: false, errors: [{ code: "multiple_blocks" }] }
  const text = blocks[0][1]
  if (text.length > MAX_BLOCK_CHARS) return { ok: false, errors: [{ code: "too_large" }] }
  let entries
  try {
    entries = readBlock(text)
  } catch (error) {
    return { ok: false, errors: [{ code: "syntax", line: error.line }] }
  }
  const values = {}
  const errors = []
  for (const { key, value, line } of entries) {
    if (!FIELDS.includes(key)) errors.push({ code: "unknown_key", line })
    else if (Object.hasOwn(values, key)) errors.push({ code: "duplicate_key", line })
    else values[key] = value
  }
  if (errors.length === 0) errors.push(...validateCard(values))
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    card: {
      kaizen: values.kaizen,
      signal: values.signal,
      job_class: values.job_class,
      evidence_jobs: values.evidence_jobs ?? [],
      countermeasure: values.countermeasure ?? null,
      plugin: values.plugin,
      version: values.version ?? null,
      hypothesis: { measure: values.hypothesis.measure, direction: values.hypothesis.direction },
    },
  }
}

function countReasons(reasons) {
  const counts = new Map()
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  return [...counts.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([reason, jobs]) => ({ reason, jobs }))
}

/**
 * `checkCard(card, records, { seed }) -> result`: `{ status:
 * "waiting_for_version" }` for a card with no version, else `{ status:
 * "checked", verdict, comparison, jobs, excluded }` where `verdict` is
 * `confirmed`, `not_confirmed` or `gathering`, `comparison` is
 * `compareMedians`' result, `jobs` the number of jobs in the card's class
 * and `excluded` each reason a job was left out with its count. `records`
 * are the rollups' job records (`jobRecord`).
 */
export function checkCard(card, records, { seed }) {
  if (card.version === null) return { status: "waiting_for_version" }
  const inClass = records.filter((record) => card.job_class === "any" || record.job_class === card.job_class)
  const before = []
  const after = []
  const reasons = []
  for (const record of inClass) {
    const range = record.plugins[card.plugin] ?? null
    const measure = record.measures[card.hypothesis.measure]
    const side = range === null ? null : compareVersions(range.min, card.version) >= 0 ? after : compareVersions(range.max, card.version) < 0 ? before : undefined
    if (!record.finished) reasons.push("open_job")
    else if (side === null) reasons.push("plugin_not_reported")
    else if (side === undefined) reasons.push("mixed_versions")
    else if (!("value" in measure)) reasons.push(measure.excluded)
    else side.push(measure.value)
  }
  const comparison = compareMedians(before, after, { seed })
  const verdict = comparison.direction === null ? "gathering" : comparison.direction === card.hypothesis.direction ? "confirmed" : "not_confirmed"
  return { status: "checked", verdict, comparison, jobs: inClass.length, excluded: countReasons(reasons) }
}

const HEADINGS = Object.freeze({ confirmed: "confirmed", not_confirmed: "not confirmed", gathering: "still gathering data" })

function errorLine(error) {
  if (error.field !== undefined) return `- \`${error.code}\` in \`${error.field}\``
  if (error.line !== undefined) return `- \`${error.code}\` on line ${error.line} of the block`
  return `- \`${error.code}\``
}

const RULE = `A verdict label is applied only when the whole ${CONFIDENCE * 100}% interval lies on one side of zero: \`${VERDICT_LABELS.confirmed}\` in the hypothesis's direction, \`${VERDICT_LABELS.not_confirmed}\` in the other. The interval comes from ${BOOTSTRAP_RESAMPLES.toLocaleString("en-US")} bootstrap resamples seeded with the card's number, so every build reproduces it. This check never closes a card.`

/**
 * `kaizenComment({ card, result } | { errors }) -> string`: the check's
 * comment for a card, starting with `KAIZEN_MARKER`. Byte-stable.
 */
export function kaizenComment({ card, result, errors }) {
  if (errors !== undefined) {
    return [KAIZEN_MARKER, "### Kaizen check: the card has errors", "", "The card's `yaml` block could not be checked. Fix these and edit the card; the next build checks it again.", "", ...errors.map(errorLine), ""].join("\n")
  }
  if (result.status === "waiting_for_version") {
    return [KAIZEN_MARKER, "### Kaizen check: waiting for the countermeasure's version", "", "The card has no `version` yet. When the countermeasure ships, set `version` to the first plugin version that carries it; the next build compares jobs before and after it.", ""].join("\n")
  }
  const measure = card.hypothesis.measure
  const format = (value) => (value === null ? "none" : formatMeasure(measure, value))
  const { comparison } = result
  const jobsOf = card.job_class === "any" ? "finished jobs of any class" : `finished \`${card.job_class}\` jobs`
  return [
    KAIZEN_MARKER,
    `### Kaizen check: ${HEADINGS[result.verdict]}`,
    "",
    `The build compares \`${measure}\` for ${jobsOf} whose every session ran \`${card.plugin}\` ${card.version} or later (after) with those whose every session ran an earlier version (before). The card's hypothesis is that it goes ${card.hypothesis.direction}.`,
    "",
    "| Jobs | Count | Median |",
    "| --- | ---: | ---: |",
    `| Before (earlier than ${card.version}) | ${comparison.before.jobs} | ${format(comparison.before.median)} |`,
    `| After (${card.version} or later) | ${comparison.after.jobs} | ${format(comparison.after.median)} |`,
    "",
    `- Change in median (after minus before): ${comparison.change === null ? "none yet" : format(comparison.change)}.`,
    `- ${CONFIDENCE * 100}% bootstrap interval: ${comparison.interval === null ? `none yet; each side needs at least ${MIN_JOBS_PER_SIDE} finished jobs` : `[${format(comparison.interval[0])}, ${format(comparison.interval[1])}]`}.`,
    `- Jobs left out: ${result.excluded.length === 0 ? "none" : result.excluded.map((entry) => `${entry.reason} ${entry.jobs}`).join(", ")}.`,
    "",
    RULE,
    "",
  ].join("\n")
}

/**
 * `planCard({ number, body, records }) -> { status, comment, label }`: what
 * the check writes for one card: `status` (`invalid`,
 * `waiting_for_version`, `confirmed`, `not_confirmed` or `gathering`), the
 * comment, and the verdict label it should carry (`null` for none).
 */
export function planCard({ number, body, records }) {
  const parsed = parseCard(body)
  if (!parsed.ok) return { status: "invalid", comment: kaizenComment({ errors: parsed.errors }), label: null }
  const result = checkCard(parsed.card, records, { seed: number })
  const status = result.status === "checked" ? result.verdict : result.status
  return { status, comment: kaizenComment({ card: parsed.card, result }), label: VERDICT_LABELS[status] ?? null }
}

/**
 * `syncKaizenCards({ client, records, author }) -> { cards }`: runs the
 * check on every open `kaizen` issue through `client` (`store-issues.js`):
 * creates or updates the one comment `author` (the workflow's bot) left
 * starting with `KAIZEN_MARKER`, writing only when it changed, and adds or
 * removes the verdict labels. Pull requests are skipped; no card is closed.
 */
export async function syncKaizenCards({ client, records, author = BOT_LOGIN }) {
  const issues = (await client.listIssues({ label: KAIZEN_LABEL, state: "open" }))
    .filter((issue) => !issue.pull_request && issue.state === "open")
    .sort((left, right) => left.number - right.number)
  const cards = []
  for (const issue of issues) {
    const plan = planCard({ number: issue.number, body: issue.body, records })
    const mine = (await client.listComments(issue.number)).find((comment) => comment.author === author && comment.body.startsWith(KAIZEN_MARKER))
    let comment = "unchanged"
    if (mine === undefined) {
      await client.createComment(issue.number, plan.comment)
      comment = "created"
    } else if (mine.body !== plan.comment) {
      await client.updateComment(mine.id, plan.comment)
      comment = "updated"
    }
    for (const label of Object.values(VERDICT_LABELS)) {
      const has = issue.labels.includes(label)
      if (plan.label === label && !has) await client.addLabels(issue.number, [label])
      if (plan.label !== label && has) await client.removeLabel(issue.number, label)
    }
    cards.push({ number: issue.number, status: plan.status, comment, labels: plan.label === null ? [] : [plan.label] })
  }
  return { cards }
}
