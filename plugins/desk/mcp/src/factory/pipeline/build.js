import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { validateLabelsBytes } from "../label-schema.js"
import { PATTERNS } from "../schema.js"
import { calculateFormulas } from "./formulas.js"
import { normalizePublished, stableStringify } from "./normalize.js"
import { computeOutcomeRollups } from "./outcomes.js"
import { buildCoverage, renderIndexMarkdown, renderJobMarkdown, renderReadme } from "./report.js"
import { computeRollups, jobRecord, renderRollupsMarkdown, resolveLabels } from "./rollups.js"
import { sessionDetail, timelineAdditions } from "./stretches.js"
import { buildTimelines } from "./timeline.js"
import { causesRollup, jobWalk, stackupRollup, tasksRollup } from "./walk.js"
import { isFactsPath, labelsPathParts, validatePr } from "./validate-pr.js"

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

function requireDirectory(directory, label) {
  const stat = lstatSync(directory)
  if (!stat.isDirectory()) throw new Error(`factory build: ${label} must be a real directory`)
}

function existingEntry(filePath) {
  return lstatSync(filePath, { throwIfNoEntry: false }) ?? null
}

function replaceDirectory(source, destination) {
  const stat = existingEntry(destination)
  if (stat !== null) {
    if (stat.isSymbolicLink()) throw new Error("factory build: outDir must not be a symlink")
    rmSync(destination, { recursive: true })
  }
  renameSync(source, destination)
}

// The job's timeline as `jobs/<job>.json` publishes it. The Lean walk adds, every time on the job clock: the job's workers
// (`agents`), human turns and pull requests (`timelineAdditions`) with how whole each list is (`human_turns_state`, `prs_state`), the
// lead window, the work bursts and the gaps between them (`jobWalk`) with `bursts_state`, how whole the intervals they are read from are,
// the after-stop waits (`waits`, each with the `next_prompt` time it holds) with `waits_state`, the state of the task's `next_prompt`
// figure they split, the task's UTC finish day (`finished_on`), and `detail_files`, the per-session swimlane files
// (`jobs/<job>/<session id>.json`) that hold the stretches.
function outputTimeline(timeline, additions, walk, detailFiles) {
  const window = walk.window
  return {
    job: timeline.job,
    sessions: timeline.sessions,
    intervals: timeline.intervals,
    transitions: timeline.transitions,
    observations: timeline.observations,
    outcome: timeline.outcome,
    agents: additions.agents,
    human_turns: additions.human_turns,
    human_turns_state: walk.human_turns_state,
    prs: additions.prs,
    prs_state: walk.prs_state,
    lead_window: Object.hasOwn(window, "start_ms") ? { start_ms: window.start_ms, end_ms: window.end_ms, state: window.lead.state, reasons: window.lead.reasons } : { state: "unavailable", reasons: window.reasons },
    bursts: walk.bursts,
    bursts_state: walk.bursts_state,
    gaps: walk.gaps,
    waits: walk.waits,
    waits_state: walk.waits_state,
    finished_on: walk.finished_on,
    detail_files: detailFiles,
  }
}

/**
 * The size a per-session swimlane file is held to: the store's site loads one when a swimlane opens. A file that would be larger has its
 * uncited intervals binned until it fits (`sessionDetail`); tests hold a session at the facts' interval cap (100,000 intervals) and at the
 * labels' stretch cap inside it. `build` takes another budget only so tests can make a small store bin.
 */
export const DETAIL_FILE_BUDGET_BYTES = 4 * 1024 * 1024

function buildError(code, message) {
  const error = new Error(`factory build: ${code}: ${message}`)
  error.code = code
  return error
}

// A store with no `facts/` has published nothing yet. Dotfiles such as
// `.gitkeep` are ignored; any other entry that is not a published facts file
// stops the build, because `validate-pr` never lets one merge unreviewed.
function readSessions(storeDir) {
  const factsDir = path.join(storeDir, "facts")
  const stat = existingEntry(factsDir)
  if (stat === null) return []
  if (!stat.isDirectory()) throw buildError("facts_not_directory", "facts must be a real directory")
  const sessions = []
  for (const entry of readdirSync(factsDir, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
    if (entry.name.startsWith(".")) continue
    if (!entry.isFile()) throw buildError("facts_entry_not_regular_file", "facts entries must be regular files")
    const relative = `facts/${entry.name}`
    if (!isFactsPath(relative)) throw buildError("invalid_facts_entry", "facts entries must be published facts files")
    const bytes = readFileSync(path.join(factsDir, entry.name))
    const validation = validatePr({ changes: [{ path: relative, status: "added", bytes }] })
    if (!validation.ok) throw buildError("invalid_published_facts", validation.errors.map((item) => item.code).join(","))
    sessions.push(normalizePublished(JSON.parse(bytes.toString("utf8"))))
  }
  sessions.sort((left, right) => compareText(left.session.host, right.session.host) || compareText(left.session.id, right.session.id))
  return sessions
}

const JOB_DIRECTORY = /^[0-9a-f]{32}$/u

function visibleEntries(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => compareText(left.name, right.name))
}

