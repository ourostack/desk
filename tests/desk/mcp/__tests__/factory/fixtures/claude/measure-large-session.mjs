// Child-process helper for the memory-growth test in
// `derive_claude_memory.test.js`. The test spawns it with
// `--max-old-space-size=64`, so a deriver that holds the transcript (about
// 90 MiB here) runs out of heap and exits non-zero. While deriving, it also
// samples `heapUsed` to report the peak growth over the pre-derivation
// baseline, which the test bounds as well. It writes the large synthetic
// transcript to a fresh temp directory (streamed, never built up as one
// string) because a committed fixture that size would bloat the repository.
// Its only stdout is one JSON line: `{ transcriptBytes, peakGrowthBytes, toolCalls }`.

import { createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { deriveClaudeSession } from "../../../../src/factory/derive-claude.js"
import { buildLargeSessionLines, LARGE_SESSION } from "./make.js"

async function writeLarge(filePath) {
  const { generate } = buildLargeSessionLines(LARGE_SESSION)
  const stream = createWriteStream(filePath)
  for (const line of generate()) {
    if (!stream.write(`${JSON.stringify(line)}\n`)) await new Promise((resolve) => stream.once("drain", resolve))
  }
  await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())))
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "desk-factory-large-"))
  const filePath = path.join(dir, `${LARGE_SESSION.sessionId}.jsonl`)
  try {
    await writeLarge(filePath)
    const transcriptBytes = statSync(filePath).size
    if (global.gc) global.gc()
    const baseline = process.memoryUsage().heapUsed
    let peak = baseline
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }, 1)

    const { facts } = await deriveClaudeSession({
      transcriptPath: filePath,
      plugins: [],
      endReason: "clear",
    })
    clearInterval(sampler)
    peak = Math.max(peak, process.memoryUsage().heapUsed)
    if (facts === null) throw new Error("expected facts, got null")

    process.stdout.write(`${JSON.stringify({ transcriptBytes, peakGrowthBytes: peak - baseline, toolCalls: facts.counts.tool_calls.shell })}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

await main()
