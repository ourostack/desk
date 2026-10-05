import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { factoryStateRoot, listMarkers, markRetracting, readJobsIndex, setJobsForFile, readStatus, setConsent, writeMarker, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
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
  assert.deepEqual(await readJobsIndex(ctx.env), {})
  const receipt = (await readStatus(ctx.env)).derivations[`claude-code-${ID}.json`]
  assert.deepEqual([receipt.bound_by, receipt.focus_disagrees, receipt.repo_unresolved, receipt.segments_capped_ms], [{}, [], 0, 0])
  assert.equal(receipt.own_activity.length, 1, "the call is still the session's own activity")
}))

test("the receipt has binding_version: 5, bound_by, own_activity (at most 500) and focus_disagrees", () => scratch(async (ctx) => {
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
  assert.equal(BINDING_VERSION, 5)
  assert.equal(receipt.binding_version, 5)
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
  assert.equal(receipt.repo_unresolved, 1, "only the vanished directory is lost: an existing folder in no repository, and a repository with no origin, are a true none")
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
  assert.equal(BINDING_VERSION, 5)
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

// A session that was derived once and whose marker is gone: its outbox copy, receipt and transcript remain.
async function orphan(ctx, { declare = true, receiptRoot = true, cwd = ctx.desk, transcript = true } = {}) {
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
  await staleReceipt(ctx, name, (receipt) => {
    if (!receiptRoot) delete receipt.desk_root
    return receipt
  })
  if (!transcript) await fs.rm(marker.log_path)
  return { marker, name }
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
}))

test("an orphan with no receipt desk_root is rebuilt from the transcript's first cwd when that is exactly a desk root", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx, { receiptRoot: false })
  assert.deepEqual(await rebuilt(ctx), [1, 0])
  assert.equal((await readStatus(ctx.env)).derivations[name].desk_root, ctx.desk)
}))

test("an orphan whose cwd is inside the desk but not the desk root stays frozen", () => scratch(async (ctx) => {
  await fs.mkdir(path.join(ctx.desk, "track"))
  await orphan(ctx, { receiptRoot: false, cwd: path.join(ctx.desk, "track") })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))

test("an orphan whose desk routes by default stays frozen", () => scratch(async (ctx) => {
  await orphan(ctx, { declare: false })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))

test("a retracted orphan stays frozen, whether the record is a retracting entry or a kept copy", () => scratch(async (ctx) => {
  const { name } = await orphan(ctx)
  await markRetracting(ctx.env, STORE, [{ name, path: `sessions/${name}`, blob: "a".repeat(40) }])
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "retracting"), { recursive: true })
  await fs.mkdir(path.join(root, "retracted-copies", "ourostack__factory"), { recursive: true })
  await fs.writeFile(path.join(root, "retracted-copies", "ourostack__factory", name), "{}")
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))

test("an orphan in a crew desk stays frozen", () => scratch(async (ctx) => {
  await orphan(ctx)
  await fs.writeFile(path.join(ctx.desk, "_meta/desks.md"), "| alias | identity |\n| --- | --- |\n| ari | ari@example.com |\n")
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))

test("an orphan whose cwd is a code repository, with no receipt desk_root, stays frozen", () => scratch(async (ctx) => {
  const code = path.join(ctx.base, "code")
  await fs.mkdir(path.join(code, "_meta"), { recursive: true })
  await orphan(ctx, { receiptRoot: false, cwd: code })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))

test("an orphan with no transcript, or no outbox facts it can read, stays frozen", () => scratch(async (ctx) => {
  await orphan(ctx, { transcript: false })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))

test("an orphan whose outbox copy is unreadable, or whose transcript names no cwd, stays frozen and is counted", () => scratch(async (ctx) => {
  const { name, marker } = await orphan(ctx, { receiptRoot: false })
  const lines = (await fs.readFile(marker.log_path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  delete lines[0].cwd
  await fs.writeFile(marker.log_path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  await fs.writeFile(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name), "not json")
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))

test("a session that still has its marker is not an orphan", () => scratch(async (ctx) => {
  const { marker } = await orphan(ctx)
  await writeMarker(ctx.env, marker)
  assert.deepEqual(await rebuilt(ctx), [0, 0])
}))

test("an orphan with no Claude projects folder at all stays frozen", () => scratch(async (ctx) => {
  await orphan(ctx)
  await fs.rm(path.join(ctx.base, ".claude"), { recursive: true })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
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

test("an orphan whose retraction records cannot be read stays frozen and counted, and an outbox that cannot be listed never stops the sweep", () => scratch(async (ctx) => {
  await orphan(ctx)
  const root = await factoryStateRoot(ctx.env)
  await fs.writeFile(path.join(root, "retracting"), "not a folder")
  assert.deepEqual(await rebuilt(ctx), [0, 1])
  await fs.rm(path.join(root, "retracting"))
  await fs.rm(path.join(root, "outbox"), { recursive: true })
  await fs.writeFile(path.join(root, "outbox"), "not a folder")
  const { sweep } = await runner()
  const summary = await sweep(ctx.env)
  assert.deepEqual([summary.rebuilt, summary.frozen], [0, 0])
}))

test("a crew desk is told by its desks folder or by an unreadable roster, and prose in the roster file is no roster", () => scratch(async (ctx) => {
  await orphan(ctx)
  await fs.writeFile(path.join(ctx.desk, "_meta/desks.md"), "# Desks\n\nNo table here.\n| only | one |\n")
  assert.deepEqual(await rebuilt(ctx), [1, 0], "prose and an unrelated table are no roster")
  await staleReceipt(ctx, `claude-code-${ID}.json`, (receipt) => receipt)
  await fs.rm(path.join(ctx.desk, "_meta/desks.md"))
  await fs.mkdir(path.join(ctx.desk, "_meta/desks.md"))
  assert.deepEqual(await rebuilt(ctx), [0, 1], "a roster that cannot be read is a crew desk")
  await fs.rm(path.join(ctx.desk, "_meta/desks.md"), { recursive: true })
  await fs.mkdir(path.join(ctx.desk, "desks"))
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))

test("an orphan is looked for under CLAUDE_CONFIG_DIR, or the home folder when the environment names none", () => scratch(async (ctx) => {
  await orphan(ctx)
  const moved = path.join(ctx.base, "elsewhere")
  await fs.rename(path.join(ctx.base, ".claude"), moved)
  const { rebuildOrphans } = await runner()
  assert.deepEqual(await rebuildOrphans({ ...ctx.env, CLAUDE_CONFIG_DIR: moved }), { rebuilt: 1, frozen: 0 }, "markers are read when none are passed")
  const { HOME, ...homeless } = ctx.env
  await staleReceipt(ctx, `claude-code-${ID}.json`, (receipt) => receipt)
  assert.equal((await rebuildOrphans({ ...homeless, CLAUDE_CONFIG_DIR: moved })).rebuilt, 1)
  assert.equal(typeof (await rebuildOrphans({ ...homeless, XDG_STATE_HOME: ctx.env.XDG_STATE_HOME })).frozen, "number")
}))

test("an orphan whose store no longer takes contributions stays frozen and is counted", () => scratch(async (ctx) => {
  await orphan(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: false })
  assert.deepEqual(await rebuilt(ctx), [0, 1])
}))