// Labels live at `labels/<job>/<session id>.json`. As under `facts/`,
// dotfiles are ignored and anything else that is not a labels file of that
// shape stops the build (`invalid_labels_entry`), because `validate-pr` never
// lets one merge unreviewed. Each file must pass the labels gate and name the
// job and session of its path (`invalid_published_labels`); whether it still
// matches its session's facts is `resolveLabels`' question, since a facts
// file can be re-derived after its labels merged.
function readLabels(storeDir) {
  const labelsDir = path.join(storeDir, "labels")
  const stat = existingEntry(labelsDir)
  if (stat === null) return []
  if (!stat.isDirectory()) throw buildError("labels_not_directory", "labels must be a real directory")
  const labels = []
  for (const jobEntry of visibleEntries(labelsDir)) {
    if (!jobEntry.isDirectory() || !JOB_DIRECTORY.test(jobEntry.name)) throw buildError("invalid_labels_entry", "labels entries must be job directories of labels files")
    for (const entry of visibleEntries(path.join(labelsDir, jobEntry.name))) {
      const relative = `labels/${jobEntry.name}/${entry.name}`
      const parts = labelsPathParts(relative)
      if (!entry.isFile() || parts === null) throw buildError("invalid_labels_entry", "labels entries must be job directories of labels files")
      const bytes = readFileSync(path.join(labelsDir, jobEntry.name, entry.name))
      if (!validateLabelsBytes(bytes).ok) throw buildError("invalid_published_labels", relative)
      const value = JSON.parse(bytes.toString("utf8"))
      if (value.job !== parts.job || value.session !== parts.session) throw buildError("invalid_published_labels", relative)
      labels.push(value)
    }
  }
  return labels
}

function writeRollups(directory, rollups) {
  mkdirSync(directory)
  writeFileSync(path.join(directory, "index.md"), renderRollupsMarkdown(rollups))
  writeFileSync(path.join(directory, "measures.json"), `${stableStringify(rollups.measures)}\n`)
  writeFileSync(path.join(directory, "muda.json"), `${stableStringify(rollups.muda)}\n`)
  writeFileSync(path.join(directory, "tool-kinds.json"), `${stableStringify(rollups.tool_kinds)}\n`)
  writeFileSync(path.join(directory, "coverage.json"), `${stableStringify(rollups.coverage)}\n`)
  writeFileSync(path.join(directory, "outcomes.json"), `${stableStringify(rollups.outcomes)}\n`)
  writeFileSync(path.join(directory, "totals.json"), `${stableStringify(rollups.totals)}\n`)
  writeFileSync(path.join(directory, "stackup.json"), `${stableStringify(rollups.stackup)}\n`)
  writeFileSync(path.join(directory, "tasks.json"), `${stableStringify(rollups.tasks)}\n`)
  writeFileSync(path.join(directory, "causes.json"), `${stableStringify(rollups.causes)}\n`)
}

// Writes each placed session's swimlane file under `jobs/<job>/` and returns their paths relative to the output root, in the
// timeline's session order. A session ID that two hosts share is written once, for the first.
function writeSessionDetails(jobsDir, timeline, labels, budgetBytes) {
  const written = []
  timeline.sessions.forEach((session, index) => {
    const detail = sessionDetail(timeline, index, labels, budgetBytes)
    const relative = `jobs/${timeline.job}/${session.id}.json`
    if (detail === null || written.includes(relative)) return
    mkdirSync(path.join(jobsDir, timeline.job), { recursive: true })
    writeFileSync(path.join(jobsDir, timeline.job, `${session.id}.json`), `${stableStringify(detail)}\n`)
    written.push(relative)
  })
  return written
}

// Everything the build derives from a store's `facts/` and `labels/`.
function readStore(store) {
  const sessions = readSessions(store)
  const labels = resolveLabels(readLabels(store), sessions)
  const reports = buildTimelines(sessions).map((timeline) => ({ timeline, formulas: calculateFormulas(timeline) }))
  const records = reports.map((report) => jobRecord(report, labels.byJobSession))
  return { sessions, labels, reports, records }
}

