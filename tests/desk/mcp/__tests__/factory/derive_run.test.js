import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, writeFileSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { factoryStateRoot, gitBlobSha, listMarkers, markDelivered, markRetracting, readJobsIndex, setJobsForFile, readStatus, setConsent, writeMarker, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { LIMITS, validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { deliver, formatReturn, sign } from "../../../../../plugins/desk/mcp/src/factory/outcome.js"
import { deriveCopilotSession } from "../../../../../plugins/desk/mcp/src/factory/derive-copilot.js"
import { END, ID, SENTINEL, START, STORE, json, scratch, session } from "./_session_helpers.js"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/factory/derive-run.js", import.meta.url)
async function runner() {
  assert.ok(existsSync(moduleUrl), "the detached derivation runner must exist")
  return import(moduleUrl)
}

for (const host of ["claude-code", "copilot-cli"]) {
  test(`${host} derives valid content-free local facts and skips identical evidence`, () => scratch(async (ctx) => {
    const { deriveMarker } = await runner()
    const marker = { ...await session(ctx, host), entrypoint: "launcher", end_reason: "complete", ended_at: END }
    await setConsent(ctx.env, { store: STORE, contribute: true })
    assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "written", store: STORE })
    const file = path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `${host}-${ID}.json`)
    const bytes = await fs.readFile(file, "utf8")
    const facts = JSON.parse(bytes)
    assert.equal(validateLocalFacts(facts).ok, true)
    assert.equal(bytes.includes(SENTINEL), false)
    assert.equal(Object.hasOwn(facts, "events"), false)
    assert.equal(facts.session.id, ID)
    if (host === "copilot-cli") assert.equal(facts.session.entrypoint, "launcher")
    assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "skipped", store: STORE })
  }))
}

test("derivation honors consent and holds invalid routing without reading the log", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "not_opted_in", store: STORE })
  await setConsent(ctx.env, { store: STORE, contribute: false })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "not_opted_in")
  await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: "invalid" })
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "held", store: null })
  assert.deepEqual(await deriveMarker(ctx.env, { ...marker, desk_root: null }), { result: "held", store: null })
  assert.deepEqual(await deriveMarker(ctx.env, { ...marker, session_id: "../escape" }), { result: "invalid", store: null })
}))

test("a deriver older than the session's declared Desk holds instead of binding with superseded logic", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = { ...await session(ctx), plugins: [{ name: "desk", version: "3.2.0-alpha.999", source: "ourostack/desk" }] }
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.deepEqual(await deriveMarker(ctx.env, marker, { ownVersion: () => "3.2.0-alpha.1" }), { result: "held", store: null })
  const file = path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `${marker.host}-${ID}.json`)
  assert.equal(existsSync(file), false)
}))

test("a deriver at or ahead of the session's declared Desk still derives, and a marker without a desk entry is unaffected", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const atParity = { ...await session(ctx), plugins: [{ name: "desk", version: "3.2.0-alpha.5", source: "ourostack/desk" }] }
  assert.equal((await deriveMarker(ctx.env, atParity, { ownVersion: () => "3.2.0-alpha.5" })).result, "written")
  const ahead = { ...await session(ctx), plugins: [{ name: "desk", version: "3.2.0-alpha.1", source: "ourostack/desk" }] }
  assert.equal((await deriveMarker(ctx.env, ahead, { ownVersion: () => "3.2.0-alpha.5" })).result, "written")
  const noDeskEntry = { ...await session(ctx), plugins: [{ name: "other-plugin", version: "1.0.0", source: "example/other" }] }
  assert.equal((await deriveMarker(ctx.env, noDeskEntry, { ownVersion: () => { throw new Error("must not be read") } })).result, "written")
}))

test("a stale-deriver hold survives exactly seven days but expires the instant after, deriving with the running code instead of holding forever", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const updatedAt = "2026-09-01T00:00:00.000Z"
  const holdMs = 7 * 24 * 60 * 60 * 1000
  const marker = { ...await session(ctx), plugins: [{ name: "desk", version: "3.2.0-alpha.999", source: "ourostack/desk" }], updated_at: updatedAt }
  assert.deepEqual(await deriveMarker(ctx.env, marker, { ownVersion: () => "3.2.0-alpha.1", now: () => Date.parse(updatedAt) + holdMs }), { result: "held", store: null })
  assert.equal((await deriveMarker(ctx.env, marker, { ownVersion: () => "3.2.0-alpha.1", now: () => Date.parse(updatedAt) + holdMs + 1 })).result, "written")
}))

test("two different-origin \"desk\" entries naming different versions are an ambiguous declaration and never hold", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = { ...await session(ctx), plugins: [
    { name: "desk", version: "3.2.0-alpha.999", source: "ourostack/desk" },
    { name: "desk", version: "3.2.0-alpha.1", source: "acme/desk-fork" },
  ] }
  assert.equal((await deriveMarker(ctx.env, marker, { ownVersion: () => { throw new Error("must not be read") } })).result, "written")
}))

test("two different-origin \"desk\" entries agreeing on version are unambiguous and still hold", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = { ...await session(ctx), plugins: [
    { name: "desk", version: "3.2.0-alpha.999", source: "ourostack/desk" },
    { name: "desk", version: "3.2.0-alpha.999", source: "acme/desk-fork" },
  ] }
  assert.equal((await deriveMarker(ctx.env, marker, { ownVersion: () => "3.2.0-alpha.1" })).result, "held")
}))

test("an unreadable or non-semver running version fails open and still derives even when a \"desk\" entry is present", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const throwing = { ...await session(ctx), plugins: [{ name: "desk", version: "3.2.0-alpha.999", source: "ourostack/desk" }] }
  assert.equal((await deriveMarker(ctx.env, throwing, { ownVersion: () => { throw new Error("boom") } })).result, "written")
  const nonSemver = { ...await session(ctx), plugins: [{ name: "desk", version: "3.2.0-alpha.999", source: "ourostack/desk" }] }
  assert.equal((await deriveMarker(ctx.env, nonSemver, { ownVersion: () => "not-a-version" })).result, "written")
}))

test("with no ownVersion override, the real running version is read from the co-located plugin.json", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = { ...await session(ctx), plugins: [{ name: "desk", version: "999.0.0", source: "ourostack/desk" }] }
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "held", store: null })
}))

test("missing, unreadable and mismatched logs have explicit outcomes", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await fs.unlink(marker.log_path)
  assert.equal((await deriveMarker(ctx.env, marker)).result, "log_missing")
  await fs.mkdir(marker.log_path)
  assert.equal((await deriveMarker(ctx.env, marker)).result, "source_unreadable")
  await fs.rmdir(marker.log_path)
  await fs.writeFile(marker.log_path, "{}\n")
  assert.equal((await deriveMarker(ctx.env, marker)).result, "source_unreadable")
  await session(ctx)
  assert.equal((await deriveMarker(ctx.env, { ...marker, session_id: "4b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60" })).result, "invalid")
}))

test("sweep derives quiet stale and ended markers but skips busy logs and unchanged evidence", () => scratch(async (ctx) => {
  const { sweep } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, marker)
  assert.equal((await sweep(ctx.env)).skipped, 1)
  const old = new Date(Date.now() - 700000)
  await fs.utimes(marker.log_path, old, old)
  assert.equal((await sweep(ctx.env)).written, 1)
  assert.equal((await sweep(ctx.env)).skipped, 1)
  await writeMarker(ctx.env, { ...marker, ended_at: END, end_reason: "complete" })
  assert.equal((await sweep(ctx.env)).written, 1)
  await fs.appendFile(marker.log_path, `${JSON.stringify({ type: "assistant", sessionId: ID, timestamp: "2026-09-26T08:02:00.000Z", message: { content: [] } })}\n`)
  assert.equal((await sweep(ctx.env)).skipped, 1, "activity after the recorded end is a resumed, busy lifetime")
  await fs.utimes(marker.log_path, old, old)
  assert.equal((await sweep(ctx.env)).written, 1)
  assert.equal((await listMarkers(ctx.env)).length, 1)
}))

test("sweep rebuilds the index only once", () => scratch(async (ctx) => {
  const { sweep } = await runner()
  const root = await factoryStateRoot(ctx.env)
  const stale = "9f2c4b1a7d3e5f60718293a4b5c6d7e8"
  await setJobsForFile(ctx.env, "claude-code-old.json", [stale])
  await sweep(ctx.env)
  assert.deepEqual(await readJobsIndex(ctx.env), {}, "the first sweep drops entries no outbox file binds")
  assert.equal(existsSync(path.join(root, "jobs-index.rebuilt")), true)
  await setJobsForFile(ctx.env, "claude-code-old.json", [stale])
  await sweep(ctx.env)
  assert.deepEqual(await readJobsIndex(ctx.env), { [stale]: ["claude-code-old.json"] }, "the second sweep leaves a hand-edited index alone")
}))

test("sweep derives even when the rebuild fails", { skip: process.getuid?.() === 0 || process.platform === "win32" }, () => scratch(async (ctx) => {
  const { sweep } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, marker)
  const old = new Date(Date.now() - 700000)
  await fs.utimes(marker.log_path, old, old)
  const root = await factoryStateRoot(ctx.env)
  const bad = path.join(root, "outbox", "ourostack__other")
  await fs.mkdir(bad, { recursive: true })
  const file = path.join(bad, `claude-code-${ID.replace(/.$/u, "9")}.json`)
  await fs.writeFile(file, "{}")
  await fs.chmod(file, 0)
  try {
    assert.equal((await sweep(ctx.env)).written, 1)
    assert.equal(existsSync(path.join(root, "jobs-index.rebuilt")), false, "the failed rebuild will retry")
  } finally {
    await fs.chmod(file, 0o600)
  }
}))

test("re-deriving a session that no longer binds a job removes it from the index", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const gone = "9f2c4b1a7d3e5f60718293a4b5c6d7e8"
  await setJobsForFile(ctx.env, `claude-code-${ID}.json`, [gone])
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  assert.deepEqual(await readJobsIndex(ctx.env), {})
}))

// Appends tool calls to the session's transcript, one a minute from `START`, each with an ok result a second later.
async function appendCalls(marker, calls) {
  const lines = calls.flatMap(([name, input], index) => {
    const at = (seconds) => new Date(Date.parse(START) + index * 60000 + seconds * 1000).toISOString()
    return [
      { type: "assistant", sessionId: ID, timestamp: at(60), message: { content: [{ type: "tool_use", id: `call-${index}`, name, input }] } },
      { type: "user", sessionId: ID, timestamp: at(61), message: { content: [{ type: "tool_result", tool_use_id: `call-${index}`, content: "ok" }] } },
    ]
  })
  await fs.appendFile(marker.log_path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
}

async function writeCard(ctx, name) {
  const card = path.join(ctx.desk, name, "task.md")
  await fs.mkdir(path.dirname(card), { recursive: true })
  await fs.writeFile(card, `---\nstatus: done\ncreated: ${START}\nupdated: ${END}\n---\n${SENTINEL}\n`)
}

test("binding writes only hashed jobs and updates the finalize lookup", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await writeCard(ctx, "track/task")
  // A status-only update is no evidence of work; the write beside it is.
  await appendCalls(marker, [
    ["mcp__desk__task_update", { track: "track", slug: "task", frontmatter: { status: "done" } }],
    ["Write", { file_path: path.join(ctx.desk, "track/task/notes.md"), content: SENTINEL }],
  ])
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const index = await readJobsIndex(ctx.env)
  assert.equal(Object.keys(index).length, 1)
  assert.match(Object.keys(index)[0], /^[0-9a-f]{32}$/u)
  assert.deepEqual(Object.values(index)[0], [`claude-code-${ID}.json`])
  assert.equal(JSON.stringify(await readStatus(ctx.env)).includes(SENTINEL), false)
  const facts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `claude-code-${ID}.json`), "utf8"))
  assert.deepEqual(facts.jobs.map((job) => [job.transitions.map((entry) => entry.to), job.agents, job.segments.length]), [[["done"], [0], 1]])
}))

test("a status-only update alone binds no job", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await writeCard(ctx, "track/task")
  await appendCalls(marker, [["mcp__desk__task_update", { track: "track", slug: "task", frontmatter: { status: "done" } }]])
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  // The call binds no job, but the task it touched carries its outcome, so the index lists it for a later change to re-derive the session.
  const facts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `claude-code-${ID}.json`), "utf8"))
  assert.deepEqual(facts.jobs, [])
  assert.deepEqual(Object.keys(await readJobsIndex(ctx.env)), facts.outcomes.map((outcome) => outcome.job))
  assert.equal(facts.outcomes.length, 1)
  const receipt = (await readStatus(ctx.env)).derivations[`claude-code-${ID}.json`]
  assert.deepEqual([receipt.bound_by, receipt.focus_disagrees, receipt.repo_unresolved, receipt.segments_capped_ms], [{}, [], 0, 0])
  assert.equal(receipt.own_activity.length, 1, "the call is still the session's own activity")
}))

