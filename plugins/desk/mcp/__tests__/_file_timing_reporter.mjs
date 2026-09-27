// Test reporter for coverage shards: records how long each test file ran, keyed by its repository-relative path, so the shard weights in config/coverage-shards.json can be refreshed from real CI timings.
//
// The coverage runner passes it alongside the TAP reporter, with its destination set to the shard's timings.json. The runner reports each file as a top-level test that encloses the file's own tests and its process startup, so a file's time is the longest top-level duration reported for it.

import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

export default async function* fileTimingReporter(source) {
  const files = new Map()
  for await (const event of source) {
    const { file, nesting, details } = event.data ?? {}
    if (event.type !== "test:complete" || nesting !== 0 || typeof file !== "string") continue
    files.set(file, Math.max(files.get(file) ?? 0, details?.duration_ms ?? 0))
  }
  const seconds = Object.fromEntries(
    [...files]
      .map(([file, milliseconds]) => [path.relative(repoRoot, file).replaceAll(path.sep, "/"), Math.round(milliseconds / 100) / 10])
      .sort(([left], [right]) => (left < right ? -1 : 1)),
  )
  yield `${JSON.stringify({ schema_version: 1, file_seconds: seconds }, null, 2)}\n`
}