// What the Lean walk derives for each job, in the order of `reports`.
function walkStore({ labels, reports, records }) {
  return reports.map((report, index) => {
    const additions = timelineAdditions(report.timeline)
    return { additions, walk: jobWalk({ ...report, additions }, labels, records[index].finished) }
  })
}

/**
 * `storeRecords(storeDir) -> records`: every job's rollup record
 * (`jobRecord`), read exactly as `build` reads the store. The kaizen check
 * and andon compare these.
 */
export function storeRecords(storeDir) {
  if (typeof storeDir !== "string") throw new TypeError("storeRecords: storeDir must be a path")
  const store = path.resolve(storeDir)
  requireDirectory(store, "store")
  return readStore(store).records
}

/**
 * `storePublicPlugins(storeDir) -> names`: the plugin names that facts
 * carrying `refs.private.plugins` publish, sorted. Only a client that applies
 * the public-source rule writes that count, and it names only plugins
 * installed from a public repository, so these are the plugins public by
 * that rule. Older facts, which named every plugin, add nothing.
 */
export function storePublicPlugins(storeDir) {
  if (typeof storeDir !== "string") throw new TypeError("storePublicPlugins: storeDir must be a path")
  const store = path.resolve(storeDir)
  requireDirectory(store, "store")
  const names = new Set()
  for (const session of readSessions(store)) {
    if (!Object.hasOwn(session.refs.private, "plugins")) continue
    for (const plugin of session.plugins) names.add(plugin.name)
  }
  return [...names].sort(compareText)
}

export function build({ storeDir, outDir, detailBudgetBytes = DETAIL_FILE_BUDGET_BYTES }) {
  if (typeof storeDir !== "string" || typeof outDir !== "string") throw new TypeError("build: storeDir and outDir must be paths")
  const store = path.resolve(storeDir)
  const out = path.resolve(outDir)
  const storeFromOut = path.relative(out, store)
  if (store === out || (storeFromOut !== "" && !storeFromOut.startsWith(`..${path.sep}`) && storeFromOut !== ".." && !path.isAbsolute(storeFromOut))) {
    throw new Error("factory build: outDir must not replace the store or its ancestor")
  }
  requireDirectory(store, "store")

  const { sessions, labels, reports, records } = readStore(store)
  const walks = walkStore({ labels, reports, records })
  const rollups = {
    ...computeRollups({ records, sessions, labels }),
    outcomes: computeOutcomeRollups({ sessions, reports, records, labels }),
    stackup: stackupRollup(walks.map(({ walk }) => walk)),
    tasks: tasksRollup(walks.map(({ walk }) => walk)),
    causes: causesRollup({ records, walks: walks.map(({ walk }) => walk), labels }),
  }
  const temporary = `${out}.factory-tmp-${process.pid}`
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(path.join(temporary, "jobs"), { recursive: true })
  try {
    writeFileSync(path.join(temporary, "README.md"), renderReadme())
    writeFileSync(path.join(temporary, "index.md"), renderIndexMarkdown(reports, buildCoverage(sessions)))
    reports.forEach(({ timeline, formulas }, reportIndex) => {
      const detailFiles = writeSessionDetails(path.join(temporary, "jobs"), timeline, labels, detailBudgetBytes)
      const { additions, walk } = walks[reportIndex]
      writeFileSync(path.join(temporary, "jobs", `${timeline.job}.json`), `${stableStringify({ job: timeline.job, timeline: outputTimeline(timeline, additions, walk, detailFiles), formulas })}\n`)
      writeFileSync(path.join(temporary, "jobs", `${timeline.job}.md`), renderJobMarkdown({ timeline, formulas, labels: labels.byJobSession }))
    })
    writeRollups(path.join(temporary, "rollups"), rollups)
    replaceDirectory(temporary, out)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  return { jobs: reports.length, sessions: sessions.length }
}

/** The report page of `job`, an ID as the store publishes it. A task card links only a desk known private, whose store job is its plain ID (`local-status.js` `publishedJobId`). */
export function jobReportUrl({ store, job }) {
  if (typeof store !== "string" || !PATTERNS.prRepo.test(store)) throw new TypeError("jobReportUrl: store must be owner/repo")
  if (typeof job !== "string" || !/^[0-9a-f]{32}$/u.test(job)) throw new TypeError("jobReportUrl: job must be 32 lowercase hex")
  return `https://github.com/${store}/blob/reports/jobs/${job}.md`
}