test("the receipt has binding_version: 6, bound_by, own_activity (at most 500) and focus_disagrees", () => scratch(async (ctx) => {
  const { deriveMarker, BINDING_VERSION } = await runner()
  const marker = await session(ctx)
  await writeCard(ctx, "track/task")
  await writeCard(ctx, "track/other")
  // Focus is declared on one task while an update and ten writes land on the other.
  await appendCalls(marker, [
    ["mcp__desk__task_focus", { track: "track", slug: "task" }],
    ["mcp__desk__task_update", { track: "track", slug: "other", progress: SENTINEL }],
    ...Array.from({ length: 10 }, (_, index) => ["Write", { file_path: path.join(ctx.desk, "track/other", `${index}.md`), content: SENTINEL }]),
  ])
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const name = `claude-code-${ID}.json`
  const status = await readStatus(ctx.env)
  const receipt = status.derivations[name]
  const [job] = Object.keys(await readJobsIndex(ctx.env))
  assert.equal(BINDING_VERSION, 6)
  assert.equal(receipt.binding_version, 6)
  assert.deepEqual(receipt.bound_by, { [job]: "focus" })
  assert.deepEqual(receipt.focus_disagrees, [job])
  // The update at two minutes in, widened by a minute each way, in milliseconds from the session's start.
  assert.deepEqual(receipt.own_activity, [[60000, 180000]])
  assert.ok(receipt.own_activity.length <= 500)
  assert.equal(receipt.desk_root, ctx.desk)
  assert.equal(JSON.stringify(status).includes(SENTINEL), false)
  // None of it reaches the facts.
  const bytes = await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name), "utf8")
  for (const key of ["bound_by", "own_activity", "focus_disagrees", "focusCalls"]) assert.equal(bytes.includes(key), false, key)
  assert.equal(validateLocalFacts(JSON.parse(bytes)).ok, true)
}))

test("work in a card's listed repository binds through the real reader, and only a directory that is gone is counted in the receipt as repo_unresolved", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  const card = path.join(ctx.desk, "track/task/task.md")
  await fs.mkdir(path.dirname(card), { recursive: true })
  await fs.writeFile(card, `---\nstatus: processing\ncreated: ${START}\nupdated: ${END}\nrepos: [ourostack/tool]\n---\n${SENTINEL}\n`)
  await writeCard(ctx, "track/other")
  // A code repository whose remote is the one the card lists, and a folder that is in no repository.
  const code = path.join(ctx.base, "code")
  await fs.mkdir(path.join(code, "src"), { recursive: true })
  await fs.mkdir(path.join(ctx.base, "plain"))
  await fs.writeFile(path.join(ctx.base, "a-file"), "x")
  // A repository with no origin: a true none, like the folder in no repository.
  const bare = path.join(ctx.base, "no-origin")
  await fs.mkdir(bare)
  const git = (folder, args) => assert.equal(spawnSync("git", ["-C", folder, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).status, 0)
  git(bare, ["init", "-q", "-b", "main"])
  for (const args of [["init", "-q", "-b", "main"], ["remote", "add", "origin", "git@github.com:OurOStack/Tool.git"]]) git(code, args)
  await appendCalls(marker, [
    ["Write", { file_path: path.join(ctx.desk, "track/task/notes.md"), content: SENTINEL }],
    ["Write", { file_path: path.join(ctx.desk, "track/other/notes.md"), content: SENTINEL }],
    ...[1, 2, 3].map((n) => ["Write", { file_path: path.join(code, "src", `${n}.js`), content: SENTINEL }]),
    ["Write", { file_path: path.join(ctx.base, "plain", "out.txt"), content: SENTINEL }],
    ["Write", { file_path: path.join(ctx.base, "plain", "again.txt"), content: SENTINEL }],
    ["Write", { file_path: path.join(bare, "out.txt"), content: SENTINEL }],
    // A directory that no longer exists is lost evidence; two writes in it count once.
    ["Write", { file_path: path.join(ctx.base, "vanished", "out.txt"), content: SENTINEL }],
    ["Write", { file_path: path.join(ctx.base, "vanished", "more.txt"), content: SENTINEL }],
    // A path under a file (ENOTDIR) is not available either.
    ["Write", { file_path: path.join(ctx.base, "a-file", "sub", "child.txt"), content: SENTINEL }],
  ])
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const name = `claude-code-${ID}.json`
  const status = await readStatus(ctx.env)
  const receipt = status.derivations[name]
  // One desk write and three repository writes make the listing card the session's one job; the other card's single write binds nothing.
  const jobs = Object.keys(await readJobsIndex(ctx.env))
  assert.equal(jobs.length, 1)
  assert.deepEqual(receipt.bound_by, { [jobs[0]]: "inferred" })
  assert.equal(receipt.repo_unresolved, 2, "the vanished directory and the path under a file are not available; an existing folder in no repository, and a repository with no origin, are a true none")
  assert.equal(receipt.segments_capped_ms, 0)
  // The receipt holds a number, never the directory or the repository; the facts hold neither.
  const text = JSON.stringify(status)
  for (const secret of [code, path.join(ctx.base, "plain"), "ourostack/tool", SENTINEL]) assert.equal(text.includes(secret), false, secret)
  const bytes = await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name), "utf8")
  for (const secret of ["repo_unresolved", "ourostack/tool", "plain", SENTINEL]) assert.equal(bytes.includes(secret), false, secret)
  assert.equal(validateLocalFacts(JSON.parse(bytes)).ok, true)
}))

test("concurrent derivation serializes one session instead of overwriting fresher facts", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const results = await Promise.all([deriveMarker(ctx.env, marker), deriveMarker(ctx.env, marker)])
  assert.deepEqual(results.map((r) => r.result).sort(), ["skipped", "written"])
}))

test("routing snapshot survives plugin cleanup, desk declaration wins, and warnings never enter facts", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = { ...await session(ctx), routing: { source: "overlay", store: "example/other", warnings: [{ code: "manifest_unreadable", manifest: path.join(ctx.base, "missing/plugin.json") }] } }
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "not_opted_in", store: "example/other" })
  assert.equal((await readStatus(ctx.env)).routing_warnings.length, 1)
  await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: STORE })
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "written", store: STORE })
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "outbox/ourostack__factory", `${marker.host}-${ID}.json`)
  assert.equal((await fs.readFile(file, "utf8")).includes("manifest_unreadable"), false)
  await fs.unlink(file)
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written", "missing facts must be repaired")
}))

test("quiet waiting sees late shutdown writes and uses refreshed markers", () => scratch(async (ctx) => {
  const { deriveFile } = await runner()
  const marker = await session(ctx, "copilot-cli")
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, marker)
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "markers", `${marker.host}-${ID}.json`)
  const write = fs.appendFile(marker.log_path, `${JSON.stringify({ type: "session.shutdown", timestamp: END, data: { modelMetrics: { "gpt-5": { requests: { count: 3 }, usage: { inputTokens: 12, outputTokens: 34 } } } } })}\n`)
  await write
  assert.equal((await deriveFile(ctx.env, file, { quietMs: 100, maxWaitMs: 2000 })).result, "written")
  const facts = JSON.parse(await fs.readFile(path.join(root, "outbox/ourostack__factory", `${marker.host}-${ID}.json`), "utf8"))
  assert.equal(facts.models[0].requests, 3)
  assert.equal((await deriveFile(ctx.env, file, { quietMs: 30000, maxWaitMs: 1 })).result, "skipped")
  assert.equal((await deriveFile(ctx.env, path.join(root, "markers/no.json"))).result, "invalid")
  await fs.unlink(marker.log_path)
  assert.equal((await deriveFile(ctx.env, file, { quietMs: 1 })).result, "log_missing")
  await fs.writeFile(file, "{")
  assert.equal((await deriveFile(ctx.env, file)).result, "source_unreadable")
}))

test("sweep reports invalid, missing and unreadable sources without losing other markers", () => scratch(async (ctx) => {
  const { sweep, deriveMarker } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, marker)
  await fs.unlink(marker.log_path)
  assert.equal((await sweep(ctx.env)).log_missing, 1)
  await fs.mkdir(marker.log_path)
  assert.equal((await sweep(ctx.env)).source_unreadable, 1)
  const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
  await json(file, { updated_at: marker.updated_at })
  assert.equal((await sweep(ctx.env)).invalid, 0, "protected enumeration prunes invalid records before sweep consumes them")
  assert.deepEqual(await listMarkers(ctx.env), [])
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await fs.rmdir(marker.log_path)
  await session(ctx)
  await writeStatus(ctx.env, { derivations: { [path.basename(file)]: { store: STORE, marker: "not-current", size: 1, mtime: 0 } } })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  await fs.mkdir(path.join(ctx.desk, ".git"))
  assert.equal((await deriveMarker({ ...ctx.env, XDG_STATE_HOME: ctx.desk }, marker)).result, "source_unreadable")
}))

test("derivation refuses malformed native facts and a mismatched Copilot path", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx, "copilot-cli")
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, { ...marker, log_path: (await session(ctx)).log_path })).result, "invalid")
  assert.equal((await deriveMarker(ctx.env, marker, { copilot: async (options) => {
    const derived = await deriveCopilotSession(options)
    derived.facts.session.host_version = "incompatible upstream metadata"
    return derived
  } })).result, "invalid")
}))

test("revoking consent during derivation prevents the facts write", (t) => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const consentFile = path.join(await factoryStateRoot(ctx.env), "consent.json")
  const read = fs.readFile
  let reads = 0
  t.mock.method(fs, "readFile", async (file, ...args) => {
    if (file === consentFile && ++reads === 2) {
      const value = JSON.parse(await read(file, "utf8"))
      value.stores[STORE].contribute = false
      await fs.writeFile(file, JSON.stringify(value))
    }
    return read(file, ...args)
  })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "not_opted_in")
}))

test("quiet wait refuses a marker invalidated while the detached process was waiting", (t) => scratch(async (ctx) => {
  const { deriveFile } = await runner()
  const marker = await session(ctx)
  await writeMarker(ctx.env, marker)
  const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
  const lstat = fs.lstat
  t.mock.method(fs, "lstat", async (target, ...args) => {
    const stat = await lstat(target, ...args)
    if (target === marker.log_path) {
      await fs.writeFile(file, "{}")
      return { ...stat, mtimeMs: Date.now(), isFile: () => true }
    }
    return stat
  })
  assert.equal((await deriveFile(ctx.env, file, { quietMs: 10 })).result, "invalid")
}))

test("a session derived under an older binding version re-derives once", () => scratch(async (ctx) => {
  const { deriveMarker, BINDING_VERSION } = await runner()
  assert.equal(BINDING_VERSION, 6)
  const marker = { ...await session(ctx), end_reason: "complete", ended_at: END }
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "written", store: STORE })
  const name = `claude-code-${ID}.json`
  const receipt = (await readStatus(ctx.env)).derivations[name]
  assert.equal(receipt.binding_version, BINDING_VERSION)
  for (const older of [undefined, 1, 2, 3, 4]) {
    const { binding_version, ...legacy } = receipt
    await writeStatus(ctx.env, { derivations: { [name]: older === undefined ? legacy : { ...legacy, binding_version: older } } })
    assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
    assert.equal((await readStatus(ctx.env)).derivations[name].binding_version, BINDING_VERSION)
    assert.equal((await deriveMarker(ctx.env, marker)).result, "skipped", "the second sweep skips it")
  }
}))

test("a current receipt still skips", () => scratch(async (ctx) => {
  const { deriveMarker, BINDING_VERSION } = await runner()
  const marker = { ...await session(ctx), end_reason: "complete", ended_at: END }
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await deriveMarker(ctx.env, marker)
  const name = `claude-code-${ID}.json`
  const receipt = (await readStatus(ctx.env)).derivations[name]
  await writeStatus(ctx.env, { derivations: { [name]: { ...receipt, binding_version: BINDING_VERSION + 1 } } })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "skipped")
}))

