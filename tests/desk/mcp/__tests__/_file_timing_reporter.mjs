// Test reporter for coverage shards: records how long each test file ran, keyed by its repository-relative path, so the shard weights in tools/desk-build/config/coverage-shards.json can be refreshed from real CI timings.
//
// The coverage runner supplies timings.json explicitly so snapshots survive interruption, independently of buffered TAP output.

import { renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

export default async function* fileTimingReporter(source, { timingsPath = process.env.DESK_COVERAGE_TIMINGS_PATH } = {}) {
  const files = new Map()
  const running = new Map()
  const relative = (file) => path.relative(repoRoot, file).replaceAll(path.sep, "/")
  const snapshot = () => ({
    schema_version: 1,
    file_seconds: Object.fromEntries(
      [...files]
        .map(([file, milliseconds]) => [relative(file), Math.round(milliseconds / 100) / 10])
        .sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
    ...(timingsPath ? {
      running_files: [...running].map(([file, started_at]) => ({ file: relative(file), started_at })),
    } : {}),
  })
  const persist = () => {
    if (!timingsPath) return
    writeFileSync(`${timingsPath}.tmp`, `${JSON.stringify(snapshot(), null, 2)}\n`)
    renameSync(`${timingsPath}.tmp`, timingsPath)
  }
  persist()
  for await (const event of source) {
    const { file, name, nesting, details } = event.data ?? {}
    if (nesting !== 0 || typeof file !== "string") continue
    if (event.type === "test:dequeue" && name === file) {
      running.set(file, new Date().toISOString())
      persist()
    } else if (event.type === "test:complete") {
      files.set(file, Math.max(files.get(file) ?? 0, details?.duration_ms ?? 0))
      if (name === file) {
        running.delete(file)
        persist()
      }
    }
  }
  if (timingsPath) persist()
  else yield `${JSON.stringify(snapshot(), null, 2)}\n`
}
