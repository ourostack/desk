// Keeps the shard duration table (suite-durations.json) honest.
// Usage:
//   node suite-durations.mjs refresh <folder>... [--tests-root <folder>] [--table <file>]   take the median of the per-file times in every results.json found under the folders into the table
//   node suite-durations.mjs check [--tests-root <folder>] [--table <file>] [--strict]       fail when the table names a test file that no longer exists; --strict also fails for a test file the table lacks
// The folders are what `gh run download <run> -p "windows-standard-shard-*"` produces. Use several runs: the median ignores a single slow one.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { suiteFiles } from "./suite-files.mjs"
import { assignShards, defaultTablePath } from "./suite-shards.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultTests = path.resolve(here, "..", "..", "tests", "desk", "mcp", "__tests__")

const findResults = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? findResults(full) : entry.name === "results.json" ? [full] : []
})

const mean = (values) => (values.length === 0 ? 1 : values.reduce((a, b) => a + b, 0) / values.length)
// The median, so one run that was slow (a loaded runner, a retry) cannot set a file's weight.
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Problems with a table against the test files that exist: `stale` entries name a file that is gone (a rename or delete the table missed), `unlisted` files fall back to the default weight, `invalid` entries are not a positive number.
export function checkTable(table, testsRoot = defaultTests) {
  const suite = new Set(suiteFiles(testsRoot))
  const entries = Object.entries(table.files ?? {})
  return {
    stale: entries.filter(([file]) => !suite.has(file)).map(([file]) => file),
    unlisted: [...suite].filter((file) => !(file in (table.files ?? {}))),
    invalid: [
      ...entries.filter(([, seconds]) => !(typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0)).map(([file]) => file),
      ...(typeof table.defaultSeconds === "number" && table.defaultSeconds > 0 ? [] : ["defaultSeconds"]),
    ],
  }
}

// Median seconds per file over every results.json under the folders, for files that still exist.
export function refreshTable(folders, testsRoot = defaultTests, previous = { files: {} }) {
  const suite = new Set(suiteFiles(testsRoot))
  const samples = new Map()
  const inputs = folders.flatMap((folder) => findResults(folder))
  if (inputs.length === 0) throw new Error("no results.json found under the given folders")
  for (const file of inputs) for (const r of JSON.parse(fs.readFileSync(file, "utf8")).results) {
    if (r.timedOut || !suite.has(r.file)) continue
    samples.set(r.file, [...(samples.get(r.file) ?? []), r.ms / 1000])
  }
  const files = {}
  // A file with no new sample keeps its old weight; a file with none at all is left to the default.
  for (const file of [...suite].sort()) {
    const seen = samples.get(file)
    if (seen) files[file] = Math.round(median(seen) * 10) / 10
    else if (previous.files?.[file] !== undefined) files[file] = previous.files[file]
  }
  return {
    note: "Seconds each Windows suite test file took in CI (standard-user shard results), the median over the source runs. Refresh with: node .github/scripts/suite-durations.mjs refresh <downloaded shard artifact folders>. A file missing here gets defaultSeconds.",
    generated: new Date().toISOString().slice(0, 10),
    inputs: inputs.length,
    // The mean of the per-file medians, not their median: most files take a second or two, but a new file that is slow is far likelier than a new file that is faster than typical, and a heavy guess only costs a little balance.
    defaultSeconds: Math.max(1, Math.round(mean(Object.values(files)))),
    files,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const tablePath = path.resolve(flag("--table", defaultTablePath))
  const testsRoot = path.resolve(flag("--tests-root", defaultTests))
  const [command, ...rest] = args
  const positional = rest.filter((a, i) => !a.startsWith("--") && !String(rest[i - 1] ?? "").startsWith("--"))
  const previous = fs.existsSync(tablePath) ? JSON.parse(fs.readFileSync(tablePath, "utf8")) : { files: {} }
  if (command === "refresh") {
    const table = refreshTable(positional.map((p) => path.resolve(p)), testsRoot, previous)
    fs.writeFileSync(tablePath, JSON.stringify(table, null, 1) + "\n")
    const plan = assignShards(suiteFiles(testsRoot), 8, table)
    console.log(`wrote ${Object.keys(table.files).length} files from ${table.inputs} results files; default ${table.defaultSeconds}s; 8-shard plan (minutes): ${plan.map((s) => Math.round(s.seconds / 60)).join(" ")}`)
  } else if (command === "check") {
    const { stale, unlisted, invalid } = checkTable(previous, testsRoot)
    for (const f of stale) console.log(`::error::${f}: in the duration table but not a test file; run refresh to drop it`)
    for (const f of invalid) console.log(`::error::${f}: not a positive number of seconds`)
    for (const f of unlisted) console.log(`::${args.includes("--strict") ? "error" : "warning"}::${f}: not in the duration table, so it gets the default weight`)
    process.exit(stale.length + invalid.length + (args.includes("--strict") ? unlisted.length : 0) > 0 ? 1 : 0)
  } else {
    console.log("usage: suite-durations.mjs refresh <folder>... | check [--strict]")
    process.exit(2)
  }
}