// Codex routing fails closed: its marker records no plugins, so a default route is unproven.
const SIBLING_ID = "5b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60"
const DEFAULT_ROUTING = { source: "default", store: STORE, warnings: [] }
const DAY = 24 * 60 * 60 * 1000
// Real-clock times: listMarkers prunes a marker whose updated_at is over 30 days old, so a fixed date would rot.
const CODEX_AT = new Date(Date.now() - 2 * DAY).toISOString()
const apart = (days) => new Date(Date.parse(CODEX_AT) + days * DAY).toISOString()

async function codexMarker(ctx) {
  const log = path.join(ctx.base, ".codex", "sessions", "2026", "09", "26", "rollout-x.jsonl")
  await fs.mkdir(path.dirname(log), { recursive: true })
  await fs.writeFile(log, "{}\n")
  return { schema_version: 1, host: "codex-cli", session_id: ID, log_path: log, cwd: ctx.desk, desk_root: ctx.desk, end_reason: "complete", ended_at: CODEX_AT, plugins: [], updated_at: CODEX_AT, routing: DEFAULT_ROUTING }
}

async function sibling(ctx, overrides) {
  const marker = { ...await session(ctx), session_id: SIBLING_ID, ended_at: CODEX_AT, updated_at: new Date().toISOString(), routing: DEFAULT_ROUTING, ...overrides }
  if (Object.hasOwn(overrides, "routing") && overrides.routing === undefined) delete marker.routing
  await writeMarker(ctx.env, marker)
  return marker
}

const stub = { codex: async () => ({ facts: null, reason: "source_unreadable" }) }

test("a default-routed Codex marker with no sibling is held as route_unverified and writes nothing", () => scratch(async (ctx) => {
  const { deriveMarker, sweep } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = await codexMarker(ctx)
  assert.deepEqual(await deriveMarker(ctx.env, marker, stub), { result: "held", store: null, reason: "route_unverified" })
  assert.equal(existsSync(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `codex-cli-${ID}.json`)), false)
  await writeMarker(ctx.env, marker)
  const summary = await sweep(ctx.env)
  assert.equal(summary.held, 1)
  assert.equal(summary.route_unverified, 1)
  assert.deepEqual((await readStatus(ctx.env)).held_markers, { route_unverified: 1 })
}))

test("a Codex marker stays held for a distant, other-desk or overlay-routed sibling", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = await codexMarker(ctx)
  const held = async (label) => assert.equal((await deriveMarker(ctx.env, marker, stub)).reason, "route_unverified", label)
  await sibling(ctx, { ended_at: apart(31) })
  await held("more than 30 days after")
  await sibling(ctx, { ended_at: apart(-31) })
  await held("more than 30 days apart")
  await sibling(ctx, { routing: { source: "overlay", store: "example/other", warnings: [] } })
  await held("overlay-routed sibling")
  await sibling(ctx, { routing: undefined })
  await held("sibling without a recorded route")
  await sibling(ctx, { desk_root: path.join(ctx.base, "other-desk") })
  await held("different desk")
  await sibling(ctx, { desk_root: null })
  await held("sibling without a desk")
  await sibling(ctx, { host: "codex-cli" })
  await held("another Codex marker proves nothing")
}))

test("a qualifying Claude or Copilot sibling releases the Codex marker, including through a symlinked desk path", () => scratch(async (ctx) => {
  const { deriveMarker, sweep } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = await codexMarker(ctx)
  await writeMarker(ctx.env, marker)
  assert.equal((await sweep(ctx.env)).route_unverified, 1)
  const link = path.join(ctx.base, "desk-link")
  await fs.symlink(ctx.desk, link)
  await sibling(ctx, { desk_root: link, ended_at: apart(-29) })
  assert.deepEqual(await deriveMarker(ctx.env, marker, stub), { result: "source_unreadable", store: STORE })
  const summary = await sweep(ctx.env)
  assert.equal(summary.route_unverified, 0)
  assert.deepEqual((await readStatus(ctx.env)).held_markers, { route_unverified: 0 })
}))

test("a Copilot sibling releases, and a missing desk path compares by resolved string", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const gone = path.join(ctx.base, "gone-desk")
  await fs.mkdir(path.join(gone, "_meta"), { recursive: true })
  const marker = { ...await codexMarker(ctx), desk_root: gone, cwd: gone }
  await fs.rm(gone, { recursive: true })
  await sibling(ctx, { host: "copilot-cli", desk_root: gone, ended_at: null, updated_at: CODEX_AT })
  assert.equal((await deriveMarker(ctx.env, { ...marker, ended_at: null, updated_at: CODEX_AT }, stub)).reason, undefined)
}))

test("a desk that declares its store routes Codex at once, and Claude and Copilot never hold", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = await codexMarker(ctx)
  assert.equal((await deriveMarker(ctx.env, marker, stub)).result, "held")
  await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: STORE })
  assert.deepEqual(await deriveMarker(ctx.env, { ...marker, routing: { source: "desk", store: STORE, warnings: [] } }, stub), { result: "source_unreadable", store: STORE })
  assert.deepEqual(await deriveMarker(ctx.env, marker, stub), { result: "source_unreadable", store: STORE }, "the desk's current declaration wins over a stale default snapshot")
  await fs.rm(path.join(ctx.desk, "_meta/factory.json"))
  assert.equal((await deriveMarker(ctx.env, await session(ctx))).result, "written")
}))

test("a sibling exactly 30 days from the Codex marker releases it, one millisecond more does not", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = await codexMarker(ctx)
  await sibling(ctx, { ended_at: new Date(Date.parse(CODEX_AT) - 30 * DAY - 1).toISOString() })
  assert.equal((await deriveMarker(ctx.env, marker, stub)).reason, "route_unverified")
  await sibling(ctx, { ended_at: apart(-30) })
  assert.equal((await deriveMarker(ctx.env, marker, stub)).reason, undefined)
}))

test("a failing status write never stops a sweep", () => scratch(async (ctx) => {
  const { sweep } = await runner()
  await fs.mkdir(path.join(await factoryStateRoot(ctx.env), "status.json"), { recursive: true })
  assert.equal((await sweep(ctx.env)).held, 0)
}))

test("quiet wait recreates nothing when the state root is removed while it waits", () => scratch(async (ctx) => {
  const { deriveFile } = await runner()
  const marker = await session(ctx, "copilot-cli")
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, marker)
  const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
  await fs.utimes(marker.log_path, new Date(), new Date())
  const waiting = deriveFile(ctx.env, file, { quietMs: 1500, maxWaitMs: 5000 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  await fs.rm(ctx.base, { recursive: true, force: true })
  assert.equal((await waiting).result, "invalid")
  assert.equal(existsSync(ctx.base), false, "no directory of the removed home may be recreated")
}))

test("a derive process whose home is removed while it waits exits and leaves nothing behind", async () => {
  const { spawn } = await import("node:child_process")
  const { waitForNoProcessesUnder, reapProcessesUnder } = await import("../_process_hygiene.js")
  await scratch(async (ctx) => {
    const { deriveFile } = await runner()
    const marker = await session(ctx, "copilot-cli")
    await setConsent(ctx.env, { store: STORE, contribute: true })
    await writeMarker(ctx.env, marker)
    const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
    assert.equal(typeof deriveFile, "function")
    await fs.utimes(marker.log_path, new Date(), new Date())
    const script = new URL("../../../../../plugins/desk/mcp/scripts/factory.js", import.meta.url).pathname
    const child = spawn(process.execPath, [script, "derive", "--marker", file, "--wait-quiet", "3000"], { cwd: ctx.desk, env: ctx.env, stdio: "ignore", detached: true })
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
    try {
      await new Promise((resolve) => setTimeout(resolve, 800))
      await fs.rm(ctx.base, { recursive: true, force: true })
      const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 15000)
      const { signal } = await exited
      clearTimeout(timer)
      assert.equal(signal, null, "the worker must exit on its own once its home is gone")
      assert.equal(existsSync(ctx.base), false, "the worker must not recreate the removed home")
      assert.deepEqual(await waitForNoProcessesUnder(ctx.base, 2000), [])
    } finally {
      try { process.kill(-child.pid, "SIGKILL") } catch { /* already gone */ }
      await reapProcessesUnder(ctx.base)
    }
  })
})

test("the derive command ends itself at its hard deadline and clears the timer when it finishes first", () => scratch(async (ctx) => {
  const { runDeriveCommand } = await import("../../../../../plugins/desk/mcp/scripts/factory.js")
  const marker = await session(ctx, "copilot-cli")
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, marker)
  const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
  await fs.utimes(marker.log_path, new Date(), new Date())
  const exits = []
  const warnings = []
  await runDeriveCommand({ argv: ["--marker", file, "--wait-quiet", "400"], env: ctx.env, deadlineMs: 20, exit: (code) => exits.push(code), warn: (message) => warnings.push(message) })
  assert.deepEqual(exits, [124], "a worker that hits its ceiling exits 124, not 0, so a hang is not mistaken for success")
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /still running after 0s; ending it \(exit 124\)/u)
  await runDeriveCommand({ argv: ["--marker", "x", "--wait-quiet", "0"], env: ctx.env, deadlineMs: 150, exit: (code) => exits.push(code), warn: (message) => warnings.push(message) })
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.deepEqual(exits, [124], "a finished worker must not fire its deadline")
  assert.equal(warnings.length, 1)
}))

test("derive refuses a file that exists but is not a marker in the markers folder", () => scratch(async (ctx) => {
  const { deriveFile } = await runner()
  const stray = path.join(ctx.base, "stray.json")
  await fs.writeFile(stray, "{}")
  assert.deepEqual(await deriveFile(ctx.env, stray), { result: "invalid", store: null })
}))

// --- Rebuilding sessions whose marker was pruned ---------------------------------

const staleReceipt = async (ctx, name, change) => {
  const file = path.join(await factoryStateRoot(ctx.env), "status.json")
  const status = JSON.parse(await fs.readFile(file, "utf8"))
  status.derivations[name] = change({ ...status.derivations[name], binding_version: 1 })
  await fs.writeFile(file, JSON.stringify(status))
}

// A session that was derived once and whose marker is gone: its outbox copy, receipt and transcript remain. `stale` lowers the receipt's
// binding version so the sweep must rebuild it; without it the receipt is current.
async function orphan(ctx, { declare = true, receiptRoot = true, cwd = ctx.desk, transcript = true, stale = true } = {}) {
  const plugins = [{ name: "desk", version: "1.0.0", source: "ourostack/desk" }, { name: "other-plugin", version: "1.0.0" }]
  const marker = { ...await session(ctx), end_reason: "complete", ended_at: END, plugins }
  if (declare) await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: STORE })
  const lines = (await fs.readFile(marker.log_path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  lines[0].cwd = cwd
  await fs.writeFile(marker.log_path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const { deriveMarker } = await runner()
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const name = `claude-code-${ID}.json`
  if (stale || !receiptRoot) {
    await staleReceipt(ctx, name, (receipt) => {
      if (!receiptRoot) delete receipt.desk_root
      if (!stale) receipt.binding_version = 6
      return receipt
    })
  }
  if (!transcript) await fs.rm(marker.log_path)
  return { marker, name }
}

// A copy of an orphan under another session id: its outbox file, transcript and receipt.
async function clone(ctx, { marker, name }, digit) {
  const id = `${ID.slice(0, -1)}${digit}`
  const copyName = `claude-code-${id}.json`
  const swap = (text) => text.replaceAll(ID, id)
  const log = path.join(path.dirname(marker.log_path), `${id}.jsonl`)
  await fs.writeFile(log, swap(await fs.readFile(marker.log_path, "utf8")))
  const outbox = path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory")
  await fs.writeFile(path.join(outbox, copyName), swap(await fs.readFile(path.join(outbox, name), "utf8")))
  const file = path.join(await factoryStateRoot(ctx.env), "status.json")
  const status = JSON.parse(await fs.readFile(file, "utf8"))
  status.derivations[copyName] = { ...status.derivations[name] }
  await fs.writeFile(file, JSON.stringify(status))
  return copyName
}

const reasons = async (ctx) => {
  const { orphans } = await readStatus(ctx.env)
  return Object.fromEntries(Object.entries(orphans.frozen).filter(([, count]) => count > 0))
}

const rebuilt = async (ctx) => {
  const { sweep } = await runner()
  const summary = await sweep(ctx.env)
  return [summary.rebuilt, summary.frozen]
}

test("an orphan in a declared desk is rebuilt, takes end_reason from its outbox copy and writes the receipt the way a derive does", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx)
  assert.deepEqual(await rebuilt(ctx), [1, 0])
  const receipt = (await readStatus(ctx.env)).derivations[name]
  const { BINDING_VERSION } = await runner()
  assert.deepEqual([receipt.binding_version, receipt.desk_root, receipt.store, receipt.repo_unresolved, receipt.segments_capped_ms], [BINDING_VERSION, ctx.desk, STORE, 0, 0])
  const facts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name), "utf8"))
  assert.equal(facts.session.end_reason, "complete")
  assert.deepEqual(facts.plugins.map((plugin) => plugin.name), ["desk", "other-plugin"], "the plugins the outbox copy named are kept")
  assert.equal((await listMarkers(ctx.env)).length, 0, "no marker is invented")
  assert.deepEqual(await rebuilt(ctx), [0, 0], "a rebuilt orphan is current; the next sweep leaves it alone")
  assert.equal((await readStatus(ctx.env)).orphans.current, 1)
}))

