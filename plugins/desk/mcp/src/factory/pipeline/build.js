import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { jobId } from "../binding.js"
import { PATTERNS } from "../schema.js"
import { calculateFormulas } from "./formulas.js"
import { normalizePublished, stableStringify } from "./normalize.js"
import { buildCoverage, renderIndexMarkdown, renderJobMarkdown, renderReadme } from "./report.js"
import { buildTimelines } from "./timeline.js"
import { isFactsPath, validatePr } from "./validate-pr.js"

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

function outputTimeline(timeline) {
  return {
    job: timeline.job,
    sessions: timeline.sessions,
    intervals: timeline.intervals,
    transitions: timeline.transitions,
    observations: timeline.observations,
  }
}

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

export function build({ storeDir, outDir }) {
  if (typeof storeDir !== "string" || typeof outDir !== "string") throw new TypeError("build: storeDir and outDir must be paths")
  const store = path.resolve(storeDir)
  const out = path.resolve(outDir)
  const storeFromOut = path.relative(out, store)
  if (store === out || (storeFromOut !== "" && !storeFromOut.startsWith(`..${path.sep}`) && storeFromOut !== ".." && !path.isAbsolute(storeFromOut))) {
    throw new Error("factory build: outDir must not replace the store or its ancestor")
  }
  requireDirectory(store, "store")

  const sessions = readSessions(store)
  const reports = buildTimelines(sessions).map((timeline) => ({ timeline, formulas: calculateFormulas(timeline) }))
  const temporary = `${out}.factory-tmp-${process.pid}`
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(path.join(temporary, "jobs"), { recursive: true })
  try {
    writeFileSync(path.join(temporary, "README.md"), renderReadme())
    writeFileSync(path.join(temporary, "index.md"), renderIndexMarkdown(reports, buildCoverage(sessions)))
    for (const { timeline, formulas } of reports) {
      writeFileSync(path.join(temporary, "jobs", `${timeline.job}.json`), `${stableStringify({ job: timeline.job, timeline: outputTimeline(timeline), formulas })}\n`)
      writeFileSync(path.join(temporary, "jobs", `${timeline.job}.md`), renderJobMarkdown({ timeline, formulas }))
    }
    replaceDirectory(temporary, out)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  return { jobs: reports.length, sessions: sessions.length }
}

export function jobLink({ store, deskRemote, personPrefix, track, slug }) {
  if (typeof store !== "string" || !PATTERNS.prRepo.test(store)) throw new TypeError("jobLink: store must be owner/repo")
  const job = jobId({ deskRemote, personPrefix, track, slug })
  return `https://github.com/${store}/blob/reports/jobs/${job}.md`
}
