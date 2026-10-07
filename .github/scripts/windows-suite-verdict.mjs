// Decides the Windows suite's verdict from the per-file results the standard-user shards uploaded, not from the shards' job conclusions.
// Usage: node windows-suite-verdict.mjs <folder holding one results.json per shard folder> <expected shard count>
// Exit code: 0 only when every expected shard reported and every file in it passed; 1 for a missing shard, a failed or timed-out file, or a failed test.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function verdict(root, expected) {
  const shards = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "results.json"))) : []
  const problems = []
  if (shards.length !== expected) problems.push(`${shards.length} of ${expected} shards reported results`)
  let files = 0
  for (const shard of shards) {
    const { results } = JSON.parse(fs.readFileSync(path.join(root, shard.name, "results.json"), "utf8"))
    for (const r of results) {
      files += 1
      if (r.timedOut) problems.push(`${shard.name}: ${r.file} timed out`)
      else if (r.exitCode !== 0 || r.fail > 0) problems.push(`${shard.name}: ${r.file} failed (${r.fail} failed tests, exit ${r.exitCode})`)
    }
  }
  return { files, problems }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, problems } = verdict(process.argv[2], Number(process.argv[3]))
  console.log(`${files} test files checked.`)
  for (const problem of problems) console.log(`::error::${problem}`)
  process.exit(problems.length > 0 ? 1 : 0)
}