test("an orphan whose receipt is already current is not derived again", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx, { stale: false })
  const file = path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name)
  const before = await fs.stat(file)
  const { sweep } = await runner()
  const summary = await sweep(ctx.env)
  assert.deepEqual([summary.rebuilt, summary.frozen, summary.pending, summary.orphans.current], [0, 0, 0, 1])
  const after = await fs.stat(file)
  assert.deepEqual([after.mtimeMs, after.ino], [before.mtimeMs, before.ino], "the outbox copy was not rewritten")
}))

test("the orphan pass writes its result to status.json as counts keyed by a closed reason list, and the list is exported and frozen", () => scratch(async (ctx) => {
  const { rebuildOrphans, ORPHAN_REASONS, ORPHAN_EXAMINE_CAP, ORPHAN_BUDGET_MS } = await runner()
  assert.equal(Object.isFrozen(ORPHAN_REASONS), true)
  assert.deepEqual([...ORPHAN_REASONS], ["no_facts", "no_transcript", "no_desk_root", "crew_desk", "route_unknown", "retracted", "not_opted_in", "recorded_by_newer_desk", "derive_failed"])
  assert.deepEqual([typeof ORPHAN_EXAMINE_CAP, typeof ORPHAN_BUDGET_MS], ["number", "number"])
  await orphan(ctx, { declare: false })
  const result = await rebuildOrphans(ctx.env, { now: () => Date.parse("2026-10-06T00:00:00.000Z") })
  assert.deepEqual([result.rebuilt, result.current, result.pending, result.frozen], [0, 0, 0, 1])
  const expected = { started_at: "2026-10-06T00:00:00.000Z", ran_at: "2026-10-06T00:00:00.000Z", cursor: null, last_wrap_at: "2026-10-06T00:00:00.000Z", sweeps_in_walk: 0, examined: 1, worked: 0, rebuilt: 0, current: 0, pending: 0, unexamined: 0, oldest_pending_days: null, frozen: Object.fromEntries(ORPHAN_REASONS.map((reason) => [reason, reason === "route_unknown" ? 1 : 0])) }
  assert.deepEqual((await readStatus(ctx.env)).orphans, expected)
  assert.deepEqual(result.orphans, expected)
  const text = JSON.stringify((await readStatus(ctx.env)).orphans)
  for (const secret of [ctx.base, ctx.desk, ID, SENTINEL]) assert.equal(text.includes(secret), false, "counts only: no path or session name")
}))

test("an orphan whose receipt names its desk is judged before its transcript is read", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx, { transcript: false })
  await fs.writeFile(path.join(ctx.desk, "_meta/desks.md"), "| alias | identity |\n| --- | --- |\n| ari | ari@example.com |\n")
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { crew_desk: 1 }, "no transcript was needed to say why")
  await fs.rm(path.join(ctx.desk, "_meta/desks.md"))
  const { markRetracting: retract } = await import(new URL("../../../../../plugins/desk/mcp/src/factory/outbox.js", import.meta.url))
  await retract(ctx.env, STORE, [{ name, path: `sessions/${name}`, blob: "a".repeat(40) }])
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { retracted: 1 })
}))

test("an orphan with no receipt desk_root is rebuilt from the transcript's first cwd when that is exactly a desk root, also through a symlink", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx, { receiptRoot: false })
  assert.deepEqual(await rebuilt(ctx), [1, 0])
  assert.equal((await readStatus(ctx.env)).derivations[name].desk_root, ctx.desk)
  const link = path.join(ctx.base, "desk-link")
  await fs.symlink(ctx.desk, link)
  const second = await orphan(ctx, { receiptRoot: false, cwd: link })
  assert.deepEqual(await rebuilt(ctx), [1, 0])
  assert.equal((await readStatus(ctx.env)).derivations[second.name].desk_root, ctx.desk, "the symlink resolves to the real desk root")
}))

test("an orphan whose cwd is inside the desk but not the desk root stays frozen, as no_desk_root", () => scratch(async (ctx) => {
  await fs.mkdir(path.join(ctx.desk, "track"))
  await orphan(ctx, { receiptRoot: false, cwd: path.join(ctx.desk, "track") })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { no_desk_root: 1 })
}))

test("an orphan whose desk routes by default stays frozen as route_unknown", () => scratch(async (ctx) => {
  await orphan(ctx, { declare: false })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { route_unknown: 1 })
}))

test("a retracted orphan stays frozen, whether the record is a retracting entry or a kept copy", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx)
  await markRetracting(ctx.env, STORE, [{ name, path: `sessions/${name}`, blob: "a".repeat(40) }])
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { retracted: 1 })
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "retracting"), { recursive: true })
  await fs.mkdir(path.join(root, "retracted-copies", "ourostack__factory"), { recursive: true })
  await fs.writeFile(path.join(root, "retracted-copies", "ourostack__factory", name), "{}")
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { retracted: 1 })
}))

test("the derivation lock's own check refuses a write the earlier check allowed", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const { marker } = await orphan(ctx)
  const before = await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `claude-code-${ID}.json`), "utf8")
  await staleReceipt(ctx, `claude-code-${ID}.json`, (receipt) => receipt)
  assert.deepEqual(await deriveMarker(ctx.env, marker, { admit: async () => "retracted" }), { result: "refused", store: STORE, reason: "retracted" })
  assert.equal(await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `claude-code-${ID}.json`), "utf8"), before, "nothing was rewritten")
  assert.equal((await deriveMarker(ctx.env, marker, { admit: async () => null })).result, "written")
}))

test("an orphan in a crew desk stays frozen as crew_desk, told by its roster, its desks folder, an unreadable roster or an unstattable desks entry", () => scratch(async (ctx) => {
  await orphan(ctx)
  await fs.writeFile(path.join(ctx.desk, "_meta/desks.md"), "# Desks\n\nNo table here.\n| only | one |\n")
  assert.deepEqual(await rebuilt(ctx), [1, 0], "prose and an unrelated table are no roster")
  await staleReceipt(ctx, `claude-code-${ID}.json`, (receipt) => receipt)
  await fs.writeFile(path.join(ctx.desk, "_meta/desks.md"), "| alias | identity |\n| --- | --- |\n| ari | ari@example.com |\n")
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { crew_desk: 1 })
  await fs.rm(path.join(ctx.desk, "_meta/desks.md"))
  await fs.mkdir(path.join(ctx.desk, "_meta/desks.md"))
  assert.deepEqual(await rebuilt(ctx), [0, 1], "a roster that cannot be read is a crew desk")
  await fs.rm(path.join(ctx.desk, "_meta/desks.md"), { recursive: true })
  await fs.mkdir(path.join(ctx.desk, "desks"))
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  await fs.rm(path.join(ctx.desk, "desks"), { recursive: true })
  await fs.symlink("desks", path.join(ctx.desk, "desks"))
  assert.deepEqual(await rebuilt(ctx), [0, 1], "a desks entry that cannot be checked at all fails closed")
}))

test("an orphan whose cwd is a code repository, with no receipt desk_root, stays frozen", () => scratch(async (ctx) => {
  const code = path.join(ctx.base, "code")
  await fs.mkdir(path.join(code, "_meta"), { recursive: true })
  await orphan(ctx, { receiptRoot: false, cwd: code })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { no_desk_root: 1 })
}))

test("an orphan with no transcript stays frozen as no_transcript, with or without a Claude projects folder", () => scratch(async (ctx) => {
  await orphan(ctx, { transcript: false })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { no_transcript: 1 })
  await fs.rm(path.join(ctx.base, ".claude"), { recursive: true })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))

const copyFile = async (ctx, name) => path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name)
const exists = (file) => fs.lstat(file).then(() => true, () => false)

test("a delivered orphan whose transcript is gone and whose record is over 90 days old loses its outbox copy, and is still frozen as no_transcript", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx, { transcript: false })
  await markDelivered(ctx.env, STORE, { name, publishedBlobSha: "a".repeat(40), publishedPath: "facts/x.json", localSha: gitBlobSha(await fs.readFile(await copyFile(ctx, name))) })
  const { rebuildOrphans } = await runner()
  // Inside the window, nothing goes.
  assert.equal((await rebuildOrphans(ctx.env, { now: () => Date.parse(END) + 89 * DAY })).orphans.copies_pruned, undefined)
  assert.equal(await exists(await copyFile(ctx, name)), true)
  const swept = await rebuildOrphans(ctx.env, { now: () => Date.parse(END) + 91 * DAY })
  assert.equal(swept.orphans.copies_pruned, 1)
  assert.deepEqual([swept.orphans.frozen.no_transcript, swept.orphans.rebuilt], [1, 0])
  assert.equal(await exists(await copyFile(ctx, name)), false)
}))

test("an orphan copy that was never delivered, or whose pruning fails, stays and is counted as no_transcript only", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx, { transcript: false })
  const { rebuildOrphans } = await runner()
  const late = () => Date.parse(END) + 200 * DAY
  const undelivered = await rebuildOrphans(ctx.env, { now: late })
  assert.equal(undelivered.orphans.copies_pruned, undefined)
  assert.equal(await exists(await copyFile(ctx, name)), true, "undelivered: the copy is the only record")
  await markDelivered(ctx.env, STORE, { name, publishedBlobSha: "a".repeat(40), publishedPath: "facts/x.json", localSha: gitBlobSha(await fs.readFile(await copyFile(ctx, name))) })
  const failed = await rebuildOrphans(ctx.env, { now: late, pruneCopy: async () => { throw new Error("disk") } })
  assert.equal(failed.orphans.copies_pruned, undefined)
  assert.equal(failed.orphans.copies_prune_failed, 1, "a failed prune is counted, not swallowed")
  assert.equal(failed.orphans.frozen.no_transcript, 1, "a failed prune is no derive failure")
  assert.equal(await exists(await copyFile(ctx, name)), true)
}))

test("the sweep prunes tombstones past their window and reports how many, or a fixed code when it could not", () => scratch(async (ctx) => {
  const { sweep } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const file = path.join(await factoryStateRoot(ctx.env), "retracting", "ourostack__factory.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tomb = (at) => ({ path: "facts/x.json", blob: "a".repeat(40), done: true, at })
  await fs.writeFile(file, JSON.stringify({ [`claude-code-${ID}.json`]: tomb("2020-01-01T00:00:00.000Z"), [`claude-code-${ID.slice(0, -1)}1.json`]: tomb(new Date().toISOString()) }))
  await sweep(ctx.env)
  const retention = (await readStatus(ctx.env)).retention
  assert.equal(retention.tombstones_pruned, 1)
  assert.match(retention.ran_at, /^\d{4}-/u)
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, "utf8"))), [`claude-code-${ID.slice(0, -1)}1.json`])
  // The retracting folder is not a folder: the pruning fails, the sweep goes on and says so.
  await fs.rm(path.dirname(file), { recursive: true })
  await fs.writeFile(path.dirname(file), "not a folder")
  await sweep(ctx.env)
  assert.equal((await readStatus(ctx.env)).retention.failed, "prune_failed")
  assert.equal((await readStatus(ctx.env)).retention.tombstones_pruned, undefined)
}))

test("an orphan whose outbox copy is unreadable stays frozen as no_facts, and one whose transcript names no cwd as no_desk_root", () => scratch(async (ctx) => {
  const { name, marker } = await orphan(ctx, { receiptRoot: false })
  const lines = (await fs.readFile(marker.log_path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  delete lines[0].cwd
  await fs.writeFile(marker.log_path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { no_desk_root: 1 })
  await fs.writeFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name), "not json")
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { no_facts: 1 })
}))

test("a session that still has its marker is not an orphan", () => scratch(async (ctx) => {
  const { marker } = await orphan(ctx)
  await writeMarker(ctx.env, marker)
  assert.deepEqual(await rebuilt(ctx), [0, 0])
}))

