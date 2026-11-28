// Refreshes the Windows shard duration table (suite-durations.json) from the last few main runs of the Windows suite, using suite-durations.mjs's own `refresh`.
// Usage: node refresh-suite-durations.mjs [--runs 4] [--table <file>] [--tests-root <folder>] [--dry-run]   (GH_TOKEN and GITHUB_REPOSITORY set; writes `changed=true|false` to $GITHUB_OUTPUT)
// It leaves the table alone when nothing moved enough to matter, so a quiet week opens no pull request and spends no CI on one.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { refreshTable } from "./suite-durations.mjs"
import { defaultTablePath } from "./suite-shards.mjs"

export const WORKFLOW = "desk-windows-suite.yml"
// A file counts as moved when its weight changed by at least this many seconds and this fraction: measurement noise of a second or two is not worth a pull request and a full CI run.
export const MIN_SECONDS = 2
export const MIN_FRACTION = 0.25

/** The newest `count` runs worth measuring: successful, from main, full (a dispatch titled "Partial: ..." ran only some files), as { databaseId, displayTitle, headBranch, conclusion } rows newest first. */
export function pickRuns(runs, count) {
  return runs
    .filter((run) => run.conclusion === "success" && run.headBranch === "main" && !/^Partial:/u.test(run.displayTitle ?? ""))
    .slice(0, count)
    .map((run) => run.databaseId)
}

/** The files whose weight moved enough to matter between two tables, plus files added or dropped. Empty means "leave the table alone". */
export function movedFiles(previous, next) {
  const before = previous.files ?? {}
  const after = next.files ?? {}
  const moved = []
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(file in before) || !(file in after)) moved.push(file)
    else if (Math.abs(after[file] - before[file]) >= Math.max(MIN_SECONDS, before[file] * MIN_FRACTION)) moved.push(file)
  }
  return moved.sort()
}

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

function main(argv) {
  const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
  const count = Number(flag("--runs", "4"))
  const repo = process.env.GITHUB_REPOSITORY
  const tablePath = path.resolve(flag("--table", defaultTablePath))
  const testsRoot = flag("--tests-root", undefined)
  const listed = JSON.parse(gh("run", "list", "--repo", repo, "--workflow", WORKFLOW, "--branch", "main", "--event", "push", "--status", "success", "--limit", "30", "--json", "databaseId,displayTitle,headBranch,conclusion"))
  const ids = pickRuns(listed, count)
  const output = (changed, summary) => {
    console.log(summary)
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Suite duration refresh\n${summary}\n`)
  }
  if (ids.length === 0) return output(false, "No successful full main run of the Windows suite to measure; the table is unchanged.")
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "suite-durations-"))
  const folders = ids.map((id) => {
    const dir = path.join(work, String(id))
    gh("run", "download", String(id), "--repo", repo, "--pattern", "windows-standard-shard-*", "--dir", dir)
    return dir
  })
  const previous = JSON.parse(fs.readFileSync(tablePath, "utf8"))
  const next = refreshTable(folders, testsRoot && path.resolve(testsRoot), previous)
  const moved = movedFiles(previous, next)
  if (moved.length === 0) return output(false, `Measured ${ids.length} runs (${ids.join(", ")}); no file moved by ${MIN_SECONDS}s and ${MIN_FRACTION * 100}% or more, so the table is unchanged.`)
  if (!argv.includes("--dry-run")) fs.writeFileSync(tablePath, JSON.stringify(next, null, 1) + "\n")
  output(true, `Measured ${ids.length} runs (${ids.join(", ")}); ${moved.length} files moved: ${moved.slice(0, 10).join(", ")}${moved.length > 10 ? ", ..." : ""}.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
