// One realistic multi-worker Claude session, run through the real functions:
// derive -> bindSession with agents -> publish -> both validators -> build().
// It pins what no single unit test can: that per-worker binding, PR crediting,
// worker_split and worker_shared survive every hand-off up to the built store.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const FACTORY = "../../../../../plugins/desk/mcp/src/factory/"
const { deriveClaudeSession } = await import(`${FACTORY}derive-claude.js`)
const { bindSession, jobId } = await import(`${FACTORY}binding.js`)
const { validateLocalFacts } = await import(`${FACTORY}schema.js`)
const { toPublished, serializePublished } = await import(`${FACTORY}publish.js`)
const { validatePublishedBytes } = await import(`${FACTORY}published-schema.js`)
const { build } = await import(`${FACTORY}pipeline/build.js`)

const SID = "2a3b4c5d-6e7f-4809-9a0b-1c2d3e4f5a6b"
const REMOTE = "https://github.com/o/desk"
const DT = "mcp__plugin_desk_desk__task_update"
const at = (minute) => new Date(Date.UTC(2026, 8, 25, 8, 0, 0) + minute * 60000).toISOString()

// Root worker 0 works on tasks A and B. Child 1 (brief line) is on A, and its own
// child 4 (no line) inherits A. Child 2 (bulleted brief line) is on C. Child 3
// has no line and its parent binds two jobs, so it stays unattributed. Every
// worker creates one PR, and the root transcript holds a `pr-link` for all of them.
function writeSession(dir) {
  let mid = 0
  const line = (minute, extra) => ({ sessionId: SID, version: "2.1.282", cwd: "/tmp/work", timestamp: at(minute), ...extra })
  const assistant = (minute, content, model = "claude-sonnet-5") => line(minute, { type: "assistant", message: { id: `m${mid++}`, model, usage: { input_tokens: 1, output_tokens: 1 }, content } })
  const use = (id, name, input) => ({ type: "tool_use", id, name, input })
  const result = (minute, id, extra = {}) => line(minute, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...extra })
  const prompt = (minute, text) => line(minute, { type: "user", message: { role: "user", content: text } })
  const created = (minute, id, number) => [
    assistant(minute, [use(id, "Bash", { command: "gh pr create" })]),
    result(minute + 1, id, { toolUseResult: { stdout: "ok", gitOperation: { pr: { number, url: `https://github.com/o/r/pull/${number}`, action: "created" } } } }),
  ]
  const prLink = (minute, number) => line(minute, { type: "pr-link", prRepository: "o/r", prNumber: number })

  const root = [
    prompt(0, "go"),
    assistant(1, [use("d1", DT, { track: "t", slug: "task-a", status: "processing" })], "claude-opus-5-5"), result(2, "d1"),
    assistant(3, [use("d2", DT, { track: "t", slug: "task-b", status: "processing" })], "claude-opus-5-5"), result(4, "d2"),
    ...created(5, "r1", 10),
    assistant(7, [use("s1", "Agent", { prompt: "Desk-Task: t/task-a\nbrief" })], "claude-opus-5-5"), result(40, "s1"),
    assistant(41, [use("s2", "Agent", { prompt: "Rules:\n- Desk-Task: t/task-c\nbrief" })], "claude-opus-5-5"), result(80, "s2"),
    assistant(81, [use("s3", "Agent", { prompt: "no line" })], "claude-opus-5-5"), result(110, "s3"),
    assistant(111, [{ type: "text", text: "done" }], "claude-opus-5-5"),
    ...[10, 11, 12, 13, 14].map((number, index) => prLink(112 + index, number)),
  ]
  const children = {
    "agent-a1": { meta: { toolUseId: "s1" }, lines: [prompt(7, "brief"), ...created(8, "c1", 11), assistant(11, [use("s4", "Agent", { prompt: "nested, no line" })]), result(30, "s4"), assistant(35, [{ type: "text", text: "x" }])] },
    "agent-a2": { meta: { toolUseId: "s2" }, lines: [prompt(41, "brief"), ...created(42, "c2", 12), assistant(75, [{ type: "text", text: "x" }])] },
    "agent-a3": { meta: { toolUseId: "s3" }, lines: [prompt(81, "x"), ...created(82, "c3", 13), assistant(105, [{ type: "text", text: "x" }])] },
    "agent-a4": { meta: { toolUseId: "s4" }, lines: [prompt(11, "x"), ...created(12, "c4", 14), assistant(25, [{ type: "text", text: "x" }])] },
  }
  const jsonl = (lines) => `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  writeFileSync(path.join(dir, `${SID}.jsonl`), jsonl(root))
  mkdirSync(path.join(dir, SID, "subagents"), { recursive: true })
  for (const [stem, { meta, lines }] of Object.entries(children)) {
    writeFileSync(path.join(dir, SID, "subagents", `${stem}.jsonl`), jsonl(lines))
    writeFileSync(path.join(dir, SID, "subagents", `${stem}.meta.json`), JSON.stringify(meta))
  }
}

test("a multi-worker Claude session goes from transcript to built store with per-worker jobs, PRs, worker_split and worker_shared", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-e2e-"))
  const store = mkdtempSync(path.join(os.tmpdir(), "desk-e2e-store-"))
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "desk-e2e-out-")), "built")
  try {
    writeSession(dir)
    const { facts, events } = await deriveClaudeSession({
      transcriptPath: path.join(dir, `${SID}.jsonl`),
      plugins: [{ name: "desk", version: "3.2.0-alpha.150", source: "ourostack/desk" }],
      endReason: "prompt_input_exit",
    })
    assert.deepEqual(facts.agents.map((agent) => [agent.n, agent.parent]), [[0, null], [1, 0], [2, 0], [3, 0], [4, 1]])
    // Each worker's PR is credited to that worker, though the root holds every pr-link.
    assert.deepEqual(facts.refs.prs, [10, 11, 12, 13, 14].map((number, index) => ({ repo: "o/r", number, agent: index })))

    const cards = Object.fromEntries(["task-a", "task-b", "task-c"].map((slug) => [`t/${slug}`, { status: "processing", created_at: at(-60), updated_at: at(0) }]))
    facts.jobs = bindSession({
      events, agents: facts.agents, deskRoot: "/desk", deskRemote: REMOTE, personPrefix: "",
      readTask: (track, slug) => cards[`${track}/${slug}`] ?? null,
      deskCommitsBetween: () => [], gitCommitTaskPaths: () => ({ exists: false }), isCardHousekeeping: () => false,
      resolveJobIdentity: (track, slug) => ({ track, slug }),
    }).jobs

    const id = (slug) => jobId({ deskRemote: REMOTE, personPrefix: "", track: "t", slug })
    const A = id("task-a")
    const B = id("task-b")
    const C = id("task-c")
    const agentsOf = (jobs) => Object.fromEntries(jobs.map((job) => [job.job, job.agents]))
    assert.deepEqual(agentsOf(facts.jobs), { [A]: [0, 1, 4], [B]: [0], [C]: [2] })
    const basisOf = (job) => facts.jobs.find((entry) => entry.job === job).basis
    assert.deepEqual(basisOf(A), ["desk_tool", "spawn_brief", "inherited"])
    assert.deepEqual(basisOf(C), ["spawn_brief"])
    // Worker 3 has no brief line and its parent binds two jobs: it is in no job.
    assert.equal(facts.jobs.some((job) => job.agents.includes(3)), false)

    assert.equal(validateLocalFacts(facts).ok, true, JSON.stringify(validateLocalFacts(facts).errors))
    const { published } = toPublished(facts, { visibility: () => "public", deskVisibility: "private", storeVisibility: "private" })
    assert.deepEqual(agentsOf(published.jobs), agentsOf(facts.jobs))
    assert.deepEqual(published.refs.prs.map((pr) => [pr.number, pr.agent]), [[10, 0], [11, 1], [12, 2], [13, 3], [14, 4]])
    const bytes = serializePublished(published)
    const verdict = validatePublishedBytes(bytes)
    assert.equal(verdict.ok, true, JSON.stringify(verdict.errors))

    mkdirSync(path.join(store, "facts"))
    writeFileSync(path.join(store, "facts", `claude-code-${SID}.json`), bytes)
    const summary = build({ storeDir: store, outDir: out })
    assert.ok(summary, "build() returned a summary")
    const built = (job) => JSON.parse(readFileSync(path.join(out, "jobs", `${job}.json`), "utf8")).formulas
    const numbers = (formulas) => formulas.references.value.public_pull_requests.map((pr) => pr.number)

    // PR credit follows the creating worker. The root is in A and B, so both get
    // its PR 10. C holds only child 2, so it gets PR 12 and nothing the root only linked.
    assert.deepEqual(numbers(built(A)), [10, 11, 14])
    assert.deepEqual(numbers(built(B)), [10])
    assert.deepEqual(numbers(built(C)), [12])

    // Every job holds a strict subset of the session's workers, so its tool measures are worker_split.
    for (const job of [A, B, C]) {
      assert.deepEqual(built(job).tool_calls_by_kind.partial_reasons, ["worker_split"], job)
      assert.deepEqual(built(job).rework_signals.tool_failures.partial_reasons, ["worker_split"], job)
    }
    // A owns the root (2 Desk calls, 1 shell, the 3 spawns it made), child 1 (1 shell, 1 spawn) and child 4 (1 shell).
    assert.deepEqual(built(A).tool_calls_by_kind.value, { agent: 4, desk: 2, shell: 3 })
    assert.deepEqual(built(C).tool_calls_by_kind.value, { shell: 1 })

    // A and B share the root, so their time is partial as worker_shared. C shares nothing.
    for (const job of [A, B]) {
      assert.equal(built(job).active_time_ms.partial, true, job)
      assert.deepEqual(built(job).active_time_ms.partial_reasons, ["worker_shared"], job)
    }
    assert.equal(Object.hasOwn(built(C).active_time_ms, "partial"), false)
    assert.ok(built(C).active_time_ms.value < built(A).active_time_ms.value)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(store, { recursive: true, force: true })
    rmSync(path.dirname(out), { recursive: true, force: true })
  }
})