test("the first cwd is read past a line that is not JSON; a relative cwd, or one whose folder is gone, leaves the orphan frozen", () => scratch(async (ctx) => {
  const { marker } = await orphan(ctx, { receiptRoot: false })
  const original = await fs.readFile(marker.log_path, "utf8")
  await fs.writeFile(marker.log_path, `not json\n${original}`)
  const old = new Date(Date.now() - 700000)
  await fs.utimes(marker.log_path, old, old)
  assert.deepEqual(await rebuilt(ctx), [1, 0], "a damaged line is skipped, the cwd after it is used")
  const lines = original.trim().split("\n").map((line) => JSON.parse(line))
  for (const cwd of ["relative/dir", path.join(ctx.base, "vanished")]) {
    lines[0].cwd = cwd
    await fs.writeFile(marker.log_path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
    await staleReceipt(ctx, `claude-code-${ID}.json`, (receipt) => {
      delete receipt.desk_root
      return receipt
    })
    assert.deepEqual(await rebuilt(ctx), [0, 1], cwd)
  }
}))

test("outbox folders that name no store, and copies from other hosts, are not Claude Code orphans", () => scratch(async (ctx) => {
  const root = await factoryStateRoot(ctx.env)
  await fs.mkdir(path.join(root, "outbox", "not-a-store"), { recursive: true })
  await fs.writeFile(path.join(root, "outbox", "not-a-store", `claude-code-${ID}.json`), "{}")
  await fs.mkdir(path.join(root, "outbox", "ourostack__factory"), { recursive: true })
  await fs.writeFile(path.join(root, "outbox", "ourostack__factory", `codex-cli-${ID}.json`), "{}")
  assert.deepEqual(await rebuilt(ctx), [0, 0])
}))

test("an orphan pass that throws records a fixed failure class and reads as failed, never as an empty pass; the sweep goes on", () => scratch(async (ctx) => {
  await orphan(ctx)
  const root = await factoryStateRoot(ctx.env)
  await fs.writeFile(path.join(root, "retracting"), "not a folder")
  const { sweep, ORPHAN_PASS_FAILED } = await runner()
  const summary = await sweep(ctx.env)
  assert.deepEqual([summary.rebuilt, summary.frozen, summary.pending, summary.unexamined], [undefined, undefined, undefined, undefined], "a failed pass has no counts, not zeros")
  const { ran_at: ranAt, started_at: startedAt, ...failed } = (await readStatus(ctx.env)).orphans
  assert.deepEqual(failed, { failed: ORPHAN_PASS_FAILED, cursor: null, last_wrap_at: null, sweeps_in_walk: 0 })
  assert.deepEqual([typeof ranAt, typeof startedAt], ["string", "string"])
  assert.deepEqual(Object.keys(summary.orphans).sort(), ["cursor", "failed", "last_wrap_at", "ran_at", "started_at", "sweeps_in_walk"])
  assert.equal(JSON.stringify(failed).includes(root), false, "no message text or path")
  await fs.rm(path.join(root, "retracting"))
  await fs.rm(path.join(root, "outbox"), { recursive: true })
  await fs.writeFile(path.join(root, "outbox"), "not a folder")
  assert.equal((await sweep(ctx.env)).orphans.failed, ORPHAN_PASS_FAILED)
}))

test("an unexpected error on one orphan freezes it as derive_failed and the pass goes on", { skip: process.getuid?.() === 0 || process.platform === "win32" }, () => scratch(async (ctx) => {
  const { marker } = await orphan(ctx, { receiptRoot: false })
  await fs.chmod(marker.log_path, 0)
  try {
    assert.deepEqual(await rebuilt(ctx), [0, 1])
    assert.deepEqual(await reasons(ctx), { derive_failed: 1 })
  } finally {
    await fs.chmod(marker.log_path, 0o644)
  }
}))

test("an orphan is looked for under CLAUDE_CONFIG_DIR, or the home folder when the environment names none", () => scratch(async (ctx) => {
  await orphan(ctx)
  const moved = path.join(ctx.base, "elsewhere")
  await fs.rename(path.join(ctx.base, ".claude"), moved)
  const { rebuildOrphans } = await runner()
  const first = await rebuildOrphans({ ...ctx.env, CLAUDE_CONFIG_DIR: moved })
  assert.deepEqual([first.rebuilt, first.frozen], [1, 0])
  const { HOME, ...homeless } = ctx.env
  await staleReceipt(ctx, `claude-code-${ID}.json`, (receipt) => receipt)
  assert.equal((await rebuildOrphans({ ...homeless, CLAUDE_CONFIG_DIR: moved })).rebuilt, 1)
  assert.equal(typeof (await rebuildOrphans({ ...homeless, XDG_STATE_HOME: ctx.env.XDG_STATE_HOME })).frozen, "number")
}))

test("an orphan whose store no longer takes contributions stays frozen as not_opted_in", () => scratch(async (ctx) => {
  await orphan(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: false })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { not_opted_in: 1 })
}))

test("an orphan whose derivation cannot read its transcript stays frozen as derive_failed", () => scratch(async (ctx) => {
  const { marker } = await orphan(ctx)
  await fs.writeFile(marker.log_path, "not a transcript\n")
  const old = new Date(Date.now() - 700000)
  await fs.utimes(marker.log_path, old, old)
  const { rebuildOrphans } = await runner()
  const result = await rebuildOrphans(ctx.env)
  assert.deepEqual([result.rebuilt, result.frozen], [0, 1])
  assert.deepEqual(await reasons(ctx), { derive_failed: 1 })
}))

test("an orphan inside the quiet window, whose log is still being written, is pending, not frozen", () => scratch(async (ctx) => {
  const { marker } = await orphan(ctx)
  await fs.appendFile(marker.log_path, `${JSON.stringify({ type: "assistant", sessionId: ID, timestamp: "2026-09-26T08:05:00.000Z", message: { content: [] } })}\n`)
  const { rebuildOrphans } = await runner()
  const result = await rebuildOrphans(ctx.env, { quietMs: 600000 })
  assert.deepEqual([result.rebuilt, result.pending, result.frozen], [0, 1, 0])
}))

test("more orphans than the cap are pending, and the next sweep rebuilds them", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  await clone(ctx, first, "1")
  await clone(ctx, first, "2")
  const { rebuildOrphans } = await runner()
  const one = await rebuildOrphans(ctx.env, { cap: 2 })
  assert.deepEqual([one.rebuilt, one.pending, one.frozen], [2, 0, 0])
  assert.equal((await readStatus(ctx.env)).orphans.unexamined, 1, "visible from outside")
  const two = await rebuildOrphans(ctx.env, { cap: 3 })
  assert.deepEqual([two.rebuilt, two.pending, two.current, two.orphans.unexamined], [1, 0, 2, 0], "a sweep that examines everything reports a measured zero")
}))

test("the pass stops at its time budget and leaves the rest pending", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  await clone(ctx, first, "1")
  const times = [0, 0, 10]
  const clock = () => times.shift() ?? 10
  const { rebuildOrphans } = await runner()
  const result = await rebuildOrphans(ctx.env, { budgetMs: 5, clock })
  assert.deepEqual([result.rebuilt, result.pending, result.orphans.unexamined], [1, 0, 1])
  assert.deepEqual([(await rebuildOrphans(ctx.env)).rebuilt], [1], "the next pass finishes it")
}))

test("a desk root read from the transcript's cwd is checked for crew and declaration like a receipt's", () => scratch(async (ctx) => {
  await orphan(ctx, { receiptRoot: false })
  await fs.writeFile(path.join(ctx.desk, "_meta/desks.md"), "| alias | identity |\n| --- | --- |\n| ari | ari@example.com |\n")
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  assert.deepEqual(await reasons(ctx), { crew_desk: 1 })
}))

test("a retraction that lands after the early check is caught inside the derivation lock, and again right before the facts are written", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx)
  const file = path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name)
  const before = await fs.readFile(file, "utf8")
  const { rebuildOrphans } = await runner()
  let answers = [new Set(), new Set([name])]
  const early = await rebuildOrphans(ctx.env, { retractions: async () => answers.shift() })
  assert.deepEqual([early.rebuilt, early.frozen], [0, 1])
  assert.deepEqual(await reasons(ctx), { retracted: 1 })
  answers = [new Set(), new Set(), new Set([name])]
  const late = await rebuildOrphans(ctx.env, { retractions: async () => answers.shift() })
  assert.deepEqual([late.rebuilt, late.frozen], [0, 1])
  assert.equal(await fs.readFile(file, "utf8"), before, "nothing was written after the late check refused")
}))

const recordNewerDesk = async (ctx, name, change = (facts) => facts) => {
  const file = path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name)
  const facts = JSON.parse(await fs.readFile(file, "utf8"))
  facts.plugins[0].version = "999.0.0"
  await fs.writeFile(file, JSON.stringify(change(facts)))
  return file
}

test("an orphan recorded by a newer Desk waits as pending with its age, then freezes once the seven days pass, taking no transcript-work slot", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  const second = await clone(ctx, first, "1")
  await recordNewerDesk(ctx, first.name)
  const { rebuildOrphans } = await runner()
  const ended = Date.parse(END)
  const own = { ownVersion: () => "1.0.0", cap: 1 }
  const waiting = await rebuildOrphans(ctx.env, { ...own, now: () => ended + 2 * DAY })
  assert.deepEqual([waiting.rebuilt, waiting.pending, waiting.frozen], [1, 1, 0], "the held orphan did not use the one slot, so the other was rebuilt")
  assert.equal(waiting.orphans.oldest_pending_days, 2)
  assert.equal((await readStatus(ctx.env)).orphans.oldest_pending_days, 2, "visible from outside")
  assert.equal(typeof second, "string")
  const expired = await rebuildOrphans(ctx.env, { ...own, now: () => ended + 8 * DAY })
  assert.deepEqual([expired.pending, expired.frozen, expired.orphans.oldest_pending_days], [0, 1, null])
  assert.deepEqual(await reasons(ctx), { recorded_by_newer_desk: 1 })
}))

test("a newer-Desk orphan with no recorded end takes its hold's time from the outbox file", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx)
  const file = await recordNewerDesk(ctx, name, (facts) => ({ ...facts, session: { ...facts.session, ended_at: null } }))
  const at = new Date(Date.UTC(2026, 8, 20))
  await fs.utimes(file, at, at)
  const { rebuildOrphans } = await runner()
  const result = await rebuildOrphans(ctx.env, { ownVersion: () => "1.0.0", now: () => at.getTime() + 3 * DAY })
  assert.deepEqual([result.pending, result.orphans.oldest_pending_days], [1, 3])
}))

test("a newer-Desk check that cannot read this Desk's own version lets the orphan through", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx)
  await recordNewerDesk(ctx, name)
  const { rebuildOrphans } = await runner()
  const result = await rebuildOrphans(ctx.env, { ownVersion: () => { throw new Error("unreadable") } })
  assert.equal(result.rebuilt, 1)
}))

test("an orphan whose desk stops yielding a store between the check and the derive is frozen as route_unknown, not pending", () => scratch(async (ctx) => {
  await orphan(ctx)
  const { rebuildOrphans } = await runner()
  // This Desk's version is read after the desk's declaration was checked and before the derive reads it again.
  const ownVersion = () => {
    writeFileSync(path.join(ctx.desk, "_meta/factory.json"), JSON.stringify({ schema_version: 1, store: "invalid" }))
    return "1.0.0"
  }
  const result = await rebuildOrphans(ctx.env, { ownVersion })
  assert.deepEqual([result.rebuilt, result.pending, result.frozen], [0, 0, 1])
  assert.deepEqual(await reasons(ctx), { route_unknown: 1 })
}))

