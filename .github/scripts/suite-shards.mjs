// Splits the Desk unit test files over the Windows shards by how long each file takes, so the shards finish at about the same time.
// The file list itself still comes only from suite-files.mjs; this module only decides which shard runs which file.
// The weights are a checked-in table (suite-durations.json) of seconds per file measured in CI. A file the table does not list (a new test file) gets the table's default weight, so a stale table makes a plan less even but never drops or duplicates a file.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const defaultTablePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "suite-durations.json")

// A missing table is not an error: every file then weighs the same and the plan is an even split by count.
export function loadDurations(file = defaultTablePath) {
  if (!fs.existsSync(file)) return { defaultSeconds: 1, files: {} }
  const table = JSON.parse(fs.readFileSync(file, "utf8"))
  return { defaultSeconds: table.defaultSeconds ?? 1, files: table.files ?? {} }
}

export const weightOf = (file, table) => table.files[file] ?? table.defaultSeconds

// Longest first: each file, heaviest first (ties by name), goes to the shard with the least load so far (ties to the lowest shard number). Nothing but the inputs decides the result, so every shard job computes the same plan.
// Returns one { files, seconds } per shard; the files of a shard are in name order.
export function assignShards(files, total, table = loadDurations()) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`shard count must be a positive integer, got ${total}`)
  const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }))
  const order = [...new Set(files)].sort((a, b) => weightOf(b, table) - weightOf(a, table) || (a < b ? -1 : a > b ? 1 : 0))
  for (const file of order) {
    const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best))
    lightest.files.push(file)
    lightest.seconds += weightOf(file, table)
  }
  for (const shard of shards) shard.files.sort()
  return shards
}

// The files of shard `index` (1-based) of `total`.
export const shardFiles = (files, index, total, table = loadDurations()) => assignShards(files, total, table)[index - 1]?.files ?? []
