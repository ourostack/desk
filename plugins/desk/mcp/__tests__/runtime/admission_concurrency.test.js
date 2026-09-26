// Concurrency: five Desk servers started on one root within 200 ms, twenty times. Every handshake completes, every server reaches ready, and exactly one readiness controller serves each root.
//
// The second test measures the client event loop during the child's reindex. It records diagnostics and DESK_EVENT_LOOP_REPORT when set; the spawned-session test separately enforces the tools/list bound.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { monitorEventLoopDelay } from "node:perf_hooks"
import * as path from "node:path"
import { connectOrStartController } from "../../src/server.js"
import { makeGitDesk, startDesk, writeActivation, writeFile } from "./_admission_fixtures.js"
import { mkTempRoot } from "../_temp_roots.js"

const ROUNDS = Number(process.env.DESK_CONCURRENCY_ROUNDS ?? 20)
const SERVERS = 5
const WINDOW_MS = 200
// Five Node processes starting at once on a machine already running the rest of the suite: the handshake must complete well inside the hosts' startup timeout (30 s), and the slowest per round is recorded. The single-start 3 s budget is asserted in admission_conditions.test.js.
const CONCURRENT_HANDSHAKE_BUDGET_MS = 10000

function ownerRecords(readinessHome) {
  if (!existsSync(readinessHome)) return []
  return readdirSync(readinessHome)
    .map((entry) => path.join(readinessHome, entry, "owner.json"))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, "utf8")))
}

test(`${SERVERS} servers on one root within ${WINDOW_MS} ms, ${ROUNDS} times: every handshake completes and one controller serves the root`, { timeout: 600000 }, async (t) => {
  let handshakes = 0
  const slowest = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const fixture = await makeGitDesk(`desk-concurrency-${round}-`)
    const configPath = writeActivation(fixture)
    const starts = Array.from({ length: SERVERS }, (_, index) => new Promise((resolve) => setTimeout(resolve, (index * WINDOW_MS) / SERVERS))
      .then(() => startDesk(fixture, { args: ["--activation-config", configPath] })))
    const sessions = await Promise.all(starts)
    try {
      for (const session of sessions) {
        assert.ok(session.handshakeMs < CONCURRENT_HANDSHAKE_BUDGET_MS, `round ${round}: handshake took ${session.handshakeMs} ms`)
        handshakes += 1
      }
      slowest.push(Math.max(...sessions.map((session) => session.handshakeMs)))
      const statuses = await Promise.all(sessions.map((session) => session.statusUntil((payload) => payload.state === "ready", { deadlineMs: 30000 })))
      for (const status of statuses) assert.equal(status.state, "ready")
      const owners = ownerRecords(fixture.readinessHome)
      assert.equal(owners.length, 1, `round ${round}: ${owners.length} controllers`)
      assert.ok(sessions.some((session) => session.child.pid === owners[0].owner.parent_pid), `round ${round}: one of the five servers owns the child`)
      assert.ok(sessions.every((session) => session.child.pid !== owners[0].owner.pid), "no session is the index writer")
    } finally {
      await Promise.all(sessions.map((session) => session.close()))
    }
  }
  assert.equal(handshakes, ROUNDS * SERVERS)
  t.diagnostic(`${handshakes} handshakes; slowest handshake per round (ms): ${slowest.join(", ")}`)
})

test("the client's event-loop lag during a child controller's full reindex is measured and recorded", { timeout: 300000 }, async (t) => {
  const root = await mkTempRoot("desk-event-loop-lag-")
  const desk = path.join(root, "desk")
  const documents = Number(process.env.DESK_LAG_DOCUMENTS ?? 2000)
  writeFile(path.join(desk, "_meta", "friction.md"), "# Friction\n")
  writeFile(path.join(desk, "_archive", ".keep"), "")
  for (let index = 0; index < documents; index += 1) {
    const track = `track-${index % 40}`
    writeFile(path.join(desk, track, `task-${index}`, "task.md"), [
      "---", "schema_version: 1", `title: Task ${index}`, "status: active", "---", "",
      `# Task ${index}`, "",
      ...Array.from({ length: 12 }, (_, line) => `Paragraph ${line} of task ${index}: the harbor log records ferry ${index * 13 + line} crossing at dawn.`),
    ].join("\n"))
  }
  const controller = await connectOrStartController({
    deskRoot: desk,
    policy: { lexical: "required", semantic: "unsupported" },
    stateHome: path.join(root, "readiness"),
    ephemeral: true,
  })
  t.after(() => controller.close())
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  // A 20 ms ticker measures this client's loop, not the child doing the indexing.
  const stalls = []
  let last = performance.now()
  const ticker = setInterval(() => {
    const now = performance.now()
    if (now - last > 100) stalls.push(now - last)
    last = now
  }, 20)
  histogram.enable()
  const started = performance.now()
  await controller.beginConvergence()
  const reindexMs = performance.now() - started
  histogram.disable()
  clearInterval(ticker)
  const ms = (nanoseconds) => Math.round(nanoseconds / 1e4) / 100
  const report = {
    measured_process: "client",
    documents,
    reindex_ms: Math.round(reindexMs),
    event_loop_delay_ms: { mean: ms(histogram.mean), p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max) },
    stalls_over_100ms: { count: stalls.length, longest_ms: Math.round(Math.max(0, ...stalls)), total_ms: Math.round(stalls.reduce((sum, value) => sum + value, 0)) },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  }
  t.diagnostic(`event-loop lag during reindex: ${JSON.stringify(report)}`)
  if (process.env.DESK_EVENT_LOOP_REPORT) writeFileSync(process.env.DESK_EVENT_LOOP_REPORT, `${JSON.stringify(report, null, 2)}\n`)
  const barrier = await controller.barrier({ capability: "lexical" })
  assert.equal(barrier.current, true)
  assert.ok(report.event_loop_delay_ms.max > 0)
})