test("a stuck orphan cannot starve the rest: the pass resumes after its cursor and wraps, so a good orphan sorted last is rebuilt in ceil(orphans / cap) sweeps", () => scratch(async (ctx) => {
  const code = path.join(ctx.base, "code")
  await fs.mkdir(path.join(code, "_meta"), { recursive: true })
  const first = await orphan(ctx, { receiptRoot: false, cwd: code })
  const stuck = [first.name]
  for (const digit of ["1", "2", "3", "4", "5"]) stuck.push(await clone(ctx, first, digit))
  const good = await clone(ctx, first, "9")
  await staleReceipt(ctx, good, (receipt) => ({ ...receipt, desk_root: ctx.desk }))
  const goodLog = path.join(path.dirname(first.marker.log_path), `${good.slice(12, -5)}.jsonl`)
  const lines = (await fs.readFile(goodLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  lines[0].cwd = ctx.desk
  await fs.writeFile(goodLog, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  const { rebuildOrphans } = await runner()
  const cap = 2
  const sweeps = Math.ceil((stuck.length + 1) / cap)
  const seen = []
  for (let sweep = 1; sweep <= sweeps; sweep += 1) {
    const result = await rebuildOrphans(ctx.env, { cap })
    seen.push(result.rebuilt)
    assert.equal(typeof (await readStatus(ctx.env)).orphans.cursor, "string", "the record carries where the next pass starts")
  }
  assert.deepEqual(seen, [0, 0, 0, 1], "rebuilt on the last sweep the arithmetic allows, not before and not never")
  assert.equal(stuck.length, 6)
}))

test("the pass writes that it started before the work, so a record with a start and no result reads as interrupted", () => scratch(async (ctx) => {
  await orphan(ctx, { declare: false })
  const { rebuildOrphans } = await runner()
  const { writeStatus: realWrite } = await import(new URL("../../../../../plugins/desk/mcp/src/factory/outbox.js", import.meta.url))
  await rebuildOrphans(ctx.env, { now: () => Date.parse("2026-10-06T00:00:00.000Z") })
  const writes = []
  const write = async (env, patch) => {
    writes.push(patch)
    if (writes.length === 2) throw new Error("disk full")
    return realWrite(env, patch)
  }
  const result = await rebuildOrphans(ctx.env, { now: () => Date.parse("2026-10-07T00:00:00.000Z"), write })
  assert.equal(result.frozen, 1, "the pass still returns its result")
  const record = (await readStatus(ctx.env)).orphans
  assert.deepEqual(Object.keys(record).sort(), ["cursor", "last_wrap_at", "started_at", "sweeps_in_walk"], "the earlier result was replaced by a start with no result")
  assert.equal(record.started_at, "2026-10-07T00:00:00.000Z")
}))

test("an orphan whose derive throws is examined and failed, and the next pass starts after it", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  const middle = await clone(ctx, first, "1")
  const last = await clone(ctx, first, "2")
  const { rebuildOrphans, deriveMarker } = await runner()
  const calls = []
  const derive = async (env, marker, options) => {
    calls.push(`claude-code-${marker.session_id}.json`)
    if (`claude-code-${marker.session_id}.json` === middle) throw new Error("boom")
    return deriveMarker(env, marker, options)
  }
  const result = await rebuildOrphans(ctx.env, { derive })
  assert.deepEqual(calls, [first.name, middle, last])
  assert.deepEqual(result.orphans.frozen.derive_failed, 1, "recorded as examined and failed, not skipped")
  assert.equal(result.orphans.examined, 3)
  assert.equal(result.orphans.cursor, last)
}))

// A pass stopped inside `name`'s derive, as the start hook's hard stop would: the record names it and has no result.
const interruptedAt = async (ctx, name, startedAt, hung) => {
  const { writeStatus: realWrite } = await import(new URL("../../../../../plugins/desk/mcp/src/factory/outbox.js", import.meta.url))
  await realWrite(ctx.env, { orphans: { started_at: startedAt, cursor: name, last_wrap_at: null, sweeps_in_walk: 0, attempting: name, ...(hung ? { hung } : {}) } })
}

const ownVersion = () => "1.0.0"

test("an orphan interrupted mid-derive by two separate passes is frozen as derive_failed and not derived again; one interruption is not enough", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  const middle = await clone(ctx, first, "1")
  await clone(ctx, first, "2")
  const { rebuildOrphans, deriveMarker } = await runner()
  const calls = []
  const derive = async (env, marker, options) => {
    calls.push(`claude-code-${marker.session_id}.json`)
    return deriveMarker(env, marker, options)
  }
  const old = "2026-10-01T00:00:00.000Z"
  const now = () => Date.parse("2026-10-06T00:00:00.000Z")
  // One interrupted pass: a strike, not a freeze, and the orphan is derived and rebuilt.
  await interruptedAt(ctx, middle, old)
  const one = await rebuildOrphans(ctx.env, { derive, now, ownVersion })
  assert.ok(calls.includes(middle), "one interruption does not freeze it")
  assert.equal(one.orphans.frozen.derive_failed, 0)
  assert.equal(one.orphans.hung, undefined, "and a derive that finished loses its strike")
  // Two interrupted passes in a row: the second strike freezes it, examined and failed, never derived.
  calls.length = 0
  await interruptedAt(ctx, middle, old, { [middle]: { strikes: 1, version: "1.0.0" } })
  await staleReceipt(ctx, middle, (receipt) => receipt)
  const two = await rebuildOrphans(ctx.env, { derive, now, ownVersion })
  assert.ok(!calls.includes(middle), "frozen without another derive")
  assert.equal(two.orphans.frozen.derive_failed, 1)
  assert.deepEqual(two.orphans.hung, { [middle]: { strikes: 2, version: "1.0.0" } })
  // A newer Desk starts again.
  calls.length = 0
  const newer = await rebuildOrphans(ctx.env, { derive, now, ownVersion: () => "999.0.0" })
  assert.ok(calls.includes(middle))
  assert.equal(newer.orphans.frozen.derive_failed, 0)
}))

test("a record without a result younger than the hard stop is a pass still running, not a strike; one whose start does not parse is a strike", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  const { rebuildOrphans } = await runner()
  const now = () => Date.parse("2026-10-06T00:00:00.000Z")
  // A derive that waits keeps the orphan unrebuilt, so its strikes stay in the record.
  const derive = async () => ({ result: "skipped" })
  const prior = { [first.name]: { strikes: 1, version: "1.0.0" } }
  await interruptedAt(ctx, first.name, "2026-10-05T23:59:30.000Z", prior)
  assert.deepEqual((await rebuildOrphans(ctx.env, { now, derive, ownVersion })).orphans.hung, prior, "30 seconds old: maybe still running, no strike")
  await interruptedAt(ctx, first.name, "garbage", prior)
  assert.deepEqual((await rebuildOrphans(ctx.env, { now, derive, ownVersion })).orphans.hung, { [first.name]: { strikes: 2, version: "1.0.0" } }, "an unreadable start reads as interrupted")
}))

test("a transcript with another hard link is not trusted: the orphan has no transcript", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  await fs.link(first.marker.log_path, path.join(path.dirname(first.marker.log_path), "second-name.jsonl"))
  const { rebuildOrphans } = await runner()
  const result = await rebuildOrphans(ctx.env)
  assert.equal(result.rebuilt, 0)
  assert.deepEqual(await reasons(ctx), { no_transcript: 1 })
}))

test("a derive that answers held (the desk no longer yields a store) freezes the orphan as route_unknown", () => scratch(async (ctx) => {
  await orphan(ctx)
  const { rebuildOrphans } = await runner()
  const result = await rebuildOrphans(ctx.env, { derive: async () => ({ result: "held", store: null }) })
  assert.equal(result.rebuilt, 0)
  assert.deepEqual(await reasons(ctx), { route_unknown: 1 })
}))

test("a failed write of the attempt record does not stop the pass, which still derives the orphan", () => scratch(async (ctx) => {
  await orphan(ctx)
  const { rebuildOrphans } = await runner()
  const { writeStatus: realWrite } = await import(new URL("../../../../../plugins/desk/mcp/src/factory/outbox.js", import.meta.url))
  const write = async (env, patch) => {
    if (patch.orphans?.attempting !== undefined) throw new Error("disk full")
    return realWrite(env, patch)
  }
  const result = await rebuildOrphans(ctx.env, { write })
  assert.equal(result.rebuilt, 1)
}))

test("an orphan whose derive finished and wrote its receipt is never frozen by earlier strikes", () => scratch(async (ctx) => {
  const first = await orphan(ctx, { stale: false })
  const { rebuildOrphans } = await runner()
  await interruptedAt(ctx, first.name, "2026-10-01T00:00:00.000Z", { [first.name]: { strikes: 5, version: "1.0.0" } })
  const result = await rebuildOrphans(ctx.env, { now: () => Date.parse("2026-10-06T00:00:00.000Z"), ownVersion })
  assert.equal(result.orphans.current, 1)
  assert.equal(result.orphans.frozen.derive_failed, 0)
  assert.equal(result.orphans.hung, undefined)
}))

test("a derive records the desk's GitHub repository on the receipt and carries the flush's desk_unprotected mark across a derive again", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: STORE })
  execFileSync("git", ["init", "-q", ctx.desk])
  execFileSync("git", ["-C", ctx.desk, "remote", "add", "origin", "https://github.com/Acme/Desk.git"])
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const name = `claude-code-${ID}.json`
  assert.equal((await readStatus(ctx.env)).derivations[name].desk_repo, "acme/desk")
  assert.equal((await readStatus(ctx.env)).derivations[name].desk_unprotected, undefined)
  await staleReceipt(ctx, name, (receipt) => ({ ...receipt, desk_unprotected: true }))
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const receipt = (await readStatus(ctx.env)).derivations[name]
  assert.equal(receipt.desk_unprotected, true)
  assert.equal(receipt.desk_repo, "acme/desk")
}))

test("facts, transcript lookup and the source stat run only for orphans inside the cap", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  for (const digit of ["1", "2", "3"]) await clone(ctx, first, digit)
  const root = await factoryStateRoot(ctx.env)
  for (const name of await fs.readdir(path.join(root, "outbox", "ourostack__factory"))) {
    if (name !== first.name) await fs.writeFile(path.join(root, "outbox", "ourostack__factory", name), "not json")
  }
  const { rebuildOrphans } = await runner()
  const result = await rebuildOrphans(ctx.env, { cap: 1 })
  assert.deepEqual(await reasons(ctx), {}, "the unreadable copies were not even opened beyond the cap")
  assert.deepEqual([result.rebuilt, result.pending, result.orphans.unexamined], [1, 0, 3])
}))

test("the oldest of several waiting orphans sets oldest_pending_days", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  const second = await clone(ctx, first, "1")
  await recordNewerDesk(ctx, first.name)
  await recordNewerDesk(ctx, second, (facts) => ({ ...facts, session: { ...facts.session, ended_at: new Date(Date.parse(END) + DAY).toISOString() } }))
  const { rebuildOrphans } = await runner()
  const result = await rebuildOrphans(ctx.env, { ownVersion: () => "1.0.0", now: () => Date.parse(END) + 2 * DAY })
  assert.deepEqual([result.pending, result.orphans.oldest_pending_days], [2, 2])
}))

// Four orphans whose transcripts are gone: each stays frozen as `no_transcript` and takes a slot every sweep, so the cap and the walk can be seen at work.
async function lostOrphans(ctx) {
  const first = await orphan(ctx, { stale: false })
  for (const digit of ["1", "2", "3"]) await clone(ctx, first, digit)
  for (const id of [ID, ...["1", "2", "3"].map((digit) => `${ID.slice(0, -1)}${digit}`)]) await fs.rm(path.join(path.dirname(first.marker.log_path), `${id}.jsonl`), { force: true })
  await fs.rm(first.marker.log_path, { force: true })
  return first
}

test("a pile of current orphans takes no slot: a long list of them never makes the work behind it wait", () => scratch(async (ctx) => {
  const first = await orphan(ctx, { stale: false })
  for (const digit of ["1", "2", "3"]) await clone(ctx, first, digit)
  const { rebuildOrphans } = await runner()
  assert.equal((await rebuildOrphans(ctx.env, { cap: 10 })).rebuilt, 3, "the copies get receipts of their own, so all four are current after this")
  // A cap of one still reaches all four, because a current orphan gives its slot back.
  const one = await rebuildOrphans(ctx.env, { cap: 1 })
  assert.deepEqual([one.pending, one.orphans.unexamined, one.orphans.examined, one.orphans.current, one.orphans.worked], [0, 0, 4, 4, 4])
  assert.equal((await readStatus(ctx.env)).orphans.oldest_pending_days, null, "no age: nothing is waiting")
  assert.equal(one.orphans.last_wrap_at !== null, true, "every orphan was reached: the walk wrapped")
}))

test("a cap of slots goes to orphans with work to do, however many current ones come first", () => scratch(async (ctx) => {
  const first = await orphan(ctx, { stale: false })
  for (const digit of ["1", "2", "3"]) await clone(ctx, first, digit)
  const { rebuildOrphans } = await runner()
  await rebuildOrphans(ctx.env, { cap: 10 })
  // The last orphan in name order goes stale; the three current ones before it take no slot, so a cap of one reaches it in one sweep.
  await staleReceipt(ctx, `claude-code-${ID.slice(0, -1)}3.json`, (receipt) => { receipt.binding_version = 1; return receipt })
  const swept = await rebuildOrphans(ctx.env, { cap: 1 })
  assert.deepEqual([swept.rebuilt, swept.orphans.current, swept.orphans.unexamined], [1, 3, 0])
}))

