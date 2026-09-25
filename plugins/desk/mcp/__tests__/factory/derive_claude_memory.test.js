// Important 2 (fix-round-1 review): `derive-claude.js` must be a true
// single pass with small state, so memory tracks the number of turns, tool
// calls and messages, never the size of the transcript. That is only
// observable by deriving a large generated transcript, so the test spawns
// `fixtures/claude/measure-large-session.mjs` in its own process with a
// 64 MiB old-generation heap. A deriver that kept the parsed lines of the
// ~90 MiB transcript would die there; a streaming one completes, and its
// sampled peak heap growth must also stay under 64 MiB.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { LARGE_SESSION } from "./fixtures/claude/make.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(here, "fixtures", "claude", "measure-large-session.mjs")
const MIB = 1024 * 1024

test("deriving a transcript larger than the heap cap completes, with peak heap growth under 64 MiB", { timeout: 180_000 }, () => {
  const output = execFileSync(process.execPath, ["--max-old-space-size=64", "--expose-gc", scriptPath], { encoding: "utf8" })
  const { transcriptBytes, peakGrowthBytes, toolCalls } = JSON.parse(output)
  assert.equal(toolCalls, LARGE_SESSION.messageCount)
  assert.ok(transcriptBytes > 64 * MIB, `the generated transcript must exceed the heap cap, got ${(transcriptBytes / MIB).toFixed(1)} MiB`)
  assert.ok(peakGrowthBytes < 64 * MIB, `expected peak heap growth under 64 MiB, got ${(peakGrowthBytes / MIB).toFixed(1)} MiB`)
})
