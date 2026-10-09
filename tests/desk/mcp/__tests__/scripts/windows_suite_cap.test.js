// The Windows suite shares the organisation's concurrent-job limit with every other repository, so one run must never hold more than a few runners at once.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const workflow = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".github", "workflows", "desk-windows-suite.yml"), "utf8")

test("the Windows shard matrix caps how many shards run at once", () => {
  const job = workflow.slice(workflow.indexOf("  windows-suite:\n"), workflow.indexOf("  windows-suite-result:\n"))
  const cap = /^ {6}max-parallel: (\d+)$/mu.exec(job)
  assert.ok(cap, "the windows-suite strategy sets max-parallel")
  assert.ok(Number(cap[1]) >= 1 && Number(cap[1]) <= 3, `max-parallel ${cap[1]} stays at three or fewer`)
})

test("the aggregate Windows suite job is not capped, so it never waits behind a shard", () => {
  const result = workflow.slice(workflow.indexOf("  windows-suite-result:\n"))
  assert.doesNotMatch(result, /max-parallel/u)
})