test("the record shows the walk: when the cursor last wrapped and how many sweeps this walk has taken", () => scratch(async (ctx) => {
  await lostOrphans(ctx)
  const { rebuildOrphans } = await runner()
  const at = (day) => () => Date.parse(`2026-10-0${day}T00:00:00.000Z`)
  const walk = async (cap, day) => {
    const { orphans } = await rebuildOrphans(ctx.env, { cap, now: at(day) })
    return [orphans.last_wrap_at, orphans.sweeps_in_walk, orphans.unexamined]
  }
  assert.deepEqual(await walk(10, 1), ["2026-10-01T00:00:00.000Z", 0, 0], "everything examined in one sweep is a wrap")
  assert.deepEqual(await walk(1, 2), ["2026-10-01T00:00:00.000Z", 1, 3], "one orphan of four: the walk is one sweep in and the wrap time stays")
  assert.deepEqual(await walk(1, 3), ["2026-10-01T00:00:00.000Z", 2, 3])
  assert.deepEqual(await walk(1, 4), ["2026-10-01T00:00:00.000Z", 3, 3])
  assert.deepEqual(await walk(1, 5), ["2026-10-05T00:00:00.000Z", 0, 3], "the last orphan was reached: the walk wrapped")
}))

test("before the first wrap the wrap time is not yet, never a zero or a start of the epoch", () => scratch(async (ctx) => {
  await lostOrphans(ctx)
  const { rebuildOrphans } = await runner()
  const one = (await rebuildOrphans(ctx.env, { cap: 1 })).orphans
  assert.deepEqual([one.last_wrap_at, one.sweeps_in_walk], [null, 1])
}))

test("orphans recorded by a newer Desk advance the cursor, so enough of them cannot hold up the orphans after them", () => scratch(async (ctx) => {
  const first = await orphan(ctx)
  const held = [first.name]
  for (const digit of ["1", "2"]) held.push(await clone(ctx, first, digit))
  const good = await clone(ctx, first, "9")
  for (const name of held) await recordNewerDesk(ctx, name)
  const { rebuildOrphans } = await runner()
  let ticks = 0
  const options = { ownVersion: () => "1.0.0", budgetMs: 3, now: () => Date.parse(END) + DAY }
  const sweep = () => { ticks = 0; return rebuildOrphans(ctx.env, { ...options, clock: () => ticks++ }) }
  const one = await sweep()
  assert.deepEqual([one.rebuilt, one.pending, one.orphans.unexamined], [0, 2, 2], "the budget reached two of them")
  const two = await sweep()
  assert.equal(two.rebuilt, 1, "the next sweep went on past them to the good orphan")
  assert.equal(typeof good, "string")
}))

// --- outcomes ---------------------------------------------------------------------

const REMOTE = "git@github.com:Owner/Desk.git"
const NOW = "2026-09-26T10:00:00.000Z"
const idFor = (track, slug, personPrefix = "") => jobId({ deskRemote: REMOTE, personPrefix, track, slug })
const signoffCall = (track, slug, overrides = {}) => ({ at: START, name: "mcp__plugin_desk_desk__task_signoff", track, slug, person: null, status: null, agent: 0, ok: true, ...overrides })
const ACCEPTED = sign(deliver({}, { at: "2026-09-25T09:00:00.000Z" }), { status: "done", outcome: "accepted", verified: true, at: "2026-09-25T09:20:00.000Z" }).record

// Fake card readers: `cards` maps `track/slug` to what `readOutcome` answers; `birth` maps it to a birth path.
function readers(cards, birth = {}) {
  const seen = []
  return {
    seen,
    readOutcome: (track, slug) => {
      seen.push(`${track}/${slug}`)
      const found = cards[`${track}/${slug}`]
      if (found instanceof Error) throw found
      return found ?? null
    },
    resolveJobIdentity: (track, slug) => birth[`${track}/${slug}`] ?? { track, slug },
  }
}
const identity = { deskRemote: REMOTE, personPrefix: "" }
const ENTRY_KEYS = ["job", "rev", "state", "verified", "reason", "deliveries", "delivered_at", "signed_at", "observed_at"]

test("a bound job's card record becomes its outcome entry", async () => {
  const { outcomesFor } = await runner()
  const bound = [{ job: idFor("a", "one"), track: "a", slug: "one" }]
  const list = outcomesFor({ jobs: bound, lifecycleCalls: [], readers: readers({ "a/one": { record: ACCEPTED, status: "done", evidenceAt: "2026-09-25T09:30:00.000Z" } }), identity, now: NOW })
  assert.deepEqual(list, [{
    job: idFor("a", "one"),
    rev: ACCEPTED.flow.rev,
    state: "accepted",
    verified: true,
    reason: null,
    deliveries: 1,
    delivered_at: "2026-09-25T09:00:00.000Z",
    signed_at: "2026-09-25T09:20:00.000Z",
    observed_at: NOW,
    since: "adopted",
    first_validating_at: "2026-09-25T09:00:00.000Z",
    first_delivered_at: "2026-09-25T09:00:00.000Z",
    returns: [],
  }])
  assert.deepEqual(Object.keys(list[0]), [...ENTRY_KEYS, "since", "first_validating_at", "first_delivered_at", "returns"], "exactly these keys: the snapshot's other keys are dropped")
  assert.deepEqual(validateLocalFacts({ ...JSON.parse(JSON.stringify(await goldenFacts())), outcomes: list }), { ok: true, errors: [] })
})

async function goldenFacts() {
  return JSON.parse(await fs.readFile(new URL("./fixtures/local-golden.json", import.meta.url), "utf8"))
}

test("a task signed in a session that did no work on it gets an outcome entry and no job binding", async () => {
  const { outcomesFor } = await runner()
  const card = { record: ACCEPTED, status: "done", evidenceAt: null }
  const reader = readers({ "a/signed": card })
  // The job is the birth path's, as binding computes it, not the path the call named.
  const list = outcomesFor({ jobs: [], lifecycleCalls: [signoffCall("a", "signed")], readers: { ...reader, resolveJobIdentity: () => ({ track: "born", slug: "first" }) }, identity, now: NOW })
  assert.deepEqual(list.map((entry) => entry.job), [idFor("born", "first")])
  assert.equal(list[0].state, "accepted")
  assert.deepEqual(reader.seen, ["a/signed"], "the card is read where the call named it")
})

test("the lifecycle calls that count are the successful ones that name a task, and each task is listed once, with the bound job's entry", async () => {
  const { outcomesFor } = await runner()
  const card = { record: ACCEPTED, status: "done", evidenceAt: null }
  const reader = readers({ "a/x": card, "a/y": card, "a/z": card, "a/w": card, "a/v": card })
  const name = (verb) => `mcp__plugin_desk_desk__${verb}`
  const list = outcomesFor({
    jobs: [{ job: idFor("a", "x"), track: "a", slug: "x" }],
    lifecycleCalls: [
      signoffCall("a", "x"), signoffCall("a", "x"),
      signoffCall("a", "y", { name: name("task_update") }),
      signoffCall("a", "z", { name: name("task_create") }),
      signoffCall("a", "w", { name: name("task_archive") }),
      signoffCall("a", "v", { ok: false }),
      signoffCall("a", "v", { name: name("task_focus") }),
      signoffCall("a", "v", { name: name("desk_save") }),
      signoffCall("a", "v", { name: undefined }),
      signoffCall("..", "v"),
      signoffCall("a", undefined),
      null,
    ],
    readers: reader,
    identity,
    now: NOW,
  })
  assert.deepEqual(list.map((entry) => entry.job), ["x", "y", "z", "w"].map((slug) => idFor("a", slug)).sort())
  assert.deepEqual(reader.seen.filter((seen) => seen === "a/x").length, 1, "a task is read once however many calls name it")
  assert.equal(reader.seen.includes("a/v"), false)
})

test("a legacy done card gives state not_recorded, and a card that was never delivered gives not_delivered", async () => {
  const { outcomesFor } = await runner()
  const empty = { signoff: null, flow: null, returns: [], returns_damaged: 0 }
  const list = outcomesFor({
    jobs: [{ job: idFor("a", "old"), track: "a", slug: "old" }, { job: idFor("a", "new"), track: "a", slug: "new" }],
    lifecycleCalls: [],
    readers: readers({ "a/old": { record: empty, status: "done", evidenceAt: "2026-09-24T08:00:00.000Z" }, "a/new": { record: empty, status: "processing", evidenceAt: null } }),
    identity,
    now: NOW,
  })
  const byJob = Object.fromEntries(list.map((entry) => [entry.job, entry]))
  assert.deepEqual(byJob[idFor("a", "old")], { job: idFor("a", "old"), rev: 0, state: "not_recorded", verified: null, reason: null, deliveries: 0, delivered_at: "2026-09-24T08:00:00.000Z", signed_at: null, observed_at: NOW })
  assert.deepEqual(byJob[idFor("a", "new")], { job: idFor("a", "new"), rev: 0, state: "not_delivered", verified: null, reason: null, deliveries: 0, delivered_at: null, signed_at: null, observed_at: NOW })
})

test("a card whose status cannot be read gives no entry, since no state can be told from it", async () => {
  const { outcomesFor } = await runner()
  const record = { signoff: null, flow: null, returns: [], returns_damaged: 0 }
  const list = outcomesFor({ jobs: [{ job: idFor("a", "odd"), track: "a", slug: "odd" }], lifecycleCalls: [], readers: readers({ "a/odd": { record, status: null, evidenceAt: null } }), identity, now: NOW })
  assert.deepEqual(list, [])
})

test("a card that cannot be found, or a reader or identity that fails, gives no entry and never stops the others", async () => {
  const { outcomesFor } = await runner()
  const card = { record: ACCEPTED, status: "done", evidenceAt: null }
  const reader = readers({ "a/ok": card, "a/broken": new Error("unreadable") })
  const list = outcomesFor({ jobs: [], lifecycleCalls: [signoffCall("a", "missing"), signoffCall("a", "broken"), signoffCall("a", "ok")], readers: reader, identity, now: NOW })
  assert.deepEqual(list.map((entry) => entry.job), [idFor("a", "ok")])
  // A desk with no remote cannot name a job: the entry is left out rather than the derivation failing.
  assert.deepEqual(outcomesFor({ jobs: [], lifecycleCalls: [signoffCall("a", "ok")], readers: reader, identity: { deskRemote: null, personPrefix: "" }, now: NOW }), [])
})

test("the three times are canonical UTC instants or null, observed_at is the time passed in, and a damaged returns list still gives an entry", async () => {
  const { outcomesFor } = await runner()
  const record = {
    signoff: { state: "accepted", at: "2026-09-25T11:20:00+02:00", verified: false, reason: null },
    flow: { since: "created", rev: 7, reached: "done", first_validating_at: null, first_delivered_at: null, delivered_at: "2026-09-25T09:00:00Z", deliveries: 2 },
    returns: ["not a readable return line"],
    returns_damaged: 1,
  }
  const found = { record, status: "done", evidenceAt: null }
  const one = [{ job: idFor("a", "one"), track: "a", slug: "one" }]
  const [entry] = outcomesFor({ jobs: one, lifecycleCalls: [], readers: readers({ "a/one": found }), identity, now: Date.parse(NOW) })
  assert.deepEqual(entry, { job: idFor("a", "one"), rev: 7, state: "accepted", verified: false, reason: null, deliveries: 2, delivered_at: "2026-09-25T09:00:00.000Z", signed_at: "2026-09-25T09:20:00.000Z", observed_at: NOW, since: "created", returns: [], returns_unreadable: 2 })
  assert.equal(outcomesFor({ jobs: one, lifecycleCalls: [], readers: readers({ "a/one": found }), identity, now: "not a time" })[0].observed_at, null)
  const odd = { ...found, record: { ...record, signoff: { ...record.signoff, at: "yesterday" } } }
  assert.equal(outcomesFor({ jobs: one, lifecycleCalls: [], readers: readers({ "a/one": odd }), identity, now: NOW })[0].signed_at, null)
})

