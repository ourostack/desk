// One realistic multi-worker Claude session, run through the real functions:
// derive -> bindSession with agents -> publish -> both validators -> build().
// It pins what no single unit test can: that per-worker binding, PR crediting
// and worker_split survive every hand-off up to the built store, and that no
// worker and no controller moment is shared between two jobs.

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
const FT = "mcp__plugin_desk_desk__task_focus"
const at = (minute) => new Date(Date.UTC(2026, 8, 25, 8, 0, 0) + minute * 60000).toISOString()

// Root worker 0 declares task A, then task B two minutes later. Child 1 (brief
// line) is on A although it is spawned while the root works B, and its own
// child 4 (no line) follows it into A. Child 2 (bulleted brief line) is on C.
// Child 3 has no line, so it is in B, the root's job when it was spawned. Every
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
    assistant(1, [use("d1", FT, { track: "t", slug: "task-a" })], "claude-opus-5-5"), result(2, "d1"),
    assistant(3, [use("d2", FT, { track: "t", slug: "task-b" })], "claude-opus-5-5"), result(4, "d2"),
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

test("a multi-worker Claude session goes from transcript to built store with every worker in one job, PRs, worker_split and no shared time", async () => {
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
    // Each PR carries the time of its creating call, in ms from the session's start.
    assert.deepEqual(facts.refs.prs, [[10, 6], [11, 9], [12, 43], [13, 83], [14, 13]].map(([number, minute], index) => ({ repo: "o/r", number, agent: index, at_ms: minute * 60000 })))

    const cards = Object.fromEntries(["task-a", "task-b", "task-c"].map((slug) => [`t/${slug}`, { status: "processing", created_at: at(-60), updated_at: at(0) }]))
    facts.jobs = bindSession({
      events, agents: facts.agents, session: facts.session, deskRoot: "/desk", deskRemote: REMOTE, personPrefix: "",
      readTask: (track, slug) => cards[`${track}/${slug}`] ?? null,
      repoLookup: () => ({ none: true }), gitCommitTaskPaths: () => ({ exists: false }), isCardHousekeeping: () => false,
      resolveJobIdentity: (track, slug) => ({ track, slug }),
    }).jobs

    const id = (slug) => jobId({ deskRemote: REMOTE, personPrefix: "", track: "t", slug })
    const A = id("task-a")
    const B = id("task-b")
    const C = id("task-c")
    const agentsOf = (jobs) => Object.fromEntries(jobs.map((job) => [job.job, job.agents]))
    assert.deepEqual(agentsOf(facts.jobs), { [A]: [0, 1, 4], [B]: [0, 3], [C]: [2] })
    const jobOf = (job) => facts.jobs.find((entry) => entry.job === job)
    assert.deepEqual(jobOf(A).basis, ["desk_tool", "spawn_brief", "inherited"])
    assert.deepEqual(jobOf(B).basis, ["desk_tool", "inherited"])
    assert.deepEqual(jobOf(C).basis, ["spawn_brief"])
    // The root's 116 minutes are cut at the second declaration; the job only a subagent holds has no segments.
    assert.deepEqual(jobOf(A).segments, [{ start_ms: 0, end_ms: 3 * 60000 }])
    assert.deepEqual(jobOf(B).segments, [{ start_ms: 3 * 60000, end_ms: 116 * 60000 }])
    assert.equal(Object.hasOwn(jobOf(C), "segments"), false)
    // Every worker is in exactly one job.
    assert.deepEqual(facts.jobs.flatMap((job) => job.agents).sort(), [0, 0, 1, 2, 3, 4])

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

    // PR credit follows the creating worker, and the root's PR follows its time: PR 10 was created at minute 6,
    // inside B's segment. A holds children 1 and 4, so it gets PRs 11 and 14. B also holds child 3 and its PR 13.
    // C holds only child 2, so it gets PR 12.
    assert.deepEqual(numbers(built(A)), [11, 14])
    assert.deepEqual(numbers(built(B)), [10, 13])
    assert.deepEqual(numbers(built(C)), [12])
    // Every PR lands in exactly one job. The pipeline still marks each job's list partial, as it did before: the
    // session binds other jobs and holds another worker's PR that is not this job's.
    for (const job of [A, B, C]) {
      assert.equal(built(job).references.partial, true, job)
      // The derived Claude facts flag commits (not recorded) and PRs (recorded partly), next to the shared worker.
      assert.deepEqual(built(job).references.partial_reasons, ["host_does_not_record", "host_records_partly", "worker_shared"], job)
    }

    // Every job holds a strict subset of the session's workers or of the root's time, so its tool measures are worker_split.
    for (const job of [A, B, C]) {
      assert.deepEqual(built(job).tool_calls_by_kind.partial_reasons, ["worker_split"], job)
      assert.deepEqual(built(job).rework_signals.tool_failures.partial_reasons, ["worker_split"], job)
    }
    // A owns the root's first three minutes (one Desk call), child 1 (1 shell, 1 spawn) and child 4 (1 shell).
    assert.deepEqual(built(A).tool_calls_by_kind.value, { agent: 1, desk: 1, shell: 2 })
    // B owns the rest of the root's calls (one Desk call, 1 shell, the 3 spawns it made) and child 3 (1 shell).
    assert.deepEqual(built(B).tool_calls_by_kind.value, { agent: 3, desk: 1, shell: 2 })
    assert.deepEqual(built(C).tool_calls_by_kind.value, { shell: 1 })

    // No worker and no moment of the root is in two jobs, so no job's time is partial.
    for (const job of [A, B, C]) assert.equal(Object.hasOwn(built(job).active_time_ms, "partial"), false, job)
    assert.ok(built(C).active_time_ms.value < built(B).active_time_ms.value)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(store, { recursive: true, force: true })
    rmSync(path.dirname(out), { recursive: true, force: true })
  }
})
