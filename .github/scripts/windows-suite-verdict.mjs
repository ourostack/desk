// Decides the Windows suite's verdict from the per-file results the standard-user shards uploaded, not from the shards' job conclusions.
// Usage: node windows-suite-verdict.mjs <folder holding one results folder per shard> <expected shard count> [<tests folder> [<only regex>]]
// Exit code: 0 only when every expected shard reported, each results file names the shard its folder says, the files reported across the shards are exactly the suite's test files, and every one passed and ran at least one test (passed, failed or skipped).
// The suite's files are found with the same code the shard runner uses (suite-files.mjs), so a shard that ran nothing, or a file no shard reported, is named and fails.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { suiteFiles } from "./suite-files.mjs"

const defaultTests = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "desk", "mcp", "__tests__")

export function verdict(root, expected, testsRoot = defaultTests, only = "") {
  const folders = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "results.json"))) : []
  const problems = []
  if (folders.length !== expected) problems.push(`${folders.length} of ${expected} shards reported results`)
  const reported = new Map()
  const numbers = new Set()
  for (const folder of folders) {
    const { shard, results } = JSON.parse(fs.readFileSync(path.join(root, folder.name, "results.json"), "utf8"))
    const named = /(\d+)$/u.exec(folder.name)?.[1]
    if (shard !== `${named}/${expected}`) problems.push(`${folder.name}: its results say shard ${shard}, not ${named}/${expected}`)
    numbers.add(named)
    for (const r of results) {
      reported.set(r.file, (reported.get(r.file) ?? 0) + 1)
      if (r.timedOut) problems.push(`${folder.name}: ${r.file} timed out`)
      else if (r.exitCode !== 0 || r.fail > 0) problems.push(`${folder.name}: ${r.file} failed (${r.fail} failed tests, exit ${r.exitCode})`)
      // A file that ran no test at all (it crashed while loading, or the runner printed nothing) is not a pass; an all-skipped file still ran its tests, so it counts.
      else if ((r.pass ?? 0) + (r.fail ?? 0) + (r.skipped ?? 0) < 1) problems.push(`${folder.name}: ${r.file} ran no tests`)
    }
  }
  if (numbers.size !== folders.length) problems.push("two result folders name the same shard")
  const suite = suiteFiles(testsRoot, only)
  for (const file of suite) if (!reported.has(file)) problems.push(`${file}: no shard reported it`)
  for (const [file, count] of reported) {
    if (!suite.includes(file)) problems.push(`${file}: reported but not a test file of this checkout`)
    else if (count > 1) problems.push(`${file}: reported by ${count} shards`)
  }
  return { files: reported.size, problems }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, problems } = verdict(process.argv[2], Number(process.argv[3]), process.argv[4] ? path.resolve(process.argv[4]) : defaultTests, process.argv[5] ?? "")
  console.log(`${files} test files reported.`)
  for (const problem of problems) console.log(`::error::${problem}`)
  process.exit(problems.length > 0 ? 1 : 0)
}