test("the list is sorted by job and holds at most LIMITS.outcomes entries", async () => {
  const { outcomesFor } = await runner()
  const card = { record: ACCEPTED, status: "done", evidenceAt: null }
  const slugs = Array.from({ length: LIMITS.outcomes + 5 }, (_, index) => `task-${index}`)
  const cards = Object.fromEntries(slugs.map((slug) => [`a/${slug}`, card]))
  const list = outcomesFor({ jobs: [], lifecycleCalls: slugs.map((slug) => signoffCall("a", slug)), readers: readers(cards), identity, now: NOW })
  assert.equal(list.length, LIMITS.outcomes)
  assert.deepEqual(list.map((entry) => entry.job), [...list.map((entry) => entry.job)].sort())
})

// A card in block form, as the task tools write it.
const CARD_TEXT = (title, status = "done") => [
  "---", `title: ${title}`, `status: ${status}`, `created: ${START}`, "updated: 2026-09-26T08:30:00.000Z",
  "signoff:", "  state: accepted", "  at: 2026-09-26T08:20:00.000Z", "  verified: true",
  "flow:", "  since: created", "  rev: 3", "  reached: done", "  delivered_at: 2026-09-26T08:10:00.000Z", "  deliveries: 1",
  "---", `body ${title}`, "",
].join("\n")
const SEGMENT = "PRIVATE-segment-must-never-persist"

async function writeOutcomeCard(ctx, folder, title) {
  const card = path.join(ctx.desk, folder, "task.md")
  await fs.mkdir(path.dirname(card), { recursive: true })
  await fs.writeFile(card, CARD_TEXT(title))
}

test("a session derived with a sign-off call writes the task's outcome with the same job ID binding gives, lists it in the jobs index, and carries no card text", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await writeOutcomeCard(ctx, `${SEGMENT}/worked`, SENTINEL)
  await writeOutcomeCard(ctx, `${SEGMENT}/_archive/signed-only`, SENTINEL)
  await appendCalls(marker, [
    ["mcp__desk__task_update", { track: SEGMENT, slug: "worked", frontmatter: { status: "done" }, title: SENTINEL }],
    ["Write", { file_path: path.join(ctx.desk, SEGMENT, "worked", "notes.md"), content: SENTINEL }],
    ["Write", { file_path: path.join(ctx.desk, SEGMENT, "worked", "more.md"), content: SENTINEL }],
    ["Write", { file_path: path.join(ctx.desk, SEGMENT, "worked", "again.md"), content: SENTINEL }],
    ["mcp__desk__task_signoff", { track: SEGMENT, slug: "signed-only", outcome: "accepted", reason: SENTINEL }],
    ["mcp__desk__task_signoff", { track: SEGMENT, slug: "failed", outcome: "accepted" }],
  ])
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, marker, { now: () => Date.parse(NOW) })).result, "written")
  const bytes = await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `claude-code-${ID}.json`), "utf8")
  const facts = JSON.parse(bytes)
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
  assert.equal(facts.jobs.length, 1, "the sign-off bound nothing")
  assert.equal(facts.outcomes.length, 2)
  assert.deepEqual(facts.outcomes.map((entry) => entry.job), [...facts.outcomes.map((entry) => entry.job)].sort())
  const worked = facts.outcomes.find((entry) => entry.job === facts.jobs[0].job)
  assert.ok(worked, "an outcome's job is the bound job's ID for the same task")
  assert.deepEqual(worked, { job: facts.jobs[0].job, rev: 3, state: "accepted", verified: true, reason: null, deliveries: 1, delivered_at: "2026-09-26T08:10:00.000Z", signed_at: "2026-09-26T08:20:00.000Z", observed_at: NOW, since: "created", returns: [] })
  assert.equal(facts.outcomes.every((entry) => Object.keys(entry).join() === [...ENTRY_KEYS, "since", "returns"].join()), true)
  const index = await readJobsIndex(ctx.env)
  for (const entry of facts.outcomes) assert.deepEqual(index[entry.job], [`claude-code-${ID}.json`])
  for (const secret of [SENTINEL, SEGMENT, "signed-only", "worked", "body", "title"]) assert.equal(bytes.includes(secret), false, secret)
  assert.equal(JSON.stringify(await readStatus(ctx.env)).includes(SEGMENT), false)
}))

// --- outcomes: the record's start and its returns ---------------------------------

const returnLine = (index, reason = "agent_error") => formatReturn({ at: new Date(Date.parse("2026-09-25T08:00:00.000Z") + index * 60_000).toISOString(), from: "validating", to: "processing", reason, caught: "at_review", refusal: null, refusal_verified: null })
const flowOf = (changes = {}) => ({ since: "created", rev: 3, reached: "done", first_validating_at: "2026-09-25T08:30:00Z", first_delivered_at: "2026-09-25T09:00:00Z", delivered_at: "2026-09-25T09:00:00Z", deliveries: 1, ...changes })
const oneEntry = async (record, now = NOW) => {
  const { outcomesFor } = await runner()
  return outcomesFor({ jobs: [{ job: idFor("a", "one"), track: "a", slug: "one" }], lifecycleCalls: [], readers: readers({ "a/one": { record, status: "done", evidenceAt: null } }), identity, now })[0]
}

test("since reads adopted for a card that gained its record late and created otherwise, and the milestone times are canonical", async () => {
  const adopted = await oneEntry({ flow: flowOf({ since: "adopted" }), returns: [] })
  assert.equal(adopted.since, "adopted")
  const created = await oneEntry({ flow: flowOf(), returns: [] })
  assert.equal(created.since, "created")
  assert.equal(created.first_validating_at, "2026-09-25T08:30:00.000Z")
  assert.equal(created.first_delivered_at, "2026-09-25T09:00:00.000Z")
  assert.deepEqual(Object.keys(created), [...ENTRY_KEYS, "since", "first_validating_at", "first_delivered_at", "returns"])
  const odd = await oneEntry({ flow: flowOf({ first_validating_at: "2026-09-25T08:30:00+02:00", first_delivered_at: null }), returns: [] })
  assert.equal(odd.first_validating_at, "2026-09-25T06:30:00.000Z")
  assert.equal(Object.hasOwn(odd, "first_delivered_at"), false, "an unknown time is left out, not written as null")
})

test("an entry for a card with no record has none of the new keys", async () => {
  const entry = await oneEntry({})
  assert.deepEqual(Object.keys(entry), ENTRY_KEYS)
})

test("returns carry reason, catch point, counts and refusal and no time", async () => {
  const entry = await oneEntry({ flow: flowOf(), returns: [returnLine(0), returnLine(1, "changed_ask")] })
  assert.deepEqual(entry.returns, [
    { reason: "agent_error", caught: "at_review", counts: true, refusal: null, refusal_verified: null },
    { reason: "changed_ask", caught: "at_review", counts: false, refusal: null, refusal_verified: null },
  ])
  assert.equal(JSON.stringify(entry.returns).includes("2026"), false)
  assert.equal(Object.hasOwn(entry, "returns_truncated"), false)
  assert.equal(Object.hasOwn(entry, "returns_unreadable"), false)
  assert.deepEqual(validateLocalFacts({ ...(await goldenFacts()), outcomes: [entry] }), { ok: true, errors: [] })
})

test("more than 32 returns keep the newest 32, keep since and say so", async () => {
  const lines = Array.from({ length: 40 }, (_, index) => returnLine(index, index < 8 ? "external" : "agent_error"))
  const entry = await oneEntry({ flow: flowOf({ since: "adopted" }), returns: lines })
  assert.equal(entry.returns.length, 32)
  assert.equal(entry.returns.some((item) => item.reason === "external"), false, "the oldest eight were dropped")
  assert.equal(entry.returns_truncated, true)
  assert.equal(entry.since, "adopted")
  assert.deepEqual(validateLocalFacts({ ...(await goldenFacts()), outcomes: [entry] }), { ok: true, errors: [] })
  const exact = await oneEntry({ flow: flowOf(), returns: lines.slice(0, 32) })
  assert.equal(Object.hasOwn(exact, "returns_truncated"), false, "32 is not truncated")
})

test("damaged return lines are counted in returns_unreadable and never leak their text", async () => {
  const entry = await oneEntry({ flow: flowOf(), returns: [returnLine(0), `${SENTINEL} not a return line`], returns_damaged: 1 })
  assert.equal(entry.returns.length, 1)
  assert.equal(entry.returns_unreadable, 2)
  assert.equal(JSON.stringify(entry).includes(SENTINEL), false)
  const noFlow = await oneEntry({ returns: [`${SENTINEL} line`] })
  assert.equal(Object.hasOwn(noFlow, "returns"), false, "a card with no record has no returns recorded")
  assert.equal(JSON.stringify(noFlow).includes(SENTINEL), false)
})

test("returns are kept for a card whose start cannot be read, and a card with a record and no returns reads as none", async () => {
  const entry = await oneEntry({ flow: flowOf({ since: "someday" }), returns: [returnLine(0)] })
  assert.equal(Object.hasOwn(entry, "since"), false)
  assert.equal(entry.returns.length, 1)
})

test("a refusal's counts pass through as the record decides: a witnessed human changed_ask does not count, an unwitnessed one does", async () => {
  const refusal = (verified) => formatReturn({ at: "2026-09-25T10:00:00.000Z", from: "done", to: "processing", reason: "agent_error", caught: "after_delivery", refusal: "changed_ask", refusal_verified: verified })
  const verified = await oneEntry({ flow: flowOf(), returns: [refusal(true)] })
  assert.deepEqual(verified.returns, [{ reason: "agent_error", caught: "after_delivery", counts: false, refusal: "changed_ask", refusal_verified: true }])
  const unverified = await oneEntry({ flow: flowOf(), returns: [refusal(false)] })
  assert.deepEqual(unverified.returns, [{ reason: "agent_error", caught: "after_delivery", counts: true, refusal: "changed_ask", refusal_verified: false }])
})

// Focus on a task, then on a task whose card is gone (which clears), over and over: each stretch of the task stands alone between cleared stretches, so a cap that is exceeded has to drop time.
async function standaloneSession(ctx, stretches) {
  const marker = await session(ctx)
  await writeCard(ctx, "track/task")
  await appendCalls(marker, Array.from({ length: stretches * 2 }, (_, index) => ["mcp__desk__task_focus", { track: "track", slug: index % 2 === 0 ? "task" : "gone" }]))
  await setConsent(ctx.env, { store: STORE, contribute: true })
  return marker
}

test("a session whose segment cap dropped time carries job_segments capped", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await standaloneSession(ctx, 210)
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const name = `claude-code-${ID}.json`
  const receipt = (await readStatus(ctx.env)).derivations[name]
  assert.ok(receipt.segments_capped_ms > 0, "the fixture must exceed the segment cap with time lost")
  const facts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name), "utf8"))
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "job_segments"), [{ field: "job_segments", reason: "capped" }])
  assert.equal(validateLocalFacts(facts).ok, true)
}))

test("a session with no dropped time carries no job_segments flag", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await standaloneSession(ctx, 3)
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const name = `claude-code-${ID}.json`
  assert.equal((await readStatus(ctx.env)).derivations[name].segments_capped_ms, 0)
  const facts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name), "utf8"))
  assert.equal(facts.unavailable.some((entry) => entry.field === "job_segments"), false)
}))

test("the receipt still records segments_capped_ms as before", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await standaloneSession(ctx, 210)
  await deriveMarker(ctx.env, marker)
  const receipt = (await readStatus(ctx.env)).derivations[`claude-code-${ID}.json`]
  assert.equal(Number.isInteger(receipt.segments_capped_ms) && receipt.segments_capped_ms > 0, true)
  assert.equal(receipt.binding_version, 6)
}))

// Capture coverage (capture-sweep.js): the sweep makes one call after the orphan pass and reports it in its summary.
test("the sweep summary says whether capture coverage was written, and status.json holds it", () => scratch(async (ctx) => {
  const { sweep } = await runner()
  const summary = await sweep(ctx.env, { quietMs: 0 })
  assert.equal(summary.coverage, "written")
  const status = await readStatus(ctx.env)
  assert.equal(status.coverage.method, 1)
  assert.equal(status.coverage_failed, undefined)
}))

test("a sweep whose capture coverage fails still derives and reports coverage failed", () => scratch(async (ctx) => {
  const { sweep } = await runner()
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, { ...await session(ctx), end_reason: "complete", ended_at: END })
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "quarantine"), { recursive: true, force: true })
  await fs.writeFile(path.join(root, "quarantine"), "not a folder")
  const summary = await sweep(ctx.env, { quietMs: 0 })
  assert.deepEqual([summary.written, summary.coverage], [1, "failed"])
  assert.equal((await readStatus(ctx.env)).coverage_failed, "state_unreadable")
}))
